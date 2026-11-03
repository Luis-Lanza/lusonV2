import { parse as parseJSON } from 'lossless-json';
import { countActorLocation, parseCountCorrections } from './transferCountCorrectionModel';
import { parseRestitutions } from './transferRestitutionModel';
import { parseDispatchReconciliations } from './transferDispatchReconciliationModel';
import type { TransferRecord } from './transferModel';

const max = 9223372036854775807n;
function invalid(): never { throw new Error('Invalid unified reconciliation evidence'); }
function object(v: unknown, keys: string[]): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return invalid();
  const o = v as Record<string, unknown>;
  if (Object.keys(o).length !== keys.length || keys.some(k => !Object.hasOwn(o, k))) return invalid();
  return o;
}
function decimal(v: unknown, minimum = 0n): bigint {
  if (typeof v !== 'string' || !/^(0|[1-9][0-9]*)$/.test(v) || v.length > 19) return invalid();
  const n = BigInt(v); if (n < minimum || n > max) return invalid(); return n;
}
function delta(v: unknown): bigint {
  if (typeof v !== 'string' || !/^(0|-?[1-9][0-9]*)$/.test(v) || v.length > 20) return invalid();
  const n = BigInt(v); if (n < -max - 1n || n > max) return invalid(); return n;
}
function variant(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 2147483647) return invalid(); return v;
}
function location(v: unknown) { if (typeof v !== 'number') return invalid(); return countActorLocation(v); }
function key(v: unknown): string { if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(v)) return invalid(); return v; }
function reason(v: unknown): string {
  if (typeof v !== 'string' || !v.isWellFormed() || v.includes('\0')) return invalid();
  const n = [...v.replace(/^ +| +$/g, '')].length; if (n < 1 || n > 2000) return invalid(); return v;
}
function bool(v: unknown): boolean { if (typeof v !== 'boolean') return invalid(); return v; }
function stamp(v: unknown): string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{0,8}[1-9])?Z$/.test(v)) return invalid();
  const d = new Date(v.slice(0, 19) + 'Z');
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 19) !== v.slice(0, 19) || v === '0001-01-01T00:00:00Z') return invalid(); return v;
}
function array<T>(v: unknown, parse: (v: unknown) => T): readonly T[] {
  if (!Array.isArray(v)) return invalid(); return Object.freeze(v.map(parse));
}
const nullable = <T>(parse: (v: unknown) => T) => (v: unknown): T | null => v === null ? null : parse(v);
const quantity = (v: unknown) => decimal(v);
const positive = (v: unknown) => decimal(v, 1n);
function choice<const T extends string>(...values: T[]) { return (v: unknown): T => {
  if (!values.includes(v as T)) return invalid(); return v as T;
}; }
type Parsers = Record<string, (v: unknown) => unknown>;
function shape<P extends Parsers>(parsers: P) {
  return (v: unknown): Readonly<{ [K in keyof P]: ReturnType<P[K]> }> => {
    const o = object(v, Object.keys(parsers));
    return Object.freeze(Object.fromEntries(Object.entries(parsers).map(([k, p]) => [k, p(o[k])]))) as Readonly<{ [K in keyof P]: ReturnType<P[K]> }>;
  };
}
// The legacy decoders' token fence is private. Preserve their duplicate-member
// semantics locally, including escaped names and equal-valued duplicates.
function decode(raw: string): unknown {
  const stack: { kind: string; keys: Set<string>; expectingKey: boolean }[] = [];
  let i = 0;
  while (i < raw.length) {
    const c = raw[i];
    if (c === '"') {
      const start = i++;
      while (i < raw.length && raw[i] !== '"') i += raw[i] === '\\' ? 2 : 1;
      if (i >= raw.length) return invalid();
      const end = ++i, frame = stack.at(-1);
      if (frame?.kind === '{' && frame.expectingKey) {
        let next = end; while (/^[ \t\r\n]$/.test(raw[next] ?? '')) next++;
        if (raw[next] === ':') {
          const name: unknown = JSON.parse(raw.slice(start, end));
          if (typeof name !== 'string' || frame.keys.has(name)) return invalid();
          frame.keys.add(name); frame.expectingKey = false;
        }
      }
      continue;
    }
    if (c === '{' || c === '[') stack.push({ kind: c, keys: new Set(), expectingKey: c === '{' });
    else if (c === '}' || c === ']') { if (stack.pop()?.kind !== (c === '}' ? '{' : '[')) return invalid(); }
    else if (c === ',' && stack.at(-1)?.kind === '{') stack.at(-1)!.expectingKey = true;
    i++;
  }
  if (stack.length) return invalid();
  return parseJSON(raw, null, { parseNumber: token => {
    if (!/^[1-9][0-9]*$/.test(token)) return invalid();
    const n = Number(token); if (!Number.isSafeInteger(n)) return invalid(); return n;
  }, onDuplicateKey: invalid });
}
const generations = shape({ count: quantity, restitution: quantity, dispatch: quantity, unified: quantity });
const original = shape({ variant_id: variant, expected_quantity: quantity, actual_quantity: quantity, available_quantity: quantity });
const operation = shape({ operation_key: key, request_id: positive, variant_id: variant, actor_location_id: location,
  action: choice('propose', 'accept', 'reject'), expected_revision: quantity,
  dispatch_quantity: nullable(quantity), arrival_quantity: nullable(quantity), retained_quantity: nullable(quantity),
  retained_at_origin: bool, reason, revision: positive, source_existing_before: nullable(quantity), source_existing_after: nullable(quantity),
  destination_existing_before: nullable(quantity), destination_existing_after: nullable(quantity), recorded_at: stamp });
