import { LosslessNumber, parse as parseJSON } from 'lossless-json';
import { parseInventory, parseVariantIdentity, queryURL, validSearch } from './model';
import type { Item, Kind, VariantIdentity } from './model';
import { newTransferRetryKey } from './transferModel';

// Warehouse ingress contract: one document, applied atomically or not at all.
// A new document always names the supplier whose products it brings in: there is
// no ingress without a supplier and no "all products" document.
export interface StockEntryLineInput { readonly variant_id: number; readonly quantity: number }
export interface StockEntryInput {
  readonly operation_key: string; readonly supplier_id: number; readonly note?: string;
  readonly lines: readonly StockEntryLineInput[];
}
export interface StockEntryLine { readonly variant_id: number; readonly quantity: number }
/** The supplier a persisted document carries: its id and the name it had then. */
export interface StockSupplierRef { readonly id: number; readonly name: string }
export interface StockEntryRecord {
  readonly id: number; readonly location_id: number; readonly note: string;
  readonly created_by_account_id: number; readonly created_at: string;
  readonly supplier: StockSupplierRef;
  readonly lines: readonly StockEntryLine[]; readonly total_units: number;
}
export type StockEntryErrorCode = 'invalid_request' | 'forbidden' | 'retry_conflict' | 'decision_conflict'
  | 'insufficient_stock' | 'service_unavailable' | 'invalid_response' | 'network' | 'aborted';

/** One counter-entry request: the target is in the path, the reason is mandatory. */
export interface StockEntryReversalInput { readonly operation_key: string; readonly reason: string }
export type StockEntryReversalErrorCode = 'invalid_request' | 'unauthenticated' | 'forbidden' | 'not_found'
  | 'decision_conflict' | 'retry_conflict' | 'insufficient_stock' | 'service_unavailable'
  | 'invalid_response' | 'network' | 'aborted';

/** One row of the read-only history: a document summary, never its lines. */
export interface StockEntryHistoryRow {
  readonly id: number; readonly note: string; readonly created_at: string;
  readonly supplier: StockSupplierRef | null;
  readonly lines: number; readonly total_units: number; readonly reversed_by: number | null;
}
/**
 * One persisted line of a document detail: the catalogue identity of the variant
 * of its own kind plus the signed quantity of that document. A battery line keeps
 * its battery attributes, a product line its typed fields, so a document never
 * invents the attribute a row does not have.
 */
export interface StockEntryDetailLine extends VariantIdentity { readonly quantity: number }
/**
 * The full persisted document behind one history row: its header, the exact units
 * that entered and the two directions of the reversal cross-reference.
 */
export interface StockEntryDetail {
  readonly id: number; readonly location_id: number; readonly note: string;
  readonly created_at: string; readonly created_by_account_id: number;
  readonly reverses_entry_id: number | null; readonly reversed_by: number | null;
  readonly reason: string; readonly supplier: StockSupplierRef | null;
  readonly lines: readonly StockEntryDetailLine[]; readonly total_units: number;
}
/** The supplier reads of the ingress screen: the list and the catalogue of one supplier. */
export type StockEntrySupplierErrorCode = 'invalid_request' | 'unauthenticated' | 'forbidden'
  | 'service_unavailable' | 'invalid_response' | 'network' | 'aborted';
/** One supplier as the screen chooses it; only an active one is selectable. */
export interface SupplierChoice {
  readonly id: number; readonly name: string; readonly contact: string;
  readonly retired: boolean; readonly kinds: readonly Kind[]; readonly offers: number;
}
export interface SupplierListPage {
  readonly page: number; readonly page_size: number; readonly total_suppliers: number;
  readonly suppliers: readonly SupplierChoice[];
}
/**
 * One row of the catalogue of a supplier: the variant identity the warehouse
 * already reads, plus the catalogue entry it belongs to and no stock numbers.
 */
