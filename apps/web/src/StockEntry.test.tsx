import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import StockEntry from './StockEntry';
import { stockEntryErrorMessages, stockEntryReversalErrorMessages } from './stockEntryModel';

const csrf = 'c'.repeat(43);
const row = (variant_id: number, model: string, existing = 14, capacity = 35) => JSON.stringify({
  variant_id, catalog_entry_id: 1, brand: 'TOYO', model, capacity_ah: capacity, polarity: 'L', existing, reserved: 0, available: existing,
});
const catalogPage = (items: readonly string[]) =>
  `{"location":{"id":1,"name":"Almacén"},"items":[${items.join(',')}],"page":1,"page_size":50,"total_variants":${items.length}}`;
const catalogReply = (search: string) => new Response(
  catalogPage(search === 'NS60' ? [row(9, 'NS60L', 9, 45)] : search === 'nada' ? [] : [row(4, 'NS40ZL'), row(9, 'NS60L', 9, 45)]),
  { status: 200, headers: { 'Content-Type': 'application/json' } });
const entryReply = () => new Response(JSON.stringify({
  id: 7, location_id: 1, note: 'Remito 0002', created_by_account_id: 1, created_at: '2026-05-01T14:20:00Z',
  lines: [{ variant_id: 4, quantity: 3 }], total_units: 3,
}), { status: 201, headers: { 'Content-Type': 'application/json' } });
const errorReply = (code: string, status: number) => new Response(JSON.stringify({ error: code }),
  { status, headers: { 'Content-Type': 'application/json' } });
const historyRow = (id: number, note: string, lines: number, units: number, reversedBy: number | null = null) =>
  JSON.stringify({ id, note, created_at: '2026-05-01T14:20:00Z', lines, total_units: units, reversed_by: reversedBy });
const historyReply = (rows: readonly string[], page = 1, pageSize = 25, total = rows.length) => new Response(
  JSON.stringify({ page, page_size: pageSize, total_entries: total,
    entries: rows.map(row => JSON.parse(row) as unknown) }),
  { status: 200, headers: { 'Content-Type': 'application/json' } });
const defaultHistoryRows = [historyRow(6, 'Remito 0002', 2, 18), historyRow(5, '', 1, 3)];

function harness(options: {
  catalog?: (search: string) => Response;
  create?: (body: string) => Response | Promise<Response>;
  history?: (query: URLSearchParams) => Response | Promise<Response>;
  reverse?: (target: string, body: string) => Response | Promise<Response>;
  detail?: (id: string) => Response | Promise<Response>;
} = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.startsWith('/api/inventory?')) {
      const search = new URL(url, 'http://localhost').searchParams.get('search') ?? '';
      return options.catalog?.(search) ?? catalogReply(search);
    }
    if (url.startsWith('/api/stock-entries?')) {
      return options.history?.(new URL(url, 'http://localhost').searchParams) ?? historyReply(defaultHistoryRows);
    }
    if (url === '/api/stock-entries') return options.create?.(String(init.body)) ?? entryReply();
    const reversal = /^\/api\/stock-entries\/([^/]+)\/reverse$/.exec(url);
    if (reversal) return options.reverse?.(reversal[1], String(init.body)) ?? counterReply();
    const detail = /^\/api\/stock-entries\/([^/?]+)$/.exec(url);
    if (detail) return options.detail?.(detail[1]) ?? detailReply();
    throw new Error('Unexpected mocked URL: ' + url);
  });
  return { fetcher, calls, catalogs: () => calls.filter(call => call.url.startsWith('/api/inventory?')),
    posts: () => calls.filter(call => call.url === '/api/stock-entries'),
    histories: () => calls.filter(call => call.url.startsWith('/api/stock-entries?')),
    reversals: () => calls.filter(call => call.url.endsWith('/reverse')),
    details: () => calls.filter(call => /^\/api\/stock-entries\/[^/?]+$/.test(call.url)) };
}

// The counter-entry of `historyRow(6, ..., 2, 18)`: the same lines, negated.
const counterReply = (overrides: Record<string, unknown> = {}) => new Response(JSON.stringify({
  id: 10, location_id: 1, note: '', created_by_account_id: 1, created_at: '2026-05-01T14:25:00Z',
  lines: [{ variant_id: 4, quantity: -3 }, { variant_id: 9, quantity: -15 }], total_units: -18, ...overrides,
}), { status: 201, headers: { 'Content-Type': 'application/json' } });
// The per-document detail of the row used by the detail tests: two catalogue lines
// summing to the listed total.
const detailLineOf = (variant_id: number, model: string, quantity: number, capacity = '45') =>
  ({ variant_id, brand: 'TOYO', model, capacity_ah: capacity, polarity: 'L' as const, quantity });
