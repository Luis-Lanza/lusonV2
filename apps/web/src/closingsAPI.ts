/**
 * Transport of the warehouse's side of the rendición de cuentas. Every answer is admitted only
 * when it is JSON of exactly the contract's shape, and every amount stays canonical text that is
 * read into exact cents: no amount is ever coerced to a float.
 *
 * The document's derived numbers are revalidated against their own identities before it reaches
 * a screen, so a settlement whose expected drawer, difference or taken cash disagree with its
 * facts — a commission inside a cash figure, for instance — is never described as valid.
 */
import { LosslessNumber, parse as parseJSON } from 'lossless-json';
import { parseInventory, queryURL, validSearch } from './model';
import {
  canonicalCorrectionBody, closingCataloguePageSize, closingCents, closingCountRequestLines,
  closingDecisionPayload,
  closingEvidenceTypes, closingMaterialMilli, closingMaterialQuantityIsCanonical,
  closingMaxCounted, closingMaxEvidenceBytes,
  closingMaxID, closingMaxMaterialID, closingMaxPage, closingPageSizes,
  closingRail, closingSignedCents, closingStatuses,
  closingFirstBranch, closingMaxBranch,
  type Closing, type ClosingCatalogueVariant, type ClosingCorrection,
  type ClosingCorrectionEffect, type ClosingCorrectionKind,
  type ClosingCorrectionPayload, type ClosingCorrectionQuantity, type ClosingCorrectionStatus,
  type ClosingCountLine, type ClosingDecision, type ClosingDecisionPayload, type CorrectionBody,
  type ClosingEvidence, type ClosingEvidenceType, type ClosingExpense,
  type ClosingMaterialKind, type ClosingMaterialLine, type ClosingMaterialUnit,
  type ClosingOffer, type ClosingOfferLine,
  type ClosingPage, type ClosingPolarity, type ClosingPurchaseFund, type ClosingRail,
  type ClosingRound, type ClosingStatus,
  type CountPayloadLine, type DrawerPayload, type MaterialCountedInput,
} from './closingModel';
import { formatMoney } from './pointOfSaleModel';

export type ClosingErrorCode =
  | 'invalid_request' | 'unauthenticated' | 'forbidden' | 'not_found' | 'method_not_allowed'
  | 'settlement_live' | 'branch_retired' | 'count_pending' | 'cash_not_stated'
  | 'fund_exceeds_drawer' | 'commission_rate_missing' | 'count_frozen' | 'state_conflict'
  | 'closure_refused' | 'reserved_stock' | 'stock_moved' | 'proposal_stale' | 'round_not_accepted'
  | 'branch_frozen' | 'correction_not_closed' | 'correction_pending' | 'correction_decided'
  | 'correction_payload' | 'correction_fund_started' | 'correction_journal'
  | 'service_unavailable' | 'invalid_response' | 'network' | 'aborted';

/** The admitted refusal per HTTP status; nothing else may reach the UI. */
export const closingAdmittedErrors: ReadonlyMap<number, readonly ClosingErrorCode[]> = new Map([
  [400, ['invalid_request']],
  [401, ['unauthenticated']],
  [403, ['forbidden']],
  [404, ['not_found']],
  [405, ['method_not_allowed']],
  [409, ['settlement_live', 'branch_retired', 'count_pending', 'cash_not_stated',
    'fund_exceeds_drawer', 'commission_rate_missing', 'count_frozen', 'state_conflict',
    'closure_refused', 'reserved_stock', 'stock_moved', 'proposal_stale', 'round_not_accepted',
    'branch_frozen', 'correction_not_closed', 'correction_pending', 'correction_decided',
    'correction_payload', 'correction_fund_started', 'correction_journal']],
  [503, ['service_unavailable']],
]);

/** Spanish message for every failure, including the transport ones. */
export const closingErrorMessages: Record<ClosingErrorCode, string> = {
  invalid_request: 'El servidor rechazó la rendición: revisá el conteo, los montos y la observación. No se registró nada.',
  unauthenticated: 'La sesión no está activa. Volvé a iniciar sesión: no se registró nada.',
  forbidden: 'No podés operar esta rendición desde esta cuenta. No se registró nada.',
  not_found: 'La rendición no existe para esta cuenta.',
  method_not_allowed: 'El servidor no admite esa operación.',
  settlement_live: 'La sucursal ya tiene una rendición abierta: hay que retomarla o cerrarla.',
  branch_retired: 'La sucursal está retirada: no se puede rendir cuentas de ella.',
  count_pending: 'Falta contar una variante del conteo: sin el conteo completo no se puede proponer.',
  cash_not_stated: 'Falta la caja contada y el fondo que queda: el cierre no se puede proponer sin eso.',
  fund_exceeds_drawer: 'El fondo supera la caja contada más el aporte.',
  commission_rate_missing: 'La sucursal no tiene porcentaje de comisión configurado: sin eso no se puede proponer.',
  count_frozen: 'El conteo ya no se puede editar en este estado.',
  state_conflict: 'El estado de la rendición no admite esta operación.',
  closure_refused: 'El cierre fue rechazado por su propia regla de caja.',
  reserved_stock: 'Una variante de la sucursal todavía tiene stock reservado: el cierre no se puede proponer.',
  stock_moved: 'Una variante se movió durante la rendición: hay que volver a contar esa línea.',
  proposal_stale: 'El conteo cambió mientras se proponía: volvé a leer la rendición y proponé de nuevo.',
  round_not_accepted: 'La última ronda de propuesta no está aceptada.',
  branch_frozen: 'La sucursal está congelada por una rendición abierta: no puede operar hasta que se cierre.',
  correction_not_closed: 'Sólo se corrige una rendición cerrada: una abierta se corrige con su propia propuesta.',
  correction_pending: 'La rendición ya tiene una corrección esperando la decisión de la sucursal.',
  correction_decided: 'La corrección ya fue decidida y no se puede decidir otra vez.',
  correction_payload: 'La corrección no es una que este sistema aplique: revisá la variante y los montos.',
  correction_fund_started: 'El período siguiente ya arrancó con el fondo registrado: la corrección del fondo ya no se puede aplicar.',
  correction_journal: 'El asiento de la corrección sólo lo escribe su aceptación.',
  service_unavailable: 'El servicio no está disponible. No pudimos confirmar la operación.',
  invalid_response: 'La respuesta del servidor no es válida. No pudimos confirmar la operación.',
  network: 'No se pudo conectar con el servidor. Revisá la conexión e intentá de nuevo.',
  aborted: 'La operación se interrumpió. Revisá la conexión e intentá de nuevo.',
};

export const closingHistoryUnavailable = 'No se pudieron consultar las rendiciones de la sucursal. Revisá la conexión e intentá de nuevo.';
export const closingDocumentUnavailable = 'No se pudo consultar la rendición. Revisá la conexión e intentá de nuevo.';

/** The fact a refusal names beside its code, exactly as the server stated it. */
export interface ClosingRefusal {
  readonly code: ClosingErrorCode;
  readonly variant_id: number | null;
  readonly excess_cents: bigint | null;
  readonly closing_id: number | null;
  readonly branch_location_id: number | null;
}

/** The refusal in the operator's words, naming what is missing instead of a generic code. */
export function closingRefusalMessage(error: { code: ClosingErrorCode } & Partial<ClosingRefusal>): string {
  const code = error.code;
  if (code === 'count_pending' && typeof error.variant_id === 'number') {
    return `Falta contar la variante ${error.variant_id} del conteo: sin el conteo completo no se puede proponer.`;
  }
  if (code === 'fund_exceeds_drawer' && typeof error.excess_cents === 'bigint') {
    return `El fondo supera la caja contada más el aporte en ${formatMoney(error.excess_cents)}: corregí el fondo.`;
  }
  if (code === 'settlement_live' && typeof error.closing_id === 'number') {
    return `La sucursal ya tiene la rendición #${error.closing_id} abierta: retomala o cerrala antes de abrir otra.`;
  }
  return closingErrorMessages[code];
}

// ---------------------------------------------------------------------------------
// Strict decoding
// ---------------------------------------------------------------------------------

function invalidResponse(): never { throw new Error('Respuesta inválida del servidor.'); }
function invalidPayload(): never { throw new Error('Rendición inválida.'); }

