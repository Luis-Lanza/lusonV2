import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import TransferDetail from './TransferDetail';
import TransferPending, { transferViewOwner } from './TransferPending';
import { parseSession } from './model';
import { useInventory, type TransferAuthority, type TransferController } from './useInventory';
import TransferDispatchReconciliations from './TransferDispatchReconciliations';
import { useTransferCountCorrections } from './useTransferCountCorrections';
import { useTransferDispatchReconciliations } from './useTransferDispatchReconciliations';
import { parseDispatchReconciliations, type DispatchReconciliations } from './transferDispatchReconciliationModel';
import { appliedSnapshot, deferred, fixture, wire, stamp } from './transferDispatchReconciliationStoreFixtures';
import type { CountCorrections } from './transferCountCorrectionModel';
import { createTransferRestitutionRecovery } from './transferRestitutionRecovery';

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
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
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

// No injected reconciliation callbacks: Pending owns the hook and the typed API
// traverses mocked fetch. The transport is synthetic, never a business ledger.
function activationFixture(pending = false, actor = 1) {
  const f = fixture(pending);
  const authority: TransferAuthority = { epoch: 1, ready: true, sessionGeneration: 1,
    session: parseSession(JSON.stringify({ authenticated: true, csrf_token: 'a'.repeat(43),
      identity: { account_id: actor, username: 'operator', location: { id: actor, name: actor === 1 ? 'Warehouse' : 'Branch' } },
      expires_at: '2030-01-01T00:00:00Z' })) };
  const listeners = new Set<() => void>();
  const confirmed = vi.fn();
  const controller: TransferController = { authorityEpoch: 1, getTransferAuthority: () => authority,
    subscribeTransferInvalidation: cb => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    settleUnauthorized: vi.fn(async () => 'unavailable' as const), confirmTransferDispatchReconciliation: confirmed,
    restitutionRecovery: createTransferRestitutionRecovery() };
  const response = (value: unknown, status = 200) => new Response(wire(value), {
    status, headers: { 'Content-Type': 'application/json' },
  });
  let unknown = false;
  const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (init.method === 'POST') {
      if (unknown) throw new Error('synthetic lost response');
      const payload = JSON.parse(String(init.body));
      const action = url.split('/').at(-1);
      return response({ ...f.op, ...payload, action, request_id: f.record.id, actor_location_id: actor,
        revision: '1', dispatch_quantity: action === 'propose' ? payload.dispatch_quantity : null,
        source_existing_before: action === 'accept' ? '15' : null,
        source_existing_after: action === 'accept' ? '13' : null,
        destination_existing_before: action === 'accept' ? '15' : null,
        destination_existing_after: action === 'accept' ? '17' : null });
    }
    if (url === '/api/transfers/counts') return response({ pending_total: '0', action_count: '0' });
    if (url.startsWith('/api/transfers?')) {
      const q = new URL(url, 'http://localhost').searchParams;
      return response({ page: Number(q.get('page')), page_size: Number(q.get('page_size')),
        status: q.get('status'), total_count: '1', records: [f.record] });
    }
    if (url === '/api/transfers/123') return response(f.record);
    if (url.endsWith('/dispatch-reconciliations')) return response(f.raw);
    if (url.endsWith('/count-corrections')) return response(counts(f.decode()));
    if (url.endsWith('/restitutions')) return response({ error: 'service_unavailable' }, 503);
    throw new Error(`Unexpected activation route: ${url}`);
  });
  vi.stubGlobal('fetch', fetch);
  const ownerTag = transferViewOwner(authority)!;
  const element = (id: string | null = '123') => <TransferPending controller={controller} ownerTag={ownerTag}
    routedDetail={id} onInventory={vi.fn()} />;
  return { ...f, authority, listeners, controller, confirmed, fetch, element,
    loseResponse: () => { unknown = true; },
    posts: () => fetch.mock.calls.filter(([, init]) => init?.method === 'POST') };
}
async function activationOpen() {
  await screen.findByRole('table', { name: 'Conteo efectivo' });
  fireEvent.click(screen.getByRole('button', { name: 'Gestiones' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Regularizar despacho' }));
  await screen.findByRole('heading', { name: 'Regularización de despacho' });
}
function activationReview(action: 'propose' | 'accept' | 'reject') {
  if (action === 'propose') fireEvent.click(screen.getAllByRole('button', { name: 'Proponer regularización' })[0]);
  else {
    fireEvent.click(screen.getByRole('button', { name: 'Consultar propuesta' }));
    fireEvent.click(screen.getByRole('button', { name: action === 'accept' ? 'Aceptar propuesta' : 'Rechazar propuesta' }));
  }
  fireEvent.change(screen.getByLabelText('Motivo y confirmación de lo ocurrido'), { target: { value: 'Verified activation evidence' } });
  fireEvent.click(screen.getByRole('button', { name: 'Ver revisión de propuesta' }));
}
it('activation integration traverses three visible menu entries and focuses the selected context without duplicate entry', async () => {
  const f = activationFixture(); render(f.element());
  await screen.findByRole('table', { name: 'Conteo efectivo' });
  const trigger = screen.getByRole('button', { name: 'Gestiones' }); fireEvent.click(trigger);
  expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([
    'Corregir conteo', 'Restituciones de origen', 'Regularizar despacho',
  ]);
  const menu = screen.getByRole('menu');
  expect(screen.getByRole('menuitem', { name: 'Corregir conteo' })).toHaveFocus();
  fireEvent.keyDown(menu, { key: 'End' });
  expect(screen.getByRole('menuitem', { name: 'Regularizar despacho' })).toHaveFocus();
  fireEvent.keyDown(menu, { key: 'ArrowDown' });
  expect(screen.getByRole('menuitem', { name: 'Corregir conteo' })).toHaveFocus();
  fireEvent.keyDown(menu, { key: 'ArrowUp' });
  expect(screen.getByRole('menuitem', { name: 'Regularizar despacho' })).toHaveFocus();
  fireEvent.keyDown(menu, { key: 'Home' });
  expect(screen.getByRole('menuitem', { name: 'Corregir conteo' })).toHaveFocus();
  fireEvent.keyDown(menu, { key: 'Escape' }); expect(trigger).toHaveFocus();
  fireEvent.click(trigger); fireEvent.click(screen.getByRole('menuitem', { name: 'Regularizar despacho' }));
  expect(screen.getByRole('heading', { name: 'Regularización de despacho' })).toHaveFocus();
  expect(screen.queryByRole('button', { name: 'Gestiones · Regularizar despacho' })).toBeNull();
  expect(f.posts()).toHaveLength(0);
});
it('activation integration preserves original receipt, count and restitution entry behavior as GET-only contexts', async () => {
  const f = activationFixture(); render(f.element());
  await screen.findByRole('table', { name: 'Conteo efectivo' });
  const original = screen.getByRole('region', { name: 'Recepción original', hidden: true }).outerHTML;
  for (const [entry, heading] of [['Corregir conteo', 'Correcciones de conteo'], ['Restituciones de origen', 'Restituciones de origen']]) {
    fireEvent.click(screen.getByRole('button', { name: 'Gestiones' }));
    fireEvent.click(screen.getByRole('menuitem', { name: entry }));
    expect(screen.getByRole('heading', { name: heading })).toHaveFocus();
    expect(screen.getByRole('region', { name: 'Recepción original', hidden: true }).outerHTML).toBe(original);
  }
  expect(f.posts()).toHaveLength(0); expect(f.confirmed).not.toHaveBeenCalled();
});
it.each(['propose', 'accept', 'reject'] as const)('activation integration routes explicit %s from Pending through the owned typed transport', async action => {
  const f = activationFixture(action !== 'propose', action === 'propose' ? 1 : 2);
  render(f.element()); await activationOpen(); activationReview(action);
  expect(f.posts()).toHaveLength(0);
  const dialog = screen.getByRole('dialog');
  expect(dialog).toHaveTextContent(action === 'reject' ? 'Sin cambios en el conteo ni en el stock.' : '−2');
  if (action !== 'reject') expect(dialog).toHaveTextContent('+2');
  fireEvent.click(within(dialog).getByRole('button', { name: action === 'propose' ? 'Enviar propuesta'
    : action === 'accept' ? 'Confirmar aceptación' : 'Confirmar rechazo' }));
  await waitFor(() => expect(f.confirmed).toHaveBeenCalledTimes(1));
  expect(f.posts()).toHaveLength(1);
  const [url, init] = f.posts()[0];
  expect(url).toBe(`/api/transfers/123/dispatch-reconciliations/${action}`);
  expect(new Headers(init?.headers).get('X-CSRF-Token')).toBe('a'.repeat(43));
  expect(init?.credentials).toBe('same-origin');
  expect(JSON.parse(String(init?.body))).toEqual({ variant_id: 1, operation_key: expect.any(String),
    expected_revision: action === 'propose' ? '0' : '1', reason: 'Verified activation evidence',
    ...(action === 'propose' ? { dispatch_quantity: '7' } : {}) });
});
it('activation integration hides routine content across contexts but retains an active dialog and restores eligible focus', async () => {
  const f = activationFixture(); render(f.element()); await activationOpen();
  const section = screen.getByRole('region', { name: 'Regularización de despacho' });
  fireEvent.click(screen.getByRole('button', { name: 'Gestiones' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Corregir conteo' }));
  expect(screen.queryByRole('table', { name: 'Comparación de despacho' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Gestiones' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Regularizar despacho' }));
  expect(screen.getByRole('region', { name: 'Regularización de despacho' })).toBe(section);
  const opener = screen.getAllByRole('button', { name: 'Proponer regularización' })[0];
  opener.focus(); fireEvent.click(opener);
  const dialog = screen.getByRole('dialog');
  expect(dialog.closest('[hidden], [inert]')).toBeNull();
  fireEvent.keyDown(dialog, { key: 'Escape' }); expect(opener).toHaveFocus();
  expect(opener.closest('[hidden], [inert]')).toBeNull(); expect(f.posts()).toHaveLength(0);
});
it('activation integration keeps unknown exact retry accessible after context switch and remount without automatic writes', async () => {
  const f = activationFixture(); let view = render(f.element()); await activationOpen();
  f.loseResponse(); activationReview('propose');
  fireEvent.click(screen.getByRole('button', { name: 'Enviar propuesta' }));
  await screen.findByRole('heading', { name: /Resultado incierto/ });
  const first = f.posts()[0]; expect(f.posts()).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Gestiones' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Corregir conteo' }));
  expect(screen.getByRole('button', { name: 'Reintentar carga exacta' })).toBeVisible();
  view.unmount(); view = render(f.element());
  await screen.findByRole('button', { name: 'Reintentar carga exacta' });
  expect(f.posts()).toHaveLength(1); expect(f.confirmed).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Reintentar carga exacta' }));
  await waitFor(() => expect(f.posts()).toHaveLength(2));
  expect(f.posts()[1][0]).toBe(first[0]); expect(f.posts()[1][1]?.body).toBe(first[1]?.body);
});
it('activation integration restores visible owned focus after uncertain proposal consultation and exact retry settlement refetch', async () => {
  const f = activationFixture();
  const settlement = deferred<Response>();
  const refreshed = deferred<Response>();
  const reply = (value: unknown) => new Response(wire(value), { headers: { 'Content-Type': 'application/json' } });
  let postCount = 0; let settled = false;
  const transport = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    if (init.method === 'POST') {
      postCount++;
      if (postCount === 1) throw new Error('synthetic lost proposal response');
      return settlement.promise;
    }
    if (String(input).endsWith('/dispatch-reconciliations') && settled) return refreshed.promise;
    return f.fetch(input, init);
  });
  vi.stubGlobal('fetch', transport);
  const posts = () => transport.mock.calls.filter(([, init]) => init?.method === 'POST');
  const reads = () => transport.mock.calls.filter(([url]) => String(url).endsWith('/dispatch-reconciliations'));
  const view = render(f.element()); await activationOpen();
  const opener = screen.getAllByRole('button', { name: 'Proponer regularización' })[0]; opener.focus();
  activationReview('propose');
  expect(posts()).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Enviar propuesta' }));
  await screen.findByRole('heading', { name: /Resultado incierto/ });
  expect(posts()).toHaveLength(1); expect(f.confirmed).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Proponer regularización' })).toBeNull();
  const readsBefore = reads().length;
  fireEvent.click(screen.getByRole('button', { name: 'Consultar resultado' }));
  await waitFor(() => expect(reads()).toHaveLength(readsBefore + 1));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Reintentar carga exacta' })).toBeEnabled());
  expect(screen.getByRole('heading', { name: /Resultado incierto/ })).toBeVisible();
  expect(posts()).toHaveLength(1); expect(f.confirmed).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Reintentar carga exacta' }));
  await waitFor(() => expect(posts()).toHaveLength(2));
  const [url, init] = posts()[0];
  expect(posts()[1][0]).toBe(url); expect(posts()[1][1]?.body).toBe(init?.body);
  expect(url).toBe('/api/transfers/123/dispatch-reconciliations/propose');
  const payload = JSON.parse(String(init?.body));
  expect(payload).toEqual({ variant_id: 1, operation_key: expect.any(String), expected_revision: '0',
    dispatch_quantity: '7', reason: 'Verified activation evidence' });
  const pending = fixture(true);
  Object.assign(pending.raw.operations[0], { operation_key: payload.operation_key, reason: payload.reason });
  Object.assign(pending.raw.lines[0].proposals[0], { operation_key: payload.operation_key, reason: payload.reason });
  settled = true;
  await act(async () => { settlement.resolve(reply(pending.raw.operations[0])); });
  await waitFor(() => expect(f.confirmed).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(reads()).toHaveLength(readsBefore + 2));
  // Hold the real hook's post-settlement GET so the empty snapshot is observable.
  expect(screen.queryByRole('table', { name: 'Comparación de despacho' })).toBeNull();
  expect(posts()).toHaveLength(2);
  await act(async () => { refreshed.resolve(reply(pending.raw)); });
  await screen.findByRole('table', { name: 'Comparación de despacho' });
  expect(screen.getByText('Esperando revisión de Branch')).toBeVisible();
  await waitFor(() => {
    const target = document.activeElement;
    const heading = screen.getByRole('heading', { name: 'Regularización de despacho' });
    expect(target === heading || (document.contains(opener) && target === opener)).toBe(true);
    expect(target).toBeVisible();
    expect((target as HTMLElement).closest('[hidden], [inert]')).toBeNull();
    expect(target).not.toBe(document.body);
  });
  expect(posts()).toHaveLength(2); expect(f.confirmed).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('button', { name: 'Reintentar carga exacta' })).toBeNull();
  // The restored target and recovery evidence must not outlive their owner.
  f.authority.ready = false; view.rerender(f.element());
  await waitFor(() => expect(screen.queryByRole('table', { name: 'Comparación de despacho' })).toBeNull());
  expect(screen.queryByText('Motivo capturado: Verified activation evidence')).toBeNull();
  expect(posts()).toHaveLength(2); expect(f.confirmed).toHaveBeenCalledTimes(1);
});
it('activation integration confirmation refetches current inventory and restores focus after the decision opener disappears', async () => {
  const f = activationFixture(true, 2);
  const reply = (value: unknown) => new Response(wire(value), { headers: { 'Content-Type': 'application/json' } });
  const confirmed = vi.fn(); let accepted = false;
  // Prevent real SSE connections without replacing the inventory controller.
  vi.stubGlobal('EventSource', class extends EventTarget { readyState = 1; close() {} });
  const transport = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (url === '/api/auth/session') return reply(f.authority.session);
    if (url === '/api/inventory/metadata') return reply({ locations: [
      { id: 1, name: 'Warehouse' }, { id: 2, name: 'Branch' }, { id: 3, name: 'Other branch' },
    ], brands: ['Brand'] });
    if (url.startsWith('/api/inventory?')) return reply({ location: { id: 2, name: 'Branch' },
      page: 1, page_size: 10, total_variants: 1, items: [{ variant_id: 1, catalog_entry_id: 1,
        brand: 'Brand', model: 'Model', capacity_ah: 60, polarity: 'L',
        existing: accepted ? 97 : 41, reserved: 0, available: accepted ? 97 : 41 }] });
    const result = await f.fetch(input, init);
    if (init.method === 'POST') {
      accepted = true;
      const applied = JSON.parse(wire(appliedSnapshot()));
      const payload = JSON.parse(String(init.body));
      applied.operations[1].operation_key = payload.operation_key;
      applied.operations[1].reason = payload.reason;
      applied.lines[0].proposals[0].decision.operation_key = payload.operation_key;
      applied.lines[0].proposals[0].decision.reason = payload.reason;
      applied.lines[0].proposals[0].application.operation_key = payload.operation_key;
      Object.assign(f.raw, applied);
    }
    return result;
  });
  vi.stubGlobal('fetch', transport);
  function InventoryPane() {
    const inventory = useInventory();
    const ownerTag = transferViewOwner(inventory.getTransferAuthority());
    return <><output aria-label="Existencias actuales">{inventory.data?.items[0]?.existing.toString() ?? 'Consultando'}</output>
      {ownerTag && <TransferPending controller={{ ...inventory, confirmTransferDispatchReconciliation: (owner, operation) => {
        confirmed(owner, operation); inventory.confirmTransferDispatchReconciliation(owner, operation);
      } }} ownerTag={ownerTag} routedDetail="123" onInventory={vi.fn()} />}</>;
  }
  render(<InventoryPane />);
  await waitFor(() => expect(screen.getByLabelText('Existencias actuales')).toHaveTextContent(/^41$/));
  await activationOpen();
  const original = screen.getByRole('region', { name: 'Recepción original', hidden: true }).outerHTML;
  const countersBefore = f.fetch.mock.calls.filter(([url]) => url === '/api/transfers/counts').length;
  const readsBefore = transport.mock.calls.filter(([url]) => String(url).startsWith('/api/inventory?')).length;
  const opener = screen.getByRole('button', { name: 'Consultar propuesta' }); opener.focus();
  activationReview('accept');
  expect(f.posts()).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar aceptación' }));
  await waitFor(() => expect(screen.getByLabelText('Existencias actuales')).toHaveTextContent(/^97$/));
  await waitFor(() => expect(document.contains(opener)).toBe(false));
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Regularización de despacho' })).toHaveFocus());
  const fallback = document.activeElement as HTMLElement;
  expect(fallback).toBeVisible(); expect(fallback).toHaveAttribute('tabindex', '-1');
  expect(fallback.closest('[hidden], [inert]')).toBeNull(); expect(fallback).not.toBe(document.body);
  expect(confirmed).toHaveBeenCalledTimes(1); expect(f.posts()).toHaveLength(1);
  expect(confirmed.mock.calls[0][1].destination_existing_after).toBe(17n);
  expect(screen.getByLabelText('Existencias actuales')).not.toHaveTextContent(/^(13|17)$/);
  expect(transport.mock.calls.filter(([url]) => String(url).startsWith('/api/inventory?'))).toHaveLength(readsBefore + 1);
  expect(f.fetch.mock.calls.filter(([url]) => url === '/api/transfers/counts')).toHaveLength(countersBefore + 1);
  expect(screen.getByRole('region', { name: 'Recepción original', hidden: true }).outerHTML).toBe(original);
});

