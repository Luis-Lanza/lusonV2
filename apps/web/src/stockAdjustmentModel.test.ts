import { describe, expect, it } from 'vitest';
import {
  canonicalStockAdjustmentInput, canonicalStockAdjustmentReason, canonicalStockAdjustmentReversalInput,
  matchesStockAdjustmentInput, matchesStockAdjustmentReversal, newStockAdjustmentOperationKey,
  parseStockAdjustmentApplyError, parseStockAdjustmentCatalog, parseStockAdjustmentDetail, parseStockAdjustmentHistory,
  parseStockAdjustmentDetailError, parseStockAdjustmentHistoryError, parseStockAdjustmentRecord,
  parseStockAdjustmentReversalError, parseStockAdjustmentCatalogError,
  parseStockAdjustmentReversalRecord, stockAdjustmentApplyMessages, stockAdjustmentCatalogPath,
  stockAdjustmentDetailPath, stockAdjustmentFailureIsDefinite, stockAdjustmentHistoryPath,
  stockAdjustmentMaxCounted, stockAdjustmentMaxLines, stockAdjustmentMotives, stockAdjustmentReadMessages,
  stockAdjustmentReversalMessages, stockAdjustmentReversalPath, stockAdjustmentReversible,
  validStockAdjustmentCounted, validStockAdjustmentHistoryQuery,
  type StockAdjustmentInput, type StockAdjustmentSummary,
} from './stockAdjustmentModel';

const key = 'warehouse_adjustment_key_01';
const motive = 'Conteo físico periódico';

const draft = (overrides: Partial<StockAdjustmentInput> = {}): StockAdjustmentInput => ({
  operation_key: key, reason: motive,
  lines: [{ variant_id: 9, counted_quantity: 12 }, { variant_id: 4, counted_quantity: 0 }],
  ...overrides,
});
const summaryRow = (overrides: Record<string, unknown> = {}) => ({
  id: 6, reason: motive, detail: '', created_at: '2026-11-04T14:20:00Z',
  lines: 2, total_difference: -4, reverses_adjustment_id: null, reversed_by: null, ...overrides,
});
const historyBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  page: 1, page_size: 25, total_adjustments: 1, adjustments: [summaryRow()], ...overrides,
});
const detailLine = (overrides: Record<string, unknown> = {}) => ({
  variant_id: 7, catalog_entry_id: 4, brand: 'TOYO', model: 'NS60L', capacity_ah: '45', polarity: 'L',
  expected_quantity: 18, counted_quantity: 12, difference: -6, ...overrides,
});
const detailBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  id: 6, location_id: 1, reason: motive, detail: 'pasillo 2', created_at: '2026-11-04T14:20:00Z',
  created_by_account_id: 1, reverses_adjustment_id: null, reversed_by: null, reversed_by_reason: '',
  lines: [detailLine()], total_difference: -6, ...overrides,
});
const recordBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  id: 7, location_id: 1, reason: motive, detail: '', created_by_account_id: 1,
  created_at: '2026-11-04T14:20:00Z', reverses_adjustment_id: null,
  lines: [{ variant_id: 4, expected_quantity: 18, counted_quantity: 0, difference: -18 },
    { variant_id: 9, expected_quantity: 9, counted_quantity: 12, difference: 3 }],
  total_difference: -15, ...overrides,
});
const catalogItem = (overrides: Record<string, unknown> = {}) => ({
  variant_id: 4, catalog_entry_id: 1, brand: 'TOYO', model: 'NS40ZL', capacity_ah: '35', polarity: 'L', ...overrides,
});
const catalogBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  page: 1, page_size: 25, total_variants: 1, items: [catalogItem()], ...overrides,
});

