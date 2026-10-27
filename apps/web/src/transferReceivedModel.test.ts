import { describe, expect, it } from 'vitest';
import { appliedSnapshot, fixture as dispatchFixture } from './transferDispatchReconciliationStoreFixtures';
import type { CountCorrectionLine, CountProposal } from './transferCountCorrectionModel';
import { previewTransferReceipt, type TransferRecord } from './transferModel';
import { projectTransferReceived, type ReceivedProjectionInput } from './transferReceivedModel';

function fixture(): ReceivedProjectionInput {
  const items = [1, 2].map(variant_id => ({ variant_id, brand: 'Historical', model: `Model ${variant_id}`,
    capacity_ah: '60', polarity: 'L' as const, quantity: 5n }));
  const receipt = previewTransferReceipt({ items: [
    { variant_id: 1, actual_quantity: '5' }, { variant_id: 2, actual_quantity: '5' },
    { variant_id: 3, actual_quantity: '2' },
  ] }, { items });
  const record: TransferRecord = { id: '9007199254740993', reference: 'TR-1', kind: 'request_stock', status: 'received',
    creator_location_id: 2, creator_location_name: 'Destination', origin_location_id: 1, origin_location_name: 'Origin',
    destination_location_id: 2, destination_location_name: 'Destination', approver_location_id: 1, approver_location_name: 'Origin',
    created_at: '2026-04-01T00:00:00Z', decision_location_id: 1, decided_at: '2026-04-02T00:00:00Z',
    dispatch_location_id: 1, dispatched_at: '2026-04-03T00:00:00Z', receipt_location_id: 2,
    received_at: '2026-04-04T00:00:00Z', items, receipt };
  return { record, snapshot: { request_id: 9007199254740993n, operations: [], lines: receipt.items.map(line => ({
    ...line, effective_dispatch: line.expected_quantity, reconciliation_revision: 0n, workflow_revision: 0n, applied_revision: 0n, effective_actual: line.actual_quantity,
    effective_credit: line.available_quantity, proposals: [],
  })) }, busy: false, error: null, masked: false, contextValid: true };
}
function withLines(input: ReceivedProjectionInput, lines: readonly CountCorrectionLine[]) {
  return { ...input, snapshot: { ...input.snapshot!, lines } };
}
function proposal(revision: bigint, state: 'applied' | 'pending' | 'rejected'): CountProposal {
  return { revision, operation_key: `proposal_key_000${revision}`, initiator_location_id: 2,
    actual_quantity: state === 'applied' ? 3n : 99n, base_revision: revision === 1n ? 0n : 1n,
    base_credit: revision === 1n ? 5n : 3n,
    reason: 'Recount', recorded_at: '2026-04-05T00:00:00Z', state,
    decision: state === 'pending' ? null : { operation_key: `decision_key_000${revision}`, actor_location_id: 1,
      accepted: state === 'applied', reason: 'Verified', recorded_at: '2026-04-06T00:00:00Z' },
    application: state === 'applied' ? { effective_credit: 3n, delta: -2n, recorded_at: '2026-04-06T00:00:00Z' } : null };
}
function freezeDeep(value: unknown) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
}

