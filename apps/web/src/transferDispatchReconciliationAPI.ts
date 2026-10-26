import { captureDecisionRecord } from './transferDecisionRecovery';
import { transferDetailPath, type TransferRecord, type TransferLocationID } from './transferModel';
import { countActorLocation, normalizeCountDecision, normalizeCountProposal, parseCountCorrectionError,
  type CountDecisionInput, type CountNormalizedDecision } from './transferCountCorrectionModel';
import { parseDispatchReconciliations, parseDispatchReconciliationOperation,
  type DispatchReconciliationAction, type DispatchReconciliationOperation } from './transferDispatchReconciliationModel';
import type { TransferErrorCode, TransferReadOptions } from './transferAPI';

export type DispatchReconciliationDecisionInput = CountDecisionInput;
export interface DispatchReconciliationProposalInput extends DispatchReconciliationDecisionInput { readonly dispatch_quantity: string }
export type DispatchReconciliationNormalizedDecision = CountNormalizedDecision;
export interface DispatchReconciliationNormalizedProposal extends DispatchReconciliationNormalizedDecision { readonly dispatch_quantity: bigint }
export class DispatchReconciliationAPIError extends Error {
  constructor(public readonly code: TransferErrorCode, public readonly status: number | null,
    public readonly uncertainReconciliation = false) { super(code); this.name = 'DispatchReconciliationAPIError'; }
}
function closed(input: unknown, proposal: boolean): void {
  const keys = ['variant_id', 'operation_key', 'expected_revision', 'reason', ...(proposal ? ['dispatch_quantity'] : [])];
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).length !== keys.length || keys.some(k => !Object.hasOwn(input, k))) throw new Error();
}
/** Reject extras before remapping; preserve admitted reason/key text exactly. */
export function normalizeDispatchReconciliationProposal(input: DispatchReconciliationProposalInput): DispatchReconciliationNormalizedProposal {
  closed(input, true);
  const { dispatch_quantity, ...common } = input;
  const { actual_quantity, ...normalized } = normalizeCountProposal({ ...common, actual_quantity: dispatch_quantity });
  return Object.freeze({ ...normalized, dispatch_quantity: actual_quantity });
}
export function normalizeDispatchReconciliationDecision(input: DispatchReconciliationDecisionInput): DispatchReconciliationNormalizedDecision {
  closed(input, false);
  return normalizeCountDecision(input);
}
/** Exact attempt only: neither current head nor inferred inventory effects. */
export function matchesDispatchReconciliationOperation(op: DispatchReconciliationOperation, requestID: bigint,
  actor: TransferLocationID, action: DispatchReconciliationAction,
  input: DispatchReconciliationNormalizedDecision | DispatchReconciliationNormalizedProposal): boolean {
  return op.request_id === requestID && op.actor_location_id === actor && op.action === action
    && op.variant_id === input.variant_id && op.operation_key === input.operation_key
    && op.expected_revision === input.expected_revision && op.reason === input.reason
    && op.dispatch_quantity === (action === 'propose' && 'dispatch_quantity' in input ? input.dispatch_quantity : null);
}
const serverCodes: Record<number, readonly string[]> = {
  400: ['invalid_request'], 401: ['unauthenticated'], 403: ['forbidden'], 404: ['not_found'],
  405: ['method_not_allowed'], 409: ['retry_conflict', 'decision_conflict', 'insufficient_stock'], 503: ['service_unavailable'],
};
function local<T>(build: () => T): T {
  try { return build(); } catch { throw new DispatchReconciliationAPIError('invalid_request', null); }
}
function context(original: TransferRecord) {
  const record = captureDecisionRecord(original);
  if (record.status !== 'received') throw new Error();
  return Object.freeze({ record, path: transferDetailPath(record.id) + '/dispatch-reconciliations' });
}
/** Additive prepared transport. No registration, session effects or automatic recovery. */
export function createDispatchReconciliationAPI(fetch: typeof globalThis.fetch = globalThis.fetch) {
  async function request<T>(path: string, init: RequestInit, parse: (raw: string) => T): Promise<T> {
    const writing = init.method === 'POST';
    let reply: Response;
    let bytes: ArrayBuffer;
    try {
      reply = await fetch(path, init);
      bytes = await reply.arrayBuffer();
    } catch (error) {
      const aborted = init.signal?.aborted || (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError');
      throw new DispatchReconciliationAPIError(aborted ? 'aborted' : 'network', null, writing);
    }
    const malformed = () => new DispatchReconciliationAPIError('invalid_response', reply.status, writing);
    let raw: string;
    try { raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw malformed(); }
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(reply.headers.get('Content-Type') ?? '')) throw malformed();
    if (reply.status !== 200) {
      let code: string;
      try { code = parseCountCorrectionError(raw); } catch { throw malformed(); }
      if (!serverCodes[reply.status]?.includes(code)) throw malformed();
      throw new DispatchReconciliationAPIError(code as TransferErrorCode, reply.status, writing && reply.status === 503);
    }
    try { return parse(raw); } catch { throw malformed(); }
  }
  async function write(original: TransferRecord, actorLocation: number, action: DispatchReconciliationAction,
    input: DispatchReconciliationProposalInput | DispatchReconciliationDecisionInput, csrf: string, signal?: AbortSignal) {
    const captured = local(() => {
      if (typeof csrf !== 'string' || !/^[A-Za-z0-9_-]+$/.test(csrf)
        || !['propose', 'accept', 'reject'].includes(action)) throw new Error();
      const base = context(original);
      const actor = countActorLocation(actorLocation);
      if (![base.record.origin_location_id, base.record.destination_location_id].includes(actor)) throw new Error();
      const payload = action === 'propose' ? normalizeDispatchReconciliationProposal(input as DispatchReconciliationProposalInput)
        : normalizeDispatchReconciliationDecision(input);
      if (!base.record.items.some(i => i.variant_id === payload.variant_id)
        || !base.record.receipt.items.some(i => i.variant_id === payload.variant_id && i.expected_quantity > 0n)) throw new Error();
      return Object.freeze({ ...base, actor, action, payload, csrf, signal });
    });
    const body = JSON.stringify(captured.payload, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value);
    return request(captured.path + '/' + captured.action, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: captured.signal,
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': captured.csrf }, body,
    }, raw => {
      const op = parseDispatchReconciliationOperation(raw, captured.record);
      if (!matchesDispatchReconciliationOperation(op, BigInt(captured.record.id), captured.actor, captured.action, captured.payload)) throw new Error();
      return op;
    });
  }
  return {
    async read(original: TransferRecord, options: TransferReadOptions = {}) {
      const captured = local(() => context(original));
      const init: RequestInit = { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: options.signal,
        headers: options.passive === true ? { 'X-Luson-Passive': '1' } : {} };
      return request(captured.path, init, raw => parseDispatchReconciliations(raw, captured.record));
    },
    propose(original: TransferRecord, actor: number, input: DispatchReconciliationProposalInput, csrf: string, signal?: AbortSignal) {
      return write(original, actor, 'propose', input, csrf, signal);
    },
    async decide(original: TransferRecord, actor: number, action: 'accept' | 'reject', input: DispatchReconciliationDecisionInput, csrf: string, signal?: AbortSignal) {
      local(() => { if (action !== 'accept' && action !== 'reject') throw new Error(); });
      return write(original, actor, action, input, csrf, signal);
    },
  };
}
export type DispatchReconciliationAPI = ReturnType<typeof createDispatchReconciliationAPI>;
