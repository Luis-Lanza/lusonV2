import { LosslessNumber, parse as parseJSON } from 'lossless-json';

/**
 * The frozen vocabulary of the battery warranty case (`apps/api/docs/warranty-cases.md`, S23) and the
 * strict readers of its wire. Nothing here invents a value the contract does not state: the phase, the
 * origin, the verdict, the destinations and the loan fate are the six lists below, and a reply that
 * carries anything else is not a reply this screen can describe.
 *
 * The tray row is the header of a case and nothing else, exactly as the contract publishes it, so a
 * queue of two hundred cases never drags two hundred histories. The client, the battery, its serial
 * and the days since the branch told the client are read from the case itself when it is selected:
 * that read is the one that carries the loans and the append-only history.
 */

export const warrantyOrigins = ['warranty_claim', 'stock_defect'] as const;
export type WarrantyOrigin = (typeof warrantyOrigins)[number];
export const warrantyPhases = ['received', 'in_transit', 'at_warehouse', 'at_factory', 'resolved', 'closed'] as const;
export type WarrantyPhase = (typeof warrantyPhases)[number];
export const warrantyVerdicts = ['repaired', 'replaced', 'unrepairable', 'not_covered', 'lost', 'refused_at_warehouse'] as const;
export type WarrantyVerdict = (typeof warrantyVerdicts)[number];
export const warrantyDestinations = ['customer', 'stock', 'scrap', 'retained_by_factory'] as const;
export type WarrantyDestination = (typeof warrantyDestinations)[number];
export const warrantyLoanFates = ['open', 'returned', 'kept_by_customer', 'failed', 'lost'] as const;
export type WarrantyLoanFate = (typeof warrantyLoanFates)[number];
export const warrantyEventKinds = ['phase', 'notice', 'release'] as const;
export type WarrantyEventKind = (typeof warrantyEventKinds)[number];

/** The two fates the counter states by delivering the exchange; the other three exclude each other. */
export const warrantyDeliveryFates = ['returned', 'kept_by_customer'] as const;
export type WarrantyDeliveryFate = (typeof warrantyDeliveryFates)[number];
/** The four fates a counter states about one lent battery; `open` is not a fate a caller writes (S7). */
export const warrantyLoanFatesStated = ['returned', 'kept_by_customer', 'failed', 'lost'] as const;
export type WarrantyLoanFateStated = (typeof warrantyLoanFatesStated)[number];

/** The labels the operator reads, one per frozen value. The value itself is never shown. */
export const warrantyOriginLabels: Record<WarrantyOrigin, string> = {
  warranty_claim: 'Garantía',
  stock_defect: 'Stock fallado',
};
export const warrantyPhaseLabels: Record<WarrantyPhase, string> = {
  received: 'Recibida en la sucursal',
  in_transit: 'En viaje al Almacén',
  at_warehouse: 'En el Almacén',
  at_factory: 'En fábrica',
  resolved: 'Resuelta · esperando al cliente',
  closed: 'Entregada al cliente',
};
/** The short form of a phase, for the list cell that has no room for the whole sentence. */
export const warrantyPhaseShortLabels: Record<WarrantyPhase, string> = {
  received: 'En la sucursal',
  in_transit: 'En viaje',
  at_warehouse: 'En el Almacén',
  at_factory: 'En fábrica',
  resolved: 'Esperando al cliente',
  closed: 'Entregada',
};
export const warrantyVerdictLabels: Record<WarrantyVerdict, string> = {
  repaired: 'Reparada',
  replaced: 'Reemplazada',
  unrepairable: 'Sin reparación',
  not_covered: 'No cubierta',
  lost: 'Perdida',
  refused_at_warehouse: 'Rechazada en el Almacén',
};
export const warrantyDestinationLabels: Record<WarrantyDestination, string> = {
  customer: 'Al cliente',
  stock: 'A stock vendible',
  scrap: 'A chatarra',
  retained_by_factory: 'Retenida por fábrica',
};
export const warrantyLoanFateLabels: Record<WarrantyLoanFate, string> = {
  open: 'En préstamo',
  returned: 'Devuelta al canjear',
  kept_by_customer: 'Queda con el cliente',
  failed: 'Falló',
  lost: 'Perdida',
};
export const warrantyEventKindLabels: Record<WarrantyEventKind, string> = {
  phase: 'Etapa del viaje',
  notice: 'Aviso al cliente',
  release: 'Liberación a stock',
};

