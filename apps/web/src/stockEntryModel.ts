import { LosslessNumber, parse as parseJSON } from 'lossless-json';
import { parseInventory, queryURL, type Item } from './model';
import { newTransferRetryKey } from './transferModel';

// Warehouse ingress contract: one document, applied atomically or not at all.
export interface StockEntryLineInput { readonly variant_id: number; readonly quantity: number }
export interface StockEntryInput {
  readonly operation_key: string; readonly note?: string; readonly lines: readonly StockEntryLineInput[];
}
export interface StockEntryLine { readonly variant_id: number; readonly quantity: number }
export interface StockEntryRecord {
  readonly id: number; readonly location_id: number; readonly note: string;
  readonly created_by_account_id: number; readonly created_at: string;
  readonly lines: readonly StockEntryLine[]; readonly total_units: number;
}
export type StockEntryErrorCode = 'invalid_request' | 'forbidden' | 'retry_conflict'
  | 'insufficient_stock' | 'service_unavailable' | 'invalid_response' | 'network' | 'aborted';

/** One counter-entry request: the target is in the path, the reason is mandatory. */
export interface StockEntryReversalInput { readonly operation_key: string; readonly reason: string }
export type StockEntryReversalErrorCode = 'invalid_request' | 'unauthenticated' | 'forbidden' | 'not_found'
  | 'decision_conflict' | 'retry_conflict' | 'insufficient_stock' | 'service_unavailable'
  | 'invalid_response' | 'network' | 'aborted';

/** One row of the read-only history: a document summary, never its lines. */
export interface StockEntryHistoryRow {
  readonly id: number; readonly note: string; readonly created_at: string;
  readonly lines: number; readonly total_units: number; readonly reversed_by: number | null;
}
/**
 * One persisted line of a document detail: the catalogue identity of the variant
 * plus the signed quantity of that document. Capacity keeps the inventory read's
 * canonical decimal text, never a float.
 */
export interface StockEntryDetailLine {
  readonly variant_id: number; readonly brand: string; readonly model: string;
  readonly capacity_ah: string; readonly polarity: 'L' | 'R'; readonly quantity: number;
}
/**
 * The full persisted document behind one history row: its header, the exact units
 * that entered and the two directions of the reversal cross-reference.
 */
export interface StockEntryDetail {
  readonly id: number; readonly location_id: number; readonly note: string;
  readonly created_at: string; readonly created_by_account_id: number;
  readonly reverses_entry_id: number | null; readonly reversed_by: number | null;
  readonly reason: string; readonly lines: readonly StockEntryDetailLine[]; readonly total_units: number;
}
export type StockEntryDetailErrorCode = 'invalid_request' | 'unauthenticated' | 'forbidden' | 'not_found'
  | 'service_unavailable' | 'invalid_response' | 'network' | 'aborted';
/** One newest-first page of persisted ingress documents plus the exact total. */
export interface StockEntryHistoryPage {
  readonly page: number; readonly page_size: number; readonly total_entries: number;
  readonly entries: readonly StockEntryHistoryRow[];
}

export const stockEntryMaxLines = 190;
export const stockEntryMaxQuantity = 1_000_000;
export const stockEntryMaxNote = 500;
export const stockEntryMaxReason = 500;
export const stockEntryMaxVariantID = 2_147_483_647;
export const stockEntryMaxDocumentUnits = stockEntryMaxLines * stockEntryMaxQuantity;
export const stockCatalogLocationID = 1;
export const stockCatalogPageSize = 50;
export const stockEntryHistoryPageSizes: readonly number[] = [10, 25, 50];
export const stockEntryHistoryDefaultPageSize = 25;
export const stockEntryHistoryMaxPage = 1_000_000;
export const stockEntryHistoryUnavailable =
  'No se pudo consultar el historial de ingresos. Revisá la conexión e intentá de nuevo.';

/** Admitted error envelope per HTTP status; nothing else may reach the UI. */
export const stockEntryAdmittedErrors: ReadonlyMap<number, readonly StockEntryErrorCode[]> = new Map([
  [400, ['invalid_request']],
  [403, ['forbidden']],
  [409, ['retry_conflict', 'insufficient_stock']],
  [503, ['service_unavailable']],
]);

/** The counter-entry route adds the identity and target failures of its own contract. */
export const stockEntryReversalAdmittedErrors: ReadonlyMap<number, readonly StockEntryReversalErrorCode[]> = new Map([
  [400, ['invalid_request']],
  [401, ['unauthenticated']],
  [403, ['forbidden']],
  [404, ['not_found']],
  [409, ['decision_conflict', 'retry_conflict', 'insufficient_stock']],
  [503, ['service_unavailable']],
]);