const detailReply = (overrides: Record<string, unknown> = {}) => new Response(JSON.stringify({
  id: 6, location_id: 1, note: 'Remito 0002', created_at: '2026-05-01T14:20:00Z',
  created_by_account_id: 1, reverses_entry_id: null, reversed_by: null, reason: '',
  lines: [detailLineOf(4, 'NS40ZL', 3, '35'), detailLineOf(9, 'NS60L', 15)], total_units: 18, ...overrides,
}), { status: 200, headers: { 'Content-Type': 'application/json' } });
const counterBody = (id: number) => JSON.stringify({
  id, location_id: 1, note: '', created_by_account_id: 1, created_at: '2026-05-01T14:25:00Z',
  lines: [{ variant_id: 4, quantity: -3 }, { variant_id: 9, quantity: -15 }], total_units: -18 });
const openReversal = async (historial: HTMLElement) => {
  fireEvent.click(within(historial).getByRole('button', { name: 'Anular ingreso #6' }));
  return screen.getByRole('dialog', { name: 'Registrar contra-asiento' });
};
const sections = () => ({
  catalogo: screen.getByRole('region', { name: 'Catálogo' }),
  documento: screen.getByRole('region', { name: 'Documento de ingreso' }),
  historial: screen.getByRole('region', { name: 'Historial de ingresos' }),
});
const totalFor = (label: string) => within(sections().documento).getByText(label).closest('div');
const addButton = (model: string) => within(sections().catalogo).getByRole('button', { name: `Agregar TOYO · ${model}` });
async function ready(h: ReturnType<typeof harness>) {
  render(<StockEntry csrf={csrf} fetcher={h.fetcher} />);
  await within(sections().catalogo).findByRole('button', { name: 'Agregar TOYO · NS40ZL' });
}

