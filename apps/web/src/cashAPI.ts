/**
 * Transport of the branch's operational drawer: the book of the counter's till, the movements the
 * branch writes in it and the correction that answers one of them (S1, S2, S6, S8, S11).
 *
 * Every answer is admitted only when it is JSON of exactly the contract's shape. Money is integer
 * cents from end to end: an amount is the canonical two-decimal text the database writes, the
 * `effective` of a row is the only signed figure of the contract, and no amount is ever coerced to a
 * float. A row that would describe money twice — a correction without a target, a target on any other
 * kind, an effect that disagrees with the direction its kind states — is not a book this domain wrote,
 * so it is refused whole instead of being read as evidence.
 */
import { LosslessNumber, parse as parseJSON } from 'lossless-json';
import { centsToMoney, moneyCents } from './pointOfSaleModel';

/** The four kinds of the book: the three directions the branch writes and the correction. */
export type CashKind = 'gasto' | 'aporte' | 'recaudacion' | 'correccion';
/** The three kinds the branch records as a direction of its drawer: a correction has its own route. */
export type CashWrittenKind = 'gasto' | 'aporte' | 'recaudacion';

export const cashWrittenKinds: readonly CashWrittenKind[] = ['gasto', 'aporte', 'recaudacion'];
const cashKinds: readonly CashKind[] = ['gasto', 'aporte', 'recaudacion', 'correccion'];

/** The words every kind is written with: a badge says the kind, never only its colour (S8). */
export const cashKindLabels: Readonly<Record<CashKind, string>> = Object.freeze({
  gasto: 'Gasto', aporte: 'Aporte', recaudacion: 'Recaudación', correccion: 'Corrección',
});

/** The contract's own bounds, mirrored so a payload this client cannot express never leaves the screen. */
export const cashMaxDescription = 500;
export const cashLedgerMovements = 500;
/** `numeric(12,2)` in cents: the largest amount the database can publish. */
const cashMaxMoneyCents = 999_999_999_999n;
const cashMaxID = Number.MAX_SAFE_INTEGER;

/** Whether a kind puts money into the drawer. A gasto and a recaudación take it out. */
export function cashKindMovesIn(kind: CashWrittenKind): boolean {
  return kind === 'aporte';
}

export type CashErrorCode = 'invalid_request' | 'correction_target_invalid' | 'forbidden'
  | 'branch_frozen' | 'correction_exceeds' | 'service_unavailable'
  | 'invalid_response' | 'network' | 'aborted';

/** One admitted refusal per HTTP status; nothing else may reach the UI. */
export const cashAdmittedErrors: ReadonlyMap<number, readonly CashErrorCode[]> = new Map([
  [400, ['invalid_request', 'correction_target_invalid']],
  [403, ['forbidden']],
  [409, ['branch_frozen', 'correction_exceeds']],
  [503, ['service_unavailable']],
]);

/** Spanish message for every failure, including the transport ones. */
export const cashErrorMessages: Record<CashErrorCode, string> = {
  invalid_request: 'El servidor rechazó el movimiento: revisá el tipo, el monto y el motivo. No se registró nada.',
  correction_target_invalid: 'Ese movimiento no se puede corregir desde acá: lo firmó una rendición, es de otra sucursal o ya es una corrección. Se resuelve en la rendición, y no se registró nada.',
  forbidden: 'No podés mover la caja de esta sucursal desde esta cuenta. No se registró nada.',
  branch_frozen: 'La sucursal está congelada por una rendición en curso: el cajón no se mueve hasta que la rendición se cierre. No se registró nada.',
  correction_exceeds: 'La corrección supera lo que todavía falta corregir de ese movimiento. No se registró nada.',
  service_unavailable: 'El servicio no está disponible. No pudimos confirmar el movimiento: no sabemos si se registró.',
  invalid_response: 'La respuesta del servidor no es válida. No pudimos confirmar el movimiento.',
  network: 'No se pudo conectar con el servidor. No pudimos confirmar el movimiento.',
  aborted: 'La operación se interrumpió. Revisá la conexión e intentá de nuevo.',
};

