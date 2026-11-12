import { describe, expect, it } from 'vitest';
import * as model from './closingModel';
import {
  canonicalCountPayload, canonicalDrawerPayload, closingAcceptance, closingAccountLabel,
  closingBlockers, closingBlockReason, closingCents, closingDecisionPayload, closingDecisionReadiness,
  closingDifferenceName, closingLineDifference, closingLineLabel, closingMomentText,
  closingPendingLines, closingPeriod, closingPeriodLabel, closingProgress, closingQuantityText,
  closingRail, closingMoneyText, closingRoundStateLabel, closingSheetChanges, closingSignedCents,
  closingSignedText, drawerDraftFrom, drawerView, emptyDrawerDraft, filterCountLines,
  type Closing, type ClosingCountLine, type ClosingOffer, type ClosingRound, type DrawerDraft,
} from './closingModel';

// The numbers of the chosen artboard (design/rendicion-de-cuentas/03-mesa-conteo.html), read as
// a fixture: Bs 7.015,00 expected, Bs 6.980,00 counted, Bs 900,00 fund, 4,50 % of Bs 32.480,00.
const line = (variant_id: number, expected: number, counted: number | null,
  overrides: Partial<ClosingCountLine> = {}): ClosingCountLine => Object.freeze({
  variant_id, catalog_entry_id: variant_id, brand: 'Bosch', model: 'S4', capacity_ah: '45',
  polarity: variant_id % 2 === 0 ? 'R' : 'L', expected_quantity: expected, counted_quantity: counted,
  ...overrides,
});

const lines: readonly ClosingCountLine[] = [
  line(1, 12, 12), line(2, 9, 8), line(3, 14, 14), line(4, 11, 13), line(5, 7, 7), line(6, 6, 6),
  line(7, 4, 3), line(8, 2, 2), line(9, 1, 1), line(10, 3, null, { model: 'Power', capacity_ah: '110' }),
  line(11, 2, null, { model: 'S5', capacity_ah: '100' }),
];

const closing = (overrides: Partial<Closing> = {}): Closing => Object.freeze({
  id: 1, branch_location_id: 2, branch_name: 'Sopocachi', status: 'open',
  period_start: '2026-08-12T18:00:00Z', cut_at: '2026-09-12T18:30:00Z', closed_at: null,
  commission_rate_percent: null,
  opening_cash_cents: 80000n, cash_sales_cents: 643000n, cash_expenses_cents: 21500n,
  counted_cash_cents: null, contributed_cash_cents: 0n, closing_cash_cents: null,
  sales_total_cents: 3248000n, commission_amount_cents: 146160n,
  card_total_cents: 324000n, transfer_total_cents: 118000n, qr_total_cents: 276000n,
  observation: '', opened_by_account_id: 1, count_lines: lines, rounds: [],
  ...overrides,
});

/** The first settlement of a branch (S11): no inherited fund, no sales, an empty till. */
const bootstrap = (overrides: Partial<Closing> = {}): Closing => closing({
  opening_cash_cents: 0n, cash_sales_cents: 0n, cash_expenses_cents: 0n,
  sales_total_cents: 0n, commission_amount_cents: 0n,
  card_total_cents: 0n, transfer_total_cents: 0n, qr_total_cents: 0n, ...overrides,
});

