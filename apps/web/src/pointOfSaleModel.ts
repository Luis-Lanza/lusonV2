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
/** The serial is read off the battery at the counter: free text, never a stock identity. */
export const maxSerialLength = 64;
/** The one free field S1 admits on the sale header. */
export const maxCustomerAddress = 200;
/** The whole body limit of the document, in physical batteries. */
export const maxSaleUnits = 1000;
/** The term a unit starts with; the seller changes it, or clears it, before issuing. */
export const defaultWarrantyMonths = 12;

export const posNotSellableReason = 'Sin precio en esta sucursal. No es vendible hasta que el Almacén lo cargue.';
export const posAmountMessage = 'Escribí un monto válido, con hasta dos decimales.';
export const posQuantityMessage = `La cantidad debe ser un número entero de 1 a ${maxQuantity}.`;
export const posMinimumQuantityMessage = 'Cada línea lleva al menos una unidad: usá Quitar para sacarla de la venta.';
export const posWarrantyMessage = `El plazo de la garantía debe ser un número entero de ${minWarrantyMonths} a ${maxWarrantyMonths} meses.`;
export const posSerialMessage = 'Cada batería lleva su número de serie: leelo de la batería y anotalo.';
export const posSerialLengthMessage = `El número de serie lleva hasta ${maxSerialLength} caracteres.`;
export const posDuplicateSerialMessage = 'Ese número de serie ya está en esta venta: cada batería se vende una sola vez.';
export const posUnitsMessage = 'Cada línea lleva una unidad por batería: revisá la cantidad.';
export const posMissingUnitMessage = 'Esa unidad ya no está en la línea: revisá la cantidad.';
export const posUnitTotalMessage = `Una venta lleva como máximo ${maxSaleUnits} unidades.`;
export const posAddressMessage = `La dirección o barrio lleva como máximo ${maxCustomerAddress} caracteres.`;
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

/** The term of one unit as the counter and the history name it: a number of months or its absence. */
export function warrantyLabel(months: number | null): string {
  if (months === null) return 'Sin garantía';
  return `${months} ${months === 1 ? 'mes' : 'meses'}`;
}

// ---------------------------------------------------------------------------------
// The cart
// ---------------------------------------------------------------------------------

/**
 * One physical battery of the cart: the serial the seller reads and its term, `null` when
 * the sale carries no warranty for this unit. There is no zero-month term.
 */
export interface CartUnit {
  readonly serial_number: string;
  readonly warranty_months: number | null;
}

/** One line of the counter cart: one variant, its quantity, its price and its units. */
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
  /** One entry per physical battery, in the order the seller wrote them. */
  readonly units: readonly CartUnit[];
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
    units: Object.freeze([newUnit()]),
  });
}

/** A battery the seller has not written yet: no serial, and the default term (D5). */
function newUnit(): CartUnit {
  return Object.freeze({ serial_number: '', warranty_months: defaultWarrantyMonths });
}

/** One unit row per battery: growing adds batteries, shrinking drops the trailing ones. */
function unitsFor(units: readonly CartUnit[], quantity: number): readonly CartUnit[] {
  if (quantity <= units.length) return Object.freeze(units.slice(0, quantity));
  const grown = [...units];
  while (grown.length < quantity) grown.push(newUnit());
  return Object.freeze(grown);
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
  const line = cart.find(entry => entry.variant_id === variantID);
  if (!line) return { ok: false, message: posMissingLineMessage };
  if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1) {
    return { ok: false, message: posQuantityMessage };
  }
  if (quantity > maxQuantity) return { ok: false, message: posQuantityMessage };
  // Every battery is a row with its own serial: a line never holds more than a whole sale.
  if (quantity > maxSaleUnits) return { ok: false, message: posUnitTotalMessage };
  return { ok: true, cart: replaceLine(cart, variantID, { quantity, units: unitsFor(line.units, quantity) }) };
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

