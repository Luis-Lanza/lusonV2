export type TransferKind = 'request_stock' | 'send_to_warehouse';
export type TransferFlow = 'requestWarehouse' | 'requestOther' | 'sendWarehouse';
export type TransferLocationID = 1 | 2 | 3;
export interface TransferDirection {
  kind: TransferKind; counterparty_location_id: TransferLocationID;
  creator_location_id: 2 | 3; origin_location_id: TransferLocationID;
  destination_location_id: TransferLocationID; approver_location_id: TransferLocationID;
}
export interface TransferLine { variant_id: number; quantity: string }
export interface TransferCreateInput {
  kind: TransferKind; counterparty_location_id: TransferLocationID;
  retry_key: string; items: readonly TransferLine[];
}
export interface TransferItem {
  variant_id: number; brand: string; model: string; capacity_ah: string;
  polarity: 'L' | 'R'; quantity: bigint;
}
export type TransferStatus = 'pending' | 'approved' | 'rejected' | 'in_transit';
interface TransferRecordFields {
  id: string; reference: string; kind: TransferKind; created_at: string;
  creator_location_id: 2 | 3; creator_location_name: string;
  origin_location_id: TransferLocationID; origin_location_name: string;
  destination_location_id: TransferLocationID; destination_location_name: string;
  approver_location_id: TransferLocationID; approver_location_name: string;
  items: TransferItem[];
}
export type TransferRecord = TransferRecordFields & (
  { status: 'pending'; decision_location_id?: never; decided_at?: never; dispatch_location_id?: never; dispatched_at?: never }
  | { status: 'approved' | 'rejected'; decision_location_id: TransferLocationID; decided_at: string; dispatch_location_id?: never; dispatched_at?: never }
  | { status: 'in_transit'; decision_location_id: TransferLocationID; decided_at: string; dispatch_location_id: TransferLocationID; dispatched_at: string }
);
export interface TransferQuery { page?: number; page_size?: 10 | 25 | 50; status?: TransferStatus }
export interface TransferCounts { pending_total: bigint; action_count: bigint }
export function parseTransferCounts(raw: string): TransferCounts {
  const o = object(decode(raw), ['pending_total', 'action_count']);
  const pending_total = exact(o.pending_total, true);
  const action_count = exact(o.action_count, true);
  if (action_count > pending_total) return invalid();
  return { pending_total, action_count };
}
export interface TransferPage {
  page: number; page_size: 10 | 25 | 50; status: TransferStatus; total_count: bigint; records: TransferRecord[];
}
const maxInt64 = 9223372036854775807n;
function invalid(): never { throw new Error('Invalid transfer response'); }
function object(value: unknown, keys: readonly string[], required = true): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const o = value as Record<string, unknown>;
  if (Object.keys(o).some(key => !keys.includes(key)) || (required && keys.some(key => !Object.hasOwn(o, key)))) return invalid();
  return o;
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) return invalid();
  return value;
}
function exact(value: unknown, zero = false): bigint {
  if (typeof value !== 'string' || value.length > 19 || !/^(0|[1-9][0-9]*)$/.test(value)) return invalid();
  const n = BigInt(value);
  if ((!zero && n === 0n) || n > maxInt64) return invalid();
  return n;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value || value.includes('\0') || !value.isWellFormed()) return invalid();
  return value;
}
function kind(value: unknown): TransferKind {
  if (value !== 'request_stock' && value !== 'send_to_warehouse') return invalid();
  return value;
}
function location(value: unknown): TransferLocationID { return integer(value, 1, 3) as TransferLocationID; }
function capacity(value: unknown): string {
  // catalog.Decimal is normalized: six whole/fraction digits, no trailing zero fraction.
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,5})(\.[0-9]{0,5}[1-9])?$/.test(value) || value === '0') return invalid();
  return value;
}
function createdAt(value: unknown): string {
  const s = text(value);
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{0,8}[1-9])?Z$/.test(s)) return invalid();
  // Validate calendar/time without rounding the original nanosecond text.
  const seconds = s.slice(0, 19) + 'Z';
  const date = new Date(seconds);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19) !== s.slice(0, 19)) return invalid();
  return s;
}
export function transferDirection(assigned: number, flow: TransferFlow): TransferDirection {
  if (assigned !== 2 && assigned !== 3) return invalid();
  if (!['requestWarehouse', 'requestOther', 'sendWarehouse'].includes(flow)) return invalid();
  const counterpart = flow === 'requestOther' ? (assigned === 2 ? 3 : 2) : 1;
  const send = flow === 'sendWarehouse';
  return { kind: send ? 'send_to_warehouse' : 'request_stock', counterparty_location_id: counterpart,
    creator_location_id: assigned, origin_location_id: send ? assigned : counterpart,
    destination_location_id: send ? 1 : assigned, approver_location_id: counterpart };
}
function lines(value: unknown): TransferLine[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 190) return invalid();
  const seen = new Set<number>();
  return value.map(v => {
    const o = object(v, ['variant_id', 'quantity']);
    const variant_id = integer(o.variant_id, 1, 2147483647);
    exact(o.quantity);
    if (seen.has(variant_id)) return invalid();
    seen.add(variant_id);
    return { variant_id, quantity: o.quantity as string };
  });
}
export function canonicalTransferInput(input: TransferCreateInput): TransferCreateInput {
  const o = object(input, ['kind', 'counterparty_location_id', 'retry_key', 'items']);
  const k = kind(o.kind);
  const counterpart = location(o.counterparty_location_id);
  if (k === 'send_to_warehouse' && counterpart !== 1) return invalid();
  if (typeof o.retry_key !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(o.retry_key)) return invalid();
  const items = lines(o.items).sort((a, b) => a.variant_id - b.variant_id).map(item => Object.freeze(item));
  return Object.freeze({ kind: k, counterparty_location_id: counterpart, retry_key: o.retry_key, items: Object.freeze(items) });
}
function status(value: unknown): TransferStatus {
  if (value !== 'pending' && value !== 'approved' && value !== 'rejected' && value !== 'in_transit') return invalid();
  return value;
}
function queryValues(query: TransferQuery): { page: number; page_size: 10 | 25 | 50; status: TransferStatus } {
  const o = object(query, ['page', 'page_size', 'status'], false);
  const page = integer(o.page === undefined ? 1 : o.page, 1, 1000000);
  const size = o.page_size === undefined ? 25 : o.page_size;
  if (size !== 10 && size !== 25 && size !== 50) return invalid();
  return { page, page_size: size, status: status(o.status === undefined ? 'pending' : o.status) };
}
export function transferListPath(query: TransferQuery = {}): string {
  const q = queryValues(query);
  return `/api/transfers?page=${q.page}&page_size=${q.page_size}&status=${q.status}`;
}
export function transferDetailPath(id: string): string {
  exact(id);
  return `/api/transfers/${id}`;
}
function decode(raw: string): unknown {
  // Trusted Go DTOs contain no duplicate keys. JSON.parse keeps string quantities
  // lossless; duplicates are not independently detected, unlike POST server input.
  try { return JSON.parse(raw); } catch { return invalid(); }
}
const recordKeys = ['id', 'reference', 'kind', 'status', 'created_at', 'items',
  'creator_location_id', 'creator_location_name', 'origin_location_id', 'origin_location_name',
  'destination_location_id', 'destination_location_name', 'approver_location_id', 'approver_location_name'];
