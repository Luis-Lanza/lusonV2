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
import {
  closingCents, closingDecisionPayload, closingMaxCountLines, closingMaxCounted, closingMaxID,
  closingMaxPage, closingPageSizes, closingRail, closingSignedCents, closingStatuses,
  closingFirstBranch, closingMaxBranch,
  type Closing, type ClosingCountLine, type ClosingDecision, type ClosingDecisionPayload,
  type ClosingOffer, type ClosingOfferLine,
  type ClosingPage, type ClosingPolarity, type ClosingRail, type ClosingRound, type ClosingStatus,
  type CountPayloadLine,
} from './closingModel';
import { formatMoney } from './pointOfSaleModel';

export type ClosingErrorCode =
  | 'invalid_request' | 'unauthenticated' | 'forbidden' | 'not_found' | 'method_not_allowed'
  | 'settlement_live' | 'branch_retired' | 'count_pending' | 'cash_not_stated'
  | 'fund_exceeds_drawer' | 'commission_rate_missing' | 'count_frozen' | 'state_conflict'
  | 'closure_refused' | 'reserved_stock' | 'round_not_accepted' | 'service_unavailable'
  | 'invalid_response' | 'network' | 'aborted';

/** The admitted refusal per HTTP status; nothing else may reach the UI. */
export const closingAdmittedErrors: ReadonlyMap<number, readonly ClosingErrorCode[]> = new Map([
  [400, ['invalid_request']],
  [401, ['unauthenticated']],
  [403, ['forbidden']],
  [404, ['not_found']],
  [405, ['method_not_allowed']],
  [409, ['settlement_live', 'branch_retired', 'count_pending', 'cash_not_stated',
    'fund_exceeds_drawer', 'commission_rate_missing', 'count_frozen', 'state_conflict',
    'closure_refused', 'reserved_stock', 'round_not_accepted']],
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
  round_not_accepted: 'La última ronda de propuesta no está aceptada.',
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

function countLine(value: unknown, previous: number): ClosingCountLine {
  const line = fields(value, ['variant_id', 'catalog_entry_id', 'brand', 'model', 'capacity_ah',
    'polarity', 'expected_quantity', 'counted_quantity']);
  const variant_id = integer(line.variant_id, 1, closingMaxID);
  if (variant_id <= previous) return invalidResponse();
  return Object.freeze({
    variant_id,
    catalog_entry_id: integer(line.catalog_entry_id, 1, closingMaxID),
    brand: text(line.brand),
    model: text(line.model),
    capacity_ah: capacity(line.capacity_ah),
    polarity: polarity(line.polarity),
    expected_quantity: counted(line.expected_quantity),
    counted_quantity: optionalInteger(line.counted_quantity, 0, closingMaxCounted),
  });
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

/** The commission is the frozen rate over the offer's own total, rounded once, half up (S6, S20). */
function commissionOf(sales_total_cents: bigint, rate: string): bigint {
  const hundredths = closingCents(rate);
  return (sales_total_cents * hundredths + 5000n) / 10000n;
}

function offer(value: unknown): ClosingOffer {
  const record = fields(value, ['period_start', 'cut_at', 'sales_total', 'commission_rate_percent',
    'commission_amount', 'cash_sales', 'cash_expenses', 'card_total', 'transfer_total', 'qr_total',
    'counted_cash', 'contributed_cash', 'closing_cash', 'observation', 'count_lines']);
  const period_start = timestamp(record.period_start);
  const cut_at = timestamp(record.cut_at);
  if (Date.parse(cut_at) < Date.parse(period_start)) return invalidResponse();
  const rate = percent(record.commission_rate_percent);
  const sales_total_cents = amount(record.sales_total);
  const commission_amount_cents = amount(record.commission_amount);
  if (commission_amount_cents !== commissionOf(sales_total_cents, rate)) return invalidResponse();
  const counted_cash = optionalAmount(record.counted_cash);
  const closing_cash = optionalAmount(record.closing_cash);
  // An offer is only made for a counted drawer, so both sides of it are stated.
  if (counted_cash === null || closing_cash === null) return invalidResponse();
  if (!Array.isArray(record.count_lines) || record.count_lines.length > closingMaxCountLines) {
    return invalidResponse();
  }
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
    commission_amount_cents,
    cash_sales_cents: amount(record.cash_sales),
    cash_expenses_cents: amount(record.cash_expenses),
    card_total_cents: amount(record.card_total),
    transfer_total_cents: amount(record.transfer_total),
    qr_total_cents: amount(record.qr_total),
    counted_cash_cents: counted_cash,
    contributed_cash_cents: amount(record.contributed_cash),
    closing_cash_cents: closing_cash,
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

function status(value: unknown): ClosingStatus {
  if (typeof value !== 'string' || !closingStatuses.includes(value as ClosingStatus)) {
    return invalidResponse();
  }
  return value as ClosingStatus;
}

/**
 * Reads one settlement. The derived numbers are recomputed here from the facts that produce
 * them and must agree with what the server published, so the rail can never show a drawer that
 * disagrees with its own money.
 */
function readClosing(value: unknown): Closing {
  const record = fields(value, ['id', 'branch_location_id', 'branch_name', 'status',
    'period_start', 'cut_at', 'closed_at', 'commission_rate_percent', 'opening_cash', 'cash_sales',
    'cash_expenses', 'expected_cash', 'counted_cash', 'cash_difference', 'contributed_cash',
    'closing_cash', 'taken_cash', 'sales_total', 'commission_amount', 'card_total',
    'transfer_total', 'qr_total', 'observation', 'opened_by_account_id', 'count_lines', 'rounds',
    'expenses', 'corrections']);
  // The branch's own expenses of the window. They are still not rendered, but the document is
  // only accepted when the field is the array the contract publishes, so a shape change cannot
  // reach the rail unnoticed.
  if (!Array.isArray(record.expenses) || !Array.isArray(record.corrections)) return invalidResponse();
  const state = status(record.status);
  const period_start = timestamp(record.period_start);
  const cut_at = timestamp(record.cut_at);
  if (Date.parse(cut_at) < Date.parse(period_start)) return invalidResponse();
  const closed_at = optionalTimestamp(record.closed_at);
  if ((state === 'closed') !== (closed_at !== null)) return invalidResponse();
  const rate = record.commission_rate_percent === null ? null : percent(record.commission_rate_percent);
  if ((state === 'open') !== (rate === null)) return invalidResponse();
  const counted_cash_cents = optionalAmount(record.counted_cash);
  const closing_cash_cents = optionalAmount(record.closing_cash);
  if (!Array.isArray(record.count_lines) || record.count_lines.length > closingMaxCountLines) {
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
    id: integer(record.id, 1, Number.MAX_SAFE_INTEGER),
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
    counted_cash_cents,
    contributed_cash_cents: amount(record.contributed_cash),
    closing_cash_cents,
    sales_total_cents: amount(record.sales_total),
    commission_amount_cents: amount(record.commission_amount),
    card_total_cents: amount(record.card_total),
    transfer_total_cents: amount(record.transfer_total),
    qr_total_cents: amount(record.qr_total),
    observation: freeText(record.observation, 1000),
    opened_by_account_id: integer(record.opened_by_account_id, 1, Number.MAX_SAFE_INTEGER),
    count_lines: Object.freeze(count_lines),
    rounds: Object.freeze(rounds),
  });
  const rail: ClosingRail = closingRail(closing);
  if (amount(record.expected_cash) !== rail.expected_cents) return invalidResponse();
  const difference = record.cash_difference === null ? null : signedAmount(record.cash_difference);
  if (difference !== rail.difference_cents) return invalidResponse();
  const taken = record.taken_cash === null ? null : signedAmount(record.taken_cash);
  if (taken !== rail.taken_cents) return invalidResponse();
  if (rate !== null && rail.commission_cents !== commissionOf(rail.sales_total_cents, rate)) {
    return invalidResponse();
  }
  return closing;
}

/** Parses one settlement document, from the wire or from a row of a page. */
export function parseClosing(raw: string): Closing {
  return readClosing(decode(raw));
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
  };
  // The opening conflict names the document that holds the branch as well as the branch itself.
  const keys = Object.keys(record);
  const expected = code === 'settlement_live' && keys.length === 3
    ? ['error', 'branch_location_id', 'closing_id'] : allowed[code] ?? ['error'];
  if (keys.length !== expected.length || expected.some(key => !Object.hasOwn(record, key))) {
    return invalidResponse();
  }
  const closing_id = code === 'settlement_live' && expected.length === 3
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

export function closingCashPath(id: number): string {
  return `/api/closings/${closingID(id)}/cash`;
}

export function closingProposePath(id: number): string {
  return `/api/closings/${closingID(id)}/propose`;
}

export function closingDecisionPath(id: number): string {
  return `/api/closings/${closingID(id)}/decision`;
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

    /** Records only what was counted: the expected quantity cannot even be expressed here. */
    async count(id: number, lines: readonly CountPayloadLine[], csrf: string,
      signal?: AbortSignal): Promise<Closing> {
      let body: string;
      let path: string;
      let wanted: number;
      try {
        token(csrf);
        path = closingCountPath(id);
        wanted = closingID(id);
        if (!Array.isArray(lines) || lines.length === 0 || lines.length > closingMaxCountLines) {
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

    /** Saves the drawer draft explicitly, so a reload does not lose the admin's work. */
    async cash(id: number, draft: {
      counted_cash: string | null; contributed_cash: string;
      closing_cash: string | null; observation: string;
    }, csrf: string, signal?: AbortSignal): Promise<Closing> {
      let body: string;
      let path: string;
      let wanted: number;
      try {
        token(csrf);
        path = closingCashPath(id);
        wanted = closingID(id);
        const keys = Object.keys(draft);
        if (keys.length !== 4) throw new Error('borrador inválido');
        body = JSON.stringify({
          counted_cash: draft.counted_cash, contributed_cash: draft.contributed_cash,
          closing_cash: draft.closing_cash, observation: draft.observation,
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
  };
}