describe('S1 the settlement and its period', () => {
  it('shows the period as the range between two rendiciones', () => {
    const period = closingPeriod('2026-08-12T18:00:00Z', '2026-09-12T18:30:00Z');
    expect(period.from).toBe('12 ago 2026');
    expect(period.to).toBe('12 sept 2026');
    expect(period.empty).toBe(false);
    expect(closingPeriodLabel(period)).toBe('12 ago 2026 → 12 sept 2026');
  });

  it('marks the bootstrap settlement, which starts and cuts at the same instant', () => {
    const period = closingPeriod('2026-08-12T18:00:00Z', '2026-08-12T18:00:00Z');
    expect(period.empty).toBe(true);
    expect(closingPeriodLabel(period)).toBe('12 ago 2026 → 12 ago 2026');
  });

  it('never names the act with the retired word, in any exported message or label', () => {
    const surfaces: string[] = [];
    for (const value of Object.values(model)) {
      if (typeof value === 'string') surfaces.push(value);
      else if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const inner of Object.values(value as Record<string, unknown>)) {
          if (typeof inner === 'string') surfaces.push(inner);
        }
      }
    }
    expect(surfaces.length).toBeGreaterThan(5);
    for (const surface of surfaces) expect(surface.toLowerCase()).not.toContain('arqueo');
  });

  it('names the four states of the settlement', () => {
    expect(model.closingStatusLabels.open).toBe('Abierta');
    expect(model.closingStatusLabels.closed).toBe('Cerrada');
    expect(model.closingIsLive('proposed')).toBe(true);
    expect(model.closingIsLive('closed')).toBe(false);
    expect(model.closingIsEditable('rejected')).toBe(true);
    expect(model.closingIsEditable('proposed')).toBe(false);
  });
});

describe('S8 the drawer and its difference', () => {
  it('derives the expected drawer from the inherited fund and the period cash', () => {
    const rail = closingRail(closing());
    expect(rail.expected_cents).toBe(701500n);
    expect(closingMoneyText(rail.expected_cents)).toBe('Bs 7.015,00');
  });

  it('shows a shortage with its sign and its name', () => {
    const rail = closingRail(closing({ counted_cash_cents: 698000n, closing_cash_cents: 90000n }));
    expect(rail.difference_cents).toBe(-3500n);
    expect(closingSignedText(-3500n)).toBe('− Bs 35,00');
    expect(closingDifferenceName(-3500n)).toBe('Faltante');
    expect(rail.taken_cents).toBe(608000n);
    expect(closingMoneyText(rail.taken_cents!)).toBe('Bs 6.080,00');
  });

  it('shows a surplus with its sign and its name, and a match as no difference', () => {
    const surplus = closingRail(closing({ counted_cash_cents: 705000n }));
    expect(surplus.difference_cents).toBe(3500n);
    expect(closingSignedText(surplus.difference_cents!)).toBe('+ Bs 35,00');
    expect(closingDifferenceName(surplus.difference_cents!)).toBe('Sobrante');
    expect(closingDifferenceName(0n)).toBe('Sin diferencia');
  });

  it('publishes the difference and what the warehouse takes only once the drawer states them', () => {
    const partial = closingRail(closing({ counted_cash_cents: 698000n }));
    expect(partial.difference_cents).toBe(-3500n);
    expect(partial.taken_cents).toBeNull();
  });

  it('reads a signed amount, never a float', () => {
    expect(closingSignedCents('-35.00')).toBe(-3500n);
    expect(closingSignedCents('35.00')).toBe(3500n);
    expect(closingCents('7015.00')).toBe(701500n);
    expect(() => closingSignedCents('-0.00')).toThrow();
    expect(() => closingCents('7.015,00')).toThrow();
    expect(() => closingSignedCents('35')).toThrow();
  });
});

describe('S9 the commission is reported beside the drawer and inside no cash identity', () => {
  it('leaves the expected drawer and the taken cash untouched by the commission', () => {
    const without = closingRail(closing({ commission_amount_cents: 0n }));
    const withMoney = closingRail(closing({ commission_amount_cents: 999_999_900n }));
    expect(withMoney.expected_cents).toBe(without.expected_cents);
    expect(withMoney.difference_cents).toBe(without.difference_cents);
    expect(withMoney.taken_cents).toBe(without.taken_cents);
    expect(withMoney.commission_cents).toBe(999_999_900n);
  });

  it('keeps the electronic collection out of the till as well (S13)', () => {
    const rail = closingRail(closing({ card_total_cents: 324000n, transfer_total_cents: 118000n,
      qr_total_cents: 276000n }));
    expect(rail.expected_cents).toBe(701500n);
    expect(rail.expected_cents).toBe(rail.opening_cents + rail.cash_sales_cents - rail.cash_expenses_cents);
    expect(rail.qr_cents).toBe(276000n);
    expect(rail.card_cents + rail.transfer_cents + rail.qr_cents).toBe(718000n);
    expect(rail.expected_cents).not.toBe(rail.opening_cents + rail.cash_sales_cents
      - rail.cash_expenses_cents + rail.qr_cents);
  });
});

