import { describe, expect, it } from 'vitest';
import {
  branchTag, catalogAmountCents, catalogAmountEntry, catalogPriceAmountMessage, catalogPriceBranchMessage,
  catalogPriceOrderMessage, catalogPricesPath, catalogPriceWarrantyMessage, formatCatalogMoney,
  matchesCatalogPriceInput, parseCatalogPrices, parseCatalogPricesError, parseCatalogPricesWriteError,
  validCatalogPricesQuery, validateCatalogPriceDraft, type CatalogPriceInput,
} from './catalogPricesModel';

const branch = (id: number, name: string) => ({ id, name });
const price = (overrides: Record<string, unknown> = {}) => ({
  branch_location_id: 2, min_price: '85000.00', suggested_price: '96000.00',
  updated_at: '2026-11-04T10:00:00Z', updated_by_account_id: 1, updated_by_display_name: 'Almacén', ...overrides,
});
const variant = (overrides: Record<string, unknown> = {}) => ({
  variant_id: 1, catalog_entry_id: 1, brand: 'CAR', model: 'NS40ZL', capacity_ah: '35', polarity: 'L',
  cells: ['B5', 'C5', 'D5'], warranty_months: 6, warranty_updated_at: '2026-11-04T10:00:00Z',
  prices: [price()], ...overrides,
});
const page = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  branches: [branch(2, 'Sucursal A'), branch(3, 'Sucursal B')],
  variants: [variant()], page: 1, page_size: 10, total_variants: 190, ...overrides,
});

describe('catalog prices read path', () => {
  it('omits the filters the operator left blank, which the contract refuses empty', () => {
    const query = { search: '', brand: '', capacity: '', polarity: '' as const, page: 1, page_size: 10 };
    expect(catalogPricesPath(query)).toBe('/api/catalog/prices?page=1&page_size=10');
    expect(catalogPricesPath({ ...query, brand: 'CAR' })).toBe('/api/catalog/prices?brand=CAR&page=1&page_size=10');
    expect(catalogPricesPath({ ...query, search: 'NS40ZL', brand: 'CAR', capacity: '35', polarity: 'L', page: 2, page_size: 25 }))
      .toBe('/api/catalog/prices?search=NS40ZL&brand=CAR&capacity=35&polarity=L&page=2&page_size=25');
  });

  it.each([
    ['a page below one', { page: 0, page_size: 10 }],
    ['a page above the limit', { page: 1_000_001, page_size: 10 }],
    ['a page size outside the matrix', { page: 1, page_size: 15 }],
    ['a fractional page', { page: 1.5, page_size: 10 }],
  ])('refuses %s', (_, overrides) => {
    expect(validCatalogPricesQuery({ search: '', brand: '', capacity: '', polarity: '', ...overrides })).toBe(false);
  });

  it.each([
    ['an oversized search', { search: 'x'.repeat(129) }],
    ['a search with NUL', { search: 'a\0b' }],
    ['a capacity that is not a decimal', { capacity: '35 Ah' }],
    ['an unknown polarity', { polarity: 'X' }],
    ['a brand with NUL', { brand: 'C\0R' }],
  ])('refuses %s', (_, overrides) => {
    expect(validCatalogPricesQuery({ search: '', brand: '', capacity: '', polarity: '', page: 1, page_size: 10, ...overrides } as never)).toBe(false);
  });

  it('admits the contract query', () => {
    expect(validCatalogPricesQuery({ search: 'NS40ZL', brand: 'CAR', capacity: '35', polarity: 'L', page: 1, page_size: 10 })).toBe(true);
    expect(validCatalogPricesQuery({ search: '', brand: '', capacity: '', polarity: '', page: 1, page_size: 50 })).toBe(true);
  });
});

