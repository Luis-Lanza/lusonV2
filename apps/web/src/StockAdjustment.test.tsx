import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import StockAdjustment from './StockAdjustment';
import { stockAdjustmentApplyMessages, stockAdjustmentReversalMessages } from './stockAdjustmentModel';

const csrf = 'c'.repeat(43);
const motive = 'Conteo físico periódico';
const json = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
const errorReply = (code: string, status: number) => json(JSON.stringify({ error: code }), status);

const catalogItem = (variant_id: number, model: string, capacity = '35', polarity = 'L', brand = 'TOYO') => ({
  variant_id, catalog_entry_id: 1, kind: 'battery', name: `${brand} · ${model}`, detail: `${capacity} Ah · ${polarity}`,
  battery: { brand, model, capacity_ah: capacity, polarity }, fields: null });
const productItem = (variant_id: number, name: string, detail: string) => ({
  variant_id, catalog_entry_id: 3, kind: 'other', name, detail, battery: null,
  fields: [{ name: 'volumen en L', kind: 'number', unit: 'L', number: '5' }] });
const catalogReply = (items: readonly Record<string, unknown>[]) => json(JSON.stringify({
  page: 1, page_size: 25, total_variants: items.length, items }));
const defaultCatalog = [
  catalogItem(4, 'NS40ZL', '35', 'L', 'CAR'), catalogItem(7, 'NS60L', '45', 'L'),
];
const defaultProducts = [
  productItem(191, 'Agua acidulada', 'volumen en L: 5 L'),
  productItem(192, 'Electrolito preparado', 'volumen en L: 5 L'),
];
const summary = (overrides: Record<string, unknown> = {}) => ({
  id: 5, reason: 'Merma o rotura', detail: '', created_at: '2026-11-02T09:12:00Z', kind: 'battery',
  lines: 1, total_difference: 0, reverses_adjustment_id: null, reversed_by: null, ...overrides });
const historyReply = (rows: readonly Record<string, unknown>[], page = 1, pageSize = 25, total = rows.length) => json(JSON.stringify({
  page, page_size: pageSize, total_adjustments: total, adjustments: rows }));
const defaultHistory = [
  summary({ id: 8, reason: 'Otro', detail: '', lines: 1, total_difference: 4, reverses_adjustment_id: 7 }),
  summary({ id: 7, reason: motive, detail: 'pasillo 2', lines: 1, total_difference: -4, reversed_by: 8 }),
  summary({ id: 6, reason: motive, detail: '', lines: 1, total_difference: -4 }),
  summary({ id: 5 }),
];
const detailLine = (overrides: Record<string, unknown> = {}) => ({
  variant_id: 7, catalog_entry_id: 2, kind: 'battery', name: 'TOYO · NS60L', detail: '45 Ah · L',
  battery: { brand: 'TOYO', model: 'NS60L', capacity_ah: '45', polarity: 'L' }, fields: null,
  expected_quantity: 18, counted_quantity: 14, difference: -4, ...overrides });
const productDetailLine = (overrides: Record<string, unknown> = {}) => ({
  variant_id: 191, catalog_entry_id: 3, kind: 'other', name: 'Agua acidulada',
  detail: 'volumen en L: 5 L', battery: null,
  fields: [{ name: 'volumen en L', kind: 'number', unit: 'L', number: '5' }],
  expected_quantity: 4, counted_quantity: 7, difference: 3, ...overrides });
const detailReply = (overrides: Record<string, unknown> = {}) => json(JSON.stringify({
  id: 6, location_id: 1, reason: motive, detail: 'pasillo 2', created_at: '2026-11-02T09:12:00Z',
  created_by_account_id: 1, reverses_adjustment_id: null, reversed_by: null, reversed_by_reason: '',
  lines: [detailLine()], total_difference: -4, ...overrides }));
