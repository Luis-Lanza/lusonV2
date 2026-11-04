import { LosslessNumber, parse as parseJSON } from 'lossless-json';
import { validSearch } from './model';

// Catalogue price matrix: one row per battery, one minimum/suggested pair per
// (branch, battery), written by the warehouse administrator in blocks. A price
// belongs to brand + model + capacity, so both polarities share it.
/** One active branch of the matrix: the destination of a block assignment. */
export interface CatalogBranch { readonly id: number; readonly name: string }
/** The polarities one battery is sold in: never priced apart from each other. */
export type CatalogPolarity = 'L' | 'R';
/** One persisted pair of a branch. Money is canonical decimal text, never a float. */
export interface CatalogPrice {
  readonly branch_location_id: number; readonly min_price: string; readonly suggested_price: string;
  readonly updated_at: string; readonly updated_by_account_id: number; readonly updated_by_display_name: string;
}
/** One battery of the catalogue: its product data, its polarities and every persisted branch price. */
export interface CatalogBattery {
  readonly catalog_entry_id: number; readonly brand: string; readonly model: string;
  readonly capacity_ah: string; readonly polarities: readonly CatalogPolarity[]; readonly cells: readonly string[];
  readonly prices: readonly CatalogPrice[];
}
export interface CatalogPricesPage {
  readonly branches: readonly CatalogBranch[]; readonly batteries: readonly CatalogBattery[];
  readonly page: number; readonly page_size: number; readonly total_batteries: number;
}
/** The frozen read query: every filter of the contract is always present. */
export interface CatalogPricesQuery {
  readonly search: string; readonly brand: string; readonly capacity: string;
  readonly page: number; readonly page_size: number;
}
/**
 * One block write: a single battery, one minimum/suggested pair and the branches
 * it applies to. The catalogue manages prices only, so the payload carries no
 * product term of any kind.
 */
export interface CatalogPriceInput {
  readonly catalog_entry_id: number; readonly min_price: string; readonly suggested_price: string;
  readonly branch_ids: readonly number[];
}
/** The persisted result the server echoes back for the write, field by field. */
export interface CatalogPriceResult {
  readonly catalog_entry_id: number; readonly written: number; readonly branch_ids: readonly number[];
  readonly min_price: string; readonly suggested_price: string;
}
/** The draft as the form holds it, before validation: strings and checkboxes. */
export interface CatalogPriceDraft {
  readonly min_price: string; readonly suggested_price: string; readonly branch_ids: readonly number[];
}
export type CatalogPriceValidation =
  | { readonly valid: true; readonly input: CatalogPriceInput }
  | { readonly valid: false; readonly message: string };

export type CatalogPricesErrorCode = 'invalid_request' | 'retired_branch' | 'unauthenticated' | 'forbidden'
  | 'not_found' | 'service_unavailable' | 'invalid_response' | 'network' | 'aborted';

export const catalogPricesPageSizes: readonly number[] = [10, 25, 50];
export const catalogPricesDefaultPageSize = 10;
export const catalogPricesMaxPage = 1_000_000;
export const catalogPricesMaxBranches = 50;
export const catalogPricesMaxCatalogEntryID = 2_147_483_647;
export const catalogPricesListUnavailable =
  'No se pudo consultar el catálogo de precios. Revisá la conexión e intentá de nuevo.';

/** Spanish message for every write failure, including transport ones. */
export const catalogPricesErrorMessages: Record<CatalogPricesErrorCode, string> = {
  invalid_request: 'El servidor rechazó los precios: revisá el mínimo, el sugerido y las sucursales elegidas. No se escribió ningún precio.',
  retired_branch: 'Una de las sucursales elegidas fue retirada: quitala de la lista y volvé a intentar. No se escribió ningún precio.',
  unauthenticated: 'La sesión no está activa. Volvé a iniciar sesión: no se escribió ningún precio.',
  forbidden: 'No tenés permiso para administrar precios del catálogo. No se escribió ningún precio.',
  not_found: 'La batería ya no existe en el catálogo. Actualizá la lista: no se escribió ningún precio.',
  service_unavailable: 'El servicio no está disponible. No pudimos confirmar los precios: conservamos lo que escribiste.',
  invalid_response: 'La respuesta del servidor no es válida. No pudimos confirmar los precios: conservamos lo que escribiste.',
  network: 'No se pudo conectar con el servidor. Conservamos lo que escribiste para reintentar.',
  aborted: 'La aplicación de precios se interrumpió. Conservamos lo que escribiste para reintentar.',
};

