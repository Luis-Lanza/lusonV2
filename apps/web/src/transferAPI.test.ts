import { describe, expect, it, vi } from 'vitest';
import { createTransferAPI, TransferAPIError } from './transferAPI';
import type { TransferCreateInput } from './transferModel';

const wire = {
  id: '1', reference: 'TR-001', kind: 'request_stock', status: 'pending', created_at: '2026-04-02T00:00:00Z',
  creator_location_id: 2, creator_location_name: 'Sucursal A', origin_location_id: 1, origin_location_name: 'Almacén',
  destination_location_id: 2, destination_location_name: 'Sucursal A', approver_location_id: 1, approver_location_name: 'Almacén',
  items: [{ variant_id: 201, brand: 'Brand', model: 'Model', capacity_ah: '35.5', polarity: 'R', quantity: '9007199254740993' }],
};
const input = (): TransferCreateInput => ({ kind: 'request_stock', counterparty_location_id: 1, retry_key: 'stable_key_000001',
  items: [{ variant_id: 201, quantity: '9007199254740993' }, { variant_id: 1, quantity: '2' }] });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const mockFetch = () => vi.fn<typeof fetch>();

describe('R04 pure transfer API', () => {
  it('uses relative private GET paths, same-origin cookies, no-store and immutable passive selection', async () => {
    const fetch = mockFetch();
    fetch.mockResolvedValueOnce(response({ page: 1, page_size: 25, status: 'pending', total_count: '0', records: [] }))
      .mockImplementation(async () => response(wire));
    const api = createTransferAPI(fetch);
    const controller = new AbortController();
    expect((await api.list()).total_count).toBe(0n);
    const options = { passive: true, signal: controller.signal };
    const pending = api.detail('9007199254740993', options);
    options.passive = false;
    await pending;
    await api.detail('1');
    expect(fetch.mock.calls.map(c => c[0])).toEqual(['/api/transfers?page=1&page_size=25&status=pending', '/api/transfers/9007199254740993', '/api/transfers/1']);
    for (const [, init] of fetch.mock.calls) {
      expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store' });
      expect(new Headers(init?.headers).has('Origin')).toBe(false);
      expect(new Headers(init?.headers).has('X-CSRF-Token')).toBe(false);
    }
    expect([...new Headers(fetch.mock.calls[1][1]?.headers)]).toEqual([['x-luson-passive', '1']]);
    expect(fetch.mock.calls[1][1]?.signal).toBe(controller.signal);
    expect(new Headers(fetch.mock.calls[0][1]?.headers).has('X-Luson-Passive')).toBe(false);
    expect(new Headers(fetch.mock.calls[2][1]?.headers).has('X-Luson-Passive')).toBe(false);
  });
  it.each([201, 200])('keeps POST retry identity and public record on status %s', async status => {
    const fetch = mockFetch().mockResolvedValue(response(wire, status));
    const attempt = input();
    const original = JSON.stringify(attempt);
    const controller = new AbortController();
    const result = await createTransferAPI(fetch).create(attempt, 'memory_csrf', controller.signal);
    expect(result.replayed).toBe(status === 200);
    expect(result.record.items[0].quantity).toBe(9007199254740993n);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [path, init] = fetch.mock.calls[0];
    expect(path).toBe('/api/transfers');
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
    expect([...new Headers(init?.headers)]).toEqual([['content-type', 'application/json'], ['x-csrf-token', 'memory_csrf']]);
    expect(JSON.parse(init?.body as string)).toEqual({ ...attempt, items: [...attempt.items].sort((a, b) => a.variant_id - b.variant_id) });
    expect(JSON.stringify(attempt)).toBe(original);
  });
  it.each([
    [400, 'invalid_request'], [401, 'unauthenticated'], [403, 'forbidden'], [404, 'not_found'],
    [405, 'method_not_allowed'], [409, 'insufficient_stock'], [409, 'retry_conflict'], [503, 'service_unavailable'],
  ] as const)('exposes only known sanitized status/code %s %s', async (status, code) => {
    const fetch = mockFetch().mockResolvedValue(response({ error: code }, status));
    await expect(createTransferAPI(fetch).create(input(), 'memory')).rejects.toMatchObject({ code, status });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('does not reveal missing versus foreign detail records', async () => {
    const fetch = mockFetch().mockResolvedValue(response({ error: 'not_found' }, 404));
    await expect(createTransferAPI(fetch).detail('1')).rejects.toMatchObject({ code: 'not_found', status: 404 });
  });
  it.each([
    response({ error: 'secret SQL private-token' }, 409), response({ error: 'forbidden' }, 401),
    response({ error: 'not_found', record: wire }, 404), new Response('<html>private-token</html>', { status: 503 }),
    response(wire, 202), response({ ...wire, id: 1 }, 201), response({ ...wire, retry_key: 'private-token' }, 200),
    new Response(JSON.stringify(wire), { status: 201, headers: { 'Content-Type': 'text/html' } }),
  ])('fails closed on unknown errors, unexpected status, framing or malformed success', async reply => {
    const fetch = mockFetch().mockResolvedValue(reply.clone());
    try { await createTransferAPI(fetch).create(input(), 'private-token'); throw new Error('Unexpected success'); }
    catch (error) {
      expect(error).toBeInstanceOf(TransferAPIError);
      expect((error as TransferAPIError).code).toBe('invalid_response');
      expect(String(error)).not.toContain('private-token');
      expect(String(error)).not.toContain('SQL');
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('distinguishes uncertain network/abort creation and preserves same caller attempt for explicit retry', async () => {
    const fetch = mockFetch().mockRejectedValueOnce(new Error('private-token network'))
      .mockRejectedValueOnce(new DOMException('private-token', 'AbortError')).mockResolvedValue(response(wire, 200));
    const api = createTransferAPI(fetch);
    const attempt = input();
    await expect(api.create(attempt, 'memory')).rejects.toMatchObject({ code: 'network', status: null, uncertainCreation: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(api.create(attempt, 'memory')).rejects.toMatchObject({ code: 'aborted', uncertainCreation: true });
    await expect(api.create(attempt, 'memory')).resolves.toMatchObject({ replayed: true });
    expect(fetch.mock.calls.map(c => c[1]?.body)).toEqual(Array(3).fill(fetch.mock.calls[0][1]?.body));
    const read = mockFetch().mockRejectedValue(new Error('private-token'));
    await expect(createTransferAPI(read).detail('1')).rejects.toMatchObject({ code: 'network', uncertainCreation: false });
  });
  it('uses passive list reads only when requested and rejects malformed pages', async () => {
    const fetch = mockFetch().mockResolvedValueOnce(response({ page: 2, page_size: 10, status: 'pending', total_count: '0', records: [] }))
      .mockResolvedValueOnce(response({ page: 1, page_size: 25, status: 'pending', total_count: 2, records: [] }));
    const api = createTransferAPI(fetch);
    await expect(api.list({ page: 2, page_size: 10 }, { passive: true })).resolves.toMatchObject({ page: 2 });
    expect(fetch.mock.calls[0][0]).toBe('/api/transfers?page=2&page_size=10&status=pending');
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('X-Luson-Passive')).toBe('1');
    await expect(api.list()).rejects.toMatchObject({ code: 'invalid_response', uncertainCreation: false });
  });
  it('captures a cloned attempt before caller changes and never conceals key conflicts', async () => {
    const fetch = mockFetch().mockResolvedValueOnce(response(wire, 201)).mockResolvedValueOnce(response({ error: 'retry_conflict' }, 409));
    const api = createTransferAPI(fetch);
    const attempt = input();
    const pending = api.create(attempt, 'memory');
    attempt.items[0].quantity = '3';
    await pending;
    await expect(api.create(attempt, 'memory')).rejects.toMatchObject({ code: 'retry_conflict', status: 409 });
    const bodies = fetch.mock.calls.map(c => JSON.parse(c[1]?.body as string));
    expect(bodies[0].items[1].quantity).toBe('9007199254740993');
    expect(bodies[1].items[1].quantity).toBe('3');
    expect(bodies[0].retry_key).toBe(bodies[1].retry_key);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('rejects invalid local inputs before sending any authority', async () => {
    const fetch = mockFetch();
    const api = createTransferAPI(fetch);
    await expect(api.detail('1?private=1')).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(api.list({ search: 'private' } as never)).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(api.create({ ...input(), retry_key: 'short' }, 'memory')).rejects.toMatchObject({ code: 'invalid_request', uncertainCreation: false });
    await expect(api.create(input(), '')).rejects.toMatchObject({ code: 'invalid_request' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
