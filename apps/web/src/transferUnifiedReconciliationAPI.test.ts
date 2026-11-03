import { describe, expect, it, vi } from 'vitest';
import { createUnifiedReconciliationAPI } from './transferUnifiedReconciliationAPI';
import { unifiedAgreement, unifiedFixture, wire } from './transferUnifiedReconciliationFixtures';
describe('unified intent transport', () => {
  const input = { variant_id: 1, operation_key: 'unified-proposal-0001', expected_revision: '0', dispatch_quantity: '4', arrival_quantity: '3', retained_quantity: '1', retained_at_origin: true, reason: 'verified' };
  it('posts exact captured intent and validates operation identity', async () => {
    const f = unifiedAgreement(); const op = f.raw.operations[0];
    const payload = { ...input, reason: String(op.reason) };
    const fetch = vi.fn().mockResolvedValue(new Response(wire({ schema: 'luson.transfer-reconciliation-operation/v2', operation: op }), { headers: { 'Content-Type': 'application/json' } }));
    const api = createUnifiedReconciliationAPI(fetch);
    const result = await api.propose(f.record, 1, payload, 'csrf-token');
    expect(result.dispatch_quantity).toBe(4n);
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/transfers/123/unified-reconciliations/propose', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: undefined,
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'csrf-token' }, body: JSON.stringify({ variant_id: payload.variant_id, operation_key: payload.operation_key, expected_revision: payload.expected_revision, retained_at_origin: payload.retained_at_origin, reason: payload.reason, dispatch_quantity: payload.dispatch_quantity, arrival_quantity: payload.arrival_quantity, retained_quantity: payload.retained_quantity }),
    });
  });
  it.each(['network', 'aborted', 'invalid_response', 'service_unavailable'])('keeps %s writes uncertain without retry', async code => {
    const fetch = vi.fn();
    if (code === 'network' || code === 'aborted') fetch.mockRejectedValue(code === 'aborted' ? new DOMException('Abort', 'AbortError') : new Error());
    else fetch.mockResolvedValue(new Response(code === 'service_unavailable' ? '{"error":"service_unavailable"}' : '{}', { status: code === 'service_unavailable' ? 503 : 200, headers: { 'Content-Type': 'application/json' } }));
    await expect(createUnifiedReconciliationAPI(fetch).propose(unifiedFixture().record, 1, input, 'csrf-token')).rejects.toMatchObject({ code, uncertainReconciliation: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['actor', 'extra', 'quantity', 'attestation'])('rejects invalid local %s without POST', async kind => {
    const fetch = vi.fn(); const payload = { ...input };
    if (kind === 'extra') Object.assign(payload, { accept: true });
    if (kind === 'quantity') payload.dispatch_quantity = '04';
    if (kind === 'attestation') Object.assign(payload, { retained_at_origin: 'true' });
    await expect(createUnifiedReconciliationAPI(fetch).propose(unifiedFixture().record, kind === 'actor' ? 3 : 1, payload, 'csrf-token')).rejects.toMatchObject({ code: 'invalid_request', uncertainReconciliation: false });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('preserves private no-store passive GET with captured receipt', async () => {
    const f = unifiedFixture(); const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(wire(f.raw), { headers: { 'Content-Type': 'application/json' } }));
    const api = createUnifiedReconciliationAPI(fetch); const signal = new AbortController().signal;
    const result = await api.read(f.record, { passive: true, signal });
    expect(result.request_id).toBe(123n); expect(Object.keys(api)).toEqual(['read', 'propose', 'decide']);
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/transfers/123/unified-reconciliations', {
      method: 'GET', credentials: 'same-origin', cache: 'no-store', signal, headers: { 'X-Luson-Passive': '1' },
    });
  });
  it.each([401, 403, 404, 405, 409, 503])('maps admitted error/status %s', async status => {
    const codes: Record<number, string> = { 401: 'unauthenticated', 403: 'forbidden', 404: 'not_found', 405: 'method_not_allowed', 409: 'decision_conflict', 503: 'service_unavailable' };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(wire({ error: codes[status] }), { status, headers: { 'Content-Type': 'application/json' } }));
    await expect(createUnifiedReconciliationAPI(fetch).read(unifiedFixture().record)).rejects.toMatchObject({ code: codes[status], status });
  });
  it.each(['content-type', 'utf8', 'schema', 'error-status'])('rejects malformed %s', async kind => {
    const f = unifiedFixture();
    const response = kind === 'utf8' ? new Response(new Uint8Array([255]), { headers: { 'Content-Type': 'application/json' } })
      : new Response(kind === 'error-status' ? '{"error":"forbidden"}' : kind === 'schema' ? '{}' : wire(f.raw), {
        status: kind === 'error-status' ? 404 : 200, headers: { 'Content-Type': kind === 'content-type' ? 'text/plain' : 'application/json' },
      });
    await expect(createUnifiedReconciliationAPI(vi.fn().mockResolvedValue(response)).read(f.record)).rejects.toMatchObject({ code: 'invalid_response' });
  });
  it.each(['network', 'aborted'])('classifies %s without a retry', async code => {
    const fetch = vi.fn().mockRejectedValue(code === 'aborted' ? new DOMException('Abort', 'AbortError') : new Error('offline'));
    await expect(createUnifiedReconciliationAPI(fetch).read(unifiedFixture().record)).rejects.toMatchObject({ code, status: null });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects invalid local context before fetch', async () => {
    const f = unifiedFixture(); Object.assign(f.record, { id: '01' }); const fetch = vi.fn();
    await expect(createUnifiedReconciliationAPI(fetch).read(f.record)).rejects.toMatchObject({ code: 'invalid_request', status: null });
    expect(fetch).not.toHaveBeenCalled();
  });
});
