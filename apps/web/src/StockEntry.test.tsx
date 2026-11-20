import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import StockEntry from './StockEntry';
import { stockEntryErrorMessages, stockEntryReversalErrorMessages, stockSupplierNoOffers } from './stockEntryModel';

const csrf = 'c'.repeat(43);
const north = { id: 3, name: 'Proveedor del norte' };
type Polarity = 'L' | 'R';
// The catalogue of the picker: the identity of the warehouse and the catalogue
// entry it belongs to, never a stock number.
const batteryRow = (variantID: number, entryID: number, brand: string, model: string, capacity: number,
  polarity: Polarity) => JSON.stringify({
  variant_id: variantID, catalog_entry_id: entryID, kind: 'battery', name: `${brand} · ${model}`,
  detail: `${capacity} Ah · ${polarity}`,
  battery: { brand, model, capacity_ah: String(capacity), polarity }, fields: null,
});
const productRow = (variantID: number, entryID: number, name: string, detail: string) => JSON.stringify({
  variant_id: variantID, catalog_entry_id: entryID, kind: 'other', name, detail, battery: null,
  fields: [{ name: detail.slice(0, detail.indexOf(':')), kind: 'text', text: detail.slice(detail.indexOf(': ') + 2) }],
});
const catalogPage = (items: readonly string[]) => `{"items":[${items.join(',')}],"page_size":500}`;
const ns40zl = [batteryRow(4, 11, 'TOYO', 'NS40ZL', 35, 'L'), batteryRow(5, 11, 'TOYO', 'NS40ZL', 35, 'R')];
const ns60l = [batteryRow(8, 12, 'TOYO', 'NS60L', 45, 'L'), batteryRow(9, 12, 'TOYO', 'NS60L', 45, 'R')];
const willard = [batteryRow(21, 21, 'WILLARD', '55D23L', 50, 'L'), batteryRow(22, 21, 'WILLARD', '55D23L', 50, 'R')];
// 22 offered rows of batteries: 3 products under TOYO and 1 under WILLARD.
const batteryItems = [...ns40zl, ...ns60l, ...willard];
const catalogReply = (search: string) => new Response(
  catalogPage(search === 'NS60' ? ns60l : search === 'nada' ? [] : batteryItems),
  { status: 200, headers: { 'Content-Type': 'application/json' } });
// The operator volume of the reported defect: 33 products of batteries, each one
// with its two polarities, for 66 variants and 33 rows.
const volumeItems = Array.from({ length: 33 }, (_, index) => {
  const brand = `MARCA ${Math.floor(index / 3) + 1}`;
  const product = `P${index + 1}`;
  return [batteryRow(1000 + index * 2, 1000 + index, brand, product, 45, 'L'),
    batteryRow(1001 + index * 2, 1000 + index, brand, product, 45, 'R')];
}).flat();
const volumeReply = () => new Response(catalogPage(volumeItems), { status: 200, headers: { 'Content-Type': 'application/json' } });
const entryReply = () => new Response(JSON.stringify({
  id: 7, location_id: 1, note: 'Remito 0002', created_by_account_id: 1, created_at: '2026-05-01T14:20:00Z',
  supplier: north, lines: [{ variant_id: 4, quantity: 3 }], total_units: 3,
}), { status: 201, headers: { 'Content-Type': 'application/json' } });
const errorReply = (code: string, status: number) => new Response(JSON.stringify({ error: code }),
  { status, headers: { 'Content-Type': 'application/json' } });
// The supplier list the screen chooses from: active suppliers first, the retired
// one last and marked, each with the offer count that makes an empty one obvious.
const supplierRow = (id: number, name: string, kinds: readonly string[], offers: number, retired = false) =>
  JSON.stringify({ id, name, contact: '', retired, kinds, offers });
const defaultSuppliers = [
  supplierRow(3, 'Proveedor del norte', ['battery', 'other'], 4),
  supplierRow(4, 'Baterías Sur', ['battery'], 2),
  supplierRow(5, 'Sin productos', [], 0),
  supplierRow(6, 'Proveedor retirado', ['battery'], 1, true),
];
const supplierReply = (rows: readonly string[] = defaultSuppliers) => new Response(
  JSON.stringify({ suppliers: rows.map(supplier => JSON.parse(supplier) as unknown), page: 1, page_size: 50,
    total_suppliers: rows.length }),
  { status: 200, headers: { 'Content-Type': 'application/json' } });
const historyRow = (id: number, note: string, lines: number, units: number, reversedBy: number | null = null,
  supplier: { id: number; name: string } | null = null) =>
  JSON.stringify({ id, note, created_at: '2026-05-01T14:20:00Z', supplier, lines, total_units: units, reversed_by: reversedBy });
const historyReply = (rows: readonly string[], page = 1, pageSize = 25, total = rows.length) => new Response(
  JSON.stringify({ page, page_size: pageSize, total_entries: total,
    entries: rows.map(row => JSON.parse(row) as unknown) }),
  { status: 200, headers: { 'Content-Type': 'application/json' } });
const defaultHistoryRows = [historyRow(6, 'Remito 0002', 2, 18, null, north), historyRow(5, '', 1, 3)];

function harness(options: {
  suppliers?: () => Response | Promise<Response>;
  catalog?: (search: string, kind: string, supplierID: string) => Response;
  create?: (body: string) => Response | Promise<Response>;
  history?: (query: URLSearchParams) => Response | Promise<Response>;
  reverse?: (target: string, body: string) => Response | Promise<Response>;
  detail?: (id: string) => Response | Promise<Response>;
} = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.startsWith('/api/suppliers?')) return options.suppliers?.() ?? supplierReply();
    const catalogue = /^\/api\/suppliers\/(\d+)\/catalog\?/.exec(url);
    if (catalogue) {
      const params = new URL(url, 'http://localhost').searchParams;
      const search = params.get('search') ?? '';
      return options.catalog?.(search, params.get('kind') ?? '', catalogue[1]) ?? catalogReply(search);
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
  return { fetcher, calls,
    supplierList: () => calls.filter(call => call.url.startsWith('/api/suppliers?')),
    catalogs: () => calls.filter(call => /^\/api\/suppliers\/\d+\/catalog\?/.test(call.url)),
    // The ingress screen has no path to the whole inventory catalogue: the picker
    // is the supplier's catalogue or nothing (S5).
    inventory: () => calls.filter(call => call.url.startsWith('/api/inventory')),
    posts: () => calls.filter(call => call.url === '/api/stock-entries'),
    histories: () => calls.filter(call => call.url.startsWith('/api/stock-entries?')),
    reversals: () => calls.filter(call => call.url.endsWith('/reverse')),
    details: () => calls.filter(call => /^\/api\/stock-entries\/[^/?]+$/.test(call.url)) };
}

// The counter-entry of `historyRow(6, ..., 2, 18)`: the same lines, negated, and
// the supplier inherited from the original document.
const counterReply = (overrides: Record<string, unknown> = {}) => new Response(JSON.stringify({
  id: 10, location_id: 1, note: '', created_by_account_id: 1, created_at: '2026-05-01T14:25:00Z',
  supplier: north, lines: [{ variant_id: 4, quantity: -3 }, { variant_id: 9, quantity: -15 }], total_units: -18, ...overrides,
}), { status: 201, headers: { 'Content-Type': 'application/json' } });
// The per-document detail of the row used by the detail tests: two catalogue lines
// summing to the listed total.
const detailLineOf = (variant_id: number, model: string, quantity: number, capacity = '45') =>
  ({ variant_id, kind: 'battery', name: `TOYO · ${model}`, detail: `${capacity} Ah · L`,
    battery: { brand: 'TOYO', model, capacity_ah: capacity, polarity: 'L' as const }, fields: null, quantity });
const productLineOf = (variant_id: number, name: string, detail: string, quantity: number) =>
  ({ variant_id, kind: 'other', name, detail, battery: null,
    fields: [{ name: detail.split(':')[0], kind: 'text', text: detail.split(': ')[1] }], quantity });