/** The database's own bounds, restated so an inadmissible text never leaves this module. */
export const warrantyMaxSerial = 64;
export const warrantyMaxNote = 500;
export const warrantyMaxModel = 40;
export const warrantyMaxQuantity = 1_000_000;
export const warrantyMinLoanQuantity = 1;
export const warrantyMaxLoanQuantity = 10_000;
export const warrantyMaxListed = 200;
export const warrantyMaxLocation = 32767;
export const warrantyMaxVariant = 2_147_483_647;
const maxID = 9_007_199_254_740_991;
const maxInt64 = 9_223_372_036_854_775_807n;
/** The model contract of a used battery: trimmed, upper-cased, no brand and no serial (S5). */
const loanModelPattern = /^[A-Z0-9][A-Z0-9 .,_/-]{0,39}$/;
const caseNumberPattern = /^C-[1-9][0-9]{0,4}-[0-9]{6,12}$/;
const instantPattern = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;

function invalid(): never { throw new Error('Respuesta inválida del servidor.'); }
function decode(raw: string): unknown { try { return parseJSON(raw, null, { onDuplicateKey: invalid }); } catch { return invalid(); } }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof LosslessNumber) return invalid();
  const result = value as Record<string, unknown>;
  if (Object.keys(result).length !== keys.length || keys.some(key => !Object.hasOwn(result, key))) return invalid();
  return result;
}
function integer(value: unknown, min: number, max: number): number {
  if (!(value instanceof LosslessNumber) || !/^(0|[1-9][0-9]*)$/.test(value.toString())) return invalid();
  const parsed = BigInt(value.toString());
  if (parsed < BigInt(min) || parsed > BigInt(max)) return invalid();
  return Number(parsed);
}
function optionalInteger(value: unknown, min: number, max: number): number | null {
  return value === null ? null : integer(value, min, max);
}
function text(value: unknown, blank = false): string {
  if (typeof value !== 'string' || (!blank && !value) || !value.isWellFormed() || value.includes('\0')) return invalid();
  return value;
}
function optionalText(value: unknown, blank = false): string | null {
  return value === null ? null : text(value, blank);
}
function instant(value: unknown): string {
  const moment = text(value);
  if (!instantPattern.test(moment) || !Number.isFinite(Date.parse(moment))) return invalid();
  // A moment the database could not have written reads back as something else, so it is refused.
  if (new Date(Date.parse(moment)).toISOString().slice(0, 19) !== moment.slice(0, 19)) return invalid();
  return moment;
}
function oneOf<T extends string>(values: readonly T[], value: unknown): T {
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) return invalid();
  return value as T;
}
function list<T>(value: unknown, read: (item: unknown) => T, maximum: number): T[] {
  if (!Array.isArray(value) || value.length > maximum) return invalid();
  return value.map(read);
}
function count(value: string): number { return [...value].length; }

// ---------------------------------------------------------------------------------
// The tray: one row per case, the header and nothing else
// ---------------------------------------------------------------------------------

export interface WarrantyCaseRow {
  readonly id: number;
  readonly case_number: string;
  readonly branch_location_id: number;
  readonly origin: WarrantyOrigin;
  readonly phase: WarrantyPhase;
  readonly variant_id: number;
  /** The serial the client brought; stated on a claim and never on a finding. */
  readonly serial_number: string | null;
  /** How many batteries of the shelf failed; stated on a finding and never on a claim. */
  readonly quantity: number | null;
  readonly declared_failure: string;
  /** The motive of the write-off of a finding; never on a claim. */
  readonly reason: string | null;
  readonly created_at: string;
}

const rowKeys = ['id', 'case_number', 'branch_location_id', 'origin', 'phase', 'variant_id',
  'serial_number', 'quantity', 'declared_failure', 'reason', 'created_at'] as const;

