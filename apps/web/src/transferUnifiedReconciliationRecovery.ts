import { captureDecisionRecord } from './transferDecisionRecovery';
import { countActorLocation } from './transferCountCorrectionModel';
import type { TransferRecord, TransferLocationID } from './transferModel';
import { normalizeUnifiedReconciliationIntent, type UnifiedReconciliationAction, type UnifiedReconciliationDecisionInput,
  type UnifiedReconciliationProposalInput, type UnifiedReconciliationOperation, type UnifiedReconciliations } from './transferUnifiedReconciliationModel';

export interface UnifiedReconciliationAttempt {
  readonly original: TransferRecord;
  readonly actor: TransferLocationID;
  readonly action: UnifiedReconciliationAction;
  readonly payload: ReturnType<typeof normalizeUnifiedReconciliationIntent>;
}
function freeze(value: unknown): void {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
}
/** Reuse the canonical record decoder, then seal nested receipt evidence for async tickets. */
export function captureUnifiedReconciliationRecord(record: TransferRecord): TransferRecord {
  const captured = captureDecisionRecord(record); freeze(captured); return captured;
}
/** Private intent contains original evidence, never credentials or eligibility. */
export function captureUnifiedReconciliationAttempt(record: TransferRecord, actorLocation: number,
  action: UnifiedReconciliationAction, input: UnifiedReconciliationDecisionInput | UnifiedReconciliationProposalInput): UnifiedReconciliationAttempt {
  const original = captureUnifiedReconciliationRecord(record), actor = countActorLocation(actorLocation);
  const payload = normalizeUnifiedReconciliationIntent(input, action === 'propose');
  if (original.status !== 'received' || !['propose', 'accept', 'reject'].includes(action)
    || ![original.origin_location_id, original.destination_location_id].includes(actor)) throw new Error('Invalid reconciliation attempt');
  const receipt = original.receipt.items.find(i => i.variant_id === payload.variant_id && i.expected_quantity > 0n);
  if (!receipt || !original.items.some(i => i.variant_id === payload.variant_id)
    || action !== 'propose' && payload.expected_revision === 0n
    || payload.retained_at_origin && (actor !== original.origin_location_id || action === 'reject')) throw new Error('Invalid reconciliation attempt');
  if ('retained_quantity' in payload && (payload.retained_quantity > (receipt.expected_quantity > payload.dispatch_quantity ? receipt.expected_quantity - payload.dispatch_quantity : 0n)
    || payload.retained_quantity > 0n && actor === original.origin_location_id && !payload.retained_at_origin)) throw new Error('Invalid reconciliation attempt');
  return Object.freeze({ original, actor, action, payload });
}
export function matchesUnifiedReconciliationOperation(a: UnifiedReconciliationAttempt, op: UnifiedReconciliationOperation): boolean {
  const p = a.payload;
  return op.request_id === BigInt(a.original.id) && op.actor_location_id === a.actor && op.action === a.action
    && op.variant_id === p.variant_id && op.operation_key === p.operation_key && op.expected_revision === p.expected_revision
    && op.reason === p.reason && op.retained_at_origin === p.retained_at_origin
    && op.dispatch_quantity === ('dispatch_quantity' in p ? p.dispatch_quantity : null)
    && op.arrival_quantity === ('arrival_quantity' in p ? p.arrival_quantity : null)
    && op.retained_quantity === ('retained_quantity' in p ? p.retained_quantity : null);
}
export type UnifiedReconciliationOutcome =
  | { readonly status: 'unresolved' | 'conflict'; readonly operation: null }
  | { readonly status: 'confirmed'; readonly operation: UnifiedReconciliationOperation };
/** Only decoded unified operation evidence resolves intent; current/legacy heads never imply success. */
export function resolveUnifiedReconciliationAttempt(a: UnifiedReconciliationAttempt, snapshot: UnifiedReconciliations): UnifiedReconciliationOutcome {
  if (snapshot.request_id !== BigInt(a.original.id) || !snapshot.lines.some(l => l.variant_id === a.payload.variant_id)) return Object.freeze({ status: 'conflict', operation: null });
  const op = snapshot.operations.find(o => o.operation_key === a.payload.operation_key);
  if (!op) return Object.freeze({ status: 'unresolved', operation: null });
  return matchesUnifiedReconciliationOperation(a, op) ? Object.freeze({ status: 'confirmed', operation: op }) : Object.freeze({ status: 'conflict', operation: null });
}