function decode(raw: string): unknown {
  try {
    return parseJSON(raw, null, { onDuplicateKey: () => { throw new Error('duplicate key'); } });
  } catch { return invalidResponse(); }
}

/**
 * The keys of one document: every key of `required` and nothing outside `required` plus `optional`.
 * A key a payload may omit is still the only set the contract publishes, so an unknown key is never
 * tolerated: the optional ones are exactly the amounts the server itself publishes as optional.
 */
function fields(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof LosslessNumber) {
    return invalidResponse();
  }
  const record = value as Record<string, unknown>;
  const published = Object.keys(record);
  if (published.length < keys.length || published.length > keys.length + optional.length
    || keys.some(key => !Object.hasOwn(record, key))
    || published.some(key => !keys.includes(key) && !optional.includes(key))) {
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

function freeText(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.includes('\0') || !value.isWellFormed()
    || Array.from(value).length > max) {
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

function optionalInteger(value: unknown, min: number, max: number): number | null {
  if (value === null) return null;
  return integer(value, min, max);
}

/** A delta carries its sign: a correction moves a quantity in either direction (036). */
function signedInteger(value: unknown, min: number, max: number): number {
  const raw = numeric(value);
  if (!/^-?(0|[1-9]\d*)$/.test(raw) || raw === '-0') return invalidResponse();
  const exact = BigInt(raw);
  if (exact < BigInt(min) || exact > BigInt(max)) return invalidResponse();
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

function optionalTimestamp(value: unknown): string | null {
  return value === null ? null : timestamp(value);
}

/** A published amount: the canonical two-decimal text the database writes. */
function amount(value: unknown): bigint {
  if (typeof value !== 'string') return invalidResponse();
  try { return closingCents(value); } catch { return invalidResponse(); }
}

/** A derived amount carries its sign, which is how a shortage is published (S8). */
function signedAmount(value: unknown): bigint {
  if (typeof value !== 'string') return invalidResponse();
  try { return closingSignedCents(value); } catch { return invalidResponse(); }
}

function optionalAmount(value: unknown): bigint | null {
  return value === null ? null : amount(value);
}

/** A percentage is canonical two-decimal text between 0 and 100. */
function percent(value: unknown): string {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,2})\.\d{2}$/.test(value)) return invalidResponse();
  if (closingCents(value) > 10000n) return invalidResponse();
  return value;
}

function polarity(value: unknown): ClosingPolarity {
  if (value !== 'L' && value !== 'R') return invalidResponse();
  return value;
}

/** Capacity is canonical decimal text and is never read as a float. */
function capacity(value: unknown): string {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,5})(\.\d{1,6})?$/.test(value) || !/[1-9]/.test(value)) {
    return invalidResponse();
  }
  return value;
}

function counted(value: unknown): number {
  return integer(value, 0, closingMaxCounted);
}

// The keys of one count line, one set per kind: the sheet publishes the identity of the row's own
// kind and omits the other kind's attributes altogether, so a product line carries no polarity and no
// capacity at all (S3).
const countLineBatteryKeys = ['variant_id', 'catalog_entry_id', 'brand', 'model', 'capacity_ah',
  'polarity', 'expected_quantity', 'counted_quantity', 'held_in_case_quantity'] as const;
const countLineProductKeys = ['variant_id', 'catalog_entry_id', 'name', 'detail',
  'expected_quantity', 'counted_quantity', 'held_in_case_quantity'] as const;

/**
 * One line of the sheet: the identity of its one kind, the snapshot the database took at the cut and
 * what was counted. A battery states its four battery attributes and a product its name and detail,
 * and neither carries the attributes of the other kind, so no field is coerced to a value the wire
 * did not state (S3).
 */
function countLine(value: unknown, previous: number): ClosingCountLine {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof LosslessNumber) {
    return invalidResponse();
  }
  const stated = value as Record<string, unknown>;
  const battery = Object.hasOwn(stated, 'brand');
  const line = fields(stated, battery ? countLineBatteryKeys : countLineProductKeys);
  const variant_id = integer(line.variant_id, 1, closingMaxID);
  if (variant_id <= previous) return invalidResponse();
  const key = {
    variant_id,
    catalog_entry_id: integer(line.catalog_entry_id, 1, closingMaxID),
    expected_quantity: counted(line.expected_quantity),
    counted_quantity: optionalInteger(line.counted_quantity, 0, closingMaxCounted),
    // The units a warranty case holds out of the branch's stock: read-only, never a term of the count
    // and never sellable, so the operator does not count what is not on the shelf.
    held_in_case_quantity: counted(line.held_in_case_quantity),
  };
  return Object.freeze(battery
    ? { ...key, brand: text(line.brand), model: text(line.model),
      capacity_ah: capacity(line.capacity_ah), polarity: polarity(line.polarity) }
    : { ...key, name: text(line.name), detail: text(line.detail) });
}

function offerLine(value: unknown, previous: number): ClosingOfferLine {
  const line = fields(value, ['variant_id', 'expected_quantity', 'counted_quantity']);
  const variant_id = integer(line.variant_id, 1, closingMaxID);
  if (variant_id <= previous) return invalidResponse();
  return Object.freeze({
    variant_id,
    expected_quantity: counted(line.expected_quantity),
    counted_quantity: counted(line.counted_quantity),
  });
}

/**
 * One line of the material sheet (S7, S8, S9): the key its kind names — the model of a used battery
 * or the id and the name of a scrap material, the other side `null` on every line — the unit every
 * quantity of it is counted in and the four quantities of the line. The quantity of the count, the
 * difference and the delivery are `null` together, and once they are stated they follow their own
 * arithmetic: the difference is the count against what the period bought and the warehouse takes
 * exactly what was counted, so a sheet that disagrees with its own facts is never described.
 */
function materialLine(value: unknown, previous: ClosingMaterialLine | null): ClosingMaterialLine {
  const record = fields(value, ['kind', 'model', 'material_id', 'material', 'unit',
    'expected_quantity', 'counted_quantity', 'difference', 'delivered_quantity']);
  const kind: ClosingMaterialKind = record.kind === 'used' || record.kind === 'scrap'
    ? record.kind : invalidResponse();
  const unit: ClosingMaterialUnit = kind === 'scrap' ? 'kg' : 'unit';
  if (record.unit !== unit) return invalidResponse();
  const model = record.model === null ? null : text(record.model);
  const material_id = optionalInteger(record.material_id, 1, closingMaxMaterialID);
  const material = record.material === null ? null : text(record.material);
  // The key of a line is exactly the one its kind names, and the side it does not name is null.
  if (kind === 'used') {
    if (model === null || material_id !== null || material !== null) return invalidResponse();
  } else if (model !== null || material_id === null || material === null) {
    return invalidResponse();
  }
  // The sheet is read in the order it is published: the used lines by model, the scrap ones by
  // material id and never one kind after the other (S8, S10).
  if (previous !== null) {
    if (previous.kind !== kind) {
      if (previous.kind !== 'used' || kind !== 'scrap') return invalidResponse();
    } else if (kind === 'used') {
      if (model === null || previous.model === null || model <= previous.model) {
        return invalidResponse();
      }
    } else if (material_id === null || previous.material_id === null
      || material_id <= previous.material_id) {
      return invalidResponse();
    }
  }
  const quantity = (raw: unknown): string => {
    if (typeof raw !== 'string' || !closingMaterialQuantityIsCanonical(unit, raw)) {
      return invalidResponse();
    }
    return raw;
  };
  const optionalQuantity = (raw: unknown): string | null => (raw === null ? null : quantity(raw));
  // A difference carries its sign, at the scale of its unit; a published quantity never does.
  const optionalSigned = (raw: unknown): string | null => {
    if (raw === null) return null;
    if (typeof raw !== 'string') return invalidResponse();
    try { closingMaterialMilli(unit, raw); } catch { return invalidResponse(); }
    return raw;
  };
  const expected_quantity = quantity(record.expected_quantity);
  const counted_quantity = optionalQuantity(record.counted_quantity);
  const difference = optionalSigned(record.difference);
  const delivered_quantity = optionalQuantity(record.delivered_quantity);
  // The count, the difference and the delivery are stated together or not at all (S8, S9).
  if ((counted_quantity === null) !== (difference === null)
    || (counted_quantity === null) !== (delivered_quantity === null)) {
    return invalidResponse();
  }
  if (counted_quantity !== null && difference !== null && delivered_quantity !== null) {
    const counted_milli = closingMaterialMilli(unit, counted_quantity);
    if (delivered_quantity !== counted_quantity) return invalidResponse();
    if (closingMaterialMilli(unit, difference)
      !== counted_milli - closingMaterialMilli(unit, expected_quantity)) {
      return invalidResponse();
    }
  }
  return Object.freeze({ kind, model, material_id, material, unit, expected_quantity,
    counted_quantity, difference, delivered_quantity });
}

