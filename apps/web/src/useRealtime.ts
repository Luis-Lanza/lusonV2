import { useEffect, useRef } from 'react';

export type Recovery = 'authorized' | 'unavailable' | 'anonymous';
export interface RealtimeOptions {
  enabled: boolean;
  epoch: number;
  resync: () => void;
  inventory: () => void;
  /** Future participant-only transfer readers; no inventory work is implied. */
  transfers?: () => void;
  error: (signal: AbortSignal) => Promise<Recovery>;
}

function emptyInvalidation(event: Event): boolean {
  const raw: unknown = (event as MessageEvent).data;
  if (typeof raw !== 'string' || raw.length > 512) return false;
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
  } catch { return false; }
}

/** Same-origin invalidations, never records or actor authority. Returns an immediate
 * stop for mutation attempts, in addition to effect cleanup on authority changes. */
export function useRealtime(options: RealtimeOptions): () => void {
  const latest = useRef(options);
  latest.current = options;
  const stop = useRef<() => void>(() => {});
  useEffect(() => {
    if (!options.enabled) return;
    const epoch = options.epoch;
    let alive = true;
    let source: EventSource | null = null;
    let detach: (() => void) | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let probe: AbortController | null = null;
    let cancelProbe: (() => void) | undefined;
    let attempts = 0;
    let nativeErrors = 0;
    let nextNativeProbe = 0;
    const valid = () => alive && latest.current.enabled && latest.current.epoch === epoch;
    function close() {
      detach?.(); detach = undefined;
      source?.close(); source = null;
    }
    function dispose() {
      alive = false; close();
      clearTimeout(retry); clearTimeout(timeout);
      probe?.abort(); cancelProbe?.(); cancelProbe = undefined; probe = null;
    }
    stop.current = dispose;
    async function validate(): Promise<Recovery> {
      const controller = new AbortController(); probe = controller;
      let timeoutResolve!: (value: Recovery) => void;
      const timedOut = new Promise<Recovery>(resolve => { timeoutResolve = resolve; });
      cancelProbe = () => timeoutResolve('anonymous');
      timeout = setTimeout(() => { controller.abort(); timeoutResolve('unavailable'); }, 5000);
      try {
        return await Promise.race([latest.current.error(controller.signal).catch(() => 'unavailable' as const), timedOut]);
      } finally {
        clearTimeout(timeout); timeout = undefined;
        if (probe === controller) { probe = null; cancelProbe = undefined; }
      }
    }
    function schedule() {
      if (!valid() || retry !== undefined) return;
      const delay = Math.min(1000 * 2 ** Math.min(attempts++, 5), 30000);
      retry = setTimeout(() => {
        retry = undefined;
        if (!valid()) return;
        void (async () => {
          const result = await validate();
          if (!valid() || result === 'anonymous') return;
          connect(true);
        })();
      }, delay);
    }
    async function failed(instance: EventSource | null, supported = true) {
      if (!valid() || instance !== source || probe || retry !== undefined) return;
      if (instance && instance.readyState !== 2) {
        // Coalescing alone does not bound settled error storms. Native retry owns
        // the transport; rate-limit its health checks without an extra timer.
        if (Date.now() < nextNativeProbe) return;
        nextNativeProbe = Date.now() + Math.min(1000 * 2 ** Math.min(nativeErrors++, 5), 30000);
      }
      const result = await validate();
      if (!valid() || instance !== source) return;
      if (result === 'anonymous') { dispose(); return; }
      // WHATWG terminal failures are CLOSED, not native retry. CONNECTING stays
      // with the browser; never replace a source on every error notification.
      if (supported && (!instance || instance.readyState === 2)) { close(); schedule(); }
    }
    function connect(validated = false) {
      if (!valid()) return;
      if (typeof EventSource !== 'function') { void failed(null, false); return; }
      try { source = new EventSource('/api/events'); }
      catch { source = null; if (validated) schedule(); else void failed(null); return; }
      const instance = source;
      const handlers: [string, EventListener][] = (['resync', 'inventory', 'transfers'] as const).map(kind => [kind, event => {
        if (!valid() || source !== instance || instance.readyState === 2 || !emptyInvalidation(event)) return;
        if (kind === 'resync') { attempts = 0; nativeErrors = 0; nextNativeProbe = 0; latest.current.resync(); }
        else if (kind === 'inventory') latest.current.inventory();
        else latest.current.transfers?.();
      }]);
      handlers.push(['error', () => { void failed(instance); }]);
      for (const [kind, handler] of handlers) instance.addEventListener(kind, handler);
      detach = () => { for (const [kind, handler] of handlers) instance.removeEventListener(kind, handler); };
    }
    connect();
    return dispose;
  }, [options.enabled, options.epoch]);
  return () => stop.current();
}
