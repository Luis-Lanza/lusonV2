import { useCallback, useEffect, useRef, useState } from 'react';
import { createDispatchReconciliationAPI, type DispatchReconciliationAPI, type DispatchReconciliationDecisionInput,
  type DispatchReconciliationProposalInput } from './transferDispatchReconciliationAPI';
import { captureDecisionRecord, decisionOwner, matchesDecisionRecord, type DecisionOwner } from './transferDecisionRecovery';
import { sameCountOwner } from './transferCountCorrectionRecovery';
import type { DispatchReconciliationAction, DispatchReconciliationOperation } from './transferDispatchReconciliationModel';
import { createTransferDispatchReconciliationStore, safeReconciliationError, type TransferDispatchReconciliationStore,
  type ReconciliationReadTicket, type ReconciliationWriteTicket } from './transferDispatchReconciliationStore';
import type { TransferRecord } from './transferModel';
import type { TransferController } from './useInventory';

export interface TransferDispatchReconciliationsOptions {
  controller: TransferController;
  record: TransferRecord | null;
  enabled?: boolean;
  api?: DispatchReconciliationAPI;
  /** Optional owner-held instance. Defaults are privately scoped to the stable authority reader. */
  store?: TransferDispatchReconciliationStore;
  /** Prepared confirmation seam only; inventory/role authority remains with the existing controller. */
  onConfirmed?: (owner: Readonly<DecisionOwner>, operation: DispatchReconciliationOperation) => void;
}
// Weak authority identity owns default memory across pane remounts. Nothing enumerates or
// exposes this cache; each access synchronizes the existing scalar owner/session fence.
const defaultStores = new WeakMap<TransferController['getTransferAuthority'], TransferDispatchReconciliationStore>();
function defaultStore(controller: TransferController) {
  let store = defaultStores.get(controller.getTransferAuthority);
  if (!store) { store = createTransferDispatchReconciliationStore(); defaultStores.set(controller.getTransferAuthority, store); }
  return store;
}
interface Context {
  controller: TransferController; source: TransferRecord | null; record: TransferRecord | null; owner: DecisionOwner | null; enabled: boolean;
  api: DispatchReconciliationAPI; store: TransferDispatchReconciliationStore;
}
interface ReadFlight { context: Context; abort: AbortController; ticket: ReconciliationReadTicket }
interface WriteFlight { context: Context; abort: AbortController; ticket: ReconciliationWriteTicket }
function sameContext(a: Context, b: Context) {
  return a.enabled && b.enabled && a.controller.getTransferAuthority === b.controller.getTransferAuthority
    && a.controller.subscribeTransferInvalidation === b.controller.subscribeTransferInvalidation
    && a.controller.settleUnauthorized === b.controller.settleUnauthorized && a.api === b.api && a.store === b.store
    && sameCountOwner(a.owner, b.owner) && !!a.record && !!b.record
    && matchesDecisionRecord(a.record, b.record) && matchesDecisionRecord(b.record, a.record);
}
/** Controlled data/actions, not a view or an authorization capability. No effect ever POSTs. */
export function useTransferDispatchReconciliations({ controller, record, enabled = true, api: injectedAPI,
  store: injectedStore, onConfirmed }: TransferDispatchReconciliationsOptions) {
  const [defaultAPI] = useState(createDispatchReconciliationAPI);
  const store = injectedStore ?? defaultStore(controller);
  let captured: TransferRecord | null = null;
  try { if (record) { captured = captureDecisionRecord(record); if (captured.status !== 'received') captured = null; } } catch { /* Invalid scope is empty. */ }
  const owner = decisionOwner(controller.getTransferAuthority());
  store.synchronize(owner);
  const context: Context = { controller, source: record, record: captured, owner, enabled: enabled && !!captured && !!owner,
    api: injectedAPI ?? defaultAPI, store };
  // Synchronous selection masks private fields during render, before effect cleanup.
  store.select(owner, context.enabled ? captured : null);
  const latest = useRef(context); latest.current = context;
  // Observers are not authority or transport scope. A rerender may replace one without aborting intent.
  const observer = useRef(onConfirmed); observer.current = onConfirmed;
  const mounted = useRef(false);
  const read = useRef<ReadFlight | null>(null);
  const writes = useRef(new Set<WriteFlight>());
  const [, revision] = useState(0);
  const cancel = useCallback((c?: Context) => {
    if (read.current && (!c || sameContext(read.current.context, c))) {
      const flight = read.current; read.current = null; flight.abort.abort(); flight.context.store.releaseRead(flight.ticket);
    }
    for (const flight of writes.current) if (!c || sameContext(flight.context, c)) {
      writes.current.delete(flight); flight.abort.abort(); flight.context.store.release(flight.ticket);
    }
  }, []);
  function valid(c: Context): boolean {
    if (!mounted.current || !sameContext(c, latest.current)) return false;
    const now = decisionOwner(c.controller.getTransferAuthority());
    c.store.synchronize(now);
    if (!sameCountOwner(c.owner, now)) { cancel(c); return false; }
    try {
      const source = captureDecisionRecord(c.source!);
      if (!matchesDecisionRecord(c.record!, source) || !matchesDecisionRecord(source, c.record!)) throw new Error('Changed record scope');
    } catch {
      c.store.select(now, null); cancel(c); return false;
    }
    return true;
  }
  function notify(c: Context, op: DispatchReconciliationOperation) {
    if (valid(c)) observer.current?.(Object.freeze({ ...c.owner! }), op);
  }
  async function load(c: Context, explicit: boolean) {
    if (!valid(c)) return;
    if (read.current) {
      const old = read.current; read.current = null; old.abort.abort(); old.context.store.releaseRead(old.ticket);
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
    } catch (error) {
      if (!current() || !c.store.isReadCurrent(ticket)) return;
      const safe = safeReconciliationError(error); c.store.failRead(ticket, safe);
      if (safe.status === 401 || safe.status === 403 || safe.status === 404) {
        for (const w of writes.current) if (sameContext(w.context, c)) { writes.current.delete(w); w.abort.abort(); c.store.release(w.ticket); }
      }
      if (safe.status === 401 && valid(c)) await c.controller.settleUnauthorized(c.owner!.epoch);
    } finally {
      if (read.current === flight) read.current = null;
      c.store.releaseRead(ticket);
    }
  }
  async function write(c: Context, ticket: ReconciliationWriteTicket) {
    const flight: WriteFlight = { context: c, ticket, abort: new AbortController() }; writes.current.add(flight);
    const current = () => writes.current.has(flight) && !flight.abort.signal.aborted && valid(c) && c.store.isWriteCurrent(ticket);
    try {
      if (!current()) return;
      // Only this transport frame sees current credentials. Recovery stores immutable intent, never the session.
      const authority = c.controller.getTransferAuthority();
      if (!sameCountOwner(c.owner, decisionOwner(authority)) || !authority.session?.authenticated) return;
      const csrf = authority.session.csrf_token;
      const a = ticket.attempt; const p = a.payload;
      const input: DispatchReconciliationDecisionInput | DispatchReconciliationProposalInput = Object.freeze({ variant_id: p.variant_id,
        operation_key: p.operation_key, expected_revision: p.expected_revision.toString(), reason: p.reason,
        ...('dispatch_quantity' in p ? { dispatch_quantity: p.dispatch_quantity.toString() } : {}) });
      const result = a.action === 'propose'
        ? await c.api.propose(a.original, a.actor, input as DispatchReconciliationProposalInput, csrf, flight.abort.signal)
        : await c.api.decide(a.original, a.actor, a.action, input, csrf, flight.abort.signal);
      if (!current()) return;
      const operation = c.store.finishWrite(ticket, result);
      if (operation) {
        notify(c, operation);
        // Discard reads that began before the persisted write; only a new GET may supply a review head.
        if (valid(c)) void load(c, false);
      }
    } catch (error) {
      if (!current()) return;
      const safe = safeReconciliationError(error); c.store.failWrite(ticket, safe);
      if (safe.status === 401 || safe.status === 403 || safe.status === 404) cancel(c);
      if (safe.status === 401 && valid(c)) await c.controller.settleUnauthorized(c.owner!.epoch);
    } finally {
      writes.current.delete(flight);
      c.store.release(ticket);
    }
  }
  const ownerKey = owner ? JSON.stringify(owner) : '';
  // Exact admitted evidence, not object identity: equivalent parent renders retain flights.
  const recordKey = captured ? JSON.stringify(captured, (_k, value: unknown) => typeof value === 'bigint' ? value.toString() : value) : '';
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; cancel(); };
  }, [cancel]);
  useEffect(() => store.subscribe(() => { if (mounted.current) revision(n => n + 1); }), [store]);
  useEffect(() => {
    if (!context.enabled) return;
    void load(context, false);
    const off = controller.subscribeTransferInvalidation(() => {
      if (valid(context)) void load(context, false);
      // Retiring owner memory alone does not repaint an already-rendered private DOM.
      // Notify only this still-selected mounted context; obsolete subscriptions cannot revive it.
      else if (mounted.current && sameContext(context, latest.current)) revision(n => n + 1);
    });
    return () => { off(); cancel(context); };
    // The context fences all captured callbacks, including record evidence and private owner scalars.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller.getTransferAuthority, controller.subscribeTransferInvalidation, controller.settleUnauthorized,
    context.api, store, context.enabled, recordKey, ownerKey, cancel]);
  function state() { return valid(context) ? store.state(owner, captured!) : store.state(null, captured!); }
  return {
    get snapshot() { return state().snapshot; },
    get draft() { return state().draft; },
    get reviewState() { return state().review; },
    get attempts() { return state().attempts; },
    get busy() { return state().busy; },
    get error() { return state().error; },
    get masked() { return state().masked; },
    begin: (variantID: number, action: DispatchReconciliationAction) => valid(context) && store.begin(owner!, captured!, variantID, action),
    setReason: (reason: string) => { if (valid(context)) store.setReason(owner!, captured!, reason); },
    review: () => valid(context) && store.review(owner!, captured!),
    cancel: () => { if (valid(context)) store.cancel(owner!, captured!); },
    confirm: () => {
      if (!valid(context)) return Promise.resolve();
      const ticket = store.confirm(owner!, captured!); return ticket ? write(context, ticket) : Promise.resolve();
    },
    refresh: () => load(context, true),
    recover: () => load(context, true),
    retry: (variantID: number) => {
      if (!valid(context)) return Promise.resolve();
      const ticket = store.retry(owner!, captured!, variantID); return ticket ? write(context, ticket) : Promise.resolve();
    },
  };
}
