/**
 * Branch account settlement (rendición de cuentas) from the warehouse's side: the count sheet
 * of one settlement and the drawer the warehouse states, in exact cents end to end.
 *
 * The database is the authority of this vertical: the expected quantity of every line is the
 * snapshot taken at the cut and is never recalculated here, the drawer's derived numbers follow
 * their own identities and the commission is reported beside them — it is inside no cash
 * identity (S9) and the electronic collection is never added to the till (S13).
 */
import { validSearch } from './model';
import { centsToMoney, formatMoney, moneyCents, parseTypedMoney, typedMoney } from './pointOfSaleModel';

// ---------------------------------------------------------------------------------
// Bounds and vocabulary
// ---------------------------------------------------------------------------------

/** The act and the document are always the rendición de cuentas: the old name appears nowhere. */
export const closingTitle = 'Rendición de cuentas';
export const closingSectionTitle = 'Rendiciones';
export const closingMaxCountLines = 190;
export const closingMaxCounted = 1_000_000;
export const closingMaxObservation = 1000;
export const closingMaxID = 2_147_483_647;
export const closingFirstBranch = 2;
export const closingMaxBranch = 32767;
export const closingMaxPage = 1_000_000;
export const closingPageSizes: readonly number[] = [10, 25, 50];
export const closingDefaultPageSize = 25;

export type ClosingStatus = 'open' | 'proposed' | 'rejected' | 'closed';
export const closingStatuses: readonly ClosingStatus[] = ['open', 'proposed', 'rejected', 'closed'];

export const closingStatusLabels: Readonly<Record<ClosingStatus, string>> = Object.freeze({
  open: 'Abierta',
  proposed: 'Propuesta a la sucursal',
  rejected: 'Devuelta por la sucursal',
  closed: 'Cerrada',
});

/** A settlement that is not closed holds its branch: it can neither sell nor receive stock (S3). */
export function closingIsLive(status: ClosingStatus): boolean {
  return status !== 'closed';
}

/** The count sheet and the drawer are written only while the warehouse holds the settlement. */
export function closingIsEditable(status: ClosingStatus): boolean {
  return status === 'open' || status === 'rejected';
}

// ---------------------------------------------------------------------------------
// The document, as the warehouse reads it
// ---------------------------------------------------------------------------------

export type ClosingPolarity = 'L' | 'R';

/** One line of the sheet: the snapshot the database took at the cut and what was counted. */
export interface ClosingCountLine {
  readonly variant_id: number;
  readonly catalog_entry_id: number;
  readonly brand: string;
  readonly model: string;
  readonly capacity_ah: string;
  readonly polarity: ClosingPolarity;
  /** Frozen at the cut and never recalculated: the sheet stays a fact of the opening (S4). */
  readonly expected_quantity: number;
  /** `null` while the variant is pending, which is what blocks the proposal and the closure. */
  readonly counted_quantity: number | null;
}

/** One line of a stored offer: both sides are stated, because the branch accepts that arithmetic. */
export interface ClosingOfferLine {
  readonly variant_id: number;
  readonly expected_quantity: number;
  readonly counted_quantity: number;
}

/** The offer of one round, frozen verbatim at proposal. */
export interface ClosingOffer {
  readonly period_start: string;
  readonly cut_at: string;
  readonly sales_total_cents: bigint;
  readonly commission_rate_percent: string;
  readonly commission_amount_cents: bigint;
  readonly cash_sales_cents: bigint;
  readonly cash_expenses_cents: bigint;
  readonly card_total_cents: bigint;
  readonly transfer_total_cents: bigint;
  readonly qr_total_cents: bigint;
  readonly counted_cash_cents: bigint;
  readonly contributed_cash_cents: bigint;
  readonly closing_cash_cents: bigint;
  readonly observation: string;
  readonly count_lines: readonly ClosingOfferLine[];
}

export type ClosingDecision = '' | 'accepted' | 'rejected';

/** One proposal round with the branch's answer, if it has one. */
export interface ClosingRound {
  readonly id: number;
  readonly round: number;
  readonly offer: ClosingOffer;
  readonly proposed_by_account_id: number;
  readonly proposed_at: string;
  readonly decision: ClosingDecision;
  readonly decision_reason: string;
  readonly decided_by_account_id: number | null;
  readonly decided_at: string | null;
}

/**
 * One settlement. The drawer's derived numbers are not stored: `expected`, the difference and
 * what the warehouse takes follow from the facts below, on every read of every screen.
 */
