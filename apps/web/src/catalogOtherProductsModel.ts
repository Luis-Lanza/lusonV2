import { LosslessNumber, parse as parseJSON } from 'lossless-json';
import { catalogPricesMaxPage, catalogPricesPageSizes } from './catalogPricesModel';

// The other products of the warehouse catalogue: a free-form name and the custom
// fields the operator assigns to that product, one product per record. The kind
// discriminator lives on the server (a battery or an other product), so this
// contract never mentions a battery and never asks for a price or a stock figure.
//
// Numbers travel as canonical decimal text, exactly like capacity_ah does: the
// payload carries a string, the record echoes the same string, and no binary float
// ever touches a field value.

/** The two kinds a custom field can be: a number, or free text. */
export type CatalogOtherFieldKind = 'number' | 'text';
/**
 * One field as the form holds it, before validation: every box is a string and the
 * kind decides which of them travels. The server is the authority, never this form.
 */
export interface CatalogOtherFieldDraft {
  readonly name: string; readonly kind: string;
  readonly unit?: string; readonly number?: string; readonly text?: string;
}
/** The drafted product of the create form, or the complete identity of an edit. */
export interface CatalogOtherProductDraft {
  readonly name: string; readonly fields: readonly CatalogOtherFieldDraft[];
}
/**
 * One field of a write. A number field admits an optional unit; a text field admits
 * no unit at all, so the two shapes never mix in one payload.
 */
export type CatalogOtherFieldInput =
  | { readonly name: string; readonly kind: 'number'; readonly number: string; readonly unit?: string }
  | { readonly name: string; readonly kind: 'text'; readonly text: string };
/** The exact body of a `POST` and of a `PATCH`: the name and the whole field set. */
export interface CatalogOtherProductInput {
  readonly name: string; readonly fields: readonly CatalogOtherFieldInput[];
}
/** One persisted field, as the server echoes it: the number keeps its text. */
export type CatalogOtherFieldRecord =
  | { readonly name: string; readonly kind: 'number'; readonly number: string; readonly unit: string | null }
  | { readonly name: string; readonly kind: 'text'; readonly text: string };
/** One created or edited product, field by field as the server returned it. */
export interface CatalogOtherProductRecord {
  readonly id: number; readonly name: string; readonly fields: readonly CatalogOtherFieldRecord[];
}
/** One page of the active catalogue: its products and the bookkeeping of the query. */
export interface CatalogOtherProductPage {
  readonly rows: readonly CatalogOtherProductRecord[];
  readonly page: number; readonly page_size: number; readonly total_products: number;
}
/** The frozen read query: every filter of the contract is always present. */
export interface CatalogOtherProductsQuery {
  readonly search: string; readonly page: number; readonly page_size: number;
}
export type CatalogOtherProductValidation<T> =
  | { readonly valid: true; readonly input: T }
  | { readonly valid: false; readonly message: string };

/** Every code this contract can answer with, including the transport ones. */
export type CatalogOtherProductsErrorCode = 'invalid_request' | 'unauthenticated' | 'forbidden' | 'not_found'
  | 'conflict' | 'catalog_product_has_stock' | 'catalog_product_has_pending' | 'service_unavailable'
  | 'invalid_response' | 'network' | 'aborted';

export const catalogOtherProductsMaxID = 2_147_483_647;
/** At most twenty custom fields per product, as the server enforces. */
export const catalogOtherProductsMaxFields = 20;
/** A product name is 3-64 bytes of trimmed UTF-8, unique among the active products. */
export const catalogOtherProductsMinNameBytes = 3;
export const catalogOtherProductsMaxNameBytes = 64;
/** A field name is 1-40 bytes inside its own product, unique ignoring case. */
export const catalogOtherProductsMaxFieldNameBytes = 40;
/** A unit is optional and never longer than eight bytes. */
export const catalogOtherProductsMaxUnitBytes = 8;
/** A text value is 1-200 bytes of valid UTF-8. */
export const catalogOtherProductsMaxTextBytes = 200;
/** The listing's search is free text bounded at 128 runes, as the server reads it. */
export const catalogOtherProductsMaxSearchRunes = 128;

