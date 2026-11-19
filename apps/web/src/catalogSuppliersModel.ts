import { LosslessNumber, parse as parseJSON } from 'lossless-json';
import { catalogPricesMaxPage, catalogPricesPageSizes } from './catalogPricesModel';

// The suppliers of the warehouse: who brings the products the catalogue holds.
// A supplier never offers stock variants: it offers catalogue ENTRIES, so a
// battery is its brand and model and an other product is its name (S2). The
// assignment is the complete set the operator saved, never a partial merge, and
// removing an entry never erases a document that already named it.

/** The two kinds of catalogue entry a supplier can offer. */
export type SupplierKind = 'battery' | 'other';

/**
 * One assignable catalogue entry: the identity the contract writes and reads.
 * A battery carries its brand, model, capacity text and polarity; an other
 * product carries its name. The irrelevant keys are `null`, never mixed.
 */
export interface SupplierCatalogEntry {
  readonly catalog_entry_id: number; readonly kind: SupplierKind;
  readonly brand: string | null; readonly model: string | null;
  readonly capacity_ah: string | null; readonly polarity: 'L' | 'R' | null;
  readonly name: string | null;
}
/** One row of the supplier listing: its contact, what it offers and its state. */
export interface SupplierListRow {
  readonly id: number; readonly name: string; readonly contact: string;
  readonly retired: boolean; readonly kinds: readonly SupplierKind[]; readonly offers: number;
}
/** One page of the supplier listing: active first by name, retired marked at the end. */
export interface SupplierListPage {
  readonly rows: readonly SupplierListRow[];
  readonly page: number; readonly page_size: number; readonly total_suppliers: number;
}
/** The record a create or an edit returns: the identity the database assigned. */
export interface SupplierRecord { readonly id: number; readonly name: string; readonly contact: string }
/** One supplier with the complete set of entries it offers. */
export interface SupplierDetail {
  readonly id: number; readonly name: string; readonly contact: string; readonly retired: boolean;
  readonly offers: readonly SupplierCatalogEntry[]; readonly kinds: readonly SupplierKind[];
}
/** One page of the assignable entries, filtered by kind and search. */
export interface SupplierCatalogPage {
  readonly entries: readonly SupplierCatalogEntry[];
  readonly page_size: number; readonly total_entries: number;
}
/** The draft the form holds: both boxes are strings and both travel. */
export interface SupplierDraft { readonly name: string; readonly contact: string }
/** The exact body of a `POST` and of a `PATCH`: the trimmed name and the typed contact. */
export interface SupplierInput { readonly name: string; readonly contact: string }
/** The frozen listing query: the page and the page size always travel. */
export interface SupplierListQuery { readonly page: number; readonly page_size: number }
/** The frozen offer-catalogue query: the kind and the search are optional. */
export interface SupplierCatalogQuery {
  readonly kind: '' | SupplierKind; readonly search: string; readonly page_size: number;
}
export type SupplierValidation<T> =
  | { readonly valid: true; readonly input: T }
  | { readonly valid: false; readonly message: string };

/** Every code this contract can answer with, including the transport ones. */
export type SuppliersErrorCode = 'invalid_request' | 'unauthenticated' | 'forbidden' | 'not_found'
  | 'conflict' | 'service_unavailable' | 'invalid_response' | 'network' | 'aborted';

export const suppliersMaxID = 2_147_483_647;
/** A supplier name is 3-64 bytes of trimmed UTF-8, unique among the active suppliers. */
export const suppliersMinNameBytes = 3;
export const suppliersMaxNameBytes = 64;
/** The contact is free text of 0-200 characters, never a control character. */
export const suppliersMaxContactCharacters = 200;
/** The whole offer set of one supplier: the server admits at most 200 entries. */
export const suppliersMaxOffers = 200;
/** The assignable search is free text bounded at 128 runes, as the server reads it. */
export const suppliersMaxSearchRunes = 128;

export const suppliersListUnavailable =
  'No se pudo consultar el catálogo de proveedores. Revisá la conexión e intentá de nuevo.';
export const supplierOffersUnavailable =
  'No se pudieron leer los productos que ofrece el proveedor. Revisá la conexión e intentá de nuevo.';
export const supplierCatalogUnavailable =
  'No se pudo consultar el catálogo asignable. Revisá la conexión e intentá de nuevo.';

