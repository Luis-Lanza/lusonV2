import { describe, expect, it, vi } from 'vitest';
import type { TransferAuthority } from './useInventory';
import type { TransferCart } from './transferCart';
import { createTransferCart, setCartQuantity, reviewCart } from './transferCart';
import { createTransferRecovery } from './transferRecovery';

const key = 'private_retry_key_1234';
const max = '9223372036854775807';
function authority(account = 2, assigned = 2, epoch = 7): TransferAuthority {
  return { ready: true, epoch, session: { authenticated: true, csrf_token: 'secret-current', expires_at: '2030-01-01T00:00:00Z',
    identity: { account_id: account, username: 'private-user', location: { id: assigned, name: 'Assigned' } } } };
}
function reviewed(a = authority(), count = 2): TransferCart {
  const rows = Array.from({ length: count }, (_, i) => ({ variant_id: i + 1, catalog_entry_id: Math.ceil((i + 1) / 2),
    brand: 'TOYO', model: 'Model', capacity_ah: '6.000001', polarity: 'L' as const, existing: BigInt(max), reserved: 0n, available: BigInt(max) }));
  let cart = createTransferCart(a, a.session?.authenticated && a.session.identity.location.id === 1 ? 'directA' : 'requestWarehouse', { location: { id: 1, name: 'Warehouse' }, rows });
  for (const row of rows) cart = setCartQuantity(cart, a, row.variant_id, max);
  return reviewCart(cart, a, key);
}

describe('W2 warehouse recovery fences', () => {
  it('releases only the warehouse flight while two branches retain unresolved attempts', () => {
    const cache = createTransferRecovery();
    const owners = [authority(), authority(3, 3), authority(1, 1)];
    const tokens = owners.map(a => cache.begin(() => a, cache.capture(() => a, reviewed(a))));
    expect(cache.confirmSuccess(() => owners[0], tokens[2])).toBe(false);
    expect(cache.confirmSuccess(() => owners[2], tokens[2])).toBe(true);
    expect(cache.getCurrent(() => owners[2])).toBeNull();
    for (const a of owners.slice(0, 2)) expect(cache.getCurrent(() => a)?.phase).toBe('inFlight');
    const replacement = authority(99, 1);
    cache.capture(() => replacement, reviewed(replacement));
    expect(cache.markUnknown(tokens[2])).toBe(false);
    expect(cache.getCurrent(() => replacement)?.phase).toBe('ready');
  });
  it('retains an uncertain immutable warehouse attempt after same-epoch reauthentication', () => {
    const cache = createTransferRecovery(); let a = { ...authority(1, 1), sessionGeneration: 1 };
    const get = () => a; const handle = cache.capture(get, reviewed(a)); const flight = cache.begin(get, handle);
    a = { ...a, sessionGeneration: 2 };
    expect(cache.confirmSuccess(get, flight)).toBe(false);
    expect(cache.getCurrent(get)).toMatchObject({ phase: 'unknown', handle, attempt: { kind: 'direct_shipment' } });
    expect(cache.markUnknown(flight)).toBe(false);
    const retry = cache.begin(get, handle);
    expect(cache.confirmSuccess(get, flight)).toBe(false);
    expect(cache.confirmSuccess(get, retry)).toBe(true);
  });
});

