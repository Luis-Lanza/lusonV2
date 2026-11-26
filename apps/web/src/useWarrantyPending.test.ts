import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useWarrantyPending } from './useWarrantyPending';
import { notifyWarrantyInvalidation } from './useInventory';
import type { TransferController } from './useInventory';
import type { WarrantyCasesAPI } from './warrantyCasesAPI';

const csrf = 'c'.repeat(43);
const session = {
  authenticated: true, csrf_token: csrf, expires_at: '2030-01-01T00:00:00Z',
  identity: { account_id: 2, username: 'branch', display_name: 'Sucursal A', must_change_password: false,
    location: { id: 2, name: 'Sucursal A' } },
};
function controller(): TransferController {
  const authority = { epoch: 1, ready: true, session };
  return {
    getTransferAuthority: () => authority,
    settleUnauthorized: vi.fn(async () => 'authorized' as const),
  } as unknown as TransferController;
}
const pendingAPI = (pending: ReturnType<typeof vi.fn>) =>
  ({ pending } as unknown as WarrantyCasesAPI);

afterEach(cleanup);

describe('the warranty notification count', () => {
  it('reads the count of this actor and reads it again on the warranty invalidation', async () => {
    const pending = vi.fn().mockResolvedValueOnce(2n).mockResolvedValueOnce(5n);
    const ctl = controller(); const api = pendingAPI(pending);
    const view = renderHook(() => useWarrantyPending({ controller: ctl, enabled: true, api }));
    await waitFor(() => expect(view.result.current.actionCount).toBe(2n));
    expect(view.result.current.unavailable).toBe(false);
    act(() => notifyWarrantyInvalidation());
    await waitFor(() => expect(view.result.current.actionCount).toBe(5n));
    expect(pending).toHaveBeenCalledTimes(2);
  });
  it('is honest when the count cannot be known and never invents a number', async () => {
    const pending = vi.fn().mockRejectedValueOnce(new Error('offline'));
    const ctl = controller(); const api = pendingAPI(pending);
    const view = renderHook(() => useWarrantyPending({ controller: ctl, enabled: true, api }));
    await waitFor(() => expect(view.result.current.unavailable).toBe(true));
    expect(view.result.current.actionCount).toBeNull();
  });
  it('does not read before the session is ready for it', () => {
    const pending = vi.fn();
    const ctl = controller(); const api = pendingAPI(pending);
    const view = renderHook(() => useWarrantyPending({ controller: ctl, enabled: false, api }));
    expect(pending).not.toHaveBeenCalled();
    expect(view.result.current.actionCount).toBeNull();
    expect(view.result.current.unavailable).toBe(false);
  });
});
