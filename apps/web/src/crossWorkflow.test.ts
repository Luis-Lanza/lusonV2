import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useInventory } from './useInventory';
import { decisionOwner } from './transferDecisionRecovery';
import { appliedSnapshot, deferred } from './transferDispatchReconciliationStoreFixtures';
class QuietSource {
  addEventListener() {}
  removeEventListener() {}
  close() {}
}
afterEach(() => { vi.unstubAllGlobals(); });
// The legacy audit panes are gone; the surviving cross-workflow seam is the
// controller's unified confirmation, which both readers and the audit store share.
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
  const controller = () => inventory.result.current;
  const transfer = vi.fn(); const source = vi.fn();
  controller().subscribeTransferInvalidation(transfer);
  controller().subscribeSourceInventoryInvalidation(source);
  const stockReads = () => fetcher.mock.calls.filter(([url]) => String(url).startsWith('/api/inventory?')).length;
  return { inventory, controller, transfer, source, stockReads, fetcher };
}
it.each(['accept', 'reject'] as const)('exact historical confirmation invalidates readers once for %s and never substitutes audit balances', async action => {
  const f = await setup();
  await act(async () => { f.inventory.result.current.change({ location: 3 }); });
  await waitFor(() => expect(f.inventory.result.current.data?.location.id).toBe(3));
  const owner = decisionOwner(f.controller().getTransferAuthority())!;
  const reads = f.stockReads(); const before = f.inventory.result.current.data;
  const fresh = deferred<Response>();
  f.fetcher.mockImplementationOnce(() => fresh.promise);
  // The exact confirmed operation, as the unified hook broadcasts it after a write.
  const op = { ...appliedSnapshot().operations[1], request_id: BigInt('9007199254740993'), actor_location_id: 2 as const, action };
  act(() => f.controller().confirmTransferDispatchReconciliation(owner, op));
  expect(f.transfer).toHaveBeenCalledTimes(1);
  expect(f.source).toHaveBeenCalledTimes(action === 'accept' ? 1 : 0);
  expect(f.stockReads()).toBe(reads + (action === 'accept' ? 1 : 0));
  // No historical 13/17 from the operation's audit balances while current GET is pending.
  expect(f.inventory.result.current.data).toBe(before);
  if (action !== 'accept') { f.inventory.unmount(); return; }
  await act(async () => { fresh.resolve(new Response(JSON.stringify({ location: { id: 3, name: 'Other' },
    items: [{ variant_id: 1, catalog_entry_id: 1, brand: 'B', model: 'M', capacity_ah: 60, polarity: 'L', existing: 100, reserved: 2, available: 98 }],
    page: 1, page_size: f.inventory.result.current.query.size, total_variants: 1 }))); });
  await waitFor(() => expect(f.inventory.result.current.data?.items[0].existing).toBe(100n));
  expect(f.inventory.result.current.data?.items[0].available).toBe(98n);
  expect(f.inventory.result.current.query.location).toBe(3);
  f.inventory.unmount();
});
it.each(['csrf', 'account', 'location', 'reentrant'] as const)('confirmation fences %s owner retirement', async change => {
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
  f.inventory.unmount();
});
