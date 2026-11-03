import { useCallback, useEffect, useRef, useState } from 'react';
import { createUnifiedReconciliationAPI, type UnifiedReconciliationAPI } from './transferUnifiedReconciliationAPI';
import { captureDecisionRecord, decisionOwner, matchesDecisionRecord, type DecisionOwner } from './transferDecisionRecovery';
import { sameCountOwner } from './transferCountCorrectionRecovery';
import type { UnifiedReconciliationAction, UnifiedReconciliationDecisionInput, UnifiedReconciliationProposalInput,
  UnifiedReconciliationOperation } from './transferUnifiedReconciliationModel';
import { createTransferUnifiedReconciliationStore, safeUnifiedReconciliationError, type TransferUnifiedReconciliationStore,
  type UnifiedReconciliationReadTicket, type UnifiedReconciliationWriteTicket } from './transferUnifiedReconciliationStore';
import type { TransferRecord } from './transferModel';
import type { TransferController } from './useInventory';
export interface TransferUnifiedReconciliationsOptions {
  controller: TransferController;
  record: TransferRecord | null;
  enabled?: boolean;
  api?: UnifiedReconciliationAPI;
  store?: TransferUnifiedReconciliationStore;
  onConfirmed?: (owner: Readonly<DecisionOwner>, operation: UnifiedReconciliationOperation) => void;
}
// Same owner-scoped, weak authority-reader lifetime as dispatch recovery. No global auth listener or credentials.
const defaultStores = new WeakMap<TransferController['getTransferAuthority'], TransferUnifiedReconciliationStore>();
function defaultStore(controller: TransferController) {
  let store = defaultStores.get(controller.getTransferAuthority);
  if (!store) { store = createTransferUnifiedReconciliationStore(); defaultStores.set(controller.getTransferAuthority, store); }
  return store;
}
interface Context {
  controller: TransferController; source: TransferRecord | null; record: TransferRecord | null;
  owner: DecisionOwner | null; enabled: boolean; api: UnifiedReconciliationAPI; store: TransferUnifiedReconciliationStore;
}
interface ReadFlight { context: Context; abort: AbortController; ticket: UnifiedReconciliationReadTicket }
interface WriteFlight { context: Context; abort: AbortController; ticket: UnifiedReconciliationWriteTicket }
function sameContext(a: Context, b: Context) {
  return a.enabled && b.enabled && a.controller.getTransferAuthority === b.controller.getTransferAuthority
    && a.controller.subscribeTransferInvalidation === b.controller.subscribeTransferInvalidation
    && a.controller.settleUnauthorized === b.controller.settleUnauthorized && a.api === b.api && a.store === b.store
    && sameCountOwner(a.owner, b.owner) && !!a.record && !!b.record
    && matchesDecisionRecord(a.record, b.record) && matchesDecisionRecord(b.record, a.record);
}
/** Inert until mounted. Effects GET only; prepare/confirm/retry are explicit user-action seams. */
export function useTransferUnifiedReconciliations({ controller, record, enabled = true, api: injectedAPI,
  store: injectedStore, onConfirmed }: TransferUnifiedReconciliationsOptions) {
  const [defaultAPI] = useState(createUnifiedReconciliationAPI);
  const store = injectedStore ?? defaultStore(controller);
  let captured: TransferRecord | null = null;
  try { if (record) { captured = captureDecisionRecord(record); if (captured.status !== 'received') captured = null; } } catch { /* Invalid scope stays private-empty. */ }
  const owner = decisionOwner(controller.getTransferAuthority());
  store.synchronize(owner);
  const context: Context = { controller, source: record, record: captured, owner, enabled: enabled && !!captured && !!owner,
    api: injectedAPI ?? defaultAPI, store };
  store.select(owner, context.enabled ? captured : null);
  const latest = useRef(context); latest.current = context;
  const observer = useRef(onConfirmed); observer.current = onConfirmed;
  const mounted = useRef(false), read = useRef<ReadFlight | null>(null), writes = useRef(new Set<WriteFlight>());
  const [, revision] = useState(0);
  const cancel = useCallback((c?: Context) => {
    if (read.current && (!c || sameContext(read.current.context, c))) {
      const f = read.current; read.current = null; f.abort.abort(); f.context.store.releaseRead(f.ticket);
    }
    for (const f of writes.current) if (!c || sameContext(f.context, c)) {
      writes.current.delete(f); f.abort.abort(); f.context.store.release(f.ticket);
    }
  }, []);
  function valid(c: Context): boolean {
    if (!mounted.current || !sameContext(c, latest.current)) return false;
    const now = decisionOwner(c.controller.getTransferAuthority()); c.store.synchronize(now);
    if (!sameCountOwner(c.owner, now)) { cancel(c); return false; }
    try {
      const source = captureDecisionRecord(c.source!);
      if (!matchesDecisionRecord(c.record!, source) || !matchesDecisionRecord(source, c.record!)) throw new Error('Changed record scope');
    } catch { c.store.select(now, null); cancel(c); return false; }
    return true;
  }
  function notify(c: Context, op: UnifiedReconciliationOperation) { if (valid(c)) observer.current?.(Object.freeze({ ...c.owner! }), op); }
  async function load(c: Context, explicit: boolean) {
    if (!valid(c)) return;
    if (read.current) {
      const f = read.current; read.current = null; f.abort.abort(); f.context.store.releaseRead(f.ticket);
    }
    const ticket = c.store.beginRead(c.owner!, c.record!, explicit); if (!ticket) return;
    const flight: ReadFlight = { context: c, ticket, abort: new AbortController() }; read.current = flight;
    const current = () => read.current === flight && !flight.abort.signal.aborted && valid(c);
    try {
      const value = await c.api.read(ticket.original, { signal: flight.abort.signal, passive: !explicit });
      if (!current() || !c.store.isReadCurrent(ticket)) return;
      const operations = c.store.finishRead(ticket, value);
      for (const op of operations) { if (!current()) return; notify(c, op); }
      for (const w of writes.current) if (sameContext(w.context, c) && !c.store.isWriteCurrent(w.ticket)) {
        writes.current.delete(w); w.abort.abort();
      }
    } catch (failure) {
      if (!current() || !c.store.isReadCurrent(ticket)) return;
      const safe = safeUnifiedReconciliationError(failure); c.store.failRead(ticket, safe);
      if ([401, 403, 404].includes(safe.status!)) {
        for (const w of writes.current) if (sameContext(w.context, c)) { writes.current.delete(w); w.abort.abort(); c.store.release(w.ticket); }
      }
      // A passive GET may mask this pane, never change the private session.
      if (explicit && safe.status === 401 && valid(c)) await c.controller.settleUnauthorized(c.owner!.epoch);
    } finally {
      if (read.current === flight) read.current = null;
      c.store.releaseRead(ticket);
    }
  }
  async function write(c: Context, ticket: UnifiedReconciliationWriteTicket) {
    const flight: WriteFlight = { context: c, ticket, abort: new AbortController() }; writes.current.add(flight);
    const current = () => writes.current.has(flight) && !flight.abort.signal.aborted && valid(c) && c.store.isWriteCurrent(ticket);
    try {
      if (!current()) return;
      const authority = c.controller.getTransferAuthority();
      if (!sameCountOwner(c.owner, decisionOwner(authority)) || !authority.session?.authenticated) return;
      const a = ticket.attempt, p = a.payload;
      const input: UnifiedReconciliationDecisionInput | UnifiedReconciliationProposalInput = Object.freeze({
        variant_id: p.variant_id, operation_key: p.operation_key, expected_revision: p.expected_revision.toString(),
        reason: p.reason, retained_at_origin: p.retained_at_origin,
        ...('dispatch_quantity' in p ? { dispatch_quantity: p.dispatch_quantity.toString(), arrival_quantity: p.arrival_quantity.toString(),
          retained_quantity: p.retained_quantity.toString() } : {}) });
      const op = a.action === 'propose'
        ? await c.api.propose(a.original, a.actor, input as UnifiedReconciliationProposalInput, authority.session.csrf_token, flight.abort.signal)
        : await c.api.decide(a.original, a.actor, a.action, input, authority.session.csrf_token, flight.abort.signal);
      if (!current()) return;
      const confirmed = c.store.finishWrite(ticket, op);
      if (confirmed) { notify(c, confirmed); if (valid(c)) void load(c, false); }
    } catch (failure) {
      if (!current()) return;
      const safe = safeUnifiedReconciliationError(failure); c.store.failWrite(ticket, safe);
      if ([401, 403, 404].includes(safe.status!)) cancel(c);
      if (safe.status === 401 && valid(c)) await c.controller.settleUnauthorized(c.owner!.epoch);
    } finally { writes.current.delete(flight); c.store.release(ticket); }
  }
  const ownerKey = owner ? JSON.stringify(owner) : '';
  const recordKey = captured ? JSON.stringify(captured, (_k, v: unknown) => typeof v === 'bigint' ? v.toString() : v) : '';
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; cancel(); }; }, [cancel]);
  useEffect(() => store.subscribe(() => { if (mounted.current) revision(n => n + 1); }), [store]);
  useEffect(() => {
    if (!context.enabled) return;
    void load(context, false);
    const off = controller.subscribeTransferInvalidation(() => {
      if (valid(context)) void load(context, false);
      else if (mounted.current && sameContext(context, latest.current)) revision(n => n + 1);
    });
    return () => { off(); cancel(context); };
    // Scope is immutable evidence plus private owner scalars, not parent object identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller.getTransferAuthority, controller.subscribeTransferInvalidation, controller.settleUnauthorized,
    context.api, store, context.enabled, recordKey, ownerKey, cancel]);
  function state() { return valid(context) ? store.state(owner, captured!) : store.state(null, captured!); }
  return {
    get snapshot() { return state().snapshot; },
    get prepared() { return state().prepared; },
    get attempts() { return state().attempts; },
    get busy() { return state().busy; },
    get error() { return state().error; },
    get masked() { return state().masked; },
    prepare: (action: UnifiedReconciliationAction, input: UnifiedReconciliationDecisionInput | UnifiedReconciliationProposalInput) =>
      valid(context) && store.prepare(owner!, captured!, action, input),
    cancel: () => { if (valid(context)) store.cancel(owner!, captured!); },
    confirm: () => {
      if (!valid(context)) return Promise.resolve();
      const ticket = store.confirm(owner!, captured!); return ticket ? write(context, ticket) : Promise.resolve();
    },
    refresh: () => load(context, true),
    recover: () => load(context, true),
    retry: (variant: number) => {
      if (!valid(context)) return Promise.resolve();
      const ticket = store.retry(owner!, captured!, variant); return ticket ? write(context, ticket) : Promise.resolve();
    },
  };
}
