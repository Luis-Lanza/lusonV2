import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import TransferCreation from './TransferCreation';
import type { Item, Metadata } from './model';
import { loadSourceInventory, SourceInventoryError, type SourceCatalog } from './sourceInventory';
import type { TransferAuthority } from './useInventory';
import { createTransferRecovery } from './transferRecovery';
import { addCartItem, createTransferCart, reviewCart } from './transferCart';

const metadata: Metadata = { locations: [{ id: 1, name: 'Almacén' }, { id: 2, name: 'Sucursal A' }, { id: 3, name: 'Sucursal B' }], brands: ['TOYO', 'CAR'] };
function authority(assigned = 2, epoch = 1, account = assigned): TransferAuthority {
  return { epoch, ready: true, session: { authenticated: true, csrf_token: 'c'.repeat(43), expires_at: '2030-01-01T00:00:00Z',
    identity: { account_id: account, username: 'test-branch', location: metadata.locations[assigned - 1] } } };
}
function catalog(source = 1, count = 2, available = 9223372036854775807n): SourceCatalog {
  return { location: metadata.locations[source - 1], rows: Array.from({ length: count }, (_, i): Item => ({
    variant_id: i + 1, catalog_entry_id: Math.floor(i / 2) + 1, brand: i % 2 ? 'CAR' : 'TOYO', model: `Modelo ${i + 1}`,
    capacity_ah: '75.125', polarity: i % 2 ? 'R' : 'L', existing: i === 1 ? 0n : available, reserved: 0n, available: i === 1 ? 0n : available,
  })) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness(initial = authority()) {
  let current = initial;
  const listeners = new Set<() => void>();
  const detach = vi.fn();
  const controller = { authorityEpoch: initial.epoch, getTransferAuthority: () => current,
    subscribeTransferInvalidation: vi.fn(() => () => {}),
    subscribeSourceInventoryInvalidation: vi.fn((listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); detach(); }; }),
    settleUnauthorized: vi.fn(async () => 'unavailable' as const) };
  return { controller, detach, listeners, set: (next: TransferAuthority) => { current = next; controller.authorityEpoch = next.epoch; },
    emit: () => act(() => { for (const listener of listeners) listener(); }) };
}
const add = () => screen.getByRole('button', { name: 'Añadir Modelo 1 L' });
const flow = (value: string) => fireEvent.change(screen.getByLabelText('Tipo de transferencia'), { target: { value } });

describe('W2 direct warehouse workspace', () => {
  it.each([2, 3])('creates destination %s only from an explicit immutable warehouse review', async destination => {
    const h = harness(authority(1)); const recovery = createTransferRecovery();
    const loader = vi.fn<typeof loadSourceInventory>(async source => catalog(source));
    const confirmation = deferred<Response>();
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(() => confirmation.promise);
    render(<TransferCreation controller={h.controller} metadata={metadata} loader={loader} recovery={recovery} onBack={vi.fn()} />);
    await screen.findByRole('button', { name: 'Añadir Modelo 1 L' });
    expect(screen.getByLabelText('Tipo de transferencia')).toHaveValue('directA');
    expect(screen.queryByRole('option', { name: 'Solicitar a Almacén' })).not.toBeInTheDocument();
    if (destination === 3) { flow('directB'); await waitFor(() => expect(loader).toHaveBeenCalledTimes(2)); }
    expect(loader.mock.calls.every(([source]) => source === 1)).toBe(true);
    fireEvent.change(screen.getByLabelText('Cantidad Modelo 1 L'), { target: { value: '9223372036854775807' } });
    fireEvent.click(add()); fireEvent.click(screen.getByRole('button', { name: 'Revisar envío' }));
    const dialog = screen.getByRole('dialog', { name: 'Revisar envío' });
    expect(within(dialog).getByText('9223372036854775807')).toBeVisible();
    expect(within(dialog).getByText(/La creación autoriza y reserva/)).toBeVisible();
    expect(within(dialog).queryByText(/pendiente de aprobación/)).not.toBeInTheDocument();
    expect(fetcher).not.toHaveBeenCalled();
    const attempt = recovery.getCurrent(h.controller.getTransferAuthority)!.attempt;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Crear envío y reservar' }));
    expect(screen.getByLabelText('Tipo de transferencia')).toBeDisabled();
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ ...attempt,
      kind: 'direct_shipment', counterparty_location_id: destination, items: [{ variant_id: 1, quantity: '9223372036854775807' }] });
    const created_at = '2028-03-01T00:00:00Z';
    await act(async () => confirmation.resolve(reply({ ...recordDTO(), kind: 'direct_shipment', status: 'approved',
      creator_location_id: 1, creator_location_name: 'Almacén', origin_location_id: 1, origin_location_name: 'Almacén',
      destination_location_id: destination, destination_location_name: metadata.locations[destination - 1].name,
      approver_location_id: 1, approver_location_name: 'Almacén', created_at, decision_location_id: 1, decided_at: created_at,
      items: recordDTO().items.map(item => ({ ...item, quantity: '9223372036854775807' })) }, 201)));
    await screen.findByRole('dialog', { name: 'Solicitud Pendiente de despacho confirmada' });
    expect(screen.getByText('Autorizada y reservada al crear:')).toBeVisible();
    const times = screen.getByRole('region', { name: 'Resultado confirmado' }).querySelectorAll('time');
    expect(times).toHaveLength(2);
    for (const time of times) {
      expect(time).toHaveTextContent('29/02/2028 · 20:00 (hora Bolivia)');
      expect(time).toHaveAttribute('datetime', created_at);
    }
    expect(screen.queryByText('Decidida:')).not.toBeInTheDocument();
    expect(recovery.getCurrent(h.controller.getTransferAuthority)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1); fetcher.mockRestore();
  });
});