export interface Closing {
  readonly id: number;
  readonly branch_location_id: number;
  readonly branch_name: string;
  readonly status: ClosingStatus;
  readonly period_start: string;
  readonly cut_at: string;
  readonly closed_at: string | null;
  /** The frozen rate; `null` while the settlement is still open (S6). */
  readonly commission_rate_percent: string | null;
  readonly opening_cash_cents: bigint;
  readonly cash_sales_cents: bigint;
  readonly cash_expenses_cents: bigint;
  readonly counted_cash_cents: bigint | null;
  readonly contributed_cash_cents: bigint;
  readonly closing_cash_cents: bigint | null;
  readonly sales_total_cents: bigint;
  readonly commission_amount_cents: bigint;
  readonly card_total_cents: bigint;
  readonly transfer_total_cents: bigint;
  readonly qr_total_cents: bigint;
  readonly observation: string;
  readonly opened_by_account_id: number;
  readonly count_lines: readonly ClosingCountLine[];
  readonly rounds: readonly ClosingRound[];
}

/** One newest-first page of one branch's settlements: each row is the same document. */
export interface ClosingPage {
  readonly page: number;
  readonly page_size: number;
  readonly total_closings: number;
  readonly closings: readonly Closing[];
}

// ---------------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------------

const signedMoneyShape = /^-?(0|[1-9]\d{0,9})\.\d{2}$/;

export const closingAmountMessage = 'Escribí un monto válido, con hasta dos decimales.';

function invalidMoney(): never { throw new Error(closingAmountMessage); }

/** Exact cents of a published amount: canonical two-decimal text, never a float. */
export function closingCents(amount: string): bigint {
  try { return moneyCents(amount); } catch { return invalidMoney(); }
}

/** Exact cents of a derived amount, which carries its sign: `"-35.00"` is a shortage. */
export function closingSignedCents(amount: string): bigint {
  if (typeof amount !== 'string' || !signedMoneyShape.test(amount)) return invalidMoney();
  const negative = amount.startsWith('-');
  const cents = closingCents(negative ? amount.slice(1) : amount);
  if (negative && cents === 0n) return invalidMoney();
  return negative ? -cents : cents;
}

/** A derived amount with its sign, the way the rail names a difference: `− Bs 35,00`. */
export function closingSignedText(cents: bigint): string {
  if (cents < 0n) return `− ${formatMoney(-cents)}`;
  if (cents > 0n) return `+ ${formatMoney(cents)}`;
  return formatMoney(0n);
}

/** A published amount that is never negative: the expected drawer, the fund, what is taken. */
export function closingMoneyText(cents: bigint): string {
  return formatMoney(cents);
}

/** The name of a difference, never only its sign (S8). */
export function closingDifferenceName(cents: bigint): string {
  if (cents < 0n) return 'Faltante';
  if (cents > 0n) return 'Sobrante';
  return 'Sin diferencia';
}

/** The frozen percentage, read the way the branch's rate is written: `4,50 %`. */
export function closingRateText(rate: string | null): string {
  if (rate === null) return 'Se congela al proponer';
  return `${rate.replace('.', ',')} %`;
}

// ---------------------------------------------------------------------------------
// The rail: the drawer's identities
// ---------------------------------------------------------------------------------

/**
 * The numbers the warehouse keeps in sight while counting. The commission and the electronic
 * collection are reported beside the drawer and are part of none of the identities below (S9,
 * S13); the settlement is the only place a cash figure comes from.
 */
export interface ClosingRail {
  readonly opening_cents: bigint;
  readonly cash_sales_cents: bigint;
  readonly cash_expenses_cents: bigint;
  readonly expected_cents: bigint;
  readonly counted_cents: bigint | null;
  readonly difference_cents: bigint | null;
  readonly contribution_cents: bigint;
  readonly fund_cents: bigint | null;
  readonly taken_cents: bigint | null;
  readonly rate_percent: string | null;
  readonly sales_total_cents: bigint;
  readonly commission_cents: bigint;
  readonly card_cents: bigint;
  readonly transfer_cents: bigint;
  readonly qr_cents: bigint;
}

