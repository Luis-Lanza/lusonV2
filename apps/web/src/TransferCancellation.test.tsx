import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TransferPending, { transferViewOwner } from './TransferPending';
import { useInventory } from './useInventory';
import { pageJSON } from './test-fixtures';

// Exercise the existing entry point: no absent TransferCancellation import can
// turn the missing creator button into a module-collection failure.
const locations = ['Almacén', 'Sucursal A', 'Sucursal B'];
function original(approved = false) {
  return { id: '1', reference: 'TR-001', kind: 'request_stock', status: approved ? 'approved' : 'pending',
    creator_location_id: 2, creator_location_name: locations[1], origin_location_id: 1, origin_location_name: locations[0],
    destination_location_id: 2, destination_location_name: locations[1], approver_location_id: 1, approver_location_name: locations[0],
    created_at: '2026-04-02T00:00:00.000000001Z',
    ...(approved ? { decision_location_id: 1, decided_at: '2026-04-03T00:00:00.000000001Z' } : {}),
    items: [{ variant_id: 201, brand: 'TOYO', model: 'Exact model', capacity_ah: '35.5', polarity: 'L', quantity: '9223372036854775807' }] };
}
const cancelled = (approved = false) => ({ ...original(approved), status: 'cancelled',
  cancellation_location_id: 2, cancelled_at: '2026-04-03T00:00:00.000000002Z' });
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>(yes => { resolve = yes; });
  return { promise, resolve };
}
function fixture(approved = false, override?: (url: string, init: RequestInit) => Promise<Response> | undefined) {
  const env = { record: original(approved), visible: true };
  const fetch = vi.fn((input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = String(input); const custom = override?.(url, init); if (custom) return custom;
    if (url === '/api/auth/session') return Promise.resolve(reply({ authenticated: true, csrf_token: 'c'.repeat(43),
      expires_at: '2030-01-01T00:00:00Z', identity: { account_id: 2, username: 'test', location: { id: 2, name: locations[1] } } }));
    if (url === '/api/inventory/metadata') return Promise.resolve(reply({ locations: locations.map((name, index) => ({ id: index + 1, name })), brands: ['TOYO'] }));
    if (url.startsWith('/api/inventory?')) {
      const location = Number(new URL(url, 'http://localhost').searchParams.get('location_id'));
      return Promise.resolve(new Response(pageJSON().replace('"location":{"id":1,"name":"Almacén"}',
        '"location":' + JSON.stringify({ id: location, name: locations[location - 1] })), { headers: { 'Content-Type': 'application/json' } }));
    }
    if (url === '/api/transfers/counts') return Promise.resolve(reply({ pending_total: '0', action_count: '0' }));
    if (url.startsWith('/api/transfers?')) return Promise.resolve(reply({ page: 1, page_size: 25, status: 'pending', total_count: '0', records: [] }));
    if (url === '/api/transfers/1') return Promise.resolve(reply(env.record));
    throw new Error('Unexpected cancellation test route');
  });
  vi.stubGlobal('fetch', fetch);
  vi.stubGlobal('EventSource', undefined);
  function Parent() {
    const controller = useInventory();
    const ownerTag = transferViewOwner(controller.getTransferAuthority());
    return env.visible && ownerTag ? <TransferPending controller={controller} ownerTag={ownerTag}
      initialDetail={{ ownerTag, id: '1' }} onInventory={() => {}} /> : null;
  }
  const view = render(<Parent />);
  const remount = () => {
    env.visible = false; view.rerender(<Parent />);
    env.visible = true; view.rerender(<Parent />);
  };
  return { env, fetch, view, remount };
}
const posts = (f: ReturnType<typeof fixture>) => f.fetch.mock.calls.filter(([url, init]) => String(url).endsWith('/cancel') && init?.method === 'POST');
async function open() {
  await screen.findByRole('heading', { name: 'TR-001' });
  fireEvent.click(screen.getByRole('button', { name: 'Cancelar solicitud' }));
  return screen.getByRole('dialog', { name: 'Confirmar cancelación' });
}
afterEach(() => vi.unstubAllGlobals());

