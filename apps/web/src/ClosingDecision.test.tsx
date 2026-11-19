import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import ClosingDecision from './ClosingDecision';
import { notifyClosingInvalidation } from './useInventory';

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
  // The envelope of the offer: what the warehouse counted and what it leaves (S1, S5, S6).
  purchase_fund_counted: '375.00', purchase_fund_cash: '1500.00',
  count_lines: [
    { variant_id: 1, expected_quantity: 12, counted_quantity: 12 },
    { variant_id: 2, expected_quantity: 9, counted_quantity: 8 },
    { variant_id: 3, expected_quantity: 14, counted_quantity: 13 }],
  ...overrides });

const round = (number: number, overrides: Record<string, unknown> = {}) => ({
  id: number, round: number, offer: offer(), proposed_by_account_id: 1,
  proposed_at: `2026-09-12T14:5${number}:00Z`, decision: '', decision_reason: '',
  decided_by_account_id: null, decided_at: null, ...overrides });

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

/**
 * The material sheet of the artboard (design/rendicion-caja-y-chatarra/04-decision-dos-pestanas.html):
 * three used models in units and four scrap materials in kilograms, one shortage of each kind, in
 * the order the contract freezes — the used lines by model, then the scrap ones by material id.
 */
const materialLines = () => [
  usedMaterial('24F-45', '6', '6'),
  usedMaterial('27-60', '12', '12'),
  usedMaterial('31-100', '9', '8'),
  scrapMaterial(1, 'Cobre', '12.400', '12.400'),
  scrapMaterial(2, 'Aluminio', '8.750', '8.750'),
  scrapMaterial(3, 'Plomo', '84.500', '80.200'),
  scrapMaterial(4, 'Bronce', '3.100', '3.100'),
];

const proposed = (overrides: Record<string, unknown> = {}) => ({
  id: 1, branch_location_id: 2, branch_name: 'Sopocachi', status: 'proposed',
  period_start: '2026-08-12T18:00:00Z', cut_at: '2026-09-12T18:30:00Z', closed_at: null,
  commission_rate_percent: '4.50', opening_cash: '800.00', cash_sales: '6430.00',
  cash_expenses: '215.00', cash_effective: '-215.00', expected_cash: '7015.00',
  counted_cash: '6980.00',
  cash_difference: '-35.00', contributed_cash: '0.00', closing_cash: '900.00',
  taken_cash: '6080.00', sales_total: '32480.00', commission_amount: '1461.60',
  card_total: '3240.00', transfer_total: '1180.00', qr_total: '2760.00',
  // The second envelope of the document: Bs 2.000,00 inherited, Bs 1.621,00 spent in cash,
  // Bs 379,00 expected, Bs 375,00 counted, Bs 1.500,00 left for the next period (S1, S5, S6).
  purchase_fund_opening: '2000.00', purchases_total: '1621.00', purchases_cash: '1621.00',
  purchase_fund_expected: '379.00', purchase_fund_counted: '375.00',
  purchase_fund_difference: '-4.00', purchase_fund_cash: '1500.00',
  observation: 'Faltan dos baterías que el encargado dice haber vendido sin registrar.',
  opened_by_account_id: 1, count_lines: sheet(), material_lines: materialLines(),
  rounds: [round(1)], expenses: [], corrections: [], ...overrides });

const open = () => proposed({
  status: 'open', commission_rate_percent: null, counted_cash: null, cash_difference: null,
  closing_cash: null, taken_cash: null, cash_sales: '0.00', cash_expenses: '0.00',
  cash_effective: '0.00', expected_cash: '800.00', sales_total: '0.00', commission_amount: '0.00', card_total: '0.00',
  transfer_total: '0.00', qr_total: '0.00', observation: '',
  // A held settlement has an envelope nobody counted yet and no frozen offer to read it from.
  purchase_fund_counted: null, purchase_fund_difference: null, purchase_fund_cash: null,
  // The sheet opens aligned with the system, so a held settlement already states a quantity for
  // every line: the branch sees the seeded count, not an empty one.
  count_lines: sheet().map(entry => ({ ...entry, counted_quantity: entry.expected_quantity })), rounds: [], expenses: [], corrections: [] });

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

const tabList = () => screen.getByRole('tablist', { name: 'Rendición' });
const cashTab = () => within(tabList()).getByRole('tab', { name: /^Caja/ });
const scrapTab = () => within(tabList()).getByRole('tab', { name: /^Chatarra/ });
const balanceStrip = () => screen.getByRole('group', { name: 'Saldos de la rendición' });
const materials = () => screen.findByRole('region', { name: 'Materiales rendidos' });
/** The scrap tab holds the envelope and the material sheet of the same document (S10, S13). */
function openScrapTab() { fireEvent.click(scrapTab()); }

