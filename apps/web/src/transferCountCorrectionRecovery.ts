import { TransferAPIError } from './transferAPI';
import type { DecisionOwner } from './transferDecisionRecovery';
import { countActorLocation, countCorrectionsPath, matchesCountOperation, normalizeCountDecision, normalizeCountProposal,
  parseCountCorrections, parseCountOperation, type CountAction, type CountCorrections, type CountDecisionInput,
  type CountNormalizedDecision, type CountNormalizedProposal, type CountOperation, type CountProposalInput } from './transferCountCorrectionModel';

export interface CountCorrectionAttempt {
  readonly requestID: bigint;
  readonly action: CountAction;
  readonly payload: CountNormalizedDecision | CountNormalizedProposal;
  readonly owner: Readonly<DecisionOwner>;
  readonly phase: 'inFlight' | 'uncertain' | 'confirmed' | 'conflict' | 'failed';
  readonly result: CountOperation | null;
  readonly failure: TransferAPIError | null;
  readonly priorUncertainty: boolean;
}
export interface CountCorrectionFlight { readonly attempt: CountCorrectionAttempt }
interface Entry { attempt: CountCorrectionAttempt; flight: CountCorrectionFlight | null; masked: boolean }
export function sameCountOwner(a: DecisionOwner | null, b: DecisionOwner | null): boolean {
  return !!a && !!b && a.account === b.account && a.location === b.location && a.epoch === b.epoch && a.generation === b.generation;
}
const wire = (value: unknown) => JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? item.toString() : item);
export const captureCountOperation = (value: unknown) => parseCountOperation(wire(value));
export const captureCountCorrections = (value: unknown) => parseCountCorrections(wire(value));
export function countRetryPayload(attempt: CountCorrectionAttempt): CountDecisionInput | CountProposalInput {
  const p = attempt.payload;
  return Object.freeze({ variant_id: p.variant_id, operation_key: p.operation_key, expected_revision: p.expected_revision.toString(),
    reason: p.reason, ...('actual_quantity' in p ? { actual_quantity: p.actual_quantity.toString() } : {}) });
}
const key = (id: bigint, variant: number) => `${id}:${variant}`;
const uncertainError = () => Object.freeze(new TransferAPIError('aborted', null, false, false, false, false, false, true));