/** The document-detail route adds the identity and missing-document failures of its own contract. */
export const stockEntryDetailAdmittedErrors: ReadonlyMap<number, readonly StockEntryDetailErrorCode[]> = new Map([
  [400, ['invalid_request']],
  [401, ['unauthenticated']],
  [403, ['forbidden']],
  [404, ['not_found']],
  [503, ['service_unavailable']],
]);

/** Spanish user-facing message for every code, including transport failures. */
export const stockEntryErrorMessages: Record<StockEntryErrorCode, string> = {
  invalid_request: 'El documento no es válido. Revisá las líneas y la nota, y volvé a intentar.',
  forbidden: 'No tenés permiso para registrar ingresos en este almacén. No se aplicó ningún cambio.',
  retry_conflict: 'La clave de este ingreso ya se usó con otro contenido. No se aplicó ningún cambio: revisá el documento.',
  insufficient_stock: 'El servidor rechazó el ingreso. No se aplicó ningún cambio en el stock.',
  service_unavailable: 'El servicio no está disponible. No pudimos confirmar el ingreso: conservamos el documento para reintentar.',
  invalid_response: 'La respuesta del servidor no es válida. No pudimos confirmar el ingreso: conservamos el documento.',
  network: 'No se pudo conectar con el servidor. Conservamos el documento para reintentar el mismo ingreso.',
  aborted: 'La confirmación se interrumpió. Conservamos el documento para reintentar el mismo ingreso.',
};

/** Spanish message for every counter-entry failure, including transport ones. */
export const stockEntryReversalErrorMessages: Record<StockEntryReversalErrorCode, string> = {
  invalid_request: 'El motivo del contra-asiento no es válido: escribí entre 1 y 500 caracteres y volvé a intentar. No se registró ningún documento.',
  unauthenticated: 'La sesión no está activa. Volvé a iniciar sesión: no se registró ningún contra-asiento.',
  forbidden: 'No tenés permiso para anular ingresos en este almacén. No se aplicó ningún cambio.',
  not_found: 'El documento ya no existe en el Almacén. Actualizamos el historial: no se registró ningún contra-asiento.',
  decision_conflict: 'Este documento ya tiene un contra-asiento, o es un contra-asiento: no se registró otro. Actualizamos el historial.',
  retry_conflict: 'La clave de este contra-asiento ya se usó con otro motivo. No se aplicó ningún cambio: revisá el motivo.',
  insufficient_stock: 'El stock actual no alcanza: el stock ya no cubre esta anulación y el contra-asiento dejaría existencias por debajo de lo reservado. No se aplicó ningún cambio.',
  service_unavailable: 'El servicio no está disponible. No pudimos confirmar el contra-asiento: conservamos el motivo para reintentar.',
  invalid_response: 'La respuesta del servidor no es válida. No pudimos confirmar el contra-asiento: conservamos el motivo.',
  network: 'No se pudo conectar con el servidor. Conservamos el motivo para reintentar el mismo contra-asiento.',
  aborted: 'La confirmación se interrumpió. Conservamos el motivo para reintentar el mismo contra-asiento.',
};

/** Spanish message for every document-detail failure, including transport ones. */
export const stockEntryDetailErrorMessages: Record<StockEntryDetailErrorCode, string> = {
  invalid_request: 'El documento pedido no es válido. Cerrá el detalle y volvé a intentar desde el historial.',
  unauthenticated: 'La sesión no está activa. Volvé a iniciar sesión para ver el detalle del ingreso.',
  forbidden: 'No tenés permiso para ver este ingreso en este almacén.',
  not_found: 'El documento ya no existe en el Almacén. Actualizá el historial: no hay detalle para mostrar.',
  service_unavailable: 'El servicio no está disponible. No pudimos traer el detalle de este ingreso: reintentá el detalle.',
  invalid_response: 'La respuesta del servidor no es válida. No pudimos traer el detalle de este ingreso: reintentá el detalle.',
  network: 'No se pudo conectar con el servidor. Revisá la conexión y reintentá el detalle.',
  aborted: 'Se interrumpió la lectura del detalle. Reintentá el detalle del ingreso.',
};

