import { describe, expect, it } from 'vitest';
import {
  addToCart, cartCount, cartTotal, centsToMoney, changeQuantity, defaultWarrantyMonths, emptyCustomer, emptyPayments,
  fillRemaining, formatMoney, lineSubtotal, maxWarrantyMonths, minWarrantyMonths, moneyCents, moneySumMessage,
  parseTypedMoney, paymentAmount, paymentBreakdown, paymentLabel, paymentsTotal, paymentsWire, posEmptyCartMessage,
  posCustomerNameMessage, posExcessMessage, posMissingMessage, posNotSellableReason, posPriceFloorMessage,
  posWarrantyMessage, prepareSale, removeFromCart, setPayment, setPaymentAmount, setQuantity, setUnitPrice, setWarranty,
  settlement, typedMoney, variantLabel, type CartLine, type SellableVariant,
} from './pointOfSaleModel';

/** The counter's sellable variant: its battery carries the pair, the variant one polarity. */
const item = (overrides: Partial<SellableVariant> = {}): SellableVariant => ({
  variant_id: 1, catalog_entry_id: 1, brand: 'CAR', model: 'NS40ZL', capacity_ah: '35', polarity: 'L',
  sellable: true, suggested_price: '96000.00', min_price: '85000.00',
  existing: 12n, reserved: 0n, available: 12n, ...overrides,
});
const toyo = (): SellableVariant => item({
  variant_id: 3, catalog_entry_id: 3, brand: 'TOYO', model: 'NS60L', capacity_ah: '45', polarity: 'R',
  suggested_price: '118000.00', min_price: '100000.00', existing: 7n, available: 7n,
});
/** A battery the branch has no price for: the row is shown, the action is not offered. */
const unpriced = (): SellableVariant => item({
  variant_id: 5, catalog_entry_id: 4, brand: 'HYBRID', model: 'BT54L', capacity_ah: '54', polarity: 'L',
  sellable: false, suggested_price: null, min_price: null, existing: 4n, available: 4n,
});

function cartOf(...items: SellableVariant[]): readonly CartLine[] {
  let cart: readonly CartLine[] = [];
  for (const entry of items) {
    const added = addToCart(cart, entry);
    expect(added.ok).toBe(true);
    if (added.ok) cart = added.cart;
  }
  return cart;
}
function priced(cart: readonly CartLine[], variantID: number, typed: string): readonly CartLine[] {
  const edited = setUnitPrice(cart, variantID, typed);
  expect(edited.ok).toBe(true);
  return edited.ok ? edited.cart : cart;
}

describe('counter money', () => {
  it('reads and writes the canonical wire amount without a float', () => {
    expect(moneyCents('96000.00')).toBe(9_600_000n);
    expect(moneyCents('0.01')).toBe(1n);
    expect(moneyCents('9999999999.99')).toBe(999_999_999_999n);
    expect(centsToMoney(9_600_000n)).toBe('96000.00');
    expect(centsToMoney(1n)).toBe('0.01');
  });

  it.each([
    ['an amount with no fraction', '96000'], ['one decimal', '96000.0'], ['three decimals', '96000.000'],
    ['a padded integer', '096000.00'], ['a negative amount', '-1.00'], ['a decimal comma', '96000,00'],
    ['an empty amount', ''], ['a non numeric amount', 'ochenta'],
  ])('refuses the wire amount %s', (_, amount) => {
    expect(() => moneyCents(amount)).toThrow();
  });

  it('formats bolivianos with dot thousands and comma decimals', () => {
    expect(formatMoney(9_600_000n)).toBe('Bs 96.000,00');
    expect(formatMoney(12_345_600n)).toBe('Bs 123.456,00');
    expect(formatMoney(0n)).toBe('Bs 0,00');
    expect(formatMoney(5n)).toBe('Bs 0,05');
    expect(formatMoney(999_999_999_999n)).toBe('Bs 9.999.999.999,99');
  });

  it('parses what the seller types, grouped or not', () => {
    expect(parseTypedMoney('96.000,00')).toBe(9_600_000n);
    expect(parseTypedMoney('96000,00')).toBe(9_600_000n);
    expect(parseTypedMoney('96000')).toBe(9_600_000n);
    expect(parseTypedMoney('96.000')).toBe(9_600_000n);
    expect(parseTypedMoney('1.234.567,05')).toBe(123_456_705n);
    expect(parseTypedMoney(' 96.000,00 ')).toBe(9_600_000n);
    expect(parseTypedMoney('Bs 96.000,00')).toBe(9_600_000n);
    expect(parseTypedMoney('96.000,5')).toBe(9_600_050n);
    expect(parseTypedMoney('0,50')).toBe(50n);
    // The point is always the thousands separator, never a decimal one.
    expect(parseTypedMoney('1.234')).toBe(123_400n);
  });

  it.each([
    ['an empty field', ''], ['a negative amount', '-1'], ['three decimals', '1,234'],
    ['a two-digit group', '1.23'], ['a decimal point as the separator', '96.000,00,00'],
    ['text', 'ochenta'], ['a bare comma', ',50'],
  ])('refuses the typed amount %s', (_, typed) => {
    expect(() => parseTypedMoney(typed)).toThrow();
  });

  it('shows an amount in the entry field', () => {
    expect(typedMoney(9_600_000n)).toBe('96.000,00');
    expect(typedMoney(50n)).toBe('0,50');
    expect(typedMoney(123_456_705n)).toBe('1.234.567,05');
  });
});

