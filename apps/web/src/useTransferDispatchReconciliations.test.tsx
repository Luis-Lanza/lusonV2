import { act, fireEvent, render, renderHook, waitFor, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { parseSession } from './model';
import type { TransferAuthority, TransferController } from './useInventory';
import type { DispatchReconciliationOperation, DispatchReconciliations } from './transferDispatchReconciliationModel';
import { DispatchReconciliationAPIError } from './transferDispatchReconciliationAPI';
import { createTransferDispatchReconciliationStore } from './transferDispatchReconciliationStore';
import { useTransferDispatchReconciliations, type TransferDispatchReconciliationsOptions } from './useTransferDispatchReconciliations';
import { appliedSnapshot, decisionKey, deferred, fixture, operationKey, wire } from './transferDispatchReconciliationStoreFixtures';
function setup(location = 1, pending = false) {
  const f = fixture(pending);
  const authority: TransferAuthority = { epoch: 1, ready: true, sessionGeneration: 1, session: parseSession(JSON.stringify({ authenticated: true,
    csrf_token: 'a'.repeat(43), identity: { account_id: 1, username: 'operator', location: { id: location, name: 'Location' } }, expires_at: '2030-01-01T00:00:00Z' })) };
  const listeners = new Set<() => void>();
  const controller: TransferController = { authorityEpoch: 1, getTransferAuthority: () => authority,
    subscribeTransferInvalidation: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, settleUnauthorized: vi.fn(async () => 'unavailable' as const) };
  const api = { read: vi.fn(async () => f.decode()), propose: vi.fn<(...args: unknown[]) => Promise<DispatchReconciliationOperation>>(async () => { throw new DispatchReconciliationAPIError('network', null, true); }),
    decide: vi.fn<(...args: unknown[]) => Promise<DispatchReconciliationOperation>>(async () => { throw new DispatchReconciliationAPIError('network', null, true); }) };
  const key = vi.fn((): string => pending ? decisionKey : operationKey); const store = createTransferDispatchReconciliationStore({ operationKey: key }); const onConfirmed = vi.fn();
  const options: TransferDispatchReconciliationsOptions = { controller, record: f.record, api, store, onConfirmed };
  const mount = () => renderHook((props: TransferDispatchReconciliationsOptions) => useTransferDispatchReconciliations(props), { initialProps: options });
  return { ...f, authority, controller, api, key, store, onConfirmed, options, mount, hint: () => { for (const listener of listeners) listener(); } };
}
async function loaded(result: { current: ReturnType<typeof useTransferDispatchReconciliations> }) {
  await waitFor(() => expect(result.current.snapshot?.request_id).toBe(123n));
}
function review(result: { current: ReturnType<typeof useTransferDispatchReconciliations> }, action: 'propose' | 'accept' | 'reject' = 'propose') {
  act(() => { result.current.begin(1, action); result.current.setReason(' verified '); result.current.review(); });
  expect(result.current.reviewState?.attempt.action).toBe(action);
}
it.each(['decision_conflict', 'insufficient_stock'] as const)('fresh definitive %s does not strand a stale pending proposal; only explicit rejection POSTs again', async code => {
  const f = setup(2, true); const h = f.mount(); await loaded(h.result); review(h.result, 'accept');
  f.api.decide.mockRejectedValueOnce(new DispatchReconciliationAPIError(code, 409, false));
  await act(async () => { await h.result.current.confirm(); }); const refused = h.result.current.attempts[0];
  f.raw.lines[0].count_generation = '1'; await act(async () => { await h.result.current.refresh(); });
  expect(f.api.decide).toHaveBeenCalledTimes(1); expect(f.key).toHaveBeenCalledTimes(1); expect(f.onConfirmed).not.toHaveBeenCalled();
  act(() => { expect(h.result.current.begin(1, 'accept')).toBe(false); expect(h.result.current.begin(1, 'reject')).toBe(true); });
  expect(refused).toMatchObject({ phase: 'failed', priorUncertainty: false, result: null, failure: { code, status: 409 } });
  expect(h.result.current.error?.code).toBe(code); f.key.mockReturnValue('dispatch-rejection-0001');
  act(() => { h.result.current.setReason('reject stale proposal'); expect(h.result.current.review()).toBe(true); });
  expect(f.api.decide).toHaveBeenCalledTimes(1);
  await act(async () => { await h.result.current.confirm(); });
  expect(f.api.decide).toHaveBeenCalledTimes(2); expect(f.api.decide.mock.calls.map(c => c.slice(0, 5))).toEqual([
    [f.record, 2, 'accept', { variant_id: 1, operation_key: decisionKey, expected_revision: '1', reason: ' verified ' }, 'a'.repeat(43)],
    [f.record, 2, 'reject', { variant_id: 1, operation_key: 'dispatch-rejection-0001', expected_revision: '1', reason: 'reject stale proposal' }, 'a'.repeat(43)],
  ]);
  expect(f.onConfirmed).not.toHaveBeenCalled(); expect(f.api.propose).not.toHaveBeenCalled(); h.unmount();
});
it.each(['network', 'aborted'] as const)('%s then definitive retry refusal preserves exact POST and blocks replacement until durable proof', async code => {
  const f = setup(2, true); const h = f.mount(); await loaded(h.result); review(h.result, 'accept');
  f.api.decide.mockRejectedValueOnce(new DispatchReconciliationAPIError(code, null, true))
    .mockRejectedValueOnce(new DispatchReconciliationAPIError('decision_conflict', 409, false));
  await act(async () => { await h.result.current.confirm(); }); const original = h.result.current.attempts[0];
  await act(async () => { await h.result.current.retry(1); }); f.raw.lines[0].count_generation = '1';
  await act(async () => { await h.result.current.refresh(); });
  expect(h.result.current.attempts[0]).toMatchObject({ phase: 'uncertain', priorUncertainty: true, result: null, failure: { code: 'decision_conflict' } });
  expect(h.result.current.attempts[0].payload).toBe(original.payload);
  act(() => { expect(h.result.current.begin(1, 'reject')).toBe(false); expect(h.result.current.begin(2, 'propose')).toBe(false); });
  await act(async () => { await h.result.current.confirm(); });
  expect(f.api.decide).toHaveBeenCalledTimes(2); expect(f.api.decide.mock.calls[1].slice(0, 5)).toEqual(f.api.decide.mock.calls[0].slice(0, 5));
  expect(f.key).toHaveBeenCalledTimes(1); expect(f.onConfirmed).not.toHaveBeenCalled();
  const durable = appliedSnapshot(); f.api.read.mockResolvedValue({ ...durable, lines: durable.lines.map(l => l.variant_id !== 1 ? l : { ...l, count_generation: 1n }) });
  await act(async () => { await h.result.current.recover(); });
  expect(h.result.current.attempts[0].phase).toBe('confirmed'); expect(f.onConfirmed).toHaveBeenCalledTimes(1); expect(f.api.decide).toHaveBeenCalledTimes(2); h.unmount();
});
it.each(['read', 'write'] as const)('fresh %s 401 awaiting settlement still masks immediately on unready/new generation and cannot disturb new draft', async lane => {
  const f = setup(2, true); const settlement = deferred<'unavailable'>(); vi.mocked(f.controller.settleUnauthorized).mockImplementationOnce(() => settlement.promise);
  const h = f.mount(); await loaded(h.result); const failure = new DispatchReconciliationAPIError('unauthenticated', 401, false);
  let promise!: Promise<void>;
  if (lane === 'write') { review(h.result, 'accept'); f.api.decide.mockRejectedValueOnce(failure); act(() => { promise = h.result.current.confirm(); }); }
  else { f.api.read.mockRejectedValueOnce(failure); act(() => { promise = h.result.current.refresh(); }); }
  await waitFor(() => expect(f.controller.settleUnauthorized).toHaveBeenCalledWith(1)); const old = h.result.current;
  f.authority.ready = false;
  expect(old.snapshot).toBeNull(); expect(old.draft).toBeNull(); expect(old.reviewState).toBeNull(); expect(old.attempts).toEqual([]); expect(old.error).toBeNull();
  f.authority.sessionGeneration!++; f.authority.ready = true; h.rerender(f.options); await loaded(h.result);
  act(() => { h.result.current.begin(1, 'reject'); h.result.current.setReason('new session reason'); });
  await act(async () => { settlement.resolve('unavailable'); await promise; await old.retry(1); await old.confirm(); });
  expect(h.result.current.draft?.reason).toBe('new session reason'); expect(h.result.current.attempts).toEqual([]); expect(h.result.current.error).toBeNull();
  expect(f.controller.settleUnauthorized).toHaveBeenCalledTimes(1); expect(f.api.decide).toHaveBeenCalledTimes(lane === 'write' ? 1 : 0); expect(f.onConfirmed).not.toHaveBeenCalled(); h.unmount();
});
it.each(['unready', 'account', 'location', 'epoch', 'generation'] as const)('DOM invalidation clears private snapshot/draft on %s without parent rerender or getter polling', async change => {
  const f = setup();
  function Pane() {
    const view = useTransferDispatchReconciliations(f.options);
    return <div><span data-testid="snapshot">{view.snapshot?.request_id.toString() ?? 'none'}</span>
      <span data-testid="reason">{view.draft?.reason ?? 'none'}</span>
      <button onClick={() => { view.begin(1, 'propose'); view.setReason('private DOM reason'); }}>Draft</button></div>;
  }
  const h = render(<Pane />); const dom = within(h.container);
  await waitFor(() => expect(dom.getByTestId('snapshot')).toHaveTextContent('123'));
  fireEvent.click(dom.getByRole('button', { name: 'Draft' })); expect(dom.getByTestId('reason')).toHaveTextContent('private DOM reason');
  // No explicit rerender and no reads of result.current: only the registered invalidation may notify React.
  const nextRead = deferred<DispatchReconciliations>(); f.api.read.mockImplementation(() => nextRead.promise);
  if (change === 'unready') f.authority.ready = false;
  else if (change === 'epoch') f.authority.epoch++;
  else if (change === 'generation') f.authority.sessionGeneration!++;
  else if (f.authority.session?.authenticated) {
    if (change === 'account') f.authority.session.identity.account_id++;
    else f.authority.session.identity.location.id = 2;
  }
  act(() => { f.hint(); });
  expect(dom.getByTestId('reason')).toHaveTextContent('none'); expect(dom.getByTestId('snapshot')).toHaveTextContent('none');
  expect(f.api.propose).not.toHaveBeenCalled(); expect(f.api.decide).not.toHaveBeenCalled(); h.unmount();
});
it.each(['read', 'write'] as const)('current %s 401 masks DOM attempts/data while settlement is deferred and authority has not changed', async lane => {
  const f = setup(); const settlement = deferred<'unavailable'>(); vi.mocked(f.controller.settleUnauthorized).mockImplementationOnce(() => settlement.promise);
  const failure = new DispatchReconciliationAPIError('unauthenticated', 401, false);
  if (lane === 'write') f.api.propose.mockRejectedValueOnce(failure);
  function Pane() {
    const view = useTransferDispatchReconciliations(f.options);
    return <div><span data-testid="snapshot">{view.snapshot?.request_id.toString() ?? 'none'}</span>
      <span data-testid="attempt">{view.attempts[0]?.payload.reason ?? 'none'}</span><span data-testid="masked">{String(view.masked)}</span>
      <button onClick={() => { view.begin(1, 'propose'); view.setReason('private 401 reason'); view.review(); void view.confirm(); }}>Submit</button>
      <button onClick={() => { void view.refresh(); }}>Refresh</button></div>;
  }
  const h = render(<Pane />); const dom = within(h.container);
  await waitFor(() => expect(dom.getByTestId('snapshot')).toHaveTextContent('123')); fireEvent.click(dom.getByRole('button', { name: 'Submit' }));
  if (lane === 'read') {
    await waitFor(() => expect(dom.getByTestId('attempt')).toHaveTextContent('private 401 reason'));
    f.api.read.mockRejectedValueOnce(failure); fireEvent.click(dom.getByRole('button', { name: 'Refresh' }));
  }
  await waitFor(() => expect(f.controller.settleUnauthorized).toHaveBeenCalledWith(1));
  expect(f.authority).toMatchObject({ ready: true, epoch: 1, sessionGeneration: 1 });
  expect(dom.getByTestId('attempt')).toHaveTextContent('none'); expect(dom.getByTestId('snapshot')).toHaveTextContent('none');
  expect(dom.getByTestId('masked')).toHaveTextContent('true'); expect(f.onConfirmed).not.toHaveBeenCalled(); expect(f.api.propose).toHaveBeenCalledTimes(1);
  await act(async () => { settlement.resolve('unavailable'); await settlement.promise; });
  expect(dom.getByTestId('masked')).toHaveTextContent('true');
  fireEvent.click(dom.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(dom.getByTestId('masked')).toHaveTextContent('false'));
  expect(dom.getByTestId('attempt')).toHaveTextContent('private 401 reason'); expect(f.api.propose).toHaveBeenCalledTimes(1); h.unmount();
});
it('observer-only rerender preserves deferred GET/write and notifies only the latest observer in the same authority/scope', async () => {
  const f = setup(); const h = f.mount(); await loaded(h.result); review(h.result);
  const post = deferred<DispatchReconciliationOperation>(); const get = deferred<DispatchReconciliations>(); const observerB = vi.fn();
  f.api.propose.mockImplementationOnce(() => post.promise); f.api.read.mockImplementationOnce(() => get.promise);
  let writing!: Promise<void>; let reading!: Promise<void>;
  act(() => { writing = h.result.current.confirm(); reading = h.result.current.refresh(); });
  const readOptions = (f.api.read.mock.calls as unknown[][])[1][1] as { signal: AbortSignal };
  const writeSignal = f.api.propose.mock.calls[0][4] as AbortSignal;
  h.rerender({ ...f.options, onConfirmed: observerB });
  expect(f.api.read).toHaveBeenCalledTimes(2); expect(readOptions.signal.aborted).toBe(false); expect(writeSignal.aborted).toBe(false);
  expect(h.result.current.attempts[0].phase).toBe('inFlight'); expect(f.api.propose).toHaveBeenCalledTimes(1);
  f.api.read.mockResolvedValue(fixture(true).decode());
  await act(async () => { post.resolve(fixture(true).decode().operations[0]); await writing; });
  expect(observerB).toHaveBeenCalledTimes(1); expect(f.onConfirmed).not.toHaveBeenCalled();
  await act(async () => { get.resolve(f.decode()); await reading; });
  expect(h.result.current.snapshot?.lines[0].workflow_revision).toBe(1n); expect(observerB).toHaveBeenCalledTimes(1);
  expect(f.api.propose).toHaveBeenCalledTimes(1); h.unmount();
});
it('explicit duplicate confirm is single flight; mount, refresh and reopen never POST or allocate a second key', async () => {
  const f = setup(); const pending = deferred<DispatchReconciliationOperation>(); f.api.propose.mockImplementationOnce(() => pending.promise);
  const h = f.mount(); await loaded(h.result); review(h.result);
  let p!: Promise<void>; act(() => { p = h.result.current.confirm(); void h.result.current.confirm(); });
  expect(f.api.propose).toHaveBeenCalledTimes(1); expect(f.key).toHaveBeenCalledTimes(1);
  expect(f.api.propose.mock.calls[0].slice(0, 4)).toEqual([f.record, 1, { variant_id: 1, operation_key: operationKey, expected_revision: '0', reason: ' verified ', dispatch_quantity: '7' }, 'a'.repeat(43)]);
  h.rerender({ ...f.options, enabled: false }); expect(h.result.current.attempts).toEqual([]);
  h.rerender(f.options); await loaded(h.result); expect(h.result.current.attempts[0].phase).toBe('uncertain');
  await act(async () => { pending.resolve(fixture(true).decode().operations[0]); await p; });
  expect(h.result.current.attempts[0].phase).toBe('uncertain'); expect(f.onConfirmed).not.toHaveBeenCalled();
  await act(async () => { await h.result.current.refresh(); }); expect(f.api.propose).toHaveBeenCalledTimes(1); h.unmount();
});
it('exact unknown retry bypasses changed eligibility, uses original payload/target and current same-owner csrf', async () => {
  const f = setup(); const h = f.mount(); await loaded(h.result); review(h.result);
  await act(async () => { await h.result.current.confirm(); }); const first = f.api.propose.mock.calls[0];
  Object.assign(f.raw.lines[0], { count_generation: '2', count_applied_revision: '1', effective_actual: '4', effective_credit: '4' });
  if (!f.authority.session?.authenticated) throw new Error(); f.authority.session.csrf_token = 'b'.repeat(43);
  await act(async () => { await h.result.current.recover(); });
  expect(h.result.current.attempts[0].phase).toBe('uncertain'); expect(h.result.current.begin(1, 'propose')).toBe(false);
  await act(async () => { await h.result.current.retry(1); });
  expect(f.api.propose.mock.calls[1].slice(0, 3)).toEqual(first.slice(0, 3)); expect(f.api.propose.mock.calls[1][3]).toBe('b'.repeat(43));
  expect(wire(h.result.current.attempts)).not.toMatch(/csrf|aaaa|bbbb/); expect(f.key).toHaveBeenCalledTimes(1); h.unmount();
});
it('retains owner-held intent through unmount; stale completion cannot release replacement retry', async () => {
  const f = setup(); const old = deferred<DispatchReconciliationOperation>(); const next = deferred<DispatchReconciliationOperation>();
  f.api.propose.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => next.promise);
  const h = f.mount(); await loaded(h.result); review(h.result); let p!: Promise<void>;
  act(() => { p = h.result.current.confirm(); }); h.unmount();
  const again = f.mount(); await loaded(again.result); expect(again.result.current.attempts[0].phase).toBe('uncertain');
  let retry!: Promise<void>; act(() => { retry = again.result.current.retry(1); });
  await act(async () => { old.resolve(fixture(true).decode().operations[0]); await p; });
  expect(again.result.current.attempts[0].phase).toBe('inFlight'); expect(f.onConfirmed).not.toHaveBeenCalled();
  await act(async () => { next.resolve(fixture(true).decode().operations[0]); await retry; });
  expect(again.result.current.attempts[0].phase).toBe('confirmed'); expect(f.onConfirmed).toHaveBeenCalledTimes(1); again.unmount();
});
it.each(['account', 'location', 'epoch', 'generation', 'unready'] as const)('immediately masks reason/review/snapshot/attempt on %s mutation before rerender', async field => {
  const f = setup(); const h = f.mount(); await loaded(h.result); review(h.result); const old = h.result.current;
  if (field === 'epoch') f.authority.epoch++;
  else if (field === 'generation') f.authority.sessionGeneration!++;
  else if (field === 'unready') f.authority.ready = false;
  else if (f.authority.session?.authenticated) {
    if (field === 'account') f.authority.session.identity.account_id++;
    else f.authority.session.identity.location.id = 2;
  }
  expect(old.snapshot).toBeNull(); expect(old.draft).toBeNull(); expect(old.reviewState).toBeNull(); expect(old.attempts).toEqual([]); expect(old.error).toBeNull();
  await act(async () => { await old.confirm(); await old.retry(1); }); expect(f.api.propose).not.toHaveBeenCalled(); h.unmount();
});
it.each(['success', 'network', '401', '403'] as const)('old owner late %s cannot populate/invalidate the new private session', async outcome => {
  const f = setup(); const pending = deferred<DispatchReconciliationOperation>(); f.api.propose.mockImplementationOnce(() => pending.promise);
  const h = f.mount(); await loaded(h.result); review(h.result); let p!: Promise<void>; const old = h.result.current;
  act(() => { p = old.confirm(); }); f.authority.sessionGeneration!++; h.rerender(f.options); await loaded(h.result);
  act(() => { h.result.current.begin(1, 'propose'); h.result.current.setReason('new owner reason'); });
  await act(async () => {
    if (outcome === 'success') pending.resolve(fixture(true).decode().operations[0]);
    else pending.reject(new DispatchReconciliationAPIError(outcome === 'network' ? 'network' : outcome === '401' ? 'unauthenticated' : 'forbidden', outcome === 'network' ? null : Number(outcome), true));
    await p; await old.retry(1); await old.confirm();
  });
  expect(h.result.current.draft?.reason).toBe('new owner reason'); expect(h.result.current.attempts).toEqual([]); expect(h.result.current.error).toBeNull();
  expect(f.controller.settleUnauthorized).not.toHaveBeenCalled(); expect(f.onConfirmed).not.toHaveBeenCalled(); expect(f.api.propose).toHaveBeenCalledTimes(1); h.unmount();
});
it('equivalent record rerender preserves flight; changed receipt or target masks and blocks old callbacks', async () => {
  const f = setup(); const pending = deferred<DispatchReconciliationOperation>(); f.api.propose.mockImplementationOnce(() => pending.promise);
  const h = f.mount(); await loaded(h.result); review(h.result); let p!: Promise<void>;
  act(() => { p = h.result.current.confirm(); }); const old = h.result.current;
  h.rerender({ ...f.options, record: fixture().record }); expect(h.result.current.attempts[0].phase).toBe('inFlight');
  expect((f.api.propose.mock.calls[0][4] as AbortSignal).aborted).toBe(false);
  h.rerender({ ...f.options, record: { ...f.record, id: '124', reference: 'TR-124' } }); expect(h.result.current.attempts).toEqual([]);
  await act(async () => { await old.retry(1); pending.resolve(fixture(true).decode().operations[0]); await p; });
  expect(f.onConfirmed).not.toHaveBeenCalled(); expect(f.api.propose).toHaveBeenCalledTimes(1);
  h.rerender(f.options); await loaded(h.result); expect(h.result.current.attempts[0].phase).toBe('uncertain');
  const altered = fixture(); if (altered.record.status !== 'received') throw new Error();
  Object.assign(altered.record.receipt.items[0], { actual_quantity: 8n }); Object.assign(altered.record.receipt.exceptions[0], { quantity: 3n });
  h.rerender({ ...f.options, record: altered.record }); expect(h.result.current.attempts).toEqual([]);
  await act(async () => { await h.result.current.retry(1); }); expect(f.api.propose).toHaveBeenCalledTimes(1); h.unmount();
});
it('latest GET ticket wins; late old 401 cannot clear newer controlled draft', async () => {
  const f = setup(); const a = deferred<DispatchReconciliations>(); const b = deferred<DispatchReconciliations>();
  const h = f.mount(); await loaded(h.result); f.api.read.mockImplementationOnce(() => a.promise).mockImplementationOnce(() => b.promise);
  let pa!: Promise<void>; let pb!: Promise<void>; act(() => { pa = h.result.current.refresh(); pb = h.result.current.refresh(); });
  f.raw.lines[1].count_generation = '1'; await act(async () => { b.resolve(f.decode()); await pb; });
  act(() => { h.result.current.begin(1, 'propose'); h.result.current.setReason('latest reason'); });
  await act(async () => { a.reject(new DispatchReconciliationAPIError('unauthenticated', 401)); await pa; });
  expect(h.result.current.snapshot?.lines[1].count_generation).toBe(1n); expect(h.result.current.draft?.reason).toBe('latest reason');
  expect(f.controller.settleUnauthorized).not.toHaveBeenCalled(); h.unmount();
});
it('generation-only selected changes retire review; unrelated variant preserves it; invalidation never POSTs', async () => {
  const f = setup(); const h = f.mount(); await loaded(h.result); review(h.result);
  f.raw.lines[1].count_generation = '1'; await act(async () => { f.hint(); }); expect(h.result.current.reviewState).not.toBeNull();
  f.raw.lines[0].count_generation = '1'; await act(async () => { f.hint(); });
  expect(h.result.current.reviewState).toBeNull(); await act(async () => { await h.result.current.confirm(); });
  expect(f.api.propose).not.toHaveBeenCalled(); expect(f.api.decide).not.toHaveBeenCalled(); h.unmount();
});
it('counterpart acceptance uses captured revision/reason and pure preview, then receives fresh server history', async () => {
  const f = setup(2, true); const h = f.mount(); await loaded(h.result); review(h.result, 'accept');
  expect(h.result.current.reviewState?.preview).toEqual({ dispatch_quantity: 7n, source_delta: -2n, destination_delta: 2n });
  const applied = appliedSnapshot(); f.api.decide.mockResolvedValueOnce(applied.operations[1]); f.api.read.mockResolvedValue(applied);
  await act(async () => { await h.result.current.confirm(); });
  await waitFor(() => expect(h.result.current.snapshot?.lines[0].effective_dispatch).toBe(7n));
  expect(f.api.decide.mock.calls[0].slice(0, 5)).toEqual([f.record, 2, 'accept', { variant_id: 1, operation_key: decisionKey, expected_revision: '1', reason: ' verified ' }, 'a'.repeat(43)]);
  expect(h.result.current.attempts[0].phase).toBe('confirmed'); expect(f.onConfirmed).toHaveBeenCalledTimes(1); expect(f.api.propose).not.toHaveBeenCalled(); h.unmount();
});
it('counterpart stale rejection is allowed without acceptance arithmetic/current pins', async () => {
  const f = setup(2, true); Object.assign(f.raw.lines[0], { count_generation: '2', count_applied_revision: '1', effective_actual: '4', effective_credit: '4', applied_retained_quantity: '1', restitution_generation: '2' });
  const h = f.mount(); await loaded(h.result); expect(h.result.current.begin(1, 'accept')).toBe(false);
  review(h.result, 'reject'); await act(async () => { await h.result.current.confirm(); });
  expect(f.api.decide).toHaveBeenCalledTimes(1); expect(f.api.decide.mock.calls[0].slice(1, 5)).toEqual([2, 'reject',
    { variant_id: 1, operation_key: decisionKey, expected_revision: '1', reason: ' verified ' }, 'a'.repeat(43)]);
  expect(f.api.propose).not.toHaveBeenCalled(); h.unmount();
});
it('third actor and invalid selections cannot create private drafts or POST', async () => {
  const f = setup(3); const h = f.mount(); await loaded(h.result);
  act(() => { expect(h.result.current.begin(1, 'propose')).toBe(false); expect(h.result.current.begin(99, 'propose')).toBe(false); h.result.current.setReason('private'); });
  expect(h.result.current.draft).toBeNull(); await act(async () => { await h.result.current.confirm(); await h.result.current.retry(1); });
  expect(f.key).not.toHaveBeenCalled(); expect(f.api.propose).not.toHaveBeenCalled(); h.unmount();
});
it('forbidden masks intent until explicit recovery, then exact persistence confirms once without POST', async () => {
  const f = setup(); const h = f.mount(); await loaded(h.result); review(h.result); await act(async () => { await h.result.current.confirm(); });
  f.api.read.mockRejectedValueOnce(new DispatchReconciliationAPIError('forbidden', 403)); await act(async () => { await h.result.current.refresh(); });
  expect(h.result.current.masked).toBe(true); expect(h.result.current.snapshot).toBeNull(); expect(h.result.current.attempts).toEqual([]);
  await act(async () => { f.hint(); await h.result.current.retry(1); }); expect(h.result.current.masked).toBe(true); expect(f.api.propose).toHaveBeenCalledTimes(1);
  f.api.read.mockResolvedValue(fixture(true).decode()); await act(async () => { await h.result.current.recover(); });
  expect(h.result.current.attempts[0].phase).toBe('confirmed'); expect(f.onConfirmed).toHaveBeenCalledTimes(1);
  await act(async () => { await h.result.current.recover(); await h.result.current.retry(1); }); expect(f.onConfirmed).toHaveBeenCalledTimes(1); expect(f.api.propose).toHaveBeenCalledTimes(1); h.unmount();
});
it('malformed injected results remain uncertain and strict snapshot errors do not fabricate success', async () => {
  const f = setup(); const h = f.mount(); await loaded(h.result); review(h.result);
  f.api.propose.mockResolvedValueOnce({ ...fixture(true).decode().operations[0], reason: 'mismatch' });
  await act(async () => { await h.result.current.confirm(); }); expect(h.result.current.attempts[0].phase).toBe('uncertain'); expect(f.onConfirmed).not.toHaveBeenCalled();
  f.api.read.mockResolvedValueOnce({ ...f.decode(), request_id: 123 } as unknown as DispatchReconciliations);
  await act(async () => { await h.result.current.recover(); }); expect(h.result.current.snapshot).toBeNull(); expect(h.result.current.error?.code).toBe('invalid_response');
  expect(h.result.current.attempts[0].phase).toBe('uncertain'); expect(f.api.propose).toHaveBeenCalledTimes(1); h.unmount();
});
it('successful write supersedes older GET, refreshes strict history and never lets old reads restore stale review data', async () => {
  const f = setup(); const oldRead = deferred<DispatchReconciliations>(); const post = deferred<DispatchReconciliationOperation>();
  const h = f.mount(); await loaded(h.result); review(h.result);
  f.api.propose.mockImplementationOnce(() => post.promise); let write!: Promise<void>; act(() => { write = h.result.current.confirm(); });
  f.api.read.mockImplementationOnce(() => oldRead.promise).mockResolvedValue(fixture(true).decode());
  let read!: Promise<void>; act(() => { read = h.result.current.refresh(); });
  await act(async () => { post.resolve(fixture(true).decode().operations[0]); await write; });
  await waitFor(() => expect(h.result.current.snapshot?.lines[0].workflow_revision).toBe(1n));
  act(() => { h.result.current.begin(2, 'propose'); h.result.current.setReason('new selected line'); });
  await act(async () => { oldRead.resolve(f.decode()); await read; });
  expect(h.result.current.snapshot?.lines[0].workflow_revision).toBe(1n); expect(h.result.current.draft?.reason).toBe('new selected line');
  expect(f.api.propose).toHaveBeenCalledTimes(1); expect(f.onConfirmed).toHaveBeenCalledTimes(1); h.unmount();
});
it('default authority-scoped store preserves unknown intent across pane unmount without a global private view', async () => {
  const f = setup(); const options = { ...f.options, store: undefined };
  const mount = () => renderHook(() => useTransferDispatchReconciliations(options));
  const h = mount(); await loaded(h.result); review(h.result); await act(async () => { await h.result.current.confirm(); });
  const captured = h.result.current.attempts[0].payload; h.unmount();
  const again = mount(); await loaded(again.result); expect(again.result.current.attempts[0]?.payload).toEqual(captured);
  expect(f.api.propose).toHaveBeenCalledTimes(1); again.unmount();
});
it('in-place immutable receipt changes immediately mask and retire old callbacks before rerender', async () => {
  const f = setup(); const h = f.mount(); await loaded(h.result); review(h.result); const old = h.result.current;
  if (f.record.status !== 'received') throw new Error();
  Object.assign(f.record.receipt.items[0], { actual_quantity: 8n }); Object.assign(f.record.receipt.exceptions[0], { quantity: 3n });
  expect(old.snapshot).toBeNull(); expect(old.draft).toBeNull(); expect(old.reviewState).toBeNull();
  await act(async () => { await old.confirm(); }); expect(f.api.propose).not.toHaveBeenCalled(); h.unmount();
});
it('active 401 settles only its captured authority, while cancel removes draft but not unknown intent', async () => {
  const f = setup(); const h = f.mount(); await loaded(h.result); review(h.result); act(() => { h.result.current.cancel(); });
  expect(h.result.current.draft).toBeNull(); expect(h.result.current.reviewState).toBeNull(); expect(f.api.propose).not.toHaveBeenCalled();
  review(h.result); f.api.propose.mockRejectedValueOnce(new DispatchReconciliationAPIError('unauthenticated', 401));
  await act(async () => { await h.result.current.confirm(); }); expect(f.controller.settleUnauthorized).toHaveBeenCalledWith(1);
  act(() => { h.result.current.cancel(); }); expect(h.result.current.masked).toBe(true); expect(h.result.current.attempts).toEqual([]);
  await act(async () => { await h.result.current.recover(); });
  expect(h.result.current.attempts[0]).toMatchObject({ phase: 'uncertain', priorUncertainty: true, payload: { reason: ' verified ' } });
  expect(f.api.propose).toHaveBeenCalledTimes(1); h.unmount();
});
