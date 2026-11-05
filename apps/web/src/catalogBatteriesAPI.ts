import { catalogPricesPath, validCatalogPricesQuery, type CatalogPricesQuery } from './catalogPricesModel';
import {
  canonicalCatalogBatteryCreate, canonicalCatalogBatteryIdentity, catalogBatteriesMaxID,
  matchesCatalogBatteryCreate, matchesCatalogBatteryIdentity, parseCatalogBatteriesError,
  parseCatalogBattery, parseCatalogBatteryPage,
  type CatalogBatteriesErrorCode, type CatalogBatteryDraft, type CatalogBatteryIdentity,
  type CatalogBatteryPage, type CatalogBatteryRecord,
} from './catalogBatteriesModel';

/** One refused battery operation: the code, and the status the server answered. */
export class CatalogBatteriesAPIError extends Error {
  constructor(public readonly code: CatalogBatteriesErrorCode, public readonly status: number | null = null) {
    super(code); this.name = 'CatalogBatteriesAPIError';
  }
}

// Every answer is admitted only when it is JSON of exactly the contract's shape.
const jsonHeader = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;
const csrfToken = /^[A-Za-z0-9_-]+$/;
const batteryPath = (id: number) => `/api/catalog/batteries/${id}`;
const validID = (id: number) => Number.isInteger(id) && id >= 1 && id <= catalogBatteriesMaxID;