function invalidResponse(): never { throw new Error('Respuesta inválida del servidor.'); }
function invalidInput(): never { throw new Error('Documento de ingreso inválido.'); }
function invalidReversal(): never { throw new Error('Contra-asiento inválido.'); }
function invalidDetail(): never { throw new Error('Detalle de ingreso inválido.'); }

function decode(raw: string): unknown {
  try {
    return parseJSON(raw, null, { onDuplicateKey: () => { throw new Error('duplicate key'); } });
  } catch { return invalidResponse(); }
}
function fields(value: unknown, keys: readonly string[], required = true): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof LosslessNumber) return invalidResponse();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !keys.includes(key))) return invalidResponse();
  if (required && keys.some(key => !Object.hasOwn(record, key))) return invalidResponse();
  return record;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value || value.includes('\0') || !value.isWellFormed()) return invalidResponse();
  return value;
}
// Default lossless parsing keeps every digit; numbers are never coerced to a float first.
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
/** A document total may be negative when the document is a counter-entry. */
function signedInteger(value: unknown, min: number, max: number): number {
  const raw = numeric(value);
  if (!/^(0|-?[1-9]\d*)$/.test(raw)) return invalidResponse();
  const exact = BigInt(raw);
  if (exact < BigInt(min) || exact > BigInt(max)) return invalidResponse();
  return Number(exact);
}
function validNote(value: string): boolean {
  return value.isWellFormed() && !value.includes('\0') && Array.from(value).length <= stockEntryMaxNote;
}
function note(value: unknown): string {
  if (typeof value !== 'string' || !validNote(value)) return invalidResponse();
  return value;
}
function timestamp(value: unknown): string {
  const raw = text(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.test(raw)) return invalidResponse();
  // Reject impossible calendar or clock values without rewriting the original text.
  const seconds = raw.slice(0, 19) + 'Z';
  const date = new Date(seconds);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19) !== raw.slice(0, 19)) return invalidResponse();
  if (!Number.isFinite(Date.parse(raw))) return invalidResponse();
  return raw;
}

export function validStockQuantity(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= stockEntryMaxQuantity;
}

function canonicalInput(input: StockEntryInput): StockEntryInput {
  // note is optional in the contract; everything else must be present and nothing else is admitted.
  const record = fields(input, ['operation_key', 'note', 'lines'], false);
  const operation_key = record.operation_key;
  if (typeof operation_key !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(operation_key)) return invalidResponse();
  if (!Array.isArray(record.lines) || record.lines.length < 1 || record.lines.length > stockEntryMaxLines) return invalidResponse();
  const seen = new Set<number>();
  const lines = record.lines.map(value => {
    const line = fields(value, ['variant_id', 'quantity']);
    const variant_id = typeof line.variant_id === 'number' && Number.isInteger(line.variant_id)
      && line.variant_id >= 1 && line.variant_id <= stockEntryMaxVariantID ? line.variant_id : invalidResponse();
    const quantity = typeof line.quantity === 'number' && validStockQuantity(line.quantity) ? line.quantity : invalidResponse();
    if (seen.has(variant_id)) return invalidResponse();
    seen.add(variant_id);
    return Object.freeze({ variant_id, quantity });
  }).sort((left, right) => left.variant_id - right.variant_id);
  const draftNote = record.note === undefined ? '' : note(record.note);
  return Object.freeze({ operation_key, ...(draftNote === '' ? {} : { note: draftNote }), lines: Object.freeze(lines) });
}

/** Validates and normalizes a draft; the same ordered payload is sent and compared. */
export function canonicalStockEntryInput(input: StockEntryInput): StockEntryInput {
  try { return canonicalInput(input); } catch { return invalidInput(); }
}

export function newStockEntryOperationKey(source: Pick<Crypto, 'getRandomValues'> | undefined = globalThis.crypto): string {
  // Same secure generator as transfer creation; Math.random is never acceptable here.
  return newTransferRetryKey(source);
}

export function parseStockEntryRecord(raw: string): StockEntryRecord {
  return parseEntryRecord(raw, 'ingress');
}

/** A counter-entry carries the exact negation of the original lines. */
export function parseStockEntryReversalRecord(raw: string): StockEntryRecord {
  return parseEntryRecord(raw, 'counter');
}