/**
 * The sheet of one settlement. A payload that does not publish `material_lines` is read as a
 * document without a sheet — an older one — and one that publishes it reads every line in the order
 * the contract writes it; an empty array is a period that bought nothing, never a missing key. The
 * sheet states no line bound of its own — one line per model and per material the period bought —
 * so no length is refused here, exactly like the count sheet of the stock.
 */
function materialLines(record: Record<string, unknown>): readonly ClosingMaterialLine[] | null {
  if (!Object.hasOwn(record, 'material_lines')) return null;
  const value = record.material_lines;
  if (!Array.isArray(value)) return invalidResponse();
  const lines: ClosingMaterialLine[] = [];
  for (const entry of value) {
    lines.push(materialLine(entry, lines.length === 0 ? null : lines[lines.length - 1]));
  }
  return Object.freeze(lines);
}

/** The commission is the frozen rate over the base it was multiplied on, rounded once, half up (S3). */
function commissionOf(base_cents: bigint, rate: string): bigint {
  const hundredths = closingCents(rate);
  return (base_cents * hundredths + 5000n) / 10000n;
}

/**
 * Whether a published commission answers its identity. The base is the battery lines of the window and
 * never the whole sale, because an other product earns nothing (S1, S2); an acta recorded before that
 * rule publishes no base at all, and its amount is then only judged by its shape, never recomputed over
 * a base the document does not state (S6).
 */
function commissionAgrees(commission_cents: bigint, base_cents: bigint | null | undefined,
  rate: string): boolean {
  return base_cents === null || base_cents === undefined
    || commission_cents === commissionOf(base_cents, rate);
}

function offer(value: unknown): ClosingOffer {
  const record = fields(value, ['period_start', 'cut_at', 'sales_total', 'commission_rate_percent',
    'commission_amount', 'cash_sales', 'cash_expenses', 'card_total', 'transfer_total', 'qr_total',
    'counted_cash', 'contributed_cash', 'closing_cash', 'observation', 'count_lines'],
  ['purchase_fund_counted', 'purchase_fund_cash', 'commission_base']);
  const period_start = timestamp(record.period_start);
  const cut_at = timestamp(record.cut_at);
  if (Date.parse(cut_at) < Date.parse(period_start)) return invalidResponse();
  const rate = percent(record.commission_rate_percent);
  const sales_total_cents = amount(record.sales_total);
  // The base is the amount this payload may omit: an offer made before the rule recorded none, which
  // is not the same fact as a zero base and is never read as one (S6).
  const commission_base_cents = optionalAmount(record.commission_base ?? null);
  const commission_amount_cents = amount(record.commission_amount);
  if (!commissionAgrees(commission_amount_cents, commission_base_cents, rate)) {
    return invalidResponse();
  }
  const counted_cash = optionalAmount(record.counted_cash);
  const closing_cash = optionalAmount(record.closing_cash);
  // An offer is only made for a counted drawer, so both sides of it are stated.
  if (counted_cash === null || closing_cash === null) return invalidResponse();
  // The offer freezes the sheet the warehouse counted, so it carries one line per variant with stock
  // and no line count of its own (S1, S2): every line is validated, none of them is counted.
  if (!Array.isArray(record.count_lines)) return invalidResponse();
  let previous = 0;
  const count_lines = record.count_lines.map(entry => {
    const line = offerLine(entry, previous);
    previous = line.variant_id;
    return line;
  });
  return Object.freeze({
    period_start,
    cut_at,
    sales_total_cents,
    commission_rate_percent: rate,
    commission_base_cents,
    commission_amount_cents,
    cash_sales_cents: amount(record.cash_sales),
    cash_expenses_cents: amount(record.cash_expenses),
    card_total_cents: amount(record.card_total),
    transfer_total_cents: amount(record.transfer_total),
    qr_total_cents: amount(record.qr_total),
    counted_cash_cents: counted_cash,
    contributed_cash_cents: amount(record.contributed_cash),
    closing_cash_cents: closing_cash,
    // The envelope of the offer is published only once the warehouse stated it, so an absent key is
    // an envelope nobody counted and never a zero (S1, S5, S6).
    purchase_fund_counted_cents: optionalAmount(record.purchase_fund_counted ?? null),
    purchase_fund_cash_cents: optionalAmount(record.purchase_fund_cash ?? null),
    observation: freeText(record.observation, 1000),
    count_lines: Object.freeze(count_lines),
  });
}

function decision(value: unknown): ClosingDecision {
  if (value === '' || value === 'accepted' || value === 'rejected') return value;
  return invalidResponse();
}

/** A decided round states who answered it and when; a rejected one always states its motive. */
function round(value: unknown, want: number): ClosingRound {
  const record = fields(value, ['id', 'round', 'offer', 'proposed_by_account_id', 'proposed_at',
    'decision', 'decision_reason', 'decided_by_account_id', 'decided_at']);
  const number = integer(record.round, 1, 1_000_000);
  if (number !== want) return invalidResponse();
  const answer = decision(record.decision);
  const reason = freeText(record.decision_reason, 1000);
  const decided_by_account_id = optionalInteger(record.decided_by_account_id, 1, Number.MAX_SAFE_INTEGER);
  const decided_at = optionalTimestamp(record.decided_at);
  if (answer === '') {
    if (decided_by_account_id !== null || decided_at !== null || reason !== '') return invalidResponse();
  } else {
    if (decided_by_account_id === null || decided_at === null) return invalidResponse();
    if (answer === 'accepted' && reason !== '') return invalidResponse();
    if (answer === 'rejected' && reason.trim() === '') return invalidResponse();
  }
  return Object.freeze({
    id: integer(record.id, 1, Number.MAX_SAFE_INTEGER),
    round: number,
    offer: offer(record.offer),
    proposed_by_account_id: integer(record.proposed_by_account_id, 1, Number.MAX_SAFE_INTEGER),
    proposed_at: timestamp(record.proposed_at),
    decision: answer,
    decision_reason: reason,
    decided_by_account_id,
    decided_at,
  });
}

const correctionKinds: readonly ClosingCorrectionKind[] =
  ['stock', 'counted_cash', 'commission', 'fund'];

/** One corrected quantity of a correction payload: the variant and what was counted. */
function correctionQuantity(value: unknown, previous: number): ClosingCorrectionQuantity {
  const line = fields(value, ['variant_id', 'counted_quantity']);
  const variant_id = integer(line.variant_id, 1, closingMaxID);
  if (variant_id <= previous) return invalidResponse();
  return Object.freeze({ variant_id, counted_quantity: counted(line.counted_quantity) });
}

/**
 * The payload of one correction: its four values, each **absent** when the correction does not touch
 * it, and at least one of them stated. A value a correction does not restate is never sent as a
 * zero, and a money value is canonical two-decimal text (S16, S20).
 */
function correctionPayload(value: unknown): ClosingCorrectionPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof LosslessNumber) {
    return invalidResponse();
  }
  const record = value as Record<string, unknown>;
  const known = ['counted_quantities', 'counted_cash', 'commission_amount', 'closing_cash'];
  if (Object.keys(record).some(key => !known.includes(key))) return invalidResponse();
  let quantities: readonly ClosingCorrectionQuantity[] = Object.freeze([]);
  if (Object.hasOwn(record, 'counted_quantities')) {
    // A correction states one entry per corrected variant, and it is the closed settlement's own sheet —
    // never a line count — that bounds it (S1, S2). Every entry is validated below.
    if (!Array.isArray(record.counted_quantities) || record.counted_quantities.length < 1) {
      return invalidResponse();
    }
    let previous = 0;
    quantities = Object.freeze(record.counted_quantities.map(entry => {
      const line = correctionQuantity(entry, previous);
      previous = line.variant_id;
      return line;
    }));
  }
  const optional = (key: string): bigint | null =>
    Object.hasOwn(record, key) ? amount(record[key]) : null;
  const counted_cash = optional('counted_cash');
  const commission_amount = optional('commission_amount');
  const closing_cash = optional('closing_cash');
  // A correction states at least one of its four values: a decision about nothing is not a
  // correction, and the database refuses the same empty payload (LC021).
  if (quantities.length === 0 && counted_cash === null && commission_amount === null
    && closing_cash === null) {
    return invalidResponse();
  }
  return Object.freeze({ counted_quantities: quantities, counted_cash_cents: counted_cash,
    commission_amount_cents: commission_amount, closing_cash_cents: closing_cash });
}

