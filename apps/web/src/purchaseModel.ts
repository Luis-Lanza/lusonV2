/**
 * Purchase model: the two kinds of line, the draft state machine, its exact totals,
 * the settlement and the frozen payload of a Compras document.
 *
 * Money is integer cents and weight is integer thousandths of a kilogram
 * (`bigint`) from end to end. The wire carries canonical decimal text
 * (`"25000.00"` and `"12.400"`), the screen shows `Bs 25.000,00` and `12,400 kg`,
 * and no amount or weight is ever parsed into a binary float.
 */
import {
  centsToMoney, formatMoney, moneyCents, posExcessMessage, posMissingMessage,
  settlement, type PaymentSplit, type Settlement,
} from './pointOfSaleModel';
import { newTransferRetryKey } from './transferModel';

// ---------------------------------------------------------------------------------
// Frozen bounds and text shapes of the contract
// ---------------------------------------------------------------------------------

export const purchaseMaxLines = 190;
export const purchaseMaxQuantity = 1_000_000;
export const purchaseMaxNote = 500;
export const purchaseMaxReason = 500;
export const purchaseMaxID = 2_147_483_647;
/** `numeric(12,2)`: the whole range of money the contract persists. */
export const purchaseMaxMoneyCents = 999_999_999_999n;
/** `numeric(12,3)`: nine integral digits and three decimals of kilograms. */
export const purchaseMaxWeightMilli = 999_999_999_999n;
export const purchaseHistoryPageSizes: readonly number[] = [10, 25, 50];
export const purchaseHistoryDefaultPageSize = 25;
export const purchaseHistoryMaxPage = 1_000_000;

// The comma is catalogue data, not decoration: 12N6,5_3B and YB6,5_BS are real models.
const modelCodeShape = /^[A-Z0-9][A-Z0-9 .,_/-]{0,39}$/;
const typedKgShape = /^(0|[1-9]\d*(?:\.\d{3})*)(?:,(\d{1,3}))?$/;
const wireKgShape = /^-?(0|[1-9]\d{0,8})\.\d{3}$/;
const operationKeyShape = /^[A-Za-z0-9_-]{16,128}$/;

function invalidModel(): never { throw new Error('Modelo inválido.'); }
function invalidWeight(): never { throw new Error('Peso inválido.'); }
function invalidPurchase(): never { throw new Error('Compra inválida.'); }
function invalidReason(): never { throw new Error('Motivo inválido.'); }

