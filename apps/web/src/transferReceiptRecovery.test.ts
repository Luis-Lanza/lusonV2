import { describe, expect, it, vi } from 'vitest';
import { createTransferReceiptRecovery } from './transferReceiptRecovery';
import { parseTransferRecord } from './transferModel';

// Deliberately isolated planned-module suite. Existing model/API/UI suites carry
// behavior RED independently of this module's initial absence.
const wire = {
  id: '1', reference: 'TR-001', kind: 'request_stock', status: 'in_transit',
  creator_location_id: 2, creator_location_name: 'Sucursal A', origin_location_id: 1, origin_location_name: 'Almacén',
  destination_location_id: 2, destination_location_name: 'Sucursal A', approver_location_id: 1, approver_location_name: 'Almacén',
  created_at: '2026-04-02T00:00:00Z', decision_location_id: 1, decided_at: '2026-04-03T00:00:00.000000001Z',
  dispatch_location_id: 1, dispatched_at: '2026-04-03T00:00:00.000000002Z',
  items: [{ variant_id: 1, brand: 'TOYO', model: 'Exact', capacity_ah: '75.125', polarity: 'L', quantity: '2' }],
};
const parse = (value: unknown) => parseTransferRecord(JSON.stringify(value));
const transit = (patch = {}) => parse({ ...wire, ...patch });
const received = (actual = '1', patch = {}) => parse({ ...wire, status: 'received', receipt_location_id: 2,
  received_at: '2026-04-03T00:00:00.000000003Z', receipt: {
    items: [{ variant_id: 1, expected_quantity: '2', actual_quantity: actual, available_quantity: actual }],
    exceptions: actual === '2' ? [] : [{ variant_id: 1, kind: 'shortage', quantity: '1' }],
  }, ...patch });
const payload = () => ({ items: [{ variant_id: 1, actual_quantity: '1' }] });
const owner = { account: 42, location: 2, epoch: 7, generation: 3 };