/** Every refusal keeps its own words, never a generic failure. */
export const suppliersErrorMessages: Record<SuppliersErrorCode, string> = {
  invalid_request: 'El servidor rechazó los datos del proveedor: revisá el nombre y el contacto. No se guardó nada.',
  unauthenticated: 'La sesión no está activa. Volvé a iniciar sesión: no se guardó nada.',
  forbidden: 'No tenés permiso para administrar proveedores. No se guardó nada.',
  not_found: 'El proveedor ya no existe en el almacén. Actualizá la lista: no se guardó nada.',
  conflict: 'El nombre ya pertenece a un proveedor activo, o el proveedor ya no se puede modificar. Revisá los datos: no se guardó nada.',
  service_unavailable: 'El servicio de proveedores no está disponible. Conservamos lo que escribiste para reintentar.',
  invalid_response: 'La respuesta del servidor no es válida. Conservamos lo que escribiste: no se guardó nada.',
  network: 'No se pudo conectar con el servidor. Conservamos lo que escribiste para reintentar.',
  aborted: 'La operación se interrumpió. Conservamos lo que escribiste para reintentar.',
};

/** The client-side mirror of the server rules, worded with the exact bound. */
export const supplierNameMessage =
  'Ingresá un nombre de proveedor de 3 a 64 bytes UTF-8, sin espacios al principio ni al final y sin caracteres de control.';
export const supplierContactMessage =
  'El contacto del proveedor admite hasta 200 caracteres, sin caracteres de control.';
export const supplierDraftMessage = 'Los datos del proveedor son su nombre y su contacto.';
export const supplierOffersMessage =
  'La asignación lleva hasta 200 entradas de catálogo válidas, cada una con su identificador.';

/** Admitted error envelope per HTTP status; nothing else may reach the UI. */
export const suppliersAdmittedErrors: ReadonlyMap<number, readonly SuppliersErrorCode[]> = new Map([
  [400, ['invalid_request']],
  [401, ['unauthenticated']],
  [403, ['forbidden']],
  [404, ['not_found']],
  [409, ['conflict']],
  [503, ['service_unavailable']],
]);

// Control characters never belong to a name or a contact.
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function invalidResponse(): never { throw new Error('Respuesta inválida del servidor.'); }
function invalidDraft(): never { throw new Error('Datos del proveedor inválidos.'); }
function invalidOffers(): never { throw new Error(supplierOffersMessage); }

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
const encoder = new TextEncoder();
function characters(value: string): number { return [...value].length; }
function bytes(value: string): number { return encoder.encode(value).length; }

// The server trims the name before it persists it, so the canonical form is the
// trimmed one: a padded name is admitted, never stored. Its bound is measured in
// bytes, the stricter of the column's two bounds.
function canonicalName(value: unknown): string {
  if (typeof value !== 'string' || !value.isWellFormed()) return invalidDraft();
  const text = value.trim();
  const size = bytes(text);
  if (size < suppliersMinNameBytes || size > suppliersMaxNameBytes || hasControlCharacter(text)) return invalidDraft();
  return text;
}
// The contact is free text: the server never trims it, so the canonical form is
// exactly what the operator typed, bounded at 200 characters.
function canonicalContact(value: unknown): string {
  if (typeof value !== 'string' || !value.isWellFormed()) return invalidDraft();
  if (characters(value) > suppliersMaxContactCharacters || hasControlCharacter(value)) return invalidDraft();
  return value;
}
/** Whether a value can be canonicalized, without decoding it. */
function admittable(load: () => unknown): boolean {
  try { load(); return true; } catch { return false; }
}
/**
 * A persisted name is the canonical text the warehouse holds: a padded or
 * control-bearing spelling is a shape this contract never writes.
 */
export function validSupplierName(value: unknown): boolean {
  return typeof value === 'string' && admittable(() => canonicalName(value)) && value.trim() === value;
}
/** A persisted contact is the control-free free text of 0-200 characters, as typed. */
export function validSupplierContact(value: unknown): boolean {
  return typeof value === 'string' && admittable(() => canonicalContact(value));
}
/** Whether an identifier can name a supplier or a catalogue entry. */
export function validSupplierID(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= suppliersMaxID;
}

/** One catalogue-identity text: a non-empty, well-formed brand, model or name. */
function requiredText(value: unknown): string {
  if (typeof value !== 'string' || value === '' || !value.isWellFormed() || value.includes('\0')) return invalidResponse();
  return value;
}
// Optional keys may be omitted or explicitly null: both spell "this kind has none".
function optionalText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return requiredText(value);
}
/**
 * A battery capacity as canonical decimal text: at most six integral and six
 * fractional digits, no leading zero and no trailing zero in the fraction. A
 * number the server already published as JSON is admitted too and kept as text.
 */