export const catalogOtherProductsListUnavailable =
  'No se pudo consultar el catálogo de otros productos. Revisá la conexión e intentá de nuevo.';

/** Every refusal keeps its own words, never a generic failure. */
export const catalogOtherProductsErrorMessages: Record<CatalogOtherProductsErrorCode, string> = {
  invalid_request: 'El servidor rechazó los datos: revisá el nombre del producto y el de sus campos. No se guardó nada.',
  unauthenticated: 'La sesión no está activa. Volvé a iniciar sesión: no se guardó nada.',
  forbidden: 'No tenés permiso para administrar otros productos del catálogo. No se guardó nada.',
  not_found: 'El producto ya no está en el catálogo activo. Actualizá la lista: no se guardó nada.',
  conflict: 'Ya existe un producto activo con ese nombre. Cambiá el nombre: no se guardó nada.',
  catalog_product_has_stock: 'El producto todavía tiene stock o unidades reservadas. Dejá sus existencias en cero antes de retirarlo: no se retiró.',
  catalog_product_has_pending: 'El producto tiene una transferencia pendiente. Resolvé esa operación antes de retirarlo: no se retiró.',
  service_unavailable: 'El servicio del catálogo no está disponible. Conservamos lo que escribiste para reintentar.',
  invalid_response: 'La respuesta del servidor no es válida. Conservamos lo que escribiste: no se guardó nada.',
  network: 'No se pudo conectar con el servidor. Conservamos lo que escribiste para reintentar.',
  aborted: 'La operación se interrumpió. Conservamos lo que escribiste para reintentar.',
};

/** The client-side mirror of the server rules, worded for the person filling the form. */
export const catalogOtherProductNameMessage =
  'Ingresá un nombre de producto de 3 a 64 bytes UTF-8. Se guarda sin espacios al principio ni al final.';
export const catalogOtherProductFieldsMessage =
  'Un producto admite hasta 20 campos, cada uno con su nombre, su tipo y su valor.';
export const catalogOtherProductFieldNameMessage =
  'El nombre de cada campo debe tener entre 1 y 40 bytes UTF-8. Se guarda sin espacios al principio ni al final.';
export const catalogOtherProductDuplicateFieldMessage =
  'Cada campo debe tener un nombre distinto dentro del producto, sin distinguir mayúsculas.';
export const catalogOtherProductNumberMessage =
  'Un campo numérico requiere un número de hasta 12 enteros y 6 decimales, positivo o negativo.';
export const catalogOtherProductUnitMessage =
  'La unidad es opcional: admite hasta 8 bytes UTF-8. Se guarda sin espacios al principio ni al final.';
export const catalogOtherProductTextMessage =
  'Un campo de texto requiere de 1 a 200 bytes UTF-8, sin caracteres de control.';

/** Admitted error envelope per HTTP status; nothing else may reach the UI. */
export const catalogOtherProductsAdmittedErrors: ReadonlyMap<number, readonly CatalogOtherProductsErrorCode[]> = new Map([
  [400, ['invalid_request']],
  [401, ['unauthenticated']],
  [403, ['forbidden']],
  [404, ['not_found']],
  [409, ['conflict', 'catalog_product_has_stock', 'catalog_product_has_pending']],
  [503, ['service_unavailable']],
]);

// Control characters never belong to a name, a field name or a unit.
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}
const encoder = new TextEncoder();

function invalidResponse(): never { throw new Error('Respuesta inválida del servidor.'); }
function invalidDraft(): never { throw new Error('Datos del producto inválidos.'); }

function decode(raw: string): unknown {
  try {
    return parseJSON(raw, null, { onDuplicateKey: () => { throw new Error('duplicate key'); } });
  } catch { return invalidResponse(); }
}
function shape(value: unknown, required: readonly string[], optional: readonly string[],
  invalid: () => never): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof LosslessNumber) return invalid();
  const record = value as Record<string, unknown>;
  const allowed = [...required, ...optional];
  if (Object.keys(record).some(key => !allowed.includes(key))) return invalid();
  if (required.some(key => !Object.hasOwn(record, key))) return invalid();
  return record;
}
const response = (value: unknown, required: readonly string[], optional: readonly string[] = []) =>
  shape(value, required, optional, invalidResponse);
