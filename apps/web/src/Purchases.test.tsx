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
const history = JSON.stringify({ page: 1, page_size: 25, total_purchases: 1, purchases: [historyRow] });
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
  history: Reply;
  detail: Reply;
  create: Reply;
  reverse: Reply;
}

function setup(overrides: Partial<Routes> = {}) {
  const routes: Routes = {
    models: () => json(models), materials: () => json(materials), lastPrices: () => json(lastPrices),
    received: () => json(received), history: () => json(history), detail: () => json(documentBody()),
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
    if (url.startsWith('/api/purchases?page=')) return routes.history();
    if (/^\/api\/purchases\/\d+$/.test(url)) return routes.detail();
    throw new Error('Unexpected mocked URL: ' + url);
  });
  render(<Purchases csrf={csrf} branch="Sucursal A" fetcher={fetch} />);
  return { fetch };
}

async function receivedHero() {
  return (await screen.findByRole('heading', { name: 'Recibido' })).closest('section')!;
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
  it('opens on the accumulated recibido band and never calls it available stock', async () => {
    setup();
    await screen.findByRole('heading', { name: 'Compras' });
    const hero = await receivedHero();
    const band = hero.querySelector('.purchases-metrics') as HTMLElement;
    // Total del recibido (400.000 usadas + 1.216.600 chatarra), units and kilograms.
    expect(await within(band).findByText('Bs 1.616.600,00')).toBeInTheDocument();
    expect(within(band).getByText('17 u.')).toBeInTheDocument();
    expect(within(band).getByText('204,700 kg')).toBeInTheDocument();
    expect(within(band).getByText('Bs 400.000,00 · no se revenden')).toBeInTheDocument();
    expect(within(band).getByText(/lo que salió de caja/)).toBeInTheDocument();
    expect(within(band).getAllByText(/recibido/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/disponible/i)).not.toBeInTheDocument();
    // The hero carries no heading paragraph and no separate action row.
    expect(within(hero).queryByText(/se calcula con los documentos/i)).not.toBeInTheDocument();
  });

  it('sits the tabs and the primary action on one row, each tab with its own total', async () => {
    setup();
    const hero = await receivedHero();
    const tabs = await within(hero).findByRole('tablist', { name: 'Recibido por tipo de material' });
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
    await receivedHero();
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
    await receivedHero();
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
    fireEvent.change(within(dialog).getByLabelText('Efectivo'), { target: { value: '20.000,00' } });
    expect(within(dialog).getByText(/Faltan Bs 5.000,00/)).toBeInTheDocument();
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Efectivo'), { target: { value: '24.500,00' } });
    fireEvent.change(within(dialog).getByLabelText('Transferencia'), { target: { value: '500,00' } });
    expect(within(dialog).getByText(/cubre el total/i)).toBeInTheDocument();
    expect(submit).toBeEnabled();
  });

  it('records the purchase and shows a printable receipt', async () => {
    const { fetch } = setup({ create: () => json(documentBody({ note: '' }), 201) });
    const dialog = await openDraft();
    addUsed(dialog, 'NS60ZL', '1', '25.000,00');
    fireEvent.change(within(dialog).getByLabelText('Efectivo'), { target: { value: '25.000,00' } });
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
    await receivedHero();
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
    fireEvent.change(within(dialog).getByLabelText('Efectivo'), { target: { value: '25.000,00' } });
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

  it('pages the history with the frozen page sizes', async () => {
    const { fetch } = setup({
      history: () => json(JSON.stringify({ page: 1, page_size: 25, total_purchases: 30, purchases: [historyRow] })),
    });
    const panel = await openDocuments();
    fireEvent.click(await within(panel).findByRole('button', { name: 'Siguiente página' }));
    await waitFor(() => expect(fetch.mock.calls.some(([url]) =>
      String(url) === '/api/purchases?page=2&page_size=25')).toBe(true));
  });
});
