/**
 * Transport of the branch metrics read (`GET /api/metrics?period=…`). Every answer is admitted only
 * when it is JSON of exactly the contract's shape, and every account of a period is judged before it
 * reaches the screen: canonical money, non-negative counts, a drawer that closes and a fund that
 * closes. The two figures a period can state above what it expected are published as counted: the
 * net of the fund's purchases may be negative and a delivery may exceed the material it delivers.
 * Money and weights stay exact integer units; no amount is ever coerced to a float (S8).
 */
import { LosslessNumber, parse as parseJSON } from 'lossless-json';

export type MetricsErrorCode = 'invalid_request' | 'forbidden' | 'not_found'
  | 'service_unavailable' | 'invalid_response' | 'network' | 'aborted';

/** The refusal the screen shows when the answer is not one this server could have written (S8). */
export const metricsInvalidResponseMessage = 'Respuesta inválida del servidor.';

export const metricsUnavailable =
  'No se pudieron leer las métricas de la sucursal. Revisá la conexión e intentá de nuevo.';

/** One admitted refusal per HTTP status; nothing else may reach the UI. */
export const metricsAdmittedErrors: ReadonlyMap<number, readonly MetricsErrorCode[]> = new Map([
  [400, ['invalid_request']],
  [403, ['forbidden']],
  [404, ['not_found']],
  [503, ['service_unavailable']],
]);

/** Spanish message for every failure, including the transport ones. */
export const metricsErrorMessages: Record<MetricsErrorCode, string> = {
  invalid_request: 'El servidor no admite este período en esta sucursal. Elegí otro período del selector.',
  forbidden: 'No tenés permiso para ver las métricas de esta sucursal.',
  not_found: 'Ese período ya no existe en esta sucursal. Actualizá los períodos del selector.',
  service_unavailable: 'El servicio no está disponible. No pudimos leer las métricas de la sucursal.',
  invalid_response: metricsInvalidResponseMessage,
  network: metricsUnavailable,
  aborted: 'La operación se interrumpió. Revisá la conexión e intentá de nuevo.',
};

/** Where the numbers of the period came from, and the only thing that decides whether they move. */
export type MetricsSource = 'settlement' | 'live' | 'history';
const metricsSources: readonly MetricsSource[] = ['settlement', 'live', 'history'];

/** A period of the selector: a closed settlement, the live one, or the whole history. */
export type MetricsPeriodKind = 'settlement' | 'open' | 'all';
const metricsPeriodKinds: readonly MetricsPeriodKind[] = ['settlement', 'open', 'all'];

export interface MetricsPeriod {
  readonly kind: MetricsPeriodKind;
  readonly closing_id: number | null;
  readonly from: string | null;
  readonly to: string | null;
  readonly label: string;
}

/** The money of the period by source; the commission is reported beside the drawer, never inside it. */
export interface MetricsSales {
  readonly total_cents: bigint;
  readonly cash_cents: bigint;
  readonly card_cents: bigint;
  readonly transfer_cents: bigint;
  readonly qr_cents: bigint;
  readonly commission_cents: bigint;
  readonly sales: number;
  readonly units: number;
}

/** The operational drawer: what it opened with, what it took, and the count when there is one. */
export interface MetricsCash {
  readonly opening_cents: bigint;
  readonly sales_cents: bigint;
  readonly expenses_cents: bigint;
  readonly expected_cents: bigint;
  readonly counted_cents: bigint | null;
  readonly difference_cents: bigint | null;
}

/** The purchase envelope, with the amount the warehouse leaves in it as the next opening. */
export interface MetricsFund {
  readonly opening_cents: bigint;
  readonly purchases_cents: bigint;
  readonly expected_cents: bigint;
  readonly counted_cents: bigint | null;
  readonly difference_cents: bigint | null;
  readonly replacement_cents: bigint | null;
}

/** One material of the scrap sheet, in integer thousandths of a kilogram. */
export interface MetricsMaterialLine {
  readonly material_id: number;
  readonly material: string;
  readonly bought_milli: bigint;
  readonly delivered_milli: bigint | null;
}

