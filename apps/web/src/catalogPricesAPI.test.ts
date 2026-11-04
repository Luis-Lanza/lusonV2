import { describe, expect, it, vi } from 'vitest';
import { CatalogPricesAPIError, createCatalogPricesAPI } from './catalogPricesAPI';
import type { CatalogPriceInput, CatalogPricesQuery } from './catalogPricesModel';

const csrf = 'c'.repeat(43);
const query: CatalogPricesQuery = { search: 'NS40ZL', brand: 'CAR', capacity: '35', polarity: 'L', page: 1, page_size: 10 };
const draft = (): CatalogPriceInput => ({
  variant_id: 1, min_price: '85000', suggested_price: '96000', warranty_months: 6, branch_ids: [2, 3],
});
const json = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
const mockFetch = () => vi.fn<typeof fetch>();

const pageBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  branches: [{ id: 2, name: 'Sucursal A' }, { id: 3, name: 'Sucursal B' }],
  variants: [{ variant_id: 1, catalog_entry_id: 1, brand: 'CAR', model: 'NS40ZL', capacity_ah: '35', polarity: 'L',
    cells: ['B5', 'C5', 'D5'], warranty_months: 6, warranty_updated_at: '2026-11-04T10:00:00Z',
    prices: [{ branch_location_id: 2, min_price: '85000.00', suggested_price: '96000.00',
      updated_at: '2026-11-04T10:00:00Z', updated_by_account_id: 1, updated_by_display_name: 'Almacén' }] }],
  page: 1, page_size: 10, total_variants: 190, ...overrides,
});
const resultBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  variant_id: 1, written: 2, branch_ids: [2, 3], min_price: '85000.00', suggested_price: '96000.00',
  warranty_months: 6, ...overrides,
});

