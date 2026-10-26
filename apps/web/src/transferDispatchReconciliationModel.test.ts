import { describe, expect, it } from 'vitest';
import { parseDispatchReconciliations, parseDispatchReconciliationOperation, type DispatchReconciliationOperation } from './transferDispatchReconciliationModel';
type Wire<T> = T extends bigint ? string : T extends object ? { -readonly [K in keyof T]: Wire<T[K]> } : T;
import type { TransferRecord } from './transferModel';
const stamp = '2026-01-02T12:00:00.123456789Z';
const key = 'dispatch-proposal-0001';
function fixture() {
  const record: TransferRecord = { id: '123', reference: 'TR-123', kind: 'direct_shipment', status: 'received', created_at: stamp,
    creator_location_id: 1, creator_location_name: 'Warehouse', origin_location_id: 1, origin_location_name: 'Warehouse',
    destination_location_id: 2, destination_location_name: 'Branch', approver_location_id: 1, approver_location_name: 'Warehouse',
    decision_location_id: 1, decided_at: stamp, dispatch_location_id: 1, dispatched_at: stamp, receipt_location_id: 2, received_at: stamp,
    items: [{ variant_id: 1, quantity: 5n, brand: 'Brand', model: 'Model', capacity_ah: '60', polarity: 'L' }],
    receipt: { items: [{ variant_id: 1, expected_quantity: 5n, actual_quantity: 7n, available_quantity: 5n }],
      exceptions: [{ variant_id: 1, kind: 'excess', quantity: 2n }] } };
  const op: Wire<DispatchReconciliationOperation> = { operation_key: key, request_id: '123', variant_id: 1, actor_location_id: 1, action: 'propose', expected_revision: '0', dispatch_quantity: '7', reason: ' verified ', revision: '1', source_existing_before: null, source_existing_after: null, destination_existing_before: null, destination_existing_after: null, recorded_at: stamp };
  const proposal = { revision: '1', operation_key: key, initiator_location_id: 1, dispatch_quantity: '7', base_dispatch: '5', base_actual: '7', base_credit: '5', count_generation: '0', restitution_generation: '0', reconciliation_generation: '0', reason: op.reason, recorded_at: stamp, state: 'pending', decision: null, application: null };
  const line = { variant_id: 1, expected_quantity: '5', actual_quantity: '7', available_quantity: '5', effective_dispatch: '5', effective_actual: '7', effective_credit: '5', applied_retained_quantity: '0', workflow_revision: '1', applied_revision: '0', count_generation: '0', count_applied_revision: '0', restitution_generation: '0', reconciliation_generation: '1', proposals: [proposal] };
  return { record, snapshot: { request_id: '123', lines: [line], operations: [op] } };
}
function applied() {
  const f = fixture();
  const p = f.snapshot.lines[0].proposals[0];
  const decision = { operation_key: 'dispatch-accept-00001', actor_location_id: 2, accepted: true, reason: 'agreed', recorded_at: stamp };
  Object.assign(p, { state: 'applied', decision, application: { operation_key: decision.operation_key, effective_dispatch: '7', source_delta: '-2', destination_delta: '2', recorded_at: stamp } });
  f.snapshot.operations.push({ ...f.snapshot.operations[0], ...decision, action: 'accept', expected_revision: '1', dispatch_quantity: null, source_existing_before: '15', source_existing_after: '13', destination_existing_before: '15', destination_existing_after: '17' } as unknown as typeof f.snapshot.operations[number]);
  // Decision's accepted flag is not an operation member.
  delete (f.snapshot.operations[1] as unknown as Record<string, unknown>).accepted;
  Object.assign(f.snapshot.lines[0], { effective_dispatch: '7', effective_credit: '7', applied_revision: '1', reconciliation_generation: '2' });
  return f;
}
const wire = (value: unknown) => JSON.stringify(value);
describe('dispatch reconciliation closed evidence', () => {
  it('retains original receipt and nanoseconds without mutating input (S3)', () => {
    const f = applied(); const before = wire(f.snapshot);
    const s = parseDispatchReconciliations(before, f.record);
    expect(s.lines[0].expected_quantity).toBe(5n); expect(s.lines[0].actual_quantity).toBe(7n);
    expect(s.lines[0].available_quantity).toBe(5n); expect(s.lines[0].effective_credit).toBe(7n);
    expect(s.operations[0].recorded_at).toBe(stamp); expect(wire(f.snapshot)).toBe(before);
    expect(Object.isFrozen(s.lines[0].proposals[0])).toBe(true);
  });
  it('keeps historical 7/base5/delta2 after count6 and a reversed-proposer dispatch6 (S4)', () => {
    const f = applied(); const l = f.snapshot.lines[0]; const first = wire(l.proposals[0]);
    const p = { ...l.proposals[0], revision: '2', operation_key: 'dispatch-proposal-0002', initiator_location_id: 2,
      dispatch_quantity: '6', base_dispatch: '7', base_actual: '6', base_credit: '6', count_generation: '2', reconciliation_generation: '2' };
    const d = { operation_key: 'dispatch-accept-00002', actor_location_id: 1, accepted: true, reason: 'later agreed', recorded_at: '2026-01-01T00:00:00Z' };
    Object.assign(p, { decision: d, application: { operation_key: d.operation_key, effective_dispatch: '6', source_delta: '1', destination_delta: '0', recorded_at: d.recorded_at } });
    l.proposals.push(p);
    f.snapshot.operations.push({ ...f.snapshot.operations[0], operation_key: p.operation_key, actor_location_id: 2,
      revision: '2', expected_revision: '1', dispatch_quantity: '6', reason: p.reason, recorded_at: p.recorded_at });
    const op: Wire<DispatchReconciliationOperation> = { ...f.snapshot.operations[1], operation_key: d.operation_key, actor_location_id: 1, revision: '2', expected_revision: '2',
      reason: d.reason, recorded_at: d.recorded_at, source_existing_before: '100', source_existing_after: '101', destination_existing_before: '200', destination_existing_after: '200' };
    f.snapshot.operations.push(op);
    Object.assign(l, { effective_actual: '6', effective_dispatch: '6', effective_credit: '6', applied_revision: '2', workflow_revision: '2', count_generation: '2', count_applied_revision: '1', reconciliation_generation: '4' });
    const s = parseDispatchReconciliations(wire(f.snapshot), f.record);
    expect(s.lines[0].proposals[0].base_credit).toBe(5n); expect(s.lines[0].proposals[0].application?.destination_delta).toBe(2n);
    expect(s.lines[0].proposals[1].application?.source_delta).toBe(1n); expect(s.lines[0].proposals[1].application?.destination_delta).toBe(0n);
    expect(s.lines[0].effective_credit).toBe(6n); expect(wire(l.proposals[0])).toBe(first);
  });
  it('accepts a stale proposal rejection without acceptance-only current pins (S6)', () => {
    const f = fixture(); const l = f.snapshot.lines[0];
    const d = { operation_key: 'dispatch-reject-00001', actor_location_id: 2, accepted: false, reason: 'stale', recorded_at: stamp };
    Object.assign(l.proposals[0], { state: 'rejected', decision: d });
    const op: Wire<DispatchReconciliationOperation> = { ...f.snapshot.operations[0], operation_key: d.operation_key, actor_location_id: 2, action: 'reject', expected_revision: '1', reason: d.reason };
    Object.assign(op, { dispatch_quantity: null }); f.snapshot.operations.push(op);
    Object.assign(l, { count_generation: '2', count_applied_revision: '1', effective_actual: '4', effective_credit: '4', applied_retained_quantity: '1', restitution_generation: '2', reconciliation_generation: '2' });
    expect(parseDispatchReconciliations(wire(f.snapshot), f.record).lines[0].proposals[0].state).toBe('rejected');
  });
  it('retains stale pending and applied restitution read evidence (S6)', () => {
    const f = fixture(); Object.assign(f.snapshot.lines[0], { count_generation: '2', count_applied_revision: '1', effective_actual: '4', effective_credit: '4', applied_retained_quantity: '1', restitution_generation: '2' });
    expect(parseDispatchReconciliations(wire(f.snapshot), f.record).lines[0].proposals[0].state).toBe('pending');
  });
  it.each(['0', '9007199254740993', '9223372036854775807'])('losslessly decodes quantity %s (S5)', quantity => {
    const f = fixture(); f.snapshot.operations[0].dispatch_quantity = quantity;
    expect(parseDispatchReconciliationOperation(wire(f.snapshot.operations[0]), f.record).dispatch_quantity).toBe(BigInt(quantity));
  });
  it('allows either endpoint to propose but not a third actor (S7)', () => {
    const f = fixture(); f.snapshot.operations[0].actor_location_id = 2; f.snapshot.lines[0].proposals[0].initiator_location_id = 2;
    expect(parseDispatchReconciliations(wire(f.snapshot), f.record).operations[0].actor_location_id).toBe(2);
    f.snapshot.operations[0].actor_location_id = 3;
    expect(() => parseDispatchReconciliations(wire(f.snapshot), f.record)).toThrow();
  });
  it('rejects understated pinned credit after a count generation changes', () => {
    const f = applied();
    Object.assign(f.snapshot.lines[0], { count_generation: '2', count_applied_revision: '1' });
    const p = f.snapshot.lines[0].proposals[0] as unknown as Record<string, unknown>;
    Object.assign(p, { count_generation: '2', base_credit: '4' });
    (p.application as Record<string, unknown>).destination_delta = '3';
    f.snapshot.operations[1].destination_existing_after = '18';
    const raw = wire(f.snapshot);
    expect(() => parseDispatchReconciliations(raw, f.record)).toThrow('Invalid dispatch reconciliation evidence');
    expect(wire(f.snapshot)).toBe(raw);
  });
  it('rejects understated current credit after a count generation changes', () => {
    const f = fixture();
    Object.assign(f.snapshot.lines[0], { count_generation: '2', count_applied_revision: '1', effective_actual: '4',
      effective_credit: '3', applied_retained_quantity: '1', restitution_generation: '2' });
    const raw = wire(f.snapshot);
    expect(() => parseDispatchReconciliations(raw, f.record)).toThrow('Invalid dispatch reconciliation evidence');
    expect(wire(f.snapshot)).toBe(raw);
  });
  it('accepts explicit empty histories and excludes unexpected receipt variants (S8)', () => {
    const f = fixture(); const l = f.snapshot.lines[0]; l.proposals = []; f.snapshot.operations = [];
    Object.assign(l, { workflow_revision: '0', reconciliation_generation: '0' });
    expect(parseDispatchReconciliations(wire(f.snapshot), f.record).operations).toEqual([]);
    if (f.record.status !== 'received') throw new Error('fixture');
    Object.assign(f.record.receipt, { items: [...f.record.receipt.items, { variant_id: 2, expected_quantity: 0n, actual_quantity: 3n, available_quantity: 0n }] });
    expect(parseDispatchReconciliations(wire(f.snapshot), f.record).lines).toHaveLength(1);
    l.variant_id = 2;
    expect(() => parseDispatchReconciliations(wire(f.snapshot), f.record)).toThrow();
  });
  it.each(['01', '-1', '1.0', '1e2', '9223372036854775808'])('rejects noncanonical or overflowing quantity %s', quantity => {
    const f = fixture(); f.snapshot.operations[0].dispatch_quantity = quantity;
    expect(() => parseDispatchReconciliationOperation(wire(f.snapshot.operations[0]), f.record)).toThrow();
  });
  it.each(['proposal-actor', 'proposal-reason', 'proposal-stamp', 'quantity-pin', 'credit-pin', 'dispatch-pin', 'generation-pin', 'state', 'application-key', 'application-stamp', 'current-dispatch', 'current-generation', 'current-actual', 'original-credit', 'missing-line', 'null-array'])('rejects inconsistent %s', kind => {
    const f = applied(); const l = f.snapshot.lines[0]; const p = l.proposals[0] as unknown as Record<string, unknown>;
    if (kind === 'proposal-actor') p.initiator_location_id = 2;
    if (kind === 'proposal-reason') p.reason = 'different';
    if (kind === 'proposal-stamp') p.recorded_at = '2026-01-02T12:00:00Z';
    if (kind === 'quantity-pin') p.base_actual = '8';
    if (kind === 'credit-pin') p.base_credit = '4';
    if (kind === 'dispatch-pin') p.base_dispatch = '6';
    if (kind === 'generation-pin') p.reconciliation_generation = '1';
    if (kind === 'state') p.state = 'pending';
    if (kind === 'application-key') (p.application as Record<string, unknown>).operation_key = key;
    if (kind === 'application-stamp') (p.application as Record<string, unknown>).recorded_at = '2026-01-02T12:00:00Z';
    if (kind === 'current-dispatch') l.effective_dispatch = '8';
    if (kind === 'current-generation') l.reconciliation_generation = '3';
    if (kind === 'current-actual') l.effective_actual = '8';
    if (kind === 'original-credit') l.available_quantity = '4';
    if (kind === 'missing-line') f.snapshot.lines = [];
    if (kind === 'null-array') Object.assign(l, { proposals: null });
    expect(() => parseDispatchReconciliations(wire(f.snapshot), f.record)).toThrow();
  });
  it('retains same-initiator supersession with complete operations', () => {
    const f = fixture(); const l = f.snapshot.lines[0]; l.proposals[0].state = 'superseded';
    l.proposals.push({ ...l.proposals[0], state: 'pending', revision: '2', operation_key: 'dispatch-proposal-0002', reconciliation_generation: '1' });
    f.snapshot.operations.push({ ...f.snapshot.operations[0], operation_key: 'dispatch-proposal-0002', expected_revision: '1', revision: '2' });
    Object.assign(l, { workflow_revision: '2', reconciliation_generation: '2' });
    expect(parseDispatchReconciliations(wire(f.snapshot), f.record).lines[0].proposals.map(p => p.state)).toEqual(['superseded', 'pending']);
  });
  it.each(['unknown', 'missing', 'numeric', 'duplicate', 'wrong-record', 'bad-actor', 'partial-balance', 'conflicting-delta', 'orphan', 'bad-date'])('rejects %s without mutation (S8)', kind => {
    const f = applied(); const s = f.snapshot; const o = s.operations[1] as unknown as Record<string, unknown>;
    if (kind === 'unknown') o.authority = true;
    if (kind === 'missing') delete o.reason;
    if (kind === 'numeric') o.source_existing_before = 9007199254740992;
    if (kind === 'wrong-record') o.request_id = '124';
    if (kind === 'bad-actor') o.actor_location_id = 1;
    if (kind === 'partial-balance') o.source_existing_after = null;
    if (kind === 'conflicting-delta') o.destination_existing_after = '18';
    if (kind === 'orphan') s.operations.push({ ...s.operations[0], operation_key: 'orphan-proposal-00001' });
    if (kind === 'bad-date') o.recorded_at = '2026-02-30T00:00:00Z';
    const before = wire(s); const raw = kind === 'duplicate' ? before.replace('"request_id":"123"', '"request_id":"123","request_id":"123"') : before;
    expect(() => parseDispatchReconciliations(raw, f.record)).toThrow(); expect(wire(s)).toBe(before);
  });
});
