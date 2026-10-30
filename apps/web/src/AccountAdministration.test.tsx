import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App';

const token = 'a'.repeat(43);
const administrator = { authenticated: true, csrf_token: token, expires_at: '2030-01-01T00:00:00Z', identity: {
  account_id: 1, username: 'almacen', display_name: 'Admin', must_change_password: false, location: { id: 1, name: 'Almacén' } } };
const seed = [
  { id: '1', username: 'almacen', display_name: 'Admin', location_id: 1, enabled: true, must_change_password: false },
  { id: '4', username: 'legacy.c', display_name: '', location_id: 4, enabled: false, must_change_password: false },
];
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function setup(override?: (url: string, init: RequestInit) => Promise<Response> | undefined) {
  const accounts = structuredClone(seed);
  const branches = [{ id: 1, name: 'Almacén' }, { id: 2, name: 'Sucursal A' }, { id: 3, name: 'Sucursal B' }, { id: 4, name: 'Sucursal C' }];
  let current: unknown = administrator;
  class Events { addEventListener() {} removeEventListener() {} close() {} }
  vi.stubGlobal('EventSource', Events);
  const fetcher = vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input); const custom = override?.(url, init); if (custom) return custom;
    if (url === '/api/auth/session') return Promise.resolve(json(current));
    if (url === '/api/auth/logout') { current = { authenticated: false, csrf_token: 'b'.repeat(43) }; return Promise.resolve(new Response(null, { status: 204 })); }
    if (url === '/api/auth/login') { current = { ...administrator, csrf_token: 'n'.repeat(43), identity: { ...administrator.identity, account_id: 20, username: 'new.operator', must_change_password: true, location: branches[1] } }; return Promise.resolve(json(current)); }
    if (url === '/api/transfers/counts') return Promise.resolve(json({ pending_total: '0', action_count: '0' }));
    if (url === '/api/inventory/metadata') return Promise.resolve(json({ locations: branches, brands: ['TOYO'] }));
    if (url.startsWith('/api/inventory?')) {
      const query = new URL(url, 'http://localhost').searchParams;
      return Promise.resolve(json({ location: branches.find(branch => branch.id === Number(query.get('location_id'))), items: [], page: 1, page_size: 10, total_variants: 0 }));
    }
    if (url === '/api/admin/accounts' && init.method === 'GET') return Promise.resolve(json(accounts));
    if (url === '/api/admin/branches' && init.method === 'GET') return Promise.resolve(json(branches));
    if (url === '/api/admin/accounts' && init.method === 'POST') {
      const body = JSON.parse(String(init.body)); const account = { id: '5', username: body.username, display_name: body.display_name, location_id: body.location_id, enabled: true, must_change_password: true };
      accounts.push(account); return Promise.resolve(json(account, 201));
    }
    if (url === '/api/admin/accounts/4' && init.method === 'PATCH') { Object.assign(accounts[1], JSON.parse(String(init.body))); return Promise.resolve(new Response(null, { status: 204 })); }
    if (url === '/api/admin/accounts/4/password' && init.method === 'POST') { accounts[1].must_change_password = true; return Promise.resolve(new Response(null, { status: 204 })); }
    if (url === '/api/admin/branches' && init.method === 'POST') { const branch = { id: 5, name: JSON.parse(String(init.body)).name }; branches.push(branch); return Promise.resolve(json(branch, 201)); }
    throw new Error('Unexpected request');
  });
  vi.stubGlobal('fetch', fetcher);
  return { fetcher, accounts, branches };
}
async function open() {
  render(<App />); await screen.findByRole('heading', { name: 'Inventario' });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Administración' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Administración' }));
  await screen.findByRole('button', { name: 'Gestionar legacy.c' });
}
const deletes = (h: ReturnType<typeof setup>) => writes(h).filter(([, init]) => init?.method === 'DELETE');
const writes = (h: ReturnType<typeof setup>) => h.fetcher.mock.calls.filter(([url, init]) => String(url).startsWith('/api/admin/') && init?.method !== 'GET');
function exactWrite(h: ReturnType<typeof setup>, index: number, url: string, method: string, body: unknown) {
  expect(writes(h)[index][0]).toBe(url);
  expect(writes(h)[index][1]).toMatchObject({ method, credentials: 'same-origin', cache: 'no-store', body: JSON.stringify(body) });
  expect([...new Headers(writes(h)[index][1]?.headers)]).toEqual([['content-type', 'application/json'], ['x-csrf-token', token]]);
}
afterEach(() => vi.unstubAllGlobals());

