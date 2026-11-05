import { LosslessNumber, parse as parseJSON } from 'lossless-json';
import { validSearch } from './model';
import {
  centsToMoney, maxCartLines, maxQuantity, maxWarrantyMonths, minWarrantyMonths, moneyCents,
  type CreateSaleInput, type PaymentWire, type SellablePage, type SellableVariant,
} from './pointOfSaleModel';

/**
 * Transport of the branch point of sale and of its history. Every answer is admitted
 * only when it is JSON of exactly the contract's shape; money and capacity stay text and
 * no amount is ever coerced to a float.
 */

export type SalesErrorCode =
  | 'invalid_request' | 'payments_mismatch' | 'variant_not_sellable' | 'below_minimum'
  | 'insufficient_stock' | 'unauthenticated' | 'forbidden' | 'not_found' | 'method_not_allowed'
  | 'service_unavailable' | 'invalid_response' | 'network' | 'aborted';

/** The side of the total a settlement failed on, with the canonical amount. */
export interface PaymentsMismatch { readonly side: 'missing' | 'excess'; readonly amount: string }

/** The admitted error envelope per HTTP status; nothing else may reach the UI. */
export const salesAdmittedErrors: ReadonlyMap<number, readonly SalesErrorCode[]> = new Map([
  [400, ['invalid_request', 'payments_mismatch']],
  [401, ['unauthenticated']],
  [403, ['forbidden']],
  [404, ['not_found']],
  [405, ['method_not_allowed']],
  [409, ['variant_not_sellable', 'below_minimum', 'insufficient_stock']],
  [503, ['service_unavailable']],
]);

/** The refusals that name the exact line the counter has to fix. */
const lineRefusals: readonly SalesErrorCode[] = ['variant_not_sellable', 'below_minimum', 'insufficient_stock'];

/** Spanish message for every failure, including the transport ones. */
export const salesErrorMessages: Record<SalesErrorCode, string> = {
  invalid_request: 'El servidor rechazó la venta: revisá las líneas, los montos y el plazo. No se registró nada.',
  payments_mismatch: 'Los montos no cierran contra el total: no se registró nada.',
  variant_not_sellable: 'Una batería no tiene precio en esta sucursal: no es vendible. No se registró nada.',
  below_minimum: 'Una línea cobra menos que el precio mínimo de la sucursal. No se registró nada.',
  insufficient_stock: 'La sucursal no tiene stock suficiente para una línea. No se registró nada.',
  unauthenticated: 'La sesión no está activa. Volvé a iniciar sesión: no se registró nada.',
  forbidden: 'No podés vender desde esta cuenta: el punto de venta es de la sucursal. No se registró nada.',
  not_found: 'El documento no existe o no es de esta sucursal.',
  method_not_allowed: 'El servidor no admite esa operación.',
  service_unavailable: 'El servicio no está disponible. No pudimos confirmar la venta.',
  invalid_response: 'La respuesta del servidor no es válida. No pudimos confirmar la venta.',
  network: 'No se pudo conectar con el servidor. Revisá la conexión e intentá de nuevo.',
  aborted: 'La operación se interrumpió. Revisá la conexión e intentá de nuevo.',
};

export const sellableUnavailable = 'No se pudo consultar el catálogo vendible. Revisá la conexión e intentá de nuevo.';
export const salesHistoryUnavailable = 'No se pudo consultar el historial de ventas. Revisá la conexión e intentá de nuevo.';
export const saleDetailUnavailable = 'No se pudo consultar la venta. Revisá la conexión e intentá de nuevo.';

/** The rows of the sellable read: one page of the branch catalogue. */
export type { SellablePage, SellableVariant };

export interface SellableQuery {
  readonly search: string;
  readonly brand: string;
  readonly capacity: string;
  readonly polarity: '' | 'L' | 'R';
  readonly page: number;
  readonly page_size: number;
}

export interface SalesQuery {
  readonly search: string;
  readonly payment_method: '' | 'cash' | 'card' | 'transfer' | 'mixed';
  readonly page: number;
  readonly page_size: number;
}

