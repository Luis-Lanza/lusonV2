import { RestitutionAPIError } from './transferAPI';
import { captureDecisionRecord, type DecisionOwner } from './transferDecisionRecovery';
import { captureCountCorrections, sameCountOwner } from './transferCountCorrectionRecovery';
import type { CountCorrections, CountCorrectionLine } from './transferCountCorrectionModel';
import type { TransferRecord } from './transferModel';
import { captureRestitutionOperation, captureRestitutions, matchesRestitutionOperation, normalizeRestitutionDecision,
  normalizeRestitutionProposal, restitutionActorLocation, type RestitutionAction, type RestitutionDecisionInput,
  type RestitutionProposalInput, type RestitutionNormalizedDecision, type RestitutionNormalizedProposal,
  type RestitutionOperation, type RestitutionProposal, type Restitutions } from './transferRestitutionModel';

export interface RestitutionAttempt {
  readonly owner: Readonly<DecisionOwner>;
  readonly requestID: bigint;
  readonly action: RestitutionAction;
  readonly payload: RestitutionNormalizedDecision | RestitutionNormalizedProposal;
  readonly phase: 'inFlight' | 'uncertain' | 'confirmed' | 'conflict' | 'failed';
  readonly priorUncertainty: boolean;
  readonly result: RestitutionOperation | null;
  readonly failure: RestitutionAPIError | null;
}
// Public shapes are diagnostic only. Private reference ownership grants capability.
export interface RestitutionReviewPin { readonly kind: 'restitution-review' }
export interface RestitutionFlight { readonly attempt: RestitutionAttempt }
export type RestitutionBlocker = 'retired' | 'consumed' | 'masked' | 'busy' | 'unresolved' | 'history'
  | 'header' | 'role' | 'variant' | 'proposal' | 'applied' | 'count-history' | 'count-mismatch' | 'count-pending' | 'predecessor' | 'capacity';
export type RestitutionEligibility = Readonly<{ eligible: true; blocker: null } | { eligible: false; blocker: RestitutionBlocker }>;
export type RestitutionEvidenceStream = 'header' | 'restitution' | 'count';
interface Evidence {
  restitution: Restitutions | null; count: CountCorrections | null;
  restitutionClean: boolean; countClean: boolean;
  restitutionEpoch: number; countEpoch: number; headerEpoch: number;
}
interface ReviewedAcceptance {
  readonly header: Readonly<Pick<TransferRecord, 'id' | 'origin_location_id' | 'destination_location_id'>>;
  readonly item: Readonly<Pick<TransferRecord['items'][number], 'variant_id' | 'quantity'>>;
  readonly receipt: Readonly<Extract<TransferRecord, { status: 'received' }>['receipt']['items'][number]>;
  readonly proposal: RestitutionProposal;
}
interface Entry { attempt: RestitutionAttempt; flight: RestitutionFlight | null; acceptance: ReviewedAcceptance | null }
function matchesReviewedOperation(e: Entry, op: RestitutionOperation): boolean {
  const a = e.attempt;
  return matchesRestitutionOperation(op, a.requestID, restitutionActorLocation(a.owner.location), a.action, a.payload)
    && (a.action !== 'accept' || e.acceptance !== null
      && op.source_existing_after! - op.source_existing_before! === e.acceptance.proposal.retained_quantity);
}
function matchesReviewedHistory(e: Entry, snapshot: Restitutions): boolean {
  const c = e.acceptance;
  if (!c) return e.attempt.action !== 'accept';
  const line = snapshot.lines.find(l => l.variant_id === c.item.variant_id);
  const p = line?.proposals.find(p => p.revision === c.proposal.revision);
  if (snapshot.request_id !== BigInt(c.header.id) || !line || !p
    || line.expected_quantity !== c.item.quantity || line.expected_quantity !== c.receipt.expected_quantity
    || line.original_credit !== c.receipt.available_quantity) return false;
  // Compare the immutable agreement, not its later decision/state or live count pins.
  const fields = ['revision', 'operation_key', 'initiator_location_id', 'retained_quantity', 'retained_at_origin',
    'base_revision', 'count_generation', 'count_applied_revision', 'base_dispatch', 'base_credit', 'base_restitution', 'reason', 'recorded_at'] as const;
  if (fields.some(field => p[field] !== c.proposal[field])
    || snapshot.operations.filter(op => op.variant_id === c.item.variant_id).some(op => op.actor_location_id !==
      (op.action === 'propose' ? c.header.origin_location_id : c.header.destination_location_id))) return false;
  const op = snapshot.operations.find(op => matchesReviewedOperation(e, op));
  if (!op) return p.decision === null || p.decision.operation_key !== e.attempt.payload.operation_key;
  return p.state === 'applied' && p.decision?.accepted === true
    && p.decision.operation_key === op.operation_key && p.decision.actor_location_id === c.header.destination_location_id
    && p.decision.reason === op.reason && p.decision.recorded_at === op.recorded_at
    && p.application?.operation_key === op.operation_key && p.application.origin_location_id === c.header.origin_location_id
    && p.application.quantity === c.proposal.retained_quantity && p.application.recorded_at === op.recorded_at;
}
interface Pin {
  owner: Readonly<DecisionOwner>; record: TransferRecord; variant: number; action: RestitutionAction;
  selection: number; evidence: Evidence; restitutionEpoch: number; countEpoch: number; headerEpoch: number; consumed: boolean;
}
function normalizePayload(action: RestitutionAction, input: RestitutionProposalInput | RestitutionDecisionInput): RestitutionNormalizedDecision | RestitutionNormalizedProposal {
  return action === 'propose' ? normalizeRestitutionProposal(input as RestitutionProposalInput) : normalizeRestitutionDecision(input);
}
const key = (id: bigint, variant: number) => `${id}:${variant}`;
const blocked = (blocker: RestitutionBlocker): RestitutionEligibility => Object.freeze({ eligible: false, blocker });
const eligible: RestitutionEligibility = Object.freeze({ eligible: true, blocker: null });
export function restitutionRetryPayload(attempt: RestitutionAttempt): RestitutionDecisionInput | RestitutionProposalInput {
  const p = attempt.payload;
  return Object.freeze({ variant_id: p.variant_id, operation_key: p.operation_key, expected_revision: p.expected_revision.toString(),
    reason: p.reason, ...('retained_quantity' in p ? { retained_quantity: p.retained_quantity.toString(), retained_at_origin: true as const } : {}) });
}

