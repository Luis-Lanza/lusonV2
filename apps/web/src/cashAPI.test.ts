import { describe, expect, it, vi } from 'vitest';
import {
  CashAPIError, canonicalCashCorrection, canonicalCashInput, cashErrorMessages, cashFailureIsDefinite,
  cashKindMovesIn, cashLedgerPath, createCashAPI, matchesCashCorrection, matchesCashInput,
  parseCashCorrection, parseCashError, parseCashLedger, parseCashMovement,
  type CashCorrectionInput, type CashMovementInput,
} from './cashAPI';

const csrf = 'c'.repeat(43);
const json = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
const mockFetch = () => vi.fn<typeof fetch>();

// One row of the book as the ledger publishes it: the positive amount the branch wrote, the kind that
// states its direction, and the signed effect the drawer actually moved by.
const entry = (patch: Record<string, unknown> = {}) => ({
  id: 21, kind: 'gasto', effect_kind: 'gasto', amount: '85.00', effective: '-85.00',
  description: 'Detergente y escobas', occurred_at: '2026-11-13T09:12:00Z',
  created_by_account_id: 2, corrects_id: null, ...patch,
});

/** The six movements of the screen: gasto, gasto, aporte, recaudación, gasto corregido y su corrección. */
const movements = () => [
  entry(),
  entry({ id: 22, amount: '120.00', effective: '-120.00', description: 'Flete',
    occurred_at: '2026-11-13T15:40:00Z' }),
  entry({ id: 23, kind: 'aporte', effect_kind: 'aporte', amount: '500.00', effective: '500.00',
    description: 'Aporte del dueño', occurred_at: '2026-11-14T08:05:00Z' }),
  entry({ id: 24, kind: 'recaudacion', effect_kind: 'recaudacion', amount: '1200.00',
    effective: '-1200.00', description: 'Retiro del Almacén',
    occurred_at: '2026-11-14T17:22:00Z' }),
  entry({ id: 25, amount: '5000.00', effective: '-5000.00', description: 'Adelanto',
    occurred_at: '2026-11-15T11:00:00Z' }),
  // 21 + 22 + 23 + 24 + 25 + 26 = −85 − 120 + 500 − 1200 − 5000 + 4500 = −1405.00
  entry({ id: 26, kind: 'correccion', effect_kind: 'gasto', amount: '4500.00', effective: '4500.00',
    description: 'Devuelve el excedente', occurred_at: '2026-11-15T11:14:00Z', corrects_id: 25 }),
];

const ledgerBody = (patch: Record<string, unknown> = {}) => JSON.stringify({
  since: '2026-11-12T18:30:00Z', until: null, opening: '1850.00', sales: '6420.00',
  effective: '-1405.00', expected: '6865.00', truncated: false, movements: movements(), ...patch,
});

const movementBody = (patch: Record<string, unknown> = {}) => JSON.stringify({
  id: 21, branch_location_id: 2, kind: 'aporte', amount: '100.00',
  description: 'Cambio para el cajón', occurred_at: '2026-11-13T09:12:00Z',
  created_by_account_id: 2, ...patch,
});
const correctionBody = (patch: Record<string, unknown> = {}) => JSON.stringify({
  id: 22, branch_location_id: 2, kind: 'correccion', amount: '20.00',
  description: 'Aporte mal cargado', occurred_at: '2026-11-13T09:22:00Z',
  created_by_account_id: 2, corrects_id: 21, ...patch,
});

const movementInput: CashMovementInput = Object.freeze({
  kind: 'aporte', amount: '100.00', description: 'Cambio para el cajón',
});
const correctionInput: CashCorrectionInput = Object.freeze({
  corrects_id: 21, amount: '20.00', description: 'Aporte mal cargado',
});

