import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { pageJSON } from './test-fixtures';
import { useInventory } from './useInventory';

const csrf = 'c'.repeat(43);
const anonymous = { authenticated: false, csrf_token: csrf };
const identity = { account_id: 1, username: 'component-user', location: { id: 1, name: 'Almacén' } };
const session = { authenticated: true, csrf_token: csrf, identity, expires_at: '2030-01-01T00:00:00Z' };
const metadata = { locations: [identity.location, { id: 2, name: 'Sucursal A' }, { id: 3, name: 'Sucursal B' }], brands: ['TOYO', 'CAR'] };
const response = (value: unknown, status = 200) => new Response(typeof value === 'string' ? value : JSON.stringify(value), { status });
class AppSource {
  static instances: AppSource[] = [];
  readyState = 0;
  listeners = new Map<string, Set<EventListener>>();
  close = vi.fn(() => { this.readyState = 2; });
  constructor(public url: string) { AppSource.instances.push(this); }
  addEventListener(kind: string, callback: EventListener) {
    const set = this.listeners.get(kind) ?? new Set(); set.add(callback); this.listeners.set(kind, set);
  }
  removeEventListener(kind: string, callback: EventListener) { this.listeners.get(kind)?.delete(callback); }
  emit(kind: string, data = '{}') { for (const callback of this.listeners.get(kind) ?? []) callback(new MessageEvent(kind, { data })); }
}
function setup(current: unknown = anonymous, override?: (url: string, init: RequestInit) => Promise<Response> | undefined) {
  AppSource.instances = []; vi.stubGlobal('EventSource', AppSource);
  const mock = vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const custom = override?.(url, init);
    if (custom) return custom;
    if (url === '/api/auth/validate') return Promise.resolve(response((current as typeof session).authenticated ? current : { authenticated: false }));
    if (url.endsWith('/session')) return Promise.resolve(response(current));
    if (url.endsWith('/login')) { current = session; return Promise.resolve(response(session)); }
    if (url.endsWith('/logout')) { current = anonymous; return Promise.resolve(new Response(null, { status: 204 })); }
    if (url.endsWith('/metadata')) return Promise.resolve(response(metadata));
    if (!url.startsWith('/api/inventory?')) throw new Error('Unexpected mocked URL: ' + url);
    const params = new URL(url, 'http://localhost').searchParams;
    const location = metadata.locations.find(l => String(l.id) === params.get('location_id')) ?? identity.location;
    return Promise.resolve(response(pageJSON().replace('"location":{"id":1,"name":"Almacén"}', '"location":' + JSON.stringify(location)).replace('"page_size":10', '"page_size":' + (params.get('page_size') ?? '10'))));
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}
async function inventory() { await screen.findByRole('table'); await screen.findByText('9007199254740993'); }
async function login() {
  await screen.findByLabelText('Usuario');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Iniciar sesión' })).toBeEnabled());
  fireEvent.change(screen.getByLabelText('Usuario'), { target: { value: 'component-user' } });
  fireEvent.change(screen.getByLabelText('Contraseña', { exact: true }), { target: { value: 'component-password' } });
  fireEvent.click(screen.getByRole('button', { name: 'Iniciar sesión' }));
  await inventory();
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const stockCalls = (mock: ReturnType<typeof setup>) => mock.mock.calls.filter(([url]) => String(url).startsWith('/api/inventory?'));
async function hookInventory(result: { current: ReturnType<typeof useInventory> }) {
  await waitFor(() => expect(result.current.data?.items[0].existing).toBe(9007199254740993n));
}

describe('R03 passive invalidation', () => {
  it('makes bootstrap and initial snapshots passive while explicit filter requests remain ordinary', async () => {
    const mock = setup(session); render(<App />); await inventory();
    for (const [, init] of mock.mock.calls) expect(new Headers(init?.headers).get('X-Luson-Passive')).toBe('1');
    fireEvent.change(screen.getByLabelText('Buscar marca o modelo'), { target: { value: 'manual' } });
    await inventory();
    expect(new Headers(mock.mock.calls.at(-1)![1]?.headers).has('X-Luson-Passive')).toBe(false);
  });
});

describe('R03 passive invalidation', () => {
  it('anonymous bootstrap never subscribes, login creates one source and mutations keep exact headers', async () => {
    const mock = setup(); render(<App />);
    await screen.findByLabelText('Usuario'); expect(AppSource.instances).toHaveLength(0);
    await login(); expect(AppSource.instances).toHaveLength(1);
    const post = mock.mock.calls.find(([url]) => String(url).endsWith('/login'))!;
    expect(post[1]?.headers).toEqual({ 'Content-Type': 'application/json', 'X-CSRF-Token': csrf });
    fireEvent.change(screen.getByLabelText('Buscar marca o modelo'), { target: { value: 'same-source' } });
    await inventory(); expect(AppSource.instances).toHaveLength(1);
  });
  it('open does not refetch; resync reads full metadata and current snapshot; transfers do not read stock', async () => {
    const mock = setup(session); render(<App />); await inventory();
    const source = AppSource.instances[0]; const before = mock.mock.calls.length;
    act(() => { source.emit('open'); source.emit('transfers'); source.emit('unknown'); source.emit('inventory', '{"record":1}'); });
    expect(mock.mock.calls).toHaveLength(before);
    act(() => source.emit('resync'));
    await waitFor(() => expect(stockCalls(mock)).toHaveLength(2)); await inventory();
    expect(mock.mock.calls.filter(([url]) => String(url).endsWith('/metadata'))).toHaveLength(2);
    for (const [, init] of mock.mock.calls.slice(before)) expect([...new Headers(init?.headers)]).toEqual([['x-luson-passive', '1']]);
    expect(mock.mock.calls.some(([url]) => String(url).startsWith('/api/transfers'))).toBe(false);
  });
  it('refreshes lossless stock without losing filter, page, focus, consulted location or assigned actor', async () => {
    let changed = false;
    const mock = setup(session, url => {
      if (!url.startsWith('/api/inventory?')) return undefined;
      const params = new URL(url, 'http://localhost').searchParams;
      let raw = pageJSON(undefined, Number(params.get('page'))).replace('"location":{"id":1,"name":"Almacén"}', '"location":{"id":3,"name":"Sucursal B"}');
      if (params.get('location_id') !== '3') return undefined;
      if (changed) raw = raw.replace('9007199254740993', '9007199254740995').replace('9007199254740992', '9007199254740994');
      return Promise.resolve(response(raw));
    });
    render(<App />); await inventory();
    fireEvent.click(screen.getByRole('button', { name: /Sucursal B/ })); await inventory();
    const search = screen.getByLabelText('Buscar marca o modelo'); search.focus();
    fireEvent.change(search, { target: { value: 'TOYO' } }); await inventory();
    fireEvent.change(screen.getByLabelText('Marca'), { target: { value: 'TOYO' } }); await inventory();
    fireEvent.change(screen.getByLabelText('Polaridad'), { target: { value: 'R' } }); await inventory();
    fireEvent.click(screen.getByRole('button', { name: 'Página siguiente' })); await inventory();
    const previousURL = stockCalls(mock).at(-1)![0]; changed = true;
    act(() => AppSource.instances[0].emit('inventory'));
    await screen.findByText('9007199254740995');
    expect(stockCalls(mock).at(-1)![0]).toBe(previousURL); expect(search).toHaveFocus();
    expect(search).toHaveValue('TOYO'); expect(screen.getByLabelText('Marca')).toHaveValue('TOYO');
    expect(screen.getByLabelText('Polaridad')).toHaveValue('R');
    expect(screen.getByText('2', { selector: '[aria-current="page"]' })).toBeInTheDocument();
    expect(screen.getByText('Almacén', { selector: '.assigned-location' })).toBeInTheDocument();
    expect(AppSource.instances).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar sesión' })); await screen.findByLabelText('Usuario');
    expect(mock.mock.calls.find(([url]) => String(url).endsWith('/logout'))![1]?.headers).toEqual({ 'X-CSRF-Token': csrf });
  });
  it('dirty in-flight bursts converge with one follow-up and do not publish the obsolete provisional snapshot', async () => {
    const pending = deferred<Response>(); let stocks = 0;
    const mock = setup(session, url => url.startsWith('/api/inventory?') && ++stocks === 1 ? pending.promise : undefined);
    const { result } = renderHook(() => useInventory());
    await waitFor(() => expect(stockCalls(mock)).toHaveLength(1));
    act(() => { for (let i = 0; i < 50; i++) AppSource.instances[0].emit(i % 2 ? 'inventory' : 'resync'); });
    expect(stockCalls(mock)).toHaveLength(1);
    await act(async () => pending.resolve(response(pageJSON().replace('TOYO', 'OBSOLETE'))));
    await hookInventory(result); expect(stockCalls(mock)).toHaveLength(2);
    expect(result.current.data?.items[0].brand).toBe('TOYO');
    expect(mock.mock.calls.filter(([url]) => String(url).endsWith('/metadata'))).toHaveLength(2);
  });
  it('invalidations during the follow-up cause another bounded latest read rather than dropping dirty work', async () => {
    const pending = deferred<Response>(); let stocks = 0;
    const mock = setup(session, url => url.startsWith('/api/inventory?') && ++stocks === 2 ? pending.promise : undefined);
    const { result } = renderHook(() => useInventory()); await hookInventory(result);
    act(() => AppSource.instances[0].emit('inventory')); await waitFor(() => expect(stocks).toBe(2));
    act(() => { for (let i = 0; i < 30; i++) AppSource.instances[0].emit('inventory'); });
    await act(async () => pending.resolve(response(pageJSON())));
    await waitFor(() => expect(stockCalls(mock)).toHaveLength(3)); await hookInventory(result);
    expect(result.current.query).toEqual({ location: 1, search: '', brand: '', polarity: '', page: 1, size: 10 });
  });
  it('healthy coalesced cookie-neutral probes preserve session object, query, snapshots and CSRF', async () => {
    const probe = deferred<Response>();
    const mock = setup(session, url => url === '/api/auth/validate' ? probe.promise : undefined);
    const { result } = renderHook(() => useInventory()); await hookInventory(result);
    act(() => result.current.change({ location: 3, search: 'literal', brand: 'TOYO', polarity: 'L' })); await hookInventory(result);
    const previous = { session: result.current.session, query: result.current.query, data: result.current.data };
    const reads = stockCalls(mock).length;
    act(() => { AppSource.instances[0].emit('error'); AppSource.instances[0].emit('error'); });
    expect(mock.mock.calls.filter(([url]) => url === '/api/auth/validate')).toHaveLength(1);
    await act(async () => probe.resolve(response(session)));
    expect(result.current.session).toBe(previous.session); expect(result.current.query).toBe(previous.query); expect(result.current.data).toBe(previous.data);
    expect(stockCalls(mock)).toHaveLength(reads); expect(AppSource.instances).toHaveLength(1);
    expect(mock.mock.calls.filter(([url]) => String(url).endsWith('/session'))).toHaveLength(1);
    const validation = mock.mock.calls.find(([url]) => url === '/api/auth/validate')![1]!;
    expect([...new Headers(validation.headers)]).toEqual([['x-luson-passive', '1']]);
    expect(validation.credentials).toBe('same-origin'); expect(validation.cache).toBe('no-store');
  });
  it.each(['503', 'network', 'invalid'])('keeps known protected state on unavailable probe %s', async kind => {
    const mock = setup(session, url => url === '/api/auth/validate'
      ? kind === 'network' ? Promise.reject(new Error('offline')) : Promise.resolve(response(kind === 'invalid' ? { authenticated: false, csrf_token: csrf } : {}, kind === '503' ? 503 : 200)) : undefined);
    const { result } = renderHook(() => useInventory()); await hookInventory(result);
    const previous = result.current.session; const data = result.current.data;
    act(() => AppSource.instances[0].emit('error'));
    await waitFor(() => expect(result.current.resultsError).not.toBe('Se interrumpió la conexión. Podés volver a consultar.'));
    expect(result.current.session).toBe(previous); expect(result.current.data).toBe(data);
    expect(mock.mock.calls.filter(([url]) => String(url).endsWith('/session'))).toHaveLength(1);
  });
  it.each(['identity', 'csrf'])('reconciles changed %s as new authority, aborting old readers before fresh assigned snapshot', async kind => {
    const old = deferred<Response>();
    const next = kind === 'csrf' ? { ...session, csrf_token: 'n'.repeat(43) }
      : { ...session, identity: { ...identity, account_id: 2, location: metadata.locations[1] } };
    const mock = setup(session, url => url === '/api/auth/validate' ? Promise.resolve(response(next)) : url.includes('search=old') ? old.promise : undefined);
    const { result } = renderHook(() => useInventory()); await hookInventory(result);
    act(() => result.current.change({ location: 3, search: 'old' }));
    await waitFor(() => expect(mock.mock.calls.some(([url]) => String(url).includes('search=old'))).toBe(true));
    const source = AppSource.instances[0]; act(() => source.emit('error'));
    await waitFor(() => expect(result.current.session?.csrf_token).toBe(next.csrf_token));
    await hookInventory(result); expect(result.current.query.search).toBe('');
    expect(result.current.query.location).toBe(next.identity.location.id); expect(source.close).toHaveBeenCalled();
    expect(AppSource.instances).toHaveLength(2);
    expect(mock.mock.calls.find(([url]) => String(url).includes('search=old'))![1]?.signal?.aborted).toBe(true);
    await act(async () => old.resolve(response({}, 401))); expect(result.current.session?.authenticated).toBe(true);
    await act(async () => result.current.logout());
    expect(mock.mock.calls.find(([url]) => String(url).endsWith('/logout'))![1]?.headers).toEqual({ 'X-CSRF-Token': next.csrf_token });
  });
  it('anonymous validate immediately clears authority and cookie-writing bootstrap must settle before login', async () => {
    const boot = deferred<Response>(); let restores = 0;
    const mock = setup(session, url => url === '/api/auth/validate' ? Promise.resolve(response({ authenticated: false }))
      : url.endsWith('/session') && restores++ > 0 ? boot.promise : undefined);
    const { result } = renderHook(() => useInventory()); await hookInventory(result);
    const source = AppSource.instances[0]; act(() => source.emit('error'));
    await waitFor(() => expect(result.current.session).toBeNull());
    expect(result.current.data).toBeNull(); expect(result.current.authBusy).toBe(true); expect(source.close).toHaveBeenCalled();
    await act(async () => result.current.login('component-user', 'password'));
    expect(mock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    await act(async () => boot.resolve(response({ ...anonymous, csrf_token: 'a'.repeat(43) })));
    expect(result.current.authBusy).toBe(false);
    await act(async () => result.current.login('component-user', 'password'));
    await hookInventory(result);
    expect(mock.mock.calls.find(([url]) => String(url).endsWith('/login'))![1]?.headers).toEqual({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'a'.repeat(43) });
  });
  it('anonymous bootstrap can reconcile an external-tab login without accepting the consulted location as actor', async () => {
    let restores = 0;
    const next = { ...session, identity: { ...identity, account_id: 3, location: metadata.locations[2] } };
    setup(session, url => url === '/api/auth/validate' ? Promise.resolve(response({ authenticated: false }))
      : url.endsWith('/session') && restores++ > 0 ? Promise.resolve(response(next)) : undefined);
    const { result } = renderHook(() => useInventory()); await hookInventory(result);
    act(() => result.current.change({ location: 2, search: 'old' })); await hookInventory(result);
    act(() => AppSource.instances[0].emit('error'));
    await waitFor(() => expect(result.current.query.location).toBe(3)); await hookInventory(result);
    expect(result.current.query.search).toBe(''); expect(result.current.session).toMatchObject({ identity: next.identity });
  });
  it('obsolete source callbacks and probe responses cannot clear a subsequent login', async () => {
    const probe = deferred<Response>();
    const mock = setup(session, url => url === '/api/auth/validate' ? probe.promise : undefined);
    const { result } = renderHook(() => useInventory()); await hookInventory(result);
    const old = AppSource.instances[0]; const callback = [...old.listeners.get('inventory')!][0];
    act(() => old.emit('error'));
    const signal = mock.mock.calls.find(([url]) => url === '/api/auth/validate')![1]?.signal;
    await act(async () => result.current.logout()); expect(signal?.aborted).toBe(true);
    await act(async () => result.current.login('component-user', 'password')); await hookInventory(result);
    const reads = stockCalls(mock).length;
    await act(async () => { probe.resolve(response({ authenticated: false })); callback(new MessageEvent('inventory', { data: '{}' })); });
    expect(result.current.session?.authenticated).toBe(true); expect(stockCalls(mock)).toHaveLength(reads);
    expect(AppSource.instances).toHaveLength(2);
  });
  it('cookie-writing bootstrap timeout is uncertain and blocks all mutations and overlapping restores', async () => {
    const boot = deferred<Response>(); const mock = setup(anonymous, url => url.endsWith('/session') ? boot.promise : undefined);
    vi.useFakeTimers(); const { result, unmount } = renderHook(() => useInventory());
    await act(async () => vi.advanceTimersByTime(10000));
    expect(result.current.formError).not.toBe(''); expect(result.current.session).toBeNull();
    await act(async () => { await result.current.login('user', 'password'); await result.current.retrySession(); });
    expect(mock.mock.calls).toHaveLength(1); expect(mock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    await act(async () => boot.resolve(response(anonymous)));
    expect(result.current.session).toBeNull(); unmount(); expect(vi.getTimerCount()).toBe(0);
  });
  it('coalesces retries behind a cookie-writing bootstrap without overlapping cookie writers', async () => {
    const boot = deferred<Response>(); let restores = 0;
    const mock = setup(anonymous, url => url.endsWith('/session') && restores++ === 0 ? boot.promise : undefined);
    const { result, unmount } = renderHook(() => useInventory());
    let retry!: Promise<void>; act(() => { retry = result.current.retrySession(); });
    expect(mock.mock.calls).toHaveLength(1);
    await act(async () => boot.resolve(response(anonymous))); await act(async () => retry);
    expect(mock.mock.calls.filter(([url]) => String(url).endsWith('/session'))).toHaveLength(1);
    expect(mock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false); unmount();
  });
  it('manual retry and page/size reads touch; failed logout may reopen current authority passively', async () => {
    const mock = setup(session, url => url.endsWith('/logout') ? Promise.resolve(response({}, 503)) : undefined);
    const { result } = renderHook(() => useInventory()); await hookInventory(result);
    await act(async () => result.current.retryInventory()); await hookInventory(result);
    expect(new Headers(stockCalls(mock).at(-1)![1]?.headers).has('X-Luson-Passive')).toBe(false);
    act(() => result.current.change({ size: 25 }, true)); await hookInventory(result);
    expect(new Headers(stockCalls(mock).at(-1)![1]?.headers).has('X-Luson-Passive')).toBe(false);
    await act(async () => result.current.logout()); await hookInventory(result);
    expect(result.current.session?.authenticated).toBe(true); expect(AppSource.instances).toHaveLength(2);
    expect(new Headers(stockCalls(mock).at(-1)![1]?.headers).get('X-Luson-Passive')).toBe('1');
  });
  it('CLOSED recovery validates twice, creates one fresh source and resync refetches passively', async () => {
    const mock = setup(session); const { result, unmount } = renderHook(() => useInventory()); await hookInventory(result);
    vi.useFakeTimers(); const old = AppSource.instances[0]; old.readyState = 2;
    await act(async () => { old.emit('error'); old.emit('error'); });
    expect(mock.mock.calls.filter(([url]) => url === '/api/auth/validate')).toHaveLength(1);
    expect(AppSource.instances).toHaveLength(1);
    await act(async () => vi.advanceTimersByTime(1000));
    expect(AppSource.instances).toHaveLength(2);
    expect(mock.mock.calls.filter(([url]) => url === '/api/auth/validate')).toHaveLength(2);
    const before = stockCalls(mock).length;
    act(() => AppSource.instances[1].emit('open')); expect(stockCalls(mock)).toHaveLength(before);
    await act(async () => AppSource.instances[1].emit('resync'));
    expect(stockCalls(mock)).toHaveLength(before + 1);
    expect(result.current.resultsError).toBe('');
    expect(new Headers(stockCalls(mock).at(-1)![1]?.headers).get('X-Luson-Passive')).toBe('1');
    unmount(); expect(vi.getTimerCount()).toBe(0);
  });
  it('probe timeout aborts cookie-neutral work and ignores a late anonymous response without a bootstrap', async () => {
    const probe = deferred<Response>();
    const mock = setup(session, url => url === '/api/auth/validate' ? probe.promise : undefined);
    const { result, unmount } = renderHook(() => useInventory()); await hookInventory(result);
    vi.useFakeTimers(); act(() => AppSource.instances[0].emit('error'));
    await act(async () => vi.advanceTimersByTime(5000));
    expect(mock.mock.calls.find(([url]) => url === '/api/auth/validate')![1]?.signal?.aborted).toBe(true);
    await act(async () => probe.resolve(response({ authenticated: false })));
    expect(result.current.session?.authenticated).toBe(true); expect(result.current.data).not.toBeNull();
    expect(mock.mock.calls.filter(([url]) => String(url).endsWith('/session'))).toHaveLength(1);
    unmount(); expect(vi.getTimerCount()).toBe(0);
  });
  it('unsupported EventSource keeps a truthful error after the initial snapshot and ordinary manual retry', async () => {
    const mock = setup(session); vi.stubGlobal('EventSource', undefined);
    const { result } = renderHook(() => useInventory()); await hookInventory(result);
    expect(result.current.resultsError).toContain('Se interrumpió');
    expect(mock.mock.calls.filter(([url]) => url === '/api/auth/validate')).toHaveLength(1);
    await act(async () => result.current.retryInventory()); await hookInventory(result);
    expect(result.current.resultsError).toContain('Se interrumpió'); expect(AppSource.instances).toHaveLength(0);
    expect(new Headers(stockCalls(mock).at(-1)![1]?.headers).has('X-Luson-Passive')).toBe(false);
  });
  it('unmount aborts a cookie-writing bootstrap and ignores its late authority response', async () => {
    const boot = deferred<Response>();
    const mock = setup(anonymous, url => url.endsWith('/session') ? boot.promise : undefined);
    const { unmount } = renderHook(() => useInventory()); unmount();
    expect(mock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    await act(async () => boot.resolve(response(session))); expect(AppSource.instances).toHaveLength(0);
    expect(stockCalls(mock)).toHaveLength(0);
  });
  it('ordinary manual pagination captures a touching job while the next invalidation uses passive headers', async () => {
    const mock = setup(session, url => url.includes('page=2') ? Promise.resolve(response(pageJSON(undefined, 2))) : undefined);
    const { result } = renderHook(() => useInventory()); await hookInventory(result);
    act(() => result.current.change({ page: 2 }, true)); await hookInventory(result);
    expect(result.current.query.page).toBe(2);
    expect(new Headers(stockCalls(mock).at(-1)![1]?.headers).has('X-Luson-Passive')).toBe(false);
    await act(async () => AppSource.instances[0].emit('inventory')); await hookInventory(result);
    expect(result.current.query.page).toBe(2);
    expect(new Headers(stockCalls(mock).at(-1)![1]?.headers).get('X-Luson-Passive')).toBe('1');
  });
  it('absolute expiry clears protected authority and closes the source without touching the old session', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2029-12-31T23:59:59Z'));
    let restores = 0;
    const mock = setup(session, url => url.endsWith('/session') && restores++ > 0 ? Promise.resolve(response(anonymous)) : undefined);
    const { result, unmount } = renderHook(() => useInventory());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(result.current.session?.authenticated).toBe(true);
    await act(async () => vi.advanceTimersByTime(1000));
    expect(result.current.session?.authenticated).toBe(false); expect(result.current.data).toBeNull();
    expect(AppSource.instances[0].close).toHaveBeenCalled();
    for (const [, init] of mock.mock.calls) expect(new Headers(init?.headers).get('X-Luson-Passive')).toBe('1');
    unmount(); expect(vi.getTimerCount()).toBe(0);
  });
});

describe('cookie session lifecycle', () => {
  it('boots anonymous once, posts exact login JSON + memory CSRF only on submit; never browser storage', async () => {
    const mock = setup(); render(<App />); await login();
    const posts = mock.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0][0]).toBe('/api/auth/login');
    expect(posts[0][1]).toMatchObject({ credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ username: 'component-user', password: 'component-password' }) });
    expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
    expect(screen.getAllByText('component-user').length).toBeGreaterThan(0);
    expect(screen.queryByText('Encargado de almacén')).not.toBeInTheDocument();
  });
  it('bad credentials refresh anonymous CSRF and retry uses only the new memory token', async () => {
    let attempts = 0;
    let restores = 0;
    const fresh = 'n'.repeat(43);
    const mock = setup(anonymous, url => {
      if (url.endsWith('/session')) return Promise.resolve(response({ ...anonymous, csrf_token: restores++ ? fresh : csrf }));
      if (url.endsWith('/login') && attempts++ === 0) return Promise.resolve(response({}, 401));
      return undefined;
    });
    render(<App />);
    await screen.findByLabelText('Usuario');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Iniciar sesión' })).toBeEnabled());
    fireEvent.change(screen.getByLabelText('Usuario'), { target: { value: 'component-user' } });
    fireEvent.change(screen.getByLabelText('Contraseña', { exact: true }), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Iniciar sesión' }));
    await screen.findByText('Usuario o contraseña incorrectos.');
    await waitFor(() => expect(screen.getByLabelText('Usuario')).toHaveFocus());
    await login();
    const posts = mock.mock.calls.filter(([url]) => String(url).endsWith('/login'));
    expect(posts).toHaveLength(2);
    expect(posts[1][1]?.headers).toMatchObject({ 'X-CSRF-Token': fresh });
  });
  it('restores identity and inventory from GET session without a login POST', async () => {
    const mock = setup(session); render(<App />); await inventory();
    expect(mock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });
  it('logout succeeds only on 204 and obtains fresh anonymous CSRF', async () => {
    const mock = setup(session); render(<App />); await inventory();
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar sesión' }));
    await screen.findByLabelText('Usuario');
    await waitFor(() => expect(mock.mock.calls.filter(([url]) => String(url).endsWith('/session'))).toHaveLength(2));
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByText('component-user')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Usuario')).toHaveFocus();
  });
  it('does not accept a 200 logout as success', async () => {
    setup(session, url => url.endsWith('/logout') ? Promise.resolve(response({})) : undefined);
    render(<App />); await inventory(); fireEvent.click(screen.getByRole('button', { name: 'Cerrar sesión' }));
    await screen.findByText(/Respuesta inválida/);
    expect(screen.getByRole('table')).toBeInTheDocument();
  });
  it.each([400, 403, 429, 503])('announces truthful login failure %s in form', async status => {
    setup(anonymous, url => url.endsWith('/login') ? Promise.resolve(response({}, status)) : undefined);
    render(<App />);
    const user = userEvent.setup();
    await screen.findByLabelText('Usuario');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Iniciar sesión' })).toBeEnabled());
    await user.type(screen.getByLabelText('Usuario'), 'test'); await user.type(screen.getByLabelText('Contraseña', { exact: true }), 'test');
    await user.click(screen.getByRole('button', { name: 'Iniciar sesión' }));
    const messages: Record<number, string> = { 400: 'Solicitud inválida', 403: 'Solicitud no autorizada', 429: 'Demasiados intentos', 503: 'Servicio no disponible' };
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(messages[status]));
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Contraseña', { exact: true })).toHaveValue('');
  });
  it('expiry focuses and clears immediately while refresh is pending, then does not steal focus again', async () => {
    let restores = 0;
    let finish!: (response: Response) => void;
    setup(session, url => {
      if (url.endsWith('/session') && restores++ > 0) return new Promise(resolve => { finish = resolve; });
      if (url.includes('search=wait-expiry')) return Promise.resolve(response({}, 401));
      return undefined;
    });
    render(<App />); await inventory();
    fireEvent.change(screen.getByLabelText('Buscar marca o modelo'), { target: { value: 'wait-expiry' } });
    await screen.findByLabelText('Usuario');
    await waitFor(() => expect(screen.getByLabelText('Usuario')).toHaveFocus());
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByText('component-user')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Iniciar sesión' })).toBeDisabled();
    screen.getByLabelText('Contraseña', { exact: true }).focus();
    await act(async () => finish(response(anonymous)));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Iniciar sesión' })).toBeEnabled());
    expect(screen.getByLabelText('Contraseña', { exact: true })).toHaveFocus();
  });
  it('401 removes all protected rows/identity, refreshes anonymous CSRF and focuses login', async () => {
    const mock = setup(session, url => url.includes('search=expire') ? Promise.resolve(response({}, 401)) : undefined);
    render(<App />); await inventory();
    fireEvent.change(screen.getByLabelText('Buscar marca o modelo'), { target: { value: 'expire' } });
    await screen.findByLabelText('Usuario');
    await waitFor(() => expect(screen.getByLabelText('Usuario')).toHaveFocus());
    expect(screen.queryByText('component-user')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(mock.mock.calls.filter(([url]) => String(url).endsWith('/session'))).toHaveLength(2);
  });
});

describe('inventory interaction and stale guards', () => {
  it('maps filters AND omission, resets page atomically, keeps assignment and ordinary fetch focus', async () => {
    const mock = setup(session, url => url.includes('page=2') ? Promise.resolve(response(pageJSON('', 2))) : undefined);
    render(<App />); await inventory();
    fireEvent.click(screen.getByRole('button', { name: 'Página siguiente' }));
    await waitFor(() => expect(screen.getByText('2', { selector: '[aria-current="page"]' })).toBeInTheDocument());
    const search = screen.getByLabelText('Buscar marca o modelo'); search.focus();
    fireEvent.change(search, { target: { value: 'á_%\\' } });
    await waitFor(() => expect(mock.mock.calls.some(([url]) => String(url).includes('search='))).toBe(true));
    expect(search).toHaveFocus();
    fireEvent.change(screen.getByLabelText('Marca'), { target: { value: 'TOYO' } });
    fireEvent.change(screen.getByLabelText('Polaridad'), { target: { value: 'R' } });
    fireEvent.click(screen.getByRole('button', { name: /Sucursal B/ }));
    fireEvent.change(screen.getByLabelText('Filas por página'), { target: { value: '25' } });
    await waitFor(() => {
      const urls = mock.mock.calls.map(([url]) => String(url));
      const last = new URL(urls.at(-1)!, 'http://localhost');
      expect(Object.fromEntries(last.searchParams)).toEqual({ location_id: '3', page: '1', page_size: '25', search: 'á_%\\', brand: 'TOYO', polarity: 'R' });
    });
    expect(screen.getByText('Almacén', { selector: '.assigned-location' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Sucursal B/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Transferencias' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Nueva transferencia/ })).toBeDisabled();
  });
  it.each(['success', 'error'])('ignores obsolete %s even when transport ignores AbortSignal', async kind => {
    let finish!: (r: Response) => void;
    const mock = setup(session, url => url.includes('search=old') ? new Promise(resolve => { finish = resolve; }) : undefined);
    render(<App />); await inventory();
    fireEvent.change(screen.getByLabelText('Buscar marca o modelo'), { target: { value: 'old' } });
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    fireEvent.change(screen.getByLabelText('Buscar marca o modelo'), { target: { value: 'new' } });
    await inventory();
    const old = mock.mock.calls.find(([url]) => String(url).includes('search=old'))!;
    expect(old[1]?.signal?.aborted).toBe(true);
    await act(async () => finish(kind === 'success' ? response(pageJSON().replace('TOYO', 'OBSOLETE')) : response({}, 401)));
    expect(screen.queryByText('OBSOLETE')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Usuario')).not.toBeInTheDocument();
  });
  it('ignores obsolete rejected fetch after a paging/size change and renders only the current page', async () => {
    let rejectOld!: (reason: Error) => void;
    setup(session, url => url.includes('page=2') ? new Promise((_, reject) => { rejectOld = reject; }) : undefined);
    render(<App />); await inventory();
    fireEvent.click(screen.getByRole('button', { name: 'Página siguiente' }));
    await waitFor(() => expect(rejectOld).toBeTypeOf('function'));
    fireEvent.change(screen.getByLabelText('Filas por página'), { target: { value: '50' } });
    await inventory();
    await act(async () => rejectOld(new Error('obsolete network failure')));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('1', { selector: '[aria-current="page"]' })).toBeInTheDocument();
    expect(screen.getByLabelText('Filas por página')).toHaveValue('50');
  });
  it('ignores late protected results after logout and a subsequent login', async () => {
    let finish!: (r: Response) => void;
    setup(session, url => url.includes('search=old') ? new Promise(resolve => { finish = resolve; }) : undefined);
    render(<App />); await inventory();
    fireEvent.change(screen.getByLabelText('Buscar marca o modelo'), { target: { value: 'old' } });
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar sesión' }));
    await login();
    await act(async () => finish(response({}, 401)));
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.queryByLabelText('Usuario')).not.toBeInTheDocument();
  });
  it('keeps results empty on current error and validates Unicode byte limit without a request', async () => {
    const mock = setup(session, url => url.includes('search=fail') ? Promise.resolve(response({}, 503)) : undefined);
    render(<App />); await inventory();
    fireEvent.change(screen.getByLabelText('Buscar marca o modelo'), { target: { value: 'fail' } });
    await screen.findByText(/Servicio no disponible/); expect(screen.queryByText('9007199254740993')).not.toBeInTheDocument();
    const before = mock.mock.calls.length;
    fireEvent.change(screen.getByLabelText('Buscar marca o modelo'), { target: { value: 'á'.repeat(65) } });
    await screen.findByText(/128 bytes/); expect(mock.mock.calls).toHaveLength(before);
  });
  it('uses warehouse-only mobile layout class, page-local singleton and server zero availability', async () => {
    const raw = pageJSON().replace('9007199254740993', '6').replace('"reserved":1', '"reserved":6').replace('9007199254740992', '0');
    setup(session, url => url.startsWith('/api/inventory?') ? Promise.resolve(response(raw)) : undefined);
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    const { container } = render(<App />); await screen.findByText('Sin disponible');
    expect(container.querySelector('.warehouse')).toBeInTheDocument();
    expect(screen.queryByText('Sin stock')).not.toBeInTheDocument();
    expect(screen.getByText('6', { selector: '.variant-bottom span:first-child b' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Transferencias' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Crear envío/ })).toBeDisabled();
    // CSS chooses the visible renderer at 768px; real geometry is verifier-owned.
    expect(container.querySelectorAll('.product-card')).toHaveLength(1);
    expect(container.querySelector('.product-card')).toHaveTextContent('1 variante');
  });
  it('branch assignment never opts into warehouse cards', async () => {
    setup({ ...session, identity: { ...identity, account_id: 2, location: metadata.locations[1] } });
    const { container } = render(<App />); await inventory();
    expect(container.querySelector('.warehouse')).not.toBeInTheDocument();
    expect(container.querySelectorAll('.product-card')).toHaveLength(0);
  });
});

describe('R04 controller transfer seams', () => {
  it('forwards resync and transfers with isolated listeners and owned cleanup', async () => {
    setup(session); const { result } = renderHook(() => useInventory()); await hookInventory(result);
    const first = vi.fn(() => { throw new Error('Subscriber failure'); }); const second = vi.fn();
    const detachFirst = result.current.subscribeTransferInvalidation(first);
    const detachSecond = result.current.subscribeTransferInvalidation(second);
    act(() => AppSource.instances[0].emit('inventory')); expect(second).not.toHaveBeenCalled();
    act(() => { AppSource.instances[0].emit('resync'); AppSource.instances[0].emit('transfers'); });
    expect(first).toHaveBeenCalledTimes(2); expect(second).toHaveBeenCalledTimes(2);
    expect(AppSource.instances).toHaveLength(1); expect(result.current.query.location).toBe(1);
    detachFirst(); detachSecond(); act(() => AppSource.instances[0].emit('transfers'));
    expect(second).toHaveBeenCalledTimes(2);
  });
  it('shares a bounded neutral probe and refuses an obsolete epoch', async () => {
    const probe = deferred<Response>();
    const mock = setup(session, url => url === '/api/auth/validate' ? probe.promise : undefined);
    const { result } = renderHook(() => useInventory()); await hookInventory(result);
    const epoch = result.current.authorityEpoch;
    let a!: Promise<unknown>; let b!: Promise<unknown>;
    act(() => { a = result.current.settleUnauthorized(epoch); b = result.current.settleUnauthorized(epoch); });
    await act(async () => { probe.resolve(response(session)); await Promise.all([a, b]); });
    expect(mock.mock.calls.filter(([url]) => url === '/api/auth/validate')).toHaveLength(1);
    const before = mock.mock.calls.length;
    await expect(result.current.settleUnauthorized(epoch - 1)).resolves.toBe('anonymous');
    expect(mock.mock.calls).toHaveLength(before);
  });
  it('shares an existing realtime probe and cools down subsequent transfer401 settlement', async () => {
    const probe = deferred<Response>(); const mock = setup(session, url => url === '/api/auth/validate' ? probe.promise : undefined);
    const { result } = renderHook(() => useInventory()); await hookInventory(result);
    let joined!: Promise<unknown>;
    act(() => { AppSource.instances[0].emit('error'); joined = result.current.settleUnauthorized(result.current.authorityEpoch); });
    await act(async () => { probe.resolve(response(session)); await joined; });
    await expect(result.current.settleUnauthorized(result.current.authorityEpoch)).resolves.toBe('unavailable');
    expect(mock.mock.calls.filter(([url]) => url === '/api/auth/validate')).toHaveLength(1);
  });
  it('bounds shared validation to five seconds even if the transport ignores abort', async () => {
    const probe = deferred<Response>();
    const mock = setup(session, url => url === '/api/auth/validate' ? probe.promise : undefined);
    const { result } = renderHook(() => useInventory()); await hookInventory(result);
    vi.useFakeTimers(); let pending!: Promise<unknown>;
    act(() => { pending = result.current.settleUnauthorized(result.current.authorityEpoch); });
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    await expect(pending).resolves.toBe('unavailable');
    const signal = mock.mock.calls.find(([url]) => url === '/api/auth/validate')![1]?.signal;
    expect(signal?.aborted).toBe(true); expect(result.current.session?.authenticated).toBe(true);
    await act(async () => probe.resolve(response({ authenticated: false })));
    expect(result.current.session?.authenticated).toBe(true);
    vi.useRealTimers();
  });
});