/** Sets the warranty term the seller states for every unit of one line (D5). */
export function setWarranty(cart: readonly CartLine[], variantID: number, months: number | null): CartEdit {
  const line = cart.find(entry => entry.variant_id === variantID);
  if (!line) return { ok: false, message: posMissingLineMessage };
  if (months !== null && !validTerm(months)) return { ok: false, message: posWarrantyMessage };
  const units = line.units.map(unit => Object.freeze({ ...unit, warranty_months: months }));
  return { ok: true, cart: replaceLine(cart, variantID, { units: Object.freeze(units) }) };
}

function validTerm(months: unknown): months is number {
  return typeof months === 'number' && Number.isInteger(months)
    && months >= minWarrantyMonths && months <= maxWarrantyMonths;
}

/** Writes the serial the seller read off one battery of the line. */
export function setUnitSerial(cart: readonly CartLine[], variantID: number, index: number,
  serial: string): CartEdit {
  return editUnit(cart, variantID, index, unit => {
    if (typeof serial !== 'string' || serial.includes('\0') || !serial.isWellFormed()) {
      return { ok: false, message: posSerialMessage };
    }
    if (serial.length > maxSerialLength) return { ok: false, message: posSerialLengthMessage };
    return { ok: true, unit: Object.freeze({ ...unit, serial_number: serial }) };
  });
}

/** Sets the term of one battery, or its explicit absence with `null`. */
export function setUnitWarranty(cart: readonly CartLine[], variantID: number, index: number,
  months: number | null): CartEdit {
  if (months !== null && !validTerm(months)) return { ok: false, message: posWarrantyMessage };
  return editUnit(cart, variantID, index, unit => ({
    ok: true, unit: Object.freeze({ ...unit, warranty_months: months }),
  }));
}

type UnitEdit =
  | { readonly ok: true; readonly unit: CartUnit }
  | { readonly ok: false; readonly message: string };