/** `expected = opening + cash sales − cash expenses`, computed once, over the settled facts. */
export function closingRail(closing: Closing): ClosingRail {
  const expected_cents = closing.opening_cash_cents + closing.cash_sales_cents
    - closing.cash_expenses_cents;
  const difference_cents = closing.counted_cash_cents === null
    ? null : closing.counted_cash_cents - expected_cents;
  const taken_cents = closing.counted_cash_cents === null || closing.closing_cash_cents === null
    ? null : closing.counted_cash_cents + closing.contributed_cash_cents - closing.closing_cash_cents;
  return Object.freeze({
    opening_cents: closing.opening_cash_cents,
    cash_sales_cents: closing.cash_sales_cents,
    cash_expenses_cents: closing.cash_expenses_cents,
    expected_cents,
    counted_cents: closing.counted_cash_cents,
    difference_cents,
    contribution_cents: closing.contributed_cash_cents,
    fund_cents: closing.closing_cash_cents,
    taken_cents,
    rate_percent: closing.commission_rate_percent,
    sales_total_cents: closing.sales_total_cents,
    commission_cents: closing.commission_amount_cents,
    card_cents: closing.card_total_cents,
    transfer_cents: closing.transfer_total_cents,
    qr_cents: closing.qr_total_cents,
  });
}

// ---------------------------------------------------------------------------------
// The drawer draft the warehouse states
// ---------------------------------------------------------------------------------

/** What the warehouse typed: two amounts and the observation, before they are canonical. */
export interface DrawerDraft {
  readonly counted: string;
  readonly fund: string;
  readonly observation: string;
}

export const emptyDrawerDraft: DrawerDraft = Object.freeze({ counted: '', fund: '', observation: '' });

/** The draft the settlement already holds, so a reload of the screen restores the admin's work. */
export function drawerDraftFrom(closing: Closing): DrawerDraft {
  return Object.freeze({
    counted: closing.counted_cash_cents === null ? '' : typedMoney(closing.counted_cash_cents),
    fund: closing.closing_cash_cents === null ? '' : typedMoney(closing.closing_cash_cents),
    observation: closing.observation,
  });
}

/** The drawer as the rail shows it while the warehouse types, before anything is saved. */
export interface DrawerView {
  readonly counted_cents: bigint | null;
  readonly fund_cents: bigint | null;
  readonly contribution_cents: bigint;
  readonly expected_cents: bigint;
  readonly difference_cents: bigint | null;
  readonly taken_cents: bigint | null;
  /** The amount the fund exceeds the drawer by, or `null` when the fund fits (S10). */
  readonly excess_cents: bigint | null;
  readonly problem: string;
}

function typedCents(text: string): bigint | null {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (trimmed === '') return null;
  try { return parseTypedMoney(trimmed); } catch { return invalidMoney(); }
}

/** The drawer over the facts the settlement carries: the commission is not one of them. */
export function drawerView(rail: ClosingRail, draft: DrawerDraft): DrawerView {
  let counted_cents: bigint | null = null;
  let fund_cents: bigint | null = null;
  let problem = '';
  try { counted_cents = typedCents(draft.counted); } catch { problem = closingAmountMessage; }
  try { fund_cents = typedCents(draft.fund); } catch { problem = closingAmountMessage; }
  if (problem !== '') { counted_cents = null; fund_cents = null; }
  const difference_cents = counted_cents === null ? null : counted_cents - rail.expected_cents;
  // The fund never exceeds the drawer plus the contribution, which is what makes the first
  // settlement possible with an empty till (S10, S11).
  const excess_cents = counted_cents !== null && fund_cents !== null
    && fund_cents > counted_cents + rail.contribution_cents
    ? fund_cents - counted_cents - rail.contribution_cents : null;
  // What the warehouse takes out of the till is stated only for a drawer it can take from: a
  // fund above the drawer is a draft that is not an offer yet, and the excess names it.
  const taken_cents = counted_cents === null || fund_cents === null || excess_cents !== null
    ? null : counted_cents + rail.contribution_cents - fund_cents;
  return Object.freeze({
    counted_cents, fund_cents, contribution_cents: rail.contribution_cents,
    expected_cents: rail.expected_cents, difference_cents, taken_cents, excess_cents, problem,
  });
}

/** The exact body of `POST /api/closings/{id}/cash`: four keys, absent amounts as `null`. */
export interface DrawerPayload {
  readonly counted_cash: string | null;
  readonly contributed_cash: string;
  readonly closing_cash: string | null;
  readonly observation: string;
}

export const closingObservationMessage = `La observación lleva hasta ${closingMaxObservation} caracteres.`;

/**
 * Canonicalizes the drawer the way the contract takes it: an amount the warehouse has not
 * counted is the explicit `null`, and the contribution is the settled fact of the settlement,
 * never a number this screen invents.
 */
