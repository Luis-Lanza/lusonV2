import { parse, LosslessNumber } from 'lossless-json';
import type { Location } from './model';

export interface Account {
  id: string; username: string; display_name: string; location_id: number;
  enabled: boolean; must_change_password: boolean;
}
function invalid(): never { throw new Error('Respuesta inválida del servidor.'); }
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof LosslessNumber) return invalid();
  const result = value as Record<string, unknown>;
  if (Object.keys(result).length !== keys.length || keys.some(key => !Object.hasOwn(result, key))) return invalid();
  return result;
}
function decode(raw: string): unknown { try { return parse(raw, null, { onDuplicateKey: invalid }); } catch { return invalid(); } }
function text(value: unknown, blank = false): string {
  if (typeof value !== 'string' || (!blank && !value) || !value.isWellFormed() || value.includes('\0')) return invalid();
  return value;
}
function locationID(value: unknown): number {
  if (!(value instanceof LosslessNumber) || !/^[1-9]\d*$/.test(value.toString())) return invalid();
  const id = BigInt(value.toString());
  if (id > 32767n) return invalid();
  return Number(id);
}
function account(value: unknown): Account {
  const item = object(value, ['id', 'username', 'display_name', 'location_id', 'enabled', 'must_change_password']);
  const id = text(item.id);
  if (!/^[1-9]\d*$/.test(id) || BigInt(id) > 9223372036854775807n
    || typeof item.enabled !== 'boolean' || typeof item.must_change_password !== 'boolean') return invalid();
  const location = locationID(item.location_id);
  if ((id === '1') !== (location === 1)) return invalid();
  return { id, username: text(item.username), display_name: text(item.display_name, true), location_id: location,
    enabled: item.enabled, must_change_password: item.must_change_password };
}
function branch(value: unknown): Location {
  const item = object(value, ['id', 'name']);
  return { id: locationID(item.id), name: text(item.name) };
}
export function parseAccount(raw: string): Account { return account(decode(raw)); }
export function parseBranch(raw: string): Location { return branch(decode(raw)); }
export function parseAccounts(raw: string): Account[] {
  const value = decode(raw);
  if (!Array.isArray(value)) return invalid();
  const items = value.map(account);
  if (items.some((item, index) => index > 0 && BigInt(items[index - 1].id) >= BigInt(item.id))) return invalid();
  return items;
}
export function parseBranches(raw: string): Location[] {
  const value = decode(raw);
  if (!Array.isArray(value)) return invalid();
  const items = value.map(branch);
  if (items.some((item, index) => index > 0 && items[index - 1].id >= item.id)) return invalid();
  return items;
}
/** One configured commission of the panel: the branch, its canonical rate, and the account
 *  that fixed it with the moment it did. The author is part of the shape because a money
 *  parameter is never shown anonymous. */
export interface Commission {
  branch_id: number; rate: string; updated_at: string; updated_by: string;
}
/** The canonical percentage the database stores: two decimals between 0.00 and 100.00. */
const commissionPattern = /^(0|[1-9][0-9]{0,2})\.([0-9]{2})$/;
function commission(value: unknown): Commission {
  const item = object(value, ['branch_location_id', 'commission_rate_percent', 'updated_at', 'updated_by']);
  const rate = text(item.commission_rate_percent);
  const match = commissionPattern.exec(rate);
  const moment = text(item.updated_at);
  if (!match || Number(match[1] + match[2]) > 10000 || !/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/.test(moment)
    || Number.isNaN(Date.parse(moment))) return invalid();
  const id = locationID(item.branch_location_id);
  // The warehouse is location 1 and never settles itself, so it carries no commission.
  if (id < 2) return invalid();
  return { branch_id: id, rate, updated_at: moment, updated_by: text(item.updated_by, true) };
}
/** Reads the configured commissions of every branch, in branch order. A branch the warehouse
 *  never configured is absent, which is what the panel shows as "sin configurar". */
export function parseCommissions(raw: string): Commission[] {
  const value = decode(raw);
  if (!Array.isArray(value)) return invalid();
  const items = value.map(commission);
  if (items.some((item, index) => index > 0 && items[index - 1].branch_id >= item.branch_id)) return invalid();
  return items;
}
/** The moment the rate was fixed, in the operator's own clock and short form: the audit half
 *  of S4 that says when, beside the account that says who. */
