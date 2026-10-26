import { describe, expect, it } from 'vitest';
import { parseDispatchReconciliations, type DispatchReconciliationOperation } from './transferDispatchReconciliationModel';
import * as recovery from './transferDispatchReconciliationRecovery';
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
describe('pure reconciliation data', () => {
  it('previews S3 without replacing original evidence', () => {
    const f = fixture(); const s = parseDispatchReconciliations(wire(f.snapshot), f.record);
    expect(recovery.previewDispatchReconciliation(s.lines[0])).toEqual({ dispatch_quantity: 7n, source_delta: -2n, destination_delta: 2n });
    expect(s.lines[0].expected_quantity).toBe(5n);
  });
});

const decode = (f: ReturnType<typeof fixture>) => parseDispatchReconciliations(wire(f.snapshot), f.record);
const input = { variant_id: 1, operation_key: key, expected_revision: '0', reason: ' verified ', dispatch_quantity: '7' };
it('deep captures receipt and exact payload; resolves original operation without mutation', () => {
  const f = fixture(); const original = wire(f.snapshot);
  const attempt = recovery.captureDispatchReconciliationAttempt(f.record, 1, 'propose', input);
  const s = decode(f);
  expect(recovery.resolveDispatchReconciliationAttempt(attempt, s)).toEqual({ status: 'confirmed', operation: s.operations[0] });
  if (f.record.status !== 'received' || attempt.original.status !== 'received') throw new Error();
  Object.assign(f.record.receipt.items[0], { actual_quantity: 9n });
  expect(attempt.original.receipt.items[0].actual_quantity).toBe(7n);
  expect(Object.isFrozen(attempt.original.receipt.items[0])).toBe(true);
  expect(Object.isFrozen(attempt.original.receipt.exceptions)).toBe(true);
  expect(wire(f.snapshot)).toBe(original);
  expect(Object.keys(attempt).sort()).toEqual(['action', 'actor', 'original', 'payload']);
});
it('missing key is unresolved; same key different exact attempt conflicts', () => {
  const f = fixture(); const s = decode(f); const before = wire(f.snapshot);
  const a = recovery.captureDispatchReconciliationAttempt(f.record, 1, 'propose', { ...input, operation_key: 'missing-operation-001' });
  expect(recovery.resolveDispatchReconciliationAttempt(a, s).status).toBe('unresolved');
  for (const change of [{ reason: 'different' }, { expected_revision: '1' }, { dispatch_quantity: '6' }]) {
    const b = recovery.captureDispatchReconciliationAttempt(f.record, 1, 'propose', { ...input, ...change });
    expect(recovery.resolveDispatchReconciliationAttempt(b, s).status).toBe('conflict');
  }
  const other = recovery.captureDispatchReconciliationAttempt(f.record, 2, 'propose', input);
  expect(recovery.resolveDispatchReconciliationAttempt(other, s).status).toBe('conflict');
  expect(wire(f.snapshot)).toBe(before);
});
it('historical replay survives latest count6, with +1/0 preview not zero-sum inference', () => {
  const f = applied(); const a = recovery.captureDispatchReconciliationAttempt(f.record, 1, 'propose', input);
  Object.assign(f.snapshot.lines[0], { count_generation: '2', count_applied_revision: '1', effective_actual: '6', effective_credit: '6' });
  const s = decode(f);
  expect(recovery.resolveDispatchReconciliationAttempt(a, s).status).toBe('confirmed');
  expect(recovery.previewHistoricalDispatchReconciliation(s.lines[0].proposals[0])).toEqual({ dispatch_quantity: 7n, source_delta: -2n, destination_delta: 2n });
  expect(recovery.previewDispatchReconciliation(s.lines[0])).toEqual({ dispatch_quantity: 6n, source_delta: 1n, destination_delta: 0n });
});
it.each(['0', '9007199254740993', '9223372036854775807'])('previews current count %s losslessly', q => {
  const f = fixture(); Object.assign(f.snapshot.lines[0], { count_generation: '2', count_applied_revision: '1', effective_actual: q, effective_credit: BigInt(q) < 5n ? q : '5' });
  const l = decode(f).lines[0];
  expect(recovery.previewDispatchReconciliation(l)).toEqual({ dispatch_quantity: BigInt(q), source_delta: 5n - BigInt(q), destination_delta: BigInt(q) - l.effective_credit });
});
it.each([1, 2] as const)('either participant %s proposes; only initiator replaces', actor => {
  const f = fixture(); f.snapshot.operations[0].actor_location_id = actor;
  f.snapshot.lines[0].proposals[0].initiator_location_id = actor;
  const s = decode(f);
  expect(recovery.dispatchReconciliationActionHints(f.record, s, 1, actor)).toEqual({ propose: true, accept: false, reject: false });
  expect(recovery.dispatchReconciliationActionHints(f.record, s, 1, actor === 1 ? 2 : 1)).toEqual({ propose: false, accept: true, reject: true });
  f.snapshot.lines[0].proposals = []; f.snapshot.operations = [];
  Object.assign(f.snapshot.lines[0], { workflow_revision: '0', reconciliation_generation: '0' });
  expect(recovery.dispatchReconciliationActionHints(f.record, decode(f), 1, actor).propose).toBe(true);
});
it('stale restored READ blocks acceptance and proposal but permits counterpart rejection', () => {
  const f = fixture(); Object.assign(f.snapshot.lines[0], { count_generation: '2', count_applied_revision: '1', effective_actual: '4', effective_credit: '4', applied_retained_quantity: '1', restitution_generation: '2' });
  const s = decode(f);
  expect(recovery.dispatchReconciliationActionHints(f.record, s, 1, 2)).toEqual({ propose: false, accept: false, reject: true });
  expect(recovery.dispatchReconciliationActionHints(f.record, s, 1, 1)).toEqual({ propose: false, accept: false, reject: false });
});
it('denies wrong scope, unexpected variant and third actor', () => {
  const f = fixture(); const s = decode(f);
  for (const [variant, actor] of [[2, 1], [1, 3]]) expect(recovery.dispatchReconciliationActionHints(f.record, s, variant, actor)).toEqual({ propose: false, accept: false, reject: false });
  expect(recovery.dispatchReconciliationActionHints({ ...f.record, id: '124' }, s, 1, 1)).toEqual({ propose: false, accept: false, reject: false });
  expect(() => recovery.captureDispatchReconciliationAttempt(f.record, 3, 'propose', input)).toThrow();
  expect(() => recovery.captureDispatchReconciliationAttempt(f.record, 1, 'propose', { ...input, variant_id: 2 })).toThrow();
});
it('review retires on selected count, restitution, proposal, applied and generation changes', () => {
  const f = fixture(); const s = decode(f); const review = recovery.captureDispatchReconciliationReview(f.record, s, 1)!;
  expect(recovery.isDispatchReconciliationReviewCurrent(review, f.record, decode(f))).toBe(true);
  const changed = fixture(); Object.assign(changed.snapshot.lines[0], { count_generation: '2', count_applied_revision: '1', effective_actual: '4', effective_credit: '4' });
  expect(recovery.isDispatchReconciliationReviewCurrent(review, changed.record, decode(changed))).toBe(false);
  const restored = fixture(); Object.assign(restored.snapshot.lines[0], { restitution_generation: '2', applied_retained_quantity: '0' });
  expect(recovery.isDispatchReconciliationReviewCurrent(review, restored.record, decode(restored))).toBe(false);
  expect(recovery.isDispatchReconciliationReviewCurrent(review, f.record, decode(applied()))).toBe(false);
  expect(recovery.captureDispatchReconciliationReview(f.record, s, 2)).toBeNull();
});
it('unrelated variant activity does not retire selected review', () => {
  const f = fixture(); if (f.record.status !== 'received') throw new Error();
  f.record.items.push({ ...f.record.items[0], variant_id: 2 });
  Object.assign(f.record.receipt, {
    items: [...f.record.receipt.items, { ...f.record.receipt.items[0], variant_id: 2 }],
    exceptions: [...f.record.receipt.exceptions, { ...f.record.receipt.exceptions[0], variant_id: 2 }],
  });
  f.snapshot.lines.push({ ...f.snapshot.lines[0], variant_id: 2, workflow_revision: '0', reconciliation_generation: '0', proposals: [] });
  const review = recovery.captureDispatchReconciliationReview(f.record, decode(f), 1)!;
  Object.assign(f.snapshot.lines[1], { count_generation: '2', count_applied_revision: '1', effective_actual: '6', effective_credit: '5' });
  expect(recovery.isDispatchReconciliationReviewCurrent(review, f.record, decode(f))).toBe(true);
});

