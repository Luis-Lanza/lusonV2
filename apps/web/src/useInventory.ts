import { useCallback, useEffect, useRef, useState } from 'react';
import { initialQuery, parseInventory, parseMetadata, parseSession, queryURL, validSearch } from './model';
import type { Inventory, Metadata, Query, Session } from './model';
import { useRealtime } from './useRealtime';
import type { Recovery } from './useRealtime';
import { createTransferDecisionRecovery, decisionOwner, type DecisionOwner, type TransferDecisionRecovery } from './transferDecisionRecovery';
import type { TransferStatus } from './transferModel';

class HTTPError extends Error {
  constructor(public status: number) { super('HTTP request failed'); }
}
export function errorMessage(error: unknown): string {
  if (error instanceof HTTPError) {
    switch (error.status) {
      case 400: return 'Solicitud inválida. Revisá los datos e intentá de nuevo.';
      case 401: return 'Usuario o contraseña incorrectos.';
      case 403: return 'Solicitud no autorizada. Actualizá la sesión e intentá de nuevo.';
      case 429: return 'Demasiados intentos. Esperá un minuto antes de volver a intentar.';
      case 503: return 'Servicio no disponible. Intentá de nuevo más tarde.';
    }
  }
  return error instanceof Error && error.message.startsWith('Respuesta inválida')
    ? error.message : 'No se pudo conectar con el servidor. Intentá de nuevo.';
}
async function request(path: string, init: RequestInit = {}, expected = 200, passive = false): Promise<Response> {
  // Selectors are additive: never erase Content-Type or memory CSRF headers.
  const headers = passive ? new Headers(init.headers) : init.headers;
  if (passive) (headers as Headers).set('X-Luson-Passive', '1');
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init, ...(headers ? { headers } : {}) });
  if (response.status !== expected) {
    if (response.status >= 200 && response.status < 300) throw new Error('Respuesta inválida del servidor.');
    throw new HTTPError(response.status);
  }
  return response;
}
type Job = { sequence: number; reason: 'initial' | 'manual' | 'event'; full: boolean };
type Read = { auth: number; generation: number; dirty: boolean; full: boolean };
type Bootstrap = { settled: Promise<void>; controller: AbortController; uncertain: boolean; cancelTimeout: () => void };
export interface TransferAuthority { epoch: number; ready: boolean; session: Session | null; sessionGeneration?: number }
export interface TransferController {
  authorityEpoch: number;
  getTransferAuthority: () => TransferAuthority;
  subscribeTransferInvalidation: (listener: () => void) => () => void;
  settleUnauthorized: (expectedEpoch: number) => Promise<Recovery>;
  decisionRecovery?: TransferDecisionRecovery;
  confirmTransferDecision?: (owner: DecisionOwner, status: TransferStatus) => void;
}

export interface SourceInventoryController {
  authorityEpoch: number;
  getTransferAuthority: () => TransferAuthority;
  subscribeSourceInventoryInvalidation: (listener: () => void) => () => void;
}