/** One amount of a persisted settlement. */
export interface SalePayment { readonly method: string; readonly amount: string }
/** The client the warranty names, exactly as persisted. */
export interface SaleCustomerRecord { readonly name: string; readonly phone: string; readonly document: string }
/** One persisted line of a created document: the price and the term frozen at write time. */
export interface SaleLineRecord {
  readonly variant_id: number;
  readonly quantity: number;
  readonly unit_price: string;
  readonly min_price: string;
  readonly warranty_months: number;
  readonly subtotal: string;
}
/** One persisted line with the catalogue identity of its variant. */
export interface SaleDetailLine extends SaleLineRecord {
  readonly catalog_entry_id: number;
  readonly brand: string;
  readonly model: string;
  readonly capacity_ah: string;
  readonly polarity: 'L' | 'R';
}
/** The created document, under the `sale` key of the creation reply. */
export interface SaleDocument {
  readonly id: number;
  readonly branch_location_id: number;
  readonly branch_sequence: number;
  readonly warranty_number: string;
  readonly payment_method: string;
  readonly payments: readonly SalePayment[];
  readonly customer: SaleCustomerRecord;
  readonly total: string;
  readonly created_by_account_id: number;
  readonly created_at: string;
  readonly lines: readonly SaleLineRecord[];
}
/** One row of the branch history. */
export interface SaleSummary {
  readonly id: number;
  readonly branch_sequence: number;
  readonly warranty_number: string;
  readonly payment_method: string;
  readonly customer_name: string;
  readonly total: string;
  readonly created_at: string;
  readonly lines: number;
}
export interface SalesPage {
  readonly page: number;
  readonly page_size: number;
  readonly total_sales: number;
  readonly sales: readonly SaleSummary[];
}
/** One document with the catalogue identity of every line. */
export interface SaleDetail {
  readonly id: number;
  readonly branch_sequence: number;
  readonly warranty_number: string;
  readonly payment_method: string;
  readonly payments: readonly SalePayment[];
  readonly customer_name: string;
  readonly customer: SaleCustomerRecord;
  readonly total: string;
  readonly created_at: string;
  readonly lines: readonly SaleDetailLine[];
}

export const salesPageSizes: readonly number[] = [10, 25, 50];
export const salesDefaultPageSize = 10;
export const salesMaxPage = 1_000_000;
export const maxSaleID = 2_147_483_647;
export const maxSaleText = 128;

const recordedMethods: readonly string[] = ['cash', 'card', 'transfer', 'mixed'];
const inputMethods: readonly string[] = ['cash', 'card', 'transfer'];
const frozenOrder: readonly string[] = ['cash', 'card', 'transfer'];

function invalidResponse(): never { throw new Error('Respuesta inválida del servidor.'); }
function invalidPayload(): never { throw new Error('Venta inválida.'); }

