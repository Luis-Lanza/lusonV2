import { LosslessNumber, parse as parseJSON } from 'lossless-json';
import { validSearch } from './model';
import { newTransferRetryKey } from './transferModel';

// Warehouse stock adjustment contract: one immutable document that corrects the
// warehouse stock against a blind physical count, corrected only by a counter-entry.
export interface StockAdjustmentLineInput { readonly variant_id: number; readonly counted_quantity: number }
/**
 * The whole capture payload. Only the variant and what the operator counted is
 * ever sent: the expected quantity and the difference belong to the server.
 */
export interface StockAdjustmentInput {
  readonly operation_key: string; readonly reason: string; readonly lines: readonly StockAdjustmentLineInput[];
}
/** One applied line of a created or counter document: the persisted snapshot and the derived difference. */
export interface StockAdjustmentLine {
  readonly variant_id: number; readonly expected_quantity: number;
  readonly counted_quantity: number; readonly difference: number;
}
export interface StockAdjustmentRecord {
  readonly id: number; readonly location_id: number; readonly reason: string; readonly detail: string;
  readonly created_by_account_id: number; readonly created_at: string;
  readonly reverses_adjustment_id: number | null;
  readonly lines: readonly StockAdjustmentLine[]; readonly total_difference: number;
}
/** One row of the read-only history: a document summary, never its lines. */
export interface StockAdjustmentSummary {
  readonly id: number; readonly reason: string; readonly detail: string; readonly created_at: string;
  readonly lines: number; readonly total_difference: number;
  readonly reverses_adjustment_id: number | null; readonly reversed_by: number | null;
}
export interface StockAdjustmentPage {
  readonly page: number; readonly page_size: number; readonly total_adjustments: number;
  readonly adjustments: readonly StockAdjustmentSummary[];
}
/** One persisted line with the catalogue identity of its variant and the applied arithmetic. */
export interface StockAdjustmentDetailLine {
  readonly variant_id: number; readonly catalog_entry_id: number; readonly brand: string; readonly model: string;
  readonly capacity_ah: string; readonly polarity: 'L' | 'R';
  readonly expected_quantity: number; readonly counted_quantity: number; readonly difference: number;
}
export interface StockAdjustmentDetail {
  readonly id: number; readonly location_id: number; readonly reason: string; readonly detail: string;
  readonly created_at: string; readonly created_by_account_id: number;
  readonly reverses_adjustment_id: number | null; readonly reversed_by: number | null;
  readonly lines: readonly StockAdjustmentDetailLine[]; readonly total_difference: number;
}
/**
 * The blind capture catalogue: the catalogue identity of one variant of this
 * warehouse. It has no stock field at all, so the capture cannot reveal the number
 * the operator is supposed to count.
 */
export interface StockAdjustmentCatalogItem {
  readonly variant_id: number; readonly catalog_entry_id: number; readonly brand: string; readonly model: string;
  readonly capacity_ah: string; readonly polarity: 'L' | 'R';
}
export interface StockAdjustmentCatalogPage {
  readonly page: number; readonly page_size: number; readonly total_variants: number;
  readonly items: readonly StockAdjustmentCatalogItem[];
}
/** One counter-entry request: the target is in the path, the motive is mandatory. */
export interface StockAdjustmentReversalInput { readonly operation_key: string; readonly reason: string }

export type StockAdjustmentErrorCode = 'invalid_request' | 'unauthenticated' | 'forbidden' | 'not_found'
  | 'decision_conflict' | 'retry_conflict' | 'insufficient_stock' | 'service_unavailable'
  | 'invalid_response' | 'network' | 'aborted';

