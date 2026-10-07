import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRealtime } from './useRealtime';
import type { RealtimeOptions, Recovery } from './useRealtime';

class FakeSource {
  static instances: FakeSource[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  readyState = 0;
  listeners = new Map<string, Set<EventListener>>();
  close = vi.fn(() => { this.readyState = 2; });
  constructor(public url: string) { FakeSource.instances.push(this); }
  addEventListener(kind: string, callback: EventListener) {
    const callbacks = this.listeners.get(kind) ?? new Set();
    callbacks.add(callback); this.listeners.set(kind, callbacks);
  }
  removeEventListener(kind: string, callback: EventListener) { this.listeners.get(kind)?.delete(callback); }
  emit(kind: string, data = '{}') {
    for (const callback of this.listeners.get(kind) ?? []) callback(new MessageEvent(kind, { data }));
  }
}
function options(patch: Partial<RealtimeOptions> = {}): RealtimeOptions {
  return { enabled: true, epoch: 1, resync: vi.fn(), inventory: vi.fn(), transfers: vi.fn(),
    error: vi.fn(async () => 'authorized' as Recovery), ...patch };
}
async function flush() { await act(async () => { await Promise.resolve(); }); }
beforeEach(() => { FakeSource.instances = []; vi.stubGlobal('EventSource', FakeSource); vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('R03 realtime lifecycle', () => {
  it('subscribes only authorized authority; open is not readiness; callback changes retain the source', () => {
    const callbacks = options({ enabled: false });
    const { rerender, unmount } = renderHook((o: RealtimeOptions) => useRealtime(o), { initialProps: callbacks });
    expect(FakeSource.instances).toHaveLength(0);
    rerender({ ...callbacks, enabled: true });
    expect(FakeSource.instances).toHaveLength(1);
    const source = FakeSource.instances[0]; expect(source.url).toBe('/api/events');
    act(() => source.emit('open')); expect(callbacks.resync).not.toHaveBeenCalled();
    const latest = vi.fn(); rerender({ ...callbacks, enabled: true, inventory: latest });
    act(() => { source.emit('resync'); source.emit('inventory'); source.emit('transfers'); });
    expect(callbacks.resync).toHaveBeenCalledOnce(); expect(latest).toHaveBeenCalledOnce();
    expect(callbacks.inventory).not.toHaveBeenCalled(); expect(callbacks.transfers).toHaveBeenCalledOnce();
    expect(FakeSource.instances).toHaveLength(1); unmount(); expect(source.close).toHaveBeenCalledOnce();
  });
  it.each(['[]', 'null', 'true', '{"id":1}', '{', ' '.repeat(513) + '{}'])('rejects bounded nonempty or malformed payload %j', data => {
    const callbacks = options(); renderHook(() => useRealtime(callbacks));
    act(() => { FakeSource.instances[0].emit('inventory', data); FakeSource.instances[0].emit('unknown'); });
    expect(callbacks.inventory).not.toHaveBeenCalled(); expect(callbacks.resync).not.toHaveBeenCalled();
  });
  it('coalesces errors and retains native CONNECTING even after a healthy probe', async () => {
    let finish!: (value: Recovery) => void;
    const error = vi.fn(() => new Promise<Recovery>(resolve => { finish = resolve; }));
    renderHook(() => useRealtime(options({ error })));
    const source = FakeSource.instances[0];
    act(() => { source.emit('error'); source.emit('error'); });
    expect(error).toHaveBeenCalledOnce();
    await act(async () => finish('authorized'));
    await act(async () => vi.advanceTimersByTime(60000));
    expect(FakeSource.instances).toHaveLength(1); expect(source.close).not.toHaveBeenCalled();
  });
  it('rate-bounds settled CONNECTING error bursts without adding native-retry timers', async () => {
    const callbacks = options(); renderHook(() => useRealtime(callbacks));
    const source = FakeSource.instances[0];
    act(() => source.emit('error')); await flush();
    act(() => { for (let i = 0; i < 50; i++) source.emit('error'); }); await flush();
    expect(callbacks.error).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    await act(async () => vi.advanceTimersByTime(1000));
    act(() => source.emit('error')); await flush(); expect(callbacks.error).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTime(1000));
    act(() => source.emit('error')); await flush(); expect(callbacks.error).toHaveBeenCalledTimes(2);
    expect(FakeSource.instances).toHaveLength(1);
    // Terminal state bypasses native cooldown: otherwise CLOSED could be stranded.
    source.readyState = 2; act(() => source.emit('error')); await flush();
    expect(callbacks.error).toHaveBeenCalledTimes(3); expect(vi.getTimerCount()).toBe(1);
  });
  it('recovers CLOSED only after one bounded timer and a fresh authorization probe', async () => {
    const callbacks = options(); renderHook(() => useRealtime(callbacks));
    const source = FakeSource.instances[0]; source.readyState = 2;
    act(() => { source.emit('error'); source.emit('error'); }); await flush();
    expect(callbacks.error).toHaveBeenCalledOnce(); expect(FakeSource.instances).toHaveLength(1);
    await act(async () => vi.advanceTimersByTime(1000));
    expect(callbacks.error).toHaveBeenCalledTimes(2); expect(FakeSource.instances).toHaveLength(2);
    act(() => FakeSource.instances[1].emit('resync')); expect(callbacks.resync).toHaveBeenCalledOnce();
  });
  it('backs off unavailable CLOSED recovery and stops on anonymous authority', async () => {
    const error = vi.fn(async () => 'unavailable' as Recovery);
    const callbacks = options({ error }); renderHook(() => useRealtime(callbacks));
    FakeSource.instances[0].readyState = 2;
    act(() => FakeSource.instances[0].emit('error')); await flush();
    await act(async () => vi.advanceTimersByTime(1000));
    expect(error).toHaveBeenCalledTimes(2); expect(FakeSource.instances).toHaveLength(2);
    FakeSource.instances[1].readyState = 2;
    error.mockResolvedValue('anonymous'); act(() => FakeSource.instances[1].emit('error')); await flush();
    await act(async () => vi.advanceTimersByTime(60000)); expect(FakeSource.instances).toHaveLength(2);
  });
  it('obsolete callbacks and pending recovery cannot act after epoch replacement or unmount', async () => {
    let finish!: (value: Recovery) => void;
    const error = vi.fn(() => new Promise<Recovery>(resolve => { finish = resolve; }));
    const callbacks = options({ error });
    const { rerender, unmount } = renderHook((o: RealtimeOptions) => useRealtime(o), { initialProps: callbacks });
    const old = FakeSource.instances[0]; const captured = [...old.listeners.get('inventory')!][0];
    old.readyState = 2; act(() => old.emit('error'));
    rerender({ ...callbacks, epoch: 2 });
    act(() => captured(new MessageEvent('inventory', { data: '{}' })));
    await act(async () => finish('authorized'));
    expect(callbacks.inventory).not.toHaveBeenCalled(); unmount();
    await act(async () => vi.advanceTimersByTime(60000)); expect(FakeSource.instances).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('times out one probe and cancels all recovery work on logout', async () => {
    const error = vi.fn((_signal: AbortSignal) => new Promise<Recovery>(() => {}));
    const callbacks = options({ error });
    const { rerender } = renderHook((o: RealtimeOptions) => useRealtime(o), { initialProps: callbacks });
    const source = FakeSource.instances[0]; source.readyState = 2; act(() => source.emit('error'));
    const signal = error.mock.calls[0]?.[0] as AbortSignal;
    await act(async () => vi.advanceTimersByTime(5000)); expect(signal.aborted).toBe(true);
    rerender({ ...callbacks, enabled: false });
    await act(async () => vi.advanceTimersByTime(60000)); expect(FakeSource.instances).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('constructor faults retry boundedly and unsupported browsers retain manual error handling', async () => {
    const error = vi.fn(async () => 'authorized' as Recovery);
    vi.stubGlobal('EventSource', class { constructor() { throw new Error('unavailable'); } });
    const { unmount } = renderHook(() => useRealtime(options({ error }))); await flush();
    expect(error).toHaveBeenCalledOnce(); await act(async () => vi.advanceTimersByTime(1000));
    expect(error).toHaveBeenCalledTimes(2); unmount();
    vi.stubGlobal('EventSource', undefined); renderHook(() => useRealtime(options({ error }))); await flush();
    expect(error).toHaveBeenCalledTimes(3); expect(vi.getTimerCount()).toBe(0);
  });
});
