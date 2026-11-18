import { describe, expect, it } from 'vitest';
import {
  canonicalCatalogOtherNumber, catalogOtherFieldLabel, catalogOtherFieldsCountLabel,
  catalogOtherProductDraftOf, catalogOtherProductDuplicateFieldMessage, catalogOtherProductFieldNameMessage,
  catalogOtherProductFieldsMessage, catalogOtherProductNameMessage, catalogOtherProductNumberMessage,
  catalogOtherProductTextMessage, catalogOtherProductUnitMessage, catalogOtherProductsErrorMessages,
  catalogOtherProductsListUnavailable, catalogOtherProductsPath, matchesCatalogOtherProduct,
  parseCatalogOtherProduct, parseCatalogOtherProductPage, parseCatalogOtherProductsError,
  validCatalogOtherProductsQuery, validateCatalogOtherProductDraft,
  type CatalogOtherProductDraft,
} from './catalogOtherProductsModel';

// One created product exactly as the frozen contract publishes it: the name the
// operator wrote and the typed fields, with numbers as canonical decimal text.
const record = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  id: 113, name: 'Agua acidulada',
  fields: [
    { name: 'volumen en L', kind: 'number', unit: 'L', number: '5' },
    { name: 'origen', kind: 'text', text: 'importado' },
  ], ...overrides,
});
const page = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  products: [JSON.parse(record())], page: 1, page_size: 10, total_products: 1, ...overrides,
});
const numberField = (overrides: Record<string, unknown> = {}) => ({
  name: 'volumen en L', kind: 'number', unit: 'L', number: '5', text: '', ...overrides,
});
const textField = (overrides: Record<string, unknown> = {}) => ({
  name: 'origen', kind: 'text', unit: '', number: '', text: 'importado', ...overrides,
});
const draft = (overrides: Partial<CatalogOtherProductDraft> = {}): CatalogOtherProductDraft => ({
  name: 'Agua acidulada', fields: [numberField(), textField()], ...overrides,
});
const query = { search: '', page: 1, page_size: 10 };