function caseRow(value: unknown, keys: readonly string[] = rowKeys): WarrantyCaseRow {
  const row = object(value, keys);
  const origin = oneOf(warrantyOrigins, row.origin);
  const phase = oneOf(warrantyPhases, row.phase);
  const declared = text(row.declared_failure);
  if (count(declared) > warrantyMaxNote) return invalid();
  const serial = optionalText(row.serial_number);
  const quantity = optionalInteger(row.quantity, 1, warrantyMaxQuantity);
  const reason = optionalText(row.reason);
  // Each door publishes its own shape and never the shape of the other (S1, S16).
  if (origin === 'warranty_claim') {
    if (serial === null || count(serial) > warrantyMaxSerial || quantity !== null || reason !== null) return invalid();
  } else if (quantity === null || serial !== null || reason === null || count(reason) > warrantyMaxNote) return invalid();
  const caseNumber = text(row.case_number);
  if (!caseNumberPattern.test(caseNumber)) return invalid();
  return {
    id: integer(row.id, 1, maxID),
    case_number: caseNumber,
    // The warehouse owns no case and is never the branch of one.
    branch_location_id: integer(row.branch_location_id, 2, warrantyMaxLocation),
    origin, phase,
    variant_id: integer(row.variant_id, 1, warrantyMaxVariant),
    serial_number: serial, quantity,
    declared_failure: declared,
    reason,
    created_at: instant(row.created_at),
  };
}

/** The tray is newest first, exactly as the contract orders it. */
export function parseWarrantyTray(raw: string): WarrantyCaseRow[] {
  const value = decode(raw);
  const tray = object(value, ['cases']);
  const rows = list(tray.cases, item => caseRow(item), warrantyMaxListed);
  if (rows.some((row, index) => index > 0 && rows[index - 1].id <= row.id)) return invalid();
  return rows;
}

// ---------------------------------------------------------------------------------
// The case: its header, its loans and its history
// ---------------------------------------------------------------------------------

export interface WarrantyLoan {
  readonly ordinal: number;
  /** The model the loan identifies. A loan is never identified by a serial (S5). */
  readonly model: string;
  readonly quantity: number;
  /** Optional free text nobody keys on; empty when the branch did not write one down. */
  readonly serial_number: string;
  readonly source_location_id: number;
  readonly given_at: string;
  readonly fate: WarrantyLoanFate;
  readonly fate_decided_at: string | null;
  readonly given_by_account_id: number;
}

export interface WarrantyEvent {
  readonly ordinal: number;
  readonly kind: WarrantyEventKind;
  readonly phase: WarrantyPhase;
  /** The file number the Almacén transcribes by hand: stated on the factory shipment only. */
  readonly factory_case_number: string;
  readonly actor_account_id: number;
  readonly recorded_at: string;
  readonly note: string;
}

export interface WarrantyCase extends WarrantyCaseRow {
  readonly verdict: WarrantyVerdict | null;
  readonly reported_destination: WarrantyDestination | null;
  readonly loan_destination: WarrantyDestination | null;
  readonly stock_destination: WarrantyDestination | null;
  readonly sale_id: number | null;
  readonly warranty_number: string | null;
  readonly created_by_account_id: number;
  readonly loans: readonly WarrantyLoan[];
  readonly events: readonly WarrantyEvent[];
}

const caseKeys = [...rowKeys, 'verdict', 'reported_destination', 'loan_destination', 'stock_destination',
  'sale_id', 'warranty_number', 'created_by_account_id', 'loans', 'events'] as const;