describe('blind capture payload', () => {
  it('sends only the variant and the counted quantity of every line', () => {
    const prepared = canonicalStockAdjustmentInput(draft());
    const sent = JSON.parse(JSON.stringify(prepared)) as Record<string, unknown>;
    expect(Object.keys(sent)).toEqual(['operation_key', 'reason', 'lines']);
    const lines = sent.lines as Record<string, number>[];
    expect(lines.map(line => Object.keys(line))).toEqual([['variant_id', 'counted_quantity'], ['variant_id', 'counted_quantity']]);
    // No expected snapshot, no difference and no stock field can leave the capture.
    expect(sent).not.toHaveProperty('detail');
    expect(JSON.stringify(sent)).not.toMatch(/expected|difference|stock|existing|reserved/);
    // Lines are ordered by variant so the same draft is always the same payload.
    expect(prepared.lines).toEqual([{ variant_id: 4, counted_quantity: 0 }, { variant_id: 9, counted_quantity: 12 }]);
    expect(prepared.reason).toBe(motive);
  });

  it('normalizes the mandatory motive and admits a counted zero', () => {
    const prepared = canonicalStockAdjustmentInput(draft({ reason: `  ${motive}  `,
      lines: [{ variant_id: 4, counted_quantity: 0 }] }));
    expect(prepared.reason).toBe(motive);
    expect(prepared.lines).toEqual([{ variant_id: 4, counted_quantity: 0 }]);
    expect(validStockAdjustmentCounted(0)).toBe(true);
    expect(validStockAdjustmentCounted(stockAdjustmentMaxCounted)).toBe(true);
    expect(validStockAdjustmentCounted(stockAdjustmentMaxCounted + 1)).toBe(false);
    expect(validStockAdjustmentCounted(-1)).toBe(false);
    expect(validStockAdjustmentCounted(1.5)).toBe(false);
  });

  it.each([
    ['no lines', draft({ lines: [] })],
    ['a duplicate variant', draft({ lines: [{ variant_id: 4, counted_quantity: 1 }, { variant_id: 4, counted_quantity: 2 }] })],
    ['a negative count', draft({ lines: [{ variant_id: 4, counted_quantity: -1 }] })],
    ['a fractional count', draft({ lines: [{ variant_id: 4, counted_quantity: 1.5 }] })],
    ['a blank motive', draft({ reason: '   ' })],
    ['a short operation key', draft({ operation_key: 'short' })],
    ['more lines than a document admits', draft({ lines: Array.from({ length: stockAdjustmentMaxLines + 1 }, (_, index) => ({ variant_id: index + 1, counted_quantity: 1 })) })],
  ])('refuses %s', (_, input) => {
    expect(() => canonicalStockAdjustmentInput(input)).toThrow('Documento de ajuste inválido.');
  });

  it.each([
    ['an expected quantity', { operation_key: key, reason: motive, lines: [{ variant_id: 4, counted_quantity: 1, expected_quantity: 9 }] }],
    ['a difference', { operation_key: key, reason: motive, lines: [{ variant_id: 4, counted_quantity: 1, difference: 2 }] }],
    ['a location', { operation_key: key, reason: motive, location_id: 1, lines: [{ variant_id: 4, counted_quantity: 1 }] }],
  ])('refuses a line carrying %s', (_, input) => {
    expect(() => canonicalStockAdjustmentInput(input as unknown as StockAdjustmentInput))
      .toThrow('Documento de ajuste inválido.');
  });

  it('generates a secure operation key and a canonical reversal payload', () => {
    expect(newStockAdjustmentOperationKey()).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(canonicalStockAdjustmentReversalInput({ operation_key: key, reason: ` ${motive} ` }))
      .toEqual({ operation_key: key, reason: motive });
    expect(() => canonicalStockAdjustmentReversalInput({ operation_key: key, reason: '  ' }))
      .toThrow('Contra-asiento inválido.');
    expect(() => canonicalStockAdjustmentReversalInput({ operation_key: key, reason: motive, lines: [] } as unknown as { operation_key: string; reason: string }))
      .toThrow('Contra-asiento inválido.');
    expect(canonicalStockAdjustmentReason(`\t${motive}\n`)).toBe(motive);
  });

  it('offers exactly the four motives the operators see', () => {
    expect(stockAdjustmentMotives).toEqual([
      'Conteo físico periódico', 'Merma o rotura', 'Diferencia detectada en preparación', 'Otro',
    ]);
  });
});

