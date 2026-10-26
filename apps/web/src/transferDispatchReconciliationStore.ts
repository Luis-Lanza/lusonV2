import { captureDecisionRecord, matchesDecisionRecord, type DecisionOwner } from './transferDecisionRecovery';
import { sameCountOwner } from './transferCountCorrectionRecovery';
import { DispatchReconciliationAPIError, matchesDispatchReconciliationOperation } from './transferDispatchReconciliationAPI';
import { parseDispatchReconciliations, parseDispatchReconciliationOperation, type DispatchReconciliations,
  type DispatchReconciliationAction, type DispatchReconciliationOperation } from './transferDispatchReconciliationModel';
import { captureDispatchReconciliationAttempt, captureDispatchReconciliationReview, dispatchReconciliationActionHints,
  isDispatchReconciliationReviewCurrent, previewDispatchReconciliation, previewHistoricalDispatchReconciliation,
  resolveDispatchReconciliationAttempt, type DispatchReconciliationAttempt, type DispatchReconciliationReview } from './transferDispatchReconciliationRecovery';
import type { TransferRecord } from './transferModel';

export interface ReconciliationDraft { readonly variantID: number; readonly action: DispatchReconciliationAction; readonly reason: string }
export interface ReconciliationReview {
  readonly data: DispatchReconciliationReview;
  readonly attempt: DispatchReconciliationAttempt;
  readonly preview: ReturnType<typeof previewDispatchReconciliation>;
}
export interface OwnedReconciliationAttempt extends DispatchReconciliationAttempt {
  readonly owner: Readonly<DecisionOwner>;
  readonly phase: 'inFlight' | 'uncertain' | 'conflict' | 'confirmed' | 'failed';
  /** Sticky uncertainty from an earlier flight; a refusal of a retry cannot erase it. */
  readonly priorUncertainty: boolean;
  readonly result: DispatchReconciliationOperation | null;
  readonly failure: DispatchReconciliationAPIError | null;
}
export interface ReconciliationWriteTicket { readonly attempt: OwnedReconciliationAttempt }
export interface ReconciliationReadTicket { readonly original: TransferRecord; readonly owner: Readonly<DecisionOwner>; readonly explicit: boolean }
interface Lane { attempt: OwnedReconciliationAttempt; flight: ReconciliationWriteTicket | null }
export interface ReconciliationStoreState {
  readonly snapshot: DispatchReconciliations | null;
  readonly draft: ReconciliationDraft | null;
  readonly review: ReconciliationReview | null;
  readonly attempts: readonly OwnedReconciliationAttempt[];
  readonly error: DispatchReconciliationAPIError | null;
  readonly busy: boolean;
  readonly masked: boolean;
}
const empty: ReconciliationStoreState = Object.freeze({ snapshot: null, draft: null, review: null,
  attempts: Object.freeze([]), error: null, busy: false, masked: false });
const wire = (v: unknown) => JSON.stringify(v, (_k, value: unknown) => typeof value === 'bigint' ? value.toString() : value);
function captureScope(record: TransferRecord): TransferRecord {
  const captured = captureDecisionRecord(record);
  if (captured.status === 'received') {
    captured.receipt.items.forEach(Object.freeze); captured.receipt.exceptions.forEach(Object.freeze);
    Object.freeze(captured.receipt.items); Object.freeze(captured.receipt.exceptions); Object.freeze(captured.receipt);
  }
  return captured;
}
function sameRecord(a: TransferRecord | null, b: TransferRecord | null): boolean {
  return !!a && !!b && matchesDecisionRecord(a, b) && matchesDecisionRecord(b, a);
}
const failureStatuses: Readonly<Record<string, number>> = Object.freeze({ invalid_request: 400, unauthenticated: 401,
  forbidden: 403, not_found: 404, method_not_allowed: 405, retry_conflict: 409, decision_conflict: 409,
  insufficient_stock: 409, service_unavailable: 503 });
