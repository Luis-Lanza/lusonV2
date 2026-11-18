import { identityOf, parseNumberVariantIdentity } from './model';
import type { Battery, Field, VariantIdentity } from './model';
import type { TransferAuthority } from './useInventory';
import type { SourceCatalog } from './sourceInventory';
import { canonicalTransferInput, newTransferRetryKey, transferDirection, transferFlow, validTransferLocation, type TransferCreateInput, type TransferDirection, type TransferFlow, type TransferLocationID } from './transferModel';

// A transfer moves one catalogue kind, and the cart keeps the shared identity of
// the row it selected: the entry it belongs to and the identity its labels are
// read from, the same one inventory publishes for a battery and for a product.
export type CartDescriptor = Readonly<VariantIdentity & { catalog_entry_id: number }>;
export interface CartRestoration {
  readonly epoch: number; readonly attempt: TransferCreateInput; readonly direction: Readonly<TransferDirection>;
  readonly items: readonly (CartDescriptor & { readonly quantity: string })[];
}
export interface CartLine { readonly item: CartDescriptor; readonly quantity: bigint; readonly available: bigint | null }
export interface TransferCart {
  readonly epoch: number; readonly sessionGeneration: number; readonly accountID: number; readonly assigned: TransferLocationID;
  readonly direction: Readonly<TransferDirection>; readonly catalog: SourceCatalog;
  readonly lines: readonly CartLine[]; readonly attempt: TransferCreateInput | null;
}
export type CartQuantity = string | bigint;
const maxInt64 = 9223372036854775807n;
function invalid(): never { throw new Error('Invalid transfer cart'); }
function actor(authority: TransferAuthority): { assigned: TransferLocationID; accountID: number; epoch: number; sessionGeneration: number } {
  const session = authority.session;
  if (!authority.ready || !session?.authenticated || session.identity.must_change_password === true) return invalid();
  const assigned = session.identity.location.id;
  if (!validTransferLocation(assigned) || !Number.isSafeInteger(session.identity.account_id) || session.identity.account_id < 1
    || (session.identity.account_id === 1) !== (assigned === 1)) return invalid();
  return { assigned, accountID: session.identity.account_id, epoch: authority.epoch, sessionGeneration: authority.sessionGeneration ?? 0 };
}
function usable(cart: TransferCart, authority: TransferAuthority): boolean {
  try {
    const current = actor(authority);
    return current.epoch === cart.epoch && current.sessionGeneration === cart.sessionGeneration && current.accountID === cart.accountID && current.assigned === cart.assigned;
  } catch { return false; }
}
function guard(cart: TransferCart, authority: TransferAuthority) { if (!usable(cart, authority)) invalid(); }
function sameBattery(left: Battery | null, right: Battery | null): boolean {
  if (left === null || right === null) return left === right;
  return left.brand === right.brand && left.model === right.model
    && left.capacity_ah === right.capacity_ah && left.polarity === right.polarity;
}
function sameFields(left: readonly Field[] | null, right: readonly Field[] | null): boolean {
  if (left === null || right === null) return left === right;
  return left.length === right.length && left.every((field, index) => {
    const other = right[index];
    return field.name === other.name && field.kind === other.kind && field.unit === other.unit
      && field.number === other.number && field.text === other.text;
  });
}
function sameDescriptor(left: CartDescriptor, right: CartDescriptor): boolean {
  return left.variant_id === right.variant_id && left.catalog_entry_id === right.catalog_entry_id
    && left.kind === right.kind && left.name === right.name && left.detail === right.detail
    && sameBattery(left.battery, right.battery) && sameFields(left.fields, right.fields);
}
function descriptor(item: VariantIdentity & { catalog_entry_id: number }): CartDescriptor {
  return Object.freeze({ ...identityOf(item), catalog_entry_id: item.catalog_entry_id,
    battery: item.battery === null ? null : Object.freeze({ ...item.battery }),
    fields: item.fields === null ? null : item.fields.map(field => Object.freeze({ ...field })) });
}
/**
 * Copies one archived descriptor, keeping only the shared identity the catalogue
 * could publish: stock numbers, credentials or any other archived extra never
 * reach a line, and nothing is invented for a row of either kind.
 */
