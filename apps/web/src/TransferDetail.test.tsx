import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TransferDetail from './TransferDetail';
import { transferViewOwner } from './TransferPending';
import { parseTransferRecord } from './transferModel';
import type { DetailController } from './TransferDetail';
import type { TransferAuthority } from './useInventory';

const names = ['Almacén', 'Sucursal A', 'Sucursal B'];
function wire(origin = 1, destination = 2, status = 'pending') {
  const creator = destination === 1 ? origin : destination;
  const approver = destination === 1 ? 1 : origin;
  return {
    id: '9007199254740993', reference: 'TR-9007199254740993', kind: destination === 1 ? 'send_to_warehouse' : 'request_stock', status,
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
function deferred() {
  let resolve!: (value: Response) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Response>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function catalog(source: number, page = 1, total = 2, available = '9223372036854775807') {
  const length = Math.min(50, Math.max(0, total - (page - 1) * 50));
  const items = Array.from({ length }, (_, index) => {
    const variant = (page - 1) * 50 + index + 1;
    return `{"variant_id":${variant},"catalog_entry_id":1,"brand":"LIVE NOT ORIGINAL","model":"Different","capacity_ah":35,"polarity":"L","existing":${available},"reserved":0,"available":${available}}`;
  });
  return new Response(`{"location":{"id":${source},"name":"${names[source - 1]}"},"page":${page},"page_size":50,"total_variants":${total},"items":[${items.join(',')}]}`, { headers: { 'Content-Type': 'application/json' } });
}
function fixture(origin = 1, destination = 2, assigned = 1, override?: (url: string, init: RequestInit) => Promise<Response>) {
  const env: { current: TransferAuthority } = { current: { epoch: 1, ready: true, sessionGeneration: 1,
    session: { authenticated: true, csrf_token: 'a'.repeat(43), identity: { account_id: assigned, username: 'test', location: { id: assigned, name: names[assigned - 1] } }, expires_at: '2030-01-01T00:00:00Z' } } };
  const listeners = new Set<() => void>();
  const controller: DetailController = {
    authorityEpoch: 1, getTransferAuthority: () => env.current,
    subscribeTransferInvalidation: () => () => {},
    subscribeSourceInventoryInvalidation: callback => { listeners.add(callback); return () => { listeners.delete(callback); }; },
    settleUnauthorized: vi.fn(async () => 'unavailable' as const),
  };
  const fetch = vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    return override ? override(url, init) : Promise.resolve(catalog(origin));
  });
  vi.stubGlobal('fetch', fetch);
  const ownerTag = transferViewOwner(env.current)!;
  const record = parseTransferRecord(JSON.stringify(wire(origin, destination)));
  const element = (value = record) => <TransferDetail controller={controller} ownerTag={ownerTag} record={value} />;
  return { env, controller, listeners, fetch, record, element };
}
async function loaded() { await waitFor(() => expect(screen.getByRole('button', { name: 'Actualizar stock de origen' })).toBeEnabled()); }
afterEach(() => vi.unstubAllGlobals());

describe('A06a immutable physical review', () => {
  it.each([[1, 2, 1], [1, 3, 3], [2, 3, 2], [3, 2, 3], [2, 1, 1], [3, 1, 3]])('reviews %s → %s for participant %s without a client actor substitution', async (origin, destination, assigned) => {
    const f = fixture(origin, destination, assigned);
    render(f.element());
    await loaded();
    const table = screen.getByRole('table', { name: 'Baterías solicitadas' });
    expect(table).toHaveTextContent('18446744073709551614');
    expect(within(table).getAllByText('9223372036854775807')).toHaveLength(2);
    expect(within(table).getAllByText('75.125 Ah')).toHaveLength(2);
    expect(Array.from(table.querySelectorAll('tbody tr')).map(row => row.getAttribute('data-variant-id'))).toEqual(['1', '2']);
    expect(table).toHaveTextContent('Original · Immutable-1');
    expect(table).toHaveTextContent('Izquierda [L]');
    expect(table).toHaveTextContent('Derecha [R]');
    expect(document.body).not.toHaveTextContent('LIVE NOT ORIGINAL');
    expect(screen.getByText('2028-01-01T00:00:00.123456789Z')).toBeVisible();
    const summary = screen.getByLabelText('Resumen de solicitud');
    expect(summary).toHaveTextContent(`Ubicación creadora${names[(destination === 1 ? origin : destination) - 1]}`);
    expect(summary).toHaveTextContent(`Requiere aprobación de${names[(destination === 1 ? 1 : origin) - 1]}`);
    expect(summary).toHaveTextContent(`solicitud completa en ${names[origin - 1]}`);
    expect(summary).toHaveTextContent('no mueve existencias ni aumenta el stock del destino');
    const url = new URL(String(f.fetch.mock.calls[0][0]), 'http://localhost');
    expect(url.searchParams.get('location_id')).toBe(String(origin));
    expect(url.searchParams.get('page_size')).toBe('50');
    expect(f.fetch.mock.calls[0][1]).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store' });
    expect(new Headers(f.fetch.mock.calls[0][1]?.headers).get('X-Luson-Passive')).toBe('1');
    expect(document.querySelector('.transfer-detail-cards') !== null).toBe(assigned === 1);
    expect(document.body).not.toHaveTextContent('Verificadas en origen');
  });
  it.each(['approved', 'rejected'])('preserves truthful %s terminal metadata without loading a fabricated stock snapshot', async status => {
    for (const [origin, destination] of [[1, 2], [1, 3], [2, 3], [3, 2], [2, 1], [3, 1]]) {
      for (const assigned of [origin, destination]) {
        const f = fixture(origin, destination, assigned);
        const view = render(f.element(parseTransferRecord(JSON.stringify(wire(origin, destination, status)))));
        expect(f.fetch).not.toHaveBeenCalled();
        expect(screen.getByText('2028-01-02T00:00:00.000000001Z')).toBeVisible();
        expect(screen.getByText('2028-01-01T00:00:00.123456789Z')).toBeVisible();
        expect(screen.queryByText('Esta solicitud todavía no reserva ni mueve stock.')).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Actualizar stock de origen' })).not.toBeInTheDocument();
        expect(screen.getByLabelText('Resumen de solicitud')).toHaveTextContent(status === 'approved' ? `solicitud completa está reservada en ${names[origin - 1]}` : 'No reserva ni mueve stock');
        expect(screen.getByRole('table')).toHaveTextContent('18446744073709551614');
        expect(screen.getByRole('table')).not.toHaveTextContent('Disponible');
        expect(screen.queryByText(/Encargado|Empleado|usuario/)).not.toBeInTheDocument();
        view.unmount();
      }
    }
  });
  it('loads the complete origin catalog across pages without changing original item order', async () => {
    const f = fixture(2, 1, 1, async url => catalog(2, Number(new URL(url, 'http://localhost').searchParams.get('page')), 51));
    render(f.element());
    await loaded();
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(String(f.fetch.mock.calls[1][0])).toContain('page=2');
    expect(screen.getByRole('table')).toHaveTextContent('Original · Immutable-2');
    expect(screen.getByRole('table')).not.toHaveTextContent('Different');
  });
  it('never invents zero or a verified badge while loading', async () => {
    const d = deferred();
    const f = fixture(1, 2, 1, () => d.promise);
    render(f.element());
    expect(screen.getByRole('table')).toHaveTextContent('Consultando stock…');
    expect(screen.getByRole('table')).not.toHaveTextContent('0 disponibles');
    expect(screen.getByRole('table')).toHaveTextContent('9223372036854775807');
    await act(async () => d.resolve(catalog(1)));
    await loaded();
  });
  it.each([0, 1])('missing original variants in a valid catalog of %s rows remain unknown, not zero', async total => {
    const f = fixture(1, 2, 2, async () => catalog(1, 1, total));
    render(f.element());
    await loaded();
    const table = screen.getByRole('table');
    expect(table).toHaveTextContent('Disponibilidad no disponible');
    expect(table).not.toHaveTextContent('0 disponibles');
    expect(within(table).getAllByText('9223372036854775807')).toHaveLength(2);
  });
  it.each([401, 403, 404, 503])('sanitizes stock HTTP %s without reading a private body or hiding immutable items', async status => {
    const text = vi.fn(async () => 'PRIVATE STOCK BODY');
    const response = { status, text } as unknown as Response;
    const f = fixture(1, 2, 2, async () => response);
    render(f.element());
    await screen.findByRole('alert');
    expect(text).not.toHaveBeenCalled();
    expect(document.body).not.toHaveTextContent('PRIVATE');
    expect(screen.getByRole('table')).toHaveTextContent('Original · Immutable-1');
    expect(screen.getByRole('table')).not.toHaveTextContent('0 disponibles');
    expect(f.controller.settleUnauthorized).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
  });
  it('keeps all items visible under advisory shortage and never gates approval by a live catalog quantity', async () => {
    const f = fixture(1, 2, 2, async () => catalog(1, 1, 2, '0'));
    render(<TransferDetail controller={f.controller} ownerTag={transferViewOwner(f.env.current)!} record={f.record} actions={() => <button>Review sentinel</button>} />);
    await loaded();
    expect(screen.getByRole('table')).toHaveTextContent('0 disponibles');
    expect(screen.getByRole('table')).toHaveTextContent('18446744073709551614');
    expect(screen.getByRole('button', { name: 'Review sentinel' })).toBeEnabled();
  });
  it('clears stale catalog immediately, coalesces dirty invalidations, and ignores the dirty result', async () => {
    let next: ReturnType<typeof deferred> | null = null;
    const f = fixture(1, 2, 2, async () => next ? next.promise : catalog(1));
    render(f.element());
    await loaded();
    next = deferred();
    act(() => { for (const listener of f.listeners) listener(); });
    await waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('table')).not.toHaveTextContent('9223372036854775807 disponibles');
    act(() => { for (const listener of f.listeners) { listener(); listener(); } });
    expect(f.fetch).toHaveBeenCalledTimes(2);
    const dirty = next;
    next = null;
    await act(async () => dirty.resolve(catalog(1, 1, 2, '17')));
    await waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(3));
    await loaded();
    expect(screen.getByRole('table')).not.toHaveTextContent('17 disponibles');
    expect(screen.getByRole('table')).toHaveTextContent('9223372036854775807 disponibles');
    expect(f.fetch.mock.calls.every(([, init]) => new Headers(init?.headers).get('X-Luson-Passive') === '1')).toBe(true);
  });
  it('a failed refresh removes old advisory values, and manual retry remains passive', async () => {
    let failing = false;
    const f = fixture(1, 2, 2, async () => failing ? Promise.reject(new Error('PRIVATE')) : catalog(1));
    render(f.element());
    await loaded();
    failing = true;
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar stock de origen' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('table')).not.toHaveTextContent('9223372036854775807 disponibles');
    failing = false;
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar stock de origen' }));
    await loaded();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(new Headers(f.fetch.mock.calls.at(-1)![1]?.headers).get('X-Luson-Passive')).toBe('1');
  });
  it.each(['unready', 'account', 'location', 'csrf', 'generation', 'username', 'expiry'])('fences retained stock callback and private render on in-place %s mutation', async mode => {
    const f = fixture(1, 2, 2);
    const view = render(f.element());
    await loaded();
    const button = screen.getByRole('button', { name: 'Actualizar stock de origen' });
    const session = f.env.current.session!;
    if (!session.authenticated) throw new Error('fixture');
    if (mode === 'unready') f.env.current.ready = false;
    if (mode === 'account') session.identity.account_id = 3;
    if (mode === 'location') session.identity.location.id = 3;
    if (mode === 'csrf') session.csrf_token = 'b'.repeat(43);
    if (mode === 'generation') f.env.current.sessionGeneration = 2;
    if (mode === 'username') session.identity.username = 'replacement';
    if (mode === 'expiry') session.expires_at = '2031-01-01T00:00:00Z';
    fireEvent.click(button);
    act(() => { for (const listener of f.listeners) listener(); });
    expect(f.fetch).toHaveBeenCalledOnce();
    view.rerender(f.element());
    expect(document.body).not.toHaveTextContent('Immutable');
    expect(document.body).not.toHaveTextContent('9007199254740993');
  });
  it.each(['success', '401'])('ignores an abort-ignoring old-authority %s stock completion', async outcome => {
    const d = deferred();
    const f = fixture(1, 2, 2, () => d.promise);
    const view = render(f.element());
    await waitFor(() => expect(f.fetch).toHaveBeenCalledOnce());
    f.env.current.ready = false;
    view.rerender(f.element());
    expect(f.fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
    await act(async () => d.resolve(outcome === 'success' ? catalog(1) : new Response('PRIVATE', { status: 401 })));
    expect(document.body).not.toHaveTextContent('Immutable');
    expect(f.controller.settleUnauthorized).not.toHaveBeenCalled();
  });
  it('aborts on unmount and detaches passive subscriptions without altering the original record', async () => {
    const d = deferred();
    const f = fixture(1, 2, 2, () => d.promise);
    const before = JSON.stringify(f.record, (_key, value) => typeof value === 'bigint' ? value.toString() : value);
    const view = render(f.element());
    await waitFor(() => expect(f.fetch).toHaveBeenCalledOnce());
    view.unmount();
    expect(f.listeners.size).toBe(0);
    expect(f.fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
    await act(async () => d.resolve(catalog(1)));
    expect(JSON.stringify(f.record, (_key, value) => typeof value === 'bigint' ? value.toString() : value)).toBe(before);
  });
});