const draft = (value: unknown, required: readonly string[], optional: readonly string[] = []) =>
  shape(value, required, optional, invalidDraft);
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

/** The byte length of a text, never its UTF-16 length. */
function bytes(value: string): number { return encoder.encode(value).length; }

// The server trims a name, a field name and a unit before it persists them, so the
// canonical form is the trimmed one: a padded value is admitted, never stored.
function boundedText(value: unknown, min: number, max: number): string {
  if (typeof value !== 'string' || !value.isWellFormed()) return invalidDraft();
  const text = value.trim();
  const size = bytes(text);
  if (size < min || size > max || hasControlCharacter(text)) return invalidDraft();
  return text;
}
/** The canonical product name: trimmed, control-free UTF-8 of 3-64 bytes. */
function canonicalName(value: unknown): string {
  return boundedText(value, catalogOtherProductsMinNameBytes, catalogOtherProductsMaxNameBytes);
}
/** The canonical field name: trimmed, control-free UTF-8 of 1-40 bytes. */
function canonicalFieldName(value: unknown): string {
  return boundedText(value, 1, catalogOtherProductsMaxFieldNameBytes);
}
/** The canonical unit: trimmed, control-free UTF-8 of 1-8 bytes. */
function canonicalUnit(value: unknown): string {
  return boundedText(value, 1, catalogOtherProductsMaxUnitBytes);
}
/** Whether a value can be canonicalized, without decoding it. */
function admittable(load: () => unknown): boolean {
  try { load(); return true; } catch { return false; }
}
/**
 * A persisted name is the canonical text the catalog holds: a padded or
 * control-bearing spelling is a shape this contract never writes, so it never
 * decodes as evidence either. The uniqueness among the active products is the
 * server's rule: this only mirrors its shape.
 */
export function validCatalogOtherProductName(value: unknown): boolean {
  return typeof value === 'string' && admittable(() => canonicalName(value)) && value.trim() === value;
}
/** A persisted field name is the trimmed, control-free UTF-8 of 1-40 bytes. */
export function validCatalogOtherFieldName(value: unknown): boolean {
  return typeof value === 'string' && admittable(() => canonicalFieldName(value)) && value.trim() === value;
}
/** A persisted unit is optional, but when present it is trimmed, control-free and 1-8 bytes. */
function validCatalogOtherUnit(value: unknown): boolean {
  return typeof value === 'string' && admittable(() => canonicalUnit(value)) && value.trim() === value;
}
/**
 * A text value is 1-200 bytes of valid UTF-8 without a control character. Spaces
 * around it are the operator's text and are preserved, exactly as written.
 */
export function validCatalogOtherText(value: unknown): boolean {
  if (typeof value !== 'string' || !value.isWellFormed() || hasControlCharacter(value)) return false;
  const size = bytes(value);
  return size >= 1 && size <= catalogOtherProductsMaxTextBytes;
}

/**
 * The canonical decimal text the database persists for a numeric field: at most
 * twelve integral and six fractional digits, without leading zeros and without a
 * trailing zero in the fraction. This is the server's own normalization, applied to
 * what was typed, so `005.50` travels as `5.5`.
 */