export function commissionMoment(moment: string): string {
  return new Date(moment).toLocaleString('es-BO', { day: '2-digit', month: '2-digit',
    year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
/** The rate as the operator reads it: the canonical percentage with a decimal comma. */
export function commissionText(rate: string): string { return rate.replace('.', ',') + ' %'; }
/** What the operator types turned into the canonical wire rate, or null when it is not a
 *  percentage the server would admit: comma or dot, at most two decimals, never above 100. */
export function commissionInput(value: string): string | null {
  const typed = value.trim().replace(',', '.');
  const match = /^(0|[1-9][0-9]{0,2})(?:\.([0-9]{1,2}))?$/.exec(typed);
  if (!match) return null;
  const hundredths = Number(match[1] + (match[2] ?? '').padEnd(2, '0'));
  if (hundredths > 10000) return null;
  return `${match[1]}.${(match[2] ?? '').padEnd(2, '0')}`;
}
export function validName(value: string): boolean {
  return !!value.trim() && value.isWellFormed() && !value.includes('\0') && new TextEncoder().encode(value).length <= 128;
}
/** What the operator types turned into the canonical wire amount, or null when it is
 *  not an amount the server would admit: comma or dot, at most two decimals, never
 *  negative, never padded. The canonical form is exactly two decimals and at most the
 *  ten integral digits `numeric(12,2)` holds, and zero is an amount. */
export function amountInput(value: string): string | null {
  const typed = value.trim().replace(',', '.');
  const match = /^(0|[1-9][0-9]{0,9})(?:\.([0-9]{1,2}))?$/.exec(typed);
  if (!match) return null;
  return `${match[1]}.${(match[2] ?? '').padEnd(2, '0')}`;
}
/** The founding the server admits (S1, S13): the name and its two mandatory amounts,
 *  exactly those three keys and never a fourth. Both amounts are required -- that is
 *  what the human asked for -- and 0,00 is a stated answer, not a missing one (S3). */
export function branchFounding(name: string, openingCash: string, purchaseFund: string): Record<string, string> {
  if (!validName(name)) throw new Error('Ingresá un nombre válido de hasta 128 bytes UTF-8.');
  return { name, ...fundAmounts(openingCash, purchaseFund) };
}
/** The two mandatory amounts of one load, as the strict payload the server admits (S2):
 *  the drawer's operating cash and the purchase fund, and never a third key. Silence is
 *  not an answer here either; 0,00 is a stated answer and it is sent as one (S9). */
export function branchFundLoad(openingCash: string, purchaseFund: string): Record<string, string> {
  return fundAmounts(openingCash, purchaseFund);
}
function fundAmounts(openingCash: string, purchaseFund: string): Record<string, string> {
  const cash = amountInput(openingCash);
  if (cash === null) throw new Error('Ingresá el fondo de caja operativa en bolivianos, con hasta dos decimales.');
  const fund = amountInput(purchaseFund);
  if (fund === null) throw new Error('Ingresá el fondo de compras en bolivianos, con hasta dos decimales.');
  return { opening_cash: cash, purchase_fund: fund };
}
/** What a stated 0,00 answers, in the words of the load it describes (S9). It is a stated
 *  answer, not a missing one: nothing is written into that box's ledger and the act is not
 *  an error. Text that is not an amount earns no notice; the payload refuses it first. */
export function fundsZeroNotice(openingCash: string, purchaseFund: string): string {
  const cash = amountInput(openingCash) === '0.00';
  const fund = amountInput(purchaseFund) === '0.00';
  if (cash && fund) return 'Declaraste 0,00 en las dos cajas: la carga no escribe ningún movimiento.';
  if (cash) return 'Declaraste 0,00 en la caja operativa: esa caja no recibe ningún movimiento.';
  if (fund) return 'Declaraste 0,00 en el fondo de compras: esa caja no recibe ningún movimiento.';
  return '';
}
/** One balance of the panel (S7): the branch, the drawer's expectation and the purchase
 *  fund -- both signed text the server read from the ledgers -- and whether a live
 *  settlement is holding the branch, in which case its numbers are about to change (S8). */
export interface BranchBalance {
  branch_id: number; cash_balance: string; fund_balance: string; frozen: boolean;
}
/** Canonical signed text of a `numeric(12,2)`, exactly as the ledgers store it. */
const signedAmountPattern = /^-?(0|[1-9][0-9]{0,9})\.[0-9]{2}$/;
function signedAmount(value: unknown): string {
  const amount = text(value);
  // `-0.00` is not an amount this arithmetic can produce, and it is not a shortage.
  if (!signedAmountPattern.test(amount) || amount === '-0.00') return invalid();
  return amount;
}
function branchBalance(value: unknown): BranchBalance {
  const item = object(value, ['branch_id', 'cash_balance', 'fund_balance', 'frozen']);
  const id = locationID(item.branch_id);
  // The warehouse owns no drawer and no fund, so it carries no balance.
  if (id < 2 || typeof item.frozen !== 'boolean') return invalid();
  return { branch_id: id, cash_balance: signedAmount(item.cash_balance),
    fund_balance: signedAmount(item.fund_balance), frozen: item.frozen };
}
/** Reads one balance per live branch, in branch order. A branch without its row is not a
 *  branch without money: it is an answer this server did not produce, and the read fails. */
export function parseBalances(raw: string): BranchBalance[] {
  const value = decode(raw);
  if (!Array.isArray(value)) return invalid();
  const items = value.map(branchBalance);
  if (items.some((item, index) => index > 0 && items[index - 1].branch_id >= item.branch_id)) return invalid();
  return items;
}
/** The signed balance as the operator reads it, in the house's money format (`Bs 5.000,00`,
 *  and `-Bs 300,00` for a shortage). Presentation only: the number is the server's and it is
 *  never recomputed, clamped or rounded here (S7). */
export function balanceText(amount: string): string {
  const match = /^(-?)(0|[1-9][0-9]{0,9})\.([0-9]{2})$/.exec(amount);
  if (!match || amount === '-0.00') return invalid();
  return `${match[1]}Bs ${match[2].replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${match[3]}`;
}
export function accountPatch(before: Account, name: string, location: number, enabled: boolean): Record<string, string | number | boolean> {
  const patch: Record<string, string | number | boolean> = {};
  if (name !== before.display_name) { if (!validName(name)) throw new Error('Ingresá un nombre válido de hasta 128 bytes UTF-8.'); patch.display_name = name; }
  if (before.id !== '1') {
    if (location !== before.location_id) patch.location_id = location;
    if (enabled !== before.enabled) patch.enabled = enabled;
  }
  return patch;
}