describe('R2 controller-owned receipt recovery', () => {
  it('captures credential-free immutable original and normalized payload without mutating callers', () => {
    const recovery = createTransferReceiptRecovery();
    const input = payload(); const source = transit(); const actor = { ...owner };
    const token = recovery.start(source, input, actor)!;
    expect(token).not.toBeNull();
    input.items[0].actual_quantity = '2'; source.items[0].quantity = 1n; actor.account = 9;
    const attempt = recovery.get(owner)!;
    expect(attempt).toMatchObject({ phase: 'inFlight', original: { items: [{ quantity: 2n }] },
      input: { items: [{ variant_id: 1, actual_quantity: '1' }] }, owner });
    for (const value of [attempt, attempt.input, attempt.input.items, attempt.input.items[0],
      attempt.original, attempt.original.items, attempt.original.items[0], attempt.owner]) expect(Object.isFrozen(value)).toBe(true);
    expect(Object.keys(attempt.owner)).toEqual(['account', 'location', 'epoch', 'generation']);
    expect(recovery.start(transit(), payload(), owner)).toBeNull();
  });
  it('keeps InTransit GET uncertain and permits only explicit identical payload retry', () => {
    const recovery = createTransferReceiptRecovery();
    const token = recovery.start(transit(), payload(), owner)!;
    recovery.finish(token, undefined, false, { code: 'network', status: null, uncertainReceipt: true });
    const read = recovery.claim(owner, true)!;
    expect(recovery.finish(read, transit())).toBe(false);
    expect(recovery.get(owner)).toMatchObject({ phase: 'uncertain', result: null, input: payload() });
    expect(recovery.start(transit(), { items: [{ variant_id: 1, actual_quantity: '2' }] }, owner)).toBeNull();
    expect(recovery.start(transit({ id: '2', reference: 'TR-002' }), payload(), owner)).toBeNull();
    const retry = recovery.start(transit(), payload(), owner)!;
    expect(retry.attempt.input).toBe(token.attempt.input);
    expect(recovery.finish(token, received())).toBe(false);
    expect(recovery.isCurrent(retry, owner)).toBe(true);
    expect(recovery.finish(retry, received())).toBe(true);
    expect(recovery.get(owner)).toMatchObject({ phase: 'confirmed', result: { status: 'received' } });
  });
  it('confirms a persisted different receipt truthfully without replacing pinned retry quantities', () => {
    const recovery = createTransferReceiptRecovery();
    const sent = recovery.start(transit(), payload(), owner)!; recovery.finish(sent);
    const read = recovery.claim(owner, true)!;
    expect(recovery.finish(read, received('2'))).toBe(true);
    expect(recovery.get(owner)).toMatchObject({ phase: 'conflict', result: { status: 'received',
      receipt: { items: [{ actual_quantity: 2n }] } }, input: payload() });
    expect(recovery.claim(owner)).toBeNull();
    expect(recovery.start(transit(), payload(), owner)).toBeNull();
    const snapshot = recovery.get(owner)!;
    const receipt = Reflect.get(snapshot.result!, 'receipt');
    for (const value of [snapshot.result, receipt, receipt.items, receipt.items[0], receipt.exceptions]) expect(Object.isFrozen(value)).toBe(true);
  });
  it.each(['account', 'location', 'epoch', 'generation'] as const)('fences changed %s before rendering or settling', field => {
    const recovery = createTransferReceiptRecovery(); const old = recovery.start(transit(), payload(), owner)!;
    const changed = { ...owner, [field]: owner[field] + 1 };
    expect(recovery.get(changed)).toBeNull(); expect(recovery.claim(changed, true)).toBeNull();
    expect(recovery.isCurrent(old, changed)).toBe(false);
    expect(recovery.get(null)).toBeNull();
  });
  it('ignores obsolete flights after owner replacement', () => {
    const recovery = createTransferReceiptRecovery(); const old = recovery.start(transit(), payload(), owner)!;
    const nextOwner = { ...owner, generation: 4 };
    const next = recovery.start(transit(), payload(), nextOwner)!;
    expect(recovery.finish(old, received())).toBe(false);
    expect(recovery.isCurrent(next, nextOwner)).toBe(true);
    expect(recovery.get(nextOwner)?.phase).toBe('inFlight');
  });
  it.each([403, 404] as const)('scopes a %s privacy mask to one request, retaining stale-token fences', status => {
    const recovery = createTransferReceiptRecovery(); const masked = recovery.start(transit(), payload(), owner)!;
    recovery.finish(masked, undefined, true, { code: status === 403 ? 'forbidden' : 'not_found', status, uncertainReceipt: false });
    expect(recovery.get(owner)).toBeNull(); expect(recovery.claim(owner)).toBeNull();
    expect(recovery.start(transit(), payload(), owner)).toBeNull();
    const other = { id: '2', reference: 'TR-002' };
    const next = recovery.start(transit(other), payload(), owner)!;
    expect(next).not.toBeNull();
    expect(recovery.finish(masked, received())).toBe(false);
    expect(recovery.finish(next, received('1', other))).toBe(true);
  });
  it('admits only destination InTransit, including warehouse destination', () => {
    const recovery = createTransferReceiptRecovery();
    expect(recovery.start(transit(), payload(), { ...owner, location: 1 })).toBeNull();
    expect(recovery.start(received(), payload(), owner)).toBeNull();
    const send = transit({ kind: 'send_to_warehouse', creator_location_id: 2, origin_location_id: 2,
      origin_location_name: 'Sucursal A', destination_location_id: 1, destination_location_name: 'Almacén', dispatch_location_id: 2 });
    expect(recovery.start(send, payload(), { ...owner, location: 1 })).not.toBeNull();
  });
  it('never consumes a flight when original, approval or dispatch identity differs', () => {
    for (const patch of [{ id: '2', reference: 'TR-002' }, { decided_at: '2026-04-03T00:00:00Z' },
      { dispatched_at: '2026-04-03T00:00:00.000000001Z' }]) {
      const recovery = createTransferReceiptRecovery(); const token = recovery.start(transit(), payload(), owner)!;
      expect(() => recovery.finish(token, received('1', patch))).toThrow();
      expect(recovery.isCurrent(token, owner)).toBe(true);
    }
  });
  it('isolates detached listeners and detaches observers without transport side effects', () => {
    const recovery = createTransferReceiptRecovery(); const observer = vi.fn();
    recovery.subscribe(() => { throw new Error('detached'); }); const detach = recovery.subscribe(observer);
    const token = recovery.start(transit(), payload(), owner)!;
    expect(observer).toHaveBeenCalledTimes(1); detach(); recovery.finish(token);
    expect(observer).toHaveBeenCalledTimes(1); expect(recovery.get(owner)?.phase).toBe('uncertain');
  });
});
