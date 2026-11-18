import { describe, expect, it } from 'vitest';
import { groupItems, initialQuery, parseInventory, parseMetadata, parseSession, queryURL, validSearch } from './model';

// The stock wire is the variant identity plus its three stock numbers, one shape
// for both kinds: a battery row carries its battery attributes and no typed
// field, a product row the other way round. The quantities stay raw tokens.
const rowJSON = '{"variant_id":1,"catalog_entry_id":1,"kind":"battery","name":"TOYO · A_%\\\\","detail":"6.5 Ah · L","battery":{"brand":"TOYO","model":"A_%\\\\","capacity_ah":"6.5","polarity":"L"},"fields":null,"existing":9007199254740993,"reserved":1,"available":9007199254740992}';
const pageJSON = (items = rowJSON, page = 1, total = 190) => `{"location":{"id":1,"name":"Almacén"},"items":[${items}],"page":${page},"page_size":10,"total_variants":${total}}`;

type Wire = Record<string, unknown>;
const batteryWire = (patch: Wire = {}): Wire => ({ variant_id: 1, catalog_entry_id: 1, kind: 'battery', name: 'CAR · NS40ZL', detail: '35 Ah · L',
  battery: { brand: 'CAR', model: 'NS40ZL', capacity_ah: '35', polarity: 'L' }, fields: null,
  existing: 13, reserved: 2, available: 11, ...patch });
const productWire = (patch: Wire = {}): Wire => ({ variant_id: 210, catalog_entry_id: 96, kind: 'other', name: 'Agua acidulada',
  detail: 'volumen en L: 5 L', battery: null,
  fields: [{ name: 'volumen en L', kind: 'number', unit: 'L', number: '5' }],
  existing: 8, reserved: 0, available: 8, ...patch });
const wirePage = (...items: Wire[]) =>
  `{"location":{"id":1,"name":"Almacén"},"items":${JSON.stringify(items)},"page":1,"page_size":10,"total_variants":${items.length}}`;

describe('lossless contract', () => {
  it('retains raw numeric tokens, bigint quantities and the canonical decimal text', () => {
    const item = parseInventory(pageJSON()).items[0];
    expect(item.existing).toBe(9007199254740993n);
    expect(item.available).toBe(9007199254740992n);
    expect(item.kind).toBe('battery');
    expect(item.name).toBe('TOYO · A_%\\');
    expect(item.detail).toBe('6.5 Ah · L');
    expect(item.battery).toEqual({ brand: 'TOYO', model: 'A_%\\', capacity_ah: '6.5', polarity: 'L' });
    expect(item.fields).toBeNull();
  });
  it.each(['-1', '9223372036854775808', '1.1', '1e3', '"9"', 'null'])('rejects malformed quantity %s', token => {
    expect(() => parseInventory(pageJSON(rowJSON.replace('9007199254740993', token)))).toThrow();
  });
  it.each(['"0"', '"-6.5"', '6.5', 'null', '"6.5e1"', '""', '"6.500000"', '"06.5"'])('rejects malformed capacity %s', token => {
    expect(() => parseInventory(pageJSON(rowJSON.replace('"capacity_ah":"6.5"', '"capacity_ah":' + token)))).toThrow();
  });
  it('supports int64 maximum, exact tiny capacity, malformed JSON and wrong shapes', () => {
    expect(parseInventory(pageJSON(rowJSON.replace('9007199254740993', '9223372036854775807'))).items[0].existing).toBe(9223372036854775807n);
    expect(parseInventory(pageJSON(rowJSON.replace('"capacity_ah":"6.5"', '"capacity_ah":"0.000001"'))).items[0].battery?.capacity_ah).toBe('0.000001');
    expect(parseInventory(pageJSON(rowJSON.replace('"capacity_ah":"6.5"', '"capacity_ah":"999999.999999"'))).items[0].battery?.capacity_ah).toBe('999999.999999');
    for (const raw of ['{', 'null', '[]', pageJSON().replace('"items":[', '"items":null,"discard":['), pageJSON().replace('"page_size":10', '"page_size":11')]) expect(() => parseInventory(raw)).toThrow('Respuesta inválida');
  });
  it('accepts allocated variant and catalogue identities past the preloaded fixture', () => {
    // Identities 191+ / 96+ are allocated by the database once the catalog is
    // operational data, so the page parser must not keep the fixture's bounds.
    const item = parseInventory(pageJSON(rowJSON.replace('"variant_id":1', '"variant_id":191').replace('"catalog_entry_id":1', '"catalog_entry_id":96'))).items[0];
    expect(item.variant_id).toBe(191);
    expect(item.catalog_entry_id).toBe(96);
    expect(parseInventory(pageJSON(rowJSON, 1, 1)).items[0].variant_id).toBe(1);
  });
  it('checks bounded IDs, pages/counts, duplicate variants and polarity', () => {
    for (const raw of [pageJSON().replace('"id":1', '"id":32768'), pageJSON().replace('"page":1', '"page":1000001'),
      pageJSON().replace('"total_variants":190', '"total_variants":9007199254740993'),
      pageJSON(rowJSON + ',' + rowJSON), pageJSON(rowJSON.replace('"polarity":"L"', '"polarity":"X"'))]) {
      expect(() => parseInventory(raw)).toThrow();
    }
  });
  it('accepts anonymous session without expires, requires real authenticated identity', () => {
    expect(parseSession('{"authenticated":false,"csrf_token":"' + 'a'.repeat(43) + '"}')).toEqual({ authenticated: false, csrf_token: 'a'.repeat(43) });
    expect(() => parseSession('{"authenticated":true,"csrf_token":"x"}')).toThrow();
    expect(() => parseMetadata('{"locations":[],"brands":[]}')).toThrow();
  });
});

