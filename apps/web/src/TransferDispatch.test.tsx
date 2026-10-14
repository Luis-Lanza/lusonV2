import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TransferPending, { transferViewOwner } from './TransferPending';
import { createTransferDispatchRecovery } from './transferDispatchRecovery';
import { createTransferDecisionRecovery, decisionOwner } from './transferDecisionRecovery';
import { parseTransferRecord } from './transferModel';
import type { TransferAuthority } from './useInventory';
import type { DetailController } from './TransferDetail';

const names = ['Almacén', 'Sucursal A', 'Sucursal B'];
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
      const records = status === env.record.status ? [env.record] : [];
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
    const history = await screen.findByRole('region', { name: 'Historial de la solicitud' });
    await waitFor(() => expect(history).toHaveTextContent('Solicitud recibida'));
    expect(history).toHaveTextContent('Solicitud aprobada'); expect(history).toHaveTextContent('Solicitud despachada');
    expect(screen.getByRole('complementary', { name: 'Resumen de solicitud' })).toHaveTextContent('Recibida');
    expect(screen.queryByRole('button', { name: /Despachar solicitud|Recibir solicitud|Resolver/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Volver a pendientes' }));
    fireEvent.change(screen.getByLabelText('Estado de transferencia'), { target: { value: 'received' } });
    await screen.findByText('1 solicitudes recibidas');
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
  expect(posts(f)).toHaveLength(1);
});

describe('D2 dispatch participant UI', () => {
  it.each([[1, 1, 2], [3, 3, 2], [2, 2, 1]])('only assigned physical origin %s confirms %s → %s in full', async (actor, origin, destination) => {
    const f = fixture(actor, origin, destination); render(f.element());
    const trigger = await screen.findByRole('button', { name: 'Despachar solicitud' });
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Confirmar despacho' });
    expect(within(dialog).getByText('Cantidad a despachar')).toBeInTheDocument();
    expect(dialog).toHaveTextContent('18446744073709551614 baterías');
    expect(dialog).toHaveTextContent('reserva propia');
    expect(dialog).toHaveTextContent('no recibe stock');
    expect(posts(f)).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirmar despacho' }));
    await screen.findByRole('heading', { name: 'Despacho confirmado', level: 2 });
    const recovery = screen.getByRole('region', { name: 'Recuperación de despacho' });
    const time = within(recovery).getByText('02/04/2026 · 20:00 (hora Bolivia)');
    expect(time).toHaveAttribute('datetime', '2026-04-03T00:00:00.000000002Z');
    expect(time).toHaveAttribute('title', '2026-04-03T00:00:00.000000002Z');
    expect(posts(f)).toHaveLength(1);
    expect(posts(f)[0]).toMatchObject(['/api/transfers/9007199254740993/dispatch', { body: '{}' }]);
    expect(f.controller.confirmTransferDispatch).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('region', { name: 'Historial de la solicitud' })).toHaveTextContent('Solicitud aprobada y stock reservado');
    expect(screen.getByRole('region', { name: 'Historial de la solicitud' })).toHaveTextContent('Solicitud despachada');
    expect(screen.getByRole('complementary', { name: 'Resumen de solicitud' })).toHaveTextContent('Pendiente de recepción');
    expect(screen.queryByRole('button', { name: /Recibir|Cancelar/ })).not.toBeInTheDocument();
    expect(f.fetch.mock.calls.some(([url]) => String(url).startsWith('/api/inventory'))).toBe(false);
  });
  it.each([[2, 1, 2], [1, 2, 1]])('destination %s cannot dispatch approved %s → %s', async (actor, origin, destination) => {
    const f = fixture(actor, origin, destination); render(f.element());
    await screen.findByRole('heading', { name: f.env.record.reference });
    expect(screen.queryByRole('button', { name: 'Despachar solicitud' })).not.toBeInTheDocument();
    expect(posts(f)).toHaveLength(0);
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
    await waitFor(() => expect(screen.getByRole('region', { name: 'Historial de la solicitud' })).toHaveTextContent('Solicitud despachada'));
    expect(screen.queryByRole('button', { name: 'Despachar solicitud' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Contadores de solicitudes' })).toHaveTextContent('Acciones requeridas2');
    fireEvent.click(screen.getByRole('button', { name: 'Volver a pendientes' }));
    fireEvent.change(screen.getByLabelText('Estado de transferencia'), { target: { value: 'in_transit' } });
    await screen.findByText('1 solicitudes en tránsito');
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
