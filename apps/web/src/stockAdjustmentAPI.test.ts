import { describe, expect, it, vi } from 'vitest';
import { createStockAdjustmentAPI, StockAdjustmentAPIError } from './stockAdjustmentAPI';
import type { StockAdjustmentInput, StockAdjustmentSummary } from './stockAdjustmentModel';

const csrf = 'c'.repeat(43);
const motive = 'Conteo físico periódico';
const draft = (): StockAdjustmentInput => ({
  operation_key: 'warehouse_adjustment_key_01', reason: motive,
  lines: [{ variant_id: 9, counted_quantity: 12 }, { variant_id: 4, counted_quantity: 0 }],
});
const listed = (overrides: Record<string, unknown> = {}): StockAdjustmentSummary => ({
  id: 6, reason: motive, detail: '', created_at: '2026-11-04T14:20:00Z',
  lines: 2, total_difference: -15, reverses_adjustment_id: null, reversed_by: null, ...overrides,
} as StockAdjustmentSummary);
const json = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
const mockFetch = () => vi.fn<typeof fetch>();

const recordBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  id: 7, location_id: 1, reason: motive, detail: '', created_by_account_id: 1,
  created_at: '2026-11-04T14:20:00Z', reverses_adjustment_id: null,
  lines: [{ variant_id: 4, expected_quantity: 18, counted_quantity: 0, difference: -18 },
    { variant_id: 9, expected_quantity: 9, counted_quantity: 12, difference: 3 }],
  total_difference: -15, ...overrides,
});
const counterBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  id: 9, location_id: 1, reason: motive, detail: '', created_by_account_id: 1,
  created_at: '2026-11-04T14:21:00Z', reverses_adjustment_id: 6,
  lines: [{ variant_id: 4, expected_quantity: 0, counted_quantity: 18, difference: 18 },
    { variant_id: 9, expected_quantity: 12, counted_quantity: 9, difference: -3 }],
  total_difference: 15, ...overrides,
});
const historyBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  page: 1, page_size: 25, total_adjustments: 1,
  adjustments: [{ id: 6, reason: motive, detail: '', created_at: '2026-11-04T14:20:00Z',
    lines: 2, total_difference: -4, reverses_adjustment_id: null, reversed_by: null }], ...overrides,
});
const detailBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  id: 6, location_id: 1, reason: motive, detail: '', created_at: '2026-11-04T14:20:00Z',
  created_by_account_id: 1, reverses_adjustment_id: null, reversed_by: null, reversed_by_reason: '',
  lines: [{ variant_id: 7, catalog_entry_id: 4, brand: 'TOYO', model: 'NS60L', capacity_ah: '45',
    polarity: 'L', expected_quantity: 18, counted_quantity: 12, difference: -6 }],
  total_difference: -6, ...overrides,
});
const catalogBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  page: 1, page_size: 25, total_variants: 1,
  items: [{ variant_id: 4, catalog_entry_id: 1, brand: 'TOYO', model: 'NS40ZL', capacity_ah: '35', polarity: 'L' }],
  ...overrides,
});