it('supersession retires review, only latest initiator receives replacement hint', () => {
  const f = fixture(); const review = recovery.captureDispatchReconciliationReview(f.record, decode(f), 1)!;
  const l = f.snapshot.lines[0]; l.proposals[0].state = 'superseded';
  l.proposals.push({ ...l.proposals[0], state: 'pending', revision: '2', operation_key: 'dispatch-proposal-0002', reconciliation_generation: '1' });
  f.snapshot.operations.push({ ...f.snapshot.operations[0], operation_key: 'dispatch-proposal-0002', expected_revision: '1', revision: '2' });
  Object.assign(l, { workflow_revision: '2', reconciliation_generation: '2' });
  const s = decode(f);
  expect(recovery.isDispatchReconciliationReviewCurrent(review, f.record, s)).toBe(false);
  expect(recovery.dispatchReconciliationActionHints(f.record, s, 1, 2)).toEqual({ propose: false, accept: true, reject: true });
});
it('count generation alone retires review and accept without blocking reject', () => {
  const f = fixture(); const review = recovery.captureDispatchReconciliationReview(f.record, decode(f), 1)!;
  f.snapshot.lines[0].count_generation = '1';
  const s = decode(f);
  expect(recovery.isDispatchReconciliationReviewCurrent(review, f.record, s)).toBe(false);
  expect(recovery.dispatchReconciliationActionHints(f.record, s, 1, 2)).toEqual({ propose: false, accept: false, reject: true });
});
