import { describe, expect, it } from 'vitest';
import {
  canonicalStockEntryInput, canonicalStockEntryReversalInput, canonicalStockEntryReversalReason, matchesStockEntryInput,
  matchesStockEntryReversal, newStockEntryOperationKey, parseStockCatalog, parseStockEntryError, parseStockEntryHistory,
  parseStockEntryDetail, parseStockEntryDetailError, parseStockEntryRecord, parseStockEntryReversalError,
  parseStockEntryReversalRecord, stockCatalogPath, stockEntryAdmittedErrors, stockEntryDetailAdmittedErrors,
  stockEntryDetailErrorMessages, stockEntryDetailPath, stockEntryErrorMessages, stockEntryFailureIsDefinite,
  stockEntryHistoryPath,
  stockEntryHistoryPageSizes, stockEntryReversalAdmittedErrors, stockEntryReversalErrorMessages,
  stockEntryReversalFailureIsDefinite, stockEntryReversalPath, stockEntryReversible, validStockEntryHistoryQuery,
  validStockQuantity, type StockEntryHistoryRow, type StockEntryInput, type StockEntryReversalInput,
} from './stockEntryModel';

const key = 'warehouse_key_0001';
function fixedRandom(): Pick<Crypto, 'getRandomValues'> {
  return { getRandomValues: <T extends ArrayBufferView | null>(array: T): T => {
    if (array !== null) new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(7);
    return array;
  } };
}
const draft = (patch: Partial<StockEntryInput> = {}): StockEntryInput => ({
  operation_key: key, lines: [{ variant_id: 4, quantity: 2 }], ...patch,
});
const recordJSON = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  id: 7, location_id: 1, note: '', created_by_account_id: 1, created_at: '2026-05-01T14:20:00Z',
  lines: [{ variant_id: 4, quantity: 2 }], total_units: 2, ...overrides,
});
const catalogJSON = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  location: { id: 1, name: 'Almacén' },
  items: [{ variant_id: 4, catalog_entry_id: 2, brand: 'TOYO', model: 'NS40ZL', capacity_ah: 35, polarity: 'L', existing: 14, reserved: 0, available: 14 }],
  page: 1, page_size: 50, total_variants: 1, ...overrides,
});

describe('stock entry canonical request', () => {
  it('orders lines by variant and freezes the exact payload that will be sent', () => {
    const canonical = canonicalStockEntryInput(draft({
      note: 'Remito 0002-00045871', lines: [{ variant_id: 9, quantity: 1 }, { variant_id: 4, quantity: 2 }],
    }));
    expect(canonical).toEqual({ operation_key: key, note: 'Remito 0002-00045871',
      lines: [{ variant_id: 4, quantity: 2 }, { variant_id: 9, quantity: 1 }] });
    expect(Object.isFrozen(canonical)).toBe(true);
    expect(Object.isFrozen(canonical.lines)).toBe(true);
    expect(Object.isFrozen(canonical.lines[0])).toBe(true);
    expect(JSON.stringify(canonical)).toBe('{"operation_key":"warehouse_key_0001","note":"Remito 0002-00045871","lines":[{"variant_id":4,"quantity":2},{"variant_id":9,"quantity":1}]}');
  });

  it('omits an empty note because it is optional in the contract', () => {
    expect(canonicalStockEntryInput(draft({ note: '' }))).toEqual({ operation_key: key, lines: [{ variant_id: 4, quantity: 2 }] });
    expect(JSON.stringify(canonicalStockEntryInput(draft({ note: '' })))).toBe('{"operation_key":"warehouse_key_0001","lines":[{"variant_id":4,"quantity":2}]}');
  });

  it.each([
    ['duplicate variants', draft({ lines: [{ variant_id: 4, quantity: 1 }, { variant_id: 4, quantity: 2 }] })],
    ['no lines', draft({ lines: [] })],
    ['191 lines', draft({ lines: Array.from({ length: 191 }, (_, index) => ({ variant_id: index + 1, quantity: 1 })) })],
    ['zero quantity', draft({ lines: [{ variant_id: 4, quantity: 0 }] })],
    ['quantity above one million', draft({ lines: [{ variant_id: 4, quantity: 1000001 }] })],
    ['fractional quantity', draft({ lines: [{ variant_id: 4, quantity: 1.5 }] })],
    ['variant id out of range', draft({ lines: [{ variant_id: 0, quantity: 1 }] })],
    ['short operation key', draft({ operation_key: 'k'.repeat(15) })],
    ['long operation key', draft({ operation_key: 'k'.repeat(129) })],
    ['operation key with forbidden characters', draft({ operation_key: 'k'.repeat(30) + '.bad' })],
    ['note over 500 characters', draft({ note: 'n'.repeat(501) })],
    ['note with NUL', draft({ note: 'remito\u0000' })],
    ['unknown field', { ...draft(), extra: true } as unknown as StockEntryInput],
  ])('rejects %s', (_, input) => {
    expect(() => canonicalStockEntryInput(input)).toThrow('Documento de ingreso inválido.');
  });

  it('accepts the 190 line and 500 character boundaries', () => {
    const lines = Array.from({ length: 190 }, (_, index) => ({ variant_id: index + 1, quantity: 1000000 }));
    const canonical = canonicalStockEntryInput(draft({ lines, note: 'n'.repeat(500) }));
    expect(canonical.lines).toHaveLength(190);
    expect(canonical.note).toHaveLength(500);
    expect(validStockQuantity(1)).toBe(true);
    expect(validStockQuantity(1000000)).toBe(true);
    expect(validStockQuantity(0)).toBe(false);
    expect(validStockQuantity(2.5)).toBe(false);
  });
});

