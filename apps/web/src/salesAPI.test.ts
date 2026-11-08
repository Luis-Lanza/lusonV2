import { describe, expect, it, vi } from 'vitest';
import {
  SalesAPIError, createSalesAPI, matchesCreateSale, parseCreatedSale, parseSaleDetail, parseSalePage,
  parseSalesError, parseSellablePage, saleDetailPath, salesErrorMessages, salesHistoryPath, sellablePath,
  validSalesQuery, validSellableQuery, warrantyPath,
} from './salesAPI';
import { moneyCents, type CreateSaleInput } from './pointOfSaleModel';

const csrf = 'c'.repeat(43);

const json = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
const mockFetch = () => vi.fn<typeof fetch>();

const sellableItem = (overrides: Record<string, unknown> = {}) => ({
  variant_id: 1, catalog_entry_id: 1, brand: 'CAR', model: 'NS40ZL', capacity_ah: '35', polarity: 'L',
  sellable: true, existing: 12, reserved: 0, available: 12,
  suggested_price: '96000.00', min_price: '85000.00', ...overrides,
});
const sellableBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  page: 1, page_size: 25, total_variants: 190, items: [sellableItem()], ...overrides,
});
const saleBody = (overrides: Record<string, unknown> = {}) => ({
  id: 1, branch_location_id: 2, branch_sequence: 126, warranty_number: '2-000126',
  payment_method: 'mixed',
  payments: [{ method: 'cash', amount: '200000.00' }, { method: 'transfer', amount: '104000.00' }],
  customer: { name: 'Marta Giménez', phone: '381 555 0198', document: '27.884.310', address: 'Av. América 123' },
  total: '304000.00', created_by_account_id: 2, created_at: '2026-11-04T17:42:00Z',
  lines: [
    { variant_id: 1, quantity: 2, unit_price: '96000.00', min_price: '85000.00', subtotal: '192000.00',
      units: [{ serial_number: 'ABC123', warranty_months: 12 }, { serial_number: 'ABC124', warranty_months: null }] },
    { variant_id: 3, quantity: 1, unit_price: '112000.00', min_price: '100000.00', subtotal: '112000.00',
      units: [{ serial_number: 'TOYO-9', warranty_months: 12 }] },
  ],
  ...overrides,
});
const createdBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({ sale: saleBody(overrides) });
const summary = (overrides: Record<string, unknown> = {}) => ({
  id: 1, branch_sequence: 126, warranty_number: '2-000126', payment_method: 'mixed',
  customer_name: 'Marta Giménez', total: '304000.00', created_at: '2026-11-04T17:42:00Z', lines: 2,
  units_total: 3, units_with_warranty: 2, ...overrides,
});
const pageBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  page: 1, page_size: 10, total_sales: 87, sales: [summary()], ...overrides,
});
const detailBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  id: 1, branch_sequence: 126, warranty_number: '2-000126', payment_method: 'cash',
  payments: [{ method: 'cash', amount: '192000.00' }],
  customer_name: 'Marta Giménez',
  customer: { name: 'Marta Giménez', phone: '381 555 0198', document: '27.884.310', address: 'Av. América 123' },
  total: '192000.00', created_at: '2026-11-04T17:42:00Z',
  lines: [{
    variant_id: 1, catalog_entry_id: 1, brand: 'CAR', model: 'NS40ZL', capacity_ah: '35', polarity: 'L',
    quantity: 2, unit_price: '96000.00', min_price: '85000.00', subtotal: '192000.00',
    units: [{ serial_number: 'ABC123', warranty_months: 12 }, { serial_number: 'ABC124', warranty_months: null }],
  }],
  ...overrides,
});
const input = (): CreateSaleInput => ({
  payments: [{ method: 'cash', amount: '200000.00' }, { method: 'transfer', amount: '104000.00' }],
  customer: { name: 'Marta Giménez', phone: '381 555 0198', document: '27.884.310', address: 'Av. América 123' },
  lines: [
    { variant_id: 1, quantity: 2, unit_price: '96000.00',
      units: [{ serial_number: 'ABC123', warranty_months: 12 }, { serial_number: 'ABC124', warranty_months: null }] },
    { variant_id: 3, quantity: 1, unit_price: '112000.00', units: [{ serial_number: 'TOYO-9', warranty_months: 12 }] },
  ],
});

