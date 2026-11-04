import { describe, expect, it } from 'vitest';
import {
  branchTag, catalogAmountCents, catalogAmountEntry, catalogPriceAmountMessage, catalogPriceBatteryMessage,
  catalogPriceBranchMessage, catalogPriceOrderMessage, catalogPricesPath, formatCatalogMoney,
  matchesCatalogPriceInput, parseCatalogPriceResult, parseCatalogPrices, parseCatalogPricesError,
  parseCatalogPricesWriteError, polaritiesLabel, sharedPriceLabel, validCatalogPricesQuery,
  validateCatalogPriceDraft, type CatalogPriceInput,
} from './catalogPricesModel';

const branch = (id: number, name: string) => ({ id, name });
const price = (overrides: Record<string, unknown> = {}) => ({
  branch_location_id: 2, min_price: '85000.00', suggested_price: '96000.00',
  updated_at: '2026-11-04T10:00:00Z', updated_by_account_id: 1, updated_by_display_name: 'Almacén', ...overrides,
});
// One row per battery: the price belongs to brand + model + capacity, so the row
// carries both polarities instead of one variant each.
const battery = (overrides: Record<string, unknown> = {}) => ({
  catalog_entry_id: 1, brand: 'CAR', model: 'NS40ZL', capacity_ah: '35', polarities: ['L', 'R'],
  cells: ['B5', 'C5', 'D5'], prices: [price()], ...overrides,
});
const page = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  branches: [branch(2, 'Sucursal A'), branch(3, 'Sucursal B')],
  batteries: [battery()], page: 1, page_size: 10, total_batteries: 95, ...overrides,
});

describe('catalog prices read path', () => {
  it('omits the filters the operator left blank, which the contract refuses empty', () => {
    const query = { search: '', brand: '', capacity: '', page: 1, page_size: 10 };
    expect(catalogPricesPath(query)).toBe('/api/catalog/prices?page=1&page_size=10');
    expect(catalogPricesPath({ ...query, brand: 'CAR' })).toBe('/api/catalog/prices?brand=CAR&page=1&page_size=10');
    expect(catalogPricesPath({ ...query, search: 'NS40ZL', brand: 'CAR', capacity: '35', page: 2, page_size: 25 }))
      .toBe('/api/catalog/prices?search=NS40ZL&brand=CAR&capacity=35&page=2&page_size=25');
  });

  it('never sends a polarity filter, because a price no longer depends on one', () => {
    const path = catalogPricesPath({ search: '', brand: 'CAR', capacity: '35', page: 1, page_size: 10 });
    expect(path).not.toContain('polarity');
  });

  it.each([
    ['a page below one', { page: 0, page_size: 10 }],
    ['a page above the limit', { page: 1_000_001, page_size: 10 }],
    ['a page size outside the matrix', { page: 1, page_size: 15 }],
    ['a fractional page', { page: 1.5, page_size: 10 }],
    ['an oversized search', { search: 'x'.repeat(129) }],
    ['a search with NUL', { search: 'a\0b' }],
    ['a capacity that is not a decimal', { capacity: '35 Ah' }],
    ['a brand with NUL', { brand: 'C\0R' }],
  ])('refuses %s', (_, overrides) => {
    expect(validCatalogPricesQuery({ search: '', brand: '', capacity: '', page: 1, page_size: 10, ...overrides } as never))
      .toBe(false);
  });

  it('admits the contract query', () => {
    expect(validCatalogPricesQuery({ search: 'NS40ZL', brand: 'CAR', capacity: '35', page: 1, page_size: 10 })).toBe(true);
    expect(validCatalogPricesQuery({ search: '', brand: '', capacity: '', page: 1, page_size: 50 })).toBe(true);
  });
});