function groupedInteger(whole: bigint): string {
  return whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function isWellFormed(value: string): boolean {
  return value.isWellFormed() && !value.includes('\0');
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && isWellFormed(value) && Array.from(value).length <= max;
}

// ---------------------------------------------------------------------------------
// Model codes, quantities and the weight the operator types
// ---------------------------------------------------------------------------------

export function validPurchaseModelCode(text: string): boolean {
  return typeof text === 'string' && modelCodeShape.test(text.trim().toUpperCase());
}

/** A model is trimmed and upper-cased, exactly as the contract stores it. */
export function canonicalPurchaseModelCode(text: string): string {
  if (typeof text !== 'string') return invalidModel();
  const model = text.trim().toUpperCase();
  if (!modelCodeShape.test(model)) return invalidModel();
  return model;
}

export function validPurchaseQuantity(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= purchaseMaxQuantity;
}

/**
 * Exact thousandths of a kilogram from what the operator typed. The dot is always
 * the thousands separator and the comma the decimal one, like the money field.
 */
export function parseTypedKg(text: string): bigint {
  if (typeof text !== 'string') return invalidWeight();
  const trimmed = text.trim();
  const match = typedKgShape.exec(trimmed);
  if (!match) return invalidWeight();
  const milli = BigInt(match[1].replace(/\./g, '')) * 1000n + BigInt((match[2] ?? '').padEnd(3, '0'));
  if (milli > purchaseMaxWeightMilli) return invalidWeight();
  return milli;
}

/** The value a weight field shows for known thousandths: `12,400`. */
export function typedKg(milli: bigint): string {
  if (typeof milli !== 'bigint' || milli > purchaseMaxWeightMilli || milli < -purchaseMaxWeightMilli) {
    return invalidWeight();
  }
  const magnitude = milli < 0n ? -milli : milli;
  const sign = milli < 0n ? '-' : '';
  return `${sign}${groupedInteger(magnitude / 1000n)},${(magnitude % 1000n).toString().padStart(3, '0')}`;
}

/** The presentation format of the received panel and the receipt: `12,400 kg`. */
export function formatKg(milli: bigint): string {
  return `${typedKg(milli)} kg`;
}

/** Exact thousandths of a canonical wire weight (`"12.400"`), signed for a counter-document. */
export function kgMilliFromWire(text: string): bigint {
  if (typeof text !== 'string' || !wireKgShape.test(text)) return invalidWeight();
  const negative = text.startsWith('-');
  const [whole, fraction] = (negative ? text.slice(1) : text).split('.');
  const magnitude = BigInt(whole) * 1000n + BigInt(fraction);
  if (magnitude > purchaseMaxWeightMilli || (negative && magnitude === 0n)) return invalidWeight();
  return negative ? -magnitude : magnitude;
}

/** The canonical wire weight of exact thousandths: `12.400`. */
export function kgMilliToWire(milli: bigint): string {
  if (typeof milli !== 'bigint' || milli > purchaseMaxWeightMilli || milli < -purchaseMaxWeightMilli) {
    return invalidWeight();
  }
  const magnitude = milli < 0n ? -milli : milli;
  const sign = milli < 0n ? '-' : '';
  return `${sign}${(magnitude / 1000n).toString()}.${(magnitude % 1000n).toString().padStart(3, '0')}`;
}

/** A signed amount for a counter-document, reusing the one money formatter. */
export function formatSignedMoney(cents: bigint): string {
  if (cents < 0n) return `-${formatMoney(-cents)}`;
  return formatMoney(cents);
}

// ---------------------------------------------------------------------------------
// The two line kinds and their exact amounts
// ---------------------------------------------------------------------------------

export type PurchaseLine =
  | {
    readonly kind: 'used';
    readonly model: string;
    readonly quantity: number;
    readonly unit_price_cents: bigint;
  }
  | {
    readonly kind: 'scrap';
    readonly material_id: number;
    readonly name: string;
    readonly kg_milli: bigint;
    readonly price_per_kg_cents: bigint;
  };

function positiveCents(cents: bigint): bigint {
  if (typeof cents !== 'bigint' || cents <= 0n) return invalidPurchase();
  try { centsToMoney(cents); } catch { return invalidPurchase(); }
  return cents;
}

/** One used battery line: the model and the typed price per battery. */
export function usedPurchaseLine(model: string, quantity: number, unitPriceCents: bigint): PurchaseLine {
  const canonical = canonicalPurchaseModelCode(model);
  if (!validPurchaseQuantity(quantity)) return invalidPurchase();
  return Object.freeze({ kind: 'used', model: canonical, quantity,
    unit_price_cents: positiveCents(unitPriceCents) });
}

/** One scrap line: the material, its kilograms and the typed price per kilogram. */
export function scrapPurchaseLine(materialId: number, name: string, kgMilli: bigint,
  pricePerKgCents: bigint): PurchaseLine {
  if (!Number.isInteger(materialId) || materialId < 1 || materialId > purchaseMaxID) return invalidPurchase();
  if (typeof name !== 'string' || !isWellFormed(name) || name.trim() === '') return invalidPurchase();
  if (typeof kgMilli !== 'bigint' || kgMilli <= 0n || kgMilli > purchaseMaxWeightMilli) return invalidPurchase();
  return Object.freeze({ kind: 'scrap', material_id: materialId, name, kg_milli: kgMilli,
    price_per_kg_cents: positiveCents(pricePerKgCents) });
}

/**
 * `kg × price_per_kg` rounded half up to the cent, the rounding the contract pins.
 * A negative weight is the counter-document's and mirrors the exact positive amount.
 */
export function scrapLineAmountCents(kgMilli: bigint, pricePerKgCents: bigint): bigint {
  if (typeof kgMilli !== 'bigint' || typeof pricePerKgCents !== 'bigint' || pricePerKgCents <= 0n) {
    return invalidPurchase();
  }
  const negative = kgMilli < 0n;
  const magnitude = negative ? -kgMilli : kgMilli;
  const cents = (magnitude * pricePerKgCents + 500n) / 1000n;
  return negative ? -cents : cents;
}

export function lineAmountCents(line: PurchaseLine): bigint {
  if (line.kind === 'used') return line.unit_price_cents * BigInt(line.quantity);
  return scrapLineAmountCents(line.kg_milli, line.price_per_kg_cents);
}

export function purchaseTotalCents(lines: readonly PurchaseLine[]): bigint {
  return lines.reduce((total, line) => total + lineAmountCents(line), 0n);
}

export function purchaseLineKey(line: PurchaseLine): string {
  return line.kind === 'used' ? `used:${line.model}` : `scrap:${line.material_id}`;
}

/**
 * The participation of one received row in its tab's total, as the whole percentage
 * the artboard bars, rounded half up on the exact ratio and never a float.
 */
export function purchaseSharePercent(value: bigint, total: bigint): number {
  if (typeof value !== 'bigint' || typeof total !== 'bigint' || value < 0n || total <= 0n) return 0;
  const percent = (value * 100n + total / 2n) / total;
  return Number(percent > 100n ? 100n : percent);
}

// ---------------------------------------------------------------------------------
// The local draft: lines, note and settlement
// ---------------------------------------------------------------------------------

export interface PurchaseDraft {
  readonly lines: readonly PurchaseLine[];
  readonly note: string;
  readonly cash_cents: bigint;
  readonly transfer_cents: bigint;
}

export function newPurchaseDraft(): PurchaseDraft {
  return Object.freeze({ lines: Object.freeze([] as readonly PurchaseLine[]), note: '',
    cash_cents: 0n, transfer_cents: 0n });
}

function draftOf(draft: PurchaseDraft, patch: Partial<PurchaseDraft>): PurchaseDraft {
  return Object.freeze({ ...draft, ...patch });
}

/** One line per model and one per material: adding the same one replaces it. */
export function upsertPurchaseLine(draft: PurchaseDraft, line: PurchaseLine): PurchaseDraft {
  const key = purchaseLineKey(line);
  const index = draft.lines.findIndex(current => purchaseLineKey(current) === key);
  if (index >= 0) {
    const lines = draft.lines.map((current, position) => position === index ? line : current);
    return draftOf(draft, { lines: Object.freeze(lines) });
  }
  const kind = draft.lines.filter(current => current.kind === line.kind).length;
  if (kind >= purchaseMaxLines) return invalidPurchase();
  return draftOf(draft, { lines: Object.freeze([...draft.lines, line]) });
}

export function removePurchaseLine(draft: PurchaseDraft, key: string): PurchaseDraft {
  return draftOf(draft, { lines: Object.freeze(draft.lines.filter(line => purchaseLineKey(line) !== key)) });
}

export function setPurchaseNote(draft: PurchaseDraft, note: string): PurchaseDraft {
  return draftOf(draft, { note });
}

export function setPurchaseSettlement(draft: PurchaseDraft, split: PaymentSplit): PurchaseDraft {
  if (typeof split.cash_cents !== 'bigint' || typeof split.transfer_cents !== 'bigint'
    || split.cash_cents < 0n || split.transfer_cents < 0n) return invalidPurchase();
  return draftOf(draft, { cash_cents: split.cash_cents, transfer_cents: split.transfer_cents });
}

export function purchaseSettlement(draft: PurchaseDraft): Settlement {
  return settlement(purchaseTotalCents(draft.lines),
    { cash_cents: draft.cash_cents, transfer_cents: draft.transfer_cents });
}

export function purchaseIsSettled(draft: PurchaseDraft): boolean {
  return purchaseSettlement(draft).status === 'exact';
}

function lineProblem(line: PurchaseLine): string | null {
  if (line.kind === 'used') {
    if (!modelCodeShape.test(line.model) || !validPurchaseQuantity(line.quantity)
      || line.unit_price_cents <= 0n || line.unit_price_cents > purchaseMaxMoneyCents) {
      return 'Hay una línea inválida: revisá el modelo, la cantidad y el precio.';
    }
    return null;
  }
  if (!Number.isInteger(line.material_id) || line.material_id < 1 || line.material_id > purchaseMaxID
    || line.kg_milli <= 0n || line.kg_milli > purchaseMaxWeightMilli
    || line.price_per_kg_cents <= 0n || line.price_per_kg_cents > purchaseMaxMoneyCents
    || line.name.trim() === '') {
    return 'Hay una línea inválida: revisá el material, los kilogramos y el precio.';
  }
  return null;
}

/** The one sentence that explains why this draft cannot be confirmed, or null. */
export function purchaseDraftProblem(draft: PurchaseDraft): string | null {
  if (draft.lines.length === 0) return 'Agregá al menos una línea antes de confirmar la compra.';
  if (draft.lines.filter(line => line.kind === 'used').length > purchaseMaxLines
    || draft.lines.filter(line => line.kind === 'scrap').length > purchaseMaxLines) {
    return `Una compra lleva como máximo ${purchaseMaxLines} líneas de cada tipo.`;
  }
  for (const line of draft.lines) {
    const problem = lineProblem(line);
    if (problem !== null) return problem;
  }
  if (!boundedText(draft.note, purchaseMaxNote)) {
    return `La nota lleva hasta ${purchaseMaxNote} caracteres.`;
  }
  const total = purchaseTotalCents(draft.lines);
  if (total > purchaseMaxMoneyCents) return 'El importe total supera el máximo que admite el sistema.';
  if (draft.cash_cents > purchaseMaxMoneyCents || draft.transfer_cents > purchaseMaxMoneyCents) {
    return 'Un monto del pago supera el máximo que admite el sistema.';
  }
  const state = purchaseSettlement(draft);
  if (state.status === 'missing') return posMissingMessage(state.remaining);
  if (state.status === 'excess') return posExcessMessage(state.excess);
  return null;
}

// ---------------------------------------------------------------------------------
// The frozen payload
// ---------------------------------------------------------------------------------

export interface PurchaseUsedLineInput { readonly model: string; readonly quantity: number; readonly unit_price: string }
export interface PurchaseScrapLineInput { readonly material_id: number; readonly kg: string; readonly price_per_kg: string }
export interface PurchaseInput {
  readonly operation_key: string;
  readonly note: string;
  readonly used_lines: readonly PurchaseUsedLineInput[];
  readonly scrap_lines: readonly PurchaseScrapLineInput[];
  readonly paid_cash: string;
  readonly paid_transfer: string;
}

function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidPurchase();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some(key => !Object.hasOwn(record, key))) {
    return invalidPurchase();
  }
  return record;
}

