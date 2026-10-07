import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import TransferCreation from './TransferCreation';
import type { Item, Metadata } from './model';
import { loadSourceInventory, SourceInventoryError, type SourceCatalog } from './sourceInventory';
import type { TransferAuthority } from './useInventory';

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
  it('opens the physical warehouse catalog with honest unavailable review and no stock mutations', async () => {
    const h = harness(); const original = catalog(); const loader = vi.fn<typeof loadSourceInventory>(async () => original);
    render(<TransferCreation controller={h.controller} metadata={metadata} loader={loader} onBack={vi.fn()} />);
    expect(await screen.findByRole('heading', { name: 'Disponibilidad en Almacén' })).toBeVisible();
    await screen.findByRole('button', { name: 'Añadir Modelo 1 L' });
    fireEvent.click(add());
    expect(screen.getByRole('button', { name: 'Revisar solicitud' })).toBeDisabled();
    expect(screen.getByText('La revisión y el envío se habilitarán en la próxima etapa.')).toBeVisible();
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