describe('F3 grouped catalog and compact route', () => {
  function pairedCatalog() {
    const source = catalog(1, 3, 17n);
    return { ...source, rows: source.rows.map((row, index): Item => index === 1
      ? { ...source.rows[0], variant_id: 2, polarity: 'R', existing: 9n, available: 9n } : row) };
  }
  it('groups paired polarities by catalog identity with independent quantities and stock bounds', async () => {
    const h = harness(authority(1));
    const loader = vi.fn<typeof loadSourceInventory>(async () => pairedCatalog());
    render(<TransferCreation controller={h.controller} metadata={metadata} loader={loader} onBack={vi.fn()} />);
    const group = await screen.findByRole('rowgroup', { name: 'TOYO · Modelo 1 · 75.125 Ah' });
    expect(within(group).getByText('2 variantes')).toBeInTheDocument();
    expect(screen.getAllByLabelText('Cantidad Modelo 1 L')).toHaveLength(1);
    expect(screen.getAllByLabelText('Cantidad Modelo 1 R')).toHaveLength(1);
    fireEvent.change(within(group).getByLabelText('Cantidad Modelo 1 L'), { target: { value: '4' } });
    fireEvent.change(within(group).getByLabelText('Cantidad Modelo 1 R'), { target: { value: '7' } });
    fireEvent.click(within(group).getByRole('button', { name: 'Añadir Modelo 1 L' }));
    fireEvent.click(within(group).getByRole('button', { name: 'Añadir Modelo 1 R' }));
    expect(within(group).getByText('En la selección: 4')).toBeVisible();
    expect(within(group).getByText('En la selección: 7')).toBeVisible();
    expect(screen.getByLabelText('Total a transferir')).toHaveTextContent('11 baterías');
    fireEvent.change(within(group).getByLabelText('Cantidad Modelo 1 R'), { target: { value: '10' } });
    fireEvent.click(within(group).getByRole('button', { name: 'Añadir Modelo 1 R' }));
    expect(screen.getByRole('alert')).toHaveTextContent('dentro del disponible');
    expect(screen.getByLabelText('Total a transferir')).toHaveTextContent('11 baterías');
    const route = screen.getByRole('region', { name: 'Ruta física' });
    expect(within(route).getByText('Origen · Fijo')).toBeVisible();
    expect(within(route).getAllByText('Almacén', { selector: 'strong' })).toHaveLength(1);
    expect(within(route).queryByText('Sucursal A', { selector: 'strong' })).not.toBeInTheDocument();
    expect(within(route).getByLabelText('Tipo de transferencia')).toHaveValue('directA');
  });
  it('retains unavailable variants without inventing absent or filtered polarities or merging identical labels', async () => {
    const h = harness(); const original = pairedCatalog();
    const source = { ...original, rows: original.rows.map((row, index): Item => index === 1
      ? { ...row, existing: 0n, available: 0n } : index === 2
        ? { ...original.rows[0], variant_id: 3, catalog_entry_id: 2 } : row) };
    const loader = vi.fn<typeof loadSourceInventory>(async () => source);
    render(<TransferCreation controller={h.controller} metadata={metadata} loader={loader} onBack={vi.fn()} />);
    await screen.findByRole('button', { name: 'Añadir Modelo 1 R' });
    const groups = screen.getAllByRole('rowgroup', { name: 'TOYO · Modelo 1 · 75.125 Ah' });
    expect(groups).toHaveLength(2);
    expect(within(groups[0]).getByRole('button', { name: 'Añadir Modelo 1 R' })).toBeDisabled();
    expect(within(groups[0]).getByLabelText('Cantidad Modelo 1 R')).toBeDisabled();
    expect(within(groups[1]).getByText('1 variante')).toBeInTheDocument();
    expect(within(groups[1]).queryByLabelText('Cantidad Modelo 1 R')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Polaridad'), { target: { value: 'L' } });
    expect(screen.queryByLabelText('Cantidad Modelo 1 R')).not.toBeInTheDocument();
    expect(screen.getAllByText('1 variante')).toHaveLength(2);
    expect(loader).toHaveBeenCalledTimes(1);
  });
  it('groups only the displayed page even when a pair crosses its boundary', async () => {
    const h = harness(); const original = catalog(1, 26, 17n);
    const source = { ...original, rows: original.rows.map((row, index): Item => index === 25
      ? { ...original.rows[24], variant_id: 26, polarity: 'R' } : row) };
    const loader = vi.fn<typeof loadSourceInventory>(async () => source);
    render(<TransferCreation controller={h.controller} metadata={metadata} loader={loader} onBack={vi.fn()} />);
    const name = 'TOYO · Modelo 25 · 75.125 Ah';
    const group = await screen.findByRole('rowgroup', { name });
    expect(within(group).getByText('1 variante')).toBeInTheDocument();
    expect(screen.queryByLabelText('Cantidad Modelo 25 R')).not.toBeInTheDocument();
    fireEvent.click(within(group).getByRole('button', { name: 'Añadir Modelo 25 L' }));
    fireEvent.click(screen.getByRole('button', { name: 'Página siguiente' }));
    const next = screen.getByRole('rowgroup', { name });
    expect(within(next).getByText('1 variante')).toBeInTheDocument();
    expect(within(next).queryByLabelText('Cantidad Modelo 25 L')).not.toBeInTheDocument();
    fireEvent.click(within(next).getByRole('button', { name: 'Añadir Modelo 25 R' }));
    expect(screen.getByLabelText('Total a transferir')).toHaveTextContent('2 baterías');
    expect(loader).toHaveBeenCalledTimes(1);
  });
});

describe('F3 responsive selection contract', () => {
  it('requests nearest full exposure for focused native table controls', async () => {
    const h = harness();
    const loader = vi.fn<typeof loadSourceInventory>(async () => catalog());
    render(<TransferCreation controller={h.controller} metadata={metadata} loader={loader} onBack={vi.fn()} />);
    const button = await screen.findByRole('button', { name: 'Añadir Modelo 1 L' });
    const input = screen.getByLabelText('Cantidad Modelo 1 L');
    for (const control of [input, button]) {
      const previous = Object.getOwnPropertyDescriptor(control, 'scrollIntoView');
      const expose = vi.fn();
      Object.defineProperty(control, 'scrollIntoView', { configurable: true, value: expose });
      try {
        act(() => control.focus());
        expect(control).toHaveFocus();
        expect(expose).toHaveBeenCalledExactlyOnceWith({ block: 'nearest', inline: 'nearest' });
        expect(expose.mock.contexts[0]).toBe(control);
      } finally {
        if (previous) Object.defineProperty(control, 'scrollIntoView', previous);
        else Reflect.deleteProperty(control, 'scrollIntoView');
      }
    }
  });
  it.each([1, 2])('keeps a single editable selection and truthful review for assignment %s', async assigned => {
    const h = harness(authority(assigned));
    const loader = vi.fn<typeof loadSourceInventory>(async source => catalog(source, 3, 17n));
    render(<TransferCreation controller={h.controller} metadata={metadata} loader={loader} onBack={vi.fn()} />);
    await screen.findByRole('button', { name: 'Añadir Modelo 1 L' });
    expect(screen.getAllByLabelText('Cantidad Modelo 1 L')).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('Cantidad Modelo 1 L'), { target: { value: '4' } });
    fireEvent.click(add());
    expect(add()).toHaveTextContent('Añadir más');
    expect(screen.getByText('En la selección: 4')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Aumentar Modelo 1' }));
    expect(screen.getByLabelText('Cantidad seleccionada Modelo 1')).toHaveValue('5');
    fireEvent.change(screen.getByLabelText('Buscar marca o modelo'), { target: { value: 'Modelo 3' } });
    expect(screen.queryByLabelText('Cantidad Modelo 1 L')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Cantidad seleccionada Modelo 1')).toHaveValue('5');
    fireEvent.click(screen.getByRole('button', { name: 'Añadir Modelo 3 L' }));
    expect(screen.getByLabelText('Total a transferir')).toHaveTextContent('6');
    fireEvent.click(screen.getByRole('button', { name: assigned === 1 ? 'Revisar envío' : 'Revisar solicitud' }));
    const dialog = screen.getByRole('dialog', { name: assigned === 1 ? 'Revisar envío' : 'Revisar solicitud' });
    expect(within(dialog).getByLabelText('Total a transferir')).toHaveTextContent('6');
    expect(within(dialog).getByText('5', { selector: 'td' })).toBeVisible();
    expect(within(dialog).getByRole('columnheader', { name: 'Cantidad a transferir' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: assigned === 1 ? 'Crear envío y reservar' : 'Enviar solicitud' })).toBeEnabled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Volver a editar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Quitar Modelo 1' }));
    expect(screen.queryByLabelText('Cantidad seleccionada Modelo 1')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Total a transferir')).toHaveTextContent('1');
    expect(screen.getByText('Este borrador no reserva ni mueve existencias.')).toBeVisible();
  });
});

describe('R04b2b workspace', () => {
  it('opens the physical warehouse catalog with explicit real review and no stock mutations', async () => {
    const h = harness(); const original = catalog(); const loader = vi.fn<typeof loadSourceInventory>(async () => original);
    render(<TransferCreation controller={h.controller} metadata={metadata} loader={loader} onBack={vi.fn()} />);
    expect(await screen.findByRole('heading', { name: 'Disponibilidad en Almacén' })).toBeVisible();
    await screen.findByRole('button', { name: 'Añadir Modelo 1 L' });
    fireEvent.click(add());
    expect(screen.getByRole('button', { name: 'Revisar solicitud' })).toBeEnabled();
    expect(screen.getByText(/El envío es manual desde la revisión/)).toBeVisible();
    expect(loader.mock.calls[0][0]).toBe(1);
    expect(original.rows[0].reserved).toBe(0n);
    expect(original.rows[0].available).toBe(9223372036854775807n);
    expect(loader.mock.calls[0][1]?.reason).toBe('manual');
    expect(h.controller.subscribeTransferInvalidation).not.toHaveBeenCalled();
  });
  it.each([2, 3])('uses all three physical routes for assigned branch %s', async assigned => {
    const h = harness(authority(assigned));
    const loader = vi.fn<typeof loadSourceInventory>(async source => catalog(source));
    render(<TransferCreation controller={h.controller} metadata={metadata} loader={loader} onBack={vi.fn()} />);
    await screen.findByRole('button', { name: 'Añadir Modelo 1 L' });
    const route = () => within(screen.getByRole('region', { name: 'Ruta física' }));
    expect(route().getByText(metadata.locations[assigned - 1].name, { selector: 'strong' })).toBeVisible();
    flow('requestOther');
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
    expect(loader.mock.calls[1][0]).toBe(assigned === 2 ? 3 : 2);
    flow('sendWarehouse');
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(3));
    expect(loader.mock.calls[2][0]).toBe(assigned);
    expect(route().getByText('Almacén', { selector: 'strong' })).toBeVisible();
    expect(route().getByText('Requiere aprobación de Almacén · No genera reserva inmediata de stock')).toBeVisible();
  });
  it.each(['anonymous', 'unready'])('denies %s without catalog requests or subscriptions', async denied => {
    const a = denied === 'anonymous' ? { epoch: 1, ready: true, session: null } : { ...authority(), ready: false };
    const h = harness(a); const loader = vi.fn<typeof loadSourceInventory>();
    render(<TransferCreation controller={h.controller} metadata={metadata} loader={loader} onBack={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('sesión activa asignada');
    expect(loader).not.toHaveBeenCalled(); expect(h.listeners.size).toBe(0);
  });
  it.each(['epoch', 'account', 'assignment', 'unready', 'anonymous'])('masks all raw private UI in the same render on %s change', async changed => {
    const h = harness(); const loader = vi.fn<typeof loadSourceInventory>(async source => catalog(source));
    const props = { controller: h.controller, metadata, loader, onBack: vi.fn() };
    let checked = false;
    function Probe() {
      const output = TransferCreation(props);
      if (checked) {
        // Render the returned subtree before passive effects may clear the held cart.
        expect(JSON.stringify(output, (key, value) => key === '_owner' || key === '_store' ? undefined : typeof value === 'bigint' ? String(value) : value)).not.toContain('Modelo 1');
      }
      return output;
    }
    const view = render(<Probe />); await screen.findByRole('button', { name: 'Añadir Modelo 1 L' });
    fireEvent.click(add());
    const next = changed === 'epoch' ? authority(2, 2) : changed === 'account' ? authority(2, 1, 99) : changed === 'assignment' ? authority(3) : changed === 'anonymous' ? { epoch: 1, ready: false, session: null } : { ...authority(), ready: false };
    h.set(next); checked = true;
    // Prevent a new successful flight so the probe remains about the render fence.
    loader.mockImplementation(() => new Promise(() => {}));
    view.rerender(<Probe />);
    expect(screen.queryByText(/Modelo 1/)).not.toBeInTheDocument();
  });
  it('rejects saved row handlers when latest readiness changes before a rerender', async () => {
    const h = harness(); const loader = vi.fn<typeof loadSourceInventory>(async source => catalog(source));
    render(<TransferCreation controller={h.controller} metadata={metadata} loader={loader} onBack={vi.fn()} />);
    await screen.findByRole('button', { name: 'Añadir Modelo 1 L' });
    h.set({ ...authority(), ready: false }); fireEvent.click(add());
    expect(screen.queryByLabelText('Cantidad seleccionada Modelo 1')).not.toBeInTheDocument();
    h.emit(); expect(loader).toHaveBeenCalledTimes(1);
  });
  it('ignores aborted old epoch success and 401, including multiple source flights', async () => {
    const h = harness(); const jobs = [deferred<SourceCatalog>(), deferred<SourceCatalog>(), deferred<SourceCatalog>(), deferred<SourceCatalog>()];
    let nextJob = 0;
    const loader = vi.fn<typeof loadSourceInventory>(() => jobs[nextJob++].promise);
    const props = { controller: h.controller, metadata, loader, onBack: vi.fn() };
    const view = render(<TransferCreation {...props} />);
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
    flow('requestOther'); flow('sendWarehouse');
    expect(loader).toHaveBeenCalledTimes(3); expect(loader.mock.calls[0][1]?.signal?.aborted).toBe(true);
    h.set(authority(3, 2)); view.rerender(<TransferCreation {...props} />);
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(4));
    await act(async () => { jobs[0].resolve(catalog()); jobs[1].reject(new SourceInventoryError('unauthenticated', 401)); jobs[2].resolve(catalog(2)); });
    expect(screen.queryByText(/Modelo 1/)).not.toBeInTheDocument(); expect(h.controller.settleUnauthorized).not.toHaveBeenCalled();
    await act(async () => jobs[3].resolve(catalog()));
    expect(add()).toBeEnabled(); expect(loader.mock.calls[3][0]).toBe(1);
  });
  it('coalesces dirty bursts into one passive followup without reclassifying manual retries', async () => {
    const h = harness(); const jobs = Array.from({ length: 4 }, () => deferred<SourceCatalog>());
    let nextJob = 0;
    const loader = vi.fn<typeof loadSourceInventory>(() => jobs[nextJob++].promise);
    render(<TransferCreation controller={h.controller} metadata={metadata} loader={loader} onBack={vi.fn()} />);
    await screen.findByRole('heading', { name: 'Disponibilidad en Almacén' });
    h.emit(); h.emit(); h.emit(); expect(loader).toHaveBeenCalledTimes(1);
    await act(async () => jobs[0].resolve(catalog()));
    expect(loader).toHaveBeenCalledTimes(2); expect(loader.mock.calls[1][1]?.reason).toBe('passive');
    h.emit(); h.emit(); fireEvent.click(screen.getByRole('button', { name: 'Reintentar catálogo' }));
    expect(loader.mock.calls[2][1]?.reason).toBe('manual'); expect(loader.mock.calls[1][1]?.signal?.aborted).toBe(true);
    await act(async () => jobs[1].resolve(catalog())); expect(loader).toHaveBeenCalledTimes(3);
    await act(async () => jobs[2].resolve(catalog())); expect(loader).toHaveBeenCalledTimes(4);
    expect(loader.mock.calls[3][1]?.reason).toBe('passive');
    await act(async () => jobs[3].resolve(catalog())); expect(loader).toHaveBeenCalledTimes(4);
    expect(h.controller.subscribeSourceInventoryInvalidation).toHaveBeenCalledTimes(1);
  });
  it('filters and paginates the whole 190 variant catalog locally while retaining exact cart totals', async () => {
    const h = harness(); const snapshot = catalog(1, 190); const loader = vi.fn<typeof loadSourceInventory>(async () => snapshot);
    const rng = vi.spyOn(crypto, 'getRandomValues'); const fetcher = vi.spyOn(globalThis, 'fetch');
    render(<TransferCreation controller={h.controller} metadata={metadata} loader={loader} onBack={vi.fn()} />);
    await screen.findByRole('button', { name: 'Añadir Modelo 1 L' });
    fireEvent.change(screen.getByLabelText('Cantidad Modelo 1 L'), { target: { value: '9223372036854775807' } }); fireEvent.click(add());
    fireEvent.change(screen.getByLabelText('Cantidad Modelo 3 L'), { target: { value: '9223372036854775807' } });
    fireEvent.click(screen.getByRole('button', { name: 'Añadir Modelo 3 L' }));
    expect(within(screen.getByRole('complementary', { name: 'Carrito de transferencia' })).getByText('2 variantes')).toBeVisible();
    expect(screen.getByLabelText('Total a transferir')).toHaveTextContent('18446744073709551614 baterías');
    expect(screen.getByRole('button', { name: 'Añadir Modelo 2 R' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Buscar marca o modelo'), { target: { value: 'Modelo 189' } });
    expect(screen.getByRole('button', { name: 'Añadir Modelo 189 L' })).toBeEnabled();
    expect(screen.getByText('Mostrando 1–1 de 1 variantes')).toBeVisible();
    fireEvent.change(screen.getByLabelText('Buscar marca o modelo'), { target: { value: '' } });
    for (let i = 0; i < 7; i++) fireEvent.click(screen.getByRole('button', { name: 'Página siguiente' }));
    expect(screen.getByText('Mostrando 176–190 de 190 variantes')).toBeVisible();
    fireEvent.change(screen.getByLabelText('Marca'), { target: { value: 'TOYO' } });
    fireEvent.change(screen.getByLabelText('Polaridad'), { target: { value: 'R' } });
    expect(screen.getByText('Mostrando 0–0 de 0 variantes')).toBeVisible();
    expect(screen.getByLabelText('Cantidad seleccionada Modelo 1')).toHaveValue('9223372036854775807');
    expect(loader).toHaveBeenCalledTimes(1); expect(rng).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
    expect(snapshot.rows[0].reserved).toBe(0n); rng.mockRestore(); fetcher.mockRestore();
  });
  it('preserves reduced and missing stock selections and filters on advisory refresh', async () => {
    const h = harness(); let snapshot = catalog(1, 3); const loader = vi.fn<typeof loadSourceInventory>(async () => snapshot);
    render(<TransferCreation controller={h.controller} metadata={metadata} loader={loader} onBack={vi.fn()} />);
    await screen.findByRole('button', { name: 'Añadir Modelo 1 L' });
    fireEvent.change(screen.getByLabelText('Cantidad Modelo 1 L'), { target: { value: '9007199254740993' } }); fireEvent.click(add());
    fireEvent.click(screen.getByRole('button', { name: 'Añadir Modelo 3 L' }));
    fireEvent.change(screen.getByLabelText('Buscar marca o modelo'), { target: { value: 'Modelo 1' } });
    snapshot = catalog(1, 1, 1n); h.emit();
    await waitFor(() => expect(screen.getAllByText(/Selección inválida:/)).toHaveLength(2));
    expect(screen.getByLabelText('Cantidad seleccionada Modelo 1')).toHaveValue('9007199254740993');
    expect(screen.getByLabelText('Cantidad seleccionada Modelo 3')).toHaveValue('1');
    expect(screen.getByText('Disponible: Variante ausente')).toBeVisible();
    expect(screen.getByLabelText('Buscar marca o modelo')).toHaveValue('Modelo 1');
    expect(loader.mock.calls[1][1]?.reason).toBe('passive');
    fireEvent.click(screen.getByRole('button', { name: 'Quitar Modelo 3' }));
    expect(screen.getByRole('button', { name: 'Reintentar catálogo' })).toHaveFocus();
  });
  it('requires explicit source discard, focuses cancel and keeps source on cancellation or same flow', async () => {
    const h = harness(); const loader = vi.fn<typeof loadSourceInventory>(async source => catalog(source));
    render(<TransferCreation controller={h.controller} metadata={metadata} loader={loader} onBack={vi.fn()} />);
    await screen.findByRole('button', { name: 'Añadir Modelo 1 L' }); fireEvent.click(add());
    expect(screen.getByLabelText('Cantidad Modelo 1 L')).toHaveFocus();
    flow('requestWarehouse'); expect(loader).toHaveBeenCalledTimes(1);
    flow('requestOther'); expect(screen.getByRole('dialog')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Conservar selección' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.getByLabelText('Tipo de transferencia')).toHaveFocus();
    expect(screen.getByLabelText('Cantidad seleccionada Modelo 1')).toHaveValue('1'); expect(loader).toHaveBeenCalledTimes(1);
    flow('requestOther'); fireEvent.click(screen.getByRole('button', { name: 'Descartar selección' }));
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
    expect(loader.mock.calls[1][0]).toBe(3); expect(screen.queryByLabelText('Cantidad seleccionada Modelo 1')).not.toBeInTheDocument();
  });
  it.each(['١', '-1', '01', '1.5', '9223372036854775808'])('rejects noncanonical or overflowing quantity %s with sanitized guidance', async value => {
    const h = harness(); const loader = vi.fn<typeof loadSourceInventory>(async source => catalog(source));
    render(<TransferCreation controller={h.controller} metadata={metadata} loader={loader} onBack={vi.fn()} />);
    await screen.findByRole('button', { name: 'Añadir Modelo 1 L' });
    fireEvent.change(screen.getByLabelText('Cantidad Modelo 1 L'), { target: { value } }); fireEvent.click(add());
    expect(screen.getByRole('alert')).toHaveTextContent('Ingresá una cantidad entera positiva');
    expect(screen.queryByLabelText('Cantidad seleccionada Modelo 1')).not.toBeInTheDocument();
  });
  it('handles zero and minus at one as explicit removal and restores input focus', async () => {
    const h = harness(); const loader = vi.fn<typeof loadSourceInventory>(async source => catalog(source));
    render(<TransferCreation controller={h.controller} metadata={metadata} loader={loader} onBack={vi.fn()} />);
    await screen.findByRole('button', { name: 'Añadir Modelo 1 L' }); fireEvent.click(add());
    fireEvent.click(screen.getByRole('button', { name: 'Aumentar Modelo 1' }));
    expect(screen.getByLabelText('Cantidad seleccionada Modelo 1')).toHaveValue('2');
    fireEvent.change(screen.getByLabelText('Cantidad seleccionada Modelo 1'), { target: { value: '0' } });
    expect(screen.queryByLabelText('Cantidad seleccionada Modelo 1')).not.toBeInTheDocument(); expect(screen.getByLabelText('Cantidad Modelo 1 L')).toHaveFocus();
    fireEvent.click(add()); fireEvent.click(screen.getByRole('button', { name: 'Reducir Modelo 1' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument(); expect(screen.getByLabelText('Cantidad Modelo 1 L')).toHaveFocus();
  });
  it('sanitizes initial and background failures, keeps full stale guidance and settles only current 401', async () => {
    const h = harness(); const loader = vi.fn<typeof loadSourceInventory>().mockRejectedValueOnce(new Error('private response'))
      .mockResolvedValueOnce(catalog()).mockRejectedValueOnce(new SourceInventoryError('unauthenticated', 401));
    render(<TransferCreation controller={h.controller} metadata={metadata} loader={loader} onBack={vi.fn()} />);
    await screen.findByRole('alert'); expect(screen.queryByText(/private response/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Añadir Modelo 1 L' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar catálogo' })); await screen.findByRole('button', { name: 'Añadir Modelo 1 L' });
    fireEvent.click(add()); h.emit();
    await screen.findByText('Disponibilidad desactualizada: se conserva la última consulta completa.');
    expect(screen.getByLabelText('Cantidad seleccionada Modelo 1')).toHaveValue('1');
    expect(h.controller.settleUnauthorized).toHaveBeenCalledExactlyOnceWith(1);
  });
  it('resumes same authority with a fresh catalog while preserving legitimate selections, and cleans up on unmount', async () => {
    const h = harness(); const resume = deferred<SourceCatalog>();
    const loader = vi.fn<typeof loadSourceInventory>().mockResolvedValueOnce(catalog()).mockImplementation(() => resume.promise);
    const props = { controller: h.controller, metadata, loader, onBack: vi.fn() };
    const view = render(<TransferCreation {...props} />); await screen.findByRole('button', { name: 'Añadir Modelo 1 L' }); fireEvent.click(add());
    h.set({ ...authority(), ready: false }); view.rerender(<TransferCreation {...props} />);
    expect(h.listeners.size).toBe(0); expect(screen.queryByText(/Modelo 1/)).not.toBeInTheDocument();
    h.set(authority()); view.rerender(<TransferCreation {...props} />);
    expect(screen.queryByText(/Modelo 1/)).not.toBeInTheDocument();
    await act(async () => resume.resolve(catalog()));
    expect(screen.getByLabelText('Cantidad seleccionada Modelo 1')).toHaveValue('1');
    h.emit(); view.unmount(); expect(h.listeners.size).toBe(0); expect(h.detach).toHaveBeenCalledTimes(2);
    expect(loader.mock.calls.at(-1)![1]?.signal?.aborted).toBe(true);
  });
});

// These assertions deliberately run against the previous workspace before wiring review.
describe('R04b2c2 explicit review', () => {
  it.each(['requestWarehouse', 'requestOther', 'sendWarehouse'])('opens a real Pending review for %s without sending', async selected => {
    const h = harness(); const loader = vi.fn<typeof loadSourceInventory>(async source => catalog(source));
    const fetcher = vi.spyOn(globalThis, 'fetch');
    render(<TransferCreation controller={h.controller} metadata={metadata} loader={loader} onBack={vi.fn()} />);
    await screen.findByRole('button', { name: 'Añadir Modelo 1 L' });
    if (selected !== 'requestWarehouse') {
      flow(selected); await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
      await screen.findByRole('button', { name: 'Añadir Modelo 1 L' });
    }
    fireEvent.click(add()); fireEvent.click(screen.getByRole('button', { name: 'Revisar solicitud' }));
    const dialog = screen.getByRole('dialog', { name: 'Revisar solicitud' });
    expect(within(dialog).getByText('75.125 Ah')).toBeVisible();
    expect(within(dialog).getByText(/no reserva ni mueve stock/)).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Enviar solicitud' })).toBeEnabled();
    expect(fetcher).not.toHaveBeenCalled(); fetcher.mockRestore();
  });
});

function reply(value: unknown, status = 201, mime = 'application/json; charset=utf-8') {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': mime } });
}
function recordDTO(id = '1001') {
  return { id, reference: `TR-${id}`, kind: 'request_stock', status: 'pending', created_at: '2028-02-29T12:34:56.123456789Z',
    creator_location_id: 2, creator_location_name: 'Sucursal A', origin_location_id: 1, origin_location_name: 'Almacén',
    destination_location_id: 2, destination_location_name: 'Sucursal A', approver_location_id: 1, approver_location_name: 'Almacén',
    items: [{ variant_id: 1, brand: 'TOYO', model: 'Modelo 1', capacity_ah: '75.125', polarity: 'L', quantity: '1' }] };
}
function archived(h: ReturnType<typeof harness>, selected: 'requestWarehouse' | 'requestOther' | 'sendWarehouse' = 'requestWarehouse', quantity = '1') {
  const recovery = createTransferRecovery();
  const a = h.controller.getTransferAuthority();
  const source = selected === 'sendWarehouse' ? 2 : selected === 'requestOther' ? 3 : 1;
  const cart = reviewCart(addCartItem(createTransferCart(a, selected, catalog(source)), a, 1, quantity), a, 'private_attempt_key_1234');
  const handle = recovery.capture(h.controller.getTransferAuthority, cart);
  const token = recovery.begin(h.controller.getTransferAuthority, handle); recovery.markUnknown(token);
  return recovery;
}
async function selectAndReview() {
  await screen.findByRole('button', { name: 'Añadir Modelo 1 L' }); fireEvent.click(add());
  fireEvent.click(screen.getByRole('button', { name: 'Revisar solicitud' }));
  return screen.getByRole('dialog', { name: 'Revisar solicitud' });
}

describe('A05a terminal original creation replay', () => {
  it.each([
    ['approved', 'requestWarehouse'], ['approved', 'requestOther'], ['approved', 'sendWarehouse'],
    ['rejected', 'requestWarehouse'], ['rejected', 'requestOther'], ['rejected', 'sendWarehouse'],
    ['in_transit', 'requestWarehouse'], ['in_transit', 'requestOther'], ['in_transit', 'sendWarehouse'],
    ['received', 'requestWarehouse'], ['received', 'requestOther'], ['received', 'sendWarehouse'],
  ] as const)('confirms only the matching %s/%s replay flight, clears recovery and navigates by actual ID', async (status, selected) => {
    const h = harness(); const recovery = archived(h, selected); const detail = vi.fn(); const back = vi.fn();
    const snapshot = recovery.getCurrent(h.controller.getTransferAuthority)!;
    const route = snapshot.direction;
    const outcome = { ...recordDTO(), status, kind: route.kind, origin_location_id: route.origin_location_id,
      origin_location_name: metadata.locations[route.origin_location_id - 1].name,
      destination_location_id: route.destination_location_id, destination_location_name: metadata.locations[route.destination_location_id - 1].name,
      approver_location_id: route.approver_location_id, approver_location_name: metadata.locations[route.approver_location_id - 1].name,
      decision_location_id: route.approver_location_id, decided_at: '2028-03-01T00:00:00.000000001Z',
      ...(status === 'in_transit' || status === 'received' ? { dispatch_location_id: route.origin_location_id, dispatched_at: '2028-03-01T00:00:00.000000002Z' } : {}),
      ...(status === 'received' ? { receipt_location_id: route.destination_location_id, received_at: '2028-03-01T00:00:00.000000003Z',
        receipt: { items: recordDTO().items.map(item => ({ variant_id: item.variant_id,
          expected_quantity: item.quantity, actual_quantity: item.quantity, available_quantity: item.quantity })), exceptions: [] } } : {}) };
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(outcome, 200));
    render(<TransferCreation controller={h.controller} metadata={metadata} recovery={recovery}
      loader={async source => catalog(source)} onBack={back} onDetail={detail} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retomar misma solicitud' }));
    const attempt = recovery.getCurrent(h.controller.getTransferAuthority)!.attempt;
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar misma solicitud' }));
    const label = status === 'approved' ? 'Aprobada' : status === 'in_transit' ? 'En tránsito' : status === 'received' ? 'Recibida' : 'Rechazada';
    expect(await screen.findByRole('dialog', { name: `Solicitud ${label} confirmada` })).toBeVisible();
    expect(recovery.getCurrent(h.controller.getTransferAuthority)).toBeNull();
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual(attempt);
    expect(screen.queryByLabelText('Cantidad seleccionada Modelo 1')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Ver detalle' })); expect(detail).toHaveBeenCalledExactlyOnceWith('1001', '1/2/2');
    fireEvent.click(screen.getByRole('button', { name: 'Volver a transferencias' })); expect(back).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledTimes(1); fetcher.mockRestore();
  });
  it.each(['approved', 'rejected'] as const)('retains the exact key and cart when a terminal %s reply is for different items', async status => {
    const h = harness(); const recovery = archived(h); const detail = vi.fn();
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply({ ...recordDTO(), status,
      decision_location_id: 1, decided_at: '2028-03-01T00:00:00Z', items: [{ ...recordDTO().items[0], quantity: '2' }] }, 200));
    render(<TransferCreation controller={h.controller} metadata={metadata} recovery={recovery}
      loader={async source => catalog(source)} onBack={vi.fn()} onDetail={detail} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retomar misma solicitud' }));
    const original = recovery.getCurrent(h.controller.getTransferAuthority)!;
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar misma solicitud' }));
    await screen.findByRole('alert');
    expect(recovery.getCurrent(h.controller.getTransferAuthority)?.attempt).toEqual(original.attempt);
    expect(recovery.getCurrent(h.controller.getTransferAuthority)?.phase).toBe('unknown');
    expect(screen.queryByRole('region', { name: 'Resultado confirmado' })).not.toBeInTheDocument();
    expect(detail).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledTimes(1); fetcher.mockRestore();
  });
  it.each(['approved', 'rejected'] as const)('does not clear a replacement flight on stale %s replay', async status => {
    const h = harness(); const recovery = createTransferRecovery(); const old = deferred<Response>(); const fresh = deferred<Response>();
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => old.promise).mockImplementationOnce(() => fresh.promise);
    const props = { controller: h.controller, metadata, recovery, loader: async (source: number) => catalog(source), onBack: vi.fn() };
    const view = render(<TransferCreation {...props} />); await selectAndReview(); fireEvent.click(screen.getByRole('button', { name: 'Enviar solicitud' }));
    h.set(authority(2, 9)); view.rerender(<TransferCreation {...props} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retomar misma solicitud' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar misma solicitud' }));
    const replacement = recovery.getCurrent(h.controller.getTransferAuthority)!;
    await act(async () => old.resolve(reply({ ...recordDTO('1002'), status, decision_location_id: 1, decided_at: '2028-03-01T00:00:00Z' }, 200)));
    expect(recovery.getCurrent(h.controller.getTransferAuthority)?.handle).toBe(replacement.handle);
    expect(recovery.getCurrent(h.controller.getTransferAuthority)?.phase).toBe('inFlight');
    expect(screen.queryByText('TR-1002')).not.toBeInTheDocument();
    await act(async () => fresh.resolve(reply({ ...recordDTO(), status, decision_location_id: 1, decided_at: '2028-03-01T00:00:00Z' }, 200)));
    expect(recovery.getCurrent(h.controller.getTransferAuthority)).toBeNull(); fetcher.mockRestore();
  });
});

describe('R04b2c2 manual lifecycle', () => {
  it.each([201, 200])('shows actual parsed %s reference, string ID, readable date and exact evidence then returns to Transfers', async status => {
    const h = harness(); const loader = vi.fn<typeof loadSourceInventory>(async source => catalog(source)); const back = vi.fn();
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(recordDTO(), status));
    render(<TransferCreation controller={h.controller} metadata={metadata} loader={loader} onBack={back} />);
    await selectAndReview(); fireEvent.click(screen.getByRole('button', { name: 'Enviar solicitud' }));
    expect(await screen.findByRole('heading', { name: 'TR-1001' })).toBeVisible();
    expect(screen.getByText('ID: 1001')).toBeVisible();
    const time = screen.getByText('29/02/2028 · 08:34 (hora Bolivia)');
    expect(time).toHaveAttribute('datetime', recordDTO().created_at);
    expect(time).toHaveAttribute('title', recordDTO().created_at);
    expect(screen.getByText(status === 200 ? 'El servidor devolvió la solicitud original.' : 'El servidor creó la solicitud.')).toBeVisible();
    expect(screen.getByRole('button', { name: /Ver detalle/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Volver a transferencias' })); expect(back).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledTimes(1);
    const init = fetcher.mock.calls[0][1]!;
    expect(new Headers(init.headers).get('X-CSRF-Token')).toBe('c'.repeat(43));
    expect(init.method).toBe('POST'); expect(init.credentials).toBe('same-origin'); fetcher.mockRestore();
  });
  it('locks synchronously against double clicks and all destructive exits while the flight is pending', async () => {
    const h = harness(); const recovery = createTransferRecovery(); const job = deferred<Response>(); const back = vi.fn();
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(() => job.promise);
    render(<TransferCreation controller={h.controller} metadata={metadata} recovery={recovery} loader={async source => catalog(source)} onBack={back} />);
    const dialog = await selectAndReview(); const send = screen.getByRole('button', { name: 'Enviar solicitud' });
    act(() => { fireEvent.click(send); fireEvent.click(send); });
    expect(fetcher).toHaveBeenCalledTimes(1); expect(recovery.getCurrent(h.controller.getTransferAuthority)?.phase).toBe('inFlight');
    for (const name of ['Cerrar revisión', 'Volver a editar', '← Volver a transferencias', 'Quitar Modelo 1', 'Aumentar Modelo 1']) expect(screen.getByRole('button', { name })).toBeDisabled();
    expect(screen.getByLabelText('Tipo de transferencia')).toBeDisabled(); expect(screen.getByLabelText('Cantidad seleccionada Modelo 1')).toBeDisabled();
    fireEvent.keyDown(dialog, { key: 'Escape' }); expect(dialog).toBeVisible(); expect(back).not.toHaveBeenCalled();
    await act(async () => job.resolve(reply(recordDTO())));
    expect(recovery.getCurrent(h.controller.getTransferAuthority)).toBeNull(); fetcher.mockRestore();
  });
  it.each([
    [403, 'forbidden', 'No tenés permiso'], [401, 'unauthenticated', 'validarse nuevamente'],
    [503, 'service_unavailable', 'servicio no está disponible'], [409, 'insufficient_stock', 'rechazó la creación por stock insuficiente'],
    [409, 'retry_conflict', 'clave corresponde a otro contenido'],
  ] as const)('preserves exact attempt and sanitizes %s/%s without fake success', async (status, code, message) => {
    const h = harness(); const recovery = createTransferRecovery();
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply({ error: code }, status));
    render(<TransferCreation controller={h.controller} metadata={metadata} recovery={recovery} loader={async source => catalog(source)} onBack={vi.fn()} />);
    await selectAndReview(); const before = recovery.getCurrent(h.controller.getTransferAuthority)!.attempt;
    fireEvent.click(screen.getByRole('button', { name: 'Enviar solicitud' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(recovery.getCurrent(h.controller.getTransferAuthority)?.attempt).toEqual(before);
    expect(screen.queryByRole('region', { name: 'Resultado confirmado' })).not.toBeInTheDocument();
    expect(h.controller.settleUnauthorized).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
    expect(screen.getByRole('button', { name: 'Reintentar misma solicitud' })).toBeEnabled(); fetcher.mockRestore();
  });
  it.each(['network', 'malformed', 'mime'])('fails closed on %s and retains the exact key for a manual retry', async failure => {
    const h = harness(); const recovery = createTransferRecovery(); const fetcher = vi.spyOn(globalThis, 'fetch');
    if (failure === 'network') fetcher.mockRejectedValue(new Error('secret response message'));
    else fetcher.mockResolvedValue(failure === 'mime' ? reply(recordDTO(), 201, 'text/html') : reply({ code: 'fake' }));
    render(<TransferCreation controller={h.controller} metadata={metadata} recovery={recovery} loader={async source => catalog(source)} onBack={vi.fn()} />);
    await selectAndReview(); fireEvent.click(screen.getByRole('button', { name: 'Enviar solicitud' })); await screen.findByRole('alert');
    const before = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    expect(screen.queryByText(/secret response message/)).not.toBeInTheDocument(); expect(screen.queryByText(/fake/)).not.toBeInTheDocument();
    expect(recovery.getCurrent(h.controller.getTransferAuthority)?.attempt.retry_key).toBe(before.retry_key);
    fetcher.mockResolvedValue(reply(recordDTO(), 200)); fireEvent.click(screen.getByRole('button', { name: 'Reintentar misma solicitud' }));
    await screen.findByRole('heading', { name: 'TR-1001' }); expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual(before); fetcher.mockRestore();
  });
  it('fails closed when secure randomness is unavailable without POST or archive', async () => {
    const h = harness(); const recovery = createTransferRecovery(); const rng = vi.spyOn(crypto, 'getRandomValues').mockImplementation(() => { throw new Error('private RNG details'); });
    const fetcher = vi.spyOn(globalThis, 'fetch');
    render(<TransferCreation controller={h.controller} metadata={metadata} recovery={recovery} loader={async source => catalog(source)} onBack={vi.fn()} />);
    await screen.findByRole('button', { name: 'Añadir Modelo 1 L' }); fireEvent.click(add()); fireEvent.click(screen.getByRole('button', { name: 'Revisar solicitud' }));
    expect(screen.getByRole('alert')).toHaveTextContent('revisión segura'); expect(screen.queryByText(/private RNG/)).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(fetcher).not.toHaveBeenCalled(); expect(recovery.getCurrent(h.controller.getTransferAuthority)).toBeNull(); rng.mockRestore(); fetcher.mockRestore();
  });
  it('retains the key across close, reopen and advisory refresh; material edits mint only on next review', async () => {
    const h = harness(); const recovery = createTransferRecovery(); const loader = vi.fn<typeof loadSourceInventory>(async source => catalog(source));
    const rng = vi.spyOn(crypto, 'getRandomValues');
    render(<TransferCreation controller={h.controller} metadata={metadata} recovery={recovery} loader={loader} onBack={vi.fn()} />);
    await selectAndReview(); const key = recovery.getCurrent(h.controller.getTransferAuthority)!.attempt.retry_key;
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' }); expect(screen.getByRole('button', { name: 'Revisar solicitud' })).toHaveFocus();
    h.emit(); await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'Retomar revisión' })); expect(recovery.getCurrent(h.controller.getTransferAuthority)!.attempt.retry_key).toBe(key);
    expect(rng).toHaveBeenCalledTimes(1); fireEvent.click(screen.getByRole('button', { name: 'Volver a editar' }));
    fireEvent.change(screen.getByLabelText('Cantidad seleccionada Modelo 1'), { target: { value: '1' } }); expect(recovery.getCurrent(h.controller.getTransferAuthority)!.attempt.retry_key).toBe(key);
    fireEvent.click(screen.getByRole('button', { name: 'Aumentar Modelo 1' })); expect(recovery.getCurrent(h.controller.getTransferAuthority)).toBeNull(); expect(rng).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Revisar solicitud' })); expect(recovery.getCurrent(h.controller.getTransferAuthority)!.attempt.retry_key).not.toBe(key); expect(rng).toHaveBeenCalledTimes(2); rng.mockRestore();
  });
  it.each(['fallen', 'missing', 'failed'])('retries archived canonical payload with fresh CSRF despite %s source', async guidance => {
    const h = harness(); const recovery = archived(h, 'requestOther', '9007199254740993'); const a = authority(2, 8);
    if (a.session?.authenticated) a.session.csrf_token = 'fresh_current_csrf'; h.set(a);
    const loader = vi.fn<typeof loadSourceInventory>(async source => { if (guidance === 'failed') throw new Error('private source'); return catalog(source, guidance === 'missing' ? 0 : 1, 0n); });
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply({ ...recordDTO(), origin_location_id: 3, origin_location_name: 'Sucursal B', approver_location_id: 3, approver_location_name: 'Sucursal B',
      items: recordDTO().items.map(item => ({ ...item, quantity: '9007199254740993' })) }, 200));
    const rng = vi.spyOn(crypto, 'getRandomValues');
    render(<TransferCreation controller={h.controller} metadata={metadata} recovery={recovery} loader={loader} onBack={vi.fn()} />);
    const resume = await screen.findByRole('button', { name: 'Retomar misma solicitud' }); fireEvent.click(resume);
    expect(screen.getByLabelText('Tipo de transferencia')).toHaveValue('requestOther');
    expect(within(screen.getByRole('dialog')).getByText('9007199254740993')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar misma solicitud' })); await screen.findByRole('heading', { name: 'TR-1001' });
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ kind: 'request_stock', counterparty_location_id: 3, retry_key: 'private_attempt_key_1234', items: [{ variant_id: 1, quantity: '9007199254740993' }] });
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('X-CSRF-Token')).toBe('fresh_current_csrf'); expect(rng).not.toHaveBeenCalled(); rng.mockRestore(); fetcher.mockRestore();
  });
  it.each(['fallen', 'missing', 'failed'])('prepares all archived quantities before warned edit/discard with %s guidance', async guidance => {
    const h = harness(); const recovery = archived(h, 'requestWarehouse', '9007199254740993');
    const loader = vi.fn<typeof loadSourceInventory>(async source => { if (guidance === 'failed') throw new Error('source failed'); return catalog(source, guidance === 'missing' ? 0 : 1, 1n); });
    render(<TransferCreation controller={h.controller} metadata={metadata} recovery={recovery} loader={loader} onBack={vi.fn()} />);
    await screen.findByRole('button', { name: 'Editar selección conservada' });
    await waitFor(() => expect(screen.queryByText('Actualizando catálogo completo…')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Editar selección conservada' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('puede haberse creado');
    expect(recovery.getCurrent(h.controller.getTransferAuthority)?.phase).toBe('unknown');
    fireEvent.click(screen.getByRole('button', { name: 'Entiendo el riesgo, habilitar edición' }));
    if (guidance === 'failed') {
      expect(recovery.getCurrent(h.controller.getTransferAuthority)?.phase).toBe('unknown'); expect(screen.getByRole('dialog')).toHaveTextContent('catálogo completo actual');
      fireEvent.click(screen.getByRole('button', { name: 'Conservar selección' })); fireEvent.click(screen.getByRole('button', { name: 'Retomar misma solicitud' }));
      expect(screen.getByRole('button', { name: 'Reintentar misma solicitud' })).toBeEnabled();
    } else {
      expect(recovery.getCurrent(h.controller.getTransferAuthority)).toBeNull(); expect(screen.getByLabelText('Cantidad seleccionada Modelo 1')).toHaveValue('9007199254740993');
      expect(screen.getByRole('alert')).toHaveTextContent('No se ajustó automáticamente');
      expect(screen.getByText(guidance === 'missing' ? 'Disponible: Variante ausente' : 'Disponible: 1')).toBeVisible();
      fireEvent.click(screen.getByRole('button', { name: 'Quitar Modelo 1' })); expect(screen.queryByLabelText('Cantidad seleccionada Modelo 1')).not.toBeInTheDocument();
    }
  });
  it('warns on unknown back and keeps the canonical attempt instead of silently discarding', async () => {
    const h = harness(); const recovery = archived(h); const back = vi.fn();
    render(<TransferCreation controller={h.controller} metadata={metadata} recovery={recovery} loader={async source => catalog(source)} onBack={back} />);
    await screen.findByRole('button', { name: 'Retomar misma solicitud' }); fireEvent.click(screen.getByRole('button', { name: '← Volver a transferencias' }));
    expect(back).not.toHaveBeenCalled(); expect(screen.getByRole('dialog')).toHaveTextContent('no al recargar o cerrar');
    fireEvent.click(screen.getByRole('button', { name: 'Volver conservando el intento' })); expect(back).toHaveBeenCalledOnce();
    expect(recovery.getCurrent(h.controller.getTransferAuthority)?.attempt.retry_key).toBe('private_attempt_key_1234');
  });
  it('cannot let an old success or rejection clear a replacement or release its new flight', async () => {
    const h = harness(); const recovery = createTransferRecovery(); const first = deferred<Response>(); const second = deferred<Response>();
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const loader = vi.fn<typeof loadSourceInventory>(async source => catalog(source)); const props = { controller: h.controller, metadata, recovery, loader, onBack: vi.fn() };
    const view = render(<TransferCreation {...props} />); await selectAndReview(); fireEvent.click(screen.getByRole('button', { name: 'Enviar solicitud' }));
    h.set(authority(2, 9)); view.rerender(<TransferCreation {...props} />);
    await screen.findByRole('button', { name: 'Retomar misma solicitud' }); fireEvent.click(screen.getByRole('button', { name: 'Retomar misma solicitud' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar misma solicitud' })); expect(fetcher).toHaveBeenCalledTimes(2);
    await act(async () => first.resolve(reply(recordDTO('1002'))));
    expect(screen.queryByText('TR-1002')).not.toBeInTheDocument(); expect(recovery.getCurrent(h.controller.getTransferAuthority)?.phase).toBe('inFlight');
    expect(screen.getByRole('button', { name: 'Cerrar revisión' })).toBeDisabled();
    await act(async () => second.resolve(reply(recordDTO(), 200))); expect(await screen.findByText('TR-1001')).toBeVisible(); fetcher.mockRestore();
  });
  it.each(['success', 'failure'])('ignores late old %s after a warned material replacement and newer flight', async settlement => {
    const h = harness(); const recovery = createTransferRecovery();
    const old = deferred<Response>(); const fresh = deferred<Response>();
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => old.promise).mockImplementationOnce(() => fresh.promise);
    const loader = vi.fn<typeof loadSourceInventory>(async source => catalog(source));
    const props = { controller: h.controller, metadata, recovery, loader, onBack: vi.fn() };
    const view = render(<TransferCreation {...props} />);
    await selectAndReview(); fireEvent.click(screen.getByRole('button', { name: 'Enviar solicitud' }));
    const original = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    h.set(authority(2, 10)); view.rerender(<TransferCreation {...props} />);
    await screen.findByRole('button', { name: 'Editar selección conservada' });
    await waitFor(() => expect(screen.queryByText('Actualizando catálogo completo…')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Editar selección conservada' }));
    fireEvent.click(screen.getByRole('button', { name: 'Entiendo el riesgo, habilitar edición' }));
    expect(screen.getByLabelText('Cantidad seleccionada Modelo 1')).toHaveValue('1');
    fireEvent.click(screen.getByRole('button', { name: 'Aumentar Modelo 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Revisar solicitud' }));
    fireEvent.click(screen.getByRole('button', { name: 'Enviar solicitud' }));
    const replacement = recovery.getCurrent(h.controller.getTransferAuthority)!;
    expect(replacement.attempt.retry_key).not.toBe(original.retry_key);
    expect(replacement.attempt.items[0].quantity).toBe('2');
    await act(async () => {
      if (settlement === 'success') old.resolve(reply(recordDTO('1002')));
      else old.reject(new Error('old private transport details'));
    });
    expect(recovery.getCurrent(h.controller.getTransferAuthority)?.handle).toBe(replacement.handle);
    expect(recovery.getCurrent(h.controller.getTransferAuthority)?.phase).toBe('inFlight');
    expect(screen.getByRole('button', { name: 'Cerrar revisión' })).toBeDisabled();
    expect(screen.queryByText(/TR-1002|old private transport details/)).not.toBeInTheDocument();
    await act(async () => fresh.resolve(reply({ ...recordDTO(), items: [{ ...recordDTO().items[0], quantity: '2' }] })));
    expect(await screen.findByText('TR-1001')).toBeVisible(); fetcher.mockRestore();
  });
  it.each(['unready', 'account', 'epoch'])('rejects saved send handler against latest %s without waiting for effects', async changed => {
    const h = harness(); const recovery = createTransferRecovery(); const fetcher = vi.spyOn(globalThis, 'fetch');
    render(<TransferCreation controller={h.controller} metadata={metadata} recovery={recovery} loader={async source => catalog(source)} onBack={vi.fn()} />);
    await selectAndReview();
    const send = screen.getByRole('button', { name: 'Enviar solicitud' });
    h.set(changed === 'unready' ? { ...authority(), ready: false } : changed === 'account' ? authority(2, 1, 99) : authority(2, 2));
    fireEvent.click(send); expect(fetcher).not.toHaveBeenCalled(); fetcher.mockRestore();
  });
  it('preserves both owner slots without a foreign banner or payload while switching A/B/A/B', async () => {
    const h = harness(); const recovery = createTransferRecovery(); const loader = vi.fn<typeof loadSourceInventory>(async source => catalog(source));
    const props = { controller: h.controller, metadata, recovery, loader, onBack: vi.fn() };
    const view = render(<TransferCreation {...props} />); await selectAndReview();
    const attemptA = recovery.getCurrent(h.controller.getTransferAuthority)!.attempt;
    h.set(authority(3, 2)); view.rerender(<TransferCreation {...props} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retomar revisión' })).not.toBeInTheDocument();
    await screen.findByRole('button', { name: 'Añadir Modelo 1 L' });
    flow('sendWarehouse'); await waitFor(() => expect(loader.mock.calls.at(-1)![0]).toBe(3));
    await screen.findByRole('button', { name: 'Añadir Modelo 1 L' }); fireEvent.click(add());
    fireEvent.click(screen.getByRole('button', { name: 'Revisar solicitud' }));
    const attemptB = recovery.getCurrent(h.controller.getTransferAuthority)!.attempt;
    expect(attemptB.kind).toBe('send_to_warehouse'); expect(attemptB.retry_key).not.toBe(attemptA.retry_key);
    h.set(authority(2, 3)); view.rerender(<TransferCreation {...props} />);
    await screen.findByRole('button', { name: 'Retomar revisión' });
    expect(recovery.getCurrent(h.controller.getTransferAuthority)?.attempt).toEqual(attemptA);
    expect(screen.getByLabelText('Tipo de transferencia')).toHaveValue('requestWarehouse');
    h.set(authority(3, 4)); view.rerender(<TransferCreation {...props} />);
    await screen.findByRole('button', { name: 'Retomar revisión' });
    expect(recovery.getCurrent(h.controller.getTransferAuthority)?.attempt).toEqual(attemptB);
    expect(screen.getByLabelText('Tipo de transferencia')).toHaveValue('sendWarehouse');
  });
  it('requires caution before unknown source change and leaves the archive intact on cancellation', async () => {
    const h = harness(); const recovery = archived(h); const loader = vi.fn<typeof loadSourceInventory>(async source => catalog(source));
    render(<TransferCreation controller={h.controller} metadata={metadata} recovery={recovery} loader={loader} onBack={vi.fn()} />);
    await screen.findByRole('button', { name: 'Añadir Modelo 1 L' });
    const before = recovery.getCurrent(h.controller.getTransferAuthority)!;
    flow('requestOther'); expect(screen.getByRole('dialog')).toHaveTextContent('generar otra solicitud');
    fireEvent.click(screen.getByRole('button', { name: 'Conservar selección' }));
    expect(recovery.getCurrent(h.controller.getTransferAuthority)?.handle).toBe(before.handle);
    expect(screen.getByLabelText('Tipo de transferencia')).toHaveValue('requestWarehouse');
    expect(loader).toHaveBeenCalledTimes(1);
    flow('requestOther'); fireEvent.click(screen.getByRole('button', { name: 'Entiendo el riesgo, habilitar edición' }));
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
    expect(recovery.getCurrent(h.controller.getTransferAuthority)).toBeNull();
    expect(screen.getByLabelText('Tipo de transferencia')).toHaveValue('requestOther');
  });
});
