/**
 * Transport of the administration of the closed catalogue of cash motives (S3, S4, S5, S10, S13).
 *
 * The catalogue is global: every category states its identity, its place in the list, its state and,
 * when it is archived, the instant and the account that archived it. A category is never deleted, so a
 * retired one stays in this list with its archive stamps and is offered back for reactivation (S3).
 *
 * Every answer is admitted only when it is JSON of exactly the contract's shape: a row whose state and
 * archive stamps disagree, an unknown key or an instant that is not RFC 3339 is not a category this
 * catalogue wrote, so it is refused whole instead of being read as evidence.
 */
import { LosslessNumber, parse as parseJSON } from 'lossless-json';
import { cashMaxCategoryLabel } from './cashAPI';

/** The two states a category can be in: offered to the branch, or archived and kept (S3). */
export type CashCategoryState = 'active' | 'retired';

/** One category of the global catalogue, exactly as the admin routes publish it. */
export interface AdminCashCategory {
  readonly id: number;
  readonly label: string;
  readonly sort_order: number;
  readonly state: CashCategoryState;
  readonly retired_at: string | null;
  readonly retired_by: string | null;
}

/** Every code this contract can answer with, including the transport ones (S13). */
export type CashCategoriesErrorCode = 'invalid_request' | 'duplicate_label' | 'category_unknown'
  | 'category_pinned' | 'last_category' | 'forbidden' | 'invalid_response' | 'network' | 'aborted';

export const cashCategoryMaxID = 2_147_483_647;

/** Admitted error envelope per HTTP status; nothing else may reach the UI. */
export const cashCategoriesAdmittedErrors: ReadonlyMap<number, readonly CashCategoriesErrorCode[]> = new Map([
  [400, ['invalid_request']],
  [403, ['forbidden']],
  [404, ['category_unknown']],
  [409, ['duplicate_label', 'category_pinned', 'last_category']],
]);

/** The read has its own words: a refused answer is not a refusal of a write. */
export const cashCategoriesListUnavailable =
  'No se pudo leer el catálogo de motivos. Revisá la conexión e intentá de nuevo.';
export const cashCategoriesLoading = 'Consultando los motivos de caja…';
export const cashCategoriesEmpty =
  'No hay motivos activos todavía: agregá el primero acá abajo. Mientras no haya ninguno, la sucursal no puede registrar un gasto.';
export const cashCategoriesArchivedEmpty = 'Todavía no hay motivos archivados.';

/** The label rule the form states before it sends anything (S13). */
export const cashCategoryLabelMessage =
  'Escribí un nombre de motivo de 1 a 500 caracteres, sin espacios al principio ni al final.';

/** Every refusal keeps its own words, never a generic failure (S13). */
export const cashCategoriesErrorMessages: Record<CashCategoriesErrorCode, string> = {
  invalid_request: 'El servidor rechazó el nombre del motivo: revisá que no quede vacío, que no pase de 500 caracteres y que no tenga espacios al principio ni al final. No se guardó nada.',
  duplicate_label: 'Ya existe un motivo con ese nombre. Elegí otro nombre: no se guardó nada.',
  category_unknown: 'Ese motivo ya no está en el catálogo. Actualizá la lista: no se guardó nada.',
  category_pinned: '«Otros gastos» no se archiva: es el cajón de sastre del catálogo. No se archivó nada.',
  last_category: 'No se puede archivar el último motivo activo: sin ninguno, la sucursal no podría registrar un gasto. No se archivó nada.',
  forbidden: 'No tenés permiso para administrar el catálogo de motivos. No se guardó nada.',
  invalid_response: 'La respuesta del servidor no es válida. Conservamos lo que escribiste: no se guardó nada.',
  network: 'No se pudo conectar con el servidor. Conservamos lo que escribiste para reintentar.',
  aborted: 'La operación se interrumpió. Conservamos lo que escribiste para reintentar.',
};

/** The duplicate label is the one refusal that names the label the catalogue already holds (S13). */
export const cashCategoryDuplicateMessage = (label: string): string =>
  `Ya existe un motivo llamado «${label}». Elegí otro nombre.`;

/** The pinned rule, stated beside the disabled action it blocks (S10). */
export const cashCategoryPinnedReason = 'No se archiva: es el cajón de sastre.';
/** The last-active rule, stated beside the disabled action it blocks (S10). */
export const cashCategoryLastActiveReason = 'No se archiva: es el último motivo activo.';

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

