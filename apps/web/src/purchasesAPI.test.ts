import { describe, expect, it, vi } from 'vitest';
import {
  PurchaseAPIError, createPurchaseAPI, parsePurchaseDocument, parsePurchaseError, parsePurchaseLastPrices,
  parsePurchaseMaterials, parsePurchaseModels, parsePurchasePage, parsePurchaseReceived, purchaseAdmittedErrors,
  purchaseDetailPath, purchaseErrorMessages, purchaseFailureIsDefinite, purchaseHistoryPath, purchaseReversePath,
  type PurchaseHistoryRow,
} from './purchasesAPI';
import type { PurchaseInput, PurchaseReversalInput } from './purchaseModel';

const csrf = 'c'.repeat(43);
const key = 'purchase_key_0001';
const input = (patch: Partial<PurchaseInput> = {}): PurchaseInput => ({
  operation_key: key,
  note: 'Remito 0002',
  used_lines: [{ model: 'NS60ZL', quantity: 1, unit_price: '25000.00' }],
  scrap_lines: [{ material_id: 1, kg: '12.400', price_per_kg: '8000.00' }],
  paid_cash: '124200.00',
  paid_transfer: '0.00',
  ...patch,
});
const documentBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  id: 7, location_id: 2, note: 'Remito 0002', total: '124200.00', paid_cash: '124200.00',
  paid_transfer: '0.00', created_by_account_id: 3, created_at: '2026-11-11T18:20:00Z',
  reverses_purchase_id: null, reversed_by: null, reason: '',
  used_lines: [{ model: 'NS60ZL', quantity: 1, unit_price: '25000.00', amount: '25000.00' }],
  scrap_lines: [{ material_id: 1, name: 'Cobre', kg: '12.400', price_per_kg: '8000.00', amount: '99200.00' }],
  ...overrides,
});
const reversalBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  id: 8, location_id: 2, note: '', total: '-124200.00', paid_cash: '-124200.00',
  paid_transfer: '0.00', created_by_account_id: 3, created_at: '2026-11-12T09:00:00Z',
  reverses_purchase_id: 7, reversed_by: null, reason: 'pesaje mal tipeado',
  used_lines: [{ model: 'NS60ZL', quantity: -1, unit_price: '25000.00', amount: '-25000.00' }],
  scrap_lines: [{ material_id: 1, name: 'Cobre', kg: '-12.400', price_per_kg: '8000.00', amount: '-99200.00' }],
  ...overrides,
});
const json = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
const mockFetch = () => vi.fn<typeof fetch>();
const historyRow = (overrides: Record<string, unknown> = {}) => ({
  id: 7, created_at: '2026-11-11T18:20:00Z', total: '124200.00',
  reverses_purchase_id: null, reversed_by: null, used_units: 1, scrap_lines: 1, ...overrides,
});
const historyBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  page: 1, page_size: 25, total_purchases: 1, purchases: [historyRow()], ...overrides,
});
const reversalInput: PurchaseReversalInput = { operation_key: 'reverse_key_00001', reason: 'pesaje mal tipeado' };
const row = (overrides: Partial<PurchaseHistoryRow> = {}): PurchaseHistoryRow => ({
  id: 7, created_at: '2026-11-11T18:20:00Z', total_cents: 12_420_000n,
  reverses_purchase_id: null, reversed_by: null, used_units: 1, scrap_lines: 1, ...overrides,
});