/** The read of the book has its own words: a refused answer is not a refusal of a movement. */
export const cashLedgerUnavailable =
  'No se pudo leer el libro de la caja. Revisá la conexión e intentá de nuevo.';

/** One movement as the two write routes answer it. */
export interface CashMovement {
  readonly id: number;
  readonly branch_location_id: number;
  readonly kind: CashKind;
  readonly amount_cents: bigint;
  readonly description: string;
  readonly occurred_at: string;
  readonly created_by_account_id: number;
  readonly corrects_id: number | null;
}

/**
 * One row of the book: the movement plus the direction it carries (`effect_kind`, which for a
 * correction is the kind of the movement it answers) and the signed effect the drawer moved by.
 */
export interface CashLedgerEntry {
  readonly id: number;
  readonly kind: CashKind;
  readonly effect_kind: CashWrittenKind;
  readonly amount_cents: bigint;
  readonly effective_cents: bigint;
  readonly description: string;
  readonly occurred_at: string;
  readonly created_by_account_id: number;
  readonly corrects_id: number | null;
}

/**
 * The book of one window. `effective` is the signed sum of the whole window and `expected` its one
 * identity — `opening + sales + effective` — so the four figures and the list never disagree (S4,
 * S13). A truncated answer lists the newest 500 rows while its numbers cover every row.
 */
export interface CashLedger {
  readonly since: string | null;
  readonly until: string | null;
  readonly opening_cents: bigint;
  readonly sales_cents: bigint;
  readonly effective_cents: bigint;
  readonly expected_cents: bigint;
  readonly truncated: boolean;
  readonly movements: readonly CashLedgerEntry[];
}

/** A movement the branch records: its direction, its amount and what it was for. */
export interface CashMovementInput {
  readonly kind: CashWrittenKind;
  readonly amount: string;
  readonly description: string;
}

/** A correction: the movement it answers, the amount it returns or takes back, and why. */
export interface CashCorrectionInput {
  readonly corrects_id: number;
  readonly amount: string;
  readonly description: string;
}

// ---------------------------------------------------------------------------------
// Strict decoding
// ---------------------------------------------------------------------------------

function invalidResponse(): never { throw new Error('Respuesta inválida del servidor.'); }

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

function timestamp(value: unknown): string {
  if (typeof value !== 'string' || value === '' || value.includes('\0') || !value.isWellFormed()) {
    return invalidResponse();
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return invalidResponse();
  }
  const seconds = value.slice(0, 19) + 'Z';
  const date = new Date(seconds);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19) !== value.slice(0, 19)) {
    return invalidResponse();
  }
  if (!Number.isFinite(Date.parse(value))) return invalidResponse();
  return value;
}

const wireMoneyShape = /^-?(0|[1-9]\d{0,9})\.\d{2}$/;

/**
 * A published amount is the canonical two-decimal text the database writes. The amount of a row is
 * always positive; `effective` is the only signed figure of this contract, and a negative zero is
 * never canonical because the database writes `0.00`.
 */
function wireMoney(value: unknown, signed: boolean): bigint {
  if (typeof value !== 'string' || !wireMoneyShape.test(value)) return invalidResponse();
  const negative = value.startsWith('-');
  if (negative && !signed) return invalidResponse();
  const [whole, fraction] = (negative ? value.slice(1) : value).split('.');
  const magnitude = BigInt(whole) * 100n + BigInt(fraction);
  if (magnitude > cashMaxMoneyCents) return invalidResponse();
  if (negative && magnitude === 0n) return invalidResponse();
  return negative ? -magnitude : magnitude;
}

function positiveMoney(value: unknown): bigint {
  const cents = wireMoney(value, false);
  if (cents <= 0n) return invalidResponse();
  return cents;
}

/** The description is stored exactly as it was written: trimmed, never blank and inside its bound. */
function description(value: unknown): string {
  if (typeof value !== 'string' || value === '' || value.includes('\0') || !value.isWellFormed()) {
    return invalidResponse();
  }
  if (Array.from(value).length > cashMaxDescription || value.trim() !== value) return invalidResponse();
  return value;
}