/** A label is the canonical text the catalogue stores: trimmed, non-empty and no longer than the bound. */
function label(value: unknown): string {
  if (typeof value !== 'string' || value === '' || value.includes('\0') || !value.isWellFormed()) {
    return invalidResponse();
  }
  if (Array.from(value).length > cashMaxCategoryLabel || value.trim() !== value) return invalidResponse();
  return value;
}

/** The acting account name of an archive stamp: a non-empty canonical text, never a blank author. */
function actor(value: unknown): string {
  if (typeof value !== 'string' || value === '' || value.includes('\0') || !value.isWellFormed()) {
    return invalidResponse();
  }
  if (value.trim() !== value) return invalidResponse();
  return value;
}

/** The catalogue's own decision of a typed label: what a create or a rename may send (S13). */
export type CashCategoryLabelValidation =
  | { readonly valid: true; readonly label: string }
  | { readonly valid: false; readonly message: string };

export function validateCashCategoryLabel(value: string): CashCategoryLabelValidation {
  const text = value.trim();
  if (text === '' || Array.from(text).length > cashMaxCategoryLabel || text.includes('\0')
    || !text.isWellFormed()) {
    return { valid: false, message: cashCategoryLabelMessage };
  }
  return { valid: true, label: text };
}

/**
 * Parses one category whole. Its state decides its archive stamps: an active row carries neither, and
 * a retired row carries both, because a retire stamps them and a reactivate clears them (S3).
 */
function category(value: unknown): AdminCashCategory {
  const record = fields(value, ['id', 'label', 'sort_order', 'state', 'retired_at', 'retired_by']);
  const id = integer(record.id, 1, cashCategoryMaxID);
  const text = label(record.label);
  const sort_order = integer(record.sort_order, 0, cashCategoryMaxID);
  if (record.state !== 'active' && record.state !== 'retired') return invalidResponse();
  const state: CashCategoryState = record.state;
  const retired_at = record.retired_at === null ? null : timestamp(record.retired_at);
  const retired_by = record.retired_by === null ? null : actor(record.retired_by);
  if ((state === 'retired') !== (retired_at !== null) || (state === 'retired') !== (retired_by !== null)) {
    return invalidResponse();
  }
  return Object.freeze({ id, label: text, sort_order, state, retired_at, retired_by });
}

/**
 * Parses the whole catalogue: the active rows and the archived ones, in the order the server states
 * them (S3, S5). No category appears twice and the list is never a missing key.
 */
export function parseAdminCashCategories(raw: string): readonly AdminCashCategory[] {
  const record = fields(decode(raw), ['categories']);
  if (!Array.isArray(record.categories)) return invalidResponse();
  const seenID = new Set<number>();
  const seenLabel = new Set<string>();
  const categories = record.categories.map((entry: unknown) => {
    const one = category(entry);
    if (seenID.has(one.id) || seenLabel.has(one.label)) return invalidResponse();
    seenID.add(one.id);
    seenLabel.add(one.label);
    return one;
  });
  return Object.freeze(categories);
}

/** Parses the single category a write answers with. */
export function parseAdminCashCategory(raw: string): AdminCashCategory {
  const record = fields(decode(raw), ['category']);
  return category(record.category);
}

export function parseCashCategoriesError(raw: string, status: number): CashCategoriesErrorCode {
  const admitted = cashCategoriesAdmittedErrors.get(status);
  if (!admitted) return invalidResponse();
  const envelope = fields(decode(raw), ['error']);
  const code = envelope.error;
  if (typeof code !== 'string' || !admitted.includes(code as CashCategoriesErrorCode)) {
    return invalidResponse();
  }
  return code as CashCategoriesErrorCode;
}

export class CashCategoriesAPIError extends Error {
  constructor(public readonly code: CashCategoriesErrorCode, public readonly status: number | null = null) {
    super(code); this.name = 'CashCategoriesAPIError';
  }
}

// Every answer is admitted only when it is JSON of exactly the contract's shape.
const jsonHeader = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;
const csrfToken = /^[A-Za-z0-9_-]+$/;
const collectionPath = '/api/admin/cash-categories';
const actionPath = (id: number, action: 'rename' | 'retire' | 'reactivate') =>
  `${collectionPath}/${id}/${action}`;
const validID = (id: number) => Number.isInteger(id) && id >= 1 && id <= cashCategoryMaxID;