function decode(raw: string): unknown {
  try {
    return parseJSON(raw, null, { onDuplicateKey: () => { throw new Error('duplicate key'); } });
  } catch { return invalidResponse(); }
}
function fields(value: unknown, keys: readonly string[], required = true): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof LosslessNumber) return invalidResponse();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !keys.includes(key))) return invalidResponse();
  if (required && keys.some(key => !Object.hasOwn(record, key))) return invalidResponse();
  return record;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value || value.includes('\0') || !value.isWellFormed()) return invalidResponse();
  return value;
}
/** A client field may be empty: the warranty has one name and two optional contacts. */
function optionalText(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.includes('\0') || !value.isWellFormed() || value.length > max) {
    return invalidResponse();
  }
  return value;
}
function numeric(value: unknown): string {
  if (!(value instanceof LosslessNumber)) return invalidResponse();
  return value.toString();
}
function integer(value: unknown, min: number, max: number): number {
  const raw = numeric(value);
  if (!/^(0|[1-9]\d*)$/.test(raw)) return invalidResponse();
  const exact = BigInt(raw);
  if (exact < BigInt(min) || exact > BigInt(max)) return invalidResponse();
  return Number(exact);
}
/** The three stock figures of the counter stay exact text, never a float. */
function balance(value: unknown): bigint {
  const raw = numeric(value);
  if (!/^(0|[1-9]\d*)$/.test(raw)) return invalidResponse();
  const exact = BigInt(raw);
  if (exact > 9223372036854775807n) return invalidResponse();
  return exact;
}
function timestamp(value: unknown): string {
  const raw = text(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.test(raw)) return invalidResponse();
  const seconds = raw.slice(0, 19) + 'Z';
  const date = new Date(seconds);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19) !== raw.slice(0, 19)) return invalidResponse();
  if (!Number.isFinite(Date.parse(raw))) return invalidResponse();
  return raw;
}
/** A persisted amount is the canonical two-decimal text the database writes. */
function wireMoney(value: unknown): string {
  if (typeof value !== 'string') return invalidResponse();
  try { return centsToMoney(moneyCents(value)); } catch { return invalidResponse(); }
}
/** An amount that is not zero: a method that did not pay is never a row of a document. */
function paidMoney(value: unknown): string {
  const amount = wireMoney(value);
  if (moneyCents(amount) === 0n) return invalidResponse();
  return amount;
}
function positiveMoney(value: unknown): string {
  const amount = wireMoney(value);
  if (moneyCents(amount) < 0n) return invalidResponse();
  return amount;
}
function capacity(value: unknown): string {
  const raw = typeof value === 'string' ? value : numeric(value);
  if (!/^(0|[1-9]\d{0,5})(\.\d{1,6})?$/.test(raw) || !/[1-9]/.test(raw)) return invalidResponse();
  return raw;
}
function polarity(value: unknown): 'L' | 'R' {
  if (value !== 'L' && value !== 'R') return invalidResponse();
  return value;
}
function variantID(value: unknown): number {
  return integer(value, 1, maxSaleID);
}
function quantity(value: unknown): number {
  return integer(value, 1, maxQuantity);
}
function warrantyMonths(value: unknown): number {
  return integer(value, minWarrantyMonths, maxWarrantyMonths);
}
/** The warranty number of a document: the branch, a hyphen and the padded correlative. */
function warrantyNumber(value: unknown): string {
  const raw = text(value);
  const match = /^([1-9]\d{0,4})-(\d{6,9})$/.exec(raw);
  if (!match) return invalidResponse();
  const branch = Number(match[1]);
  const sequence = Number(match[2]);
  if (branch < 2 || branch > 32767 || sequence < 1 || !Number.isSafeInteger(sequence)) return invalidResponse();
  if (match[2].length > 6 && match[2].startsWith('0')) return invalidResponse();
  return raw;
}
/** The label is derived from the amounts; a document that contradicts itself never renders. */
function paymentLabel(payments: readonly SalePayment[]): string {
  if (payments.length === 0) return invalidResponse();
  return payments.length === 1 ? payments[0].method : 'mixed';
}
function payments(value: unknown): readonly SalePayment[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > frozenOrder.length) return invalidResponse();
  let previous = -1;
  const rows = value.map(entry => {
    const record = fields(entry, ['method', 'amount']);
    const method = record.method;
    if (typeof method !== 'string' || !inputMethods.includes(method)) return invalidResponse();
    const rank = frozenOrder.indexOf(method);
    if (rank <= previous) return invalidResponse();
    previous = rank;
    return Object.freeze({ method, amount: paidMoney(record.amount) });
  });
  return Object.freeze(rows);
}
function customer(value: unknown): SaleCustomerRecord {
  const record = fields(value, ['name', 'phone', 'document']);
  const name = text(record.name);
  if (name.length > 120) return invalidResponse();
  return Object.freeze({ name, phone: optionalText(record.phone, 40), document: optionalText(record.document, 40) });
}
/** A frozen line: the charged price, the floor, the term and the exact subtotal. */
function saleLine(value: unknown): SaleLineRecord {
  const record = fields(value, ['variant_id', 'quantity', 'unit_price', 'min_price', 'warranty_months', 'subtotal']);
  const line = {
    variant_id: variantID(record.variant_id), quantity: quantity(record.quantity),
    unit_price: wireMoney(record.unit_price), min_price: wireMoney(record.min_price),
    warranty_months: warrantyMonths(record.warranty_months), subtotal: wireMoney(record.subtotal),
  };
  if (moneyCents(line.unit_price) < moneyCents(line.min_price)) return invalidResponse();
  if (moneyCents(line.subtotal) !== moneyCents(line.unit_price) * BigInt(line.quantity)) return invalidResponse();
  return Object.freeze(line);
}
function detailLine(value: unknown): SaleDetailLine {
  const record = fields(value, ['variant_id', 'catalog_entry_id', 'brand', 'model', 'capacity_ah', 'polarity',
    'quantity', 'unit_price', 'min_price', 'warranty_months', 'subtotal']);
  const line = saleLine({
    variant_id: record.variant_id, quantity: record.quantity, unit_price: record.unit_price,
    min_price: record.min_price, warranty_months: record.warranty_months, subtotal: record.subtotal,
  });
  return Object.freeze({
    ...line, catalog_entry_id: variantID(record.catalog_entry_id), brand: text(record.brand),
    model: text(record.model), capacity_ah: capacity(record.capacity_ah), polarity: polarity(record.polarity),
  });
}
function lineList<T>(value: unknown, each: (entry: unknown) => T): readonly T[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maxCartLines) return invalidResponse();
  const rows = value.map(each);
  const ids = new Set(rows.map(row => (row as { variant_id: number }).variant_id));
  if (ids.size !== rows.length) return invalidResponse();
  return Object.freeze(rows);
}
/** The lines of a document are ascending by variant, the way the store publishes them. */
function ascending(rows: readonly { variant_id: number }[]): void {
  rows.forEach((row, index) => { if (index > 0 && row.variant_id <= rows[index - 1].variant_id) invalidResponse(); });
}
function totalOf(lines: readonly SaleLineRecord[]): bigint {
  return lines.reduce((total, line) => total + moneyCents(line.subtotal), 0n);
}
function pageOf(record: Record<string, unknown>): { page: number; page_size: number } {
  const page = integer(record.page, 1, salesMaxPage);
  const page_size = integer(record.page_size, 10, 50);
  if (!salesPageSizes.includes(page_size)) return invalidResponse();
  return { page, page_size };
}
function fitsPage(rows: number, page: number, page_size: number, total: number): void {
  if (rows > page_size) return invalidResponse();
  if (rows > 0 && (page - 1) * page_size + rows > total) return invalidResponse();
}

