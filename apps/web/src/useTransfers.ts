import { useCallback, useEffect, useRef, useState } from 'react';
import type { TransferController } from './useInventory';
import type { Session } from './model';
import { captureDecisionRecord, decisionOwner, matchesDecisionRecord, satisfiesDecision, type DecisionFlight, type TransferDecision } from './transferDecisionRecovery';
import type { CancellationFlight } from './transferCancellationRecovery';
import type { DispatchFlight } from './transferDispatchRecovery';
import type { ReceiptFlight } from './transferReceiptRecovery';
import { createTransferAPI, TransferAPIError, type TransferCreateResult } from './transferAPI';
import {
  matchesReceiptInput, canonicalTransferInput, transferDetailPath, transferListPath,
  type TransferReceiptInput, type TransferCounts, type TransferCreateInput, type TransferPage, type TransferQuery, type TransferRecord,
} from './transferModel';

export interface TransferHookOptions {
  controller: TransferController; api?: ReturnType<typeof createTransferAPI>;
  listEnabled?: boolean; detailEnabled?: boolean; countsEnabled?: boolean;
}
const initialQuery = (): TransferQuery => Object.freeze({ page: 1, page_size: 25, status: 'pending' });
function sanitized(error: unknown, creating = false): TransferAPIError {
  return error instanceof TransferAPIError ? error : new TransferAPIError('invalid_response', null, creating);
}
function sessionIdentity(session: Session | null): string {
  if (!session?.authenticated) return '';
  // Snapshot scalar values, not a mutable session reference. Never expose this tag.
  return JSON.stringify([session.csrf_token, session.identity.account_id, session.identity.username,
    session.identity.location.id, session.identity.location.name, session.expires_at]);
}
function participant(record: TransferRecord, assigned: number) {
  if (record.origin_location_id !== assigned && record.destination_location_id !== assigned) throw new TransferAPIError('invalid_response', 200);
}

