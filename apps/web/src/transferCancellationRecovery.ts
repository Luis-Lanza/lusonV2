import { captureDecisionRecord, matchesDecisionRecord, type DecisionOwner } from './transferDecisionRecovery';
import type { TransferRecord } from './transferModel';
import type { TransferErrorCode } from './transferAPI';

export interface CancellationFailure { readonly code: TransferErrorCode; readonly status: number | null; readonly uncertainCancellation: boolean }
export interface CancellationAttempt {
  readonly original: TransferRecord; readonly current: TransferRecord; readonly owner: Readonly<DecisionOwner>;
  readonly phase: 'uncertain' | 'inFlight' | 'confirmed' | 'conflict'; readonly result: TransferRecord | null;
  readonly failure: Readonly<CancellationFailure> | null;
}
export interface CancellationFlight { readonly attempt: CancellationAttempt }
export function createTransferCancellationRecovery() {
  let attempt: CancellationAttempt | null = null;
  let flight: CancellationFlight | null = null;
  let masks = new Set<string>();
  let closed = new Set<string>();
  const listeners = new Set<() => void>();
  const owned = (owner: DecisionOwner | null) => !!owner && !!attempt && owner.account === attempt.owner.account
    && owner.location === attempt.owner.location && owner.epoch === attempt.owner.epoch && owner.generation === attempt.owner.generation;
  const emit = () => { for (const listener of [...listeners]) { try { listener(); } catch { /* Detached readers cannot block settlement. */ } } };
  function claim(owner: DecisionOwner | null): CancellationFlight | null {
    if (!owned(owner) || !attempt || flight || masks.has(attempt.original.id)
      || attempt.phase === 'confirmed' || attempt.phase === 'conflict') return null;
    attempt = Object.freeze({ ...attempt, phase: 'inFlight', failure: null });
    const token = Object.freeze({ attempt }); flight = token; emit(); return token;
  }
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    get(owner: DecisionOwner | null): CancellationAttempt | null {
      return owned(owner) && attempt && !masks.has(attempt.original.id) ? attempt : null;
    },
    start(record: TransferRecord, owner: DecisionOwner): CancellationFlight | null {
      if ((record.status !== 'pending' && record.status !== 'approved') || record.creator_location_id !== owner.location) return null;
      const original = captureDecisionRecord(record);
      if (owned(owner) && attempt) {
        if (masks.has(original.id) || closed.has(original.id) || flight) return null;
        if (attempt.phase === 'uncertain' && !masks.has(attempt.original.id)) {
          if (attempt.original.id !== original.id || !matchesDecisionRecord(attempt.current, original)) return null;
          return claim(owner);
        }
        if (attempt.original.id === original.id && (attempt.phase === 'confirmed' || attempt.phase === 'conflict')) return null;
      } else { masks = new Set(); closed = new Set(); }
      attempt = Object.freeze({ original, current: original, owner: Object.freeze({ ...owner }), phase: 'uncertain', result: null, failure: null });
      flight = null; return claim(owner);
    },
    claim,
    isCurrent(token: CancellationFlight, owner: DecisionOwner | null) { return flight === token && owned(owner); },
    finish(token: CancellationFlight, outcome?: TransferRecord, privateView = false, failure?: CancellationFailure): boolean {
      if (flight !== token || attempt !== token.attempt) return false;
      const result = outcome ? captureDecisionRecord(outcome) : null;
      if (result && !matchesDecisionRecord(attempt.current, result)) throw new Error('Invalid cancellation identity');
      const terminal = !!result && result.status !== 'pending' && result.status !== 'approved';
      flight = null;
      if (privateView) masks.add(attempt.original.id);
      if (terminal) closed.add(attempt.original.id);
      // A still-cancellable GET cannot prove a sent POST failed. Pin any discovered
      // approval for all subsequent results, without rewriting the original request.
      attempt = Object.freeze({ ...attempt, current: result ?? attempt.current,
        phase: terminal ? result.status === 'cancelled' ? 'confirmed' : 'conflict' : 'uncertain',
        result: terminal ? result : null,
        failure: failure ? Object.freeze({ code: failure.code, status: failure.status, uncertainCancellation: failure.uncertainCancellation }) : null });
      emit(); return terminal;
    },
  };
}
export type TransferCancellationRecovery = ReturnType<typeof createTransferCancellationRecovery>;
