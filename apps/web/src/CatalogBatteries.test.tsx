import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import CatalogBatteries from './CatalogBatteries';
import {
  catalogBatteriesErrorMessages, catalogBatteriesListUnavailable, catalogBatteryCapacityMessage,
  catalogBatteryNameMessage, catalogBatteryPolarityMessage, catalogBatteryPricingHint, catalogBatteryUnsellableLabel,
} from './catalogBatteriesModel';

const csrf = 'c'.repeat(43);
const json = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
const price = (branch: number) => ({
  branch_location_id: branch, min_price: '85000.00', suggested_price: '96000.00',
  updated_at: '2026-11-04T10:00:00Z', updated_by_account_id: 1, updated_by_display_name: 'Almacén',
});
const priced = { catalog_entry_id: 96, brand: 'TOYO', model: 'NS40ZL', capacity_ah: '45', polarities: ['L', 'R'],
  cells: [], prices: [price(2)] };
const unpriced = { catalog_entry_id: 97, brand: 'CAR', model: 'NS60', capacity_ah: '60', polarities: ['L'],
  cells: [], prices: [] };
const pageBody = (batteries: readonly unknown[] = [priced, unpriced], total = 97) => JSON.stringify({
  branches: [{ id: 2, name: 'Sucursal A' }, { id: 3, name: 'Sucursal B' }],
  batteries, page: 1, page_size: 10, total_batteries: total,
});
const created = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  id: 98, brand: 'HYBRID', model: 'BT54L', capacity_ah: '54',
  variants: [{ id: 195, polarity: 'L' }, { id: 196, polarity: 'R' }], priced_branches: 0, ...overrides,
});
const edited = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  id: 96, brand: 'TOYO', model: 'NS40ZL', capacity_ah: '45.5',
  variants: [{ id: 191, polarity: 'L' }, { id: 192, polarity: 'R' }], priced_branches: 1, ...overrides,
});

function harness(options: {
  page?: () => Response | Promise<Response>;
  create?: (body: string) => Response | Promise<Response>;
  edit?: (id: string, body: string) => Response | Promise<Response>;
  archive?: (id: string) => Response | Promise<Response>;
} = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const method = init.method ?? 'GET';
    if (url.startsWith('/api/catalog/prices?')) return options.page?.() ?? json(pageBody());
    if (url === '/api/catalog/batteries' && method === 'POST') {
      return options.create?.(String(init.body)) ?? json(created(), 201);
    }
    const match = /^\/api\/catalog\/batteries\/(\d+)$/.exec(url);
    if (match && method === 'PATCH') return options.edit?.(match[1], String(init.body)) ?? json(edited());
    if (match && method === 'DELETE') return options.archive?.(match[1]) ?? new Response(null, { status: 204 });
    throw new Error('Unexpected mocked URL: ' + method + ' ' + url);
  });
  return {
    fetcher, calls,
    reads: () => calls.filter(call => call.url.startsWith('/api/catalog/prices?')),
    writes: () => calls.filter(call => call.init.method !== undefined && call.init.method !== 'GET'),
  };
}

const rowOf = (label: string) => screen.getAllByRole('row')
  .find(row => row.hasAttribute('data-battery-id') && (row.textContent ?? '').startsWith(label))!;
const form = () => within(screen.getByRole('region', { name: 'Nueva batería' }));
const listing = () => within(screen.getByRole('region', { name: 'Baterías' }));
const typeCreate = (values: { brand: string; model: string; capacity: string; polarities?: readonly string[] }) => {
  fireEvent.change(form().getByLabelText('Marca'), { target: { value: values.brand } });
  fireEvent.change(form().getByLabelText('Modelo'), { target: { value: values.model } });
  fireEvent.change(form().getByLabelText('Capacidad (Ah)'), { target: { value: values.capacity } });
  for (const polarity of values.polarities ?? []) {
    fireEvent.click(form().getByRole('checkbox', { name: `Polaridad ${polarity}` }));
  }
};
async function ready(h: ReturnType<typeof harness>) {
  render(<CatalogBatteries csrf={csrf} fetcher={h.fetcher} />);
  await screen.findByRole('table');
}

