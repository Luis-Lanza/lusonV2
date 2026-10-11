import { describe, expect, it, vi } from 'vitest';
import { createTransferDecisionRecovery, decisionOwner, matchesDecisionRecord, type DecisionOwner } from './transferDecisionRecovery';
import { parseTransferRecord, type TransferRecord } from './transferModel';

const wire = { id: '9007199254740993', reference: 'TR-9007199254740993', kind: 'request_stock', status: 'pending', created_at: '2026-04-02T00:00:00.000000001Z',
  creator_location_id: 2, creator_location_name: 'Branch A', origin_location_id: 1, origin_location_name: 'Warehouse',
  destination_location_id: 2, destination_location_name: 'Branch A', approver_location_id: 1, approver_location_name: 'Warehouse',
  items: [{ variant_id: 201, brand: 'Brand', model: 'Model', capacity_ah: '35.5', polarity: 'R', quantity: '9007199254740993' }] };
const record = () => parseTransferRecord(JSON.stringify(wire));
const owner: DecisionOwner = { account: 42, location: 1, epoch: 7, generation: 3 };
const outcome = (status: 'approved' | 'rejected') => parseTransferRecord(JSON.stringify({ ...wire, status,
  decision_location_id: 1, decided_at: '2026-04-03T00:00:00.000000001Z' }));

describe('R2 historical decision recovery', () => {
  it('an approval retry confirms current Received and freezes its nested receipt', () => {
    const recovery = createTransferDecisionRecovery(); const token = recovery.start(record(), 'approve', owner)!;
    const received = parseTransferRecord(JSON.stringify({ ...wire, status: 'received', decision_location_id: 1,
      decided_at: '2026-04-03T00:00:00.000000001Z', dispatch_location_id: 1,
      dispatched_at: '2026-04-03T00:00:00.000000002Z', receipt_location_id: 2,
      received_at: '2026-04-03T00:00:00.000000003Z', receipt: {
        items: [{ variant_id: 201, expected_quantity: '9007199254740993', actual_quantity: '9007199254740993', available_quantity: '9007199254740993' }], exceptions: [],
      } }));
    expect(recovery.finish(token, received)).toBe(true);
    expect(recovery.get(owner)).toMatchObject({ phase: 'confirmed', result: { status: 'received' } });
    const receipt = Reflect.get(recovery.get(owner)!.result!, 'receipt');
    for (const value of [receipt, receipt.items, receipt.items[0], receipt.exceptions]) expect(Object.isFrozen(value)).toBe(true);
    const changed = { ...received, receipt: { ...receipt, items: [{ ...receipt.items[0], actual_quantity: 1n }] } };
    expect(matchesDecisionRecord(received, changed)).toBe(false);
  });
});

