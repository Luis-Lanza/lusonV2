import { describe, expect, it } from 'vitest';
import {
  metricsInvalidResponseMessage, metricsPath, metricsPeriodToken, parseMetricsAnswer,
} from './metricsAPI';

// The selector this contract publishes: every closed settlement newest first, then the live one,
// then the whole history. The pending balance of Compras is never a period here.
const closedPeriod = (id: number, from: string, to: string) =>
  ({ kind: 'settlement', closing_id: id, from, to, label: `Rendición #${id}` });
const livePeriod = (id: number, from: string, to: string) =>
  ({ kind: 'open', closing_id: id, from, to, label: 'En curso' });
const allPeriod = { kind: 'all', closing_id: null, from: null, to: null, label: 'Todo el historial' };
// The window since the last closed cut: no closing of its own, no end, computed at the read (S3, S4).
const currentPeriod = { kind: 'current', closing_id: null, from: '2026-11-01T12:00:00Z', to: null,
  label: 'Desde el último corte' };
const closed = closedPeriod(4, '2026-10-20T12:00:00Z', '2026-11-01T12:00:00Z');
const live = livePeriod(5, '2026-11-01T12:00:00Z', '2026-11-12T12:00:00Z');
const periods = [closed, live, allPeriod];

// The money of the period by kind and by method: `batteries` is the battery lines of the same window
// and the other products are the rest of the total, never a third figure of their own (S2, S3).
const sales = {
  total: '4286400.00', batteries: '2100000.00', cash: '1842300.00', card: '1486900.00',
  transfer: '612200.00', qr: '345000.00', commission: '192888.00', sales: 63, units: 78,
};
// The drawer closes: 120000 + 1842300 − 84500 = 1877800.
const cash = {
  opening: '120000.00', sales: '1842300.00', expenses: '84500.00', expected: '1877800.00',
  counted: '1877800.00', difference: '0.00',
};
// The envelope closes too: 480000 − 312000 = 168000, and the warehouse left 200000 in it as the
// opening of the next period.
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
// The ranking is by units and not by money: the last row and the fourth are the ones that would swap
// if the order were the money of each model.
const topModels = [
  { catalog_entry_id: 1, brand: 'Willard', model: 'UB 12-75', capacity_ah: '75', units: 22, money: '1221000.00' },
  { catalog_entry_id: 2, brand: 'Moura', model: '12-60', capacity_ah: '60', units: 17, money: '782000.00' },
  { catalog_entry_id: 3, brand: 'Bosch', model: 'S4 12-45', capacity_ah: '45', units: 11, money: '396000.00' },
  { catalog_entry_id: 4, brand: 'Willard', model: 'UB 12-100', capacity_ah: '100', units: 9, money: '1035000.00' },
  { catalog_entry_id: 5, brand: 'Rocket', model: '12-55', capacity_ah: '55', units: 4, money: '208000.00' },
];
// One row of the second catalogue kind: a product is its free name, and it publishes no capacity at all
// because it never had one. The shape of the row is its own discriminant: a battery has a brand, a product
// has a name, and neither carries a tag beside it (S6).
const productModel = { catalog_entry_id: 6, name: 'Agua acidulada', units: 3, money: '150000.00' };
const stock = { units: 214 };