// Private evidence belongs to the authority, not to a pane or transport. Tokens
// are opaque by reference and never reconstructed from request/variant values.
export function createTransferCountCorrectionRecovery() {
  let owner: Readonly<DecisionOwner> | null = null;
  const entries = new Map<string, Entry>();
  const maskedRequests = new Set<bigint>();
  const listeners = new Set<() => void>();
  function emit() { for (const listener of [...listeners]) { try { listener(); } catch { /* Isolate detached readers. */ } } }
  function synchronize(next: DecisionOwner | null) {
    if (sameCountOwner(owner, next) || (!owner && !next)) return;
    entries.clear(); maskedRequests.clear(); owner = next ? Object.freeze({ ...next }) : null;
  }
  function entry(token: CountCorrectionFlight): Entry | null {
    const e = entries.get(key(token.attempt.requestID, token.attempt.payload.variant_id));
    return e?.flight === token && e.attempt === token.attempt ? e : null;
  }
  function confirm(e: Entry, op: CountOperation): CountOperation | null {
    if (e.attempt.phase === 'confirmed') return null;
    if (!matchesCountOperation(op, e.attempt.requestID, countActorLocation(e.attempt.owner.location), e.attempt.action, e.attempt.payload)) return null;
    e.flight = null; e.masked = false;
    e.attempt = Object.freeze({ ...e.attempt, phase: 'confirmed', result: op, failure: null });
    return op;
  }
  return {
    synchronize,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    get(next: DecisionOwner | null, id: bigint): readonly CountCorrectionAttempt[] {
      synchronize(next);
      return Object.freeze([...entries.values()].filter(e => !e.masked && e.attempt.requestID === id).map(e => e.attempt));
    },
    isRequestMasked(next: DecisionOwner | null, id: bigint): boolean {
      synchronize(next); return maskedRequests.has(id);
    },
    isMasked(next: DecisionOwner | null, id: bigint, variant: number): boolean {
      synchronize(next); return entries.get(key(id, variant))?.masked === true;
    },
    start(id: string, action: CountAction, input: CountProposalInput | CountDecisionInput, next: DecisionOwner): CountCorrectionFlight | null {
      countCorrectionsPath(id); countActorLocation(next.location);
      if (!['propose', 'accept', 'reject'].includes(action)) throw new Error('Invalid count action');
      const payload = action === 'propose' ? normalizeCountProposal(input as CountProposalInput) : normalizeCountDecision(input);
      synchronize(next);
      const requestID = BigInt(id); const k = key(requestID, payload.variant_id); const previous = entries.get(k);
      if (maskedRequests.has(requestID)) return null;
      if (previous && (previous.masked || previous.flight || previous.attempt.priorUncertainty && previous.attempt.phase !== 'confirmed'
        || previous.attempt.payload.operation_key === payload.operation_key)) return null;
      const attempt: CountCorrectionAttempt = Object.freeze({ requestID, action, payload, owner: Object.freeze({ ...next }),
        phase: 'inFlight', result: null, failure: null, priorUncertainty: false });
      const flight = Object.freeze({ attempt }); entries.set(k, { attempt, flight, masked: false }); emit(); return flight;
    },
    claim(next: DecisionOwner, id: bigint, variant: number): CountCorrectionFlight | null {
      synchronize(next); const e = entries.get(key(id, variant));
      if (maskedRequests.has(id)) return null;
      if (!e || e.masked || e.flight || !['uncertain', 'conflict'].includes(e.attempt.phase)) return null;
      e.attempt = Object.freeze({ ...e.attempt, phase: 'inFlight', failure: null });
      const flight = Object.freeze({ attempt: e.attempt }); e.flight = flight; emit(); return flight;
    },
    isCurrent(token: CountCorrectionFlight, next: DecisionOwner | null) {
      synchronize(next); return !!entry(token) && sameCountOwner(token.attempt.owner, next);
    },
    finish(token: CountCorrectionFlight, value: unknown): CountOperation | null {
      const e = entry(token); if (!e) return null;
      const op = captureCountOperation(value);
      if (!matchesCountOperation(op, e.attempt.requestID, countActorLocation(e.attempt.owner.location), e.attempt.action, e.attempt.payload)) throw new Error('Invalid count operation identity');
      const result = confirm(e, op); emit(); return result;
    },
    fail(token: CountCorrectionFlight, failure: TransferAPIError) {
      const e = entry(token); if (!e) return;
      const definite = !failure.uncertainCorrection && (failure.status === 400 && failure.code === 'invalid_request'
        || failure.status === 409 && ['retry_conflict', 'decision_conflict', 'insufficient_stock'].includes(failure.code));
      e.flight = null; e.masked = failure.status === 403 || failure.status === 404;
      const priorUncertainty = e.attempt.priorUncertainty || !definite;
      const capturedFailure = Object.freeze(new TransferAPIError(failure.code, failure.status, false, false, false, false, false, failure.uncertainCorrection));
      e.attempt = Object.freeze({ ...e.attempt, phase: priorUncertainty ? 'uncertain' : 'failed', priorUncertainty, failure: capturedFailure }); emit();
    },
    release(token: CountCorrectionFlight) {
      const e = entry(token); if (!e) return;
      e.flight = null; e.attempt = Object.freeze({ ...e.attempt, phase: 'uncertain', priorUncertainty: true, failure: uncertainError() }); emit();
    },
    mask(next: DecisionOwner, id: bigint) {
      synchronize(next); maskedRequests.add(id);
      for (const e of entries.values()) if (e.attempt.requestID === id) {
        e.masked = true; e.flight = null;
        if (e.attempt.phase === 'inFlight') e.attempt = Object.freeze({ ...e.attempt, phase: 'uncertain', priorUncertainty: true });
      }
      emit();
    },
    observe(next: DecisionOwner, value: CountCorrections, explicit = false, dirty = false): readonly CountOperation[] {
      const snapshot = captureCountCorrections(value);
      synchronize(next); const confirmed: CountOperation[] = [];
      if (maskedRequests.has(snapshot.request_id) && !explicit) return confirmed;
      if (explicit) maskedRequests.delete(snapshot.request_id);
      for (const e of entries.values()) {
        const a = e.attempt;
        if (a.requestID !== snapshot.request_id || e.masked && !explicit) continue;
        if (explicit) e.masked = false;
        const match = snapshot.operations.find(op => matchesCountOperation(op, a.requestID, countActorLocation(next.location), a.action, a.payload));
        if (match) { const op = confirm(e, match); if (op) confirmed.push(op); }
        else if (!dirty && !e.flight && a.priorUncertainty && a.phase !== 'confirmed') {
          const line = snapshot.lines.find(line => line.variant_id === a.payload.variant_id);
          e.attempt = Object.freeze({ ...a, phase: line && line.workflow_revision > a.payload.expected_revision ? 'conflict' : 'uncertain' });
        }
      }
      emit(); return Object.freeze(confirmed);
    },
  };
}
export type TransferCountCorrectionRecovery = ReturnType<typeof createTransferCountCorrectionRecovery>;