/** The client-side mirror of the server rules, worded for the person writing prices. */
export const catalogPriceAmountMessage = 'El mínimo y el sugerido deben ser montos positivos, con hasta dos decimales.';
export const catalogPriceOrderMessage = 'El precio sugerido no puede ser menor que el precio mínimo de venta.';
export const catalogPriceBranchMessage = 'Elegí al menos una sucursal a la que aplicar el precio.';
export const catalogPriceBatteryMessage = 'La batería elegida no es válida. Actualizá la lista e intentá de nuevo.';

/** Admitted error envelope per HTTP status; nothing else may reach the UI. */
export const catalogPricesAdmittedErrors: ReadonlyMap<number, readonly CatalogPricesErrorCode[]> = new Map([
  [400, ['invalid_request', 'retired_branch']],
  [401, ['unauthenticated']],
  [403, ['forbidden']],
  [404, ['not_found']],
  [503, ['service_unavailable']],
]);

function invalidResponse(): never { throw new Error('Respuesta inválida del servidor.'); }
function invalidDraft(): never { throw new Error('Precios inválidos.'); }

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
/**
 * A display name is free text a real account may not have set: the preview
 * database bootstraps it empty, and an empty one is still a legitimate label.
 */
function label(value: unknown): string {
  if (typeof value !== 'string' || value.includes('\0') || !value.isWellFormed()) return invalidResponse();
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
 * A persisted amount is the canonical decimal money the database writes: at most
 * ten integral digits, exactly two fractions and strictly positive. It is kept as
 * text all the way to the view, so no binary float ever touches a price.
 */
const persistedAmount = /^(0|[1-9]\d{0,9})\.\d{2}$/;
function money(value: unknown): string {
  if (typeof value !== 'string' || !persistedAmount.test(value)) return invalidResponse();
  if (/^0+\.0+$/.test(value)) return invalidResponse();
  return value;
}
/**
 * Capacity is the inventory contract's canonical decimal text: at most six
 * integral digits, at most six fractional ones, positive and normalized. The
 * inventory read already serves it as a JSON number, so both shapes are admitted
 * and both are returned as the same canonical text.
 */
function capacity(value: unknown): string {
  const raw = typeof value === 'string' ? value : numeric(value);
  if (!/^(0|[1-9]\d{0,5})(\.\d{1,6})?$/.test(raw) || !/[1-9]/.test(raw)) return invalidResponse();
  const normalized = raw.includes('.') ? raw.replace(/0+$/, '').replace(/\.$/, '') : raw;
  // The server always writes the normalized decimal, so a padded one is a shape
  // this contract never produces.
  return typeof value === 'string' && normalized !== raw ? invalidResponse() : normalized;
}
/** The assigned tag of a branch: its own short name, never a renumbered index. */
export function branchTag(name: string): string {
  const words = name.trim().split(/\s+/);
  const last = words[words.length - 1] ?? '';
  if (last.length > 0 && last.length <= 3) return last;
  return (words[0] ?? '').slice(0, 1).toUpperCase();
}

/** The row's polarity summary: one row speaks for every polarity of the battery. */
export function polaritiesLabel(tags: readonly CatalogPolarity[]): string {
  return tags.length > 1 ? `Polaridades ${tags.join(' y ')}` : `Polaridad ${tags[0]}`;
}
/** The line that states the single price of the battery, whichever polarities it has. */
export function sharedPriceLabel(tags: readonly CatalogPolarity[]): string {
  const subjects = tags.length > 1 ? `las polaridades ${tags.join(' y ')}` : `la polaridad ${tags[0]}`;
  return `Un mismo precio para ${subjects} de esta batería.`;
}

/**
 * The frozen read path. The contract refuses an empty filter value, so a filter the
 * operator left blank is absent from the query instead of sent empty; the page and
 * the page size always travel.
 */
export function catalogPricesPath(query: CatalogPricesQuery): string {
  if (!validCatalogPricesQuery(query)) return invalidResponse();
  const params = new URLSearchParams();
  if (query.search !== '') params.set('search', query.search);
  if (query.brand !== '') params.set('brand', query.brand);
  if (query.capacity !== '') params.set('capacity', query.capacity);
  params.set('page', String(query.page));
  params.set('page_size', String(query.page_size));
  return '/api/catalog/prices?' + params.toString();
}

function validLabel(value: unknown): boolean {
  return typeof value === 'string' && !value.includes('\0') && value.isWellFormed();
}

export function validCatalogPricesQuery(query: CatalogPricesQuery): boolean {
  const filters = query as unknown as Record<string, unknown>;
  if (typeof filters.search !== 'string' || !validSearch(filters.search)) return false;
  if (typeof filters.brand !== 'string' || !validLabel(filters.brand) || filters.brand.length > 128) return false;
  if (typeof filters.capacity !== 'string' || (filters.capacity !== '' && !/^(0|[1-9]\d{0,5})(\.\d{1,6})?$/.test(filters.capacity))) return false;
  return Number.isInteger(query.page) && query.page >= 1 && query.page <= catalogPricesMaxPage
    && Number.isInteger(query.page_size) && catalogPricesPageSizes.includes(query.page_size);
}

/**
 * The polarities of one battery: one or two distinct tags, kept in a fixed order so
 * every row reads the same no matter how the server listed them.
 */
function polarities(value: unknown): readonly CatalogPolarity[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) return invalidResponse();
  const tags = value.map(entry => {
    if (entry !== 'L' && entry !== 'R') return invalidResponse();
    return entry;
  });
  if (new Set(tags).size !== tags.length) return invalidResponse();
  return Object.freeze(tags.sort());
}

