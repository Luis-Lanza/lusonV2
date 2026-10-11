import { describe, expect, it } from 'vitest';
import { createTransferDispatchRecovery } from './transferDispatchRecovery';
import { parseTransferRecord } from './transferModel';
const dispatchWire = (overrides = {}) => ({
  id: '9007199254740993', reference: 'TR-9007199254740993', kind: 'request_stock', status: 'in_transit',
  creator_location_id: 2, creator_location_name: 'Sucursal A', origin_location_id: 1, origin_location_name: 'Almacén',
  destination_location_id: 2, destination_location_name: 'Sucursal A', approver_location_id: 1, approver_location_name: 'Almacén',
  created_at: '2026-04-02T00:00:00Z', decision_location_id: 1, decided_at: '2026-04-03T00:00:00.000000001Z',
  dispatch_location_id: 1, dispatched_at: '2026-04-03T00:00:00.000000002Z',
  items: [{ variant_id: 1, brand: 'Brand', model: 'Model', capacity_ah: '35.5', polarity: 'L', quantity: '9223372036854775807' }], ...overrides,
});

const approved = () => parseTransferRecord(JSON.stringify(dispatchWire({ status: 'approved', dispatch_location_id: undefined, dispatched_at: undefined })));
const transit = (changes = {}) => parseTransferRecord(JSON.stringify(dispatchWire(changes)));
const owner = { account: 1, location: 1, epoch: 1, generation: 1 };
describe('R2 later dispatch outcome', () => {
  it('confirms Received on explicit dispatch recovery without discarding approval or dispatch identity', () => {
    const recovery = createTransferDispatchRecovery(); const token = recovery.start(approved(), owner)!;
    recovery.finish(token); const read = recovery.claim(owner, true)!;
    const received = parseTransferRecord(JSON.stringify(dispatchWire({ status: 'received', receipt_location_id: 2,
      received_at: '2026-04-03T00:00:00.000000003Z', receipt: {
        items: [{ variant_id: 1, expected_quantity: '9223372036854775807', actual_quantity: '9223372036854775807', available_quantity: '9223372036854775807' }], exceptions: [],
      } })));
    expect(recovery.finish(read, received)).toBe(true);
    expect(recovery.get(owner)).toMatchObject({ phase: 'confirmed', result: { status: 'received',
      decided_at: '2026-04-03T00:00:00.000000001Z', dispatched_at: '2026-04-03T00:00:00.000000002Z' } });
    const receipt = Reflect.get(recovery.get(owner)!.result!, 'receipt');
    for (const value of [receipt, receipt.items, receipt.items[0], receipt.exceptions]) expect(Object.isFrozen(value)).toBe(true);
  });
});

describe('D2 controller-owned dispatch recovery', () => {
  it('keeps approved GET uncertain and confirms only matching transit, with immutable approval', () => {
    const recovery = createTransferDispatchRecovery();
    const token = recovery.start(approved(), owner)!;
    expect(token).not.toBeNull();
    expect(recovery.start(approved(), owner)).toBeNull();
    recovery.finish(token, undefined, false, { code: 'network', status: null, uncertainDispatch: true });
    const read = recovery.claim(owner, true)!;
    expect(recovery.finish(read, approved())).toBe(false);
    expect(recovery.get(owner)?.phase).toBe('uncertain');
    const retry = recovery.start(approved(), owner)!;
    expect(() => recovery.finish(retry, transit({ decided_at: '2026-04-03T00:00:00Z' }))).toThrow();
    expect(recovery.isCurrent(retry, owner)).toBe(true);
    expect(recovery.finish(retry, transit())).toBe(true);
    expect(recovery.get(owner)).toMatchObject({ phase: 'confirmed', result: { status: 'in_transit' } });
    expect(Object.isFrozen(recovery.get(owner)?.original.items)).toBe(true);
  });
  it('fences account, location, epoch, generation and replacement opaque flights', () => {
    const recovery = createTransferDispatchRecovery();
    const old = recovery.start(approved(), owner)!;
    for (const changed of [{ account: 9 }, { location: 2 }, { epoch: 2 }, { generation: 2 }]) {
      expect(recovery.get({ ...owner, ...changed })).toBeNull();
      expect(recovery.isCurrent(old, { ...owner, ...changed })).toBe(false);
    }
    const replacement = { ...owner, generation: 2 };
    const next = recovery.start(approved(), replacement)!;
    expect(recovery.finish(old, transit())).toBe(false);
    expect(recovery.isCurrent(next, replacement)).toBe(true);
    recovery.finish(next, undefined, true);
    expect(recovery.get(replacement)).toBeNull();
    expect(recovery.start(approved(), replacement)).toBeNull();
  });
  it.each([403, 404] as const)('keeps masked request private after %s while admitting another approved request for the same owner', status => {
    const recovery = createTransferDispatchRecovery();
    const masked = recovery.start(approved(), owner)!;
    recovery.finish(masked, undefined, true, {
      code: status === 403 ? 'forbidden' : 'not_found', status, uncertainDispatch: false,
    });
    expect(recovery.get(owner)).toBeNull();
    expect(recovery.claim(owner)).toBeNull();
    expect(recovery.start(approved(), owner)).toBeNull();
    const identity = { id: '9007199254740994', reference: 'TR-9007199254740994' };
    const other = parseTransferRecord(JSON.stringify(dispatchWire({ ...identity, status: 'approved',
      dispatch_location_id: undefined, dispatched_at: undefined })));
    const next = recovery.start(other, owner)!;
    expect(next).not.toBeNull();
    expect(recovery.get(owner)).toMatchObject({ phase: 'inFlight', original: identity, failure: null });
    expect(recovery.finish(masked, transit())).toBe(false);
    expect(recovery.isCurrent(next, owner)).toBe(true);
    for (const changed of [{ account: 9 }, { location: 2 }, { epoch: 2 }, { generation: 2 }]) {
      expect(recovery.get({ ...owner, ...changed })).toBeNull();
      expect(recovery.isCurrent(next, { ...owner, ...changed })).toBe(false);
    }
    expect(recovery.finish(next, transit(identity))).toBe(true);
    expect(recovery.get(owner)).toMatchObject({ phase: 'confirmed', result: identity });
  });
  it('admits only approved physical origins, never destination approval authority', () => {
    const recovery = createTransferDispatchRecovery();
    expect(recovery.start(approved(), { ...owner, location: 2 })).toBeNull();
    expect(recovery.start(transit(), owner)).toBeNull();
  });
});