/** The three kinds a direction can be written with; a correction is never one of them. */
function writtenKind(value: unknown): CashWrittenKind {
  if (typeof value !== 'string' || !cashWrittenKinds.includes(value as CashWrittenKind)) {
    return invalidResponse();
  }
  return value as CashWrittenKind;
}

function anyKind(value: unknown): CashKind {
  if (typeof value !== 'string' || !cashKinds.includes(value as CashKind)) return invalidResponse();
  return value as CashKind;
}

// ---------------------------------------------------------------------------------
// The answers of the two write routes
// ---------------------------------------------------------------------------------

/** Parses one recorded movement: the three directions, with no correction among them (S1, S2). */
export function parseCashMovement(raw: string): CashMovement {
  const record = fields(decode(raw), ['id', 'branch_location_id', 'kind', 'amount', 'description',
    'occurred_at', 'created_by_account_id']);
  return Object.freeze({
    id: integer(record.id, 1, cashMaxID),
    branch_location_id: integer(record.branch_location_id, 2, 32767),
    kind: writtenKind(record.kind),
    amount_cents: positiveMoney(record.amount),
    description: description(record.description),
    occurred_at: timestamp(record.occurred_at),
    created_by_account_id: integer(record.created_by_account_id, 1, cashMaxID),
    corrects_id: null,
  });
}

/** Parses one recorded correction: kind `correccion` and the movement it answers (S6). */
export function parseCashCorrection(raw: string): CashMovement {
  const record = fields(decode(raw), ['id', 'branch_location_id', 'kind', 'amount', 'description',
    'occurred_at', 'created_by_account_id', 'corrects_id']);
  const id = integer(record.id, 1, cashMaxID);
  if (record.kind !== 'correccion') return invalidResponse();
  return Object.freeze({
    id,
    branch_location_id: integer(record.branch_location_id, 2, 32767),
    kind: 'correccion',
    amount_cents: positiveMoney(record.amount),
    description: description(record.description),
    occurred_at: timestamp(record.occurred_at),
    created_by_account_id: integer(record.created_by_account_id, 1, cashMaxID),
    // A correction answers a movement that already existed: it never names itself or a later row.
    corrects_id: integer(record.corrects_id, 1, id - 1),
  });
}

// ---------------------------------------------------------------------------------
// The book of the window
// ---------------------------------------------------------------------------------

/** One row of the book, judged as the money and the direction it states. */
function ledgerEntry(value: unknown): CashLedgerEntry {
  const record = fields(value, ['id', 'kind', 'effect_kind', 'amount', 'effective', 'description',
    'occurred_at', 'created_by_account_id', 'corrects_id']);
  const id = integer(record.id, 1, cashMaxID);
  const kind = anyKind(record.kind);
  const effect_kind = writtenKind(record.effect_kind);
  const amount_cents = positiveMoney(record.amount);
  const effective_cents = wireMoney(record.effective, true);
  const corrects_id = record.corrects_id === null
    ? null : integer(record.corrects_id, 1, id - 1);
  // A correction without a target would be money out of nowhere, and a target on any other kind
  // would describe a cancelation the rest of the domain does not read (S6).
  if ((kind === 'correccion') !== (corrects_id !== null)) return invalidResponse();
  // A correction carries the kind of the movement it answers; every other row carries its own.
  if (kind !== 'correccion' && effect_kind !== kind) return invalidResponse();
  // The direction is the one effect_kind states, inverted for a correction: an aporte enters the
  // drawer, a gasto and a recaudación leave it, and the correction of a gasto puts the money back.
  const into = (effect_kind === 'aporte') !== (kind === 'correccion');
  if (into !== (effective_cents > 0n)) return invalidResponse();
  // The view states the effect as the amount with its sign: an effect of another magnitude is not
  // this row's money.
  if ((effective_cents < 0n ? -effective_cents : effective_cents) !== amount_cents) {
    return invalidResponse();
  }
  return Object.freeze({
    id, kind, effect_kind, amount_cents, effective_cents,
    description: description(record.description),
    occurred_at: timestamp(record.occurred_at),
    created_by_account_id: integer(record.created_by_account_id, 1, cashMaxID),
    corrects_id,
  });
}

