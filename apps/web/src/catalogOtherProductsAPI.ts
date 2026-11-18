import {
  canonicalCatalogOtherProduct, catalogOtherProductsMaxID, catalogOtherProductsPath,
  matchesCatalogOtherProduct, parseCatalogOtherProduct, parseCatalogOtherProductPage,
  parseCatalogOtherProductsError, validCatalogOtherProductsQuery,
  type CatalogOtherProductsErrorCode, type CatalogOtherProductDraft, type CatalogOtherProductPage,
  type CatalogOtherProductRecord, type CatalogOtherProductsQuery,
} from './catalogOtherProductsModel';

/** One refused other-product operation: the code, and the status the server answered. */
export class CatalogOtherProductsAPIError extends Error {
  constructor(public readonly code: CatalogOtherProductsErrorCode, public readonly status: number | null = null) {
    super(code); this.name = 'CatalogOtherProductsAPIError';
  }
}

// Every answer is admitted only when it is JSON of exactly the contract's shape.
const jsonHeader = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;
const csrfToken = /^[A-Za-z0-9_-]+$/;
const collectionPath = '/api/catalog/other-products';
const productPath = (id: number) => `${collectionPath}/${id}`;
const validID = (id: number) => Number.isInteger(id) && id >= 1 && id <= catalogOtherProductsMaxID;

function transportError(signal: AbortSignal | undefined, error: unknown): CatalogOtherProductsAPIError {
  const aborted = signal?.aborted === true
    || (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError');
  return new CatalogOtherProductsAPIError(aborted ? 'aborted' : 'network', null);
}

export function createCatalogOtherProductsAPI(fetch: typeof globalThis.fetch = globalThis.fetch) {
  /** One page of the active catalogue, decoded strictly against the frozen query. */
  async function list(query: CatalogOtherProductsQuery, signal?: AbortSignal): Promise<CatalogOtherProductPage> {
    let path: string;
    try {
      if (!validCatalogOtherProductsQuery(query)) throw new Error('Invalid query');
      path = catalogOtherProductsPath(query);
    } catch { throw new CatalogOtherProductsAPIError('invalid_request', null); }
    let reply: Response;
    let raw: string;
    try {
      reply = await fetch(path, { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal });
      raw = await reply.text();
    } catch (error) { throw transportError(signal, error); }
    const malformed = () => new CatalogOtherProductsAPIError('invalid_response', reply.status);
    // A proxy page or a non-JSON body is never evidence about the catalogue.
    if (!jsonHeader.test(reply.headers.get('Content-Type') ?? '')) throw malformed();
    if (reply.status !== 200) {
      let code: CatalogOtherProductsErrorCode;
      try { code = parseCatalogOtherProductsError(raw, reply.status); } catch { throw malformed(); }
      throw new CatalogOtherProductsAPIError(code, reply.status);
    }
    let page: CatalogOtherProductPage;
    try { page = parseCatalogOtherProductPage(raw); } catch { throw malformed(); }
    // A page that does not answer the exact query is not evidence about it.
    if (page.page !== query.page || page.page_size !== query.page_size) throw malformed();
    return page;
  }

  /**
   * Creates one product with its typed fields. The payload carries the name and the
   * whole field set only: the identifier is the database's, so the reply is admitted
   * when it repeats exactly that write.
   */
  async function create(input: CatalogOtherProductDraft, csrf: string,
    signal?: AbortSignal): Promise<CatalogOtherProductRecord> {
    // Capture the exact payload and the token before any await: callers cannot
    // reclassify an in-flight write by mutating their draft object.
    let body: string;
    let sent: CatalogOtherProductDraft;
    try {
      if (typeof csrf !== 'string' || !csrfToken.test(csrf)) throw new Error('Missing CSRF token');
      sent = canonicalCatalogOtherProduct(input);
      body = JSON.stringify(sent);
    } catch { throw new CatalogOtherProductsAPIError('invalid_request', null); }
    return write('POST', collectionPath, body, csrf, signal, 201, sent);
  }

  /**
   * Edits one active product. `PATCH` replaces the whole field set instead of
   * merging it, so a partial edit is refused before it leaves this client.
   */
  async function edit(id: number, input: CatalogOtherProductDraft, csrf: string,
    signal?: AbortSignal): Promise<CatalogOtherProductRecord> {
    let body: string;
    let sent: CatalogOtherProductDraft;
    try {
      if (!validID(id)) throw new Error('Invalid product');
      if (typeof csrf !== 'string' || !csrfToken.test(csrf)) throw new Error('Missing CSRF token');
      sent = canonicalCatalogOtherProduct(input);
      body = JSON.stringify(sent);
    } catch { throw new CatalogOtherProductsAPIError('invalid_request', null); }
    return write('PATCH', productPath(id), body, csrf, signal, 200, sent);
  }

  async function write(method: 'POST' | 'PATCH', path: string, body: string, csrf: string,
    signal: AbortSignal | undefined, status: 200 | 201, sent: CatalogOtherProductDraft,
  ): Promise<CatalogOtherProductRecord> {
    let reply: Response;
    let raw: string;
    try {
      reply = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store', signal,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body });
      raw = await reply.text();
    } catch (error) { throw transportError(signal, error); }
    const malformed = () => new CatalogOtherProductsAPIError('invalid_response', reply.status);
    if (!jsonHeader.test(reply.headers.get('Content-Type') ?? '')) throw malformed();
    if (reply.status !== status) {
      let code: CatalogOtherProductsErrorCode;
      try { code = parseCatalogOtherProductsError(raw, reply.status); } catch { throw malformed(); }
      throw new CatalogOtherProductsAPIError(code, reply.status);
    }
    let record: CatalogOtherProductRecord;
    try { record = parseCatalogOtherProduct(raw); } catch { throw malformed(); }
    // The reply must repeat the exact product this client wrote.
    if (!matchesCatalogOtherProduct(sent, record)) throw malformed();
    return record;
  }

  /**
   * Retires one product. Retirement is one way and it has no body: the only answer
   * that means it happened is the empty 204.
   */
  async function archive(id: number, csrf: string, signal?: AbortSignal): Promise<void> {
    try {
      if (!validID(id)) throw new Error('Invalid product');
      if (typeof csrf !== 'string' || !csrfToken.test(csrf)) throw new Error('Missing CSRF token');
    } catch { throw new CatalogOtherProductsAPIError('invalid_request', null); }
    let reply: Response;
    let raw: string;
    try {
      reply = await fetch(productPath(id), { method: 'DELETE', credentials: 'same-origin', cache: 'no-store', signal,
        headers: { 'X-CSRF-Token': csrf } });
      raw = await reply.text();
    } catch (error) { throw transportError(signal, error); }
    if (reply.status === 204) return;
    const malformed = () => new CatalogOtherProductsAPIError('invalid_response', reply.status);
    let code: CatalogOtherProductsErrorCode;
    try { code = parseCatalogOtherProductsError(raw, reply.status); } catch { throw malformed(); }
    throw new CatalogOtherProductsAPIError(code, reply.status);
  }

  return { list, create, edit, archive };
}
