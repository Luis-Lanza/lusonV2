import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ClosingDecision from './ClosingDecision';

const csrf = 'c'.repeat(43);
const json = (body: unknown, status = 200) => new Response(
  typeof body === 'string' ? body : JSON.stringify(body),
  { status, headers: { 'Content-Type': 'application/json' } });

const line = (variant_id: number, expected: number, counted: number | null,
  overrides: Record<string, unknown> = {}) => ({
  variant_id, catalog_entry_id: variant_id, brand: 'Bosch', model: 'S4', capacity_ah: '45',
  polarity: 'L', expected_quantity: expected, counted_quantity: counted, ...overrides });

/** The three counted variants of the decision artboard, with the two that differ from the system. */
const sheet = () => [
  line(1, 12, 12),
  line(2, 9, 8, { polarity: 'R', model: 'Power', capacity_ah: '110' }),
  line(3, 14, 13, { polarity: 'L', model: 'Blue', capacity_ah: '60' }),
];

const offer = (overrides: Record<string, unknown> = {}) => ({
  period_start: '2026-08-12T18:00:00Z', cut_at: '2026-09-12T18:30:00Z', sales_total: '32480.00',
  commission_rate_percent: '4.50', commission_amount: '1461.60', cash_sales: '6430.00',
  cash_expenses: '215.00', card_total: '3240.00', transfer_total: '1180.00', qr_total: '2760.00',
  counted_cash: '6980.00', contributed_cash: '0.00', closing_cash: '900.00', observation: '',
  count_lines: [
    { variant_id: 1, expected_quantity: 12, counted_quantity: 12 },
    { variant_id: 2, expected_quantity: 9, counted_quantity: 8 },
    { variant_id: 3, expected_quantity: 14, counted_quantity: 13 }],
  ...overrides });

const round = (number: number, overrides: Record<string, unknown> = {}) => ({
  id: number, round: number, offer: offer(), proposed_by_account_id: 1,
  proposed_at: `2026-09-12T14:5${number}:00Z`, decision: '', decision_reason: '',
  decided_by_account_id: null, decided_at: null, ...overrides });

const proposed = (overrides: Record<string, unknown> = {}) => ({
  id: 1, branch_location_id: 2, branch_name: 'Sopocachi', status: 'proposed',
  period_start: '2026-08-12T18:00:00Z', cut_at: '2026-09-12T18:30:00Z', closed_at: null,
  commission_rate_percent: '4.50', opening_cash: '800.00', cash_sales: '6430.00',
  cash_expenses: '215.00', expected_cash: '7015.00', counted_cash: '6980.00',
  cash_difference: '-35.00', contributed_cash: '0.00', closing_cash: '900.00',
  taken_cash: '6080.00', sales_total: '32480.00', commission_amount: '1461.60',
  card_total: '3240.00', transfer_total: '1180.00', qr_total: '2760.00',
  observation: 'Faltan dos baterías que el encargado dice haber vendido sin registrar.',
  opened_by_account_id: 1, count_lines: sheet(), rounds: [round(1)], expenses: [], corrections: [], ...overrides });

const open = () => proposed({
  status: 'open', commission_rate_percent: null, counted_cash: null, cash_difference: null,
  closing_cash: null, taken_cash: null, cash_sales: '0.00', cash_expenses: '0.00',
  expected_cash: '800.00', sales_total: '0.00', commission_amount: '0.00', card_total: '0.00',
  transfer_total: '0.00', qr_total: '0.00', observation: '',
  count_lines: sheet().map(entry => ({ ...entry, counted_quantity: null })), rounds: [], expenses: [], corrections: [] });

const closed = (overrides: Record<string, unknown> = {}) => proposed({ status: 'closed',
  closed_at: '2026-09-12T18:31:00Z',
  rounds: [round(1, { decision: 'accepted', decided_by_account_id: 2,
    decided_at: '2026-09-12T15:01:00Z' })], ...overrides });

const summary = (document: Record<string, unknown>) => ({ ...document, count_lines: [], rounds: [] });

/**
 * The server of these tests holds one settlement of Sopocachi and answers the branch's two
 * operations, so a decision is the real conversation and not a stub: the document it returns is
 * the one the screen has to describe afterwards.
 */
