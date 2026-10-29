import { describe, expect, it, vi } from 'vitest';
import type { TransferAuthority } from './useInventory';
import type { SourceCatalog } from './sourceInventory';
import { newTransferRetryKey, type TransferFlow } from './transferModel';
import { createTransferRecovery } from './transferRecovery';
import { addCartItem, restoreTransferCart, cartStatus, clearTransferCart, createTransferCart, refreshCart, removeCartItem, reviewCart, setCartQuantity } from './transferCart';

const max = 9223372036854775807n;
const key = 'private_retry_key_1234';
function authority(assigned = 2, epoch = 7): TransferAuthority {
  return { ready: true, epoch, session: { authenticated: true, csrf_token: 'not-stored-in-cart', expires_at: '2030-01-01T00:00:00Z',
    identity: { account_id: assigned, username: 'not-stored-in-cart', location: { id: assigned, name: 'Assigned' } } } };
}
function catalog(source = 1, count = 2, available = max): SourceCatalog {
  return { location: { id: source, name: 'Physical source' }, rows: Array.from({ length: count }, (_, i) => ({
    variant_id: i + 1, catalog_entry_id: Math.ceil((i + 1) / 2), brand: 'TOYO', model: 'Real model', capacity_ah: '6.000001', polarity: 'L',
    existing: max, reserved: 0n, available,
  })) };
}
const cart = () => createTransferCart(authority(), 'requestWarehouse', catalog());

it('restores a dynamic branch route without exposing another same-branch operator archive', () => {
  const a = authority(4);
  if (a.session?.authenticated) a.session.identity.account_id = 9007199254740991;
  const recovery = createTransferRecovery();
  const selected = reviewCart(addCartItem(createTransferCart(a, 'request:2', catalog(2)), a, 1, 2n), a, key);
  recovery.capture(() => a, selected);
  const flight = recovery.begin(() => a, recovery.getCurrent(() => a)!.handle);
  expect(recovery.markUnknown(flight)).toBe(true);
  const snapshot = recovery.getCurrent(() => a)!;
  expect(restoreTransferCart(a, catalog(2), snapshot).direction).toMatchObject({ origin_location_id: 2, destination_location_id: 4 });
  const other = authority(4);
  if (other.session?.authenticated) other.session.identity.account_id = 901;
  expect(recovery.getCurrent(() => other)).toBeNull();
  if (a.session?.authenticated) a.session.identity.must_change_password = true;
  expect(recovery.getCurrent(() => a)).toBeNull();
});

describe('W2 warehouse cart', () => {
  it.each(['directA', 'directB'] as const)('freezes and restores full int64 %s selection from warehouse only', flow => {
    const a = authority(1); const recovery = createTransferRecovery();
    const selected = reviewCart(addCartItem(createTransferCart(a, flow, catalog()), a, 1, max), a, key);
    expect(selected.direction).toMatchObject({ kind: 'direct_shipment', creator_location_id: 1, origin_location_id: 1,
      destination_location_id: flow === 'directA' ? 2 : 3, approver_location_id: 1 });
    recovery.capture(() => a, selected);
    const next = authority(1, 8); const snapshot = recovery.getCurrent(() => next)!;
    const restored = restoreTransferCart(next, catalog(1, 0), snapshot);
    expect(restored.lines[0].quantity).toBe(max);
    expect(restored.lines[0].available).toBeNull();
    expect(reviewCart(restored, next).attempt).toEqual(selected.attempt);
    expect(() => createTransferCart(a, flow, catalog(2))).toThrow();
    expect(() => createTransferCart(authority(2), flow, catalog())).toThrow();
    expect(() => createTransferCart(a, 'requestWarehouse', catalog())).toThrow();
  });
  it('rejects retained cart edits after a same-epoch session generation change', () => {
    const a = { ...authority(1), sessionGeneration: 1 };
    const selected = addCartItem(createTransferCart(a, 'directA', catalog()), a, 1, '1');
    const next = { ...a, sessionGeneration: 2 };
    expect(cartStatus(selected, next).usable).toBe(false);
    expect(() => setCartQuantity(selected, next, 1, '2')).toThrow();
  });
});

