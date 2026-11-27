import { describe, expect, it, vi } from 'vitest';
import { filterSourceInventory, loadSourceInventory, SourceInventoryError } from './sourceInventory';

// Raw numeric wire tokens, not JSON.stringify(bigint) or rounded JS quantities.
function row(id: number, stock = '9223372036854775807', entry = Math.ceil(id / 2)): string {
  return `{"variant_id":${id},"catalog_entry_id":${entry},"kind":"battery","name":"TOYO · M+_%","detail":"6.000001 Ah · L","battery":{"brand":"TOYO","model":"M+_%","capacity_ah":"6.000001","polarity":"L"},"fields":null,"existing":${stock},"reserved":0,"available":${stock}}`;
}
function page(ids: number[], total = ids.length, current = 1, source = 1, name = 'Almacén'): string {
  return `{"location":{"id":${source},"name":"${name}"},"items":[${ids.map(id => row(id)).join(',')}],"page":${current},"page_size":50,"total_variants":${total}}`;
}
// The origin picker also reads the other-product catalogue, whose rows are not batteries.
function product(id: number): string {
  return `{"variant_id":${id},"catalog_entry_id":${id},"kind":"other","name":"Agua acidulada ${id}","detail":"5 L","battery":null,"fields":[{"name":"volumen en L","kind":"number","unit":"L","number":"5"}],"existing":4,"reserved":0,"available":4}`;
}
function productPage(ids: number[], total: number, current: number): string {
  return `{"location":{"id":1,"name":"Almacén"},"items":[${ids.map(product).join(',')}],"page":${current},"page_size":50,"total_variants":${total}}`;
}
const json = (raw: string, status = 200) => new Response(raw, { status, headers: { 'Content-Type': 'application/json' } });
const range = (first: number, count: number) => Array.from({ length: count }, (_, i) => first + i);
const replies = (...raws: string[]) => vi.fn<typeof fetch>().mockImplementation(async () => json(raws.shift()!));

