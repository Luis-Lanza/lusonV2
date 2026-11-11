/**
 * Transport of the branch Compras document. Every answer is admitted only when it is
 * JSON of exactly the contract's shape; money and weight stay exact integer units and
 * no amount is ever coerced to a float.
 */
import { LosslessNumber, parse as parseJSON } from 'lossless-json';
import { moneyCents } from './pointOfSaleModel';
import {
  canonicalPurchaseInput, canonicalPurchaseModelCode, canonicalPurchaseReversalInput,
  kgMilliFromWire, purchaseHistoryMaxPage, purchaseMaxID, purchaseMaxLines,
  purchaseMaxMoneyCents, purchaseMaxNote, purchaseMaxQuantity, purchaseMaxReason,
  purchaseReversible, purchaseHistoryPageSizes, scrapLineAmountCents,
  type PurchaseHistoryRow, type PurchaseInput, type PurchaseReversalInput,
} from './purchaseModel';

export type { PurchaseHistoryRow } from './purchaseModel';

export type PurchaseErrorCode = 'invalid_request' | 'forbidden' | 'not_found'
  | 'retry_conflict' | 'already_reversed' | 'service_unavailable'
  | 'invalid_response' | 'network' | 'aborted';

/** One admitted refusal per HTTP status; nothing else may reach the UI. */
export const purchaseAdmittedErrors: ReadonlyMap<number, readonly PurchaseErrorCode[]> = new Map([
  [400, ['invalid_request']],
  [403, ['forbidden']],
  [404, ['not_found']],
  [409, ['retry_conflict', 'already_reversed']],
  [503, ['service_unavailable']],
]);

/** Spanish message for every failure, including the transport ones. */
export const purchaseErrorMessages: Record<PurchaseErrorCode, string> = {
  invalid_request: 'El servidor rechazó la compra: revisá las líneas, los montos y la nota. No se registró nada.',
  forbidden: 'No tenés permiso para registrar compras en esta sucursal. No se registró nada.',
  not_found: 'La compra ya no existe en esta sucursal. Actualizá el historial.',
  retry_conflict: 'La clave de esta compra ya se usó con otro contenido. No se aplicó ningún cambio: revisá el documento.',
  already_reversed: 'Esta compra ya tiene su contra-documento o es un contra-documento: no se registró otra anulación.',
  service_unavailable: 'El servicio no está disponible. No pudimos confirmar la compra: conservamos el documento para reintentar.',
  invalid_response: 'La respuesta del servidor no es válida. No pudimos confirmar la compra: conservamos el documento.',
  network: 'No se pudo conectar con el servidor. Conservamos el documento para reintentar el mismo registro.',
  aborted: 'La operación se interrumpió. Revisá la conexión e intentá de nuevo.',
};

export const purchaseReceivedUnavailable = 'No se pudo consultar lo recibido. Revisá la conexión e intentá de nuevo.';
export const purchaseHistoryUnavailable = 'No se pudo consultar el historial de compras. Revisá la conexión e intentá de nuevo.';
export const purchaseModelsUnavailable = 'No se pudo consultar el catálogo de modelos. Revisá la conexión e intentá de nuevo.';

