import { captureDecisionRecord, matchesDecisionRecord, type DecisionOwner } from './transferDecisionRecovery';
import type { TransferRecord } from './transferModel';
import type { TransferErrorCode } from './transferAPI';

export interface DispatchFailure { readonly code: TransferErrorCode; readonly status: number | null; readonly uncertainDispatch: boolean }
export interface DispatchAttempt {
  readonly original: TransferRecord; readonly owner: Readonly<DecisionOwner>;
  readonly phase: 'uncertain' | 'inFlight' | 'confirmed'; readonly result: TransferRecord | null;
  readonly failure: Readonly<DispatchFailure> | null;
}
export interface DispatchFlight { readonly attempt: DispatchAttempt }
export function createTransferDispatchRecovery() {
  let attempt: DispatchAttempt | null = null;
  let flight: DispatchFlight | null = null;
  let masked = false;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* Detached readers cannot block settlement. */ }
    }
  };
  const owned = (owner: DecisionOwner | null) => !!owner && !!attempt && owner.account === attempt.owner.account
    && owner.location === attempt.owner.location && owner.epoch === attempt.owner.epoch && owner.generation === attempt.owner.generation;
  function claim(owner: DecisionOwner | null, reading = false): DispatchFlight | null {
    if (!owned(owner) || !attempt || flight || (masked && !reading)) return null;
    attempt = Object.freeze({ ...attempt, phase: 'inFlight', failure: null });
    flight = Object.freeze({ attempt });
    const token = flight;
    emit(); return token;
  }
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    get(owner: DecisionOwner | null): DispatchAttempt | null { return owned(owner) && !masked ? attempt : null; },
    start(record: TransferRecord, owner: DecisionOwner): DispatchFlight | null {
      if (record.status !== 'approved' || owner.location !== record.origin_location_id) return null;
      const original = captureDecisionRecord(record);
      if (owned(owner) && attempt) {
        // Mask only the unavailable request; unmasked uncertainty still pins its original.
        if (flight || (masked && attempt.original.id === original.id)) return null;
        if (!masked && attempt.phase === 'uncertain') {
          if (!matchesDecisionRecord(attempt.original, original)) return null;
          return claim(owner);
        }
      }
      attempt = Object.freeze({ original, owner: Object.freeze({ ...owner }), phase: 'uncertain', result: null, failure: null });
      flight = null; masked = false;
      return claim(owner);
    },
    claim,
    isCurrent(token: DispatchFlight, owner: DecisionOwner | null) { return flight === token && owned(owner); },
    finish(token: DispatchFlight, outcome?: TransferRecord, privateView = false, failure?: DispatchFailure): boolean {
      if (flight !== token || attempt !== token.attempt) return false;
      const result = outcome ? captureDecisionRecord(outcome) : null;
      if (result && (!matchesDecisionRecord(attempt.original, result) || (result.status !== 'approved' && result.status !== 'in_transit'))) {
        throw new Error('Invalid dispatch identity');
      }
      const confirmed = result?.status === 'in_transit';
      flight = null; masked = privateView;
      // An Approved GET cannot establish that a previously sent POST failed.
      attempt = Object.freeze({ ...attempt, phase: confirmed ? 'confirmed' : 'uncertain', result: confirmed ? result : null,
        failure: failure ? Object.freeze({ code: failure.code, status: failure.status, uncertainDispatch: failure.uncertainDispatch }) : null });
      emit(); return confirmed;
    },
  };
}
export type TransferDispatchRecovery = ReturnType<typeof createTransferDispatchRecovery>;
