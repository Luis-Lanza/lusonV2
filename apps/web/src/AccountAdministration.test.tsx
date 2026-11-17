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
function setup(override?: (url: string, init: RequestInit) => Promise<Response> | undefined,
  configured: { branch_location_id: number; commission_rate_percent: string; updated_at: string; updated_by: string }[] = []) {
  const accounts = structuredClone(seed);
  const commissions = [...configured];
  const branches = [{ id: 1, name: 'Almacén' }, { id: 2, name: 'Sucursal A' }, { id: 3, name: 'Sucursal B' }, { id: 4, name: 'Sucursal C' }];
  // One row per live branch: the drawer's expectation and the purchase fund, both read from the
  // ledgers by the server, plus whether a live settlement is holding the branch (S7, S8).
  const balances = [
    { branch_id: 2, cash_balance: '5000.00', fund_balance: '3000.00', frozen: false },
    { branch_id: 3, cash_balance: '0.00', fund_balance: '0.00', frozen: true },
    { branch_id: 4, cash_balance: '120.50', fund_balance: '-30.00', frozen: false },
  ];
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
    if (url === '/api/admin/branches' && init.method === 'POST') { const body = JSON.parse(String(init.body)); const branch = { id: 5, name: body.name }; branches.push(branch); balances.push({ branch_id: 5, cash_balance: body.opening_cash, fund_balance: body.purchase_fund, frozen: false }); return Promise.resolve(json(branch, 201)); }
    if (url === '/api/admin/branches/balances' && init.method === 'GET') return Promise.resolve(json(balances));
    const funds = /^\/api\/admin\/branches\/(\d+)\/funds$/.exec(url);
    if (funds && init.method === 'POST') {
      const body = JSON.parse(String(init.body)); const row = balances.find(item => item.branch_id === Number(funds[1]))!;
      row.cash_balance = plus(row.cash_balance, body.opening_cash);
      row.fund_balance = plus(row.fund_balance, body.purchase_fund);
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (url === '/api/closings/branches/commissions' && init.method === 'GET') return Promise.resolve(json(commissions));
    const commission = /^\/api\/closings\/branches\/(\d+)\/commission$/.exec(url);
    if (commission && init.method === 'POST') {
      const rate = JSON.parse(String(init.body)).commission_rate_percent;
      const branch = Number(commission[1]);
      const existing = commissions.findIndex(item => item.branch_location_id === branch);
      const entry = { branch_location_id: branch, commission_rate_percent: rate, updated_at: '2026-11-15T04:48:56Z', updated_by: 'Admin' };
      if (existing < 0) commissions.push(entry); else commissions[existing] = entry;
      return Promise.resolve(json({ branch_location_id: branch, commission_rate_percent: rate }));
    }
    throw new Error('Unexpected request');
  });
  vi.stubGlobal('fetch', fetcher);
  return { fetcher, accounts, branches, commissions, balances };
}
/** Exact cents of a balance, added the way the ledgers add them: the mock server only. */
function plus(balance: string, amount: string): string {
  const cents = (text: string) => { const [whole, fraction] = text.split('.'); return BigInt(whole) * 100n + BigInt(fraction); };
  const total = cents(balance) + cents(amount);
  const magnitude = total < 0n ? -total : total;
  return `${total < 0n ? '-' : ''}${magnitude / 100n}.${(magnitude % 100n).toString().padStart(2, '0')}`;
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
    fireEvent.change(screen.getByLabelText('Fondo de caja operativa'), { target: { value: '500' } });
    fireEvent.change(screen.getByLabelText('Fondo de compras'), { target: { value: '300,5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Crear sucursal' }));
    await screen.findByText('Sucursal creada: Sucursal Sur. Stock inicial cero.');
    // The two amounts are mandatory in the payload and they are the canonical text the
    // server stores, whatever the operator typed (S1, S13).
    exactWrite(h, 0, '/api/admin/branches', 'POST', { name: 'Sucursal Sur', opening_cash: '500.00', purchase_fund: '300.50' });
    await waitFor(() => expect(h.fetcher.mock.calls.filter(([url]) => url === '/api/inventory/metadata')).toHaveLength(2));
    fireEvent.click(screen.getByRole('link', { name: 'Inventario' }));
    await screen.findByRole('button', { name: /Sucursal Sur.*Solo consulta/ });
    expect(screen.getByText('Almacén', { selector: '.assigned-location' })).toBeInTheDocument();
    expect(h.fetcher.mock.calls.filter(([url]) => url === '/api/auth/session')).toHaveLength(1);
    expect(writes(h)).toHaveLength(1);
  });
  it('asks for both amounts, refuses to submit without them and warns what 0,00 means (S1, S3)', async () => {
    const h = setup(); await open();
    fireEvent.click(screen.getByRole('button', { name: 'Sucursales' }));
    // Both boxes are stated as required fields of the form and of the payload: silence is
    // never an answer, and it is never read as 0,00 behind the operator's back.
    expect(screen.getByLabelText('Fondo de caja operativa')).toBeRequired();
    expect(screen.getByLabelText('Fondo de compras')).toBeRequired();
    fireEvent.change(screen.getByLabelText('Nombre de sucursal'), { target: { value: 'Sucursal Sur' } });
    fireEvent.click(screen.getByRole('button', { name: 'Crear sucursal' }));
    expect(writes(h)).toHaveLength(0);
    // Filling only one of them is still not a founding, and it is not sent.
    fireEvent.change(screen.getByLabelText('Fondo de caja operativa'), { target: { value: '500' } });
    fireEvent.click(screen.getByRole('button', { name: 'Crear sucursal' }));
    expect(writes(h)).toHaveLength(0);
    // Text that is not an amount this house admits is refused before the wire, and it
    // says which of the two boxes is wrong.
    fireEvent.change(screen.getByLabelText('Fondo de caja operativa'), { target: { value: '500,005' } });
    fireEvent.change(screen.getByLabelText('Fondo de compras'), { target: { value: '300' } });
    fireEvent.click(screen.getByRole('button', { name: 'Crear sucursal' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Ingresá el fondo de caja operativa');
    expect(writes(h)).toHaveLength(0);
    // 0,00 is admitted as the explicit answer it is, and the form says what it means: the
    // branch is born unable to spend until the warehouse loads that fund.
    fireEvent.change(screen.getByLabelText('Fondo de caja operativa'), { target: { value: '500' } });
    fireEvent.change(screen.getByLabelText('Fondo de compras'), { target: { value: '0,00' } });
    expect(await screen.findByText(/Declaraste 0,00/)).toHaveTextContent(/sin plata para gastar hasta que el almacén cargue ese fondo/);
    fireEvent.click(screen.getByRole('button', { name: 'Crear sucursal' }));
    await screen.findByText('Sucursal creada: Sucursal Sur. Stock inicial cero.');
    exactWrite(h, 0, '/api/admin/branches', 'POST', { name: 'Sucursal Sur', opening_cash: '500.00', purchase_fund: '0.00' });
    expect(writes(h)).toHaveLength(1);
    // The warning is about a stated zero, so it does not outlive the form it described.
    expect(screen.queryByText(/Declaraste 0,00/)).not.toBeInTheDocument();
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
    fireEvent.change(screen.getByLabelText('Fondo de caja operativa'), { target: { value: '500' } });
    fireEvent.change(screen.getByLabelText('Fondo de compras'), { target: { value: '300' } });
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

describe('the commission of each branch', () => {
  const configured = [{
    branch_location_id: 2, commission_rate_percent: '4.50',
    updated_at: '2026-11-15T04:48:56Z', updated_by: 'Admin',
  }];

  it('shows the configured rate with its author and marks every branch that has none', async () => {
    setup(undefined, configured);
    await open(); fireEvent.click(screen.getByRole('button', { name: 'Sucursales' }));

    // The configured branch states its rate and who fixed it; the rest say they have none,
    // which is the same state that blocks their settlement.
    await waitFor(() => expect(screen.getAllByText('Sin configurar')).toHaveLength(2));
    expect(screen.getByText('4,50 % · Admin', { exact: false })).toBeTruthy();
    expect(screen.getAllByText('sin eso la sucursal no puede proponer su rendición', { exact: false })).toHaveLength(2);
    // The warehouse is never a branch that pays a commission.
    expect(screen.getByText('Almacén protegido')).toBeTruthy();
    // The audit of a money parameter says who fixed it and when (S4).
    expect(screen.getByText(/\d{2}\/\d{2}\/\d{4},? \d{2}:\d{2}/)).toBeTruthy();
    // Two branches still have no rate; the configured one offers to change it instead.
    expect(screen.getAllByRole('button', { name: 'Configurar comisión' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Cambiar comisión' })).toHaveLength(1);
  });

  it('keeps working when a rate names a branch the directory no longer lists', async () => {
    // The server filters retired branches, so this is the defensive read of a list that carries
    // one anyway: the extra entry is not a broken answer, it is a branch that no longer exists.
    setup(undefined, [...configured, { branch_location_id: 3, commission_rate_percent: '5.00',
      updated_at: '2026-11-15T04:48:56Z', updated_by: 'Admin' }]);
    await open(); fireEvent.click(screen.getByRole('button', { name: 'Sucursales' }));

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.getByText('Sucursal A')).toBeTruthy();
    expect(screen.getByText('4,50 % · Admin', { exact: false })).toBeTruthy();
    // The branch that does exist and has no rate is the one the panel flags.
    expect(screen.getAllByText('Sin configurar')).toHaveLength(1);
  });

  it('writes the rate through the settlement surface that owns the rule and refetches the panel', async () => {
    const h = setup();
    await open(); fireEvent.click(screen.getByRole('button', { name: 'Sucursales' }));
    fireEvent.click((await screen.findAllByRole('button', { name: 'Configurar comisión' }))[0]);
    const input = screen.getByLabelText('Porcentaje de comisión');
    fireEvent.change(input, { target: { value: '4,5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar comisión' }));

    await waitFor(() => expect(h.commissions).toEqual([{
      branch_location_id: 2, commission_rate_percent: '4.50',
      updated_at: '2026-11-15T04:48:56Z', updated_by: 'Admin',
    }]));
    const write = h.fetcher.mock.calls.find(([url]) => String(url) === '/api/closings/branches/2/commission');
    expect(write?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify({ commission_rate_percent: '4.50' }) });
    // The panel reads the list again and shows the rate it just fixed.
    await waitFor(() => expect(screen.getAllByText('Sin configurar')).toHaveLength(2));
    expect(await screen.findByText('4,50 % · Admin', { exact: false })).toBeTruthy();
    expect(screen.getByText('Comisión actualizada: rige para la próxima rendición que se proponga.')).toBeTruthy();
  });

  it('refuses a percentage the server would not admit without writing anything', async () => {
    const h = setup();
    await open(); fireEvent.click(screen.getByRole('button', { name: 'Sucursales' }));
    fireEvent.click((await screen.findAllByRole('button', { name: 'Configurar comisión' }))[0]);
    fireEvent.change(screen.getByLabelText('Porcentaje de comisión'), { target: { value: '100,01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar comisión' }));

    expect(await screen.findByText('Ingresá un porcentaje entre 0 y 100, con hasta dos decimales.')).toBeTruthy();
    expect(h.fetcher.mock.calls.some(([url]) => String(url).includes('/commission') && String(url) !== '/api/closings/branches/commissions')).toBe(false);
  });
});

describe('the two balances of each branch and the load of its funds', () => {
  const card = (name: string) => screen.getByRole('heading', { name, level: 3 }).closest('article')!;
  async function branchesTab() {
    await open(); fireEvent.click(screen.getByRole('button', { name: 'Sucursales' }));
    await screen.findByRole('region', { name: 'Saldos de Sucursal A' });
  }

  it('publishes the two balances the server reads from the ledgers, and none for the warehouse', async () => {
    setup(); await branchesTab();

    const a = within(card('Sucursal A'));
    expect(a.getByText('Fondo de caja operativa')).toBeTruthy();
    expect(a.getByText('Fondo de compras')).toBeTruthy();
    expect(a.getByText('Bs 5.000,00')).toBeTruthy();
    expect(a.getByText('Bs 3.000,00')).toBeTruthy();
    // A signed balance is published exactly as the server states it: a shortage is negative
    // and it is never zeroed, clamped or recomputed by the panel (S7).
    expect(within(card('Sucursal C')).getByText('-Bs 30,00')).toBeTruthy();
    // The warehouse owns no drawer and no fund, so it shows no balances at all.
    expect(within(card('Almacén')).queryByRole('region')).toBeNull();
  });

  it('says a frozen branch is being counted instead of publishing numbers about to change', async () => {
    setup(); await branchesTab();

    const b = within(card('Sucursal B'));
    expect(b.getByText(/Rendición en curso/)).toHaveTextContent(/congelada/);
    expect(b.queryByText(/^Bs /)).toBeNull();
    expect(b.queryByText(/^-Bs /)).toBeNull();
    // Money stated into a till being counted would break the count, so the panel does not
    // offer the load at all while the settlement holds the branch (S5).
    expect(b.queryByRole('button', { name: 'Cargar fondos' })).toBeNull();
  });

  it('loads both funds of a branch that already exists and shows the numbers the server returns', async () => {
    const h = setup(); await branchesTab();

    const a = within(card('Sucursal A'));
    fireEvent.click(a.getByRole('button', { name: 'Cargar fondos' }));
    const cash = a.getByLabelText('Fondo de caja operativa');
    const fund = a.getByLabelText('Fondo de compras');
    // Both boxes are required fields: silence is never read as 0,00 behind the operator (S2).
    expect(cash).toBeRequired(); expect(fund).toBeRequired();
    fireEvent.click(a.getByRole('button', { name: 'Confirmar carga' }));
    expect(writes(h)).toHaveLength(0);
    fireEvent.change(cash, { target: { value: '500' } });
    fireEvent.click(a.getByRole('button', { name: 'Confirmar carga' }));
    expect(writes(h)).toHaveLength(0);
    // Text that is not an amount this house admits is refused before the wire, naming the box.
    fireEvent.change(cash, { target: { value: '500,005' } });
    fireEvent.change(fund, { target: { value: '300' } });
    fireEvent.click(a.getByRole('button', { name: 'Confirmar carga' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Ingresá el fondo de caja operativa');
    expect(writes(h)).toHaveLength(0);

    fireEvent.change(cash, { target: { value: '1000' } });
    fireEvent.click(a.getByRole('button', { name: 'Confirmar carga' }));
    await screen.findByText(/Fondos cargados/);
    exactWrite(h, 0, '/api/admin/branches/2/funds', 'POST', { opening_cash: '1000.00', purchase_fund: '300.00' });
    expect(writes(h)).toHaveLength(1);
    // The panel reads the books again and shows the server's new number; the branch keeps
    // operating, because a load does not freeze it (S6, S7).
    await waitFor(() => expect(within(card('Sucursal A')).getByText('Bs 6.000,00')).toBeTruthy());
    expect(within(card('Sucursal A')).getByText('Bs 3.300,00')).toBeTruthy();
    expect(h.fetcher.mock.calls.filter(([url]) => url === '/api/admin/branches/balances')).toHaveLength(2);
    // The form is gone: the create-branch box is the only one left on the screen.
    expect(screen.getAllByLabelText('Fondo de caja operativa')).toHaveLength(1);
  });

  it('warns what a stated 0,00 means and still sends it as the answer it is', async () => {
    const h = setup(); await branchesTab();

    const c = within(card('Sucursal C'));
    fireEvent.click(c.getByRole('button', { name: 'Cargar fondos' }));
    fireEvent.change(c.getByLabelText('Fondo de caja operativa'), { target: { value: '0,00' } });
    fireEvent.change(c.getByLabelText('Fondo de compras'), { target: { value: '0' } });
    expect(await c.findByText(/Declaraste 0,00 en las dos cajas/)).toHaveTextContent(/no escribe ningún movimiento/);
    fireEvent.click(c.getByRole('button', { name: 'Confirmar carga' }));
    await screen.findByText(/Fondos cargados/);
    exactWrite(h, 0, '/api/admin/branches/4/funds', 'POST', { opening_cash: '0.00', purchase_fund: '0.00' });
    expect(writes(h)).toHaveLength(1);
  });

  it.each([
    ['branch_frozen', 409, /rendición en curso/i],
    ['forbidden', 403, /permiso/i],
    ['network', 0, /confirmar|consultá/i],
  ] as const)('keeps the form and explains a refused load (%s)', async (code, status, explanation) => {
    const h = setup((url, init) => url === '/api/admin/branches/2/funds' && init.method === 'POST'
      ? code === 'network' ? Promise.reject(new Error('private detail')) : Promise.resolve(json({ error: code }, status)) : undefined);
    await branchesTab();
    const a = within(card('Sucursal A'));
    fireEvent.click(a.getByRole('button', { name: 'Cargar fondos' }));
    fireEvent.change(a.getByLabelText('Fondo de caja operativa'), { target: { value: '1000' } });
    fireEvent.change(a.getByLabelText('Fondo de compras'), { target: { value: '300' } });
    fireEvent.click(a.getByRole('button', { name: 'Confirmar carga' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(explanation);
    expect(screen.queryByText('private detail')).toBeNull();
    expect(screen.queryByText(/Fondos cargados/)).toBeNull();
    // Nothing is retried and the stated amounts are still there to be checked.
    expect(writes(h)).toHaveLength(1);
    expect(a.getByLabelText('Fondo de caja operativa')).toHaveValue('1000');
    expect(a.getByLabelText('Fondo de compras')).toHaveValue('300');
    expect(within(card('Sucursal A')).getByText('Bs 5.000,00')).toBeTruthy();
  });

  it('refuses a balance the panel could not have read instead of inventing a number', async () => {
    setup((url, init) => url === '/api/admin/branches/balances' && init.method === 'GET'
      ? Promise.resolve(json([{ branch_id: 2, cash_balance: '5000.00', fund_balance: '3000.00', frozen: false }])) : undefined);
    render(<App />); await screen.findByRole('heading', { name: 'Inventario' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Administración' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Administración' }));

    // A directory branch without its balance row is an answer this house did not produce: the
    // panel fails closed rather than showing a branch with no money, and it renders no number.
    expect(await screen.findByRole('alert')).toHaveTextContent('Respuesta inválida del servidor.');
    expect(screen.queryByText(/^Bs /)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Gestionar legacy.c' })).toBeNull();
  });
});

describe('the panel arrives where the settlement sends it', () => {
  it('opens the branches screen directly from the hash the blocker links to', async () => {
    const h = setup(undefined, [{ branch_location_id: 2, commission_rate_percent: '4.50',
      updated_at: '2026-11-15T04:48:56Z', updated_by: 'Admin' }]);
    window.location.hash = '#/administracion/sucursales';
    render(<App />);
    // The tab is already the branches one: the operator lands where the rate is fixed, not on
    // the accounts directory to find it.
    expect(await screen.findByRole('button', { name: 'Sucursales' })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(screen.getAllByText('Sin configurar')).toHaveLength(2));
    expect(h.commissions).toHaveLength(1);
    window.location.hash = '';
  });
});