describe('one created or edited other product', () => {
  it('admits the contract shape with its typed fields', () => {
    const product = parseCatalogOtherProduct(record());
    expect(product).toEqual({
      id: 113, name: 'Agua acidulada',
      fields: [
        { name: 'volumen en L', kind: 'number', unit: 'L', number: '5' },
        { name: 'origen', kind: 'text', text: 'importado' },
      ],
    });
    expect(Object.isFrozen(product)).toBe(true);
    expect(Object.isFrozen(product.fields)).toBe(true);
    expect(Object.isFrozen(product.fields[0])).toBe(true);
  });

  it.each([
    ['no fields at all', { fields: [] }, { fields: [] }],
    ['a number without unit', { fields: [{ name: 'volumen', kind: 'number', number: '5' }] },
      { fields: [{ name: 'volumen', kind: 'number', unit: null, number: '5' }] }],
    ['a number with a null unit key', { fields: [{ name: 'volumen', kind: 'number', unit: null, number: '5' }] },
      { fields: [{ name: 'volumen', kind: 'number', unit: null, number: '5' }] }],
    ['a negative number', { fields: [{ name: 'temperatura', kind: 'number', number: '-3.5' }] },
      { fields: [{ name: 'temperatura', kind: 'number', unit: null, number: '-3.5' }] }],
    ['the widest number', { fields: [{ name: 'volumen', kind: 'number', unit: 'mL', number: '123456789012.000001' }] },
      { fields: [{ name: 'volumen', kind: 'number', unit: 'mL', number: '123456789012.000001' }] }],
    ['a text of 200 bytes', { fields: [{ name: 'origen', kind: 'text', text: 'á'.repeat(100) }] },
      { fields: [{ name: 'origen', kind: 'text', text: 'á'.repeat(100) }] }],
    ['twenty fields', { fields: Array.from({ length: 20 }, (_, index) =>
      ({ name: `campo ${index}`, kind: 'text', text: 'x' })) },
    { fields: Array.from({ length: 20 }, (_, index) => ({ name: `campo ${index}`, kind: 'text', text: 'x' })) }],
    ['the smallest id', { id: 1 }, { id: 1 }],
  ])('accepts %s', (_name, overrides, expected) => {
    expect(parseCatalogOtherProduct(record(overrides))).toMatchObject(expected);
  });

  it.each([
    ['an unknown key', { priced: true }],
    ['an unknown field key', { fields: [{ name: 'origen', kind: 'text', text: 'x', number: '5' }] }],
    ['an unknown nested key', { fields: [{ name: 'origen', kind: 'text', text: 'x', unit: 'L' }] }],
    ['a missing id', { id: undefined }],
    ['a missing name', { name: undefined }],
    ['a missing field list', { fields: undefined }],
    ['a missing kind', { fields: [{ name: 'origen', text: 'x' }] }],
    ['an id below one', { id: 0 }],
    ['an id past the identity bound', { id: 2147483648 }],
    ['an id as text', { id: '113' }],
    ['an id as a float', { id: 113.5 }],
    ['an empty name', { name: '' }],
    ['a name of two bytes', { name: 'ab' }],
    ['a name past 64 bytes', { name: 'á'.repeat(33) }],
    ['a name with surrounding spaces', { name: ' Agua acidulada' }],
    ['a name with a control character', { name: 'Agua\tacidulada' }],
    ['a name with a NUL', { name: 'Agua\0acidulada' }],
    ['twenty-one fields', { fields: Array.from({ length: 21 }, (_, index) =>
      ({ name: `campo ${index}`, kind: 'text', text: 'x' })) }],
    ['two fields with the same name', { fields: [
      { name: 'origen', kind: 'text', text: 'a' }, { name: 'ORIGEN', kind: 'text', text: 'b' }] }],
    ['an empty field name', { fields: [{ name: '', kind: 'text', text: 'x' }] }],
    ['a field name past 40 bytes', { fields: [{ name: 'á'.repeat(21), kind: 'text', text: 'x' }] }],
    ['a field name with surrounding spaces', { fields: [{ name: ' origen', kind: 'text', text: 'x' }] }],
    ['a number field without number', { fields: [{ name: 'volumen', kind: 'number', unit: 'L' }] }],
    ['a number that is padded', { fields: [{ name: 'volumen', kind: 'number', number: '5.50' }] }],
    ['a number with thirteen integers', { fields: [{ name: 'volumen', kind: 'number', number: '1234567890123' }] }],
    ['a number with seven decimals', { fields: [{ name: 'volumen', kind: 'number', number: '5.1234567' }] }],
    ['a number as a JSON number', { fields: [{ name: 'volumen', kind: 'number', number: 5 }] }],
    ['a negative zero', { fields: [{ name: 'volumen', kind: 'number', number: '-0' }] }],
    ['a unit past eight bytes', { fields: [{ name: 'volumen', kind: 'number', unit: 'litros ya', number: '5' }] }],
    ['a padded unit', { fields: [{ name: 'volumen', kind: 'number', unit: ' L', number: '5' }] }],
    ['an empty unit', { fields: [{ name: 'volumen', kind: 'number', unit: '', number: '5' }] }],
    ['a unit on a text field', { fields: [{ name: 'origen', kind: 'text', unit: 'L', text: 'x' }] }],
    ['a text field without text', { fields: [{ name: 'origen', kind: 'text' }] }],
    ['an empty text value', { fields: [{ name: 'origen', kind: 'text', text: '' }] }],
    ['a text past 200 bytes', { fields: [{ name: 'origen', kind: 'text', text: 'á'.repeat(101) }] }],
    ['a field of an unknown kind', { fields: [{ name: 'origen', kind: 'date', text: 'x' }] }],
  ])('refuses %s', (_name, overrides) => {
    expect(() => parseCatalogOtherProduct(record(overrides))).toThrow();
  });

  it('refuses a duplicated key even when both values are a name', () => {
    expect(() => parseCatalogOtherProduct(record().replace('"id":113', '"id":113,"id":114'))).toThrow();
  });
});