// The drawer of today: what the last cut left, the cash the sales collected after it and the signed
// effect of the movements of that window. 500000 + 1842300 + (−42500) = 2299800, the drawer's own
// identity, and the expense is the net of the gasto rows: 2500.00 (S4, S12).
const today = {
  since: '2026-11-01T12:00:00Z', opening: '500000.00', sales: '1842300.00',
  expenses: '2500.00', effective: '-42500.00', expected: '2299800.00',
  // What the branch is earning so far: the rate over the base the commission is computed on, never
  // over the whole sale. This window sold 2100000.00 of batteries and no other product, so its base is
  // its total and 12.50% of it is 262500.00, rounded once, the settlement's own rule (S3, S18).
  rate: '12.50', sold: '2100000.00', commission_base: '2100000.00', commission: '262500.00',
  movements: [
    { kind: 'aporte', amount: '10000.00', effective: '10000.00', occurred_at: '2026-11-01T12:00:00Z' },
    { kind: 'gasto', amount: '2500.00', effective: '-2500.00', occurred_at: '2026-11-02T09:30:00Z' },
    { kind: 'recaudacion', amount: '50000.00', effective: '-50000.00',
      occurred_at: '2026-11-03T18:00:00Z' },
  ],
};
// The purchase envelope of today: what the last cut left in it, the signed effect of the movements of its
// window and the balance the book holds -- 480000 + (−150000) = 330000, the book's own sum -- with the
// volume of those same documents (S5, S15-S17).
const fundToday = {
  since: '2026-11-01T12:00:00Z', opening: '480000.00', purchases: '150000.00',
  effective: '-150000.00', balance: '330000.00', documents: 4, used_units: 11, scrap_milli: 42500,
};
const settlementBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  periods, period: closed, source: 'settlement', sales, cash, fund, materials,
  top_models: topModels, stock, today, fund_today: fundToday, ...overrides,
});
// The live period: nobody counted the drawer or the sheet yet, and the warehouse has not stated the
// replacement. Every one of those is a null, never a zero.
const liveBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  periods, period: live, source: 'live', sales,
  cash: { ...cash, counted: null, difference: null },
  // An envelope that spent more than it inherited is short: the expectation carries its sign.
  fund: { ...fund, purchases: '512000.00', expected: '-32000.00', counted: null, difference: null,
    replacement: null },
  materials: { used_units: 78, used_delivered_units: null, scrap_milli: 214500,
    scrap_delivered_milli: null, materials: scrapRows.map(row => ({ ...row, delivered_milli: null })) },
  top_models: topModels, stock, today, fund_today: fundToday, ...overrides,
});
// The window since the last cut: the money and the ranking of that stretch, and no acta to read a
// drawer, an envelope or a sheet from (S5).
const windowBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  periods: [currentPeriod, closed, allPeriod], period: currentPeriod, source: 'live', sales,
  cash: null, fund: null, materials: null,
  // One window, one total: what the period collected is what the line of today says was sold, and the
  // battery base of that same window is the `batteries` of the period it states beside it (S2, S4).
  today: { ...today, sold: sales.total },
  top_models: topModels, stock, fund_today: fundToday, ...overrides,
});
// The accumulated history: sales, catalogue and scrap, and no drawer at all (S9). The drawer of
// today is still stated: it is the drawer of the branch, not a total of the period (S12).
const historyBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  periods, period: allPeriod, source: 'history', sales, cash: null, fund: null, materials: null,
  top_models: topModels, stock, today, fund_today: fundToday, ...overrides,
});