describe('S4 the count sheet is not blind and never recalculates the expected quantity', () => {
  it('states the progress of the sheet and which rows are still pending', () => {
    const progress = closingProgress(lines);
    expect(progress).toEqual({ total: 11, counted: 9, pending: 2 });
    expect(closingPendingLines(lines).map(entry => entry.variant_id)).toEqual([10, 11]);
  });

  it('shows the difference of a counted row with its sign and a pending row without one', () => {
    expect(closingLineDifference(line(2, 9, 8))).toBe(-1);
    expect(closingLineDifference(line(4, 11, 13))).toBe(2);
    expect(closingLineDifference(line(1, 12, 12))).toBe(0);
    expect(closingLineDifference(line(10, 3, null))).toBeNull();
    expect(closingQuantityText(-1)).toBe('−1');
    expect(closingQuantityText(2)).toBe('+2');
    expect(closingQuantityText(0)).toBe('—');
    expect(closingQuantityText(null)).toBe('—');
  });

  it('takes only what was counted, so the expected quantity cannot even be expressed', () => {
    expect(canonicalCountPayload([{ variant_id: 2, counted: '8' }, { variant_id: 10, counted: '0' }]))
      .toEqual([{ variant_id: 2, counted_quantity: 8 }, { variant_id: 10, counted_quantity: 0 }]);
    expect(() => canonicalCountPayload([])).toThrow(model.closingCountEmptyMessage);
    expect(() => canonicalCountPayload([{ variant_id: 2, counted: '' }])).toThrow(model.closingQuantityMessage);
    expect(() => canonicalCountPayload([{ variant_id: 2, counted: '1.5' }])).toThrow(model.closingQuantityMessage);
    expect(() => canonicalCountPayload([{ variant_id: 2, counted: '1000001' }])).toThrow(model.closingQuantityMessage);
    expect(() => canonicalCountPayload([{ variant_id: 0, counted: '1' }])).toThrow(model.closingQuantityMessage);
    expect(() => canonicalCountPayload([{ variant_id: 2, counted: '1' }, { variant_id: 2, counted: '2' }]))
      .toThrow(model.closingQuantityMessage);
  });

  it('saves a sheet longer than one request in order, never dropping a counted line', () => {
    const lines = Array.from({ length: 191 }, (_, index) => ({ variant_id: index + 1, counted_quantity: index }));
    const batches = model.closingCountBatches(lines);
    expect(batches.map(batch => batch.length)).toEqual([190, 1]);
    expect(batches.flat().map(line => line.variant_id)).toEqual(lines.map(line => line.variant_id));
    expect(model.closingCountBatches(lines.slice(0, 190)).map(batch => batch.length)).toEqual([190]);
    expect(model.closingCountBatches([])).toEqual([]);
  });

  it('filters the sheet by brand, model, capacity and polarity without asking the server', () => {
    expect(filterCountLines(lines, '').length).toBe(11);
    expect(filterCountLines(lines, 'S5').map(entry => entry.variant_id)).toEqual([11]);
    expect(filterCountLines(lines, '110').map(entry => entry.variant_id)).toEqual([10]);
    expect(filterCountLines(lines, 'r').map(entry => entry.variant_id)).toEqual([2, 4, 6, 8, 10]);
    expect(() => filterCountLines(lines, 'x'.repeat(200))).toThrow(model.closingSearchMessage);
  });

  it('labels a row with its battery, polarity and capacity', () => {
    expect(closingLineLabel(line(10, 3, null, { model: 'Power', capacity_ah: '110' })))
      .toBe('Bosch Power R · 110 Ah');
  });
});

