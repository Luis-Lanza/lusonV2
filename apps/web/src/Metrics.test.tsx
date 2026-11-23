import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Metrics from './Metrics';

const json = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'Content-Type': 'application/json' } });

const closedPeriod = (id: number, from: string, to: string) =>
  ({ kind: 'settlement', closing_id: id, from, to, label: `Rendición #${id}` });
const livePeriod = (id: number, from: string, to: string) =>
  ({ kind: 'open', closing_id: id, from, to, label: 'En curso' });
const allPeriod = { kind: 'all', closing_id: null, from: null, to: null, label: 'Todo el historial' };
// The window since the last closed cut: computed at the read, with no closing of its own (S3, S4).
const currentPeriod = { kind: 'current', closing_id: null, from: '2026-11-01T12:00:00Z', to: null,
  label: 'Desde el último corte' };
const closed = closedPeriod(4, '2026-10-20T12:00:00Z', '2026-11-01T12:00:00Z');
const older = closedPeriod(3, '2026-10-01T12:00:00Z', '2026-10-20T12:00:00Z');
const live = livePeriod(5, '2026-11-01T12:00:00Z', '2026-11-12T12:00:00Z');
// The selector the server publishes for a branch that is not inside a settlement: the window since the
// last cut first, then the closed settlements newest first, then the whole history (S4).
const periods = [currentPeriod, closed, older, allPeriod];
// A branch inside a live settlement has no window to publish: «En curso» covers that same stretch.
const livePeriods = [closed, live, allPeriod];

const sales = {
  total: '4286400.00', cash: '1842300.00', card: '1486900.00', transfer: '612200.00',
  qr: '345000.00', commission: '192888.00', sales: 63, units: 78,
};
const cash = {
  opening: '120000.00', sales: '1842300.00', expenses: '84500.00', expected: '1877800.00',
  counted: '1877800.00', difference: '0.00',
};
const fund = {
  opening: '480000.00', purchases: '312000.00', expected: '168000.00', counted: '168000.00',
  difference: '0.00', replacement: '200000.00',
};
const scrapRows = [
  { material_id: 1, material: 'Cobre', bought_milli: 92300, delivered_milli: 92300 },
  { material_id: 2, material: 'Aluminio', bought_milli: 61000, delivered_milli: 61000 },
  { material_id: 3, material: 'Plomo', bought_milli: 45700, delivered_milli: 45700 },
  { material_id: 4, material: 'Bronce', bought_milli: 15500, delivered_milli: 15500 },
];
const materials = {
  used_units: 78, used_delivered_units: 78, scrap_milli: 214500, scrap_delivered_milli: 214500,
  materials: scrapRows,
};
const topModels = [
  { catalog_entry_id: 1, brand: 'Willard', model: 'UB 12-75', capacity_ah: '75', units: 22, money: '1221000.00' },
  { catalog_entry_id: 2, brand: 'Moura', model: '12-60', capacity_ah: '60', units: 17, money: '782000.00' },
  { catalog_entry_id: 3, brand: 'Bosch', model: 'S4 12-45', capacity_ah: '45', units: 11, money: '396000.00' },
  { catalog_entry_id: 4, brand: 'Willard', model: 'UB 12-100', capacity_ah: '100', units: 9, money: '1035000.00' },
  { catalog_entry_id: 5, brand: 'Rocket', model: '12-55', capacity_ah: '55', units: 4, money: '208000.00' },
];
// One row of the second catalogue kind: a product is its free name and it carries no capacity. The shape
// of the row is its own discriminant and there is no tag beside it (S6).
const productModel = { catalog_entry_id: 6, name: 'Agua acidulada', units: 3, money: '150000.00' };
const stock = { units: 214 };

// The drawer of today: what the last cut left, the cash sales after it and the signed movements of its
// window -- 500000 + 1842300 + (10000 − 2500 − 50000) = 2299800 (S12).
const today = {
  since: '2026-11-01T12:00:00Z', opening: '500000.00', sales: '1842300.00',
  expenses: '2500.00', effective: '-42500.00', expected: '2299800.00',
  // What the branch is earning so far: 2100000.00 sold since the cut at 12.50% is 262500.00 (S18).
  rate: '12.50', sold: '2100000.00', commission: '262500.00',
  movements: [
    { kind: 'aporte', amount: '10000.00', effective: '10000.00', occurred_at: '2026-11-01T12:00:00Z' },
    { kind: 'gasto', amount: '2500.00', effective: '-2500.00', occurred_at: '2026-11-02T09:30:00Z' },
    { kind: 'recaudacion', amount: '50000.00', effective: '-50000.00', occurred_at: '2026-11-03T18:00:00Z' },
  ],
};