/**
 * Parses the book of one window whole: its two bounds, its four figures, the fact that its list is a
 * window of a longer period and the movements themselves, oldest first. The four figures close on the
 * drawer's own identity and, when nothing was truncated, on the sum of the rows listed beside them, so
 * the screen can never show a list that disagrees with the number above it (S13).
 */
export function parseCashLedger(raw: string): CashLedger {
  const record = fields(decode(raw), ['since', 'until', 'opening', 'sales', 'effective', 'expected',
    'truncated', 'movements']);
  const since = record.since === null ? null : timestamp(record.since);
  const until = record.until === null ? null : timestamp(record.until);
  if (since !== null && until !== null && Date.parse(since) > Date.parse(until)) return invalidResponse();
  const opening_cents = wireMoney(record.opening, false);
  const sales_cents = wireMoney(record.sales, false);
  const effective_cents = wireMoney(record.effective, true);
  const expected_cents = wireMoney(record.expected, true);
  if (expected_cents !== opening_cents + sales_cents + effective_cents) return invalidResponse();
  if (typeof record.truncated !== 'boolean') return invalidResponse();
  if (!Array.isArray(record.movements) || record.movements.length > cashLedgerMovements) {
    return invalidResponse();
  }
  const movements = record.movements.map(ledgerEntry);
  movements.forEach((movement, index) => {
    const at = Date.parse(movement.occurred_at);
    // The list is the window's own movements: an instant outside it is another window's row.
    if (since !== null && at < Date.parse(since)) return invalidResponse();
    if (until !== null && at >= Date.parse(until)) return invalidResponse();
    if (index === 0) return;
    const previous = movements[index - 1];
    const before = Date.parse(previous.occurred_at);
    // A book is read in the order it happened: the sequence advances in (occurred_at, id).
    if (before > at || (before === at && previous.id >= movement.id)) return invalidResponse();
  });
  if (record.truncated) {
    // The bound keeps the newest rows, so a truncated list is exactly the bound long and its figures
    // are the whole window's: that is the one shape in which the total is not the sum of the list.
    if (movements.length !== cashLedgerMovements) return invalidResponse();
  } else {
    const sum = movements.reduce((total, movement) => total + movement.effective_cents, 0n);
    if (sum !== effective_cents) return invalidResponse();
  }
  return Object.freeze({
    since, until, opening_cents, sales_cents, effective_cents, expected_cents,
    truncated: record.truncated, movements: Object.freeze(movements),
  });
}

// ---------------------------------------------------------------------------------
// Payloads this client can express
// ---------------------------------------------------------------------------------

function invalidPayload(): never { throw new Error('Movimiento de caja inválido.'); }

function inputFields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidPayload();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some(key => !Object.hasOwn(record, key))) {
    return invalidPayload();
  }
  return record;
}

/** A typed amount becomes the canonical positive text the contract states, never a zero movement. */
function canonicalPositive(value: unknown): string {
  if (typeof value !== 'string') return invalidPayload();
  let cents: bigint;
  try { cents = moneyCents(value); } catch { return invalidPayload(); }
  if (cents <= 0n) return invalidPayload();
  return centsToMoney(cents);
}

/** The description goes out exactly as it is stored: trimmed, never blank and inside its bound. */
function canonicalDescription(value: unknown): string {
  if (typeof value !== 'string' || value.includes('\0') || !value.isWellFormed()) return invalidPayload();
  const trimmed = value.trim();
  if (trimmed === '' || Array.from(trimmed).length > cashMaxDescription) return invalidPayload();
  return trimmed;
}

function canonicalID(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > cashMaxID) {
    return invalidPayload();
  }
  return value;
}

