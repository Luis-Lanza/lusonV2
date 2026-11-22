import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import CashCategories from './CashCategories';
import {
  cashCategoriesArchivedEmpty, cashCategoriesEmpty, cashCategoriesErrorMessages,
  cashCategoriesListUnavailable, cashCategoriesLoading,
} from './cashCategoriesAPI';
import { notifyCatalogueInvalidation } from './useInventory';

const csrf = 'c'.repeat(43);
const json = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
const category = (overrides: Record<string, unknown> = {}) => ({
  id: 1, label: 'Alquiler', sort_order: 1, state: 'active', retired_at: null, retired_by: null, ...overrides,
});
const retired = (overrides: Record<string, unknown> = {}) => category({
  id: 12, label: 'Gas', sort_order: 12, state: 'retired',
  retired_at: '2026-11-12T10:00:00Z', retired_by: 'dev_almacen', ...overrides,
});
const listBody = (categories: readonly unknown[]) => JSON.stringify({ categories });
const one = (value: unknown) => JSON.stringify({ category: value });

const activeCatalogue = () => [
  category({ id: 1, label: 'Alquiler', sort_order: 1 }),
  category({ id: 2, label: 'Internet', sort_order: 2 }),
  category({ id: 11, label: 'Otros gastos', sort_order: 11 }),
  retired(),
];

function harness(options: {
  list?: () => Response | Promise<Response>;
  create?: (body: string) => Response | Promise<Response>;
  rename?: (id: string, body: string) => Response | Promise<Response>;
  retire?: (id: string) => Response | Promise<Response>;
  reactivate?: (id: string) => Response | Promise<Response>;
} = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const method = init.method ?? 'GET';
    if (url === '/api/admin/cash-categories' && method === 'GET') {
      return options.list?.() ?? json(listBody(activeCatalogue()));
    }
    if (url === '/api/admin/cash-categories' && method === 'POST') {
      return options.create?.(String(init.body))
        ?? json(one(category({ id: 13, label: 'Limpieza', sort_order: 13 })), 201);
    }
    const match = /^\/api\/admin\/cash-categories\/(\d+)\/(rename|retire|reactivate)$/.exec(url);
    if (match !== null) {
      const [, id, action] = match;
      if (action === 'rename') {
        return options.rename?.(id, String(init.body)) ?? json(one({ ...category({ id: Number(id) }), label: 'Alquiler del local' }));
      }
      if (action === 'retire') {
        return options.retire?.(id) ?? json(one(retired({ id: Number(id), label: 'Alquiler' })));
      }
      return options.reactivate?.(id) ?? json(one(category({ id: Number(id) })));
    }
    throw new Error('Unexpected mocked URL: ' + method + ' ' + url);
  });
  return {
    fetcher, calls,
    reads: () => calls.filter(call => (call.init.method ?? 'GET') === 'GET'),
    writes: () => calls.filter(call => (call.init.method ?? 'GET') !== 'GET'),
  };
}

const rowOf = (label: string) => screen.getAllByRole('row')
  .find(row => row.hasAttribute('data-motive-id') && (row.textContent ?? '').includes(label))!;
const createForm = () => within(screen.getByRole('form', { name: 'Agregar un motivo' }));
const archivedBlock = () => within(screen.getByText(/^Archivados \(\d+\)$/).closest('details')!);

async function ready(h: ReturnType<typeof harness>) {
  render(<CashCategories csrf={csrf} fetcher={h.fetcher} />);
  await screen.findByRole('form', { name: 'Agregar un motivo' });
}