describe('R04b2c-hydration', () => {
  function snapshot() {
    const recovery = createTransferRecovery();
    const reviewed = reviewCart(addCartItem(addCartItem(cart(), authority(), 1, max), authority(), 2, max), authority(), key);
    recovery.capture(() => authority(), reviewed);
    return recovery.getCurrent(() => authority(2, 8))!;
  }
  it('restores factory-authorized same-owner fresh epoch with lossless immutable minimal data', () => {
    const input = snapshot();
    const source = catalog(1, 1, 2n);
    const state = restoreTransferCart(authority(2, 8), source, input);
    expect(state).toMatchObject({ epoch: 8, accountID: 2, assigned: 2, attempt: input.attempt });
    expect(state.attempt).not.toBe(input.attempt);
    expect(state.lines.map(v => [v.quantity, v.available])).toEqual([[max, 2n], [max, null]]);
    expect(cartStatus(state, authority(2, 8))).toEqual({ usable: true, ready: false, total: max * 2n, invalid: [1, 2] });
    expect(Object.keys(state.lines[0].item).sort()).toEqual(['brand', 'capacity_ah', 'catalog_entry_id', 'model', 'polarity', 'variant_id']);
    expect(state.lines[1].item.capacity_ah).toBe('6.000001');
    for (const value of [state, state.direction, state.catalog, state.catalog.location, state.catalog.rows, state.catalog.rows[0],
      state.lines, state.lines[0], state.lines[0].item, state.attempt, state.attempt!.items, state.attempt!.items[0]]) expect(Object.isFrozen(value)).toBe(true);
    expect(state.catalog).not.toBe(source);
  });
  it('copies mutable input without retaining stock or credential extras', () => {
    const original = snapshot();
    const items = original.items.map(v => ({ ...v, existing: max, csrf_token: 'not-retained' }));
    const attempt = { ...original.attempt, items: original.attempt.items.map(v => ({ ...v })) };
    const direction = { ...original.direction };
    const row = { ...catalog().rows[0] };
    const location = { id: 1, name: 'Physical source' };
    const state = restoreTransferCart(authority(2, 8), { location, rows: [row] }, { ...original, items, attempt, direction });
    items[0].brand = 'Changed'; attempt.items[0].quantity = '1'; direction.origin_location_id = 3;
    row.available = 0n; location.id = 3;
    expect(state.lines[0].item.brand).toBe('TOYO');
    expect(state.lines[0].item).not.toHaveProperty('csrf_token');
    expect(state.lines[0].item).not.toHaveProperty('existing');
    expect(state.lines[0].available).toBe(max);
    expect(state.attempt!.items[0].quantity).toBe(max.toString());
    expect(state.direction.origin_location_id).toBe(1);
    expect(state.catalog.location.id).toBe(1);
  });
  it.each(['stale', 'unready', 'anonymous', 'unsupported-role'] as const)('guards %s before private payload getters', mode => {
    const current = mode === 'unsupported-role' ? authority(32768, 8) : authority(2, 8);
    if (mode === 'unready') current.ready = false;
    if (mode === 'anonymous') current.session = { authenticated: false, csrf_token: 'blocked' };
    const payload = vi.fn((): never => { throw new Error('private payload'); });
    const input = { epoch: mode === 'stale' ? 7 : 8, get attempt(): never { return payload(); },
      get direction(): never { return payload(); }, get items(): never { return payload(); } };
    expect(() => restoreTransferCart(current, catalog(), input)).toThrow('Invalid transfer cart');
    expect(payload).not.toHaveBeenCalled();
  });
  it.each(['direction', 'counterparty', 'source', 'count', 'duplicate', 'membership', 'quantity', 'float', 'variant', 'entry', 'brand', 'model', 'capacity', 'polarity', 'catalog-descriptor'])(
    'rejects %s mismatch with sanitized errors', mode => {
      const original = snapshot();
      const input = { ...original, direction: { ...original.direction }, attempt: { ...original.attempt }, items: original.items.map(v => ({ ...v })) };
      let source = catalog();
      if (mode === 'direction') input.direction.approver_location_id = 3;
      if (mode === 'counterparty') input.attempt.counterparty_location_id = 2;
      if (mode === 'source') source = catalog(3);
      if (mode === 'count') input.items.pop();
      if (mode === 'duplicate') input.items[1] = { ...input.items[0] };
      if (mode === 'membership') input.items[0].variant_id = 3;
      if (mode === 'quantity') input.items[0].quantity = '1';
      if (mode === 'float') input.items[0].quantity = '1.5';
      if (mode === 'variant') input.items[0].variant_id = 191;
      if (mode === 'entry') input.items[0].catalog_entry_id = 96;
      if (mode === 'brand') input.items[0].brand = '';
      if (mode === 'model') input.items[0].model = '\0';
      if (mode === 'capacity') input.items[0].capacity_ah = '6.0';
      // @ts-expect-error deliberately invalid polarity
      if (mode === 'polarity') input.items[0].polarity = 'X';
      if (mode === 'catalog-descriptor') input.items[0].model = 'Different';
      expect(() => restoreTransferCart(authority(2, 8), source, input)).toThrow(/^Invalid transfer cart$/);
    });
  it.each([2, 3])('restores every physical route from assigned branch%s, not consulted stock', assigned => {
    for (const flow of ['requestWarehouse', 'requestOther', 'sendWarehouse'] as const) {
      const current = authority(assigned, 8);
      const source = catalog(flow === 'sendWarehouse' ? assigned : flow === 'requestOther' ? (assigned === 2 ? 3 : 2) : 1);
      const reviewed = reviewCart(addCartItem(createTransferCart(current, flow, source), current, 1, '2'), current, key);
      const recovery = createTransferRecovery(); recovery.capture(() => current, reviewed);
      expect(restoreTransferCart(current, source, recovery.getCurrent(() => current)!).direction).toEqual(reviewed.direction);
    }
  });
  it('preserves retries on guidance/no-op refresh and requires explicit edits then new review for RNG', () => {
    const current = authority(2, 8);
    const state = restoreTransferCart(current, catalog(1, 0), snapshot());
    const rng = vi.fn(() => newTransferRetryKey({ getRandomValues: array => array }));
    expect(setCartQuantity(state, current, 1, max)).toBe(state);
    expect(reviewCart(state, current, rng)).toBe(state);
    const refreshed = refreshCart(state, current, catalog());
    expect(refreshed.attempt).toBe(state.attempt);
    expect(rng).not.toHaveBeenCalled();
    const edited = setCartQuantity(refreshed, current, 1, '2');
    expect(edited.attempt).toBeNull();
    expect(reviewCart(edited, current, rng).attempt!.retry_key).toBe('0'.repeat(32));
    expect(rng).toHaveBeenCalledTimes(1);
    expect(() => removeCartItem(state, authority(2, 9), 1)).toThrow();
  });
});