function loan(value: unknown): WarrantyLoan {
  const item = object(value, ['ordinal', 'model', 'quantity', 'serial_number', 'source_location_id',
    'given_at', 'fate', 'fate_decided_at', 'given_by_account_id']);
  const model = text(item.model);
  const serial = text(item.serial_number, true);
  const given = instant(item.given_at);
  const fate = oneOf(warrantyLoanFates, item.fate);
  const decided = item.fate_decided_at === null ? null : instant(item.fate_decided_at);
  if (count(model) > warrantyMaxModel || !loanModelPattern.test(model) || count(serial) > warrantyMaxSerial) return invalid();
  // A loan is born open and undated; a decided fate states the instant of its decision, never before.
  if ((fate === 'open') !== (decided === null)) return invalid();
  if (decided !== null && Date.parse(decided) < Date.parse(given)) return invalid();
  return {
    ordinal: integer(item.ordinal, 1, 100),
    model,
    quantity: integer(item.quantity, warrantyMinLoanQuantity, warrantyMaxLoanQuantity),
    serial_number: serial,
    source_location_id: integer(item.source_location_id, 1, warrantyMaxLocation),
    given_at: given, fate, fate_decided_at: decided,
    given_by_account_id: integer(item.given_by_account_id, 1, maxID),
  };
}

function event(value: unknown): WarrantyEvent {
  const item = object(value, ['ordinal', 'kind', 'phase', 'factory_case_number', 'actor_account_id',
    'recorded_at', 'note']);
  const kind = oneOf(warrantyEventKinds, item.kind);
  const phase = oneOf(warrantyPhases, item.phase);
  const file = text(item.factory_case_number, true);
  const note = text(item.note, true);
  if (count(file) > 200 || count(note) > warrantyMaxNote) return invalid();
  // The factory file number travels with the factory shipment and with nothing else (S9, S10).
  if ((kind === 'phase' && phase === 'at_factory') !== (file !== '')) return invalid();
  return {
    ordinal: integer(item.ordinal, 1, 1000), kind, phase,
    factory_case_number: file,
    actor_account_id: integer(item.actor_account_id, 1, maxID),
    recorded_at: instant(item.recorded_at), note,
  };
}

function record(value: unknown): WarrantyCase {
  const row = caseRow(value, caseKeys);
  const item = object(value, caseKeys);
  const verdict = item.verdict === null ? null : oneOf(warrantyVerdicts, item.verdict);
  const reported = item.reported_destination === null ? null : oneOf(warrantyDestinations, item.reported_destination);
  const loanDestination = item.loan_destination === null ? null : oneOf(warrantyDestinations, item.loan_destination);
  const stockDestination = item.stock_destination === null ? null : oneOf(warrantyDestinations, item.stock_destination);
  // The verdict and the destinations are stated at once and the doors state their own units (S11).
  if (verdict === null) {
    if (reported !== null || loanDestination !== null || stockDestination !== null) return invalid();
  } else if (reported === null) return invalid();
  if (row.origin === 'warranty_claim') {
    if (verdict !== null && loanDestination === null) return invalid();
    if (stockDestination !== null) return invalid();
  } else {
    if (loanDestination !== null) return invalid();
    const returns = verdict === 'repaired' || verdict === 'replaced';
    if (returns ? stockDestination !== 'stock' : stockDestination !== null) return invalid();
  }
  const sale = optionalInteger(item.sale_id, 1, maxID);
  const warrantyNumber = optionalText(item.warranty_number);
  if (warrantyNumber !== null && count(warrantyNumber) > 32) return invalid();
  // A claim was sold and a finding never was (S1).
  if (row.origin === 'warranty_claim' ? sale === null : sale !== null || warrantyNumber !== null) return invalid();
  const loans = list(item.loans, loan, 100);
  if (loans.some((entry, index) => entry.ordinal !== index + 1)) return invalid();
  const events = list(item.events, event, 1000);
  if (events.some((entry, index) => index > 0 && events[index - 1].ordinal >= entry.ordinal)) return invalid();
  // The phase of a case is the phase its last event states, so the header and the history can never be
  // published disagreeing (S9, S31). A tramo of the journey enters its phase, a notice carries the phase the
  // case already holds, and the release that sells the unit bound for the branch's shelf states the `closed`
  // it writes, because it is the act that closes that case (073). The server derives this same phase from the
  // same last event and refuses a document where the two disagree, so the screen keeps that one rule.
  const phase = events.reduce<WarrantyPhase>((current, entry) => entry.phase, 'received');
  if (phase !== row.phase) return invalid();
  return {
    ...row, verdict, reported_destination: reported, loan_destination: loanDestination,
    stock_destination: stockDestination, sale_id: sale, warranty_number: warrantyNumber,
    created_by_account_id: integer(item.created_by_account_id, 1, maxID),
    loans, events,
  };
}

