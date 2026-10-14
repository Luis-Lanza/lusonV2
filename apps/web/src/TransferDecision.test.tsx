import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TransferDecision from './TransferDecision';
import { transferViewOwner } from './TransferPending';
import { useTransfers } from './useTransfers';
import { parseTransferRecord } from './transferModel';
import { createTransferDecisionRecovery } from './transferDecisionRecovery';
import type { TransferAuthority, TransferController } from './useInventory';

const names = ['Almacén', 'Sucursal A', 'Sucursal B'];
function wire(origin = 1, destination = 2, status = 'pending', id = '9007199254740993') {
  const creator = destination === 1 ? origin : destination;
  const approver = destination === 1 ? 1 : origin;
  return {
    id, reference: `TR-${id}`, kind: destination === 1 ? 'send_to_warehouse' : 'request_stock', status,
    created_at: '2028-01-01T00:00:00.123456789Z',
    creator_location_id: creator, creator_location_name: names[creator - 1],
    origin_location_id: origin, origin_location_name: names[origin - 1],
    destination_location_id: destination, destination_location_name: names[destination - 1],
    approver_location_id: approver, approver_location_name: names[approver - 1],
    ...(status === 'pending' ? {} : { decision_location_id: approver, decided_at: '2028-01-02T00:00:00.000000001Z' }),
    items: [1, 2].map(variant_id => ({ variant_id, brand: 'Original', model: `Immutable-${variant_id}`,
      capacity_ah: '75.125', polarity: variant_id === 1 ? 'L' : 'R', quantity: '9223372036854775807' })),
  };
}
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
function deferred() {
  let resolve!: (value: Response) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Response>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(origin = 1, destination = 2, assigned = destination === 1 ? 1 : origin,
  transport?: (url: string, init: RequestInit) => Promise<Response>) {
  const env: { current: TransferAuthority; record: ReturnType<typeof wire> } = {
    current: { epoch: 1, ready: true, sessionGeneration: 1, session: { authenticated: true, csrf_token: 'a'.repeat(43),
      identity: { account_id: assigned, username: 'test', location: { id: assigned, name: names[assigned - 1] } }, expires_at: '2030-01-01T00:00:00Z' } },
    record: wire(origin, destination),
  };
  const controller: TransferController = {
    authorityEpoch: 1, getTransferAuthority: () => env.current,
    subscribeTransferInvalidation: () => () => {},
    settleUnauthorized: vi.fn(async () => 'unavailable' as const),
    decisionRecovery: createTransferDecisionRecovery(), confirmTransferDecision: vi.fn(),
  };
  const fetch = vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (transport) return transport(url, init);
    const status = url.endsWith('/approve') ? 'approved' : url.endsWith('/reject') ? 'rejected' : env.record.status;
    return Promise.resolve(reply(wire(origin, destination, status, env.record.id)));
  });
  vi.stubGlobal('fetch', fetch);
  const ownerTag = transferViewOwner(env.current)!;
  const privateUnavailable = vi.fn();
  function Harness({ noRecord = false }: { noRecord?: boolean }) {
    const transfers = useTransfers({ controller });
    const record = parseTransferRecord(JSON.stringify(env.record));
    return <TransferDecision controller={controller} ownerTag={ownerTag} transfers={transfers}
      record={noRecord ? null : record} onPrivateUnavailable={privateUnavailable} />;
  }
  const element = (noRecord = false) => <Harness noRecord={noRecord} />;
  return { env, controller, fetch, element, privateUnavailable };
}
function open(action: 'approve' | 'reject', send = false) {
  fireEvent.click(screen.getByRole('button', { name: `${action === 'approve' ? 'Aprobar' : 'Rechazar'} ${send ? 'envío' : 'solicitud'}` }));
  return screen.getByRole('dialog');
}
function confirm(action: 'approve' | 'reject') {
  fireEvent.click(screen.getByRole('button', { name: action === 'approve' ? 'Confirmar aprobación' : 'Confirmar rechazo' }));
}
async function uncertain() { await screen.findByRole('button', { name: 'Consultar resultado original' }); }
afterEach(() => vi.unstubAllGlobals());

