import { LosslessNumber, parse as parseJSON } from 'lossless-json';
import {
  catalogPricesPath, parseCatalogPrices, validCatalogPricesQuery,
  type CatalogPolarity, type CatalogPricesQuery,
} from './catalogPricesModel';

// The polarity of a battery is the price contract's own vocabulary: one battery,
// one or two variants, never a third.
export type { CatalogPolarity };

// The warehouse administrator's battery contract: create the identity with its
// polarities, edit the complete identity and retire the battery. Identifiers are
// never typed: the database allocates the battery id and every variant id, and the
// echo of the write is the only place the screen learns them. A created battery
// carries no branch price, so priced_branches 0 is a real state: the battery exists
// and is not sellable until the price screen prices it per branch.
//
// The catalog publishes no dedicated battery listing. Its only battery read is the
// price matrix, one row per active battery with the pairs of the active branches, so
// this module derives the count the record names from that row. No payload gains a
// field: the reading and the decoding stay exactly the price matrix contract.

/** One allocated polarity of a battery: the id is the database's. */
export interface CatalogBatteryVariant { readonly id: number; readonly polarity: CatalogPolarity }
/** The created or edited battery, field by field as the server echoes it. */
export interface CatalogBatteryRecord {
  readonly id: number; readonly brand: string; readonly model: string; readonly capacity_ah: string;
  readonly variants: readonly CatalogBatteryVariant[]; readonly priced_branches: number;
}
/** One battery of the active catalog, as its only listing publishes it. */
export interface CatalogBatteryRow {
  readonly id: number; readonly brand: string; readonly model: string; readonly capacity_ah: string;
  readonly polarities: readonly CatalogPolarity[]; readonly priced_branches: number;
}
export interface CatalogBatteryPage {
  readonly rows: readonly CatalogBatteryRow[];
  readonly page: number; readonly page_size: number; readonly total_batteries: number;
}
/** The drafted identity of a new battery: the polarities it must exist in. */
export interface CatalogBatteryDraft {
  readonly brand: string; readonly model: string; readonly capacity_ah: string;
  readonly polarities: readonly CatalogPolarity[];
}
/** The complete identity of an existing battery: never a partial patch. */
export interface CatalogBatteryIdentity {
  readonly brand: string; readonly model: string; readonly capacity_ah: string;
}
export type CatalogBatteryValidation<T> =
  | { readonly valid: true; readonly input: T }
  | { readonly valid: false; readonly message: string };

/** Every code this contract can answer with, including the transport ones. */
export type CatalogBatteriesErrorCode = 'invalid_request' | 'unauthenticated' | 'forbidden' | 'not_found'
  | 'conflict' | 'catalog_battery_has_stock' | 'catalog_battery_has_pending' | 'service_unavailable'
  | 'invalid_response' | 'network' | 'aborted';

export const catalogBatteriesMaxID = 2_147_483_647;
/** The branch identity bound: a battery can never be priced in more branches. */
export const catalogBatteriesMaxPricedBranches = 32_767;
/** A brand or a model is exact bounded text, never a trimmed nor padded one. */
export const catalogBatteriesMaxNameBytes = 128;

export const catalogBatteriesListUnavailable =
  'No se pudo consultar el catálogo de baterías. Revisá la conexión e intentá de nuevo.';

/** The three refusals of retirement keep their own words, never a generic failure. */
export const catalogBatteriesErrorMessages: Record<CatalogBatteriesErrorCode, string> = {
  invalid_request: 'El servidor rechazó los datos: revisá la marca, el modelo, la capacidad y las polaridades. No se guardó nada.',
  unauthenticated: 'La sesión no está activa. Volvé a iniciar sesión: no se guardó nada.',
  forbidden: 'No tenés permiso para administrar el catálogo de baterías. No se guardó nada.',
  not_found: 'La batería ya no está en el catálogo activo. Actualizá la lista: no se guardó nada.',
  conflict: 'Ya existe una batería activa con esa marca y modelo. Cambiá la marca o el modelo: no se guardó nada.',
  catalog_battery_has_stock: 'La batería todavía tiene stock o unidades reservadas. Dejá sus existencias en cero antes de archivarla: no se archivó.',
  catalog_battery_has_pending: 'La batería tiene una transferencia pendiente. Resolvé esa operación antes de archivarla: no se archivó.',
  service_unavailable: 'El servicio del catálogo no está disponible. Conservamos lo que escribiste para reintentar.',
  invalid_response: 'La respuesta del servidor no es válida. Conservamos lo que escribiste: no se guardó nada.',
  network: 'No se pudo conectar con el servidor. Conservamos lo que escribiste para reintentar.',
  aborted: 'La operación se interrumpió. Conservamos lo que escribiste para reintentar.',
};