export function canonicalDrawerPayload(draft: DrawerDraft, contributionCents: bigint): DrawerPayload {
  if (typeof contributionCents !== 'bigint' || contributionCents < 0n) return invalidMoney();
  let counted_cash: string | null;
  let closing_cash: string | null;
  try {
    const counted = typedCents(draft.counted);
    const fund = typedCents(draft.fund);
    counted_cash = counted === null ? null : centsToMoney(counted);
    closing_cash = fund === null ? null : centsToMoney(fund);
  } catch { return invalidMoney(); }
  const observation = draft.observation;
  if (typeof observation !== 'string' || observation.includes('\0') || !observation.isWellFormed()
    || Array.from(observation).length > closingMaxObservation) {
    throw new Error(closingObservationMessage);
  }
  return Object.freeze({
    counted_cash, contributed_cash: centsToMoney(contributionCents), closing_cash, observation,
  });
}

// ---------------------------------------------------------------------------------
// The count sheet
// ---------------------------------------------------------------------------------

export const closingQuantityMessage =
  `La cantidad contada debe ser un número entero de 0 a ${closingMaxCounted}.`;
export const closingCountEmptyMessage = 'Contá al menos una variante antes de guardar.';
export const closingCountLimitMessage = `Un conteo lleva como máximo ${closingMaxCountLines} variantes.`;
export const closingSearchMessage = 'La búsqueda admite hasta 128 bytes UTF-8, sin caracteres inválidos.';

/** `TOYO NS40ZL L`: the label a row, a blocker and a refusal share. */
export function closingLineLabel(line: ClosingCountLine): string {
  return `${line.brand} ${line.model} ${line.polarity} · ${line.capacity_ah} Ah`;
}

export function closingPendingLines(lines: readonly ClosingCountLine[]): readonly ClosingCountLine[] {
  return lines.filter(line => line.counted_quantity === null);
}

export interface ClosingProgress {
  readonly total: number;
  readonly counted: number;
  readonly pending: number;
}

/** `9 de 11 contadas`: the progress of the sheet over every variant the branch held at the cut. */
export function closingProgress(lines: readonly ClosingCountLine[]): ClosingProgress {
  const total = lines.length;
  const pending = closingPendingLines(lines).length;
  return Object.freeze({ total, counted: total - pending, pending });
}

/** The difference of one row, with its sign; `null` while the row is pending. */
export function closingLineDifference(line: ClosingCountLine): number | null {
  if (line.counted_quantity === null) return null;
  return line.counted_quantity - line.expected_quantity;
}

/** A counted difference is shown with its sign, and a match is shown as a dash, not zero. */
export function closingQuantityText(value: number | null): string {
  if (value === null || value === 0) return '—';
  if (value > 0) return `+${value}`;
  return `−${-value}`;
}

/** The pending row is visibly pending, in words, and not only through a colour. */
export const closingPendingTag = 'Pendiente';

/** The search of the sheet: the sheet is already here, so the filter never asks the server. */
export function filterCountLines(lines: readonly ClosingCountLine[], search: string): readonly ClosingCountLine[] {
  if (typeof search !== 'string' || !validSearch(search)) throw new Error(closingSearchMessage);
  const needle = search.trim().toLocaleLowerCase('es');
  if (needle === '') return lines;
  return lines.filter(line => {
    const haystack = `${line.brand} ${line.model} ${line.capacity_ah} ${line.polarity} ${line.variant_id}`
      .toLocaleLowerCase('es');
    return haystack.includes(needle);
  });
}

/** One counted line the warehouse is about to save. */
export interface CountedLineInput {
  readonly variant_id: number;
  readonly counted: string;
}

export interface CountPayloadLine { readonly variant_id: number; readonly counted_quantity: number }

/**
 * Admits what the warehouse counted: only a whole quantity per variant, inside the sheet's own
 * bounds. The expected quantity and the difference cannot be expressed here at all (S4).
 */
export function canonicalCountPayload(input: readonly CountedLineInput[]): readonly CountPayloadLine[] {
  if (!Array.isArray(input) || input.length === 0) throw new Error(closingCountEmptyMessage);
  if (input.length > closingMaxCountLines) throw new Error(closingCountLimitMessage);
  const seen = new Set<number>();
  return Object.freeze(input.map(line => {
    const variant = line.variant_id;
    if (!Number.isInteger(variant) || variant < 1 || variant > closingMaxID || seen.has(variant)) {
      throw new Error(closingQuantityMessage);
    }
    seen.add(variant);
    const raw = typeof line.counted === 'string' ? line.counted.trim() : '';
    if (!/^(0|[1-9]\d{0,6})$/.test(raw) || Number(raw) > closingMaxCounted) {
      throw new Error(closingQuantityMessage);
    }
    return Object.freeze({ variant_id: variant, counted_quantity: Number(raw) });
  }));
}