function capacityText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const raw = value instanceof LosslessNumber ? value.toString() : value;
  if (typeof raw !== 'string' || !/^(0|[1-9]\d{0,5})(\.\d{1,6})?$/.test(raw)
    || /\.\d*0$/.test(raw) || !/[1-9]/.test(raw)) return invalidResponse();
  return raw;
}

/** The kinds a supplier offers: unique and only the two the catalogue knows. */
function decodeKinds(value: unknown): readonly SupplierKind[] {
  if (!Array.isArray(value)) return invalidResponse();
  const kinds: SupplierKind[] = [];
  for (const entry of value) {
    if (entry !== 'battery' && entry !== 'other') return invalidResponse();
    if (kinds.includes(entry)) return invalidResponse();
    kinds.push(entry);
  }
  return Object.freeze(kinds);
}

/** One assignable entry: the kind decides which keys it carries. */
function decodeEntry(value: unknown): SupplierCatalogEntry {
  const record = response(value, ['catalog_entry_id', 'kind'],
    ['brand', 'model', 'capacity_ah', 'polarity', 'name']);
  const catalog_entry_id = integer(record.catalog_entry_id, 1, suppliersMaxID);
  if (record.kind === 'battery') {
    // A battery is its brand and model. Capacity and polarity belong to a variant, so
    // the entry may omit them; when a polarity travels it is one of the two values.
    if (!Object.hasOwn(record, 'brand') || !Object.hasOwn(record, 'model')) return invalidResponse();
    if (record.polarity != null && record.polarity !== 'L' && record.polarity !== 'R') return invalidResponse();
    return Object.freeze({ catalog_entry_id, kind: 'battery' as const,
      brand: requiredText(record.brand), model: requiredText(record.model),
      capacity_ah: capacityText(record.capacity_ah),
      polarity: record.polarity === 'L' || record.polarity === 'R' ? record.polarity : null,
      name: optionalText(record.name) });
  }
  if (record.kind === 'other') {
    // An other product is its name and carries no battery attribute at all.
    if (record.brand != null || record.model != null || record.capacity_ah != null || record.polarity != null) {
      return invalidResponse();
    }
    return Object.freeze({ catalog_entry_id, kind: 'other' as const, brand: null, model: null,
      capacity_ah: null, polarity: null, name: requiredText(record.name) });
  }
  return invalidResponse();
}

/** One listing row: its contact, the kinds it offers and how many entries that is. */
function decodeRow(value: unknown): SupplierListRow {
  const record = response(value, ['id', 'name', 'contact', 'retired', 'kinds', 'offers']);
  const id = integer(record.id, 1, suppliersMaxID);
  if (!validSupplierName(record.name)) return invalidResponse();
  if (!validSupplierContact(record.contact)) return invalidResponse();
  if (typeof record.retired !== 'boolean') return invalidResponse();
  return Object.freeze({ id, name: record.name as string, contact: record.contact as string,
    retired: record.retired, kinds: decodeKinds(record.kinds),
    offers: integer(record.offers, 0, Number.MAX_SAFE_INTEGER) });
}

/** One created or edited supplier: exact keys, allocated id, canonical text. */
export function parseSupplierRecord(raw: string): SupplierRecord {
  const record = response(decode(raw), ['id', 'name', 'contact']);
  if (!validSupplierName(record.name)) return invalidResponse();
  if (!validSupplierContact(record.contact)) return invalidResponse();
  return Object.freeze({ id: integer(record.id, 1, suppliersMaxID), name: record.name as string,
    contact: record.contact as string });
}

/**
 * One page strictly: exact keys, the bookkeeping of the query and unique ids. A
 * page that announces fewer suppliers than it lists is not a page this server wrote.
 */
export function parseSupplierListPage(raw: string): SupplierListPage {
  const record = response(decode(raw), ['suppliers', 'page', 'page_size', 'total_suppliers']);
  const page = integer(record.page, 1, catalogPricesMaxPage);
  const page_size = integer(record.page_size, 10, 50);
  if (!catalogPricesPageSizes.includes(page_size)) return invalidResponse();
  const total_suppliers = integer(record.total_suppliers, 0, Number.MAX_SAFE_INTEGER);
  if (!Array.isArray(record.suppliers) || record.suppliers.length > page_size) return invalidResponse();
  if (record.suppliers.length > 0 && (page - 1) * page_size + record.suppliers.length > total_suppliers) {
    return invalidResponse();
  }
  const ids = new Set<number>();
  const rows = record.suppliers.map(value => {
    const row = decodeRow(value);
    if (ids.has(row.id)) return invalidResponse();
    ids.add(row.id);
    return row;
  });
  return Object.freeze({ rows: Object.freeze(rows), page, page_size, total_suppliers });
}