// The purchase envelope of today: what the last cut left in it, the signed effect of the movements of
// its window and the balance of the book -- 480000 + (−120000) = 360000 (S5, S15-S17).
const fundToday = {
  since: '2026-11-01T12:00:00Z', opening: '480000.00', purchases: '150000.00',
  effective: '-120000.00', balance: '360000.00', documents: 4, used_units: 11, scrap_milli: 42500,
};

const settlementBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  periods, period: closed, source: 'settlement', sales, cash, fund, materials,
  top_models: topModels, stock, today, fund_today: fundToday, ...overrides,
});
const olderBody = () => settlementBody({
  period: older,
  sales: { ...sales, total: '1000000.00', cash: '1000000.00', card: '0.00', transfer: '0.00',
    qr: '0.00', commission: '45000.00', sales: 10, units: 12 },
  cash: { opening: '0.00', sales: '1000000.00', expenses: '0.00', expected: '1000000.00',
    counted: '1000000.00', difference: '0.00' },
  fund: { opening: '0.00', purchases: '0.00', expected: '0.00', counted: '0.00',
    difference: '0.00', replacement: '0.00' },
  materials: { used_units: 0, used_delivered_units: 0, scrap_milli: 0, scrap_delivered_milli: 0,
    materials: [] },
  top_models: [{ catalog_entry_id: 1, brand: 'Willard', model: 'UB 12-75',
    capacity_ah: '75', units: 12, money: '1000000.00' }],
});
const liveBody = () => JSON.stringify({
  periods: livePeriods, period: live, source: 'live', sales,
  cash: { ...cash, counted: null, difference: null },
  fund: { ...fund, counted: null, difference: null, replacement: null },
  materials: { used_units: 78, used_delivered_units: null, scrap_milli: 214500,
    scrap_delivered_milli: null, materials: scrapRows.map(row => ({ ...row, delivered_milli: null })) },
  top_models: topModels, stock, today, fund_today: fundToday,
});
// The window since the last cut: the money and the ranking of that stretch, and no acta, so the
// three accounts are null and the figures say why (S5, S8).
const currentBody = () => JSON.stringify({
  periods: [currentPeriod, closed, older, allPeriod], period: currentPeriod, source: 'live', sales,
  cash: null, fund: null, materials: null,
  // One window, one total: the period collected what the line of today says was sold (S6).
  today: { ...today, sold: sales.total, commission: '535800.00' },
  top_models: topModels, stock, fund_today: fundToday,
});
const historyBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  periods, period: allPeriod, source: 'history', sales, cash: null, fund: null, materials: null,
  top_models: topModels, stock, today, fund_today: fundToday, ...overrides,
});

type Route = (token: string) => Response;
const defaultRoutes: Route = token => {
  if (token === '4') return json(settlementBody());
  if (token === '3') return json(olderBody());
  if (token === '5') return json(liveBody());
  if (token === 'current') return json(currentBody());
  if (token === 'all') return json(historyBody());
  throw new Error('Unexpected mocked period: ' + token);
};

const notFound = () => new Response('{"error":"not_found"}',
  { status: 404, headers: { 'Content-Type': 'application/json' } });

// The screen opens on the window since the last cut (S10), so every branch is read for it first. A
// route that does not answer it gets the base window; the tests of a branch without one (a live
// settlement, or no closed settlement at all) pass `notFound` and the screen falls back to history.
function setup(route: Route = defaultRoutes, current: Route = () => json(currentBody())) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init = {}) => {
    const url = String(input);
    const match = /^\/api\/metrics\?period=(.+)$/.exec(url);
    if (!match) throw new Error('Unexpected mocked URL: ' + url);
    // Reading metrics is a read: the screen never writes, whatever period is on screen.
    expect(init.method ?? 'GET').toBe('GET');
    expect(init.body).toBeUndefined();
    return match[1] === 'current' ? current(match[1]) : route(match[1]);
  });
  render(<Metrics branch="Sucursal A" fetcher={fetch} />);
  const calls = () => fetch.mock.calls.map(([url]) => String(url));
  return { fetch, calls };
}