describe('adjustment document parsing', () => {
  it('parses the created document with its persisted expected and derived difference', () => {
    const record = parseStockAdjustmentRecord(recordBody());
    expect(record).toMatchObject({ id: 7, location_id: 1, reason: motive, detail: '', total_difference: -15,
      reverses_adjustment_id: null });
    expect(record.lines).toEqual([
      { variant_id: 4, expected_quantity: 18, counted_quantity: 0, difference: -18 },
      { variant_id: 9, expected_quantity: 9, counted_quantity: 12, difference: 3 },
    ]);
  });

  it('refuses a creation reply that is a counter-entry and a counter-entry reply that is not', () => {
    expect(() => parseStockAdjustmentRecord(recordBody({ reverses_adjustment_id: 3 }))).toThrow('Respuesta inválida');
    expect(() => parseStockAdjustmentReversalRecord(recordBody())).toThrow('Respuesta inválida');
    expect(parseStockAdjustmentReversalRecord(recordBody({ id: 8, reverses_adjustment_id: 7 })))
      .toMatchObject({ id: 8, reverses_adjustment_id: 7 });
  });

  it.each([
    ['an unknown line field', recordBody({ lines: [{ variant_id: 4, expected_quantity: 1, counted_quantity: 0, difference: -1, stock: 3 }] })],
    ['a difference that is not counted minus expected', recordBody({ lines: [{ variant_id: 4, expected_quantity: 18, counted_quantity: 0, difference: -17 }] })],
    ['a total that is not the sum of the lines', recordBody({ total_difference: 0 })],
    ['lines out of variant order', recordBody({ lines: [{ variant_id: 9, expected_quantity: 9, counted_quantity: 12, difference: 3 }, { variant_id: 4, expected_quantity: 18, counted_quantity: 0, difference: -18 }] })],
    ['another warehouse', recordBody({ location_id: 2 })],
    ['a blank motive', recordBody({ reason: '   ' })],
    ['a duplicated key', '{"id":7,"id":8}'],
    ['a document without lines', recordBody({ lines: [] })],
  ])('refuses %s', (_, raw) => {
    expect(() => parseStockAdjustmentRecord(raw)).toThrow('Respuesta inválida del servidor.');
  });

  it('parses the newest-first history with the reversal cross-references', () => {
    const page = parseStockAdjustmentHistory(historyBody({ page_size: 25, total_adjustments: 3, adjustments: [
      summaryRow({ id: 8, reason: 'Contra-asiento', total_difference: 4, reverses_adjustment_id: 6 }),
      summaryRow({ id: 6, total_difference: -4, reversed_by: 8 }),
      summaryRow({ id: 5, lines: 1, total_difference: 0, detail: 'pasillo 2' }),
    ] }));
    expect(page).toMatchObject({ page: 1, page_size: 25, total_adjustments: 3 });
    expect(page.adjustments.map(row => [row.id, row.total_difference, row.reverses_adjustment_id, row.reversed_by]))
      .toEqual([[8, 4, 6, null], [6, -4, null, 8], [5, 0, null, null]]);
    expect(page.adjustments[2].detail).toBe('pasillo 2');
  });

  it.each([
    ['rows that are not newest first', historyBody({ adjustments: [summaryRow({ id: 5 }), summaryRow({ id: 6 })] })],
    ['a page that does not fit its total', historyBody({ page: 4, total_adjustments: 2 })],
    ['an unadmitted page size', historyBody({ page_size: 15 })],
    ['a row with a foreign field', historyBody({ adjustments: [summaryRow({ expected_quantity: 3 })] })],
    ['a counter-entry that is not later than its target', historyBody({ adjustments: [summaryRow({ reverses_adjustment_id: 6 })] })],
    ['a reversal reference that is not later either', historyBody({ adjustments: [summaryRow({ reversed_by: 6 })] })],
  ])('refuses a history with %s', (_, raw) => {
    expect(() => parseStockAdjustmentHistory(raw)).toThrow('Respuesta inválida del servidor.');
  });

  it('parses one detail with the catalogue identity and the applied arithmetic', () => {
    const detail = parseStockAdjustmentDetail(detailBody({ lines: [
      detailLine({ variant_id: 4, brand: 'CAR', model: 'NS40ZL', capacity_ah: '35', expected_quantity: 9, counted_quantity: 5, difference: -4 }),
      detailLine(),
    ], total_difference: -10 }));
    expect(detail).toMatchObject({ id: 6, reason: motive, detail: 'pasillo 2', total_difference: -10 });
    expect(detail.lines).toEqual([
      { variant_id: 4, catalog_entry_id: 4, brand: 'CAR', model: 'NS40ZL', capacity_ah: '35', polarity: 'L',
        expected_quantity: 9, counted_quantity: 5, difference: -4 },
      { variant_id: 7, catalog_entry_id: 4, brand: 'TOYO', model: 'NS60L', capacity_ah: '45', polarity: 'L',
        expected_quantity: 18, counted_quantity: 12, difference: -6 },
    ]);
  });

  it('keeps both directions of the reversal cross-reference in the detail', () => {
    const counter = parseStockAdjustmentDetail(detailBody({ id: 8, reverses_adjustment_id: 6, reason: 'Otro',
      lines: [detailLine({ expected_quantity: 12, counted_quantity: 18, difference: 6 })], total_difference: 6 }));
    expect(counter.reverses_adjustment_id).toBe(6);
    expect(counter.reversed_by).toBeNull();
    // A counter-entry states its own motive, never the motive of a counter-entry.
    expect(counter.reversed_by_reason).toBe('');
    const reversed = parseStockAdjustmentDetail(detailBody({ reversed_by: 8, reversed_by_reason: 'error de conteo' }));
    expect(reversed.reversed_by).toBe(8);
    expect(reversed.reverses_adjustment_id).toBeNull();
    // The counter-entry's own motive travels with the cross-reference.
    expect(reversed.reversed_by_reason).toBe('error de conteo');
  });

  it.each([
    ['an expected quantity that contradicts the difference', detailBody({ lines: [detailLine({ expected_quantity: 18, counted_quantity: 12, difference: 6 })] })],
    ['a padded capacity', detailBody({ lines: [detailLine({ capacity_ah: '45.0' })] })],
    ['a foreign polarity', detailBody({ lines: [detailLine({ polarity: 'X' })] })],
    ['an unknown field', detailBody({ operation_key: key })],
    ['a self reference', detailBody({ reverses_adjustment_id: 6 })],
    ['a foreign document location', detailBody({ location_id: 2 })],
    ['an empty motive', detailBody({ reason: '' })],
    // The counter-entry motive is present exactly when the document is reversed.
    ['a reversed document without a counter-entry motive', detailBody({ reversed_by: 8 })],
    ['a counter-entry motive without a counter-entry', detailBody({ reversed_by_reason: 'error de conteo' })],
    ['a wrong-typed counter-entry motive', detailBody({ reversed_by: 8, reversed_by_reason: 8 })],
    ['a blank counter-entry motive', detailBody({ reversed_by: 8, reversed_by_reason: '   ' })],
    ['an unbounded counter-entry motive', detailBody({ reversed_by: 8, reversed_by_reason: 'x'.repeat(501) })],
  ])('refuses a detail with %s', (_, raw) => {
    expect(() => parseStockAdjustmentDetail(raw)).toThrow('Respuesta inválida del servidor.');
  });
});

