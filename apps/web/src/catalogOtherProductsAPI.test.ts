import { describe, expect, it, vi } from 'vitest';
import { CatalogOtherProductsAPIError, createCatalogOtherProductsAPI } from './catalogOtherProductsAPI';

const csrf = 'c'.repeat(43);
const json = (body: string, status = 200, type = 'application/json') =>
  new Response(body, { status, headers: { 'Content-Type': type } });
const record = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  id: 113, name: 'Agua acidulada',
  fields: [
    { name: 'volumen en L', kind: 'number', unit: 'L', number: '5' },
    { name: 'origen', kind: 'text', text: 'importado' },
  ], ...overrides,
});
const page = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  products: [JSON.parse(record())], page: 1, page_size: 10, total_products: 1, ...overrides,
});
const query = { search: '', page: 1, page_size: 10 };
const draft = {
  name: 'Agua acidulada',
  fields: [
    { name: 'volumen en L', kind: 'number', unit: 'L', number: '05', text: '' },
    { name: 'origen', kind: 'text', unit: '', number: '', text: 'importado' },
  ],
};
const editedDraft = {
  name: 'Agua acidulada',
  fields: [{ name: 'volumen en L', kind: 'number', unit: 'L', number: '6', text: '' }],
};

function harness(reply: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init = {}) => {
    calls.push({ url: String(input), init });
    return reply(String(input), init);
  });
  return { fetcher, calls, api: createCatalogOtherProductsAPI(fetcher) };
}
const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try { await promise; } catch (failure) {
    if (failure instanceof CatalogOtherProductsAPIError) return failure.code;
    return 'unexpected: ' + String(failure);
  }
  return 'resolved';
};

describe('the other products listing read', () => {
  it('reads the frozen path and decodes the page', async () => {
    const h = harness(() => json(page()));
    const parsed = await h.api.list(query);
    expect(h.calls[0].url).toBe('/api/catalog/other-products?page=1&page_size=10');
    expect(h.calls[0].init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store' });
    expect(parsed.rows.map(row => [row.id, row.name])).toEqual([[113, 'Agua acidulada']]);
    expect(parsed.total_products).toBe(1);
  });

  it('never sends an inadmissible query', async () => {
    const h = harness(() => json(page()));
    expect(await codeOf(h.api.list({ ...query, page: 0 }))).toBe('invalid_request');
    expect(await codeOf(h.api.list({ ...query, page_size: 7 }))).toBe('invalid_request');
    expect(h.calls).toHaveLength(0);
  });

  it.each([
    ['a row that grew a field', page({ products: [{ ...JSON.parse(record()), priced: true }] })],
    ['a duplicated key', '{"products":[],"products":[{"id":113,"name":"Agua acidulada","fields":[]}],"page":1,"page_size":10,"total_products":1}'],
    ['a page that does not answer the query', page({ page: 2 })],
  ])('refuses %s as evidence about the catalogue', async (_name, body) => {
    const h = harness(() => json(body));
    expect(await codeOf(h.api.list(query))).toBe('invalid_response');
  });

  it('refuses a non-JSON page and maps the authority refusals', async () => {
    const html = harness(() => json(page(), 200, 'text/html'));
    expect(await codeOf(html.api.list(query))).toBe('invalid_response');
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

describe('creating one other product', () => {
  it('writes once with the exact canonical payload and returns the allocated record', async () => {
    const h = harness(() => json(record(), 201));
    const created = await h.api.create(draft, csrf);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].url).toBe('/api/catalog/other-products');
    expect(h.calls[0].init).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf } });
    expect(JSON.parse(String(h.calls[0].init.body))).toEqual({
      name: 'Agua acidulada',
      fields: [
        { name: 'volumen en L', kind: 'number', number: '5', unit: 'L' },
        { name: 'origen', kind: 'text', text: 'importado' },
      ],
    });
    expect(created.id).toBe(113);
  });

  it('never sends an inadmissible draft or a missing token', async () => {
    const h = harness(() => json(record(), 201));
    expect(await codeOf(h.api.create({ name: 'ab', fields: [] }, csrf))).toBe('invalid_request');
    expect(await codeOf(h.api.create(draft, ''))).toBe('invalid_request');
    expect(await codeOf(h.api.create(draft, 'not a token'))).toBe('invalid_request');
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
    expect(await codeOf(h.api.create(draft, csrf))).toBe(code);
  });

  it('refuses a record that does not repeat the write or is not a 201', async () => {
    const mismatched = harness(() => json(record({ name: 'Otra agua' }), 201));
    expect(await codeOf(mismatched.api.create(draft, csrf))).toBe('invalid_response');
    const lost = harness(() => json(record({ fields: [] }), 201));
    expect(await codeOf(lost.api.create(draft, csrf))).toBe('invalid_response');
    const wrongStatus = harness(() => json(record(), 200));
    expect(await codeOf(wrongStatus.api.create(draft, csrf))).toBe('invalid_response');
    const offContract = harness(() => json(record({ priced: true }), 201));
    expect(await codeOf(offContract.api.create(draft, csrf))).toBe('invalid_response');
  });
});