/** One used line of a persisted document: the model, the typed price and its amount. */
export interface PurchaseUsedLine {
  readonly model: string;
  readonly quantity: number;
  readonly unit_price_cents: bigint;
  readonly amount_cents: bigint;
}
/** One scrap line of a persisted document, weighed in integer thousandths of a kilogram. */
export interface PurchaseScrapLine {
  readonly material_id: number;
  readonly name: string;
  readonly kg_milli: bigint;
  readonly price_per_kg_cents: bigint;
  readonly amount_cents: bigint;
}
/** The persisted purchase, exactly as the contract answers it. */
export interface PurchaseDocument {
  readonly id: number;
  readonly location_id: number;
  readonly note: string;
  readonly total_cents: bigint;
  readonly paid_cash_cents: bigint;
  readonly paid_transfer_cents: bigint;
  readonly created_by_account_id: number;
  readonly created_at: string;
  readonly reverses_purchase_id: number | null;
  readonly reversed_by: number | null;
  readonly reason: string;
  readonly used_lines: readonly PurchaseUsedLine[];
  readonly scrap_lines: readonly PurchaseScrapLine[];
}
/** One newest-first page of purchase documents. */
export interface PurchasePage {
  readonly page: number;
  readonly page_size: number;
  readonly total_purchases: number;
  readonly purchases: readonly PurchaseHistoryRow[];
}
export interface PurchaseMaterial { readonly id: number; readonly name: string }
export interface PurchaseLastPriceModel {
  readonly model: string;
  readonly unit_price_cents: bigint;
  readonly purchased_at: string;
}
export interface PurchaseLastPriceMaterial {
  readonly material_id: number;
  readonly price_per_kg_cents: bigint;
  readonly purchased_at: string;
}
export interface PurchaseLastPrices {
  readonly models: readonly PurchaseLastPriceModel[];
  readonly materials: readonly PurchaseLastPriceMaterial[];
}
export interface PurchaseReceivedUsed {
  readonly model: string;
  readonly quantity: number;
  readonly value_cents: bigint;
}
export interface PurchaseReceivedScrap {
  readonly material_id: number;
  readonly name: string;
  readonly kg_milli: bigint;
  readonly value_cents: bigint;
}
export interface PurchaseReceived {
  readonly used: readonly PurchaseReceivedUsed[];
  readonly scrap: readonly PurchaseReceivedScrap[];
}

// ---------------------------------------------------------------------------------
// Strict decoding
// ---------------------------------------------------------------------------------

function invalidResponse(): never { throw new Error('Respuesta inválida del servidor.'); }

function decode(raw: string): unknown {
  try {
    return parseJSON(raw, null, { onDuplicateKey: () => { throw new Error('duplicate key'); } });
  } catch { return invalidResponse(); }
}

function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof LosslessNumber) {
    return invalidResponse();
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some(key => !Object.hasOwn(record, key))) {
    return invalidResponse();
  }
  return record;
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value === '' || value.includes('\0') || !value.isWellFormed()) {
    return invalidResponse();
  }
  return value;
}

function optionalText(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.includes('\0') || !value.isWellFormed()
    || Array.from(value).length > max) {
    return invalidResponse();
  }
  return value;
}

function numeric(value: unknown): string {
  if (!(value instanceof LosslessNumber)) return invalidResponse();
  return value.toString();
}

function integer(value: unknown, min: number, max: number): number {
  const raw = numeric(value);
  if (!/^(0|[1-9]\d*)$/.test(raw)) return invalidResponse();
  const exact = BigInt(raw);
  if (exact < BigInt(min) || exact > BigInt(max)) return invalidResponse();
  return Number(exact);
}

function signedInteger(value: unknown, min: number, max: number): number {
  const raw = numeric(value);
  if (!/^(0|-?[1-9]\d*)$/.test(raw)) return invalidResponse();
  const exact = BigInt(raw);
  if (exact < BigInt(min) || exact > BigInt(max)) return invalidResponse();
  return Number(exact);
}

function timestamp(value: unknown): string {
  const raw = text(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.test(raw)) {
    return invalidResponse();
  }
  const seconds = raw.slice(0, 19) + 'Z';
  const date = new Date(seconds);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19) !== raw.slice(0, 19)) {
    return invalidResponse();
  }
  if (!Number.isFinite(Date.parse(raw))) return invalidResponse();
  return raw;
}

const wireMoneyShape = /^-?(0|[1-9]\d{0,9})\.\d{2}$/;

/** A persisted amount is the canonical two-decimal text the database writes, signed or not. */
function wireMoney(value: unknown): bigint {
  if (typeof value !== 'string' || !wireMoneyShape.test(value)) return invalidResponse();
  const negative = value.startsWith('-');
  const [whole, fraction] = (negative ? value.slice(1) : value).split('.');
  const magnitude = BigInt(whole) * 100n + BigInt(fraction);
  if (magnitude > purchaseMaxMoneyCents || (negative && magnitude === 0n)) return invalidResponse();
  return negative ? -magnitude : magnitude;
}

function positiveMoney(value: unknown): bigint {
  const cents = wireMoney(value);
  if (cents <= 0n) return invalidResponse();
  return cents;
}

