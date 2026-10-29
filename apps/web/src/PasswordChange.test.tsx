import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { useInventory } from './useInventory';
import type { Session } from './model';

const token = 'a'.repeat(43);
const restricted = { authenticated: true, csrf_token: token, expires_at: '2030-01-01T00:00:00Z',
  identity: { account_id: 20, username: 'personal.test', display_name: 'Persona', must_change_password: true, location: { id: 4, name: 'Sucursal C' } } };
const anonymous = { authenticated: false, csrf_token: 'b'.repeat(43) };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function setup(reply: () => Promise<Response>) {
  let current: unknown = restricted;
  const events = vi.fn(); vi.stubGlobal('EventSource', events);
  const fetcher = vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (url === '/api/auth/session') return Promise.resolve(json(current));
    if (url === '/api/auth/password') return reply();
    if (url === '/api/auth/logout') { current = anonymous; return Promise.resolve(new Response(null, { status: 204 })); }
    if (url === '/api/auth/login') { current = { ...restricted, csrf_token: 'n'.repeat(43), identity: { ...restricted.identity, account_id: 30, username: 'new.person' } }; return Promise.resolve(json(current)); }
    throw new Error('Unexpected request');
  });
  vi.stubGlobal('fetch', fetcher);
  return { fetcher, events, anonymous: () => { current = anonymous; } };
}
function fill(current = 'current password  ', next = ' nueva privada é ') {
  fireEvent.change(screen.getByLabelText('Contraseña actual'), { target: { value: current } });
  fireEvent.change(screen.getByLabelText('Nueva contraseña', { exact: true }), { target: { value: next } });
  fireEvent.change(screen.getByLabelText('Confirmar nueva contraseña'), { target: { value: next } });
}
const posts = (fetcher: ReturnType<typeof setup>['fetcher']) => fetcher.mock.calls.filter(([url]) => url === '/api/auth/password');
afterEach(() => vi.unstubAllGlobals());

