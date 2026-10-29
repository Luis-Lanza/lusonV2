import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useInventory } from './useInventory';
import { useTransferRestitutions } from './useTransferRestitutions';
import { useTransferCountCorrections } from './useTransferCountCorrections';
import { createTransferRestitutionRecovery, type TransferRestitutionRecovery } from './transferRestitutionRecovery';
import { decisionOwner, type DecisionOwner } from './transferDecisionRecovery';
import { captureCountCorrections } from './transferCountCorrectionRecovery';
import type { CountOperation } from './transferCountCorrectionModel';
import { RestitutionAPIError } from './transferAPI';
import { captureRestitutions, type RestitutionOperation } from './transferRestitutionModel';
import { parseTransferRecord } from './transferModel';
import { useTransferDispatchReconciliations } from './useTransferDispatchReconciliations';
import { appliedSnapshot, fixture as dispatchFixture, decisionKey } from './transferDispatchReconciliationStoreFixtures';
import { createTransferDispatchReconciliationStore } from './transferDispatchReconciliationStore';
import type { TransferController } from './useInventory';
import type { DispatchReconciliationOperation } from './transferDispatchReconciliationModel';

const id = '9007199254740993';
const stamp = '2026-04-02T00:00:00Z';
const proposalInput = { variant_id: 201, operation_key: 'retained_proposal_01', expected_revision: '0', retained_quantity: '1', retained_at_origin: true as const, reason: 'retained' };
const decisionInput = { variant_id: 201, operation_key: 'retained_decision_01', expected_revision: '1', reason: 'checked' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
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
function operation(action: 'propose' | 'accept' | 'reject' = 'accept'): RestitutionOperation {
  return { request_id: BigInt(id), variant_id: 201, operation_key: action === 'propose' ? proposalInput.operation_key : decisionInput.operation_key,
    actor_location_id: action === 'propose' ? 1 : 2, action, expected_revision: action === 'propose' ? 0n : 1n,
    retained_quantity: action === 'propose' ? 1n : null, retained_at_origin: action === 'propose' ? true : null,
    reason: action === 'propose' ? proposalInput.reason : decisionInput.reason, revision: 1n,
    source_existing_before: action === 'accept' ? 10n : null, source_existing_after: action === 'accept' ? 11n : null, recorded_at: stamp };
}
function history(proposed = true) {
  return captureRestitutions({ request_id: BigInt(id), lines: [{ variant_id: 201, expected_quantity: 5n, effective_dispatch: 5n, reconciliation_revision: 0n, original_credit: 4n,
    workflow_revision: proposed ? 1n : 0n, applied_revision: 0n, count_generation: 0n, count_applied_revision: 0n, effective_credit: 4n,
    applied_retained_quantity: 0n, proposals: proposed ? [{ revision: 1n, operation_key: proposalInput.operation_key, initiator_location_id: 1,
      retained_quantity: 1n, retained_at_origin: true, base_revision: 0n, count_generation: 0n, count_applied_revision: 0n,
      base_dispatch: 5n, base_credit: 4n, base_restitution: 0n, reason: proposalInput.reason, recorded_at: stamp, state: 'pending', decision: null, application: null }] : [] }],
    operations: proposed ? [operation('propose')] : [] });
}
function count() {
  return captureCountCorrections({ request_id: BigInt(id), operations: [], lines: [{ variant_id: 201, expected_quantity: 5n, effective_dispatch: 5n, reconciliation_revision: 0n,
    actual_quantity: 4n, available_quantity: 4n, workflow_revision: 0n, applied_revision: 0n, effective_actual: 4n, effective_credit: 4n, proposals: [] }] });
}
function countOperation(action: 'propose' | 'accept' | 'reject'): CountOperation {
  return { request_id: BigInt(id), variant_id: 201, operation_key: 'count_operation_01', actor_location_id: 2, action,
    expected_revision: action === 'propose' ? 0n : 1n, actual_quantity: action === 'propose' ? 4n : null,
    reason: 'count checked', revision: 1n, recorded_at: stamp };
}
class QuietSource {
  addEventListener() {}
  removeEventListener() {}
  close() {}
}
afterEach(() => { vi.unstubAllGlobals(); });
async function setup(destination = true) {
  vi.stubGlobal('EventSource', QuietSource);
  const locations = [{ id: 1, name: 'Origin' }, { id: 2, name: 'Destination' }, { id: 3, name: 'Other' }];
  const session = { authenticated: true as const, csrf_token: 'c'.repeat(43), identity: { account_id: destination ? 2 : 1,
    username: 'participant', display_name: 'Operador participante', must_change_password: false, location: locations[destination ? 1 : 0] }, expires_at: '2030-01-01T00:00:00Z' };
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/auth/session') return new Response(JSON.stringify(session));
    if (url === '/api/inventory/metadata') return new Response(JSON.stringify({ locations, brands: ['B'] }));
    if (url.startsWith('/api/inventory?')) {
      const params = new URL(url, 'http://localhost').searchParams;
      return new Response(JSON.stringify({ location: locations[Number(params.get('location_id')) - 1], items: [],
        page: Number(params.get('page')), page_size: Number(params.get('page_size')), total_variants: 0 }));
    }
    throw new Error(`Unexpected URL: ${url}`);
  });
  vi.stubGlobal('fetch', fetcher);
  const inventory = renderHook(() => useInventory());
  await waitFor(() => expect(inventory.result.current.data).not.toBeNull());
  // Baseline fallback lets the first RED exercise real acceptance, rather than
  // fail merely because the additive controller property does not exist yet.
  const controller = () => inventory.result.current as typeof inventory.result.current & {
    restitutionRecovery?: TransferRestitutionRecovery;
    confirmTransferRestitution?: (owner: DecisionOwner, operation: RestitutionOperation) => void;
  };
  const recovery = controller().restitutionRecovery ?? createTransferRestitutionRecovery();
  const api = { restitutions: vi.fn(async () => history(destination)), countCorrections: vi.fn(async () => count()),
    proposeRestitution: vi.fn(async () => operation('propose')), decideRestitution: vi.fn(async () => operation()),
    proposeCount: vi.fn(async () => countOperation('propose')), decideCount: vi.fn(async () => countOperation('accept')) };
  const mount = () => renderHook(() => ({
    restitution: useTransferRestitutions({ controller: controller(), recovery, onConfirmation: controller().confirmTransferRestitution,
      requestID: id, record: record(), variantID: 201, api }),
    count: useTransferCountCorrections({ controller: controller(), requestID: id, api }),
  }));
  const pane = mount();
  await waitFor(() => expect(pane.result.current.restitution.snapshot).not.toBeNull());
  const transfer = vi.fn(); const source = vi.fn();
  controller().subscribeTransferInvalidation(transfer);
  controller().subscribeSourceInventoryInvalidation(source);
  const stockReads = () => fetcher.mock.calls.filter(([url]) => String(url).startsWith('/api/inventory?')).length;
  return { inventory, controller, recovery, api, pane, mount, transfer, source, stockReads, fetcher };
}
async function review(f: Awaited<ReturnType<typeof setup>>, action: 'propose' | 'accept' | 'reject' = 'accept') {
  await act(async () => { await f.pane.result.current.restitution.refresh(); });
  const pin = f.pane.result.current.restitution.review(action);
  expect(pin).not.toBeNull();
  return pin!;
}
it.each(['post', 'recovery'] as const)('dispatch reconciliation exact historical %s confirmation refetches current inventory and both existing readers only once', async mode => {
  const f = await setup();
  await act(async () => { f.inventory.result.current.change({ location: 3 }); });
  await waitFor(() => expect(f.inventory.result.current.data?.location.id).toBe(3));
  const d = dispatchFixture(true); const applied = appliedSnapshot();
  const api = { read: vi.fn(async () => d.decode()), propose: vi.fn(), decide: vi.fn(async () => applied.operations[1]) };
  const store = createTransferDispatchReconciliationStore({ operationKey: () => decisionKey });
  const pane = renderHook(() => useTransferDispatchReconciliations({ controller: f.controller(), record: d.record, api, store,
    onConfirmed: (f.controller() as TransferController & { confirmTransferDispatchReconciliation?: (owner: DecisionOwner, op: DispatchReconciliationOperation) => void }).confirmTransferDispatchReconciliation }));
  await waitFor(() => expect(pane.result.current.snapshot).not.toBeNull());
  const reads = f.stockReads(); const counts = f.api.countCorrections.mock.calls.length; const rests = f.api.restitutions.mock.calls.length;
  const before = f.inventory.result.current.data;
  const freshInventory = deferred<Response>();
  f.fetcher.mockImplementationOnce(() => freshInventory.promise);
  act(() => { expect(pane.result.current.begin(1, 'accept')).toBe(true); pane.result.current.setReason(' verified '); expect(pane.result.current.review()).toBe(true); });
  if (mode === 'recovery') api.decide.mockRejectedValueOnce(new Error('lost response'));
  else api.read.mockResolvedValue(applied);
  await act(async () => { await pane.result.current.confirm(); });
  if (mode === 'recovery') {
    expect(f.transfer).not.toHaveBeenCalled(); expect(f.source).not.toHaveBeenCalled(); expect(f.stockReads()).toBe(reads);
    api.read.mockResolvedValue(applied);
    await act(async () => { await pane.result.current.recover(); });
  }
  expect(f.transfer).toHaveBeenCalledTimes(1); expect(f.source).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(f.stockReads()).toBe(reads + 1));
  expect(f.api.countCorrections.mock.calls.length).toBeGreaterThan(counts);
  expect(f.api.restitutions.mock.calls.length).toBeGreaterThan(rests);
  expect(f.inventory.result.current.data).toBe(before); // No historical 13/17 while current GET is pending.
  await act(async () => { freshInventory.resolve(new Response(JSON.stringify({ location: { id: 3, name: 'Other' },
    items: [{ variant_id: 1, catalog_entry_id: 1, brand: 'B', model: 'M', capacity_ah: 60, polarity: 'L', existing: 100, reserved: 2, available: 98 }],
    page: 1, page_size: f.inventory.result.current.query.size, total_variants: 1 }))); });
  await waitFor(() => expect(f.inventory.result.current.data?.items[0].existing).toBe(100n));
  expect(f.inventory.result.current.data?.items[0].available).toBe(98n);
  expect(f.inventory.result.current.query.location).toBe(3);
  await act(async () => { await pane.result.current.recover(); await pane.result.current.retry(1); });
  expect(f.transfer).toHaveBeenCalledTimes(1); expect(api.decide).toHaveBeenCalledTimes(1);
  pane.unmount(); f.pane.unmount(); f.inventory.unmount();
});