describe('safe retirement administration', () => {
  function removeUser() { fireEvent.click(screen.getByRole('button', { name: 'Gestionar legacy.c' })); fireEvent.click(screen.getByRole('button', { name: /eliminar usuario/i })); }
  function confirm() { fireEvent.click(screen.getByRole('button', { name: /confirmar eliminación/i })); }
  it('requires intent confirmation and removes the user only after canonical empty 204 and refetch', async () => {
    const h = setup((url, init) => {
      if (url === '/api/admin/accounts/4' && init.method === 'DELETE') { h.accounts.splice(1, 1); return Promise.resolve(new Response(null, { status: 204 })); }
    });
    await open(); removeUser(); expect(deletes(h)).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: /cancelar/i })); expect(deletes(h)).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Gestionar legacy.c' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /eliminar usuario/i })); confirm();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Gestionar legacy.c' })).not.toBeInTheDocument());
    expect(deletes(h)).toHaveLength(1);
    const [url, init] = deletes(h)[0]; expect(url).toBe('/api/admin/accounts/4');
    expect(init).toMatchObject({ method: 'DELETE', credentials: 'same-origin', cache: 'no-store' }); expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).get('X-CSRF-Token')).toBe(token);
    expect(h.accounts.map(account => account.id)).toEqual(['1']);
    expect(screen.queryByRole('region', { name: 'Gestión de cuenta' })).not.toBeInTheDocument();
    expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
    expect(h.fetcher.mock.calls.filter(([url]) => url === '/api/admin/accounts')).toHaveLength(2);
  });
  it('protects the unique administrator and warehouse while exposing personal deletion separately from access', async () => {
    const h = setup(); await open(); fireEvent.click(screen.getByRole('button', { name: 'Gestionar almacen' }));
    expect(within(screen.getByRole('region', { name: 'Gestión de cuenta' })).queryByRole('button', { name: /eliminar/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar gestión' }));
    fireEvent.click(screen.getByRole('button', { name: 'Gestionar legacy.c' }));
    expect(screen.getByLabelText('Acceso')).toHaveValue('disabled'); expect(screen.getByRole('button', { name: /eliminar usuario/i })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Sucursales' }));
    const warehouse = screen.getByRole('heading', { name: 'Almacén', level: 3 }).closest('article')!;
    expect(within(warehouse).queryByRole('button', { name: /eliminar/i })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /eliminar sucursal/i }).length).toBeGreaterThan(0); expect(deletes(h)).toHaveLength(0);
  });
  it.each([['branch_has_stock', /stock|reservas/i], ['branch_has_users', /usuarios|cuentas/i], ['branch_has_pending_operations', /operaciones|pendientes/i]] as const)
    ('keeps a rejected branch visible and explains how to resolve %s', async (code, explanation) => {
    const h = setup((url, init) => url === '/api/admin/branches/4' && init.method === 'DELETE' ? Promise.resolve(json({ error: code }, 409)) : undefined);
    await open(); fireEvent.click(screen.getByRole('button', { name: 'Sucursales' }));
    const card = screen.getByRole('heading', { name: 'Sucursal C', level: 3 }).closest('article')!;
    fireEvent.click(within(card).getByRole('button', { name: /eliminar sucursal/i })); confirm();
    const alert = await screen.findByRole('alert'); expect(alert).toHaveTextContent(explanation);
    expect(alert).toHaveTextContent(/retirá|resolvé|reasigná|eliminá|completá|antes/i);
    expect(screen.getByRole('heading', { name: 'Sucursal C', level: 3 })).toBeInTheDocument(); expect(deletes(h)).toHaveLength(1);
    expect(h.branches.map(branch => branch.id)).toEqual([1, 2, 3, 4]);
    expect(h.accounts).toEqual(seed);
    expect(deletes(h)[0][0]).toBe('/api/admin/branches/4');
    expect(deletes(h)[0][1]?.body).toBeUndefined();
    expect(new Headers(deletes(h)[0][1]?.headers).get('X-CSRF-Token')).toBe(token);
    expect(h.fetcher.mock.calls.filter(([url]) => url === '/api/inventory/metadata')).toHaveLength(1);
  });
  it('clears private handoff when its target is deleted', async () => {
    const h = setup((url, init) => {
      if (url === '/api/admin/accounts/4' && init.method === 'DELETE') { h.accounts.splice(1, 1); return Promise.resolve(new Response(null, { status: 204 })); }
    });
    await open(); fireEvent.click(screen.getByRole('button', { name: 'Gestionar legacy.c' }));
    fireEvent.change(screen.getByLabelText('Contraseña temporal'), { target: { value: 'test temporary value' } });
    fireEvent.click(screen.getByRole('button', { name: 'Restablecer contraseña' })); await screen.findByRole('region', { name: 'Entrega privada de contraseña' });
    removeUser(); confirm(); await waitFor(() => expect(screen.queryByRole('button', { name: 'Gestionar legacy.c' })).not.toBeInTheDocument());
    expect(screen.queryByRole('region', { name: 'Entrega privada de contraseña' })).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('test temporary value')).not.toBeInTheDocument(); expect(deletes(h)).toHaveLength(1);
  });
  it('sends once while pending and ignores an aborted late outcome after owner retirement', async () => {
    let resolve!: (value: Response) => void; const held = new Promise<Response>(yes => { resolve = yes; });
    const h = setup((url, init) => url === '/api/admin/accounts/4' && init.method === 'DELETE' ? held : undefined);
    await open(); removeUser(); const button = screen.getByRole('button', { name: /confirmar eliminación/i });
    fireEvent.click(button); fireEvent.click(button); expect(deletes(h)).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar sesión' })); await screen.findByLabelText('Usuario');
    expect(deletes(h)[0][1]?.signal?.aborted).toBe(true);
    await act(async () => resolve(new Response(null, { status: 204 })));
    expect(screen.queryByText(/Cuenta actualizada|eliminad[oa]/i)).not.toBeInTheDocument(); expect(deletes(h)).toHaveLength(1);
    expect(h.fetcher.mock.calls.filter(([url]) => url === '/api/admin/accounts')).toHaveLength(1);
  });
  it('does not retry an uncertain deletion or claim success', async () => {
    const h = setup((url, init) => url === '/api/admin/accounts/4' && init.method === 'DELETE' ? Promise.reject(new Error('private transport detail')) : undefined);
    await open(); removeUser(); confirm(); await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: 'Gestionar legacy.c' })).toBeInTheDocument(); expect(deletes(h)).toHaveLength(1);
    expect(screen.queryByText('private transport detail')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/confirmar|consultá|actualizá/i);
  });
});

