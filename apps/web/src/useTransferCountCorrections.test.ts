import { StrictMode, createElement } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseSession } from './model';
import { TransferAPIError } from './transferAPI';
import { captureCountCorrections, createTransferCountCorrectionRecovery } from './transferCountCorrectionRecovery';
import { useTransferCountCorrections, type TransferCountCorrectionsOptions } from './useTransferCountCorrections';
import { useInventory, type TransferAuthority, type TransferController } from './useInventory';
import { useTransfers } from './useTransfers';
import { decisionOwner } from './transferDecisionRecovery';
import { pageJSON } from './test-fixtures';
import type { CountCorrections, CountOperation } from './transferCountCorrectionModel';
const id = '9007199254740993';
const locations = [{ id: 1, name: 'Warehouse' }, { id: 2, name: 'Branch A' }, { id: 3, name: 'Branch B' }];
const input = { variant_id: 201, operation_key: 'stable_count_key_01', expected_revision: '0', actual_quantity: '5', reason: ' original reason ' };
const stamp = '2026-04-02T00:00:00Z';
const network = () => new TransferAPIError('network', null, false, false, false, false, false, true);
function session() {
  return { authenticated: true, csrf_token: 'c'.repeat(43), identity: { account_id: 2, username: 'account-2', location: locations[1] }, expires_at: '2030-01-01T00:00:00Z' };
}
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
}
function op(action: 'propose' | 'accept' | 'reject' = 'propose', variant = 201): CountOperation {
  return { request_id: BigInt(id), variant_id: variant, operation_key: input.operation_key, actor_location_id: 2, action,
    expected_revision: action === 'propose' ? 0n : 1n, actual_quantity: action === 'propose' ? 5n : null,
    reason: input.reason, revision: 1n, recorded_at: stamp };
}
function history(head = 0n, operations: CountOperation[] = []): CountCorrections {
  return captureCountCorrections({ request_id: BigInt(id), operations, lines: [201, 202].map(variant_id => ({ variant_id,
    expected_quantity: 6n, actual_quantity: 6n, available_quantity: 6n, workflow_revision: head,
    applied_revision: 0n, effective_actual: 6n, effective_credit: 6n, proposals: [] })) });
}
function fixture() {
  const authority: TransferAuthority = { epoch: 1, ready: true, session: parseSession(JSON.stringify(session())), sessionGeneration: 1 };
  const listeners = new Set<() => void>();
  const controller: TransferController = { authorityEpoch: 1, getTransferAuthority: () => authority,
    subscribeTransferInvalidation: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    settleUnauthorized: vi.fn(async () => 'unavailable' as const), countCorrectionRecovery: createTransferCountCorrectionRecovery(),
    confirmTransferCountCorrection: vi.fn() };
  const api = { countCorrections: vi.fn(async () => history()), proposeCount: vi.fn(async () => op()), decideCount: vi.fn(async () => op('accept')) };
  const options: TransferCountCorrectionsOptions = { controller, requestID: id, api };
  const mount = (strict = false) => renderHook((props: TransferCountCorrectionsOptions) => useTransferCountCorrections(props), {
    initialProps: options, ...(strict ? { wrapper: ({ children }: { children: React.ReactNode }) => createElement(StrictMode, null, children) } : {}) });
  return { authority, controller, api, options, mount, hint: () => { for (const listener of listeners) listener(); } };
}
async function loaded(result: { current: ReturnType<typeof useTransferCountCorrections> }) {
  await waitFor(() => expect(result.current.snapshot?.request_id).toBe(BigInt(id)));
}
afterEach(() => { vi.unstubAllGlobals(); });

