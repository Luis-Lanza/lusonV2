import { describe, expect, it, vi } from 'vitest';
import { createStockEntryAPI, StockEntryAPIError } from './stockEntryAPI';
import type { StockEntryInput } from './stockEntryModel';

const csrf = 'c'.repeat(43);
const draft = (): StockEntryInput => ({
  operation_key: 'warehouse_key_0001', note: 'Remito 0002',
  lines: [{ variant_id: 9, quantity: 1 }, { variant_id: 4, quantity: 2 }],
});
const recordBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  id: 7, location_id: 1, note: 'Remito 0002', created_by_account_id: 1, created_at: '2026-05-01T14:20:00Z',
  lines: [{ variant_id: 4, quantity: 2 }, { variant_id: 9, quantity: 1 }], total_units: 3, ...overrides,
});
const json = (body: string, status = 201) => new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
const mockFetch = () => vi.fn<typeof fetch>();
const historyRow = (overrides: Record<string, unknown> = {}) => ({
  id: 7, note: 'Remito 0002', created_at: '2026-05-01T14:20:00Z',
  lines: 2, total_units: 18, reversed_by: null, ...overrides });
const historyBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  page: 1, page_size: 25, total_entries: 1, entries: [historyRow()], ...overrides });
const historyResponse = (body = historyBody()) => json(body, 200);