/** A persisted weight is the canonical three-decimal text, signed for a counter-document. */
function wireWeight(value: unknown): bigint {
  if (typeof value !== 'string') return invalidResponse();
  try { return kgMilliFromWire(value); } catch { return invalidResponse(); }
}

function modelCode(value: unknown): string {
  const model = text(value);
  try {
    if (canonicalPurchaseModelCode(model) !== model) return invalidResponse();
  } catch { return invalidResponse(); }
  return model;
}

/** A counter-document states its motive; an original never carries one. */
function documentReason(value: unknown, counter: boolean): string {
  const reason = optionalText(value, purchaseMaxReason);
  if (counter) {
    const trimmed = reason.trim();
    if (trimmed === '' || trimmed !== reason) return invalidResponse();
    return reason;
  }
  return reason === '' ? '' : invalidResponse();
}

function usedLine(value: unknown, counter: boolean): PurchaseUsedLine {
  const line = fields(value, ['model', 'quantity', 'unit_price', 'amount']);
  const quantity = counter
    ? signedInteger(line.quantity, -purchaseMaxQuantity, -1)
    : integer(line.quantity, 1, purchaseMaxQuantity);
  const unit_price_cents = positiveMoney(line.unit_price);
  const amount_cents = wireMoney(line.amount);
  if (amount_cents !== unit_price_cents * BigInt(quantity)) return invalidResponse();
  return Object.freeze({ model: modelCode(line.model), quantity, unit_price_cents, amount_cents });
}

function scrapLine(value: unknown, counter: boolean): PurchaseScrapLine {
  const line = fields(value, ['material_id', 'name', 'kg', 'price_per_kg', 'amount']);
  const kg_milli = wireWeight(line.kg);
  if (counter ? kg_milli >= 0n : kg_milli <= 0n) return invalidResponse();
  const price_per_kg_cents = positiveMoney(line.price_per_kg);
  const amount_cents = wireMoney(line.amount);
  if (amount_cents !== scrapLineAmountCents(kg_milli, price_per_kg_cents)) return invalidResponse();
  return Object.freeze({ material_id: integer(line.material_id, 1, purchaseMaxID), name: text(line.name),
    kg_milli, price_per_kg_cents, amount_cents });
}

function ascending<T>(rows: readonly T[], key: (row: T) => number | string): void {
  rows.forEach((row, index) => {
    if (index === 0) return;
    const previous = key(rows[index - 1]);
    const current = key(row);
    if (typeof previous === 'number' && typeof current === 'number') {
      if (current <= previous) invalidResponse();
    } else if (String(current) <= String(previous)) invalidResponse();
  });
}

/** Parses one persisted document: exact keys, exact amounts and the mirror of a reversal. */
export function parsePurchaseDocument(raw: string): PurchaseDocument {
  const record = fields(decode(raw), ['id', 'location_id', 'note', 'total', 'paid_cash', 'paid_transfer',
    'created_by_account_id', 'created_at', 'reverses_purchase_id', 'reversed_by', 'reason',
    'used_lines', 'scrap_lines']);
  const id = integer(record.id, 1, Number.MAX_SAFE_INTEGER);
  const location_id = integer(record.location_id, 2, 32767);
  const reverses_purchase_id = record.reverses_purchase_id === null
    ? null : integer(record.reverses_purchase_id, 1, id - 1);
  const counter = reverses_purchase_id !== null;
  const reversed_by = record.reversed_by === null
    ? null : integer(record.reversed_by, id + 1, Number.MAX_SAFE_INTEGER);
  if (!Array.isArray(record.used_lines) || record.used_lines.length > purchaseMaxLines) return invalidResponse();
  if (!Array.isArray(record.scrap_lines) || record.scrap_lines.length > purchaseMaxLines) return invalidResponse();
  if (record.used_lines.length + record.scrap_lines.length === 0) return invalidResponse();
  const used_lines = record.used_lines.map(line => usedLine(line, counter));
  ascending(used_lines, line => line.model);
  const scrap_lines = record.scrap_lines.map(line => scrapLine(line, counter));
  ascending(scrap_lines, line => line.material_id);
  const total_cents = wireMoney(record.total);
  const paid_cash_cents = wireMoney(record.paid_cash);
  const paid_transfer_cents = wireMoney(record.paid_transfer);
  const sum = used_lines.reduce((amount, line) => amount + line.amount_cents, 0n)
    + scrap_lines.reduce((amount, line) => amount + line.amount_cents, 0n);
  if (total_cents !== sum) return invalidResponse();
  if (paid_cash_cents + paid_transfer_cents !== total_cents) return invalidResponse();
  if (counter) {
    if (total_cents >= 0n || paid_cash_cents > 0n || paid_transfer_cents > 0n) return invalidResponse();
  } else if (total_cents <= 0n || paid_cash_cents < 0n || paid_transfer_cents < 0n) {
    return invalidResponse();
  }
  return Object.freeze({
    id, location_id, note: optionalText(record.note, purchaseMaxNote),
    total_cents, paid_cash_cents, paid_transfer_cents,
    created_by_account_id: integer(record.created_by_account_id, 1, Number.MAX_SAFE_INTEGER),
    created_at: timestamp(record.created_at), reverses_purchase_id, reversed_by,
    reason: documentReason(record.reason, counter), used_lines: Object.freeze(used_lines),
    scrap_lines: Object.freeze(scrap_lines),
  });
}