function parseEntryRecord(raw: string, sign: 'ingress' | 'counter'): StockEntryRecord {
  const record = fields(decode(raw), ['id', 'location_id', 'note', 'created_by_account_id', 'created_at', 'lines', 'total_units']);
  const id = integer(record.id, 1, Number.MAX_SAFE_INTEGER);
  const location_id = integer(record.location_id, 1, 32767);
  const created_by_account_id = integer(record.created_by_account_id, 1, Number.MAX_SAFE_INTEGER);
  const created_at = timestamp(record.created_at);
  if (!Array.isArray(record.lines) || record.lines.length < 1 || record.lines.length > stockEntryMaxLines) return invalidResponse();
  const seen = new Set<number>();
  const lines = record.lines.map(value => {
    const line = fields(value, ['variant_id', 'quantity']);
    const variant_id = integer(line.variant_id, 1, stockEntryMaxVariantID);
    const quantity = sign === 'ingress'
      ? integer(line.quantity, 1, stockEntryMaxQuantity)
      : signedInteger(line.quantity, -stockEntryMaxQuantity, -1);
    if (seen.has(variant_id)) return invalidResponse();
    seen.add(variant_id);
    return Object.freeze({ variant_id, quantity });
  });
  const total_units = sign === 'ingress'
    ? integer(record.total_units, 1, stockEntryMaxLines * stockEntryMaxQuantity)
    : signedInteger(record.total_units, -stockEntryMaxLines * stockEntryMaxQuantity, -1);
  // A counter-entry has no note of its own and its lines always add up to its
  // total, so a shape the database cannot have written never crosses the wire.
  const documentNote = sign === 'ingress' ? note(record.note) : record.note === '' ? '' : invalidResponse();
  if (sign === 'counter' && lines.reduce((sum, line) => sum + line.quantity, 0) !== total_units) return invalidResponse();
  return Object.freeze({ id, location_id, note: documentNote, created_by_account_id, created_at,
    lines: Object.freeze(lines), total_units });
}

function admittedError<C extends string>(raw: string, status: number, table: ReadonlyMap<number, readonly C[]>): C {
  const admitted = table.get(status);
  if (!admitted) return invalidResponse();
  const envelope = fields(decode(raw), ['error']);
  const code = envelope.error;
  if (typeof code !== 'string' || !admitted.includes(code as C)) return invalidResponse();
  return code as C;
}

export function parseStockEntryError(raw: string, status: number): StockEntryErrorCode {
  return admittedError(raw, status, stockEntryAdmittedErrors);
}

export function parseStockEntryReversalError(raw: string, status: number): StockEntryReversalErrorCode {
  return admittedError(raw, status, stockEntryReversalAdmittedErrors);
}

/** A definite rejection proves nothing was written; every other failure stays uncertain. */
export function stockEntryFailureIsDefinite(code: StockEntryErrorCode): boolean {
  return code === 'invalid_request' || code === 'forbidden' || code === 'retry_conflict' || code === 'insufficient_stock';
}

/** The response is evidence only if it repeats the exact payload this client sent. */
export function matchesStockEntryInput(input: StockEntryInput, record: StockEntryRecord): boolean {
  let expected: StockEntryInput;
  try { expected = canonicalStockEntryInput(input); } catch { return false; }
  if (record.location_id !== stockCatalogLocationID) return false;
  if (record.lines.length !== expected.lines.length) return false;
  const total = expected.lines.reduce((sum, line) => sum + line.quantity, 0);
  if (record.total_units !== total) return false;
  if (record.lines.reduce((sum, line) => sum + line.quantity, 0) !== record.total_units) return false;
  const lines = [...record.lines].sort((left, right) => left.variant_id - right.variant_id);
  return expected.lines.every((line, index) => lines[index].variant_id === line.variant_id && lines[index].quantity === line.quantity);
}

/** Reuses the existing inventory read contract; no new catalog endpoint. */
export function stockCatalogPath(search: string): string {
  return queryURL({ location: stockCatalogLocationID, search, brand: '', polarity: '', page: 1, size: stockCatalogPageSize });
}

export function parseStockCatalog(raw: string): readonly Item[] {
  const page = parseInventory(raw);
  if (page.location.id !== stockCatalogLocationID || page.page !== 1 || page.page_size !== stockCatalogPageSize) return invalidResponse();
  return Object.freeze(page.items);
}

/** Only the frozen page and page sizes are ever requested. */
export function validStockEntryHistoryQuery(page: number, pageSize: number): boolean {
  return Number.isInteger(page) && page >= 1 && page <= stockEntryHistoryMaxPage
    && Number.isInteger(pageSize) && stockEntryHistoryPageSizes.includes(pageSize);
}

export function stockEntryHistoryPath(page: number, pageSize: number): string {
  return `/api/stock-entries?page=${page}&page_size=${pageSize}`;
}