const changes = () => screen.findByRole('region', { name: 'Qué cambia si aceptás' });
const cash = () => screen.getByRole('region', { name: 'Caja y pago' });
const rounds = () => screen.getByRole('region', { name: 'Rondas de esta rendición' });
const decision = () => screen.getByRole('region', { name: 'Tu decisión' });
const acceptButton = () => within(decision()).getByRole('button', { name: 'Aceptar y cerrar la rendición' });
const rejectToggle = () => within(decision()).getByRole('button', { name: 'Rechazar la propuesta' });
const sendRejection = () => within(decision()).getByRole('button', { name: 'Enviar rechazo al Almacén' });

describe('the settlement arrives on the branch stream (S10)', () => {
  it('shows the frozen branch and then the offer without a reload', async () => {
    const h = server();
    // The branch holds nothing yet: the warehouse has not opened the rendición.
    h.state.listed = [];
    await ready(h);
    expect(await screen.findByText('La sucursal no tiene una rendición abierta ni cerrada todavía.'))
      .toBeInTheDocument();
    expect(screen.queryByText('Sucursal congelada')).not.toBeInTheDocument();
    // The warehouse opens it: the settlement's own trigger (058) rides the branch's stream, and the
    // notice of the freeze appears without the branch reloading the page.
    h.state.closing = open(); h.state.listed = [summary(open())];
    act(() => notifyClosingInvalidation());
    expect(await screen.findByText('Sucursal congelada')).toBeInTheDocument();
    // A held settlement has no offer: there is nothing to accept until the warehouse proposes it.
    expect(screen.queryByRole('button', { name: 'Aceptar y cerrar la rendición' }))
      .not.toBeInTheDocument();
    // The proposal is the same stream and the same screen: the acceptance is offered in place.
    h.state.closing = proposed(); h.state.listed = [summary(proposed())];
    act(() => notifyClosingInvalidation());
    expect(await screen.findByRole('button', { name: 'Aceptar y cerrar la rendición' }))
      .toBeInTheDocument();
  });

  it('never discards the answer being typed when the stream speaks', async () => {
    const h = server();
    await ready(h);
    fireEvent.click(rejectToggle());
    fireEvent.change(screen.getByLabelText('Motivo del rechazo'),
      { target: { value: 'Falta contar el plomo' } });
    const reads = h.calls.length;
    // The branch is answering a round right now: a hint of the same stream must not read the
    // document again, because reading it again is what clears the motive it is typing.
    h.state.closing = closed(); h.state.listed = [summary(closed())];
    act(() => notifyClosingInvalidation());
    expect(h.calls).toHaveLength(reads);
    expect(screen.getByLabelText('Motivo del rechazo')).toHaveValue('Falta contar el plomo');
  });

  it('applies the frame that arrived while the branch was answering once the answer is out of the way', async () => {
    const h = server();
    await ready(h);
    // The warehouse re-proposes the settlement while the branch is writing its rejection.
    fireEvent.click(rejectToggle());
    fireEvent.change(screen.getByLabelText('Motivo del rechazo'),
      { target: { value: 'Falta contar el plomo' } });
    const second = proposed({ rounds: [
      round(1, { decision: 'rejected', decision_reason: 'Falta contar el plomo',
        decided_by_account_id: 2, decided_at: '2026-09-12T15:02:00Z' }),
      round(2)] });
    h.state.closing = second; h.state.listed = [summary(second)];
    const reads = h.calls.length;
    act(() => notifyClosingInvalidation());
    // The motive is not thrown away, and nothing is read over it: the frame waits.
    expect(h.calls).toHaveLength(reads);
    expect(screen.getByLabelText('Motivo del rechazo')).toHaveValue('Falta contar el plomo');
    // The branch clears the motive: the frame that waited lands now, once, so the new offer is on
    // screen without a reload (S10).
    fireEvent.change(screen.getByLabelText('Motivo del rechazo'), { target: { value: '' } });
    expect(await screen.findByText('Propuesta 2 de 2')).toBeInTheDocument();
    expect(h.calls.filter(call => call.url === '/api/closings/1')).toHaveLength(2);
  });
});

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

  it('waits for the offer instead of rendering the draft sheet of a held settlement', async () => {
    const h = server(open());
    await ready(h);
    const panel = await changes();
    expect(within(panel).getByText(/todavía no propuso esta rendición/)).toBeInTheDocument();
    expect(within(panel).queryByText('Sistema')).not.toBeInTheDocument();
    expect(within(panel).queryByText(/diferencia/)).not.toBeInTheDocument();
  });

  it('lists the offered sheet even when no existence changes', async () => {
    const h = server(proposed({ count_lines: sheet()
      .map(entry => ({ ...entry, counted_quantity: entry.expected_quantity })) }));
    await ready(h);
    const panel = await changes();
    expect(within(panel).getByText('Sistema')).toBeInTheDocument();
    expect(within(panel).getByText('Sin diferencias de stock')).toBeInTheDocument();
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
    // The base is stated beside the commission, so the branch reads what the percentage is applied
    // to, and that the electronic collection counts for it even though it was never in the drawer.
    expect(within(panel).getByText('Ventas sobre precio de venta').parentElement)
      .toHaveTextContent('Bs 32.480,00');
    expect(within(panel).getByText(/también lo cobrado por QR/)).toBeInTheDocument();
    expect(within(panel).getByText('Fondo que queda en la caja').parentElement).toHaveTextContent('Bs 900,00');
    // The commission is reported beside the drawer and is inside no cash identity (S9).
    expect(within(panel).getByText('Caja esperada').parentElement).not.toHaveTextContent('1.461,60');
  });
});

