import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { parseSession } from './model';
import type { TransferAuthority, TransferController } from './useInventory';
import { unifiedAgreement, unifiedFixture, wire } from './transferUnifiedReconciliationFixtures';
import { parseUnifiedReconciliations } from './transferUnifiedReconciliationModel';
import { UnifiedReconciliationAPIError } from './transferUnifiedReconciliationAPI';
import { useTransferUnifiedReconciliations } from './useTransferUnifiedReconciliations';
import TransferUnifiedReconciliation from './TransferUnifiedReconciliation';

function setup(actor = 1, pending = false) {
  const f = pending ? unifiedAgreement('pending', '4', '3', '1', actor === 1 ? 2 : 1) : unifiedFixture();
  const authority: TransferAuthority = { epoch: 1, ready: true, sessionGeneration: 1,
    session: parseSession(JSON.stringify({ authenticated: true, csrf_token: 'a'.repeat(43),
      identity: { account_id: actor, username: 'operator', display_name: 'Operator', must_change_password: false,
        location: { id: actor, name: 'Location' } }, expires_at: '2030-01-01T00:00:00Z' })) };
  const controller: TransferController = { authorityEpoch: 1, getTransferAuthority: () => authority,
    subscribeTransferInvalidation: () => () => {}, settleUnauthorized: vi.fn(async () => 'unavailable' as const) };
  const api = { read: vi.fn(async () => parseUnifiedReconciliations(wire(f.raw), f.record)),
    propose: vi.fn(async () => { throw new UnifiedReconciliationAPIError('network', null, true); }),
    decide: vi.fn(async () => { throw new UnifiedReconciliationAPIError('network', null, true); }) };
  function Harness() {
    const hook = useTransferUnifiedReconciliations({ controller, record: f.record, api });
    return <TransferUnifiedReconciliation controller={controller} record={f.record} reconciliations={hook} />;
  }
  return { ...f, authority, api, Harness };
}
async function open() { fireEvent.click(await screen.findByRole('button', { name: 'Resolver diferencia' })); }
function facts(d: string, a: string, r: string) {
  fireEvent.change(screen.getByLabelText('Salieron realmente'), { target: { value: d } });
  fireEvent.change(screen.getByLabelText('Llegaron realmente'), { target: { value: a } });
  fireEvent.change(screen.getByLabelText('Quedaron físicamente en origen'), { target: { value: r } });
  fireEvent.change(screen.getByLabelText('Motivo y evidencia'), { target: { value: 'Recuento físico' } });
}
describe('unified modal', () => {
  it.each([['7', '8', '0'], ['3', '2', '1'], ['0', '0', '0']])('reviews allowed facts %s/%s/%s without posting until explicit confirmation', async (d, a, r) => {
    const f = setup(); render(<f.Harness />); await open(); facts(d, a, r);
    if (r !== '0') fireEvent.click(screen.getByLabelText(/Verifiqué físicamente/));
    fireEvent.click(screen.getByRole('button', { name: 'Revisar propuesta' }));
    expect(screen.getByRole('heading', { name: 'Revisar efectos' })).toBeInTheDocument();
    expect(screen.getByText(/Sin localizar no equivale/)).toBeInTheDocument();
    expect(f.api.propose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar propuesta' }));
    await waitFor(() => expect(f.api.propose).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Resultado incierto')).toBeInTheDocument();
    expect(f.api.propose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Consultar operación' }));
    await waitFor(() => expect(f.api.read.mock.calls.length).toBeGreaterThan(1));
    expect(f.api.propose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar exactamente la misma operación' }));
    await waitFor(() => expect(f.api.propose).toHaveBeenCalledTimes(2));
    expect(f.api.propose.mock.calls[1].slice(0, 4)).toEqual(f.api.propose.mock.calls[0].slice(0, 4));
  });
  it.each([1, 2].flatMap(actor => (['accept', 'reject'] as const).map(action => ({ actor, action }))))('allows counterparty $actor to review $action, with origin-only attestation', async ({ actor, action }) => {
    const f = setup(actor, true); render(<f.Harness />); await open();
    expect(screen.queryByLabelText(/Verifiqué físicamente/)).toBe(actor === 1 ? screen.getByLabelText(/Verifiqué físicamente/) : null);
    fireEvent.change(screen.getByLabelText('Motivo y evidencia'), { target: { value: 'Verificado' } });
    if (actor === 1) fireEvent.click(screen.getByLabelText(/Verifiqué físicamente/));
    fireEvent.click(screen.getByRole('button', { name: action === 'accept' ? 'Revisar aceptación' : 'Revisar rechazo' }));
    expect(f.api.decide).not.toHaveBeenCalled();
    if (action === 'reject') {
      expect(screen.getByText('Cambio de existencias en origen').nextElementSibling).toHaveTextContent(/^0$/);
      expect(screen.getByText('Cambio de crédito destino').nextElementSibling).toHaveTextContent(/^0$/);
    }
    fireEvent.click(screen.getByRole('button', { name: action === 'accept' ? 'Confirmar aceptación' : 'Confirmar rechazo' }));
    await waitFor(() => expect(f.api.decide).toHaveBeenCalledTimes(1));
  });
  it('closes and restores focus without posting', async () => {
    const f = setup(); render(<f.Harness />); await open();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Resolver diferencia' })).toHaveFocus();
    expect(f.api.propose).not.toHaveBeenCalled();
  });
  it('masks an open modal when authority changes', async () => {
    const f = setup(); const view = render(<f.Harness />); await open();
    f.authority.epoch++; view.rerender(<f.Harness />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(f.api.propose).not.toHaveBeenCalled();
  });
});