describe('purchase document decoding', () => {
  it('reads money and weight as integer units, never a float', () => {
    const document = parsePurchaseDocument(documentBody());
    expect(document).toMatchObject({
      id: 7, location_id: 2, note: 'Remito 0002', total_cents: 12_420_000n,
      paid_cash_cents: 12_420_000n, paid_transfer_cents: 0n,
      created_by_account_id: 3, created_at: '2026-11-11T18:20:00Z',
      reverses_purchase_id: null, reversed_by: null, reason: '',
    });
    expect(document.used_lines[0]).toEqual({
      model: 'NS60ZL', quantity: 1, unit_price_cents: 2_500_000n, amount_cents: 2_500_000n,
    });
    expect(document.scrap_lines[0]).toEqual({
      material_id: 1, name: 'Cobre', kg_milli: 12_400n, price_per_kg_cents: 800_000n, amount_cents: 9_920_000n,
    });
    expect(Object.isFrozen(document)).toBe(true);
  });

  it('reads a counter-document with negative quantities, weights and amounts', () => {
    const document = parsePurchaseDocument(reversalBody());
    expect(document.total_cents).toBe(-12_420_000n);
    expect(document.used_lines[0].quantity).toBe(-1);
    expect(document.scrap_lines[0].kg_milli).toBe(-12_400n);
    expect(document.reverses_purchase_id).toBe(7);
    expect(document.reason).toBe('pesaje mal tipeado');
  });

  it.each([
    ['an extra field', documentBody({ extra: 1 })],
    ['a missing field', JSON.stringify({ id: 7, location_id: 2 })],
    ['a duplicated key', '{"id":7,"id":8,"location_id":2,"note":"","total":"1.00","paid_cash":"1.00","paid_transfer":"0.00","created_by_account_id":3,"created_at":"2026-11-11T18:20:00Z","reverses_purchase_id":null,"reversed_by":null,"reason":"","used_lines":[],"scrap_lines":[]}'],
    ['a warehouse location', documentBody({ location_id: 1 })],
    ['a total that does not add up', documentBody({ total: '1.00' })],
    ['a settlement that does not close', documentBody({ paid_transfer: '1.00' })],
    ['a line amount that is not quantity times price', documentBody({
      used_lines: [{ model: 'NS60ZL', quantity: 2, unit_price: '25000.00', amount: '25000.00' }] })],
    ['a scrap amount that is not rounded half up', documentBody({
      scrap_lines: [{ material_id: 1, name: 'Cobre', kg: '12.400', price_per_kg: '8000.00', amount: '99200.01' }] })],
    ['a non canonical weight', documentBody({
      scrap_lines: [{ material_id: 1, name: 'Cobre', kg: '12.4', price_per_kg: '8000.00', amount: '99200.00' }] })],
    ['unordered used lines', documentBody({
      used_lines: [{ model: 'ZZ99', quantity: 1, unit_price: '1.00', amount: '1.00' },
        { model: 'AA11', quantity: 1, unit_price: '1.00', amount: '1.00' }], total: '99202.00',
      paid_cash: '99202.00' })],
    ['unordered scrap lines', documentBody({
      scrap_lines: [{ material_id: 2, name: 'Aluminio', kg: '1.000', price_per_kg: '1.00', amount: '1.00' },
        { material_id: 1, name: 'Cobre', kg: '1.000', price_per_kg: '1.00', amount: '1.00' }],
      used_lines: [], total: '2.00', paid_cash: '2.00' })],
    ['a document with no line', documentBody({ used_lines: [], scrap_lines: [], total: '0.00', paid_cash: '0.00' })],
    ['a positive document that reverses another', documentBody({ reverses_purchase_id: 6 })],
    ['a counter-document without a reason', reversalBody({ reason: '' })],
    ['a counter-document with a positive line', reversalBody({
      used_lines: [{ model: 'NS60ZL', quantity: 1, unit_price: '25000.00', amount: '25000.00' }] })],
    ['an impossible date', documentBody({ created_at: '2026-02-31T00:00:00Z' })],
    ['a note with NUL', documentBody({ note: 'a\u0000b' })],
  ])('rejects %s', (_, raw) => {
    expect(() => parsePurchaseDocument(raw)).toThrow('Respuesta inválida del servidor.');
  });
});