/**
 * Parses one matrix page strictly: exact keys, lossless numbers, unique branches,
 * prices that belong to a listed branch and a pair that never reports a suggested
 * price below its own minimum.
 */
export function parseCatalogPrices(raw: string): CatalogPricesPage {
  const record = fields(decode(raw), ['branches', 'batteries', 'page', 'page_size', 'total_batteries']);
  const page = integer(record.page, 1, catalogPricesMaxPage);
  const page_size = integer(record.page_size, 10, 50);
  if (!catalogPricesPageSizes.includes(page_size)) return invalidResponse();
  const total_batteries = integer(record.total_batteries, 0, Number.MAX_SAFE_INTEGER);
  if (!Array.isArray(record.branches)) return invalidResponse();
  const branchIDs = new Set<number>();
  const branches = record.branches.map(value => {
    const entry = fields(value, ['id', 'name']);
    const id = integer(entry.id, 1, 32767);
    if (branchIDs.has(id)) return invalidResponse();
    branchIDs.add(id);
    return Object.freeze({ id, name: text(entry.name) });
  });
  if (!Array.isArray(record.batteries) || record.batteries.length > page_size) return invalidResponse();
  if (record.batteries.length > 0 && (page - 1) * page_size + record.batteries.length > total_batteries) return invalidResponse();
  const entryIDs = new Set<number>();
  const batteries = record.batteries.map(value => {
    const row = fields(value, ['catalog_entry_id', 'brand', 'model', 'capacity_ah', 'polarities', 'cells', 'prices']);
    const catalog_entry_id = integer(row.catalog_entry_id, 1, catalogPricesMaxCatalogEntryID);
    if (entryIDs.has(catalog_entry_id)) return invalidResponse();
    entryIDs.add(catalog_entry_id);
    const tags = polarities(row.polarities);
    if (!Array.isArray(row.cells) || row.cells.length > 64) return invalidResponse();
    const cells = row.cells.map(text);
    if (new Set(cells).size !== cells.length) return invalidResponse();
    if (!Array.isArray(row.prices) || row.prices.length > branches.length) return invalidResponse();
    const pricedBranches = new Set<number>();
    const prices = row.prices.map(entry => {
      const price = fields(entry, ['branch_location_id', 'min_price', 'suggested_price', 'updated_at',
        'updated_by_account_id', 'updated_by_display_name']);
      const branch_location_id = integer(price.branch_location_id, 1, 32767);
      // A price for a branch outside this matrix is not evidence about this catalogue.
      if (!branchIDs.has(branch_location_id) || pricedBranches.has(branch_location_id)) return invalidResponse();
      pricedBranches.add(branch_location_id);
      const min_price = money(price.min_price);
      const suggested_price = money(price.suggested_price);
      // The server enforces the floor; a persisted pair that violates it never renders.
      if (catalogAmountCents(suggested_price) < catalogAmountCents(min_price)) return invalidResponse();
      return Object.freeze({ branch_location_id, min_price, suggested_price,
        updated_at: timestamp(price.updated_at),
        updated_by_account_id: integer(price.updated_by_account_id, 1, Number.MAX_SAFE_INTEGER),
        updated_by_display_name: label(price.updated_by_display_name) });
    });
    return Object.freeze({ catalog_entry_id, brand: text(row.brand), model: text(row.model),
      capacity_ah: capacity(row.capacity_ah), polarities: tags, cells: Object.freeze(cells),
      prices: Object.freeze(prices) });
  });
  return Object.freeze({ branches: Object.freeze(branches), batteries: Object.freeze(batteries), page, page_size, total_batteries });
}

