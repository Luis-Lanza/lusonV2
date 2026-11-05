import { describe, expect, it } from 'vitest';
import {
  catalogBatteriesErrorMessages, catalogBatteriesListUnavailable, catalogBatteriesPath, catalogBatteryCapacityMessage,
  catalogBatteryNameMessage, catalogBatteryPolarityMessage, catalogBatteryPricingHint, catalogBatteryUnsellableLabel,
  matchesCatalogBatteryCreate, matchesCatalogBatteryIdentity, parseCatalogBatteriesError, parseCatalogBattery,
  parseCatalogBatteryPage, pricedBranchesLabel, variantsLabel,
  validateCatalogBatteryCreateDraft, validateCatalogBatteryIdentityDraft,
  type CatalogBatteryDraft,
} from './catalogBatteriesModel';

// One created battery exactly as the server publishes it: allocated ids, canonical
// capacity text and the count of active branches that already hold a price.
const record = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  id: 96, brand: 'TOYO', model: 'NS40ZL', capacity_ah: '45',
  variants: [{ id: 191, polarity: 'L' }, { id: 192, polarity: 'R' }], priced_branches: 0, ...overrides,
});
const draft = (overrides: Partial<CatalogBatteryDraft> = {}): CatalogBatteryDraft => ({
  brand: 'TOYO', model: 'NS40ZL', capacity_ah: '45', polarities: ['L', 'R'], ...overrides,
});

describe('one created or edited battery', () => {
  it('admits the created shape with its allocated ids and unsellable count', () => {
    const battery = parseCatalogBattery(record());
    expect(battery).toEqual({
      id: 96, brand: 'TOYO', model: 'NS40ZL', capacity_ah: '45',
      variants: [{ id: 191, polarity: 'L' }, { id: 192, polarity: 'R' }], priced_branches: 0,
    });
    expect(Object.isFrozen(battery)).toBe(true);
    expect(Object.isFrozen(battery.variants)).toBe(true);
    expect(Object.isFrozen(battery.variants[0])).toBe(true);
  });

  it.each([
    ['a single polarity', { variants: [{ id: 191, polarity: 'R' }] }, { variants: [{ id: 191, polarity: 'R' }] }],
    ['a priced battery', { priced_branches: 3 }, { priced_branches: 3 }],
    ['the smallest capacity', { capacity_ah: '0.5' }, { capacity_ah: '0.5' }],
    ['the widest capacity', { capacity_ah: '123456.000001' }, { capacity_ah: '123456.000001' }],
    ['an allocated id past the fixture', { id: 2147483647, variants: [{ id: 2147483647, polarity: 'L' }] },
      { id: 2147483647, variants: [{ id: 2147483647, polarity: 'L' }] }],
  ])('accepts %s', (_name, overrides, expected) => {
    expect(parseCatalogBattery(record(overrides))).toMatchObject(expected);
  });

  it.each([
    ['an unknown key', { cells: [] }],
    ['an unknown nested key', { variants: [{ id: 191, polarity: 'L', cells: [] }] }],
    ['a missing id', { id: undefined }],
    ['a missing brand', { brand: undefined }],
    ['a missing model', { model: undefined }],
    ['a missing capacity', { capacity_ah: undefined }],
    ['a missing variant list', { variants: undefined }],
    ['a missing priced_branches', { priced_branches: undefined }],
    ['a duplicated key', '__duplicate__'],
    ['an id below one', { id: 0 }],
    ['an id past the identity bound', { id: 2147483648 }],
    ['an id as text', { id: '96' }],
    ['an id as a float', { id: 96.5 }],
    ['an empty brand', { brand: '' }],
    ['a brand with a NUL', { brand: 'TO\0YO' }],
    ['a brand past 128 bytes', { brand: 'Á'.repeat(65) }],
    ['a model past 128 bytes', { model: 'M'.repeat(129) }],
    ['a blank model', { model: '   ' }],
    ['a padded capacity', { capacity_ah: '045' }],
    ['a capacity with a trailing zero', { capacity_ah: '45.50' }],
    ['a capacity of zero', { capacity_ah: '0' }],
    ['a capacity as a number', { capacity_ah: 45 }],
    ['a capacity with a comma', { capacity_ah: '45,5' }],
    ['a capacity past six integers', { capacity_ah: '1234567' }],
    ['an empty variant list', { variants: [] }],
    ['three variants', { variants: [{ id: 191, polarity: 'L' }, { id: 192, polarity: 'R' }, { id: 193, polarity: 'L' }] }],
    ['duplicated polarities', { variants: [{ id: 191, polarity: 'L' }, { id: 192, polarity: 'L' }] }],
    ['descending polarities', { variants: [{ id: 191, polarity: 'R' }, { id: 192, polarity: 'L' }] }],
    ['an unadmitted polarity', { variants: [{ id: 191, polarity: 'X' }] }],
    ['a variant id below one', { variants: [{ id: 0, polarity: 'L' }] }],
    ['a negative priced count', { priced_branches: -1 }],
    ['a fractional priced count', { priced_branches: 1.5 }],
    ['a priced count as text', { priced_branches: '0' }],
    ['a priced count past the branch bound', { priced_branches: 40000 }],
  ])('refuses %s', (_name, overrides) => {
    const raw = overrides === '__duplicate__'
      ? '{"id":96,"id":97,"brand":"TOYO","model":"NS40ZL","capacity_ah":"45","variants":[{"id":191,"polarity":"L"}],"priced_branches":0}'
      : record(overrides as Record<string, unknown>);
    expect(() => parseCatalogBattery(raw)).toThrow();
  });

  it.each([
    ['a non-JSON body', 'no es json'],
    ['an array', '[]'],
    ['a null', 'null'],
  ])('refuses %s as a record', (_name, raw) => {
    expect(() => parseCatalogBattery(raw)).toThrow();
  });
});