export function canonicalCatalogOtherNumber(value: unknown): string {
  if (typeof value !== 'string' || !/^-?\d{1,18}(\.\d{1,6})?$/.test(value)) return invalidDraft();
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const integral = whole.replace(/^0+/, '') || '0';
  if (integral.length > 12) return invalidDraft();
  const decimals = fraction.replace(/0+$/, '');
  // A negative zero is not a value: it is a spelling the server never persists.
  if (integral === '0' && decimals === '') return negative ? invalidDraft() : '0';
  const canonical = decimals === '' ? integral : `${integral}.${decimals}`;
  return negative ? `-${canonical}` : canonical;
}
// A persisted number is already the canonical text this contract writes.
function recordNumber(value: unknown): string {
  if (typeof value !== 'string') return invalidResponse();
  let canonical: string;
  try { canonical = canonicalCatalogOtherNumber(value); } catch { return invalidResponse(); }
  return canonical === value ? value : invalidResponse();
}
// A persisted name is the bounded text this contract wrote, echoed back unchanged.
function recordName(value: unknown): string {
  return validCatalogOtherProductName(value) ? value as string : invalidResponse();
}
function recordUnit(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return validCatalogOtherUnit(value) ? value as string : invalidResponse();
}

/** One persisted field: exact keys, canonical number text, its unit when it has one. */
function decodeField(value: unknown): CatalogOtherFieldRecord {
  // `unit` and `text` are optional so a number without unit and a text field both fit.
  const field = response(value, ['name', 'kind'], ['unit', 'number', 'text']);
  const name = validCatalogOtherFieldName(field.name) ? field.name as string : invalidResponse();
  if (field.kind === 'number') {
    if (!Object.hasOwn(field, 'number') || Object.hasOwn(field, 'text')) return invalidResponse();
    return Object.freeze({ name, kind: 'number', number: recordNumber(field.number), unit: recordUnit(field.unit) });
  }
  if (field.kind === 'text') {
    // A text field admits no unit and no number at all.
    if (Object.hasOwn(field, 'number') || (Object.hasOwn(field, 'unit') && field.unit !== null)) return invalidResponse();
    if (!validCatalogOtherText(field.text)) return invalidResponse();
    return Object.freeze({ name, kind: 'text', text: field.text as string });
  }
  return invalidResponse();
}

function decodeRecord(value: unknown): CatalogOtherProductRecord {
  const record = response(value, ['id', 'name', 'fields']);
  const id = integer(record.id, 1, catalogOtherProductsMaxID);
  const name = recordName(record.name);
  if (!Array.isArray(record.fields) || record.fields.length > catalogOtherProductsMaxFields) return invalidResponse();
  const seen = new Set<string>();
  const fields = record.fields.map(entry => {
    const field = decodeField(entry);
    const key = field.name.toLowerCase();
    // Two fields with the same name inside one product are not a shape this contract writes.
    if (seen.has(key)) return invalidResponse();
    seen.add(key);
    return field;
  });
  return Object.freeze({ id, name, fields: Object.freeze(fields) });
}

/** Parses one created or edited product: exact keys, allocated id, typed fields. */
export function parseCatalogOtherProduct(raw: string): CatalogOtherProductRecord {
  return decodeRecord(decode(raw));
}

/**
 * Parses one page strictly: exact keys, the bookkeeping of the query and unique ids.
 * A page that announces fewer products than it lists is not a page this server wrote.
 */
export function parseCatalogOtherProductPage(raw: string): CatalogOtherProductPage {
  const record = response(decode(raw), ['products', 'page', 'page_size', 'total_products']);
  const page = integer(record.page, 1, catalogPricesMaxPage);
  const page_size = integer(record.page_size, 10, 50);
  if (!catalogPricesPageSizes.includes(page_size)) return invalidResponse();
  const total_products = integer(record.total_products, 0, Number.MAX_SAFE_INTEGER);
  if (!Array.isArray(record.products) || record.products.length > page_size) return invalidResponse();
  if (record.products.length > 0 && (page - 1) * page_size + record.products.length > total_products) {
    return invalidResponse();
  }
  const ids = new Set<number>();
  const rows = record.products.map(value => {
    const row = decodeRecord(value);
    if (ids.has(row.id)) return invalidResponse();
    ids.add(row.id);
    return row;
  });
  return Object.freeze({ rows: Object.freeze(rows), page, page_size, total_products });
}