describe('metrics wire contract', () => {
  it('parses a closed settlement to the exact numbers the acta states', () => {
    const answer = parseMetricsAnswer(settlementBody());
    expect(answer.periods).toHaveLength(3);
    expect(answer.period).toEqual(closed);
    expect(metricsPeriodToken(answer.period)).toBe('4');
    expect(answer.source).toBe('settlement');
    expect(answer.sales).toEqual({
      total_cents: 428640000n, batteries_cents: 210000000n, other_cents: 218640000n,
      cash_cents: 184230000n, card_cents: 148690000n, transfer_cents: 61220000n,
      qr_cents: 34500000n, commission_cents: 19288800n, sales: 63, units: 78,
    });
    expect(answer.cash).toEqual({
      opening_cents: 12000000n, sales_cents: 184230000n, expenses_cents: 8450000n,
      expected_cents: 187780000n, counted_cents: 187780000n, difference_cents: 0n,
    });
    expect(answer.fund).toEqual({
      opening_cents: 48000000n, purchases_cents: 31200000n, expected_cents: 16800000n,
      counted_cents: 16800000n, difference_cents: 0n, replacement_cents: 20000000n,
    });
    expect(answer.materials).toEqual({
      used_units: 78, used_delivered_units: 78, scrap_milli: 214500n,
      scrap_delivered_milli: 214500n,
      materials: [
        { material_id: 1, material: 'Cobre', bought_milli: 92300n, delivered_milli: 92300n },
        { material_id: 2, material: 'Aluminio', bought_milli: 61000n, delivered_milli: 61000n },
        { material_id: 3, material: 'Plomo', bought_milli: 45700n, delivered_milli: 45700n },
        { material_id: 4, material: 'Bronce', bought_milli: 15500n, delivered_milli: 15500n },
      ],
    });
    // Ordered by units: 22, 17, 11, 9, 4 — the money of each row is the secondary reading.
    expect(answer.top_models.map(row => row.units)).toEqual([22, 17, 11, 9, 4]);
    expect(answer.top_models[0]).toEqual({
      catalog_entry_id: 1, brand: 'Willard', model: 'UB 12-75', capacity_ah: '75', units: 22,
      money_cents: 122100000n,
    });
    expect(answer.stock).toEqual({ units: 214 });
  });

  it('keeps every absent account a null and never a zero', () => {
    const history = parseMetricsAnswer(historyBody());
    expect(history.source).toBe('history');
    expect(history.cash).toBeNull();
    expect(history.fund).toBeNull();
    expect(history.materials).toBeNull();
    // The sales and the shelf are still stated: the history is a period like any other.
    expect(history.sales.total_cents).toBe(428640000n);
    expect(history.stock).toEqual({ units: 214 });

    const open = parseMetricsAnswer(liveBody());
    expect(open.source).toBe('live');
    expect(open.cash).toEqual({
      opening_cents: 12000000n, sales_cents: 184230000n, expenses_cents: 8450000n,
      expected_cents: 187780000n, counted_cents: null, difference_cents: null,
    });
    expect(open.fund).toEqual({
      opening_cents: 48000000n, purchases_cents: 51200000n, expected_cents: -3200000n,
      counted_cents: null, difference_cents: null, replacement_cents: null,
    });
    expect(open.materials?.used_delivered_units).toBeNull();
    expect(open.materials?.scrap_delivered_milli).toBeNull();
    expect(open.materials?.materials.every(row => row.delivered_milli === null)).toBe(true);
  });

  it('reads the window since the last cut as a period without an acta', () => {
    const answer = parseMetricsAnswer(windowBody());
    expect(answer.period).toEqual(currentPeriod);
    expect(metricsPeriodToken(answer.period)).toBe('current');
    // It moves with every sale, and it states no drawer, no envelope and no sheet (S5).
    expect(answer.source).toBe('live');
    expect(answer.cash).toBeNull();
    expect(answer.fund).toBeNull();
    expect(answer.materials).toBeNull();
    expect(answer.sales.total_cents).toBe(428640000n);
    expect(answer.top_models).toHaveLength(5);
    // It is published once and first, before every settlement (S4).
    expect(answer.periods.map(period => period.kind)).toEqual(['current', 'settlement', 'all']);
  });

  it('refuses a window that is not the first period, or that names a closing or an end', () => {
    const notFirst = JSON.parse(windowBody()) as Record<string, unknown>;
    notFirst.periods = [closed, currentPeriod, allPeriod];
    expect(() => parseMetricsAnswer(JSON.stringify(notFirst))).toThrow(metricsInvalidResponseMessage);

    const withClosing = JSON.parse(windowBody()) as Record<string, unknown>;
    withClosing.periods = [{ ...currentPeriod, closing_id: 4 }, closed, allPeriod];
    withClosing.period = { ...currentPeriod, closing_id: 4 };
    expect(() => parseMetricsAnswer(JSON.stringify(withClosing))).toThrow(metricsInvalidResponseMessage);

    const withEnd = JSON.parse(windowBody()) as Record<string, unknown>;
    withEnd.periods = [{ ...currentPeriod, to: '2026-11-12T12:00:00Z' }, closed, allPeriod];
    withEnd.period = { ...currentPeriod, to: '2026-11-12T12:00:00Z' };
    expect(() => parseMetricsAnswer(JSON.stringify(withEnd))).toThrow(metricsInvalidResponseMessage);

    // A window is not an acta: a frozen origin beside it describes another period.
    expect(() => parseMetricsAnswer(windowBody({ source: 'settlement' })))
      .toThrow(metricsInvalidResponseMessage);

    // One window, one total: a period that collected something else than what today sold is not it.
    expect(() => parseMetricsAnswer(windowBody({ today: { ...today, sold: '100.00' } })))
      .toThrow(metricsInvalidResponseMessage);
  });

  it('derives the other products as the rest of the total, never as a figure of their own', () => {
    // The period sold 4286400.00 of which 2100000.00 are the battery lines: the other products are the
    // difference and the answer publishes no field for them (S3).
    const answer = parseMetricsAnswer(settlementBody());
    expect(answer.sales.batteries_cents).toBe(210000000n);
    expect(answer.sales.other_cents).toBe(218640000n);
    expect(answer.sales.batteries_cents + answer.sales.other_cents).toBe(answer.sales.total_cents);
    // A period that sold no battery has no other products either: the two parts still add up to it.
    const noBattery = parseMetricsAnswer(settlementBody({ sales: { ...sales, batteries: '0.00' } }));
    expect(noBattery.sales.batteries_cents).toBe(0n);
    expect(noBattery.sales.other_cents).toBe(428640000n);
    // A period that sold batteries and nothing else states no other products at all.
    const batteryOnly = parseMetricsAnswer(settlementBody({
      sales: { ...sales, batteries: sales.total },
    }));
    expect(batteryOnly.sales.other_cents).toBe(0n);
    expect(batteryOnly.sales.batteries_cents).toBe(428640000n);
  });

  it('admits a purchase net a counter-document left negative, with its sign', () => {
    // The net of a window can be negative: a counter-document reversed a purchase of an earlier
    // period, so the envelope ends up larger than what it inherited (L7).
    const answer = parseMetricsAnswer(settlementBody({
      fund: { ...fund, purchases: '-120000.00', expected: '600000.00', counted: '600000.00' },
    }));
    expect(answer.fund?.purchases_cents).toBe(-12000000n);
    // The envelope still closes: 480000 − (−120000) = 600000.
    expect(answer.fund?.opening_cents).toBe(48000000n);
    expect(answer.fund?.expected_cents).toBe(60000000n);
  });

  it('admits a settlement that counted more than the period bought, keeping the counts', () => {
    // The delivered quantity is the counted one: a count larger than the bought material is
    // informed and blocks nothing, exactly like a cash difference (L7).
    const answer = parseMetricsAnswer(settlementBody({
      materials: {
        used_units: 78, used_delivered_units: 80, scrap_milli: 214500,
        scrap_delivered_milli: 216000,
        materials: scrapRows.map(row => ({ ...row, delivered_milli: row.bought_milli + 375 })),
      },
    }));
    expect(answer.materials?.used_delivered_units).toBe(80);
    expect(answer.materials?.scrap_delivered_milli).toBe(216000n);
    // The bought side does not move: only the counted one exceeds it.
    expect(answer.materials?.used_units).toBe(78);
    expect(answer.materials?.scrap_milli).toBe(214500n);
    expect(answer.materials?.materials.map(row => row.delivered_milli)).toEqual([
      92675n, 61375n, 46075n, 15875n,
    ]);
  });

  it('parses the drawer of today with its window, its expectation and its movements', () => {
    const answer = parseMetricsAnswer(settlementBody());
    // The window starts at the cut of the last closed settlement, and the expectation is the drawer's
    // own identity over every term of it: 500000 + 1842300 + (−42500) = 2299800 (S4).
    expect(answer.today).toEqual({
      since: '2026-11-01T12:00:00Z', opening_cents: 50000000n, sales_cents: 184230000n,
      expenses_cents: 250000n, effective_cents: -4250000n, expected_cents: 229980000n,
      rate_percent: '12.50', sold_cents: 210000000n, commission_base_cents: 210000000n,
      commission_cents: 26250000n,
      movements: [
        { kind: 'aporte', amount_cents: 1000000n, effective_cents: 1000000n,
          occurred_at: '2026-11-01T12:00:00Z' },
        { kind: 'gasto', amount_cents: 250000n, effective_cents: -250000n,
          occurred_at: '2026-11-02T09:30:00Z' },
        { kind: 'recaudacion', amount_cents: 5000000n, effective_cents: -5000000n,
          occurred_at: '2026-11-03T18:00:00Z' },
      ],
    });
    // The movements are the terms of that sum: their signed effect is the aggregate the card states,
    // so the collection of 50000 lowers the expectation and the contribution of 10000 raises it (S4).
    expect(answer.today.movements.reduce((sum, movement) => sum + movement.effective_cents, 0n))
      .toBe(answer.today.effective_cents);
    expect(answer.today.expected_cents).toBe(answer.today.opening_cents
      + answer.today.sales_cents + answer.today.effective_cents);
  });

  it('reads a correction of today as money coming back to the drawer', () => {
    // The branch paid 2500.00 out of the drawer and corrected 1000.00 of it: the expense of the card
    // is the net of the two rows and the correction raises the expectation with its own sign (S4, S6).
    const answer = parseMetricsAnswer(settlementBody({
      today: { ...today, expenses: '1500.00', effective: '-41500.00', expected: '2300800.00',
        movements: [
          { kind: 'gasto', amount: '2500.00', effective: '-2500.00',
            occurred_at: '2026-11-02T09:30:00Z' },
          { kind: 'correccion', amount: '1000.00', effective: '1000.00',
            occurred_at: '2026-11-02T10:00:00Z' },
        ] },
    }));
    expect(answer.today.movements[1]).toEqual({ kind: 'correccion', amount_cents: 100000n,
      effective_cents: 100000n, occurred_at: '2026-11-02T10:00:00Z' });
    expect(answer.today.expenses_cents).toBe(150000n);
    expect(answer.today.effective_cents).toBe(-4150000n);
    expect(answer.today.expected_cents).toBe(230080000n);
  });

  it('parses a branch the warehouse never gave a rate as a null rate and no commission', () => {
    const answer = parseMetricsAnswer(settlementBody({
      today: { ...today, rate: null, commission: '0.00' },
    }));
    // The absence of a rate is a state of its own, never a zero percentage that reads as a rate (S20),
    // and the base it did not apply to is still stated because the window is a fact.
    expect(answer.today.rate_percent).toBeNull();
    expect(answer.today.commission_cents).toBe(0n);
    expect(answer.today.sold_cents).toBe(210000000n);
    expect(answer.today.commission_base_cents).toBe(210000000n);
  });

  it('computes the commission on the battery base and never on the whole sale', () => {
    // The window sold a battery and an other product: 2100000.00 of total, of which 1200000.00 are the
    // battery lines. The commission is the rate over those 1200000.00 -- 150000.00 -- because an other
    // product like the acidulated water earns nothing (S1, S2, S3).
    const answer = parseMetricsAnswer(settlementBody({
      today: { ...today, commission_base: '1200000.00', commission: '150000.00' },
    }));
    expect(answer.today.commission_base_cents).toBe(120000000n);
    expect(answer.today.commission_cents).toBe(15000000n);
    // The total keeps its own place: it still counts every line of the window (S4).
    expect(answer.today.sold_cents).toBe(210000000n);
    // The amount the old rule produced over the whole sale is not the commission of this base.
    expect(() => parseMetricsAnswer(settlementBody({
      today: { ...today, commission_base: '1200000.00', commission: '262500.00' },
    }))).toThrow(metricsInvalidResponseMessage);
  });

  it('reads a window that sold no battery as no commission over a stated total', () => {
    // The branch sold products and no battery: the total is a fact and the base is zero, so the card
    // earns nothing and says so instead of carrying a commission the branch never earned (S7).
    const answer = parseMetricsAnswer(settlementBody({
      today: { ...today, commission_base: '0.00', commission: '0.00' },
    }));
    expect(answer.today.commission_base_cents).toBe(0n);
    expect(answer.today.sold_cents).toBe(210000000n);
    expect(() => parseMetricsAnswer(settlementBody({
      today: { ...today, commission_base: '0.00', commission: '262500.00' },
    }))).toThrow(metricsInvalidResponseMessage);
  });

  it('parses a drawer of today without a cut as the whole life of the branch', () => {
    const answer = parseMetricsAnswer(historyBody({
      today: { ...today, since: null, opening: '0.00', sales: '0.00', expenses: '0.00',
        effective: '0.00', expected: '0.00', movements: [] },
    }));
    expect(answer.today.since).toBeNull();
    expect(answer.today.opening_cents).toBe(0n);
    expect(answer.today.effective_cents).toBe(0n);
    expect(answer.today.expected_cents).toBe(0n);
    expect(answer.today.movements).toEqual([]);
  });

  it('parses the purchase fund of today with its window, its balance and its breakdown', () => {
    const answer = parseMetricsAnswer(settlementBody());
    // The envelope of today is the branch's book: 480000 + (−150000) = 330000, with the purchases of the
    // same window beside it (S5, S16).
    expect(answer.fund_today).toEqual({
      since: '2026-11-01T12:00:00Z', opening_cents: 48000000n, purchases_cents: 15000000n,
      effective_cents: -15000000n, balance_cents: 33000000n, documents: 4, used_units: 11,
      scrap_milli: 42500n,
    });
  });

  it('reads a purchase fund of today whose documents netted fewer than none', () => {
    // A counter-document that reversed an earlier purchase leaves the volume of the window negative.
    // It is the net of those documents, so it is published with its sign instead of being refused.
    const answer = parseMetricsAnswer(settlementBody({
      fund_today: { ...fundToday, used_units: -1, scrap_milli: -1500 },
    }));
    expect(answer.fund_today.used_units).toBe(-1);
    expect(answer.fund_today.scrap_milli).toBe(-1500n);
  });

  it('parses a purchase fund of today without a cut as the whole life of the branch', () => {
    const answer = parseMetricsAnswer(historyBody({
      fund_today: { since: null, opening: '0.00', purchases: '120500.00',
        effective: '-120500.00', balance: '-120500.00', documents: 1, used_units: 2,
        scrap_milli: 0 },
    }));
    // A branch that never closed a settlement inherits nothing, and its window is the whole book (S5).
    expect(answer.fund_today.since).toBeNull();
    expect(answer.fund_today.opening_cents).toBe(0n);
    expect(answer.fund_today.purchases_cents).toBe(12050000n);
    expect(answer.fund_today.effective_cents).toBe(-12050000n);
    expect(answer.fund_today.balance_cents).toBe(-12050000n);
  });

  it('parses the fund a branch was founded with and never settled', () => {
    // The defect the card carried: 5.000,00 in the book and no settlement used to read as Bs 0,00. The
    // founding is an `aporte` of the window, so the book -- and the card -- states 5.000,00 (S5).
    const answer = parseMetricsAnswer(historyBody({
      fund_today: { since: null, opening: '0.00', purchases: '0.00', effective: '5000.00',
        balance: '5000.00', documents: 0, used_units: 0, scrap_milli: 0 },
    }));
    expect(answer.fund_today.balance_cents).toBe(500000n);
    expect(answer.fund_today.effective_cents).toBe(500000n);
  });

  it('keeps the purchase fund of today beside an envelope of the period that says another number', () => {
    // The two reads are separate statements of the same envelope: a purchase landing between them moves
    // the live one and leaves today where it was written, and that is not a contradiction to refuse (S16).
    const answer = parseMetricsAnswer(liveBody({
      fund_today: { ...fundToday, purchases: '151000.00', effective: '-151000.00',
        balance: '329000.00' },
    }));
    expect(answer.fund_today.balance_cents).toBe(32900000n);
    expect(answer.fund?.expected_cents).toBe(-3200000n);
  });

  it('keeps the drawer of today beside a drawer of the period that says another number', () => {
    // The two reads are separate statements: a sale landing between them moves the live drawer and
    // leaves today where it was written, and that is not a contradiction to refuse.
    const answer = parseMetricsAnswer(liveBody({
      today: { ...today, expected: '2299900.00', sales: '1842400.00' },
    }));
    expect(answer.today.expected_cents).toBe(229990000n);
    expect(answer.cash?.expected_cents).toBe(187780000n);
  });

  it('reads a product row as its name and no capacity', () => {
    const answer = parseMetricsAnswer(settlementBody({
      top_models: [topModels[0], productModel],
    }));
    // The product row is its own identity: its name, its units, its money and no capacity invented for it.
    expect(answer.top_models[1]).toEqual({
      catalog_entry_id: 6, name: 'Agua acidulada', units: 3, money_cents: 15000000n,
    });
    expect(answer.top_models[1]).not.toHaveProperty('capacity_ah');
    expect(answer.top_models[1]).not.toHaveProperty('brand');
    // The battery row keeps the six fields it always published, and no tag tells the two apart: the shape
    // of the row does.
    expect(answer.top_models[0]).toEqual({
      catalog_entry_id: 1, brand: 'Willard', model: 'UB 12-75', capacity_ah: '75', units: 22,
      money_cents: 122100000n,
    });
    expect(answer.top_models[0]).not.toHaveProperty('name');
  });

  it.each([
    ['an extra field the contract does not publish', settlementBody({ extra: 1 })],
    ['a period kind this contract never publishes', settlementBody({
      periods: [{ kind: 'pending', closing_id: null, from: null, to: null, label: 'Pendiente' }, ...periods],
    })],
    ['a chosen period that is not one of the published periods', settlementBody({
      period: closedPeriod(9, '2026-10-01T12:00:00Z', '2026-10-20T12:00:00Z'),
    })],
    ['a source that disagrees with the period', settlementBody({ source: 'live' })],
    ['non-canonical money', settlementBody({ sales: { ...sales, total: '4286400.0' } })],
    ['money with a thousands separator', settlementBody({ sales: { ...sales, cash: '1.842.300,00' } })],
    ['a drawer that does not close', settlementBody({ cash: { ...cash, expected: '1877850.00' } })],
    ['a counted amount without its difference', settlementBody({ cash: { ...cash, difference: null } })],
    ['a battery money that exceeds the total of the period', settlementBody({
      sales: { ...sales, batteries: '4286400.01' },
    })],
    ['a sales answer without its battery money', settlementBody({
      sales: { ...sales, batteries: undefined },
    })],
    ['non-canonical battery money', settlementBody({ sales: { ...sales, batteries: '2100000.0' } })],
    ['signed battery money', settlementBody({ sales: { ...sales, batteries: '-2100000.00' } })],
    ['battery money published as a number', settlementBody({
      sales: { ...sales, batteries: 2100000 },
    })],
    ['a negative count of sales', settlementBody({ sales: { ...sales, sales: -1 } })],
    ['a negative count of units', settlementBody({ sales: { ...sales, units: -1 } })],
    ['a negative delivered count', settlementBody({
      materials: { ...materials, used_delivered_units: -1 },
    })],
    ['a purchase net of negative zero', settlementBody({
      fund: { ...fund, purchases: '-0.00', expected: '480000.00', counted: null,
        difference: null },
    })],
    ['a material sheet whose rows do not add up to its total', settlementBody({
      materials: { ...materials, scrap_milli: 214501 },
    })],
    ['a delivered total that is not the sum of its rows', settlementBody({
      materials: { ...materials, scrap_delivered_milli: 214501 },
    })],
    ['a ranking ordered by money instead of units', settlementBody({
      top_models: [topModels[3], topModels[0], topModels[1], topModels[2], topModels[4]],
    })],
    ['a ranking row carrying both kinds', settlementBody({
      top_models: [{ ...topModels[0], name: 'Agua acidulada' }],
    })],
    ['a ranking row of neither kind', settlementBody({
      top_models: [{ catalog_entry_id: 6, units: 3, money: '150000.00' }],
    })],
    ['a battery row without its brand', settlementBody({
      top_models: [{ catalog_entry_id: 1, model: 'UB 12-75', capacity_ah: '75', units: 22,
        money: '1221000.00' }],
    })],
    ['a battery row with a capacity that is not a number', settlementBody({
      top_models: [{ ...topModels[0], capacity_ah: '75 Ah' }],
    })],
    ['a battery row without a capacity', settlementBody({
      top_models: [{ ...topModels[0], capacity_ah: '' }],
    })],
    ['a product row carrying a capacity', settlementBody({
      top_models: [{ ...productModel, capacity_ah: '75' }],
    })],
    ['a product row carrying a battery brand', settlementBody({
      top_models: [{ ...productModel, brand: 'Willard' }],
    })],
    ['a product row without a name', settlementBody({
      top_models: [{ ...productModel, name: '' }],
    })],
    ['a product row without units', settlementBody({
      top_models: [{ ...productModel, units: 0 }],
    })],
    ['an account the history cannot state', historyBody({ cash })],
    ['a drawer of today that does not close', settlementBody({
      today: { ...today, expected: '2257900.00' },
    })],
    ['a drawer of today whose expectation leaves its movements out', settlementBody({
      today: { ...today, expected: '2342300.00' },
    })],
    ['a drawer of today without its signed effect', settlementBody({
      today: { ...today, effective: undefined },
    })],
    ['a movement of a kind the ledger never writes', settlementBody({
      today: { ...today, movements: [{ kind: 'transferencia', amount: '10000.00',
        effective: '10000.00', occurred_at: '2026-11-01T12:00:00Z' }] },
    })],
    ['a non-canonical amount of a movement', settlementBody({
      today: { ...today, movements: [{ kind: 'gasto', amount: '2500.0', effective: '-2500.00',
        occurred_at: '2026-11-02T09:30:00Z' }] },
    })],
    ['a movement of a negative amount', settlementBody({
      today: { ...today, movements: [{ kind: 'gasto', amount: '-2500.00', effective: '-2500.00',
        occurred_at: '2026-11-02T09:30:00Z' }] },
    })],
    ['a movement whose effect is not signed money', settlementBody({
      today: { ...today, movements: [{ kind: 'gasto', amount: '2500.00', effective: '-2500.0',
        occurred_at: '2026-11-02T09:30:00Z' }] },
    })],
    ['a movement whose effect is not its own amount', settlementBody({
      today: { ...today, movements: [{ kind: 'gasto', amount: '2500.00', effective: '-2600.00',
        occurred_at: '2026-11-02T09:30:00Z' }] },
    })],
    ['a movement whose effect contradicts its kind', settlementBody({
      today: { ...today, movements: [{ kind: 'gasto', amount: '2500.00', effective: '2500.00',
        occurred_at: '2026-11-02T09:30:00Z' }] },
    })],
    ['a correction of today without a direction', settlementBody({
      today: { ...today, movements: [{ kind: 'correccion', amount: '2500.00', effective: '0.00',
        occurred_at: '2026-11-02T09:30:00Z' }] },
    })],
    ['a malformed instant of a movement', settlementBody({
      today: { ...today, movements: [{ kind: 'gasto', amount: '2500.00', effective: '-2500.00',
        occurred_at: '2026-11-02' }] },
    })],
    ['a malformed cut of today', settlementBody({ today: { ...today, since: '2026-11-01' } })],
    ['a drawer of today without its movements', settlementBody({
      today: { since: null, opening: '0.00', sales: '0.00', expenses: '0.00', effective: '0.00',
        expected: '0.00' },
    })],
    ['movements out of the order they happened', settlementBody({
      today: { ...today, movements: [today.movements[2], today.movements[0], today.movements[1]] },
    })],
    ['more movements than the server publishes', settlementBody({
      today: { ...today, movements: Array.from({ length: 51 }, (_, index) => ({
        kind: 'gasto', amount: '100.00', effective: '-100.00',
        occurred_at: new Date(Date.UTC(2026, 10, 1, 12, 0, index)).toISOString(),
      })) },
    })],
    ['an extra field in the drawer of today', settlementBody({ today: { ...today, extra: 1 } })],
    ['a commission that is not its rate times the battery base', settlementBody({
      today: { ...today, commission: '1.00' },
    })],
    ['a commission base that is signed money', settlementBody({
      today: { ...today, commission_base: '-2100000.00' },
    })],
    ['a non-canonical commission base', settlementBody({
      today: { ...today, commission_base: '2100000.0' },
    })],
    ['a drawer of today without its commission base', settlementBody({
      today: { ...today, commission_base: undefined },
    })],
    ['a commission with no rate behind it', settlementBody({
      today: { ...today, rate: null },
    })],
    ['a rate that is not a percentage', settlementBody({
      today: { ...today, rate: '101.00' },
    })],
    ['a rate with one decimal', settlementBody({ today: { ...today, rate: '12.5' } })],
    ['a sold total that is not money', settlementBody({ today: { ...today, sold: '-2100000.00' } })],
    ['a purchase fund of today whose terms do not produce its balance', settlementBody({
      fund_today: { ...fundToday, balance: '331000.00' },
    })],
    ['a purchase fund of today whose effect does not produce its balance', settlementBody({
      fund_today: { ...fundToday, effective: '0.00' },
    })],
    ['a purchase fund of today without the effect of its window', settlementBody({
      fund_today: { since: '2026-11-01T12:00:00Z', opening: '480000.00', purchases: '150000.00',
        balance: '330000.00', documents: 4, used_units: 11, scrap_milli: 42500 },
    })],
    ['a non-canonical amount of the purchase fund of today', settlementBody({
      fund_today: { ...fundToday, opening: '480000.0' },
    })],
    ['a signed opening of the purchase fund of today', settlementBody({
      fund_today: { ...fundToday, opening: '-480000.00', balance: '-630000.00' },
    })],
    ['a negative document count of the purchase fund of today', settlementBody({
      fund_today: { ...fundToday, documents: -1 },
    })],
    ['a malformed cut of the purchase fund of today', settlementBody({
      fund_today: { ...fundToday, since: '2026-11-01' },
    })],
    ['a purchase fund of today whose null cut leaves an opening behind', settlementBody({
      fund_today: { ...fundToday, since: null },
    })],
    ['an extra field in the purchase fund of today', settlementBody({
      fund_today: { ...fundToday, extra: 1 },
    })],
    ['a purchase fund of today the answer does not carry', settlementBody({ fund_today: undefined })],
  ])('refuses %s with the screen refusal', (_reason, body) => {
    expect(() => parseMetricsAnswer(body)).toThrow('Respuesta inválida del servidor.');
    expect(() => parseMetricsAnswer(body)).toThrow(metricsInvalidResponseMessage);
  });

  it('reads only the two period tokens the route admits', () => {
    expect(metricsPath('4')).toBe('/api/metrics?period=4');
    expect(metricsPath('all')).toBe('/api/metrics?period=all');
    for (const token of ['', '0', '04', ' 4', '4 ', 'pending', '-1', '4.0']) {
      expect(() => metricsPath(token)).toThrow('Consulta de métricas inválida.');
    }
  });
});