describe('blind capture catalogue parsing', () => {
  it('parses the catalogue identity and nothing else', () => {
    const page = parseStockAdjustmentCatalog(catalogBody({ total_variants: 2, items: [
      catalogItem(), catalogItem({ variant_id: 9, catalog_entry_id: 2, brand: 'VOLTA', model: 'NS60L', capacity_ah: '45', polarity: 'R' }),
    ] }));
    expect(page).toMatchObject({ page: 1, page_size: 25, total_variants: 2 });
    expect(page.items[1]).toEqual({ variant_id: 9, catalog_entry_id: 2, brand: 'VOLTA', model: 'NS60L',
      capacity_ah: '45', polarity: 'R' });
    // The capture payload never carries a stock figure the operator is meant to count.
    expect(Object.keys(page.items[0])).toEqual(['variant_id', 'catalog_entry_id', 'brand', 'model', 'capacity_ah', 'polarity']);
  });

  it.each([
    ['a stock quantity in the item', catalogBody({ items: [{ ...catalogItem(), existing: 14 }] })],
    ['a reserved quantity in the item', catalogBody({ items: [{ ...catalogItem(), reserved: 0 }] })],
    ['an unadmitted page size', catalogBody({ page_size: 20 })],
    ['an item without a brand', catalogBody({ items: [{ variant_id: 4, catalog_entry_id: 1, model: 'NS40ZL', capacity_ah: '35', polarity: 'L' }] })],
  ])('refuses a catalogue with %s', (_, raw) => {
    expect(() => parseStockAdjustmentCatalog(raw)).toThrow('Respuesta inválida del servidor.');
  });
});