const decision = shape({ operation_key: key, actor_location_id: location, accepted: bool, retained_at_origin: bool, reason, recorded_at: stamp });
const application = shape({ operation_key: key, source_delta: delta, destination_delta: delta });
const proposal = shape({ revision: positive, operation_key: key, initiator_location_id: location,
  dispatch_quantity: quantity, arrival_quantity: quantity, retained_quantity: quantity, retained_at_origin: bool,
  base_source_debit: quantity, base_destination_credit: quantity, count_generation: quantity, restitution_generation: quantity,
  reconciliation_generation: quantity, unified_generation: quantity, reason, recorded_at: stamp,
  state: choice('pending', 'superseded', 'rejected', 'applied'), decision: nullable(decision), application: nullable(application) });
const line = shape({ variant_id: variant, expected_quantity: positive, actual_quantity: quantity, available_quantity: quantity,
  workflow_revision: quantity, applied_revision: quantity, unified_generation: quantity, proposals: (v: unknown) => array(v, proposal) });
const current = shape({ variant_id: variant, owner: choice('legacy', 'unified'), source: choice('legacy', 'unified'),
  application_operation_key: nullable(key), applied_revision: quantity, version: generations,
  effective_dispatch: quantity, effective_actual: quantity, effective_credit: quantity, source_debit: quantity,
  retained_quantity: nullable(quantity), origin_unknown: nullable(quantity), transit_unknown: nullable(quantity), excess: nullable(quantity) });
export type UnifiedReconciliationAction = 'propose' | 'accept' | 'reject';
export interface UnifiedReconciliationDecisionInput {
  readonly variant_id: number; readonly operation_key: string; readonly expected_revision: string;
  readonly retained_at_origin: boolean; readonly reason: string;
}
export interface UnifiedReconciliationProposalInput extends UnifiedReconciliationDecisionInput {
  readonly dispatch_quantity: string; readonly arrival_quantity: string; readonly retained_quantity: string;
}
const decisionIntent = shape({ variant_id: variant, operation_key: key, expected_revision: quantity, retained_at_origin: bool, reason });
const proposalIntent = shape({ variant_id: variant, operation_key: key, expected_revision: quantity, retained_at_origin: bool, reason,
  dispatch_quantity: quantity, arrival_quantity: quantity, retained_quantity: quantity });