export function parseWarrantyCase(raw: string): WarrantyCase { return record(decode(raw)); }
export function parseWarrantyLoan(raw: string): WarrantyLoan { return loan(decode(raw)); }

/**
 * The notification of the section: the cases whose next act is this actor's (S19). It is one
 * decimal string, exactly as Go publishes an int64, and it says nothing about which case it is:
 * the badge is a count, never a record.
 */
export function parseWarrantyPending(raw: string): bigint {
  const value = object(decode(raw), ['action_count']);
  const count = value.action_count;
  if (typeof count !== 'string' || count.length > 19 || !/^(0|[1-9][0-9]*)$/.test(count)) return invalid();
  const parsed = BigInt(count);
  if (parsed > maxInt64) return invalid();
  return parsed;
}

// ---------------------------------------------------------------------------------
// What the screen derives from the published facts, and nothing else
// ---------------------------------------------------------------------------------

const dayMilliseconds = 86_400_000;

/** Whole days between a persisted instant and now. A clock behind the instant never counts backwards. */
export function warrantyDaysSince(instant: string, now: Date): number {
  const then = Date.parse(instant);
  if (!Number.isFinite(then) || !Number.isFinite(now.getTime())) return 0;
  const days = Math.floor((now.getTime() - then) / dayMilliseconds);
  return days > 0 ? days : 0;
}

/** The last time the branch told the client, exactly as the case recorded it (S14). */
export function warrantyNotice(value: WarrantyCase): WarrantyEvent | null {
  return value.events.filter(entry => entry.kind === 'notice').at(-1) ?? null;
}

/** Days since the last notice, or null while the branch has not told the client anything (S15). */
export function warrantyNoticeDays(value: WarrantyCase, now: Date): number | null {
  const notice = warrantyNotice(value);
  return notice === null ? null : warrantyDaysSince(notice.recorded_at, now);
}

/** Whether the warehouse already moved the unit the case held to the branch's sellable stock (S14). */
export function warrantyReleased(value: WarrantyCase): boolean {
  return value.events.some(entry => entry.kind === 'release');
}

/**
 * Whether the release is the act that closed the case, and not the delivery (S31). The release that sells the
 * unit bound for the branch's shelf states the `closed` it writes, and it is the last event of the case: no
 * tramo of the journey states that close, so the phase alone never answers which act ended it.
 */
export function warrantyClosedByRelease(value: WarrantyCase): boolean {
  return value.phase === 'closed' && (value.events.at(-1)?.kind ?? null) === 'release';
}

/**
 * A claim whose usable unit the factory returned for the branch's own shelf (S31): the pair the backend names
 * in `warranty_case_unit_bound_for_stock()` (073). The destination column alone never answers it, and a
 * `not_covered` unit with that same destination is the pool de usadas and not a sellable unit at all (LW025).
 */
export function warrantyUnitBoundForStock(value: WarrantyCase): boolean {
  return value.origin === 'warranty_claim' && value.reported_destination === 'stock'
    && (value.verdict === 'repaired' || value.verdict === 'replaced');
}

/**
 * The units the case holds that are not sellable stock (S13, S31). A claim holds the single unit that came back
 * from the factory while the case waits — the repaired one a client will collect, and the usable one bound for
 * the branch's own shelf — and it stops holding it when the Almacén releases it to stock or when the counter
 * delivers it. A finding holds nothing: its units are the branch's own and came back at its resolution.
 */
export function warrantyCustodyUnits(value: WarrantyCase): number {
  if (value.origin !== 'warranty_claim') return 0;
  if (value.phase !== 'resolved') return 0;
  // S13, S31: one battery came back to the branch and waits in custody — the repaired unit a client will
  // collect, and the usable unit bound for the branch's own shelf, which the release enters into stock.
  if (value.reported_destination !== 'customer' && !warrantyUnitBoundForStock(value)) return 0;
  return warrantyReleased(value) ? 0 : 1;
}

