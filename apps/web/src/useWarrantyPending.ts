import { useEffect, useState } from 'react';
import type { Session } from './model';
import { subscribeWarrantyInvalidation, type TransferController } from './useInventory';
import { createWarrantyCasesAPI, WarrantyCaseAPIError, type WarrantyCasesAPI } from './warrantyCasesAPI';

/**
 * The notification of the battery case section (S19): how many cases wait for the side this session
 * acts from, and never an act the actor cannot take. The count is one aggregate read of the case
 * contract, so the badge beside the navigation entry is honest while no list is open, and it is read
 * again on the same participant invalidation that re-reads the two warranty screens. A count that
 * cannot be known is reported as unknown, never as a zero and never as the previous number.
 */

export interface WarrantyPending {
  /** The exact count of cases waiting for this actor, or null while it is being read or unknown. */
  readonly actionCount: bigint | null;
  readonly busy: boolean;
  /** True when the last read failed: the screen says the count is unknown instead of guessing. */
  readonly unavailable: boolean;
}

export interface WarrantyPendingOptions {
  controller: TransferController;
  enabled: boolean;
  api?: Pick<WarrantyCasesAPI, 'pending'>;
}

function identityOf(session: Session | null): string {
  if (!session?.authenticated || session.identity.must_change_password === true) return '';
  // Snapshot scalar authority, never a mutable session object.
  return JSON.stringify([session.csrf_token, session.identity.account_id, session.identity.location.id]);
}

export function useWarrantyPending({ controller, enabled, api: injected }: WarrantyPendingOptions): WarrantyPending {
  const [defaultAPI] = useState(() => createWarrantyCasesAPI());
  const api = injected ?? defaultAPI;
  const authority = controller.getTransferAuthority();
  const { epoch, ready, session } = authority;
  const identity = identityOf(session);
  const active = enabled && ready && identity !== '';
  const [state, setState] = useState({ epoch: -1, identity: '', actionCount: null as bigint | null,
    busy: false, unavailable: false });
  const [revision, setRevision] = useState(0);
  const settleUnauthorized = controller.settleUnauthorized;
  useEffect(() => {
    if (!active) {
      setState({ epoch, identity, actionCount: null, busy: false, unavailable: false });
      return;
    }
    const flight = new AbortController();
    let alive = true;
    setState(previous => ({
      epoch, identity,
      // A new identity never inherits another session's count; the same one keeps it while it re-reads.
      actionCount: previous.epoch === epoch && previous.identity === identity ? previous.actionCount : null,
      busy: true, unavailable: false,
    }));
    void (async () => {
      try {
        const count = await api.pending(flight.signal);
        if (!alive) return;
        setState({ epoch, identity, actionCount: count, busy: false, unavailable: false });
      } catch (error) {
        if (!alive) return;
        setState({ epoch, identity, actionCount: null, busy: false, unavailable: true });
        if (error instanceof WarrantyCaseAPIError && error.status === 401) await settleUnauthorized(epoch);
      }
    })();
    return () => { alive = false; flight.abort(); };
  }, [api, active, epoch, identity, revision, settleUnauthorized]);
  useEffect(() => {
    if (!active) return;
    return subscribeWarrantyInvalidation(() => setRevision(value => value + 1));
  }, [active]);
  const visible = active && state.epoch === epoch && state.identity === identity;
  return {
    actionCount: visible ? state.actionCount : null,
    busy: visible && state.busy,
    unavailable: visible && state.unavailable,
  };
}
