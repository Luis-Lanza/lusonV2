import { describe, expect, it, vi } from 'vitest';
import { createTransferAPI, RestitutionAPIError, TransferAPIError } from './transferAPI';
import type { RestitutionDecisionInput, RestitutionProposalInput } from './transferRestitutionModel';

const id = '9007199254740993';
const input = (): RestitutionProposalInput => ({ variant_id: 1, operation_key: 'restitution_key_001', expected_revision: '9007199254740993',
  retained_quantity: '9223372036854775807', retained_at_origin: true, reason: '  retained ☃  ' });
const decision = (): RestitutionDecisionInput => ({ variant_id: 1, operation_key: 'restitution_dec_001',
  expected_revision: '9007199254740994', reason: '  confirmed  ' });
const persisted = (action = 'propose') => ({ ...(action === 'propose' ? input() : decision()), request_id: id,
  actor_location_id: action === 'propose' ? 1 : 2, action, retained_quantity: action === 'propose' ? input().retained_quantity : null,
  retained_at_origin: action === 'propose' ? true : null, revision: '9007199254740994',
  source_existing_before: action === 'accept' ? '0' : null, source_existing_after: action === 'accept' ? '9223372036854775807' : null,
  recorded_at: '2026-01-02T03:04:05.000000001Z' });
const empty = () => ({ request_id: id, lines: [{ variant_id: 1, expected_quantity: '5', original_credit: '4', workflow_revision: '0',
  applied_revision: '0', count_generation: '20', count_applied_revision: '3', effective_credit: '4', applied_retained_quantity: '0', proposals: [] }], operations: [] });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const rawResponse = (body: string, status = 200, media = 'application/json') => new Response(body, { status, headers: { 'Content-Type': media } });
const mockFetch = () => vi.fn<typeof globalThis.fetch>();
const call = (fetch: typeof globalThis.fetch, signal?: AbortSignal) => createTransferAPI(fetch).proposeRestitution(id, 1, input(), 'memory', signal);

it('returns exact persisted proposal and sends only the authorized wire payload', async () => {
  const fetch = mockFetch().mockResolvedValue(response(persisted()));
  expect(await call(fetch)).toMatchObject({ request_id: 9007199254740993n, retained_quantity: 9223372036854775807n,
    retained_at_origin: true, reason: input().reason });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual(input());
});