describe('editing one other product', () => {
  it('replaces the whole field set and returns the persisted record', async () => {
    const h = harness(() => json(record({ fields: [{ name: 'volumen en L', kind: 'number', unit: 'L', number: '6' }] })));
    const edited = await h.api.edit(113, editedDraft, csrf);
    expect(h.calls[0].url).toBe('/api/catalog/other-products/113');
    expect(h.calls[0].init).toMatchObject({ method: 'PATCH', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf } });
    expect(JSON.parse(String(h.calls[0].init.body))).toEqual({
      name: 'Agua acidulada',
      fields: [{ name: 'volumen en L', kind: 'number', unit: 'L', number: '6' }],
    });
    expect(edited.fields).toHaveLength(1);
  });

  it('refuses an impossible identity or an unknown product before sending', async () => {
    const h = harness(() => json(record()));
    expect(await codeOf(h.api.edit(0, editedDraft, csrf))).toBe('invalid_request');
    expect(await codeOf(h.api.edit(113, { name: '', fields: [] }, csrf))).toBe('invalid_request');
    expect(await codeOf(h.api.edit(113, editedDraft, ''))).toBe('invalid_request');
    expect(h.calls).toHaveLength(0);
  });

  it('reports a retired product and a repeated name as the server words them', async () => {
    const gone = harness(() => json('{"error":"not_found"}', 404));
    expect(await codeOf(gone.api.edit(113, editedDraft, csrf))).toBe('not_found');
    const duplicate = harness(() => json('{"error":"conflict"}', 409));
    expect(await codeOf(duplicate.api.edit(113, editedDraft, csrf))).toBe('conflict');
  });

  it('refuses a record that does not repeat the field set that was written', async () => {
    const h = harness(() => json(record({ fields: [{ name: 'volumen en L', kind: 'number', unit: 'L', number: '7' }] })));
    expect(await codeOf(h.api.edit(113, editedDraft, csrf))).toBe('invalid_response');
  });
});

describe('retiring one other product', () => {
  it('sends one DELETE and admits only the empty 204', async () => {
    const h = harness(() => new Response(null, { status: 204 }));
    await expect(h.api.archive(113, csrf)).resolves.toBeUndefined();
    expect(h.calls[0].url).toBe('/api/catalog/other-products/113');
    expect(h.calls[0].init).toMatchObject({ method: 'DELETE', credentials: 'same-origin', cache: 'no-store',
      headers: { 'X-CSRF-Token': csrf } });
    expect(h.calls[0].init.body).toBeUndefined();
  });

  it.each([
    ['catalog_product_has_stock', 409],
    ['catalog_product_has_pending', 409],
    ['conflict', 409],
    ['not_found', 404],
    ['invalid_request', 400],
    ['forbidden', 403],
    ['unauthenticated', 401],
    ['service_unavailable', 503],
  ])('reports %s as its own refusal', async (code, status) => {
    const h = harness(() => json(JSON.stringify({ error: code }), status));
    expect(await codeOf(h.api.archive(113, csrf))).toBe(code);
  });

  it('treats a 200 as an off-contract answer instead of a retirement', async () => {
    const h = harness(() => json(record(), 200));
    expect(await codeOf(h.api.archive(113, csrf))).toBe('invalid_response');
    const missing = harness(() => new Response(null, { status: 204 }));
    expect(await codeOf(missing.api.archive(0, csrf))).toBe('invalid_request');
    expect(missing.calls).toHaveLength(0);
  });
});
