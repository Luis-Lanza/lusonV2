import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Purchases from './Purchases';

const csrf = 'c'.repeat(43);
const json = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'Content-Type': 'application/json' } });

const models = JSON.stringify({ models: ['NS40ZL', 'NS60ZL'] });
const materials = JSON.stringify({ materials: [{ id: 1, name: 'Cobre' }, { id: 2, name: 'Aluminio' }] });
const lastPrices = JSON.stringify({
  models: [{ model: 'NS60ZL', unit_price: '25000.00', purchased_at: '2026-11-10T14:02:00Z' }],
  materials: [{ material_id: 1, price_per_kg: '8000.00', purchased_at: '2026-11-10T14:02:00Z' }],
});
// Two used models and two materials so each tab carries a real participation split.
const received = JSON.stringify({
  used: [
    { model: 'NS40ZL', quantity: 5, value: '100000.00' },
    { model: 'NS60ZL', quantity: 12, value: '300000.00' },
  ],
  scrap: [
    { material_id: 1, name: 'Cobre', kg: '120.500', value: '964000.00' },
    { material_id: 2, name: 'Aluminio', kg: '84.200', value: '252600.00' },
  ],
});
const historyRow = {
  id: 7, created_at: '2026-11-11T18:20:00Z', total: '25000.00',
  reverses_purchase_id: null, reversed_by: null, used_units: 1, scrap_lines: 0,
};
// The selector the server publishes: pending, the closed settlements newest first, the whole
// history. A period is one settlement, never a calendar month.
const pendingPeriod = { kind: 'pending', closing_id: null, from: null, to: null, label: 'Pendiente' };
const closedPeriod = (id: number, from: string, to: string) => ({ kind: 'settlement', closing_id: id,
  from, to, label: `Rendición #${id}` });
const latestSettlement = closedPeriod(7, '2026-10-23T10:00:00Z', '2026-11-12T18:20:00Z');
const olderSettlement = closedPeriod(3, '2026-09-25T10:00:00Z', '2026-10-23T10:00:00Z');
const allPeriod = { kind: 'all', closing_id: null, from: null, to: null, label: 'Todo el historial' };
const periods = [pendingPeriod, latestSettlement, olderSettlement, allPeriod];
// The reading the human reported: twelve bought, ten counted at the closure, so two still sit in
// the branch; the two keys that were delivered whole are not rows of the pending balance.
const pendingBalance = {
  used: [{ model: 'NS40ZL', bought: '5', delivered: '5', balance: '0' },
    { model: 'NS60ZL', bought: '12', delivered: '10', balance: '2' }],
  scrap: [{ material_id: 1, bought: '120.500', delivered: '118.500', balance: '2.000' },
    { material_id: 2, bought: '84.200', delivered: '84.200', balance: '0.000' }],
};
// A settlement that counted everything: the branch reads zero and the documents stay listed.
const deliveredBalance = {
  used: [{ model: 'NS60ZL', bought: '12', delivered: '12', balance: '0' }],
  scrap: [{ material_id: 1, bought: '120.500', delivered: '120.500', balance: '0.000' }],
};
// The three header numbers the server publishes for each period. The pending period is the balance's
// own sum and states no money; a window states the money that left the cash box.
const pendingTotals = { money: null, used_units: '2', scrap_kg: '2.000' };
const deliveredTotals = { money: null, used_units: '0', scrap_kg: '0.000' };
const historyTotals = { money: '1616600.00', used_units: '17', scrap_kg: '204.700' };
const settlementTotals = { money: '50000.00', used_units: '2', scrap_kg: '3.000' };