// ---------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------

export function validSellableQuery(query: SellableQuery): boolean {
  if (typeof query.search !== 'string' || !validSearch(query.search)) return false;
  if (typeof query.brand !== 'string' || !query.brand.isWellFormed() || query.brand.includes('\0')
    || query.brand.length > maxSaleText) return false;
  if (typeof query.capacity !== 'string'
    || (query.capacity !== '' && !/^(0|[1-9]\d{0,5})(\.\d{1,6})?$/.test(query.capacity))) return false;
  if (query.polarity !== '' && query.polarity !== 'L' && query.polarity !== 'R') return false;
  return Number.isInteger(query.page) && query.page >= 1 && query.page <= salesMaxPage
    && Number.isInteger(query.page_size) && salesPageSizes.includes(query.page_size);
}

export function validSalesQuery(query: SalesQuery): boolean {
  if (typeof query.search !== 'string' || !validSearch(query.search)) return false;
  if (query.payment_method !== '' && !recordedMethods.includes(query.payment_method)) return false;
  return Number.isInteger(query.page) && query.page >= 1 && query.page <= salesMaxPage
    && Number.isInteger(query.page_size) && salesPageSizes.includes(query.page_size);
}

/** The frozen read path: a blank filter is absent instead of sent empty. */
export function sellablePath(query: SellableQuery): string {
  if (!validSellableQuery(query)) return invalidPayload();
  const params = new URLSearchParams();
  if (query.search !== '') params.set('search', query.search);
  if (query.brand !== '') params.set('brand', query.brand);
  if (query.capacity !== '') params.set('capacity', query.capacity);
  if (query.polarity !== '') params.set('polarity', query.polarity);
  params.set('page', String(query.page));
  params.set('page_size', String(query.page_size));
  return '/api/sales/sellable?' + params.toString();
}

export function salesHistoryPath(query: SalesQuery): string {
  if (!validSalesQuery(query)) return invalidPayload();
  const params = new URLSearchParams();
  if (query.search !== '') params.set('search', query.search);
  if (query.payment_method !== '') params.set('payment_method', query.payment_method);
  params.set('page', String(query.page));
  params.set('page_size', String(query.page_size));
  return '/api/sales?' + params.toString();
}

function documentID(id: number): number {
  if (!Number.isInteger(id) || id < 1 || id > maxSaleID) return invalidPayload();
  return id;
}

export function saleDetailPath(id: number): string {
  return `/api/sales/${documentID(id)}`;
}

