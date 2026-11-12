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

/** One row of the branch's own catalogue: every variant of the branch, stock or not. */
const catalogueItem = (overrides: Record<string, unknown> = {}) => ({
  variant_id: 1, catalog_entry_id: 1, brand: 'Bosch', model: 'S4', capacity_ah: 45,
  polarity: 'L', existing: 12, reserved: 0, available: 12, ...overrides,
});

/**
 * The branch catalogue as the screen reads it (`/api/inventory`): the three variants the sheet of
 * the cut already holds, the battery the branch counted and the system had none of (variant 20) and
 * a sibling variant the branch does hold (21), so an addition is never offered for it.
 */
const cataloguePage = (search: string) => {
  const items = [catalogueItem(),
    catalogueItem({ variant_id: 2, polarity: 'R', model: 'Power', capacity_ah: 110, existing: 9, available: 9 }),
    catalogueItem({ variant_id: 3, model: 'Blue', capacity_ah: 60, existing: 14, available: 14 }),
    catalogueItem({ variant_id: 20, catalog_entry_id: 11, brand: 'Toyo', model: 'NS60',
      capacity_ah: 65, polarity: 'R', existing: 0, available: 0 }),
    catalogueItem({ variant_id: 21, catalog_entry_id: 11, brand: 'Toyo', model: 'NS60',
      capacity_ah: 65, polarity: 'L', existing: 4, available: 4 })].filter(item =>
    search === '' || `${item.brand} ${item.model}`.toLowerCase().includes(search.toLowerCase()));
  return { location: { id: 2, name: 'Sopocachi' }, page: 1, page_size: 50,
    total_variants: items.length, items };
};

/**
 * The server of these tests: it holds the settlement of Sopocachi and applies the requests the
 * screen sends, so a save, a refusal and a reload are the real conversation and not a stub.
 * `bootstrap` is the first settlement of the branch (S11): no inherited fund, no sales, an
 * empty till, where only a contribution the Admin declares can leave a fund behind.
 */