describe('the battery listing', () => {
  // The catalog's only battery listing is the price matrix read: one row per active
  // battery with the pairs of the active branches. priced_branches is that count.
  const price = (branch: number) => ({
    branch_location_id: branch, min_price: '85000.00', suggested_price: '96000.00',
    updated_at: '2026-11-04T10:00:00Z', updated_by_account_id: 1, updated_by_display_name: 'Almacén',
  });
  const row = (overrides: Record<string, unknown> = {}) => ({ catalog_entry_id: 97, brand: 'CAR', model: 'NS60',
    capacity_ah: '60', polarities: ['R'], cells: [], prices: [], ...overrides });
  const page = (overrides: Record<string, unknown> = {}) => JSON.stringify({
    branches: [{ id: 2, name: 'Sucursal A' }, { id: 3, name: 'Sucursal B' }],
    batteries: [{ catalog_entry_id: 96, brand: 'TOYO', model: 'NS40ZL', capacity_ah: '45',
      polarities: ['L', 'R'], cells: [], prices: [price(2)] }, row(overrides)],
    page: 1, page_size: 10, total_batteries: 96,
  });

  it('derives the priced branches and the polarities of every listed battery', () => {
    const listed = parseCatalogBatteryPage(page());
    expect(listed.rows.map(row => row.priced_branches)).toEqual([1, 0]);
    expect(listed.rows[0]).toEqual({
      id: 96, brand: 'TOYO', model: 'NS40ZL', capacity_ah: '45', polarities: ['L', 'R'], priced_branches: 1,
    });
    expect(listed.rows[1].polarities).toEqual(['R']);
    expect(listed).toMatchObject({ page: 1, page_size: 10, total_batteries: 96 });
    expect(Object.isFrozen(listed)).toBe(true);
    expect(Object.isFrozen(listed.rows)).toBe(true);
    expect(Object.isFrozen(listed.rows[0])).toBe(true);
  });

  it('refuses a matrix row that grew a field instead of reading it', () => {
    expect(() => parseCatalogBatteryPage(page({ priced_branches: 0 }))).toThrow();
  });

  it('refuses a price that belongs to no listed active branch', () => {
    expect(() => parseCatalogBatteryPage(page({ prices: [price(9)] }))).toThrow();
  });

  it('builds the same frozen read path the matrix already serves', () => {
    // No new field travels: the listing is the price matrix query, unchanged.
    expect(catalogBatteriesPath({ search: '', brand: '', capacity: '', page: 2, page_size: 25 }))
      .toBe('/api/catalog/prices?page=2&page_size=25');
    expect(() => catalogBatteriesPath({ search: '', brand: '', capacity: '', page: 0, page_size: 25 })).toThrow();
  });
});