describe('adjustment creation transport', () => {
  it.each([[201, false], [200, true]])('posts the blind payload with the session CSRF header (%s)', async (status, replayed) => {
    const fetch = mockFetch().mockResolvedValue(json(recordBody(), status));
    const result = await createStockAdjustmentAPI(fetch).create(draft(), csrf);
    expect(result.replayed).toBe(replayed);
    expect(result.record).toMatchObject({ id: 7, location_id: 1, total_difference: -15 });
    expect(fetch.mock.calls[0]).toEqual(['/api/stock-adjustments', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: undefined,
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: '{"operation_key":"warehouse_adjustment_key_01","reason":"Conteo físico periódico","lines":[{"variant_id":4,"counted_quantity":0},{"variant_id":9,"counted_quantity":12}]}',
    }]);
    // The wire payload never carries an expected quantity or a difference.
    const body = String(fetch.mock.calls[0][1]?.body);
    expect(body).not.toMatch(/expected_quantity|difference|stock/);
  });

  it('captures the exact payload before awaiting and sends the abort signal', async () => {
    let resolve!: (value: Response) => void;
    const fetch = mockFetch().mockReturnValue(new Promise<Response>(yes => { resolve = yes; }));
    const input = draft() as { operation_key: string; reason: string; lines: { variant_id: number; counted_quantity: number }[] };
    const controller = new AbortController();
    const job = createStockAdjustmentAPI(fetch).create(input, csrf, controller.signal);
    input.lines[0].counted_quantity = 500;
    input.reason = 'Otro';
    resolve(json(recordBody(), 201));
    await job;
    expect(fetch.mock.calls[0][1]?.signal).toBe(controller.signal);
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({
      operation_key: 'warehouse_adjustment_key_01', reason: motive,
      lines: [{ variant_id: 4, counted_quantity: 0 }, { variant_id: 9, counted_quantity: 12 }],
    });
  });

  it.each([
    [400, 'invalid_request'], [401, 'unauthenticated'], [403, 'forbidden'],
    [409, 'retry_conflict'], [409, 'insufficient_stock'], [503, 'service_unavailable'],
  ])('reports the admitted %s %s with its status', async (status, code) => {
    const fetch = mockFetch().mockResolvedValue(json(`{"error":"${code}"}`, status));
    const failure = await createStockAdjustmentAPI(fetch).create(draft(), csrf).catch(error => error);
    expect(failure).toBeInstanceOf(StockAdjustmentAPIError);
    expect(failure).toMatchObject({ code, status });
  });

  it.each([
    ['a text/html body', new Response(recordBody(), { status: 201, headers: { 'Content-Type': 'text/html' } })],
    ['a reply with another counted quantity', json(recordBody({ lines: [{ variant_id: 4, expected_quantity: 18, counted_quantity: 1, difference: -17 }, { variant_id: 9, expected_quantity: 9, counted_quantity: 12, difference: 3 }], total_difference: -14 }), 201)],
    ['a reply with another motive', json(recordBody({ reason: 'Otro' }), 201)],
    ['a reply that is a counter-entry', json(recordBody({ reverses_adjustment_id: 3 }), 201)],
    ['a reply outside the warehouse', json(recordBody({ location_id: 2 }), 201)],
    ['an unadmitted success status', json(recordBody(), 202)],
    ['an uninterpretable error code', json('{"error":"decision_conflict"}', 409)],
  ])('refuses to interpret %s', async (_, reply) => {
    const fetch = mockFetch().mockResolvedValue(reply);
    await expect(createStockAdjustmentAPI(fetch).create(draft(), csrf)).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('distinguishes a lost connection from an aborted attempt', async () => {
    const network = mockFetch().mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(createStockAdjustmentAPI(network).create(draft(), csrf)).rejects.toMatchObject({ code: 'network', status: null });
    const controller = new AbortController();
    controller.abort();
    const aborted = mockFetch().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await expect(createStockAdjustmentAPI(aborted).create(draft(), csrf, controller.signal))
      .rejects.toMatchObject({ code: 'aborted', status: null });
  });

  it.each([
    ['an invalid draft', { operation_key: 'short', reason: motive, lines: [{ variant_id: 4, counted_quantity: 1 }] } as StockAdjustmentInput, csrf],
    ['a missing CSRF token', draft(), ''],
    ['a CSRF token with forbidden characters', draft(), 'not a token'],
  ])('fails closed on %s without any network call', async (_, input, token) => {
    const fetch = mockFetch();
    await expect(createStockAdjustmentAPI(fetch).create(input, token))
      .rejects.toMatchObject({ code: 'invalid_request', status: null });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('adjustment history transport', () => {
  it('reads one page with the session cookie and no CSRF header', async () => {
    const fetch = mockFetch().mockResolvedValue(json(historyBody()));
    const page = await createStockAdjustmentAPI(fetch).history(1, 25);
    expect(page).toMatchObject({ page: 1, page_size: 25, total_adjustments: 1 });
    expect(fetch.mock.calls[0]).toEqual(['/api/stock-adjustments?page=1&page_size=25', {
      method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: undefined,
    }]);
  });

  it('rejects a page that echoes another query than the one requested', async () => {
    const fetch = mockFetch().mockResolvedValue(json(historyBody({ page: 2 })));
    await expect(createStockAdjustmentAPI(fetch).history(1, 25)).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it.each([[400, 'invalid_request'], [401, 'unauthenticated'], [403, 'forbidden'], [503, 'service_unavailable']])(
    'reports the admitted %s %s', async (status, code) => {
      const fetch = mockFetch().mockResolvedValue(json(`{"error":"${code}"}`, status));
      await expect(createStockAdjustmentAPI(fetch).history(1, 25)).rejects.toMatchObject({ code, status });
    });

  it.each([[0, 25], [1, 15], [1000001, 25], [1.5, 25]])('fails closed on page %s size %s without any call', async (page, size) => {
    const fetch = mockFetch();
    await expect(createStockAdjustmentAPI(fetch).history(page, size)).rejects.toMatchObject({ code: 'invalid_request', status: null });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('adjustment detail transport', () => {
  it('reads one document with the session cookie', async () => {
    const fetch = mockFetch().mockResolvedValue(json(detailBody()));
    const detail = await createStockAdjustmentAPI(fetch).detail(6);
    expect(detail.lines[0]).toMatchObject({ variant_id: 7, expected_quantity: 18, counted_quantity: 12, difference: -6 });
    expect(fetch.mock.calls[0]).toEqual(['/api/stock-adjustments/6', {
      method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: undefined,
    }]);
  });

  it('refuses a reply for another document', async () => {
    const fetch = mockFetch().mockResolvedValue(json(detailBody({ id: 7 })));
    await expect(createStockAdjustmentAPI(fetch).detail(6)).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it.each([[400, 'invalid_request'], [401, 'unauthenticated'], [403, 'forbidden'], [404, 'not_found'], [503, 'service_unavailable']])(
    'reports the admitted %s %s', async (status, code) => {
      const fetch = mockFetch().mockResolvedValue(json(`{"error":"${code}"}`, status));
      await expect(createStockAdjustmentAPI(fetch).detail(6)).rejects.toMatchObject({ code, status });
    });

  it.each([0, -1, 1.5, Number.NaN])('fails closed on document id %s without any call', async id => {
    const fetch = mockFetch();
    await expect(createStockAdjustmentAPI(fetch).detail(id)).rejects.toMatchObject({ code: 'invalid_request', status: null });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('blind capture catalogue transport', () => {
  it('reads the quantity-free catalogue for the typed search', async () => {
    const fetch = mockFetch().mockImplementation(async () => json(catalogBody()));
    const page = await createStockAdjustmentAPI(fetch).catalog('');
    expect(page.items[0]).toEqual({ variant_id: 4, catalog_entry_id: 1, brand: 'TOYO', model: 'NS40ZL',
      capacity_ah: '35', polarity: 'L' });
    expect(fetch.mock.calls[0][0]).toBe('/api/stock-adjustments/catalog?page=1&page_size=25');
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store' });
    await createStockAdjustmentAPI(fetch).catalog('NS40ZL');
    expect(fetch.mock.calls[1][0]).toBe('/api/stock-adjustments/catalog?page=1&page_size=25&search=NS40ZL');
  });

  it.each([
    ['a catalogue that leaked a stock figure', json(catalogBody({ items: [{ ...JSON.parse(String(catalogBody())).items[0], existing: 14 }] }))],
    ['a catalogue for another page', json(catalogBody({ page: 2 }))],
    ['a catalogue with another page size', json(catalogBody({ page_size: 50 }))],
    ['an uninterpretable error code', json('{"error":"not_found"}', 404)],
  ])('refuses %s', async (_, reply) => {
    const fetch = mockFetch().mockResolvedValue(reply);
    await expect(createStockAdjustmentAPI(fetch).catalog('')).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it.each([[400, 'invalid_request'], [401, 'unauthenticated'], [403, 'forbidden'], [503, 'service_unavailable']])(
    'reports the admitted %s %s', async (status, code) => {
      const fetch = mockFetch().mockResolvedValue(json(`{"error":"${code}"}`, status));
      await expect(createStockAdjustmentAPI(fetch).catalog('')).rejects.toMatchObject({ code, status });
    });

  it('fails closed on an inadmissible search without any call', async () => {
    const fetch = mockFetch();
    await expect(createStockAdjustmentAPI(fetch).catalog('x'.repeat(129)))
      .rejects.toMatchObject({ code: 'invalid_request', status: null });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('counter-entry transport', () => {
  const reversal = { operation_key: 'warehouse_reversal_key_01', reason: motive };

  it.each([[201, false], [200, true]])('posts only the key and the reason to the frozen path (%s)', async (status, replayed) => {
    const fetch = mockFetch().mockResolvedValue(json(counterBody(), status));
    const result = await createStockAdjustmentAPI(fetch).reverse(listed(), reversal, csrf);
    expect(result.replayed).toBe(replayed);
    expect(result.record).toMatchObject({ id: 9, reverses_adjustment_id: 6, total_difference: 15 });
    expect(fetch.mock.calls[0]).toEqual(['/api/stock-adjustments/6/reverse', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: undefined,
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: '{"operation_key":"warehouse_reversal_key_01","reason":"Conteo físico periódico"}',
    }]);
  });

  it.each([
    ['a document that already has a counter-entry', listed({ reversed_by: 9 })],
    ['a counter-entry', listed({ reverses_adjustment_id: 3 })],
  ])('refuses to send a reversal of %s', async (_, row) => {
    const fetch = mockFetch();
    await expect(createStockAdjustmentAPI(fetch).reverse(row, reversal, csrf))
      .rejects.toMatchObject({ code: 'invalid_request', status: null });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['a blank reason', { operation_key: 'warehouse_reversal_key_01', reason: '  ' }, listed(), csrf],
    ['an invalid target', reversal, listed({ id: 0 }), csrf],
    ['a missing CSRF token', reversal, listed(), ''],
  ])('fails closed on %s without any call', async (_, input, row, token) => {
    const fetch = mockFetch();
    await expect(createStockAdjustmentAPI(fetch).reverse(row, input, token))
      .rejects.toMatchObject({ code: 'invalid_request', status: null });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([[400, 'invalid_request'], [401, 'unauthenticated'], [403, 'forbidden'], [404, 'not_found'],
    [409, 'decision_conflict'], [409, 'retry_conflict'], [409, 'insufficient_stock'], [503, 'service_unavailable']])(
  'reports the admitted %s %s', async (status, code) => {
    const fetch = mockFetch().mockResolvedValue(json(`{"error":"${code}"}`, status));
    await expect(createStockAdjustmentAPI(fetch).reverse(listed(), reversal, csrf)).rejects.toMatchObject({ code, status });
  });

  it.each([
    ['a counter-entry of another document', json(counterBody({ reverses_adjustment_id: 5 }), 201)],
    ['a counter-entry with another motive', json(counterBody({ reason: 'Otro' }), 201)],
    ['a counter-entry with a detail', json(counterBody({ detail: 'x' }), 201)],
    ['a counter-entry that does not mirror the total', json(counterBody({ total_difference: 14,
      lines: [{ variant_id: 4, expected_quantity: 0, counted_quantity: 18, difference: 18 },
        { variant_id: 9, expected_quantity: 12, counted_quantity: 8, difference: -4 }] }), 201)],
    ['a counter-entry with another line count', json(counterBody({ lines: [{ variant_id: 4, expected_quantity: 0, counted_quantity: 18, difference: 18 }], total_difference: 18 }), 201)],
    ['an unadmitted success status', json(counterBody(), 202)],
  ])('refuses to interpret %s', async (_, reply) => {
    const fetch = mockFetch().mockResolvedValue(reply);
    await expect(createStockAdjustmentAPI(fetch).reverse(listed(), reversal, csrf))
      .rejects.toMatchObject({ code: 'invalid_response' });
  });
});