describe('the catalogue battery screen', () => {
  it('lists the batteries with their variants and marks the unpriced one as not sellable', async () => {
    const h = harness();
    await ready(h);
    expect(h.reads()[0].url).toBe('/api/catalog/prices?page=1&page_size=10');
    expect(h.reads()[0].init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store' });
    const toyo = rowOf('TOYO NS40ZL');
    expect(within(toyo).getByText('45 Ah')).toBeInTheDocument();
    expect(within(toyo).getByText('L')).toBeInTheDocument();
    expect(within(toyo).getByText('R')).toBeInTheDocument();
    expect(within(toyo).getByText('Con precio en 1 sucursal')).toBeInTheDocument();
    expect(within(toyo).queryByText(catalogBatteryUnsellableLabel)).not.toBeInTheDocument();
    // The battery exists but it is not sellable: the screen says so and names the price screen.
    const car = rowOf('CAR NS60');
    expect(within(car).getByText(catalogBatteryUnsellableLabel)).toBeInTheDocument();
    expect(within(car).getByText(catalogBatteryPricingHint)).toBeInTheDocument();
    expect(within(car).queryByText(/Con precio/)).not.toBeInTheDocument();
    // Nothing is written until the operator asks for it.
    expect(h.writes()).toHaveLength(0);
    expect(listing().getByText('Mostrando 1–2 de 97 baterías')).toBeInTheDocument();
  });

  it('offers the create, edit and archive affordances of every listed battery', async () => {
    const h = harness();
    await ready(h);
    expect(form().getByRole('button', { name: 'Crear batería' })).toBeInTheDocument();
    expect(within(rowOf('TOYO NS40ZL')).getByRole('button', { name: 'Editar TOYO NS40ZL' })).toBeInTheDocument();
    expect(within(rowOf('TOYO NS40ZL')).getByRole('button', { name: 'Archivar TOYO NS40ZL' })).toBeInTheDocument();
    expect(h.writes()).toHaveLength(0);
  });

  it('creates once with brand, model, capacity and at least one polarity, then re-reads', async () => {
    const h = harness();
    await ready(h);
    typeCreate({ brand: 'HYBRID', model: 'BT54L', capacity: '054.0', polarities: ['L', 'R'] });
    fireEvent.click(form().getByRole('button', { name: 'Crear batería' }));
    await waitFor(() => expect(h.writes()).toHaveLength(1));
    const write = h.writes()[0];
    expect(write.url).toBe('/api/catalog/batteries');
    expect(write.init).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf } });
    expect(JSON.parse(String(write.init.body))).toEqual({
      brand: 'HYBRID', model: 'BT54L', capacity_ah: '54', polarities: ['L', 'R'],
    });
    // The allocated identity comes from the server response, and the list is re-read.
    expect(await screen.findByText(/Batería #98 creada con las variantes #195 L · #196 R\./)).toBeInTheDocument();
    expect(screen.getByText(/Todavía no es vendible: sin precio en ninguna sucursal\./)).toBeInTheDocument();
    // The same hint also stands in the unpriced row; the notice carries it too.
    expect(screen.getByText(/Batería #98 creada/).closest('p')).toHaveTextContent(catalogBatteryPricingHint);
    await waitFor(() => expect(h.reads()).toHaveLength(2));
    expect(form().getByLabelText('Marca')).toHaveValue('');
    expect(form().getByLabelText('Modelo')).toHaveValue('');
    expect(form().getByLabelText('Capacidad (Ah)')).toHaveValue('');
    expect(form().getByRole('checkbox', { name: 'Polaridad L' })).not.toBeChecked();
  });

  it('keeps the create draft when the server refuses the battery', async () => {
    const h = harness({ create: () => json('{"error":"conflict"}', 409) });
    await ready(h);
    typeCreate({ brand: 'TOYO', model: 'NS40ZL', capacity: '45', polarities: ['L'] });
    fireEvent.click(form().getByRole('button', { name: 'Crear batería' }));
    expect(await form().findByRole('alert')).toHaveTextContent(catalogBatteriesErrorMessages.conflict);
    expect(form().getByLabelText('Marca')).toHaveValue('TOYO');
    expect(form().getByLabelText('Modelo')).toHaveValue('NS40ZL');
    expect(form().getByLabelText('Capacidad (Ah)')).toHaveValue('45');
    expect(form().getByRole('checkbox', { name: 'Polaridad L' })).toBeChecked();
    expect(h.writes()).toHaveLength(1);
    expect(h.reads()).toHaveLength(1);
  });

  it('mirrors the create rules before writing anything', async () => {
    const h = harness();
    await ready(h);
    typeCreate({ brand: 'HYBRID', model: 'BT54L', capacity: '54' });
    fireEvent.click(form().getByRole('button', { name: 'Crear batería' }));
    expect(form().getByRole('alert')).toHaveTextContent(catalogBatteryPolarityMessage);
    expect(h.writes()).toHaveLength(0);
    fireEvent.click(form().getByRole('checkbox', { name: 'Polaridad L' }));
    fireEvent.change(form().getByLabelText('Marca'), { target: { value: '' } });
    fireEvent.click(form().getByRole('button', { name: 'Crear batería' }));
    expect(form().getByRole('alert')).toHaveTextContent(catalogBatteryNameMessage);
    fireEvent.change(form().getByLabelText('Marca'), { target: { value: 'HYBRID' } });
    fireEvent.change(form().getByLabelText('Capacidad (Ah)'), { target: { value: '0' } });
    fireEvent.click(form().getByRole('button', { name: 'Crear batería' }));
    expect(form().getByRole('alert')).toHaveTextContent(catalogBatteryCapacityMessage);
    expect(h.writes()).toHaveLength(0);
  });

  it('edits the complete identity of a listed battery and re-reads', async () => {
    const h = harness();
    await ready(h);
    fireEvent.click(within(rowOf('TOYO NS40ZL')).getByRole('button', { name: 'Editar TOYO NS40ZL' }));
    const editor = screen.getByRole('form', { name: 'Editar TOYO NS40ZL' });
    expect(within(editor).getByLabelText('Nueva marca')).toHaveValue('TOYO');
    expect(within(editor).getByLabelText('Nuevo modelo')).toHaveValue('NS40ZL');
    expect(within(editor).getByLabelText('Nueva capacidad (Ah)')).toHaveValue('45');
    // The variants are the database's identities: the edit never changes them.
    expect(within(editor).getByText(/L · R/)).toBeInTheDocument();
    expect(within(editor).queryByRole('checkbox')).not.toBeInTheDocument();
    fireEvent.change(within(editor).getByLabelText('Nueva capacidad (Ah)'), { target: { value: '45.5' } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Guardar cambios' }));
    await waitFor(() => expect(h.writes()).toHaveLength(1));
    expect(h.writes()[0].url).toBe('/api/catalog/batteries/96');
    expect(h.writes()[0].init).toMatchObject({ method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf } });
    expect(JSON.parse(String(h.writes()[0].init.body))).toEqual({ brand: 'TOYO', model: 'NS40ZL', capacity_ah: '45.5' });
    expect(await screen.findByText('Batería #96 actualizada: TOYO NS40ZL · 45.5 Ah.')).toBeInTheDocument();
    await waitFor(() => expect(h.reads()).toHaveLength(2));
    expect(screen.queryByRole('form', { name: 'Editar TOYO NS40ZL' })).not.toBeInTheDocument();
  });

  it('keeps the edit draft when the server refuses the identity', async () => {
    const h = harness({ edit: () => json('{"error":"conflict"}', 409) });
    await ready(h);
    fireEvent.click(within(rowOf('TOYO NS40ZL')).getByRole('button', { name: 'Editar TOYO NS40ZL' }));
    const editor = screen.getByRole('form', { name: 'Editar TOYO NS40ZL' });
    fireEvent.change(within(editor).getByLabelText('Nuevo modelo'), { target: { value: 'NS40ZR' } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Guardar cambios' }));
    expect(await within(editor).findByRole('alert')).toHaveTextContent(catalogBatteriesErrorMessages.conflict);
    expect(within(editor).getByLabelText('Nuevo modelo')).toHaveValue('NS40ZR');
    expect(within(editor).getByLabelText('Nueva capacidad (Ah)')).toHaveValue('45');
    expect(h.writes()).toHaveLength(1);
  });

  it('archives only after a confirmation and removes the retired battery from the list', async () => {
    let release = () => {};
    const pendingRead = new Promise<Response>(resolve => { release = () => resolve(json(pageBody([unpriced], 96))); });
    let reads = 0;
    const h = harness({ page: () => { reads += 1; return reads === 1 ? json(pageBody()) : pendingRead; } });
    await ready(h);
    fireEvent.click(within(rowOf('TOYO NS40ZL')).getByRole('button', { name: 'Archivar TOYO NS40ZL' }));
    const confirmation = screen.getByRole('group', { name: 'Archivar TOYO NS40ZL' });
    expect(within(confirmation).getByText(/no se puede volver a activar/i)).toBeInTheDocument();
    expect(h.writes()).toHaveLength(0);
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Confirmar archivado' }));
    await waitFor(() => expect(h.writes()).toHaveLength(1));
    expect(h.writes()[0].url).toBe('/api/catalog/batteries/96');
    expect(h.writes()[0].init).toMatchObject({ method: 'DELETE', headers: { 'X-CSRF-Token': csrf } });
    // The 204 is the retirement: the row leaves the editable list before the re-read.
    expect(await screen.findByText('Batería #96 archivada. No se puede volver a activar y deja de aparecer en el catálogo.'))
      .toBeInTheDocument();
    expect(screen.getAllByRole('row').some(row => (row.textContent ?? '').startsWith('TOYO NS40ZL'))).toBe(false);
    release();
    await waitFor(() => expect(h.reads()).toHaveLength(2));
  });

  it.each([
    ['catalog_battery_has_stock', /stock|existencias/i],
    ['catalog_battery_has_pending', /transferencia/i],
    ['conflict', /marca y modelo/i],
  ])('shows the %s refusal as its own message and keeps the battery', async (code, wording) => {
    const h = harness({ archive: () => json(JSON.stringify({ error: code }), 409) });
    await ready(h);
    fireEvent.click(within(rowOf('CAR NS60')).getByRole('button', { name: 'Archivar CAR NS60' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Archivar CAR NS60' }))
      .getByRole('button', { name: 'Confirmar archivado' }));
    const alert = await listing().findByRole('alert');
    expect(alert).toHaveTextContent(catalogBatteriesErrorMessages[code as keyof typeof catalogBatteriesErrorMessages]);
    expect(alert.textContent).toMatch(wording);
    expect(alert.textContent).not.toBe(catalogBatteriesErrorMessages.invalid_response);
    expect(rowOf('CAR NS60')).toBeInTheDocument();
    expect(h.reads()).toHaveLength(1);
  });

  it('reports an unavailable listing and reads it again on demand', async () => {
    let failing = true;
    const h = harness({ page: () => failing ? json('{"error":"service_unavailable"}', 503) : json(pageBody()) });
    render(<CatalogBatteries csrf={csrf} fetcher={h.fetcher} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(catalogBatteriesListUnavailable);
    failing = false;
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar catálogo' }));
    await screen.findByText('TOYO NS40ZL');
    expect(h.reads()).toHaveLength(2);
  });

  it('keeps the read contract in the query when the page changes', async () => {
    const h = harness();
    await ready(h);
    fireEvent.click(listing().getByRole('button', { name: 'Siguiente página' }));
    await waitFor(() => expect(h.reads()).toHaveLength(2));
    expect(h.reads()[1].url).toBe('/api/catalog/prices?page=2&page_size=10');
    fireEvent.change(listing().getByLabelText('Buscar marca o modelo'), { target: { value: 'NS40' } });
    await waitFor(() => expect(h.reads().at(-1)?.url).toBe('/api/catalog/prices?search=NS40&page=1&page_size=10'));
    expect(h.writes()).toHaveLength(0);
  });
});
