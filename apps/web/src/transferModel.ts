import { parse as parseJSON } from 'lossless-json';

export type TransferKind = 'request_stock' | 'send_to_warehouse' | 'direct_shipment';
export type TransferFlow = 'requestWarehouse' | 'requestOther' | 'sendWarehouse' | 'directA' | 'directB';
export type TransferLocationID = 1 | 2 | 3;
export interface TransferDirection {
  kind: TransferKind; counterparty_location_id: TransferLocationID;
  creator_location_id: TransferLocationID; origin_location_id: TransferLocationID;
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
export type TransferStatus = 'pending' | 'approved' | 'rejected' | 'in_transit' | 'received' | 'cancelled';
export interface TransferReceiptInput { items: readonly { readonly variant_id: number; readonly actual_quantity: string }[] }
export interface TransferReceiptLine { readonly variant_id: number; readonly expected_quantity: bigint; readonly actual_quantity: bigint; readonly available_quantity: bigint }
export interface TransferReceiptException { readonly variant_id: number; readonly kind: 'shortage' | 'excess' | 'unexpected'; readonly quantity: bigint }
export interface TransferReceiptData { readonly items: readonly TransferReceiptLine[]; readonly exceptions: readonly TransferReceiptException[] }
interface TransferRecordFields {
  id: string; reference: string; kind: TransferKind; created_at: string;
  creator_location_id: TransferLocationID; creator_location_name: string;
  origin_location_id: TransferLocationID; origin_location_name: string;
  destination_location_id: TransferLocationID; destination_location_name: string;
  approver_location_id: TransferLocationID; approver_location_name: string;
  items: TransferItem[];
  cancellation_location_id?: TransferLocationID; cancelled_at?: string;
}
export type TransferRecord = TransferRecordFields & (
  { status: 'cancelled'; cancellation_location_id: TransferLocationID; cancelled_at: string;
    dispatch_location_id?: never; dispatched_at?: never } & (
      { decision_location_id?: never; decided_at?: never }
      | { decision_location_id: TransferLocationID; decided_at: string })
  | { status: 'pending'; decision_location_id?: never; decided_at?: never; dispatch_location_id?: never; dispatched_at?: never }
  | { status: 'approved' | 'rejected'; decision_location_id: TransferLocationID; decided_at: string; dispatch_location_id?: never; dispatched_at?: never }
  | { status: 'in_transit'; decision_location_id: TransferLocationID; decided_at: string; dispatch_location_id: TransferLocationID; dispatched_at: string; receipt_location_id?: never; received_at?: never; receipt?: never }
  | { status: 'received'; decision_location_id: TransferLocationID; decided_at: string; dispatch_location_id: TransferLocationID; dispatched_at: string; receipt_location_id: TransferLocationID; received_at: string; receipt: TransferReceiptData }
);
export type TransferStatusFilter = TransferStatus | 'all';
export const transferActionReasons = ['approve', 'dispatch', 'receive', 'review_count', 'review_restitution'] as const;
export type TransferActionReason = typeof transferActionReasons[number];
export type TransferActionCounts = Record<TransferActionReason, bigint>;
export interface TransferQuery { page?: number; page_size?: 10 | 25 | 50; status?: TransferStatusFilter; requires_action?: boolean }
export interface TransferCounts { pending_total: bigint; action_count: bigint; actions?: TransferActionCounts }
export function parseTransferCounts(raw: string): TransferCounts {
  const o = object(decode(raw), ['pending_total', 'action_count', 'actions'], false);
  const pending_total = exact(o.pending_total, true);
  const action_count = exact(o.action_count, true);
  if (!Object.hasOwn(o, 'actions')) return { pending_total, action_count };
  const categories = object(o.actions, transferActionReasons);
  const actions = Object.fromEntries(transferActionReasons.map(reason => {
    const count = exact(categories[reason], true);
    if (count > action_count) return invalid();
    return [reason, count];
  })) as TransferActionCounts;
  return { pending_total, action_count, actions };
}
export interface TransferPage {
  page: number; page_size: 10 | 25 | 50; status: TransferStatusFilter; total_count: bigint; records: TransferRecord[];
  requires_action?: boolean;
  required_actions?: Record<string, readonly TransferActionReason[]>;
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
  if (value !== 'request_stock' && value !== 'send_to_warehouse' && value !== 'direct_shipment') return invalid();
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
  if (assigned === 1) {
    if (flow !== 'directA' && flow !== 'directB') return invalid();
    const destination = flow === 'directA' ? 2 : 3;
    return { kind: 'direct_shipment', counterparty_location_id: destination, creator_location_id: 1,
      origin_location_id: 1, destination_location_id: destination, approver_location_id: 1 };
  }
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
  if ((k === 'send_to_warehouse' && counterpart !== 1) || (k === 'direct_shipment' && counterpart === 1)) return invalid();
  if (typeof o.retry_key !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(o.retry_key)) return invalid();
  const items = lines(o.items).sort((a, b) => a.variant_id - b.variant_id).map(item => Object.freeze(item));
  return Object.freeze({ kind: k, counterparty_location_id: counterpart, retry_key: o.retry_key, items: Object.freeze(items) });
}
export function canonicalTransferReceiptInput(input: TransferReceiptInput, original: Pick<TransferRecord, 'items'>): TransferReceiptInput {
  const o = object(input, ['items']);
  if (!Array.isArray(o.items) || o.items.length === 0) return invalid();
  const expected = new Set(original.items.map(item => item.variant_id));
  const seen = new Set<number>();
  let positive = false;
  const items = o.items.map(value => {
    const line = object(value, ['variant_id', 'actual_quantity']);
    const variant_id = integer(line.variant_id, 1, 2147483647);
    const actual = exact(line.actual_quantity, true);
    if (seen.has(variant_id) || (!expected.has(variant_id) && actual === 0n)) return invalid();
    seen.add(variant_id); positive ||= actual > 0n;
    return Object.freeze({ variant_id, actual_quantity: line.actual_quantity as string });
  }).sort((a, b) => a.variant_id - b.variant_id);
  if (!positive || [...expected].some(id => !seen.has(id))) return invalid();
  return Object.freeze({ items: Object.freeze(items) });
}
export function previewTransferReceipt(input: TransferReceiptInput, original: Pick<TransferRecord, 'items'>): TransferReceiptData {
  const canonical = canonicalTransferReceiptInput(input, original);
  const sent = new Map(original.items.map(item => [item.variant_id, item.quantity]));
  const exceptions: TransferReceiptException[] = [];
  const items = canonical.items.map(line => {
    const expected_quantity = sent.get(line.variant_id) ?? 0n;
    const actual_quantity = BigInt(line.actual_quantity);
    const available_quantity = actual_quantity < expected_quantity ? actual_quantity : expected_quantity;
    if (expected_quantity === 0n) exceptions.push(Object.freeze({ variant_id: line.variant_id, kind: 'unexpected', quantity: actual_quantity }));
    else if (actual_quantity !== expected_quantity) exceptions.push(Object.freeze({ variant_id: line.variant_id,
      kind: actual_quantity < expected_quantity ? 'shortage' : 'excess',
      quantity: actual_quantity < expected_quantity ? expected_quantity - actual_quantity : actual_quantity - expected_quantity }));
    return Object.freeze({ variant_id: line.variant_id, expected_quantity, actual_quantity, available_quantity });
  });
  return Object.freeze({ items: Object.freeze(items), exceptions: Object.freeze(exceptions) });
}
function receiptData(value: unknown, sent: TransferItem[]): TransferReceiptData {
  const o = object(value, ['items', 'exceptions']);
  if (!Array.isArray(o.items) || !Array.isArray(o.exceptions)) return invalid();
  const items = o.items.map(value => {
    const line = object(value, ['variant_id', 'expected_quantity', 'actual_quantity', 'available_quantity']);
    return { variant_id: integer(line.variant_id, 1, 2147483647), expected_quantity: exact(line.expected_quantity, true),
      actual_quantity: exact(line.actual_quantity, true), available_quantity: exact(line.available_quantity, true) };
  });
  const exceptions = o.exceptions.map(value => {
    const exception = object(value, ['variant_id', 'kind', 'quantity']);
    if (!['shortage', 'excess', 'unexpected'].includes(exception.kind as string)) return invalid();
    return { variant_id: integer(exception.variant_id, 1, 2147483647), kind: exception.kind, quantity: exact(exception.quantity) };
  });
  // Recompute the contract from original sent units; never trust supplied credit or exceptions.
  const expected = previewTransferReceipt({ items: items.map(item => ({ variant_id: item.variant_id,
    actual_quantity: item.actual_quantity.toString() })) }, { items: sent });
  if (items.length !== expected.items.length || exceptions.length !== expected.exceptions.length
    || items.some((line, i) => Object.keys(line).some(key => Reflect.get(line, key) !== Reflect.get(expected.items[i], key)))
    || exceptions.some((line, i) => Object.keys(line).some(key => Reflect.get(line, key) !== Reflect.get(expected.exceptions[i], key)))) return invalid();
  return expected;
}
export function matchesReceiptInput(input: TransferReceiptInput, record: TransferRecord): boolean {
  return record.status === 'received' && input.items.length === record.receipt.items.length
    && input.items.every((line, i) => line.variant_id === record.receipt.items[i].variant_id
      && BigInt(line.actual_quantity) === record.receipt.items[i].actual_quantity);
}
function status(value: unknown): TransferStatus {
  if (value !== 'pending' && value !== 'approved' && value !== 'rejected' && value !== 'in_transit' && value !== 'received' && value !== 'cancelled') return invalid();
  return value;
}
function statusFilter(value: unknown): TransferStatusFilter { return value === 'all' ? value : status(value); }
function queryValues(query: TransferQuery): { page: number; page_size: 10 | 25 | 50; status: TransferStatusFilter; requires_action: boolean } {
  const o = object(query, ['page', 'page_size', 'status', 'requires_action'], false);
  if (o.requires_action !== undefined && typeof o.requires_action !== 'boolean') return invalid();
  const page = integer(o.page === undefined ? 1 : o.page, 1, 1000000);
  const size = o.page_size === undefined ? 25 : o.page_size;
  if (size !== 10 && size !== 25 && size !== 50) return invalid();
  return { page, page_size: size, status: statusFilter(o.status === undefined ? 'pending' : o.status), requires_action: o.requires_action === true };
}
export function transferListPath(query: TransferQuery = {}): string {
  const q = queryValues(query);
  return `/api/transfers?page=${q.page}&page_size=${q.page_size}&status=${q.status}${q.requires_action ? '&requires_action=true' : ''}`;
}
export function transferDetailPath(id: string): string {
  exact(id);
  return `/api/transfers/${id}`;
}
function assertUniqueJSONKeys(raw: string): void {
  // lossless-json's duplicate callback omits equal values. Scan tokens first,
  // with one key set per object; syntax and numeric decoding remain its job.
  // This is an iterative linear scan, with stack/storage bounded by input size.
  const stack: { kind: '{' | '['; keys: Set<string>; expectingKey: boolean }[] = [];
  const whitespace = (char: string | undefined) => char === ' ' || char === '\t' || char === '\r' || char === '\n';
  let index = 0;
  while (index < raw.length) {
    const char = raw[index];
    if (char === '"') {
      const start = index++;
      while (index < raw.length && raw[index] !== '"') {
        // Skip an escaped character, including quotes and backslashes. Unicode
        // escape validity is checked when decoding keys, or by the final parser.
        index += raw[index] === '\\' ? 2 : 1;
      }
      if (index >= raw.length) return invalid();
      const end = ++index;
      const frame = stack.at(-1);
      if (frame?.kind === '{' && frame.expectingKey) {
        let next = end;
        while (whitespace(raw[next])) next++;
        if (raw[next] === ':') {
          // Decode only this quoted key token, never values or the whole DTO.
          const key: unknown = JSON.parse(raw.slice(start, end));
          if (typeof key !== 'string' || frame.keys.has(key)) return invalid();
          frame.keys.add(key); frame.expectingKey = false;
        }
      }
      continue;
    }
    if (char === '{' || char === '[') stack.push({ kind: char, keys: new Set<string>(), expectingKey: char === '{' });
    else if (char === '}' || char === ']') {
      const frame = stack.pop();
      if (!frame || frame.kind !== (char === '}' ? '{' : '[')) return invalid();
    } else if (char === ',') {
      const frame = stack.at(-1);
      if (frame?.kind === '{') frame.expectingKey = true;
    }
    index++;
  }
  if (stack.length !== 0) return invalid();
}
function decode(raw: string): unknown {
  try {
    assertUniqueJSONKeys(raw);
    return parseJSON(raw, null, { parseNumber: Number, onDuplicateKey: invalid });
  } catch { return invalid(); }
}
const recordKeys = ['id', 'reference', 'kind', 'status', 'created_at', 'items',
  'creator_location_id', 'creator_location_name', 'origin_location_id', 'origin_location_name',
  'destination_location_id', 'destination_location_name', 'approver_location_id', 'approver_location_name'];
function record(value: unknown): TransferRecord {
  // Determine the discriminant before enforcing an exact status-specific whitelist.
  const decisionKeys = [...recordKeys, 'decision_location_id', 'decided_at'];
  const dispatchKeys = [...decisionKeys, 'dispatch_location_id', 'dispatched_at'];
  const receiptKeys = [...dispatchKeys, 'receipt_location_id', 'received_at', 'receipt'];
  const cancellationKeys = [...recordKeys, 'cancellation_location_id', 'cancelled_at'];
  const candidate = object(value, [...receiptKeys, 'cancellation_location_id', 'cancelled_at'], false);
  const selected = status(candidate.status);
  const preservedApproval = selected === 'cancelled' && (Object.hasOwn(candidate, 'decision_location_id') || Object.hasOwn(candidate, 'decided_at'));
  const o = object(value, selected === 'cancelled' ? preservedApproval ? [...cancellationKeys, 'decision_location_id', 'decided_at'] : cancellationKeys
    : selected === 'pending' ? recordKeys : selected === 'received' ? receiptKeys : selected === 'in_transit' ? dispatchKeys : decisionKeys);
  exact(o.id);
  const id = o.id as string;
  if (o.reference !== `TR-${id.padStart(3, '0')}`) return invalid();
  const k = kind(o.kind);
  const creator = location(o.creator_location_id);
  const origin = location(o.origin_location_id);
  const destination = location(o.destination_location_id);
  const approver = location(o.approver_location_id);
  const flow = k === 'direct_shipment' ? destination === 2 ? 'directA' : 'directB'
    : k === 'send_to_warehouse' ? 'sendWarehouse' : origin === 1 ? 'requestWarehouse' : 'requestOther';
  const direction = transferDirection(creator, flow);
  if (k !== direction.kind || origin !== direction.origin_location_id || destination !== direction.destination_location_id || approver !== direction.approver_location_id) return invalid();
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
  const decision = selected === 'pending' || (selected === 'cancelled' && !preservedApproval) ? null : {
    decision_location_id: location(o.decision_location_id), decided_at: createdAt(o.decided_at),
  };
  if (decision && decision.decision_location_id !== approver) return invalid();
  let outcome: Pick<TransferRecord, 'status' | 'decision_location_id' | 'decided_at' | 'dispatch_location_id' | 'dispatched_at'>;
  if (selected === 'pending' || selected === 'cancelled') outcome = { status: selected, ...decision };
  else if (selected === 'in_transit' || selected === 'received') {
    const dispatched_at = createdAt(o.dispatched_at);
    // Fixed-width UTC seconds + padded fractions retain nanosecond ordering.
    const ordered = (time: string) => time.slice(0, 19) + (time.includes('.') ? time.slice(20, -1) : '').padEnd(9, '0');
    if (location(o.dispatch_location_id) !== origin || ordered(dispatched_at) < ordered(decision!.decided_at)) return invalid();
    outcome = { status: selected, ...decision!, dispatch_location_id: origin, dispatched_at };
  } else outcome = { status: selected, ...decision! };
  const receiptFields = selected === 'received' ? (() => {
    const received_at = createdAt(o.received_at);
    const ordered = (time: string) => time.slice(0, 19) + (time.includes('.') ? time.slice(20, -1) : '').padEnd(9, '0');
    if (location(o.receipt_location_id) !== destination || ordered(received_at) < ordered(outcome.dispatched_at!)) return invalid();
    return { receipt_location_id: destination, received_at, receipt: receiptData(o.receipt, items) };
  })() : {};
  const created_at = createdAt(o.created_at);
  if (k === 'direct_shipment' && (selected === 'pending' || selected === 'rejected'
    || !decision || decision.decision_location_id !== 1 || decision.decided_at !== created_at)) return invalid();
  const ordered = (time: string) => time.slice(0, 19) + (time.includes('.') ? time.slice(20, -1) : '').padEnd(9, '0');
  const cancellationFields = selected === 'cancelled' ? (() => {
    const cancelled_at = createdAt(o.cancelled_at);
    if (location(o.cancellation_location_id) !== creator || ordered(cancelled_at) < ordered(created_at)
      || (decision && (ordered(decision.decided_at) < ordered(created_at) || ordered(cancelled_at) < ordered(decision.decided_at)))) return invalid();
    return { cancellation_location_id: creator, cancelled_at };
  })() : {};
  const decoded = { ...outcome, ...receiptFields, ...cancellationFields, id, reference: o.reference as string, kind: k, created_at,
    creator_location_id: creator, creator_location_name: text(o.creator_location_name),
    origin_location_id: origin, origin_location_name: text(o.origin_location_name),
    destination_location_id: destination, destination_location_name: text(o.destination_location_name),
    approver_location_id: approver, approver_location_name: text(o.approver_location_name), items } as TransferRecord;
  if (k === 'direct_shipment' || selected === 'received' || selected === 'cancelled') { items.forEach(Object.freeze); Object.freeze(items); Object.freeze(decoded); }
  return decoded;
}
export function parseTransferRecord(raw: string): TransferRecord { return record(decode(raw)); }
export function parseTransferPage(raw: string): TransferPage {
  const o = object(decode(raw), ['page', 'page_size', 'status', 'total_count', 'records', 'requires_action', 'required_actions'], false);
  for (const key of ['page', 'page_size', 'status', 'total_count', 'records']) if (!Object.hasOwn(o, key)) return invalid();
  if (!Array.isArray(o.records)) return invalid();
  const q = queryValues({ page: o.page as number, page_size: o.page_size as 10 | 25 | 50, status: statusFilter(o.status) });
  const total_count = exact(o.total_count, true);
  const records = o.records.map(record);
  if (q.status !== 'all' && records.some(r => r.status !== q.status)) return invalid();
  const offset = BigInt(q.page - 1) * BigInt(q.page_size);
  const remaining = total_count > offset ? total_count - offset : 0n;
  const expected = remaining > BigInt(q.page_size) ? BigInt(q.page_size) : remaining;
  if (BigInt(records.length) !== expected || records.some((r, i) => i > 0 && BigInt(records[i - 1].id) <= BigInt(r.id))) return invalid();
  const page: TransferPage = { page: q.page, page_size: q.page_size, status: q.status, total_count, records };
  if (Object.hasOwn(o, 'requires_action') || Object.hasOwn(o, 'required_actions')) {
    if (typeof o.requires_action !== 'boolean') return invalid();
    page.requires_action = o.requires_action;
    page.required_actions = object(o.required_actions, records.map(r => r.id)) as TransferPage['required_actions'];
  }
  validateTransferActions(page);
  return page;
}
// List-only advice, never mutation permission. Count proposal initiators are not
// present in immutable headers: their counterpart eligibility stays server-owned.
export function validateTransferActions(page: TransferPage, assigned?: number): void {
  if (page.requires_action === undefined && page.required_actions === undefined) return;
  if (typeof page.requires_action !== 'boolean') return invalid();
  const metadata = object(page.required_actions, page.records.map(r => r.id));
  for (const record of page.records) {
    exact(record.id);
    const reasons = metadata[record.id];
    if (!Array.isArray(reasons) || (page.requires_action && reasons.length === 0)) return invalid();
    let previous = -1;
    for (const reason of reasons) {
      const index = transferActionReasons.indexOf(reason);
      if (index <= previous) return invalid();
      previous = index;
      const expected = reason === 'approve' ? 'pending' : reason === 'dispatch' ? 'approved' : reason === 'receive' ? 'in_transit' : 'received';
      if (record.status !== expected) return invalid();
      const owner = reason === 'approve' ? record.approver_location_id : reason === 'dispatch' ? record.origin_location_id
        : reason === 'review_count' ? assigned : record.destination_location_id;
      if (assigned !== undefined && owner !== assigned) return invalid();
    }
  }
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