/** The client-side mirror of the server rules, worded for the person filling the form. */
export const catalogBatteryNameMessage =
  'Ingresá una marca y un modelo de hasta 128 bytes UTF-8, sin NUL ni espacios solamente.';
export const catalogBatteryCapacityMessage =
  'Ingresá una capacidad positiva, de hasta seis enteros y seis decimales.';
export const catalogBatteryPolarityMessage = 'Elegí al menos una polaridad: L, R o ambas, sin repetir.';

/** A battery with no price in any active branch is not sellable, and says so. */
export const catalogBatteryUnsellableLabel = 'No vendible · sin precio';
export const catalogBatteryPricingHint = 'Cargá su precio en el catálogo de precios para poder venderla.';

/** Admitted error envelope per HTTP status; nothing else may reach the UI. */
export const catalogBatteriesAdmittedErrors: ReadonlyMap<number, readonly CatalogBatteriesErrorCode[]> = new Map([
  [400, ['invalid_request']],
  [401, ['unauthenticated']],
  [403, ['forbidden']],
  [404, ['not_found']],
  [409, ['conflict', 'catalog_battery_has_stock', 'catalog_battery_has_pending']],
  [503, ['service_unavailable']],
]);

function invalidResponse(): never { throw new Error('Respuesta inválida del servidor.'); }
function invalidDraft(): never { throw new Error('Datos de la batería inválidos.'); }

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

/** The byte length of the name, never its UTF-16 length. */
export function catalogBatteryNameBytes(value: string): number {
  return new TextEncoder().encode(value).length;
}
/**
 * A brand or a model is exact text: valid UTF-8, at most 128 bytes, at least one
 * non-space rune and no NUL. Spaces around it are preserved, never trimmed, so the
 * catalogue echoes exactly what was written.
 */
export function validCatalogBatteryName(value: unknown): boolean {
  return typeof value === 'string' && value !== '' && !value.includes('\0') && value.isWellFormed()
    && value.trim() !== '' && catalogBatteryNameBytes(value) <= catalogBatteriesMaxNameBytes;
}
/**
 * The canonical capacity the database persists: at most six integral and six
 * fractional digits, positive, without leading zeros and without a trailing zero in
 * the fraction. This is the server's own normalization, applied to what was typed.
 */
export function canonicalCatalogCapacity(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9]+(\.[0-9]{1,6})?$/.test(value)) return invalidDraft();
  const [whole, fraction = ''] = value.split('.');
  const integral = whole.replace(/^0+/, '') || '0';
  if (integral.length > 6) return invalidDraft();
  const decimals = fraction.replace(/0+$/, '');
  if (integral === '0' && decimals === '') return invalidDraft();
  return decimals === '' ? integral : `${integral}.${decimals}`;
}
/**
 * A persisted capacity is already the canonical decimal text the database writes: a
 * padded or differently spelled one is a shape this contract never produces.
 */
const persistedCapacity = /^(0|[1-9]\d{0,5})(\.\d{0,5}[1-9])?$/;
function recordCapacity(value: unknown): string {
  if (typeof value !== 'string' || !persistedCapacity.test(value) || value === '0') return invalidResponse();
  return value;
}
/** A persisted name is the bounded text this contract wrote, echoed back unchanged. */
function recordName(value: unknown): string {
  if (!validCatalogBatteryName(value)) return invalidResponse();
  return value as string;
}