/** One movement this client may send: a direction, a positive canonical amount and a motive. */
export function canonicalCashInput(input: CashMovementInput): CashMovementInput {
  const record = inputFields(input, ['kind', 'amount', 'description']);
  if (typeof record.kind !== 'string' || !cashWrittenKinds.includes(record.kind as CashWrittenKind)) {
    return invalidPayload();
  }
  return Object.freeze({ kind: record.kind as CashWrittenKind,
    amount: canonicalPositive(record.amount), description: canonicalDescription(record.description) });
}

/** One correction this client may send: no correction of a correction is even expressible here. */
export function canonicalCashCorrection(input: CashCorrectionInput): CashCorrectionInput {
  const record = inputFields(input, ['corrects_id', 'amount', 'description']);
  return Object.freeze({ corrects_id: canonicalID(record.corrects_id),
    amount: canonicalPositive(record.amount), description: canonicalDescription(record.description) });
}

/** The answer is evidence only if it repeats the exact movement this client sent. */
export function matchesCashInput(input: CashMovementInput, movement: CashMovement): boolean {
  let expected: CashMovementInput;
  try { expected = canonicalCashInput(input); } catch { return false; }
  return movement.kind === expected.kind
    && movement.amount_cents === moneyCents(expected.amount)
    && movement.description === expected.description
    && movement.corrects_id === null;
}

/** A correction must mirror the movement it answers and the amount it stated. */
export function matchesCashCorrection(input: CashCorrectionInput, movement: CashMovement): boolean {
  let expected: CashCorrectionInput;
  try { expected = canonicalCashCorrection(input); } catch { return false; }
  return movement.kind === 'correccion'
    && movement.corrects_id === expected.corrects_id
    && movement.amount_cents === moneyCents(expected.amount)
    && movement.description === expected.description;
}

// ---------------------------------------------------------------------------------
// Paths, refusals and transport
// ---------------------------------------------------------------------------------

const instantShape = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

function ledgerBound(value: string | null, key: 'from' | 'to'): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !instantShape.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error('Ventana del libro inválida.');
  }
  return `${key}=${encodeURIComponent(value)}`;
}

/**
 * The book of one window. Without bounds the path asks for the store's own default window — from the
 * cut of the last closed settlement with the amount it left in the drawer — and never invents an
 * instant the server did not publish (S12).
 */
export function cashLedgerPath(from: string | null = null, to: string | null = null): string {
  const bounds = [ledgerBound(from, 'from'), ledgerBound(to, 'to')];
  if (from !== null && to !== null && Date.parse(from) > Date.parse(to)) {
    throw new Error('Ventana del libro inválida.');
  }
  const query = bounds.filter(bound => bound !== null).join('&');
  return query === '' ? '/api/closings/cash-ledger' : `/api/closings/cash-ledger?${query}`;
}

export function parseCashError(raw: string, status: number): CashErrorCode {
  const admitted = cashAdmittedErrors.get(status);
  if (!admitted) return invalidResponse();
  const envelope = fields(decode(raw), ['error']);
  const code = envelope.error;
  if (typeof code !== 'string' || !admitted.includes(code as CashErrorCode)) return invalidResponse();
  return code as CashErrorCode;
}

/** A definite rejection wrote nothing; every other failure leaves the outcome unknown. */
export function cashFailureIsDefinite(code: CashErrorCode): boolean {
  return code !== 'service_unavailable' && code !== 'invalid_response'
    && code !== 'network' && code !== 'aborted';
}

export class CashAPIError extends Error {
  constructor(public readonly code: CashErrorCode, public readonly status: number | null) {
    super(code); this.name = 'CashAPIError';
  }
}

const jsonHeader = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;
const csrfToken = /^[A-Za-z0-9_-]+$/;

