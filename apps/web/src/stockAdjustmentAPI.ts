import {
  canonicalStockAdjustmentInput, canonicalStockAdjustmentReversalInput, matchesStockAdjustmentInput,
  matchesStockAdjustmentReversal, parseStockAdjustmentApplyError, parseStockAdjustmentCatalog,
  parseStockAdjustmentCatalogError, parseStockAdjustmentDetail, parseStockAdjustmentDetailError,
  parseStockAdjustmentHistory, parseStockAdjustmentHistoryError, parseStockAdjustmentRecord, parseStockAdjustmentReversalError, parseStockAdjustmentReversalRecord,
  stockAdjustmentCatalogPageSize, stockAdjustmentCatalogPath, stockAdjustmentDetailPath, stockAdjustmentHistoryPath, stockAdjustmentReversible,
  stockAdjustmentReversalPath, validStockAdjustmentHistoryQuery,
  type StockAdjustmentCatalogPage, type StockAdjustmentDetail, type StockAdjustmentErrorCode,
  type StockAdjustmentInput, type StockAdjustmentPage, type StockAdjustmentRecord,
  type StockAdjustmentReversalInput, type StockAdjustmentSummary,
} from './stockAdjustmentModel';

export class StockAdjustmentAPIError extends Error {
  constructor(public readonly code: StockAdjustmentErrorCode, public readonly status: number | null) {
    super(code); this.name = 'StockAdjustmentAPIError';
  }
}
export interface StockAdjustmentApplyResult { readonly record: StockAdjustmentRecord; readonly replayed: boolean }
export interface StockAdjustmentReversalResult { readonly record: StockAdjustmentRecord; readonly replayed: boolean }

// Every read answer is admitted only when it is JSON of exactly the contract's shape.
const jsonHeader = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;