/** Exact cents of an admitted draft amount, so no comparison ever uses a float. */
export function catalogAmountCents(amount: string): bigint {
  if (typeof amount !== 'string') return invalidDraft();
  const match = /^(0|[1-9]\d{0,9})(?:\.(\d{1,2}))?$/.exec(amount.trim());
  if (!match) return invalidDraft();
  return BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));
}

/** A positive entry amount with at most two decimals. */
function entryMoney(value: unknown): string {
  if (typeof value !== 'string') return invalidDraft();
  const trimmed = value.trim();
  if (!/^(0|[1-9]\d{0,9})(\.\d{1,2})?$/.test(trimmed)) return invalidDraft();
  if (catalogAmountCents(trimmed) <= 0n) return invalidDraft();
  return trimmed;
}

/** The grouping the price columns use, built by hand so it never depends on a locale. */
export function formatCatalogMoney(amount: string): string {
  const cents = catalogAmountCents(amount);
  const whole = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const fraction = cents % 100n;
  return fraction === 0n ? `$ ${whole}` : `$ ${whole},${fraction.toString().padStart(2, '0')}`;
}

/** The value the entry field shows for a persisted amount, without padded zeros. */
export function catalogAmountEntry(amount: string): string {
  const cents = catalogAmountCents(amount);
  const whole = (cents / 100n).toString();
  const fraction = (cents % 100n).toString().padStart(2, '0').replace(/0+$/, '');
  return fraction === '' ? whole : `${whole}.${fraction}`;
}

function branchesOf(value: unknown): readonly number[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > catalogPricesMaxBranches) return invalidDraft();
  const seen = new Set<number>();
  const ids = value.map(entry => {
    // A destination is a branch: the warehouse (1) never receives a sale price.
    if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < 2 || entry > 32767) return invalidDraft();
    if (seen.has(entry)) return invalidDraft();
    seen.add(entry);
    return entry;
  }).sort((left, right) => left - right);
  return Object.freeze(ids);
}

/**
 * Admits one draft against the rules the server also enforces and freezes the
 * exact payload that will be sent: sorted unique branches and the flexible
 * entry amount. Any other key is refused, so no product term can travel.
 */
export function canonicalCatalogPriceInput(input: CatalogPriceInput): CatalogPriceInput {
  const record = fields(input, ['catalog_entry_id', 'min_price', 'suggested_price', 'branch_ids'], false);
  const catalog_entry_id = typeof record.catalog_entry_id === 'number' && Number.isInteger(record.catalog_entry_id)
    && record.catalog_entry_id >= 1 && record.catalog_entry_id <= catalogPricesMaxCatalogEntryID
    ? record.catalog_entry_id : invalidDraft();
  const min_price = entryMoney(record.min_price);
  const suggested_price = entryMoney(record.suggested_price);
  if (catalogAmountCents(suggested_price) < catalogAmountCents(min_price)) return invalidDraft();
  const branch_ids = branchesOf(record.branch_ids);
  return Object.freeze({ catalog_entry_id, min_price, suggested_price, branch_ids });
}

function draftProblem(draft: CatalogPriceDraft): string | null {
  const record = draft as unknown as Record<string, unknown>;
  let min: string;
  let suggested: string;
  try {
    min = entryMoney(record.min_price);
    suggested = entryMoney(record.suggested_price);
  } catch { return catalogPriceAmountMessage; }
  if (catalogAmountCents(suggested) < catalogAmountCents(min)) return catalogPriceOrderMessage;
  try { branchesOf(record.branch_ids); } catch { return catalogPriceBranchMessage; }
  return null;
}