function historyRow(value: unknown): PurchaseHistoryRow {
  const row = fields(value, ['id', 'created_at', 'total', 'reverses_purchase_id', 'reversed_by',
    'used_units', 'scrap_lines']);
  const id = integer(row.id, 1, Number.MAX_SAFE_INTEGER);
  const reverses_purchase_id = row.reverses_purchase_id === null
    ? null : integer(row.reverses_purchase_id, 1, id - 1);
  const counter = reverses_purchase_id !== null;
  const total_cents = wireMoney(row.total);
  if (counter ? total_cents >= 0n : total_cents <= 0n) return invalidResponse();
  const used_units = signedInteger(row.used_units,
    -purchaseMaxLines * purchaseMaxQuantity, purchaseMaxLines * purchaseMaxQuantity);
  const scrap_lines = integer(row.scrap_lines, 0, purchaseMaxLines);
  if (used_units === 0 && scrap_lines === 0) return invalidResponse();
  return Object.freeze({
    id, created_at: timestamp(row.created_at), total_cents, reverses_purchase_id,
    reversed_by: row.reversed_by === null ? null : integer(row.reversed_by, id + 1, Number.MAX_SAFE_INTEGER),
    used_units, scrap_lines,
  });
}

/** Parses one newest-first page with counts that fit the page and the document bounds. */
export function parsePurchasePage(raw: string): PurchasePage {
  const record = fields(decode(raw), ['page', 'page_size', 'total_purchases', 'purchases']);
  const page = integer(record.page, 1, purchaseHistoryMaxPage);
  const page_size = integer(record.page_size, 10, 50);
  if (!purchaseHistoryPageSizes.includes(page_size)) return invalidResponse();
  const total_purchases = integer(record.total_purchases, 0, Number.MAX_SAFE_INTEGER);
  if (!Array.isArray(record.purchases) || record.purchases.length > page_size) return invalidResponse();
  if (record.purchases.length > 0
    && (page - 1) * page_size + record.purchases.length > total_purchases) return invalidResponse();
  let previous = Number.POSITIVE_INFINITY;
  const purchases = record.purchases.map(value => {
    const row = historyRow(value);
    if (row.id >= previous) return invalidResponse();
    previous = row.id;
    return row;
  });
  return Object.freeze({ page, page_size, total_purchases, purchases: Object.freeze(purchases) });
}

export function parsePurchaseModels(raw: string): readonly string[] {
  const record = fields(decode(raw), ['models']);
  if (!Array.isArray(record.models)) return invalidResponse();
  const models = record.models.map(modelCode);
  ascending(models, model => model);
  return Object.freeze(models);
}

