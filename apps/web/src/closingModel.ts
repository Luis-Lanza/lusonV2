/**
 * Branch account settlement (rendición de cuentas) from the warehouse's side: the count sheet
 * of one settlement and the drawer the warehouse states, in exact cents end to end.
 *
 * The database is the authority of this vertical: the expected quantity of every line is the
 * snapshot taken at the cut and is never recalculated here, the drawer's derived numbers follow
 * their own identities and the commission is reported beside them — it is inside no cash
 * identity (S9) and the electronic collection is never added to the till (S13).
 *
 * The drawer states three amounts: the cash counted, the contribution the warehouse puts into
 * the till for this settlement and the fund left behind. The fund never exceeds the counted cash
 * plus the contribution, which is what lets the first settlement of a branch leave money in an
 * empty till (S10, S11, L13); the contribution is money put in and never money collected, so it
 * is in no sale and in no commission.
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

/**
 * The identity of a battery variant: the four attributes the catalogue publishes of one. A line of a
 * battery states exactly these and never the identity of the other kind (S3).
 */
export interface ClosingBatteryIdentity {
  readonly brand: string;
  readonly model: string;
  readonly capacity_ah: string;
  readonly polarity: ClosingPolarity;
}

/**
 * The identity of an other product: the name it is sold by and the detail the catalogue composes of
 * its typed fields. A line of a product states these and no battery attribute (S3).
 */
export interface ClosingProductIdentity {
  readonly name: string;
  readonly detail: string;
}

/** The two keys every row of the sheet shares, whatever its kind. */
export interface ClosingLineKey {
  readonly variant_id: number;
  readonly catalog_entry_id: number;
}

/**
 * Whether a row names a battery. The wire states the identity of the one kind a row has and omits the
 * other kind's attributes altogether, so presence is the only discriminant and no field is invented
 * for a row that does not carry it (S3).
 */
export function closingIsBatteryLine(
  line: ClosingBatteryIdentity | ClosingProductIdentity): line is ClosingBatteryIdentity {
  return 'brand' in line;
}

/** One battery line of the sheet, with its four battery attributes. */
export type ClosingBatteryLine = ClosingLineKey & ClosingBatteryIdentity & {
  /** Frozen at the cut and never recalculated: the sheet stays a fact of the opening (S4). */
  readonly expected_quantity: number;
  readonly counted_quantity: number | null;
};

/** One product line of the sheet, with its name and detail and no battery attribute. */
export type ClosingProductLine = ClosingLineKey & ClosingProductIdentity & {
  readonly expected_quantity: number;
  readonly counted_quantity: number | null;
};

/**
 * One line of the sheet: the identity of its one kind, the snapshot the database took at the cut and
 * what was counted. The sheet counts the whole catalogue, so a battery row and a product row live in
 * the same sheet (S2, S3).
 */
export type ClosingCountLine = ClosingBatteryLine | ClosingProductLine;

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
  /**
   * The envelope of the offer (S1, S5, S6): what the warehouse counted in the purchase fund and the
   * amount it leaves there for the next period. Both are `null` in an offer made before the warehouse
   * stated the envelope, and the contract omits them entirely in that case.
   */
  readonly purchase_fund_counted_cents: bigint | null;
  readonly purchase_fund_cash_cents: bigint | null;
  readonly observation: string;
  readonly count_lines: readonly ClosingOfferLine[];
}

export type ClosingDecision = '' | 'accepted' | 'rejected';

/**
 * One expense of the settled window as the acta publishes it (S8, S13): the amount the branch paid out,
 * the motive it was recorded with and the copy of the label that motive had, and the note beside it.
 * `motive` is `null` on a row that names none — the correction of an expense and every row recorded
 * before the closed list existed — and on those rows `note` is the text the row itself states, which is
 * the only reason it ever had (S7).
 */
export interface ClosingExpense {
  readonly id: number;
  readonly kind: 'gasto' | 'correccion';
  readonly amount_cents: bigint;
  readonly motive: string | null;
  readonly note: string;
  readonly corrects_id: number | null;
}

/**
 * The reason one row of the acta states, in the operator's words (S8): the motive the expense was
 * recorded with and, on a row recorded before the closed list existed, its own free text.
 */
export function closingExpenseMotive(expense: ClosingExpense): string {
  return expense.motive ?? expense.note;
}

/**
 * The clarification beside the motive, or `null` when the row states none (S3): an expense may be
 * recorded without a note, and a historical row already says its reason in that same text, so it is
 * never read twice.
 */
export function closingExpenseNote(expense: ClosingExpense): string | null {
  return expense.motive === null || expense.note === '' ? null : expense.note;
}

/**
 * What the row does to the drawer: a pay-out takes the money out and the correction that answers it
 * puts it back, which is the direction of its kind and never a sign the row stores (S13).
 */
export function closingExpenseEffect(expense: ClosingExpense): bigint {
  return expense.kind === 'gasto' ? -expense.amount_cents : expense.amount_cents;
}

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
  /**
   * The signed effect of every movement the branch wrote inside this window — its aportes, its
   * recaudaciones, its gastos and the corrections of them — as the server publishes it (S4, S13). It is
   * the third term of the drawer's expectation, so this screen adds it instead of subtracting the net
   * expense a second time.
   */
  readonly cash_effective_cents: bigint;
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
  /**
   * The third account (S7, S8, S9): what the period bought of every used model and every scrap
   * material, what the warehouse counted, the difference and what goes to the warehouse. `null` is
   * a payload that publishes no sheet at all — an older document — and `[]` is a period that bought
   * no materials, which is a truth of its own and never a missing key.
   */
  readonly material_lines: readonly ClosingMaterialLine[] | null;
  readonly rounds: readonly ClosingRound[];
  /**
   * The expenses of the window, oldest first, with the corrections of those expenses among them: the
   * ledger the `cash_expenses_cents` beside them was computed from, each row with the motive it was
   * recorded with and the copy of that motive's label (S8, S13).
   */
  readonly expenses: readonly ClosingExpense[];
  /**
   * The branch's second envelope, or `null` when the payload does not publish it (S1, S5, S6).
   */
  readonly purchase_fund: ClosingPurchaseFund | null;
  /**
   * The corrections of this settlement, oldest first: the accepted ones with the deltas they applied
   * and, when there is one, the correction that still waits for the branch's decision. A live
   * settlement carries none — it is corrected by its own rounds — and a rejected one applied nothing,
   * so it is never published (S16).
   */
  readonly corrections: readonly ClosingCorrection[];
}

/** One newest-first page of one branch's settlements: each row is the same document. */
export interface ClosingPage {
  readonly page: number;
  readonly page_size: number;
  readonly total_closings: number;
  readonly closings: readonly Closing[];
}

/**
 * The branch's purchase fund, its second envelope (S1, S2): the money it keeps apart from the
 * operating drawer to buy used batteries and scrap. The inherited balance, the purchases of the
 * window and the expectation are derived by the server on every read; the count and the amount it
 * leaves are the warehouse's drafts, frozen by the proposal. None of these amounts enters the
 * drawer's identities nor the commission, and no money of a sale feeds the envelope (S12).
 */
