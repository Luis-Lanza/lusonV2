import {
  canonicalSupplierDraft, canonicalSupplierOffers, matchesSupplierOffers, matchesSupplierRecord,
  parseSupplierCatalogPage, parseSupplierDetail, parseSupplierListPage, parseSupplierRecord,
  parseSuppliersError, supplierCatalogPath, supplierListPath, supplierOffersPath, supplierPath,
  validSupplierCatalogQuery, validSupplierID, validSupplierListQuery,
  type SupplierCatalogPage, type SupplierCatalogQuery, type SupplierDetail, type SupplierDraft,
  type SupplierInput, type SupplierListPage, type SupplierListQuery, type SupplierRecord,
  type SuppliersErrorCode,
} from './catalogSuppliersModel';

/** One refused supplier operation: the code, and the status the server answered. */
export class SuppliersAPIError extends Error {
  constructor(public readonly code: SuppliersErrorCode, public readonly status: number | null = null) {
    super(code); this.name = 'SuppliersAPIError';
  }
}

// Every answer is admitted only when it is JSON of exactly the contract's shape.
const jsonHeader = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;
const csrfToken = /^[A-Za-z0-9_-]+$/;

function transportError(signal: AbortSignal | undefined, error: unknown): SuppliersAPIError {
  const aborted = signal?.aborted === true
    || (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError');
  return new SuppliersAPIError(aborted ? 'aborted' : 'network', null);
}

export function createSuppliersAPI(fetch: typeof globalThis.fetch = globalThis.fetch) {
  /** One read that admits only its own 200 answer and decodes it strictly. */
  async function read<T>(path: string, signal: AbortSignal | undefined, decode: (raw: string) => T): Promise<T> {
    let reply: Response;
    let raw: string;
    try {
      reply = await fetch(path, { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal });
      raw = await reply.text();
    } catch (error) { throw transportError(signal, error); }
    const malformed = () => new SuppliersAPIError('invalid_response', reply.status);
    // A proxy page or a non-JSON body is never evidence about the suppliers.
    if (!jsonHeader.test(reply.headers.get('Content-Type') ?? '')) throw malformed();
    if (reply.status !== 200) {
      let code: SuppliersErrorCode;
      try { code = parseSuppliersError(raw, reply.status); } catch { throw malformed(); }
      throw new SuppliersAPIError(code, reply.status);
    }
    try { return decode(raw); } catch { throw malformed(); }
  }

  /** One page of the warehouse suppliers, decoded strictly against the frozen query. */
  async function list(query: SupplierListQuery, signal?: AbortSignal): Promise<SupplierListPage> {
    let path: string;
    try {
      if (!validSupplierListQuery(query)) throw new Error('Invalid query');
      path = supplierListPath(query);
    } catch { throw new SuppliersAPIError('invalid_request', null); }
    const page = await read(path, signal, parseSupplierListPage);
    // A page that does not answer the exact query is not evidence about it.
    if (page.page !== query.page || page.page_size !== query.page_size) {
      throw new SuppliersAPIError('invalid_response', null);
    }
    return page;
  }

  /** One supplier with the complete set of entries it offers. */
  async function detail(id: number, signal?: AbortSignal): Promise<SupplierDetail> {
    let path: string;
    try { path = supplierPath(id); } catch { throw new SuppliersAPIError('invalid_request', null); }
    return read(path, signal, parseSupplierDetail);
  }

  /** One page of the assignable catalogue entries, filtered by kind and search. */
  async function catalog(query: SupplierCatalogQuery, signal?: AbortSignal): Promise<SupplierCatalogPage> {
    let path: string;
    try {
      if (!validSupplierCatalogQuery(query)) throw new Error('Invalid query');
      path = supplierCatalogPath(query);
    } catch { throw new SuppliersAPIError('invalid_request', null); }
    const page = await read(path, signal, parseSupplierCatalogPage);
    if (page.page_size !== query.page_size) throw new SuppliersAPIError('invalid_response', null);
    return page;
  }

  /**
   * Creates one supplier. The payload carries the trimmed name and contact only:
   * the identifier is the database's, so the reply must repeat exactly that write.
   */
  async function create(input: SupplierDraft, csrf: string, signal?: AbortSignal): Promise<SupplierRecord> {
    let body: string;
    let sent: SupplierInput;
    try {
      if (typeof csrf !== 'string' || !csrfToken.test(csrf)) throw new Error('Missing CSRF token');
      sent = canonicalSupplierDraft(input);
      body = JSON.stringify(sent);
    } catch { throw new SuppliersAPIError('invalid_request', null); }
    return write('POST', '/api/suppliers', body, csrf, signal, 201, sent);
  }

  /** Edits one active supplier: `PATCH` replaces the name and the contact together. */
  async function edit(id: number, input: SupplierDraft, csrf: string,
    signal?: AbortSignal): Promise<SupplierRecord> {
    let body: string;
    let sent: SupplierInput;
    try {
      if (!validSupplierID(id)) throw new Error('Invalid supplier');
      if (typeof csrf !== 'string' || !csrfToken.test(csrf)) throw new Error('Missing CSRF token');
      sent = canonicalSupplierDraft(input);
      body = JSON.stringify(sent);
    } catch { throw new SuppliersAPIError('invalid_request', null); }
    return write('PATCH', supplierPath(id), body, csrf, signal, 200, sent);
  }

  async function write(method: 'POST' | 'PATCH', path: string, body: string, csrf: string,
    signal: AbortSignal | undefined, status: 200 | 201, sent: SupplierInput,
  ): Promise<SupplierRecord> {
    let reply: Response;
    let raw: string;
    try {
      reply = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store', signal,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body });
      raw = await reply.text();
    } catch (error) { throw transportError(signal, error); }
    const malformed = () => new SuppliersAPIError('invalid_response', reply.status);
    if (!jsonHeader.test(reply.headers.get('Content-Type') ?? '')) throw malformed();
    if (reply.status !== status) {
      let code: SuppliersErrorCode;
      try { code = parseSuppliersError(raw, reply.status); } catch { throw malformed(); }
      throw new SuppliersAPIError(code, reply.status);
    }
    let record: SupplierRecord;
    try { record = parseSupplierRecord(raw); } catch { throw malformed(); }
    // The reply must repeat the exact supplier this client wrote.
    if (!matchesSupplierRecord(sent, record)) throw malformed();
    return record;
  }

  /**
   * Retires one supplier. Retirement is one way and it has no body: the only answer
   * that means it happened is the empty 204.
   */
  async function retire(id: number, csrf: string, signal?: AbortSignal): Promise<void> {
    try {
      if (!validSupplierID(id)) throw new Error('Invalid supplier');
      if (typeof csrf !== 'string' || !csrfToken.test(csrf)) throw new Error('Missing CSRF token');
    } catch { throw new SuppliersAPIError('invalid_request', null); }
    let reply: Response;
    let raw: string;
    try {
      reply = await fetch(supplierPath(id), { method: 'DELETE', credentials: 'same-origin', cache: 'no-store', signal,
        headers: { 'X-CSRF-Token': csrf } });
      raw = await reply.text();
    } catch (error) { throw transportError(signal, error); }
    if (reply.status === 204) return;
    const malformed = () => new SuppliersAPIError('invalid_response', reply.status);
    let code: SuppliersErrorCode;
    try { code = parseSuppliersError(raw, reply.status); } catch { throw malformed(); }
    throw new SuppliersAPIError(code, reply.status);
  }

  /**
   * Replaces the complete set of entries one supplier offers in a single `PUT`. An
   * empty list is a valid set: the supplier offers nothing. The reply must repeat
   * exactly that set, whatever order the server lists it in.
   */
  async function saveOffers(id: number, ids: readonly number[], csrf: string,
    signal?: AbortSignal): Promise<SupplierDetail> {
    let body: string;
    let sent: readonly number[];
    let path: string;
    try {
      if (!validSupplierID(id)) throw new Error('Invalid supplier');
      if (typeof csrf !== 'string' || !csrfToken.test(csrf)) throw new Error('Missing CSRF token');
      sent = canonicalSupplierOffers(ids);
      path = supplierOffersPath(id);
      body = JSON.stringify({ catalog_entry_ids: sent });
    } catch { throw new SuppliersAPIError('invalid_request', null); }
    let reply: Response;
    let raw: string;
    try {
      reply = await fetch(path, { method: 'PUT', credentials: 'same-origin', cache: 'no-store', signal,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body });
      raw = await reply.text();
    } catch (error) { throw transportError(signal, error); }
    const malformed = () => new SuppliersAPIError('invalid_response', reply.status);
    if (!jsonHeader.test(reply.headers.get('Content-Type') ?? '')) throw malformed();
    if (reply.status !== 200) {
      let code: SuppliersErrorCode;
      try { code = parseSuppliersError(raw, reply.status); } catch { throw malformed(); }
      throw new SuppliersAPIError(code, reply.status);
    }
    let detail: SupplierDetail;
    try { detail = parseSupplierDetail(raw); } catch { throw malformed(); }
    if (!matchesSupplierOffers(sent, detail)) throw malformed();
    return detail;
  }

  return { list, detail, catalog, create, edit, retire, saveOffers };
}
