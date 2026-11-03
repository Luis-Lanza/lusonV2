import { captureDecisionRecord } from './transferDecisionRecovery';
import { transferDetailPath, type TransferRecord } from './transferModel';
import { countActorLocation, parseCountCorrectionError } from './transferCountCorrectionModel';
import { normalizeUnifiedReconciliationIntent, parseUnifiedReconciliationOperation, parseUnifiedReconciliations,
  type UnifiedReconciliationAction, type UnifiedReconciliationDecisionInput, type UnifiedReconciliationProposalInput } from './transferUnifiedReconciliationModel';
import type { TransferErrorCode, TransferReadOptions } from './transferAPI';

export class UnifiedReconciliationAPIError extends Error {
  constructor(public readonly code: TransferErrorCode, public readonly status: number | null,
    public readonly uncertainReconciliation = false) {
    super(code); this.name = 'UnifiedReconciliationAPIError';
  }
}
const serverCodes: Record<number, readonly string[]> = {
  400: ['invalid_request'], 401: ['unauthenticated'], 403: ['forbidden'], 404: ['not_found'],
  405: ['method_not_allowed'], 409: ['decision_conflict', 'retry_conflict', 'insufficient_stock'], 503: ['service_unavailable'],
};
function local<T>(build: () => T): T {
  try { return build(); } catch { throw new UnifiedReconciliationAPIError('invalid_request', null); }
}
function context(original: TransferRecord) {
  const record = captureDecisionRecord(original);
  if (record.status !== 'received') throw new Error();
  return Object.freeze({ record, path: transferDetailPath(record.id) + '/unified-reconciliations' });
}
/** Prepared transport only: no registration, automatic retries or session effects. */
export function createUnifiedReconciliationAPI(fetch: typeof globalThis.fetch = globalThis.fetch) {
  async function request<T>(path: string, init: RequestInit, parse: (raw: string) => T): Promise<T> {
    const writing = init.method === 'POST';
    let reply: Response; let bytes: ArrayBuffer;
    try { reply = await fetch(path, init); bytes = await reply.arrayBuffer(); }
    catch (error) {
      const aborted = init.signal?.aborted || (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError');
      throw new UnifiedReconciliationAPIError(aborted ? 'aborted' : 'network', null, writing);
    }
    const malformed = () => new UnifiedReconciliationAPIError('invalid_response', reply.status, writing);
    let raw: string;
    try { raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw malformed(); }
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(reply.headers.get('Content-Type') ?? '')) throw malformed();
    if (reply.status !== 200) {
      let code: string;
      try { code = parseCountCorrectionError(raw); } catch { throw malformed(); }
      if (!serverCodes[reply.status]?.includes(code)) throw malformed();
      throw new UnifiedReconciliationAPIError(code as TransferErrorCode, reply.status, writing && reply.status === 503);
    }
    try { return parse(raw); } catch { throw malformed(); }
  }
  async function write(original: TransferRecord, actorLocation: number, action: UnifiedReconciliationAction,
    input: UnifiedReconciliationDecisionInput | UnifiedReconciliationProposalInput, csrf: string, signal?: AbortSignal) {
    const captured = local(() => {
      if (!['propose', 'accept', 'reject'].includes(action) || typeof csrf !== 'string' || !/^[A-Za-z0-9_-]+$/.test(csrf)) throw new Error();
      const base = context(original), actor = countActorLocation(actorLocation);
      if (![base.record.origin_location_id, base.record.destination_location_id].includes(actor)) throw new Error();
      const payload = normalizeUnifiedReconciliationIntent(input, action === 'propose');
      const line = base.record.receipt.items.find(i => i.variant_id === payload.variant_id && i.expected_quantity > 0n);
      if (!line || !base.record.items.some(i => i.variant_id === payload.variant_id)
        || action !== 'propose' && payload.expected_revision === 0n
        || payload.retained_at_origin && (actor !== base.record.origin_location_id || action === 'reject')) throw new Error();
      if ('retained_quantity' in payload && (payload.retained_quantity > (line.expected_quantity > payload.dispatch_quantity ? line.expected_quantity - payload.dispatch_quantity : 0n)
        || payload.retained_quantity > 0n && actor === base.record.origin_location_id && !payload.retained_at_origin)) throw new Error();
      return Object.freeze({ ...base, actor, action, payload, csrf, signal });
    });
    const body = JSON.stringify(captured.payload, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value);
    return request(captured.path + '/' + captured.action, { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: captured.signal,
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': captured.csrf }, body }, raw => {
      const op = parseUnifiedReconciliationOperation(raw, captured.record), p = captured.payload;
      if (op.request_id !== BigInt(captured.record.id) || op.actor_location_id !== captured.actor || op.action !== captured.action
        || op.variant_id !== p.variant_id || op.operation_key !== p.operation_key || op.expected_revision !== p.expected_revision
        || op.reason !== p.reason || op.retained_at_origin !== p.retained_at_origin
        || op.dispatch_quantity !== ('dispatch_quantity' in p ? p.dispatch_quantity : null)
        || op.arrival_quantity !== ('arrival_quantity' in p ? p.arrival_quantity : null)
        || op.retained_quantity !== ('retained_quantity' in p ? p.retained_quantity : null)) throw new Error();
      return op;
    });
  }
  return {
    async read(original: TransferRecord, options: TransferReadOptions = {}) {
      const captured = local(() => context(original));
      return request(captured.path, { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: options.signal,
        headers: options.passive === true ? { 'X-Luson-Passive': '1' } : {} }, raw => parseUnifiedReconciliations(raw, captured.record));
    },
    propose(original: TransferRecord, actor: number, input: UnifiedReconciliationProposalInput, csrf: string, signal?: AbortSignal) {
      return write(original, actor, 'propose', input, csrf, signal);
    },
    decide(original: TransferRecord, actor: number, action: 'accept' | 'reject', input: UnifiedReconciliationDecisionInput, csrf: string, signal?: AbortSignal) {
      local(() => { if (action !== 'accept' && action !== 'reject') throw new Error(); });
      return write(original, actor, action, input, csrf, signal);
    },
  };
}
export type UnifiedReconciliationAPI = ReturnType<typeof createUnifiedReconciliationAPI>;
