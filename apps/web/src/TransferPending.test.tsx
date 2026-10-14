import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TransferPending, { transferViewOwner } from './TransferPending';
import TransferReview from './TransferReview';
import { parseTransferRecord, transferDirection } from './transferModel';
import type { RecoverySnapshot } from './transferRecovery';
import type { TransferAuthority } from './useInventory';
import type { DetailController } from './TransferDetail';
import { createTransferDecisionRecovery, decisionOwner } from './transferDecisionRecovery';
import { createTransferCountCorrectionRecovery } from './transferCountCorrectionRecovery';
import type { CountDecisionInput, CountProposalInput } from './transferCountCorrectionModel';
import App from './App';
import { createTransferReceiptRecovery } from './transferReceiptRecovery';
import { createTransferRestitutionRecovery } from './transferRestitutionRecovery';
import { createTransferDispatchRecovery } from './transferDispatchRecovery';

const locations = ['Almacén', 'Sucursal A', 'Sucursal B'];
function authority(id = 2, epoch = 1, token = 'a'.repeat(43)): TransferAuthority {
  return { epoch, ready: true, session: { authenticated: true, csrf_token: token,
    identity: { account_id: id, username: `test-${id}`, location: { id, name: locations[id - 1] } }, expires_at: '2030-01-01T00:00:00Z' } };
}
function wire(origin = 1, destination = 2, id = '9007199254740993', status = 'pending') {
  const creator = destination === 1 ? origin : destination;
  return { id, reference: `TR-${id.padStart(3, '0')}`, kind: destination === 1 ? 'send_to_warehouse' : 'request_stock', status,
    ...(status === 'pending' ? {} : { decision_location_id: destination === 1 ? 1 : origin, decided_at: '2028-01-02T00:00:00.000000001Z' }),
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
  const env = { current: authority(id), record: wire(), count: '9007199254740993',
    counts: { pending_total: '9007199254740995', action_count: '9007199254740994' } };
  const listeners = new Set<() => void>();
  const sourceListeners = new Set<() => void>();
  const controller: DetailController = {
    get authorityEpoch() { return env.current.epoch; },
    getTransferAuthority: () => env.current,
    subscribeTransferInvalidation: callback => { listeners.add(callback); return () => { listeners.delete(callback); }; },
    settleUnauthorized: vi.fn(async () => 'unavailable' as const),
    decisionRecovery: createTransferDecisionRecovery(),
    subscribeSourceInventoryInvalidation: callback => { sourceListeners.add(callback); return () => { sourceListeners.delete(callback); }; },
    confirmTransferDecision: vi.fn((_owner, status) => {
      for (const listener of listeners) listener();
      if (status === 'approved') for (const listener of sourceListeners) listener();
    }),
  };
  const fetch = vi.fn((input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = String(input); const custom = override?.(url, init); if (custom) return custom;
    if (url === '/api/transfers/counts') return Promise.resolve(reply(env.counts));
    if (url.startsWith('/api/transfers?')) {
      const query = new URL(url, 'http://localhost').searchParams;
      const page = Number(query.get('page')); const size = Number(query.get('page_size'));
      const remaining = BigInt(env.count) - BigInt(page - 1) * BigInt(size);
      const length = remaining <= 0n ? 0 : remaining > BigInt(size) ? size : Number(remaining);
      const records = Array.from({ length }, (_, index) => {
        const recordID = (BigInt(env.record.id) - BigInt(index)).toString();
        return wire(env.record.origin_location_id, env.record.destination_location_id, recordID, query.get('status') ?? 'pending');
      });
      return Promise.resolve(reply({ page, page_size: size, status: query.get('status'), total_count: env.count, records }));
    }
    if (url.startsWith('/api/inventory?')) {
      const location = Number(new URL(url, 'http://localhost').searchParams.get('location_id'));
      return Promise.resolve(reply({ location: { id: location, name: locations[location - 1] }, page: 1, page_size: 50, total_variants: 0, items: [] }));
    }
    if (init.method === 'POST') {
      env.record = wire(env.record.origin_location_id, env.record.destination_location_id, env.record.id, url.endsWith('/approve') ? 'approved' : 'rejected');
      return Promise.resolve(reply(env.record));
    }
    if (url === `/api/transfers/${env.record.id}`) return Promise.resolve(reply(env.record));
    throw new Error('Unexpected test route');
  });
  vi.stubGlobal('fetch', fetch);
  const back = vi.fn();
  const ownerTag = transferViewOwner(env.current)!;
  const element = (initialDetail?: { ownerTag: string; id: string }) => <TransferPending controller={controller} ownerTag={ownerTag} initialDetail={initialDetail} onInventory={back} />;
  return { env, controller, listeners, sourceListeners, fetch, back, ownerTag, element };
}
const calls = (f: ReturnType<typeof fixture>, detail = false) => f.fetch.mock.calls.filter(([url]) => detail
  ? /^\/api\/transfers\/[1-9][0-9]*$/.test(String(url)) : String(url).startsWith('/api/transfers?'));
const countCalls = (f: ReturnType<typeof fixture>) => f.fetch.mock.calls.filter(([url]) => url === '/api/transfers/counts');
const isPassive = (call: [RequestInfo | URL, RequestInit?]) => new Headers(call[1]?.headers).get('X-Luson-Passive') === '1';
async function loaded() { await screen.findByText('9007199254740993 solicitudes pendientes'); }
async function detail() { fireEvent.click(screen.getByRole('button', { name: 'Ver detalle TR-9007199254740993' })); await screen.findByRole('heading', { name: 'TR-9007199254740993' }); }
afterEach(() => { vi.unstubAllGlobals(); });

const correctionStamp = '2028-01-03T00:00:00.000000001Z';
function receivedWire(origin = 1, destination = 2) {
  const original = wire(origin, destination, '9007199254740993', 'approved');
  return { ...original, status: 'received', dispatch_location_id: origin, dispatched_at: correctionStamp,
    receipt_location_id: destination, received_at: correctionStamp,
    receipt: { items: original.items.map(item => ({ variant_id: item.variant_id,
      expected_quantity: item.quantity, actual_quantity: item.quantity, available_quantity: item.quantity })), exceptions: [] } };
}
function correctionHistory(record = receivedWire()) {
  return { request_id: record.id, operations: [], lines: record.receipt.items.map(item => ({ ...item,
    workflow_revision: '0', applied_revision: '0', effective_actual: item.actual_quantity,
    effective_credit: item.available_quantity, proposals: [] })) };
}
const correctionCalls = (f: ReturnType<typeof fixture>) => f.fetch.mock.calls.filter(([url]) => String(url).includes('/count-corrections'));
const correctionPosts = (f: ReturnType<typeof fixture>) => correctionCalls(f).filter(([, init]) => init?.method === 'POST');
function correctionFixture(actor = 2, override?: (url: string, init: RequestInit) => Promise<Response> | undefined,
  record = receivedWire()) {
  const f = fixture(actor, (url, init) => override?.(url, init)
    ?? (url === `/api/transfers/${record.id}` ? Promise.resolve(reply(record))
      : url === `/api/transfers/${record.id}/count-corrections` ? Promise.resolve(reply(correctionHistory(record))) : undefined));
  f.controller.countCorrectionRecovery = createTransferCountCorrectionRecovery();
  f.controller.confirmTransferCountCorrection = vi.fn(() => { for (const listener of f.listeners) listener(); });
  const element = () => f.element({ ownerTag: f.ownerTag, id: record.id });
  return { ...f, record, element };
}
async function correctionLoaded() { await screen.findByRole('heading', { name: 'Conteo efectivo confirmado' }); }
function correctionPreview(action: 'propose' | 'accept' | 'reject' = 'propose') {
  fireEvent.click(screen.getAllByRole('button', { name: action === 'propose' ? 'Proponer corrección'
    : `${action === 'accept' ? 'Aceptar' : 'Rechazar'} revisión 1` })[0]);
  if (action === 'propose') fireEvent.change(screen.getByLabelText('Cantidad corregida'), { target: { value: '5' } });
  fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: '  Recuento exacto  ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Revisar corrección' }));
  return screen.getByRole('dialog', { name: 'Revisar corrección de conteo' });
}
function operationWire(input: CountDecisionInput | CountProposalInput, actor = 2, action = 'propose') {
  return { ...input, request_id: '9007199254740993', actor_location_id: actor, action,
    actual_quantity: 'actual_quantity' in input ? input.actual_quantity : null,
    revision: (BigInt(input.expected_revision) + (action === 'propose' ? 1n : 0n)).toString(), recorded_at: correctionStamp };
}
function pendingHistory(record = receivedWire()) {
  const history = correctionHistory(record);
  return { ...history, lines: history.lines.map((line, index) => ({ ...line, workflow_revision: index === 0 ? '1' : '0',
    proposals: index === 0 ? [{ revision: '1', operation_key: 'original_proposal_0001', initiator_location_id: 1,
      actual_quantity: '5', base_revision: '0', base_credit: line.available_quantity, reason: 'Reconteo de origen',
      recorded_at: correctionStamp, state: 'pending', decision: null, application: null }] : [] })) };
}

describe('F4a selected chrome', () => {
  it('prioritizes selected identity and preserves counters, navigation and mounted lanes', async () => {
    const f = correctionFixture();
    render(f.element()); await correctionLoaded();
    const identity = screen.getByRole('heading', { name: f.record.reference, level: 1 });
    expect(screen.queryByRole('heading', { name: 'Detalle de solicitud' })).not.toBeInTheDocument();
    expect(screen.queryByText(/solicitudes pendientes$/)).not.toBeInTheDocument();
    const counters = screen.getByRole('region', { name: 'Contadores de solicitudes' });
    expect(identity.compareDocumentPosition(counters) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(counters).toHaveTextContent('9007199254740995');
    expect(counters).toHaveTextContent('9007199254740994');
    const lane = screen.getByRole('region', { name: 'Correcciones de conteo' });
    expect(screen.getAllByRole('region', { name: 'Correcciones de conteo' })).toHaveLength(1);
    expect(screen.getByRole('region', { name: 'Recepción original' }).compareDocumentPosition(lane) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Recibir solicitud' })).not.toBeInTheDocument();
    expect(f.fetch.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Volver a pendientes' }));
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'Volver al inventario' }));
    expect(f.back).toHaveBeenCalledOnce();
  });
});