/**
 * The material sheet of the period. The two delivered figures are null as a whole while any line is
 * uncounted, so a half-counted sheet never reads as delivered.
 */
export interface MetricsMaterials {
  readonly used_units: number;
  readonly used_delivered_units: number | null;
  readonly scrap_milli: bigint;
  readonly scrap_delivered_milli: bigint | null;
  readonly materials: readonly MetricsMaterialLine[];
}

/** One row of the ranking: units first, the money of that row as the secondary reading. */
export interface MetricsModel {
  readonly catalog_entry_id: number;
  readonly brand: string;
  readonly model: string;
  readonly capacity_ah: string;
  readonly units: number;
  readonly money_cents: bigint;
}

export interface MetricsStock { readonly units: number }

/** The three kinds the branch's cash ledger writes: the money paid, taken and left in the drawer. */
export type MetricsMovementKind = 'aporte' | 'recaudacion' | 'gasto';
const metricsMovementKinds: readonly MetricsMovementKind[] = ['aporte', 'recaudacion', 'gasto'];

/** One row of the ledger after the last cut: its kind, its amount and the instant it happened. */
export interface MetricsMovement {
  readonly kind: MetricsMovementKind;
  readonly amount_cents: bigint;
  readonly occurred_at: string;
}

/**
 * The drawer of the branch today, published whatever period is on screen (S12). `since` is the cut of
 * the last closed settlement and null for a branch that never closed one, where the window is
 * everything the branch ever did. The expectation is the settlement's own identity and the movements
 * are information the card lists, never terms of that sum (S14).
 */
export interface MetricsToday {
  readonly since: string | null;
  readonly opening_cents: bigint;
  readonly sales_cents: bigint;
  readonly expenses_cents: bigint;
  readonly expected_cents: bigint;
  readonly movements: readonly MetricsMovement[];
}

/**
 * The purchase fund of the branch today, published whatever period is on screen (S15). `since` is the
 * cut of the last closed settlement and null for a branch that never closed one, where the window is
 * everything the branch ever bought. The balance is what the last cut left in the envelope minus the
 * cash spent on purchases after it -- the settlement's own fund identity -- and is signed: an envelope
 * that spent more than it inherited is a shortage the branch must see, not a number to hide (S16). The
 * three counts are the volume of those same documents, net of the counter-documents.
 */
export interface MetricsFundToday {
  readonly since: string | null;
  readonly opening_cents: bigint;
  readonly purchases_cents: bigint;
  readonly balance_cents: bigint;
  readonly documents: number;
  readonly used_units: number;
  readonly scrap_milli: bigint;
}

/** The whole answer of one period: the selector, the chosen period, its origin and its accounts. */
export interface MetricsAnswer {
  readonly periods: readonly MetricsPeriod[];
  readonly period: MetricsPeriod;
  readonly source: MetricsSource;
  readonly sales: MetricsSales;
  readonly cash: MetricsCash | null;
  readonly fund: MetricsFund | null;
  readonly materials: MetricsMaterials | null;
  readonly top_models: readonly MetricsModel[];
  readonly stock: MetricsStock;
  readonly today: MetricsToday;
  readonly fund_today: MetricsFundToday;
}

// ---------------------------------------------------------------------------------
// Strict decoding
// ---------------------------------------------------------------------------------

function invalidResponse(): never { throw new Error(metricsInvalidResponseMessage); }

function decode(raw: string): unknown {
  try {
    return parseJSON(raw, null, { onDuplicateKey: () => { throw new Error('duplicate key'); } });
  } catch { return invalidResponse(); }
}

function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof LosslessNumber) {
    return invalidResponse();
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some(key => !Object.hasOwn(record, key))) {
    return invalidResponse();
  }
  return record;
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value === '' || value.includes('\0') || !value.isWellFormed()) {
    return invalidResponse();
  }
  return value;
}

function numeric(value: unknown): string {
  if (!(value instanceof LosslessNumber)) return invalidResponse();
  return value.toString();
}

