import { describe, expect, it } from 'vitest';
import {
  canonicalSupplierDraft, canonicalSupplierOffers, matchesSupplierOffers, matchesSupplierRecord,
  parseSupplierCatalogPage, parseSupplierDetail, parseSupplierListPage, parseSupplierRecord,
  parseSuppliersError, supplierCatalogPath, supplierContactMessage, supplierDraftMessage,
  supplierDraftOf, supplierEntryDetail, supplierEntryLabel, supplierKindLabel, supplierKindsLabel,
  supplierListPath, supplierNameMessage, supplierOffersLabel, supplierOffersPath,
  supplierOffersMessage, supplierPath, supplierStateLabel, suppliersErrorMessages,
  suppliersListUnavailable, validSupplierCatalogQuery, validSupplierListQuery, validateSupplierDraft,
  type SupplierDraft,
} from './catalogSuppliersModel';

// The contract's own shapes: a battery entry is brand and model, an other product
// entry is its name, and the supplier carries the whole set it offers.
const batteryEntry = { catalog_entry_id: 7, kind: 'battery', brand: 'Willard', model: '12N24', capacity_ah: '12' };
const otherEntry = { catalog_entry_id: 9, kind: 'other', name: 'Agua acidulada' };
const row = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  id: 3, name: 'Baterías del Sur', contact: 'Llamar al 4455-1122', retired: false,
  kinds: ['battery', 'other'], offers: 2, ...overrides,
});
const listPage = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  suppliers: [JSON.parse(row())], page: 1, page_size: 10, total_suppliers: 1, ...overrides,
});
const detail = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  id: 3, name: 'Baterías del Sur', contact: 'Llamar al 4455-1122', retired: false,
  offers: [batteryEntry, otherEntry], kinds: ['battery', 'other'], ...overrides,
});
const catalogPage = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  entries: [batteryEntry, otherEntry], page_size: 10, total_entries: 2, ...overrides,
});
const draft = (overrides: Partial<SupplierDraft> = {}): SupplierDraft =>
  ({ name: 'Baterías del Sur', contact: 'Llamar al 4455-1122', ...overrides });

describe('one page of the supplier listing', () => {
  it('admits the contract shape with the state and the kinds of each row', () => {
    const parsed = parseSupplierListPage(listPage());
    expect(parsed).toEqual({
      rows: [{ id: 3, name: 'Baterías del Sur', contact: 'Llamar al 4455-1122', retired: false,
        kinds: ['battery', 'other'], offers: 2 }],
      page: 1, page_size: 10, total_suppliers: 1,
    });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.rows)).toBe(true);
    expect(Object.isFrozen(parsed.rows[0].kinds)).toBe(true);
  });

  it.each([
    ['an empty contact', { contact: '' }],
    ['a contact with the spaces it was typed with', { contact: ' Llamar al 4455-1122 ' }],
    ['a retired row without products', { retired: true, offers: 0, kinds: [] }],
    ['the smallest id', { id: 1 }],
  ])('accepts %s', (_name, overrides) => {
    expect(parseSupplierListPage(listPage({ suppliers: [JSON.parse(row(overrides))] })).rows).toHaveLength(1);
  });

  it('admits an empty page', () => {
    expect(parseSupplierListPage(JSON.stringify({ suppliers: [], page: 2, page_size: 10, total_suppliers: 10 })))
      .toMatchObject({ rows: [], page: 2, page_size: 10, total_suppliers: 10 });
  });

  it.each([
    ['an unknown key', listPage({ page_total: 1 })],
    ['a missing suppliers list', JSON.stringify({ page: 1, page_size: 10, total_suppliers: 0 })],
    ['a suppliers list that is not a list', listPage({ suppliers: {} })],
    ['a page size outside the contract', listPage({ page_size: 7 })],
    ['a page below one', listPage({ page: 0 })],
    ['more rows than the page holds', listPage({ suppliers: [JSON.parse(row()), JSON.parse(row({ id: 4 }))] })],
    ['rows past the announced total', listPage({ total_suppliers: 0 })],
    ['two rows with the same id', listPage({ suppliers: [JSON.parse(row()), JSON.parse(row())], total_suppliers: 2 })],
    ['a row that grew a field', listPage({ suppliers: [{ ...JSON.parse(row()), priced: true }] })],
    ['a row with an id of zero', listPage({ suppliers: [JSON.parse(row({ id: 0 }))] })],
    ['a row with an id past the identity bound', listPage({ suppliers: [JSON.parse(row({ id: 2147483648 }))] })],
    ['a row with a retired flag that is not a boolean', listPage({ suppliers: [JSON.parse(row({ retired: 'no' }))] })],
    ['a row with a negative number of products', listPage({ suppliers: [JSON.parse(row({ offers: -1 }))] })],
    ['a row with an unknown kind', listPage({ suppliers: [JSON.parse(row({ kinds: ['battery', 'liquid'] }))] })],
    ['a row that repeats a kind', listPage({ suppliers: [JSON.parse(row({ kinds: ['battery', 'battery'] }))] })],
    ['a row with an empty name', listPage({ suppliers: [JSON.parse(row({ name: '' }))] })],
    ['a row with a name of two characters', listPage({ suppliers: [JSON.parse(row({ name: 'ab' }))] })],
    ['a row with a name past 64 characters', listPage({ suppliers: [JSON.parse(row({ name: 'á'.repeat(65) }))] })],
    ['a row with a padded name', listPage({ suppliers: [JSON.parse(row({ name: ' Baterías del Sur' }))] })],
    ['a row with a control character in the name', listPage({ suppliers: [JSON.parse(row({ name: 'Baterías\tSur' }))] })],
    ['a row with a contact past 200 characters', listPage({ suppliers: [JSON.parse(row({ contact: 'a'.repeat(201) }))] })],
    ['a row with a control character in the contact', listPage({ suppliers: [JSON.parse(row({ contact: 'Llamar\nluego' }))] })],
    ['a row with a contact that is not text', listPage({ suppliers: [JSON.parse(row({ contact: 44551122 }))] })],
  ])('refuses %s', (_name, body) => {
    expect(() => parseSupplierListPage(body)).toThrow();
  });

  it('refuses a duplicated key even when both values are a name', () => {
    expect(() => parseSupplierListPage(listPage().replace('"id":3', '"id":3,"id":4'))).toThrow();
  });
});