describe('T6 directory real API workflows', () => {
  it('creates a personal branch operator with only API fields and private one-time delivery', async () => {
    const h = setup(); await open(); fireEvent.click(screen.getByRole('button', { name: '+ Crear usuario' }));
    fireEvent.change(screen.getByLabelText('Nombre completo'), { target: { value: 'Persona nueva' } });
    fireEvent.change(screen.getByLabelText('Usuario', { exact: true }), { target: { value: 'personal.new' } });
    const select = screen.getByLabelText('Sucursal asignada');
    expect(within(select).queryByRole('option', { name: 'Almacén' })).not.toBeInTheDocument();
    fireEvent.change(select, { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('Contraseña temporal'), { target: { value: ' temporal privada ' } });
    expect(writes(h)).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Crear usuario' }));
    const handoff = await screen.findByRole('region', { name: 'Entrega privada de contraseña' });
    exactWrite(h, 0, '/api/admin/accounts', 'POST', { username: 'personal.new', display_name: 'Persona nueva', location_id: 4, temporary_password: ' temporal privada ' });
    expect(writes(h)).toHaveLength(1); expect(within(handoff).getByLabelText('Temporal para entrega')).toHaveAttribute('type', 'password');
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    const copy = vi.fn().mockResolvedValue(undefined); Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
    expect(copy).not.toHaveBeenCalled(); fireEvent.click(within(handoff).getByRole('button', { name: 'Mostrar entrega' }));
    expect(within(handoff).getByLabelText('Temporal para entrega')).toHaveAttribute('type', 'text');
    fireEvent.click(within(handoff).getByRole('button', { name: 'Copiar temporal' })); await waitFor(() => expect(copy).toHaveBeenCalledExactlyOnceWith(' temporal privada '));
    fireEvent.click(within(handoff).getByRole('button', { name: 'Cerrar entrega privada' }));
    expect(screen.queryByDisplayValue(' temporal privada ')).not.toBeInTheDocument();
    expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0); expect(window.location.href).not.toContain('privada');
    await screen.findByRole('button', { name: 'Gestionar personal.new' });
  });
  it('changes only assignment for a legacy blank name, then explicitly reactivates and deactivates', async () => {
    const h = setup(); await open();
    fireEvent.click(screen.getByRole('button', { name: 'Gestionar legacy.c' }));
    fireEvent.change(screen.getByLabelText('Sucursal asignada'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Gestión de cuenta' })).not.toBeInTheDocument());
    exactWrite(h, 0, '/api/admin/accounts/4', 'PATCH', { location_id: 2 });
    for (const [index, access, enabled] of [[1, 'enabled', true], [2, 'disabled', false]] as const) {
      fireEvent.click(await screen.findByRole('button', { name: 'Gestionar legacy.c' }));
      fireEvent.change(screen.getByLabelText('Acceso'), { target: { value: access } });
      fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));
      await waitFor(() => expect(screen.queryByRole('region', { name: 'Gestión de cuenta' })).not.toBeInTheDocument());
      exactWrite(h, index, '/api/admin/accounts/4', 'PATCH', { enabled });
    }
    expect(writes(h)).toHaveLength(3); expect(h.accounts[1].display_name).toBe('');
  });
  it('resets a disabled account without reactivation or previous-secret retrieval', async () => {
    const h = setup(); await open(); fireEvent.click(screen.getByRole('button', { name: 'Gestionar legacy.c' }));
    fireEvent.change(screen.getByLabelText('Contraseña temporal'), { target: { value: 'private reset value' } });
    fireEvent.click(screen.getByRole('button', { name: 'Restablecer contraseña' }));
    await screen.findByRole('region', { name: 'Entrega privada de contraseña' });
    exactWrite(h, 0, '/api/admin/accounts/4/password', 'POST', { temporary_password: 'private reset value' });
    expect(writes(h)).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar entrega privada' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Gestionar legacy.c' }));
    expect(screen.getByLabelText('Acceso')).toHaveValue('disabled'); expect(screen.getByLabelText('Contraseña temporal')).toHaveValue('');
    expect(screen.getByText('Cambio obligatorio', { selector: 'td small' })).toBeInTheDocument();
  });
  it('creates a branch and refetches actual inventory metadata without login or physical reassignment', async () => {
    const h = setup(); await open();
    fireEvent.click(screen.getByRole('button', { name: 'Sucursales' }));
    fireEvent.change(screen.getByLabelText('Nombre de sucursal'), { target: { value: 'Sucursal Sur' } });
    fireEvent.click(screen.getByRole('button', { name: 'Crear sucursal' }));
    await screen.findByText('Sucursal creada: Sucursal Sur. Stock inicial cero.');
    exactWrite(h, 0, '/api/admin/branches', 'POST', { name: 'Sucursal Sur' });
    await waitFor(() => expect(h.fetcher.mock.calls.filter(([url]) => url === '/api/inventory/metadata')).toHaveLength(2));
    fireEvent.click(screen.getByRole('link', { name: 'Inventario' }));
    await screen.findByRole('button', { name: /Sucursal Sur.*Solo consulta/ });
    expect(screen.getByText('Almacén', { selector: '.assigned-location' })).toBeInTheDocument();
    expect(h.fetcher.mock.calls.filter(([url]) => url === '/api/auth/session')).toHaveLength(1);
    expect(writes(h)).toHaveLength(1);
  });
  it('filters locally by search, status and branch without additional HTTP', async () => {
    const h = setup(); await open(); const before = h.fetcher.mock.calls.length;
    fireEvent.change(screen.getByLabelText('Buscar usuario'), { target: { value: 'legacy' } });
    fireEvent.change(screen.getByLabelText('Estado de cuenta'), { target: { value: 'disabled' } });
    fireEvent.change(screen.getByLabelText('Filtrar sucursal'), { target: { value: '4' } });
    expect(screen.getByRole('button', { name: 'Gestionar legacy.c' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Gestionar almacen' })).not.toBeInTheDocument();
    expect(h.fetcher.mock.calls).toHaveLength(before);
  });
  it.each([['conflict', 409], ['forbidden', 403], ['service_unavailable', 503], ['network', 0]])('does not confirm or retry branch failure %s', async (code, status) => {
    const h = setup((url, init) => url === '/api/admin/branches' && init.method === 'POST'
      ? code === 'network' ? Promise.reject(new Error('private detail')) : Promise.resolve(json({ error: code }, Number(status))) : undefined);
    await open(); fireEvent.click(screen.getByRole('button', { name: 'Sucursales' }));
    fireEvent.change(screen.getByLabelText('Nombre de sucursal'), { target: { value: 'Not created' } });
    fireEvent.click(screen.getByRole('button', { name: 'Crear sucursal' })); await screen.findByRole('alert');
    expect(screen.queryByText(/Sucursal creada:/)).not.toBeInTheDocument(); expect(writes(h)).toHaveLength(1);
    expect(screen.getByLabelText('Nombre de sucursal')).toHaveValue('Not created');
    expect(h.fetcher.mock.calls.filter(([url]) => url === '/api/inventory/metadata')).toHaveLength(1);
    expect(screen.queryByText('private detail')).not.toBeInTheDocument();
  });
  it.each([200, 401])('ignores a late directory %s after owner retirement', async status => {
    let resolve!: (value: Response) => void; const held = new Promise<Response>(yes => { resolve = yes; });
    const h = setup((url, init) => url === '/api/admin/accounts' && init.method === 'GET' ? held : undefined);
    render(<App />); await screen.findByRole('heading', { name: 'Inventario' });
    fireEvent.click(screen.getByRole('button', { name: 'Administración' }));
    await screen.findByRole('heading', { name: 'Usuarios y sucursales' });
    await waitFor(() => expect(h.fetcher.mock.calls.some(([url]) => url === '/api/admin/accounts')).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar sesión' })); await screen.findByLabelText('Usuario');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Iniciar sesión' })).toBeEnabled());
    fireEvent.change(screen.getByLabelText('Usuario'), { target: { value: 'new.operator' } });
    fireEvent.change(screen.getByLabelText('Contraseña', { exact: true }), { target: { value: 'private login value' } });
    fireEvent.click(screen.getByRole('button', { name: 'Iniciar sesión' }));
    await screen.findByRole('heading', { name: 'Creá tu contraseña personal' });
    await act(async () => resolve(status === 200 ? json(seed) : json({ error: 'unauthenticated' }, status)));
    expect(screen.queryByText('legacy.c')).not.toBeInTheDocument(); expect(screen.queryByLabelText('Usuario')).not.toBeInTheDocument();
    expect(h.fetcher.mock.calls.filter(([url]) => url === '/api/auth/session')).toHaveLength(2);
    expect(h.fetcher.mock.calls.find(([url]) => url === '/api/admin/accounts')![1]?.signal?.aborted).toBe(true);
  });
});