export function parsePurchaseMaterials(raw: string): readonly PurchaseMaterial[] {
  const record = fields(decode(raw), ['materials']);
  if (!Array.isArray(record.materials)) return invalidResponse();
  const materials = record.materials.map(value => {
    const row = fields(value, ['id', 'name']);
    return Object.freeze({ id: integer(row.id, 1, purchaseMaxID), name: text(row.name) });
  });
  ascending(materials, row => row.id);
  return Object.freeze(materials);
}

export function parsePurchaseLastPrices(raw: string): PurchaseLastPrices {
  const record = fields(decode(raw), ['models', 'materials']);
  if (!Array.isArray(record.models) || !Array.isArray(record.materials)) return invalidResponse();
  const models = record.models.map(value => {
    const row = fields(value, ['model', 'unit_price', 'purchased_at']);
    return Object.freeze({ model: modelCode(row.model), unit_price_cents: positiveMoney(row.unit_price),
      purchased_at: timestamp(row.purchased_at) });
  });
  ascending(models, row => row.model);
  const materials = record.materials.map(value => {
    const row = fields(value, ['material_id', 'price_per_kg', 'purchased_at']);
    return Object.freeze({ material_id: integer(row.material_id, 1, purchaseMaxID),
      price_per_kg_cents: positiveMoney(row.price_per_kg), purchased_at: timestamp(row.purchased_at) });
  });
  ascending(materials, row => row.material_id);
  return Object.freeze({ models: Object.freeze(models), materials: Object.freeze(materials) });
}

export function parsePurchaseReceived(raw: string): PurchaseReceived {
  const record = fields(decode(raw), ['used', 'scrap']);
  if (!Array.isArray(record.used) || !Array.isArray(record.scrap)) return invalidResponse();
  const used = record.used.map(value => {
    const row = fields(value, ['model', 'quantity', 'value']);
    return Object.freeze({ model: modelCode(row.model),
      quantity: integer(row.quantity, 1, purchaseMaxLines * purchaseMaxQuantity),
      value_cents: positiveMoney(row.value) });
  });
  ascending(used, row => row.model);
  const scrap = record.scrap.map(value => {
    const row = fields(value, ['material_id', 'name', 'kg', 'value']);
    const kg_milli = wireWeight(row.kg);
    if (kg_milli <= 0n) return invalidResponse();
    return Object.freeze({ material_id: integer(row.material_id, 1, purchaseMaxID), name: text(row.name),
      kg_milli, value_cents: positiveMoney(row.value) });
  });
  ascending(scrap, row => row.material_id);
  return Object.freeze({ used: Object.freeze(used), scrap: Object.freeze(scrap) });
}

export function parsePurchaseError(raw: string, status: number): PurchaseErrorCode {
  const admitted = purchaseAdmittedErrors.get(status);
  if (!admitted) return invalidResponse();
  const envelope = fields(decode(raw), ['error']);
  const code = envelope.error;
  if (typeof code !== 'string' || !admitted.includes(code as PurchaseErrorCode)) return invalidResponse();
  return code as PurchaseErrorCode;
}

/** A definite rejection proves nothing was written; every other failure stays uncertain. */
export function purchaseFailureIsDefinite(code: PurchaseErrorCode): boolean {
  return code === 'invalid_request' || code === 'forbidden' || code === 'not_found'
    || code === 'retry_conflict' || code === 'already_reversed';
}

// ---------------------------------------------------------------------------------
// Paths and the evidence a reply must repeat
// ---------------------------------------------------------------------------------

export function validPurchaseHistoryQuery(page: number, pageSize: number): boolean {
  return Number.isInteger(page) && page >= 1 && page <= purchaseHistoryMaxPage
    && Number.isInteger(pageSize) && purchaseHistoryPageSizes.includes(pageSize);
}

export function purchaseHistoryPath(page: number, pageSize: number): string {
  if (!validPurchaseHistoryQuery(page, pageSize)) {
    throw new Error('Consulta de compras inválida.');
  }
  return `/api/purchases?page=${page}&page_size=${pageSize}`;
}

function purchaseID(id: number): number {
  if (!Number.isSafeInteger(id) || id < 1 || id > Number.MAX_SAFE_INTEGER) {
    throw new Error('Compra inválida.');
  }
  return id;
}

export function purchaseDetailPath(id: number): string {
  return `/api/purchases/${purchaseID(id)}`;
}

