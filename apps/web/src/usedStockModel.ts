import { LosslessNumber, parse as parseJSON } from 'lossless-json';

/**
 * The stock of used batteries (`apps/api/docs/warranty-cases.md`, «The stock of used batteries»): the
 * one read that answers how many used batteries of a model a location holds. There is no balance row
 * and no stored total (S18, S24) — the answer is the signed sum of the facts already registered, so a
 * certificate that disagrees with the documents cannot exist, and nothing here ever writes one.
 *
 * The reader is strict on purpose: every term is a canonical decimal string, the model is the
 * trimmed and upper-cased key a purchase stores (S26), the list is ordered by location and model, and
 * a row whose `available` is not the arithmetic of S24 for its own location is a row this screen
 * cannot describe. `available` itself may be negative — it is a sum of the whole history and never a
 * clamp — and a location with no fact of a model has no row at all: the read never invents a zero.
 */

/** The one route of the derived stock: no body, no query and no write. */
export const usedStockPath = '/api/warranty-cases/used-stock';
/** The warehouse owns location 1 and no case: its row is the pool the branches deliver into (S24, S27). */
export const usedStockWarehouse = 1;
export const usedStockUnavailable = 'No se pudo consultar el stock de usadas. Revisá la conexión e intentá de nuevo.';

export interface UsedStockRow {
  readonly location_id: number;
  /** The only identity of a used battery: trimmed and upper-cased, exactly like a purchase line (S26). */
  readonly model: string;
  /** What the location bought of the model, counter-documents included as they are stored. */
  readonly purchased: number;
  /** The units the factory refused and sent back to the used pool; the warehouse's only (S27). */
  readonly factory_returns: number;
  /** The units of this location's loans the counter got back. */
  readonly loans_returned: number;
  /** What the closed settlements counted of the model: a branch delivered it, the warehouse received it. */
  readonly delivered: number;
  /** The units handed to the client of a case out of this location. */
  readonly loans_given: number;
  /** The signed sum of the five terms for this location, as the database states it. */
  readonly available: number;
}

export interface UsedStockTotals {
  readonly purchased: number;
  readonly factory_returns: number;
  readonly loans_returned: number;
  readonly delivered: number;
  readonly loans_given: number;
  readonly available: number;
}

const rowKeys = ['location_id', 'model', 'purchased', 'factory_returns', 'loans_returned', 'delivered',
  'loans_given', 'available'] as const;
/** The database's own bounds, restated so an inadmissible number never leaves this module. */
const maxLocation = 32767;
const maxQuantity = 9_007_199_254_740_991;
const modelPattern = /^[A-Z0-9][A-Z0-9 .,_/-]{0,39}$/;

function invalid(): never { throw new Error('Respuesta inválida del servidor.'); }
function decode(raw: string): unknown {
  try { return parseJSON(raw, null, { onDuplicateKey: invalid }); } catch { return invalid(); }
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof LosslessNumber) return invalid();
  const result = value as Record<string, unknown>;
  if (Object.keys(result).length !== keys.length || keys.some(key => !Object.hasOwn(result, key))) return invalid();
  return result;
}
function whole(value: unknown, min: number, max: number): number {
  if (!(value instanceof LosslessNumber) || !/^(0|[1-9][0-9]*)$/.test(value.toString())) return invalid();
  const parsed = BigInt(value.toString());
  if (parsed < BigInt(min) || parsed > BigInt(max)) return invalid();
  return Number(parsed);
}
/** One term of the formula: a quantity, so never a negative number and never a decimal. */
function term(value: unknown): number {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) return invalid();
  const parsed = BigInt(value);
  if (parsed > BigInt(maxQuantity)) return invalid();
  return Number(parsed);
}
/** The signed sum of one row: it may be negative, because it is the history and not a clamp. */
function signed(value: unknown): number {
  if (typeof value !== 'string' || !/^(0|-?[1-9][0-9]*)$/.test(value)) return invalid();
  const parsed = BigInt(value);
  if (parsed > BigInt(maxQuantity) || parsed < -BigInt(maxQuantity)) return invalid();
  return Number(parsed);
}
function model(value: unknown): string {
  if (typeof value !== 'string' || !modelPattern.test(value) || value !== value.trim().toUpperCase()) return invalid();
  return value;
}

