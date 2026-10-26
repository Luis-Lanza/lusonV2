import type { TransferRecord } from './transferModel';
import { parseDispatchReconciliations } from './transferDispatchReconciliationModel';
export const stamp = '2026-01-02T12:00:00Z';
export const operationKey = 'dispatch-proposal-0001';
export const decisionKey = 'dispatch-decision-0001';
export const owner = Object.freeze({ account: 1, location: 1, epoch: 1, generation: 1 });
export const wire = (value: unknown) => JSON.stringify(value, (_k, v: unknown) => typeof v === 'bigint' ? v.toString() : v);
export function fixture(pending = false) {
  const record: TransferRecord = { id: '123', reference: 'TR-123', kind: 'direct_shipment', status: 'received', created_at: stamp,
    creator_location_id: 1, creator_location_name: 'Warehouse', origin_location_id: 1, origin_location_name: 'Warehouse',
    destination_location_id: 2, destination_location_name: 'Branch', approver_location_id: 1, approver_location_name: 'Warehouse',
    decision_location_id: 1, decided_at: stamp, dispatch_location_id: 1, dispatched_at: stamp, receipt_location_id: 2, received_at: stamp,
    items: [1, 2].map(variant_id => ({ variant_id, quantity: 5n, brand: 'Brand', model: 'Model', capacity_ah: '60', polarity: 'L' })),
    receipt: { items: [1, 2].map(variant_id => ({ variant_id, expected_quantity: 5n, actual_quantity: 7n, available_quantity: 5n })),
      exceptions: [1, 2].map(variant_id => ({ variant_id, kind: 'excess' as const, quantity: 2n })) } };
  const op = { operation_key: operationKey, request_id: '123', variant_id: 1, actor_location_id: 1, action: 'propose', expected_revision: '0',
    dispatch_quantity: '7', reason: ' verified ', revision: '1', source_existing_before: null, source_existing_after: null,
    destination_existing_before: null, destination_existing_after: null, recorded_at: stamp };
  const proposal = { revision: '1', operation_key: operationKey, initiator_location_id: 1, dispatch_quantity: '7', base_dispatch: '5', base_actual: '7',
    base_credit: '5', count_generation: '0', restitution_generation: '0', reconciliation_generation: '0', reason: op.reason, recorded_at: stamp,
    state: 'pending', decision: null, application: null };
  const raw = { request_id: '123', lines: [1, 2].map(variant_id => ({ variant_id, expected_quantity: '5', actual_quantity: '7', available_quantity: '5',
    effective_dispatch: '5', effective_actual: '7', effective_credit: '5', applied_retained_quantity: '0', workflow_revision: pending && variant_id === 1 ? '1' : '0',
    applied_revision: '0', count_generation: '0', count_applied_revision: '0', restitution_generation: '0', reconciliation_generation: pending && variant_id === 1 ? '1' : '0',
    proposals: pending && variant_id === 1 ? [proposal] : [] })), operations: pending ? [op] : [] };
  return { record, raw, op, decode: () => parseDispatchReconciliations(wire(raw), record) };
}
export function appliedSnapshot() {
  const f = fixture(true);
  const decision = { operation_key: decisionKey, actor_location_id: 2, accepted: true, reason: ' verified ', recorded_at: stamp };
  return parseDispatchReconciliations(wire({ ...f.raw,
    lines: f.raw.lines.map(l => l.variant_id !== 1 ? l : { ...l, effective_dispatch: '7', effective_credit: '7', applied_revision: '1', reconciliation_generation: '2',
      proposals: l.proposals.map(p => ({ ...p, state: 'applied', decision, application: { operation_key: decisionKey, effective_dispatch: '7', source_delta: '-2', destination_delta: '2', recorded_at: stamp } })) }),
    operations: [...f.raw.operations, { ...f.op, operation_key: decisionKey, actor_location_id: 2, action: 'accept', expected_revision: '1', dispatch_quantity: null,
      source_existing_before: '15', source_existing_after: '13', destination_existing_before: '15', destination_existing_after: '17' }],
  }), f.record);
}
export function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
}