/** A count is a whole, non-negative JSON number: no exponent, no padding, no sign. */
function count(value: unknown, max: number): number {
  const raw = numeric(value);
  if (!/^(0|[1-9]\d*)$/.test(raw)) return invalidResponse();
  const exact = BigInt(raw);
  if (exact > BigInt(max)) return invalidResponse();
  return Number(exact);
}

function timestamp(value: unknown): string {
  const raw = text(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.test(raw)) {
    return invalidResponse();
  }
  const seconds = raw.slice(0, 19) + 'Z';
  const date = new Date(seconds);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19) !== raw.slice(0, 19)) {
    return invalidResponse();
  }
  if (!Number.isFinite(Date.parse(raw))) return invalidResponse();
  return raw;
}

/** The database writes `numeric(12,2)`, so this is the largest amount it can publish. */
const metricsMaxMoneyCents = 999_999_999_999n;
const wireMoneyShape = /^-?(0|[1-9]\d{0,9})\.\d{2}$/;

/**
 * A published amount is the canonical two-decimal text the database writes. An expectation or a
 * difference carries its sign; a collection, a count or a replacement never does. A negative zero is
 * not canonical: the database writes `0.00`.
 */
function wireMoney(value: unknown, signed: boolean): bigint {
  if (typeof value !== 'string' || !wireMoneyShape.test(value)) return invalidResponse();
  const negative = value.startsWith('-');
  if (negative && !signed) return invalidResponse();
  const [whole, fraction] = (negative ? value.slice(1) : value).split('.');
  const magnitude = BigInt(whole) * 100n + BigInt(fraction);
  if (magnitude > metricsMaxMoneyCents) return invalidResponse();
  if (negative && magnitude === 0n) return invalidResponse();
  return negative ? -magnitude : magnitude;
}

function optionalMoney(value: unknown, signed: boolean): bigint | null {
  return value === null ? null : wireMoney(value, signed);
}

/** A battery is counted whole: the delivered units are the count the warehouse stated. */
function deliveredUnits(value: unknown): number | null {
  if (value === null) return null;
  // A count larger than the bought quantity is a counted excess, not a shape this server never
  // wrote: it is informed exactly like the cash difference of a drawer.
  return count(value, Number.MAX_SAFE_INTEGER);
}

/** A signed count is the net of a set of documents: it carries a sign, never padding or a fraction. */
function signedCount(value: unknown): number {
  const raw = numeric(value);
  if (!/^-?(0|[1-9]\d*)$/.test(raw) || raw === '-0') return invalidResponse();
  const exact = BigInt(raw);
  if (exact > BigInt(Number.MAX_SAFE_INTEGER) || exact < -BigInt(Number.MAX_SAFE_INTEGER)) {
    return invalidResponse();
  }
  return Number(exact);
}

/** A signed weight is the net of the same documents, in thousandths of a kilogram. */
function signedMilli(value: unknown): bigint {
  const raw = numeric(value);
  if (!/^-?(0|[1-9]\d*)$/.test(raw) || raw === '-0') return invalidResponse();
  return BigInt(raw);
}

/** A weight is published in integer thousandths of a kilogram by a whole, non-negative count. */
function milli(value: unknown, max: bigint): bigint {
  const raw = numeric(value);
  if (!/^(0|[1-9]\d*)$/.test(raw)) return invalidResponse();
  const exact = BigInt(raw);
  if (exact > max) return invalidResponse();
  return exact;
}

// ---------------------------------------------------------------------------------
// The selector, the chosen period and the origin of the numbers
// ---------------------------------------------------------------------------------

/** The server generates the words of a period, so this is its own bound, not a client cap. */
const metricsMaxPeriodLabel = 200;

