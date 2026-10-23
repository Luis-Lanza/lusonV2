import { describe, expect, it, vi } from 'vitest';
import { createTransferAPI, TransferAPIError } from './transferAPI';
import { parseTransferRecord, type TransferCreateInput } from './transferModel';

import type { CountDecisionInput, CountProposalInput } from './transferCountCorrectionModel';

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

describe('C3b count correction transport', () => {
  const id = '9007199254740993';
  const input = (): CountProposalInput => ({ variant_id: 201, operation_key: 'count_proposal_0001',
    expected_revision: '9007199254740993', actual_quantity: '9223372036854775807', reason: '  physical recount  ' });
  const decision = (): CountDecisionInput => ({ variant_id: 201, operation_key: 'count_decision_0001',
    expected_revision: '9007199254740994', reason: '  verified  ' });
  const persisted = (action = 'propose') => ({ ...(action === 'propose' ? input() : decision()), request_id: id,
    actor_location_id: 2, action, actual_quantity: action === 'propose' ? input().actual_quantity : null,
    revision: '9007199254740994', recorded_at: '2026-01-02T12:00:00.000000001Z' });
  const call = (fetch: typeof globalThis.fetch, signal?: AbortSignal) => createTransferAPI(fetch).proposeCount(id, 2, input(), 'memory_csrf', signal);
  it('captures exact immutable proposal before network and returns historical persisted operation on identical retry', async () => {
    let resolve!: (value: Response) => void;
    const fetch = mockFetch().mockReturnValueOnce(new Promise<Response>(yes => { resolve = yes; }))
      .mockResolvedValue(response(persisted()));
    const original = input(); const api = createTransferAPI(fetch); const signal = new AbortController().signal;
    const job = api.proposeCount(id, 2, original, 'memory_csrf', signal);
    Object.assign(original, { operation_key: 'changed_key_00001', expected_revision: '1', actual_quantity: '0', reason: 'changed', variant_id: 1 });
    resolve(response(persisted()));
    const op = await job;
    expect(op).toMatchObject({ request_id: 9007199254740993n, actual_quantity: 9223372036854775807n });
    expect(Object.isFrozen(op)).toBe(true);
    expect(await api.proposeCount(id, 2, input(), 'memory_csrf', signal)).toEqual(op);
    for (const args of fetch.mock.calls) expect(args).toEqual([`/api/transfers/${id}/count-corrections/propose`, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'memory_csrf' },
      body: '{"variant_id":201,"operation_key":"count_proposal_0001","expected_revision":"9007199254740993","reason":"  physical recount  ","actual_quantity":"9223372036854775807"}',
    }]);
    expect(fetch.mock.calls[0][1]?.body).not.toContain('actor_location_id');
  });
  it.each(['accept', 'reject'] as const)('sends %s without actual or actor and accepts null actual', async action => {
    const fetch = mockFetch().mockResolvedValue(response(persisted(action)));
    const op = await createTransferAPI(fetch).decideCount(id, 2, action, decision(), 'memory');
    expect(op).toMatchObject({ action, actual_quantity: null, expected_revision: 9007199254740994n });
    expect(fetch.mock.calls[0]).toEqual([`/api/transfers/${id}/count-corrections/${action}`, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: undefined,
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'memory' }, body: JSON.stringify(decision()),
    }]);
  });
  it.each([
    { request_id: '1' }, { variant_id: 202 }, { actor_location_id: 1 }, { action: 'accept', actual_quantity: null, expected_revision: '9007199254740994' },
    { operation_key: 'different_key_0001' }, { expected_revision: '9007199254740992', revision: '9007199254740993' },
    { actual_quantity: '0' }, { actual_quantity: null }, { reason: 'physical recount' }, { revision: '1' },
  ])('treats any requested identity mismatch as correction-only uncertainty %j', async patch => {
    const fetch = mockFetch().mockResolvedValue(response({ ...persisted(), ...patch }));
    await expect(call(fetch)).rejects.toMatchObject({ code: 'invalid_response', uncertainCorrection: true,
      uncertainCreation: false, uncertainDecision: false, uncertainDispatch: false, uncertainReceipt: false, uncertainCancellation: false });
  });
  it.each(['accept', 'reject'] as const)('rejects decision %s with non-null actual or swapped action', async action => {
    for (const patch of [{ actual_quantity: '0' }, { action: action === 'accept' ? 'reject' : 'accept' }]) {
      const fetch = mockFetch().mockResolvedValue(response({ ...persisted(action), ...patch }));
      await expect(createTransferAPI(fetch).decideCount(id, 2, action, decision(), 'memory')).rejects.toMatchObject({ uncertainCorrection: true });
    }
  });
  it.each(['network', 'abort', 'read', 'json', 'media', 'schema', '503', 'wrongStatus', 'duplicate', 'private'] as const)
    ('sanitizes ambiguous %s without creation uncertainty or private payload', async mode => {
      const fetch = mockFetch().mockImplementation(async () => {
        if (mode === 'network') throw new Error('PRIVATE SQL');
        if (mode === 'abort') throw new DOMException('PRIVATE SQL', 'AbortError');
        if (mode === 'read') {
          const reply = response(persisted());
          vi.spyOn(reply, 'text').mockRejectedValue(new Error('PRIVATE SQL'));
          return reply;
        }
        if (mode === 'json') return new Response('{PRIVATE', { headers: { 'Content-Type': 'application/json' } });
        if (mode === 'media') return new Response('PRIVATE', { status: 400, headers: { 'Content-Type': 'text/html' } });
        if (mode === '503') return response({ error: 'service_unavailable' }, 503);
        if (mode === 'wrongStatus') return response({ error: 'invalid_request' }, 500);
        if (mode === 'duplicate') return new Response('{"error":"invalid_request","error":"invalid_request"}', { status: 400, headers: { 'Content-Type': 'application/json' } });
        return response({ ...persisted(), ...(mode === 'private' ? { private_history: 'PRIVATE SQL' } : { actual_quantity: 1 }) });
      });
      const error = await call(fetch).catch(error => error);
      expect(error).toBeInstanceOf(TransferAPIError);
      expect(error).toMatchObject({ uncertainCorrection: true, uncertainCreation: false, uncertainDecision: false,
        uncertainDispatch: false, uncertainReceipt: false, uncertainCancellation: false });
      expect(String(error)).not.toMatch(/PRIVATE|SQL/);
      expect(Object.values(error)).not.toContain('PRIVATE SQL');
      if (mode === 'abort') expect(error.code).toBe('aborted');
      if (mode === '503') expect(error).toMatchObject({ code: 'service_unavailable', status: 503 });
    });
  it('retains abort uncertainty when an aborted signal causes transport failure', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(call(mockFetch().mockRejectedValue(new Error()), controller.signal)).rejects.toMatchObject({ code: 'aborted', uncertainCorrection: true });
  });
  it.each([[400, 'invalid_request'], [409, 'retry_conflict'], [409, 'decision_conflict'], [409, 'insufficient_stock'],
    [401, 'unauthenticated'], [403, 'forbidden'], [404, 'not_found']] as const)
    ('maps recognized %s/%s as definite for this call only', async (status, code) => {
      await expect(call(mockFetch().mockResolvedValue(response({ error: code }, status)))).rejects.toMatchObject({ code, status,
        uncertainCorrection: false, uncertainCreation: false });
    });
  it.each([[400, 'retry_conflict'], [409, 'invalid_request'], [503, 'not_found'], [201, 'service_unavailable']] as const)
    ('does not trust wrong status/code %s/%s as definite', async (status, code) => {
      await expect(call(mockFetch().mockResolvedValue(response({ error: code }, status)))).rejects.toMatchObject({ code: 'invalid_response', uncertainCorrection: true });
    });
  it('reads private immutable snapshot with exact route ID and no mutation headers', async () => {
    const fetch = mockFetch().mockResolvedValue(response({ request_id: id, lines: [], operations: [persisted()] }));
    const signal = new AbortController().signal;
    expect(await createTransferAPI(fetch).countCorrections(id, { signal, passive: true })).toMatchObject({ request_id: BigInt(id) });
    expect(fetch.mock.calls[0]).toEqual([`/api/transfers/${id}/count-corrections`, {
      method: 'GET', credentials: 'same-origin', cache: 'no-store', signal, headers: { 'X-Luson-Passive': '1' },
    }]);
    fetch.mockResolvedValue(response({ request_id: '1', lines: [], operations: [] }));
    await expect(createTransferAPI(fetch).countCorrections(id)).rejects.toMatchObject({ code: 'invalid_response', uncertainCorrection: false });
  });
  it('rejects invalid route, actor context, CSRF, action and payload locally', async () => {
    const fetch = mockFetch(); const api = createTransferAPI(fetch);
    for (const badID of ['0', '01', '1/accept', '1?x=1', '9223372036854775808']) {
      await expect(api.proposeCount(badID, 2, input(), 'memory')).rejects.toMatchObject({ code: 'invalid_request', uncertainCorrection: false });
      await expect(api.countCorrections(badID)).rejects.toMatchObject({ code: 'invalid_request' });
    }
    for (const actor of [0, 4, 1.5, '2']) await expect(api.proposeCount(id, actor as number, input(), 'memory')).rejects.toMatchObject({ code: 'invalid_request' });
    for (const csrf of ['', 'bad token', 'x\r\ny']) await expect(api.proposeCount(id, 2, input(), csrf)).rejects.toMatchObject({ code: 'invalid_request' });
    for (const action of ['approve', 'propose', null]) {
      await expect(api.decideCount(id, 2, action as never, input(), 'memory')).rejects.toMatchObject({ code: 'invalid_request' });
    }
    await expect(api.decideCount(id, 2, 'accept', input(), 'memory')).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(api.proposeCount(id, 2, { ...input(), actual_quantity: 1 } as never, 'memory')).rejects.toMatchObject({ code: 'invalid_request' });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('C2 cancelled lifecycle transport', () => {
  const cancelled = (approved = false, patch: Record<string, unknown> = {}) => ({ ...wire, status: 'cancelled',
    cancellation_location_id: 2, cancelled_at: '2026-04-03T00:00:00.000000002Z',
    ...(approved ? { decision_location_id: 1, decided_at: '2026-04-03T00:00:00.000000001Z' } : {}), ...patch });
  const original = (approved = false) => parseTransferRecord(JSON.stringify({ ...wire,
    ...(approved ? { status: 'approved', decision_location_id: 1, decided_at: '2026-04-03T00:00:00.000000001Z' } : {}) }));
  it.each([false, true])('reads cancelled detail and identical original creation replay (approved=%s)', async approved => {
    const current = cancelled(approved);
    const fetch = mockFetch().mockImplementation(async () => response(current));
    const api = createTransferAPI(fetch);
    expect(await api.detail('1')).toMatchObject({ status: 'cancelled', cancellation_location_id: 2 });
    expect(await api.create(input(), 'memory')).toMatchObject({ replayed: true, record: { status: 'cancelled', id: '1' } });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/transfers/1', '/api/transfers']);
    expect(fetch.mock.calls[1][1]?.body).toContain('stable_key_000001');
  });
  it('queries cancelled participant pages and reads terminal zero counts without mutation', async () => {
    const fetch = mockFetch().mockResolvedValueOnce(response({ page: 1, page_size: 25, status: 'cancelled', total_count: '1', records: [cancelled()] }))
      .mockResolvedValueOnce(response({ pending_total: '0', action_count: '0' }));
    const api = createTransferAPI(fetch);
    expect((await api.list({ status: 'cancelled' as never })).records[0].status).toBe('cancelled');
    expect(await api.counts()).toEqual({ pending_total: 0n, action_count: 0n });
    expect(fetch.mock.calls[0][0]).toBe('/api/transfers?page=1&page_size=25&status=cancelled');
    expect(fetch.mock.calls.every(([, init]) => init?.method === 'GET' && init.body === undefined)).toBe(true);
  });
  it.each([false, true])('posts only strict empty cancellation and preserves approval identity (approved=%s)', async approved => {
    const fetch = mockFetch().mockResolvedValue(response(cancelled(approved)));
    const signal = new AbortController().signal;
    // Planned method absence is not the behavioral decoder RED above.
    expect(await createTransferAPI(fetch).cancel(original(approved), 'memory_csrf', signal))
      .toMatchObject({ status: 'cancelled', cancelled_at: '2026-04-03T00:00:00.000000002Z' });
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/transfers/1/cancel', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'memory_csrf' }, body: '{}',
    });
  });
  it.each([[400, 'invalid_request'], [401, 'unauthenticated'], [403, 'forbidden'], [404, 'not_found'],
    [409, 'decision_conflict'], [503, 'service_unavailable']] as const)
    ('keeps definite cancellation %s/%s separate from uncertainty', async (status, code) => {
      const fetch = mockFetch().mockResolvedValue(response({ error: code }, status));
      await expect(createTransferAPI(fetch).cancel(original(), 'memory')).rejects.toMatchObject({ status, code,
        uncertainCancellation: false, uncertainCreation: false, uncertainDecision: false, uncertainDispatch: false, uncertainReceipt: false });
    });
  it.each(['network', 'media', 'identity', 'approval', 'missingApproval', 'pending', 'private'] as const)
    ('sanitizes uncertain cancellation %s without publishing changed immutable history', async mode => {
      const fetch = mockFetch().mockImplementation(async () => {
        if (mode === 'network') throw new Error('PRIVATE SQL');
        if (mode === 'media') return new Response(JSON.stringify(cancelled(true)), { headers: { 'Content-Type': 'text/html' } });
        const patch = mode === 'identity' ? { items: [{ ...wire.items[0], quantity: '1' }] }
          : mode === 'approval' ? { decided_at: '2026-04-03T00:00:00Z' }
          : mode === 'missingApproval' ? { decision_location_id: undefined, decided_at: undefined }
          : mode === 'pending' ? { status: 'pending' } : mode === 'private' ? { allocations: 'PRIVATE SQL' } : {};
        return response(cancelled(true, patch));
      });
      const error = await createTransferAPI(fetch).cancel(original(true), 'memory').catch(error => error);
      expect(error).toMatchObject({ uncertainCancellation: true, uncertainCreation: false, uncertainDecision: false, uncertainDispatch: false });
      expect(String(error)).not.toMatch(/PRIVATE|SQL/);
    });
  it('admits approval serialized before a Pending cancellation without changing original creation identity', async () => {
    const fetch = mockFetch().mockResolvedValue(response(cancelled(true)));
    expect(await createTransferAPI(fetch).cancel(original(), 'memory')).toMatchObject({ status: 'cancelled',
      decision_location_id: 1, decided_at: '2026-04-03T00:00:00.000000001Z' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('pins the original before transport and admits identical persisted cancellation retries', async () => {
    let resolve!: (value: Response) => void;
    const fetch = mockFetch().mockReturnValueOnce(new Promise<Response>(yes => { resolve = yes; }))
      .mockResolvedValue(response(cancelled(true)));
    const api = createTransferAPI(fetch); const captured = original(true);
    const job = api.cancel(captured, 'memory');
    captured.items[0].quantity = 1n; captured.reference = 'changed';
    resolve(response(cancelled(true)));
    const outcome = await job;
    expect(outcome).toMatchObject({ status: 'cancelled', reference: 'TR-001', items: [{ quantity: 9007199254740993n }] });
    expect(await api.cancel(outcome, 'memory')).toEqual(outcome);
    expect(fetch.mock.calls.map(([url, init]) => [url, init?.body])).toEqual([
      ['/api/transfers/1/cancel', '{}'], ['/api/transfers/1/cancel', '{}'],
    ]);
  });
  it('rejects invalid cancellation authority, identifiers and terminal inputs locally', async () => {
    const fetch = mockFetch(); const api = createTransferAPI(fetch);
    for (const id of ['0', '01', '1/cancel', '1?x=1', '9223372036854775808']) {
      await expect(api.cancel({ ...original(), id }, 'memory')).rejects.toMatchObject({ code: 'invalid_request', uncertainCancellation: false });
    }
    for (const token of ['', 'private token', 'x\r\ny']) {
      await expect(api.cancel(original(), token)).rejects.toMatchObject({ code: 'invalid_request' });
    }
    const rejected = parseTransferRecord(JSON.stringify({ ...wire, status: 'rejected', decision_location_id: 1,
      decided_at: '2026-04-03T00:00:00.000000001Z' }));
    await expect(api.cancel(rejected, 'memory')).rejects.toMatchObject({ code: 'invalid_request' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not transform decision/dispatch conflict into cancellation success', async () => {
    const fetch = mockFetch().mockImplementation(async () => response({ error: 'decision_conflict' }, 409));
    const api = createTransferAPI(fetch);
    await expect(api.decide(original(true), 'approve', 'memory')).rejects.toMatchObject({ code: 'decision_conflict', uncertainDecision: false });
    await expect(api.dispatch(original(true), 'memory')).rejects.toMatchObject({ code: 'decision_conflict', uncertainDispatch: false });
  });
});

describe('R2 Received lifecycle transport', () => {
  const approved = { ...wire, status: 'approved', decision_location_id: 1, decided_at: '2026-04-03T00:00:00.000000001Z' };
  const transit = { ...approved, status: 'in_transit', dispatch_location_id: 1, dispatched_at: '2026-04-03T00:00:00.000000002Z' };
  const received = { ...transit, status: 'received', receipt_location_id: 2, received_at: '2026-04-03T00:00:00.000000003Z',
    receipt: { items: [{ variant_id: 201, expected_quantity: '9007199254740993', actual_quantity: '9007199254740993', available_quantity: '9007199254740993' }], exceptions: [] } };
  const parse = (value: unknown) => parseTransferRecord(JSON.stringify(value));
  it('reads Received detail and creation replay instead of reporting a malformed outcome', async () => {
    const fetch = mockFetch().mockImplementation(async () => response(received));
    const api = createTransferAPI(fetch);
    expect((await api.detail('1')).status).toBe('received');
    expect(await api.create(input(), 'memory_csrf')).toMatchObject({ replayed: true, record: { status: 'received' } });
  });
  it('accepts latest Received on authorized approve and dispatch retries', async () => {
    const fetch = mockFetch().mockImplementation(async () => response(received));
    const api = createTransferAPI(fetch);
    expect((await api.decide(parse(approved), 'approve', 'memory_csrf')).status).toBe('received');
    expect((await api.dispatch(parse(approved), 'memory_csrf')).status).toBe('received');
    expect((await api.dispatch(parse(transit), 'memory_csrf')).status).toBe('received');
    expect((await api.dispatch(parse(received), 'memory_csrf')).status).toBe('received');
  });
  it('uses workflow counts and Received list filtering without a Pending ceiling', async () => {
    const fetch = mockFetch().mockResolvedValueOnce(response({ pending_total: '0', action_count: '2' }))
      .mockResolvedValueOnce(response({ page: 1, page_size: 25, status: 'received', total_count: '1', records: [received] }));
    const api = createTransferAPI(fetch);
    expect(await api.counts()).toEqual({ pending_total: 0n, action_count: 2n });
    expect((await api.list({ status: 'received' as never })).records[0].status).toBe('received');
  });
  it('posts canonical receipt quantities only, retaining explicit zeros and sorting variants', async () => {
    const unexpected = { ...received, receipt: { items: [
      { variant_id: 1, expected_quantity: '0', actual_quantity: '9223372036854775807', available_quantity: '0' },
      { variant_id: 201, expected_quantity: '9007199254740993', actual_quantity: '0', available_quantity: '0' },
    ], exceptions: [ { variant_id: 1, kind: 'unexpected', quantity: '9223372036854775807' },
      { variant_id: 201, kind: 'shortage', quantity: '9007199254740993' } ] } };
    const fetch = mockFetch().mockResolvedValue(response(unexpected));
    const api = createTransferAPI(fetch);
    const signal = new AbortController().signal;
    // Planned API method; no production shim is supplied in the tests-only phase.
    const result = await api.receive(parse(transit), { items: [
      { variant_id: 201, actual_quantity: '0' }, { variant_id: 1, actual_quantity: '9223372036854775807' },
    ] }, 'memory_csrf', signal);
    expect(result.status).toBe('received');
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/transfers/1/receive', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'memory_csrf' },
      body: '{"items":[{"variant_id":1,"actual_quantity":"9223372036854775807"},{"variant_id":201,"actual_quantity":"0"}]}',
    });
  });
  it.each([[400, 'invalid_request'], [401, 'unauthenticated'], [403, 'forbidden'], [404, 'not_found'],
    [409, 'retry_conflict'], [409, 'decision_conflict'], [503, 'service_unavailable']] as const)
    ('keeps definite receive failure %s/%s separate from mutation uncertainty', async (status, code) => {
      const fetch = mockFetch().mockResolvedValue(response({ error: code }, status));
      await expect(createTransferAPI(fetch).receive(parse(transit), { items: [{ variant_id: 201, actual_quantity: '1' }] }, 'memory'))
        .rejects.toMatchObject({ status, code, uncertainReceipt: false, uncertainCreation: false, uncertainDecision: false, uncertainDispatch: false });
    });
  it('pins the sent payload before awaits and treats a different receipt POST outcome as uncertain', async () => {
    let resolve!: (value: Response) => void;
    const fetch = mockFetch().mockReturnValue(new Promise<Response>(yes => { resolve = yes; }));
    const quantities = { items: [{ variant_id: 201, actual_quantity: '1' }] };
    const job = createTransferAPI(fetch).receive(parse(transit), quantities, 'memory');
    quantities.items[0].actual_quantity = '9007199254740993';
    resolve(response(received));
    await expect(job).rejects.toMatchObject({ uncertainReceipt: true, uncertainCreation: false, code: 'invalid_response' });
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ items: [{ variant_id: 201, actual_quantity: '1' }] });
  });
  it.each(['network', 'malformed', 'identity', 'approval', 'dispatch', 'media'] as const)
    ('does not publish or leak uncertain receive %s outcomes', async failure => {
      const fetch = mockFetch().mockImplementation(async () => {
        if (failure === 'network') throw new Error('private SQL');
        if (failure === 'malformed') return response({ private: 'SQL' });
        if (failure === 'media') return new Response(JSON.stringify(received), { headers: { 'Content-Type': 'text/html' } });
        const patch = failure === 'identity' ? { id: '2', reference: 'TR-002' }
          : failure === 'approval' ? { decided_at: '2026-04-03T00:00:00Z' }
          : { dispatched_at: '2026-04-03T00:00:00.000000001Z' };
        return response({ ...received, ...patch });
      });
      const error = await createTransferAPI(fetch).receive(parse(transit), { items: [{ variant_id: 201, actual_quantity: '9007199254740993' }] }, 'memory').catch(error => error);
      expect(error).toMatchObject({ uncertainReceipt: true, uncertainCreation: false, uncertainDecision: false, uncertainDispatch: false });
      expect(String(error)).not.toMatch(/private|SQL/);
    });
  it('admits multiple MaxInt64 actuals by positive existence, never a bounded numeric aggregate', async () => {
    const max = '9223372036854775807';
    const original = { ...transit, items: [1, 201].map(variant_id => ({ ...wire.items[0], variant_id, quantity: max })) };
    const current = { ...received, items: original.items, receipt: { items: [1, 201].map(variant_id => ({
      variant_id, expected_quantity: max, actual_quantity: max, available_quantity: max,
    })), exceptions: [] } };
    const fetch = mockFetch().mockResolvedValue(response(current));
    expect((await createTransferAPI(fetch).receive(parse(original), { items: [201, 1].map(variant_id => ({ variant_id, actual_quantity: max })) }, 'memory')).status).toBe('received');
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ items: [1, 201].map(variant_id => ({ variant_id, actual_quantity: max })) });
  });
  it('rejects malformed receive input before transport', async () => {
    const fetch = mockFetch(); const api = createTransferAPI(fetch);
    for (const items of [[], [{ variant_id: 201, actual_quantity: '0' }], [{ variant_id: 1, actual_quantity: '1' }],
      [{ variant_id: 201, actual_quantity: '01' }], [{ variant_id: 201, actual_quantity: 1 }],
      [{ variant_id: 201, actual_quantity: '9223372036854775808' }],
      [{ variant_id: 201, actual_quantity: '1', actor: 2 }],
      [{ variant_id: 201, actual_quantity: '1' }, { variant_id: 1, actual_quantity: '0' }],
      [{ variant_id: 201, actual_quantity: '1' }, { variant_id: 201, actual_quantity: '1' }]]) {
      await expect(api.receive(parse(transit), { items } as never, 'memory')).rejects.toMatchObject({ code: 'invalid_request', status: null });
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});

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
  it.each([response({ pending_total: '1', action_count: '01' }), response({ pending_total: '1', action_count: '0', secret: 'private' }),
    response({ error: 'private' }, 403), response({ pending_total: '1', action_count: '0' }, 201)])('sanitizes malformed counts and unknown replies', async reply => {
    const fetch = mockFetch().mockResolvedValue(reply.clone());
    await expect(createTransferAPI(fetch).counts()).rejects.toMatchObject({ code: 'invalid_response', uncertainCreation: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('required action filter transport', () => {
  it('captures action selection and verifies exact echo, metadata and pagination', async () => {
    const page = { page: 1, page_size: 25, status: 'all', total_count: '1', records: [wire], requires_action: true, required_actions: { '1': ['approve'] } };
    let resolve!: (reply: Response) => void;
    const fetch = mockFetch().mockReturnValueOnce(new Promise<Response>(yes => { resolve = yes; }));
    const api = createTransferAPI(fetch);
    const query = { status: 'all' as const, requires_action: true };
    const job = api.list(query); query.requires_action = false;
    resolve(response(page));
    expect(await job).toMatchObject({ requires_action: true, required_actions: { '1': ['approve'] } });
    expect(fetch.mock.calls[0][0]).toBe('/api/transfers?page=1&page_size=25&status=all&requires_action=true');
    for (const patch of [{ requires_action: false }, { requires_action: undefined, required_actions: undefined },
      { required_actions: undefined }, { required_actions: { '1': [] } }, { page: 2, records: [], required_actions: {} }, { page_size: 10 }]) {
      fetch.mockResolvedValue(response({ ...page, ...patch }));
      await expect(api.list({ status: 'all', requires_action: true })).rejects.toMatchObject({ code: 'invalid_response', status: 200 });
    }
    fetch.mockResolvedValue(response(page));
    await expect(api.list({ status: 'all' })).rejects.toMatchObject({ code: 'invalid_response' });
    fetch.mockResolvedValue(response({ ...page, requires_action: false, required_actions: { '1': [] } }));
    expect(await api.list({ status: 'all', requires_action: false })).toMatchObject({ requires_action: false });
    expect(fetch.mock.calls.at(-1)?.[0]).toBe('/api/transfers?page=1&page_size=25&status=all');
    expect(fetch.mock.calls.every(([, init]) => init?.method === 'GET' && init.body === undefined)).toBe(true);
  });
});

describe('all transfer filter', () => {
  it('sends explicit all and requires the exact query echo', async () => {
    const page = { page: 1, page_size: 25, status: 'all', total_count: '1', records: [wire] };
    const fetch = mockFetch().mockResolvedValueOnce(response(page))
      .mockResolvedValueOnce(response({ ...page, status: 'pending' }));
    const api = createTransferAPI(fetch);
    expect(await api.list({ status: 'all' })).toMatchObject({ status: 'all', records: [{ status: 'pending' }] });
    expect(fetch.mock.calls[0][0]).toBe('/api/transfers?page=1&page_size=25&status=all');
    await expect(api.list({ status: 'all' })).rejects.toMatchObject({ code: 'invalid_response', status: 200 });
    expect(fetch.mock.calls.every(([, init]) => init?.method === 'GET' && init.body === undefined)).toBe(true);
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
