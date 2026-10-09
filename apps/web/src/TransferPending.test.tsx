import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TransferPending, { transferViewOwner } from './TransferPending';
import TransferReview from './TransferReview';
import { parseTransferRecord, transferDirection } from './transferModel';
import type { RecoverySnapshot } from './transferRecovery';
import type { TransferAuthority, TransferController } from './useInventory';

const locations = ['Almacén', 'Sucursal A', 'Sucursal B'];
function authority(id = 2, epoch = 1, token = 'a'.repeat(43)): TransferAuthority {
  return { epoch, ready: true, session: { authenticated: true, csrf_token: token,
    identity: { account_id: id, username: `test-${id}`, location: { id, name: locations[id - 1] } }, expires_at: '2030-01-01T00:00:00Z' } };
}
function wire(origin = 1, destination = 2, id = '9007199254740993') {
  const creator = destination === 1 ? origin : destination;
  return { id, reference: `TR-${id.padStart(3, '0')}`, kind: destination === 1 ? 'send_to_warehouse' : 'request_stock', status: 'pending',
    created_at: '2028-01-01T00:00:00.123456789Z', creator_location_id: creator, creator_location_name: locations[creator - 1],
    origin_location_id: origin, origin_location_name: locations[origin - 1], destination_location_id: destination, destination_location_name: locations[destination - 1],
    approver_location_id: destination === 1 ? 1 : origin, approver_location_name: locations[(destination === 1 ? 1 : origin) - 1],
    items: [1, 2].map(variant_id => ({ variant_id, brand: 'TOYO', model: `Exact-${variant_id}`, capacity_ah: '75.125', polarity: variant_id === 1 ? 'L' : 'R', quantity: '9223372036854775807' })) };
}
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function deferred() {
  let resolve!: (value: Response) => void;
  let reject!: (value: Error) => void;
  const promise = new Promise<Response>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(id = 2, override?: (url: string, init: RequestInit) => Promise<Response> | undefined) {
  const env = { current: authority(id), record: wire(), count: '9007199254740993' };
  const listeners = new Set<() => void>();
  const controller: TransferController = {
    get authorityEpoch() { return env.current.epoch; },
    getTransferAuthority: () => env.current,
    subscribeTransferInvalidation: callback => { listeners.add(callback); return () => { listeners.delete(callback); }; },
    settleUnauthorized: vi.fn(async () => 'unavailable' as const),
  };
  const fetch = vi.fn((input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = String(input); const custom = override?.(url, init); if (custom) return custom;
    if (url.startsWith('/api/transfers?')) {
      const query = new URL(url, 'http://localhost').searchParams;
      const page = Number(query.get('page')); const size = Number(query.get('page_size'));
      const remaining = BigInt(env.count) - BigInt(page - 1) * BigInt(size);
      const length = remaining <= 0n ? 0 : remaining > BigInt(size) ? size : Number(remaining);
      const records = Array.from({ length }, (_, index) => {
        const recordID = (BigInt(env.record.id) - BigInt(index)).toString();
        return { ...env.record, id: recordID, reference: `TR-${recordID.padStart(3, '0')}` };
      });
      return Promise.resolve(reply({ page, page_size: size, status: 'pending', total_count: env.count, records }));
    }
    if (url === `/api/transfers/${env.record.id}`) return Promise.resolve(reply(env.record));
    throw new Error('Unexpected test route');
  });
  vi.stubGlobal('fetch', fetch);
  const back = vi.fn();
  const ownerTag = transferViewOwner(env.current)!;
  const element = (initialDetail?: { ownerTag: string; id: string }) => <TransferPending controller={controller} ownerTag={ownerTag} initialDetail={initialDetail} onInventory={back} />;
  return { env, controller, listeners, fetch, back, ownerTag, element };
}
const calls = (f: ReturnType<typeof fixture>, detail = false) => f.fetch.mock.calls.filter(([url]) => String(url).startsWith(detail ? '/api/transfers/' : '/api/transfers?'));
const isPassive = (call: [RequestInfo | URL, RequestInit?]) => new Headers(call[1]?.headers).get('X-Luson-Passive') === '1';
async function loaded() { await screen.findByText('9007199254740993 solicitudes pendientes'); }
async function detail() { fireEvent.click(screen.getByRole('button', { name: 'Ver detalle TR-9007199254740993' })); await screen.findByRole('heading', { name: 'TR-9007199254740993' }); }
afterEach(() => { vi.unstubAllGlobals(); });

describe('R05-U1 list creation entry', () => {
  it.each([1, 2, 3])('offers creation only on the assigned branch %s list, never detail', async id => {
    const f = fixture(id); if (id === 3) f.env.record = wire(2, 3);
    const create = vi.fn();
    render(<TransferPending controller={f.controller} ownerTag={f.ownerTag} onInventory={f.back} creationAvailable onCreate={create} />);
    await loaded();
    if (id === 1) expect(screen.queryByRole('button', { name: 'Nueva transferencia' })).not.toBeInTheDocument();
    else {
      fireEvent.click(screen.getByRole('button', { name: 'Nueva transferencia' }));
      expect(create).toHaveBeenCalledOnce();
    }
    await detail();
    expect(screen.queryByRole('button', { name: 'Nueva transferencia' })).not.toBeInTheDocument();
    expect(f.fetch.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  });
  it.each(['unready', 'epoch', 'warehouse', 'unavailable'])('blocks retained creation callbacks for %s', async mode => {
    const f = fixture(); const create = vi.fn();
    render(<TransferPending controller={f.controller} ownerTag={f.ownerTag} onInventory={f.back} creationAvailable={mode !== 'unavailable'} onCreate={create} />);
    await loaded(); const button = screen.getByRole('button', { name: 'Nueva transferencia' });
    if (mode === 'unready') f.env.current = { ...f.env.current, ready: false };
    else if (mode === 'epoch') f.env.current = authority(2, 2);
    else if (mode === 'warehouse') f.env.current = authority(1, 2);
    fireEvent.click(button); expect(create).not.toHaveBeenCalled();
  });
});

describe('R04c participant Pending', () => {
  it.each([1, 2, 3])('uses assigned participant %s, exact count and unbounded units, not page length', async id => {
    const f = fixture(id); if (id === 3) f.env.record = wire(2, 3);
    render(f.element()); await loaded();
    const table = screen.getByRole('table', { name: 'Solicitudes pendientes participantes' });
    expect(table).toHaveTextContent('18446744073709551614');
    expect(table).toHaveTextContent('Pendiente de aprobación');
    expect(table).toHaveTextContent('Requiere aprobación de');
    expect(calls(f)).toHaveLength(1); expect(isPassive(calls(f)[0])).toBe(true);
    expect(screen.queryByText('1 solicitudes pendientes')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Aprobar|Rechazar|Cancelar|Despachar/ })).not.toBeInTheDocument();
  });
  it.each([[1, 2, 'Solicitud a Almacén'], [2, 3, 'Solicitud entre sucursales'], [2, 1, 'Propuesta de envío a Almacén']])('labels physical route %s to %s honestly', async (origin, destination, label) => {
    const f = fixture(2); f.env.record = wire(Number(origin), Number(destination)); render(f.element()); await loaded();
    expect(screen.getByRole('table')).toHaveTextContent(String(label)); await detail();
    expect(screen.getByRole('region', { name: 'Ruta física' })).toHaveTextContent(`Origen${locations[Number(origin) - 1]}→Destino${locations[Number(destination) - 1]}`);
    expect(screen.getByLabelText('Resumen de solicitud')).toHaveTextContent('Esta solicitud todavía no reserva ni mueve stock.');
  });
  it('keeps exact Ah, nanosecond UTC, quantities and physical creator/approver in detail', async () => {
    const f = fixture(); render(f.element()); await loaded(); await detail();
    const items = screen.getByRole('table', { name: 'Baterías solicitadas' });
    expect(items).toHaveTextContent('75.125 Ah'); expect(items).toHaveTextContent('Izquierda [L]'); expect(items).toHaveTextContent('Derecha [R]');
    expect(within(items).getAllByText('9223372036854775807')).toHaveLength(2);
    expect(screen.getByText('2028-01-01T00:00:00.123456789Z')).toBeVisible();
    expect(screen.getByLabelText('Resumen de solicitud')).toHaveTextContent('Ubicación creadoraSucursal A');
    expect(screen.queryByText(/Existencias|Reservadas|Historial|Empleado/)).not.toBeInTheDocument();
    expect(isPassive(calls(f, true)[0])).toBe(false);
    expect(calls(f, true)[0][1]).toMatchObject({ credentials: 'same-origin', cache: 'no-store', method: 'GET' });
  });
  it('does not invent zero while loading or echo selected ID before detail validation', async () => {
    const list = deferred(); const item = deferred();
    const f = fixture(2, url => url.startsWith('/api/transfers?') ? list.promise : item.promise);
    render(f.element({ ownerTag: f.ownerTag, id: '123456789' }));
    expect(screen.queryByText('0 solicitudes pendientes')).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('123456789');
    await waitFor(() => expect(calls(f, true)).toHaveLength(1));
    expect(isPassive(calls(f, true)[0])).toBe(false);
    item.resolve(reply({ error: 'not_found' }, 404));
    expect(await screen.findByText('La solicitud no está disponible.')).toBeVisible();
    expect(document.body).not.toHaveTextContent('123456789');
    list.resolve(reply({ page: 1, page_size: 25, status: 'pending', total_count: '0', records: [] }));
    expect(await screen.findByText('0 solicitudes pendientes')).toBeVisible();
  });
  it.each(['private-third-account', 'unknown-id'])('uses identical generic 404 presentation for %s', async () => {
    const f = fixture(3, url => url.startsWith('/api/transfers/') ? Promise.resolve(reply({ error: 'not_found' }, 404))
      : Promise.resolve(reply({ page: 1, page_size: 25, status: 'pending', total_count: '0', records: [] })));
    render(f.element({ ownerTag: f.ownerTag, id: '999999999' }));
    expect(await screen.findByText('La solicitud no está disponible.')).toBeVisible();
    expect(document.body).not.toHaveTextContent('999999999'); expect(document.body).not.toHaveTextContent('TR-');
  });
  it('rejects nonparticipant records instead of constructing private activity', async () => {
    const f = fixture(3); render(f.element());
    expect(await screen.findByText('No se pudieron consultar las solicitudes.')).toBeVisible();
    expect(document.body).not.toHaveTextContent('9007199254740993');
  });
  it.each([10, 25, 50])('uses admitted size %s, manual paging, exact count bounds and detail-back query retention', async size => {
    const f = fixture(); render(f.element()); await loaded();
    fireEvent.change(screen.getByLabelText('Solicitudes por página'), { target: { value: String(size) } });
    await waitFor(() => expect(calls(f).at(-1)![0]).toContain(`page_size=${size}`));
    await loaded(); fireEvent.click(screen.getByRole('button', { name: 'Siguiente pendientes' }));
    await screen.findByText('Página 2'); await loaded();
    expect(String(calls(f).at(-1)![0])).toContain('page=2'); expect(isPassive(calls(f).at(-1)!)).toBe(false);
    await detail(); fireEvent.click(screen.getByRole('button', { name: 'Volver a pendientes' }));
    expect(screen.getByLabelText('Solicitudes por página')).toHaveValue(String(size)); expect(screen.getByText('Página 2')).toBeVisible();
    fireEvent.change(screen.getByLabelText('Solicitudes por página'), { target: { value: String(size === 50 ? 10 : 50) } });
    await screen.findByText('Página 1');
  });
  it('bounds next by BigInt count and never mistakes an empty out-of-range page for zero', async () => {
    const f = fixture(2, url => {
      if (!url.startsWith('/api/transfers?')) return undefined;
      const page = Number(new URL(url, 'http://localhost').searchParams.get('page'));
      const records = page === 1 ? Array.from({ length: 25 }, (_, i) => wire(1, 2, String(100 - i))) : [];
      return Promise.resolve(reply({ page, page_size: 25, status: 'pending', total_count: page === 1 ? '26' : '1', records }));
    });
    render(f.element()); await screen.findByText('26 solicitudes pendientes');
    expect(screen.queryByText('No hay solicitudes pendientes para tu ubicación.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Anterior pendientes' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Siguiente pendientes' })); await screen.findByText('Página 2');
    await screen.findByText('1 solicitudes pendientes');
    expect(screen.getByRole('button', { name: 'Siguiente pendientes' })).toBeDisabled();
    expect(screen.queryByText('No hay solicitudes pendientes para tu ubicación.')).not.toBeInTheDocument();
  });
  it('admits page one million without rounding counts, bounds next and rejects invalid human pages', async () => {
    const f = fixture(); render(f.element()); await loaded();
    for (const value of ['0', '1000001', '-1', '1.5', '01', 'Infinity']) {
      const before = calls(f).length;
      fireEvent.change(screen.getByLabelText('Ir a página'), { target: { value } });
      fireEvent.click(screen.getByRole('button', { name: 'Consultar página' })); expect(calls(f)).toHaveLength(before);
    }
    fireEvent.change(screen.getByLabelText('Ir a página'), { target: { value: '1000000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Consultar página' }));
    await screen.findByText('Página 1000000'); await loaded();
    expect(screen.getByRole('button', { name: 'Siguiente pendientes' })).toBeDisabled();
    expect(String(calls(f).at(-1)![0])).toContain('page=1000000'); expect(isPassive(calls(f).at(-1)!)).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Anterior pendientes' })); await screen.findByText('Página 999999');
  });
  it('handles sanitized unknown failures and explicit retry without leaking raw messages', async () => {
    let fails = true;
    const f = fixture(2, () => fails ? Promise.reject(new Error('SECRET requested id 777')) : undefined);
    render(f.element()); await screen.findByText('No se pudieron consultar las solicitudes.');
    expect(document.body).not.toHaveTextContent('SECRET'); fails = false;
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar pendientes' })); await loaded();
    expect(isPassive(calls(f).at(-1)!)).toBe(false);
  });
  it.each(['unready', 'account', 'csrf', 'epoch'])('masks raw data and blocks stale handlers synchronously on %s', async mode => {
    const f = fixture(); const view = render(f.element()); await loaded(); await detail();
    const back = screen.getByRole('button', { name: 'Volver al inventario' });
    if (mode === 'unready') f.env.current = { ...f.env.current, ready: false };
    else f.env.current = authority(mode === 'account' ? 3 : 2, 2, mode === 'csrf' ? 'b'.repeat(43) : 'a'.repeat(43));
    fireEvent.click(back); expect(f.back).not.toHaveBeenCalled();
    view.rerender(f.element());
    expect(document.body).not.toHaveTextContent('TR-9007199254740993');
    expect(document.body).not.toHaveTextContent('18446744073709551614');
    expect(document.body).not.toHaveTextContent('75.125');
    const before = calls(f, true).length;
    await act(async () => { for (const listener of f.listeners) listener(); });
    expect(calls(f, true)).toHaveLength(before);
  });
  it('blocks a retained row-detail handler before requesting its ID under a different current actor', async () => {
    const f = fixture(); render(f.element()); await loaded();
    const button = screen.getByRole('button', { name: 'Ver detalle TR-9007199254740993' });
    f.env.current = authority(3, 2); fireEvent.click(button);
    await act(async () => {}); expect(calls(f, true)).toHaveLength(0);
  });
  it('checks initial-detail owner before reading its ID or requesting under a new actor', async () => {
    const f = fixture(3);
    const initial = { ownerTag: '1/2/2', get id(): string { throw new Error('Old owner ID accessed'); } };
    render(f.element(initial)); await screen.findByText('No se pudieron consultar las solicitudes.');
    expect(calls(f, true)).toHaveLength(0);
  });
  it.each(['success', 'error'])('ignores late old-owner detail %s after authority switch', async outcome => {
    const item = deferred(); const f = fixture(2, url => url.startsWith('/api/transfers/') ? item.promise : undefined);
    const view = render(f.element()); await loaded(); fireEvent.click(screen.getByRole('button', { name: 'Ver detalle TR-9007199254740993' }));
    await waitFor(() => expect(calls(f, true)).toHaveLength(1));
    f.env.current = authority(3, 2); view.rerender(f.element());
    await act(async () => { if (outcome === 'success') item.resolve(reply(f.env.record)); else item.reject(new Error('OLD PRIVATE FAILURE')); });
    expect(document.body).not.toHaveTextContent('TR-9007199254740993'); expect(document.body).not.toHaveTextContent('OLD PRIVATE FAILURE');
    expect(calls(f, true)).toHaveLength(1);
  });
  it('invalidates both active lanes passively and coalesces a dirty detail flight', async () => {
    let next: ReturnType<typeof deferred> | null = null;
    const f = fixture(2, url => url.startsWith('/api/transfers/') && next ? next.promise : undefined);
    render(f.element()); await loaded(); await detail();
    const beforeList = calls(f).length; const beforeDetail = calls(f, true).length;
    next = deferred();
    act(() => { for (const listener of f.listeners) listener(); });
    await waitFor(() => expect(calls(f, true)).toHaveLength(beforeDetail + 1));
    expect(calls(f)).toHaveLength(beforeList + 1);
    act(() => { for (const listener of f.listeners) { listener(); listener(); } });
    const flight = next; next = null;
    await act(async () => { flight!.resolve(reply({ ...f.env.record, reference: 'TR-999' })); });
    await waitFor(() => expect(calls(f, true)).toHaveLength(beforeDetail + 2));
    expect(screen.queryByRole('heading', { name: 'TR-999' })).not.toBeInTheDocument();
    for (const call of calls(f, true).slice(beforeDetail)) expect(isPassive(call)).toBe(true);
    expect(screen.getByRole('heading', { name: 'TR-9007199254740993' })).toBeVisible();
  });
  it.each(['current', 'unready', 'account', 'csrfEpoch'])('guards the optional success detail callback against latest %s authority', async mode => {
    const f = fixture(); const navigate = vi.fn();
    const snapshot: RecoverySnapshot = { epoch: 1, phase: 'ready', handle: {},
      attempt: { kind: 'request_stock', counterparty_location_id: 1, retry_key: 'test_review_stable_key', items: [{ variant_id: 1, quantity: '1' }] },
      direction: transferDirection(2, 'requestWarehouse'), items: [{ variant_id: 1, catalog_entry_id: 1, brand: 'TOYO', model: 'Exact-1', capacity_ah: '75.125', polarity: 'L', quantity: '1' }] };
    const result = { record: parseTransferRecord(JSON.stringify(f.env.record)), replayed: false };
    render(<TransferReview controller={f.controller} metadata={{ locations: locations.map((name, index) => ({ id: index + 1, name })), brands: ['TOYO'] }}
      ownerTag={f.ownerTag} snapshot={snapshot} result={result} busy={false} error="" returnFocus={null}
      onBack={vi.fn()} onClose={vi.fn()} onEdit={vi.fn()} onSend={vi.fn()} onDetail={navigate} />);
    const button = screen.getByRole('button', { name: 'Ver detalle' });
    if (mode === 'unready') f.env.current = { ...f.env.current, ready: false };
    else if (mode === 'account') f.env.current = authority(3, 2);
    else if (mode === 'csrfEpoch') f.env.current = authority(2, 2, 'b'.repeat(43));
    // Change current getter before any rerender/effect, then invoke the retained handler.
    fireEvent.click(button);
    if (mode === 'current') expect(navigate).toHaveBeenCalledExactlyOnceWith('9007199254740993');
    else expect(navigate).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it('renders warehouse-only cards and retains branch desktop table independently of viewport', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    const w = fixture(1); const view = render(w.element()); await loaded();
    expect(document.querySelector('.pending-cards')).toHaveTextContent('Ubicación creadora: Sucursal A');
    expect(document.querySelector('.pending-cards')).toHaveTextContent('75.125 Ah'); view.unmount();
    const a = fixture(2); render(a.element()); await loaded();
    expect(document.querySelector('.pending-cards')).toBeNull(); expect(screen.getByRole('table')).toBeVisible();
  });
});
