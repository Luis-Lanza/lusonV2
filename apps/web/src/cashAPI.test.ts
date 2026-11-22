import { describe, expect, it, vi } from 'vitest';
import {
  CashAPIError, canonicalCashCorrection, canonicalCashInput, cashErrorMessages, cashEvidenceRefusal,
  cashFailureIsDefinite, cashKindMovesIn, cashLedgerPath, cashMaxEvidenceBytes, cashMaxEvidenceSide,
  createCashAPI, matchesCashCorrection, matchesCashInput,
  parseCashCategories, parseCashCorrection, parseCashError, parseCashLedger, parseCashMovement,
  type CashCorrectionInput, type CashErrorCode, type CashMovementInput,
} from './cashAPI';

const csrf = 'c'.repeat(43);
const json = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
const mockFetch = () => vi.fn<typeof fetch>();

/** The magic bytes and the header of a PNG of the stated size: what the screen measures before sending. */
function pngFile(width: number, height: number): Blob {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  // The IHDR chunk: its length, its type and the two sides of the image.
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return new Blob([bytes]);
}

/** The magic bytes and the frame header of a JPEG of the stated size, behind a JFIF segment. */
function jpegFile(width: number, height: number): Blob {
  const bytes = new Uint8Array([
    0xff, 0xd8,
    // APP0 · JFIF, the segment every camera writes before the frame.
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00,
    0x01, 0x00, 0x00,
    // SOF0: the precision, the two sides and the three components of the frame.
    0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff,
    0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xff, 0xd9,
  ]);
  return new Blob([bytes]);
}