describe('one page of the other products catalogue', () => {
  it('admits a page and freezes it', () => {
    const parsed = parseCatalogOtherProductPage(page());
    expect(parsed.page).toBe(1);
    expect(parsed.page_size).toBe(10);
    expect(parsed.total_products).toBe(1);
    expect(parsed.rows.map(row => row.name)).toEqual(['Agua acidulada']);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.rows)).toBe(true);
  });

  it('admits an empty page', () => {
    expect(parseCatalogOtherProductPage(JSON.stringify({ products: [], page: 2, page_size: 10, total_products: 10 })))
      .toMatchObject({ rows: [], page: 2, page_size: 10, total_products: 10 });
  });

  it.each([
    ['an unknown key', page({ page_total: 1 })],
    ['a missing products list', JSON.stringify({ page: 1, page_size: 10, total_products: 0 })],
    ['a products list that is not a list', page({ products: {} })],
    ['a page size outside the contract', page({ page_size: 7 })],
    ['a page below one', page({ page: 0 })],
    ['more rows than the page holds', page({ products: [JSON.parse(record()), JSON.parse(record({ id: 114 }))] })],
    ['rows past the announced total', page({ total_products: 0 })],
    ['two rows with the same id', page({ products: [JSON.parse(record()), JSON.parse(record())], total_products: 2 })],
    ['a row that grew a field', page({ products: [{ ...JSON.parse(record()), priced: true }] })],
  ])('refuses %s', (_name, body) => {
    expect(() => parseCatalogOtherProductPage(body)).toThrow();
  });
});

describe('the frozen listing path', () => {
  it('always carries the page and omits an empty search', () => {
    expect(catalogOtherProductsPath(query)).toBe('/api/catalog/other-products?page=1&page_size=10');
    expect(catalogOtherProductsPath({ ...query, search: 'Agua acidulada', page: 3, page_size: 25 }))
      .toBe('/api/catalog/other-products?search=Agua+acidulada&page=3&page_size=25');
  });

  it('refuses a query outside the contract', () => {
    expect(validCatalogOtherProductsQuery(query)).toBe(true);
    for (const broken of [{ ...query, page: 0 }, { ...query, page_size: 7 },
      { ...query, page: 1_000_001 }, { ...query, search: 'a\0b' }, { ...query, search: 'á'.repeat(129) }]) {
      expect(validCatalogOtherProductsQuery(broken)).toBe(false);
      expect(() => catalogOtherProductsPath(broken)).toThrow();
    }
    // The bound is the server's own, measured in runes: a 128-rune search fits even in UTF-8.
    expect(validCatalogOtherProductsQuery({ ...query, search: 'á'.repeat(128) })).toBe(true);
  });
});

describe('the canonical number of a numeric field', () => {
  it.each([
    ['5', '5'], ['005.50', '5.5'], ['0', '0'], ['5.000000', '5'],
    ['123456789012', '123456789012'], ['-3.5', '-3.5'], ['-0.5', '-0.5'],
  ])('normalizes %s to %s', (typed, canonical) => {
    expect(canonicalCatalogOtherNumber(typed)).toBe(canonical);
  });

  it.each([[''], [' '], ['-0'], ['5.'], ['.5'], ['5,5'], ['1e5'], ['1234567890123'], ['1.1234567'], ['abc']])(
    'refuses %s',
    value => expect(() => canonicalCatalogOtherNumber(value)).toThrow(),
  );
});