export function createStockAdjustmentAPI(fetch: typeof globalThis.fetch = globalThis.fetch) {
  return {
    async create(input: StockAdjustmentInput, csrf: string, signal?: AbortSignal): Promise<StockAdjustmentApplyResult> {
      // Capture the exact payload and the token before any await: callers cannot
      // reclassify an in-flight write by mutating their draft object.
      let body: string;
      let sent: StockAdjustmentInput;
      try {
        if (typeof csrf !== 'string' || !/^[A-Za-z0-9_-]+$/.test(csrf)) throw new Error('Missing CSRF token');
        sent = canonicalStockAdjustmentInput(input);
        body = JSON.stringify(sent);
      } catch { throw new StockAdjustmentAPIError('invalid_request', null); }
      let reply: Response;
      let raw: string;
      try {
        reply = await fetch('/api/stock-adjustments', { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body });
        raw = await reply.text();
      } catch (error) {
        const aborted = signal?.aborted === true
          || (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError');
        throw new StockAdjustmentAPIError(aborted ? 'aborted' : 'network', null);
      }
      const malformed = () => new StockAdjustmentAPIError('invalid_response', reply.status);
      // Never interpret a proxy page or a non-JSON body as evidence of a document.
      if (!jsonHeader.test(reply.headers.get('Content-Type') ?? '')) throw malformed();
      if (reply.status !== 200 && reply.status !== 201) {
        let code: StockAdjustmentErrorCode;
        try { code = parseStockAdjustmentApplyError(raw, reply.status); } catch { throw malformed(); }
        throw new StockAdjustmentAPIError(code, reply.status);
      }
      let record: StockAdjustmentRecord;
      try { record = parseStockAdjustmentRecord(raw); } catch { throw malformed(); }
      // The reply must repeat the exact counted document this client sent.
      if (!matchesStockAdjustmentInput(sent, record)) throw malformed();
      return { record, replayed: reply.status === 200 };
    },

    async reverse(row: StockAdjustmentSummary, input: StockAdjustmentReversalInput, csrf: string,
      signal?: AbortSignal): Promise<StockAdjustmentReversalResult> {
      // The payload, the frozen path and the token are captured before any await,
      // so an in-flight counter-entry cannot be reclassified by the caller.
      let body: string;
      let sent: StockAdjustmentReversalInput;
      let path: string;
      try {
        if (typeof csrf !== 'string' || !/^[A-Za-z0-9_-]+$/.test(csrf)) throw new Error('Missing CSRF token');
        if (!stockAdjustmentReversible(row)) throw new Error('Not reversible');
        path = stockAdjustmentReversalPath(row.id);
        sent = canonicalStockAdjustmentReversalInput(input);
        body = JSON.stringify(sent);
      } catch { throw new StockAdjustmentAPIError('invalid_request', null); }
      let reply: Response;
      let raw: string;
      try {
        reply = await fetch(path, { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body });
        raw = await reply.text();
      } catch (error) {
        const aborted = signal?.aborted === true
          || (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError');
        throw new StockAdjustmentAPIError(aborted ? 'aborted' : 'network', null);
      }
      const malformed = () => new StockAdjustmentAPIError('invalid_response', reply.status);
      if (!jsonHeader.test(reply.headers.get('Content-Type') ?? '')) throw malformed();
      if (reply.status !== 200 && reply.status !== 201) {
        let code: StockAdjustmentErrorCode;
        try { code = parseStockAdjustmentReversalError(raw, reply.status); } catch { throw malformed(); }
        throw new StockAdjustmentAPIError(code, reply.status);
      }
      let record: StockAdjustmentRecord;
      try { record = parseStockAdjustmentReversalRecord(raw); } catch { throw malformed(); }
      // The counter-entry must mirror the listed document and repeat this motive.
      if (record.reason !== sent.reason) throw malformed();
      if (!matchesStockAdjustmentReversal(row, record)) throw malformed();
      return { record, replayed: reply.status === 200 };
    },

    async history(page: number, pageSize: number, signal?: AbortSignal): Promise<StockAdjustmentPage> {
      // The page and size are the frozen read contract: a bad one never leaves here.
      if (!validStockAdjustmentHistoryQuery(page, pageSize)) throw new StockAdjustmentAPIError('invalid_request', null);
      let reply: Response;
      let raw: string;
      try {
        reply = await fetch(stockAdjustmentHistoryPath(page, pageSize), {
          method: 'GET', credentials: 'same-origin', cache: 'no-store', signal });
        raw = await reply.text();
      } catch (error) {
        const aborted = signal?.aborted === true
          || (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError');
        throw new StockAdjustmentAPIError(aborted ? 'aborted' : 'network', null);
      }
      const malformed = () => new StockAdjustmentAPIError('invalid_response', reply.status);
      if (!jsonHeader.test(reply.headers.get('Content-Type') ?? '')) throw malformed();
      if (reply.status !== 200) {
        let code: StockAdjustmentErrorCode;
        try { code = parseStockAdjustmentHistoryError(raw, reply.status); } catch { throw malformed(); }
        throw new StockAdjustmentAPIError(code, reply.status);
      }
      let result: StockAdjustmentPage;
      try { result = parseStockAdjustmentHistory(raw); } catch { throw malformed(); }
      // A page that does not answer the exact query is not evidence about it.
      if (result.page !== page || result.page_size !== pageSize) throw malformed();
      return result;
    },

    async detail(id: number, signal?: AbortSignal): Promise<StockAdjustmentDetail> {
      // The path is the frozen detail contract: a non-canonical id never leaves here.
      let path: string;
      try { path = stockAdjustmentDetailPath(id); } catch { throw new StockAdjustmentAPIError('invalid_request', null); }
      let reply: Response;
      let raw: string;
      try {
        reply = await fetch(path, { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal });
        raw = await reply.text();
      } catch (error) {
        const aborted = signal?.aborted === true
          || (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError');
        throw new StockAdjustmentAPIError(aborted ? 'aborted' : 'network', null);
      }
      const malformed = () => new StockAdjustmentAPIError('invalid_response', reply.status);
      if (!jsonHeader.test(reply.headers.get('Content-Type') ?? '')) throw malformed();
      if (reply.status !== 200) {
        let code: StockAdjustmentErrorCode;
        try { code = parseStockAdjustmentDetailError(raw, reply.status); } catch { throw malformed(); }
        throw new StockAdjustmentAPIError(code, reply.status);
      }
      let detail: StockAdjustmentDetail;
      try { detail = parseStockAdjustmentDetail(raw); } catch { throw malformed(); }
      // A reply for another document is never evidence about the row that asked.
      if (detail.id !== id) throw malformed();
      return detail;
    },

    async catalog(search: string, signal?: AbortSignal): Promise<StockAdjustmentCatalogPage> {
      // The capture catalogue is its own quantity-free read; an inadmissible search
      // never leaves here, and an empty one is simply absent from the query.
      let path: string;
      try { path = stockAdjustmentCatalogPath(search); } catch { throw new StockAdjustmentAPIError('invalid_request', null); }
      let reply: Response;
      let raw: string;
      try {
        reply = await fetch(path, { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal });
        raw = await reply.text();
      } catch (error) {
        const aborted = signal?.aborted === true
          || (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError');
        throw new StockAdjustmentAPIError(aborted ? 'aborted' : 'network', null);
      }
      const malformed = () => new StockAdjustmentAPIError('invalid_response', reply.status);
      if (!jsonHeader.test(reply.headers.get('Content-Type') ?? '')) throw malformed();
      if (reply.status !== 200) {
        let code: StockAdjustmentErrorCode;
        try { code = parseStockAdjustmentCatalogError(raw, reply.status); } catch { throw malformed(); }
        throw new StockAdjustmentAPIError(code, reply.status);
      }
      let page: StockAdjustmentCatalogPage;
      try { page = parseStockAdjustmentCatalog(raw); } catch { throw malformed(); }
      if (page.page !== 1 || page.page_size !== stockAdjustmentCatalogPageSize) throw malformed();
      return page;
    },
  };
}