/** One supplier with the whole set of entries it offers, read strictly. */
export function parseSupplierDetail(raw: string): SupplierDetail {
  const record = response(decode(raw), ['id', 'name', 'contact', 'retired', 'offers', 'kinds']);
  if (!validSupplierName(record.name)) return invalidResponse();
  if (!validSupplierContact(record.contact)) return invalidResponse();
  if (typeof record.retired !== 'boolean') return invalidResponse();
  if (!Array.isArray(record.offers)) return invalidResponse();
  const ids = new Set<number>();
  const offers = record.offers.map(value => {
    const entry = decodeEntry(value);
    if (ids.has(entry.catalog_entry_id)) return invalidResponse();
    ids.add(entry.catalog_entry_id);
    return entry;
  });
  return Object.freeze({ id: integer(record.id, 1, suppliersMaxID), name: record.name as string,
    contact: record.contact as string, retired: record.retired, offers: Object.freeze(offers),
    kinds: decodeKinds(record.kinds) });
}

/**
 * One page of assignable entries strictly: exact keys, an admitted page size and
 * the announced total. The listing has no page number, so it never returns more
 * entries than its own page size.
 */
export function parseSupplierCatalogPage(raw: string): SupplierCatalogPage {
  const record = response(decode(raw), ['entries', 'page_size', 'total_entries']);
  const page_size = integer(record.page_size, 10, 50);
  if (!catalogPricesPageSizes.includes(page_size)) return invalidResponse();
  const total_entries = integer(record.total_entries, 0, Number.MAX_SAFE_INTEGER);
  if (!Array.isArray(record.entries) || record.entries.length > page_size) return invalidResponse();
  if (record.entries.length > total_entries) return invalidResponse();
  const ids = new Set<number>();
  const entries = record.entries.map(value => {
    const entry = decodeEntry(value);
    if (ids.has(entry.catalog_entry_id)) return invalidResponse();
    ids.add(entry.catalog_entry_id);
    return entry;
  });
  return Object.freeze({ entries: Object.freeze(entries), page_size, total_entries });
}

export function validSupplierListQuery(query: SupplierListQuery): boolean {
  return Number.isInteger(query.page) && query.page >= 1 && query.page <= catalogPricesMaxPage
    && Number.isInteger(query.page_size) && catalogPricesPageSizes.includes(query.page_size);
}

/**
 * The frozen listing path: the page and the page size always travel. The supplier
 * listing has no search of its own; what is searched is the assignable catalogue.
 */
export function supplierListPath(query: SupplierListQuery): string {
  if (!validSupplierListQuery(query)) return invalidResponse();
  const params = new URLSearchParams();
  params.set('page', String(query.page));
  params.set('page_size', String(query.page_size));
  return '/api/suppliers?' + params.toString();
}

/** One supplier's path: the identifier is admitted before it is written. */
export function supplierPath(id: number): string {
  if (!validSupplierID(id)) return invalidResponse();
  return `/api/suppliers/${id}`;
}
/** The path that replaces the complete offer set of one supplier. */
export function supplierOffersPath(id: number): string {
  if (!validSupplierID(id)) return invalidResponse();
  return `/api/suppliers/${id}/offers`;
}

export function validSupplierCatalogQuery(query: SupplierCatalogQuery): boolean {
  if (query.kind !== '' && query.kind !== 'battery' && query.kind !== 'other') return false;
  // The search bound is the server's own: valid UTF-8, no NUL and at most 128 runes.
  if (typeof query.search !== 'string' || !query.search.isWellFormed() || query.search.includes('\0')) return false;
  if (characters(query.search) > suppliersMaxSearchRunes) return false;
  return Number.isInteger(query.page_size) && catalogPricesPageSizes.includes(query.page_size);
}

/**
 * The frozen assignable-catalogue path: the kind and the search are absent when
 * the operator left them empty, and the page size always travels.
 */
export function supplierCatalogPath(query: SupplierCatalogQuery): string {
  if (!validSupplierCatalogQuery(query)) return invalidResponse();
  const params = new URLSearchParams();
  if (query.kind !== '') params.set('kind', query.kind);
  if (query.search !== '') params.set('search', query.search);
  params.set('page_size', String(query.page_size));
  return '/api/suppliers/catalog?' + params.toString();
}

/**
 * Admits one write and freezes its exact body: the trimmed name and the contact as
 * it was typed.
 * other key is refused, so no identifier and no retirement state can travel.
 */
export function canonicalSupplierDraft(input: SupplierDraft): SupplierInput {
  const record = draft(input, ['name', 'contact']);
  return Object.freeze({ name: canonicalName(record.name), contact: canonicalContact(record.contact) });
}