/** One request takes at most 190 lines: a longer sheet is saved in order, batch by batch. */
export function closingCountBatches(
  lines: readonly CountPayloadLine[]): readonly (readonly CountPayloadLine[])[] {
  const batches: CountPayloadLine[][] = [];
  for (let index = 0; index < lines.length; index += closingMaxCountLines) {
    batches.push(lines.slice(index, index + closingMaxCountLines));
  }
  return Object.freeze(batches.map(batch => Object.freeze(batch)));
}

// ---------------------------------------------------------------------------------
// Why the offer cannot be made yet
// ---------------------------------------------------------------------------------

export interface ClosingBlocker { readonly code: string; readonly message: string }

const listedNames = 4;

function pendingBlocker(lines: readonly ClosingCountLine[]): ClosingBlocker {
  const names = lines.map(closingLineLabel);
  const listed = names.slice(0, listedNames).join(', ');
  const rest = names.length > listedNames ? ` y ${names.length - listedNames} más` : '';
  return Object.freeze({
    code: 'count_pending',
    message: `Faltan ${names.length} ${names.length === 1 ? 'variante' : 'variantes'} por contar: ${listed}${rest}.`,
  });
}

/**
 * What still blocks the proposal, in the order the warehouse can act on it. Every blocker is a
 * fact of the settlement it already holds or of the draft it typed; the refusal itself is the
 * server's, and this list never replaces it.
 */
export function closingBlockers(closing: Closing, view: DrawerView,
  unsaved = false): readonly ClosingBlocker[] {
  if (!closingIsEditable(closing.status)) {
    return Object.freeze([Object.freeze({
      code: closing.status === 'proposed' ? 'state_conflict' : 'closed',
      message: closing.status === 'proposed'
        ? 'La propuesta espera la decisión de la sucursal: no se puede proponer otra vez.'
        : 'La rendición está cerrada: no se puede proponer ni editar.',
    })]);
  }
  const blockers: ClosingBlocker[] = [];
  const pending = closingPendingLines(closing.count_lines);
  if (pending.length > 0) blockers.push(pendingBlocker(pending));
  if (view.problem !== '') {
    blockers.push(Object.freeze({ code: 'invalid_amount', message: view.problem }));
  }
  const missing: string[] = [];
  if (view.counted_cents === null) missing.push('la caja contada');
  if (view.fund_cents === null) missing.push('el fondo que queda en la caja');
  // An amount that cannot be read is already named above; it is not also reported as absent.
  if (missing.length > 0 && view.problem === '') {
    blockers.push(Object.freeze({
      code: 'cash_not_stated',
      message: `Falta ${missing.join(' y ')}: el cierre no puede proponerse sin eso.`,
    }));
  }
  if (view.excess_cents !== null) {
    blockers.push(Object.freeze({
      code: 'fund_exceeds_drawer',
      message: `El fondo supera la caja contada más el aporte en ${formatMoney(view.excess_cents)}.`,
    }));
  }
  if (unsaved) {
    blockers.push(Object.freeze({
      code: 'unsaved',
      message: 'Hay cambios sin guardar: guardá el borrador antes de proponer.',
    }));
  }
  return Object.freeze(blockers);
}

/** The state of the sheet and the drawer as the action bar announces it. */
export function closingBlockReason(blockers: readonly ClosingBlocker[]): string {
  if (blockers.length === 0) return 'La rendición se puede proponer: el conteo cubre toda variante con existencia y la caja está contada.';
  return blockers.map(blocker => blocker.message).join(' ');
}

// ---------------------------------------------------------------------------------
// The period: always the range between two rendiciones (S1)
// ---------------------------------------------------------------------------------

export interface ClosingPeriod { readonly from: string; readonly to: string; readonly empty: boolean }

const periodFormat = new Intl.DateTimeFormat('es-BO', {
  timeZone: 'America/La_Paz', day: '2-digit', month: 'short', year: 'numeric',
});

function periodDate(value: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return 'Fecha no disponible';
  return periodFormat.format(new Date(value));
}

/** `23 feb 2026 → 23 mar 2026`; a bootstrap settlement starts and cuts at the same instant. */
export function closingPeriod(periodStart: string, cutAt: string): ClosingPeriod {
  return Object.freeze({
    from: periodDate(periodStart),
    to: periodDate(cutAt),
    empty: periodStart === cutAt,
  });
}

export function closingPeriodLabel(period: ClosingPeriod): string {
  return `${period.from} → ${period.to}`;
}