type ReadConfig<T> = {
  controller: TransferController; epoch: number; identity: string; enabled: boolean; key: string;
  discardOnRefresh?: boolean;
  read: (signal: AbortSignal, passive: boolean) => Promise<T>;
};
// Instance-owned list, detail and counts lanes share lifecycle fences, not data.
function useParticipantRead<T extends TransferPage | TransferRecord | TransferCounts>(config: ReadConfig<T>) {
  const latest = useRef(config); latest.current = config;
  const [job, setJob] = useState({ sequence: 0, epoch: -1, passive: true });
  const [state, setState] = useState({ epoch: -1, key: '', data: null as T | null, busy: false, error: null as TransferAPIError | null });
  const pending = useRef<{ controller: AbortController; dirty: boolean } | null>(null);
  const queued = useRef<{ epoch: number; passive: boolean; dirty: boolean } | null>(null);
  const cancel = useCallback(() => { pending.current?.controller.abort(); pending.current = null; }, []);
  const refresh = useCallback((passive: boolean) => {
    const c = latest.current; const authority = c.controller.getTransferAuthority();
    if (!authority.ready || authority.epoch !== c.epoch || sessionIdentity(authority.session) !== c.identity || (passive && !c.enabled)) return;
    if (c.discardOnRefresh) setState({ epoch: c.epoch, key: c.key, data: null, busy: true, error: null });
    if (passive && pending.current) { pending.current.dirty = true; return; }
    if (passive && queued.current?.epoch === c.epoch && !queued.current.passive) { queued.current.dirty = true; return; }
    queued.current = { epoch: c.epoch, passive, dirty: false };
    if (!passive) {
      cancel();
      setState({ epoch: c.epoch, key: c.key, data: null, busy: false, error: null });
    }
    setJob(previous => ({ sequence: previous.sequence + 1, epoch: c.epoch, passive }));
  }, [cancel]);
  useEffect(() => {
    cancel();
    if (!config.enabled) {
      queued.current = null;
      setState({ epoch: -1, key: '', data: null, busy: false, error: null });
      setJob(previous => previous.passive ? previous : { ...previous, passive: true });
      return;
    }
    const c = config;
    const flight = { controller: new AbortController(), dirty: queued.current?.epoch === c.epoch && queued.current.dirty === true };
    queued.current = null; pending.current = flight;
    const valid = () => {
      const authority = c.controller.getTransferAuthority(); const now = latest.current;
      return pending.current === flight && authority.ready && authority.epoch === c.epoch
        && sessionIdentity(authority.session) === c.identity
        && now.controller.getTransferAuthority === c.controller.getTransferAuthority && now.identity === c.identity
        && now.enabled && now.epoch === c.epoch && now.key === c.key;
    };
    if (!valid()) { cancel(); return; }
    const passive = job.epoch !== c.epoch || job.passive;
    setState(previous => ({ epoch: c.epoch, key: c.key,
      data: !c.discardOnRefresh && previous.epoch === c.epoch && previous.key === c.key ? previous.data : null, busy: true, error: null }));
    void (async () => {
      try {
        const data = await c.read(flight.controller.signal, passive);
        if (valid() && !flight.dirty) setState({ epoch: c.epoch, key: c.key, data, busy: false, error: null });
      } catch (error) {
        if (!valid()) return;
        const safe = sanitized(error);
        setState({ epoch: c.epoch, key: c.key, data: null, busy: false, error: safe });
        if (safe.status === 401) await c.controller.settleUnauthorized(c.epoch);
      } finally {
        if (valid()) {
          pending.current = null;
          setState(previous => ({ ...previous, busy: false }));
          if (flight.dirty) setJob(previous => ({ sequence: previous.sequence + 1, epoch: c.epoch, passive: true }));
        }
      }
    })();
    return cancel;
    // Each lane captures an immutable key/reason/authority for the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.controller.getTransferAuthority, config.enabled, config.epoch, config.identity, config.key, job, cancel]);
  function visible() {
    const authority = config.controller.getTransferAuthority();
    return config.enabled && authority.ready && authority.epoch === config.epoch
      && sessionIdentity(authority.session) === config.identity
      && state.epoch === config.epoch && state.key === config.key;
  }
  return { get data() { return visible() ? state.data : null; },
    get busy() { return visible() && state.busy; }, get error() { return visible() ? state.error : null; }, refresh };
}

export function useTransfers({ controller, api: injectedAPI, listEnabled = false, detailEnabled = false, countsEnabled = false }: TransferHookOptions) {
  const [defaultAPI] = useState(() => createTransferAPI());
  const api = injectedAPI ?? defaultAPI;
  const authority = controller.getTransferAuthority();
  const { epoch, ready, session } = authority;
  const identity = sessionIdentity(session);
  const [view, setView] = useState({ epoch, identity, query: initialQuery(), id: null as string | null });
  const currentView = view.identity === identity ? { ...view, epoch } : { epoch, identity, query: initialQuery(), id: null };
  const query = currentView.query; const selectedID = currentView.id;
  const assigned = session?.authenticated ? session.identity.location.id : null;
  const list = useParticipantRead({ controller, epoch, identity, enabled: ready && listEnabled, key: identity + transferListPath(query),
    read: async (signal, passive) => {
      const page = await api.list(query, { signal, passive });
      if (page.page !== (query.page ?? 1) || page.page_size !== (query.page_size ?? 25) || page.status !== (query.status ?? 'pending')
        || page.records.some(record => record.status !== page.status)) throw new TransferAPIError('invalid_response', 200);
      for (const record of page.records) participant(record, assigned!);
      return page;
    } });
  const detail = useParticipantRead({ controller, epoch, identity, enabled: ready && detailEnabled && !!selectedID, key: identity + (selectedID ?? ''),
    read: async (signal, passive) => {
      const record = await api.detail(selectedID!, { signal, passive });
      participant(record, assigned!);
      if (record.id !== selectedID) throw new TransferAPIError('invalid_response', 200);
      return record;
    } });
  const counts = useParticipantRead({ controller, epoch, identity, enabled: ready && countsEnabled,
    key: identity + '/api/transfers/counts', discardOnRefresh: true, read: signal => api.counts({ signal }) });
  const callbacks = useRef({ list: list.refresh, detail: detail.refresh, counts: counts.refresh });
  callbacks.current = { list: list.refresh, detail: detail.refresh, counts: counts.refresh };
  const invalidate = useCallback(() => { callbacks.current.list(true); callbacks.current.detail(true); callbacks.current.counts(true); }, []);
  useEffect(() => {
    if (!ready) return;
    // An obsolete subscription must not invalidate newer-epoch lanes.
    return controller.subscribeTransferInvalidation(() => {
      const now = controller.getTransferAuthority();
      if (now.ready && now.epoch === epoch && sessionIdentity(now.session) === identity) invalidate();
    });
  }, [controller.subscribeTransferInvalidation, epoch, identity, ready, invalidate]);
  const creation = useRef<{ epoch: number; controller: AbortController } | null>(null);
  const [submission, setSubmission] = useState({ epoch: -1, busy: false, error: null as TransferAPIError | null });
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; creation.current?.controller.abort(); creation.current = null; }; }, []);
  useEffect(() => {
    if (view.epoch !== epoch || view.identity !== identity) setView(currentView);
    creation.current?.controller.abort(); creation.current = null;
    setSubmission({ epoch, busy: false, error: null });
  }, [epoch, identity, ready]);
  function changeQuery(patch: TransferQuery) {
    // Validate exact admitted fields before merging; no search/flow/actor filters.
    transferListPath(patch);
    if (!visibleAuthority()) return;
    const captured = { ...patch };
    list.refresh(false);
    setView(previous => {
      const before = previous.identity === identity ? { ...previous, epoch } : { epoch, identity, query: initialQuery(), id: null };
      const next = { ...before.query, ...captured };
      if ((captured.page_size !== undefined || captured.status !== undefined) && captured.page === undefined) next.page = 1;
      return { ...before, query: Object.freeze(next) };
    });
  }
  function selectDetail(id: string | null) {
    if (id !== null) transferDetailPath(id);
    if (!visibleAuthority()) return;
    detail.refresh(false);
    setView(previous => ({ epoch, identity, query: previous.identity === identity ? previous.query : initialQuery(), id }));
  }
  async function submit(input: TransferCreateInput): Promise<TransferCreateResult> {
    const before = controller.getTransferAuthority();
    if (!mounted.current || !before.ready || before.epoch !== epoch || sessionIdentity(before.session) !== identity || !before.session?.authenticated) throw new TransferAPIError('unauthenticated', null);
    const actor = before.session.identity.location.id;
    if (actor !== 2 && actor !== 3) throw new TransferAPIError('forbidden', null);
    let canonical: TransferCreateInput;
    try { canonical = canonicalTransferInput(input); } catch { throw new TransferAPIError('invalid_request', null); }
    if (canonical.kind === 'request_stock' && canonical.counterparty_location_id === actor) throw new TransferAPIError('invalid_request', null);
    if (creation.current?.epoch === before.epoch) throw new TransferAPIError('invalid_request', null);
    const flight = { epoch: before.epoch, controller: new AbortController() }; creation.current = flight;
    const valid = () => {
      const now = controller.getTransferAuthority();
      return mounted.current && creation.current === flight && now.ready && now.epoch === before.epoch
        && sessionIdentity(now.session) === identity;
    };
    setSubmission({ epoch: before.epoch, busy: true, error: null });
    try {
      const result = await api.create(canonical, before.session.csrf_token, flight.controller.signal);
      if (!valid()) throw new TransferAPIError('aborted', null, true);
      participant(result.record, actor);
      if (result.record.status !== 'pending') {
        // A terminal original-creation replay must confirm THIS immutable attempt.
        // Pending creation compatibility remains unchanged; no decision retry here.
        const record = result.record;
        const counterpart = canonical.counterparty_location_id;
        const send = canonical.kind === 'send_to_warehouse';
        const matches = record.kind === canonical.kind && record.creator_location_id === actor
          && record.origin_location_id === (send ? actor : counterpart)
          && record.destination_location_id === (send ? 1 : actor)
          && record.approver_location_id === counterpart && record.items.length === canonical.items.length
          && canonical.items.every(line => record.items.some(item => item.variant_id === line.variant_id
            && item.quantity === BigInt(line.quantity)));
        if (!matches) throw new TransferAPIError('invalid_response', result.replayed ? 200 : 201, true);
      }
      invalidate(); return result;
    } catch (error) {
      if (!valid()) throw new TransferAPIError('aborted', null, true);
      const safe = sanitized(error, true);
      setSubmission({ epoch: before.epoch, busy: false, error: safe });
      if (safe.status === 401) await controller.settleUnauthorized(before.epoch);
      throw safe;
    } finally {
      if (valid()) { creation.current = null; setSubmission(previous => ({ ...previous, busy: false })); }
    }
  }
  const recovery = controller.decisionRecovery;
  const [, updateDecision] = useState(0);
  const decisionTransport = useRef<AbortController | null>(null);
  useEffect(() => recovery?.subscribe(() => updateDecision(value => value + 1)), [recovery]);
  useEffect(() => () => { decisionTransport.current?.abort(); }, []);
  function currentDecisionOwner() {
    const now = controller.getTransferAuthority();
    return mounted.current && visibleAuthority() && now.sessionGeneration === authority.sessionGeneration ? decisionOwner(now) : null;
  }
  function admittedDecision() {
    const owner = currentDecisionOwner();
    if (!owner) throw new TransferAPIError('unauthenticated', null);
    if (!recovery) throw new TransferAPIError('invalid_request', null);
    return { owner, recovery };
  }
  async function runDecision(token: DecisionFlight, reading: boolean): Promise<TransferRecord> {
    const transport = new AbortController(); decisionTransport.current = transport;
    const { original, action, owner } = token.attempt;
    const valid = () => !!currentDecisionOwner() && recovery!.isCurrent(token, currentDecisionOwner());
    try {
      const before = controller.getTransferAuthority();
      if (!valid() || !before.session?.authenticated) throw new TransferAPIError('aborted', null, false, true);
      const returned = reading ? await api.detail(original.id, { signal: transport.signal })
        : await api.decide(original, action, before.session.csrf_token, transport.signal);
      if (!valid()) throw new TransferAPIError('aborted', null, false, true);
      let record: TransferRecord;
      try {
        record = captureDecisionRecord(returned);
        participant(record, owner.location);
        if (!matchesDecisionRecord(original, record) || record.approver_location_id !== owner.location
          || (!reading && !satisfiesDecision(action, record))) throw new Error();
      } catch { throw new TransferAPIError('invalid_response', 200, false, !reading); }
      const terminal = recovery!.finish(token, record);
      if (terminal) {
        if (record.status === 'cancelled') controller.confirmTransferCancellation?.(owner, record);
        else controller.confirmTransferDecision?.(owner, record.status);
      }
      return record;
    } catch (error) {
      const current = valid();
      const safe = current ? error instanceof TransferAPIError ? error : new TransferAPIError('invalid_response', null, false, !reading)
        : new TransferAPIError('aborted', null, false, true);
      // A stale/unmounted completion remains unknown. Only its opaque flight may
      // be released; it cannot settle or reveal a replacement owner's attempt.
      recovery!.finish(token, undefined, current && (safe.status === 403 || safe.status === 404), safe);
      if (current) {
        if (safe.status === 401 && currentDecisionOwner()) await controller.settleUnauthorized(owner.epoch);
      }
      throw safe;
    } finally {
      if (decisionTransport.current === transport) decisionTransport.current = null;
    }
  }
  async function decide(original: TransferRecord, action: TransferDecision): Promise<TransferRecord> {
    const { owner, recovery } = admittedDecision();
    if (original.approver_location_id !== owner.location) throw new TransferAPIError('forbidden', null);
    let token: DecisionFlight | null;
    try { token = recovery.start(original, action, owner); } catch { throw new TransferAPIError('invalid_request', null); }
    if (!token) throw new TransferAPIError('invalid_request', null);
    return runDecision(token, false);
  }
  async function retryDecision(): Promise<TransferRecord> {
    const { owner, recovery } = admittedDecision();
    const snapshot = recovery.get(owner);
    if (!snapshot) throw new TransferAPIError('invalid_request', null);
    return decide(snapshot.original, snapshot.action);
  }
  async function recoverDecision(): Promise<TransferRecord> {
    const { owner, recovery } = admittedDecision();
    const token = recovery.claim(owner, true);
    if (!token) throw new TransferAPIError('invalid_request', null);
    return runDecision(token, true);
  }
  const dispatchRecovery = controller.dispatchRecovery;
  const [, updateDispatch] = useState(0);
  const dispatchTransport = useRef<AbortController | null>(null);
  useEffect(() => dispatchRecovery?.subscribe(() => updateDispatch(value => value + 1)), [dispatchRecovery]);
  useEffect(() => () => { dispatchTransport.current?.abort(); }, []);
  function admittedDispatch() {
    const owner = currentDecisionOwner();
    if (!owner) throw new TransferAPIError('unauthenticated', null);
    if (!dispatchRecovery) throw new TransferAPIError('invalid_request', null);
    return { owner, recovery: dispatchRecovery };
  }
  async function runDispatch(token: DispatchFlight, reading: boolean): Promise<TransferRecord> {
    const transport = new AbortController(); dispatchTransport.current = transport;
    const { original, owner } = token.attempt;
    const valid = () => !!currentDecisionOwner() && dispatchRecovery!.isCurrent(token, currentDecisionOwner());
    try {
      const before = controller.getTransferAuthority();
      if (!valid() || !before.session?.authenticated) throw new TransferAPIError('aborted', null, false, false, true);
      const returned = reading ? await api.detail(original.id, { signal: transport.signal })
        : await api.dispatch(original, before.session.csrf_token, transport.signal);
      if (!valid()) throw new TransferAPIError('aborted', null, false, false, true);
      let record: TransferRecord;
      try {
        record = captureDecisionRecord(returned);
        participant(record, owner.location);
        if (!matchesDecisionRecord(original, record) || record.origin_location_id !== owner.location
          || (reading ? record.status !== 'approved' && record.status !== 'in_transit' && record.status !== 'received' && record.status !== 'cancelled' : record.status !== 'in_transit' && record.status !== 'received')) throw new Error();
      } catch { throw new TransferAPIError('invalid_response', 200, false, false, !reading); }
      const confirmed = dispatchRecovery!.finish(token, record);
      if (confirmed) {
        if (record.status === 'cancelled') controller.confirmTransferCancellation?.(owner, record);
        else controller.confirmTransferDispatch?.(owner);
      }
      return record;
    } catch (error) {
      const current = valid();
      const safe = current ? error instanceof TransferAPIError ? error : new TransferAPIError('invalid_response', null, false, false, !reading)
        : new TransferAPIError('aborted', null, false, false, true);
      // Obsolete transports can release only their own opaque flight, not a replacement.
      dispatchRecovery!.finish(token, undefined, current && (safe.status === 403 || safe.status === 404), safe);
      if (current && safe.status === 401 && currentDecisionOwner()) await controller.settleUnauthorized(owner.epoch);
      throw safe;
    } finally {
      if (dispatchTransport.current === transport) dispatchTransport.current = null;
    }
  }
  async function dispatch(original: TransferRecord): Promise<TransferRecord> {
    const { owner, recovery } = admittedDispatch();
    if (original.origin_location_id !== owner.location) throw new TransferAPIError('forbidden', null);
    let token: DispatchFlight | null;
    try { token = recovery.start(original, owner); } catch { throw new TransferAPIError('invalid_request', null); }
    if (!token) throw new TransferAPIError('invalid_request', null);
    return runDispatch(token, false);
  }
  async function retryDispatch(): Promise<TransferRecord> {
    const { owner, recovery } = admittedDispatch();
    const snapshot = recovery.get(owner);
    if (!snapshot) throw new TransferAPIError('invalid_request', null);
    return dispatch(snapshot.original);
  }
  async function recoverDispatch(): Promise<TransferRecord> {
    const { owner, recovery } = admittedDispatch();
    const token = recovery.claim(owner, true);
    if (!token) throw new TransferAPIError('invalid_request', null);
    return runDispatch(token, true);
  }
  const cancellationRecovery = controller.cancellationRecovery;
  const [, updateCancellation] = useState(0);
  const cancellationTransport = useRef<AbortController | null>(null);
  useEffect(() => cancellationRecovery?.subscribe(() => updateCancellation(value => value + 1)), [cancellationRecovery]);
  useEffect(() => () => { cancellationTransport.current?.abort(); }, []);
  function admittedCancellation() {
    const owner = currentDecisionOwner();
    if (!owner) throw new TransferAPIError('unauthenticated', null);
    if (!cancellationRecovery) throw new TransferAPIError('invalid_request', null);
    return { owner, recovery: cancellationRecovery };
  }
  async function runCancellation(token: CancellationFlight, reading: boolean): Promise<TransferRecord> {
    const transport = new AbortController(); cancellationTransport.current = transport;
    const { original, current: pinned, owner } = token.attempt;
    const valid = () => !!currentDecisionOwner() && cancellationRecovery!.isCurrent(token, currentDecisionOwner());
    try {
      const before = controller.getTransferAuthority();
      if (!valid() || !before.session?.authenticated) throw new TransferAPIError('aborted', null, false, false, false, false, true);
      const returned = reading ? await api.detail(original.id, { signal: transport.signal })
        : await api.cancel(pinned, before.session.csrf_token, transport.signal);
      if (!valid()) throw new TransferAPIError('aborted', null, false, false, false, false, true);
      let record: TransferRecord;
      try {
        record = captureDecisionRecord(returned); participant(record, owner.location);
        if (!matchesDecisionRecord(pinned, record) || record.creator_location_id !== owner.location
          || (!reading && record.status !== 'cancelled')) throw new Error();
      } catch { throw new TransferAPIError('invalid_response', 200, false, false, false, false, !reading); }
      const terminal = cancellationRecovery!.finish(token, record);
      if (terminal) {
        if (record.status === 'cancelled') controller.confirmTransferCancellation?.(owner, record);
        else controller.confirmTransferDecision?.(owner, record.status);
      }
      return record;
    } catch (error) {
      const current = valid();
      const safe = current ? error instanceof TransferAPIError ? error : new TransferAPIError('invalid_response', null, false, false, false, false, !reading)
        : new TransferAPIError('aborted', null, false, false, false, false, true);
      cancellationRecovery!.finish(token, undefined, current && (safe.status === 403 || safe.status === 404), safe);
      if (current && safe.status === 401 && currentDecisionOwner()) await controller.settleUnauthorized(owner.epoch);
      throw safe;
    } finally { if (cancellationTransport.current === transport) cancellationTransport.current = null; }
  }
  async function cancel(original: TransferRecord): Promise<TransferRecord> {
    const { owner, recovery } = admittedCancellation();
    if (original.creator_location_id !== owner.location) throw new TransferAPIError('forbidden', null);
    let token: CancellationFlight | null;
    try { token = recovery.start(original, owner); } catch { throw new TransferAPIError('invalid_request', null); }
    if (!token) throw new TransferAPIError('invalid_request', null);
    return runCancellation(token, false);
  }
  async function retryCancellation(): Promise<TransferRecord> {
    const { owner, recovery } = admittedCancellation();
    const snapshot = recovery.get(owner);
    if (!snapshot) throw new TransferAPIError('invalid_request', null);
    return cancel(snapshot.current);
  }
  async function recoverCancellation(): Promise<TransferRecord> {
    const { owner, recovery } = admittedCancellation();
    const token = recovery.claim(owner);
    if (!token) throw new TransferAPIError('invalid_request', null);
    return runCancellation(token, true);
  }
  const receiptRecovery = controller.receiptRecovery;
  const [, updateReceipt] = useState(0);
  const receiptTransport = useRef<AbortController | null>(null);
  useEffect(() => receiptRecovery?.subscribe(() => updateReceipt(value => value + 1)), [receiptRecovery]);
  useEffect(() => () => { receiptTransport.current?.abort(); }, []);
  function admittedReceipt() {
    const owner = currentDecisionOwner();
    if (!owner) throw new TransferAPIError('unauthenticated', null);
    if (!receiptRecovery) throw new TransferAPIError('invalid_request', null);
    return { owner, recovery: receiptRecovery };
  }
  async function runReceipt(token: ReceiptFlight, reading: boolean): Promise<TransferRecord> {
    const transport = new AbortController(); receiptTransport.current = transport;
    const { original, input, owner } = token.attempt;
    const valid = () => !!currentDecisionOwner() && receiptRecovery!.isCurrent(token, currentDecisionOwner());
    try {
      const before = controller.getTransferAuthority();
      if (!valid() || !before.session?.authenticated) throw new TransferAPIError('aborted', null, false, false, false, true);
      const returned = reading ? await api.detail(original.id, { signal: transport.signal })
        : await api.receive(original, input, before.session.csrf_token, transport.signal);
      if (!valid()) throw new TransferAPIError('aborted', null, false, false, false, true);
      let record: TransferRecord;
      try {
        record = captureDecisionRecord(returned); participant(record, owner.location);
        if (!matchesDecisionRecord(original, record) || record.destination_location_id !== owner.location
          || (reading ? record.status !== 'in_transit' && record.status !== 'received' : !matchesReceiptInput(input, record))) throw new Error();
      } catch { throw new TransferAPIError('invalid_response', 200, false, false, false, !reading); }
      const confirmed = receiptRecovery!.finish(token, record);
      if (confirmed) controller.confirmTransferReceipt?.(owner, record);
      return record;
    } catch (error) {
      const current = valid();
      const safe = current ? error instanceof TransferAPIError ? error : new TransferAPIError('invalid_response', null, false, false, false, !reading)
        : new TransferAPIError('aborted', null, false, false, false, true);
      receiptRecovery!.finish(token, undefined, current && (safe.status === 403 || safe.status === 404), safe);
      if (current && safe.status === 401 && currentDecisionOwner()) await controller.settleUnauthorized(owner.epoch);
      throw safe;
    } finally { if (receiptTransport.current === transport) receiptTransport.current = null; }
  }
  async function receive(original: TransferRecord, input: TransferReceiptInput): Promise<TransferRecord> {
    const { owner, recovery } = admittedReceipt();
    if (original.destination_location_id !== owner.location) throw new TransferAPIError('forbidden', null);
    let token: ReceiptFlight | null;
    try { token = recovery.start(original, input, owner); } catch { throw new TransferAPIError('invalid_request', null); }
    if (!token) throw new TransferAPIError('invalid_request', null);
    return runReceipt(token, false);
  }
  async function retryReceipt(): Promise<TransferRecord> {
    const { owner, recovery } = admittedReceipt(); const snapshot = recovery.get(owner);
    if (!snapshot) throw new TransferAPIError('invalid_request', null);
    return receive(snapshot.original, snapshot.input);
  }
  async function recoverReceipt(): Promise<TransferRecord> {
    const { owner, recovery } = admittedReceipt(); const token = recovery.claim(owner, true);
    if (!token) throw new TransferAPIError('invalid_request', null);
    return runReceipt(token, true);
  }
  const visibleAuthority = () => {
    const now = controller.getTransferAuthority(); return now.ready && now.epoch === epoch && sessionIdentity(now.session) === identity;
  };
  return { query, get counts() { return counts.data; }, get countsBusy() { return counts.busy; }, get countsError() { return counts.error; },
    get selectedID() { return visibleAuthority() ? selectedID : null; },
    get page() { return list.data; }, get listBusy() { return list.busy; }, get listError() { return list.error; },
    get detail() { return detail.data; }, get detailBusy() { return detail.busy; }, get detailError() { return detail.error; },
    get submitBusy() { return visibleAuthority() && submission.epoch === epoch && submission.busy; },
    get submitError() { return visibleAuthority() && submission.epoch === epoch ? submission.error : null; },
    get decision() {
      const attempt = recovery?.get(currentDecisionOwner()) ?? null;
      const latest = detail.data?.status === 'cancelled' ? detail.data : cancellationRecovery?.get(currentDecisionOwner())?.result
        ?? receiptRecovery?.get(currentDecisionOwner())?.result ?? (detail.data?.status === 'received' ? detail.data : dispatchRecovery?.get(currentDecisionOwner())?.result ?? detail.data);
      // A current later lifecycle record must not be hidden by cached approval.
      return attempt?.result?.status === 'approved' && (latest?.status === 'in_transit' || latest?.status === 'received' || latest?.status === 'cancelled')
        && matchesDecisionRecord(attempt.result, latest) ? { ...attempt, phase: latest.status === 'cancelled' ? 'conflict' as const : attempt.phase, result: latest } : attempt;
    },
    get decisionError() {
      const failure = recovery?.get(currentDecisionOwner())?.failure;
      return failure ? new TransferAPIError(failure.code, failure.status, false, failure.uncertainDecision) : null;
    },
    get dispatchAttempt() {
      const attempt = dispatchRecovery?.get(currentDecisionOwner()) ?? null;
      const latest = detail.data?.status === 'cancelled' ? detail.data : cancellationRecovery?.get(currentDecisionOwner())?.result ?? receiptRecovery?.get(currentDecisionOwner())?.result ?? detail.data;
      return attempt?.result && (latest?.status === 'received' || latest?.status === 'cancelled') && matchesDecisionRecord(attempt.result, latest)
        ? { ...attempt, phase: latest.status === 'cancelled' ? 'conflict' as const : attempt.phase, result: latest } : attempt;
    },
    get receiptAttempt() { return receiptRecovery?.get(currentDecisionOwner()) ?? null; },
    get receiptError() {
      const failure = receiptRecovery?.get(currentDecisionOwner())?.failure;
      return failure ? new TransferAPIError(failure.code, failure.status, false, false, false, failure.uncertainReceipt) : null;
    },
    get cancellationAttempt() { return cancellationRecovery?.get(currentDecisionOwner()) ?? null; },
    get cancellationError() {
      const failure = cancellationRecovery?.get(currentDecisionOwner())?.failure;
      return failure ? new TransferAPIError(failure.code, failure.status, false, false, false, false, failure.uncertainCancellation) : null;
    },
    cancel, retryCancellation, recoverCancellation,
    receive, retryReceipt, recoverReceipt,
    get dispatchError() {
      const failure = dispatchRecovery?.get(currentDecisionOwner())?.failure;
      return failure ? new TransferAPIError(failure.code, failure.status, false, false, failure.uncertainDispatch) : null;
    },
    dispatch, retryDispatch, recoverDispatch,
    decide, retryDecision, recoverDecision,
    changeQuery, selectDetail, retryList: () => list.refresh(false), retryDetail: () => detail.refresh(false), submit };
}