export const stockAdjustmentMaxLines = 190;
export const stockAdjustmentMaxCounted = 1_000_000;
export const stockAdjustmentMaxReason = 500;
export const stockAdjustmentMaxDetail = 500;
export const stockAdjustmentMaxVariantID = 2_147_483_647;
/** A line can only add a counted maximum and only remove an existing balance. */
export const stockAdjustmentMaxTotal = stockAdjustmentMaxLines * stockAdjustmentMaxCounted;
export const stockAdjustmentLocationID = 1;
export const stockAdjustmentPageSizes: readonly number[] = [10, 25, 50];
export const stockAdjustmentDefaultPageSize = 25;
export const stockAdjustmentCatalogPageSize = 25;
export const stockAdjustmentMaxPage = 1_000_000;
export const stockAdjustmentHistoryUnavailable =
  'No se pudo consultar el historial de ajustes. Revisá la conexión e intentá de nuevo.';
export const stockAdjustmentCatalogUnavailable =
  'No se pudo consultar el catálogo del Almacén. Revisá la conexión e intentá de nuevo.';

/** The four motives the operator sees, shown exactly as they are sent. */
export const stockAdjustmentMotives = [
  'Conteo físico periódico', 'Merma o rotura', 'Diferencia detectada en preparación', 'Otro',
] as const;
export type StockAdjustmentMotive = (typeof stockAdjustmentMotives)[number];

/** Admitted error envelope per HTTP status; nothing else may reach the UI. */
export const stockAdjustmentApplyAdmittedErrors: ReadonlyMap<number, readonly StockAdjustmentErrorCode[]> = new Map([
  [400, ['invalid_request']],
  [401, ['unauthenticated']],
  [403, ['forbidden']],
  [409, ['retry_conflict', 'insufficient_stock']],
  [503, ['service_unavailable']],
]);
export const stockAdjustmentHistoryAdmittedErrors: ReadonlyMap<number, readonly StockAdjustmentErrorCode[]> = new Map([
  [400, ['invalid_request']],
  [401, ['unauthenticated']],
  [403, ['forbidden']],
  [503, ['service_unavailable']],
]);
export const stockAdjustmentCatalogAdmittedErrors: ReadonlyMap<number, readonly StockAdjustmentErrorCode[]> = new Map([
  [400, ['invalid_request']],
  [401, ['unauthenticated']],
  [403, ['forbidden']],
  [503, ['service_unavailable']],
]);
export const stockAdjustmentDetailAdmittedErrors: ReadonlyMap<number, readonly StockAdjustmentErrorCode[]> = new Map([
  [400, ['invalid_request']],
  [401, ['unauthenticated']],
  [403, ['forbidden']],
  [404, ['not_found']],
  [503, ['service_unavailable']],
]);
export const stockAdjustmentReversalAdmittedErrors: ReadonlyMap<number, readonly StockAdjustmentErrorCode[]> = new Map([
  [400, ['invalid_request']],
  [401, ['unauthenticated']],
  [403, ['forbidden']],
  [404, ['not_found']],
  [409, ['decision_conflict', 'retry_conflict', 'insufficient_stock']],
  [503, ['service_unavailable']],
]);

/** Spanish message for every failure of an applied document, including transport ones. */
export const stockAdjustmentApplyMessages: Record<StockAdjustmentErrorCode, string> = {
  invalid_request: 'El ajuste no es válido: revisá las cantidades contadas y el motivo, y volvé a intentar. No se aplicó ningún cambio.',
  unauthenticated: 'La sesión no está activa. Volvé a iniciar sesión: no se aplicó ningún ajuste.',
  forbidden: 'No tenés permiso para ajustar el stock de este almacén. No se aplicó ningún cambio.',
  not_found: 'El documento pedido ya no existe en el Almacén. No se aplicó ningún ajuste.',
  decision_conflict: 'Este documento ya tiene un contra-asiento: no se aplicó ningún ajuste.',
  retry_conflict: 'La clave de este ajuste ya se usó con otro contenido. No se aplicó ningún cambio: revisá el documento antes de reintentar.',
  insufficient_stock: 'El ajuste dejaría existencias por debajo de lo reservado. No se aplicó ningún cambio en el stock.',
  service_unavailable: 'El servicio no está disponible. No pudimos confirmar el ajuste: conservamos lo contado para reintentar.',
  invalid_response: 'La respuesta del servidor no es válida. No pudimos confirmar el ajuste: conservamos lo contado.',
  network: 'No se pudo conectar con el servidor. Conservamos lo contado para reintentar el mismo ajuste.',
  aborted: 'La aplicación del ajuste se interrumpió. Conservamos lo contado para reintentar el mismo ajuste.',
};

