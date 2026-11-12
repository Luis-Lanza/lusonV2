import { describe, expect, it } from 'vitest';
import * as model from './closingModel';
import {
  canonicalCountPayload, canonicalDrawerPayload, closingAcceptance, closingAccountLabel,
  closingBlockers, closingBlockReason, closingCents, closingDecisionPayload, closingDecisionReadiness,
  closingDifferenceName, closingLineDifference, closingLineLabel, closingMomentText,
  closingPendingLines, closingPeriod, closingPeriodLabel, closingProgress, closingQuantityText,
  closingRail, closingMoneyText, closingRoundStateLabel, closingSheetChanges, closingSignedCents,
  closingSignedText, drawerDraftFrom, drawerView, emptyDrawerDraft, filterCountLines,
  canonicalCorrection, canonicalCorrectionBody, closingAcceptedCorrections, closingCorrectedAmounts,
  closingCorrectedCommission, closingCorrectedCounts, closingCorrectionPreview,
  closingCorrectionReadiness, closingPendingCorrection, correctionDraftFrom,
  closingAddLine, closingCatalogueOptions, closingCountChanges, closingLineIsOutsideSystem,
  closingSheetRows, closingSheetVariantIDs,
  type Closing, type ClosingCatalogueVariant, type ClosingCountLine, type ClosingCorrection,
  type ClosingOffer, type ClosingRound, type CorrectionDraft, type DrawerDraft,
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
  observation: '', opened_by_account_id: 1, count_lines: lines, rounds: [], corrections: [],
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

// ---------------------------------------------------------------------------------
// Corrections of a closed settlement (S16)
// ---------------------------------------------------------------------------------

/** The closed settlement of the artboard: Bs 6.980,00 counted over Bs 7.015,00 expected, fund 900. */
const settled = (overrides: Partial<Closing> = {}): Closing => closing({
  status: 'closed', closed_at: '2026-09-12T18:31:00Z', commission_rate_percent: '4.50',
  counted_cash_cents: 698000n, closing_cash_cents: 90000n, ...overrides,
});

const accepted = (overrides: Partial<ClosingCorrection> = {}): ClosingCorrection => Object.freeze({
  id: 3, closing_id: 1, status: 'accepted', reason: 'conté mal el cajón',
  payload: Object.freeze({ counted_quantities: Object.freeze([]), counted_cash_cents: 695000n,
    commission_amount_cents: null, closing_cash_cents: null }),
  proposed_by_account_id: 1, proposed_at: '2026-09-12T19:00:00Z',
  decided_by_account_id: 2, decided_at: '2026-09-12T19:10:00Z', decision_reason: '',
  effects: Object.freeze([Object.freeze({ kind: 'counted_cash' as const, variant_id: null,
    quantity_delta: null, amount_delta_cents: -3000n })]),
  ...overrides,
});

const pending = (overrides: Partial<ClosingCorrection> = {}): ClosingCorrection => Object.freeze({
  id: 4, closing_id: 1, status: 'proposed', reason: 'la caja estaba mal y una batería',
  payload: Object.freeze({ counted_quantities: Object.freeze([{ variant_id: 2, counted_quantity: 7 }]),
    counted_cash_cents: 710000n, commission_amount_cents: null, closing_cash_cents: null }),
  proposed_by_account_id: 1, proposed_at: '2026-09-12T20:00:00Z',
  decided_by_account_id: null, decided_at: null, decision_reason: '', effects: Object.freeze([]),
  ...overrides,
});

const draft = (overrides: Partial<CorrectionDraft> = {}): CorrectionDraft => Object.freeze({
  reason: 'conté mal el cajón', counted: Object.freeze({}),
  counted_cash: '6.980,00', commission: '1.461,60', fund: '900,00', ...overrides,
});

describe('S16 what the accepted corrections already changed', () => {
  it('shows a corrected number as corrected, beside the signed one and with its delta', () => {
    // The published drawer is the corrected one: Bs 6.950,00 over the Bs 6.980,00 that were signed.
    const document = settled({ counted_cash_cents: 695000n, corrections: [accepted()] });
    const amounts = closingCorrectedAmounts(document);
    expect(amounts).toHaveLength(1);
    expect(amounts[0]).toEqual({ kind: 'counted_cash', label: 'Caja contada',
      signed_cents: 698000n, corrected_cents: 695000n, delta_cents: -3000n });
    // The corrected drawer is the one the identities of the document follow.
    expect(closingRail(document).difference_cents).toBe(695000n - 701500n);
    expect(closingRail(document).taken_cents).toBe(695000n - 90000n);
  });

  it('recovers the signed commission from the published one plus its delta', () => {
    const document = settled({ corrections: [accepted({
      payload: Object.freeze({ counted_quantities: Object.freeze([]), counted_cash_cents: null,
        commission_amount_cents: 200000n, closing_cash_cents: null }),
      effects: Object.freeze([Object.freeze({ kind: 'commission' as const, variant_id: null,
        quantity_delta: null, amount_delta_cents: 200000n - 146160n })]) })] });
    // The document publishes the commission the period was signed with; the corrected one is derived.
    expect(closingCorrectedCommission(document)).toBe(200000n);
    const commission = closingCorrectedAmounts(document)
      .find(amount => amount.kind === 'commission')!;
    expect(commission.signed_cents).toBe(146160n);
    expect(commission.corrected_cents).toBe(200000n);
    expect(commission.delta_cents).toBe(200000n - 146160n);
  });

  it('shows a corrected quantity with the signed one and the delta of the journal', () => {
    const document = settled({ corrections: [accepted({
      payload: Object.freeze({ counted_quantities: Object.freeze([{ variant_id: 2, counted_quantity: 7 }]),
        counted_cash_cents: null, commission_amount_cents: null, closing_cash_cents: null }),
      effects: Object.freeze([Object.freeze({ kind: 'stock' as const, variant_id: 2,
        quantity_delta: -1, amount_delta_cents: null })]) })] });
    const counts = closingCorrectedCounts(document);
    expect(counts).toHaveLength(1);
    expect(counts[0]).toMatchObject({ variant_id: 2, signed_quantity: 8,
      corrected_quantity: 7, delta: -1 });
    expect(counts[0].label).toBe('Bosch S4 R · 45 Ah');
  });

  it('renders nothing invented for a settlement with no correction', () => {
    expect(closingCorrectedAmounts(settled())).toEqual([]);
    expect(closingCorrectedCounts(settled())).toEqual([]);
    expect(closingAcceptedCorrections(settled())).toEqual([]);
    expect(closingPendingCorrection(settled())).toBeNull();
    expect(closingCorrectionPreview(settled())).toBeNull();
    expect(closingCorrectedCommission(settled())).toBe(146160n);
  });
});

describe('S16 the correction that waits for the branch', () => {
  it('is the proposed one, and the only one, with its reason and its author', () => {
    const document = settled({ corrections: [accepted(), pending()] });
    const waiting = closingPendingCorrection(document)!;
    expect(waiting.id).toBe(4);
    expect(waiting.reason).toBe('la caja estaba mal y una batería');
    expect(waiting.proposed_by_account_id).toBe(1);
    expect(closingAcceptedCorrections(document)).toHaveLength(1);
    expect(closingCorrectionReadiness(document)).toEqual({ awaiting: true, reason: '' });
  });

  it('states what accepting it would change, with the identities over the corrected drawer', () => {
    const preview = closingCorrectionPreview(settled({ corrections: [pending()] }))!;
    expect(preview.correction.id).toBe(4);
    expect(preview.amounts).toEqual([{ kind: 'counted_cash', label: 'Caja contada',
      current_cents: 698000n, proposed_cents: 710000n, delta_cents: 12000n }]);
    expect(preview.counts).toEqual([{ variant_id: 2, label: 'Bosch S4 R · 45 Ah',
      current_quantity: 8, proposed_quantity: 7, delta: -1 }]);
    // The expected cash is untouched by a correction and the difference follows the corrected drawer.
    expect(preview.expected_cents).toBe(701500n);
    expect(preview.counted_cents).toBe(710000n);
    expect(preview.difference_cents).toBe(710000n - 701500n);
    expect(preview.fund_cents).toBe(90000n);
    expect(preview.taken_cents).toBe(710000n - 90000n);
    expect(preview.commission_cents).toBe(146160n);
  });

  it('is not decidable before the closure, and says so', () => {
    const live = closing({ status: 'proposed', commission_rate_percent: '4.50',
      corrections: [pending()] });
    expect(closingCorrectionPreview(live)).toBeNull();
    expect(closingCorrectionReadiness(live).awaiting).toBe(false);
    expect(closingCorrectionReadiness(live).reason).toContain('no está cerrada');
    expect(closingCorrectionReadiness(settled()).awaiting).toBe(false);
    expect(closingCorrectionReadiness(settled()).reason).toContain('no tiene una corrección');
  });

  it('refuses a correction of another settlement instead of describing it', () => {
    expect(() => closingCorrectionPreview(settled({ corrections: [pending({ closing_id: 2 })] })))
      .toThrow();
  });
});

describe('S16 the correction the warehouse proposes', () => {
  it('seeds the draft from the numbers the settlement reads today', () => {
    const document = settled({ counted_cash_cents: 695000n, corrections: [accepted()] });
    const seeded = correctionDraftFrom(document);
    // The corrected drawer is what a second correction takes its difference against (036, 040).
    expect(seeded.counted_cash).toBe('6.950,00');
    expect(seeded.commission).toBe('1.461,60');
    expect(seeded.fund).toBe('900,00');
    expect(seeded.reason).toBe('');
    expect(seeded.counted[1]).toBe('12');
  });

  it('states only the values that really changed', () => {
    const body = canonicalCorrection(settled(), draft({
      counted: Object.freeze({ 2: '7' }), counted_cash: '7.100,00' }));
    expect(body).toEqual({
      reason: 'conté mal el cajón',
      payload: { counted_quantities: [{ variant_id: 2, counted_quantity: 7 }], counted_cash: '7100.00' },
    });
    // A restated value is not a correction of it, neither an amount nor a quantity: the sheet keeps
    // what it counted and only the line that changed is stated.
    const restated = canonicalCorrection(settled(), draft({ reason: 'motivo',
      counted: Object.freeze({ 1: '11', 2: '8' }), counted_cash: '7.100,00' }));
    expect(restated.payload).toEqual({
      counted_quantities: [{ variant_id: 1, counted_quantity: 11 }], counted_cash: '7100.00' });
    // A value restated as it reads today is not a correction of it, and a correction that states
    // nothing at all is refused instead of sent.
    expect(() => canonicalCorrection(settled(),
      draft({ reason: 'motivo', counted_cash: '', fund: '900,00' }))).toThrow(/al menos un valor/);
  });

  it('refuses a correction without a reason or without any value', () => {
    expect(() => canonicalCorrection(settled(), draft({ reason: '   ', counted: Object.freeze({ 2: '7' }) })))
      .toThrow(/motivo/);
    expect(() => canonicalCorrection(settled(), draft({ reason: 'un motivo' })))
      .toThrow(/al menos un valor/);
    expect(() => canonicalCorrectionBody({ reason: '', payload: { counted_cash: '1.00' } }))
      .toThrow(/motivo/);
    expect(() => canonicalCorrectionBody({ reason: 'un motivo', payload: {} }))
      .toThrow(/al menos un valor/);
  });

  it('admits only canonical money and whole quantities', () => {
    expect(() => canonicalCorrection(settled(), draft({ counted_cash: 'no es un monto' })))
      .toThrow(/monto/i);
    expect(() => canonicalCorrection(settled(), draft({ counted: Object.freeze({ 1: '1.5' }) })))
      .toThrow(/entero/);
    expect(() => canonicalCorrection(settled(), draft({ counted: Object.freeze({ 1: '-1' }) })))
      .toThrow(/entero/);
    expect(() => canonicalCorrectionBody({ reason: 'un motivo', payload: { counted_cash: '6980' } }))
      .toThrow(/monto/i);
    // A key the contract does not take is never sent.
    expect(() => canonicalCorrectionBody({ reason: 'un motivo',
      payload: { fund: '1.00' } } as never)).toThrow(/al menos un valor/);
  });
});

// A battery that exists physically and the system does not have: the sheet only lists what the cut
// knew, so the upward half of S5 is a row the admin adds from the branch's own catalogue (L38).
const catalogueVariant = (variant_id: number, overrides: Partial<ClosingCatalogueVariant> = {}):
ClosingCatalogueVariant => Object.freeze({
  variant_id, catalog_entry_id: variant_id, brand: 'Toyo', model: 'NS60', capacity_ah: '65',
  polarity: 'R', existing: 0n, ...overrides,
});

describe('S4, S5 a battery the system did not have', () => {
  it('offers only what the branch does not hold and the sheet does not list', () => {
    const options = closingCatalogueOptions([
      catalogueVariant(1, { brand: 'Bosch', model: 'S4', capacity_ah: '45', polarity: 'L' }),
      catalogueVariant(20),
      // The same variant twice in one page is offered once, never twice.
      catalogueVariant(20),
      catalogueVariant(21, { existing: 4n, polarity: 'L' }),
    ], closingSheetVariantIDs(closing()));
    expect(options.map(option => [option.variant.variant_id, option.state])).toEqual([
      [1, 'listed'], [20, 'addable'], [21, 'held']]);
    // The three states are said in words, so the admin never guesses from a colour.
    expect(model.closingCatalogueListedTag).toBe('Ya está en la planilla');
    expect(model.closingCatalogueHeldTag).toBe('La sucursal ya tiene stock');
    expect(model.closingOutsideSystemTag).toBe('Fuera del sistema');
  });

  it('marks an added row as outside the system, with no expected quantity at all', () => {
    const rows = closingSheetRows(closing(), [catalogueVariant(20)]);
    // The sheet of the cut keeps every line and the new row joins it, in variant order.
    expect(rows.map(row => row.variant_id)).toEqual([...lines.map(line => line.variant_id), 20]);
    const added = rows[rows.length - 1];
    expect(added.expected_quantity).toBe(0);
    expect(added.counted_quantity).toBeNull();
    expect(closingLineIsOutsideSystem(added)).toBe(true);
    expect(closingLineLabel(added)).toBe('Toyo NS60 R · 65 Ah');
    // A line of the cut is never outside the system: the sheet only seeded what the branch held.
    expect(rows.slice(0, -1).every(row => !closingLineIsOutsideSystem(row))).toBe(true);
  });

  it('refuses the same variant twice and a variant the sheet already lists', () => {
    const taken = closingSheetVariantIDs(closing());
    expect(() => closingAddLine([], catalogueVariant(1, { brand: 'Bosch', model: 'S4',
      capacity_ah: '45', polarity: 'L' }), taken)).toThrow(model.closingDuplicateLineMessage);
    const once = closingAddLine([], catalogueVariant(20), taken);
    expect(once.map(line => line.variant_id)).toEqual([20]);
    expect(() => closingAddLine(once, catalogueVariant(20), taken)).toThrow(model.closingDuplicateLineMessage);
  });

  it('sends only what the admin counted, the added row included and nothing else', () => {
    const rows = closingSheetRows(closing(), [catalogueVariant(20)]);
    // The screen seeds the draft from the sheet, so a row the admin did not touch is not a change.
    const seeded = Object.fromEntries(rows.map(row =>
      [row.variant_id, row.counted_quantity === null ? '' : String(row.counted_quantity)]));
    const changes = closingCountChanges(rows, { ...seeded, 1: '11', 20: '3' });
    // The added row travels exactly like a sheet row: its counted quantity and its variant.
    expect(changes).toEqual([{ variant_id: 1, counted: '11' }, { variant_id: 20, counted: '3' }]);
    expect(canonicalCountPayload(changes)).toEqual([
      { variant_id: 1, counted_quantity: 11 }, { variant_id: 20, counted_quantity: 3 }]);
    // What was not counted is not sent: no row invents a zero for the admin (S4).
    expect(closingCountChanges(rows, { ...seeded, 1: '11' })).toEqual([{ variant_id: 1, counted: '11' }]);
  });

  it('blocks the proposal while the added row is uncounted, naming it', () => {
    const sheetless = closing({ count_lines: [] });
    const stated = drawerView(closingRail(sheetless), { counted: '7.015,00', contribution: '0,00',
      fund: '900,00', observation: '' });
    const rows = closingSheetRows(sheetless, [catalogueVariant(20)]);
    const blocked = closingBlockers(sheetless, stated, false, rows);
    expect(blocked.map(blocker => blocker.code)).toEqual(['count_pending']);
    expect(blocked[0].message).toBe('Faltan 1 variante por contar: Toyo NS60 R · 65 Ah.');
    // Without the added row, and with the drawer stated, nothing blocks the offer.
    expect(closingBlockers(sheetless, stated, false, [])).toEqual([]);
  });

  it('keeps the added row of a reloaded draft, still outside the system', () => {
    const reloaded = closing({ count_lines: [...lines, line(20, 0, 3,
      { brand: 'Toyo', model: 'NS60', capacity_ah: '65', polarity: 'R' })] });
    const added = closingSheetRows(reloaded).find(row => row.variant_id === 20)!;
    expect(closingLineIsOutsideSystem(added)).toBe(true);
    expect(added.counted_quantity).toBe(3);
    expect(closingLineDifference(added)).toBe(3);
    // The reloaded sheet covers the added row like any other line of the count.
    expect(closingProgress(reloaded.count_lines).total).toBe(lines.length + 1);
  });
});
