import { StrictMode, createElement } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { parseSession } from './model';
import { RestitutionAPIError, TransferAPIError } from './transferAPI';
import { captureCountCorrections } from './transferCountCorrectionRecovery';
import { createTransferRestitutionRecovery } from './transferRestitutionRecovery';
import { captureRestitutions, type RestitutionOperation, type Restitutions } from './transferRestitutionModel';
import { parseTransferRecord } from './transferModel';
import type { TransferAuthority } from './useInventory';
import { useTransferRestitutions, type TransferRestitutionsOptions } from './useTransferRestitutions';
const id = '9007199254740993';
const stamp = '2026-04-02T00:00:00Z';
const input = { variant_id: 201, operation_key: 'retained_proposal_01', expected_revision: '0', retained_quantity: '1', retained_at_origin: true as const, reason: ' retained at origin ' };
const decision = { variant_id: 201, operation_key: 'retained_decision_01', expected_revision: '1', reason: ' destination checked ' };
function deferred<T>() {
  let resolve!: (v: T) => void; let reject!: (e: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
}
function record() {
  return parseTransferRecord(JSON.stringify({ id, reference: `TR-${id}`, kind: 'direct_shipment', status: 'received',
    created_at: stamp, creator_location_id: 1, creator_location_name: 'Origin', origin_location_id: 1, origin_location_name: 'Origin',
    destination_location_id: 2, destination_location_name: 'Destination', approver_location_id: 1, approver_location_name: 'Origin',
    decision_location_id: 1, decided_at: stamp, dispatch_location_id: 1, dispatched_at: stamp, receipt_location_id: 2, received_at: stamp,
    items: [{ variant_id: 201, brand: 'B', model: 'M', capacity_ah: '60', polarity: 'L', quantity: '5' }],
    receipt: { items: [{ variant_id: 201, expected_quantity: '5', actual_quantity: '4', available_quantity: '4' }],
      exceptions: [{ variant_id: 201, kind: 'shortage', quantity: '1' }] } }));
}
function history(proposed = false): Restitutions {
  return captureRestitutions({ request_id: BigInt(id), lines: [{ variant_id: 201, expected_quantity: 5n, effective_dispatch: 5n, reconciliation_revision: 0n, original_credit: 4n,
    workflow_revision: proposed ? 1n : 0n, applied_revision: 0n, count_generation: 0n, count_applied_revision: 0n, effective_credit: 4n,
    applied_retained_quantity: 0n, proposals: proposed ? [{ revision: 1n, operation_key: input.operation_key, initiator_location_id: 1,
      retained_quantity: 1n, retained_at_origin: true, base_revision: 0n, count_generation: 0n, count_applied_revision: 0n,
      base_dispatch: 5n, base_credit: 4n, base_restitution: 0n, reason: input.reason, recorded_at: stamp, state: 'pending', decision: null, application: null }] : [] }],
    operations: proposed ? [operation()] : [] });
}
function operation(action: 'propose' | 'accept' | 'reject' = 'propose'): RestitutionOperation {
  return { request_id: BigInt(id), variant_id: 201, operation_key: action === 'propose' ? input.operation_key : decision.operation_key,
    actor_location_id: action === 'propose' ? 1 : 2, action, expected_revision: action === 'propose' ? 0n : 1n,
    retained_quantity: action === 'propose' ? 1n : null, retained_at_origin: action === 'propose' ? true : null,
    reason: action === 'propose' ? input.reason : decision.reason, revision: 1n,
    source_existing_before: action === 'accept' ? 10n : null, source_existing_after: action === 'accept' ? 11n : null, recorded_at: stamp };
}
function count() {
  return captureCountCorrections({ request_id: BigInt(id), operations: [], lines: [{ variant_id: 201, expected_quantity: 5n, effective_dispatch: 5n, reconciliation_revision: 0n,
    actual_quantity: 4n, available_quantity: 4n, workflow_revision: 0n, applied_revision: 0n, effective_actual: 4n, effective_credit: 4n, proposals: [] }] });
}
function fixture(destination = false) {
  const authority: TransferAuthority = { epoch: 1, ready: true, sessionGeneration: 1, session: parseSession(JSON.stringify({
    authenticated: true, csrf_token: 'c'.repeat(43), identity: { account_id: destination ? 2 : 1, username: 'participant',
      location: { id: destination ? 2 : 1, name: 'Location' } }, expires_at: '2030-01-01T00:00:00Z' })) };
  const listeners = new Set<() => void>();
  const controller = { getTransferAuthority: () => authority, subscribeTransferInvalidation: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
    settleUnauthorized: vi.fn(async () => 'unavailable' as const) };
  const api = { restitutions: vi.fn(async () => history(destination)), countCorrections: vi.fn(async () => count()),
    proposeRestitution: vi.fn(async () => operation()), decideRestitution: vi.fn(async () => operation('accept')) };
  const recovery = createTransferRestitutionRecovery(); const onConfirmation = vi.fn();
  const options: TransferRestitutionsOptions = { controller, api, recovery, requestID: id, record: record(), variantID: 201, onConfirmation };
  const mount = () => renderHook((p: TransferRestitutionsOptions) => useTransferRestitutions(p), { initialProps: options });
  return { authority, controller, api, recovery, options, onConfirmation, mount, hint: () => { for (const l of listeners) l(); } };
}
async function loaded(h: ReturnType<ReturnType<typeof fixture>['mount']>) {
  await waitFor(() => expect(h.result.current.snapshot?.request_id).toBe(BigInt(id)));
}
async function reviewed(h: ReturnType<ReturnType<typeof fixture>['mount']>, action: 'propose' | 'accept' | 'reject' = 'propose') {
  await act(async () => { await h.result.current.refresh(); });
  const pin = h.result.current.review(action); expect(pin).not.toBeNull(); return pin!;
}
it('passive mount/hints cannot grant consent; explicit reconciled evidence can', async () => {
  const f = fixture(); const h = f.mount(); await loaded(h);
  expect(h.result.current.review('propose')).toBeNull();
  const pin = await reviewed(h);
  await act(async () => { await h.result.current.submit(pin, input); });
  expect(f.api.proposeRestitution).toHaveBeenCalledTimes(1);
  expect(h.result.current.attempts[0].phase).toBe('confirmed'); expect(f.onConfirmation).toHaveBeenCalledTimes(1);
  await act(async () => { f.hint(); await h.result.current.refresh(); });
  expect(f.onConfirmation).toHaveBeenCalledTimes(1); h.unmount();
});
it('captures immutable retry payload synchronously and does not retry on remount', async () => {
  const f = fixture(); const first = deferred<RestitutionOperation>(); f.api.proposeRestitution.mockImplementationOnce(() => first.promise);
  const h = f.mount(); await loaded(h); const pin = await reviewed(h); const form = { ...input }; let p!: Promise<void>;
  act(() => { p = h.result.current.submit(pin, form); }); form.reason = 'changed'; form.retained_quantity = '99';
  await act(async () => { first.reject(new RestitutionAPIError('network', null, true)); await p; });
  expect(h.result.current.attempts[0].phase).toBe('uncertain'); h.unmount();
  const again = f.mount(); await loaded(again); expect(f.api.proposeRestitution).toHaveBeenCalledTimes(1);
  await act(async () => { await again.result.current.retry(201); });
  const calls = f.api.proposeRestitution.mock.calls as unknown[][];
  expect(calls[0].slice(0, 4)).toEqual([id, 1, input, 'c'.repeat(43)]); expect(calls[1].slice(0, 4)).toEqual(calls[0].slice(0, 4));
  expect(f.onConfirmation).toHaveBeenCalledTimes(1); again.unmount();
});
it('settles finish validation failures as restitution uncertainty, allowing exact retry', async () => {
  const f = fixture(true); f.api.decideRestitution.mockResolvedValueOnce({ ...operation('accept'), source_existing_after: 12n });
  const h = f.mount(); await loaded(h); const pin = await reviewed(h, 'accept');
  await act(async () => { await h.result.current.submit(pin, decision); });
  expect(h.result.current.attempts[0]).toMatchObject({ phase: 'uncertain', failure: { code: 'invalid_response', status: 200, uncertainRestitution: true } });
  expect(h.result.current.busy).toBe(false); expect(f.onConfirmation).not.toHaveBeenCalled();
  expect(h.result.current.error).toMatchObject({ code: 'invalid_response', status: 200, uncertainRestitution: true });
  await act(async () => { await h.result.current.retry(201); });
  expect(h.result.current.attempts[0].phase).toBe('confirmed'); expect(f.onConfirmation).toHaveBeenCalledTimes(1); h.unmount();
});

it('coalesces dirty hints into one follow-up without publishing a fresh head or consent', async () => {
  const f = fixture(); const h = f.mount(); await loaded(h); const pin = await reviewed(h);
  const dirty = deferred<Restitutions>(); const next = deferred<Restitutions>();
  f.api.restitutions.mockImplementationOnce(() => dirty.promise).mockImplementationOnce(() => next.promise);
  act(() => { f.hint(); f.hint(); f.hint(); });
  await act(async () => { await h.result.current.submit(pin, input); });
  expect(f.api.proposeRestitution).not.toHaveBeenCalled();
  expect(f.api.restitutions).toHaveBeenCalledTimes(3);
  await act(async () => { dirty.resolve(history(true)); await dirty.promise; });
  await waitFor(() => expect(f.api.restitutions).toHaveBeenCalledTimes(4));
  expect(h.result.current.snapshot?.lines[0].workflow_revision).toBe(0n);
  expect(h.result.current.review('propose')).toBeNull();
  await act(async () => { next.resolve(history(true)); await next.promise; });
  expect(h.result.current.snapshot?.lines[0].workflow_revision).toBe(1n);
  expect(h.result.current.review('propose')).toBeNull(); h.unmount();
});
it('dirty GET persistence settles only the captured operation, once', async () => {
  const f = fixture(); f.api.proposeRestitution.mockRejectedValueOnce(new RestitutionAPIError('network', null, true));
  const h = f.mount(); await loaded(h); const pin = await reviewed(h);
  await act(async () => { await h.result.current.submit(pin, input); });
  const dirty = deferred<Restitutions>(); const next = deferred<Restitutions>();
  f.api.restitutions.mockImplementationOnce(() => dirty.promise).mockImplementationOnce(() => next.promise);
  act(() => { f.hint(); f.hint(); });
  await act(async () => { dirty.resolve(history(true)); await dirty.promise; });
  expect(h.result.current.attempts[0].phase).toBe('confirmed'); expect(f.onConfirmation).toHaveBeenCalledTimes(1);
  expect(h.result.current.snapshot?.lines[0].workflow_revision).toBe(0n);
  await act(async () => { next.resolve(history(true)); await next.promise; });
  expect(f.onConfirmation).toHaveBeenCalledTimes(1); expect(f.api.proposeRestitution).toHaveBeenCalledTimes(1); h.unmount();
});
it.each([403, 404])('request-wide %s privacy survives passive reads and remount; explicit recovery alone unmasks', async status => {
  const f = fixture(); const h = f.mount(); await loaded(h); const pin = await reviewed(h);
  f.api.proposeRestitution.mockRejectedValueOnce(new RestitutionAPIError('network', null, true));
  await act(async () => { await h.result.current.submit(pin, input); });
  f.api.restitutions.mockRejectedValueOnce(new RestitutionAPIError(status === 403 ? 'forbidden' : 'not_found', status));
  await act(async () => { await h.result.current.refresh(); });
  expect(h.result.current.masked).toBe(true); expect(h.result.current.attempts).toEqual([]); expect(h.result.current.snapshot).toBeNull();
  await act(async () => { f.hint(); await h.result.current.retry(201); });
  expect(h.result.current.masked).toBe(true); expect(f.api.proposeRestitution).toHaveBeenCalledTimes(1); h.unmount();
  const again = f.mount(); await waitFor(() => expect(f.api.restitutions).toHaveBeenCalledTimes(5));
  expect(again.result.current.masked).toBe(true); expect(again.result.current.review('propose')).toBeNull();
  await act(async () => { await again.result.current.recover(); });
  expect(again.result.current.masked).toBe(false); expect(again.result.current.attempts[0].phase).toBe('uncertain');
  expect(again.result.current.review('propose')).toBeNull(); again.unmount();
});
it('a count privacy failure masks the request and fences an ignored-abort restitution read', async () => {
  const f = fixture(); const h = f.mount(); await loaded(h);
  const pending = deferred<Restitutions>(); f.api.restitutions.mockImplementationOnce(() => pending.promise);
  f.api.countCorrections.mockRejectedValueOnce(new TransferAPIError('forbidden', 403));
  let refresh!: Promise<void>; act(() => { refresh = h.result.current.refresh(); });
  await waitFor(() => expect(h.result.current.masked).toBe(true));
  await act(async () => { pending.resolve(history()); await refresh; });
  expect(h.result.current.masked).toBe(true); expect(h.result.current.snapshot).toBeNull(); h.unmount();
});
it.each([403, 404])('POST %s masks all private evidence and prevents exact retry', async status => {
  const f = fixture(); const h = f.mount(); await loaded(h); const pin = await reviewed(h);
  f.api.proposeRestitution.mockRejectedValueOnce(new RestitutionAPIError(status === 403 ? 'forbidden' : 'not_found', status));
  await act(async () => { await h.result.current.submit(pin, input); });
  expect(h.result.current.snapshot).toBeNull(); expect(h.result.current.masked).toBe(true); expect(h.result.current.attempts).toEqual([]);
  await act(async () => { await h.result.current.retry(201); f.hint(); });
  expect(f.api.proposeRestitution).toHaveBeenCalledTimes(1); expect(h.result.current.masked).toBe(true); h.unmount();
});
it('reject is count-independent while accept requires count evidence', async () => {
  const f = fixture(true); f.api.countCorrections.mockRejectedValue(new TransferAPIError('network', null));
  f.api.decideRestitution.mockResolvedValue(operation('reject'));
  const h = f.mount(); await loaded(h);
  await act(async () => { await h.result.current.refresh(); });
  expect(h.result.current.review('accept')).toBeNull(); const pin = h.result.current.review('reject'); expect(pin).not.toBeNull();
  await act(async () => { await h.result.current.submit(pin!, decision); });
  expect(h.result.current.attempts[0].phase).toBe('confirmed'); expect(f.onConfirmation).toHaveBeenCalledTimes(1); h.unmount();
});
it.each(['missing', 'mismatch', 'malformed'] as const)('fresh proposal requires %s count evidence to be reconciled', async mode => {
  const f = fixture();
  if (mode === 'missing') f.api.countCorrections.mockRejectedValue(new TransferAPIError('network', null));
  else { const c = count(); f.api.countCorrections.mockResolvedValue({ ...c,
    lines: [{ ...c.lines[0], effective_credit: mode === 'mismatch' ? 3n : -1n }] }); }
  const h = f.mount(); await loaded(h); await act(async () => { await h.result.current.refresh(); });
  expect(h.result.current.review('propose')).toBeNull(); expect(f.api.proposeRestitution).not.toHaveBeenCalled(); h.unmount();
});
it.each(['account', 'location', 'epoch', 'generation'] as const)('fences ignored-abort POST and old callbacks after %s scalar mutation', async field => {
  const f = fixture(); const h = f.mount(); await loaded(h); const pin = await reviewed(h); const old = h.result.current;
  const pending = deferred<RestitutionOperation>(); f.api.proposeRestitution.mockImplementationOnce(() => pending.promise); let p!: Promise<void>;
  act(() => { p = old.submit(pin, input); }); const original = structuredClone(f.authority);
  if (field === 'epoch') f.authority.epoch++;
  else if (field === 'generation') f.authority.sessionGeneration!++;
  else if (f.authority.session?.authenticated) {
    if (field === 'account') f.authority.session.identity.account_id = 3;
    else f.authority.session.identity.location.id = 3;
  }
  expect(old.snapshot).toBeNull(); expect(old.attempts).toEqual([]);
  h.rerender(f.options);
  await act(async () => { pending.resolve(operation()); await p; await old.submit(pin, input); await old.retry(201); });
  expect(f.onConfirmation).not.toHaveBeenCalled(); expect(f.api.proposeRestitution).toHaveBeenCalledTimes(1);
  Object.assign(f.authority, original); h.rerender(f.options);
  expect(h.result.current.attempts).toEqual([]); h.unmount();
});
it.each(['request', 'api', 'recovery', 'disabled', 'variant', 'header', 'notready'] as const)('fences late POST after %s context replacement', async change => {
  const f = fixture(); const h = f.mount(); await loaded(h); const pin = await reviewed(h); const old = h.result.current;
  const pending = deferred<RestitutionOperation>(); f.api.proposeRestitution.mockImplementationOnce(() => pending.promise); let p!: Promise<void>;
  act(() => { p = old.submit(pin, input); }); const options = { ...f.options };
  if (change === 'request') options.requestID = '2';
  if (change === 'api') options.api = { ...f.api };
  if (change === 'recovery') options.recovery = createTransferRestitutionRecovery();
  if (change === 'disabled') options.enabled = false;
  if (change === 'variant') options.variantID = 202;
  if (change === 'header') options.record = null;
  if (change === 'notready') f.authority.ready = false;
  h.rerender(options);
  await act(async () => { pending.resolve(operation()); await p; await old.submit(pin, input); await old.refresh(); });
  expect(f.onConfirmation).not.toHaveBeenCalled(); expect(f.api.proposeRestitution).toHaveBeenCalledTimes(1);
  expect(((f.api.proposeRestitution.mock.calls as unknown[][])[0][4] as AbortSignal).aborted).toBe(true); h.unmount();
});
it('unmount releases uncertainty and an obsolete POST cannot settle a new retry', async () => {
  const f = fixture(); const h = f.mount(); await loaded(h); const pin = await reviewed(h);
  const old = deferred<RestitutionOperation>(); const fresh = deferred<RestitutionOperation>();
  f.api.proposeRestitution.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => fresh.promise); let p!: Promise<void>;
  act(() => { p = h.result.current.submit(pin, input); }); h.unmount();
  const again = f.mount(); await loaded(again); expect(again.result.current.attempts[0].phase).toBe('uncertain'); let retry!: Promise<void>;
  act(() => { retry = again.result.current.retry(201); });
  await act(async () => { old.resolve(operation()); await p; });
  expect(again.result.current.attempts[0].phase).toBe('inFlight'); expect(f.onConfirmation).not.toHaveBeenCalled();
  await act(async () => { fresh.resolve(operation()); await retry; });
  expect(again.result.current.attempts[0].phase).toBe('confirmed'); expect(f.onConfirmation).toHaveBeenCalledTimes(1); again.unmount();
});
it.each(['read', 'write'] as const)('401 %s uses owner-fenced unauthorized settlement', async lane => {
  const f = fixture(); const h = f.mount(); await loaded(h); const pin = await reviewed(h);
  if (lane === 'read') {
    f.api.restitutions.mockRejectedValueOnce(new RestitutionAPIError('unauthenticated', 401));
    await act(async () => { await h.result.current.refresh(); });
  } else {
    f.api.proposeRestitution.mockRejectedValueOnce(new RestitutionAPIError('unauthenticated', 401));
    await act(async () => { await h.result.current.submit(pin, input); });
  }
  expect(f.controller.settleUnauthorized).toHaveBeenCalledExactlyOnceWith(1); h.unmount();
});
it('invalid header and request identity never grant a review pin', async () => {
  const f = fixture(); const h = f.mount(); await loaded(h); await reviewed(h);
  h.rerender({ ...f.options, record: { ...record(), destination_location_id: 3 } });
  await act(async () => { await h.result.current.refresh(); });
  expect(h.result.current.review('accept')).toBeNull();
  h.rerender({ ...f.options, record: null }); await act(async () => { await h.result.current.refresh(); });
  expect(h.result.current.review('propose')).toBeNull();
  h.rerender({ ...f.options, requestID: '../private' }); expect(h.result.current.snapshot).toBeNull();
  expect(h.result.current.attempts).toEqual([]); h.unmount();
});
it('C4 uncertainty flags cannot classify a restitution POST', async () => {
  const f = fixture(); const h = f.mount(); await loaded(h); const pin = await reviewed(h);
  f.api.proposeRestitution.mockRejectedValueOnce(new TransferAPIError('invalid_request', 400, false, false, false, false, false, true));
  await act(async () => { await h.result.current.submit(pin, input); });
  expect(h.result.current.attempts[0]).toMatchObject({ phase: 'uncertain', failure: { code: 'invalid_response', status: 200, uncertainRestitution: true } });
  expect(f.onConfirmation).not.toHaveBeenCalled(); h.unmount();
});
it('fences every callback in a drained confirmation batch', async () => {
  const f = fixture(); const header = record(); if (header.status !== 'received') throw new Error('Fixture must be received');
  const secondInput = { ...input, variant_id: 202, operation_key: 'retained_proposal_02' };
  const secondOp = { ...operation(), variant_id: 202, operation_key: secondInput.operation_key };
  const secondLine = { ...history(true).lines[0], variant_id: 202,
    proposals: [{ ...history(true).lines[0].proposals[0], operation_key: secondInput.operation_key }] };
  const full = captureRestitutions({ request_id: BigInt(id), operations: [operation(), secondOp], lines: [history(true).lines[0], secondLine] });
  const empty = captureRestitutions({ ...full, operations: [], lines: full.lines.map(l => ({ ...l, workflow_revision: 0n, proposals: [] })) });
  f.options.record = { ...header, items: [...header.items, { ...header.items[0], variant_id: 202 }],
    receipt: { items: [...header.receipt.items, { ...header.receipt.items[0], variant_id: 202 }],
      exceptions: [...header.receipt.exceptions, { ...header.receipt.exceptions[0], variant_id: 202 }] } };
  const owner = { account: 1, location: 1, epoch: 1, generation: 1 };
  f.recovery.observe(owner, empty, true);
  f.recovery.observeCount(owner, { ...count(), lines: [count().lines[0], { ...count().lines[0], variant_id: 202 }] }, true);
  const firstPin = f.recovery.review(owner, f.options.record, 201, 'propose')!;
  f.recovery.finish(f.recovery.start(firstPin, input)!, operation());
  f.recovery.observe(owner, { ...full, operations: [operation()], lines: [full.lines[0], empty.lines[1]] }, true);
  const secondPin = f.recovery.review(owner, f.options.record, 202, 'propose')!;
  f.recovery.finish(f.recovery.start(secondPin, secondInput)!, secondOp);
  f.api.restitutions.mockResolvedValue(full);
  f.onConfirmation.mockImplementationOnce(() => { f.authority.epoch++; });
  const h = f.mount(); await waitFor(() => expect(f.onConfirmation).toHaveBeenCalledTimes(1));
  expect(f.onConfirmation.mock.calls[0][1]).toEqual(operation()); expect(h.result.current.attempts).toEqual([]); h.unmount();
});
it('StrictMode remounts and refreshes never POST or grant passive consent', async () => {
  const f = fixture();
  const h = renderHook(() => useTransferRestitutions(f.options), {
    wrapper: ({ children }: { children: React.ReactNode }) => createElement(StrictMode, null, children),
  });
  await loaded(h); expect(h.result.current.review('propose')).toBeNull();
  await act(async () => { f.hint(); await h.result.current.refresh(); });
  expect(f.api.proposeRestitution).not.toHaveBeenCalled(); expect(f.api.decideRestitution).not.toHaveBeenCalled(); h.unmount();
});
it('pending count operations block accept but not exact rejection', async () => {
  const f = fixture(true); const c = count(); const r = history(true);
  f.api.countCorrections.mockResolvedValue({ ...c,
    operations: [{ request_id: BigInt(id), variant_id: 201, operation_key: 'count_proposal_001', actor_location_id: 2,
      action: 'propose', expected_revision: 0n, actual_quantity: 4n, reason: 'counting', revision: 1n, recorded_at: stamp }],
    lines: [{ ...c.lines[0], workflow_revision: 1n, proposals: [{ revision: 1n, operation_key: 'count_proposal_001',
      initiator_location_id: 2, actual_quantity: 4n, base_revision: 0n, base_credit: 4n, reason: 'counting',
      recorded_at: stamp, state: 'pending', decision: null, application: null }] }],
  });
  f.api.restitutions.mockResolvedValue({ ...r, lines: [{ ...r.lines[0], count_generation: 1n,
    proposals: [{ ...r.lines[0].proposals[0], count_generation: 1n }] }] });
  f.api.decideRestitution.mockResolvedValue(operation('reject'));
  const h = f.mount(); await loaded(h); await act(async () => { await h.result.current.refresh(); });
  expect(h.result.current.review('accept')).toBeNull(); const pin = h.result.current.review('reject'); expect(pin).not.toBeNull();
  await act(async () => { await h.result.current.submit(pin!, decision); });
  expect(f.onConfirmation).toHaveBeenCalledTimes(1); h.unmount();
});
it('a definite retry failure cannot erase earlier restitution uncertainty', async () => {
  const f = fixture(); const h = f.mount(); await loaded(h); const pin = await reviewed(h);
  f.api.proposeRestitution.mockRejectedValueOnce(new RestitutionAPIError('network', null, true))
    .mockRejectedValueOnce(new RestitutionAPIError('decision_conflict', 409));
  await act(async () => { await h.result.current.submit(pin, input); await h.result.current.retry(201); });
  expect(h.result.current.attempts[0]).toMatchObject({ phase: 'uncertain', priorUncertainty: true });
  expect(h.result.current.review('propose')).toBeNull(); expect(f.onConfirmation).not.toHaveBeenCalled(); h.unmount();
});
it.each(['request', 'api', 'recovery', 'disabled', 'owner'] as const)('late ignored-abort GET cannot publish after %s changes', async change => {
  const f = fixture(); const pending = deferred<Restitutions>(); f.api.restitutions.mockImplementationOnce(() => pending.promise);
  const h = f.mount(); const old = h.result.current; const options = { ...f.options };
  if (change === 'request') options.requestID = '2';
  if (change === 'api') options.api = { ...f.api };
  if (change === 'recovery') options.recovery = createTransferRestitutionRecovery();
  if (change === 'disabled') options.enabled = false;
  if (change === 'owner') f.authority.epoch++;
  h.rerender(options);
  await act(async () => { pending.resolve(history(true)); await pending.promise; await old.refresh(); });
  expect(old.snapshot).toBeNull(); expect(f.onConfirmation).not.toHaveBeenCalled();
  expect(h.result.current.snapshot?.lines[0].workflow_revision).not.toBe(1n);
  expect(((f.api.restitutions.mock.calls as unknown[][])[0][1] as { signal: AbortSignal }).signal.aborted).toBe(true); h.unmount();
});
it('reentrant authority mutation during validated GET notification fences confirmation and publication', async () => {
  const f = fixture(); const h = f.mount(); await loaded(h); const pin = await reviewed(h);
  f.api.proposeRestitution.mockRejectedValueOnce(new RestitutionAPIError('network', null, true));
  await act(async () => { await h.result.current.submit(pin, input); });
  f.api.restitutions.mockResolvedValue(history(true));
  const old = h.result.current; let retired = false;
  const unsubscribe = f.recovery.subscribe(() => {
    if (!retired && f.recovery.get({ account: 1, location: 1, epoch: 1, generation: 1 }, BigInt(id))[0]?.phase === 'confirmed') {
      retired = true; f.authority.epoch++;
    }
  });
  await act(async () => { await old.refresh(); });
  expect(retired).toBe(true); expect(f.onConfirmation).not.toHaveBeenCalled(); expect(old.snapshot).toBeNull(); expect(h.result.current.attempts).toEqual([]);
  unsubscribe(); h.unmount();
});
it('dirty explicit recovery cannot unmask private history', async () => {
  const f = fixture(); const h = f.mount(); await loaded(h);
  f.api.restitutions.mockRejectedValueOnce(new RestitutionAPIError('forbidden', 403));
  await act(async () => { await h.result.current.refresh(); });
  const dirty = deferred<Restitutions>(); const next = deferred<Restitutions>();
  f.api.restitutions.mockImplementationOnce(() => dirty.promise).mockImplementationOnce(() => next.promise);
  let p!: Promise<void>; act(() => { p = h.result.current.recover(); f.hint(); f.hint(); });
  await act(async () => { dirty.resolve(history()); await p; });
  expect(h.result.current.masked).toBe(true); expect(h.result.current.snapshot).toBeNull();
  await act(async () => { next.resolve(history()); await next.promise; });
  expect(h.result.current.masked).toBe(true); expect(h.result.current.review('propose')).toBeNull(); h.unmount();
});
