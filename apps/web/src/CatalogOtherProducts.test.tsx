import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import CatalogOtherProducts from './CatalogOtherProducts';
import {
  catalogOtherProductDuplicateFieldMessage, catalogOtherProductNameMessage, catalogOtherProductNumberMessage,
  catalogOtherProductsErrorMessages, catalogOtherProductsListUnavailable,
} from './catalogOtherProductsModel';

const csrf = 'c'.repeat(43);
const json = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
const product = (overrides: Record<string, unknown> = {}) => ({
  id: 113, name: 'Agua acidulada',
  fields: [
    { name: 'volumen en L', kind: 'number', unit: 'L', number: '5' },
    { name: 'origen', kind: 'text', text: 'importado' },
  ], ...overrides,
});
const pageBody = (products: readonly unknown[] = [product()], total = 1) => JSON.stringify({
  products, page: 1, page_size: 10, total_products: total,
});
const created = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  id: 114, name: 'Agua acidulada',
  fields: [
    { name: 'volumen en L', kind: 'number', unit: 'L', number: '5' },
    { name: 'origen', kind: 'text', text: 'importado' },
  ], ...overrides,
});
const edited = JSON.stringify({
  id: 113, name: 'Agua acidulada', fields: [{ name: 'color', kind: 'text', text: 'ámbar' }],
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
    if (url.startsWith('/api/catalog/other-products?')) return options.page?.() ?? json(pageBody());
    if (url === '/api/catalog/other-products' && method === 'POST') {
      return options.create?.(String(init.body)) ?? json(created(), 201);
    }
    const match = /^\/api\/catalog\/other-products\/(\d+)$/.exec(url);
    if (match && method === 'PATCH') return options.edit?.(match[1], String(init.body)) ?? json(edited);
    if (match && method === 'DELETE') return options.archive?.(match[1]) ?? new Response(null, { status: 204 });
    throw new Error('Unexpected mocked URL: ' + method + ' ' + url);
  });
  return {
    fetcher, calls,
    reads: () => calls.filter(call => call.url.startsWith('/api/catalog/other-products?')),
    writes: () => calls.filter(call => call.init.method !== undefined && call.init.method !== 'GET'),
  };
}

const rowOf = (label: string) => screen.getAllByRole('row')
  .find(row => row.hasAttribute('data-product-id') && (row.textContent ?? '').startsWith(label))!;
const form = () => within(screen.getByRole('region', { name: 'Nuevo producto' }));
const listing = () => within(screen.getByRole('region', { name: 'Otros productos' }));
const fieldRow = (scope: ReturnType<typeof within>, index: number) =>
  scope.getByRole('group', { name: `Campo ${index}` });

interface FieldInput { readonly name: string; readonly kind?: 'Texto'; readonly unit?: string; readonly value: string }
function typeCreate(fields: readonly FieldInput[], name = 'Agua acidulada') {
  fireEvent.change(form().getByLabelText('Nombre'), { target: { value: name } });
  fields.forEach((field, index) => {
    if (index > 0) fireEvent.click(form().getByRole('button', { name: 'Agregar campo' }));
    const row = within(fieldRow(form(), index + 1));
    fireEvent.change(row.getByLabelText('Nombre del campo'), { target: { value: field.name } });
    if (field.kind === 'Texto') fireEvent.change(row.getByLabelText('Tipo'), { target: { value: 'text' } });
    if (field.unit !== undefined) fireEvent.change(row.getByLabelText('Unidad (opcional)'), { target: { value: field.unit } });
    fireEvent.change(row.getByLabelText('Valor'), { target: { value: field.value } });
  });
}
async function ready(h: ReturnType<typeof harness>) {
  render(<CatalogOtherProducts csrf={csrf} fetcher={h.fetcher} />);
  await screen.findByRole('table');
}