describe('one created or edited supplier', () => {
  it('admits the allocated id and the trimmed text', () => {
    const record = parseSupplierRecord(JSON.stringify({ id: 11, name: 'Baterías del Sur', contact: '' }));
    expect(record).toEqual({ id: 11, name: 'Baterías del Sur', contact: '' });
    expect(Object.isFrozen(record)).toBe(true);
  });

  it('admits a contact of exactly 200 characters and one that keeps its spaces', () => {
    expect(parseSupplierRecord(JSON.stringify({ id: 11, name: 'Baterías del Sur', contact: 'a'.repeat(200) })))
      .toMatchObject({ contact: 'a'.repeat(200) });
    expect(parseSupplierRecord(JSON.stringify({ id: 11, name: 'Baterías del Sur', contact: ' 4455-1122 ' })))
      .toMatchObject({ contact: ' 4455-1122 ' });
  });

  it.each([
    ['an unknown key', { retired: false }],
    ['a missing contact', { contact: undefined }],
    ['a missing name', { name: undefined }],
    ['an id below one', { id: 0 }],
    ['an id past the identity bound', { id: 2147483648 }],
    ['an id as text', { id: '11' }],
    ['an id as a float', { id: 11.5 }],
    ['a name of two characters', { name: 'ab' }],
    ['a name past 64 characters', { name: 'á'.repeat(65) }],
    ['a name with surrounding spaces', { name: ' Baterías del Sur' }],
    ['a name with a control character', { name: 'Baterías\tSur' }],
    ['a contact past 200 characters', { contact: 'a'.repeat(201) }],
    ['a contact with a NUL', { contact: 'Llamar\0luego' }],
  ])('refuses %s', (_name, overrides) => {
    expect(() => parseSupplierRecord(JSON.stringify({ id: 11, name: 'Baterías del Sur', contact: 'Llamar', ...overrides })))
      .toThrow();
  });

  it('refuses a duplicated key', () => {
    expect(() => parseSupplierRecord('{"id":11,"name":"Baterías del Sur","contact":"","contact":"x"}')).toThrow();
  });
});