describe('the cash motives administration screen', () => {
  it('lists the active motives in the catalogue order with place, label, state and actions', async () => {
    const h = harness();
    await ready(h);
    expect(h.reads()[0].url).toBe('/api/admin/cash-categories');
    expect(h.reads()[0].init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store' });
    const alquiler = within(rowOf('Alquiler'));
    expect(alquiler.getByText('01')).toBeInTheDocument();
    expect(alquiler.getByText('Activo')).toBeInTheDocument();
    expect(alquiler.getByRole('button', { name: 'Renombrar Alquiler' })).toBeEnabled();
    expect(alquiler.getByRole('button', { name: 'Archivar Alquiler' })).toBeEnabled();
    expect(within(rowOf('Internet')).getByText('02')).toBeInTheDocument();
    expect(h.writes()).toHaveLength(0);
  });

  it('disables the archival of «Otros gastos» and states both guard rules next to it', async () => {
    const h = harness();
    await ready(h);
    const others = within(rowOf('Otros gastos'));
    const archive = others.getByRole('button', { name: 'Archivar Otros gastos' });
    expect(archive).toBeDisabled();
    expect(others.getByText('No se archiva: es el cajón de sastre.')).toBeInTheDocument();
    expect(others.getByRole('button', { name: 'Renombrar Otros gastos' })).toBeEnabled();
    // A disabled control cannot be focused to explain itself: the reason is written beside it.
    expect(archive.getAttribute('aria-describedby')).toBeTruthy();
    expect(document.getElementById(archive.getAttribute('aria-describedby')!)).toHaveTextContent('cajón de sastre');
    const guard = screen.getByText(/«Otros gastos» no se archiva/).closest('p')!;
    expect(guard.textContent).toContain('último motivo activo');
    fireEvent.click(archive);
    expect(h.writes()).toHaveLength(0);
  });

  it('keeps the archived motives in a collapsed block with their instant, author and reactivation', async () => {
    const h = harness();
    await ready(h);
    const block = archivedBlock();
    expect(block.getByText(/Archivado el/).textContent).toContain('dev_almacen');
    expect(block.getByText('Archivado')).toBeInTheDocument();
    expect(block.getByRole('button', { name: 'Reactivar Gas' })).toBeInTheDocument();
    // The block is collapsed until the operator opens it.
    expect(screen.getByText('Archivados (1)').closest('details')?.hasAttribute('open')).toBe(false);
  });

  it('creates at the foot of the panel with the label alone and re-reads the list', async () => {
    const h = harness();
    await ready(h);
    fireEvent.change(createForm().getByLabelText('Agregar un motivo'), { target: { value: 'Limpieza' } });
    expect(screen.getByText(/Se agrega al final de la lista/)).toBeInTheDocument();
    fireEvent.click(createForm().getByRole('button', { name: 'Agregar al final' }));
    await waitFor(() => expect(h.writes()).toHaveLength(1));
    const write = h.writes()[0];
    expect(write.url).toBe('/api/admin/cash-categories');
    expect(write.init).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf } });
    expect(JSON.parse(String(write.init.body))).toEqual({ label: 'Limpieza' });
    await waitFor(() => expect(h.reads()).toHaveLength(2));
    expect(createForm().getByLabelText('Agregar un motivo')).toHaveValue('');
  });

  it('states the duplicated label rejection with the server wording and keeps what was typed', async () => {
    const h = harness({ create: () => json(JSON.stringify({ error: 'duplicate_label' }), 409) });
    await ready(h);
    fireEvent.change(createForm().getByLabelText('Agregar un motivo'), { target: { value: 'Limpieza' } });
    fireEvent.click(createForm().getByRole('button', { name: 'Agregar al final' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Ya existe un motivo llamado «Limpieza». Elegí otro nombre.');
    expect(createForm().getByLabelText('Agregar un motivo')).toHaveValue('Limpieza');
    expect(h.reads()).toHaveLength(1);
  });

  it('states the invalid request rejection on its own line', async () => {
    const h = harness({ create: () => json(JSON.stringify({ error: 'invalid_request' }), 400) });
    await ready(h);
    fireEvent.change(createForm().getByLabelText('Agregar un motivo'), { target: { value: 'Limpieza' } });
    fireEvent.click(createForm().getByRole('button', { name: 'Agregar al final' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(cashCategoriesErrorMessages.invalid_request);
    expect(createForm().getByLabelText('Agregar un motivo')).toHaveValue('Limpieza');
  });

  it('renames in place with the current label preloaded, saves explicitly and keeps the history note', async () => {
    let rows = activeCatalogue();
    const h = harness({
      list: () => json(listBody(rows)),
      rename: () => {
        rows = rows.map(row => row.id === 1 ? { ...row, label: 'Alquiler del local' } : row);
        return json(one(rows[0]));
      },
    });
    await ready(h);
    fireEvent.click(within(rowOf('Alquiler')).getByRole('button', { name: 'Renombrar Alquiler' }));
    const form = within(screen.getByRole('form', { name: 'Renombrar Alquiler' }));
    const field = form.getByLabelText('Nuevo nombre');
    expect(field).toHaveValue('Alquiler');
    expect(form.getByText(/conservan la etiqueta con la que se guardaron/)).toBeInTheDocument();
    expect(h.writes()).toHaveLength(0);
    fireEvent.change(field, { target: { value: 'Alquiler del local' } });
    fireEvent.click(form.getByRole('button', { name: 'Guardar nombre' }));
    await waitFor(() => expect(h.writes()).toHaveLength(1));
    expect(h.writes()[0].url).toBe('/api/admin/cash-categories/1/rename');
    expect(JSON.parse(String(h.writes()[0].init.body))).toEqual({ label: 'Alquiler del local' });
    await waitFor(() => expect(h.reads()).toHaveLength(2));
    expect(within(rowOf('Alquiler del local')).getByText('Activo')).toBeInTheDocument();
  });

  it('confirms the archival before sending it, saying it is reversible and touches no movement', async () => {
    let rows = activeCatalogue();
    const h = harness({
      list: () => json(listBody(rows)),
      retire: () => {
        rows = rows.map(row => row.id === 1 ? retired({ id: 1, label: 'Alquiler' }) : row);
        return json(one(retired({ id: 1, label: 'Alquiler' })));
      },
    });
    await ready(h);
    fireEvent.click(within(rowOf('Alquiler')).getByRole('button', { name: 'Archivar Alquiler' }));
    expect(h.writes()).toHaveLength(0);
    const confirmation = within(screen.getByText('Archivar Alquiler').closest('fieldset')!);
    expect(confirmation.getByText(/es reversible/).textContent).toContain('reactivarlo');
    expect(confirmation.getByText(/No toca ningún movimiento ya registrado/)).toBeInTheDocument();
    fireEvent.click(confirmation.getByRole('button', { name: 'Confirmar archivo' }));
    await waitFor(() => expect(h.writes()).toHaveLength(1));
    expect(h.writes()[0].url).toBe('/api/admin/cash-categories/1/retire');
    expect(h.writes()[0].init.body).toBeUndefined();
    await waitFor(() => expect(h.reads()).toHaveLength(2));
    expect(within(rowOf('Alquiler')).queryByRole('button', { name: 'Archivar Alquiler' })).not.toBeInTheDocument();
    expect(archivedBlock().getByRole('button', { name: 'Reactivar Alquiler' })).toBeInTheDocument();
  });

  it('reactivates an archived motive through its own route and re-reads the list', async () => {
    let rows = activeCatalogue();
    const h = harness({
      list: () => json(listBody(rows)),
      reactivate: () => {
        rows = rows.map(row => row.id === 12 ? category({ id: 12, label: 'Gas', sort_order: 12 }) : row);
        return json(one(rows.find(row => row.id === 12)!));
      },
    });
    await ready(h);
    fireEvent.click(archivedBlock().getByRole('button', { name: 'Reactivar Gas' }));
    await waitFor(() => expect(h.writes()).toHaveLength(1));
    expect(h.writes()[0].url).toBe('/api/admin/cash-categories/12/reactivate');
    await waitFor(() => expect(h.reads()).toHaveLength(2));
    expect(screen.getByText('Archivados (0)')).toBeInTheDocument();
    expect(archivedBlock().getByText(cashCategoriesArchivedEmpty)).toBeInTheDocument();
    expect(within(rowOf('Gas')).getByText('04')).toBeInTheDocument();
  });

  it('distinguishes loading, empty and failure with their own copy and a retry', async () => {
    let release: (value: Response) => void = () => {};
    const pending = new Promise<Response>(resolve => { release = resolve; });
    render(<CashCategories csrf={csrf} fetcher={vi.fn<typeof fetch>(async () => pending)} />);
    expect(screen.getByText(cashCategoriesLoading)).toBeInTheDocument();
    release(json(listBody([])));
    await screen.findByText(cashCategoriesEmpty);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    let reads = 0;
    const h = harness({
      list: () => (reads++ === 0
        ? json(JSON.stringify({ error: 'invalid_request' }), 400)
        : json(listBody(activeCatalogue()))),
    });
    const screenRead = render(<CashCategories csrf={csrf} fetcher={h.fetcher} />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(cashCategoriesListUnavailable);
    fireEvent.click(within(alert).getByRole('button', { name: 'Reintentar catálogo de motivos' }));
    await waitFor(() => expect(h.reads()).toHaveLength(2));
    expect(await screen.findAllByRole('table')).toHaveLength(2);
    screenRead.unmount();
  });

  it('re-reads the list on a catalogue invalidation', async () => {
    const h = harness();
    await ready(h);
    expect(h.reads()).toHaveLength(1);
    act(() => notifyCatalogueInvalidation());
    await waitFor(() => expect(h.reads()).toHaveLength(2));
    expect(h.reads()[1].url).toBe('/api/admin/cash-categories');
  });
});
