import { describe, expect, it, vi } from 'vitest';
import { closingRail } from './closingModel';
import {
  ClosingAPIError, closingCashPath, closingCountPath, closingDecisionPath, closingDetailPath,
  closingHistoryPath, closingProposePath, closingRefusalMessage, createClosingAPI, parseClosing,
  parseClosingPage, parseClosingRefusal,
} from './closingsAPI';

const csrf = 'c'.repeat(43);
const json = (body: unknown, status = 200) => new Response(
  typeof body === 'string' ? body : JSON.stringify(body),
  { status, headers: { 'Content-Type': 'application/json' } });

const countedLine = (overrides: Record<string, unknown> = {}) => ({
  variant_id: 1, catalog_entry_id: 1, brand: 'Bosch', model: 'S4', capacity_ah: '45',
  polarity: 'L', expected_quantity: 12, counted_quantity: 12, ...overrides,
});

// The closed settlement of the chosen artboard: Bs 7.015,00 expected, Bs 6.980,00 counted,
// Bs 900,00 fund, 4,50 % of Bs 32.480,00 reported beside the drawer.
const document = (overrides: Record<string, unknown> = {}) => ({
  id: 1, branch_location_id: 2, branch_name: 'Sopocachi', status: 'closed',
  period_start: '2026-08-12T18:00:00Z', cut_at: '2026-09-12T18:30:00Z',
  closed_at: '2026-09-12T18:31:00Z', commission_rate_percent: '4.50',
  opening_cash: '800.00', cash_sales: '6430.00', cash_expenses: '215.00', expected_cash: '7015.00',
  counted_cash: '6980.00', cash_difference: '-35.00', contributed_cash: '0.00',
  closing_cash: '900.00', taken_cash: '6080.00', sales_total: '32480.00',
  commission_amount: '1461.60', card_total: '3240.00', transfer_total: '1180.00',
  qr_total: '2760.00', observation: 'contado en persona', opened_by_account_id: 1,
  count_lines: [countedLine(), countedLine({ variant_id: 2, polarity: 'R', expected_quantity: 9 })],
  rounds: [], expenses: [], corrections: [], ...overrides,
});

const openDocument = (overrides: Record<string, unknown> = {}) => document({
  status: 'open', closed_at: null, commission_rate_percent: null, cash_sales: '0.00',
  cash_expenses: '0.00', expected_cash: '800.00', counted_cash: null, cash_difference: null,
  closing_cash: null, taken_cash: null, sales_total: '0.00', commission_amount: '0.00',
  card_total: '0.00', transfer_total: '0.00', qr_total: '0.00', observation: '',
  count_lines: [countedLine({ counted_quantity: null })], ...overrides,
});

function harness(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  });
  return { fetcher, calls, api: createClosingAPI(fetcher) };
}

async function refusalOf(promise: Promise<unknown>): Promise<ClosingAPIError> {
  try { await promise; } catch (error) {
    if (error instanceof ClosingAPIError) return error;
    throw error;
  }
  throw new Error('the call was expected to fail');
}