describe('catalog prices read mapping', () => {
  it('keeps money as exact decimal text and maps every chip of the matrix', () => {
    const parsed = parseCatalogPrices(page());
    expect(parsed.page).toBe(1);
    expect(parsed.total_variants).toBe(190);
    expect(parsed.branches.map(b => b.name)).toEqual(['Sucursal A', 'Sucursal B']);
    const row = parsed.variants[0];
    expect(row).toMatchObject({ variant_id: 1, brand: 'CAR', model: 'NS40ZL', capacity_ah: '35', polarity: 'L', warranty_months: 6 });
    expect(row.cells).toEqual(['B5', 'C5', 'D5']);
    expect(row.prices[0].min_price).toBe('85000.00');
    expect(row.prices[0].suggested_price).toBe('96000.00');
    expect(typeof row.prices[0].min_price).toBe('string');
  });

  it('admits a variant with no warranty term and no price in any branch', () => {
    const parsed = parseCatalogPrices(page({
      variants: [variant({ warranty_months: null, warranty_updated_at: null, prices: [], cells: [] })],
    }));
    expect(parsed.variants[0].warranty_months).toBeNull();
    expect(parsed.variants[0].prices).toEqual([]);
    expect(parsed.variants[0].cells).toEqual([]);
  });

  it('admits a JSON number capacity, which the inventory read already serves', () => {
    expect(parseCatalogPrices(page({ variants: [variant({ capacity_ah: 54 })] })).variants[0].capacity_ah).toBe('54');
    expect(parseCatalogPrices(page({ variants: [variant({ capacity_ah: 6.5 })] })).variants[0].capacity_ah).toBe('6.5');
  });

  it.each([
    ['an unknown top-level key', page({ extra: 1 })],
    ['an unknown variant key', page({ variants: [variant({ existing: 3 })] })],
    ['an unknown price key', page({ variants: [variant({ prices: [price({ note: 'x' })] })] })],
    ['a page size outside the matrix', page({ page_size: 15 })],
    ['more variants than the announced page', page({ page_size: 10, variants: Array.from({ length: 11 }, (_, index) => variant({ variant_id: index + 1 })), total_variants: 190 })],
    ['a page past the announced total', page({ page: 2, variants: [variant({ variant_id: 190 })], total_variants: 1 })],
    ['a polarity that is not L or R', page({ variants: [variant({ polarity: 'X' })] })],
    ['a capacity that is not canonical', page({ variants: [variant({ capacity_ah: '035' })] })],
    ['a zero capacity', page({ variants: [variant({ capacity_ah: '0' })] })],
    ['a duplicated variant', page({ variants: [variant(), variant()] })],
    ['a duplicated branch', page({ branches: [branch(2, 'Sucursal A'), branch(2, 'Sucursal A')] })],
    ['a duplicated price for the same branch', page({ variants: [variant({ prices: [price(), price()] })] })],
    ['a price for a branch outside the matrix', page({ variants: [variant({ prices: [price({ branch_location_id: 9 })] })] })],
    ['money with one decimal', page({ variants: [variant({ prices: [price({ min_price: '85000.0' })] })] })],
    ['money with three decimals', page({ variants: [variant({ prices: [price({ min_price: '85000.000' })] })] })],
    ['negative money', page({ variants: [variant({ prices: [price({ min_price: '-1.00' })] })] })],
    ['a JSON number as money', page({ variants: [variant({ prices: [price({ min_price: 85000 })] })] })],
    ['a suggested price below the minimum', page({ variants: [variant({ prices: [price({ suggested_price: '80000.00' })] })] })],
    ['a fractional warranty term', page({ variants: [variant({ warranty_months: 1.5 })] })],
    ['a warranty term without its stamp', page({ variants: [variant({ warranty_months: 6, warranty_updated_at: null })] })],
    ['a warranty stamp without its term', page({ variants: [variant({ warranty_months: null, warranty_updated_at: '2026-11-04T10:00:00Z' })] })],
    ['a duplicated JSON key', '{"branches":[],"branches":[{"id":2,"name":"Sucursal A"}],"variants":[],"page":1,"page_size":10,"total_variants":0}'],
  ])('refuses %s', (_, body) => {
    expect(() => parseCatalogPrices(body)).toThrow();
  });

  it('admits a suggested price equal to the minimum', () => {
    const parsed = parseCatalogPrices(page({ variants: [variant({ prices: [price({ suggested_price: '85000.00' })] })] }));
    expect(parsed.variants[0].prices[0].suggested_price).toBe('85000.00');
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

  it('produces the exact block payload with sorted, unique branches', () => {
    const validation = validateCatalogPriceDraft(1, draft());
    expect(validation).toEqual({ valid: true, input: {
      variant_id: 1, min_price: '85000', suggested_price: '96000', branch_ids: [2, 3],
    } });
  });

  it('sends the warranty term only when the variant has none yet', () => {
    const validation = validateCatalogPriceDraft(1, draft({ warranty_months: 6 }));
    expect(validation.valid && Object.hasOwn(validation.input, 'warranty_months')).toBe(true);
    const existing = validateCatalogPriceDraft(1, draft());
    expect(existing.valid && Object.hasOwn(existing.input, 'warranty_months')).toBe(false);
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

  it.each([[0], [121], [1.5], [Number.NaN], ['6']])('rejects the warranty term %s', warranty_months => {
    expect(validateCatalogPriceDraft(1, draft({ warranty_months } as never)))
      .toEqual({ valid: false, message: catalogPriceWarrantyMessage });
  });
});

describe('catalog price write evidence', () => {
  const input: CatalogPriceInput = { variant_id: 1, min_price: '85000', suggested_price: '96000', warranty_months: 6, branch_ids: [2, 3] };
  const response = (overrides: Record<string, unknown> = {}) => ({
    variant_id: 1, written: 2, branch_ids: [2, 3], min_price: '85000.00', suggested_price: '96000.00',
    warranty_months: 6, ...overrides,
  });

  it('accepts a reply that repeats the exact payload', () => {
    expect(matchesCatalogPriceInput(input, 6, response())).toBe(true);
  });

  it('accepts a reply for a variant whose term was already set', () => {
    const withoutTerm: CatalogPriceInput = { variant_id: 1, min_price: '85000', suggested_price: '96000', branch_ids: [2] };
    expect(matchesCatalogPriceInput(withoutTerm, 12, response({ written: 1, branch_ids: [2], warranty_months: 12 }))).toBe(true);
  });

  it.each([
    ['another variant', response({ variant_id: 2 })],
    ['another branch set', response({ branch_ids: [2, 4] })],
    ['another written count', response({ written: 1 })],
    ['another minimum', response({ min_price: '86000.00' })],
    ['another suggested price', response({ suggested_price: '97000.00' })],
    ['another warranty term', response({ warranty_months: 12 })],
    ['a suggested price below the minimum', response({ suggested_price: '80000.00' })],
  ])('refuses a reply that reports %s', (_, reply) => {
    expect(matchesCatalogPriceInput(input, 6, reply)).toBe(false);
  });
});
