import { describe, expect, it, vi } from 'vitest';
import { filterSourceInventory, loadSourceInventory, SourceInventoryError } from './sourceInventory';

// Raw numeric wire tokens, not JSON.stringify(bigint) or rounded JS quantities.
function row(id: number, stock = '9223372036854775807', entry = Math.ceil(id / 2)): string {
  return `{"variant_id":${id},"catalog_entry_id":${entry},"brand":"TOYO","model":"M+_%","capacity_ah":6.000001,"polarity":"L","existing":${stock},"reserved":0,"available":${stock}}`;
}
function page(ids: number[], total = ids.length, current = 1, source = 1, name = 'Almacén'): string {
  return `{"location":{"id":${source},"name":"${name}"},"items":[${ids.map(id => row(id)).join(',')}],"page":${current},"page_size":50,"total_variants":${total}}`;
}
const json = (raw: string, status = 200) => new Response(raw, { status, headers: { 'Content-Type': 'application/json' } });
const range = (first: number, count: number) => Array.from({ length: count }, (_, i) => first + i);
const replies = (...raws: string[]) => vi.fn<typeof fetch>().mockImplementation(async () => json(raws.shift()!));

describe('R04 source catalog', () => {
  it('loads all190 in four unfiltered pages and freezes exact copied rows', async () => {
    const fetcher = replies(page(range(1, 50), 190), page(range(51, 50), 190, 2), page(range(101, 50), 190, 3), page(range(151, 40), 190, 4));
    const catalog = await loadSourceInventory(1, {}, fetcher);
    expect(catalog.rows).toHaveLength(190);
    expect(catalog.rows[189]).toMatchObject({ variant_id: 190, catalog_entry_id: 95, available: 9223372036854775807n, capacity_ah: '6.000001' });
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
  it('accepts a consistent empty catalog without fabricated rows', async () => {
    const fetcher = replies(page([]));
    expect((await loadSourceInventory(1, {}, fetcher)).rows).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['entry96', page([190]).replace('"catalog_entry_id":95', '"catalog_entry_id":96')],
    ['variant191', page([191], 1)],
    ['variant0', page([0], 1)],
    ['oversize', page([1], 191)],
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
    expect(filterSourceInventory(catalog, { search: '+_%', brand: 'TOYO', polarity: 'L' })).toHaveLength(51);
    expect(filterSourceInventory(catalog, { search: 'toyo' })).toHaveLength(51);
    expect(filterSourceInventory(catalog, { brand: 'toyo' })).toHaveLength(0);
    expect(filterSourceInventory(catalog, { polarity: 'R' })).toHaveLength(0);
    expect(() => filterSourceInventory(catalog, { search: '\0' })).toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