describe('adjustment evidence and paths', () => {
  const applied = summaryRow() as StockAdjustmentSummary;

  it('accepts only a reply that repeats the exact counted document', () => {
    const record = parseStockAdjustmentRecord(recordBody());
    expect(matchesStockAdjustmentInput({ operation_key: key, reason: motive,
      lines: [{ variant_id: 9, counted_quantity: 12 }, { variant_id: 4, counted_quantity: 0 }] }, record)).toBe(true);
    expect(matchesStockAdjustmentInput({ operation_key: key, reason: motive,
      lines: [{ variant_id: 9, counted_quantity: 11 }, { variant_id: 4, counted_quantity: 0 }] }, record)).toBe(false);
    expect(matchesStockAdjustmentInput({ operation_key: key, reason: 'Otro',
      lines: [{ variant_id: 9, counted_quantity: 12 }, { variant_id: 4, counted_quantity: 0 }] }, record)).toBe(false);
    // A counter-entry is never evidence of an applied count.
    expect(matchesStockAdjustmentInput({ operation_key: key, reason: motive,
      lines: [{ variant_id: 9, counted_quantity: 12 }, { variant_id: 4, counted_quantity: 0 }] },
    parseStockAdjustmentReversalRecord(recordBody({ id: 9, reverses_adjustment_id: 7 })))).toBe(false);
  });

  it('accepts only a counter-entry that mirrors the listed document', () => {
    const original = { ...applied, lines: 2, total_difference: -4 } as StockAdjustmentSummary;
    const mirror = parseStockAdjustmentReversalRecord(recordBody({ id: 9, reverses_adjustment_id: 6,
      lines: [{ variant_id: 4, expected_quantity: 0, counted_quantity: 18, difference: 18 },
        { variant_id: 9, expected_quantity: 12, counted_quantity: 9, difference: -3 }],
      total_difference: 15 }));
    expect(matchesStockAdjustmentReversal({ ...original, total_difference: -15 }, mirror)).toBe(true);
    expect(matchesStockAdjustmentReversal(original, mirror)).toBe(false);
    expect(matchesStockAdjustmentReversal({ ...original, lines: 3, total_difference: -15 }, mirror)).toBe(false);
  });

  it('decides which documents may be corrected', () => {
    expect(stockAdjustmentReversible(applied)).toBe(true);
    expect(stockAdjustmentReversible({ ...applied, total_difference: 0 })).toBe(true);
    expect(stockAdjustmentReversible({ ...applied, reversed_by: 8 })).toBe(false);
    expect(stockAdjustmentReversible({ ...applied, reverses_adjustment_id: 3 })).toBe(false);
  });

  it('builds only the frozen paths, and omits an empty search entirely', () => {
    expect(stockAdjustmentHistoryPath(2, 50)).toBe('/api/stock-adjustments?page=2&page_size=50');
    expect(stockAdjustmentCatalogPath('')).toBe('/api/stock-adjustments/catalog?page=1&page_size=25');
    expect(stockAdjustmentCatalogPath('NS40ZL')).toBe('/api/stock-adjustments/catalog?page=1&page_size=25&search=NS40ZL');
    expect(stockAdjustmentCatalogPath('45 Ah')).toBe('/api/stock-adjustments/catalog?page=1&page_size=25&search=45+Ah');
    expect(stockAdjustmentDetailPath(6)).toBe('/api/stock-adjustments/6');
    expect(stockAdjustmentReversalPath(6)).toBe('/api/stock-adjustments/6/reverse');
    expect(validStockAdjustmentHistoryQuery(1, 25)).toBe(true);
    expect(validStockAdjustmentHistoryQuery(0, 25)).toBe(false);
    expect(validStockAdjustmentHistoryQuery(1, 15)).toBe(false);
    expect(() => stockAdjustmentDetailPath(0)).toThrow('Detalle de ajuste inválido.');
    expect(() => stockAdjustmentReversalPath(1.5)).toThrow('Contra-asiento inválido.');
    expect(() => stockAdjustmentCatalogPath('x'.repeat(129))).toThrow('Documento de ajuste inválido.');
  });
});