/**
 * The second envelope of the settlement (S1, S5, S6): the branch reads the envelope of the offer it
 * is accepting, without an input of its own, and the line that says what acceptance makes of it.
 */
describe('the purchase fund the branch is accepting (S1, S5, S6)', () => {
  const envelope = () => screen.getByRole('region', { name: 'Fondo de compras' });

  it('shows the frozen envelope of the offer, read-only, with its difference', async () => {
    const h = server();
    await ready(h);
    openScrapTab();
    const panel = envelope();
    expect(within(panel).getByText('Saldo heredado').parentElement).toHaveTextContent('Bs 2.000,00');
    expect(within(panel).getByText('Compras del período').parentElement)
      .toHaveTextContent('− Bs 1.621,00');
    expect(within(panel).getByText('Fondo esperado').parentElement).toHaveTextContent('Bs 379,00');
    // The count and the amount it leaves are the ones the warehouse offered, not today's columns.
    expect(within(panel).getByText('Fondo contado').parentElement).toHaveTextContent('Bs 375,00');
    const difference = within(panel).getByText('Diferencia').parentElement!;
    expect(difference).toHaveTextContent('− Bs 4,00');
    expect(within(difference).getByText('Faltante')).toBeInTheDocument();
    // The branch decides on it and never types into it: the envelope is the warehouse's count.
    expect(within(panel).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(panel).queryByLabelText('Fondo contado (Bs)')).not.toBeInTheDocument();
    expect(h.posts('/api/closings/1/decision')).toHaveLength(0);
  });

  it('says that accepting makes the new amount its purchase fund for the next period', async () => {
    const h = server();
    await ready(h);
    openScrapTab();
    const panel = envelope();
    expect(within(panel).getByText('Tu fondo de compras arranca con').parentElement)
      .toHaveTextContent('Bs 1.500,00');
    expect(panel).toHaveTextContent(/pasa a ser tu fondo de compras/i);
    // The envelope is apart from the till, and no money of a sale feeds it (S1, S12).
    expect(panel).toHaveTextContent(/sobre aparte/i);
    expect(panel).toHaveTextContent(/ninguna venta lo alimenta/i);
    // The closed settlement keeps the envelope the branch accepted.
    fireEvent.click(acceptButton());
    await screen.findByText('Rendición cerrada: la sucursal vuelve a operar.');
    expect(within(envelope()).getByText('Tu fondo de compras arranca con').parentElement)
      .toHaveTextContent('Bs 1.500,00');
  });
});

