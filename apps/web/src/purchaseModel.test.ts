import { describe, expect, it } from 'vitest';
import { formatMoney } from './pointOfSaleModel';
import {
  buildPurchaseInput, canonicalPurchaseInput, canonicalPurchaseModelCode, canonicalPurchaseReason,
  formatKg, formatSignedMoney, kgMilliFromWire, kgMilliToWire, lineAmountCents, newPurchaseDraft,
  newPurchaseOperationKey, parseTypedKg, purchaseDraftProblem, purchaseMaxLines, purchaseMaxNote,
  purchaseMaxQuantity, purchaseReversible, purchaseSettlement, purchaseTotalCents, removePurchaseLine,
  purchaseSharePercent, scrapLineAmountCents, scrapPurchaseLine, setPurchaseNote, setPurchaseSettlement, typedKg,
  upsertPurchaseLine, usedPurchaseLine, validPurchaseModelCode, validPurchaseQuantity,
  type PurchaseDraft, type PurchaseInput,
} from './purchaseModel';

const key = 'purchase_key_0001';
const cobre = { id: 1, name: 'Cobre' };

function fixedRandom(): Pick<Crypto, 'getRandomValues'> {
  return { getRandomValues: <T extends ArrayBufferView | null>(array: T): T => {
    if (array !== null) new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(7);
    return array;
  } };
}

function settled(lines: PurchaseDraft['lines'], cash: bigint, transfer = 0n, note = ''): PurchaseDraft {
  return setPurchaseSettlement(setPurchaseNote({ ...newPurchaseDraft(), lines }, note),
    { cash_cents: cash, transfer_cents: transfer });
}

const documentInput = (patch: Partial<PurchaseInput> = {}): PurchaseInput => ({
  operation_key: key,
  note: '',
  used_lines: [{ model: 'NS60ZL', quantity: 1, unit_price: '25000.00' }],
  scrap_lines: [{ material_id: 1, kg: '12.400', price_per_kg: '8000.00' }],
  paid_cash: '124200.00',
  paid_transfer: '0.00',
  ...patch,
});

describe('purchase model codes', () => {
  it('trims and upper-cases a typed model and admits the catalogue shapes', () => {
    expect(canonicalPurchaseModelCode('  ns60zl ')).toBe('NS60ZL');
    expect(canonicalPurchaseModelCode('12n5-3b')).toBe('12N5-3B');
    expect(canonicalPurchaseModelCode('55B24L')).toBe('55B24L');
    expect(canonicalPurchaseModelCode('NS 60 ZL')).toBe('NS 60 ZL');
    expect(validPurchaseModelCode('NS60ZL')).toBe(true);
  });

  it('admits the catalogue models that carry a comma', () => {
    // 12N6,5_3B and YB6,5_BS are real catalogue codes: the pattern must not
    // refuse a model the picker offers.
    expect(validPurchaseModelCode('12N6,5_3B')).toBe(true);
    expect(canonicalPurchaseModelCode('yb6,5_bs')).toBe('YB6,5_BS');
  });

  it.each(['', '-NS60ZL', 'Ñ60', 'A'.repeat(41), 'NS60\nZL', 'NS60ZL!', 'NS60ZL;'])('rejects the model %j', value => {
    expect(validPurchaseModelCode(value)).toBe(false);
    expect(() => canonicalPurchaseModelCode(value)).toThrow('Modelo inválido.');
  });

  it('bounds the quantity to the contract range', () => {
    expect(validPurchaseQuantity(1)).toBe(true);
    expect(validPurchaseQuantity(purchaseMaxQuantity)).toBe(true);
    expect(validPurchaseQuantity(0)).toBe(false);
    expect(validPurchaseQuantity(purchaseMaxQuantity + 1)).toBe(false);
    expect(validPurchaseQuantity(1.5)).toBe(false);
  });
});

describe('purchase weight and money', () => {
  it('reads kilograms typed with a comma and shows them with three decimals', () => {
    expect(parseTypedKg('12,4')).toBe(12400n);
    expect(parseTypedKg('1.234,5')).toBe(1234500n);
    expect(parseTypedKg('0,001')).toBe(1n);
    expect(typedKg(12400n)).toBe('12,400');
    expect(typedKg(1234500n)).toBe('1.234,500');
    expect(formatKg(12400n)).toBe('12,400 kg');
    expect(formatKg(-12400n)).toBe('-12,400 kg');
  });

  it.each(['', '12,1234', '1,2,3', '-1', 'abc', '12.4'])('rejects the typed weight %j', value => {
    expect(() => parseTypedKg(value)).toThrow('Peso inválido.');
  });

  it('translates the wire weight between canonical text and integer thousandths', () => {
    expect(kgMilliFromWire('12.400')).toBe(12400n);
    expect(kgMilliFromWire('-12.400')).toBe(-12400n);
    expect(kgMilliToWire(12400n)).toBe('12.400');
    expect(kgMilliToWire(-12400n)).toBe('-12.400');
    for (const bad of ['12.4', '12', '12.4000', '-0.000', '1e3']) {
      expect(() => kgMilliFromWire(bad)).toThrow('Peso inválido.');
    }
  });

  it('shows a signed amount without inventing a second formatter', () => {
    expect(formatSignedMoney(25000n)).toBe(formatMoney(25000n));
    expect(formatSignedMoney(-25000n)).toBe('-Bs 250,00');
    expect(formatSignedMoney(0n)).toBe('Bs 0,00');
  });
});

