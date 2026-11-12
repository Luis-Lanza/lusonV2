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

/**
 * The server of these tests: it holds the settlement of Sopocachi and applies the requests the
 * screen sends, so a save, a refusal and a reload are the real conversation and not a stub.
 */
function server(options: { opened?: boolean, status?: string, refuse?: unknown } = {}) {
  const state = {
    opened: options.opened ?? true,
    status: options.status ?? 'open',
    counted: new Map<number, number | null>([[1, 12], [2, null], [3, null]]),
    // A settlement that was already proposed states its drawer; an open one does not.
    countedCash: (options.status ?? 'open') === 'open' ? null : '6980.00',
    fund: (options.status ?? 'open') === 'open' ? null : '900.00',
    observation: '',
    closed: false,
    rounds: [] as unknown[],
  };
  const calls: { url: string; init: RequestInit }[] = [];
  const document = () => {
    const lines = [countedLine({ variant_id: 1, counted_quantity: state.counted.get(1) ?? null }),
      countedLine({ variant_id: 2, polarity: 'R', expected_quantity: 9, model: 'Power', capacity_ah: '110',
        counted_quantity: state.counted.get(2) ?? null }),
      countedLine({ variant_id: 3, polarity: 'L', expected_quantity: 14, model: 'Blue', capacity_ah: '60',
        counted_quantity: state.counted.get(3) ?? null })];
    const opened = state.status !== 'open';
    // An open settlement publishes the period's totals as zero: they are recorded at the proposal.
    const expected = opened ? '7015.00' : '800.00';
    const countedCash = state.countedCash;
    const fund = state.fund;
    const difference = countedCash === null ? null
      : (Number(countedCash) - Number(expected)).toFixed(2);
    // A published derived amount carries its sign only when it is negative.
    const signed = difference;
    const taken = countedCash === null || fund === null
      ? null : (Number(countedCash) - Number(fund)).toFixed(2);
    return {
      id: 1, branch_location_id: 2, branch_name: 'Sopocachi', status: state.closed ? 'closed' : state.status,
      period_start: '2026-08-12T18:00:00Z', cut_at: '2026-09-12T18:30:00Z',
      closed_at: state.closed ? '2026-09-12T18:31:00Z' : null,
      commission_rate_percent: opened ? '4.50' : null,
      opening_cash: '800.00',
      cash_sales: opened ? '6430.00' : '0.00',
      cash_expenses: opened ? '215.00' : '0.00',
      expected_cash: expected,
      counted_cash: countedCash,
      cash_difference: signed,
      contributed_cash: '0.00',
      closing_cash: fund,
      taken_cash: taken,
      sales_total: opened ? '32480.00' : '0.00',
      commission_amount: opened ? '1461.60' : '0.00',
      card_total: opened ? '3240.00' : '0.00',
      transfer_total: opened ? '1180.00' : '0.00',
      qr_total: opened ? '2760.00' : '0.00',
      observation: state.observation, opened_by_account_id: 1,
      count_lines: lines, rounds: state.rounds,
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
      for (const line of body.lines) state.counted.set(line.variant_id, line.counted_quantity);
      return json(document());
    }
    if (url === '/api/closings/1/cash' && init.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { counted_cash: string | null;
        closing_cash: string | null; observation: string };
      state.countedCash = body.counted_cash;
      state.fund = body.closing_cash;
      state.observation = body.observation;
      return json(document());
    }
    if (url === '/api/closings/1/propose' && init.method === 'POST') {
      if (options.refuse) return json(options.refuse, 409);
      state.status = 'proposed';
      state.rounds = [{ id: 1, round: 1, offer: {
        period_start: '2026-08-12T18:00:00Z', cut_at: '2026-09-12T18:30:00Z', sales_total: '32480.00',
        commission_rate_percent: '4.50', commission_amount: '1461.60', cash_sales: '6430.00',
        cash_expenses: '215.00', card_total: '3240.00', transfer_total: '1180.00', qr_total: '2760.00',
        counted_cash: state.countedCash, contributed_cash: '0.00', closing_cash: state.fund,
        observation: '', count_lines: [] }, proposed_by_account_id: 1,
        proposed_at: '2026-09-12T18:31:00Z', decision: '', decision_reason: '',
        decided_by_account_id: null, decided_at: null }];
      return json(document());
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