/** One period: the kind decides which fields it is allowed to carry. */
function periodValue(value: unknown): MetricsPeriod {
  const record = fields(value, ['kind', 'closing_id', 'from', 'to', 'label']);
  if (typeof record.kind !== 'string' || !metricsPeriodKinds.includes(record.kind as MetricsPeriodKind)) {
    return invalidResponse();
  }
  const kind = record.kind as MetricsPeriodKind;
  const label = text(record.label);
  if (Array.from(label).length > metricsMaxPeriodLabel) return invalidResponse();
  if (kind === 'all') {
    // The whole history is not a stretch of time: an id or a window here is not this server's answer.
    if (record.closing_id !== null || record.from !== null || record.to !== null) return invalidResponse();
    return Object.freeze({ kind, closing_id: null, from: null, to: null, label });
  }
  const closing_id = count(record.closing_id, Number.MAX_SAFE_INTEGER);
  if (closing_id < 1) return invalidResponse();
  const from = timestamp(record.from);
  const to = timestamp(record.to);
  if (Date.parse(from) > Date.parse(to)) return invalidResponse();
  return Object.freeze({ kind, closing_id, from, to, label });
}

/** The wire token of a period: the closing id for a settlement, the kind otherwise. */
export function metricsPeriodToken(period: MetricsPeriod): string {
  return period.closing_id === null ? period.kind : String(period.closing_id);
}

/** Two published periods are the same only when every published field agrees. */
function sameMetricsPeriod(left: MetricsPeriod, right: MetricsPeriod): boolean {
  return left.kind === right.kind && left.closing_id === right.closing_id
    && left.from === right.from && left.to === right.to && left.label === right.label;
}

/**
 * The selector of this contract is published in one frozen order: every closed settlement newest
 * first, then the live one when the branch is inside one, then the whole history. The pending balance
 * is never an entry. A list that is not that order, that repeats a period or that carries two live
 * settlements is not a selector this domain wrote.
 */
function periodsValue(value: unknown): readonly MetricsPeriod[] {
  if (!Array.isArray(value) || value.length === 0) return invalidResponse();
  const periods = value.map(periodValue);
  if (periods[periods.length - 1].kind !== 'all') return invalidResponse();
  const seen = new Set<string>();
  let live = 0;
  let previousClosing = Number.POSITIVE_INFINITY;
  periods.forEach((period, index) => {
    const identity = [period.kind, period.closing_id ?? '-', period.from ?? '-', period.to ?? '-',
      period.label].join('|');
    if (seen.has(identity)) return invalidResponse();
    seen.add(identity);
    if (period.kind === 'all' && index !== periods.length - 1) return invalidResponse();
    if (period.kind === 'settlement') {
      // The live settlement is the newest of the branch: a closed one after it, or an ascending
      // closing id, is not the history this server read.
      if (live > 0 || (period.closing_id ?? 0) >= previousClosing) return invalidResponse();
      previousClosing = period.closing_id ?? 0;
    }
    if (period.kind === 'open') {
      if (live > 0) return invalidResponse();
      live += 1;
    }
  });
  return Object.freeze(periods);
}

function sourceValue(value: unknown, kind: MetricsPeriodKind): MetricsSource {
  if (typeof value !== 'string' || !metricsSources.includes(value as MetricsSource)) {
    return invalidResponse();
  }
  // The origin is decided by the period: frozen settlement, live settlement, whole history. An
  // answer that pairs them differently is describing another period than the one it names.
  const expected: MetricsSource = kind === 'settlement' ? 'settlement' : kind === 'open' ? 'live' : 'history';
  if (value !== expected) return invalidResponse();
  return expected;
}

// ---------------------------------------------------------------------------------
// The accounts of the period
// ---------------------------------------------------------------------------------

function salesValue(value: unknown): MetricsSales {
  const record = fields(value, ['total', 'cash', 'card', 'transfer', 'qr', 'commission',
    'sales', 'units']);
  return Object.freeze({
    total_cents: wireMoney(record.total, false),
    cash_cents: wireMoney(record.cash, false),
    card_cents: wireMoney(record.card, false),
    transfer_cents: wireMoney(record.transfer, false),
    qr_cents: wireMoney(record.qr, false),
    commission_cents: wireMoney(record.commission, false),
    sales: count(record.sales, Number.MAX_SAFE_INTEGER),
    units: count(record.units, Number.MAX_SAFE_INTEGER),
  });
}

/** A counted amount and its difference are published together or not at all: a difference of zero
 * would be a count that never happened. */