describe('S10 the fund, the contribution and what the warehouse takes', () => {
  it('reads the drawer the admin types over the facts the settlement holds', () => {
    const rail = closingRail(closing());
    const view = drawerView(rail, { counted: '6.980,00', contribution: '0,00', fund: '900,00',
      observation: '' });
    expect(view.problem).toBe('');
    expect(view.counted_cents).toBe(698000n);
    expect(view.contribution_cents).toBe(0n);
    expect(view.fund_cents).toBe(90000n);
    expect(view.difference_cents).toBe(-3500n);
    expect(view.taken_cents).toBe(608000n);
    expect(view.excess_cents).toBeNull();
  });

  it('names the amount the fund exceeds the drawer by, contribution included', () => {
    const rail = closingRail(closing());
    const above = drawerView(rail, { counted: '6.980,00', contribution: '0,00', fund: '7.100,00',
      observation: '' });
    expect(above.excess_cents).toBe(12000n);
    // A fund that cannot be left leaves nothing to take: it is a draft, not an offer.
    expect(above.taken_cents).toBeNull();
    // The contribution the admin declares lifts the bound by exactly its own amount (S10, L13).
    const contributed = drawerView(rail, { counted: '6.980,00', contribution: '120,00', fund: '7.100,00',
      observation: '' });
    expect(contributed.excess_cents).toBeNull();
    expect(contributed.taken_cents).toBe(0n);
    expect(contributed.contribution_cents).toBe(12000n);
    // One cent over the bound is still over it.
    const offByOneCent = drawerView(rail, { counted: '6.980,00', contribution: '119,99', fund: '7.100,00',
      observation: '' });
    expect(offByOneCent.excess_cents).toBe(1n);
  });

  it('lets an empty drawer reach a fund once the admin declares the contribution (S11)', () => {
    const rail = closingRail(bootstrap());
    expect(rail.expected_cents).toBe(0n);
    // With no contribution the empty till bounds the fund at zero: the first settlement is refused.
    const noAporte = drawerView(rail, { counted: '0,00', contribution: '0,00', fund: '500,00',
      observation: '' });
    expect(noAporte.excess_cents).toBe(50000n);
    expect(noAporte.taken_cents).toBeNull();
    // The money the warehouse puts in is the fund it leaves behind: nothing is taken out.
    const declared = drawerView(rail, { counted: '0,00', contribution: '500,00', fund: '500,00',
      observation: '' });
    expect(declared.excess_cents).toBeNull();
    expect(declared.taken_cents).toBe(0n);
    expect(declared.difference_cents).toBe(0n);
    // Bs 300,00 into an empty till cannot leave Bs 500,00 behind.
    const short = drawerView(rail, { counted: '0,00', contribution: '300,00', fund: '500,00',
      observation: '' });
    expect(short.excess_cents).toBe(20000n);
  });

  it('keeps the contribution out of the money collected and out of the commission', () => {
    const rail = closingRail(closing());
    const withAporte = drawerView(rail, { counted: '6.980,00', contribution: '500,00', fund: '900,00',
      observation: '' });
    // It is money the warehouse put in: the expected drawer and its difference do not move.
    expect(withAporte.expected_cents).toBe(rail.expected_cents);
    expect(withAporte.difference_cents).toBe(-3500n);
    expect(rail.cash_sales_cents).toBe(643000n);
    expect(rail.sales_total_cents).toBe(3248000n);
    expect(rail.commission_cents).toBe(146160n);
    // counted + aporte − fondo: the contribution is what makes the fund reachable, nothing else.
    expect(withAporte.taken_cents).toBe(658000n);
  });

  it('keeps a draft the admin has not stated yet explicitly absent, never zero', () => {
    const rail = closingRail(closing());
    const view = drawerView(rail, emptyDrawerDraft);
    expect(view.counted_cents).toBeNull();
    expect(view.contribution_cents).toBe(0n);
    expect(view.fund_cents).toBeNull();
    expect(view.difference_cents).toBeNull();
    expect(view.taken_cents).toBeNull();
    expect(view.excess_cents).toBeNull();
  });

  it('never guesses the fund bound while the contribution is not declared', () => {
    // Without the contribution the screen cannot tell the bound, so it publishes none: the
    // server's own refusal is then the only one the admin reads.
    const view = drawerView(closingRail(closing()), { counted: '6.980,00', contribution: '',
      fund: '9.999,00', observation: '' });
    expect(view.contribution_cents).toBeNull();
    expect(view.excess_cents).toBeNull();
    expect(view.taken_cents).toBeNull();
    // A contribution it cannot read is an amount it names, and not a bound it invents either.
    const unreadable = drawerView(closingRail(closing()), { counted: '6.980,00', contribution: 'mil',
      fund: '900,00', observation: '' });
    expect(unreadable.problem).toBe(model.closingAmountMessage);
    expect(unreadable.excess_cents).toBeNull();
  });

  it('reports an amount it cannot read instead of guessing one', () => {
    const view = drawerView(closingRail(closing()), { counted: '6.980,001', contribution: '0,00',
      fund: '', observation: '' });
    expect(view.problem).toBe(model.closingAmountMessage);
    expect(view.counted_cents).toBeNull();
  });

  it('saves the drawer with the four keys of the contract and the declared contribution', () => {
    expect(canonicalDrawerPayload({ counted: '6.980,00', contribution: '0,00', fund: '900,00',
      observation: 'contado en persona' }))
      .toEqual({ counted_cash: '6980.00', contributed_cash: '0.00', closing_cash: '900.00',
        observation: 'contado en persona' });
    expect(canonicalDrawerPayload({ counted: '0,00', contribution: '500,00', fund: '500,00',
      observation: '' }))
      .toEqual({ counted_cash: '0.00', contributed_cash: '500.00', closing_cash: '500.00', observation: '' });
    expect(canonicalDrawerPayload(emptyDrawerDraft)).toEqual({
      counted_cash: null, contributed_cash: '0.00', closing_cash: null, observation: '' });
    // The contribution is a fact of the settlement: an empty field is a decision still to make.
    expect(() => canonicalDrawerPayload({ ...emptyDrawerDraft, contribution: '' }))
      .toThrow(model.closingContributionMessage);
    expect(() => canonicalDrawerPayload({ counted: '0,00', contribution: 'mil', fund: '0,00', observation: '' }))
      .toThrow(model.closingAmountMessage);
    expect(() => canonicalDrawerPayload({ ...emptyDrawerDraft, contribution: '0,00',
      observation: 'x'.repeat(1001) })).toThrow();
  });

  it('restores the draft the settlement already holds, contribution included', () => {
    const draft = drawerDraftFrom(closing({ counted_cash_cents: 698000n, closing_cash_cents: 90000n,
      contributed_cash_cents: 50000n, observation: 'contado en persona' }));
    expect(draft).toEqual<DrawerDraft>({ counted: '6.980,00', contribution: '500,00', fund: '900,00',
      observation: 'contado en persona' });
    // A saved draft never reopens with its contribution silently zeroed.
    expect(drawerDraftFrom(closing()).contribution).toBe('0,00');
    expect(drawerDraftFrom(closing())).toEqual<DrawerDraft>({ counted: '', contribution: '0,00',
      fund: '', observation: '' });
  });
});

