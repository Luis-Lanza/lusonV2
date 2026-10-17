import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import TransferRestitutions from './TransferRestitutions';
import { parseTransferRecord } from './transferModel';
import { createTransferRestitutionRecovery } from './transferRestitutionRecovery';
import type { TransferAuthority, TransferController } from './useInventory';
const id = '9007199254740993'; const stamp = '2026-04-02T00:00:00Z';
function fixture(actor = 1, proposed = false, dispatched = '5', multiple = false) {
  const authority: TransferAuthority = { epoch: 1, ready: true, sessionGeneration: 1, session: { authenticated: true,
    csrf_token: 'c'.repeat(43), identity: { account_id: actor, username: 'participant', location: { id: actor, name: 'Location' } }, expires_at: '2030-01-01T00:00:00Z' } };
  let record = parseTransferRecord(JSON.stringify({ id, reference: `TR-${id}`, kind: 'direct_shipment', status: 'received',
    created_at: stamp, creator_location_id: 1, creator_location_name: 'Origin', origin_location_id: 1, origin_location_name: 'Origin',
    destination_location_id: 2, destination_location_name: 'Destination', approver_location_id: 1, approver_location_name: 'Origin',
    decision_location_id: 1, decided_at: stamp, dispatch_location_id: 1, dispatched_at: stamp, receipt_location_id: 2, received_at: stamp,
    items: [{ variant_id: 201, brand: 'B', model: 'M', capacity_ah: '60', polarity: 'L', quantity: dispatched }],
    receipt: { items: [{ variant_id: 201, expected_quantity: dispatched, actual_quantity: '4', available_quantity: '4' }],
      exceptions: [{ variant_id: 201, kind: 'shortage', quantity: (BigInt(dispatched) - 4n).toString() }] } }));
  if (multiple && record.status === 'received') record = parseTransferRecord(JSON.stringify({ ...record,
    items: [...record.items, { ...record.items[0], variant_id: 202, model: 'Other' }],
    receipt: { items: [...record.receipt.items, { ...record.receipt.items[0], variant_id: 202 }],
      exceptions: [...record.receipt.exceptions, { ...record.receipt.exceptions[0], variant_id: 202 }] } },
    (_key, value) => typeof value === 'bigint' ? value.toString() : value));
  const listeners = new Set<() => void>();
  const controller: TransferController = { authorityEpoch: 1, getTransferAuthority: () => authority,
    subscribeTransferInvalidation: l => { listeners.add(l); return () => { listeners.delete(l); }; },
    settleUnauthorized: vi.fn(async () => 'unavailable' as const), restitutionRecovery: createTransferRestitutionRecovery(), confirmTransferRestitution: vi.fn() };
  const proposal = { revision: '1', operation_key: 'retained_proposal_01', initiator_location_id: 1, retained_quantity: '1', retained_at_origin: true,
    base_revision: '0', count_generation: '0', count_applied_revision: '0', base_credit: '4', base_restitution: '0', reason: ' origin evidence ', recorded_at: stamp,
    state: 'pending', decision: null, application: null };
  const history = { request_id: id, operations: proposed ? [{ request_id: id, variant_id: 201, operation_key: proposal.operation_key, actor_location_id: 1,
    action: 'propose', expected_revision: '0', retained_quantity: '1', retained_at_origin: true, reason: proposal.reason, revision: '1',
    source_existing_before: null, source_existing_after: null, recorded_at: stamp }] : [], lines: [{ variant_id: 201, expected_quantity: dispatched, original_credit: '4',
    workflow_revision: proposed ? '1' : '0', applied_revision: '0', count_generation: '0', count_applied_revision: '0', effective_credit: '4', applied_retained_quantity: '0', proposals: proposed ? [proposal] : [] }] };
  if (multiple) history.lines.push({ ...history.lines[0], variant_id: 202, proposals: [] });
  let fail = false; let mask = false;
  const fetch = vi.fn(async (url: RequestInfo | URL, init: RequestInit = {}) => {
    if (mask) return new Response(JSON.stringify({ error: 'PRIVATE' }), { status: 403 });
    if (init.method === 'POST') {
      if (fail) throw new Error('PRIVATE lost reply');
      const p = JSON.parse(String(init.body)); const action = String(url).split('/').at(-1);
      return new Response(JSON.stringify({ ...p, request_id: id, actor_location_id: actor, action, revision: '1', recorded_at: stamp,
        retained_quantity: action === 'propose' ? p.retained_quantity : null, retained_at_origin: action === 'propose' ? true : null,
        source_existing_before: action === 'accept' ? '10' : null, source_existing_after: action === 'accept' ? '11' : null }), { headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify(String(url).endsWith('/restitutions') ? history : { request_id: id, operations: [], lines: history.lines.map(l => ({ variant_id: l.variant_id,
      expected_quantity: dispatched, actual_quantity: '4', available_quantity: '4', workflow_revision: '0', applied_revision: '0', effective_actual: '4', effective_credit: '4', proposals: [] })) }), { headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetch);
  const element = (enabled = true, requestID: string | null = id) => <TransferRestitutions controller={controller} record={record} enabled={enabled} requestID={requestID} />;
  const posts = () => fetch.mock.calls.filter(([, init]) => init?.method === 'POST');
  return { authority, record, controller, history, listeners, element, fetch, posts, fail: () => { fail = true; }, mask: () => { mask = true; } };
}
function appliedFixture(dispatched = '5') {
  const f = fixture(2, true, dispatched); const line = f.history.lines[0];
  line.applied_revision = '1'; line.applied_retained_quantity = '1'; const p = line.proposals[0]; p.state = 'applied';
  const decision = { operation_key: 'retained_accept_01', actor_location_id: 2, accepted: true, reason: ' exact acceptance ', recorded_at: stamp };
  Object.assign(p, { decision, application: { operation_key: decision.operation_key, origin_location_id: 1, quantity: '1', recorded_at: stamp } });
  f.history.operations.push({ ...f.history.operations[0], operation_key: decision.operation_key, actor_location_id: 2, action: 'accept',
    expected_revision: '1', retained_quantity: null, retained_at_origin: null, reason: decision.reason, source_existing_before: '10', source_existing_after: '11' } as unknown as typeof f.history.operations[number]);
  return f;
}
it.each([1, 2].flatMap(actor => ['restitutions', 'count-corrections'].flatMap(stream =>
  ['failed', 'missing', 'mismatched'].map(evidence => ({ actor, stream, evidence })))))(
  'keeps collapsed $stream $evidence consultation usable for actor $actor', async ({ actor, stream, evidence }) => {
    const f = fixture(actor); const read = f.fetch.getMockImplementation()!;
    let unavailable = true;
    f.fetch.mockImplementation(async (url, init = {}) => {
      if (unavailable && String(url).endsWith(`/${stream}`)) {
        if (evidence === 'failed') return new Response(JSON.stringify({ error: 'service_unavailable' }), { status: 503 });
        const response = await read(url, init); const history = await response.json();
        return new Response(JSON.stringify({ ...history,
          ...(evidence === 'missing' ? { lines: [] } : { request_id: '2' }) }));
      }
      return read(url, init);
    });
    const view = render(<TransferRestitutions controller={f.controller} record={f.record}
      requestID={id} enabled contextVisible={false} />);
    await screen.findByRole('alert');
    const button = screen.getByRole('button', { name: 'Consultar para revisar restitución' });
    expect(button).toBeVisible(); expect(button).toBeEnabled();
    button.focus(); expect(button).toHaveFocus();
    for (const name of ['Proponer restitución', 'Aceptar restitución', 'Rechazar restitución']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
    const before = f.fetch.mock.calls.length; unavailable = false;
    await act(async () => { fireEvent.click(button); });
    await waitFor(() => expect(screen.queryByText('Evidencia de restitución no disponible.')).not.toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(f.fetch).toHaveBeenCalledTimes(before + 2); expect(f.posts()).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Consultar para revisar restitución' })).not.toBeInTheDocument();
    for (const name of ['Proponer restitución', 'Aceptar restitución', 'Rechazar restitución']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
    view.unmount();
});

it('keeps collapsed consultation visible but disabled while evidence is loading', async () => {
  const f = fixture(); const read = f.fetch.getMockImplementation()!;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  f.fetch.mockImplementation(async (url, init) => { await pending; return read(url, init); });
  render(<TransferRestitutions controller={f.controller} record={f.record} requestID={id} enabled contextVisible={false} />);
  const button = screen.getByRole('button', { name: 'Consultar para revisar restitución' });
  expect(button).toBeVisible(); expect(button).toBeDisabled();
  expect(screen.getByLabelText('Variante de restitución')).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Proponer restitución' })).not.toBeInTheDocument();
  await act(async () => { release(); });
  expect(screen.queryByRole('button', { name: 'Consultar para revisar restitución' })).not.toBeInTheDocument();
});

it('keeps consultation mounted and a captured review pinned when its routine context collapses', async () => {
  const f = fixture(); const read = f.fetch.getMockImplementation()!;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  f.fetch.mockImplementation(async (url, init) => { await pending; return read(url, init); });
  const element = (visible: boolean, token?: number) => <TransferRestitutions controller={f.controller}
    record={f.record} requestID={id} enabled contextVisible={visible} entryFocusKey={token} />;
  const view = render(element(false));
  await waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(2));
  // Starting both reads does not mean their evidence has settled.
  expect(screen.getByRole('button', { name: 'Consultar para revisar restitución' })).toBeDisabled();
  await act(async () => { release(); });
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Consultar para revisar restitución' })).not.toBeInTheDocument());
  view.rerender(element(true, 1));
  expect(screen.getByRole('heading', { name: 'Restituciones de origen' })).toHaveFocus();
  await screen.findByText('Crédito efectivo en destino'); await consult();
  fireEvent.click(screen.getByRole('button', { name: 'Proponer restitución' }));
  fireEvent.change(screen.getByLabelText('Cantidad retenida'), { target: { value: '1' } });
  fireEvent.change(screen.getByLabelText('Motivo de restitución'), { target: { value: 'Pinned private reason' } });
  view.rerender(element(false, 1));
  expect(screen.getByLabelText('Motivo de restitución')).toHaveValue('Pinned private reason');
  fireEvent.click(screen.getByLabelText('Confirmo que estas unidades permanecen físicamente en origen'));
  fireEvent.click(screen.getByRole('button', { name: 'Revisar restitución' }));
  const modal = screen.getByRole('dialog'); const reads = f.fetch.mock.calls.length;
  view.rerender(element(false, 1));
  expect(screen.getByRole('dialog')).toBe(modal); expect(modal).toHaveTextContent('Pinned private reason');
  expect(f.fetch).toHaveBeenCalledTimes(reads); expect(f.posts()).toHaveLength(0);
});
it('keeps masked recovery visible while routine restitution context is collapsed', async () => {
  const f = fixture(); f.mask();
  render(<TransferRestitutions controller={f.controller} record={f.record} requestID={id} enabled contextVisible={false} />);
  expect(await screen.findByRole('button', { name: 'Consultar recuperación autorizada' })).toBeVisible();
  expect(screen.getByRole('status')).toHaveTextContent('Restituciones no disponibles');
  expect(screen.getByRole('heading')).not.toHaveFocus();
});

it.each(['0', '01', '-1', '1.5', '2', '9223372036854775808'])('does not review invalid or excessive retained quantity %s', async quantity => {
  const f = fixture(); render(f.element()); await screen.findByText('Crédito efectivo en destino'); await consult(); draft();
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  fireEvent.click(screen.getByRole('button', { name: 'Proponer restitución' }));
  fireEvent.change(screen.getByLabelText('Cantidad retenida'), { target: { value: quantity } });
  fireEvent.change(screen.getByLabelText('Motivo de restitución'), { target: { value: 'reason' } });
  fireEvent.click(screen.getByLabelText('Confirmo que estas unidades permanecen físicamente en origen'));
  fireEvent.click(screen.getByRole('button', { name: 'Revisar restitución' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(f.posts()).toHaveLength(0);
});
it('does not grant decision authority to another account assigned to destination', async () => {
  const f = fixture(2, true); if (!f.authority.session?.authenticated) throw new Error('fixture');
  f.authority.session.identity.account_id = 77;
  render(f.element()); await screen.findByText('Crédito efectivo en destino');
  fireEvent.click(screen.getByRole('button', { name: 'Consultar para revisar restitución' })); await act(async () => {});
  expect(screen.queryByRole('button', { name: 'Aceptar restitución' })).not.toBeInTheDocument(); expect(f.posts()).toHaveLength(0);
});
it('retires private form and hook reads on authority change', async () => {
  const f = fixture(); const view = render(f.element()); await screen.findByText('Crédito efectivo en destino');
  expect(screen.getByRole('button', { name: 'Proponer restitución' })).toBeDisabled();
  // Settle the explicit consultation, including its async event guard, before opening a draft.
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Consultar para revisar restitución' })); });
  expect(screen.getByRole('button', { name: 'Proponer restitución' })).toBeEnabled(); draft();
  expect(screen.getByRole('dialog', { name: 'Revisar restitución' })).toBeVisible();
  const before = f.fetch.mock.calls.length; f.authority.ready = false; view.rerender(f.element());
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(screen.queryByRole('form', { name: 'Editar restitución' })).not.toBeInTheDocument();
  expect(screen.queryByRole('region')).not.toBeInTheDocument();
  await act(async () => {}); expect(f.fetch.mock.calls).toHaveLength(before); expect(f.posts()).toHaveLength(0);
});
it('keeps separate immutable proposal, decision and partial application evidence and closes policy', async () => {
  const f = fixture(2, true, '6'); const line = f.history.lines[0];
  line.expected_quantity = '6'; line.applied_revision = '1'; line.applied_retained_quantity = '1';
  const p = line.proposals[0]; p.state = 'applied';
  const decision = { operation_key: 'retained_accept_01', actor_location_id: 2, accepted: true, reason: ' exact acceptance ', recorded_at: stamp };
  Object.assign(p, { decision, application: { operation_key: decision.operation_key, origin_location_id: 1, quantity: '1', recorded_at: stamp } });
  f.history.operations.push({ ...f.history.operations[0], operation_key: decision.operation_key, actor_location_id: 2, action: 'accept',
    expected_revision: '1', retained_quantity: null, retained_at_origin: null, reason: decision.reason, source_existing_before: '10', source_existing_after: '11' } as unknown as typeof f.history.operations[number]);
  render(f.element()); await screen.findByText('Crédito efectivo en destino');
  expect(screen.getByRole('region', { name: 'Propuesta 1' })).toHaveTextContent('origin evidence');
  expect(screen.getByRole('region', { name: 'Decisión 1' })).toHaveTextContent('exact acceptance');
  expect(screen.getByRole('region', { name: 'Aplicación 1' })).toHaveTextContent('10 → 11');
  for (const name of ['Propuesta 1', 'Decisión 1', 'Aplicación 1']) {
    const time = screen.getByRole('region', { name }).querySelector('time');
    expect(time?.textContent).toBe('01/04/2026 · 20:00 (hora Bolivia)');
    expect(time).toHaveAttribute('datetime', stamp);
    expect(time).toHaveAttribute('title', stamp);
  }
  expect(screen.getByText('Restitución cerrada')).toBeVisible();
  expect(screen.getByText('Una aplicación, incluso parcial, cierra esta restitución.')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Consultar para revisar restitución' })); await act(async () => {});
  expect(screen.getByRole('button', { name: 'Aceptar restitución' })).toBeDisabled(); expect(f.posts()).toHaveLength(0);
});
it('owns one selected variant, retires its review and requires another explicit consultation after selection', async () => {
  const f = fixture(1, false, '5', true); render(f.element()); await screen.findByText('Crédito efectivo en destino'); await consult(); draft();
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  fireEvent.change(screen.getByLabelText('Variante de restitución'), { target: { value: '202' } });
  await waitFor(() => expect(f.fetch.mock.calls.filter(([url]) => String(url).endsWith('/restitutions'))).toHaveLength(3));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Consultar para revisar restitución' })).toBeEnabled());
  expect(screen.getByRole('button', { name: 'Proponer restitución' })).toBeDisabled();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(f.posts()).toHaveLength(0);
  await consult(); draft(); fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirmar propuesta' }));
  await waitFor(() => expect(f.posts()).toHaveLength(1)); expect(JSON.parse(String(f.posts()[0][1]?.body)).variant_id).toBe(202);
});
it.each(['5', '6'])('presents applied origin outcome separately from destination credit and closes even partial dispatch %s', async dispatched => {
  const f = appliedFixture(dispatched);
  render(f.element()); await screen.findByText('Crédito efectivo en destino');
  const outcome = screen.getByRole('region', { name: 'Resultado de restitución de la variante seleccionada' });
  expect(outcome).toHaveTextContent('Restitución cerrada');
  expect(within(outcome).getByText('Crédito efectivo en destino').nextElementSibling).toHaveTextContent(/^4$/);
  expect(within(outcome).getByText('Restitución aplicada en origen').nextElementSibling).toHaveTextContent(/^1$/);
  expect(outcome).toHaveTextContent('Una aplicación, incluso parcial, cierra esta restitución.');
  expect(outcome.compareDocumentPosition(screen.getByLabelText('Variante de restitución')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.queryByText(/^La falta en destino no prueba retención/)).not.toBeInTheDocument();
  expect(screen.getByText(/El despacho y la recepción original son inmutables/)).toBeVisible();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Consultar para revisar restitución' })); });
  expect(screen.getByRole('button', { name: 'Aceptar restitución' })).toBeDisabled(); expect(f.posts()).toHaveLength(0);
});
it('keeps operational history visible while exact technical evidence is disclosed without reads or writes', async () => {
  const f = appliedFixture();
  render(f.element()); await screen.findByText('Crédito efectivo en destino');
  for (const name of ['Propuesta 1', 'Decisión 1', 'Aplicación 1']) {
    const region = screen.getByRole('region', { name });
    expect(region.querySelector('time')).toBeVisible(); expect(region.querySelector('h4')).toBeVisible();
  }
  expect(screen.getByText('Motivo: origin evidence', { exact: false })).toBeVisible();
  expect(screen.getByText('Motivo de decisión: exact acceptance', { exact: false })).toBeVisible();
  expect(screen.getByText(/Clave: retained_proposal_01/)).not.toBeVisible();
  expect(screen.getByText(/Existencias de origen registradas: 10 → 11/)).not.toBeVisible();
  expect(screen.getByText('Retenidas en origen: 1 · Retención física atestada explícitamente')).toBeVisible();
  expect(screen.getByText(/Existencias acreditadas: \+1/)).toBeVisible();
  const before = f.fetch.mock.calls.length;
  for (const summary of screen.getAllByText('Evidencia técnica', { selector: 'summary' })) {
    const details = summary.closest('details')!; expect(details).not.toHaveAttribute('open');
    fireEvent.click(summary); details.open = true; fireEvent(details, new Event('toggle'));
    expect(details).toHaveAttribute('open');
  }
  expect(screen.getByText(/Clave: retained_proposal_01/)).toBeVisible();
  for (const key of screen.getAllByText(/Clave: retained_accept_01/, { selector: 'p' })) expect(key).toBeVisible();
  expect(screen.getByText(/Existencias de origen registradas: 10 → 11/)).toBeVisible();
  expect(screen.getByText(/Revisión base: 0 · Crédito base: 4 · Restitución base: 0/)).toBeVisible();
  expect(screen.getByText(/Generación de conteo: 0 · Revisión de conteo aplicada: 0/)).toBeVisible();
  await act(async () => {}); expect(f.fetch.mock.calls).toHaveLength(before); expect(f.posts()).toHaveLength(0);
});
it('does not substitute zero for unavailable evidence and keeps pending safety warnings outside disclosures', async () => {
  const f = fixture(); const view = render(f.element());
  expect(screen.queryByRole('region', { name: 'Resultado de restitución de la variante seleccionada' })).not.toBeInTheDocument();
  await screen.findByText('Crédito efectivo en destino');
  const warning = screen.getByText(/^La falta en destino no prueba retención/);
  expect(warning).toBeVisible(); expect(warning.closest('details')).toBeNull();
  expect(screen.getByText(/Una aplicación, incluso parcial/)).toBeVisible();
  view.unmount(); expect(f.posts()).toHaveLength(0);
});
afterEach(() => vi.unstubAllGlobals());
async function consult() {
  // An enabled button reflects hook state, but run() still owns a synchronous
  // sending guard until its promise settles. Flush that event before drafting.
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Consultar para revisar restitución' })); });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Proponer restitución' })).toBeEnabled());
}
function draft() {
  fireEvent.click(screen.getByRole('button', { name: 'Proponer restitución' }));
  expect(screen.getByLabelText('Cantidad retenida')).toHaveValue('');
  expect(screen.getByLabelText('Confirmo que estas unidades permanecen físicamente en origen')).not.toBeChecked();
  fireEvent.change(screen.getByLabelText('Cantidad retenida'), { target: { value: '1' } });
  fireEvent.change(screen.getByLabelText('Motivo de restitución'), { target: { value: ' exact reason ' } });
  fireEvent.click(screen.getByLabelText('Confirmo que estas unidades permanecen físicamente en origen'));
  fireEvent.click(screen.getByRole('button', { name: 'Revisar restitución' }));
}
it('requires explicit consultation and unchecked physical attestation, reviews without posting, then sends exact proposal once', async () => {
  const f = fixture(); render(f.element());
  await screen.findByText('Crédito efectivo en destino');
  expect(screen.getByRole('button', { name: 'Proponer restitución' })).toBeDisabled();
  await consult(); draft();
  expect(f.posts()).toHaveLength(0);
  const dialog = screen.getByRole('dialog', { name: 'Revisar restitución' });
  expect(dialog).toHaveTextContent('No mueve stock');
  expect(dialog).toHaveTextContent('permanecen físicamente en origen');
  expect(dialog).toHaveTextContent('Una aplicación, incluso parcial, cierra esta restitución');
  expect(dialog).toHaveTextContent('El despacho y la recepción original son inmutables');
  const confirm = within(dialog).getByRole('button', { name: 'Confirmar propuesta' }); fireEvent.click(confirm); fireEvent.click(confirm);
  await waitFor(() => expect(f.posts()).toHaveLength(1));
  expect(JSON.parse(String(f.posts()[0][1]?.body))).toEqual({ variant_id: 201, operation_key: expect.stringMatching(/^[a-f0-9]{32}$/), expected_revision: '0', retained_quantity: '1', retained_at_origin: true, reason: ' exact reason ' });
  await waitFor(() => expect(f.controller.confirmTransferRestitution).toHaveBeenCalledOnce());
});
it.each(['accept', 'reject'])('destination reviews %s with required reason and no quantity or attestation in decision', async action => {
  const f = fixture(2, true); render(f.element()); await screen.findByText('Crédito efectivo en destino');
  const label = action === 'accept' ? 'Aceptar restitución' : 'Rechazar restitución';
  expect(screen.getByRole('button', { name: label })).toBeDisabled();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Consultar para revisar restitución' })); });
  await waitFor(() => expect(screen.getByRole('button', { name: label })).toBeEnabled()); fireEvent.click(screen.getByRole('button', { name: label }));
  expect(screen.queryByLabelText('Cantidad retenida')).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Motivo de restitución'), { target: { value: ' destination reason ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Revisar restitución' }));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: action === 'accept' ? 'Confirmar aceptación' : 'Confirmar rechazo' }));
  await waitFor(() => expect(f.controller.confirmTransferRestitution).toHaveBeenCalledOnce());
  expect(Object.keys(JSON.parse(String(f.posts()[0][1]?.body))).sort()).toEqual(['expected_revision', 'operation_key', 'reason', 'variant_id']);
});
it('retires a review on invalidation and restores focus on Escape without sending', async () => {
  const f = fixture(); render(f.element()); await screen.findByText('Crédito efectivo en destino'); await consult(); draft();
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' }); expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Proponer restitución' })).toHaveFocus(); draft();
  act(() => { for (const l of f.listeners) l(); }); await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument()); expect(f.posts()).toHaveLength(0);
});
it('closes review when controller-owned count evidence is retired without replacing the visible history', async () => {
  const f = fixture(); render(f.element()); await screen.findByText('Crédito efectivo en destino'); await consult(); draft();
  act(() => { f.controller.restitutionRecovery!.invalidate({ account: 1, location: 1, epoch: 1, generation: 1 }, BigInt(id), 'count'); });
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(screen.queryByRole('form', { name: 'Editar restitución' })).not.toBeInTheDocument(); expect(f.posts()).toHaveLength(0);
});
it('preserves controller-owned uncertainty across remount and retries only captured payload', async () => {
  const f = fixture(); f.fail(); const view = render(f.element()); await screen.findByText('Crédito efectivo en destino'); await consult(); draft();
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirmar propuesta' }));
  await screen.findByRole('button', { name: 'Reintentar carga exacta' }); const body = f.posts()[0][1]?.body;
  view.unmount();
  render(<TransferRestitutions controller={f.controller} record={f.record} requestID={id} enabled contextVisible={false} />);
  await screen.findByRole('button', { name: 'Reintentar carga exacta' }); expect(f.posts()).toHaveLength(1);
  const warning = screen.getByText('Resultado incierto. No crees otra operación para esta variante.');
  expect(warning).toBeVisible(); expect(warning.closest('details')).toBeNull();
  expect(screen.getByRole('button', { name: 'Consultar resultado de restitución' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Reintentar carga exacta' })); await waitFor(() => expect(f.posts()).toHaveLength(2)); expect(f.posts()[1][1]?.body).toBe(body); expect(document.body).not.toHaveTextContent('PRIVATE');
});
it.each([false, true])('does not read for disabled or mismatched selection (%s)', async enabled => {
  const f = fixture(); render(f.element(enabled, enabled ? '2' : id)); await act(async () => {}); expect(f.fetch).not.toHaveBeenCalled();
});
it('masks private history and form through hook without echoing error data', async () => {
  const f = fixture(); render(f.element()); await screen.findByText('Crédito efectivo en destino'); await consult(); draft(); f.mask();
  act(() => { for (const l of f.listeners) l(); }); await screen.findByText('Restituciones no disponibles para esta sesión.');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(document.body).not.toHaveTextContent('PRIVATE'); expect(f.posts()).toHaveLength(0);
});
