import { describe, expect, it } from 'vitest';
import * as model from './closingModel';
import {
  canonicalCountPayload, canonicalDrawerPayload, closingBlockers, closingBlockReason,
  closingCents, closingDifferenceName, closingLineDifference, closingLineLabel, closingPendingLines,
  closingPeriod, closingPeriodLabel, closingProgress, closingQuantityText, closingRail,
  closingMoneyText, closingSignedCents, closingSignedText, drawerDraftFrom, drawerView, emptyDrawerDraft,
  filterCountLines,
  type Closing, type ClosingCountLine, type DrawerDraft,
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
    const view = drawerView(rail, { counted: '6.980,00', fund: '900,00', observation: '' });
    expect(view.problem).toBe('');
    expect(view.counted_cents).toBe(698000n);
    expect(view.fund_cents).toBe(90000n);
    expect(view.difference_cents).toBe(-3500n);
    expect(view.taken_cents).toBe(608000n);
    expect(view.excess_cents).toBeNull();
  });

  it('names the amount the fund exceeds the drawer by, contribution included', () => {
    const rail = closingRail(closing());
    const above = drawerView(rail, { counted: '6.980,00', fund: '7.100,00', observation: '' });
    expect(above.excess_cents).toBe(12000n);
    // A fund that cannot be left leaves nothing to take: it is a draft, not an offer.
    expect(above.taken_cents).toBeNull();
    const contributed = closingRail(closing({ contributed_cash_cents: 50000n }));
    expect(drawerView(contributed, { counted: '6.980,00', fund: '7.100,00', observation: '' }).excess_cents)
      .toBeNull();
    expect(drawerView(contributed, { counted: '6.980,00', fund: '7.100,00', observation: '' }).taken_cents)
      .toBe(38000n);
  });

  it('keeps a draft the admin has not stated yet explicitly absent, never zero', () => {
    const rail = closingRail(closing());
    const view = drawerView(rail, emptyDrawerDraft);
    expect(view.counted_cents).toBeNull();
    expect(view.fund_cents).toBeNull();
    expect(view.difference_cents).toBeNull();
    expect(view.taken_cents).toBeNull();
    expect(view.excess_cents).toBeNull();
  });

  it('reports an amount it cannot read instead of guessing one', () => {
    const view = drawerView(closingRail(closing()), { counted: '6.980,001', fund: '', observation: '' });
    expect(view.problem).toBe(model.closingAmountMessage);
    expect(view.counted_cents).toBeNull();
  });

  it('saves the drawer with the four keys of the contract and the settled contribution', () => {
    expect(canonicalDrawerPayload({ counted: '6.980,00', fund: '900,00', observation: 'contado en persona' }, 0n))
      .toEqual({ counted_cash: '6980.00', contributed_cash: '0.00', closing_cash: '900.00',
        observation: 'contado en persona' });
    expect(canonicalDrawerPayload(emptyDrawerDraft, 100000n))
      .toEqual({ counted_cash: null, contributed_cash: '1000.00', closing_cash: null, observation: '' });
    expect(() => canonicalDrawerPayload({ ...emptyDrawerDraft, observation: 'x'.repeat(1001) }, 0n)).toThrow();
  });

  it('restores the draft the settlement already holds', () => {
    const draft = drawerDraftFrom(closing({ counted_cash_cents: 698000n, closing_cash_cents: 90000n,
      observation: 'contado en persona' }));
    expect(draft).toEqual<DrawerDraft>({ counted: '6.980,00', fund: '900,00', observation: 'contado en persona' });
    expect(drawerDraftFrom(closing())).toEqual(emptyDrawerDraft);
  });
});

describe('S14 what still blocks the offer, named', () => {
  const complete = (overrides: Partial<Closing> = {}) => closing({
    counted_cash_cents: 698000n, closing_cash_cents: 90000n,
    count_lines: lines.map(entry => Object.freeze({ ...entry,
      counted_quantity: entry.counted_quantity ?? entry.expected_quantity })),
    ...overrides,
  });

  const view = (subject: Closing, draft: DrawerDraft = { counted: '6.980,00', fund: '900,00', observation: '' }) =>
    drawerView(closingRail(subject), draft);

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

  it('names only the side of the drawer that is missing', () => {
    const subject = complete();
    expect(closingBlockers(subject, view(subject, { counted: '', fund: '900,00', observation: '' }))[0].message)
      .toBe('Falta la caja contada: el cierre no puede proponerse sin eso.');
    expect(closingBlockers(subject, view(subject, { counted: '6.980,00', fund: '', observation: '' }))[0].message)
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
    const excess = closingBlockers(subject, view(subject, { counted: '6.980,00', fund: '7.100,00', observation: '' }));
    expect(excess.map(blocker => blocker.code)).toEqual(['fund_exceeds_drawer']);
    expect(excess[0].message).toBe('El fondo supera la caja contada más el aporte en Bs 120,00.');
    const invalid = closingBlockers(subject, view(subject, { counted: '6.980,001', fund: '900,00', observation: '' }));
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
