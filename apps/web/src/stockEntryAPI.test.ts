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
