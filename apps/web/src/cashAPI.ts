/**
 * Transport of the branch's operational drawer: the closed list of motives an expense is recorded with,
 * the book of the counter's till, the movements the branch writes in it and the correction that answers
 * one of them (S1, S2, S6, S8, S11).
 *
 * Every answer is admitted only when it is JSON of exactly the contract's shape. Money is integer
 * cents from end to end: an amount is the canonical two-decimal text the database writes, the
 * `effective` of a row is the only signed figure of the contract, and no amount is ever coerced to a
 * float. A row that would describe money twice — a correction without a target, a target on any other
 * kind, an effect that disagrees with the direction its kind states — is not a book this domain wrote,
 * so it is refused whole instead of being read as evidence.
 */
import { LosslessNumber, parse as parseJSON } from 'lossless-json';
import {
  closingEvidenceTypes, closingMaxEvidenceBytes, closingMaxEvidenceSide,
  type ClosingEvidence, type ClosingEvidenceType,
} from './closingModel';
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
/** The bound of the label of one motive of the closed list an expense is recorded with (061, S2). */
export const cashMaxCategoryLabel = 500;
export const cashLedgerMovements = 500;
/** `numeric(12,2)` in cents: the largest amount the database can publish. */
const cashMaxMoneyCents = 999_999_999_999n;
const cashMaxID = Number.MAX_SAFE_INTEGER;
/** The canonical two-decimal text an amount of money is stated with, both ways: what is written and what
 * a refusal of the till answers back. A balance is a signed quantity, so its text may carry one leading
 * minus -- a drawer that is already negative states it that way -- and nothing else is admitted. */
const canonicalStatedMoney = /^-?\d{1,10}\.\d{2}$/;

/** Whether a kind puts money into the drawer. A gasto and a recaudación take it out. */
export function cashKindMovesIn(kind: CashWrittenKind): boolean {
  return kind === 'aporte';
}

export type CashErrorCode = 'invalid_request' | 'correction_target_invalid' | 'forbidden'
  | 'branch_frozen' | 'correction_exceeds' | 'drawer_insufficient' | 'service_unavailable'
  | 'category_required' | 'category_unknown' | 'category_not_applicable'
  | 'evidence_empty' | 'evidence_too_large' | 'evidence_unsupported' | 'evidence_dimensions'
  | 'evidence_not_applicable'
  | 'invalid_response' | 'network' | 'aborted';

/** One admitted refusal per HTTP status; nothing else may reach the UI. */
export const cashAdmittedErrors: ReadonlyMap<number, readonly CashErrorCode[]> = new Map([
  [400, ['invalid_request', 'correction_target_invalid', 'category_required', 'category_unknown',
    'category_not_applicable', 'evidence_empty', 'evidence_too_large', 'evidence_unsupported',
    'evidence_dimensions', 'evidence_not_applicable']],
  [403, ['forbidden']],
  [409, ['branch_frozen', 'correction_exceeds', 'drawer_insufficient']],
  [503, ['service_unavailable']],
]);

/** Spanish message for every failure, including the transport ones. */
export const cashErrorMessages: Record<CashErrorCode, string> = {
  invalid_request: 'El servidor rechazó el movimiento: revisá el tipo, el monto y el motivo. No se registró nada.',
  correction_target_invalid: 'Ese movimiento no se puede corregir desde acá: lo firmó una rendición, es de otra sucursal o ya es una corrección. Se resuelve en la rendición, y no se registró nada.',
  forbidden: 'No podés mover la caja de esta sucursal desde esta cuenta. No se registró nada.',
  branch_frozen: 'La sucursal está congelada por una rendición en curso: el cajón no se mueve hasta que la rendición se cierre. No se registró nada.',
  correction_exceeds: 'La corrección supera lo que todavía falta corregir de ese movimiento. No se registró nada.',
  drawer_insufficient: 'La caja no tiene ese dinero: el movimiento gasta más de lo que hay en el cajón. Gastá menos o registrá un aporte por el efectivo que tenés. No se registró nada.',
  service_unavailable: 'El servicio no está disponible. No pudimos confirmar el movimiento: no sabemos si se registró.',
  category_required: 'Elegí un motivo de la lista: un gasto sin motivo no se registra. No se registró nada.',
  category_unknown: 'Ese motivo ya no está en la lista. Elegí otro y volvé a intentar. No se registró nada.',
  category_not_applicable: 'Un aporte o una recaudación no llevan motivo de gasto. No se registró nada.',
  // The refusals of the receipt are written once and read by both sides: the screen judges the chosen
  // file with these words before it sends it, and the server's code is read with the same ones (S1, S6).
  evidence_empty: 'El archivo del comprobante está vacío. Elegí otra foto o registrá el gasto sin comprobante.',
  evidence_too_large: 'La foto del comprobante pesa más de 8 MB. Elegí una más liviana o registrá el gasto sin comprobante.',
  evidence_unsupported: 'El comprobante tiene que ser una foto JPEG o PNG. Ese archivo no es una imagen de las que se aceptan.',
  evidence_dimensions: 'La foto del comprobante mide más de 10000 × 10000 píxeles. Achicála o registrá el gasto sin comprobante.',
  evidence_not_applicable: 'Sólo un gasto lleva comprobante: un aporte o una recaudación no llevan foto.',
  invalid_response: 'La respuesta del servidor no es válida. No pudimos confirmar el movimiento.',
  network: 'No se pudo conectar con el servidor. No pudimos confirmar el movimiento.',
  aborted: 'La operación se interrumpió. Revisá la conexión e intentá de nuevo.',
};