describe('purchase line amounts and totals', () => {
  it('multiplies quantity by unit price exactly, in cents', () => {
    const line = usedPurchaseLine('NS60ZL', 3, 2_500_000n);
    expect(lineAmountCents(line)).toBe(7_500_000n);
  });

  it('rounds the scrap amount half up to the cent', () => {
    // 0,001 kg × Bs 5,00/kg = Bs 0,005 → one cent.
    expect(scrapLineAmountCents(1n, 500n)).toBe(1n);
    // 0,001 kg × Bs 4,99/kg = Bs 0,00499 → zero cents.
    expect(scrapLineAmountCents(1n, 499n)).toBe(0n);
    // The published example: 12,400 kg × Bs 8.000,00/kg.
    expect(scrapLineAmountCents(12_400n, 800_000n)).toBe(9_920_000n);
    // A counter-document mirrors the exact positive amount.
    expect(scrapLineAmountCents(-12_400n, 800_000n)).toBe(-9_920_000n);
  });

  it('adds every line amount into the document total', () => {
    const lines = [usedPurchaseLine('NS60ZL', 1, 2_500_000n),
      scrapPurchaseLine(cobre.id, cobre.name, 12_400n, 800_000n)];
    expect(purchaseTotalCents(lines)).toBe(12_420_000n);
  });

  it('bars the participation of one received row exactly, without floats', () => {
    // The published artboard split: 300.000 and 105.000 of 459.000.
    expect(purchaseSharePercent(30_000_000n, 45_900_000n)).toBe(65);
    expect(purchaseSharePercent(10_500_000n, 45_900_000n)).toBe(23);
    expect(purchaseSharePercent(5_400_000n, 45_900_000n)).toBe(12);
    // A whole tab is its own hundred percent.
    expect(purchaseSharePercent(45_900_000n, 45_900_000n)).toBe(100);
    // Rounding is half up on the exact ratio, and a counter-document never goes negative.
    expect(purchaseSharePercent(1n, 3n)).toBe(33);
    expect(purchaseSharePercent(2n, 3n)).toBe(67);
    expect(purchaseSharePercent(-5n, 3n)).toBe(0);
    expect(purchaseSharePercent(5n, 0n)).toBe(0);
  });

  it.each([
    ['a zero unit price', () => usedPurchaseLine('NS60ZL', 1, 0n)],
    ['a negative unit price', () => usedPurchaseLine('NS60ZL', 1, -1n)],
    ['a zero quantity', () => usedPurchaseLine('NS60ZL', 0, 100n)],
    ['a fractional quantity', () => usedPurchaseLine('NS60ZL', 1.5, 100n)],
    ['an invalid material', () => scrapPurchaseLine(0, 'Cobre', 1000n, 100n)],
    ['a zero weight', () => scrapPurchaseLine(1, 'Cobre', 0n, 100n)],
    ['a negative weight', () => scrapPurchaseLine(1, 'Cobre', -1n, 100n)],
    ['a zero price per kilogram', () => scrapPurchaseLine(1, 'Cobre', 1000n, 0n)],
  ])('rejects %s', (_, build) => {
    expect(build).toThrow('Compra inválida.');
  });
});