describe('the draft the form writes', () => {
  it('sends the canonical payload with the irrelevant boxes dropped', () => {
    const validation = validateCatalogOtherProductDraft(draft({
      name: 'Agua acidulada',
      fields: [numberField({ unit: '', number: '05.50' }), textField()],
    }));
    expect(validation.valid).toBe(true);
    expect(validation.valid && validation.input).toEqual({
      name: 'Agua acidulada',
      fields: [
        { name: 'volumen en L', kind: 'number', number: '5.5' },
        { name: 'origen', kind: 'text', text: 'importado' },
      ],
    });
    // The payload carries no unit key at all when the operator left it blank.
    expect(validation.valid && Object.hasOwn(validation.input.fields[0], 'unit')).toBe(false);
  });

  it('admits a product without fields', () => {
    const validation = validateCatalogOtherProductDraft(draft({ fields: [] }));
    expect(validation).toEqual({ valid: true, input: { name: 'Agua acidulada', fields: [] } });
  });

  it('trims the name, the field name and the unit before it writes them', () => {
    const validation = validateCatalogOtherProductDraft(draft({
      name: '  Agua acidulada  ',
      fields: [numberField({ name: ' volumen en L ', unit: ' L ', number: '5' }), textField()],
    }));
    expect(validation).toEqual({
      valid: true,
      input: {
        name: 'Agua acidulada',
        fields: [
          { name: 'volumen en L', kind: 'number', number: '5', unit: 'L' },
          { name: 'origen', kind: 'text', text: 'importado' },
        ],
      },
    });
  });

  it.each([
    ['a short name', draft({ name: 'ab' }), catalogOtherProductNameMessage],
    ['a name of 65 bytes', draft({ name: 'á'.repeat(33) }), catalogOtherProductNameMessage],
    ['twenty-one fields', draft({ fields: Array.from({ length: 21 }, (_, index) => textField({ name: `c${index}` })) }),
      catalogOtherProductFieldsMessage],
    ['an empty field name', draft({ fields: [textField({ name: '' })] }), catalogOtherProductFieldNameMessage],
    ['a whitespace-only field name', draft({ fields: [textField({ name: '   ' })] }), catalogOtherProductFieldNameMessage],
    ['a field name past 40 bytes', draft({ fields: [textField({ name: 'á'.repeat(21) })] }), catalogOtherProductFieldNameMessage],
    ['two identical field names', draft({ fields: [textField(), textField({ name: 'Origen' })] }),
      catalogOtherProductDuplicateFieldMessage],
    ['two field names that differ only in surrounding spaces',
      draft({ fields: [textField(), textField({ name: ' origen ' })] }), catalogOtherProductDuplicateFieldMessage],
    ['a number that is not one', draft({ fields: [numberField({ number: 'mucho' })] }), catalogOtherProductNumberMessage],
    ['a number with thirteen integers', draft({ fields: [numberField({ number: '1234567890123' })] }),
      catalogOtherProductNumberMessage],
    ['a unit past eight bytes', draft({ fields: [numberField({ unit: 'litros ya' })] }), catalogOtherProductUnitMessage],
    ['a whitespace-only unit', draft({ fields: [numberField({ unit: '   ' })] }), catalogOtherProductUnitMessage],
    ['a text field with an empty value', draft({ fields: [textField({ text: '' })] }), catalogOtherProductTextMessage],
    ['a text past 200 bytes', draft({ fields: [textField({ text: 'á'.repeat(101) })] }), catalogOtherProductTextMessage],
    ['a text with a control character', draft({ fields: [textField({ text: 'importado\nluego' })] }),
      catalogOtherProductTextMessage],
  ])('reports %s with its own message', (_name, broken, message) => {
    expect(validateCatalogOtherProductDraft(broken)).toEqual({ valid: false, message });
  });

  it('never admits an unknown key into the payload', () => {
    const extra = draft() as unknown as Record<string, unknown>;
    expect(validateCatalogOtherProductDraft({ ...extra, id: 113 } as never)).toEqual({
      valid: false, message: catalogOtherProductFieldsMessage,
    });
  });
});

