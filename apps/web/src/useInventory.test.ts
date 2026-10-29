import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useInventory } from './useInventory';

afterEach(() => vi.unstubAllGlobals());
it('does not bootstrap operations or realtime for a mandatory-password session', async () => {
 const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ authenticated: true,
  csrf_token: 'a'.repeat(43), expires_at: '2030-01-01T00:00:00Z', identity: { account_id: 20, username: 'operator_c',
   display_name: 'Operador C', must_change_password: true, location: { id: 4, name: 'Sucursal C' } } }),
  { status: 200, headers: { 'Content-Type': 'application/json' } }));
 const events = vi.fn(); vi.stubGlobal('fetch', fetcher); vi.stubGlobal('EventSource', events);
 const hook = renderHook(() => useInventory());
 await waitFor(() => expect(hook.result.current.authBusy).toBe(false));
 expect(hook.result.current.session).toBeNull();
 expect(hook.result.current.getTransferAuthority().ready).toBe(false);
 expect(hook.result.current.metadata).toBeNull();
 expect(hook.result.current.data).toBeNull();
 expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['/api/auth/session']);
 expect(events).not.toHaveBeenCalled();
 expect(hook.result.current.formError).toBe('La cuenta requiere cambiar la contraseña antes de operar.');
});