describe('catalog prices read transport', () => {
  it('reads one matrix page with the exact query and the session cookie', async () => {
    const fetch = mockFetch().mockResolvedValue(json(pageBody()));
    const page = await createCatalogPricesAPI(fetch).list(query);
    expect(page.total_variants).toBe(190);
    expect(page.variants[0].prices[0].min_price).toBe('85000.00');
    expect(fetch.mock.calls[0]).toEqual([
      '/api/catalog/prices?search=NS40ZL&brand=CAR&capacity=35&polarity=L&page=1&page_size=10',
      { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: undefined },
    ]);
  });

  it('leaves out the filters the operator left blank and always sends page and size', async () => {
    const fetch = mockFetch().mockResolvedValue(json(pageBody()));
    await createCatalogPricesAPI(fetch).list({ ...query, search: '', brand: '', capacity: '', polarity: '' });
    expect(fetch.mock.calls[0][0]).toBe('/api/catalog/prices?page=1&page_size=10');
  });

  it('forwards the abort signal of the read', async () => {
    const controller = new AbortController();
    const fetch = mockFetch().mockResolvedValue(json(pageBody()));
    await createCatalogPricesAPI(fetch).list(query, controller.signal);
    expect(fetch.mock.calls[0][1]?.signal).toBe(controller.signal);
  });

  it.each([[400, 'invalid_request'], [401, 'unauthenticated'], [403, 'forbidden'], [404, 'not_found'], [503, 'service_unavailable']])(
    'reports the admitted %s %s with its status', async (status, code) => {
      const fetch = mockFetch().mockResolvedValue(json(`{"error":"${code}"}`, status));
      const failure = await createCatalogPricesAPI(fetch).list(query).catch(error => error);
      expect(failure).toBeInstanceOf(CatalogPricesAPIError);
      expect(failure).toMatchObject({ code, status });
    });

  it.each([
    ['a text/html body', new Response(pageBody(), { status: 200, headers: { 'Content-Type': 'text/html' } })],
    ['a page that reports another size', json(pageBody({ page_size: 25 }))],
    ['an uninterpretable error code', json('{"error":"unauthenticated"}', 400)],
  ])('refuses to interpret %s', async (_, reply) => {
    const fetch = mockFetch().mockResolvedValue(reply);
    await expect(createCatalogPricesAPI(fetch).list(query)).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('fails closed on an inadmissible query without any call', async () => {
    const fetch = mockFetch();
    await expect(createCatalogPricesAPI(fetch).list({ ...query, page_size: 15 }))
      .rejects.toMatchObject({ code: 'invalid_request', status: null });
    await expect(createCatalogPricesAPI(fetch).list({ ...query, search: 'x'.repeat(129) }))
      .rejects.toMatchObject({ code: 'invalid_request', status: null });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('distinguishes a lost connection from an aborted read', async () => {
    const network = mockFetch().mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(createCatalogPricesAPI(network).list(query)).rejects.toMatchObject({ code: 'network', status: null });
    const controller = new AbortController();
    controller.abort();
    const aborted = mockFetch().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await expect(createCatalogPricesAPI(aborted).list(query, controller.signal))
      .rejects.toMatchObject({ code: 'aborted', status: null });
  });
});

describe('catalog prices write transport', () => {
  it('puts the exact block payload to the frozen path with the session CSRF header', async () => {
    const fetch = mockFetch().mockResolvedValue(json(resultBody()));
    const result = await createCatalogPricesAPI(fetch).apply(draft(), 6, csrf);
    expect(result).toMatchObject({ variant_id: 1, written: 2, warranty_months: 6 });
    expect(fetch.mock.calls[0]).toEqual(['/api/catalog/prices', {
      method: 'PUT', credentials: 'same-origin', cache: 'no-store', signal: undefined,
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: '{"variant_id":1,"min_price":"85000","suggested_price":"96000","warranty_months":6,"branch_ids":[2,3]}',
    }]);
  });

  it('omits the warranty term when the variant already has one', async () => {
    const fetch = mockFetch().mockResolvedValue(json(resultBody({ warranty_months: 12 })));
    const result = await createCatalogPricesAPI(fetch).apply({ ...draft(), warranty_months: undefined }, 12, csrf);
    expect(result.warranty_months).toBe(12);
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({
      variant_id: 1, min_price: '85000', suggested_price: '96000', branch_ids: [2, 3],
    });
  });

  it('captures the exact payload before awaiting and sends the abort signal', async () => {
    let resolve!: (value: Response) => void;
    const fetch = mockFetch().mockReturnValue(new Promise<Response>(yes => { resolve = yes; }));
    const input = draft() as { variant_id: number; min_price: string; suggested_price: string;
      warranty_months?: number; branch_ids: number[] };
    const controller = new AbortController();
    const job = createCatalogPricesAPI(fetch).apply(input, 6, csrf, controller.signal);
    input.min_price = '1';
    input.branch_ids.pop();
    resolve(json(resultBody()));
    await job;
    expect(fetch.mock.calls[0][1]?.signal).toBe(controller.signal);
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({
      variant_id: 1, min_price: '85000', suggested_price: '96000', warranty_months: 6, branch_ids: [2, 3],
    });
  });

  it.each([[400, 'invalid_request'], [401, 'unauthenticated'], [403, 'forbidden'], [404, 'not_found'], [503, 'service_unavailable']])(
    'reports the admitted %s %s with its status', async (status, code) => {
      const fetch = mockFetch().mockResolvedValue(json(`{"error":"${code}"}`, status));
      await expect(createCatalogPricesAPI(fetch).apply(draft(), 6, csrf)).rejects.toMatchObject({ code, status, branchId: null });
    });

  it('carries the id of a retired branch so the caller can name it', async () => {
    const fetch = mockFetch().mockResolvedValue(json('{"error":"retired_branch","branch_id":4}', 400));
    await expect(createCatalogPricesAPI(fetch).apply(draft(), 6, csrf))
      .rejects.toMatchObject({ code: 'retired_branch', status: 400, branchId: 4 });
  });

  it.each([
    ['a text/html body', new Response(resultBody(), { status: 200, headers: { 'Content-Type': 'text/html' } })],
    ['another variant', json(resultBody({ variant_id: 2 }))],
    ['another branch set', json(resultBody({ branch_ids: [2, 4] }))],
    ['another written count', json(resultBody({ written: 1 }))],
    ['another minimum', json(resultBody({ min_price: '86000.00' }))],
    ['another warranty term', json(resultBody({ warranty_months: 12 }))],
    ['an unadmitted success status', json(resultBody(), 201)],
    ['an uninterpretable error code', json('{"error":"forbidden"}', 409)],
  ])('refuses to interpret %s', async (_, reply) => {
    const fetch = mockFetch().mockResolvedValue(reply);
    await expect(createCatalogPricesAPI(fetch).apply(draft(), 6, csrf))
      .rejects.toMatchObject({ code: 'invalid_response' });
  });

  it.each([
    ['a suggested price below the minimum', { ...draft(), suggested_price: '80000' }, 6, csrf],
    ['no branch', { ...draft(), branch_ids: [] }, 6, csrf],
    ['a minimum with three decimals', { ...draft(), min_price: '85000.123' }, 6, csrf],
    ['a missing CSRF token', draft(), 6, ''],
    ['a CSRF token with forbidden characters', draft(), 6, 'not a token'],
  ])('fails closed on %s without any network call', async (_, input, warranty, token) => {
    const fetch = mockFetch();
    await expect(createCatalogPricesAPI(fetch).apply(input as CatalogPriceInput, warranty as number, token as string))
      .rejects.toMatchObject({ code: 'invalid_request', status: null });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('distinguishes a lost connection from an aborted write', async () => {
    const network = mockFetch().mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(createCatalogPricesAPI(network).apply(draft(), 6, csrf)).rejects.toMatchObject({ code: 'network', status: null });
    const controller = new AbortController();
    controller.abort();
    const aborted = mockFetch().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await expect(createCatalogPricesAPI(aborted).apply(draft(), 6, csrf, controller.signal))
      .rejects.toMatchObject({ code: 'aborted', status: null });
  });
});