interface ListingQuery { readonly period: string; readonly page: number; readonly page_size: number }
const listingBody = (query: ListingQuery, overrides: Record<string, unknown> = {}) => JSON.stringify({
  page: query.page, page_size: query.page_size, total_purchases: 1, purchases: [historyRow],
  periods, period: pendingPeriod, totals: pendingTotals, balance: pendingBalance, ...overrides,
});
const documentBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  id: 7, location_id: 2, note: 'Remito 0002', total: '25000.00', paid_cash: '25000.00',
  paid_transfer: '0.00', created_by_account_id: 3, created_at: '2026-11-11T18:20:00Z',
  reverses_purchase_id: null, reversed_by: null, reason: '',
  used_lines: [{ model: 'NS60ZL', quantity: 1, unit_price: '25000.00', amount: '25000.00' }],
  scrap_lines: [],
  ...overrides,
});
const reversalBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  id: 8, location_id: 2, note: 'Remito 0002', total: '-25000.00', paid_cash: '-25000.00',
  paid_transfer: '0.00', created_by_account_id: 3, created_at: '2026-11-12T09:00:00Z',
  reverses_purchase_id: 7, reversed_by: null, reason: 'pesaje mal tipeado',
  used_lines: [{ model: 'NS60ZL', quantity: -1, unit_price: '25000.00', amount: '-25000.00' }],
  scrap_lines: [],
  ...overrides,
});

type Reply = () => Response;
interface Routes {
  models: Reply;
  materials: Reply;
  lastPrices: Reply;
  received: Reply;
  listing: (query: ListingQuery) => Response;
  detail: Reply;
  create: Reply;
  reverse: Reply;
}

/** The whole history and a closed settlement publish the same documents but own their period. */
function listingFor(query: ListingQuery): Response {
  if (query.period === 'all') return json(listingBody(query, { period: allPeriod, totals: historyTotals, balance: null }));
  if (query.period === '7') return json(listingBody(query, { period: latestSettlement, totals: settlementTotals, balance: null }));
  return json(listingBody(query));
}

function setup(overrides: Partial<Routes> = {}) {
  const routes: Routes = {
    models: () => json(models), materials: () => json(materials), lastPrices: () => json(lastPrices),
    received: () => json(received), listing: listingFor, detail: () => json(documentBody()),
    create: () => json(documentBody(), 201), reverse: () => json(reversalBody(), 201), ...overrides,
  };
  const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    if (method === 'POST' && url === '/api/purchases') return routes.create();
    if (method === 'POST' && url.endsWith('/reverse')) return routes.reverse();
    if (url === '/api/purchases/models') return routes.models();
    if (url === '/api/purchases/materials') return routes.materials();
    if (url === '/api/purchases/last-prices') return routes.lastPrices();
    if (url === '/api/purchases/received') return routes.received();
    if (url.startsWith('/api/purchases?page=')) {
      const parameters = new URL(url, 'http://test').searchParams;
      return routes.listing({ period: parameters.get('period') ?? '',
        page: Number(parameters.get('page')), page_size: Number(parameters.get('page_size')) });
    }
    if (/^\/api\/purchases\/\d+$/.test(url)) return routes.detail();
    throw new Error('Unexpected mocked URL: ' + url);
  });
  render(<Purchases csrf={csrf} branch="Sucursal A" fetcher={fetch} />);
  const listings = () => fetch.mock.calls.map(([url]) => String(url)).filter(url => url.startsWith('/api/purchases?page='));
  return { fetch, listings };
}

/** Chooses one period of the selector the server published. */
async function selectPeriod(token: string) {
  const select = await screen.findByLabelText('Período') as HTMLSelectElement;
  await waitFor(() => expect(within(select).getAllByRole('option').length).toBeGreaterThan(1));
  fireEvent.change(select, { target: { value: token } });
  await waitFor(() => expect(select.value).toBe(token));
}

async function periodHero() {
  return (await screen.findByRole('heading', { name: 'Resumen del período' })).closest('section')!;
}

async function openDraft() {
  fireEvent.click(await screen.findByRole('button', { name: 'Registrar compra' }));
  return screen.findByRole('dialog', { name: 'Nueva compra' });
}

async function openDocuments() {
  fireEvent.click(await screen.findByRole('tab', { name: /Documentos/ }));
  return screen.findByRole('tabpanel');
}

