import { parse as parseJSON } from 'lossless-json';
import {
  matchesRestitutionOperation, normalizeRestitutionDecision, normalizeRestitutionProposal, parseRestitutionError,
  parseRestitutionOperation, parseRestitutions, restitutionActorLocation, restitutionsPath,
  type RestitutionAction, type RestitutionDecisionInput, type RestitutionOperation, type RestitutionProposalInput, type Restitutions,
} from './transferRestitutionModel';
import {
  canonicalTransferReceiptInput, matchesReceiptInput, canonicalTransferInput, parseTransferCounts, parseTransferPage, parseTransferRecord, transferDetailPath, transferListPath,
  type TransferReceiptInput, type TransferCounts, type TransferCreateInput, type TransferPage, type TransferQuery, type TransferRecord,
} from './transferModel';
import { captureDecisionRecord, matchesDecisionRecord, satisfiesDecision, type TransferDecision } from './transferDecisionRecovery';
import {
  countActorLocation, countCorrectionsPath, matchesCountOperation, normalizeCountDecision, normalizeCountProposal,
  parseCountCorrectionError, parseCountCorrections, parseCountOperation, type CountAction, type CountCorrections, type CountDecisionInput,
  type CountOperation, type CountProposalInput,
} from './transferCountCorrectionModel';
export type TransferErrorCode = 'invalid_request' | 'unauthenticated' | 'forbidden' | 'not_found' | 'method_not_allowed' | 'insufficient_stock' | 'retry_conflict' | 'decision_conflict' | 'service_unavailable' | 'invalid_response' | 'network' | 'aborted';
export class TransferAPIError extends Error {
  constructor(public readonly code: TransferErrorCode, public readonly status: number | null, public readonly uncertainCreation = false, public readonly uncertainDecision = false, public readonly uncertainDispatch = false, public readonly uncertainReceipt = false, public readonly uncertainCancellation = false, public readonly uncertainCorrection = false) { super(code); this.name = 'TransferAPIError'; }
}
export class RestitutionAPIError extends Error {
  constructor(public readonly code: TransferErrorCode, public readonly status: number | null,
    public readonly uncertainRestitution = false) { super(code); this.name = 'RestitutionAPIError'; }
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
  async function request(path: string, init: RequestInit, statuses: readonly number[], decision = false, dispatch = false, receipt = false, cancellation = false, correction = false) {
    const creating = init.method === 'POST' && !decision && !dispatch && !receipt && !cancellation && !correction;
    let reply: Response;
    let body: string;
    try {
      reply = await fetch(path, init);
      body = await reply.text();
    } catch (error) {
      const aborted = init.signal?.aborted || (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError');
      throw new TransferAPIError(aborted ? 'aborted' : 'network', null, creating, decision, dispatch, receipt, cancellation, correction);
    }
    const malformed = () => new TransferAPIError('invalid_response', reply.status, creating, decision, dispatch, receipt, cancellation, correction);
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(reply.headers.get('Content-Type') ?? '')) throw malformed();
    if (!statuses.includes(reply.status)) {
      let value: unknown;
      try {
        value = correction ? { error: parseCountCorrectionError(body) }
          : parseJSON(body, null, { parseNumber: Number, onDuplicateKey: () => { throw malformed(); } });
      } catch { throw malformed(); }
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'error')) throw malformed();
      const code = (value as { error: unknown }).error;
      const admitted = reply.status === 409 && correction ? ['retry_conflict', 'decision_conflict', 'insufficient_stock'] : reply.status === 409 && cancellation ? ['decision_conflict'] : reply.status === 409 && receipt ? ['retry_conflict', 'decision_conflict']
        : reply.status === 409 && (decision || dispatch) ? ['insufficient_stock', 'decision_conflict'] : serverCodes[reply.status];
      if (typeof code !== 'string' || !admitted?.includes(code as TransferErrorCode)) throw malformed();
      // A recognized correction 503 still cannot prove that the write rolled back.
      throw new TransferAPIError(code as TransferErrorCode, reply.status, false, false, false, false, false,
        correction && reply.status === 503);
    }
    return { body, status: reply.status };
  }
  function checked<T>(parse: () => T, status: number, creating = false, decision = false, dispatch = false, receipt = false, cancellation = false, correction = false): T {
    try { return parse(); } catch { throw new TransferAPIError('invalid_response', status, creating, decision, dispatch, receipt, cancellation, correction); }
  }
  async function writeCount(id: string, actorLocation: number, selectedAction: CountAction,
    input: CountProposalInput | CountDecisionInput, csrf: string, signal?: AbortSignal): Promise<CountOperation> {
    const captured = local(() => {
      if (typeof csrf !== 'string' || !/^[A-Za-z0-9_-]+$/.test(csrf)
        || !['propose', 'accept', 'reject'].includes(selectedAction)) throw new Error();
      const path = countCorrectionsPath(id);
      const actor = countActorLocation(actorLocation);
      const payload = selectedAction === 'propose' ? normalizeCountProposal(input as CountProposalInput) : normalizeCountDecision(input);
      // Capture immutable evidence before serialization or any asynchronous work.
      return Object.freeze({ path, requestID: BigInt(id), actor, action: selectedAction, payload });
    });
    const body = JSON.stringify(captured.payload, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value);
    const reply = await request(captured.path + '/' + captured.action, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body,
    }, [200], false, false, false, false, true);
    return checked(() => {
      const op = parseCountOperation(reply.body);
      if (!matchesCountOperation(op, captured.requestID, captured.actor, captured.action, captured.payload)) throw new Error();
      return op;
    }, reply.status, false, false, false, false, false, true);
  }
  function restitutionLocal<T>(build: () => T): T {
    try { return build(); } catch { throw new RestitutionAPIError('invalid_request', null); }
  }
  async function restitutionRequest<T>(path: string, init: RequestInit, parse: (body: string) => T): Promise<T> {
    const writing = init.method === 'POST';
    let reply: Response;
    let bytes: ArrayBuffer;
    try {
      reply = await fetch(path, init);
      bytes = await reply.arrayBuffer();
    } catch (error) {
      const aborted = init.signal?.aborted || (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError');
      throw new RestitutionAPIError(aborted ? 'aborted' : 'network', null, writing);
    }
    const malformed = () => new RestitutionAPIError('invalid_response', reply.status, writing);
    let body: string;
    // Decode strictly before admitting any JSON evidence or server error envelope.
    try { body = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw malformed(); }
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(reply.headers.get('Content-Type') ?? '')) throw malformed();
    if (reply.status !== 200) {
      let code: string;
      try { code = parseRestitutionError(body); } catch { throw malformed(); }
      const admitted = reply.status === 409 ? ['retry_conflict', 'decision_conflict', 'insufficient_stock'] : serverCodes[reply.status];
      if (!admitted?.includes(code as TransferErrorCode)) throw malformed();
      throw new RestitutionAPIError(code as TransferErrorCode, reply.status, writing && reply.status === 503);
    }
    try { return parse(body); } catch { throw malformed(); }
  }
  async function writeRestitution(id: string, actorLocation: number, selectedAction: RestitutionAction,
    input: RestitutionProposalInput | RestitutionDecisionInput, csrf: string, signal?: AbortSignal): Promise<RestitutionOperation> {
    const captured = restitutionLocal(() => {
      if (typeof csrf !== 'string' || !/^[A-Za-z0-9_-]+$/.test(csrf)
        || !['propose', 'accept', 'reject'].includes(selectedAction)) throw new Error();
      const path = restitutionsPath(id);
      const actor = restitutionActorLocation(actorLocation);
      const payload = selectedAction === 'propose' ? normalizeRestitutionProposal(input as RestitutionProposalInput) : normalizeRestitutionDecision(input);
      return Object.freeze({ path, requestID: BigInt(id), actor, action: selectedAction, payload });
    });
    const body = JSON.stringify(captured.payload, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value);
    return restitutionRequest(captured.path + '/' + captured.action, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body,
    }, raw => {
      const op = parseRestitutionOperation(raw);
      if (!matchesRestitutionOperation(op, captured.requestID, captured.actor, captured.action, captured.payload)) throw new Error();
      return op;
    });
  }
  return {
    async restitutions(id: string, options: TransferReadOptions = {}): Promise<Restitutions> {
      const path = restitutionLocal(() => restitutionsPath(id));
      const requestID = BigInt(id);
      return restitutionRequest(path, readInit(options), raw => {
        const snapshot = parseRestitutions(raw);
        if (snapshot.request_id !== requestID) throw new Error();
        return snapshot;
      });
    },
    proposeRestitution(id: string, actorLocation: number, input: RestitutionProposalInput, csrf: string, signal?: AbortSignal): Promise<RestitutionOperation> {
      return writeRestitution(id, actorLocation, 'propose', input, csrf, signal);
    },
    async decideRestitution(id: string, actorLocation: number, action: 'accept' | 'reject', input: RestitutionDecisionInput, csrf: string, signal?: AbortSignal): Promise<RestitutionOperation> {
      restitutionLocal(() => { if (action !== 'accept' && action !== 'reject') throw new Error(); });
      return writeRestitution(id, actorLocation, action, input, csrf, signal);
    },
    async countCorrections(id: string, options: TransferReadOptions = {}): Promise<CountCorrections> {
      const path = local(() => countCorrectionsPath(id));
      const requestID = BigInt(id);
      const reply = await request(path, readInit(options), [200]);
      return checked(() => {
        const snapshot = parseCountCorrections(reply.body);
        if (snapshot.request_id !== requestID) throw new Error();
        return snapshot;
      }, reply.status);
    },
    proposeCount(id: string, actorLocation: number, input: CountProposalInput, csrf: string, signal?: AbortSignal): Promise<CountOperation> {
      return writeCount(id, actorLocation, 'propose', input, csrf, signal);
    },
    async decideCount(id: string, actorLocation: number, action: 'accept' | 'reject', input: CountDecisionInput, csrf: string, signal?: AbortSignal): Promise<CountOperation> {
      local(() => { if (action !== 'accept' && action !== 'reject') throw new Error(); });
      return writeCount(id, actorLocation, action, input, csrf, signal);
    },
    async cancel(original: TransferRecord, csrf: string, signal?: AbortSignal): Promise<TransferRecord> {
      const captured = local(() => {
        if (!['pending', 'approved', 'cancelled'].includes(original.status) || typeof csrf !== 'string' || !/^[A-Za-z0-9_-]+$/.test(csrf)) throw new Error();
        return captureDecisionRecord(original);
      });
      const path = local(() => transferDetailPath(captured.id)) + '/cancel';
      const reply = await request(path, { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: '{}' }, [200], false, false, false, true);
      return checked(() => {
        const record = parseTransferRecord(reply.body);
        if (record.status !== 'cancelled' || !matchesDecisionRecord(captured, record)) throw new Error();
        return record;
      }, reply.status, false, false, false, false, true);
    },
    async receive(original: TransferRecord, input: TransferReceiptInput, csrf: string, signal?: AbortSignal): Promise<TransferRecord> {
      const captured = local(() => {
        if ((original.status !== 'in_transit' && original.status !== 'received') || typeof csrf !== 'string' || !/^[A-Za-z0-9_-]+$/.test(csrf)) throw new Error();
        return captureDecisionRecord(original);
      });
      const payload = local(() => canonicalTransferReceiptInput(input, captured));
      const path = local(() => transferDetailPath(captured.id)) + '/receive';
      const reply = await request(path, { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(payload) }, [200], false, false, true);
      return checked(() => {
        const record = parseTransferRecord(reply.body);
        if (!matchesDecisionRecord(captured, record) || !matchesReceiptInput(payload, record)) throw new Error();
        return record;
      }, reply.status, false, false, false, true);
    },
    async dispatch(original: TransferRecord, csrf: string, signal?: AbortSignal): Promise<TransferRecord> {
      const captured = local(() => {
        if (!['approved', 'in_transit', 'received'].includes(original.status) || typeof csrf !== 'string' || !/^[A-Za-z0-9_-]+$/.test(csrf)) throw new Error();
        return captureDecisionRecord(original);
      });
      const path = local(() => transferDetailPath(captured.id)) + '/dispatch';
      const reply = await request(path, { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: '{}' }, [200], false, true);
      return checked(() => {
        const record = parseTransferRecord(reply.body);
        if ((record.status !== 'in_transit' && record.status !== 'received') || !matchesDecisionRecord(captured, record)) throw new Error();
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