function wireMoney(value: unknown): bigint {
  if (typeof value !== 'string') return invalidPurchase();
  try { return moneyCents(value); } catch { return invalidPurchase(); }
}

function wireWeight(value: unknown): bigint {
  if (typeof value !== 'string') return invalidPurchase();
  try { return kgMilliFromWire(value); } catch { return invalidPurchase(); }
}

function boundedInteger(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) return invalidPurchase();
  return value;
}

/**
 * Admits exactly the body of `POST /api/purchases`: the frozen bounds, canonical
 * money and weight, one line per model and per material, and a settlement that
 * equals the total. Anything else fails closed before a byte is sent.
 */
export function canonicalPurchaseInput(input: PurchaseInput): PurchaseInput {
  const record = fields(input, ['operation_key', 'note', 'used_lines', 'scrap_lines', 'paid_cash', 'paid_transfer']);
  const operation_key = record.operation_key;
  if (typeof operation_key !== 'string' || !operationKeyShape.test(operation_key)) return invalidPurchase();
  if (!boundedText(record.note, purchaseMaxNote)) return invalidPurchase();
  if (!Array.isArray(record.used_lines) || record.used_lines.length > purchaseMaxLines) return invalidPurchase();
  if (!Array.isArray(record.scrap_lines) || record.scrap_lines.length > purchaseMaxLines) return invalidPurchase();
  if (record.used_lines.length + record.scrap_lines.length === 0) return invalidPurchase();
  const models = new Set<string>();
  const used = record.used_lines.map(value => {
    const line = fields(value, ['model', 'quantity', 'unit_price']);
    const model = typeof line.model === 'string' ? line.model : invalidPurchase();
    if (!modelCodeShape.test(model) || models.has(model)) return invalidPurchase();
    models.add(model);
    return Object.freeze({ model, quantity: boundedInteger(line.quantity, 1, purchaseMaxQuantity),
      unit_price: centsToMoney(positiveCents(wireMoney(line.unit_price))) });
  }).sort((left, right) => left.model < right.model ? -1 : left.model > right.model ? 1 : 0);
  const materials = new Set<number>();
  const scrap = record.scrap_lines.map(value => {
    const line = fields(value, ['material_id', 'kg', 'price_per_kg']);
    const material_id = boundedInteger(line.material_id, 1, purchaseMaxID);
    if (materials.has(material_id)) return invalidPurchase();
    materials.add(material_id);
    const kg = wireWeight(line.kg);
    if (kg <= 0n) return invalidPurchase();
    return Object.freeze({ material_id, kg: kgMilliToWire(kg),
      price_per_kg: centsToMoney(positiveCents(wireMoney(line.price_per_kg))) });
  }).sort((left, right) => left.material_id - right.material_id);
  const paid_cash = wireMoney(record.paid_cash);
  const paid_transfer = wireMoney(record.paid_transfer);
  const total = used.reduce((sum, line) => sum + moneyCents(line.unit_price) * BigInt(line.quantity), 0n)
    + scrap.reduce((sum, line) => sum + scrapLineAmountCents(kgMilliFromWire(line.kg),
      moneyCents(line.price_per_kg)), 0n);
  if (paid_cash + paid_transfer !== total) return invalidPurchase();
  return Object.freeze({
    operation_key, note: record.note as string,
    used_lines: Object.freeze(used), scrap_lines: Object.freeze(scrap),
    paid_cash: centsToMoney(paid_cash), paid_transfer: centsToMoney(paid_transfer),
  });
}