describe('received effective projection', () => {
  it('joins accepted dispatch evidence by variant without rewriting original quantities', () => {
    const reconciliations = appliedSnapshot(); const record = dispatchFixture().record;
    const snapshot = { request_id: 123n, operations: [], lines: reconciliations.lines.map(l => ({
      variant_id: l.variant_id, expected_quantity: l.expected_quantity, actual_quantity: l.actual_quantity,
      available_quantity: l.available_quantity, effective_dispatch: l.effective_dispatch, reconciliation_revision: l.applied_revision,
      workflow_revision: 0n, applied_revision: 0n, effective_actual: l.effective_actual, effective_credit: l.effective_credit, proposals: [],
    })) };
    const input = { record, snapshot, reconciliations, busy: false, error: null, masked: false, contextValid: true };
    const before = structuredClone(input); freezeDeep(input);
    expect(projectTransferReceived(input)).toMatchObject({ status: 'available', rows: [
      { expected: 7n, actual: 7n, credit: 7n, excess: 0n }, { expected: 5n, excess: 2n },
    ] });
    for (const field of ['effective_dispatch', 'effective_actual', 'effective_credit', 'applied_revision', 'count_generation', 'count_applied_revision'] as const) {
      const wrong = { ...reconciliations, lines: reconciliations.lines.map((l, i) => i ? l : { ...l, [field]: l[field] + 1n }) };
      expect(projectTransferReceived({ ...input, reconciliations: wrong })).toEqual({ status: 'unavailable', reason: 'reconciliation-mismatch' });
    }
    expect(projectTransferReceived({ ...input, reconciliations: null }).status).toBe('unavailable');
    expect(projectTransferReceived({ ...input, busy: true }).status).toBe('updating');
    expect(input).toEqual(before);
  });
  it('joins by variant, preserves immutable historical metadata and unexpected ID-only identity', () => {
    const input = fixture();
    const result = projectTransferReceived(withLines(input, [...input.snapshot!.lines].reverse()));
    expect(result.status).toBe('available');
    if (result.status === 'unavailable') throw new Error('Expected projection');
    expect(result.rows.map(row => row.variant_id)).toEqual([1, 2, 3]);
    expect(result.rows[0].product).toEqual({ brand: 'Historical', model: 'Model 1', capacity_ah: '60', polarity: 'L' });
    expect(result.rows[2]).toMatchObject({ variant_id: 3, product: null, expected: 0n, actual: 2n, credit: 0n, unexpected: 2n });
    expect(result.totals).toEqual({ expected: 10n, actual: 12n, credit: 10n, shortage: 0n, excess: 0n, unexpected: 2n });
  });

  it.each(['pending', 'rejected'] as const)('uses applied GET quantities despite a later %s head', state => {
    const input = fixture();
    const lines = [...input.snapshot!.lines];
    lines[0] = { ...lines[0], workflow_revision: 2n, applied_revision: 1n, effective_actual: 3n, effective_credit: 3n,
      proposals: [proposal(1n, 'applied'), proposal(2n, state)] };
    const result = projectTransferReceived(withLines(input, lines));
    expect(result).toMatchObject({ status: 'available', rows: [
      { actual: 3n, credit: 3n, shortage: 2n, workflow_revision: 2n, applied_revision: 1n }, {}, {},
    ] });
    expect(input.record?.status === 'received' && input.record.receipt.items[0].actual_quantity).toBe(5n);
  });

  it.each(['pending', 'rejected'] as const)('does not treat an unapplied %s proposal as an effect', state => {
    const input = fixture();
    const lines = [...input.snapshot!.lines];
    lines[0] = { ...lines[0], workflow_revision: 1n, proposals: [proposal(1n, state)] };
    expect(projectTransferReceived(withLines(input, lines))).toMatchObject({ rows: [
      { actual: 5n, credit: 5n, applied_revision: 0n, workflow_revision: 1n }, {}, {},
    ] });
  });

  it('keeps opposite discrepancies separate and sums exact bigints above MAX_SAFE_INTEGER', () => {
    const input = fixture();
    const huge = 9007199254740993n;
    const lines = input.snapshot!.lines.map((line, i) => ({ ...line,
      effective_actual: i === 0 ? 3n : i === 1 ? huge : 2n,
      effective_credit: i === 0 ? 3n : i === 1 ? 5n : 0n }));
    expect(projectTransferReceived(withLines(input, lines))).toMatchObject({ totals: {
      expected: 10n, actual: huge + 5n, credit: 8n, shortage: 2n, excess: huge - 5n, unexpected: 2n,
    } });
  });

  it.each(['expected_quantity', 'actual_quantity', 'available_quantity'] as const)('rejects incompatible original %s', field => {
    const input = fixture();
    const lines = input.snapshot!.lines.map((line, i) => i === 0 ? { ...line, [field]: line[field] + 1n } : line);
    expect(projectTransferReceived(withLines(input, lines))).toEqual({ status: 'unavailable', reason: 'original-mismatch' });
  });

  it('rejects missing, extra and duplicate snapshot variants without fallback', () => {
    const input = fixture();
    const lines = input.snapshot!.lines;
    for (const [replacement, reason] of [
      [lines.slice(0, 2), 'missing-variant'],
      [[...lines, { ...lines[0], variant_id: 4 }], 'extra-variant'],
      [[...lines, lines[0]], 'duplicate-variant'],
    ] as const) expect(projectTransferReceived(withLines(input, replacement))).toEqual({ status: 'unavailable', reason });
  });

  it('rejects duplicate receipt evidence and mismatched request headers', () => {
    const input = fixture();
    expect(projectTransferReceived({ ...input, snapshot: { ...input.snapshot!, request_id: 42n } }))
      .toEqual({ status: 'unavailable', reason: 'request-mismatch' });
    if (input.record?.status !== 'received') throw new Error('Expected receipt');
    const record = { ...input.record, receipt: { ...input.record.receipt,
      items: [...input.record.receipt.items, input.record.receipt.items[0]] } };
    expect(projectTransferReceived({ ...input, record })).toEqual({ status: 'unavailable', reason: 'duplicate-variant' });
  });

  it.each([
    [{ record: null }, 'not-received'], [{ snapshot: null }, 'absent'],
    [{ error: new Error('Failed read') }, 'error'], [{ masked: true }, 'masked'],
    [{ contextValid: false }, 'context-invalid'],
  ] as const)('withholds effective values for unavailable caller state %j', (patch, reason) => {
    expect(projectTransferReceived({ ...fixture(), ...patch })).toEqual({ status: 'unavailable', reason });
  });

  it('marks retained busy evidence updating, but never creates evidence while loading', () => {
    expect(projectTransferReceived({ ...fixture(), busy: true })).toMatchObject({ status: 'updating' });
    expect(projectTransferReceived({ ...fixture(), busy: true, snapshot: null })).toEqual({ status: 'unavailable', reason: 'absent' });
    expect(projectTransferReceived({ ...fixture(), busy: true, masked: true })).toEqual({ status: 'unavailable', reason: 'masked' });
  });

  it('does not mutate any input or alias mutable product metadata', () => {
    const input = fixture();
    const before = structuredClone(input);
    freezeDeep(input);
    const result = projectTransferReceived(input);
    expect(input).toEqual(before);
    if (result.status === 'unavailable') throw new Error('Expected projection');
    expect(Object.isFrozen(result.rows[0].product)).toBe(true);
    expect(result.rows[0].product).not.toBe(input.record!.items[0]);
  });
});
