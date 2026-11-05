/**
 * Point of sale model: money, cart, settlement and the document the counter sends.
 *
 * Money is integer cents from end to end (`bigint`). The wire carries canonical decimal
 * text (`"96000.00"`), the counter shows `Bs 96.000,00` and the seller may type either
 * `96.000,00` or `96000,00`; no amount is ever parsed into a binary float.
 */

// ---------------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------------

/** The whole range of `numeric(12,2)` expressed in cents. */
export const maxSaleCents = 999_999_999_999n;

const canonicalMoney = /^(0|[1-9]\d{0,9})\.\d{2}$/;
/** The typed shape: dot thousands groups and an optional comma fraction. */
const typedMoneyShape = /^(0|[1-9]\d*(?:\.\d{3})*)(?:,(\d{1,2}))?$/;

function invalidMoney(): never { throw new Error('Monto inválido.'); }

/** Exact cents of a canonical wire amount (`"96000.00"`). */
export function moneyCents(amount: string): bigint {
  if (typeof amount !== 'string' || !canonicalMoney.test(amount)) return invalidMoney();
  const [whole, fraction] = amount.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction);
  if (cents > maxSaleCents) return invalidMoney();
  return cents;
}

/** The canonical wire amount of an exact amount of cents. */
export function centsToMoney(cents: bigint): string {
  if (typeof cents !== 'bigint' || cents < 0n || cents > maxSaleCents) return invalidMoney();
  const whole = (cents / 100n).toString();
  return `${whole}.${(cents % 100n).toString().padStart(2, '0')}`;
}

function grouped(whole: bigint): string {
  return whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/** The presentation format the counter and the warranty use: `Bs 1.234,56`. */
export function formatMoney(cents: bigint): string {
  if (typeof cents !== 'bigint' || cents < 0n || cents > maxSaleCents) return invalidMoney();
  return `Bs ${grouped(cents / 100n)},${(cents % 100n).toString().padStart(2, '0')}`;
}

/**
 * Exact cents of what the seller typed. In this shape the dot is always the thousands
 * separator and the comma the decimal one, so `1.234` is `1234` and never `1,234`.
 */
export function parseTypedMoney(text: string): bigint {
  if (typeof text !== 'string') return invalidMoney();
  const trimmed = text.trim().replace(/^bs\s*/i, '');
  const match = typedMoneyShape.exec(trimmed);
  if (!match) return invalidMoney();
  const cents = BigInt(match[1].replace(/\./g, '')) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));
  if (cents > maxSaleCents) return invalidMoney();
  return cents;
}