describe('R04 source catalog', () => {
  it('loads all190 in four unfiltered pages and freezes exact copied rows', async () => {
    const fetcher = replies(page(range(1, 50), 190), page(range(51, 50), 190, 2), page(range(101, 50), 190, 3), page(range(151, 40), 190, 4));
    const catalog = await loadSourceInventory(1, {}, fetcher);
    expect(catalog.rows).toHaveLength(190);
    expect(catalog.rows[189]).toMatchObject({ variant_id: 190, catalog_entry_id: 95, available: 9223372036854775807n,
      battery: { brand: 'TOYO', model: 'M+_%', capacity_ah: '6.000001', polarity: 'L' } });
    expect(catalog.rows[0].existing).toBe(9223372036854775807n);
    for (const value of [catalog, catalog.location, catalog.rows, catalog.rows[0]]) expect(Object.isFrozen(value)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(4);
    fetcher.mock.calls.forEach(([url, init], i) => {
      expect(url).toBe(`/api/inventory?location_id=1&page=${i + 1}&page_size=50`);
      expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store' });
      expect(new Headers(init?.headers).has('X-Luson-Passive')).toBe(false);
      expect(init?.body).toBeUndefined();
    });
  });
  it.each([2, 3, 4, 32767] as const)('reads physical branch%s without actor/viewer query parameters', async source => {
    const fetcher = replies(page([1], 1, 1, source, 'Sucursal'));
    expect((await loadSourceInventory(source, {}, fetcher)).location.id).toBe(source);
    expect(fetcher.mock.calls[0][0]).toBe(`/api/inventory?location_id=${source}&page=1&page_size=50`);
  });
  it('supports smaller complete two-page catalogs, exact2^53 tokens and legitimate cross-page stock changes', async () => {
    const fetcher = replies(page(range(1, 50), 51).replaceAll('9223372036854775807', '9007199254740993'), page([51], 51, 2).replaceAll('9223372036854775807', '9'));
    const catalog = await loadSourceInventory(1, {}, fetcher);
    expect(catalog.rows[0].available).toBe(9007199254740993n);
    expect(catalog.rows[50].available).toBe(9n);
  });
  it('accepts sealed upper identifiers even in a one-row catalog', async () => {
    const catalog = await loadSourceInventory(1, {}, replies(page([190])));
    expect(catalog.rows[0]).toMatchObject({ variant_id: 190, catalog_entry_id: 95 });
  });
  it('loads allocated identities past the preloaded fixture', async () => {
    const fetcher = replies(
      page(range(1, 50), 191), page(range(51, 50), 191, 2), page(range(101, 50), 191, 3), page(range(151, 41), 191, 4));
    const catalog = await loadSourceInventory(1, {}, fetcher);
    expect(catalog.rows).toHaveLength(191);
    expect(catalog.rows[190]).toMatchObject({ variant_id: 191, catalog_entry_id: 96 });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  // The catalogue publishes 267 other-product and 540 battery variants, so the
  // reader cannot stop at a page count of its own: eleven pages must load whole.
  it('loads a complete catalog larger than four pages page by page', async () => {
    const pages = (total: number, last: number) => Array.from({ length: Math.ceil(total / 50) },
      (_, i) => page(range(i * 50 + 1, i === Math.ceil(total / 50) - 1 ? last : 50), total, i + 1));
    const fetcher = replies(...pages(540, 40));
    const catalog = await loadSourceInventory(1, {}, fetcher);
    expect(catalog.rows).toHaveLength(540);
    expect(catalog.rows[539]).toMatchObject({ variant_id: 540, catalog_entry_id: 270 });
    expect(fetcher).toHaveBeenCalledTimes(11);
    expect(fetcher.mock.calls[10][0]).toBe('/api/inventory?location_id=1&page=11&page_size=50');
  });
  // The absolute boundary of the same rule: 267 other products are five full pages
  // and a last one of seventeen.
  it('loads an odd-sized catalog whose last page is not full', async () => {
    const fetcher = replies(productPage(range(1, 50), 267, 1), productPage(range(51, 50), 267, 2),
      productPage(range(101, 50), 267, 3), productPage(range(151, 50), 267, 4),
      productPage(range(201, 50), 267, 5), productPage(range(251, 17), 267, 6));
    const catalog = await loadSourceInventory(1, { kind: 'other' }, fetcher);
    expect(catalog.rows).toHaveLength(267);
    expect(catalog.rows[266].variant_id).toBe(267);
    expect(fetcher).toHaveBeenCalledTimes(6);
  });
  it('accepts a consistent empty catalog without fabricated rows', async () => {
    const fetcher = replies(page([]));
    expect((await loadSourceInventory(1, {}, fetcher)).rows).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['variant0', page([0], 1)],
    ['count-type', page([1]).replace('"total_variants":1', '"total_variants":"1"')],
    ['size', page([1]).replace('"page_size":50', '"page_size":25')],
    ['page', page([1], 1, 2)],
    ['foreign-source', page([1], 1, 1, 2)],
    ['unknown-source', page([1], 1, 1, 4)],
    ['partial', page([1], 2)],
    ['empty-intermediate', page([], 51)],
    ['duplicate', page([1, 1], 2)],
    ['inconsistent-availability', page([1]).replace('"reserved":0', '"reserved":1')],
    ['fraction-quantity', page([1]).replaceAll('9223372036854775807', '1.5')],
    ['overflow-quantity', page([1]).replaceAll('9223372036854775807', '9223372036854775808')],
    ['broken-json', '{'],
  ])('rejects malformed %s without exposing wire content', async (_name, raw) => {
    await expect(loadSourceInventory(1, {}, replies(raw))).rejects.toMatchObject({ code: 'malformed', message: 'malformed', status: 200 });
  });
  it.each([
    ['changed-count', page([51], 52, 2)],
    ['duplicate-cross-page', page([50], 51, 2)],
    ['changed-name', page([51], 51, 2, 1, 'Other')],
    ['wrong-page', page([51], 51, 3)],
    ['wrong-source', page([51], 51, 2, 3)],
    ['empty-terminal', page([], 51, 2)],
  ])('rejects second-page %s with no partial result', async (_name, raw) => {
    await expect(loadSourceInventory(1, {}, replies(page(range(1, 50), 51), raw))).rejects.toBeInstanceOf(SourceInventoryError);
  });
  // A total the pages can never satisfy is still refused, and a published total no
  // branch could hold is refused after one page instead of asking forever.
  it('rejects a page that cannot complete the published total', async () => {
    const fetcher = replies(page(range(1, 50), 540), page(range(51, 50), 540, 2), page(range(101, 50), 540, 3),
      page(range(151, 50), 540, 4), page(range(201, 50), 540, 5), page(range(251, 50), 540, 6),
      page(range(301, 50), 540, 7), page(range(351, 50), 540, 8), page(range(401, 50), 540, 9),
      page(range(451, 50), 540, 10), page(range(501, 39), 540, 11));
    await expect(loadSourceInventory(1, {}, fetcher)).rejects.toMatchObject({ code: 'malformed', message: 'malformed', status: 200 });
  });
  it.each([1000000000, 1000000000000])('refuses an impossible published total %i after the first page', async total => {
    const fetcher = replies(page(range(1, 50), total));
    await expect(loadSourceInventory(1, {}, fetcher)).rejects.toMatchObject({ code: 'malformed', message: 'malformed', status: 200 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects reordered pages even when all returned IDs are unique', async () => {
    await expect(loadSourceInventory(1, {}, replies(page(range(2, 50), 51), page([1], 51, 2)))).rejects.toMatchObject({ code: 'malformed' });
  });
  it.each([401, 503])('sanitizes page-two HTTP%s including HTML without probes', async status => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(page(range(1, 50), 51)))
      .mockResolvedValueOnce(new Response('<html>private SQL detail</html>', { status }));
    await expect(loadSourceInventory(1, {}, fetcher)).rejects.toMatchObject({ code: status === 401 ? 'unauthenticated' : 'unavailable', status });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('sanitizes cross-realm transport cancellation without a session probe', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue({ name: 'AbortError', message: 'private' });
    await expect(loadSourceInventory(1, {}, fetcher)).rejects.toMatchObject({ code: 'canceled', message: 'canceled' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects successful HTML and sanitizes transport errors', async () => {
    await expect(loadSourceInventory(1, {}, vi.fn<typeof fetch>().mockResolvedValue(new Response('<html>private</html>')))).rejects.toMatchObject({ code: 'malformed' });
    await expect(loadSourceInventory(1, {}, vi.fn<typeof fetch>().mockRejectedValue(new Error('private')))).rejects.toMatchObject({ message: 'unavailable' });
  });
  it.each(['manual', 'passive'] as const)('captures %s reason and signal before page one awaits', async reason => {
    const options = { reason, signal: new AbortController().signal };
    const signal = options.signal;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      options.reason = reason === 'manual' ? 'passive' : 'manual';
      options.signal = new AbortController().signal;
      expect(init?.signal).toBe(signal);
      const h = new Headers(init?.headers);
      expect([...h]).toEqual(reason === 'passive' ? [['x-luson-passive', '1']] : []);
      return json(fetcher.mock.calls.length === 1 ? page(range(1, 50), 51) : page([51], 51, 2));
    });
    await loadSourceInventory(1, options, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('honors abort before, between and after pages even when fetch ignores cancellation', async () => {
    for (const timing of ['before', 'between', 'after']) {
      const controller = new AbortController();
      if (timing === 'before') controller.abort();
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
        if (timing === 'between' || fetcher.mock.calls.length === 2) controller.abort();
        return json(fetcher.mock.calls.length === 1 ? page(range(1, 50), 51) : page([51], 51, 2));
      });
      await expect(loadSourceInventory(1, { signal: controller.signal }, fetcher)).rejects.toMatchObject({ code: 'canceled' });
      expect(fetcher).toHaveBeenCalledTimes(timing === 'before' ? 0 : timing === 'between' ? 1 : 2);
    }
  });
  it('rejects unknown requested source without issuing GET', async () => {
    const fetcher = replies(page([]));
    await expect(loadSourceInventory(32768, {}, fetcher)).rejects.toMatchObject({ code: 'invalid_source' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('filters a complete catalog locally with literal brand/model search and exact brand/polarity', async () => {
    const fetcher = replies(page(range(1, 50), 51), page([51], 51, 2));
    const catalog = await loadSourceInventory(1, {}, fetcher);
    expect(filterSourceInventory(catalog, { kind: 'battery', search: '+_%', brand: 'TOYO', polarity: 'L' })).toHaveLength(51);
    expect(filterSourceInventory(catalog, { kind: 'battery', search: 'toyo' })).toHaveLength(51);
    expect(filterSourceInventory(catalog, { kind: 'battery', brand: 'toyo' })).toHaveLength(0);
    expect(filterSourceInventory(catalog, { kind: 'battery', polarity: 'R' })).toHaveLength(0);
    expect(() => filterSourceInventory(catalog, { kind: 'battery', search: '\0' })).toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('asks the endpoint for the one catalogue kind the document carries', async () => {
    const fetcher = replies(page([1], 1, 1, 2, 'Sucursal'));
    await loadSourceInventory(2, { kind: 'battery' }, fetcher);
    expect(fetcher.mock.calls[0][0]).toBe('/api/inventory?location_id=2&page=1&page_size=50&kind=battery');
  });
  it('rejects a reply that offers a row of the other kind', async () => {
    const product = JSON.stringify({ variant_id: 2, catalog_entry_id: 1, kind: 'other', name: 'Agua acidulada',
      detail: '5 L', battery: null, fields: [{ name: 'volumen en L', kind: 'number', unit: 'L', number: '5' }],
      existing: 3, reserved: 0, available: 3 });
    const mixed = page([1]).replace(']}', '') + ',' + product + ']}';
    await expect(loadSourceInventory(1, { kind: 'battery' }, replies(mixed))).rejects.toMatchObject({ code: 'malformed' });
  });
  it('offers only the selected kind and finds a product by its name or by a typed field', async () => {
    const product = (variant_id: number, name: string, field: string, value: string) => JSON.stringify({ variant_id,
      catalog_entry_id: variant_id, kind: 'other', name, detail: `${field}: ${value}`,
      battery: null, fields: [{ name: field, kind: 'number' as const, unit: 'L', number: value }],
      existing: 4, reserved: 0, available: 4 });
    const wire = '{"location":{"id":2,"name":"Sucursal"},"items":[' + product(1, 'Agua acidulada', 'volumen en L', '5')
      + ',' + product(2, 'Trapos de limpieza', 'bultos', '2') + '],"page":1,"page_size":50,"total_variants":2}';
    const catalog = await loadSourceInventory(2, { kind: 'other' }, replies(wire));
    expect(filterSourceInventory(catalog, { kind: 'other' })).toHaveLength(2);
    expect(filterSourceInventory(catalog, { kind: 'other', search: 'agua' }).map(row => row.variant_id)).toEqual([1]);
    // A term the row shows must find it: the typed field and its unit both count.
    expect(filterSourceInventory(catalog, { kind: 'other', search: 'volumen' }).map(row => row.variant_id)).toEqual([1]);
    expect(filterSourceInventory(catalog, { kind: 'other', search: 'bultos' }).map(row => row.variant_id)).toEqual([2]);
    // The battery filters never apply to a product, and a battery term finds nothing here.
    expect(filterSourceInventory(catalog, { kind: 'other', brand: 'TOYO', polarity: 'L' })).toHaveLength(2);
    expect(filterSourceInventory(catalog, { kind: 'other', search: 'toyo' })).toHaveLength(0);
    expect(filterSourceInventory(catalog, { kind: 'battery' })).toHaveLength(0);
  });
});