it.each(['propose', 'reject', 'accept'] as const)('dispatch reconciliation %s retires detached consent and never uses audit balances', async action => {
  const f = await setup(); const pin = await review(f); const owner = decisionOwner(f.controller().getTransferAuthority())!;
  f.pane.unmount(); const reads = f.stockReads();
  const op = { ...appliedSnapshot().operations[action === 'propose' ? 0 : 1], request_id: BigInt(id), actor_location_id: 2 as const, action };
  const before = f.inventory.result.current.data;
  const observe = vi.fn(() => f.recovery.eligibility(owner, pin).eligible);
  f.controller().subscribeTransferInvalidation(observe);
  act(() => f.controller().confirmTransferDispatchReconciliation(owner, op));
  expect(observe.mock.results[0].value).toBe(false);
  expect(f.transfer).toHaveBeenCalledTimes(1); expect(f.source).toHaveBeenCalledTimes(action === 'accept' ? 1 : 0);
  await waitFor(() => expect(f.stockReads()).toBe(reads + (action === 'accept' ? 1 : 0)));
  expect(f.inventory.result.current.data).toEqual(before);
  f.inventory.unmount();
});
it.each(['csrf', 'account', 'location', 'reentrant'] as const)('dispatch reconciliation confirmation fences %s owner retirement', async change => {
  const f = await setup(); const owner = decisionOwner(f.controller().getTransferAuthority())!;
  const reads = f.stockReads(); const data = f.inventory.result.current.data;
  const retire = () => {
    const session = f.controller().session; if (!session?.authenticated) throw new Error('Session missing');
    if (change === 'account') session.identity.account_id = 3;
    else if (change === 'location') session.identity.location.id = 3;
    else session.csrf_token = 'n'.repeat(43);
  };
  if (change === 'reentrant') f.controller().subscribeTransferInvalidation(retire); else retire();
  const after = vi.fn(); f.controller().subscribeTransferInvalidation(after);
  act(() => f.controller().confirmTransferDispatchReconciliation(owner, appliedSnapshot().operations[1]));
  expect(after).not.toHaveBeenCalled(); expect(f.source).not.toHaveBeenCalled();
  expect(f.stockReads()).toBe(reads); expect(f.inventory.result.current.data).toBe(data);
  expect(f.transfer).toHaveBeenCalledTimes(change === 'reentrant' ? 1 : 0);
  f.pane.unmount(); f.inventory.unmount();
});