/** The draft's exact payload, validated the way the contract will read it. */
export function buildPurchaseInput(draft: PurchaseDraft, operationKey: string): PurchaseInput {
  if (purchaseDraftProblem(draft) !== null) return invalidPurchase();
  if (typeof operationKey !== 'string' || !operationKeyShape.test(operationKey)) return invalidPurchase();
  const used = draft.lines.filter((line): line is Extract<PurchaseLine, { kind: 'used' }> => line.kind === 'used')
    .map(line => Object.freeze({ model: line.model, quantity: line.quantity,
      unit_price: centsToMoney(line.unit_price_cents) }))
    .sort((left, right) => left.model < right.model ? -1 : left.model > right.model ? 1 : 0);
  const scrap = draft.lines.filter((line): line is Extract<PurchaseLine, { kind: 'scrap' }> => line.kind === 'scrap')
    .map(line => Object.freeze({ material_id: line.material_id, kg: kgMilliToWire(line.kg_milli),
      price_per_kg: centsToMoney(line.price_per_kg_cents) }))
    .sort((left, right) => left.material_id - right.material_id);
  try {
    return canonicalPurchaseInput({ operation_key: operationKey, note: draft.note,
      used_lines: used, scrap_lines: scrap,
      paid_cash: centsToMoney(draft.cash_cents), paid_transfer: centsToMoney(draft.transfer_cents) });
  } catch { return invalidPurchase(); }
}

