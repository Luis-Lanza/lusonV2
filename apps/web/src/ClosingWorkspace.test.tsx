import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ClosingWorkspace from './ClosingWorkspace';

const csrf = 'c'.repeat(43);
const branches = [{ id: 2, name: 'Sopocachi' }, { id: 3, name: 'Miraflores' }];
const json = (body: unknown, status = 200) => new Response(
  typeof body === 'string' ? body : JSON.stringify(body),
  { status, headers: { 'Content-Type': 'application/json' } });

const countedLine = (overrides: Record<string, unknown> = {}) => ({
  variant_id: 1, catalog_entry_id: 1, brand: 'Bosch', model: 'S4', capacity_ah: '45',
  polarity: 'L', expected_quantity: 12, counted_quantity: 12, ...overrides,
});

/** One row of the branch's own catalogue: every variant of the branch, stock or not, as the
 * inventory read publishes it: the variant identity of its kind plus its three stock numbers. */
const catalogueItem = ({ brand = 'Bosch', model = 'S4', capacity_ah = '45', polarity = 'L',
  ...overrides }: Record<string, unknown> = {}) => ({
  variant_id: 1, catalog_entry_id: 1, kind: 'battery', name: `${brand} · ${model}`,
  detail: `${capacity_ah} Ah · ${polarity}`,
  battery: { brand, model, capacity_ah, polarity }, fields: null,
  existing: 12, reserved: 0, available: 12, ...overrides,
});

/** One used line of the material sheet: whole units per model (S7, S8). */
const usedMaterial = (model: string, expected: string, counted: string | null) => ({
  kind: 'used', model, material_id: null, material: null, unit: 'unit', expected_quantity: expected,
  counted_quantity: counted,
  difference: counted === null ? null : String(Number(counted) - Number(expected)),
  delivered_quantity: counted });

/** One scrap line of the material sheet: kilograms per material, at three decimals (S7, S8). */
const scrapMaterial = (material_id: number, material: string, expected: string,
  counted: string | null) => ({ kind: 'scrap', model: null, material_id, material, unit: 'kg',
  expected_quantity: expected, counted_quantity: counted,
  difference: counted === null ? null : (Number(counted) - Number(expected)).toFixed(3),
  delivered_quantity: counted });

/** The sheet of the artboard: one battery of the 31-100 and 4,300 kg of lead are missing (S8). */
const materialSheet = (counts: ReadonlyMap<string, string | null>) => [
  usedMaterial('24F-45', '6', counts.get('used:24F-45') ?? null),
  usedMaterial('27-60', '12', counts.get('used:27-60') ?? null),
  usedMaterial('31-100', '9', counts.get('used:31-100') ?? null),
  scrapMaterial(1, 'Cobre', '12.400', counts.get('scrap:1') ?? null),
  scrapMaterial(2, 'Aluminio', '8.750', counts.get('scrap:2') ?? null),
  scrapMaterial(3, 'Plomo', '84.500', counts.get('scrap:3') ?? null),
  scrapMaterial(4, 'Bronce', '3.100', counts.get('scrap:4') ?? null),
];

/**
 * The branch catalogue as the screen reads it (`/api/inventory`): the three variants the sheet of
 * the cut already holds, the battery the branch counted and the system had none of (variant 20) and
 * a sibling variant the branch does hold (21), so an addition is never offered for it.
 */
const cataloguePage = (search: string) => {
  const items = [catalogueItem(),
    catalogueItem({ variant_id: 2, polarity: 'R', model: 'Power', capacity_ah: '110', existing: 9, available: 9 }),
    catalogueItem({ variant_id: 3, model: 'Blue', capacity_ah: '60', existing: 14, available: 14 }),
    catalogueItem({ variant_id: 20, catalog_entry_id: 11, brand: 'Toyo', model: 'NS60',
      capacity_ah: '65', polarity: 'R', existing: 0, available: 0 }),
    catalogueItem({ variant_id: 21, catalog_entry_id: 11, brand: 'Toyo', model: 'NS60',
      capacity_ah: '65', polarity: 'L', existing: 4, available: 4 })].filter(item =>
    search === '' || `${item.battery.brand} ${item.battery.model}`.toLowerCase().includes(search.toLowerCase()));
  return { location: { id: 2, name: 'Sopocachi' }, page: 1, page_size: 50,
    total_variants: items.length, items };
};

/**
 * The server of these tests: it holds the settlement of Sopocachi and applies the requests the
 * screen sends, so a save, a refusal and a reload are the real conversation and not a stub.
 * `bootstrap` is the first settlement of the branch (S11): no inherited fund, no sales, an
 * empty till, where only a contribution the Admin declares can leave a fund behind.
 * `uncounted` leaves one line without a quantity on purpose: the sheet is seeded with the expected
 * one on every opening (S1), so that shape is only the leftover of a settlement older than the
 * seed and it is read defensively (L3).
 */