describe('the settlement document', () => {
  it('reads every amount of the document into exact cents and keeps the commission apart (S8, S9)', () => {
    const closing = parseClosing(JSON.stringify(document()));
    expect(closing.status).toBe('closed');
    expect(closing.commission_rate_percent).toBe('4.50');
    expect(closing.opening_cash_cents).toBe(80000n);
    expect(closing.counted_cash_cents).toBe(698000n);
    expect(closing.qr_total_cents).toBe(276000n);
    const rail = closingRail(closing);
    expect(rail.expected_cents).toBe(701500n);
    expect(rail.difference_cents).toBe(-3500n);
    expect(rail.taken_cents).toBe(608000n);
    // The commission is a reported amount and the QR was never in the drawer (S9, S13).
    expect(rail.commission_cents).toBe(146160n);
    expect(rail.expected_cents).toBe(80000n + 643000n - 21500n);
  });

  it('reads an open settlement whose drawer and totals are not stated yet', () => {
    const closing = parseClosing(JSON.stringify(openDocument()));
    expect(closing.commission_rate_percent).toBeNull();
    expect(closing.counted_cash_cents).toBeNull();
    const rail = closingRail(closing);
    expect(rail.expected_cents).toBe(80000n);
    expect(rail.difference_cents).toBeNull();
    expect(rail.taken_cents).toBeNull();
  });

  it('rejects a document whose expected drawer counts the commission', () => {
    // Bs 7.015,00 + Bs 1.461,60: the commission is inside no cash identity.
    expect(() => parseClosing(JSON.stringify(document({ expected_cash: '8476.60' })))).toThrow();
  });

  it('rejects a difference that disagrees with the counted cash and the expected drawer', () => {
    expect(() => parseClosing(JSON.stringify(document({ cash_difference: '-30.00' })))).toThrow();
    expect(() => parseClosing(JSON.stringify(document({ cash_difference: '+35.00' })))).toThrow();
  });

  it('rejects a difference or a taken cash that is stated before the drawer is', () => {
    expect(() => parseClosing(JSON.stringify(openDocument({ cash_difference: '-35.00' })))).toThrow();
    expect(() => parseClosing(JSON.stringify(document({ counted_cash: null })))).toThrow();
  });

  it('rejects a commission that is not the frozen rate over the total, rounded once half up (S6, S20)', () => {
    // Bs 0,10 at 5,00 % is exactly half a cent: the single rounding goes up to Bs 0,01.
    const half = document({ sales_total: '0.10', commission_amount: '0.01',
      commission_rate_percent: '5.00' });
    expect(closingRail(parseClosing(JSON.stringify(half))).commission_cents).toBe(1n);
    expect(() => parseClosing(JSON.stringify({ ...half, commission_amount: '0.00' }))).toThrow();
  });

  it('rejects a shape this contract never publishes', () => {
    expect(() => parseClosing(JSON.stringify({ ...document(), total: '6080.00' }))).toThrow();
    const missing: Record<string, unknown> = document();
    delete missing.observation;
    expect(() => parseClosing(JSON.stringify(missing))).toThrow();
    expect(() => parseClosing(JSON.stringify(document({ status: 'settled' })))).toThrow();
    expect(() => parseClosing(JSON.stringify(document({ counted_cash: '6980,00' })))).toThrow();
    expect(() => parseClosing(JSON.stringify(document({
      count_lines: [countedLine({ variant_id: 2 }), countedLine()] })))).toThrow();
  });

  it('reads one newest-first page of the branch history', () => {
    const page = parseClosingPage(JSON.stringify({ page: 1, page_size: 25, total_closings: 2,
      closings: [document({ id: 2, cut_at: '2026-10-12T18:30:00Z', period_start: '2026-09-12T18:30:00Z' }),
        document({ id: 1 })] }));
    expect(page.total_closings).toBe(2);
    expect(page.closings.map(closing => closing.id)).toEqual([2, 1]);
    expect(() => parseClosingPage(JSON.stringify({ page: 1, page_size: 25, total_closings: 2,
      closings: [document({ id: 1 }), document({ id: 2, cut_at: '2026-10-12T18:30:00Z',
        period_start: '2026-09-12T18:30:00Z' })] }))).toThrow();
  });

  it('builds only the paths of this contract', () => {
    expect(closingHistoryPath(2, 1, 25)).toBe('/api/closings?branch_location_id=2&page=1&page_size=25');
    expect(closingDetailPath(7)).toBe('/api/closings/7');
    expect(closingCountPath(7)).toBe('/api/closings/7/count');
    expect(closingCashPath(7)).toBe('/api/closings/7/cash');
    expect(closingProposePath(7)).toBe('/api/closings/7/propose');
    expect(closingDecisionPath(7)).toBe('/api/closings/7/decision');
    expect(() => closingHistoryPath(1, 1, 25)).toThrow();
    expect(() => closingHistoryPath(2, 1, 20)).toThrow();
    expect(() => closingDetailPath(0)).toThrow();
  });
});

describe('a refusal of this contract', () => {
  it('names the variant still to count', () => {
    const refusal = parseClosingRefusal('{"error":"count_pending","variant_id":7}', 409);
    expect(refusal.code).toBe('count_pending');
    expect(refusal.variant_id).toBe(7);
    expect(closingRefusalMessage(refusal)).toBe('Falta contar la variante 7 del conteo: sin el conteo completo no se puede proponer.');
  });

  it('names the excess of a fund over the drawer', () => {
    const refusal = parseClosingRefusal('{"error":"fund_exceeds_drawer","excess":"50.00"}', 409);
    expect(refusal.excess_cents).toBe(5000n);
    expect(closingRefusalMessage(refusal)).toBe('El fondo supera la caja contada más el aporte en Bs 50,00: corregí el fondo.');
  });

  it('names the settlement that already holds the branch', () => {
    const refusal = parseClosingRefusal('{"error":"settlement_live","branch_location_id":2,"closing_id":7}', 409);
    expect(refusal.closing_id).toBe(7);
    expect(refusal.branch_location_id).toBe(2);
    expect(closingRefusalMessage(refusal)).toContain('la rendición #7 abierta');
    // The conflict the store could not read names the branch alone and invents no document.
    expect(parseClosingRefusal('{"error":"settlement_live","branch_location_id":2}', 409).closing_id).toBeNull();
  });

  it('admits only the code of its own status and never a companion key it cannot read', () => {
    expect(() => parseClosingRefusal('{"error":"count_pending"}', 409)).toThrow();
    expect(() => parseClosingRefusal('{"error":"fund_exceeds_drawer","excess":"50"}', 409)).toThrow();
    expect(() => parseClosingRefusal('{"error":"forbidden"}', 409)).toThrow();
    expect(() => parseClosingRefusal('{"error":"reserved_stock","variant_id":7}', 409)).toThrow();
    expect(parseClosingRefusal('{"error":"commission_rate_missing"}', 409).code).toBe('commission_rate_missing');
    expect(parseClosingRefusal('{"error":"service_unavailable"}', 503).code).toBe('service_unavailable');
  });
});