describe('R6a received detail restitution composition', () => {
  it('mounts one controller-owned restitution lane after C4 and preserves original receipt through Back', async () => {
    const record = receivedWire();
    const f = correctionFixture(2, url => url.endsWith('/restitutions') ? Promise.resolve(reply({ request_id: record.id, operations: [],
      lines: record.receipt.items.map(i => ({ variant_id: i.variant_id, expected_quantity: i.expected_quantity, original_credit: i.available_quantity,
        workflow_revision: '0', applied_revision: '0', count_generation: '0', count_applied_revision: '0', effective_credit: i.available_quantity,
        applied_retained_quantity: '0', proposals: [] })) })) : undefined, record);
    f.controller.restitutionRecovery = createTransferRestitutionRecovery();
    f.controller.confirmTransferRestitution = vi.fn();
    render(f.element()); await screen.findByText('Crédito efectivo en destino');
    const original = screen.getByRole('table', { name: 'Detalle de recepción' }).outerHTML;
    const section = screen.getByRole('region', { name: 'Restituciones de origen' });
    expect(section.previousElementSibling).toBe(screen.getByRole('region', { name: 'Correcciones de conteo' }));
    expect(f.fetch.mock.calls.filter(([url]) => String(url).endsWith('/restitutions'))).toHaveLength(1);
    fireEvent.click(within(section).getByRole('button', { name: 'Consultar para revisar restitución' }));
    await waitFor(() => expect(f.fetch.mock.calls.filter(([url]) => String(url).endsWith('/restitutions'))).toHaveLength(2));
    expect(screen.getByRole('table', { name: 'Detalle de recepción' }).outerHTML).toBe(original);
    fireEvent.click(screen.getByRole('button', { name: 'Volver a pendientes' }));
    expect(screen.queryByRole('region', { name: 'Restituciones de origen' })).not.toBeInTheDocument();
    expect(f.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  });
});

describe('C4b received detail real-hook integration', () => {
  it('opens exactly the selected correction lane beside unchanged original receipt evidence', async () => {
    const record = receivedWire();
    const f = fixture(2, url => url === `/api/transfers/${record.id}` ? Promise.resolve(reply(record))
      : url === `/api/transfers/${record.id}/count-corrections` ? Promise.resolve(reply(correctionHistory(record))) : undefined);
    render(f.element({ ownerTag: f.ownerTag, id: record.id }));
    await screen.findByRole('heading', { name: 'TR-9007199254740993' });
    await screen.findByRole('heading', { name: 'Conteo efectivo confirmado' });
    expect(correctionCalls(f)).toHaveLength(1);
    expect(correctionCalls(f)[0][0]).toBe(`/api/transfers/${record.id}/count-corrections`);
    expect(isPassive(correctionCalls(f)[0])).toBe(true);
    const receivedTime = screen.getByRole('region', { name: 'Historial de la solicitud' }).querySelector(`time[datetime="${record.received_at}"]`);
    expect(receivedTime).toHaveTextContent('02/01/2028 · 20:00 (hora Bolivia)');
    expect(receivedTime).toHaveAttribute('datetime', record.received_at);
    expect(within(screen.getByRole('region', { name: 'Cantidades de la solicitud' })).getByText('Stock acreditado (recepción original)').nextElementSibling).toHaveTextContent('18446744073709551614');
    expect(f.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  });
});

describe('C4b App correction settlement with real inventory controller', () => {
  it.each(['accept', 'reject'] as const)('previews %s without POST, settles history and refreshes inventory only for acceptance', async action => {
    const record = receivedWire(); const originalHistory = pendingHistory(record);
    let nextHistory: unknown = originalHistory;
    let settled = false;
    class Source { addEventListener() {} removeEventListener() {} close() {} }
    vi.stubGlobal('EventSource', Source);
    const f = correctionFixture(2, (url, init) => {
      if (url === '/api/auth/session') return Promise.resolve(reply(authority().session));
      if (url === '/api/inventory/metadata') return Promise.resolve(reply({ locations: locations.map((name, index) => ({ id: index + 1, name })), brands: ['TOYO'] }));
      if (url.startsWith('/api/inventory?')) {
        const query = new URL(url, 'http://localhost').searchParams;
        const location = Number(query.get('location_id'));
        return Promise.resolve(reply({ location: { id: location, name: locations[location - 1] }, page: Number(query.get('page')),
          page_size: Number(query.get('page_size')), total_variants: 0, items: [] }));
      }
      if (url.startsWith('/api/transfers?')) {
        const status = new URL(url, 'http://localhost').searchParams.get('status');
        return Promise.resolve(reply({ page: 1, page_size: 25, status, total_count: status === 'received' ? '1' : '0', records: status === 'received' ? [record] : [] }));
      }
      if (url.endsWith(`/count-corrections/${action}`) && init.method === 'POST') {
        const input = JSON.parse(String(init.body)) as CountDecisionInput;
        settled = true;
        const proposal = originalHistory.lines[0].proposals[0];
        const snapshot = { ...originalHistory, operations: [operationWire(input, 2, action)], lines: originalHistory.lines.map((line, index) => index ? line : {
          ...line, applied_revision: action === 'accept' ? '1' : '0', effective_actual: action === 'accept' ? '5' : line.actual_quantity,
          effective_credit: action === 'accept' ? '5' : line.available_quantity, proposals: [{ ...proposal,
            state: action === 'accept' ? 'applied' : 'rejected', decision: { operation_key: input.operation_key,
              actor_location_id: 2, accepted: action === 'accept', reason: input.reason, recorded_at: correctionStamp },
            application: action === 'accept' ? { effective_credit: '5', delta: '-9223372036854775802', recorded_at: correctionStamp } : null }] }) };
        nextHistory = snapshot;
        return Promise.resolve(reply(operationWire(input, 2, action)));
      }
      if (url.endsWith('/count-corrections')) return Promise.resolve(reply(settled ? nextHistory : originalHistory));
      return undefined;
    });
    render(<App />);
    await screen.findByRole('region', { name: 'Resultados de inventario' });
    // Consulted inventory differs from the assigned destination; it grants no authority.
    fireEvent.click(await screen.findByRole('button', { name: /Sucursal B/ }));
    await waitFor(() => expect(String(f.fetch.mock.calls.filter(([url]) => String(url).startsWith('/api/inventory?')).at(-1)?.[0])).toContain('location_id=3'));
    fireEvent.click(screen.getByRole('button', { name: 'Transferencias' }));
    fireEvent.change(await screen.findByLabelText('Estado de transferencia'), { target: { value: 'received' } });
    fireEvent.click(await screen.findByRole('button', { name: `Ver detalle ${record.reference}` })); await correctionLoaded();
    const receipt = screen.getByRole('table', { name: 'Detalle de recepción' });
    const metrics = screen.getByRole('region', { name: 'Cantidades de la solicitud' });
    const summary = screen.getByRole('complementary', { name: 'Resumen de solicitud' });
    const original = { receipt: receipt.outerHTML, metrics: metrics.outerHTML,
      times: [...summary.querySelectorAll('time')].map(time => time.outerHTML), header: screen.getByRole('heading', { name: record.reference }).parentElement!.outerHTML };
    const inventoryBefore = f.fetch.mock.calls.filter(([url]) => String(url).startsWith('/api/inventory?')).length;
    const modal = correctionPreview(action);
    expect(modal).toHaveTextContent('Revisión de flujo esperada: 1');
    expect(modal).toHaveTextContent(action === 'accept' ? 'Efecto en destino: -9223372036854775802' : 'Efecto en destino: 0');
    expect(correctionPosts(f)).toHaveLength(0);
    const confirm = screen.getByRole('button', { name: action === 'accept' ? 'Confirmar aceptación' : 'Confirmar rechazo' });
    fireEvent.click(confirm); fireEvent.click(confirm);
    await screen.findByText(`${action === 'accept' ? 'Aplicada' : 'Rechazada'} · Revisión 1`);
    expect(correctionPosts(f)).toHaveLength(1);
    const input = JSON.parse(String(correctionPosts(f)[0][1]?.body)) as CountDecisionInput;
    expect(input).toEqual({ variant_id: 1, operation_key: expect.stringMatching(/^[a-f0-9]{32}$/), expected_revision: '1', reason: '  Recuento exacto  ' });
    expect(screen.getByRole('table', { name: 'Detalle de recepción' }).outerHTML).toBe(original.receipt);
    expect(screen.getByRole('region', { name: 'Cantidades de la solicitud' }).outerHTML).toBe(original.metrics);
    expect([...screen.getByRole('complementary', { name: 'Resumen de solicitud' }).querySelectorAll('time')]
      .map(time => time.outerHTML)).toEqual(original.times);
    expect(screen.getByRole('heading', { name: record.reference }).parentElement!.outerHTML).toBe(original.header);
    await act(async () => {});
    expect(f.fetch.mock.calls.filter(([url]) => String(url).startsWith('/api/inventory?'))).toHaveLength(inventoryBefore + (action === 'accept' ? 1 : 0));
    const inventoryLast = f.fetch.mock.calls.filter(([url]) => String(url).startsWith('/api/inventory?')).at(-1)!;
    expect(String(inventoryLast[0])).toContain('location_id=3');
    // C4 and the restitution hook independently consult count evidence initially and after settlement.
    expect(correctionCalls(f).filter(([, init]) => init?.method === 'GET')).toHaveLength(4);
  });
});

describe('C4b correction authority and operation boundaries', () => {
  it('uses a just-confirmed receipt while the list and detail still say in transit', async () => {
    const record = receivedWire();
    const { receipt: _receipt, receipt_location_id: _location, received_at: _stamp, ...sent } = record;
    const transit = { ...sent, status: 'in_transit' };
    const refresh = deferred(); let confirmed = false;
    const f = correctionFixture(2, (url, init) => {
      if (url === `/api/transfers/${record.id}`) return confirmed ? refresh.promise : Promise.resolve(reply(transit));
      if (url.endsWith('/receive') && init.method === 'POST') { confirmed = true; return Promise.resolve(reply(record)); }
      return undefined;
    });
    f.controller.receiptRecovery = createTransferReceiptRecovery();
    f.controller.confirmTransferReceipt = vi.fn(() => { for (const listener of f.listeners) listener(); });
    render(f.element()); await screen.findByRole('button', { name: 'Recibir solicitud' });
    expect(correctionCalls(f)).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Recibir solicitud' }));
    for (const input of screen.getAllByLabelText(/Cantidad recibida.*Exact/)) fireEvent.change(input, { target: { value: '9223372036854775807' } });
    fireEvent.click(screen.getByRole('button', { name: 'Revisar recepción' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirmar recepción' }));
    await correctionLoaded();
    expect(correctionCalls(f)).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'Solicitud Recibida' })).toBeInTheDocument();
    expect(within(screen.getByRole('heading', { name: record.reference }).closest('.transfer-detail') as HTMLElement)
      .getByRole('table', { name: 'Detalle de recepción' })).toHaveTextContent('9223372036854775807');
    await act(async () => refresh.resolve(reply(transit)));
    expect(screen.getByRole('heading', { name: 'Conteo efectivo confirmado' })).toBeInTheDocument();
    expect(correctionCalls(f)).toHaveLength(1); expect(correctionPosts(f)).toHaveLength(0);
  });
  it.each(['pending', 'approved', 'rejected', 'in_transit', 'cancelled'])('reads no correction history for %s', async status => {
    const original = wire(1, 2, '9007199254740993', status);
    const record = status === 'in_transit' ? { ...original, dispatch_location_id: 1, dispatched_at: correctionStamp }
      : status === 'cancelled' ? { ...original, cancellation_location_id: 2, cancelled_at: correctionStamp } : original;
    const f = fixture(2, url => url === `/api/transfers/${record.id}` ? Promise.resolve(reply(record)) : undefined);
    render(f.element({ ownerTag: f.ownerTag, id: record.id }));
    await screen.findByRole('heading', { name: record.reference });
    expect(correctionCalls(f)).toHaveLength(0);
    expect(screen.queryByRole('region', { name: 'Correcciones de conteo' })).not.toBeInTheDocument();
  });

  it.each([[1, 1, 2], [2, 1, 2], [1, 2, 1], [2, 2, 1], [2, 3, 2], [3, 3, 2], [1, 3, 2]])(
    'gates actor %s on physical route %s → %s', async (actor, origin, destination) => {
      const f = correctionFixture(actor, undefined, receivedWire(origin, destination));
      render(f.element());
      if (actor === origin || actor === destination) {
        await screen.findByRole('heading', { name: f.record.reference });
        await correctionLoaded(); expect(correctionCalls(f)).toHaveLength(1);
      } else {
        await screen.findByText('No se pudo consultar la solicitud.');
        expect(correctionCalls(f)).toHaveLength(0);
        expect(screen.queryByRole('region', { name: 'Correcciones de conteo' })).not.toBeInTheDocument();
      }
      expect(correctionPosts(f)).toHaveLength(0);
    });

  it('keeps previews through fresh controller wrappers but cancels on genuine record refresh', async () => {
    const f = correctionFixture(); const view = render(f.element()); await correctionLoaded();
    fireEvent.click(screen.getAllByRole('button', { name: 'Proponer corrección' })[0]);
    fireEvent.change(screen.getByLabelText('Cantidad corregida'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: 'Recuento exacto' } });
    const rerender = () => view.rerender(<TransferPending controller={{ ...f.controller }} ownerTag={f.ownerTag}
      initialDetail={{ ownerTag: f.ownerTag, id: f.record.id }} onInventory={f.back} />);
    rerender();
    expect(screen.getByLabelText('Cantidad corregida')).toHaveValue('5');
    expect(screen.getByLabelText('Motivo')).toHaveValue('Recuento exacto');
    fireEvent.click(screen.getByRole('button', { name: 'Revisar corrección' })); rerender();
    expect(screen.getByRole('dialog')).toHaveTextContent('Recuento exacto');
    expect(correctionCalls(f)).toHaveLength(1); expect(correctionPosts(f)).toHaveLength(0);
    act(() => { for (const listener of f.listeners) listener(); });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(correctionPosts(f)).toHaveLength(0);
    await waitFor(() => expect(correctionCalls(f)).toHaveLength(2));
  });

  it('cancels a preview when only the correction snapshot changes, without posting the stale revision', async () => {
    let reads = 0;
    const f = correctionFixture(2, url => url.endsWith('/count-corrections')
      ? Promise.resolve(reply(++reads === 1 ? correctionHistory() : pendingHistory())) : undefined);
    render(f.element()); await correctionLoaded(); correctionPreview();
    // The newly enabled parent hook subscribes after the detail's child effect.
    // Isolate that history lane so the received record retains its object identity.
    const historyListener = [...f.listeners].at(-1)!;
    expect(historyListener).toBeTypeOf('function');
    act(() => historyListener());
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByText('Pendiente · Revisión 1')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Editar corrección' })).not.toBeInTheDocument();
    expect(correctionPosts(f)).toHaveLength(0);
    expect(calls(f, true)).toHaveLength(1);
  });

  it.each(['unready', 'generation', 'account', 'location'])('retires a private preview on %s changes without a write', async change => {
    const f = correctionFixture(); const view = render(f.element()); await correctionLoaded(); correctionPreview();
    const before = correctionCalls(f).length;
    if (change === 'unready') f.env.current = { ...f.env.current, ready: false };
    else if (change === 'generation') f.env.current = { ...f.env.current, sessionGeneration: 2 };
    else if (change === 'location') f.env.current = authority(3);
    else {
      const session = f.env.current.session;
      if (!session?.authenticated) throw new Error('Missing synthetic session');
      f.env.current = { ...f.env.current, session: { ...session, identity: { ...session.identity, account_id: 77 } } };
    }
    view.rerender(f.element());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(correctionPosts(f)).toHaveLength(0);
    await act(async () => {});
    expect(correctionCalls(f)).toHaveLength(before);
  });

  it.each([403, 404])('masks correction %s while retaining original receipt, and does not resume on re-render', async status => {
    const f = correctionFixture(2, url => url.endsWith('/count-corrections')
      ? Promise.resolve(reply({ error: 'PRIVATE evidence' }, status)) : undefined);
    const view = render(f.element()); await screen.findByText('Correcciones no disponibles para esta sesión.');
    expect(screen.getByRole('table', { name: 'Detalle de recepción' })).toHaveTextContent('9223372036854775807');
    expect(screen.queryByRole('button', { name: 'Proponer corrección' })).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('PRIVATE');
    view.rerender(f.element()); await act(async () => {});
    expect(correctionCalls(f)).toHaveLength(1); expect(correctionPosts(f)).toHaveLength(0);
  });

  it.each([403, 404])('never opens corrections for an unavailable original detail %s', async status => {
    const f = correctionFixture(2, url => url === '/api/transfers/9007199254740993'
      ? Promise.resolve(reply({ error: status === 404 ? 'not_found' : 'PRIVATE detail' }, status)) : undefined);
    render(f.element()); await screen.findByText('La solicitud no está disponible.');
    expect(correctionCalls(f)).toHaveLength(0);
    expect(screen.queryByRole('table', { name: 'Detalle de recepción' })).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('PRIVATE');
  });

  it('sends no proposal during preview, then confirms exactly once with the full captured identity', async () => {
    const write = deferred();
    const f = correctionFixture(2, (url, init) => url.endsWith('/count-corrections/propose') && init.method === 'POST' ? write.promise : undefined);
    render(f.element()); await correctionLoaded(); const modal = correctionPreview();
    expect(modal).toHaveTextContent('Crédito limitado: 5');
    expect(modal).toHaveTextContent('Efecto en destino: -9223372036854775802');
    expect(correctionPosts(f)).toHaveLength(0);
    const confirm = screen.getByRole('button', { name: 'Confirmar propuesta' });
    fireEvent.click(confirm); fireEvent.click(confirm);
    expect(correctionPosts(f)).toHaveLength(1);
    const [url, init] = correctionPosts(f)[0];
    expect(url).toBe(`/api/transfers/${f.record.id}/count-corrections/propose`);
    const input = JSON.parse(String(init?.body)) as CountProposalInput;
    expect(input).toEqual({ variant_id: 1, operation_key: expect.stringMatching(/^[a-f0-9]{32}$/),
      expected_revision: '0', actual_quantity: '5', reason: '  Recuento exacto  ' });
    expect(new Headers(init?.headers).get('X-CSRF-Token')).toBe('a'.repeat(43));
    await act(async () => write.resolve(reply(operationWire(input))));
    expect(f.controller.confirmTransferCountCorrection).toHaveBeenCalledExactlyOnceWith(decisionOwner(f.env.current),
      expect.objectContaining({ request_id: BigInt(f.record.id), actor_location_id: 2, action: 'propose',
        operation_key: input.operation_key, reason: input.reason, expected_revision: 0n, actual_quantity: 5n, revision: 1n }));
    await waitFor(() => expect(correctionCalls(f).filter(([, init]) => init?.method === 'GET')).toHaveLength(2));
  });

  it('retains uncertainty across parent unmount/remount and explicitly retries the same payload without rebase', async () => {
    let fail = true;
    const f = correctionFixture(2, (url, init) => url.endsWith('/count-corrections/propose') && init.method === 'POST'
      ? fail ? Promise.reject(new Error('PRIVATE lost reply'))
        : Promise.resolve(reply(operationWire(JSON.parse(String(init.body)) as CountProposalInput))) : undefined);
    const view = render(f.element()); await correctionLoaded(); correctionPreview();
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar propuesta' }));
    await screen.findByRole('button', { name: 'Reintentar carga exacta' });
    const captured = correctionPosts(f)[0][1]?.body;
    fireEvent.click(screen.getByRole('button', { name: 'Volver a pendientes' }));
    expect(screen.queryByRole('region', { name: 'Correcciones de conteo' })).not.toBeInTheDocument();
    view.unmount(); render(f.element()); await correctionLoaded();
    expect(screen.getByRole('article', { name: 'Recuperación 1' })).toHaveTextContent('Recuento exacto');
    expect(correctionPosts(f)).toHaveLength(1);
    expect(within(screen.getByRole('article', { name: 'TOYO · Exact-1 · 75.125 Ah · L' })).queryByRole('button', { name: 'Proponer corrección' })).not.toBeInTheDocument();
    fail = false; fireEvent.click(screen.getByRole('button', { name: 'Reintentar carga exacta' }));
    await waitFor(() => expect(f.controller.confirmTransferCountCorrection).toHaveBeenCalledTimes(1));
    expect(correctionPosts(f)).toHaveLength(2); expect(correctionPosts(f)[1][1]?.body).toBe(captured);
    expect(document.body).not.toHaveTextContent('PRIVATE');
  });

  it('opens history only after selecting a received row and disables it again on Back', async () => {
    const record = receivedWire();
    const f = correctionFixture(2, url => {
      if (url.includes('status=received')) return Promise.resolve(reply({ page: 1, page_size: 25, status: 'received', total_count: '1', records: [record] }));
      return undefined;
    });
    render(<TransferPending controller={f.controller} ownerTag={f.ownerTag} onInventory={f.back} />);
    await loaded();
    fireEvent.change(screen.getByLabelText('Estado de transferencia'), { target: { value: 'received' } });
    await screen.findByText('1 solicitud recibida'); expect(correctionCalls(f)).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: `Ver detalle ${record.reference}` })); await correctionLoaded();
    expect(correctionCalls(f)).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Volver a recibidas' }));
    expect(screen.queryByRole('region', { name: 'Correcciones de conteo' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Estado de transferencia')).toHaveValue('received');
    await act(async () => {}); expect(correctionCalls(f)).toHaveLength(1);
  });

  it('keeps a privately unavailable receipt masked even if a later GET says received', async () => {
    const record = receivedWire();
    const { receipt: _receipt, receipt_location_id: _location, received_at: _stamp, ...sent } = record;
    let received = false;
    const f = correctionFixture(2, (url, init) => {
      if (url === `/api/transfers/${record.id}`) return Promise.resolve(reply(received ? record : { ...sent, status: 'in_transit' }));
      if (url.endsWith('/receive') && init.method === 'POST') return Promise.resolve(reply({ error: 'not_found' }, 404));
      return undefined;
    });
    f.controller.receiptRecovery = createTransferReceiptRecovery();
    render(f.element()); fireEvent.click(await screen.findByRole('button', { name: 'Recibir solicitud' }));
    for (const input of screen.getAllByLabelText(/Cantidad recibida.*Exact/)) fireEvent.change(input, { target: { value: '9223372036854775807' } });
    fireEvent.click(screen.getByRole('button', { name: 'Revisar recepción' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirmar recepción' }));
    await screen.findByText('La solicitud no está disponible.');
    received = true; act(() => { for (const listener of f.listeners) listener(); });
    await waitFor(() => expect(calls(f, true)).toHaveLength(2)); await act(async () => {});
    expect(correctionCalls(f)).toHaveLength(0);
    expect(screen.queryByRole('table', { name: 'Detalle de recepción' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Correcciones de conteo' })).not.toBeInTheDocument();
  });

  it('ignores an aborted late history from a previous selection', async () => {
    const read = deferred();
    const f = correctionFixture(2, url => url.endsWith('/count-corrections') ? read.promise : undefined);
    render(f.element()); await screen.findByRole('heading', { name: f.record.reference });
    await waitFor(() => expect(correctionCalls(f)).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Volver a pendientes' }));
    expect(correctionCalls(f)[0][1]?.signal?.aborted).toBe(true);
    await act(async () => read.resolve(reply(correctionHistory(f.record))));
    expect(screen.queryByRole('region', { name: 'Correcciones de conteo' })).not.toBeInTheDocument();
    expect(correctionPosts(f)).toHaveLength(0); expect(f.controller.confirmTransferCountCorrection).not.toHaveBeenCalled();
  });
});

describe('C2 creator cancellation entry and consultation', () => {
  it.each([[1, 2], [1, 3], [2, 3], [3, 2], [2, 1], [3, 1]])
    ('offers Pending/Approved cancellation only to the original creator on %s → %s', async (origin, destination) => {
      const creator = destination === 1 ? origin : destination;
      for (const status of ['pending', 'approved']) {
        for (const actor of [origin, destination]) {
          const f = fixture(actor);
          f.env.record = wire(origin, destination, '9007199254740993', status);
          const view = render(f.element({ ownerTag: f.ownerTag, id: f.env.record.id }));
          await screen.findByRole('heading', { name: f.env.record.reference });
          const button = screen.queryByRole('button', { name: 'Cancelar solicitud' });
          if (actor === creator) expect(button).toBeEnabled();
          else expect(button).not.toBeInTheDocument();
          expect(f.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
          view.unmount();
        }
      }
    });
  it.each([false, true])('consults Cancelada with immutable history, zero actions and no fake approval (approved=%s)', async approved => {
    const original = wire();
    const cancelled = { ...original, status: 'cancelled', cancellation_location_id: 2,
      cancelled_at: '2028-01-02T00:00:00.000000002Z',
      ...(approved ? { decision_location_id: 1, decided_at: '2028-01-02T00:00:00.000000001Z' } : {}) };
    const f = fixture(2, (url, init) => {
      if (url === '/api/transfers/counts') return Promise.resolve(reply({ pending_total: '0', action_count: '0' }));
      if (url.includes('status=cancelled')) return Promise.resolve(reply({ page: 1, page_size: 25,
        status: 'cancelled', total_count: '1', records: [cancelled] }));
      if (url === `/api/transfers/${original.id}` && init.method === 'GET') return Promise.resolve(reply(cancelled));
      return undefined;
    });
    render(f.element()); await loaded();
    const selector = screen.getByRole('combobox', { name: 'Estado de transferencia' });
    expect(within(selector).getByRole('option', { name: 'Canceladas' })).toHaveValue('cancelled');
    fireEvent.change(selector, { target: { value: 'cancelled' } });
    await screen.findByText('1 solicitud cancelada');
    expect(screen.getByRole('table')).toHaveTextContent('Cancelada');
    await detail();
    expect(screen.getByRole('heading', { name: 'Solicitud Cancelada' })).toBeVisible();
    const history = screen.getByRole('region', { name: 'Historial de la solicitud' });
    expect(within(history).getAllByRole('listitem')).toHaveLength(approved ? 3 : 2);
    expect(within(history).getByText('31/12/2027 · 20:00 (hora Bolivia)')).toHaveAttribute('datetime', original.created_at);
    expect(history).toHaveTextContent('Solicitud cancelada');
    expect(history).toHaveTextContent('Sucursal A');
    expect(history.querySelector(`time[datetime="${cancelled.cancelled_at}"]`)).toHaveTextContent('01/01/2028 · 20:00 (hora Bolivia)');
    if (approved) expect(history.querySelector('time[datetime="2028-01-02T00:00:00.000000001Z"]')).toHaveTextContent('01/01/2028 · 20:00 (hora Bolivia)');
    else expect(history).not.toHaveTextContent(/aprobada|reservado|Decidida/);
    expect(history).not.toHaveTextContent(/rechazada|despachada|recibida/);
    expect(screen.queryByRole('button', { name: /^(Cancelar|Aprobar|Rechazar|Despachar|Recibir) / })).not.toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Baterías solicitadas' })).toHaveTextContent('18446744073709551614');
    expect(f.fetch.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Volver a canceladas' }));
    expect(screen.getByLabelText('Estado de transferencia')).toHaveValue('cancelled');
  });
});

describe('A06b independent passive counters', () => {
  it('shows exact independent request counters, not rows, selected totals or item units', async () => {
    const f = fixture(); render(f.element()); await loaded();
    const counters = await screen.findByRole('region', { name: 'Contadores de solicitudes' });
    expect(counters).toHaveTextContent('Pendientes de tu ubicación9007199254740995');
    expect(counters).toHaveTextContent('Acciones requeridas9007199254740994');
    expect(counters).not.toHaveTextContent('18446744073709551614');
    expect(counters).not.toHaveTextContent('9007199254740993');
  });

  it.each([1, 2, 3])('uses intrinsic headerless counts GET for assigned participant %s through query/detail/Back', async id => {
    const f = fixture(id); if (id === 3) f.env.record = wire(2, 3);
    render(f.element()); await loaded();
    const counters = await screen.findByRole('region', { name: 'Contadores de solicitudes' });
    await waitFor(() => expect(counters.querySelectorAll('dd')).toHaveLength(2));
    fireEvent.change(screen.getByLabelText('Estado de transferencia'), { target: { value: 'approved' } });
    await screen.findByText('9007199254740993 solicitudes aprobadas');
    fireEvent.click(screen.getByRole('button', { name: 'Siguiente aprobadas' }));
    await screen.findByText('Página 2');
    f.env.record = wire(f.env.record.origin_location_id, f.env.record.destination_location_id, f.env.record.id, 'approved');
    await detail(); fireEvent.click(screen.getByRole('button', { name: 'Volver a aprobadas' }));
    expect(screen.getByLabelText('Estado de transferencia')).toHaveValue('approved');
    expect(screen.getByText('Página 2')).toBeVisible();
    expect(countCalls(f)).toHaveLength(1);
    expect(countCalls(f)[0][1]).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store' });
    expect([...new Headers(countCalls(f)[0][1]?.headers)]).toEqual([]);
    expect(countCalls(f)[0][1]?.body).toBeUndefined();
    expect(counters).toHaveTextContent('9007199254740994');
    expect(f.fetch.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
    expect(f.listeners.size).toBe(1);
  });

  it('keeps initial/loading unknown distinct from genuine zero even when the list fails', async () => {
    const flight = deferred();
    const f = fixture(2, url => url === '/api/transfers/counts' ? flight.promise
      : url.startsWith('/api/transfers?') ? Promise.reject(new Error('PRIVATE list')) : undefined);
    render(f.element());
    const counters = screen.getByRole('region', { name: 'Contadores de solicitudes' });
    expect(counters).toHaveTextContent('Consultando contadores…');
    expect(counters.querySelector('dd')).toBeNull();
    await screen.findByText('No se pudieron consultar las solicitudes.');
    await act(async () => flight.resolve(reply({ pending_total: '0', action_count: '0' })));
    expect([...counters.querySelectorAll('dd')].map(value => value.textContent)).toEqual(['0', '0']);
    expect(counters).not.toHaveTextContent('no disponibles');
    expect(document.body).not.toHaveTextContent('PRIVATE');
  });

  it.each(['malformed', 'network', '403', '404', '503', '401'])('sanitizes current counts %s without hiding a successful list', async mode => {
    const f = fixture(2, url => url === '/api/transfers/counts'
      ? mode === 'network' ? Promise.reject(new Error('PRIVATE count id 777'))
        : Promise.resolve(mode === 'malformed' ? reply({ pending_total: '1', action_count: '2', private: 'PRIVATE' })
          : reply({ error: 'PRIVATE count id 777' }, Number(mode))) : undefined);
    render(f.element()); await loaded();
    const counters = screen.getByRole('region', { name: 'Contadores de solicitudes' });
    await waitFor(() => expect(counters).toHaveTextContent('Contadores no disponibles.'));
    expect(counters.querySelector('dd')).toBeNull();
    expect(screen.getByRole('table')).toHaveTextContent('TR-9007199254740993');
    expect(document.body).not.toHaveTextContent('PRIVATE');
    if (mode === '401') await waitFor(() => expect(f.controller.settleUnauthorized).toHaveBeenCalledExactlyOnceWith(1));
    else expect(f.controller.settleUnauthorized).not.toHaveBeenCalled();
  });

  it('immediately clears refreshed metrics, discards dirty snapshots and coalesces one follow-up', async () => {
    let held: ReturnType<typeof deferred> | null = null;
    const f = fixture(2, url => url === '/api/transfers/counts' ? held?.promise : undefined);
    render(f.element()); await loaded();
    const counters = screen.getByRole('region', { name: 'Contadores de solicitudes' });
    await waitFor(() => expect(counters).toHaveTextContent('9007199254740994'));
    held = deferred();
    act(() => { for (const listener of f.listeners) listener(); });
    expect(counters.querySelector('dd')).toBeNull();
    expect(counters).toHaveTextContent('Consultando contadores…');
    await waitFor(() => expect(countCalls(f)).toHaveLength(2));
    act(() => { for (const listener of f.listeners) { listener(); listener(); } });
    expect(countCalls(f)).toHaveLength(2);
    const first = held; held = deferred();
    await act(async () => first.resolve(reply({ pending_total: '777', action_count: '666' })));
    await waitFor(() => expect(countCalls(f)).toHaveLength(3));
    expect(counters.querySelector('dd')).toBeNull();
    await act(async () => held!.resolve(reply({ pending_total: '5', action_count: '1' })));
    expect([...counters.querySelectorAll('dd')].map(value => value.textContent)).toEqual(['5', '1']);
    await act(async () => {}); expect(countCalls(f)).toHaveLength(3);
    held = deferred(); act(() => { for (const listener of f.listeners) listener(); });
    expect(counters.querySelector('dd')).toBeNull();
    await act(async () => held!.reject(new Error('PRIVATE refresh')));
    expect(counters).toHaveTextContent('Contadores no disponibles.');
    expect(counters.querySelector('dd')).toBeNull();
    expect(document.body).not.toHaveTextContent('PRIVATE');
  });

  it.each(['csrf', 'account', 'location', 'unready', 'logout'])('fences same-object %s before rerender and ignores obsolete success/error/401', async mode => {
    for (const outcome of ['success', 'error', '401']) {
      const old = deferred(); let held = false;
      const f = fixture(2, url => held && url === '/api/transfers/counts' ? old.promise : undefined);
      const view = render(f.element()); await loaded();
      await waitFor(() => expect(screen.getByRole('region', { name: 'Contadores de solicitudes' })).toHaveTextContent('9007199254740994'));
      held = true; act(() => { for (const listener of f.listeners) listener(); });
      await waitFor(() => expect(countCalls(f)).toHaveLength(2));
      const saved = [...f.listeners];
      if (mode === 'unready') f.env.current.ready = false;
      else if (mode === 'logout') f.env.current.session = { authenticated: false, csrf_token: 'b'.repeat(43) };
      else if (f.env.current.session?.authenticated) {
        if (mode === 'csrf') f.env.current.session.csrf_token = 'b'.repeat(43);
        if (mode === 'account') f.env.current.session.identity.account_id = 3;
        if (mode === 'location') f.env.current.session.identity.location.id = 3;
      }
      act(() => { for (const listener of saved) listener(); });
      expect(countCalls(f)).toHaveLength(2);
      await act(async () => {
        if (outcome === 'error') old.reject(new Error('PRIVATE obsolete count'));
        else old.resolve(outcome === '401' ? reply({ error: 'unauthenticated' }, 401)
          : reply({ pending_total: '777', action_count: '666' }));
      });
      expect(f.controller.settleUnauthorized).not.toHaveBeenCalled();
      view.rerender(f.element());
      expect(document.body).not.toHaveTextContent('9007199254740994');
      expect(document.body).not.toHaveTextContent('PRIVATE');
      const counters = screen.queryByRole('region', { name: 'Contadores de solicitudes' });
      expect(counters?.querySelector('dd') ?? null).toBeNull();
      expect(countCalls(f).every(([, init]) => init?.method === 'GET')).toBe(true);
      view.unmount();
    }
  });
});

describe('A06b status-specific consultation', () => {
  const selectStatus = (status: string) => fireEvent.change(screen.getByRole('combobox', { name: 'Estado de transferencia' }), { target: { value: status } });
  const listReply = (status: string, records: unknown[] = [], count = '0', page = 1, size = 25) => reply({ status, page, page_size: size, total_count: count, records });

  it.each(['approved', 'rejected'])('queries exact %s pages, resets status/size and retains the query on Back', async status => {
    const f = fixture(); render(f.element()); await loaded();
    const selector = screen.getByRole('combobox', { name: 'Estado de transferencia' });
    expect(selector).toHaveValue('pending');
    expect(within(selector).getAllByRole('option').map(option => option.getAttribute('value'))).toEqual(['pending', 'approved', 'rejected', 'in_transit', 'received', 'cancelled']);
    fireEvent.click(screen.getByRole('button', { name: 'Siguiente pendientes' })); await loaded();
    selectStatus(status);
    await screen.findByText(`9007199254740993 solicitudes ${status === 'approved' ? 'aprobadas' : 'rechazadas'}`);
    expect(calls(f).at(-1)![0]).toBe(`/api/transfers?page=1&page_size=25&status=${status}`);
    expect(isPassive(calls(f).at(-1)!)).toBe(false);
    fireEvent.change(screen.getByLabelText('Solicitudes por página'), { target: { value: '10' } });
    await waitFor(() => expect(calls(f).at(-1)![0]).toBe(`/api/transfers?page=1&page_size=10&status=${status}`));
    const plural = status === 'approved' ? 'aprobadas' : 'rechazadas';
    await screen.findByText(`9007199254740993 solicitudes ${plural}`);
    fireEvent.click(screen.getByRole('button', { name: `Siguiente ${plural}` }));
    await screen.findByText(`9007199254740993 solicitudes ${plural}`);
    f.env.record = wire(1, 2, f.env.record.id, status);
    await detail();
    expect(screen.queryByRole('combobox', { name: 'Estado de transferencia' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: `Volver a ${plural}` }));
    expect(selector.isConnected).toBe(false);
    expect(screen.getByLabelText('Estado de transferencia')).toHaveValue(status);
    expect(screen.getByLabelText('Solicitudes por página')).toHaveValue('10');
    expect(screen.getByText('Página 2')).toBeVisible();
    expect(calls(f).at(-1)![0]).toBe(`/api/transfers?page=2&page_size=10&status=${status}`);
    fireEvent.change(screen.getByLabelText('Solicitudes por página'), { target: { value: '50' } });
    await waitFor(() => expect(calls(f).at(-1)![0]).toBe(`/api/transfers?page=1&page_size=50&status=${status}`));
    selectStatus('pending'); await loaded();
    expect(calls(f).at(-1)![0]).toBe('/api/transfers?page=1&page_size=50&status=pending');
    expect(f.fetch.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  });

  it.each(['approved', 'rejected'])('distinguishes %s loading, errors and zero without stale Pending totals', async status => {
    let flight = deferred();
    const f = fixture(2, url => url.includes(`status=${status}`) ? flight.promise : undefined);
    render(f.element()); await loaded(); selectStatus(status);
    const plural = status === 'approved' ? 'aprobadas' : 'rechazadas';
    expect(await screen.findByText(`Actualizando solicitudes ${plural}…`)).toBeVisible();
    expect(screen.getByText(`Consultando solicitudes ${plural}…`)).toBeVisible();
    expect(document.body).not.toHaveTextContent('9007199254740993 solicitudes pendientes');
    expect(document.body).not.toHaveTextContent(`0 solicitudes ${plural}`);
    await act(async () => flight.reject(new Error('PRIVATE old requester')));
    expect(await screen.findByText(`No se pudieron consultar las solicitudes ${plural}.`)).toBeVisible();
    expect(document.body).not.toHaveTextContent('PRIVATE');
    flight = deferred();
    fireEvent.click(screen.getByRole('button', { name: `Reintentar ${plural}` }));
    await act(async () => flight.resolve(listReply(status)));
    expect(await screen.findByText(`No hay solicitudes ${plural} para tu ubicación.`)).toBeVisible();
    expect(screen.getByText(`0 solicitudes ${plural}`)).toBeVisible();
    expect(screen.getByRole('button', { name: `Siguiente ${plural}` })).toBeDisabled();
  });

  it.each([[1, 2], [1, 3], [2, 3], [3, 2], [2, 1], [3, 1]])('keeps terminal %s → %s routes and persisted participants without pending work', async (origin, destination) => {
    for (const status of ['approved', 'rejected']) {
      const f = fixture(destination === 1 ? 1 : destination); f.env.record = wire(origin, destination); f.env.count = '1';
      const view = render(f.element()); await screen.findByText('1 solicitud pendiente'); selectStatus(status);
      const plural = status === 'approved' ? 'aprobadas' : 'rechazadas';
      await screen.findByText(`1 solicitud ${status === 'approved' ? 'aprobada' : 'rechazada'}`);
      const table = screen.getByRole('table', { name: `Solicitudes ${plural} participantes` });
      expect(table).toHaveTextContent(locations[origin - 1]); expect(table).toHaveTextContent(locations[destination - 1]);
      expect(table).toHaveTextContent('18446744073709551614');
      expect(table).toHaveTextContent('Ubicación aprobadora');
      expect(document.body).not.toHaveTextContent('Requiere aprobación de');
      expect(document.body).not.toHaveTextContent('Solicitudes Pending');
      expect(screen.queryByRole('button', { name: /^(Aprobar|Rechazar) / })).not.toBeInTheDocument();
      if (destination === 1) {
        const cards = document.querySelector('.pending-cards')!;
        expect(cards).toHaveTextContent('75.125 Ah'); expect(cards).toHaveTextContent('9223372036854775807');
        expect(cards).toHaveTextContent(`Ubicación creadora: ${locations[origin - 1]}`);
        expect(cards).toHaveTextContent('Ubicación aprobadora: Almacén');
      }
      f.env.record = wire(origin, destination, f.env.record.id, status); await detail();
      expect(within(screen.getByRole('region', { name: 'Historial de la solicitud' })).getByText('01/01/2028 · 20:00 (hora Bolivia)')).toHaveAttribute('datetime', '2028-01-02T00:00:00.000000001Z');
      expect(f.fetch.mock.calls.filter(([url]) => String(url).startsWith('/api/inventory?'))).toHaveLength(0);
      expect(f.fetch.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true); view.unmount();
    }
  });

  it('uses only the selected participant total and coalesces status invalidations without changing an open detail', async () => {
    let held: ReturnType<typeof deferred> | null = null;
    const f = fixture(2, url => url.includes('status=approved') ? (held?.promise ?? Promise.resolve(listReply('approved', [wire(1, 2, '99', 'approved')], '1'))) : undefined);
    render(f.element()); await loaded(); selectStatus('approved');
    await screen.findByText('1 solicitud aprobada');
    expect(screen.getByRole('button', { name: 'Siguiente aprobadas' })).toBeDisabled();
    held = deferred(); const before = calls(f).length;
    act(() => { for (const listener of f.listeners) listener(); });
    await waitFor(() => expect(calls(f)).toHaveLength(before + 1));
    act(() => { for (const listener of f.listeners) { listener(); listener(); } });
    const flight = held; held = null;
    await act(async () => flight.resolve(listReply('approved', [wire(1, 2, '98', 'approved')], '1')));
    await waitFor(() => expect(calls(f)).toHaveLength(before + 2));
    expect(screen.queryByRole('button', { name: 'Ver detalle TR-098' })).not.toBeInTheDocument();
    expect(isPassive(calls(f).at(-1)!)).toBe(true);
    f.env.record = wire(1, 2, '99', 'approved');
    fireEvent.click(await screen.findByRole('button', { name: 'Ver detalle TR-099' }));
    await screen.findByRole('heading', { name: 'TR-099' });
    act(() => { for (const listener of f.listeners) listener(); });
    await waitFor(() => expect(calls(f, true)).toHaveLength(2));
    expect(screen.getByRole('heading', { name: 'TR-099' })).toBeVisible();
    expect(screen.getByRole('region', { name: 'Historial de la solicitud' })).toBeVisible();
    expect(countCalls(f)).toHaveLength(4);
  });

  it.each([401, 403, 404])('sanitizes current terminal list HTTP %s without exposing old requester rows', async status => {
    const f = fixture(2, url => url.includes('status=rejected') ? Promise.resolve(reply({ error: status === 401 ? 'unauthenticated' : status === 403 ? 'forbidden' : 'not_found' }, status)) : undefined);
    render(f.element()); await loaded(); selectStatus('rejected');
    await screen.findByText('No se pudieron consultar las solicitudes rechazadas.');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('TR-9007199254740993');
    expect(document.body).not.toHaveTextContent('9223372036854775807');
    if (status === 401) await waitFor(() => expect(f.controller.settleUnauthorized).toHaveBeenCalledExactlyOnceWith(1));
    else expect(f.controller.settleUnauthorized).not.toHaveBeenCalled();
  });

  it.each(['success', '401', 'failure'])('ignores late old-status %s even when abort is ignored', async outcome => {
    const old = deferred();
    const f = fixture(2, url => url.includes('status=approved') ? old.promise : undefined);
    render(f.element()); await loaded(); selectStatus('approved');
    await waitFor(() => expect(calls(f).at(-1)![0]).toContain('status=approved'));
    selectStatus('rejected'); await screen.findByText('9007199254740993 solicitudes rechazadas');
    await act(async () => {
      if (outcome === 'failure') old.reject(new Error('PRIVATE obsolete status'));
      else old.resolve(outcome === '401' ? reply({ error: 'unauthorized' }, 401) : listReply('approved', [wire(1, 2, '99', 'approved')], '1'));
    });
    expect(screen.getByLabelText('Estado de transferencia')).toHaveValue('rejected');
    expect(screen.getByText('9007199254740993 solicitudes rechazadas')).toBeVisible();
    expect(document.body).not.toHaveTextContent('TR-099'); expect(document.body).not.toHaveTextContent('PRIVATE');
    expect(f.controller.settleUnauthorized).not.toHaveBeenCalled();
  });

  it.each(['csrf', 'account', 'unready'])('blocks retained status events and old private replies after %s mutation', async mode => {
    const old = deferred(); const f = fixture(2, url => url.includes('status=approved') ? old.promise : undefined);
    const view = render(f.element()); await loaded(); selectStatus('approved');
    const selector = screen.getByLabelText('Estado de transferencia'); const before = calls(f).length;
    if (mode === 'unready') f.env.current.ready = false;
    else if (f.env.current.session?.authenticated) {
      if (mode === 'csrf') f.env.current.session.csrf_token = 'b'.repeat(43);
      else f.env.current.session.identity.account_id = 3;
    }
    fireEvent.change(selector, { target: { value: 'rejected' } });
    expect(calls(f)).toHaveLength(before); view.rerender(f.element());
    await act(async () => old.resolve(listReply('approved', [wire(1, 2, '99', 'approved')], '1')));
    expect(document.body).not.toHaveTextContent('TR-099'); expect(document.body).not.toHaveTextContent('75.125');
    expect(f.controller.settleUnauthorized).not.toHaveBeenCalled();
  });

  it.each(['approved', 'rejected'])('explicit original recovery after status selection reports actual %s without a replacement POST', async outcome => {
    let recovering = false;
    const f = fixture(1, (url, init) => {
      if (init.method === 'POST') return Promise.reject(new Error('lost'));
      if (recovering && url === '/api/transfers/9007199254740993') return Promise.resolve(reply(wire(1, 2, '9007199254740993', outcome)));
      return undefined;
    });
    render(f.element({ ownerTag: f.ownerTag, id: f.env.record.id }));
    await screen.findByRole('heading', { name: 'TR-9007199254740993' });
    fireEvent.click(screen.getByRole('button', { name: 'Rechazar solicitud' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar rechazo' }));
    await screen.findByRole('button', { name: 'Consultar resultado original' });
    fireEvent.click(screen.getByRole('button', { name: 'Volver al detalle' }));
    fireEvent.click(screen.getByRole('button', { name: 'Volver a pendientes' }));
    selectStatus('approved'); await screen.findByText('9007199254740993 solicitudes aprobadas');
    recovering = true; fireEvent.click(screen.getByRole('button', { name: 'Consultar resultado original' }));
    await waitFor(() => expect(f.controller.confirmTransferDecision).toHaveBeenCalledExactlyOnceWith(expect.anything(), outcome));
    const attempt = f.controller.decisionRecovery!.get(decisionOwner(f.env.current));
    expect(attempt?.phase).toBe(outcome === 'approved' ? 'conflict' : 'confirmed');
    expect(attempt?.result?.status).toBe(outcome);
    expect(f.fetch.mock.calls.filter(([, init]) => init?.method === 'POST').map(([url]) => url)).toEqual(['/api/transfers/9007199254740993/reject']);
  });

  it.each(['approve', 'reject'])('preserves unknown original %s through status selection and remount without automatic POST', async action => {
    let posts = 0;
    const f = fixture(1, (_url, init) => init.method === 'POST' ? (++posts === 1 ? Promise.reject(new Error('lost'))
      : Promise.resolve(reply(wire(1, 2, '9007199254740993', action === 'approve' ? 'approved' : 'rejected')))) : undefined);
    let view = render(f.element({ ownerTag: f.ownerTag, id: f.env.record.id }));
    await screen.findByRole('heading', { name: 'TR-9007199254740993' });
    fireEvent.click(screen.getByRole('button', { name: action === 'approve' ? 'Aprobar solicitud' : 'Rechazar solicitud' }));
    fireEvent.click(screen.getByRole('button', { name: action === 'approve' ? 'Confirmar aprobación' : 'Confirmar rechazo' }));
    await screen.findByRole('button', { name: 'Consultar resultado original' });
    const attempt = f.controller.decisionRecovery!.get(decisionOwner(f.env.current));
    fireEvent.click(screen.getByRole('button', { name: 'Volver al detalle' }));
    fireEvent.click(screen.getByRole('button', { name: 'Volver a pendientes' }));
    selectStatus('approved'); await screen.findByText('9007199254740993 solicitudes aprobadas');
    selectStatus('rejected'); await screen.findByText('9007199254740993 solicitudes rechazadas');
    expect(f.controller.decisionRecovery!.get(decisionOwner(f.env.current))).toBe(attempt); expect(posts).toBe(1);
    view.unmount(); view = render(f.element());
    fireEvent.click(await screen.findByRole('button', { name: 'Consultar resultado original' }));
    const retry = action === 'approve' ? 'Reintentar misma aprobación' : 'Reintentar mismo rechazo';
    fireEvent.click(await screen.findByRole('button', { name: retry }));
    await waitFor(() => expect(f.controller.confirmTransferDecision).toHaveBeenCalledOnce());
    expect(f.fetch.mock.calls.filter(([, init]) => init?.method === 'POST').map(([url]) => url)).toEqual([
      `/api/transfers/9007199254740993/${action}`, `/api/transfers/9007199254740993/${action}`,
    ]); view.unmount();
  });
});

describe('A06a decision entry', () => {
  it('opens approval confirmation only after an explicit approver click', async () => {
    const f = fixture(1);
    render(f.element({ ownerTag: f.ownerTag, id: f.env.record.id }));
    await screen.findByRole('heading', { name: 'TR-9007199254740993' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Aprobar solicitud' }));
    expect(screen.getByRole('dialog', { name: 'Confirmar aprobación' })).toBeVisible();
    expect(f.fetch.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  });
});

describe('F5d1 explicit decision dismissal focus', () => {
  it.each(['escape', 'close', 'back'] as const)('returns confirmed decisions to current detail navigation via %s', async method => {
    for (const action of ['approve', 'reject'] as const) {
      const f = fixture(1);
      const view = render(f.element({ ownerTag: f.ownerTag, id: f.env.record.id }));
      await screen.findByRole('heading', { name: f.env.record.reference });
      const trigger = screen.getByRole('button', { name: action === 'approve' ? 'Aprobar solicitud' : 'Rechazar solicitud' });
      fireEvent.click(trigger);
      const dialog = screen.getByRole('dialog');
      fireEvent.click(within(dialog).getByRole('button', { name: action === 'approve' ? 'Confirmar aprobación' : 'Confirmar rechazo' }));
      await within(dialog).findByRole('heading', { name: /^Solicitud (Aprobada|Rechazada) confirmada$/ });
      expect(trigger.isConnected).toBe(false);
      await act(async () => {});
      const before = f.fetch.mock.calls.length;
      if (method === 'escape') fireEvent.keyDown(dialog, { key: 'Escape' });
      if (method === 'close') fireEvent.click(within(dialog).getByRole('button', { name: 'Cerrar confirmación' }));
      if (method === 'back') fireEvent.click(within(dialog).getByRole('button', { name: 'Volver al detalle' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Volver a pendientes' })).toHaveFocus();
      await act(async () => {});
      expect(f.fetch.mock.calls).toHaveLength(before);
      expect(f.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
      view.unmount();
    }
  });
  it.each(['unmount', 'authority', 'list'] as const)('never restores the decision trigger during automatic %s teardown', async mode => {
    const f = fixture(1);
    const view = render(f.element({ ownerTag: f.ownerTag, id: f.env.record.id }));
    await screen.findByRole('heading', { name: f.env.record.reference });
    const trigger = screen.getByRole('button', { name: 'Aprobar solicitud' });
    fireEvent.click(trigger);
    const restoration = vi.spyOn(trigger, 'focus');
    if (mode === 'unmount') view.unmount();
    if (mode === 'authority') { f.env.current = authority(1, 2); view.rerender(f.element()); }
    if (mode === 'list') fireEvent.click(screen.getByRole('button', { name: 'Volver a pendientes' }));
    await act(async () => {});
    expect(restoration).not.toHaveBeenCalled();
    expect(f.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
    restoration.mockRestore();
    view.unmount();
  });
});

describe('F5d2 automatic modal teardown focus boundaries', () => {
  const cases = (['decision', 'dispatch', 'receipt'] as const).flatMap(lane =>
    (['403', '404', 'authority', 'selection', 'unmount', 'strict-unmount', 'inventory', 'list'] as const).map(mode => ({ lane, mode })));
  it.each(cases)('$lane never restores focus during $mode', async ({ lane, mode }) => {
    const actor = lane === 'receipt' ? 2 : 1;
    const status = lane === 'decision' ? 'pending' : lane === 'dispatch' ? 'approved' : 'in_transit';
    const record = { ...wire(1, 2, '9007199254740993', status),
      ...(lane === 'receipt' ? { dispatch_location_id: 1, dispatched_at: correctionStamp } : {}) };
    const next = { ...record, id: '9007199254740992', reference: 'TR-9007199254740992' };
    const f = fixture(actor, (url, init) => {
      if (init.method === 'POST') return Promise.resolve(reply({ error: mode === '404' ? 'not_found' : 'forbidden' }, mode === '404' ? 404 : 403));
      if (url === `/api/transfers/${next.id}`) return Promise.resolve(reply(next));
      return undefined;
    });
    f.env.record = record;
    f.controller.dispatchRecovery = createTransferDispatchRecovery();
    f.controller.receiptRecovery = createTransferReceiptRecovery();
    const element = () => mode === 'strict-unmount' ? <StrictMode>{f.element({ ownerTag: f.ownerTag, id: record.id })}</StrictMode> : f.element({ ownerTag: f.ownerTag, id: record.id });
    const view = render(element());
    await screen.findByRole('heading', { name: record.reference });
    const trigger = screen.getByRole('button', { name: lane === 'decision' ? 'Aprobar solicitud' : lane === 'dispatch' ? 'Despachar solicitud' : 'Recibir solicitud' });
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog');
    if (lane === 'receipt') {
      for (const input of within(dialog).getAllByLabelText(/Cantidad recibida/)) fireEvent.change(input, { target: { value: '1' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Revisar recepción' }));
    }
    await act(async () => {});
    const back = screen.getByRole('button', { name: 'Volver a pendientes' });
    const triggerFocus = vi.spyOn(trigger, 'focus');
    const backFocus = vi.spyOn(back, 'focus');
    if (mode === '403' || mode === '404') {
      fireEvent.click(within(dialog).getByRole('button', { name: /^Confirmar (aprobación|despacho|recepción)$/ }));
      await screen.findByText('La solicitud no está disponible.');
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    } else if (mode === 'authority') {
      f.env.current = authority(actor, 2); view.rerender(element());
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    } else if (mode === 'unmount' || mode === 'strict-unmount') view.unmount();
    else {
      fireEvent.click(mode === 'inventory' ? screen.getByRole('button', { name: 'Volver al inventario' }) : back);
      if (mode === 'inventory') expect(f.back).toHaveBeenCalledOnce();
      if (mode === 'selection') {
        await screen.findByRole('heading', { name: 'Transferencias pendientes' });
        fireEvent.click(screen.getByRole('button', { name: `Ver detalle ${next.reference}` }));
        await screen.findByRole('heading', { name: next.reference });
        expect(screen.getByRole('button', { name: lane === 'decision' ? 'Aprobar solicitud' : lane === 'dispatch' ? 'Despachar solicitud' : 'Recibir solicitud' })).toBeEnabled();
      }
    }
    await act(async () => {});
    expect(triggerFocus).not.toHaveBeenCalled();
    expect(backFocus).not.toHaveBeenCalled();
    const before = f.fetch.mock.calls.length;
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await act(async () => {});
    expect(f.fetch.mock.calls).toHaveLength(before);
    expect(f.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(mode === '403' || mode === '404' ? 1 : 0);
    expect(triggerFocus).not.toHaveBeenCalled();
    expect(backFocus).not.toHaveBeenCalled();
    triggerFocus.mockRestore(); backFocus.mockRestore();
    view.unmount();
  });
});

describe('A06a real list/detail decision bindings', () => {
  it.each([[1, 2], [1, 3], [2, 3], [3, 2], [2, 1], [3, 1]])('keeps confirmed whole-request outcomes truthful for %s → %s while refresh is pending', async (origin, destination) => {
    for (const action of ['approve', 'reject'] as const) {
      let decided = false;
      const held = deferred();
      const f = fixture(destination === 1 ? 1 : origin, (url, init) => {
        if (init.method === 'POST') {
          decided = true;
          return Promise.resolve(reply(wire(origin, destination, '9007199254740993', action === 'approve' ? 'approved' : 'rejected')));
        }
        if (decided && url === '/api/transfers/9007199254740993') return held.promise;
        return undefined;
      });
      f.env.record = wire(origin, destination);
      const view = render(f.element({ ownerTag: f.ownerTag, id: f.env.record.id }));
      await screen.findByRole('heading', { name: 'TR-9007199254740993' });
      const noun = destination === 1 ? 'envío' : 'solicitud';
      fireEvent.click(screen.getByRole('button', { name: `${action === 'approve' ? 'Aprobar' : 'Rechazar'} ${noun}` }));
      const modal = screen.getByRole('dialog');
      expect(modal).toHaveTextContent('18446744073709551614');
      fireEvent.click(within(modal).getByRole('button', { name: action === 'approve' ? 'Confirmar aprobación' : 'Confirmar rechazo' }));
      await waitFor(() => expect(f.controller.confirmTransferDecision).toHaveBeenCalledOnce());
      const summary = screen.getByLabelText('Resumen de solicitud');
      expect(summary).toHaveTextContent(action === 'approve' ? `está reservada en ${locations[origin - 1]}` : 'completa fue rechazada');
      expect(within(summary).getByText('01/01/2028 · 20:00 (hora Bolivia)')).toHaveAttribute('datetime', '2028-01-02T00:00:00.000000001Z');
      expect(screen.queryByText('Esta solicitud todavía no reserva ni mueve stock.')).not.toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Solicitud Pending' })).not.toBeInTheDocument();
      expect(screen.getByRole('table', { name: 'Baterías solicitadas' })).toHaveTextContent('9223372036854775807');
      expect(screen.queryByRole('button', { name: `Aprobar ${noun}` })).not.toBeInTheDocument();
      expect(f.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
      await act(async () => held.resolve(reply(wire(origin, destination, '9007199254740993', action === 'approve' ? 'approved' : 'rejected'))));
      view.unmount();
    }
  });
  it.each([[1, 2, 2], [1, 3, 3], [2, 3, 3], [3, 2, 2], [2, 1, 2], [3, 1, 3]])('does not render hidden-but-enabled decisions for requester %s → %s assigned %s', async (origin, destination, assigned) => {
    const f = fixture(assigned);
    f.env.record = wire(origin, destination);
    render(f.element({ ownerTag: f.ownerTag, id: f.env.record.id }));
    await screen.findByRole('heading', { name: 'TR-9007199254740993' });
    expect(screen.queryByRole('button', { name: /^(Aprobar|Rechazar) / })).not.toBeInTheDocument();
    expect(f.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  });
  it.each(['approve', 'reject'] as const)('keeps unknown %s reachable after Back and child remount; explicit retry uses the original ID/action', async action => {
    let posts = 0;
    const f = fixture(1, (url, init) => {
      if (init.method === 'POST') {
        posts++;
        if (posts === 1) return Promise.reject(new Error('PRIVATE timeout unknown'));
        return Promise.resolve(reply(wire(1, 2, '9007199254740993', action === 'approve' ? 'approved' : 'rejected')));
      }
      return undefined;
    });
    let view = render(f.element({ ownerTag: f.ownerTag, id: f.env.record.id }));
    await screen.findByRole('heading', { name: 'TR-9007199254740993' });
    fireEvent.click(screen.getByRole('button', { name: action === 'approve' ? 'Aprobar solicitud' : 'Rechazar solicitud' }));
    fireEvent.click(screen.getByRole('button', { name: action === 'approve' ? 'Confirmar aprobación' : 'Confirmar rechazo' }));
    await screen.findByRole('button', { name: 'Consultar resultado original' });
    fireEvent.click(screen.getByRole('button', { name: 'Volver al detalle' }));
    fireEvent.click(screen.getByRole('button', { name: 'Volver a pendientes' }));
    expect(screen.getByLabelText('Recuperación de decisión')).toHaveTextContent('TR-9007199254740993');
    expect(posts).toBe(1);
    view.unmount();
    view = render(f.element());
    await screen.findByRole('button', { name: 'Consultar resultado original' });
    expect(posts).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Consultar resultado original' }));
    await screen.findByRole('button', { name: action === 'approve' ? 'Reintentar misma aprobación' : 'Reintentar mismo rechazo' });
    expect(f.controller.confirmTransferDecision).not.toHaveBeenCalled();
    expect(posts).toBe(1);
    expect(document.body).not.toHaveTextContent('PRIVATE');
    fireEvent.click(screen.getByRole('button', { name: action === 'approve' ? 'Reintentar misma aprobación' : 'Reintentar mismo rechazo' }));
    await waitFor(() => expect(f.controller.confirmTransferDecision).toHaveBeenCalledOnce());
    expect(f.fetch.mock.calls.filter(([, init]) => init?.method === 'POST').map(([url]) => url)).toEqual([`/api/transfers/9007199254740993/${action}`, `/api/transfers/9007199254740993/${action}`]);
    view.unmount();
  });
  it.each([403, 404])('removes the complete private selected record after decision HTTP %s', async status => {
    const f = fixture(1, (_url, init) => init.method === 'POST' ? Promise.resolve(reply({ error: status === 403 ? 'forbidden' : 'not_found' }, status)) : undefined);
    render(f.element({ ownerTag: f.ownerTag, id: f.env.record.id }));
    await screen.findByRole('heading', { name: 'TR-9007199254740993' });
    fireEvent.click(screen.getByRole('button', { name: 'Aprobar solicitud' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar aprobación' }));
    await screen.findByText('La solicitud no está disponible.');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Recuperación de decisión')).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('TR-9007199254740993');
    expect(document.body).not.toHaveTextContent('75.125');
    expect(document.body).not.toHaveTextContent('9223372036854775807');
  });
  it('refreshes advisory origin stock passively after shortage without replacing the immutable request or automatically retrying', async () => {
    const f = fixture(1, (_url, init) => init.method === 'POST' ? Promise.resolve(reply({ error: 'insufficient_stock' }, 409)) : undefined);
    render(f.element({ ownerTag: f.ownerTag, id: f.env.record.id }));
    await screen.findByRole('heading', { name: 'TR-9007199254740993' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Actualizar stock de origen' })).toBeEnabled());
    const before = f.fetch.mock.calls.filter(([url]) => String(url).startsWith('/api/inventory?')).length;
    fireEvent.click(screen.getByRole('button', { name: 'Aprobar solicitud' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar aprobación' }));
    await screen.findByRole('button', { name: 'Consultar resultado original' });
    await waitFor(() => expect(f.fetch.mock.calls.filter(([url]) => String(url).startsWith('/api/inventory?'))).toHaveLength(before + 1));
    expect(screen.getByRole('table', { name: 'Baterías solicitadas' })).toHaveTextContent('18446744073709551614');
    expect(f.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(f.controller.confirmTransferDecision).not.toHaveBeenCalled();
    for (const [url, init] of f.fetch.mock.calls) if (String(url).startsWith('/api/inventory?')) expect(new Headers(init?.headers).get('X-Luson-Passive')).toBe('1');
  });
  it('original recovery is not replaced when a different list record is selected', async () => {
    const f = fixture(1, (_url, init) => init.method === 'POST' ? Promise.reject(new Error('lost')) : undefined);
    render(f.element({ ownerTag: f.ownerTag, id: f.env.record.id }));
    await screen.findByRole('heading', { name: 'TR-9007199254740993' });
    fireEvent.click(screen.getByRole('button', { name: 'Aprobar solicitud' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar aprobación' }));
    await screen.findByRole('button', { name: 'Consultar resultado original' });
    fireEvent.click(screen.getByRole('button', { name: 'Volver al detalle' }));
    fireEvent.click(screen.getByRole('button', { name: 'Volver a pendientes' }));
    f.env.record = wire(1, 2, '9007199254740992');
    act(() => { for (const listener of f.listeners) listener(); });
    const row = await screen.findByRole('button', { name: 'Ver detalle TR-9007199254740992' });
    fireEvent.click(row);
    await screen.findByRole('heading', { name: 'TR-9007199254740992' });
    expect(screen.getByRole('button', { name: 'Aprobar solicitud' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar misma aprobación' }));
    await screen.findByRole('button', { name: 'Consultar resultado original' });
    expect(f.fetch.mock.calls.filter(([, init]) => init?.method === 'POST').map(([url]) => url)).toEqual(['/api/transfers/9007199254740993/approve', '/api/transfers/9007199254740993/approve']);
  });
});

describe('A05a truthful terminal detail', () => {
  it.each(['approved', 'rejected'] as const)('shows %s without Pending-only reservation claims', async status => {
    const label = status === 'approved' ? 'Aprobada' : 'Rechazada';
    const f = fixture(1, url => url === '/api/transfers/9007199254740993'
      ? Promise.resolve(reply({ ...wire(), status, decision_location_id: 1, decided_at: '2028-01-02T00:00:00.000000001Z' })) : undefined);
    render(f.element({ ownerTag: f.ownerTag, id: '9007199254740993' }));
    expect(await screen.findByText(label, { selector: '.pending-status' })).toBeVisible();
    expect(screen.getByRole('heading', { name: `Solicitud ${label}` })).toBeVisible();
    expect(screen.queryByText('Esta solicitud todavía no reserva ni mueve stock.')).not.toBeInTheDocument();
    expect(screen.queryByText(/La aprobación deberá revalidar/)).not.toBeInTheDocument();
    expect(within(screen.getByLabelText('Resumen de solicitud')).getByText('01/01/2028 · 20:00 (hora Bolivia)')).toHaveAttribute('datetime', '2028-01-02T00:00:00.000000001Z');
    for (const name of ['Aprobar', 'Rechazar', 'Confirmar aprobación']) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
  });
});

describe('F2 list presentation', () => {
  it('keeps independent counter semantics in compact expandable help', async () => {
    const f = fixture(); render(f.element()); await loaded();
    const counters = screen.getByRole('region', { name: 'Contadores de solicitudes' });
    const help = within(counters).getByText('Sobre los totales').closest('details');
    expect(help).not.toBeNull();
    expect(help).not.toHaveAttribute('open');
    expect(help).toHaveTextContent('Totales independientes del filtro');
    expect(help).toHaveTextContent('aprobar, despachar o recibir');
    expect(counters.querySelectorAll('dd')).toHaveLength(2);
  });
  it('groups mobile route participants, flow and exact variant quantities', async () => {
    const f = fixture(1); f.env.count = '1'; render(f.element());
    await screen.findByText('1 solicitud pendiente');
    const card = document.querySelector('.pending-cards article')!;
    expect(card.querySelector('header .pending-flow')).toHaveTextContent('Solicitud a Almacén');
    const route = card.querySelector('.pending-card-route');
    expect(route).toHaveTextContent('Ruta: Almacén → Sucursal A');
    expect(route).toHaveTextContent('Ubicación creadora: Sucursal A');
    expect(route).toHaveTextContent('Requiere aprobación de: Almacén');
    expect(within(card as HTMLElement).getByRole('heading', { name: 'Detalle del envío (2 variantes)' })).toBeInTheDocument();
    expect([...card.querySelectorAll('.pending-variant-quantity')].map(node => node.textContent)).toEqual([
      '9223372036854775807 unidades', '9223372036854775807 unidades',
    ]);
  });
  it.each(['0', '1'])('keeps pagination within the list region with %s records', async count => {
    const f = fixture(); f.env.count = count; render(f.element());
    await screen.findByText(count === '0' ? '0 solicitudes pendientes' : '1 solicitud pendiente');
    const results = screen.getByRole('region', { name: 'Listado de transferencias' });
    expect(within(results).getByLabelText('Ir a página')).toBeInTheDocument();
    expect(results.querySelector('footer')).toHaveAttribute('aria-label', 'Paginación de transferencias');
    if (count === '1') expect(within(results).getByRole('table')).toBeInTheDocument();
    else expect(within(results).getByRole('status')).toHaveTextContent('No hay solicitudes pendientes');
  });
  it.each([1, 2, 3])('uses direct-send copy only for assigned warehouse %s', async id => {
    const f = fixture(id); if (id === 3) f.env.record = wire(2, 3);
    render(<TransferPending controller={f.controller} ownerTag={f.ownerTag} onInventory={f.back} creationAvailable onCreate={vi.fn()} />);
    await loaded();
    expect(screen.getByRole('button', { name: id === 1 ? 'Crear envío' : 'Nueva transferencia' })).toHaveTextContent(id === 1 ? 'Crear envío' : 'Nueva transferencia');
    const heading = screen.getByRole('heading', { name: 'Transferencias pendientes' });
    expect(heading.firstChild?.textContent).toBe('Transferencias');
    expect(screen.getByText('Consultá las transferencias de tu ubicación asignada.')).toBeVisible();
    expect(screen.queryByRole('option', { name: 'Todas' })).not.toBeInTheDocument();
  });
  it.each([
    ['pending', 'pendiente'], ['approved', 'aprobada'], ['rejected', 'rechazada'],
    ['in_transit', 'en tránsito'], ['received', 'recibida'], ['cancelled', 'cancelada'],
  ])('uses singular summary for one %s request without changing independent counters', async (status, singular) => {
    const f = fixture(2, url => {
      if (!url.startsWith('/api/transfers?')) return undefined;
      const selectedStatus = new URL(url, 'http://localhost').searchParams.get('status')!;
      const base = wire(1, 2, '9007199254740993', selectedStatus);
      const record = selectedStatus === 'received' ? receivedWire()
        : selectedStatus === 'in_transit' ? { ...base, dispatch_location_id: 1, dispatched_at: correctionStamp }
          : selectedStatus === 'cancelled' ? { ...base, cancellation_location_id: 2, cancelled_at: correctionStamp } : base;
      return Promise.resolve(reply({ page: 1, page_size: 25, status: selectedStatus, total_count: '1', records: [record] }));
    });
    render(f.element());
    await screen.findByText('1 solicitud pendiente');
    fireEvent.change(screen.getByLabelText('Estado de transferencia'), { target: { value: status } });
    expect(await screen.findByText(`1 solicitud ${singular}`)).toHaveAttribute('aria-live', 'polite');
    const counters = screen.getByRole('region', { name: 'Contadores de solicitudes' });
    expect(counters).toHaveTextContent('9007199254740995');
    expect(counters).toHaveTextContent('9007199254740994');
  });
});

describe('R05-U2 pending header action stack', () => {
  it.each([2, 3])('groups branch %s creation before the live count separately from the title', async id => {
    const f = fixture(id); if (id === 3) f.env.record = wire(2, 3);
    f.env.count = '3';
    render(<TransferPending controller={f.controller} ownerTag={f.ownerTag} onInventory={f.back} creationAvailable onCreate={vi.fn()} />);
    const count = await screen.findByText('3 solicitudes pendientes');
    const button = screen.getByRole('button', { name: 'Nueva transferencia' });
    const title = screen.getByRole('heading', { name: 'Transferencias pendientes' });
    const header = title.closest('header')!;
    const actions = header.querySelector('.pending-heading-actions');
    expect(actions).not.toBeNull();
    expect(button.parentElement).toBe(actions);
    expect(count.parentElement).toBe(actions);
    expect(Array.from(actions!.children)).toEqual([button, count]);
    expect(actions).not.toContainElement(title);
    expect(title.parentElement?.parentElement).toBe(header);
    expect(actions!.parentElement).toBe(header);
    expect(count).toHaveAttribute('aria-live', 'polite');
    await detail();
    expect(screen.queryByRole('button', { name: 'Nueva transferencia' })).not.toBeInTheDocument();
    expect(screen.queryByText('3 solicitudes pendientes')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Contadores de solicitudes' })).toHaveAttribute('aria-live', 'polite');
    fireEvent.click(screen.getByRole('button', { name: 'Volver a pendientes' }));
    expect(await screen.findByText('3 solicitudes pendientes')).toHaveAttribute('aria-live', 'polite');
  });
  it('keeps warehouse count separate from the title beside the creation action', async () => {
    const f = fixture(1);
    render(<TransferPending controller={f.controller} ownerTag={f.ownerTag} onInventory={f.back} creationAvailable onCreate={vi.fn()} />);
    await loaded();
    const title = screen.getByRole('heading', { name: 'Transferencias pendientes' });
    const count = screen.getByText('9007199254740993 solicitudes pendientes');
    expect(count.closest('header')).toBe(title.closest('header'));
    expect(screen.getByRole('button', { name: 'Crear envío' })).toBeEnabled();
    await detail();
    expect(screen.queryByRole('button', { name: 'Crear envío' })).not.toBeInTheDocument();
  });
});

describe('R05-U1 list creation entry', () => {
  it.each([1, 2, 3])('offers creation on the assigned location %s list, never detail', async id => {
    const f = fixture(id); if (id === 3) f.env.record = wire(2, 3);
    const create = vi.fn();
    render(<TransferPending controller={f.controller} ownerTag={f.ownerTag} onInventory={f.back} creationAvailable onCreate={create} />);
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: id === 1 ? 'Crear envío' : 'Nueva transferencia' }));
    expect(create).toHaveBeenCalledOnce();
    await detail();
    expect(screen.queryByRole('button', { name: id === 1 ? 'Crear envío' : 'Nueva transferencia' })).not.toBeInTheDocument();
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
    expect(screen.queryByText('1 solicitud pendiente')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Aprobar|Rechazar|Cancelar|Despachar/ })).not.toBeInTheDocument();
  });
  it.each([[1, 2, 'Solicitud a Almacén'], [2, 3, 'Solicitud entre sucursales'], [2, 1, 'Propuesta de envío a Almacén']])('labels physical route %s to %s honestly', async (origin, destination, label) => {
    const f = fixture(2); f.env.record = wire(Number(origin), Number(destination)); render(f.element()); await loaded();
    expect(screen.getByRole('table')).toHaveTextContent(String(label)); await detail();
    const route = screen.getByRole('region', { name: 'Ruta física' });
    expect(route.querySelector(':scope > div:first-child strong')).toHaveTextContent(locations[Number(origin) - 1]);
    expect(route.querySelector(':scope > div:last-child strong')).toHaveTextContent(locations[Number(destination) - 1]);
    expect(route.querySelector('b')).toHaveTextContent('→');
    expect(screen.getByLabelText('Resumen de solicitud')).toHaveTextContent('Esta solicitud todavía no reserva ni mueve stock.');
  });
  it('keeps exact Ah, nanosecond UTC, quantities and physical creator/approver in detail', async () => {
    const f = fixture(); render(f.element()); await loaded(); await detail();
    const items = screen.getByRole('table', { name: 'Baterías solicitadas' });
    expect(items).toHaveTextContent('75.125 Ah'); expect(items).toHaveTextContent('Izquierda [L]'); expect(items).toHaveTextContent('Derecha [R]');
    expect(within(items).getAllByText('9223372036854775807')).toHaveLength(2);
    expect(within(screen.getByLabelText('Resumen de solicitud')).getByText('31/12/2027 · 20:00 (hora Bolivia)')).toHaveAttribute('datetime', '2028-01-01T00:00:00.123456789Z');
    expect(screen.getByLabelText('Resumen de solicitud')).toHaveTextContent('Ubicación creadoraSucursal A');
    const history = screen.getByRole('region', { name: 'Historial de la solicitud' });
    expect(within(history).getAllByRole('listitem')).toHaveLength(1);
    expect(history).toHaveTextContent('Solicitud creada');
    expect(history).toHaveTextContent('Ubicación: Sucursal A');
    expect(within(history).getByText('31/12/2027 · 20:00 (hora Bolivia)')).toHaveAttribute('datetime', '2028-01-01T00:00:00.123456789Z');
    expect(history).not.toHaveTextContent(/aprobada|rechazada|reservad|despacho|recepción/i);
    expect(screen.queryByRole('button', { name: /Aprobar|Rechazar/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Empleado|Verificadas en origen/)).not.toBeInTheDocument();
    expect(isPassive(calls(f, true)[0])).toBe(false);
    expect(calls(f, true)[0][1]).toMatchObject({ credentials: 'same-origin', cache: 'no-store', method: 'GET' });
  });
  it('does not invent zero while loading or echo selected ID before detail validation', async () => {
    const list = deferred(); const item = deferred();
    const f = fixture(2, url => url.startsWith('/api/transfers?') ? list.promise
      : url === '/api/transfers/123456789' ? item.promise : undefined);
    render(f.element({ ownerTag: f.ownerTag, id: '123456789' }));
    expect(screen.queryByText('0 solicitudes pendientes')).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('123456789');
    await waitFor(() => expect(calls(f, true)).toHaveLength(1));
    expect(isPassive(calls(f, true)[0])).toBe(false);
    item.resolve(reply({ error: 'not_found' }, 404));
    expect(await screen.findByText('La solicitud no está disponible.')).toBeVisible();
    expect(document.body).not.toHaveTextContent('123456789');
    list.resolve(reply({ page: 1, page_size: 25, status: 'pending', total_count: '0', records: [] }));
    expect(screen.queryByText('0 solicitudes pendientes')).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('123456789');
    fireEvent.click(screen.getByRole('button', { name: 'Volver a pendientes' }));
    expect(await screen.findByText('0 solicitudes pendientes')).toBeVisible();
  });
  it.each(['private-third-account', 'unknown-id'])('uses identical generic 404 presentation for %s', async () => {
    const f = fixture(3, url => url === '/api/transfers/counts' ? undefined
      : url === '/api/transfers/999999999' ? Promise.resolve(reply({ error: 'not_found' }, 404))
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
    await screen.findByText('1 solicitud pendiente');
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
    const item = deferred(); const f = fixture(2, url => url === '/api/transfers/9007199254740993' ? item.promise : undefined);
    const view = render(f.element()); await loaded(); fireEvent.click(screen.getByRole('button', { name: 'Ver detalle TR-9007199254740993' }));
    await waitFor(() => expect(calls(f, true)).toHaveLength(1));
    f.env.current = authority(3, 2); view.rerender(f.element());
    await act(async () => { if (outcome === 'success') item.resolve(reply(f.env.record)); else item.reject(new Error('OLD PRIVATE FAILURE')); });
    expect(document.body).not.toHaveTextContent('TR-9007199254740993'); expect(document.body).not.toHaveTextContent('OLD PRIVATE FAILURE');
    expect(calls(f, true)).toHaveLength(1);
  });
  it('invalidates both active lanes passively and coalesces a dirty detail flight', async () => {
    let next: ReturnType<typeof deferred> | null = null;
    const f = fixture(2, url => url === '/api/transfers/9007199254740993' && next ? next.promise : undefined);
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