function server(options: { opened?: boolean, status?: string, refuse?: unknown, bootstrap?: boolean,
  contributed?: string, countedCash?: string, fund?: string,
  corrections?: unknown[] } = {}) {
  const state = {
    opened: options.opened ?? true,
    status: options.status ?? 'open',
    bootstrap: options.bootstrap ?? false,
    // A closed settlement states every counted quantity; a live one still has pending lines.
    counted: new Map<number, number | null>((options.status ?? 'open') === 'closed'
      ? [[1, 12], [2, 9], [3, 14]] : [[1, 12], [2, null], [3, null]]),
    // A settlement that was already proposed states its drawer; an open one does not.
    countedCash: options.countedCash
      ?? ((options.status ?? 'open') === 'open' ? null : '6980.00'),
    contributedCash: options.contributed ?? '0.00',
    fund: options.fund ?? ((options.status ?? 'open') === 'open' ? null : '900.00'),
    observation: '',
    closed: (options.status ?? 'open') === 'closed',
    rounds: [] as unknown[],
    // The published corrections of the closed settlement: the accepted ones and the pending one.
    corrections: (options.corrections ?? []) as unknown[],
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
    return {
      id: 1, branch_location_id: 2, branch_name: 'Sopocachi', status: state.closed ? 'closed' : state.status,
      period_start: '2026-08-12T18:00:00Z', cut_at: '2026-09-12T18:30:00Z',
      closed_at: state.closed ? '2026-09-12T18:31:00Z' : null,
      commission_rate_percent: opened ? '4.50' : null,
      opening_cash: opening,
      cash_sales: !bootstrap && opened ? '6430.00' : '0.00',
      cash_expenses: !bootstrap && opened ? '215.00' : '0.00',
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
      count_lines: lines, rounds: state.rounds, expenses: [], corrections: state.corrections,
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
    if (url === '/api/closings/1/cash' && init.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { counted_cash: string | null;
        contributed_cash: string; closing_cash: string | null; observation: string };
      state.countedCash = body.counted_cash;
      state.contributedCash = body.contributed_cash;
      state.fund = body.closing_cash;
      state.observation = body.observation;
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
const rail = () => screen.getByRole('complementary', { name: 'Números de la rendición' });
const actionBar = () => screen.getByRole('region', { name: 'Acciones de la rendición' });
const proposeButton = () => within(actionBar()).getByRole('button', { name: 'Proponer a la sucursal' });

/** Counts the two pending variants and states the drawer of the artboard. */
async function completeTheSheet() {
  fireEvent.change(await screen.findByLabelText('Contado de Bosch Power R · 110 Ah'), { target: { value: '9' } });
  fireEvent.change(screen.getByLabelText('Contado de Bosch Blue L · 60 Ah'), { target: { value: '14' } });
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
    // The sheet is the one the opening returned, not a client copy of it.
    expect(within(await sheet()).getByLabelText('Contado de Bosch Power R · 110 Ah')).toHaveValue('');
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
  it('shows the frozen expected quantity, the counted one and the running difference', async () => {
    const h = server();
    await ready(h);
    const count = await sheet();
    const power = within(count).getByLabelText('Contado de Bosch Power R · 110 Ah').closest('tr')!;
    expect(within(power).getByText('9')).toBeInTheDocument();
    expect(within(power).getByText('Pendiente')).toBeInTheDocument();
    expect(power).toHaveClass('pending');
    fireEvent.change(within(power).getByLabelText('Contado de Bosch Power R · 110 Ah'), { target: { value: '8' } });
    expect(within(power).getByText('−1')).toBeInTheDocument();
    fireEvent.change(within(power).getByLabelText('Contado de Bosch Power R · 110 Ah'), { target: { value: '11' } });
    expect(within(power).getByText('+2')).toBeInTheDocument();
    // The expected quantity is the database's snapshot and never follows the count (S4).
    expect(within(power).getByText('9')).toBeInTheDocument();
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
  it('blocks the proposal while rows are pending and names the variants still to count', async () => {
    const h = server();
    await ready(h);
    await sheet();
    expect(proposeButton()).toBeDisabled();
    expect(proposeButton()).toHaveAccessibleDescription(
      /Faltan 2 variantes por contar: Bosch Power R · 110 Ah, Bosch Blue L · 60 Ah/);
    expect(proposeButton()).toHaveAccessibleDescription(/Falta la caja contada y el fondo/);
    expect(h.posts('/api/closings/1/propose')).toHaveLength(0);
  });

  it('enables the proposal once the sheet is covered and the drawer is saved', async () => {
    const h = server();
    await ready(h);
    fireEvent.change(await screen.findByLabelText('Contado de Bosch Power R · 110 Ah'), { target: { value: '8' } });
    fireEvent.change(screen.getByLabelText('Contado de Bosch Blue L · 60 Ah'), { target: { value: '14' } });
    // Unsaved work is not an offer: the count and the drawer are saved explicitly first.
    expect(proposeButton()).toBeDisabled();
    expect(proposeButton()).toHaveAccessibleDescription(/cambios sin guardar/);
    fireEvent.change(screen.getByLabelText('Caja contada (Bs)'), { target: { value: '6.980,00' } });
    fireEvent.change(screen.getByLabelText('Monto que dejás en la caja (Bs)'), { target: { value: '900,00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar borrador' }));
    await waitFor(() => expect(proposeButton()).toBeEnabled());
    expect(h.posts('/api/closings/1/count')).toHaveLength(1);
    expect(JSON.parse(String(h.posts('/api/closings/1/count')[0].init.body))).toEqual({
      lines: [{ variant_id: 2, counted_quantity: 8 }, { variant_id: 3, counted_quantity: 14 }] });
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
  });

  it('takes the fund out of the counted drawer and leaves the difference alone', async () => {
    const h = server({ status: 'proposed' });
    await ready(h);
    await screen.findByRole('heading', { name: 'Rendición de cuentas · Sopocachi' });
    const aside = rail();
    expect(within(aside).getByText('Caja contada').parentElement).toHaveTextContent('Bs 6.980,00');
    expect(within(aside).getByText('Fondo que queda en la caja').parentElement).toHaveTextContent('− Bs 900,00');
    expect(within(aside).getByText('Te llevás al Almacén').parentElement).toHaveTextContent('Bs 6.080,00');
    // The difference of the drawer is not discounted from the fund nor absorbed by anything.
    expect(within(aside).getByText('− Bs 35,00')).toBeInTheDocument();
    expect(within(aside).getByText('Faltante')).toBeInTheDocument();
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

  /** Counts the two pending variants of the fixture, so only the drawer is left to state. */
  async function countTheSheet() {
    fireEvent.change(await screen.findByLabelText('Contado de Bosch Power R · 110 Ah'),
      { target: { value: '9' } });
    fireEvent.change(screen.getByLabelText('Contado de Bosch Blue L · 60 Ah'), { target: { value: '14' } });
  }

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
      await countTheSheet();
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
    await countTheSheet();
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
    await countTheSheet();
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
    await countTheSheet();
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
    // An uncounted added row is a pending line and blocks the proposal by name, beside the rest.
    expect(proposeButton()).toBeDisabled();
    expect(proposeButton()).toHaveAccessibleDescription(
      /Faltan 3 variantes por contar: Bosch Power R · 110 Ah, Bosch Blue L · 60 Ah, Toyo NS60 R · 65 Ah/);
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

  it('takes the offer back while the added row is uncounted or not saved', async () => {
    const h = server();
    await ready(h);
    fireEvent.change(await screen.findByLabelText('Contado de Bosch Power R · 110 Ah'),
      { target: { value: '9' } });
    fireEvent.change(screen.getByLabelText('Contado de Bosch Blue L · 60 Ah'), { target: { value: '14' } });
    fireEvent.change(screen.getByLabelText('Caja contada (Bs)'), { target: { value: '800,00' } });
    fireEvent.change(screen.getByLabelText('Monto que dejás en la caja (Bs)'), { target: { value: '500,00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar borrador' }));
    await waitFor(() => expect(proposeButton()).toBeEnabled());
    const count = await catalogueSearch();
    fireEvent.click(within(count).getByRole('button', { name: 'Agregar Toyo NS60 R · 65 Ah' }));
    expect(proposeButton()).toBeDisabled();
    expect(proposeButton()).toHaveAccessibleDescription(/Faltan 1 variante por contar: Toyo NS60 R · 65 Ah/);
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