describe('catalog prices read mapping', () => {
  it('maps one row per battery with both of its polarities and every branch chip', () => {
    const parsed = parseCatalogPrices(page());
    expect(parsed.page).toBe(1);
    expect(parsed.total_batteries).toBe(95);
    expect(parsed.branches.map(b => b.name)).toEqual(['Sucursal A', 'Sucursal B']);
    const row = parsed.batteries[0];
    expect(row).toMatchObject({ catalog_entry_id: 1, brand: 'CAR', model: 'NS40ZL', capacity_ah: '35' });
    expect(row.polarities).toEqual(['L', 'R']);
    expect(row.cells).toEqual(['B5', 'C5', 'D5']);
    expect(row.prices[0].min_price).toBe('85000.00');
    expect(row.prices[0].suggested_price).toBe('96000.00');
    expect(typeof row.prices[0].min_price).toBe('string');
    expect(row).not.toHaveProperty('variant_id');
    expect(row).not.toHaveProperty('warranty_months');
  });

  it('admits a battery with a single polarity, listed once', () => {
    const parsed = parseCatalogPrices(page({ batteries: [battery({ polarities: ['R'] })] }));
    expect(parsed.batteries[0].polarities).toEqual(['R']);
  });

  it('admits a battery with no price in any branch', () => {
    const parsed = parseCatalogPrices(page({ batteries: [battery({ prices: [], cells: [] })] }));
    expect(parsed.batteries[0].prices).toEqual([]);
    expect(parsed.batteries[0].cells).toEqual([]);
  });

  it('admits a persisted writer whose account has no display name', () => {
    // The preview database holds writers without a display name: the row they wrote
    // is still evidence about the catalogue and must render.
    const parsed = parseCatalogPrices(page({
      branches: Array.from({ length: 5 }, (_, index) => branch(index + 2, `Sucursal ${index + 1}`)),
      batteries: [battery({ prices: [
        price({ branch_location_id: 2, updated_by_display_name: '' }),
        price({ branch_location_id: 3, updated_by_display_name: '', updated_at: '2026-11-04T23:14:07.123456Z' }),
      ] })],
    }));
    expect(parsed.branches).toHaveLength(5);
    expect(parsed.batteries[0].prices.map(entry => entry.updated_by_display_name)).toEqual(['', '']);
    expect(parsed.batteries[0].prices[1].updated_at).toBe('2026-11-04T23:14:07.123456Z');
  });

  it('admits a JSON number capacity, which the inventory read already serves', () => {
    expect(parseCatalogPrices(page({ batteries: [battery({ capacity_ah: 54 })] })).batteries[0].capacity_ah).toBe('54');
    expect(parseCatalogPrices(page({ batteries: [battery({ capacity_ah: 6.5 })] })).batteries[0].capacity_ah).toBe('6.5');
  });

  it.each([
    ['an unknown top-level key', page({ extra: 1 })],
    ['the variant-shaped page key of the previous contract', page({ batteries: undefined, variants: [battery()] })],
    ['an unknown battery key', page({ batteries: [battery({ existing: 3 })] })],
    ['the variant-shaped row of the previous contract', page({ batteries: [battery({ variant_id: 1, polarity: 'L' })] })],
    ['an unknown price key', page({ batteries: [battery({ prices: [price({ note: 'x' })] })] })],
    ['a page size outside the matrix', page({ page_size: 15 })],
    ['more batteries than the announced page', page({ page_size: 10, batteries: Array.from({ length: 11 }, (_, index) => battery({ catalog_entry_id: index + 1 })), total_batteries: 95 })],
    ['a page past the announced total', page({ page: 2, batteries: [battery({ catalog_entry_id: 95 })], total_batteries: 1 })],
    ['an empty polarity list', page({ batteries: [battery({ polarities: [] })] })],
    ['a polarity list that is not an array', page({ batteries: [battery({ polarities: 'L' })] })],
    ['a polarity that is not L or R', page({ batteries: [battery({ polarities: ['L', 'X'] })] })],
    ['the same polarity twice', page({ batteries: [battery({ polarities: ['L', 'L'] })] })],
    ['a third polarity', page({ batteries: [battery({ polarities: ['L', 'R', 'L'] })] })],
    ['a capacity that is not canonical', page({ batteries: [battery({ capacity_ah: '035' })] })],
    ['a zero capacity', page({ batteries: [battery({ capacity_ah: '0' })] })],
    ['a duplicated battery', page({ batteries: [battery(), battery()] })],
    ['a duplicated branch', page({ branches: [branch(2, 'Sucursal A'), branch(2, 'Sucursal A')] })],
    ['a duplicated price for the same branch', page({ batteries: [battery({ prices: [price(), price()] })] })],
    ['a price for a branch outside the matrix', page({ batteries: [battery({ prices: [price({ branch_location_id: 9 })] })] })],
    ['money with one decimal', page({ batteries: [battery({ prices: [price({ min_price: '85000.0' })] })] })],
    ['money with three decimals', page({ batteries: [battery({ prices: [price({ min_price: '85000.000' })] })] })],
    ['negative money', page({ batteries: [battery({ prices: [price({ min_price: '-1.00' })] })] })],
    ['a JSON number as money', page({ batteries: [battery({ prices: [price({ min_price: 85000 })] })] })],
    ['a suggested price below the minimum', page({ batteries: [battery({ prices: [price({ suggested_price: '80000.00' })] })] })],
    ['a duplicated JSON key', '{"branches":[],"branches":[{"id":2,"name":"Sucursal A"}],"batteries":[],"page":1,"page_size":10,"total_batteries":0}'],
  ])('refuses %s', (_, body) => {
    expect(() => parseCatalogPrices(body)).toThrow();
  });

  it('admits a suggested price equal to the minimum', () => {
    const parsed = parseCatalogPrices(page({ batteries: [battery({ prices: [price({ suggested_price: '85000.00' })] })] }));
    expect(parsed.batteries[0].prices[0].suggested_price).toBe('85000.00');
  });
});

