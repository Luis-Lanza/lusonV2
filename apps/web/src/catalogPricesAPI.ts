import {
  canonicalCatalogPriceInput, catalogPricesPath, matchesCatalogPriceInput, parseCatalogPriceResult,
  parseCatalogPrices, parseCatalogPricesError, parseCatalogPricesWriteError, validCatalogPricesQuery,
  type CatalogPriceInput, type CatalogPriceResult, type CatalogPricesErrorCode,
  type CatalogPricesPage, type CatalogPricesQuery,
} from './catalogPricesModel';

export class CatalogPricesAPIError extends Error {
  constructor(public readonly code: CatalogPricesErrorCode, public readonly status: number | null,
    // The branch the server named as retired, when it named one.
    public readonly branchId: number | null = null) {
    super(code); this.name = 'CatalogPricesAPIError';
  }
}

// Every answer is admitted only when it is JSON of exactly the contract's shape.
const jsonHeader = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;

export function createCatalogPricesAPI(fetch: typeof globalThis.fetch = globalThis.fetch) {
  return {
    async list(query: CatalogPricesQuery, signal?: AbortSignal): Promise<CatalogPricesPage> {
      // The query is the frozen read contract: an inadmissible one never leaves here.
      let path: string;
      try {
        if (!validCatalogPricesQuery(query)) throw new Error('Invalid query');
        path = catalogPricesPath(query);
      } catch { throw new CatalogPricesAPIError('invalid_request', null); }
      let reply: Response;
      let raw: string;
      try {
        reply = await fetch(path, { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal });
        raw = await reply.text();
      } catch (error) {
        const aborted = signal?.aborted === true
          || (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError');
        throw new CatalogPricesAPIError(aborted ? 'aborted' : 'network', null);
      }
      const malformed = () => new CatalogPricesAPIError('invalid_response', reply.status);
      // A proxy page or a non-JSON body is never evidence about the catalogue.
      if (!jsonHeader.test(reply.headers.get('Content-Type') ?? '')) throw malformed();
      if (reply.status !== 200) {
        let code: CatalogPricesErrorCode;
        try { code = parseCatalogPricesError(raw, reply.status); } catch { throw malformed(); }
        throw new CatalogPricesAPIError(code, reply.status);
      }
      let page: CatalogPricesPage;
      try { page = parseCatalogPrices(raw); } catch { throw malformed(); }
      // A page that does not answer the exact query is not evidence about it.
      if (page.page !== query.page || page.page_size !== query.page_size) throw malformed();
      return page;
    },

    /**
     * Writes one block. The payload carries the battery, the prices and the branches
     * only: the reply is admitted when it repeats exactly that write.
     */
    async apply(input: CatalogPriceInput, csrf: string,
      signal?: AbortSignal): Promise<CatalogPriceResult> {
      // Capture the exact payload and the token before any await: callers cannot
      // reclassify an in-flight write by mutating their draft object.
      let body: string;
      let sent: CatalogPriceInput;
      try {
        if (typeof csrf !== 'string' || !/^[A-Za-z0-9_-]+$/.test(csrf)) throw new Error('Missing CSRF token');
        sent = canonicalCatalogPriceInput(input);
        body = JSON.stringify(sent);
      } catch { throw new CatalogPricesAPIError('invalid_request', null); }
      let reply: Response;
      let raw: string;
      try {
        reply = await fetch('/api/catalog/prices', { method: 'PUT', credentials: 'same-origin', cache: 'no-store', signal,
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body });
        raw = await reply.text();
      } catch (error) {
        const aborted = signal?.aborted === true
          || (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError');
        throw new CatalogPricesAPIError(aborted ? 'aborted' : 'network', null);
      }
      const malformed = () => new CatalogPricesAPIError('invalid_response', reply.status);
      if (!jsonHeader.test(reply.headers.get('Content-Type') ?? '')) throw malformed();
      if (reply.status !== 200) {
        let failure_: { code: CatalogPricesErrorCode; branch_id: number | null };
        try { failure_ = parseCatalogPricesWriteError(raw, reply.status); } catch { throw malformed(); }
        throw new CatalogPricesAPIError(failure_.code, reply.status, failure_.branch_id);
      }
      let result: CatalogPriceResult;
      try { result = parseCatalogPriceResult(raw); } catch { throw malformed(); }
      // The reply must repeat the exact write this client sent.
      if (!matchesCatalogPriceInput(sent, result)) throw malformed();
      return result;
    },
  };
}