describe('one supplier with the entries it offers', () => {
  it('admits a battery entry and an other product entry, frozen', () => {
    const parsed = parseSupplierDetail(detail());
    expect(parsed.offers.map(entry => [entry.catalog_entry_id, entry.kind])).toEqual([[7, 'battery'], [9, 'other']]);
    expect(parsed.offers[0]).toMatchObject({ brand: 'Willard', model: '12N24', capacity_ah: '12', polarity: null });
    expect(parsed.offers[1]).toMatchObject({ name: 'Agua acidulada', brand: null, polarity: null });
    expect(parsed.retired).toBe(false);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.offers)).toBe(true);
    expect(Object.isFrozen(parsed.offers[0])).toBe(true);
  });

  it('admits a supplier without offers, and a battery entry without capacity or polarity', () => {
    expect(parseSupplierDetail(detail({ offers: [], kinds: [] }))).toMatchObject({ offers: [], kinds: [] });
    const bare = parseSupplierDetail(detail({
      offers: [{ catalog_entry_id: 7, kind: 'battery', brand: 'Willard', model: '12N24' }],
      kinds: ['battery'],
    }));
    expect(bare.offers[0]).toMatchObject({ capacity_ah: null, polarity: null, name: null });
    // The frozen contract still admits a polarity when it travels; the entry level
    // does not need it, because polarity belongs to a variant.
    const withPolarity = parseSupplierDetail(detail({
      offers: [{ catalog_entry_id: 7, kind: 'battery', brand: 'Willard', model: '12N24', capacity_ah: '12', polarity: 'R' }],
      kinds: ['battery'],
    }));
    expect(withPolarity.offers[0].polarity).toBe('R');
  });

  it('admits a capacity published as a JSON number, kept as canonical text', () => {
    const parsed = parseSupplierDetail(detail({
      offers: [{ catalog_entry_id: 7, kind: 'battery', brand: 'Willard', model: '12N24', capacity_ah: 12 }],
      kinds: ['battery'],
    }));
    expect(parsed.offers[0].capacity_ah).toBe('12');
  });

  it.each([
    ['an unknown key', detail({ supplier: 3 })],
    ['a missing offers list', JSON.stringify({ id: 3, name: 'Baterías del Sur', contact: '', retired: false, kinds: [] })],
    ['a missing kinds list', JSON.stringify({ id: 3, name: 'Baterías del Sur', contact: '', retired: false, offers: [] })],
    ['a retired flag that is not a boolean', detail({ retired: 'no' })],
    ['two offers of the same entry', detail({ offers: [batteryEntry, batteryEntry] })],
    ['a battery without brand', detail({ offers: [{ catalog_entry_id: 7, kind: 'battery', model: '12N24', polarity: 'L' }] })],
    ['a battery with a polarity outside L and R',
      detail({ offers: [{ catalog_entry_id: 7, kind: 'battery', brand: 'Willard', model: '12N24', polarity: 'X' }] })],
    ['a battery with a padded capacity',
      detail({ offers: [{ catalog_entry_id: 7, kind: 'battery', brand: 'Willard', model: '12N24', capacity_ah: '12.50', polarity: 'L' }] })],
    ['an other product without name', detail({ offers: [{ catalog_entry_id: 9, kind: 'other' }] })],
    ['an other product with a battery brand',
      detail({ offers: [{ catalog_entry_id: 9, kind: 'other', name: 'Agua acidulada', brand: 'Willard' }] })],
    ['an entry of an unknown kind', detail({ offers: [{ catalog_entry_id: 9, kind: 'liquid', name: 'Agua' }] })],
    ['an entry that grew a key', detail({ offers: [{ ...batteryEntry, price: '1000' }] })],
    ['an unknown kind in the kinds list', detail({ kinds: ['battery', 'liquid'] })],
  ])('refuses %s', (_name, body) => {
    expect(() => parseSupplierDetail(body)).toThrow();
  });
});