describe('S14 what still blocks the offer, named', () => {
  const complete = (overrides: Partial<Closing> = {}) => closing({
    counted_cash_cents: 698000n, closing_cash_cents: 90000n,
    count_lines: lines.map(entry => Object.freeze({ ...entry,
      counted_quantity: entry.counted_quantity ?? entry.expected_quantity })),
    ...overrides,
  });

  const view = (subject: Closing, draft: DrawerDraft = { counted: '6.980,00', contribution: '0,00',
    fund: '900,00', observation: '' }) => drawerView(closingRail(subject), draft);

  it('names the variants still to count and the drawer that is not stated', () => {
    const subject = closing();
    const blockers = closingBlockers(subject, view(subject, emptyDrawerDraft));
    expect(blockers.map(blocker => blocker.code)).toEqual(['count_pending', 'cash_not_stated']);
    expect(blockers[0].message).toContain('Faltan 2 variantes por contar');
    expect(blockers[0].message).toContain('Bosch Power R · 110 Ah');
    expect(blockers[0].message).toContain('Bosch S5 L · 100 Ah');
    expect(blockers[1].message).toBe('Falta la caja contada y el fondo que queda en la caja: el cierre no puede proponerse sin eso.');
    expect(closingBlockReason(blockers)).toContain('Faltan 2 variantes por contar');
  });

  it('names the contribution it does not have and never guesses the bound without it', () => {
    const subject = complete();
    const missing = closingBlockers(subject, view(subject, { counted: '6.980,00', contribution: '',
      fund: '900,00', observation: '' }));
    expect(missing.map(blocker => blocker.code)).toEqual(['cash_not_stated']);
    expect(missing[0].message).toBe('Falta el aporte del Almacén: el cierre no puede proponerse sin eso.');
    // With the contribution declared the fund the drawer cannot hold is a fund that fits.
    expect(closingBlockers(subject, view(subject, { counted: '6.980,00', contribution: '120,00',
      fund: '7.100,00', observation: '' }))).toEqual([]);
    expect(closingBlockers(subject, view(subject, { counted: '6.980,00', contribution: '119,99',
      fund: '7.100,00', observation: '' })).map(blocker => blocker.code)).toEqual(['fund_exceeds_drawer']);
  });

  it('names only the side of the drawer that is missing', () => {
    const subject = complete();
    expect(closingBlockers(subject, view(subject, { counted: '', contribution: '0,00', fund: '900,00',
      observation: '' }))[0].message)
      .toBe('Falta la caja contada: el cierre no puede proponerse sin eso.');
    expect(closingBlockers(subject, view(subject, { counted: '6.980,00', contribution: '0,00', fund: '',
      observation: '' }))[0].message)
      .toBe('Falta el fondo que queda en la caja: el cierre no puede proponerse sin eso.');
  });

  it('lets the offer through only when the sheet is covered, the drawer is stated and nothing is unsaved', () => {
    const subject = complete();
    expect(closingBlockers(subject, view(subject), false)).toEqual([]);
    expect(closingBlockReason([])).toBe('La rendición se puede proponer: el conteo cubre toda variante con existencia y la caja está contada.');
    expect(closingBlockers(subject, view(subject), true).map(blocker => blocker.code)).toEqual(['unsaved']);
  });

  it('names a fund above the drawer and an amount it cannot read', () => {
    const subject = complete();
    const excess = closingBlockers(subject, view(subject, { counted: '6.980,00', contribution: '0,00',
      fund: '7.100,00', observation: '' }));
    expect(excess.map(blocker => blocker.code)).toEqual(['fund_exceeds_drawer']);
    expect(excess[0].message).toBe('El fondo supera la caja contada más el aporte en Bs 120,00.');
    const invalid = closingBlockers(subject, view(subject, { counted: '6.980,001', contribution: '0,00',
      fund: '900,00', observation: '' }));
    expect(invalid.map(blocker => blocker.code)).toEqual(['invalid_amount']);
  });

  it('refuses to offer again while the branch decides or after the closure', () => {
    const proposed = closingBlockers(complete({ status: 'proposed', commission_rate_percent: '4.50' }),
      view(complete({ status: 'proposed', commission_rate_percent: '4.50' })));
    expect(proposed.map(blocker => blocker.code)).toEqual(['state_conflict']);
    expect(proposed[0].message).toContain('decisión de la sucursal');
    const closed = closingBlockers(complete({ status: 'closed', commission_rate_percent: '4.50',
      closed_at: '2026-09-12T18:31:00Z' }), view(complete()));
    expect(closed[0].message).toBe('La rendición está cerrada: no se puede proponer ni editar.');
  });
});