const detailReply = (overrides: Record<string, unknown> = {}) => new Response(JSON.stringify({
  id: 6, location_id: 1, note: 'Remito 0002', created_at: '2026-05-01T14:20:00Z',
  created_by_account_id: 1, reverses_entry_id: null, reversed_by: null, reason: '', supplier: north,
  lines: [detailLineOf(4, 'NS40ZL', 3, '35'), detailLineOf(9, 'NS60L', 15)], total_units: 18, ...overrides,
}), { status: 200, headers: { 'Content-Type': 'application/json' } });
const openReversal = async (historial: HTMLElement) => {
  fireEvent.click(within(historial).getByRole('button', { name: 'Anular ingreso #6' }));
  return screen.getByRole('dialog', { name: 'Registrar contra-asiento' });
};

// The screen is one context strip, two bounded panels and the ledger below.
const contextStrip = () => screen.getByRole('region', { name: 'Contexto del documento' });
const catalogPanel = () => screen.getByRole('region', { name: 'Catálogo' });
const documentPanel = () => screen.getByRole('region', { name: 'Documento' });
const historyPanel = () => screen.getByRole('region', { name: 'Historial de ingresos' });
const supplierSelect = () => within(contextStrip()).getByLabelText('Proveedor') as HTMLSelectElement;
const kindControl = () => screen.queryByRole('group', { name: 'Tipo de producto del ingreso' });
const supplierOption = (name: string) =>
  within(supplierSelect()).getByRole('option', { name: new RegExp(`^${name}`) }) as HTMLOptionElement;
const groupHead = (label: string) => within(catalogPanel()).getByRole('button', { name: new RegExp(`^${label}`) });
const polarityButton = (brand: string, model: string, polarity: Polarity) =>
  within(catalogPanel()).getByRole('button', { name: `Agregar ${brand} ${model} polaridad ${polarity}` });
const addProduct = (name: string) => within(catalogPanel()).getByRole('button', { name: `Agregar ${name}` });
const totalFor = (label: 'Líneas' | 'Unidades') =>
  within(documentPanel()).getByText(label, { selector: 'dt' }).closest('div') as HTMLElement;
const confirmButton = () => within(documentPanel()).getByRole('button', { name: 'Confirmar ingreso' });
// The screen asks who brings the merchandise before anything else, so every flow
// starts by choosing the supplier and then the kind of the document.
const chooseSupplier = async (name = north.name) => {
  const select = supplierSelect();
  await waitFor(() => expect(within(select).getByRole('option', { name: new RegExp(`^${name}`) })).toBeInTheDocument());
  fireEvent.change(select, { target: { value: supplierOption(name).value } });
};
const chooseKind = (label: 'Baterías' | 'Otros productos') => {
  const control = kindControl();
  if (control === null) throw new Error('the screen offers no kind control');
  fireEvent.click(within(control).getByRole('button', { name: label }));
};
async function ready(h: ReturnType<typeof harness>) {
  render(<StockEntry csrf={csrf} fetcher={h.fetcher} />);
  await chooseSupplier();
  chooseKind('Baterías');
  await within(catalogPanel()).findByRole('button', { name: 'Agregar TOYO NS40ZL polaridad L' });
}
const productRows = () => Array.from(document.querySelectorAll('tr[data-product-id]'));