export function purchaseReversePath(id: number): string {
  return `/api/purchases/${purchaseID(id)}/reverse`;
}

/** The reply is evidence only if it repeats the exact document this client sent. */
export function matchesPurchaseInput(input: PurchaseInput, document: PurchaseDocument): boolean {
  let expected: PurchaseInput;
  try { expected = canonicalPurchaseInput(input); } catch { return false; }
  if (document.reverses_purchase_id !== null || document.note !== expected.note) return false;
  if (document.used_lines.length !== expected.used_lines.length) return false;
  if (document.scrap_lines.length !== expected.scrap_lines.length) return false;
  const sameUsed = expected.used_lines.every((line, index) => {
    const written = document.used_lines[index];
    return written.model === line.model && written.quantity === line.quantity
      && written.unit_price_cents === moneyCents(line.unit_price);
  });
  if (!sameUsed) return false;
  const sameScrap = expected.scrap_lines.every((line, index) => {
    const written = document.scrap_lines[index];
    return written.material_id === line.material_id && written.kg_milli === kgMilliFromWire(line.kg)
      && written.price_per_kg_cents === moneyCents(line.price_per_kg);
  });
  if (!sameScrap) return false;
  const expectedTotal = expected.used_lines.reduce((total, line) =>
    total + moneyCents(line.unit_price) * BigInt(line.quantity), 0n)
    + expected.scrap_lines.reduce((total, line) =>
      total + scrapLineAmountCents(kgMilliFromWire(line.kg), moneyCents(line.price_per_kg)), 0n);
  return document.total_cents === expectedTotal
    && document.paid_cash_cents === moneyCents(expected.paid_cash)
    && document.paid_transfer_cents === moneyCents(expected.paid_transfer);
}

/** The counter-document must mirror the listed document exactly, motive included. */
export function matchesPurchaseReversal(row: PurchaseHistoryRow, input: PurchaseReversalInput,
  document: PurchaseDocument): boolean {
  let expected: PurchaseReversalInput;
  try { expected = canonicalPurchaseReversalInput(input); } catch { return false; }
  if (!purchaseReversible(row)) return false;
  if (document.reverses_purchase_id !== row.id || document.reason !== expected.reason) return false;
  if (document.total_cents !== -row.total_cents) return false;
  const units = document.used_lines.reduce((total, line) => total + line.quantity, 0);
  if (units !== -row.used_units) return false;
  if (document.scrap_lines.length !== row.scrap_lines) return false;
  if (document.used_lines.some(line => line.quantity >= 0)) return false;
  if (document.scrap_lines.some(line => line.kg_milli >= 0n)) return false;
  return true;
}

// ---------------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------------

export class PurchaseAPIError extends Error {
  constructor(public readonly code: PurchaseErrorCode, public readonly status: number | null) {
    super(code); this.name = 'PurchaseAPIError';
  }
}

const jsonHeader = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;
const csrfToken = /^[A-Za-z0-9_-]+$/;

