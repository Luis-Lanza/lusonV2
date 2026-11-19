import { describe, expect, it, vi } from 'vitest';
import { createStockEntryAPI, StockEntryAPIError, StockEntryDetailAPIError, StockEntryReversalAPIError,
  StockEntrySupplierAPIError } from './stockEntryAPI';
import type { StockEntryInput } from './stockEntryModel';

const csrf = 'c'.repeat(43);
const supplier = { id: 3, name: 'Proveedor del norte' };
const draft = (): StockEntryInput => ({
  operation_key: 'warehouse_key_0001', supplier_id: 3, note: 'Remito 0002',
  lines: [{ variant_id: 9, quantity: 1 }, { variant_id: 4, quantity: 2 }],
});
const recordBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  id: 7, location_id: 1, note: 'Remito 0002', created_by_account_id: 1, created_at: '2026-05-01T14:20:00Z',
  supplier, lines: [{ variant_id: 4, quantity: 2 }, { variant_id: 9, quantity: 1 }], total_units: 3, ...overrides,
});
const json = (body: string, status = 201) => new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
const mockFetch = () => vi.fn<typeof fetch>();
const historyRow = (overrides: Record<string, unknown> = {}) => ({
  id: 7, note: 'Remito 0002', created_at: '2026-05-01T14:20:00Z', supplier: null,
  lines: 2, total_units: 18, reversed_by: null, ...overrides });
const historyBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  page: 1, page_size: 25, total_entries: 1, entries: [historyRow()], ...overrides });
const historyResponse = (body = historyBody()) => json(body, 200);