it('real controller restitution acceptance refreshes readers once with both hooks mounted', async () => {
  const f = await setup();
  const pin = await review(f);
  const held = deferred<RestitutionOperation>();
  f.api.decideRestitution.mockImplementationOnce(() => held.promise);
  const reads = f.stockReads();
  const countReads = f.api.countCorrections.mock.calls.length;
  const data = f.inventory.result.current.data;
  let submitted!: Promise<void>;
  act(() => { submitted = f.pane.result.current.restitution.submit(pin, decisionInput); });
  expect(f.transfer).not.toHaveBeenCalled(); expect(f.source).not.toHaveBeenCalled();
  await act(async () => { held.resolve(operation()); await submitted; });
  expect(f.transfer).toHaveBeenCalledTimes(1);
  expect(f.source).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(f.stockReads()).toBe(reads + 1));
  expect(f.api.countCorrections.mock.calls.length).toBeGreaterThan(countReads);
  expect(data?.items).toEqual([]); // Cache invalidation, never optimistic stock.
  f.pane.unmount();
  const again = f.mount();
  await waitFor(() => expect(again.result.current.restitution.snapshot).not.toBeNull());
  expect(f.controller().restitutionRecovery).toBe(f.recovery);
  await act(async () => { await again.result.current.restitution.retry(201); });
  expect(f.api.decideRestitution).toHaveBeenCalledTimes(1);
  expect(f.transfer).toHaveBeenCalledTimes(1); expect(f.source).toHaveBeenCalledTimes(1);
  again.unmount(); f.inventory.unmount();
});