/** One delta an accepted correction applied, in the unit its kind owns and never in the other. */
function correctionEffect(value: unknown): ClosingCorrectionEffect {
  const record = fields(value, ['kind', 'variant_id', 'quantity_delta', 'amount_delta']);
  const kind = record.kind;
  if (typeof kind !== 'string' || !correctionKinds.includes(kind as ClosingCorrectionKind)) {
    return invalidResponse();
  }
  const variant_id = optionalInteger(record.variant_id, 1, closingMaxID);
  const quantity_delta = record.quantity_delta === null ? null
    : signedInteger(record.quantity_delta, -closingMaxCounted, closingMaxCounted);
  const amount_delta_cents = record.amount_delta === null ? null : signedAmount(record.amount_delta);
  if (kind === 'stock') {
    if (variant_id === null || quantity_delta === null || quantity_delta === 0
      || amount_delta_cents !== null) {
      return invalidResponse();
    }
  } else if (variant_id !== null || quantity_delta !== null || amount_delta_cents === null
    || amount_delta_cents === 0n) {
    return invalidResponse();
  }
  return Object.freeze({ kind: kind as ClosingCorrectionKind, variant_id, quantity_delta,
    amount_delta_cents });
}

/**
 * One correction of a closed settlement: what it corrects, why, who proposed it and -- once the
 * branch accepted it -- the deltas it applied. A pending one states no decision and no delta, an
 * accepted one states both, and a rejected one is never part of a document (S16).
 */
function correctionRecord(value: unknown, closing_id: number | null, previous: number,
  answer: boolean): ClosingCorrection {
  const record = fields(value, ['id', 'closing_id', 'status', 'reason', 'payload',
    'proposed_by_account_id', 'proposed_at', 'decided_by_account_id', 'decided_at',
    'decision_reason', 'effects']);
  const id = integer(record.id, 1, Number.MAX_SAFE_INTEGER);
  if (id <= previous) return invalidResponse();
  const settlement = integer(record.closing_id, 1, Number.MAX_SAFE_INTEGER);
  if (closing_id !== null && settlement !== closing_id) return invalidResponse();
  const state = record.status;
  if (state !== 'proposed' && state !== 'accepted' && state !== 'rejected') return invalidResponse();
  // The document publishes the accepted corrections and the one that waits; a rejection applied
  // nothing and is only published as the answer of the decision route (S16).
  if (state === 'rejected' && !answer) return invalidResponse();
  const decided_by_account_id = optionalInteger(record.decided_by_account_id, 1, Number.MAX_SAFE_INTEGER);
  const decided_at = optionalTimestamp(record.decided_at);
  const decision_reason = freeText(record.decision_reason, 1000);
  // One delta per corrected value: a correction of a big settlement states as many effects as it
  // changed values, so the list is read whole and each delta is validated on its own (S1, S2).
  if (!Array.isArray(record.effects)) {
    return invalidResponse();
  }
  const effects = Object.freeze(record.effects.map(entry => correctionEffect(entry)));
  if (state === 'proposed') {
    // A decision that has not been taken has no author, no instant, no motive and no delta.
    if (decided_by_account_id !== null || decided_at !== null || decision_reason !== ''
      || effects.length !== 0) {
      return invalidResponse();
    }
  } else if (decided_by_account_id === null || decided_at === null) {
    return invalidResponse();
  } else if (state === 'accepted' && decision_reason !== '') {
    return invalidResponse();
  } else if (state === 'rejected' && decision_reason.trim() === '') {
    return invalidResponse();
  }
  return Object.freeze({
    id,
    closing_id: settlement,
    status: state as ClosingCorrectionStatus,
    reason: text(record.reason),
    payload: correctionPayload(record.payload),
    proposed_by_account_id: integer(record.proposed_by_account_id, 1, Number.MAX_SAFE_INTEGER),
    proposed_at: timestamp(record.proposed_at),
    decided_by_account_id,
    decided_at,
    decision_reason,
    effects,
  });
}

/** The corrections of one settlement, oldest first, with the pending one always last (034, S16). */
function correctionsOf(value: unknown, closing_id: number,
  state: ClosingStatus): readonly ClosingCorrection[] {
  // The corrections of one settlement are a list of its own and not its sheet (S1, S2): a settlement
  // corrected many times publishes every one of them, and each is validated on its own.
  if (!Array.isArray(value)) return invalidResponse();
  // A live settlement is corrected by its own rounds, and a rejected correction applied nothing, so
  // neither of them is ever part of a document.
  if (state !== 'closed' && value.length > 0) return invalidResponse();
  const corrections: ClosingCorrection[] = [];
  let previous = 0;
  let pending = false;
  for (const entry of value) {
    const correction = correctionRecord(entry, closing_id, previous, false);
    if (correction.status === 'proposed') {
      if (pending) return invalidResponse();
      pending = true;
    } else if (pending) {
      // A decided correction is final, so no accepted one follows a pending one.
      return invalidResponse();
    }
    previous = correction.id;
    corrections.push(correction);
  }
  return Object.freeze(corrections);
}

function status(value: unknown): ClosingStatus {
  if (typeof value !== 'string' || !closingStatuses.includes(value as ClosingStatus)) {
    return invalidResponse();
  }
  return value as ClosingStatus;
}

/** The seven amounts the purchase fund publishes, in the order they are read (S1, S5, S6). */
const purchaseFundKeys: readonly string[] = ['purchase_fund_opening', 'purchases_total',
  'purchases_cash', 'purchase_fund_expected', 'purchase_fund_counted', 'purchase_fund_difference',
  'purchase_fund_cash'];

/**
 * The purchase fund as the document publishes it: the seven amounts of the second envelope, all of
 * them stated or none. The count and the amount the warehouse leaves are nullable and stay so; the
 * inherited balance is a published amount, while the purchases of the window and the expectation are
 * net sums that keep their sign — a counter-document of an earlier purchase can leave them negative
 * and an envelope can spend more than it inherited (S3, S11). The expectation and the difference are
 * revalidated against their own identities, exactly like the drawer's, so the rail can never read an
 * envelope that disagrees with its facts (S1, S3, S5).
 *
 * A payload that publishes none of them is read as a settlement without an envelope instead of being
 * refused: its drawer is complete and correct without it, and the live contract always publishes the
 * seven. A payload that states some of them but not the rest is refused, because a half-published
 * envelope is not a shape this contract has.
 */
function purchaseFund(record: Record<string, unknown>): ClosingPurchaseFund | null {
  const stated = purchaseFundKeys.filter(key => Object.hasOwn(record, key));
  if (stated.length === 0) return null;
  if (stated.length !== purchaseFundKeys.length) return invalidResponse();
  const opening_cents = amount(record.purchase_fund_opening);
  const purchases_cash_cents = signedAmount(record.purchases_cash);
  const expected_cents = signedAmount(record.purchase_fund_expected);
  if (expected_cents !== opening_cents - purchases_cash_cents) return invalidResponse();
  const counted_cents = optionalAmount(record.purchase_fund_counted);
  const difference_cents = record.purchase_fund_difference === null
    ? null : signedAmount(record.purchase_fund_difference);
  // The difference exists exactly when the envelope was counted, and it is that count against the
  // expectation with its sign (S8).
  if ((counted_cents === null) !== (difference_cents === null)) return invalidResponse();
  if (counted_cents !== null && difference_cents !== counted_cents - expected_cents) {
    return invalidResponse();
  }
  return Object.freeze({
    opening_cents,
    purchases_total_cents: signedAmount(record.purchases_total),
    purchases_cash_cents,
    expected_cents,
    counted_cents,
    difference_cents,
    new_cents: optionalAmount(record.purchase_fund_cash),
  });
}