describe('stock entry API transport', () => {
  it.each([[201, false], [200, true]])('posts the canonical payload with the session CSRF header (%s)', async (status, replayed) => {
    const fetch = mockFetch().mockResolvedValue(json(recordBody(), status));
    const result = await createStockEntryAPI(fetch).create(draft(), csrf);
    expect(result.replayed).toBe(replayed);
    expect(result.record).toMatchObject({ id: 7, location_id: 1, total_units: 3, note: 'Remito 0002', supplier });
    expect(fetch.mock.calls[0]).toEqual(['/api/stock-entries', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: undefined,
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: '{"operation_key":"warehouse_key_0001","supplier_id":3,"note":"Remito 0002","lines":[{"variant_id":4,"quantity":2},{"variant_id":9,"quantity":1}]}',
    }]);
  });

  it('captures the exact payload before awaiting, so later mutations cannot change it', async () => {
    let resolve!: (value: Response) => void;
    const fetch = mockFetch().mockReturnValue(new Promise<Response>(yes => { resolve = yes; }));
    // Deliberately mutable copy: the API must not read it again after the first await.
    const input = draft() as { operation_key: string; supplier_id: number; note?: string;
      lines: { variant_id: number; quantity: number }[] };
    const job = createStockEntryAPI(fetch).create(input, csrf);
    input.lines[0].quantity = 500;
    input.note = 'mutated';
    input.operation_key = 'warehouse_key_9999';
    input.supplier_id = 99;
    resolve(json(recordBody()));
    await job;
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({
      operation_key: 'warehouse_key_0001', supplier_id: 3, note: 'Remito 0002',
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
    ['a record of another supplier', json(recordBody({ supplier: { id: 4, name: 'Baterías Sur' } })), 'invalid_response'],
    ['a record without a supplier', json(recordBody({ supplier: null })), 'invalid_response'],
    ['an unadmitted success status', json(recordBody(), 202), 'invalid_response'],
  ])('rejects %s', async (_, reply, code) => {
    const fetch = mockFetch().mockResolvedValue(reply);
    await expect(createStockEntryAPI(fetch).create(draft(), csrf)).rejects.toMatchObject({ name: 'StockEntryAPIError', code });
  });

  it.each([
    [400, 'invalid_request'], [403, 'forbidden'], [409, 'retry_conflict'], [409, 'decision_conflict'],
    [409, 'insufficient_stock'], [503, 'service_unavailable'],
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
    ['an invalid draft', { operation_key: 'short', supplier_id: 3, lines: [{ variant_id: 4, quantity: 1 }] } as StockEntryInput, csrf],
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
      supplier: null, lines: 2, total_units: 18, reversed_by: null });
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

describe('stock counter-entry transport', () => {
  const listed = (overrides: Record<string, unknown> = {}) => ({
    id: 7, note: 'Remito 0002', created_at: '2026-05-01T14:20:00Z', supplier,
    lines: 2, total_units: 18, reversed_by: null, ...overrides });
  const reversal = { operation_key: 'warehouse_reverse_01', reason: ' error de carga ' };
  const counterBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({
    id: 9, location_id: 1, note: '', created_by_account_id: 1, created_at: '2026-05-01T14:21:00Z',
    supplier, lines: [{ variant_id: 1, quantity: -4 }, { variant_id: 2, quantity: -14 }], total_units: -18, ...overrides,
  });
  const counterResponse = (body = counterBody(), status = 201) => json(body, status);

  it.each([[201, false], [200, true]])('posts the canonical reason to the frozen path (%s)', async (status, replayed) => {
    const fetch = mockFetch().mockResolvedValue(counterResponse(counterBody(), status));
    const result = await createStockEntryAPI(fetch).reverse(listed(), reversal, csrf);
    expect(result.replayed).toBe(replayed);
    expect(result.record).toMatchObject({ id: 9, note: '', total_units: -18 });
    expect(fetch.mock.calls[0]).toEqual(['/api/stock-entries/7/reverse', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: undefined,
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: '{"operation_key":"warehouse_reverse_01","reason":"error de carga"}',
    }]);
  });

  it('captures the exact payload before awaiting and sends the abort signal it was given', async () => {
    let resolve!: (value: Response) => void;
    const fetch = mockFetch().mockReturnValue(new Promise<Response>(yes => { resolve = yes; }));
    const input = { operation_key: 'warehouse_reverse_01', reason: 'error de carga' };
    const controller = new AbortController();
    const job = createStockEntryAPI(fetch).reverse(listed(), input, csrf, controller.signal);
    input.reason = 'mutado';
    resolve(counterResponse());
    await job;
    expect(fetch.mock.calls[0][1]?.signal).toBe(controller.signal);
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({
      operation_key: 'warehouse_reverse_01', reason: 'error de carga' });
  });

  it.each([
    ['a document that already has a counter-entry', listed({ reversed_by: 9 })],
    ['a counter-entry', listed({ total_units: -18 })],
  ])('refuses to send a reversal of %s', async (_, row) => {
    const fetch = mockFetch();
    await expect(createStockEntryAPI(fetch).reverse(row, reversal, csrf)).rejects.toMatchObject({ code: 'invalid_request', status: null });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['an empty reason', { operation_key: 'warehouse_reverse_01', reason: '  ' }],
    ['an invalid target', { operation_key: 'warehouse_reverse_01', reason: 'error de carga' }, { ...listed(), id: 0 }],
    ['a missing CSRF token', { operation_key: 'warehouse_reverse_01', reason: 'error de carga' }, listed(), ''],
  ])('fails closed on %s without any network call', async (_, input, row = listed(), token = csrf) => {
    const fetch = mockFetch();
    await expect(createStockEntryAPI(fetch).reverse(row, input, token))
      .rejects.toMatchObject({ code: 'invalid_request', status: null });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [400, 'invalid_request'], [401, 'unauthenticated'], [403, 'forbidden'], [404, 'not_found'],
    [409, 'decision_conflict'], [409, 'retry_conflict'], [409, 'insufficient_stock'], [503, 'service_unavailable'],
  ])('reports the admitted %s %s code with its status', async (status, code) => {
    const fetch = mockFetch().mockResolvedValue(json(`{"error":"${code}"}`, status));
    const failure = await createStockEntryAPI(fetch).reverse(listed(), reversal, csrf).catch(error => error);
    expect(failure).toBeInstanceOf(StockEntryReversalAPIError);
    expect(failure).toMatchObject({ code, status });
  });

  it.each([
    ['a text/html body', new Response(counterBody(), { status: 201, headers: { 'Content-Type': 'text/html' } })],
    ['an unparseable record', json('not json')],
    ['a record that is not the negation', counterResponse(counterBody({ total_units: -17 }))],
    ['a record with another line count', counterResponse(counterBody({ lines: [{ variant_id: 1, quantity: -18 }] }))],
    ['a positive record', counterResponse(counterBody({ lines: [{ variant_id: 1, quantity: 4 }, { variant_id: 2, quantity: -22 }], total_units: -18 }))],
    ['a record with a note', counterResponse(counterBody({ note: 'Remito 0002' }))],
    ['a record outside the warehouse', counterResponse(counterBody({ location_id: 2 }))],
    ['an unadmitted success status', counterResponse(counterBody(), 202)],
    ['an error envelope with extra keys', json('{"error":"forbidden","detail":"x"}', 403)],
    ['an unlisted failure status', json('{"error":"invalid_request"}', 500)],
  ])('refuses to interpret %s', async (_, reply) => {
    const fetch = mockFetch().mockResolvedValue(reply);
    await expect(createStockEntryAPI(fetch).reverse(listed(), reversal, csrf))
      .rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('distinguishes a lost connection from an aborted attempt', async () => {
    const network = mockFetch().mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(createStockEntryAPI(network).reverse(listed(), reversal, csrf))
      .rejects.toMatchObject({ code: 'network', status: null });
    const controller = new AbortController();
    controller.abort();
    const aborted = mockFetch().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await expect(createStockEntryAPI(aborted).reverse(listed(), reversal, csrf, controller.signal))
      .rejects.toMatchObject({ code: 'aborted', status: null });
  });
});

describe('stock document detail transport', () => {
  const detailLine = (overrides: Record<string, unknown> = {}) => ({
    variant_id: 7, kind: 'battery', name: 'TOYO · NS60L', detail: '45 Ah · L',
    battery: { brand: 'TOYO', model: 'NS60L', capacity_ah: '45', polarity: 'L' }, fields: null,
    quantity: 18, ...overrides });
  const productLine = (overrides: Record<string, unknown> = {}) => ({
    variant_id: 210, kind: 'other', name: 'Agua acidulada', detail: 'volumen en L: 5 L', battery: null,
    fields: [{ name: 'volumen en L', kind: 'number', unit: 'L', number: '5' }], quantity: 20, ...overrides });
  const detailBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({
    id: 6, location_id: 1, note: 'Remito 0002-00045871', created_at: '2026-05-01T14:20:00Z',
    created_by_account_id: 1, reverses_entry_id: null, reversed_by: null, reason: '',
    supplier, lines: [detailLine()], total_units: 18, ...overrides,
  });
  const detailResponse = (body = detailBody(), status = 200) => json(body, status);

  it('reads one document with the session cookie and no CSRF header', async () => {
    const fetch = mockFetch().mockResolvedValue(detailResponse());
    const detail = await createStockEntryAPI(fetch).detail(6);
    expect(detail).toMatchObject({ id: 6, note: 'Remito 0002-00045871', total_units: 18,
      reverses_entry_id: null, reversed_by: null, reason: '', supplier });
    expect(detail.lines).toEqual([{ variant_id: 7, kind: 'battery', name: 'TOYO · NS60L', detail: '45 Ah · L',
      battery: { brand: 'TOYO', model: 'NS60L', capacity_ah: '45', polarity: 'L' }, fields: null, quantity: 18 }]);
    expect(fetch.mock.calls[0]).toEqual(['/api/stock-entries/6', {
      method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: undefined,
    }]);
  });

  it('reads a product document with the identity union of its lines', async () => {
    const fetch = mockFetch().mockResolvedValue(detailResponse(detailBody({ lines: [productLine()], total_units: 20 })));
    const detail = await createStockEntryAPI(fetch).detail(6);
    expect(detail.lines).toEqual([{ variant_id: 210, kind: 'other', name: 'Agua acidulada',
      detail: 'volumen en L: 5 L', battery: null,
      fields: [{ name: 'volumen en L', kind: 'number', unit: 'L', number: '5' }], quantity: 20 }]);
  });

  it('sends the abort signal it was given', async () => {
    const fetch = mockFetch().mockResolvedValue(detailResponse());
    const controller = new AbortController();
    await createStockEntryAPI(fetch).detail(6, controller.signal);
    expect(fetch.mock.calls[0][1]?.signal).toBe(controller.signal);
  });

  it.each([[0], [-1], [1.5], [Number.NaN], [Number.MAX_SAFE_INTEGER + 1]])(
    'fails closed on document id %s without any network call', async id => {
      const fetch = mockFetch();
      await expect(createStockEntryAPI(fetch).detail(id)).rejects.toMatchObject({ code: 'invalid_request', status: null });
      expect(fetch).not.toHaveBeenCalled();
    });

  it.each([
    ['a text/html body', new Response(detailBody(), { status: 200, headers: { 'Content-Type': 'text/html' } })],
    ['an unparseable detail', json('not json', 200)],
    ['a detail of another document', detailResponse(detailBody({ id: 7 }))],
    ['a detail with a foreign field', detailResponse(detailBody({ operation_key: 'warehouse_key_0001' }))],
    ['a detail of another location', detailResponse(detailBody({ location_id: 2 }))],
    ['an unadmitted success status', detailResponse(detailBody(), 201)],
    ['an error envelope with extra keys', json('{"error":"forbidden","detail":"x"}', 403)],
    ['an unlisted failure status', json('{"error":"not_found"}', 409)],
  ])('refuses to interpret %s', async (_, reply) => {
    const fetch = mockFetch().mockResolvedValue(reply);
    await expect(createStockEntryAPI(fetch).detail(6)).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it.each([[400, 'invalid_request'], [401, 'unauthenticated'], [403, 'forbidden'], [404, 'not_found'], [503, 'service_unavailable']])(
    'reports the admitted %s %s code with its status', async (status, code) => {
      const fetch = mockFetch().mockResolvedValue(json(`{"error":"${code}"}`, status));
      const failure = await createStockEntryAPI(fetch).detail(6).catch(error => error);
      expect(failure).toBeInstanceOf(StockEntryDetailAPIError);
      expect(failure).toMatchObject({ code, status });
    });

  it('distinguishes a lost connection from an aborted read', async () => {
    const network = mockFetch().mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(createStockEntryAPI(network).detail(6)).rejects.toMatchObject({ code: 'network', status: null });
    const controller = new AbortController();
    controller.abort();
    const aborted = mockFetch().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await expect(createStockEntryAPI(aborted).detail(6, controller.signal)).rejects.toMatchObject({ code: 'aborted', status: null });
  });
});

describe('supplier read transport', () => {
  const supplierChoice = (overrides: Record<string, unknown> = {}) => ({
    id: 3, name: 'Proveedor del norte', contact: '', retired: false,
    kinds: ['battery', 'other'], offers: 4, ...overrides });
  const supplierListBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({
    suppliers: [supplierChoice()], page: 1, page_size: 50, total_suppliers: 1, ...overrides });
  const catalogueBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({
    items: [{ variant_id: 4, catalog_entry_id: 2, kind: 'battery', name: 'TOYO · NS40ZL', detail: '35 Ah · L',
      battery: { brand: 'TOYO', model: 'NS40ZL', capacity_ah: '35', polarity: 'L' }, fields: null }],
    page_size: 50, ...overrides });

  it('reads one page of suppliers with the session cookie and no CSRF header', async () => {
    const fetch = mockFetch().mockResolvedValue(json(supplierListBody(), 200));
    const page = await createStockEntryAPI(fetch).suppliers(1, 50);
    expect(page.suppliers).toEqual([{ id: 3, name: 'Proveedor del norte', contact: '', retired: false,
      kinds: ['battery', 'other'], offers: 4 }]);
    expect(fetch.mock.calls[0]).toEqual(['/api/suppliers?page=1&page_size=50', {
      method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: undefined,
    }]);
  });

  it('reads the catalogue of exactly one supplier with its kind and search', async () => {
    const fetch = mockFetch().mockResolvedValue(json(catalogueBody(), 200));
    const items = await createStockEntryAPI(fetch).supplierCatalog(3, 'battery', 'NS40');
    expect(items[0]).toMatchObject({ variant_id: 4, catalog_entry_id: 2, kind: 'battery' });
    expect(fetch.mock.calls[0]).toEqual(['/api/suppliers/3/catalog?kind=battery&search=NS40', {
      method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: undefined,
    }]);
  });

  it('sends the abort signal it was given to both reads', async () => {
    const fetch = mockFetch().mockResolvedValue(json(supplierListBody(), 200));
    const controller = new AbortController();
    await createStockEntryAPI(fetch).suppliers(1, 50, controller.signal);
    expect(fetch.mock.calls[0][1]?.signal).toBe(controller.signal);
    const catalogue = mockFetch().mockResolvedValue(json(catalogueBody(), 200));
    await createStockEntryAPI(catalogue).supplierCatalog(3, 'battery', '', controller.signal);
    expect(catalogue.mock.calls[0][1]?.signal).toBe(controller.signal);
  });

  it.each([
    ['a text/html body', new Response(supplierListBody(), { status: 200, headers: { 'Content-Type': 'text/html' } })],
    ['an unparseable page', json('not json', 200)],
    ['a page with a foreign supplier field', json(supplierListBody({ suppliers: [supplierChoice({ offers_list: [] })] }), 200)],
    ['a page outside the request', json(supplierListBody({ page: 2 }), 200)],
    ['an unadmitted success status', json(supplierListBody(), 201)],
  ])('refuses to interpret %s of the supplier list', async (_, reply) => {
    const fetch = mockFetch().mockResolvedValue(reply);
    await expect(createStockEntryAPI(fetch).suppliers(1, 50))
      .rejects.toMatchObject({ name: 'StockEntrySupplierAPIError', code: 'invalid_response' });
  });

  it.each([
    ['a text/html body', new Response(catalogueBody(), { status: 200, headers: { 'Content-Type': 'text/html' } })],
    ['an unparseable catalogue', json('not json', 200)],
    ['a catalogue with stock numbers', json(catalogueBody({ items: [{ variant_id: 4, catalog_entry_id: 2, kind: 'battery',
      name: 'TOYO · NS40ZL', detail: '35 Ah · L', battery: { brand: 'TOYO', model: 'NS40ZL', capacity_ah: '35', polarity: 'L' },
      fields: null, existing: 14 }] }), 200)],
    ['a catalogue of the other kind', json(catalogueBody({ items: [{ variant_id: 210, catalog_entry_id: 97, kind: 'other',
      name: 'Agua acidulada', detail: 'volumen en L: 5 L', battery: null, fields: [] }] }), 200)],
    ['an unadmitted success status', json(catalogueBody(), 201)],
  ])('refuses to interpret %s of a supplier catalogue', async (_, reply) => {
    const fetch = mockFetch().mockResolvedValue(reply);
    await expect(createStockEntryAPI(fetch).supplierCatalog(3, 'battery', ''))
      .rejects.toMatchObject({ name: 'StockEntrySupplierAPIError', code: 'invalid_response' });
  });

  it.each([[400, 'invalid_request'], [401, 'unauthenticated'], [403, 'forbidden'], [503, 'service_unavailable']])(
    'reports the admitted supplier read %s %s code with its status', async (status, code) => {
      const fetch = mockFetch().mockResolvedValue(json(`{"error":"${code}"}`, status));
      const failure = await createStockEntryAPI(fetch).suppliers(1, 50).catch(error => error);
      expect(failure).toBeInstanceOf(StockEntrySupplierAPIError);
      expect(failure).toMatchObject({ code, status });
    });

  it('distinguishes a lost connection from an aborted supplier read', async () => {
    const network = mockFetch().mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(createStockEntryAPI(network).suppliers(1, 50)).rejects.toMatchObject({ code: 'network', status: null });
    const controller = new AbortController();
    controller.abort();
    const aborted = mockFetch().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await expect(createStockEntryAPI(aborted).supplierCatalog(3, 'battery', '', controller.signal))
      .rejects.toMatchObject({ code: 'aborted', status: null });
  });

  it.each([[0, 50], [1, 0], [1, 51], [1.5, 50]])('fails closed on page %s size %s without any network call',
    async (page, size) => {
      const fetch = mockFetch();
      await expect(createStockEntryAPI(fetch).suppliers(page, size))
        .rejects.toMatchObject({ code: 'invalid_request', status: null });
      expect(fetch).not.toHaveBeenCalled();
    });

  it.each([[0], [-1], [3.5], [Number.NaN]])('fails closed on supplier %s without any network call', async id => {
    const fetch = mockFetch();
    await expect(createStockEntryAPI(fetch).supplierCatalog(id, 'battery', ''))
      .rejects.toMatchObject({ code: 'invalid_request', status: null });
    expect(fetch).not.toHaveBeenCalled();
  });
});