/**
 * The polarities of a draft: at least one and at most both, each L or R, distinct
 * and kept in a fixed order so the payload never depends on the order they were
 * checked in.
 */
function draftPolarities(value: unknown): readonly CatalogPolarity[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) return invalidDraft();
  const tags = value.map(entry => {
    if (entry !== 'L' && entry !== 'R') return invalidDraft();
    return entry;
  });
  if (new Set(tags).size !== tags.length) return invalidDraft();
  return Object.freeze(tags.sort());
}
/**
 * The allocated variants of a persisted battery: one or two, each with a distinct
 * polarity in ascending order, exactly as the database returns them.
 */
function recordVariants(value: unknown): readonly CatalogBatteryVariant[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) return invalidResponse();
  const variants = value.map(entry => {
    const variant = fields(entry, ['id', 'polarity']);
    const polarity = variant.polarity;
    if (polarity !== 'L' && polarity !== 'R') return invalidResponse();
    return Object.freeze({ id: integer(variant.id, 1, catalogBatteriesMaxID), polarity });
  });
  if (variants.length > 1 && variants[1].polarity <= variants[0].polarity) return invalidResponse();
  return Object.freeze(variants);
}

/** Parses one created or edited battery: exact keys, allocated ids, canonical text. */
export function parseCatalogBattery(raw: string): CatalogBatteryRecord {
  const record = fields(decode(raw), ['id', 'brand', 'model', 'capacity_ah', 'variants', 'priced_branches']);
  return Object.freeze({
    id: integer(record.id, 1, catalogBatteriesMaxID),
    brand: recordName(record.brand), model: recordName(record.model),
    capacity_ah: recordCapacity(record.capacity_ah),
    variants: recordVariants(record.variants),
    priced_branches: integer(record.priced_branches, 0, catalogBatteriesMaxPricedBranches),
  });
}

/**
 * Reads one page of the active catalog through the matrix read and derives the
 * priced-branch count of every row. The matrix already refuses an off-contract row,
 * an unknown key and a price of a branch it did not list, so a row here is evidence
 * about the catalog, never a partial guess.
 */
export function parseCatalogBatteryPage(raw: string): CatalogBatteryPage {
  const matrix = parseCatalogPrices(raw);
  const rows = matrix.batteries.map(battery => Object.freeze({
    id: battery.catalog_entry_id, brand: battery.brand, model: battery.model,
    capacity_ah: battery.capacity_ah, polarities: battery.polarities,
    priced_branches: battery.prices.length,
  }));
  return Object.freeze({
    rows: Object.freeze(rows), page: matrix.page, page_size: matrix.page_size,
    total_batteries: matrix.total_batteries,
  });
}

/** The frozen read path of the listing: the price matrix query, unchanged. */
export function catalogBatteriesPath(query: CatalogPricesQuery): string {
  if (!validCatalogPricesQuery(query)) return invalidResponse();
  return catalogPricesPath(query);
}

function capacityProblem(value: unknown): boolean {
  try { canonicalCatalogCapacity(value); return false; } catch { return true; }
}
function polaritiesProblem(value: unknown): boolean {
  try { draftPolarities(value); return false; } catch { return true; }
}
function createProblem(record: Record<string, unknown>): string | null {
  if (!validCatalogBatteryName(record.brand) || !validCatalogBatteryName(record.model)) return catalogBatteryNameMessage;
  if (capacityProblem(record.capacity_ah)) return catalogBatteryCapacityMessage;
  if (polaritiesProblem(record.polarities)) return catalogBatteryPolarityMessage;
  return null;
}
function identityProblem(record: Record<string, unknown>): string | null {
  if (!validCatalogBatteryName(record.brand) || !validCatalogBatteryName(record.model)) return catalogBatteryNameMessage;
  if (capacityProblem(record.capacity_ah)) return catalogBatteryCapacityMessage;
  return null;
}

/**
 * Admits one creation and freezes the exact payload: the identity, the canonical
 * capacity and the sorted polarities. Any other key is refused, so no identifier
 * and no price can travel.
 */
