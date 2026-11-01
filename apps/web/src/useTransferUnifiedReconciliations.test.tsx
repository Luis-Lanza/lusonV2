import { act, fireEvent, render, renderHook, waitFor, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { parseSession } from './model';
import type { TransferReadOptions } from './transferAPI';
import type { TransferRecord } from './transferModel';
import type { TransferAuthority, TransferController } from './useInventory';
import { UnifiedReconciliationAPIError } from './transferUnifiedReconciliationAPI';
import type { UnifiedReconciliationOperation, UnifiedReconciliations } from './transferUnifiedReconciliationModel';
import { parseUnifiedReconciliations } from './transferUnifiedReconciliationModel';
import { unifiedAgreement, unifiedFixture, wire } from './transferUnifiedReconciliationFixtures';
import { useTransferUnifiedReconciliations, type TransferUnifiedReconciliationsOptions } from './useTransferUnifiedReconciliations';
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function setup() {
  const f = unifiedFixture();
  const authority: TransferAuthority = { epoch: 1, ready: true, sessionGeneration: 1, session: parseSession(JSON.stringify({ authenticated: true,
    csrf_token: 'a'.repeat(43), identity: { account_id: 1, username: 'operator', display_name: 'Operator', must_change_password: false,
      location: { id: 1, name: 'Origin' } }, expires_at: '2030-01-01T00:00:00Z' })) };
  const listeners = new Set<() => void>();
  const controller: TransferController = { authorityEpoch: 1, getTransferAuthority: () => authority,
    subscribeTransferInvalidation: fn => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    settleUnauthorized: vi.fn(async () => 'unavailable' as const) };
  const api = { read: vi.fn(async (_record: TransferRecord, _options?: TransferReadOptions): Promise<UnifiedReconciliations> => parseUnifiedReconciliations(wire(f.raw), f.record)),
    propose: vi.fn(async (..._args: unknown[]): Promise<UnifiedReconciliationOperation> => { throw new UnifiedReconciliationAPIError('network', null, true); }),
    decide: vi.fn(async (..._args: unknown[]): Promise<UnifiedReconciliationOperation> => { throw new UnifiedReconciliationAPIError('network', null, true); }) };
  const onConfirmed = vi.fn();
  const options: TransferUnifiedReconciliationsOptions = { controller, record: f.record, api, onConfirmed };
  const mount = () => renderHook((p: TransferUnifiedReconciliationsOptions) => useTransferUnifiedReconciliations(p), { initialProps: options });
  return { ...f, authority, controller, api, options, onConfirmed, mount, invalidate: () => listeners.forEach(fn => fn()) };
}
const input = { variant_id: 1, operation_key: 'unified-proposal-0001', expected_revision: '0',
  dispatch_quantity: '4', arrival_quantity: '3', retained_quantity: '1', retained_at_origin: true, reason: ' verified ' };
it('never POSTs from effects, preserves exact retry across remount and confirms only exact read evidence', async () => {
  const f = setup(); let h = f.mount();
  await waitFor(() => expect(h.result.current.snapshot).not.toBeNull());
  act(() => { expect(h.result.current.prepare('propose', input)).toBe(true); });
  expect(f.api.propose).not.toHaveBeenCalled();
  await act(async () => { await h.result.current.confirm(); });
  expect(h.result.current.attempts[0].phase).toBe('uncertain');
  h.unmount(); h = f.mount();
  await waitFor(() => expect(h.result.current.snapshot).not.toBeNull());
  expect(f.api.propose).toHaveBeenCalledTimes(1);
  await act(async () => { await h.result.current.retry(1); });
  expect(f.api.propose).toHaveBeenCalledTimes(2);
  expect(f.api.propose.mock.calls[1].slice(0, 4)).toEqual(f.api.propose.mock.calls[0].slice(0, 4));
  const durable = unifiedAgreement('pending'); f.api.read.mockResolvedValue(parseUnifiedReconciliations(wire(durable.raw), durable.record));
  await act(async () => { await h.result.current.recover(); });
  expect(h.result.current.attempts[0].phase).toBe('confirmed');
  expect(f.onConfirmed).toHaveBeenCalledTimes(1); expect(f.api.propose).toHaveBeenCalledTimes(2);
  h.unmount();
});
it.each(['generation', 'epoch', 'unready', 'account', 'location'] as const)('synchronously masks %s changes, aborts obsolete read and rejects late evidence', async change => {
  const f = setup(); const pending = deferred<UnifiedReconciliations>();
  f.api.read.mockImplementationOnce(() => pending.promise); const h = f.mount();
  await waitFor(() => expect(f.api.read).toHaveBeenCalledTimes(1));
  const old = h.result.current;
  if (change === 'unready') f.authority.ready = false;
  else if (change === 'epoch') f.authority.epoch++;
  else if (change === 'generation') f.authority.sessionGeneration!++;
  else if (f.authority.session?.authenticated) {
    if (change === 'account') f.authority.session.identity.account_id++;
    else f.authority.session.identity.location.id = 2;
  }
  expect(old.snapshot).toBeNull(); expect(old.prepared).toBeNull(); expect(old.attempts).toEqual([]);
  h.rerender(f.options);
  expect(f.api.read.mock.calls[0][1]?.signal?.aborted).toBe(true);
  await act(async () => { pending.resolve(parseUnifiedReconciliations(wire(f.raw), f.record)); });
  await old.confirm(); expect(f.api.propose).not.toHaveBeenCalled(); expect(f.onConfirmed).not.toHaveBeenCalled(); h.unmount();
});
it('invalidation clears already-rendered private DOM without a parent render or getter polling', async () => {
  const f = setup();
  function Pane() {
    const view = useTransferUnifiedReconciliations(f.options);
    return <div><span data-testid="snapshot">{view.snapshot?.request_id.toString() ?? 'none'}</span>
      <span data-testid="reason">{view.prepared?.payload.reason ?? 'none'}</span>
      <button onClick={() => view.prepare('propose', input)}>Prepare</button></div>;
  }
  const h = render(<Pane />), dom = within(h.container);
  await waitFor(() => expect(dom.getByTestId('snapshot')).toHaveTextContent('123'));
  fireEvent.click(dom.getByRole('button', { name: 'Prepare' }));
  expect(dom.getByTestId('reason')).toHaveTextContent('verified');
  f.authority.ready = false; act(() => { f.invalidate(); });
  expect(dom.getByTestId('snapshot')).toHaveTextContent('none');
  expect(dom.getByTestId('reason')).toHaveTextContent('none');
  expect(f.api.propose).not.toHaveBeenCalled(); h.unmount();
});
it('passive auth failure masks without session mutation; explicit refresh may settle the current epoch', async () => {
  const f = setup(); f.api.read.mockRejectedValue(new UnifiedReconciliationAPIError('unauthenticated', 401));
  const h = f.mount(); await waitFor(() => expect(h.result.current.masked).toBe(true));
  expect(f.controller.settleUnauthorized).not.toHaveBeenCalled();
  expect(f.api.read.mock.calls[0][1]?.passive).toBe(true);
  await act(async () => { await h.result.current.refresh(); });
  expect(f.controller.settleUnauthorized).toHaveBeenCalledExactlyOnceWith(1);
  expect(f.api.propose).not.toHaveBeenCalled(); expect(f.api.decide).not.toHaveBeenCalled(); h.unmount();
});
it('newer refresh wins over obsolete response and selection masks private intent before cleanup', async () => {
  const f = setup(); const h = f.mount(); await waitFor(() => expect(h.result.current.snapshot).not.toBeNull());
  act(() => { h.result.current.prepare('propose', input); });
  const pending = deferred<UnifiedReconciliations>(); f.api.read.mockImplementationOnce(() => pending.promise);
  let oldRead!: Promise<void>; act(() => { oldRead = h.result.current.refresh(); });
  const durable = unifiedAgreement('pending'); f.api.read.mockResolvedValue(parseUnifiedReconciliations(wire(durable.raw), durable.record));
  await act(async () => { await h.result.current.refresh(); });
  expect(h.result.current.snapshot?.operations).toHaveLength(1); expect(h.result.current.prepared).toBeNull();
  await act(async () => { pending.resolve(parseUnifiedReconciliations(wire(f.raw), f.record)); await oldRead; });
  expect(h.result.current.snapshot?.operations).toHaveLength(1);
  h.rerender({ ...f.options, record: null });
  expect(h.result.current.snapshot).toBeNull(); expect(h.result.current.attempts).toEqual([]); h.unmount();
});
it('read proof retires a live POST and its late reply cannot overwrite durable confirmation', async () => {
  const f = setup(); const h = f.mount(); await waitFor(() => expect(h.result.current.snapshot).not.toBeNull());
  const pending = deferred<UnifiedReconciliationOperation>(); f.api.propose.mockImplementationOnce(() => pending.promise);
  act(() => { h.result.current.prepare('propose', input); });
  let flight!: Promise<void>; act(() => { flight = h.result.current.confirm(); });
  await waitFor(() => expect(f.api.propose).toHaveBeenCalledTimes(1));
  const durable = unifiedAgreement('pending'), decoded = parseUnifiedReconciliations(wire(durable.raw), durable.record);
  f.api.read.mockResolvedValue(decoded);
  await act(async () => { await h.result.current.recover(); });
  expect(h.result.current.attempts[0].phase).toBe('confirmed');
  expect((f.api.propose.mock.calls[0][4] as AbortSignal).aborted).toBe(true);
  await act(async () => { pending.resolve({ ...decoded.operations[0], reason: 'obsolete' }); await flight; });
  expect(h.result.current.attempts[0].result).toEqual(decoded.operations[0]); expect(f.onConfirmed).toHaveBeenCalledTimes(1); h.unmount();
});
it('unmount aborts a live write but retains uncertainty for the same owner, never for a new owner', async () => {
  const f = setup(); const h = f.mount(); await waitFor(() => expect(h.result.current.snapshot).not.toBeNull());
  const pending = deferred<UnifiedReconciliationOperation>(); f.api.propose.mockImplementationOnce(() => pending.promise);
  act(() => { h.result.current.prepare('propose', input); });
  let flight!: Promise<void>; act(() => { flight = h.result.current.confirm(); });
  await waitFor(() => expect(f.api.propose).toHaveBeenCalledTimes(1)); h.unmount();
  expect((f.api.propose.mock.calls[0][4] as AbortSignal).aborted).toBe(true);
  const next = f.mount(); await waitFor(() => expect(next.result.current.snapshot).not.toBeNull());
  expect(next.result.current.attempts[0].phase).toBe('uncertain');
  f.authority.sessionGeneration!++; next.rerender(f.options);
  expect(next.result.current.attempts).toEqual([]);
  const durable = unifiedAgreement('pending');
  await act(async () => { pending.resolve(parseUnifiedReconciliations(wire(durable.raw), durable.record).operations[0]); await flight; });
  expect(next.result.current.attempts).toEqual([]); expect(f.onConfirmed).not.toHaveBeenCalled(); next.unmount();
});