function server(options: { opened?: boolean, status?: string, refuse?: unknown, bootstrap?: boolean,
  contributed?: string, countedCash?: string, fund?: string, uncounted?: number,
  purchaseCounted?: string | null, purchaseCash?: string | null,
  materials?: 'sheet' | 'empty',
  // The cash purchases of the period: a branch with an empty envelope can still spend of it, and
  // its expectation is then negative — the envelope carries its sign (S3, S11).
  purchases?: string,
  // Whether the branch has a commission the warehouse fixed: without one it cannot propose.
  commission?: string | null,
  corrections?: unknown[] } = {}) {
  const seeded: readonly (readonly [number, number])[] = [[1, 12], [2, 9], [3, 14]];
  const state = {
    opened: options.opened ?? true,
    status: options.status ?? 'open',
    bootstrap: options.bootstrap ?? false,
    // The seed of the count sheet: every line carries the quantity the system expected (S1).
    counted: new Map<number, number | null>(seeded.map(([id, value]) =>
      [id, id === options.uncounted ? null : value])),
    // A settlement that was already proposed states its drawer; an open one does not.
    countedCash: options.countedCash
      ?? ((options.status ?? 'open') === 'open' ? null : '6980.00'),
    contributedCash: options.contributed ?? '0.00',
    fund: options.fund ?? ((options.status ?? 'open') === 'open' ? null : '900.00'),
    // The second envelope: the warehouse's own draft, frozen by the proposal (S1, S5, S6).
    purchaseCounted: options.purchaseCounted
      ?? ((options.status ?? 'open') === 'open' ? null : '375.00'),
    purchaseCash: options.purchaseCash
      ?? ((options.status ?? 'open') === 'open' ? null : '1500.00'),
    observation: '',
    closed: (options.status ?? 'open') === 'closed',
    rounds: [] as unknown[],
    // The published corrections of the closed settlement: the accepted ones and the pending one.
    corrections: (options.corrections ?? []) as unknown[],
    // The third account: what the warehouse typed into the material sheet (S7, S8, S9).
    materialCounts: options.materials === 'empty' ? null
      : new Map<string, string | null>([
        ['used:24F-45', '6'], ['used:27-60', '12'], ['used:31-100', '8'],
        ['scrap:1', '12.400'], ['scrap:2', '8.750'], ['scrap:3', '80.200'], ['scrap:4', '3.100'],
      ]),
    // The rows the admin added by hand: a variant the cut did not know, so no expected quantity.
    added: new Map<number, number>(),
  };
  const calls: { url: string; init: RequestInit }[] = [];
  const document = () => {
    const lines = [countedLine({ variant_id: 1, counted_quantity: state.counted.get(1) ?? null }),
      countedLine({ variant_id: 2, polarity: 'R', expected_quantity: 9, model: 'Power', capacity_ah: '110',
        counted_quantity: state.counted.get(2) ?? null }),
      countedLine({ variant_id: 3, polarity: 'L', expected_quantity: 14, model: 'Blue', capacity_ah: '60',
        counted_quantity: state.counted.get(3) ?? null }),
      ...[...state.added.entries()].sort((left, right) => left[0] - right[0]).map(([id, counted]) =>
        countedLine({ variant_id: id, catalog_entry_id: 11, brand: 'Toyo', model: 'NS60',
          capacity_ah: '65', polarity: 'R', expected_quantity: 0, counted_quantity: counted }))];
    const opened = state.status !== 'open';
    const bootstrap = state.bootstrap;
    // An open settlement publishes the period's totals as zero: they are recorded at the proposal.
    const opening = bootstrap ? '0.00' : '800.00';
    const expected = bootstrap ? '0.00' : opened ? '7015.00' : '800.00';
    const countedCash = state.countedCash;
    const contributedCash = state.contributedCash;
    const fund = state.fund;
    const difference = countedCash === null ? null
      : (Number(countedCash) - Number(expected)).toFixed(2);
    // A published derived amount carries its sign only when it is negative.
    const signed = difference;
    // counted + contribution − fund: the contribution lifts the bound the fund is taken from.
    const taken = countedCash === null || fund === null
      ? null : (Number(countedCash) + Number(contributedCash) - Number(fund)).toFixed(2);
    // The purchase fund is derived on every read: the previous closure's new amount, the purchases
    // of the window paid in cash and the expectation those two produce (S3, S5).
    const purchaseOpening = bootstrap ? '0.00' : '2000.00';
    const purchases = options.purchases ?? (bootstrap ? '0.00' : '1621.00');
    const purchaseExpected = (Number(purchaseOpening) - Number(purchases)).toFixed(2);
    const purchaseCounted = state.purchaseCounted;
    const purchaseDifference = purchaseCounted === null ? null
      : (Number(purchaseCounted) - Number(purchaseExpected)).toFixed(2);
    return {
      id: 1, branch_location_id: 2, branch_name: 'Sopocachi', status: state.closed ? 'closed' : state.status,
      period_start: '2026-08-12T18:00:00Z', cut_at: '2026-09-12T18:30:00Z',
      closed_at: state.closed ? '2026-09-12T18:31:00Z' : null,
      commission_rate_percent: opened ? '4.50' : null,
      opening_cash: opening,
      cash_sales: !bootstrap && opened ? '6430.00' : '0.00',
      cash_expenses: !bootstrap && opened ? '215.00' : '0.00',
      cash_effective: !bootstrap && opened ? '-215.00' : '0.00',
      expected_cash: expected,
      counted_cash: countedCash,
      cash_difference: signed,
      contributed_cash: contributedCash,
      closing_cash: fund,
      taken_cash: taken,
      sales_total: !bootstrap && opened ? '32480.00' : '0.00',
      commission_amount: !bootstrap && opened ? '1461.60' : '0.00',
      card_total: !bootstrap && opened ? '3240.00' : '0.00',
      transfer_total: !bootstrap && opened ? '1180.00' : '0.00',
      qr_total: !bootstrap && opened ? '2760.00' : '0.00',
      observation: state.observation, opened_by_account_id: 1,
      purchase_fund_opening: purchaseOpening, purchases_total: purchases, purchases_cash: purchases,
      purchase_fund_expected: purchaseExpected, purchase_fund_counted: purchaseCounted,
      purchase_fund_difference: purchaseDifference, purchase_fund_cash: state.purchaseCash,
      count_lines: lines,
      material_lines: state.materialCounts === null ? [] : materialSheet(state.materialCounts),
      rounds: state.rounds, expenses: [], corrections: state.corrections,
    };
  };
  const fetcher = vi.fn<typeof fetch>(async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.startsWith('/api/closings?')) {
      return json({ page: 1, page_size: 25, total_closings: state.opened ? 1 : 0,
        closings: state.opened ? [{ ...document(), count_lines: [], rounds: [] }] : [] });
    }
    if (url === '/api/closings' && init.method === 'POST') {
      state.opened = true;
      return json(document(), 201);
    }
    if (url === '/api/closings/1') return json(document());
    if (url === '/api/closings/branches/2/commission') {
      const rate = options.commission === undefined ? '4.50' : options.commission;
      return rate === null ? json({ error: 'not_found' }, 404)
        : json({ branch_location_id: 2, commission_rate_percent: rate });
    }
    if (url === '/api/closings/1/count' && init.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { lines: { variant_id: number; counted_quantity: number }[] };
      for (const line of body.lines) {
        // A variant the cut did not know is added to the sheet with no expected quantity at all.
        if (line.variant_id > 3) state.added.set(line.variant_id, line.counted_quantity);
        else state.counted.set(line.variant_id, line.counted_quantity);
      }
      return json(document());
    }
    if (url.startsWith('/api/inventory?')) {
      const search = new URLSearchParams(url.slice(url.indexOf('?') + 1)).get('search') ?? '';
      return json(cataloguePage(search));
    }
    if (url === '/api/closings/1/materials' && init.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { lines: { kind: string; model?: string;
        material_id?: number; counted_quantity: string }[] };
      // A sheet the period bought nothing into is the sheet this route writes into: the line the
      // warehouse counted is added to it, never refused for being new.
      state.materialCounts ??= new Map<string, string | null>();
      for (const line of body.lines) {
        const key = line.kind === 'used' ? `used:${line.model}` : `scrap:${line.material_id}`;
        state.materialCounts.set(key, line.counted_quantity);
      }
      return json(document());
    }
    if (url === '/api/closings/1/cash' && init.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { counted_cash: string | null;
        contributed_cash: string; closing_cash: string | null; observation: string;
        purchase_fund_counted?: string | null; purchase_fund_cash?: string | null };
      state.countedCash = body.counted_cash;
      state.contributedCash = body.contributed_cash;
      state.fund = body.closing_cash;
      state.observation = body.observation;
      // An absent key is the contract's own "nobody counted the envelope", never a zero.
      state.purchaseCounted = body.purchase_fund_counted ?? null;
      state.purchaseCash = body.purchase_fund_cash ?? null;
      return json(document());
    }
    if (url === '/api/closings/1/propose' && init.method === 'POST') {
      if (options.refuse) return json(options.refuse, 409);
      state.status = 'proposed';
      state.rounds = [{ id: 1, round: 1, offer: {
        period_start: '2026-08-12T18:00:00Z', cut_at: '2026-09-12T18:30:00Z',
        sales_total: state.bootstrap ? '0.00' : '32480.00',
        commission_rate_percent: '4.50', commission_amount: state.bootstrap ? '0.00' : '1461.60',
        cash_sales: state.bootstrap ? '0.00' : '6430.00',
        cash_expenses: state.bootstrap ? '0.00' : '215.00', card_total: '3240.00',
        transfer_total: '1180.00', qr_total: '2760.00',
        counted_cash: state.countedCash, contributed_cash: state.contributedCash,
        closing_cash: state.fund,
        purchase_fund_counted: state.purchaseCounted, purchase_fund_cash: state.purchaseCash,
        observation: '', count_lines: [] }, proposed_by_account_id: 1,
        proposed_at: '2026-09-12T18:31:00Z', decision: '', decision_reason: '',
        decided_by_account_id: null, decided_at: null }];
      return json(document());
    }
    if (url === '/api/closings/1/corrections' && init.method === 'POST') {
      const body = JSON.parse(String(init.body)) as
        { reason: string; payload: Record<string, unknown> };
      const correction = { id: state.corrections.length + 1, closing_id: 1, status: 'proposed',
        reason: body.reason, payload: body.payload, proposed_by_account_id: 1,
        proposed_at: '2026-09-12T19:00:00Z', decided_by_account_id: null, decided_at: null,
        decision_reason: '', effects: [] };
      state.corrections = [...state.corrections, correction];
      return json(correction, 201);
    }
    throw new Error('Unexpected mocked URL: ' + url);
  });
  return { fetcher, calls, state, document,
    posts: (suffix: string) => calls.filter(call => call.url.endsWith(suffix) && call.init.method === 'POST') };
}

async function ready(h: ReturnType<typeof server>, branch = 2) {
  const view = render(<ClosingWorkspace csrf={csrf} branches={branches} fetcher={h.fetcher} />);
  fireEvent.change(screen.getByLabelText('Sucursal'), { target: { value: String(branch) } });
  await screen.findByRole('region', { name: 'Sucursal a rendir' });
  return view;
}
const sheet = () => screen.findByRole('region', { name: 'Conteo de stock' });
const rail = () => screen.getByRole('complementary', { name: 'Números de la caja' });
const chatarraRail = () => screen.getByRole('complementary', { name: 'Números del fondo de compras' });
const actionBar = () => screen.getByRole('region', { name: 'Acciones de la rendición' });
const proposeButton = () => within(actionBar()).getByRole('button', { name: 'Proponer a la sucursal' });
const tabList = () => screen.getByRole('tablist', { name: 'Rendición' });
const cashTab = () => within(tabList()).getByRole('tab', { name: /^Caja/ });
const scrapTab = () => within(tabList()).getByRole('tab', { name: /^Chatarra/ });
const balanceStrip = () => screen.getByRole('group', { name: 'Saldos de la rendición' });
const materials = () => screen.findByRole('region', { name: 'Materiales rendidos' });
/** The scrap tab of the settlement: the envelope and the material sheet live there (S10, S13). */
function openScrapTab() { fireEvent.click(scrapTab()); }
function openCashTab() { fireEvent.click(cashTab()); }

/** States the drawer of the artboard; the sheet already coincides with the system (S1). */
async function completeTheSheet() {
  fireEvent.change(screen.getByLabelText('Caja contada (Bs)'), { target: { value: '6.980,00' } });
  fireEvent.change(screen.getByLabelText('Monto que dejás en la caja (Bs)'), { target: { value: '900,00' } });
  fireEvent.click(screen.getByRole('button', { name: 'Guardar borrador' }));
  await waitFor(() => expect(proposeButton()).toBeEnabled());
}