function server(initial: Record<string, unknown> = proposed()) {
  const state = {
    closing: initial,
    listed: [summary(initial)] as Record<string, unknown>[],
    detail: null as null | { body: unknown; status: number },
    decision: null as null | { body: unknown; status: number },
  };
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.startsWith('/api/closings?')) {
      return json({ page: 1, page_size: 25, total_closings: state.listed.length,
        closings: state.listed });
    }
    if (url === '/api/closings/1' && init.method !== 'POST') {
      if (state.detail) return json(state.detail.body, state.detail.status);
      return json(state.closing);
    }
    if (url === '/api/closings/1/decision' && init.method === 'POST') {
      if (state.decision) return json(state.decision.body, state.decision.status);
      const body = JSON.parse(String(init.body)) as { decision: string; reason?: string };
      if (body.decision === 'accepted') {
        state.closing = { ...state.closing, status: 'closed', closed_at: '2026-09-12T18:31:00Z',
          rounds: [round(1, { decision: 'accepted', decided_by_account_id: 2,
            decided_at: '2026-09-12T15:01:00Z' })] };
      } else {
        state.closing = { ...state.closing, status: 'rejected',
          rounds: [round(1, { decision: 'rejected', decision_reason: body.reason ?? '',
            decided_by_account_id: 2, decided_at: '2026-09-12T15:02:00Z' })] };
      }
      return json(state.closing);
    }
    if (url === '/api/closings/corrections/1/decision' && init.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { decision: string; reason?: string };
      const current = (state.closing.corrections as Record<string, unknown>[])[0];
      const accepted = body.decision === 'accepted';
      const decided = { ...current, status: accepted ? 'accepted' : 'rejected',
        decided_by_account_id: 2, decided_at: '2026-09-13T10:00:00Z',
        decision_reason: accepted ? '' : (body.reason ?? ''),
        effects: accepted
          ? [{ kind: 'counted_cash', variant_id: null, quantity_delta: null, amount_delta: '120.00' }]
          : [] };
      // An acceptance applies the delta; a rejection applies nothing and is never published.
      state.closing = accepted
        ? { ...state.closing, counted_cash: '7100.00', cash_difference: '85.00',
          taken_cash: '6200.00', corrections: [decided] }
        : { ...state.closing, corrections: [] };
      return json(decided);
    }
    throw new Error('Unexpected mocked URL: ' + url);
  });
  return { fetcher, calls, state,
    posts: (suffix: string) => calls.filter(call => call.url.endsWith(suffix) && call.init.method === 'POST') };
}

async function ready(h: ReturnType<typeof server>) {
  const view = render(<ClosingDecision csrf={csrf} branch={2} branchName="Sopocachi" fetcher={h.fetcher} />);
  await screen.findByRole('heading', { name: 'Rendición de cuentas · Sopocachi' });
  return view;
}

const changes = () => screen.findByRole('region', { name: 'Qué cambia si aceptás' });
const cash = () => screen.getByRole('region', { name: 'Caja y pago' });
const rounds = () => screen.getByRole('region', { name: 'Rondas de esta rendición' });
const decision = () => screen.getByRole('region', { name: 'Tu decisión' });
const acceptButton = () => within(decision()).getByRole('button', { name: 'Aceptar y cerrar la rendición' });
const rejectToggle = () => within(decision()).getByRole('button', { name: 'Rechazar la propuesta' });
const sendRejection = () => within(decision()).getByRole('button', { name: 'Enviar rechazo al Almacén' });