describe('stock entry supplier first', () => {
  it('asks for the supplier before any kind, catalogue or document exists', async () => {
    const h = harness();
    render(<StockEntry csrf={csrf} fetcher={h.fetcher} />);
    const strip = contextStrip();
    expect(supplierSelect()).toBeDisabled();
    expect(within(strip).getByRole('status')).toHaveTextContent('Consultando proveedores');
    // The offer count makes an empty supplier obvious before choosing it, a retired
    // supplier is listed but never selectable, and the placeholder is not a choice.
    await within(strip).findByRole('option', { name: /^Proveedor del norte · 4 productos/ });
    expect(within(strip).getAllByRole('option')).toHaveLength(5);
    expect(supplierOption('Sin productos')).toHaveTextContent('Sin productos asignados');
    expect(supplierOption('Proveedor retirado')).toBeDisabled();
    // Nothing else exists yet: no kind decision, no picker and no document.
    expect(kindControl()).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Catálogo' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Documento' })).not.toBeInTheDocument();
    expect(screen.getByText('Elegí el proveedor para ver los productos que podés ingresar.')).toBeInTheDocument();
    expect(h.supplierList()).toHaveLength(1);
    expect(h.supplierList()[0].url).toBe('/api/suppliers?page=1&page_size=50');
    expect(h.supplierList()[0].init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store' });
    expect(h.catalogs()).toHaveLength(0);
    // Only after choosing a supplier does the kind decision appear and reading start.
    await chooseSupplier();
    expect(within(kindControl() as HTMLElement).getAllByRole('button').map(choice => choice.textContent))
      .toEqual(['Baterías', 'Otros productos']);
    expect(h.catalogs()).toHaveLength(0);
    chooseKind('Baterías');
    await within(catalogPanel()).findByRole('button', { name: 'Agregar TOYO NS40ZL polaridad L' });
    expect(h.catalogs()[0].url).toBe('/api/suppliers/3/catalog?kind=battery');
    expect(h.inventory()).toHaveLength(0);
  });

  it('offers only the kinds the chosen supplier actually offers', async () => {
    const h = harness();
    render(<StockEntry csrf={csrf} fetcher={h.fetcher} />);
    // A supplier with a single kind needs no control and no sentence: the kind is
    // a chip of its own and it is chosen as soon as the supplier is.
    await chooseSupplier('Baterías Sur');
    expect(kindControl()).not.toBeInTheDocument();
    expect(within(contextStrip()).getByRole('note', { name: 'Tipo del documento' })).toHaveTextContent('Baterías');
    expect(screen.queryByRole('button', { name: 'Otros productos' })).not.toBeInTheDocument();
    await within(catalogPanel()).findByRole('button', { name: 'Agregar TOYO NS40ZL polaridad L' });
    expect(h.catalogs()[0].url).toBe('/api/suppliers/4/catalog?kind=battery');
    // A supplier that offers both kinds asks for the kind, and only those two.
    await chooseSupplier();
    expect(within(kindControl() as HTMLElement).getAllByRole('button').map(choice => choice.getAttribute('aria-pressed')))
      .toEqual(['false', 'false']);
  });

  it('reads the picker of the chosen supplier only, never the whole catalogue', async () => {
    const h = harness({ catalog: (search, _kind, supplierID) => supplierID === '4'
      ? new Response(catalogPage([batteryRow(31, 31, 'WILLARD', '55B24L', 45, 'L')]),
        { status: 200, headers: { 'Content-Type': 'application/json' } })
      : catalogReply(search) });
    render(<StockEntry csrf={csrf} fetcher={h.fetcher} />);
    await chooseSupplier('Baterías Sur');
    await within(catalogPanel()).findByRole('button', { name: 'Agregar WILLARD 55B24L polaridad L' });
    expect(within(catalogPanel()).queryByRole('button', { name: 'Agregar TOYO NS40ZL polaridad L' })).not.toBeInTheDocument();
    // Choosing another supplier drops every row of the previous one, so a line of
    // a supplier that does not offer it can never be added.
    await chooseSupplier();
    chooseKind('Baterías');
    await within(catalogPanel()).findByRole('button', { name: 'Agregar TOYO NS40ZL polaridad L' });
    expect(within(catalogPanel()).queryByRole('button', { name: 'Agregar WILLARD 55B24L polaridad L' })).not.toBeInTheDocument();
    expect(h.catalogs().map(call => call.url)).toEqual([
      '/api/suppliers/4/catalog?kind=battery', '/api/suppliers/3/catalog?kind=battery',
    ]);
    expect(h.inventory()).toHaveLength(0);
  });

  it('names the chosen supplier and its kind in the request, the strip and the document', async () => {
    const h = harness();
    render(<StockEntry csrf={csrf} fetcher={h.fetcher} />);
    await chooseSupplier();
    chooseKind('Baterías');
    await within(catalogPanel()).findByRole('button', { name: 'Agregar TOYO NS40ZL polaridad L' });
    expect(h.catalogs()[0].url).toBe('/api/suppliers/3/catalog?kind=battery');
    expect(within(contextStrip()).getByText('4 productos')).toBeInTheDocument();
    expect(within(catalogPanel()).getByText(new RegExp(`^${north.name} · Baterías`))).toBeInTheDocument();
    const documento = documentPanel();
    expect(within(documento).getByRole('note', { name: 'Proveedor del documento' })).toHaveTextContent(north.name);
    expect(within(documento).getByRole('note', { name: 'Tipo del documento' })).toHaveTextContent('Baterías');
    fireEvent.change(within(catalogPanel()).getByLabelText('Buscar marca, modelo o capacidad'), { target: { value: 'NS60' } });
    await within(catalogPanel()).findByRole('button', { name: 'Agregar TOYO NS60L polaridad L' });
    expect(h.catalogs().at(-1)?.url).toBe('/api/suppliers/3/catalog?kind=battery&search=NS60');
  });

  it('says a supplier without assigned products can ingress nothing', async () => {
    const h = harness();
    render(<StockEntry csrf={csrf} fetcher={h.fetcher} />);
    await chooseSupplier('Sin productos');
    expect(screen.getByText(stockSupplierNoOffers)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Proveedor sin productos' })).toBeInTheDocument();
    // No picker, no document and no confirmation: nothing can be sent.
    expect(kindControl()).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Catálogo' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Documento' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirmar ingreso' })).not.toBeInTheDocument();
    expect(h.catalogs()).toHaveLength(0);
    expect(h.posts()).toHaveLength(0);
  });

  it('asks for confirmation and only then discards the draft when the supplier changes', async () => {
    const h = harness();
    await ready(h);
    const documento = documentPanel();
    fireEvent.click(polarityButton('TOYO', 'NS40ZL', 'L'));
    fireEvent.change(within(documento).getByLabelText('Cantidad de TOYO · NS40ZL polaridad L'), { target: { value: '3' } });
    fireEvent.change(within(documento).getByLabelText('Nota (opcional)'), { target: { value: 'Remito 0002' } });
    await chooseSupplier('Baterías Sur');
    const dialog = screen.getByRole('dialog', { name: 'Cambiar de proveedor' });
    expect(within(dialog).getByText(/no se convierten ni se migran/)).toBeInTheDocument();
    // Nothing changed while the confirmation is open: the strip still names the
    // supplier of the document and its line keeps its quantity.
    expect(supplierSelect().value).toBe('3');
    expect(within(documento).getByLabelText('Cantidad de TOYO · NS40ZL polaridad L')).toHaveValue(3);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(supplierSelect().value).toBe('3');
    expect(within(documento).getByLabelText('Cantidad de TOYO · NS40ZL polaridad L')).toHaveValue(3);
    expect(within(documento).getByLabelText('Nota (opcional)')).toHaveValue('Remito 0002');
    // The deliberate change discards the whole draft of the other supplier.
    await chooseSupplier('Baterías Sur');
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Cambiar de proveedor' }))
      .getByRole('button', { name: 'Descartar borrador y cambiar proveedor' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await within(catalogPanel()).findByRole('button', { name: 'Agregar TOYO NS40ZL polaridad L' });
    expect(within(documento).queryByLabelText('Cantidad de TOYO · NS40ZL polaridad L')).not.toBeInTheDocument();
    expect(within(documento).getByText('Todavía no agregaste líneas.')).toBeInTheDocument();
    expect(within(documento).getByLabelText('Nota (opcional)')).toHaveValue('');
    expect(within(documento).getByRole('note', { name: 'Proveedor del documento' })).toHaveTextContent('Baterías Sur');
    expect(h.catalogs().at(-1)?.url).toBe('/api/suppliers/4/catalog?kind=battery');
  });

  it('reports an unavailable supplier list and reads it again on retry', async () => {
    let failing = true;
    const h = harness({ suppliers: () => failing ? errorReply('service_unavailable', 503) : supplierReply() });
    render(<StockEntry csrf={csrf} fetcher={h.fetcher} />);
    const strip = contextStrip();
    expect(await within(strip).findByRole('alert')).toHaveTextContent('No se pudo consultar la lista de proveedores');
    expect(screen.queryByRole('region', { name: 'Catálogo' })).not.toBeInTheDocument();
    failing = false;
    fireEvent.click(within(strip).getByRole('button', { name: 'Reintentar proveedores' }));
    await waitFor(() => expect(within(strip).getByRole('option', { name: /^Proveedor del norte/ })).toBeInTheDocument());
    expect(h.supplierList()).toHaveLength(2);
  });
});

describe('stock entry catalogue', () => {
  it('groups 66 variants of 33 products into 33 rows under their brand groups', async () => {
    const h = harness({ catalog: () => volumeReply() });
    render(<StockEntry csrf={csrf} fetcher={h.fetcher} />);
    await chooseSupplier();
    chooseKind('Baterías');
    await waitFor(() => expect(catalogPanel().querySelectorAll('.stock-group-head')).toHaveLength(11));
    expect(within(catalogPanel()).getAllByText('33 productos').length).toBeGreaterThan(0);
    const heads = Array.from(catalogPanel().querySelectorAll<HTMLButtonElement>('.stock-group-head'));
    expect(heads).toHaveLength(11);
    for (const head of heads) expect(head).toHaveTextContent('3 productos');
    // Default order: the group where the work starts, open; everything else closed.
    expect(heads[0]).toHaveAttribute('aria-expanded', 'true');
    expect(heads.slice(1).every(head => head.getAttribute('aria-expanded') === 'false')).toBe(true);
    expect(productRows()).toHaveLength(3);
    // The whole catalogue is 33 rows: one per product, never one per polarity.
    fireEvent.click(within(catalogPanel()).getByRole('button', { name: 'Ver todos los productos (33)' }));
    const rows = productRows();
    expect(rows).toHaveLength(33);
    expect(new Set(rows.map(row => row.getAttribute('data-product-id'))).size).toBe(33);
    expect(within(catalogPanel()).getAllByRole('button', { name: /polaridad/ })).toHaveLength(66);
    // The footer counts products, never polarities.
    expect(catalogPanel().querySelector('.stock-catalog-foot')).toHaveTextContent('33 productos');
  });

  it('collapses and expands a brand group with aria-expanded', async () => {
    const h = harness();
    await ready(h);
    const toyo = groupHead('TOYO');
    const willardHead = groupHead('WILLARD');
    expect(toyo).toHaveAttribute('aria-expanded', 'true');
    expect(willardHead).toHaveAttribute('aria-expanded', 'false');
    expect(productRows()).toHaveLength(2);
    fireEvent.click(willardHead);
    expect(willardHead).toHaveAttribute('aria-expanded', 'true');
    expect(productRows()).toHaveLength(3);
    fireEvent.click(toyo);
    expect(toyo).toHaveAttribute('aria-expanded', 'false');
    expect(within(catalogPanel()).queryByRole('button', { name: 'Agregar TOYO NS40ZL polaridad L' })).not.toBeInTheDocument();
    fireEvent.click(toyo);
    expect(toyo).toHaveAttribute('aria-expanded', 'true');
    expect(polarityButton('TOYO', 'NS40ZL', 'L')).toBeInTheDocument();
  });

  it('opens every group with Ver todos los productos (N)', async () => {
    const h = harness();
    await ready(h);
    fireEvent.click(within(catalogPanel()).getByRole('button', { name: 'Ver todos los productos (3)' }));
    expect(groupHead('TOYO')).toHaveAttribute('aria-expanded', 'true');
    expect(groupHead('WILLARD')).toHaveAttribute('aria-expanded', 'true');
    expect(productRows()).toHaveLength(3);
  });

  it('reads the supplier catalogue once, then again for the typed search', async () => {
    const h = harness();
    render(<StockEntry csrf={csrf} fetcher={h.fetcher} />);
    await chooseSupplier();
    chooseKind('Baterías');
    expect(within(catalogPanel()).getByRole('status')).toHaveTextContent('Consultando el catálogo del proveedor');
    await within(catalogPanel()).findByText('NS40ZL');
    expect(within(catalogPanel()).getByText('35 Ah')).toBeInTheDocument();
    // The supplier catalogue carries no stock numbers of its own, and its rows are
    // products with one control per polarity.
    expect(within(catalogPanel()).getAllByRole('columnheader').map(head => head.textContent))
      .toEqual(['Producto', 'Polaridad', 'En el documento']);
    expect(within(catalogPanel()).queryByText('Stock actual')).not.toBeInTheDocument();
    expect(h.catalogs()[0].url).toBe('/api/suppliers/3/catalog?kind=battery');
    expect(h.catalogs()[0].init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store' });
    fireEvent.change(within(catalogPanel()).getByLabelText('Buscar marca, modelo o capacidad'), { target: { value: 'NS60' } });
    await within(catalogPanel()).findByRole('button', { name: 'Agregar TOYO NS60L polaridad L' });
    expect(h.catalogs().at(-1)?.url).toBe('/api/suppliers/3/catalog?kind=battery&search=NS60');
    expect(within(catalogPanel()).queryByRole('button', { name: 'Agregar TOYO NS40ZL polaridad L' })).not.toBeInTheDocument();
    fireEvent.change(within(catalogPanel()).getByLabelText('Buscar marca, modelo o capacidad'), { target: { value: 'nada' } });
    await within(catalogPanel()).findByText('Sin coincidencias en el catálogo.');
    expect(within(catalogPanel()).queryByRole('button', { name: /Ver todos los productos/ })).not.toBeInTheDocument();
  });

  it('reports an unavailable catalogue and reads it again on demand', async () => {
    let failing = true;
    const h = harness({ catalog: search => failing ? errorReply('service_unavailable', 503) : catalogReply(search) });
    render(<StockEntry csrf={csrf} fetcher={h.fetcher} />);
    await chooseSupplier();
    chooseKind('Baterías');
    const catalogo = catalogPanel();
    expect(await within(catalogo).findByRole('alert')).toHaveTextContent('No se pudo consultar el catálogo del proveedor elegido');
    failing = false;
    fireEvent.click(within(catalogo).getByRole('button', { name: 'Reintentar catálogo' }));
    await within(catalogo).findByRole('button', { name: 'Agregar TOYO NS40ZL polaridad L' });
    expect(h.catalogs()).toHaveLength(2);
  });
});

describe('stock entry document', () => {
  it('adds a line by polarity to that exact variant and the counters follow', async () => {
    const h = harness();
    await ready(h);
    const documento = documentPanel();
    expect(within(documento).getByText('Todavía no agregaste líneas.')).toBeInTheDocument();
    expect(totalFor('Líneas')).toHaveTextContent(/Líneas\s*0/);
    expect(totalFor('Unidades')).toHaveTextContent(/Unidades\s*0/);
    fireEvent.click(polarityButton('TOYO', 'NS40ZL', 'L'));
    fireEvent.click(polarityButton('TOYO', 'NS40ZL', 'L'));
    // The same polarity increments its own line instead of adding a second row.
    expect(within(documento).getAllByLabelText(/^Cantidad de /)).toHaveLength(1);
    expect(within(documento).getByLabelText('Cantidad de TOYO · NS40ZL polaridad L')).toHaveValue(2);
    expect(within(documento).getByRole('status'))
      .toHaveTextContent('TOYO · NS40ZL polaridad L ya estaba en el documento: ahora 2 unidades.');
    // The other polarity of the same product is its own line, never another product.
    fireEvent.click(polarityButton('TOYO', 'NS40ZL', 'R'));
    expect(within(documento).getByLabelText('Cantidad de TOYO · NS40ZL polaridad R')).toHaveValue(1);
    expect(totalFor('Líneas')).toHaveTextContent(/Líneas\s*2/);
    expect(totalFor('Unidades')).toHaveTextContent(/Unidades\s*3/);
    // The counters of the catalogue footer follow the same draft.
    expect(catalogPanel().querySelector('.stock-catalog-foot'))
      .toHaveTextContent('3 productos · 2 líneas en el documento · 3 u.');
    // The brand header aggregates what the draft already holds from that brand.
    expect(groupHead('TOYO')).toHaveTextContent('3 u.');
    fireEvent.click(confirmButton());
    await waitFor(() => expect(h.posts()).toHaveLength(1));
    expect(JSON.parse(String(h.posts()[0].init.body))).toMatchObject({
      supplier_id: 3, lines: [{ variant_id: 4, quantity: 2 }, { variant_id: 5, quantity: 1 }],
    });
  });

  it('zero lines leaves the confirmation disabled with its reason wired by aria-describedby', async () => {
    const h = harness();
    await ready(h);
    const documento = documentPanel();
    const confirm = confirmButton();
    expect(confirm).toBeDisabled();
    const reason = document.getElementById(confirm.getAttribute('aria-describedby') ?? '');
    expect(reason).toBeInTheDocument();
    expect(reason).toHaveTextContent('Agregá al menos una línea para confirmar. El stock no se toca hasta que confirmes.');
    fireEvent.click(polarityButton('TOYO', 'NS40ZL', 'L'));
    expect(confirmButton()).toBeEnabled();
    expect(document.getElementById(confirmButton().getAttribute('aria-describedby') ?? ''))
      .toHaveTextContent('Se aplica todo junto; al confirmar el documento queda fijo y se corrige con un contra-asiento.');
    expect(within(documento).getByText('Sin aplicar')).toBeInTheDocument();
  });

  it('updates the totals when a quantity is edited or a line is removed', async () => {
    const h = harness();
    await ready(h);
    const documento = documentPanel();
    fireEvent.click(polarityButton('TOYO', 'NS40ZL', 'L'));
    fireEvent.click(polarityButton('TOYO', 'NS60L', 'L'));
    fireEvent.change(within(documento).getByLabelText('Cantidad de TOYO · NS40ZL polaridad L'), { target: { value: '5' } });
    expect(totalFor('Líneas')).toHaveTextContent(/Líneas\s*2/);
    expect(totalFor('Unidades')).toHaveTextContent(/Unidades\s*6/);
    fireEvent.click(within(documento).getByRole('button', { name: 'Quitar TOYO · NS60L polaridad L' }));
    expect(within(documento).queryByLabelText('Cantidad de TOYO · NS60L polaridad L')).not.toBeInTheDocument();
    expect(totalFor('Líneas')).toHaveTextContent(/Líneas\s*1/);
    expect(totalFor('Unidades')).toHaveTextContent(/Unidades\s*5/);
  });

  it('refuses an invalid quantity without sending anything', async () => {
    const h = harness();
    await ready(h);
    const documento = documentPanel();
    fireEvent.click(polarityButton('TOYO', 'NS40ZL', 'L'));
    fireEvent.change(within(documento).getByLabelText('Cantidad de TOYO · NS40ZL polaridad L'), { target: { value: '0' } });
    fireEvent.click(confirmButton());
    expect(within(documento).getByRole('status')).toHaveTextContent('Cantidad inválida: ingresá un entero entre 1 y 1.000.000 en cada línea.');
    expect(h.posts()).toHaveLength(0);
  });

  it('confirms the exact payload with its supplier, shows the new document number and clears the draft', async () => {
    const h = harness();
    await ready(h);
    const documento = documentPanel();
    const before = h.catalogs().length;
    fireEvent.click(polarityButton('TOYO', 'NS40ZL', 'L'));
    fireEvent.change(within(documento).getByLabelText('Cantidad de TOYO · NS40ZL polaridad L'), { target: { value: '3' } });
    fireEvent.change(within(documento).getByLabelText('Nota (opcional)'), { target: { value: 'Remito 0002' } });
    fireEvent.click(confirmButton());
    await waitFor(() => expect(h.posts()).toHaveLength(1));
    const post = h.posts()[0];
    expect(post.init).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store' });
    expect(post.init.headers).toMatchObject({ 'Content-Type': 'application/json', 'X-CSRF-Token': csrf });
    expect(JSON.parse(String(post.init.body))).toEqual({
      operation_key: expect.stringMatching(/^[A-Za-z0-9_-]{16,128}$/), supplier_id: 3,
      note: 'Remito 0002', lines: [{ variant_id: 4, quantity: 3 }],
    });
    expect(await within(documento).findByText(/Ingreso confirmado: documento 7/)).toBeInTheDocument();
    expect(within(documento).getByRole('status')).toHaveTextContent('Ingreso confirmado: documento 7 · 3 unidades.');
    expect(within(documento).getByLabelText('Nota (opcional)')).toHaveValue('');
    expect(totalFor('Líneas')).toHaveTextContent(/Líneas\s*0/);
    expect(totalFor('Unidades')).toHaveTextContent(/Unidades\s*0/);
    await waitFor(() => expect(h.catalogs().length).toBeGreaterThan(before));
    expect(h.catalogs().at(-1)?.url).toBe('/api/suppliers/3/catalog?kind=battery');
  });

  it('keeps the typed document and the same operation key when the outcome is uncertain', async () => {
    const h = harness({ create: () => errorReply('service_unavailable', 503) });
    await ready(h);
    const documento = documentPanel();
    fireEvent.click(polarityButton('TOYO', 'NS40ZL', 'L'));
    fireEvent.change(within(documento).getByLabelText('Cantidad de TOYO · NS40ZL polaridad L'), { target: { value: '3' } });
    fireEvent.change(within(documento).getByLabelText('Nota (opcional)'), { target: { value: 'Remito 0002' } });
    fireEvent.click(confirmButton());
    await waitFor(() => expect(within(documento).getByRole('status')).toHaveTextContent(stockEntryErrorMessages.service_unavailable));
    expect(within(documento).queryByText(/Ingreso confirmado/)).not.toBeInTheDocument();
    expect(within(documento).getByLabelText('Cantidad de TOYO · NS40ZL polaridad L')).toHaveValue(3);
    expect(within(documento).getByLabelText('Nota (opcional)')).toHaveValue('Remito 0002');
    fireEvent.click(confirmButton());
    await waitFor(() => expect(h.posts()).toHaveLength(2));
    // The replay is the same intent: the same key and the same supplier.
    expect(h.posts()[1].init.body).toBe(h.posts()[0].init.body);
    expect(JSON.parse(String(h.posts()[1].init.body))).toMatchObject({ supplier_id: 3 });
  });

  it('reports a supplier that is no longer available without keeping the key', async () => {
    const h = harness({ create: () => errorReply('decision_conflict', 409) });
    await ready(h);
    const documento = documentPanel();
    fireEvent.click(polarityButton('TOYO', 'NS40ZL', 'L'));
    fireEvent.click(confirmButton());
    await waitFor(() => expect(within(documento).getByRole('status'))
      .toHaveTextContent(stockEntryErrorMessages.decision_conflict));
    expect(h.posts()).toHaveLength(1);
  });

  it('disables the confirmation while the request is in flight', async () => {
    let resolve!: (value: Response) => void;
    const h = harness({ create: () => new Promise<Response>(yes => { resolve = yes; }) });
    await ready(h);
    const documento = documentPanel();
    fireEvent.click(polarityButton('TOYO', 'NS40ZL', 'L'));
    fireEvent.change(within(documento).getByLabelText('Cantidad de TOYO · NS40ZL polaridad L'), { target: { value: '3' } });
    fireEvent.click(confirmButton());
    await waitFor(() => expect(confirmButton()).toBeDisabled());
    expect(within(documento).getByRole('status')).toHaveTextContent('Confirmando ingreso…');
    fireEvent.click(confirmButton());
    expect(h.posts()).toHaveLength(1);
    resolve(entryReply());
    await within(documento).findByText(/Ingreso confirmado: documento 7/);
    // The confirmed draft is empty again, so the same rule that starts the screen
    // disables it: zero lines cannot be confirmed twice.
    expect(confirmButton()).toBeDisabled();
  });
});

describe('stock entry bounded panels', () => {
  it('bounds the catalogue and the document with their own scroll regions and pinned footers', async () => {
    const h = harness();
    await ready(h);
    fireEvent.click(polarityButton('TOYO', 'NS40ZL', 'L'));
    const catalogo = catalogPanel();
    const documento = documentPanel();
    // The catalogue: the search above the scroll, the table head inside it and the
    // counters pinned in a footer that is not part of the scrolling region.
    const catalogScroll = within(catalogo).getByRole('region', { name: 'Productos del catálogo' });
    expect(catalogScroll).toHaveClass('stock-catalog-scroll');
    expect(catalogScroll).not.toContainElement(within(catalogo).getByLabelText('Buscar marca, modelo o capacidad'));
    expect(catalogScroll).toContainElement(within(catalogo).getAllByRole('columnheader')[0]);
    const catalogFoot = catalogo.querySelector('.stock-catalog-foot') as HTMLElement;
    expect(catalogFoot).toBeInTheDocument();
    expect(catalogScroll).not.toContainElement(catalogFoot);
    expect(catalogFoot).toHaveTextContent('3 productos · 1 línea en el documento · 1 u.');
    // The document: the context and the note above, the lines in their own region
    // with its column header, and the totals with the confirm in the pinned footer.
    const docScroll = within(documento).getByRole('region', { name: 'Líneas del documento' });
    expect(docScroll).toHaveClass('stock-doc-scroll');
    expect(docScroll).toContainElement(within(documento).getByRole('columnheader', { name: 'Cantidad' }));
    expect(docScroll).not.toContainElement(within(documento).getByLabelText('Nota (opcional)'));
    const docFoot = documento.querySelector('.stock-doc-foot') as HTMLElement;
    expect(docFoot).toBeInTheDocument();
    expect(docScroll).not.toContainElement(docFoot);
    expect(docFoot).toContainElement(confirmButton());
    expect(docFoot).toHaveTextContent('Líneas');
    expect(docFoot).toHaveTextContent('Unidades');
  });

  it('keeps the operator copy free of the removed words and the removed kind step', async () => {
    const h = harness();
    await ready(h);
    expect(document.body.textContent).not.toMatch(/variante/i);
    expect(document.body.textContent).not.toMatch(/borrador local/i);
    expect(within(documentPanel()).getByText('Sin aplicar')).toBeInTheDocument();
    // No sentence explains a kind step that only exists when both kinds are offered.
    expect(screen.queryByText(/Queda elegido automáticamente/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Elegí el tipo de producto/)).not.toBeInTheDocument();
    expect(screen.getByText('Registrá la mercadería que entra al depósito. El stock se aplica recién al confirmar.')).toBeInTheDocument();
  });
});

describe('stock ingress history', () => {
  const cellsOf = (row: HTMLElement) => within(row).getAllByRole('cell').map(cell => cell.textContent);

  it('lists the newest documents first with the applied and reversed tags', async () => {
    let release!: () => void;
    const gate = new Promise<void>(yes => { release = yes; });
    const h = harness({ history: async () => {
      await gate;
      return historyReply([
        historyRow(9, 'Remito 0003', 1, 4),
        historyRow(7, 'Remito 0002-00045871', 2, 18, 9),
        historyRow(6, '', 3, 6),
      ]);
    } });
    render(<StockEntry csrf={csrf} fetcher={h.fetcher} />);
    await chooseSupplier();
    const historial = historyPanel();
    expect(within(historial).getByRole('status')).toHaveTextContent('Consultando el historial de ingresos');
    release();
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

  it('shows the supplier of every row and sin proveedor for a historical document', async () => {
    const h = harness({ history: () => historyReply([
      historyRow(8, 'Remito 0004', 1, 20, null, north),
      historyRow(6, 'Remito 0002', 2, 18),
    ]) });
    render(<StockEntry csrf={csrf} fetcher={h.fetcher} />);
    await chooseSupplier();
    const historial = historyPanel();
    await within(historial).findByText('#8');
    const rows = within(historial).getAllByRole('row').slice(1);
    expect(cellsOf(rows[0])[6]).toBe(north.name);
    expect(cellsOf(rows[1])[6]).toBe('sin proveedor');
    // A document without a supplier keeps both of its actions.
    expect(within(rows[1]).getByRole('button', { name: 'Ver detalle del ingreso #6' })).toBeInTheDocument();
    expect(within(rows[1]).getByRole('button', { name: 'Anular ingreso #6' })).toBeInTheDocument();
  });

  it('shows an empty history without rows', async () => {
    const h = harness({ history: () => historyReply([]) });
    render(<StockEntry csrf={csrf} fetcher={h.fetcher} />);
    await chooseSupplier();
    const historial = historyPanel();
    expect(await within(historial).findByText('Todavía no hay ingresos registrados.')).toBeInTheDocument();
    expect(within(historial).queryByRole('table')).not.toBeInTheDocument();
  });

  it('reports an unavailable history and reads it again on retry', async () => {
    let failing = true;
    const h = harness({ history: () => failing ? errorReply('service_unavailable', 503) : historyReply(defaultHistoryRows) });
    render(<StockEntry csrf={csrf} fetcher={h.fetcher} />);
    await chooseSupplier();
    const historial = historyPanel();
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
    await chooseSupplier();
    const historial = historyPanel();
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
        ? [historyRow(7, 'Remito 0002', 1, 3, null, north), historyRow(6, 'Remito 0002', 2, 18)]
        : [historyRow(6, 'Remito 0002', 2, 18)]),
      create: () => { confirmed = true; return entryReply(); },
    });
    await ready(h);
    const documento = documentPanel();
    const historial = historyPanel();
    await within(historial).findByText('#6');
    expect(within(historial).queryByText('#7')).not.toBeInTheDocument();
    fireEvent.click(polarityButton('TOYO', 'NS40ZL', 'L'));
    fireEvent.change(within(documento).getByLabelText('Cantidad de TOYO · NS40ZL polaridad L'), { target: { value: '3' } });
    fireEvent.click(confirmButton());
    await within(historial).findByText('#7');
    expect(h.histories().length).toBeGreaterThan(1);
    const rows = within(historial).getAllByRole('row').slice(1);
    expect(rows.map(row => cellsOf(row)[0])).toEqual(['#7', '#6']);
    expect(cellsOf(rows[0])[6]).toBe(north.name);
  });

  it('keeps the typed document when the history read fails', async () => {
    const h = harness({ history: () => errorReply('service_unavailable', 503) });
    await ready(h);
    const documento = documentPanel();
    const historial = historyPanel();
    fireEvent.click(polarityButton('TOYO', 'NS40ZL', 'L'));
    fireEvent.change(within(documento).getByLabelText('Nota (opcional)'), { target: { value: 'Remito 0002' } });
    expect(await within(historial).findByRole('alert')).toHaveTextContent('No se pudo consultar el historial de ingresos');
    expect(within(documento).getByLabelText('Cantidad de TOYO · NS40ZL polaridad L')).toHaveValue(1);
    expect(within(documento).getByLabelText('Nota (opcional)')).toHaveValue('Remito 0002');
    expect(totalFor('Unidades')).toHaveTextContent(/Unidades\s*1/);
  });
});

describe('stock counter-entry', () => {
  const rowsWithAction = () => [
    historyRow(9, 'Remito 0003', 1, 4, null, north),
    historyRow(8, 'Remito 0002', 2, 18, 10, north),
    historyRow(7, '', 1, -3, null, north),
    historyRow(6, 'Remito 0002', 2, 18),
  ];
  const reasonBox = (dialog: HTMLElement) => within(dialog).getByLabelText('Motivo del contra-asiento') as HTMLTextAreaElement;
  const confirm = (dialog: HTMLElement) => within(dialog).getByRole('button', { name: 'Confirmar contra-asiento' });

  it('offers the action only on rows that have no counter-entry yet', async () => {
    const h = harness({ history: () => historyReply(rowsWithAction()) });
    render(<StockEntry csrf={csrf} fetcher={h.fetcher} />);
    await chooseSupplier();
    await within(historyPanel()).findByText('#6');
    expect(within(historyPanel()).getAllByRole('button', { name: /^Anular ingreso/ }).map(button => button.getAttribute('aria-label')))
      .toEqual(['Anular ingreso #9', 'Anular ingreso #6']);
    expect(within(historyPanel()).queryByRole('button', { name: 'Anular ingreso #8' })).not.toBeInTheDocument();
    // A counter-entry (negative units) is never reversible.
    expect(within(historyPanel()).queryByRole('button', { name: 'Anular ingreso #7' })).not.toBeInTheDocument();
  });

  it('opens an accessible dialog that explains the immutable original and moves focus', async () => {
    const h = harness({ history: () => historyReply(rowsWithAction()) });
    render(<StockEntry csrf={csrf} fetcher={h.fetcher} />);
    await chooseSupplier();
    await within(historyPanel()).findByText('#6');
    const dialog = await openReversal(historyPanel());
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByText(/documento nuevo con las mismas líneas en negativo/)).toBeInTheDocument();
    expect(within(dialog).getByText(/El original nunca cambia/)).toBeInTheDocument();
    // The supplier is inherited: the reversal never asks for it again.
    expect(within(dialog).getByText(/hereda el proveedor del original/)).toBeInTheDocument();
    expect(within(dialog).queryByLabelText(/Proveedor/)).not.toBeInTheDocument();
    expect(within(dialog).getByText(/#6/)).toBeInTheDocument();
    expect(reasonBox(dialog)).toHaveFocus();
    expect(reasonBox(dialog)).toHaveAttribute('maxlength', '500');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(within(historyPanel()).getByRole('button', { name: 'Anular ingreso #6' })).toHaveFocus();
  });

  it('refuses a blank reason without sending anything', async () => {
    const h = harness({ history: () => historyReply(rowsWithAction()) });
    render(<StockEntry csrf={csrf} fetcher={h.fetcher} />);
    await chooseSupplier();
    await within(historyPanel()).findByText('#6');
    const dialog = await openReversal(historyPanel());
    fireEvent.change(reasonBox(dialog), { target: { value: '   ' } });
    fireEvent.click(confirm(dialog));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('El motivo es obligatorio');
    expect(h.reversals()).toHaveLength(0);
  });

  it('sends only the operation key and the reason to the frozen path', async () => {
    let reversed = false;
    const h = harness({
      history: () => historyReply(reversed
        ? [historyRow(10, '', 2, -18, null, north), historyRow(6, 'Remito 0002', 2, 18, 10)]
        : [historyRow(6, 'Remito 0002', 2, 18)]),
      reverse: () => { reversed = true; return counterReply(); },
    });
    render(<StockEntry csrf={csrf} fetcher={h.fetcher} />);
    await chooseSupplier();
    await within(historyPanel()).findByText('#6');
    const dialog = await openReversal(historyPanel());
    fireEvent.change(reasonBox(dialog), { target: { value: '  error de carga  ' } });
    fireEvent.click(confirm(dialog));
    await waitFor(() => expect(h.reversals()).toHaveLength(1));
    const post = h.reversals()[0];
    expect(post.url).toBe('/api/stock-entries/6/reverse');
    expect(post.init).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store' });
    expect(post.init.headers).toMatchObject({ 'Content-Type': 'application/json', 'X-CSRF-Token': csrf });
    // Neither the supplier nor anything else travels: the server inherits it.
    expect(JSON.parse(String(post.init.body))).toEqual({
      operation_key: expect.stringMatching(/^[A-Za-z0-9_-]{16,128}$/), reason: 'error de carga',
    });
    // The dialog closes, the history is refreshed and the result is announced.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await within(historyPanel()).findByText(/Contra-asiento registrado: documento 10 · -18 unidades/)).toBeInTheDocument();
    expect(h.histories().length).toBeGreaterThan(1);
    const rows = within(historyPanel()).getAllByRole('row').slice(1);
    expect(rows.map(row => within(row).getAllByRole('cell')[0].textContent)).toEqual(['#10', '#6']);
    expect(within(historyPanel()).queryByRole('button', { name: 'Anular ingreso #6' })).not.toBeInTheDocument();
  });

  it('reverses a historical document that has no supplier', async () => {
    const h = harness({ history: () => historyReply([historyRow(6, 'Remito 0002', 2, 18)]) });
    render(<StockEntry csrf={csrf} fetcher={h.fetcher} />);
    await chooseSupplier();
    await within(historyPanel()).findByText('#6');
    const dialog = await openReversal(historyPanel());
    fireEvent.change(reasonBox(dialog), { target: { value: 'error de carga' } });
    fireEvent.click(confirm(dialog));
    await waitFor(() => expect(h.reversals()).toHaveLength(1));
    expect(JSON.parse(String(h.reversals()[0].init.body))).toEqual({
      operation_key: expect.stringMatching(/^[A-Za-z0-9_-]{16,128}$/), reason: 'error de carga',
    });
  });

  it('keeps the typed reason and the dialog open when the stock no longer covers the reversal', async () => {
    const h = harness({ history: () => historyReply(rowsWithAction()),
      reverse: () => errorReply('insufficient_stock', 409) });
    render(<StockEntry csrf={csrf} fetcher={h.fetcher} />);
    await chooseSupplier();
    await within(historyPanel()).findByText('#6');
    const dialog = await openReversal(historyPanel());
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
    await chooseSupplier();
    await within(historyPanel()).findByText('#6');
    const dialog = await openReversal(historyPanel());
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
    await chooseSupplier();
    await within(historyPanel()).findByText('#6');
    const dialog = await openReversal(historyPanel());
    fireEvent.change(reasonBox(dialog), { target: { value: 'error de carga' } });
    fireEvent.click(confirm(dialog));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await within(historyPanel()).findByText(stockEntryReversalErrorMessages.decision_conflict)).toBeInTheDocument();
    await within(historyPanel()).findByText('#10');
  });

  it('disables the action while the reversal is in flight', async () => {
    let resolve!: (value: Response) => void;
    const h = harness({ history: () => historyReply(rowsWithAction()),
      reverse: () => new Promise<Response>(yes => { resolve = yes; }) });
    render(<StockEntry csrf={csrf} fetcher={h.fetcher} />);
    await chooseSupplier();
    await within(historyPanel()).findByText('#6');
    const dialog = await openReversal(historyPanel());
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
  // Each listed document has its own detail, so a stale reply would be visible.
  const defaultDetail = (id: string) => id === '9'
    ? detailReply({ id: 9, note: 'Remito 0003', lines: [detailLineOf(4, '95D31L', 4, '90')], total_units: 4 })
    : id === '7'
      ? detailReply({ id: 7, note: '', reverses_entry_id: 6, reason: 'error de carga',
        lines: [detailLineOf(4, 'NS40ZL', -3, '35'), detailLineOf(9, 'NS60L', -15)], total_units: -18 })
      : detailReply();
  const rowsWithDetail = () => [historyRow(9, 'Remito 0003', 1, 4, null, north), historyRow(7, '', 2, -18), historyRow(6, 'Remito 0002', 2, 18)];
  const detailButton = (id: number) => within(historyPanel()).getByRole('button', { name: `Ver detalle del ingreso #${id}` });
  const openDetail = async (id: number) => {
    fireEvent.click(detailButton(id));
    return screen.getByRole('dialog', { name: `Detalle del ingreso #${id}` });
  };

  it('offers the detail action on every row, including a reversed document', async () => {
    const h = harness({ history: () => historyReply([historyRow(9, 'Remito 0003', 1, 4),
      historyRow(7, 'Remito 0002', 2, 18, 10), historyRow(6, '', 3, 6)]) });
    render(<StockEntry csrf={csrf} fetcher={h.fetcher} />);
    await chooseSupplier();
    await within(historyPanel()).findByText('#6');
    expect(within(historyPanel()).getAllByRole('button', { name: /^Ver detalle del ingreso/ })
      .map(button => button.getAttribute('aria-label')))
      .toEqual(['Ver detalle del ingreso #9', 'Ver detalle del ingreso #7', 'Ver detalle del ingreso #6']);
  });

  it('opens the clicked document with exactly the units that entered', async () => {
    const h = harness({ history: () => historyReply(rowsWithDetail()), detail: defaultDetail });
    render(<StockEntry csrf={csrf} fetcher={h.fetcher} />);
    await chooseSupplier();
    await within(historyPanel()).findByText('#6');
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

  it('shows the supplier of the document and sin proveedor for a historical one', async () => {
    const h = harness({ history: () => historyReply([historyRow(9, 'Remito 0003', 1, 4, null, north),
      historyRow(6, 'Remito 0002', 2, 18)]),
      detail: id => id === '9' ? defaultDetail(id) : detailReply({ supplier: null }) });
    render(<StockEntry csrf={csrf} fetcher={h.fetcher} />);
    await chooseSupplier();
    await within(historyPanel()).findByText('#9');
    const withSupplier = await openDetail(9);
    await within(withSupplier).findByText('TOYO · 95D31L');
    expect(within(withSupplier).getByText('Proveedor')).toBeInTheDocument();
    expect(within(withSupplier).getByText(north.name)).toBeInTheDocument();
    fireEvent.keyDown(withSupplier, { key: 'Escape' });
    const historical = await openDetail(6);
    await within(historical).findByText('TOYO · NS60L');
    expect(within(historical).getByText('sin proveedor')).toBeInTheDocument();
    fireEvent.click(within(historical).getByRole('button', { name: 'Volver' }));
  });

  it('reads a product document back with its name and detail and no battery attribute', async () => {
    const h = harness({
      history: () => historyReply([historyRow(8, 'Remito 0004', 1, 20), historyRow(6, 'Remito 0002', 2, 18)]),
      detail: id => id === '8'
        ? detailReply({ id: 8, note: 'Remito 0004', lines: [productLineOf(210, 'Agua acidulada', 'volumen en L: 5 L', 20)], total_units: 20 })
        : detailReply(),
    });
    render(<StockEntry csrf={csrf} fetcher={h.fetcher} />);
    await chooseSupplier();
    await within(historyPanel()).findByText('#8');
    const dialog = await openDetail(8);
    await within(dialog).findByText('Agua acidulada');
    const lines = within(dialog).getAllByRole('row').slice(1)
      .map(row => within(row).getAllByRole('cell').map(cell => cell.textContent));
    expect(lines).toEqual([['Agua acidulada', 'volumen en L: 5 L', '20']]);
    expect(within(dialog).queryByText(/TOYO/)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/Ah/)).not.toBeInTheDocument();
    expect(within(dialog).getByText('Unidades del documento: 20')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Volver' }));
  });

  it('shows the motive and the original document of a counter-entry with negative units', async () => {
    const h = harness({ history: () => historyReply(rowsWithDetail()), detail: defaultDetail });
    render(<StockEntry csrf={csrf} fetcher={h.fetcher} />);
    await chooseSupplier();
    await within(historyPanel()).findByText('#7');
    const dialog = await openDetail(7);
    await within(dialog).findByText(/error de carga/);
    expect(within(dialog).getByText('Contra-asiento del documento')).toBeInTheDocument();
    expect(within(dialog).getByText('#6', { selector: 'dd' })).toBeInTheDocument();
    expect(within(dialog).getByText('Motivo')).toBeInTheDocument();
    // The counter-entry repeats the supplier of its original.
    expect(within(dialog).getByText(north.name)).toBeInTheDocument();
    const quantities = within(dialog).getAllByRole('row').slice(1).map(row => within(row).getAllByRole('cell')[3].textContent);
    expect(quantities).toEqual(['-3', '-15']);
    expect(within(dialog).getByText('Unidades del documento: -18')).toBeInTheDocument();
    expect(within(dialog).queryByText('Nota')).not.toBeInTheDocument();
  });

  it('never shows the previous document after closing and opening another row', async () => {
    const h = harness({ history: () => historyReply(rowsWithDetail()), detail: defaultDetail });
    render(<StockEntry csrf={csrf} fetcher={h.fetcher} />);
    await chooseSupplier();
    await within(historyPanel()).findByText('#6');
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
    await chooseSupplier();
    await within(historyPanel()).findByText('#6');
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
    await chooseSupplier();
    await within(historyPanel()).findByText('#6');
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
    await chooseSupplier();
    await within(historyPanel()).findByText('#6');
    const dialog = await openDetail(6);
    await within(dialog).findByText('TOYO · NS60L');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    fireEvent.click(within(historyPanel()).getByRole('button', { name: 'Anular ingreso #6' }));
    const reversal = screen.getByRole('dialog', { name: 'Registrar contra-asiento' });
    fireEvent.change(within(reversal).getByLabelText('Motivo del contra-asiento'), { target: { value: 'error de carga' } });
    fireEvent.click(within(reversal).getByRole('button', { name: 'Confirmar contra-asiento' }));
    await waitFor(() => expect(h.reversals()).toHaveLength(1));
    expect(h.reversals()[0].url).toBe('/api/stock-entries/6/reverse');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});

describe('stock entry other products', () => {
  const productReply = (search: string) => new Response(
    catalogPage(search === 'nada' ? []
      : search === 'x12' ? [productRow(211, 98, 'Guantes de nitrilo', 'presentación: pack x12')]
        : [productRow(210, 97, 'Agua acidulada', 'volumen en L: 5 L'),
          productRow(211, 98, 'Guantes de nitrilo', 'presentación: pack x12')]),
    { status: 200, headers: { 'Content-Type': 'application/json' } });

  it('asks for the kind before reading anything and offers only the two kinds', async () => {
    const h = harness({ catalog: search => productReply(search) });
    render(<StockEntry csrf={csrf} fetcher={h.fetcher} />);
    await chooseSupplier();
    const control = kindControl() as HTMLElement;
    expect(within(control).getAllByRole('button').map(button => button.getAttribute('aria-pressed')))
      .toEqual(['false', 'false']);
    // Nothing has been read and no document exists until the kind is chosen.
    expect(screen.queryByRole('region', { name: 'Catálogo' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Documento' })).not.toBeInTheDocument();
    expect(h.catalogs()).toHaveLength(0);
    // The chosen kind is what the picker reads and what the document declares.
    chooseKind('Otros productos');
    expect(within(control).getByRole('button', { name: 'Otros productos' })).toHaveAttribute('aria-pressed', 'true');
    expect(await within(catalogPanel()).findByText('Agua acidulada')).toBeInTheDocument();
    expect(h.catalogs()[0].url).toBe('/api/suppliers/3/catalog?kind=other');
    expect(within(documentPanel()).getByRole('note', { name: 'Tipo del documento' })).toHaveTextContent('Otros productos');
  });

  it('collects every other product in the single Otros productos group', async () => {
    const h = harness({ catalog: search => productReply(search) });
    render(<StockEntry csrf={csrf} fetcher={h.fetcher} />);
    await chooseSupplier();
    chooseKind('Otros productos');
    const catalogo = catalogPanel();
    const head = await within(catalogo).findByRole('button', { name: /^Otros productos/ });
    expect(head).toHaveAttribute('aria-expanded', 'true');
    expect(head).toHaveTextContent('2 productos');
    // A product of another kind is added by its own name, with no polarity at all.
    expect(within(catalogo).getAllByRole('columnheader').map(column => column.textContent))
      .toEqual(['Producto', 'Agregar', 'En el documento']);
    expect(within(catalogo).getByText('volumen en L: 5 L')).toBeInTheDocument();
    expect(within(catalogo).queryByRole('button', { name: /polaridad/ })).not.toBeInTheDocument();
    expect(within(catalogo).getAllByRole('button', { name: /^Agregar / })).toHaveLength(2);
  });

  it('adds a product line with its name and detail and sends only a variant and a quantity', async () => {
    const h = harness({ catalog: search => productReply(search) });
    render(<StockEntry csrf={csrf} fetcher={h.fetcher} />);
    await chooseSupplier();
    chooseKind('Otros productos');
    const documento = documentPanel();
    await within(catalogPanel()).findByRole('button', { name: 'Agregar Agua acidulada' });
    fireEvent.click(addProduct('Agua acidulada'));
    expect(within(documento).getByLabelText('Cantidad de Agua acidulada')).toHaveValue(1);
    expect(within(documento).getByText('Agua acidulada')).toBeInTheDocument();
    expect(within(documento).getByText('volumen en L: 5 L')).toBeInTheDocument();
    // Nothing battery-specific is invented for a product line.
    expect(within(documento).queryByText(/Ah/)).not.toBeInTheDocument();
    expect(within(documento).queryByText(/Polaridad/)).not.toBeInTheDocument();
    fireEvent.change(within(documento).getByLabelText('Cantidad de Agua acidulada'), { target: { value: '20' } });
    fireEvent.click(confirmButton());
    await waitFor(() => expect(h.posts()).toHaveLength(1));
    expect(JSON.parse(String(h.posts()[0].init.body))).toEqual({
      operation_key: expect.stringMatching(/^[A-Za-z0-9_-]{16,128}$/), supplier_id: 3, lines: [{ variant_id: 210, quantity: 20 }],
    });
  });

  it('asks for confirmation and discards the draft when the kind changes with a line', async () => {
    const h = harness({ catalog: (search, kind) => kind === 'other' ? productReply(search) : catalogReply(search) });
    await ready(h);
    const documento = documentPanel();
    fireEvent.click(polarityButton('TOYO', 'NS40ZL', 'L'));
    fireEvent.change(within(documento).getByLabelText('Nota (opcional)'), { target: { value: 'Remito 0002' } });
    chooseKind('Otros productos');
    const dialog = screen.getByRole('dialog', { name: 'Cambiar el tipo del ingreso' });
    expect(within(dialog).getByText(/nunca mezcla los dos tipos/)).toBeInTheDocument();
    expect(within(dialog).getByText(/no se convierten ni se migran/)).toBeInTheDocument();
    // Nothing changed while the confirmation is open.
    expect(h.catalogs().at(-1)?.url).toContain('kind=battery');
    expect(within(documento).getByLabelText('Cantidad de TOYO · NS40ZL polaridad L')).toHaveValue(1);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(within(documento).getByLabelText('Cantidad de TOYO · NS40ZL polaridad L')).toHaveValue(1);
    expect(within(documento).getByLabelText('Nota (opcional)')).toHaveValue('Remito 0002');
    // The deliberate change discards the draft of the other kind.
    chooseKind('Otros productos');
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Cambiar el tipo del ingreso' }))
      .getByRole('button', { name: 'Descartar borrador y cambiar tipo' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await within(catalogPanel()).findByRole('button', { name: 'Agregar Agua acidulada' });
    expect(h.catalogs().at(-1)?.url).toContain('kind=other');
    expect(within(documento).queryByLabelText('Cantidad de TOYO · NS40ZL polaridad L')).not.toBeInTheDocument();
    expect(within(documento).getByText('Todavía no agregaste líneas.')).toBeInTheDocument();
    expect(within(documento).getByLabelText('Nota (opcional)')).toHaveValue('');
    expect(within(documento).getByRole('note', { name: 'Tipo del documento' })).toHaveTextContent('Otros productos');
  });
});