/** Spanish message for every counter-entry failure, including transport ones. */
export const stockAdjustmentReversalMessages: Record<StockAdjustmentErrorCode, string> = {
  invalid_request: 'El motivo del contra-asiento no es válido: elegí un motivo de la lista y volvé a intentar. No se registró ningún documento.',
  unauthenticated: 'La sesión no está activa. Volvé a iniciar sesión: no se registró ningún contra-asiento.',
  forbidden: 'No tenés permiso para registrar contra-asientos en este almacén. No se aplicó ningún cambio.',
  not_found: 'El documento ya no existe en el Almacén. Actualizamos el historial: no se registró ningún contra-asiento.',
  decision_conflict: 'Este documento ya tiene un contra-asiento, o es un contra-asiento: no se registró otro. Actualizamos el historial.',
  retry_conflict: 'La clave de este contra-asiento ya se usó con otro motivo. No se aplicó ningún cambio: revisá el motivo.',
  insufficient_stock: 'El stock actual no alcanza: el contra-asiento dejaría existencias por debajo de lo reservado. No se aplicó ningún cambio.',
  service_unavailable: 'El servicio no está disponible. No pudimos confirmar el contra-asiento: conservamos el motivo para reintentar.',
  invalid_response: 'La respuesta del servidor no es válida. No pudimos confirmar el contra-asiento: conservamos el motivo.',
  network: 'No se pudo conectar con el servidor. Conservamos el motivo para reintentar el mismo contra-asiento.',
  aborted: 'La confirmación se interrumpió. Conservamos el motivo para reintentar el mismo contra-asiento.',
};

/** Spanish message for every read failure of the history, the detail and the capture catalogue. */
export const stockAdjustmentReadMessages: Record<StockAdjustmentErrorCode, string> = {
  invalid_request: 'La consulta de ajustes no es válida. Revisá los datos e intentá de nuevo.',
  unauthenticated: 'La sesión no está activa. Volvé a iniciar sesión para consultar los ajustes.',
  forbidden: 'No tenés permiso para consultar los ajustes de este almacén.',
  not_found: 'El documento ya no existe en el Almacén. Actualizá el historial: no hay detalle para mostrar.',
  decision_conflict: 'El documento consultado cambió de estado. Actualizá el historial.',
  retry_conflict: 'La consulta de ajustes quedó desactualizada. Actualizá el historial.',
  insufficient_stock: 'La consulta de ajustes no pudo completarse con el stock actual. Actualizá el historial.',
  service_unavailable: 'El servicio no está disponible. No pudimos traer los ajustes: revisá la conexión e intentá de nuevo.',
  invalid_response: 'La respuesta del servidor no es válida. No pudimos traer los ajustes: intentá de nuevo.',
  network: 'No se pudo conectar con el servidor. Revisá la conexión e intentá de nuevo.',
  aborted: 'Se interrumpió la lectura de los ajustes. Volvé a intentar la consulta.',
};