function countedValue(record: Record<string, unknown>, expected: bigint,
  keys: readonly [string, string]): { counted_cents: bigint | null; difference_cents: bigint | null } {
  const counted_cents = optionalMoney(record[keys[0]], false);
  const difference_cents = optionalMoney(record[keys[1]], true);
  if ((counted_cents === null) !== (difference_cents === null)) return invalidResponse();
  if (counted_cents === null || difference_cents === null) {
    return { counted_cents: null, difference_cents: null };
  }
  if (difference_cents !== counted_cents - expected) return invalidResponse();
  return { counted_cents, difference_cents };
}

/**
 * The drawer closes: the opening plus the cash of the period minus its expenses is the expectation,
 * and the count completes it. The commission is inside none of these identities.
 */
function cashValue(value: unknown): MetricsCash {
  const record = fields(value, ['opening', 'sales', 'expenses', 'expected', 'counted', 'difference']);
  const opening_cents = wireMoney(record.opening, false);
  const sales_cents = wireMoney(record.sales, false);
  const expenses_cents = wireMoney(record.expenses, false);
  const expected_cents = wireMoney(record.expected, true);
  if (expected_cents !== opening_cents + sales_cents - expenses_cents) return invalidResponse();
  const counted = countedValue(record, expected_cents, ['counted', 'difference']);
  return Object.freeze({ opening_cents, sales_cents, expenses_cents, expected_cents, ...counted });
}

/** The envelope closes the same way: what it inherited minus the cash its purchases spent. */
function fundValue(value: unknown): MetricsFund {
  const record = fields(value, ['opening', 'purchases', 'expected', 'counted', 'difference',
    'replacement']);
  const opening_cents = wireMoney(record.opening, false);
  // The net of the period's purchases is a difference: a counter-document that reversed a purchase
  // of an earlier period leaves it negative, and the envelope still closes on its own sign.
  const purchases_cents = wireMoney(record.purchases, true);
  const expected_cents = wireMoney(record.expected, true);
  if (expected_cents !== opening_cents - purchases_cents) return invalidResponse();
  const counted = countedValue(record, expected_cents, ['counted', 'difference']);
  return Object.freeze({
    opening_cents, purchases_cents, expected_cents,
    // The amount the warehouse left in the envelope is null while nobody stated it, never a zero.
    replacement_cents: optionalMoney(record.replacement, false),
    ...counted,
  });
}

/** One material of the scrap sheet: what the period bought and what the warehouse took. */
function materialLine(value: unknown): MetricsMaterialLine {
  const record = fields(value, ['material_id', 'material', 'bought_milli', 'delivered_milli']);
  const bought_milli = milli(record.bought_milli, BigInt(Number.MAX_SAFE_INTEGER));
  // A row of the sheet is a material the period actually bought: no bought grams, no row.
  if (bought_milli <= 0n) return invalidResponse();
  // The delivered weight is what the warehouse counted, so it is bounded by nothing but its own
  // non-negative integer shape: a count above the bought one is admitted as the excess it is.
  const delivered_milli = record.delivered_milli === null
    ? null : milli(record.delivered_milli, BigInt(Number.MAX_SAFE_INTEGER));
  const material_id = count(record.material_id, 32767);
  if (material_id < 1) return invalidResponse();
  return Object.freeze({ material_id, material: text(record.material), bought_milli, delivered_milli });
}

/**
 * The material sheet: the used units, the scrap by material and the delivery as one reading. A sheet
 * with any uncounted line states no delivery at all, so a half-counted sheet never reads as
 * delivered. A counted delivery is published as it was counted and may exceed the bought quantity.
 */