describe('restitution UTF-8 wire admission', () => {
  // Splice bytes into a JSON string without passing malformed input through a string decoder.
  const wireResponse = (body: unknown, bytes?: readonly number[], status = 200) => {
    const text = JSON.stringify(body);
    const marker = 'WIRE_REASON';
    const offset = text.indexOf(marker);
    const encoder = new TextEncoder();
    const wire = bytes === undefined ? encoder.encode(text) : new Uint8Array([
      ...encoder.encode(text.slice(0, offset)), ...bytes, ...encoder.encode(text.slice(offset + marker.length)),
    ]);
    return new Response(wire, { status, headers: { 'Content-Type': 'application/json' } });
  };
  it.each([
    ['invalid lead byte', [0xff], '\uFFFD'],
    ['truncated multibyte', [0xe2, 0x82], '\uFFFD'],
    ['malformed continuation', [0xe2, 0x28, 0xa1], '\uFFFD(\uFFFD'],
  ] as const)('rejects malformed UTF-8 POST %s rather than matching replacement text', async (_name, bytes, reason) => {
    const fetch = mockFetch().mockResolvedValue(wireResponse({ ...persisted(), reason: 'WIRE_REASON' }, bytes));
    await expect(createTransferAPI(fetch).proposeRestitution(id, 1, { ...input(), reason }, 'memory'))
      .rejects.toMatchObject({ name: 'RestitutionAPIError', code: 'invalid_response', status: 200, uncertainRestitution: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['  literal \uFFFD  ', '  retained ☃ 😀 e\u0301  '])('preserves canonical UTF-8 POST reason %s exactly', async reason => {
    const fetch = mockFetch().mockResolvedValue(wireResponse({ ...persisted(), reason }));
    expect(await createTransferAPI(fetch).proposeRestitution(id, 1, { ...input(), reason }, 'memory'))
      .toMatchObject({ reason, retained_quantity: 9223372036854775807n });
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string).reason).toBe(reason);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([true, false])('classifies GET history malformed UTF-8=%s without write uncertainty', async malformed => {
    const body = empty();
    const snapshot = { ...body, lines: [{ ...body.lines[0], workflow_revision: '1', proposals: [{
      revision: '1', operation_key: input().operation_key, initiator_location_id: 1, retained_quantity: '1',
      retained_at_origin: true, base_revision: '0', count_generation: '20', count_applied_revision: '3',
      base_credit: '4', base_restitution: '0', reason: malformed ? 'WIRE_REASON' : '\uFFFD', recorded_at: persisted().recorded_at,
      state: 'pending', decision: null, application: null,
    }] }], operations: [{ ...persisted(), retained_quantity: '1', expected_revision: '0', revision: '1', reason: '\uFFFD' }] };
    const fetch = mockFetch().mockResolvedValue(wireResponse(snapshot, malformed ? [0xff] : undefined));
    const job = createTransferAPI(fetch).restitutions(id, { passive: true });
    if (malformed) await expect(job)
      .rejects.toMatchObject({ name: 'RestitutionAPIError', code: 'invalid_response', status: 200, uncertainRestitution: false });
    else expect(await job).toMatchObject({ operations: [{ reason: '\uFFFD' }] });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1]?.method).toBe('GET');
  });
  it.each(['GET', 'POST'] as const)('rejects malformed UTF-8 %s error envelope before server-code admission', async method => {
    const fetch = mockFetch().mockResolvedValue(wireResponse({ error: 'WIRE_REASON' }, [0xe2, 0x82], 400));
    const api = createTransferAPI(fetch);
    await expect(method === 'GET' ? api.restitutions(id) : call(fetch))
      .rejects.toMatchObject({ name: 'RestitutionAPIError', code: 'invalid_response', status: 400,
        uncertainRestitution: method === 'POST' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['GET', 'POST'] as const)('keeps %s body-read abort separate from malformed bytes', async method => {
    const reply = wireResponse(empty());
    vi.spyOn(reply, 'arrayBuffer').mockRejectedValue(new DOMException('body read aborted', 'AbortError'));
    const fetch = mockFetch().mockResolvedValue(reply);
    await expect(method === 'GET' ? createTransferAPI(fetch).restitutions(id) : call(fetch))
      .rejects.toMatchObject({ name: 'RestitutionAPIError', code: 'aborted', status: null, uncertainRestitution: method === 'POST' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('admits a canonical UTF-8 error envelope as definitive', async () => {
    const fetch = mockFetch().mockResolvedValue(wireResponse({ error: 'invalid_request' }, undefined, 400));
    await expect(call(fetch)).rejects.toMatchObject({ code: 'invalid_request', status: 400, uncertainRestitution: false });
  });
});

describe('additive restitution transport', () => {
  it('captures payload/scalar actor/key/revision/CSRF synchronously before deferred response', async () => {
    let resolve!: (value: Response) => void;
    const fetch = mockFetch().mockReturnValueOnce(new Promise<Response>(yes => { resolve = yes; })).mockResolvedValue(response(persisted()));
    const original = input(); const api = createTransferAPI(fetch); const signal = new AbortController().signal;
    let actor = 1; let route = id; let csrf = 'memory';
    const job = api.proposeRestitution(route, actor, original, csrf, signal);
    actor = 2; route = '1'; csrf = 'changed';
    Object.assign(original, { operation_key: 'changed_key_00001', expected_revision: '1', retained_quantity: '1',
      retained_at_origin: false, reason: 'changed', variant_id: 2 });
    resolve(response(persisted()));
    const op = await job;
    expect(Object.isFrozen(op)).toBe(true);
    expect(op.actor_location_id).toBe(1);
    expect(await api.proposeRestitution(id, 1, input(), 'memory', signal)).toEqual(op);
    for (const args of fetch.mock.calls) expect(args).toEqual([`/api/transfers/${id}/restitutions/propose`, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'memory' },
      body: JSON.stringify({ variant_id: 1, operation_key: input().operation_key, expected_revision: input().expected_revision,
        reason: input().reason, retained_quantity: input().retained_quantity, retained_at_origin: true }),
    }]);
    expect(fetch.mock.calls[0][1]?.body).not.toContain('actor_location_id');
    expect([actor, route, csrf]).toEqual([2, '1', 'changed']);
  });
  it.each(['accept', 'reject'] as const)('sends exact four-member %s and captures reason before await', async action => {
    let resolve!: (value: Response) => void;
    const fetch = mockFetch().mockReturnValue(new Promise<Response>(yes => { resolve = yes; }));
    const original = decision();
    const job = createTransferAPI(fetch).decideRestitution(id, 2, action, original, 'memory');
    Object.assign(original, { reason: 'changed', expected_revision: '2', operation_key: 'changed_key_00001' });
    resolve(response(persisted(action)));
    expect(await job).toMatchObject({ action, retained_quantity: null, retained_at_origin: null, reason: decision().reason });
    expect(fetch.mock.calls).toEqual([[`/api/transfers/${id}/restitutions/${action}`, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: undefined,
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'memory' }, body: JSON.stringify(decision()),
    }]]);
  });
  it.each([{ request_id: '1' }, { variant_id: 2 }, { actor_location_id: 2 }, { operation_key: 'different_key_0001' },
    { expected_revision: '9007199254740992', revision: '9007199254740993' }, { reason: 'retained ☃' },
    { retained_quantity: '1' }, { retained_quantity: null }, { retained_at_origin: null }, { retained_at_origin: false },
    { action: 'reject', retained_quantity: null, retained_at_origin: null, expected_revision: '9007199254740994' }, { revision: '1' }])
    ('marks mismatched 200 proposal as restitution-only uncertainty %j', async patch => {
      const fetch = mockFetch().mockResolvedValue(response({ ...persisted(), ...patch }));
      const error = await call(fetch).catch(error => error);
      expect(error).toBeInstanceOf(RestitutionAPIError);
      expect(error).not.toBeInstanceOf(TransferAPIError);
      expect(error).toMatchObject({ code: 'invalid_response', status: 200, uncertainRestitution: true });
      expect(error).not.toHaveProperty('uncertainCreation');
      expect(error).not.toHaveProperty('uncertainCorrection');
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  it.each(['accept', 'reject'] as const)('rejects mismatched persisted %s result without fallback calls', async action => {
    for (const patch of [{ retained_quantity: '1' }, { retained_at_origin: true }, { reason: 'confirmed' },
      { actor_location_id: 1 }, { action: action === 'accept' ? 'reject' : 'accept' }]) {
      const fetch = mockFetch().mockResolvedValue(response({ ...persisted(action), ...patch }));
      await expect(createTransferAPI(fetch).decideRestitution(id, 2, action, decision(), 'memory'))
        .rejects.toMatchObject({ code: 'invalid_response', uncertainRestitution: true });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });
  it('returns historical acceptance stock evidence without reading current inventory', async () => {
    const fetch = mockFetch().mockResolvedValue(response(persisted('accept')));
    const op = await createTransferAPI(fetch).decideRestitution(id, 2, 'accept', decision(), 'memory');
    expect(op).toMatchObject({ source_existing_before: 0n, source_existing_after: 9223372036854775807n });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe(`/api/transfers/${id}/restitutions/accept`);
  });
  it.each(['network', 'abort', 'read', 'empty', 'json', 'media', 'schema', '503', 'unknownStatus', 'duplicate', 'escapedDuplicate', 'private'] as const)
    ('sanitizes ambiguous POST %s with no retry/history/session fanout', async mode => {
      const fetch = mockFetch().mockImplementation(async () => {
        if (mode === 'network') throw new Error('PRIVATE SQL');
        if (mode === 'abort') throw new DOMException('PRIVATE SQL', 'AbortError');
        if (mode === 'read') { const reply = response(persisted()); vi.spyOn(reply, 'arrayBuffer').mockRejectedValue(new Error('PRIVATE SQL')); return reply; }
        if (mode === 'empty') return rawResponse('');
        if (mode === 'json') return rawResponse('{PRIVATE');
        if (mode === 'media') return rawResponse('PRIVATE', 400, 'text/html');
        if (mode === '503') return response({ error: 'service_unavailable' }, 503);
        if (mode === 'unknownStatus') return response({ error: 'invalid_request' }, 500);
        if (mode === 'duplicate') return rawResponse('{"error":"invalid_request","error":"invalid_request"}', 400);
        if (mode === 'escapedDuplicate') return rawResponse('{"error":"invalid_request","err\\u006fr":"invalid_request"}', 400);
        return response({ ...persisted(), ...(mode === 'private' ? { private_history: 'PRIVATE SQL' } : { retained_quantity: 1 }) });
      });
      const error = await call(fetch).catch(error => error);
      expect(error).toBeInstanceOf(RestitutionAPIError);
      expect(error).toMatchObject({ uncertainRestitution: true });
      expect(String(error)).not.toMatch(/PRIVATE|SQL/);
      expect(Object.values(error)).not.toContain('PRIVATE SQL');
      expect(error).not.toHaveProperty('uncertainCreation');
      if (mode === 'abort') expect(error.code).toBe('aborted');
      if (mode === 'network' || mode === 'read') expect(error.code).toBe('network');
      if (mode === '503') expect(error).toMatchObject({ code: 'service_unavailable', status: 503 });
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  it.each(['accept', 'reject'] as const)('keeps %s failure classification separate from proposal/creation and GET', async action => {
    for (const [status, code, uncertainRestitution] of [[400, 'invalid_request', false], [403, 'forbidden', false],
      [404, 'not_found', false], [409, 'decision_conflict', false], [503, 'service_unavailable', true]] as const) {
      const fetch = mockFetch().mockResolvedValue(response({ error: code }, status));
      await expect(createTransferAPI(fetch).decideRestitution(id, 2, action, decision(), 'memory'))
        .rejects.toMatchObject({ code, status, uncertainRestitution });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
    const fetch = mockFetch().mockRejectedValue(new DOMException('PRIVATE SQL', 'AbortError'));
    await expect(createTransferAPI(fetch).decideRestitution(id, 2, action, decision(), 'memory'))
      .rejects.toMatchObject({ code: 'aborted', uncertainRestitution: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('retains write uncertainty when aborted signal causes a generic transport failure', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(call(mockFetch().mockRejectedValue(new Error()), controller.signal)).rejects.toMatchObject({
      code: 'aborted', status: null, uncertainRestitution: true,
    });
  });
  it.each([[400, 'invalid_request'], [403, 'forbidden'], [404, 'not_found'], [409, 'retry_conflict'],
    [409, 'decision_conflict'], [409, 'insufficient_stock'], [401, 'unauthenticated'], [405, 'method_not_allowed']] as const)
    ('maps exact backend %s/%s as definitive for this invocation', async (status, code) => {
      const fetch = mockFetch().mockResolvedValue(response({ error: code }, status));
      await expect(call(fetch)).rejects.toMatchObject({ code, status, uncertainRestitution: false });
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  it.each([[400, 'retry_conflict'], [409, 'invalid_request'], [503, 'not_found'], [201, 'service_unavailable'],
    [409, 'unknown_failure'], [403, 'unauthenticated']] as const)
    ('does not trust incorrect error status/code %s/%s', async (status, code) => {
      await expect(call(mockFetch().mockResolvedValue(response({ error: code }, status))))
        .rejects.toMatchObject({ code: 'invalid_response', uncertainRestitution: true });
    });
  it.each([null, [], {}, { error: null }, { error: 1 }, { error: 'invalid_request', detail: 'PRIVATE' }])
    ('requires closed noncoercing error envelope %j', async body => {
      await expect(call(mockFetch().mockResolvedValue(response(body, 400))))
        .rejects.toMatchObject({ code: 'invalid_response', uncertainRestitution: true });
    });
  it('reads private history passively with no mutation headers and captures options before await', async () => {
    let resolve!: (value: Response) => void;
    const fetch = mockFetch().mockReturnValueOnce(new Promise<Response>(yes => { resolve = yes; })).mockResolvedValue(response(empty()));
    const options = { signal: new AbortController().signal, passive: true };
    const api = createTransferAPI(fetch); const job = api.restitutions(id, options);
    options.passive = false;
    resolve(response(empty()));
    expect(await job).toMatchObject({ request_id: BigInt(id), operations: [] });
    expect(fetch.mock.calls[0]).toEqual([`/api/transfers/${id}/restitutions`, {
      method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: options.signal, headers: { 'X-Luson-Passive': '1' },
    }]);
    await api.restitutions(id);
    expect(fetch.mock.calls[1][1]).toEqual({ method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: undefined, headers: {} });
    expect(fetch.mock.calls.every(([, init]) => init?.body === undefined)).toBe(true);
  });
  it.each(['network', 'abort', 'read', '503', 'wrongID', 'malformed', 'partial', 'media', 'duplicate'] as const)
    ('keeps GET %s failure distinct from write certainty', async mode => {
      const fetch = mockFetch().mockImplementation(async () => {
        if (mode === 'network') throw new Error('PRIVATE SQL');
        if (mode === 'abort') throw new DOMException('PRIVATE SQL', 'AbortError');
        if (mode === 'read') { const reply = response(empty()); vi.spyOn(reply, 'arrayBuffer').mockRejectedValue(new Error('PRIVATE SQL')); return reply; }
        if (mode === '503') return response({ error: 'service_unavailable' }, 503);
        if (mode === 'wrongID') return response({ ...empty(), request_id: '1' });
        if (mode === 'malformed') return rawResponse('{');
        if (mode === 'media') return rawResponse('{}', 200, 'text/plain');
        if (mode === 'duplicate') return rawResponse(JSON.stringify(empty()).replace('"request_id":', '"request_id":"1","request_id":'));
        return response({ ...empty(), operations: [persisted()] });
      });
      const error = await createTransferAPI(fetch).restitutions(id).catch(error => error);
      expect(error).toBeInstanceOf(RestitutionAPIError);
      expect(error).toMatchObject({ uncertainRestitution: false });
      if (mode === 'network' || mode === 'read') expect(error).toMatchObject({ code: 'network', status: null });
      if (mode === 'abort') expect(error).toMatchObject({ code: 'aborted', status: null });
      expect(String(error)).not.toMatch(/PRIVATE|SQL/);
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  it('rejects invalid route/actor/CSRF/action and exact payload locally before any network', async () => {
    const fetch = mockFetch(); const api = createTransferAPI(fetch);
    for (const badID of ['0', '01', '1/accept', '1?x=1', '9223372036854775808']) {
      await expect(api.proposeRestitution(badID, 1, input(), 'memory')).rejects.toMatchObject({ code: 'invalid_request', uncertainRestitution: false });
      await expect(api.restitutions(badID)).rejects.toBeInstanceOf(RestitutionAPIError);
    }
    for (const actor of [0, 4, 1.5, '1']) await expect(api.proposeRestitution(id, actor as number, input(), 'memory')).rejects.toMatchObject({ code: 'invalid_request' });
    for (const csrf of ['', 'bad token', 'x\r\ny']) await expect(api.proposeRestitution(id, 1, input(), csrf)).rejects.toMatchObject({ code: 'invalid_request' });
    for (const action of ['approve', 'propose', null]) await expect(api.decideRestitution(id, 2, action as never, decision(), 'memory')).rejects.toMatchObject({ code: 'invalid_request' });
    for (const patch of [{ retained_at_origin: false }, { retained_quantity: 1 }, { expected_revision: 0 }, { reason: '' },
      { base_revision: '0' }, { actor_location_id: 1 }]) {
      await expect(api.proposeRestitution(id, 1, { ...input(), ...patch } as never, 'memory')).rejects.toMatchObject({ code: 'invalid_request', uncertainRestitution: false });
    }
    for (const patch of [{ retained_quantity: '1' }, { retained_at_origin: true }, { reason: undefined }, { reason: '' }]) {
      await expect(api.decideRestitution(id, 2, 'accept', { ...decision(), ...patch } as never, 'memory')).rejects.toMatchObject({ code: 'invalid_request' });
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