/** The stable download of the warranty of one sale. */
export function warrantyPath(id: number): string {
  return `/api/sales/${documentID(id)}/warranty.pdf`;
}

// ---------------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------------

/** Parses one page of the sellable catalogue: a row per variant, priced or not. */
export function parseSellablePage(raw: string): SellablePage {
  const record = fields(decode(raw), ['page', 'page_size', 'total_variants', 'items']);
  const { page, page_size } = pageOf(record);
  const total_variants = integer(record.total_variants, 0, Number.MAX_SAFE_INTEGER);
  if (!Array.isArray(record.items)) return invalidResponse();
  fitsPage(record.items.length, page, page_size, total_variants);
  let previous = 0;
  const items = record.items.map(value => {
    const row = fields(value, ['variant_id', 'catalog_entry_id', 'brand', 'model', 'capacity_ah', 'polarity',
      'sellable', 'suggested_price', 'min_price', 'existing', 'reserved', 'available']);
    const variant_id = variantID(row.variant_id);
    if (variant_id <= previous) return invalidResponse();
    previous = variant_id;
    if (typeof row.sellable !== 'boolean') return invalidResponse();
    const existing = balance(row.existing);
    const reserved = balance(row.reserved);
    const available = balance(row.available);
    if (reserved > existing || available > existing) return invalidResponse();
    let suggested_price: string | null = null;
    let min_price: string | null = null;
    if (row.sellable) {
      suggested_price = wireMoney(row.suggested_price);
      min_price = wireMoney(row.min_price);
      if (moneyCents(suggested_price) < moneyCents(min_price)) return invalidResponse();
    } else if (row.suggested_price !== null || row.min_price !== null) {
      // A variant the branch cannot sell never carries a pair the counter could charge.
      return invalidResponse();
    }
    return Object.freeze({
      variant_id, catalog_entry_id: variantID(row.catalog_entry_id), brand: text(row.brand),
      model: text(row.model), capacity_ah: capacity(row.capacity_ah), polarity: polarity(row.polarity),
      sellable: row.sellable, suggested_price, min_price, existing, reserved, available,
    }) as SellableVariant;
  });
  return Object.freeze({ page, page_size, total_variants, items: Object.freeze(items) });
}

/** Parses the creation reply: the document under its own key, exactly as written. */
export function parseCreatedSale(raw: string): SaleDocument {
  const record = fields(decode(raw), ['sale']);
  const sale = fields(record.sale, ['id', 'branch_location_id', 'branch_sequence', 'warranty_number',
    'payment_method', 'payments', 'customer', 'total', 'created_by_account_id', 'created_at', 'lines']);
  const id = integer(sale.id, 1, Number.MAX_SAFE_INTEGER);
  const branch_location_id = integer(sale.branch_location_id, 2, 32767);
  const branch_sequence = integer(sale.branch_sequence, 1, 999_999_999);
  const number = warrantyNumber(sale.warranty_number);
  const expected = `${branch_location_id}-${String(branch_sequence).padStart(6, '0')}`;
  if (number !== expected) return invalidResponse();
  const settlement = payments(sale.payments);
  const label = paymentLabel(settlement);
  if (sale.payment_method !== label) return invalidResponse();
  const lines = lineList(sale.lines, saleLine);
  ascending(lines);
  const total = wireMoney(sale.total);
  if (moneyCents(total) !== totalOf(lines) || paymentsTotal(settlement) !== moneyCents(total)) return invalidResponse();
  return Object.freeze({
    id, branch_location_id, branch_sequence, warranty_number: number, payment_method: label,
    payments: settlement, customer: customer(sale.customer), total, created_at: timestamp(sale.created_at),
    created_by_account_id: integer(sale.created_by_account_id, 1, Number.MAX_SAFE_INTEGER),
    lines,
  });
}