describe('opening and resuming a settlement', () => {
  it('opens the settlement of the chosen branch with the only field the contract takes', async () => {
    const h = server({ opened: false });
    await ready(h);
    const scope = screen.getByRole('region', { name: 'Sucursal a rendir' });
    expect(await within(scope).findByText('La sucursal no tiene una rendición abierta.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Abrir rendición de cuentas' }));
    await screen.findByRole('heading', { name: 'Rendición de cuentas · Sopocachi' });
    expect(h.posts('/api/closings')).toHaveLength(1);
    expect(h.posts('/api/closings')[0].init.body).toBe('{"branch_location_id":2}');
    expect(new Headers(h.posts('/api/closings')[0].init.headers).get('X-CSRF-Token')).toBe(csrf);
    // The sheet is the one the opening returned, not a client copy of it: every line arrives with
    // the quantity the system expected, so the admin writes nothing to make it coincide (S1).
    expect(within(await sheet()).getByLabelText('Contado de Bosch Power R · 110 Ah')).toHaveValue('9');
  });

  it('resumes the live settlement of a branch and says it holds the branch', async () => {
    const h = server({ status: 'proposed' });
    await ready(h);
    await screen.findByRole('heading', { name: 'Rendición de cuentas · Sopocachi' });
    const scope = screen.getByRole('region', { name: 'Sucursal a rendir' });
    expect(within(scope).getByText(/ya tenía la rendición #1 abierta/)).toBeInTheDocument();
    expect(within(scope).getByText('Sucursal congelada')).toBeInTheDocument();
    expect(within(scope).getByText('12 ago 2026 → 12 sept 2026')).toBeInTheDocument();
    expect(h.posts('/api/closings')).toHaveLength(0);
    // A settlement the branch is deciding is read-only: no count field, no second proposal.
    expect(within(await sheet()).queryByLabelText('Contado de Bosch Power R · 110 Ah')).not.toBeInTheDocument();
    expect(proposeButton()).toBeDisabled();
    expect(proposeButton()).toHaveAccessibleDescription(/decisión de la sucursal/);
  });

  it('names the live settlement when the server refuses a second opening', async () => {
    const h = server({ opened: false });
    const fetcher = vi.fn<typeof fetch>(async (input, init = {}) => {
      const url = String(input);
      if (url === '/api/closings' && init?.method === 'POST') {
        // The branch now holds a settlement: the history that follows has to name it.
        h.state.opened = true;
        return json({ error: 'settlement_live', branch_location_id: 2, closing_id: 1 }, 409);
      }
      return h.fetcher(input as string, init as RequestInit);
    });
    render(<ClosingWorkspace csrf={csrf} branches={branches} fetcher={fetcher} />);
    fireEvent.change(screen.getByLabelText('Sucursal'), { target: { value: '2' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Abrir rendición de cuentas' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/la rendición #1 abierta/);
    // The refusal sends the operator to the document that holds the branch.
    expect(await screen.findByRole('heading', { name: 'Rendición de cuentas · Sopocachi' })).toBeInTheDocument();
  });
});

describe('the count sheet (S4)', () => {
  it('shows the frozen expected quantity, the seeded count and the running difference', async () => {
    const h = server();
    await ready(h);
    const count = await sheet();
    const power = within(count).getByLabelText('Contado de Bosch Power R · 110 Ah').closest('tr')!;
    // The row opens carrying the expected quantity: it is no longer a cell waiting to be filled.
    expect(within(power).getByLabelText('Contado de Bosch Power R · 110 Ah')).toHaveValue('9');
    expect(within(power).getAllByRole('cell')[1]).toHaveTextContent('9');
    expect(within(power).getByText('—')).toBeInTheDocument();
    expect(within(power).queryByText('Pendiente')).not.toBeInTheDocument();
    expect(power).not.toHaveClass('pending');
    fireEvent.change(within(power).getByLabelText('Contado de Bosch Power R · 110 Ah'), { target: { value: '8' } });
    expect(within(power).getByText('−1')).toBeInTheDocument();
    fireEvent.change(within(power).getByLabelText('Contado de Bosch Power R · 110 Ah'), { target: { value: '11' } });
    expect(within(power).getByText('+2')).toBeInTheDocument();
    // The expected quantity is the database's snapshot and never follows the count (S4).
    expect(within(power).getByText('9')).toBeInTheDocument();
  });

  it('counts the differences against the system in the draft and marks the changed rows (S2)', async () => {
    const h = server();
    await ready(h);
    const count = await sheet();
    const power = within(count).getByLabelText('Contado de Bosch Power R · 110 Ah').closest('tr')!;
    // Nothing was written yet: the sheet coincides with the system, and the rail says so (S1).
    expect(within(count).getByText('Conteo coincidente')).toBeInTheDocument();
    expect(within(actionBar()).getByText('Conteo coincidente')).toBeInTheDocument();
    expect(power).not.toHaveClass('changed');
    fireEvent.change(within(power).getByLabelText('Contado de Bosch Power R · 110 Ah'), { target: { value: '8' } });
    // One difference: the rail counts it and the row itself says it, in words and not by colour (S2).
    expect(within(count).getByText('1 diferencia contra el sistema')).toBeInTheDocument();
    expect(within(actionBar()).getByText('1 diferencia contra el sistema')).toBeInTheDocument();
    expect(power).toHaveClass('changed');
    expect(within(power).getByText('No coincide')).toBeInTheDocument();
    // A line edited back to the expected quantity is not a difference any more.
    fireEvent.change(within(power).getByLabelText('Contado de Bosch Power R · 110 Ah'), { target: { value: '9' } });
    expect(within(count).getByText('Conteo coincidente')).toBeInTheDocument();
    expect(power).not.toHaveClass('changed');
    expect(within(power).queryByText('No coincide')).not.toBeInTheDocument();
    // The count is the client's own draft: nothing of it was sent to the server (S2).
    expect(h.posts('/api/closings/1/count')).toHaveLength(0);
  });

  it('reads a line the document does not state as the expected quantity (S1)', async () => {
    // Defensive only: the seed gives every line a quantity, so a line without one is the leftover
    // of a settlement opened before the seed (L3), and it is read as coinciding.
    const h = server({ uncounted: 3 });
    await ready(h);
    const count = await sheet();
    const blue = within(count).getByLabelText('Contado de Bosch Blue L · 60 Ah').closest('tr')!;
    expect(within(blue).getByLabelText('Contado de Bosch Blue L · 60 Ah')).toHaveValue('14');
    expect(within(blue).getByText('—')).toBeInTheDocument();
    expect(within(blue).queryByText('Pendiente')).not.toBeInTheDocument();
    expect(within(count).getByText('Conteo coincidente')).toBeInTheDocument();
    // The drawer alone gates the offer: the line that carries no quantity blocks nothing (S1, S3).
    fireEvent.change(screen.getByLabelText('Caja contada (Bs)'), { target: { value: '800,00' } });
    fireEvent.change(screen.getByLabelText('Monto que dejás en la caja (Bs)'), { target: { value: '500,00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar borrador' }));
    await waitFor(() => expect(proposeButton()).toBeEnabled());
    expect(proposeButton()).not.toHaveAccessibleDescription(/por contar/);
  });

  it('writes a zero the admin counted as an explicit zero (S4)', async () => {
    const h = server();
    await ready(h);
    const count = await sheet();
    const blue = within(count).getByLabelText('Contado de Bosch Blue L · 60 Ah').closest('tr')!;
    fireEvent.change(within(blue).getByLabelText('Contado de Bosch Blue L · 60 Ah'), { target: { value: '0' } });
    expect(within(blue).getByText('−14')).toBeInTheDocument();
    expect(within(count).getByText('1 diferencia contra el sistema')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Caja contada (Bs)'), { target: { value: '6.980,00' } });
    fireEvent.change(screen.getByLabelText('Monto que dejás en la caja (Bs)'), { target: { value: '900,00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar borrador' }));
    await waitFor(() => expect(h.posts('/api/closings/1/count')).toHaveLength(1));
    // Zero is a count like any other: it leaves the screen as the explicit 0, never as an absent one.
    expect(JSON.parse(String(h.posts('/api/closings/1/count')[0].init.body)))
      .toEqual({ lines: [{ variant_id: 3, counted_quantity: 0 }] });
  });

  it('filters the sheet locally, without reading the server again', async () => {
    const h = server();
    await ready(h);
    const count = await sheet();
    const reads = h.calls.length;
    fireEvent.change(within(count).getByLabelText('Buscar batería'), { target: { value: 'Blue' } });
    expect(within(count).getByText(/Blue/)).toBeInTheDocument();
    expect(within(count).queryByText(/Power/)).not.toBeInTheDocument();
    expect(h.calls).toHaveLength(reads);
  });
});

describe('proposing (S14)', () => {
  it('blocks the proposal only for the drawer it does not have, never for a sheet line (S1, S3)', async () => {
    const h = server();
    await ready(h);
    await sheet();
    // The sheet of the cut coincides with the system: the count side of the gate has no arm at all.
    expect(proposeButton()).toBeDisabled();
    expect(proposeButton()).toHaveAccessibleDescription(/Falta la caja contada y el fondo/);
    expect(proposeButton()).not.toHaveAccessibleDescription(/por contar/);
    expect(h.posts('/api/closings/1/propose')).toHaveLength(0);
  });

  it('enables the proposal without a single quantity written once the drawer is declared (S1, S3)', async () => {
    const h = server();
    await ready(h);
    fireEvent.change(await screen.findByLabelText('Caja contada (Bs)'), { target: { value: '6.980,00' } });
    fireEvent.change(screen.getByLabelText('Monto que dejás en la caja (Bs)'), { target: { value: '900,00' } });
    // Unsaved work is not an offer: the drawer is saved explicitly first.
    expect(proposeButton()).toBeDisabled();
    expect(proposeButton()).toHaveAccessibleDescription(/cambios sin guardar/);
    fireEvent.click(screen.getByRole('button', { name: 'Guardar borrador' }));
    await waitFor(() => expect(proposeButton()).toBeEnabled());
    // Not one line changed, so not one line is sent: the sheet already coincides with the system.
    expect(h.posts('/api/closings/1/count')).toHaveLength(0);
    expect(JSON.parse(String(h.posts('/api/closings/1/cash')[0].init.body))).toEqual({
      counted_cash: '6980.00', contributed_cash: '0.00', closing_cash: '900.00', observation: '' });
    fireEvent.click(proposeButton());
    await waitFor(() => expect(h.posts('/api/closings/1/propose')).toHaveLength(1));
    expect(h.posts('/api/closings/1/propose')[0].init.body).toBeUndefined();
    expect(await screen.findByText(/espera su aceptación o su rechazo/)).toBeInTheDocument();
  });

  it('publishes the refusal of the server by the fact it names, even when the sheet looks complete', async () => {
    // The screen cannot know this variant: only the settlement the server holds names it.
    const h = server({ refuse: { error: 'count_pending', variant_id: 9 } });
    await ready(h);
    await completeTheSheet();
    fireEvent.click(proposeButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Falta contar la variante 9 del conteo: sin el conteo completo no se puede proponer.');
  });

  it('shows the refusal of the server, named, when the proposal is rejected', async () => {
    const h = server({ refuse: { error: 'commission_rate_missing' } });
    await ready(h);
    await completeTheSheet();
    fireEvent.click(proposeButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'La sucursal no tiene porcentaje de comisión configurado: sin eso no se puede proponer.');
  });

  it('states the refusal beside the button that caused it, not at the top of the sheet', async () => {
    const h = server({ refuse: { error: 'commission_rate_missing' } });
    await ready(h);
    await completeTheSheet();
    fireEvent.click(proposeButton());
    // The button lives in the bottom bar and the sheet is long: a refusal rendered at the top of it
    // is a refusal the operator never reads.
    expect(await within(actionBar()).findByRole('alert')).toHaveTextContent(
      'La sucursal no tiene porcentaje de comisión configurado: sin eso no se puede proponer.');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  it('keeps the refusal at the top, with a reload, when no settlement is on screen', async () => {
    // Nothing to attach the refusal to: the operator is told why the branch has no document and
    // offered the read again.
    const h = server({ opened: false });
    const fetcher = vi.fn<typeof fetch>(async (input, init = {}) => {
      if (String(input) === '/api/closings' && init?.method === 'POST') {
        return json({ error: 'service_unavailable' }, 503);
      }
      return h.fetcher(input as string, init as RequestInit);
    });
    render(<ClosingWorkspace csrf={csrf} branches={branches} fetcher={fetcher} />);
    fireEvent.change(screen.getByLabelText('Sucursal'), { target: { value: '2' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Abrir rendición de cuentas' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('El servicio no está disponible. No pudimos confirmar la operación.');
    expect(within(alert).getByRole('button', { name: 'Recargar la rendición' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Acciones de la rendición' })).not.toBeInTheDocument();
  });
});

describe('the numbers rail (S8, S9, S13)', () => {
  it('shows the expected drawer, the counted one and the difference of both signs', async () => {
    const h = server();
    await ready(h);
    await sheet();
    fireEvent.change(screen.getByLabelText('Caja contada (Bs)'), { target: { value: '795,00' } });
    expect(within(rail()).getByText('− Bs 5,00')).toBeInTheDocument();
    expect(within(rail()).getByText('Faltante')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Caja contada (Bs)'), { target: { value: '810,00' } });
    expect(within(rail()).getByText('+ Bs 10,00')).toBeInTheDocument();
    expect(within(rail()).getByText('Sobrante')).toBeInTheDocument();
    expect(within(rail()).getByText('Caja esperada').parentElement).toHaveTextContent('Bs 800,00');
  });

  it('derives the expected drawer from the facts and never from the commission', async () => {
    const h = server({ status: 'proposed' });
    await ready(h);
    await screen.findByRole('heading', { name: 'Rendición de cuentas · Sopocachi' });
    const aside = rail();
    expect(within(aside).getByText('Fondo heredado').parentElement).toHaveTextContent('Bs 800,00');
    expect(within(aside).getByText('Ventas en efectivo').parentElement).toHaveTextContent('Bs 6.430,00');
    expect(within(aside).getByText('Gastos del período').parentElement).toHaveTextContent('− Bs 215,00');
    // 800 + 6.430 − 215: the commission of Bs 1.461,60 is inside no part of it (S9).
    expect(within(aside).getByText('Caja esperada').parentElement).toHaveTextContent('Bs 7.015,00');
    expect(within(aside).getByText('Comisión').parentElement).toHaveTextContent('Bs 1.461,60');
    expect(within(aside).getByText('Porcentaje congelado').parentElement).toHaveTextContent('4,50 %');
    expect(within(aside).getByText('Ventas sobre precio de venta').parentElement).toHaveTextContent('Bs 32.480,00');
    // The commission base is every sale of the period, so the electronic collection is inside it:
    // the note states it where the warehouse reads the commission (S13).
    expect(within(aside).getByText(/también lo cobrado por QR/)).toBeInTheDocument();
    expect(aside).not.toHaveTextContent('8.476,60');
  });

  it('reports QR as money collected outside the drawer and never adds it to the till', async () => {
    const h = server({ status: 'proposed' });
    await ready(h);
    await screen.findByRole('heading', { name: 'Rendición de cuentas · Sopocachi' });
    const aside = rail();
    const electronic = within(aside).getByText('Electrónico · fuera de la caja').closest('.closing-group')!;
    expect(within(electronic as HTMLElement).getByText('QR').parentElement).toHaveTextContent('Bs 2.760,00');
    expect(within(electronic as HTMLElement).getByText('Tarjeta').parentElement).toHaveTextContent('Bs 3.240,00');
    expect(within(aside).getByText('Caja esperada').parentElement).not.toHaveTextContent('2.760,00');
    expect(within(aside).getByText('Caja contada').parentElement).not.toHaveTextContent('2.760,00');
    // The block is read with the drawer it explains, before the commission it is calculated over:
    // the warehouse sees the QR amount while it counts, not after scrolling past the fund (S13).
    const commission = within(aside).getByText('Comisión del período').closest('.closing-group')!;
    expect(electronic.compareDocumentPosition(commission) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
  });

  it('takes the fund out of the counted drawer and leaves the difference alone', async () => {
    const h = server({ status: 'proposed' });
    await ready(h);
    await screen.findByRole('heading', { name: 'Rendición de cuentas · Sopocachi' });
    const aside = rail();
    expect(within(aside).getByText('Caja contada').parentElement).toHaveTextContent('Bs 6.980,00');
    expect(within(aside).getByText('Fondo que queda en la caja').parentElement).toHaveTextContent('− Bs 900,00');
    expect(within(aside).getByText('Te llevás al Almacén').parentElement).toHaveTextContent('Bs 6.080,00');
    // The difference of the drawer is not discounted from the fund nor absorbed by anything. The
    // drawer's block is scoped because the envelope below it publishes its own difference (S1, S8).
    const drawer = within(aside).getByText('Caja').closest('.closing-group') as HTMLElement;
    expect(within(drawer).getByText('− Bs 35,00')).toBeInTheDocument();
    expect(within(drawer).getByText('Faltante')).toBeInTheDocument();
  });
});

describe('the purchase fund, the second envelope (S1, S5, S6)', () => {
  // The envelope lives in the scrap tab, beside the material sheet it bought (S10, S13).
  const envelope = () => within(chatarraRail()).getByText('Fondo de compras')
    .closest('.closing-group') as HTMLElement;
  const countedField = () => screen.getByLabelText('Fondo contado (Bs)');
  const newField = () => screen.getByLabelText('Monto nuevo que dejás (Bs)');

  it('shows the inherited balance, the purchases and the expectation of the envelope', async () => {
    const h = server();
    await ready(h);
    await sheet();
    // Not one number of the envelope is inside the drawer of the other tab (S12).
    const aside = rail();
    expect(within(aside).getByText('Caja esperada').parentElement).toHaveTextContent('Bs 800,00');
    expect(within(aside).getByText('Caja esperada').parentElement).not.toHaveTextContent('379,00');
    openScrapTab();
    const group = envelope();
    expect(within(group).getByText('Saldo heredado').parentElement).toHaveTextContent('Bs 2.000,00');
    expect(within(group).getByText('Compras del período').parentElement)
      .toHaveTextContent('− Bs 1.621,00');
    // 2.000,00 inherited − 1.621,00 spent in cash: the envelope's own identity (S3).
    expect(within(group).getByText('Fondo esperado').parentElement).toHaveTextContent('Bs 379,00');
    // The envelope is settled apart from the till, and it says so where the warehouse reads it.
    expect(group).toHaveTextContent(/sobre aparte/i);
    expect(group).toHaveTextContent(/ninguna venta lo alimenta/i);
  });

  it('publishes the difference of the envelope with its sign and its name, like the drawer\'s', async () => {
    const h = server();
    await ready(h);
    await sheet();
    openScrapTab();
    fireEvent.change(countedField(), { target: { value: '375,00' } });
    expect(within(envelope()).getByText('− Bs 4,00')).toBeInTheDocument();
    expect(within(envelope()).getByText('Faltante')).toBeInTheDocument();
    fireEvent.change(countedField(), { target: { value: '400,00' } });
    expect(within(envelope()).getByText('+ Bs 21,00')).toBeInTheDocument();
    expect(within(envelope()).getByText('Sobrante')).toBeInTheDocument();
    // It is a reading of the draft: nothing of it left the screen yet.
    expect(h.posts('/api/closings/1/cash')).toHaveLength(0);
  });

  it('posts both keys of the envelope through the drawer draft', async () => {
    const h = server();
    await ready(h);
    await sheet();
    fireEvent.change(screen.getByLabelText('Caja contada (Bs)'), { target: { value: '6.980,00' } });
    fireEvent.change(screen.getByLabelText('Monto que dejás en la caja (Bs)'), { target: { value: '900,00' } });
    openScrapTab();
    fireEvent.change(countedField(), { target: { value: '375,00' } });
    fireEvent.change(newField(), { target: { value: '1.500,00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar borrador' }));
    await screen.findByText(/Borrador guardado/);
    expect(JSON.parse(String(h.posts('/api/closings/1/cash')[0].init.body))).toEqual({
      counted_cash: '6980.00', contributed_cash: '0.00', closing_cash: '900.00', observation: '',
      purchase_fund_counted: '375.00', purchase_fund_cash: '1500.00' });
    // The envelope the server now holds is the one the rail reads back after the save.
    expect(countedField()).toHaveValue('375,00');
    expect(newField()).toHaveValue('1.500,00');
    expect(within(envelope()).getByText('− Bs 4,00')).toBeInTheDocument();
    // The new amount opens the next period and buys used batteries and scrap only (S5, S6).
    expect(envelope()).toHaveTextContent(/baterías usadas y chatarra/i);
    expect(envelope()).toHaveTextContent(/período siguiente/i);
  });

  it('shows an envelope nobody counted as empty, with no difference text at all', async () => {
    const h = server();
    await ready(h);
    await sheet();
    openScrapTab();
    expect(h.state.purchaseCounted).toBeNull();
    expect(countedField()).toHaveValue('');
    expect(newField()).toHaveValue('');
    const group = envelope();
    expect(within(group).getByText('Sin contar')).toBeInTheDocument();
    // No name of a difference is published for an amount nobody counted (S8).
    expect(within(group).queryByText('Faltante')).not.toBeInTheDocument();
    expect(within(group).queryByText('Sobrante')).not.toBeInTheDocument();
    expect(within(group).queryByText('Sin diferencia')).not.toBeInTheDocument();
  });

  it('never blocks the proposal for the envelope (S5)', async () => {
    // The warehouse counted Bs 375,00 over an expectation of Bs 379,00: a shortage of Bs 4,00.
    const h = server({ purchaseCounted: '375.00' });
    await ready(h);
    await sheet();
    openScrapTab();
    expect(within(envelope()).getByText('− Bs 4,00')).toBeInTheDocument();
    await completeTheSheet();
    expect(h.posts('/api/closings/1/cash')[0].init.body).toBe(JSON.stringify({
      counted_cash: '6980.00', contributed_cash: '0.00', closing_cash: '900.00', observation: '',
      purchase_fund_counted: '375.00', purchase_fund_cash: null }));
    // The difference of the envelope is informed and never gates the offer, exactly like the till's
    // (S8): the proposal is enabled by the drawer alone.
    expect(proposeButton()).toBeEnabled();
    expect(proposeButton()).toHaveAccessibleDescription(
      'La rendición se puede proponer: la caja está declarada.');
    expect(h.posts('/api/closings/1/propose')).toHaveLength(0);
  });
});

describe('the two tabs and the three balances (S10, S13)', () => {
  it('opens on the cash tab and switches with the mouse, one panel at a time', async () => {
    const h = server();
    await ready(h);
    await sheet();
    expect(cashTab()).toHaveAttribute('aria-selected', 'true');
    expect(cashTab()).toHaveAttribute('tabindex', '0');
    expect(cashTab()).toHaveAttribute('aria-controls', 'closing-panel-caja');
    expect(scrapTab()).toHaveAttribute('aria-selected', 'false');
    expect(scrapTab()).toHaveAttribute('tabindex', '-1');
    expect(scrapTab()).toHaveAttribute('aria-controls', 'closing-panel-chatarra');
    expect(screen.getByRole('tabpanel', { name: 'Caja' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Materiales rendidos' })).not.toBeInTheDocument();
    openScrapTab();
    expect(scrapTab()).toHaveAttribute('aria-selected', 'true');
    expect(cashTab()).toHaveAttribute('aria-selected', 'false');
    expect(await materials()).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Conteo de stock' })).not.toBeInTheDocument();
    // One document, one closure, one acceptance: the tabs are navigation, never two life cycles
    // (S10), so switching between them writes nothing at all.
    expect(h.posts('/api/closings/1/count')).toHaveLength(0);
    expect(h.posts('/api/closings/1/materials')).toHaveLength(0);
    openCashTab();
    expect(await sheet()).toBeInTheDocument();
  });

  it('moves between the tabs with the arrows and takes the focus with it', async () => {
    const h = server();
    await ready(h);
    await sheet();
    cashTab().focus();
    fireEvent.keyDown(tabList(), { key: 'ArrowRight' });
    expect(scrapTab()).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(scrapTab());
    fireEvent.keyDown(tabList(), { key: 'ArrowLeft' });
    expect(cashTab()).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(cashTab());
    // The arrows wrap around the two tabs, and nothing else moves the selection.
    fireEvent.keyDown(tabList(), { key: 'ArrowLeft' });
    expect(scrapTab()).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(tabList(), { key: 'Enter' });
    expect(scrapTab()).toHaveAttribute('aria-selected', 'true');
    expect(h.posts('/api/closings/1/materials')).toHaveLength(0);
  });

  it('states the three balances above the tabs and takes each one to its own tab', async () => {
    const h = server();
    await ready(h);
    await sheet();
    const balances = () => within(balanceStrip()).getAllByRole('button');
    expect(balances().map(button => button.textContent)).toEqual([
      expect.stringContaining('Caja operativa'), expect.stringContaining('Fondo de compras'),
      expect.stringContaining('Materiales')]);
    // An amount nobody counted says so instead of showing a zero.
    expect(balances()[0]).toHaveTextContent('Sin contar');
    expect(balances()[1]).toHaveTextContent('Sin contar');
    // The materials are named in their own unit and never summed with the money (S13).
    expect(balances()[2]).toHaveTextContent('2 cuentas con diferencia');
    expect(balances()[0]).toHaveAttribute('aria-pressed', 'true');
    expect(balances()[1]).toHaveAttribute('aria-pressed', 'false');
    // A difference of the drawer is stated in the strip and marked on its tab, in words (S13).
    fireEvent.change(screen.getByLabelText('Caja contada (Bs)'), { target: { value: '795,00' } });
    expect(balances()[0]).toHaveTextContent('− Bs 5,00');
    expect(balances()[0]).toHaveTextContent('contada 795,00 · esperada 800,00');
    expect(cashTab()).toHaveTextContent('− Bs 5,00');
    expect(scrapTab()).toHaveTextContent('2 cuentas con diferencia');
    // Every balance selects the tab it belongs to, and both accounts of the scrap tab agree on it.
    fireEvent.click(balances()[1]);
    expect(scrapTab()).toHaveAttribute('aria-selected', 'true');
    expect(balances()[1]).toHaveAttribute('aria-pressed', 'true');
    expect(balances()[2]).toHaveAttribute('aria-pressed', 'true');
    expect(balances()[0]).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(balances()[0]);
    expect(cashTab()).toHaveAttribute('aria-selected', 'true');
    expect(balances()[0]).toHaveAttribute('aria-pressed', 'true');
    expect(balances()[1]).toHaveAttribute('aria-pressed', 'false');
    expect(h.posts('/api/closings/1/cash')).toHaveLength(0);
  });
});

describe('the material sheet of the scrap tab (S7, S8, S9)', () => {
  const table = async (name: string) => within(await materials()).getByRole('table', { name });

  it('renders both tables with their totals and the sign of every difference (S8)', async () => {
    const h = server();
    await ready(h);
    await sheet();
    openScrapTab();
    const used = await table('Baterías usadas · unidades por modelo');
    expect(within(used).getByText('Modelo')).toBeInTheDocument();
    expect(within(used).getByText('Compradas')).toBeInTheDocument();
    expect(within(used).getByText('Contadas')).toBeInTheDocument();
    const missing = within(used).getByLabelText('Contadas modelo 31-100').closest('tr')!;
    expect(within(missing).getByText('9')).toBeInTheDocument();
    expect(within(missing).getByLabelText('Contadas modelo 31-100')).toHaveValue('8');
    expect(within(missing).getByText('−1')).toBeInTheDocument();
    // The total row of a kind sums its own kind only, and only when it has more than one line.
    const usedTotal = used.querySelector('tfoot')!;
    expect(usedTotal).toHaveTextContent('27');
    expect(usedTotal).toHaveTextContent('26');
    expect(usedTotal).toHaveTextContent('−1');
    expect(usedTotal).not.toHaveTextContent('kg');
    const scrap = await table('Chatarra · kilogramos por material');
    const plomo = within(scrap).getByLabelText('Contados kg de Plomo').closest('tr')!;
    expect(within(plomo).getByText('84,500 kg')).toBeInTheDocument();
    expect(within(plomo).getByLabelText('Contados kg de Plomo')).toHaveValue('80,200');
    expect(within(plomo).getByText('−4,300')).toBeInTheDocument();
    // A line that coincides shows a dash, never a zero dressed as a difference.
    expect(within(scrap).getByLabelText('Contados kg de Cobre').closest('tr')).toHaveTextContent('—');
    const scrapTotal = scrap.querySelector('tfoot')!;
    expect(scrapTotal).toHaveTextContent('108,750 kg');
    expect(scrapTotal).toHaveTextContent('104,450 kg');
    expect(scrapTotal).toHaveTextContent('−4,300');
    // A kilogram and a unit are never added together: each total row stays in its own kind.
    expect(scrapTotal).not.toHaveTextContent('26');
    expect(usedTotal).not.toHaveTextContent('108,750');
    // What was counted goes to the warehouse and the branch starts the next period at zero (S9).
    expect(await materials()).toHaveTextContent(
      'Se lleva todo lo contado: 26 usadas y 104,450 kg de chatarra.');
    expect(await materials()).toHaveTextContent(/la sucursal queda en cero/);
  });

  it('reads the typed counts and the difference they leave, in the unit of the line (S8)', async () => {
    const h = server();
    await ready(h);
    await sheet();
    openScrapTab();
    const used = await table('Baterías usadas · unidades por modelo');
    fireEvent.change(within(used).getByLabelText('Contadas modelo 31-100'),
      { target: { value: '11' } });
    const row = within(used).getByLabelText('Contadas modelo 31-100').closest('tr')!;
    expect(within(row).getByText('+2')).toBeInTheDocument();
    expect(used.querySelector('tfoot')).toHaveTextContent('+2');
    // A fraction of a battery is not a count and is never typed into the cell.
    fireEvent.change(within(used).getByLabelText('Contadas modelo 31-100'),
      { target: { value: '7,5' } });
    expect(within(used).getByLabelText('Contadas modelo 31-100')).toHaveValue('11');
    const scrap = await table('Chatarra · kilogramos por material');
    // A weight is typed with the decimal comma of the screen; the dot is not a separator here.
    fireEvent.change(within(scrap).getByLabelText('Contados kg de Plomo'),
      { target: { value: '84.5' } });
    expect(within(scrap).getByLabelText('Contados kg de Plomo')).toHaveValue('80,200');
    fireEvent.change(within(scrap).getByLabelText('Contados kg de Plomo'),
      { target: { value: '84,5' } });
    expect(within(scrap).getByLabelText('Contados kg de Plomo')).toHaveValue('84,5');
    expect(within(scrap).getByLabelText('Contados kg de Plomo').closest('tr'))
      .toHaveTextContent('—');
    // Nothing of the draft left the screen.
    expect(h.posts('/api/closings/1/materials')).toHaveLength(0);
  });

  it('says plainly that the period bought no materials, instead of an empty table (S7)', async () => {
    const h = server({ materials: 'empty' });
    await ready(h);
    await sheet();
    openScrapTab();
    const panel = await materials();
    expect(within(panel).getByText(/El período no compró materiales/)).toBeInTheDocument();
    expect(within(panel).queryByRole('table')).not.toBeInTheDocument();
    // The balance and the tab say the same, and no marker is invented for a sheet that is empty.
    expect(within(balanceStrip()).getAllByRole('button')[2]).toHaveTextContent('Sin materiales');
    expect(scrapTab()).not.toHaveTextContent('con diferencia');
    expect(h.posts('/api/closings/1/materials')).toHaveLength(0);
  });

  it('posts the material counts beside the drawer, in the shape each kind takes (S8, S10)', async () => {
    const h = server();
    await ready(h);
    await sheet();
    fireEvent.change(screen.getByLabelText('Caja contada (Bs)'), { target: { value: '6.980,00' } });
    fireEvent.change(screen.getByLabelText('Monto que dejás en la caja (Bs)'),
      { target: { value: '900,00' } });
    openScrapTab();
    const used = await table('Baterías usadas · unidades por modelo');
    fireEvent.change(within(used).getByLabelText('Contadas modelo 31-100'),
      { target: { value: '7' } });
    fireEvent.change(screen.getByLabelText('Contados kg de Plomo'), { target: { value: '80,1' } });
    // The counts of the third account are unsaved work exactly like the drawer's, and the offer
    // waits for them: one draft, one save, both sheets (S10).
    expect(proposeButton()).toBeDisabled();
    expect(proposeButton()).toHaveAccessibleDescription(/cambios sin guardar/);
    expect(h.posts('/api/closings/1/materials')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Guardar borrador' }));
    await screen.findByText(/Borrador guardado/);
    expect(h.posts('/api/closings/1/materials')).toHaveLength(1);
    expect(JSON.parse(String(h.posts('/api/closings/1/materials')[0].init.body))).toEqual({
      lines: [
        { kind: 'used', model: '31-100', counted_quantity: '7' },
        { kind: 'scrap', material_id: 3, counted_quantity: '80.100' },
      ] });
    // The drawer travelled in the same save, and the sheet on screen is now the server's own.
    expect(h.posts('/api/closings/1/cash')).toHaveLength(1);
    const plomo = (await table('Chatarra · kilogramos por material'))
      .querySelector('[data-material-key="scrap:3"]')!;
    expect(within(plomo as HTMLElement).getByText('−4,400')).toBeInTheDocument();
    await waitFor(() => expect(proposeButton()).toBeEnabled());
  });

  it('never blocks the proposal for a material difference (S8)', async () => {
    const h = server();
    await ready(h);
    await sheet();
    openScrapTab();
    expect(await materials()).toHaveTextContent('−4,300');
    await completeTheSheet();
    // The sheet of the shelf differs in two kinds and the offer is still made: the difference is
    // informed exactly like the drawer's, and the stock count sheet stays the only gate (S8).
    expect(proposeButton()).toBeEnabled();
    expect(proposeButton()).toHaveAccessibleDescription(
      'La rendición se puede proponer: la caja está declarada.');
    fireEvent.click(proposeButton());
    await waitFor(() => expect(h.posts('/api/closings/1/propose')).toHaveLength(1));
    expect(await screen.findByText(/espera su aceptación o su rechazo/)).toBeInTheDocument();
    // The difference stays published after the offer: it is recorded, not corrected away.
    expect(await materials()).toHaveTextContent('−4,300');
  });
});

describe('the drawer draft (S10)', () => {
  it('restores the saved work after a reload', async () => {
    const h = server();
    const view = await ready(h);
    await sheet();
    fireEvent.change(screen.getByLabelText('Caja contada (Bs)'), { target: { value: '6.980,00' } });
    fireEvent.change(screen.getByLabelText('Monto que dejás en la caja (Bs)'), { target: { value: '900,00' } });
    fireEvent.change(screen.getByLabelText('Observación del cierre'), { target: { value: 'contado en persona' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar borrador' }));
    await screen.findByText(/Borrador guardado/);
    expect(JSON.parse(String(h.posts('/api/closings/1/cash')[0].init.body))).toEqual({
      counted_cash: '6980.00', contributed_cash: '0.00', closing_cash: '900.00',
      observation: 'contado en persona' });
    view.unmount();
    // A reload: the same admin, the same settlement, and the draft the server already holds.
    await ready(h);
    await screen.findByRole('heading', { name: 'Rendición de cuentas · Sopocachi' });
    expect(screen.getByLabelText('Caja contada (Bs)')).toHaveValue('6.980,00');
    expect(screen.getByLabelText('Monto que dejás en la caja (Bs)')).toHaveValue('900,00');
    expect(screen.getByLabelText('Observación del cierre')).toHaveValue('contado en persona');
  });

  it('names the amount the fund exceeds the drawer by instead of saving it silently', async () => {
    const h = server();
    await ready(h);
    await sheet();
    fireEvent.change(screen.getByLabelText('Caja contada (Bs)'), { target: { value: '795,00' } });
    fireEvent.change(screen.getByLabelText('Monto que dejás en la caja (Bs)'), { target: { value: '900,00' } });
    expect(proposeButton()).toBeDisabled();
    expect(proposeButton()).toHaveAccessibleDescription(
      /El fondo supera la caja contada más el aporte en Bs 105,00/);
  });
});

describe('the contribution the Admin declares (S10, S11)', () => {
  const contributionField = () => screen.getByLabelText('Aporte del Almacén (Bs)');

  it('starts from the contribution the settlement already reports and keeps it on save', async () => {
    const h = server({ contributed: '500.00' });
    await ready(h);
    await sheet();
    expect(contributionField()).toHaveValue('500,00');
    fireEvent.change(screen.getByLabelText('Caja contada (Bs)'), { target: { value: '6.980,00' } });
    fireEvent.change(screen.getByLabelText('Monto que dejás en la caja (Bs)'), { target: { value: '900,00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar borrador' }));
    await screen.findByText(/Borrador guardado/);
    // The field is not an invention of the screen: what it shows is what it sends (S10).
    expect(JSON.parse(String(h.posts('/api/closings/1/cash')[0].init.body))).toEqual({
      counted_cash: '6980.00', contributed_cash: '500.00', closing_cash: '900.00', observation: '' });
  });

  it('lets an empty drawer reach a fund and be proposed once the Admin declares the contribution (S11)',
    async () => {
      const h = server({ bootstrap: true });
      await ready(h);
      await sheet();
      fireEvent.change(screen.getByLabelText('Caja contada (Bs)'), { target: { value: '0,00' } });
      fireEvent.change(screen.getByLabelText('Monto que dejás en la caja (Bs)'), { target: { value: '500,00' } });
      // An empty till bounds the fund at zero, and the screen names the excess before the server.
      expect(proposeButton()).toBeDisabled();
      expect(proposeButton()).toHaveAccessibleDescription(
        /El fondo supera la caja contada más el aporte en Bs 500,00/);
      // The money the Admin puts into the till is what makes the fund reachable.
      fireEvent.change(contributionField(), { target: { value: '500,00' } });
      expect(proposeButton()).not.toHaveAccessibleDescription(/supera la caja contada/);
      expect(proposeButton()).toHaveAccessibleDescription(/cambios sin guardar/);
      fireEvent.click(screen.getByRole('button', { name: 'Guardar borrador' }));
      await waitFor(() => expect(proposeButton()).toBeEnabled());
      expect(JSON.parse(String(h.posts('/api/closings/1/cash')[0].init.body))).toEqual({
        counted_cash: '0.00', contributed_cash: '500.00', closing_cash: '500.00', observation: '' });
      fireEvent.click(proposeButton());
      await waitFor(() => expect(h.posts('/api/closings/1/propose')).toHaveLength(1));
      expect(await screen.findByText(/espera su aceptación o su rechazo/)).toBeInTheDocument();
    });

  it('keeps the declared contribution when the draft is saved and reopened', async () => {
    const h = server({ bootstrap: true });
    const view = await ready(h);
    await sheet();
    fireEvent.change(screen.getByLabelText('Caja contada (Bs)'), { target: { value: '0,00' } });
    fireEvent.change(contributionField(), { target: { value: '500,00' } });
    fireEvent.change(screen.getByLabelText('Monto que dejás en la caja (Bs)'), { target: { value: '500,00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar borrador' }));
    await screen.findByText(/Borrador guardado/);
    view.unmount();
    await ready(h);
    await screen.findByRole('heading', { name: 'Rendición de cuentas · Sopocachi' });
    // Reopening a saved draft does not silently zero the money the warehouse put in.
    expect(contributionField()).toHaveValue('500,00');
    expect(screen.getByLabelText('Monto que dejás en la caja (Bs)')).toHaveValue('500,00');
    // The bound it lifted is still lifted, so the first settlement is still offerable.
    expect(proposeButton()).toBeEnabled();
  });

  it('refuses a fund above the counted cash plus the contribution, naming the excess', async () => {
    const h = server({ bootstrap: true });
    await ready(h);
    await sheet();
    fireEvent.change(screen.getByLabelText('Caja contada (Bs)'), { target: { value: '0,00' } });
    fireEvent.change(contributionField(), { target: { value: '300,00' } });
    fireEvent.change(screen.getByLabelText('Monto que dejás en la caja (Bs)'), { target: { value: '500,00' } });
    expect(proposeButton()).toBeDisabled();
    expect(proposeButton()).toHaveAccessibleDescription(
      /El fondo supera la caja contada más el aporte en Bs 200,00/);
    // Nothing leaves the screen: the refusal is the screen's own reading of its own draft.
    expect(h.posts('/api/closings/1/propose')).toHaveLength(0);
  });

  it('shows the contribution as money put into the till, never as money collected', async () => {
    const h = server({ bootstrap: true });
    await ready(h);
    await sheet();
    fireEvent.change(screen.getByLabelText('Caja contada (Bs)'), { target: { value: '0,00' } });
    fireEvent.change(contributionField(), { target: { value: '500,00' } });
    fireEvent.change(screen.getByLabelText('Monto que dejás en la caja (Bs)'), { target: { value: '500,00' } });
    const aside = rail();
    expect(within(aside).getByText('Aporte del Almacén').parentElement).toHaveTextContent('Bs 500,00');
    // It is not cash sales, it is not in the expected drawer and it is in no commission (S9, S10).
    expect(within(aside).getByText('Ventas en efectivo').parentElement).toHaveTextContent('Bs 0,00');
    expect(within(aside).getByText('Caja esperada').parentElement).toHaveTextContent('Bs 0,00');
    expect(within(aside).getByText('Ventas sobre precio de venta').parentElement).toHaveTextContent('Bs 0,00');
    expect(within(aside).getByText('Comisión').parentElement).toHaveTextContent('Bs 0,00');
    // Bs 0,00 counted + Bs 500,00 put in − Bs 500,00 left behind: nothing is taken out.
    expect(within(aside).getByText('Te llevás al Almacén').parentElement).toHaveTextContent('Bs 0,00');
    // The field that declares it says what it is, beside the fund and not among the cash facts.
    expect(contributionField().closest('.closing-group')).toHaveTextContent(/no entra en la comisión/i);
  });

  it('publishes the server refusal of the fund bound when the screen cannot tell it', async () => {
    const h = server({ refuse: { error: 'fund_exceeds_drawer', excess: '50.00' } });
    await ready(h);
    await completeTheSheet();
    fireEvent.click(proposeButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'El fondo supera la caja contada más el aporte en Bs 50,00: corregí el fondo.');
  });
});

describe('corrections of a closed settlement (S16)', () => {
  const corrections = () => screen.getByRole('region', { name: 'Correcciones del cierre' });
  const proposeCorrection = () => within(corrections()).getByRole('button', { name: 'Proponer corrección' });
  const reason = () => within(corrections()).getByLabelText('Motivo de la corrección');

  /** One accepted correction of the drawer: the warehouse counted Bs 6.950,00 and not Bs 6.980,00. */
  const acceptedDrawer = () => ({
    id: 1, closing_id: 1, status: 'accepted', reason: 'conté mal el cajón, faltaba plata',
    payload: { counted_cash: '6950.00' },
    proposed_by_account_id: 1, proposed_at: '2026-09-12T19:00:00Z',
    decided_by_account_id: 2, decided_at: '2026-09-12T19:10:00Z',
    decision_reason: '',
    effects: [{ kind: 'counted_cash', variant_id: null, quantity_delta: null, amount_delta: '-30.00' }],
  });

  const pendingDrawer = () => ({
    id: 2, closing_id: 1, status: 'proposed', reason: 'la caja estaba mal contada',
    payload: { counted_cash: '6900.00' },
    proposed_by_account_id: 1, proposed_at: '2026-09-12T20:00:00Z',
    decided_by_account_id: null, decided_at: null, decision_reason: '', effects: [],
  });

  it('offers nothing invented on a settlement with no correction', async () => {
    const h = server({ status: 'closed' });
    await ready(h);
    const panel = await screen.findByRole('region', { name: 'Correcciones del cierre' });
    expect(within(panel).getByText(/El cierre no tiene correcciones/)).toBeInTheDocument();
    // No corrected figure is published when nothing was corrected: the numbers are the signed ones.
    expect(within(panel).queryByRole('table', { name: 'Números corregidos del cierre' }))
      .not.toBeInTheDocument();
    expect(within(rail()).getByText('Caja contada').parentElement).toHaveTextContent('Bs 6.980,00');
    expect(h.posts('/api/closings/1/corrections')).toHaveLength(0);
  });

  it('shows a corrected number as corrected, with its delta beside the signed one', async () => {
    const h = server({ status: 'closed', countedCash: '6950.00', corrections: [acceptedDrawer()] });
    await ready(h);
    const panel = await screen.findByRole('region', { name: 'Correcciones del cierre' });
    const row = within(panel).getByText('Caja contada').closest('.closing-correction-value')!;
    // The three numbers of a corrected figure, together: what was signed, what it reads today and the
    // delta that produced it.
    expect(within(row as HTMLElement).getByText('Bs 6.980,00')).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText('Bs 6.950,00')).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText('− Bs 30,00')).toBeInTheDocument();
    // The correction that produced it is legible beside it, with its reason.
    expect(within(panel).getByText('conté mal el cajón, faltaba plata')).toBeInTheDocument();
    // The rail keeps the identities over the corrected drawer, never over the signed one.
    expect(within(rail()).getByText('Caja contada').parentElement).toHaveTextContent('Bs 6.950,00');
    expect(within(rail()).getByText('− Bs 65,00')).toBeInTheDocument();
    expect(within(rail()).getByText('Te llevás al Almacén').parentElement).toHaveTextContent('Bs 6.050,00');
  });

  it('will not propose a correction without a reason', async () => {
    const h = server({ status: 'closed' });
    await ready(h);
    fireEvent.change(await within(corrections()).findByLabelText('Caja contada corregida (Bs)'),
      { target: { value: '6.900,00' } });
    expect(proposeCorrection()).toBeDisabled();
    expect(proposeCorrection()).toHaveAccessibleDescription(/sin motivo no se puede proponer/);
    expect(h.posts('/api/closings/1/corrections')).toHaveLength(0);
  });

  it('will not propose a correction that changes no value', async () => {
    const h = server({ status: 'closed' });
    await ready(h);
    fireEvent.change(await within(corrections()).findByLabelText('Motivo de la corrección'),
      { target: { value: 'revisé todo y estaba bien' } });
    expect(proposeCorrection()).toBeDisabled();
    expect(proposeCorrection()).toHaveAccessibleDescription(/al menos un valor/);
    expect(h.posts('/api/closings/1/corrections')).toHaveLength(0);
  });

  it('proposes the correction with its reason and only the values that changed', async () => {
    const h = server({ status: 'closed' });
    await ready(h);
    fireEvent.change(await within(corrections()).findByLabelText('Caja contada corregida (Bs)'),
      { target: { value: '6.900,00' } });
    fireEvent.change(within(corrections()).getByLabelText('Contado corregido de Bosch Power R · 110 Ah'),
      { target: { value: '8' } });
    fireEvent.change(reason(), { target: { value: '  conté mal la caja y una batería  ' } });
    expect(proposeCorrection()).toBeEnabled();
    fireEvent.click(proposeCorrection());
    await waitFor(() => expect(h.posts('/api/closings/1/corrections')).toHaveLength(1));
    // The untouched values are absent, never restated: the fund and the commission are not sent.
    expect(JSON.parse(String(h.posts('/api/closings/1/corrections')[0].init.body))).toEqual({
      reason: 'conté mal la caja y una batería',
      payload: { counted_quantities: [{ variant_id: 2, counted_quantity: 8 }],
        counted_cash: '6900.00' },
    });
    // The correction leaves and the settlement is read again, so the screen publishes what waits.
    expect(await screen.findByText(/Corrección propuesta a la sucursal/)).toBeInTheDocument();
    expect(within(corrections()).getByText('conté mal la caja y una batería')).toBeInTheDocument();
    expect(within(corrections()).getByText('Espera la decisión de la sucursal')).toBeInTheDocument();
  });

  it('shows the correction that waits for the branch and refuses a second one', async () => {
    const h = server({ status: 'closed', corrections: [pendingDrawer()] });
    await ready(h);
    const panel = await screen.findByRole('region', { name: 'Correcciones del cierre' });
    expect(within(panel).getByText('Espera la decisión de la sucursal')).toBeInTheDocument();
    expect(within(panel).getByText('la caja estaba mal contada')).toBeInTheDocument();
    // What it would change is stated before the branch answers, and nothing is applied yet.
    expect(within(panel).getByText('Bs 6.900,00')).toBeInTheDocument();
    expect(within(rail()).getByText('Caja contada').parentElement).toHaveTextContent('Bs 6.980,00');
    // One correction waits at a time: there is no second proposal to make.
    expect(within(panel).queryByRole('button', { name: 'Proponer corrección' })).not.toBeInTheDocument();
    expect(h.posts('/api/closings/1/corrections')).toHaveLength(0);
  });
});

// The upward half of S5: the sheet only lists what the cut knew, so the admin has to be able to
// count a battery that exists physically and the system does not have (L38).
describe('a battery the system did not have (S4, S5)', () => {
  const catalogueSearch = async () => {
    const count = await sheet();
    fireEvent.change(within(count).getByLabelText('Buscar batería en el catálogo de la sucursal'),
      { target: { value: 'NS60' } });
    fireEvent.click(within(count).getByRole('button', { name: 'Buscar en el catálogo' }));
    await within(count).findByRole('list', { name: 'Variantes del catálogo para agregar' });
    return count;
  };

  it('adds it as a row with no expected quantity and sends only what was counted', async () => {
    const h = server();
    const view = await ready(h);
    const count = await catalogueSearch();
    const results = within(count).getByRole('list', { name: 'Variantes del catálogo para agregar' });
    // The battery the branch holds none of is the only addition its sibling does not allow.
    expect(within(results).getByText('La sucursal ya tiene stock')).toBeInTheDocument();
    expect(within(results).queryByRole('button', { name: 'Agregar Toyo NS60 L · 65 Ah' }))
      .not.toBeInTheDocument();
    fireEvent.click(within(results).getByRole('button', { name: 'Agregar Toyo NS60 R · 65 Ah' }));
    // The same variant cannot be added twice: it is listed as on the sheet from now on.
    expect(within(await within(count).findByRole('list',
      { name: 'Variantes del catálogo para agregar' })).getByText('Ya está en la planilla'))
      .toBeInTheDocument();
    const row = within(count).getByLabelText('Contado de Toyo NS60 R · 65 Ah').closest('tr')!;
    // It carries no expected quantity at all, and says why it is different from a sheet row.
    expect(within(row).getAllByRole('cell')[1]).toHaveTextContent('—');
    expect(within(row).getByText('Fuera del sistema')).toBeInTheDocument();
    // The row is a change of the draft and not a line waiting to be counted: what holds the offer
    // back is that it is not saved yet, never a variant the sheet has to cover (S1, S3).
    expect(proposeButton()).toBeDisabled();
    expect(proposeButton()).toHaveAccessibleDescription(/cambios sin guardar/);
    expect(proposeButton()).not.toHaveAccessibleDescription(/por contar/);
    fireEvent.change(within(row).getByLabelText('Contado de Toyo NS60 R · 65 Ah'),
      { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar borrador' }));
    await screen.findByText(/Borrador guardado/);
    // The added row travels like every other row: its variant and its counted quantity, nothing else.
    expect(JSON.parse(String(h.posts('/api/closings/1/count').at(-1)!.init.body)))
      .toEqual({ lines: [{ variant_id: 20, counted_quantity: 4 }] });
    // The row survives the reload of the draft, still outside the system.
    view.unmount();
    await ready(h);
    const reloaded = within(await sheet()).getByLabelText('Contado de Toyo NS60 R · 65 Ah').closest('tr')!;
    expect(within(reloaded).getByText('Fuera del sistema')).toBeInTheDocument();
    expect(within(reloaded).getByLabelText('Contado de Toyo NS60 R · 65 Ah')).toHaveValue('4');
    expect(within(reloaded).getAllByRole('cell')[1]).toHaveTextContent('—');
  });

  it('never offers a variant the sheet already lists', async () => {
    const h = server();
    await ready(h);
    const count = await sheet();
    fireEvent.change(within(count).getByLabelText('Buscar batería en el catálogo de la sucursal'),
      { target: { value: 'Bosch' } });
    fireEvent.click(within(count).getByRole('button', { name: 'Buscar en el catálogo' }));
    const results = await within(count).findByRole('list',
      { name: 'Variantes del catálogo para agregar' });
    expect(within(results).getAllByText('Ya está en la planilla')).toHaveLength(3);
    expect(within(results).queryAllByRole('button')).toHaveLength(0);
    expect(h.posts('/api/closings/1/count')).toHaveLength(0);
  });

  it('says why the catalogue could not be read instead of naming the settlement', async () => {
    const h = server();
    const fetcher = vi.fn<typeof fetch>(async (input, init = {}) => {
      const url = String(input);
      if (url.startsWith('/api/inventory?')) return json({ error: 'service_unavailable' }, 503);
      return h.fetcher(input as string, init as RequestInit);
    });
    render(<ClosingWorkspace csrf={csrf} branches={branches} fetcher={fetcher} />);
    fireEvent.change(screen.getByLabelText('Sucursal'), { target: { value: '2' } });
    const count = await sheet();
    fireEvent.change(within(count).getByLabelText('Buscar batería en el catálogo de la sucursal'),
      { target: { value: 'NS60' } });
    fireEvent.click(within(count).getByRole('button', { name: 'Buscar en el catálogo' }));
    expect(await within(count).findByRole('alert')).toHaveTextContent(
      'No se pudo consultar el catálogo de la sucursal. Revisá la conexión e intentá de nuevo.');
    // A failed read offers nothing to add, and it never touches the count of the cut.
    expect(within(count).queryByRole('list', { name: 'Variantes del catálogo para agregar' }))
      .not.toBeInTheDocument();
    expect(h.posts('/api/closings/1/count')).toHaveLength(0);
  });

  it('takes the offer back while the added row travels unsaved', async () => {
    const h = server();
    await ready(h);
    fireEvent.change(screen.getByLabelText('Caja contada (Bs)'), { target: { value: '800,00' } });
    fireEvent.change(screen.getByLabelText('Monto que dejás en la caja (Bs)'), { target: { value: '500,00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar borrador' }));
    await waitFor(() => expect(proposeButton()).toBeEnabled());
    const count = await catalogueSearch();
    fireEvent.click(within(count).getByRole('button', { name: 'Agregar Toyo NS60 R · 65 Ah' }));
    // The added row is not of the cut, so it is no variant to count: it is an unsaved change.
    expect(proposeButton()).toBeDisabled();
    expect(proposeButton()).toHaveAccessibleDescription(/cambios sin guardar/);
    expect(proposeButton()).not.toHaveAccessibleDescription(/por contar/);
    fireEvent.change(screen.getByLabelText('Contado de Toyo NS60 R · 65 Ah'), { target: { value: '4' } });
    // Counted and unsaved is still not an offer: the closure has no count for it yet.
    expect(proposeButton()).toBeDisabled();
    expect(proposeButton()).toHaveAccessibleDescription(/cambios sin guardar/);
    fireEvent.click(screen.getByRole('button', { name: 'Guardar borrador' }));
    await waitFor(() => expect(proposeButton()).toBeEnabled());
  });

  it('drops a row that is not saved yet and never one of the cut', async () => {
    const h = server();
    await ready(h);
    const count = await catalogueSearch();
    fireEvent.click(within(count).getByRole('button', { name: 'Agregar Toyo NS60 R · 65 Ah' }));
    // A line of the cut is never removable: it is the snapshot the closure has to settle.
    const bosch = within(count).getByLabelText('Contado de Bosch Power R · 110 Ah').closest('tr')!;
    expect(within(bosch).queryAllByRole('button')).toHaveLength(0);
    fireEvent.click(within(count).getByRole('button', { name: 'Quitar Toyo NS60 R · 65 Ah del borrador' }));
    expect(within(count).queryByLabelText('Contado de Toyo NS60 R · 65 Ah')).not.toBeInTheDocument();
    expect(h.posts('/api/closings/1/count')).toHaveLength(0);
  });
});

describe('S5 the commission a branch needs to be settled', () => {
  it('blocks the proposal and names where the rate is fixed when the branch has none', async () => {
    const h = server({ commission: null });
    await ready(h);
    // The drawer is stated and saved; the proposal is what the missing rate holds back.
    fireEvent.change(screen.getByLabelText('Caja contada (Bs)'), { target: { value: '6.980,00' } });
    fireEvent.change(screen.getByLabelText('Monto que dejás en la caja (Bs)'), { target: { value: '900,00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar borrador' }));
    await waitFor(() => expect(within(actionBar()).getByText(/comisión configurado/)).toBeInTheDocument());

    // The rate the branch lacks is a blocker of the bar, not a refusal after pressing: the button
    // is disabled, the reason is the sentence the panel answers with, and the way to fix it is a
    // link to the screen that writes it.
    expect(proposeButton()).toBeDisabled();
    expect(within(actionBar()).getByText(
      'La sucursal no tiene porcentaje de comisión configurado: sin eso no se puede proponer.')).toBeInTheDocument();
    const link = within(actionBar()).getByRole('link', { name: 'Configurar la comisión de esta sucursal' });
    expect(link).toHaveAttribute('href', '#/administracion/sucursales');
    expect(h.posts('/api/closings/1/propose')).toHaveLength(0);
  });

  it('offers the proposal when the warehouse did fix a rate, with no link and no blocker', async () => {
    const h = server({ commission: '4.50' });
    await ready(h);
    await completeTheSheet();

    expect(proposeButton()).toBeEnabled();
    expect(within(actionBar()).queryByRole('link')).toBeNull();
    expect(within(actionBar()).queryByText(/comisión configurado/)).toBeNull();
  });

  it('renders a live settlement without a rate whose envelope is signed', async () => {
    // The branch holds a live settlement and no configured rate, so the configured read answers the
    // 404 the API maps to `null`. The period spent Bs 120,50 of its empty purchase envelope, so the
    // envelope's expectation is negative — a derived amount that carries its sign (S3, S11) — and
    // the screen reads it instead of going blank over a money figure it cannot format.
    const h = server({ commission: null, bootstrap: true, purchases: '120.50' });
    await ready(h);

    // The document of the live settlement is on screen: the sheet is the one the cut snapshot.
    expect(await sheet()).toBeInTheDocument();
    // A signed expectation is shown with its sign in the head of the balance it belongs to.
    expect(within(balanceStrip()).getByText('esperado − 120,50')).toBeInTheDocument();
    // The absence of the rate is named, and the action that needs it is refused with the reason at
    // hand instead of a refusal the warehouse reads after pressing the button.
    expect(within(actionBar()).getByText(
      /La sucursal no tiene porcentaje de comisión configurado: sin eso no se puede proponer\./))
      .toBeInTheDocument();
    expect(proposeButton()).toBeDisabled();
    expect(proposeButton()).toHaveAccessibleDescription(/porcentaje de comisión configurado/);
    expect(within(actionBar()).getByRole('link', { name: 'Configurar la comisión de esta sucursal' }))
      .toHaveAttribute('href', '#/administracion/sucursales');
  });
});
