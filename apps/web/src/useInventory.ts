import { useEffect, useRef, useState } from 'react';
import { initialQuery, parseInventory, parseMetadata, parseSession, queryURL, validSearch } from './model';
import type { Inventory, Metadata, Query, Session } from './model';

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
async function request(path: string, init: RequestInit = {}, expected = 200): Promise<Response> {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init });
  if (response.status !== expected) {
    if (response.status >= 200 && response.status < 300) throw new Error('Respuesta inválida del servidor.');
    throw new HTTPError(response.status);
  }
  return response;
}

export function useInventory() {
  const [session, setSession] = useState<Session | null>(null);
  const [metadata, setMetadata] = useState<Metadata | null>(null);
  const [data, setData] = useState<Inventory | null>(null);
  const [query, setQuery] = useState<Query>(initialQuery(1));
  const [loading, setLoading] = useState(false);
  const [authBusy, setAuthBusy] = useState(true);
  const [formError, setFormError] = useState('');
  const [resultsError, setResultsError] = useState('');
  const [focusLogin, setFocusLogin] = useState(0);
  const authGeneration = useRef(0);
  const readGeneration = useRef(0);
  const active = useRef(new Set<AbortController>());
  const csrf = useRef('');
  const mounted = useRef(true);

  function cancelReads() {
    readGeneration.current++;
    for (const controller of active.current) controller.abort();
    active.current.clear();
  }
  function clearProtected() {
    cancelReads(); setMetadata(null); setData(null); setResultsError(''); setLoading(false);
    csrf.current = ''; setSession(null);
  }
  function current(auth: number, read?: number) {
    return mounted.current && authGeneration.current === auth && (read === undefined || readGeneration.current === read);
  }
  async function restore(anonymousOnly = false, message = '') {
    const auth = ++authGeneration.current;
    clearProtected(); setAuthBusy(true); setFormError(message);
    if (anonymousOnly) setFocusLogin(n => n + 1);
    const controller = new AbortController(); active.current.add(controller);
    try {
      const next = parseSession(await (await request('/api/auth/session', { signal: controller.signal })).text());
      if (!current(auth)) return;
      if (anonymousOnly && next.authenticated) throw new Error('Respuesta inválida del servidor.');
      csrf.current = next.csrf_token;
      setSession(next);
      if (next.authenticated) setQuery(initialQuery(next.identity.location.id));
    } catch (error) {
      if (current(auth)) setFormError(errorMessage(error));
    } finally {
      active.current.delete(controller);
      if (current(auth)) setAuthBusy(false);
    }
  }
  function expire() {
    // No protected content survives an expiry, even if the refresh fails.
    void restore(true, 'La sesión venció. Iniciá sesión nuevamente.');
  }
  useEffect(() => {
    mounted.current = true;
    void restore();
    return () => { mounted.current = false; authGeneration.current++; cancelReads(); csrf.current = ''; };
    // Session restoration is a mount operation, never a login POST.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!session?.authenticated || authBusy) return;
    const auth = authGeneration.current;
    const read = ++readGeneration.current;
    const controller = new AbortController(); active.current.add(controller);
    setData(null); setLoading(true); setResultsError('');
    if (!validSearch(query.search)) {
      setResultsError('La búsqueda admite hasta 128 bytes UTF-8, sin caracteres inválidos.');
      setLoading(false); active.current.delete(controller); return;
    }
    void (async () => {
      try {
        const meta = metadata ?? parseMetadata(await (await request('/api/inventory/metadata', { signal: controller.signal })).text());
        if (!current(auth, read)) return;
        if (!metadata) setMetadata(meta);
        const next = parseInventory(await (await request(queryURL(query), { signal: controller.signal })).text());
        if (!current(auth, read)) return;
        if (next.location.id !== query.location || next.page !== query.page || next.page_size !== query.size) throw new Error('Respuesta inválida del servidor.');
        setData(next);
      } catch (error) {
        if (!current(auth, read)) return;
        if (error instanceof HTTPError && error.status === 401) expire();
        else setResultsError(errorMessage(error));
      } finally {
        active.current.delete(controller);
        if (current(auth, read)) setLoading(false);
      }
    })();
    return () => { controller.abort(); active.current.delete(controller); if (readGeneration.current === read) readGeneration.current++; };
    // metadata is fetched as part of the same generation, not another request trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, query]);

  function change(patch: Partial<Query>, paging = false) {
    cancelReads(); setData(null); setResultsError('');
    setQuery(previous => ({ ...previous, ...patch, page: paging ? patch.page ?? previous.page : 1 }));
  }
  async function login(username: string, password: string) {
    if (authBusy || !csrf.current) return;
    const token = csrf.current;
    const auth = ++authGeneration.current;
    cancelReads(); setAuthBusy(true); setFormError('');
    try {
      const next = parseSession(await (await request('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
        body: JSON.stringify({ username, password }),
      })).text());
      if (!current(auth)) return;
      if (!next.authenticated) throw new Error('Respuesta inválida del servidor.');
      csrf.current = next.csrf_token; setMetadata(null); setData(null);
      setQuery(initialQuery(next.identity.location.id)); setSession(next);
    } catch (error) {
      if (!current(auth)) return;
      if (error instanceof HTTPError && error.status === 401) {
        await restore(true, errorMessage(error));
      } else setFormError(errorMessage(error));
    } finally { if (current(auth)) setAuthBusy(false); }
  }
  async function logout() {
    if (authBusy || !session?.authenticated) return;
    const auth = ++authGeneration.current;
    cancelReads(); setLoading(false); setAuthBusy(true); setResultsError('');
    try {
      await request('/api/auth/logout', { method: 'POST', headers: { 'X-CSRF-Token': csrf.current } }, 204);
      if (current(auth)) await restore(true);
    } catch (error) {
      if (!current(auth)) return;
      if (error instanceof HTTPError && error.status === 401) expire();
      else setResultsError(errorMessage(error));
    } finally { if (current(auth)) setAuthBusy(false); }
  }
  return { session, metadata, data, query, loading, authBusy, formError, resultsError, focusLogin,
    login, logout, change, retrySession: () => restore(), retryInventory: () => change({}, true) };
}