describe('the two tabs and the three balances of the decision (S10, S13)', () => {
  const balances = () => within(balanceStrip()).getAllByRole('button');

  it('opens on the cash tab with the three balances of the offer above it', async () => {
    const h = server();
    await ready(h);
    expect(balances()).toHaveLength(3);
    expect(balances()[0]).toHaveTextContent('Caja operativa');
    expect(balances()[0]).toHaveTextContent('− Bs 35,00');
    expect(balances()[0]).toHaveTextContent('contada 6.980,00 · esperada 7.015,00');
    expect(balances()[1]).toHaveTextContent('Fondo de compras');
    expect(balances()[1]).toHaveTextContent('− Bs 4,00');
    expect(balances()[2]).toHaveTextContent('Materiales');
    // The materials are named in their own unit and never added to any money figure (S13).
    expect(balances()[2]).toHaveTextContent('2 cuentas con diferencia');
    expect(balances()[0]).toHaveAttribute('aria-pressed', 'true');
    expect(cashTab()).toHaveAttribute('aria-selected', 'true');
    expect(scrapTab()).toHaveAttribute('aria-selected', 'false');
    // The marker of each tab is the difference of its accounts, in words and never a bare dot.
    expect(cashTab()).toHaveTextContent('− Bs 35,00');
    expect(scrapTab()).toHaveTextContent('2 con diferencia');
    // Nothing of it is a field: the branch confirms, it never types (S14).
    expect(within(balanceStrip()).queryByRole('textbox')).not.toBeInTheDocument();
    expect(h.posts('/api/closings/1/decision')).toHaveLength(0);
  });

  it('switches with the mouse and with the arrows, and the answer stays reachable', async () => {
    const h = server();
    await ready(h);
    await changes();
    openScrapTab();
    expect(scrapTab()).toHaveAttribute('aria-selected', 'true');
    expect(await materials()).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Qué cambia si aceptás' })).not.toBeInTheDocument();
    // The decision is the same document seen from either tab: one acceptance, never two (S10).
    expect(decision()).toBeInTheDocument();
    expect(acceptButton()).toBeEnabled();
    fireEvent.click(balances()[0]);
    expect(cashTab()).toHaveAttribute('aria-selected', 'true');
    expect(await changes()).toBeInTheDocument();
    cashTab().focus();
    fireEvent.keyDown(tabList(), { key: 'ArrowRight' });
    expect(scrapTab()).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(scrapTab());
    fireEvent.keyDown(tabList(), { key: 'ArrowLeft' });
    expect(cashTab()).toHaveAttribute('aria-selected', 'true');
    expect(h.posts('/api/closings/1/decision')).toHaveLength(0);
  });

  it('reads the material sheet read-only, in the frozen order and with the delivery (S7, S8, S9)',
    async () => {
      const h = server();
      await ready(h);
      openScrapTab();
      const panel = await materials();
      const used = within(panel).getByRole('table',
        { name: 'Baterías usadas · unidades por modelo' });
      // The order the document freezes: the used lines by model and then the scrap ones by id.
      expect(within(used).getAllByRole('row')
        .map(row => row.querySelector('th,td')?.textContent))
        .toEqual(['Modelo', '24F-45', '27-60', '31-100', 'Total']);
      const scrap = within(panel).getByRole('table',
        { name: 'Chatarra · kilogramos por material' });
      expect(within(scrap).getAllByRole('row')
        .map(row => row.querySelector('th,td')?.textContent))
        .toEqual(['Material', 'Cobre', 'Aluminio', 'Plomo', 'Bronce', 'Total']);
      const missing = within(used).getByText('31-100').closest('tr')!;
      expect(within(missing).getByText('9')).toBeInTheDocument();
      expect(within(missing).getByText('8')).toBeInTheDocument();
      expect(within(missing).getByText('−1')).toBeInTheDocument();
      const plomo = within(scrap).getByText('Plomo').closest('tr')!;
      expect(within(plomo).getByText('84,500 kg')).toBeInTheDocument();
      expect(within(plomo).getByText('80,200 kg')).toBeInTheDocument();
      expect(within(plomo).getByText('−4,300')).toBeInTheDocument();
      // The branch reads the sheet and types into none of it.
      expect(within(panel).queryByRole('textbox')).not.toBeInTheDocument();
      expect(within(panel).queryByRole('spinbutton')).not.toBeInTheDocument();
      // What acceptance delivers: everything counted, and the shelf back at zero (S9).
      expect(within(panel).getByText('Usadas que se lleva el Almacén').parentElement)
        .toHaveTextContent('26');
      expect(within(panel).getByText('Chatarra que se lleva el Almacén').parentElement)
        .toHaveTextContent('104,450 kg');
      expect(within(panel).getByText('Queda en tu estantería').parentElement)
        .toHaveTextContent('cero');
      expect(panel).toHaveTextContent(
        'Se lleva todo lo contado: 26 usadas y 104,450 kg de chatarra.');
      expect(panel).toHaveTextContent(/la sucursal queda en cero/);
      expect(h.posts('/api/closings/1/decision')).toHaveLength(0);
    });

  it('says plainly that the period bought no materials, instead of an empty table (S7)', async () => {
    const h = server(proposed({ material_lines: [] }));
    await ready(h);
    openScrapTab();
    const panel = await materials();
    expect(within(panel).getByText(/El período no compró materiales/)).toBeInTheDocument();
    expect(within(panel).queryByRole('table')).not.toBeInTheDocument();
    expect(within(balanceStrip()).getAllByRole('button')[2]).toHaveTextContent('Sin materiales');
    // An empty sheet is no reason to keep the branch from accepting.
    expect(acceptButton()).toBeEnabled();
  });

  it('never blocks the acceptance for a material difference, counted or not (S8)', async () => {
    const h = server(proposed({ material_lines: [
      usedMaterial('31-100', '9', '8'), scrapMaterial(3, 'Plomo', '84.500', null)] }));
    await ready(h);
    openScrapTab();
    const panel = await materials();
    // A line nobody counted is informed as pending and blocks nothing either.
    const plomo = within(panel).getByText('Plomo').closest('tr')!;
    expect(within(plomo).getByText('Sin contar')).toBeInTheDocument();
    expect(within(plomo).getAllByRole('cell')[3]).toHaveTextContent('—');
    expect(acceptButton()).toBeEnabled();
    fireEvent.click(acceptButton());
    await waitFor(() => expect(h.posts('/api/closings/1/decision')).toHaveLength(1));
    expect(h.posts('/api/closings/1/decision')[0].init.body).toBe('{"decision":"accepted"}');
    expect(await screen.findByText('Rendición cerrada: la sucursal vuelve a operar.')).toBeInTheDocument();
  });
});

