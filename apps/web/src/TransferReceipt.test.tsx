import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App';

// Exercise the existing App/controller boundary, not an import of the planned
// component. Before R2 these fail at the destination receipt affordance.
const locations = [{ id: 1, name: 'Almacén' }, { id: 2, name: 'Sucursal A' }, { id: 3, name: 'Sucursal B' }];
const sent = '9007199254740993';
const transit = {
  id: '1', reference: 'TR-001', kind: 'request_stock', status: 'in_transit',
  creator_location_id: 2, creator_location_name: 'Sucursal A', origin_location_id: 1, origin_location_name: 'Almacén',
  destination_location_id: 2, destination_location_name: 'Sucursal A', approver_location_id: 1, approver_location_name: 'Almacén',
  created_at: '2026-04-02T00:00:00Z', decision_location_id: 1, decided_at: '2026-04-03T00:00:00.000000001Z',
  dispatch_location_id: 1, dispatched_at: '2026-04-03T00:00:00.000000002Z',
  items: [{ variant_id: 1, brand: 'TOYO', model: 'Expected', capacity_ah: '75.125', polarity: 'L', quantity: sent }],
};
function outcome(actual = sent, unexpected = false) {
  const credited = BigInt(actual) < BigInt(sent) ? actual : sent;
  return { ...transit, status: 'received', receipt_location_id: 2, received_at: '2026-04-03T00:00:00.000000003Z',
    receipt: { items: [ { variant_id: 1, expected_quantity: sent, actual_quantity: actual, available_quantity: credited },
      ...(unexpected ? [{ variant_id: 2, expected_quantity: '0', actual_quantity: '7', available_quantity: '0' }] : []) ],
    exceptions: [ ...(BigInt(actual) < BigInt(sent) ? [{ variant_id: 1, kind: 'shortage', quantity: (BigInt(sent) - BigInt(actual)).toString() }]
      : BigInt(actual) > BigInt(sent) ? [{ variant_id: 1, kind: 'excess', quantity: (BigInt(actual) - BigInt(sent)).toString() }] : []),
      ...(unexpected ? [{ variant_id: 2, kind: 'unexpected', quantity: '7' }] : []) ] } };
}
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
class Source {
  readyState = 0;
  addEventListener() {}
  removeEventListener() {}
  close() { this.readyState = 2; }
}
function fixture(actor = 2, override?: (url: string, init: RequestInit) => Promise<Response> | undefined) {
  let record: unknown = transit;
  const session = { authenticated: true, csrf_token: 'c'.repeat(43), expires_at: '2030-01-01T00:00:00Z',
    identity: { account_id: actor, username: `receipt-${actor}`, location: locations[actor - 1] } };
  const fetch = vi.fn((input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = String(input); const custom = override?.(url, init); if (custom) return custom;
    if (url === '/api/auth/session' || url === '/api/auth/validate') return Promise.resolve(reply(session));
    if (url === '/api/inventory/metadata') return Promise.resolve(reply({ locations, brands: ['TOYO'] }));
    if (url.startsWith('/api/inventory?')) {
      const q = new URL(url, 'http://localhost').searchParams;
      const row = (variant_id: number, model: string) => ({ variant_id, catalog_entry_id: variant_id,
        brand: 'TOYO', model, capacity_ah: 75.125, polarity: 'L', existing: 0, reserved: 0, available: 0 });
      return Promise.resolve(reply({ location: locations[Number(q.get('location_id')) - 1], page: Number(q.get('page')),
        page_size: Number(q.get('page_size')), total_variants: 2, items: [row(1, 'Expected'), row(2, 'Unexpected')] }));
    }
    if (url === '/api/transfers/counts') return Promise.resolve(reply({ pending_total: '0', action_count: actor === 2 ? '1' : '0' }));
    if (url.startsWith('/api/transfers?')) {
      const status = new URL(url, 'http://localhost').searchParams.get('status');
      const records = status === Reflect.get(record as object, 'status') ? [record] : [];
      return Promise.resolve(reply({ page: 1, page_size: 25, status, total_count: String(records.length), records }));
    }
    if (url === '/api/transfers/1') return Promise.resolve(reply(record));
    if (url === '/api/transfers/1/receive') {
      const items = JSON.parse(String(init.body)).items as { variant_id: number; actual_quantity: string }[];
      record = outcome(items.find(item => item.variant_id === 1)!.actual_quantity, items.some(item => item.variant_id === 2));
      return Promise.resolve(reply(record));
    }
    throw new Error('Unexpected fixture route: ' + url);
  });
  vi.stubGlobal('fetch', fetch); vi.stubGlobal('EventSource', Source);
  return { fetch, setRecord: (value: unknown) => { record = value; } };
}
const posts = (f: ReturnType<typeof fixture>) => f.fetch.mock.calls.filter(([url, init]) => String(url).endsWith('/receive') && init?.method === 'POST');
async function detail() {
  await screen.findByRole('region', { name: 'Resultados de inventario' });
  fireEvent.click(screen.getByRole('button', { name: 'Transferencias' }));
  fireEvent.change(await screen.findByLabelText('Estado de transferencia'), { target: { value: 'in_transit' } });
  fireEvent.click(await screen.findByRole('button', { name: 'Ver detalle TR-001' }));
  await screen.findByRole('heading', { name: 'TR-001' });
}
async function capture() {
  fireEvent.click(await screen.findByRole('button', { name: 'Recibir solicitud' }));
  return screen.getByRole('dialog', { name: 'Confirmar recepción' });
}
const actualInput = () => screen.getByLabelText(/Cantidad recibida.*Expected/);
afterEach(() => vi.unstubAllGlobals());