function addUsed(dialog: HTMLElement, model: string, quantity: string, price: string) {
  fireEvent.change(within(dialog).getByLabelText('Modelo'), { target: { value: model } });
  fireEvent.change(within(dialog).getByLabelText('Cantidad'), { target: { value: quantity } });
  fireEvent.change(within(dialog).getByLabelText('Precio por batería (Bs)'), { target: { value: price } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Agregar batería' }));
}

describe('purchases section', () => {
  it('keeps the accumulated recibido band under the whole history and never calls it available stock', async () => {
    setup();
    await screen.findByRole('heading', { name: 'Compras' });
    await selectPeriod('all');
    const hero = await periodHero();
    const band = hero.querySelector('.purchases-metrics') as HTMLElement;
    // Total del recibido (400.000 usadas + 1.216.600 chatarra), units and kilograms.
    expect(await within(band).findByText('Bs 1.616.600,00')).toBeInTheDocument();
    expect(within(band).getByText('17 u.')).toBeInTheDocument();
    expect(within(band).getByText('204,700 kg')).toBeInTheDocument();
    expect(within(band).getByText('no se revenden')).toBeInTheDocument();
    expect(within(band).getByText(/lo que salió de caja/)).toBeInTheDocument();
    expect(within(band).getAllByText(/recibido/i).length).toBeGreaterThan(0);
    // The whole history is its own period: the band never claims a number without saying so.
    expect(within(band).queryByText(/acumulado/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/disponible/i)).not.toBeInTheDocument();
    // The hero carries no heading paragraph and no separate action row.
    expect(within(hero).queryByText(/se calcula con los documentos/i)).not.toBeInTheDocument();
  });

  it('sits the tabs and the primary action on one row, each tab with its own total', async () => {
    setup();
    await selectPeriod('all');
    const hero = await periodHero();
    const tabs = await within(hero).findByRole('tablist', { name: 'Materiales y documentos del período' });
    const used = within(tabs).getByRole('tab', { name: /Baterías usadas/ });
    const scrap = within(tabs).getByRole('tab', { name: /Chatarra/ });
    await waitFor(() => expect(used).toHaveAccessibleName(/17 u\. · Bs 400\.000,00/));
    expect(scrap).toHaveAccessibleName(/204,700 kg · Bs 1\.216\.600,00/);
    expect(within(tabs).getByRole('tab', { name: /Documentos/ })).toHaveAccessibleName(/Documentos\s+1$/);
    expect(used).toHaveAttribute('aria-selected', 'true');
    expect(scrap).toHaveAttribute('aria-selected', 'false');
    // The primary action shares the tabs row, not a row of its own.
    const trigger = within(hero).getByRole('button', { name: 'Registrar compra' });
    expect(tabs.parentElement).toContainElement(trigger);
    expect(trigger.parentElement).toBe(tabs.parentElement);
  });

  it('bars the participation of every used model in the selected tab', async () => {
    setup();
    await selectPeriod('all');
    const panel = await screen.findByRole('tabpanel');
    await within(panel).findByText('NS60ZL');
    const big = within(panel).getByText('NS60ZL').closest('tr')!;
    const small = within(panel).getByText('NS40ZL').closest('tr')!;
    // 300.000 of 400.000 and 100.000 of 400.000.
    expect(big.querySelector('.purchases-bar i')).toHaveStyle({ width: '75%' });
    expect(within(big).getByText('75 %')).toBeInTheDocument();
    expect(small.querySelector('.purchases-bar i')).toHaveStyle({ width: '25%' });
    expect(within(small).getByText('25 %')).toBeInTheDocument();
    expect(within(small).getByText('unidades')).toBeInTheDocument();
    // The tabular totals row closes the table.
    expect(within(panel).getByText('17 unidades')).toBeInTheDocument();
    expect(within(panel).getByText('100 %')).toBeInTheDocument();
    // The honest copy stays, and the figures are received, never available stock.
    expect(panel.querySelector('.purchases-note')).toHaveTextContent(/Es recibido/);
    expect(screen.queryByText(/disponible/i)).not.toBeInTheDocument();
  });

  it('shows the scrap tab by weight and value without a participation column', async () => {
    setup();
    await selectPeriod('all');
    await periodHero();
    fireEvent.click(screen.getByRole('tab', { name: /Chatarra/ }));
    const panel = await screen.findByRole('tabpanel');
    const row = (await within(panel).findByText('Cobre')).closest('tr')!;
    expect(within(row).getByText('Bs 964.000,00')).toBeInTheDocument();
    expect(within(row).getByText('120,500 kg')).toBeInTheDocument();
    expect(panel.querySelector('.purchases-bar')).toBeNull();
  });

  it('lists the documents of the month in their own tab with their state', async () => {
    setup();
    const panel = await openDocuments();
    const row = (await within(panel).findByText('#7')).closest('tr')!;
    expect(within(row).getByText('1 usada')).toBeInTheDocument();
    expect(within(row).getByText('Vigente')).toBeInTheDocument();
    expect(within(row).getByText('Bs 25.000,00')).toBeInTheDocument();
  });

  it('keeps the document closed on load and opens it over an inert page only from the trigger', async () => {
    setup();
    const trigger = await screen.findByRole('button', { name: 'Registrar compra' });
    await periodHero();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger.closest('[inert]')).toBeNull();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: 'Nueva compra' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    // The page behind the document is attenuated and unreachable.
    expect(trigger.closest('[inert]')).not.toBeNull();
    expect(within(dialog).getByLabelText('Modelo')).toHaveFocus();
  });

  it('closes with Escape and with Cancelar, returning focus to the trigger', async () => {
    setup();
    const trigger = await screen.findByRole('button', { name: 'Registrar compra' });
    fireEvent.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: 'Nueva compra' });
    fireEvent.keyDown(within(dialog).getByLabelText('Modelo'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
    expect(trigger.closest('[inert]')).toBeNull();

    fireEvent.click(trigger);
    const again = await screen.findByRole('dialog', { name: 'Nueva compra' });
    fireEvent.click(within(again).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it('lays every add-line field as label, control and hint inside one shared row', async () => {
    setup();
    const dialog = await openDraft();
    // The style pins the three rows of the row's grid through this shape: the fields
    // are direct children of the row and each one carries exactly a label, a control
    // and a hint child. A wrapper or a missing hint would break the shared rows.
    const row = within(dialog).getByLabelText('Modelo').closest('.purchase-line') as HTMLElement;
    const fields = [...row.children].filter(child => child.classList.contains('purchase-field'));
    expect(fields).toHaveLength(4);
    for (const field of fields) expect(field.children).toHaveLength(3);
    expect(fields[0].children[0].tagName).toBe('LABEL');
    expect(fields[0].children[1].tagName).toBe('INPUT');
    expect(fields[0].children[2]).toHaveClass('stock-hint');
    // Importe labels with a plain span and its control is the live amount, not an input.
    expect(fields[3].children[0].tagName).toBe('SPAN');
    expect(fields[3].children[1]).toHaveClass('purchase-amount');
    expect(fields[3].children[2]).toHaveClass('stock-hint');
    // The action shares the row instead of sitting under it.
    const action = within(row).getByRole('button', { name: 'Agregar batería' });
    expect(action.parentElement?.parentElement).toBe(row);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Chatarra por kg' }));
    const scrapRow = within(dialog).getByLabelText('Material').closest('.purchase-line') as HTMLElement;
    const scrapFields = [...scrapRow.children].filter(child => child.classList.contains('purchase-field'));
    expect(scrapFields).toHaveLength(4);
    for (const field of scrapFields) expect(field.children).toHaveLength(3);
    expect(scrapFields[2].children[1].tagName).toBe('INPUT');
    expect(within(scrapRow).getByRole('button', { name: 'Agregar material' }).parentElement?.parentElement)
      .toBe(scrapRow);
  });

  it('edits a used draft, anchors the last paid price and admits a model typed outside the catalogue', async () => {
    setup();
    const dialog = await openDraft();
    fireEvent.change(within(dialog).getByLabelText('Modelo'), { target: { value: 'NS60ZL' } });
    expect(await within(dialog).findByText('Última: Bs 25.000,00')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Cantidad'), { target: { value: '2' } });
    fireEvent.change(within(dialog).getByLabelText('Precio por batería (Bs)'), { target: { value: '25.000,00' } });
    // The line's importe is computed as it is typed.
    expect(within(dialog).getByText('Bs 50.000,00')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Agregar batería' }));
    expect(within(dialog).getAllByText('Bs 50.000,00').length).toBeGreaterThan(0);
    // The draft line stays editable in place.
    fireEvent.change(within(dialog).getByLabelText('Cantidad de NS60ZL'), { target: { value: '3' } });
    expect(within(dialog).getAllByText('Bs 75.000,00').length).toBeGreaterThan(0);
    // A code that is not in GET /api/purchases/models can still be bought.
    addUsed(dialog, 'zz99', '1', '1.000,00');
    expect(within(dialog).getByText('ZZ99')).toBeInTheDocument();
    expect(within(dialog).getAllByText('Bs 76.000,00').length).toBeGreaterThan(0);
  });

  it('refuses a settlement that does not equal the total', async () => {
    setup();
    const dialog = await openDraft();
    addUsed(dialog, 'NS60ZL', '1', '25.000,00');
    const submit = within(dialog).getByRole('button', { name: 'Registrar compra' });
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Efectivo del fondo de compras'), { target: { value: '20.000,00' } });
    expect(within(dialog).getByText(/Faltan Bs 5.000,00/)).toBeInTheDocument();
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Efectivo del fondo de compras'), { target: { value: '26.000,00' } });
    expect(within(dialog).getByText(/Sobran Bs 1.000,00/)).toBeInTheDocument();
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Efectivo del fondo de compras'), { target: { value: '25.000,00' } });
    expect(within(dialog).getByText(/cubre el total/i)).toBeInTheDocument();
    expect(submit).toBeEnabled();
  });

  it('pays a purchase in cash from the purchase fund and never posts a transfer amount', async () => {
    const { fetch } = setup({ create: () => json(documentBody({ note: '' }), 201) });
    const dialog = await openDraft();
    // The fund is cash: the document offers no transfer amount to fill in, and it says where
    // the money comes from.
    expect(within(dialog).queryByLabelText(/transferencia/i)).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText('Efectivo del fondo de compras')).toBeInTheDocument();
    expect(within(dialog).getAllByText(/fondo de compras/).length).toBeGreaterThan(0);
    addUsed(dialog, 'NS60ZL', '1', '25.000,00');
    fireEvent.change(within(dialog).getByLabelText('Efectivo del fondo de compras'), { target: { value: '25.000,00' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Registrar compra' }));
    await screen.findByRole('dialog', { name: 'Comprobante de compra #7' });
    const body = JSON.parse(String(fetch.mock.calls
      .find(([url]) => String(url) === '/api/purchases')?.[1]?.body));
    expect(body.paid_cash).toBe('25000.00');
    expect(body.paid_transfer).toBe('0.00');
    // The total is derived from what is actually paid, so the two sides still close.
    expect(body.used_lines).toEqual([{ model: 'NS60ZL', quantity: 1, unit_price: '25000.00' }]);
  });

  it('records the purchase and shows a printable receipt', async () => {
    const { fetch } = setup({ create: () => json(documentBody({ note: '' }), 201) });
    const dialog = await openDraft();
    addUsed(dialog, 'NS60ZL', '1', '25.000,00');
    fireEvent.change(within(dialog).getByLabelText('Efectivo del fondo de compras'), { target: { value: '25.000,00' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Registrar compra' }));
    const receipt = await screen.findByRole('dialog', { name: 'Comprobante de compra #7' });
    expect(JSON.parse(String(fetch.mock.calls.find(([url]) => String(url) === '/api/purchases')
      ?.[1]?.body))).toEqual({
      operation_key: expect.stringMatching(/^[A-Za-z0-9_-]{16,128}$/),
      note: '', used_lines: [{ model: 'NS60ZL', quantity: 1, unit_price: '25000.00' }],
      scrap_lines: [], paid_cash: '25000.00', paid_transfer: '0.00',
    });
    expect(within(receipt).getByText('NS60ZL')).toBeInTheDocument();
    expect(within(receipt).getAllByText('Bs 25.000,00').length).toBeGreaterThan(0);
    expect(within(receipt).getByText('Efectivo')).toBeInTheDocument();
    expect(within(receipt).getByText('Cuenta #3')).toBeInTheDocument();
    expect(within(receipt).getByText(/Firma/)).toBeInTheDocument();
    expect(within(receipt).getByRole('button', { name: 'Imprimir comprobante' })).toBeInTheDocument();
  });

  it('buys scrap by kilogram showing the last price per kilogram', async () => {
    setup();
    await periodHero();
    fireEvent.click(screen.getByRole('tab', { name: /Chatarra/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Registrar compra' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nueva compra' });
    // The document opens on the kind the operator was looking at.
    expect(within(dialog).getByRole('button', { name: 'Chatarra por kg' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.change(within(dialog).getByLabelText('Material'), { target: { value: '1' } });
    expect(await within(dialog).findByText('Última: Bs 8.000,00')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Kilogramos'), { target: { value: '12,4' } });
    fireEvent.change(within(dialog).getByLabelText('Precio por kilogramo (Bs)'), { target: { value: '8.000,00' } });
    expect(within(dialog).getByText('Bs 99.200,00')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Agregar material' }));
    expect(within(dialog).getAllByText('Bs 99.200,00').length).toBeGreaterThan(0);
  });

  it('unfolds a document as a receipt with who received it', async () => {
    setup();
    await openDocuments();
    fireEvent.click(await screen.findByRole('button', { name: 'Ver el detalle de la compra #7' }));
    const receipt = await screen.findByRole('dialog', { name: 'Comprobante de compra #7' });
    expect(within(receipt).getByText('Cuenta #3')).toBeInTheDocument();
    expect(within(receipt).getByText('Efectivo')).toBeInTheDocument();
    expect(within(receipt).getByText(/Firma/)).toBeInTheDocument();
    expect(within(receipt).getByRole('button', { name: 'Imprimir comprobante' })).toBeInTheDocument();
  });

  it('requires a reversal reason before posting anything', async () => {
    const { fetch } = setup();
    await openDocuments();
    fireEvent.click(await screen.findByRole('button', { name: 'Anular la compra #7' }));
    const dialog = await screen.findByRole('dialog', { name: 'Anular compra #7' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirmar anulación' }));
    expect(await within(dialog).findByText(/El motivo es obligatorio/)).toBeInTheDocument();
    expect(fetch.mock.calls.some(([url, init]) => String(url).endsWith('/reverse') && init?.method === 'POST')).toBe(false);
    fireEvent.change(within(dialog).getByLabelText('Motivo de la anulación'), { target: { value: 'pesaje mal tipeado' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirmar anulación' }));
    await waitFor(() => expect(fetch.mock.calls.some(([url, init]) =>
      String(url) === '/api/purchases/7/reverse' && init?.method === 'POST')).toBe(true));
    const call = fetch.mock.calls.find(([url, init]) => String(url) === '/api/purchases/7/reverse' && init?.method === 'POST');
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      operation_key: expect.stringMatching(/^[A-Za-z0-9_-]{16,128}$/),
      reason: 'pesaje mal tipeado',
    });
    expect(await screen.findByText(/anulación registrada/i)).toBeInTheDocument();
  });

  it('surfaces the refusal tokens as typed messages', async () => {
    setup({
      create: () => json('{"error":"forbidden"}', 403),
      reverse: () => json('{"error":"already_reversed"}', 409),
    });
    const dialog = await openDraft();
    addUsed(dialog, 'NS60ZL', '1', '25.000,00');
    fireEvent.change(within(dialog).getByLabelText('Efectivo del fondo de compras'), { target: { value: '25.000,00' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Registrar compra' }));
    expect(await within(dialog).findByText(/No tenés permiso para registrar compras/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await openDocuments();
    fireEvent.click(await screen.findByRole('button', { name: 'Anular la compra #7' }));
    const reversal = await screen.findByRole('dialog', { name: 'Anular compra #7' });
    fireEvent.change(within(reversal).getByLabelText('Motivo de la anulación'), { target: { value: 'motivo' } });
    fireEvent.click(within(reversal).getByRole('button', { name: 'Confirmar anulación' }));
    expect(await screen.findByText(/ya tiene su contra-documento/i)).toBeInTheDocument();
  });

  it('pages the history with the frozen page sizes inside the chosen period', async () => {
    const { fetch } = setup({ listing: query => json(listingBody(query, { total_purchases: 30 })) });
    const panel = await openDocuments();
    fireEvent.click(await within(panel).findByRole('button', { name: 'Siguiente página' }));
    await waitFor(() => expect(fetch.mock.calls.some(([url]) =>
      String(url) === '/api/purchases?page=2&page_size=25&period=pending')).toBe(true));
  });
});

describe('purchases by period', () => {
  it('offers exactly the periods the server sent, in its order, and opens on Pendiente', async () => {
    const { listings } = setup();
    const select = await screen.findByLabelText('Período') as HTMLSelectElement;
    await waitFor(() => expect(within(select).getAllByRole('option')).toHaveLength(4));
    expect(within(select).getAllByRole('option').map(option => option.textContent)).toEqual([
      'Pendiente', 'Rendición #7', 'Rendición #3', 'Todo el historial',
    ]);
    expect(select.value).toBe('pending');
    // The first read already asks for the pending balance, and it is the only read made.
    expect(listings()).toEqual(['/api/purchases?page=1&page_size=25&period=pending']);
  });

  it('shows only the periods a branch without any settlement was given', async () => {
    setup({ listing: query => json(listingBody(query, { periods: [pendingPeriod, allPeriod] })) });
    const select = await screen.findByLabelText('Período') as HTMLSelectElement;
    await waitFor(() => expect(within(select).getAllByRole('option')).toHaveLength(2));
    expect(within(select).getAllByRole('option').map(option => option.textContent))
      .toEqual(['Pendiente', 'Todo el historial']);
  });

  it('reads its three numbers from the pending balance instead of the accumulated received', async () => {
    setup();
    const hero = await periodHero();
    const band = hero.querySelector('.purchases-metrics') as HTMLElement;
    // Twelve bought minus ten counted: the two units and two kilograms stay on screen.
    expect(await within(band).findByText('2 u.')).toBeInTheDocument();
    expect(within(band).getByText('2,000 kg')).toBeInTheDocument();
    // The two figures that explain each reading travel with it.
    expect(within(band).getByText('17 compradas · 15 entregadas')).toBeInTheDocument();
    expect(within(band).getByText('204,700 kg compradas · 202,700 kg entregadas')).toBeInTheDocument();
    // What the branch spent over its whole history is not a position, so it is not here.
    expect(within(band).queryByText('17 u.')).not.toBeInTheDocument();
    expect(within(band).queryByText('Bs 1.616.600,00')).not.toBeInTheDocument();
  });

  it('keeps the remainder visible when the count was lower than expected', async () => {
    setup();
    const panel = await screen.findByRole('tabpanel');
    const model = (await within(panel).findByText('NS60ZL')).closest('tr')!;
    expect(within(model).getByText('12')).toBeInTheDocument();
    expect(within(model).getByText('10')).toBeInTheDocument();
    expect(within(model).getByText('2')).toBeInTheDocument();
    // A model the warehouse counted whole is not a row of the pending reading.
    expect(within(panel).queryByText('NS40ZL')).not.toBeInTheDocument();
    expect(within(panel).getByText(/Es saldo, no stock de venta/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /Chatarra/ }));
    const scrapPanel = await screen.findByRole('tabpanel');
    const copper = (await within(scrapPanel).findByText('Cobre')).closest('tr')!;
    expect(within(copper).getByText('118,500 kg')).toBeInTheDocument();
    expect(within(copper).getByText('2,000 kg')).toBeInTheDocument();
    expect(within(scrapPanel).queryByText('Aluminio')).not.toBeInTheDocument();
  });

  it('reads zero after a settlement that counted everything', async () => {
    setup({ listing: query => json(listingBody(query, { balance: deliveredBalance, totals: deliveredTotals })) });
    const hero = await periodHero();
    const band = hero.querySelector('.purchases-metrics') as HTMLElement;
    expect(await within(band).findByText('0 u.')).toBeInTheDocument();
    expect(within(band).getByText('0,000 kg')).toBeInTheDocument();
    const panel = await screen.findByRole('tabpanel');
    expect(await within(panel).findByText(/No queda saldo pendiente/)).toBeInTheDocument();
    expect(within(panel).queryByRole('table')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /Chatarra/ }));
    const scrapPanel = await screen.findByRole('tabpanel');
    expect(within(scrapPanel).getByText(/No queda saldo pendiente/)).toBeInTheDocument();
    expect(within(scrapPanel).queryByRole('table')).not.toBeInTheDocument();
  });

  it('says in words which period it is showing and cuts a settlement at its own moment', async () => {
    const { listings } = setup();
    expect(await screen.findByText(/saldo abierto, sin corte/)).toBeInTheDocument();
    await selectPeriod('7');
    const line = await screen.findByText(/cerrada · corte/);
    expect(line).toHaveTextContent('Rendición #7');
    expect(line).toHaveTextContent(/12\/11\/2026/);
    expect(line).toHaveTextContent(/23\/10\/2026/);
    expect(line).toHaveTextContent(/de este período/);
    // Nothing on this page claims the accumulated history as if it were this period's reading.
    expect(line).not.toHaveTextContent(/acumulado/i);
    // The period that is asked for is the one that is described.
    expect(listings()).toHaveLength(2);
    expect(listings()[1]).toBe('/api/purchases?page=1&page_size=25&period=7');
  });

  it('follows a closed settlement through its own documents and its own count', async () => {
    const { listings } = setup();
    await selectPeriod('7');
    const documents = await screen.findByRole('tab', { name: /Documentos/ });
    await waitFor(() => expect(documents).toHaveAccessibleName(/Documentos\s+1$/));
    fireEvent.click(documents);
    const panel = await screen.findByRole('tabpanel');
    expect(within(panel).getByText('#7')).toBeInTheDocument();
    // Exactly one request per change: the numbers never come from a second read.
    expect(listings().filter(url => url.includes('period=7'))).toHaveLength(1);
  });

  it('reads a closed settlement through its own three numbers and never the history', async () => {
    setup();
    await selectPeriod('7');
    const hero = await periodHero();
    const band = hero.querySelector('.purchases-metrics') as HTMLElement;
    // The totals of the window the settlement closed: 50.000,00, two units and three kilos.
    expect(await within(band).findByText('Bs 50.000,00')).toBeInTheDocument();
    expect(within(band).getByText('2 u.')).toBeInTheDocument();
    expect(within(band).getByText('3,000 kg')).toBeInTheDocument();
    // The accumulated history is not a reading of this period, so it is not on the band.
    expect(within(band).queryByText('Bs 1.616.600,00')).not.toBeInTheDocument();
    expect(within(band).queryByText('17 u.')).not.toBeInTheDocument();
    expect(within(band).queryByText('204,700 kg')).not.toBeInTheDocument();
    expect(within(band).queryByText(/acumulado/i)).not.toBeInTheDocument();
  });

  it('refuses a listing whose totals do not belong to the period instead of half rendering it', async () => {
    // Money under the pending period: the balance is material, so this answer is not one the server
    // writes, and the screen must fall back to its refusal rather than show a number of nowhere.
    setup({ listing: query => json(listingBody(query, { totals: settlementTotals })) });
    expect(await screen.findByText(/No se pudo consultar el historial de compras/)).toBeInTheDocument();
    const hero = await periodHero();
    const band = hero.querySelector('.purchases-metrics') as HTMLElement;
    expect(within(band).getAllByText('—')).toHaveLength(3);
    expect(screen.queryByLabelText('Período')).not.toBeInTheDocument();
    expect(screen.queryByText('NS60ZL')).not.toBeInTheDocument();
  });

  it('refuses an answer it cannot trust instead of half rendering it', async () => {
    setup({ listing: () => json(JSON.stringify({ page: 1, page_size: 25, total_purchases: 1,
      purchases: [historyRow] })) });
    expect(await screen.findByText(/No se pudo consultar el historial de compras/)).toBeInTheDocument();
    const hero = await periodHero();
    const band = hero.querySelector('.purchases-metrics') as HTMLElement;
    expect(within(band).getAllByText('—')).toHaveLength(3);
    expect(screen.queryByLabelText('Período')).not.toBeInTheDocument();
    expect(screen.queryByText('NS60ZL')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
