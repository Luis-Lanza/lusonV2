import { describe, expect, it } from 'vitest';
import { parseUnifiedReconciliations } from './transferUnifiedReconciliationModel';
import { unifiedFixture, unifiedAgreement, wire } from './transferUnifiedReconciliationFixtures';
const parse = (f: ReturnType<typeof unifiedFixture>) => parseUnifiedReconciliations(wire(f.raw), f.record);
describe('unified read evidence S2-S7', () => {
  it('preserves original and legacy evidence separately from current (S2,S3)', () => {
    const f = unifiedAgreement(); const before = wire(f.raw); const s = parse(f);
    expect(s.original[0].actual_quantity).toBe(7n); expect(s.legacy.dispatch.lines[0].effective_dispatch).toBe(5n);
    expect(s.current[0].effective_dispatch).toBe(4n); expect(wire(f.raw)).toBe(before);
    expect(Object.isFrozen(s.current[0])).toBe(true);
  });
  it.each(['pending', 'rejected'] as const)('ownership is not application: %s (S4)', state => {
    const s = parse(unifiedAgreement(state)); expect(s.current[0].owner).toBe('unified');
    expect(s.current[0].source).toBe('legacy'); expect(s.current[0].retained_quantity).toBeNull();
  });
  it.each([['4', '3', '0'], ['7', '8', '0'], ['0', '0', '5'], ['4', '3', '1']])('accepts exact accounting D%s A%s R%s (S5-S7)', (d, a, r) => {
    const s = parse(unifiedAgreement('applied', d, a, r)); expect(s.current[0].effective_credit).toBe(BigInt(d) < BigInt(a) ? BigInt(d) : BigInt(a));
  });
  it('allows destination initiation with origin confirmation (S7)', () => { expect(parse(unifiedAgreement('applied', '4', '3', '1', 2)).current[0].source).toBe('unified'); });
  it.each(['schema', 'original', 'identity', 'accounting', 'generation', 'attestation', 'orphan', 'legacy', 'null', 'retention'])('rejects corrupted %s without mutating evidence', rule => {
    const f = unifiedAgreement();
    if (rule === 'schema') f.raw.schema = 'v1';
    if (rule === 'original') f.raw.original[0].actual_quantity = '8';
    if (rule === 'identity') f.raw.operations[1].actor_location_id = 1;
    if (rule === 'accounting') f.raw.current[0].source_debit = '5';
    if (rule === 'generation') f.raw.current[0].version.unified = '1';
    if (rule === 'attestation') { f.raw.operations[0].retained_at_origin = false; f.raw.lines[0].proposals[0].retained_at_origin = false; }
    if (rule === 'orphan') f.raw.operations.push({ ...f.raw.operations[0], operation_key: 'unified-orphan-00001' });
    if (rule === 'legacy') f.raw.legacy.dispatch.lines[0].effective_dispatch = '6';
    if (rule === 'null') delete f.raw.lines[0].proposals[0].decision;
    if (rule === 'retention') { f.raw.lines[0].proposals[0].retained_quantity = '2'; f.raw.operations[0].retained_quantity = '2'; }
    const before = wire(f.raw); expect(() => parse(f)).toThrow('Invalid unified reconciliation evidence'); expect(wire(f.raw)).toBe(before);
  });
  it.each(['"schema":"luson.transfer-reconciliation/v2",', '"\\u0073chema":"luson.transfer-reconciliation/v2",'])('rejects duplicate decoded members %s', extra => {
    const f = unifiedFixture(); expect(() => parseUnifiedReconciliations('{' + extra + wire(f.raw).slice(1), f.record)).toThrow();
  });
  it.each(['01', '-0', '1e1', '9223372036854775808'])('rejects noncanonical/range quantity %s', q => {
    const f = unifiedFixture(); f.raw.current[0].source_debit = q; expect(() => parse(f)).toThrow();
  });
  it('rejects orphan legacy count operations against original receipt context', () => {
    const f = unifiedFixture();
    (f.raw.legacy.count.operations as unknown[]).push({ operation_key: 'legacy-orphan-000001', request_id: '123', variant_id: 99,
      actor_location_id: 1, action: 'propose', expected_revision: '0', actual_quantity: '3', reason: 'verified', revision: '1', recorded_at: f.raw.received_at });
    expect(() => parse(f)).toThrow();
  });
  it.each(['pending', 'rejected'] as const)('retains previous acceptance beneath later %s', state => {
    const f = unifiedAgreement(); const l = f.raw.lines[0], c = f.raw.current[0];
    const p = { ...l.proposals[0], revision: '2', operation_key: 'unified-proposal-0002', base_source_debit: c.source_debit,
      base_destination_credit: c.effective_credit, unified_generation: '2', state, decision: null as Record<string, unknown> | null, application: null };
    l.proposals.push(p); f.raw.operations.push({ ...f.raw.operations[0], operation_key: p.operation_key, revision: '2', expected_revision: '1' });
    l.workflow_revision = '2'; l.unified_generation = '3'; c.version.unified = '3';
    if (state === 'rejected') {
      const d = { operation_key: 'unified-decision-0002', actor_location_id: 2, accepted: false, retained_at_origin: false, reason: 'no', recorded_at: f.raw.received_at };
      p.decision = d; f.raw.operations.push({ ...f.raw.operations[1], ...d, action: 'reject', revision: '2', expected_revision: '2',
        source_existing_before: null, source_existing_after: null, destination_existing_before: null, destination_existing_after: null });
      delete f.raw.operations[3].accepted; l.unified_generation = '4'; c.version.unified = '4';
    }
    const s = parse(f); expect(s.current[0].application_operation_key).toBe('unified-decision-0001'); expect(s.current[0].applied_revision).toBe(1n);
  });
  it('keeps unexpected variants audit-only', () => {
    const f = unifiedFixture(); if (f.record.status !== 'received') throw new Error();
    Object.assign(f.record.receipt, { items: [...f.record.receipt.items, { variant_id: 3, expected_quantity: 0n, actual_quantity: 2n, available_quantity: 0n }] });
    f.raw.original.push({ variant_id: 3, expected_quantity: '0', actual_quantity: '2', available_quantity: '0' });
    f.raw.legacy.count.lines.push({ ...f.raw.legacy.count.lines[0], variant_id: 3, expected_quantity: '0', actual_quantity: '2', available_quantity: '0', effective_dispatch: '0', effective_actual: '2', effective_credit: '0' });
    f.raw.current.push({ ...f.raw.current[0], variant_id: 3, effective_dispatch: '0', effective_actual: '2', effective_credit: '0', source_debit: '0' });
    expect(parse(f).current[2].owner).toBe('legacy'); expect(parse(f).lines).toHaveLength(2);
    f.raw.lines.push({ ...f.raw.lines[0], variant_id: 3 }); expect(() => parse(f)).toThrow();
  });
  it('validates the exact 10/9/8/1 sample without changing destination credit (S6)', () => {
    const f = unifiedAgreement('applied', '9', '8', '1'); if (f.record.status !== 'received') throw new Error();
    Object.assign(f.record.items[0], { quantity: 10n }); Object.assign(f.record.receipt.items[0], { expected_quantity: 10n, actual_quantity: 8n, available_quantity: 8n });
    for (const l of [f.raw.original[0], f.raw.lines[0], f.raw.legacy.count.lines[0], f.raw.legacy.dispatch.lines[0]]) Object.assign(l, {
      expected_quantity: '10', actual_quantity: '8', available_quantity: '8',
    });
    Object.assign(f.raw.legacy.count.lines[0], { effective_dispatch: '10', effective_actual: '8', effective_credit: '8' });
    Object.assign(f.raw.legacy.dispatch.lines[0], { effective_dispatch: '10', effective_actual: '8', effective_credit: '8' });
    Object.assign(f.raw.legacy.restitution.lines[0], { expected_quantity: '10', effective_dispatch: '10', original_credit: '8', effective_credit: '8' });
    Object.assign(f.raw.lines[0].proposals[0], { base_source_debit: '10', base_destination_credit: '8',
      application: { operation_key: 'unified-decision-0001', source_delta: '1', destination_delta: '0' } });
    Object.assign(f.raw.operations[1], { source_existing_before: '20', source_existing_after: '21', destination_existing_before: '20', destination_existing_after: '20' });
    Object.assign(f.raw.current[0], { source_debit: '9', effective_credit: '8', origin_unknown: '0', transit_unknown: '1', excess: '0' });
    const s = parse(f); expect(s.lines[0].proposals[0].application?.source_delta).toBe(1n);
    expect(s.lines[0].proposals[0].application?.destination_delta).toBe(0n); expect(s.current[0].transit_unknown).toBe(1n);
  });
  it('does not double restore an already applied legacy retention (S3,S6)', () => {
    const f = unifiedAgreement(); if (f.record.status !== 'received') throw new Error();
    Object.assign(f.record.receipt.items[0], { actual_quantity: 3n, available_quantity: 3n });
    for (const l of [f.raw.original[0], f.raw.lines[0], f.raw.legacy.count.lines[0], f.raw.legacy.dispatch.lines[0]]) Object.assign(l, { actual_quantity: '3', available_quantity: '3' });
    Object.assign(f.raw.legacy.count.lines[0], { effective_actual: '3', effective_credit: '3' });
    Object.assign(f.raw.legacy.dispatch.lines[0], { effective_actual: '3', effective_credit: '3', applied_retained_quantity: '1', restitution_generation: '2' });
    Object.assign(f.raw.legacy.restitution.lines[0], { original_credit: '3', effective_credit: '3', applied_retained_quantity: '1', workflow_revision: '1', applied_revision: '1' });
    const at = f.raw.received_at;
    const d = { operation_key: 'unified-decision-0001', actor_location_id: 2, accepted: true, reason: 'yes', recorded_at: at };
    const op = { operation_key: 'unified-proposal-0001', request_id: '123', variant_id: 1, actor_location_id: 1, action: 'propose', expected_revision: '0',
      retained_quantity: '1', retained_at_origin: true, reason: 'verified', revision: '1', source_existing_before: null, source_existing_after: null, recorded_at: at };
    (f.raw.legacy.restitution.operations as unknown[]).push(op, { ...op, operation_key: d.operation_key, actor_location_id: 2, action: 'accept', expected_revision: '1', retained_quantity: null,
      retained_at_origin: null, reason: d.reason, source_existing_before: '20', source_existing_after: '21' });
    (f.raw.legacy.restitution.lines[0].proposals as unknown[]).push({ revision: '1', operation_key: op.operation_key, initiator_location_id: 1, retained_quantity: '1', retained_at_origin: true,
      base_revision: '0', count_generation: '0', count_applied_revision: '0', base_dispatch: '5', base_credit: '3', base_restitution: '0', reason: op.reason, recorded_at: at,
      state: 'applied', decision: d, application: { operation_key: d.operation_key, origin_location_id: 1, quantity: '1', recorded_at: at } });
    Object.assign(f.raw.lines[0].proposals[0], { restitution_generation: '2', base_source_debit: '4', base_destination_credit: '3',
      application: { operation_key: 'unified-decision-0001', source_delta: '0', destination_delta: '0' } });
    Object.assign(f.raw.operations[1], { source_existing_before: '20', source_existing_after: '20', destination_existing_before: '20', destination_existing_after: '20' });
    f.raw.current[0].version.restitution = '2';
    const s = parse(f); expect(s.lines[0].proposals[0].application?.source_delta).toBe(0n);
    expect(s.legacy.restitution.lines[0].applied_retained_quantity).toBe(1n); expect(s.current[0].retained_quantity).toBe(1n);
  });
  it.each(['9007199254740993', '9223372036854775807'])('retains lossless proposal quantity %s', q => {
    expect(parse(unifiedAgreement('pending', q, q, '0')).lines[0].proposals[0].dispatch_quantity).toBe(BigInt(q));
  });
  it('permits optional origin attestation at zero retention without imposing a product restriction', () => {
    const f = unifiedAgreement('applied', '7', '7', '0'); f.raw.operations[0].retained_at_origin = true;
    f.raw.lines[0].proposals[0].retained_at_origin = true; expect(parse(f).current[0].retained_quantity).toBe(0n);
  });
  it('requires explicit arrays and a closed schema', () => {
    const f = unifiedFixture(); expect(parse(f).operations).toEqual([]);
    Object.assign(f.raw, { extra: true }); expect(() => parse(f)).toThrow();
  });
});