function draftProblem(input: SupplierDraft): string | null {
  let record: Record<string, unknown>;
  try { record = draft(input, ['name', 'contact']); } catch { return supplierDraftMessage; }
  if (!admittable(() => canonicalName(record.name))) return supplierNameMessage;
  if (!admittable(() => canonicalContact(record.contact))) return supplierContactMessage;
  return null;
}

/** Validates one write and returns either the exact payload or the message to show. */
export function validateSupplierDraft(input: SupplierDraft): SupplierValidation<SupplierInput> {
  const problem = draftProblem(input);
  if (problem !== null) return { valid: false, message: problem };
  try { return { valid: true, input: canonicalSupplierDraft(input) }; }
  catch { return { valid: false, message: supplierDraftMessage }; }
}

/**
 * The exact body of the offer write: the complete set, de-duplicated and ordered,
 * so the same selection always travels as the same canonical list.
 */
export function canonicalSupplierOffers(ids: readonly number[]): readonly number[] {
  if (!Array.isArray(ids)) return invalidOffers();
  const seen = new Set<number>();
  for (const id of ids) {
    if (!validSupplierID(id)) return invalidOffers();
    seen.add(id);
  }
  if (seen.size > suppliersMaxOffers) return invalidOffers();
  return Object.freeze([...seen].sort((left, right) => left - right));
}

/**
 * The record is evidence only if it repeats the supplier this client wrote: the
 * same canonical name and the same canonical contact.
 */
export function matchesSupplierRecord(input: SupplierDraft, record: SupplierRecord): boolean {
  let expected: SupplierInput;
  try { expected = canonicalSupplierDraft(input); } catch { return false; }
  return validSupplierID(record.id) && record.name === expected.name && record.contact === expected.contact;
}

/**
 * The detail is evidence only if it repeats the exact set this client wrote: the
 * order the server lists the entries in carries no meaning.
 */
export function matchesSupplierOffers(ids: readonly number[], detail: SupplierDetail): boolean {
  let sent: readonly number[];
  try { sent = canonicalSupplierOffers(ids); } catch { return false; }
  const echoed = detail.offers.map(entry => entry.catalog_entry_id).sort((left, right) => left - right);
  return sent.length === echoed.length && sent.every((id, index) => id === echoed[index]);
}

/** The one line an assignable entry is called by: brand and model, or its name. */
export function supplierEntryLabel(entry: SupplierCatalogEntry): string {
  if (entry.kind === 'battery') return [entry.brand, entry.model].filter(part => part !== null).join(' ');
  return entry.name ?? '';
}
/** What tells one entry of the listing apart: its battery attributes or its kind. */
export function supplierEntryDetail(entry: SupplierCatalogEntry): string {
  if (entry.kind !== 'battery') return 'Otro producto';
  if (entry.capacity_ah === null) return 'Batería';
  return entry.polarity === null ? `${entry.capacity_ah} Ah` : `${entry.capacity_ah} Ah · ${entry.polarity === 'L' ? 'Izquierda [L]' : 'Derecha [R]'}`;
}
export function supplierKindLabel(kind: SupplierKind): string {
  return kind === 'battery' ? 'Baterías' : 'Otros productos';
}
/** Which kinds one supplier offers, in the words of the listing. */
export function supplierKindsLabel(kinds: readonly SupplierKind[]): string {
  if (kinds.length === 0) return 'Sin productos asignados';
  if (kinds.includes('battery') && kinds.includes('other')) return 'Baterías y otros productos';
  return kinds.includes('battery') ? 'Solo baterías' : 'Solo otros productos';
}
/** How many entries one supplier offers. */
export function supplierOffersLabel(count: number): string {
  if (count === 0) return 'sin productos';
  return count === 1 ? '1 producto' : `${count} productos`;
}
export function supplierStateLabel(retired: boolean): string {
  return retired ? 'Retirado' : 'Activo';
}
/** The draft the editor writes for an existing supplier: its own name and contact. */
export function supplierDraftOf(row: { readonly name: string; readonly contact: string }): SupplierDraft {
  return { name: row.name, contact: row.contact };
}

/** One rejected write: only the house envelope, and only for the admitted status. */
export function parseSuppliersError(raw: string, status: number): SuppliersErrorCode {
  const admitted = suppliersAdmittedErrors.get(status);
  if (!admitted) return invalidResponse();
  const envelope = response(decode(raw), ['error']);
  const code = envelope.error;
  if (typeof code !== 'string' || !admitted.includes(code as SuppliersErrorCode)) return invalidResponse();
  return code as SuppliersErrorCode;
}
