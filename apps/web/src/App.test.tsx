import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { pageJSON } from './test-fixtures';

const csrf = 'c'.repeat(43);
const anonymous = { authenticated: false, csrf_token: csrf };
const identity = { account_id: 1, username: 'component-user', location: { id: 1, name: 'Almacén' } };
const session = { authenticated: true, csrf_token: csrf, identity, expires_at: '2030-01-01T00:00:00Z' };
const metadata = { locations: [identity.location, { id: 2, name: 'Sucursal A' }, { id: 3, name: 'Sucursal B' }], brands: ['TOYO', 'CAR'] };
const response = (value: unknown, status = 200) => new Response(typeof value === 'string' ? value : JSON.stringify(value), { status });
function setup(current: unknown = anonymous, override?: (url: string, init: RequestInit) => Promise<Response> | undefined) {
  const mock = vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const custom = override?.(url, init);
    if (custom) return custom;
    if (url.endsWith('/session')) return Promise.resolve(response(current));
    if (url.endsWith('/login')) { current = session; return Promise.resolve(response(session)); }
    if (url.endsWith('/logout')) { current = anonymous; return Promise.resolve(new Response(null, { status: 204 })); }
    if (url.endsWith('/metadata')) return Promise.resolve(response(metadata));
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
afterEach(() => vi.unstubAllGlobals());

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