// ---------------------------------------------------------------------------------
// The branch's side: it only accepts or rejects the offer it is shown (S14, S15)
// ---------------------------------------------------------------------------------

const completeLines: readonly ClosingCountLine[] = lines.map(entry => Object.freeze({
  ...entry, counted_quantity: entry.counted_quantity ?? entry.expected_quantity }));

const offerLines = completeLines.map(entry => Object.freeze({
  variant_id: entry.variant_id, expected_quantity: entry.expected_quantity,
  counted_quantity: entry.counted_quantity! }));

const offer = (overrides: Partial<ClosingOffer> = {}): ClosingOffer => Object.freeze({
  period_start: '2026-08-12T18:00:00Z', cut_at: '2026-09-12T18:30:00Z',
  sales_total_cents: 3248000n, commission_rate_percent: '4.50', commission_amount_cents: 146160n,
  cash_sales_cents: 643000n, cash_expenses_cents: 21500n, card_total_cents: 324000n,
  transfer_total_cents: 118000n, qr_total_cents: 276000n,
  counted_cash_cents: 698000n, contributed_cash_cents: 0n, closing_cash_cents: 90000n,
  observation: '', count_lines: offerLines, ...overrides,
});

const answer = (overrides: Partial<ClosingRound> = {}): ClosingRound => Object.freeze({
  id: 1, round: 1, offer: offer(), proposed_by_account_id: 1,
  proposed_at: '2026-09-12T14:58:00Z', decision: '', decision_reason: '',
  decided_by_account_id: null, decided_at: null, ...overrides,
});