describe('the cart', () => {
  it('holds one line per variant, starting from the suggested price and a term', () => {
    const cart = cartOf(item());
    expect(cart).toHaveLength(1);
    expect(cart[0]).toMatchObject({
      variant_id: 1, catalog_entry_id: 1, brand: 'CAR', model: 'NS40ZL', capacity_ah: '35', polarity: 'L',
      quantity: 1, unit_price_cents: 9_600_000n, suggested_price_cents: 9_600_000n, min_price_cents: 8_500_000n,
      warranty_months: defaultWarrantyMonths,
    });
    expect(defaultWarrantyMonths).toBe(12);
    expect(variantLabel(cart[0])).toBe('CAR NS40ZL L');
  });

  it('bumps the quantity instead of repeating the variant', () => {
    const first = addToCart(cartOf(item()), item());
    expect(first.ok).toBe(true);
    const cart = first.ok ? first.cart : [];
    expect(cart).toHaveLength(1);
    expect(cart[0].quantity).toBe(2);
    expect(cartCount(cart)).toBe(2);
  });

  it('refuses a variant this branch has no price for, and never hides why', () => {
    const refused = addToCart([], unpriced());
    expect(refused).toEqual({ ok: false, message: posNotSellableReason });
    expect(posNotSellableReason).toBe('Sin precio en esta sucursal. No es vendible hasta que el Almacén lo cargue.');
  });

  it('refuses a line the seller cannot add because the document is full', () => {
    const full: readonly CartLine[] = Array.from({ length: 190 }, (_, index) => ({
      variant_id: index + 1, catalog_entry_id: index + 1, brand: 'CAR', model: `M${index + 1}`,
      capacity_ah: '35', polarity: 'L', quantity: 1, unit_price_cents: 9_600_000n,
      suggested_price_cents: 9_600_000n, min_price_cents: 8_500_000n, warranty_months: 12,
    }));
    expect(addToCart(full, item({ variant_id: 500 })).ok).toBe(false);
  });

  it('removes a line and computes exact totals', () => {
    const cart = priced(cartOf(item(), toyo()), 1, '96.000,00');
    const bump = changeQuantity(cart, 1, 1);
    expect(bump.ok).toBe(true);
    const two = bump.ok ? bump.cart : cart;
    expect(lineSubtotal(two[0])).toBe(19_200_000n);
    expect(lineSubtotal(two[1])).toBe(11_800_000n);
    expect(cartTotal(two)).toBe(31_000_000n);
    expect(formatMoney(cartTotal(two))).toBe('Bs 310.000,00');
    // 2 x 96.000,00 + 1 x 112.000,00, the artboard's own document.
    const artboard = priced(two, 3, '112.000,00');
    expect(cartTotal(artboard)).toBe(30_400_000n);
    expect(formatMoney(cartTotal(artboard))).toBe('Bs 304.000,00');
    const left = removeFromCart(artboard, 3);
    expect(left).toHaveLength(1);
    expect(left[0].variant_id).toBe(1);
    expect(cartTotal([])).toBe(0n);
  });

  it('keeps the quantity inside its bounds', () => {
    const cart = cartOf(item());
    expect(changeQuantity(cart, 1, -1)).toEqual({ ok: false, message: expect.stringContaining('una unidad') });
    expect(setQuantity(cart, 1, 0).ok).toBe(false);
    expect(setQuantity(cart, 1, 1.5).ok).toBe(false);
    expect(setQuantity(cart, 1, 1_000_001).ok).toBe(false);
    const max = setQuantity(cart, 1, 1_000_000);
    expect(max.ok).toBe(true);
    expect(max.ok && max.cart[0].quantity).toBe(1_000_000);
  });

  it('keeps the warranty term between one and hundred twenty months', () => {
    const cart = cartOf(item());
    expect(setWarranty(cart, 1, minWarrantyMonths).ok).toBe(true);
    expect(setWarranty(cart, 1, maxWarrantyMonths).ok).toBe(true);
    expect(setWarranty(cart, 1, 0)).toEqual({ ok: false, message: posWarrantyMessage });
    expect(setWarranty(cart, 1, 121)).toEqual({ ok: false, message: posWarrantyMessage });
    expect(setWarranty(cart, 1, 12.5)).toEqual({ ok: false, message: posWarrantyMessage });
    expect(setWarranty(cart, 1, Number.NaN)).toEqual({ ok: false, message: posWarrantyMessage });
    const term = setWarranty(cart, 1, 24);
    expect(term.ok && term.cart[0].warranty_months).toBe(24);
  });

  it('refuses a price under the branch minimum before sending anything', () => {
    const cart = cartOf(item());
    expect(setUnitPrice(cart, 1, '84.999,99')).toEqual({
      ok: false, message: posPriceFloorMessage(8_500_000n),
    });
    expect(posPriceFloorMessage(8_500_000n))
      .toBe('El precio no puede quedar por debajo del mínimo autorizado Bs 85.000,00.');
    expect(setUnitPrice(cart, 1, '85000,00').ok).toBe(true);
    expect(setUnitPrice(cart, 1, '96.000,00')).toEqual({ ok: true, cart: expect.any(Array) });
    expect(setUnitPrice(cart, 1, 'ochenta').ok).toBe(false);
  });

  it('never stores an unpriced line, even when the edit is asked for directly', () => {
    const cart = cartOf(item());
    expect(setUnitPrice(cart, 1, '0,00').ok).toBe(false);
  });
});

