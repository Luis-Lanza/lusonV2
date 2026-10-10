import { describe, expect, it, vi } from 'vitest';
import { createTransferAPI, TransferAPIError } from './transferAPI';
import { parseTransferRecord, type TransferCreateInput } from './transferModel';

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

describe('D2 dispatch transport', () => {
  const approved = { ...wire, status: 'approved', decision_location_id: 1, decided_at: '2026-04-03T00:00:00.000000001Z' };
  const transit = { ...approved, status: 'in_transit', dispatch_location_id: 1, dispatched_at: '2026-04-03T00:00:00.000000002Z' };
  const original = () => parseTransferRecord(JSON.stringify(approved));
  it('posts strict empty dispatch, accepts current transit approval retry and creation replay', async () => {
    const fetch = mockFetch().mockImplementation(async () => response(transit));
    const api = createTransferAPI(fetch);
    expect(await api.dispatch(original(), 'memory_csrf')).toMatchObject({ status: 'in_transit' });
    expect(fetch).toHaveBeenCalledWith('/api/transfers/1/dispatch', expect.objectContaining({ method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'memory_csrf' } }));
    expect(await api.decide(original(), 'approve', 'memory_csrf')).toMatchObject({ status: 'in_transit' });
    expect((await api.create(input(), 'memory_csrf')).record.status).toBe('in_transit');
  });
  it('classifies lost or mismatched dispatch as dispatch uncertainty, never creation', async () => {
    for (const reply of [() => Promise.reject(new Error('offline')), () => Promise.resolve(response(approved)),
      () => Promise.resolve(response({ ...transit, decided_at: '2026-04-03T00:00:00Z' })),
      () => Promise.resolve(response({ ...transit, items: [{ ...wire.items[0], quantity: '2' }] }))]) {
      const fetch = mockFetch().mockImplementation(reply);
      await expect(createTransferAPI(fetch).dispatch(original(), 'memory_csrf')).rejects.toMatchObject({ uncertainDispatch: true, uncertainCreation: false, uncertainDecision: false });
    }
  });
  it.each([[403, 'forbidden'], [404, 'not_found'], [409, 'decision_conflict'], [503, 'service_unavailable']] as const)('preserves definite dispatch failure %s', async (status, error) => {
    const fetch = mockFetch().mockResolvedValue(response({ error }, status));
    await expect(createTransferAPI(fetch).dispatch(original(), 'memory_csrf')).rejects.toMatchObject({ status, code: error, uncertainDispatch: false });
  });
});

