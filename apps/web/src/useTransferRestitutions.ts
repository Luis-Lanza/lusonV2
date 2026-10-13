import { useEffect, useRef, useState } from 'react';
import { createTransferAPI, RestitutionAPIError, TransferAPIError } from './transferAPI';
import { captureDecisionRecord, decisionOwner, type DecisionOwner } from './transferDecisionRecovery';
import { captureCountCorrections, sameCountOwner } from './transferCountCorrectionRecovery';
import { restitutionRetryPayload, type TransferRestitutionRecovery, type RestitutionReviewPin, type RestitutionFlight } from './transferRestitutionRecovery';
import { captureRestitutions, restitutionsPath, type RestitutionAction, type RestitutionDecisionInput,
  type RestitutionProposalInput, type RestitutionOperation, type Restitutions } from './transferRestitutionModel';
import type { TransferRecord } from './transferModel';
import type { TransferController } from './useInventory';

export interface TransferRestitutionsOptions {
  controller: Pick<TransferController, 'getTransferAuthority' | 'subscribeTransferInvalidation' | 'settleUnauthorized'>;
  requestID: string | null;
  record: TransferRecord | null;
  variantID: number | null;
  enabled?: boolean;
  recovery: TransferRestitutionRecovery;
  api?: Pick<ReturnType<typeof createTransferAPI>, 'restitutions' | 'countCorrections' | 'proposeRestitution' | 'decideRestitution'>;
  onConfirmation?: (owner: DecisionOwner, operation: RestitutionOperation) => void;
}
type API = NonNullable<TransferRestitutionsOptions['api']>;
interface Context {
  controller: TransferRestitutionsOptions['controller']; api: API; recovery: TransferRestitutionRecovery;
  id: string | null; owner: DecisionOwner | null; enabled: boolean; record: TransferRecord | null;
  header: string; variant: number | null; confirmation: TransferRestitutionsOptions['onConfirmation'];
}
interface ReadFlight { context: Context; abort: AbortController; dirty: boolean }
interface WriteFlight { context: Context; abort: AbortController; token: RestitutionFlight }
interface View { context: Context; snapshot: Restitutions | null; busy: boolean; error: RestitutionAPIError | null }
function same(a: Context, b: Context) {
  return a.enabled && b.enabled && a.api === b.api && a.recovery === b.recovery && a.id === b.id
    && a.variant === b.variant && a.header === b.header && a.confirmation === b.confirmation
    && a.controller.getTransferAuthority === b.controller.getTransferAuthority
    && a.controller.subscribeTransferInvalidation === b.controller.subscribeTransferInvalidation
    && a.controller.settleUnauthorized === b.controller.settleUnauthorized && sameCountOwner(a.owner, b.owner);
}
function readError(error: unknown) {
  if (error instanceof RestitutionAPIError) return error;
  if (error instanceof TransferAPIError) return new RestitutionAPIError(error.code, error.status);
  return new RestitutionAPIError('invalid_response', null);
}

/** Reads establish evidence only; a reviewed opaque pin is required for a fresh
 * write. Recovery and confirmation ownership are injected, not inventory effects. */
