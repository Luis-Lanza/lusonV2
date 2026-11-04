import { LosslessNumber, parse as parseJSON } from 'lossless-json';
import { parseInventory, queryURL, type Item } from './model';
import { newTransferRetryKey } from './transferModel';

// Warehouse ingress contract: one document, applied atomically or not at all.
export interface StockEntryLineInput { readonly variant_id: number; readonly quantity: number }
export interface StockEntryInput {
  readonly operation_key: string; readonly note?: string; readonly lines: readonly StockEntryLineInput[];
}
export interface StockEntryLine { readonly variant_id: number; readonly quantity: number }
export interface StockEntryRecord {
  readonly id: number; readonly location_id: number; readonly note: string;
  readonly created_by_account_id: number; readonly created_at: string;
  readonly lines: readonly StockEntryLine[]; readonly total_units: number;
}
export type StockEntryErrorCode = 'invalid_request' | 'forbidden' | 'retry_conflict'
  | 'insufficient_stock' | 'service_unavailable' | 'invalid_response' | 'network' | 'aborted';

export const stockEntryMaxLines = 190;
export const stockEntryMaxQuantity = 1_000_000;
export const stockEntryMaxNote = 500;
export const stockEntryMaxVariantID = 2_147_483_647;
export const stockCatalogLocationID = 1;
export const stockCatalogPageSize = 50;

/** Admitted error envelope per HTTP status; nothing else may reach the UI. */
export const stockEntryAdmittedErrors: ReadonlyMap<number, readonly StockEntryErrorCode[]> = new Map([
  [400, ['invalid_request']],
  [403, ['forbidden']],
  [409, ['retry_conflict', 'insufficient_stock']],
  [503, ['service_unavailable']],
]);

/** Spanish user-facing message for every code, including transport failures. */
export const stockEntryErrorMessages: Record<StockEntryErrorCode, string> = {
  invalid_request: 'El documento no es válido. Revisá las líneas y la nota, y volvé a intentar.',
  forbidden: 'No tenés permiso para registrar ingresos en este almacén. No se aplicó ningún cambio.',
  retry_conflict: 'La clave de este ingreso ya se usó con otro contenido. No se aplicó ningún cambio: revisá el documento.',
  insufficient_stock: 'El servidor rechazó el ingreso. No se aplicó ningún cambio en el stock.',
  service_unavailable: 'El servicio no está disponible. No pudimos confirmar el ingreso: conservamos el documento para reintentar.',
  invalid_response: 'La respuesta del servidor no es válida. No pudimos confirmar el ingreso: conservamos el documento.',
  network: 'No se pudo conectar con el servidor. Conservamos el documento para reintentar el mismo ingreso.',
  aborted: 'La confirmación se interrumpió. Conservamos el documento para reintentar el mismo ingreso.',
};

function invalidResponse(): never { throw new Error('Respuesta inválida del servidor.'); }
function invalidInput(): never { throw new Error('Documento de ingreso inválido.'); }

function decode(raw: string): unknown {
  try {
    return parseJSON(raw, null, { onDuplicateKey: () => { throw new Error('duplicate key'); } });
  } catch { return invalidResponse(); }
}
function fields(value: unknown, keys: readonly string[], required = true): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof LosslessNumber) return invalidResponse();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !keys.includes(key))) return invalidResponse();
  if (required && keys.some(key => !Object.hasOwn(record, key))) return invalidResponse();
  return record;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value || value.includes('\0') || !value.isWellFormed()) return invalidResponse();
  return value;
}
// Default lossless parsing keeps every digit; numbers are never coerced to a float first.
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
function validNote(value: string): boolean {
  return value.isWellFormed() && !value.includes('\0') && Array.from(value).length <= stockEntryMaxNote;
}
function note(value: unknown): string {
  if (typeof value !== 'string' || !validNote(value)) return invalidResponse();
  return value;
}
function timestamp(value: unknown): string {
  const raw = text(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.test(raw)) return invalidResponse();
  // Reject impossible calendar or clock values without rewriting the original text.
  const seconds = raw.slice(0, 19) + 'Z';
  const date = new Date(seconds);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19) !== raw.slice(0, 19)) return invalidResponse();
  if (!Number.isFinite(Date.parse(raw))) return invalidResponse();
  return raw;
}

export function validStockQuantity(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= stockEntryMaxQuantity;
}