describe('the two kinds of one stock list', () => {
  it('parses a battery row and a product row of the same page', () => {
    const page = parseInventory(wirePage(batteryWire(), productWire()));
    const [battery, product] = page.items;
    expect(battery).toEqual({ variant_id: 1, catalog_entry_id: 1, kind: 'battery', name: 'CAR · NS40ZL', detail: '35 Ah · L',
      battery: { brand: 'CAR', model: 'NS40ZL', capacity_ah: '35', polarity: 'L' }, fields: null,
      existing: 13n, reserved: 2n, available: 11n });
    expect(product).toEqual({ variant_id: 210, catalog_entry_id: 96, kind: 'other', name: 'Agua acidulada', detail: 'volumen en L: 5 L',
      battery: null, fields: [{ name: 'volumen en L', kind: 'number', unit: 'L', number: '5' }],
      existing: 8n, reserved: 0n, available: 8n });
  });
  it('parses a product without typed fields and a text field without unit', () => {
    const page = parseInventory(wirePage(
      productWire({ fields: [{ name: 'presentación', kind: 'text', text: 'paquete' }] }),
      productWire({ variant_id: 211, name: 'Trapos de limpieza', detail: 'Trapos de limpieza', fields: [] })));
    expect(page.items[0].fields).toEqual([{ name: 'presentación', kind: 'text', text: 'paquete' }]);
    expect(page.items[1].fields).toEqual([]);
  });
  it.each([
    ['an unknown key', batteryWire({ brand: 'CAR' })],
    ['a battery row without its catalogue entry', (({ catalog_entry_id, ...rest }) => rest)(batteryWire())],
    ['a missing key', (({ detail, ...rest }) => rest)(batteryWire())],
    ['a battery row without its battery', batteryWire({ battery: null })],
    ['a battery row carrying typed fields', batteryWire({ fields: [] })],
    ['a product row carrying a battery', productWire({ battery: batteryWire().battery })],
    ['a product row without a field array', productWire({ fields: null })],
    ['an empty name', batteryWire({ name: '' })],
    ['an empty detail', batteryWire({ detail: '' })],
    ['an unknown kind', batteryWire({ kind: 'gift' })],
    ['a battery without a brand', batteryWire({ battery: { brand: '', model: 'NS40ZL', capacity_ah: '35', polarity: 'L' } })],
    ['a battery with an unknown key', batteryWire({ battery: { brand: 'CAR', model: 'NS40ZL', capacity_ah: '35', polarity: 'L', speed: '1' } })],
    ['a field of an unknown kind', productWire({ fields: [{ name: 'x', kind: 'money', text: '1' }] })],
    ['a number field carrying text', productWire({ fields: [{ name: 'x', kind: 'number', number: '1', text: '1' }] })],
    ['a number field without a value', productWire({ fields: [{ name: 'x', kind: 'number', unit: 'L' }] })],
    ['a field with an empty name', productWire({ fields: [{ name: '', kind: 'text', text: '1' }] })],
    ['a noncanonical field number', productWire({ fields: [{ name: 'x', kind: 'number', number: '005.50' }] })],
  ])('rejects %s', (_label, row) => {
    expect(() => parseInventory(wirePage(row))).toThrow('Respuesta inválida');
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
  const locations = [{ id: 1, name: 'Almacén' }, { id: 2, name: 'Sucursal A' }, { id: 3, name: 'Sucursal B' }, session.identity.location];
  it.each([
    { label: '[1]', activeIDs: [1] },
    { label: '[1,2]', activeIDs: [1, 2] },
    { label: '[1,3]', activeIDs: [1, 3] },
  ])('safe retirement metadata accepts active IDs $label', ({ activeIDs }) => {
    const activeLocations = locations.filter(location => activeIDs.includes(location.id));
    const brands = ['TOYO'];
    const metadata = parseMetadata(JSON.stringify({ locations: activeLocations, brands }));

    expect(metadata.locations).toEqual(activeLocations);
    expect(metadata.locations[0]).toEqual({ id: 1, name: 'Almacén' });
    expect(metadata.brands).toEqual(brands);
  });
  it('accepts fourth-branch metadata while preserving unique existing identities', () => {
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
  it('sends the kind state and never the battery attributes of a product listing', () => {
    const q = initialQuery(1, 'all');
    expect(new URL(queryURL(q), 'http://localhost').searchParams.get('kind')).toBe('all');
    const product = new URL(queryURL({ ...q, kind: 'other', brand: 'TOYO', polarity: 'L', search: 'agua' }), 'http://localhost');
    expect(Object.fromEntries(product.searchParams)).toEqual({ location_id: '1', page: '1', page_size: '10', kind: 'other', search: 'agua' });
    const battery = new URL(queryURL({ ...q, kind: 'battery', brand: 'TOYO', polarity: 'L' }), 'http://localhost');
    expect(Object.fromEntries(battery.searchParams)).toEqual({ location_id: '1', page: '1', page_size: '10', kind: 'battery', brand: 'TOYO', polarity: 'L' });
  });
  it('bounds UTF-8 bytes rather than code units and rejects NUL/unpaired surrogates', () => {
    expect(validSearch('á'.repeat(64))).toBe(true);
    expect(validSearch('á'.repeat(65))).toBe(false);
    expect(validSearch('a\0')).toBe(false);
    expect(validSearch('\ud800')).toBe(false);
  });
  it('groups only present page variants by their identity, including singleton', () => {
    const [battery] = parseInventory(pageJSON()).items;
    const items = [battery, { ...battery, variant_id: 2, detail: '6.5 Ah · R', battery: { ...battery.battery!, polarity: 'R' as const } },
      parseInventory(wirePage(productWire())).items[0]];
    expect(groupItems(items).map(g => g.map(i => i.variant_id))).toEqual([[1, 2], [210]]);
    expect(groupItems([items[1]])[0]).toEqual([items[1]]);
  });
});