describe('the transport of the warehouse side', () => {
  it('opens the settlement of one branch with the only field the contract takes', async () => {
    const h = harness(() => json(openDocument(), 201));
    const closing = await h.api.open(2, csrf);
    expect(closing.id).toBe(1);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].url).toBe('/api/closings');
    expect(h.calls[0].init).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store' });
    expect(h.calls[0].init.body).toBe('{"branch_location_id":2}');
    expect(new Headers(h.calls[0].init.headers).get('X-CSRF-Token')).toBe(csrf);
    expect(new Headers(h.calls[0].init.headers).get('Content-Type')).toBe('application/json');
  });

  it('refuses to open a branch the server already holds, naming the live settlement', async () => {
    const h = harness(() => json({ error: 'settlement_live', branch_location_id: 2, closing_id: 7 }, 409));
    const failure = await refusalOf(h.api.open(2, csrf));
    expect(failure.code).toBe('settlement_live');
    expect(failure.refusal?.closing_id).toBe(7);
    expect(closingRefusalMessage({ code: failure.code, closing_id: 7 })).toContain('#7');
  });

  it('reads one branch history with the page it asked for', async () => {
    const h = harness(() => json({ page: 1, page_size: 25, total_closings: 0, closings: [] }));
    const page = await h.api.history(3, 1, 25);
    expect(page.total_closings).toBe(0);
    expect(h.calls[0].url).toBe('/api/closings?branch_location_id=3&page=1&page_size=25');
    expect(h.calls[0].init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store' });
    expect(new Headers(h.calls[0].init.headers).has('X-CSRF-Token')).toBe(false);
    const wrong = harness(() => json({ page: 2, page_size: 25, total_closings: 0, closings: [] }));
    expect((await refusalOf(wrong.api.history(3, 1, 25))).code).toBe('invalid_response');
  });

  it('saves only what was counted, one line per variant', async () => {
    const h = harness(() => json(openDocument()));
    await h.api.count(1, [{ variant_id: 2, counted_quantity: 8 }], csrf);
    expect(h.calls[0].url).toBe('/api/closings/1/count');
    expect(h.calls[0].init.body).toBe('{"lines":[{"variant_id":2,"counted_quantity":8}]}');
    expect(new Headers(h.calls[0].init.headers).get('X-CSRF-Token')).toBe(csrf);
  });

  it('surfaces the variant a frozen sheet refuses to change', async () => {
    const h = harness(() => json({ error: 'count_pending', variant_id: 9 }, 409));
    const failure = await refusalOf(h.api.count(1, [{ variant_id: 2, counted_quantity: 8 }], csrf));
    expect(failure.code).toBe('count_pending');
    expect(failure.refusal?.variant_id).toBe(9);
  });

  it('saves the drawer draft with its four keys, absent amounts as explicit nulls', async () => {
    const h = harness(() => json(openDocument()));
    await h.api.cash(1, { counted_cash: '6980.00', contributed_cash: '0.00',
      closing_cash: '900.00', observation: '' }, csrf);
    expect(h.calls[0].url).toBe('/api/closings/1/cash');
    expect(h.calls[0].init.body).toBe('{"counted_cash":"6980.00","contributed_cash":"0.00","closing_cash":"900.00","observation":""}');
    const empty = harness(() => json(openDocument()));
    await empty.api.cash(1, { counted_cash: null, contributed_cash: '0.00', closing_cash: null,
      observation: '' }, csrf);
    expect(empty.calls[0].init.body).toBe('{"counted_cash":null,"contributed_cash":"0.00","closing_cash":null,"observation":""}');
    // A draft missing a key is never sent.
    const missing = harness(() => json(openDocument()));
    expect((await refusalOf(missing.api.cash(1, { counted_cash: '6980.00', contributed_cash: '0.00',
      closing_cash: null } as never, csrf))).code).toBe('invalid_request');
    expect(missing.calls).toHaveLength(0);
  });

  it('offers the settlement with no body at all', async () => {
    const h = harness(() => json(document({ status: 'proposed', closed_at: null })));
    const closing = await h.api.propose(1, csrf);
    expect(closing.status).toBe('proposed');
    expect(closing.closed_at).toBeNull();
    expect(h.calls[0].url).toBe('/api/closings/1/propose');
    expect(h.calls[0].init.body).toBeUndefined();
    expect(new Headers(h.calls[0].init.headers).has('Content-Type')).toBe(false);
    expect(new Headers(h.calls[0].init.headers).get('X-CSRF-Token')).toBe(csrf);
  });

  it('accepts with the decision alone and rejects with its motive (S14)', async () => {
    const accepted = harness(() => json(document()));
    const closed = await accepted.api.decision(1, { decision: 'accepted' }, csrf);
    expect(closed.status).toBe('closed');
    expect(accepted.calls[0].url).toBe('/api/closings/1/decision');
    expect(accepted.calls[0].init).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store' });
    expect(accepted.calls[0].init.body).toBe('{"decision":"accepted"}');
    expect(new Headers(accepted.calls[0].init.headers).get('X-CSRF-Token')).toBe(csrf);
    expect(new Headers(accepted.calls[0].init.headers).get('Content-Type')).toBe('application/json');

    const rejected = harness(() => json(document({ status: 'rejected', closed_at: null })));
    const returned = await rejected.api.decision(1, { decision: 'rejected', reason: 'faltó contar la bodega' }, csrf);
    expect(returned.status).toBe('rejected');
    expect(rejected.calls[0].init.body).toBe('{"decision":"rejected","reason":"faltó contar la bodega"}');
  });

  it('never sends a decision the contract does not take (S14)', async () => {
    const h = harness(() => json(document()));
    expect((await refusalOf(h.api.decision(1, { decision: 'accepted', reason: 'sobra' } as never, csrf))).code)
      .toBe('invalid_request');
    expect((await refusalOf(h.api.decision(1, { decision: 'rejected' } as never, csrf))).code)
      .toBe('invalid_request');
    expect((await refusalOf(h.api.decision(1, { decision: 'rejected', reason: '   ' }, csrf))).code)
      .toBe('invalid_request');
    expect((await refusalOf(h.api.decision(1, { decision: 'rejected', reason: 'x'.repeat(1001) }, csrf))).code)
      .toBe('invalid_request');
    expect((await refusalOf(h.api.decision(1, { decision: 'maybe' } as never, csrf))).code)
      .toBe('invalid_request');
    expect((await refusalOf(h.api.decision(1, { decision: 'accepted' }, 'not a token'))).code)
      .toBe('invalid_request');
    expect(h.calls).toHaveLength(0);
  });

  it('names the state a decision cannot be taken in, and another branch as not found', async () => {
    const conflict = harness(() => json({ error: 'state_conflict' }, 409));
    expect((await refusalOf(conflict.api.decision(1, { decision: 'accepted' }, csrf))).code)
      .toBe('state_conflict');
    const reserved = harness(() => json({ error: 'reserved_stock' }, 409));
    expect((await refusalOf(reserved.api.decision(1, { decision: 'accepted' }, csrf))).code)
      .toBe('reserved_stock');
    const foreign = harness(() => json({ error: 'not_found' }, 404));
    const failure = await refusalOf(foreign.api.decision(7, { decision: 'accepted' }, csrf));
    expect(failure.code).toBe('not_found');
    expect(closingRefusalMessage(failure)).toBe('La rendición no existe para esta cuenta.');
    const warehouse = harness(() => json({ error: 'forbidden' }, 403));
    expect((await refusalOf(warehouse.api.decision(1, { decision: 'rejected', reason: 'no' }, csrf))).code)
      .toBe('forbidden');
  });

  it('publishes the server refusal of a proposal and never a client guess', async () => {
    const h = harness(() => json({ error: 'commission_rate_missing' }, 409));
    const failure = await refusalOf(h.api.propose(1, csrf));
    expect(failure.code).toBe('commission_rate_missing');
    expect(closingRefusalMessage(failure)).toContain('porcentaje de comisión');
  });

  it('fails closed on a transport that is not this contract', async () => {
    const plain = harness(() => new Response('{"error":"forbidden"}', { status: 403 }));
    expect((await refusalOf(plain.api.detail(1))).code).toBe('invalid_response');
    const unadmitted = harness(() => json({ error: 'teapot' }, 418));
    expect((await refusalOf(unadmitted.api.detail(1))).code).toBe('invalid_response');
    const offline = harness(() => { throw new Error('offline'); });
    expect((await refusalOf(offline.api.detail(1))).code).toBe('network');
    const unexpected = harness(() => json(document({ id: 2 })));
    expect((await refusalOf(unexpected.api.detail(1))).code).toBe('invalid_response');
    const noToken = harness(() => json(openDocument(), 201));
    expect((await refusalOf(noToken.api.open(2, 'not a token'))).code).toBe('invalid_request');
    expect(noToken.calls).toHaveLength(0);
  });
});