describe('stock entry API transport', () => {
  it.each([[201, false], [200, true]])('posts the canonical payload with the session CSRF header (%s)', async (status, replayed) => {
    const fetch = mockFetch().mockResolvedValue(json(recordBody(), status));
    const result = await createStockEntryAPI(fetch).create(draft(), csrf);
    expect(result.replayed).toBe(replayed);
    expect(result.record).toMatchObject({ id: 7, location_id: 1, total_units: 3, note: 'Remito 0002' });
    expect(fetch.mock.calls[0]).toEqual(['/api/stock-entries', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: undefined,
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: '{"operation_key":"warehouse_key_0001","note":"Remito 0002","lines":[{"variant_id":4,"quantity":2},{"variant_id":9,"quantity":1}]}',
    }]);
  });

  it('captures the exact payload before awaiting, so later mutations cannot change it', async () => {
    let resolve!: (value: Response) => void;
    const fetch = mockFetch().mockReturnValue(new Promise<Response>(yes => { resolve = yes; }));
    // Deliberately mutable copy: the API must not read it again after the first await.
    const input = draft() as { operation_key: string; note?: string; lines: { variant_id: number; quantity: number }[] };
    const job = createStockEntryAPI(fetch).create(input, csrf);
    input.lines[0].quantity = 500;
    input.note = 'mutated';
    input.operation_key = 'warehouse_key_9999';
    resolve(json(recordBody()));
    await job;
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({
      operation_key: 'warehouse_key_0001', note: 'Remito 0002',
      lines: [{ variant_id: 4, quantity: 2 }, { variant_id: 9, quantity: 1 }],
    });
  });

  it('sends the abort signal it was given', async () => {
    const fetch = mockFetch().mockResolvedValue(json(recordBody()));
    const controller = new AbortController();
    await createStockEntryAPI(fetch).create(draft(), csrf, controller.signal);
    expect(fetch.mock.calls[0][1]?.signal).toBe(controller.signal);
  });

  it.each([
    ['a text/html body', new Response(recordBody(), { status: 201, headers: { 'Content-Type': 'text/html' } }), 'invalid_response'],
    ['an unparseable record', json('not json'), 'invalid_response'],
    ['a record with another quantity', json(recordBody({ lines: [{ variant_id: 4, quantity: 3 }, { variant_id: 9, quantity: 1 }], total_units: 3 })), 'invalid_response'],
    ['a record with another variant set', json(recordBody({ lines: [{ variant_id: 4, quantity: 2 }, { variant_id: 5, quantity: 1 }] })), 'invalid_response'],
    ['a record whose total does not add up', json(recordBody({ total_units: 9 })), 'invalid_response'],
    ['a record outside the warehouse', json(recordBody({ location_id: 2 })), 'invalid_response'],
    ['an unadmitted success status', json(recordBody(), 202), 'invalid_response'],
  ])('rejects %s', async (_, reply, code) => {
    const fetch = mockFetch().mockResolvedValue(reply);
    await expect(createStockEntryAPI(fetch).create(draft(), csrf)).rejects.toMatchObject({ name: 'StockEntryAPIError', code });
  });

  it.each([
    [400, 'invalid_request'], [403, 'forbidden'], [409, 'retry_conflict'], [409, 'insufficient_stock'], [503, 'service_unavailable'],
  ])('reports the admitted %s %s code with its status', async (status, code) => {
    const fetch = mockFetch().mockResolvedValue(json(`{"error":"${code}"}`, status));
    const failure = await createStockEntryAPI(fetch).create(draft(), csrf).catch(error => error);
    expect(failure).toBeInstanceOf(StockEntryAPIError);
    expect(failure).toMatchObject({ code, status });
  });

  it.each([
    ['a code the status does not admit', json('{"error":"retry_conflict"}', 403)],
    ['an error envelope with extra keys', json('{"error":"forbidden","detail":"x"}', 403)],
    ['a non JSON error body', new Response('proxy down', { status: 503, headers: { 'Content-Type': 'text/plain' } })],
    ['an unlisted status', json('{"error":"invalid_request"}', 500)],
  ])('refuses to interpret %s', async (_, reply) => {
    const fetch = mockFetch().mockResolvedValue(reply);
    await expect(createStockEntryAPI(fetch).create(draft(), csrf)).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('distinguishes a lost connection from an aborted attempt', async () => {
    const network = mockFetch().mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(createStockEntryAPI(network).create(draft(), csrf)).rejects.toMatchObject({ code: 'network', status: null });
    const controller = new AbortController();
    controller.abort();
    const aborted = mockFetch().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await expect(createStockEntryAPI(aborted).create(draft(), csrf, controller.signal)).rejects.toMatchObject({ code: 'aborted', status: null });
  });

  it.each([
    ['an invalid draft', { operation_key: 'short', lines: [{ variant_id: 4, quantity: 1 }] } as StockEntryInput, csrf],
    ['a missing CSRF token', draft(), ''],
    ['a CSRF token with forbidden characters', draft(), 'not a token'],
  ])('fails closed on %s without any network call', async (_, input, token) => {
    const fetch = mockFetch();
    await expect(createStockEntryAPI(fetch).create(input, token)).rejects.toMatchObject({ code: 'invalid_request', status: null });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('stock ingress history transport', () => {
  it('reads one page with the session cookie and no CSRF header', async () => {
    const fetch = mockFetch().mockResolvedValue(historyResponse());
    const page = await createStockEntryAPI(fetch).history(2, 50);
    expect(page).toMatchObject({ page: 1, page_size: 25, total_entries: 1 });
    expect(page.entries[0]).toEqual({ id: 7, note: 'Remito 0002', created_at: '2026-05-01T14:20:00Z',
      lines: 2, total_units: 18, reversed_by: null });
    expect(fetch.mock.calls[0]).toEqual(['/api/stock-entries?page=2&page_size=50', {
      method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: undefined,
    }]);
  });

  it('sends the abort signal it was given', async () => {
    const fetch = mockFetch().mockResolvedValue(historyResponse());
    const controller = new AbortController();
    await createStockEntryAPI(fetch).history(1, 10, controller.signal);
    expect(fetch.mock.calls[0][1]?.signal).toBe(controller.signal);
  });

  it.each([
    ['a text/html body', new Response(historyBody(), { status: 200, headers: { 'Content-Type': 'text/html' } }), 'invalid_response'],
    ['an unparseable page', json('not json', 200), 'invalid_response'],
    ['a page with a foreign row', json(historyBody({ entries: [historyRow({ variant_id: 4 })] }), 200), 'invalid_response'],
    ['a page with a wrong size', json(historyBody({ page_size: 15 }), 200), 'invalid_response'],
    ['a page outside the request', json(historyBody({ page: 7 }), 200), 'invalid_response'],
    ['an unadmitted success status', json(historyBody(), 201), 'invalid_response'],
  ])('rejects %s', async (_, reply, code) => {
    const fetch = mockFetch().mockResolvedValue(reply);
    await expect(createStockEntryAPI(fetch).history(1, 25)).rejects.toMatchObject({ name: 'StockEntryAPIError', code });
  });

  it.each([[400, 'invalid_request'], [403, 'forbidden'], [503, 'service_unavailable']])(
    'reports the admitted %s %s code with its status', async (status, code) => {
    const fetch = mockFetch().mockResolvedValue(json(`{"error":"${code}"}`, status));
    const failure = await createStockEntryAPI(fetch).history(1, 25).catch(error => error);
    expect(failure).toBeInstanceOf(StockEntryAPIError);
    expect(failure).toMatchObject({ code, status });
  });

  it.each([
    ['a code the status does not admit', json('{"error":"retry_conflict"}', 403)],
    ['an error envelope with extra keys', json('{"error":"forbidden","detail":"x"}', 403)],
    ['a non JSON error body', new Response('proxy down', { status: 503, headers: { 'Content-Type': 'text/plain' } })],
    ['an unlisted failure status', json('{"error":"invalid_request"}', 500)],
  ])('refuses to interpret %s', async (_, reply) => {
    const fetch = mockFetch().mockResolvedValue(reply);
    await expect(createStockEntryAPI(fetch).history(1, 25)).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('distinguishes a lost connection from an aborted read', async () => {
    const network = mockFetch().mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(createStockEntryAPI(network).history(1, 25)).rejects.toMatchObject({ code: 'network', status: null });
    const controller = new AbortController();
    controller.abort();
    const aborted = mockFetch().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await expect(createStockEntryAPI(aborted).history(1, 25, controller.signal)).rejects.toMatchObject({ code: 'aborted', status: null });
  });

  it.each([[0, 25], [1, 15], [1000001, 25], [1.5, 25], [1, 100]])('fails closed on page %s size %s without any network call', async (page, size) => {
    const fetch = mockFetch();
    await expect(createStockEntryAPI(fetch).history(page, size)).rejects.toMatchObject({ code: 'invalid_request', status: null });
    expect(fetch).not.toHaveBeenCalled();
  });
});