describe('the echo of a write', () => {
  it('admits a record that repeats the write, whatever order the server lists the fields in', () => {
    const written = { name: 'Agua acidulada', fields: [
      { name: 'volumen en L', kind: 'number' as const, number: '5', unit: 'L' },
      { name: 'origen', kind: 'text' as const, text: 'importado' }] };
    expect(matchesCatalogOtherProduct(written, parseCatalogOtherProduct(record()))).toBe(true);
    const reordered = JSON.parse(record());
    reordered.fields.reverse();
    expect(matchesCatalogOtherProduct(written, parseCatalogOtherProduct(JSON.stringify(reordered)))).toBe(true);
  });

  it('refuses a record that changed a value, lost a field or renamed the product', () => {
    const written = { name: 'Agua acidulada', fields: [
      { name: 'volumen en L', kind: 'number' as const, number: '5', unit: 'L' }] };
    expect(matchesCatalogOtherProduct(written, parseCatalogOtherProduct(record({
      fields: [{ name: 'volumen en L', kind: 'number', unit: 'L', number: '6' }] })))).toBe(false);
    expect(matchesCatalogOtherProduct(written, parseCatalogOtherProduct(record({ fields: [] })))).toBe(false);
    expect(matchesCatalogOtherProduct(written, parseCatalogOtherProduct(record({
      fields: [{ name: 'volumen en L', kind: 'number', unit: 'ml', number: '5' }] })))).toBe(false);
    expect(matchesCatalogOtherProduct(written, parseCatalogOtherProduct(record({ name: 'Otra agua' })))).toBe(false);
    expect(matchesCatalogOtherProduct({ name: 'ab', fields: [] }, parseCatalogOtherProduct(record()))).toBe(false);
  });
});

describe('the words the screen shows', () => {
  it('renders a number with its unit and a text as it was written', () => {
    const product = parseCatalogOtherProduct(record());
    expect(catalogOtherFieldLabel(product.fields[0])).toBe('volumen en L: 5 L');
    expect(catalogOtherFieldLabel(product.fields[1])).toBe('origen: importado');
    expect(catalogOtherFieldLabel({ name: 'volumen', kind: 'number', unit: null, number: '5' })).toBe('volumen: 5');
    expect(catalogOtherFieldsCountLabel(product.fields)).toBe('2 campos');
    expect(catalogOtherFieldsCountLabel([])).toBe('sin campos');
    expect(catalogOtherFieldsCountLabel([{ name: 'origen', kind: 'text', text: 'x' }])).toBe('1 campo');
  });

  it('turns a record back into the draft the editor writes', () => {
    expect(catalogOtherProductDraftOf(parseCatalogOtherProduct(record()))).toEqual({
      name: 'Agua acidulada',
      fields: [
        { name: 'volumen en L', kind: 'number', unit: 'L', number: '5', text: '' },
        { name: 'origen', kind: 'text', unit: '', number: '', text: 'importado' },
      ],
    });
  });

  it('names every refusal in its own words', () => {
    expect(catalogOtherProductsListUnavailable).toMatch(/catálogo de otros productos/i);
    expect(catalogOtherProductsErrorMessages.catalog_product_has_stock).toMatch(/stock|existencias/i);
    expect(catalogOtherProductsErrorMessages.catalog_product_has_pending).toMatch(/transferencia/i);
    expect(catalogOtherProductsErrorMessages.conflict).toMatch(/nombre/i);
    expect(Object.values(catalogOtherProductsErrorMessages).every(message => message.trim() !== '')).toBe(true);
  });
});

describe('one rejected write', () => {
  it.each([
    ['invalid_request', 400], ['unauthenticated', 401], ['forbidden', 403], ['not_found', 404],
    ['conflict', 409], ['catalog_product_has_stock', 409], ['catalog_product_has_pending', 409],
    ['service_unavailable', 503],
  ])('admits %s with status %i', (code, status) => {
    expect(parseCatalogOtherProductsError(JSON.stringify({ error: code }), status)).toBe(code);
  });

  it.each([
    ['an unadmitted code', '{"error":"catalog_battery_has_stock"}', 409],
    ['an unadmitted status', '{"error":"conflict"}', 500],
    ['an unknown key', '{"error":"conflict","id":1}', 409],
    ['a missing envelope', '{}', 409],
  ])('refuses %s', (_name, body, status) => {
    expect(() => parseCatalogOtherProductsError(body, status)).toThrow();
  });
});