function invalidResponse(): never { throw new Error('Respuesta inválida del servidor.'); }
function invalidInput(): never { throw new Error('Documento de ajuste inválido.'); }
function invalidReversal(): never { throw new Error('Contra-asiento inválido.'); }
function invalidDetail(): never { throw new Error('Detalle de ajuste inválido.'); }

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
/** A difference, a total and a reversal amount are signed; the stored shape is canonical. */
function signedInteger(value: unknown, min: number, max: number): number {
  const raw = numeric(value);
  if (!/^(0|-?[1-9]\d*)$/.test(raw)) return invalidResponse();
  const exact = BigInt(raw);
  if (exact < BigInt(min) || exact > BigInt(max)) return invalidResponse();
  return Number(exact);
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
/**
 * Capacity is the inventory contract's canonical decimal text: at most six
 * integral digits, at most six fractional ones, positive, and already normalized,
 * because the server never writes a trailing zero.
 */
function capacity(value: unknown): string {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,5})(\.\d{1,6})?$/.test(value) || !/[1-9]/.test(value)) return invalidResponse();
  const normalized = value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
  return normalized === value ? value : invalidResponse();
}
/** A persisted motive is canonical: trimmed, non-empty, bounded UTF-16. */
function reason(value: unknown): string {
  if (typeof value !== 'string' || !value.isWellFormed() || value.includes('\0')) return invalidResponse();
  if (Array.from(value).length > stockAdjustmentMaxReason) return invalidResponse();
  const trimmed = value.trim();
  if (trimmed === '' || trimmed !== value) return invalidResponse();
  return value;
}
/** The optional document detail is persisted verbatim, so only its bound is enforced. */
function detailText(value: unknown): string {
  if (typeof value !== 'string' || !value.isWellFormed() || value.includes('\0')) return invalidResponse();
  if (Array.from(value).length > stockAdjustmentMaxDetail) return invalidResponse();
  return value;
}

export function validStockAdjustmentCounted(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= stockAdjustmentMaxCounted;
}

function validOperationKey(value: string): boolean {
  return /^[A-Za-z0-9_-]{16,128}$/.test(value);
}

/** Admits the mandatory motive and returns the exact text that is sent and compared. */
export function canonicalStockAdjustmentReason(value: string): string {
  if (typeof value !== 'string' || !value.isWellFormed() || value.includes('\0')) return invalidReversal();
  if (Array.from(value).length > stockAdjustmentMaxReason) return invalidReversal();
  const trimmed = value.trim();
  if (trimmed === '') return invalidReversal();
  return trimmed;
}

/**
 * Validates and freezes the exact capture payload that will be sent. The admitted
 * keys are the operation key, the motive and the counted lines: an expected
 * quantity or a difference is not part of this contract at all.
 */
export function canonicalStockAdjustmentInput(input: StockAdjustmentInput): StockAdjustmentInput {
  try {
    const record = fields(input, ['operation_key', 'reason', 'lines']);
    const operation_key = record.operation_key;
    if (typeof operation_key !== 'string' || !validOperationKey(operation_key)) return invalidInput();
    const motive = canonicalStockAdjustmentReason(record.reason as string);
    if (!Array.isArray(record.lines) || record.lines.length < 1 || record.lines.length > stockAdjustmentMaxLines) return invalidInput();
    const seen = new Set<number>();
    const lines = record.lines.map(value => {
      const line = fields(value, ['variant_id', 'counted_quantity']);
      const variant_id = typeof line.variant_id === 'number' && Number.isInteger(line.variant_id)
        && line.variant_id >= 1 && line.variant_id <= stockAdjustmentMaxVariantID ? line.variant_id : invalidInput();
      const counted_quantity = typeof line.counted_quantity === 'number' && validStockAdjustmentCounted(line.counted_quantity)
        ? line.counted_quantity : invalidInput();
      if (seen.has(variant_id)) return invalidInput();
      seen.add(variant_id);
      return Object.freeze({ variant_id, counted_quantity });
    }).sort((left, right) => left.variant_id - right.variant_id);
    return Object.freeze({ operation_key, reason: motive, lines: Object.freeze(lines) });
  } catch { return invalidInput(); }
}