describe('catalog prices polarity wording', () => {
  it('names both polarities of the battery when the row covers two', () => {
    expect(polaritiesLabel(['L', 'R'])).toBe('Polaridades L y R');
    expect(sharedPriceLabel(['L', 'R'])).toBe('Un mismo precio para las polaridades L y R de esta batería.');
  });

  it('says it correctly when only one polarity exists', () => {
    expect(polaritiesLabel(['L'])).toBe('Polaridad L');
    expect(polaritiesLabel(['R'])).toBe('Polaridad R');
    expect(sharedPriceLabel(['R'])).toBe('Un mismo precio para la polaridad R de esta batería.');
  });
});

describe('catalog prices errors', () => {
  it.each([[400, 'invalid_request'], [401, 'unauthenticated'], [403, 'forbidden'], [404, 'not_found'], [503, 'service_unavailable']])(
    'admits the house envelope %s %s', (status, code) => {
      expect(parseCatalogPricesError(`{"error":"${code}"}`, status)).toBe(code);
    });

  it.each([
    ['an unadmitted status', '{"error":"forbidden"}', 409],
    ['an unexpected code for the status', '{"error":"retry_conflict"}', 400],
    ['a message beside the code', '{"error":"forbidden","message":"no"}', 403],
    ['a non-JSON body', 'forbidden', 403],
  ])('refuses %s', (_, body, status) => {
    expect(() => parseCatalogPricesError(body, status)).toThrow();
  });
});

describe('catalog price write errors', () => {
  it('names the retired branch the server reports', () => {
    expect(parseCatalogPricesWriteError('{"error":"retired_branch","branch_id":4}', 400))
      .toEqual({ code: 'retired_branch', branch_id: 4 });
  });

  it('reads the plain house envelope for every other failure', () => {
    expect(parseCatalogPricesWriteError('{"error":"invalid_request"}', 400)).toEqual({ code: 'invalid_request', branch_id: null });
    expect(parseCatalogPricesWriteError('{"error":"forbidden"}', 403)).toEqual({ code: 'forbidden', branch_id: null });
    expect(parseCatalogPricesError('{"error":"retired_branch"}', 400)).toBe('retired_branch');
  });

  it.each([
    ['a retired branch without a body id', '{"error":"retired_branch"}', 400],
    ['a retired branch with a warehouse id', '{"error":"retired_branch","branch_id":1}', 400],
    ['an unadmitted status', '{"error":"retired_branch","branch_id":4}', 409],
  ])('falls back on %s', (_, body, status) => {
    if (status === 400) {
      expect(parseCatalogPricesWriteError(body, status)).toEqual({ code: 'retired_branch', branch_id: null });
      return;
    }
    expect(() => parseCatalogPricesWriteError(body, status)).toThrow();
  });
});

describe('catalog price amounts', () => {
  it('formats a persisted amount with bolivian grouping', () => {
    expect(formatCatalogMoney('85000.00')).toBe('$ 85.000');
    expect(formatCatalogMoney('96000.50')).toBe('$ 96.000,50');
    expect(formatCatalogMoney('1234567.05')).toBe('$ 1.234.567,05');
  });

  it('shows the entry field without the persisted trailing zeros', () => {
    expect(catalogAmountEntry('85000.00')).toBe('85000');
    expect(catalogAmountEntry('96000.50')).toBe('96000.5');
  });

  it('compares amounts as exact cents', () => {
    expect(catalogAmountCents('85000')).toBe(8500000n);
    expect(catalogAmountCents('85000.00')).toBe(8500000n);
    expect(() => catalogAmountCents('85000.000')).toThrow();
  });

  it('labels a branch with its own tag', () => {
    expect(branchTag('Sucursal A')).toBe('A');
    expect(branchTag('Sucursal Norte')).toBe('S');
  });
});