describe('the other products catalogue screen', () => {
  it('lists every product with its fields rendered readably', async () => {
    const h = harness();
    await ready(h);
    expect(h.reads()[0].url).toBe('/api/catalog/other-products?page=1&page_size=10');
    expect(h.reads()[0].init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store' });
    const row = rowOf('Agua acidulada');
    // A number renders with its unit, a text as it was written.
    expect(within(row).getByText('volumen en L: 5 L')).toBeInTheDocument();
    expect(within(row).getByText('origen: importado')).toBeInTheDocument();
    expect(listing().getByText('Mostrando 1–1 de 1 producto')).toBeInTheDocument();
    expect(h.writes()).toHaveLength(0);
  });

  it('reads the list again with the search the operator typed', async () => {
    const h = harness();
    await ready(h);
    fireEvent.change(listing().getByLabelText('Buscar producto'), { target: { value: 'Agua' } });
    await waitFor(() => expect(h.reads().at(-1)?.url).toBe('/api/catalog/other-products?search=Agua&page=1&page_size=10'));
    expect(h.writes()).toHaveLength(0);
  });

  it('creates a product with a numeric field carrying a unit and a text field, then re-reads', async () => {
    const h = harness();
    await ready(h);
    typeCreate([
      { name: 'volumen en L', unit: 'L', value: '5' },
      { name: 'origen', kind: 'Texto', value: 'importado' },
    ]);
    fireEvent.click(form().getByRole('button', { name: 'Crear producto' }));
    await waitFor(() => expect(h.writes()).toHaveLength(1));
    const write = h.writes()[0];
    expect(write.url).toBe('/api/catalog/other-products');
    expect(write.init).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf } });
    expect(JSON.parse(String(write.init.body))).toEqual({
      name: 'Agua acidulada',
      fields: [
        { name: 'volumen en L', kind: 'number', number: '5', unit: 'L' },
        { name: 'origen', kind: 'text', text: 'importado' },
      ],
    });
    // The allocated id comes from the server response, and the list is re-read.
    expect(await screen.findByText('Producto #114 creado: Agua acidulada · 2 campos.')).toBeInTheDocument();
    await waitFor(() => expect(h.reads()).toHaveLength(2));
    expect(form().getByLabelText('Nombre')).toHaveValue('');
    expect(form().getAllByLabelText('Nombre del campo')).toHaveLength(1);
    expect(form().getByLabelText('Nombre del campo')).toHaveValue('');
    expect(h.writes()).toHaveLength(1);
  });

  it('adds and removes the repeatable field rows', async () => {
    const h = harness();
    await ready(h);
    expect(form().getAllByLabelText('Nombre del campo')).toHaveLength(1);
    fireEvent.click(form().getByRole('button', { name: 'Agregar campo' }));
    expect(form().getAllByLabelText('Nombre del campo')).toHaveLength(2);
    fireEvent.click(form().getByRole('button', { name: 'Quitar campo 2' }));
    expect(form().getAllByLabelText('Nombre del campo')).toHaveLength(1);
    // The unit belongs to a numeric field: a text field offers no unit at all.
    expect(within(fieldRow(form(), 1)).getByLabelText('Unidad (opcional)')).toBeInTheDocument();
    fireEvent.change(within(fieldRow(form(), 1)).getByLabelText('Tipo'), { target: { value: 'text' } });
    expect(within(fieldRow(form(), 1)).queryByLabelText('Unidad (opcional)')).not.toBeInTheDocument();
    expect(h.writes()).toHaveLength(0);
  });

  it('mirrors the create rules before writing anything', async () => {
    const h = harness();
    await ready(h);
    typeCreate([{ name: 'volumen en L', unit: 'L', value: '5' }], 'ab');
    fireEvent.click(form().getByRole('button', { name: 'Crear producto' }));
    expect(form().getByRole('alert')).toHaveTextContent(catalogOtherProductNameMessage);
    fireEvent.change(form().getByLabelText('Nombre'), { target: { value: 'Agua acidulada' } });
    fireEvent.click(form().getByRole('button', { name: 'Agregar campo' }));
    const second = within(fieldRow(form(), 2));
    fireEvent.change(second.getByLabelText('Nombre del campo'), { target: { value: 'VOLUMEN EN L' } });
    fireEvent.change(second.getByLabelText('Tipo'), { target: { value: 'text' } });
    fireEvent.change(second.getByLabelText('Valor'), { target: { value: 'x' } });
    fireEvent.click(form().getByRole('button', { name: 'Crear producto' }));
    expect(form().getByRole('alert')).toHaveTextContent(catalogOtherProductDuplicateFieldMessage);
    fireEvent.click(form().getByRole('button', { name: 'Quitar campo 2' }));
    fireEvent.change(within(fieldRow(form(), 1)).getByLabelText('Valor'), { target: { value: 'mucho' } });
    fireEvent.click(form().getByRole('button', { name: 'Crear producto' }));
    expect(form().getByRole('alert')).toHaveTextContent(catalogOtherProductNumberMessage);
    expect(h.writes()).toHaveLength(0);
  });

  it('keeps the create draft when the server refuses the product', async () => {
    const h = harness({ create: () => json('{"error":"conflict"}', 409) });
    await ready(h);
    typeCreate([{ name: 'volumen en L', unit: 'L', value: '5' }]);
    fireEvent.click(form().getByRole('button', { name: 'Crear producto' }));
    expect(await form().findByRole('alert')).toHaveTextContent(catalogOtherProductsErrorMessages.conflict);
    expect(form().getByLabelText('Nombre')).toHaveValue('Agua acidulada');
    expect(within(fieldRow(form(), 1)).getByLabelText('Nombre del campo')).toHaveValue('volumen en L');
    expect(within(fieldRow(form(), 1)).getByLabelText('Unidad (opcional)')).toHaveValue('L');
    expect(within(fieldRow(form(), 1)).getByLabelText('Valor')).toHaveValue('5');
    expect(h.writes()).toHaveLength(1);
    expect(h.reads()).toHaveLength(1);
  });

  it('edits a listed product by replacing its whole field set, then re-reads', async () => {
    const h = harness();
    await ready(h);
    fireEvent.click(within(rowOf('Agua acidulada')).getByRole('button', { name: 'Editar Agua acidulada' }));
    const editor = within(screen.getByRole('form', { name: 'Editar Agua acidulada' }));
    expect(editor.getByLabelText('Nuevo nombre')).toHaveValue('Agua acidulada');
    expect(within(fieldRow(editor, 1)).getByLabelText('Nombre del campo')).toHaveValue('volumen en L');
    expect(within(fieldRow(editor, 1)).getByLabelText('Valor')).toHaveValue('5');
    expect(within(fieldRow(editor, 2)).getByLabelText('Tipo')).toHaveValue('text');
    // Replacing means replacing: the previous fields are dropped, never merged.
    fireEvent.click(editor.getByRole('button', { name: 'Quitar campo 2' }));
    fireEvent.click(editor.getByRole('button', { name: 'Quitar campo 1' }));
    fireEvent.click(editor.getByRole('button', { name: 'Agregar campo' }));
    const row = within(fieldRow(editor, 1));
    fireEvent.change(row.getByLabelText('Nombre del campo'), { target: { value: 'color' } });
    fireEvent.change(row.getByLabelText('Tipo'), { target: { value: 'text' } });
    fireEvent.change(row.getByLabelText('Valor'), { target: { value: 'ámbar' } });
    fireEvent.click(editor.getByRole('button', { name: 'Guardar cambios' }));
    await waitFor(() => expect(h.writes()).toHaveLength(1));
    expect(h.writes()[0].url).toBe('/api/catalog/other-products/113');
    expect(h.writes()[0].init).toMatchObject({ method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf } });
    expect(JSON.parse(String(h.writes()[0].init.body))).toEqual({
      name: 'Agua acidulada', fields: [{ name: 'color', kind: 'text', text: 'ámbar' }],
    });
    expect(await screen.findByText('Producto #113 actualizado: Agua acidulada · 1 campo.')).toBeInTheDocument();
    await waitFor(() => expect(h.reads()).toHaveLength(2));
    expect(screen.queryByRole('form', { name: 'Editar Agua acidulada' })).not.toBeInTheDocument();
  });

  it('keeps the edit draft when the server refuses the new field set', async () => {
    const h = harness({ edit: () => json('{"error":"conflict"}', 409) });
    await ready(h);
    fireEvent.click(within(rowOf('Agua acidulada')).getByRole('button', { name: 'Editar Agua acidulada' }));
    const editor = within(screen.getByRole('form', { name: 'Editar Agua acidulada' }));
    fireEvent.change(editor.getByLabelText('Nuevo nombre'), { target: { value: 'Agua acidulada fina' } });
    fireEvent.click(editor.getByRole('button', { name: 'Guardar cambios' }));
    expect(await editor.findByRole('alert')).toHaveTextContent(catalogOtherProductsErrorMessages.conflict);
    expect(editor.getByLabelText('Nuevo nombre')).toHaveValue('Agua acidulada fina');
    expect(h.writes()).toHaveLength(1);
    expect(h.reads()).toHaveLength(1);
  });

  it('retires only after a confirmation and removes the product from the list', async () => {
    let release = () => {};
    const pendingRead = new Promise<Response>(resolve => { release = () => resolve(json(pageBody([], 0))); });
    let reads = 0;
    const h = harness({ page: () => { reads += 1; return reads === 1 ? json(pageBody()) : pendingRead; } });
    await ready(h);
    fireEvent.click(within(rowOf('Agua acidulada')).getByRole('button', { name: 'Retirar Agua acidulada' }));
    const confirmation = screen.getByRole('group', { name: 'Retirar Agua acidulada' });
    expect(within(confirmation).getByText(/no se puede volver a activar/i)).toBeInTheDocument();
    expect(h.writes()).toHaveLength(0);
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Confirmar retiro' }));
    await waitFor(() => expect(h.writes()).toHaveLength(1));
    expect(h.writes()[0].url).toBe('/api/catalog/other-products/113');
    expect(h.writes()[0].init).toMatchObject({ method: 'DELETE', headers: { 'X-CSRF-Token': csrf } });
    // The 204 is the retirement: the row leaves the editable list before the re-read.
    expect(await screen.findByText('Producto #113 retirado. No se puede volver a activar y deja de aparecer en el catálogo.'))
      .toBeInTheDocument();
    expect(screen.queryAllByRole('row').some(row => (row.textContent ?? '').startsWith('Agua acidulada'))).toBe(false);
    release();
    await waitFor(() => expect(h.reads()).toHaveLength(2));
  });

  it.each([
    ['catalog_product_has_stock', /stock|existencias/i],
    ['catalog_product_has_pending', /transferencia/i],
    ['not_found', /catálogo activo/i],
  ])('shows the %s refusal as its own message and keeps the product', async (code, wording) => {
    const h = harness({ archive: () => json(JSON.stringify({ error: code }), code === 'not_found' ? 404 : 409) });
    await ready(h);
    fireEvent.click(within(rowOf('Agua acidulada')).getByRole('button', { name: 'Retirar Agua acidulada' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Retirar Agua acidulada' }))
      .getByRole('button', { name: 'Confirmar retiro' }));
    const alert = await listing().findByRole('alert');
    expect(alert).toHaveTextContent(catalogOtherProductsErrorMessages[code as keyof typeof catalogOtherProductsErrorMessages]);
    expect(alert.textContent).toMatch(wording);
    expect(alert.textContent).not.toBe(catalogOtherProductsErrorMessages.invalid_response);
    expect(rowOf('Agua acidulada')).toBeInTheDocument();
    expect(h.reads()).toHaveLength(1);
  });

  it('reports an unavailable listing and reads it again on demand', async () => {
    let failing = true;
    const h = harness({ page: () => failing ? json('{"error":"service_unavailable"}', 503) : json(pageBody()) });
    render(<CatalogOtherProducts csrf={csrf} fetcher={h.fetcher} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(catalogOtherProductsListUnavailable);
    failing = false;
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar catálogo' }));
    await screen.findByText('Agua acidulada');
    expect(h.reads()).toHaveLength(2);
  });
});
