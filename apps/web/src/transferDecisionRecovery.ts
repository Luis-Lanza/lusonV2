import { parseTransferRecord, type TransferRecord } from './transferModel';
import type { TransferAuthority } from './useInventory';
import type { TransferErrorCode } from './transferAPI';

export type TransferDecision = 'approve' | 'reject';
export interface DecisionOwner { account: number; location: number; epoch: number; generation: number }
export interface DecisionFailure { readonly code: TransferErrorCode; readonly status: number | null; readonly uncertainDecision: boolean }
export interface DecisionAttempt {
  readonly original: TransferRecord; readonly action: TransferDecision; readonly owner: Readonly<DecisionOwner>;
  readonly phase: 'uncertain' | 'inFlight' | 'confirmed' | 'conflict'; readonly result: TransferRecord | null;
  readonly failure: Readonly<DecisionFailure> | null;
}
export interface DecisionFlight { readonly attempt: DecisionAttempt }
export function decisionOwner(authority: TransferAuthority): DecisionOwner | null {
  const session = authority.session;
  return authority.ready && session?.authenticated ? { account: session.identity.account_id,
    location: session.identity.location.id, epoch: authority.epoch, generation: authority.sessionGeneration ?? 0 } : null;
}
function sameOwner(a: DecisionOwner | null, b: DecisionOwner | null) {
  return !!a && !!b && a.account === b.account && a.location === b.location && a.epoch === b.epoch && a.generation === b.generation;
}
export function captureDecisionRecord(record: TransferRecord): TransferRecord {
  // Reuse the strict wire decoder even for injected APIs. Bigints stay decimal text.
  const copy = parseTransferRecord(JSON.stringify(record, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value));
  copy.items.forEach(Object.freeze); Object.freeze(copy.items);
  return Object.freeze(copy);
}
export function matchesDecisionRecord(original: TransferRecord, result: TransferRecord): boolean {
  const fields = ['id', 'reference', 'kind', 'created_at', 'creator_location_id', 'creator_location_name',
    'origin_location_id', 'origin_location_name', 'destination_location_id', 'destination_location_name',
    'approver_location_id', 'approver_location_name'] as const;
  const itemFields = ['variant_id', 'brand', 'model', 'capacity_ah', 'polarity', 'quantity'] as const;
  const metadataMatches = original.status === 'pending' || ((result.status === original.status
    || (original.status === 'approved' && result.status === 'in_transit'))
    && result.decision_location_id === original.decision_location_id && result.decided_at === original.decided_at
    && (original.status !== 'in_transit' || (result.dispatch_location_id === original.dispatch_location_id && result.dispatched_at === original.dispatched_at)));
  return metadataMatches && fields.every(field => original[field] === result[field]) && original.items.length === result.items.length
    && original.items.every((item, index) => itemFields.every(field => item[field] === result.items[index][field]));
}
export function requestedDecision(action: TransferDecision) { return action === 'approve' ? 'approved' : 'rejected'; }
export function satisfiesDecision(action: TransferDecision, result: TransferRecord) {
  return result.status === requestedDecision(action) || (action === 'approve' && result.status === 'in_transit');
}

export function createTransferDecisionRecovery() {
  let attempt: DecisionAttempt | null = null;
  let flight: DecisionFlight | null = null;
  let masked = false;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* One detached reader cannot block settlement. */ }
    }
  };
  const owned = (owner: DecisionOwner | null) => sameOwner(attempt?.owner ?? null, owner);
  function claim(owner: DecisionOwner | null, reading = false): DecisionFlight | null {
    if (!owned(owner) || !attempt || flight || (masked && !reading)) return null;
    attempt = Object.freeze({ ...attempt, phase: 'inFlight', failure: null });
    const token = Object.freeze({ attempt });
    flight = token; emit(); return token;
  }
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    get(owner: DecisionOwner | null): DecisionAttempt | null { return owned(owner) && !masked ? attempt : null; },
    start(record: TransferRecord, action: TransferDecision, owner: DecisionOwner): DecisionFlight | null {
      if (owner.location !== record.approver_location_id || (action !== 'approve' && action !== 'reject')) return null;
      const original = captureDecisionRecord(record);
      if (owned(owner) && attempt) {
        if (flight || masked) return null;
        if (attempt.phase === 'uncertain') {
          if (attempt.action !== action || !matchesDecisionRecord(attempt.original, original)) return null;
          return claim(owner);
        }
      }
      // A different owner never inherits the private original; obsolete opaque
      // flights can complete but cannot release this replacement flight.
      attempt = Object.freeze({ original, action, owner: Object.freeze({ ...owner }), phase: 'uncertain', result: null, failure: null });
      flight = null; masked = false;
      return claim(owner);
    },
    claim,
    isCurrent(token: DecisionFlight, owner: DecisionOwner | null) { return flight === token && owned(owner); },
    finish(token: DecisionFlight, outcome?: TransferRecord, privateView = false, failure?: DecisionFailure): boolean {
      if (flight !== token || attempt !== token.attempt) return false;
      // Identity validation precedes releasing the flight, including Pending GETs.
      const result = outcome ? captureDecisionRecord(outcome) : null;
      if (result && !matchesDecisionRecord(attempt.original, result)) throw new Error('Invalid decision identity');
      if (result && result.status !== 'pending' && result.decision_location_id !== attempt.owner.location) throw new Error('Invalid decision actor');
      flight = null; masked = privateView;
      const terminal = result?.status !== 'pending' && result !== null;
      attempt = Object.freeze({ ...attempt, phase: terminal ? satisfiesDecision(attempt.action, result) ? 'confirmed' : 'conflict' : 'uncertain', result: terminal ? result : null,
        failure: failure ? Object.freeze({ code: failure.code, status: failure.status, uncertainDecision: failure.uncertainDecision }) : null });
      emit(); return terminal;
    },
  };
}
export type TransferDecisionRecovery = ReturnType<typeof createTransferDecisionRecovery>;
