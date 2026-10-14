import { captureDecisionRecord, matchesDecisionRecord, type DecisionOwner } from './transferDecisionRecovery';
import { canonicalTransferReceiptInput, matchesReceiptInput, type TransferReceiptInput, type TransferRecord } from './transferModel';
import type { TransferErrorCode } from './transferAPI';

export interface ReceiptFailure { readonly code: TransferErrorCode; readonly status: number | null; readonly uncertainReceipt: boolean }
export interface ReceiptAttempt {
  readonly original: TransferRecord; readonly input: TransferReceiptInput; readonly owner: Readonly<DecisionOwner>;
  readonly phase: 'uncertain' | 'inFlight' | 'confirmed' | 'conflict'; readonly result: TransferRecord | null;
  readonly failure: Readonly<ReceiptFailure> | null;
}
export interface ReceiptFlight { readonly attempt: ReceiptAttempt }
export function createTransferReceiptRecovery() {
  let attempt: ReceiptAttempt | null = null;
  let flight: ReceiptFlight | null = null;
  let masked = false;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* Detached readers cannot prevent settlement. */ }
    }
  };
  const owned = (owner: DecisionOwner | null) => !!owner && !!attempt && owner.account === attempt.owner.account
    && owner.location === attempt.owner.location && owner.epoch === attempt.owner.epoch && owner.generation === attempt.owner.generation;
  function claim(owner: DecisionOwner | null, reading = false): ReceiptFlight | null {
    if (!owned(owner) || !attempt || flight || (masked && !reading) || attempt.phase === 'confirmed' || attempt.phase === 'conflict') return null;
    attempt = Object.freeze({ ...attempt, phase: 'inFlight', failure: null });
    const token = Object.freeze({ attempt }); flight = token; emit(); return token;
  }
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    get(owner: DecisionOwner | null): ReceiptAttempt | null { return owned(owner) && !masked ? attempt : null; },
    start(record: TransferRecord, input: TransferReceiptInput, owner: DecisionOwner): ReceiptFlight | null {
      if (record.status !== 'in_transit' || owner.location !== record.destination_location_id) return null;
      const original = captureDecisionRecord(record);
      const canonical = canonicalTransferReceiptInput(input, original);
      if (owned(owner) && attempt) {
        const sameID = attempt.original.id === original.id;
        if (flight || (masked && sameID) || (sameID && (attempt.phase === 'confirmed' || attempt.phase === 'conflict'))) return null;
        if (!masked && attempt.phase === 'uncertain') {
          if (!matchesDecisionRecord(attempt.original, original) || JSON.stringify(attempt.input) !== JSON.stringify(canonical)) return null;
          return claim(owner);
        }
      }
      attempt = Object.freeze({ original, input: canonical, owner: Object.freeze({ ...owner }), phase: 'uncertain', result: null, failure: null });
      flight = null; masked = false;
      return claim(owner);
    },
    claim,
    isCurrent(token: ReceiptFlight, owner: DecisionOwner | null) { return flight === token && owned(owner); },
    finish(token: ReceiptFlight, outcome?: TransferRecord, privateView = false, failure?: ReceiptFailure): boolean {
      if (flight !== token || attempt !== token.attempt) return false;
      const result = outcome ? captureDecisionRecord(outcome) : null;
      if (result && (!matchesDecisionRecord(attempt.original, result) || (result.status !== 'in_transit' && result.status !== 'received'))) {
        throw new Error('Invalid receipt identity');
      }
      const terminal = result?.status === 'received';
      flight = null; masked = privateView;
      // InTransit GET is not evidence that the previous POST failed. Received GET
      // establishes current truth, but may belong to a different receipt payload.
      attempt = Object.freeze({ ...attempt, phase: terminal ? matchesReceiptInput(attempt.input, result) ? 'confirmed' : 'conflict' : 'uncertain',
        result: terminal ? result : null, failure: failure ? Object.freeze({ code: failure.code, status: failure.status, uncertainReceipt: failure.uncertainReceipt }) : null });
      emit(); return terminal;
    },
  };
}
export type TransferReceiptRecovery = ReturnType<typeof createTransferReceiptRecovery>;
