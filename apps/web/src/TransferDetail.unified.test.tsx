import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { parseSession } from './model';
import TransferDetail from './TransferDetail';
import { transferViewOwner } from './TransferPending';
import type { TransferAuthority, TransferController } from './useInventory';
import { unifiedAgreement, wire } from './transferUnifiedReconciliationFixtures';
import { parseUnifiedReconciliations } from './transferUnifiedReconciliationModel';
import type { useTransferUnifiedReconciliations } from './useTransferUnifiedReconciliations';
import { UnifiedReconciliationAPIError } from './transferUnifiedReconciliationAPI';
type Hook = ReturnType<typeof useTransferUnifiedReconciliations>;
function scene(location = 1) {
  const agreement = unifiedAgreement();
  const authority: TransferAuthority = { ready: true, epoch: 1, sessionGeneration: 1, session: parseSession(JSON.stringify({
    authenticated: true, csrf_token: 'a'.repeat(43), expires_at: '2030-01-01T00:00:00Z',
    identity: { account_id: location, username: 'operator', display_name: 'Operator', must_change_password: false,
      location: { id: location, name: location === 1 ? 'Origin' : 'Branch' } } })) };
  const controller: TransferController = { authorityEpoch: 1, getTransferAuthority: () => authority,
    subscribeTransferInvalidation: () => () => {}, settleUnauthorized: vi.fn(async () => 'unavailable' as const) };
  const hook = (patch: Partial<Hook> = {}): Hook => ({ snapshot: parseUnifiedReconciliations(wire(agreement.raw), agreement.record),
    busy: false, masked: false, error: null, attempts: [], prepared: null, prepare: vi.fn(() => false), cancel: vi.fn(),
    confirm: vi.fn(async () => {}), refresh: vi.fn(async () => {}), recover: vi.fn(async () => {}), retry: vi.fn(async () => {}), ...patch });
  const element = (patch: Partial<Hook> = {}) => <TransferDetail controller={controller}
    ownerTag={transferViewOwner(authority)!} record={agreement.record} unified={hook(patch)} />;
  return { agreement, authority, controller, hook, element };
}
it('uses coordinated Current in the existing table and a single direct difference action', () => {
  const f = scene();
  const view = render(f.element());
  const table = screen.getByRole('table', { name: 'Conteo efectivo' });
  const row = within(table).getAllByRole('row')[1];
  expect(within(row).getAllByRole('cell').map(cell => cell.textContent)).toEqual(expect.arrayContaining(['4', '3', '3']));
  // S4: unified reconciliation is the only management flow, so no menu remains.
  expect(screen.queryByRole('button', { name: 'Gestiones' })).toBeNull();
  expect(screen.queryByRole('menu')).toBeNull();
  expect(screen.queryAllByRole('menuitem')).toHaveLength(0);
  const action = screen.getByRole('button', { name: 'Resolver diferencia' });
  expect(screen.getAllByRole('button', { name: 'Resolver diferencia' })).toHaveLength(1);
  // Same trigger semantics: the clicked action opens the modal and regains focus.
  fireEvent.click(action);
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByRole('button', { name: 'Resolver diferencia' })).toBe(action);
  expect(action).toHaveFocus();
  fireEvent.click(screen.getByText('Ver recepción original'));
  expect(screen.getByRole('region', { name: 'Recepción original' })).toHaveTextContent('14');
  view.rerender(f.element({ snapshot: null, error: null }));
  expect(screen.queryByRole('table', { name: 'Conteo efectivo' })).toBeNull();
  expect(screen.getByRole('heading', { name: 'Conteo efectivo no disponible' })).toBeInTheDocument();
});
it('shows a pending table instead of recovery copy while the first coordinated read is in flight', () => {
  const f = scene();
  render(f.element({ snapshot: null, busy: true }));
  const section = screen.getByRole('region', { name: 'Conteo efectivo de recepción' });
  expect(section).toHaveAttribute('aria-busy', 'true');
  expect(within(section).getByRole('heading', { name: 'Cargando conteo efectivo…' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Conteo efectivo no disponible' })).toBeNull();
  // No recovery action may be offered for evidence that is still arriving.
  expect(screen.queryByRole('button', { name: 'Consultar conciliación' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Reintentar conteo efectivo' })).toBeNull();
  // The direct difference action stays reachable, as the menu did for any freshness state.
  expect(screen.getByRole('button', { name: 'Resolver diferencia' })).toBeEnabled();
});
it('keeps retained evidence visible as updating without claiming a confirmed count', () => {
  const f = scene();
  render(f.element({ busy: true }));
  const section = screen.getByRole('region', { name: 'Conteo efectivo de recepción' });
  expect(section).toHaveAttribute('aria-busy', 'true');
  expect(within(section).getByRole('heading', { name: 'Actualizando conteo efectivo…' })).toBeInTheDocument();
  expect(within(section).getByText(/evidencia retenida, pendiente de consulta; no confirma el estado más reciente/)).toBeVisible();
  expect(screen.queryByRole('heading', { name: 'Conteo efectivo confirmado' })).toBeNull();
  const table = screen.getByRole('table', { name: 'Conteo efectivo' });
  const row = within(table).getAllByRole('row')[1];
  expect(within(row).getAllByRole('cell').map(cell => cell.textContent)).toEqual(expect.arrayContaining(['4', '3', '3']));
  expect(screen.getByRole('button', { name: 'Resolver diferencia' })).toBeEnabled();
});
it.each(['masked', 'error'] as const)('renders no effective count for %s evidence and never falls back to the original receipt', mode => {
  const f = scene();
  render(f.element({ masked: mode === 'masked',
    error: mode === 'error' ? new UnifiedReconciliationAPIError('invalid_response', null) : null }));
  expect(screen.getByRole('region', { name: 'Conteo efectivo de recepción' })).toHaveTextContent('Conteo efectivo no disponible');
  expect(screen.queryByRole('table', { name: 'Conteo efectivo' })).toBeNull();
  // Masked evidence hides its own recovery button; a failed read keeps it reachable.
  if (mode === 'masked') expect(screen.queryByRole('button', { name: 'Consultar conciliación' })).toBeNull();
  else expect(screen.getByRole('button', { name: 'Consultar conciliación' })).toBeVisible();
  const action = screen.getByRole('button', { name: 'Resolver diferencia' });
  expect(action).toHaveProperty('disabled', mode === 'masked');
  fireEvent.click(screen.getByText('Ver recepción original'));
  expect(screen.getByRole('table', { name: 'Detalle de recepción' })).toBeVisible();
});
it('hides received evidence from a nonparticipant that was handed the hook', () => {
  const f = scene(3);
  render(f.element());
  expect(document.querySelector('.transfer-received-detail')).toBeNull();
  expect(screen.queryByText('Ver recepción original')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Resolver diferencia' })).toBeNull();
  expect(screen.getByRole('table', { name: 'Detalle de recepción' })).toBeVisible();
});
it('retires received evidence when the mount-bound authority changes', () => {
  const f = scene();
  const view = render(f.element());
  expect(document.querySelector('.transfer-received-detail')).not.toBeNull();
  f.authority.sessionGeneration = 2;
  view.rerender(f.element());
  expect(document.querySelector('.transfer-received-detail')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Resolver diferencia' })).toBeNull();
});
