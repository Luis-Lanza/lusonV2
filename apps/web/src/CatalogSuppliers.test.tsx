import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import CatalogSuppliers from './CatalogSuppliers';
import {
  supplierContactMessage, supplierNameMessage, suppliersErrorMessages, suppliersListUnavailable,
} from './catalogSuppliersModel';

const csrf = 'c'.repeat(43);
const json = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
const supplierRow = (overrides: Record<string, unknown> = {}) => ({
  id: 3, name: 'Baterías del Sur', contact: 'Llamar al 4455-1122', retired: false,
  kinds: ['battery', 'other'], offers: 2, ...overrides,
});
const retiredRow = (overrides: Record<string, unknown> = {}) => ({
  id: 5, name: 'Repuestos Viejos', contact: '', retired: true, kinds: [], offers: 0, ...overrides,
});
const batteryEntry = { catalog_entry_id: 7, kind: 'battery', brand: 'Willard', model: '12N24', capacity_ah: '12' };
const otherEntry = { catalog_entry_id: 9, kind: 'other', name: 'Agua acidulada' };
const thirdEntry = { catalog_entry_id: 13, kind: 'other', name: 'Agua destilada' };
const listBody = (suppliers: readonly unknown[] = [supplierRow()], total = suppliers.length) =>
  JSON.stringify({ suppliers, page: 1, page_size: 10, total_suppliers: total });
const detailBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  id: 3, name: 'Baterías del Sur', contact: 'Llamar al 4455-1122', retired: false,
  offers: [batteryEntry, otherEntry], kinds: ['battery', 'other'], ...overrides,
});
const catalogBody = (entries: readonly unknown[] = [batteryEntry, otherEntry, thirdEntry]) =>
  JSON.stringify({ entries, page_size: 10, total_entries: entries.length });
const created = JSON.stringify({ id: 11, name: 'Baterías del Sur', contact: 'Llamar al 4455-1122' });
const edited = JSON.stringify({ id: 3, name: 'Baterías del Norte', contact: 'Llamar al 4000-0000' });

function harness(options: {
  page?: () => Response | Promise<Response>;
  detail?: () => Response | Promise<Response>;
  catalog?: () => Response | Promise<Response>;
  create?: (body: string) => Response | Promise<Response>;
  edit?: (id: string, body: string) => Response | Promise<Response>;
  retire?: (id: string) => Response | Promise<Response>;
  offers?: (id: string, body: string) => Response | Promise<Response>;
} = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const method = init.method ?? 'GET';
    if (url.startsWith('/api/suppliers/catalog?')) return options.catalog?.() ?? json(catalogBody());
    if (url === '/api/suppliers?' || url.startsWith('/api/suppliers?')) return options.page?.() ?? json(listBody());
    if (url === '/api/suppliers' && method === 'POST') return options.create?.(String(init.body)) ?? json(created, 201);
    const offerMatch = /^\/api\/suppliers\/(\d+)\/offers$/.exec(url);
    if (offerMatch && method === 'PUT') return options.offers?.(offerMatch[1], String(init.body)) ?? json(detailBody());
    const match = /^\/api\/suppliers\/(\d+)$/.exec(url);
    if (match && method === 'GET') return options.detail?.() ?? json(detailBody());
    if (match && method === 'PATCH') return options.edit?.(match[1], String(init.body)) ?? json(edited);
    if (match && method === 'DELETE') return options.retire?.(match[1]) ?? new Response(null, { status: 204 });
    throw new Error('Unexpected mocked URL: ' + method + ' ' + url);
  });
  return {
    fetcher, calls,
    listReads: () => calls.filter(call => call.url.startsWith('/api/suppliers?')),
    detailReads: () => calls.filter(call => /^\/api\/suppliers\/\d+$/.test(call.url)),
    catalogReads: () => calls.filter(call => call.url.startsWith('/api/suppliers/catalog?')),
    writes: () => calls.filter(call => call.init.method !== undefined && call.init.method !== 'GET'),
  };
}

