import { describe, expect, it, vi } from 'vitest';
import { CatalogBatteriesAPIError, createCatalogBatteriesAPI } from './catalogBatteriesAPI';

const csrf = 'c'.repeat(43);
const json = (body: string, status = 200, type = 'application/json') =>
  new Response(body, { status, headers: { 'Content-Type': type } });
const record = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  id: 96, brand: 'TOYO', model: 'NS40ZL', capacity_ah: '45',
  variants: [{ id: 191, polarity: 'L' }, { id: 192, polarity: 'R' }], priced_branches: 0, ...overrides,
});
const price = (branch: number) => ({
  branch_location_id: branch, min_price: '85000.00', suggested_price: '96000.00',
  updated_at: '2026-11-04T10:00:00Z', updated_by_account_id: 1, updated_by_display_name: 'Almacén',
});
const matrix = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  branches: [{ id: 2, name: 'Sucursal A' }],
  batteries: [{ catalog_entry_id: 96, brand: 'TOYO', model: 'NS40ZL', capacity_ah: '45',
    polarities: ['L', 'R'], cells: [], prices: [price(2)] }, { catalog_entry_id: 97, brand: 'CAR', model: 'NS60',
    capacity_ah: '60', polarities: ['R'], cells: [], prices: [], ...overrides }],
  page: 1, page_size: 10, total_batteries: 97,
});
const query = { search: '', brand: '', capacity: '', page: 1, page_size: 10 };

function harness(reply: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init = {}) => {
    calls.push({ url: String(input), init });
    return reply(String(input), init);
  });
  return { fetcher, calls, api: createCatalogBatteriesAPI(fetcher) };
}

const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try { await promise; } catch (failure) {
    if (failure instanceof CatalogBatteriesAPIError) return failure.code;
    return 'unexpected: ' + String(failure);
  }
  return 'resolved';
};

describe('the battery listing read', () => {
  it('reads the matrix path and derives the unsellable state of every row', async () => {
    const h = harness(() => json(matrix()));
    const page = await h.api.list(query);
    expect(h.calls[0].url).toBe('/api/catalog/prices?page=1&page_size=10');
    expect(h.calls[0].init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store' });
    expect(page.rows.map(row => [row.id, row.priced_branches]))
      .toEqual([[96, 1], [97, 0]]);
  });

  it('never sends an inadmissible query', async () => {
    const h = harness(() => json(matrix()));
    expect(await codeOf(h.api.list({ ...query, page: 0 }))).toBe('invalid_request');
    expect(await codeOf(h.api.list({ ...query, page_size: 7 }))).toBe('invalid_request');
    expect(h.calls).toHaveLength(0);
  });

  it.each([
    ['a row that grew a field', matrix({ priced_branches: 0 })],
    ['a duplicated key', '{"branches":[],"branches":[{"id":2,"name":"Sucursal A"}],"batteries":[],"page":1,"page_size":10,"total_batteries":0}'],
    ['a page that does not answer the query', JSON.stringify({ branches: [], batteries: [], page: 2, page_size: 10, total_batteries: 0 })],
  ])('refuses %s as evidence about the catalogue', async (_name, body) => {
    const h = harness(() => json(body));
    expect(await codeOf(h.api.list(query))).toBe('invalid_response');
  });

  it('refuses a non-JSON page and maps the authority refusals', async () => {
    const h = harness(url => url.startsWith('/api/catalog/prices?')
      ? json(matrix(), 200, 'text/html') : json('{"error":"forbidden"}', 403));
    expect(await codeOf(h.api.list(query))).toBe('invalid_response');
    const forbidden = harness(() => json('{"error":"forbidden"}', 403));
    expect(await codeOf(forbidden.api.list(query))).toBe('forbidden');
    const unauthenticated = harness(() => json('{"error":"unauthenticated"}', 401));
    expect(await codeOf(unauthenticated.api.list(query))).toBe('unauthenticated');
    const unavailable = harness(() => json('{"error":"service_unavailable"}', 503));
    expect(await codeOf(unavailable.api.list(query))).toBe('service_unavailable');
  });

  it('keeps a transport failure and an aborted read apart', async () => {
    const network = harness(() => { throw new Error('offline'); });
    expect(await codeOf(network.api.list(query))).toBe('network');
    const aborted = harness(() => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); });
    const controller = new AbortController();
    expect(await codeOf(aborted.api.list(query, controller.signal))).toBe('aborted');
    controller.abort();
    expect(await codeOf(aborted.api.list(query, controller.signal))).toBe('aborted');
  });
});