it('presents a cancelled decision conflict date without claiming the original action succeeded', async () => {
  const cancelled_at = '2028-01-03T00:00:00.000000002Z';
  const f = fixture(1, 2, 1, async (_url, init) => {
    if (init.method === 'POST') throw new Error('Lost reply');
    return reply({ ...wire(), status: 'cancelled', cancellation_location_id: 2, cancelled_at });
  });
  render(f.element()); open('approve'); confirm('approve');
  fireEvent.click(await screen.findByRole('button', { name: 'Consultar resultado original' }));
  const time = await screen.findByText('02/01/2028 · 20:00 (hora Bolivia)');
  expect(time).toHaveAttribute('datetime', cancelled_at);
  expect(time).toHaveAttribute('title', cancelled_at);
  expect(screen.getByRole('region', { name: 'Recuperación de decisión' })).toHaveTextContent('No se confirmó la acción original');
});

describe('A06a explicit immutable confirmations', () => {
  it.each(['terminal', 'differentID'])('blocks a retained confirmation after the current view becomes %s without replacing the reviewed original', async mode => {
    const f = fixture();
    const view = render(f.element());
    const dialog = open('approve');
    const confirm = within(dialog).getByRole('button', { name: 'Confirmar aprobación' });
    f.env.record = mode === 'terminal' ? wire(1, 2, 'rejected') : wire(1, 2, 'pending', '9007199254740992');
    view.rerender(f.element());
    fireEvent.click(confirm);
    await act(async () => {});
    expect(f.fetch).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Confirmar aprobación' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog')).toHaveTextContent('TR-9007199254740993');
    expect(screen.getByRole('dialog')).not.toHaveTextContent('TR-9007199254740992');
  });
  it.each([[1, 2], [1, 3], [2, 3], [3, 2], [2, 1], [3, 1]])('binds both actions to persisted approver for %s → %s and reserves only the whole original request', async (origin, destination) => {
    for (const action of ['approve', 'reject'] as const) {
      const f = fixture(origin, destination);
      const view = render(f.element());
      expect(f.fetch).not.toHaveBeenCalled();
      const dialog = open(action, destination === 1);
      expect(dialog).toHaveTextContent(`TR-9007199254740993 · ${names[origin - 1]} → ${names[destination - 1]}`);
      const table = within(dialog).getByRole('table', { name: 'Solicitud completa a confirmar' });
      expect(table).toHaveTextContent('18446744073709551614');
      expect(within(table).getAllByText('9223372036854775807')).toHaveLength(2);
      expect(within(table).getAllByText('75.125 Ah')).toHaveLength(2);
      expect(Array.from(table.querySelectorAll('tbody tr')).map(row => row.getAttribute('data-variant-id'))).toEqual(['1', '2']);
      expect(table).toHaveTextContent('Izquierda [L]');
      expect(table).toHaveTextContent('Derecha [R]');
      expect(within(table).getAllByRole('columnheader')).toHaveLength(action === 'approve' ? 4 : 3);
      expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument();
      expect(within(dialog).queryByRole('spinbutton')).not.toBeInTheDocument();
      expect(dialog).toHaveTextContent(action === 'approve' ? `cantidades completas en ${names[origin - 1]}` : 'No se liberarán reservas ni se moverán existencias');
      expect(dialog).not.toHaveTextContent('cancelar antes');
      expect(f.fetch).not.toHaveBeenCalled();
      confirm(action);
      await waitFor(() => expect(f.controller.confirmTransferDecision).toHaveBeenCalledOnce());
      expect(f.fetch).toHaveBeenCalledExactlyOnceWith(`/api/transfers/9007199254740993/${action}`, expect.objectContaining({ method: 'POST', body: '{}', credentials: 'same-origin', cache: 'no-store' }));
      const init = f.fetch.mock.calls[0][1];
      expect(new Headers(init?.headers).get('X-CSRF-Token')).toBe('a'.repeat(43));
      expect(new Headers(init?.headers).has('X-Luson-Passive')).toBe(false);
      expect(f.controller.confirmTransferDecision).toHaveBeenCalledWith(expect.objectContaining({ location: destination === 1 ? 1 : origin }), action === 'approve' ? 'approved' : 'rejected');
      const recovery = screen.getByRole('region', { name: 'Recuperación de decisión' });
      const time = within(recovery).getByText('01/01/2028 · 20:00 (hora Bolivia)');
      expect(time).toHaveAttribute('datetime', '2028-01-02T00:00:00.000000001Z');
      expect(time).toHaveAttribute('title', '2028-01-02T00:00:00.000000001Z');
      expect(screen.queryByRole('button', { name: /^(Aprobar|Rechazar) / })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Consultar resultado original' })).not.toBeInTheDocument();
      view.unmount();
    }
  });
  it.each([[1, 2, 2], [1, 3, 3], [2, 3, 3], [3, 2, 2], [2, 1, 2], [3, 1, 3]])('conceals both decision controls for requester %s → %s assigned %s', (origin, destination, assigned) => {
    const f = fixture(origin, destination, assigned);
    render(f.element());
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it.each(['approved', 'rejected'])('conceals actions for terminal %s records under each participant', status => {
    for (const assigned of [1, 2]) {
      const f = fixture(1, 2, assigned);
      f.env.record = wire(1, 2, status);
      const view = render(f.element());
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
      expect(f.fetch).not.toHaveBeenCalled();
      view.unmount();
    }
  });
  it.each(['approve', 'reject'] as const)('traps keyboard focus, closes via Escape/Cancel/close, restores trigger, and never sends %s', action => {
    const f = fixture();
    render(f.element());
    const trigger = screen.getByRole('button', { name: action === 'approve' ? 'Aprobar solicitud' : 'Rechazar solicitud' });
    for (const method of ['escape', 'cancel', 'close']) {
      const dialog = open(action);
      const close = within(dialog).getByRole('button', { name: 'Cerrar confirmación' });
      const last = within(dialog).getByRole('button', { name: action === 'approve' ? 'Confirmar aprobación' : 'Confirmar rechazo' });
      expect(close).toHaveFocus();
      fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
      expect(last).toHaveFocus();
      fireEvent.keyDown(last, { key: 'Tab' });
      expect(close).toHaveFocus();
      if (method === 'escape') fireEvent.keyDown(dialog, { key: 'Escape' });
      if (method === 'cancel') fireEvent.click(within(dialog).getByRole('button', { name: 'Volver al detalle' }));
      if (method === 'close') fireEvent.click(close);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
    }
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it.each(['approve', 'reject'] as const)('nonoverlap and busy modal focus protect double %s clicks and Escape', async action => {
    const d = deferred();
    const f = fixture(1, 2, 1, () => d.promise);
    render(f.element());
    const dialog = open(action);
    const button = within(dialog).getByRole('button', { name: action === 'approve' ? 'Confirmar aprobación' : 'Confirmar rechazo' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(dialog).toHaveAttribute('aria-busy', 'true');
    expect(dialog).toHaveFocus();
    expect(within(dialog).getByRole('button', { name: 'Cerrar confirmación' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Volver al detalle' })).toBeDisabled();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(dialog).toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(dialog).toHaveFocus();
    await act(async () => d.resolve(reply(wire(1, 2, action === 'approve' ? 'approved' : 'rejected'))));
    expect(dialog).toHaveAttribute('aria-busy', 'false');
    expect(within(dialog).getByRole('button', { name: 'Cerrar confirmación' })).toHaveFocus();
  });
  it.each(['unready', 'account', 'location', 'csrf', 'generation', 'username', 'expiry'])('blocks retained confirm/Escape callbacks and masks review on same-session %s mutation before rerender', async mode => {
    const f = fixture();
    const view = render(f.element());
    const dialog = open('approve');
    const button = within(dialog).getByRole('button', { name: 'Confirmar aprobación' });
    const session = f.env.current.session!;
    if (!session.authenticated) throw new Error('fixture');
    if (mode === 'unready') f.env.current.ready = false;
    if (mode === 'account') session.identity.account_id = 2;
    if (mode === 'location') session.identity.location.id = 2;
    if (mode === 'csrf') session.csrf_token = 'b'.repeat(43);
    if (mode === 'generation') f.env.current.sessionGeneration = 2;
    if (mode === 'username') session.identity.username = 'new';
    if (mode === 'expiry') session.expires_at = '2031-01-01T00:00:00Z';
    fireEvent.click(button);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await act(async () => {});
    expect(f.fetch).not.toHaveBeenCalled();
    view.rerender(f.element());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('Immutable');
    expect(document.body).not.toHaveTextContent('9007199254740993');
  });
});

describe('A06a controller-owned uncertain outcome recovery', () => {
  it.each(['approve', 'reject'] as const)('discards mismatched private GET outcomes while retaining the original %s capability', async action => {
    const f = fixture(1, 2, 1, async (_url, init) => {
      if (init.method === 'POST') throw new Error('unknown');
      return reply({ ...wire(1, 2, 'approved', '999'), reference: 'TR-999' });
    });
    render(f.element());
    open(action);
    confirm(action);
    await uncertain();
    fireEvent.click(screen.getByRole('button', { name: 'Consultar resultado original' }));
    await uncertain();
    expect(screen.getByLabelText('Recuperación de decisión')).toHaveTextContent('TR-9007199254740993');
    expect(document.body).not.toHaveTextContent('TR-999');
    expect(f.controller.confirmTransferDecision).not.toHaveBeenCalled();
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: action === 'approve' ? 'Reintentar misma aprobación' : 'Reintentar mismo rechazo' })).toBeEnabled();
  });
  it.each(['success', '401'])('masks an old in-flight POST %s completion without settling replacement authority', async outcome => {
    const d = deferred();
    const f = fixture(1, 2, 1, () => d.promise);
    const view = render(f.element());
    open('approve');
    confirm('approve');
    f.env.current.sessionGeneration = 2;
    view.rerender(f.element());
    await act(async () => d.resolve(outcome === 'success' ? reply(wire(1, 2, 'approved')) : reply({ error: 'unauthenticated' }, 401)));
    expect(document.body).not.toHaveTextContent('9007199254740993');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(f.controller.confirmTransferDecision).not.toHaveBeenCalled();
    expect(f.controller.settleUnauthorized).not.toHaveBeenCalled();
  });
  it.each(['approve', 'reject'] as const)('retains unknown %s, explicit GET Pending still unknown, and original same-action POST retry only', async action => {
    let posts = 0;
    const f = fixture(1, 2, 1, async (url, init) => {
      if (init.method === 'POST' && ++posts === 1) throw new Error('PRIVATE LOST REPLY');
      return reply(wire(1, 2, init.method === 'POST' ? action === 'approve' ? 'approved' : 'rejected' : 'pending'));
    });
    render(f.element());
    open(action);
    confirm(action);
    await uncertain();
    expect(document.body).not.toHaveTextContent('PRIVATE');
    fireEvent.click(screen.getByRole('button', { name: 'Volver al detalle' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Aprobar solicitud' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Rechazar solicitud' })).toBeDisabled();
    expect(f.fetch).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Consultar resultado original' }));
    await uncertain();
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.fetch.mock.calls[1]).toEqual(['/api/transfers/9007199254740993', expect.objectContaining({ method: 'GET' })]);
    expect(new Headers(f.fetch.mock.calls[1][1]?.headers).has('X-Luson-Passive')).toBe(false);
    expect(document.body).toHaveTextContent('aunque una consulta muestre Pending');
    expect(f.controller.confirmTransferDecision).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: action === 'approve' ? 'Reintentar misma aprobación' : 'Reintentar mismo rechazo' }));
    await waitFor(() => expect(f.controller.confirmTransferDecision).toHaveBeenCalledOnce());
    expect(f.fetch.mock.calls.map(([url]) => url)).toEqual([`/api/transfers/9007199254740993/${action}`, '/api/transfers/9007199254740993', `/api/transfers/9007199254740993/${action}`]);
    expect(f.fetch.mock.calls[0][1]?.body).toBe(f.fetch.mock.calls[2][1]?.body);
  });
  it.each([['approve', 'approved'], ['approve', 'rejected'], ['reject', 'rejected'], ['reject', 'approved']] as const)('shows actual %s original action → %s GET outcome without retrying a substitute action', async (action, status) => {
    const f = fixture(1, 2, 1, async (_url, init) => {
      if (init.method === 'POST') throw new Error('lost');
      return reply(wire(1, 2, status));
    });
    render(f.element());
    open(action);
    confirm(action);
    await uncertain();
    fireEvent.click(screen.getByRole('button', { name: 'Consultar resultado original' }));
    await waitFor(() => expect(f.controller.confirmTransferDecision).toHaveBeenCalledOnce());
    expect(screen.getByLabelText('Recuperación de decisión')).toHaveTextContent(status === 'approved' ? 'Estado confirmado: Aprobada.' : 'Estado confirmado: Rechazada.');
    expect(within(screen.getByLabelText('Recuperación de decisión')).getByText('01/01/2028 · 20:00 (hora Bolivia)')).toHaveAttribute('datetime', '2028-01-02T00:00:00.000000001Z');
    expect(document.body.textContent?.includes('decisión distinta')).toBe((action === 'approve') !== (status === 'approved'));
    expect(f.controller.confirmTransferDecision).toHaveBeenCalledWith(expect.anything(), status);
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: /^Reintentar/ })).not.toBeInTheDocument();
  });
  it.each([401, 403, 404, 503, 409])('sanitizes decision HTTP %s and masks private recovery when required', async status => {
    const code = status === 401 ? 'unauthenticated' : status === 403 ? 'forbidden' : status === 404 ? 'not_found' : status === 409 ? 'insufficient_stock' : 'service_unavailable';
    const f = fixture(1, 2, 1, async () => reply({ error: code }, status));
    render(f.element());
    open('approve');
    confirm('approve');
    await waitFor(() => expect(f.fetch).toHaveBeenCalledOnce());
    await act(async () => {});
    if (status === 403 || status === 404) {
      expect(f.privateUnavailable).toHaveBeenCalledOnce();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Recuperación de decisión')).not.toBeInTheDocument();
    } else {
      await uncertain();
      expect(screen.getByLabelText('Recuperación de decisión')).toHaveTextContent(status === 409 ? 'No hay disponibilidad suficiente' : status === 401 ? 'No se pudo verificar la sesión' : 'No se pudo confirmar la decisión');
    }
    expect(f.controller.settleUnauthorized).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
    expect(f.controller.confirmTransferDecision).not.toHaveBeenCalled();
    expect(document.body).not.toHaveTextContent(code);
  });
  it('prevents overlap of explicit GET and POST retry and never auto-sends on rerender/remount', async () => {
    let next: ReturnType<typeof deferred> | null = null;
    const f = fixture(1, 2, 1, async () => next ? next.promise : Promise.reject(new Error('unknown')));
    let view = render(f.element());
    open('approve');
    confirm('approve');
    await uncertain();
    view.unmount();
    view = render(f.element(true));
    expect(screen.getByRole('button', { name: 'Consultar resultado original' })).toBeEnabled();
    expect(f.fetch).toHaveBeenCalledOnce();
    next = deferred();
    const get = screen.getByRole('button', { name: 'Consultar resultado original' });
    const retry = screen.getByRole('button', { name: 'Reintentar misma aprobación' });
    fireEvent.click(get);
    fireEvent.click(get);
    fireEvent.click(retry);
    expect(f.fetch).toHaveBeenCalledTimes(2);
    await act(async () => next!.resolve(reply(wire())));
    await uncertain();
    view.rerender(f.element(true));
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });
  it('unmount abort preserves an unknown original request even when transport ignores abort', async () => {
    const d = deferred();
    const f = fixture(1, 2, 1, () => d.promise);
    let view = render(f.element());
    open('reject');
    confirm('reject');
    expect(f.fetch).toHaveBeenCalledOnce();
    view.unmount();
    expect(f.fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
    await act(async () => d.resolve(reply(wire(1, 2, 'rejected'))));
    view = render(f.element(true));
    await uncertain();
    expect(screen.getByRole('button', { name: 'Reintentar mismo rechazo' })).toBeEnabled();
    expect(f.controller.confirmTransferDecision).not.toHaveBeenCalled();
    expect(f.fetch).toHaveBeenCalledOnce();
    view.unmount();
  });
  it.each(['unready', 'account', 'location', 'csrf', 'generation'])('retained recovery handlers cannot reveal/send an old original under mutated %s authority', async mode => {
    const f = fixture(1, 2, 1, async () => Promise.reject(new Error('lost')));
    const view = render(f.element());
    open('approve');
    confirm('approve');
    await uncertain();
    const get = screen.getByRole('button', { name: 'Consultar resultado original' });
    const retry = screen.getByRole('button', { name: 'Reintentar misma aprobación' });
    const session = f.env.current.session!;
    if (!session.authenticated) throw new Error('fixture');
    if (mode === 'unready') f.env.current.ready = false;
    if (mode === 'account') session.identity.account_id = 2;
    if (mode === 'location') session.identity.location.id = 2;
    if (mode === 'csrf') session.csrf_token = 'b'.repeat(43);
    if (mode === 'generation') f.env.current.sessionGeneration = 2;
    fireEvent.click(get);
    fireEvent.click(retry);
    await act(async () => {});
    expect(f.fetch).toHaveBeenCalledOnce();
    view.rerender(f.element());
    expect(document.body).not.toHaveTextContent('9007199254740993');
    expect(screen.queryByLabelText('Recuperación de decisión')).not.toBeInTheDocument();
  });
});