export function archivedCartDescriptor(value: unknown): CartDescriptor {
  const line = typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : invalid();
  const catalog_entry_id = line.catalog_entry_id;
  if (typeof catalog_entry_id !== 'number' || !Number.isSafeInteger(catalog_entry_id)
    || catalog_entry_id < 1 || catalog_entry_id > 2_147_483_647) return invalid();
  const identity = parseNumberVariantIdentity({ variant_id: line.variant_id, kind: line.kind, name: line.name,
    detail: line.detail, battery: line.battery, fields: line.fields });
  return descriptor({ ...identity, catalog_entry_id });
}
function quantity(input: CartQuantity): bigint {
  if (typeof input !== 'string' && typeof input !== 'bigint') return invalid();
  const text = String(input);
  if (text.length > 19 || !/^[1-9][0-9]*$/.test(text)) return invalid();
  const exact = BigInt(text);
  if (exact > maxInt64) return invalid();
  return exact;
}
function copyCatalog(catalog: SourceCatalog, source: number): SourceCatalog {
  if (catalog.location.id !== source || catalog.rows.length > 2_147_483_647) return invalid();
  const seen = new Set<number>();
  const rows = catalog.rows.map(item => {
    if (!Number.isInteger(item.variant_id) || item.variant_id < 1 || item.variant_id > 2_147_483_647 || seen.has(item.variant_id)) return invalid();
    seen.add(item.variant_id);
    return Object.freeze({ ...item });
  });
  return Object.freeze({ location: Object.freeze({ ...catalog.location }), rows: Object.freeze(rows) });
}
function withLines(cart: TransferCart, lines: readonly CartLine[], attempt: TransferCreateInput | null = null): TransferCart {
  return Object.freeze({ ...cart, lines: Object.freeze([...lines]), attempt });
}