function transportError(signal: AbortSignal | undefined, error: unknown): CatalogBatteriesAPIError {
  const aborted = signal?.aborted === true
    || (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError');
  return new CatalogBatteriesAPIError(aborted ? 'aborted' : 'network', null);
}

export function createCatalogBatteriesAPI(fetch: typeof globalThis.fetch = globalThis.fetch) {
  /** The catalog's only battery read: the frozen price matrix query, decoded strictly. */
  async function list(query: CatalogPricesQuery, signal?: AbortSignal): Promise<CatalogBatteryPage> {
    let path: string;
    try {
      if (!validCatalogPricesQuery(query)) throw new Error('Invalid query');
      path = catalogPricesPath(query);
    } catch { throw new CatalogBatteriesAPIError('invalid_request', null); }
    let reply: Response;
    let raw: string;
    try {
      reply = await fetch(path, { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal });
      raw = await reply.text();
    } catch (error) { throw transportError(signal, error); }
    const malformed = () => new CatalogBatteriesAPIError('invalid_response', reply.status);
    // A proxy page or a non-JSON body is never evidence about the catalogue.
    if (!jsonHeader.test(reply.headers.get('Content-Type') ?? '')) throw malformed();
    if (reply.status !== 200) {
      let code: CatalogBatteriesErrorCode;
      try { code = parseCatalogBatteriesError(raw, reply.status); } catch { throw malformed(); }
      throw new CatalogBatteriesAPIError(code, reply.status);
    }
    let page: CatalogBatteryPage;
    try { page = parseCatalogBatteryPage(raw); } catch { throw malformed(); }
    // A page that does not answer the exact query is not evidence about it.
    if (page.page !== query.page || page.page_size !== query.page_size) throw malformed();
    return page;
  }

  /**
   * Creates one battery with its variants. The payload carries the identity and the
   * polarities only: identifiers are the database's, so the reply is admitted when it
   * repeats exactly that write and its allocated ids are the ones the screen shows.
   */
  async function create(input: CatalogBatteryDraft, csrf: string,
    signal?: AbortSignal): Promise<CatalogBatteryRecord> {
    // Capture the exact payload and the token before any await: callers cannot
    // reclassify an in-flight write by mutating their draft object.
    let body: string;
    let sent: CatalogBatteryDraft;
    try {
      if (typeof csrf !== 'string' || !csrfToken.test(csrf)) throw new Error('Missing CSRF token');
      sent = canonicalCatalogBatteryCreate(input);
      body = JSON.stringify(sent);
    } catch { throw new CatalogBatteriesAPIError('invalid_request', null); }
    let reply: Response;
    let raw: string;
    try {
      reply = await fetch('/api/catalog/batteries', { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body });
      raw = await reply.text();
    } catch (error) { throw transportError(signal, error); }
    const malformed = () => new CatalogBatteriesAPIError('invalid_response', reply.status);
    if (!jsonHeader.test(reply.headers.get('Content-Type') ?? '')) throw malformed();
    if (reply.status !== 201) {
      let code: CatalogBatteriesErrorCode;
      try { code = parseCatalogBatteriesError(raw, reply.status); } catch { throw malformed(); }
      throw new CatalogBatteriesAPIError(code, reply.status);
    }
    let record: CatalogBatteryRecord;
    try { record = parseCatalogBattery(raw); } catch { throw malformed(); }
    // The reply must repeat the exact battery this client wrote, polarities included.
    if (!matchesCatalogBatteryCreate(sent, record)) throw malformed();
    return record;
  }

  /**
   * Edits the complete identity of an active battery. Ids and variants never travel:
   * a partial edit is refused instead of merged.
   */
  async function edit(id: number, input: CatalogBatteryIdentity, csrf: string,
    signal?: AbortSignal): Promise<CatalogBatteryRecord> {
    let body: string;
    let sent: CatalogBatteryIdentity;
    try {
      if (!validID(id)) throw new Error('Invalid battery');
      if (typeof csrf !== 'string' || !csrfToken.test(csrf)) throw new Error('Missing CSRF token');
      sent = canonicalCatalogBatteryIdentity(input);
      body = JSON.stringify(sent);
    } catch { throw new CatalogBatteriesAPIError('invalid_request', null); }
    let reply: Response;
    let raw: string;
    try {
      reply = await fetch(batteryPath(id), { method: 'PATCH', credentials: 'same-origin', cache: 'no-store', signal,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body });
      raw = await reply.text();
    } catch (error) { throw transportError(signal, error); }
    const malformed = () => new CatalogBatteriesAPIError('invalid_response', reply.status);
    if (!jsonHeader.test(reply.headers.get('Content-Type') ?? '')) throw malformed();
    if (reply.status !== 200) {
      let code: CatalogBatteriesErrorCode;
      try { code = parseCatalogBatteriesError(raw, reply.status); } catch { throw malformed(); }
      throw new CatalogBatteriesAPIError(code, reply.status);
    }
    let record: CatalogBatteryRecord;
    try { record = parseCatalogBattery(raw); } catch { throw malformed(); }
    if (!matchesCatalogBatteryIdentity(sent, record)) throw malformed();
    return record;
  }

  /**
   * Retires one battery. Retirement is one way and it has no body: the only answer
   * that means it happened is the empty 204.
   */
  async function archive(id: number, csrf: string, signal?: AbortSignal): Promise<void> {
    try {
      if (!validID(id)) throw new Error('Invalid battery');
      if (typeof csrf !== 'string' || !csrfToken.test(csrf)) throw new Error('Missing CSRF token');
    } catch { throw new CatalogBatteriesAPIError('invalid_request', null); }
    let reply: Response;
    let raw: string;
    try {
      reply = await fetch(batteryPath(id), { method: 'DELETE', credentials: 'same-origin', cache: 'no-store', signal,
        headers: { 'X-CSRF-Token': csrf } });
      raw = await reply.text();
    } catch (error) { throw transportError(signal, error); }
    if (reply.status === 204) return;
    const malformed = () => new CatalogBatteriesAPIError('invalid_response', reply.status);
    let code: CatalogBatteriesErrorCode;
    try { code = parseCatalogBatteriesError(raw, reply.status); } catch { throw malformed(); }
    throw new CatalogBatteriesAPIError(code, reply.status);
  }

  return { list, create, edit, archive };
}