/** Chooses one period of the selector the server published. */
async function selectPeriod(token: string) {
  const select = await screen.findByLabelText('Período') as HTMLSelectElement;
  await waitFor(() => expect(within(select).getAllByRole('option').length).toBeGreaterThan(1));
  fireEvent.change(select, { target: { value: token } });
  await waitFor(() => expect(select.value).toBe(token));
}

const panel = (name: string) => screen.getByRole('region', { name });

afterEach(() => { vi.useRealTimers(); });

describe('branch metrics screen', () => {
  it('opens on the window since the last cut and names where its numbers come from', async () => {
    const { calls } = setup();
    // The screen starts on the window that moves with the branch today (S10).
    await waitFor(() => expect(calls()).toEqual(['/api/metrics?period=current']));
    expect(await screen.findByText(/se mueve con cada venta/)).toBeInTheDocument();
    expect(screen.getByText(/Desde el corte del/)).toBeInTheDocument();
    const first = screen.getByLabelText('Período') as HTMLSelectElement;
    expect(first.value).toBe('current');

    await selectPeriod('4');
    expect(calls()).toEqual(['/api/metrics?period=current', '/api/metrics?period=4']);
    // Where the numbers come from, in words, under the title (S6).
    expect(await screen.findByText(/Números al cierre del/)).toBeInTheDocument();

    // Only a period this server published can be asked for, in the server's own order.
    const select = screen.getByLabelText('Período') as HTMLSelectElement;
    const offered = within(select).getAllByRole('option').map(option => (option as HTMLOptionElement).value);
    expect(offered).toEqual(['current', '4', '3', 'all']);
  });

  it('opens on the whole history, with no error, when the branch has no window', async () => {
    // A branch inside a live settlement, or one that never closed a settlement, has no window: the
    // screen opens on its history instead of showing a fault (S10).
    const { calls } = setup(defaultRoutes, notFound);
    await waitFor(() => expect(calls())
      .toEqual(['/api/metrics?period=current', '/api/metrics?period=all']));
    expect(await screen.findByText('Todo el historial de la sucursal')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect((screen.getByLabelText('Período') as HTMLSelectElement).value).toBe('all');
  });

  it('states the period in four figures and keeps no prose of the acta', async () => {
    setup(token => token === 'all' ? json(historyBody()) : json(settlementBody()));
    await selectPeriod('4');

    const figures = panel('Lo que dejó el período');
    expect(within(figures).getByText('Bs 4.286.400,00')).toBeInTheDocument();
    expect(within(figures).getByText('63 ventas')).toBeInTheDocument();
    // The ticket of the period is not a reading of this screen: the figure states the sales only.
    expect(within(figures).queryByText(/ticket/i)).toBeNull();
    expect(within(figures).getByText('Bs 1.877.800,00')).toBeInTheDocument();
    expect(within(figures).getByText('contada · sin diferencia')).toBeInTheDocument();
    expect(within(figures).getByText('Bs 200.000,00')).toBeInTheDocument();
    expect(within(figures).getByText('recambio del Almacén')).toBeInTheDocument();
    expect(within(figures).getByText('78 u · 214,500 kg')).toBeInTheDocument();
    expect(within(figures).getByText('baterías usadas y chatarra')).toBeInTheDocument();

    // The prose of the acta is gone: no footnote, no formula, no window sentence, no rate sentence.
    expect(screen.queryByText(/Cómo leer estos números/)).toBeNull();
    expect(screen.queryByText(/Lo que quedó en el cajón al cerrar el último corte/)).toBeNull();
    expect(screen.queryByText(/La tasa que fijó el Almacén/)).toBeNull();
    expect(screen.queryByText(/Cubre/)).toBeNull();
    expect(screen.queryByText(/período de rendición, con la misma numeración/)).toBeNull();
    // The ledger of the drawer and the breakdown of both boxes are not on this screen anymore.
    expect(screen.queryByText(/Movimientos de caja desde el último corte/)).toBeNull();
    expect(screen.queryByText('Debería haber')).toBeNull();
    expect(screen.queryByText('Apertura declarada')).toBeNull();
    expect(screen.queryByText('Recambio que dejó el Almacén')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Caja operativa' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Fondo de compras' })).toBeNull();
  });

  it('reads the collection of the period by method, with its amount and its share', async () => {
    setup(token => token === 'all' ? json(historyBody()) : json(settlementBody()));
    await selectPeriod('4');
    const mix = panel('Cómo se cobró');
    // One row per method and only its own reading: the total is the figure above, never repeated here.
    expect(within(mix).getAllByRole('listitem')).toHaveLength(4);
    expect(within(mix).getByText('Efectivo')).toBeInTheDocument();
    expect(within(mix).getByText('Bs 1.842.300,00')).toBeInTheDocument();
    expect(within(mix).getByText('43,0 %')).toBeInTheDocument();
    expect(within(mix).getByText('34,7 %')).toBeInTheDocument();
    expect(within(mix).getByText('8,0 %')).toBeInTheDocument();
    expect(within(mix).queryByText('Total')).toBeNull();
    // The commission of the period is not a row of this screen: it is settled with the acta.
    expect(within(mix).queryByText(/Bs 192\.888,00/)).toBeNull();
  });

  it('ranks the period by units with the money of each row and nothing else', async () => {
    setup(token => token === 'all' ? json(historyBody()) : json(settlementBody()));
    await selectPeriod('4');
    const podium = panel('Más vendidas');
    const rows = within(podium).getAllByRole('row');
    expect(rows).toHaveLength(6);
    expect(rows[1]).toHaveTextContent('Willard UB 12-75');
    // A battery keeps the capacity the screen always composed, beside its name.
    expect(rows[1]).toHaveTextContent('75 Ah');
    expect(rows[1]).toHaveTextContent('22');
    expect(rows[1]).toHaveTextContent('Bs 1.221.000,00');
    expect(rows[5]).toHaveTextContent('Rocket 12-55');
    // The share bar of the old panel is gone; the volume it was computed from stays as one line.
    expect(within(podium).queryByText('Parte')).toBeNull();
    expect(within(podium).queryByText('28 %')).toBeNull();
    expect(within(podium).getByText('63 de 78 unidades')).toBeInTheDocument();
  });

  it('renders a product row by its name and invents no capacity for it', async () => {
    // The period sold two batteries and one product, ranked by units: the product is the last row.
    const ranking = { top_models: [topModels[0], topModels[1], productModel] };
    setup(token => json(token === 'all' ? historyBody(ranking) : settlementBody(ranking)));
    await selectPeriod('4');

    const podium = panel('Más vendidas');
    const rows = within(podium).getAllByRole('row');
    expect(rows).toHaveLength(4);
    expect(rows[3]).toHaveTextContent('Agua acidulada');
    expect(rows[3]).toHaveTextContent('Bs 150.000,00');
    expect(rows[3]).not.toHaveTextContent('Ah');
    // The volume of the period is untouched by the ranking's kinds (S7).
    expect(within(panel('Lo que dejó el período')).getByText('63 ventas')).toBeInTheDocument();
  });

  it('names the empty ranking in words instead of an empty table', async () => {
    setup(token => json(token === 'all' ? historyBody({ top_models: [] })
      : settlementBody({ top_models: [] })));
    await selectPeriod('4');
    const podium = panel('Más vendidas');
    expect(within(podium).getByText('El período no vendió nada: no hay ranking que mostrar.'))
      .toBeInTheDocument();
    expect(within(podium).queryByRole('table')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Baterías más vendidas' })).toBeNull();
  });

  it('states the scrap the branch bought in the period, by material and in total', async () => {
    setup(token => token === 'all' ? json(historyBody()) : json(settlementBody()));
    await selectPeriod('4');
    const scrap = panel('Chatarra comprada');
    expect(within(scrap).getByText('Cobre')).toBeInTheDocument();
    expect(within(scrap).getByText('92,300 kg')).toBeInTheDocument();
    expect(within(scrap).getByText('Bronce')).toBeInTheDocument();
    expect(within(scrap).getByText('214,500 kg')).toBeInTheDocument();
    // What the branch bought, never what it delivered: there is no delivery reading on this strip.
    expect(within(scrap).queryByText(/entregad/i)).toBeNull();
  });

  it('reads the bought kilos when the count and the purchase do not agree', async () => {
    // The sheet counted more than the period bought: the strip keeps stating the purchase, because the
    // delivery is the warehouse's reading and not this one.
    const overRows = scrapRows.map(row => ({ ...row, delivered_milli: row.bought_milli + 375 }));
    setup(token => token === '4'
      ? json(settlementBody({ materials: { used_units: 78, used_delivered_units: 80,
        scrap_milli: 214500, scrap_delivered_milli: 216000, materials: overRows } }))
      : json(historyBody()));
    await selectPeriod('4');
    const scrap = panel('Chatarra comprada');
    expect(within(scrap).getByText('92,300 kg')).toBeInTheDocument();
    expect(within(scrap).getByText('214,500 kg')).toBeInTheDocument();
    expect(within(scrap).queryByText('92,675 kg')).toBeNull();
    expect(within(scrap).queryByText('216,000 kg')).toBeNull();
  });

  it('states the scrap a window bought even though it has no sheet yet', async () => {
    const windowPeriods = [currentPeriod, closed, older, allPeriod];
    setup(token => token === 'current' ? json(currentBody())
      : json(historyBody({ periods: windowPeriods })));
    await selectPeriod('current');
    const scrap = panel('Chatarra comprada');
    // The window has no material sheet: it states the kilos the branch bought since the cut.
    expect(within(scrap).getByText('Comprada desde el corte')).toBeInTheDocument();
    expect(within(scrap).getByText('42,500 kg')).toBeInTheDocument();
  });

  it('states a window without purchases in words instead of a zero', async () => {
    setup(defaultRoutes, () => json(JSON.stringify({ ...JSON.parse(currentBody()),
      fund_today: { ...fundToday, purchases: '0.00', effective: '0.00', balance: '480000.00',
        documents: 0, used_units: 0, scrap_milli: 0 } })));
    await selectPeriod('current');
    expect(within(panel('Chatarra comprada')).getByText('Sin compras')).toBeInTheDocument();
  });

  it('reads a settlement that counted more material than the period bought', async () => {
    const overRows = scrapRows.map(row => ({ ...row, delivered_milli: row.bought_milli + 375 }));
    setup(token => token === '4'
      ? json(settlementBody({ materials: { used_units: 78, used_delivered_units: 80,
        scrap_milli: 214500, scrap_delivered_milli: 216000, materials: overRows } }))
      : json(historyBody()));
    await selectPeriod('4');
    // The delivered quantity is the counted one, and it may exceed what the period bought (L7).
    expect(within(panel('Lo que dejó el período')).getByText('80 u · 216,000 kg'))
      .toBeInTheDocument();
    // The figure counts the delivery; the strip keeps stating the purchase, which did not move.
    const scrap = panel('Chatarra comprada');
    expect(within(scrap).getByText('92,300 kg')).toBeInTheDocument();
    expect(within(scrap).getByText('214,500 kg')).toBeInTheDocument();
  });

  it('says with words that the accumulated history has no drawer, no fund and no sheet', async () => {
    setup(defaultRoutes, notFound);
    const figures = await screen.findByRole('region', { name: 'Lo que dejó el período' });
    await waitFor(() => expect(within(figures).getByText('Sin caja')).toBeInTheDocument());
    expect(within(figures).getByText('Sin fondo')).toBeInTheDocument();
    expect(within(figures).getByText('Sin planilla')).toBeInTheDocument();
    // The history is still a period of its own: its sales are stated, and no zero stands for an absence.
    expect(within(figures).getByText('Bs 4.286.400,00')).toBeInTheDocument();
    expect(screen.queryByText('Bs 0,00')).toBeNull();
    // The strip of the scrap says it with words too, and states no kilos it never had.
    expect(within(panel('Chatarra comprada')).getByText(/no tiene planilla/)).toBeInTheDocument();
  });

  it('states the expectation of a live period and never a counted zero', async () => {
    setup(token => json(token === 'all' ? historyBody({ periods: livePeriods }) : liveBody()), notFound);
    await selectPeriod('5');
    const figures = panel('Lo que dejó el período');
    // Nobody counted the drawer yet: the figure is the expectation and it says so.
    expect(within(figures).getByText('Bs 1.877.800,00')).toBeInTheDocument();
    expect(within(figures).getByText('todavía no se contó')).toBeInTheDocument();
    // The warehouse declared no replacement yet, and the delivery has no count either.
    expect(within(figures).getByText('Sin declarar')).toBeInTheDocument();
    expect(within(figures).getByText('Sin contar')).toBeInTheDocument();
    expect(screen.getByText('En vivo, se mueve con cada venta')).toBeInTheDocument();
    // The strip still states the purchase of the sheet: a delivery nobody counted does not hide it.
    expect(within(panel('Chatarra comprada')).getByText('214,500 kg')).toBeInTheDocument();
  });

  it('reads the drawer, the envelope, the sales and the commission of today as four figures', async () => {
    setup(token => token === '4' ? json(settlementBody()) : json(historyBody()));
    await selectPeriod('4');
    const card = panel('Hoy');
    // The two money boxes of the branch as they stand, and the two readings of the live window (S12, S18).
    expect(within(card).getByText('Bs 2.299.800,00')).toBeInTheDocument();
    // The envelope is named for what it is: the branch's purchase fund (S15).
    expect(within(card).getByText('Fondo de compras disponible')).toBeInTheDocument();
    expect(within(card).getByText('Bs 360.000,00')).toBeInTheDocument();
    expect(within(card).getByText('Bs 2.100.000,00')).toBeInTheDocument();
    expect(within(card).getByText('Bs 262.500,00')).toBeInTheDocument();
    // The purchases of the window, because the envelope is what pays them (S15, S17).
    expect(within(card).getByText('4 compras')).toBeInTheDocument();
    expect(within(card).getByText('11 u · 42,500 kg')).toBeInTheDocument();
    // The window those figures cover, from the cut of the last closed settlement.
    expect(card).toHaveTextContent('desde el corte del 01/11/2026 · 08:00');
  });

  it('reads the purchase of one used battery in the line of today', async () => {
    // The case the operator checks by hand: one document paid from the envelope, one battery and no
    // scrap. The line names the purchase, what it bought and the balance it left (S15, S17).
    setup(token => token === '4'
      ? json(settlementBody({ fund_today: { ...fundToday, purchases: '100.00', effective: '-100.00',
        balance: '479900.00', documents: 1, used_units: 1, scrap_milli: 0 } }))
      : json(historyBody()));
    await selectPeriod('4');
    const card = panel('Hoy');
    expect(within(card).getByText('1 compra')).toBeInTheDocument();
    expect(within(card).getByText('1 u')).toBeInTheDocument();
    expect(within(card).getByText('Bs 479.900,00')).toBeInTheDocument();
  });

  it('states a window without purchases with words instead of a zero', async () => {
    setup(token => token === '4'
      ? json(settlementBody({ fund_today: { ...fundToday, purchases: '0.00', effective: '0.00',
        balance: '480000.00', documents: 0, used_units: 0, scrap_milli: 0 } }))
      : json(historyBody()));
    await selectPeriod('4');
    const card = panel('Hoy');
    expect(within(card).getByText('Sin compras')).toBeInTheDocument();
    expect(within(card).queryByText(/Sin unidades ni kilos/)).toBeNull();
    expect(within(card).queryByText('0 compras')).toBeNull();
  });

  it('states the absence of a rate and of a sale with words, never with a zero', async () => {
    setup(token => token === '4'
      ? json(settlementBody({ today: { ...today, rate: null, sold: '0.00', commission: '0.00' } }))
      : json(historyBody()));
    await selectPeriod('4');
    const card = panel('Hoy');
    expect(within(card).getByText('Sin tasa')).toBeInTheDocument();
    expect(within(card).getByText('Sin ventas')).toBeInTheDocument();
    expect(within(card).queryByText('Bs 0,00')).toBeNull();
  });

  it('states a window without sales as the start of the commission, not as a zero', async () => {
    setup(token => token === '4'
      ? json(settlementBody({ today: { ...today, sold: '0.00', commission: '0.00' } }))
      : json(historyBody()));
    await selectPeriod('4');
    expect(within(panel('Hoy')).getByText('Sin comisión todavía')).toBeInTheDocument();
  });

  it('says that today starts at the beginning of the branch when there is no cut', async () => {
    const noCut = { ...today, since: null };
    setup(() => json(historyBody({ today: noCut })), notFound);
    const card = await screen.findByRole('region', { name: 'Hoy' });
    expect(card).toHaveTextContent('desde el comienzo de la sucursal');
    expect(within(card).getByText('Bs 2.299.800,00')).toBeInTheDocument();
  });

  it('switches to another published period and refetches with that exact token', async () => {
    const { calls } = setup();
    await selectPeriod('4');
    const select = screen.getByLabelText('Período') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '3' } });
    await waitFor(() => expect(calls()).toContain('/api/metrics?period=3'));
    expect(await screen.findByText('10 ventas')).toBeInTheDocument();
  });

  it('offers the window since the last cut first and reads it without an acta', async () => {
    // This branch has no live settlement: its selector carries the window first, then the closed
    // settlements, then the history — the same list every answer publishes (S4).
    const windowPeriods = [currentPeriod, closed, older, allPeriod];
    const { calls } = setup(token => {
      if (token === 'current') return json(currentBody());
      if (token === 'all') return json(historyBody({ periods: windowPeriods }));
      return json(settlementBody({ periods: windowPeriods }));
    });
    await selectPeriod('current');
    // The window is the first period the selector offers, and asking for it asks for `current`.
    await waitFor(() => expect(calls()).toContain('/api/metrics?period=current'));
    const select = screen.getByLabelText('Período') as HTMLSelectElement;
    expect(within(select).getByRole('option', { name: 'Desde el último corte' })).toBeInTheDocument();
    expect(within(select).getAllByRole('option').map(option => (option as HTMLOptionElement).value))
      .toEqual(['current', '4', '3', 'all']);

    // The money of the window, its ranking and its shelf; the accounts say the acta is missing (S8).
    const figures = panel('Lo que dejó el período');
    expect(within(figures).getByText('Bs 4.286.400,00')).toBeInTheDocument();
    expect(within(figures).getByText('63 ventas')).toBeInTheDocument();
    expect(within(figures).getByText('Sin caja')).toBeInTheDocument();
    expect(within(figures).getByText('se cuenta al rendir')).toBeInTheDocument();
    expect(within(figures).getByText('Sin fondo')).toBeInTheDocument();
    expect(within(figures).getByText('lo declara el Almacén al rendir')).toBeInTheDocument();
    expect(within(figures).getByText('Sin planilla')).toBeInTheDocument();
    expect(within(figures).getByText('se entrega al rendir')).toBeInTheDocument();
    expect(within(panel('Más vendidas')).getAllByRole('row')).toHaveLength(6);

    // The stamp says which cut the window starts at, and that it moves with every sale.
    expect(await screen.findByText(/se mueve con cada venta/)).toBeInTheDocument();
    expect(screen.getByText(/Desde el corte del/)).toBeInTheDocument();
  });

  it('refuses a payload the server could not have written and offers the same retry', async () => {
    // This branch has no window, so the screen falls back to the history, which is the answer that
    // cannot be trusted.
    const { calls } = setup(token => {
      if (token !== 'all') throw new Error('Unexpected mocked period: ' + token);
      return json(historyBody({ sales: { ...sales, total: '4286400.0' } }));
    }, notFound);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Respuesta inválida del servidor.');
    // A refused answer is not shown: no figure and no panel survive it.
    expect(screen.queryByRole('region', { name: 'Lo que dejó el período' })).toBeNull();
    expect(screen.queryByText('Bs 4.286.400,00')).toBeNull();
    fireEvent.click(within(alert).getByRole('button', { name: 'Reintentar' }));
    // The window the branch does not have, the history that failed, and the retry of the history.
    await waitFor(() => expect(calls()).toEqual(['/api/metrics?period=current',
      '/api/metrics?period=all', '/api/metrics?period=all']));
    expect(await screen.findByRole('alert')).toHaveTextContent('Respuesta inválida del servidor.');
  });
});