describe('the purchase draft state machine', () => {
  it('starts empty and refuses to build a document without lines', () => {
    expect(newPurchaseDraft()).toEqual({ lines: [], note: '', cash_cents: 0n, transfer_cents: 0n });
    expect(purchaseDraftProblem(newPurchaseDraft())).toContain('al menos una línea');
    expect(() => buildPurchaseInput(newPurchaseDraft(), key)).toThrow('Compra inválida.');
  });

  it('keeps one line per model and per material, replacing the previous one', () => {
    let draft = upsertPurchaseLine(newPurchaseDraft(), usedPurchaseLine('NS60ZL', 1, 100n));
    draft = upsertPurchaseLine(draft, usedPurchaseLine('NS60ZL', 4, 200n));
    draft = upsertPurchaseLine(draft, scrapPurchaseLine(1, 'Cobre', 1000n, 100n));
    draft = upsertPurchaseLine(draft, scrapPurchaseLine(1, 'Cobre', 2000n, 100n));
    expect(draft.lines).toHaveLength(2);
    expect(draft.lines[0]).toMatchObject({ kind: 'used', model: 'NS60ZL', quantity: 4 });
    expect(draft.lines[1]).toMatchObject({ kind: 'scrap', material_id: 1, kg_milli: 2000n });
    expect(removePurchaseLine(draft, 'used:NS60ZL').lines).toHaveLength(1);
  });

  it('bounds each kind of line to the frozen maximum', () => {
    let draft = newPurchaseDraft();
    for (let index = 0; index < purchaseMaxLines; index += 1) {
      draft = upsertPurchaseLine(draft, usedPurchaseLine(`M${index}`, 1, 100n));
    }
    expect(() => upsertPurchaseLine(draft, usedPurchaseLine('ONE-MORE', 1, 100n))).toThrow('Compra inválida.');
  });

  it('requires the settlement to equal the total exactly', () => {
    const lines = [usedPurchaseLine('NS60ZL', 1, 2_500_000n)];
    const exact = settled(lines, 2_500_000n);
    expect(purchaseSettlement(exact)).toEqual({ status: 'exact', paid: 2_500_000n });
    expect(purchaseSettlement(settled(lines, 2_000_000n))).toEqual({ status: 'missing', remaining: 500_000n });
    expect(purchaseSettlement(settled(lines, 2_500_000n, 1n))).toEqual({ status: 'excess', excess: 1n });
    expect(purchaseDraftProblem(settled(lines, 2_000_000n))).toContain('Faltan');
    expect(purchaseDraftProblem(settled(lines, 2_500_000n, 1n))).toContain('Sobran');
    expect(purchaseDraftProblem(exact)).toBeNull();
  });

  it('bounds the free note to 500 characters', () => {
    const lines = [usedPurchaseLine('NS60ZL', 1, 100n)];
    expect(purchaseDraftProblem(settled(lines, 100n, 0n, 'n'.repeat(purchaseMaxNote)))).toBeNull();
    expect(purchaseDraftProblem(settled(lines, 100n, 0n, 'n'.repeat(purchaseMaxNote + 1))))
      .toContain('hasta 500 caracteres');
  });

  it('builds the frozen payload with sorted lines and canonical wire amounts', () => {
    let draft = newPurchaseDraft();
    draft = upsertPurchaseLine(draft, usedPurchaseLine('ZZ99', 2, 100n));
    draft = upsertPurchaseLine(draft, usedPurchaseLine('AA11', 1, 300n));
    draft = upsertPurchaseLine(draft, scrapPurchaseLine(1, 'Cobre', 12_400n, 800_000n));
    draft = setPurchaseNote(draft, '  Remito del día  ');
    draft = setPurchaseSettlement(draft, { cash_cents: 9_920_500n, transfer_cents: 0n });
    const input = buildPurchaseInput(draft, key);
    expect(input).toEqual(documentInput({
      note: '  Remito del día  ',
      used_lines: [{ model: 'AA11', quantity: 1, unit_price: '3.00' }, { model: 'ZZ99', quantity: 2, unit_price: '1.00' }],
      paid_cash: '99205.00',
    }));
    expect(Object.isFrozen(input)).toBe(true);
    expect(Object.isFrozen(input.used_lines)).toBe(true);
    expect(JSON.stringify(input)).toBe('{"operation_key":"purchase_key_0001","note":"  Remito del día  ",'
      + '"used_lines":[{"model":"AA11","quantity":1,"unit_price":"3.00"},{"model":"ZZ99","quantity":2,"unit_price":"1.00"}],'
      + '"scrap_lines":[{"material_id":1,"kg":"12.400","price_per_kg":"8000.00"}],'
      + '"paid_cash":"99205.00","paid_transfer":"0.00"}');
  });

  it('generates a secure operation key with the contract shape', () => {
    const generated = newPurchaseOperationKey(fixedRandom());
    expect(generated).toBe(newPurchaseOperationKey(fixedRandom()));
    expect(generated).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
  });
});