export function validCatalogOtherProductsQuery(query: CatalogOtherProductsQuery): boolean {
  // The search bound is the server's own: valid UTF-8, no NUL and at most 128 runes.
  if (typeof query.search !== 'string' || !query.search.isWellFormed() || query.search.includes('\0')) return false;
  if ([...query.search].length > catalogOtherProductsMaxSearchRunes) return false;
  return Number.isInteger(query.page) && query.page >= 1 && query.page <= catalogPricesMaxPage
    && Number.isInteger(query.page_size) && catalogPricesPageSizes.includes(query.page_size);
}

/**
 * The frozen read path: the page and the page size always travel, and a search the
 * operator left blank is absent from the query instead of sent empty.
 */
export function catalogOtherProductsPath(query: CatalogOtherProductsQuery): string {
  if (!validCatalogOtherProductsQuery(query)) return invalidResponse();
  const params = new URLSearchParams();
  if (query.search !== '') params.set('search', query.search);
  params.set('page', String(query.page));
  params.set('page_size', String(query.page_size));
  return '/api/catalog/other-products?' + params.toString();
}

/**
 * Admits one write and freezes the exact body of both `POST` and `PATCH`: the name
 * and the whole field set, with canonical numbers and the unit only when written.
 * Any other key is refused, so no identifier and no battery term can travel.
 */
export function canonicalCatalogOtherProduct(input: CatalogOtherProductDraft): CatalogOtherProductInput {
  // The server trims the name and every field name and unit before persisting them,
  // so the payload carries the trimmed form the record will echo back.
  const record = draft(input, ['name', 'fields']);
  const name = canonicalName(record.name);
  const list = record.fields;
  if (!Array.isArray(list) || list.length > catalogOtherProductsMaxFields) return invalidDraft();
  const seen = new Set<string>();
  const fields = list.map(entry => {
    // `unit` and `text` are optional so a number without unit and a text field both fit.
    const field = draft(entry, ['name', 'kind'], ['unit', 'number', 'text']);
    const fieldName = canonicalFieldName(field.name);
    const key = fieldName.toLowerCase();
    if (seen.has(key)) return invalidDraft();
    seen.add(key);
    if (field.kind === 'number') {
      const number = canonicalCatalogOtherNumber(field.number);
      // An empty unit is no unit: the key is absent from the payload, never null.
      if (field.unit === undefined || field.unit === null || field.unit === '') {
        return Object.freeze({ name: fieldName, kind: 'number' as const, number });
      }
      return Object.freeze({ name: fieldName, kind: 'number' as const, number, unit: canonicalUnit(field.unit) });
    }
    if (field.kind === 'text') {
      if (!validCatalogOtherText(field.text)) return invalidDraft();
      return Object.freeze({ name: fieldName, kind: 'text' as const, text: field.text as string });
    }
    return invalidDraft();
  });
  return Object.freeze({ name, fields: Object.freeze(fields) });
}

/** One drafted field: its own name, its type and the value that type requires. */
function fieldProblem(value: unknown, seen: Set<string>): string | null {
  let field: Record<string, unknown>;
  try { field = draft(value, ['name', 'kind'], ['unit', 'number', 'text']); } catch { return catalogOtherProductFieldsMessage; }
  if (!admittable(() => canonicalFieldName(field.name))) return catalogOtherProductFieldNameMessage;
  const key = (field.name as string).trim().toLowerCase();
  if (seen.has(key)) return catalogOtherProductDuplicateFieldMessage;
  seen.add(key);
  if (field.kind === 'number') {
    try { canonicalCatalogOtherNumber(field.number); } catch { return catalogOtherProductNumberMessage; }
    const unit = field.unit;
    if (typeof unit === 'string' && unit !== '' && !admittable(() => canonicalUnit(unit))) {
      return catalogOtherProductUnitMessage;
    }
    return null;
  }
  if (field.kind === 'text') return validCatalogOtherText(field.text) ? null : catalogOtherProductTextMessage;
  return catalogOtherProductFieldsMessage;
}