/**
 * The pill of a case in `closed`, decided by the act that closed it and never by the phase alone (S19, S31):
 * the release sold the unit into the branch's sellable stock, the delivery handed the repaired unit to the
 * client, and a finding is closed by its own branch. Every other phase states the phase it holds.
 */
export function warrantyPhaseShortLabel(value: WarrantyCase): string {
  if (value.phase !== 'closed') return warrantyPhaseShortLabels[value.phase];
  if (warrantyClosedByRelease(value)) return 'Cerrada por liberación';
  return value.origin === 'warranty_claim' ? 'Entregada al cliente' : 'Cerrada por la sucursal';
}

/** The notice is the branch's, it happens once and it exists only once the factory answered (S14). */
export function warrantyNoticeAvailable(value: WarrantyCase): boolean {
  return value.origin === 'warranty_claim' && value.phase === 'resolved' && warrantyNotice(value) === null;
}

/** The delivery hands the battery to the client and closes the case, settling every open loan (S4). */
export function warrantyDeliveryAvailable(value: WarrantyCase): boolean {
  return value.origin === 'warranty_claim' && value.phase === 'resolved';
}

/** S4: a claim registers its loan before the case can leave the branch, so a loanless claim waits. */
export function warrantyLoanRegistered(value: WarrantyCase): boolean {
  return value.origin === 'stock_defect' || value.loans.length > 0;
}

/** A case leaves the branch for the warehouse only from `received`, and only with its loan (S4). */
export function warrantyDispatchAvailable(value: WarrantyCase): boolean {
  return value.phase === 'received';
}

/** A finding is closed by its own branch through the `closed` tramo once the factory answered. */
export function warrantyCloseAvailable(value: WarrantyCase): boolean {
  return value.origin === 'stock_defect' && value.phase === 'resolved';
}

/** A used battery is lent while the case is open and before the counter delivers the exchange. */
export function warrantyLendAvailable(value: WarrantyCase): boolean {
  return value.origin === 'warranty_claim' && value.phase !== 'closed';
}

/** The loan receipt needs a handed-over used battery: a finding and a loanless claim have none (S8). */
export function warrantyReceiptAvailable(value: WarrantyCase): boolean {
  return value.origin === 'warranty_claim' && value.loans.length > 0;
}

/** The tone of a phase pill, so colour never carries the meaning alone: the label always says it. */
export type WarrantyTone = 'quiet' | 'wine' | 'ok' | 'warn';
export function warrantyPhaseTone(phase: WarrantyPhase): WarrantyTone {
  if (phase === 'received' || phase === 'resolved') return 'wine';
  if (phase === 'at_warehouse') return 'warn';
  if (phase === 'closed') return 'ok';
  return 'quiet';
}

// ---------------------------------------------------------------------------------
// Paths of the contract, one per route
// ---------------------------------------------------------------------------------

export const warrantyClaimPath = '/api/warranty-cases/claims';
export const warrantyDefectPath = '/api/warranty-cases/stock-defects';
/** The count of cases waiting for the session's own side; one read, no filter and no record. */
export const warrantyPendingPath = '/api/warranty-cases/counts';

export type WarrantyPhaseFilter = WarrantyPhase | 'all';
export type WarrantyOriginFilter = WarrantyOrigin | 'all';
export interface WarrantyTrayFilter {
  readonly phase?: WarrantyPhaseFilter;
  readonly origin?: WarrantyOriginFilter;
}

function caseID(id: number): number {
  if (!Number.isInteger(id) || id < 1 || id > maxID) throw new Error('Caso inválido.');
  return id;
}