describe('purchase reads', () => {
  it('parses one newest-first history page', () => {
    const page = parsePurchasePage(historyBody());
    expect(page).toEqual({ page: 1, page_size: 25, total_purchases: 1, purchases: [{
      id: 7, created_at: '2026-11-11T18:20:00Z', total_cents: 12_420_000n,
      reverses_purchase_id: null, reversed_by: null, used_units: 1, scrap_lines: 1,
    }] });
  });

  it.each([
    ['a wrong page size', historyBody({ page_size: 15 })],
    ['rows beyond the total', historyBody({ total_purchases: 1, purchases: [historyRow(), historyRow({ id: 6 })] })],
    ['a row without any line', historyBody({ purchases: [historyRow({ used_units: 0, scrap_lines: 0 })] })],
    ['a positive row that reverses another', historyBody({ purchases: [historyRow({ reverses_purchase_id: 6 })] })],
    ['a counter row with a positive total', historyBody({ purchases: [historyRow({ reverses_purchase_id: 6 })] })],
    ['rows out of newest-first order', historyBody({ total_purchases: 2,
      purchases: [historyRow({ id: 6 }), historyRow({ id: 7 })] })],
  ])('rejects %s', (_, raw) => {
    expect(() => parsePurchasePage(raw)).toThrow('Respuesta inválida del servidor.');
  });

  it('parses the model list, the materials and the last prices', () => {
    expect(parsePurchaseModels('{"models":["12N5-3B","NS60ZL"]}')).toEqual(['12N5-3B', 'NS60ZL']);
    expect(parsePurchaseMaterials('{"materials":[{"id":1,"name":"Cobre"},{"id":2,"name":"Aluminio"}]}'))
      .toEqual([{ id: 1, name: 'Cobre' }, { id: 2, name: 'Aluminio' }]);
    const last = parsePurchaseLastPrices(JSON.stringify({
      models: [{ model: 'NS60ZL', unit_price: '25000.00', purchased_at: '2026-11-10T14:02:00Z' }],
      materials: [{ material_id: 1, price_per_kg: '8000.00', purchased_at: '2026-11-10T14:02:00Z' }],
    }));
    expect(last.models[0]).toEqual({ model: 'NS60ZL', unit_price_cents: 2_500_000n,
      purchased_at: '2026-11-10T14:02:00Z' });
    expect(last.materials[0]).toEqual({ material_id: 1, price_per_kg_cents: 800_000n,
      purchased_at: '2026-11-10T14:02:00Z' });
  });

  it.each([
    ['a repeated model', '{"models":["NS60ZL","NS60ZL"]}'],
    ['a lower-case model', '{"models":["ns60zl"]}'],
    ['a non ascending model list', '{"models":["NS60ZL","AA11"]}'],
  ])('rejects the model list with %s', (_, raw) => {
    expect(() => parsePurchaseModels(raw)).toThrow('Respuesta inválida del servidor.');
  });

  it('parses the received totals with their valuation', () => {
    const received = parsePurchaseReceived(JSON.stringify({
      used: [{ model: 'NS60ZL', quantity: 12, value: '300000.00' }],
      scrap: [{ material_id: 1, name: 'Cobre', kg: '120.500', value: '964000.00' }],
    }));
    expect(received.used[0]).toEqual({ model: 'NS60ZL', quantity: 12, value_cents: 30_000_000n });
    expect(received.scrap[0]).toEqual({ material_id: 1, name: 'Cobre', kg_milli: 120_500n, value_cents: 96_400_000n });
  });

  it.each([
    ['a zero net quantity', JSON.stringify({ used: [{ model: 'NS60ZL', quantity: 0, value: '0.00' }], scrap: [] })],
    ['a negative net value', JSON.stringify({ used: [{ model: 'NS60ZL', quantity: 1, value: '-1.00' }], scrap: [] })],
    ['unordered scrap rows', JSON.stringify({ used: [],
      scrap: [{ material_id: 2, name: 'Aluminio', kg: '1.000', value: '1.00' },
        { material_id: 1, name: 'Cobre', kg: '1.000', value: '1.00' }] })],
  ])('rejects the received totals with %s', (_, raw) => {
    expect(() => parsePurchaseReceived(raw)).toThrow('Respuesta inválida del servidor.');
  });
});

