import { canonicalStockEntryInput, matchesStockEntryInput, parseStockEntryError, parseStockEntryRecord,
  type StockEntryErrorCode, type StockEntryInput, type StockEntryRecord } from './stockEntryModel';

export class StockEntryAPIError extends Error {
  constructor(public readonly code: StockEntryErrorCode, public readonly status: number | null) {
    super(code); this.name = 'StockEntryAPIError';
  }
}
export interface StockEntryCreateResult { readonly record: StockEntryRecord; readonly replayed: boolean }

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
  };
}