describe('the payment split', () => {
  it('holds one amount per offered method and totals them exactly', () => {
    expect(paymentsTotal(emptyPayments)).toBe(0n);
    const split = setPaymentAmount(setPaymentAmount(emptyPayments, 'cash', 20_000_000n), 'transfer', 10_400_000n);
    expect(paymentAmount(split, 'cash')).toBe(20_000_000n);
    expect(paymentAmount(split, 'transfer')).toBe(10_400_000n);
    expect(paymentsTotal(split)).toBe(30_400_000n);
    expect(formatMoney(paymentsTotal(split))).toBe('Bs 304.000,00');
  });

  it('reports the missing, the excess or the exact difference in cents', () => {
    const total = 30_400_000n;
    const exact = setPaymentAmount(setPaymentAmount(emptyPayments, 'cash', 20_000_000n), 'transfer', 10_400_000n);
    expect(settlement(total, exact)).toEqual({ status: 'exact', paid: 30_400_000n });
    const missing = setPaymentAmount(emptyPayments, 'cash', 20_000_000n);
    expect(settlement(total, missing)).toEqual({ status: 'missing', remaining: 10_400_000n });
    const excess = setPaymentAmount(setPaymentAmount(emptyPayments, 'cash', 20_000_000n), 'transfer', 11_000_000n);
    expect(settlement(total, excess)).toEqual({ status: 'excess', excess: 600_000n });
    expect(moneySumMessage(total, exact)).toBe('Suma Bs 304.000,00 · cubre el total');
    expect(moneySumMessage(total, missing)).toBe(posMissingMessage(10_400_000n));
    expect(posMissingMessage(10_400_000n)).toBe('Faltan Bs 104.000,00 para cubrir el total.');
    expect(moneySumMessage(total, excess)).toBe(posExcessMessage(600_000n));
    expect(posExcessMessage(600_000n)).toBe('Sobran Bs 6.000,00: la suma no puede superar el total.');
  });

  it('fills the open amount into the method that has none', () => {
    const total = 30_400_000n;
    const cash = setPaymentAmount(emptyPayments, 'cash', 20_000_000n);
    const filled = fillRemaining(cash, total);
    expect(filled).not.toBeNull();
    expect(paymentAmount(filled!, 'transfer')).toBe(10_400_000n);
    expect(settlement(total, filled!)).toEqual({ status: 'exact', paid: total });
    // Both methods already hold an amount and the split does not close: nothing is guessed.
    const both = setPaymentAmount(setPaymentAmount(emptyPayments, 'cash', 1_000_000n), 'transfer', 1_000_000n);
    expect(fillRemaining(both, total)).toBeNull();
    expect(fillRemaining(cash, 0n)).toBeNull();
  });

  it('reads a typed amount into the offered method and refuses the rest', () => {
    const split = setPayment(emptyPayments, 'cash', '200.000,00');
    expect(split).toEqual({ ok: true, split: { cash_cents: 20_000_000n, transfer_cents: 0n } });
    expect(setPayment(emptyPayments, 'cash', '')).toEqual({ ok: true, split: emptyPayments });
    expect(setPayment(emptyPayments, 'cash', 'dos mil')).toEqual({ ok: false, message: expect.any(String) });
    // The counter offers cash and transfer only: a card is not a field of this screen.
    expect(setPayment(emptyPayments, 'card' as never, '10,00').ok).toBe(false);
  });

  it('sends only the methods that paid, in the frozen order', () => {
    expect(paymentsWire(emptyPayments)).toEqual([]);
    expect(paymentsWire(setPaymentAmount(emptyPayments, 'transfer', 5_000n)))
      .toEqual([{ method: 'transfer', amount: '50.00' }]);
    const split = setPaymentAmount(setPaymentAmount(emptyPayments, 'transfer', 10_400_000n), 'cash', 20_000_000n);
    expect(paymentsWire(split)).toEqual([
      { method: 'cash', amount: '200000.00' }, { method: 'transfer', amount: '104000.00' },
    ]);
  });

  it('labels every method the document can carry', () => {
    expect(paymentLabel('cash')).toBe('Efectivo');
    expect(paymentLabel('transfer')).toBe('Transferencia');
    expect(paymentLabel('card')).toBe('Tarjeta');
    expect(paymentLabel('mixed')).toBe('Mixto');
    expect(paymentBreakdown([
      { method: 'cash', amount: '40000.00' }, { method: 'transfer', amount: '56000.00' },
    ])).toBe('Mixto: Bs 40.000,00 efectivo + Bs 56.000,00 transferencia');
  });
});