export function normalizeUnifiedReconciliationIntent(input: UnifiedReconciliationDecisionInput | UnifiedReconciliationProposalInput, propose: boolean): ReturnType<typeof decisionIntent> | ReturnType<typeof proposalIntent> {
  const normalized = propose ? proposalIntent(input) : decisionIntent(input);
  if (normalized.expected_revision === max) return invalid();
  return normalized;
}
/** Closed versioned result, independently bound to immutable receipt evidence. */
export function parseUnifiedReconciliationOperation(raw: string, record: TransferRecord): UnifiedReconciliationOperation {
  try {
    const envelope = object(decode(raw), ['schema', 'operation']);
    if (envelope.schema !== 'luson.transfer-reconciliation-operation/v2' || record.status !== 'received') return invalid();
    const op = operation(envelope.operation);
    const receipt = record.receipt.items.find(i => i.variant_id === op.variant_id && i.expected_quantity > 0n);
    if (!receipt || !record.items.some(i => i.variant_id === op.variant_id) || op.request_id !== BigInt(record.id)
      || ![record.origin_location_id, record.destination_location_id].includes(op.actor_location_id)
      || op.expected_revision === max || op.revision !== (op.action === 'propose' ? op.expected_revision + 1n : op.expected_revision)
      || op.action !== 'propose' && op.expected_revision === 0n
      || op.retained_at_origin && (op.actor_location_id !== record.origin_location_id || op.action === 'reject')
      || [op.dispatch_quantity, op.arrival_quantity, op.retained_quantity].some(v => op.action === 'propose' ? v === null : v !== null)
      || [op.source_existing_before, op.source_existing_after, op.destination_existing_before, op.destination_existing_after].some(v => op.action === 'accept' ? v === null : v !== null)
      || op.action === 'propose' && (op.retained_quantity! > positivePart(receipt.expected_quantity - op.dispatch_quantity!)
        || op.retained_quantity! > 0n && op.actor_location_id === record.origin_location_id && !op.retained_at_origin)) return invalid();
    return op;
  } catch { return invalid(); }
}
export type UnifiedReconciliationProposal = ReturnType<typeof proposal>;
export type UnifiedReconciliationOperation = ReturnType<typeof operation>;
export type UnifiedReconciliations = ReturnType<typeof snapshot>;
function snapshot(raw: string, record: TransferRecord) {
  const o = object(decode(raw), ['schema', 'request_id', 'origin_location_id', 'destination_location_id', 'received_at', 'original', 'legacy', 'current', 'lines', 'operations']);
  if (o.schema !== 'luson.transfer-reconciliation/v2' || record.status !== 'received') return invalid();
  const legacy = object(o.legacy, ['count', 'restitution', 'dispatch']);
  const s = Object.freeze({ schema: o.schema, request_id: positive(o.request_id), origin_location_id: location(o.origin_location_id),
    destination_location_id: location(o.destination_location_id), received_at: stamp(o.received_at), original: array(o.original, original),
    legacy: Object.freeze({ count: parseCountCorrections(JSON.stringify(legacy.count)), restitution: parseRestitutions(JSON.stringify(legacy.restitution)),
      dispatch: parseDispatchReconciliations(JSON.stringify(legacy.dispatch), record) }),
    current: array(o.current, current), lines: array(o.lines, line), operations: array(o.operations, operation) });
  validate(s, record); return s;
}
const min = (a: bigint, b: bigint) => a < b ? a : b;
const positivePart = (n: bigint) => n > 0n ? n : 0n;
const chronological = (v: string) => v.slice(0, 19) + (v.slice(19, -1).slice(1) || '').padEnd(9, '0');
function validate(s: UnifiedReconciliations, record: TransferRecord): void {
  if (record.status !== 'received' || s.request_id !== BigInt(record.id) || s.origin_location_id !== record.origin_location_id
    || s.destination_location_id !== record.destination_location_id || s.received_at !== record.received_at
    || s.original.length !== record.receipt.items.length || s.current.length !== s.original.length || s.lines.length !== record.items.length) return invalid();
  const endpoints = [s.origin_location_id, s.destination_location_id];
  for (const ledger of [s.legacy.count, s.legacy.restitution, s.legacy.dispatch]) {
    // Operation identities belong to their ledger, not a synthetic global keyspace.
    const ledgerKeys = new Set<string>();
    if (ledger.request_id !== s.request_id) return invalid();
    for (const op of ledger.operations) {
      if (ledgerKeys.has(op.operation_key) || !endpoints.includes(op.actor_location_id)) return invalid();
      ledgerKeys.add(op.operation_key);
    }
  }
  // Count's public parser is structural; bind its immutable history here to the
  // original receipt and operation identities before using its accounting.
  const countOps = new Map(s.legacy.count.operations.map(op => [op.operation_key, op]));
  const countUsed = new Set<string>();
  let countPrevious = 0;
  for (const l of s.legacy.count.lines) {
    if (l.variant_id <= countPrevious || l.workflow_revision !== BigInt(l.proposals.length)) return invalid();
    countPrevious = l.variant_id; let applied = 0n;
    for (let i = 0; i < l.proposals.length; i++) {
      const p = l.proposals[i], op = countOps.get(p.operation_key);
      if (!op || countUsed.has(op.operation_key) || op.action !== 'propose' || op.variant_id !== l.variant_id
        || op.revision !== BigInt(i + 1) || p.revision !== op.revision || p.base_revision !== applied
        || op.actual_quantity !== p.actual_quantity || op.actor_location_id !== p.initiator_location_id
        || op.reason !== p.reason || op.recorded_at !== p.recorded_at) return invalid();
      countUsed.add(op.operation_key);
      let state = i === l.proposals.length - 1 ? 'pending' : 'superseded';
      if (p.decision) {
        const d = p.decision, dop = countOps.get(d.operation_key);
        if (!dop || countUsed.has(dop.operation_key) || dop.action !== (d.accepted ? 'accept' : 'reject')
          || dop.variant_id !== l.variant_id || dop.revision !== p.revision || dop.actor_location_id !== d.actor_location_id
          || d.actor_location_id === p.initiator_location_id || dop.reason !== d.reason || dop.recorded_at !== d.recorded_at) return invalid();
        countUsed.add(dop.operation_key); state = d.accepted ? 'applied' : 'rejected';
        if (d.accepted) {
          if (!p.application || p.application.recorded_at !== d.recorded_at || p.application.delta !== p.application.effective_credit - p.base_credit) return invalid();
          applied = p.revision;
        }
      }
      if (p.state !== state) return invalid();
    }
    if (applied !== l.applied_revision) return invalid();
  }
  if (countUsed.size !== countOps.size) return invalid();
  const ops = new Map<string, UnifiedReconciliationOperation>(); const used = new Set<string>();
  for (const op of s.operations) {
    if (ops.has(op.operation_key) || op.request_id !== s.request_id || !endpoints.includes(op.actor_location_id)
      || !s.lines.some(l => l.variant_id === op.variant_id) || op.expected_revision === max
      || op.revision !== (op.action === 'propose' ? op.expected_revision + 1n : op.expected_revision)
      || [op.dispatch_quantity, op.arrival_quantity, op.retained_quantity].some(v => op.action === 'propose' ? v === null : v !== null)
      || [op.source_existing_before, op.source_existing_after, op.destination_existing_before, op.destination_existing_after].some(v => op.action === 'accept' ? v === null : v !== null)
      || op.retained_at_origin && op.actor_location_id !== s.origin_location_id) return invalid();
    ops.set(op.operation_key, op);
  }
  let previous = 0;
  for (let index = 0; index < s.original.length; index++) {
    const o = s.original[index], c = s.current[index];
    const receipt = record.receipt.items.find(r => r.variant_id === o.variant_id);
    if (!receipt || o.variant_id <= previous || c.variant_id !== o.variant_id || o.expected_quantity !== receipt.expected_quantity
      || o.actual_quantity !== receipt.actual_quantity || o.available_quantity !== receipt.available_quantity) return invalid();
    previous = o.variant_id;
    const count = s.legacy.count.lines.find(l => l.variant_id === o.variant_id);
    const rest = s.legacy.restitution.lines.find(l => l.variant_id === o.variant_id);
    const dispatch = s.legacy.dispatch.lines.find(l => l.variant_id === o.variant_id);
    if (!count || count.expected_quantity !== o.expected_quantity || count.actual_quantity !== o.actual_quantity || count.available_quantity !== o.available_quantity) return invalid();
    const countGeneration = BigInt(s.legacy.count.operations.filter(op => op.variant_id === o.variant_id).length);
    const restGeneration = BigInt(s.legacy.restitution.operations.filter(op => op.variant_id === o.variant_id).length);
    const dispatchGeneration = BigInt(s.legacy.dispatch.operations.filter(op => op.variant_id === o.variant_id).length);
    if (c.version.count !== countGeneration || c.version.restitution !== restGeneration || c.version.dispatch !== dispatchGeneration) return invalid();
    let sourceDebit = o.expected_quantity, credit = o.available_quantity;
    for (const p of rest?.proposals ?? []) if (p.application) sourceDebit -= p.application.quantity;
    for (const p of dispatch?.proposals ?? []) if (p.application) { sourceDebit -= p.application.source_delta; credit += p.application.destination_delta; }
    for (const p of count.proposals) if (p.application) credit += p.application.delta;
    if (o.expected_quantity > 0n && (!rest || !dispatch || rest.expected_quantity !== o.expected_quantity || rest.original_credit !== o.available_quantity
      || rest.effective_dispatch !== count.effective_dispatch || dispatch.effective_dispatch !== count.effective_dispatch
      || rest.effective_credit !== count.effective_credit || dispatch.effective_credit !== count.effective_credit
      || dispatch.effective_actual !== count.effective_actual || rest.applied_retained_quantity !== dispatch.applied_retained_quantity
      || rest.count_generation !== countGeneration || dispatch.count_generation !== countGeneration
      || dispatch.restitution_generation !== restGeneration || dispatch.reconciliation_generation !== dispatchGeneration)) return invalid();
    if (credit !== count.effective_credit) return invalid();
    const l = s.lines.find(l => l.variant_id === o.variant_id);
    if (o.expected_quantity === 0n ? l !== undefined || rest !== undefined || dispatch !== undefined : !l) return invalid();
    let generation = 0n, applied = 0n;
    let lastApplied: UnifiedReconciliationProposal | undefined;
    let prior: UnifiedReconciliationProposal | undefined;
    for (let i = 0; i < (l?.proposals.length ?? 0); i++) {
      const p = l!.proposals[i], op = ops.get(p.operation_key);
      const d = p.dispatch_quantity, a = p.arrival_quantity, r = p.retained_quantity;
      if (!op || used.has(op.operation_key) || op.action !== 'propose' || op.variant_id !== o.variant_id || op.revision !== BigInt(i + 1)
        || p.revision !== op.revision || op.actor_location_id !== p.initiator_location_id || op.dispatch_quantity !== d
        || op.arrival_quantity !== a || op.retained_quantity !== r || op.retained_at_origin !== p.retained_at_origin
        || op.reason !== p.reason || op.recorded_at !== p.recorded_at || p.unified_generation !== generation
        || p.count_generation > countGeneration || p.restitution_generation > restGeneration || p.reconciliation_generation > dispatchGeneration
        || p.base_source_debit !== sourceDebit || p.base_destination_credit !== credit || r > positivePart(o.expected_quantity - d)
        || p.retained_at_origin && p.initiator_location_id !== s.origin_location_id
        || r > 0n && p.initiator_location_id === s.origin_location_id && !p.retained_at_origin
        || prior && (p.count_generation < prior.count_generation || p.restitution_generation < prior.restitution_generation
          || p.reconciliation_generation < prior.reconciliation_generation || prior.decision === null && prior.initiator_location_id !== p.initiator_location_id)) return invalid();
      used.add(op.operation_key); generation++;
      let state = i === l!.proposals.length - 1 ? 'pending' : 'superseded';
      if (p.decision) {
        const dec = p.decision, dop = ops.get(dec.operation_key);
        if (!dop || used.has(dop.operation_key) || dop.action !== (dec.accepted ? 'accept' : 'reject') || dop.variant_id !== o.variant_id
          || dop.revision !== p.revision || dop.actor_location_id !== dec.actor_location_id || dec.actor_location_id === p.initiator_location_id
          || dop.retained_at_origin !== dec.retained_at_origin || dop.reason !== dec.reason || dop.recorded_at !== dec.recorded_at
          || chronological(dec.recorded_at) < chronological(p.recorded_at)
          || dec.retained_at_origin && (!dec.accepted || dec.actor_location_id !== s.origin_location_id)) return invalid();
        used.add(dop.operation_key); generation++; state = dec.accepted ? 'applied' : 'rejected';
        if (dec.accepted) {
          const app = p.application, targetDebit = (o.expected_quantity > d ? o.expected_quantity : d) - r, targetCredit = min(d, a);
          if (r > 0n && !(p.initiator_location_id === s.origin_location_id && p.retained_at_origin
            || dec.actor_location_id === s.origin_location_id && dec.retained_at_origin)
            || !app || app.operation_key !== dec.operation_key || app.source_delta !== sourceDebit - targetDebit
            || app.destination_delta !== targetCredit - credit || dop.source_existing_after! - dop.source_existing_before! !== app.source_delta
            || dop.destination_existing_after! - dop.destination_existing_before! !== app.destination_delta) return invalid();
          sourceDebit = targetDebit; credit = targetCredit; applied = p.revision; lastApplied = p;
        } else if (p.application !== null) return invalid();
      } else if (p.application !== null) return invalid();
      if (p.state !== state) return invalid(); prior = p;
    }
    if (l && (l.expected_quantity !== o.expected_quantity || l.actual_quantity !== o.actual_quantity || l.available_quantity !== o.available_quantity
      || l.workflow_revision !== BigInt(l.proposals.length) || l.applied_revision !== applied || l.unified_generation !== generation)) return invalid();
    if (c.owner !== (l?.proposals.length ? 'unified' : 'legacy') || c.source !== (lastApplied ? 'unified' : 'legacy')
      || c.version.unified !== generation || c.applied_revision !== applied || c.application_operation_key !== (lastApplied?.application?.operation_key ?? null)
      || c.source_debit !== sourceDebit || c.effective_credit !== credit || sourceDebit < 0n || sourceDebit > max || credit < 0n || credit > max) return invalid();
    if (lastApplied) {
      const p = lastApplied, d = p.dispatch_quantity, a = p.arrival_quantity, r = p.retained_quantity;
      if (c.effective_dispatch !== d || c.effective_actual !== a || c.retained_quantity !== r
        || c.origin_unknown !== positivePart(o.expected_quantity - d) - r || c.transit_unknown !== positivePart(d - a) || c.excess !== positivePart(a - d)) return invalid();
    } else if (c.effective_dispatch !== count.effective_dispatch || c.effective_actual !== count.effective_actual
      || [c.retained_quantity, c.origin_unknown, c.transit_unknown, c.excess].some(v => v !== null)) return invalid();
  }
  if (used.size !== ops.size || new Set(s.lines.map(l => l.variant_id)).size !== s.lines.length
    || s.lines.some((l, i) => i > 0 && l.variant_id <= s.lines[i - 1].variant_id)
    || s.legacy.count.lines.length !== s.original.length || s.legacy.restitution.lines.length !== s.lines.length) return invalid();
}
/** Strict, deeply captured audit and authoritative current state; grants no capability. */
export function parseUnifiedReconciliations(raw: string, record: TransferRecord): UnifiedReconciliations {
  try { return snapshot(raw, record); } catch { return invalid(); }
}
