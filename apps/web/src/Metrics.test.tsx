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
const closed = closedPeriod(4, '2026-10-20T12:00:00Z', '2026-11-01T12:00:00Z');
const older = closedPeriod(3, '2026-10-01T12:00:00Z', '2026-10-20T12:00:00Z');
const live = livePeriod(5, '2026-11-01T12:00:00Z', '2026-11-12T12:00:00Z');
// The selector the server publishes: the closed settlements newest first, the live one, the history.
const periods = [closed, older, live, allPeriod];

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
const stock = { units: 214 };

// The drawer of today, published by every source: what the last cut left, the cash sales after it
// and the expenses paid out of it -- 500000 + 1842300 − 84500 = 2257800 -- with the ledger rows of
// the window as information (S12-S14).
const today = {
  since: '2026-11-01T12:00:00Z', opening: '500000.00', sales: '1842300.00',
  expenses: '84500.00', expected: '2257800.00',
  movements: [
    { kind: 'aporte', amount: '10000.00', occurred_at: '2026-11-01T12:00:00Z' },
    { kind: 'gasto', amount: '2500.00', occurred_at: '2026-11-02T09:30:00Z' },
    { kind: 'recaudacion', amount: '50000.00', occurred_at: '2026-11-03T18:00:00Z' },
  ],
};

const settlementBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  periods, period: closed, source: 'settlement', sales, cash, fund, materials,
  top_models: topModels, stock, today, ...overrides,
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
  top_models: [{ catalog_entry_id: 1, brand: 'Willard', model: 'UB 12-75', capacity_ah: '75',
    units: 12, money: '1000000.00' }],
});
const liveBody = () => JSON.stringify({
  periods, period: live, source: 'live', sales,
  cash: { ...cash, counted: null, difference: null },
  fund: { ...fund, counted: null, difference: null, replacement: null },
  materials: { used_units: 78, used_delivered_units: null, scrap_milli: 214500,
    scrap_delivered_milli: null, materials: scrapRows.map(row => ({ ...row, delivered_milli: null })) },
  top_models: topModels, stock, today,
});
const historyBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  periods, period: allPeriod, source: 'history', sales, cash: null, fund: null, materials: null,
  top_models: topModels, stock, today, ...overrides,
});

type Route = (token: string) => Response;
const defaultRoutes: Route = token => {
  if (token === '4') return json(settlementBody());
  if (token === '3') return json(olderBody());
  if (token === '5') return json(liveBody());
  if (token === 'all') return json(historyBody());
  throw new Error('Unexpected mocked period: ' + token);
};