export interface SupplierCatalogRow extends VariantIdentity { readonly catalog_entry_id: number }
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
/** The two kinds a document can be, in the order the screen offers them. */
export const stockEntryKinds: readonly Kind[] = ['battery', 'other'];
export const stockEntryKindLabels: Record<Kind, string> = { battery: 'Baterías', other: 'Otros productos' };
export const stockEntryKindDescriptions: Record<Kind, string> = {
  battery: 'Con marca, modelo, capacidad y polaridad.',
  other: 'Del catálogo libre: nombre y sus campos propios.',
};
export const stockCatalogPageSize = 50;
/** One page of suppliers is all the picker asks for, and it asks for the maximum. */
export const stockSupplierPageSize = 50;
/**
 * The catalogue of one supplier is a single server-capped page, never paged here.
 * The bound is the page size the server publishes (500 variants: 200 assignable
 * entries at most two polarities each), never a smaller local guess: a decoder
 * stricter than that reply refuses the whole picker.
 */
export const stockSupplierMaxCatalogPageSize = 500;
export const stockSupplierMaxID = 2_147_483_647;
export const stockSupplierMaxName = 64;
export const stockSupplierMaxContact = 200;
export const stockSupplierMaxOffers = 1_000_000;
/** A supplier without assigned products cannot receive an ingress, and says so. */
export const stockSupplierNoOffers =
  'Este proveedor no tiene productos asignados. Asigná sus productos en Catálogo → Proveedores y volvé a intentar.';
/** A line the chosen supplier does not offer is refused before anything is sent. */
export const stockSupplierDraftNotOffered =
  'El documento tiene una línea que este proveedor no ofrece. Quitá esa línea o elegí otro proveedor: no se envió nada.';
/** Nothing is written before the supplier is chosen. */
export const stockSupplierRequired = 'Elegí el proveedor del ingreso antes de confirmar.';
export const stockEntryHistoryPageSizes: readonly number[] = [10, 25, 50];
export const stockEntryHistoryDefaultPageSize = 25;
export const stockEntryHistoryMaxPage = 1_000_000;
export const stockEntryHistoryUnavailable =
  'No se pudo consultar el historial de ingresos. Revisá la conexión e intentá de nuevo.';

/** Admitted error envelope per HTTP status; nothing else may reach the UI. */
export const stockEntryAdmittedErrors: ReadonlyMap<number, readonly StockEntryErrorCode[]> = new Map([
  [400, ['invalid_request']],
  [403, ['forbidden']],
  [409, ['decision_conflict', 'retry_conflict', 'insufficient_stock']],
  [503, ['service_unavailable']],
]);