describe('the sale the counter sends', () => {
  const cart = priced(cartOf(item(), toyo()), 3, '112.000,00');
  const bump = changeQuantity(cart, 1, 1);
  const document = bump.ok ? bump.cart : cart;
  const split = setPaymentAmount(setPaymentAmount(emptyPayments, 'cash', 20_000_000n), 'transfer', 10_400_000n);
  const customer = { name: '  Marta Giménez ', phone: '381 555 0198', document: '27.884.310' };

  it('builds the exact payload of the contract once the sum closes', () => {
    expect(prepareSale(document, split, customer)).toEqual({
      ok: true, total_cents: 30_400_000n,
      input: {
        payments: [{ method: 'cash', amount: '200000.00' }, { method: 'transfer', amount: '104000.00' }],
        customer: { name: 'Marta Giménez', phone: '381 555 0198', document: '27.884.310' },
        lines: [
          { variant_id: 1, quantity: 2, unit_price: '96000.00', warranty_months: 12 },
          { variant_id: 3, quantity: 1, unit_price: '112000.00', warranty_months: 12 },
        ],
      },
    });
  });

  it('refuses an empty cart', () => {
    expect(prepareSale([], split, customer)).toEqual({ ok: false, message: posEmptyCartMessage });
  });

  it('refuses a sum that does not close exactly', () => {
    const open = setPaymentAmount(emptyPayments, 'cash', 20_000_000n);
    expect(prepareSale(document, open, customer)).toEqual({ ok: false, message: posMissingMessage(10_400_000n) });
    const over = setPaymentAmount(setPaymentAmount(emptyPayments, 'cash', 20_000_000n), 'transfer', 11_000_000n);
    expect(prepareSale(document, over, customer)).toEqual({ ok: false, message: posExcessMessage(600_000n) });
  });

  it('refuses a sale without a client name, because the warranty names one', () => {
    expect(prepareSale(document, split, { ...customer, name: '   ' }))
      .toEqual({ ok: false, message: posCustomerNameMessage });
    expect(prepareSale(document, split, { ...customer, name: 'x'.repeat(121) }).ok).toBe(false);
    expect(prepareSale(document, split, { ...customer, phone: 'x'.repeat(41) }).ok).toBe(false);
    expect(prepareSale(document, split, { ...customer, document: 'x'.repeat(41) }).ok).toBe(false);
    expect(emptyCustomer).toEqual({ name: '', phone: '', document: '' });
  });

  it('refuses a document whose line would break a frozen rule', () => {
    const broken = document.map(line => line.variant_id === 1 ? { ...line, warranty_months: 0 } : line);
    expect(prepareSale(broken, split, customer)).toEqual({ ok: false, message: posWarrantyMessage });
    const cheap = document.map(line => line.variant_id === 1 ? { ...line, unit_price_cents: 1n } : line);
    expect(prepareSale(cheap, split, customer)).toEqual({ ok: false, message: posPriceFloorMessage(8_500_000n) });
  });
});