describe('one page of the assignable catalogue', () => {
  it('admits the entries and the announced total', () => {
    const parsed = parseSupplierCatalogPage(catalogPage());
    expect(parsed.entries.map(entry => entry.catalog_entry_id)).toEqual([7, 9]);
    expect(parsed.page_size).toBe(10);
    expect(parsed.total_entries).toBe(2);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.entries)).toBe(true);
  });

  it('admits an empty page and a total past the loaded entries', () => {
    expect(parseSupplierCatalogPage(JSON.stringify({ entries: [], page_size: 10, total_entries: 0 })))
      .toMatchObject({ entries: [], total_entries: 0 });
    expect(parseSupplierCatalogPage(JSON.stringify({ entries: [batteryEntry], page_size: 10, total_entries: 40 })))
      .toMatchObject({ total_entries: 40 });
  });

  it.each([
    ['an unknown key', catalogPage({ page: 1 })],
    ['a missing entries list', JSON.stringify({ page_size: 10, total_entries: 0 })],
    ['a page size outside the contract', catalogPage({ page_size: 7 })],
    ['more entries than the page holds', catalogPage({ entries: Array.from({ length: 11 }, (_, index) =>
      ({ catalog_entry_id: index + 1, kind: 'other', name: `Producto ${index}` })), total_entries: 11 })],
    ['entries past the announced total', catalogPage({ total_entries: 1 })],
    ['two entries with the same id', catalogPage({ entries: [otherEntry, otherEntry], total_entries: 2 })],
    ['an entry that grew a key', catalogPage({ entries: [{ ...otherEntry, priced: true }] })],
  ])('refuses %s', (_name, body) => {
    expect(() => parseSupplierCatalogPage(body)).toThrow();
  });
});

describe('the frozen paths', () => {
  it('always carries the page and the page size of the listing', () => {
    expect(supplierListPath({ page: 1, page_size: 10 })).toBe('/api/suppliers?page=1&page_size=10');
    expect(supplierListPath({ page: 3, page_size: 25 })).toBe('/api/suppliers?page=3&page_size=25');
    for (const broken of [{ page: 0, page_size: 10 }, { page: 1, page_size: 7 }, { page: 1_000_001, page_size: 10 }]) {
      expect(validSupplierListQuery(broken)).toBe(false);
      expect(() => supplierListPath(broken)).toThrow();
    }
  });

  it('names one supplier and its offers under their own paths', () => {
    expect(supplierPath(3)).toBe('/api/suppliers/3');
    expect(supplierOffersPath(3)).toBe('/api/suppliers/3/offers');
    for (const id of [0, -1, 1.5, 2_147_483_648]) {
      expect(() => supplierPath(id)).toThrow();
      expect(() => supplierOffersPath(id)).toThrow();
    }
  });

  it('omits an empty kind and search and always carries the page size', () => {
    expect(supplierCatalogPath({ kind: '', search: '', page_size: 10 })).toBe('/api/suppliers/catalog?page_size=10');
    expect(supplierCatalogPath({ kind: 'battery', search: 'Willard 12N24', page_size: 25 }))
      .toBe('/api/suppliers/catalog?kind=battery&search=Willard+12N24&page_size=25');
    expect(supplierCatalogPath({ kind: 'other', search: '', page_size: 10 }))
      .toBe('/api/suppliers/catalog?kind=other&page_size=10');
  });

  it('refuses an assignable query outside the contract', () => {
    const query = { kind: 'battery' as const, search: '', page_size: 10 };
    expect(validSupplierCatalogQuery(query)).toBe(true);
    for (const broken of [{ ...query, kind: 'liquid' as never }, { ...query, page_size: 7 },
      { ...query, search: 'a\0b' }, { ...query, search: 'á'.repeat(129) }]) {
      expect(validSupplierCatalogQuery(broken as never)).toBe(false);
      expect(() => supplierCatalogPath(broken as never)).toThrow();
    }
    // The bound is the server's own, measured in runes: a 128-rune search fits even in UTF-8.
    expect(validSupplierCatalogQuery({ ...query, search: 'á'.repeat(128) })).toBe(true);
  });
});