function transportError(signal: AbortSignal | undefined, error: unknown): CashCategoriesAPIError {
  const aborted = signal?.aborted === true
    || (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError');
  return new CashCategoriesAPIError(aborted ? 'aborted' : 'network', null);
}

export function createCashCategoriesAPI(fetch: typeof globalThis.fetch = globalThis.fetch) {
  /** The whole catalogue: the active rows and the archived ones, in the catalogue's own order. */
  async function list(signal?: AbortSignal): Promise<readonly AdminCashCategory[]> {
    let reply: Response;
    let raw: string;
    try {
      reply = await fetch(collectionPath, { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal });
      raw = await reply.text();
    } catch (error) { throw transportError(signal, error); }
    const malformed = () => new CashCategoriesAPIError('invalid_response', reply.status);
    // A proxy page or a non-JSON body is never evidence about the catalogue.
    if (!jsonHeader.test(reply.headers.get('Content-Type') ?? '')) throw malformed();
    if (reply.status !== 200) {
      let code: CashCategoriesErrorCode;
      try { code = parseCashCategoriesError(raw, reply.status); } catch { throw malformed(); }
      throw new CashCategoriesAPIError(code, reply.status);
    }
    try { return parseAdminCashCategories(raw); } catch { throw malformed(); }
  }

  /**
   * Creates one category at the end of the list. The payload carries the label alone: the identifier
   * and the next `sort_order` are the server's, so the reply is admitted when it repeats that label
   * as an active row (S5).
   */
  async function create(value: string, csrf: string, signal?: AbortSignal): Promise<AdminCashCategory> {
    const validation = validateCashCategoryLabel(value);
    if (!validation.valid) throw new CashCategoriesAPIError('invalid_request', null);
    const record = await write(collectionPath, JSON.stringify({ label: validation.label }), csrf, signal, 201);
    if (record.label !== validation.label || record.state !== 'active') {
      throw new CashCategoriesAPIError('invalid_response', null);
    }
    return record;
  }

  /** Renames one category, leaving the label already copied into recorded expenses untouched (S4). */
  async function rename(id: number, value: string, csrf: string,
    signal?: AbortSignal): Promise<AdminCashCategory> {
    if (!validID(id)) throw new CashCategoriesAPIError('invalid_request', null);
    const validation = validateCashCategoryLabel(value);
    if (!validation.valid) throw new CashCategoriesAPIError('invalid_request', null);
    const record = await write(actionPath(id, 'rename'), JSON.stringify({ label: validation.label }),
      csrf, signal, 200);
    if (record.id !== id || record.label !== validation.label) {
      throw new CashCategoriesAPIError('invalid_response', null);
    }
    return record;
  }

  /** Archives one category: it keeps its identity, its place and its pin, and is never deleted (S3). */
  async function retire(id: number, csrf: string, signal?: AbortSignal): Promise<AdminCashCategory> {
    if (!validID(id)) throw new CashCategoriesAPIError('invalid_request', null);
    const record = await write(actionPath(id, 'retire'), null, csrf, signal, 200);
    if (record.id !== id || record.state !== 'retired') {
      throw new CashCategoriesAPIError('invalid_response', null);
    }
    return record;
  }

  /** Brings one archived category back into the selector by clearing its archive stamps (S3). */
  async function reactivate(id: number, csrf: string, signal?: AbortSignal): Promise<AdminCashCategory> {
    if (!validID(id)) throw new CashCategoriesAPIError('invalid_request', null);
    const record = await write(actionPath(id, 'reactivate'), null, csrf, signal, 200);
    if (record.id !== id || record.state !== 'active') {
      throw new CashCategoriesAPIError('invalid_response', null);
    }
    return record;
  }

  async function write(path: string, body: string | null, csrf: string, signal: AbortSignal | undefined,
    status: 200 | 201): Promise<AdminCashCategory> {
    // Capture the token before any await: a caller cannot reclassify an in-flight write.
    if (typeof csrf !== 'string' || !csrfToken.test(csrf)) {
      throw new CashCategoriesAPIError('invalid_request', null);
    }
    const headers: Record<string, string> = { 'X-CSRF-Token': csrf };
    if (body !== null) headers['Content-Type'] = 'application/json';
    let reply: Response;
    let raw: string;
    try {
      reply = await fetch(path, { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal, headers,
        ...(body === null ? {} : { body }) });
      raw = await reply.text();
    } catch (error) { throw transportError(signal, error); }
    const malformed = () => new CashCategoriesAPIError('invalid_response', reply.status);
    if (!jsonHeader.test(reply.headers.get('Content-Type') ?? '')) throw malformed();
    if (reply.status !== status) {
      let code: CashCategoriesErrorCode;
      try { code = parseCashCategoriesError(raw, reply.status); } catch { throw malformed(); }
      throw new CashCategoriesAPIError(code, reply.status);
    }
    try { return parseAdminCashCategory(raw); } catch { throw malformed(); }
  }

  return { list, create, rename, retire, reactivate };
}
