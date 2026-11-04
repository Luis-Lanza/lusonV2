import { describe, expect, it } from 'vitest';
import {
  canonicalStockEntryInput, matchesStockEntryInput, newStockEntryOperationKey, parseStockCatalog, parseStockEntryError,
  parseStockEntryHistory, parseStockEntryRecord, stockCatalogPath, stockEntryAdmittedErrors, stockEntryErrorMessages,
  stockEntryFailureIsDefinite, stockEntryHistoryPath, stockEntryHistoryPageSizes, validStockEntryHistoryQuery,
  validStockQuantity, type StockEntryInput,
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
