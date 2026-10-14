import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
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
    if (url === '/api/transfers/counts') return Promise.resolve(countResponse('0', '0'));
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
async function inventory() { await screen.findByRole('table'); await within(screen.getByRole('region', { name: 'Resultados de inventario' })).findByText('9007199254740993'); }
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

const countCalls = (mock: ReturnType<typeof setup>) => mock.mock.calls.filter(([url]) => url === '/api/transfers/counts');
const transferResponse = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const countResponse = (action = '9007199254740993', total = '9007199254740994') => transferResponse({ pending_total: total, action_count: action });
const shellCount = () => within(screen.getByRole('navigation')).getByRole('status');
function passiveCounts(mock: ReturnType<typeof setup>) {
  for (const [, init] of countCalls(mock)) {
    expect(init?.method).toBe('GET'); expect(init?.body).toBeUndefined();
    expect([...new Headers(init?.headers)]).toEqual([]);
    expect(init?.credentials).toBe('same-origin'); expect(init?.cache).toBe('no-store');
  }
}

describe('W2 assigned warehouse creation entry', () => {
  it.each([2, 3])('opens warehouse creation without POST while consulting branch %s and keeps source fixed at 1', async consulted => {
    const mock = setup(session);
    render(<App />); await inventory();
    fireEvent.click(screen.getByRole('button', { name: new RegExp(metadata.locations[consulted - 1].name) }));
    await inventory();
    expect(new URL(String(stockCalls(mock).at(-1)![0]), 'http://localhost').searchParams.get('location_id'))
      .toBe(String(consulted));
    expect(screen.getByText('Almacén', { selector: '.assigned-location' })).toBeInTheDocument();
    const entry = screen.getByRole('button', { name: /Nueva transferencia/ });
    expect(entry).toBeEnabled();
    expect(mock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    const before = stockCalls(mock).length;
    fireEvent.click(entry);
    const route = await screen.findByRole('region', { name: 'Ruta física' });
    expect(within(route).getByText('Origen').parentElement).toHaveTextContent('Almacén');
    await screen.findByRole('region', { name: 'Catálogo de origen' });
    await waitFor(() => expect(stockCalls(mock).length).toBeGreaterThan(before));
    for (const [url] of stockCalls(mock).slice(before)) {
      const query = new URL(String(url), 'http://localhost').searchParams;
      expect(query.get('location_id')).toBe('1');
      expect(query.get('page_size')).toBe('50');
    }
    expect(mock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });
});

describe('R2 workflow action badges', () => {
  it.each([false, true])('truthfully exposes required actions when Pending is zero (mobile=%s)', async mobile => {
    vi.stubGlobal('matchMedia', () => ({ matches: mobile, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    const mock = setup(session, url => url === '/api/transfers/counts' ? Promise.resolve(countResponse('1', '0')) : undefined);
    render(<App />);
    const navigation = await screen.findByRole('navigation', { name: mobile ? 'Navegación móvil' : 'Navegación principal' });
    const status = within(navigation).getByRole('status');
    await waitFor(() => expect(status).toHaveTextContent(/acciones.*1/i));
    expect(status).not.toHaveTextContent(/aprobación/i);
    expect(within(navigation).getByRole('button', { name: 'Transferencias' }).querySelector('.transfer-action-badge')).toHaveTextContent('1');
    passiveCounts(mock);
    expect(mock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });
});

describe('D2 dispatch shell lifetime', () => {
  it('keeps uncertain dispatch across Inventory navigation, consults explicitly, and refreshes workflow shell counts without SSE', async () => {
    const approved = { id: '1001', reference: 'TR-1001', kind: 'request_stock', status: 'approved',
      creator_location_id: 2, creator_location_name: 'Sucursal A', origin_location_id: 1, origin_location_name: 'Almacén',
      destination_location_id: 2, destination_location_name: 'Sucursal A', approver_location_id: 1, approver_location_name: 'Almacén',
      created_at: '2028-01-01T00:00:00Z', decision_location_id: 1, decided_at: '2028-01-02T00:00:00.000000001Z',
      items: [{ variant_id: 1, brand: 'TOYO', model: 'Exact-1', capacity_ah: '75.125', polarity: 'L', quantity: '2' }] };
    const transit = { ...approved, status: 'in_transit', dispatch_location_id: 1, dispatched_at: '2028-01-02T00:00:00.000000002Z' };
    let dispatched = false;
    const mock = setup(session, (url, init) => {
      if (url === '/api/transfers/counts') return Promise.resolve(countResponse('2', '5'));
      if (url.startsWith('/api/transfers?')) {
        const query = new URL(url, 'http://localhost').searchParams;
        const selected = query.get('status'); const record = dispatched ? transit : approved;
        const records = selected === record.status ? [record] : [];
        return Promise.resolve(transferResponse({ page: 1, page_size: 25, status: selected, total_count: records.length.toString(), records }));
      }
      if (url === '/api/transfers/1001/dispatch' && init.method === 'POST') {
        dispatched = true; return Promise.reject(new Error('lost after commit'));
      }
      if (url === '/api/transfers/1001') return Promise.resolve(transferResponse(dispatched ? transit : approved));
      return undefined;
    });
    render(<App />); await inventory();
    fireEvent.click(screen.getByRole('button', { name: 'Transferencias' }));
    fireEvent.change(await screen.findByLabelText('Estado de transferencia'), { target: { value: 'approved' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Ver detalle TR-1001' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Despachar solicitud' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar despacho' }));
    await screen.findByText('Despacho pendiente de confirmación');
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar confirmación de despacho' }));
    fireEvent.click(screen.getByRole('button', { name: 'Volver al inventario' })); await inventory();
    fireEvent.click(screen.getByRole('button', { name: 'Transferencias' }));
    const recovery = await screen.findByRole('region', { name: 'Recuperación de despacho' });
    expect(recovery).toHaveTextContent('Despacho pendiente de confirmación');
    const posts = () => mock.mock.calls.filter(([url, init]) => String(url).endsWith('/dispatch') && init?.method === 'POST');
    expect(posts()).toHaveLength(1);
    const countsBefore = countCalls(mock).length; const stockBefore = stockCalls(mock).length;
    fireEvent.click(within(recovery).getByRole('button', { name: 'Consultar resultado original del despacho' }));
    await waitFor(() => expect(recovery).toHaveTextContent('Estado confirmado: En tránsito.'));
    await waitFor(() => expect(countCalls(mock).length).toBeGreaterThan(countsBefore));
    await waitFor(() => expect(stockCalls(mock).length).toBeGreaterThan(stockBefore));
    expect(shellCount()).toHaveTextContent('Acciones requeridas: 2');
    expect(posts()).toHaveLength(1); expect(AppSource.instances).toHaveLength(1);
  });
});

describe('B4 assigned-participant shell badge', () => {
  it.each([false, true])('shows exact shell counts independently of Pending rows and totals, mobile=%s', async mobile => {
    vi.stubGlobal('matchMedia', () => ({ matches: mobile, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    let reads = 0;
    const mock = setup(session, url => {
      if (url === '/api/transfers/counts') return Promise.resolve(countResponse(++reads === 1 ? '9007199254740993' : '2'));
      if (url.startsWith('/api/transfers?')) return Promise.resolve(transferResponse({ page: 1, page_size: 25, status: 'pending', total_count: '0', records: [] }));
      return undefined;
    });
    render(<App />);
    await within(await screen.findByRole('region', { name: 'Resultados de inventario' })).findByText('9007199254740993');
    fireEvent.click(screen.getByRole('button', { name: 'Transferencias' }));
    await screen.findByText('0 solicitudes pendientes');
    await waitFor(() => expect(document.querySelector('.transfer-request-counters dd')).toHaveTextContent('9007199254740994'));
    expect(shellCount()).toHaveTextContent('Acciones requeridas: 9007199254740993');
    expect(document.querySelector('nav .transfer-action-badge')).toHaveTextContent('9007199254740993');
    await waitFor(() => expect(countCalls(mock)).toHaveLength(2));
    expect(document.querySelectorAll('.transfer-request-counters dd')[1]).toHaveTextContent('2');
    fireEvent.click(screen.getByRole('button', { name: 'Volver al inventario' }));
    await within(screen.getByRole('region', { name: 'Resultados de inventario' })).findByText('9007199254740993');
    expect(shellCount()).toHaveTextContent('9007199254740993');
    expect(screen.queryByLabelText(/Requieren acción/)).not.toBeInTheDocument();
    expect(mock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false); passiveCounts(mock);
  });
  it.each([1, 2, 3])('reads assigned location %s while consulting another inventory location', async assigned => {
    const actor = { ...session, identity: { ...identity, account_id: assigned, location: metadata.locations[assigned - 1] } };
    const mock = setup(actor, url => url === '/api/transfers/counts' ? Promise.resolve(countResponse()) : undefined);
    render(<App />); await inventory();
    await waitFor(() => expect(shellCount()).toHaveTextContent('9007199254740993'));
    fireEvent.click(screen.getByRole('button', { name: new RegExp(metadata.locations[assigned === 3 ? 0 : 2].name) })); await inventory();
    expect(countCalls(mock)).toHaveLength(1); expect(shellCount()).toHaveTextContent('9007199254740993');
    if (assigned === 1) expect(screen.getByRole('button', { name: /Nueva transferencia/ })).toBeEnabled();
    expect(mock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false); passiveCounts(mock);
  });
  it.each([false, true])('distinguishes loading from exact zero in the mobile=%s shell', async mobile => {
    vi.stubGlobal('matchMedia', () => ({ matches: mobile, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    const held = deferred<Response>();
    const mock = setup(session, url => url === '/api/transfers/counts' ? held.promise : undefined);
    render(<App />);
    await screen.findByRole('navigation', { name: mobile ? 'Navegación móvil' : 'Navegación principal' });
    expect(shellCount()).toHaveTextContent('Consultando acciones requeridas…');
    expect(document.querySelector('nav .transfer-action-badge')).not.toHaveTextContent('0');
    expect(screen.getByRole('button', { name: 'Transferencias' })).toBeEnabled();
    await act(async () => held.resolve(countResponse('0', '7')));
    await waitFor(() => expect(shellCount()).toHaveTextContent('Acciones requeridas: 0'));
    expect(document.querySelector('nav .transfer-action-badge')).toHaveTextContent(/^0$/);
    expect(screen.getByRole('button', { name: mobile ? /Crear envío/ : /Nueva transferencia/ })).toBeEnabled(); passiveCounts(mock);
  });
  it.each(['403', '404', '503', 'network', 'malformed'])('keeps navigation usable with unavailable counts: %s', async kind => {
    const mock = setup(session, url => {
      if (url === '/api/transfers/counts') return kind === 'network' ? Promise.reject(new Error('offline'))
        : Promise.resolve(kind === 'malformed' ? transferResponse({ pending_total: '1', action_count: '01' })
          : transferResponse({ error: kind === '403' ? 'forbidden' : kind === '404' ? 'not_found' : 'service_unavailable' }, Number(kind)));
      if (url.startsWith('/api/transfers?')) return Promise.resolve(transferResponse({ error: 'service_unavailable' }, 503));
      return undefined;
    });
    render(<App />); await inventory();
    await waitFor(() => expect(shellCount()).toHaveTextContent('Contador de acciones no disponible.'));
    expect(document.querySelector('nav .transfer-action-badge')).toHaveTextContent('—');
    fireEvent.click(screen.getByRole('button', { name: 'Transferencias' }));
    await screen.findByText('No se pudieron consultar las solicitudes.');
    expect(shellCount()).toHaveTextContent('Contador de acciones no disponible.');
    fireEvent.click(screen.getByRole('button', { name: 'Volver al inventario' })); await inventory();
    expect(mock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false); passiveCounts(mock);
  });
  it('does not replace good shell counts with an unavailable list snapshot', async () => {
    const mock = setup(session, url => url === '/api/transfers/counts' ? Promise.resolve(countResponse())
      : url.startsWith('/api/transfers?') ? Promise.resolve(transferResponse({ error: 'service_unavailable' }, 503)) : undefined);
    render(<App />); await inventory(); await waitFor(() => expect(shellCount()).toHaveTextContent('9007199254740993'));
    fireEvent.click(screen.getByRole('button', { name: 'Transferencias' })); await screen.findByText('No se pudieron consultar las solicitudes.');
    expect(shellCount()).toHaveTextContent('9007199254740993'); expect(countCalls(mock)).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Volver al inventario' })).toBeEnabled(); passiveCounts(mock);
  });
  it('removes the prior value on a failed refresh and recovers through resync', async () => {
    let reads = 0;
    const mock = setup(session, url => url === '/api/transfers/counts'
      ? Promise.resolve(++reads === 2 ? transferResponse({ error: 'forbidden' }, 403) : countResponse(reads === 1 ? '6' : '0')) : undefined);
    render(<App />); await inventory(); await waitFor(() => expect(shellCount()).toHaveTextContent('requeridas: 6'));
    act(() => AppSource.instances[0].emit('transfers'));
    await waitFor(() => expect(shellCount()).toHaveTextContent('Contador de acciones no disponible.'));
    expect(document.querySelector('nav .transfer-action-badge')).toHaveTextContent('—');
    act(() => AppSource.instances[0].emit('resync'));
    await waitFor(() => expect(shellCount()).toHaveTextContent('requeridas: 0')); expect(reads).toBe(3); passiveCounts(mock);
  });
  it('discards stale values and coalesces dirty refreshes within its lane without reading stock on transfers', async () => {
    const held = deferred<Response>(); const latest = deferred<Response>(); let reads = 0;
    const mock = setup(session, url => url === '/api/transfers/counts'
      ? ++reads === 1 ? Promise.resolve(countResponse()) : reads === 2 ? held.promise : latest.promise : undefined);
    render(<App />); await inventory();
    await waitFor(() => expect(shellCount()).toHaveTextContent('9007199254740993'));
    const stocks = stockCalls(mock).length;
    act(() => AppSource.instances[0].emit('transfers'));
    await waitFor(() => expect(reads).toBe(2));
    expect(shellCount()).toHaveTextContent('Consultando'); expect(shellCount()).not.toHaveTextContent('9007199254740993');
    act(() => { for (let i = 0; i < 20; i++) AppSource.instances[0].emit('transfers'); });
    expect(reads).toBe(2);
    await act(async () => held.resolve(countResponse('8')));
    await waitFor(() => expect(reads).toBe(3));
    expect(shellCount()).not.toHaveTextContent('8');
    await act(async () => latest.resolve(countResponse('0')));
    await waitFor(() => expect(shellCount()).toHaveTextContent('requeridas: 0'));
    expect(stockCalls(mock)).toHaveLength(stocks); passiveCounts(mock);
  });
  it.each(['success', 'network', '401'])('ignores obsolete %s after logout and a new login', async kind => {
    const held = deferred<Response>(); let reads = 0;
    const mock = setup(session, url => url === '/api/transfers/counts'
      ? ++reads === 1 ? Promise.resolve(countResponse()) : reads === 2 ? held.promise : Promise.resolve(countResponse('3')) : undefined);
    render(<App />); await inventory(); await waitFor(() => expect(shellCount()).toHaveTextContent('9007199254740993'));
    act(() => AppSource.instances[0].emit('transfers')); await waitFor(() => expect(reads).toBe(2));
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar sesión' })); await screen.findByLabelText('Usuario');
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument(); expect(reads).toBe(2);
    await login(); await waitFor(() => expect(shellCount()).toHaveTextContent('requeridas: 3'));
    expect(countCalls(mock)[1][1]?.signal?.aborted).toBe(true);
    await act(async () => { if (kind === 'network') held.reject(new Error('old offline')); else held.resolve(kind === '401' ? transferResponse({ error: 'unauthenticated' }, 401) : countResponse('8')); });
    expect(shellCount()).toHaveTextContent('requeridas: 3'); expect(screen.queryByLabelText('Usuario')).not.toBeInTheDocument();
    expect(mock.mock.calls.filter(([url]) => String(url).endsWith('/logout'))).toHaveLength(1); passiveCounts(mock);
  });
  it.each(['identity', 'csrf'].flatMap(kind => ['success', 'network', '401'].map(reply => [kind, reply])))('fences %s changes against obsolete %s in the same shell', async (kind, reply) => {
    const held = deferred<Response>(); let reads = 0;
    const next = kind === 'csrf' ? { ...session, csrf_token: 'n'.repeat(43) }
      : { ...session, identity: { ...identity, account_id: 2, location: metadata.locations[1] } };
    const mock = setup(session, url => url === '/api/auth/validate' ? Promise.resolve(response(next))
      : url === '/api/transfers/counts' ? ++reads === 1 ? held.promise : Promise.resolve(countResponse('4')) : undefined);
    render(<App />); await inventory(); await waitFor(() => expect(reads).toBe(1));
    act(() => AppSource.instances[0].emit('error'));
    await waitFor(() => expect(shellCount()).toHaveTextContent('requeridas: 4'));
    expect(countCalls(mock)[0][1]?.signal?.aborted).toBe(true);
    await act(async () => {
      if (reply === 'network') held.reject(new Error('old offline'));
      else held.resolve(reply === '401' ? transferResponse({ error: 'unauthenticated' }, 401) : countResponse('8'));
    });
    expect(shellCount()).toHaveTextContent('requeridas: 4'); expect(screen.queryByLabelText('Usuario')).not.toBeInTheDocument();
    expect(countCalls(mock)).toHaveLength(2); passiveCounts(mock);
  });
  it('clears private counts on current 401 and never reads counts while anonymous', async () => {
    let reads = 0;
    const mock = setup(session, url => url === '/api/transfers/counts'
      ? Promise.resolve(++reads === 1 ? countResponse() : transferResponse({ error: 'unauthenticated' }, 401))
      : url === '/api/auth/validate' && reads > 1 ? Promise.resolve(response({ authenticated: false }))
      : url.endsWith('/session') && reads > 1 ? Promise.resolve(response(anonymous)) : undefined);
    render(<App />); await inventory(); await waitFor(() => expect(shellCount()).toHaveTextContent('9007199254740993'));
    act(() => AppSource.instances[0].emit('transfers')); await screen.findByLabelText('Usuario');
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument(); expect(reads).toBe(2);
    expect(mock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false); passiveCounts(mock);
  });
});

describe('R03 passive invalidation', () => {
  it('makes bootstrap and initial snapshots passive while explicit filter requests remain ordinary', async () => {
    const mock = setup(session); render(<App />); await inventory();
    for (const [url, init] of mock.mock.calls) {
      if (url === '/api/transfers/counts') continue;
      expect(new Headers(init?.headers).get('X-Luson-Passive')).toBe('1');
    }
    passiveCounts(mock);
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
    act(() => { source.emit('open'); source.emit('unknown'); source.emit('inventory', '{"record":1}'); });
    expect(mock.mock.calls).toHaveLength(before);
    act(() => source.emit('transfers'));
    await waitFor(() => expect(countCalls(mock)).toHaveLength(2));
    expect(stockCalls(mock)).toHaveLength(1);
    act(() => source.emit('resync'));
    await waitFor(() => expect(stockCalls(mock)).toHaveLength(2)); await inventory();
    expect(mock.mock.calls.filter(([url]) => String(url).endsWith('/metadata'))).toHaveLength(2);
    for (const [url, init] of mock.mock.calls.slice(before)) {
      if (url === '/api/transfers/counts') continue;
      expect([...new Headers(init?.headers)]).toEqual([['x-luson-passive', '1']]);
    }
    await waitFor(() => expect(countCalls(mock)).toHaveLength(3)); passiveCounts(mock);
    expect(mock.mock.calls.filter(([url]) => String(url).startsWith('/api/transfers') && url !== '/api/transfers/counts')).toHaveLength(0);
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
    expect(screen.getByRole('button', { name: 'Transferencias' })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Nueva transferencia/ })).toBeEnabled();
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
    expect(screen.getByRole('button', { name: 'Transferencias' })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Crear envío/ })).toBeEnabled();
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

// R04b2a adds an authority-bound signal, not a source catalog reader.
describe('R04b2a source-stock bridge', () => {
  it.each([1, 2, 3])('routes distinct channels for assigned location %s without reading physical source stock', async assigned => {
    const actor = { ...session, identity: { ...identity, account_id: assigned, location: metadata.locations[assigned - 1] } };
    const mock = setup(actor); const { result } = renderHook(() => useInventory()); await hookInventory(result);
    const subscribe = result.current.subscribeSourceInventoryInvalidation;
    const source = vi.fn(); const privateSignal = vi.fn();
    const before = mock.mock.calls.length;
    const detachSource = subscribe(source); const detachPrivate = result.current.subscribeTransferInvalidation(privateSignal);
    expect(mock.mock.calls).toHaveLength(before); expect(AppSource.instances).toHaveLength(1);
    const epoch = result.current.authorityEpoch;
    const consulted = assigned === 3 ? 1 : 3;
    act(() => result.current.change({ location: consulted })); await hookInventory(result);
    expect(result.current.subscribeSourceInventoryInvalidation).toBe(subscribe);
    expect(result.current.authorityEpoch).toBe(epoch);
    expect(result.current.getTransferAuthority().session).toEqual(actor);
    const stream = AppSource.instances[0]; const stockBefore = stockCalls(mock).length;
    act(() => stream.emit('inventory'));
    expect(source).toHaveBeenCalledExactlyOnceWith(); expect(privateSignal).not.toHaveBeenCalled();
    await waitFor(() => expect(stockCalls(mock)).toHaveLength(stockBefore + 1)); await hookInventory(result);
    const metaBefore = mock.mock.calls.filter(([url]) => String(url).endsWith('/metadata')).length;
    act(() => stream.emit('resync'));
    expect(source).toHaveBeenCalledTimes(2); expect(privateSignal).toHaveBeenCalledExactlyOnceWith();
    await waitFor(() => expect(stockCalls(mock)).toHaveLength(stockBefore + 2)); await hookInventory(result);
    expect(mock.mock.calls.filter(([url]) => String(url).endsWith('/metadata'))).toHaveLength(metaBefore + 1);
    const settled = mock.mock.calls.length;
    act(() => { stream.emit('transfers'); stream.emit('inventory', '{"source_id":2}'); });
    expect(source).toHaveBeenCalledTimes(2); expect(privateSignal).toHaveBeenCalledTimes(2);
    expect(mock.mock.calls).toHaveLength(settled);
    for (const [url, init] of mock.mock.calls.slice(before)) {
      expect(String(url).includes(`location_id=${assigned}`)).toBe(false);
      if (String(url).startsWith('/api/inventory?') && new Headers(init?.headers).has('X-Luson-Passive')) {
        expect(new Headers(init?.headers).get('X-Luson-Passive')).toBe('1');
      }
    }
    detachSource(); act(() => stream.emit('resync'));
    expect(source).toHaveBeenCalledTimes(2); expect(privateSignal).toHaveBeenCalledTimes(3);
    detachPrivate();
  });
  it('checks membership per listener and keeps independent unsubscriptions and throwing callbacks isolated', async () => {
    setup(session); const { result } = renderHook(() => useInventory()); await hookInventory(result);
    const log = vi.spyOn(console, 'error'); const warn = vi.spyOn(console, 'warn');
    let detachLater = () => {};
    const first = vi.fn(() => { detachLater(); throw new Error('private subscriber error'); });
    const later = vi.fn(); const survivor = vi.fn(); const privateSignal = vi.fn();
    const detachFirst = result.current.subscribeSourceInventoryInvalidation(first);
    detachLater = result.current.subscribeSourceInventoryInvalidation(later);
    result.current.subscribeSourceInventoryInvalidation(survivor);
    const detachPrivate = result.current.subscribeTransferInvalidation(privateSignal);
    act(() => AppSource.instances[0].emit('resync'));
    expect(first).toHaveBeenCalledOnce(); expect(later).not.toHaveBeenCalled();
    expect(survivor).toHaveBeenCalledExactlyOnceWith(); expect(privateSignal).toHaveBeenCalledOnce();
    detachPrivate(); detachFirst(); act(() => AppSource.instances[0].emit('resync'));
    expect(survivor).toHaveBeenCalledTimes(2); expect(privateSignal).toHaveBeenCalledOnce();
    expect(log).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled(); log.mockRestore(); warn.mockRestore();
  });
  it.each(['account', 'assignment', 'csrf', 'anonymous'])('rejects old registrations after %s validation and delivers only to the new ready epoch', async change => {
    let next: unknown = session;
    setup(session, url => url === '/api/auth/validate' ? Promise.resolve(response(next)) : undefined);
    const { result } = renderHook(() => useInventory()); await hookInventory(result);
    const old = vi.fn(); result.current.subscribeSourceInventoryInvalidation(old);
    const epoch = result.current.authorityEpoch;
    next = change === 'anonymous' ? { authenticated: false } : {
      ...session, csrf_token: change === 'csrf' ? 'd'.repeat(43) : csrf,
      identity: { ...identity, account_id: change === 'account' ? 2 : 1,
        location: change === 'assignment' ? metadata.locations[1] : identity.location },
    };
    await act(async () => { await result.current.settleUnauthorized(epoch); });
    await waitFor(() => expect(result.current.getTransferAuthority().ready).toBe(true));
    expect(result.current.authorityEpoch).toBeGreaterThan(epoch);
    const fresh = vi.fn(); result.current.subscribeSourceInventoryInvalidation(fresh);
    act(() => { AppSource.instances.at(-1)!.emit('inventory'); AppSource.instances.at(-1)!.emit('resync'); });
    expect(old).not.toHaveBeenCalled(); expect(fresh).toHaveBeenCalledTimes(2);
  });
  it('masks authority synchronously when an earlier listener starts logout and restores only new-epoch registrations after failure', async () => {
    const pending = deferred<Response>();
    setup(session, url => url.endsWith('/logout') ? pending.promise : undefined);
    const { result } = renderHook(() => useInventory()); await hookInventory(result);
    const later = vi.fn(); const privateSignal = vi.fn(); let logout!: Promise<void>;
    result.current.subscribeSourceInventoryInvalidation(() => {
      logout = result.current.logout(); expect(result.current.getTransferAuthority().ready).toBe(false);
    });
    result.current.subscribeSourceInventoryInvalidation(later);
    result.current.subscribeTransferInvalidation(privateSignal);
    act(() => AppSource.instances[0].emit('inventory'));
    expect(later).not.toHaveBeenCalled(); expect(privateSignal).not.toHaveBeenCalled();
    await act(async () => { pending.resolve(response({}, 503)); await logout; });
    await hookInventory(result); expect(result.current.getTransferAuthority().ready).toBe(true);
    const fresh = vi.fn(); result.current.subscribeSourceInventoryInvalidation(fresh);
    act(() => AppSource.instances.at(-1)!.emit('resync'));
    expect(later).not.toHaveBeenCalled(); expect(privateSignal).not.toHaveBeenCalled(); expect(fresh).toHaveBeenCalledOnce();
  });
  it('accepts unready registration without leaking authority and requires re-subscription at a ready epoch', async () => {
    setup(); const { result } = renderHook(() => useInventory());
    const old = vi.fn(); result.current.subscribeSourceInventoryInvalidation(old);
    await waitFor(() => expect(result.current.authBusy).toBe(false));
    expect(result.current.getTransferAuthority().ready).toBe(false); expect(AppSource.instances).toHaveLength(0);
    await act(async () => result.current.login('component-user', 'component-password')); await hookInventory(result);
    const fresh = vi.fn(); result.current.subscribeSourceInventoryInvalidation(fresh);
    act(() => AppSource.instances[0].emit('inventory'));
    expect(old).not.toHaveBeenCalled(); expect(fresh).toHaveBeenCalledOnce();
  });
  it('owns subscriber sets per controller and leaves unmounted registrations inert on a fresh mount', async () => {
    setup(session);
    const a = renderHook(() => useInventory()); const b = renderHook(() => useInventory());
    await hookInventory(a.result); await hookInventory(b.result);
    const first = vi.fn(); const second = vi.fn();
    a.result.current.subscribeSourceInventoryInvalidation(first); b.result.current.subscribeSourceInventoryInvalidation(second);
    expect(AppSource.instances).toHaveLength(2);
    act(() => AppSource.instances[0].emit('inventory'));
    expect(first).toHaveBeenCalledOnce(); expect(second).not.toHaveBeenCalled();
    a.unmount(); expect(AppSource.instances[0].close).toHaveBeenCalled();
    const c = renderHook(() => useInventory()); await hookInventory(c.result);
    const fresh = vi.fn(); c.result.current.subscribeSourceInventoryInvalidation(fresh);
    act(() => { AppSource.instances[0].emit('resync'); AppSource.instances[1].emit('inventory'); AppSource.instances[2].emit('inventory'); });
    expect(first).toHaveBeenCalledOnce(); expect(second).toHaveBeenCalledOnce(); expect(fresh).toHaveBeenCalledOnce();
  });
});

describe('R04b2b App workspace entry', () => {
  it.each([2, 3])('opens for branch %s independent of consulted stock and returns with the same query', async assigned => {
    const branch = { ...session, identity: { ...identity, account_id: assigned, location: metadata.locations[assigned - 1] } };
    const sourceCalls: { url: string; init: RequestInit }[] = [];
    const mock = setup(branch, (url, init) => {
      if (!url.startsWith('/api/inventory?')) return undefined;
      const params = new URL(url, 'http://localhost').searchParams;
      if (params.get('page_size') !== '50') {
        if (params.get('page') === '1') return undefined;
        const location = metadata.locations[Number(params.get('location_id')) - 1];
        return Promise.resolve(response(pageJSON(undefined, Number(params.get('page'))).replace('"location":{"id":1,"name":"Almacén"}', '"location":' + JSON.stringify(location))));
      }
      sourceCalls.push({ url, init });
      const page = Number(params.get('page')); const source = Number(params.get('location_id'));
      const items = Array.from({ length: Math.min(50, 190 - (page - 1) * 50) }, (_, index) => {
        const variant = (page - 1) * 50 + index + 1;
        return { variant_id: variant, catalog_entry_id: Math.ceil(variant / 2), brand: 'TOYO', model: `Batería ${variant}`,
          capacity_ah: 75.125, polarity: variant % 2 ? 'L' : 'R', existing: 10, reserved: 0, available: 10 };
      });
      return Promise.resolve(new Response(JSON.stringify({ location: metadata.locations[source - 1], page, page_size: 50, total_variants: 190, items }),
        { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } }));
    });
    render(<App />); await inventory();
    fireEvent.click(screen.getByRole('button', { name: /Almacén.*Solo consulta/ })); await inventory();
    fireEvent.change(screen.getByLabelText('Buscar marca o modelo'), { target: { value: 'TOYO' } }); await inventory();
    fireEvent.change(screen.getByLabelText('Marca'), { target: { value: 'TOYO' } }); await inventory();
    fireEvent.change(screen.getByLabelText('Polaridad'), { target: { value: 'L' } }); await inventory();
    fireEvent.click(screen.getByRole('button', { name: 'Página siguiente' })); await inventory();
    const query = stockCalls(mock).at(-1)![0];
    const cta = screen.getByRole('button', { name: /Nueva transferencia/ }); expect(cta).toBeEnabled(); fireEvent.click(cta);
    await screen.findByRole('button', { name: 'Añadir Batería 1 L' });
    expect(sourceCalls).toHaveLength(4);
    expect(sourceCalls.map(call => new URL(call.url, 'http://localhost').searchParams.get('page'))).toEqual(['1', '2', '3', '4']);
    for (const call of sourceCalls) {
      expect(new URL(call.url, 'http://localhost').searchParams.get('location_id')).toBe('1');
      expect(new Headers(call.init.headers).has('X-Luson-Passive')).toBe(false);
    }
    expect(screen.getByRole('button', { name: 'Transferencias' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /Volver a transferencias/ }));
    await screen.findByRole('heading', { name: 'Transferencias pendientes' });
    fireEvent.click(screen.getByRole('button', { name: 'Volver al inventario' })); await inventory();
    expect(screen.getByLabelText('Buscar marca o modelo')).toHaveValue('TOYO');
    expect(screen.getByLabelText('Marca')).toHaveValue('TOYO'); expect(screen.getByLabelText('Polaridad')).toHaveValue('L');
    expect(stockCalls(mock).filter(([url]) => String(url) === String(query))).toHaveLength(1);
    expect(mock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    expect(AppSource.instances).toHaveLength(1);
  });
  it('keeps warehouse creation available without automatic reads when consulting a branch on desktop', async () => {
    const mock = setup(session); render(<App />); await inventory();
    fireEvent.click(screen.getByRole('button', { name: /Sucursal A/ })); await inventory();
    const before = mock.mock.calls.length;
    const cta = screen.getByRole('button', { name: /Nueva transferencia/ }); expect(cta).toBeEnabled();
    expect(mock.mock.calls).toHaveLength(before); expect(screen.queryByLabelText('Tipo de transferencia')).not.toBeInTheDocument();
  });
  it('has no anonymous creation entry or private source request', async () => {
    const mock = setup(); render(<App />); await screen.findByLabelText('Usuario');
    expect(screen.queryByRole('button', { name: /Nueva transferencia/ })).not.toBeInTheDocument();
    expect(stockCalls(mock)).toHaveLength(0); expect(countCalls(mock)).toHaveLength(0);
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });
});

function r04b2c2App() {
  const branch = (id: number, token: string) => ({ ...session, csrf_token: token,
    identity: { account_id: id, username: `TEST-branch-${id}`, location: metadata.locations[id - 1] } });
  let current: typeof session | typeof anonymous = branch(2, 'a'.repeat(43));
  let next = branch(3, 'b'.repeat(43)); let failedSource = false; let stock = 8;
  const posts: RequestInit[] = [];
  const mock = setup(current, (url, init) => {
    if (url.endsWith('/session')) return Promise.resolve(response(current));
    if (url.endsWith('/validate')) return Promise.resolve(response(current.authenticated ? current : { authenticated: false }));
    if (url.endsWith('/logout')) { current = anonymous; return Promise.resolve(new Response(null, { status: 204 })); }
    if (url.endsWith('/login')) { current = next; return Promise.resolve(response(current)); }
    if (url.startsWith('/api/transfers?')) return Promise.resolve(new Response(JSON.stringify({ page: 1, page_size: 25, status: 'pending', total_count: '0', records: [] }), { headers: { 'Content-Type': 'application/json' } }));
    if (url === '/api/transfers') {
      posts.push(init);
      if (posts.length === 1) return Promise.reject(new Error('lost TEST reply'));
      return Promise.resolve(new Response(JSON.stringify({ id: '1001', reference: 'TR-1001', kind: 'request_stock', status: 'pending', created_at: '2028-01-01T00:00:00.123456789Z',
        creator_location_id: 2, creator_location_name: 'Sucursal A', origin_location_id: 3, origin_location_name: 'Sucursal B', destination_location_id: 2,
        destination_location_name: 'Sucursal A', approver_location_id: 3, approver_location_name: 'Sucursal B',
        items: [{ variant_id: 1, brand: 'TOYO', model: 'Private selected', capacity_ah: '75.125', polarity: 'L', quantity: '1' }] }),
      { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } }));
    }
    if (url.startsWith('/api/inventory?') && new URL(url, 'http://localhost').searchParams.get('page_size') === '50') {
      if (failedSource) return Promise.reject(new Error('failed TEST source'));
      const source = Number(new URL(url, 'http://localhost').searchParams.get('location_id'));
      return Promise.resolve(new Response(JSON.stringify({ location: metadata.locations[source - 1], page: 1, page_size: 50, total_variants: 1,
        items: [{ variant_id: 1, catalog_entry_id: 1, brand: 'TOYO', model: 'Private selected', capacity_ah: 75.125, polarity: 'L', existing: stock, reserved: 0, available: stock }] }),
      { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } }));
    }
    return undefined;
  });
  return { mock, posts, loginAs: (id: number, token: string) => { next = branch(id, token); }, failSource: () => { failedSource = true; }, fallStock: () => { stock = 0; } };
}
async function r04b2c2OpenAndLose() {
  fireEvent.click(screen.getByRole('button', { name: /Nueva transferencia/ }));
  await screen.findByRole('button', { name: 'Añadir Private selected L' });
  fireEvent.change(screen.getByLabelText('Tipo de transferencia'), { target: { value: 'requestOther' } });
  await screen.findByRole('heading', { name: 'Disponibilidad en Sucursal B' });
  await waitFor(() => expect(screen.queryByText('Actualizando catálogo completo…')).not.toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: 'Añadir Private selected L' }));
  fireEvent.click(screen.getByRole('button', { name: 'Revisar solicitud' }));
  fireEvent.click(screen.getByRole('button', { name: 'Enviar solicitud' })); await screen.findByRole('alert');
}

describe('R04b2c2 root lifetime', () => {
  it.each(['failed', 'fallen'])('retains A through logout/login B/private exclusion/login A with %s source and current CSRF', async source => {
    const h = r04b2c2App(); render(<App />); await inventory(); await r04b2c2OpenAndLose();
    const first = JSON.parse(String(h.posts[0].body));
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar sesión' })); await screen.findByLabelText('Usuario');
    expect(screen.queryByText(/Private selected|pendiente de confirmación|Retomar/)).not.toBeInTheDocument();
    await login();
    expect(screen.queryByRole('region', { name: 'Recuperación de solicitud' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Private selected/)).not.toBeInTheDocument(); expect(h.posts).toHaveLength(1);
    h.loginAs(2, 'f'.repeat(43));
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar sesión' })); await screen.findByLabelText('Usuario');
    await login(); expect(await screen.findByRole('region', { name: 'Recuperación de solicitud' })).toHaveTextContent('pendiente de confirmación');
    if (source === 'failed') h.failSource(); else h.fallStock();
    fireEvent.click(screen.getByRole('button', { name: 'Retomar misma solicitud' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Retomar misma solicitud' }));
    expect(screen.getByRole('main')).toHaveAttribute('id', 'transferencias');
    expect(screen.getByRole('button', { name: 'Transferencias' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByLabelText('Tipo de transferencia')).toHaveValue('requestOther');
    expect(h.posts).toHaveLength(1); fireEvent.click(screen.getByRole('button', { name: 'Reintentar misma solicitud' }));
    expect(await screen.findByText('TR-1001')).toBeVisible(); expect(h.posts).toHaveLength(2);
    expect(JSON.parse(String(h.posts[1].body))).toEqual(first);
    expect(new Headers(h.posts[1].headers).get('X-CSRF-Token')).toBe('f'.repeat(43));
    expect(h.mock.mock.calls.filter(([url]) => String(url).startsWith('/api/transfers') && url !== '/api/transfers/counts')).toHaveLength(2);
    passiveCounts(h.mock);
    expect(AppSource.instances.filter(instance => instance.readyState !== 2)).toHaveLength(1);
  });
  it('returns through Transfers to the consulted inventory query with an owner-only recovery banner', async () => {
    const h = r04b2c2App(); render(<App />); await inventory();
    fireEvent.click(screen.getByRole('button', { name: /Almacén.*Solo consulta/ })); await inventory();
    fireEvent.change(screen.getByLabelText('Buscar marca o modelo'), { target: { value: 'kept-query' } }); await inventory();
    await r04b2c2OpenAndLose(); fireEvent.click(screen.getByRole('button', { name: 'Cerrar revisión' }));
    fireEvent.click(screen.getByRole('button', { name: '← Volver a transferencias' }));
    fireEvent.click(screen.getByRole('button', { name: 'Volver conservando el intento' }));
    await screen.findByRole('heading', { name: 'Transferencias pendientes' });
    fireEvent.click(screen.getByRole('button', { name: 'Volver al inventario' })); await inventory();
    expect(screen.getByLabelText('Buscar marca o modelo')).toHaveValue('kept-query');
    expect(screen.getByRole('button', { name: /Almacén.*Solo consulta/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('region', { name: 'Recuperación de solicitud' })).toHaveTextContent('Recargar o cerrar');
    expect(h.posts).toHaveLength(1); expect(h.mock.mock.calls.filter(([url]) => /^\/api\/transfers\/[1-9][0-9]*$/.test(String(url)))).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Transferencias' })).toBeEnabled();
  });
  it('does not persist recovery across actual App unmount and new mount', async () => {
    const h = r04b2c2App(); const view = render(<App />); await inventory(); await r04b2c2OpenAndLose();
    view.unmount(); render(<App />); await inventory();
    expect(screen.queryByRole('region', { name: 'Recuperación de solicitud' })).not.toBeInTheDocument();
    expect(h.posts).toHaveLength(1);
  });
});

describe('R04c Pending navigation', () => {
  it('opens participant Pending without inventing a loading count', async () => {
    const pending = deferred<Response>();
    setup(session, url => url.startsWith('/api/transfers?') ? pending.promise : undefined);
    render(<App />); await inventory();
    fireEvent.click(screen.getByRole('button', { name: 'Transferencias' }));
    expect(await screen.findByRole('heading', { name: 'Transferencias pendientes' })).toBeVisible();
    expect(screen.queryByText('0 solicitudes pendientes')).not.toBeInTheDocument();
    pending.resolve(new Response(JSON.stringify({ page: 1, page_size: 25, status: 'pending', total_count: '0', records: [] }), { headers: { 'Content-Type': 'application/json' } }));
    expect(await screen.findByText('0 solicitudes pendientes')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Volver al inventario' })); await inventory();
  });
  it('keeps the unknown root attempt through Pending and inventory, then retries the exact key and quantities manually', async () => {
    const h = r04b2c2App(); const previous = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => String(input).startsWith('/api/transfers?')
      ? Promise.resolve(new Response(JSON.stringify({ page: 1, page_size: 25, status: 'pending', total_count: '0', records: [] }), { headers: { 'Content-Type': 'application/json' } })) : previous(input, init)));
    render(<App />); await inventory(); await r04b2c2OpenAndLose();
    const attempt = JSON.parse(String(h.posts[0].body));
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar revisión' }));
    expect(screen.getByRole('button', { name: 'Transferencias' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '← Volver a transferencias' }));
    fireEvent.click(screen.getByRole('button', { name: 'Volver conservando el intento' }));
    await screen.findByText('0 solicitudes pendientes'); expect(h.posts).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Volver al inventario' })); await inventory();
    expect(screen.getByRole('region', { name: 'Recuperación de solicitud' })).toHaveTextContent('pendiente de confirmación');
    fireEvent.click(screen.getByRole('button', { name: 'Retomar misma solicitud' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Retomar misma solicitud' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar misma solicitud' })); await screen.findByText('TR-1001');
    expect(h.posts).toHaveLength(2); expect(JSON.parse(String(h.posts[1].body))).toEqual(attempt);
  });
});

function r04cRecord() {
  return { id: '9007199254740993', reference: 'TR-9007199254740993', kind: 'request_stock', status: 'pending', created_at: '2028-01-01T00:00:00.123456789Z',
    creator_location_id: 2, creator_location_name: 'Sucursal A', origin_location_id: 1, origin_location_name: 'Almacén', destination_location_id: 2,
    destination_location_name: 'Sucursal A', approver_location_id: 1, approver_location_name: 'Almacén',
    items: [{ variant_id: 1, brand: 'TOYO', model: 'Real response', capacity_ah: '75.125', polarity: 'L', quantity: '1' }] };
}
function r04cApp(status: number, stalled?: ReturnType<typeof deferred<Response>>, assigned = 2) {
  const actor = { ...session, identity: { ...identity, account_id: assigned, location: metadata.locations[assigned - 1] } };
  const posts: RequestInit[] = [];
  const mock = setup(actor, (url, init) => {
    if (url === '/api/transfers') { posts.push(init); return stalled?.promise ?? Promise.resolve(new Response(JSON.stringify(r04cRecord()), { status, headers: { 'Content-Type': 'application/json' } })); }
    if (url === '/api/transfers/counts') return Promise.resolve(countResponse(assigned === 1 ? '1' : '0', '1'));
    if (url.startsWith('/api/transfers/')) return Promise.resolve(new Response(JSON.stringify(r04cRecord()), { headers: { 'Content-Type': 'application/json' } }));
    if (url.startsWith('/api/transfers?')) {
      const q = new URL(url, 'http://localhost').searchParams;
      return Promise.resolve(new Response(JSON.stringify({ page: Number(q.get('page')), page_size: Number(q.get('page_size')), status: 'pending', total_count: '1', records: [{ ...r04cRecord(), creator_location_id: assigned === 3 ? 3 : 2,
        creator_location_name: assigned === 3 ? 'Sucursal B' : 'Sucursal A', destination_location_id: assigned === 3 ? 3 : 2,
        destination_location_name: assigned === 3 ? 'Sucursal B' : 'Sucursal A' }] }), { headers: { 'Content-Type': 'application/json' } }));
    }
    if (url.startsWith('/api/inventory?') && new URL(url, 'http://localhost').searchParams.get('page_size') === '50') {
      const source = Number(new URL(url, 'http://localhost').searchParams.get('location_id'));
      return Promise.resolve(new Response(JSON.stringify({ location: metadata.locations[source - 1], page: 1, page_size: 50, total_variants: 1,
        items: [{ variant_id: 1, catalog_entry_id: 1, brand: 'TOYO', model: 'Real response', capacity_ah: 75.125, polarity: 'L', existing: 8, reserved: 0, available: 8 }] }), { headers: { 'Content-Type': 'application/json' } }));
    }
    return undefined;
  });
  return { mock, posts };
}
async function r04cSend() {
  fireEvent.click(screen.getByRole('button', { name: /Nueva transferencia/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Añadir Real response L' }));
  fireEvent.click(screen.getByRole('button', { name: 'Revisar solicitud' }));
  fireEvent.click(screen.getByRole('button', { name: 'Enviar solicitud' }));
}
describe('R05-U1 creation section', () => {
  function transfersContext() {
    expect(screen.getByRole('button', { name: 'Transferencias' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Inventario' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('main')).toHaveAttribute('id', 'transferencias');
    expect(document.querySelector('.app-header')).toHaveTextContent('Luson Transferencias');
    expect(document.querySelector('.creation-breadcrumb')).toHaveTextContent(/^Transferencias \/ /);
    expect(document.querySelectorAll('nav [aria-current="page"]')).toHaveLength(1);
  }
  it.each(['inventory', 'pending-A', 'pending-B'])('opens the same Transfers-owned form from %s and discards back to Transfers', async entry => {
    const h = r04cApp(201, undefined, entry === 'pending-B' ? 3 : 2);
    render(<App />); await inventory();
    fireEvent.click(screen.getByRole('button', { name: /Almacén.*Solo consulta/ })); await inventory();
    if (entry !== 'inventory') {
      fireEvent.click(screen.getByRole('button', { name: 'Transferencias' }));
      await screen.findByText('1 solicitudes pendientes');
    }
    fireEvent.click(screen.getByRole('button', { name: /Nueva transferencia/ }));
    const add = await screen.findByRole('button', { name: 'Añadir Real response L' });
    transfersContext();
    expect(screen.queryByRole('heading', { name: 'Transferencias pendientes' })).not.toBeInTheDocument();
    expect(screen.getAllByLabelText('Tipo de transferencia')).toHaveLength(1);
    fireEvent.click(add);
    fireEvent.click(screen.getByRole('button', { name: '← Volver a transferencias' }));
    expect(screen.getByRole('dialog')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Descartar selección' }));
    await screen.findByRole('heading', { name: 'Transferencias pendientes' });
    expect(screen.getByRole('main')).toHaveAttribute('id', 'transferencias');
    expect(h.posts).toHaveLength(0);
  });
  it.each(['inventory', 'pending'])('returns an empty creation to Transfers from %s', async entry => {
    r04cApp(201); render(<App />); await inventory();
    if (entry === 'pending') {
      fireEvent.click(screen.getByRole('button', { name: 'Transferencias' }));
      await screen.findByRole('heading', { name: 'Transferencias pendientes' });
    }
    fireEvent.click(screen.getByRole('button', { name: /Nueva transferencia/ }));
    await screen.findByRole('button', { name: 'Añadir Real response L' });
    fireEvent.click(screen.getByRole('button', { name: '← Volver a transferencias' }));
    await screen.findByRole('heading', { name: 'Transferencias pendientes' });
  });
  it.each([false, true])('preserves warehouse list/detail/inventory at mobile=%s without creation reads or POST', async mobile => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: mobile, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    const h = r04cApp(201, undefined, 1); render(<App />);
    const catalogReads = () => h.mock.mock.calls.filter(([input]) => {
      const url = new URL(String(input), 'http://localhost');
      return url.pathname === '/api/inventory' && url.searchParams.get('page_size') === '50';
    });
    await screen.findByText('9007199254740993');
    expect(catalogReads()).toHaveLength(0);
    const cta = screen.getByRole('button', { name: /Nueva transferencia|Crear envío/ });
    expect(cta).toBeEnabled();
    expect(catalogReads()).toHaveLength(0);
    expect(screen.queryByLabelText('Tipo de transferencia')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Transferencias' }));
    await screen.findByText('1 solicitudes pendientes');
    expect(screen.getByRole('button', { name: 'Nueva transferencia' })).toBeEnabled();
    expect(screen.getByRole('main')).toHaveAttribute('id', 'transferencias');
    expect(document.querySelectorAll('nav [aria-current="page"]')).toHaveLength(1);
    expect(catalogReads()).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Ver detalle TR-9007199254740993' }));
    await screen.findByRole('heading', { name: 'TR-9007199254740993' });
    expect(screen.queryByRole('button', { name: 'Nueva transferencia' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Actualizar stock de origen' })).toBeEnabled());
    expect(catalogReads()).toHaveLength(1);
    const [input, init] = catalogReads()[0];
    const url = new URL(String(input), 'http://localhost');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      location_id: String(r04cRecord().origin_location_id), page: '1', page_size: '50',
    });
    expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store' });
    const headers = new Headers(init?.headers);
    expect(headers.get('X-Luson-Passive')).toBe('1');
    expect(headers.has('X-CSRF-Token')).toBe(false);
    expect(init?.body).toBeUndefined();
    expect(screen.getAllByText('8 disponibles').length).toBeGreaterThan(0);
    expect(screen.queryByLabelText('Tipo de transferencia')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Volver a pendientes' }));
    await screen.findByRole('heading', { name: 'Transferencias pendientes' });
    fireEvent.click(screen.getByRole('button', { name: 'Volver al inventario' }));
    await screen.findByText('9007199254740993');
    expect(screen.getByRole('main')).toHaveAttribute('id', 'inventario');
    expect(h.posts).toHaveLength(0);
    expect(catalogReads()).toHaveLength(1);
    expect(h.mock.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
  });
  it.each(['inventory', 'pending'])('returns confirmed review to Transfers from %s', async entry => {
    const h = r04cApp(201); render(<App />); await inventory();
    if (entry === 'pending') {
      fireEvent.click(screen.getByRole('button', { name: 'Transferencias' }));
      await screen.findByRole('heading', { name: 'Transferencias pendientes' });
    }
    await r04cSend(); await screen.findByRole('heading', { name: 'Solicitud Pending confirmada' });
    transfersContext();
    fireEvent.click(screen.getByRole('button', { name: 'Volver a transferencias' }));
    await screen.findByRole('heading', { name: 'Transferencias pendientes' });
    expect(h.posts).toHaveLength(1);
  });
});

describe('R04c guarded success navigation', () => {
  it('does not request a selected A detail under B after actual logout/login, even when the old reply arrives late', async () => {
    const h = r04b2c2App(); const previous = globalThis.fetch; const late = deferred<Response>(); let assigned = 2;
    const records = () => assigned === 2 ? [r04cRecord()] : [{ ...r04cRecord(), id: '9007199254740994', reference: 'TR-9007199254740994',
      creator_location_id: 3, creator_location_name: 'Sucursal B', destination_location_id: 3, destination_location_name: 'Sucursal B' }];
    const fetch = vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      if (url.endsWith('/login')) assigned = 3;
      if (url.startsWith('/api/transfers?')) return Promise.resolve(new Response(JSON.stringify({ page: 1, page_size: 25, status: 'pending', total_count: '1', records: records() }), { headers: { 'Content-Type': 'application/json' } }));
      if (url === '/api/transfers/counts') return Promise.resolve(response({ pending_total: '1', action_count: '0' }));
      if (/^\/api\/transfers\/[1-9][0-9]*$/.test(url)) return late.promise;
      return previous(input, init);
    }); vi.stubGlobal('fetch', fetch);
    render(<App />); await inventory(); fireEvent.click(screen.getByRole('button', { name: 'Transferencias' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Ver detalle TR-9007199254740993' }));
    await waitFor(() => expect(fetch.mock.calls.filter(([url]) => String(url) === '/api/transfers/9007199254740993')).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar sesión' })); await screen.findByLabelText('Usuario'); await login();
    expect(screen.queryByRole('heading', { name: 'Detalle de solicitud' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Transferencias' }));
    await screen.findByRole('button', { name: 'Ver detalle TR-9007199254740994' });
    await act(async () => { late.resolve(new Response(JSON.stringify(r04cRecord()), { headers: { 'Content-Type': 'application/json' } })); });
    expect(document.body).not.toHaveTextContent('TR-9007199254740993');
    expect(fetch.mock.calls.filter(([url]) => /^\/api\/transfers\/[1-9][0-9]*$/.test(String(url))).map(([url]) => url)).toEqual(['/api/transfers/9007199254740993']); expect(h.posts).toHaveLength(0);
  });
  it.each([1, 2])('uses assigned role %s at narrow viewport independently of the consulted warehouse', async assigned => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    const actor = { ...session, identity: { ...identity, account_id: assigned, location: metadata.locations[assigned - 1] } };
    setup(actor, url => url.startsWith('/api/transfers?') ? Promise.resolve(new Response(JSON.stringify({ page: 1, page_size: 25, status: 'pending', total_count: '1', records: [r04cRecord()] }), { headers: { 'Content-Type': 'application/json' } })) : undefined);
    render(<App />); if (assigned === 1) await screen.findByText('9007199254740993'); else await inventory();
    if (assigned === 2) { fireEvent.click(screen.getByRole('button', { name: /Almacén.*Solo consulta/ })); await inventory(); }
    fireEvent.click(screen.getByRole('button', { name: 'Transferencias' })); await screen.findByText('1 solicitudes pendientes');
    expect(document.querySelector('.app-shell')?.classList.contains('warehouse')).toBe(assigned === 1);
    expect(document.querySelector('.pending-cards') !== null).toBe(assigned === 1);
    expect(screen.getByRole('main')).toHaveAttribute('id', 'transferencias');
    expect(document.querySelectorAll('nav [aria-current="page"]')).toHaveLength(1);
    if (assigned === 1) expect(screen.getByRole('button', { name: 'Nueva transferencia' })).toBeEnabled();
    expect(screen.queryByRole('navigation', { name: 'Navegación móvil' }) !== null).toBe(assigned === 1);
    expect(screen.getByRole('table', { name: 'Solicitudes pendientes participantes' })).toBeInTheDocument();
  });
  it.each([201, 200])('opens only the validated %s record ID and returns to the unchanged inventory query', async status => {
    const h = r04cApp(status); render(<App />); await inventory();
    fireEvent.click(screen.getByRole('button', { name: /Almacén.*Solo consulta/ })); await inventory();
    fireEvent.change(screen.getByLabelText('Buscar marca o modelo'), { target: { value: 'kept-r04c' } }); await inventory();
    fireEvent.change(screen.getByLabelText('Marca', { exact: true }), { target: { value: 'TOYO' } }); await inventory();
    fireEvent.change(screen.getByLabelText('Polaridad', { exact: true }), { target: { value: 'L' } }); await inventory();
    fireEvent.change(screen.getByLabelText('Filas por página'), { target: { value: '10' } }); await inventory();
    await r04cSend(); await screen.findByRole('heading', { name: 'Solicitud Pending confirmada' });
    expect(h.mock.mock.calls.filter(([url, init]) => String(url).startsWith('/api/transfers') && url !== '/api/transfers/counts' && init?.method !== 'POST')).toHaveLength(0);
    await waitFor(() => expect(countCalls(h.mock)).toHaveLength(2)); passiveCounts(h.mock);
    fireEvent.click(screen.getByRole('button', { name: 'Ver detalle' }));
    await screen.findByRole('heading', { name: 'TR-9007199254740993' });
    const reads = h.mock.mock.calls.filter(([url]) => /^\/api\/transfers\/[1-9][0-9]*$/.test(String(url)));
    await waitFor(() => expect(countCalls(h.mock)).toHaveLength(3));
    const counts = countCalls(h.mock);
    expect(counts).toHaveLength(3); passiveCounts(h.mock);
    expect(counts[0][1]).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store' });
    expect([...new Headers(counts[0][1]?.headers)]).toEqual([]);
    expect(counts[0][1]?.body).toBeUndefined();
    expect(reads).toHaveLength(1); expect(reads[0][0]).toBe('/api/transfers/9007199254740993');
    expect(new Headers(reads[0][1]?.headers).has('X-Luson-Passive')).toBe(false);
    expect(h.posts).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Volver al inventario' })); await inventory();
    expect(screen.getByLabelText('Buscar marca o modelo')).toHaveValue('kept-r04c');
    expect(screen.getByLabelText('Marca', { exact: true })).toHaveValue('TOYO'); expect(screen.getByLabelText('Polaridad', { exact: true })).toHaveValue('L');
    expect(screen.getByLabelText('Filas por página')).toHaveValue('10');
    expect(screen.getByRole('button', { name: /Almacén.*Solo consulta/ })).toHaveAttribute('aria-pressed', 'true'); expect(h.posts).toHaveLength(1);
  });
  it('blocks sidebar inventory and Pending exit during POST and keeps one POST', async () => {
    const pending = deferred<Response>(); const h = r04cApp(201, pending); render(<App />); await inventory(); await r04cSend();
    await screen.findByText('Enviando solicitud… No cambies la selección mientras se resuelve.');
    expect(screen.getByRole('button', { name: 'Transferencias' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Transferencias' })); fireEvent.click(screen.getByRole('link', { name: 'Inventario' }));
    expect(screen.queryByRole('heading', { name: 'Transferencias pendientes' })).not.toBeInTheDocument();
    pending.resolve(new Response(JSON.stringify(r04cRecord()), { status: 201, headers: { 'Content-Type': 'application/json' } }));
    await screen.findByRole('button', { name: 'Ver detalle' }); expect(h.posts).toHaveLength(1);
  });
  it('keeps one existing EventSource and refreshes both detail and list on transfers/resync', async () => {
    const h = r04cApp(201); render(<App />); await inventory(); fireEvent.click(screen.getByRole('button', { name: 'Transferencias' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Ver detalle TR-9007199254740993' })); await screen.findByRole('heading', { name: 'TR-9007199254740993' });
    for (const kind of ['transfers', 'resync']) {
      const listBefore = h.mock.mock.calls.filter(([url]) => String(url).startsWith('/api/transfers?')).length;
      const detailBefore = h.mock.mock.calls.filter(([url]) => url === '/api/transfers/9007199254740993').length;
      const countsBefore = h.mock.mock.calls.filter(([url]) => url === '/api/transfers/counts').length;
      act(() => { AppSource.instances[0].emit(kind); });
      await waitFor(() => expect(h.mock.mock.calls.filter(([url]) => url === '/api/transfers/9007199254740993')).toHaveLength(detailBefore + 1));
      await waitFor(() => expect(h.mock.mock.calls.filter(([url]) => url === '/api/transfers/counts')).toHaveLength(countsBefore + 2));
      expect(h.mock.mock.calls.filter(([url]) => String(url).startsWith('/api/transfers?'))).toHaveLength(listBefore + 1);
    }
    expect(AppSource.instances.filter(s => s.readyState !== 2)).toHaveLength(1); expect(h.posts).toHaveLength(0);
    for (const [url, init] of h.mock.mock.calls.filter(([url]) => String(url).startsWith('/api/transfers')).slice(-4)) {
      if (url === '/api/transfers/counts') {
        expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store' });
        expect([...new Headers(init?.headers)]).toEqual([]);
        expect(init?.body).toBeUndefined();
      } else expect(new Headers(init?.headers).get('X-Luson-Passive')).toBe('1');
    }
  });
});