function materialsValue(value: unknown): MetricsMaterials {
  const record = fields(value, ['used_units', 'used_delivered_units', 'scrap_milli',
    'scrap_delivered_milli', 'materials']);
  const used_units = count(record.used_units, Number.MAX_SAFE_INTEGER);
  const scrap_milli = milli(record.scrap_milli, BigInt(Number.MAX_SAFE_INTEGER));
  if (!Array.isArray(record.materials)) return invalidResponse();
  const materialLines = record.materials.map(materialLine);
  const ids = new Set<number>();
  for (const line of materialLines) {
    if (ids.has(line.material_id)) return invalidResponse();
    ids.add(line.material_id);
  }
  // The sheet's own total is the sum of its rows: a total that does not close is another answer.
  const bought = materialLines.reduce((sum, line) => sum + line.bought_milli, 0n);
  if (bought !== scrap_milli) return invalidResponse();
  const used_delivered_units = deliveredUnits(record.used_delivered_units);
  const scrap_delivered_milli = record.scrap_delivered_milli === null
    ? null : milli(record.scrap_delivered_milli, BigInt(Number.MAX_SAFE_INTEGER));
  if ((used_delivered_units === null) !== (scrap_delivered_milli === null)) return invalidResponse();
  const allCounted = materialLines.every(line => line.delivered_milli !== null);
  const noneCounted = materialLines.every(line => line.delivered_milli === null);
  if (!allCounted && !noneCounted) return invalidResponse();
  if (allCounted !== (scrap_delivered_milli !== null)) return invalidResponse();
  if (scrap_delivered_milli !== null) {
    const delivered = materialLines.reduce((sum, line) => sum + (line.delivered_milli ?? 0n), 0n);
    if (delivered !== scrap_delivered_milli) return invalidResponse();
  }
  return Object.freeze({ used_units, used_delivered_units, scrap_milli, scrap_delivered_milli,
    materials: Object.freeze(materialLines) });
}

/** The rendered capacity of a model: ampere-hours, whole or fractional, without padding. */
const capacityShape = /^\d{1,9}(\.\d{1,6})?$/;
/** The ranking publishes at most five models. */
const metricsTopModels = 5;

/**
 * One row of the ranking. The server already ordered it by units, so the only ordering this parser
 * can judge without inventing one is that the units never grow and that no model is listed twice.
 */
function modelValue(value: unknown): MetricsModel {
  const record = fields(value, ['catalog_entry_id', 'brand', 'model', 'capacity_ah', 'units', 'money']);
  const catalog_entry_id = count(record.catalog_entry_id, Number.MAX_SAFE_INTEGER);
  if (catalog_entry_id < 1) return invalidResponse();
  const capacity_ah = text(record.capacity_ah);
  if (!capacityShape.test(capacity_ah)) return invalidResponse();
  const units = count(record.units, Number.MAX_SAFE_INTEGER);
  // A model nobody sold is not a row of the ranking.
  if (units < 1) return invalidResponse();
  return Object.freeze({ catalog_entry_id, brand: text(record.brand), model: text(record.model),
    capacity_ah, units, money_cents: wireMoney(record.money, false) });
}

function topModelsValue(value: unknown): readonly MetricsModel[] {
  if (!Array.isArray(value) || value.length > metricsTopModels) return invalidResponse();
  const models = value.map(modelValue);
  const seen = new Set<number>();
  models.forEach((model, index) => {
    if (seen.has(model.catalog_entry_id)) return invalidResponse();
    seen.add(model.catalog_entry_id);
    // The ranking is by units and never by money: units only descend.
    if (index > 0 && model.units > models[index - 1].units) return invalidResponse();
  });
  return Object.freeze(models);
}

function stockValue(value: unknown): MetricsStock {
  return Object.freeze({ units: count(fields(value, ['units']).units, Number.MAX_SAFE_INTEGER) });
}

/** The server bounds the ledger list of today, so a longer one is another answer. */
const metricsTodayMovements = 50;

/** One movement of the drawer: a kind the ledger writes, a positive amount and a real instant. */
function movementValue(value: unknown): MetricsMovement {
  const record = fields(value, ['kind', 'amount', 'occurred_at']);
  if (typeof record.kind !== 'string'
    || !metricsMovementKinds.includes(record.kind as MetricsMovementKind)) {
    return invalidResponse();
  }
  const amount_cents = wireMoney(record.amount, false);
  // The ledger writes an amount above zero: a movement exists because money moved.
  if (amount_cents <= 0n) return invalidResponse();
  return Object.freeze({ kind: record.kind as MetricsMovementKind, amount_cents,
    occurred_at: timestamp(record.occurred_at) });
}