export function useInventory() {
  const [decisionRecovery] = useState(createTransferDecisionRecovery);
  const [session, setSession] = useState<Session | null>(null);
  const [metadata, setMetadata] = useState<Metadata | null>(null);
  const [data, setData] = useState<Inventory | null>(null);
  const [query, setQuery] = useState<Query>(initialQuery(1));
  const [job, setJob] = useState<Job>({ sequence: 0, reason: 'initial', full: true });
  const [loading, setLoading] = useState(false);
  const [authBusy, setAuthBusy] = useState(true);
  const [formError, setFormError] = useState('');
  const [resultsError, setResultsError] = useState('');
  const [realtimeError, setRealtimeError] = useState('');
  const [focusLogin, setFocusLogin] = useState(0);
  const authGeneration = useRef(0);
  const readGeneration = useRef(0);
  const active = useRef(new Set<AbortController>());
  const inFlight = useRef<Read | null>(null);
  const csrf = useRef('');
  const mounted = useRef(true);
  const bootstrap = useRef<Bootstrap | null>(null);
  const mutation = useRef(false);
  const authorityState = useRef({ session, authBusy });
  authorityState.current = { session, authBusy };
  const transferListeners = useRef(new Set<{ epoch: number; listener: () => void }>());
  const sourceInventoryListeners = useRef(new Set<{ epoch: number; listener: () => void }>());
  const neutralProbe = useRef<{ epoch: number; promise: Promise<Recovery>; cancel: () => void } | null>(null);
  const unauthorizedCooldown = useRef({ epoch: -1, until: 0 });
  const validateLatest = useRef<(signal: AbortSignal) => Promise<Recovery>>(async () => 'unavailable');
  // Auth-only fingerprint detects even in-place changes before React renders.
  // Recovery receives only the monotonic generation, never this credential tag.
  const sessionFence = useRef({ fingerprint: '', generation: 0 });
  const getTransferAuthority = useCallback((): TransferAuthority => {
    const session = authorityState.current.session;
    const fingerprint = session?.authenticated ? JSON.stringify([session.identity.account_id, session.identity.username,
      session.identity.location.id, session.identity.location.name, session.expires_at, session.csrf_token]) : '';
    if (sessionFence.current.fingerprint !== fingerprint) {
      sessionFence.current = { fingerprint, generation: sessionFence.current.generation + 1 };
    }
    return { epoch: authGeneration.current, session, sessionGeneration: sessionFence.current.generation,
      ready: mounted.current && !mutation.current && !authorityState.current.authBusy && !!session?.authenticated };
  }, []);
  const subscribeTransferInvalidation = useCallback((listener: () => void) => {
    const entry = { epoch: authGeneration.current, listener };
    transferListeners.current.add(entry);
    return () => { transferListeners.current.delete(entry); };
  }, []);
  const subscribeSourceInventoryInvalidation = useCallback((listener: () => void) => {
    const entry = { epoch: authGeneration.current, listener };
    sourceInventoryListeners.current.add(entry);
    return () => { sourceInventoryListeners.current.delete(entry); };
  }, []);
  const settleUnauthorized = useCallback(async (expectedEpoch: number): Promise<Recovery> => {
    const authority = getTransferAuthority();
    if (!authority.ready || authority.epoch !== expectedEpoch) return 'anonymous';
    if (neutralProbe.current?.epoch === expectedEpoch) {
      unauthorizedCooldown.current = { epoch: expectedEpoch, until: Date.now() + 5000 };
      return neutralProbe.current.promise;
    }
    const cooldown = unauthorizedCooldown.current;
    if (cooldown.epoch === expectedEpoch && Date.now() < cooldown.until) return 'unavailable';
    unauthorizedCooldown.current = { epoch: expectedEpoch, until: Date.now() + 5000 };
    return validateLatest.current(new AbortController().signal);
  }, [getTransferAuthority]);
  function decisionIsCurrent(owner: DecisionOwner) {
    const now = decisionOwner(getTransferAuthority());
    return !!now && now.account === owner.account && now.location === owner.location
      && now.epoch === owner.epoch && now.generation === owner.generation;
  }
  function notifyTransfers(epoch: number, owner?: DecisionOwner) {
    const authority = getTransferAuthority();
    if (!authority.ready || authority.epoch !== epoch) return;
    for (const entry of [...transferListeners.current]) {
      if (owner && !decisionIsCurrent(owner)) return;
      if (entry.epoch !== epoch || !transferListeners.current.has(entry) || !current(epoch) || mutation.current) continue;
      // A failed subscriber must not interrupt other readers or inventory resync.
      try { entry.listener(); } catch { /* No subscriber payload or error is logged. */ }
    }
  }

  function notifySourceInventory(epoch: number, owner?: DecisionOwner) {
    for (const entry of [...sourceInventoryListeners.current]) {
      const authority = getTransferAuthority();
      if (!authority.ready || authority.epoch !== epoch || (owner && !decisionIsCurrent(owner))) return;
      if (entry.epoch !== epoch || !sourceInventoryListeners.current.has(entry) || !current(epoch) || mutation.current) continue;
      // Signals have no data; subscriber failures must not disrupt other readers.
      try { entry.listener(); } catch { /* No subscriber payload or error is logged. */ }
    }
  }

  function cancelReads() {
    readGeneration.current++; inFlight.current = null;
    for (const controller of active.current) controller.abort();
    active.current.clear();
  }
  function clearProtected() {
    neutralProbe.current?.cancel(); neutralProbe.current = null;
    cancelReads(); setMetadata(null); setData(null); setResultsError(''); setRealtimeError(''); setLoading(false);
    csrf.current = ''; authorityState.current.session = null; setSession(null);
  }
  function current(auth: number, read?: number) {
    return mounted.current && authGeneration.current === auth && (read === undefined || readGeneration.current === read);
  }
  function initial(next: Session) {
    csrf.current = next.csrf_token; authorityState.current.session = next; setSession(next);
    if (next.authenticated) {
      setQuery(initialQuery(next.identity.location.id));
      setJob(previous => ({ sequence: previous.sequence + 1, reason: 'initial', full: true }));
    }
  }
  async function restore(anonymousOnly = false, message = '', reconcile = false) {
    // Session GET can write cookies. Do not overlap it with another bootstrap,
    // or mistake abort/generation guards for rollback of browser cookie headers.
    const previous = bootstrap.current;
    if (previous) {
      await previous.settled;
      // Concurrent restoration attempts share the existing result, not a queue
      // of subsequent cookie writers. An uncertain result cannot be retried here.
      return;
    }
    if (!mounted.current) return;
    stopRealtime();
    const auth = ++authGeneration.current;
    clearProtected(); setAuthBusy(true); setFormError(message);
    if (anonymousOnly) setFocusLogin(n => n + 1);
    const controller = new AbortController();
    let settle!: () => void;
    const gate: Bootstrap = { settled: new Promise(resolve => { settle = resolve; }), controller, uncertain: false, cancelTimeout: () => {} };
    bootstrap.current = gate;
    let timedOut!: () => void;
    const timeout = new Promise<never>((_, reject) => {
      timedOut = () => { gate.uncertain = true; controller.abort(); reject(new Error('Bootstrap timeout')); };
    });
    const timer = setTimeout(timedOut, 10000);
    gate.cancelTimeout = () => clearTimeout(timer);
    try {
      const next = await Promise.race([
        request('/api/auth/session', { signal: controller.signal }, 200, true).then(async response => parseSession(await response.text())), timeout,
      ]);
      if (!current(auth)) return;
      if (anonymousOnly && next.authenticated && !reconcile) throw new Error('Respuesta inválida del servidor.');
      initial(next);
    } catch (error) {
      if (controller.signal.aborted) gate.uncertain = true;
      if (current(auth)) setFormError(errorMessage(error));
    } finally {
      clearTimeout(timer); settle();
      // Uncertain cookie-writing aborts remain a fail-closed mutation barrier.
      if (!gate.uncertain && bootstrap.current === gate) bootstrap.current = null;
      if (current(auth)) setAuthBusy(false);
    }
  }
  function expire() {
    stopRealtime();
    void restore(true, 'La sesión venció. Iniciá sesión nuevamente.');
  }
  function invalidate(full: boolean) {
    if (!session?.authenticated || authBusy || mutation.current) return;
    const pending = inFlight.current;
    if (pending && current(pending.auth, pending.generation)) {
      pending.dirty = true; pending.full ||= full;
    } else setJob(previous => ({ sequence: previous.sequence + 1, reason: 'event', full: previous.reason === 'event' ? previous.full || full : full }));
  }
  async function validateCurrent(signal: AbortSignal): Promise<Recovery> {
    const auth = authGeneration.current;
    if (!session?.authenticated || mutation.current) return 'anonymous';
    setRealtimeError('Se interrumpió la conexión. Podés volver a consultar.');
    try {
      const raw = await (await request('/api/auth/validate', { signal }, 200, true)).text();
      if (!current(auth) || signal.aborted || mutation.current) return 'anonymous';
      // Anonymous validate deliberately has no CSRF: only the distinct bootstrap
      // endpoint may establish the anonymous mutation token.
      let anonymous: boolean;
      try {
        const value: unknown = JSON.parse(raw);
        anonymous = value !== null && typeof value === 'object' && !Array.isArray(value)
          && Object.keys(value).length === 1 && (value as { authenticated?: unknown }).authenticated === false;
      } catch { throw new Error('Respuesta inválida del servidor.'); }
      if (anonymous) { stopRealtime(); void restore(true, '', true); return 'anonymous'; }
      const next = parseSession(raw);
      if (!next.authenticated) throw new Error('Respuesta inválida del servidor.');
      const before = session.identity; const after = next.identity;
      const same = before.account_id === after.account_id && before.username === after.username
        && before.location.id === after.location.id && before.location.name === after.location.name
        && session.csrf_token === next.csrf_token;
      if (!same) {
        stopRealtime(); authGeneration.current++; clearProtected(); initial(next);
      }
      // A healthy probe leaves the Session object, query, snapshot and CSRF alone.
      return 'authorized';
    } catch (error) {
      if (current(auth) && !signal.aborted) setRealtimeError(errorMessage(error));
      return 'unavailable';
    }
  }
  async function validate(signal: AbortSignal): Promise<Recovery> {
    const epoch = authGeneration.current;
    if (signal.aborted || !getTransferAuthority().ready) return 'anonymous';
    if (neutralProbe.current?.epoch === epoch) return neutralProbe.current.promise;
    neutralProbe.current?.cancel();
    const controller = new AbortController();
    let finish!: (value: Recovery) => void;
    const bounded = new Promise<Recovery>(resolve => { finish = resolve; });
    const timer = setTimeout(() => { controller.abort(); finish('unavailable'); }, 5000);
    const promise = Promise.race([validateCurrent(controller.signal), bounded]).finally(() => {
      clearTimeout(timer);
      if (neutralProbe.current?.promise === promise) neutralProbe.current = null;
    });
    neutralProbe.current = { epoch, promise, cancel: () => { clearTimeout(timer); controller.abort(); finish('anonymous'); } };
    return promise;
  }
  validateLatest.current = validate;
  const decisionEffects = useRef<(owner: DecisionOwner, status: TransferStatus) => void>(() => {});
  decisionEffects.current = (owner, status) => {
    if (!decisionIsCurrent(owner) || status === 'pending') return;
    notifyTransfers(owner.epoch, owner);
    if (status === 'approved' && decisionIsCurrent(owner)) {
      invalidate(false); notifySourceInventory(owner.epoch, owner);
    }
  };
  const confirmTransferDecision = useCallback((owner: DecisionOwner, status: TransferStatus) => decisionEffects.current(owner, status), []);
  const realtimeEpoch = authGeneration.current;
  const stopRealtime = useRealtime({ enabled: !!session?.authenticated && !authBusy, epoch: realtimeEpoch,
    resync: () => { invalidate(true); notifyTransfers(realtimeEpoch); notifySourceInventory(realtimeEpoch); },
    inventory: () => { invalidate(false); notifySourceInventory(realtimeEpoch); },
    transfers: () => notifyTransfers(realtimeEpoch), error: validate });

  useEffect(() => {
    mounted.current = true; void restore();
    return () => {
      mounted.current = false; stopRealtime(); authGeneration.current++; cancelReads(); csrf.current = '';
      transferListeners.current.clear(); sourceInventoryListeners.current.clear();
      neutralProbe.current?.cancel(); neutralProbe.current = null;
      const gate = bootstrap.current;
      if (gate) { gate.uncertain = true; gate.cancelTimeout(); gate.controller.abort(); }
    };
    // Session restoration is a mount operation, never a login POST.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!session?.authenticated || authBusy) return;
    const deadline = Date.parse(session.expires_at);
    let timer: ReturnType<typeof setTimeout>;
    function schedule() {
      const remaining = deadline - Date.now();
      timer = setTimeout(remaining > 2147483647 ? schedule : expire, Math.max(0, Math.min(remaining, 2147483647)));
    }
    schedule();
    return () => clearTimeout(timer);
    // Absolute expiry never renews through passive probes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, authBusy]);

  useEffect(() => {
    if (!session?.authenticated || authBusy) return;
    const auth = authGeneration.current;
    const read = ++readGeneration.current;
    const pending: Read = { auth, generation: read, dirty: false, full: false };
    inFlight.current = pending;
    const controller = new AbortController(); active.current.add(controller);
    const passive = job.reason !== 'manual';
    if (!passive) setData(null);
    setLoading(true); setResultsError('');
    if (!validSearch(query.search)) {
      setResultsError('La búsqueda admite hasta 128 bytes UTF-8, sin caracteres inválidos.');
      setLoading(false); active.current.delete(controller); inFlight.current = null; return;
    }
    void (async () => {
      try {
        const meta = !metadata || job.full
          ? parseMetadata(await (await request('/api/inventory/metadata', { signal: controller.signal }, 200, passive)).text()) : metadata;
        if (!current(auth, read)) return;
        setMetadata(meta);
        const next = parseInventory(await (await request(queryURL(query), { signal: controller.signal }, 200, passive)).text());
        if (!current(auth, read)) return;
        if (next.location.id !== query.location || next.page !== query.page || next.page_size !== query.size) throw new Error('Respuesta inválida del servidor.');
        if (!pending.dirty) {
          setData(next);
          if (job.reason === 'event') setRealtimeError('');
        }
      } catch (error) {
        if (!current(auth, read)) return;
        if (error instanceof HTTPError && error.status === 401) expire();
        else setResultsError(errorMessage(error));
      } finally {
        active.current.delete(controller);
        if (current(auth, read)) {
          inFlight.current = null; setLoading(false);
          if (pending.dirty) setJob(previous => ({ sequence: previous.sequence + 1, reason: 'event', full: pending.full }));
        }
      }
    })();
    return () => { controller.abort(); active.current.delete(controller); if (inFlight.current === pending) inFlight.current = null; if (readGeneration.current === read) readGeneration.current++; };
    // Each job captures its query, reason and epoch; callbacks never alter headers
    // of an in-flight request. Metadata is not a separate effect dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, query, job, authBusy]);

  function change(patch: Partial<Query>, paging = false) {
    cancelReads(); setData(null); setResultsError('');
    setJob(previous => ({ sequence: previous.sequence + 1, reason: 'manual', full: false }));
    setQuery(previous => ({ ...previous, ...patch, page: paging ? patch.page ?? previous.page : 1 }));
  }
  async function mutationBarrier(): Promise<boolean> {
    const gate = bootstrap.current;
    if (gate) { await gate.settled; if (gate.uncertain) return false; }
    return mounted.current && !!csrf.current;
  }
  async function login(username: string, password: string) {
    if (authBusy || mutation.current || !csrf.current) return;
    mutation.current = true; stopRealtime(); neutralProbe.current?.cancel(); neutralProbe.current = null;
    const auth = ++authGeneration.current;
    cancelReads(); setAuthBusy(true); setFormError('');
    try {
      if (!await mutationBarrier() || !current(auth)) return;
      const next = parseSession(await (await request('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf.current },
        body: JSON.stringify({ username, password }),
      })).text());
      if (!current(auth)) return;
      if (!next.authenticated) throw new Error('Respuesta inválida del servidor.');
      setMetadata(null); setData(null); initial(next);
    } catch (error) {
      if (!current(auth)) return;
      if (error instanceof HTTPError && error.status === 401) await restore(true, errorMessage(error));
      else setFormError(errorMessage(error));
    } finally { mutation.current = false; if (current(auth)) setAuthBusy(false); }
  }
  async function logout() {
    if (authBusy || mutation.current || !session?.authenticated) return;
    mutation.current = true; stopRealtime(); neutralProbe.current?.cancel(); neutralProbe.current = null;
    const auth = ++authGeneration.current;
    cancelReads(); setLoading(false); setAuthBusy(true); setResultsError('');
    setJob(previous => ({ sequence: previous.sequence + 1, reason: 'event', full: false }));
    try {
      if (!await mutationBarrier() || !current(auth)) return;
      await request('/api/auth/logout', { method: 'POST', headers: { 'X-CSRF-Token': csrf.current } }, 204);
      if (current(auth)) await restore(true);
    } catch (error) {
      if (!current(auth)) return;
      if (error instanceof HTTPError && error.status === 401) expire();
      else setResultsError(errorMessage(error));
    } finally { mutation.current = false; if (current(auth)) setAuthBusy(false); }
  }
  return { session, metadata, data, query, loading, authBusy, formError, resultsError: resultsError || realtimeError, focusLogin,
    login, logout, change, retrySession: () => restore(), retryInventory: () => change({}, true),
    decisionRecovery, confirmTransferDecision,
    authorityEpoch: authGeneration.current, getTransferAuthority, subscribeTransferInvalidation, subscribeSourceInventoryInvalidation, settleUnauthorized };
}
