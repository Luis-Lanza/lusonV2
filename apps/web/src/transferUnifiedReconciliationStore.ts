import { matchesDecisionRecord, type DecisionOwner } from './transferDecisionRecovery';
import { sameCountOwner } from './transferCountCorrectionRecovery';
import { UnifiedReconciliationAPIError } from './transferUnifiedReconciliationAPI';
import { parseUnifiedReconciliations, parseUnifiedReconciliationOperation, type UnifiedReconciliations,
  type UnifiedReconciliationOperation, type UnifiedReconciliationAction, type UnifiedReconciliationDecisionInput,
  type UnifiedReconciliationProposalInput } from './transferUnifiedReconciliationModel';
import { captureUnifiedReconciliationAttempt, captureUnifiedReconciliationRecord, matchesUnifiedReconciliationOperation, resolveUnifiedReconciliationAttempt,
  type UnifiedReconciliationAttempt } from './transferUnifiedReconciliationRecovery';
import type { TransferRecord } from './transferModel';

export interface OwnedUnifiedReconciliationAttempt extends UnifiedReconciliationAttempt {
  readonly owner: Readonly<DecisionOwner>;
  readonly phase: 'inFlight' | 'uncertain' | 'conflict' | 'confirmed' | 'failed';
  readonly priorUncertainty: boolean;
  readonly result: UnifiedReconciliationOperation | null;
  readonly failure: UnifiedReconciliationAPIError | null;
}
export interface UnifiedReconciliationWriteTicket { readonly attempt: OwnedUnifiedReconciliationAttempt }
export interface UnifiedReconciliationReadTicket { readonly original: TransferRecord; readonly owner: Readonly<DecisionOwner>; readonly explicit: boolean }
interface Lane { attempt: OwnedUnifiedReconciliationAttempt; flight: UnifiedReconciliationWriteTicket | null }
export interface UnifiedReconciliationStoreState {
  readonly snapshot: UnifiedReconciliations | null;
  readonly prepared: UnifiedReconciliationAttempt | null;
  readonly attempts: readonly OwnedUnifiedReconciliationAttempt[];
  readonly error: UnifiedReconciliationAPIError | null;
  readonly busy: boolean;
  readonly masked: boolean;
}
const empty: UnifiedReconciliationStoreState = Object.freeze({ snapshot: null, prepared: null, attempts: Object.freeze([]), error: null, busy: false, masked: false });
const wire = (v: unknown) => JSON.stringify(v, (_k, value: unknown) => typeof value === 'bigint' ? value.toString() : value);
const sameRecord = (a: TransferRecord | null, b: TransferRecord | null) => !!a && !!b && matchesDecisionRecord(a, b) && matchesDecisionRecord(b, a);
const statuses: Readonly<Record<string, number>> = { invalid_request: 400, unauthenticated: 401, forbidden: 403, not_found: 404,
  method_not_allowed: 405, retry_conflict: 409, decision_conflict: 409, insufficient_stock: 409, service_unavailable: 503 };
export function safeUnifiedReconciliationError(error: unknown): UnifiedReconciliationAPIError {
  if (error instanceof UnifiedReconciliationAPIError && typeof error.uncertainReconciliation === 'boolean'
    && (error.status === null && ['invalid_request', 'invalid_response', 'network', 'aborted'].includes(error.code)
      || error.status !== null && Number.isInteger(error.status) && error.status >= 100 && error.status <= 599
        && (error.code === 'invalid_response' || statuses[error.code] === error.status))) {
    return Object.freeze(new UnifiedReconciliationAPIError(error.code, error.status, error.uncertainReconciliation));
  }
  return Object.freeze(new UnifiedReconciliationAPIError('invalid_response', null, true));
}
const refused = (e: UnifiedReconciliationAPIError) => !e.uncertainReconciliation
  && (e.status === 400 && e.code === 'invalid_request' || e.status === 409 && ['retry_conflict', 'decision_conflict', 'insufficient_stock'].includes(e.code));