/**
 * Parses one history page strictly: exact keys, lossless numbers, newest-first
 * rows with counts that fit the page and the document bounds. A counter-entry is
 * always a later document than the one it reverses.
 */
export function parseStockEntryHistory(raw: string): StockEntryHistoryPage {
  const record = fields(decode(raw), ['page', 'page_size', 'total_entries', 'entries']);
  const page = integer(record.page, 1, stockEntryHistoryMaxPage);
  const page_size = integer(record.page_size, 10, 50);
  if (!stockEntryHistoryPageSizes.includes(page_size)) return invalidResponse();
  const total_entries = integer(record.total_entries, 0, Number.MAX_SAFE_INTEGER);
  if (!Array.isArray(record.entries) || record.entries.length > page_size) return invalidResponse();
  // A page beyond the last one is legitimately empty; a page with rows must fit
  // inside the total it was served with.
  if (record.entries.length > 0 && (page - 1) * page_size + record.entries.length > total_entries) return invalidResponse();
  let previous = Number.POSITIVE_INFINITY;
  const entries = record.entries.map(value => {
    const row = fields(value, ['id', 'note', 'created_at', 'lines', 'total_units', 'reversed_by']);
    const id = integer(row.id, 1, Number.MAX_SAFE_INTEGER);
    if (id >= previous) return invalidResponse();
    previous = id;
    const lines = integer(row.lines, 1, stockEntryMaxLines);
    const total_units = signedInteger(row.total_units, -stockEntryMaxDocumentUnits, stockEntryMaxDocumentUnits);
    const reversed_by = row.reversed_by === null ? null : integer(row.reversed_by, 1, Number.MAX_SAFE_INTEGER);
    if (reversed_by !== null && reversed_by <= id) return invalidResponse();
    return Object.freeze({ id, note: note(row.note), created_at: timestamp(row.created_at), lines, total_units, reversed_by });
  });
  return Object.freeze({ page, page_size, total_entries, entries: Object.freeze(entries) });
}

/**
 * A document is reversible only while it has no counter-entry of its own. A
 * counter-entry is never reversible: its lines are already negative, which is
 * exactly what `total_units > 0` proves here.
 */
export function stockEntryReversible(row: StockEntryHistoryRow): boolean {
  return row.reversed_by === null && row.total_units > 0;
}

/**
 * Admits the mandatory counter-entry reason and returns the exact text that is
 * sent, compared on a retry and persisted: trimmed, non-empty, at most 500
 * characters, no NUL and well-formed UTF-16.
 */
export function canonicalStockEntryReversalReason(reason: string): string {
  if (typeof reason !== 'string' || !validNote(reason)) return invalidReversal();
  const trimmed = reason.trim();
  if (trimmed === '') return invalidReversal();
  return trimmed;
}

/** Validates and freezes the exact counter-entry payload that will be sent. */
export function canonicalStockEntryReversalInput(input: StockEntryReversalInput): StockEntryReversalInput {
  try {
    const record = fields(input, ['operation_key', 'reason']);
    const operation_key = record.operation_key;
    if (typeof operation_key !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(operation_key)) return invalidReversal();
    return Object.freeze({ operation_key, reason: canonicalStockEntryReversalReason(record.reason as string) });
  } catch { return invalidReversal(); }
}

/** The frozen counter-entry path; only a canonical positive target id is admitted. */
export function stockEntryReversalPath(id: number): string {
  if (!Number.isSafeInteger(id) || id < 1) return invalidReversal();
  return `/api/stock-entries/${id}/reverse`;
}

/**
 * The response is evidence only if it is the exact negation of the listed
 * document: same line count, same unit total with the opposite sign, and every
 * line negative. Nothing about the original is cached, so this is the only
 * proof the client can demand.
 */
export function matchesStockEntryReversal(row: StockEntryHistoryRow, record: StockEntryRecord): boolean {
  if (record.location_id !== stockCatalogLocationID || record.note !== '') return false;
  if (!stockEntryReversible(row)) return false;
  if (record.lines.length !== row.lines) return false;
  const total = record.lines.reduce((sum, line) => sum + line.quantity, 0);
  if (record.lines.some(line => line.quantity >= 0)) return false;
  return total === record.total_units && total === -row.total_units;
}

/** A definite rejection proves nothing was written; every other failure stays uncertain. */
export function stockEntryReversalFailureIsDefinite(code: StockEntryReversalErrorCode): boolean {
  return code === 'invalid_request' || code === 'unauthenticated' || code === 'forbidden' || code === 'not_found'
    || code === 'decision_conflict' || code === 'retry_conflict' || code === 'insufficient_stock';
}