describe('C2 creator cancellation confirmation through existing UI', () => {
  it.each([false, true])('reviews immutable request before one explicit POST and blocks busy keyboard dismissal (approved=%s)', async approved => {
    const held = deferred();
    const f = fixture(approved, (url, init) => url.endsWith('/cancel') && init.method === 'POST' ? held.promise : undefined);
    const modal = await open();
    expect(posts(f)).toHaveLength(0);
    expect(modal).toHaveTextContent('TR-001');
    expect(modal).toHaveTextContent('9223372036854775807');
    expect(modal).toHaveTextContent('35.5 Ah');
    expect(modal).toHaveTextContent('Almacén');
    expect(modal).toHaveTextContent('Sucursal A');
    expect(modal).not.toHaveTextContent('Cantidad a reservar');
    const confirm = within(modal).getByRole('button', { name: 'Confirmar cancelación' });
    fireEvent.click(confirm); fireEvent.click(confirm);
    await waitFor(() => expect(posts(f)).toHaveLength(1));
    expect(confirm).toBeDisabled();
    fireEvent.keyDown(modal, { key: 'Escape' });
    expect(modal).toBeVisible();
    expect(posts(f)[0][0]).toBe('/api/transfers/1/cancel');
    expect(posts(f)[0][1]).toMatchObject({ body: '{}', method: 'POST', credentials: 'same-origin', cache: 'no-store' });
    await act(async () => { held.resolve(reply(cancelled(approved))); });
    await screen.findByText('Cancelada', { selector: '.pending-status' });
    const recovery = screen.getByRole('region', { name: 'Recuperación de cancelación' });
    const time = within(recovery).getByText('02/04/2026 · 20:00 (hora Bolivia)');
    expect(time).toHaveAttribute('datetime', cancelled(approved).cancelled_at);
    expect(time).toHaveAttribute('title', cancelled(approved).cancelled_at);
    expect(screen.queryByRole('button', { name: 'Cancelar solicitud' })).not.toBeInTheDocument();
    expect(posts(f)).toHaveLength(1);
  });
  it.each(['rejected', 'in_transit', 'received'] as const)('never offers creator cancellation after %s', async status => {
    const approved = original(true);
    const transit = { ...approved, status: 'in_transit', dispatch_location_id: 1,
      dispatched_at: '2026-04-03T00:00:00.000000002Z' };
    const record = status === 'rejected' ? { ...approved, status } : status === 'in_transit' ? transit
      : { ...transit, status, receipt_location_id: 2, received_at: '2026-04-03T00:00:00.000000003Z',
        receipt: { items: [{ variant_id: 201, expected_quantity: '9223372036854775807',
          actual_quantity: '9223372036854775807', available_quantity: '9223372036854775807' }], exceptions: [] } };
    const f = fixture(true, url => url === '/api/transfers/1' ? Promise.resolve(reply(record)) : undefined);
    await screen.findByRole('heading', { name: 'TR-001' });
    expect(screen.queryByRole('button', { name: 'Cancelar solicitud' })).not.toBeInTheDocument();
    expect(posts(f)).toHaveLength(0);
  });
  it('traps review focus, closes with Escape without POST and restores creator trigger focus', async () => {
    const f = fixture();
    const modal = await open();
    const focusable = within(modal).getAllByRole('button').filter(button => !(button as HTMLButtonElement).disabled);
    const first = focusable[0]; const last = focusable.at(-1)!;
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true }); expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: 'Tab' }); expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancelar solicitud' })).toHaveFocus();
    expect(posts(f)).toHaveLength(0);
  });
  it.each([403, 404])('masks the selected private request after cancellation HTTP %s', async status => {
    const f = fixture(false, (url, init) => url.endsWith('/cancel') && init.method === 'POST'
      ? Promise.resolve(reply({ error: status === 403 ? 'forbidden' : 'not_found' }, status)) : undefined);
    await open(); fireEvent.click(screen.getByRole('button', { name: 'Confirmar cancelación' }));
    await screen.findByText('La solicitud no está disponible.');
    expect(document.body).not.toHaveTextContent('TR-001');
    expect(document.body).not.toHaveTextContent('Exact model');
    expect(document.body).not.toHaveTextContent('9223372036854775807');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(posts(f)).toHaveLength(1);
  });
  it('remounts uncertainty without silent POST, then explicitly discovers approval and retries original cancellation', async () => {
    let sent = 0; let recovering = false;
    const f = fixture(false, (url, init) => {
      if (url.endsWith('/cancel') && init.method === 'POST') return ++sent === 1
        ? Promise.reject(new Error('PRIVATE lost reply')) : Promise.resolve(reply(cancelled(true)));
      if (recovering && url === '/api/transfers/1') return Promise.resolve(reply(original(true)));
      return undefined;
    });
    await open(); fireEvent.click(screen.getByRole('button', { name: 'Confirmar cancelación' }));
    await screen.findByRole('button', { name: 'Consultar resultado original' });
    f.remount();
    await screen.findByRole('button', { name: 'Consultar resultado original' });
    expect(sent).toBe(1); recovering = true;
    fireEvent.click(screen.getByRole('button', { name: 'Consultar resultado original' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reintentar misma cancelación' }));
    await screen.findByText('Cancelada', { selector: '.pending-status' });
    expect(sent).toBe(2);
    expect(posts(f).map(([url, init]) => [url, init?.body])).toEqual([
      ['/api/transfers/1/cancel', '{}'], ['/api/transfers/1/cancel', '{}'],
    ]);
    expect(document.body).not.toHaveTextContent('PRIVATE');
  });
});