describe('purchase error envelopes', () => {
  it('admits only the exact code for each status', () => {
    expect(parsePurchaseError('{"error":"invalid_request"}', 400)).toBe('invalid_request');
    expect(parsePurchaseError('{"error":"forbidden"}', 403)).toBe('forbidden');
    expect(parsePurchaseError('{"error":"not_found"}', 404)).toBe('not_found');
    expect(parsePurchaseError('{"error":"retry_conflict"}', 409)).toBe('retry_conflict');
    expect(parsePurchaseError('{"error":"already_reversed"}', 409)).toBe('already_reversed');
    expect(parsePurchaseError('{"error":"service_unavailable"}', 503)).toBe('service_unavailable');
  });

  it.each([
    ['a known code on the wrong status', '{"error":"retry_conflict"}', 400],
    ['an unknown code', '{"error":"conflict"}', 409],
    ['an unlisted status', '{"error":"invalid_request"}', 500],
    ['an envelope with more than one key', '{"error":"forbidden","detail":"x"}', 403],
    ['a non JSON body', '<html>proxy</html>', 503],
  ])('rejects %s', (_, raw, status) => {
    expect(() => parsePurchaseError(raw, status)).toThrow('Respuesta inválida del servidor.');
  });

  it('maps every admitted code to Spanish and classifies only proven rejections as definite', () => {
    for (const codes of purchaseAdmittedErrors.values()) {
      for (const code of codes) expect(purchaseErrorMessages[code]).toMatch(/[áéíóúñ]/i);
    }
    for (const code of ['invalid_request', 'forbidden', 'not_found', 'retry_conflict', 'already_reversed'] as const) {
      expect(purchaseFailureIsDefinite(code)).toBe(true);
    }
    for (const code of ['service_unavailable', 'invalid_response', 'network', 'aborted'] as const) {
      expect(purchaseFailureIsDefinite(code)).toBe(false);
    }
  });
});