const detailsFor = (id: number) => id === 8
  ? detailReply({ id: 8, reason: 'Otro', detail: '', created_at: '2026-11-03T10:00:00Z', reverses_adjustment_id: 7,
    lines: [detailLine({ expected_quantity: 14, counted_quantity: 18, difference: 4 })], total_difference: 4 })
  : id === 7
    ? detailReply({ id: 7, detail: 'pasillo 2', reversed_by: 8, reversed_by_reason: 'Otro' })
    : id === 10
      ? detailReply({ id: 10, reason: 'Diferencia detectada en preparación', detail: '',
        reverses_adjustment_id: 6, lines: [detailLine({ expected_quantity: 14, counted_quantity: 18, difference: 4 })],
        total_difference: 4 })
      : id === 9
    ? detailReply({ id: 9, reason: motive, detail: '', created_at: '2026-11-05T14:20:00Z',
      lines: [detailLine({ variant_id: 4, catalog_entry_id: 1, name: 'CAR · NS40ZL', detail: '35 Ah · L',
        battery: { brand: 'CAR', model: 'NS40ZL', capacity_ah: '35', polarity: 'L' },
        expected_quantity: 18, counted_quantity: 12, difference: -6 }),
      detailLine({ variant_id: 7, expected_quantity: 0, counted_quantity: 0, difference: 0 })], total_difference: -6 })
    : id === 11
      ? detailReply({ id: 11, reason: motive, detail: '', created_at: '2026-11-05T14:20:00Z',
        lines: [productDetailLine()], total_difference: 3 })
    : id === 6
      ? detailReply()
      : detailReply({ id, reason: 'Merma o rotura', detail: '',
        lines: [detailLine({ expected_quantity: 6, counted_quantity: 6, difference: 0 })], total_difference: 0 });
const createdReply = () => json(JSON.stringify({
  id: 9, location_id: 1, reason: motive, detail: '', created_by_account_id: 1,
  created_at: '2026-11-05T14:20:00Z', reverses_adjustment_id: null,
  lines: [{ variant_id: 4, expected_quantity: 18, counted_quantity: 12, difference: -6 },
    { variant_id: 7, expected_quantity: 0, counted_quantity: 0, difference: 0 }],
  total_difference: -6,
}), 201);
const counterReply = (reason = 'Otro') => json(JSON.stringify({
  id: 10, location_id: 1, reason, detail: '', created_by_account_id: 1,
  created_at: '2026-11-05T14:30:00Z', reverses_adjustment_id: 6,
  lines: [{ variant_id: 7, expected_quantity: 14, counted_quantity: 18, difference: 4 }], total_difference: 4,
}), 201);

function harness(options: {
  catalog?: (search: string, kind: string) => Response | Promise<Response>;
  history?: (query: URLSearchParams) => Response | Promise<Response>;
  create?: (body: string) => Response | Promise<Response>;
  detail?: (id: string) => Response | Promise<Response>;
  reverse?: (id: string, body: string) => Response | Promise<Response>;
} = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.startsWith('/api/stock-adjustments/catalog?')) {
      const query = new URL(url, 'http://localhost').searchParams;
      const search = query.get('search') ?? '';
      const kind = query.get('kind') ?? '';
      return options.catalog?.(search, kind) ?? (kind === 'other'
        ? catalogReply(search === 'nada' ? [] : defaultProducts)
        : catalogReply(search === 'NS60'
          ? [catalogItem(7, 'NS60L', '45')] : search === 'nada' ? [] : defaultCatalog));
    }
    if (url.startsWith('/api/stock-adjustments?')) {
      return options.history?.(new URL(url, 'http://localhost').searchParams) ?? historyReply(defaultHistory);
    }
    if (url === '/api/stock-adjustments') return options.create?.(String(init.body)) ?? createdReply();
    const reversal = /^\/api\/stock-adjustments\/([^/]+)\/reverse$/.exec(url);
    if (reversal) return options.reverse?.(reversal[1], String(init.body)) ?? counterReply();
    const detail = /^\/api\/stock-adjustments\/([^/?]+)$/.exec(url);
    if (detail) return options.detail?.(detail[1]) ?? detailsFor(Number(detail[1]));
    throw new Error('Unexpected mocked URL: ' + url);
  });
  return { fetcher, calls,
    histories: () => calls.filter(call => call.url.startsWith('/api/stock-adjustments?')),
    catalogs: () => calls.filter(call => call.url.startsWith('/api/stock-adjustments/catalog?')),
    details: () => calls.filter(call => /^\/api\/stock-adjustments\/[^/?]+$/.test(call.url)),
    posts: () => calls.filter(call => call.url === '/api/stock-adjustments'),
    reversals: () => calls.filter(call => call.url.endsWith('/reverse')) };
}
const historial = () => screen.getByRole('region', { name: 'Documentos' });
const rowOf = (id: number) => historial().querySelector<HTMLElement>(`tr[data-adjustment-id="${id}"]`)!;
const cellsOf = (row: HTMLElement) => within(row).getAllByRole('cell').map(cell => cell.textContent);
const disclosure = (id: number) => within(rowOf(id)).getByRole('button', { name: `#${id}` });
async function ready(h: ReturnType<typeof harness>) {
  render(<StockAdjustment csrf={csrf} fetcher={h.fetcher} />);
  await within(historial()).findByText('#6');
}
const openDrawer = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Nuevo ajuste' }));
  return screen.getByRole('dialog', { name: 'Nuevo ajuste' });
};
const countedBox = (drawer: HTMLElement, label: string) => within(drawer).getByLabelText(`Contado de ${label}`);
const applyButton = (drawer: HTMLElement) => within(drawer).getByRole('button', { name: 'Aplicar ajuste' });
const historyStatus = () => within(historial()).getByRole('status');