export interface ClosingPurchaseFund {
  /** What the previous closure left in the envelope; `0.00` when there is none (S5, S6). It is money
   * the branch holds, so it is never negative. */
  readonly opening_cents: bigint;
  /**
   * The purchases of the window, counter-documents included, so they already subtract (S11). A net
   * sum that keeps its sign: a counter-document of an earlier purchase leaves it negative.
   */
  readonly purchases_total_cents: bigint;
  /** The cash of those purchases, with the same sign and for the same reason (S3, S11). */
  readonly purchases_cash_cents: bigint;
  /** `opening − purchases paid in cash`, signed: a period that spent more than it had is short. */
  readonly expected_cents: bigint;
  readonly counted_cents: bigint | null;
  readonly difference_cents: bigint | null;
  /**
   * The amount the warehouse leaves in the envelope (`purchase_fund_cash`): the "monto nuevo" that
   * opens the next period. It is not bounded by the count — the warehouse brings money from outside
   * the branch, so it may leave more than it found (S5, S6).
   */
  readonly new_cents: bigint | null;
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

/**
 * A published amount rendered as it is. Most of them are never negative, but the second envelope is
 * the exception the sign exists for: its purchases are a net sum that a counter-document can leave
 * negative and its expectation is negative whenever the envelope spent more than it inherited, so
 * both are shown with their sign instead of failing to render a settlement the server published
 * (S3, S11).
 */
export function closingMoneyText(cents: bigint): string {
  return cents < 0n ? closingSignedText(cents) : formatMoney(cents);
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
  /** The signed effect of the window's movements: the third term of the expectation (S4, S13). */
  readonly cash_effective_cents: bigint;
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

/**
 * `expected = opening + cash sales + the signed effect of the window`: the server's own rule, applied
 * here to the numbers it published and to nothing else. The net `cash_expenses` of the document is
 * already one term of that effect — the acta's expense is what the branch paid, corrections included —
 * so it is reported beside the drawer and never subtracted a second time (S4, S13).
 */
export function closingRail(closing: Closing): ClosingRail {
  const expected_cents = closing.opening_cash_cents + closing.cash_sales_cents
    + closing.cash_effective_cents;
  const difference_cents = closing.counted_cash_cents === null
    ? null : closing.counted_cash_cents - expected_cents;
  const taken_cents = closing.counted_cash_cents === null || closing.closing_cash_cents === null
    ? null : closing.counted_cash_cents + closing.contributed_cash_cents - closing.closing_cash_cents;
  return Object.freeze({
    opening_cents: closing.opening_cash_cents,
    cash_sales_cents: closing.cash_sales_cents,
    cash_expenses_cents: closing.cash_expenses_cents,
    cash_effective_cents: closing.cash_effective_cents,
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
// The purchase fund: the second envelope (S1, S5, S6)
// ---------------------------------------------------------------------------------

/**
 * The envelope is settled apart from the drawer: it is counted on its own, no money of a sale feeds
 * it and it is inside no cash identity nor the commission (S1, S12).
 */
export const closingEnvelopeApartHelp =
  'El fondo de compras vive en un sobre aparte de la caja operativa: se cuenta por separado, ninguna venta lo alimenta y no entra en la comisión ni en ninguna igualdad de la caja.';
/** What the amount the warehouse leaves is for: it opens the next period (S5, S6). */
export const closingEnvelopeNewHelp =
  'El monto nuevo abre el período siguiente y sólo sirve para comprar baterías usadas y chatarra.';
/** What acceptance makes of the new amount, in the branch's own words (S5, S6). */
export const closingEnvelopeAcceptanceHelp =
  'Al aceptar, el monto nuevo pasa a ser tu fondo de compras: abre el período siguiente y el Almacén se lleva todo lo que contó en el sobre.';

/**
 * The envelope the settlement publishes, or the one the offer froze when the branch is deciding it
 * (S5, S6). The inherited balance, the purchases and the expectation are always the document's, and
 * the two amounts the warehouse states are the offer's own once there is one, so a proposal is read
 * exactly as it was offered. A payload that does not publish the envelope publishes none here.
 */
export function closingEnvelope(closing: Closing,
  offer: ClosingOffer | null = null): ClosingPurchaseFund | null {
  const fund = closing.purchase_fund;
  if (fund === null || offer === null) return fund;
  const counted_cents = offer.purchase_fund_counted_cents;
  return Object.freeze({ ...fund, counted_cents,
    difference_cents: counted_cents === null ? null : counted_cents - fund.expected_cents,
    new_cents: offer.purchase_fund_cash_cents });
}

/**
 * What the warehouse typed into the second envelope: the count and the amount it leaves, before
 * they are canonical. Both are optional, because an envelope nobody counted states neither — the
 * amount the warehouse leaves is a decision it takes at the closure, not a zero by default (S5).
 */
export interface PurchaseFundDraft {
  readonly counted: string;
  readonly cash: string;
}

export const emptyPurchaseFundDraft: PurchaseFundDraft = Object.freeze({ counted: '', cash: '' });

/** The envelope draft the settlement already holds, so a reload restores the admin's work. */
export function purchaseFundDraftFrom(closing: Closing): PurchaseFundDraft {
  const fund = closing.purchase_fund;
  return Object.freeze({
    counted: fund === null || fund.counted_cents === null ? '' : typedMoney(fund.counted_cents),
    cash: fund === null || fund.new_cents === null ? '' : typedMoney(fund.new_cents),
  });
}

/** The envelope as the rail shows it while the warehouse types, over the facts it holds. */
export interface PurchaseFundView {
  readonly counted_cents: bigint | null;
  readonly new_cents: bigint | null;
  readonly expected_cents: bigint;
  readonly difference_cents: bigint | null;
  readonly problem: string;
}

/**
 * The envelope over the draft the warehouse typed. The difference is published with its sign and
 * never blocks the proposal, exactly like the drawer's (S8), and the new amount is deliberately not
 * bounded by the count: the warehouse may leave more than it found (S5).
 */
export function purchaseFundView(fund: ClosingPurchaseFund,
  draft: PurchaseFundDraft): PurchaseFundView {
  let counted_cents: bigint | null = null;
  let new_cents: bigint | null = null;
  let problem = '';
  try { counted_cents = typedCents(draft.counted); } catch { problem = closingAmountMessage; }
  try { new_cents = typedCents(draft.cash); } catch { problem = closingAmountMessage; }
  if (problem !== '') { counted_cents = null; new_cents = null; }
  const difference_cents = counted_cents === null ? null : counted_cents - fund.expected_cents;
  return Object.freeze({
    counted_cents, new_cents, expected_cents: fund.expected_cents, difference_cents, problem,
  });
}

// ---------------------------------------------------------------------------------
// The third account: the materials the fund bought (S7, S8, S9, S10)
// ---------------------------------------------------------------------------------

/** The two kinds of one sheet: used batteries by the unit and scrap by the kilogram (S7, S8). */
export type ClosingMaterialKind = 'used' | 'scrap';

/** The unit every quantity of a line is counted — and published — in: whole units or kilograms. */
export type ClosingMaterialUnit = 'unit' | 'kg';

export const closingMaterialKindLabels: Readonly<Record<ClosingMaterialKind, string>> =
  Object.freeze({ used: 'Baterías usadas', scrap: 'Chatarra' });

/** The unit a kind is counted in, which is the scale of both of its quantities (S8). */
export function closingMaterialUnitOf(kind: ClosingMaterialKind): ClosingMaterialUnit {
  return kind === 'scrap' ? 'kg' : 'unit';
}

/** The bound of one request: the same 190 lines a count of the stock states. */
export const closingMaxMaterialLines = 190;
/** The range of a material id, which is the smallint of the reference table. */
export const closingMaxMaterialID = 32767;

/**
 * One line of the material sheet, as the document publishes it (S7, S8, S9): what the period bought
 * of one used model or one scrap material, what the warehouse counted at the cut, the difference
 * between the two and the quantity that goes to the warehouse. The expected quantity is the fact of
 * the opening, and the count, the difference and the delivery are `null` together while the line is
 * uncounted. Quantities are canonical text — whole units or kilograms with three decimals — and
 * never a float, so a count of 84,500 kg is never an approximation.
 */
export interface ClosingMaterialLine {
  readonly kind: ClosingMaterialKind;
  readonly model: string | null;
  readonly material_id: number | null;
  readonly material: string | null;
  readonly unit: ClosingMaterialUnit;
  readonly expected_quantity: string;
  readonly counted_quantity: string | null;
  readonly difference: string | null;
  readonly delivered_quantity: string | null;
}

/** The sheet of one settlement: `null` is a document that publishes no sheet at all. */
export function closingMaterialLines(closing: Closing): readonly ClosingMaterialLine[] {
  return closing.material_lines ?? [];
}

export const closingMaterialQuantityMessage =
  'Contá un número entero de unidades o kilogramos con hasta tres decimales.';
export const closingMaterialClearedMessage =
  'La cantidad contada no se borra, se corrige: la entrega es exactamente lo que contaste.';

export const closingMaterialShelfHelp =
  'La estantería arranca en cero: la rendición anterior se llevó todo, así que lo que debe haber es exactamente lo comprado en este período.';
export const closingMaterialDeliveryHelp =
  'Se lleva todo lo contado: la sucursal queda en cero y la próxima rendición arranca limpia.';
export const closingMaterialEmptySheet =
  'El período no compró materiales: la estantería no tiene nada que contar ni entregar.';

const wholeQuantityShape = /^(0|[1-9]\d{0,8})$/;
const kilogramQuantityShape = /^(0|[1-9]\d{0,8})\.\d{3}$/;
const typedQuantityShape = /^\d{1,9}([,.]\d{1,3})?$/;

/** Whether a published quantity is the canonical text of its own unit (S8). */
export function closingMaterialQuantityIsCanonical(unit: ClosingMaterialUnit,
  text: string): boolean {
  if (typeof text !== 'string') return false;
  return unit === 'kg' ? kilogramQuantityShape.test(text) : wholeQuantityShape.test(text);
}

/**
 * Exact thousandths of one quantity of the sheet: a unit is a thousand thousandths. Text that is
 * not canonical is refused instead of normalized, so a count is never approximated (S8).
 */
export function closingMaterialMilli(unit: ClosingMaterialUnit, text: string): bigint {
  const negative = typeof text === 'string' && text.startsWith('-');
  const magnitude = negative ? text.slice(1) : text;
  if (!closingMaterialQuantityIsCanonical(unit, magnitude) || (negative && !/[1-9]/.test(magnitude))) {
    throw new Error(closingMaterialQuantityMessage);
  }
  const [whole, fraction = ''] = magnitude.split('.');
  const milli = BigInt(whole) * 1000n + BigInt((fraction + '000').slice(0, 3));
  return negative ? -milli : milli;
}

/** The text of a quantity the way the screen writes it: `12` units and `12,400` kilograms. */
export function closingMaterialQuantityText(unit: ClosingMaterialUnit, milli: bigint): string {
  const magnitude = milli < 0n ? -milli : milli;
  if (unit === 'unit') {
    if (magnitude % 1000n !== 0n) throw new Error(closingMaterialQuantityMessage);
    return String(magnitude / 1000n);
  }
  return `${magnitude / 1000n},${String(magnitude % 1000n).padStart(3, '0')}`;
}

/** The canonical wire text of a quantity: `7` units and `12.500` kilograms (S8). */
export function closingMaterialWireText(unit: ClosingMaterialUnit, milli: bigint): string {
  return closingMaterialQuantityText(unit, milli).replace(',', '.');
}

/** A quantity with the unit it is counted in, for a table cell: `12,400 kg` and `12`. */
export function closingMaterialQuantityLabel(unit: ClosingMaterialUnit, text: string): string {
  const shown = unit === 'kg'
    ? closingMaterialQuantityText(unit, closingMaterialMilli(unit, text))
    : text;
  return unit === 'kg' ? `${shown} kg` : shown;
}

/** `−4,300` / `+2`, and a dash for a difference that is zero, like every other one (S8). */
export function closingMaterialSignedText(unit: ClosingMaterialUnit, milli: bigint): string {
  if (milli === 0n) return '—';
  const magnitude = closingMaterialQuantityText(unit, milli < 0n ? -milli : milli);
  return milli < 0n ? `−${magnitude}` : `+${magnitude}`;
}

/** `− 4,300 kg` / `− 1 unidad`: the difference with its unit, which is what the strip names (S13). */
export function closingMaterialDifferenceText(unit: ClosingMaterialUnit, milli: bigint): string {
  if (milli === 0n) return closingMaterialSignedText(unit, milli);
  const magnitude = milli < 0n ? -milli : milli;
  const quantity = closingMaterialQuantityText(unit, magnitude);
  const unitText = unit === 'kg' ? 'kg' : magnitude === 1000n ? 'unidad' : 'unidades';
  return `${milli < 0n ? '−' : '+'} ${quantity} ${unitText}`;
}

/** One line of the sheet read over the draft: what the period bought and what is counted now. */
export interface ClosingMaterialRow {
  readonly key: string;
  readonly line: ClosingMaterialLine;
  readonly label: string;
  readonly unit: ClosingMaterialUnit;
  readonly expected_milli: bigint;
  /** The count the draft states; `null` while the line is uncounted. */
  readonly counted_milli: bigint | null;
  /** `counted − expected`, with its sign, and `null` while the line is uncounted (S8). */
  readonly difference_milli: bigint | null;
  /** Everything counted goes to the warehouse, so the delivery is the whole count (S9). */
  readonly delivered_milli: bigint | null;
}

/** One kind of the sheet with its own total, which is only stated for more than one line. */
export interface ClosingMaterialGroup {
  readonly kind: ClosingMaterialKind;
  readonly label: string;
  readonly unit: ClosingMaterialUnit;
  readonly lines: readonly ClosingMaterialRow[];
  readonly differing: number;
  readonly counted: number;
  readonly expected_milli: bigint;
  /** The counted total, or `null` while a line of the kind is still uncounted. */
  readonly counted_milli: bigint | null;
  /** The difference of the lines already counted, with its sign; partial until the kind is whole. */
  readonly difference_milli: bigint;
  /** Whether every line of the kind is counted, which is what its total row needs. */
  readonly complete: boolean;
}

export type ClosingMaterialTone = 'zero' | 'neg' | 'pos' | 'mixed';

/** One line the screen is about to send: the key its kind names and what was counted. */
export interface MaterialCountedInput {
  readonly kind: ClosingMaterialKind;
  readonly model: string | null;
  readonly material_id: number | null;
  readonly counted_quantity: string;
}

/** The body of `POST /api/closings/{id}/materials`: only what was counted (S8). */
export interface MaterialPayload { readonly lines: readonly MaterialCountedInput[] }

/** The typed counted quantity of one line, keyed by the key its kind names. */
export type MaterialDraft = Readonly<Record<string, string>>;

export const emptyMaterialDraft: MaterialDraft = Object.freeze({});

/** `used:NS60ZL` / `scrap:1`: the key of one line, which is also the key of its draft cell. */
export function closingMaterialKey(line: ClosingMaterialLine): string {
  return line.kind === 'used' ? `used:${line.model ?? ''}` : `scrap:${line.material_id ?? 0}`;
}

/** The name a row and a cell share: the model of a used line or the material of a scrap one. */
export function closingMaterialLabel(line: ClosingMaterialLine): string {
  return line.kind === 'used' ? line.model ?? '' : line.material ?? '';
}

/** The text the counted cell starts from: the count the document holds and nothing invented (S8). */
export function closingMaterialSeed(line: ClosingMaterialLine): string {
  if (line.counted_quantity === null) return '';
  return line.unit === 'kg'
    ? closingMaterialQuantityText('kg', closingMaterialMilli('kg', line.counted_quantity))
    : line.counted_quantity;
}

/** The draft the settlement already holds, so a reload restores the counts the server has (S8). */
export function materialDraftFrom(closing: Closing): MaterialDraft {
  const draft: Record<string, string> = {};
  for (const line of closingMaterialLines(closing)) {
    draft[closingMaterialKey(line)] = closingMaterialSeed(line);
  }
  return Object.freeze(draft);
}

/** One typed quantity of the sheet, in exact thousandths; `null` is a cell nobody filled. */
function typedMaterial(unit: ClosingMaterialUnit, text: string): bigint | null {
  const raw = typeof text === 'string' ? text.trim().replace(/^0+(?=\d)/, '') : '';
  if (raw === '') return null;
  if (!typedQuantityShape.test(raw)) throw new Error(closingMaterialQuantityMessage);
  // A battery is not divisible: a fractional unit is refused instead of rounded (S8).
  if (unit === 'unit' && /[,.]/.test(raw)) throw new Error(closingMaterialQuantityMessage);
  const [whole, fraction = ''] = raw.replace(',', '.').split('.');
  if (unit === 'unit') return closingMaterialMilli('unit', whole);
  // A weight is typed with as many decimals as the warehouse writes, and is read at the scale of
  // its column: `80,2` and `80,200` are the same 80,200 kg and never two different counts (S8).
  return closingMaterialMilli('kg', `${whole}.${(fraction + '000').slice(0, 3)}`);
}

/**
 * The material sheet read over the draft the warehouse typed, which is also the reading the branch
 * sees with no inputs at all: the counts of the document are the draft it starts from. Nothing here
 * is a difference the client gates the offer with — the stock count sheet stays the only gate
 * (S8) — and a difference is published with its sign, in the unit of its own kind, never summed
 * across units (S8, S13).
 */
export interface ClosingMaterialReading {
  readonly rows: readonly ClosingMaterialRow[];
  readonly groups: readonly ClosingMaterialGroup[];
  readonly used: ClosingMaterialGroup;
  readonly scrap: ClosingMaterialGroup;
  readonly total: number;
  readonly counted: number;
  readonly differing: number;
  readonly empty: boolean;
  /** The mere head of the account, as the strip and the tabs name it (S13). */
  readonly value: string;
  readonly detail: string;
  readonly tone: ClosingMaterialTone;
  readonly difference: boolean;
  readonly delivery: string;
  /** A quantity the screen cannot read, named instead of being saved (S8). */
  readonly problem: string;
  readonly unsaved: boolean;
  readonly changes: readonly MaterialCountedInput[];
}

/** `a, b y c`, the same listing the blockers of the drawer use. */
function materialGroup(kind: ClosingMaterialKind,
  rows: readonly ClosingMaterialRow[]): ClosingMaterialGroup {
  const unit = closingMaterialUnitOf(kind);
  let expected_milli = 0n;
  let difference_milli = 0n;
  let differing = 0;
  let counted = 0;
  for (const row of rows) {
    expected_milli += row.expected_milli;
    if (row.counted_milli === null) continue;
    counted += 1;
    difference_milli += row.difference_milli ?? 0n;
    if (row.difference_milli !== null && row.difference_milli !== 0n) differing += 1;
  }
  const complete = rows.every(row => row.counted_milli !== null);
  return Object.freeze({
    kind, label: closingMaterialKindLabels[kind], unit, lines: rows, differing, counted,
    expected_milli, difference_milli,
    counted_milli: complete ? rows.reduce((sum, row) => sum + (row.counted_milli ?? 0n), 0n) : null,
    complete,
  });
}

/** The head of the third account: the kind when only one differs and the count when several do. */
function materialBalance(groups: readonly ClosingMaterialGroup[], counted: number,
  total: number): { value: string; detail: string; tone: ClosingMaterialTone; difference: boolean } {
  const differing = groups.filter(group => group.differing > 0);
  if (groups.length === 0) {
    return { value: 'Sin materiales', detail: 'El período no compró materiales', tone: 'zero',
      difference: false };
  }
  const countedText = `${counted} de ${total} ${total === 1 ? 'línea contada' : 'líneas contadas'}`;
  if (differing.length === 0) {
    return { value: 'Sin diferencia', detail: countedText, tone: 'zero', difference: false };
  }
  if (differing.length === 1) {
    const [group] = differing;
    const tone: ClosingMaterialTone = group.difference_milli === 0n ? 'mixed'
      : group.difference_milli < 0n ? 'neg' : 'pos';
    // Two lines of the same kind that cancel each other leave a zero total, which is not a
    // difference the head can state: the count of lines is what is left to say (S13).
    const value = group.difference_milli === 0n
      ? `${group.differing} ${group.differing === 1 ? 'línea' : 'líneas'} con diferencia`
      : closingMaterialDifferenceText(group.unit, group.difference_milli);
    return { value, tone, difference: true,
      detail: `${group.label} · ${group.differing} de ${group.lines.length} con diferencia` };
  }
  return {
    value: `${differing.length} cuentas con diferencia`,
    detail: differing.map(group =>
      `${group.label.toLocaleLowerCase('es')} ${closingMaterialDifferenceText(group.unit, group.difference_milli)}`).join(' · '),
    tone: 'mixed',
    difference: true,
  };
}

/** What the warehouse takes at the closure, in the words of the artboard (S9). */
function materialDelivery(groups: readonly ClosingMaterialGroup[], counted: number,
  total: number): string {
  if (groups.length === 0) return closingMaterialEmptySheet;
  if (counted === 0) {
    return 'Se lleva todo lo contado: contá la estantería y lo que cuentes se entrega entero.';
  }
  if (counted < total) {
    return `Se lleva todo lo contado: ${counted} de ${total} líneas ya contadas se entregan enteras y el resto, cuando lo cuentes.`;
  }
  const parts: string[] = [];
  for (const group of groups) {
    if (group.counted_milli === null) continue;
    if (group.kind === 'scrap') {
      parts.push(`${closingMaterialQuantityText('kg', group.counted_milli)} kg de chatarra`);
    } else {
      const units = group.counted_milli / 1000n;
      parts.push(`${units} ${units === 1n ? 'usada' : 'usadas'}`);
    }
  }
  return `Se lleva todo lo contado: ${listedSides(parts)}.`;
}

/**
 * The material sheet over the draft, with the three things the screen needs from one reading: the
 * rows and their totals, the head the strip names, and the lines that are about to be sent. It never
 * throws: a quantity it cannot read is named in `problem` and left uncounted, and a change that is
 * not a readable count is never part of `changes` (S8).
 */
export function closingMaterialReading(lines: readonly ClosingMaterialLine[],
  draft: MaterialDraft): ClosingMaterialReading {
  let problem = '';
  let unsaved = false;
  const changes: MaterialCountedInput[] = [];
  const rows: ClosingMaterialRow[] = [];
  for (const line of lines) {
    const key = closingMaterialKey(line);
    const unit = line.unit;
    const seed = closingMaterialSeed(line);
    const typed = Object.hasOwn(draft, key) ? draft[key] : seed;
    if (Object.hasOwn(draft, key) && typed !== seed) unsaved = true;
    let expected_milli: bigint;
    try { expected_milli = closingMaterialMilli(unit, line.expected_quantity); }
    catch { problem = closingMaterialQuantityMessage; continue; }
    let counted_milli: bigint | null = null;
    try { counted_milli = typedMaterial(unit, typed); }
    catch {
      if (problem === '') problem = closingMaterialQuantityMessage;
    }
    // A count that is cleared is not a count that is absent: the delivery is what was counted, so
    // a saved line is corrected and never blanked (S9).
    if (counted_milli === null && seed !== '') {
      if (problem === '') problem = closingMaterialClearedMessage;
    }
    const difference_milli = counted_milli === null ? null : counted_milli - expected_milli;
    rows.push(Object.freeze({ key, line, label: closingMaterialLabel(line), unit,
      expected_milli, counted_milli, difference_milli, delivered_milli: counted_milli }));
    // Only a line whose typed count changed is sent, and only when it reads as a count: the
    // request states what was counted and nothing else (S8).
    if (Object.hasOwn(draft, key) && typed !== seed && counted_milli !== null) {
      changes.push(Object.freeze({ kind: line.kind, model: line.model, material_id: line.material_id,
        counted_quantity: closingMaterialWireText(unit, counted_milli) }));
    }
  }
  const used = materialGroup('used', rows.filter(row => row.line.kind === 'used'));
  const scrap = materialGroup('scrap', rows.filter(row => row.line.kind === 'scrap'));
  const groups = [used, scrap].filter(group => group.lines.length > 0);
  const counted = rows.filter(row => row.counted_milli !== null).length;
  const differing = rows.filter(row => row.difference_milli !== null && row.difference_milli !== 0n).length;
  const balance = materialBalance(groups, counted, rows.length);
  return Object.freeze({
    rows: Object.freeze(rows),
    groups: Object.freeze(groups),
    used, scrap,
    total: rows.length,
    counted,
    differing,
    empty: rows.length === 0,
    value: balance.value,
    detail: balance.detail,
    tone: balance.tone,
    difference: balance.difference,
    delivery: materialDelivery(groups, counted, rows.length),
    problem,
    unsaved,
    changes: Object.freeze(changes),
  });
}

// ---------------------------------------------------------------------------------
// The two tabs and the three balances of one settlement (S10, S13, S14)
// ---------------------------------------------------------------------------------

/** The two tabs are navigation, never two life cycles: one cut, one offer, one acceptance (S10). */
export type ClosingTab = 'caja' | 'chatarra';

export const closingTabOrder: readonly ClosingTab[] = Object.freeze(['caja', 'chatarra']);
export const closingTabLabels: Readonly<Record<ClosingTab, string>> = Object.freeze({
  caja: 'Caja', chatarra: 'Chatarra',
});
/** The name the tab list and its panels share. */
export const closingTabsLabel = 'Rendición';
/** The name of the header with the three balances, which is above the tabs (S13). */
export const closingBalancesLabel = 'Saldos de la rendición';

export const closingBalanceLabels: Readonly<Record<'cash' | 'fund' | 'materials', string>> =
  Object.freeze({ cash: 'Caja operativa', fund: 'Fondo de compras', materials: 'Materiales' });

/**
 * The tab an arrow key moves to, which is the one interaction model the screens share with the
 * purchases tabs: the arrows wrap around the two tabs and nothing else moves the selection.
 */
export function closingTabAfter(tab: ClosingTab, key: string): ClosingTab | null {
  if (key !== 'ArrowRight' && key !== 'ArrowLeft') return null;
  const index = closingTabOrder.indexOf(tab);
  return closingTabOrder[(index + (key === 'ArrowRight' ? 1 : closingTabOrder.length - 1))
    % closingTabOrder.length];
}

/** One balance of the header: its difference in words and the tab it belongs to (S13). */
export interface ClosingBalance {
  readonly key: 'cash' | 'fund' | 'materials';
  readonly label: string;
  /** `− Bs 35,00`, `− 4,300 kg` or `Sin diferencia`; `Sin contar` before the count exists. */
  readonly value: string;
  /** The facts under it: `contada 6.980,00 · esperada 7.015,00`. */
  readonly detail: string;
  readonly tone: ClosingMaterialTone;
  /** Whether the account carries a difference, which is what the tab marker states. */
  readonly difference: boolean;
  readonly tab: ClosingTab;
}

/** The facts the three balances read: the drawer, the envelope and the material sheet, live. */
export interface ClosingBalanceFacts {
  readonly cash_counted_cents: bigint | null;
  readonly cash_expected_cents: bigint;
  readonly cash_difference_cents: bigint | null;
  /** `null` when the document publishes no envelope at all. */
  readonly fund_counted_cents: bigint | null;
  readonly fund_expected_cents: bigint | null;
  readonly fund_difference_cents: bigint | null;
  readonly materials: ClosingMaterialReading;
}

/**
 * `6.980,00` or `− 120,50`: an amount without its currency, for a line whose headline already
 * carries it. The figure keeps the sign of a derived amount instead of handing a negative number to
 * a formatter that only takes money: the envelope's expectation is negative whenever it spent more
 * than it inherited, and that is a settlement the server published, not one the head may refuse
 * (S3, S11).
 */
function moneyFigure(cents: bigint): string {
  const magnitude = cents < 0n ? -cents : cents;
  const figure = formatMoney(magnitude).slice(3);
  return cents < 0n ? `− ${figure}` : figure;
}

function moneyBalance(difference: bigint | null,
  expected: bigint): { value: string; tone: ClosingMaterialTone; difference: boolean } {
  if (difference === null) return { value: 'Sin contar', tone: 'zero', difference: false };
  if (difference === 0n) return { value: closingDifferenceName(difference), tone: 'zero', difference: false };
  return { value: closingSignedText(difference), tone: difference < 0n ? 'neg' : 'pos', difference: true };
}

/**
 * The three balances of the settlement, above the tabs (S13): the operating drawer, the purchase
 * fund and the materials, each with its difference or with the words that say there is none. The
 * materials are never added to any money figure and a kilogram is never added to a unit: each
 * account is read in its own unit and named on its own.
 */
export function closingBalanceStrip(facts: ClosingBalanceFacts): readonly ClosingBalance[] {
  const cash = moneyBalance(facts.cash_difference_cents, facts.cash_expected_cents);
  const fund = facts.fund_expected_cents === null
    ? { value: 'Sin sobre', tone: 'zero' as ClosingMaterialTone, difference: false }
    : moneyBalance(facts.fund_difference_cents, facts.fund_expected_cents);
  return Object.freeze([
    Object.freeze({
      key: 'cash' as const,
      label: closingBalanceLabels.cash,
      value: cash.value,
      tone: cash.tone,
      difference: cash.difference,
      tab: 'caja' as ClosingTab,
      detail: facts.cash_counted_cents === null
        ? `esperada ${moneyFigure(facts.cash_expected_cents)}`
        : `contada ${moneyFigure(facts.cash_counted_cents)} · esperada ${moneyFigure(facts.cash_expected_cents)}`,
    }),
    Object.freeze({
      key: 'fund' as const,
      label: closingBalanceLabels.fund,
      value: fund.value,
      tone: fund.tone,
      difference: fund.difference,
      tab: 'chatarra' as ClosingTab,
      detail: facts.fund_expected_cents === null
        ? 'La rendición no publica el sobre'
        : facts.fund_counted_cents === null
          ? `esperado ${moneyFigure(facts.fund_expected_cents)}`
          : `contado ${moneyFigure(facts.fund_counted_cents)} · esperado ${moneyFigure(facts.fund_expected_cents)}`,
    }),
    Object.freeze({
      key: 'materials' as const,
      label: closingBalanceLabels.materials,
      value: facts.materials.value,
      detail: facts.materials.detail,
      tone: facts.materials.tone,
      difference: facts.materials.difference,
      tab: 'chatarra' as ClosingTab,
    }),
  ]);
}

/**
 * The marker one tab carries: the difference of its accounts in words — `− Bs 35,00`, `− 4,300 kg`
 * or `2 con diferencia` — and `null` when none of them carries one. It is never a bare dot, because
 * a colour or a mark alone is not a reading (S13).
 */
export function closingTabMarker(balances: readonly ClosingBalance[], tab: ClosingTab): string | null {
  const carrying = balances.filter(balance => balance.tab === tab && balance.difference);
  if (carrying.length === 0) return null;
  if (carrying.length === 1) return carrying[0].value;
  return `${carrying.length} con diferencia`;
}

// ---------------------------------------------------------------------------------
// The drawer draft the warehouse states
// ---------------------------------------------------------------------------------

/** What the warehouse typed: the drawer's two amounts beside the contribution, before they are
 * canonical. The contribution is what the warehouse puts into the till for this settlement, so a
 * fund can be left with an empty drawer (S10, S11, L13). */
export interface DrawerDraft {
  readonly counted: string;
  readonly contribution: string;
  readonly fund: string;
  readonly observation: string;
}

/** The contribution defaults to zero, which is the normal case and what the settlement reports. */
export const emptyDrawerDraft: DrawerDraft = Object.freeze({
  counted: '', contribution: '0,00', fund: '', observation: '',
});

/** The draft the settlement already holds, so a reload of the screen restores the admin's work. */
export function drawerDraftFrom(closing: Closing): DrawerDraft {
  return Object.freeze({
    counted: closing.counted_cash_cents === null ? '' : typedMoney(closing.counted_cash_cents),
    // The contribution starts from the fact the server holds: a saved one never reopens as zero.
    contribution: typedMoney(closing.contributed_cash_cents),
    fund: closing.closing_cash_cents === null ? '' : typedMoney(closing.closing_cash_cents),
    observation: closing.observation,
  });
}

/** The drawer as the rail shows it while the warehouse types, before anything is saved. */
export interface DrawerView {
  readonly counted_cents: bigint | null;
  /** What the warehouse puts into the till, as the draft states it; `null` while undeclared. */
  readonly contribution_cents: bigint | null;
  readonly fund_cents: bigint | null;
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
  let contribution_cents: bigint | null = null;
  let fund_cents: bigint | null = null;
  let problem = '';
  try { counted_cents = typedCents(draft.counted); } catch { problem = closingAmountMessage; }
  try { contribution_cents = typedCents(draft.contribution); } catch { problem = closingAmountMessage; }
  try { fund_cents = typedCents(draft.fund); } catch { problem = closingAmountMessage; }
  if (problem !== '') { counted_cents = null; contribution_cents = null; fund_cents = null; }
  const difference_cents = counted_cents === null ? null : counted_cents - rail.expected_cents;
  // The fund never exceeds the drawer the warehouse counts plus the money it put into the till,
  // which is what makes the first settlement possible with an empty drawer (S10, S11, L13). The
  // bound is stated only when its two sides are: an undeclared contribution leaves the screen
  // without an answer, and then the server's own refusal is the only one the admin reads.
  const bound_cents = counted_cents === null || contribution_cents === null
    ? null : counted_cents + contribution_cents;
  const excess_cents = bound_cents === null || fund_cents === null || fund_cents <= bound_cents
    ? null : fund_cents - bound_cents;
  // What the warehouse takes out of the till is stated only for a drawer it can take from: a
  // fund above the drawer is a draft that is not an offer yet, and the excess names it.
  const taken_cents = bound_cents === null || fund_cents === null || excess_cents !== null
    ? null : bound_cents - fund_cents;
  return Object.freeze({
    counted_cents, contribution_cents, fund_cents,
    expected_cents: rail.expected_cents, difference_cents, taken_cents, excess_cents, problem,
  });
}

/**
 * The exact body of `POST /api/closings/{id}/cash`: the four keys of the drawer, absent amounts as
 * `null`, and — when the warehouse stated the envelope — the two keys of the purchase fund (S1, S5).
 */
export interface DrawerPayload {
  readonly counted_cash: string | null;
  readonly contributed_cash: string;
  readonly closing_cash: string | null;
  readonly observation: string;
  readonly purchase_fund_counted?: string | null;
  readonly purchase_fund_cash?: string | null;
}

export const closingObservationMessage = `La observación lleva hasta ${closingMaxObservation} caracteres.`;
export const closingContributionMessage =
  'Escribí el aporte del Almacén, aunque sea cero: el cierre lo registra como movimiento de caja.';

/**
 * Canonicalizes the drawer the way the contract takes it: an amount the warehouse has not
 * counted is the explicit `null`, and the contribution is the money the warehouse states it put
 * into the till. It is a fact of the settlement, so an empty field is refused instead of being
 * sent as a zero the admin never declared (S10).
 *
 * The envelope travels in the same body: its two keys are stated when the warehouse wrote them,
 * each as canonical non-negative text or as the explicit `null` of the side it did not state, and
 * both are absent when it stated neither — an envelope nobody counted is never an invented zero
 * (S1, S5).
 */
export function canonicalDrawerPayload(draft: DrawerDraft,
  envelope: PurchaseFundDraft = emptyPurchaseFundDraft): DrawerPayload {
  let counted_cash: string | null;
  let closing_cash: string | null;
  let envelopeCounted: bigint | null;
  let envelopeCash: bigint | null;
  try {
    const counted = typedCents(draft.counted);
    const fund = typedCents(draft.fund);
    counted_cash = counted === null ? null : centsToMoney(counted);
    closing_cash = fund === null ? null : centsToMoney(fund);
    envelopeCounted = typedCents(envelope.counted);
    envelopeCash = typedCents(envelope.cash);
  } catch { return invalidMoney(); }
  const contribution = typedCents(draft.contribution);
  if (contribution === null) throw new Error(closingContributionMessage);
  const observation = draft.observation;
  if (typeof observation !== 'string' || observation.includes('\0') || !observation.isWellFormed()
    || Array.from(observation).length > closingMaxObservation) {
    throw new Error(closingObservationMessage);
  }
  const drawer = {
    counted_cash, contributed_cash: centsToMoney(contribution), closing_cash, observation,
  };
  if (envelopeCounted === null && envelopeCash === null) return Object.freeze(drawer);
  return Object.freeze({
    ...drawer,
    purchase_fund_counted: envelopeCounted === null ? null : centsToMoney(envelopeCounted),
    purchase_fund_cash: envelopeCash === null ? null : centsToMoney(envelopeCash),
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

/** `TOYO NS40ZL L · 100 Ah` for a battery and `Agua acidulada · 1 L` for a product: the label a
 *  row, a blocker and a refusal share, stated with the identity of its own kind (S3). */
export function closingLineLabel(line: ClosingCountLine): string {
  return closingIsBatteryLine(line)
    ? `${line.brand} ${line.model} ${line.polarity} · ${line.capacity_ah} Ah`
    : `${line.name} · ${line.detail}`;
}

/**
 * The quantity the sheet assumes for a line: the count the document holds or, when it holds none,
 * the expected one. Every line opens seeded with `counted_quantity = expected_quantity`, so a line
 * without a count can only come from a settlement opened before that seed (L3) — it is read as
 * coinciding, never as an empty cell the admin has to fill and never as a reason to refuse (S1).
 */
export function closingAssumedQuantity(line: ClosingCountLine): number {
  return line.counted_quantity ?? line.expected_quantity;
}

/**
 * The text the sheet starts a row from: the quantity the document already publishes, so the admin
 * only types where the count differs (S1, L2). A row the cut did not know publishes nothing — its
 * quantity is the admin's to state (S4).
 */
export function closingSeedQuantity(line: ClosingCountLine): string {
  if (line.counted_quantity !== null) return String(line.counted_quantity);
  return closingLineIsOutsideSystem(line) ? '' : String(line.expected_quantity);
}

/** The difference of one row, with its sign; a row nobody counted coincides, so it is a zero. */
export function closingLineDifference(line: ClosingCountLine): number {
  return closingAssumedQuantity(line) - line.expected_quantity;
}

/** A counted difference is shown with its sign, and a match is shown as a dash, not zero. */
export function closingQuantityText(value: number | null): string {
  if (value === null || value === 0) return '—';
  if (value > 0) return `+${value}`;
  return `−${-value}`;
}

/** The count of the sheet against the system, in words: nothing is read from a colour alone (S2). */
export const closingCountMatchTag = 'Conteo coincidente';
/** A row whose count does not coincide with the system says so in words, beside its difference. */
export const closingChangedTag = 'No coincide';

/** `1 diferencia contra el sistema` / `3 diferencias contra el sistema`, for the rail and the bar. */
export function closingCountDifferenceText(differing: number): string {
  return `${differing} ${differing === 1 ? 'diferencia' : 'diferencias'} contra el sistema`;
}

/** The search of the sheet: the sheet is already here, so the filter never asks the server. It
 *  indexes the identity of each row -- the battery attributes of a battery and the name and detail of
 *  a product -- because a term a row shows must answer that row (S3, S4). */
export function filterCountLines(lines: readonly ClosingCountLine[], search: string): readonly ClosingCountLine[] {
  if (typeof search !== 'string' || !validSearch(search)) throw new Error(closingSearchMessage);
  const needle = search.trim().toLocaleLowerCase('es');
  if (needle === '') return lines;
  return lines.filter(line => {
    const identity = closingIsBatteryLine(line)
      ? `${line.brand} ${line.model} ${line.capacity_ah} ${line.polarity}`
      : `${line.name} ${line.detail}`;
    return `${identity} ${line.variant_id}`.toLocaleLowerCase('es').includes(needle);
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
// A battery the system did not have (S4, S5: the stock squares upward too)
// ---------------------------------------------------------------------------------

/**
 * The sheet of the cut only lists the variants the branch held, so a battery that exists physically
 * and the system does not have has no row at all. The admin adds it from the branch's own catalogue,
 * and the closure honours it as stock the system did not have (S5, L38).
 */
export const closingCataloguePageSize = 50;
export const closingCatalogueUnavailable =
  'No se pudo consultar el catálogo de la sucursal. Revisá la conexión e intentá de nuevo.';
export const closingCatalogueHelp =
  '¿Contaste una batería o un producto que el sistema no tiene? Buscalo en el catálogo de la sucursal y agregalo: la fila queda sin cantidad esperada y el cierre la deja con lo que contaste.';
export const closingCatalogueEmpty = 'Sin variantes para agregar con esa búsqueda.';
export const closingCatalogueListedTag = 'Ya está en la planilla';
export const closingCatalogueHeldTag = 'La sucursal ya tiene stock';
export const closingDuplicateLineMessage =
  'Esa variante ya está en la planilla: no se puede agregar dos veces.';
/** A row added by hand says, in words, that the cut did not know it. */
export const closingOutsideSystemTag = 'Fuera del sistema';
export const closingOutsideSystemHelp =
  'La sucursal no tenía esta variante en el sistema: la fila no lleva cantidad esperada y su diferencia es lo contado.';

/**
 * One variant of the branch's catalogue, with the stock the branch holds right now. It is the
 * identity of its own kind -- a battery states its battery attributes, a product its name and detail
 * -- plus the stock, so the sheet completes itself from both kinds (S3, S4).
 */
export type ClosingCatalogueVariant = ClosingLineKey &
  (ClosingBatteryIdentity | ClosingProductIdentity) & {
    /** What the branch holds: only a variant it holds none of is an addition (S5). */
    readonly existing: bigint;
  };

/** What the catalogue search offers for one variant of the branch. */
export type ClosingCatalogueState = 'addable' | 'listed' | 'held';

/** One row of the catalogue search: the variant and whether the sheet can still take it. */
export interface ClosingCatalogueOption {
  readonly variant: ClosingCatalogueVariant;
  readonly state: ClosingCatalogueState;
}

/**
 * The variant ids the sheet already holds: the snapshot of the cut plus the rows the admin added by
 * hand and has not saved yet. One variant is added once, and a line of the sheet is never added.
 */
export function closingSheetVariantIDs(closing: Closing,
  added: readonly ClosingCatalogueVariant[] = []): ReadonlySet<number> {
  const ids = new Set<number>(closing.count_lines.map(line => line.variant_id));
  for (const variant of added) ids.add(variant.variant_id);
  return ids;
}

/**
 * The catalogue search as the sheet can use it: a variant the sheet already lists is only listed, a
 * variant the branch holds is only held, and only a variant the system does not have is addable.
 * It is the one place the exclusion is decided, so the screen cannot offer a row twice.
 */
export function closingCatalogueOptions(catalogue: readonly ClosingCatalogueVariant[],
  taken: ReadonlySet<number>): readonly ClosingCatalogueOption[] {
  const seen = new Set<number>();
  const options: ClosingCatalogueOption[] = [];
  for (const variant of catalogue) {
    if (seen.has(variant.variant_id)) continue;
    seen.add(variant.variant_id);
    const state: ClosingCatalogueState = taken.has(variant.variant_id) ? 'listed'
      : variant.existing !== 0n ? 'held' : 'addable';
    options.push(Object.freeze({ variant: Object.freeze({ ...variant }), state }));
  }
  return Object.freeze(options);
}

/**
 * Adds one variant of the branch catalogue as a row the closure will honour as stock the system did
 * not have. A variant already taken — on the sheet or added once already — is refused instead.
 */
export function closingAddLine(lines: readonly ClosingCatalogueVariant[],
  variant: ClosingCatalogueVariant, taken: ReadonlySet<number>): readonly ClosingCatalogueVariant[] {
  if (taken.has(variant.variant_id) || lines.some(line => line.variant_id === variant.variant_id)) {
    throw new Error(closingDuplicateLineMessage);
  }
  return Object.freeze([...lines, Object.freeze({ ...variant })]);
}

/** Drops a row the admin added and has not saved yet: a line of the cut is never removed. */
export function closingRemoveLine(lines: readonly ClosingCatalogueVariant[],
  variant_id: number): readonly ClosingCatalogueVariant[] {
  return Object.freeze(lines.filter(line => line.variant_id !== variant_id));
}

/** The identity of one row of the sheet, without the stock the catalogue read carries. */
function lineIdentity(
  line: ClosingBatteryIdentity | ClosingProductIdentity): ClosingBatteryIdentity | ClosingProductIdentity {
  return closingIsBatteryLine(line)
    ? { brand: line.brand, model: line.model, capacity_ah: line.capacity_ah, polarity: line.polarity }
    : { name: line.name, detail: line.detail };
}

/**
 * The rows the screen works on: the snapshot of the cut plus the rows added by hand, in variant
 * order. An added row carries no expected quantity because the cut had none of it, and it keeps the
 * identity of its kind (S3).
 */
export function closingSheetRows(closing: Closing,
  added: readonly ClosingCatalogueVariant[] = []): readonly ClosingCountLine[] {
  const rows: ClosingCountLine[] = closing.count_lines.map(line => Object.freeze(
    { ...lineIdentity(line), variant_id: line.variant_id, catalog_entry_id: line.catalog_entry_id,
      expected_quantity: line.expected_quantity, counted_quantity: line.counted_quantity }));
  for (const variant of added) {
    if (rows.some(row => row.variant_id === variant.variant_id)) continue;
    rows.push(Object.freeze({ ...lineIdentity(variant), variant_id: variant.variant_id,
      catalog_entry_id: variant.catalog_entry_id, expected_quantity: 0, counted_quantity: null }));
  }
  rows.sort((left, right) => left.variant_id - right.variant_id);
  return Object.freeze(rows);
}

/**
 * A row the cut did not know: the system had none of it, so it carries no expected quantity. Every
 * line the opening seeded has stock, which is exactly what makes the two kinds tellable apart.
 */
export function closingLineIsOutsideSystem(line: { readonly expected_quantity: number }): boolean {
  return line.expected_quantity === 0;
}

/**
 * The lines the admin is about to save: every row whose count changed, the rows added by hand
 * included, and nothing else. A row that was not typed is not a count and is never sent (S4), and
 * the quantity it is compared against is the one the sheet was seeded with (S1).
 */
export function closingCountChanges(rows: readonly ClosingCountLine[],
  draft: Readonly<Record<number, string>>): readonly CountedLineInput[] {
  const changes: CountedLineInput[] = [];
  for (const row of rows) {
    const typed = typeof draft[row.variant_id] === 'string' ? draft[row.variant_id] : '';
    if (typed !== closingSeedQuantity(row)) {
      changes.push(Object.freeze({ variant_id: row.variant_id, counted: typed }));
    }
  }
  return Object.freeze(changes);
}

/** One row of the sheet whose count does not coincide with the quantity the system expected (S2). */
export interface ClosingCountDifference {
  readonly variant_id: number;
  readonly label: string;
  readonly expected_quantity: number;
  readonly counted_quantity: number;
  readonly difference: number;
}

/** The whole quantity a text states, or `null` when it states none the sheet could save. */
function wholeQuantity(text: string | undefined): number | null {
  const raw = typeof text === 'string' ? text.trim() : '';
  if (!/^(0|[1-9]\d{0,6})$/.test(raw)) return null;
  const quantity = Number(raw);
  return quantity > closingMaxCounted ? null : quantity;
}

/** The count of the sheet as the admin's draft states it: which rows differ and how many. */
export interface ClosingCountReading {
  readonly total: number;
  /** How many rows differ from the expected quantity; `0` is a sheet that coincides (S1). */
  readonly differing: number;
  readonly differences: readonly ClosingCountDifference[];
}

/**
 * The rows whose count does not coincide with the expected quantity, as the draft states them: a
 * row edited back to the expected quantity is not a difference, and a row the admin did not type
 * keeps the quantity the document publishes. It is a reading of the client's own draft and nothing
 * else: no column, no document field and no request carries it (S2).
 */
export function closingCountReading(rows: readonly ClosingCountLine[],
  draft: Readonly<Record<number, string>>): ClosingCountReading {
  const differences: ClosingCountDifference[] = [];
  for (const row of rows) {
    const counted = wholeQuantity(draft[row.variant_id]) ?? closingAssumedQuantity(row);
    const difference = counted - row.expected_quantity;
    if (difference === 0) continue;
    differences.push(Object.freeze({ variant_id: row.variant_id, label: closingLineLabel(row),
      expected_quantity: row.expected_quantity, counted_quantity: counted, difference }));
  }
  return Object.freeze({ total: rows.length, differing: differences.length,
    differences: Object.freeze(differences) });
}

// ---------------------------------------------------------------------------------
// Why the offer cannot be made yet
// ---------------------------------------------------------------------------------

export interface ClosingBlocker { readonly code: string; readonly message: string }

/** `a, b y c`: the sides a statement is missing, named in the order they are stated. */
function listedSides(sides: readonly string[]): string {
  if (sides.length <= 1) return sides.join('');
  return `${sides.slice(0, -1).join(', ')} y ${sides[sides.length - 1]}`;
}

/**
 * What still blocks the proposal, in the order the warehouse can act on it. Every blocker is a
 * fact of the settlement it already holds or of the draft it typed; the refusal itself is the
 * server's, and this list never replaces it. The count side has no arm of its own: the sheet opens
 * coinciding with the system, so a variant waiting to be counted is not a fact any more (S1, S3),
 * and no confirmation step is added in its place (S2).
 */
export function closingBlockers(closing: Closing, view: DrawerView,
  unsaved = false, commissionMissing = false): readonly ClosingBlocker[] {
  if (!closingIsEditable(closing.status)) {
    return Object.freeze([Object.freeze({
      code: closing.status === 'proposed' ? 'state_conflict' : 'closed',
      message: closing.status === 'proposed'
        ? 'La propuesta espera la decisión de la sucursal: no se puede proponer otra vez.'
        : 'La rendición está cerrada: no se puede proponer ni editar.',
    })]);
  }
  const blockers: ClosingBlocker[] = [];
  if (view.problem !== '') {
    blockers.push(Object.freeze({ code: 'invalid_amount', message: view.problem }));
  }
  const missing: string[] = [];
  if (view.counted_cents === null) missing.push('la caja contada');
  // The contribution is a side of the drawer the admin states: without it the fund bound has no
  // second term and the first settlement of a branch could never be offered (S10, S11).
  if (view.contribution_cents === null) missing.push('el aporte del Almacén');
  if (view.fund_cents === null) missing.push('el fondo que queda en la caja');
  // An amount that cannot be read is already named above; it is not also reported as absent.
  if (missing.length > 0 && view.problem === '') {
    blockers.push(Object.freeze({
      code: 'cash_not_stated',
      message: `Falta ${listedSides(missing)}: el cierre no puede proponerse sin eso.`,
    }));
  }
  if (view.excess_cents !== null) {
    blockers.push(Object.freeze({
      code: 'fund_exceeds_drawer',
      message: `El fondo supera la caja contada más el aporte en ${formatMoney(view.excess_cents)}.`,
    }));
  }
  // A branch without a commission has nothing to settle: the server refuses the proposal, so
  // the screen says it before the button is pressed instead of showing the refusal afterwards.
  if (commissionMissing) {
    blockers.push(Object.freeze({
      code: 'commission_missing',
      message: 'La sucursal no tiene porcentaje de comisión configurado: sin eso no se puede proponer.',
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
  if (blockers.length === 0) return 'La rendición se puede proponer: la caja está declarada.';
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

// ---------------------------------------------------------------------------------
// The branch's side: it only accepts or rejects the offer it is shown (S14, S15)
// ---------------------------------------------------------------------------------

export const closingMotiveRequiredMessage =
  'Escribí el motivo del rechazo: sin motivo no se puede rechazar la propuesta.';
export const closingMotiveLengthMessage =
  `El motivo del rechazo lleva hasta ${closingMaxObservation} caracteres y no admite caracteres inválidos.`;
export const closingAcceptanceMismatchMessage =
  'La propuesta no coincide con la rendición que tenés delante: no se puede describir ni aceptar.';

/** The exact body of `POST /api/closings/{id}/decision`: the two decisions are exclusive. */
export interface ClosingDecisionPayload {
  readonly decision: 'accepted' | 'rejected';
  readonly reason?: string;
}

/**
 * Canonicalizes the only two answers the branch can send. A rejection without a motive cannot
 * even be expressed: it is trimmed, bounded and refused before it can reach the server (S14).
 */
export function closingDecisionPayload(
  decision: 'accepted' | 'rejected', reason: string): ClosingDecisionPayload {
  if (decision === 'accepted') return Object.freeze({ decision: 'accepted' });
  if (decision !== 'rejected') throw new Error(closingMotiveRequiredMessage);
  const motive = typeof reason === 'string' ? reason.trim() : '';
  if (motive === '') throw new Error(closingMotiveRequiredMessage);
  if (motive.includes('\0') || !motive.isWellFormed()
    || Array.from(motive).length > closingMaxObservation) {
    throw new Error(closingMotiveLengthMessage);
  }
  return Object.freeze({ decision: 'rejected', reason: motive });
}

/** Only `proposed` awaits the branch; every other state is read-only and says why. */
export interface ClosingDecisionReadiness { readonly awaiting: boolean; readonly reason: string }

export function closingDecisionReadiness(closing: Closing): ClosingDecisionReadiness {
  if (closing.status === 'closed') {
    return Object.freeze({
      awaiting: false,
      reason: 'La rendición ya está cerrada: el Almacén no puede reabrirla y no hay nada que decidir.',
    });
  }
  if (closing.status === 'proposed') return Object.freeze({ awaiting: true, reason: '' });
  return Object.freeze({
    awaiting: false,
    reason: 'La sucursal está congelada: el Almacén todavía no propuso el cierre, así que no hay nada que aceptar ni rechazar.',
  });
}

/** One counted variant as the branch is about to accept it: the system, the count and the result. */
export interface ClosingStockChange {
  readonly variant_id: number;
  readonly label: string;
  readonly system_quantity: number;
  readonly counted_quantity: number;
  readonly becomes_quantity: number;
  readonly difference: number;
}

function stockChange(variant_id: number, label: string, system: number, counted: number): ClosingStockChange {
  return Object.freeze({
    variant_id, label, system_quantity: system, counted_quantity: counted,
    becomes_quantity: counted, difference: counted - system,
  });
}

/** The counted sheet of a settlement that is not being offered, still legible after the closure. */
export function closingSheetChanges(closing: Closing): readonly ClosingStockChange[] {
  return Object.freeze(closing.count_lines
    .filter(line => line.counted_quantity !== null)
    .map(line => stockChange(line.variant_id, closingLineLabel(line), line.expected_quantity,
      line.counted_quantity!)));
}

/** The counted lines of a stored offer, labelled with the sheet of the settlement it belongs to. */
export function closingOfferChanges(closing: Closing,
  offer: ClosingOffer): readonly ClosingStockChange[] {
  const sheet = new Map(closing.count_lines.map(line => [line.variant_id, line]));
  return Object.freeze(offer.count_lines.map(line => {
    const entry = sheet.get(line.variant_id);
    const label = entry === undefined ? `Variante #${line.variant_id}` : closingLineLabel(entry);
    return stockChange(line.variant_id, label, line.expected_quantity, line.counted_quantity);
  }));
}

/**
 * The drawer of the offer: the inherited fund with the offer's own cash sales and the signed effect the
 * document published for the window — the same rule the document's own rail applies — produce the
 * expected drawer, the difference and what the warehouse takes. The offer's window is the document's
 * window, because the closure froze both from the same proposal, so its effect is the document's; the
 * acceptance still compares the offer's cash facts with the frozen ones, so a drifted offer is refused
 * instead of described. The commission is reported beside them and is inside none of those identities
 * (S9).
 */
export function closingOfferRail(closing: Closing, offer: ClosingOffer): ClosingRail {
  const expected_cents = closing.opening_cash_cents + offer.cash_sales_cents
    + closing.cash_effective_cents;
  return Object.freeze({
    opening_cents: closing.opening_cash_cents,
    cash_sales_cents: offer.cash_sales_cents,
    cash_expenses_cents: offer.cash_expenses_cents,
    cash_effective_cents: closing.cash_effective_cents,
    expected_cents,
    counted_cents: offer.counted_cash_cents,
    difference_cents: offer.counted_cash_cents - expected_cents,
    contribution_cents: offer.contributed_cash_cents,
    fund_cents: offer.closing_cash_cents,
    taken_cents: offer.counted_cash_cents + offer.contributed_cash_cents - offer.closing_cash_cents,
    rate_percent: offer.commission_rate_percent,
    sales_total_cents: offer.sales_total_cents,
    commission_cents: offer.commission_amount_cents,
    card_cents: offer.card_total_cents,
    transfer_cents: offer.transfer_total_cents,
    qr_cents: offer.qr_total_cents,
  });
}

/** The offer the branch is deciding, with what acceptance applies and nothing else. */
export interface ClosingAcceptance {
  readonly round: ClosingRound;
  readonly offer: ClosingOffer;
  readonly changes: readonly ClosingStockChange[];
  readonly rail: ClosingRail;
}

function sameOfferLines(left: readonly ClosingOfferLine[], right: readonly ClosingCountLine[]): boolean {
  const counted = right.filter(line => line.counted_quantity !== null);
  if (left.length !== counted.length) return false;
  return left.every((line, index) => {
    const sheet = counted[index];
    return line.variant_id === sheet.variant_id && line.expected_quantity === sheet.expected_quantity
      && line.counted_quantity === sheet.counted_quantity;
  });
}

/**
 * The decisive reading of a `proposed` settlement: the latest undecided round and the offer it
 * holds. A document whose offer disagrees with its own facts is refused instead of described, so
 * the branch never accepts arithmetic the server would not apply.
 */
export function closingAcceptance(closing: Closing): ClosingAcceptance | null {
  if (closing.status !== 'proposed') return null;
  const round = closing.rounds[closing.rounds.length - 1];
  if (round === undefined || round.decision !== '') return null;
  const rail = closingOfferRail(closing, round.offer);
  const published = closingRail(closing);
  // The envelope of the offer is the one the closure applies, so an offer that disagrees with the
  // envelope the document publishes is never described as acceptable either (S5, S6).
  const fund = closing.purchase_fund;
  const envelopeDrifted = fund !== null
    && (round.offer.purchase_fund_counted_cents !== fund.counted_cents
      || round.offer.purchase_fund_cash_cents !== fund.new_cents);
  if (rail.expected_cents !== published.expected_cents
    || rail.difference_cents !== published.difference_cents
    || rail.taken_cents !== published.taken_cents
    || rail.commission_cents !== published.commission_cents
    // The offer's cash facts are the ones the document froze: they are compared as the published numbers
    // they are, never through a formula of this screen.
    || round.offer.cash_sales_cents !== closing.cash_sales_cents
    || round.offer.cash_expenses_cents !== closing.cash_expenses_cents
    || envelopeDrifted
    || !sameOfferLines(round.offer.count_lines, closing.count_lines)) {
    throw new Error(closingAcceptanceMismatchMessage);
  }
  return Object.freeze({
    round,
    offer: round.offer,
    changes: closingOfferChanges(closing, round.offer),
    rail,
  });
}

/** The account that proposed or decided a round, as the contract identifies it: no names (S7). */
export function closingAccountLabel(accountID: number): string {
  return `Cuenta #${accountID}`;
}

const momentFormat = new Intl.DateTimeFormat('es-BO', {
  timeZone: 'America/La_Paz', day: '2-digit', month: 'short', year: 'numeric',
  hour: '2-digit', minute: '2-digit', hour12: false,
});

/** `12 sept 2026, 10:44`: when a round was offered or answered, in the branch time zone. */
export function closingMomentText(value: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return 'Fecha no disponible';
  return momentFormat.format(new Date(value));
}

/** The answer of a round in the branch's words; `''` is the offer still on the table. */
export function closingRoundStateLabel(decision: ClosingDecision): string {
  if (decision === 'accepted') return 'Aceptada';
  if (decision === 'rejected') return 'Rechazada';
  return 'Por decidir';
}

// ---------------------------------------------------------------------------------
// Corrections of a closed settlement (S16)
// ---------------------------------------------------------------------------------

export type ClosingCorrectionStatus = 'proposed' | 'accepted' | 'rejected';

export const closingCorrectionStatusLabels: Readonly<Record<ClosingCorrectionStatus, string>> =
  Object.freeze({
    proposed: 'Espera la decisión de la sucursal',
    accepted: 'Aceptada',
    rejected: 'Rechazada',
  });

/** The four facts one correction can restate: the sheet, the drawer, the commission and the fund. */
export type ClosingCorrectionKind = 'stock' | 'counted_cash' | 'commission' | 'fund';

export const closingCorrectionKindLabels: Readonly<Record<ClosingCorrectionKind, string>> =
  Object.freeze({
    stock: 'Conteo',
    counted_cash: 'Caja contada',
    commission: 'Comisión',
    fund: 'Fondo que queda',
  });

/** One corrected quantity: the variant and the number the warehouse says it counted. */
export interface ClosingCorrectionQuantity {
  readonly variant_id: number;
  readonly counted_quantity: number;
}

/** The four values a correction can state; a value it does not touch stays absent (S16). */
export interface ClosingCorrectionPayload {
  readonly counted_quantities: readonly ClosingCorrectionQuantity[];
  readonly counted_cash_cents: bigint | null;
  readonly commission_amount_cents: bigint | null;
  readonly closing_cash_cents: bigint | null;
}

/** One delta an accepted correction applied. Exactly one unit is stated, by the kind (036, 040). */
export interface ClosingCorrectionEffect {
  readonly kind: ClosingCorrectionKind;
  readonly variant_id: number | null;
  readonly quantity_delta: number | null;
  readonly amount_delta_cents: bigint | null;
}

/** One correction of a closed settlement: what it corrects, why, and who answered it (S16). */
export interface ClosingCorrection {
  readonly id: number;
  readonly closing_id: number;
  readonly status: ClosingCorrectionStatus;
  readonly reason: string;
  readonly payload: ClosingCorrectionPayload;
  readonly proposed_by_account_id: number;
  readonly proposed_at: string;
  readonly decided_by_account_id: number | null;
  readonly decided_at: string | null;
  readonly decision_reason: string;
  readonly effects: readonly ClosingCorrectionEffect[];
}

/**
 * The correction that waits for the branch, or `null` when there is none. It is the only one the
 * branch can decide, so the screen that answers it reads it from here instead of guessing from a
 * list: a settlement with no corrections offers no decision at all (S16).
 */
export function closingPendingCorrection(closing: Closing): ClosingCorrection | null {
  return closing.corrections.find(correction => correction.status === 'proposed') ?? null;
}

/** The corrections the branch already accepted, oldest first: each one amended a number. */
export function closingAcceptedCorrections(closing: Closing): readonly ClosingCorrection[] {
  return closing.corrections.filter(correction => correction.status === 'accepted');
}

/** The delta the accepted corrections journalled for one money kind of the settlement. */
function acceptedAmountDelta(closing: Closing, kind: ClosingCorrectionKind): bigint {
  let total = 0n;
  for (const correction of closingAcceptedCorrections(closing)) {
    for (const effect of correction.effects) {
      if (effect.kind === kind && effect.amount_delta_cents !== null) total += effect.amount_delta_cents;
    }
  }
  return total;
}

/** The delta the accepted corrections applied to one variant of the count sheet. */
function acceptedQuantityDeltas(closing: Closing): ReadonlyMap<number, number> {
  const deltas = new Map<number, number>();
  for (const correction of closingAcceptedCorrections(closing)) {
    for (const effect of correction.effects) {
      if (effect.kind !== 'stock' || effect.variant_id === null || effect.quantity_delta === null) continue;
      deltas.set(effect.variant_id, (deltas.get(effect.variant_id) ?? 0) + effect.quantity_delta);
    }
  }
  return deltas;
}

/**
 * One amount of the settlement as the branch signed it and as it reads today. The row keeps the
 * signed numbers and the journal keeps what moved, so the signed one is recovered from the published
 * corrected one minus the deltas -- except the commission, which the document publishes as the
 * signed amount and whose corrected figure is the signed one plus its delta (034, 036, 040). A
 * corrected number is therefore always shown with the delta that produced it, never as signed.
 */
export interface ClosingCorrectedAmount {
  readonly kind: 'counted_cash' | 'commission' | 'fund';
  readonly label: string;
  readonly signed_cents: bigint;
  readonly corrected_cents: bigint;
  readonly delta_cents: bigint;
}

/** The amounts the accepted corrections already changed, with the delta of each one. */
export function closingCorrectedAmounts(closing: Closing): readonly ClosingCorrectedAmount[] {
  const amounts: ClosingCorrectedAmount[] = [];
  const countedDelta = acceptedAmountDelta(closing, 'counted_cash');
  if (closing.counted_cash_cents !== null && countedDelta !== 0n) {
    amounts.push(Object.freeze({ kind: 'counted_cash' as const,
      label: closingCorrectionKindLabels.counted_cash,
      signed_cents: closing.counted_cash_cents - countedDelta,
      corrected_cents: closing.counted_cash_cents, delta_cents: countedDelta }));
  }
  const commissionDelta = acceptedAmountDelta(closing, 'commission');
  if (commissionDelta !== 0n) {
    amounts.push(Object.freeze({ kind: 'commission' as const,
      label: closingCorrectionKindLabels.commission,
      signed_cents: closing.commission_amount_cents,
      corrected_cents: closing.commission_amount_cents + commissionDelta, delta_cents: commissionDelta }));
  }
  const fundDelta = acceptedAmountDelta(closing, 'fund');
  if (closing.closing_cash_cents !== null && fundDelta !== 0n) {
    amounts.push(Object.freeze({ kind: 'fund' as const, label: closingCorrectionKindLabels.fund,
      signed_cents: closing.closing_cash_cents - fundDelta,
      corrected_cents: closing.closing_cash_cents, delta_cents: fundDelta }));
  }
  return Object.freeze(amounts);
}

/** One count line the accepted corrections already changed. */
export interface ClosingCorrectedCount {
  readonly variant_id: number;
  readonly label: string;
  readonly signed_quantity: number;
  readonly corrected_quantity: number;
  readonly delta: number;
}

/** The count lines the accepted corrections already changed, in variant order. */
export function closingCorrectedCounts(closing: Closing): readonly ClosingCorrectedCount[] {
  const deltas = acceptedQuantityDeltas(closing);
  const sheet = new Map(closing.count_lines.map(line => [line.variant_id, line]));
  return Object.freeze([...deltas.keys()].sort((left, right) => left - right).map(variant_id => {
    const line = sheet.get(variant_id);
    const signed = line?.counted_quantity ?? 0;
    const delta = deltas.get(variant_id) ?? 0;
    return Object.freeze({ variant_id, label: line === undefined ? `Variante #${variant_id}` : closingLineLabel(line),
      signed_quantity: signed, corrected_quantity: signed + delta, delta });
  }));
}

/** The commission the settlement reads today, over the accepted deltas of its journal. */
export function closingCorrectedCommission(closing: Closing): bigint {
  return closing.commission_amount_cents + acceptedAmountDelta(closing, 'commission');
}

// ---------------------------------------------------------------------------------
// What a pending correction would change
// ---------------------------------------------------------------------------------

/** One amount a pending correction would leave different, with the difference. */
export interface ClosingCorrectionAmountStep {
  readonly kind: 'counted_cash' | 'commission' | 'fund';
  readonly label: string;
  readonly current_cents: bigint;
  readonly proposed_cents: bigint;
  readonly delta_cents: bigint;
}

/** One count line a pending correction would leave different, with the difference. */
export interface ClosingCorrectionCountStep {
  readonly variant_id: number;
  readonly label: string;
  readonly current_quantity: number;
  readonly proposed_quantity: number;
  readonly delta: number;
}

/**
 * The pending correction as the branch reads it before deciding: what it states, what it would
 * change, and the drawer it would leave. The expected cash is untouched by a correction -- it is the
 * inherited fund plus the cash facts of the period -- so the difference and what the warehouse takes
 * are derived again over the corrected drawer instead of being restated (S8, S10, S16).
 */
export interface ClosingCorrectionPreview {
  readonly correction: ClosingCorrection;
  readonly amounts: readonly ClosingCorrectionAmountStep[];
  readonly counts: readonly ClosingCorrectionCountStep[];
  readonly expected_cents: bigint;
  readonly counted_cents: bigint | null;
  readonly difference_cents: bigint | null;
  readonly contribution_cents: bigint;
  readonly fund_cents: bigint | null;
  readonly taken_cents: bigint | null;
  readonly commission_cents: bigint;
}

/**
 * The reading of the correction that waits for the branch, or `null` when nothing waits. A document
 * whose pending correction belongs to another settlement is refused instead of described: the branch
 * never decides a correction it cannot see whole (S16).
 */
export function closingCorrectionPreview(closing: Closing): ClosingCorrectionPreview | null {
  if (closing.status !== 'closed') return null;
  const correction = closingPendingCorrection(closing);
  if (correction === null) return null;
  if (correction.closing_id !== closing.id) throw new Error(closingAcceptanceMismatchMessage);
  const expected_cents = closingRail(closing).expected_cents;
  const currentCounts = new Map(closingCorrectedCounts(closing)
    .map(count => [count.variant_id, count.corrected_quantity]));
  const sheet = new Map(closing.count_lines.map(line => [line.variant_id, line]));
  const amounts: ClosingCorrectionAmountStep[] = [];
  const step = (kind: 'counted_cash' | 'commission' | 'fund', label: string,
    current: bigint | null, proposed: bigint | null): bigint | null => {
    if (proposed === null || current === null) return current;
    amounts.push(Object.freeze({ kind, label, current_cents: current, proposed_cents: proposed,
      delta_cents: proposed - current }));
    return proposed;
  };
  const counted_cents = step('counted_cash', closingCorrectionKindLabels.counted_cash,
    closing.counted_cash_cents, correction.payload.counted_cash_cents);
  const commission_cents = step('commission', closingCorrectionKindLabels.commission,
    closingCorrectedCommission(closing), correction.payload.commission_amount_cents);
  const fund_cents = step('fund', closingCorrectionKindLabels.fund,
    closing.closing_cash_cents, correction.payload.closing_cash_cents);
  const counts: ClosingCorrectionCountStep[] = [];
  for (const quantity of correction.payload.counted_quantities) {
    const line = sheet.get(quantity.variant_id);
    const current = currentCounts.get(quantity.variant_id) ?? line?.counted_quantity ?? null;
    if (current === null) continue;
    if (current === quantity.counted_quantity) continue;
    counts.push(Object.freeze({
      variant_id: quantity.variant_id,
      label: line === undefined ? `Variante #${quantity.variant_id}` : closingLineLabel(line),
      current_quantity: current, proposed_quantity: quantity.counted_quantity,
      delta: quantity.counted_quantity - current,
    }));
  }
  const difference_cents = counted_cents === null ? null : counted_cents - expected_cents;
  const taken_cents = counted_cents === null || fund_cents === null
    ? null : counted_cents + closing.contributed_cash_cents - fund_cents;
  return Object.freeze({
    correction,
    amounts: Object.freeze(amounts),
    counts: Object.freeze(counts),
    expected_cents,
    counted_cents,
    difference_cents,
    contribution_cents: closing.contributed_cash_cents,
    fund_cents,
    taken_cents,
    commission_cents: commission_cents ?? closing.commission_amount_cents,
  });
}

// ---------------------------------------------------------------------------------
// The correction the warehouse proposes
// ---------------------------------------------------------------------------------

export const closingCorrectionReasonMessage =
  'Escribí el motivo de la corrección: sin motivo no se puede proponer.';
export const closingCorrectionValueMessage =
  'La corrección tiene que cambiar al menos un valor: el conteo, la caja, la comisión o el fondo.';

/** The four correctable values as the warehouse types them, over the closed settlement. */
export interface CorrectionDraft {
  readonly reason: string;
  readonly counted: Readonly<Record<number, string>>;
  readonly counted_cash: string;
  readonly commission: string;
  readonly fund: string;
}

/**
 * The draft of a correction, seeded with what the settlement reads today: a field the warehouse does
 * not touch is not restated, and the corrected numbers it already published are the ones a second
 * correction takes its difference against (036, 040).
 */
export function correctionDraftFrom(closing: Closing): CorrectionDraft {
  const correctedAmounts = new Map(closingCorrectedAmounts(closing)
    .map(amount => [amount.kind, amount.corrected_cents]));
  const correctedCounts = new Map(closingCorrectedCounts(closing)
    .map(count => [count.variant_id, count.corrected_quantity]));
  const counted: Record<number, string> = {};
  for (const line of closing.count_lines) {
    if (line.counted_quantity === null) continue;
    counted[line.variant_id] = String(correctedCounts.get(line.variant_id) ?? line.counted_quantity);
  }
  return Object.freeze({
    reason: '',
    counted: Object.freeze(counted),
    counted_cash: closing.counted_cash_cents === null ? ''
      : typedMoney(correctedAmounts.get('counted_cash') ?? closing.counted_cash_cents),
    commission: typedMoney(correctedAmounts.get('commission') ?? closingCorrectedCommission(closing)),
    fund: closing.closing_cash_cents === null ? ''
      : typedMoney(correctedAmounts.get('fund') ?? closing.closing_cash_cents),
  });
}

/** The body of `POST /api/closings/{id}/corrections`: the reason and the values it corrects. */
export interface CorrectionBody {
  readonly reason: string;
  readonly payload: {
    readonly counted_quantities?: readonly ClosingCorrectionQuantity[];
    readonly counted_cash?: string;
    readonly commission_amount?: string;
    readonly closing_cash?: string;
  };
}

/**
 * Canonicalizes the body of one correction: a reason that is not blank once trimmed, and at least
 * one of the four values, each in the shape that value is. It is the contract's own gate, so a
 * correction that states nothing never leaves the screen (S16, S20).
 */
export function canonicalCorrectionBody(body: CorrectionBody): CorrectionBody {
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
  if (reason === '' || reason.includes('\0') || !reason.isWellFormed()
    || Array.from(reason).length > closingMaxObservation) {
    throw new Error(closingCorrectionReasonMessage);
  }
  if (!body.payload || typeof body.payload !== 'object') throw new Error(closingCorrectionValueMessage);
  const known = ['counted_quantities', 'counted_cash', 'commission_amount', 'closing_cash'];
  if (Object.keys(body.payload).some(key => !known.includes(key))) {
    throw new Error(closingCorrectionValueMessage);
  }
  const payload: { counted_quantities?: ClosingCorrectionQuantity[]; counted_cash?: string;
    commission_amount?: string; closing_cash?: string } = {};
  let stated = 0;
  if (body.payload.counted_quantities !== undefined) {
    const lines = body.payload.counted_quantities;
    if (!Array.isArray(lines) || lines.length === 0) throw new Error(closingCorrectionValueMessage);
    if (lines.length > closingMaxCountLines) throw new Error(closingCountLimitMessage);
    const seen = new Set<number>();
    payload.counted_quantities = lines.map(line => {
      const variant = line.variant_id;
      if (!Number.isInteger(variant) || variant < 1 || variant > closingMaxID || seen.has(variant)) {
        throw new Error(closingQuantityMessage);
      }
      seen.add(variant);
      if (!Number.isInteger(line.counted_quantity) || line.counted_quantity < 0
        || line.counted_quantity > closingMaxCounted) {
        throw new Error(closingQuantityMessage);
      }
      return Object.freeze({ variant_id: variant, counted_quantity: line.counted_quantity });
    });
    stated += 1;
  }
  for (const key of ['counted_cash', 'commission_amount', 'closing_cash'] as const) {
    const value = body.payload[key];
    if (value === undefined) continue;
    if (typeof value !== 'string') throw new Error(closingAmountMessage);
    const cents = closingCents(value);
    if (centsToMoney(cents) !== value) throw new Error(closingAmountMessage);
    payload[key] = value;
    stated += 1;
  }
  if (stated === 0) throw new Error(closingCorrectionValueMessage);
  return Object.freeze({ reason, payload: Object.freeze(payload) });
}

/**
 * The correction the warehouse is proposing, built over the closed settlement's own numbers: only
 * the values it actually changes are stated, each money one as canonical text, so the payload the
 * branch receives is exactly what is different and nothing is restated (S16).
 */
export function canonicalCorrection(closing: Closing, draft: CorrectionDraft): CorrectionBody {
  const currentCounts = new Map(closingCorrectedCounts(closing)
    .map(count => [count.variant_id, count.corrected_quantity]));
  const quantities: ClosingCorrectionQuantity[] = [];
  for (const line of closing.count_lines) {
    const current = currentCounts.get(line.variant_id) ?? line.counted_quantity;
    if (current === null) continue;
    const raw = typeof draft.counted[line.variant_id] === 'string'
      ? draft.counted[line.variant_id].trim() : '';
    if (raw === '') continue;
    if (!/^(0|[1-9]\d{0,6})$/.test(raw) || Number(raw) > closingMaxCounted) {
      throw new Error(closingQuantityMessage);
    }
    if (Number(raw) === current) continue;
    quantities.push(Object.freeze({ variant_id: line.variant_id, counted_quantity: Number(raw) }));
  }
  const amount = (typed: string, current: bigint | null): string | null => {
    const raw = typeof typed === 'string' ? typed.trim() : '';
    if (raw === '') return null;
    const cents = parseTypedMoney(raw);
    if (current !== null && cents === current) return null;
    return centsToMoney(cents);
  };
  const payload: { counted_quantities?: readonly ClosingCorrectionQuantity[];
    counted_cash?: string; commission_amount?: string; closing_cash?: string } = {};
  if (quantities.length > 0) payload.counted_quantities = quantities;
  const countedCash = amount(draft.counted_cash, closing.counted_cash_cents);
  if (countedCash !== null) payload.counted_cash = countedCash;
  const commission = amount(draft.commission, closingCorrectedCommission(closing));
  if (commission !== null) payload.commission_amount = commission;
  const fund = amount(draft.fund, closing.closing_cash_cents);
  if (fund !== null) payload.closing_cash = fund;
  return canonicalCorrectionBody({ reason: draft.reason, payload });
}

/** Only the correction that waits for the branch is decidable; every other state says why (S16). */
export function closingCorrectionReadiness(closing: Closing): ClosingDecisionReadiness {
  if (closing.status !== 'closed') {
    return Object.freeze({
      awaiting: false,
      reason: 'La rendición todavía no está cerrada: se corrige después del cierre, no antes.',
    });
  }
  if (closingPendingCorrection(closing) !== null) return Object.freeze({ awaiting: true, reason: '' });
  return Object.freeze({
    awaiting: false,
    reason: 'La rendición está cerrada y no tiene una corrección esperando tu decisión.',
  });
}

/** `+ Bs 50,00` / `− Bs 35,00` for the delta of a correction, always with its sign. */
export function closingCorrectionDeltaText(cents: bigint): string {
  return closingSignedText(cents);
}

/** `+1` / `−2` for a corrected quantity, and a dash for a difference that is not one. */
export function closingCorrectionQuantityDeltaText(delta: number): string {
  return closingQuantityText(delta);
}