describe('stock entry catalog', () => {
  it('reads the warehouse catalog once, then again for the typed search', async () => {
    const h = harness();
    render(<StockEntry csrf={csrf} fetcher={h.fetcher} />);
    const { catalogo } = sections();
    expect(within(catalogo).getByRole('status')).toHaveTextContent('Consultando catálogo del almacén');
    await within(catalogo).findByText('TOYO · NS40ZL');
    expect(within(catalogo).getByText('35 Ah')).toBeInTheDocument();
    expect(within(catalogo).getByText('14')).toBeInTheDocument();
    expect(h.catalogs()[0].url).toBe('/api/inventory?location_id=1&page=1&page_size=50');
    expect(h.catalogs()[0].init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store' });
    fireEvent.change(within(catalogo).getByLabelText('Buscar marca, modelo o capacidad'), { target: { value: 'NS60' } });
    await within(catalogo).findByRole('button', { name: 'Agregar TOYO · NS60L' });
    expect(h.catalogs().at(-1)?.url).toBe('/api/inventory?location_id=1&page=1&page_size=50&search=NS60');
    expect(within(catalogo).queryByRole('button', { name: 'Agregar TOYO · NS40ZL' })).not.toBeInTheDocument();
    fireEvent.change(within(catalogo).getByLabelText('Buscar marca, modelo o capacidad'), { target: { value: 'nada' } });
    await within(catalogo).findByText('Sin coincidencias en el catálogo.');
  });

  it('reports an unavailable catalog and reads it again on demand', async () => {
    let failing = true;
    const h = harness({ catalog: search => failing ? errorReply('service_unavailable', 503) : catalogReply(search) });
    render(<StockEntry csrf={csrf} fetcher={h.fetcher} />);
    const { catalogo } = sections();
    expect(await within(catalogo).findByRole('alert')).toHaveTextContent('No se pudo consultar el catálogo del Almacén');
    failing = false;
    fireEvent.click(within(catalogo).getByRole('button', { name: 'Reintentar catálogo' }));
    await within(catalogo).findByRole('button', { name: 'Agregar TOYO · NS40ZL' });
    expect(h.catalogs()).toHaveLength(2);
  });
});

describe('stock entry document', () => {
  it('adds a variant once and increments it instead of duplicating the line', async () => {
    const h = harness();
    await ready(h);
    const { documento } = sections();
    expect(within(documento).getByText('Todavía no agregaste líneas.')).toBeInTheDocument();
    fireEvent.click(addButton('NS40ZL'));
    fireEvent.click(addButton('NS40ZL'));
    expect(within(documento).getAllByLabelText(/^Cantidad de /)).toHaveLength(1);
    expect(within(documento).getByLabelText('Cantidad de TOYO · NS40ZL')).toHaveValue(2);
    expect(totalFor('Variantes')).toHaveTextContent(/Variantes\s*1/);
    expect(totalFor('Unidades')).toHaveTextContent(/Unidades\s*2/);
    expect(within(documento).getByRole('status')).toHaveTextContent('TOYO · NS40ZL ya estaba en el documento: ahora 2 unidades.');
  });

  it('updates the totals when a quantity is edited or a line is removed', async () => {
    const h = harness();
    await ready(h);
    const { documento } = sections();
    fireEvent.click(addButton('NS40ZL'));
    fireEvent.click(addButton('NS60L'));
    fireEvent.change(within(documento).getByLabelText('Cantidad de TOYO · NS40ZL'), { target: { value: '5' } });
    expect(totalFor('Variantes')).toHaveTextContent(/Variantes\s*2/);
    expect(totalFor('Unidades')).toHaveTextContent(/Unidades\s*6/);
    fireEvent.click(within(documento).getByRole('button', { name: 'Quitar TOYO · NS60L' }));
    expect(within(documento).queryByLabelText('Cantidad de TOYO · NS60L')).not.toBeInTheDocument();
    expect(totalFor('Variantes')).toHaveTextContent(/Variantes\s*1/);
    expect(totalFor('Unidades')).toHaveTextContent(/Unidades\s*5/);
  });

  it('refuses an invalid quantity without sending anything', async () => {
    const h = harness();
    await ready(h);
    const { documento } = sections();
    fireEvent.click(addButton('NS40ZL'));
    fireEvent.change(within(documento).getByLabelText('Cantidad de TOYO · NS40ZL'), { target: { value: '0' } });
    fireEvent.click(within(documento).getByRole('button', { name: 'Confirmar ingreso' }));
    expect(within(documento).getByRole('status')).toHaveTextContent('Cantidad inválida: ingresá un entero entre 1 y 1.000.000 en cada línea.');
    expect(h.posts()).toHaveLength(0);
  });

  it('confirms the exact payload, shows the new document number and clears the draft', async () => {
    const h = harness();
    await ready(h);
    const { documento } = sections();
    const before = h.catalogs().length;
    fireEvent.click(addButton('NS40ZL'));
    fireEvent.change(within(documento).getByLabelText('Cantidad de TOYO · NS40ZL'), { target: { value: '3' } });
    fireEvent.change(within(documento).getByLabelText('Nota del documento (opcional)'), { target: { value: 'Remito 0002' } });
    fireEvent.click(within(documento).getByRole('button', { name: 'Confirmar ingreso' }));
    await waitFor(() => expect(h.posts()).toHaveLength(1));
    const post = h.posts()[0];
    expect(post.init).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store' });
    expect(post.init.headers).toMatchObject({ 'Content-Type': 'application/json', 'X-CSRF-Token': csrf });
    expect(JSON.parse(String(post.init.body))).toEqual({
      operation_key: expect.stringMatching(/^[A-Za-z0-9_-]{16,128}$/), note: 'Remito 0002', lines: [{ variant_id: 4, quantity: 3 }],
    });
    expect(await within(documento).findByText(/Ingreso confirmado: documento 7/)).toBeInTheDocument();
    expect(within(documento).getByRole('status')).toHaveTextContent('Ingreso confirmado: documento 7 · 3 unidades.');
    expect(within(documento).getByLabelText('Nota del documento (opcional)')).toHaveValue('');
    expect(totalFor('Variantes')).toHaveTextContent(/Variantes\s*0/);
    expect(totalFor('Unidades')).toHaveTextContent(/Unidades\s*0/);
    await waitFor(() => expect(h.catalogs().length).toBeGreaterThan(before));
    expect(h.catalogs().at(-1)?.url).toBe('/api/inventory?location_id=1&page=1&page_size=50');
  });

  it('keeps the typed document and the same operation key when the outcome is uncertain', async () => {
    const h = harness({ create: () => errorReply('service_unavailable', 503) });
    await ready(h);
    const { documento } = sections();
    fireEvent.click(addButton('NS40ZL'));
    fireEvent.change(within(documento).getByLabelText('Cantidad de TOYO · NS40ZL'), { target: { value: '3' } });
    fireEvent.change(within(documento).getByLabelText('Nota del documento (opcional)'), { target: { value: 'Remito 0002' } });
    fireEvent.click(within(documento).getByRole('button', { name: 'Confirmar ingreso' }));
    await waitFor(() => expect(within(documento).getByRole('status')).toHaveTextContent(stockEntryErrorMessages.service_unavailable));
    expect(within(documento).queryByText(/Ingreso confirmado/)).not.toBeInTheDocument();
    expect(within(documento).getByLabelText('Cantidad de TOYO · NS40ZL')).toHaveValue(3);
    expect(within(documento).getByLabelText('Nota del documento (opcional)')).toHaveValue('Remito 0002');
    fireEvent.click(within(documento).getByRole('button', { name: 'Confirmar ingreso' }));
    await waitFor(() => expect(h.posts()).toHaveLength(2));
    expect(h.posts()[1].init.body).toBe(h.posts()[0].init.body);
  });

  it('disables the confirmation while the request is in flight', async () => {
    let resolve!: (value: Response) => void;
    const h = harness({ create: () => new Promise<Response>(yes => { resolve = yes; }) });
    await ready(h);
    const { documento } = sections();
    fireEvent.click(addButton('NS40ZL'));
    fireEvent.change(within(documento).getByLabelText('Cantidad de TOYO · NS40ZL'), { target: { value: '3' } });
    const confirm = within(documento).getByRole('button', { name: 'Confirmar ingreso' });
    fireEvent.click(confirm);
    await waitFor(() => expect(within(documento).getByRole('button', { name: 'Confirmar ingreso' })).toBeDisabled());
    expect(within(documento).getByRole('status')).toHaveTextContent('Confirmando ingreso…');
    fireEvent.click(within(documento).getByRole('button', { name: 'Confirmar ingreso' }));
    expect(h.posts()).toHaveLength(1);
    resolve(entryReply());
    await within(documento).findByText(/Ingreso confirmado: documento 7/);
    expect(within(documento).getByRole('button', { name: 'Confirmar ingreso' })).toBeEnabled();
  });
});

describe('stock ingress history', () => {
  const historySections = () => sections().historial;
  const cellsOf = (row: HTMLElement) => within(row).getAllByRole('cell').map(cell => cell.textContent);

  it('lists the newest documents first with the applied and reversed tags', async () => {
    const h = harness({ history: () => historyReply([
      historyRow(9, 'Remito 0003', 1, 4),
      historyRow(7, 'Remito 0002-00045871', 2, 18, 9),
      historyRow(6, '', 3, 6),
    ]) });
    render(<StockEntry csrf={csrf} fetcher={h.fetcher} />);
    const historial = historySections();
    expect(within(historial).getByRole('status')).toHaveTextContent('Consultando el historial de ingresos');
    await within(historial).findByText('#9');
    const rows = within(historial).getAllByRole('row').slice(1);
    expect(rows.map(row => cellsOf(row)[0])).toEqual(['#9', '#7', '#6']);
    expect(cellsOf(rows[0])).toMatchObject({ 1: expect.stringContaining('2026'), 3: '1', 4: '4', 5: 'Aplicado' });
    expect(cellsOf(rows[1])[2]).toBe('Remito 0002-00045871');
    expect(cellsOf(rows[1])[3]).toBe('2');
    expect(cellsOf(rows[1])[4]).toBe('18');
    expect(cellsOf(rows[1])[5]).toBe('Anulado por contra-asiento');
    expect(cellsOf(rows[2])[5]).toBe('Aplicado');
    expect(within(historial).getByRole('table', { name: /Historial/ })).toBeInTheDocument();
    expect(h.histories()[0].url).toBe('/api/stock-entries?page=1&page_size=25');
    expect(h.histories()[0].init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store' });
  });

  it('shows an empty history without rows', async () => {
    const h = harness({ history: () => historyReply([]) });
    render(<StockEntry csrf={csrf} fetcher={h.fetcher} />);
    const historial = historySections();
    expect(await within(historial).findByText('Todavía no hay ingresos registrados.')).toBeInTheDocument();
    expect(within(historial).queryByRole('table')).not.toBeInTheDocument();
  });

  it('reports an unavailable history and reads it again on retry', async () => {
    let failing = true;
    const h = harness({ history: () => failing ? errorReply('service_unavailable', 503) : historyReply(defaultHistoryRows) });
    render(<StockEntry csrf={csrf} fetcher={h.fetcher} />);
    const historial = historySections();
    expect(await within(historial).findByRole('alert')).toHaveTextContent('No se pudo consultar el historial de ingresos');
    expect(within(historial).queryByRole('table')).not.toBeInTheDocument();
    failing = false;
    fireEvent.click(within(historial).getByRole('button', { name: 'Reintentar historial' }));
    await within(historial).findByText('#6');
    expect(h.histories()).toHaveLength(2);
  });

  it('asks for the next page and for another page size', async () => {
    const h = harness({ history: query => historyReply(defaultHistoryRows, Number(query.get('page')),
      Number(query.get('page_size')), 60) });
    render(<StockEntry csrf={csrf} fetcher={h.fetcher} />);
    const historial = historySections();
    await within(historial).findByText('#6');
    expect(h.histories()[0].url).toBe('/api/stock-entries?page=1&page_size=25');
    fireEvent.click(within(historial).getByRole('button', { name: 'Siguiente página' }));
    await waitFor(() => expect(h.histories().at(-1)?.url).toBe('/api/stock-entries?page=2&page_size=25'));
    expect(within(historial).getByText('Página 2')).toBeInTheDocument();
    fireEvent.change(within(historial).getByLabelText('Ingresos por página'), { target: { value: '50' } });
    await waitFor(() => expect(h.histories().at(-1)?.url).toBe('/api/stock-entries?page=1&page_size=50'));
    expect(within(historial).getByRole('button', { name: 'Anterior página' })).toBeDisabled();
  });

  it('refetches the history after a confirmed ingress so the new document appears', async () => {
    let confirmed = false;
    const h = harness({
      history: () => historyReply(confirmed
        ? [historyRow(7, 'Remito 0002', 1, 3), historyRow(6, 'Remito 0002', 2, 18)]
        : [historyRow(6, 'Remito 0002', 2, 18)]),
      create: () => { confirmed = true; return entryReply(); },
    });
    await ready(h);
    const { documento, historial } = sections();
    await within(historial).findByText('#6');
    expect(within(historial).queryByText('#7')).not.toBeInTheDocument();
    fireEvent.click(addButton('NS40ZL'));
    fireEvent.change(within(documento).getByLabelText('Cantidad de TOYO · NS40ZL'), { target: { value: '3' } });
    fireEvent.click(within(documento).getByRole('button', { name: 'Confirmar ingreso' }));
    await within(historial).findByText('#7');
    expect(h.histories().length).toBeGreaterThan(1);
    const rows = within(historial).getAllByRole('row').slice(1);
    expect(rows.map(row => cellsOf(row)[0])).toEqual(['#7', '#6']);
  });

  it('keeps the typed document when the history read fails', async () => {
    const h = harness({ history: () => errorReply('service_unavailable', 503) });
    await ready(h);
    const { documento, historial } = sections();
    fireEvent.click(addButton('NS40ZL'));
    fireEvent.change(within(documento).getByLabelText('Nota del documento (opcional)'), { target: { value: 'Remito 0002' } });
    expect(await within(historial).findByRole('alert')).toHaveTextContent('No se pudo consultar el historial de ingresos');
    expect(within(documento).getByLabelText('Cantidad de TOYO · NS40ZL')).toHaveValue(1);
    expect(within(documento).getByLabelText('Nota del documento (opcional)')).toHaveValue('Remito 0002');
    expect(totalFor('Unidades')).toHaveTextContent(/Unidades\s*1/);
  });
});

describe('stock counter-entry', () => {
  const historial = () => sections().historial;
  const rowsWithAction = () => [
    historyRow(9, 'Remito 0003', 1, 4),
    historyRow(8, 'Remito 0002', 2, 18, 10),
    historyRow(7, '', 1, -3),
    historyRow(6, 'Remito 0002', 2, 18),
  ];
  const reasonBox = (dialog: HTMLElement) => within(dialog).getByLabelText('Motivo del contra-asiento') as HTMLTextAreaElement;
  const confirm = (dialog: HTMLElement) => within(dialog).getByRole('button', { name: 'Confirmar contra-asiento' });

  it('offers the action only on rows that have no counter-entry yet', async () => {
    const h = harness({ history: () => historyReply(rowsWithAction()) });
    render(<StockEntry csrf={csrf} fetcher={h.fetcher} />);
    await within(historial()).findByText('#6');
    expect(within(historial()).getAllByRole('button', { name: /^Anular ingreso/ }).map(button => button.getAttribute('aria-label')))
      .toEqual(['Anular ingreso #9', 'Anular ingreso #6']);
    expect(within(historial()).queryByRole('button', { name: 'Anular ingreso #8' })).not.toBeInTheDocument();
    // A counter-entry (negative units) is never reversible.
    expect(within(historial()).queryByRole('button', { name: 'Anular ingreso #7' })).not.toBeInTheDocument();
  });

  it('opens an accessible dialog that explains the immutable original and moves focus', async () => {
    const h = harness({ history: () => historyReply(rowsWithAction()) });
    render(<StockEntry csrf={csrf} fetcher={h.fetcher} />);
    await within(historial()).findByText('#6');
    const dialog = await openReversal(historial());
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByText(/documento nuevo con las mismas líneas en negativo/)).toBeInTheDocument();
    expect(within(dialog).getByText(/El original nunca cambia/)).toBeInTheDocument();
    expect(within(dialog).getByText(/#6/)).toBeInTheDocument();
    expect(reasonBox(dialog)).toHaveFocus();
    expect(reasonBox(dialog)).toHaveAttribute('maxlength', '500');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(within(historial()).getByRole('button', { name: 'Anular ingreso #6' })).toHaveFocus();
  });

  it('refuses a blank reason without sending anything', async () => {
    const h = harness({ history: () => historyReply(rowsWithAction()) });
    render(<StockEntry csrf={csrf} fetcher={h.fetcher} />);
    await within(historial()).findByText('#6');
    const dialog = await openReversal(historial());
    fireEvent.change(reasonBox(dialog), { target: { value: '   ' } });
    fireEvent.click(confirm(dialog));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('El motivo es obligatorio');
    expect(h.reversals()).toHaveLength(0);
  });

  it('sends the exact payload to the frozen path and shows the counter-entry', async () => {
    let reversed = false;
    const h = harness({
      history: () => historyReply(reversed
        ? [historyRow(10, '', 2, -18), historyRow(6, 'Remito 0002', 2, 18, 10)]
        : [historyRow(6, 'Remito 0002', 2, 18)]),
      reverse: () => { reversed = true; return counterReply(); },
    });
    render(<StockEntry csrf={csrf} fetcher={h.fetcher} />);
    await within(historial()).findByText('#6');
    const dialog = await openReversal(historial());
    fireEvent.change(reasonBox(dialog), { target: { value: '  error de carga  ' } });
    fireEvent.click(confirm(dialog));
    await waitFor(() => expect(h.reversals()).toHaveLength(1));
    const post = h.reversals()[0];
    expect(post.url).toBe('/api/stock-entries/6/reverse');
    expect(post.init).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store' });
    expect(post.init.headers).toMatchObject({ 'Content-Type': 'application/json', 'X-CSRF-Token': csrf });
    expect(JSON.parse(String(post.init.body))).toEqual({
      operation_key: expect.stringMatching(/^[A-Za-z0-9_-]{16,128}$/), reason: 'error de carga',
    });
    // The dialog closes, the history is refreshed and the result is announced.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await within(historial()).findByText(/Contra-asiento registrado: documento 10 · -18 unidades/)).toBeInTheDocument();
    expect(h.histories().length).toBeGreaterThan(1);
    const rows = within(historial()).getAllByRole('row').slice(1);
    expect(rows.map(row => within(row).getAllByRole('cell')[0].textContent)).toEqual(['#10', '#6']);
    expect(within(historial()).queryByRole('button', { name: 'Anular ingreso #6' })).not.toBeInTheDocument();
  });

  it('keeps the typed reason and the dialog open when the stock no longer covers the reversal', async () => {
    const h = harness({ history: () => historyReply(rowsWithAction()),
      reverse: () => errorReply('insufficient_stock', 409) });
    render(<StockEntry csrf={csrf} fetcher={h.fetcher} />);
    await within(historial()).findByText('#6');
    const dialog = await openReversal(historial());
    fireEvent.change(reasonBox(dialog), { target: { value: 'error de carga' } });
    fireEvent.click(confirm(dialog));
    await waitFor(() => expect(within(dialog).getByRole('alert'))
      .toHaveTextContent(stockEntryReversalErrorMessages.insufficient_stock));
    expect(screen.getByRole('dialog', { name: 'Registrar contra-asiento' })).toBeInTheDocument();
    expect(reasonBox(dialog)).toHaveValue('error de carga');
    expect(within(dialog).getByRole('button', { name: 'Confirmar contra-asiento' })).toBeEnabled();
  });

  it('reuses the same operation key when the outcome is uncertain and a fresh one after a rejection', async () => {
    let calls = 0;
    const h = harness({ history: () => historyReply(rowsWithAction()),
      reverse: () => { calls += 1; return calls === 1 ? errorReply('service_unavailable', 503) : counterReply(); } });
    render(<StockEntry csrf={csrf} fetcher={h.fetcher} />);
    await within(historial()).findByText('#6');
    const dialog = await openReversal(historial());
    fireEvent.change(reasonBox(dialog), { target: { value: 'error de carga' } });
    fireEvent.click(confirm(dialog));
    await waitFor(() => expect(within(dialog).getByRole('alert')).toHaveTextContent(stockEntryReversalErrorMessages.service_unavailable));
    expect(reasonBox(dialog)).toHaveValue('error de carga');
    fireEvent.click(confirm(dialog));
    await waitFor(() => expect(h.reversals()).toHaveLength(2));
    const first = JSON.parse(String(h.reversals()[0].init.body)) as { operation_key: string; reason: string };
    const second = JSON.parse(String(h.reversals()[1].init.body)) as { operation_key: string; reason: string };
    expect(second.operation_key).toBe(first.operation_key);
    expect(second.reason).toBe('error de carga');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('closes the dialog and refreshes the history when the document is already reversed', async () => {
    let stale = true;
    const h = harness({
      history: () => historyReply(stale ? [historyRow(6, 'Remito 0002', 2, 18)] : [historyRow(10, '', 2, -18), historyRow(6, 'Remito 0002', 2, 18, 10)]),
      reverse: () => { stale = false; return errorReply('decision_conflict', 409); },
    });
    render(<StockEntry csrf={csrf} fetcher={h.fetcher} />);
    await within(historial()).findByText('#6');
    const dialog = await openReversal(historial());
    fireEvent.change(reasonBox(dialog), { target: { value: 'error de carga' } });
    fireEvent.click(confirm(dialog));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await within(historial()).findByText(stockEntryReversalErrorMessages.decision_conflict)).toBeInTheDocument();
    await within(historial()).findByText('#10');
  });

  it('disables the action while the reversal is in flight', async () => {
    let resolve!: (value: Response) => void;
    const h = harness({ history: () => historyReply(rowsWithAction()),
      reverse: () => new Promise<Response>(yes => { resolve = yes; }) });
    render(<StockEntry csrf={csrf} fetcher={h.fetcher} />);
    await within(historial()).findByText('#6');
    const dialog = await openReversal(historial());
    fireEvent.change(reasonBox(dialog), { target: { value: 'error de carga' } });
    fireEvent.click(confirm(dialog));
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Confirmar contra-asiento' })).toBeDisabled());
    expect(within(dialog).getByRole('button', { name: 'Cancelar' })).toBeDisabled();
    fireEvent.click(confirm(dialog));
    expect(h.reversals()).toHaveLength(1);
    resolve(counterReply());
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});

describe('stock ingress detail', () => {
  const historial = () => sections().historial;
  // Each listed document has its own detail, so a stale reply would be visible.
  const defaultDetail = (id: string) => id === '9'
    ? detailReply({ id: 9, note: 'Remito 0003', lines: [detailLineOf(4, '95D31L', 4, '90')], total_units: 4 })
    : id === '7'
      ? detailReply({ id: 7, note: '', reverses_entry_id: 6, reason: 'error de carga',
        lines: [detailLineOf(4, 'NS40ZL', -3, '35'), detailLineOf(9, 'NS60L', -15)], total_units: -18 })
      : detailReply();
  const rowsWithDetail = () => [historyRow(9, 'Remito 0003', 1, 4), historyRow(7, '', 2, -18), historyRow(6, 'Remito 0002', 2, 18)];
  const detailButton = (id: number) => within(historial()).getByRole('button', { name: `Ver detalle del ingreso #${id}` });
  const openDetail = async (id: number) => {
    fireEvent.click(detailButton(id));
    return screen.getByRole('dialog', { name: `Detalle del ingreso #${id}` });
  };

  it('offers the detail action on every row, including a reversed document', async () => {
    const h = harness({ history: () => historyReply([historyRow(9, 'Remito 0003', 1, 4),
      historyRow(7, 'Remito 0002', 2, 18, 10), historyRow(6, '', 3, 6)]) });
    render(<StockEntry csrf={csrf} fetcher={h.fetcher} />);
    await within(historial()).findByText('#6');
    expect(within(historial()).getAllByRole('button', { name: /^Ver detalle del ingreso/ })
      .map(button => button.getAttribute('aria-label')))
      .toEqual(['Ver detalle del ingreso #9', 'Ver detalle del ingreso #7', 'Ver detalle del ingreso #6']);
  });

  it('opens the clicked document with exactly the units that entered', async () => {
    const h = harness({ history: () => historyReply(rowsWithDetail()), detail: defaultDetail });
    render(<StockEntry csrf={csrf} fetcher={h.fetcher} />);
    await within(historial()).findByText('#6');
    fireEvent.click(detailButton(6));
    const dialog = screen.getByRole('dialog', { name: 'Detalle del ingreso #6' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByRole('status')).toHaveTextContent('Consultando el detalle del ingreso');
    await within(dialog).findByText('TOYO · NS60L');
    expect(h.details().map(call => call.url)).toEqual(['/api/stock-entries/6']);
    expect(h.details()[0].init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store' });
    const lines = within(dialog).getAllByRole('row').slice(1).map(row => within(row).getAllByRole('cell').map(cell => cell.textContent));
    expect(lines).toEqual([
      ['TOYO · NS40ZL', '35 Ah', 'L', '3'],
      ['TOYO · NS60L', '45 Ah', 'L', '15'],
    ]);
    expect(within(dialog).getByText('Unidades del documento: 18')).toBeInTheDocument();
    expect(within(dialog).getByText('Aplicado')).toBeInTheDocument();
    expect(within(dialog).getByText('Remito 0002')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Volver' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(detailButton(6)).toHaveFocus();
  });

  it('shows the motive and the original document of a counter-entry with negative units', async () => {
    const h = harness({ history: () => historyReply(rowsWithDetail()), detail: defaultDetail });
    render(<StockEntry csrf={csrf} fetcher={h.fetcher} />);
    await within(historial()).findByText('#7');
    const dialog = await openDetail(7);
    await within(dialog).findByText(/error de carga/);
    expect(within(dialog).getByText('Contra-asiento del documento')).toBeInTheDocument();
    expect(within(dialog).getByText('#6', { selector: 'dd' })).toBeInTheDocument();
    expect(within(dialog).getByText('Motivo')).toBeInTheDocument();
    const quantities = within(dialog).getAllByRole('row').slice(1).map(row => within(row).getAllByRole('cell')[3].textContent);
    expect(quantities).toEqual(['-3', '-15']);
    expect(within(dialog).getByText('Unidades del documento: -18')).toBeInTheDocument();
    expect(within(dialog).queryByText('Nota')).not.toBeInTheDocument();
  });

  it('never shows the previous document after closing and opening another row', async () => {
    const h = harness({ history: () => historyReply(rowsWithDetail()), detail: defaultDetail });
    render(<StockEntry csrf={csrf} fetcher={h.fetcher} />);
    await within(historial()).findByText('#6');
    const first = await openDetail(6);
    await within(first).findByText('TOYO · NS60L');
    fireEvent.keyDown(first, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const second = await openDetail(9);
    await within(second).findByText('TOYO · 95D31L');
    expect(within(second).getByText('Unidades del documento: 4')).toBeInTheDocument();
    expect(within(second).queryByText('TOYO · NS60L')).not.toBeInTheDocument();
    expect(within(second).queryByText('Unidades del documento: 18')).not.toBeInTheDocument();
    expect(h.details().map(call => call.url)).toEqual(['/api/stock-entries/6', '/api/stock-entries/9']);
  });

  it('reports a failed detail read and retries it inside the dialog', async () => {
    let failing = true;
    const h = harness({ history: () => historyReply(rowsWithDetail()),
      detail: id => { if (failing) { failing = false; return errorReply('service_unavailable', 503); } return defaultDetail(id); } });
    render(<StockEntry csrf={csrf} fetcher={h.fetcher} />);
    await within(historial()).findByText('#6');
    const dialog = await openDetail(6);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('No pudimos traer el detalle de este ingreso');
    expect(within(dialog).queryByRole('table')).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reintentar detalle' }));
    await within(dialog).findByText('Unidades del documento: 18');
    expect(h.details()).toHaveLength(2);
  });

  it('closes with Escape, restores focus and cycles Tab inside the dialog', async () => {
    const h = harness({ history: () => historyReply(rowsWithDetail()), detail: defaultDetail });
    render(<StockEntry csrf={csrf} fetcher={h.fetcher} />);
    await within(historial()).findByText('#6');
    const dialog = await openDetail(6);
    await within(dialog).findByText('TOYO · NS60L');
    expect(dialog).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(within(dialog).getByRole('button', { name: 'Cerrar detalle del ingreso' })).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(within(dialog).getByRole('button', { name: 'Volver' })).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(detailButton(6)).toHaveFocus();
  });

  it('keeps the counter-entry flow unchanged after a detail dialog closed', async () => {
    const h = harness({ history: () => historyReply(rowsWithDetail()), detail: defaultDetail });
    render(<StockEntry csrf={csrf} fetcher={h.fetcher} />);
    await within(historial()).findByText('#6');
    const dialog = await openDetail(6);
    await within(dialog).findByText('TOYO · NS60L');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    fireEvent.click(within(historial()).getByRole('button', { name: 'Anular ingreso #6' }));
    const reversal = screen.getByRole('dialog', { name: 'Registrar contra-asiento' });
    fireEvent.change(within(reversal).getByLabelText('Motivo del contra-asiento'), { target: { value: 'error de carga' } });
    fireEvent.click(within(reversal).getByRole('button', { name: 'Confirmar contra-asiento' }));
    await waitFor(() => expect(h.reversals()).toHaveLength(1));
    expect(h.reversals()[0].url).toBe('/api/stock-entries/6/reverse');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
