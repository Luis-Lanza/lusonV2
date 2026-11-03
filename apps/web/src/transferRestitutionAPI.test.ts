import { describe, expect, it, vi } from 'vitest';
import { createTransferAPI, RestitutionAPIError } from './transferAPI';

const id = '9007199254740993';
const input = () => ({ variant_id: 1, operation_key: 'restitution_key_001', expected_revision: '9007199254740993',
  retained_quantity: '9223372036854775807', retained_at_origin: true, reason: '  retained ☃  ' });
const persisted = () => ({ ...input(), request_id: id, actor_location_id: 1, action: 'propose',
  revision: '9007199254740994', source_existing_before: null, source_existing_after: null,
  recorded_at: '2026-01-02T03:04:05.000000001Z' });
const empty = () => ({ request_id: id, lines: [{ variant_id: 1, expected_quantity: '5', effective_dispatch: '5', reconciliation_revision: '0', original_credit: '4', workflow_revision: '0',
  applied_revision: '0', count_generation: '20', count_applied_revision: '3', effective_credit: '4', applied_retained_quantity: '0', proposals: [] }], operations: [] });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const rawResponse = (body: string, status = 200, media = 'application/json') => new Response(body, { status, headers: { 'Content-Type': media } });
const mockFetch = () => vi.fn<typeof globalThis.fetch>();

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
  it.each([true, false])('classifies GET history malformed UTF-8=%s without write uncertainty', async malformed => {
    const body = empty();
    const snapshot = { ...body, lines: [{ ...body.lines[0], workflow_revision: '1', proposals: [{
      revision: '1', operation_key: input().operation_key, initiator_location_id: 1, retained_quantity: '1',
      retained_at_origin: true, base_revision: '0', count_generation: '20', count_applied_revision: '3',
      base_dispatch: '5', base_credit: '4', base_restitution: '0', reason: malformed ? 'WIRE_REASON' : '\uFFFD', recorded_at: persisted().recorded_at,
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
  it('rejects a malformed UTF-8 GET error envelope before server-code admission', async () => {
    const fetch = mockFetch().mockResolvedValue(wireResponse({ error: 'WIRE_REASON' }, [0xe2, 0x82], 400));
    await expect(createTransferAPI(fetch).restitutions(id))
      .rejects.toMatchObject({ name: 'RestitutionAPIError', code: 'invalid_response', status: 400,
        uncertainRestitution: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('keeps GET body-read abort separate from malformed bytes', async () => {
    const reply = wireResponse(empty());
    vi.spyOn(reply, 'arrayBuffer').mockRejectedValue(new DOMException('body read aborted', 'AbortError'));
    const fetch = mockFetch().mockResolvedValue(reply);
    await expect(createTransferAPI(fetch).restitutions(id))
      .rejects.toMatchObject({ name: 'RestitutionAPIError', code: 'aborted', status: null, uncertainRestitution: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('restitution history transport', () => {
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
      expect(error).not.toHaveProperty('uncertainCorrection');
      if (mode === 'network' || mode === 'read') expect(error).toMatchObject({ code: 'network', status: null });
      if (mode === 'abort') expect(error).toMatchObject({ code: 'aborted', status: null });
      expect(String(error)).not.toMatch(/PRIVATE|SQL/);
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  it('rejects invalid history route identifiers locally before any network', async () => {
    const fetch = mockFetch(); const api = createTransferAPI(fetch);
    for (const badID of ['0', '01', '1/accept', '1?x=1', '9223372036854775808']) {
      await expect(api.restitutions(badID)).rejects.toBeInstanceOf(RestitutionAPIError);
      await expect(api.restitutions(badID))
        .rejects.toMatchObject({ code: 'invalid_request', status: null, uncertainRestitution: false });
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