describe('catalog price draft validation', () => {
  const draft = (overrides: Record<string, unknown> = {}) => ({
    min_price: '85000', suggested_price: '96000', branch_ids: [3, 2], ...overrides,
  });

  it('produces the exact block payload of the battery with sorted, unique branches', () => {
    const validation = validateCatalogPriceDraft(1, draft());
    expect(validation).toEqual({ valid: true, input: {
      catalog_entry_id: 1, min_price: '85000', suggested_price: '96000', branch_ids: [2, 3],
    } });
  });

  it('sends no product term, whatever the draft carried', () => {
    // The catalogue manages prices only: a draft that still holds a product term
    // fails closed instead of leaking it into the payload.
    expect(validateCatalogPriceDraft(1, draft({ warranty_months: 6 } as never)).valid).toBe(false);
    const clean = validateCatalogPriceDraft(1, draft());
    expect(clean.valid && Object.keys(clean.input).sort())
      .toEqual(['branch_ids', 'catalog_entry_id', 'min_price', 'suggested_price']);
  });

  it.each([
    ['an empty minimum', { min_price: '' }],
    ['a zero minimum', { min_price: '0' }],
    ['a negative minimum', { min_price: '-85000' }],
    ['three decimals', { min_price: '85000.123' }],
    ['a non-numeric minimum', { min_price: 'ochenta' }],
    ['an empty suggested price', { suggested_price: '  ' }],
    ['a decimal comma', { suggested_price: '96000,5' }],
  ])('rejects %s', (_, overrides) => {
    expect(validateCatalogPriceDraft(1, draft(overrides))).toEqual({ valid: false, message: catalogPriceAmountMessage });
  });

  it('rejects a suggested price below the minimum, and admits equality', () => {
    expect(validateCatalogPriceDraft(1, draft({ suggested_price: '80000' })))
      .toEqual({ valid: false, message: catalogPriceOrderMessage });
    expect(validateCatalogPriceDraft(1, draft({ suggested_price: '85000.00' })).valid).toBe(true);
    expect(validateCatalogPriceDraft(1, draft({ min_price: '85000.00', suggested_price: '85000' })).valid).toBe(true);
  });

  it.each([
    ['no branch', []],
    ['a duplicated branch', [2, 2]],
    ['a zero branch', [0]],
    ['a fractional branch', [2.5]],
    ['the warehouse as a destination', [1]],
    ['too many branches', Array.from({ length: 65 }, (_, index) => index + 2)],
  ])('rejects %s', (_, branch_ids) => {
    expect(validateCatalogPriceDraft(1, draft({ branch_ids })))
      .toEqual({ valid: false, message: catalogPriceBranchMessage });
  });

  it.each([[0], [-1], [1.5], [Number.NaN], ['1']])('rejects the battery %s', catalog_entry_id => {
    expect(validateCatalogPriceDraft(catalog_entry_id as number, draft()))
      .toEqual({ valid: false, message: catalogPriceBatteryMessage });
  });
});

describe('catalog price write evidence', () => {
  const input: CatalogPriceInput = { catalog_entry_id: 1, min_price: '85000', suggested_price: '96000', branch_ids: [2, 3] };
  const response = (overrides: Record<string, unknown> = {}) => ({
    catalog_entry_id: 1, written: 2, branch_ids: [2, 3], min_price: '85000.00', suggested_price: '96000.00',
    ...overrides,
  });

  it('accepts a reply that repeats the exact payload', () => {
    expect(matchesCatalogPriceInput(input, response())).toBe(true);
  });

  it('refuses a variant-shaped reply of the previous contract', () => {
    expect(matchesCatalogPriceInput(input, { variant_id: 1, written: 2, branch_ids: [2, 3],
      min_price: '85000.00', suggested_price: '96000.00' } as never)).toBe(false);
  });

  it.each([
    ['another battery', response({ catalog_entry_id: 2 })],
    ['another branch set', response({ branch_ids: [2, 4] })],
    ['another written count', response({ written: 1 })],
    ['another minimum', response({ min_price: '86000.00' })],
    ['another suggested price', response({ suggested_price: '97000.00' })],
    ['a suggested price below the minimum', response({ suggested_price: '80000.00' })],
  ])('refuses a reply that reports %s', (_, reply) => {
    expect(matchesCatalogPriceInput(input, reply)).toBe(false);
  });
});

describe('catalog price reply parsing', () => {
  const reply = (overrides: Record<string, unknown> = {}) => JSON.stringify({
    catalog_entry_id: 1, written: 2, branch_ids: [2, 3], min_price: '85000.00', suggested_price: '96000.00',
    ...overrides,
  });

  it('admits the exact contract reply with its persisted canonical amounts', () => {
    expect(parseCatalogPriceResult(reply())).toEqual({
      catalog_entry_id: 1, written: 2, branch_ids: [2, 3], min_price: '85000.00', suggested_price: '96000.00',
    });
  });

  it.each([
    ['a warranty term, which the contract no longer carries', reply({ warranty_months: 6 })],
    ['the variant-shaped id of the previous contract', reply({ variant_id: 1 })],
    ['an unknown key', reply({ note: 'x' })],
    ['money with three decimals', reply({ min_price: '85000.000' })],
    ['a suggested price below the minimum', reply({ suggested_price: '80000.00' })],
  ])('refuses %s', (_, body) => {
    expect(() => parseCatalogPriceResult(body)).toThrow();
  });
});