/**
 * The drawer of today. Its expectation is the settlement's own identity -- what the last cut left plus
 * the cash collected after it minus the expenses paid after it -- so the card and the acta of the same
 * drawer cannot state two different numbers (S12).
 *
 * It is deliberately NOT compared with `cash.expected` of a live period: the two are separate
 * statements of the same drawer, so a sale landing between the two reads would move one and not the
 * other, and refusing that answer would refuse a payload this server really wrote (S12, S14).
 */
function todayValue(value: unknown): MetricsToday {
  const record = fields(value, ['since', 'opening', 'sales', 'expenses', 'expected', 'movements']);
  const opening_cents = wireMoney(record.opening, false);
  const sales_cents = wireMoney(record.sales, false);
  const expenses_cents = wireMoney(record.expenses, false);
  const expected_cents = wireMoney(record.expected, true);
  if (expected_cents !== opening_cents + sales_cents - expenses_cents) return invalidResponse();
  if (!Array.isArray(record.movements) || record.movements.length > metricsTodayMovements) {
    return invalidResponse();
  }
  const movements = record.movements.map(movementValue);
  movements.forEach((movement, index) => {
    // The list reads from the oldest movement to the newest: an order nobody wrote is another answer.
    if (index > 0 && Date.parse(movement.occurred_at) < Date.parse(movements[index - 1].occurred_at)) {
      return invalidResponse();
    }
  });
  return Object.freeze({
    // A branch that never closed a settlement has no cut: its window is everything it ever did.
    since: record.since === null ? null : timestamp(record.since),
    opening_cents, sales_cents, expenses_cents, expected_cents,
    movements: Object.freeze(movements),
  });
}

/**
 * The purchase envelope of today. Its balance is the settlement's own fund identity -- what the last cut
 * left in it minus the cash spent on purchases after it -- so the card and the acta of the same envelope
 * cannot state two different balances (S16). The purchases are signed because a counter-document after
 * the cut nets them down, and the balance is signed because a shortage is a fact the branch must see.
 *
 * It is deliberately NOT compared with `fund` of a period on screen: the two are separate reads of the
 * same envelope, so a purchase landing between them would move one and not the other, and refusing that
 * answer would refuse a payload this server really wrote (S16).
 */
function fundTodayValue(value: unknown): MetricsFundToday {
  const record = fields(value, ['since', 'opening', 'purchases', 'balance', 'documents', 'used_units',
    'scrap_milli']);
  const opening_cents = wireMoney(record.opening, false);
  const purchases_cents = wireMoney(record.purchases, true);
  const balance_cents = wireMoney(record.balance, true);
  if (balance_cents !== opening_cents - purchases_cents) return invalidResponse();
  const since = record.since;
  // A branch without a previous closure states no cut and inherits nothing: the two facts are one state.
  if (since === null && opening_cents !== 0n) return invalidResponse();
  return Object.freeze({
    // A branch that never closed a settlement has no cut: its window is everything it ever bought.
    since: since === null ? null : timestamp(since),
    opening_cents, purchases_cents, balance_cents,
    documents: count(record.documents, Number.MAX_SAFE_INTEGER),
    // The units and the kilograms are the net of the same documents: a counter-document that reversed
    // an earlier purchase may leave them negative, and that is a reading, not a malformed answer.
    used_units: signedCount(record.used_units),
    scrap_milli: signedMilli(record.scrap_milli),
  });
}

/**
 * Parses the metrics answer whole: the selector, the period that was chosen out of it, where its
 * numbers came from and the accounts themselves. The chosen period must be one of the selector's
 * own entries, and the history states no drawer and no envelope at all, so the words on screen and
 * the period they describe can never disagree (S6, S9).
 */