describe('R04 transfer cart', () => {
  it.each([2, 3])('binds branch%s three flows to fixed physical source and approver', assigned => {
    const flows: TransferFlow[] = ['requestWarehouse', 'requestOther', 'sendWarehouse'];
    const origins = [1, assigned === 2 ? 3 : 2, assigned];
    flows.forEach((flow, i) => {
      const state = createTransferCart(authority(assigned), flow, catalog(origins[i]));
      expect(state.direction).toMatchObject({ creator_location_id: assigned, origin_location_id: origins[i],
        destination_location_id: flow === 'sendWarehouse' ? 1 : assigned,
        approver_location_id: flow === 'requestOther' ? origins[i] : 1 });
      expect(state.lines).toEqual([]);
      expect(state.epoch).toBe(7);
    });
  });
  it('refuses warehouse, unready, anonymous and foreign-source creation', () => {
    expect(() => createTransferCart(authority(1), 'requestWarehouse', catalog())).toThrow();
    expect(() => createTransferCart({ ...authority(), ready: false }, 'requestWarehouse', catalog())).toThrow();
    expect(() => createTransferCart({ epoch: 7, ready: true, session: null }, 'requestWarehouse', catalog())).toThrow();
    expect(() => createTransferCart(authority(), 'requestWarehouse', catalog(2))).toThrow();
  });
  it('retains exact descriptors, copies caller rows and never reserves or moves stocks', () => {
    const input = catalog();
    const initial = createTransferCart(authority(), 'requestWarehouse', input);
    const next = addCartItem(initial, authority(), 1, '9007199254740993');
    expect(next.lines[0]).toMatchObject({ quantity: 9007199254740993n, item: { brand: 'TOYO', model: 'Real model', capacity_ah: '6.000001', polarity: 'L', existing: max, reserved: 0n, available: max } });
    expect(input.rows[0].available).toBe(max);
    expect(initial.lines).toEqual([]);
    expect(next.catalog).not.toBe(input);
    expect(next.catalog.rows[0]).not.toBe(input.rows[0]);
    for (const value of [next, next.lines, next.lines[0], next.lines[0].item, next.direction, next.catalog, next.catalog.rows]) expect(Object.isFrozen(value)).toBe(true);
    expect(JSON.stringify({ epoch: next.epoch, accountID: next.accountID, assigned: next.assigned })).not.toContain('not-stored');
  });
  it('isolates cart state from later caller row/location mutations', () => {
    const owned = { ...catalog().rows[0] };
    const location = { id: 1, name: 'Physical source' };
    const selected = addCartItem(createTransferCart(authority(), 'requestWarehouse', { location, rows: [owned] }), authority(), 1, '2');
    owned.available = 0n;
    owned.brand = 'Changed';
    location.id = 3;
    expect(selected.lines[0].item.brand).toBe('TOYO');
    expect(selected.lines[0].available).toBe(max);
    expect(selected.catalog.location.id).toBe(1);
    expect(cartStatus(selected, authority()).ready).toBe(true);
  });
  it('deliberately increments duplicate adds as one line with checked int64 and availability', () => {
    const first = addCartItem(cart(), authority(), 1, '2');
    const second = addCartItem(first, authority(), 1, 3n);
    expect(second.lines).toHaveLength(1);
    expect(second.lines[0].quantity).toBe(5n);
    expect(() => addCartItem(second, authority(), 1, max)).toThrow();
    const small = createTransferCart(authority(), 'requestWarehouse', catalog(1, 1, 3n));
    expect(() => addCartItem(addCartItem(small, authority(), 1, '2'), authority(), 1, '2')).toThrow();
  });
  it.each(['0', '01', '-1', '1.1', '1e3', '+1', ' 1', '1 ', '9223372036854775808', '', '1,000'])('rejects noncanonical quantity %s', quantity => {
    const initial = cart();
    expect(() => setCartQuantity(initial, authority(), 1, quantity)).toThrow();
  });
  it('rejects numeric quantities, unknown/nonpositive IDs and zero bigint', () => {
    const initial = cart();
    // @ts-expect-error numeric input is intentionally unsupported
    expect(() => setCartQuantity(initial, authority(), 1, 9007199254740992)).toThrow();
    for (const id of [0, -1, 1.5, 3, 191, 2147483647]) expect(() => addCartItem(initial, authority(), id, '1')).toThrow();
    expect(() => setCartQuantity(initial, authority(), 1, 0n)).toThrow();
  });
  it('supports190 unique lines and unbounded bigint totals beyond int64', () => {
    let state = createTransferCart(authority(), 'requestWarehouse', catalog(1, 190));
    for (let id = 1; id <= 190; id++) state = addCartItem(state, authority(), id, max);
    expect(state.lines).toHaveLength(190);
    expect(cartStatus(state, authority())).toMatchObject({ usable: true, ready: true, total: max * 190n, invalid: [] });
    expect(reviewCart(state, authority(), key).attempt?.items).toHaveLength(190);
    expect(() => createTransferCart(authority(), 'requestWarehouse', catalog(1, 191))).toThrow();
  });
  it('removes explicitly, clears explicitly and starts a different source only as an empty new cart', () => {
    const selected = addCartItem(cart(), authority(), 1, '2');
    expect(removeCartItem(selected, authority(), 1).lines).toEqual([]);
    expect(clearTransferCart(selected, authority()).lines).toEqual([]);
    expect(() => setCartQuantity(selected, authority(), 1, '0')).toThrow();
    expect(() => refreshCart(selected, authority(), catalog(3))).toThrow();
    expect(createTransferCart(authority(), 'requestOther', catalog(3)).lines).toEqual([]);
    expect(selected.lines[0].quantity).toBe(2n);
  });
  it('keeps quantity and selected variant on refresh, marks insufficient/missing without resetting draft', () => {
    const selected = addCartItem(addCartItem(cart(), authority(), 1, '4'), authority(), 2, '3');
    const reduced = refreshCart(selected, authority(), catalog(1, 1, 2n));
    expect(reduced.lines.map(line => [line.item.variant_id, line.quantity, line.available])).toEqual([[1, 4n, 2n], [2, 3n, null]]);
    expect(reduced.direction).toBe(selected.direction);
    expect(cartStatus(reduced, authority())).toMatchObject({ usable: true, ready: false, invalid: [1, 2], total: 7n });
    expect(() => reviewCart(reduced, authority(), key)).toThrow();
    const edited = removeCartItem(setCartQuantity(reduced, authority(), 1, '2'), authority(), 2);
    expect(cartStatus(edited, authority()).ready).toBe(true);
    expect(selected.lines[0].available).toBe(max);
    const restored = refreshCart(reduced, authority(), catalog());
    expect(cartStatus(restored, authority()).ready).toBe(true);
    expect(restored.lines.map(line => line.quantity)).toEqual([4n, 3n]);
  });
  it('material edits invalidate frozen attempt; unchanged edits/back-to-review preserve exact key/payload', () => {
    const reviewed = reviewCart(addCartItem(cart(), authority(), 2, '2'), authority(), key);
    expect(Object.keys(reviewed.attempt!).sort()).toEqual(['counterparty_location_id', 'items', 'kind', 'retry_key']);
    expect(reviewed.attempt).toEqual({ kind: 'request_stock', counterparty_location_id: 1, retry_key: key, items: [{ variant_id: 2, quantity: '2' }] });
    expect(Object.isFrozen(reviewed.attempt)).toBe(true);
    const rng = vi.fn(() => 'another_secure_key_123');
    expect(reviewCart(reviewed, authority(), rng)).toBe(reviewed);
    expect(rng).not.toHaveBeenCalled();
    expect(setCartQuantity(reviewed, authority(), 2, '2')).toBe(reviewed);
    const edited = setCartQuantity(reviewed, authority(), 2, '3');
    expect(edited.attempt).toBeNull();
    expect(reviewCart(edited, authority(), rng).attempt?.retry_key).toBe('another_secure_key_123');
    expect(addCartItem(reviewed, authority(), 1, '1').attempt).toBeNull();
    expect(removeCartItem(reviewed, authority(), 2).attempt).toBeNull();
    expect(clearTransferCart(reviewed, authority()).attempt).toBeNull();
  });
  it('preserves uncertain retry attempts despite missing/insufficient availability; no new-attempt readiness claim', () => {
    const reviewed = reviewCart(addCartItem(cart(), authority(), 1, '5'), authority(), key);
    const reduced = refreshCart(reviewed, authority(), catalog(1, 0));
    expect(cartStatus(reduced, authority()).ready).toBe(false);
    expect(reduced.attempt).toBe(reviewed.attempt);
    expect(reviewCart(reduced, authority(), () => { throw new Error('must not regenerate'); })).toBe(reduced);
    expect(reviewed.attempt?.items[0].quantity).toBe('5');
  });
  it.each([2, 3])('freezes correct review routes for branch%s without actor/epoch/CSRF fields', assigned => {
    const actor = authority(assigned);
    for (const flow of ['requestWarehouse', 'requestOther', 'sendWarehouse'] as const) {
      const source = flow === 'sendWarehouse' ? assigned : flow === 'requestOther' ? (assigned === 2 ? 3 : 2) : 1;
      const selected = addCartItem(createTransferCart(actor, flow, catalog(source)), actor, 1, '1');
      expect(reviewCart(selected, actor, key).attempt).toEqual({ kind: flow === 'sendWarehouse' ? 'send_to_warehouse' : 'request_stock',
        counterparty_location_id: flow === 'requestOther' ? source : 1, retry_key: key, items: [{ variant_id: 1, quantity: '1' }] });
    }
  });
  it('sorts payload items and refuses empty or bad-key attempts', () => {
    const selected = addCartItem(addCartItem(cart(), authority(), 2, '2'), authority(), 1, '1');
    expect(reviewCart(selected, authority(), key).attempt?.items.map(line => line.variant_id)).toEqual([1, 2]);
    expect(() => reviewCart(cart(), authority(), key)).toThrow();
    expect(() => reviewCart(selected, authority(), 'short')).toThrow();
  });
  it('requires explicit review for secure RNG, fails closed without randomness and never posts', () => {
    const rng = vi.fn(() => newTransferRetryKey({ getRandomValues: () => { throw new Error('unavailable'); } }));
    const selected = addCartItem(cart(), authority(), 1, '1');
    expect(rng).not.toHaveBeenCalled();
    expect(() => reviewCart(selected, authority(), rng)).toThrow('Secure randomness unavailable');
    expect(selected.attempt).toBeNull();
    const secure = vi.fn(() => newTransferRetryKey({ getRandomValues: array => array }));
    expect(reviewCart(selected, authority(), secure).attempt?.retry_key).toBe('0'.repeat(32));
    expect(secure).toHaveBeenCalledTimes(1);
  });
  it.each(['epoch', 'account', 'assigned', 'unready', 'null-session', 'anonymous'] as const)('returns neutral status for %s authority without private totals or IDs', mismatch => {
    const selected = addCartItem(addCartItem(cart(), authority(), 1, max), authority(), 2, max);
    const state = refreshCart(selected, authority(), catalog(1, 1, 0n));
    const current = mismatch === 'epoch' ? authority(2, 8) : authority();
    if (current.session?.authenticated) {
      if (mismatch === 'account') current.session.identity.account_id = 99;
      if (mismatch === 'assigned') current.session.identity.location.id = 3;
    }
    if (mismatch === 'unready') current.ready = false;
    if (mismatch === 'null-session') current.session = null;
    if (mismatch === 'anonymous') current.session = { authenticated: false, csrf_token: 'bootstrap-blocked' };
    const status = cartStatus(state, current);
    expect(status).toEqual({ usable: false, ready: false, total: 0n, invalid: [] });
    expect(Object.isFrozen(status.invalid)).toBe(true);
    expect(cartStatus(state, authority())).toEqual({ usable: true, ready: false, total: max * 2n, invalid: [1, 2] });
  });
  it('returns neutral status before accessing any obsolete cart lines', () => {
    const state = { ...cart(), get lines(): never { throw new Error('Private lines accessed'); } };
    const status = cartStatus(state, authority(2, 8));
    expect(status).toEqual({ usable: false, ready: false, total: 0n, invalid: [] });
    expect(Object.isFrozen(status.invalid)).toBe(true);
  });
  it('guards current epoch, account, assigned actor and readiness on every operation including retry', () => {
    const state = reviewCart(addCartItem(cart(), authority(), 1, '1'), authority(), key);
    const otherAccount = authority();
    if (otherAccount.session?.authenticated) otherAccount.session.identity.account_id = 99;
    for (const current of [authority(2, 8), authority(3), { ...authority(), ready: false }, otherAccount]) {
      expect(cartStatus(state, current)).toMatchObject({ usable: false, ready: false });
      for (const operation of [() => addCartItem(state, current, 1, '1'), () => setCartQuantity(state, current, 1, '1'),
        () => removeCartItem(state, current, 1), () => clearTransferCart(state, current), () => refreshCart(state, current, catalog()), () => reviewCart(state, current, key)]) expect(operation).toThrow();
    }
  });
});