describe('per-endpoint error mapping', () => {
  it.each([[400, 'invalid_request'], [401, 'unauthenticated'], [403, 'forbidden'],
    [409, 'retry_conflict'], [409, 'insufficient_stock'], [503, 'service_unavailable']] as const)(
  'maps %s %s for the applied document', (status, code) => {
    expect(parseStockAdjustmentApplyError(`{"error":"${code}"}`, status)).toBe(code);
  });

  it.each([[400, 'invalid_request'], [401, 'unauthenticated'], [403, 'forbidden'],
    [409, 'retry_conflict'], [409, 'insufficient_stock'], [503, 'service_unavailable']] as const)(
  'maps %s %s for the counter-entry', (status, code) => {
    expect(parseStockAdjustmentReversalError(`{"error":"${code}"}`, status)).toBe(code);
  });

  it.each([[400, 'invalid_request'], [401, 'unauthenticated'], [403, 'forbidden'],
    [404, 'not_found'], [409, 'decision_conflict'], [503, 'service_unavailable']] as const)(
  'maps %s %s for the counter-entry target', (status, code) => {
    expect(parseStockAdjustmentReversalError(`{"error":"${code}"}`, status)).toBe(code);
  });

  it.each([[400, 'invalid_request'], [401, 'unauthenticated'], [403, 'forbidden'],
    [404, 'not_found'], [503, 'service_unavailable']] as const)(
  'maps %s %s for the document detail', (status, code) => {
    expect(parseStockAdjustmentDetailError(`{"error":"${code}"}`, status)).toBe(code);
  });

  it.each([[400, 'invalid_request'], [401, 'unauthenticated'], [403, 'forbidden'], [503, 'service_unavailable']] as const)(
  'maps %s %s for the history and the blind catalogue', (status, code) => {
    expect(parseStockAdjustmentHistoryError(`{"error":"${code}"}`, status)).toBe(code);
    expect(parseStockAdjustmentCatalogError(`{"error":"${code}"}`, status)).toBe(code);
  });

  it('refuses a not_found envelope on a route that has no document id', () => {
    expect(() => parseStockAdjustmentHistoryError('{"error":"not_found"}', 404)).toThrow('Respuesta inválida del servidor.');
    expect(() => parseStockAdjustmentCatalogError('{"error":"not_found"}', 404)).toThrow('Respuesta inválida del servidor.');
  });

  it.each([
    ['a certificate code the status does not admit', '{"error":"retry_conflict"}', 403],
    ['a decision conflict on an apply', '{"error":"decision_conflict"}', 409],
    ['an error envelope with extra keys', '{"error":"forbidden","detail":"x"}', 403],
    ['an unlisted status', '{"error":"invalid_request"}', 500],
    ['a non JSON body', 'proxy down', 503],
  ])('refuses to interpret %s', (_, raw, status) => {
    expect(() => parseStockAdjustmentApplyError(raw, status)).toThrow('Respuesta inválida del servidor.');
    expect(() => parseStockAdjustmentDetailError(raw, status)).toThrow('Respuesta inválida del servidor.');
  });

  it('gives every failure its own honest message', () => {
    expect(stockAdjustmentApplyMessages.retry_conflict).not.toBe(stockAdjustmentApplyMessages.insufficient_stock);
    expect(stockAdjustmentApplyMessages.insufficient_stock).toMatch(/reservado/);
    expect(stockAdjustmentApplyMessages.forbidden).toMatch(/permiso/);
    expect(stockAdjustmentApplyMessages.invalid_request).toMatch(/no es válido/);
    expect(stockAdjustmentApplyMessages.service_unavailable).toMatch(/no está disponible/);
    expect(stockAdjustmentReversalMessages.decision_conflict).toMatch(/contra-asiento/);
    expect(stockAdjustmentReversalMessages.not_found).toMatch(/ya no existe/);
    expect(stockAdjustmentReadMessages.not_found).toMatch(/ya no existe/);
    const codes = ['invalid_request', 'unauthenticated', 'forbidden', 'not_found', 'decision_conflict',
      'retry_conflict', 'insufficient_stock', 'service_unavailable', 'invalid_response', 'network', 'aborted'] as const;
    for (const table of [stockAdjustmentApplyMessages, stockAdjustmentReversalMessages, stockAdjustmentReadMessages]) {
      const seen = codes.filter(code => code in table).map(code => table[code]);
      expect(new Set(seen).size).toBe(seen.length);
    }
  });

  it('knows which rejections prove that nothing was written', () => {
    expect(stockAdjustmentFailureIsDefinite('invalid_request')).toBe(true);
    expect(stockAdjustmentFailureIsDefinite('forbidden')).toBe(true);
    expect(stockAdjustmentFailureIsDefinite('retry_conflict')).toBe(true);
    expect(stockAdjustmentFailureIsDefinite('insufficient_stock')).toBe(true);
    expect(stockAdjustmentFailureIsDefinite('service_unavailable')).toBe(false);
    expect(stockAdjustmentFailureIsDefinite('network')).toBe(false);
    expect(stockAdjustmentFailureIsDefinite('aborted')).toBe(false);
    expect(stockAdjustmentFailureIsDefinite('invalid_response')).toBe(false);
  });
});