/** The supplier reads are their own contract: identity, permission and service failures. */
export const stockSupplierAdmittedErrors: ReadonlyMap<number, readonly StockEntrySupplierErrorCode[]> = new Map([
  [400, ['invalid_request']],
  [401, ['unauthenticated']],
  [403, ['forbidden']],
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
  decision_conflict: 'El proveedor elegido ya no está disponible para ingresos. No se aplicó ningún cambio: elegí un proveedor activo y volvé a intentar.',
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
// The name a supplier is listed and persisted by: bounded, trimmed and free of
// control characters, exactly like the row the server composes.
function supplierName(value: unknown): string {
  if (typeof value !== 'string' || value.includes('\0') || !value.isWellFormed()) return invalidResponse();
  if (value.trim() !== value || value === '') return invalidResponse();
  if (Array.from(value).length > stockSupplierMaxName) return invalidResponse();
  return value;
}
function supplierContact(value: unknown): string {
  if (typeof value !== 'string' || value.includes('\0') || !value.isWellFormed()) return invalidResponse();
  if (Array.from(value).length > stockSupplierMaxContact) return invalidResponse();
  return value;
}
function supplierRef(value: unknown): StockSupplierRef {
  const record = fields(value, ['id', 'name']);
  return Object.freeze({ id: integer(record.id, 1, stockSupplierMaxID), name: supplierName(record.name) });
}
// The kinds a supplier offers, in the order the screen offers them, so the
// picker never depends on the wire order or on a repeated kind.
function supplierKinds(value: unknown): readonly Kind[] {
  if (!Array.isArray(value) || value.length > stockEntryKinds.length) return invalidResponse();
  if (value.some(kind => kind !== 'battery' && kind !== 'other')) return invalidResponse();
  if (new Set(value).size !== value.length) return invalidResponse();
  return Object.freeze(stockEntryKinds.filter(kind => value.includes(kind)));
}
function supplierChoice(value: unknown): SupplierChoice {
  const record = fields(value, ['id', 'name', 'contact', 'retired', 'kinds', 'offers']);
  if (typeof record.retired !== 'boolean') return invalidResponse();
  const kinds = supplierKinds(record.kinds);
  const offers = integer(record.offers, 0, stockSupplierMaxOffers);
  // An offer is always of some kind: a supplier with assigned products offers at
  // least one kind and a supplier without products offers none.
  if ((offers === 0) !== (kinds.length === 0)) return invalidResponse();
  return Object.freeze({ id: integer(record.id, 1, stockSupplierMaxID), name: supplierName(record.name),
    contact: supplierContact(record.contact), retired: record.retired, kinds, offers });
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
  const record = fields(input, ['operation_key', 'supplier_id', 'note', 'lines'], false);
  const operation_key = record.operation_key;
  if (typeof operation_key !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(operation_key)) return invalidResponse();
  // The supplier is part of the canonical payload: the same key with another
  // supplier is a different intent and the server answers retry_conflict.
  const supplier_id = typeof record.supplier_id === 'number' && Number.isInteger(record.supplier_id)
    && record.supplier_id >= 1 && record.supplier_id <= stockSupplierMaxID ? record.supplier_id : invalidResponse();
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
  return Object.freeze({ operation_key, supplier_id, ...(draftNote === '' ? {} : { note: draftNote }), lines: Object.freeze(lines) });
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
  const record = fields(decode(raw), ['id', 'location_id', 'note', 'created_by_account_id', 'created_at',
    'supplier', 'lines', 'total_units']);
  const id = integer(record.id, 1, Number.MAX_SAFE_INTEGER);
  const location_id = integer(record.location_id, 1, 32767);
  const created_by_account_id = integer(record.created_by_account_id, 1, Number.MAX_SAFE_INTEGER);
  const created_at = timestamp(record.created_at);
  // A counter-entry inherits the supplier of its original, so both directions of
  // the contract carry one and a document without a supplier is not one of these.
  const supplier = supplierRef(record.supplier);
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
  return Object.freeze({ id, location_id, note: documentNote, created_by_account_id, created_at, supplier,
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

/** The supplier reads admit their own codes and nothing else. */
export function parseStockSupplierError(raw: string, status: number): StockEntrySupplierErrorCode {
  return admittedError(raw, status, stockSupplierAdmittedErrors);
}

/** A definite rejection proves nothing was written; every other failure stays uncertain. */
export function stockEntryFailureIsDefinite(code: StockEntryErrorCode): boolean {
  return code === 'invalid_request' || code === 'forbidden' || code === 'retry_conflict'
    || code === 'decision_conflict' || code === 'insufficient_stock';
}

/** The response is evidence only if it repeats the exact payload this client sent. */
export function matchesStockEntryInput(input: StockEntryInput, record: StockEntryRecord): boolean {
  let expected: StockEntryInput;
  try { expected = canonicalStockEntryInput(input); } catch { return false; }
  if (record.location_id !== stockCatalogLocationID) return false;
  // The reply must name the supplier the payload named: a document of another
  // supplier is not evidence about this one.
  if (record.supplier.id !== expected.supplier_id) return false;
  if (record.lines.length !== expected.lines.length) return false;
  const total = expected.lines.reduce((sum, line) => sum + line.quantity, 0);
  if (record.total_units !== total) return false;
  if (record.lines.reduce((sum, line) => sum + line.quantity, 0) !== record.total_units) return false;
  const lines = [...record.lines].sort((left, right) => left.variant_id - right.variant_id);
  return expected.lines.every((line, index) => lines[index].variant_id === line.variant_id && lines[index].quantity === line.quantity);
}

/** Reuses the existing inventory read contract with the kind of the document. */
export function stockCatalogPath(search: string, kind: Kind): string {
  return queryURL({ location: stockCatalogLocationID, kind, search, brand: '', polarity: '', page: 1, size: stockCatalogPageSize });
}

/**
 * The supplier list the screen chooses from: the active ones first by name and
 * the retired ones last, marked. Only page and size are ever requested.
 */
export function validStockSupplierQuery(page: number, pageSize: number): boolean {
  return Number.isInteger(page) && page >= 1 && page <= stockEntryHistoryMaxPage
    && Number.isInteger(pageSize) && pageSize >= 1 && pageSize <= stockSupplierPageSize;
}

export function stockSupplierListPath(page: number, pageSize: number): string {
  if (!validStockSupplierQuery(page, pageSize)) return invalidResponse();
  return `/api/suppliers?page=${page}&page_size=${pageSize}`;
}

/**
 * Parses one page of suppliers strictly: exact keys, lossless numbers, unique
 * known ids, the two admitted kinds and the offer count that proves whether the
 * supplier can receive an ingress at all. Retired suppliers are listed last.
 */
export function parseSupplierList(raw: string): SupplierListPage {
  const record = fields(decode(raw), ['suppliers', 'page', 'page_size', 'total_suppliers']);
  const page = integer(record.page, 1, stockEntryHistoryMaxPage);
  const page_size = integer(record.page_size, 1, stockSupplierPageSize);
  const total_suppliers = integer(record.total_suppliers, 0, Number.MAX_SAFE_INTEGER);
  if (!Array.isArray(record.suppliers) || record.suppliers.length > page_size) return invalidResponse();
  if (record.suppliers.length > 0
    && (page - 1) * page_size + record.suppliers.length > total_suppliers) return invalidResponse();
  const suppliers = record.suppliers.map(supplierChoice);
  if (new Set(suppliers.map(choice => choice.id)).size !== suppliers.length) return invalidResponse();
  // The contract lists the retired suppliers last: an active one after a retired
  // one is a page this server never composed.
  const firstRetired = suppliers.findIndex(choice => choice.retired);
  if (firstRetired !== -1 && suppliers.slice(firstRetired).some(choice => !choice.retired)) return invalidResponse();
  return Object.freeze({ page, page_size, total_suppliers, suppliers: Object.freeze(suppliers) });
}

/** The frozen catalogue path of exactly one supplier, with its kind and search. */
export function supplierCatalogPath(supplierID: number, kind: Kind, search: string): string {
  if (!Number.isSafeInteger(supplierID) || supplierID < 1 || supplierID > stockSupplierMaxID) return invalidResponse();
  if (kind !== 'battery' && kind !== 'other') return invalidResponse();
  if (typeof search !== 'string' || !validSearch(search)) return invalidResponse();
  const params = new URLSearchParams({ kind });
  if (search !== '') params.set('search', search);
  return `/api/suppliers/${supplierID}/catalog?${params.toString()}`;
}

/**
 * Parses the catalogue of one supplier strictly: the typed identity of the
 * warehouse plus its catalogue entry, without stock numbers, and only rows of
 * the kind the document declares. This is the only catalogue an ingress names.
 */
export function parseSupplierCatalog(raw: string, kind: Kind): readonly SupplierCatalogRow[] {
  const record = fields(decode(raw), ['items', 'page_size']);
  const page_size = integer(record.page_size, 1, stockSupplierMaxCatalogPageSize);
  if (!Array.isArray(record.items) || record.items.length > page_size) return invalidResponse();
  const seen = new Set<number>();
  const items = record.items.map(value => {
    const item = fields(value, ['variant_id', 'catalog_entry_id', 'kind', 'name', 'detail', 'battery', 'fields']);
    const identity = parseVariantIdentity(item, ['catalog_entry_id']);
    if (identity.kind !== kind) return invalidResponse();
    if (seen.has(identity.variant_id)) return invalidResponse();
    seen.add(identity.variant_id);
    return Object.freeze({ ...identity, catalog_entry_id: integer(item.catalog_entry_id, 1, stockSupplierMaxID) });
  });
  return Object.freeze(items);
}

/** The exact variants a draft may name: only the ones this supplier offers. */
export function offeredStockEntryVariantIDs(items: readonly SupplierCatalogRow[]): ReadonlySet<number> {
  return new Set(items.map(item => item.variant_id));
}

/** The draft lines the chosen supplier does not offer, in document order. */
export function unofferedStockEntryVariantIDs(offered: ReadonlySet<number>,
  variantIDs: readonly number[]): readonly number[] {
  return variantIDs.filter(id => !offered.has(id));
}

// The picker answers the kind the document declares, so a row of the other kind
// is a reply this screen never asked for and never renders.
export function parseStockCatalog(raw: string, kind: Kind): readonly Item[] {
  const page = parseInventory(raw);
  if (page.location.id !== stockCatalogLocationID || page.page !== 1 || page.page_size !== stockCatalogPageSize) return invalidResponse();
  if (page.items.some(item => item.kind !== kind)) return invalidResponse();
  return Object.freeze(page.items.map(item => Object.freeze({ ...item })));
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
    const row = fields(value, ['id', 'note', 'created_at', 'supplier', 'lines', 'total_units', 'reversed_by']);
    const id = integer(row.id, 1, Number.MAX_SAFE_INTEGER);
    if (id >= previous) return invalidResponse();
    previous = id;
    // A historical document written before suppliers existed keeps a null
    // supplier: it is never invented and never hidden from the ledger.
    const supplier = row.supplier === null ? null : supplierRef(row.supplier);
    const lines = integer(row.lines, 1, stockEntryMaxLines);
    const total_units = signedInteger(row.total_units, -stockEntryMaxDocumentUnits, stockEntryMaxDocumentUnits);
    const reversed_by = row.reversed_by === null ? null : integer(row.reversed_by, 1, Number.MAX_SAFE_INTEGER);
    if (reversed_by !== null && reversed_by <= id) return invalidResponse();
    return Object.freeze({ id, note: note(row.note), created_at: timestamp(row.created_at), supplier,
      lines, total_units, reversed_by });
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
    'reverses_entry_id', 'reversed_by', 'reason', 'supplier', 'lines', 'total_units']);
  const id = integer(record.id, 1, Number.MAX_SAFE_INTEGER);
  if (integer(record.location_id, 1, 32767) !== stockCatalogLocationID) return invalidResponse();
  const created_by_account_id = integer(record.created_by_account_id, 1, Number.MAX_SAFE_INTEGER);
  const created_at = timestamp(record.created_at);
  // The counter-entry repeats the supplier of its original; a historical
  // document keeps a null supplier instead of an invented one.
  const supplier = record.supplier === null ? null : supplierRef(record.supplier);
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
    const line = fields(value, ['variant_id', 'kind', 'name', 'detail', 'battery', 'fields', 'quantity']);
    // The line is the shared identity of the inventory read plus its quantity, so
    // both reads accept and reject exactly the same identity.
    const identity = parseVariantIdentity(value, ['quantity']);
    if (identity.variant_id <= previous) return invalidResponse();
    previous = identity.variant_id;
    const quantity = counter
      ? signedInteger(line.quantity, -stockEntryMaxQuantity, -1)
      : integer(line.quantity, 1, stockEntryMaxQuantity);
    return Object.freeze({ ...identity, quantity });
  });
  const total_units = counter
    ? signedInteger(record.total_units, -stockEntryMaxDocumentUnits, -1)
    : integer(record.total_units, 1, stockEntryMaxDocumentUnits);
  // The total is the exact signed sum of the listed lines, never a rounded or
  // independently reported figure.
  if (lines.reduce((sum, line) => sum + line.quantity, 0) !== total_units) return invalidResponse();
  return Object.freeze({ id, location_id: stockCatalogLocationID, note: note(record.note), created_at,
    created_by_account_id, reverses_entry_id, reversed_by, reason, supplier,
    lines: Object.freeze(lines), total_units });
}

export function parseStockEntryDetailError(raw: string, status: number): StockEntryDetailErrorCode {
  return admittedError(raw, status, stockEntryDetailAdmittedErrors);
}