/** The read of the book has its own words: a refused answer is not a refusal of a movement. */
export const cashLedgerUnavailable =
  'No se pudo leer el libro de la caja. Revisá la conexión e intentá de nuevo.';

/** The closed list of motives has its own words too: without it an expense cannot be registered, while
 * a contribution and a collection name no motive of the list and keep working (S1, S4). */
export const cashCatalogueUnavailable =
  'No se pudo leer la lista de motivos: un gasto no se puede registrar hasta que la lista vuelva. Los aportes y las recaudaciones siguen funcionando.';

/** One motive of the closed list an expense is recorded with (S1, S2): the id the row states and the
 * label the screen offers. Nothing here creates, renames or archives one (S6). */
export interface CashCategory {
  readonly id: number;
  readonly label: string;
}

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
 * correction is the kind of the movement it answers) and the signed effect the drawer moved by. An
 * expense states its motive beside it — the reference and the copy of the label it had when the row was
 * written — and every other row states both as null (S4, S7, S8). The receipt of a pay-out is published
 * as its metadata — type, size and SHA-256 — and as null on every row that carries none (S1, S7): the
 * bytes are served by the image route and never travel inside the book.
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
  readonly category_id: number | null;
  readonly category_label: string | null;
  readonly evidence: ClosingEvidence | null;
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

/** A movement the branch records: its direction, its amount and what it was for. An expense names the
 * motive of the closed list and its note is optional; a contribution and a collection name no motive and
 * still state what they are for (S3, S4). */
