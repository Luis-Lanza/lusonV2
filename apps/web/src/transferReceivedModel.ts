import type { CountCorrections } from './transferCountCorrectionModel';
import type { TransferItem, TransferRecord } from './transferModel';

export interface ReceivedProjectionInput {
  readonly record: TransferRecord | null;
  readonly snapshot: CountCorrections | null;
  readonly busy: boolean;
  readonly error: unknown | null;
  readonly masked: boolean;
  /** Caller must fence account, owner and current selection before allowing evidence. */
  readonly contextValid: boolean;
}
export interface ReceivedQuantities {
  readonly expected: bigint;
  readonly actual: bigint;
  readonly credit: bigint;
  readonly shortage: bigint;
  readonly excess: bigint;
  readonly unexpected: bigint;
}
export interface ReceivedRow extends ReceivedQuantities {
  readonly variant_id: number;
  /** Null means ID-only identity: receipt-only variants have no historical product metadata. */
  readonly product: Readonly<Pick<TransferItem, 'brand' | 'model' | 'capacity_ah' | 'polarity'>> | null;
  readonly workflow_revision: bigint;
  readonly applied_revision: bigint;
}
export type ReceivedUnavailableReason = 'context-invalid' | 'masked' | 'error' | 'not-received' | 'absent'
  | 'request-mismatch' | 'duplicate-variant' | 'missing-variant' | 'extra-variant' | 'original-mismatch';
export type ReceivedProjection =
  | { readonly status: 'unavailable'; readonly reason: ReceivedUnavailableReason }
  | { readonly status: 'available' | 'updating'; readonly rows: readonly ReceivedRow[]; readonly totals: ReceivedQuantities };

/**
 * Joins parsed domain evidence, not raw DTOs. Availability is not proof of head
 * freshness or ownership; revisions alone cannot establish either. Busy retained
 * evidence remains explicitly updating. No proposal/operation reconstructs effects.
 */
export function projectTransferReceived(input: ReceivedProjectionInput): ReceivedProjection {
  const unavailable = (reason: ReceivedUnavailableReason): ReceivedProjection => ({ status: 'unavailable', reason });
  if (!input.contextValid) return unavailable('context-invalid');
  if (input.masked) return unavailable('masked');
  if (input.error !== null) return unavailable('error');
  const { record, snapshot } = input;
  if (!record || record.status !== 'received') return unavailable('not-received');
  if (!snapshot) return unavailable('absent');
  if (snapshot.request_id.toString() !== record.id) return unavailable('request-mismatch');

  const original = new Map(record.receipt.items.map(line => [line.variant_id, line]));
  const effective = new Map(snapshot.lines.map(line => [line.variant_id, line]));
  if (original.size !== record.receipt.items.length || effective.size !== snapshot.lines.length) {
    return unavailable('duplicate-variant');
  }
  if (snapshot.lines.some(line => !original.has(line.variant_id))) return unavailable('extra-variant');
  if (record.receipt.items.some(line => !effective.has(line.variant_id))) return unavailable('missing-variant');
  const products = new Map(record.items.map(item => [item.variant_id, item]));
  const rows: ReceivedRow[] = [];
  const totals = { expected: 0n, actual: 0n, credit: 0n, shortage: 0n, excess: 0n, unexpected: 0n };
  for (const originalLine of record.receipt.items) {
    const line = effective.get(originalLine.variant_id)!;
    if (line.expected_quantity !== originalLine.expected_quantity || line.actual_quantity !== originalLine.actual_quantity
      || line.available_quantity !== originalLine.available_quantity) return unavailable('original-mismatch');
    const product = products.get(line.variant_id);
    const expected = line.expected_quantity;
    const actual = line.effective_actual;
    const row: ReceivedRow = Object.freeze({
      variant_id: line.variant_id,
      product: product ? Object.freeze({ brand: product.brand, model: product.model,
        capacity_ah: product.capacity_ah, polarity: product.polarity }) : null,
      expected, actual, credit: line.effective_credit,
      shortage: actual < expected ? expected - actual : 0n,
      excess: expected > 0n && actual > expected ? actual - expected : 0n,
      unexpected: expected === 0n ? actual : 0n,
      workflow_revision: line.workflow_revision, applied_revision: line.applied_revision,
    });
    rows.push(row);
    totals.expected += row.expected;
    totals.actual += row.actual;
    totals.credit += row.credit;
    totals.shortage += row.shortage;
    totals.excess += row.excess;
    totals.unexpected += row.unexpected;
  }
  return Object.freeze({ status: input.busy ? 'updating' : 'available',
    rows: Object.freeze(rows), totals: Object.freeze(totals) });
}