export function newStockAdjustmentOperationKey(source: Pick<Crypto, 'getRandomValues'> | undefined = globalThis.crypto): string {
  // Same secure generator as ingress and transfers; Math.random is never acceptable here.
  return newTransferRetryKey(source);
}

/** Validates and freezes the exact counter-entry payload: only the key and the motive. */
export function canonicalStockAdjustmentReversalInput(input: StockAdjustmentReversalInput): StockAdjustmentReversalInput {
  try {
    const record = fields(input, ['operation_key', 'reason']);
    const operation_key = record.operation_key;
    if (typeof operation_key !== 'string' || !validOperationKey(operation_key)) return invalidReversal();
    return Object.freeze({ operation_key, reason: canonicalStockAdjustmentReason(record.reason as string) });
  } catch { return invalidReversal(); }
}

/**
 * A cross-reference into this warehouse's own ledger: a counter-entry always
 * points at a strictly earlier document, and the document it corrects is always
 * a later one.
 */
function reference(value: unknown, documentID: number, later: boolean): number | null {
  if (value === null) return null;
  const id = integer(value, 1, Number.MAX_SAFE_INTEGER);
  if (later ? id <= documentID : id >= documentID) return invalidResponse();
  return id;
}

function parseDocumentLines(value: unknown): readonly StockAdjustmentLine[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > stockAdjustmentMaxLines) return invalidResponse();
  let previous = 0;
  let total = 0;
  const lines = value.map(entry => {
    const line = fields(entry, ['variant_id', 'expected_quantity', 'counted_quantity', 'difference']);
    const variant_id = integer(line.variant_id, 1, stockAdjustmentMaxVariantID);
    if (variant_id <= previous) return invalidResponse();
    previous = variant_id;
    // The expected snapshot is the database's own non-negative value and the count
    // is what the operator declared; the difference is derived, never supplied.
    const expected_quantity = integer(line.expected_quantity, 0, Number.MAX_SAFE_INTEGER);
    const counted_quantity = integer(line.counted_quantity, 0, stockAdjustmentMaxCounted);
    const difference = signedInteger(line.difference, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    if (difference !== counted_quantity - expected_quantity) return invalidResponse();
    total += difference;
    return Object.freeze({ variant_id, expected_quantity, counted_quantity, difference });
  });
  // The total is the exact signed sum of the listed lines, never an independent figure.
  if (Math.abs(total) > stockAdjustmentMaxTotal) return invalidResponse();
  return Object.freeze(lines);
}

function parseDocumentRecord(raw: string, counter: boolean): StockAdjustmentRecord {
  const record = fields(decode(raw), ['id', 'location_id', 'reason', 'detail', 'created_by_account_id',
    'created_at', 'reverses_adjustment_id', 'lines', 'total_difference']);
  const id = integer(record.id, 1, Number.MAX_SAFE_INTEGER);
  if (integer(record.location_id, 1, 32767) !== stockAdjustmentLocationID) return invalidResponse();
  const reverses_adjustment_id = reference(record.reverses_adjustment_id, id, false);
  // A created document is an original; a counter-entry always states its target.
  if ((reverses_adjustment_id === null) === counter) return invalidResponse();
  const lines = parseDocumentLines(record.lines);
  const total_difference = signedInteger(record.total_difference, -stockAdjustmentMaxTotal, stockAdjustmentMaxTotal);
  if (lines.reduce((sum, line) => sum + line.difference, 0) !== total_difference) return invalidResponse();
  return Object.freeze({ id, location_id: stockAdjustmentLocationID, reason: reason(record.reason),
    detail: detailText(record.detail), created_by_account_id: integer(record.created_by_account_id, 1, Number.MAX_SAFE_INTEGER),
    created_at: timestamp(record.created_at), reverses_adjustment_id,
    lines, total_difference });
}

/** Parses the reply of an applied adjustment: an original document with its own arithmetic. */
export function parseStockAdjustmentRecord(raw: string): StockAdjustmentRecord {
  return parseDocumentRecord(raw, false);
}