/** Parses one page of the branch history: the document header and its line count. */
export function parseSalePage(raw: string): SalesPage {
  const record = fields(decode(raw), ['page', 'page_size', 'total_sales', 'sales']);
  const { page, page_size } = pageOf(record);
  const total_sales = integer(record.total_sales, 0, Number.MAX_SAFE_INTEGER);
  if (!Array.isArray(record.sales)) return invalidResponse();
  fitsPage(record.sales.length, page, page_size, total_sales);
  let previous = Number.MAX_SAFE_INTEGER;
  const sales = record.sales.map(value => {
    const row = fields(value, ['id', 'branch_sequence', 'warranty_number', 'payment_method', 'customer_name',
      'total', 'created_at', 'lines']);
    const id = integer(row.id, 1, Number.MAX_SAFE_INTEGER);
    if (id >= previous) return invalidResponse();
    previous = id;
    if (typeof row.payment_method !== 'string' || !recordedMethods.includes(row.payment_method)) return invalidResponse();
    return Object.freeze({
      id, branch_sequence: integer(row.branch_sequence, 1, 999_999_999),
      warranty_number: warrantyNumber(row.warranty_number), payment_method: row.payment_method,
      customer_name: text(row.customer_name), total: wireMoney(row.total),
      created_at: timestamp(row.created_at), lines: integer(row.lines, 1, maxCartLines),
    }) as SaleSummary;
  });
  return Object.freeze({ page, page_size, total_sales, sales: Object.freeze(sales) });
}

/** Parses one document with the catalogue identity of every line. */
export function parseSaleDetail(raw: string): SaleDetail {
  const record = fields(decode(raw), ['id', 'branch_sequence', 'warranty_number', 'payment_method', 'payments',
    'customer_name', 'customer', 'total', 'created_at', 'lines']);
  const settlement = payments(record.payments);
  const label = paymentLabel(settlement);
  if (record.payment_method !== label) return invalidResponse();
  const lines = lineList(record.lines, detailLine);
  ascending(lines);
  const total = wireMoney(record.total);
  if (moneyCents(total) !== totalOf(lines) || paymentsTotal(settlement) !== moneyCents(total)) return invalidResponse();
  const customer_name = text(record.customer_name);
  const client = customer(record.customer);
  if (client.name !== customer_name) return invalidResponse();
  return Object.freeze({
    id: integer(record.id, 1, Number.MAX_SAFE_INTEGER),
    branch_sequence: integer(record.branch_sequence, 1, 999_999_999),
    warranty_number: warrantyNumber(record.warranty_number), payment_method: label, payments: settlement,
    customer_name, customer: client, total, created_at: timestamp(record.created_at), lines,
  });
}

/** One admitted refusal: the code, the line it names and the side of an open settlement. */
export interface SalesErrorDetail {
  readonly code: SalesErrorCode;
  readonly variant_id: number | null;
  readonly mismatch: PaymentsMismatch | null;
}

export function parseSalesError(raw: string, status: number): SalesErrorDetail {
  const admitted = salesAdmittedErrors.get(status);
  if (!admitted) return invalidResponse();
  const envelope = fields(decode(raw), ['error', 'variant_id', 'missing', 'excess'], false);
  const code = envelope.error;
  if (typeof code !== 'string' || !admitted.includes(code as SalesErrorCode)) return invalidResponse();
  const keys = Object.keys(envelope).sort();
  if (code === 'payments_mismatch') {
    const sides = (['missing', 'excess'] as const).filter(side => Object.hasOwn(envelope, side));
    if (sides.length !== 1 || keys.length !== 2) return invalidResponse();
    const side = sides[0];
    let amount: string;
    try { amount = paidMoney(envelope[side]); } catch { return invalidResponse(); }
    return { code: code as SalesErrorCode, variant_id: null, mismatch: { side, amount } };
  }
  if (lineRefusals.includes(code as SalesErrorCode)) {
    if (keys.length !== 2 || !Object.hasOwn(envelope, 'variant_id')) return invalidResponse();
    return { code: code as SalesErrorCode, variant_id: integer(envelope.variant_id, 1, maxSaleID), mismatch: null };
  }
  if (keys.length !== 1) return invalidResponse();
  return { code: code as SalesErrorCode, variant_id: null, mismatch: null };
}

// ---------------------------------------------------------------------------------
// The write payload the counter freezes
// ---------------------------------------------------------------------------------

/** A draft number is a plain integer, not a parsed wire number. */
function draftInteger(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) return invalidPayload();
  return value;
}

function paymentsTotal(payments: readonly SalePayment[]): bigint {
  return payments.reduce((total, payment) => total + moneyCents(payment.amount), 0n);
}