describe('the create and edit drafts', () => {
  it('sends the identity, the canonical capacity and the sorted polarities', () => {
    const validation = validateCatalogBatteryCreateDraft(draft({ capacity_ah: '045.50', polarities: ['R', 'L'] }));
    expect(validation).toEqual({ valid: true, input: {
      brand: 'TOYO', model: 'NS40ZL', capacity_ah: '45.5', polarities: ['L', 'R'],
    } });
  });

  it.each([
    ['an empty brand', { brand: '' }, catalogBatteryNameMessage],
    ['a blank brand', { brand: '   ' }, catalogBatteryNameMessage],
    ['a brand with a NUL', { brand: 'TO\0YO' }, catalogBatteryNameMessage],
    ['a brand past 128 bytes', { brand: 'Á'.repeat(65) }, catalogBatteryNameMessage],
    ['an empty model', { model: '' }, catalogBatteryNameMessage],
    ['an empty capacity', { capacity_ah: '' }, catalogBatteryCapacityMessage],
    ['a capacity of zero', { capacity_ah: '0' }, catalogBatteryCapacityMessage],
    ['a capacity of zero with a fraction of zero', { capacity_ah: '0.0' }, catalogBatteryCapacityMessage],
    ['a negative capacity', { capacity_ah: '-1' }, catalogBatteryCapacityMessage],
    ['an exponential capacity', { capacity_ah: '1e2' }, catalogBatteryCapacityMessage],
    ['a capacity past six decimals', { capacity_ah: '45.1234567' }, catalogBatteryCapacityMessage],
    ['a capacity past six integers', { capacity_ah: '1234567' }, catalogBatteryCapacityMessage],
    ['no polarity', { polarities: [] }, catalogBatteryPolarityMessage],
    ['a duplicated polarity', { polarities: ['L', 'L'] }, catalogBatteryPolarityMessage],
    ['three polarities', { polarities: ['L', 'R', 'L'] }, catalogBatteryPolarityMessage],
    ['an unadmitted polarity', { polarities: ['X'] }, catalogBatteryPolarityMessage],
  ])('refuses %s before anything is sent', (_name, overrides, message) => {
    expect(validateCatalogBatteryCreateDraft(draft(overrides as Partial<CatalogBatteryDraft>)))
      .toEqual({ valid: false, message });
  });

  it('edits the complete identity only: a partial edit is refused, never merged', () => {
    expect(validateCatalogBatteryIdentityDraft({ brand: 'TOYO', model: 'NS40ZL', capacity_ah: '45.5' }))
      .toEqual({ valid: true, input: { brand: 'TOYO', model: 'NS40ZL', capacity_ah: '45.5' } });
    expect(validateCatalogBatteryIdentityDraft({ brand: 'TOYO', model: '', capacity_ah: '45' }))
      .toEqual({ valid: false, message: catalogBatteryNameMessage });
    expect(validateCatalogBatteryIdentityDraft({ brand: 'TOYO', model: 'NS40ZL', capacity_ah: '' }))
      .toEqual({ valid: false, message: catalogBatteryCapacityMessage });
  });

  it('admits the record only when it repeats the write that was sent', () => {
    const sent = { brand: 'TOYO', model: 'NS40ZL', capacity_ah: '45', polarities: ['L', 'R'] as const };
    expect(matchesCatalogBatteryCreate(sent, parseCatalogBattery(record()))).toBe(true);
    expect(matchesCatalogBatteryCreate(sent, parseCatalogBattery(record({ brand: 'OTRA' })))).toBe(false);
    expect(matchesCatalogBatteryCreate(sent, parseCatalogBattery(record({ capacity_ah: '45.5' })))).toBe(false);
    expect(matchesCatalogBatteryCreate(sent, parseCatalogBattery(record({ variants: [{ id: 191, polarity: 'L' }] }))))
      .toBe(false);
    expect(matchesCatalogBatteryIdentity({ brand: 'TOYO', model: 'NS40ZL', capacity_ah: '45' },
      parseCatalogBattery(record({ priced_branches: 2 })))).toBe(true);
    expect(matchesCatalogBatteryIdentity({ brand: 'TOYO', model: 'NS40ZL', capacity_ah: '46' },
      parseCatalogBattery(record()))).toBe(false);
  });
});

