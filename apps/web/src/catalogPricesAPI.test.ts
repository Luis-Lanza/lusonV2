import { describe, expect, it, vi } from 'vitest';
import { CatalogPricesAPIError, createCatalogPricesAPI } from './catalogPricesAPI';
import type { CatalogPriceInput, CatalogPricesQuery } from './catalogPricesModel';

const csrf = 'c'.repeat(43);
const query: CatalogPricesQuery = { search: 'NS40ZL', brand: 'CAR', capacity: '35', page: 1, page_size: 10 };
const draft = (): CatalogPriceInput => ({
  catalog_entry_id: 1, min_price: '85000', suggested_price: '96000', branch_ids: [2, 3],
});
const json = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
const mockFetch = () => vi.fn<typeof fetch>();

const pageBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  branches: [{ id: 2, name: 'Sucursal A' }, { id: 3, name: 'Sucursal B' }],
  batteries: [{ catalog_entry_id: 1, brand: 'CAR', model: 'NS40ZL', capacity_ah: '35', polarities: ['L', 'R'],
    cells: ['B5', 'C5', 'D5'],
    prices: [{ branch_location_id: 2, min_price: '85000.00', suggested_price: '96000.00',
      updated_at: '2026-11-04T10:00:00Z', updated_by_account_id: 1, updated_by_display_name: 'Almacén' }] }],
  page: 1, page_size: 10, total_batteries: 95, ...overrides,
});
const resultBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  catalog_entry_id: 1, written: 2, branch_ids: [2, 3], min_price: '85000.00', suggested_price: '96000.00',
  ...overrides,
});

describe('catalog prices read transport', () => {
  it('reads one matrix page with the exact query and the session cookie', async () => {
    const fetch = mockFetch().mockResolvedValue(json(pageBody()));
    const page = await createCatalogPricesAPI(fetch).list(query);
    expect(page.total_batteries).toBe(95);
    expect(page.batteries[0].polarities).toEqual(['L', 'R']);
    expect(page.batteries[0].prices[0].min_price).toBe('85000.00');
    expect(fetch.mock.calls[0]).toEqual([
      '/api/catalog/prices?search=NS40ZL&brand=CAR&capacity=35&page=1&page_size=10',
      { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: undefined },
    ]);
  });

  it('leaves out the filters the operator left blank and always sends page and size', async () => {
    const fetch = mockFetch().mockResolvedValue(json(pageBody()));
    await createCatalogPricesAPI(fetch).list({ ...query, search: '', brand: '', capacity: '' });
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
    ['the variant-shaped page of the previous contract', json(pageBody({ batteries: undefined, variants: [] }))],
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
    const result = await createCatalogPricesAPI(fetch).apply(draft(), csrf);
    expect(result).toMatchObject({ catalog_entry_id: 1, written: 2, branch_ids: [2, 3], min_price: '85000.00' });
    expect(Object.keys(result).sort())
      .toEqual(['branch_ids', 'catalog_entry_id', 'min_price', 'suggested_price', 'written']);
    expect(fetch.mock.calls[0]).toEqual(['/api/catalog/prices', {
      method: 'PUT', credentials: 'same-origin', cache: 'no-store', signal: undefined,
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: '{"catalog_entry_id":1,"min_price":"85000","suggested_price":"96000","branch_ids":[2,3]}',
    }]);
  });

  it('captures the exact payload before awaiting and sends the abort signal', async () => {
    let resolve!: (value: Response) => void;
    const fetch = mockFetch().mockReturnValue(new Promise<Response>(yes => { resolve = yes; }));
    const input = draft() as { catalog_entry_id: number; min_price: string; suggested_price: string;
      branch_ids: number[] };
    const controller = new AbortController();
    const job = createCatalogPricesAPI(fetch).apply(input, csrf, controller.signal);
    input.min_price = '1';
    input.branch_ids.pop();
    resolve(json(resultBody()));
    await job;
    expect(fetch.mock.calls[0][1]?.signal).toBe(controller.signal);
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({
      catalog_entry_id: 1, min_price: '85000', suggested_price: '96000', branch_ids: [2, 3],
    });
  });

  it.each([[400, 'invalid_request'], [401, 'unauthenticated'], [403, 'forbidden'], [404, 'not_found'], [503, 'service_unavailable']])(
    'reports the admitted %s %s with its status', async (status, code) => {
      const fetch = mockFetch().mockResolvedValue(json(`{"error":"${code}"}`, status));
      await expect(createCatalogPricesAPI(fetch).apply(draft(), csrf)).rejects.toMatchObject({ code, status, branchId: null });
    });

  it('carries the id of a retired branch so the caller can name it', async () => {
    const fetch = mockFetch().mockResolvedValue(json('{"error":"retired_branch","branch_id":4}', 400));
    await expect(createCatalogPricesAPI(fetch).apply(draft(), csrf))
      .rejects.toMatchObject({ code: 'retired_branch', status: 400, branchId: 4 });
  });

  it.each([
    ['a text/html body', new Response(resultBody(), { status: 200, headers: { 'Content-Type': 'text/html' } })],
    ['another battery', json(resultBody({ catalog_entry_id: 2 }))],
    ['the variant-shaped echo of the previous contract', json(resultBody({ variant_id: 1 }))],
    ['a warranty term the contract no longer carries', json(resultBody({ warranty_months: 6 }))],
    ['another branch set', json(resultBody({ branch_ids: [2, 4] }))],
    ['another written count', json(resultBody({ written: 1 }))],
    ['another minimum', json(resultBody({ min_price: '86000.00' }))],
    ['an unadmitted success status', json(resultBody(), 201)],
    ['an uninterpretable error code', json('{"error":"forbidden"}', 409)],
  ])('refuses to interpret %s', async (_, reply) => {
    const fetch = mockFetch().mockResolvedValue(reply);
    await expect(createCatalogPricesAPI(fetch).apply(draft(), csrf))
      .rejects.toMatchObject({ code: 'invalid_response' });
  });

  it.each([
    ['a suggested price below the minimum', { ...draft(), suggested_price: '80000' }, csrf],
    ['no branch', { ...draft(), branch_ids: [] }, csrf],
    ['a minimum with three decimals', { ...draft(), min_price: '85000.123' }, csrf],
    ['an invalid battery id', { ...draft(), catalog_entry_id: 0 }, csrf],
    ['a missing CSRF token', draft(), ''],
    ['a CSRF token with forbidden characters', draft(), 'not a token'],
  ])('fails closed on %s without any network call', async (_, input, token) => {
    const fetch = mockFetch();
    await expect(createCatalogPricesAPI(fetch).apply(input as CatalogPriceInput, token as string))
      .rejects.toMatchObject({ code: 'invalid_request', status: null });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('distinguishes a lost connection from an aborted write', async () => {
    const network = mockFetch().mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(createCatalogPricesAPI(network).apply(draft(), csrf)).rejects.toMatchObject({ code: 'network', status: null });
    const controller = new AbortController();
    controller.abort();
    const aborted = mockFetch().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await expect(createCatalogPricesAPI(aborted).apply(draft(), csrf, controller.signal))
      .rejects.toMatchObject({ code: 'aborted', status: null });
  });
});
