import { describe, expect, it, vi } from 'vitest';
import { createSuppliersAPI, SuppliersAPIError } from './catalogSuppliersAPI';

const csrf = 'c'.repeat(43);
const json = (body: string, status = 200, type = 'application/json') =>
  new Response(body, { status, headers: { 'Content-Type': type } });
const batteryEntry = { catalog_entry_id: 7, kind: 'battery', brand: 'Willard', model: '12N24', capacity_ah: '12' };
const otherEntry = { catalog_entry_id: 9, kind: 'other', name: 'Agua acidulada' };
const row = (overrides: Record<string, unknown> = {}) => ({
  id: 3, name: 'Baterías del Sur', contact: 'Llamar al 4455-1122', retired: false,
  kinds: ['battery', 'other'], offers: 2, ...overrides,
});
const listBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  suppliers: [row()], page: 1, page_size: 10, total_suppliers: 1, ...overrides,
});
const detailBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  id: 3, name: 'Baterías del Sur', contact: 'Llamar al 4455-1122', retired: false,
  offers: [batteryEntry, otherEntry], kinds: ['battery', 'other'], ...overrides,
});
const catalogBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  entries: [batteryEntry, otherEntry], page_size: 10, total_entries: 2, ...overrides,
});
const recordBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  id: 11, name: 'Baterías del Sur', contact: 'Llamar al 4455-1122', ...overrides,
});
const query = { page: 1, page_size: 10 };
const catalogQuery = { kind: '' as const, search: '', page_size: 10 };

function harness(reply: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init = {}) => {
    calls.push({ url: String(input), init });
    return reply(String(input), init);
  });
  return { fetcher, calls, api: createSuppliersAPI(fetcher) };
}
const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try { await promise; } catch (failure) {
    if (failure instanceof SuppliersAPIError) return failure.code;
    return 'unexpected: ' + String(failure);
  }
  return 'resolved';
};

