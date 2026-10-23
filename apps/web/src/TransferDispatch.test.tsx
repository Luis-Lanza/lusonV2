import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TransferPending, { transferViewOwner } from './TransferPending';
import { createTransferDispatchRecovery } from './transferDispatchRecovery';
import { createTransferDecisionRecovery, decisionOwner } from './transferDecisionRecovery';
import { parseTransferRecord } from './transferModel';
import type { TransferAuthority } from './useInventory';
import type { DetailController } from './TransferDetail';

const names = ['Almacén', 'Sucursal A', 'Sucursal B'];
const dispatchCompletion = {
  in_transit: 'Despacho registrado correctamente. La solicitud está En tránsito; la recepción en destino sigue pendiente y todavía no se acreditó stock.',
  received: 'Despacho confirmado. La solicitud ya fue recibida en destino; la recepción está finalizada.',
};
function expectNoDispatchCompletion(dialog: HTMLElement) {
  for (const message of Object.values(dispatchCompletion)) expect(within(dialog).queryByText(message)).not.toBeInTheDocument();
}

function wire(origin = 1, destination = 2, status = 'approved', length = 2) {
  const approver = destination === 1 ? 1 : origin;
  const creator = destination === 1 ? origin : destination;
  return { id: '9007199254740993', reference: 'TR-9007199254740993', kind: destination === 1 ? 'send_to_warehouse' : 'request_stock', status,
    creator_location_id: creator, creator_location_name: names[creator - 1], origin_location_id: origin, origin_location_name: names[origin - 1],
    destination_location_id: destination, destination_location_name: names[destination - 1], approver_location_id: approver, approver_location_name: names[approver - 1],
    created_at: '2026-04-02T00:00:00Z', decision_location_id: approver, decided_at: '2026-04-03T00:00:00.000000001Z',
    ...(status === 'in_transit' ? { dispatch_location_id: origin, dispatched_at: '2026-04-03T00:00:00.000000002Z' } : {}),
    items: Array.from({ length }, (_, index) => ({ variant_id: index + 1, brand: 'TOYO', model: `Exact-${index + 1}`, capacity_ah: '75.125', polarity: index % 2 ? 'R' : 'L', quantity: '9223372036854775807' })) };
}
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>(yes => { resolve = yes; });
  return { promise, resolve };
}
function fixture(actor = 1, origin = 1, destination = 2, override?: (url: string, init: RequestInit) => Promise<Response> | undefined) {
  const authority: TransferAuthority = { epoch: 1, sessionGeneration: 1, ready: true, session: { authenticated: true, csrf_token: 'memory_csrf',
    identity: { account_id: actor, username: `test-${actor}`, location: { id: actor, name: names[actor - 1] } }, expires_at: '2030-01-01T00:00:00Z' } };
  const env = { record: wire(origin, destination), authority };
  const listeners = new Set<() => void>();
  const source = vi.fn();
  const controller: DetailController = { authorityEpoch: 1, getTransferAuthority: () => env.authority,
    subscribeTransferInvalidation: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    settleUnauthorized: vi.fn(async () => 'unavailable' as const),
    decisionRecovery: createTransferDecisionRecovery(), dispatchRecovery: createTransferDispatchRecovery(),
    confirmTransferDispatch: vi.fn(() => { for (const listener of listeners) listener(); source(); }) };
  const fetch = vi.fn((input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = String(input); const custom = override?.(url, init); if (custom) return custom;
    if (url === '/api/transfers/counts') return Promise.resolve(reply({ pending_total: '5', action_count: '2' }));
    if (url.startsWith('/api/transfers?')) {
      const query = new URL(url, 'http://localhost').searchParams;
      const status = query.get('status');
      const records = status === 'all' || status === env.record.status ? [env.record] : [];
      return Promise.resolve(reply({ page: 1, page_size: 25, status, total_count: records.length.toString(), records }));
    }
    if (url.endsWith('/dispatch')) { env.record = wire(origin, destination, 'in_transit', env.record.items.length); return Promise.resolve(reply(env.record)); }
    if (url === '/api/transfers/' + env.record.id) return Promise.resolve(reply(env.record));
    throw new Error('Unexpected route');
  });
  vi.stubGlobal('fetch', fetch);
  const ownerTag = transferViewOwner(authority)!;
  const element = () => <TransferPending controller={controller} ownerTag={ownerTag} onInventory={() => {}} initialDetail={{ ownerTag, id: env.record.id }} />;
  return { env, controller, fetch, source, element, listeners };
}
const posts = (f: ReturnType<typeof fixture>) => f.fetch.mock.calls.filter(([, init]) => init?.method === 'POST');
afterEach(() => vi.unstubAllGlobals());
describe('F5 approved participant detail and dispatch', () => {
  const routes = [['request_stock', 1, 3], ['request_stock', 2, 3],
    ['direct_shipment', 1, 3], ['send_to_warehouse', 2, 1]] as const;
  it.each(routes.flatMap(([kind, origin, destination]) => [origin, destination].map(actor => ({ kind, origin, destination, actor }))))(
    'shares approved hierarchy without changing actions for $kind at $actor', async ({ kind, origin, destination, actor }) => {
    const f = fixture(actor, origin, destination);
    f.env.record = { ...f.env.record, kind, ...(kind === 'direct_shipment' ? {
      creator_location_id: origin, creator_location_name: names[origin - 1], decided_at: f.env.record.created_at } : {}) };
    const start = vi.spyOn(f.controller.dispatchRecovery!, 'start');
    const view = render(f.element());
    await screen.findByRole('heading', { name: f.env.record.reference });
    expect(screen.getByRole('navigation')).toHaveClass('approved-origin-navigation');
    expect(screen.queryByRole('region', { name: 'Contadores de solicitudes' })).toBeNull();
    const productLabel = kind === 'direct_shipment' ? 'Productos a despachar' : kind === 'send_to_warehouse' ? 'Productos propuestos' : 'Productos solicitados';
    const products = screen.getByRole('region', { name: productLabel });
    expect(products).toHaveTextContent(`18446744073709551614 baterías están reservadas en ${names[origin - 1]}`);
    expect(within(products).getByRole('columnheader', { name: kind === 'direct_shipment' ? 'A despachar' : kind === 'send_to_warehouse' ? 'Propuestas' : 'Solicitadas' })).toBeVisible();
    const reservation = `Reservadas para ${kind === 'request_stock' ? 'esta solicitud' : kind === 'send_to_warehouse' ? 'esta propuesta' : 'este envío'}`;
    expect(within(products).getByRole('columnheader', { name: reservation })).toBeVisible();
    const allocations = products.querySelectorAll(`[data-label="${reservation}"]`);
    expect(allocations).toHaveLength(2);
    for (const allocation of allocations) expect(allocation).toHaveTextContent(/^9223372036854775807 uds\.$/);
    expect(within(products).queryByRole('columnheader', { name: /Disponibl/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Aprobar|Rechazar|Actualizar stock/ })).toBeNull();
    expect(screen.queryByRole('button', { name: kind === 'direct_shipment' ? 'Cancelar envío' : kind === 'send_to_warehouse' ? 'Cancelar propuesta' : 'Cancelar solicitud' }) !== null).toBe(actor === f.env.record.creator_location_id);
    expect(within(products).queryByRole('button', { name: /Despachar/ }) !== null).toBe(actor === origin);
    if (actor !== origin) expect(products).toHaveTextContent(`Pendiente de despacho desde ${names[origin - 1]}`);
    expect(document.querySelector('.transfer-approved-heading .pending-status')).toHaveTextContent(kind === 'direct_shipment' ? 'Pendiente de despacho' : 'Aprobada');
    fireEvent.click(screen.getByRole('button', { name: 'Ver historial' }));
    const history = screen.getByRole('region', { name: kind === 'direct_shipment' ? 'Historial del envío' : kind === 'send_to_warehouse' ? 'Historial de la propuesta' : 'Historial de la solicitud' });
    expect(history.querySelectorAll('time')).toHaveLength(kind === 'direct_shipment' ? 1 : 2);
    expect(history.querySelector('time')).toHaveAttribute('datetime', f.env.record.created_at);
    expect(history).toHaveTextContent(`Ubicación: ${f.env.record.creator_location_name}`);
    if (kind === 'direct_shipment') {
      expect(history).toHaveTextContent('Envío creado, autorizado y stock reservado');
      expect(history).not.toHaveTextContent(/aprobada|aprobación/);
    } else expect(history).toHaveTextContent(`Ubicación: ${f.env.record.approver_location_name}`);
    if (actor === origin) {
      const trigger = within(products).getByRole('button', { name: kind === 'request_stock' ? 'Despachar solicitud' : 'Despachar envío' });
      fireEvent.click(trigger);
      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveClass('transfer-dispatch-confirmation');
      expect(within(dialog).getByRole('table', { name: kind === 'request_stock' ? 'Solicitud completa a confirmar' : kind === 'send_to_warehouse' ? 'Propuesta completa a confirmar' : 'Envío completo a confirmar' })).toHaveTextContent('18446744073709551614');
      expect(dialog).toHaveTextContent(`${names[origin - 1]} → ${names[destination - 1]}`);
      expect(within(dialog).getAllByRole('listitem')).toHaveLength(3);
      expect(dialog.querySelector('input, textarea, select')).toBeNull();
      expect(document.querySelector('.transfer-receipt')).toHaveAttribute('inert');
      const confirm = within(dialog).getByRole('button', { name: 'Confirmar despacho' });
      within(dialog).getByRole('button', { name: 'Cerrar confirmación de despacho' }).focus();
      fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true }); expect(confirm).toHaveFocus();
      fireEvent.keyDown(dialog, { key: 'Escape' }); expect(trigger).toHaveFocus();
      expect(document.querySelector('.transfer-receipt')).not.toHaveAttribute('inert');
      fireEvent.click(trigger);
      f.env.authority.ready = false; view.rerender(f.element());
      expect(screen.queryByRole('dialog')).toBeNull();
    }
    expect(start).not.toHaveBeenCalled();
    expect(posts(f)).toHaveLength(0);
    expect(f.fetch.mock.calls.some(([url]) => String(url).startsWith('/api/inventory'))).toBe(false);
  });
});