it('auto and realtime reads are passive, manual refresh is active, and never POST on resume', async () => {
  const f = fixture(); const h = f.mount(); await loaded(h.result);
  expect(f.api.countCorrections.mock.calls[0]).toEqual([id, expect.objectContaining({ passive: true })]);
  await act(async () => { await h.result.current.refresh(); });
  expect(f.api.countCorrections.mock.calls.at(-1)).toEqual([id, expect.objectContaining({ passive: false })]);
  await act(async () => { f.hint(); });
  expect(f.api.countCorrections.mock.calls.at(-1)).toEqual([id, expect.objectContaining({ passive: true })]);
  h.rerender({ ...f.options, enabled: false }); expect(h.result.current.snapshot).toBeNull();
  h.rerender(f.options); await loaded(h.result);
  expect(f.api.proposeCount).not.toHaveBeenCalled(); expect(f.api.decideCount).not.toHaveBeenCalled(); h.unmount();
});
it('captures original retry evidence synchronously, despite mutated form fields', async () => {
  const f = fixture(); const first = deferred<CountOperation>(); f.api.proposeCount.mockImplementationOnce(() => first.promise);
  const h = f.mount(); await loaded(h.result); const form = { ...input };
  let promise!: Promise<void>;
  act(() => { promise = h.result.current.propose(form); }); form.reason = 'new reason'; form.expected_revision = '8';
  await act(async () => { first.reject(network()); await promise; });
  expect(h.result.current.attempts[0].phase).toBe('uncertain');
  await act(async () => { await h.result.current.retry(201); });
  const calls = f.api.proposeCount.mock.calls as unknown[][];
  expect(calls[0].slice(0, 4)).toEqual([id, 2, input, session().csrf_token]);
  expect(calls[1].slice(0, 4)).toEqual(calls[0].slice(0, 4));
  expect(h.result.current.attempts[0].phase).toBe('confirmed'); expect(f.controller.confirmTransferCountCorrection).toHaveBeenCalledTimes(1); h.unmount();
});
it('independent lines retain uncertainty and unmount aborts flights without destroying controller memory', async () => {
  const f = fixture(); const a = deferred<CountOperation>(); const b = deferred<CountOperation>();
  f.api.proposeCount.mockImplementationOnce(() => a.promise).mockImplementationOnce(() => b.promise);
  const h = f.mount(); await loaded(h.result); let pa!: Promise<void>; let pb!: Promise<void>;
  act(() => { pa = h.result.current.propose(input); pb = h.result.current.propose({ ...input, variant_id: 202 }); });
  h.unmount();
  const calls = f.api.proposeCount.mock.calls as unknown[][];
  expect((calls[0][4] as AbortSignal).aborted).toBe(true); expect((calls[1][4] as AbortSignal).aborted).toBe(true);
  const again = f.mount(); await loaded(again.result);
  expect(again.result.current.attempts.map(a => a.phase)).toEqual(['uncertain', 'uncertain']);
  expect(f.api.proposeCount).toHaveBeenCalledTimes(2);
  await act(async () => { a.resolve(op()); b.resolve(op('propose', 202)); await Promise.all([pa, pb]); });
  expect(f.controller.confirmTransferCountCorrection).not.toHaveBeenCalled();
  expect(again.result.current.attempts.map(a => a.phase)).toEqual(['uncertain', 'uncertain']); again.unmount();
});
it('old token after remount cannot settle a new retry of the same line', async () => {
  const f = fixture(); const old = deferred<CountOperation>(); const fresh = deferred<CountOperation>();
  f.api.proposeCount.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => fresh.promise);
  const h = f.mount(); await loaded(h.result); let p!: Promise<void>;
  act(() => { p = h.result.current.propose(input); }); h.unmount();
  const again = f.mount(); await loaded(again.result); let retry!: Promise<void>;
  act(() => { retry = again.result.current.retry(201); });
  await act(async () => { old.resolve(op()); await p; }); expect(again.result.current.attempts[0].phase).toBe('inFlight');
  await act(async () => { fresh.resolve(op()); await retry; });
  expect(f.controller.confirmTransferCountCorrection).toHaveBeenCalledTimes(1); again.unmount();
});
it.each(['accept', 'reject'] as const)('historical %s confirmation does not depend on current proposal state', async action => {
  const f = fixture(); f.api.decideCount.mockRejectedValueOnce(network());
  const h = f.mount(); await loaded(h.result);
  await act(async () => { await h.result.current.decide(action, { variant_id: 201, operation_key: input.operation_key, expected_revision: '1', reason: input.reason }); });
  const historical = history(9n, [op(action)]);
  // Later superseded/rejected proposals are separate evidence from this operation.
  const withProposals = captureCountCorrections({ ...historical, lines: historical.lines.map(line => ({ ...line, proposals: [{
    revision: 9n, operation_key: 'later_proposal_key', initiator_location_id: 1, actual_quantity: 4n, base_revision: 8n,
    base_credit: 6n, reason: 'later evidence', recorded_at: stamp, state: 'rejected', application: null,
    decision: { operation_key: 'later_decision_key', actor_location_id: 2, accepted: false, reason: 'later rejection', recorded_at: stamp },
  }] })) });
  f.api.countCorrections.mockResolvedValue(withProposals);
  await act(async () => { await h.result.current.recover(201); });
  expect(h.result.current.attempts[0].phase).toBe('confirmed');
  await act(async () => { await h.result.current.refresh(); });
  expect(f.controller.confirmTransferCountCorrection).toHaveBeenCalledTimes(1); h.unmount();
});
it('coalesces dirty hints, suppresses stale snapshots but permits exact immutable confirmation', async () => {
  const f = fixture(); const read = deferred<CountCorrections>();
  const h = f.mount(); await loaded(h.result); f.api.proposeCount.mockRejectedValueOnce(network());
  await act(async () => { await h.result.current.propose(input); });
  f.api.countCorrections.mockImplementationOnce(() => read.promise).mockResolvedValue(history(8n));
  act(() => { f.hint(); f.hint(); f.hint(); });
  expect(f.api.countCorrections).toHaveBeenCalledTimes(2);
  await act(async () => { read.resolve(history(4n, [op()])); await read.promise; });
  await waitFor(() => expect(f.api.countCorrections).toHaveBeenCalledTimes(3));
  expect(h.result.current.snapshot?.lines[0].workflow_revision).toBe(8n);
  expect(h.result.current.attempts[0].phase).toBe('confirmed');
  expect(f.controller.confirmTransferCountCorrection).toHaveBeenCalledTimes(1); h.unmount();
});
it('dirty missing-operation head never infers a stale conflict before the coalesced read', async () => {
  const f = fixture(); const dirty = deferred<CountCorrections>(); const next = deferred<CountCorrections>();
  const h = f.mount(); await loaded(h.result); f.api.proposeCount.mockRejectedValueOnce(network());
  await act(async () => { await h.result.current.propose(input); });
  f.api.countCorrections.mockImplementationOnce(() => dirty.promise).mockImplementationOnce(() => next.promise);
  act(() => { f.hint(); f.hint(); });
  await act(async () => { dirty.resolve(history(10n)); await dirty.promise; });
  expect(h.result.current.attempts[0].phase).toBe('uncertain'); expect(h.result.current.snapshot?.lines[0].workflow_revision).toBe(0n);
  await act(async () => { next.resolve(history(2n)); await next.promise; });
  expect(h.result.current.attempts[0].phase).toBe('conflict'); expect(f.api.proposeCount).toHaveBeenCalledTimes(1); h.unmount();
});
it.each([403, 404])('private %s masks read and write retry until explicit recovery, across remount', async status => {
  const f = fixture(); const h = f.mount(); await loaded(h.result); f.api.proposeCount.mockRejectedValueOnce(network());
  await act(async () => { await h.result.current.propose(input); });
  f.api.countCorrections.mockRejectedValueOnce(new TransferAPIError(status === 403 ? 'forbidden' : 'not_found', status));
  await act(async () => { await h.result.current.refresh(); });
  expect(h.result.current.snapshot).toBeNull(); expect(h.result.current.attempts).toEqual([]); expect(h.result.current.masked).toBe(true);
  await act(async () => { await h.result.current.retry(201); await h.result.current.propose({ ...input, operation_key: 'fresh_count_key_02' }); });
  h.unmount(); const again = f.mount();
  await waitFor(() => expect(f.api.countCorrections).toHaveBeenCalledTimes(3));
  expect(again.result.current.snapshot).toBeNull(); expect(again.result.current.masked).toBe(true);
  await act(async () => { await again.result.current.recover(201); });
  expect(again.result.current.masked).toBe(false); expect(again.result.current.attempts[0].phase).toBe('uncertain');
  await act(async () => { await again.result.current.retry(201); });
  expect(f.api.proposeCount).toHaveBeenCalledTimes(2); again.unmount();
});
it.each([403, 404])('private POST %s masks the request without exposing prior history', async status => {
  const f = fixture(); const h = f.mount(); await loaded(h.result);
  f.api.proposeCount.mockRejectedValueOnce(new TransferAPIError(status === 403 ? 'forbidden' : 'not_found', status));
  await act(async () => { await h.result.current.propose(input); });
  expect(h.result.current.masked).toBe(true); expect(h.result.current.snapshot).toBeNull(); expect(h.result.current.attempts).toEqual([]);
  await act(async () => { await h.result.current.retry(201); f.hint(); });
  expect(f.api.proposeCount).toHaveBeenCalledTimes(1); expect(h.result.current.snapshot).toBeNull(); h.unmount();
});
it.each(['read', 'write'] as const)('401 %s settlement is authority fenced', async lane => {
  const f = fixture(); const h = f.mount(); await loaded(h.result);
  const error = new TransferAPIError('unauthenticated', 401);
  if (lane === 'read') { f.api.countCorrections.mockRejectedValueOnce(error); await act(async () => { await h.result.current.refresh(); }); }
  else { f.api.proposeCount.mockRejectedValueOnce(error); await act(async () => { await h.result.current.propose(input); }); }
  expect(f.controller.settleUnauthorized).toHaveBeenCalledWith(1); expect(f.controller.settleUnauthorized).toHaveBeenCalledTimes(1); h.unmount();
});
describe('obsolete transports and callbacks', () => {
  it.each(['account', 'location', 'epoch', 'generation'] as const)('hides on %s mutation and does not resurrect old evidence', async field => {
    const f = fixture(); const pending = deferred<CountOperation>(); f.api.proposeCount.mockImplementationOnce(() => pending.promise);
    const h = f.mount(); await loaded(h.result); const old = h.result.current; let p!: Promise<void>;
    act(() => { p = old.propose(input); });
    const original = structuredClone(f.authority);
    if (field === 'epoch') f.authority.epoch++;
    else if (field === 'generation') f.authority.sessionGeneration!++;
    else if (f.authority.session?.authenticated) {
      if (field === 'account') f.authority.session.identity.account_id++;
      else f.authority.session.identity.location.id = 1;
    }
    expect(old.attempts).toEqual([]); expect(old.snapshot).toBeNull();
    h.rerender(f.options);
    await act(async () => { pending.resolve(op()); await p; await old.retry(201); await old.propose(input); });
    expect(f.controller.confirmTransferCountCorrection).not.toHaveBeenCalled();
    Object.assign(f.authority, original); h.rerender(f.options);
    expect(h.result.current.attempts).toEqual([]); expect(f.api.proposeCount).toHaveBeenCalledTimes(1); h.unmount();
  });
  it.each(['request', 'controller', 'api', 'disabled', 'null', 'notready'] as const)('rejects late ignored-abort %s responses and captured callbacks', async change => {
    const f = fixture(); const pendingRead = deferred<CountCorrections>(); const pendingWrite = deferred<CountOperation>();
    f.api.countCorrections.mockImplementationOnce(() => pendingRead.promise); f.api.proposeCount.mockImplementationOnce(() => pendingWrite.promise);
    const h = f.mount(); const old = h.result.current; let p!: Promise<void>;
    act(() => { p = old.propose(input); });
    const options = { ...f.options };
    if (change === 'request') options.requestID = '2';
    if (change === 'controller') options.controller = { ...f.controller, countCorrectionRecovery: createTransferCountCorrectionRecovery() };
    if (change === 'api') options.api = { ...f.api };
    if (change === 'disabled') options.enabled = false;
    if (change === 'null') options.requestID = null;
    if (change === 'notready') f.authority.ready = false;
    h.rerender(options);
    await act(async () => { pendingRead.resolve(history()); pendingWrite.resolve(op()); await Promise.all([pendingRead.promise, p]); await old.propose(input); await old.refresh(); });
    expect(f.controller.confirmTransferCountCorrection).not.toHaveBeenCalled(); expect(f.api.proposeCount).toHaveBeenCalledTimes(1);
    expect((f.api.countCorrections.mock.calls as unknown[][])[0][1]).toEqual(expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(((f.api.countCorrections.mock.calls as unknown[][])[0][1] as { signal: AbortSignal }).signal.aborted).toBe(true); h.unmount();
  });
});
it('validates injected responses losslessly and rejects actor/payload mismatches as uncertain', async () => {
  const f = fixture(); const h = f.mount(); await loaded(h.result);
  f.api.proposeCount.mockResolvedValueOnce({ ...op(), request_id: Number(id) } as unknown as CountOperation);
  await act(async () => { await h.result.current.propose(input); });
  expect(h.result.current.attempts[0].phase).toBe('uncertain'); expect(f.controller.confirmTransferCountCorrection).not.toHaveBeenCalled();
  f.api.proposeCount.mockResolvedValueOnce({ ...op(), reason: 'different reason' });
  await act(async () => { await h.result.current.retry(201); });
  expect(h.result.current.attempts[0].phase).toBe('uncertain');
  f.api.countCorrections.mockResolvedValueOnce({ ...history(), request_id: Number(id) } as unknown as CountCorrections);
  await act(async () => { await h.result.current.refresh(); });
  expect(h.result.current.snapshot).toBeNull(); expect(h.result.current.error?.code).toBe('invalid_response'); h.unmount();
});
it('strict mount cleanup does not confirm or auto-write retained attempts', async () => {
  const f = fixture(); const owner = decisionOwner(f.authority)!;
  const token = f.controller.countCorrectionRecovery!.start(id, 'propose', input, owner)!;
  f.controller.countCorrectionRecovery!.release(token);
  const h = f.mount(true); await loaded(h.result);
  expect(h.result.current.attempts[0].phase).toBe('uncertain'); expect(f.api.proposeCount).not.toHaveBeenCalled();
  expect(f.controller.confirmTransferCountCorrection).not.toHaveBeenCalled(); h.unmount();
});

it.each([400, 409])('a later definite %s response cannot erase a prior uncertain write', async status => {
  const f = fixture(); const h = f.mount(); await loaded(h.result);
  f.api.proposeCount.mockRejectedValueOnce(network()).mockRejectedValueOnce(new TransferAPIError(status === 400 ? 'invalid_request' : 'decision_conflict', status));
  await act(async () => { await h.result.current.propose(input); await h.result.current.retry(201); });
  expect(h.result.current.attempts[0].phase).toBe('uncertain');
  await act(async () => { await h.result.current.propose({ ...input, operation_key: 'replacement_key_01' }); });
  expect(f.api.proposeCount).toHaveBeenCalledTimes(2);
  f.api.countCorrections.mockResolvedValue(history(1n, [op()]));
  await act(async () => { await h.result.current.recover(201); });
  expect(h.result.current.attempts[0].phase).toBe('confirmed'); h.unmount();
});
it.each(['network', 'aborted', 'invalid_response', 'service_unavailable'] as const)('retains uncertainty after injected %s failures', async code => {
  const f = fixture(); const h = f.mount(); await loaded(h.result);
  f.api.proposeCount.mockRejectedValueOnce(new TransferAPIError(code, code === 'service_unavailable' ? 503 : code === 'invalid_response' ? 400 : null));
  await act(async () => { await h.result.current.propose(input); });
  expect(h.result.current.attempts[0].phase).toBe('uncertain');
  expect(h.result.current.attempts[0].priorUncertainty).toBe(true); h.unmount();
});
it('passive history can confirm a live write exactly once before an ignored-abort POST returns', async () => {
  const f = fixture(); const pending = deferred<CountOperation>(); f.api.proposeCount.mockImplementationOnce(() => pending.promise);
  const h = f.mount(); await loaded(h.result); let p!: Promise<void>;
  act(() => { p = h.result.current.propose(input); });
  f.api.countCorrections.mockResolvedValue(history(3n, [op()]));
  await act(async () => { f.hint(); });
  expect(h.result.current.attempts[0].phase).toBe('confirmed');
  await act(async () => { pending.resolve(op()); await p; });
  expect(f.controller.confirmTransferCountCorrection).toHaveBeenCalledTimes(1); h.unmount();
});
it('obsolete read rejection cannot report errors or settle unauthorized on a new request', async () => {
  const f = fixture(); const pending = deferred<CountCorrections>(); f.api.countCorrections.mockImplementationOnce(() => pending.promise);
  const h = f.mount(); h.rerender({ ...f.options, requestID: null });
  await act(async () => { pending.reject(new TransferAPIError('unauthenticated', 401)); await pending.promise.catch(() => {}); });
  expect(h.result.current.error).toBeNull(); expect(f.controller.settleUnauthorized).not.toHaveBeenCalled(); h.unmount();
});
it('masked GET cancels concurrent writes and ignores their late responses', async () => {
  const f = fixture(); const pending = deferred<CountOperation>(); f.api.proposeCount.mockImplementationOnce(() => pending.promise);
  const h = f.mount(); await loaded(h.result); let p!: Promise<void>;
  act(() => { p = h.result.current.propose(input); });
  f.api.countCorrections.mockRejectedValueOnce(new TransferAPIError('forbidden', 403));
  await act(async () => { await h.result.current.refresh(); });
  expect(((f.api.proposeCount.mock.calls as unknown[][])[0][4] as AbortSignal).aborted).toBe(true);
  await act(async () => { pending.resolve(op()); await p; });
  expect(h.result.current.attempts).toEqual([]); expect(f.controller.confirmTransferCountCorrection).not.toHaveBeenCalled(); h.unmount();
});
it('disabled, null and unavailable initial authority do not issue reads or writes', async () => {
  const f = fixture(); const h = renderHook((props: TransferCountCorrectionsOptions) => useTransferCountCorrections(props), {
    initialProps: { ...f.options, enabled: false },
  });
  await act(async () => { await h.result.current.refresh(); await h.result.current.propose(input); });
  expect(f.api.countCorrections).not.toHaveBeenCalled();
  h.rerender({ ...f.options, enabled: true, requestID: null });
  await act(async () => { await h.result.current.refresh(); });
  f.authority.ready = false; h.rerender({ ...f.options, enabled: true });
  await act(async () => { await h.result.current.propose(input); });
  expect(f.api.countCorrections).not.toHaveBeenCalled(); expect(f.api.proposeCount).not.toHaveBeenCalled();
  expect(h.result.current.busy).toBe(false); expect(h.result.current.attempts).toEqual([]); h.unmount();
});
it('a scalar authority mutation followed by return without rerender retires evidence when observed', async () => {
  const f = fixture(); const h = f.mount(); await loaded(h.result); f.api.proposeCount.mockRejectedValueOnce(network());
  await act(async () => { await h.result.current.propose(input); });
  f.authority.sessionGeneration!++;
  expect(h.result.current.attempts).toEqual([]);
  f.authority.sessionGeneration!--;
  expect(h.result.current.attempts).toEqual([]); h.unmount();
});
it('retains uncertainty with optional recovery and confirmation seams omitted', async () => {
  const f = fixture(); delete f.controller.countCorrectionRecovery; delete f.controller.confirmTransferCountCorrection;
  const h = f.mount(); await loaded(h.result); f.api.proposeCount.mockRejectedValueOnce(network());
  await act(async () => { await h.result.current.propose(input); await h.result.current.retry(201); });
  expect(h.result.current.attempts[0].phase).toBe('confirmed'); h.unmount();
});

class Source {
  static instances: Source[] = [];
  readyState = 0;
  listeners = new Map<string, Set<EventListener>>();
  constructor(public url: string) { Source.instances.push(this); }
  close() { this.readyState = 2; }
  addEventListener(kind: string, listener: EventListener) {
    const set = this.listeners.get(kind) ?? new Set(); set.add(listener); this.listeners.set(kind, set);
  }
  removeEventListener(kind: string, listener: EventListener) { this.listeners.get(kind)?.delete(listener); }
}
const reply = (value: unknown) => new Response(JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? item.toString() : item), {
  status: 200, headers: { 'Content-Type': 'application/json' },
});
function realFixture() {
  Source.instances = []; vi.stubGlobal('EventSource', Source);
  const fetch = vi.fn(async (url: RequestInfo | URL) => {
    const path = String(url);
    if (path === '/api/auth/session') return reply(session());
    if (path === '/api/inventory/metadata') return reply({ locations, brands: ['TOYO'] });
    if (path.startsWith('/api/inventory?')) return new Response(pageJSON().replace('"location":{"id":1,"name":"Almacén"}', '"location":' + JSON.stringify(locations[1])), { status: 200 });
    if (path.startsWith('/api/transfers?')) return reply({ page: 1, page_size: 25, status: 'pending', total_count: '0', records: [] });
    throw new Error('Unexpected route');
  });
  vi.stubGlobal('fetch', fetch); return fetch;
}
it.each(['propose', 'reject', 'accept'] as const)('real controller confirms %s: refreshes transfer readers, accept alone refreshes inventory/source', async action => {
  const fetch = realFixture(); const source = vi.fn();
  const api = { countCorrections: vi.fn(async () => history()), proposeCount: vi.fn(async () => op()), decideCount: vi.fn(async () => op(action === 'accept' ? 'accept' : 'reject')) };
  const h = renderHook(() => {
    const controller = useInventory(); const transfers = useTransfers({ controller, listEnabled: true });
    const corrections = useTransferCountCorrections({ controller, requestID: id, api }); return { controller, transfers, corrections };
  });
  await waitFor(() => expect(h.result.current.controller.data).not.toBeNull());
  await waitFor(() => expect(h.result.current.transfers.page?.total_count).toBe(0n));
  await waitFor(() => expect(h.result.current.corrections.snapshot).not.toBeNull());
  const unsubscribe = h.result.current.controller.subscribeSourceInventoryInvalidation(source);
  const lists = () => fetch.mock.calls.filter(([url]) => String(url).startsWith('/api/transfers?')).length;
  const inventory = () => fetch.mock.calls.filter(([url]) => String(url).startsWith('/api/inventory?')).length;
  const beforeList = lists(); const beforeInventory = inventory();
  await act(async () => {
    if (action === 'propose') await h.result.current.corrections.propose(input);
    else await h.result.current.corrections.decide(action, { variant_id: 201, operation_key: input.operation_key, expected_revision: '1', reason: input.reason });
  });
  await waitFor(() => expect(lists()).toBe(beforeList + 1));
  expect(source).toHaveBeenCalledTimes(action === 'accept' ? 1 : 0);
  expect(inventory()).toBe(beforeInventory + (action === 'accept' ? 1 : 0));
  await act(async () => { await h.result.current.corrections.refresh(); });
  expect(lists()).toBe(beforeList + 1); unsubscribe(); h.unmount();
});
it.each(['csrf_token', 'expires_at', 'username', 'location_name'] as const)('real controller fences in-place session %s changes before a render', async field => {
  realFixture(); const pending = deferred<CountOperation>();
  const api = { countCorrections: vi.fn(async () => history()), proposeCount: vi.fn(() => pending.promise), decideCount: vi.fn(async () => op('accept')) };
  const h = renderHook(() => {
    const controller = useInventory();
    return { controller, corrections: useTransferCountCorrections({ controller, requestID: id, api }) };
  });
  await waitFor(() => expect(h.result.current.corrections.snapshot).not.toBeNull());
  const owner = decisionOwner(h.result.current.controller.getTransferAuthority())!;
  const source = vi.fn(); const transfers = vi.fn();
  const offSource = h.result.current.controller.subscribeSourceInventoryInvalidation(source);
  const offTransfers = h.result.current.controller.subscribeTransferInvalidation(transfers);
  let p!: Promise<void>; act(() => { p = h.result.current.corrections.propose(input); });
  const session = h.result.current.controller.session;
  if (!session?.authenticated) throw new Error('Expected authenticated fixture');
  if (field === 'csrf_token') session.csrf_token = 'd'.repeat(43);
  if (field === 'expires_at') session.expires_at = '2031-01-01T00:00:00Z';
  if (field === 'username') session.identity.username = 'different-account';
  if (field === 'location_name') session.identity.location.name = 'Renamed branch';
  expect(h.result.current.corrections.snapshot).toBeNull(); expect(h.result.current.corrections.attempts).toEqual([]);
  expect(decisionOwner(h.result.current.controller.getTransferAuthority())!.generation).toBeGreaterThan(owner.generation);
  await act(async () => { pending.resolve(op()); await p; });
  expect(source).not.toHaveBeenCalled(); expect(transfers).not.toHaveBeenCalled(); offSource(); offTransfers(); h.unmount();
});
it('real controller rechecks owner after transfer subscribers and rejects mismatched actors', async () => {
  realFixture(); const source = vi.fn();
  const h = renderHook(() => useInventory());
  await waitFor(() => expect(h.result.current.data).not.toBeNull());
  const owner = decisionOwner(h.result.current.getTransferAuthority())!;
  const unsubscribeSource = h.result.current.subscribeSourceInventoryInvalidation(source);
  const unsubscribeTransfer = h.result.current.subscribeTransferInvalidation(() => {
    const session = h.result.current.session; if (session?.authenticated) session.identity.account_id++;
  });
  act(() => { h.result.current.confirmTransferCountCorrection(owner, { ...op('accept'), actor_location_id: 1 }); });
  expect(source).not.toHaveBeenCalled();
  act(() => { h.result.current.confirmTransferCountCorrection(owner, op('accept')); });
  expect(source).not.toHaveBeenCalled(); expect(decisionOwner(h.result.current.getTransferAuthority())).not.toEqual(owner);
  unsubscribeSource(); unsubscribeTransfer(); h.unmount();
});