describe('T6 real password API', () => {
  it('sends preserved bytes and exact CSRF JSON, then retires authority on 204 without auto-login', async () => {
    const h = setup(async () => { h.anonymous(); return new Response(null, { status: 204 }); });
    render(<App />); await screen.findByRole('heading', { name: 'Creá tu contraseña personal' });
    fill(); fireEvent.click(screen.getByRole('button', { name: 'Guardar contraseña' }));
    await screen.findByLabelText('Usuario');
    expect(screen.getByRole('status')).toHaveTextContent('Contraseña actualizada. Iniciá sesión nuevamente.');
    expect(posts(h.fetcher)).toHaveLength(1);
    expect(posts(h.fetcher)[0][1]).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store', body: JSON.stringify({ current_password: 'current password  ', new_password: ' nueva privada é ' }) });
    expect([...new Headers(posts(h.fetcher)[0][1]?.headers)]).toEqual([['content-type', 'application/json'], ['x-csrf-token', token]]);
    expect(h.fetcher.mock.calls.map(([url]) => url)).toEqual(['/api/auth/session', '/api/auth/password', '/api/auth/session']);
    expect(h.events).not.toHaveBeenCalled(); expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
    expect(window.location.href).not.toContain('privada'); expect(screen.queryByDisplayValue(' nueva privada é ')).not.toBeInTheDocument();
  });
  it.each([['invalid_credentials', 401, 'La contraseña actual es incorrecta.'], ['invalid_request', 400, 'Solicitud inválida.'], ['forbidden', 403, 'No tenés permiso'], ['rate_limited', 429, 'Demasiados intentos'], ['service_unavailable', 503, 'Servicio no disponible']])('keeps the valid restricted session after %s', async (code, status, message) => {
    const h = setup(async () => json({ error: code }, Number(status)));
    render(<App />); await screen.findByRole('heading', { name: 'Creá tu contraseña personal' });
    fill(); fireEvent.click(screen.getByRole('button', { name: 'Guardar contraseña' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(String(message)));
    expect(screen.queryByLabelText('Usuario')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Contraseña actual')).toHaveValue('');
    expect(screen.getByLabelText('Nueva contraseña', { exact: true })).toHaveValue('');
    expect(h.fetcher.mock.calls.map(([url]) => url)).toEqual(['/api/auth/session', '/api/auth/password']);
    expect(posts(h.fetcher)).toHaveLength(1); expect(h.events).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
  });
  it.each(['network', 'unexpected200'])('does not claim success or retry an uncertain %s result', async mode => {
    const h = setup(async () => { if (mode === 'network') throw new Error('private transport detail'); return json({}); });
    render(<App />); await screen.findByRole('heading', { name: 'Creá tu contraseña personal' });
    fill(); fireEvent.click(screen.getByRole('button', { name: 'Guardar contraseña' }));
    await screen.findByRole('alert');
    expect(screen.queryByText(/Contraseña actualizada/)).not.toBeInTheDocument();
    expect(screen.queryByText('private transport detail')).not.toBeInTheDocument();
    expect(h.fetcher.mock.calls.map(([url]) => url)).toEqual(['/api/auth/session', '/api/auth/password']);
    expect(screen.getByLabelText('Contraseña actual')).toHaveValue('');
  });
  it.each(['short', 'é'.repeat(65), 'secret\0secret', 'current password  '])('rejects invalid or unchanged new password without a mutation (%s)', async next => {
    const h = setup(async () => new Response(null, { status: 204 }));
    render(<App />); await screen.findByRole('heading', { name: 'Creá tu contraseña personal' });
    fill('current password  ', next); fireEvent.submit(screen.getByRole('button', { name: 'Guardar contraseña' }).closest('form')!);
    await screen.findByRole('alert'); expect(h.fetcher.mock.calls.map(([url]) => url)).toEqual(['/api/auth/session']);
    expect(screen.getByLabelText('Nueva contraseña', { exact: true })).toHaveValue(next);
  });
  it('rejects confirmation mismatch without a mutation', async () => {
    const h = setup(async () => new Response(null, { status: 204 }));
    render(<App />); await screen.findByRole('heading', { name: 'Creá tu contraseña personal' }); fill();
    fireEvent.change(screen.getByLabelText('Confirmar nueva contraseña'), { target: { value: 'different private' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar contraseña' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Las contraseñas no coinciden.'); expect(posts(h.fetcher)).toHaveLength(0);
  });
  it.each([204, 401])('ignores obsolete password %s after logout and new restricted login', async status => {
    let resolve!: (value: Response) => void;
    const held = new Promise<Response>(yes => { resolve = yes; }); const h = setup(() => held);
    render(<App />); await screen.findByRole('heading', { name: 'Creá tu contraseña personal' }); fill();
    fireEvent.click(screen.getByRole('button', { name: 'Guardar contraseña' }));
    await waitFor(() => expect(posts(h.fetcher)).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar sesión' })); await screen.findByLabelText('Usuario');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Iniciar sesión' })).toBeEnabled());
    fireEvent.change(screen.getByLabelText('Usuario'), { target: { value: 'new.person' } });
    fireEvent.change(screen.getByLabelText('Contraseña', { exact: true }), { target: { value: 'different private' } });
    fireEvent.click(screen.getByRole('button', { name: 'Iniciar sesión' }));
    await screen.findByRole('heading', { name: 'Creá tu contraseña personal' });
    await act(async () => resolve(status === 204 ? new Response(null, { status }) : json({ error: 'unauthenticated' }, status)));
    expect(screen.queryByLabelText('Usuario')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Contraseña actual')).toHaveValue('');
    expect(posts(h.fetcher)[0][1]?.signal?.aborted).toBe(true);
    expect(h.fetcher.mock.calls.map(([url]) => url)).toEqual(['/api/auth/session', '/api/auth/password', '/api/auth/logout', '/api/auth/session', '/api/auth/login']);
    expect(h.events).not.toHaveBeenCalled();
  });
  it('rejects an in-place identity change before submission even without a React render', async () => {
    const h = setup(async () => new Response(null, { status: 204 }));
    const { result } = renderHook(() => useInventory()); await waitFor(() => expect(result.current.authBusy).toBe(false));
    const owner = result.current.privateOwner('password')!;
    const session = result.current.session as Extract<Session, { authenticated: true }>;
    session.identity.account_id = 21;
    await expect(result.current.changePassword(owner, 'current password', 'different password', new AbortController().signal)).rejects.toThrow('La sesión cambió');
    expect(h.fetcher.mock.calls.map(([url]) => url)).toEqual(['/api/auth/session']);
  });
});
