import {
  canonicalTransferInput, parseTransferCounts, parseTransferPage, parseTransferRecord, transferDetailPath, transferListPath,
  type TransferCounts, type TransferCreateInput, type TransferPage, type TransferQuery, type TransferRecord,
} from './transferModel';
import { captureDecisionRecord, matchesDecisionRecord, satisfiesDecision, type TransferDecision } from './transferDecisionRecovery';
export type TransferErrorCode = 'invalid_request' | 'unauthenticated' | 'forbidden' | 'not_found' | 'method_not_allowed' | 'insufficient_stock' | 'retry_conflict' | 'decision_conflict' | 'service_unavailable' | 'invalid_response' | 'network' | 'aborted';
export class TransferAPIError extends Error {
  constructor(public readonly code: TransferErrorCode, public readonly status: number | null, public readonly uncertainCreation = false, public readonly uncertainDecision = false, public readonly uncertainDispatch = false) { super(code); this.name = 'TransferAPIError'; }
}
export interface TransferReadOptions { signal?: AbortSignal; passive?: boolean }
export interface TransferCreateResult { record: TransferRecord; replayed: boolean }
const serverCodes: Record<number, readonly TransferErrorCode[]> = {
  400: ['invalid_request'], 401: ['unauthenticated'], 403: ['forbidden'], 404: ['not_found'],
  405: ['method_not_allowed'], 409: ['insufficient_stock', 'retry_conflict'], 503: ['service_unavailable'],
};
function local<T>(build: () => T): T {
  try { return build(); } catch { throw new TransferAPIError('invalid_request', null); }
}
function readInit(options: TransferReadOptions): RequestInit {
  // Capture mode before any await; callers cannot reclassify an in-flight read.
  return { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: options.signal,
    headers: options.passive === true ? { 'X-Luson-Passive': '1' } : {} };
}
export function createTransferAPI(fetch: typeof globalThis.fetch = globalThis.fetch) {
  async function request(path: string, init: RequestInit, statuses: readonly number[], decision = false, dispatch = false) {
    const creating = init.method === 'POST' && !decision && !dispatch;
    let reply: Response;
    let body: string;
    try {
      reply = await fetch(path, init);
      body = await reply.text();
    } catch (error) {
      const aborted = init.signal?.aborted || (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError');
      throw new TransferAPIError(aborted ? 'aborted' : 'network', null, creating, decision, dispatch);
    }
    const malformed = () => new TransferAPIError('invalid_response', reply.status, creating, decision, dispatch);
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(reply.headers.get('Content-Type') ?? '')) throw malformed();
    if (!statuses.includes(reply.status)) {
      let value: unknown;
      try { value = JSON.parse(body); } catch { throw malformed(); }
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'error')) throw malformed();
      const code = (value as { error: unknown }).error;
      const admitted = reply.status === 409 && (decision || dispatch) ? ['insufficient_stock', 'decision_conflict'] : serverCodes[reply.status];
      if (typeof code !== 'string' || !admitted?.includes(code as TransferErrorCode)) throw malformed();
      throw new TransferAPIError(code as TransferErrorCode, reply.status);
    }
    return { body, status: reply.status };
  }
  function checked<T>(parse: () => T, status: number, creating = false, decision = false, dispatch = false): T {
    try { return parse(); } catch { throw new TransferAPIError('invalid_response', status, creating, decision, dispatch); }
  }
  return {
    async dispatch(original: TransferRecord, csrf: string, signal?: AbortSignal): Promise<TransferRecord> {
      const captured = local(() => {
        if (original.status !== 'approved' || typeof csrf !== 'string' || !/^[A-Za-z0-9_-]+$/.test(csrf)) throw new Error();
        return captureDecisionRecord(original);
      });
      const path = local(() => transferDetailPath(captured.id)) + '/dispatch';
      const reply = await request(path, { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: '{}' }, [200], false, true);
      return checked(() => {
        const record = parseTransferRecord(reply.body);
        if (record.status !== 'in_transit' || !matchesDecisionRecord(captured, record)) throw new Error();
        return record;
      }, reply.status, false, false, true);
    },
    async decide(original: TransferRecord, action: TransferDecision, csrf: string, signal?: AbortSignal): Promise<TransferRecord> {
      const captured = local(() => {
        if ((action !== 'approve' && action !== 'reject') || typeof csrf !== 'string' || !/^[A-Za-z0-9_-]+$/.test(csrf)) throw new Error();
        return captureDecisionRecord(original);
      });
      const path = local(() => transferDetailPath(captured.id)) + '/' + action;
      const reply = await request(path, { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: '{}' }, [200], true);
      return checked(() => {
        const record = parseTransferRecord(reply.body);
        if (!satisfiesDecision(action, record) || !matchesDecisionRecord(captured, record)
          || record.decision_location_id !== captured.approver_location_id) throw new Error();
        return record;
      }, reply.status, false, true);
    },
    async counts(options: Pick<TransferReadOptions, 'signal'> = {}): Promise<TransferCounts> {
      // This endpoint is intrinsically passive: no selector or caller headers.
      const reply = await request('/api/transfers/counts', {
        method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: options.signal,
      }, [200]);
      return checked(() => parseTransferCounts(reply.body), reply.status);
    },
    async list(query: TransferQuery = {}, options: TransferReadOptions = {}): Promise<TransferPage> {
      const path = local(() => transferListPath(query));
      const selected = query.status ?? 'pending';
      const reply = await request(path, readInit(options), [200]);
      return checked(() => {
        const page = parseTransferPage(reply.body);
        if (page.status !== selected) throw new Error();
        return page;
      }, reply.status);
    },
    async detail(id: string, options: TransferReadOptions = {}): Promise<TransferRecord> {
      const path = local(() => transferDetailPath(id));
      const reply = await request(path, readInit(options), [200]);
      return checked(() => parseTransferRecord(reply.body), reply.status);
    },
    async create(input: TransferCreateInput, csrf: string, signal?: AbortSignal): Promise<TransferCreateResult> {
      const body = local(() => {
        if (typeof csrf !== 'string' || !csrf || !/^[A-Za-z0-9_-]+$/.test(csrf)) throw new Error();
        return JSON.stringify(canonicalTransferInput(input));
      });
      const reply = await request('/api/transfers', { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body }, [200, 201]);
      const record = checked(() => parseTransferRecord(reply.body), reply.status, true);
      return { record, replayed: reply.status === 200 };
    },
  };
}