export function useTransferRestitutions(options: TransferRestitutionsOptions) {
  const { controller, recovery, requestID, record: suppliedRecord, variantID, enabled = true, onConfirmation } = options;
  const [defaultAPI] = useState(createTransferAPI);
  let id: string | null = null; let record: TransferRecord | null = null;
  try { if (requestID !== null) { restitutionsPath(requestID); id = BigInt(requestID).toString(); } } catch { /* Invalid selection. */ }
  try { if (suppliedRecord) record = captureDecisionRecord(suppliedRecord); } catch { /* No fresh header authority. */ }
  if (record?.id !== id) record = null;
  const header = JSON.stringify(record, (_key, v: unknown) => typeof v === 'bigint' ? v.toString() : v);
  const owner = decisionOwner(controller.getTransferAuthority());
  recovery.select(owner, id === null ? null : BigInt(id), variantID);
  const context: Context = { controller, recovery, api: options.api ?? defaultAPI, id, owner,
    enabled: enabled && id !== null && owner !== null, record, header, variant: variantID, confirmation: onConfirmation };
  const latest = useRef(context);
  const previous = latest.current;
  latest.current = context;
  // Changing the validated header retires previously issued capabilities before
  // an event callback can run, even when no new review is requested.
  if (previous.recovery === recovery && previous.id === id && id && sameCountOwner(previous.owner, owner)
    && previous.header !== header && owner) recovery.invalidate(owner, BigInt(id), 'header');
  const mounted = useRef(false);
  const read = useRef<ReadFlight | null>(null);
  const writes = useRef(new Set<WriteFlight>());
  const pins = useRef(new WeakMap<RestitutionReviewPin, Context>());
  const [view, setView] = useState<View>({ context, snapshot: null, busy: false, error: null });
  const [, revision] = useState(0);
  function cancel() {
    read.current?.abort.abort(); read.current = null;
    for (const w of writes.current) { w.abort.abort(); w.context.recovery.release(w.token); }
    writes.current.clear();
  }
  function valid(c: Context) {
    if (!mounted.current || !same(c, latest.current)) return false;
    const now = decisionOwner(c.controller.getTransferAuthority());
    c.recovery.synchronize(now);
    if (!sameCountOwner(c.owner, now)) { cancel(); return false; }
    return true;
  }
  function drain(c: Context) {
    if (!valid(c) || !c.confirmation) return;
    const operations = c.recovery.consumeConfirmations(c.owner);
    for (const op of operations) {
      if (!valid(c) || c.recovery.isRequestMasked(c.owner, op.request_id)) return;
      try { c.confirmation(c.owner!, op); } catch { /* A consumer cannot strand a settled flight. */ }
    }
  }
  function mask(c: Context, failure: RestitutionAPIError) {
    c.recovery.mask(c.owner!, BigInt(c.id!));
    read.current?.abort.abort(); read.current = null;
    for (const w of writes.current) if (same(w.context, c)) { w.abort.abort(); writes.current.delete(w); }
    if (valid(c)) setView({ context: c, snapshot: null, busy: false, error: failure });
  }
  async function load(c: Context, passive: boolean) {
    if (!valid(c)) return;
    if (passive && read.current && same(read.current.context, c)) { read.current.dirty = true; return; }
    read.current?.abort.abort();
    const f: ReadFlight = { context: c, abort: new AbortController(), dirty: false }; read.current = f;
    const current = () => read.current === f && !f.abort.signal.aborted && valid(c);
    // Pending reads and hints retire consent immediately, not on response arrival.
    c.recovery.invalidate(c.owner!, BigInt(c.id!), 'restitution');
    if (!current()) return;
    c.recovery.invalidate(c.owner!, BigInt(c.id!), 'count');
    if (!current()) return;
    setView(p => ({ context: c, snapshot: same(p.context, c) && passive ? p.snapshot : null, busy: true, error: null }));
    async function failure(error: unknown, stream: 'restitution' | 'count') {
      if (!current()) return;
      const safe = readError(error);
      c.recovery.readFailure(c.owner!, BigInt(c.id!), stream, safe);
      if (!current()) return;
      if (safe.status === 403 || safe.status === 404) mask(c, safe);
      else if (current() && !f.dirty) setView(p => ({ ...p, error: safe, ...(stream === 'restitution' ? { snapshot: null } : {}) }));
      if (safe.status === 401 && valid(c)) await c.controller.settleUnauthorized(c.owner!.epoch);
    }
    try {
      await Promise.all([
        (async () => {
          try {
            if (!current()) return;
            const value = await c.api.restitutions(c.id!, { signal: f.abort.signal, passive });
            if (!current()) return;
            const snapshot = captureRestitutions(value);
            if (snapshot.request_id !== BigInt(c.id!)) throw new Error('Invalid restitution request');
            if (!current()) return;
            c.recovery.observe(c.owner!, snapshot, !passive && !f.dirty, f.dirty);
            if (!current()) return;
            drain(c);
            if (current() && !f.dirty) setView(p => ({ ...p, snapshot: c.recovery.isRequestMasked(c.owner, snapshot.request_id) ? null : snapshot }));
          } catch (error) { await failure(error, 'restitution'); }
        })(),
        (async () => {
          try {
            if (!current()) return;
            const value = await c.api.countCorrections(c.id!, { signal: f.abort.signal, passive });
            if (!current()) return;
            const snapshot = captureCountCorrections(value);
            if (snapshot.request_id !== BigInt(c.id!)) throw new Error('Invalid count request');
            if (!current()) return;
            c.recovery.observeCount(c.owner!, snapshot, !passive, f.dirty);
          } catch (error) { await failure(error, 'count'); }
        })(),
      ]);
    } finally {
      if (current()) {
        read.current = null;
        setView(p => same(p.context, c) ? { ...p, busy: false } : p);
        if (f.dirty) void load(c, true);
      }
    }
  }
  async function write(c: Context, token: RestitutionFlight) {
    const f: WriteFlight = { context: c, token, abort: new AbortController() }; writes.current.add(f);
    const current = () => writes.current.has(f) && !f.abort.signal.aborted && valid(c) && c.recovery.isCurrent(token, c.owner);
    try {
      if (!current()) return;
      const session = c.controller.getTransferAuthority().session;
      if (!session?.authenticated) return;
      const a = token.attempt; const payload = restitutionRetryPayload(a);
      const result = a.action === 'propose'
        ? await c.api.proposeRestitution(a.requestID.toString(), a.owner.location, payload as RestitutionProposalInput, session.csrf_token, f.abort.signal)
        : await c.api.decideRestitution(a.requestID.toString(), a.owner.location, a.action, payload, session.csrf_token, f.abort.signal);
      if (!current()) return;
      // finish may throw while still owning the token. Treat that as uncertain
      // malformed POST evidence and settle it through the restitution channel.
      try { c.recovery.finish(token, result); }
      catch { throw new RestitutionAPIError('invalid_response', 200, true); }
      if (valid(c)) drain(c);
    } catch (error) {
      if (!current()) return;
      const safe = error instanceof RestitutionAPIError ? error : new RestitutionAPIError('invalid_response', 200, true);
      c.recovery.fail(token, safe);
      if (!valid(c)) return;
      if (safe.status === 403 || safe.status === 404) mask(c, safe);
      else if (valid(c)) setView(p => same(p.context, c) ? { ...p, error: safe } : p);
      if (safe.status === 401 && valid(c)) await c.controller.settleUnauthorized(c.owner!.epoch);
    } finally {
      writes.current.delete(f); c.recovery.release(token);
    }
  }
  const ownerKey = JSON.stringify(owner);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; cancel(); }; }, []);
  useEffect(() => recovery.subscribe(() => { if (mounted.current) revision(n => n + 1); }), [recovery]);
  useEffect(() => {
    if (!context.enabled) { cancel(); return; }
    void load(context, true);
    const unsubscribe = controller.subscribeTransferInvalidation(() => {
      if (!valid(context)) return;
      recovery.invalidate(context.owner!, BigInt(context.id!), 'restitution');
      if (!valid(context)) return;
      recovery.invalidate(context.owner!, BigInt(context.id!), 'count');
      if (!valid(context)) return;
      void load(context, true);
    });
    return () => { unsubscribe(); cancel(); };
    // Every async lane checks the latest captured scalar authority and dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller.getTransferAuthority, controller.subscribeTransferInvalidation, controller.settleUnauthorized,
    context.api, recovery, id, variantID, header, context.enabled, ownerKey, onConfirmation]);
  function visible() { return valid(context) && same(view.context, context); }
  return {
    get snapshot() { return visible() && !recovery.isRequestMasked(owner, BigInt(id!)) ? view.snapshot : null; },
    get masked() { return valid(context) && recovery.isRequestMasked(owner, BigInt(id!)); },
    get error() { return visible() ? view.error : null; },
    get busy() { return valid(context) && (visible() && view.busy || recovery.get(owner, BigInt(id!)).some(a => a.phase === 'inFlight')); },
    get attempts() { return valid(context) ? recovery.get(owner, BigInt(id!)) : []; },
    refresh: () => load(context, false),
    recover: () => load(context, false),
    review(action: RestitutionAction) {
      if (!valid(context) || !context.record || context.variant === null) return null;
      const pin = recovery.review(owner!, context.record, context.variant, action);
      if (pin) pins.current.set(pin, context);
      return pin;
    },
    submit(pin: RestitutionReviewPin, input: RestitutionProposalInput | RestitutionDecisionInput): Promise<void> {
      const c = pins.current.get(pin);
      if (!c || !valid(c)) return Promise.resolve();
      try { const token = recovery.start(pin, input); return token ? write(c, token) : Promise.resolve(); }
      catch { if (valid(c)) setView(p => ({ ...p, error: new RestitutionAPIError('invalid_request', null) })); return Promise.resolve(); }
    },
    retry(variant: number): Promise<void> {
      if (!valid(context)) return Promise.resolve();
      const token = recovery.claim(owner!, BigInt(id!), variant);
      return token ? write(context, token) : Promise.resolve();
    },
  };
}