/** The two admitted keys of the tray and nothing else; a blank filter is absent, never sent empty. */
export function warrantyTrayPath(filter: WarrantyTrayFilter = {}): string {
  const params = new URLSearchParams();
  if (filter.phase !== undefined && filter.phase !== 'all') {
    if (!warrantyPhases.includes(filter.phase)) throw new Error('Fase inválida.');
    params.set('phase', filter.phase);
  }
  if (filter.origin !== undefined && filter.origin !== 'all') {
    if (!warrantyOrigins.includes(filter.origin)) throw new Error('Origen inválido.');
    params.set('origin', filter.origin);
  }
  const query = params.toString();
  return '/api/warranty-cases' + (query === '' ? '' : '?' + query);
}

export function warrantyCasePath(id: number): string { return `/api/warranty-cases/${caseID(id)}`; }
export function warrantyLoansPath(id: number): string { return `/api/warranty-cases/${caseID(id)}/loans`; }
export function warrantyAdvancePath(id: number): string { return `/api/warranty-cases/${caseID(id)}/advance`; }
export function warrantyNoticePath(id: number): string { return `/api/warranty-cases/${caseID(id)}/notice`; }
export function warrantyDeliveryPath(id: number): string { return `/api/warranty-cases/${caseID(id)}/delivery`; }
export function warrantyLoanFatePath(id: number, ordinal: number): string {
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > 100) throw new Error('Préstamo inválido.');
  return `/api/warranty-cases/${caseID(id)}/loans/${ordinal}/fate`;
}
/** The stable download the contract names for the loan receipt (S8). */
export function warrantyReceiptPath(id: number): string { return `/api/warranty-cases/${caseID(id)}/receipt.pdf`; }

/** The file the database names the receipt after: the persisted case number, never a letter form. */
export function warrantyReceiptFileName(value: Pick<WarrantyCase, 'case_number'>): string {
  return `comprobante-${value.case_number}.pdf`;
}

// ---------------------------------------------------------------------------------
// The bodies of the writes, canonical and frozen before any await
// ---------------------------------------------------------------------------------

export interface WarrantyClaimInput {
  readonly serial_number: string;
  readonly declared_failure: string;
}
export interface WarrantyDefectInput {
  readonly variant_id: number;
  readonly quantity: number;
  readonly declared_failure: string;
  readonly reason: string;
}
export interface WarrantyLoanInput {
  readonly model: string;
  readonly quantity: number;
  readonly serial_number: string;
  readonly source_location_id: number;
}
export interface WarrantyAdvanceInput {
  /** The tramo the contract's edge admits: the branch records the departure and the close, the
   *  warehouse the arrival and the shipment to the factory (S9, S19). */
  readonly phase: 'in_transit' | 'at_warehouse' | 'at_factory' | 'closed';
  readonly factory_case_number: string;
  readonly note: string;
}
export interface WarrantyDeliveryInput {
  readonly loan_fate: WarrantyDeliveryFate;
  readonly note: string;
}

/** The serial the client brought: trimmed, non-empty and inside the database's bound (S2). */
export function canonicalClaimSerial(value: string): string {
  const serial = value.trim();
  if (serial === '' || count(serial) > warrantyMaxSerial || !serial.isWellFormed() || serial.includes('\0')) {
    throw new Error(`El número de serie es obligatorio, de hasta ${warrantyMaxSerial} caracteres.`);
  }
  return serial;
}
/** What failed, in the words of whoever registered the case. */
export function canonicalDeclaration(value: string): string {
  const declaration = value.trim();
  if (declaration === '' || count(declaration) > warrantyMaxNote || !declaration.isWellFormed()
    || declaration.includes('\0')) {
    throw new Error(`Contá qué falló, de 1 a ${warrantyMaxNote} caracteres.`);
  }
  return declaration;
}
/** The model of a used battery is trimmed and upper-cased, and it never carries a serial (S5). */
export function canonicalLoanModel(value: string): string {
  const model = value.trim().toUpperCase();
  if (!loanModelPattern.test(model)) {
    throw new Error('El modelo de la usada va sin marca ni serie: hasta 40 caracteres, letras, números y . , _ / -');
  }
  return model;
}
/** The serial of a used battery is optional free text: an empty one is a stated answer (S5). */
export function canonicalLoanSerial(value: string): string {
  const serial = value.trim();
  if (count(serial) > warrantyMaxSerial || !serial.isWellFormed() || serial.includes('\0')) {
    throw new Error(`El serial de la usada es opcional, de hasta ${warrantyMaxSerial} caracteres.`);
  }
  return serial;
}
function wholeNumber(value: unknown, minimum: number, maximum: number, message: string): number {
  const parsed = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(message);
  return parsed;
}
function sourceLocation(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > warrantyMaxLocation) {
    throw new Error('Elegí de dónde sale la usada: la sucursal, el Almacén u otra sucursal.');
  }
  return value;
}
function note(value: string): string {
  const words = value.trim();
  if (words === '' || count(words) > warrantyMaxNote || !words.isWellFormed() || words.includes('\0')) {
    throw new Error(`Escribí el motivo, de 1 a ${warrantyMaxNote} caracteres.`);
  }
  return words;
}

