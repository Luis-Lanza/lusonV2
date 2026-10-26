import { parse as parseJSON } from 'lossless-json';
import { countActorLocation } from './transferCountCorrectionModel';
import type { TransferRecord, TransferLocationID } from './transferModel';

export type DispatchReconciliationAction = 'propose' | 'accept' | 'reject';
export type DispatchReconciliationState = 'pending' | 'superseded' | 'rejected' | 'applied';
/** Trusted existing record, not a new authorization capability. */
export type DispatchReconciliationContext = TransferRecord;
export interface DispatchReconciliationOperation {
  readonly operation_key: string;
  readonly request_id: bigint;
  readonly variant_id: number;
  readonly actor_location_id: TransferLocationID;
  readonly action: DispatchReconciliationAction;
  readonly expected_revision: bigint;
  readonly dispatch_quantity: bigint | null;
  readonly reason: string;
  readonly revision: bigint;
  readonly source_existing_before: bigint | null;
  readonly source_existing_after: bigint | null;
  readonly destination_existing_before: bigint | null;
  readonly destination_existing_after: bigint | null;
  readonly recorded_at: string;
}
export interface DispatchReconciliationDecision {
  readonly operation_key: string;
  readonly actor_location_id: TransferLocationID;
  readonly accepted: boolean;
  readonly reason: string;
  readonly recorded_at: string;
}
export interface DispatchReconciliationApplication {
  readonly operation_key: string;
  readonly effective_dispatch: bigint;
  readonly source_delta: bigint;
  readonly destination_delta: bigint;
  readonly recorded_at: string;
}
export interface DispatchReconciliationProposal {
  readonly revision: bigint;
  readonly operation_key: string;
  readonly initiator_location_id: TransferLocationID;
  readonly dispatch_quantity: bigint;
  readonly base_dispatch: bigint;
  readonly base_actual: bigint;
  readonly base_credit: bigint;
  readonly count_generation: bigint;
  readonly restitution_generation: bigint;
  readonly reconciliation_generation: bigint;
  readonly reason: string;
  readonly recorded_at: string;
  readonly state: DispatchReconciliationState;
  readonly decision: DispatchReconciliationDecision | null;
  readonly application: DispatchReconciliationApplication | null;
}
export interface DispatchReconciliationLine {
  readonly variant_id: number;
  readonly expected_quantity: bigint;
  readonly actual_quantity: bigint;
  readonly available_quantity: bigint;
  readonly effective_dispatch: bigint;
  readonly effective_actual: bigint;
  readonly effective_credit: bigint;
  readonly applied_retained_quantity: bigint;
  readonly workflow_revision: bigint;
  readonly applied_revision: bigint;
  readonly count_generation: bigint;
  readonly count_applied_revision: bigint;
  readonly restitution_generation: bigint;
  readonly reconciliation_generation: bigint;
  readonly proposals: readonly DispatchReconciliationProposal[];
}
export interface DispatchReconciliations {
  readonly request_id: bigint;
  readonly lines: readonly DispatchReconciliationLine[];
  readonly operations: readonly DispatchReconciliationOperation[];
}
const max = 9223372036854775807n;
function invalid(): never { throw new Error('Invalid dispatch reconciliation evidence'); }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const o = value as Record<string, unknown>;
  if (Object.keys(o).length !== keys.length || keys.some(k => !Object.hasOwn(o, k))) return invalid();
  return o;
}
function decimal(value: unknown, minimum = 0n): bigint {
  if (typeof value !== 'string' || value.length > 19 || !/^(0|[1-9][0-9]*)$/.test(value)) return invalid();
  const n = BigInt(value);
  if (n < minimum || n > max) return invalid();
  return n;
}
function delta(value: unknown): bigint {
  if (typeof value !== 'string' || value.length > 20 || !/^(0|-?[1-9][0-9]*)$/.test(value)) return invalid();
  const n = BigInt(value);
  if (n < -max - 1n || n > max) return invalid();
  return n;
}
function variant(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 2147483647) return invalid();
  return value;
}
function location(value: unknown): TransferLocationID {
  if (typeof value !== 'number') return invalid();
  return countActorLocation(value);
}
function key(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(value)) return invalid();
  return value;
}
function reason(value: unknown): string {
  if (typeof value !== 'string' || !value.isWellFormed() || value.includes('\0')) return invalid();
  const length = [...value.replace(/^ +| +$/g, '')].length;
  if (length < 1 || length > 2000) return invalid();
  return value;
}
function stamp(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{0,8}[1-9])?Z$/.test(value)) return invalid();
  const date = new Date(value.slice(0, 19) + 'Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19) !== value.slice(0, 19)) return invalid();
  return value;
}
function array<T>(value: unknown, parse: (v: unknown) => T): readonly T[] {
  if (!Array.isArray(value)) return invalid();
  return Object.freeze(value.map(parse));
}
// Existing codecs keep this token fence private. Match their duplicate-member
// semantics, including escaped equal-valued duplicates, without changing them.
function decode(raw: string): unknown {
  const stack: { kind: string; keys: Set<string>; expectingKey: boolean }[] = [];
  let i = 0;
  while (i < raw.length) {
    const c = raw[i];
    if (c === '"') {
      const start = i++;
      while (i < raw.length && raw[i] !== '"') i += raw[i] === '\\' ? 2 : 1;
      if (i >= raw.length) return invalid();
      const end = ++i; const frame = stack.at(-1);
      if (frame?.kind === '{' && frame.expectingKey) {
        let next = end;
        while (/^[ \t\r\n]$/.test(raw[next] ?? '')) next++;
        if (raw[next] === ':') {
          const name: unknown = JSON.parse(raw.slice(start, end));
          if (typeof name !== 'string' || frame.keys.has(name)) return invalid();
          frame.keys.add(name); frame.expectingKey = false;
        }
      }
      continue;
    }
    if (c === '{' || c === '[') stack.push({ kind: c, keys: new Set(), expectingKey: c === '{' });
    else if (c === '}' || c === ']') {
      const f = stack.pop();
      if (!f || f.kind !== (c === '}' ? '{' : '[')) return invalid();
    } else if (c === ',' && stack.at(-1)?.kind === '{') stack.at(-1)!.expectingKey = true;
    i++;
  }
  if (stack.length) return invalid();
  return parseJSON(raw, null, { parseNumber: token => {
    if (!/^[1-9][0-9]*$/.test(token)) return invalid();
    const n = Number(token);
    if (!Number.isSafeInteger(n)) return invalid();
    return n;
  }, onDuplicateKey: invalid });
}
function operation(value: unknown): DispatchReconciliationOperation {
  const o = object(value, ['operation_key', 'request_id', 'variant_id', 'actor_location_id', 'action', 'expected_revision',
    'dispatch_quantity', 'reason', 'revision', 'source_existing_before', 'source_existing_after', 'destination_existing_before', 'destination_existing_after', 'recorded_at']);
  const a = o.action;
  if (a !== 'propose' && a !== 'accept' && a !== 'reject') return invalid();
  const expected = decimal(o.expected_revision); const revision = decimal(o.revision, 1n);
  if (expected === max || revision !== (a === 'propose' ? expected + 1n : expected)) return invalid();
  if (a !== 'propose' && o.dispatch_quantity !== null) return invalid();
  const nullable = (v: unknown) => v === null ? null : decimal(v);
  const sb = nullable(o.source_existing_before), sa = nullable(o.source_existing_after);
  const db = nullable(o.destination_existing_before), da = nullable(o.destination_existing_after);
  if ([sb, sa, db, da].some(v => a === 'accept' ? v === null : v !== null)) return invalid();
  return Object.freeze({ operation_key: key(o.operation_key), request_id: decimal(o.request_id, 1n), variant_id: variant(o.variant_id),
    actor_location_id: location(o.actor_location_id), action: a, expected_revision: expected, revision,
    dispatch_quantity: a === 'propose' ? decimal(o.dispatch_quantity) : null, reason: reason(o.reason),
    source_existing_before: sb, source_existing_after: sa, destination_existing_before: db, destination_existing_after: da, recorded_at: stamp(o.recorded_at) });
}
function decision(value: unknown): DispatchReconciliationDecision {
  const o = object(value, ['operation_key', 'actor_location_id', 'accepted', 'reason', 'recorded_at']);
  if (typeof o.accepted !== 'boolean') return invalid();
  return Object.freeze({ operation_key: key(o.operation_key), actor_location_id: location(o.actor_location_id), accepted: o.accepted, reason: reason(o.reason), recorded_at: stamp(o.recorded_at) });
}
function application(value: unknown): DispatchReconciliationApplication {
  const o = object(value, ['operation_key', 'effective_dispatch', 'source_delta', 'destination_delta', 'recorded_at']);
  return Object.freeze({ operation_key: key(o.operation_key), effective_dispatch: decimal(o.effective_dispatch), source_delta: delta(o.source_delta), destination_delta: delta(o.destination_delta), recorded_at: stamp(o.recorded_at) });
}
function proposal(value: unknown): DispatchReconciliationProposal {
  const o = object(value, ['revision', 'operation_key', 'initiator_location_id', 'dispatch_quantity', 'base_dispatch', 'base_actual', 'base_credit',
    'count_generation', 'restitution_generation', 'reconciliation_generation', 'reason', 'recorded_at', 'state', 'decision', 'application']);
  const state = o.state;
  if (state !== 'pending' && state !== 'superseded' && state !== 'rejected' && state !== 'applied') return invalid();
  return Object.freeze({ revision: decimal(o.revision, 1n), operation_key: key(o.operation_key), initiator_location_id: location(o.initiator_location_id),
    dispatch_quantity: decimal(o.dispatch_quantity), base_dispatch: decimal(o.base_dispatch), base_actual: decimal(o.base_actual), base_credit: decimal(o.base_credit),
    count_generation: decimal(o.count_generation), restitution_generation: decimal(o.restitution_generation), reconciliation_generation: decimal(o.reconciliation_generation),
    reason: reason(o.reason), recorded_at: stamp(o.recorded_at), state, decision: o.decision === null ? null : decision(o.decision), application: o.application === null ? null : application(o.application) });
}
function line(value: unknown): DispatchReconciliationLine {
  const o = object(value, ['variant_id', 'expected_quantity', 'actual_quantity', 'available_quantity', 'effective_dispatch', 'effective_actual', 'effective_credit',
    'applied_retained_quantity', 'workflow_revision', 'applied_revision', 'count_generation', 'count_applied_revision', 'restitution_generation', 'reconciliation_generation', 'proposals']);
  return Object.freeze({ variant_id: variant(o.variant_id), expected_quantity: decimal(o.expected_quantity, 1n), actual_quantity: decimal(o.actual_quantity), available_quantity: decimal(o.available_quantity),
    effective_dispatch: decimal(o.effective_dispatch), effective_actual: decimal(o.effective_actual), effective_credit: decimal(o.effective_credit), applied_retained_quantity: decimal(o.applied_retained_quantity),
    workflow_revision: decimal(o.workflow_revision), applied_revision: decimal(o.applied_revision), count_generation: decimal(o.count_generation), count_applied_revision: decimal(o.count_applied_revision),
    restitution_generation: decimal(o.restitution_generation), reconciliation_generation: decimal(o.reconciliation_generation), proposals: array(o.proposals, proposal) });
}
function contextOperation(op: DispatchReconciliationOperation, record: TransferRecord): void {
  if (record.status !== 'received' || op.request_id !== decimal(record.id, 1n)
    || ![record.origin_location_id, record.destination_location_id].includes(op.actor_location_id)
    || !record.items.some(i => i.variant_id === op.variant_id)
    || !record.receipt.items.some(i => i.variant_id === op.variant_id && i.expected_quantity > 0n)) return invalid();
}
function history(s: DispatchReconciliations, record: TransferRecord): void {
  if (record.status !== 'received' || s.request_id !== decimal(record.id, 1n) || s.lines.length !== record.items.length) return invalid();
  const ops = new Map<string, DispatchReconciliationOperation>(); const used = new Set<string>();
  for (const op of s.operations) {
    contextOperation(op, record);
    if (ops.has(op.operation_key)) return invalid();
    ops.set(op.operation_key, op);
  }
  let previousVariant = 0;
  for (const l of s.lines) {
    const item = record.items.find(i => i.variant_id === l.variant_id);
    const receipt = record.receipt.items.find(i => i.variant_id === l.variant_id);
    if (!item || !receipt || l.variant_id <= previousVariant || l.expected_quantity !== item.quantity || l.expected_quantity !== receipt.expected_quantity
      || l.actual_quantity !== receipt.actual_quantity || l.available_quantity !== receipt.available_quantity
      || l.workflow_revision !== BigInt(l.proposals.length) || l.count_applied_revision > l.count_generation
      || l.effective_credit + l.applied_retained_quantity > l.effective_dispatch
      || l.effective_credit !== (l.effective_dispatch < l.effective_actual ? l.effective_dispatch : l.effective_actual)
      || l.count_applied_revision === 0n && l.effective_actual !== l.actual_quantity
      || l.applied_retained_quantity > 0n && l.restitution_generation < 2n) return invalid();
    previousVariant = l.variant_id;
    let dispatch = l.expected_quantity; let applied = 0n; let generation = 0n;
    // With an unchanged count generation, no hidden count operation can change
    // A/C between these pins. Capture a predecessor, never sum a partial ledger.
    let pinnedCount = 0n; let pinnedActual = l.actual_quantity; let pinnedCredit = l.available_quantity;
    let prior: DispatchReconciliationProposal | undefined;
    for (let i = 0; i < l.proposals.length; i++) {
      const p = l.proposals[i]; const op = ops.get(p.operation_key);
      if (!op || used.has(op.operation_key) || op.action !== 'propose' || op.variant_id !== l.variant_id || op.revision !== BigInt(i + 1)
        || p.revision !== op.revision || op.actor_location_id !== p.initiator_location_id || op.dispatch_quantity !== p.dispatch_quantity
        || op.reason !== p.reason || op.recorded_at !== p.recorded_at || p.base_dispatch !== dispatch || p.base_actual !== p.dispatch_quantity
        || p.dispatch_quantity === p.base_dispatch || p.base_credit !== (p.base_dispatch < p.base_actual ? p.base_dispatch : p.base_actual)
        || p.count_generation === pinnedCount && (p.base_actual !== pinnedActual || p.base_credit !== pinnedCredit)
        || p.reconciliation_generation !== generation || p.count_generation > l.count_generation || p.restitution_generation > l.restitution_generation
        || prior && (p.count_generation < prior.count_generation || p.restitution_generation < prior.restitution_generation
          || prior.decision === null && prior.initiator_location_id !== p.initiator_location_id)) return invalid();
      used.add(op.operation_key); generation++;
      pinnedCount = p.count_generation; pinnedActual = p.base_actual; pinnedCredit = p.base_credit;
      let state: DispatchReconciliationState = i === l.proposals.length - 1 ? 'pending' : 'superseded';
      if (p.decision) {
        const d = p.decision; const dop = ops.get(d.operation_key);
        if (!dop || used.has(d.operation_key) || dop.variant_id !== l.variant_id || dop.action !== (d.accepted ? 'accept' : 'reject')
          || dop.revision !== p.revision || dop.actor_location_id !== d.actor_location_id || d.actor_location_id === p.initiator_location_id
          || dop.reason !== d.reason || dop.recorded_at !== d.recorded_at) return invalid();
        used.add(d.operation_key); generation++;
        state = d.accepted ? 'applied' : 'rejected';
        if (d.accepted) {
          const a = p.application;
          if (!a || a.operation_key !== d.operation_key || a.recorded_at !== d.recorded_at || a.effective_dispatch !== p.dispatch_quantity
            || a.source_delta !== p.base_dispatch - p.dispatch_quantity || a.destination_delta !== p.dispatch_quantity - p.base_credit
            || dop.source_existing_after! - dop.source_existing_before! !== a.source_delta
            || dop.destination_existing_after! - dop.destination_existing_before! !== a.destination_delta) return invalid();
          dispatch = a.effective_dispatch; applied = p.revision; pinnedCredit = a.effective_dispatch;
        } else if (p.application !== null) return invalid();
      } else if (p.application !== null) return invalid();
      if (p.state !== state) return invalid();
      prior = p;
    }
    if (l.count_generation === pinnedCount && (l.effective_actual !== pinnedActual || l.effective_credit !== pinnedCredit)
      || l.effective_dispatch !== dispatch || l.applied_revision !== applied || l.reconciliation_generation !== generation
      || l.count_applied_revision === 0n && applied === 0n && l.effective_credit !== l.available_quantity) return invalid();
    // Count acceptance targets min(D,A); reconciliation sets D=C=A. That
    // current-state invariant holds without reconstructing either partial ledger.
    // Current credit spans multiple ledgers. Never sum this ledger to infer C,
    // or chain warehouse balances across unrelated inventory activity.
  }
  if (used.size !== ops.size) return invalid();
}
/** Standalone immutable result; current head/eligibility intentionally irrelevant. */
export function parseDispatchReconciliationOperation(raw: string, record: DispatchReconciliationContext): DispatchReconciliationOperation {
  try { const op = operation(decode(raw)); contextOperation(op, record); return op; } catch { return invalid(); }
}
/** Closed coordinated snapshot, deeply captured without changing raw/context. No permission is granted. */
export function parseDispatchReconciliations(raw: string, record: DispatchReconciliationContext): DispatchReconciliations {
  try {
    const o = object(decode(raw), ['request_id', 'lines', 'operations']);
    const s = Object.freeze({ request_id: decimal(o.request_id, 1n), lines: array(o.lines, line), operations: array(o.operations, operation) });
    history(s, record); return s;
  } catch { return invalid(); }
}
