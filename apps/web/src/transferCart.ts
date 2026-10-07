import type { Item } from './model';
import type { TransferAuthority } from './useInventory';
import type { SourceCatalog } from './sourceInventory';
import { canonicalTransferInput, newTransferRetryKey, transferDirection, type TransferCreateInput, type TransferDirection, type TransferFlow } from './transferModel';

export interface CartLine { readonly item: Readonly<Item>; readonly quantity: bigint; readonly available: bigint | null }
export interface TransferCart {
  readonly epoch: number; readonly accountID: number; readonly assigned: 2 | 3;
  readonly direction: Readonly<TransferDirection>; readonly catalog: SourceCatalog;
  readonly lines: readonly CartLine[]; readonly attempt: TransferCreateInput | null;
}
export type CartQuantity = string | bigint;
const maxInt64 = 9223372036854775807n;
function invalid(): never { throw new Error('Invalid transfer cart'); }
function actor(authority: TransferAuthority): { assigned: 2 | 3; accountID: number; epoch: number } {
  const session = authority.session;
  if (!authority.ready || !session?.authenticated) return invalid();
  const assigned = session.identity.location.id;
  if (assigned !== 2 && assigned !== 3) return invalid();
  return { assigned, accountID: session.identity.account_id, epoch: authority.epoch };
}
function usable(cart: TransferCart, authority: TransferAuthority): boolean {
  try {
    const current = actor(authority);
    return current.epoch === cart.epoch && current.accountID === cart.accountID && current.assigned === cart.assigned;
  } catch { return false; }
}
function guard(cart: TransferCart, authority: TransferAuthority) { if (!usable(cart, authority)) invalid(); }
function quantity(input: CartQuantity): bigint {
  if (typeof input !== 'string' && typeof input !== 'bigint') return invalid();
  const text = String(input);
  if (text.length > 19 || !/^[1-9][0-9]*$/.test(text)) return invalid();
  const exact = BigInt(text);
  if (exact > maxInt64) return invalid();
  return exact;
}
function copyCatalog(catalog: SourceCatalog, source: number): SourceCatalog {
  if (catalog.location.id !== source || catalog.rows.length > 190) return invalid();
  const seen = new Set<number>();
  const rows = catalog.rows.map(item => {
    if (!Number.isInteger(item.variant_id) || item.variant_id < 1 || item.variant_id > 190 || seen.has(item.variant_id)) return invalid();
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
  const item = cart.catalog.rows.find(row => row.variant_id === id);
  if (!item || exact > item.available || (!previous && cart.lines.length >= 190)) return invalid();
  const line = Object.freeze({ item, quantity: exact, available: item.available });
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
    const item = copied.rows.find(row => row.variant_id === line.item.variant_id);
    return Object.freeze({ item: item ?? line.item, quantity: line.quantity, available: item?.available ?? null });
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
