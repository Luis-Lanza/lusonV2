import { describe, expect, it, vi } from 'vitest';
import { createDispatchReconciliationAPI, DispatchReconciliationAPIError, normalizeDispatchReconciliationProposal } from './transferDispatchReconciliationAPI';
import type { TransferRecord } from './transferModel';
const stamp = '2026-01-02T12:00:00Z';
function fixture() {
  const record: TransferRecord = { id: '123', reference: 'TR-123', kind: 'direct_shipment', status: 'received', created_at: stamp,
    creator_location_id: 1, creator_location_name: 'Warehouse', origin_location_id: 1, origin_location_name: 'Warehouse',
    destination_location_id: 2, destination_location_name: 'Branch', approver_location_id: 1, approver_location_name: 'Warehouse',
    decision_location_id: 1, decided_at: stamp, dispatch_location_id: 1, dispatched_at: stamp, receipt_location_id: 2, received_at: stamp,
    items: [{ variant_id: 1, quantity: 5n, brand: 'Brand', model: 'Model', capacity_ah: '60', polarity: 'L' }],
    receipt: { items: [{ variant_id: 1, expected_quantity: 5n, actual_quantity: 7n, available_quantity: 5n }],
      exceptions: [{ variant_id: 1, kind: 'excess', quantity: 2n }] } };
  const input = { variant_id: 1, operation_key: 'dispatch-proposal-0001', expected_revision: '0', dispatch_quantity: '7', reason: ' verified ' };
  const op = { ...input, request_id: '123', actor_location_id: 1, action: 'propose', revision: '1',
    source_existing_before: null as string | null, source_existing_after: null as string | null,
    destination_existing_before: null as string | null, destination_existing_after: null as string | null, recorded_at: stamp };
  const snapshot = { request_id: '123', lines: [{ variant_id: 1, expected_quantity: '5', actual_quantity: '7', available_quantity: '5',
    effective_dispatch: '5', effective_actual: '7', effective_credit: '5', applied_retained_quantity: '0', workflow_revision: '0', applied_revision: '0',
    count_generation: '0', count_applied_revision: '0', restitution_generation: '0', reconciliation_generation: '0', proposals: [] }], operations: [] };
  return { record, input, op, snapshot };
}
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
function transport(reply: () => Promise<Response>) {
  const fetch = vi.fn<typeof globalThis.fetch>((_input, _init) => reply());
  return { fetch, api: createDispatchReconciliationAPI(fetch) };
}
async function failure(promise: Promise<unknown>, code: string, status: number | null, uncertain: boolean) {
  await expect(promise).rejects.toMatchObject({ name: 'DispatchReconciliationAPIError', code, status, uncertainReconciliation: uncertain, message: code });
}
describe('dispatch reconciliation additive transport', () => {
  it('captures received context and passive read options before awaiting', async () => {
    const f = fixture(); let release!: (r: Response) => void;
    const { api, fetch } = transport(() => new Promise(resolve => { release = resolve; }));
    const controller = new AbortController(); const options = { passive: true, signal: controller.signal };
    const pending = api.read(f.record, options);
    f.record.id = '124'; f.record.items[0].quantity = 9n; options.passive = false;
    release(response(f.snapshot));
    expect((await pending).request_id).toBe(123n);
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/transfers/123/dispatch-reconciliations', {
      method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: controller.signal, headers: { 'X-Luson-Passive': '1' } });
  });
  it.each(['0', '9007199254740993', '9223372036854775807'])('posts exact proposal quantity %s without a current eligibility gate', async quantity => {
    const f = fixture(); f.input.dispatch_quantity = quantity; f.op.dispatch_quantity = quantity;
    const before = structuredClone(f); const { api, fetch } = transport(async () => response(f.op));
    expect((await api.propose(f.record, 1, f.input, 'csrf-token')).dispatch_quantity).toBe(BigInt(quantity));
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/transfers/123/dispatch-reconciliations/propose', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: undefined,
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'csrf-token' }, body: expect.any(String) });
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual(f.input);
    expect(f).toEqual(before); expect(Object.isFrozen(normalizeDispatchReconciliationProposal(f.input))).toBe(true);
  });
  it.each(['accept', 'reject'] as const)('posts exact %s with null operation quantity and no quantity body', async action => {
    const f = fixture(); const { dispatch_quantity: _quantity, ...input } = f.input; input.expected_revision = '1';
    const op = { ...f.op, ...input, action, actor_location_id: 2, dispatch_quantity: null,
      ...(action === 'accept' ? { source_existing_before: '15', source_existing_after: '13', destination_existing_before: '15', destination_existing_after: '17' } : {}) };
    const { api, fetch } = transport(async () => response(op));
    expect((await api.decide(f.record, 2, action, input, 'csrf')).dispatch_quantity).toBeNull();
    expect(fetch.mock.calls[0]).toEqual([`/api/transfers/123/dispatch-reconciliations/${action}`, expect.objectContaining({ body: JSON.stringify(input) })]);
  });
  it('freezes original record and exact attempt against caller mutation during await', async () => {
    const f = fixture(); const original = structuredClone(f.op); let release!: (r: Response) => void;
    const { api } = transport(() => new Promise(resolve => { release = resolve; }));
    const pending = api.propose(f.record, 1, f.input, 'csrf');
    f.input.reason = 'changed'; f.input.operation_key = 'another-key-000000'; f.record.id = '124'; f.record.items[0].variant_id = 2;
    release(response(original)); expect((await pending).reason).toBe(' verified ');
  });
  it('admits historical operations after later count state, without comparing quantity to receipt', async () => {
    const f = fixture(); f.input.dispatch_quantity = '6'; f.op.dispatch_quantity = '6';
    const { api } = transport(async () => response(f.op));
    expect((await api.propose(f.record, 1, f.input, 'csrf')).dispatch_quantity).toBe(6n);
  });
  it.each(['request_id', 'variant_id', 'actor_location_id', 'action', 'operation_key', 'expected_revision', 'reason', 'dispatch_quantity'])('rejects mismatched success %s as uncertain', async field => {
    const f = fixture(); const op = { ...f.op };
    const changes: Record<string, unknown> = { request_id: '124', variant_id: 2, actor_location_id: 2, action: 'reject', operation_key: 'another-key-000000', expected_revision: '1', reason: 'other', dispatch_quantity: '8' };
    Object.assign(op, { [field]: changes[field] });
    const { api } = transport(async () => response(op));
    await failure(api.propose(f.record, 1, f.input, 'csrf'), 'invalid_response', 200, true);
  });
  it.each(['actor', 'csrf', 'record', 'variant', 'extra', 'actual_quantity', 'revision', 'quantity', 'key', 'reason', 'action'])('rejects local %s before fetch', async kind => {
    const f = fixture(); let actor = 1; let csrf = 'csrf';
    if (kind === 'actor') actor = 3;
    if (kind === 'csrf') csrf = '';
    if (kind === 'record') f.record.id = '0123';
    if (kind === 'variant') f.input.variant_id = 2;
    if (kind === 'extra') Object.assign(f.input, { actor_location_id: 1 });
    if (kind === 'actual_quantity') Object.assign(f.input, { actual_quantity: '7' });
    if (kind === 'revision') f.input.expected_revision = '9223372036854775807';
    if (kind === 'quantity') f.input.dispatch_quantity = '01';
    if (kind === 'key') f.input.operation_key = 'short';
    if (kind === 'reason') f.input.reason = '\0';
    const before = structuredClone(f); const { api, fetch } = transport(async () => response(f.op));
    const pending = kind === 'action' ? api.decide(f.record, actor, 'bad' as 'accept', f.input, csrf) : api.propose(f.record, actor, f.input, csrf);
    await failure(pending, 'invalid_request', null, false); expect(fetch).not.toHaveBeenCalled(); expect(f).toEqual(before);
  });
  it.each([400, 401, 403, 404, 405, 409, 503])('classifies recognized error status %s', async status => {
    const codes: Record<number, string> = { 400: 'invalid_request', 401: 'unauthenticated', 403: 'forbidden', 404: 'not_found', 405: 'method_not_allowed', 409: 'decision_conflict', 503: 'service_unavailable' };
    const f = fixture(); const { api } = transport(async () => response({ error: codes[status] }, status));
    await failure(api.propose(f.record, 1, f.input, 'csrf'), codes[status], status, status === 503);
    await failure(api.read(f.record), codes[status], status, false);
  });
  it.each(['network', 'abort', 'body'])('classifies %s loss without claiming rollback', async kind => {
    const f = fixture(); const { api } = transport(async () => {
      if (kind === 'network') throw new Error('private');
      if (kind === 'abort') throw new DOMException('private', 'AbortError');
      const r = response(f.op); r.arrayBuffer = async () => { throw new Error('private'); }; return r;
    });
    await failure(api.propose(f.record, 1, f.input, 'csrf'), kind === 'abort' ? 'aborted' : 'network', null, true);
    await failure(api.read(f.record), kind === 'abort' ? 'aborted' : 'network', null, false);
  });
  it.each(['unknown', 'duplicate', 'utf8', 'media', 'error-extra', 'error-duplicate', 'error-code', 'status'])('rejects invalid %s evidence for writes and reads', async kind => {
    const f = fixture(); let raw: BodyInit = JSON.stringify(f.op); let status = 200; let media = 'application/json';
    if (kind === 'unknown') raw = JSON.stringify({ ...f.op, extra: true });
    if (kind === 'duplicate') raw = raw.replace('"request_id":"123"', '"request_id":"123","request_id":"123"');
    if (kind === 'utf8') raw = new Uint8Array([0xff]);
    if (kind === 'media') media = 'text/plain';
    if (kind.startsWith('error')) { status = 409; raw = kind === 'error-extra' ? '{"error":"retry_conflict","extra":true}' : kind === 'error-duplicate' ? '{"error":"retry_conflict","error":"retry_conflict"}' : '{"error":"forbidden"}'; }
    if (kind === 'status') status = 201;
    const { api } = transport(async () => new Response(raw, { status, headers: { 'Content-Type': media } }));
    await failure(api.propose(f.record, 1, f.input, 'csrf'), 'invalid_response', status, true);
    await failure(api.read(f.record), 'invalid_response', status, false);
  });
  it('reads a coordinated later count snapshot retaining historical proposal evidence', async () => {
    const f = fixture();
    const proposal = { revision: '1', operation_key: f.input.operation_key, initiator_location_id: 1, dispatch_quantity: '7',
      base_dispatch: '5', base_actual: '7', base_credit: '5', count_generation: '0', restitution_generation: '0',
      reconciliation_generation: '0', reason: f.input.reason, recorded_at: stamp, state: 'pending', decision: null, application: null };
    const snapshot = { ...f.snapshot, operations: [f.op], lines: [{ ...f.snapshot.lines[0], proposals: [proposal],
      workflow_revision: '1', count_generation: '2', count_applied_revision: '1', effective_actual: '6', effective_credit: '5', reconciliation_generation: '1' }] };
    const { api, fetch } = transport(async () => response(snapshot));
    const result = await api.read(f.record);
    expect(result.lines[0].effective_actual).toBe(6n); expect(result.operations[0].dispatch_quantity).toBe(7n);
    expect(fetch.mock.calls[0][1]).toMatchObject({ headers: {}, credentials: 'same-origin', cache: 'no-store' });
  });
  it.each(['retry_conflict', 'insufficient_stock'])('admits definitive 409 %s', async code => {
    const f = fixture(); const { api } = transport(async () => response({ error: code }, 409));
    await failure(api.propose(f.record, 1, f.input, 'csrf'), code, 409, false);
  });
  it('rejects proposal-only quantity in decisions before fetch', async () => {
    const f = fixture(); const { api, fetch } = transport(async () => response(f.op));
    await failure(api.decide(f.record, 2, 'reject', f.input, 'csrf'), 'invalid_request', null, false);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('exports the dedicated typed error without token or payload detail', () => {
    expect(new DispatchReconciliationAPIError('invalid_request', null).message).toBe('invalid_request');
  });
});