describe('the read paths of the counter', () => {
  it('omits the filters the operator left blank and always sends page and size', () => {
    expect(sellablePath({ search: '', brand: '', capacity: '', polarity: '', page: 1, page_size: 25 }))
      .toBe('/api/sales/sellable?page=1&page_size=25');
    expect(sellablePath({ search: 'NS40', brand: 'CAR', capacity: '35', polarity: 'L', page: 2, page_size: 10 }))
      .toBe('/api/sales/sellable?search=NS40&brand=CAR&capacity=35&polarity=L&page=2&page_size=10');
  });

  it('keeps the history filters and the mixed label in the query', () => {
    expect(salesHistoryPath({ search: '', payment_method: '', page: 1, page_size: 10 }))
      .toBe('/api/sales?page=1&page_size=10');
    expect(salesHistoryPath({ search: '2-00012', payment_method: 'mixed', page: 3, page_size: 50 }))
      .toBe('/api/sales?search=2-00012&payment_method=mixed&page=3&page_size=50');
  });

  it('addresses one document and its warranty', () => {
    expect(saleDetailPath(7)).toBe('/api/sales/7');
    expect(warrantyPath(7)).toBe('/api/sales/7/warranty.pdf');
    expect(() => saleDetailPath(0)).toThrow();
    expect(() => warrantyPath(1.5)).toThrow();
  });

  it.each([
    ['a page below one', { page: 0, page_size: 10 }],
    ['a page past the limit', { page: 1_000_001, page_size: 10 }],
    ['a page size outside the contract', { page: 1, page_size: 20 }],
    ['a search with NUL', { search: 'a\0b' }],
    ['an oversized search', { search: 'x'.repeat(129) }],
    ['a capacity that is not a decimal', { capacity: '35 Ah' }],
    ['a polarity outside L and R', { polarity: 'X' }],
    ['an unrecorded payment label', { payment_method: 'bitcoin' }],
  ])('refuses %s', (_, overrides) => {
    const sellable = { search: '', brand: '', capacity: '', polarity: '', page: 1, page_size: 10, ...overrides };
    const history = { search: '', payment_method: '', page: 1, page_size: 10, ...overrides };
    const sellableOk = validSellableQuery(sellable as never);
    const historyOk = validSalesQuery(history as never);
    expect(sellableOk && historyOk).toBe(false);
  });

  it('admits the contract queries, including the mixed filter of the history', () => {
    expect(validSellableQuery({ search: 'NS40', brand: 'CAR', capacity: '35', polarity: 'L', page: 1, page_size: 10 })).toBe(true);
    expect(validSellableQuery({ search: '', brand: '', capacity: '', polarity: '', page: 1, page_size: 50 })).toBe(true);
    expect(validSalesQuery({ search: '', payment_method: 'mixed', page: 1, page_size: 25 })).toBe(true);
    expect(validSalesQuery({ search: 'Marta', payment_method: '', page: 2, page_size: 50 })).toBe(true);
  });
});

describe('the sellable catalogue read', () => {
  it('maps the variants with their pair, their polarities and their availability', () => {
    const page = parseSellablePage(sellableBody({
      items: [sellableItem(), sellableItem({ variant_id: 2, polarity: 'R' }),
        sellableItem({ variant_id: 5, catalog_entry_id: 4, brand: 'HYBRID', model: 'BT54L', capacity_ah: '54',
          sellable: false, suggested_price: null, min_price: null, existing: 4, available: 4 })],
    }));
    expect(page.total_variants).toBe(190);
    expect(page.items.map(item => item.polarity)).toEqual(['L', 'R', 'L']);
    expect(page.items[0]).toMatchObject({ variant_id: 1, suggested_price: '96000.00', min_price: '85000.00', sellable: true });
    // Availability stays exact text, never a float.
    expect(page.items[0].existing).toBe(12n);
    expect(page.items[0].available).toBe(12n);
    // The unpriced battery is a row with no pair at all.
    expect(page.items[2]).toMatchObject({ sellable: false, suggested_price: null, min_price: null });
  });

  it.each([
    ['an unknown top-level key', sellableBody({ extra: 1 })],
    ['an unknown item key', sellableBody({ items: [sellableItem({ warranty_months: 12 })] })],
    ['a sellable row without prices', sellableBody({ items: [sellableItem({ suggested_price: null, min_price: null })] })],
    ['an unpriced row that still carries a price', sellableBody({ items: [sellableItem({ sellable: false })] })],
    ['a suggested price under the minimum', sellableBody({ items: [sellableItem({ suggested_price: '80000.00' })] })],
    ['money with three decimals', sellableBody({ items: [sellableItem({ min_price: '85000.000' })] })],
    ['a polarity that is not L or R', sellableBody({ items: [sellableItem({ polarity: 'X' })] })],
    ['a capacity that is not canonical', sellableBody({ items: [sellableItem({ capacity_ah: '035' })] })],
    ['a reserved balance above the existing one', sellableBody({ items: [sellableItem({ reserved: 99 })] })],
    ['more items than the announced page', sellableBody({ page_size: 10, items: Array.from({ length: 11 }, (_, index) => sellableItem({ variant_id: index + 1 })) })],
    ['a duplicated variant', sellableBody({ items: [sellableItem(), sellableItem()] })],
    ['a page past the announced total', sellableBody({ page: 2, items: [sellableItem()], total_variants: 1 })],
    ['a duplicated JSON key', '{"page":1,"page":2,"page_size":25,"total_variants":0,"items":[]}'],
  ])('refuses %s', (_, body) => {
    expect(() => parseSellablePage(body)).toThrow();
  });
});