export function canonicalCatalogBatteryCreate(input: CatalogBatteryDraft): CatalogBatteryDraft {
  const record = fields(input, ['brand', 'model', 'capacity_ah', 'polarities'], false);
  if (createProblem(record) !== null) return invalidDraft();
  return Object.freeze({
    brand: record.brand as string, model: record.model as string,
    capacity_ah: canonicalCatalogCapacity(record.capacity_ah), polarities: draftPolarities(record.polarities),
  });
}
/** Admits one edit and freezes the complete identity: three fields, never a patch. */
export function canonicalCatalogBatteryIdentity(input: CatalogBatteryIdentity): CatalogBatteryIdentity {
  const record = fields(input, ['brand', 'model', 'capacity_ah'], false);
  if (identityProblem(record) !== null) return invalidDraft();
  return Object.freeze({
    brand: record.brand as string, model: record.model as string,
    capacity_ah: canonicalCatalogCapacity(record.capacity_ah),
  });
}

/** Validates a creation and returns either the exact payload or the message to show. */
export function validateCatalogBatteryCreateDraft(
  draft: CatalogBatteryDraft,
): CatalogBatteryValidation<CatalogBatteryDraft> {
  const problem = createProblem(draft as unknown as Record<string, unknown>);
  if (problem !== null) return { valid: false, message: problem };
  try { return { valid: true, input: canonicalCatalogBatteryCreate(draft) }; }
  catch { return { valid: false, message: catalogBatteryNameMessage }; }
}
/** Validates an edit and returns either the complete identity or the message to show. */
export function validateCatalogBatteryIdentityDraft(
  draft: CatalogBatteryIdentity,
): CatalogBatteryValidation<CatalogBatteryIdentity> {
  const problem = identityProblem(draft as unknown as Record<string, unknown>);
  if (problem !== null) return { valid: false, message: problem };
  try { return { valid: true, input: canonicalCatalogBatteryIdentity(draft) }; }
  catch { return { valid: false, message: catalogBatteryNameMessage }; }
}

/**
 * The created record is evidence only if it repeats the battery this client wrote:
 * the same identity and the same allocated polarities.
 */
export function matchesCatalogBatteryCreate(input: CatalogBatteryDraft, record: CatalogBatteryRecord): boolean {
  let expected: CatalogBatteryDraft;
  try { expected = canonicalCatalogBatteryCreate(input); } catch { return false; }
  if (record.brand !== expected.brand || record.model !== expected.model) return false;
  if (record.capacity_ah !== expected.capacity_ah) return false;
  const polarities = record.variants.map(variant => variant.polarity);
  return polarities.length === expected.polarities.length
    && expected.polarities.every((polarity, index) => polarities[index] === polarity);
}
/** The edited record is evidence only if it repeats the identity this client wrote. */
export function matchesCatalogBatteryIdentity(input: CatalogBatteryIdentity, record: CatalogBatteryRecord): boolean {
  let expected: CatalogBatteryIdentity;
  try { expected = canonicalCatalogBatteryIdentity(input); } catch { return false; }
  return record.brand === expected.brand && record.model === expected.model
    && record.capacity_ah === expected.capacity_ah;
}

/** How the screen describes the priced branches of one battery. */
export function pricedBranchesLabel(count: number): string {
  if (count === 0) return 'Sin precio en ninguna sucursal';
  return count === 1 ? 'Con precio en 1 sucursal' : `Con precio en ${count} sucursales`;
}
/** The allocated variants the server returned, never an id the client guessed. */
export function variantsLabel(variants: readonly CatalogBatteryVariant[]): string {
  return variants.map(variant => `#${variant.id} ${variant.polarity}`).join(' · ');
}

/** One rejected write: only the house envelope, and only for the admitted status. */
export function parseCatalogBatteriesError(raw: string, status: number): CatalogBatteriesErrorCode {
  const admitted = catalogBatteriesAdmittedErrors.get(status);
  if (!admitted) return invalidResponse();
  const envelope = fields(decode(raw), ['error']);
  const code = envelope.error;
  if (typeof code !== 'string' || !admitted.includes(code as CatalogBatteriesErrorCode)) return invalidResponse();
  return code as CatalogBatteriesErrorCode;
}