/** The two kinds the acta's expense list holds: the pay-out of the period and the correction that
 * answers one of them (S13). A contribution and a collection are money of the drawer, never an expense
 * of the period, so they are not rows of this list. */
const expenseKinds: readonly string[] = ['gasto', 'correccion'];

/** The bound of the description of an expense, which is the database's own column bound. */
const expenseMaxDescription = 500;

/** The bound of the label of one motive of the closed list an expense is recorded with (061, S2). */
const expenseMaxLabel = 500;

/**
 * How many rows of the acta's own list this document keeps. It is the expenses of the window, not the
 * settlement's count sheet: the sheet has no bound of its own (S1), so this ceiling says nothing about
 * the size of a settlement and only keeps a hostile list out of the acta.
 */
const expenseMaxRows = 190;

/** The digest the acta publishes for one photo: 32 bytes of lowercase hexadecimal. */
const evidenceDigest = /^[0-9a-f]{64}$/;

/**
 * The receipt of one pay-out as the acta publishes it (S1, S7): the three keys of the contract — the
 * content type the server validated by decoding the bytes, the size of those bytes and their SHA-256 —
 * and JSON null on a row that carries no photo. The bytes are served by the image route and never travel
 * inside the document. A receipt on a kind that never carries one is not a row this document wrote (S2).
 */
function evidenceOf(value: unknown, kind: string): ClosingEvidence | null {
  if (value === null) return null;
  const receipt = fields(value, ['type', 'size', 'sha256']);
  if (typeof receipt.type !== 'string'
    || !closingEvidenceTypes.includes(receipt.type as ClosingEvidenceType)) {
    return invalidResponse();
  }
  const size = integer(receipt.size, 1, closingMaxEvidenceBytes);
  if (typeof receipt.sha256 !== 'string' || !evidenceDigest.test(receipt.sha256)) {
    return invalidResponse();
  }
  if (kind !== 'gasto') return invalidResponse();
  return Object.freeze({ type: receipt.type as ClosingEvidenceType, size, sha256: receipt.sha256 });
}

/**
 * A motive of the closed list is the canonical text the catalogue stores (S2, S8): it says something and
 * it is published exactly as it is offered.
 */
function motive(value: unknown): string {
  const label = text(value);
  if (label.trim() !== label || Array.from(label).length > expenseMaxLabel) {
    return invalidResponse();
  }
  return label;
}

/**
 * The branch's own expenses of the settled window, published beside the total they produced so the
 * warehouse reads what it is subtracting and the branch what it is being charged for (S13). Each row is
 * the ledger's own shape and every key is validated: the amount is canonical money and strictly
 * positive — the direction of a row is the ledger view's signed reading and never a sign this document
 * invents —, the kind is one of the two this list holds, the text is the canonical text the database
 * stores — the optional note of an expense, which may be empty, and the mandatory description of the
 * correction that answers it —, the instant is the one the database stamped, and the reference is the
 * movement a correction answers and nothing else, exactly like the shape rule the database itself
 * enforces (S6). The motive is the pair the book publishes — the reference and the copy of the label it
 * had — stated by an expense only and never one without the other (S8), and the receipt of the pay-out is
 * the metadata the book publishes beside it, null on a correction and on a pay-out with no photo (S1, S7).
 * The rows are the order the branch recorded them in, so a list that does not advance in id is refused.
 */
function expensesOf(value: unknown): readonly ClosingExpense[] {
  if (!Array.isArray(value) || value.length > expenseMaxRows) return invalidResponse();
  const expenses: ClosingExpense[] = [];
  let previous = 0;
  for (const entry of value) {
    const row = fields(entry, ['id', 'branch_location_id', 'kind', 'amount', 'description',
      'occurred_at', 'created_by_account_id', 'corrects_id', 'category_id', 'category_label',
      'evidence']);
    const id = integer(row.id, 1, Number.MAX_SAFE_INTEGER);
    if (id <= previous) return invalidResponse();
    previous = id;
    integer(row.branch_location_id, closingFirstBranch, closingMaxBranch);
    integer(row.created_by_account_id, 1, Number.MAX_SAFE_INTEGER);
    const kind = row.kind;
    if (typeof kind !== 'string' || !expenseKinds.includes(kind)) return invalidResponse();
    const amount_cents = amount(row.amount);
    if (amount_cents < 1n) return invalidResponse();
    const note = freeText(row.description, expenseMaxDescription);
    if (note.trim() !== note) return invalidResponse();
    // Only the note of an expense may be empty: a correction still says what it is for (S3).
    if (kind !== 'gasto' && note === '') return invalidResponse();
    timestamp(row.occurred_at);
    // A correction names exactly one movement and no other kind names one (S6): a row that breaks it is
    // a cancelation this domain does not read.
    const corrects_id = optionalInteger(row.corrects_id, 1, Number.MAX_SAFE_INTEGER);
    if ((kind === 'correccion') !== (corrects_id !== null)) return invalidResponse();
    // The motive is the pair the book publishes (S8): together or not at all, and stated by an expense
    // only — a correction carries none of its own (S10).
    const category_id = row.category_id === null
      ? null : integer(row.category_id, 1, Number.MAX_SAFE_INTEGER);
    const category_label = row.category_label === null ? null : motive(row.category_label);
    if ((category_id === null) !== (category_label === null)) return invalidResponse();
    if (category_id !== null && kind !== 'gasto') return invalidResponse();
    expenses.push(Object.freeze({
      id, kind: kind as ClosingExpense['kind'], amount_cents, motive: category_label, note,
      corrects_id, evidence: evidenceOf(row.evidence, kind),
    }));
  }
  return Object.freeze(expenses);
}

/**
 * Reads one settlement. The derived numbers are recomputed here from the facts that produce
 * them and must agree with what the server published, so the rail can never show a drawer that
 * disagrees with its own money. The commission is one of those identities: it is the frozen rate over
 * the base the document published, and an acta recorded before that rule states no base and is read
 * as it was written (S3, S6).
 */