it.each(['propose', 'reject'] as const)('restitution %s notifies transfer readers without refreshing stock', async action => {
  const f = await setup(action !== 'propose');
  const pin = await review(f, action);
  f.api.decideRestitution.mockResolvedValueOnce(operation('reject'));
  const reads = f.stockReads();
  await act(async () => { await f.pane.result.current.restitution.submit(pin, action === 'propose' ? proposalInput : decisionInput); });
  expect(f.transfer).toHaveBeenCalledTimes(1); expect(f.source).not.toHaveBeenCalled();
  expect(f.stockReads()).toBe(reads);
  f.pane.unmount(); f.inventory.unmount();
});

it.each((['propose', 'reject', 'accept'] as const).flatMap(action =>
  (['accept', 'reject'] as const).map(reviewAction => ({ action, reviewAction }))))('count $action retires detached restitution $reviewAction consent before broadcasting (accept has zero delta)', async ({ action, reviewAction }) => {
  const f = await setup(); const pin = await review(f, reviewAction);
  const owner = decisionOwner(f.controller().getTransferAuthority())!;
  f.pane.unmount();
  expect(f.recovery.eligibility(owner, pin).eligible).toBe(true);
  // Another request must not retire this request's independently reviewed pin.
  await act(async () => { f.controller().confirmTransferCountCorrection(owner, { ...countOperation(action), request_id: BigInt(id) + 1n }); });
  expect(f.recovery.eligibility(owner, pin).eligible).toBe(true);
  f.transfer.mockClear(); f.source.mockClear();
  const reads = f.stockReads();
  const atBroadcast = vi.fn(() => f.recovery.eligibility(owner, pin).eligible);
  f.controller().subscribeTransferInvalidation(atBroadcast);
  const countPane = renderHook(() => useTransferCountCorrections({ controller: f.controller(), requestID: id, api: f.api }));
  await waitFor(() => expect(countPane.result.current.snapshot).not.toBeNull());
  const held = deferred<CountOperation>();
  if (action === 'propose') f.api.proposeCount.mockImplementationOnce(() => held.promise);
  else f.api.decideCount.mockImplementationOnce(() => held.promise);
  const input = { variant_id: 201, operation_key: 'count_operation_01', expected_revision: action === 'propose' ? '0' : '1', reason: 'count checked' };
  let submitted!: Promise<void>;
  act(() => { submitted = action === 'propose' ? countPane.result.current.propose({ ...input, actual_quantity: '4' }) : countPane.result.current.decide(action, input); });
  expect(f.recovery.eligibility(owner, pin).eligible).toBe(true);
  await act(async () => { held.resolve(countOperation(action)); await submitted; });
  expect(f.recovery.eligibility(owner, pin).eligible).toBe(false);
  expect(atBroadcast).toHaveBeenCalledTimes(1); expect(atBroadcast.mock.results[0].value).toBe(false);
  expect(f.transfer).toHaveBeenCalledTimes(1);
  expect(f.source).toHaveBeenCalledTimes(action === 'accept' ? 1 : 0);
  await waitFor(() => expect(f.stockReads()).toBe(reads + (action === 'accept' ? 1 : 0)));
  countPane.unmount(); f.inventory.unmount();
});

