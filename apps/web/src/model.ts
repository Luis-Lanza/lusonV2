import { LosslessNumber, parse } from 'lossless-json';

export interface Location { id: number; name: string }
export interface Identity { account_id: number; username: string; display_name?: string; must_change_password?: boolean; location: Location }
export type Session = { authenticated: false; csrf_token: string } | {
  authenticated: true; csrf_token: string; identity: Identity; expires_at: string;
};
export interface Metadata { locations: Location[]; brands: string[] }
export interface Item {
  variant_id: number; catalog_entry_id: number; brand: string; model: string;
  capacity_ah: string; polarity: 'L' | 'R'; existing: bigint; reserved: bigint; available: bigint;
}
export interface Inventory {
  location: Location; items: Item[]; page: number; page_size: number; total_variants: number;
}
export interface Query {
  location: number; search: string; brand: string; polarity: '' | 'L' | 'R'; page: number; size: number;
}
export const initialQuery = (location: number): Query => ({ location, search: '', brand: '', polarity: '', page: 1, size: 10 });
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
function capacity(v: unknown): string {
  const raw = numeric(v);
  if (!/^(0|[1-9]\d{0,5})(\.\d{1,6})?$/.test(raw) || !/[1-9]/.test(raw)) return invalid();
  return raw.includes('.') ? raw.replace(/0+$/, '').replace(/\.$/, '') : raw;
}
function location(v: unknown): Location {
  const o = object(v);
  return { id: integer(o.id, 1, 32767), name: text(o.name) };
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
  if (locations.length < 3 || new Set(locations.map(l => l.id)).size !== locations.length
    || ![1, 2, 3].every(id => locations.some(l => l.id === id)) || !brands.length || new Set(brands).size !== brands.length) return invalid();
  return { locations, brands };
}
export function parseInventory(raw: string): Inventory {
  const o = object(decode(raw));
  const page = integer(o.page, 1, 1000000);
  const size = integer(o.page_size, 10, 50);
  const total = integer(o.total_variants, 0, 190);
  if (![10, 25, 50].includes(size) || !Array.isArray(o.items) || o.items.length > size || o.items.length > total) return invalid();
  const items = o.items.map(value => {
    const i = object(value);
    if (i.polarity !== 'L' && i.polarity !== 'R') return invalid();
    const result: Item = {
      variant_id: integer(i.variant_id, 1, 190), catalog_entry_id: integer(i.catalog_entry_id, 1, 95),
      brand: text(i.brand), model: text(i.model), capacity_ah: capacity(i.capacity_ah), polarity: i.polarity,
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
  if (q.search) params.set('search', q.search);
  if (q.brand) params.set('brand', q.brand);
  if (q.polarity) params.set('polarity', q.polarity);
  return '/api/inventory?' + params.toString();
}
export function validSearch(text: string): boolean {
  return text.isWellFormed() && !text.includes('\0') && new TextEncoder().encode(text).length <= 128;
}
export function groupItems(items: Item[]): Item[][] {
  const groups = new Map<number, Item[]>();
  for (const item of items) {
    const group = groups.get(item.catalog_entry_id);
    if (group) group.push(item); else groups.set(item.catalog_entry_id, [item]);
  }
  return [...groups.values()];
}