function canonicalInput(input: StockEntryInput): StockEntryInput {
  // note is optional in the contract; everything else must be present and nothing else is admitted.
  const record = fields(input, ['operation_key', 'note', 'lines'], false);
  const operation_key = record.operation_key;
  if (typeof operation_key !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(operation_key)) return invalidResponse();
  if (!Array.isArray(record.lines) || record.lines.length < 1 || record.lines.length > stockEntryMaxLines) return invalidResponse();
  const seen = new Set<number>();
  const lines = record.lines.map(value => {
    const line = fields(value, ['variant_id', 'quantity']);
    const variant_id = typeof line.variant_id === 'number' && Number.isInteger(line.variant_id)
      && line.variant_id >= 1 && line.variant_id <= stockEntryMaxVariantID ? line.variant_id : invalidResponse();
    const quantity = typeof line.quantity === 'number' && validStockQuantity(line.quantity) ? line.quantity : invalidResponse();
    if (seen.has(variant_id)) return invalidResponse();
    seen.add(variant_id);
    return Object.freeze({ variant_id, quantity });
  }).sort((left, right) => left.variant_id - right.variant_id);
  const draftNote = record.note === undefined ? '' : note(record.note);
  return Object.freeze({ operation_key, ...(draftNote === '' ? {} : { note: draftNote }), lines: Object.freeze(lines) });
}

/** Validates and normalizes a draft; the same ordered payload is sent and compared. */
export function canonicalStockEntryInput(input: StockEntryInput): StockEntryInput {
  try { return canonicalInput(input); } catch { return invalidInput(); }
}

export function newStockEntryOperationKey(source: Pick<Crypto, 'getRandomValues'> | undefined = globalThis.crypto): string {
  // Same secure generator as transfer creation; Math.random is never acceptable here.
  return newTransferRetryKey(source);
}

export function parseStockEntryRecord(raw: string): StockEntryRecord {
  const record = fields(decode(raw), ['id', 'location_id', 'note', 'created_by_account_id', 'created_at', 'lines', 'total_units']);
  const id = integer(record.id, 1, Number.MAX_SAFE_INTEGER);
  const location_id = integer(record.location_id, 1, 32767);
  const created_by_account_id = integer(record.created_by_account_id, 1, Number.MAX_SAFE_INTEGER);
  const created_at = timestamp(record.created_at);
  if (!Array.isArray(record.lines) || record.lines.length < 1 || record.lines.length > stockEntryMaxLines) return invalidResponse();
  const seen = new Set<number>();
  const lines = record.lines.map(value => {
    const line = fields(value, ['variant_id', 'quantity']);
    const variant_id = integer(line.variant_id, 1, stockEntryMaxVariantID);
    const quantity = integer(line.quantity, 1, stockEntryMaxQuantity);
    if (seen.has(variant_id)) return invalidResponse();
    seen.add(variant_id);
    return Object.freeze({ variant_id, quantity });
  });
  const total_units = integer(record.total_units, 1, stockEntryMaxLines * stockEntryMaxQuantity);
  return Object.freeze({ id, location_id, note: note(record.note), created_by_account_id, created_at,
    lines: Object.freeze(lines), total_units });
}

export function parseStockEntryError(raw: string, status: number): StockEntryErrorCode {
  const admitted = stockEntryAdmittedErrors.get(status);
  if (!admitted) return invalidResponse();
  const envelope = fields(decode(raw), ['error']);
  const code = envelope.error;
  if (typeof code !== 'string' || !admitted.includes(code as StockEntryErrorCode)) return invalidResponse();
  return code as StockEntryErrorCode;
}

/** A definite rejection proves nothing was written; every other failure stays uncertain. */
export function stockEntryFailureIsDefinite(code: StockEntryErrorCode): boolean {
  return code === 'invalid_request' || code === 'forbidden' || code === 'retry_conflict' || code === 'insufficient_stock';
}

/** The response is evidence only if it repeats the exact payload this client sent. */
export function matchesStockEntryInput(input: StockEntryInput, record: StockEntryRecord): boolean {
  let expected: StockEntryInput;
  try { expected = canonicalStockEntryInput(input); } catch { return false; }
  if (record.location_id !== stockCatalogLocationID) return false;
  if (record.lines.length !== expected.lines.length) return false;
  const total = expected.lines.reduce((sum, line) => sum + line.quantity, 0);
  if (record.total_units !== total) return false;
  if (record.lines.reduce((sum, line) => sum + line.quantity, 0) !== record.total_units) return false;
  const lines = [...record.lines].sort((left, right) => left.variant_id - right.variant_id);
  return expected.lines.every((line, index) => lines[index].variant_id === line.variant_id && lines[index].quantity === line.quantity);
}

/** Reuses the existing inventory read contract; no new catalog endpoint. */
export function stockCatalogPath(search: string): string {
  return queryURL({ location: stockCatalogLocationID, search, brand: '', polarity: '', page: 1, size: stockCatalogPageSize });
}

export function parseStockCatalog(raw: string): readonly Item[] {
  const page = parseInventory(raw);
  if (page.location.id !== stockCatalogLocationID || page.page !== 1 || page.page_size !== stockCatalogPageSize) return invalidResponse();
  return Object.freeze(page.items);
}