function transportFailure(error: unknown, signal?: AbortSignal): PurchaseAPIError {
  const aborted = signal?.aborted === true
    || (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError');
  return new PurchaseAPIError(aborted ? 'aborted' : 'network', null);
}

async function readText(reply: Response, signal?: AbortSignal): Promise<string> {
  try { return await reply.text(); } catch (error) { throw transportFailure(error, signal); }
}

export function createPurchaseAPI(fetch: typeof globalThis.fetch = globalThis.fetch) {
  async function get<T>(path: string, parse: (raw: string) => T, signal?: AbortSignal): Promise<T> {
    let reply: Response;
    let raw: string;
    try {
      reply = await fetch(path, { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal });
      raw = await readText(reply, signal);
    } catch (error) {
      if (error instanceof PurchaseAPIError) throw error;
      throw transportFailure(error, signal);
    }
    const malformed = () => new PurchaseAPIError('invalid_response', reply.status);
    if (!jsonHeader.test(reply.headers.get('Content-Type') ?? '')) throw malformed();
    if (reply.status !== 200) {
      let code: PurchaseErrorCode;
      try { code = parsePurchaseError(raw, reply.status); } catch { throw malformed(); }
      throw new PurchaseAPIError(code, reply.status);
    }
    try { return parse(raw); } catch { throw malformed(); }
  }

  async function post<T>(path: string, body: string, csrf: string,
    parse: (raw: string) => T, signal?: AbortSignal): Promise<T> {
    let reply: Response;
    let raw: string;
    try {
      reply = await fetch(path, { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body });
      raw = await readText(reply, signal);
    } catch (error) {
      if (error instanceof PurchaseAPIError) throw error;
      throw transportFailure(error, signal);
    }
    const malformed = () => new PurchaseAPIError('invalid_response', reply.status);
    if (!jsonHeader.test(reply.headers.get('Content-Type') ?? '')) throw malformed();
    if (reply.status !== 201) {
      let code: PurchaseErrorCode;
      try { code = parsePurchaseError(raw, reply.status); } catch { throw malformed(); }
      throw new PurchaseAPIError(code, reply.status);
    }
    try { return parse(raw); } catch { throw malformed(); }
  }

  return {
    /** Registers the purchase; the payload and the token are frozen before any await. */
    async create(input: PurchaseInput, csrf: string, signal?: AbortSignal): Promise<PurchaseDocument> {
      let sent: PurchaseInput;
      let body: string;
      try {
        if (typeof csrf !== 'string' || !csrfToken.test(csrf)) throw new Error('Missing CSRF token');
        sent = canonicalPurchaseInput(input);
        body = JSON.stringify(sent);
      } catch { throw new PurchaseAPIError('invalid_request', null); }
      const document = await post('/api/purchases', body, csrf, parsePurchaseDocument, signal);
      if (!matchesPurchaseInput(sent, document)) throw new PurchaseAPIError('invalid_response', 201);
      return document;
    },

    async history(page: number, pageSize: number, signal?: AbortSignal): Promise<PurchasePage> {
      let path: string;
      try { path = purchaseHistoryPath(page, pageSize); } catch { throw new PurchaseAPIError('invalid_request', null); }
      const parsed = await get(path, parsePurchasePage, signal);
      if (parsed.page !== page || parsed.page_size !== pageSize) throw new PurchaseAPIError('invalid_response', 200);
      return parsed;
    },

    async detail(id: number, signal?: AbortSignal): Promise<PurchaseDocument> {
      let path: string;
      try { path = purchaseDetailPath(id); } catch { throw new PurchaseAPIError('invalid_request', null); }
      const document = await get(path, parsePurchaseDocument, signal);
      if (document.id !== id) throw new PurchaseAPIError('invalid_response', 200);
      return document;
    },

    async reverse(row: PurchaseHistoryRow, input: PurchaseReversalInput, csrf: string,
      signal?: AbortSignal): Promise<PurchaseDocument> {
      let sent: PurchaseReversalInput;
      let body: string;
      let path: string;
      try {
        if (typeof csrf !== 'string' || !csrfToken.test(csrf)) throw new Error('Missing CSRF token');
        if (!purchaseReversible(row)) throw new Error('Not reversible');
        path = purchaseReversePath(row.id);
        sent = canonicalPurchaseReversalInput(input);
        body = JSON.stringify(sent);
      } catch { throw new PurchaseAPIError('invalid_request', null); }
      const document = await post(path, body, csrf, parsePurchaseDocument, signal);
      if (!matchesPurchaseReversal(row, sent, document)) throw new PurchaseAPIError('invalid_response', 201);
      return document;
    },

    async models(signal?: AbortSignal): Promise<readonly string[]> {
      return get('/api/purchases/models', parsePurchaseModels, signal);
    },

    async materials(signal?: AbortSignal): Promise<readonly PurchaseMaterial[]> {
      return get('/api/purchases/materials', parsePurchaseMaterials, signal);
    },

    async lastPrices(signal?: AbortSignal): Promise<PurchaseLastPrices> {
      return get('/api/purchases/last-prices', parsePurchaseLastPrices, signal);
    },

    async received(signal?: AbortSignal): Promise<PurchaseReceived> {
      return get('/api/purchases/received', parsePurchaseReceived, signal);
    },
  };
}
