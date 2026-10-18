import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import TransferReceipt, { ReceiptPreview, type TransferReceiptProps } from './TransferReceipt';
import { parseTransferRecord, previewTransferReceipt } from './transferModel';

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
  return screen.getByRole('dialog', { name: 'Registrar cantidades recibidas' });
}
const actualInput = () => screen.getByLabelText(/Cantidad recibida.*Expected/);
afterEach(() => vi.unstubAllGlobals());

const receiptRoutes = [
  { kind: 'request_stock', origin: 1, destination: 2, creator: 2, approver: 1 },
  { kind: 'request_stock', origin: 3, destination: 2, creator: 2, approver: 3 },
  { kind: 'direct_shipment', origin: 1, destination: 2, creator: 1, approver: 1 },
  { kind: 'send_to_warehouse', origin: 2, destination: 1, creator: 2, approver: 1 },
];
function routeRecord(route: typeof receiptRoutes[number]) {
  return { ...transit, kind: route.kind,
    creator_location_id: route.creator, creator_location_name: locations[route.creator - 1].name,
    origin_location_id: route.origin, origin_location_name: locations[route.origin - 1].name,
    destination_location_id: route.destination, destination_location_name: locations[route.destination - 1].name,
    approver_location_id: route.approver, approver_location_name: locations[route.approver - 1].name,
    decision_location_id: route.approver, dispatch_location_id: route.origin,
    decided_at: route.kind === 'direct_shipment' ? transit.created_at : transit.decided_at,
  };
}
describe('F2 shared receipt across eligible routes', () => {
  it.each(receiptRoutes)('shares capture/review/edit and destination-only reads for $kind from $origin', async route => {
    const original = routeRecord(route);
    const f = fixture(route.destination); f.setRecord(original);
    const view = render(<App />); await detail();
    const label = route.kind === 'request_stock' ? 'Recibir solicitud' : 'Registrar recepción';
    const trigger = screen.getByRole('button', { name: label });
    if (route.kind !== 'request_stock') expect(screen.queryByRole('button', { name: 'Recibir solicitud' })).toBeNull();
    const before = f.fetch.mock.calls.length;
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Registrar cantidades recibidas' });
    expect(dialog).toHaveClass('transfer-receipt-modal');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveTextContent(`TR-001 · ${original.origin_location_name} → ${original.destination_location_name}`);
    expect(dialog).toHaveTextContent('Conteo · Luego revisarás la recepción');
    expect(view.container.querySelector('.transfer-receipt > .transfer-cancellation')).toHaveAttribute('inert');
    expect(within(dialog).getByRole('button', { name: 'Cerrar confirmación de recepción' })).toHaveFocus();
    const table = within(dialog).getByRole('table', { name: 'Cantidades recibidas' });
    expect(table).toHaveTextContent(sent);
    expect(table).toHaveTextContent('75.125 Ah'); expect(table).toHaveTextContent('Izquierda [L]');
    expect(actualInput()).toHaveValue('');
    expect(actualInput()).toHaveAttribute('aria-describedby', 'receipt-capture-rules');
    expect(within(dialog).getByRole('button', { name: 'Revisar recepción' })).toBeDisabled();
    expect(within(dialog).queryByRole('button', { name: 'Confirmar recepción' })).toBeNull();
    const panel = within(dialog).getByRole('region', { name: '¿Llegó otra variante?' });
    const selector = within(panel).getByLabelText('Variante inesperada');
    await waitFor(() => expect(selector).toBeEnabled());
    expect(within(panel).getByRole('button', { name: 'Agregar variante inesperada' })).toBeDisabled();
    const afterCatalog = f.fetch.mock.calls.length;
    fireEvent.change(actualInput(), { target: { value: '00' } });
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Revisá las cantidades');
    expect(within(dialog).getByRole('button', { name: 'Revisar recepción' })).toBeDisabled();
    fireEvent.change(actualInput(), { target: { value: sent } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revisar recepción' }));
    expect(screen.getByRole('dialog', { name: 'Revisar recepción' })).toBe(dialog);
    expect(dialog).toHaveClass('receipt-expected-review');
    expect(dialog).toHaveTextContent('Revisión previa a confirmar');
    const preview = within(dialog).getByRole('table', { name: 'Revisión de cantidades recibidas' });
    const total = within(preview).getByRole('row', { name: /Total: 1 variantes/ });
    expect(within(total).getAllByRole('cell').slice(1, 4).map(cell => cell.textContent)).toEqual([sent, sent, sent]);
    expect(preview).toHaveTextContent('Sin diferencias');
    expect(dialog).toHaveTextContent(`Se acreditarán ${sent} baterías en ${original.destination_location_name} al confirmar.`);
    expect(dialog).toHaveTextContent('No es inventario actual.');
    expect(dialog).toHaveTextContent('Conteo original guardado una sola vez; no se podrá editar.');
    expect(dialog.querySelector('input, select')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Editar cantidades' }));
    expect(screen.getByRole('dialog', { name: 'Registrar cantidades recibidas' })).toBe(dialog);
    expect(actualInput()).toHaveValue(sent);
    expect(original.items[0].quantity).toBe(sent);
    fireEvent.keyDown(actualInput(), { key: 'Escape', isComposing: true }); expect(dialog).toBeInTheDocument();
    fireEvent.keyDown(actualInput(), { key: 'Escape' }); expect(dialog).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(view.container.querySelector('.transfer-receipt > .transfer-cancellation')).not.toHaveAttribute('inert');
    expect(f.fetch.mock.calls).toHaveLength(afterCatalog);
    const reads = f.fetch.mock.calls.slice(before);
    expect(reads).toHaveLength(1);
    expect(String(reads[0][0])).toContain(`location_id=${route.destination}`);
    expect(String(reads[0][0])).toContain('page_size=50');
    expect(reads[0][1]?.method ?? 'GET').toBe('GET');
    expect(posts(f)).toHaveLength(0);
  });
  it.each(receiptRoutes)('never offers receipt or loads destination catalog for $kind origin $origin', async route => {
    const f = fixture(route.origin); f.setRecord(routeRecord(route)); render(<App />); await detail();
    expect(screen.queryByRole('button', { name: /Recibir solicitud|Registrar recepción/ })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(f.fetch.mock.calls.filter(([url]) => String(url).includes('page_size=50'))).toHaveLength(0);
    expect(posts(f)).toHaveLength(0);
  });
});

describe('U3d expected receipt review', () => {
  const pair = { ...transit, items: ['L', 'R'].map((polarity, index) => ({
    ...transit.items[0], variant_id: index + 1, polarity, quantity: '1',
  })) };
  it.each([
    ['matched', '1', ['2', '2', '2'], 'Sin diferencias'],
    ['shortage', '0', ['2', '1', '1'], 'Faltante: 1'],
    ['excess', '2', ['2', '3', '2'], 'Exceso: 1'],
  ])('reviews %s with physical counts and future credit, preserving the draft', async (_kind, right, totals, difference) => {
    const f = fixture(); f.setRecord(pair); render(<App />); await detail(); const dialog = await capture();
    const inputs = within(dialog).getAllByRole('textbox');
    fireEvent.change(inputs[0], { target: { value: '1' } });
    fireEvent.change(inputs[1], { target: { value: right } });
    fireEvent.click(screen.getByRole('button', { name: 'Revisar recepción' }));
    const table = within(dialog).getByRole('table', { name: 'Revisión de cantidades recibidas' });
    expect(within(table).getAllByRole('columnheader').map(cell => cell.textContent)).toEqual([
      'Producto', 'Enviadas', 'Recibidas', 'A acreditar', 'Diferencia',
    ]);
    expect(table).toHaveTextContent('75.125 Ah · Izquierda [L]');
    expect(table).toHaveTextContent('75.125 Ah · Derecha [R]');
    expect(table).toHaveTextContent(difference);
    const total = within(table).getByRole('row', { name: /Total: 2 variantes/ });
    expect(within(total).getAllByRole('cell').slice(1, 4).map(cell => cell.textContent)).toEqual(totals);
    expect(dialog).toHaveTextContent(totals[2] === '1'
      ? 'Se acreditará 1 batería en Sucursal A al confirmar.' : `Se acreditarán ${totals[2]} baterías en Sucursal A al confirmar.`);
    expect(dialog).toHaveTextContent('No es inventario actual.');
    expect(dialog).toHaveTextContent('Conteo original guardado una sola vez; no se podrá editar.');
    expect(dialog).toHaveTextContent('Se acreditará el mínimo recibido/enviado por variante.');
    expect(table.querySelectorAll('.receipt-preview-difference svg')).toHaveLength(2);
    if (right === '0') expect(dialog).toHaveTextContent('El faltante quedará registrado; no se resuelve automáticamente.');
    if (right === '2') expect(dialog).toHaveTextContent('El exceso quedará registrado por separado; no se sumará automáticamente al stock disponible.');
    expect(dialog.querySelector('input, select')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Editar cantidades' }));
    expect(within(dialog).getAllByRole('textbox').map(input => (input as HTMLInputElement).value)).toEqual(['1', right]);
    expect(pair.items.map(item => item.quantity)).toEqual(['1', '1']);
    expect(posts(f)).toHaveLength(0);
  });
  it('sums canonical bigints exactly without netting opposite variant differences', async () => {
    const f = fixture(); f.setRecord({ ...pair, items: pair.items.map(item => ({ ...item, quantity: sent })) });
    render(<App />); await detail(); const dialog = await capture();
    const inputs = within(dialog).getAllByRole('textbox');
    fireEvent.change(inputs[0], { target: { value: (BigInt(sent) - 1n).toString() } });
    fireEvent.change(inputs[1], { target: { value: (BigInt(sent) + 1n).toString() } });
    fireEvent.click(screen.getByRole('button', { name: 'Revisar recepción' }));
    const table = within(dialog).getByRole('table', { name: 'Revisión de cantidades recibidas' });
    const total = within(table).getByRole('row', { name: /Total: 2 variantes/ });
    expect(within(total).getAllByRole('cell').slice(1, 4).map(cell => cell.textContent)).toEqual([
      '18014398509481986', '18014398509481986', '18014398509481985',
    ]);
    expect(total).toHaveTextContent('Faltante: 1'); expect(total).toHaveTextContent('Exceso: 1');
    expect(posts(f)).toHaveLength(0);
  });
  it('reviews unexpected catalog identity with zero future credit', async () => {
    const f = fixture(); render(<App />); await detail(); const dialog = await capture();
    const selector = screen.getByLabelText('Variante inesperada');
    await waitFor(() => expect(selector).toBeEnabled());
    fireEvent.change(selector, { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Agregar variante inesperada' }));
    fireEvent.change(actualInput(), { target: { value: sent } });
    fireEvent.change(screen.getByLabelText(/Cantidad recibida.*Unexpected/), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: 'Revisar recepción' }));
    const table = within(dialog).getByRole('table', { name: 'Revisión de cantidades recibidas' });
    const row = table.querySelector('[data-variant-id="2"]')!;
    expect(row).toHaveTextContent('TOYO Unexpected · 75.125 Ah · Izquierda [L]');
    expect(within(row as HTMLElement).getAllByRole('cell').slice(1, 4).map(cell => cell.textContent)).toEqual(['0', '7', '0']);
    expect(row).toHaveTextContent('No enviada: 7');
    expect(dialog).toHaveTextContent('La variante no enviada quedará registrada por separado; no se acreditará automáticamente al stock disponible ni se resolverá esta diferencia.');
    expect(dialog.querySelector('input, select')).toBeNull();
    expect(posts(f)).toHaveLength(0);
  });
});

describe('U3e unexpected and mixed receipt preview', () => {
  it('uses only the ID and unavailable guidance when no catalog identity is known', () => {
    const record = parseTransferRecord(JSON.stringify(transit));
    const receipt = previewTransferReceipt({ items: [{ variant_id: 1, actual_quantity: '0' }, { variant_id: 2, actual_quantity: '1' }] }, record);
    render(<ReceiptPreview record={record} receipt={receipt} identities={{}} />);
    const row = screen.getByRole('table').querySelector('[data-variant-id="2"]')!;
    expect(row).toHaveTextContent('Variante 2');
    expect(row).toHaveTextContent('Identidad no disponible. Consultá el catálogo del destino.');
    expect(row).not.toHaveTextContent('Ah'); expect(row).not.toHaveTextContent('Izquierda'); expect(row).not.toHaveTextContent('Derecha');
    expect(row).toHaveTextContent('No enviada: 1');
  });
  it.each(receiptRoutes)('preserves $kind from $origin per-variant counts and bigint credit without netting', async route => {
    const f = fixture(route.destination);
    f.setRecord({ ...routeRecord(route), items: [1, 3].map((variant_id, index) => ({
      ...transit.items[0], variant_id, polarity: index ? 'R' : 'L', quantity: sent,
    })) });
    render(<App />); await detail();
    fireEvent.click(await screen.findByRole('button', { name: route.kind === 'request_stock' ? 'Recibir solicitud' : 'Registrar recepción' }));
    const dialog = screen.getByRole('dialog');
    const selector = within(dialog).getByLabelText('Variante inesperada');
    await waitFor(() => expect(selector).toBeEnabled());
    fireEvent.change(selector, { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Agregar variante inesperada' }));
    const inputs = within(dialog).getAllByRole('textbox');
    const values = [(BigInt(sent) - 1n).toString(), (BigInt(sent) + 1n).toString(), '1'];
    inputs.forEach((input, index) => fireEvent.change(input, { target: { value: values[index] } }));
    fireEvent.click(screen.getByRole('button', { name: 'Revisar recepción' }));
    const table = within(dialog).getByRole('table', { name: 'Revisión de cantidades recibidas' });
    expect(table.querySelectorAll('tbody tr')).toHaveLength(3);
    for (const [id, expected] of [[1, [sent, values[0], values[0]]], [3, [sent, values[1], sent]], [2, ['0', '1', '0']]] as const) {
      const row = table.querySelector(`[data-variant-id="${id}"]`) as HTMLElement;
      expect(within(row).getAllByRole('cell').slice(1, 4).map(cell => cell.textContent)).toEqual(expected);
    }
    expect(table).toHaveTextContent('Faltante: 1'); expect(table).toHaveTextContent('Exceso: 1');
    const total = within(table).getByRole('row', { name: /Total: 3 variantes/ });
    expect(within(total).getAllByRole('cell').slice(1, 4).map(cell => cell.textContent)).toEqual([
      '18014398509481986', '18014398509481987', '18014398509481985',
    ]);
    for (const badge of ['Faltante: 1', 'Exceso: 1', 'No enviada: 1']) expect(total).toHaveTextContent(badge);
    expect(table.querySelectorAll('.receipt-preview-difference svg')).toHaveLength(3);
    expect(dialog.querySelector('input, select')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Editar cantidades' }));
    expect(within(dialog).getAllByRole('textbox').map(input => (input as HTMLInputElement).value)).toEqual(values);
    expect(posts(f)).toHaveLength(0);
  });
  it.each(['changed', 'unavailable'])('pins captured destination identity through %s catalog reload and draft editing', async mode => {
    let reload = false;
    let resolve!: (response: Response) => void;
    const job = new Promise<Response>(yes => { resolve = yes; });
    const f = fixture(2, url => reload && url.startsWith('/api/inventory?') ? job : undefined);
    const authority = { ready: true, epoch: 1, session: { authenticated: true,
      identity: { account_id: 2, username: 'receipt-2', location: locations[1] },
      csrf_token: 'c'.repeat(43), expires_at: '2030-01-01T00:00:00Z' } };
    const props = { ownerTag: '1/2/2', controller: { getTransferAuthority: () => authority },
      transfers: {}, record: parseTransferRecord(JSON.stringify({ ...transit, items: [1, 3].map(variant_id => ({
        ...transit.items[0], variant_id, quantity: '1',
      })) })) } as unknown as TransferReceiptProps;
    const view = render(<TransferReceipt {...props} />); const dialog = await capture();
    const selector = within(dialog).getByLabelText('Variante inesperada');
    await waitFor(() => expect(selector).toBeEnabled());
    fireEvent.change(selector, { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Agregar variante inesperada' }));
    within(dialog).getAllByRole('textbox').forEach(input => fireEvent.change(input, { target: { value: '1' } }));
    fireEvent.click(screen.getByRole('button', { name: 'Revisar recepción' }));
    const assertReview = () => {
      const table = within(dialog).getByRole('table', { name: 'Revisión de cantidades recibidas' });
      expect(table).toHaveTextContent('TOYO Unexpected · 75.125 Ah · Izquierda [L]');
      const total = within(table).getByRole('row', { name: /Total: 3 variantes/ });
      expect(within(total).getAllByRole('cell').slice(1, 4).map(cell => cell.textContent)).toEqual(['2', '3', '2']);
      expect(total).toHaveTextContent('No enviada: 1');
      expect(screen.getByRole('button', { name: 'Confirmar recepción' })).toBeEnabled();
    };
    assertReview(); reload = true;
    // Same authority, new getter identity: exercise a passive catalog effect rerun.
    view.rerender(<TransferReceipt {...props} controller={{ ...props.controller, getTransferAuthority: () => authority } as TransferReceiptProps['controller']} />);
    assertReview();
    await act(async () => resolve(mode === 'unavailable' ? reply({}, 503) : reply({
      location: locations[1], page: 1, page_size: 50, total_variants: 1,
      items: [{ variant_id: 2, catalog_entry_id: 2, brand: 'RENAMED', model: 'Replacement', capacity_ah: 100,
        polarity: 'R', existing: 0, reserved: 0, available: 0 }],
    })));
    assertReview(); expect(dialog).not.toHaveTextContent('RENAMED');
    fireEvent.click(screen.getByRole('button', { name: 'Editar cantidades' }));
    expect(screen.getByLabelText(/Cantidad recibida.*Unexpected/)).toHaveValue('1');
    expect(dialog).toHaveTextContent('75.125 Ah'); expect(dialog).toHaveTextContent('Izquierda [L]');
    expect(screen.getByRole('button', { name: 'Revisar recepción' })).toBeEnabled();
    if (mode === 'unavailable') expect(within(dialog).getByRole('alert')).toHaveTextContent('Catálogo del destino no disponible');
    fireEvent.click(screen.getByRole('button', { name: 'Revisar recepción' })); assertReview();
    expect(posts(f)).toHaveLength(0);
  });
});

describe('U3c receipt capture presentation', () => {
  it('shows immutable sent evidence, blank labeled counts and the visible catalog before review', async () => {
    const f = fixture(); render(<App />); await detail(); const dialog = await capture();
    const table = within(dialog).getByRole('table', { name: 'Cantidades recibidas' });
    expect(within(table).getAllByRole('columnheader').map(cell => cell.textContent)).toEqual(['Producto', 'Polaridad', 'Enviadas', 'Recibidas']);
    expect(table).toHaveTextContent('TOYO · Expected'); expect(table).toHaveTextContent('75.125 Ah');
    expect(table).toHaveTextContent('Izquierda [L]'); expect(table).toHaveTextContent(sent);
    expect(actualInput()).toHaveValue(''); expect(actualInput()).toHaveAttribute('placeholder', 'Cantidad');
    expect(actualInput()).toHaveAttribute('aria-describedby', 'receipt-capture-rules');
    expect(within(dialog).getByRole('button', { name: 'Revisar recepción' })).toBeDisabled();
    expect(within(dialog).queryByRole('button', { name: 'Confirmar recepción' })).toBeNull();
    const catalog = within(dialog).getByRole('region', { name: '¿Llegó otra variante?' });
    expect(within(catalog).getByLabelText('Variante inesperada')).toBeVisible();
    expect(within(catalog).getByRole('button', { name: 'Agregar variante inesperada' })).toBeDisabled();
    expect(dialog).toHaveTextContent('Usá 0 si una variante no llegó.');
    expect(dialog).toHaveTextContent('Todavía no se modifica el stock. Primero revisarás el conteo.');
    expect(posts(f)).toHaveLength(0);
  });
  it.each(['00', '+1', '-1', '1.0', '1e2', '9223372036854775808', '0'])('explains invalid complete capture %s without allowing review', async value => {
    const f = fixture(); render(<App />); await detail(); const dialog = await capture();
    fireEvent.change(actualInput(), { target: { value } });
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Revisá las cantidades');
    expect(screen.getByRole('button', { name: 'Revisar recepción' })).toBeDisabled();
    fireEvent.change(actualInput(), { target: { value: sent } });
    expect(within(dialog).queryByText(/Revisá las cantidades/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Revisar recepción' })).toBeEnabled();
    expect(posts(f)).toHaveLength(0);
  });
  it('retains visible loading/unavailable guidance and still permits expected-only review', async () => {
    let resolve!: (value: Response) => void;
    const job = new Promise<Response>(yes => { resolve = yes; });
    const f = fixture(2, url => url.startsWith('/api/inventory?') && url.includes('page_size=50') ? job : undefined);
    render(<App />); await detail(); const dialog = await capture();
    const panel = within(dialog).getByRole('region', { name: '¿Llegó otra variante?' });
    expect(within(panel).getByRole('status')).toHaveTextContent('Consultando catálogo');
    expect(within(panel).getByLabelText('Variante inesperada')).toBeDisabled();
    await act(async () => resolve(reply({ error: 'service_unavailable' }, 503)));
    expect(within(panel).getByRole('alert')).toHaveTextContent('Catálogo del destino no disponible');
    fireEvent.change(actualInput(), { target: { value: sent } });
    expect(screen.getByRole('button', { name: 'Revisar recepción' })).toBeEnabled();
    expect(posts(f)).toHaveLength(0);
  });
  it('uses real catalog identity for added rows, excludes duplicates, removes and preserves the draft on edit', async () => {
    const f = fixture(); render(<App />); await detail(); const dialog = await capture();
    const selector = within(dialog).getByLabelText('Variante inesperada');
    await waitFor(() => expect(selector).toBeEnabled());
    expect(within(selector).queryByRole('option', { name: /Expected/ })).toBeNull();
    fireEvent.change(selector, { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Agregar variante inesperada' }));
    const table = within(dialog).getByRole('table', { name: 'Cantidades recibidas' });
    expect(table).toHaveTextContent('TOYO · Unexpected'); expect(table).toHaveTextContent('75.125 Ah');
    expect(within(selector).queryByRole('option', { name: /Unexpected/ })).toBeNull();
    expect(screen.getByLabelText(/Cantidad recibida.*Unexpected/)).toHaveValue('');
    fireEvent.change(actualInput(), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText(/Cantidad recibida.*Unexpected/), { target: { value: '0' } });
    expect(screen.getByRole('button', { name: 'Revisar recepción' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Cantidad recibida.*Unexpected/), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: 'Revisar recepción' }));
    fireEvent.click(screen.getByRole('button', { name: 'Editar cantidades' }));
    expect(actualInput()).toHaveValue('0'); expect(screen.getByLabelText(/Cantidad recibida.*Unexpected/)).toHaveValue('7');
    fireEvent.click(screen.getByRole('button', { name: /Quitar variante inesperada/ }));
    expect(within(dialog).getByRole('table', { name: 'Cantidades recibidas' })).not.toHaveTextContent('Unexpected');
    expect(within(screen.getByLabelText('Variante inesperada')).getByRole('option', { name: /Unexpected/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revisar recepción' })).toBeDisabled();
    expect(posts(f)).toHaveLength(0);
  });
});

describe('U3b receipt modal foundation', () => {
  it('names each step, keeps the physical route and preserves the complete draft when editing', async () => {
    const f = fixture(); render(<App />); await detail();
    const dialog = await capture();
    expect(dialog).toHaveClass('transfer-receipt-modal');
    expect(dialog).toHaveTextContent('TR-001 · Almacén → Sucursal A');
    expect(dialog).toHaveTextContent('Conteo · Luego revisarás la recepción');
    expect(actualInput()).toHaveValue('');
    const selector = screen.getByLabelText('Variante inesperada');
    await waitFor(() => expect(selector).toBeEnabled());
    fireEvent.change(actualInput(), { target: { value: sent } });
    fireEvent.change(selector, { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Agregar variante inesperada' }));
    fireEvent.change(screen.getByLabelText(/Cantidad recibida.*Unexpected/), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: 'Revisar recepción' }));
    expect(screen.getByRole('dialog', { name: 'Revisar recepción' })).toBe(dialog);
    expect(dialog).toHaveTextContent('Revisión previa a confirmar');
    expect(dialog.querySelector('input, select')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Editar cantidades' }));
    expect(screen.getByRole('dialog', { name: 'Registrar cantidades recibidas' })).toBe(dialog);
    expect(actualInput()).toHaveValue(sent);
    expect(screen.getByLabelText(/Cantidad recibida.*Unexpected/)).toHaveValue('7');
    expect(posts(f)).toHaveLength(0);
  });
  it.each(['escape', 'close', 'back', 'unmount'] as const)('restores dynamic background attributes before focus on %s', async method => {
    const f = fixture(); const view = render(<App />); await detail();
    const trigger = screen.getByRole('button', { name: 'Recibir solicitud' });
    const background = view.container.querySelector('.transfer-receipt > .transfer-cancellation')!;
    const prior = document.createElement('aside'); prior.setAttribute('inert', 'retained'); document.body.append(prior);
    const dynamic = document.createElement('button'); dynamic.textContent = 'Dynamic background';
    try {
      const dialog = await capture();
      expect(background).toHaveAttribute('inert');
      document.querySelector('.transfer-receipt')!.prepend(dynamic);
      await waitFor(() => expect(dynamic).toHaveAttribute('inert'));
      const restored = vi.fn(() => expect(background).not.toHaveAttribute('inert'));
      trigger.addEventListener('focus', restored);
      if (method === 'escape') fireEvent.keyDown(actualInput(), { key: 'Escape' });
      if (method === 'close') fireEvent.click(within(dialog).getByRole('button', { name: 'Cerrar confirmación de recepción' }));
      if (method === 'back') fireEvent.click(within(dialog).getByRole('button', { name: 'Volver al detalle' }));
      if (method === 'unmount') view.unmount();
      expect(prior).toHaveAttribute('inert', 'retained');
      expect(dynamic).not.toHaveAttribute('inert');
      expect(background).not.toHaveAttribute('inert');
      if (method !== 'unmount') { expect(trigger).toHaveFocus(); expect(restored).toHaveBeenCalled(); }
      else expect(restored).not.toHaveBeenCalled();
      expect(posts(f)).toHaveLength(0);
    } finally { prior.remove(); dynamic.remove(); }
  });

  it('cleans up isolation without returning stale focus after catalog authority loss', async () => {
    let resolve!: (value: Response) => void;
    const job = new Promise<Response>(yes => { resolve = yes; });
    fixture(2, url => url.startsWith('/api/inventory?') && url.includes('page_size=50') ? job
      : url === '/api/auth/validate' ? Promise.resolve(reply({ authenticated: false })) : undefined);
    const view = render(<App />); await detail();
    const trigger = screen.getByRole('button', { name: 'Recibir solicitud' });
    const dialog = await capture();
    const background = view.container.querySelector('.transfer-receipt > .transfer-cancellation')!;
    expect(background).toHaveAttribute('inert');
    const restoration = vi.spyOn(trigger, 'focus');
    await act(async () => resolve(reply({ error: 'unauthorized' }, 401)));
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(background).not.toHaveAttribute('inert');
    expect(view.container).not.toHaveAttribute('inert');
    expect(restoration).not.toHaveBeenCalled();
  });
  it('wraps Tab around enabled inputs, selects and textareas without intercepting interior controls or composing Escape', async () => {
    fixture(); render(<App />); await detail(); const dialog = await capture();
    const first = within(dialog).getByRole('button', { name: 'Cerrar confirmación de recepción' });
    const last = within(dialog).getByRole('button', { name: 'Volver al detalle' });
    const selector = screen.getByLabelText('Variante inesperada');
    await waitFor(() => expect(selector).toBeEnabled());
    for (const control of [actualInput(), selector]) {
      control.focus(); fireEvent.keyDown(control, { key: 'Tab' }); expect(control).toHaveFocus();
    }
    first.focus(); fireEvent.keyDown(first, { key: 'Tab', shiftKey: true }); expect(last).toHaveFocus();
    last.focus(); fireEvent.keyDown(last, { key: 'Tab' }); expect(first).toHaveFocus();
    const textarea = document.createElement('textarea'); dialog.append(textarea);
    try {
      first.focus(); fireEvent.keyDown(first, { key: 'Tab', shiftKey: true }); expect(textarea).toHaveFocus();
      fireEvent.keyDown(textarea, { key: 'Tab' }); expect(first).toHaveFocus();
      fireEvent.keyDown(actualInput(), { key: 'Escape', isComposing: true }); expect(dialog).toBeInTheDocument();
      fireEvent.keyDown(selector, { key: 'Escape' }); expect(dialog).not.toBeInTheDocument();
    } finally { textarea.remove(); }
  });
});

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
    const dialog = screen.getByRole('dialog', { name: 'Revisar recepción' });
    expect(dialog).toHaveTextContent('Exceso'); expect(dialog).toHaveTextContent(sent);
    expect(dialog).toHaveTextContent('disponible'); expect(posts(f)).toHaveLength(0);
    expect(dialog).toHaveTextContent('Se acreditará el mínimo recibido/enviado por variante.');
    expect(dialog).toHaveTextContent('El exceso quedará registrado por separado; no se sumará automáticamente al stock disponible.');
    expect(dialog).toHaveTextContent('Conteo original guardado una sola vez; no se podrá editar.');
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
    fireEvent.click(within(dialog).getByRole('button', { name: 'Volver al detalle' }));
    expect(screen.queryByRole('region', { name: 'Historial de la solicitud' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Ver historial' }));
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
    expect(dialog).toHaveTextContent('Faltante'); expect(dialog).toHaveTextContent('No enviada: 7');
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
    const recovery = screen.getByRole('region', { name: 'Recuperación de recepción' });
    await waitFor(() => expect(recovery).toHaveAttribute('inert'));
    expect(dialog).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'Tab' }); expect(dialog).toHaveFocus();
    expect(within(dialog).queryByText('Recepción registrada correctamente.')).not.toBeInTheDocument();
    await act(async () => { resolve(reply(outcome())); }); await screen.findByRole('heading', { name: 'Recepción confirmada', level: 2 });
    expect(recovery).toHaveAttribute('inert');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Volver al detalle' }));
    expect(recovery).not.toHaveAttribute('inert');
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
    await waitFor(() => expect(screen.getByRole('region', { name: 'Recuperación de recepción' })).toHaveAttribute('inert'));
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