/** The value an amount field shows for a known amount of cents. */
export function typedMoney(cents: bigint): string {
  if (typeof cents !== 'bigint' || cents < 0n || cents > maxSaleCents) return invalidMoney();
  return `${grouped(cents / 100n)},${(cents % 100n).toString().padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------------
// The sellable catalogue, as the counter reads it
// ---------------------------------------------------------------------------------

export type Polarity = 'L' | 'R';

/** One variant of the branch catalogue: its battery, one polarity and its availability. */
export interface SellableVariant {
  readonly variant_id: number;
  readonly catalog_entry_id: number;
  readonly brand: string;
  readonly model: string;
  readonly capacity_ah: string;
  readonly polarity: Polarity;
  /** False when the branch has no price for the battery: the row is shown, never sold. */
  readonly sellable: boolean;
  readonly suggested_price: string | null;
  readonly min_price: string | null;
  readonly existing: bigint;
  readonly reserved: bigint;
  readonly available: bigint;
}

export interface SellablePage {
  readonly page: number;
  readonly page_size: number;
  readonly total_variants: number;
  readonly items: readonly SellableVariant[];
}

// ---------------------------------------------------------------------------------
// The frozen bounds and the messages the counter shows
// ---------------------------------------------------------------------------------

export const maxCartLines = 190;
export const maxQuantity = 1_000_000;
export const minWarrantyMonths = 1;
export const maxWarrantyMonths = 120;
/** The term a line starts with; the seller changes it before issuing the warranty. */
export const defaultWarrantyMonths = 12;

export const posNotSellableReason = 'Sin precio en esta sucursal. No es vendible hasta que el Almacén lo cargue.';
export const posAmountMessage = 'Escribí un monto válido, con hasta dos decimales.';
export const posQuantityMessage = `La cantidad debe ser un número entero de 1 a ${maxQuantity}.`;
export const posMinimumQuantityMessage = 'Cada línea lleva al menos una unidad: usá Quitar para sacarla de la venta.';
export const posWarrantyMessage = `El plazo de la garantía debe ser un número entero de ${minWarrantyMonths} a ${maxWarrantyMonths} meses.`;
export const posLineLimitMessage = `Una venta lleva como máximo ${maxCartLines} líneas.`;
export const posMissingLineMessage = 'La línea ya no está en la venta: volvé a agregarla.';
export const posEmptyCartMessage = 'Agregá al menos una batería para cobrar.';
export const posCustomerNameMessage = 'Escribí el nombre del cliente: la garantía lo exige.';
export const posCustomerTextMessage = 'El teléfono y el documento llevan como máximo 40 caracteres.';
export const posPaymentMethodMessage = 'El mostrador cobra en efectivo o por transferencia.';

export const posMissingMessage = (cents: bigint): string => `Faltan ${formatMoney(cents)} para cubrir el total.`;
export const posExcessMessage = (cents: bigint): string => `Sobran ${formatMoney(cents)}: la suma no puede superar el total.`;
export const posPriceFloorMessage = (minimum: bigint): string =>
  `El precio no puede quedar por debajo del mínimo autorizado ${formatMoney(minimum)}.`;

// ---------------------------------------------------------------------------------
// The cart
// ---------------------------------------------------------------------------------

/** One line of the counter cart: one variant, its quantity, its price and its term. */
export interface CartLine {
  readonly variant_id: number;
  readonly catalog_entry_id: number;
  readonly brand: string;
  readonly model: string;
  readonly capacity_ah: string;
  readonly polarity: Polarity;
  readonly quantity: number;
  readonly unit_price_cents: bigint;
  readonly suggested_price_cents: bigint;
  readonly min_price_cents: bigint;
  readonly warranty_months: number;
}

export type CartEdit =
  | { readonly ok: true; readonly cart: readonly CartLine[] }
  | { readonly ok: false; readonly message: string };

/** `CAR NS40ZL L`: the label a line and a card share. */
export function variantLabel(value: { brand: string; model: string; polarity: Polarity }): string {
  return `${value.brand} ${value.model} ${value.polarity}`;
}

function lineOf(variant: SellableVariant): CartLine | null {
  if (!variant.sellable || variant.suggested_price === null || variant.min_price === null) return null;
  return Object.freeze({
    variant_id: variant.variant_id, catalog_entry_id: variant.catalog_entry_id,
    brand: variant.brand, model: variant.model, capacity_ah: variant.capacity_ah, polarity: variant.polarity,
    quantity: 1, unit_price_cents: moneyCents(variant.suggested_price),
    suggested_price_cents: moneyCents(variant.suggested_price), min_price_cents: moneyCents(variant.min_price),
    warranty_months: defaultWarrantyMonths,
  });
}

/** Adds one unit of a variant: one line per variant, and never an unpriced battery. */
export function addToCart(cart: readonly CartLine[], variant: SellableVariant): CartEdit {
  const existing = cart.find(line => line.variant_id === variant.variant_id);
  if (existing) return changeQuantity(cart, variant.variant_id, 1);
  const line = lineOf(variant);
  if (line === null) return { ok: false, message: posNotSellableReason };
  if (cart.length >= maxCartLines) return { ok: false, message: posLineLimitMessage };
  return { ok: true, cart: [...cart, line] };
}

export function removeFromCart(cart: readonly CartLine[], variantID: number): readonly CartLine[] {
  return cart.filter(line => line.variant_id !== variantID);
}

function replaceLine(cart: readonly CartLine[], variantID: number, patch: Partial<CartLine>): readonly CartLine[] {
  return cart.map(line => line.variant_id === variantID ? Object.freeze({ ...line, ...patch }) : line);
}

/** Sets the quantity of a line, inside the document's bounds. */
export function setQuantity(cart: readonly CartLine[], variantID: number, quantity: number): CartEdit {
  if (!cart.some(line => line.variant_id === variantID)) return { ok: false, message: posMissingLineMessage };
  if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1) {
    return { ok: false, message: posQuantityMessage };
  }
  if (quantity > maxQuantity) return { ok: false, message: posQuantityMessage };
  return { ok: true, cart: replaceLine(cart, variantID, { quantity }) };
}

/** Moves the quantity by one unit with the steppers, always leaving a line with one unit. */
export function changeQuantity(cart: readonly CartLine[], variantID: number, delta: number): CartEdit {
  const line = cart.find(entry => entry.variant_id === variantID);
  if (!line) return { ok: false, message: posMissingLineMessage };
  if (!Number.isInteger(delta) || delta === 0) return { ok: false, message: posQuantityMessage };
  const next = line.quantity + delta;
  if (next < 1) return { ok: false, message: posMinimumQuantityMessage };
  return setQuantity(cart, variantID, next);
}

/** Sets the warranty term the seller states for one line. */
export function setWarranty(cart: readonly CartLine[], variantID: number, months: number): CartEdit {
  if (!cart.some(line => line.variant_id === variantID)) return { ok: false, message: posMissingLineMessage };
  if (typeof months !== 'number' || !Number.isInteger(months)
    || months < minWarrantyMonths || months > maxWarrantyMonths) {
    return { ok: false, message: posWarrantyMessage };
  }
  return { ok: true, cart: replaceLine(cart, variantID, { warranty_months: months }) };
}

/** Sets the charged price from what the seller typed, never under the branch minimum. */
export function setUnitPrice(cart: readonly CartLine[], variantID: number, typed: string): CartEdit {
  const line = cart.find(entry => entry.variant_id === variantID);
  if (!line) return { ok: false, message: posMissingLineMessage };
  let cents: bigint;
  try { cents = parseTypedMoney(typed); } catch { return { ok: false, message: posAmountMessage }; }
  if (cents < line.min_price_cents) return { ok: false, message: posPriceFloorMessage(line.min_price_cents) };
  return { ok: true, cart: replaceLine(cart, variantID, { unit_price_cents: cents }) };
}

export function lineSubtotal(line: CartLine): bigint {
  return line.unit_price_cents * BigInt(line.quantity);
}

export function cartTotal(cart: readonly CartLine[]): bigint {
  return cart.reduce((total, line) => total + lineSubtotal(line), 0n);
}

export function cartCount(cart: readonly CartLine[]): number {
  return cart.reduce((count, line) => count + line.quantity, 0);
}

// ---------------------------------------------------------------------------------
// The settlement: one amount per method the counter offers
// ---------------------------------------------------------------------------------

/** The counter offers cash and transfer only; the contract admits card as well. */
export type CounterPaymentMethod = 'cash' | 'transfer';
export const counterPaymentMethods: readonly CounterPaymentMethod[] = ['cash', 'transfer'];

const methodNames: Record<string, string> = {
  cash: 'Efectivo', card: 'Tarjeta', transfer: 'Transferencia', mixed: 'Mixto',
};
const methodNouns: Record<string, string> = {
  cash: 'efectivo', card: 'tarjeta', transfer: 'transferencia',
};

export function paymentLabel(method: string): string {
  return methodNames[method] ?? 'Forma de pago desconocida';
}

/** The settlement of one sale: exactly one amount per offered method. */
export interface PaymentSplit {
  readonly cash_cents: bigint;
  readonly transfer_cents: bigint;
}

export const emptyPayments: PaymentSplit = Object.freeze({ cash_cents: 0n, transfer_cents: 0n });

function isCounterMethod(method: string): method is CounterPaymentMethod {
  return method === 'cash' || method === 'transfer';
}

export function paymentAmount(split: PaymentSplit, method: CounterPaymentMethod): bigint {
  return method === 'cash' ? split.cash_cents : split.transfer_cents;
}

export function setPaymentAmount(split: PaymentSplit, method: CounterPaymentMethod,
  cents: bigint): PaymentSplit {
  return method === 'cash' ? { ...split, cash_cents: cents } : { ...split, transfer_cents: cents };
}

/** Reads one typed field of the settlement: an empty field is a method that did not pay. */
export function setPayment(split: PaymentSplit, method: CounterPaymentMethod,
  typed: string): { readonly ok: true; readonly split: PaymentSplit } | { readonly ok: false; readonly message: string } {
  if (!isCounterMethod(method)) return { ok: false, message: posPaymentMethodMessage };
  const trimmed = typeof typed === 'string' ? typed.trim() : null;
  if (trimmed === null) return { ok: false, message: posAmountMessage };
  if (trimmed === '') return { ok: true, split: setPaymentAmount(split, method, 0n) };
  try { return { ok: true, split: setPaymentAmount(split, method, parseTypedMoney(trimmed)) }; }
  catch { return { ok: false, message: posAmountMessage }; }
}

export function paymentsTotal(split: PaymentSplit): bigint {
  return split.cash_cents + split.transfer_cents;
}

export type Settlement =
  | { readonly status: 'exact'; readonly paid: bigint }
  | { readonly status: 'missing'; readonly remaining: bigint }
  | { readonly status: 'excess'; readonly excess: bigint };

/** Compares the settlement against the total, exactly and in cents. */
export function settlement(total: bigint, split: PaymentSplit): Settlement {
  const paid = paymentsTotal(split);
  if (paid === total) return { status: 'exact', paid };
  if (paid < total) return { status: 'missing', remaining: total - paid };
  return { status: 'excess', excess: paid - total };
}

export function isClosed(total: bigint, split: PaymentSplit): boolean {
  return settlement(total, split).status === 'exact';
}

/** The line under the settlement: how the sum stands against the total. */
export function moneySumMessage(total: bigint, split: PaymentSplit): string {
  const state = settlement(total, split);
  if (state.status === 'exact') return `Suma ${formatMoney(state.paid)} · cubre el total`;
  if (state.status === 'missing') return posMissingMessage(state.remaining);
  return posExcessMessage(state.excess);
}

/**
 * The `Resto` shortcut: fills the open amount into the first offered method that holds
 * nothing. When both methods already hold money it guesses nothing and answers null.
 */
export function fillRemaining(split: PaymentSplit, total: bigint): PaymentSplit | null {
  const open = total - paymentsTotal(split);
  if (open <= 0n) return null;
  for (const method of counterPaymentMethods) {
    if (paymentAmount(split, method) === 0n) return setPaymentAmount(split, method, open);
  }
  return null;
}

export interface PaymentWire { readonly method: string; readonly amount: string }

/** The settlement as the contract takes it: only the methods that paid, frozen order. */
export function paymentsWire(split: PaymentSplit): readonly PaymentWire[] {
  return counterPaymentMethods
    .filter(method => paymentAmount(split, method) > 0n)
    .map(method => ({ method, amount: centsToMoney(paymentAmount(split, method)) }));
}

/** `Mixto: Bs 40.000,00 efectivo + Bs 56.000,00 transferencia`, or the single method. */
export function paymentBreakdown(payments: readonly PaymentWire[]): string {
  const parts = payments.map(payment => `${formatMoney(moneyCents(payment.amount))} ${methodNouns[payment.method] ?? payment.method}`);
  if (parts.length === 1) return `${paymentLabel(payments[0].method)}: ${parts[0]}`;
  return `${paymentLabel('mixed')}: ${parts.join(' + ')}`;
}

// ---------------------------------------------------------------------------------
// The document the counter sends
// ---------------------------------------------------------------------------------

export interface SaleCustomer {
  readonly name: string;
  readonly phone: string;
  readonly document: string;
}

export const emptyCustomer: SaleCustomer = Object.freeze({ name: '', phone: '', document: '' });

export interface SaleLineWire {
  readonly variant_id: number;
  readonly quantity: number;
  readonly unit_price: string;
  readonly warranty_months: number;
}

/** The exact body of `POST /api/sales`, frozen before it leaves the counter. */
export interface CreateSaleInput {
  readonly payments: readonly PaymentWire[];
  readonly customer: SaleCustomer;
  readonly lines: readonly SaleLineWire[];
}

export type SalePreparation =
  | { readonly ok: true; readonly input: CreateSaleInput; readonly total_cents: bigint }
  | { readonly ok: false; readonly message: string };

function boundedText(value: unknown, max: number): boolean {
  return typeof value === 'string' && !value.includes('\0') && value.isWellFormed() && value.length <= max;
}

/**
 * Admits the sale the seller is about to charge: one or more lines, a price at or above
 * each minimum, a term inside its bounds, a settlement that closes exactly against the
 * total and a client the warranty can name. It returns the exact payload, or the message
 * that states what has to be fixed first.
 */
export function prepareSale(cart: readonly CartLine[], split: PaymentSplit, customer: SaleCustomer): SalePreparation {
  if (cart.length === 0) return { ok: false, message: posEmptyCartMessage };
  if (cart.length > maxCartLines) return { ok: false, message: posLineLimitMessage };
  const variants = new Set<number>();
  const lines: SaleLineWire[] = [];
  for (const line of cart) {
    if (variants.has(line.variant_id)) return { ok: false, message: posMissingLineMessage };
    variants.add(line.variant_id);
    if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > maxQuantity) {
      return { ok: false, message: posQuantityMessage };
    }
    if (!Number.isInteger(line.warranty_months)
      || line.warranty_months < minWarrantyMonths || line.warranty_months > maxWarrantyMonths) {
      return { ok: false, message: posWarrantyMessage };
    }
    if (line.unit_price_cents < line.min_price_cents) {
      return { ok: false, message: posPriceFloorMessage(line.min_price_cents) };
    }
    lines.push({ variant_id: line.variant_id, quantity: line.quantity,
      unit_price: centsToMoney(line.unit_price_cents), warranty_months: line.warranty_months });
  }
  const total = cartTotal(cart);
  const state = settlement(total, split);
  if (state.status === 'missing') return { ok: false, message: posMissingMessage(state.remaining) };
  if (state.status === 'excess') return { ok: false, message: posExcessMessage(state.excess) };
  if (!boundedText(customer.name, 120)) return { ok: false, message: posCustomerNameMessage };
  const name = customer.name.trim();
  if (name === '') return { ok: false, message: posCustomerNameMessage };
  if (!boundedText(customer.phone, 40) || !boundedText(customer.document, 40)) {
    return { ok: false, message: posCustomerTextMessage };
  }
  return {
    ok: true, total_cents: total,
    input: {
      payments: paymentsWire(split),
      customer: { name, phone: customer.phone, document: customer.document },
      lines,
    },
  };
}