/** Parses the reply of a counter-entry: a document that states the one it corrects. */
export function parseStockAdjustmentReversalRecord(raw: string): StockAdjustmentRecord {
  return parseDocumentRecord(raw, true);
}

/** Only the frozen page and page sizes are ever requested. */
export function validStockAdjustmentHistoryQuery(page: number, pageSize: number): boolean {
  return Number.isInteger(page) && page >= 1 && page <= stockAdjustmentMaxPage
    && Number.isInteger(pageSize) && stockAdjustmentPageSizes.includes(pageSize);
}

export function stockAdjustmentHistoryPath(page: number, pageSize: number): string {
  return `/api/stock-adjustments?page=${page}&page_size=${pageSize}`;
}

/**
 * The capture catalogue is a separate, quantity-free projection, so the capture
 * never reuses the inventory read: that payload includes the expected balance.
 * An empty search is omitted entirely because the contract refuses empty values.
 */
export function stockAdjustmentCatalogPath(search: string): string {
  if (!validSearch(search)) return invalidInput();
  const params = new URLSearchParams({ page: '1', page_size: String(stockAdjustmentCatalogPageSize) });
  if (search !== '') params.set('search', search);
  return '/api/stock-adjustments/catalog?' + params.toString();
}

/** The frozen detail path; only a canonical positive document id is admitted. */
export function stockAdjustmentDetailPath(id: number): string {
  if (!Number.isSafeInteger(id) || id < 1) return invalidDetail();
  return `/api/stock-adjustments/${id}`;
}

/** The frozen counter-entry path: the decimal id of the original document. */
export function stockAdjustmentReversalPath(id: number): string {
  if (!Number.isSafeInteger(id) || id < 1) return invalidReversal();
  return `/api/stock-adjustments/${id}/reverse`;
}

/**
 * Parses one history page strictly: exact keys, lossless numbers, newest-first rows
 * whose references point inside the ledger. A page beyond the last one is
 * legitimately empty; a page with rows must still fit inside the reported total.
 */
export function parseStockAdjustmentHistory(raw: string): StockAdjustmentPage {
  const record = fields(decode(raw), ['page', 'page_size', 'total_adjustments', 'adjustments']);
  const page = integer(record.page, 1, stockAdjustmentMaxPage);
  const page_size = integer(record.page_size, 10, 50);
  if (!stockAdjustmentPageSizes.includes(page_size)) return invalidResponse();
  const total_adjustments = integer(record.total_adjustments, 0, Number.MAX_SAFE_INTEGER);
  if (!Array.isArray(record.adjustments) || record.adjustments.length > page_size) return invalidResponse();
  if (record.adjustments.length > 0 && (page - 1) * page_size + record.adjustments.length > total_adjustments) return invalidResponse();
  let previous = Number.POSITIVE_INFINITY;
  const adjustments = record.adjustments.map(value => {
    const row = fields(value, ['id', 'reason', 'detail', 'created_at', 'lines', 'total_difference',
      'reverses_adjustment_id', 'reversed_by']);
    const id = integer(row.id, 1, Number.MAX_SAFE_INTEGER);
    if (id >= previous) return invalidResponse();
    previous = id;
    return Object.freeze({ id, reason: reason(row.reason), detail: detailText(row.detail),
      created_at: timestamp(row.created_at), lines: integer(row.lines, 1, stockAdjustmentMaxLines),
      total_difference: signedInteger(row.total_difference, -stockAdjustmentMaxTotal, stockAdjustmentMaxTotal),
      reverses_adjustment_id: reference(row.reverses_adjustment_id, id, false),
      reversed_by: reference(row.reversed_by, id, true) });
  });
  return Object.freeze({ page, page_size, total_adjustments, adjustments: Object.freeze(adjustments) });
}