// The C4 capture validates wire types, not cross-array history. Reconcile the
// selected line from its actual operations, including zero-delta decisions.
function reconciledCount(history: CountCorrections, line: CountCorrectionLine, originCredit: bigint, origin: number, destination: number): boolean {
  const operations = history.operations.filter(op => op.variant_id === line.variant_id);
  const used = new Set<string>();
  if (new Set(history.lines.map(line => line.variant_id)).size !== history.lines.length
    || new Set(history.operations.map(op => op.operation_key)).size !== history.operations.length
    || line.workflow_revision !== BigInt(line.proposals.length)) return false;
  let applied = 0n; let credit = originCredit; let actual = line.actual_quantity;
  for (let i = 0; i < line.proposals.length; i++) {
    const p = line.proposals[i]; const previous = line.proposals[i - 1];
    const op = operations.find(op => op.operation_key === p.operation_key);
    if (previous && !previous.decision && (previous.state !== 'superseded' || previous.initiator_location_id !== p.initiator_location_id)) return false;
    if (p.revision !== BigInt(i + 1) || p.base_revision !== applied || line.reconciliation_revision === 0n && p.base_credit !== credit
      || ![origin, destination].includes(p.initiator_location_id) || !op || used.has(op.operation_key) || op.actor_location_id !== p.initiator_location_id
      || op.action !== 'propose' || op.expected_revision !== BigInt(i) || op.revision !== p.revision
      || op.actual_quantity !== p.actual_quantity || op.reason !== p.reason || op.recorded_at !== p.recorded_at) return false;
    used.add(op.operation_key);
    if (p.decision) {
      const d = p.decision; const decision = operations.find(op => op.operation_key === d.operation_key);
      if (!decision || used.has(decision.operation_key) || ![origin, destination].includes(d.actor_location_id)
        || d.actor_location_id === p.initiator_location_id || decision.actor_location_id !== d.actor_location_id
        || decision.action !== (d.accepted ? 'accept' : 'reject') || decision.expected_revision !== p.revision
        || decision.reason !== d.reason || decision.recorded_at !== d.recorded_at) return false;
      used.add(decision.operation_key);
      if (d.accepted) {
        const application = p.application;
        // Count history does not carry historical dispatch pins. Validate its
        // recorded delta against its own base, never today's dispatch. Only an
        // unreconciled line can be reconstructed from count applications alone.
        if (!application || application.effective_credit > p.actual_quantity
          || application.delta !== application.effective_credit - p.base_credit
          || line.reconciliation_revision === 0n && application.effective_credit !== (p.actual_quantity < line.expected_quantity ? p.actual_quantity : line.expected_quantity)
          || application.recorded_at !== d.recorded_at) return false;
        applied = p.revision; credit = application.effective_credit; actual = p.actual_quantity;
      }
    } else if (p.state !== (i === line.proposals.length - 1 ? 'pending' : 'superseded')) return false;
  }
  return used.size === operations.length && line.applied_revision === applied
    && (line.reconciliation_revision !== 0n || line.effective_credit === credit)
    && line.effective_credit === (line.effective_dispatch < actual ? line.effective_dispatch : actual)
    && line.effective_actual === actual && line.available_quantity === originCredit;
}