describe('stock entry response parsing', () => {
  it('parses lossless numbers into exact safe integers and keeps an empty note', () => {
    const record = parseStockEntryRecord(recordJSON({ id: 9007199254740991, total_units: 2 }));
    expect(record).toEqual({ id: 9007199254740991, location_id: 1, note: '', created_by_account_id: 1,
      created_at: '2026-05-01T14:20:00Z', lines: [{ variant_id: 4, quantity: 2 }], total_units: 2 });
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.lines)).toBe(true);
  });

  it.each([
    ['an extra field', recordJSON({ extra: 1 })],
    ['a missing field', JSON.stringify({ id: 7, location_id: 1, note: '', created_at: '2026-05-01T14:20:00Z', lines: [{ variant_id: 4, quantity: 2 }], total_units: 2 })],
    ['an unsafe id', recordJSON({ id: 9007199254740992 })],
    ['a fractional quantity', recordJSON({ lines: [{ variant_id: 4, quantity: 1.5 }] })],
    ['an exponent quantity', '{"id":7,"location_id":1,"note":"","created_by_account_id":1,"created_at":"2026-05-01T14:20:00Z","lines":[{"variant_id":4,"quantity":1e3}],"total_units":1000}'],
    ['duplicate lines', recordJSON({ lines: [{ variant_id: 4, quantity: 2 }, { variant_id: 4, quantity: 1 }], total_units: 3 })],
    ['an impossible date', recordJSON({ created_at: '2026-02-31T00:00:00Z' })],
    ['a date without offset', recordJSON({ created_at: '2026-05-01T14:20:00' })],
    ['a note with NUL', recordJSON({ note: 'a\u0000b' })],
    ['a note over 500 characters', recordJSON({ note: 'n'.repeat(501) })],
  ])('rejects %s', (_, raw) => {
    expect(() => parseStockEntryRecord(raw)).toThrow('Respuesta inválida del servidor.');
  });

  it('rejects a duplicated JSON key instead of keeping the last value', () => {
    expect(() => parseStockEntryRecord('{"id":7,"id":8,"location_id":1,"note":"","created_by_account_id":1,"created_at":"2026-05-01T14:20:00Z","lines":[{"variant_id":4,"quantity":2}],"total_units":2}'))
      .toThrow('Respuesta inválida del servidor.');
  });
});

describe('stock entry error envelopes', () => {
  it('admits only the exact code for each status', () => {
    expect(parseStockEntryError('{"error":"invalid_request"}', 400)).toBe('invalid_request');
    expect(parseStockEntryError('{"error":"forbidden"}', 403)).toBe('forbidden');
    expect(parseStockEntryError('{"error":"retry_conflict"}', 409)).toBe('retry_conflict');
    expect(parseStockEntryError('{"error":"insufficient_stock"}', 409)).toBe('insufficient_stock');
    expect(parseStockEntryError('{"error":"service_unavailable"}', 503)).toBe('service_unavailable');
  });

  it.each([
    ['a known code on the wrong status', '{"error":"retry_conflict"}', 400],
    ['a known code on 409 that is not admitted there', '{"error":"forbidden"}', 409],
    ['an unknown code', '{"error":"conflict"}', 409],
    ['an unlisted status', '{"error":"invalid_request"}', 500],
    ['an envelope with more than one key', '{"error":"forbidden","detail":"x"}', 403],
    ['a non JSON body', '<html>proxy</html>', 503],
    ['a non string code', '{"error":400}', 400],
  ])('rejects %s', (_, raw, status) => {
    expect(() => parseStockEntryError(raw, status)).toThrow('Respuesta inválida del servidor.');
  });

  it('maps every admitted code to a Spanish message and classifies only proven rejections as definite', () => {
    for (const codes of stockEntryAdmittedErrors.values()) {
      for (const code of codes) expect(stockEntryErrorMessages[code]).toMatch(/[áéíóúñ¿]/i);
    }
    expect(stockEntryErrorMessages.network).toContain('No se pudo conectar');
    expect(stockEntryErrorMessages.aborted).toContain('Conservamos el documento');
    for (const code of ['invalid_request', 'forbidden', 'retry_conflict', 'insufficient_stock'] as const) {
      expect(stockEntryFailureIsDefinite(code)).toBe(true);
    }
    for (const code of ['service_unavailable', 'invalid_response', 'network', 'aborted'] as const) {
      expect(stockEntryFailureIsDefinite(code)).toBe(false);
    }
  });
});