describe('the draft the form writes', () => {
  it('trims the name and keeps the contact exactly as it was typed', () => {
    const validation = validateSupplierDraft(draft({ name: '  Baterías del Sur  ', contact: ' 4455-1122 ' }));
    expect(validation).toEqual({
      valid: true,
      input: { name: 'Baterías del Sur', contact: ' 4455-1122 ' },
    });
  });

  it('admits a supplier without contact', () => {
    expect(validateSupplierDraft(draft({ contact: '' }))).toEqual({
      valid: true, input: { name: 'Baterías del Sur', contact: '' },
    });
  });

  it('admits a name of exactly 3 and exactly 64 bytes and a contact of 0 and 200 characters', () => {
    expect(validateSupplierDraft(draft({ name: 'Sur' })).valid).toBe(true);
    expect(validateSupplierDraft(draft({ name: 'a'.repeat(64) })).valid).toBe(true);
    // The bound is the server's own, measured in bytes: 32 accented runes are 64 bytes.
    expect(validateSupplierDraft(draft({ name: 'á'.repeat(32) })).valid).toBe(true);
    expect(validateSupplierDraft(draft({ contact: 'a'.repeat(200) })).valid).toBe(true);
  });

  it.each([
    ['a name of two characters', draft({ name: 'ab' }), supplierNameMessage],
    ['a name of 65 characters', draft({ name: 'a'.repeat(65) }), supplierNameMessage],
    ['a name of 66 bytes in 33 characters', draft({ name: 'á'.repeat(33) }), supplierNameMessage],
    ['a whitespace-only name', draft({ name: '   ' }), supplierNameMessage],
    ['a name with a control character', draft({ name: 'Baterías\tSur' }), supplierNameMessage],
    ['a contact of 201 characters', draft({ contact: 'a'.repeat(201) }), supplierContactMessage],
    ['a contact with a control character', draft({ contact: 'Llamar\nluego' }), supplierContactMessage],
    ['a contact with a NUL', draft({ contact: 'Llamar\0luego' }), supplierContactMessage],
  ])('reports %s with its own message and the bound it broke', (_name, broken, message) => {
    expect(validateSupplierDraft(broken)).toEqual({ valid: false, message });
  });

  it('shows the exact bound of the name and of the contact', () => {
    expect(supplierNameMessage).toMatch(/3 a 64/);
    expect(supplierContactMessage).toMatch(/200/);
  });

  it('never admits an unknown key into the payload', () => {
    expect(validateSupplierDraft({ ...draft(), id: 3 } as never)).toEqual({ valid: false, message: supplierDraftMessage });
    expect(validateSupplierDraft({ name: 'Baterías del Sur' } as never)).toEqual({ valid: false, message: supplierDraftMessage });
  });

  it('refuses to canonicalize an invalid draft', () => {
    expect(() => canonicalSupplierDraft(draft({ name: 'ab' }))).toThrow();
    expect(() => canonicalSupplierDraft(draft({ contact: 'a'.repeat(201) }))).toThrow();
  });
});

describe('the canonical set of offers', () => {
  it('de-duplicates and orders the entries so the same set always travels the same', () => {
    const ids = canonicalSupplierOffers([9, 3, 9, 7]);
    expect(ids).toEqual([3, 7, 9]);
    expect(Object.isFrozen(ids)).toBe(true);
    expect(canonicalSupplierOffers([])).toEqual([]);
  });

  it('admits exactly 200 entries and refuses one more', () => {
    const full = Array.from({ length: 200 }, (_, index) => index + 1);
    expect(canonicalSupplierOffers(full)).toHaveLength(200);
    expect(() => canonicalSupplierOffers([...full, 201])).toThrowError(supplierOffersMessage);
  });

  it.each([[[0]], [[-1]], [[1.5]], [[2_147_483_648]], [['3' as unknown as number]]])('refuses %j', ids => {
    expect(() => canonicalSupplierOffers(ids)).toThrow();
    expect(() => canonicalSupplierOffers(ids)).toThrowError(supplierOffersMessage);
  });
});

