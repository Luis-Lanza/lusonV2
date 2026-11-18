import { LosslessNumber, parse } from 'lossless-json';

export interface Location { id: number; name: string }
export interface Identity { account_id: number; username: string; display_name?: string; must_change_password?: boolean; location: Location }
export type Session = { authenticated: false; csrf_token: string } | {
  authenticated: true; csrf_token: string; identity: Identity; expires_at: string;
};
export interface Metadata { locations: Location[]; brands: string[] }
/** The two kinds of catalogue entry a variant can belong to. */
export type Kind = 'battery' | 'other';
/** The three states of the kind selection: both kinds, batteries alone, products alone. */
export type KindFilter = 'all' | 'battery' | 'other';
/** The battery attributes of a battery variant: brand, model, capacity text and polarity. */
export interface Battery { brand: string; model: string; capacity_ah: string; polarity: 'L' | 'R' }
export type FieldKind = 'number' | 'text';
/** One typed custom field of an other product: a canonical number with an optional unit, or text. */
export interface Field { name: string; kind: FieldKind; unit?: string; number?: string; text?: string }
/**
 * One stock row: the variant identity every surface reads, one shape for both
 * kinds, plus the three stock numbers of the location.
 */
export interface Item extends VariantIdentity {
  catalog_entry_id: number; existing: bigint; reserved: bigint; available: bigint;
}
export interface Inventory {
  location: Location; items: Item[]; page: number; page_size: number; total_variants: number;
}export interface Query {
  location: number;
  // Absent is the battery-only listing the endpoint answers by default, so a
  // caller that predates the second kind keeps its own answer.
  kind?: KindFilter;
  search: string; brand: string; polarity: '' | 'L' | 'R'; page: number; size: number;
}
export const initialQuery = (location: number, kind?: KindFilter): Query => ({ location, kind, search: '', brand: '', polarity: '', page: 1, size: 10 });
function invalid(): never { throw new Error('Respuesta inválida del servidor.'); }
function decode(raw: string): unknown {
  try { return parse(raw); } catch { return invalid(); }
}
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v) || v instanceof LosslessNumber) return invalid();
  return v as Record<string, unknown>;
}
function text(v: unknown): string {
  if (typeof v !== 'string' || !v || v.includes('\0') || !v.isWellFormed()) return invalid();
  return v;
}
function numeric(v: unknown): string {
  // Default parse returns LosslessNumber. Never call valueOf or coerce it to a float.
  if (!(v instanceof LosslessNumber)) return invalid();
  return v.toString();
}
function integer(v: unknown, min: number, max: number): number {
  const raw = numeric(v);
  if (!/^(0|[1-9]\d*)$/.test(raw)) return invalid();
  const exact = BigInt(raw);
  if (exact < BigInt(min) || exact > BigInt(max) || exact > BigInt(Number.MAX_SAFE_INTEGER)) return invalid();
  return Number(exact);
}
function quantity(v: unknown): bigint {
  const raw = numeric(v);
  if (!/^(0|[1-9]\d*)$/.test(raw)) return invalid();
  const exact = BigInt(raw);
  if (exact > 9223372036854775807n) return invalid();
  return exact;
}
// A decimal the server publishes as canonical text: no leading zero in the
// integral part, no trailing zero in the fraction and no negative zero, so the
// value travels exactly as it was composed.
function decimal(v: unknown, integral: number, signed: boolean): string {
  const raw = text(v);
  const pattern = new RegExp('^' + (signed ? '-?' : '') + '(0|[1-9]\\d{0,' + (integral - 1) + '})(\\.\\d{1,6})?$');
  if (!pattern.test(raw) || /\.\d*0$/.test(raw) || raw === '-0' || (!signed && !/[1-9]/.test(raw))) return invalid();
  return raw;
}
// The admitted number of custom fields of one product, and the byte bounds of
// its own columns, restated so a row the server could not publish never reaches
// a screen.
const maxFields = 20;
const fieldBounds = { name: 40, unit: 8, text: 200 } as const;
function bounded(v: unknown, limit: number): string {
  const raw = text(v);
  if (new TextEncoder().encode(raw).length > limit) return invalid();
  return raw;
}
// Every object of the identity is read as its exact key set: an unknown key and
// a missing key are both a row the server never composed.
function keys(o: Record<string, unknown>, expected: readonly string[]): Record<string, unknown> {
  if (Object.keys(o).length !== expected.length || !expected.every(key => Object.hasOwn(o, key))) return invalid();
  return o;
}
function field(v: unknown): Field {
  const o = object(v);
  const name = bounded(o.name, fieldBounds.name);
  if (o.kind === 'number') {
    const unit = Object.hasOwn(o, 'unit');
    keys(o, unit ? ['name', 'kind', 'unit', 'number'] : ['name', 'kind', 'number']);
    const number = decimal(o.number, 12, true);
    return unit ? { name, kind: 'number', unit: bounded(o.unit, fieldBounds.unit), number } : { name, kind: 'number', number };
  }
  if (o.kind === 'text') {
    keys(o, ['name', 'kind', 'text']);
    return { name, kind: 'text', text: bounded(o.text, fieldBounds.text) };
  }
  return invalid();
}
function fields(v: unknown): Field[] {
  if (!Array.isArray(v) || v.length > maxFields) return invalid();
  return v.map(field);
}
function battery(v: unknown): Battery {
  const o = keys(object(v), ['brand', 'model', 'capacity_ah', 'polarity']);
  if (o.polarity !== 'L' && o.polarity !== 'R') return invalid();
  return { brand: text(o.brand), model: text(o.model), capacity_ah: decimal(o.capacity_ah, 6, false), polarity: o.polarity };
}
function location(v: unknown): Location {
  const o = object(v);
  return { id: integer(o.id, 1, 32767), name: text(o.name) };
}
/**
 * The variant identity every screen reads, without the stock numbers of one
 * location: one shape for both kinds, where the kind shows in the name and the
 * detail. A battery carries its battery attributes and no typed field, a product
 * carries its typed fields and no battery attribute.
 */