function canonicalPayment(value: unknown): PaymentWire {
  const record = fields(value, ['method', 'amount'], false);
  if (Object.keys(record).length !== 2) return invalidPayload();
  const method = record.method;
  if (typeof method !== 'string' || !inputMethods.includes(method)) return invalidPayload();
  const amount = wireMoney(record.amount);
  if (moneyCents(amount) === 0n) return invalidPayload();
  return Object.freeze({ method, amount });
}

/**
 * Admits the exact body of `POST /api/sales`: only the methods and the lines the
 * contract takes, every amount canonical, every term inside its bounds and a client the
 * warranty can name. Anything else fails closed before a single byte is sent.
 */
export function canonicalCreateSaleInput(input: CreateSaleInput): CreateSaleInput {
  const record = fields(input, ['payments', 'customer', 'lines'], false);
  if (Object.keys(record).length !== 3) return invalidPayload();
  if (!Array.isArray(record.payments) || record.payments.length < 1 || record.payments.length > inputMethods.length) {
    return invalidPayload();
  }
  let previous = -1;
  const payments = record.payments.map(entry => {
    const payment = canonicalPayment(entry);
    const rank = frozenOrder.indexOf(payment.method);
    if (rank <= previous) return invalidPayload();
    previous = rank;
    return payment;
  });
  const client = fields(record.customer, ['name', 'phone', 'document'], false);
  if (Object.keys(client).length !== 3) return invalidPayload();
  const name = typeof client.name === 'string' ? client.name.trim() : invalidPayload();
  if (name === '' || name.length > 120 || name.includes('\0') || !name.isWellFormed()) return invalidPayload();
  const phone = optionalText(client.phone, 40);
  const document = optionalText(client.document, 40);
  if (!Array.isArray(record.lines) || record.lines.length < 1 || record.lines.length > maxCartLines) return invalidPayload();
  const variants = new Set<number>();
  const lines = record.lines.map(entry => {
    const line = fields(entry, ['variant_id', 'quantity', 'unit_price', 'warranty_months'], false);
    if (Object.keys(line).length !== 4) return invalidPayload();
    const variant_id = draftInteger(line.variant_id, 1, maxSaleID);
    if (variants.has(variant_id)) return invalidPayload();
    variants.add(variant_id);
    return Object.freeze({
      variant_id, quantity: draftInteger(line.quantity, 1, maxQuantity), unit_price: wireMoney(line.unit_price),
      warranty_months: draftInteger(line.warranty_months, minWarrantyMonths, maxWarrantyMonths),
    });
  });
  return Object.freeze({
    payments: Object.freeze(payments),
    customer: Object.freeze({ name, phone, document }),
    lines: Object.freeze(lines),
  });
}

/**
 * The creation reply is evidence only when it repeats the exact sale this counter sent:
 * the same settlement, the same lines and the same client.
 */
export function matchesCreateSale(input: CreateSaleInput, sale: SaleDocument): boolean {
  let expected: CreateSaleInput;
  try { expected = canonicalCreateSaleInput(input); } catch { return false; }
  if (sale.payments.length !== expected.payments.length) return false;
  const settled = expected.payments.every((payment, index) => {
    const written = sale.payments[index];
    return written.method === payment.method
      && moneyCents(written.amount) === moneyCents(payment.amount);
  });
  if (!settled) return false;
  if (sale.customer.name !== expected.customer.name || sale.customer.phone !== expected.customer.phone
    || sale.customer.document !== expected.customer.document) return false;
  if (sale.lines.length !== expected.lines.length) return false;
  const sent = new Map(expected.lines.map(line => [line.variant_id, line]));
  for (const line of sale.lines) {
    const asked = sent.get(line.variant_id);
    if (!asked) return false;
    if (line.quantity !== asked.quantity) return false;
    if (moneyCents(line.unit_price) !== moneyCents(asked.unit_price)) return false;
    if (line.warranty_months !== asked.warranty_months) return false;
  }
  const expectedTotal = expected.lines.reduce((total, line) => total + moneyCents(line.unit_price) * BigInt(line.quantity), 0n);
  return moneyCents(sale.total) === expectedTotal;
}

// ---------------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------------

export class SalesAPIError extends Error {
  constructor(public readonly code: SalesErrorCode, public readonly status: number | null,
    public readonly variantId: number | null = null,
    public readonly mismatch: PaymentsMismatch | null = null) {
    super(code); this.name = 'SalesAPIError';
  }
}