describe('purchase API transport', () => {
  it('posts the canonical payload with the session CSRF header', async () => {
    const fetch = mockFetch().mockResolvedValue(json(documentBody({ total: '124201.00', paid_cash: '124201.00',
      used_lines: [{ model: 'NS60ZL', quantity: 1, unit_price: '25000.00', amount: '25000.00' },
        { model: 'ZZ99', quantity: 1, unit_price: '1.00', amount: '1.00' }] }), 201));
    const document = await createPurchaseAPI(fetch).create(input({
      used_lines: [{ model: 'ZZ99', quantity: 1, unit_price: '1.00' }, { model: 'NS60ZL', quantity: 1, unit_price: '25000.00' }],
      paid_cash: '124201.00',
    }), csrf);
    expect(document.id).toBe(7);
    expect(fetch.mock.calls[0][0]).toBe('/api/purchases');
    expect(fetch.mock.calls[0][1]).toMatchObject({
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    });
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual(input({
      used_lines: [{ model: 'NS60ZL', quantity: 1, unit_price: '25000.00' },
        { model: 'ZZ99', quantity: 1, unit_price: '1.00' }],
      paid_cash: '124201.00',
    }));
  });

  it('captures the exact payload before awaiting', async () => {
    let resolve!: (value: Response) => void;
    const fetch = mockFetch().mockReturnValue(new Promise<Response>(yes => { resolve = yes; }));
    const mutable = input() as unknown as {
      note: string;
      used_lines: { model: string; quantity: number; unit_price: string }[];
    };
    const job = createPurchaseAPI(fetch).create(mutable as unknown as PurchaseInput, csrf);
    mutable.note = 'mutated';
    mutable.used_lines[0].quantity = 500;
    resolve(json(documentBody(), 201));
    await job;
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body)).note).toBe('Remito 0002');
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body)).used_lines[0].quantity).toBe(1);
  });

  it('reads one history page with the frozen path', async () => {
    const fetch = mockFetch().mockResolvedValue(json(historyBody(), 200));
    const page = await createPurchaseAPI(fetch).history(1, 25);
    expect(fetch.mock.calls[0]).toEqual([purchaseHistoryPath(1, 25), {
      method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: undefined,
    }]);
    expect(page.total_purchases).toBe(1);
  });

  it('reads a detail, the model list, the materials, the last prices and the received totals', async () => {
    const fetch = mockFetch()
      .mockResolvedValueOnce(json(documentBody(), 200))
      .mockResolvedValueOnce(json('{"models":["NS60ZL"]}', 200))
      .mockResolvedValueOnce(json('{"materials":[{"id":1,"name":"Cobre"}]}', 200))
      .mockResolvedValueOnce(json('{"models":[],"materials":[]}', 200))
      .mockResolvedValueOnce(json('{"used":[],"scrap":[]}', 200));
    const api = createPurchaseAPI(fetch);
    expect((await api.detail(7)).id).toBe(7);
    expect(await api.models()).toEqual(['NS60ZL']);
    expect(await api.materials()).toEqual([{ id: 1, name: 'Cobre' }]);
    expect(await api.lastPrices()).toEqual({ models: [], materials: [] });
    expect(await api.received()).toEqual({ used: [], scrap: [] });
    expect(fetch.mock.calls.map(call => call[0])).toEqual([
      purchaseDetailPath(7), '/api/purchases/models', '/api/purchases/materials',
      '/api/purchases/last-prices', '/api/purchases/received',
    ]);
  });

  it('posts a mandated reversal to the target path and verifies the mirror', async () => {
    const fetch = mockFetch().mockResolvedValue(json(reversalBody(), 201));
    const document = await createPurchaseAPI(fetch).reverse(row(), reversalInput, csrf);
    expect(document.id).toBe(8);
    expect(fetch.mock.calls[0][0]).toBe(purchaseReversePath(7));
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual(reversalInput);
  });

  it.each([
    ['a missing reversal reason', (fetch: typeof globalThis.fetch) => createPurchaseAPI(fetch).reverse(row(),
      { operation_key: 'reverse_key_00001', reason: '   ' }, csrf)],
    ['a non reversible target', (fetch: typeof globalThis.fetch) => createPurchaseAPI(fetch).reverse(row({ reversed_by: 8 }),
      reversalInput, csrf)],
    ['a missing CSRF token', (fetch: typeof globalThis.fetch) => createPurchaseAPI(fetch).create(input(), '')],
  ])('fails closed on %s without any network call', async (_, run) => {
    const fetch = mockFetch();
    await expect(run(fetch)).rejects.toMatchObject({ code: 'invalid_request', status: null });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a text/html body, an unparseable one and an unadmitted status', async () => {
    const html = new Response(documentBody(), { status: 201, headers: { 'Content-Type': 'text/html' } });
    await expect(createPurchaseAPI(mockFetch().mockResolvedValue(html)).create(input(), csrf))
      .rejects.toMatchObject({ name: 'PurchaseAPIError', code: 'invalid_response' });
    await expect(createPurchaseAPI(mockFetch().mockResolvedValue(json('not json', 201))).create(input(), csrf))
      .rejects.toMatchObject({ code: 'invalid_response' });
    await expect(createPurchaseAPI(mockFetch().mockResolvedValue(json(documentBody(), 200))).create(input(), csrf))
      .rejects.toMatchObject({ code: 'invalid_response' });
    const mismatched = documentBody({ total: '1.00', paid_cash: '1.00' });
    await expect(createPurchaseAPI(mockFetch().mockResolvedValue(json(mismatched, 201))).create(input(), csrf))
      .rejects.toMatchObject({ code: 'invalid_response' });
    await expect(createPurchaseAPI(mockFetch().mockResolvedValue(json(reversalBody(), 200))).reverse(row(), reversalInput, csrf))
      .rejects.toMatchObject({ code: 'invalid_response' });
    const foreignMirror = reversalBody({ reason: 'otro motivo' });
    await expect(createPurchaseAPI(mockFetch().mockResolvedValue(json(foreignMirror, 201))).reverse(row(), reversalInput, csrf))
      .rejects.toMatchObject({ code: 'invalid_response' });
  });

  it.each([
    [400, 'invalid_request'], [403, 'forbidden'], [404, 'not_found'],
    [409, 'retry_conflict'], [409, 'already_reversed'], [503, 'service_unavailable'],
  ])('reports the admitted %s %s code with its status', async (status, code) => {
    const fetch = mockFetch().mockResolvedValue(json(`{"error":"${code}"}`, status));
    const failure = await createPurchaseAPI(fetch).create(input(), csrf).catch(error => error);
    expect(failure).toBeInstanceOf(PurchaseAPIError);
    expect(failure).toMatchObject({ code, status });
  });

  it('distinguishes a lost connection from an aborted attempt', async () => {
    const network = mockFetch().mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(createPurchaseAPI(network).models()).rejects.toMatchObject({ code: 'network', status: null });
    const controller = new AbortController();
    controller.abort();
    const aborted = mockFetch().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await expect(createPurchaseAPI(aborted).models(controller.signal)).rejects.toMatchObject({ code: 'aborted', status: null });
  });

  it.each([[0, 25], [1, 15], [1_000_001, 25], [1.5, 25], [1, 100]])(
    'fails closed on page %s size %s without any network call', async (page, size) => {
      const fetch = mockFetch();
      await expect(createPurchaseAPI(fetch).history(page, size)).rejects.toMatchObject({ code: 'invalid_request', status: null });
      expect(fetch).not.toHaveBeenCalled();
    });
});