function readClosing(value: unknown): Closing {
  const record = fields(value, ['id', 'branch_location_id', 'branch_name', 'status',
    'period_start', 'cut_at', 'closed_at', 'commission_rate_percent', 'opening_cash', 'cash_sales',
    'cash_expenses', 'cash_effective', 'expected_cash', 'counted_cash', 'cash_difference',
    'contributed_cash',
    'closing_cash', 'taken_cash', 'sales_total', 'commission_amount', 'card_total',
    'transfer_total', 'qr_total', 'observation', 'opened_by_account_id', 'count_lines', 'rounds',
    'expenses', 'corrections'], [...purchaseFundKeys, 'material_lines', 'commission_base']);
  // The branch's own expenses of the window, with the motive of each one: the document is only accepted
  // when the field is the list the contract publishes, so a shape change cannot reach the acta unnoticed
  // (S8, S13).
  const expenses = expensesOf(record.expenses);
  const id = integer(record.id, 1, Number.MAX_SAFE_INTEGER);
  const state = status(record.status);
  // The corrections of the closed settlement, the pending one included: a settlement whose
  // corrections are not the shape this contract publishes is never described.
  const corrections = correctionsOf(record.corrections, id, state);
  const period_start = timestamp(record.period_start);
  const cut_at = timestamp(record.cut_at);
  if (Date.parse(cut_at) < Date.parse(period_start)) return invalidResponse();
  const closed_at = optionalTimestamp(record.closed_at);
  if ((state === 'closed') !== (closed_at !== null)) return invalidResponse();
  const rate = record.commission_rate_percent === null ? null : percent(record.commission_rate_percent);
  if ((state === 'open') !== (rate === null)) return invalidResponse();
  // The base the commission was multiplied on. An acta recorded before the rule publishes none, which
  // is a fact of its own: the amount is then judged by its shape alone (S6).
  const commission_base_cents = optionalAmount(record.commission_base ?? null);
  const counted_cash_cents = optionalAmount(record.counted_cash);
  const closing_cash_cents = optionalAmount(record.closing_cash);
  // The sheet is one line per variant the branch had in stock, so the catalogue bounds it and nothing
  // here restates a size (S1, S2): the lines are read whole, in ascending variant order, and every one
  // of them is validated by `countLine`.
  if (!Array.isArray(record.count_lines)) {
    return invalidResponse();
  }
  let previousVariant = 0;
  const count_lines = record.count_lines.map(entry => {
    const line = countLine(entry, previousVariant);
    previousVariant = line.variant_id;
    return line;
  });
  if (!Array.isArray(record.rounds) || record.rounds.length > 1_000_000) return invalidResponse();
  const rounds = record.rounds.map((entry, index) => round(entry, index + 1));
  const closing: Closing = Object.freeze({
    id,
    branch_location_id: integer(record.branch_location_id, closingFirstBranch, closingMaxBranch),
    branch_name: text(record.branch_name),
    status: state,
    period_start,
    cut_at,
    closed_at,
    commission_rate_percent: rate,
    opening_cash_cents: amount(record.opening_cash),
    cash_sales_cents: amount(record.cash_sales),
    cash_expenses_cents: amount(record.cash_expenses),
    // The signed effect of the movements the branch wrote in the window: the term the drawer's expectation
    // is built from, published by the server so this screen never re-derives it (S4, S13).
    cash_effective_cents: signedAmount(record.cash_effective),
    counted_cash_cents,
    contributed_cash_cents: amount(record.contributed_cash),
    closing_cash_cents,
    sales_total_cents: amount(record.sales_total),
    commission_base_cents,
    commission_amount_cents: amount(record.commission_amount),
    card_total_cents: amount(record.card_total),
    transfer_total_cents: amount(record.transfer_total),
    qr_total_cents: amount(record.qr_total),
    observation: freeText(record.observation, 1000),
    opened_by_account_id: integer(record.opened_by_account_id, 1, Number.MAX_SAFE_INTEGER),
    count_lines: Object.freeze(count_lines),
    // The third account of the document (S7, S8, S9): a payload that does not publish it is read
    // as a document without a sheet, and one that does is revalidated against its own arithmetic.
    material_lines: materialLines(record),
    rounds: Object.freeze(rounds),
    expenses,
    purchase_fund: purchaseFund(record),
    corrections,
  });
  const rail: ClosingRail = closingRail(closing);
  if (amount(record.expected_cash) !== rail.expected_cents) return invalidResponse();
  const difference = record.cash_difference === null ? null : signedAmount(record.cash_difference);
  if (difference !== rail.difference_cents) return invalidResponse();
  const taken = record.taken_cash === null ? null : signedAmount(record.taken_cash);
  if (taken !== rail.taken_cents) return invalidResponse();
  if (rate !== null && !commissionAgrees(rail.commission_cents, commission_base_cents, rate)) {
    return invalidResponse();
  }
  return closing;
}

/** Parses one settlement document, from the wire or from a row of a page. */
export function parseClosing(raw: string): Closing {
  return readClosing(decode(raw));
}

/**
 * Parses one correction on its own, which is what the two correction routes answer: the pending one
 * when the warehouse proposes it and the decided one when the branch answers it. The settlement it
 * belongs to is the one the correction states, and the correction is validated exactly like the one
 * inside the document, so a correction read here and the same correction read there cannot disagree.
 */
export function parseClosingCorrection(raw: string): ClosingCorrection {
  return correctionRecord(decode(raw), null, 0, true);
}

/**
 * Parses one newest-first page of a branch's settlements. Every row is the same document, so a
 * history row and the settlement it summarises can never disagree.
 */
export function parseClosingPage(raw: string): ClosingPage {
  const record = fields(decode(raw), ['page', 'page_size', 'total_closings', 'closings']);
  const page = integer(record.page, 1, closingMaxPage);
  const page_size = integer(record.page_size, 10, 50);
  if (!closingPageSizes.includes(page_size)) return invalidResponse();
  const total_closings = integer(record.total_closings, 0, Number.MAX_SAFE_INTEGER);
  if (!Array.isArray(record.closings) || record.closings.length > page_size) return invalidResponse();
  if (record.closings.length > 0
    && (page - 1) * page_size + record.closings.length > total_closings) {
    return invalidResponse();
  }
  let previousCut = Number.POSITIVE_INFINITY;
  let previousID = Number.POSITIVE_INFINITY;
  const closings = record.closings.map(entry => {
    const closing = readClosing(entry);
    // Newest first by cut instant, the newer settlement first when two share one instant.
    const cut = Date.parse(closing.cut_at);
    if (cut > previousCut || (cut === previousCut && closing.id > previousID)) return invalidResponse();
    previousCut = cut;
    previousID = closing.id;
    return closing;
  });
  return Object.freeze({ page, page_size, total_closings, closings: Object.freeze(closings) });
}

const namedFacts: readonly ClosingErrorCode[] = ['count_pending', 'fund_exceeds_drawer', 'settlement_live'];

/** Parses one admitted refusal, with the fact it names beside the code. */
export function parseClosingRefusal(raw: string, status: number): ClosingRefusal {
  const admitted = closingAdmittedErrors.get(status);
  if (!admitted) return invalidResponse();
  const envelope = decode(raw);
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || envelope instanceof LosslessNumber) {
    return invalidResponse();
  }
  const record = envelope as Record<string, unknown>;
  const code = record.error;
  if (typeof code !== 'string' || !admitted.includes(code as ClosingErrorCode)) return invalidResponse();
  const allowed: Record<string, readonly string[]> = {
    count_pending: ['error', 'variant_id'],
    fund_exceeds_drawer: ['error', 'excess'],
    settlement_live: ['error', 'branch_location_id'],
    branch_retired: ['error', 'branch_location_id'],
    // A correction of a live settlement names the document the operator has to look at.
    correction_not_closed: ['error', 'closing_id'],
  };
  // The opening conflict names the document that holds the branch as well as the branch itself.
  const keys = Object.keys(record);
  const expected = code === 'settlement_live' && keys.length === 3
    ? ['error', 'branch_location_id', 'closing_id'] : allowed[code] ?? ['error'];
  if (keys.length !== expected.length || expected.some(key => !Object.hasOwn(record, key))) {
    return invalidResponse();
  }
  const closing_id = expected.includes('closing_id')
    ? integer(record.closing_id, 1, Number.MAX_SAFE_INTEGER) : null;
  const branch_location_id = code === 'settlement_live' || code === 'branch_retired'
    ? integer(record.branch_location_id, closingFirstBranch, closingMaxBranch) : null;
  const variant_id = code === 'count_pending'
    ? integer(record.variant_id, 1, closingMaxID) : null;
  let excess_cents: bigint | null = null;
  if (code === 'fund_exceeds_drawer') {
    if (typeof record.excess !== 'string') return invalidResponse();
    try { excess_cents = closingCents(record.excess); } catch { return invalidResponse(); }
  }
  return Object.freeze({ code: code as ClosingErrorCode, variant_id, excess_cents, closing_id, branch_location_id });
}

/** A definite rejection wrote nothing; every other failure leaves the outcome unknown. */
export function closingFailureIsDefinite(code: ClosingErrorCode): boolean {
  return code !== 'service_unavailable' && code !== 'invalid_response'
    && code !== 'network' && code !== 'aborted';
}

/** One line of the material request, in the exact shape each kind takes (S8). */
type MaterialBodyLine = { readonly kind: 'used'; readonly model: string;
  readonly counted_quantity: string }
  | { readonly kind: 'scrap'; readonly material_id: number; readonly counted_quantity: string };

/**
 * One line of `POST /api/closings/{id}/materials`: the kind, the one key that kind names and the
 * canonical count of its unit, and nothing else. The expected quantity is the fact of the opening
 * and the difference and the delivery are derived from it, so none of them can even be expressed
 * here — a blinded count of this sheet is refused on the screen, exactly like the stock one (S8).
 */
function materialBody(line: MaterialCountedInput): MaterialBodyLine {
  const unit: ClosingMaterialUnit = line.kind === 'scrap' ? 'kg' : 'unit';
  if (typeof line.counted_quantity !== 'string'
    || !closingMaterialQuantityIsCanonical(unit, line.counted_quantity)) {
    return invalidPayload();
  }
  if (line.kind === 'used') {
    if (typeof line.model !== 'string' || line.model === '' || line.material_id !== null) {
      return invalidPayload();
    }
    return { kind: 'used', model: line.model, counted_quantity: line.counted_quantity };
  }
  if (line.kind !== 'scrap' || line.model !== null || !Number.isInteger(line.material_id)
    || line.material_id === null || line.material_id < 1 || line.material_id > closingMaxMaterialID) {
    return invalidPayload();
  }
  return { kind: 'scrap', material_id: line.material_id, counted_quantity: line.counted_quantity };
}