describe('creating one battery', () => {
  it('writes once with the exact canonical payload and returns the allocated record', async () => {
    // The server persists the canonical capacity this client sent.
    const h = harness(() => json(record({ capacity_ah: '45.5' }), 201));
    const created = await h.api.create({ brand: 'TOYO', model: 'NS40ZL', capacity_ah: '045.50', polarities: ['R', 'L'] }, csrf);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].url).toBe('/api/catalog/batteries');
    expect(h.calls[0].init).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf } });
    expect(JSON.parse(String(h.calls[0].init.body))).toEqual({
      brand: 'TOYO', model: 'NS40ZL', capacity_ah: '45.5', polarities: ['L', 'R'],
    });
    expect(created.id).toBe(96);
    expect(created.variants.map(variant => variant.id)).toEqual([191, 192]);
    expect(created.priced_branches).toBe(0);
  });

  it('never sends an inadmissible draft or a missing token', async () => {
    const h = harness(() => json(record(), 201));
    expect(await codeOf(h.api.create({ brand: 'TOYO', model: 'NS40ZL', capacity_ah: '45', polarities: [] }, csrf)))
      .toBe('invalid_request');
    expect(await codeOf(h.api.create({ brand: 'TOYO', model: 'NS40ZL', capacity_ah: '45', polarities: ['L'] }, '')))
      .toBe('invalid_request');
    expect(h.calls).toHaveLength(0);
  });

  it.each([
    ['conflict', '{"error":"conflict"}', 409],
    ['invalid_request', '{"error":"invalid_request"}', 400],
    ['forbidden', '{"error":"forbidden"}', 403],
    ['unauthenticated', '{"error":"unauthenticated"}', 401],
    ['service_unavailable', '{"error":"service_unavailable"}', 503],
  ])('reports %s from the server as its own code', async (code, body, status) => {
    const h = harness(() => json(body, status));
    expect(await codeOf(h.api.create({ brand: 'TOYO', model: 'NS40ZL', capacity_ah: '45', polarities: ['L'] }, csrf)))
      .toBe(code);
  });

  it('refuses a record that does not repeat the write or is not a 201', async () => {
    const mismatched = harness(() => json(record({ brand: 'OTRA' }), 201));
    expect(await codeOf(mismatched.api.create({ brand: 'TOYO', model: 'NS40ZL', capacity_ah: '45', polarities: ['L', 'R'] }, csrf)))
      .toBe('invalid_response');
    const wrongStatus = harness(() => json(record(), 200));
    expect(await codeOf(wrongStatus.api.create({ brand: 'TOYO', model: 'NS40ZL', capacity_ah: '45', polarities: ['L'] }, csrf)))
      .toBe('invalid_response');
    const offContract = harness(() => json(record({ cells: [] }), 201));
    expect(await codeOf(offContract.api.create({ brand: 'TOYO', model: 'NS40ZL', capacity_ah: '45', polarities: ['L'] }, csrf)))
      .toBe('invalid_response');
  });
});

describe('editing one battery', () => {
  it('sends the complete identity and nothing else, then returns the persisted record', async () => {
    const h = harness(() => json(record({ capacity_ah: '45.5', priced_branches: 2 })));
    const edited = await h.api.edit(96, { brand: 'TOYO', model: 'NS40ZL', capacity_ah: '45.5' }, csrf);
    expect(h.calls[0].url).toBe('/api/catalog/batteries/96');
    expect(h.calls[0].init).toMatchObject({ method: 'PATCH', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf } });
    expect(Object.keys(JSON.parse(String(h.calls[0].init.body))).sort()).toEqual(['brand', 'capacity_ah', 'model']);
    expect(JSON.parse(String(h.calls[0].init.body))).toEqual({ brand: 'TOYO', model: 'NS40ZL', capacity_ah: '45.5' });
    expect(edited.capacity_ah).toBe('45.5');
    expect(edited.priced_branches).toBe(2);
  });

  it('refuses an impossible identity or an unknown battery before sending nothing valid', async () => {
    const h = harness(() => json(record()));
    expect(await codeOf(h.api.edit(0, { brand: 'TOYO', model: 'NS40ZL', capacity_ah: '45' }, csrf))).toBe('invalid_request');
    expect(await codeOf(h.api.edit(96, { brand: 'TOYO', model: '', capacity_ah: '45' }, csrf))).toBe('invalid_request');
    expect(h.calls).toHaveLength(0);
  });

  it('reports a retired battery and a repeated identity as the server words them', async () => {
    const gone = harness(() => json('{"error":"not_found"}', 404));
    expect(await codeOf(gone.api.edit(96, { brand: 'TOYO', model: 'NS40ZL', capacity_ah: '45' }, csrf))).toBe('not_found');
    const duplicate = harness(() => json('{"error":"conflict"}', 409));
    expect(await codeOf(duplicate.api.edit(96, { brand: 'TOYO', model: 'NS40ZL', capacity_ah: '45' }, csrf))).toBe('conflict');
  });

  it('refuses a record that does not repeat the identity that was written', async () => {
    const h = harness(() => json(record({ model: 'OTRO' })));
    expect(await codeOf(h.api.edit(96, { brand: 'TOYO', model: 'NS40ZL', capacity_ah: '45' }, csrf))).toBe('invalid_response');
  });
});

describe('archiving one battery', () => {
  it('sends one DELETE and admits only the empty 204', async () => {
    const h = harness(() => new Response(null, { status: 204 }));
    await expect(h.api.archive(96, csrf)).resolves.toBeUndefined();
    expect(h.calls[0].url).toBe('/api/catalog/batteries/96');
    expect(h.calls[0].init).toMatchObject({ method: 'DELETE', credentials: 'same-origin', cache: 'no-store',
      headers: { 'X-CSRF-Token': csrf } });
    expect(h.calls[0].init.body).toBeUndefined();
  });

  it.each([
    ['catalog_battery_has_stock', 409],
    ['catalog_battery_has_pending', 409],
    ['conflict', 409],
    ['not_found', 404],
    ['invalid_request', 400],
    ['forbidden', 403],
    ['unauthenticated', 401],
    ['service_unavailable', 503],
  ])('reports %s as its own refusal', async (code, status) => {
    const h = harness(() => json(JSON.stringify({ error: code }), status));
    expect(await codeOf(h.api.archive(96, csrf))).toBe(code);
  });

  it('treats a 200 as an off-contract answer instead of a retirement', async () => {
    const h = harness(() => json(record(), 200));
    expect(await codeOf(h.api.archive(96, csrf))).toBe('invalid_response');
    const missing = harness(() => new Response(null, { status: 204 }));
    expect(await codeOf(missing.api.archive(0, csrf))).toBe('invalid_request');
    expect(missing.calls).toHaveLength(0);
  });
});