it('activation integration controlled scope switch preserves an owned dialog and safe close focus outside hidden routine content', async () => {
  // Controlled presentation scope proof, not an inert-menu click or Pending routing proof.
  const f = activationFixture();
  function Controlled({ contextVisible }: { contextVisible: boolean }) {
    const reconciliations = useTransferDispatchReconciliations({ controller: f.controller, record: f.record });
    const context = { contextVisible, entryFocusKey: 1 };
    return <TransferDispatchReconciliations {...context} record={f.record} actorLocation={1} reconciliations={reconciliations} />;
  }
  const view = render(<Controlled contextVisible />);
  await screen.findByRole('table', { name: 'Comparación de despacho' });
  const opener = screen.getAllByRole('button', { name: 'Proponer regularización' })[0]; opener.focus();
  fireEvent.click(opener);
  fireEvent.change(screen.getByLabelText('Motivo y confirmación de lo ocurrido'), { target: { value: 'Owned context draft' } });
  const dialog = screen.getByRole('dialog');
  view.rerender(<Controlled contextVisible={false} />);
  expect(screen.getByRole('dialog')).toBe(dialog); expect(dialog).toBeVisible();
  expect(dialog.closest('[hidden], [inert]')).toBeNull();
  expect(screen.getByLabelText('Motivo y confirmación de lo ocurrido')).toHaveValue('Owned context draft');
  expect(screen.queryByRole('table', { name: 'Comparación de despacho' })).toBeNull();
  fireEvent.keyDown(dialog, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  const fallback = screen.getByRole('heading', { name: 'Regularización de despacho' });
  expect(fallback).toBeVisible(); expect(fallback).toHaveFocus(); expect(fallback).toHaveAttribute('tabindex', '-1');
  expect(fallback.closest('[hidden], [inert]')).toBeNull(); expect(document.activeElement).not.toBe(document.body);
  expect(f.posts()).toHaveLength(0); expect(f.confirmed).not.toHaveBeenCalled();
});
it.each(['selection', 'owner', 'physical'] as const)('activation integration retires private dialog and context on %s changes', async mode => {
  const f = activationFixture(); const view = render(f.element()); await activationOpen();
  fireEvent.click(screen.getAllByRole('button', { name: 'Proponer regularización' })[0]);
  fireEvent.change(screen.getByLabelText('Motivo y confirmación de lo ocurrido'), { target: { value: 'Private retired draft' } });
  if (mode === 'owner') { f.authority.ready = false; view.rerender(f.element()); }
  else if (mode === 'physical') {
    Object.assign(f.record, { destination_location_id: 3, destination_location_name: 'Other branch', receipt_location_id: 3 });
    act(() => { for (const listener of f.listeners) listener(); });
  } else view.rerender(f.element(null));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(screen.queryByDisplayValue('Private retired draft')).toBeNull();
  expect(screen.queryByRole('table', { name: 'Comparación de despacho' })).toBeNull();
  expect(f.posts()).toHaveLength(0); expect(f.confirmed).not.toHaveBeenCalled();
});