describe('the battery write refusals', () => {
  it.each([
    [400, 'invalid_request'],
    [401, 'unauthenticated'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [409, 'conflict'],
    [409, 'catalog_battery_has_stock'],
    [409, 'catalog_battery_has_pending'],
    [503, 'service_unavailable'],
  ])('admits %s %s', (status, code) => {
    expect(parseCatalogBatteriesError(JSON.stringify({ error: code }), status)).toBe(code);
  });

  it.each([
    ['an unadmitted code for the status', '{"error":"conflict"}', 400],
    ['a code from another contract', '{"error":"catalog_variant_retired_battery"}', 409],
    ['an extra field', '{"error":"conflict","brand":"TOYO"}', 409],
    ['no error key', '{"message":"conflict"}', 409],
    ['an unknown status', '{"error":"conflict"}', 500],
    ['a non-JSON body', 'conflict', 409],
  ])('refuses %s', (_name, raw, status) => {
    expect(() => parseCatalogBatteriesError(raw, status)).toThrow();
  });

  it('keeps the three refusal codes as their own messages', () => {
    const stock = catalogBatteriesErrorMessages.catalog_battery_has_stock;
    const pending = catalogBatteriesErrorMessages.catalog_battery_has_pending;
    const conflict = catalogBatteriesErrorMessages.conflict;
    expect(new Set([stock, pending, conflict, catalogBatteriesErrorMessages.invalid_response]).size).toBe(4);
    expect(stock).toMatch(/stock|existencias/i);
    expect(stock).toMatch(/cero/i);
    expect(pending).toMatch(/transferencia/i);
    expect(conflict).toMatch(/marca y modelo/i);
    expect(stock).not.toMatch(/no se pudo/i);
  });
});

describe('what the operator reads', () => {
  it('states that a battery without a price is not sellable', () => {
    expect(pricedBranchesLabel(0)).toBe('Sin precio en ninguna sucursal');
    expect(pricedBranchesLabel(1)).toBe('Con precio en 1 sucursal');
    expect(pricedBranchesLabel(4)).toBe('Con precio en 4 sucursales');
    expect(catalogBatteryUnsellableLabel).toBe('No vendible · sin precio');
    expect(catalogBatteryPricingHint).toBe('Cargá su precio en el catálogo de precios para poder venderla.');
    expect(catalogBatteriesListUnavailable).toMatch(/catálogo de baterías/i);
  });

  it('names the allocated variants the server returned', () => {
    expect(variantsLabel(parseCatalogBattery(record()).variants)).toBe('#191 L · #192 R');
    expect(variantsLabel(parseCatalogBattery(record({ variants: [{ id: 191, polarity: 'R' }] })).variants)).toBe('#191 R');
  });
});