it.each(['malformed', 'network'] as const)('preserves %s acceptance uncertainty across pane remount and confirms exact retry once', async failure => {
  const f = await setup(); const pin = await review(f);
  const reads = f.stockReads();
  if (failure === 'malformed') f.api.decideRestitution.mockResolvedValueOnce({ ...operation(), source_existing_after: 12n });
  else f.api.decideRestitution.mockRejectedValueOnce(new RestitutionAPIError('network', null, true));
  await act(async () => { await f.pane.result.current.restitution.submit(pin, decisionInput); });
  expect(f.pane.result.current.restitution.attempts[0].phase).toBe('uncertain');
  expect(f.transfer).not.toHaveBeenCalled(); expect(f.source).not.toHaveBeenCalled(); expect(f.stockReads()).toBe(reads);
  const recovery = f.controller().restitutionRecovery;
  f.pane.unmount(); const again = f.mount();
  await waitFor(() => expect(again.result.current.restitution.snapshot).not.toBeNull());
  expect(f.controller().restitutionRecovery).toBe(recovery);
  expect(again.result.current.restitution.attempts[0].phase).toBe('uncertain');
  expect(f.api.decideRestitution).toHaveBeenCalledTimes(1);
  await act(async () => { await again.result.current.restitution.retry(201); });
  const calls = f.api.decideRestitution.mock.calls as unknown[][];
  expect(calls[1].slice(0, 5)).toEqual(calls[0].slice(0, 5));
  expect(f.transfer).toHaveBeenCalledTimes(1); expect(f.source).toHaveBeenCalledTimes(1);
  await act(async () => { await again.result.current.restitution.retry(201); });
  expect(f.transfer).toHaveBeenCalledTimes(1); expect(f.source).toHaveBeenCalledTimes(1);
  again.unmount(); f.inventory.unmount();
});

