import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useInventory } from './useInventory';
import type { Session } from './model';

afterEach(() => vi.unstubAllGlobals());
it('does not bootstrap operations or realtime for a mandatory-password session', async () => {
 const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ authenticated: true,
  csrf_token: 'a'.repeat(43), expires_at: '2030-01-01T00:00:00Z', identity: { account_id: 20, username: 'operator_c',
   display_name: 'Operador C', must_change_password: true, location: { id: 4, name: 'Sucursal C' } } }),
  { status: 200, headers: { 'Content-Type': 'application/json' } }));
 const events = vi.fn(); vi.stubGlobal('fetch', fetcher); vi.stubGlobal('EventSource', events);
 const hook = renderHook(() => useInventory());
 await waitFor(() => expect(hook.result.current.authBusy).toBe(false));
 expect(hook.result.current.session).toMatchObject({ authenticated: true, identity: { account_id: 20, must_change_password: true } });
 expect(hook.result.current.getTransferAuthority().ready).toBe(false);
 expect(hook.result.current.metadata).toBeNull();
 expect(hook.result.current.data).toBeNull();
 expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['/api/auth/session']);
 expect(events).not.toHaveBeenCalled();
 expect(hook.result.current.formError).toBe('');
});

const t6Session = { authenticated: true, csrf_token: 'a'.repeat(43), expires_at: '2030-01-01T00:00:00Z', identity: {
 account_id: 1, username: 'almacen', display_name: 'Admin', must_change_password: false, location: { id: 1, name: 'Almacén' } } };
function t6Setup(override?: (url: string, init: RequestInit) => Promise<Response> | undefined) {
 let authenticated = true;
 class Events { addEventListener() {} removeEventListener() {} close() {} }
 vi.stubGlobal('EventSource', Events);
 const fetcher = vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
  const url = String(input); const custom = override?.(url, init); if (custom) return custom;
  if (url === '/api/auth/password') { authenticated = false; return Promise.resolve(new Response(null, { status: 204 })); }
  const value = url === '/api/auth/session' ? authenticated ? t6Session : { authenticated: false, csrf_token: 'b'.repeat(43) }
   : url === '/api/inventory/metadata' ? { locations: [{ id: 1, name: 'Almacén' }, { id: 2, name: 'A' }, { id: 3, name: 'B' }], brands: ['TOYO'] }
   : { location: { id: 1, name: 'Almacén' }, page: 1, page_size: 10, total_variants: 0, items: [] };
  return Promise.resolve(new Response(JSON.stringify(value)));
 });
 vi.stubGlobal('fetch', fetcher); return fetcher;
}
describe('T6 shared controller private ownership', () => {
 it.each(['account', 'display', 'csrf', 'forced', 'assignment'])('refuses stale admin action after in-place %s change before render', async kind => {
  const fetcher = t6Setup(); const { result } = renderHook(() => useInventory());
  await waitFor(() => expect(result.current.data).not.toBeNull());
  const owner = result.current.privateOwner('admin')!;
  const session = result.current.session as Extract<Session, { authenticated: true }>;
  if (kind === 'account') session.identity.account_id = 4;
  if (kind === 'display') session.identity.display_name = 'Changed';
  if (kind === 'csrf') session.csrf_token = 'n'.repeat(43);
  if (kind === 'forced') session.identity.must_change_password = true;
  if (kind === 'assignment') session.identity.location.id = 4;
  await expect(result.current.privateRequest(owner, 'admin', '/api/admin/accounts', new AbortController().signal)).rejects.toThrow('La sesión cambió');
  expect(fetcher.mock.calls.some(([url]) => String(url).startsWith('/api/admin/'))).toBe(false);
 });
 it.each([200, 401])('ignores pending private %s after in-place owner change', async status => {
  let resolve!: (response: Response) => void;
  const held = new Promise<Response>(yes => { resolve = yes; });
  const fetcher = t6Setup(url => url === '/api/admin/accounts' ? held : undefined);
  const { result } = renderHook(() => useInventory()); await waitFor(() => expect(result.current.data).not.toBeNull());
  const owner = result.current.privateOwner('admin')!;
  const pending = result.current.privateRequest(owner, 'admin', '/api/admin/accounts', new AbortController().signal);
  const rejected = expect(pending).rejects.toThrow('La sesión cambió');
  const session = result.current.session as Extract<Session, { authenticated: true }>;
  session.identity.account_id = 4; session.identity.location.id = 4;
  await act(async () => resolve(new Response(JSON.stringify(status === 200 ? [] : { error: 'unauthenticated' }), { status })));
  await rejected;
  expect(result.current.session).toBe(session); expect(result.current.session?.authenticated).toBe(true);
  expect(fetcher.mock.calls.filter(([url]) => url === '/api/auth/session')).toHaveLength(1);
 });
 it('retires owned inventory requests after own-password success without accepting a late 401', async () => {
  let resolve!: (response: Response) => void;
  const held = new Promise<Response>(yes => { resolve = yes; });
  const fetcher = t6Setup(url => url.startsWith('/api/inventory?') ? held : undefined);
  const { result } = renderHook(() => useInventory());
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => String(url).startsWith('/api/inventory?'))).toBe(true));
  const owner = result.current.privateOwner('password')!;
  await act(async () => result.current.changePassword(owner, 'current password', 'different password', new AbortController().signal));
  expect(result.current.session?.authenticated).toBe(false); expect(result.current.data).toBeNull(); expect(result.current.getTransferAuthority().ready).toBe(false);
  expect(fetcher.mock.calls.find(([url]) => String(url).startsWith('/api/inventory?'))![1]?.signal?.aborted).toBe(true);
  await act(async () => resolve(new Response(JSON.stringify({ error: 'unauthenticated' }), { status: 401 })));
  expect(fetcher.mock.calls.filter(([url]) => url === '/api/auth/session')).toHaveLength(2);
  expect(result.current.authNotice).toBe('Contraseña actualizada. Iniciá sesión nuevamente.');
 });
});