const rows = () => screen.getAllByRole('row').filter(row => row.hasAttribute('data-supplier-id'));
const rowOf = (label: string) => rows().find(row => (row.textContent ?? '').startsWith(label))!;
const form = () => within(screen.getByRole('region', { name: 'Nuevo proveedor' }));
const listing = () => within(screen.getByRole('region', { name: 'Proveedores' }));
async function ready(h: ReturnType<typeof harness>) {
  render(<CatalogSuppliers csrf={csrf} fetcher={h.fetcher} />);
  await screen.findByRole('table');
}
function typeCreate(name = 'Baterías del Sur', contact = 'Llamar al 4455-1122') {
  fireEvent.change(form().getByLabelText('Nombre'), { target: { value: name } });
  fireEvent.change(form().getByLabelText('Contacto'), { target: { value: contact } });
}

describe('the suppliers screen', () => {
  it('lists every supplier with its contact, its products and its state', async () => {
    const h = harness({ page: () => json(listBody([supplierRow(), retiredRow()], 2)) });
    await ready(h);
    expect(h.listReads()[0].url).toBe('/api/suppliers?page=1&page_size=10');
    expect(h.listReads()[0].init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store' });
    const active = rowOf('Baterías del Sur');
    expect(within(active).getByText('Llamar al 4455-1122')).toBeInTheDocument();
    expect(within(active).getByText('2 productos')).toBeInTheDocument();
    expect(within(active).getByText('Baterías')).toBeInTheDocument();
    expect(within(active).getByText('Otros productos')).toBeInTheDocument();
    expect(within(active).getByText('Activo')).toBeInTheDocument();
    // The retired supplier stays listed, marked, and it offers no action at all.
    const retired = rowOf('Repuestos Viejos');
    expect(within(retired).getByText('Retirado')).toBeInTheDocument();
    expect(within(retired).getByText('Sin productos asignados')).toBeInTheDocument();
    expect(within(retired).queryByRole('button', { name: 'Editar Repuestos Viejos' })).not.toBeInTheDocument();
    expect(within(retired).queryByRole('button', { name: 'Retirar Repuestos Viejos' })).not.toBeInTheDocument();
    expect(within(retired).queryByRole('button', { name: 'Asignar productos a Repuestos Viejos' })).not.toBeInTheDocument();
    expect(listing().getByText('Mostrando 1–2 de 2 proveedores')).toBeInTheDocument();
    expect(h.writes()).toHaveLength(0);
  });

  it('reads the list again with the page size the operator chose', async () => {
    const h = harness();
    await ready(h);
    fireEvent.change(listing().getByLabelText('Proveedores por página'), { target: { value: '25' } });
    await waitFor(() => expect(h.listReads().at(-1)?.url).toBe('/api/suppliers?page=1&page_size=25'));
    expect(h.writes()).toHaveLength(0);
  });

  it('creates a supplier with its name and contact, then re-reads', async () => {
    const h = harness();
    await ready(h);
    typeCreate();
    fireEvent.click(form().getByRole('button', { name: 'Crear proveedor' }));
    await waitFor(() => expect(h.writes()).toHaveLength(1));
    const write = h.writes()[0];
    expect(write.url).toBe('/api/suppliers');
    expect(write.init).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf } });
    expect(JSON.parse(String(write.init.body))).toEqual({ name: 'Baterías del Sur', contact: 'Llamar al 4455-1122' });
    // The allocated id comes from the server response, and the list is re-read.
    expect(await screen.findByText('Proveedor #11 creado: Baterías del Sur.')).toBeInTheDocument();
    await waitFor(() => expect(h.listReads()).toHaveLength(2));
    expect(form().getByLabelText('Nombre')).toHaveValue('');
    expect(form().getByLabelText('Contacto')).toHaveValue('');
    expect(h.writes()).toHaveLength(1);
  });

  it('mirrors the create rules before writing anything', async () => {
    const h = harness();
    await ready(h);
    typeCreate('ab');
    fireEvent.click(form().getByRole('button', { name: 'Crear proveedor' }));
    expect(form().getByRole('alert')).toHaveTextContent(supplierNameMessage);
    typeCreate('á'.repeat(65));
    fireEvent.click(form().getByRole('button', { name: 'Crear proveedor' }));
    expect(form().getByRole('alert')).toHaveTextContent(supplierNameMessage);
    typeCreate('Baterías\tSur');
    fireEvent.click(form().getByRole('button', { name: 'Crear proveedor' }));
    expect(form().getByRole('alert')).toHaveTextContent(supplierNameMessage);
    typeCreate('Baterías del Sur', 'a'.repeat(201));
    fireEvent.click(form().getByRole('button', { name: 'Crear proveedor' }));
    expect(form().getByRole('alert')).toHaveTextContent(supplierContactMessage);
    // Nothing left the client for any of these refusals.
    expect(h.writes()).toHaveLength(0);
  });

  it('keeps the create draft when the server refuses the supplier', async () => {
    const h = harness({ create: () => json('{"error":"conflict"}', 409) });
    await ready(h);
    typeCreate('Baterías del Norte');
    fireEvent.click(form().getByRole('button', { name: 'Crear proveedor' }));
    expect(await form().findByRole('alert')).toHaveTextContent(suppliersErrorMessages.conflict);
    expect(form().getByLabelText('Nombre')).toHaveValue('Baterías del Norte');
    expect(form().getByLabelText('Contacto')).toHaveValue('Llamar al 4455-1122');
    expect(h.writes()).toHaveLength(1);
    expect(h.listReads()).toHaveLength(1);
  });

  it('edits a listed supplier in place, then re-reads', async () => {
    const h = harness();
    await ready(h);
    fireEvent.click(within(rowOf('Baterías del Sur')).getByRole('button', { name: 'Editar Baterías del Sur' }));
    const editor = within(screen.getByRole('form', { name: 'Editar Baterías del Sur' }));
    expect(editor.getByLabelText('Nuevo nombre')).toHaveValue('Baterías del Sur');
    expect(editor.getByLabelText('Contacto')).toHaveValue('Llamar al 4455-1122');
    fireEvent.change(editor.getByLabelText('Nuevo nombre'), { target: { value: 'Baterías del Norte' } });
    fireEvent.change(editor.getByLabelText('Contacto'), { target: { value: 'Llamar al 4000-0000' } });
    fireEvent.click(editor.getByRole('button', { name: 'Guardar cambios' }));
    await waitFor(() => expect(h.writes()).toHaveLength(1));
    expect(h.writes()[0].url).toBe('/api/suppliers/3');
    expect(h.writes()[0].init).toMatchObject({ method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf } });
    expect(JSON.parse(String(h.writes()[0].init.body))).toEqual({
      name: 'Baterías del Norte', contact: 'Llamar al 4000-0000',
    });
    expect(await screen.findByText('Proveedor #3 actualizado: Baterías del Norte.')).toBeInTheDocument();
    await waitFor(() => expect(h.listReads()).toHaveLength(2));
    expect(screen.queryByRole('form', { name: 'Editar Baterías del Sur' })).not.toBeInTheDocument();
  });

  it('keeps the edit draft when the server refuses the new name', async () => {
    const h = harness({ edit: () => json('{"error":"conflict"}', 409) });
    await ready(h);
    fireEvent.click(within(rowOf('Baterías del Sur')).getByRole('button', { name: 'Editar Baterías del Sur' }));
    const editor = within(screen.getByRole('form', { name: 'Editar Baterías del Sur' }));
    fireEvent.change(editor.getByLabelText('Nuevo nombre'), { target: { value: 'Repuestos Viejos' } });
    fireEvent.click(editor.getByRole('button', { name: 'Guardar cambios' }));
    expect(await editor.findByRole('alert')).toHaveTextContent(suppliersErrorMessages.conflict);
    expect(editor.getByLabelText('Nuevo nombre')).toHaveValue('Repuestos Viejos');
    expect(editor.getByLabelText('Contacto')).toHaveValue('Llamar al 4455-1122');
    expect(h.writes()).toHaveLength(1);
    expect(h.listReads()).toHaveLength(1);
  });

  it('retires only after a confirmation that explains Ingresos and the documents', async () => {
    let reads = 0;
    // The retired supplier no longer answers the listing: the server excludes it.
    const h = harness({ page: () => { reads += 1; return reads === 1 ? json(listBody()) : json(listBody([], 0)); } });
    await ready(h);
    fireEvent.click(within(rowOf('Baterías del Sur')).getByRole('button', { name: 'Retirar Baterías del Sur' }));
    const confirmation = screen.getByRole('group', { name: 'Retirar Baterías del Sur' });
    expect(within(confirmation).getByText(/Ingresos/)).toBeInTheDocument();
    expect(within(confirmation).getByText(/documentos/i)).toBeInTheDocument();
    expect(h.writes()).toHaveLength(0);
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Confirmar retiro' }));
    await waitFor(() => expect(h.writes()).toHaveLength(1));
    expect(h.writes()[0].url).toBe('/api/suppliers/3');
    expect(h.writes()[0].init).toMatchObject({ method: 'DELETE', headers: { 'X-CSRF-Token': csrf } });
    expect(await screen.findByText('Proveedor #3 retirado. Deja de estar disponible en Ingresos y sus documentos ya registrados se siguen leyendo.'))
      .toBeInTheDocument();
    expect(screen.queryAllByRole('row').some(row => (row.textContent ?? '').startsWith('Baterías del Sur'))).toBe(false);
    await waitFor(() => expect(h.listReads()).toHaveLength(2));
  });

  it.each([
    ['conflict', /nombre|modificar/i],
    ['not_found', /no existe/i],
  ])('shows the %s refusal as its own message and keeps the supplier', async (code, wording) => {
    const h = harness({ retire: () => json(JSON.stringify({ error: code }), code === 'not_found' ? 404 : 409) });
    await ready(h);
    fireEvent.click(within(rowOf('Baterías del Sur')).getByRole('button', { name: 'Retirar Baterías del Sur' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Retirar Baterías del Sur' }))
      .getByRole('button', { name: 'Confirmar retiro' }));
    const alert = await listing().findByRole('alert');
    expect(alert).toHaveTextContent(suppliersErrorMessages[code as keyof typeof suppliersErrorMessages]);
    expect(alert.textContent).toMatch(wording);
    expect(alert.textContent).not.toBe(suppliersErrorMessages.invalid_response);
    expect(rowOf('Baterías del Sur')).toBeInTheDocument();
    expect(h.listReads()).toHaveLength(1);
  });

  it('adds and removes assignments and saves the whole set once', async () => {
    const h = harness({
      offers: () => json(detailBody({ offers: [batteryEntry, thirdEntry] })),
    });
    await ready(h);
    fireEvent.click(within(rowOf('Baterías del Sur')).getByRole('button', { name: 'Asignar productos a Baterías del Sur' }));
    const editor = within(await screen.findByRole('form', { name: 'Productos que ofrece Baterías del Sur' }));
    await waitFor(() => expect(editor.getByText('Productos asignados: 2')).toBeInTheDocument());
    expect(h.detailReads()[0].url).toBe('/api/suppliers/3');
    expect(h.catalogReads()[0].url).toBe('/api/suppliers/catalog?page_size=10');
    // The assigned entries arrive checked, the rest of the catalogue stays unchecked.
    expect(editor.getByLabelText('Ofrecer Willard 12N24')).toBeChecked();
    expect(editor.getByLabelText('Ofrecer Agua acidulada')).toBeChecked();
    expect(editor.getByLabelText('Ofrecer Agua destilada')).not.toBeChecked();
    // Adding and removing are local: nothing is written until the whole set is saved.
    fireEvent.click(editor.getByLabelText('Ofrecer Agua destilada'));
    expect(editor.getByText('Productos asignados: 3')).toBeInTheDocument();
    fireEvent.click(editor.getByLabelText('Ofrecer Agua acidulada'));
    expect(editor.getByText('Productos asignados: 2')).toBeInTheDocument();
    expect(h.writes()).toHaveLength(0);
    fireEvent.click(editor.getByRole('button', { name: 'Guardar asignación' }));
    await waitFor(() => expect(h.writes()).toHaveLength(1));
    const write = h.writes()[0];
    expect(write.url).toBe('/api/suppliers/3/offers');
    expect(write.init).toMatchObject({ method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf } });
    expect(JSON.parse(String(write.init.body))).toEqual({ catalog_entry_ids: [7, 13] });
    expect(await screen.findByText('Proveedor #3 actualizado: ofrece 2 productos.')).toBeInTheDocument();
    // Only the supplier detail is read again: the catalogue of what can be assigned did not change.
    await waitFor(() => expect(h.detailReads()).toHaveLength(2));
    expect(h.catalogReads()).toHaveLength(1);
  });

  it('reads the assignable catalogue again with the search and the kind the operator chose', async () => {
    const h = harness();
    await ready(h);
    fireEvent.click(within(rowOf('Baterías del Sur')).getByRole('button', { name: 'Asignar productos a Baterías del Sur' }));
    const editor = within(await screen.findByRole('form', { name: 'Productos que ofrece Baterías del Sur' }));
    await waitFor(() => expect(h.catalogReads()).toHaveLength(1));
    fireEvent.change(editor.getByLabelText('Buscar en el catálogo'), { target: { value: 'Willard' } });
    await waitFor(() => expect(h.catalogReads().at(-1)?.url).toBe('/api/suppliers/catalog?search=Willard&page_size=10'));
    fireEvent.change(editor.getByLabelText('Tipo de producto'), { target: { value: 'battery' } });
    await waitFor(() => expect(h.catalogReads().at(-1)?.url)
      .toBe('/api/suppliers/catalog?kind=battery&search=Willard&page_size=10'));
    expect(h.writes()).toHaveLength(0);
  });

  it('keeps the assignment draft when the server refuses the set', async () => {
    const h = harness({ offers: () => json('{"error":"conflict"}', 409) });
    await ready(h);
    fireEvent.click(within(rowOf('Baterías del Sur')).getByRole('button', { name: 'Asignar productos a Baterías del Sur' }));
    const editor = within(await screen.findByRole('form', { name: 'Productos que ofrece Baterías del Sur' }));
    await waitFor(() => expect(editor.getByText('Productos asignados: 2')).toBeInTheDocument());
    fireEvent.click(editor.getByLabelText('Ofrecer Agua destilada'));
    fireEvent.click(editor.getByRole('button', { name: 'Guardar asignación' }));
    expect(await editor.findByRole('alert')).toHaveTextContent(suppliersErrorMessages.conflict);
    // The selected set is still the operator's draft, not the server's old one.
    expect(editor.getByText('Productos asignados: 3')).toBeInTheDocument();
    expect(editor.getByLabelText('Ofrecer Agua destilada')).toBeChecked();
    expect(h.writes()).toHaveLength(1);
    expect(h.detailReads()).toHaveLength(1);
  });

  it('saves an empty set and says that removing a product never erases a document', async () => {
    const h = harness({ offers: () => json(detailBody({ offers: [], kinds: [] })) });
    await ready(h);
    fireEvent.click(within(rowOf('Baterías del Sur')).getByRole('button', { name: 'Asignar productos a Baterías del Sur' }));
    const editor = within(await screen.findByRole('form', { name: 'Productos que ofrece Baterías del Sur' }));
    await waitFor(() => expect(editor.getByText('Productos asignados: 2')).toBeInTheDocument());
    expect(editor.getByText(/no borra los ingresos ya registrados/i)).toBeInTheDocument();
    fireEvent.click(editor.getByLabelText('Ofrecer Willard 12N24'));
    fireEvent.click(editor.getByLabelText('Ofrecer Agua acidulada'));
    expect(editor.getByText('Productos asignados: 0')).toBeInTheDocument();
    fireEvent.click(editor.getByRole('button', { name: 'Guardar asignación' }));
    await waitFor(() => expect(h.writes()).toHaveLength(1));
    expect(JSON.parse(String(h.writes()[0].init.body))).toEqual({ catalog_entry_ids: [] });
  });

  it('reports an unavailable listing and reads it again on demand', async () => {
    let failing = true;
    const h = harness({ page: () => failing ? json('{"error":"service_unavailable"}', 503) : json(listBody()) });
    render(<CatalogSuppliers csrf={csrf} fetcher={h.fetcher} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(suppliersListUnavailable);
    failing = false;
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar proveedores' }));
    await screen.findByText('Baterías del Sur');
    expect(h.listReads()).toHaveLength(2);
  });

  it.each([
    ['forbidden', 403],
    ['unauthenticated', 401],
  ])('shows the %s authority refusal with the words the other catalogue screens use', async (code, status) => {
    const h = harness({ page: () => json(JSON.stringify({ error: code }), status) });
    render(<CatalogSuppliers csrf={csrf} fetcher={h.fetcher} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      suppliersErrorMessages[code as keyof typeof suppliersErrorMessages]);
  });
});
