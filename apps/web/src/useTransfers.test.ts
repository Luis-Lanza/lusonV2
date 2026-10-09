import { createElement } from 'react';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import TransferCreation from './TransferCreation';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useInventory } from './useInventory';
import { useTransfers } from './useTransfers';
import { createTransferAPI } from './transferAPI';
import { parseTransferRecord } from './transferModel';
import type { TransferAuthority, TransferController } from './useInventory';
import { pageJSON } from './test-fixtures';
import type { TransferCreateInput } from './transferModel';

class Source {
  static instances: Source[] = [];
  readyState = 0;
  listeners = new Map<string, Set<EventListener>>();
  close = vi.fn(() => { this.readyState = 2; });
  constructor(public url: string) { Source.instances.push(this); }
  addEventListener(kind: string, listener: EventListener) {
    const listeners = this.listeners.get(kind) ?? new Set(); listeners.add(listener); this.listeners.set(kind, listeners);
  }
  removeEventListener(kind: string, listener: EventListener) { this.listeners.get(kind)?.delete(listener); }
  emit(kind: string) { for (const listener of this.listeners.get(kind) ?? []) listener(new MessageEvent(kind, { data: '{}' })); }
}
const locations = [{ id: 1, name: 'Warehouse' }, { id: 2, name: 'Branch A' }, { id: 3, name: 'Branch B' }];
const csrf = 'c'.repeat(43);
const anonymous = { authenticated: false, csrf_token: csrf };
function session(id = 2, token = csrf) {
  return { authenticated: true, csrf_token: token, identity: { account_id: id, username: `account-${id}`, location: locations[id - 1] }, expires_at: '2030-01-01T00:00:00Z' };
}
function wire(branch = 2, id = '9007199254740993') {
  return { id, reference: `TR-${id.padStart(3, '0')}`, kind: 'request_stock', status: 'pending', created_at: '2026-04-02T00:00:00Z',
    creator_location_id: branch, creator_location_name: locations[branch - 1].name,
    origin_location_id: 1, origin_location_name: 'Warehouse', destination_location_id: branch, destination_location_name: locations[branch - 1].name,
    approver_location_id: 1, approver_location_name: 'Warehouse',
    items: [{ variant_id: 201, brand: 'Brand', model: 'Model', capacity_ah: '35.5', polarity: 'L', quantity: '9223372036854775807' }] };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const reply = (body: unknown, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function fixture(initial: unknown = session(), override?: (url: string, init: RequestInit) => Promise<Response> | undefined) {
  const env = { current: initial };
  Source.instances = []; vi.stubGlobal('EventSource', Source);
  const fetch = vi.fn((input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = String(input); const custom = override?.(url, init); if (custom) return custom;
    if (url === '/api/auth/session') return Promise.resolve(reply(env.current));
    if (url === '/api/auth/validate') return Promise.resolve(reply((env.current as typeof anonymous).authenticated ? env.current : { authenticated: false }));
    if (url === '/api/auth/logout') { env.current = anonymous; return Promise.resolve(new Response(null, { status: 204 })); }
    if (url === '/api/auth/login') return Promise.resolve(reply(env.current));
    if (url === '/api/inventory/metadata') return Promise.resolve(reply({ locations, brands: ['Brand'] }));
    if (url.startsWith('/api/inventory?')) {
      const q = new URL(url, 'http://localhost').searchParams;
      const loc = locations[Number(q.get('location_id')) - 1];
      return Promise.resolve(reply(pageJSON().replace('"location":{"id":1,"name":"Almacén"}', '"location":' + JSON.stringify(loc))));
    }
    const branch = (env.current as ReturnType<typeof session>).identity?.location.id === 3 ? 3 : 2;
    if (url.startsWith('/api/transfers?')) {
      const q = new URL(url, 'http://localhost').searchParams;
      const page = Number(q.get('page')); const page_size = Number(q.get('page_size'));
      return Promise.resolve(reply({ page, page_size, status: 'pending', total_count: '1', records: page === 1 ? [wire(branch)] : [] }));
    }
    if (url.startsWith('/api/transfers/')) return Promise.resolve(reply(wire(branch, url.slice('/api/transfers/'.length))));
    if (url === '/api/transfers' && init.method === 'POST') return Promise.resolve(reply(wire(branch), 201));
    throw new Error('Unexpected mock route');
  });
  vi.stubGlobal('fetch', fetch);
  return { env, fetch };
}
function harness(listEnabled = true, detailEnabled = true) {
  return renderHook(({ list, detail }) => {
    const controller = useInventory();
    const transfers = useTransfers({ controller, listEnabled: list, detailEnabled: detail });
    return { controller, transfers };
  }, { initialProps: { list: listEnabled, detail: detailEnabled } });
}
type HookResult = ReturnType<typeof harness>['result'];
async function loaded(result: HookResult) { await waitFor(() => expect(result.current.transfers.page?.total_count).toBe(1n)); }
const transferCalls = (fetch: ReturnType<typeof fixture>['fetch']) => fetch.mock.calls.filter(([url]) => String(url).startsWith('/api/transfers'));
const listCalls = (fetch: ReturnType<typeof fixture>['fetch']) => fetch.mock.calls.filter(([url]) => String(url).startsWith('/api/transfers?'));
const detailCalls = (fetch: ReturnType<typeof fixture>['fetch']) => fetch.mock.calls.filter(([url]) => String(url).startsWith('/api/transfers/'));
const passive = (call: [RequestInfo | URL, RequestInit?]) => new Headers(call[1]?.headers).get('X-Luson-Passive');
const attempt = (): TransferCreateInput => ({ kind: 'request_stock', counterparty_location_id: 1, retry_key: 'stable_hook_key_01', items: [{ variant_id: 201, quantity: '2' }] });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function boundedHarness(countsEnabled = true, actor = 2) {
  const a: TransferAuthority = { epoch: 1, ready: true, session: structuredClone(session(actor)) };
  const listeners = new Set<() => void>();
  const controller: TransferController = { authorityEpoch: 1, getTransferAuthority: () => a,
    subscribeTransferInvalidation: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    settleUnauthorized: vi.fn(async () => 'unavailable' as const) };
  const jobs: ReturnType<typeof deferred<Response>>[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    const job = deferred<Response>(); jobs.push(job); return job.promise;
  });
  const api = createTransferAPI(fetch);
  const hook = renderHook(({ enabled }) => useTransfers({ controller, api, countsEnabled: enabled }),
    { initialProps: { enabled: countsEnabled } });
  const emit = () => act(() => { for (const listener of listeners) listener(); });
  return { a, controller, listeners, jobs, fetch, hook, emit, api };
}

type DecisionHook = ReturnType<typeof useTransfers>;
type InventoryHook = ReturnType<typeof useInventory>;
function decisionFixture(actor = 1, original = wire(2, '1'), override?: Parameters<typeof fixture>[1], catalog = false) {
  const f = fixture(session(actor), (url, init) => {
    const custom = override?.(url, init); if (custom) return custom;
    if (url === '/api/transfers/counts') return Promise.resolve(reply({ pending_total: '9', action_count: '2' }));
    if (url.startsWith('/api/transfers?')) return Promise.resolve(reply({ page: 1, page_size: 25, status: 'pending', total_count: '1', records: [original] }));
    if (url.startsWith('/api/transfers/')) return Promise.resolve(reply(original));
    if (url.startsWith('/api/inventory?') && new URL(url, 'http://localhost').searchParams.get('page_size') === '50') {
      return Promise.resolve(reply(pageJSON(undefined, 1, 1).replace('"page_size":10', '"page_size":50').replace('"name":"Almacén"', '"name":"Warehouse"')));
    }
    return undefined;
  });
  let controller!: InventoryHook;
  const lanes: DecisionHook[] = [];
  function Lane({ index, owner }: { index: number; owner: InventoryHook }) {
    lanes[index] = useTransfers({ controller: owner, listEnabled: true, detailEnabled: true, countsEnabled: true });
    return null;
  }
  function Parent({ childrenVisible }: { childrenVisible: boolean }) {
    controller = useInventory();
    return createElement('div', null,
      childrenVisible ? [0, 1].map(index => createElement(Lane, { key: index, index, owner: controller })) : null,
      catalog && controller.metadata ? createElement(TransferCreation, { controller, metadata: controller.metadata, onBack: () => {} }) : null);
  }
  const view = render(createElement(Parent, { childrenVisible: true }));
  const ready = async () => {
    await waitFor(() => expect(lanes[0].page?.total_count).toBe(1n));
    await waitFor(() => expect(lanes[1].counts?.action_count).toBe(2n));
    await waitFor(() => expect(controller.data).not.toBeNull());
  };
  return { ...f, lanes, view, ready, original: parseTransferRecord(JSON.stringify(original)),
    get controller() { return controller; }, show: (visible: boolean) => view.rerender(createElement(Parent, { childrenVisible: visible })) };
}
const decisionOutcome = (original: ReturnType<typeof wire>, status: 'approved' | 'rejected') => ({ ...original, status,
  decision_location_id: original.approver_location_id, decided_at: '2026-04-03T00:00:00.000000001Z' });
const decisionPosts = (fetch: ReturnType<typeof fixture>['fetch']) => fetch.mock.calls.filter(([, init]) => init?.method === 'POST' && String(init?.body) === '{}');
const inventoryCalls = (fetch: ReturnType<typeof fixture>['fetch']) => fetch.mock.calls.filter(([url]) => String(url).startsWith('/api/inventory?'));

describe('A05b real controller decisions', () => {
  const otherBranch = { ...wire(2, '1'), origin_location_id: 3, origin_location_name: 'Branch B', approver_location_id: 3, approver_location_name: 'Branch B' };
  const send = { ...wire(2, '1'), kind: 'send_to_warehouse', origin_location_id: 2, origin_location_name: 'Branch A', destination_location_id: 1, destination_location_name: 'Warehouse' };
  it.each([wire(2, '1'), otherBranch, send].flatMap(original => (['approve', 'reject'] as const).map(action => ({ original, action }))))
   ('uses assigned persisted approver for $original.kind/$original.origin_location_id/$action, not consulted inventory', async ({ original, action }) => {
      const h = decisionFixture(original.approver_location_id, original, (_url, init) => init.method === 'POST'
        ? Promise.resolve(reply(decisionOutcome(original, action === 'approve' ? 'approved' : 'rejected'))) : undefined);
      await h.ready();
      act(() => h.controller.change({ location: original.approver_location_id === 1 ? 3 : 1 }));
      await waitFor(() => expect(h.controller.loading).toBe(false));
      await act(async () => { await h.lanes[0].decide(h.original, action); });
      expect(h.lanes[1].decision?.result).toMatchObject({ decision_location_id: original.approver_location_id });
      expect(decisionPosts(h.fetch)).toHaveLength(1);
      h.view.unmount();
    });
  it.each(['approve', 'reject'] as const)('SSE invalidations never replay an uncertain %s POST', async action => {
    const h = decisionFixture(1, wire(2, '1'), (_url, init) => init.method === 'POST' ? Promise.reject(new Error('unknown')) : undefined);
    await h.ready();
    await act(async () => { await h.lanes[0].decide(h.original, action).catch(() => {}); });
    for (const event of ['transfers', 'resync', 'inventory']) {
      act(() => Source.instances[0].emit(event));
      await waitFor(() => expect(h.lanes[0].listBusy).toBe(false));
      expect(h.lanes[1].decision).toMatchObject({ phase: 'uncertain', action, result: null });
      expect(decisionPosts(h.fetch)).toHaveLength(1);
    }
    h.view.unmount();
  });
  it.each(['approve', 'reject'] as const)('refuses a participant who is not the persisted approver on %s', async action => {
    const h = decisionFixture(2); await h.ready();
    await expect(h.lanes[0].decide(h.original, action)).rejects.toMatchObject({ code: 'forbidden', uncertainDecision: false });
    expect(decisionPosts(h.fetch)).toHaveLength(0); expect(h.lanes[0].decision).toBeNull(); h.view.unmount();
  });
  it.each((['approve', 'reject'] as const).flatMap(action => (['post', 'get'] as const).flatMap(operation =>
    (['account', 'location', 'csrf', 'username', 'expiry'] as const).flatMap(field =>
      (['terminal', 'unauthenticated'] as const).map(completion => ({ action, operation, field, completion }))))))
   ('fences retained callbacks and ignored-abort $operation $action on same-object $field change before render ($completion)', async ({ action, operation, field, completion }) => {
      const original = wire(2, '1'); const delayed = deferred<Response>();
      const h = decisionFixture(1, original, (url, init) => init.method === 'POST'
        ? operation === 'post' ? delayed.promise : Promise.reject(new Error('unknown'))
        : operation === 'get' && url === '/api/transfers/1' ? delayed.promise : undefined);
      await h.ready();
      if (operation === 'get') await act(async () => { await h.lanes[0].decide(h.original, action).catch(() => {}); });
      const saved = h.lanes[0]; let pending!: Promise<unknown>;
      act(() => { pending = (operation === 'post' ? saved.decide(h.original, action) : saved.recoverDecision()).catch(error => error); });
      const session = h.controller.getTransferAuthority().session;
      if (!session?.authenticated) throw new Error('fixture');
      if (field === 'account') session.identity.account_id = 99;
      if (field === 'location') session.identity.location = { id: 3, name: 'Branch B' };
      if (field === 'csrf') session.csrf_token = 'rotated';
      if (field === 'username') session.identity.username = 'replacement';
      if (field === 'expiry') session.expires_at = '2040-01-01T00:00:00Z';
      expect(saved.decision).toBeNull(); expect(saved.decisionError).toBeNull(); expect(saved.page).toBeNull();
      const calls = h.fetch.mock.calls.length;
      await expect(saved.retryDecision()).rejects.toMatchObject({ code: 'unauthenticated' });
      await expect(saved.recoverDecision()).rejects.toMatchObject({ code: 'unauthenticated' });
      await expect(saved.decide(h.original, action)).rejects.toMatchObject({ code: 'unauthenticated' });
      expect(h.fetch.mock.calls).toHaveLength(calls);
      await act(async () => { delayed.resolve(completion === 'unauthenticated' ? reply({ error: 'unauthenticated' }, 401) : reply(decisionOutcome(original, action === 'approve' ? 'approved' : 'rejected'))); await pending; });
      await expect(pending).resolves.toMatchObject({ code: 'aborted', uncertainDecision: true });
      expect(h.fetch.mock.calls.filter(([url]) => url === '/api/auth/validate')).toHaveLength(0);
      expect(saved.decision).toBeNull(); h.view.unmount();
    });
  it.each(['approve', 'reject'] as const)('unmounted %s transport abort cannot settle a remounted controller recovery or overlap retry', async action => {
    const original = wire(2, '1'); const delayed = deferred<Response>();
    const h = decisionFixture(1, original, (_url, init) => init.method === 'POST' ? delayed.promise : undefined);
    await h.ready(); let pending!: Promise<unknown>;
    act(() => { pending = h.lanes[0].decide(h.original, action).catch(error => error); });
    const post = decisionPosts(h.fetch)[0]; h.show(false);
    expect(post[1]?.signal?.aborted).toBe(true);
    h.show(true); await h.ready();
    expect(h.lanes[1].decision?.phase).toBe('inFlight');
    await expect(h.lanes[1].retryDecision()).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(h.lanes[1].recoverDecision()).rejects.toMatchObject({ code: 'invalid_request' });
    await act(async () => { delayed.resolve(reply(decisionOutcome(original, action === 'approve' ? 'approved' : 'rejected'))); await pending; });
    await expect(pending).resolves.toMatchObject({ code: 'aborted', uncertainDecision: true });
    expect(h.lanes[1].decision?.phase).toBe('uncertain'); expect(h.lanes[1].decision?.result).toBeNull();
    expect(decisionPosts(h.fetch)).toHaveLength(1); h.view.unmount();
  });
  it.each([[403, 'forbidden'], [404, 'not_found'], [409, 'insufficient_stock'], [503, 'service_unavailable']] as const)
    ('decision POST %s/%s remains sanitized, does not log out, and cannot silently replace an attempt', async (status, code) => {
      const h = decisionFixture(1, wire(2, '1'), (_url, init) => init.method === 'POST' ? Promise.resolve(reply({ error: code }, status)) : undefined);
      await h.ready();
      await act(async () => { await expect(h.lanes[0].decide(h.original, 'approve')).rejects.toMatchObject({ code, status, uncertainCreation: false }); });
      expect(h.controller.session?.authenticated).toBe(true);
      expect(h.fetch.mock.calls.filter(([url]) => url === '/api/auth/validate')).toHaveLength(0);
      if (status === 403 || status === 404) {
        expect(h.lanes[1].decision).toBeNull(); expect(h.lanes[0].decisionError).toBeNull();
      } else {
        expect(h.lanes[1].decision?.phase).toBe('uncertain'); expect(h.lanes[1].decisionError?.code).toBe(code);
      }
      await expect(h.lanes[1].decide({ ...h.original, id: '2', reference: 'TR-002' }, 'reject')).rejects.toMatchObject({ code: 'invalid_request' });
      expect(decisionPosts(h.fetch)).toHaveLength(1); h.view.unmount();
    });
  it.each(['post', 'get'] as const)('logout barriers hide the original immediately and stale %s 401 cannot settle resumed same-account authority', async operation => {
    const old = deferred<Response>(); const original = wire(2, '1');
    const h = decisionFixture(1, original, (url, init) => {
      if (url === '/api/auth/logout') return Promise.resolve(reply({ error: 'service_unavailable' }, 503));
      if (init.method === 'POST' && url.endsWith('/approve')) return operation === 'post' ? old.promise : Promise.reject(new Error('unknown'));
      return operation === 'get' && url === '/api/transfers/1' ? old.promise : undefined;
    });
    await h.ready();
    if (operation === 'get') await act(async () => { await h.lanes[0].decide(h.original, 'approve').catch(() => {}); });
    const saved = h.lanes[0]; let pending!: Promise<unknown>; let logout!: Promise<void>;
    act(() => { pending = (operation === 'post' ? saved.decide(h.original, 'approve') : saved.recoverDecision()).catch(error => error); });
    act(() => { logout = h.controller.logout(); expect(saved.decision).toBeNull(); });
    await act(async () => { await logout; }); await h.ready();
    await act(async () => { old.resolve(reply({ error: 'unauthenticated' }, 401)); await pending; });
    await expect(pending).resolves.toMatchObject({ code: 'aborted', uncertainDecision: true });
    await expect(saved.retryDecision()).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(h.lanes[1].decision).toBeNull(); expect(h.controller.session?.authenticated).toBe(true);
    expect(h.fetch.mock.calls.filter(([url]) => url === '/api/auth/validate')).toHaveLength(0);
    expect(decisionPosts(h.fetch)).toHaveLength(1); h.view.unmount();
  });
  it.each(['items', 'metadata', 'identity', 'action'] as const)('malformed/mismatched POST %s keeps the unknown immutable attempt and never invalidates', async failure => {
    const original = wire(2, '1');
    const patch = failure === 'items' ? { items: [{ ...original.items[0], quantity: '1' }] }
      : failure === 'metadata' ? { decision_location_id: 2 } : failure === 'action' ? { status: 'rejected' } : { created_at: '2026-04-02T00:00:00.000000001Z' };
    const h = decisionFixture(1, original, (_url, init) => init.method === 'POST' ? Promise.resolve(reply({ ...decisionOutcome(original, 'approved'), ...patch })) : undefined);
    await h.ready(); const inventory = inventoryCalls(h.fetch).length; const lists = listCalls(h.fetch).length;
    await act(async () => { await expect(h.lanes[0].decide(h.original, 'approve')).rejects.toMatchObject({ code: 'invalid_response', uncertainDecision: true }); });
    expect(h.lanes[1].decision).toMatchObject({ phase: 'uncertain', original: { created_at: original.created_at }, result: null });
    expect(inventoryCalls(h.fetch)).toHaveLength(inventory); expect(listCalls(h.fetch)).toHaveLength(lists);
    await expect(h.lanes[1].decide(h.original, 'reject')).rejects.toMatchObject({ code: 'invalid_request' });
    expect(decisionPosts(h.fetch)).toHaveLength(1); h.view.unmount();
  });
  it.each(['post', 'get'] as const)('current %s 401 settles exact authority through neutral validation', async operation => {
    const h = decisionFixture(1, wire(2, '1'), (url, init) => init.method === 'POST'
      ? operation === 'post' ? Promise.resolve(reply({ error: 'unauthenticated' }, 401)) : Promise.reject(new Error('unknown'))
      : operation === 'get' && url === '/api/transfers/1' ? Promise.resolve(reply({ error: 'unauthenticated' }, 401)) : undefined);
    await h.ready();
    if (operation === 'get') await act(async () => { await h.lanes[0].decide(h.original, 'approve').catch(() => {}); });
    h.env.current = anonymous;
    await act(async () => { await expect(operation === 'post' ? h.lanes[0].decide(h.original, 'approve') : h.lanes[0].recoverDecision()).rejects.toMatchObject({ code: 'unauthenticated', status: 401 }); });
    await waitFor(() => expect(h.controller.session?.authenticated).toBe(false));
    expect(h.lanes[0].decision).toBeNull(); expect(h.lanes[0].decisionError).toBeNull();
    expect(h.fetch.mock.calls.filter(([url]) => url === '/api/auth/validate')).toHaveLength(1); h.view.unmount();
  });
  it.each([403, 404] as const)('private recovery %s masks original/error without logout, later authorized Pending preserves uncertainty', async status => {
    let privateView = true;
    const h = decisionFixture(1, wire(2, '1'), (url, init) => init.method === 'POST' ? Promise.reject(new Error('unknown'))
      : url === '/api/transfers/1' && privateView ? Promise.resolve(reply({ error: status === 403 ? 'forbidden' : 'not_found' }, status)) : undefined);
    await h.ready();
    await act(async () => { await h.lanes[0].decide(h.original, 'reject').catch(() => {}); });
    await act(async () => { await expect(h.lanes[1].recoverDecision()).rejects.toMatchObject({ status }); });
    expect(h.lanes[0].decision).toBeNull(); expect(h.lanes[1].decisionError).toBeNull();
    expect(h.controller.session?.authenticated).toBe(true);
    expect(h.fetch.mock.calls.filter(([url]) => url === '/api/auth/validate')).toHaveLength(0);
    await expect(h.lanes[0].retryDecision()).rejects.toMatchObject({ code: 'invalid_request' });
    privateView = false;
    await act(async () => { await h.lanes[0].recoverDecision(); });
    expect(h.lanes[1].decision).toMatchObject({ phase: 'uncertain', result: null });
    expect(decisionPosts(h.fetch)).toHaveLength(1); h.view.unmount();
  });
  it.each(['network', 'service', 'items', 'metadata', 'identity'] as const)('unknown or mismatched GET %s preserves original uncertainty without publishing or invalidating', async failure => {
    const original = wire(2, '1');
    const h = decisionFixture(1, original, (url, init) => {
      if (init.method === 'POST') return Promise.reject(new Error('unknown'));
      if (url !== '/api/transfers/1') return undefined;
      if (failure === 'network') return Promise.reject(new Error('private transport'));
      if (failure === 'service') return Promise.resolve(reply({ error: 'service_unavailable' }, 503));
      const patch = failure === 'items' ? { items: [{ ...original.items[0], quantity: '1' }] }
        : failure === 'metadata' ? { decision_location_id: 2 } : { id: '2', reference: 'TR-002' };
      return Promise.resolve(reply({ ...decisionOutcome(original, 'approved'), ...patch }));
    });
    await h.ready();
    await act(async () => { await h.lanes[0].decide(h.original, 'approve').catch(() => {}); });
    const lists = listCalls(h.fetch).length; const inventory = inventoryCalls(h.fetch).length;
    await act(async () => { await expect(h.lanes[1].recoverDecision()).rejects.toMatchObject({ code: failure === 'network' ? 'network' : failure === 'service' ? 'service_unavailable' : 'invalid_response' }); });
    expect(h.lanes[0].decision).toMatchObject({ phase: 'uncertain', original: { id: '1' }, result: null });
    expect(String(h.lanes[1].decisionError)).not.toContain('private');
    expect(listCalls(h.fetch)).toHaveLength(lists); expect(inventoryCalls(h.fetch)).toHaveLength(inventory);
    expect(decisionPosts(h.fetch)).toHaveLength(1); h.view.unmount();
  });
  it.each(['post', 'get'] as const)('a new owner replacement is neither unlocked nor cleared by stale $operation success (%s)', async operation => {
    const original = wire(2, '1'); const old = deferred<Response>(); const newer = deferred<Response>(); let posts = 0; let recovering = false;
    const h = decisionFixture(1, original, (url, init) => {
      if (init.method === 'POST') return ++posts === 1 ? operation === 'post' ? old.promise : Promise.reject(new Error('unknown')) : newer.promise;
      return recovering && url === '/api/transfers/1' ? old.promise : undefined;
    });
    await h.ready(); let pending!: Promise<unknown>; let replacement!: Promise<unknown>;
    if (operation === 'get') { await act(async () => { await h.lanes[0].decide(h.original, 'approve').catch(() => {}); }); recovering = true; }
    act(() => { pending = (operation === 'post' ? h.lanes[0].decide(h.original, 'approve') : h.lanes[0].recoverDecision()).catch(error => error); });
    const saved = h.lanes[0];
    h.env.current = { ...session(1), identity: { ...session(1).identity, account_id: 2 } };
    act(() => Source.instances[0].emit('error'));
    await waitFor(() => expect(h.controller.session).toMatchObject({ identity: { account_id: 2 } }));
    expect(saved.decision).toBeNull();
    recovering = false;
    act(() => { replacement = h.lanes[1].decide(h.original, 'reject'); });
    await act(async () => { old.resolve(reply(decisionOutcome(original, 'approved'))); await pending; });
    expect(h.lanes[0].decision).toMatchObject({ phase: 'inFlight', action: 'reject', owner: { account: 2 } });
    await expect(h.lanes[0].retryDecision()).rejects.toMatchObject({ code: 'invalid_request' });
    await act(async () => { newer.resolve(reply(decisionOutcome(original, 'rejected'))); await replacement; });
    expect(h.lanes[0].decision).toMatchObject({ phase: 'confirmed', result: { status: 'rejected' } }); h.view.unmount();
  });
  it.each((['approve', 'reject'] as const).flatMap(action => (['post', 'sameGet', 'oppositeGet'] as const).map(mode => ({ action, mode }))))
   ('real creation catalog and inventory readers react only to actual approval from $action/$mode, with no SSE', async ({ action, mode }) => {
      const original = otherBranch;
      const status = (mode === 'oppositeGet' ? action === 'approve' ? 'rejected' : 'approved' : action === 'approve' ? 'approved' : 'rejected') as 'approved' | 'rejected';
      let reading = false;
      const h = decisionFixture(3, original, (url, init) => init.method === 'POST' ? mode === 'post'
        ? Promise.resolve(reply(decisionOutcome(original, status))) : Promise.reject(new Error('unknown'))
        : reading && url === '/api/transfers/1' ? Promise.resolve(reply(decisionOutcome(original, status))) : undefined, true);
      await h.ready(); await screen.findByText(/^TOYO ·/);
      const sourceCalls = () => inventoryCalls(h.fetch).filter(([url]) => new URL(String(url), 'http://localhost').searchParams.get('page_size') === '50');
      expect(sourceCalls()).toHaveLength(1);
      const inventory = inventoryCalls(h.fetch).length;
      await act(async () => { await h.lanes[0].decide(h.original, action).catch(() => {}); });
      if (mode !== 'post') { reading = true; await act(async () => { await h.lanes[1].recoverDecision(); }); }
      await waitFor(() => expect(sourceCalls()).toHaveLength(status === 'approved' ? 2 : 1));
      await waitFor(() => expect(inventoryCalls(h.fetch)).toHaveLength(inventory + (status === 'approved' ? 2 : 0)));
      if (status === 'approved') expect(passive(sourceCalls()[1])).toBe('1');
      expect(h.lanes[0].decision?.result?.status).toBe(status);
      expect(Source.instances).toHaveLength(1); expect(decisionPosts(h.fetch)).toHaveLength(1); h.view.unmount();
    });
  it('repeated confirmed retries coalesce dirty list/detail/count/inventory/catalog reads without assuming atomic snapshots', async () => {
    let delay = false;
    const waiting: { kind: string; job: ReturnType<typeof deferred<Response>>; url: string }[] = [];
    const original = otherBranch;
    const h = decisionFixture(3, original, (url, init) => {
      if (init.method === 'POST') return Promise.resolve(reply(decisionOutcome(original, 'approved')));
      if (!delay) return undefined;
      const kind = url.startsWith('/api/transfers?') ? 'list' : url === '/api/transfers/counts' ? 'counts'
        : url === '/api/transfers/1' ? 'detail' : url.startsWith('/api/inventory?') ? 'inventory' : '';
      if (!kind) return undefined;
      const job = deferred<Response>(); waiting.push({ kind, job, url }); return job.promise;
    }, true);
    await h.ready(); await screen.findByText(/^TOYO ·/);
    act(() => h.lanes.forEach(lane => lane.selectDetail('1')));
    await waitFor(() => expect(h.lanes[1].detail?.id).toBe('1'));
    delay = true;
    await act(async () => { await h.lanes[0].decide(h.original, 'approve'); });
    await waitFor(() => expect(waiting).toHaveLength(8));
    await act(async () => { await h.lanes[1].retryDecision(); });
    expect(waiting).toHaveLength(8); expect(h.lanes[0].counts).toBeNull();
    const lists = listCalls(h.fetch).length; const inventory = inventoryCalls(h.fetch).length;
    delay = false;
    await act(async () => {
      for (const { kind, job, url } of waiting) {
        const body = kind === 'list' ? { page: 1, page_size: 25, status: 'pending', total_count: '0', records: [] }
          : kind === 'counts' ? { pending_total: '0', action_count: '0' }
          : kind === 'detail' ? original
          : pageJSON(undefined, 1, 1).replace('"page_size":10', '"page_size":' + new URL(url, 'http://localhost').searchParams.get('page_size'))
            .replace('"location":{"id":1,"name":"Almacén"}', '"location":' + JSON.stringify(locations[Number(new URL(url, 'http://localhost').searchParams.get('location_id')) - 1]));
        job.resolve(reply(body));
      }
    });
    await waitFor(() => expect(listCalls(h.fetch)).toHaveLength(lists + 2));
    await waitFor(() => expect(inventoryCalls(h.fetch)).toHaveLength(inventory + 2));
    await waitFor(() => expect(h.lanes[1].counts?.pending_total).toBe(9n));
    expect(h.lanes[0].page?.total_count).toBe(1n); expect(h.lanes[1].detail?.id).toBe('1');
    expect(decisionPosts(h.fetch)).toHaveLength(2); h.view.unmount();
  });
  it.each(['approve', 'reject'] as const)('warehouse can %s, and completion refreshes all mounted lanes without SSE', async action => {
    const original = wire(2, '1');
    const h = decisionFixture(1, original, (url, init) => init.method === 'POST' && url.endsWith('/' + action)
      ? Promise.resolve(reply(decisionOutcome(original, action === 'approve' ? 'approved' : 'rejected'))) : undefined);
    await h.ready(); act(() => h.lanes.forEach(lane => lane.selectDetail('1')));
    await waitFor(() => expect(h.lanes[1].detail?.id).toBe('1'));
    const lists = listCalls(h.fetch).length; const details = h.fetch.mock.calls.filter(([url]) => url === '/api/transfers/1').length;
    const counts = h.fetch.mock.calls.filter(([url]) => url === '/api/transfers/counts').length;
    const inventory = inventoryCalls(h.fetch).length;
    await act(async () => { await expect(h.lanes[0].decide(h.original, action)).resolves.toMatchObject({ status: action === 'approve' ? 'approved' : 'rejected' }); });
    await waitFor(() => expect(listCalls(h.fetch)).toHaveLength(lists + 2));
    await waitFor(() => expect(h.fetch.mock.calls.filter(([url]) => url === '/api/transfers/counts')).toHaveLength(counts + 2));
    // Two passive detail reads plus the POST; snapshots remain independent.
    expect(h.fetch.mock.calls.filter(([url, init]) => url === '/api/transfers/1' && init?.method !== 'POST')).toHaveLength(details + 2);
    expect(h.lanes[1].decision?.phase).toBe('confirmed'); expect(h.lanes[0].counts?.pending_total).toBe(9n);
    await waitFor(() => expect(inventoryCalls(h.fetch)).toHaveLength(inventory + (action === 'approve' ? 1 : 0)));
    expect(decisionPosts(h.fetch)).toHaveLength(1); expect(Source.instances).toHaveLength(1); h.view.unmount();
  });
  it.each([wire(2, '1'), otherBranch, send].flatMap(original => (['approve', 'reject'] as const).map(action => ({ original, action }))))
   ('retains unknown $action/$original.kind/$original.origin_location_id across child remount, never auto-posts, and explicitly retries', async ({ original, action }) => {
    let failing = true;
    const h = decisionFixture(original.approver_location_id, original, (_url, init) => init.method === 'POST' ? failing ? Promise.reject(new Error('private transport'))
      : Promise.resolve(reply(decisionOutcome(original, action === 'approve' ? 'approved' : 'rejected'))) : undefined);
    await h.ready(); const saved = h.lanes[0];
    await act(async () => { await expect(saved.decide(h.original, action)).rejects.toMatchObject({ code: 'network', uncertainDecision: true, uncertainCreation: false }); });
    expect(h.lanes[1].decision?.original.id).toBe('1'); expect(String(h.lanes[0].decisionError)).not.toContain('private');
    h.show(false); h.show(true); await h.ready();
    expect(h.lanes[0].decision?.phase).toBe('uncertain'); expect(decisionPosts(h.fetch)).toHaveLength(1);
    expect(h.lanes[0].decisionError).toMatchObject({ code: 'network', uncertainDecision: true });
    await expect(saved.retryDecision()).rejects.toMatchObject({ code: 'unauthenticated' });
    await act(async () => { await expect(h.lanes[0].recoverDecision()).resolves.toMatchObject({ status: 'pending' }); });
    expect(h.lanes[0].decision?.phase).toBe('uncertain'); expect(decisionPosts(h.fetch)).toHaveLength(1);
    await expect(h.lanes[1].decide(h.original, action === 'approve' ? 'reject' : 'approve')).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(h.lanes[1].decide({ ...h.original, id: '2', reference: 'TR-002' }, action)).rejects.toMatchObject({ code: 'invalid_request' });
    failing = false; await act(async () => { await h.lanes[1].retryDecision(); });
    expect(decisionPosts(h.fetch).map(([, init]) => init?.body)).toEqual(['{}', '{}']); expect(h.lanes[0].decision?.phase).toBe('confirmed'); h.view.unmount();
  });
  it.each([wire(2, '1'), otherBranch, send].flatMap(original => (['approve', 'reject'] as const).flatMap(action =>
    (['approved', 'rejected'] as const).map(status => ({ original, action, status })))))
   ('authorized $original.kind/$original.origin_location_id recovery of $status for $action publishes persisted outcome and invalidates', async ({ original, action, status }) => {
      let terminal = false;
      const h = decisionFixture(original.approver_location_id, original, (url, init) => init.method === 'POST' ? Promise.resolve(reply({ error: 'decision_conflict' }, 409))
        : url === '/api/transfers/1' && terminal ? Promise.resolve(reply(decisionOutcome(original, status))) : undefined);
      await h.ready();
      act(() => h.lanes.forEach(lane => lane.selectDetail('1')));
      await waitFor(() => expect(h.lanes[1].detail?.id).toBe('1'));
      await act(async () => { await expect(h.lanes[0].decide(h.original, action)).rejects.toMatchObject({ code: 'decision_conflict' }); });
      expect(h.lanes[0].decision?.result).toBeNull(); expect(decisionPosts(h.fetch)).toHaveLength(1);
      const inventory = inventoryCalls(h.fetch).length; const lists = listCalls(h.fetch).length;
      const details = h.fetch.mock.calls.filter(([url]) => url === '/api/transfers/1').length;
      const counts = h.fetch.mock.calls.filter(([url]) => url === '/api/transfers/counts').length;
      terminal = true;
      await act(async () => { await expect(h.lanes[1].recoverDecision()).resolves.toMatchObject({ status, decided_at: '2026-04-03T00:00:00.000000001Z' }); });
      expect(h.lanes[0].decision?.phase).toBe(status === (action === 'approve' ? 'approved' : 'rejected') ? 'confirmed' : 'conflict');
      await waitFor(() => expect(listCalls(h.fetch)).toHaveLength(lists + 2));
      await waitFor(() => expect(h.fetch.mock.calls.filter(([url]) => url === '/api/transfers/1')).toHaveLength(details + 3));
      await waitFor(() => expect(h.fetch.mock.calls.filter(([url]) => url === '/api/transfers/counts')).toHaveLength(counts + 2));
      await waitFor(() => expect(h.lanes[0].detail?.status).toBe(status));
      await waitFor(() => expect(inventoryCalls(h.fetch)).toHaveLength(inventory + (status === 'approved' ? 1 : 0)));
      expect(decisionPosts(h.fetch)).toHaveLength(1); h.view.unmount();
    });
});

describe('A05a independent counts and authority fences', () => {
  it.each([1, 2, 3])('opt-in counts are passive for participant %s, not creation permission', async actor => {
    const h = boundedHarness(false, actor);
    expect(h.fetch).not.toHaveBeenCalled(); h.emit(); expect(h.fetch).not.toHaveBeenCalled();
    h.hook.rerender({ enabled: true });
    await waitFor(() => expect(h.jobs).toHaveLength(1));
    await act(async () => h.jobs[0].resolve(reply({ pending_total: '9007199254740993', action_count: '2' })));
    expect(h.hook.result.current.counts).toEqual({ pending_total: 9007199254740993n, action_count: 2n });
    expect(h.fetch.mock.calls[0][0]).toBe('/api/transfers/counts');
    expect([...new Headers(h.fetch.mock.calls[0][1]?.headers)]).toEqual([]);
    if (actor === 1) await expect(h.hook.result.current.submit(attempt())).rejects.toMatchObject({ code: 'forbidden' });
    h.hook.rerender({ enabled: false }); expect(h.hook.result.current.counts).toBeNull();
    h.emit(); expect(h.fetch).toHaveBeenCalledTimes(1); h.hook.unmount(); expect(h.listeners.size).toBe(0);
  });
  it('coalesces counts bursts, discards dirty snapshots and masks current failure', async () => {
    const h = boundedHarness(); await waitFor(() => expect(h.jobs).toHaveLength(1));
    h.emit(); h.emit(); h.emit();
    await act(async () => h.jobs[0].resolve(reply({ pending_total: '8', action_count: '4' })));
    expect(h.hook.result.current.counts).toBeNull(); await waitFor(() => expect(h.jobs).toHaveLength(2));
    await act(async () => h.jobs[1].resolve(reply({ pending_total: '3', action_count: '1' })));
    expect(h.hook.result.current.counts?.action_count).toBe(1n);
    h.emit(); expect(h.hook.result.current.counts).toBeNull();
    await act(async () => h.jobs[2].resolve(reply({ error: 'service_unavailable' }, 503)));
    expect(h.hook.result.current.counts).toBeNull(); expect(h.hook.result.current.countsError?.code).toBe('service_unavailable');
    h.hook.unmount(); expect(h.listeners.size).toBe(0);
  });
  it.each(['account', 'csrf', 'assignment', 'username', 'expiry', 'revoked'] as const)
    ('discards counts and saved callbacks on same-object %s change BEFORE rerender', async field => {
      const h = boundedHarness(); await waitFor(() => expect(h.jobs).toHaveLength(1));
      await act(async () => h.jobs[0].resolve(reply({ pending_total: '2', action_count: '1' })));
      const saved = h.hook.result.current;
      h.emit(); await waitFor(() => expect(h.jobs).toHaveLength(2));
      if (!h.a.session?.authenticated) throw new Error('fixture');
      if (field === 'account') h.a.session.identity.account_id = 99;
      if (field === 'csrf') h.a.session.csrf_token = 'different';
      if (field === 'assignment') h.a.session.identity.location.id = 3;
      if (field === 'username') h.a.session.identity.username = 'different';
      if (field === 'expiry') h.a.session.expires_at = '2040-01-01T00:00:00Z';
      if (field === 'revoked') h.a.ready = false;
      expect(saved.counts).toBeNull(); h.emit(); expect(h.jobs).toHaveLength(2);
      await act(async () => h.jobs[1].resolve(reply({ error: 'unauthenticated' }, 401)));
      expect(h.controller.settleUnauthorized).not.toHaveBeenCalled();
      expect(saved.countsError).toBeNull(); h.hook.unmount();
    });
  it('aborts disabled/unmounted counts and ignores transport that ignores AbortSignal', async () => {
    const h = boundedHarness(); await waitFor(() => expect(h.jobs).toHaveLength(1));
    h.hook.rerender({ enabled: false }); expect(h.fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
    h.hook.rerender({ enabled: true }); await waitFor(() => expect(h.jobs).toHaveLength(2));
    await act(async () => h.jobs[0].resolve(reply({ pending_total: '8', action_count: '8' })));
    expect(h.hook.result.current.counts).toBeNull();
    h.hook.unmount(); expect(h.fetch.mock.calls[1][1]?.signal?.aborted).toBe(true);
    await act(async () => h.jobs[1].resolve(reply({ error: 'unauthenticated' }, 401)));
    expect(h.controller.settleUnauthorized).not.toHaveBeenCalled();
  });
  it('accepts separate count/list snapshots without atomic equality or inferred actions', async () => {
    fixture(session(), url => url === '/api/transfers/counts' ? Promise.resolve(reply({ pending_total: '9', action_count: '3' })) : undefined);
    const { result } = renderHook(() => {
      const controller = useInventory(); return useTransfers({ controller, listEnabled: true, countsEnabled: true });
    });
    await waitFor(() => expect(result.current.counts?.action_count).toBe(3n));
    expect(result.current.page?.total_count).toBe(1n); expect(result.current.counts?.pending_total).toBe(9n);
  });
  it.each(['account', 'csrf', 'assignment', 'expiry'] as const)('masks settled list/detail on same-object %s mutation and fences retained actions', async field => {
    const h = boundedHarness(false);
    const fetch = vi.fn<typeof globalThis.fetch>(async input => String(input).includes('?')
      ? reply({ page: 1, page_size: 25, status: 'pending', total_count: '1', records: [wire(2, '1')] }) : reply(wire(2, '1')));
    const api = createTransferAPI(fetch);
    const hook = renderHook(() => useTransfers({ controller: h.controller, api, listEnabled: true, detailEnabled: true }));
    await waitFor(() => expect(hook.result.current.page?.total_count).toBe(1n));
    act(() => hook.result.current.selectDetail('1'));
    await waitFor(() => expect(hook.result.current.detail?.id).toBe('1'));
    const saved = hook.result.current;
    if (!h.a.session?.authenticated) throw new Error('fixture');
    if (field === 'account') h.a.session.identity.account_id = 99;
    if (field === 'csrf') h.a.session.csrf_token = 'new_token';
    if (field === 'assignment') h.a.session.identity.location.id = 3;
    if (field === 'expiry') h.a.session.expires_at = '2040-01-01T00:00:00Z';
    expect(saved.page).toBeNull(); expect(saved.detail).toBeNull(); expect(saved.selectedID).toBeNull();
    act(() => { saved.retryList(); saved.retryDetail(); saved.changeQuery({ page: 2 }); saved.selectDetail('2'); });
    await expect(saved.submit(attempt())).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(fetch).toHaveBeenCalledTimes(2); hook.unmount(); h.hook.unmount();
  });
  it('masks settled counts before any refresh when authority changes in place', async () => {
    const h = boundedHarness(); await waitFor(() => expect(h.jobs).toHaveLength(1));
    await act(async () => h.jobs[0].resolve(reply({ pending_total: '2', action_count: '1' })));
    const saved = h.hook.result.current; expect(saved.counts?.action_count).toBe(1n);
    if (!h.a.session?.authenticated) throw new Error('fixture');
    h.a.session.identity.account_id = 99;
    expect(saved.counts).toBeNull(); expect(saved.countsBusy).toBe(false); expect(saved.countsError).toBeNull();
    h.emit(); expect(h.fetch).toHaveBeenCalledTimes(1); h.hook.unmount();
  });
  it('rejects old counts and detached subscriptions after epoch/account replacement even with ignored abort', async () => {
    const h = boundedHarness(); await waitFor(() => expect(h.jobs).toHaveLength(1));
    const oldListener = [...h.listeners][0];
    h.a.epoch = 2; h.a.session = structuredClone(session(3)); h.hook.rerender({ enabled: true });
    await waitFor(() => expect(h.jobs).toHaveLength(2));
    expect(h.fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
    await act(async () => h.jobs[1].resolve(reply({ pending_total: '1', action_count: '0' })));
    act(() => oldListener()); expect(h.jobs).toHaveLength(2);
    await act(async () => h.jobs[0].resolve(reply({ error: 'unauthenticated' }, 401)));
    expect(h.hook.result.current.counts).toEqual({ pending_total: 1n, action_count: 0n });
    expect(h.controller.settleUnauthorized).not.toHaveBeenCalled(); expect(h.listeners.size).toBe(1);
    h.hook.unmount(); expect(h.listeners.size).toBe(0);
  });
  it('settles current counts401 through revoked/expired neutral authority and clears metrics', async () => {
    const h = boundedHarness(); await waitFor(() => expect(h.jobs).toHaveLength(1));
    const settle = vi.mocked(h.controller.settleUnauthorized);
    settle.mockImplementation(async () => { h.a.ready = false; h.a.session = null; return 'anonymous'; });
    await act(async () => h.jobs[0].resolve(reply({ error: 'unauthenticated' }, 401)));
    expect(settle).toHaveBeenCalledExactlyOnceWith(1); expect(h.hook.result.current.counts).toBeNull();
    expect(h.hook.result.current.countsError).toBeNull(); h.emit(); expect(h.jobs).toHaveLength(1);
    h.hook.unmount();
  });
  it('preserves independent list and detail while a count response is missing or malformed', async () => {
    const h = boundedHarness(false); const counts = deferred<Response>();
    const fetch = vi.fn<typeof globalThis.fetch>(async input => {
      const path = String(input);
      if (path === '/api/transfers/counts') return counts.promise;
      return path.includes('?') ? reply({ page: 1, page_size: 25, status: 'pending', total_count: '1', records: [wire(2, '1')] }) : reply(wire(2, '1'));
    });
    const api = createTransferAPI(fetch);
    const hook = renderHook(() => useTransfers({ controller: h.controller, api, listEnabled: true, detailEnabled: true, countsEnabled: true }));
    await waitFor(() => expect(hook.result.current.page?.total_count).toBe(1n));
    act(() => hook.result.current.selectDetail('1')); await waitFor(() => expect(hook.result.current.detail?.id).toBe('1'));
    expect(hook.result.current.counts).toBeNull(); expect(hook.result.current.countsBusy).toBe(true);
    await act(async () => counts.resolve(reply({ pending_total: '1' })));
    expect(hook.result.current.countsError?.code).toBe('invalid_response'); expect(hook.result.current.counts).toBeNull();
    expect(hook.result.current.page?.total_count).toBe(1n); expect(hook.result.current.detail?.id).toBe('1');
    hook.unmount(); h.hook.unmount();
  });
  it.each(['approved', 'rejected'] as const)('publishes %s detail only for the selected ID and physical participant', async status => {
    const h = boundedHarness(false, 1);
    const outcome = { ...wire(2, '1'), status, decision_location_id: 1, decided_at: '2028-01-01T00:00:00.000000001Z' };
    const fetch = vi.fn<typeof globalThis.fetch>(async () => reply(outcome));
    const hook = renderHook(() => useTransfers({ controller: h.controller, api: createTransferAPI(fetch), detailEnabled: true }));
    act(() => hook.result.current.selectDetail('1'));
    await waitFor(() => expect(hook.result.current.detail?.status).toBe(status));
    expect(hook.result.current.detail).toMatchObject({ decided_at: outcome.decided_at });
    act(() => hook.result.current.selectDetail('2'));
    await waitFor(() => expect(hook.result.current.detailError?.code).toBe('invalid_response'));
    expect(hook.result.current.detail).toBeNull(); hook.unmount(); h.hook.unmount();
  });
  it.each(['account', 'csrf'] as const)('rejects creation completion after same-object %s change without publishing or invalidating', async field => {
    const h = boundedHarness(false); const create = deferred<Response>();
    const fetch = vi.fn<typeof globalThis.fetch>().mockReturnValue(create.promise);
    const hook = renderHook(() => useTransfers({ controller: h.controller, api: createTransferAPI(fetch) }));
    let pending!: Promise<unknown>;
    act(() => { pending = hook.result.current.submit(attempt()).catch(error => error); });
    if (!h.a.session?.authenticated) throw new Error('fixture');
    if (field === 'account') h.a.session.identity.account_id = 99;
    else h.a.session.csrf_token = 'rotated';
    expect(hook.result.current.submitBusy).toBe(false);
    await act(async () => create.resolve(reply({ ...wire(), status: 'approved', decision_location_id: 1,
      decided_at: '2028-01-01T00:00:00Z', items: [{ ...wire().items[0], quantity: '2' }] }, 200)));
    await expect(pending).resolves.toMatchObject({ code: 'aborted', uncertainCreation: true });
    expect(hook.result.current.submitError).toBeNull(); expect(fetch).toHaveBeenCalledTimes(1);
    expect(h.controller.settleUnauthorized).not.toHaveBeenCalled(); hook.unmount(); h.hook.unmount();
  });
  it('requires returned selected status even when an injected API bypasses the decoder', async () => {
    const h = boundedHarness(false);
    const list = vi.spyOn(h.api, 'list').mockResolvedValue({ page: 1, page_size: 25, status: 'pending', total_count: 0n, records: [] });
    const hook = renderHook(() => useTransfers({ controller: h.controller, api: h.api, listEnabled: true }));
    await waitFor(() => expect(hook.result.current.page).not.toBeNull());
    act(() => hook.result.current.changeQuery({ status: 'approved' }));
    await waitFor(() => expect(hook.result.current.listError?.code).toBe('invalid_response'));
    expect(hook.result.current.page).toBeNull(); expect(list).toHaveBeenCalledTimes(2); hook.unmount(); h.hook.unmount();
  });
});

describe('R04 transfer hook', () => {
  it('has no protected reads while anonymous or disabled, then activates passively', async () => {
    const f = fixture(anonymous); const h = harness(false, false);
    await waitFor(() => expect(h.result.current.controller.authBusy).toBe(false));
    expect(transferCalls(f.fetch)).toHaveLength(0); expect(h.result.current.transfers.page).toBeNull(); h.unmount();
    const authorized = fixture(); const active = harness(false, false);
    await waitFor(() => expect(active.result.current.controller.data).not.toBeNull());
    expect(transferCalls(authorized.fetch)).toHaveLength(0);
    active.rerender({ list: true, detail: true }); await loaded(active.result);
    expect(passive(listCalls(authorized.fetch)[0])).toBe('1');
    active.rerender({ list: false, detail: false }); expect(active.result.current.transfers.page).toBeNull();
    active.rerender({ list: true, detail: true }); await loaded(active.result);
    expect(listCalls(authorized.fetch)).toHaveLength(2);
  });
  it.each([1, 2, 3])('reads real participant snapshots under assigned role %s', async actor => {
    const f = fixture(session(actor)); const { result } = harness(); await loaded(result);
    expect(result.current.transfers.page?.records[0].items[0].quantity).toBe(9223372036854775807n);
    act(() => result.current.transfers.selectDetail('9007199254740993'));
    await waitFor(() => expect(result.current.transfers.detail?.id).toBe('9007199254740993'));
    expect(Source.instances).toHaveLength(1);
    for (const [, init] of transferCalls(f.fetch)) expect(init).toMatchObject({ credentials: 'same-origin', cache: 'no-store' });
  });
  it('accepts explicit API injection without changing controller source ownership', async () => {
    const f = fixture(); const api = createTransferAPI(f.fetch); const list = vi.spyOn(api, 'list');
    const { result } = renderHook(() => {
      const controller = useInventory(); const transfers = useTransfers({ controller, api, listEnabled: true });
      return { controller, transfers };
    });
    await loaded(result); expect(list).toHaveBeenCalledTimes(1); expect(Source.instances).toHaveLength(1);
  });
  it('preserves authorized counts beyond safe Number precision', async () => {
    const records = Array.from({ length: 25 }, (_, i) => wire(2, String(9007199254740993n - BigInt(i))));
    fixture(session(), url => url.startsWith('/api/transfers?') ? Promise.resolve(reply({ page: 1, page_size: 25, status: 'pending', total_count: '9007199254740993', records })) : undefined);
    const { result } = harness();
    await waitFor(() => expect(result.current.transfers.page?.total_count).toBe(9007199254740993n));
    expect(result.current.transfers.page?.records[0].id).toBe('9007199254740993');
  });
  it('keeps zero private counts and inaccessible detail404 sanitized', async () => {
    const f = fixture(session(3), url => url.startsWith('/api/transfers?')
      ? Promise.resolve(reply({ page: 1, page_size: 25, status: 'pending', total_count: '0', records: [] }))
      : url.startsWith('/api/transfers/') ? Promise.resolve(reply({ error: 'not_found' }, 404)) : undefined);
    const { result } = harness(); await waitFor(() => expect(result.current.transfers.page?.total_count).toBe(0n));
    act(() => result.current.transfers.selectDetail('1'));
    await waitFor(() => expect(result.current.transfers.detailError?.code).toBe('not_found'));
    expect(result.current.transfers.detail).toBeNull(); expect(transferCalls(f.fetch)).toHaveLength(2);
  });
  it('forwards resync/transfers only, preserving source, consultation, selection and external draft', async () => {
    const f = fixture(); const { result } = harness(); await loaded(result);
    const draft = { quantity: '9007199254740993', key: 'caller_owned_key_1' };
    act(() => { result.current.controller.change({ location: 3 }); result.current.transfers.selectDetail('1'); });
    await waitFor(() => expect(result.current.transfers.detail?.id).toBe('1'));
    const count = listCalls(f.fetch).length;
    act(() => Source.instances[0].emit('inventory'));
    await waitFor(() => expect(result.current.controller.loading).toBe(false)); expect(listCalls(f.fetch)).toHaveLength(count);
    for (const event of ['resync', 'transfers']) {
      const before = listCalls(f.fetch).length;
      act(() => Source.instances[0].emit(event));
      await waitFor(() => expect(listCalls(f.fetch)).toHaveLength(before + 1));
      await waitFor(() => expect(result.current.transfers.listBusy).toBe(false));
      expect(passive(listCalls(f.fetch).at(-1)!)).toBe('1'); expect(passive(detailCalls(f.fetch).at(-1)!)).toBe('1');
    }
    expect(Source.instances).toHaveLength(1); expect(result.current.controller.query.location).toBe(3);
    expect(result.current.controller.session).toMatchObject({ identity: { location: { id: 2 } } });
    expect(result.current.transfers.selectedID).toBe('1'); expect(draft).toEqual({ quantity: '9007199254740993', key: 'caller_owned_key_1' });
  });
  it('captures manual page/size/detail/retry headers without inventing filters', async () => {
    const f = fixture(); const { result } = harness(); await loaded(result);
    act(() => result.current.transfers.changeQuery({ page: 2, page_size: 10 }));
    await waitFor(() => expect(result.current.transfers.page?.page).toBe(2));
    expect(result.current.transfers.page?.records).toEqual([]); expect(listCalls(f.fetch)).toHaveLength(2);
    expect(passive(listCalls(f.fetch)[1])).toBeNull();
    act(() => result.current.transfers.retryList()); await waitFor(() => expect(listCalls(f.fetch)).toHaveLength(3));
    act(() => result.current.transfers.selectDetail('1')); await waitFor(() => expect(result.current.transfers.detail?.id).toBe('1'));
    expect(passive(detailCalls(f.fetch)[0])).toBeNull();
    act(() => result.current.transfers.retryDetail()); await waitFor(() => expect(detailCalls(f.fetch)).toHaveLength(2));
    expect(passive(detailCalls(f.fetch)[1])).toBeNull();
    expect(() => act(() => result.current.transfers.changeQuery({ search: 'private' } as never))).toThrow();
    expect(() => act(() => result.current.transfers.selectDetail('01'))).toThrow();
  });
  it('coalesces dirty in-flight bursts for both lanes into one passive follow-up', async () => {
    const list = deferred<Response>(); const detail = deferred<Response>(); let firstList = true; let firstDetail = true;
    const f = fixture(session(), url => {
      if (url.startsWith('/api/transfers?') && firstList) { firstList = false; return list.promise; }
      if (url.startsWith('/api/transfers/') && firstDetail) { firstDetail = false; return detail.promise; }
      return undefined;
    });
    const { result } = harness(); await waitFor(() => expect(listCalls(f.fetch)).toHaveLength(1));
    act(() => result.current.transfers.selectDetail('1')); await waitFor(() => expect(detailCalls(f.fetch)).toHaveLength(1));
    act(() => { for (let i = 0; i < 8; i++) Source.instances[0].emit('transfers'); });
    expect(listCalls(f.fetch)).toHaveLength(1); expect(detailCalls(f.fetch)).toHaveLength(1);
    await act(async () => { list.resolve(reply({ page: 1, page_size: 25, status: 'pending', total_count: '0', records: [] })); detail.resolve(reply(wire(2, '1'))); });
    await loaded(result); await waitFor(() => expect(result.current.transfers.detail?.id).toBe('1'));
    expect(listCalls(f.fetch)).toHaveLength(2); expect(detailCalls(f.fetch)).toHaveLength(2);
    expect(passive(listCalls(f.fetch)[1])).toBe('1'); expect(passive(detailCalls(f.fetch)[1])).toBe('1');
  });
  it('supersedes obsolete query/detail data and errors even when abort is ignored', async () => {
    const oldList = deferred<Response>(); const oldDetail = deferred<Response>(); let first = true;
    const f = fixture(session(), url => {
      if (url.startsWith('/api/transfers?') && first) { first = false; return oldList.promise; }
      if (url === '/api/transfers/1') return oldDetail.promise;
      return undefined;
    });
    const { result } = harness(); await waitFor(() => expect(listCalls(f.fetch)).toHaveLength(1));
    act(() => { Source.instances[0].emit('transfers'); result.current.transfers.changeQuery({ page: 2 }); result.current.transfers.selectDetail('1'); });
    await waitFor(() => expect(result.current.transfers.page?.page).toBe(2));
    act(() => result.current.transfers.selectDetail('2')); await waitFor(() => expect(result.current.transfers.detail?.id).toBe('2'));
    await act(async () => { oldList.resolve(reply({ error: 'unauthenticated' }, 401)); oldDetail.resolve(reply(wire(2, '1'))); });
    expect(result.current.transfers.page?.page).toBe(2); expect(result.current.transfers.detail?.id).toBe('2');
    expect(listCalls(f.fetch)).toHaveLength(2); expect(f.fetch.mock.calls.filter(([u]) => u === '/api/auth/validate')).toHaveLength(0);
    expect(listCalls(f.fetch)[0][1]?.signal?.aborted).toBe(true);
  });
  it('coalesces current401 through neutral validation and never destructively restores healthy authority', async () => {
    const probe = deferred<Response>();
    const f = fixture(session(), url => url.startsWith('/api/transfers') ? Promise.resolve(reply({ error: 'unauthenticated' }, 401))
      : url === '/api/auth/validate' ? probe.promise : undefined);
    const { result } = harness(); await waitFor(() => expect(result.current.transfers.listError?.code).toBe('unauthenticated'));
    act(() => result.current.transfers.selectDetail('1'));
    await waitFor(() => expect(detailCalls(f.fetch)).toHaveLength(1));
    await act(async () => probe.resolve(reply(session())));
    expect(f.fetch.mock.calls.filter(([u]) => u === '/api/auth/validate')).toHaveLength(1);
    expect(f.fetch.mock.calls.filter(([u]) => u === '/api/auth/session')).toHaveLength(1);
    expect(result.current.controller.session).toMatchObject({ authenticated: true });
    expect(passive(f.fetch.mock.calls.find(([u]) => u === '/api/auth/validate')!)).toBe('1');
  });
  it('masks synchronously on logout and rejects stale stream/data401 after a new login', async () => {
    const old = deferred<Response>(); let delayed = false;
    const f = fixture(session(), url => url.startsWith('/api/transfers?') && delayed ? old.promise : undefined);
    const { result } = harness(); await loaded(result);
    const oldEpoch = result.current.controller.authorityEpoch;
    const stale = [...Source.instances[0].listeners.get('transfers')!][0];
    delayed = true; act(() => Source.instances[0].emit('transfers')); await waitFor(() => expect(listCalls(f.fetch)).toHaveLength(2));
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.controller.logout();
      expect(result.current.controller.getTransferAuthority().epoch).not.toBe(oldEpoch);
      expect(result.current.transfers.page).toBeNull();
    });
    expect(result.current.transfers.page).toBeNull(); await act(async () => pending);
    delayed = false; f.env.current = session(3);
    await act(async () => result.current.controller.login('ignored', 'ignored')); await loaded(result);
    await act(async () => { stale(new MessageEvent('transfers', { data: '{}' })); old.resolve(reply({ error: 'unauthenticated' }, 401)); });
    expect(result.current.controller.session).toMatchObject({ identity: { location: { id: 3 } } });
    expect(result.current.transfers.page?.records[0].destination_location_id).toBe(3);
    expect(f.fetch.mock.calls.filter(([u]) => u === '/api/auth/validate')).toHaveLength(0);
  });
  it.each([2, 3])('clears selected detail and resets query on changed CSRF for actor%s', async actor => {
    const f = fixture(); const { result } = harness(); await loaded(result);
    act(() => { result.current.transfers.selectDetail('1'); result.current.transfers.changeQuery({ page: 2 }); });
    await waitFor(() => expect(result.current.transfers.detail?.id).toBe('1'));
    const epoch = result.current.controller.authorityEpoch;
    f.env.current = session(actor, 'd'.repeat(43));
    act(() => Source.instances[0].emit('error'));
    await waitFor(() => expect(result.current.controller.authorityEpoch).not.toBe(epoch)); await loaded(result);
    expect(result.current.transfers.query.page).toBe(1); expect(result.current.transfers.selectedID).toBeNull();
    expect(result.current.transfers.detail).toBeNull(); expect(result.current.transfers.page?.records[0].destination_location_id).toBe(actor);
  });
  it('unmount detaches its subscriber and ignores late transport completions', async () => {
    const f = fixture(); const { result, unmount } = harness(); await loaded(result);
    const source = Source.instances[0]; const callbacks = [...source.listeners.get('transfers')!];
    const count = transferCalls(f.fetch).length; unmount();
    act(() => { for (const callback of callbacks) callback(new MessageEvent('transfers', { data: '{}' })); });
    expect(transferCalls(f.fetch)).toHaveLength(count); expect(source.close).toHaveBeenCalledTimes(1);
    expect(source.listeners.get('transfers')?.size).toBe(0);
  });
  it.each([201, 200])('submits once with memory authority and status%s, then invalidates passively', async status => {
    const f = fixture(session(), (url, init) => url === '/api/transfers' && init.method === 'POST' ? Promise.resolve(reply(wire(), status)) : undefined);
    const { result } = harness(); await loaded(result); const input = attempt(); const original = JSON.stringify(input);
    let outcome;
    await act(async () => { outcome = await result.current.transfers.submit(input); });
    expect(outcome).toMatchObject({ replayed: status === 200 }); expect(JSON.stringify(input)).toBe(original);
    const posts = transferCalls(f.fetch).filter(([, i]) => i?.method === 'POST'); expect(posts).toHaveLength(1);
    expect(new Headers(posts[0][1]?.headers).get('X-CSRF-Token')).toBe(csrf); expect(passive(posts[0])).toBeNull();
    await waitFor(() => expect(listCalls(f.fetch)).toHaveLength(2)); expect(passive(listCalls(f.fetch)[1])).toBe('1');
  });
  it.each([[403, 'forbidden'], [409, 'retry_conflict'], [409, 'insufficient_stock']] as const)('keeps authority on fixed status%s/%s without retry or logout', async (status, code) => {
    const f = fixture(session(), (u, i) => u === '/api/transfers' && i.method === 'POST' ? Promise.resolve(reply({ error: code }, status)) : undefined);
    const { result } = harness(); await loaded(result);
    await act(async () => { await expect(result.current.transfers.submit(attempt())).rejects.toMatchObject({ code }); });
    expect(result.current.transfers.submitError?.code).toBe(code); expect(result.current.controller.session?.authenticated).toBe(true);
    expect(transferCalls(f.fetch).filter(([, i]) => i?.method === 'POST')).toHaveLength(1);
    expect(f.fetch.mock.calls.filter(([u]) => u === '/api/auth/validate')).toHaveLength(0);
  });
  it('retains uncertain input/key for explicit retry and refuses warehouse creation', async () => {
    let fail = true;
    const f = fixture(session(), (u, i) => u === '/api/transfers' && i.method === 'POST' && fail ? Promise.reject(new Error('private raw transport')) : undefined);
    const { result, unmount } = harness(); await loaded(result); const input = attempt();
    await act(async () => { await expect(result.current.transfers.submit(input)).rejects.toMatchObject({ code: 'network', uncertainCreation: true }); });
    expect(String(result.current.transfers.submitError)).not.toContain('private'); fail = false;
    await act(async () => { await result.current.transfers.submit(input); });
    const posts = transferCalls(f.fetch).filter(([, i]) => i?.method === 'POST'); expect(posts).toHaveLength(2); expect(posts[0][1]?.body).toBe(posts[1][1]?.body);
    unmount(); const warehouse = fixture(session(1)); const h = harness(); await loaded(h.result);
    await act(async () => { await expect(h.result.current.transfers.submit(input)).rejects.toMatchObject({ code: 'forbidden' }); });
    expect(transferCalls(warehouse.fetch).some(([, i]) => i?.method === 'POST')).toBe(false);
  });
  it('retains manual mode when a push races a queued manual request', async () => {
    const f = fixture(); const { result } = harness(); await loaded(result);
    act(() => { result.current.transfers.retryList(); Source.instances[0].emit('transfers'); });
    await waitFor(() => expect(listCalls(f.fetch)).toHaveLength(3));
    expect(passive(listCalls(f.fetch)[1])).toBeNull(); expect(passive(listCalls(f.fetch)[2])).toBe('1');
  });
  it('keeps query/selection after failed logout under the same authority, with fresh passive data', async () => {
    const f = fixture(session(), url => url === '/api/auth/logout' ? Promise.resolve(reply({ error: 'service_unavailable' }, 503)) : undefined);
    const { result } = harness(); await loaded(result);
    act(() => { result.current.transfers.changeQuery({ page: 2 }); result.current.transfers.selectDetail('1'); });
    await waitFor(() => expect(result.current.transfers.detail?.id).toBe('1'));
    await act(async () => result.current.controller.logout());
    await waitFor(() => expect(result.current.transfers.page?.page).toBe(2));
    expect(result.current.transfers.selectedID).toBe('1'); expect(passive(listCalls(f.fetch).at(-1)!)).toBe('1');
  });
  it('rejects foreign returned records and malformed private counts without ghost metrics', async () => {
    const f = fixture(session(3), url => url.startsWith('/api/transfers?')
      ? Promise.resolve(reply({ page: 1, page_size: 25, status: 'pending', total_count: '1', records: [wire(2)] })) : undefined);
    const { result } = harness(); await waitFor(() => expect(result.current.transfers.listError?.code).toBe('invalid_response'));
    expect(result.current.transfers.page).toBeNull(); expect(listCalls(f.fetch)).toHaveLength(1);
  });
  it('anonymous neutral validation clears private state before the separate bootstrap', async () => {
    const f = fixture(); const { result } = harness(); await loaded(result);
    f.env.current = anonymous; act(() => Source.instances[0].emit('error'));
    await waitFor(() => expect(result.current.controller.authBusy).toBe(false));
    await waitFor(() => expect(result.current.controller.session?.authenticated).toBe(false));
    expect(result.current.transfers.page).toBeNull(); expect(result.current.transfers.detail).toBeNull();
    expect(f.fetch.mock.calls.filter(([u]) => u === '/api/auth/validate')).toHaveLength(1);
    expect(f.fetch.mock.calls.filter(([u]) => u === '/api/auth/session')).toHaveLength(2);
  });
  it('unavailable validation preserves authority but never fabricates a healthy transfer snapshot', async () => {
    const f = fixture(session(), u => u.startsWith('/api/transfers?') ? Promise.resolve(reply({ error: 'unauthenticated' }, 401))
      : u === '/api/auth/validate' ? Promise.resolve(reply({ error: 'service_unavailable' }, 503)) : undefined);
    const { result } = harness(); await waitFor(() => expect(result.current.transfers.listError?.code).toBe('unauthenticated'));
    expect(result.current.transfers.page).toBeNull(); expect(result.current.controller.session?.authenticated).toBe(true);
    expect(f.fetch.mock.calls.filter(([u]) => u === '/api/auth/session')).toHaveLength(1);
  });
  it('makes no disabled reads and reactivates only the selected detail lane', async () => {
    const f = fixture(); const h = harness(); await loaded(h.result);
    act(() => h.result.current.transfers.selectDetail('1')); await waitFor(() => expect(h.result.current.transfers.detail?.id).toBe('1'));
    h.rerender({ list: false, detail: false }); const count = transferCalls(f.fetch).length;
    act(() => Source.instances[0].emit('transfers')); expect(transferCalls(f.fetch)).toHaveLength(count);
    h.rerender({ list: false, detail: true }); await waitFor(() => expect(h.result.current.transfers.detail?.id).toBe('1'));
    expect(listCalls(f.fetch)).toHaveLength(1); expect(passive(detailCalls(f.fetch).at(-1)!)).toBe('1');
  });
  it('refuses a self-counterparty and simultaneous POST while retaining caller ownership', async () => {
    const deferredCreate = deferred<Response>();
    const f = fixture(session(), (u, i) => u === '/api/transfers' && i.method === 'POST' ? deferredCreate.promise : undefined);
    const { result } = harness(); await loaded(result);
    await expect(result.current.transfers.submit({ ...attempt(), counterparty_location_id: 2 })).rejects.toMatchObject({ code: 'invalid_request' });
    let pending!: Promise<unknown>; act(() => { pending = result.current.transfers.submit(attempt()); });
    await expect(result.current.transfers.submit(attempt())).rejects.toMatchObject({ code: 'invalid_request' });
    expect(transferCalls(f.fetch).filter(([, i]) => i?.method === 'POST')).toHaveLength(1);
    await act(async () => { deferredCreate.resolve(reply(wire(), 201)); await pending; });
  });
  it('never publishes an obsolete creation success under changed authority', async () => {
    const create = deferred<Response>(); const f = fixture(session(), (u, i) => u === '/api/transfers' && i.method === 'POST' ? create.promise : undefined);
    const { result } = harness(); await loaded(result);
    let outcome!: Promise<unknown>; act(() => { outcome = result.current.transfers.submit(attempt()).catch(error => error); });
    f.env.current = session(3, 'd'.repeat(43)); act(() => Source.instances[0].emit('error'));
    await waitFor(() => expect(result.current.controller.session).toMatchObject({ identity: { location: { id: 3 } } }));
    await act(async () => create.resolve(reply(wire(), 201)));
    await expect(outcome).resolves.toMatchObject({ code: 'aborted', uncertainCreation: true });
    expect(result.current.transfers.submitError).toBeNull(); expect(result.current.transfers.page?.records[0].destination_location_id).toBe(3);
  });
});