describe('R2 latest Received participant history', () => {
  it.each(['approval', 'dispatch'] as const)('latest Received detail outranks cached %s and exposes immutable history/filter', async cached => {
    const f = fixture();
    if (cached === 'approval') {
      const pending = parseTransferRecord(JSON.stringify({ ...wire(), status: 'pending', decision_location_id: undefined, decided_at: undefined }));
      const token = f.controller.decisionRecovery!.start(pending, 'approve', decisionOwner(f.env.authority)!)!;
      f.controller.decisionRecovery!.finish(token, parseTransferRecord(JSON.stringify(wire())));
    } else {
      const token = f.controller.dispatchRecovery!.start(parseTransferRecord(JSON.stringify(wire())), decisionOwner(f.env.authority)!)!;
      f.controller.dispatchRecovery!.finish(token, parseTransferRecord(JSON.stringify(wire(1, 2, 'in_transit'))));
    }
    const transit = wire(1, 2, 'in_transit');
    f.env.record = { ...transit, status: 'received', ...{
      receipt_location_id: 2, received_at: '2026-04-03T00:00:00.000000003Z', receipt: {
        items: transit.items.map(item => ({ variant_id: item.variant_id, expected_quantity: item.quantity,
          actual_quantity: item.quantity, available_quantity: item.quantity })), exceptions: [],
      },
    } };
    render(f.element());
    await waitFor(() => expect(document.querySelector('.transfer-received-heading')).toHaveTextContent('Recibida'));
    expect(screen.queryByRole('region', { name: 'Historial de la solicitud' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Ver historial' }));
    const history = screen.getByRole('region', { name: 'Historial de la solicitud' });
    expect(history).toHaveTextContent('Solicitud recibida');
    expect(history).toHaveTextContent('Solicitud aprobada'); expect(history).toHaveTextContent('Solicitud despachada');
    expect(history.querySelector('time[datetime="2026-04-03T00:00:00.000000003Z"]')).not.toBeNull();
    expect(document.querySelector('.transfer-received-heading')).toHaveTextContent('Recibida');
    expect(screen.queryByRole('button', { name: /Despachar solicitud|Recibir solicitud|Resolver/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Volver a transferencias' }));
    fireEvent.change(screen.getByLabelText('Estado de transferencia'), { target: { value: 'received' } });
    await screen.findByText('1 solicitud recibida');
    expect(screen.getByRole('table', { name: 'Solicitudes recibidas participantes' })).toHaveTextContent('Recibida');
    expect(posts(f)).toHaveLength(0);
  });
});

it.each(['cancelled', 'received'])('presents readable %s dispatch recovery dates with exact evidence', async status => {
  const dispatched_at = '2026-04-03T00:00:00.000000002Z';
  const terminalStamp = '2026-04-04T00:00:00.000000003Z';
  const result = { ...wire(1, 2, 'in_transit'), status,
    ...(status === 'cancelled' ? { cancellation_location_id: 2, cancelled_at: terminalStamp,
      dispatch_location_id: undefined, dispatched_at: undefined }
      : { receipt_location_id: 2, received_at: terminalStamp, receipt: {
        items: wire().items.map(item => ({ variant_id: item.variant_id, expected_quantity: item.quantity,
          actual_quantity: item.quantity, available_quantity: item.quantity })), exceptions: [],
      } }),
  };
  let recovering = false;
  const f = fixture(1, 1, 2, url => url.endsWith('/dispatch') ? Promise.reject(new Error('Lost reply'))
    : recovering && url === '/api/transfers/9007199254740993' ? Promise.resolve(reply(result)) : undefined);
  render(f.element()); fireEvent.click(await screen.findByRole('button', { name: 'Despachar solicitud' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar despacho' }));
  const consult = await screen.findByRole('button', { name: 'Consultar resultado original del despacho' });
  recovering = true; fireEvent.click(consult);
  const recovery = await screen.findByRole('region', { name: 'Recuperación de despacho' });
  const time = await within(recovery).findByText('03/04/2026 · 20:00 (hora Bolivia)');
  expect(time).toHaveAttribute('datetime', terminalStamp);
  expect(time).toHaveAttribute('title', terminalStamp);
  if (status === 'received') expect(within(recovery).getByText('02/04/2026 · 20:00 (hora Bolivia)')).toHaveAttribute('datetime', dispatched_at);
  else expect(recovery).toHaveTextContent('No se confirmó un despacho');
  const dialog = screen.getByRole('dialog');
  expect(dialog).toHaveTextContent(status === 'received' ? 'Estado confirmado: Recibida.' : 'Estado confirmado: Cancelada.');
  if (status === 'received') {
    expect(within(dialog).getByText(dispatchCompletion.received)).toBeVisible();
    expect(within(dialog).queryByText(dispatchCompletion.in_transit)).not.toBeInTheDocument();
  } else {
    expect(within(dialog).getByText('No se confirmó el despacho original. La solicitud está Cancelada; no se enviará otro despacho.')).toBeVisible();
    expectNoDispatchCompletion(dialog);
    expect(within(dialog).queryByRole('heading', { name: 'Despacho confirmado' })).not.toBeInTheDocument();
  }
  expect(within(dialog).queryByText(/^Se despacharán todas las baterías/)).not.toBeInTheDocument();
  expect(within(dialog).queryByText(/^Se descontarán existencias/)).not.toBeInTheDocument();
  expect(within(dialog).queryByText(/^El destino no recibe stock con el despacho/)).not.toBeInTheDocument();
  expect(posts(f)).toHaveLength(1);
});

describe('U2b approved stock-request dispatch review', () => {
  it('shows a read-only compact whole-request summary, exact total and three stock effects', async () => {
    const f = fixture(); render(f.element());
    const trigger = await screen.findByRole('button', { name: 'Despachar solicitud' });
    expect(trigger).toHaveTextContent(/^Despachar$/); fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveClass('transfer-dispatch-confirmation');
    expect(within(dialog).getAllByRole('columnheader').map(cell => cell.textContent)).toEqual(['Producto', 'Polaridad', 'A despachar']);
    expect(within(dialog).getByRole('cell', { name: 'TOYO Exact-1 · 75.125 Ah' })).toBeVisible();
    expect(dialog).toHaveTextContent('Total: 2 variantes · 18446744073709551614 baterías');
    const bullets = within(dialog).getAllByRole('listitem');
    expect(bullets).toHaveLength(3);
    expect(bullets[0]).toHaveTextContent('18446744073709551614 baterías de Almacén');
    expect(bullets[0]).toHaveTextContent('reserva propia');
    expect(bullets[1]).toHaveTextContent('disponibilidad libre y las reservas de otras transferencias no cambian');
    expect(bullets[2]).toHaveTextContent('En tránsito');
    expect(bullets[2]).toHaveTextContent('Sucursal A recibirá stock solo al confirmar la recepción');
    expect(dialog.querySelector('input, select, textarea')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: /Actualizar/ })).toBeNull();
    expect(posts(f)).toHaveLength(0);
  });
  it.each(['escape', 'close', 'back', 'unmount', 'authority'] as const)('isolates dynamic background and restores prior inert state on %s', async method => {
    const f = fixture(); const view = render(f.element());
    const trigger = await screen.findByRole('button', { name: 'Despachar solicitud' });
    const background = view.container.querySelector('.transfer-receipt')!;
    const prior = document.createElement('aside'); prior.setAttribute('inert', 'retained'); document.body.append(prior);
    const dynamic = document.createElement('button'); dynamic.textContent = 'Dynamic background';
    try {
      fireEvent.click(trigger);
      expect(background).toHaveAttribute('inert');
      document.querySelector('.transfer-dispatch')!.prepend(dynamic);
      await waitFor(() => expect(dynamic).toHaveAttribute('inert'));
      const restored = vi.fn(() => expect(background).not.toHaveAttribute('inert'));
      trigger.addEventListener('focus', restored);
      if (method === 'escape') fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
      if (method === 'close') fireEvent.click(screen.getByRole('button', { name: 'Cerrar confirmación de despacho' }));
      if (method === 'back') fireEvent.click(screen.getByRole('button', { name: 'Volver al detalle' }));
      if (method === 'unmount') view.unmount();
      if (method === 'authority') {
        f.env.authority = { ...f.env.authority, epoch: 2 }; view.rerender(f.element());
      }
      expect(prior).toHaveAttribute('inert', 'retained');
      expect(dynamic).not.toHaveAttribute('inert');
      expect(background).not.toHaveAttribute('inert');
      if (['escape', 'close', 'back'].includes(method)) { expect(trigger).toHaveFocus(); expect(restored).toHaveBeenCalled(); }
      else expect(restored).not.toHaveBeenCalled();
      expect(posts(f)).toHaveLength(0);
    } finally { prior.remove(); dynamic.remove(); }
  });
  it('keeps direct-shipment review and creator cancellation available in the compact presentation', async () => {
    const f = fixture();
    f.env.record = { ...f.env.record, kind: 'direct_shipment', creator_location_id: 1,
      creator_location_name: 'Almacén', decided_at: f.env.record.created_at };
    render(f.element());
    const trigger = await screen.findByRole('button', { name: 'Despachar envío' });
    expect(screen.getByRole('button', { name: 'Cancelar envío' })).toBeEnabled();
    expect(trigger).toHaveTextContent('Despachar envío'); fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveClass('transfer-dispatch-confirmation');
    expect(within(dialog).getByRole('columnheader', { name: 'A despachar' })).toBeVisible();
    fireEvent.keyDown(dialog, { key: 'Escape' }); expect(trigger).toHaveFocus();
    expect(posts(f)).toHaveLength(0);
  });
  it('isolates recovery mounted during busy and uncertain renders until dismissal', async () => {
    const delayed = deferred();
    const f = fixture(1, 1, 2, url => url.endsWith('/dispatch') ? delayed.promise : undefined);
    const view = render(f.element());
    fireEvent.click(await screen.findByRole('button', { name: 'Despachar solicitud' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar despacho' }));
    const recovery = await screen.findByRole('region', { name: 'Recuperación de despacho' });
    await waitFor(() => expect(recovery).toHaveAttribute('inert'));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-busy', 'true');
    await act(async () => delayed.resolve(reply({ error: 'service_unavailable' }, 503)));
    expect(recovery).toHaveAttribute('inert');
    fireEvent.click(screen.getByRole('button', { name: 'Volver al detalle' }));
    expect(recovery).not.toHaveAttribute('inert');
    expect(view.container).not.toHaveAttribute('inert');
    expect(posts(f)).toHaveLength(1);
  });
});

describe('D2 dispatch participant UI', () => {
  it.each(['escape', 'close', 'back'] as const)('restores dispatch cancellation/success focus via %s without requests', async method => {
    for (const confirmed of [false, true]) {
      const f = fixture(); const view = render(f.element());
      const trigger = await screen.findByRole('button', { name: 'Despachar solicitud' });
      fireEvent.click(trigger);
      const dialog = screen.getByRole('dialog');
      if (confirmed) {
        fireEvent.click(within(dialog).getByRole('button', { name: 'Confirmar despacho' }));
        await within(dialog).findByRole('heading', { name: 'Despacho confirmado' });
        expect(trigger.isConnected).toBe(false);
      }
      await act(async () => {});
      const before = f.fetch.mock.calls.length;
      if (method === 'escape') fireEvent.keyDown(dialog, { key: 'Escape' });
      if (method === 'close') fireEvent.click(within(dialog).getByRole('button', { name: 'Cerrar confirmación de despacho' }));
      if (method === 'back') fireEvent.click(within(dialog).getByRole('button', { name: 'Volver al detalle' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      if (confirmed) expect(screen.getByRole('button', { name: 'Volver a transferencias' })).toHaveFocus();
      else { expect(trigger).toBeEnabled(); expect(trigger).toHaveFocus(); }
      await act(async () => {});
      expect(f.fetch.mock.calls).toHaveLength(before);
      expect(posts(f)).toHaveLength(confirmed ? 1 : 0);
      view.unmount();
    }
  });
  it.each([[1, 1, 2], [3, 3, 2], [2, 2, 1]])('only assigned physical origin %s confirms %s → %s in full', async (actor, origin, destination) => {
    const f = fixture(actor, origin, destination); render(f.element());
    const trigger = await screen.findByRole('button', { name: destination === 1 ? 'Despachar envío' : 'Despachar solicitud' });
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Confirmar despacho' });
    expect(within(dialog).getByText('A despachar')).toBeInTheDocument();
    expect(dialog).toHaveTextContent('18446744073709551614 baterías');
    expect(dialog).toHaveTextContent('reserva propia');
    expect(dialog).toHaveClass('transfer-dispatch-confirmation');
    expect(dialog).toHaveTextContent('reserva propia');
    expect(dialog).toHaveTextContent('disponibilidad libre y las reservas de otras transferencias no cambian');
    expect(dialog).toHaveTextContent('recibirá stock solo al confirmar la recepción');
    expect(posts(f)).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirmar despacho' }));
    await screen.findByRole('heading', { name: 'Despacho confirmado', level: 2 });
    expect(within(dialog).getByText(dispatchCompletion.in_transit)).toBeVisible();
    expect(dialog).toHaveTextContent('Estado confirmado: En tránsito.');
    expect(within(dialog).queryByText(/^Se despacharán todas las baterías/)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/^Se descontarán existencias/)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/^El destino no recibe stock con el despacho/)).not.toBeInTheDocument();
    const recovery = screen.getByRole('region', { name: 'Recuperación de despacho' });
    const time = within(recovery).getByText('02/04/2026 · 20:00 (hora Bolivia)');
    expect(time).toHaveAttribute('datetime', '2026-04-03T00:00:00.000000002Z');
    expect(time).toHaveAttribute('title', '2026-04-03T00:00:00.000000002Z');
    expect(posts(f)).toHaveLength(1);
    expect(posts(f)[0]).toMatchObject(['/api/transfers/9007199254740993/dispatch', { body: '{}' }]);
    expect(f.controller.confirmTransferDispatch).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Volver al detalle' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ver historial' }));
    const history = screen.getByRole('region', { name: destination === 1 ? 'Historial de la propuesta' : 'Historial de la solicitud' });
    expect(history).toHaveTextContent(destination === 1 ? 'Propuesta aprobada y stock reservado' : 'Solicitud aprobada y stock reservado');
    expect(history).toHaveTextContent(destination === 1 ? 'Envío despachado' : 'Solicitud despachada');
    expect(history).toHaveTextContent(`Origen: ${names[origin - 1]}`);
    expect(history.querySelector('time[datetime="2026-04-03T00:00:00.000000002Z"]')).not.toBeNull();
    expect(screen.getByRole('region', { name: 'Productos enviados' })).toHaveTextContent('Pendiente de recepción');
    expect(screen.queryByRole('button', { name: /Recibir|Cancelar/ })).not.toBeInTheDocument();
    expect(f.fetch.mock.calls.some(([url]) => String(url).startsWith('/api/inventory'))).toBe(false);
  });
  it.each([[2, 1, 2], [1, 2, 1]])('destination %s cannot dispatch approved %s → %s', async (actor, origin, destination) => {
    const f = fixture(actor, origin, destination); render(f.element());
    await screen.findByRole('heading', { name: f.env.record.reference });
    expect(screen.queryByRole('button', { name: /Despachar/ })).not.toBeInTheDocument();
    expect(posts(f)).toHaveLength(0);
  });
  it.each(['lost', '503'] as const)('keeps the open dispatch dialog uncertain after %s and an Approved GET', async mode => {
    const f = fixture(1, 1, 2, url => url.endsWith('/dispatch')
      ? mode === '503' ? Promise.resolve(reply({ error: 'service_unavailable' }, 503)) : Promise.reject(new Error('lost'))
      : undefined);
    render(f.element()); fireEvent.click(await screen.findByRole('button', { name: 'Despachar solicitud' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar despacho' }));
    await screen.findByText('Despacho pendiente de confirmación');
    const dialog = screen.getByRole('dialog');
    expectNoDispatchCompletion(dialog);
    const recovery = screen.getByRole('region', { name: 'Recuperación de despacho' });
    await act(async () => { fireEvent.click(within(recovery).getByRole('button', { name: 'Consultar resultado original del despacho' })); });
    await waitFor(() => expect(within(recovery).getByRole('button', { name: 'Reintentar mismo despacho' })).toBeEnabled());
    expect(within(dialog).getByText('Resultado sin confirmar. Usá la recuperación del despacho original.')).toBeVisible();
    expectNoDispatchCompletion(dialog);
    expect(posts(f)).toHaveLength(1);
  });
  it('requires explicit consult/retry after lost POST, preserves uncertainty through pane remount and Approved GET', async () => {
    let sent = 0;
    const f = fixture(1, 1, 2, url => url.endsWith('/dispatch') && ++sent === 1 ? Promise.reject(new Error('lost')) : undefined);
    const view = render(f.element());
    fireEvent.click(await screen.findByRole('button', { name: 'Despachar solicitud' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar despacho' }));
    await screen.findByText('Despacho pendiente de confirmación');
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar confirmación de despacho' }));
    view.unmount(); render(f.element());
    const recovery = await screen.findByRole('region', { name: 'Recuperación de despacho' });
    fireEvent.click(within(recovery).getByRole('button', { name: 'Consultar resultado original del despacho' }));
    await waitFor(() => expect(within(recovery).getByRole('button', { name: 'Reintentar mismo despacho' })).toBeEnabled());
    expect(recovery).toHaveTextContent('aunque una consulta muestre Aprobada');
    expect(posts(f)).toHaveLength(1);
    fireEvent.click(within(recovery).getByRole('button', { name: 'Reintentar mismo despacho' }));
    await waitFor(() => expect(recovery).toHaveTextContent('En tránsito'));
    expect(posts(f)).toHaveLength(2);
  });
  it('traps/restores focus and blocks dismissal and double POST while busy, with central long-item table', async () => {
    const delayed = deferred();
    const f = fixture(1, 1, 2, url => url.endsWith('/dispatch') ? delayed.promise : undefined);
    f.env.record = wire(1, 2, 'approved', 190);
    render(f.element()); const trigger = await screen.findByRole('button', { name: 'Despachar solicitud' });
    fireEvent.click(trigger);
    let dialog = screen.getByRole('dialog');
    const close = within(dialog).getByRole('button', { name: 'Cerrar confirmación de despacho' });
    const confirm = within(dialog).getByRole('button', { name: 'Confirmar despacho' });
    expect(close).toHaveFocus(); fireEvent.keyDown(close, { key: 'Tab', shiftKey: true }); expect(confirm).toHaveFocus();
    fireEvent.keyDown(confirm, { key: 'Tab' }); expect(close).toHaveFocus();
    expect(within(dialog).getAllByRole('row')).toHaveLength(192);
    expect(dialog.querySelector('.transfer-decision-body .transfer-detail-items')).not.toBeNull();
    fireEvent.keyDown(dialog, { key: 'Escape' }); expect(screen.queryByRole('dialog')).toBeNull(); expect(trigger).toHaveFocus();
    fireEvent.click(trigger); dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirmar despacho' }));
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(dialog).toBeInTheDocument(); expect(dialog).toHaveAttribute('aria-busy', 'true');
    expectNoDispatchCompletion(dialog);
    expect(within(dialog).getByRole('button', { name: 'Cerrar confirmación de despacho' })).toBeDisabled();
    expect(posts(f)).toHaveLength(1);
    await act(async () => { delayed.resolve(reply(wire(1, 2, 'in_transit', 190))); });
    await screen.findByRole('heading', { name: 'Despacho confirmado', level: 2 });
  });
  it('does not let cached approval hide newer transit detail, and labels workflow counters truthfully', async () => {
    const f = fixture();
    const pending = parseTransferRecord(JSON.stringify({ ...wire(), status: 'pending', decision_location_id: undefined, decided_at: undefined }));
    const token = f.controller.decisionRecovery!.start(pending, 'approve', decisionOwner(f.env.authority)!)!;
    f.controller.decisionRecovery!.finish(token, parseTransferRecord(JSON.stringify(wire())));
    f.env.record = wire(1, 2, 'in_transit'); render(f.element());
    await screen.findByRole('heading', { name: f.env.record.reference });
    expect(document.querySelector('.transfer-transit-heading')).toHaveTextContent('En tránsito');
    fireEvent.click(screen.getByRole('button', { name: 'Ver historial' }));
    expect(screen.getByRole('region', { name: 'Historial de la solicitud' })).toHaveTextContent('Solicitud despachada');
    expect(screen.queryByRole('button', { name: 'Despachar solicitud' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Volver a transferencias' }));
    expect(screen.getByRole('region', { name: 'Contadores de solicitudes' })).toHaveTextContent('2 transferencias requieren tu atención');
    fireEvent.change(screen.getByLabelText('Estado de transferencia'), { target: { value: 'in_transit' } });
    await screen.findByText('1 solicitud en tránsito');
    expect(screen.getByRole('table', { name: 'Solicitudes en tránsito participantes' })).toHaveTextContent('En tránsito');
  });
  it.each(['epoch', 'generation', 'unready'] as const)('fences saved confirmation handlers and private dialog on %s replacement', async change => {
    const f = fixture(); const view = render(f.element());
    fireEvent.click(await screen.findByRole('button', { name: 'Despachar solicitud' }));
    const confirm = screen.getByRole('button', { name: 'Confirmar despacho' });
    if (change === 'epoch') f.env.authority = { ...f.env.authority, epoch: 2 };
    if (change === 'generation') f.env.authority = { ...f.env.authority, sessionGeneration: 2 };
    if (change === 'unready') f.env.authority = { ...f.env.authority, ready: false };
    // The retained DOM callback must consult current authority before React rerenders.
    fireEvent.click(confirm); expect(posts(f)).toHaveLength(0);
    view.rerender(f.element());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Recuperación de despacho' })).toBeNull();
    expect(posts(f)).toHaveLength(0);
  });
  it.each([403, 404])('hides private selected record and recovery after dispatch %s', async status => {
    const f = fixture(1, 1, 2, url => url.endsWith('/dispatch') ? Promise.resolve(reply({ error: status === 403 ? 'forbidden' : 'not_found' }, status)) : undefined);
    render(f.element()); fireEvent.click(await screen.findByRole('button', { name: 'Despachar solicitud' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar despacho' }));
    await screen.findByText('La solicitud no está disponible.');
    expect(screen.queryByRole('region', { name: 'Recuperación de despacho' })).toBeNull();
    expect(screen.queryByRole('heading', { name: f.env.record.reference })).toBeNull();
  });
});