describe('what the branch is accepting (S14)', () => {
  it('reads its own settlement and only its own branch from the session', async () => {
    const h = server();
    await ready(h);
    expect(h.calls[0].url).toBe('/api/closings?branch_location_id=2&page=1&page_size=25');
    expect(h.calls.some(call => call.url === '/api/closings/1')).toBe(true);
    expect(h.posts('/api/closings/1/decision')).toHaveLength(0);
  });

  it('shows what every counted variant becomes in the system, including the ones that change', async () => {
    const h = server();
    await ready(h);
    const panel = await changes();
    const power = within(panel).getByText(/Bosch Power R · 110 Ah/).closest('tr')!;
    expect(within(power).getByText('9')).toBeInTheDocument();
    expect(within(power).getAllByText('8')).toHaveLength(2);
    const blue = within(panel).getByText(/Bosch Blue L · 60 Ah/).closest('tr')!;
    expect(within(blue).getByText('14')).toBeInTheDocument();
    expect(within(blue).getAllByText('13')).toHaveLength(2);
    expect(within(panel).getByText('2 diferencias de stock')).toBeInTheDocument();
  });

  it('shows the drawer, its difference, the commission and the fund the branch is left with', async () => {
    const h = server();
    await ready(h);
    const panel = cash();
    expect(within(panel).getByText('Caja esperada').parentElement).toHaveTextContent('Bs 7.015,00');
    expect(within(panel).getByText('Caja contada').parentElement).toHaveTextContent('Bs 6.980,00');
    expect(within(panel).getByText('Diferencia').parentElement).toHaveTextContent('− Bs 35,00');
    expect(within(panel).getByText('Faltante')).toBeInTheDocument();
    expect(within(panel).getByText('Comisión del período').parentElement).toHaveTextContent('Bs 1.461,60');
    expect(within(panel).getByText('Fondo que queda en la caja').parentElement).toHaveTextContent('Bs 900,00');
    // The commission is reported beside the drawer and is inside no cash identity (S9).
    expect(within(panel).getByText('Caja esperada').parentElement).not.toHaveTextContent('1.461,60');
  });
});

