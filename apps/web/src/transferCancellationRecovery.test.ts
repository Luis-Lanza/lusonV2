import { describe, expect, it, vi } from 'vitest';
import { createTransferCancellationRecovery } from './transferCancellationRecovery';
import { parseTransferRecord } from './transferModel';

const owner = { account: 2, location: 2, epoch: 1, generation: 1 };
const wire = { id: '1', reference: 'TR-001', kind: 'request_stock', status: 'pending',
  created_at: '2026-04-02T00:00:00Z', creator_location_id: 2, creator_location_name: 'A',
  origin_location_id: 1, origin_location_name: 'Warehouse', destination_location_id: 2, destination_location_name: 'A',
  approver_location_id: 1, approver_location_name: 'Warehouse',
  items: [{ variant_id: 1, brand: 'Brand', model: 'Model', capacity_ah: '35.5', polarity: 'L', quantity: '9223372036854775807' }] };
const record = (patch = {}) => parseTransferRecord(JSON.stringify({ ...wire, ...patch }));
const approval = { status: 'approved', decision_location_id: 1, decided_at: '2026-04-03T00:00:00.000000001Z' };
const cancellation = { status: 'cancelled', cancellation_location_id: 2, cancelled_at: '2026-04-03T00:00:00.000000002Z' };

describe('C2 pure cancellation recovery', () => {
  it('pins credential-free originals, one opaque flight and immutable discovered approval', () => {
    const recovery = createTransferCancellationRecovery();
    const source = record(); const first = recovery.start(source, owner)!;
    source.items[0].quantity = 1n;
    expect(first.attempt.original.items[0].quantity).toBe(9223372036854775807n);
    expect(recovery.start(record(), owner)).toBeNull();
    expect(recovery.claim(owner)).toBeNull();
    recovery.finish(first);
    const read = recovery.claim(owner)!;
    expect(recovery.finish(read, record(approval))).toBe(false);
    expect(recovery.get(owner)).toMatchObject({ phase: 'uncertain', original: { status: 'pending' }, current: { status: 'approved' } });
    const retry = recovery.start(record(approval), owner)!;
    expect(retry.attempt.original).toBe(first.attempt.original);
    expect(recovery.finish(first, record(cancellation))).toBe(false);
    expect(() => recovery.finish(retry, record(cancellation))).toThrow();
    expect(recovery.isCurrent(retry, owner)).toBe(true);
    expect(recovery.finish(retry, record({ ...approval, ...cancellation }))).toBe(true);
    const settled = recovery.get(owner)!;
    for (const value of [settled, settled.owner, settled.original, settled.original.items, settled.original.items[0], settled.result]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(Object.keys(settled.owner)).toEqual(['account', 'location', 'epoch', 'generation']);
    expect(recovery.claim(owner)).toBeNull();
    expect(recovery.start(record(), owner)).toBeNull();
  });
  it.each(['account', 'location', 'epoch', 'generation'] as const)('fences owner %s and obsolete completions', field => {
    const recovery = createTransferCancellationRecovery();
    const old = recovery.start(record(), owner)!;
    const nextOwner = { ...owner, [field]: owner[field] + 1 };
    expect(recovery.get(nextOwner)).toBeNull();
    expect(recovery.claim(nextOwner)).toBeNull();
    expect(recovery.isCurrent(old, nextOwner)).toBe(false);
    if (field === 'location') return;
    const next = recovery.start(record(), nextOwner)!;
    expect(recovery.finish(old, record(cancellation))).toBe(false);
    expect(recovery.isCurrent(next, nextOwner)).toBe(true);
    expect(recovery.get(null)).toBeNull();
  });
  it.each([403, 404])('retains request-specific privacy masks after %s without masking another creator request', status => {
    const recovery = createTransferCancellationRecovery();
    const first = recovery.start(record(), owner)!;
    recovery.finish(first, undefined, true, { code: status === 403 ? 'forbidden' : 'not_found', status, uncertainCancellation: false });
    expect(recovery.get(owner)).toBeNull();
    expect(recovery.claim(owner)).toBeNull();
    expect(recovery.start(record(), owner)).toBeNull();
    const other = { id: '2', reference: 'TR-002' };
    const next = recovery.start(record(other), owner)!;
    expect(next).not.toBeNull();
    expect(recovery.finish(first, record(cancellation))).toBe(false);
    recovery.finish(next, record({ ...other, ...cancellation }));
    expect(recovery.start(record(), owner)).toBeNull();
  });
  it('refuses noncreators and terminal starts, and never replaces an unmasked uncertain original', () => {
    const recovery = createTransferCancellationRecovery();
    expect(recovery.start(record(), { ...owner, location: 1 })).toBeNull();
    expect(recovery.start(record(cancellation), owner)).toBeNull();
    const first = recovery.start(record(), owner)!;
    recovery.finish(first);
    expect(recovery.start(record({ id: '2', reference: 'TR-002' }), owner)).toBeNull();
    const read = recovery.claim(owner)!;
    expect(recovery.finish(read, record({ ...approval, status: 'rejected' }))).toBe(true);
    expect(recovery.get(owner)).toMatchObject({ phase: 'conflict', result: { status: 'rejected' } });
    expect(recovery.start(record(), owner)).toBeNull();
  });
  it('never resends a known terminal cancellation after settling another request', () => {
    const recovery = createTransferCancellationRecovery();
    const first = recovery.start(record(), owner)!;
    recovery.finish(first, record(cancellation));
    const other = { id: '2', reference: 'TR-002' };
    const next = recovery.start(record(other), owner)!;
    recovery.finish(next, record({ ...other, ...cancellation }));
    expect(recovery.start(record(), owner)).toBeNull();
    expect(recovery.start(record(other), owner)).toBeNull();
    expect(recovery.get(owner)?.result?.id).toBe('2');
  });
  it('isolates observers and returns the original token if an observer replaces its owner', () => {
    const recovery = createTransferCancellationRecovery(); const observer = vi.fn();
    let replaced = false;
    recovery.subscribe(() => { throw new Error('detached'); });
    recovery.subscribe(observer);
    recovery.subscribe(() => {
      if (!replaced) { replaced = true; recovery.start(record(), { ...owner, generation: 2 }); }
    });
    const old = recovery.start(record(), owner)!;
    expect(old.attempt.owner).toEqual(owner);
    expect(recovery.isCurrent(old, owner)).toBe(false);
    expect(recovery.finish(old, record(cancellation))).toBe(false);
    expect(observer).toHaveBeenCalledTimes(2);
  });
});
