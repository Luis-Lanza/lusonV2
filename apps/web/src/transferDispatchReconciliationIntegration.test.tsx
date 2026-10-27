import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import TransferDetail from './TransferDetail';
import { transferViewOwner } from './TransferPending';
import { parseSession } from './model';
import type { TransferAuthority, TransferController } from './useInventory';
import { useTransferCountCorrections } from './useTransferCountCorrections';
import { useTransferDispatchReconciliations } from './useTransferDispatchReconciliations';
import { parseDispatchReconciliations, type DispatchReconciliations } from './transferDispatchReconciliationModel';
import { appliedSnapshot, fixture, wire, stamp } from './transferDispatchReconciliationStoreFixtures';
import type { CountCorrections } from './transferCountCorrectionModel';

function counts(snapshot: DispatchReconciliations): CountCorrections {
  return { request_id: snapshot.request_id, operations: [], lines: snapshot.lines.map(l => ({
    variant_id: l.variant_id, expected_quantity: l.expected_quantity, actual_quantity: l.actual_quantity,
    available_quantity: l.available_quantity, effective_dispatch: l.effective_dispatch,
    reconciliation_revision: l.applied_revision, workflow_revision: 0n,
    applied_revision: l.count_applied_revision, effective_actual: l.effective_actual, effective_credit: l.effective_credit, proposals: [],
  })) };
}
function setup(snapshot = appliedSnapshot(), countSnapshot = counts(snapshot)) {
  const f = fixture();
  const authority: TransferAuthority = { epoch: 1, ready: true, sessionGeneration: 1,
    session: parseSession(JSON.stringify({ authenticated: true, csrf_token: 'a'.repeat(43),
      identity: { account_id: 1, username: 'operator', location: { id: 1, name: 'Warehouse' } }, expires_at: '2030-01-01T00:00:00Z' })) };
  const listeners = new Set<() => void>();
  const controller: TransferController = { authorityEpoch: 1, getTransferAuthority: () => authority,
    subscribeTransferInvalidation: cb => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    settleUnauthorized: vi.fn(async () => 'unavailable' as const) };
  const countAPI = { countCorrections: vi.fn(async () => countSnapshot),
    proposeCount: vi.fn(), decideCount: vi.fn() };
  const api = { read: vi.fn(async () => snapshot), propose: vi.fn(), decide: vi.fn() };
  function Pane() {
    const corrections = useTransferCountCorrections({ controller, requestID: f.record.id, api: countAPI });
    const reconciliations = useTransferDispatchReconciliations({ controller, record: f.record, api });
    const connection = { reconciliations, reconciliationRequestID: f.record.id, reconciliationsEnabled: true };
    return <><button onClick={() => { for (const cb of listeners) cb(); }}>Invalidate</button>
      <TransferDetail controller={controller} ownerTag="1/1/1" record={f.record} corrections={corrections}
        correctionRequestID={f.record.id} correctionsEnabled {...connection} /></>;
  }
  const view = render(<Pane />);
  return { ...f, authority, controller, countAPI, api, view };
}
afterEach(() => vi.restoreAllMocks());
it.each([6n, 8n].flatMap(actual => [false, true].map(repeated => ({ actual, repeated }))))('historical count evidence uses its own generation: $actual, repeated $repeated', async ({ actual, repeated }) => {
  const initial = appliedSnapshot(); const credit = actual < 7n ? actual : 7n;
  let snapshot = parseDispatchReconciliations(wire({ ...initial, lines: initial.lines.map(l => l.variant_id !== 1 ? l : {
    ...l, count_generation: 2n, count_applied_revision: 1n, effective_actual: actual, effective_credit: credit,
  }) }), fixture().record);
  if (repeated) {
    const propose = { ...initial.operations[0], operation_key: 'dispatch_proposal_0002', expected_revision: 1n, revision: 2n, dispatch_quantity: actual };
    const accept = { ...initial.operations[1], operation_key: 'dispatch_decision_0002', expected_revision: 2n, revision: 2n,
      source_existing_before: 13n, source_existing_after: 13n + 7n - actual,
      destination_existing_before: 40n, destination_existing_after: 40n + actual - credit };
    snapshot = parseDispatchReconciliations(wire({ ...snapshot, operations: [...snapshot.operations, propose, accept],
      lines: snapshot.lines.map(l => l.variant_id !== 1 ? l : { ...l, effective_dispatch: actual, effective_credit: actual,
        workflow_revision: 2n, applied_revision: 2n, reconciliation_generation: 4n,
        proposals: [...l.proposals, { ...l.proposals[0], revision: 2n, operation_key: propose.operation_key,
          dispatch_quantity: actual, base_dispatch: 7n, base_actual: actual, base_credit: credit, count_generation: 2n, reconciliation_generation: 2n,
          decision: { ...l.proposals[0].decision!, operation_key: accept.operation_key },
          application: { ...l.proposals[0].application!, operation_key: accept.operation_key, effective_dispatch: actual,
            source_delta: 7n - actual, destination_delta: actual - credit } }],
      }) }), fixture().record);
  }
  const countSnapshot = counts(snapshot);
  const corrected: CountCorrections = { ...countSnapshot, operations: [
    { operation_key: 'count_proposal_0001', request_id: 123n, variant_id: 1, actor_location_id: 2, action: 'propose', expected_revision: 0n,
      actual_quantity: actual, reason: 'Recount', revision: 1n, recorded_at: stamp },
    { operation_key: 'count_decision_0001', request_id: 123n, variant_id: 1, actor_location_id: 1, action: 'accept', expected_revision: 1n,
      actual_quantity: null, reason: 'Verified', revision: 1n, recorded_at: stamp },
  ], lines: countSnapshot.lines.map(l => l.variant_id !== 1 ? l : {
    ...l, workflow_revision: 1n, proposals: [{ revision: 1n, operation_key: 'count_proposal_0001', initiator_location_id: 2, actual_quantity: actual,
      base_revision: 0n, base_credit: 7n, reason: 'Recount', recorded_at: stamp, state: 'applied',
      decision: { operation_key: 'count_decision_0001', actor_location_id: 1, accepted: true, reason: 'Verified', recorded_at: stamp },
      application: { effective_credit: credit, delta: credit - 7n, recorded_at: stamp } }],
  }) };
  const before = structuredClone(corrected);
  setup(snapshot, corrected);
  await screen.findByRole('table', { name: 'Conteo efectivo' });
  expect(await screen.findByText('Conteo corregido')).toBeVisible();
  const results = screen.getByRole('region', { name: 'Resultados de corrección confirmados' });
  expect(results).toHaveTextContent(`7 → ${actual}`);
  expect(results).toHaveTextContent(`Cambio de crédito registrado en destino: ${credit - 7n}`);
  expect(corrected).toEqual(before);
});
it('integrated received projection uses reconciled dispatch, retaining the original receipt without exposing actions', async () => {
  const f = setup();
  const table = await screen.findByRole('table', { name: 'Conteo efectivo' });
  await waitFor(() => expect(table.querySelector('tbody tr [data-label="Enviadas"]')).toHaveTextContent('7'));
  expect(table.querySelector('tbody tr [data-label="Crédito efectivo"]')).toHaveTextContent('7');
  expect(within(table).getAllByRole('row')[1]).toHaveTextContent('Sin diferencias de conteo');
  expect(screen.getByRole('region', { name: 'Recepción original', hidden: true })).toHaveTextContent('Baterías enviadas10');
  expect(screen.queryByRole('button', { name: /Proponer regularización|Regularizar despacho/ })).toBeNull();
  expect(f.api.read).toHaveBeenCalledTimes(1);
  expect(f.api.propose).not.toHaveBeenCalled(); expect(f.api.decide).not.toHaveBeenCalled();
});
it('mismatched reconciliation/count generations fail closed rather than showing retained counts as current', async () => {
  const f = setup();
  await screen.findByRole('table', { name: 'Conteo efectivo' });
  f.countAPI.countCorrections.mockResolvedValue(counts(fixture().decode()));
  fireEvent.click(screen.getByRole('button', { name: 'Invalidate' }));
  await waitFor(() => expect(f.countAPI.countCorrections).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByRole('table', { name: 'Conteo efectivo' })).toBeNull());
  expect(screen.getByText('Conteo efectivo no disponible')).toBeVisible();
  expect(f.api.propose).not.toHaveBeenCalled(); expect(f.api.decide).not.toHaveBeenCalled();
});
it('failed reconciliation refresh never relabels retained evidence as current', async () => {
  const f = setup(); await screen.findByRole('table', { name: 'Conteo efectivo' });
  f.api.read.mockRejectedValueOnce(new Error('offline'));
  fireEvent.click(screen.getByRole('button', { name: 'Invalidate' }));
  await screen.findByText('Conteo efectivo no disponible');
  expect(screen.queryByRole('table', { name: 'Conteo efectivo' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Reintentar conteo efectivo' }));
  await screen.findByRole('table', { name: 'Conteo efectivo' });
  expect(f.api.read).toHaveBeenCalledTimes(3);
  expect(f.api.propose).not.toHaveBeenCalled(); expect(f.api.decide).not.toHaveBeenCalled();
});
it('unreconciled receipt preserves original effective dispatch and privacy retirement hides all private quantities', async () => {
  const f = setup(fixture().decode());
  const table = await screen.findByRole('table', { name: 'Conteo efectivo' });
  expect(table.querySelector('tbody tr [data-label="Enviadas"]')).toHaveTextContent('5');
  expect(within(table).getAllByRole('row')[1]).toHaveTextContent('Exceso: 2');
  act(() => { f.authority.ready = false; });
  fireEvent.click(screen.getByRole('button', { name: 'Invalidate' }));
  await waitFor(() => expect(screen.queryByText('TR-123')).toBeNull());
  expect(f.api.read).toHaveBeenCalledTimes(1);
  expect(transferViewOwner(f.controller.getTransferAuthority())).toBeNull();
});