/** The first door: the serial and what failed, and nothing else (S1). */
export function canonicalClaimBody(serial: string, declaredFailure: string): WarrantyClaimInput {
  return Object.freeze({ serial_number: canonicalClaimSerial(serial),
    declared_failure: canonicalDeclaration(declaredFailure) });
}

/** The second door: the shelf, its quantity, what failed and the motive of the write-off (S16). */
export function canonicalDefectBody(variantID: number, quantity: unknown, declaredFailure: string,
  reason: string): WarrantyDefectInput {
  if (!Number.isInteger(variantID) || variantID < 1 || variantID > warrantyMaxVariant) {
    throw new Error('Elegí la batería que falló en la góndola.');
  }
  if (reason.trim() === '') throw new Error('La baja de stock exige el motivo por el que se saca de la sucursal.');
  return Object.freeze({
    variant_id: variantID,
    quantity: wholeNumber(quantity, 1, warrantyMaxQuantity,
      `La cantidad es un número entero de 1 a ${warrantyMaxQuantity}.`),
    declared_failure: canonicalDeclaration(declaredFailure),
    reason: note(reason),
  });
}

/** One loan: model, quantity, the optional serial and where the used battery came from (S5, S6). */
export function canonicalLoanBody(model: string, quantity: unknown, serial: string,
  sourceLocationID: number): WarrantyLoanInput {
  return Object.freeze({
    model: canonicalLoanModel(model),
    quantity: wholeNumber(quantity, warrantyMinLoanQuantity, warrantyMaxLoanQuantity,
      `La cantidad prestada es un número entero de ${warrantyMinLoanQuantity} a ${warrantyMaxLoanQuantity}.`),
    serial_number: canonicalLoanSerial(serial),
    source_location_id: sourceLocation(sourceLocationID),
  });
}

/** A tramo of the branch's own journey: the shipment to the warehouse or the close of a finding. */
export function canonicalAdvanceBody(phase: 'in_transit' | 'closed', noteText: string): WarrantyAdvanceInput {
  return Object.freeze({ phase, factory_case_number: '', note: note(noteText) });
}

/** The delivery settles every open loan with the fate the counter states (S4). */
export function canonicalDeliveryBody(fate: WarrantyDeliveryFate, noteText: string): WarrantyDeliveryInput {
  if (!warrantyDeliveryFates.includes(fate)) {
    throw new Error('Elegí qué pasó con la usada: volvió al local o se la quedó el cliente.');
  }
  return Object.freeze({ loan_fate: fate, note: note(noteText) });
}

/** What became of one lent battery. A fate once stated is final and the failed one is replaced (S7). */
export function canonicalLoanFateBody(fate: WarrantyLoanFate): { readonly fate: WarrantyLoanFateStated } {
  if (!warrantyLoanFatesStated.includes(fate as WarrantyLoanFateStated)) {
    throw new Error('Elegí qué pasó con la usada: volvió, se la quedó el cliente, falló o se perdió.');
  }
  return Object.freeze({ fate: fate as WarrantyLoanFateStated });
}

/** The notice states that the client was told; the body carries its words and nothing else (S14). */
export function canonicalNoticeBody(noteText: string): { readonly note: string } {
  return Object.freeze({ note: note(noteText) });
}