describe('the supplier listing read', () => {
  it('reads the frozen path and decodes the page', async () => {
    const h = harness(() => json(listBody()));
    const parsed = await h.api.list(query);
    expect(h.calls[0].url).toBe('/api/suppliers?page=1&page_size=10');
    expect(h.calls[0].init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store' });
    expect(parsed.rows.map(entry => [entry.id, entry.name, entry.offers])).toEqual([[3, 'Baterías del Sur', 2]]);
    expect(parsed.total_suppliers).toBe(1);
  });

  it('never sends an inadmissible query', async () => {
    const h = harness(() => json(listBody()));
    expect(await codeOf(h.api.list({ ...query, page: 0 }))).toBe('invalid_request');
    expect(await codeOf(h.api.list({ ...query, page_size: 7 }))).toBe('invalid_request');
    expect(h.calls).toHaveLength(0);
  });

  it.each([
    ['a row that grew a field', listBody({ suppliers: [{ ...row(), priced: true }] })],
    ['a duplicated key', '{"suppliers":[],"suppliers":[{"id":3,"name":"Baterías del Sur","contact":"","retired":false,"kinds":[],"offers":0}],"page":1,"page_size":10,"total_suppliers":0}'],
    ['a page that does not answer the query', listBody({ page: 2 })],
  ])('refuses %s as evidence about the suppliers', async (_name, body) => {
    const h = harness(() => json(body));
    expect(await codeOf(h.api.list(query))).toBe('invalid_response');
  });

  it('refuses a non-JSON page and maps the authority refusals', async () => {
    const html = harness(() => json(listBody(), 200, 'text/html'));
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

describe('one supplier with the entries it offers', () => {
  it('reads the supplier path and decodes the whole offer set', async () => {
    const h = harness(() => json(detailBody()));
    const parsed = await h.api.detail(3);
    expect(h.calls[0].url).toBe('/api/suppliers/3');
    expect(h.calls[0].init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store' });
    expect(parsed.offers.map(entry => entry.catalog_entry_id)).toEqual([7, 9]);
    expect(parsed.retired).toBe(false);
  });

  it('refuses an impossible identity before sending and maps a missing supplier', async () => {
    const h = harness(() => json(detailBody()));
    expect(await codeOf(h.api.detail(0))).toBe('invalid_request');
    expect(h.calls).toHaveLength(0);
    const gone = harness(() => json('{"error":"not_found"}', 404));
    expect(await codeOf(gone.api.detail(3))).toBe('not_found');
  });

  it('refuses a detail that does not repeat the contract shape', async () => {
    const h = harness(() => json(detailBody({ offers: [batteryEntry, batteryEntry] })));
    expect(await codeOf(h.api.detail(3))).toBe('invalid_response');
  });
});

describe('the assignable catalogue read', () => {
  it('reads the frozen path with the page size alone when the filters are empty', async () => {
    const h = harness(() => json(catalogBody()));
    const parsed = await h.api.catalog(catalogQuery);
    expect(h.calls[0].url).toBe('/api/suppliers/catalog?page_size=10');
    expect(parsed.entries.map(entry => entry.kind)).toEqual(['battery', 'other']);
    expect(parsed.total_entries).toBe(2);
  });

  it('sends the kind and the search the operator chose', async () => {
    const h = harness(() => json(catalogBody({ entries: [batteryEntry], page_size: 25, total_entries: 1 })));
    await h.api.catalog({ kind: 'battery', search: 'Willard 12N24', page_size: 25 });
    expect(h.calls[0].url).toBe('/api/suppliers/catalog?kind=battery&search=Willard+12N24&page_size=25');
  });

  it('never sends an inadmissible query and refuses an off-contract page', async () => {
    const h = harness(() => json(catalogBody()));
    expect(await codeOf(h.api.catalog({ ...catalogQuery, page_size: 7 }))).toBe('invalid_request');
    expect(await codeOf(h.api.catalog({ ...catalogQuery, kind: 'liquid' as never }))).toBe('invalid_request');
    expect(h.calls).toHaveLength(0);
    const wrong = harness(() => json(catalogBody({ page_size: 25 })));
    expect(await codeOf(wrong.api.catalog(catalogQuery))).toBe('invalid_response');
    const forbidden = harness(() => json('{"error":"forbidden"}', 403));
    expect(await codeOf(forbidden.api.catalog(catalogQuery))).toBe('forbidden');
  });
});

describe('creating one supplier', () => {
  it('writes once with the exact canonical payload and returns the allocated record', async () => {
    const h = harness(() => json(recordBody(), 201));
    const created = await h.api.create({ name: '  Baterías del Sur ', contact: 'Llamar al 4455-1122' }, csrf);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].url).toBe('/api/suppliers');
    expect(h.calls[0].init).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf } });
    expect(JSON.parse(String(h.calls[0].init.body))).toEqual({ name: 'Baterías del Sur', contact: 'Llamar al 4455-1122' });
    expect(created.id).toBe(11);
  });

  it('never sends an inadmissible draft or a missing token', async () => {
    const h = harness(() => json(recordBody(), 201));
    expect(await codeOf(h.api.create({ name: 'ab', contact: '' }, csrf))).toBe('invalid_request');
    expect(await codeOf(h.api.create({ name: 'Baterías del Sur', contact: 'a'.repeat(201) }, csrf))).toBe('invalid_request');
    expect(await codeOf(h.api.create({ name: 'Baterías del Sur', contact: '' }, ''))).toBe('invalid_request');
    expect(await codeOf(h.api.create({ name: 'Baterías del Sur', contact: '' }, 'not a token'))).toBe('invalid_request');
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
    expect(await codeOf(h.api.create({ name: 'Baterías del Sur', contact: '' }, csrf))).toBe(code);
  });

  it('refuses a record that does not repeat the write or is not a 201', async () => {
    const mismatched = harness(() => json(recordBody({ name: 'Otras baterías' }), 201));
    expect(await codeOf(mismatched.api.create({ name: 'Baterías del Sur', contact: 'Llamar al 4455-1122' }, csrf)))
      .toBe('invalid_response');
    const wrongStatus = harness(() => json(recordBody(), 200));
    expect(await codeOf(wrongStatus.api.create({ name: 'Baterías del Sur', contact: 'Llamar al 4455-1122' }, csrf)))
      .toBe('invalid_response');
    const offContract = harness(() => json(recordBody({ retired: false }), 201));
    expect(await codeOf(offContract.api.create({ name: 'Baterías del Sur', contact: 'Llamar al 4455-1122' }, csrf)))
      .toBe('invalid_response');
  });
});

describe('editing one supplier', () => {
  it('replaces the name and contact in place and returns the persisted record', async () => {
    const h = harness(() => json(recordBody({ name: 'Baterías del Norte', contact: 'Llamar al 4000-0000' })));
    const edited = await h.api.edit(3, { name: 'Baterías del Norte', contact: 'Llamar al 4000-0000' }, csrf);
    expect(h.calls[0].url).toBe('/api/suppliers/3');
    expect(h.calls[0].init).toMatchObject({ method: 'PATCH', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf } });
    expect(JSON.parse(String(h.calls[0].init.body))).toEqual({
      name: 'Baterías del Norte', contact: 'Llamar al 4000-0000',
    });
    expect(edited.name).toBe('Baterías del Norte');
  });

  it('refuses an impossible identity or an invalid draft before sending', async () => {
    const h = harness(() => json(recordBody()));
    expect(await codeOf(h.api.edit(0, { name: 'Baterías del Sur', contact: '' }, csrf))).toBe('invalid_request');
    expect(await codeOf(h.api.edit(3, { name: 'ab', contact: '' }, csrf))).toBe('invalid_request');
    expect(await codeOf(h.api.edit(3, { name: 'Baterías del Sur', contact: '' }, ''))).toBe('invalid_request');
    expect(h.calls).toHaveLength(0);
  });

  it('reports a missing supplier and a repeated name as the server words them', async () => {
    const gone = harness(() => json('{"error":"not_found"}', 404));
    expect(await codeOf(gone.api.edit(3, { name: 'Baterías del Sur', contact: '' }, csrf))).toBe('not_found');
    const duplicate = harness(() => json('{"error":"conflict"}', 409));
    expect(await codeOf(duplicate.api.edit(3, { name: 'Baterías del Sur', contact: '' }, csrf))).toBe('conflict');
  });

  it('refuses a record that does not repeat the supplier that was written', async () => {
    const h = harness(() => json(recordBody({ contact: 'Otro contacto' })));
    expect(await codeOf(h.api.edit(3, { name: 'Baterías del Sur', contact: 'Llamar al 4455-1122' }, csrf)))
      .toBe('invalid_response');
  });
});