describe('Transfer recovery R04b2c1', () => {
  it('recovers exact A attempt after B and a fresh verified A epoch', () => {
    const cache = createTransferRecovery(); let current = authority(); const get = () => current;
    const handle = cache.capture(get, reviewed()); const flight = cache.begin(get, handle);
    expect(cache.markUnknown(flight)).toBe(true);
    current = authority(3, 3); expect(cache.getCurrent(get)).toBeNull();
    const b = cache.capture(get, reviewed(current)); expect(b).not.toBe(handle);
    current = authority(2, 2, 9);
    expect(cache.getCurrent(get)).toMatchObject({ epoch: 9, phase: 'unknown', handle, attempt: { retry_key: key, items: [
      { variant_id: 1, quantity: max }, { variant_id: 2, quantity: max }] } });
  });
  it.each(['anonymous', 'unready', 'warehouse', 'account', 'assigned', 'epoch'])('guards %s before private cart getters', reason => {
    const cache = createTransferRecovery(); const a = authority();
    const hidden = { epoch: 7, accountID: 2, assigned: 2, get attempt() { throw new Error('private'); },
      get lines() { throw new Error('private'); } } as unknown as TransferCart;
    const get = vi.fn(() => reason === 'anonymous' ? { ...a, session: null } : reason === 'unready' ? { ...a, ready: false }
      : reason === 'warehouse' ? authority(1, 1) : reason === 'account' ? authority(99) : reason === 'assigned' ? authority(2, 3) : authority(2, 2, 8));
    expect(cache.getCurrent(get)).toBeNull();
    expect(() => cache.capture(get, hidden)).toThrow('Transfer recovery unavailable');
    expect(get).toHaveBeenCalledTimes(2);
  });
  it('never reads private snapshot getters for foreign, unready or warehouse authority', () => {
    const cache = createTransferRecovery(); const handle = cache.capture(() => authority(), reviewed());
    const probe = vi.fn(() => { throw new Error('private'); });
    const hidden = { epoch: 7, accountID: 2, assigned: 2, get attempt() { return probe(); }, get lines() { return probe(); } } as unknown as TransferCart;
    for (const a of [authority(99), authority(2, 3), authority(1, 1), { ...authority(), ready: false }, { ...authority(), session: null }]) {
      const value = cache.getCurrent(() => a) ?? null;
      expect(() => cache.capture(() => a, hidden)).toThrow('Transfer recovery unavailable');
      expect(value).toBeNull(); expect(cache.discardCurrent(() => a, handle, true)).toBe(false);
    }
    expect(probe).not.toHaveBeenCalled();
  });
  it('reads latest same-object authority mutations rather than cached readiness', () => {
    const cache = createTransferRecovery(); const a = authority(); const get = () => a;
    const handle = cache.capture(get, reviewed(a)); a.ready = false;
    expect(cache.getCurrent(get)).toBeNull(); expect(() => cache.begin(get, handle)).toThrow();
    a.ready = true; a.epoch = 8; a.session!.csrf_token = 'fresh-secret';
    expect(cache.getCurrent(get)?.epoch).toBe(8);
  });
  it('copies and freezes only minimal descriptors and canonical payload without stock or auth', () => {
    const cache = createTransferRecovery(); const original = reviewed();
    const item = { ...original.lines[0].item }; const input = { ...original.attempt!, items: original.attempt!.items.map(v => ({ ...v })).reverse() };
    const cart = { ...original, attempt: input, lines: [{ ...original.lines[0], item }, original.lines[1]], direction: { ...original.direction } };
    cache.capture(() => authority(), cart); item.brand = 'mutated'; input.items[0].quantity = '1'; cart.direction.origin_location_id = 3;
    const s = cache.getCurrent(() => authority())!;
    expect(s.items[0]).toEqual({ variant_id: 1, catalog_entry_id: 1, brand: 'TOYO', model: 'Model', capacity_ah: '6.000001', polarity: 'L', quantity: max });
    expect(s.attempt.items.map(v => v.variant_id)).toEqual([1, 2]);
    for (const value of [s, s.handle, s.items, ...s.items, s.attempt, s.attempt.items, ...s.attempt.items, s.direction]) expect(Object.isFrozen(value)).toBe(true);
    const json = JSON.stringify(s);
    for (const forbidden of ['existing', 'reserved', 'available', 'catalog"', 'secret-current', 'private-user', 'session', 'csrf']) expect(json).not.toContain(forbidden);
    expect(Object.keys(s.handle)).toEqual([]);
  });
  it('requires existing review, uses no randomness and reads no availability on retries', () => {
    const cache = createTransferRecovery(); const cart = reviewed();
    expect(() => cache.capture(() => authority(), { ...cart, attempt: null })).toThrow();
    const random = vi.spyOn(crypto, 'getRandomValues');
    const noStock = { ...cart, lines: cart.lines.map(line => ({ ...line, get available(): bigint { throw new Error('stock'); },
      item: { ...line.item, get available(): bigint { throw new Error('stock'); }, get existing(): bigint { throw new Error('stock'); } } })) };
    const handle = cache.capture(() => authority(), noStock);
    const flight = cache.begin(() => authority(), handle); cache.markUnknown(flight);
    expect(cache.capture(() => authority(), noStock)).toBe(handle);
    expect(cache.getCurrent(() => authority())?.phase).toBe('unknown');
    expect(random).not.toHaveBeenCalled(); random.mockRestore();
  });
  it.each(['0', '01', '1.5', '9223372036854775808'])('rejects invalid canonical quantity %s without replacing original', quantity => {
    const cache = createTransferRecovery(); const cart = reviewed(); const handle = cache.capture(() => authority(), cart);
    const attempt = { ...cart.attempt!, items: [{ variant_id: 1, quantity }] };
    expect(() => cache.capture(() => authority(), { ...cart, attempt })).toThrow('Transfer recovery unavailable');
    expect(cache.getCurrent(() => authority())?.handle).toBe(handle);
  });
  it('preserves unresolved entries on conflicting key, content, source or variant metadata', () => {
    const cache = createTransferRecovery(); const cart = reviewed(); const handle = cache.capture(() => authority(), cart);
    const conflicts = [
      { ...cart, attempt: { ...cart.attempt!, retry_key: 'different_retry_key_123' } },
      { ...cart, attempt: { ...cart.attempt!, items: [{ variant_id: 1, quantity: '1' }, cart.attempt!.items[1]] }, lines: [{ ...cart.lines[0], quantity: 1n }, cart.lines[1]] },
      { ...cart, direction: { ...cart.direction, origin_location_id: 2 as const } },
      { ...cart, catalog: { ...cart.catalog, location: { id: 2, name: 'wrong' } } },
      { ...cart, lines: [{ ...cart.lines[0], item: { ...cart.lines[0].item, variant_id: NaN } }, cart.lines[1]] },
      { ...cart, attempt: { ...cart.attempt!, counterparty_location_id: 2 as const } },
    ];
    for (const conflict of conflicts) expect(() => cache.capture(() => authority(), conflict)).toThrow('Transfer recovery unavailable');
    expect(cache.getCurrent(() => authority())?.handle).toBe(handle);
    expect(cache.capture(() => authority(), cart)).toBe(handle);
  });
  it('rejects malformed kinds, duplicate IDs, fractional IDs and oversized cardinality', () => {
    const cache = createTransferRecovery(); const cart = reviewed();
    const attempts = [
      { ...cart.attempt!, kind: 'unknown' },
      { ...cart.attempt!, items: [cart.attempt!.items[0], cart.attempt!.items[0]] },
      { ...cart.attempt!, items: [{ variant_id: 1.5, quantity: '1' }] },
      { ...cart.attempt!, items: Array.from({ length: 191 }, (_, i) => ({ variant_id: i + 1, quantity: '1' })) },
    ];
    for (const attempt of attempts) expect(() => cache.capture(() => authority(), { ...cart, attempt } as TransferCart)).toThrow('Transfer recovery unavailable');
    expect(cache.getCurrent(() => authority())).toBeNull();
  });
  it('retains all 190 exact int64 lines and unbounded aggregate without numeric coercion', () => {
    const cache = createTransferRecovery(); cache.capture(() => authority(), reviewed(authority(), 190));
    const s = cache.getCurrent(() => authority())!;
    expect(s.items).toHaveLength(190); expect(s.items[189].variant_id).toBe(190);
    expect(s.items.reduce((sum, v) => sum + BigInt(v.quantity), 0n)).toBe(BigInt(max) * 190n);
  });
  it('uses new retry tokens, denies busy destruction and ignores all stale callbacks', () => {
    const cache = createTransferRecovery(); const get = () => authority(); const handle = cache.capture(get, reviewed());
    const first = cache.begin(get, handle);
    expect(cache.getCurrent(get)?.phase).toBe('inFlight');
    expect(() => cache.begin(get, handle)).toThrow(); expect(cache.discardCurrent(get, handle, true)).toBe(false);
    expect(cache.capture(get, reviewed())).toBe(handle);
    expect(cache.markUnknown(first)).toBe(true); expect(cache.confirmSuccess(get, first)).toBe(false);
    const retry = cache.begin(get, handle); expect(retry).not.toBe(first); expect(Object.keys(retry)).toEqual([]);
    expect(cache.markUnknown(first)).toBe(false); expect(cache.confirmSuccess(get, first)).toBe(false);
    expect(cache.confirmSuccess(get, retry)).toBe(true); expect(cache.getCurrent(get)).toBeNull();
    const replacement = cache.capture(get, reviewed()); expect(replacement).not.toBe(handle);
    expect(cache.markUnknown(retry)).toBe(false); expect(cache.confirmSuccess(get, retry)).toBe(false);
    expect(cache.discardCurrent(get, handle, true)).toBe(false);
  });
  it('records uncertain A callback while B active without affecting B or returning payload', () => {
    const cache = createTransferRecovery(); let a = authority(); const get = () => a;
    const handle = cache.capture(get, reviewed()); const flight = cache.begin(get, handle);
    a = authority(3, 3); const b = cache.capture(get, reviewed(a));
    expect(cache.confirmSuccess(get, flight)).toBe(false); expect(cache.markUnknown(flight)).toBe(true);
    expect(cache.getCurrent(get)).toMatchObject({ handle: b, phase: 'ready' });
    a = authority(2, 2, 9); expect(cache.getCurrent(get)).toMatchObject({ handle, phase: 'unknown' });
  });
  it('turns previous-epoch pending into unknown and requires manual begin to clear', () => {
    const cache = createTransferRecovery(); let a = authority(); const get = () => a;
    const handle = cache.capture(get, reviewed()); const old = cache.begin(get, handle);
    a = authority(2, 2, 8); expect(cache.confirmSuccess(get, old)).toBe(false);
    expect(cache.getCurrent(get)).toMatchObject({ handle, phase: 'unknown', epoch: 8 });
    expect(cache.markUnknown(old)).toBe(false); expect(cache.discardCurrent(get, handle, false)).toBe(false);
    const retry = cache.begin(get, handle); expect(cache.confirmSuccess(get, old)).toBe(false);
    expect(cache.confirmSuccess(get, retry)).toBe(true);
  });
  it('requires explicit true acknowledgement for unknown discard and allows ready discard', () => {
    const cache = createTransferRecovery(); const get = () => authority(); let handle = cache.capture(get, reviewed());
    expect(cache.discardCurrent(get, handle, false)).toBe(true);
    handle = cache.capture(get, reviewed()); cache.markUnknown(cache.begin(get, handle));
    expect(cache.discardCurrent(get, handle, false)).toBe(false);
    expect(cache.discardCurrent(get, handle, true)).toBe(true); expect(cache.getCurrent(get)).toBeNull();
  });
  it('keeps three owners including warehouse without eviction and gives generic capacity failure', () => {
    const cache = createTransferRecovery();
    const owners = [authority(), authority(3, 3), authority(1, 1)];
    for (const a of owners) {
      const handle = cache.capture(() => a, reviewed(a));
      cache.markUnknown(cache.begin(() => a, handle));
    }
    const fourth = authority(99, 2);
    expect(cache.getCurrent(() => fourth)).toBeNull();
    expect(() => cache.capture(() => fourth, reviewed(fourth))).toThrow('Transfer recovery unavailable');
    for (const a of owners) expect(cache.getCurrent(() => a)).toMatchObject({ phase: 'unknown', attempt: { retry_key: key } });
    expect(Object.keys(cache).sort()).toEqual(['begin', 'capture', 'confirmSuccess', 'discardCurrent', 'getCurrent', 'markUnknown']);
  });
  it('isolates instances and rejects forged or foreign opaque handles and tokens', () => {
    const cache = createTransferRecovery(); const other = createTransferRecovery(); const get = () => authority();
    const handle = cache.capture(get, reviewed()); const flight = cache.begin(get, handle);
    expect(other.getCurrent(get)).toBeNull();
    for (const invalid of [{}, handle]) expect(() => other.begin(get, invalid)).toThrow();
    expect(other.markUnknown(flight)).toBe(false); expect(other.confirmSuccess(get, flight)).toBe(false);
    expect(other.discardCurrent(get, handle, true)).toBe(false); expect(cache.markUnknown({})).toBe(false);
    expect(cache.getCurrent(() => { throw new Error('private authority'); })).toBeNull();
  });
});