// ---------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------

function branchID(branch: number): number {
  if (!Number.isInteger(branch) || branch < closingFirstBranch || branch > closingMaxBranch) {
    return invalidPayload();
  }
  return branch;
}

function closingID(id: number): number {
  if (!Number.isInteger(id) || id < 1 || id > closingMaxID) return invalidPayload();
  return id;
}

export function validClosingHistoryQuery(page: number, pageSize: number): boolean {
  return Number.isInteger(page) && page >= 1 && page <= closingMaxPage
    && Number.isInteger(pageSize) && closingPageSizes.includes(pageSize);
}

/** The history is one branch's own: the branch is mandatory and the query is token-exact. */
export function closingHistoryPath(branch: number, page: number, pageSize: number): string {
  const scope = branchID(branch);
  if (!validClosingHistoryQuery(page, pageSize)) return invalidPayload();
  return `/api/closings?branch_location_id=${scope}&page=${page}&page_size=${pageSize}`;
}

export function closingDetailPath(id: number): string {
  return `/api/closings/${closingID(id)}`;
}

export function closingCountPath(id: number): string {
  return `/api/closings/${closingID(id)}/count`;
}

/** The material sheet of one settlement: the counts of the third account (S8). */
export function closingMaterialsPath(id: number): string {
  return `/api/closings/${closingID(id)}/materials`;
}

export function closingCashPath(id: number): string {
  return `/api/closings/${closingID(id)}/cash`;
}

export function closingProposePath(id: number): string {
  return `/api/closings/${closingID(id)}/propose`;
}

export function closingDecisionPath(id: number): string {
  return `/api/closings/${closingID(id)}/decision`;
}

/** The configured commission of one branch: the rate its settlement pays on the period sales. */
export function closingCommissionPath(branch: number): string {
  return `/api/closings/branches/${closingID(branch)}/commission`;
}

/** The configured rate of one branch as the server stores it. Only the canonical percentage is
 *  an answer this server could have produced. */
export function parseConfiguredRate(raw: string): string {
  const record = fields(decode(raw), ['branch_location_id', 'commission_rate_percent']);
  integer(record.branch_location_id, 2, 32767);
  const rate = record.commission_rate_percent;
  if (typeof rate !== 'string' || !/^(?:0|[1-9][0-9]{0,2})\.[0-9]{2}$/.test(rate)
    || Number(rate.replace('.', '')) > 10000) return invalidResponse();
  return rate;
}

/** The corrections of one closed settlement: the warehouse appends one to it. */
export function closingCorrectionPath(id: number): string {
  return `/api/closings/${closingID(id)}/corrections`;
}

/** The branch's answer to one correction, named by the correction's own id. */
export function closingCorrectionDecisionPath(correction: number): string {
  return `/api/closings/corrections/${closingID(correction)}/decision`;
}

// ---------------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------------

export class ClosingAPIError extends Error {
  constructor(public readonly code: ClosingErrorCode, public readonly status: number | null,
    public readonly refusal: ClosingRefusal | null = null) {
    super(code); this.name = 'ClosingAPIError';
  }
}

const jsonHeader = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;
const csrfToken = /^[A-Za-z0-9_-]+$/;