// ---------------------------------------------------------------------------------
// The reversal
// ---------------------------------------------------------------------------------

/** One row of the history: a document header, never its lines. */
export interface PurchaseHistoryRow {
  readonly id: number;
  readonly created_at: string;
  readonly total_cents: bigint;
  readonly reverses_purchase_id: number | null;
  readonly reversed_by: number | null;
  readonly used_units: number;
  readonly scrap_lines: number;
}

/** A document is reversible only while nothing reversed it and it is not a counter-document. */
export function purchaseReversible(row: PurchaseHistoryRow): boolean {
  return row.reversed_by === null && row.reverses_purchase_id === null;
}

export interface PurchaseReversalInput { readonly operation_key: string; readonly reason: string }

/** The reason is trimmed, non-empty and bounded: exactly what is sent and persisted. */
export function canonicalPurchaseReason(reason: string): string {
  if (typeof reason !== 'string' || !isWellFormed(reason)) return invalidReason();
  const trimmed = reason.trim();
  if (trimmed === '' || Array.from(trimmed).length > purchaseMaxReason) return invalidReason();
  return trimmed;
}

export function canonicalPurchaseReversalInput(input: PurchaseReversalInput): PurchaseReversalInput {
  const record = fields(input, ['operation_key', 'reason']);
  const operation_key = record.operation_key;
  if (typeof operation_key !== 'string' || !operationKeyShape.test(operation_key)) return invalidReason();
  return Object.freeze({ operation_key, reason: canonicalPurchaseReason(record.reason as string) });
}

export function newPurchaseOperationKey(source: Pick<Crypto, 'getRandomValues'> | undefined = globalThis.crypto): string {
  return newTransferRetryKey(source);
}