// Changing flow/source means a NEW empty cart; confirmation is a future UI concern.
export function createTransferCart(authority: TransferAuthority, flow: TransferFlow, catalog: SourceCatalog): TransferCart {
  const current = actor(authority);
  const direction = Object.freeze(transferDirection(current.assigned, flow));
  return Object.freeze({ ...current, direction, catalog: copyCatalog(catalog, direction.origin_location_id), lines: Object.freeze([]), attempt: null });
}
// Caller MUST obtain snapshot through recovery.getCurrent(latestAuthorityGetter).
// Snapshot has no account credential: epoch/route checks do not authorize archive access.
export function restoreTransferCart(authority: TransferAuthority, catalog: SourceCatalog, snapshot: CartRestoration): TransferCart {
  try {
    const current = actor(authority);
    if (!Number.isSafeInteger(current.accountID) || current.accountID < 1
      || snapshot.epoch !== current.epoch) return invalid();
    const attempt = canonicalTransferInput(snapshot.attempt);
    const flow = transferFlow(current.assigned, attempt.kind, attempt.counterparty_location_id);
    const direction = Object.freeze(transferDirection(current.assigned, flow));
    if (attempt.counterparty_location_id !== direction.counterparty_location_id
      || Object.keys(direction).some(k => direction[k as keyof TransferDirection] !== snapshot.direction[k as keyof TransferDirection])) return invalid();
    const copied = copyCatalog(catalog, direction.origin_location_id);
    if (!Array.isArray(snapshot.items) || snapshot.items.length !== attempt.items.length) return invalid();
    const seen = new Set<number>();
    const lines = snapshot.items.map(selected => {
      const item = archivedCartDescriptor(selected);
      const requestedQuantity = (selected as { quantity?: unknown }).quantity;
      const requested = attempt.items.find(line => line.variant_id === item.variant_id);
      if (seen.has(item.variant_id) || !requested || typeof requestedQuantity !== 'string'
        || requestedQuantity !== requested.quantity) return invalid();
      seen.add(item.variant_id);
      const row = copied.rows.find(v => v.variant_id === item.variant_id);
      if (row && !sameDescriptor(item, descriptor(row))) return invalid();
      return Object.freeze({ item, quantity: quantity(requestedQuantity), available: row?.available ?? null });
    });
    return Object.freeze({ ...current, direction, catalog: copied, lines: Object.freeze(lines), attempt });
  } catch { return invalid(); }
}
export function cartStatus(cart: TransferCart, authority: TransferAuthority): { usable: boolean; ready: boolean; total: bigint; invalid: readonly number[] } {
  const current = usable(cart, authority);
  if (!current) return { usable: false, ready: false, total: 0n, invalid: Object.freeze([]) };
  const invalid = Object.freeze(cart.lines.filter(line => line.available === null || line.quantity > line.available).map(line => line.item.variant_id));
  return { usable: current, ready: current && cart.lines.length > 0 && invalid.length === 0,
    total: cart.lines.reduce((sum, line) => sum + line.quantity, 0n), invalid };
}
export function setCartQuantity(cart: TransferCart, authority: TransferAuthority, id: number, input: CartQuantity): TransferCart {
  guard(cart, authority);
  const exact = quantity(input);
  const previous = cart.lines.find(line => line.item.variant_id === id);
  // A no-op must not discard a known uncertain attempt after guidance changes.
  if (previous?.quantity === exact) return cart;
  const row = cart.catalog.rows.find(row => row.variant_id === id);
  // A document carries one catalogue kind: a row of the other kind never enters it.
  if (!row || exact > row.available || (cart.lines[0]?.item.kind ?? row.kind) !== row.kind
    || (!previous && cart.lines.length >= 190)) return invalid();
  const line = Object.freeze({ item: descriptor(row), quantity: exact, available: row.available });
  return withLines(cart, previous ? cart.lines.map(old => old.item.variant_id === id ? line : old) : [...cart.lines, line]);
}
export function addCartItem(cart: TransferCart, authority: TransferAuthority, id: number, input: CartQuantity): TransferCart {
  guard(cart, authority);
  const increment = quantity(input);
  const previous = cart.lines.find(line => line.item.variant_id === id);
  return setCartQuantity(cart, authority, id, (previous?.quantity ?? 0n) + increment);
}
export function removeCartItem(cart: TransferCart, authority: TransferAuthority, id: number): TransferCart {
  guard(cart, authority);
  if (!cart.lines.some(line => line.item.variant_id === id)) return cart;
  return withLines(cart, cart.lines.filter(line => line.item.variant_id !== id));
}
export function clearTransferCart(cart: TransferCart, authority: TransferAuthority): TransferCart {
  guard(cart, authority);
  return cart.lines.length ? withLines(cart, []) : cart;
}
export function refreshCart(cart: TransferCart, authority: TransferAuthority, catalog: SourceCatalog): TransferCart {
  guard(cart, authority);
  const copied = copyCatalog(catalog, cart.direction.origin_location_id);
  const lines = cart.lines.map(line => {
    const row = copied.rows.find(row => row.variant_id === line.item.variant_id);
    return Object.freeze({ item: row ? descriptor(row) : line.item,
      quantity: line.quantity, available: row?.available ?? null });
  });
  // Availability/descriptors are guidance only, not material request edits.
  return withLines(Object.freeze({ ...cart, catalog: copied }), lines, cart.attempt);
}
export function reviewCart(cart: TransferCart, authority: TransferAuthority, key: string | (() => string) = newTransferRetryKey): TransferCart {
  guard(cart, authority);
  // Server checks idempotent replay BEFORE current availability. Preserve retries.
  if (cart.attempt) return cart;
  if (!cartStatus(cart, authority).ready) return invalid();
  const attempt = canonicalTransferInput({ kind: cart.direction.kind, counterparty_location_id: cart.direction.counterparty_location_id,
    retry_key: typeof key === 'string' ? key : key(), items: cart.lines.map(line => ({ variant_id: line.item.variant_id, quantity: line.quantity.toString() })) });
  return withLines(cart, cart.lines, attempt);
}
