import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useInventory } from './useInventory';
import { useTransfers } from './useTransfers';
import { createTransferAPI } from './transferAPI';
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