// One row of the book as the ledger publishes it: the positive amount the branch wrote, the kind that
// states its direction, the signed effect the drawer actually moved by, and — on an expense — the
// motive with the copy of the label it had when the row was written (S7, S8).
const entry = (patch: Record<string, unknown> = {}) => {
  const row: Record<string, unknown> = {
    id: 21, kind: 'gasto', effect_kind: 'gasto', amount: '85.00', effective: '-85.00',
    description: 'Detergente y escobas', occurred_at: '2026-11-13T09:12:00Z',
    created_by_account_id: 2, corrects_id: null, category_id: 5, category_label: 'Limpieza',
    evidence: null, ...patch,
  };
  // A motive is a fact of an expense alone: every other kind states both keys as null (S4).
  if (row.kind !== 'gasto' && patch.category_id === undefined && patch.category_label === undefined) {
    row.category_id = null;
    row.category_label = null;
  }
  return row;
};

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
      created_by_account_id: 2, corrects_id: null, category_id: 5, category_label: 'Limpieza',
      evidence: null,
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

  it('reads the motive of an expense with the copy of the label the row was written with', () => {
    const book = parseCashLedger(ledgerBody());
    // The motive is the pair the row states: the reference and the label it had at that moment (S8).
    expect(book.movements[0]).toMatchObject({ category_id: 5, category_label: 'Limpieza' });
    // Every kind that is not an expense names no motive at all, and states both keys as null (S4).
    expect(book.movements[2]).toMatchObject({ kind: 'aporte', category_id: null, category_label: null });
    expect(book.movements[5]).toMatchObject({ kind: 'correccion', category_id: null,
      category_label: null });
    // A row recorded before the closed list existed keeps its free-text motive and names no motive in
    // the new sense: it still reads, and it is not broken by the list (S7).
    const historical = parseCashLedger(ledgerBody({
      effective: '-85.00', expected: '8185.00',
      movements: [entry({ category_id: null, category_label: null, description: 'Flete viejo' })],
    }));
    expect(historical.movements[0]).toMatchObject({ category_id: null, category_label: null,
      description: 'Flete viejo' });
  });

  it('refuses a motive the contract does not publish on a row of the book', () => {
    const broken = (id: number, patch: Record<string, unknown>) => () => parseCashLedger(ledgerBody({
      movements: movements().map(row => row.id === id ? { ...row, ...patch } : row),
    }));
    // A row states both keys or none of them, never one of the two.
    expect(broken(21, { category_label: null })).toThrow();
    expect(broken(21, { category_id: null })).toThrow();
    // A motive on a kind that names none is not a row this domain wrote (S4).
    expect(broken(23, { category_id: 5, category_label: 'Limpieza' })).toThrow();
    expect(broken(26, { category_id: 5, category_label: 'Limpieza' })).toThrow();
    // The label is the canonical text the catalogue stores, and the identity is positive.
    expect(broken(21, { category_label: ' Limpieza' })).toThrow();
    expect(broken(21, { category_label: '' })).toThrow();
    expect(broken(21, { category_id: 0 })).toThrow();
    expect(broken(21, { category_id: 1.5 })).toThrow();
  });

  it('reads an expense with a motive and no note, and keeps the mandatory text of every other kind', () => {
    // The note of an expense is optional: the motive already states what the money paid for (S3).
    const book = parseCashLedger(ledgerBody({
      movements: movements().map(row => row.id === 21 ? { ...row, description: '' } : row),
    }));
    expect(book.movements[0].description).toBe('');
    // A contribution and a collection still state what they are for: a blank text is not this book.
    expect(() => parseCashLedger(ledgerBody({
      movements: movements().map(row => row.id === 23 ? { ...row, description: '' } : row),
    }))).toThrow();
    // The write answer follows the same rule, and a correction always states its own text.
    expect(parseCashMovement(movementBody({ kind: 'gasto', description: '' })).description).toBe('');
    expect(() => parseCashMovement(movementBody({ kind: 'gasto', description: ' Detergente' }))).toThrow();
    expect(() => parseCashMovement(movementBody({ description: '' }))).toThrow();
    expect(() => parseCashCorrection(correctionBody({ description: '' }))).toThrow();
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

  it('sends the motive of an expense as its own key and its note as the description', async () => {
    const fetch = mockFetch().mockResolvedValue(json(movementBody({ kind: 'gasto', amount: '85.00',
      description: 'Detergente' }), 201));
    const movement = await createCashAPI(fetch).record(
      { kind: 'gasto', amount: '85.00', category_id: 5, description: '  Detergente  ' }, csrf);
    expect(movement.kind).toBe('gasto');
    const [path, init] = fetch.mock.calls[0];
    expect(path).toBe('/api/closings/cash-movements');
    // The body states exactly the four keys of an expense, in the canonical text of the contract.
    expect(String(init?.body))
      .toBe('{"kind":"gasto","amount":"85.00","category_id":5,"description":"Detergente"}');
  });

  it('sends an empty note as an empty note and reads it back without invalidating the movement', async () => {
    const fetch = mockFetch().mockResolvedValue(json(movementBody({ kind: 'gasto', amount: '85.00',
      description: '' }), 201));
    const movement = await createCashAPI(fetch).record(
      { kind: 'gasto', amount: '85.00', category_id: 5, description: '' }, csrf);
    const [, init] = fetch.mock.calls[0];
    expect(String(init?.body))
      .toBe('{"kind":"gasto","amount":"85.00","category_id":5,"description":""}');
    expect(movement.description).toBe('');
  });

  it('refuses an expense without a motive and a motive on a kind that names none', async () => {
    const fetch = mockFetch();
    const noMotive = { kind: 'gasto', amount: '85.00', description: 'Detergente' } as
      unknown as CashMovementInput;
    await expect(createCashAPI(fetch).record(noMotive, csrf))
      .rejects.toMatchObject({ code: 'invalid_request' });
    const onAnAporte = { kind: 'aporte', amount: '85.00', category_id: 5, description: 'Cambio' } as
      unknown as CashMovementInput;
    await expect(createCashAPI(fetch).record(onAnAporte, csrf))
      .rejects.toMatchObject({ code: 'invalid_request' });
    for (const category of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 2, '5', null]) {
      const input = { kind: 'gasto', amount: '85.00', category_id: category, description: '' } as
        unknown as CashMovementInput;
      await expect(createCashAPI(fetch).record(input, csrf))
        .rejects.toMatchObject({ code: 'invalid_request' });
    }
    expect(fetch).not.toHaveBeenCalled();
    // A note above the bound of the contract never leaves the screen either.
    expect(() => canonicalCashInput({ kind: 'gasto', amount: '85.00', category_id: 5,
      description: 'x'.repeat(501) })).toThrow();
    expect(canonicalCashInput({ kind: 'gasto', amount: '85.00', category_id: 5, description: '' }))
      .toEqual({ kind: 'gasto', amount: '85.00', category_id: 5, description: '' });
  });

  it('reads the closed list of motives an expense is recorded with', async () => {
    const body = JSON.stringify({ categories: [{ id: 1, label: 'Alquiler' },
      { id: 2, label: 'Internet' }, { id: 5, label: 'Limpieza' }] });
    const fetch = mockFetch().mockResolvedValue(json(body));
    const options = await createCashAPI(fetch).categories();
    expect(options).toEqual([{ id: 1, label: 'Alquiler' }, { id: 2, label: 'Internet' },
      { id: 5, label: 'Limpieza' }]);
    const [path, init] = fetch.mock.calls[0];
    // The list is the same for every branch and states no query at all.
    expect(path).toBe('/api/closings/cash-categories');
    expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store' });
    expect(init?.body).toBeUndefined();
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

describe('the closed list of motives of an expense', () => {
  const categoriesBody = (patch: Record<string, unknown> = {}) => JSON.stringify({
    categories: [{ id: 1, label: 'Alquiler' }, { id: 2, label: 'Internet' }], ...patch,
  });

  it('reads the options in the order the database states them, and an empty list as an empty list', () => {
    const options = parseCashCategories(categoriesBody());
    expect(options).toEqual([{ id: 1, label: 'Alquiler' }, { id: 2, label: 'Internet' }]);
    expect(Object.isFrozen(options)).toBe(true);
    expect(Object.isFrozen(options[0])).toBe(true);
    // An empty catalogue is published as an empty list, never as a missing key (S2).
    expect(parseCashCategories(categoriesBody({ categories: [] }))).toEqual([]);
  });

  it('refuses an option that is not exactly the identity and the label of the list', () => {
    const only = (option: unknown) => categoriesBody({ categories: [option] });
    // The answer is the list and nothing else.
    expect(() => parseCashCategories(categoriesBody({ total: 2 }))).toThrow();
    expect(() => parseCashCategories(categoriesBody({ categories: undefined }))).toThrow();
    expect(() => parseCashCategories('{"categories":{}}')).toThrow();
    // An option states exactly its id and its label (S6: nothing here offers to edit one).
    expect(() => parseCashCategories(only({ id: 1, label: 'Alquiler', archived: false }))).toThrow();
    expect(() => parseCashCategories(only({ id: 1 }))).toThrow();
    expect(() => parseCashCategories(only({ id: 0, label: 'Alquiler' }))).toThrow();
    expect(() => parseCashCategories(only({ id: 1.5, label: 'Alquiler' }))).toThrow();
    expect(() => parseCashCategories(only({ id: 1, label: '  Alquiler' }))).toThrow();
    expect(() => parseCashCategories(only({ id: 1, label: '' }))).toThrow();
    expect(() => parseCashCategories(only({ id: 1, label: 'x'.repeat(501) }))).toThrow();
    // A motive is offered once, under one identity and one label.
    expect(() => parseCashCategories(categoriesBody({
      categories: [{ id: 1, label: 'Alquiler' }, { id: 1, label: 'Internet' }],
    }))).toThrow();
    expect(() => parseCashCategories(categoriesBody({
      categories: [{ id: 1, label: 'Alquiler' }, { id: 2, label: 'Alquiler' }],
    }))).toThrow();
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
    [400, 'a missing motive', { error: 'category_required' }, 'category_required'],
    [400, 'an unknown motive', { error: 'category_unknown' }, 'category_unknown'],
    [400, 'a motive on another kind', { error: 'category_not_applicable' },
      'category_not_applicable'],
  ] as const)('admits %s %s', (status, _name, body, code) => {
    expect(parseCashError(JSON.stringify(body), status)).toBe(code);
    expect(cashErrorMessages[code]).toBeTruthy();
  });

  it('refuses a code that does not belong to the status or to this contract', () => {
    expect(() => parseCashError(JSON.stringify({ error: 'correction_exceeds' }), 400)).toThrow();
    expect(() => parseCashError(JSON.stringify({ error: 'settlement_live' }), 409)).toThrow();
    expect(() => parseCashError(JSON.stringify({ error: 'branch_frozen', excess: '1.00' }), 409)).toThrow();
    expect(() => parseCashError('{"error":"branch_frozen"}', 200)).toThrow();
    // The bound of the till is the one refusal that states two quantities beside its code (S4): it is
    // admitted with them, and refused whole when one of them is not the canonical money text.
    expect(parseCashError('{"error":"drawer_insufficient","balance":"50.00","requested":"1200.00"}',
      409)).toBe('drawer_insufficient');
    expect(() => parseCashError('{"error":"drawer_insufficient","balance":"50.00"}', 409)).toThrow();
    expect(() => parseCashError(
      '{"error":"drawer_insufficient","balance":"50","requested":"1200.00"}', 409)).toThrow();
    // A drawer that is already negative states its balance with a sign, and the refusal is read whole:
    // the operator reads the number the rule saw instead of an unreadable envelope.
    expect(parseCashError('{"error":"drawer_insufficient","balance":"-50.00","requested":"1200.00"}',
      409)).toBe('drawer_insufficient');
    // The sign is optional and never doubled or spaced, and the decimals are the canonical two.
    for (const balance of ['- 50.00', '--50.00', '+50.00', '-50', '-.50']) {
      expect(() => parseCashError(
        `{"error":"drawer_insufficient","balance":"${balance}","requested":"1200.00"}`, 409))
        .toThrow();
    }
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

// The receipt of a pay-out is one optional photo of the ticket (S1): it travels as a file the customer
// chose, it is judged before anything leaves the screen, and the book publishes its metadata alone (S7).
describe('the receipt of an expense', () => {
  const receipt = Object.freeze({ type: 'image/jpeg', size: 482_913, sha256: 'a'.repeat(64) });

  const withoutReceipt = (row: Record<string, unknown>): Record<string, unknown> => {
    const { evidence: _dropped, ...rest } = row;
    return rest;
  };

  it('reads the metadata of the receipt of one row and nothing of its bytes (S7)', () => {
    const book = parseCashLedger(ledgerBody({
      movements: movements().map(row => row.id === 21 ? { ...row, evidence: receipt } : row),
    }));
    // The receipt is the three keys the contract publishes: type, size and digest, never the image.
    expect(book.movements[0].evidence).toEqual(receipt);
    expect(Object.isFrozen(book.movements[0].evidence)).toBe(true);
    // A row recorded without a photo states null, which is not the same fact as a missing key.
    expect(book.movements[1].evidence).toBeNull();
  });

  it('refuses a receipt that is not the shape this contract publishes', () => {
    const broken = (evidence: unknown) => () => parseCashLedger(ledgerBody({
      movements: movements().map(row => row.id === 21 ? { ...row, evidence } : row),
    }));
    // The key is always published: a row that omits it is not a row of this book (S7).
    expect(() => parseCashLedger(ledgerBody({
      movements: movements().map(row => row.id === 21 ? withoutReceipt(row) : row),
    }))).toThrow();
    // The three keys, all of them and nothing beside them.
    expect(broken({ type: 'image/jpeg', size: 482_913 })).toThrow();
    expect(broken({ ...receipt, bytes: 'x' })).toThrow();
    expect(broken({ ...receipt, name: 'comprobante.jpg' })).toThrow();
    // Only the two formats the server decodes, a positive size inside the 8 MB cap and a lowercase digest.
    expect(broken({ ...receipt, type: 'image/gif' })).toThrow();
    expect(broken({ ...receipt, type: 'image/svg+xml' })).toThrow();
    expect(broken({ ...receipt, size: 0 })).toThrow();
    expect(broken({ ...receipt, size: cashMaxEvidenceBytes + 1 })).toThrow();
    expect(broken({ ...receipt, size: '482913' })).toThrow();
    expect(broken({ ...receipt, sha256: 'A'.repeat(64) })).toThrow();
    expect(broken({ ...receipt, sha256: 'a'.repeat(63) })).toThrow();
    expect(broken({ ...receipt, sha256: 42 })).toThrow();
  });

  it('refuses a receipt on a kind that never carries one (S2)', () => {
    for (const id of [23, 24, 26]) {
      expect(() => parseCashLedger(ledgerBody({
        movements: movements().map(row => row.id === id ? { ...row, evidence: receipt } : row),
      }))).toThrow();
    }
  });

  it('sends an expense with a photo as multipart, with the movement and exactly one file', async () => {
    const fetch = mockFetch().mockResolvedValue(json(movementBody({ kind: 'gasto',
      amount: '85.00', description: 'Detergente' }), 201));
    // A real photo of the drawer: a JPEG whose own header states its two sides.
    const file = new File([await jpegFile(2, 2).arrayBuffer()], 'comprobante.jpg',
      { type: 'image/jpeg' });
    await createCashAPI(fetch).record(
      { kind: 'gasto', amount: '85.00', category_id: 5, description: ' Detergente ' }, csrf,
      undefined, file);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [path, init] = fetch.mock.calls[0];
    expect(path).toBe('/api/closings/cash-movements');
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store' });
    expect(new Headers(init?.headers).get('X-CSRF-Token')).toBe(csrf);
    // The browser states the boundary of the body: this client never writes that header itself.
    expect(new Headers(init?.headers).get('Content-Type')).toBeNull();
    const form = init?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    // Two parts, in this order: the JSON object of the route and the one photo (S1).
    expect([...form.keys()]).toEqual(['movement', 'evidence']);
    expect(form.getAll('evidence')).toHaveLength(1);
    // The `movement` part is the same JSON the plain route sends, canonical text and all (S9).
    expect(await (form.get('movement') as Blob).text())
      .toBe('{"kind":"gasto","amount":"85.00","category_id":5,"description":"Detergente"}');
    const part = form.get('evidence') as File;
    expect(part.name).toBe('comprobante.jpg');
    // The bytes travel exactly as the operator chose them: nothing is re-encoded on the way out.
    expect([...new Uint8Array(await part.arrayBuffer())])
      .toEqual([...new Uint8Array(await file.arrayBuffer())]);
  });

  it('sends the same expense as plain JSON when no photo was chosen (S9)', async () => {
    const fetch = mockFetch().mockResolvedValue(json(movementBody({ kind: 'gasto',
      amount: '85.00', description: 'Detergente' }), 201));
    await createCashAPI(fetch).record(
      { kind: 'gasto', amount: '85.00', category_id: 5, description: 'Detergente' }, csrf, undefined,
      null);
    const [, init] = fetch.mock.calls[0];
    // The form of the route is the JSON one, byte for byte the body it always sent.
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
    expect(init?.body).toBe('{"kind":"gasto","amount":"85.00","category_id":5,"description":"Detergente"}');
  });

  it('refuses to attach a photo to anything that is not an expense, before asking the server (S2)', async () => {
    const fetch = mockFetch();
    const file = new File([new Uint8Array([0xff, 0xd8])], 'comprobante.jpg', { type: 'image/jpeg' });
    for (const kind of ['aporte', 'recaudacion'] as const) {
      await expect(createCashAPI(fetch).record(
        { kind, amount: '100.00', description: 'Cambio para el cajón' }, csrf, undefined, file))
        .rejects.toMatchObject({ code: 'evidence_not_applicable' });
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(cashErrorMessages.evidence_not_applicable).toContain('Sólo un gasto lleva comprobante');
  });

  it('judges a chosen file by its own bytes and its size before anything leaves the screen', async () => {
    // The two formats the server decodes are admitted by their header, which is what the screen reads.
    expect(await cashEvidenceRefusal(pngFile(1, 1))).toBeNull();
    expect(await cashEvidenceRefusal(jpegFile(2, 2))).toBeNull();
    // The pixel cap is 6000 a side, on both formats and on the square that states it twice.
    expect(cashMaxEvidenceSide).toBe(6_000);
    expect(await cashEvidenceRefusal(jpegFile(6_000, 6_000))).toBeNull();
    expect(await cashEvidenceRefusal(pngFile(6_000, 6_000))).toBeNull();
    // A file that states no bytes is the first refusal of the contract.
    expect(await cashEvidenceRefusal(new Blob([]))).toBe('evidence_empty');
    // The cap of 8 MB is the contract's own, and it is judged before the bytes are even read.
    expect(await cashEvidenceRefusal(new Blob([new Uint8Array(cashMaxEvidenceBytes + 1)])))
      .toBe('evidence_too_large');
    expect(await cashEvidenceRefusal(new Blob([new Uint8Array(cashMaxEvidenceBytes)])))
      .toBe('evidence_unsupported');
    // SVG and every other file that is not a JPEG or a PNG: the format is read from the bytes, never
    // from the name the file carries (S6).
    expect(await cashEvidenceRefusal(new Blob(['<svg xmlns="http://www.w3.org/2000/svg"/>'])))
      .toBe('evidence_unsupported');
    const disguised = new File(['<?php echo 1; ?>'], 'comprobante.png', { type: 'image/png' });
    expect(await cashEvidenceRefusal(disguised)).toBe('evidence_unsupported');
    // The cap of 6000×6000 pixels is read from the header of the image, on both formats and on both
    // sides, and one pixel past it is the refusal the contract names.
    expect(await cashEvidenceRefusal(pngFile(6_001, 1))).toBe('evidence_dimensions');
    expect(await cashEvidenceRefusal(pngFile(1, 6_001))).toBe('evidence_dimensions');
    expect(await cashEvidenceRefusal(pngFile(6_001, 6_001))).toBe('evidence_dimensions');
    expect(await cashEvidenceRefusal(jpegFile(6_001, 10))).toBe('evidence_dimensions');
    expect(await cashEvidenceRefusal(jpegFile(10, 6_001))).toBe('evidence_dimensions');
    expect(await cashEvidenceRefusal(jpegFile(6_001, 6_001))).toBe('evidence_dimensions');
    // A PNG whose header does not state the two sides is not a file this screen can judge.
    expect(await cashEvidenceRefusal(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])])))
      .toBe('evidence_unsupported');
    expect(await cashEvidenceRefusal(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])])))
      .toBe('evidence_unsupported');
    // The words of the screen state the contract's own cap, which is the server's.
    expect(cashErrorMessages.evidence_dimensions).toContain('6000');
    expect(cashErrorMessages.evidence_dimensions).not.toContain('10000');
    // The screen and the server refuse with the same words, because it is one message.
    for (const code of ['evidence_empty', 'evidence_too_large', 'evidence_unsupported',
      'evidence_dimensions', 'evidence_not_applicable'] as const) {
      expect(cashErrorMessages[code]).toBeTruthy();
      expect(parseCashError(JSON.stringify({ error: code }), 400)).toBe(code);
    }
  });

  it('answers a refused upload with the words of the screen, never with the raw code', async () => {
    for (const code of ['evidence_empty', 'evidence_too_large', 'evidence_unsupported',
      'evidence_dimensions', 'evidence_not_applicable'] as const) {
      const fetch = mockFetch().mockResolvedValue(json(JSON.stringify({ error: code }), 400));
      // The file itself is one the screen admits: the refusal read back is the server's own.
      const file = new File([await jpegFile(2, 2).arrayBuffer()], 'comprobante.jpg');
      const refusal = await createCashAPI(fetch).record(
        { kind: 'gasto', amount: '85.00', category_id: 5, description: '' }, csrf, undefined, file)
        .catch(error => error);
      expect(refusal).toBeInstanceOf(CashAPIError);
      expect(refusal).toMatchObject({ code: code as CashErrorCode, status: 400 });
      expect(cashErrorMessages[code as CashErrorCode]).not.toContain(code);
    }
    // A code this contract does not publish is never read as one of them.
    expect(() => parseCashError(JSON.stringify({ error: 'evidence_corrupt' }), 400)).toThrow();
  });
});