const proposed = (overrides: Partial<Closing> = {}): Closing => closing({
  status: 'proposed', commission_rate_percent: '4.50', count_lines: completeLines,
  counted_cash_cents: 698000n, closing_cash_cents: 90000n, rounds: [answer()], ...overrides,
});

describe('S14 the branch only accepts or rejects, with a mandatory motive', () => {
  it('states the two decisions it can send and never a rejection without its motive', () => {
    expect(closingDecisionPayload('accepted', '')).toEqual({ decision: 'accepted' });
    expect(closingDecisionPayload('rejected', '  faltó contar la bodega  '))
      .toEqual({ decision: 'rejected', reason: 'faltó contar la bodega' });
    expect(() => closingDecisionPayload('rejected', '')).toThrow(model.closingMotiveRequiredMessage);
    expect(() => closingDecisionPayload('rejected', '   ')).toThrow(model.closingMotiveRequiredMessage);
    expect(() => closingDecisionPayload('rejected', 'x'.repeat(1001)))
      .toThrow(model.closingMotiveLengthMessage);
    expect(() => closingDecisionPayload('rejected', 'motivo\u0000')).toThrow(model.closingMotiveLengthMessage);
    // An acceptance carries no reason at all: the two decisions are exclusive.
    expect(closingDecisionPayload('accepted', 'x'.repeat(1001))).toEqual({ decision: 'accepted' });
  });

  it('offers a decision only while the settlement is proposed, naming why otherwise', () => {
    expect(closingDecisionReadiness(proposed())).toEqual({ awaiting: true, reason: '' });
    const open = closingDecisionReadiness(closing({ status: 'open' }));
    expect(open.awaiting).toBe(false);
    expect(open.reason).toContain('congelada');
    expect(open.reason).toContain('todavía no propuso');
    const rejected = closingDecisionReadiness(closing({ status: 'rejected',
      commission_rate_percent: '4.50' }));
    expect(rejected.awaiting).toBe(false);
    expect(rejected.reason).toContain('todavía no propuso');
    const closed = closingDecisionReadiness(closing({ status: 'closed',
      commission_rate_percent: '4.50', closed_at: '2026-09-12T18:31:00Z' }));
    expect(closed.awaiting).toBe(false);
    expect(closed.reason).toContain('cerrada');
  });

  it('reads the offer it is accepting: what every counted variant becomes and the drawer', () => {
    const acceptance = closingAcceptance(proposed())!;
    expect(acceptance.round.round).toBe(1);
    expect(acceptance.changes).toHaveLength(11);
    const power = acceptance.changes.find(change => change.variant_id === 10)!;
    expect(power.label).toBe('Bosch Power R · 110 Ah');
    expect({ system: power.system_quantity, counted: power.counted_quantity, becomes: power.becomes_quantity,
      difference: power.difference }).toEqual({ system: 3, counted: 3, becomes: 3, difference: 0 });
    const short = acceptance.changes.find(change => change.variant_id === 2)!;
    expect({ system: short.system_quantity, counted: short.counted_quantity, becomes: short.becomes_quantity,
      difference: short.difference }).toEqual({ system: 9, counted: 8, becomes: 8, difference: -1 });
    // Bs 7.015,00 expected, Bs 6.980,00 counted, Bs 35,00 short: the commission is inside no identity.
    expect(acceptance.rail.expected_cents).toBe(701500n);
    expect(acceptance.rail.difference_cents).toBe(-3500n);
    expect(acceptance.rail.fund_cents).toBe(90000n);
    expect(acceptance.rail.taken_cents).toBe(608000n);
    expect(acceptance.rail.commission_cents).toBe(146160n);
    expect(acceptance.rail.expected_cents).toBe(80000n + 643000n - 21500n);
    // An open settlement has no offer to accept.
    expect(closingAcceptance(closing())).toBeNull();
  });

  it('refuses an offer that does not agree with the settlement it belongs to', () => {
    const drifted = proposed({ counted_cash_cents: 700000n });
    expect(() => closingAcceptance(drifted)).toThrow(model.closingAcceptanceMismatchMessage);
    const decided = proposed({ rounds: [answer({ decision: 'accepted', decided_by_account_id: 2,
      decided_at: '2026-09-12T15:00:00Z' })] });
    expect(closingAcceptance(decided)).toBeNull();
  });

  it('reads the counted sheet of a settlement that is not being offered', () => {
    const changes = closingSheetChanges(closing({ count_lines: completeLines }));
    expect(changes).toHaveLength(11);
    expect(changes.find(change => change.variant_id === 4)).toMatchObject({ system_quantity: 11,
      counted_quantity: 13, becomes_quantity: 13, difference: 2 });
    expect(closingSheetChanges(closing()).map(change => change.variant_id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

describe('S15 every round of the settlement stays legible', () => {
  it('names who answered each round and when, in the branch time zone', () => {
    expect(closingAccountLabel(12)).toBe('Cuenta #12');
    expect(closingMomentText('2026-09-12T14:44:00Z')).toBe('12 sept 2026, 10:44');
    expect(closingMomentText('not an instant')).toBe('Fecha no disponible');
  });

  it('names the state of every round and keeps each rejection motive', () => {
    expect(closingRoundStateLabel('')).toBe('Por decidir');
    expect(closingRoundStateLabel('accepted')).toBe('Aceptada');
    expect(closingRoundStateLabel('rejected')).toBe('Rechazada');
    const rounds = [answer({ decision: 'rejected', decision_reason: 'La comisión estaba mal.',
      decided_by_account_id: 2, decided_at: '2026-09-12T14:44:00Z' }),
    answer({ id: 2, round: 2 })];
    expect(rounds.map(entry => entry.decision_reason)).toEqual(['La comisión estaba mal.', '']);
    expect(rounds.map(entry => closingRoundStateLabel(entry.decision))).toEqual(['Rechazada', 'Por decidir']);
  });
});