/** Owner-held, inert coordinator. Selection never transfers unresolved intent to another record. */
export function createTransferUnifiedReconciliationStore() {
  let owner: Readonly<DecisionOwner> | null = null, original: TransferRecord | null = null;
  let snapshot: UnifiedReconciliations | null = null, prepared: UnifiedReconciliationAttempt | null = null;
  let preparedHead = '', error: UnifiedReconciliationAPIError | null = null, read: UnifiedReconciliationReadTicket | null = null;
  const lanes = new Map<string, Lane>(), masked = new Set<string>(), listeners = new Set<() => void>();
  const owns = (next: DecisionOwner | null) => sameCountOwner(owner, next);
  const selected = (next: DecisionOwner | null, record: TransferRecord) => owns(next) && sameRecord(original, record);
  const key = (a: UnifiedReconciliationAttempt) => `${a.original.id}:${a.payload.variant_id}`;
  const emit = () => { for (const fn of [...listeners]) { try { fn(); } catch { /* Detached observers cannot block settlement. */ } } };
  const clear = () => { snapshot = null; prepared = null; preparedHead = ''; error = null; read = null; };
  const currentRead = (t: UnifiedReconciliationReadTicket) => read === t && selected(t.owner, t.original);
  function lane(t: UnifiedReconciliationWriteTicket) {
    const e = lanes.get(key(t.attempt));
    return owns(t.attempt.owner) && e?.flight === t && e.attempt === t.attempt ? e : undefined;
  }
  function hide(id: string) {
    masked.add(id); if (original?.id === id) clear();
    for (const e of lanes.values()) if (e.attempt.original.id === id && e.flight) {
      e.flight = null; e.attempt = Object.freeze({ ...e.attempt, phase: 'uncertain', priorUncertainty: true });
    }
  }
  function confirmLane(e: Lane, op: UnifiedReconciliationOperation) {
    e.flight = null; e.attempt = Object.freeze({ ...e.attempt, phase: 'confirmed', result: op, failure: null });
  }
  function eligible(a: UnifiedReconciliationAttempt) {
    const l = snapshot?.lines.find(l => l.variant_id === a.payload.variant_id);
    if (!l || l.workflow_revision !== a.payload.expected_revision) return false;
    const head = l.proposals.at(-1), pending = head?.state === 'pending' ? head : null;
    if (a.action === 'propose') return !pending || pending.initiator_location_id === a.actor;
    if (!pending || pending.initiator_location_id === a.actor) return false;
    if (a.action === 'reject') return true;
    const c = snapshot!.current.find(c => c.variant_id === l.variant_id)!;
    return pending.base_source_debit === c.source_debit && pending.base_destination_credit === c.effective_credit
      && pending.count_generation === c.version.count && pending.restitution_generation === c.version.restitution
      && pending.reconciliation_generation === c.version.dispatch && pending.unified_generation + 1n === c.version.unified
      && !(pending.retained_quantity > 0n && a.actor === a.original.origin_location_id && !a.payload.retained_at_origin);
  }
  return {
    synchronize(next: DecisionOwner | null) {
      if (owns(next) || !owner && !next) return;
      owner = next ? Object.freeze({ account: next.account, location: next.location, epoch: next.epoch, generation: next.generation }) : null;
      lanes.clear(); masked.clear(); original = null; clear();
    },
    select(next: DecisionOwner | null, record: TransferRecord | null) {
      if (!owns(next)) return false;
      let captured: TransferRecord | null = null;
      try { if (record) { captured = captureUnifiedReconciliationRecord(record); if (captured.status !== 'received') captured = null; } } catch { /* Invalid scope stays empty. */ }
      if (!sameRecord(original, captured) && (original || captured)) { original = captured; clear(); }
      return !!captured;
    },
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    state(next: DecisionOwner | null, record: TransferRecord): UnifiedReconciliationStoreState {
      if (!selected(next, record)) return empty;
      if (masked.has(record.id)) return Object.freeze({ ...empty, masked: true, error });
      const attempts = Object.freeze([...lanes.values()].filter(e => sameRecord(e.attempt.original, record)).map(e => e.attempt));
      return Object.freeze({ snapshot, prepared, attempts, error: error ?? attempts.find(a => a.failure)?.failure ?? null,
        busy: !!read || attempts.some(a => a.phase === 'inFlight'), masked: false });
    },
    beginRead(next: DecisionOwner, record: TransferRecord, explicit = false): UnifiedReconciliationReadTicket | null {
      if (!selected(next, record)) return null;
      read = Object.freeze({ original: captureUnifiedReconciliationRecord(record), owner: Object.freeze({ ...owner! }), explicit }); error = null; emit(); return read;
    },
    isReadCurrent: currentRead,
    finishRead(t: UnifiedReconciliationReadTicket, value: unknown): readonly UnifiedReconciliationOperation[] {
      if (!currentRead(t)) return Object.freeze([]);
      const captured = parseUnifiedReconciliations(wire(value), t.original);
      if (masked.has(t.original.id) && !t.explicit) { read = null; emit(); return Object.freeze([]); }
      for (const e of lanes.values()) if (sameRecord(e.attempt.original, t.original) && e.attempt.phase === 'confirmed'
        && resolveUnifiedReconciliationAttempt(e.attempt, captured).status !== 'confirmed') throw new Error('Snapshot contradicts confirmed reconciliation');
      read = null; if (t.explicit) masked.delete(t.original.id);
      const results: UnifiedReconciliationOperation[] = [];
      for (const e of lanes.values()) if (sameRecord(e.attempt.original, t.original) && !['confirmed', 'failed'].includes(e.attempt.phase)) {
        const outcome = resolveUnifiedReconciliationAttempt(e.attempt, captured);
        if (outcome.status === 'confirmed') { confirmLane(e, outcome.operation); results.push(outcome.operation); }
        else if (outcome.status === 'conflict') { e.flight = null; e.attempt = Object.freeze({ ...e.attempt, phase: 'conflict', priorUncertainty: true }); }
      }
      snapshot = captured; error = null;
      if (prepared && preparedHead !== wire(captured)) { prepared = null; preparedHead = ''; }
      emit(); return Object.freeze(results);
    },
    failRead(t: UnifiedReconciliationReadTicket, failure: unknown) {
      if (!currentRead(t)) return;
      const safe = safeUnifiedReconciliationError(failure); clear();
      if ([401, 403, 404].includes(safe.status!)) hide(t.original.id);
      error = safe; emit();
    },
    releaseRead(t: UnifiedReconciliationReadTicket) { if (currentRead(t)) { read = null; emit(); } },
    prepare(next: DecisionOwner, record: TransferRecord, action: UnifiedReconciliationAction,
      input: UnifiedReconciliationDecisionInput | UnifiedReconciliationProposalInput) {
      if (!selected(next, record) || masked.has(record.id) || !snapshot
        || [...lanes.values()].some(e => !['confirmed', 'failed'].includes(e.attempt.phase))) return false;
      try {
        const a = captureUnifiedReconciliationAttempt(record, next.location, action, input);
        if (!eligible(a) || [...lanes.values()].some(e => e.attempt.payload.operation_key === a.payload.operation_key)) return false;
        prepared = a; preparedHead = wire(snapshot); error = null; emit(); return true;
      } catch { error = new UnifiedReconciliationAPIError('invalid_request', null); emit(); return false; }
    },
    cancel(next: DecisionOwner, record: TransferRecord) { if (selected(next, record)) { prepared = null; preparedHead = ''; emit(); } },
    confirm(next: DecisionOwner, record: TransferRecord): UnifiedReconciliationWriteTicket | null {
      if (!selected(next, record) || masked.has(record.id) || read || !snapshot || !prepared || preparedHead !== wire(snapshot)
        || !eligible(prepared) || [...lanes.values()].some(e => !['confirmed', 'failed'].includes(e.attempt.phase))) return null;
      const attempt: OwnedUnifiedReconciliationAttempt = Object.freeze({ ...prepared, owner: Object.freeze({ ...owner! }),
        phase: 'inFlight', priorUncertainty: false, result: null, failure: null });
      const ticket = Object.freeze({ attempt }); lanes.set(key(attempt), { attempt, flight: ticket });
      prepared = null; preparedHead = ''; error = null; emit(); return ticket;
    },
    retry(next: DecisionOwner, record: TransferRecord, variant: number): UnifiedReconciliationWriteTicket | null {
      if (!selected(next, record) || masked.has(record.id)) return null;
      const e = lanes.get(`${record.id}:${variant}`);
      if (!e || e.flight || !sameRecord(e.attempt.original, record) || !['uncertain', 'conflict'].includes(e.attempt.phase)) return null;
      e.attempt = Object.freeze({ ...e.attempt, phase: 'inFlight', priorUncertainty: true, failure: null });
      const ticket = Object.freeze({ attempt: e.attempt }); e.flight = ticket; error = null; emit(); return ticket;
    },
    isWriteCurrent(t: UnifiedReconciliationWriteTicket) { return !!lane(t); },
    finishWrite(t: UnifiedReconciliationWriteTicket, value: unknown): UnifiedReconciliationOperation | null {
      const e = lane(t); if (!e) return null;
      const op = parseUnifiedReconciliationOperation(wire({ schema: 'luson.transfer-reconciliation-operation/v2', operation: value }), e.attempt.original);
      if (!matchesUnifiedReconciliationOperation(e.attempt, op)) throw new Error('Invalid reconciliation identity');
      confirmLane(e, op); if (sameRecord(original, e.attempt.original)) clear(); emit(); return op;
    },
    failWrite(t: UnifiedReconciliationWriteTicket, failure: unknown) {
      const e = lane(t); if (!e) return;
      const safe = safeUnifiedReconciliationError(failure), priorUncertainty = e.attempt.priorUncertainty || !refused(safe);
      e.flight = null; e.attempt = Object.freeze({ ...e.attempt, phase: priorUncertainty ? 'uncertain' : 'failed', priorUncertainty, failure: safe });
      if ([401, 403, 404].includes(safe.status!)) hide(e.attempt.original.id);
      if (sameRecord(original, e.attempt.original)) error = safe; emit();
    },
    release(t: UnifiedReconciliationWriteTicket) {
      const e = lane(t); if (!e) return;
      e.flight = null; e.attempt = Object.freeze({ ...e.attempt, phase: 'uncertain', priorUncertainty: true,
        failure: new UnifiedReconciliationAPIError('aborted', null, true) }); emit();
    },
  };
}
export type TransferUnifiedReconciliationStore = ReturnType<typeof createTransferUnifiedReconciliationStore>;