describe('stock entry operation key', () => {
  it('uses secure randomness in the accepted alphabet and never Math.random', () => {
    const first = newStockEntryOperationKey();
    expect(first).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(newStockEntryOperationKey()).not.toBe(first);
    expect(newStockEntryOperationKey(fixedRandom())).toBe('07'.repeat(16));
  });

  it('fails closed when secure randomness is unavailable', () => {
    expect(() => newStockEntryOperationKey({} as Pick<Crypto, 'getRandomValues'>)).toThrow('Secure randomness unavailable');
  });
});

describe('stock entry payload evidence', () => {
  const record = parseStockEntryRecord(recordJSON({ lines: [{ variant_id: 9, quantity: 1 }, { variant_id: 4, quantity: 2 }], total_units: 3 }));

  it('accepts a record that repeats the sent lines in any order', () => {
    expect(matchesStockEntryInput(draft({ lines: [{ variant_id: 4, quantity: 2 }, { variant_id: 9, quantity: 1 }] }), record)).toBe(true);
  });

  it.each([
    ['a different quantity', draft({ lines: [{ variant_id: 4, quantity: 3 }, { variant_id: 9, quantity: 1 }] })],
    ['a missing line', draft({ lines: [{ variant_id: 4, quantity: 2 }] })],
    ['a different variant', draft({ lines: [{ variant_id: 4, quantity: 2 }, { variant_id: 5, quantity: 1 }] })],
  ])('rejects %s', (_, input) => {
    expect(matchesStockEntryInput(input, record)).toBe(false);
  });

  it('rejects a total that does not add up or a record outside the warehouse', () => {
    expect(matchesStockEntryInput(draft({ lines: [{ variant_id: 4, quantity: 2 }, { variant_id: 9, quantity: 1 }] }),
      parseStockEntryRecord(recordJSON({ lines: [{ variant_id: 4, quantity: 2 }, { variant_id: 9, quantity: 1 }], total_units: 9 })))).toBe(false);
    expect(matchesStockEntryInput(draft(), parseStockEntryRecord(recordJSON({ location_id: 2 })))).toBe(false);
  });
});

