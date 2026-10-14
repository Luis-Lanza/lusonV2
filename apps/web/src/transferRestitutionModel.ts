import { parse as parseJSON } from 'lossless-json';
import { transferDetailPath, type TransferLocationID } from './transferModel';

export type RestitutionAction = 'propose' | 'accept' | 'reject';
export type RestitutionState = 'pending' | 'superseded' | 'rejected' | 'applied';
export interface RestitutionDecisionInput {
  readonly variant_id: number;
  readonly operation_key: string;
  readonly expected_revision: string;
  readonly reason: string;
}
export interface RestitutionProposalInput extends RestitutionDecisionInput {
  readonly retained_quantity: string;
  readonly retained_at_origin: true;
}
export interface RestitutionNormalizedDecision {
  readonly variant_id: number;
  readonly operation_key: string;
  readonly expected_revision: bigint;
  readonly reason: string;
}
export interface RestitutionNormalizedProposal extends RestitutionNormalizedDecision {
  readonly retained_quantity: bigint;
  readonly retained_at_origin: true;
}
export interface RestitutionOperation {
  readonly operation_key: string;
  readonly request_id: bigint;
  readonly variant_id: number;
  readonly actor_location_id: TransferLocationID;
  readonly action: RestitutionAction;
  readonly expected_revision: bigint;
  readonly retained_quantity: bigint | null;
  readonly retained_at_origin: true | null;
  readonly reason: string;
  readonly revision: bigint;
  /** Persisted stock evidence, never current balances. */
  readonly source_existing_before: bigint | null;
  readonly source_existing_after: bigint | null;
  readonly recorded_at: string;
}
export interface RestitutionDecision {
  readonly operation_key: string;
  readonly actor_location_id: TransferLocationID;
  readonly accepted: boolean;
  readonly reason: string;
  readonly recorded_at: string;
}
export interface RestitutionApplication {
  readonly operation_key: string;
  readonly origin_location_id: TransferLocationID;
  readonly quantity: bigint;
  readonly recorded_at: string;
}
export interface RestitutionProposal {
  readonly revision: bigint;
  readonly operation_key: string;
  readonly initiator_location_id: TransferLocationID;
  readonly retained_quantity: bigint;
  readonly retained_at_origin: true;
  readonly base_revision: bigint;
  readonly count_generation: bigint;
  readonly count_applied_revision: bigint;
  readonly base_credit: bigint;
  readonly base_restitution: bigint;
  readonly reason: string;
  readonly recorded_at: string;
  readonly state: RestitutionState;
  readonly decision: RestitutionDecision | null;
  readonly application: RestitutionApplication | null;
}
export interface RestitutionLine {
  readonly variant_id: number;
  readonly expected_quantity: bigint;
  readonly original_credit: bigint;
  readonly workflow_revision: bigint;
  readonly applied_revision: bigint;
  /** Number of count operations, not the count proposal revision. */
  readonly count_generation: bigint;
  readonly count_applied_revision: bigint;
  readonly effective_credit: bigint;
  readonly applied_retained_quantity: bigint;
  readonly proposals: readonly RestitutionProposal[];
}
export interface Restitutions {
  readonly request_id: bigint;
  readonly lines: readonly RestitutionLine[];
  readonly operations: readonly RestitutionOperation[];
}
const maxInt64 = 9223372036854775807n;
function invalid(): never { throw new Error('Invalid restitution evidence'); }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const o = value as Record<string, unknown>;
  if (Object.keys(o).length !== keys.length || keys.some(k => !Object.hasOwn(o, k))) return invalid();
  return o;
}
function decimal(value: unknown, min = 0n, max = maxInt64): bigint {
  if (typeof value !== 'string' || value.length > 19 || !/^(0|[1-9][0-9]*)$/.test(value)) return invalid();
  const n = BigInt(value);
  if (n < min || n > max) return invalid();
  return n;
}
function integer(value: unknown, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) return invalid();
  return value;
}
function variant(value: unknown): number { return integer(value, 2147483647); }
function location(value: unknown): TransferLocationID { return integer(value, 3) as TransferLocationID; }
function key(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(value)) return invalid();
  return value;
}
function reason(value: unknown): string {
  if (typeof value !== 'string' || !value.isWellFormed() || value.includes('\0')) return invalid();
  const length = [...value.replace(/^ +| +$/g, '')].length;
  if (length < 1 || length > 2000) return invalid();
  return value; // Admission trims ASCII spaces only; identity preserves decoded text.
}
function stamp(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{0,8}[1-9])?Z$/.test(value)) return invalid();
  const date = new Date(value.slice(0, 19) + 'Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19) !== value.slice(0, 19)
    || value === '0001-01-01T00:00:00Z') return invalid();
  return value;
}
// RFC3339Nano trims fractional zeroes; pad only for ordering, not stored identity.
function chronological(value: string): string { return value.slice(0, 19) + (value.slice(19, -1).slice(1) || '').padEnd(9, '0'); }
function action(value: unknown): RestitutionAction {
  if (value !== 'propose' && value !== 'accept' && value !== 'reject') return invalid();
  return value;
}
function array<T>(value: unknown, parse: (item: unknown) => T): readonly T[] {
  if (!Array.isArray(value)) return invalid();
  return Object.freeze(value.map(parse));
}
// Local duplicate-token fence mirrors the private C4 decoder without changing it.
// Decoded member names matter: escaped equal-valued duplicates also fail closed.
function decode(raw: string): unknown {
  const stack: { kind: string; keys: Set<string>; expectingKey: boolean }[] = [];
  let index = 0;
  while (index < raw.length) {
    const char = raw[index];
    if (char === '"') {
      const start = index++;
      while (index < raw.length && raw[index] !== '"') index += raw[index] === '\\' ? 2 : 1;
      if (index >= raw.length) return invalid();
      const end = ++index;
      const frame = stack.at(-1);
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
    if (char === '{' || char === '[') stack.push({ kind: char, keys: new Set(), expectingKey: char === '{' });
    else if (char === '}' || char === ']') {
      const frame = stack.pop();
      if (!frame || frame.kind !== (char === '}' ? '{' : '[')) return invalid();
    } else if (char === ',' && stack.at(-1)?.kind === '{') stack.at(-1)!.expectingKey = true;
    index++;
  }
  if (stack.length) return invalid();
  return parseJSON(raw, null, { parseNumber: token => {
    if (!/^[1-9][0-9]*$/.test(token)) return invalid();
    const n = Number(token);
    if (!Number.isSafeInteger(n)) return invalid();
    return n;
  }, onDuplicateKey: invalid });
}
function operation(value: unknown): RestitutionOperation {
  const o = object(value, ['operation_key', 'request_id', 'variant_id', 'actor_location_id', 'action',
    'expected_revision', 'retained_quantity', 'retained_at_origin', 'reason', 'revision',
    'source_existing_before', 'source_existing_after', 'recorded_at']);
  const a = action(o.action);
  const expected = decimal(o.expected_revision, 0n, maxInt64 - 1n);
  const revision = decimal(o.revision, 1n);
  if (revision !== (a === 'propose' ? expected + 1n : expected)) return invalid();
  if (a === 'propose' ? o.retained_at_origin !== true : o.retained_quantity !== null || o.retained_at_origin !== null) return invalid();
  const before = o.source_existing_before === null ? null : decimal(o.source_existing_before);
  const after = o.source_existing_after === null ? null : decimal(o.source_existing_after);
  if (a === 'accept' ? before === null || after === null || after <= before : before !== null || after !== null) return invalid();
  return Object.freeze({ operation_key: key(o.operation_key), request_id: decimal(o.request_id, 1n),
    variant_id: variant(o.variant_id), actor_location_id: location(o.actor_location_id), action: a,
    expected_revision: expected, retained_quantity: a === 'propose' ? decimal(o.retained_quantity, 1n) : null,
    retained_at_origin: a === 'propose' ? true : null, reason: reason(o.reason), revision,
    source_existing_before: before, source_existing_after: after, recorded_at: stamp(o.recorded_at) });
}
function decision(value: unknown): RestitutionDecision {
  const o = object(value, ['operation_key', 'actor_location_id', 'accepted', 'reason', 'recorded_at']);
  if (typeof o.accepted !== 'boolean') return invalid();
  return Object.freeze({ operation_key: key(o.operation_key), actor_location_id: location(o.actor_location_id),
    accepted: o.accepted, reason: reason(o.reason), recorded_at: stamp(o.recorded_at) });
}
function application(value: unknown): RestitutionApplication {
  const o = object(value, ['operation_key', 'origin_location_id', 'quantity', 'recorded_at']);
  return Object.freeze({ operation_key: key(o.operation_key), origin_location_id: location(o.origin_location_id),
    quantity: decimal(o.quantity, 1n), recorded_at: stamp(o.recorded_at) });
}
function proposal(value: unknown): RestitutionProposal {
  const o = object(value, ['revision', 'operation_key', 'initiator_location_id', 'retained_quantity', 'retained_at_origin',
    'base_revision', 'count_generation', 'count_applied_revision', 'base_credit', 'base_restitution',
    'reason', 'recorded_at', 'state', 'decision', 'application']);
  const state = o.state;
  if (!['pending', 'superseded', 'rejected', 'applied'].includes(state as string) || o.retained_at_origin !== true) return invalid();
  return Object.freeze({ revision: decimal(o.revision, 1n), operation_key: key(o.operation_key),
    initiator_location_id: location(o.initiator_location_id), retained_quantity: decimal(o.retained_quantity, 1n), retained_at_origin: true,
    base_revision: decimal(o.base_revision), count_generation: decimal(o.count_generation), count_applied_revision: decimal(o.count_applied_revision),
    base_credit: decimal(o.base_credit), base_restitution: decimal(o.base_restitution), reason: reason(o.reason),
    recorded_at: stamp(o.recorded_at), state: state as RestitutionState,
    decision: o.decision === null ? null : decision(o.decision), application: o.application === null ? null : application(o.application) });
}
function line(value: unknown): RestitutionLine {
  const o = object(value, ['variant_id', 'expected_quantity', 'original_credit', 'workflow_revision', 'applied_revision',
    'count_generation', 'count_applied_revision', 'effective_credit', 'applied_retained_quantity', 'proposals']);
  return Object.freeze({ variant_id: variant(o.variant_id), expected_quantity: decimal(o.expected_quantity, 1n),
    original_credit: decimal(o.original_credit), workflow_revision: decimal(o.workflow_revision), applied_revision: decimal(o.applied_revision),
    count_generation: decimal(o.count_generation), count_applied_revision: decimal(o.count_applied_revision), effective_credit: decimal(o.effective_credit),
    applied_retained_quantity: decimal(o.applied_retained_quantity), proposals: array(o.proposals, proposal) });
}
function history(snapshot: Restitutions): void {
  if (!snapshot.lines.length) return invalid();
  const ops = new Map<string, RestitutionOperation>();
  const used = new Set<string>();
  // The GET DTO omits the header participants. Infer only observed role evidence,
  // requiring consistency across every line, without inventing missing actors.
  let origin: TransferLocationID | null = null;
  let destination: TransferLocationID | null = null;
  function participant(actor: TransferLocationID, source: boolean): void {
    const previous = source ? origin : destination;
    if (previous !== null && previous !== actor) return invalid();
    if (source) origin = actor; else destination = actor;
    if (origin !== null && origin === destination) return invalid();
  }
  for (const op of snapshot.operations) {
    if (op.request_id !== snapshot.request_id || ops.has(op.operation_key)) return invalid();
    participant(op.actor_location_id, op.action === 'propose');
    ops.set(op.operation_key, op);
  }
  let previousVariant = 0;
  for (const l of snapshot.lines) {
    if (l.variant_id <= previousVariant || l.original_credit > l.expected_quantity || l.effective_credit > l.expected_quantity
      || l.count_applied_revision > l.count_generation || l.workflow_revision !== BigInt(l.proposals.length)
      || l.applied_retained_quantity > l.expected_quantity - l.effective_credit
      || l.count_applied_revision === 0n && l.effective_credit !== l.original_credit) return invalid();
    previousVariant = l.variant_id;
    let applied = 0n;
    let quantity = 0n;
    for (let j = 0; j < l.proposals.length; j++) {
      const p = l.proposals[j];
      if (applied !== 0n) return invalid();
      const previous = l.proposals[j - 1];
      if (previous && (p.count_generation < previous.count_generation || p.count_applied_revision < previous.count_applied_revision
        || chronological(p.recorded_at) < chronological(previous.recorded_at))) return invalid();
      const op = ops.get(p.operation_key);
      if (!op || used.has(p.operation_key) || op.action !== 'propose' || op.variant_id !== l.variant_id
        || p.revision !== BigInt(j + 1) || op.revision !== p.revision || p.base_revision !== p.revision - 1n
        || p.retained_quantity !== op.retained_quantity || p.reason !== op.reason || p.recorded_at !== op.recorded_at
        || p.count_generation > l.count_generation || p.count_applied_revision > p.count_generation
        || p.count_applied_revision > l.count_applied_revision || p.base_credit > l.expected_quantity
        || p.base_restitution !== 0n || p.retained_quantity > l.expected_quantity - p.base_credit) return invalid();
      participant(p.initiator_location_id, true);
      used.add(p.operation_key);
      let state: RestitutionState = p.revision === l.workflow_revision ? 'pending' : 'superseded';
      if (p.decision !== null) {
        const d = p.decision;
        const decisionOp = ops.get(d.operation_key);
        state = d.accepted ? 'applied' : 'rejected';
        if (!decisionOp || used.has(d.operation_key) || decisionOp.action !== (d.accepted ? 'accept' : 'reject')
          || decisionOp.variant_id !== l.variant_id || decisionOp.revision !== p.revision
          || decisionOp.reason !== d.reason || decisionOp.recorded_at !== d.recorded_at
          || chronological(d.recorded_at) < chronological(p.recorded_at)) return invalid();
        participant(d.actor_location_id, false);
        used.add(d.operation_key);
        if (d.accepted) {
          const a = p.application;
          if (a === null || a.operation_key !== d.operation_key || a.quantity !== p.retained_quantity
            || a.recorded_at !== d.recorded_at || decisionOp.source_existing_after! - decisionOp.source_existing_before! !== a.quantity) return invalid();
          participant(a.origin_location_id, true);
          applied = p.revision; quantity = a.quantity;
        } else if (p.application !== null) return invalid();
      } else if (p.application !== null) return invalid();
      if (p.state !== state) return invalid();
    }
    if (applied !== l.applied_revision || quantity !== l.applied_retained_quantity) return invalid();
  }
  if (used.size !== ops.size) return invalid();
}
export function parseRestitutionError(raw: string): string {
  const o = object(decode(raw), ['error']);
  if (typeof o.error !== 'string') return invalid();
  return o.error;
}
export function parseRestitutionOperation(raw: string): RestitutionOperation { return operation(decode(raw)); }
export function parseRestitutions(raw: string): Restitutions {
  const o = object(decode(raw), ['request_id', 'lines', 'operations']);
  const snapshot = Object.freeze({ request_id: decimal(o.request_id, 1n), lines: array(o.lines, line), operations: array(o.operations, operation) });
  history(snapshot);
  return snapshot;
}
function normalized(value: unknown, propose: boolean): RestitutionNormalizedDecision | RestitutionNormalizedProposal {
  const o = object(value, ['variant_id', 'operation_key', 'expected_revision', 'reason', ...(propose ? ['retained_quantity', 'retained_at_origin'] : [])]);
  const common = { variant_id: variant(o.variant_id), operation_key: key(o.operation_key),
    expected_revision: decimal(o.expected_revision, 0n, maxInt64 - 1n), reason: reason(o.reason) };
  if (propose && o.retained_at_origin !== true) return invalid();
  return Object.freeze(propose ? { ...common, retained_quantity: decimal(o.retained_quantity, 1n), retained_at_origin: true as const } : common);
}
export function normalizeRestitutionProposal(input: RestitutionProposalInput): RestitutionNormalizedProposal {
  return normalized(input, true) as RestitutionNormalizedProposal;
}
export function normalizeRestitutionDecision(input: RestitutionDecisionInput): RestitutionNormalizedDecision { return normalized(input, false); }
export function restitutionsPath(id: string): string { return transferDetailPath(id) + '/restitutions'; }
export function restitutionActorLocation(value: number): TransferLocationID { return location(value); }
export function matchesRestitutionOperation(op: RestitutionOperation, requestID: bigint, actor: TransferLocationID,
  requestedAction: RestitutionAction, input: RestitutionNormalizedDecision | RestitutionNormalizedProposal): boolean {
  return op.request_id === requestID && op.actor_location_id === actor && op.action === requestedAction
    && op.variant_id === input.variant_id && op.operation_key === input.operation_key
    && op.expected_revision === input.expected_revision && op.reason === input.reason
    && op.retained_quantity === ('retained_quantity' in input ? input.retained_quantity : null)
    && op.retained_at_origin === ('retained_at_origin' in input ? input.retained_at_origin : null);
}
// Revalidate and deeply capture already-decoded evidence for future owner recovery.
function wire(value: unknown): string { return JSON.stringify(value, (_key, v: unknown) => typeof v === 'bigint' ? v.toString() : v); }
export function captureRestitutionOperation(value: unknown): RestitutionOperation { return parseRestitutionOperation(wire(value)); }
export function captureRestitutions(value: unknown): Restitutions { return parseRestitutions(wire(value)); }