describe('adjustment history', () => {
  it('lists the newest document first with its state, line count and difference', async () => {
    const h = harness();
    await ready(h);
    const rows = within(historial()).getAllByRole('row').slice(1);
    expect(rows.map(row => row.getAttribute('data-adjustment-id'))).toEqual(['8', '7', '6', '5']);
    expect(cellsOf(rowOf(8))).toMatchObject({ 0: '#8', 1: 'Baterías', 3: 'Otro', 4: '1', 5: '+4', 6: 'Contra-asiento' });
    expect(cellsOf(rowOf(7))[6]).toBe('Revertido');
    expect(cellsOf(rowOf(6))[6]).toBe('Aplicado');
    expect(cellsOf(rowOf(5))[6]).toBe('Aplicado');
    expect(cellsOf(rowOf(5))[5]).toBe('0');
    expect(cellsOf(rowOf(6))[2]).toContain('2026');
    expect(h.histories()[0].url).toBe('/api/stock-adjustments?page=1&page_size=25');
    expect(h.histories()[0].init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store' });
  });

  // The history is one list of both kinds, and the kind of every row is the
  // server's own derivation from that document's lines.
  it('names the kind of every document in the same list', async () => {
    const h = harness({ history: () => historyReply([
      summary({ id: 8, kind: 'other', total_difference: 3 }),
      summary({ id: 7, kind: 'battery', total_difference: -4 }),
      summary({ id: 6, kind: null, total_difference: 0 }),
    ]) });
    await ready(h);
    const rows = within(historial()).getAllByRole('row').slice(1);
    expect(rows.map(row => row.getAttribute('data-adjustment-id'))).toEqual(['8', '7', '6']);
    expect(rows.map(row => cellsOf(row)[1])).toEqual(['Otros productos', 'Baterías', '—']);
    expect(within(historial()).getByRole('columnheader', { name: 'Tipo' })).toBeInTheDocument();
    expect(h.histories()).toHaveLength(1);
  });

  it('keeps the history copy word for word', async () => {
    const h = harness();
    await ready(h);
    expect(screen.getByText('Cada ajuste es un documento inmutable con el esperado, lo contado y la diferencia. Las correcciones son contra-asientos.'))
      .toBeInTheDocument();
  });

  // A product document reads back through the identity union: its line shows the
  // product name and detail instead of blank battery cells.
  it('reads a product document through its own identity without battery cells', async () => {
    const h = harness({ history: () => historyReply([summary({ id: 11, kind: 'other', total_difference: 3 })]) });
    render(<StockAdjustment csrf={csrf} fetcher={h.fetcher} />);
    await within(historial()).findByText('#11');
    fireEvent.click(disclosure(11));
    const panel = document.getElementById('adjustment-lines-11')!;
    expect(await within(panel).findByText('Agua acidulada')).toBeInTheDocument();
    expect(within(panel).getAllByRole('columnheader').map(cell => cell.textContent))
      .toEqual(['Producto', 'Detalle', 'Esperado', 'Contado', 'Diferencia']);
    const lines = within(panel).getAllByRole('row').slice(1)
      .map(row => within(row).getAllByRole('cell').map(cell => cell.textContent));
    expect(lines).toEqual([['Agua acidulada', 'volumen en L: 5 L', '4', '7', '+3']]);
  });

  it('expands a document in place with expected, counted and difference', async () => {
    const h = harness();
    await ready(h);
    expect(document.getElementById('adjustment-lines-6')).toBeNull();
    fireEvent.click(disclosure(6));
    expect(disclosure(6)).toHaveAttribute('aria-expanded', 'true');
    const panel = document.getElementById('adjustment-lines-6')!;
    expect(await within(panel).findByText('TOYO · NS60L')).toBeInTheDocument();
    expect(h.details().map(call => call.url)).toEqual(['/api/stock-adjustments/6']);
    const lines = within(panel).getAllByRole('row').slice(1).map(row => within(row).getAllByRole('cell').map(cell => cell.textContent));
    expect(lines).toEqual([['TOYO · NS60L', '45 Ah', 'L', '18', '14', '-4']]);
    expect(within(panel).getByText(/El esperado es la foto del momento del ajuste/)).toBeInTheDocument();
    fireEvent.click(disclosure(6));
    expect(document.getElementById('adjustment-lines-6')).toBeNull();
    expect(disclosure(6)).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps the counter-entry cross-reference in both directions', async () => {
    const h = harness();
    await ready(h);
    fireEvent.click(disclosure(7));
    const reversed = document.getElementById('adjustment-lines-7')!;
    expect(await within(reversed).findByText(
      'Revertido por el contra-asiento #8 · motivo: “Otro”.')).toBeInTheDocument();
    fireEvent.click(disclosure(8));
    const counter = document.getElementById('adjustment-lines-8')!;
    expect(await within(counter).findByText('Contra-asiento del documento #7.')).toBeInTheDocument();
    // A counter-entry is never described as reversed, so it reports no counter motive.
    expect(within(counter).queryByText(/Revertido por el contra-asiento/)).not.toBeInTheDocument();
    const lines = within(counter).getAllByRole('row').slice(1).map(row => within(row).getAllByRole('cell')[4].textContent);
    expect(lines).toEqual(['18']);
    expect(within(counter).getByText('Otro')).toBeInTheDocument();
  });

  it('opens a document when its row is clicked, not only its disclosure', async () => {
    const h = harness();
    await ready(h);
    fireEvent.click(rowOf(5));
    expect(disclosure(5)).toHaveAttribute('aria-expanded', 'true');
    expect(await within(document.getElementById('adjustment-lines-5')!).findByText('TOYO · NS60L')).toBeInTheDocument();
    fireEvent.click(rowOf(5));
    expect(document.getElementById('adjustment-lines-5')).toBeNull();
  });

  it('pages the history and reads another page size', async () => {
    const h = harness({ history: query => historyReply(defaultHistory, Number(query.get('page')),
      Number(query.get('page_size')), 60) });
    await ready(h);
    expect(h.histories()[0].url).toBe('/api/stock-adjustments?page=1&page_size=25');
    fireEvent.click(within(historial()).getByRole('button', { name: 'Siguiente página' }));
    await waitFor(() => expect(h.histories().at(-1)?.url).toBe('/api/stock-adjustments?page=2&page_size=25'));
    expect(within(historial()).getByText('Página 2')).toBeInTheDocument();
    fireEvent.change(within(historial()).getByLabelText('Ajustes por página'), { target: { value: '50' } });
    await waitFor(() => expect(h.histories().at(-1)?.url).toBe('/api/stock-adjustments?page=1&page_size=50'));
    expect(within(historial()).getByRole('button', { name: 'Anterior página' })).toBeDisabled();
  });

  it('reports a failed document read inside the expanded row and retries it', async () => {
    let failing = true;
    const h = harness({ detail: id => { if (failing) { failing = false; return errorReply('service_unavailable', 503); } return detailsFor(Number(id)); } });
    await ready(h);
    fireEvent.click(disclosure(6));
    const panel = document.getElementById('adjustment-lines-6')!;
    expect(await within(panel).findByRole('alert')).toHaveTextContent('No pudimos traer los ajustes');
    fireEvent.click(within(panel).getByRole('button', { name: 'Reintentar detalle' }));
    await within(panel).findByText('TOYO · NS60L');
    expect(h.details()).toHaveLength(2);
  });
});

describe('blind capture', () => {
  it('opens a drawer that shows catalogue identity and no stock figure at all', async () => {
    const h = harness();
    await ready(h);
    const drawer = await openDrawer();
    expect(drawer).toHaveAttribute('aria-modal', 'true');
    expect(within(drawer).getByRole('note')).toHaveTextContent('Conteo ciego.');
    expect(h.catalogs()[0].url).toBe('/api/stock-adjustments/catalog?page=1&page_size=25&kind=battery');
    expect(h.catalogs()[0].init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store' });
    expect(await within(drawer).findByText('CAR · NS40ZL')).toBeInTheDocument();
    expect(within(drawer).getByText('35 Ah')).toBeInTheDocument();
    // No expected quantity, no stock column and no stock figure is rendered while counting.
    expect(within(drawer).queryByText(/Esperado|Stock actual|Existencias|Disponibles|Reservadas/)).not.toBeInTheDocument();
    expect(within(drawer).queryByText(/^14$/)).not.toBeInTheDocument();
    expect(within(drawer).queryByText(/^18$/)).not.toBeInTheDocument();
  });

  // The drawer asks for the kind with two tabs, and only that kind's picker is
  // offered: the battery picker stays exactly as it is today.
  it('offers the kind with two tabs and only that kind\u2019s picker', async () => {
    const h = harness();
    await ready(h);
    const drawer = await openDrawer();
    const tabs = within(drawer).getAllByRole('tab');
    expect(tabs.map(tab => tab.textContent)).toEqual(['Baterías', 'Otros productos']);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[1]).toHaveAttribute('aria-selected', 'false');
    expect(await within(drawer).findByText('CAR · NS40ZL')).toBeInTheDocument();
    expect(h.catalogs()[0].url).toBe('/api/stock-adjustments/catalog?page=1&page_size=25&kind=battery');
    expect(within(drawer).getAllByRole('columnheader').map(cell => cell.textContent))
      .toEqual(['Producto', 'Capacidad', 'Polaridad', 'Contado']);
    fireEvent.click(tabs[1]);
    expect(await within(drawer).findByText('Agua acidulada')).toBeInTheDocument();
    expect(h.catalogs().at(-1)?.url).toBe('/api/stock-adjustments/catalog?page=1&page_size=25&kind=other');
    // The product picker has no capacity, no polarity and no expected column.
    expect(within(drawer).getAllByRole('columnheader').map(cell => cell.textContent))
      .toEqual(['Producto', 'Detalle', 'Contado']);
    expect(within(drawer).getByLabelText('Buscar producto')).toBeInTheDocument();
    expect(within(drawer).queryByText(/Esperado|Stock actual|Existencias|Disponibles|Reservadas/))
      .not.toBeInTheDocument();
    expect(within(drawer).getByRole('note')).toHaveTextContent(
      'Conteo ciego. No se muestra el stock esperado. Cargá lo que contaste; la diferencia se conoce al aplicar.');
  });

  // A document never mixes kinds, so changing the kind with lines loaded asks first
  // and discards the whole draft, exactly like the ingress.
  it('asks before discarding the counted lines when the kind changes', async () => {
    const h = harness();
    await ready(h);
    const drawer = await openDrawer();
    fireEvent.change(await within(drawer).findByLabelText('Contado de CAR · NS40ZL'), { target: { value: '12' } });
    fireEvent.click(within(drawer).getByRole('tab', { name: 'Otros productos' }));
    const dialog = screen.getByRole('dialog', { name: 'Cambiar el tipo del ajuste' });
    expect(within(dialog).getByText(/se descarta el borrador completo/)).toBeInTheDocument();
    // Cancelling keeps the counted line and the battery picker.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('dialog', { name: 'Cambiar el tipo del ajuste' })).not.toBeInTheDocument();
    expect(countedBox(drawer, 'CAR · NS40ZL')).toHaveValue(12);
    expect(within(drawer).getByRole('tab', { name: 'Baterías' })).toHaveAttribute('aria-selected', 'true');
    // Confirming discards the whole draft and reads the other kind's picker.
    fireEvent.click(within(drawer).getByRole('tab', { name: 'Otros productos' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Cambiar el tipo del ajuste' }))
      .getByRole('button', { name: 'Descartar borrador y cambiar tipo' }));
    expect(await within(drawer).findByText('Agua acidulada')).toBeInTheDocument();
    expect(within(drawer).getByRole('tab', { name: 'Otros productos' })).toHaveAttribute('aria-selected', 'true');
    expect(h.catalogs().at(-1)?.url).toBe('/api/stock-adjustments/catalog?page=1&page_size=25&kind=other');
    expect(within(drawer).queryByLabelText('Contado de CAR · NS40ZL')).not.toBeInTheDocument();
    expect(h.posts()).toHaveLength(0);
  });

  it('applies a product count and reads the document back through its identity', async () => {
    const created = json(JSON.stringify({
      id: 11, location_id: 1, reason: motive, detail: '', created_by_account_id: 1,
      created_at: '2026-11-05T14:20:00Z', reverses_adjustment_id: null,
      lines: [{ variant_id: 191, expected_quantity: 4, counted_quantity: 7, difference: 3 }],
      total_difference: 3,
    }), 201);
    const h = harness({
      create: () => created,
      history: () => historyReply([summary({ id: 11, kind: 'other', total_difference: 3 })]),
    });
    render(<StockAdjustment csrf={csrf} fetcher={h.fetcher} />);
    await within(historial()).findByText('#11');
    const drawer = await openDrawer();
    fireEvent.click(within(drawer).getByRole('tab', { name: 'Otros productos' }));
    fireEvent.change(await within(drawer).findByLabelText('Contado de Agua acidulada'), { target: { value: '7' } });
    fireEvent.change(within(drawer).getByLabelText('Motivo del ajuste'), { target: { value: motive } });
    fireEvent.click(applyButton(drawer));
    await waitFor(() => expect(h.posts()).toHaveLength(1));
    expect(JSON.parse(String(h.posts()[0].init.body))).toEqual({
      operation_key: expect.stringMatching(/^[A-Za-z0-9_-]{16,128}$/), reason: motive,
      lines: [{ variant_id: 191, counted_quantity: 7 }],
    });
    await waitFor(() => expect(document.getElementById('adjustment-lines-11')).not.toBeNull());
    const panel = document.getElementById('adjustment-lines-11')!;
    expect(await within(panel).findByText('Agua acidulada')).toBeInTheDocument();
    expect(within(panel).getAllByRole('columnheader').map(cell => cell.textContent))
      .toEqual(['Producto', 'Detalle', 'Esperado', 'Contado', 'Diferencia']);
  });

  it('asks the catalogue for the typed search and shows the matching variants', async () => {
    const h = harness();
    await ready(h);
    const drawer = await openDrawer();
    await within(drawer).findByText('CAR · NS40ZL');
    fireEvent.change(within(drawer).getByLabelText('Buscar variante'), { target: { value: 'NS60' } });
    await within(drawer).findByText('TOYO · NS60L');
    expect(h.catalogs().at(-1)?.url).toBe('/api/stock-adjustments/catalog?page=1&page_size=25&kind=battery&search=NS60');
    expect(within(drawer).queryByText('CAR · NS40ZL')).not.toBeInTheDocument();
    fireEvent.change(within(drawer).getByLabelText('Buscar variante'), { target: { value: 'nada' } });
    expect(await within(drawer).findByText('Sin variantes para esa búsqueda.')).toBeInTheDocument();
  });

  it('refuses an empty document without sending anything', async () => {
    const h = harness();
    await ready(h);
    const drawer = await openDrawer();
    await within(drawer).findByText('CAR · NS40ZL');
    fireEvent.click(applyButton(drawer));
    expect(within(drawer).getByRole('status')).toHaveTextContent('Agregá al menos una variante contada antes de aplicar.');
    expect(h.posts()).toHaveLength(0);
  });

  it('refuses a document without a motive without sending anything', async () => {
    const h = harness();
    await ready(h);
    const drawer = await openDrawer();
    fireEvent.change(await within(drawer).findByLabelText('Contado de CAR · NS40ZL'), { target: { value: '12' } });
    fireEvent.click(applyButton(drawer));
    expect(within(drawer).getByRole('status')).toHaveTextContent('Elegí un motivo del ajuste antes de aplicar.');
    expect(h.posts()).toHaveLength(0);
  });

  it('applies only the counted quantities, then reveals the new document', async () => {
    let applied = false;
    const h = harness({
      create: () => { applied = true; return createdReply(); },
      history: () => historyReply(applied
        ? [summary({ id: 9, reason: motive, detail: '', lines: 2, total_difference: -6 }), ...defaultHistory]
        : defaultHistory),
    });
    await ready(h);
    const drawer = await openDrawer();
    fireEvent.change(await within(drawer).findByLabelText('Contado de CAR · NS40ZL'), { target: { value: '12' } });
    fireEvent.change(within(drawer).getByLabelText('Contado de TOYO · NS60L'), { target: { value: '0' } });
    fireEvent.change(within(drawer).getByLabelText('Motivo del ajuste'), { target: { value: motive } });
    fireEvent.click(applyButton(drawer));
    await waitFor(() => expect(h.posts()).toHaveLength(1));
    const post = h.posts()[0];
    expect(post.init).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store' });
    expect(post.init.headers).toMatchObject({ 'Content-Type': 'application/json', 'X-CSRF-Token': csrf });
    expect(JSON.parse(String(post.init.body))).toEqual({
      operation_key: expect.stringMatching(/^[A-Za-z0-9_-]{16,128}$/), reason: motive,
      lines: [{ variant_id: 4, counted_quantity: 12 }, { variant_id: 7, counted_quantity: 0 }],
    });
    // The drawer closes, the history is refreshed and the new document opens by itself.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(historyStatus()).toHaveTextContent('Ajuste #9 aplicado: diferencia total -6.'));
    await waitFor(() => expect(document.getElementById('adjustment-lines-9')).not.toBeNull());
    const panel = document.getElementById('adjustment-lines-9')!;
    expect(await within(panel).findByText('CAR · NS40ZL')).toBeInTheDocument();
    const lines = within(panel).getAllByRole('row').slice(1).map(row => within(row).getAllByRole('cell').map(cell => cell.textContent));
    expect(lines).toEqual([
      ['CAR · NS40ZL', '35 Ah', 'L', '18', '12', '-6'],
      ['TOYO · NS60L', '45 Ah', 'L', '0', '0', '0'],
    ]);
  });

  it.each([
    ['retry_conflict', 409, stockAdjustmentApplyMessages.retry_conflict],
    ['insufficient_stock', 409, stockAdjustmentApplyMessages.insufficient_stock],
    ['invalid_request', 400, stockAdjustmentApplyMessages.invalid_request],
    ['forbidden', 403, stockAdjustmentApplyMessages.forbidden],
    ['service_unavailable', 503, stockAdjustmentApplyMessages.service_unavailable],
  ])('shows the honest message for a %s rejection and never retries silently', async (code, status, message) => {
    const h = harness({ create: () => errorReply(code, status) });
    await ready(h);
    const drawer = await openDrawer();
    fireEvent.change(await within(drawer).findByLabelText('Contado de CAR · NS40ZL'), { target: { value: '12' } });
    fireEvent.change(within(drawer).getByLabelText('Motivo del ajuste'), { target: { value: motive } });
    fireEvent.click(applyButton(drawer));
    await waitFor(() => expect(within(drawer).getByRole('alert')).toHaveTextContent(message));
    // The typed count survives the rejection and no second request leaves on its own.
    expect(countedBox(drawer, 'CAR · NS40ZL')).toHaveValue(12);
    await waitFor(() => expect(h.posts()).toHaveLength(1));
    expect(screen.getByRole('dialog', { name: 'Nuevo ajuste' })).toBeInTheDocument();
  });
});

describe('adjustment counter-entry', () => {
  const openReversal = (id: number) => {
    fireEvent.click(within(historial()).getByRole('button', { name: `Revertir ajuste #${id}` }));
    return screen.getByRole('dialog', { name: 'Registrar contra-asiento' });
  };

  it('offers the correction only on an applied document', async () => {
    const h = harness();
    await ready(h);
    expect(within(historial()).getAllByRole('button', { name: /^Revertir ajuste/ })
      .map(button => button.getAttribute('aria-label'))).toEqual(['Revertir ajuste #6', 'Revertir ajuste #5']);
    expect(within(historial()).queryByRole('button', { name: 'Revertir ajuste #8' })).not.toBeInTheDocument();
    expect(within(historial()).queryByRole('button', { name: 'Revertir ajuste #7' })).not.toBeInTheDocument();
  });

  it('offers exactly the four operator motives and refuses a blank reason', async () => {
    const h = harness();
    await ready(h);
    const dialog = openReversal(6);
    const select = within(dialog).getByLabelText('Motivo del contra-asiento');
    expect(within(select).getAllByRole('option').map(option => option.textContent)).toEqual([
      'Elegí un motivo', 'Conteo físico periódico', 'Merma o rotura', 'Diferencia detectada en preparación', 'Otro',
    ]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirmar contra-asiento' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('El motivo del contra-asiento es obligatorio');
    expect(h.reversals()).toHaveLength(0);
  });

  it('sends only the operation key and the reason, then shows the counter-entry', async () => {
    let reversed = false;
    const h = harness({
      reverse: () => { reversed = true; return counterReply('Diferencia detectada en preparación'); },
      history: () => historyReply(reversed
        ? [summary({ id: 10, reason: 'Diferencia detectada en preparación', lines: 1, total_difference: 4, reverses_adjustment_id: 6 }),
          summary({ id: 6, reason: motive, detail: '', lines: 1, total_difference: -4, reversed_by: 10 }),
          summary({ id: 5 })]
        : defaultHistory),
    });
    await ready(h);
    const dialog = openReversal(6);
    fireEvent.change(within(dialog).getByLabelText('Motivo del contra-asiento'), { target: { value: 'Diferencia detectada en preparación' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirmar contra-asiento' }));
    await waitFor(() => expect(h.reversals()).toHaveLength(1));
    expect(h.reversals()[0].url).toBe('/api/stock-adjustments/6/reverse');
    expect(JSON.parse(String(h.reversals()[0].init.body))).toEqual({
      operation_key: expect.stringMatching(/^[A-Za-z0-9_-]{16,128}$/),
      reason: 'Diferencia detectada en preparación',
    });
    expect(Object.keys(JSON.parse(String(h.reversals()[0].init.body)))).toEqual(['operation_key', 'reason']);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(historyStatus()).toHaveTextContent('Contra-asiento registrado: documento #10.'));
    await waitFor(() => expect(document.getElementById('adjustment-lines-10')).not.toBeNull());
    expect(await within(historial()).findByText('Revertido')).toBeInTheDocument();
  });

  it('keeps the dialog and the chosen motive when the server rejects the correction', async () => {
    const h = harness({ reverse: () => errorReply('insufficient_stock', 409) });
    await ready(h);
    const dialog = openReversal(6);
    fireEvent.change(within(dialog).getByLabelText('Motivo del contra-asiento'), { target: { value: 'Merma o rotura' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirmar contra-asiento' }));
    await waitFor(() => expect(within(dialog).getByRole('alert'))
      .toHaveTextContent(stockAdjustmentReversalMessages.insufficient_stock));
    expect(within(dialog).getByLabelText('Motivo del contra-asiento')).toHaveValue('Merma o rotura');
    expect(h.reversals()).toHaveLength(1);
  });
});

describe('adjustment realtime refresh', () => {
  it('re-reads the history and the catalogue when another session changes the stock', async () => {
    const listeners = new Set<() => void>();
    const realtime = {
      subscribeSourceInventoryInvalidation: (listener: () => void) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
    };
    const h = harness();
    render(<StockAdjustment csrf={csrf} fetcher={h.fetcher} realtime={realtime} />);
    await within(historial()).findByText('#6');
    expect(listeners.size).toBe(1);
    const drawer = await openDrawer();
    await within(drawer).findByText('CAR · NS40ZL');
    const historiesBefore = h.histories().length;
    const catalogsBefore = h.catalogs().length;
    listeners.forEach(listener => listener());
    await waitFor(() => expect(h.histories().length).toBeGreaterThan(historiesBefore));
    await waitFor(() => expect(h.catalogs().length).toBeGreaterThan(catalogsBefore));
  });
});