describe('the echo of a write', () => {
  it('admits a record that repeats the trimmed supplier the client wrote', () => {
    const record = parseSupplierRecord(JSON.stringify({ id: 11, name: 'Baterías del Sur', contact: 'Llamar' }));
    expect(matchesSupplierRecord({ name: '  Baterías del Sur ', contact: 'Llamar' }, record)).toBe(true);
  });

  it('refuses a record that renamed the supplier, changed its contact or invented an id', () => {
    const record = parseSupplierRecord(JSON.stringify({ id: 11, name: 'Baterías del Sur', contact: 'Llamar' }));
    expect(matchesSupplierRecord({ name: 'Otras baterías', contact: 'Llamar' }, record)).toBe(false);
    expect(matchesSupplierRecord({ name: 'Baterías del Sur', contact: 'Otro' }, record)).toBe(false);
    expect(matchesSupplierRecord({ name: 'ab', contact: '' }, record)).toBe(false);
    expect(matchesSupplierRecord({ name: 'Baterías del Sur', contact: 'Llamar' },
      { id: 0, name: 'Baterías del Sur', contact: 'Llamar' })).toBe(false);
  });

  it('admits a detail that repeats the exact set, whatever order the server lists it in', () => {
    const written = [7, 9];
    expect(matchesSupplierOffers(written, parseSupplierDetail(detail()))).toBe(true);
    const reversed = parseSupplierDetail(detail({ offers: [otherEntry, batteryEntry] }));
    expect(matchesSupplierOffers(written, reversed)).toBe(true);
    expect(matchesSupplierOffers([], parseSupplierDetail(detail({ offers: [], kinds: [] })))).toBe(true);
  });

  it('refuses a detail that lost or gained an entry, or is not a valid set', () => {
    expect(matchesSupplierOffers([7], parseSupplierDetail(detail()))).toBe(false);
    expect(matchesSupplierOffers([7, 9, 11], parseSupplierDetail(detail()))).toBe(false);
    expect(matchesSupplierOffers([0], parseSupplierDetail(detail()))).toBe(false);
  });
});

describe('the words the screen shows', () => {
  it('names a battery by brand and model and an other product by its name', () => {
    const parsed = parseSupplierDetail(detail());
    expect(supplierEntryLabel(parsed.offers[0])).toBe('Willard 12N24');
    expect(supplierEntryLabel(parsed.offers[1])).toBe('Agua acidulada');
    expect(supplierEntryDetail(parsed.offers[0])).toBe('12 Ah');
    expect(supplierEntryDetail({ ...parsed.offers[0], polarity: 'L' })).toBe('12 Ah · Izquierda [L]');
    expect(supplierEntryDetail(parsed.offers[1])).toBe('Otro producto');
    expect(supplierEntryDetail({ ...parsed.offers[0], capacity_ah: null, polarity: null })).toBe('Batería');
  });

  it('says how many products a supplier offers and which kinds', () => {
    expect(supplierOffersLabel(0)).toBe('sin productos');
    expect(supplierOffersLabel(1)).toBe('1 producto');
    expect(supplierOffersLabel(5)).toBe('5 productos');
    expect(supplierKindsLabel([])).toBe('Sin productos asignados');
    expect(supplierKindsLabel(['battery'])).toBe('Solo baterías');
    expect(supplierKindsLabel(['other'])).toBe('Solo otros productos');
    expect(supplierKindsLabel(['battery', 'other'])).toBe('Baterías y otros productos');
    expect(supplierKindLabel('battery')).toBe('Baterías');
    expect(supplierKindLabel('other')).toBe('Otros productos');
  });

  it('marks the state of the supplier and turns a row back into its draft', () => {
    expect(supplierStateLabel(false)).toBe('Activo');
    expect(supplierStateLabel(true)).toBe('Retirado');
    expect(supplierDraftOf({ name: 'Baterías del Sur', contact: 'Llamar' }))
      .toEqual({ name: 'Baterías del Sur', contact: 'Llamar' });
  });

  it('names every refusal in its own words', () => {
    expect(suppliersListUnavailable).toMatch(/catálogo de proveedores/i);
    expect(suppliersErrorMessages.conflict).toMatch(/nombre/i);
    expect(suppliersErrorMessages.forbidden).toMatch(/permiso/i);
    expect(Object.values(suppliersErrorMessages).every(message => message.trim() !== '')).toBe(true);
  });
});

describe('one rejected write', () => {
  it.each([
    ['invalid_request', 400], ['unauthenticated', 401], ['forbidden', 403],
    ['not_found', 404], ['conflict', 409], ['service_unavailable', 503],
  ])('admits %s with status %i', (code, status) => {
    expect(parseSuppliersError(JSON.stringify({ error: code }), status)).toBe(code);
  });

  it.each([
    ['an unadmitted code', '{"error":"catalog_product_has_stock"}', 409],
    ['an unadmitted status', '{"error":"conflict"}', 500],
    ['an unknown key', '{"error":"conflict","id":1}', 409],
    ['a missing envelope', '{}', 409],
  ])('refuses %s', (_name, body, status) => {
    expect(() => parseSuppliersError(body, status)).toThrow();
  });
});