function draftProblem(input: CatalogOtherProductDraft): string | null {
  let record: Record<string, unknown>;
  try { record = draft(input, ['name', 'fields']); } catch { return catalogOtherProductFieldsMessage; }
  if (!admittable(() => canonicalName(record.name))) return catalogOtherProductNameMessage;
  if (!Array.isArray(record.fields) || record.fields.length > catalogOtherProductsMaxFields) {
    return catalogOtherProductFieldsMessage;
  }
  const seen = new Set<string>();
  for (const entry of record.fields) {
    const problem = fieldProblem(entry, seen);
    if (problem !== null) return problem;
  }
  return null;
}

/** Validates one write and returns either the exact payload or the message to show. */
export function validateCatalogOtherProductDraft(
  input: CatalogOtherProductDraft,
): CatalogOtherProductValidation<CatalogOtherProductInput> {
  const problem = draftProblem(input);
  if (problem !== null) return { valid: false, message: problem };
  try { return { valid: true, input: canonicalCatalogOtherProduct(input) }; }
  catch { return { valid: false, message: catalogOtherProductFieldsMessage }; }
}

function sameField(written: CatalogOtherFieldInput, record: CatalogOtherFieldRecord): boolean {
  if (written.name !== record.name || written.kind !== record.kind) return false;
  if (written.kind === 'number' && record.kind === 'number') {
    return written.number === record.number && (written.unit ?? null) === (record.unit ?? null);
  }
  return written.kind === 'text' && record.kind === 'text' && written.text === record.text;
}

/**
 * The record is evidence only if it repeats the product this client wrote: the same
 * name and the same field set. The order the server lists the fields in carries no
 * meaning, so the comparison is made by field name.
 */
export function matchesCatalogOtherProduct(input: CatalogOtherProductDraft,
  record: CatalogOtherProductRecord): boolean {
  let expected: CatalogOtherProductInput;
  try { expected = canonicalCatalogOtherProduct(input); } catch { return false; }
  if (record.name !== expected.name || record.fields.length !== expected.fields.length) return false;
  const order = (left: { name: string }, right: { name: string }) => {
    const a = left.name.toLowerCase(); const b = right.name.toLowerCase();
    return a < b ? -1 : a > b ? 1 : 0;
  };
  const written = [...expected.fields].sort(order);
  const echoed = [...record.fields].sort(order);
  return written.every((field, index) => sameField(field, echoed[index]));
}

/** How the screen writes one field: a number with its unit, a text as it was written. */
export function catalogOtherFieldValue(field: CatalogOtherFieldRecord): string {
  if (field.kind === 'number') return field.unit === null ? field.number : `${field.number} ${field.unit}`;
  return field.text;
}
/** The whole field on one line: its name and the value it holds. */
export function catalogOtherFieldLabel(field: CatalogOtherFieldRecord): string {
  return `${field.name}: ${catalogOtherFieldValue(field)}`;
}
/** How many custom fields one product carries. */
export function catalogOtherFieldsCountLabel(fields: readonly CatalogOtherFieldRecord[]): string {
  if (fields.length === 0) return 'sin campos';
  return fields.length === 1 ? '1 campo' : `${fields.length} campos`;
}

/** The draft the editor writes for an existing product: its own name and field set. */
export function catalogOtherProductDraftOf(record: CatalogOtherProductRecord): CatalogOtherProductDraft {
  return {
    name: record.name,
    fields: record.fields.map(field => field.kind === 'number'
      ? { name: field.name, kind: 'number', unit: field.unit ?? '', number: field.number, text: '' }
      : { name: field.name, kind: 'text', unit: '', number: '', text: field.text }),
  };
}

/** One rejected write: only the house envelope, and only for the admitted status. */
export function parseCatalogOtherProductsError(raw: string, status: number): CatalogOtherProductsErrorCode {
  const admitted = catalogOtherProductsAdmittedErrors.get(status);
  if (!admitted) return invalidResponse();
  const envelope = response(decode(raw), ['error']);
  const code = envelope.error;
  if (typeof code !== 'string' || !admitted.includes(code as CatalogOtherProductsErrorCode)) return invalidResponse();
  return code as CatalogOtherProductsErrorCode;
}