it('isolates subscriber exceptions and rechecks owner after reentrant transfer callbacks', async () => {
  const f = await setup(); const pin = await review(f);
  const unsubscribeThrow = f.controller().subscribeTransferInvalidation(() => { throw new Error('subscriber failed'); });
  const healthy = vi.fn(); f.controller().subscribeTransferInvalidation(healthy);
  f.controller().subscribeSourceInventoryInvalidation(() => { throw new Error('source failed'); });
  const healthySource = vi.fn(); f.controller().subscribeSourceInventoryInvalidation(healthySource);
  await act(async () => { await f.pane.result.current.restitution.submit(pin, decisionInput); });
  expect(healthy).toHaveBeenCalledTimes(1); expect(healthySource).toHaveBeenCalledTimes(1);
  unsubscribeThrow();
  const owner = decisionOwner(f.controller().getTransferAuthority())!;
  const reads = f.stockReads();
  const recovery = f.controller().restitutionRecovery;
  f.controller().subscribeTransferInvalidation(() => {
    const session = f.controller().session;
    if (session?.authenticated) session.csrf_token = 'n'.repeat(43);
  });
  const afterChange = vi.fn(); f.controller().subscribeTransferInvalidation(afterChange);
  f.source.mockClear();
  act(() => { f.controller().confirmTransferRestitution!(owner, operation()); });
  expect(afterChange).not.toHaveBeenCalled(); expect(f.source).not.toHaveBeenCalled(); expect(f.stockReads()).toBe(reads);
  expect(recovery?.get(owner, BigInt(id))).toEqual([]);
  f.pane.unmount(); f.inventory.unmount();
});

it.each(['csrf', 'account', 'location'] as const)('fences ignored-abort late acceptance and retires detached recovery on %s change', async change => {
  const f = await setup(); const pin = await review(f);
  const owner = decisionOwner(f.controller().getTransferAuthority())!;
  const held = deferred<RestitutionOperation>(); f.api.decideRestitution.mockImplementationOnce(() => held.promise);
  let submitted!: Promise<void>;
  act(() => { submitted = f.pane.result.current.restitution.submit(pin, decisionInput); });
  f.pane.unmount();
  expect(f.recovery.get(owner, BigInt(id))[0].phase).toBe('uncertain');
  // Mutate the real controller's parsed authority, not a synthetic controller.
  const session = f.controller().session;
  if (!session?.authenticated) throw new Error('Missing authenticated session');
  if (change === 'csrf') session.csrf_token = 'n'.repeat(43);
  else if (change === 'account') session.identity.account_id = 3;
  else session.identity.location.id = 3;
  f.controller().getTransferAuthority();
  expect(f.recovery.get(decisionOwner(f.controller().getTransferAuthority()), BigInt(id))).toEqual([]);
  await act(async () => { held.resolve(operation()); await submitted; });
  expect(f.transfer).not.toHaveBeenCalled(); expect(f.source).not.toHaveBeenCalled();
  act(() => { f.controller().confirmTransferRestitution!(owner, operation()); });
  expect(f.transfer).not.toHaveBeenCalled();
  f.inventory.unmount();
});