function transportFailure(error: unknown, signal?: AbortSignal): CashAPIError {
  const aborted = signal?.aborted === true
    || (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError');
  return new CashAPIError(aborted ? 'aborted' : 'network', null);
}

async function readText(reply: Response, signal?: AbortSignal): Promise<string> {
  try { return await reply.text(); } catch (error) { throw transportFailure(error, signal); }
}

export function createCashAPI(fetch: typeof globalThis.fetch = globalThis.fetch) {
  async function get<T>(path: string, parse: (raw: string) => T, signal?: AbortSignal): Promise<T> {
    let reply: Response;
    let raw: string;
    try {
      reply = await fetch(path, { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal });
      raw = await readText(reply, signal);
    } catch (error) {
      if (error instanceof CashAPIError) throw error;
      throw transportFailure(error, signal);
    }
    const malformed = () => new CashAPIError('invalid_response', reply.status);
    if (!jsonHeader.test(reply.headers.get('Content-Type') ?? '')) throw malformed();
    if (reply.status !== 200) {
      let code: CashErrorCode;
      try { code = parseCashError(raw, reply.status); } catch { throw malformed(); }
      throw new CashAPIError(code, reply.status);
    }
    try { return parse(raw); } catch { throw malformed(); }
  }

  async function post<T>(path: string, body: string, csrf: string,
    parse: (raw: string) => T, signal?: AbortSignal): Promise<T> {
    let reply: Response;
    let raw: string;
    try {
      reply = await fetch(path, { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body });
      raw = await readText(reply, signal);
    } catch (error) {
      if (error instanceof CashAPIError) throw error;
      throw transportFailure(error, signal);
    }
    const malformed = () => new CashAPIError('invalid_response', reply.status);
    if (!jsonHeader.test(reply.headers.get('Content-Type') ?? '')) throw malformed();
    if (reply.status !== 201) {
      let code: CashErrorCode;
      try { code = parseCashError(raw, reply.status); } catch { throw malformed(); }
      throw new CashAPIError(code, reply.status);
    }
    try { return parse(raw); } catch { throw malformed(); }
  }

  function token(csrf: string): string {
    if (typeof csrf !== 'string' || !csrfToken.test(csrf)) throw new CashAPIError('invalid_request', null);
    return csrf;
  }

  return {
    /** Records a gasto, an aporte or a recaudación in the session's own drawer (S1, S2). */
    async record(input: CashMovementInput, csrf: string, signal?: AbortSignal): Promise<CashMovement> {
      let body: string;
      let sent: CashMovementInput;
      try {
        token(csrf);
        sent = canonicalCashInput(input);
        body = JSON.stringify(sent);
      } catch { throw new CashAPIError('invalid_request', null); }
      const movement = await post('/api/closings/cash-movements', body, csrf, parseCashMovement, signal);
      if (!matchesCashInput(sent, movement)) throw new CashAPIError('invalid_response', 201);
      return movement;
    },

    /** Answers one movement with its opposite: nothing is edited and nothing is deleted (S6). */
    async correct(input: CashCorrectionInput, csrf: string, signal?: AbortSignal): Promise<CashMovement> {
      let body: string;
      let sent: CashCorrectionInput;
      try {
        token(csrf);
        sent = canonicalCashCorrection(input);
        body = JSON.stringify(sent);
      } catch { throw new CashAPIError('invalid_request', null); }
      const movement = await post('/api/closings/cash-corrections', body, csrf, parseCashCorrection, signal);
      if (!matchesCashCorrection(sent, movement)) throw new CashAPIError('invalid_response', 201);
      return movement;
    },

    /**
     * The book of one window. The answer is evidence only when it describes the window that was asked
     * for, so the period on screen and the numbers under it can never be two different periods.
     */
    async ledger(from: string | null = null, to: string | null = null,
      signal?: AbortSignal): Promise<CashLedger> {
      let path: string;
      try { path = cashLedgerPath(from, to); } catch { throw new CashAPIError('invalid_request', null); }
      const book = await get(path, parseCashLedger, signal);
      const malformed = () => new CashAPIError('invalid_response', 200);
      if (from !== null && (book.since === null || Date.parse(book.since) !== Date.parse(from))) {
        throw malformed();
      }
      if (to === null ? book.until !== null : (book.until === null || Date.parse(book.until) !== Date.parse(to))) {
        throw malformed();
      }
      return book;
    },
  };
}

export type CashAPI = ReturnType<typeof createCashAPI>;