export function parseMetricsAnswer(raw: string): MetricsAnswer {
  const record = fields(decode(raw), ['periods', 'period', 'source', 'sales', 'cash', 'fund',
    'materials', 'top_models', 'stock', 'today', 'fund_today']);
  const periods = periodsValue(record.periods);
  const period = periodValue(record.period);
  if (!periods.some(entry => sameMetricsPeriod(entry, period))) return invalidResponse();
  const source = sourceValue(record.source, period.kind);
  const sales = salesValue(record.sales);
  const history = source === 'history';
  // A drawer and an envelope are closed one settlement at a time: the accumulated history has
  // nothing to state, and a settlement always states both (S9).
  if (history !== (record.cash === null) || history !== (record.fund === null)) return invalidResponse();
  const cash = record.cash === null ? null : cashValue(record.cash);
  const fund = record.fund === null ? null : fundValue(record.fund);
  // The material sheet is the third account: the history has none, and a settlement whose sheet was
  // never seeded publishes none either.
  if (history && record.materials !== null) return invalidResponse();
  const materials = record.materials === null ? null : materialsValue(record.materials);
  const top_models = topModelsValue(record.top_models);
  const stock = stockValue(record.stock);
  // The drawer of today is stated by every source and is never null: it is the drawer of the branch,
  // not a total of the period, and it is the one reading a branch without a settlement open has.
  const today = todayValue(record.today);
  // The purchase envelope of today is stated by every source too: it is the second money box of the
  // branch, and without an open settlement there is no other screen that states it (S15).
  const fund_today = fundTodayValue(record.fund_today);
  return Object.freeze({ periods, period, source, sales, cash, fund, materials, top_models, stock,
    today, fund_today });
}

// ---------------------------------------------------------------------------------
// Path and transport
// ---------------------------------------------------------------------------------

/** The period token this contract reads: the whole history or one positive closing id. */
function metricsPeriodTokenIsValid(token: string): boolean {
  if (token === 'all') return true;
  return /^[1-9]\d*$/.test(token) && Number.isSafeInteger(Number(token));
}

export function metricsPath(token: string): string {
  if (!metricsPeriodTokenIsValid(token)) throw new Error('Consulta de métricas inválida.');
  return `/api/metrics?period=${token}`;
}

export function parseMetricsError(raw: string, status: number): MetricsErrorCode {
  const admitted = metricsAdmittedErrors.get(status);
  if (!admitted) return invalidResponse();
  const envelope = fields(decode(raw), ['error']);
  const code = envelope.error;
  if (typeof code !== 'string' || !admitted.includes(code as MetricsErrorCode)) return invalidResponse();
  return code as MetricsErrorCode;
}

export class MetricsAPIError extends Error {
  constructor(public readonly code: MetricsErrorCode, public readonly status: number | null) {
    super(code); this.name = 'MetricsAPIError';
  }
}

const jsonHeader = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;

function transportFailure(error: unknown, signal?: AbortSignal): MetricsAPIError {
  const aborted = signal?.aborted === true
    || (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError');
  return new MetricsAPIError(aborted ? 'aborted' : 'network', null);
}

export function createMetricsAPI(fetch: typeof globalThis.fetch = globalThis.fetch) {
  return {
    /**
     * The metrics of one period of the actor's own branch. The answer is evidence only when it
     * repeats the period that was asked for, so the selector can never describe another period.
     */
    async read(token: string, signal?: AbortSignal): Promise<MetricsAnswer> {
      let path: string;
      try { path = metricsPath(token); } catch { throw new MetricsAPIError('invalid_request', null); }
      let reply: Response;
      let raw: string;
      try {
        reply = await fetch(path, { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal });
        raw = await reply.text();
      } catch (error) {
        if (error instanceof MetricsAPIError) throw error;
        throw transportFailure(error, signal);
      }
      const malformed = () => new MetricsAPIError('invalid_response', reply.status);
      if (!jsonHeader.test(reply.headers.get('Content-Type') ?? '')) throw malformed();
      if (reply.status !== 200) {
        let code: MetricsErrorCode;
        try { code = parseMetricsError(raw, reply.status); } catch { throw malformed(); }
        throw new MetricsAPIError(code, reply.status);
      }
      let answer: MetricsAnswer;
      try { answer = parseMetricsAnswer(raw); } catch { throw malformed(); }
      if (metricsPeriodToken(answer.period) !== token) throw malformed();
      return answer;
    },
  };
}

export type MetricsAPI = ReturnType<typeof createMetricsAPI>;