it('acceptance invalidates the consulted third location and stops source fanout after reentrant owner change', async () => {
  const f = await setup();
  const callback = f.controller().confirmTransferRestitution;
  const recovery = f.controller().restitutionRecovery;
  await act(async () => { f.inventory.result.current.change({ location: 3 }); });
  await waitFor(() => expect(f.inventory.result.current.data?.location.id).toBe(3));
  expect(f.controller().confirmTransferRestitution).toBe(callback);
  expect(f.controller().restitutionRecovery).toBe(recovery);
  const pin = await review(f); const reads = f.stockReads();
  f.controller().subscribeSourceInventoryInvalidation(() => {
    const session = f.controller().session;
    if (session?.authenticated) session.identity.account_id = 3;
  });
  const obsoleteSource = vi.fn(); f.controller().subscribeSourceInventoryInvalidation(obsoleteSource);
  await act(async () => { await f.pane.result.current.restitution.submit(pin, decisionInput); });
  expect(f.transfer).toHaveBeenCalledTimes(1); expect(f.source).toHaveBeenCalledTimes(1);
  expect(obsoleteSource).not.toHaveBeenCalled();
  await waitFor(() => expect(f.stockReads()).toBe(reads + 1));
  expect(f.inventory.result.current.query.location).toBe(3);
  f.pane.unmount(); f.inventory.unmount();
});

it('controller restoration retires detached pins immediately at the auth epoch barrier', async () => {
  const f = await setup(); const pin = await review(f);
  const owner = decisionOwner(f.controller().getTransferAuthority())!;
  f.pane.unmount();
  const held = deferred<Response>(); f.fetcher.mockImplementationOnce(() => held.promise);
  let restored!: Promise<void>;
  act(() => { restored = f.controller().retrySession(); });
  expect(f.controller().getTransferAuthority().ready).toBe(false);
  expect(f.recovery.eligibility(owner, pin).eligible).toBe(false);
  act(() => { f.controller().confirmTransferRestitution!(owner, operation()); });
  expect(f.transfer).not.toHaveBeenCalled(); expect(f.source).not.toHaveBeenCalled();
  await act(async () => { held.resolve(new Response(JSON.stringify({ authenticated: false, csrf_token: 'a'.repeat(43) }))); await restored; });
  expect(f.controller().getTransferAuthority().epoch).toBeGreaterThan(owner.epoch);
  f.inventory.unmount();
});

it('GET reconciliation is the sole once-only acceptance effect source after uncertain POST', async () => {
  const f = await setup(); const pin = await review(f);
  f.api.decideRestitution.mockRejectedValueOnce(new RestitutionAPIError('network', null, true));
  await act(async () => { await f.pane.result.current.restitution.submit(pin, decisionInput); });
  const pending = history(); const line = pending.lines[0]; const proposal = line.proposals[0];
  const applied = captureRestitutions({ ...pending, operations: [...pending.operations, operation()],
    lines: [{ ...line, applied_revision: 1n, applied_retained_quantity: 1n, proposals: [{ ...proposal, state: 'applied',
      decision: { operation_key: decisionInput.operation_key, actor_location_id: 2, accepted: true, reason: decisionInput.reason, recorded_at: stamp },
      application: { operation_key: decisionInput.operation_key, origin_location_id: 1, quantity: 1n, recorded_at: stamp } }] }] });
  f.api.restitutions.mockResolvedValue(applied);
  const reads = f.stockReads();
  await act(async () => { await f.pane.result.current.restitution.recover(); });
  expect(f.pane.result.current.restitution.attempts[0].phase).toBe('confirmed');
  expect(f.transfer).toHaveBeenCalledTimes(1); expect(f.source).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(f.stockReads()).toBe(reads + 1));
  await act(async () => { await f.pane.result.current.restitution.recover(); });
  expect(f.transfer).toHaveBeenCalledTimes(1); expect(f.source).toHaveBeenCalledTimes(1);
  expect(f.api.decideRestitution).toHaveBeenCalledTimes(1);
  f.pane.unmount(); const again = f.mount();
  await waitFor(() => expect(again.result.current.restitution.snapshot).not.toBeNull());
  expect(f.transfer).toHaveBeenCalledTimes(1); expect(f.source).toHaveBeenCalledTimes(1);
  again.unmount(); f.inventory.unmount();
});
