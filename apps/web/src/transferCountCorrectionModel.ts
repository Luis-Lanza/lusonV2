import { parse as parseJSON } from 'lossless-json';
import { transferDetailPath, type TransferLocationID } from './transferModel';

export type CountAction = 'propose' | 'accept' | 'reject';
export type CountProposalState = 'pending' | 'superseded' | 'rejected' | 'applied';
export interface CountDecisionInput {
  readonly variant_id: number;
  readonly operation_key: string;
  readonly expected_revision: string;
  readonly reason: string;
}
export interface CountProposalInput extends CountDecisionInput { readonly actual_quantity: string }
export interface CountNormalizedDecision {
  readonly variant_id: number;
  readonly operation_key: string;
  readonly expected_revision: bigint;
  readonly reason: string;
}
export interface CountNormalizedProposal extends CountNormalizedDecision { readonly actual_quantity: bigint }
export interface CountOperation {
  readonly operation_key: string;
  readonly request_id: bigint;
  readonly variant_id: number;
  readonly actor_location_id: TransferLocationID;
  readonly action: CountAction;
  readonly expected_revision: bigint;
  readonly actual_quantity: bigint | null;
  readonly reason: string;
  readonly revision: bigint;
  readonly recorded_at: string;
}
export interface CountDecision {
  readonly operation_key: string;
  readonly actor_location_id: TransferLocationID;
  readonly accepted: boolean;
  readonly reason: string;
  readonly recorded_at: string;
}
export interface CountApplication {
  readonly effective_credit: bigint;
  readonly delta: bigint;
  readonly recorded_at: string;
}
export interface CountProposal {
  readonly revision: bigint;
  readonly operation_key: string;
  readonly initiator_location_id: TransferLocationID;
  readonly actual_quantity: bigint;
  readonly base_revision: bigint;
  readonly base_credit: bigint;
  readonly reason: string;
  readonly recorded_at: string;
  readonly state: CountProposalState;
  readonly decision: CountDecision | null;
  readonly application: CountApplication | null;
}
export interface CountCorrectionLine {
  readonly effective_dispatch: bigint;
  readonly reconciliation_revision: bigint;
  readonly variant_id: number;
  readonly expected_quantity: bigint;
  readonly actual_quantity: bigint;
  readonly available_quantity: bigint;
  readonly workflow_revision: bigint;
  readonly applied_revision: bigint;
  readonly effective_actual: bigint;
  readonly effective_credit: bigint;
  readonly proposals: readonly CountProposal[];
}
export interface CountCorrections {
  readonly request_id: bigint;
  readonly lines: readonly CountCorrectionLine[];
  readonly operations: readonly CountOperation[];
}
const maxInt64 = 9223372036854775807n;
function invalid(): never { throw new Error('Invalid count correction response'); }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const o = value as Record<string, unknown>;
  if (Object.keys(o).length !== keys.length || keys.some(key => !Object.hasOwn(o, key))) return invalid();
  return o;
}
function decimal(value: unknown, min = 0n, max = maxInt64): bigint {
  if (typeof value !== 'string' || value.length > 19 || !/^(0|[1-9][0-9]*)$/.test(value)) return invalid();
  const n = BigInt(value);
  if (n < min || n > max) return invalid();
  return n;
}
function delta(value: unknown): bigint {
  if (typeof value !== 'string' || value.length > 20 || !/^(0|-?[1-9][0-9]*)$/.test(value)) return invalid();
  const n = BigInt(value);
  if (n < -maxInt64 - 1n || n > maxInt64) return invalid();
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
  return value; // ASCII-space admission check must never change persisted evidence.
}
function stamp(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{0,8}[1-9])?Z$/.test(value)) return invalid();
  const date = new Date(value.slice(0, 19) + 'Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19) !== value.slice(0, 19)) return invalid();
  return value;
}
function action(value: unknown): CountAction {
  if (value !== 'propose' && value !== 'accept' && value !== 'reject') return invalid();
  return value;
}
function array<T>(value: unknown, parse: (item: unknown) => T): readonly T[] {
  if (!Array.isArray(value)) return invalid();
  return Object.freeze(value.map(parse));
}
// The existing transfer decoder helpers are private. Keep a narrow local token
// scan because lossless-json alone permits equal-valued duplicate members.
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
function operation(value: unknown): CountOperation {
  const o = object(value, ['operation_key', 'request_id', 'variant_id', 'actor_location_id', 'action',
    'expected_revision', 'actual_quantity', 'reason', 'revision', 'recorded_at']);
  const a = action(o.action);
  const expected = decimal(o.expected_revision, 0n, maxInt64 - 1n);
  const revision = decimal(o.revision, 1n);
  if (revision !== (a === 'propose' ? expected + 1n : expected)) return invalid();
  if (a !== 'propose' && o.actual_quantity !== null) return invalid();
  return Object.freeze({ operation_key: key(o.operation_key), request_id: decimal(o.request_id, 1n),
    variant_id: variant(o.variant_id), actor_location_id: location(o.actor_location_id), action: a,
    expected_revision: expected, actual_quantity: a === 'propose' ? decimal(o.actual_quantity) : null,
    reason: reason(o.reason), revision, recorded_at: stamp(o.recorded_at) });
}
function decision(value: unknown): CountDecision {
  const o = object(value, ['operation_key', 'actor_location_id', 'accepted', 'reason', 'recorded_at']);
  if (typeof o.accepted !== 'boolean') return invalid();
  return Object.freeze({ operation_key: key(o.operation_key), actor_location_id: location(o.actor_location_id),
    accepted: o.accepted, reason: reason(o.reason), recorded_at: stamp(o.recorded_at) });
}
function application(value: unknown): CountApplication {
  const o = object(value, ['effective_credit', 'delta', 'recorded_at']);
  return Object.freeze({ effective_credit: decimal(o.effective_credit), delta: delta(o.delta), recorded_at: stamp(o.recorded_at) });
}
function proposal(value: unknown): CountProposal {
  const o = object(value, ['revision', 'operation_key', 'initiator_location_id', 'actual_quantity', 'base_revision',
    'base_credit', 'reason', 'recorded_at', 'state', 'decision', 'application']);
  const state = o.state;
  if (state !== 'pending' && state !== 'superseded' && state !== 'rejected' && state !== 'applied') return invalid();
  const d = o.decision === null ? null : decision(o.decision);
  const a = o.application === null ? null : application(o.application);
  if (state === 'applied' ? !d?.accepted || !a : state === 'rejected' ? !d || d.accepted || a !== null : d !== null || a !== null) return invalid();
  return Object.freeze({ revision: decimal(o.revision, 1n), operation_key: key(o.operation_key),
    initiator_location_id: location(o.initiator_location_id), actual_quantity: decimal(o.actual_quantity),
    base_revision: decimal(o.base_revision), base_credit: decimal(o.base_credit), reason: reason(o.reason),
    recorded_at: stamp(o.recorded_at), state, decision: d, application: a });
}
function line(value: unknown): CountCorrectionLine {
  const o = object(value, ['variant_id', 'expected_quantity', 'actual_quantity', 'available_quantity',
    'workflow_revision', 'applied_revision', 'effective_actual', 'effective_credit', 'proposals', 'effective_dispatch', 'reconciliation_revision']);
  const expected = decimal(o.expected_quantity);
  const dispatch = decimal(o.effective_dispatch);
  const reconciliation = decimal(o.reconciliation_revision);
  if (reconciliation === 0n && dispatch !== expected || expected === 0n && (dispatch !== 0n || reconciliation !== 0n)) return invalid();
  return Object.freeze({ variant_id: variant(o.variant_id), expected_quantity: expected,
    effective_dispatch: dispatch, reconciliation_revision: reconciliation,
    actual_quantity: decimal(o.actual_quantity), available_quantity: decimal(o.available_quantity),
    workflow_revision: decimal(o.workflow_revision), applied_revision: decimal(o.applied_revision),
    effective_actual: decimal(o.effective_actual), effective_credit: decimal(o.effective_credit), proposals: array(o.proposals, proposal) });
}
export function parseCountCorrectionError(raw: string): string {
  try {
    const o = object(decode(raw), ['error']);
    if (typeof o.error !== 'string') return invalid();
    return o.error;
  } catch { return invalid(); }
}
export function parseCountOperation(raw: string): CountOperation {
  try { return operation(decode(raw)); } catch { return invalid(); }
}
export function parseCountCorrections(raw: string): CountCorrections {
  try {
    const o = object(decode(raw), ['request_id', 'lines', 'operations']);
    const request_id = decimal(o.request_id, 1n);
    const operations = array(o.operations, operation);
    if (operations.some(op => op.request_id !== request_id)) return invalid();
    return Object.freeze({ request_id, lines: array(o.lines, line), operations });
  } catch { return invalid(); }
}
function normalized(value: unknown, propose: boolean): CountNormalizedDecision | CountNormalizedProposal {
  const o = object(value, ['variant_id', 'operation_key', 'expected_revision', 'reason', ...(propose ? ['actual_quantity'] : [])]);
  const common = { variant_id: variant(o.variant_id), operation_key: key(o.operation_key),
    expected_revision: decimal(o.expected_revision, 0n, maxInt64 - 1n), reason: reason(o.reason) };
  return Object.freeze(propose ? { ...common, actual_quantity: decimal(o.actual_quantity) } : common);
}
export function normalizeCountProposal(input: CountProposalInput): CountNormalizedProposal {
  return normalized(input, true) as CountNormalizedProposal;
}
export function normalizeCountDecision(input: CountDecisionInput): CountNormalizedDecision {
  return normalized(input, false);
}
export function countCorrectionsPath(id: string): string { return transferDetailPath(id) + '/count-corrections'; }
export function countActorLocation(value: number): TransferLocationID { return location(value); }
export function matchesCountOperation(op: CountOperation, requestID: bigint, actor: TransferLocationID,
  requestedAction: CountAction, input: CountNormalizedDecision | CountNormalizedProposal): boolean {
  return op.request_id === requestID && op.actor_location_id === actor && op.action === requestedAction
    && op.variant_id === input.variant_id && op.operation_key === input.operation_key
    && op.expected_revision === input.expected_revision && op.reason === input.reason
    && op.actual_quantity === ('actual_quantity' in input ? input.actual_quantity : null);
}