export interface VariantIdentity {
  variant_id: number; kind: Kind; name: string; detail: string;
  battery: Battery | null; fields: Field[] | null;
}
const identityKeys = ['variant_id', 'kind', 'name', 'detail', 'battery', 'fields'] as const;
// The kind decides the shape: a battery row without its battery object is a
// malformed row, and so is a product row carrying one.
function identity(o: Record<string, unknown>): VariantIdentity {
  if (o.kind !== 'battery' && o.kind !== 'other') return invalid();
  const result: VariantIdentity = {
    variant_id: integer(o.variant_id, 1, 2_147_483_647), kind: o.kind, name: text(o.name), detail: text(o.detail),
    battery: o.kind === 'battery' ? battery(o.battery) : null,
    fields: o.kind === 'other' ? fields(o.fields) : null,
  };
  if (o.kind === 'battery' ? o.fields !== null : o.battery !== null) return invalid();
  return result;
}
/**
 * Parses one variant identity from any wire shape that carries it plus the keys
 * of its own envelope, so the ingress detail line and the stock row read the same
 * identity instead of two parsers that could disagree.
 */
export function parseVariantIdentity(v: unknown, extraKeys: readonly string[] = []): VariantIdentity {
  const o = object(v);
  keys(o, [...identityKeys, ...extraKeys]);
  return identity(o);
}
/**
 * The identity of one row, stripped of whatever envelope carries it: the stock
 * numbers of a location or the catalogue entry of a capture projection. A plain
 * identity answers itself, so every surface builds a draft line the same way.
 */