describe('the sale document read', () => {
  it('reads the created document with its settlement and its frozen units', () => {
    const sale = parseCreatedSale(createdBody());
    expect(sale).toMatchObject({
      id: 1, branch_location_id: 2, branch_sequence: 126, warranty_number: '2-000126',
      payment_method: 'mixed', total: '304000.00', created_by_account_id: 2,
      customer: { name: 'Marta Giménez', phone: '381 555 0198', document: '27.884.310', address: 'Av. América 123' },
    });
    expect(sale.payments).toEqual([
      { method: 'cash', amount: '200000.00' }, { method: 'transfer', amount: '104000.00' },
    ]);
    expect(sale.lines[1]).toMatchObject({ variant_id: 3, quantity: 1, unit_price: '112000.00' });
    // One row per physical battery, its serial and its term or its explicit absence.
    expect(sale.lines[0].units).toEqual([
      { serial_number: 'ABC123', warranty_months: 12 }, { serial_number: 'ABC124', warranty_months: null },
    ]);
  });

  it('reads the history page of the branch with its warranty position', () => {
    const page = parseSalePage(pageBody());
    expect(page.total_sales).toBe(87);
    expect(page.sales[0]).toMatchObject({ id: 1, warranty_number: '2-000126', payment_method: 'mixed', lines: 2 });
    expect(page.sales[0].total).toBe('304000.00');
    expect(page.sales[0].units_total).toBe(3);
    expect(page.sales[0].units_with_warranty).toBe(2);
  });

  it('reads one document with the catalogue identity and the units of every line', () => {
    const detail = parseSaleDetail(detailBody());
    expect(detail.customer_name).toBe('Marta Giménez');
    expect(detail.customer.address).toBe('Av. América 123');
    expect(detail.lines[0]).toMatchObject({
      variant_id: 1, catalog_entry_id: 1, brand: 'CAR', model: 'NS40ZL', capacity_ah: '35', polarity: 'L',
      quantity: 2, unit_price: '96000.00', min_price: '85000.00', subtotal: '192000.00',
    });
    expect(detail.lines[0].units.map(unit => unit.warranty_months)).toEqual([12, null]);
  });

  it.each([
    ['a document with no settlement', createdBody({ payments: [] })],
    ['a label that contradicts its own payments', createdBody({ payment_method: 'cash' })],
    ['a warranty number under another branch', createdBody({ warranty_number: '3-000126' })],
    ['a warranty number with a shorter correlative', createdBody({ warranty_number: '2-126' })],
    ['an unadmitted payment method', createdBody({ payment_method: 'bitcoin' })],
    ['a payment with a zero amount', createdBody({ payments: [{ method: 'cash', amount: '0.00' }], payment_method: 'cash' })],
    ['a duplicated payment method', createdBody({ payments: [{ method: 'cash', amount: '1.00' }, { method: 'cash', amount: '2.00' }] })],
    ['a document without lines', createdBody({ lines: [] })],
    ['a line without its frozen minimum', createdBody({ lines: [{ variant_id: 1, quantity: 1, unit_price: '96000.00', subtotal: '96000.00',
      units: [{ serial_number: 'ABC123', warranty_months: 12 }] }] })],
    ['a line without its units', createdBody({ lines: [{ variant_id: 1, quantity: 1, unit_price: '96000.00', min_price: '85000.00',
      subtotal: '96000.00' }] })],
    ['a line with more units than its quantity', createdBody({ lines: [{ variant_id: 1, quantity: 1, unit_price: '96000.00',
      min_price: '85000.00', subtotal: '96000.00', units: [{ serial_number: 'A', warranty_months: 1 },
        { serial_number: 'B', warranty_months: 1 }] }] })],
    ['a unit with an unknown key', createdBody({ lines: [{ variant_id: 1, quantity: 1, unit_price: '96000.00',
      min_price: '85000.00', subtotal: '96000.00',
      units: [{ serial_number: 'A', warranty_months: 1, serial: 'A' }] }] })],
    ['a unit without its term key', createdBody({ lines: [{ variant_id: 1, quantity: 1, unit_price: '96000.00',
      min_price: '85000.00', subtotal: '96000.00', units: [{ serial_number: 'A' }] }] })],
    ['a unit whose term is zero', createdBody({ lines: [{ variant_id: 1, quantity: 1, unit_price: '96000.00',
      min_price: '85000.00', subtotal: '96000.00', units: [{ serial_number: 'A', warranty_months: 0 }] }] })],
    ['a unit whose term is past 120', createdBody({ lines: [{ variant_id: 1, quantity: 1, unit_price: '96000.00',
      min_price: '85000.00', subtotal: '96000.00', units: [{ serial_number: 'A', warranty_months: 121 }] }] })],
    ['a unit with an empty serial', createdBody({ lines: [{ variant_id: 1, quantity: 1, unit_price: '96000.00',
      min_price: '85000.00', subtotal: '96000.00', units: [{ serial_number: '', warranty_months: 1 }] }] })],
    ['a unit with a serial over 64 characters', createdBody({ lines: [{ variant_id: 1, quantity: 1, unit_price: '96000.00',
      min_price: '85000.00', subtotal: '96000.00', units: [{ serial_number: 'x'.repeat(65), warranty_months: 1 }] }] })],
    ['the same serial twice in one sale', createdBody({ lines: [{ variant_id: 1, quantity: 1, unit_price: '96000.00',
      min_price: '85000.00', subtotal: '96000.00', units: [{ serial_number: 'ABC123', warranty_months: 1 }] },
    { variant_id: 3, quantity: 1, unit_price: '96000.00', min_price: '85000.00', subtotal: '96000.00',
      units: [{ serial_number: 'abc123', warranty_months: 1 }] }], total: '192000.00',
    payments: [{ method: 'cash', amount: '192000.00' }], payment_method: 'cash' })],
    ['a client without a name', createdBody({ customer: { name: '', phone: '', document: '', address: '' } })],
    ['a client without its address key', createdBody({ customer: { name: 'Marta Giménez', phone: '', document: '' } })],
    ['a client address over 200 characters', createdBody({ customer: { name: 'Marta Giménez', phone: '', document: '', address: 'x'.repeat(201) } })],
    ['a total that is not canonical', createdBody({ total: '304000' })],
    ['a creation reply without the sale key', JSON.stringify(saleBody())],
  ])('refuses %s', (_, body) => {
    expect(() => parseCreatedSale(body)).toThrow();
  });

  it.each([
    ['an unknown history key', pageBody({ extra: true })],
    ['a row without its line count', pageBody({ sales: [{ ...summary(), lines: undefined }] })],
    ['a zero line count', pageBody({ sales: [summary({ lines: 0 })] })],
    ['a row without its unit count', pageBody({ sales: [{ ...summary(), units_total: undefined }] })],
    ['a row without its warranty count', pageBody({ sales: [{ ...summary(), units_with_warranty: undefined }] })],
    ['a row whose warranties exceed its units', pageBody({ sales: [summary({ units_with_warranty: 4 })] })],
    ['a row with more lines than units', pageBody({ sales: [summary({ units_total: 1, units_with_warranty: 1 })] })],
    ['more rows than the announced page', pageBody({ page_size: 10, sales: Array.from({ length: 11 }, (_, index) => summary({ id: index + 1 })) })],
    ['a page past the announced total', pageBody({ page: 2, sales: [summary()], total_sales: 1 })],
    ['a detail without the catalogue identity', detailBody({ lines: [{ variant_id: 1, quantity: 1, unit_price: '1.00', min_price: '1.00', subtotal: '1.00',
      units: [{ serial_number: 'A', warranty_months: 1 }] }] })],
    ['a detail whose line has no units', detailBody({ lines: [{ variant_id: 1, catalog_entry_id: 1, brand: 'CAR', model: 'NS40ZL',
      capacity_ah: '35', polarity: 'L', quantity: 1, unit_price: '96000.00', min_price: '85000.00', subtotal: '96000.00' }],
    total: '96000.00', payments: [{ method: 'cash', amount: '96000.00' }] })],
    ['a detail without its payments', detailBody({ payments: [] })],
  ])('refuses %s', (_, body) => {
    expect(() => (body.includes('"sales"') ? parseSalePage(body) : parseSaleDetail(body))).toThrow();
  });
});