function editUnit(cart: readonly CartLine[], variantID: number, index: number,
  edit: (unit: CartUnit) => UnitEdit): CartEdit {
  const line = cart.find(entry => entry.variant_id === variantID);
  if (!line) return { ok: false, message: posMissingLineMessage };
  if (!Number.isInteger(index) || index < 0 || index >= line.units.length) {
    return { ok: false, message: posMissingUnitMessage };
  }
  const written = edit(line.units[index]);
  if (!written.ok) return { ok: false, message: written.message };
  const units = line.units.map((unit, position) => position === index ? written.unit : unit);
  return { ok: true, cart: replaceLine(cart, variantID, { units: Object.freeze(units) }) };
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

/**
 * The refusal of a serial that is already sold, in the seller's words: it names the serial the
 * server compared and points at the units of this counter that carry it (D8), so the seller
 * knows which row to fix instead of reading that the answer was invalid.
 */
export function serialSoldProblem(cart: readonly CartLine[], serial: string): string {
  // D2 compares after trimming and case folding, the way the database does.
  const key = serial.trim().toLowerCase();
  const rows: string[] = [];
  if (key !== '') {
    for (const line of cart) {
      line.units.forEach((unit, index) => {
        if (typeof unit.serial_number === 'string' && unit.serial_number.trim().toLowerCase() === key) {
          rows.push(`la unidad ${index + 1} de ${variantLabel(line)}`);
        }
      });
    }
  }
  if (rows.length === 0) return `El número de serie ${serial} ya se vendió en otra venta. No se registró nada.`;
  const carries = rows.length === 1 ? `lo lleva ${rows[0]}` : `lo llevan ${rows.join(' y ')}`;
  return `El número de serie ${serial} ya se vendió: ${carries}. Corregí ese serial antes de cobrar.`
    + ' No se registró nada.';
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
  /** The one free field of S1: an address or a neighbourhood, empty when absent. */
  readonly address: string;
}

export const emptyCustomer: SaleCustomer = Object.freeze({ name: '', phone: '', document: '', address: '' });

/** One physical battery on the wire: its serial, and its term or the explicit absence. */
export interface SaleUnitWire {
  readonly serial_number: string;
  readonly warranty_months: number | null;
}

export interface SaleLineWire {
  readonly variant_id: number;
  readonly quantity: number;
  readonly unit_price: string;
  readonly units: readonly SaleUnitWire[];
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
 * The optional free field of the client, trimmed before it is bounded because that is how
 * the server canonicalizes it: a trailing space never turns a real sale into `invalid_response`
 * when the answered document carries the trimmed address (D9).
 */
function trimmedText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return boundedText(trimmed, max) ? trimmed : null;
}

type UnitsCheck =
  | { readonly ok: true; readonly units: readonly SaleUnitWire[] }
  | { readonly ok: false; readonly message: string };

/**
 * The units of one line as the contract takes them: exactly as many as the quantity, one
 * written serial per battery and a term that is 1..120 or the explicit absence `null`.
 * A serial repeated anywhere in the sale is refused here, before a byte leaves the counter
 * (D2), and so is a serial the seller has not read yet.
 */
function checkedUnits(line: CartLine, serials: Set<string>): UnitsCheck {
  if (line.units.length !== line.quantity) return { ok: false, message: posUnitsMessage };
  const units: SaleUnitWire[] = [];
  for (const unit of line.units) {
    const serial = typeof unit.serial_number === 'string' ? unit.serial_number.trim() : '';
    if (serial === '' || serial.includes('\0') || !serial.isWellFormed()) {
      return { ok: false, message: posSerialMessage };
    }
    if (serial.length > maxSerialLength) return { ok: false, message: posSerialLengthMessage };
    // D2: the serial is compared after trimming and case folding.
    const canonical = serial.toLowerCase();
    if (serials.has(canonical)) return { ok: false, message: posDuplicateSerialMessage };
    serials.add(canonical);
    const months = unit.warranty_months;
    if (months !== null && !validTerm(months)) return { ok: false, message: posWarrantyMessage };
    units.push({ serial_number: serial, warranty_months: months });
  }
  return { ok: true, units };
}

/**
 * The first reason the sale cannot be charged yet because of its units, in the seller's
 * words, or `null` when every battery already carries its serial and a valid term.
 */
export function unitsProblem(cart: readonly CartLine[]): string | null {
  const serials = new Set<string>();
  let total = 0;
  for (const line of cart) {
    const checked = checkedUnits(line, serials);
    if (!checked.ok) return checked.message;
    total += checked.units.length;
  }
  return total > maxSaleUnits ? posUnitTotalMessage : null;
}

/**
 * Admits the sale the seller is about to charge: one or more lines, a price at or above
 * each minimum, one written serial and a valid term per battery, a settlement that closes
 * exactly against the total and a client the warranty can name. It returns the exact
 * payload, or the message that states what has to be fixed first.
 */
export function prepareSale(cart: readonly CartLine[], split: PaymentSplit, customer: SaleCustomer): SalePreparation {
  if (cart.length === 0) return { ok: false, message: posEmptyCartMessage };
  if (cart.length > maxCartLines) return { ok: false, message: posLineLimitMessage };
  const variants = new Set<number>();
  const serials = new Set<string>();
  const lines: SaleLineWire[] = [];
  let unitsTotal = 0;
  for (const line of cart) {
    if (variants.has(line.variant_id)) return { ok: false, message: posMissingLineMessage };
    variants.add(line.variant_id);
    if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > maxQuantity) {
      return { ok: false, message: posQuantityMessage };
    }
    const checked = checkedUnits(line, serials);
    if (!checked.ok) return { ok: false, message: checked.message };
    unitsTotal += checked.units.length;
    if (line.unit_price_cents < line.min_price_cents) {
      return { ok: false, message: posPriceFloorMessage(line.min_price_cents) };
    }
    lines.push({ variant_id: line.variant_id, quantity: line.quantity,
      unit_price: centsToMoney(line.unit_price_cents), units: checked.units });
  }
  if (unitsTotal > maxSaleUnits) return { ok: false, message: posUnitTotalMessage };
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
  const address = trimmedText(customer.address, maxCustomerAddress);
  if (address === null) return { ok: false, message: posAddressMessage };
  return {
    ok: true, total_cents: total,
    input: {
      payments: paymentsWire(split),
      customer: { name, phone: customer.phone, document: customer.document, address },
      lines,
    },
  };
}