function setup(route: Route = defaultRoutes) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init = {}) => {
    const url = String(input);
    const match = /^\/api\/metrics\?period=(.+)$/.exec(url);
    if (!match) throw new Error('Unexpected mocked URL: ' + url);
    // Reading metrics is a read: the screen never writes, whatever period is on screen.
    expect(init.method ?? 'GET').toBe('GET');
    expect(init.body).toBeUndefined();
    return route(match[1]);
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
  it('opens on the whole history and states the sales, the ranking and the band of a closed settlement', async () => {
    const { calls } = setup();
    // The screen starts on the only default this contract has: the whole history.
    await waitFor(() => expect(calls()).toEqual(['/api/metrics?period=all']));
    await selectPeriod('4');
    expect(calls()).toEqual(['/api/metrics?period=all', '/api/metrics?period=4']);

    // Where the numbers come from, in words, beside the control (S6).
    expect(await screen.findByText(/Números al cierre del/)).toBeInTheDocument();

    const band = panel('Lo que dejó el período');
    expect(within(band).getByText('Bs 1.877.800,00')).toBeInTheDocument();
    expect(within(band).getByText('Bs 200.000,00')).toBeInTheDocument();
    expect(within(band).getByText('78 u · 214,500 kg')).toBeInTheDocument();

    const money = panel('Plata del período');
    expect(within(money).getAllByText('Bs 4.286.400,00').length).toBeGreaterThan(0);
    expect(within(money).getByText('en 63 ventas')).toBeInTheDocument();
    expect(within(money).getByText(/Ticket promedio Bs 68\.038,10/)).toBeInTheDocument();
    expect(within(money).getByText(/78 baterías vendidas/)).toBeInTheDocument();
    // The collection by method with its share of the total; the commission is reported beside it.
    expect(within(money).getByText('43,0 %')).toBeInTheDocument();
    expect(within(money).getByText('34,7 %')).toBeInTheDocument();
    expect(within(money).getByText(/Bs 192\.888,00/)).toBeInTheDocument();

    const drawer = panel('Caja operativa');
    expect(within(drawer).getByText('Debería haber')).toBeInTheDocument();
    // The domain has no withdrawals: the row the artboard invented is not on this screen.
    expect(within(drawer).queryByText('Retiros')).toBeNull();
    expect(within(drawer).getAllByText('Sin diferencia').length).toBeGreaterThan(0);

    const envelope = panel('Fondo de compras');
    // The envelope closes: the expectation and its count are the same amount, shown twice.
    expect(within(envelope).getAllByText('Bs 168.000,00').length).toBeGreaterThan(1);
    expect(within(envelope).getByText('Recambio que dejó el Almacén')).toBeInTheDocument();

    // Top 5 by units with the money of each row as the secondary reading (S4).
    const podium = panel('Baterías más vendidas');
    const rows = within(podium).getAllByRole('row');
    expect(rows).toHaveLength(6);
    expect(rows[1]).toHaveTextContent('Willard UB 12-75');
    expect(rows[1]).toHaveTextContent('75 Ah');
    expect(within(rows[1]).getByText('28 %')).toBeInTheDocument();
    expect(rows[1]).toHaveTextContent('Bs 1.221.000,00');
    expect(rows[5]).toHaveTextContent('Rocket 12-55');

    const scrap = panel('Recambio');
    expect(within(scrap).getByText('Cobre')).toBeInTheDocument();
    expect(within(scrap).getByText('214 u')).toBeInTheDocument();
  });

  it('switches to another published period and refetches with that exact token', async () => {
    const { calls } = setup();
    await selectPeriod('4');
    const select = screen.getByLabelText('Período') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '3' } });
    await waitFor(() => expect(calls()).toContain('/api/metrics?period=3'));
    expect(await screen.findByText('en 10 ventas')).toBeInTheDocument();
    // Only a period this server published can be asked for.
    const offered = within(select).getAllByRole('option').map(option => (option as HTMLOptionElement).value);
    expect(offered).toEqual(['4', '3', '5', 'all']);
  });

  it('says with words that the accumulated history has no drawer, and shows no zeros for it', async () => {
    setup();
    expect(await screen.findByText('El acumulado no tiene caja: la caja se cierra en cada rendición.'))
      .toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Caja operativa' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Fondo de compras' })).toBeNull();
    const band = panel('Lo que dejó el período');
    expect(within(band).getByText('Sin caja')).toBeInTheDocument();
    expect(within(band).getByText('Sin fondo')).toBeInTheDocument();
    expect(within(band).getByText('Sin planilla')).toBeInTheDocument();
    // The sales of the history are still a period of its own.
    expect(within(panel('Plata del período')).getAllByText('Bs 4.286.400,00').length).toBeGreaterThan(0);
    expect(screen.getByText('Todo el historial de la sucursal')).toBeInTheDocument();
    expect(screen.queryByText('Bs 0,00')).toBeNull();
  });

  it('derives the days without settling from the open period of the selector', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-12T12:00:00Z'));
    setup();
    await selectPeriod('5');
    const band = panel('Lo que dejó el período');
    expect(within(band).getByText('Días sin rendir')).toBeInTheDocument();
    // The live period opened on 2026-11-01T12:00:00Z, eleven whole days before now.
    expect(within(band).getByText('11 días')).toBeInTheDocument();
    expect(screen.getByText('En vivo, se mueve con cada venta')).toBeInTheDocument();
    // Nobody counted the drawer yet: it reads as an expectation, never as a counted zero.
    expect(within(band).getByText('Bs 1.877.800,00')).toBeInTheDocument();
    expect(within(band).getByText('Todavía no se contó: es la expectativa')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Caja operativa' })).toBeInTheDocument();
    expect(screen.getAllByText('Sin contar').length).toBeGreaterThan(0);
  });

  it('hides the days without settling when the selector publishes no open period', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-12T12:00:00Z'));
    setup(token => token === 'all'
      ? json(historyBody({ periods: [closed, older, allPeriod] }))
      : json(settlementBody({ periods: [closed, older, allPeriod] })));
    await selectPeriod('4');
    expect(await screen.findByText(/Números al cierre del/)).toBeInTheDocument();
    expect(screen.queryByText('Días sin rendir')).toBeNull();
    expect(within(panel('Lo que dejó el período')).queryByText(/días/)).toBeNull();
  });

  it('says with words that the accumulated history publishes no cash, no fund and no sheet', async () => {
    setup();
    expect(await screen.findByText('El acumulado no tiene caja: la caja se cierra en cada rendición.'))
      .toBeInTheDocument();
    // The sheet is absent for the same reason: each settlement took its material with it, so a sum
    // of sheets would be a number no settlement signed (S9).
    const scrap = panel('Recambio');
    expect(within(scrap).getByText(/no tiene planilla/)).toBeInTheDocument();
    expect(within(scrap).queryByText('Bs 0,00')).toBeNull();
    // What the history does state is still there: the sales, the ranking and the shelf of today.
    const podium = panel('Baterías más vendidas');
    expect(within(podium).getAllByRole('row')).toHaveLength(6);
    expect(within(scrap).getByText('214 u')).toBeInTheDocument();
  });

  it('renders a purchase net a counter-document left negative with its sign', async () => {
    setup(token => token === '4'
      ? json(settlementBody({ fund: { ...fund, purchases: '-120000.00', expected: '600000.00',
        counted: '600000.00', difference: '0.00' } }))
      : json(historyBody()));
    await selectPeriod('4');
    const envelope = panel('Fondo de compras');
    // The net of the window is negative: the row keeps the sign of the reversal it states (L7).
    expect(within(envelope).getByText('+ Bs 120.000,00')).toBeInTheDocument();
    // The envelope still closes: 480.000 − (−120.000) = 600.000.
    expect(within(envelope).getAllByText('Bs 600.000,00').length).toBeGreaterThan(1);
  });

  it('renders a settlement that counted more material than the period bought', async () => {
    const overRows = scrapRows.map(row => ({ ...row, delivered_milli: row.bought_milli + 375 }));
    setup(token => token === '4'
      ? json(settlementBody({ materials: { used_units: 78, used_delivered_units: 80,
        scrap_milli: 214500, scrap_delivered_milli: 216000, materials: overRows } }))
      : json(historyBody()));
    await selectPeriod('4');
    // The delivered quantity is the counted one, and it may exceed what the period bought (L7).
    expect(within(panel('Lo que dejó el período')).getByText('80 u · 216,000 kg'))
      .toBeInTheDocument();
    const scrap = panel('Recambio');
    expect(within(scrap).getByText('80 u')).toBeInTheDocument();
    expect(within(scrap).getByText('216,000')).toBeInTheDocument();
    expect(within(scrap).getByText('92,675')).toBeInTheDocument();
    // The bought side never moves with the count.
    expect(within(scrap).getAllByText('214,500').length).toBeGreaterThan(0);
  });

  it('scopes the footnote to the accounts of the acta and never freezes the shelf', async () => {
    setup();
    await selectPeriod('4');
    // What the settlement froze is the money and the counts, not what moves today (S6).
    expect(await screen.findByText(/la plata y los conteos del cierre/)).toBeInTheDocument();
    expect(screen.getByText(/la estantería es la de hoy/i)).toBeInTheDocument();
    expect(screen.getByText(/el ranking es del período/)).toBeInTheDocument();
    expect(screen.queryByText(/todo lo de arriba está congelado/)).toBeNull();

    await selectPeriod('5');
    await waitFor(() => expect(screen.getByText('En vivo, se mueve con cada venta'))
      .toBeInTheDocument());
    // The live period moves too, but the shelf is equally today's and the ranking its own.
    expect(screen.getByText(/la estantería es la de hoy/i)).toBeInTheDocument();
    expect(screen.getByText(/el ranking es del período/)).toBeInTheDocument();
  });

  it('renders the cash of today with the movements of the window, above the period accounts', async () => {
    setup(token => token === '4' ? json(settlementBody()) : json(historyBody()));
    await selectPeriod('4');
    const card = panel('Caja de hoy');
    // The expectation of the drawer as it stands today, with the identity that produces it (S12).
    expect(within(card).getByText('Bs 2.257.800,00')).toBeInTheDocument();
    expect(card).toHaveTextContent(/Lo que quedó en el cajón al cerrar el último corte/);
    expect(card).toHaveTextContent(/ventas en efectivo/);
    expect(card).toHaveTextContent(/gastos/);
    // The window it covers, from the cut of the last closed settlement.
    expect(card).toHaveTextContent(/Desde el corte del/);
    expect(card).toHaveTextContent('01/11/2026 · 08:00 (hora Bolivia)');
    expect(within(card).getByText('Bs 500.000,00')).toBeInTheDocument();
    // The movements, with their kind, their amount and their moment (S13).
    const rows = within(card).getAllByRole('row');
    expect(rows).toHaveLength(4);
    expect(rows[1]).toHaveTextContent('Aporte');
    expect(rows[1]).toHaveTextContent('Bs 10.000,00');
    expect(rows[1]).toHaveTextContent('01/11/2026 · 08:00');
    expect(rows[2]).toHaveTextContent('Gasto');
    expect(rows[2]).toHaveTextContent('Bs 2.500,00');
    expect(rows[3]).toHaveTextContent('Recaudación');
    expect(rows[3]).toHaveTextContent('Bs 50.000,00');
    // The card is above the period accounts: it is the first region of the answer.
    const regions = screen.getAllByRole('region').map(region => region.getAttribute('aria-labelledby'));
    expect(regions.indexOf('metrics-today-title'))
      .toBeLessThan(regions.indexOf('metrics-left-title'));
  });

  it('says with words that today has no movements instead of a zero row', async () => {
    setup(token => token === '4'
      ? json(settlementBody({ today: { ...today, movements: [] } }))
      : json(historyBody()));
    await selectPeriod('4');
    const card = panel('Caja de hoy');
    expect(within(card).getByText('Sin movimientos desde el último corte.')).toBeInTheDocument();
    expect(within(card).queryByRole('table')).toBeNull();
    expect(within(card).queryByText('Bs 0,00')).toBeNull();
  });

  it('says that today starts at the beginning of the branch when there is no cut', async () => {
    const noCut = { since: null, opening: '0.00', sales: '100.00', expenses: '20.00',
      expected: '80.00', movements: [{ kind: 'gasto', amount: '20.00',
        occurred_at: '2026-11-02T09:30:00Z' }] };
    // The whole history is the period the screen opens on, and today is stated there too: a branch
    // that never closed a settlement still has a drawer (S12).
    setup(() => json(historyBody({ today: noCut })));
    const card = await screen.findByRole('region', { name: 'Caja de hoy' });
    expect(within(card).getByText('Bs 80,00')).toBeInTheDocument();
    expect(within(card).getByText('Desde el comienzo de la sucursal')).toBeInTheDocument();
    expect(within(card).getByText('Gasto')).toBeInTheDocument();
    expect(within(card).getByText('Bs 20,00')).toBeInTheDocument();
  });

  it('renders the cash of today even when the period on screen is the history', async () => {
    const noCut = { since: null, opening: '0.00', sales: '0.00', expenses: '0.00',
      expected: '0.00', movements: [] };
    setup(token => token === 'all' ? json(historyBody({ today: noCut })) : json(settlementBody()));
    // The history has no drawer of its own and still shows today's drawer of the branch.
    expect(await screen.findByText('El acumulado no tiene caja: la caja se cierra en cada rendición.'))
      .toBeInTheDocument();
    const card = panel('Caja de hoy');
    expect(within(card).getByText('Desde el comienzo de la sucursal')).toBeInTheDocument();
    expect(within(card).getByText('Sin movimientos desde el último corte.')).toBeInTheDocument();
    // The line that says the period below counts the same drawer belongs to the live period only.
    expect(within(card).queryByText(/Es el mismo cajón que cuenta el período de abajo/)).toBeNull();
  });

  it('says that today is the same drawer the live period below is counting', async () => {
    setup();
    await selectPeriod('5');
    const card = panel('Caja de hoy');
    expect(within(card).getByText(/Es el mismo cajón que cuenta el período de abajo/)).toBeInTheDocument();
    expect(within(card).getByText('Bs 2.257.800,00')).toBeInTheDocument();
  });

  it('refuses a payload the server could not have written and offers the same retry', async () => {
    const { calls } = setup(token => {
      if (token !== 'all') throw new Error('Unexpected mocked period: ' + token);
      return json(historyBody({ sales: { ...sales, total: '4286400.0' } }));
    });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Respuesta inválida del servidor.');
    // A refused answer is not shown: no figure and no panel survive it.
    expect(screen.queryByRole('region', { name: 'Plata del período' })).toBeNull();
    expect(screen.queryByText('Bs 4.286.400,00')).toBeNull();
    fireEvent.click(within(alert).getByRole('button', { name: 'Reintentar' }));
    await waitFor(() => expect(calls()).toEqual(['/api/metrics?period=all', '/api/metrics?period=all']));
    expect(await screen.findByRole('alert')).toHaveTextContent('Respuesta inválida del servidor.');
  });
});