/**
 * Capacity is the inventory contract's canonical decimal text: at most six
 * integral digits, at most six fractional ones, positive, and already normalized,
 * because the server never writes a trailing zero.
 */
function stockCapacity(value: unknown): string {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,5})(\.\d{1,6})?$/.test(value) || !/[1-9]/.test(value)) return invalidResponse();
  const normalized = value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
  // The server always writes the normalized decimal, so a padded one is a shape
  // this contract never produces.
  return normalized === value ? value : invalidResponse();
}

/** A persisted motive is canonical: trimmed, non-empty, bounded UTF-16. */
function stockDetailReason(value: unknown): string {
  if (typeof value !== 'string' || !value.isWellFormed() || value.includes('\0')) return invalidResponse();
  if (Array.from(value).length > stockEntryMaxReason) return invalidResponse();
  const trimmed = value.trim();
  if (trimmed === '' || trimmed !== value) return invalidResponse();
  return value;
}

/** The frozen detail path; only a canonical positive document id is admitted. */
export function stockEntryDetailPath(id: number): string {
  if (!Number.isSafeInteger(id) || id < 1) return invalidDetail();
  return `/api/stock-entries/${id}`;
}

/**
 * Parses one document detail strictly: exact keys, lossless numbers, the catalogue
 * identity of every line and exactly the units that entered. An ingress document
 * only adds units, a counter-entry always negates its original and states why, and
 * neither cross-reference can point at itself or forward.
 */
export function parseStockEntryDetail(raw: string): StockEntryDetail {
  const record = fields(decode(raw), ['id', 'location_id', 'note', 'created_at', 'created_by_account_id',
    'reverses_entry_id', 'reversed_by', 'reason', 'lines', 'total_units']);
  const id = integer(record.id, 1, Number.MAX_SAFE_INTEGER);
  if (integer(record.location_id, 1, 32767) !== stockCatalogLocationID) return invalidResponse();
  const created_by_account_id = integer(record.created_by_account_id, 1, Number.MAX_SAFE_INTEGER);
  const created_at = timestamp(record.created_at);
  // A counter-entry points at an earlier document of this warehouse; an ingress
  // document points at nothing.
  const reverses_entry_id = record.reverses_entry_id === null
    ? null : integer(record.reverses_entry_id, 1, id - 1);
  // Only a later document can have reversed this one.
  const reversed_by = record.reversed_by === null
    ? null : integer(record.reversed_by, id + 1, Number.MAX_SAFE_INTEGER);
  const counter = reverses_entry_id !== null;
  const reason = counter ? stockDetailReason(record.reason) : record.reason === '' ? '' : invalidResponse();
  if (!Array.isArray(record.lines) || record.lines.length < 1 || record.lines.length > stockEntryMaxLines) return invalidResponse();
  let previous = 0;
  const lines = record.lines.map(value => {
    const line = fields(value, ['variant_id', 'brand', 'model', 'capacity_ah', 'polarity', 'quantity']);
    const variant_id = integer(line.variant_id, 1, stockEntryMaxVariantID);
    if (variant_id <= previous) return invalidResponse();
    previous = variant_id;
    if (line.polarity !== 'L' && line.polarity !== 'R') return invalidResponse();
    const quantity = counter
      ? signedInteger(line.quantity, -stockEntryMaxQuantity, -1)
      : integer(line.quantity, 1, stockEntryMaxQuantity);
    return Object.freeze({ variant_id, brand: text(line.brand), model: text(line.model),
      capacity_ah: stockCapacity(line.capacity_ah), polarity: line.polarity, quantity });
  });
  const total_units = counter
    ? signedInteger(record.total_units, -stockEntryMaxDocumentUnits, -1)
    : integer(record.total_units, 1, stockEntryMaxDocumentUnits);
  // The total is the exact signed sum of the listed lines, never a rounded or
  // independently reported figure.
  if (lines.reduce((sum, line) => sum + line.quantity, 0) !== total_units) return invalidResponse();
  return Object.freeze({ id, location_id: stockCatalogLocationID, note: note(record.note), created_at,
    created_by_account_id, reverses_entry_id, reversed_by, reason,
    lines: Object.freeze(lines), total_units });
}

export function parseStockEntryDetailError(raw: string, status: number): StockEntryDetailErrorCode {
  return admittedError(raw, status, stockEntryDetailAdmittedErrors);
}