export function identityOf(item: VariantIdentity): VariantIdentity {
  return { variant_id: item.variant_id, kind: item.kind, name: item.name, detail: item.detail,
    battery: item.battery, fields: item.fields };
}
export function parseSession(raw: string): Session {
  const o = object(decode(raw));
  const csrf = text(o.csrf_token);
  if (!/^[A-Za-z0-9_-]{43}$/.test(csrf)) return invalid();
  if (o.authenticated === false) return { authenticated: false, csrf_token: csrf };
  if (o.authenticated !== true) return invalid();
  const i = object(o.identity);
  if (typeof i.must_change_password !== 'boolean' || typeof i.display_name !== 'string'
    || i.display_name.includes('\0') || !i.display_name.isWellFormed()) return invalid();
  const identity = { account_id: integer(i.account_id, 1, Number.MAX_SAFE_INTEGER), username: text(i.username),
    display_name: i.display_name, must_change_password: i.must_change_password, location: location(i.location) };
  if ((identity.account_id === 1) !== (identity.location.id === 1)) return invalid();
  const expiry = text(o.expires_at);
  if (!Number.isFinite(Date.parse(expiry))) return invalid();
  return { authenticated: true, csrf_token: csrf, identity, expires_at: expiry };
}
export function parseMetadata(raw: string): Metadata {
  const o = object(decode(raw));
  if (!Array.isArray(o.locations) || !Array.isArray(o.brands)) return invalid();
  const locations = o.locations.map(location);
  const brands = o.brands.map(text);
  if (new Set(locations.map(l => l.id)).size !== locations.length
    || !locations.some(l => l.id === 1) || !brands.length || new Set(brands).size !== brands.length) return invalid();
  return { locations, brands };
}
export function parseInventory(raw: string): Inventory {
  const o = object(decode(raw));
  const page = integer(o.page, 1, 1000000);
  const size = integer(o.page_size, 10, 50);
  const total = integer(o.total_variants, 0, 2_147_483_647);
  if (![10, 25, 50].includes(size) || !Array.isArray(o.items) || o.items.length > size || o.items.length > total) return invalid();
  const items = o.items.map(value => {
    const i = keys(object(value), ['variant_id', 'catalog_entry_id', 'kind', 'name', 'detail', 'battery', 'fields', 'existing', 'reserved', 'available']);
    const result: Item = {
      ...identity(i),
      catalog_entry_id: integer(i.catalog_entry_id, 1, 2_147_483_647),
      existing: quantity(i.existing), reserved: quantity(i.reserved), available: quantity(i.available),
    };
    if (result.reserved > result.existing || result.available > result.existing) return invalid();
    return result;
  });
  if (items.some((item, index) => index > 0 && item.variant_id <= items[index - 1].variant_id)) return invalid();
  return { location: location(o.location), items, page, page_size: size, total_variants: total };
}
export function queryURL(q: Query): string {
  const params = new URLSearchParams({ location_id: String(q.location), page: String(q.page), page_size: String(q.size) });
  // The brand and the polarity are battery attributes: a product-only listing
  // never sends them, so a stale battery filter cannot empty it.
  const batteryFilters = q.kind !== 'other';
  if (q.kind) params.set('kind', q.kind);
  if (q.search) params.set('search', q.search);
  if (batteryFilters && q.brand) params.set('brand', q.brand);
  if (batteryFilters && q.polarity) params.set('polarity', q.polarity);
  return '/api/inventory?' + params.toString();
}
export function validSearch(text: string): boolean {
  return text.isWellFormed() && !text.includes('\0') && new TextEncoder().encode(text).length <= 128;
}
// A battery-only surface reads rows that carry their battery: transfers and the
// closing count sheet never handle a product, while the ingress catalogue reads
// the battery projection for its battery document and the product listing for a
// product document (S11).
export type BatteryRow = Readonly<Item> & { readonly battery: Battery };
function hasBattery(item: Item): item is BatteryRow { return item.battery !== null; }
export function batteryRows(items: readonly Item[]): BatteryRow[] {
  return items.filter(hasBattery).map(item => Object.freeze({ ...item }));
}
// The warehouse identity is account 1 in location 1, the only identity that reads
// and writes the warehouse surfaces: it is the one that lists both kinds at once.
export function warehouseIdentity(identity: Identity | null | undefined): boolean {
  return !!identity && identity.account_id === 1 && identity.location.id === 1;
}
// The page lists variants, and the catalogue entry they belong to is what a
// grouping surface folds together: the polarity variants of one battery are one
// entry, and a product is one entry of exactly one variant.
export function groupItems<T extends Item>(items: T[]): T[][] {
  const groups = new Map<number, T[]>();
  for (const item of items) {
    const group = groups.get(item.catalog_entry_id);
    if (group) group.push(item); else groups.set(item.catalog_entry_id, [item]);
  }
  return [...groups.values()];
}
