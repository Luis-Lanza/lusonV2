import { archivedCartDescriptor, type CartDescriptor, type TransferCart } from './transferCart';
import type { TransferAuthority } from './useInventory';
import { canonicalTransferInput, transferDirection, transferFlow, validTransferLocation, type TransferCreateInput, type TransferDirection, type TransferLocationID } from './transferModel';
export interface RecoveryHandle { readonly __recoveryHandle?: never }
export interface RecoveryFlight { readonly __recoveryFlight?: never }
// The archived selection is the cart descriptor itself plus the requested quantity,
// so the recovery and the cart can never describe the same row differently.
export interface RecoveryItem extends CartDescriptor { readonly quantity: string }
export interface RecoverySnapshot {
  readonly epoch: number; readonly phase: 'ready' | 'unknown' | 'inFlight'; readonly handle: RecoveryHandle;
  readonly attempt: TransferCreateInput; readonly direction: Readonly<TransferDirection>; readonly items: readonly RecoveryItem[];
}
type AuthorityGetter = () => TransferAuthority;
type Owner = { key: string; epoch: number; generation: number; account: number; assigned: TransferLocationID };
type Entry = { owner: string; handle: RecoveryHandle; phase: RecoverySnapshot['phase'];
  attempt: TransferCreateInput; direction: Readonly<TransferDirection>; items: readonly RecoveryItem[]; flight: RecoveryFlight | null };
type Flight = { entry: Entry; epoch: number; generation: number };
function unavailable(): never { throw new Error('Transfer recovery unavailable'); }
function integer(value: number, max: number): boolean { return Number.isInteger(value) && value >= 1 && value <= max; }

// Only opaque identities escape these instance-local maps; no auth object is retained.
export function createTransferRecovery() {
  const slots = new Map<string, Entry>();
  const handles = new WeakMap<RecoveryHandle, Entry>();
  const flights = new WeakMap<RecoveryFlight, Flight>();
  function owner(get: AuthorityGetter): Owner | null {
    try {
      const a = get(); const s = a.session;
      if (!a.ready || !s?.authenticated || s.identity.must_change_password === true) return null;
      const account = s.identity.account_id; const assigned = s.identity.location.id;
      if (!integer(account, Number.MAX_SAFE_INTEGER) || !validTransferLocation(assigned)
        || (account === 1) !== (assigned === 1)) return null;
      return { key: `${account}:${assigned}`, account, assigned, epoch: a.epoch, generation: a.sessionGeneration ?? 0 };
    } catch { return null; }
  }
  function current(o: Owner): Entry | undefined {
    const entry = slots.get(o.key);
    // Reauthentication makes an unsettled old flight uncertain, never auto-sends.
    if (entry?.flight && (flights.get(entry.flight)?.epoch !== o.epoch || flights.get(entry.flight)?.generation !== o.generation)) {
      entry.phase = 'unknown'; entry.flight = null;
    }
    return entry;
  }
  function live(flight: RecoveryFlight): Flight | undefined {
    const record = flights.get(flight);
    return record && slots.get(record.entry.owner) === record.entry && record.entry.flight === flight ? record : undefined;
  }
  function selected(o: Owner, handle: RecoveryHandle): Entry | undefined {
    const entry = current(o);
    return entry && handles.get(handle) === entry ? entry : undefined;
  }
  function remove(entry: Entry) { slots.delete(entry.owner); entry.flight = null; }
  return Object.freeze({
    getCurrent(get: AuthorityGetter): RecoverySnapshot | null {
      const o = owner(get); if (!o) return null;
      const entry = current(o); if (!entry) return null;
      return Object.freeze({ epoch: o.epoch, phase: entry.phase, handle: entry.handle,
        attempt: entry.attempt, direction: entry.direction, items: entry.items });
    },
    capture(get: AuthorityGetter, cart: TransferCart): RecoveryHandle {
      const o = owner(get); if (!o) return unavailable();
      try {
        // Metadata guard precedes all cart payload getters (including attempt/lines).
        if (cart.epoch !== o.epoch || cart.sessionGeneration !== o.generation || cart.accountID !== o.account || cart.assigned !== o.assigned) return unavailable();
        if (!cart.attempt) return unavailable();
        const attempt = canonicalTransferInput(cart.attempt);
        const flow = transferFlow(o.assigned, attempt.kind, attempt.counterparty_location_id);
        const direction = Object.freeze(transferDirection(o.assigned, flow));
        if (Object.keys(direction).some(k => direction[k as keyof TransferDirection] !== cart.direction[k as keyof TransferDirection])
          || attempt.counterparty_location_id !== direction.counterparty_location_id
          || cart.catalog.location.id !== direction.origin_location_id || cart.lines.length !== attempt.items.length) return unavailable();
        const seen = new Set<number>();
        const items = Object.freeze(attempt.items.map(line => {
          const selected = cart.lines.find(v => v.item.variant_id === line.variant_id);
          if (!selected || selected.quantity.toString() !== line.quantity) return unavailable();
          // The archived line is the shared identity of its own kind plus the
          // requested quantity: no surface has to know a battery attribute.
          if (seen.has(line.variant_id)) return unavailable();
          seen.add(line.variant_id);
          return Object.freeze({ ...archivedCartDescriptor(selected.item), quantity: line.quantity });
        }));
        const previous = current(o);
        if (previous) {
          if (JSON.stringify(previous.attempt) !== JSON.stringify(attempt)) return unavailable();
          return previous.handle;
        }
        if (slots.size >= 3) return unavailable();
        const handle = Object.freeze({});
        const entry: Entry = { owner: o.key, handle, phase: 'ready', attempt, direction, items, flight: null };
        slots.set(o.key, entry); handles.set(handle, entry);
        return handle;
      } catch { return unavailable(); }
    },
    begin(get: AuthorityGetter, handle: RecoveryHandle): RecoveryFlight {
      const o = owner(get); if (!o) return unavailable();
      const entry = selected(o, handle); if (!entry || entry.phase === 'inFlight') return unavailable();
      const flight = Object.freeze({});
      flights.set(flight, { entry, epoch: o.epoch, generation: o.generation }); entry.flight = flight; entry.phase = 'inFlight';
      return flight;
    },
    markUnknown(flight: RecoveryFlight): boolean {
      const record = live(flight); if (!record) return false;
      record.entry.phase = 'unknown'; record.entry.flight = null; return true;
    },
    confirmSuccess(get: AuthorityGetter, flight: RecoveryFlight): boolean {
      const o = owner(get); if (!o) return false;
      const record = live(flight);
      if (!record || record.entry.owner !== o.key || record.epoch !== o.epoch || record.generation !== o.generation) return false;
      remove(record.entry); return true;
    },
    discardCurrent(get: AuthorityGetter, handle: RecoveryHandle, acknowledgedUncertainty: boolean): boolean {
      const o = owner(get); if (!o) return false;
      const entry = selected(o, handle);
      if (!entry || entry.phase === 'inFlight' || (entry.phase === 'unknown' && acknowledgedUncertainty !== true)) return false;
      remove(entry); return true;
    },
  });
}
