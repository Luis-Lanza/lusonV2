import { useCallback, useEffect, useRef, useState } from 'react';
import { createTransferAPI, TransferAPIError } from './transferAPI';
import { decisionOwner, type DecisionOwner } from './transferDecisionRecovery';
import { countCorrectionsPath, type CountCorrections, type CountDecisionInput, type CountOperation, type CountProposalInput } from './transferCountCorrectionModel';
import { captureCountCorrections, countRetryPayload, createTransferCountCorrectionRecovery, sameCountOwner,
  type CountCorrectionFlight, type TransferCountCorrectionRecovery } from './transferCountCorrectionRecovery';
import type { TransferController } from './useInventory';

export interface TransferCountCorrectionsOptions {
  controller: TransferController;
  requestID: string | null;
  enabled?: boolean;
  api?: Pick<ReturnType<typeof createTransferAPI>, 'countCorrections' | 'proposeCount' | 'decideCount'>;
}
type API = NonNullable<TransferCountCorrectionsOptions['api']>;
interface Context {
  controller: TransferController; api: API; recovery: TransferCountCorrectionRecovery;
  id: string | null; owner: DecisionOwner | null; enabled: boolean;
}
interface ReadFlight { abort: AbortController; context: Context; dirty: boolean }
interface WriteFlight { abort: AbortController; context: Context; token: CountCorrectionFlight }
interface View { context: Context; snapshot: CountCorrections | null; busy: boolean; error: TransferAPIError | null; masked: boolean }
const safeError = (error: unknown) => error instanceof TransferAPIError ? error
  : new TransferAPIError('invalid_response', null, false, false, false, false, false, true);
function sameContext(a: Context, b: Context) {
  return a.controller.getTransferAuthority === b.controller.getTransferAuthority
    && a.controller.subscribeTransferInvalidation === b.controller.subscribeTransferInvalidation
    && a.controller.settleUnauthorized === b.controller.settleUnauthorized
    && a.controller.confirmTransferCountCorrection === b.controller.confirmTransferCountCorrection
    && a.api === b.api && a.recovery === b.recovery && a.id === b.id
    && a.enabled && b.enabled && sameCountOwner(a.owner, b.owner);
}

