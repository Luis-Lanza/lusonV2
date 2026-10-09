import { useCallback, useEffect, useRef, useState } from 'react';
import type { TransferController } from './useInventory';
import type { Session } from './model';
import { createTransferAPI, TransferAPIError, type TransferCreateResult } from './transferAPI';
import {
  canonicalTransferInput, transferDetailPath, transferListPath,
  type TransferCounts, type TransferCreateInput, type TransferPage, type TransferQuery, type TransferRecord,
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
  const visibleAuthority = () => {
    const now = controller.getTransferAuthority(); return now.ready && now.epoch === epoch && sessionIdentity(now.session) === identity;
  };
  return { query, get counts() { return counts.data; }, get countsBusy() { return counts.busy; }, get countsError() { return counts.error; },
    get selectedID() { return visibleAuthority() ? selectedID : null; },
    get page() { return list.data; }, get listBusy() { return list.busy; }, get listError() { return list.error; },
    get detail() { return detail.data; }, get detailBusy() { return detail.busy; }, get detailError() { return detail.error; },
    get submitBusy() { return visibleAuthority() && submission.epoch === epoch && submission.busy; },
    get submitError() { return visibleAuthority() && submission.epoch === epoch ? submission.error : null; },
    changeQuery, selectDetail, retryList: () => list.refresh(false), retryDetail: () => detail.refresh(false), submit };
}
