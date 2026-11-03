import type { UnifiedReconciliations } from './transferUnifiedReconciliationModel';
import type { TransferRecord } from './transferModel';
import type { ReceivedQuantities, ReceivedRow, UnifiedReceivedProjection } from './transferReceivedModel';

export function projectUnifiedReceived(record: TransferRecord, snapshot: UnifiedReconciliations | null,
  busy: boolean, error: unknown, masked: boolean): UnifiedReceivedProjection {
  if (masked || error) return { status: 'unavailable', reason: masked ? 'masked' : 'error' };
  if (record.status !== 'received') return { status: 'unavailable', reason: 'absent' };
  // No snapshot while a read is in flight is loading, never unavailability: the
  // first paint must not offer recovery actions for evidence that is still arriving.
  if (!snapshot) return busy ? { status: 'loading' } : { status: 'unavailable', reason: 'absent' };
  if (snapshot.request_id.toString() !== record.id || snapshot.origin_location_id !== record.origin_location_id
    || snapshot.destination_location_id !== record.destination_location_id || snapshot.received_at !== record.received_at) {
    return { status: 'unavailable', reason: 'absent' };
  }
  const totals: ReceivedQuantities = { expected: 0n, actual: 0n, credit: 0n, shortage: 0n, excess: 0n, unexpected: 0n };
  const rows: ReceivedRow[] = snapshot.current.map(c => {
    const expected = c.effective_dispatch, actual = c.effective_actual;
    // An expected variant with agreed zero dispatch is not an unexpected variant.
    const expectedVariant = record.items.some(i => i.variant_id === c.variant_id);
    const row = { variant_id: c.variant_id, product: record.items.find(i => i.variant_id === c.variant_id) ?? null,
      expected, actual, credit: c.effective_credit, shortage: actual < expected ? expected - actual : 0n,
      excess: expectedVariant && actual > expected ? actual - expected : 0n,
      unexpected: expectedVariant ? 0n : actual, workflow_revision: c.version.unified, applied_revision: c.applied_revision };
    for (const key of ['expected', 'actual', 'credit', 'shortage', 'excess', 'unexpected'] as const) {
      (totals as { -readonly [K in keyof ReceivedQuantities]: bigint })[key] += row[key];
    }
    return row;
  });
  return { status: busy ? 'updating' : 'available', rows, totals };
}

/** Presentation only. The coordinated decoder, not this projection, proves Current. */
export function reconciliationCurrentRows(snapshot: UnifiedReconciliations | null) {
  if (!snapshot) return null;
  return snapshot.current.map(current => ({
    variant_id: current.variant_id, source: current.source, owner: current.owner,
    dispatch: current.effective_dispatch, actual: current.effective_actual,
    credit: current.effective_credit, sourceDebit: current.source_debit,
    retained: current.retained_quantity, originUnknown: current.origin_unknown,
    transitUnknown: current.transit_unknown, excess: current.excess,
  }));
}

const max = 9223372036854775807n;
function quantity(text: string): bigint | null {
  if (!/^(0|[1-9][0-9]*)$/.test(text) || text.length > 19) return null;
  const value = BigInt(text);
  return value <= max ? value : null;
}
const positive = (n: bigint) => n > 0n ? n : 0n;

/** Hypothetical effects only: never a stock guarantee or write capability.
 * Baselines are authoritative Current ledger totals, not original quantities or
 * nested Legacy projections. Every mutation still uses the established store.
 */
export function reconciliationEffects(expected: bigint, sourceDebit: bigint, destinationCredit: bigint,
  dispatchText: string, arrivalText: string, retainedText: string) {
  const dispatch = quantity(dispatchText), arrival = quantity(arrivalText), retained = quantity(retainedText);
  if (dispatch === null || arrival === null || retained === null
    || retained > positive(expected - dispatch)) return null;
  const targetDebit = (expected > dispatch ? expected : dispatch) - retained;
  const targetCredit = dispatch < arrival ? dispatch : arrival;
  return { dispatch, arrival, retained, sourceDebit: targetDebit, destinationCredit: targetCredit,
    sourceDelta: sourceDebit - targetDebit, destinationDelta: targetCredit - destinationCredit,
    originUnknown: positive(expected - dispatch) - retained,
    transitUnknown: positive(dispatch - arrival), excess: positive(arrival - dispatch) };
}