describe('the operational drawer is read as it was written', () => {
  it('reads the ledger of a window with every money figure in exact cents', () => {
    const book = parseCashLedger(ledgerBody());
    expect(book.since).toBe('2026-11-12T18:30:00Z');
    expect(book.until).toBeNull();
    expect(book.opening_cents).toBe(185_000n);
    expect(book.sales_cents).toBe(642_000n);
    expect(book.effective_cents).toBe(-140_500n);
    expect(book.expected_cents).toBe(686_500n);
    expect(book.truncated).toBe(false);
    expect(book.movements).toHaveLength(6);
    expect(book.movements[0]).toEqual({
      id: 21, kind: 'gasto', effect_kind: 'gasto', amount_cents: 8_500n, effective_cents: -8_500n,
      description: 'Detergente y escobas', occurred_at: '2026-11-13T09:12:00Z',
      created_by_account_id: 2, corrects_id: null,
    });
    // The correction carries the direction it answers, inverted: money that a gasto took out comes back.
    expect(book.movements[5]).toMatchObject({
      id: 26, kind: 'correccion', effect_kind: 'gasto', amount_cents: 450_000n,
      effective_cents: 450_000n, corrects_id: 25,
    });
    expect(Object.isFrozen(book)).toBe(true);
    expect(Object.isFrozen(book.movements)).toBe(true);
    expect(Object.isFrozen(book.movements[0])).toBe(true);
  });

  it('reads a movement and a correction as the two answers of the two write routes', () => {
    expect(parseCashMovement(movementBody())).toMatchObject({
      id: 21, branch_location_id: 2, kind: 'aporte', amount_cents: 10_000n,
      description: 'Cambio para el cajón', corrects_id: null,
    });
    expect(parseCashCorrection(correctionBody())).toMatchObject({
      id: 22, kind: 'correccion', amount_cents: 2_000n, corrects_id: 21,
    });
  });

  it('refuses an answer that carries a key the contract does not state', () => {
    expect(() => parseCashLedger(ledgerBody({ expected_total: '6865.00' }))).toThrow();
    expect(() => parseCashLedger(ledgerBody({ movements: [entry({ signed: '-85.00' })] }))).toThrow();
    expect(() => parseCashMovement(movementBody({ branch: 2 }))).toThrow();
    expect(() => parseCashCorrection(correctionBody({ effect_kind: 'gasto' }))).toThrow();
  });

  it.each(['1405', '1405.0', '1405.000', '+1405.00', '-0.00', ' 1405.00', '1e3', '1405.00 '])(
    'refuses an effective that is not a signed canonical decimal: %s', effective => {
      const rows = movements();
      // The ledger effective is the only signed money of the contract: a figure that does not read as
      // canonical cents is not one this server wrote.
      expect(() => parseCashLedger(ledgerBody({
        movements: rows.map((row, index) => index === 0 ? { ...row, effective } : row),
      }))).toThrow();
    });

  it('refuses a movement whose kind and its reference do not state the same fact', () => {
    // A correction without a target would be money out of nowhere; a target on any other kind would
    // describe a cancelation the rest of the domain does not read.
    const rows = movements();
    expect(() => parseCashLedger(ledgerBody({
      movements: rows.map(row => row.id === 26 ? { ...row, corrects_id: null } : row),
    }))).toThrow();
    expect(() => parseCashLedger(ledgerBody({
      movements: rows.map(row => row.id === 21 ? { ...row, corrects_id: 25 } : row),
    }))).toThrow();
    // A correction answers a movement that already existed: the book never names a later row.
    expect(() => parseCashLedger(ledgerBody({
      movements: rows.map(row => row.id === 26 ? { ...row, corrects_id: 26 } : row),
    }))).toThrow();
  });

  it('refuses an out-of-order id: the book is read in the order it happened', () => {
    const rows = movements();
    const swapped = [...rows];
    swapped[0] = rows[1];
    swapped[1] = rows[0];
    expect(() => parseCashLedger(ledgerBody({ movements: swapped }))).toThrow();
  });

  it('refuses a row whose direction disagrees with the kind it names', () => {
    const rows = movements();
    // An aporte enters the drawer; a gasto and a recaudación leave it; a correction inverts that.
    expect(() => parseCashLedger(ledgerBody({
      movements: rows.map(row => row.id === 23 ? { ...row, effective: '-500.00' } : row),
    }))).toThrow();
    expect(() => parseCashLedger(ledgerBody({
      movements: rows.map(row => row.id === 26 ? { ...row, effective: '-4500.00' } : row),
    }))).toThrow();
  });

  it('refuses a book whose expectation does not close', () => {
    // expected = opening + sales + effective, the drawer's one identity.
    expect(() => parseCashLedger(ledgerBody({ expected: '6864.99' }))).toThrow();
    expect(() => parseCashLedger(ledgerBody({ effective: '-1405.01' }))).toThrow();
  });

  it('reads a truncated window as the newest 500 rows whose numbers cover the whole period', () => {
    const rows = Array.from({ length: 500 }, (_, index) => entry({
      id: index + 1, amount: '1.00', effective: '-1.00',
      occurred_at: `2026-11-13T${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}:00Z`,
    }));
    const book = parseCashLedger(ledgerBody({
      effective: '-500.00', sales: '0.00', opening: '0.00', expected: '-500.00',
      truncated: true, movements: rows,
    }));
    expect(book.truncated).toBe(true);
    expect(book.movements).toHaveLength(500);
    // The window holds more rows than the list: a shorter list with a matching total is not this book.
    expect(() => parseCashLedger(ledgerBody({
      effective: '-499.00', sales: '0.00', opening: '0.00', expected: '-499.00',
      truncated: true, movements: rows.slice(1),
    }))).toThrow();
  });
});

