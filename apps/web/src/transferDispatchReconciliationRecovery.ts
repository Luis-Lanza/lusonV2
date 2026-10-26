import { captureDecisionRecord } from './transferDecisionRecovery';
import { countActorLocation } from './transferCountCorrectionModel';
import type { TransferRecord, TransferLocationID } from './transferModel';
import { normalizeDispatchReconciliationDecision, normalizeDispatchReconciliationProposal,
  matchesDispatchReconciliationOperation, type DispatchReconciliationDecisionInput,
  type DispatchReconciliationProposalInput, type DispatchReconciliationNormalizedDecision,
  type DispatchReconciliationNormalizedProposal } from './transferDispatchReconciliationAPI';
import type { DispatchReconciliations, DispatchReconciliationAction, DispatchReconciliationLine,
  DispatchReconciliationProposal, DispatchReconciliationOperation } from './transferDispatchReconciliationModel';

export interface DispatchReconciliationAttempt {
  readonly original: TransferRecord;
  readonly actor: TransferLocationID;
  readonly action: DispatchReconciliationAction;
  readonly payload: DispatchReconciliationNormalizedDecision | DispatchReconciliationNormalizedProposal;
}
function freezeDeep(value: unknown): void {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
}
function scoped(record: TransferRecord, snapshot: DispatchReconciliations, variant: number): DispatchReconciliationLine | undefined {
  if (record.status !== 'received' || snapshot.request_id !== BigInt(record.id)
    || !record.items.some(i => i.variant_id === variant)
    || !record.receipt.items.some(i => i.variant_id === variant && i.expected_quantity > 0n)) return undefined;
  return snapshot.lines.find(l => l.variant_id === variant);
}
/** Capture exact retry data, not eligibility or private session ownership. No secrets. */
export function captureDispatchReconciliationAttempt(record: TransferRecord, actorLocation: number,
  action: DispatchReconciliationAction, input: DispatchReconciliationDecisionInput | DispatchReconciliationProposalInput): DispatchReconciliationAttempt {
  const original = captureDecisionRecord(record);
  const actor = countActorLocation(actorLocation);
  if (original.status !== 'received' || !['propose', 'accept', 'reject'].includes(action)
    || ![original.origin_location_id, original.destination_location_id].includes(actor)) throw new Error('Invalid reconciliation attempt');
  const payload = action === 'propose' ? normalizeDispatchReconciliationProposal(input as DispatchReconciliationProposalInput)
    : normalizeDispatchReconciliationDecision(input);
  if (!original.items.some(i => i.variant_id === payload.variant_id)
    || !original.receipt.items.some(i => i.variant_id === payload.variant_id && i.expected_quantity > 0n)) throw new Error('Invalid reconciliation attempt');
  freezeDeep(original);
  return Object.freeze({ original, actor, action, payload });
}
export type DispatchReconciliationOutcome =
  | { readonly status: 'unresolved' | 'conflict'; readonly operation: null }
  | { readonly status: 'confirmed'; readonly operation: DispatchReconciliationOperation };
/** Strict decoded evidence only. Missing evidence never means rollback or success. */
export function resolveDispatchReconciliationAttempt(attempt: DispatchReconciliationAttempt, snapshot: DispatchReconciliations): DispatchReconciliationOutcome {
  if (!scoped(attempt.original, snapshot, attempt.payload.variant_id)) return Object.freeze({ status: 'conflict', operation: null });
  const op = snapshot.operations.find(o => o.operation_key === attempt.payload.operation_key);
  if (!op) return Object.freeze({ status: 'unresolved', operation: null });
  return matchesDispatchReconciliationOperation(op, BigInt(attempt.original.id), attempt.actor, attempt.action, attempt.payload)
    ? Object.freeze({ status: 'confirmed', operation: op }) : Object.freeze({ status: 'conflict', operation: null });
}
/** Mathematical effects only; never a stock, reservation or physical-proof permission. */
export function previewDispatchReconciliation(line: DispatchReconciliationLine) {
  return Object.freeze({ dispatch_quantity: line.effective_actual, source_delta: line.effective_dispatch - line.effective_actual,
    destination_delta: line.effective_actual - line.effective_credit });
}
export function previewHistoricalDispatchReconciliation(p: DispatchReconciliationProposal) {
  return Object.freeze({ dispatch_quantity: p.dispatch_quantity, source_delta: p.base_dispatch - p.dispatch_quantity,
    destination_delta: p.dispatch_quantity - p.base_credit });
}
/** Data-only affordances. The server remains authoritative for every request. */
export function dispatchReconciliationActionHints(record: TransferRecord, snapshot: DispatchReconciliations, variant: number, actor: number) {
  const none = Object.freeze({ propose: false, accept: false, reject: false });
  const l = scoped(record, snapshot, variant);
  if (!l || ![record.origin_location_id, record.destination_location_id].includes(actor as TransferLocationID)) return none;
  const head = l.proposals.at(-1);
  const pending = head?.state === 'pending' ? head : undefined;
  const eligible = l.applied_retained_quantity === 0n && l.effective_actual !== l.effective_dispatch;
  const counterpart = !!pending && pending.initiator_location_id !== actor;
  const fresh = !!pending && pending.count_generation === l.count_generation
    && pending.restitution_generation === l.restitution_generation
    && pending.reconciliation_generation + 1n === l.reconciliation_generation
    && pending.base_dispatch === l.effective_dispatch && pending.base_actual === l.effective_actual
    && pending.base_credit === l.effective_credit && pending.dispatch_quantity === l.effective_actual;
  return Object.freeze({ propose: eligible && (!pending || pending.initiator_location_id === actor),
    accept: eligible && counterpart && fresh, reject: counterpart });
}
const reviewFields = ['effective_dispatch', 'effective_actual', 'effective_credit', 'applied_retained_quantity',
  'workflow_revision', 'applied_revision', 'count_applied_revision', 'count_generation', 'restitution_generation', 'reconciliation_generation'] as const;
export interface DispatchReconciliationReview {
  readonly request_id: bigint;
  readonly variant_id: number;
  readonly values: readonly bigint[];
}
/** Selected-line DATA freshness only. UI must additionally fence private owner/session/epoch. */
export function captureDispatchReconciliationReview(record: TransferRecord, snapshot: DispatchReconciliations, variant: number): DispatchReconciliationReview | null {
  const l = scoped(record, snapshot, variant);
  return l ? Object.freeze({ request_id: snapshot.request_id, variant_id: variant,
    values: Object.freeze(reviewFields.map(k => l[k])) }) : null;
}
export function isDispatchReconciliationReviewCurrent(review: DispatchReconciliationReview, record: TransferRecord, snapshot: DispatchReconciliations): boolean {
  const current = captureDispatchReconciliationReview(record, snapshot, review.variant_id);
  return !!current && current.request_id === review.request_id && current.values.length === review.values.length
    && current.values.every((v, i) => v === review.values[i]);
}