describe('deciding (S14)', () => {
  it('accepts and closes, and the screen then shows the closed settlement', async () => {
    const h = server();
    await ready(h);
    expect(acceptButton()).toBeEnabled();
    fireEvent.click(acceptButton());
    await waitFor(() => expect(h.posts('/api/closings/1/decision')).toHaveLength(1));
    expect(h.posts('/api/closings/1/decision')[0].init.body).toBe('{"decision":"accepted"}');
    expect(await screen.findByText('Rendición cerrada: la sucursal vuelve a operar.')).toBeInTheDocument();
    expect(screen.getByText('Cerrada')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Aceptar y cerrar la rendición' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rechazar la propuesta' })).not.toBeInTheDocument();
    expect(screen.getByText(/ya está cerrada/)).toBeInTheDocument();
    expect(within(rounds()).getByText('Aceptada')).toBeInTheDocument();
    expect(within(rounds()).getByText(/Cuenta #2/)).toBeInTheDocument();
  });

  it('cannot reject without a motive and rejects with one, naming who answered and when', async () => {
    const h = server();
    await ready(h);
    fireEvent.click(rejectToggle());
    const motive = within(decision()).getByLabelText('Motivo del rechazo');
    expect(sendRejection()).toBeDisabled();
    fireEvent.change(motive, { target: { value: '   ' } });
    expect(sendRejection()).toBeDisabled();
    expect(within(decision()).getByText(/sin motivo/)).toBeInTheDocument();
    expect(h.posts('/api/closings/1/decision')).toHaveLength(0);

    const written = 'Faltó contar la bodega: el sistema dice 9 y contamos 8.';
    fireEvent.change(motive, { target: { value: `  ${written}  ` } });
    expect(sendRejection()).toBeEnabled();
    fireEvent.click(sendRejection());
    await waitFor(() => expect(h.posts('/api/closings/1/decision')).toHaveLength(1));
    expect(h.posts('/api/closings/1/decision')[0].init.body)
      .toBe(JSON.stringify({ decision: 'rejected', reason: written }));
    // The rejection applies nothing: the settlement is back with the warehouse, still frozen.
    expect(await screen.findByText(/rechazo enviado al Almacén/i)).toBeInTheDocument();
    expect(screen.getByText(/todavía no propuso/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Aceptar y cerrar la rendición' })).not.toBeInTheDocument();
    const history = rounds();
    expect(within(history).getByText('Rechazada')).toBeInTheDocument();
    expect(within(history).getByText(new RegExp(written))).toBeInTheDocument();
    expect(within(history).getByText(/Cuenta #2/)).toBeInTheDocument();
    expect(within(history).getByText(/12 sept 2026, 11:02/)).toBeInTheDocument();
  });
});

describe('the rounds of the settlement (S15)', () => {
  it('renders every rejection motive with who decided and when, and how many offers were made', async () => {
    const h = server(proposed({ rounds: [
      round(1, { decision: 'rejected', decision_reason: 'La comisión estaba calculada sobre el período entero.',
        decided_by_account_id: 2, decided_at: '2026-09-12T14:44:00Z' }),
      round(2, { decision: 'rejected', decision_reason: 'El conteo de Bosch Power R todavía no estaba.',
        decided_by_account_id: 3, decided_at: '2026-09-12T14:55:00Z' }),
      round(3)] }));
    await ready(h);
    const history = rounds();
    expect(within(history).getByText('Propuesta 1')).toBeInTheDocument();
    expect(within(history).getByText('Propuesta 2')).toBeInTheDocument();
    expect(within(history).getByText('Propuesta 3')).toBeInTheDocument();
    expect(within(history).getByText(/La comisión estaba calculada sobre el período entero\./))
      .toBeInTheDocument();
    expect(within(history).getByText(/El conteo de Bosch Power R todavía no estaba\./))
      .toBeInTheDocument();
    expect(within(history).getByText(/Cuenta #2/)).toBeInTheDocument();
    expect(within(history).getByText(/Cuenta #3/)).toBeInTheDocument();
    expect(within(history).getByText(/12 sept 2026, 10:44/)).toBeInTheDocument();
    expect(within(history).getByText(/12 sept 2026, 10:52/)).toBeInTheDocument();
    expect(within(history).getByText(/12 sept 2026, 10:55/)).toBeInTheDocument();
    expect(within(history).getByText('Por decidir')).toBeInTheDocument();
    expect(within(history).getAllByText('Rechazada')).toHaveLength(2);
  });
});

describe('the screen when there is nothing to decide (S14)', () => {
  it.each([
    ['open', 'Abierta', /todavía no propuso/],
    ['closed', 'Cerrada', /ya está cerrada/],
  ])('is read-only in %s and names why', async (status, tag, reason) => {
    const document = status === 'open' ? open() : closed();
    const h = server(document);
    await ready(h);
    expect(screen.getByText(tag)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Aceptar y cerrar la rendición' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rechazar la propuesta' })).not.toBeInTheDocument();
    expect(screen.getByText(status === 'open'
      ? /La sucursal está congelada: el Almacén todavía no propuso/
      : /La rendición ya está cerrada/)).toBeInTheDocument();
    expect(h.posts('/api/closings/1/decision')).toHaveLength(0);
  });

  it('says a settlement of another branch is not found and offers no decision', async () => {
    const h = server(proposed({ branch_location_id: 3, branch_name: 'Miraflores' }));
    h.state.detail = { body: { error: 'not_found' }, status: 404 };
    await ready(h);
    expect(await screen.findByRole('alert')).toHaveTextContent('La rendición no existe para esta cuenta.');
    expect(screen.queryByRole('region', { name: 'Tu decisión' })).not.toBeInTheDocument();
    expect(h.posts('/api/closings/1/decision')).toHaveLength(0);
  });

  it('offers no decision when the branch holds no settlement at all', async () => {
    const h = server();
    h.state.listed = [];
    await ready(h);
    expect(await screen.findByText(/no tiene una rendición abierta/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Tu decisión' })).not.toBeInTheDocument();
    expect(h.posts('/api/closings/1/decision')).toHaveLength(0);
  });
});

/** The correction that waits for the branch of a closed settlement (S16). */
const correction = (overrides: Record<string, unknown> = {}) => ({
  id: 1, closing_id: 1, status: 'proposed', reason: 'conté mal el cajón y una batería',
  payload: { counted_cash: '7100.00',
    counted_quantities: [{ variant_id: 2, counted_quantity: 7 }] },
  proposed_by_account_id: 1, proposed_at: '2026-09-13T09:00:00Z',
  decided_by_account_id: null, decided_at: null, decision_reason: '', effects: [],
  ...overrides });

const awaitingCorrection = (overrides: Record<string, unknown> = {}) => closed({
  corrections: [correction()], ...overrides });

describe('the correction that waits for the branch (S16)', () => {
  const pendingPanel = () => screen.findByRole('region', { name: 'Corrección pendiente' });
  const acceptCorrection = () => within(screen.getByRole('region', { name: 'Corrección pendiente' }))
    .getByRole('button', { name: 'Aceptar la corrección' });
  const rejectToggle = () => within(screen.getByRole('region', { name: 'Corrección pendiente' }))
    .getByRole('button', { name: 'Rechazar la corrección' });
  const sendRejection = () => within(screen.getByRole('region', { name: 'Corrección pendiente' }))
    .getByRole('button', { name: 'Enviar rechazo de la corrección' });
  const motive = () => within(screen.getByRole('region', { name: 'Corrección pendiente' }))
    .getByLabelText('Motivo del rechazo de la corrección');

  it('cannot decide a correction it was not shown', async () => {
    const h = server(closed());
    await ready(h);
    expect(screen.getByText(/no tiene una corrección esperando tu decisión/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Corrección pendiente' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Aceptar la corrección' })).not.toBeInTheDocument();
    expect(h.posts('/api/closings/corrections/1/decision')).toHaveLength(0);
  });

  it('shows the reason and what accepting it would change before the answer', async () => {
    const h = server(awaitingCorrection());
    await ready(h);
    const panel = await pendingPanel();
    expect(within(panel).getByText('conté mal el cajón y una batería')).toBeInTheDocument();
    expect(within(panel).getByText(/Cuenta #1/)).toBeInTheDocument();
    // The corrected drawer, the corrected count line and the difference of each one.
    const drawerRow = within(panel).getByText('Caja contada').closest('tr')!;
    expect(within(drawerRow).getByText('Bs 6.980,00')).toBeInTheDocument();
    expect(within(drawerRow).getByText('Bs 7.100,00')).toBeInTheDocument();
    expect(within(drawerRow).getByText('+ Bs 120,00')).toBeInTheDocument();
    const countRow = within(panel).getByText(/Bosch Power R · 110 Ah/).closest('tr')!;
    expect(within(countRow).getByText('8')).toBeInTheDocument();
    expect(within(countRow).getByText('7')).toBeInTheDocument();
    expect(within(countRow).getByText('−1')).toBeInTheDocument();
    // The identities stay over the corrected drawer, and the expected cash is untouched.
    expect(within(panel).getByText('Caja esperada').parentElement).toHaveTextContent('Bs 7.015,00');
    expect(within(panel).getByText('Diferencia').parentElement).toHaveTextContent('+ Bs 85,00');
    expect(within(panel).getByText('Te llevás al Almacén').parentElement)
      .toHaveTextContent('Bs 6.200,00');
    // Nothing of it is applied while it waits: the settlement still publishes the signed drawer.
    expect(within(cash()).getByText('Caja contada').parentElement).toHaveTextContent('Bs 6.980,00');
    expect(h.posts('/api/closings/corrections/1/decision')).toHaveLength(0);
  });

  it('accepts the correction it was shown, and the settlement reads as corrected', async () => {
    const h = server(awaitingCorrection());
    await ready(h);
    await pendingPanel();
    fireEvent.click(acceptCorrection());
    await waitFor(() => expect(h.posts('/api/closings/corrections/1/decision')).toHaveLength(1));
    expect(h.posts('/api/closings/corrections/1/decision')[0].init.body)
      .toBe('{"decision":"accepted"}');
    expect(await screen.findByText(/Corrección aceptada/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Corrección pendiente' })).not.toBeInTheDocument();
  });

  it('cannot reject without a motive', async () => {
    const h = server(awaitingCorrection());
    await ready(h);
    await pendingPanel();
    fireEvent.click(rejectToggle());
    expect(sendRejection()).toBeDisabled();
    fireEvent.change(motive(), { target: { value: '   ' } });
    expect(sendRejection()).toBeDisabled();
    expect(h.posts('/api/closings/corrections/1/decision')).toHaveLength(0);
    fireEvent.change(motive(), { target: { value: '  lo reviso con el contador  ' } });
    expect(sendRejection()).toBeEnabled();
    fireEvent.click(sendRejection());
    await waitFor(() => expect(h.posts('/api/closings/corrections/1/decision')).toHaveLength(1));
    // The motive is the branch's own and it is trimmed before it leaves the screen.
    expect(h.posts('/api/closings/corrections/1/decision')[0].init.body).toBe(
      '{"decision":"rejected","reason":"lo reviso con el contador"}');
    expect(await screen.findByText(/Rechazo enviado al Almacén/)).toBeInTheDocument();
  });
});
