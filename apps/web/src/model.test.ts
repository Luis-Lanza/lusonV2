import { describe, expect, it } from 'vitest';
import { groupItems, initialQuery, parseInventory, parseMetadata, parseSession, queryURL, validSearch } from './model';

import { pageJSON, rowJSON as row } from './test-fixtures';

describe('lossless contract', () => {
  it('retains raw numeric tokens, bigint quantities and canonical decimal text', () => {
    const item = parseInventory(pageJSON()).items[0];
    expect(item.existing).toBe(9007199254740993n);
    expect(item.available).toBe(9007199254740992n);
    expect(item.capacity_ah).toBe('6.5');
    expect(parseInventory(pageJSON(row.replace('6.5', '6.500000'))).items[0].capacity_ah).toBe('6.5');
  });
  it.each(['-1', '9223372036854775808', '1.1', '1e3', '"9"', 'null'])('rejects malformed quantity %s', token => {
    expect(() => parseInventory(pageJSON(row.replace('9007199254740993', token)))).toThrow();
  });
  it.each(['0', '-6.5', '"6.5"', '6.5e1', 'null'])('rejects malformed capacity %s', token => {
    expect(() => parseInventory(pageJSON(row.replace('6.5', token)))).toThrow();
  });
  it('supports int64 maximum, exact tiny capacity, malformed JSON and wrong shapes', () => {
    expect(parseInventory(pageJSON(row.replace('9007199254740993', '9223372036854775807'))).items[0].existing).toBe(9223372036854775807n);
    expect(parseInventory(pageJSON(row.replace('6.5', '0.000001'))).items[0].capacity_ah).toBe('0.000001');
    for (const raw of ['{', 'null', '[]', pageJSON().replace('"items":[', '"items":null,"discard":['), pageJSON().replace('"page_size":10', '"page_size":11')]) expect(() => parseInventory(raw)).toThrow('Respuesta inválida');
  });
  it('checks bounded IDs, pages/counts, duplicate variants and polarity', () => {
    for (const raw of [pageJSON().replace('"id":1', '"id":32768'), pageJSON().replace('"page":1', '"page":1000001'),
      pageJSON().replace('"total_variants":190', '"total_variants":9007199254740993'),
      pageJSON(row + ',' + row), pageJSON(row.replace('"L"', '"X"'))]) {
      expect(() => parseInventory(raw)).toThrow();
    }
  });
  it('accepts anonymous session without expires, requires real authenticated identity', () => {
    expect(parseSession('{"authenticated":false,"csrf_token":"' + 'a'.repeat(43) + '"}')).toEqual({ authenticated: false, csrf_token: 'a'.repeat(43) });
    expect(() => parseSession('{"authenticated":true,"csrf_token":"x"}')).toThrow();
    expect(() => parseMetadata('{"locations":[],"brands":[]}')).toThrow();
  });
});

describe('dynamic branch sessions', () => {
  const session = { authenticated: true, csrf_token: 'a'.repeat(43), expires_at: '2030-01-01T00:00:00Z',
    identity: { account_id: 900, username: 'operator', display_name: 'Operador C', must_change_password: false,
      location: { id: 4, name: 'Sucursal C' } } };
  it('decodes independent safe account IDs and explicit password state', () => {
    expect(parseSession(JSON.stringify(session))).toEqual(session);
    expect(parseSession(JSON.stringify({ ...session, identity: { ...session.identity, must_change_password: true } }))).toMatchObject({ identity: { must_change_password: true } });
    for (const value of [undefined, null, 'false']) {
      expect(() => parseSession(JSON.stringify({ ...session, identity: { ...session.identity, must_change_password: value } }))).toThrow();
    }
    for (const account_id of [0, 9007199254740992]) expect(() => parseSession(JSON.stringify({ ...session, identity: { ...session.identity, account_id } }))).toThrow();
  });
  it('accepts fourth-branch metadata while preserving unique existing identities', () => {
    const locations = [{ id: 1, name: 'Almacén' }, { id: 2, name: 'Sucursal A' }, { id: 3, name: 'Sucursal B' }, session.identity.location];
    expect(parseMetadata(JSON.stringify({ locations, brands: ['TOYO'] })).locations).toEqual(locations);
    expect(parseMetadata(JSON.stringify({ locations: locations.slice(0, 3), brands: ['TOYO'] })).locations).toHaveLength(3);
    expect(() => parseMetadata(JSON.stringify({ locations: [...locations, locations[3]], brands: ['TOYO'] }))).toThrow();
  });
});

describe('consultation mapping', () => {
  it('omits empty filters, preserves literal Unicode/search and maps exact brand + polarity', () => {
    const q = initialQuery(2);
    expect(queryURL(q)).toBe('/api/inventory?location_id=2&page=1&page_size=10');
    const u = new URL(queryURL({ ...q, search: 'á_%\\', brand: 'TOYO', polarity: 'R', page: 2, size: 25 }), 'http://localhost');
    expect(Object.fromEntries(u.searchParams)).toEqual({ location_id: '2', page: '2', page_size: '25', search: 'á_%\\', brand: 'TOYO', polarity: 'R' });
  });
  it('bounds UTF-8 bytes rather than code units and rejects NUL/unpaired surrogates', () => {
    expect(validSearch('á'.repeat(64))).toBe(true);
    expect(validSearch('á'.repeat(65))).toBe(false);
    expect(validSearch('a\0')).toBe(false);
    expect(validSearch('\ud800')).toBe(false);
  });
  it('groups only present page variants in catalog and variant order, including singleton', () => {
    const item = parseInventory(pageJSON()).items[0];
    const items = [item, { ...item, variant_id: 2, polarity: 'R' as const }, { ...item, catalog_entry_id: 2, variant_id: 3 }];
    expect(groupItems(items).map(g => g.map(i => i.variant_id))).toEqual([[1, 2], [3]]);
    expect(groupItems([items[1]])[0]).toEqual([items[1]]);
  });
});