export function safeReconciliationError(error: unknown): DispatchReconciliationAPIError {
  if (error instanceof DispatchReconciliationAPIError && typeof error.code === 'string' && typeof error.uncertainReconciliation === 'boolean') {
    const local = error.status === null && ['invalid_request', 'invalid_response', 'network', 'aborted'].includes(error.code);
    const remote = typeof error.status === 'number' && Number.isInteger(error.status) && error.status >= 100 && error.status <= 599
      && (error.code === 'invalid_response' || failureStatuses[error.code] === error.status);
    if (local || remote) return Object.freeze(new DispatchReconciliationAPIError(error.code, error.status, error.uncertainReconciliation));
  }
  return Object.freeze(new DispatchReconciliationAPIError('invalid_response', null, true));
}
function definitiveRefusal(error: DispatchReconciliationAPIError): boolean {
  // Only these recognized, explicitly non-uncertain domain refusals unlock fresh work.
  // Auth/privacy/service/transport errors remain conservative recovery obligations.
  return error.uncertainReconciliation === false && (error.code === 'invalid_request' && error.status === 400
    || error.status === 409 && ['retry_conflict', 'decision_conflict', 'insufficient_stock'].includes(error.code));
}
/** One private coordinator per controlled pane. Inject an owner-held instance to survive pane unmounts.
 * Only synchronize/select change ownership/selection; obsolete tickets can never adopt an owner.
 * No credentials, storage, subscriptions to global auth, or automatic writes live here.
 */