describe('the sale evidence', () => {
  it('accepts the created document that repeats the exact payload', () => {
    expect(matchesCreateSale(input(), parseCreatedSale(createdBody()))).toBe(true);
  });

  it.each([
    ['another total', createdBody({ total: '400000.00', payment_method: 'cash',
      payments: [{ method: 'cash', amount: '400000.00' }], lines: [
      { variant_id: 1, quantity: 3, unit_price: '96000.00', min_price: '85000.00', subtotal: '288000.00',
        units: [{ serial_number: 'ABC123', warranty_months: 12 }, { serial_number: 'ABC124', warranty_months: null },
          { serial_number: 'ABC125', warranty_months: 12 }] },
      { variant_id: 3, quantity: 1, unit_price: '112000.00', min_price: '100000.00', subtotal: '112000.00',
        units: [{ serial_number: 'TOYO-9', warranty_months: 12 }] },
    ] })],
    ['another settlement', createdBody({ payments: [{ method: 'cash', amount: '304000.00' }], payment_method: 'cash' })],
    ['another line price', createdBody({ total: '302000.00',
      payments: [{ method: 'cash', amount: '190000.00' }, { method: 'transfer', amount: '112000.00' }], lines: [
      { variant_id: 1, quantity: 2, unit_price: '95000.00', min_price: '85000.00', subtotal: '190000.00',
        units: [{ serial_number: 'ABC123', warranty_months: 12 }, { serial_number: 'ABC124', warranty_months: null }] },
      { variant_id: 3, quantity: 1, unit_price: '112000.00', min_price: '100000.00', subtotal: '112000.00',
        units: [{ serial_number: 'TOYO-9', warranty_months: 12 }] },
    ] })],
    ['another term on one unit', createdBody({ lines: [
      { variant_id: 1, quantity: 2, unit_price: '96000.00', min_price: '85000.00', subtotal: '192000.00',
        units: [{ serial_number: 'ABC123', warranty_months: 6 }, { serial_number: 'ABC124', warranty_months: null }] },
      { variant_id: 3, quantity: 1, unit_price: '112000.00', min_price: '100000.00', subtotal: '112000.00',
        units: [{ serial_number: 'TOYO-9', warranty_months: 12 }] },
    ] })],
    ['a warranty where the seller registered none', createdBody({ lines: [
      { variant_id: 1, quantity: 2, unit_price: '96000.00', min_price: '85000.00', subtotal: '192000.00',
        units: [{ serial_number: 'ABC123', warranty_months: 12 }, { serial_number: 'ABC124', warranty_months: 12 }] },
      { variant_id: 3, quantity: 1, unit_price: '112000.00', min_price: '100000.00', subtotal: '112000.00',
        units: [{ serial_number: 'TOYO-9', warranty_months: 12 }] },
    ] })],
    ['another serial on one unit', createdBody({ lines: [
      { variant_id: 1, quantity: 2, unit_price: '96000.00', min_price: '85000.00', subtotal: '192000.00',
        units: [{ serial_number: 'ZZZ999', warranty_months: 12 }, { serial_number: 'ABC124', warranty_months: null }] },
      { variant_id: 3, quantity: 1, unit_price: '112000.00', min_price: '100000.00', subtotal: '112000.00',
        units: [{ serial_number: 'TOYO-9', warranty_months: 12 }] },
    ] })],
    ['another client', createdBody({ customer: { name: 'Otra Persona', phone: '', document: '', address: 'Av. América 123' } })],
    ['another address', createdBody({ customer: { name: 'Marta Giménez', phone: '381 555 0198', document: '27.884.310', address: '' } })],
    ['a missing line', createdBody({ total: '192000.00', payment_method: 'cash',
      payments: [{ method: 'cash', amount: '192000.00' }],
      lines: [{ variant_id: 1, quantity: 2, unit_price: '96000.00', min_price: '85000.00', subtotal: '192000.00',
        units: [{ serial_number: 'ABC123', warranty_months: 12 }, { serial_number: 'ABC124', warranty_months: null }] }] })],
  ])('refuses a reply that reports %s', (_, body) => {
    expect(matchesCreateSale(input(), parseCreatedSale(body))).toBe(false);
  });
});