describe('the requests the screen sends', () => {
  it('records a movement with the canonical body and admits the answer as evidence', async () => {
    const fetch = mockFetch().mockResolvedValue(json(movementBody(), 201));
    const api = createCashAPI(fetch);
    const movement = await api.record(movementInput, csrf);
    expect(movement.id).toBe(21);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [path, init] = fetch.mock.calls[0];
    expect(path).toBe('/api/closings/cash-movements');
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store' });
    expect(new Headers(init?.headers).get('X-CSRF-Token')).toBe(csrf);
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
    expect(JSON.parse(String(init?.body))).toEqual({
      kind: 'aporte', amount: '100.00', description: 'Cambio para el cajón',
    });
  });

  it('records a correction that names the movement it answers', async () => {
    const fetch = mockFetch().mockResolvedValue(json(correctionBody(), 201));
    const api = createCashAPI(fetch);
    const movement = await api.correct(correctionInput, csrf);
    expect(movement.corrects_id).toBe(21);
    const [path, init] = fetch.mock.calls[0];
    expect(path).toBe('/api/closings/cash-corrections');
    expect(JSON.parse(String(init?.body))).toEqual({
      corrects_id: 21, amount: '20.00', description: 'Aporte mal cargado',
    });
  });

  it('reads the ledger of the default window without inventing bounds', async () => {
    const fetch = mockFetch().mockResolvedValue(json(ledgerBody()));
    const book = await createCashAPI(fetch).ledger();
    expect(book.since).toBe('2026-11-12T18:30:00Z');
    const [path, init] = fetch.mock.calls[0];
    expect(path).toBe('/api/closings/cash-ledger');
    expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store' });
    expect(init?.body).toBeUndefined();
  });

  it('reads one settlement window and demands the answer repeat it', async () => {
    const window = { since: '2026-11-12T18:30:00Z', until: '2026-11-16T00:00:00Z' };
    // With an explicit window the period inherits nothing: 0 + 6420 − 1405 = 5015.
    const body = ledgerBody({ ...window, opening: '0.00', expected: '5015.00' });
    const fetch = mockFetch().mockResolvedValue(json(body));
    const book = await createCashAPI(fetch).ledger(window.since, window.until);
    expect(book.until).toBe(window.until);
    expect(fetch.mock.calls[0][0]).toBe(
      '/api/closings/cash-ledger?from=2026-11-12T18%3A30%3A00Z&to=2026-11-16T00%3A00%3A00Z');
    // An answer about another window is not evidence of this one.
    const other = mockFetch().mockResolvedValue(json(ledgerBody({ since: '2026-10-01T00:00:00Z',
      until: window.until, opening: '0.00', expected: '5015.00' })));
    await expect(createCashAPI(other).ledger(window.since, window.until))
      .rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('refuses a bound that is not an instant without asking the server', async () => {
    const fetch = mockFetch();
    await expect(createCashAPI(fetch).ledger('2026-11-01', null))
      .rejects.toMatchObject({ code: 'invalid_request' });
    await expect(createCashAPI(fetch).ledger('2026-11-12T00:00:00Z', '2026-11-01T00:00:00Z'))
      .rejects.toMatchObject({ code: 'invalid_request' });
    expect(fetch).not.toHaveBeenCalled();
    expect(cashLedgerPath('2026-11-01T00:00:00Z', null))
      .toBe('/api/closings/cash-ledger?from=2026-11-01T00%3A00%3A00Z');
  });

  it('keeps the payload the screen offered and refuses a reply that changed it', async () => {
    // The reply repeats the amount the client sent, or it is not the movement this screen wrote.
    const other = mockFetch().mockResolvedValue(json(movementBody({ amount: '101.00' }), 201));
    await expect(createCashAPI(other).record(movementInput, csrf))
      .rejects.toMatchObject({ code: 'invalid_response' });
    expect(matchesCashInput(movementInput, parseCashMovement(movementBody()))).toBe(true);
    expect(matchesCashCorrection(correctionInput, parseCashCorrection(correctionBody()))).toBe(true);
    expect(matchesCashCorrection({ ...correctionInput, corrects_id: 25 },
      parseCashCorrection(correctionBody()))).toBe(false);
  });

  it('refuses a payload the contract cannot express before it leaves the screen', async () => {
    const fetch = mockFetch();
    // A correction is a direction of its own route, never of this one; a zero amount is no movement.
    const notADirection = { ...movementInput, kind: 'correccion' } as unknown as CashMovementInput;
    await expect(createCashAPI(fetch).record(notADirection, csrf))
      .rejects.toMatchObject({ code: 'invalid_request' });
    await expect(createCashAPI(fetch).record({ ...movementInput, amount: '0.00' }, csrf))
      .rejects.toMatchObject({ code: 'invalid_request' });
    await expect(createCashAPI(fetch).correct({ ...correctionInput, corrects_id: 0 }, csrf))
      .rejects.toMatchObject({ code: 'invalid_request' });
    await expect(createCashAPI(fetch).record(movementInput, 'bad token'))
      .rejects.toMatchObject({ code: 'invalid_request' });
    expect(fetch).not.toHaveBeenCalled();
    expect(canonicalCashInput(movementInput)).toEqual(movementInput);
    expect(canonicalCashCorrection(correctionInput)).toEqual(correctionInput);
    expect(cashKindMovesIn('aporte')).toBe(true);
    expect(cashKindMovesIn('gasto')).toBe(false);
  });
});

describe('refusals of the drawer', () => {
  it.each([
    [409, 'frozen', { error: 'branch_frozen' }, 'branch_frozen'],
    [400, 'invalid request', { error: 'invalid_request' }, 'invalid_request'],
    [403, 'forbidden', { error: 'forbidden' }, 'forbidden'],
    [400, 'an invalid target', { error: 'correction_target_invalid' }, 'correction_target_invalid'],
    [409, 'an excess', { error: 'correction_exceeds' }, 'correction_exceeds'],
    [503, 'an outage', { error: 'service_unavailable' }, 'service_unavailable'],
  ] as const)('admits %s %s', (status, _name, body, code) => {
    expect(parseCashError(JSON.stringify(body), status)).toBe(code);
    expect(cashErrorMessages[code]).toBeTruthy();
  });

  it('refuses a code that does not belong to the status or to this contract', () => {
    expect(() => parseCashError(JSON.stringify({ error: 'correction_exceeds' }), 400)).toThrow();
    expect(() => parseCashError(JSON.stringify({ error: 'settlement_live' }), 409)).toThrow();
    expect(() => parseCashError(JSON.stringify({ error: 'branch_frozen', excess: '1.00' }), 409)).toThrow();
    expect(() => parseCashError('{"error":"branch_frozen"}', 200)).toThrow();
  });

  it('carries the refusal as the error of the call, with the status it answered', async () => {
    const fetch = mockFetch().mockResolvedValue(json('{"error":"branch_frozen"}', 409));
    const refusal = await createCashAPI(fetch).record(movementInput, csrf).catch(error => error);
    expect(refusal).toBeInstanceOf(CashAPIError);
    expect(refusal).toMatchObject({ code: 'branch_frozen', status: 409 });
    expect(cashFailureIsDefinite('branch_frozen')).toBe(true);
    expect(cashFailureIsDefinite('service_unavailable')).toBe(false);
    expect(cashFailureIsDefinite('invalid_response')).toBe(false);
    expect(cashFailureIsDefinite('network')).toBe(false);
  });
});