describe('R2 destination receipt capture/review/once UI', () => {
  it.each(['escape', 'close', 'back'] as const)('restores receipt cancellation/success focus via %s, not during review', async method => {
    for (const confirmed of [false, true]) {
      const f = fixture(); const view = render(<App />); await detail();
      const trigger = screen.getByRole('button', { name: 'Recibir solicitud' });
      const dialog = await capture();
      const restoration = vi.spyOn(trigger, 'focus');
      fireEvent.change(actualInput(), { target: { value: sent } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Revisar recepción' }));
      expect(restoration).not.toHaveBeenCalled();
      expect(within(dialog).getByRole('button', { name: 'Cerrar confirmación de recepción' })).toHaveFocus();
      if (confirmed) {
        fireEvent.click(within(dialog).getByRole('button', { name: 'Confirmar recepción' }));
        await within(dialog).findByRole('heading', { name: 'Recepción confirmada' });
        expect(trigger.isConnected).toBe(false);
      }
      await act(async () => {});
      const before = f.fetch.mock.calls.length;
      if (method === 'escape') fireEvent.keyDown(dialog, { key: 'Escape' });
      if (method === 'close') fireEvent.click(within(dialog).getByRole('button', { name: 'Cerrar confirmación de recepción' }));
      if (method === 'back') fireEvent.click(within(dialog).getByRole('button', { name: 'Volver al detalle' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      if (confirmed) expect(screen.getByRole('button', { name: 'Volver a en tránsito' })).toHaveFocus();
      else { expect(trigger).toBeEnabled(); expect(trigger).toHaveFocus(); }
      await act(async () => {});
      expect(f.fetch.mock.calls).toHaveLength(before);
      expect(posts(f)).toHaveLength(confirmed ? 1 : 0);
      restoration.mockRestore();
      view.unmount();
    }
  });
  it('offers capture only to destination, never physical origin', async () => {
    const f = fixture(1); render(<App />); await detail();
    expect(screen.queryByRole('button', { name: 'Recibir solicitud' })).not.toBeInTheDocument();
    expect(posts(f)).toHaveLength(0);
  });
  it('requires quantity review before one explicit confirmation, without destination availability caps', async () => {
    const f = fixture(); render(<App />); await detail();
    await capture();
    fireEvent.change(actualInput(), { target: { value: '9007199254740994' } });
    fireEvent.click(screen.getByRole('button', { name: 'Revisar recepción' }));
    const dialog = screen.getByRole('dialog', { name: 'Confirmar recepción' });
    expect(dialog).toHaveTextContent('Exceso'); expect(dialog).toHaveTextContent(sent);
    expect(dialog).toHaveTextContent('disponible'); expect(posts(f)).toHaveLength(0);
    expect(dialog).toHaveTextContent('Solo el mínimo entre lo recibido y lo enviado de cada variante esperada se acredita como stock disponible. Faltantes, excesos y variantes inesperadas quedan registrados por separado; no se acreditan ni se resuelven automáticamente.');
    expect(dialog).toHaveTextContent('Confirmar finaliza la recepción una sola vez. No se podrá modificar después.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirmar recepción' }));
    await screen.findByRole('heading', { name: 'Recepción confirmada', level: 2 });
    expect(within(dialog).getByRole('status')).toHaveTextContent('Recepción registrada correctamente.');
    expect(within(dialog).getAllByRole('table', { name: 'Detalle de recepción' })).toHaveLength(1);
    const persisted = within(dialog).getByRole('table', { name: 'Detalle de recepción' });
    expect(persisted).toHaveTextContent('9007199254740994');
    expect(persisted).toHaveTextContent(sent);
    expect(persisted).toHaveTextContent('Exceso: 1');
    expect(within(dialog).queryByText(/^Solo el mínimo entre lo recibido y lo enviado/)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/^Confirmar finaliza la recepción una sola vez/)).not.toBeInTheDocument();
    expect(posts(f)).toHaveLength(1);
    expect(JSON.parse(String(posts(f)[0][1]?.body))).toEqual({ items: [{ variant_id: 1, actual_quantity: '9007199254740994' }] });
    expect(screen.getByRole('region', { name: 'Historial de la solicitud' })).toHaveTextContent('Solicitud recibida');
    expect(screen.queryByRole('button', { name: /Resolver discrepancia|Recibir solicitud/ })).not.toBeInTheDocument();
  });
  it.each(['', '00', '+1', '-1', '1.0', '1e2', '9223372036854775808', '0'])('does not admit invalid or total-zero actual %s', async actual => {
    const f = fixture(); render(<App />); await detail(); await capture();
    fireEvent.change(actualInput(), { target: { value: actual } });
    expect(screen.getByRole('button', { name: 'Revisar recepción' })).toBeDisabled();
    expect(posts(f)).toHaveLength(0);
  });
  it('permits unexpected-only arrivals using destination catalog and explicit expected zero', async () => {
    const f = fixture(); render(<App />); await detail(); await capture();
    fireEvent.change(actualInput(), { target: { value: '0' } });
    const unexpectedSelector = await screen.findByLabelText('Variante inesperada');
    await waitFor(() => expect(unexpectedSelector).toBeEnabled());
    fireEvent.change(unexpectedSelector, { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Agregar variante inesperada' }));
    fireEvent.change(screen.getByLabelText(/Cantidad recibida.*Unexpected/), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: 'Revisar recepción' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Faltante'); expect(dialog).toHaveTextContent('Inesperada');
    expect(dialog).toHaveTextContent('0'); expect(posts(f)).toHaveLength(0);
    const stockReadsBefore = f.fetch.mock.calls.filter(([url]) => String(url).startsWith('/api/inventory?')).length;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirmar recepción' }));
    await screen.findByRole('heading', { name: 'Recepción confirmada', level: 2 });
    expect(posts(f)).toHaveLength(1);
    expect(f.fetch.mock.calls.filter(([url]) => String(url).startsWith('/api/inventory?'))).toHaveLength(stockReadsBefore);
    expect(JSON.parse(String(posts(f)[0][1]?.body))).toEqual({ items: [{ variant_id: 1, actual_quantity: '0' }, { variant_id: 2, actual_quantity: '7' }] });
    const catalogs = f.fetch.mock.calls.filter(([url]) => String(url).startsWith('/api/inventory?') && String(url).includes('page_size=50'));
    expect(catalogs.length).toBeGreaterThan(0);
    expect(catalogs.every(([url]) => new URL(String(url), 'http://localhost').searchParams.get('location_id') === '2')).toBe(true);
  });
  it('locks double-confirmation/dismissal during POST and restores focus when capture is canceled', async () => {
    let resolve!: (value: Response) => void;
    const job = new Promise<Response>(yes => { resolve = yes; });
    const f = fixture(2, url => url.endsWith('/receive') ? job : undefined); render(<App />); await detail();
    const trigger = screen.getByRole('button', { name: 'Recibir solicitud' });
    let dialog = await capture();
    fireEvent.keyDown(dialog, { key: 'Escape' }); expect(screen.queryByRole('dialog')).toBeNull(); expect(trigger).toHaveFocus();
    dialog = await capture(); fireEvent.change(actualInput(), { target: { value: sent } });
    fireEvent.click(screen.getByRole('button', { name: 'Revisar recepción' }));
    const confirm = screen.getByRole('button', { name: 'Confirmar recepción' });
    fireEvent.click(confirm); fireEvent.click(confirm); fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(dialog).toHaveAttribute('aria-busy', 'true'); expect(confirm).toBeDisabled(); expect(posts(f)).toHaveLength(1);
    expect(within(dialog).queryByText('Recepción registrada correctamente.')).not.toBeInTheDocument();
    await act(async () => { resolve(reply(outcome())); }); await screen.findByRole('heading', { name: 'Recepción confirmada', level: 2 });
  });
  it('retains receipt across Inventory navigation; InTransit consult is not proof of failure', async () => {
    let sentPosts = 0;
    const f = fixture(2, url => url.endsWith('/receive') && ++sentPosts === 1 ? Promise.reject(new Error('lost')) : undefined);
    render(<App />); await detail(); await capture(); fireEvent.change(actualInput(), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Revisar recepción' })); fireEvent.click(screen.getByRole('button', { name: 'Confirmar recepción' }));
    await screen.findByText('Recepción pendiente de confirmación');
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar confirmación de recepción' }));
    fireEvent.click(screen.getByRole('button', { name: 'Volver al inventario' }));
    await screen.findByRole('region', { name: 'Resultados de inventario' });
    fireEvent.click(screen.getByRole('button', { name: 'Transferencias' }));
    const recovery = await screen.findByRole('region', { name: 'Recuperación de recepción' });
    fireEvent.click(within(recovery).getByRole('button', { name: 'Consultar resultado original de la recepción' }));
    await waitFor(() => expect(within(recovery).getByRole('button', { name: 'Reintentar misma recepción' })).toBeEnabled());
    expect(recovery).toHaveTextContent('En tránsito'); expect(posts(f)).toHaveLength(1);
    fireEvent.click(within(recovery).getByRole('button', { name: 'Reintentar misma recepción' }));
    await waitFor(() => expect(recovery).toHaveTextContent('Recibida'));
    expect(posts(f)).toHaveLength(2); expect(posts(f)[0][1]?.body).toBe(posts(f)[1][1]?.body);
  });
  it.each([403, 404] as const)('masks private receipt/request quantities after %s without automatic replay', async status => {
    const f = fixture(2, url => url.endsWith('/receive') ? Promise.resolve(reply({ error: status === 403 ? 'forbidden' : 'not_found' }, status)) : undefined);
    render(<App />); await detail(); await capture(); fireEvent.change(actualInput(), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Revisar recepción' })); fireEvent.click(screen.getByRole('button', { name: 'Confirmar recepción' }));
    await screen.findByText('La solicitud no está disponible.');
    expect(screen.queryByRole('region', { name: 'Historial de la solicitud' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Recuperación de recepción' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Cantidad recibida.*Expected/)).not.toBeInTheDocument();
    expect(posts(f)).toHaveLength(1);
  });
  it.each(['received', 'in_transit'] as const)('keeps the open receipt dialog truthful after a lost POST and %s consultation', async status => {
    const f = fixture(2, url => url.endsWith('/receive') ? Promise.reject(new Error('lost')) : undefined);
    render(<App />); await detail();
    const dialog = await capture();
    fireEvent.change(actualInput(), { target: { value: '1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revisar recepción' }));
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Confirmar recepción' })); });
    await screen.findByText('Recepción pendiente de confirmación');
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).queryByText('Recepción registrada correctamente.')).not.toBeInTheDocument();
    f.setRecord(status === 'received' ? outcome() : transit);
    const recovery = screen.getByRole('region', { name: 'Recuperación de recepción' });
    await act(async () => { fireEvent.click(within(recovery).getByRole('button', { name: 'Consultar resultado original de la recepción' })); });
    expect(posts(f)).toHaveLength(1);
    if (status === 'received') {
      expect(await within(dialog).findByText(
        'La recepción persistida tiene cantidades diferentes de las enviadas en este intento. No se reemplazaron las cantidades originales ni se reintentará la recepción.')).toBeVisible();
      expect(within(dialog).queryByRole('heading', { name: 'Recepción confirmada' })).not.toBeInTheDocument();
      expect(within(dialog).getAllByRole('table', { name: 'Detalle de recepción' })).toHaveLength(1);
      const persisted = within(dialog).getByRole('table', { name: 'Detalle de recepción' });
      expect(persisted).toHaveTextContent(sent);
      expect(persisted).toHaveTextContent('Sin discrepancia');
      expect(within(recovery).queryByRole('button', { name: 'Reintentar misma recepción' })).not.toBeInTheDocument();
    } else {
      expect(within(dialog).getByText('Resultado sin confirmar. Usá la recuperación de la recepción original.')).toBeVisible();
      expect(within(recovery).getByRole('button', { name: 'Reintentar misma recepción' })).toBeEnabled();
    }
    expect(within(dialog).queryByText('Recepción registrada correctamente.')).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Confirmar recepción' })).not.toBeInTheDocument();
    expect(posts(f)).toHaveLength(1);
  });

  it('distinguishes a different persisted receipt from the sent quantities, without offering a second receipt', async () => {
    const f = fixture(2, url => url.endsWith('/receive') ? Promise.reject(new Error('lost')) : undefined);
    render(<App />); await detail(); await capture(); fireEvent.change(actualInput(), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Revisar recepción' })); fireEvent.click(screen.getByRole('button', { name: 'Confirmar recepción' }));
    await screen.findByText('Recepción pendiente de confirmación');
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar confirmación de recepción' })); f.setRecord(outcome());
    const recovery = screen.getByRole('region', { name: 'Recuperación de recepción' });
    fireEvent.click(within(recovery).getByRole('button', { name: 'Consultar resultado original de la recepción' }));
    await waitFor(() => expect(recovery).toHaveTextContent(/cantidades.*diferentes/i));
    expect(within(recovery).queryByRole('button', { name: 'Reintentar misma recepción' })).not.toBeInTheDocument();
    expect(posts(f)).toHaveLength(1);
  });
});