/** Validates a draft and returns either the exact payload or the message to show. */
export function validateCatalogPriceDraft(entryID: number, draft: CatalogPriceDraft): CatalogPriceValidation {
  if (!Number.isInteger(entryID) || entryID < 1 || entryID > catalogPricesMaxCatalogEntryID) {
    return { valid: false, message: catalogPriceBatteryMessage };
  }
  const problem = draftProblem(draft);
  if (problem !== null) return { valid: false, message: problem };
  try { return { valid: true, input: canonicalCatalogPriceInput({ catalog_entry_id: entryID, ...draft }) }; }
  catch { return { valid: false, message: catalogPriceAmountMessage }; }
}

/**
 * The reply is evidence only if it reports the exact write this client sent: the
 * same battery, the same branch set and the same pair in cents.
 */
export function matchesCatalogPriceInput(input: CatalogPriceInput, result: CatalogPriceResult): boolean {
  let expected: CatalogPriceInput;
  try { expected = canonicalCatalogPriceInput(input); } catch { return false; }
  if (result.catalog_entry_id !== expected.catalog_entry_id) return false;
  if (result.written !== expected.branch_ids.length) return false;
  if (result.branch_ids.length !== expected.branch_ids.length) return false;
  const written = [...result.branch_ids].sort((left, right) => left - right);
  if (expected.branch_ids.some((id, index) => written[index] !== id)) return false;
  if (catalogAmountCents(result.min_price) !== catalogAmountCents(expected.min_price)) return false;
  if (catalogAmountCents(result.suggested_price) !== catalogAmountCents(expected.suggested_price)) return false;
  return catalogAmountCents(result.suggested_price) >= catalogAmountCents(result.min_price);
}

/**
 * Parses the reply of one applied block: the exact flat echo of the payload the
 * client sent, with the persisted canonical amounts and no product term at all.
 */
export function parseCatalogPriceResult(raw: string): CatalogPriceResult {
  const record = fields(decode(raw), ['catalog_entry_id', 'written', 'branch_ids', 'min_price', 'suggested_price']);
  const catalog_entry_id = integer(record.catalog_entry_id, 1, catalogPricesMaxCatalogEntryID);
  const written = integer(record.written, 1, catalogPricesMaxBranches);
  if (!Array.isArray(record.branch_ids) || record.branch_ids.length > catalogPricesMaxBranches) return invalidResponse();
  const seen = new Set<number>();
  const branch_ids = record.branch_ids.map(entry => {
    const id = integer(entry, 1, 32767);
    if (seen.has(id)) return invalidResponse();
    seen.add(id);
    return id;
  });
  const min_price = money(record.min_price);
  const suggested_price = money(record.suggested_price);
  if (catalogAmountCents(suggested_price) < catalogAmountCents(min_price)) return invalidResponse();
  return Object.freeze({ catalog_entry_id, written, branch_ids: Object.freeze(branch_ids), min_price, suggested_price });
}

function admittedError<C extends string>(raw: string, status: number, table: ReadonlyMap<number, readonly C[]>): C {
  const admitted = table.get(status);
  if (!admitted) return invalidResponse();
  const envelope = fields(decode(raw), ['error']);
  const code = envelope.error;
  if (typeof code !== 'string' || !admitted.includes(code as C)) return invalidResponse();
  return code as C;
}

export function parseCatalogPricesError(raw: string, status: number): CatalogPricesErrorCode {
  return admittedError(raw, status, catalogPricesAdmittedErrors);
}

/** One rejected write: the code plus the branch the server named as retired. */
export interface CatalogPricesWriteError { readonly code: CatalogPricesErrorCode; readonly branch_id: number | null }

/**
 * A retired branch is answered with the offending id beside the code, so the client
 * can name the row it must drop; every other failure is the plain house envelope.
 */
export function parseCatalogPricesWriteError(raw: string, status: number): CatalogPricesWriteError {
  if (status === 400) {
    let envelope: Record<string, unknown> | null = null;
    try { envelope = fields(decode(raw), ['error', 'branch_id']); } catch { envelope = null; }
    if (envelope !== null && envelope.error === 'retired_branch') {
      // A destination outside the branch range cannot be acted on, so the message
      // stays generic instead of naming the wrong row.
      let branch_id: number | null = null;
      try { branch_id = integer(envelope.branch_id, 2, 32767); } catch { branch_id = null; }
      return { code: 'retired_branch', branch_id };
    }
  }
  return { code: admittedError(raw, status, catalogPricesAdmittedErrors), branch_id: null };
}