describe('the purchase payload the API admits', () => {
  it('keeps both sortable line lists and canonical amounts', () => {
    const canonical = canonicalPurchaseInput(documentInput({
      used_lines: [{ model: 'ZZ99', quantity: 2, unit_price: '1.00' }, { model: 'AA11', quantity: 1, unit_price: '3.00' }],
      scrap_lines: [{ material_id: 4, kg: '1.000', price_per_kg: '2.00' }],
      paid_cash: '7.00',
      paid_transfer: '0.00',
      note: 'Remito',
    }));
    expect(canonical.used_lines.map(line => line.model)).toEqual(['AA11', 'ZZ99']);
    expect(canonical.scrap_lines.map(line => line.material_id)).toEqual([4]);
    expect(Object.isFrozen(canonical)).toBe(true);
  });

  it.each([
    ['both arrays empty', documentInput({ used_lines: [], scrap_lines: [] })],
    ['a duplicate model', documentInput({ used_lines: [{ model: 'NS60ZL', quantity: 1, unit_price: '1.00' },
      { model: 'NS60ZL', quantity: 2, unit_price: '1.00' }], paid_cash: '124203.00' })],
    ['a duplicate material', documentInput({ scrap_lines: [{ material_id: 1, kg: '1.000', price_per_kg: '1.00' },
      { material_id: 1, kg: '2.000', price_per_kg: '1.00' }], paid_cash: '124203.00' })],
    ['a zero quantity', documentInput({ used_lines: [{ model: 'NS60ZL', quantity: 0, unit_price: '1.00' }] })],
    ['a quantity above the bound', documentInput({ used_lines: [{ model: 'NS60ZL', quantity: 1_000_001, unit_price: '1.00' }] })],
    ['a zero price', documentInput({ used_lines: [{ model: 'NS60ZL', quantity: 1, unit_price: '0.00' }] })],
    ['a non canonical price', documentInput({ used_lines: [{ model: 'NS60ZL', quantity: 1, unit_price: '25000' }] })],
    ['a zero weight', documentInput({ scrap_lines: [{ material_id: 1, kg: '0.000', price_per_kg: '1.00' }] })],
    ['a weight with two decimals', documentInput({ scrap_lines: [{ material_id: 1, kg: '12.40', price_per_kg: '1.00' }] })],
    ['a negative weight', documentInput({ scrap_lines: [{ material_id: 1, kg: '-12.400', price_per_kg: '1.00' }] })],
    ['an invalid material id', documentInput({ scrap_lines: [{ material_id: 0, kg: '1.000', price_per_kg: '1.00' }] })],
    ['a settlement that does not close', documentInput({ paid_cash: '1.00' })],
    ['an open settlement', documentInput({ paid_cash: '124200.00', paid_transfer: '0.01' })],
    ['a short operation key', documentInput({ operation_key: 'k'.repeat(15) })],
    ['a long operation key', documentInput({ operation_key: 'k'.repeat(129) })],
    ['an operation key with forbidden characters', documentInput({ operation_key: 'k'.repeat(30) + '.bad' })],
    ['a note over 500 characters', documentInput({ note: 'n'.repeat(501) })],
    ['a note with NUL', documentInput({ note: 'a\u0000b' })],
    ['an unknown field', { ...documentInput(), extra: true } as unknown as PurchaseInput],
  ])('rejects %s', (_, input) => {
    expect(() => canonicalPurchaseInput(input)).toThrow('Compra inválida.');
  });

  it('accepts the maximum line counts and note at the boundary', () => {
    const used = Array.from({ length: purchaseMaxLines }, (_, index) => ({
      model: `M${index}`, quantity: purchaseMaxQuantity, unit_price: '0.01' }));
    const total = purchaseMaxLines * purchaseMaxQuantity * 1;
    const canonical = canonicalPurchaseInput(documentInput({
      used_lines: used, scrap_lines: [], note: 'n'.repeat(500),
      paid_cash: `${String(total / 100)}.${String(total % 100).padStart(2, '0')}`,
      paid_transfer: '0.00',
    }));
    expect(canonical.used_lines).toHaveLength(purchaseMaxLines);
    expect(canonical.note).toHaveLength(500);
  });
});

describe('the counter-document rules', () => {
  it('makes only an original document reversible', () => {
    expect(purchaseReversible({ id: 7, created_at: '2026-11-11T18:20:00Z', total_cents: 1n, used_units: 1,
      scrap_lines: 0, reverses_purchase_id: null, reversed_by: null })).toBe(true);
    expect(purchaseReversible({ id: 7, created_at: '2026-11-11T18:20:00Z', total_cents: 1n, used_units: 1,
      scrap_lines: 0, reverses_purchase_id: null, reversed_by: 8 })).toBe(false);
    expect(purchaseReversible({ id: 7, created_at: '2026-11-11T18:20:00Z', total_cents: -1n, used_units: -1,
      scrap_lines: 0, reverses_purchase_id: 6, reversed_by: null })).toBe(false);
  });

  it('trims a mandatory reversal reason and bounds it', () => {
    expect(canonicalPurchaseReason('  pesaje mal tipeado  ')).toBe('pesaje mal tipeado');
    for (const bad of ['', '   ', 'n'.repeat(501), 'a\u0000b']) {
      expect(() => canonicalPurchaseReason(bad)).toThrow('Motivo inválido.');
    }
  });
});