describe('retiring one supplier', () => {
  it('sends one DELETE and admits only the empty 204', async () => {
    const h = harness(() => new Response(null, { status: 204 }));
    await expect(h.api.retire(3, csrf)).resolves.toBeUndefined();
    expect(h.calls[0].url).toBe('/api/suppliers/3');
    expect(h.calls[0].init).toMatchObject({ method: 'DELETE', credentials: 'same-origin', cache: 'no-store',
      headers: { 'X-CSRF-Token': csrf } });
    expect(h.calls[0].init.body).toBeUndefined();
  });

  it.each([
    ['conflict', 409], ['not_found', 404], ['invalid_request', 400],
    ['forbidden', 403], ['unauthenticated', 401], ['service_unavailable', 503],
  ])('reports %s as its own refusal', async (code, status) => {
    const h = harness(() => json(JSON.stringify({ error: code }), status));
    expect(await codeOf(h.api.retire(3, csrf))).toBe(code);
  });

  it('treats a 200 as an off-contract answer instead of a retirement', async () => {
    const h = harness(() => json(recordBody(), 200));
    expect(await codeOf(h.api.retire(3, csrf))).toBe('invalid_response');
    const missing = harness(() => new Response(null, { status: 204 }));
    expect(await codeOf(missing.api.retire(0, csrf))).toBe('invalid_request');
    expect(missing.calls).toHaveLength(0);
  });
});

describe('replacing the offers of one supplier', () => {
  it('sends the whole set once with the exact wire shape and admits the echoed detail', async () => {
    const h = harness(() => json(detailBody({ offers: [batteryEntry, otherEntry] })));
    const detail = await h.api.saveOffers(3, [9, 7, 9], csrf);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].url).toBe('/api/suppliers/3/offers');
    expect(h.calls[0].init).toMatchObject({ method: 'PUT', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf } });
    expect(JSON.parse(String(h.calls[0].init.body))).toEqual({ catalog_entry_ids: [7, 9] });
    expect(detail.offers).toHaveLength(2);
  });

  it('saves an empty set as the absence of products', async () => {
    const h = harness(() => json(detailBody({ offers: [], kinds: [] })));
    const detail = await h.api.saveOffers(3, [], csrf);
    expect(JSON.parse(String(h.calls[0].init.body))).toEqual({ catalog_entry_ids: [] });
    expect(detail.offers).toEqual([]);
  });

  it('refuses an impossible identity, an invalid set or a missing token before sending', async () => {
    const h = harness(() => json(detailBody()));
    expect(await codeOf(h.api.saveOffers(0, [7], csrf))).toBe('invalid_request');
    expect(await codeOf(h.api.saveOffers(3, [0], csrf))).toBe('invalid_request');
    expect(await codeOf(h.api.saveOffers(3, [7], ''))).toBe('invalid_request');
    expect(h.calls).toHaveLength(0);
  });

  it('reports a retired supplier and a refused entry as their own codes', async () => {
    const retired = harness(() => json('{"error":"conflict"}', 409));
    expect(await codeOf(retired.api.saveOffers(3, [7], csrf))).toBe('conflict');
    const refused = harness(() => json('{"error":"invalid_request"}', 400));
    expect(await codeOf(refused.api.saveOffers(3, [7], csrf))).toBe('invalid_request');
  });

  it('refuses a detail that repeats a different set than the one written', async () => {
    const h = harness(() => json(detailBody({ offers: [batteryEntry] })));
    expect(await codeOf(h.api.saveOffers(3, [7, 9], csrf))).toBe('invalid_response');
    const extra = harness(() => json(detailBody()));
    expect(await codeOf(extra.api.saveOffers(3, [], csrf))).toBe('invalid_response');
  });
});