/**
 * The electronic collection of the offer: card, transfer and QR are money the branch collected and
 * that is reported on its own. It is inside no cash identity of the drawer (S2), and a settlement
 * without electronic collection states three zeroes instead of looking like missing data.
 */
describe('the electronic collection of the offer (S2)', () => {
  const collected = (card: string, transfer: string, qr: string) => proposed({
    card_total: card, transfer_total: transfer, qr_total: qr,
    rounds: [round(1, { offer: offer({
      card_total: card, transfer_total: transfer, qr_total: qr }) })] });
  const electronic = () => within(cash())
    .getByText('Electrónico · fuera de la caja').closest('.closing-group') as HTMLElement;

  it('reports card, transfer and QR of the offer outside the drawer it never enters', async () => {
    const h = server(collected('2500.00', '1000.00', '500.00'));
    await ready(h);
    const panel = cash();
    const block = electronic();
    expect(within(block).getByText('Tarjeta').parentElement).toHaveTextContent('Bs 2.500,00');
    expect(within(block).getByText('Transferencia').parentElement).toHaveTextContent('Bs 1.000,00');
    expect(within(block).getByText('QR').parentElement).toHaveTextContent('Bs 500,00');
    expect(block).toHaveTextContent(/no se suma a ninguna igualdad de caja/);
    // S2: none of the three is inside the expected drawer, the difference or the fund left behind.
    const expected = within(panel).getByText('Caja esperada').parentElement!;
    expect(expected).toHaveTextContent('Bs 7.015,00');
    for (const amount of ['2.500,00', '1.000,00', '500,00']) {
      expect(expected).not.toHaveTextContent(amount);
      expect(within(panel).getByText('Diferencia').parentElement).not.toHaveTextContent(amount);
      expect(within(panel).getByText('Fondo que queda en la caja').parentElement)
        .not.toHaveTextContent(amount);
    }
  });

  it('renders a zero electronic collection as Bs 0,00 and not as missing data', async () => {
    const h = server(open());
    await ready(h);
    const block = electronic();
    for (const label of ['Tarjeta', 'Transferencia', 'QR']) {
      const row = within(block).getByText(label).parentElement!;
      expect(row).toHaveTextContent('Bs 0,00');
      expect(row).not.toHaveTextContent('Sin contar');
    }
  });
});

// The difference row is not a rule of its own: it is what makes the panel legible, so the tag keeps
// the separation every other tag of the panel has (S2).
describe('the difference row of the branch panel', () => {
  const styles = () => readFileSync(`${import.meta.dirname}/closings.css`, 'utf8');

  it('separates the missing/over tag from its amount without gluing it to the figure', async () => {
    const h = server();
    await ready(h);
    const difference = within(cash()).getByText('Diferencia').parentElement!;
    expect(difference).toHaveTextContent('− Bs 35,00');
    const tag = within(difference).getByText('Faltante');
    // jsdom does not apply this package's stylesheet to computed styles, so the separation is
    // pinned on the class the tag carries and on the rule the sheet gives that class inside a
    // summary row: the text and the markup stay exactly as they were, only the spacing is CSS's.
    expect(tag).toHaveClass('closing-difference-name');
    expect(styles()).toMatch(/\.closing-summary dd \.closing-difference-name\s*\{[^}]*margin-left:\s*\d+px/);
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