describe('stock ingress history read contract', () => {
  const historyRow = (overrides: Record<string, unknown> = {}) => ({
    id: 7, note: 'Remito 0002', created_at: '2026-11-04T14:20:00Z',
    lines: 2, total_units: 18, reversed_by: null, ...overrides });
  const historyJSON = (overrides: Record<string, unknown> = {}) => JSON.stringify({
    page: 1, page_size: 25, total_entries: 1, entries: [historyRow()], ...overrides });

  it('builds the frozen query and admits only canonical pages and sizes', () => {
    expect(stockEntryHistoryPath(1, 25)).toBe('/api/stock-entries?page=1&page_size=25');
    expect(stockEntryHistoryPath(3, 50)).toBe('/api/stock-entries?page=3&page_size=50');
    expect([...stockEntryHistoryPageSizes]).toEqual([10, 25, 50]);
    for (const size of stockEntryHistoryPageSizes) {
      expect(validStockEntryHistoryQuery(1, size)).toBe(true);
    }
    expect(validStockEntryHistoryQuery(1000000, 25)).toBe(true);
    for (const page of [0, -1, 1.5, 1000001, Number.NaN]) {
      expect(validStockEntryHistoryQuery(page, 25)).toBe(false);
    }
    for (const size of [0, 5, 15, 100, 25.5]) {
      expect(validStockEntryHistoryQuery(1, size)).toBe(false);
    }
  });

  it('keeps every number lossless and freezes the page and its rows', () => {
    const page = parseStockEntryHistory(JSON.stringify({
      page: 2, page_size: 10, total_entries: 12,
      entries: [historyRow({ id: 9007199254740990, total_units: -3, reversed_by: 9007199254740991, note: '' }),
        historyRow({ id: 8, lines: 1, total_units: 1 })],
    }));
    expect(page).toEqual({ page: 2, page_size: 10, total_entries: 12, entries: [
      { id: 9007199254740990, note: '', created_at: '2026-11-04T14:20:00Z', lines: 2, total_units: -3, reversed_by: 9007199254740991 },
      { id: 8, note: 'Remito 0002', created_at: '2026-11-04T14:20:00Z', lines: 1, total_units: 1, reversed_by: null },
    ] });
    expect(Object.isFrozen(page)).toBe(true);
    expect(Object.isFrozen(page.entries)).toBe(true);
    expect(Object.isFrozen(page.entries[0])).toBe(true);
  });

  it('parses an empty page beyond the last one', () => {
    const page = parseStockEntryHistory(historyJSON({ page: 1000000, page_size: 50, total_entries: 3, entries: [] }));
    expect(page.entries).toEqual([]);
    expect(page.total_entries).toBe(3);
  });

  it.each([
    ['an extra page field', historyJSON({ extra: 1 })],
    ['a missing page field', JSON.stringify({ page_size: 25, total_entries: 1, entries: [historyRow()] })],
    ['a zero page', historyJSON({ page: 0 })],
    ['a page above the bound', historyJSON({ page: 1000001 })],
    ['a padded page', '{"page":01,"page_size":25,"total_entries":1,"entries":[]}'],
    ['a page size outside the contract', historyJSON({ page_size: 15 })],
    ['a negative total', historyJSON({ total_entries: -1 })],
    ['entries that are not an array', historyJSON({ entries: {} })],
    ['more rows than the page size', historyJSON({ page_size: 10, total_entries: 11,
      entries: [historyRow({ id: 20 }), historyRow({ id: 19 }), historyRow({ id: 18 }), historyRow({ id: 17 }), historyRow({ id: 16 }),
        historyRow({ id: 15 }), historyRow({ id: 14 }), historyRow({ id: 13 }), historyRow({ id: 12 }), historyRow({ id: 11 }),
        historyRow({ id: 10 })] })],
    ['a page whose rows exceed the total', historyJSON({ page: 2, page_size: 10, total_entries: 5, entries: [historyRow({ id: 3 })] })],
    ['an extra row field', historyJSON({ entries: [historyRow({ variant_id: 4 })] })],
    ['a missing row field', historyJSON({ entries: [{ id: 7, created_at: '2026-11-04T14:20:00Z', lines: 2, total_units: 18, reversed_by: null }] })],
    ['an unsafe id', historyJSON({ entries: [historyRow({ id: 9007199254740992 })] })],
    ['a zero id', historyJSON({ entries: [historyRow({ id: 0 })] })],
    ['rows out of order', historyJSON({ total_entries: 2, entries: [historyRow({ id: 7 }), historyRow({ id: 9 })] })],
    ['a repeated row', historyJSON({ total_entries: 2, entries: [historyRow({ id: 7 }), historyRow({ id: 7 })] })],
    ['zero lines', historyJSON({ entries: [historyRow({ lines: 0 })] })],
    ['more lines than a document admits', historyJSON({ entries: [historyRow({ lines: 191 })] })],
    ['a fractional quantity total', historyJSON({ entries: [historyRow({ total_units: 1.5 })] })],
    ['an exponent total', '{"page":1,"page_size":25,"total_entries":1,"entries":[{"id":7,"note":"","created_at":"2026-11-04T14:20:00Z","lines":1,"total_units":1e3,"reversed_by":null}]}'],
    ['a total above one document', historyJSON({ entries: [historyRow({ total_units: 190000001 })] })],
    ['a total below one document', historyJSON({ entries: [historyRow({ total_units: -190000001 })] })],
    ['a reversal that is not later', historyJSON({ entries: [historyRow({ id: 7, reversed_by: 7 })] })],
    ['a zero reversal id', historyJSON({ entries: [historyRow({ id: 7, reversed_by: 0 })] })],
    ['a string reversal id', historyJSON({ entries: [historyRow({ id: 7, reversed_by: '9' })] })],
    ['an impossible date', historyJSON({ entries: [historyRow({ created_at: '2026-02-31T00:00:00Z' })] })],
    ['a note with NUL', historyJSON({ entries: [historyRow({ note: 'a\u0000b' })] })],
    ['a note over 500 characters', historyJSON({ entries: [historyRow({ note: 'n'.repeat(501) })] })],
    ['a duplicated JSON key', '{"page":1,"page":2,"page_size":25,"total_entries":0,"entries":[]}'],
    ['a non JSON body', '<html>proxy</html>'],
  ])('rejects %s', (_, raw) => {
    expect(() => parseStockEntryHistory(raw)).toThrow('Respuesta inválida del servidor.');
  });
});