const jsonHeader = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;
const csrfToken = /^[A-Za-z0-9_-]+$/;

function failure(reply: Response, raw: string, status: number): never {
  const malformed = () => new SalesAPIError('invalid_response', reply.status);
  let detail: SalesErrorDetail;
  try { detail = parseSalesError(raw, status); } catch { throw malformed(); }
  throw new SalesAPIError(detail.code, status, detail.variant_id, detail.mismatch);
}

async function read(reply: Response, signal?: AbortSignal): Promise<string> {
  try { return await reply.text(); } catch (error) {
    const aborted = signal?.aborted === true
      || (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError');
    throw new SalesAPIError(aborted ? 'aborted' : 'network', null);
  }
}

export function createSalesAPI(fetch: typeof globalThis.fetch = globalThis.fetch) {
  async function get<T>(path: string, status: number, parse: (raw: string) => T, signal?: AbortSignal): Promise<T> {
    let reply: Response;
    let raw: string;
    try {
      reply = await fetch(path, { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal });
      raw = await read(reply, signal);
    } catch (error) {
      if (error instanceof SalesAPIError) throw error;
      const aborted = signal?.aborted === true
        || (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError');
      throw new SalesAPIError(aborted ? 'aborted' : 'network', null);
    }
    if (!jsonHeader.test(reply.headers.get('Content-Type') ?? '')) throw new SalesAPIError('invalid_response', reply.status);
    if (reply.status !== status) failure(reply, raw, reply.status);
    try { return parse(raw); } catch { throw new SalesAPIError('invalid_response', reply.status); }
  }

  return {
    async sellable(query: SellableQuery, signal?: AbortSignal): Promise<SellablePage> {
      let path: string;
      try { path = sellablePath(query); } catch { throw new SalesAPIError('invalid_request', null); }
      const page = await get(path, 200, parseSellablePage, signal);
      // A page that does not answer the exact query is not evidence about it.
      if (page.page !== query.page || page.page_size !== query.page_size) {
        throw new SalesAPIError('invalid_response', 200);
      }
      return page;
    },

    async history(query: SalesQuery, signal?: AbortSignal): Promise<SalesPage> {
      let path: string;
      try { path = salesHistoryPath(query); } catch { throw new SalesAPIError('invalid_request', null); }
      const page = await get(path, 200, parseSalePage, signal);
      if (page.page !== query.page || page.page_size !== query.page_size) {
        throw new SalesAPIError('invalid_response', 200);
      }
      return page;
    },

    async detail(id: number, signal?: AbortSignal): Promise<SaleDetail> {
      let path: string;
      try { path = saleDetailPath(id); } catch { throw new SalesAPIError('invalid_request', null); }
      return get(path, 200, parseSaleDetail, signal);
    },

    /**
     * Registers the sale. The payload and the token are frozen before any await, so a
     * caller cannot reclassify an in-flight write by mutating its draft.
     */
    async create(input: CreateSaleInput, csrf: string, signal?: AbortSignal): Promise<SaleDocument> {
      let body: string;
      let sent: CreateSaleInput;
      try {
        if (typeof csrf !== 'string' || !csrfToken.test(csrf)) throw new Error('Missing CSRF token');
        sent = canonicalCreateSaleInput(input);
        body = JSON.stringify(sent);
      } catch { throw new SalesAPIError('invalid_request', null); }
      let reply: Response;
      let raw: string;
      try {
        reply = await fetch('/api/sales', { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body });
        raw = await read(reply, signal);
      } catch (error) {
        if (error instanceof SalesAPIError) throw error;
        const aborted = signal?.aborted === true
          || (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError');
        throw new SalesAPIError(aborted ? 'aborted' : 'network', null);
      }
      if (!jsonHeader.test(reply.headers.get('Content-Type') ?? '')) throw new SalesAPIError('invalid_response', reply.status);
      if (reply.status !== 201) failure(reply, raw, reply.status);
      let sale: SaleDocument;
      try { sale = parseCreatedSale(raw); } catch { throw new SalesAPIError('invalid_response', reply.status); }
      if (!matchesCreateSale(sent, sale)) throw new SalesAPIError('invalid_response', reply.status);
      return sale;
    },
  };
}