/** The arithmetic of S24 per location: the delivery leaves the branch and enters the warehouse. */
export function usedStockSum(row: Pick<UsedStockRow, 'location_id' | 'purchased' | 'factory_returns'
  | 'loans_returned' | 'delivered' | 'loans_given'>): number {
  const total = row.purchased + row.factory_returns + row.loans_returned - row.loans_given;
  return row.location_id === usedStockWarehouse ? total + row.delivered : total - row.delivered;
}

function stockRow(value: unknown): UsedStockRow {
  const item = object(value, rowKeys);
  const row: UsedStockRow = {
    location_id: whole(item.location_id, usedStockWarehouse, maxLocation),
    model: model(item.model),
    purchased: term(item.purchased),
    factory_returns: term(item.factory_returns),
    loans_returned: term(item.loans_returned),
    delivered: term(item.delivered),
    loans_given: term(item.loans_given),
    available: signed(item.available),
  };
  // A row whose balance is not its own arithmetic is a number nobody can act on, so it is refused.
  if (row.available !== usedStockSum(row)) return invalid();
  return row;
}

/** The whole table, one row per location and model, in the order the contract publishes it. */
export function parseUsedStock(raw: string): UsedStockRow[] {
  const table = object(decode(raw), ['stock']);
  const stock = table.stock;
  if (!Array.isArray(stock) || stock.length > 100_000) return invalid();
  const rows = stock.map(stockRow);
  if (rows.some((row, index) => index > 0 && (rows[index - 1].location_id > row.location_id
    || (rows[index - 1].location_id === row.location_id && rows[index - 1].model >= row.model)))) return invalid();
  return rows;
}

// ---------------------------------------------------------------------------------
// What a screen derives from the published facts, and nothing else
// ---------------------------------------------------------------------------------

/** The rows of one location; a location with no fact of a model contributes no row. */
export function usedStockAt(rows: readonly UsedStockRow[], locationID: number): UsedStockRow[] {
  return rows.filter(row => row.location_id === locationID);
}

/**
 * The two loan terms of one model in one location. A model no document moved has no row, so both terms
 * are zero: a branch that never lent a used battery states no loan at all.
 */
export function usedStockLoansOf(rows: readonly UsedStockRow[], locationID: number,
  model: string): { readonly given: number; readonly returned: number } {
  const row = rows.find(entry => entry.location_id === locationID && entry.model === model);
  return { given: row?.loans_given ?? 0, returned: row?.loans_returned ?? 0 };
}

/** The five terms and the sum of a group of rows, added term by term and never recomposed. */
export function usedStockTotals(rows: readonly UsedStockRow[]): UsedStockTotals {
  return rows.reduce<UsedStockTotals>((total, row) => ({
    purchased: total.purchased + row.purchased,
    factory_returns: total.factory_returns + row.factory_returns,
    loans_returned: total.loans_returned + row.loans_returned,
    delivered: total.delivered + row.delivered,
    loans_given: total.loans_given + row.loans_given,
    available: total.available + row.available,
  }), { purchased: 0, factory_returns: 0, loans_returned: 0, delivered: 0, loans_given: 0, available: 0 });
}

export const usedStockUnits = (quantity: number): string =>
  `${quantity} ${quantity === 1 ? 'unidad' : 'unidades'}`;

/** The five terms of the contract, one label each: the value itself is never shown to an operator. */
export const usedStockTermLabels = {
  purchased: 'Compradas',
  factory_returns: 'Devueltas de fábrica',
  loans_returned: 'Devueltas de préstamo',
  delivered: 'Entregadas por sucursales',
  loans_given: 'Prestadas',
  available: 'Disponible',
} as const;
