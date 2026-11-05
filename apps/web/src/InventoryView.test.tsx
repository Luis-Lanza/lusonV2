import { render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InventoryView } from './App';
import type { Metadata, Query, Session } from './model';
import { createTransferRecovery } from './transferRecovery';
import type { Controller, TransferAuthority } from './useInventory';

// App only mounts InventoryView for an authenticated identity without a pending
// password change, so the shell is rendered directly here: that is the only way to
// drive the same component instance across an authentication transition.
const csrf = 'c'.repeat(43);
const anonymous: Session = { authenticated: false, csrf_token: csrf };
const identity = { account_id: 1, username: 'component-user', display_name: 'Operador', must_change_password: false, location: { id: 1, name: 'Almacén' } };
const session: Session = { authenticated: true, csrf_token: csrf, identity, expires_at: '2030-01-01T00:00:00Z' };
const metadata: Metadata = { locations: [identity.location, { id: 2, name: 'Sucursal A' }], brands: ['TOYO', 'CAR'] };
const query: Query = { location: 1, search: '', brand: '', polarity: '', page: 1, size: 10 };
const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });

// Only the members InventoryView reads at render time are real. The unchecked cast
// mirrors DetailController in TransferDetail.test.tsx: a hand-built controller would
// be a second, silently diverging contract for the ~50-member shell controller.
function controller(authority: TransferAuthority): Controller {
  return {
    session: authority.session, metadata, query, data: null, loading: false, authBusy: false, resultsError: '',
    getTransferAuthority: () => authority,
    subscribeTransferInvalidation: () => () => {},
    // Only a 401 from the count lane reaches this; the stub below never answers 401.
    settleUnauthorized: async () => 'unavailable' as const,
    privateOwner: () => null,
  } as unknown as Controller;
}
// Reachable seam for the component's own effects: the narrow-viewport hook reads it
// during the unauthenticated render, before the authentication gate returns null.
function stubMatchMedia() {
  const matchMedia = vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal('matchMedia', matchMedia);
  return matchMedia;
}
function stubFetch() {
  const mock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    // Only the shell's passive transfer count lane may reach the network here.
    if (url === '/api/transfers/counts') return Promise.resolve(response({ pending_total: '0', action_count: '0' }));
    throw new Error('Unexpected mocked URL: ' + url);
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('InventoryView hook order across an authentication transition', () => {
  it('renders the same instance before and after authentication without changing the hook order', async () => {
    const matchMedia = stubMatchMedia();
    const fetchMock = stubFetch();
    const recovery = createTransferRecovery();
    const view = render(<InventoryView state={controller({ epoch: 1, ready: false, sessionGeneration: 1, session: anonymous })} recovery={recovery} />);
    expect(view.container.querySelector('.app-shell')).toBeNull();
    // The gate is the last statement, not the first: hooks and their effects already ran.
    // React cannot report 0-to-N hook transitions itself (the update dispatcher needs a
    // previous hook list), so this effect is the observable proof of the hook order.
    expect(matchMedia).toHaveBeenCalled();
    // Same mounted instance, authenticated authority: every hook must still be the same hook.
    expect(() => view.rerender(<InventoryView state={controller({ epoch: 1, ready: true, sessionGeneration: 1, session })} recovery={recovery} />))
      .not.toThrow();
    const navigation = await screen.findByRole('navigation', { name: 'Navegación principal' });
    expect(screen.getByText('Almacén', { selector: '.assigned-location' })).toBeInTheDocument();
    // The count lane settling proves the authenticated children mounted, not just the shell div.
    await waitFor(() => expect(within(navigation).getByRole('status')).toHaveTextContent('Acciones requeridas: 0'));
    expect(fetchMock).toHaveBeenCalled();
  });
});
