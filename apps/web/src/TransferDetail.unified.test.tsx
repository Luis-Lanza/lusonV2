import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { parseSession } from './model';
import TransferDetail from './TransferDetail';
import { transferViewOwner } from './TransferPending';
import type { TransferAuthority, TransferController } from './useInventory';
import { unifiedAgreement, wire } from './transferUnifiedReconciliationFixtures';
import { parseUnifiedReconciliations } from './transferUnifiedReconciliationModel';
import type { useTransferUnifiedReconciliations } from './useTransferUnifiedReconciliations';
it('uses coordinated Current in the existing table and a single expected-variant management entry', () => {
  const f = unifiedAgreement();
  const authority: TransferAuthority = { ready: true, epoch: 1, sessionGeneration: 1, session: parseSession(JSON.stringify({
    authenticated: true, csrf_token: 'a'.repeat(43), expires_at: '2030-01-01T00:00:00Z',
    identity: { account_id: 1, username: 'operator', display_name: 'Operator', must_change_password: false, location: { id: 1, name: 'Origin' } } })) };
  const controller: TransferController = { authorityEpoch: 1, getTransferAuthority: () => authority,
    subscribeTransferInvalidation: () => () => {}, settleUnauthorized: vi.fn(async () => 'unavailable' as const) };
  const hook: ReturnType<typeof useTransferUnifiedReconciliations> = { snapshot: parseUnifiedReconciliations(wire(f.raw), f.record),
    busy: false, masked: false, error: null, attempts: [], prepared: null, prepare: vi.fn(() => false), cancel: vi.fn(),
    confirm: vi.fn(async () => {}), refresh: vi.fn(async () => {}), recover: vi.fn(async () => {}), retry: vi.fn(async () => {}) };
  const view = render(<TransferDetail controller={controller} ownerTag={transferViewOwner(authority)!} record={f.record} unified={hook} />);
  const table = screen.getByRole('table', { name: 'Conteo efectivo' });
  const row = within(table).getAllByRole('row')[1];
  expect(within(row).getAllByRole('cell').map(cell => cell.textContent)).toEqual(expect.arrayContaining(['4', '3', '3']));
  fireEvent.click(screen.getByRole('button', { name: 'Gestiones' }));
  expect(screen.getByRole('menuitem', { name: 'Resolver diferencia' })).toBeInTheDocument();
  expect(screen.queryByRole('menuitem', { name: 'Regularizar despacho' })).toBeNull();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Resolver diferencia' }));
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  expect(screen.getByRole('button', { name: 'Gestiones' })).toHaveFocus();
  fireEvent.click(screen.getByText('Ver recepción original'));
  expect(screen.getByRole('region', { name: 'Recepción original' })).toHaveTextContent('14');
  view.rerender(<TransferDetail controller={controller} ownerTag={transferViewOwner(authority)!} record={f.record} unified={{ ...hook, snapshot: null, error: null }} />);
  expect(screen.queryByRole('table', { name: 'Conteo efectivo' })).toBeNull();
  expect(screen.getByRole('heading', { name: 'Conteo efectivo no disponible' })).toBeInTheDocument();
});
