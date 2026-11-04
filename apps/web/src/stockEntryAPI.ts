import { canonicalStockEntryInput, canonicalStockEntryReversalInput, matchesStockEntryInput, matchesStockEntryReversal,
  parseStockEntryError, parseStockEntryHistory, parseStockEntryRecord, parseStockEntryReversalError,
  parseStockEntryReversalRecord, stockEntryHistoryPath, stockEntryReversalPath, stockEntryReversible,
  validStockEntryHistoryQuery,
  type StockEntryErrorCode, type StockEntryHistoryPage, type StockEntryHistoryRow, type StockEntryInput,
  type StockEntryRecord, type StockEntryReversalErrorCode, type StockEntryReversalInput } from './stockEntryModel';

export class StockEntryAPIError extends Error {
  constructor(public readonly code: StockEntryErrorCode, public readonly status: number | null) {
    super(code); this.name = 'StockEntryAPIError';
  }
}
// The counter-entry contract adds its own codes, so it carries its own error type
// instead of widening the creation contract's vocabulary.
export class StockEntryReversalAPIError extends Error {
  constructor(public readonly code: StockEntryReversalErrorCode, public readonly status: number | null) {
    super(code); this.name = 'StockEntryReversalAPIError';
  }
}
export interface StockEntryCreateResult { readonly record: StockEntryRecord; readonly replayed: boolean }
export interface StockEntryReversalResult { readonly record: StockEntryRecord; readonly replayed: boolean }

export function createStockEntryAPI(fetch: typeof globalThis.fetch = globalThis.fetch) {
  return {
    async create(input: StockEntryInput, csrf: string, signal?: AbortSignal): Promise<StockEntryCreateResult> {
      // Capture the exact payload and token before any await: callers cannot
      // reclassify an in-flight write by mutating their draft object.
      let body: string;
      let sent: StockEntryInput;
      try {
        if (typeof csrf !== 'string' || !/^[A-Za-z0-9_-]+$/.test(csrf)) throw new Error('Missing CSRF token');
        sent = canonicalStockEntryInput(input);
        body = JSON.stringify(sent);
      } catch { throw new StockEntryAPIError('invalid_request', null); }
      let reply: Response;
      let raw: string;
      try {
        reply = await fetch('/api/stock-entries', { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body });
        raw = await reply.text();
      } catch (error) {
        const aborted = signal?.aborted === true
          || (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError');
        throw new StockEntryAPIError(aborted ? 'aborted' : 'network', null);
      }
      const malformed = () => new StockEntryAPIError('invalid_response', reply.status);
      // Never interpret a proxy page or a non-JSON body as evidence of a document.
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(reply.headers.get('Content-Type') ?? '')) throw malformed();
      if (reply.status !== 200 && reply.status !== 201) {
        let code: StockEntryErrorCode;
        try { code = parseStockEntryError(raw, reply.status); } catch { throw malformed(); }
        throw new StockEntryAPIError(code, reply.status);
      }
      let record: StockEntryRecord;
      try { record = parseStockEntryRecord(raw); } catch { throw malformed(); }
      if (!matchesStockEntryInput(sent, record)) throw malformed();
      return { record, replayed: reply.status === 200 };
    },

    async reverse(row: StockEntryHistoryRow, input: StockEntryReversalInput, csrf: string,
      signal?: AbortSignal): Promise<StockEntryReversalResult> {
      // The exact payload, the frozen path and the CSRF token are captured before
      // any await, so an in-flight reversal cannot be reclassified by the caller.
      let body: string;
      let sent: StockEntryReversalInput;
      let path: string;
      try {
        if (typeof csrf !== 'string' || !/^[A-Za-z0-9_-]+$/.test(csrf)) throw new Error('Missing CSRF token');
        if (!stockEntryReversible(row)) throw new Error('Not reversible');
        path = stockEntryReversalPath(row.id);
        sent = canonicalStockEntryReversalInput(input);
        body = JSON.stringify(sent);
      } catch { throw new StockEntryReversalAPIError('invalid_request', null); }
      let reply: Response;
      let raw: string;
      try {
        reply = await fetch(path, { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body });
        raw = await reply.text();
      } catch (error) {
        const aborted = signal?.aborted === true
          || (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError');
        throw new StockEntryReversalAPIError(aborted ? 'aborted' : 'network', null);
      }
      const malformed = () => new StockEntryReversalAPIError('invalid_response', reply.status);
      // A proxy page, a non-JSON body or an unadmitted status is never evidence.
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(reply.headers.get('Content-Type') ?? '')) throw malformed();
      if (reply.status !== 200 && reply.status !== 201) {
        let code: StockEntryReversalErrorCode;
        try { code = parseStockEntryReversalError(raw, reply.status); } catch { throw malformed(); }
        throw new StockEntryReversalAPIError(code, reply.status);
      }
      let record: StockEntryRecord;
      try { record = parseStockEntryReversalRecord(raw); } catch { throw malformed(); }
      // The counter-entry must be the exact negation of the listed document.
      if (!matchesStockEntryReversal(row, record)) throw malformed();
      return { record, replayed: reply.status === 200 };
    },

    async history(page: number, pageSize: number, signal?: AbortSignal): Promise<StockEntryHistoryPage> {
      // The page and size are the frozen read contract: a bad one never leaves here.
      if (!validStockEntryHistoryQuery(page, pageSize)) throw new StockEntryAPIError('invalid_request', null);
      let reply: Response;
      let raw: string;
      try {
        reply = await fetch(stockEntryHistoryPath(page, pageSize), {
          method: 'GET', credentials: 'same-origin', cache: 'no-store', signal });
        raw = await reply.text();
      } catch (error) {
        const aborted = signal?.aborted === true
          || (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError');
        throw new StockEntryAPIError(aborted ? 'aborted' : 'network', null);
      }
      const malformed = () => new StockEntryAPIError('invalid_response', reply.status);
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(reply.headers.get('Content-Type') ?? '')) throw malformed();
      if (reply.status !== 200) {
        let code: StockEntryErrorCode;
        try { code = parseStockEntryError(raw, reply.status); } catch { throw malformed(); }
        throw new StockEntryAPIError(code, reply.status);
      }
      try { return parseStockEntryHistory(raw); } catch { throw malformed(); }
    },
  };
}