export interface CashMovementInput {
  readonly kind: CashWrittenKind;
  readonly amount: string;
  readonly description: string;
  readonly category_id?: number;
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

/** The note beside the motive of an expense is optional, so it may be the empty string: it is stored
 * trimmed and inside its bound like every other text of the contract (S3). */
function note(value: unknown): string {
  if (typeof value !== 'string' || value.includes('\0') || !value.isWellFormed()) {
    return invalidResponse();
  }
  if (Array.from(value).length > cashMaxDescription || value.trim() !== value) return invalidResponse();
  return value;
}

/** The text a row of the book states: the optional note of an expense, the mandatory description of
 * every other kind. */
function rowText(kind: CashKind, value: unknown): string {
  return kind === 'gasto' ? note(value) : description(value);
}

/** The label of one motive of the closed list is the canonical text the catalogue stores (061, S2). */
function label(value: unknown): string {
  if (typeof value !== 'string' || value === '' || value.includes('\0') || !value.isWellFormed()) {
    return invalidResponse();
  }
  if (Array.from(value).length > cashMaxCategoryLabel || value.trim() !== value) {
    return invalidResponse();
  }
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
// The receipt of a pay-out
// ---------------------------------------------------------------------------------

/** The two caps of one photo, mirrored from the contract so a file it cannot take is refused before
 * anything leaves the screen (S1, S6). */
export const cashMaxEvidenceBytes = closingMaxEvidenceBytes;
export const cashMaxEvidenceSide = closingMaxEvidenceSide;

/** The four refusals one chosen file can be judged with on this side of the wire. */
export type CashEvidenceRefusal = 'evidence_empty' | 'evidence_too_large' | 'evidence_unsupported'
  | 'evidence_dimensions';

/** The digest the contract publishes: 32 bytes of lowercase hexadecimal. */
const evidenceDigest = /^[0-9a-f]{64}$/;

/**
 * A receipt as the book publishes it (S1, S7): the three keys of the contract — the type the server
 * validated by decoding the bytes, the size of those bytes and their SHA-256 — and `null` on a row that
 * carries no photo. Only a pay-out carries one, so a receipt on any other kind is not a row this book
 * wrote (S2).
 */
function publishedEvidence(value: unknown, kind: CashKind): ClosingEvidence | null {
  if (value === null) return null;
  const record = fields(value, ['type', 'size', 'sha256']);
  if (typeof record.type !== 'string'
    || !closingEvidenceTypes.includes(record.type as ClosingEvidenceType)) {
    return invalidResponse();
  }
  const size = integer(record.size, 1, cashMaxEvidenceBytes);
  if (typeof record.sha256 !== 'string' || !evidenceDigest.test(record.sha256)) {
    return invalidResponse();
  }
  if (kind !== 'gasto') return invalidResponse();
  return Object.freeze({ type: record.type as ClosingEvidenceType, size, sha256: record.sha256 });
}

// ---------------------------------------------------------------------------------
// The answers of the two write routes
// ---------------------------------------------------------------------------------

/** Parses one recorded movement: the three directions, with no correction among them (S1, S2). */
export function parseCashMovement(raw: string): CashMovement {
  const record = fields(decode(raw), ['id', 'branch_location_id', 'kind', 'amount', 'description',
    'occurred_at', 'created_by_account_id']);
  const kind = writtenKind(record.kind);
  return Object.freeze({
    id: integer(record.id, 1, cashMaxID),
    branch_location_id: integer(record.branch_location_id, 2, 32767),
    kind,
    amount_cents: positiveMoney(record.amount),
    // A gasto is written with a motive, so its text is the optional note beside it (S3).
    description: rowText(kind, record.description),
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
    'occurred_at', 'created_by_account_id', 'corrects_id', 'category_id', 'category_label',
    'evidence']);
  const id = integer(record.id, 1, cashMaxID);
  const kind = anyKind(record.kind);
  const effect_kind = writtenKind(record.effect_kind);
  const amount_cents = positiveMoney(record.amount);
  const effective_cents = wireMoney(record.effective, true);
  const corrects_id = record.corrects_id === null
    ? null : integer(record.corrects_id, 1, id - 1);
  // The motive is the pair an expense states: its reference and the copy of the label it had when the row
  // was written. A row that states only one of the two describes nothing this domain wrote (S8).
  const category_id = record.category_id === null ? null : integer(record.category_id, 1, cashMaxID);
  const category_label = record.category_label === null ? null : label(record.category_label);
  if ((category_id === null) !== (category_label === null)) return invalidResponse();
  // Only an expense names a motive: a motive on any other kind is not a row of this book (S4).
  if (category_id !== null && kind !== 'gasto') return invalidResponse();
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
    description: rowText(kind, record.description),
    occurred_at: timestamp(record.occurred_at),
    created_by_account_id: integer(record.created_by_account_id, 1, cashMaxID),
    corrects_id, category_id, category_label,
    evidence: publishedEvidence(record.evidence, kind),
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
// The closed list of motives an expense is recorded with
// ---------------------------------------------------------------------------------

/**
 * Parses the closed list of motives whole: the options of the screen, in the order the database states
 * them. Every option states exactly its identity and its label, both canonical, and no motive is offered
 * twice; an empty catalogue is an empty list and never a missing key (S1, S2, S6).
 */
export function parseCashCategories(raw: string): readonly CashCategory[] {
  const record = fields(decode(raw), ['categories']);
  if (!Array.isArray(record.categories)) return invalidResponse();
  const seenID = new Set<number>();
  const seenLabel = new Set<string>();
  const options = record.categories.map((option: unknown) => {
    const one = fields(option, ['id', 'label']);
    const id = integer(one.id, 1, cashMaxID);
    const text = label(one.label);
    if (seenID.has(id) || seenLabel.has(text)) return invalidResponse();
    seenID.add(id);
    seenLabel.add(text);
    return Object.freeze({ id, label: text });
  });
  return Object.freeze(options);
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

/** The note of an expense goes out as it is stored: trimmed, inside its bound and possibly empty. */
function canonicalNote(value: unknown): string {
  if (typeof value !== 'string' || value.includes('\0') || !value.isWellFormed()) return invalidPayload();
  const trimmed = value.trim();
  if (Array.from(trimmed).length > cashMaxDescription) return invalidPayload();
  return trimmed;
}

function canonicalID(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > cashMaxID) {
    return invalidPayload();
  }
  return value;
}

/**
 * One movement this client may send, judged per kind exactly as the contract judges it: an expense states
 * the motive of the closed list and an optional note, and a contribution or a collection states no motive
 * and still states what it is for (S3, S4).
 */
export function canonicalCashInput(input: CashMovementInput): CashMovementInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalidPayload();
  const record = input as unknown as Record<string, unknown>;
  const keys = record.kind === 'gasto'
    ? ['kind', 'amount', 'category_id', 'description']
    : ['kind', 'amount', 'description'];
  if (Object.keys(record).length !== keys.length || keys.some(key => !Object.hasOwn(record, key))) {
    return invalidPayload();
  }
  if (typeof record.kind !== 'string' || !cashWrittenKinds.includes(record.kind as CashWrittenKind)) {
    return invalidPayload();
  }
  const kind = record.kind as CashWrittenKind;
  const amount = canonicalPositive(record.amount);
  if (kind === 'gasto') {
    return Object.freeze({ kind, amount, category_id: canonicalID(record.category_id),
      description: canonicalNote(record.description) });
  }
  return Object.freeze({ kind, amount, description: canonicalDescription(record.description) });
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
// The photo of a pay-out, judged before it leaves the screen
// ---------------------------------------------------------------------------------

const jpegSignature: readonly number[] = [0xff, 0xd8];
const pngSignature: readonly number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return bytes.length >= signature.length && signature.every((byte, at) => bytes[at] === byte);
}

/**
 * The two sides of one PNG, read from its IHDR chunk, which is always the first chunk of the file: eight
 * bytes of signature, the length of the chunk, its type and then the width and the height.
 */
function pngSides(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  if (String.fromCharCode(...bytes.slice(12, 16)) !== 'IHDR') return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * The two sides of one JPEG, read from its frame header (SOF), which is the only place the file states
 * them: the segments before it — JFIF, EXIF — are skipped by their own stated length.
 */
function jpegSides(bytes: Uint8Array): { width: number; height: number } | null {
  let at = 2;
  while (at + 3 < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1];
    // A padding byte before a marker, and the markers that carry no segment of their own.
    if (marker === 0xff) { at += 1; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { at += 2; continue; }
    // The compressed data starts before any frame header: this file states no sides at all.
    if (marker === 0xda || marker === 0xd9) return null;
    const length = (bytes[at + 2] << 8) | bytes[at + 3];
    if (length < 2) return null;
    // SOF0–SOF15 carry the frame, except C4 (Huffman tables), C8 (a reserved marker) and CC (arithmetic).
    if (marker >= 0xc0 && marker <= 0xcf
      && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (at + 9 > bytes.length) return null;
      return {
        width: (bytes[at + 7] << 8) | bytes[at + 8],
        height: (bytes[at + 5] << 8) | bytes[at + 6],
      };
    }
    at += 2 + length;
  }
  return null;
}

/**
 * Judges one chosen file before anything leaves the screen (S1, S6): a file that states no bytes, one
 * above the 8 MB cap, one whose own bytes are not a JPEG or a PNG, and one above the 10000×10000 pixel
 * cap, which is measured from the header of the image exactly as the server measures it. The answer is
 * the refusal the contract names — the same words the screen shows for the server's own — or `null`.
 */
export async function cashEvidenceRefusal(file: Blob): Promise<CashEvidenceRefusal | null> {
  if (file.size === 0) return 'evidence_empty';
  if (file.size > cashMaxEvidenceBytes) return 'evidence_too_large';
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(await file.arrayBuffer()); } catch { return 'evidence_unsupported'; }
  const sides = startsWith(bytes, pngSignature) ? pngSides(bytes)
    : startsWith(bytes, jpegSignature) ? jpegSides(bytes) : null;
  if (sides === null || sides.width < 1 || sides.height < 1) return 'evidence_unsupported';
  if (sides.width > cashMaxEvidenceSide || sides.height > cashMaxEvidenceSide) {
    return 'evidence_dimensions';
  }
  return null;
}

/** The name one chosen photo travels with: its own when it has one, and a name of the route otherwise. */
function evidenceFileName(evidence: Blob): string {
  const name = typeof File !== 'undefined' && evidence instanceof File ? evidence.name : '';
  return name === '' ? 'comprobante' : name;
}

/**
 * The two-form body of the route (S9): the `movement` part is exactly the JSON object of the plain form
 * — the fields never become form fields — and the `evidence` part is the one file the operator chose
 * (S1). A pay-out with no photo never comes here: it is the JSON body this screen always sent.
 */
function uploadBody(body: string, evidence: Blob): FormData {
  const form = new FormData();
  form.append('movement', new Blob([body], { type: 'application/json' }), 'movement.json');
  form.append('evidence', evidence, evidenceFileName(evidence));
  return form;
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
  const parsed = decode(raw);
  // The bound of the till is the one refusal that states two quantities beside its code (S4). Its
  // envelope is admitted with them, and only with them: a refusal a client cannot read whole is not a
  // refusal this domain wrote. The balance is a signed quantity, because a drawer that is already
  // negative states that negative instead of hiding it.
  if (statedCode(parsed) === 'drawer_insufficient' && admitted.includes('drawer_insufficient')) {
    const envelope = fields(parsed, ['error', 'balance', 'requested']);
    if (typeof envelope.balance !== 'string' || !canonicalStatedMoney.test(envelope.balance)
      || typeof envelope.requested !== 'string' || !canonicalStatedMoney.test(envelope.requested)) {
      return invalidResponse();
    }
    return 'drawer_insufficient';
  }
  const envelope = fields(parsed, ['error']);
  const code = envelope.error;
  if (typeof code !== 'string' || !admitted.includes(code as CashErrorCode)) return invalidResponse();
  return code as CashErrorCode;
}

/** The code a refusal states, read before its envelope is judged whole: the till's refusal carries two
 * quantities beside it, and the other refusals carry the code alone. */
function statedCode(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof LosslessNumber) {
    return null;
  }
  const code = (value as Record<string, unknown>).error;
  return typeof code === 'string' ? code : null;
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

  async function post<T>(path: string, body: string | FormData, csrf: string,
    parse: (raw: string) => T, signal?: AbortSignal): Promise<T> {
    // The browser states the boundary of a multipart body; the JSON form keeps the header it always had.
    const headers: Record<string, string> = { 'X-CSRF-Token': csrf };
    if (typeof body === 'string') headers['Content-Type'] = 'application/json';
    let reply: Response;
    let raw: string;
    try {
      reply = await fetch(path, { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
        headers, body });
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
    /**
     * Records a gasto, an aporte or a recaudación in the session's own drawer (S1, S2), with the one
     * optional photo of a pay-out. The file is judged here as well as on the screen, so no request can
     * carry one the contract refuses (S6); without a file the body is the JSON this route always took (S9).
     */
    async record(input: CashMovementInput, csrf: string, signal?: AbortSignal,
      evidence: Blob | null = null): Promise<CashMovement> {
      let body: string;
      let sent: CashMovementInput;
      try {
        token(csrf);
        sent = canonicalCashInput(input);
        body = JSON.stringify(sent);
      } catch { throw new CashAPIError('invalid_request', null); }
      let upload: FormData | null = null;
      if (evidence !== null) {
        // Only a pay-out carries a receipt: a contribution and a collection never do (S2).
        if (sent.kind !== 'gasto') throw new CashAPIError('evidence_not_applicable', null);
        const refusal = await cashEvidenceRefusal(evidence);
        if (refusal !== null) throw new CashAPIError(refusal, null);
        upload = uploadBody(body, evidence);
      }
      const movement = await post('/api/closings/cash-movements', upload ?? body, csrf,
        parseCashMovement, signal);
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
     * The closed list of motives an expense is recorded with (S1, S2): the options the screen offers. It
     * states no branch, because the list is the same for every branch.
     */
    async categories(signal?: AbortSignal): Promise<readonly CashCategory[]> {
      return await get('/api/closings/cash-categories', parseCashCategories, signal);
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
