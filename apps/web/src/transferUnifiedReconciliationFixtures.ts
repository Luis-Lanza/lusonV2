import { fixture, stamp, wire } from './transferDispatchReconciliationStoreFixtures';
export { wire, stamp };
/** Independent receipt plus coherent, untouched legacy histories. */
export function unifiedFixture() {
  const { record, raw: dispatch } = fixture();
  const original = dispatch.lines.map(l => ({ variant_id: l.variant_id, expected_quantity: l.expected_quantity,
    actual_quantity: l.actual_quantity, available_quantity: l.available_quantity }));
  const version = { count: '0', restitution: '0', dispatch: '0', unified: '0' };
  const raw = { schema: 'luson.transfer-reconciliation/v2', request_id: record.id,
    origin_location_id: 1, destination_location_id: 2, received_at: stamp, original,
    legacy: { dispatch, count: { request_id: record.id, operations: [], lines: original.map(l => ({ ...l,
      workflow_revision: '0', applied_revision: '0', effective_dispatch: l.expected_quantity, reconciliation_revision: '0',
      effective_actual: l.actual_quantity, effective_credit: l.available_quantity, proposals: [] })) },
    restitution: { request_id: record.id, operations: [], lines: original.map(l => ({ variant_id: l.variant_id,
      expected_quantity: l.expected_quantity, effective_dispatch: l.expected_quantity, reconciliation_revision: '0', original_credit: l.available_quantity,
      workflow_revision: '0', applied_revision: '0', count_generation: '0', count_applied_revision: '0', effective_credit: l.available_quantity,
      applied_retained_quantity: '0', proposals: [] })) } },
    current: original.map(l => ({ variant_id: l.variant_id, owner: 'legacy', source: 'legacy', application_operation_key: null as string | null,
      applied_revision: '0', version: { ...version }, effective_dispatch: l.expected_quantity, effective_actual: l.actual_quantity,
      effective_credit: l.available_quantity, source_debit: l.expected_quantity, retained_quantity: null as string | null,
      origin_unknown: null as string | null, transit_unknown: null as string | null, excess: null as string | null })),
    lines: original.map(l => ({ ...l, workflow_revision: '0', applied_revision: '0', unified_generation: '0', proposals: [] as Record<string, unknown>[] })),
    operations: [] as Record<string, unknown>[] };
  return { record, raw };
}
export function unifiedAgreement(state: 'pending' | 'rejected' | 'applied' = 'applied', dispatch = '4', arrival = '3', retained = '1', initiator = 1) {
  const f = unifiedFixture(); const l = f.raw.lines[0]; const c = f.raw.current[0];
  const op = { operation_key: 'unified-proposal-0001', request_id: f.record.id, variant_id: 1, actor_location_id: initiator,
    action: 'propose', expected_revision: '0', dispatch_quantity: dispatch, arrival_quantity: arrival, retained_quantity: retained,
    retained_at_origin: initiator === 1 && retained !== '0', reason: ' verified ', revision: '1', source_existing_before: null,
    source_existing_after: null, destination_existing_before: null, destination_existing_after: null, recorded_at: stamp };
  const p: Record<string, unknown> = { revision: '1', operation_key: op.operation_key, initiator_location_id: initiator,
    dispatch_quantity: dispatch, arrival_quantity: arrival, retained_quantity: retained, retained_at_origin: op.retained_at_origin,
    base_source_debit: '5', base_destination_credit: '5', count_generation: '0', restitution_generation: '0', reconciliation_generation: '0',
    unified_generation: '0', reason: op.reason, recorded_at: stamp, state, decision: null, application: null };
  l.proposals.push(p); f.raw.operations.push(op); l.workflow_revision = '1'; l.unified_generation = '1'; c.owner = 'unified'; c.version.unified = '1';
  if (state !== 'pending') {
    const accepted = state === 'applied'; const actor = initiator === 1 ? 2 : 1;
    const d = { operation_key: 'unified-decision-0001', actor_location_id: actor, accepted,
      retained_at_origin: accepted && actor === 1 && retained !== '0', reason: ' agreed ', recorded_at: stamp };
    p.decision = d;
    const D = BigInt(dispatch), A = BigInt(arrival), R = BigInt(retained);
    const debit = (D > 5n ? D : 5n) - R, credit = D < A ? D : A;
    f.raw.operations.push({ ...op, ...d, accepted: undefined, action: accepted ? 'accept' : 'reject', expected_revision: '1',
      dispatch_quantity: null, arrival_quantity: null, retained_quantity: null,
      source_existing_before: accepted ? '20' : null, source_existing_after: accepted ? String(25n - debit) : null,
      destination_existing_before: accepted ? '20' : null, destination_existing_after: accepted ? String(15n + credit) : null });
    delete f.raw.operations[1].accepted;
    l.unified_generation = '2'; c.version.unified = '2';
    if (accepted) {
      p.application = { operation_key: d.operation_key, source_delta: String(5n - debit), destination_delta: String(credit - 5n) };
      l.applied_revision = '1'; Object.assign(c, { source: 'unified', application_operation_key: d.operation_key, applied_revision: '1',
        effective_dispatch: dispatch, effective_actual: arrival, effective_credit: String(credit), source_debit: String(debit), retained_quantity: retained,
        origin_unknown: String((5n > D ? 5n - D : 0n) - R), transit_unknown: String(D > A ? D - A : 0n), excess: String(A > D ? A - D : 0n) });
    }
  }
  return f;
}