export function useTransferCountCorrections({ controller, requestID, enabled = true, api: injectedAPI }: TransferCountCorrectionsOptions) {
  const [defaultAPI] = useState(createTransferAPI);
  // Optional seams preserve legacy injected controllers. Real useInventory owns it.
  const [fallbackRecovery] = useState(createTransferCountCorrectionRecovery);
  const recovery = controller.countCorrectionRecovery ?? fallbackRecovery;
  let id: string | null = null;
  if (requestID !== null) { try { countCorrectionsPath(requestID); id = BigInt(requestID).toString(); } catch { /* Invalid selections cannot read. */ } }
  const owner = decisionOwner(controller.getTransferAuthority());
  recovery.synchronize(owner);
  const context: Context = { controller, api: injectedAPI ?? defaultAPI, recovery, id, owner, enabled: enabled && !!id && !!owner };
  const latest = useRef(context); latest.current = context;
  const mounted = useRef(false);
  const read = useRef<ReadFlight | null>(null);
  const writes = useRef(new Set<WriteFlight>());
  const [view, setView] = useState<View>({ context, snapshot: null, busy: false, error: null, masked: false });
  const [, revision] = useState(0);
  function valid(c: Context) {
    if (!mounted.current || !sameContext(c, latest.current)) return false;
    const now = decisionOwner(c.controller.getTransferAuthority());
    // Scalar mutation can precede a render. Hide and retire private memory now,
    // so returning to an old authority cannot resurrect captured evidence.
    c.recovery.synchronize(now);
    if (!sameCountOwner(c.owner, now)) { cancel(); return false; }
    return true;
  }
  function effects(c: Context, operation: CountOperation) {
    if (valid(c)) c.controller.confirmTransferCountCorrection?.(c.owner!, operation);
  }
  const cancel = useCallback(() => {
    read.current?.abort.abort(); read.current = null;
    for (const w of writes.current) { w.abort.abort(); w.context.recovery.release(w.token); }
    writes.current.clear();
  }, []);
  async function load(c: Context, passive: boolean) {
    if (!valid(c)) return;
    if (passive && read.current && sameContext(read.current.context, c)) { read.current.dirty = true; return; }
    read.current?.abort.abort();
    const flight: ReadFlight = { abort: new AbortController(), context: c, dirty: false }; read.current = flight;
    const current = () => read.current === flight && !flight.abort.signal.aborted && valid(c);
    setView(previous => ({ context: c, snapshot: sameContext(previous.context, c) && passive ? previous.snapshot : null,
      masked: sameContext(previous.context, c) && previous.masked, busy: true, error: null }));
    try {
      const snapshot = captureCountCorrections(await c.api.countCorrections(c.id!, { signal: flight.abort.signal, passive }));
      if (!current()) return;
      if (snapshot.request_id !== BigInt(c.id!)) throw new Error('Invalid count request identity');
      // A dirty read can prove immutable persistence, not the latest workflow head.
      const operations = c.recovery.observe(c.owner!, snapshot, !passive, flight.dirty);
      for (const operation of operations) { if (!current()) return; effects(c, operation); }
      for (const w of writes.current) if (sameContext(w.context, c) && !c.recovery.isCurrent(w.token, c.owner)) {
        w.abort.abort(); writes.current.delete(w);
      }
      if (current() && !flight.dirty) {
        const masked = c.recovery.isRequestMasked(c.owner, snapshot.request_id);
        setView({ context: c, snapshot: masked ? null : snapshot, masked, busy: false, error: null });
      }
    } catch (error) {
      if (!current()) return;
      const safe = safeError(error); const masked = safe.status === 403 || safe.status === 404;
      if (masked) {
        c.recovery.mask(c.owner!, BigInt(c.id!));
        for (const w of writes.current) if (sameContext(w.context, c)) { w.abort.abort(); writes.current.delete(w); }
      }
      if (!flight.dirty || masked) setView({ context: c, snapshot: null, masked, busy: false, error: safe });
      if (safe.status === 401 && current()) await c.controller.settleUnauthorized(c.owner!.epoch);
    } finally {
      if (current()) {
        read.current = null;
        setView(previous => sameContext(previous.context, c) ? { ...previous, busy: false } : previous);
        if (flight.dirty) void load(c, true);
      }
    }
  }
  async function write(c: Context, token: CountCorrectionFlight) {
    const flight: WriteFlight = { context: c, token, abort: new AbortController() }; writes.current.add(flight);
    const current = () => writes.current.has(flight) && !flight.abort.signal.aborted && valid(c) && c.recovery.isCurrent(token, c.owner);
    // Credentials stay transport-local and are never retained in recovery memory.
    const session = c.controller.getTransferAuthority().session;
    if (!current() || !session?.authenticated) { c.recovery.release(token); writes.current.delete(flight); return; }
    const csrf = session.csrf_token; const a = token.attempt; const payload = countRetryPayload(a);
    try {
      const result = a.action === 'propose'
        ? await c.api.proposeCount(a.requestID.toString(), a.owner.location, payload as CountProposalInput, csrf, flight.abort.signal)
        : await c.api.decideCount(a.requestID.toString(), a.owner.location, a.action, payload, csrf, flight.abort.signal);
      if (!current()) return;
      const operation = c.recovery.finish(token, result);
      if (operation && valid(c)) effects(c, operation);
    } catch (error) {
      if (!current()) return;
      const safe = safeError(error); c.recovery.fail(token, safe);
      if (safe.status === 403 || safe.status === 404) {
        c.recovery.mask(c.owner!, a.requestID);
        for (const other of writes.current) if (other !== flight && sameContext(other.context, c)) {
          other.abort.abort(); writes.current.delete(other);
        }
        read.current?.abort.abort(); read.current = null;
        setView({ context: c, snapshot: null, busy: false, masked: true, error: safe });
      } else setView(previous => sameContext(previous.context, c) ? { ...previous, error: safe }
        : { context: c, snapshot: null, busy: false, masked: false, error: safe });
      if (safe.status === 401 && valid(c)) await c.controller.settleUnauthorized(c.owner!.epoch);
    } finally {
      writes.current.delete(flight);
      if (sameContext(c, latest.current)) c.recovery.synchronize(decisionOwner(c.controller.getTransferAuthority()));
      c.recovery.release(token);
    }
  }
  function start(action: 'propose' | 'accept' | 'reject', input: CountProposalInput | CountDecisionInput) {
    const c = context;
    if (!valid(c) || c.recovery.isRequestMasked(c.owner, BigInt(c.id!))) return Promise.resolve();
    try {
      const token = c.recovery.start(c.id!, action, input, c.owner!);
      return token ? write(c, token) : Promise.resolve();
    } catch {
      const error = new TransferAPIError('invalid_request', null);
      setView(previous => sameContext(previous.context, c) ? { ...previous, error }
        : { context: c, snapshot: null, busy: false, masked: false, error });
      return Promise.resolve();
    }
  }
  const ownerKey = owner ? JSON.stringify(owner) : '';
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; cancel(); };
  }, [cancel]);
  useEffect(() => recovery.subscribe(() => { if (mounted.current) revision(n => n + 1); }), [recovery]);
  useEffect(() => {
    if (!context.enabled) { cancel(); return; }
    void load(context, true);
    const unsubscribe = controller.subscribeTransferInvalidation(() => { if (valid(context)) void load(context, true); });
    return () => { unsubscribe(); cancel(); };
    // Captured callbacks fence controller, API, selection and every owner scalar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller.getTransferAuthority, controller.subscribeTransferInvalidation, controller.settleUnauthorized,
    controller.confirmTransferCountCorrection, context.api, recovery, id, context.enabled, ownerKey, cancel]);
  function visible() { return valid(context) && sameContext(view.context, context); }
  return {
    get snapshot() { return visible() && !recovery.isRequestMasked(owner, BigInt(id!)) ? view.snapshot : null; },
    get busy() { return valid(context) && (visible() && view.busy || recovery.get(owner, BigInt(id!)).some(a => a.phase === 'inFlight')); },
    get error() { return visible() ? view.error : null; },
    get masked() { return valid(context) && recovery.isRequestMasked(owner, BigInt(id!)); },
    get attempts() { return valid(context) && !(visible() && view.masked) ? recovery.get(owner, BigInt(id!)) : []; },
    refresh: () => load(context, false),
    propose: (input: CountProposalInput) => start('propose', input),
    decide: (action: 'accept' | 'reject', input: CountDecisionInput) => start(action, input),
    retry: (variantID: number) => {
      if (!valid(context) || recovery.isRequestMasked(owner, BigInt(id!))) return Promise.resolve();
      const token = recovery.claim(owner!, BigInt(id!), variantID);
      return token ? write(context, token) : Promise.resolve();
    },
    recover: (variantID: number) => {
      if (!valid(context)) return Promise.resolve();
      if (!recovery.isRequestMasked(owner, BigInt(id!)) && !recovery.get(owner, BigInt(id!)).some(a => a.payload.variant_id === variantID)) return Promise.resolve();
      return load(context, false);
    },
  };
}