/** Pure owner memory. Effects must consume consumeConfirmations(), not inspect
 * finish's boolean or replay get(). No operation from unrelated history emits. */
export function createTransferRestitutionRecovery() {
  let owner: Readonly<DecisionOwner> | null = null;
  let ownerEpoch = 0; let selectionEpoch = 0; let selected: string | null = null;
  let selectedHeader: string | null = null;
  const entries = new Map<string, Entry>();
  const evidence = new Map<bigint, Evidence>();
  const masked = new Set<bigint>();
  const usedKeys = new Set<string>();
  const knownOperations = new Map<string, RestitutionOperation>();
  const pins = new WeakMap<RestitutionReviewPin, Pin>();
  const flights = new WeakMap<RestitutionFlight, Entry>();
  const listeners = new Set<() => void>();
  let confirmations: RestitutionOperation[] = [];
  function emit() {
    const epoch = ownerEpoch;
    for (const listener of [...listeners]) {
      if (epoch !== ownerEpoch) break;
      try { listener(); } catch { /* Detached readers cannot block settlement. */ }
    }
  }
  function synchronize(next: DecisionOwner | null) {
    if (sameCountOwner(owner, next) || !owner && !next) return;
    owner = next ? Object.freeze({ ...next }) : null; ownerEpoch++; selectionEpoch++; selected = null;
    selectedHeader = null; entries.clear(); evidence.clear(); masked.clear(); usedKeys.clear(); knownOperations.clear(); confirmations = [];
  }
  function stream(id: bigint): Evidence {
    let e = evidence.get(id);
    if (!e) {
      e = { restitution: null, count: null, restitutionClean: false, countClean: false,
        restitutionEpoch: 0, countEpoch: 0, headerEpoch: 0 }; evidence.set(id, e);
    }
    return e;
  }
  function select(next: DecisionOwner | null, id: bigint | null, variant: number | null) {
    synchronize(next);
    const value = id === null || variant === null ? null : key(id, variant);
    if (selected !== value) { selected = value; selectedHeader = null; selectionEpoch++; }
  }
  function owned(token: RestitutionFlight): Entry | null {
    const e = flights.get(token);
    return e && e.flight === token && entries.get(key(e.attempt.requestID, e.attempt.payload.variant_id)) === e
      && sameCountOwner(owner, e.attempt.owner) ? e : null;
  }
  function check(p: Pin): RestitutionEligibility {
    const id = BigInt(p.record.id); const s = p.evidence;
    if (!sameCountOwner(owner, p.owner) || p.selection !== selectionEpoch || selected !== key(id, p.variant)
      || evidence.get(id) !== s) return blocked('retired');
    if (p.consumed) return blocked('consumed');
    if (masked.has(id)) return blocked('masked');
    if (p.headerEpoch !== s.headerEpoch) return blocked('header');
    if (!s.restitutionClean || p.restitutionEpoch !== s.restitutionEpoch) return blocked('history');
    const previous = entries.get(key(id, p.variant));
    if (previous?.flight) return blocked('busy');
    if (previous && ['uncertain', 'conflict'].includes(previous.attempt.phase)) return blocked('unresolved');
    const line = s.restitution?.lines.find(l => l.variant_id === p.variant);
    if (!line || p.record.status !== 'received') return blocked('variant');
    const receipt = p.record.receipt.items.find(l => l.variant_id === p.variant);
    const item = p.record.items.find(l => l.variant_id === p.variant);
    if (!item || !receipt || receipt.expected_quantity !== line.expected_quantity || item.quantity !== line.expected_quantity
      || receipt.available_quantity !== line.original_credit) return blocked('header');
    if (p.owner.location !== (p.action === 'propose' ? p.record.origin_location_id : p.record.destination_location_id)) return blocked('role');
    // GET role evidence must also agree with the separately validated header.
    if (s.restitution!.operations.some(op => op.actor_location_id !== (op.action === 'propose'
      ? p.record.origin_location_id : p.record.destination_location_id))) return blocked('header');
    const proposal = line.proposals.at(-1);
    if (p.action !== 'propose' && (!proposal || proposal.decision !== null || proposal.revision !== line.workflow_revision)) return blocked('proposal');
    // SQL reject deliberately has no count availability/predecessor guard.
    if (p.action === 'reject') return eligible;
    if (line.applied_revision !== 0n || line.applied_retained_quantity !== 0n) return blocked('applied');
    if (!s.countClean || p.countEpoch !== s.countEpoch || !s.count || s.count.request_id !== id) return blocked('count-history');
    const count = s.count.lines.find(l => l.variant_id === p.variant);
    if (!count || count.expected_quantity !== line.expected_quantity || count.actual_quantity !== receipt.actual_quantity || !reconciledCount(s.count, count, line.original_credit, p.record.origin_location_id, p.record.destination_location_id)
      || count.applied_revision !== line.count_applied_revision || count.effective_credit !== line.effective_credit
      || count.effective_dispatch !== line.effective_dispatch || count.reconciliation_revision !== line.reconciliation_revision
      || BigInt(s.count.operations.filter(op => op.variant_id === p.variant).length) !== line.count_generation) return blocked('count-mismatch');
    if (count.proposals.at(-1)?.decision === null) return blocked('count-pending');
    if (p.action === 'accept' && proposal && (proposal.base_revision !== line.workflow_revision - 1n
      || proposal.count_generation !== line.count_generation || proposal.count_applied_revision !== line.count_applied_revision
      || proposal.base_dispatch !== line.effective_dispatch
      || proposal.base_credit !== line.effective_credit || proposal.base_restitution !== line.applied_retained_quantity)) return blocked('predecessor');
    const capacity = line.effective_dispatch - line.effective_credit - line.applied_retained_quantity;
    if (capacity <= 0n || p.action === 'accept' && proposal!.retained_quantity > capacity) return blocked('capacity');
    return eligible;
  }
  function claimEntry(e: Entry): RestitutionFlight | null {
    e.attempt = Object.freeze({ ...e.attempt, phase: 'inFlight', failure: null });
    const token = Object.freeze({ attempt: e.attempt }); e.flight = token; flights.set(token, e);
    emit(); return owned(token) ? token : null;
  }
  function confirm(e: Entry, op: RestitutionOperation): boolean {
    const a = e.attempt;
    if (a.phase === 'confirmed' || !matchesReviewedOperation(e, op)) return false;
    e.flight = null; e.attempt = Object.freeze({ ...a, phase: 'confirmed', result: op, failure: null });
    knownOperations.set(op.operation_key, op); confirmations.push(op); return true;
  }
  function invalidate(next: DecisionOwner, id: bigint, dependency: RestitutionEvidenceStream) {
    synchronize(next); const s = stream(id);
    if (dependency === 'count') { s.countClean = false; s.countEpoch++; }
    else if (dependency === 'restitution') { s.restitutionClean = false; s.restitutionEpoch++; }
    else { s.headerEpoch++; s.restitutionClean = false; s.restitutionEpoch++; }
    emit();
  }
  function mask(next: DecisionOwner, id: bigint) {
    synchronize(next); masked.add(id); const s = stream(id); s.restitutionClean = false; s.restitutionEpoch++;
    for (const e of entries.values()) if (e.attempt.requestID === id && e.flight) {
      e.flight = null; e.attempt = Object.freeze({ ...e.attempt, phase: 'uncertain', priorUncertainty: true });
    }
    emit();
  }
  return {
    synchronize, select, invalidate, mask,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    get(next: DecisionOwner | null, id: bigint): readonly RestitutionAttempt[] {
      synchronize(next);
      return Object.freeze(masked.has(id) ? [] : [...entries.values()].filter(e => e.attempt.requestID === id).map(e => e.attempt));
    },
    isRequestMasked(next: DecisionOwner | null, id: bigint): boolean { synchronize(next); return masked.has(id); },
    review(next: DecisionOwner, value: TransferRecord, variant: number, action: RestitutionAction): RestitutionReviewPin | null {
      synchronize(next);
      if (!['propose', 'accept', 'reject'].includes(action)) return null;
      let record: TransferRecord;
      try { record = captureDecisionRecord(value); restitutionActorLocation(next.location); } catch { return null; }
      if (record.status !== 'received') return null;
      select(next, BigInt(record.id), variant);
      const header = JSON.stringify(record, (_key, v: unknown) => typeof v === 'bigint' ? v.toString() : v);
      if (selectedHeader !== header) { selectedHeader = header; selectionEpoch++; }
      const s = stream(BigInt(record.id));
      const pin: Pin = { owner: Object.freeze({ ...next }), record, variant, action, selection: selectionEpoch, evidence: s,
        restitutionEpoch: s.restitutionEpoch, countEpoch: s.countEpoch, headerEpoch: s.headerEpoch, consumed: false };
      if (!check(pin).eligible) return null;
      const token: RestitutionReviewPin = Object.freeze({ kind: 'restitution-review' }); pins.set(token, pin); return token;
    },
    eligibility(next: DecisionOwner | null, token: RestitutionReviewPin): RestitutionEligibility {
      synchronize(next); const p = pins.get(token); return p ? check(p) : blocked('retired');
    },
    start(token: RestitutionReviewPin, input: RestitutionProposalInput | RestitutionDecisionInput): RestitutionFlight | null {
      const p = pins.get(token); if (!p || !check(p).eligible) return null;
      const payload = normalizePayload(p.action, input);
      if (!check(p).eligible) return null;
      const id = BigInt(p.record.id); const line = p.evidence.restitution!.lines.find(l => l.variant_id === p.variant)!;
      if (payload.variant_id !== p.variant || payload.expected_revision !== line.workflow_revision || usedKeys.has(payload.operation_key)
        || p.evidence.restitution!.operations.some(op => op.operation_key === payload.operation_key)) return null;
      if ('retained_quantity' in payload && payload.retained_quantity > line.effective_dispatch - line.effective_credit - line.applied_retained_quantity) return null;
      p.consumed = true; usedKeys.add(payload.operation_key);
      const attempt: RestitutionAttempt = Object.freeze({ owner: p.owner, requestID: id, action: p.action, payload,
        phase: 'inFlight', priorUncertainty: false, result: null, failure: null });
      // Retain only selected immutable consent, privately, while the pin is valid.
      const acceptance: ReviewedAcceptance | null = p.action === 'accept' && p.record.status === 'received' ? Object.freeze({
        header: Object.freeze({ id: p.record.id, origin_location_id: p.record.origin_location_id, destination_location_id: p.record.destination_location_id }),
        item: Object.freeze({ variant_id: p.variant, quantity: p.record.items.find(item => item.variant_id === p.variant)!.quantity }),
        receipt: Object.freeze({ ...p.record.receipt.items.find(item => item.variant_id === p.variant)! }),
        proposal: line.proposals.at(-1)!,
      }) : null;
      const e: Entry = { attempt, flight: null, acceptance }; entries.set(key(id, p.variant), e); return claimEntry(e);
    },
    claim(next: DecisionOwner, id: bigint, variant: number): RestitutionFlight | null {
      synchronize(next); const e = entries.get(key(id, variant));
      if (!e || masked.has(id) || e.flight || !['uncertain', 'conflict'].includes(e.attempt.phase)) return null;
      return claimEntry(e);
    },
    isCurrent(token: RestitutionFlight, next: DecisionOwner | null): boolean { synchronize(next); return !!owned(token); },
    finish(token: RestitutionFlight, value: unknown): boolean {
      const e = owned(token); if (!e) return false;
      const op = captureRestitutionOperation(value);
      if (owned(token) !== e) return false;
      if (!matchesReviewedOperation(e, op)) throw new Error('Invalid restitution operation identity');
      const epoch = ownerEpoch; const changed = confirm(e, op);
      const s = stream(e.attempt.requestID); s.restitutionClean = false; s.restitutionEpoch++;
      emit(); return epoch === ownerEpoch && changed;
    },
    fail(token: RestitutionFlight, failure: RestitutionAPIError) {
      const e = owned(token); if (!e) return;
      const definite = !failure.uncertainRestitution && (failure.status === 400 && failure.code === 'invalid_request'
        || failure.status === 409 && ['retry_conflict', 'decision_conflict', 'insufficient_stock'].includes(failure.code));
      const priorUncertainty = e.attempt.priorUncertainty || !definite;
      e.flight = null;
      e.attempt = Object.freeze({ ...e.attempt, phase: failure.code === 'retry_conflict' ? 'conflict' : priorUncertainty ? 'uncertain' : 'failed', priorUncertainty,
        failure: Object.freeze(new RestitutionAPIError(failure.code, failure.status, failure.uncertainRestitution)) });
      if (failure.status === 403 || failure.status === 404) mask(e.attempt.owner, e.attempt.requestID);
      else emit();
    },
    release(token: RestitutionFlight) {
      const e = owned(token); if (!e) return;
      e.flight = null; e.attempt = Object.freeze({ ...e.attempt, phase: 'uncertain', priorUncertainty: true,
        failure: Object.freeze(new RestitutionAPIError('aborted', null, true)) }); emit();
    },
    readFailure(next: DecisionOwner, id: bigint, dependency: 'restitution' | 'count', failure: RestitutionAPIError) {
      if (failure.status === 403 || failure.status === 404) mask(next, id);
      else invalidate(next, id, dependency);
    },
    observeCount(next: DecisionOwner, value: CountCorrections, explicit = false, dirty = false) {
      const snapshot = captureCountCorrections(value); synchronize(next); const s = stream(snapshot.request_id);
      s.countEpoch++; s.countClean = explicit && !dirty; s.count = snapshot; emit();
    },
    observe(next: DecisionOwner, value: Restitutions, explicit = false, dirty = false) {
      const snapshot = captureRestitutions(value); synchronize(next); const s = stream(snapshot.request_id);
      s.restitutionEpoch++; s.restitutionClean = explicit && !dirty; s.restitution = snapshot;
      if (masked.has(snapshot.request_id) && !explicit) { emit(); return; }
      if (explicit) masked.delete(snapshot.request_id);
      // Incomplete GETs cannot erase persisted evidence, including successes
      // whose current attempt entry was later replaced by a new proposal.
      for (const known of knownOperations.values()) if (known.request_id === snapshot.request_id) {
        const op = snapshot.operations.find(op => op.operation_key === known.operation_key);
        if (!op || (Object.keys(known) as (keyof RestitutionOperation)[]).some(field => op[field] !== known[field])) s.restitutionClean = false;
      }
      for (const e of entries.values()) {
        const a = e.attempt; if (a.requestID !== snapshot.request_id) continue;
        const op = snapshot.operations.find(op => matchesRestitutionOperation(op, a.requestID, restitutionActorLocation(a.owner.location), a.action, a.payload));
        if (a.action === 'accept' && !matchesReviewedHistory(e, snapshot)) {
          s.restitutionClean = false; continue;
        }
        if (op) confirm(e, op);
        else if (explicit && !dirty && !e.flight && a.priorUncertainty && a.phase !== 'confirmed') {
          const line = snapshot.lines.find(l => l.variant_id === a.payload.variant_id);
          if (line && line.workflow_revision > a.payload.expected_revision) e.attempt = Object.freeze({ ...a, phase: 'conflict' });
        }
      }
      emit();
    },
    consumeConfirmations(next: DecisionOwner | null): readonly RestitutionOperation[] {
      synchronize(next);
      const result = Object.freeze(confirmations.filter(op => !masked.has(op.request_id)));
      confirmations = confirmations.filter(op => masked.has(op.request_id)); return result;
    },
  };
}
export type TransferRestitutionRecovery = ReturnType<typeof createTransferRestitutionRecovery>;