describe('the sale failures', () => {
  it.each([
    [400, '{"error":"invalid_request"}', 'invalid_request'],
    [401, '{"error":"unauthenticated"}', 'unauthenticated'],
    [403, '{"error":"forbidden"}', 'forbidden'],
    [404, '{"error":"not_found"}', 'not_found'],
    [405, '{"error":"method_not_allowed"}', 'method_not_allowed'],
    [409, '{"error":"variant_not_sellable","variant_id":3}', 'variant_not_sellable'],
    [409, '{"error":"below_minimum","variant_id":1}', 'below_minimum'],
    [409, '{"error":"insufficient_stock","variant_id":19}', 'insufficient_stock'],
    [409, '{"error":"serial_already_sold","serial_number":"ABC123"}', 'serial_already_sold'],
    [503, '{"error":"service_unavailable"}', 'service_unavailable'],
  ])('admits the %s %s envelope', (status, body, code) => {
    expect(parseSalesError(body, status)).toMatchObject({ code });
  });

  it('names the variant a line refusal points at', () => {
    expect(parseSalesError('{"error":"below_minimum","variant_id":1}', 409))
      .toEqual({ code: 'below_minimum', variant_id: 1, serial_number: null, mismatch: null });
  });

  it('names the serial a repeated-serial refusal points at', () => {
    expect(parseSalesError('{"error":"serial_already_sold","serial_number":"ABC123"}', 409))
      .toEqual({ code: 'serial_already_sold', variant_id: null, serial_number: 'ABC123', mismatch: null });
  });

  it('tells the seller the serial was already sold and that nothing was registered', () => {
    expect(salesErrorMessages.serial_already_sold).toContain('ya se vendió');
    expect(salesErrorMessages.serial_already_sold).toContain('No se registró nada.');
  });

  it('names the side that does not close, with its amount', () => {
    expect(parseSalesError('{"error":"payments_mismatch","missing":"104000.00"}', 400)).toEqual({
      code: 'payments_mismatch', variant_id: null, serial_number: null,
      mismatch: { side: 'missing', amount: '104000.00' },
    });
    expect(parseSalesError('{"error":"payments_mismatch","excess":"6000.00"}', 400)).toEqual({
      code: 'payments_mismatch', variant_id: null, serial_number: null,
      mismatch: { side: 'excess', amount: '6000.00' },
    });
  });

  it.each([
    ['an unadmitted status', '{"error":"forbidden"}', 409],
    ['an unexpected code for the status', '{"error":"retry_conflict"}', 400],
    ['a mismatch without a side', '{"error":"payments_mismatch"}', 400],
    ['a mismatch with both sides', '{"error":"payments_mismatch","missing":"1.00","excess":"2.00"}', 400],
    ['a mismatch with money that is not canonical', '{"error":"payments_mismatch","missing":"1000"}', 400],
    ['a variant refusal without its id', '{"error":"below_minimum"}', 409],
    ['a serial refusal without its serial', '{"error":"serial_already_sold"}', 409],
    ['a serial refusal beside a variant id', '{"error":"serial_already_sold","serial_number":"ABC123","variant_id":1}', 409],
    ['a serial refusal with an empty serial', '{"error":"serial_already_sold","serial_number":""}', 409],
    ['a serial refusal with a padded serial', '{"error":"serial_already_sold","serial_number":" ABC123 "}', 409],
    ['a serial refusal with a serial over 64 characters', `{"error":"serial_already_sold","serial_number":"${'x'.repeat(65)}"}`, 409],
    ['a serial beside another code', '{"error":"forbidden","serial_number":"ABC123"}', 403],
    ['a message beside the code', '{"error":"forbidden","message":"no"}', 403],
    ['a non-JSON body', 'forbidden', 403],
  ])('refuses %s', (_, body, status) => {
    expect(() => parseSalesError(body, status)).toThrow();
  });
});