/**
 * Parses one document detail strictly: the catalogue identity of every line, the
 * expected snapshot, the counted quantity and the derived difference, plus both
 * directions of the reversal cross-reference.
 */
export function parseStockAdjustmentDetail(raw: string): StockAdjustmentDetail {
  const record = fields(decode(raw), ['id', 'location_id', 'reason', 'detail', 'created_at',
    'created_by_account_id', 'reverses_adjustment_id', 'reversed_by', 'lines', 'total_difference']);
  const id = integer(record.id, 1, Number.MAX_SAFE_INTEGER);
  if (integer(record.location_id, 1, 32767) !== stockAdjustmentLocationID) return invalidResponse();
  if (!Array.isArray(record.lines) || record.lines.length < 1 || record.lines.length > stockAdjustmentMaxLines) return invalidResponse();
  let previous = 0;
  let total = 0;
  const lines = record.lines.map(value => {
    const line = fields(value, ['variant_id', 'catalog_entry_id', 'brand', 'model', 'capacity_ah',
      'polarity', 'expected_quantity', 'counted_quantity', 'difference']);
    const variant_id = integer(line.variant_id, 1, stockAdjustmentMaxVariantID);
    if (variant_id <= previous) return invalidResponse();
    previous = variant_id;
    if (line.polarity !== 'L' && line.polarity !== 'R') return invalidResponse();
    const expected_quantity = integer(line.expected_quantity, 0, Number.MAX_SAFE_INTEGER);
    const counted_quantity = integer(line.counted_quantity, 0, stockAdjustmentMaxCounted);
    const difference = signedInteger(line.difference, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    if (difference !== counted_quantity - expected_quantity) return invalidResponse();
    total += difference;
    return Object.freeze({ variant_id, catalog_entry_id: integer(line.catalog_entry_id, 1, Number.MAX_SAFE_INTEGER),
      brand: text(line.brand), model: text(line.model), capacity_ah: capacity(line.capacity_ah),
      polarity: line.polarity, expected_quantity, counted_quantity, difference });
  });
  const total_difference = signedInteger(record.total_difference, -stockAdjustmentMaxTotal, stockAdjustmentMaxTotal);
  if (total !== total_difference) return invalidResponse();
  return Object.freeze({ id, location_id: stockAdjustmentLocationID, reason: reason(record.reason),
    detail: detailText(record.detail), created_at: timestamp(record.created_at),
    created_by_account_id: integer(record.created_by_account_id, 1, Number.MAX_SAFE_INTEGER),
    reverses_adjustment_id: reference(record.reverses_adjustment_id, id, false),
    reversed_by: reference(record.reversed_by, id, true),
    lines: Object.freeze(lines), total_difference });
}

/** Parses the blind capture catalogue: identity only, never a stock field. */
export function parseStockAdjustmentCatalog(raw: string): StockAdjustmentCatalogPage {
  const record = fields(decode(raw), ['page', 'page_size', 'total_variants', 'items']);
  const page = integer(record.page, 1, stockAdjustmentMaxPage);
  const page_size = integer(record.page_size, 10, 50);
  if (!stockAdjustmentPageSizes.includes(page_size)) return invalidResponse();
  const total_variants = integer(record.total_variants, 0, Number.MAX_SAFE_INTEGER);
  if (!Array.isArray(record.items) || record.items.length > page_size) return invalidResponse();
  if (record.items.length > 0 && (page - 1) * page_size + record.items.length > total_variants) return invalidResponse();
  let previous = 0;
  const items = record.items.map(value => {
    const item = fields(value, ['variant_id', 'catalog_entry_id', 'brand', 'model', 'capacity_ah', 'polarity']);
    const variant_id = integer(item.variant_id, 1, stockAdjustmentMaxVariantID);
    if (variant_id <= previous) return invalidResponse();
    previous = variant_id;
    if (item.polarity !== 'L' && item.polarity !== 'R') return invalidResponse();
    return Object.freeze({ variant_id, catalog_entry_id: integer(item.catalog_entry_id, 1, Number.MAX_SAFE_INTEGER),
      brand: text(item.brand), model: text(item.model), capacity_ah: capacity(item.capacity_ah), polarity: item.polarity });
  });
  return Object.freeze({ page, page_size, total_variants, items: Object.freeze(items) });
}

function admittedError<C extends string>(raw: string, status: number, table: ReadonlyMap<number, readonly C[]>): C {
  const admitted = table.get(status);
  if (!admitted) return invalidResponse();
  const envelope = fields(decode(raw), ['error']);
  const code = envelope.error;
  if (typeof code !== 'string' || !admitted.includes(code as C)) return invalidResponse();
  return code as C;
}

export function parseStockAdjustmentApplyError(raw: string, status: number): StockAdjustmentErrorCode {
  return admittedError(raw, status, stockAdjustmentApplyAdmittedErrors);
}
export function parseStockAdjustmentHistoryError(raw: string, status: number): StockAdjustmentErrorCode {
  return admittedError(raw, status, stockAdjustmentHistoryAdmittedErrors);
}
export function parseStockAdjustmentCatalogError(raw: string, status: number): StockAdjustmentErrorCode {
  return admittedError(raw, status, stockAdjustmentCatalogAdmittedErrors);
}
/** Only the detail route has a document id, so only it admits `not_found`. */
export function parseStockAdjustmentDetailError(raw: string, status: number): StockAdjustmentErrorCode {
  return admittedError(raw, status, stockAdjustmentDetailAdmittedErrors);
}
export function parseStockAdjustmentReversalError(raw: string, status: number): StockAdjustmentErrorCode {
  return admittedError(raw, status, stockAdjustmentReversalAdmittedErrors);
}

/** A definite rejection proves nothing was written; every other failure stays uncertain. */
export function stockAdjustmentFailureIsDefinite(code: StockAdjustmentErrorCode): boolean {
  return code === 'invalid_request' || code === 'unauthenticated' || code === 'forbidden'
    || code === 'not_found' || code === 'decision_conflict' || code === 'retry_conflict'
    || code === 'insufficient_stock';
}

/**
 * The reply is evidence only if it repeats the exact document this capture sent:
 * the same motive and the same counted quantities, as an original document.
 */
export function matchesStockAdjustmentInput(input: StockAdjustmentInput, record: StockAdjustmentRecord): boolean {
  let expected: StockAdjustmentInput;
  try { expected = canonicalStockAdjustmentInput(input); } catch { return false; }
  if (record.location_id !== stockAdjustmentLocationID || record.reverses_adjustment_id !== null) return false;
  if (record.reason !== expected.reason) return false;
  if (record.lines.length !== expected.lines.length) return false;
  const lines = [...record.lines].sort((left, right) => left.variant_id - right.variant_id);
  return expected.lines.every((line, index) => lines[index].variant_id === line.variant_id
    && lines[index].counted_quantity === line.counted_quantity);
}

/**
 * A counter-entry is evidence only if it mirrors the listed document: the same
 * number of lines, the exact negated total and no detail of its own. The original
 * lines are never cached, so this is the only proof the client can demand.
 */
export function matchesStockAdjustmentReversal(row: StockAdjustmentSummary, record: StockAdjustmentRecord): boolean {
  if (record.location_id !== stockAdjustmentLocationID) return false;
  if (!stockAdjustmentReversible(row)) return false;
  if (record.reverses_adjustment_id !== row.id) return false;
  if (record.detail !== '' || record.lines.length !== row.lines) return false;
  return record.total_difference === -row.total_difference;
}

/** Only an applied original document may be corrected; a counter-entry never is. */
export function stockAdjustmentReversible(row: StockAdjustmentSummary): boolean {
  return row.reversed_by === null && row.reverses_adjustment_id === null;
}