describe('stock catalog read contract', () => {
  it('reuses the inventory query with the warehouse, first page and fifty rows', () => {
    expect(stockCatalogPath('')).toBe('/api/inventory?location_id=1&page=1&page_size=50');
    expect(stockCatalogPath('NS40ZL')).toBe('/api/inventory?location_id=1&page=1&page_size=50&search=NS40ZL');
  });

  it('parses the existing inventory payload and refuses another location, page or size', () => {
    const items = parseStockCatalog(catalogJSON());
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ variant_id: 4, brand: 'TOYO', model: 'NS40ZL', capacity_ah: '35', existing: 14n });
    expect(Object.isFrozen(items)).toBe(true);
    expect(() => parseStockCatalog(catalogJSON({ location: { id: 2, name: 'Sucursal A' } }))).toThrow('Respuesta inválida del servidor.');
    expect(() => parseStockCatalog(catalogJSON({ page: 2 }))).toThrow('Respuesta inválida del servidor.');
    expect(() => parseStockCatalog(catalogJSON({ page_size: 10 }))).toThrow('Respuesta inválida del servidor.');
  });
});

describe('stock counter-entry contract', () => {
  const reversible = (overrides: Partial<StockEntryHistoryRow> = {}): StockEntryHistoryRow => ({
    id: 7, note: 'Remito 0002', created_at: '2026-11-04T14:20:00Z', lines: 2, total_units: 18,
    reversed_by: null, ...overrides });
  const counterJSON = (overrides: Record<string, unknown> = {}) => JSON.stringify({
    id: 9, location_id: 1, note: '', created_by_account_id: 1, created_at: '2026-11-04T14:21:00Z',
    lines: [{ variant_id: 1, quantity: -4 }, { variant_id: 2, quantity: -14 }], total_units: -18, ...overrides });

  it('canonicalizes the mandatory reason and keeps the exact payload', () => {
    expect(canonicalStockEntryReversalInput({ operation_key: 'warehouse_key_0001', reason: '  error de carga  ' }))
      .toEqual({ operation_key: 'warehouse_key_0001', reason: 'error de carga' });
    expect(JSON.stringify(canonicalStockEntryReversalInput({ operation_key: 'warehouse_key_0001', reason: ' error de carga ' })))
      .toBe('{"operation_key":"warehouse_key_0001","reason":"error de carga"}');
    expect(canonicalStockEntryReversalReason('ñ'.repeat(500))).toBe('ñ'.repeat(500));
  });

  it.each([
    ['an empty reason', { operation_key: 'warehouse_key_0001', reason: '' }],
    ['a blank reason', { operation_key: 'warehouse_key_0001', reason: '   \n' }],
    ['a reason over 500 characters', { operation_key: 'warehouse_key_0001', reason: 'ñ'.repeat(501) }],
    ['a reason with NUL', { operation_key: 'warehouse_key_0001', reason: 'a\u0000b' }],
    ['a short operation key', { operation_key: 'k'.repeat(15), reason: 'motivo' }],
    ['an operation key outside the alphabet', { operation_key: 'k'.repeat(30) + '.bad', reason: 'motivo' }],
    ['an unknown field', { operation_key: 'warehouse_key_0001', reason: 'motivo', lines: [] }],
  ])('rejects %s', (_, input) => {
    expect(() => canonicalStockEntryReversalInput(input as unknown as StockEntryReversalInput))
      .toThrow('Contra-asiento inválido.');
  });

  it('builds the frozen reversal path and admits only a canonical target id', () => {
    expect(stockEntryReversalPath(7)).toBe('/api/stock-entries/7/reverse');
    expect(stockEntryReversalPath(9007199254740991)).toBe('/api/stock-entries/9007199254740991/reverse');
    for (const id of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => stockEntryReversalPath(id)).toThrow('Contra-asiento inválido.');
    }
  });

  it('parses a counter-entry with negative lines and a negative total', () => {
    const record = parseStockEntryReversalRecord(counterJSON());
    expect(record).toEqual({ id: 9, location_id: 1, note: '', created_by_account_id: 1,
      created_at: '2026-11-04T14:21:00Z',
      lines: [{ variant_id: 1, quantity: -4 }, { variant_id: 2, quantity: -14 }], total_units: -18 });
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.lines)).toBe(true);
  });

  it.each([
    ['a positive line', counterJSON({ lines: [{ variant_id: 1, quantity: 4 }, { variant_id: 2, quantity: -14 }] })],
    ['a zero line', counterJSON({ lines: [{ variant_id: 1, quantity: 0 }, { variant_id: 2, quantity: -18 }] })],
    ['a positive total', counterJSON({ total_units: 18 })],
    ['a zero total', counterJSON({ total_units: 0 })],
    ['a total that does not add up', counterJSON({ total_units: -9 })],
    ['an extra field', counterJSON({ reason: 'error de carga' })],
    ['a note', counterJSON({ note: 'Remito 0002' })],
    ['a duplicated JSON key', '{"id":9,"id":10,"location_id":1,"note":"","created_by_account_id":1,"created_at":"2026-11-04T14:21:00Z","lines":[{"variant_id":1,"quantity":-1}],"total_units":-1}'],
  ])('rejects a counter-entry with %s', (_, raw) => {
    expect(() => parseStockEntryReversalRecord(raw)).toThrow('Respuesta inválida del servidor.');
  });

  it('proves the counter-entry is the exact negation of the listed document', () => {
    const record = parseStockEntryReversalRecord(counterJSON());
    expect(matchesStockEntryReversal(reversible(), record)).toBe(true);
    expect(matchesStockEntryReversal(reversible({ lines: 1 }), record)).toBe(false);
    expect(matchesStockEntryReversal(reversible({ total_units: 9 }), record)).toBe(false);
    expect(matchesStockEntryReversal(reversible({ total_units: -18 }), record)).toBe(false);
    expect(matchesStockEntryReversal(reversible(), parseStockEntryReversalRecord(counterJSON({ location_id: 2 })))).toBe(false);
  });

  it('offers the action only on documents that have no counter-entry yet', () => {
    expect(stockEntryReversible(reversible())).toBe(true);
    expect(stockEntryReversible(reversible({ reversed_by: 9 }))).toBe(false);
    // A counter-entry is never reversible: its own lines are already negative.
    expect(stockEntryReversible(reversible({ total_units: -18 }))).toBe(false);
  });

  it('admits only the exact reversal error code for each status', () => {
    expect(parseStockEntryReversalError('{"error":"invalid_request"}', 400)).toBe('invalid_request');
    expect(parseStockEntryReversalError('{"error":"unauthenticated"}', 401)).toBe('unauthenticated');
    expect(parseStockEntryReversalError('{"error":"forbidden"}', 403)).toBe('forbidden');
    expect(parseStockEntryReversalError('{"error":"not_found"}', 404)).toBe('not_found');
    expect(parseStockEntryReversalError('{"error":"decision_conflict"}', 409)).toBe('decision_conflict');
    expect(parseStockEntryReversalError('{"error":"retry_conflict"}', 409)).toBe('retry_conflict');
    expect(parseStockEntryReversalError('{"error":"insufficient_stock"}', 409)).toBe('insufficient_stock');
    expect(parseStockEntryReversalError('{"error":"service_unavailable"}', 503)).toBe('service_unavailable');
  });

  it.each([
    ['the creation code set on a reversal status', '{"error":"retry_conflict"}', 403],
    ['a reversal code on the creation status', '{"error":"unauthenticated"}', 400],
    ['an unknown code', '{"error":"stale"}', 409],
    ['an unlisted status', '{"error":"not_found"}', 200],
    ['an envelope with more than one key', '{"error":"forbidden","detail":"x"}', 403],
    ['a non JSON body', '<html>proxy</html>', 503],
  ])('rejects %s', (_, raw, status) => {
    expect(() => parseStockEntryReversalError(raw, status)).toThrow('Respuesta inválida del servidor.');
  });

  it('maps every reversal code to a clear Spanish message and names the stock cause', () => {
    for (const codes of stockEntryReversalAdmittedErrors.values()) {
      for (const code of codes) expect(stockEntryReversalErrorMessages[code]).toMatch(/[áéíóúñ¿]/i);
    }
    expect(stockEntryReversalErrorMessages.insufficient_stock).toContain('el stock');
    expect(stockEntryReversalErrorMessages.insufficient_stock).toContain('no alcanza');
    expect(stockEntryReversalErrorMessages.decision_conflict).toContain('contra-asiento');
    expect(stockEntryReversalErrorMessages.not_found).toContain('no existe');
    expect(stockEntryReversalErrorMessages.network).toContain('No se pudo conectar');
    for (const code of ['invalid_request', 'unauthenticated', 'forbidden', 'not_found', 'decision_conflict',
      'retry_conflict', 'insufficient_stock'] as const) {
      expect(stockEntryReversalFailureIsDefinite(code)).toBe(true);
    }
    for (const code of ['service_unavailable', 'invalid_response', 'network', 'aborted'] as const) {
      expect(stockEntryReversalFailureIsDefinite(code)).toBe(false);
    }
  });
});