function transportFailure(error: unknown, signal?: AbortSignal): ClosingAPIError {
  const aborted = signal?.aborted === true
    || (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError');
  return new ClosingAPIError(aborted ? 'aborted' : 'network', null);
}

async function readText(reply: Response, signal?: AbortSignal): Promise<string> {
  try { return await reply.text(); } catch (error) { throw transportFailure(error, signal); }
}

export function createClosingAPI(fetch: typeof globalThis.fetch = globalThis.fetch) {
  async function send<T>(method: 'GET' | 'POST', path: string, status: number,
    parse: (raw: string) => T, body: string | null, csrf: string,
    signal?: AbortSignal): Promise<T> {
    const headers = new Headers();
    if (body !== null) headers.set('Content-Type', 'application/json');
    if (method === 'POST') headers.set('X-CSRF-Token', csrf);
    let reply: Response;
    let raw: string;
    try {
      reply = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store', signal,
        headers, ...(body === null ? {} : { body }) });
      raw = await readText(reply, signal);
    } catch (error) {
      if (error instanceof ClosingAPIError) throw error;
      throw transportFailure(error, signal);
    }
    const malformed = () => new ClosingAPIError('invalid_response', reply.status);
    if (!jsonHeader.test(reply.headers.get('Content-Type') ?? '')) throw malformed();
    if (reply.status !== status) {
      let refusal: ClosingRefusal;
      try { refusal = parseClosingRefusal(raw, reply.status); } catch { throw malformed(); }
      throw new ClosingAPIError(refusal.code, reply.status, refusal);
    }
    try { return parse(raw); } catch { throw malformed(); }
  }

  function token(csrf: string): string {
    if (typeof csrf !== 'string' || !csrfToken.test(csrf)) throw new ClosingAPIError('invalid_request', null);
    return csrf;
  }

  return {
    /** One branch's own history: newest first, with the live settlement when there is one. */
    async history(branch: number, page: number, pageSize: number, signal?: AbortSignal): Promise<ClosingPage> {
      let path: string;
      try { path = closingHistoryPath(branch, page, pageSize); } catch { throw new ClosingAPIError('invalid_request', null); }
      const parsed = await send('GET', path, 200, parseClosingPage, null, '', signal);
      if (parsed.page !== page || parsed.page_size !== pageSize) throw new ClosingAPIError('invalid_response', 200);
      return parsed;
    },

    async detail(id: number, signal?: AbortSignal): Promise<Closing> {
      let path: string;
      try { path = closingDetailPath(id); } catch { throw new ClosingAPIError('invalid_request', null); }
      const closing = await send('GET', path, 200, parseClosing, null, '', signal);
      if (closing.id !== id) throw new ClosingAPIError('invalid_response', 200);
      return closing;
    },

    /** The commission configured for one branch, or `null` when the warehouse never fixed one:
     *  that absence is not a failure of the screen but the reason it cannot propose. */
    async commission(branch: number, signal?: AbortSignal): Promise<string | null> {
      let path: string;
      try { path = closingCommissionPath(branch); } catch { throw new ClosingAPIError('invalid_request', null); }
      try {
        return await send('GET', path, 200, parseConfiguredRate, null, '', signal);
      } catch (error) {
        if (error instanceof ClosingAPIError && error.status === 404) return null;
        throw error;
      }
    },

    /** Opens the settlement of a branch; the cut instant and the inherited fund are the server's. */
    async open(branch: number, csrf: string, signal?: AbortSignal): Promise<Closing> {
      let body: string;
      let sent: number;
      try {
        token(csrf);
        sent = branchID(branch);
        body = JSON.stringify({ branch_location_id: sent });
      } catch { throw new ClosingAPIError('invalid_request', null); }
      const closing = await send('POST', '/api/closings', 201, parseClosing, body, csrf, signal);
      if (closing.branch_location_id !== sent) throw new ClosingAPIError('invalid_response', 201);
      return closing;
    },

    /**
     * The branch's own catalogue, for a variant the count sheet does not have at all: the balance
     * matrix of the branch carries every variant of the operative catalogue with the stock it holds,
     * zero included, so a battery or a product that exists physically and the system does not have
     * can be found (S4, S5, L38). The read is the session's own inventory read, scoped to the
     * settlement's branch, and it is decoded strictly: a page that answers another branch or another
     * size is not evidence.
     *
     * The sheet counts the whole catalogue, so this read asks for both kinds (`kind=all`) and keeps
     * the identity of each row: the battery attributes of a battery and the name and detail of a
     * product (S3, S4).
     */
    async catalogue(branch: number, search: string, signal?: AbortSignal):
      Promise<readonly ClosingCatalogueVariant[]> {
      let path: string;
      let wanted: number;
      try {
        if (!validSearch(search)) throw new Error('búsqueda inválida');
        wanted = branchID(branch);
        path = queryURL({ location: wanted, search: search.trim(), brand: '', polarity: '',
          kind: 'all', page: 1, size: closingCataloguePageSize });
      } catch { throw new ClosingAPIError('invalid_request', null); }
      const page = await send('GET', path, 200, parseInventory, null, '', signal);
      if (page.page !== 1 || page.page_size !== closingCataloguePageSize
        || page.location.id !== wanted) {
        throw new ClosingAPIError('invalid_response', 200);
      }
      // The inventory read already admits the shape of each kind, so this projection only keeps the
      // identity of the row: the battery attributes of a battery and the name and detail of a product.
      return Object.freeze(page.items.map(item => {
        const key = { variant_id: item.variant_id, catalog_entry_id: item.catalog_entry_id,
          existing: item.existing };
        const battery = item.battery;
        return Object.freeze(battery === null
          ? { ...key, name: item.name, detail: item.detail }
          : { ...key, brand: battery.brand, model: battery.model,
            capacity_ah: battery.capacity_ah, polarity: battery.polarity });
      }));
    },

    /**
     * Records only what was counted: the expected quantity cannot even be expressed here. One request
     * carries one batch of the sheet and never the sheet itself, whose size the catalogue sets: a wider
     * settlement is saved in order, request by request (S1, S2).
     */
    async count(id: number, lines: readonly CountPayloadLine[], csrf: string,
      signal?: AbortSignal): Promise<Closing> {
      let body: string;
      let path: string;
      let wanted: number;
      try {
        token(csrf);
        path = closingCountPath(id);
        wanted = closingID(id);
        if (!Array.isArray(lines) || lines.length === 0 || lines.length > closingCountRequestLines) {
          throw new Error('conteo inválido');
        }
        body = JSON.stringify({ lines: lines.map(line => ({
          variant_id: line.variant_id, counted_quantity: line.counted_quantity,
        })) });
      } catch { throw new ClosingAPIError('invalid_request', null); }
      const closing = await send('POST', path, 200, parseClosing, body, csrf, signal);
      if (closing.id !== wanted) throw new ClosingAPIError('invalid_response', 200);
      return closing;
    },

    /**
     * Writes the counted quantities of the material sheet: only what was counted, one line per key,
     * in the shape the contract takes — the one key its kind names and the canonical quantity of its
     * unit. The request is whole-set and idempotent: a line it does not state keeps the count it has
     * (S8).
     */
    async materials(id: number, lines: readonly MaterialCountedInput[], csrf: string,
      signal?: AbortSignal): Promise<Closing> {
      let body: string;
      let path: string;
      let wanted: number;
      try {
        token(csrf);
        path = closingMaterialsPath(id);
        wanted = closingID(id);
        if (!Array.isArray(lines) || lines.length === 0) {
          throw new Error('materiales inválidos');
        }
        body = JSON.stringify({ lines: lines.map(line => materialBody(line)) });
      } catch { throw new ClosingAPIError('invalid_request', null); }
      const closing = await send('POST', path, 200, parseClosing, body, csrf, signal);
      if (closing.id !== wanted) throw new ClosingAPIError('invalid_response', 200);
      return closing;
    },

    /** Saves the drawer draft explicitly, so a reload does not lose the admin's work. */
    async cash(id: number, draft: DrawerPayload, csrf: string,
      signal?: AbortSignal): Promise<Closing> {
      let body: string;
      let path: string;
      let wanted: number;
      try {
        token(csrf);
        path = closingCashPath(id);
        wanted = closingID(id);
        const keys = Object.keys(draft);
        // Four keys of the drawer, plus the two of the purchase envelope when it was stated (S1, S5).
        const envelope = keys.length === 6 && Object.hasOwn(draft, 'purchase_fund_counted')
          && Object.hasOwn(draft, 'purchase_fund_cash');
        if (keys.length !== 4 && !envelope) throw new Error('borrador inválido');
        body = JSON.stringify({
          counted_cash: draft.counted_cash, contributed_cash: draft.contributed_cash,
          closing_cash: draft.closing_cash, observation: draft.observation,
          ...(envelope ? { purchase_fund_counted: draft.purchase_fund_counted,
            purchase_fund_cash: draft.purchase_fund_cash } : {}),
        });
      } catch { throw new ClosingAPIError('invalid_request', null); }
      const closing = await send('POST', path, 200, parseClosing, body, csrf, signal);
      if (closing.id !== wanted) throw new ClosingAPIError('invalid_response', 200);
      return closing;
    },

    /** Offers the settlement to the branch. The route takes no body at all. */
    async propose(id: number, csrf: string, signal?: AbortSignal): Promise<Closing> {
      let path: string;
      let wanted: number;
      try {
        token(csrf);
        path = closingProposePath(id);
        wanted = closingID(id);
      } catch { throw new ClosingAPIError('invalid_request', null); }
      const closing = await send('POST', path, 200, parseClosing, null, csrf, signal);
      if (closing.id !== wanted) throw new ClosingAPIError('invalid_response', 200);
      return closing;
    },

    /**
     * The branch's answer: acceptance carries only the decision, a rejection carries its motive
     * and nothing else. Both are canonicalized by the model before anything leaves the screen.
     */
    async decision(id: number, payload: ClosingDecisionPayload, csrf: string,
      signal?: AbortSignal): Promise<Closing> {
      let body: string;
      let path: string;
      let wanted: number;
      try {
        token(csrf);
        path = closingDecisionPath(id);
        wanted = closingID(id);
        const keys = Object.keys(payload);
        const canonical = closingDecisionPayload(payload.decision, payload.reason ?? '');
        if (canonical.decision === 'accepted') {
          if (keys.length !== 1) throw new Error('decisión inválida');
          body = JSON.stringify({ decision: 'accepted' });
        } else {
          if (keys.length !== 2 || canonical.reason === undefined) throw new Error('decisión inválida');
          body = JSON.stringify({ decision: 'rejected', reason: canonical.reason });
        }
      } catch { throw new ClosingAPIError('invalid_request', null); }
      const closing = await send('POST', path, 200, parseClosing, body, csrf, signal);
      if (closing.id !== wanted) throw new ClosingAPIError('invalid_response', 200);
      return closing;
    },

    /**
     * The warehouse proposes one correction of a closed settlement: a mandatory reason and at least
     * one of the four values, each in the shape that value is. The body is canonicalized by the
     * model before it leaves the screen, and here again, so a correction that states nothing never
     * reaches the server (S16).
     */
    async correction(id: number, body: CorrectionBody, csrf: string,
      signal?: AbortSignal): Promise<ClosingCorrection> {
      let path: string;
      let wanted: number;
      let sent: string;
      try {
        token(csrf);
        path = closingCorrectionPath(id);
        wanted = closingID(id);
        sent = JSON.stringify(canonicalCorrectionBody(body));
      } catch { throw new ClosingAPIError('invalid_request', null); }
      const correction = await send('POST', path, 201, parseClosingCorrection, sent, csrf, signal);
      if (correction.closing_id !== wanted) throw new ClosingAPIError('invalid_response', 201);
      return correction;
    },

    /** The branch's answer to the correction it was shown: the same gate as a round's decision. */
    async correctionDecision(correction: number, payload: ClosingDecisionPayload, csrf: string,
      signal?: AbortSignal): Promise<ClosingCorrection> {
      let body: string;
      let path: string;
      let wanted: number;
      try {
        token(csrf);
        path = closingCorrectionDecisionPath(correction);
        wanted = closingID(correction);
        const keys = Object.keys(payload);
        const canonical = closingDecisionPayload(payload.decision, payload.reason ?? '');
        if (canonical.decision === 'accepted') {
          if (keys.length !== 1) throw new Error('decisión inválida');
          body = JSON.stringify({ decision: 'accepted' });
        } else {
          if (keys.length !== 2 || canonical.reason === undefined) throw new Error('decisión inválida');
          body = JSON.stringify({ decision: 'rejected', reason: canonical.reason });
        }
      } catch { throw new ClosingAPIError('invalid_request', null); }
      const decided = await send('POST', path, 200, parseClosingCorrection, body, csrf, signal);
      if (decided.id !== wanted) throw new ClosingAPIError('invalid_response', 200);
      if (decided.status === 'proposed') throw new ClosingAPIError('invalid_response', 200);
      return decided;
    },
  };
}