describe('the counter transport', () => {
  it('reads one sellable page with the exact query and the session cookie', async () => {
    const fetch = mockFetch().mockResolvedValue(json(sellableBody()));
    const page = await createSalesAPI(fetch).sellable({ search: '', brand: '', capacity: '', polarity: '', page: 1, page_size: 25 });
    expect(page.items[0].min_price).toBe('85000.00');
    expect(fetch.mock.calls[0]).toEqual([
      '/api/sales/sellable?page=1&page_size=25',
      { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: undefined },
    ]);
  });

  it('reads the history and one document of it', async () => {
    const fetch = mockFetch()
      .mockResolvedValueOnce(json(pageBody()))
      .mockResolvedValueOnce(json(detailBody()));
    const api = createSalesAPI(fetch);
    expect((await api.history({ search: '', payment_method: '', page: 1, page_size: 10 })).total_sales).toBe(87);
    expect((await api.detail(1)).lines[0].brand).toBe('CAR');
    expect(fetch.mock.calls[1][0]).toBe('/api/sales/1');
  });

  it('trims the address it sends and compares the replied one the way the server does', async () => {
    const asked = input();
    const spaced = { ...asked, customer: { ...asked.customer, address: '  Av. América 123  ' } };
    const fetch = mockFetch().mockResolvedValue(json(createdBody({
      customer: { ...asked.customer, address: 'Av. América 123' },
    }), 201));
    const sale = await createSalesAPI(fetch).create(spaced, csrf);
    expect(sale.customer.address).toBe('Av. América 123');
    // D9: the body carries the trimmed address the server echoes back.
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body)).customer.address).toBe('Av. América 123');
  });

  it('posts the exact document payload with the session CSRF header', async () => {
    const fetch = mockFetch().mockResolvedValue(new Response(createdBody(), {
      status: 201, headers: { 'Content-Type': 'application/json' },
    }));
    const sale = await createSalesAPI(fetch).create(input(), csrf);
    expect(sale.warranty_number).toBe('2-000126');
    expect(fetch.mock.calls[0]).toEqual(['/api/sales', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: undefined,
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify(input()),
    }]);
  });

  it('captures the exact payload before awaiting', async () => {
    let resolve!: (value: Response) => void;
    const fetch = mockFetch().mockReturnValue(new Promise<Response>(yes => { resolve = yes; }));
    const sent = input() as unknown as { lines: { variant_id: number }[]; customer: { name: string } };
    const job = createSalesAPI(fetch).create(sent as unknown as CreateSaleInput, csrf);
    sent.lines[0].variant_id = 99;
    sent.customer.name = 'Otra';
    resolve(new Response(createdBody(), { status: 201, headers: { 'Content-Type': 'application/json' } }));
    await job;
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual(input());
  });

  it('reports a settlement that does not close with the side and its amount', async () => {
    const fetch = mockFetch().mockResolvedValue(json('{"error":"payments_mismatch","missing":"104000.00"}', 400));
    const failure = await createSalesAPI(fetch).create(input(), csrf).catch(error => error);
    expect(failure).toBeInstanceOf(SalesAPIError);
    expect(failure).toMatchObject({ code: 'payments_mismatch', status: 400 });
    expect((failure as SalesAPIError).mismatch).toEqual({ side: 'missing', amount: '104000.00' });
    expect(moneyCents((failure as SalesAPIError).mismatch!.amount)).toBe(10_400_000n);
  });

  it('carries the variant a line refusal names', async () => {
    const fetch = mockFetch().mockResolvedValue(json('{"error":"below_minimum","variant_id":3}', 409));
    await expect(createSalesAPI(fetch).create(input(), csrf)).rejects.toMatchObject({
      code: 'below_minimum', status: 409, variantId: 3,
    });
  });

  it('carries the serial a repeated-serial refusal names, so the counter can point at it', async () => {
    const fetch = mockFetch().mockResolvedValue(json('{"error":"serial_already_sold","serial_number":"ABC123"}', 409));
    await expect(createSalesAPI(fetch).create(input(), csrf)).rejects.toMatchObject({
      code: 'serial_already_sold', status: 409, serialNumber: 'ABC123',
    });
  });

  it.each([
    ['a reply under another status', new Response(createdBody(), { status: 200, headers: { 'Content-Type': 'application/json' } })],
    ['a reply that reports another total', new Response(createdBody({ total: '1.00' }), { status: 201, headers: { 'Content-Type': 'application/json' } })],
  ])('refuses to interpret %s', async (_, reply) => {
    const fetch = mockFetch().mockResolvedValue(reply);
    await expect(createSalesAPI(fetch).create(input(), csrf)).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('refuses to interpret a page that is not the one asked for', async () => {
    const fetch = mockFetch().mockResolvedValue(json(pageBody({ page_size: 25 })));
    await expect(createSalesAPI(fetch).history({ search: '', payment_method: '', page: 1, page_size: 10 }))
      .rejects.toMatchObject({ code: 'invalid_response' });
  });

  it.each([
    ['a missing CSRF token', input(), ''],
    ['a CSRF token with forbidden characters', input(), 'not a token'],
    ['a document with no payments', { ...input(), payments: [] }, csrf],
    ['a document with no lines', { ...input(), lines: [] }, csrf],
    ['a price with three decimals', { ...input(), lines: [{ variant_id: 1, quantity: 1, unit_price: '96000.000',
      units: [{ serial_number: 'ABC123', warranty_months: 12 }] }] }, csrf],
    ['a term outside its bounds', { ...input(), lines: [{ variant_id: 1, quantity: 1, unit_price: '96000.00',
      units: [{ serial_number: 'ABC123', warranty_months: 0 }] }] }, csrf],
    ['a unit without its term key', { ...input(), lines: [{ variant_id: 1, quantity: 1, unit_price: '96000.00',
      units: [{ serial_number: 'ABC123' }] }] }, csrf],
    ['a unit count that is not the quantity', { ...input(), lines: [{ variant_id: 1, quantity: 2, unit_price: '96000.00',
      units: [{ serial_number: 'ABC123', warranty_months: 12 }] }] }, csrf],
    ['a unit without a serial', { ...input(), lines: [{ variant_id: 1, quantity: 1, unit_price: '96000.00',
      units: [{ serial_number: '  ', warranty_months: 12 }] }] }, csrf],
    ['a serial over 64 characters', { ...input(), lines: [{ variant_id: 1, quantity: 1, unit_price: '96000.00',
      units: [{ serial_number: 'x'.repeat(65), warranty_months: 12 }] }] }, csrf],
    ['the same serial twice', { ...input(), lines: [{ variant_id: 1, quantity: 2, unit_price: '96000.00',
      units: [{ serial_number: 'ABC123', warranty_months: 12 }, { serial_number: 'abc123', warranty_months: 12 }] }] }, csrf],
    ['a line with a warranty term outside the units', { ...input(), lines: [{ variant_id: 1, quantity: 1, unit_price: '96000.00',
      warranty_months: 12, units: [{ serial_number: 'ABC123', warranty_months: 12 }] }] }, csrf],
    ['a client without a name', { ...input(), customer: { name: '  ', phone: '', document: '', address: '' } }, csrf],
    ['a client without its address key', { ...input(), customer: { name: 'Marta', phone: '', document: '' } }, csrf],
    ['a client address over 200 characters', { ...input(),
      customer: { name: 'Marta', phone: '', document: '', address: 'x'.repeat(201) } }, csrf],
  ])('fails closed on %s without any network call', async (_, body, token) => {
    const fetch = mockFetch();
    await expect(createSalesAPI(fetch).create(body as CreateSaleInput, token)).rejects.toMatchObject({
      code: 'invalid_request', status: null,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('distinguishes a lost connection from an aborted read', async () => {
    const network = mockFetch().mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(createSalesAPI(network).sellable({ search: '', brand: '', capacity: '', polarity: '', page: 1, page_size: 25 }))
      .rejects.toMatchObject({ code: 'network', status: null });
    const controller = new AbortController();
    controller.abort();
    const aborted = mockFetch().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await expect(createSalesAPI(aborted).sellable({ search: '', brand: '', capacity: '', polarity: '', page: 1, page_size: 25 }, controller.signal))
      .rejects.toMatchObject({ code: 'aborted', status: null });
  });
});