export function createTransferDispatchReconciliationStore(options: { operationKey?: () => string } = {}) {
  let owner: Readonly<DecisionOwner> | null = null;
  let original: TransferRecord | null = null;
  let snapshot: DispatchReconciliations | null = null;
  let draft: ReconciliationDraft | null = null;
  let review: ReconciliationReview | null = null;
  let error: DispatchReconciliationAPIError | null = null;
  let read: ReconciliationReadTicket | null = null;
  const lanes = new Map<string, Lane>();
  const masked = new Set<string>();
  const listeners = new Set<() => void>();
  const owns = (next: DecisionOwner | null) => sameCountOwner(owner, next);
  const selected = (next: DecisionOwner | null, record: TransferRecord) => owns(next) && sameRecord(original, record);
  const key = (record: TransferRecord, variant: number) => `${record.id}:${variant}`;
  function emit() { for (const listener of [...listeners]) { try { listener(); } catch { /* Detached readers cannot prevent settlement. */ } } }
  function clearView() { snapshot = null; draft = null; review = null; error = null; read = null; }
  function lane(ticket: ReconciliationWriteTicket): Lane | undefined {
    const e = lanes.get(key(ticket.attempt.original, ticket.attempt.payload.variant_id));
    return owns(ticket.attempt.owner) && e?.flight === ticket && e.attempt === ticket.attempt ? e : undefined;
  }
  function currentRead(ticket: ReconciliationReadTicket) { return read === ticket && selected(ticket.owner, ticket.original); }
  function allowed(next: DecisionOwner, record: TransferRecord) {
    return selected(next, record) && !masked.has(record.id) && snapshot !== null;
  }
  function blocked(record: TransferRecord, variant: number) {
    // One owned unresolved intent is a recovery lane, not a draft for another target.
    if ([...lanes.values()].some(e => !['confirmed', 'failed'].includes(e.attempt.phase))) return true;
    const e = lanes.get(key(record, variant));
    return !!e && e.attempt.phase !== 'failed' && !sameRecord(e.attempt.original, record);
  }
  function hide(id: string) {
    masked.add(id);
    if (original?.id === id) clearView();
    for (const e of lanes.values()) if (e.attempt.original.id === id && e.flight) {
      e.flight = null; e.attempt = Object.freeze({ ...e.attempt, phase: 'uncertain', priorUncertainty: true });
    }
  }
  function confirmed(e: Lane, operation: DispatchReconciliationOperation) {
    e.flight = null; e.attempt = Object.freeze({ ...e.attempt, phase: 'confirmed', result: operation, failure: null });
  }
  return {
    synchronize(next: DecisionOwner | null) {
      if (sameCountOwner(owner, next) || !owner && !next) return;
      owner = next ? Object.freeze({ account: next.account, location: next.location, epoch: next.epoch, generation: next.generation }) : null;
      lanes.clear(); masked.clear(); original = null; clearView();
    },
    select(next: DecisionOwner | null, record: TransferRecord | null) {
      if (!owns(next)) return false;
      let captured: TransferRecord | null = null;
      try { if (record) { captured = captureScope(record); if (captured.status !== 'received') captured = null; } } catch { /* Invalid scope is private-empty. */ }
      if (sameRecord(original, captured) || !original && !captured) return !!captured;
      original = captured; clearView(); return !!captured;
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    state(next: DecisionOwner | null, record: TransferRecord): ReconciliationStoreState {
      if (!selected(next, record)) return empty;
      if (masked.has(record.id)) return Object.freeze({ ...empty, masked: true, error });
      const attempts = Object.freeze([...lanes.values()].filter(e => sameRecord(e.attempt.original, record)).map(e => e.attempt));
      return Object.freeze({ snapshot, draft, review, attempts, error: error ?? attempts.find(a => a.failure)?.failure ?? null,
        busy: !!read || attempts.some(a => a.phase === 'inFlight'), masked: false });
    },
    beginRead(next: DecisionOwner, record: TransferRecord, explicit = false): ReconciliationReadTicket | null {
      if (!selected(next, record)) return null;
      // Select has already strictly captured the record; no view-owned mutable object escapes.
      read = Object.freeze({ original: captureScope(record), owner: Object.freeze({ ...owner! }), explicit });
      error = null; emit(); return read;
    },
    isReadCurrent: currentRead,
    finishRead(ticket: ReconciliationReadTicket, value: unknown): readonly DispatchReconciliationOperation[] {
      if (!currentRead(ticket)) return Object.freeze([]);
      const captured = parseDispatchReconciliations(wire(value), ticket.original);
      if (!masked.has(ticket.original.id) || ticket.explicit) {
        for (const e of lanes.values()) if (sameRecord(e.attempt.original, ticket.original) && e.attempt.phase === 'confirmed'
          && resolveDispatchReconciliationAttempt(e.attempt, captured).status !== 'confirmed') {
          // A read omitting already-proven immutable evidence cannot be a fresh review head.
          // Retain confirmation; never reinterpret absence as rollback.
          throw new Error('Snapshot contradicts confirmed reconciliation');
        }
      }
      read = null;
      if (masked.has(ticket.original.id) && !ticket.explicit) { emit(); return Object.freeze([]); }
      if (ticket.explicit) masked.delete(ticket.original.id);
      const results: DispatchReconciliationOperation[] = [];
      for (const e of lanes.values()) {
        if (!sameRecord(e.attempt.original, ticket.original) || ['confirmed', 'failed'].includes(e.attempt.phase)) continue;
        const outcome = resolveDispatchReconciliationAttempt(e.attempt, captured);
        if (outcome.status === 'confirmed') { confirmed(e, outcome.operation); results.push(outcome.operation); }
        else if (outcome.status === 'conflict') { e.flight = null; e.attempt = Object.freeze({ ...e.attempt, phase: 'conflict', priorUncertainty: true }); }
        // Missing operations do not resolve uncertainty or retire a live write.
      }
      snapshot = captured; error = null;
      if (review && !isDispatchReconciliationReviewCurrent(review.data, ticket.original, captured)) { review = null; draft = null; }
      emit(); return Object.freeze(results);
    },
    failRead(ticket: ReconciliationReadTicket, failure: unknown) {
      if (!currentRead(ticket)) return;
      const safe = safeReconciliationError(failure); read = null; snapshot = null; review = null; draft = null;
      if (safe.status === 401 || safe.status === 403 || safe.status === 404) hide(ticket.original.id);
      error = safe; emit();
    },
    releaseRead(ticket: ReconciliationReadTicket) { if (currentRead(ticket)) { read = null; emit(); } },
    begin(next: DecisionOwner, record: TransferRecord, variantID: number, action: DispatchReconciliationAction): boolean {
      if (!allowed(next, record) || blocked(record, variantID) || !['propose', 'accept', 'reject'].includes(action)
        || !dispatchReconciliationActionHints(record, snapshot!, variantID, next.location)[action]) return false;
      draft = Object.freeze({ variantID, action, reason: '' }); review = null; error = null; emit(); return true;
    },
    setReason(next: DecisionOwner, record: TransferRecord, reason: string) {
      if (!allowed(next, record) || !draft || review || typeof reason !== 'string') return;
      draft = Object.freeze({ ...draft, reason }); emit();
    },
    review(next: DecisionOwner, record: TransferRecord): boolean {
      if (!allowed(next, record) || !draft || review || blocked(record, draft.variantID)) return false;
      const { variantID, action, reason } = draft;
      if (!dispatchReconciliationActionHints(record, snapshot!, variantID, next.location)[action]) return false;
      const data = captureDispatchReconciliationReview(record, snapshot!, variantID);
      const line = snapshot!.lines.find(l => l.variant_id === variantID);
      if (!data || !line) return false;
      try {
        const operation_key = (options.operationKey ?? (() => crypto.randomUUID()))();
        const attempt = captureDispatchReconciliationAttempt(record, next.location, action, { variant_id: variantID, reason, operation_key,
          expected_revision: line.workflow_revision.toString(), ...(action === 'propose' ? { dispatch_quantity: line.effective_actual.toString() } : {}) });
        const preview = action === 'propose' ? previewDispatchReconciliation(line) : previewHistoricalDispatchReconciliation(line.proposals.at(-1)!);
        review = Object.freeze({ data, attempt, preview }); emit(); return true;
      } catch { error = new DispatchReconciliationAPIError('invalid_request', null); emit(); return false; }
    },
    cancel(next: DecisionOwner, record: TransferRecord) {
      if (!selected(next, record)) return; draft = null; review = null; emit();
    },
    confirm(next: DecisionOwner, record: TransferRecord): ReconciliationWriteTicket | null {
      if (!allowed(next, record) || read || !review || blocked(record, review.data.variant_id)) return null;
      const r = review;
      if (!isDispatchReconciliationReviewCurrent(r.data, record, snapshot!)
        || !dispatchReconciliationActionHints(record, snapshot!, r.data.variant_id, next.location)[r.attempt.action]) {
        review = null; draft = null; emit(); return null;
      }
      const previous = lanes.get(key(record, r.data.variant_id));
      if (previous?.attempt.payload.operation_key === r.attempt.payload.operation_key) return null;
      const attempt: OwnedReconciliationAttempt = Object.freeze({ ...r.attempt, owner: Object.freeze({ ...owner! }), phase: 'inFlight', priorUncertainty: false, result: null, failure: null });
      const ticket = Object.freeze({ attempt }); lanes.set(key(record, r.data.variant_id), { attempt, flight: ticket });
      draft = null; review = null; error = null; emit(); return ticket;
    },
    retry(next: DecisionOwner, record: TransferRecord, variantID: number): ReconciliationWriteTicket | null {
      if (!selected(next, record) || masked.has(record.id)) return null;
      const e = lanes.get(key(record, variantID));
      if (!e || e.flight || !sameRecord(e.attempt.original, record) || !['uncertain', 'conflict'].includes(e.attempt.phase)) return null;
      e.attempt = Object.freeze({ ...e.attempt, phase: 'inFlight', priorUncertainty: true, failure: null });
      const ticket = Object.freeze({ attempt: e.attempt }); e.flight = ticket; error = null; emit(); return ticket;
    },
    isWriteCurrent(ticket: ReconciliationWriteTicket) { return !!lane(ticket); },
    finishWrite(ticket: ReconciliationWriteTicket, value: unknown): DispatchReconciliationOperation | null {
      const e = lane(ticket); if (!e) return null;
      const op = parseDispatchReconciliationOperation(wire(value), e.attempt.original);
      if (!matchesDispatchReconciliationOperation(op, BigInt(e.attempt.original.id), e.attempt.actor, e.attempt.action, e.attempt.payload)) throw new Error('Invalid reconciliation identity');
      confirmed(e, op);
      if (sameRecord(original, e.attempt.original)) clearView();
      emit(); return op;
    },
    failWrite(ticket: ReconciliationWriteTicket, failure: unknown) {
      const e = lane(ticket); if (!e) return;
      const safe = safeReconciliationError(failure); e.flight = null;
      const priorUncertainty = e.attempt.priorUncertainty || !definitiveRefusal(safe);
      e.attempt = Object.freeze({ ...e.attempt, phase: priorUncertainty ? 'uncertain' : 'failed', priorUncertainty, failure: safe });
      if (safe.status === 401 || safe.status === 403 || safe.status === 404) hide(e.attempt.original.id);
      if (sameRecord(original, e.attempt.original)) error = safe;
      emit();
    },
    release(ticket: ReconciliationWriteTicket) {
      const e = lane(ticket); if (!e) return;
      e.flight = null; e.attempt = Object.freeze({ ...e.attempt, phase: 'uncertain', priorUncertainty: true, failure: new DispatchReconciliationAPIError('aborted', null, true) }); emit();
    },
  };
}
export type TransferDispatchReconciliationStore = ReturnType<typeof createTransferDispatchReconciliationStore>;