describe('controller-owned decision recovery', () => {
  it.each(['approve', 'reject'] as const)('deep captures a credential-free immutable %s original and never mutates its source', action => {
    const recovery = createTransferDecisionRecovery(); const source = record(); const actor = { ...owner };
    const token = recovery.start(source, action, actor);
    expect(token).not.toBeNull();
    source.reference = 'changed'; source.items[0].quantity = 1n; actor.account = 9;
    const snapshot = recovery.get(owner)!;
    expect(snapshot.original).toMatchObject({ id: wire.id, reference: wire.reference, created_at: wire.created_at, items: [{ quantity: 9007199254740993n }] });
    expect(snapshot.owner).toEqual(owner); expect(Object.keys(snapshot)).toEqual(['original', 'action', 'owner', 'phase', 'result', 'failure']);
    for (const value of [snapshot, snapshot.original, snapshot.original.items, snapshot.original.items[0], snapshot.owner]) expect(Object.isFrozen(value)).toBe(true);
    expect(Object.keys(snapshot.owner)).toEqual(['account', 'location', 'epoch', 'generation']);
  });
  it.each(['account', 'location', 'epoch', 'generation'] as const)('masks and refuses old recovery for changed %s before any render', field => {
    const recovery = createTransferDecisionRecovery(); const token = recovery.start(record(), 'approve', owner)!;
    const changed = { ...owner, [field]: owner[field] + 1 };
    expect(recovery.get(changed)).toBeNull(); expect(recovery.claim(changed)).toBeNull(); expect(recovery.isCurrent(token, changed)).toBe(false);
    expect(recovery.get(null)).toBeNull(); expect(recovery.claim(null)).toBeNull();
    expect(recovery.get(owner)?.phase).toBe('inFlight');
  });
  it('refuses authority derived from DTO, anonymous sessions, or a nonapprover', () => {
    const recovery = createTransferDecisionRecovery();
    expect(recovery.start(record(), 'approve', { ...owner, location: 2 })).toBeNull();
    expect(decisionOwner({ epoch: 1, ready: false, session: null })).toBeNull();
    expect(decisionOwner({ epoch: 1, ready: true, session: { authenticated: false, csrf_token: 'not-stored' } })).toBeNull();
    expect(recovery.get(owner)).toBeNull();
  });
  it.each(['approve', 'reject'] as const)('retains Pending uncertainty and allows only nonoverlapping original %s retries', action => {
    const recovery = createTransferDecisionRecovery(); const original = record(); const first = recovery.start(original, action, owner)!;
    expect(recovery.start(original, action, owner)).toBeNull(); expect(recovery.claim(owner, true)).toBeNull();
    expect(recovery.finish(first)).toBe(false); expect(recovery.get(owner)?.phase).toBe('uncertain');
    const read = recovery.claim(owner, true)!;
    expect(recovery.finish(read, record())).toBe(false); expect(recovery.get(owner)).toMatchObject({ phase: 'uncertain', result: null });
    expect(recovery.start(original, action === 'approve' ? 'reject' : 'approve', owner)).toBeNull();
    expect(recovery.start({ ...original, id: '2', reference: 'TR-002' }, action, owner)).toBeNull();
    const retry = recovery.start(original, action, owner)!;
    expect(retry.attempt.original).toBe(first.attempt.original); expect(retry.attempt.action).toBe(action);
    expect(recovery.finish(first, outcome(action === 'approve' ? 'approved' : 'rejected'))).toBe(false);
    expect(recovery.get(owner)?.phase).toBe('inFlight');
  });
  it.each((['approve', 'reject'] as const).flatMap(action => (['approved', 'rejected'] as const).map(status => ({ action, status }))))
   ('records authorized same/opposite persisted $status for $action', ({ action, status }) => {
      const recovery = createTransferDecisionRecovery(); const first = recovery.start(record(), action, owner)!;
      recovery.finish(first); const read = recovery.claim(owner, true)!;
      expect(recovery.finish(read, outcome(status))).toBe(true);
      expect(recovery.get(owner)).toMatchObject({ phase: status === (action === 'approve' ? 'approved' : 'rejected') ? 'confirmed' : 'conflict', result: { status, decided_at: '2026-04-03T00:00:00.000000001Z' } });
    });
  it('an obsolete opaque flight cannot release or clear a replacement owner attempt', () => {
    const recovery = createTransferDecisionRecovery(); const old = recovery.start(record(), 'approve', owner)!;
    const newer = { ...owner, generation: 4 }; const replacement = recovery.start(record(), 'reject', newer)!;
    expect(recovery.finish(old, outcome('approved'))).toBe(false); expect(recovery.isCurrent(replacement, newer)).toBe(true);
    expect(recovery.get(owner)).toBeNull(); expect(recovery.get(newer)?.phase).toBe('inFlight');
    expect(recovery.finish(replacement, outcome('rejected'))).toBe(true);
  });
  it('masks private results without losing original recovery, and an authorized Pending read restores uncertainty', () => {
    const recovery = createTransferDecisionRecovery(); const token = recovery.start(record(), 'reject', owner)!;
    recovery.finish(token, undefined, true); expect(recovery.get(owner)).toBeNull(); expect(recovery.claim(owner)).toBeNull();
    const read = recovery.claim(owner, true)!; expect(read.attempt.original.id).toBe(wire.id);
    recovery.finish(read, record()); expect(recovery.get(owner)?.phase).toBe('uncertain');
  });
  it.each([{ reference: 'different' }, { items: [{ ...record().items[0], quantity: 1n }] }, { decision_location_id: 2 }])
   ('never settles or clears a mismatched recovery result %s', patch => {
      const recovery = createTransferDecisionRecovery(); const token = recovery.start(record(), 'approve', owner)!;
      expect(() => recovery.finish(token, { ...outcome('approved'), ...patch } as TransferRecord)).toThrow();
      expect(recovery.isCurrent(token, owner)).toBe(true); expect(recovery.get(owner)?.phase).toBe('inFlight');
      recovery.finish(token); expect(recovery.get(owner)?.phase).toBe('uncertain');
    });
  it('returns the original opaque token even if a listener synchronously replaces the owner', () => {
    const recovery = createTransferDecisionRecovery(); const newer = { ...owner, generation: 4 }; let replaced = false;
    recovery.subscribe(() => {
      if (!replaced) { replaced = true; recovery.start(record(), 'reject', newer); }
    });
    const old = recovery.start(record(), 'approve', owner)!;
    expect(old.attempt.owner).toEqual(owner); expect(recovery.isCurrent(old, owner)).toBe(false);
    expect(recovery.finish(old, outcome('approved'))).toBe(false);
    expect(recovery.get(newer)).toMatchObject({ phase: 'inFlight', action: 'reject' });
  });
  it('a failing listener cannot prevent other observers or leave a transport locked', () => {
    const recovery = createTransferDecisionRecovery(); const observer = vi.fn();
    recovery.subscribe(() => { throw new Error('detached view'); }); recovery.subscribe(observer);
    const token = recovery.start(record(), 'reject', owner)!;
    expect(observer).toHaveBeenCalledTimes(1); recovery.finish(token);
    expect(observer).toHaveBeenCalledTimes(2); expect(recovery.claim(owner)).not.toBeNull();
  });
  it('listeners observe transitions and detach without creating transports', () => {
    const recovery = createTransferDecisionRecovery(); const listener = vi.fn(); const detach = recovery.subscribe(listener);
    const token = recovery.start(record(), 'approve', owner)!;
    expect(listener).toHaveBeenCalledTimes(1); recovery.finish(token); expect(listener).toHaveBeenCalledTimes(2);
    detach(); recovery.start(record(), 'approve', owner); expect(listener).toHaveBeenCalledTimes(2);
    expect(matchesDecisionRecord(record(), outcome('rejected'))).toBe(true);
  });
});