function record(value: unknown): TransferRecord {
  // Determine the discriminant before enforcing an exact status-specific whitelist.
  const decisionKeys = [...recordKeys, 'decision_location_id', 'decided_at'];
  const dispatchKeys = [...decisionKeys, 'dispatch_location_id', 'dispatched_at'];
  const candidate = object(value, dispatchKeys, false);
  const selected = status(candidate.status);
  const o = object(value, selected === 'pending' ? recordKeys : selected === 'in_transit' ? dispatchKeys : decisionKeys);
  exact(o.id);
  const id = o.id as string;
  if (o.reference !== `TR-${id.padStart(3, '0')}`) return invalid();
  const k = kind(o.kind);
  const creator = integer(o.creator_location_id, 2, 3) as 2 | 3;
  const origin = location(o.origin_location_id);
  const destination = location(o.destination_location_id);
  const approver = location(o.approver_location_id);
  const flow = k === 'send_to_warehouse' ? 'sendWarehouse' : origin === 1 ? 'requestWarehouse' : 'requestOther';
  const direction = transferDirection(creator, flow);
  if (origin !== direction.origin_location_id || destination !== direction.destination_location_id || approver !== direction.approver_location_id) return invalid();
  if (!Array.isArray(o.items) || o.items.length < 1 || o.items.length > 190) return invalid();
  const quantities = lines(o.items.map(v => {
    const item = object(v, ['variant_id', 'brand', 'model', 'capacity_ah', 'polarity', 'quantity']);
    return { variant_id: item.variant_id, quantity: item.quantity };
  }));
  const items = o.items.map((v, i): TransferItem => {
    const item = v as Record<string, unknown>;
    if (item.polarity !== 'L' && item.polarity !== 'R') return invalid();
    return { variant_id: quantities[i].variant_id, quantity: BigInt(quantities[i].quantity),
      brand: text(item.brand), model: text(item.model), capacity_ah: capacity(item.capacity_ah), polarity: item.polarity };
  });
  const decision = selected === 'pending' ? null : {
    decision_location_id: location(o.decision_location_id), decided_at: createdAt(o.decided_at),
  };
  if (decision && decision.decision_location_id !== approver) return invalid();
  let outcome: Pick<TransferRecord, 'status' | 'decision_location_id' | 'decided_at' | 'dispatch_location_id' | 'dispatched_at'>;
  if (selected === 'pending') outcome = { status: selected };
  else if (selected === 'in_transit') {
    const dispatched_at = createdAt(o.dispatched_at);
    // Fixed-width UTC seconds + padded fractions retain nanosecond ordering.
    const ordered = (time: string) => time.slice(0, 19) + (time.includes('.') ? time.slice(20, -1) : '').padEnd(9, '0');
    if (location(o.dispatch_location_id) !== origin || ordered(dispatched_at) < ordered(decision!.decided_at)) return invalid();
    outcome = { status: selected, ...decision!, dispatch_location_id: origin, dispatched_at };
  } else outcome = { status: selected, ...decision! };
  return { ...outcome, id, reference: o.reference as string, kind: k, created_at: createdAt(o.created_at),
    creator_location_id: creator, creator_location_name: text(o.creator_location_name),
    origin_location_id: origin, origin_location_name: text(o.origin_location_name),
    destination_location_id: destination, destination_location_name: text(o.destination_location_name),
    approver_location_id: approver, approver_location_name: text(o.approver_location_name), items } as TransferRecord;
}
export function parseTransferRecord(raw: string): TransferRecord { return record(decode(raw)); }
export function parseTransferPage(raw: string): TransferPage {
  const o = object(decode(raw), ['page', 'page_size', 'status', 'total_count', 'records']);
  if (!Array.isArray(o.records)) return invalid();
  const q = queryValues({ page: o.page as number, page_size: o.page_size as 10 | 25 | 50, status: status(o.status) });
  const total_count = exact(o.total_count, true);
  const records = o.records.map(record);
  if (records.some(r => r.status !== q.status)) return invalid();
  const offset = BigInt(q.page - 1) * BigInt(q.page_size);
  const remaining = total_count > offset ? total_count - offset : 0n;
  const expected = remaining > BigInt(q.page_size) ? BigInt(q.page_size) : remaining;
  if (BigInt(records.length) !== expected || records.some((r, i) => i > 0 && BigInt(records[i - 1].id) <= BigInt(r.id))) return invalid();
  return { ...q, total_count, records };
}
export function transferQuantityTotal(record: TransferRecord): bigint {
  return record.items.reduce((total, item) => total + item.quantity, 0n);
}
export function newTransferRetryKey(crypto: Pick<Crypto, 'getRandomValues'> | undefined = globalThis.crypto): string {
  try {
    if (!crypto || typeof crypto.getRandomValues !== 'function') throw new Error();
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  } catch { throw new Error('Secure randomness unavailable'); }
}