describe('stock ingress detail contract', () => {
  const detailLine = (overrides: Record<string, unknown> = {}) => ({
    variant_id: 7, brand: 'TOYO', model: 'NS60L', capacity_ah: '45', polarity: 'L', quantity: 18, ...overrides });
  const detailJSON = (overrides: Record<string, unknown> = {}) => JSON.stringify({
    id: 6, location_id: 1, note: 'Remito 0002-00045871', created_at: '2026-11-04T14:20:00Z',
    created_by_account_id: 1, reverses_entry_id: null, reversed_by: null, reason: '',
    lines: [detailLine()], total_units: 18, ...overrides });

  it('builds the frozen detail path and admits only a canonical document id', () => {
    expect(stockEntryDetailPath(6)).toBe('/api/stock-entries/6');
    expect(stockEntryDetailPath(9007199254740991)).toBe('/api/stock-entries/9007199254740991');
    for (const id of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => stockEntryDetailPath(id)).toThrow('Detalle de ingreso inválido.');
    }
  });

  it('parses the exact units of one document with its catalogue identity', () => {
    const detail = parseStockEntryDetail(detailJSON({
      lines: [detailLine({ variant_id: 7, quantity: 3 }), detailLine({ variant_id: 9, quantity: 15 })],
      total_units: 18,
    }));
    expect(detail).toEqual({ id: 6, location_id: 1, note: 'Remito 0002-00045871',
      created_at: '2026-11-04T14:20:00Z', created_by_account_id: 1, reverses_entry_id: null,
      reversed_by: null, reason: '',
      lines: [
        { variant_id: 7, brand: 'TOYO', model: 'NS60L', capacity_ah: '45', polarity: 'L', quantity: 3 },
        { variant_id: 9, brand: 'TOYO', model: 'NS60L', capacity_ah: '45', polarity: 'L', quantity: 15 },
      ], total_units: 18 });
    expect(Object.isFrozen(detail)).toBe(true);
    expect(Object.isFrozen(detail.lines)).toBe(true);
    expect(Object.isFrozen(detail.lines[0])).toBe(true);
  });

  it('parses a reversed document and its counter-entry cross-references', () => {
    const reversed = parseStockEntryDetail(detailJSON({ reversed_by: 10 }));
    expect(reversed.reversed_by).toBe(10);
    expect(reversed.reverses_entry_id).toBeNull();
    const counter = parseStockEntryDetail(detailJSON({ id: 10, note: '', reverses_entry_id: 6,
      reason: 'error de carga', lines: [detailLine({ quantity: -18 })], total_units: -18 }));
    expect(counter).toMatchObject({ id: 10, reverses_entry_id: 6, reversed_by: null,
      reason: 'error de carga', note: '', total_units: -18 });
    expect(counter.lines.map(line => line.quantity)).toEqual([-18]);
  });

  it('keeps a fractional capacity as its exact decimal text', () => {
    expect(parseStockEntryDetail(detailJSON({ lines: [detailLine({ capacity_ah: '6.5' })] })).lines[0].capacity_ah).toBe('6.5');
  });

  it.each([
    ['an extra header field', detailJSON({ location_name: 'Almacén' })],
    ['a missing header field', JSON.stringify({ id: 6, location_id: 1, note: '', created_at: '2026-11-04T14:20:00Z',
      created_by_account_id: 1, reverses_entry_id: null, reason: '', lines: [detailLine()], total_units: 18 })],
    ['a zero document id', detailJSON({ id: 0 })],
    ['an unsafe document id', detailJSON({ id: 9007199254740992 })],
    ['a document of another location', detailJSON({ location_id: 2 })],
    ['a note with NUL', detailJSON({ note: 'a\u0000b' })],
    ['a note over 500 characters', detailJSON({ note: 'n'.repeat(501) })],
    ['an impossible date', detailJSON({ created_at: '2026-02-31T00:00:00Z' })],
    ['an unknown actor', detailJSON({ created_by_account_id: 0 })],
    ['an extra line field', detailJSON({ lines: [detailLine({ catalog_entry_id: 2 })] })],
    ['a missing line field', detailJSON({ lines: [{ variant_id: 7, brand: 'TOYO', model: 'NS60L', capacity_ah: '45', quantity: 18 }] })],
    ['a numeric capacity', detailJSON({ lines: [detailLine({ capacity_ah: 45 })] })],
    ['a padded capacity', detailJSON({ lines: [detailLine({ capacity_ah: '045' })] })],
    ['a capacity with trailing zeros', detailJSON({ lines: [detailLine({ capacity_ah: '45.000' })] })],
    ['a zero capacity', detailJSON({ lines: [detailLine({ capacity_ah: '0' })] })],
    ['an empty brand', detailJSON({ lines: [detailLine({ brand: '' })] })],
    ['an unknown polarity', detailJSON({ lines: [detailLine({ polarity: 'X' })] })],
    ['a zero quantity', detailJSON({ lines: [detailLine({ quantity: 0 })] })],
    ['a fractional quantity', detailJSON({ lines: [detailLine({ quantity: 1.5 })] })],
    ['an exponent quantity', '{"id":6,"location_id":1,"note":"","created_at":"2026-11-04T14:20:00Z","created_by_account_id":1,"reverses_entry_id":null,"reversed_by":null,"reason":"","lines":[{"variant_id":7,"brand":"TOYO","model":"NS60L","capacity_ah":"45","polarity":"L","quantity":1e3}],"total_units":1000}'],
    ['a quantity above one document line', detailJSON({ lines: [detailLine({ quantity: 1000001 })], total_units: 1000001 })],
    ['a negative line on an ingress document', detailJSON({ lines: [detailLine({ quantity: -18 })], total_units: -18 })],
    ['lines out of order', detailJSON({ lines: [detailLine({ variant_id: 9 }), detailLine({ variant_id: 7 })], total_units: 36 })],
    ['a repeated line', detailJSON({ lines: [detailLine(), detailLine()], total_units: 36 })],
    ['no lines', detailJSON({ lines: [], total_units: 0 })],
    ['a total that does not add up', detailJSON({ total_units: 19 })],
    ['a counter-entry without a motive', detailJSON({ reverses_entry_id: 5, note: '', lines: [detailLine({ quantity: -18 })], total_units: -18 })],
    ['an original document with a motive', detailJSON({ reason: 'error de carga' })],
    ['a padded motive', detailJSON({ reverses_entry_id: 5, note: '', reason: ' error de carga ',
      lines: [detailLine({ quantity: -18 })], total_units: -18 })],
    ['a motive over 500 characters', detailJSON({ reverses_entry_id: 5, note: '', reason: 'ñ'.repeat(501),
      lines: [detailLine({ quantity: -18 })], total_units: -18 })],
    ['a counter-entry of itself', detailJSON({ id: 6, reverses_entry_id: 6, note: '', lines: [detailLine({ quantity: -18 })], total_units: -18 })],
    ['a counter-entry of a later document', detailJSON({ reverses_entry_id: 9, note: '', lines: [detailLine({ quantity: -18 })], total_units: -18 })],
    ['a reverse entry id of zero', detailJSON({ reverses_entry_id: 0 })],
    ['a positive line on a counter-entry', detailJSON({ reverses_entry_id: 5, note: '', reason: 'error de carga', lines: [detailLine({ quantity: 18 })] })],
    ['a reversal of itself', detailJSON({ reversed_by: 6 })],
    ['a reversal of an earlier document', detailJSON({ reversed_by: 5 })],
    ['a zero reversal id', detailJSON({ reversed_by: 0 })],
    ['a duplicated JSON key', '{"id":6,"id":7,"location_id":1,"note":"","created_at":"2026-11-04T14:20:00Z","created_by_account_id":1,"reverses_entry_id":null,"reversed_by":null,"reason":"","lines":[{"variant_id":7,"brand":"TOYO","model":"NS60L","capacity_ah":"45","polarity":"L","quantity":18}],"total_units":18}'],
    ['a non JSON body', '<html>proxy</html>'],
  ])('rejects %s', (_, raw) => {
    expect(() => parseStockEntryDetail(raw)).toThrow('Respuesta inválida del servidor.');
  });

  it('admits only the exact detail error code for each status', () => {
    expect(parseStockEntryDetailError('{"error":"invalid_request"}', 400)).toBe('invalid_request');
    expect(parseStockEntryDetailError('{"error":"unauthenticated"}', 401)).toBe('unauthenticated');
    expect(parseStockEntryDetailError('{"error":"forbidden"}', 403)).toBe('forbidden');
    expect(parseStockEntryDetailError('{"error":"not_found"}', 404)).toBe('not_found');
    expect(parseStockEntryDetailError('{"error":"service_unavailable"}', 503)).toBe('service_unavailable');
  });

  it.each([
    ['the reversal code set on a detail status', '{"error":"decision_conflict"}', 409],
    ['a known code on the wrong status', '{"error":"not_found"}', 403],
    ['an unlisted status', '{"error":"not_found"}', 409],
    ['an envelope with more than one key', '{"error":"forbidden","detail":"x"}', 403],
    ['a non JSON body', '<html>proxy</html>', 503],
  ])('rejects %s', (_, raw, status) => {
    expect(() => parseStockEntryDetailError(raw, status)).toThrow('Respuesta inválida del servidor.');
  });

  it('maps every detail failure to a Spanish message', () => {
    for (const codes of stockEntryDetailAdmittedErrors.values()) {
      for (const code of codes) expect(stockEntryDetailErrorMessages[code]).toMatch(/[áéíóúñ¿]/i);
    }
    expect(stockEntryDetailErrorMessages.not_found).toContain('no existe');
    expect(stockEntryDetailErrorMessages.network).toContain('No se pudo conectar');
    expect(stockEntryDetailErrorMessages.aborted).toContain('Se interrumpió');
  });
});