describe('A05b decision transport', () => {
  const flows = [wire, { ...wire, origin_location_id: 3, origin_location_name: 'Sucursal B', approver_location_id: 3, approver_location_name: 'Sucursal B' },
    { ...wire, kind: 'send_to_warehouse', origin_location_id: 2, origin_location_name: 'Sucursal A', destination_location_id: 1, destination_location_name: 'Almacén' }];
  const terminal = (original: typeof wire, action: 'approve' | 'reject') => ({ ...original,
    status: action === 'approve' ? 'approved' : 'rejected', decision_location_id: original.approver_location_id, decided_at: '2026-04-03T00:00:00.000000001Z' });
  it.each(flows.flatMap(original => (['approve', 'reject'] as const).map(action => ({ original, action }))))
   ('posts only the empty whole-request decision $action for $original.kind/$original.origin_location_id', async ({ original, action }) => {
      const fetch = mockFetch().mockResolvedValue(response(terminal(original, action)));
      const signal = new AbortController().signal;
      const record = parseTransferRecord(JSON.stringify(original));
      expect(await createTransferAPI(fetch).decide(record, action, 'memory_csrf', signal)).toMatchObject({ status: action === 'approve' ? 'approved' : 'rejected', id: original.id });
      expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/transfers/1/' + action, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'memory_csrf' }, body: '{}',
      });
      expect([...new Headers(fetch.mock.calls[0][1]?.headers)]).toEqual([['content-type', 'application/json'], ['x-csrf-token', 'memory_csrf']]);
    });
  it.each(['9007199254740993', '9223372036854775807'])('keeps canonical int64 ID %s lossless in the decision path', async id => {
    const original = { ...wire, id, reference: `TR-${id}` };
    const fetch = mockFetch().mockResolvedValue(response(terminal(original, 'reject')));
    await createTransferAPI(fetch).decide(parseTransferRecord(JSON.stringify(original)), 'reject', 'memory');
    expect(fetch.mock.calls[0][0]).toBe(`/api/transfers/${id}/reject`);
  });
  it('creation never accepts decision_conflict or acquires decision uncertainty', async () => {
    const fetch = mockFetch().mockResolvedValue(response({ error: 'decision_conflict' }, 409));
    await expect(createTransferAPI(fetch).create(input(), 'memory')).rejects.toMatchObject({ code: 'invalid_response', uncertainCreation: true, uncertainDecision: false });
  });
  it.each(['approve', 'reject'] as const)('terminal original retries preserve persisted decision time on %s', async action => {
    const original = terminal(wire, action);
    const fetch = mockFetch().mockResolvedValueOnce(response(original))
      .mockResolvedValueOnce(response({ ...original, decided_at: '2026-04-03T00:00:00.000000002Z' }));
    const api = createTransferAPI(fetch); const record = parseTransferRecord(JSON.stringify(original));
    await expect(api.decide(record, action, 'memory')).resolves.toMatchObject({ decided_at: original.decided_at });
    await expect(api.decide(record, action, 'memory')).rejects.toMatchObject({ code: 'invalid_response', uncertainDecision: true });
  });
  it.each(['approve', 'reject'] as const)('captures the original before caller mutation on %s', async action => {
    let resolve!: (reply: Response) => void;
    const fetch = mockFetch().mockReturnValue(new Promise<Response>(yes => { resolve = yes; }));
    const original = parseTransferRecord(JSON.stringify(wire));
    const job = createTransferAPI(fetch).decide(original, action, 'memory');
    original.items[0].quantity = 1n; original.reference = 'changed';
    resolve(response(terminal(wire, action)));
    await expect(job).resolves.toMatchObject({ reference: wire.reference, items: [{ quantity: 9007199254740993n }] });
  });
  const mismatches = [
    { id: '2', reference: 'TR-002' }, { reference: 'different' }, { created_at: '2026-04-02T00:00:00.000000001Z' },
    { creator_location_id: 3, creator_location_name: 'Sucursal B', destination_location_id: 3, destination_location_name: 'Sucursal B' },
    { creator_location_name: 'different' }, { origin_location_name: 'different' }, { destination_location_name: 'different' },
    { approver_location_name: 'different' }, { origin_location_id: 3, approver_location_id: 3, decision_location_id: 3 },
    { kind: 'send_to_warehouse', origin_location_id: 2, destination_location_id: 1 },
    ...['variant_id', 'brand', 'model', 'capacity_ah', 'polarity', 'quantity'].map(field => ({ items: [{ ...wire.items[0],
      [field]: ({ variant_id: 202, brand: 'other', model: 'other', capacity_ah: '35.500001', polarity: 'L', quantity: '9007199254740992' } as Record<string, unknown>)[field] }] })),
    { items: [] }, { items: [...wire.items, { ...wire.items[0], variant_id: 202 }] },
    { decision_location_id: 2 }, { decided_at: 'private' }, { status: 'pending' },
  ];
  it.each((['approve', 'reject'] as const).flatMap(action => mismatches.map(patch => ({ action, patch }))))
   ('does not publish changed immutable identity or metadata on $action/$patch', async ({ action, patch }) => {
      const fetch = mockFetch().mockResolvedValue(response({ ...terminal(wire, action), ...patch }));
      await expect(createTransferAPI(fetch).decide(parseTransferRecord(JSON.stringify(wire)), action, 'memory'))
        .rejects.toMatchObject({ code: 'invalid_response', status: 200, uncertainCreation: false, uncertainDecision: true });
    });
  it.each(['approve', 'reject'] as const)('rejects wrong action and item order on %s', async action => {
    const original = { ...wire, items: [...wire.items, { ...wire.items[0], variant_id: 202 }] };
    const fetch = mockFetch().mockResolvedValueOnce(response(terminal(original, action === 'approve' ? 'reject' : 'approve')))
      .mockResolvedValueOnce(response({ ...terminal(original, action), items: [...original.items].reverse() }));
    const api = createTransferAPI(fetch); const record = parseTransferRecord(JSON.stringify(original));
    for (let i = 0; i < 2; i++) await expect(api.decide(record, action, 'memory')).rejects.toMatchObject({ code: 'invalid_response', uncertainDecision: true });
  });
  it.each([[401, 'unauthenticated'], [403, 'forbidden'], [404, 'not_found'], [409, 'insufficient_stock'], [409, 'decision_conflict'], [503, 'service_unavailable']] as const)
   ('sanitizes decision status %s/%s separately from creation', async (status, code) => {
      const fetch = mockFetch().mockResolvedValue(response({ error: code }, status));
      await expect(createTransferAPI(fetch).decide(parseTransferRecord(JSON.stringify(wire)), 'approve', 'memory'))
        .rejects.toMatchObject({ code, status, uncertainCreation: false, uncertainDecision: false, message: code });
    });
  it.each([response({ error: 'retry_conflict' }, 409), response({ error: 'SQL private' }, 403), response({ error: 'forbidden', private: wire }, 403),
    response(wire, 201), response(terminal(wire, 'approve'), 202), new Response('private', { status: 503 }),
    new Response('private malformed JSON', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    new Response(JSON.stringify(terminal(wire, 'approve')), { status: 200, headers: { 'Content-Type': 'text/html' } }),
    response({ ...terminal(wire, 'approve'), secret: 'private' })])
   ('keeps malformed decision replies uncertain and private', async reply => {
      const fetch = mockFetch().mockResolvedValue(reply.clone());
      const error = await createTransferAPI(fetch).decide(parseTransferRecord(JSON.stringify(wire)), 'approve', 'memory').catch(error => error);
      expect(error).toMatchObject({ code: 'invalid_response', uncertainDecision: true, uncertainCreation: false });
      expect(String(error)).not.toMatch(/SQL|private/);
    });
  it.each(['approve', 'reject'] as const)('keeps unknown network/abort outcomes distinct on %s', async action => {
    const fetch = mockFetch().mockRejectedValueOnce(new Error('private')).mockRejectedValueOnce(new DOMException('private', 'AbortError'));
    const api = createTransferAPI(fetch); const original = parseTransferRecord(JSON.stringify(wire));
    await expect(api.decide(original, action, 'memory')).rejects.toMatchObject({ code: 'network', uncertainDecision: true, uncertainCreation: false });
    await expect(api.decide(original, action, 'memory')).rejects.toMatchObject({ code: 'aborted', uncertainDecision: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each(['0', '01', '9223372036854775808', '1/approve', '1?x=1'])('rejects noncanonical ID %s locally', async id => {
    const fetch = mockFetch(); const original = { ...parseTransferRecord(JSON.stringify(wire)), id };
    await expect(createTransferAPI(fetch).decide(original, 'approve', 'memory')).rejects.toMatchObject({ code: 'invalid_request', uncertainDecision: false });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['', 'private token', 'x\r\ny'])('rejects invalid CSRF %s before transport', async token => {
    const fetch = mockFetch();
    await expect(createTransferAPI(fetch).decide(parseTransferRecord(JSON.stringify(wire)), 'reject', token)).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(createTransferAPI(fetch).decide(parseTransferRecord(JSON.stringify(wire)), 'other' as never, 'memory')).rejects.toMatchObject({ code: 'invalid_request' });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('A05a outcome transport', () => {
  it.each(['approved', 'rejected'] as const)('reads and replays the original %s DTO without a Location prerequisite', async status => {
    const outcome = { ...wire, status, decision_location_id: 1, decided_at: '2026-04-03T00:00:00.000000001Z' };
    const fetch = mockFetch().mockResolvedValueOnce(response({ page: 1, page_size: 25, status, total_count: '1', records: [outcome] }))
      .mockResolvedValueOnce(response(outcome)).mockResolvedValueOnce(response(outcome, 200));
    const api = createTransferAPI(fetch);
    expect((await api.list({ status })).records[0]).toMatchObject({ status, decided_at: outcome.decided_at });
    expect(await api.detail('1')).toMatchObject({ status, created_at: wire.created_at });
    expect(await api.create(input(), 'memory')).toMatchObject({ replayed: true, record: { status, id: '1' } });
    expect(fetch.mock.calls[0][0]).toBe(`/api/transfers?page=1&page_size=25&status=${status}`);
    expect(fetch.mock.calls[2][1]?.body).toContain('stable_key_000001');
  });
  it.each(['approved', 'rejected'] as const)('accepts a full %s creation201 as well as replay200 and rejects malformed metadata', async status => {
    const outcome = { ...wire, status, decision_location_id: 1, decided_at: '2028-02-29T23:59:59.123456789Z' };
    const fetch = mockFetch().mockResolvedValueOnce(response(outcome, 201))
      .mockResolvedValueOnce(response({ ...outcome, decision_location_id: 2 }, 200));
    const api = createTransferAPI(fetch);
    expect(await api.create(input(), 'memory')).toMatchObject({ replayed: false, record: { status, decided_at: outcome.decided_at } });
    await expect(api.create(input(), 'memory')).rejects.toMatchObject({ code: 'invalid_response', status: 200, uncertainCreation: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('captures selected list status before await and rejects a different returned status', async () => {
    let resolve!: (reply: Response) => void;
    const delayed = new Promise<Response>(yes => { resolve = yes; });
    const fetch = mockFetch().mockReturnValueOnce(delayed).mockResolvedValueOnce(response({ page: 1, page_size: 25, status: 'pending', total_count: '0', records: [] }));
    const api = createTransferAPI(fetch); const query = { status: 'approved' as 'approved' | 'rejected' };
    const pending = api.list(query); query.status = 'rejected';
    resolve(response({ page: 1, page_size: 25, status: 'approved', total_count: '0', records: [] }));
    expect((await pending).status).toBe('approved');
    await expect(api.list({ status: 'rejected' })).rejects.toMatchObject({ code: 'invalid_response', status: 200 });
  });
  it.each([401, 403, 503] as const)('preserves counts error classification for status%s without creation uncertainty', async status => {
    const code = status === 401 ? 'unauthenticated' : status === 403 ? 'forbidden' : 'service_unavailable';
    const fetch = mockFetch().mockResolvedValue(response({ error: code }, status));
    await expect(createTransferAPI(fetch).counts()).rejects.toMatchObject({ code, status, uncertainCreation: false });
    expect(new Headers(fetch.mock.calls[0][1]?.headers).has('X-Luson-Passive')).toBe(false);
  });
  it('issues passive counts without query, CSRF, selectors or caller headers', async () => {
    const fetch = mockFetch().mockResolvedValue(response({ pending_total: '9007199254740993', action_count: '2' }));
    const signal = new AbortController().signal;
    const api = createTransferAPI(fetch);
    expect(await api.counts({ signal, passive: true, headers: { Origin: 'private' }, location: 1 } as never))
      .toEqual({ pending_total: 9007199254740993n, action_count: 2n });
    expect(fetch.mock.calls[0][0]).toBe('/api/transfers/counts');
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store', signal });
    expect([...new Headers(fetch.mock.calls[0][1]?.headers)]).toEqual([]);
  });
  it.each([response({ pending_total: '1', action_count: '2' }), response({ pending_total: '1', action_count: '0', secret: 'private' }),
    response({ error: 'private' }, 403), response({ pending_total: '1', action_count: '0' }, 201)])('sanitizes malformed counts and unknown replies', async reply => {
    const fetch = mockFetch().mockResolvedValue(reply.clone());
    await expect(createTransferAPI(fetch).counts()).rejects.toMatchObject({ code: 'invalid_response', uncertainCreation: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

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
