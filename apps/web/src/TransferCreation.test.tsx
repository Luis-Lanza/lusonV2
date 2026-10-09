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
  it.each(['warehouse', 'anonymous', 'unready'])('denies %s without catalog requests or subscriptions', async denied => {
    const a = denied === 'warehouse' ? authority(1) : denied === 'anonymous' ? { epoch: 1, ready: true, session: null } : { ...authority(), ready: false };
    const h = harness(a); const loader = vi.fn<typeof loadSourceInventory>();
    render(<TransferCreation controller={h.controller} metadata={metadata} loader={loader} onBack={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('sesión activa de sucursal');
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
    expect(screen.getByText('2 variantes · 18446744073709551614 baterías')).toBeVisible();
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

describe('R04b2c2 manual lifecycle', () => {
  it.each([201, 200])('shows only actual parsed %s reference, string ID and exact UTC then returns to Transfers', async status => {
    const h = harness(); const loader = vi.fn<typeof loadSourceInventory>(async source => catalog(source)); const back = vi.fn();
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(recordDTO(), status));
    render(<TransferCreation controller={h.controller} metadata={metadata} loader={loader} onBack={back} />);
    await selectAndReview(); fireEvent.click(screen.getByRole('button', { name: 'Enviar solicitud' }));
    expect(await screen.findByRole('heading', { name: 'TR-1001' })).toBeVisible();
    expect(screen.getByText('ID: 1001')).toBeVisible(); expect(screen.getByText(recordDTO().created_at)).toBeVisible();
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
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply({ ...recordDTO(), origin_location_id: 3, origin_location_name: 'Sucursal B', approver_location_id: 3, approver_location_name: 'Sucursal B' }, 200));
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
