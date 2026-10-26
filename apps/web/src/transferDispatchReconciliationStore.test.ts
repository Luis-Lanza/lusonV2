import { describe, expect, it, vi } from 'vitest';
import { createTransferDispatchReconciliationStore } from './transferDispatchReconciliationStore';
import { DispatchReconciliationAPIError } from './transferDispatchReconciliationAPI';
import { appliedSnapshot, decisionKey, fixture, operationKey, owner, wire } from './transferDispatchReconciliationStoreFixtures';
const unknown = () => new DispatchReconciliationAPIError('network', null, true);
function setup(pending = false, location = 1) {
  const f = fixture(pending); const key = vi.fn((): string => pending ? decisionKey : operationKey); const store = createTransferDispatchReconciliationStore({ operationKey: key });
  const who = { ...owner, location }; store.synchronize(who); store.select(who, f.record);
  const read = store.beginRead(who, f.record)!; store.finishRead(read, f.decode());
  return { ...f, store, key, who, state: () => store.state(who, f.record) };
}
function prepare(f: ReturnType<typeof setup>, action: 'propose' | 'accept' | 'reject' = 'propose') {
  expect(f.store.begin(f.who, f.record, 1, action)).toBe(true);
  f.store.setReason(f.who, f.record, ' verified '); expect(f.store.review(f.who, f.record)).toBe(true);
  return f.store.confirm(f.who, f.record)!;
}
describe('private coordinator store', () => {
  it.each(['decision_conflict', 'insufficient_stock', 'retry_conflict', 'invalid_request'] as const)('fresh definitive %s preserves refusal evidence but permits valid counterpart rejection after refresh', code => {
    const f = setup(true, 2); const original = prepare(f, 'accept');
    const failure = new DispatchReconciliationAPIError(code, code === 'invalid_request' ? 400 : 409, false);
    f.store.failWrite(original, failure);
    expect(f.state().error?.code).toBe(code); expect(f.state().attempts[0].result).toBeNull(); expect(f.state().busy).toBe(false);
    f.raw.lines[0].count_generation = '1';
    expect(f.store.finishRead(f.store.beginRead(f.who, f.record)!, f.decode())).toEqual([]);
    // The generation changed, not the pending proposal. Only counterpart rejection remains valid.
    expect(f.store.begin(f.who, f.record, 1, 'accept')).toBe(false);
    expect(f.store.begin(f.who, f.record, 1, 'reject')).toBe(true);
    expect(f.state().attempts[0]).toMatchObject({ phase: 'failed', priorUncertainty: false, result: null, failure: { code, status: failure.status } });
    expect(f.state().attempts[0].payload).toBe(original.attempt.payload); expect(f.state().error?.code).toBe(code);
    expect(f.store.retry(f.who, f.record, 1)).toBeNull(); expect(f.key).toHaveBeenCalledTimes(1);
    f.key.mockReturnValue('dispatch-rejection-0001'); f.store.setReason(f.who, f.record, 'reject stale proposal');
    expect(f.store.review(f.who, f.record)).toBe(true); const reject = f.store.confirm(f.who, f.record)!;
    expect(reject.attempt.action).toBe('reject'); expect(reject.attempt.payload).toEqual({ variant_id: 1, operation_key: 'dispatch-rejection-0001', expected_revision: 1n, reason: 'reject stale proposal' });
    expect(f.key).toHaveBeenCalledTimes(2); expect(f.state().attempts[0].result).toBeNull();
  });
  it.each(['network', 'aborted', 'release'] as const)('%s uncertainty survives a later definitive retry refusal until exact durable proof', first => {
    const f = setup(true, 2); const original = prepare(f, 'accept');
    if (first === 'release') f.store.release(original);
    else f.store.failWrite(original, new DispatchReconciliationAPIError(first, null, true));
    const retry = f.store.retry(f.who, f.record, 1)!;
    f.store.failWrite(retry, new DispatchReconciliationAPIError('decision_conflict', 409, false));
    f.store.release(original); f.store.release(retry);
    f.raw.lines[0].count_generation = '1'; expect(f.store.finishRead(f.store.beginRead(f.who, f.record)!, f.decode())).toEqual([]);
    const retained = f.state().attempts[0];
    expect(retained).toMatchObject({ phase: 'uncertain', priorUncertainty: true, result: null, failure: { code: 'decision_conflict', status: 409 } });
    expect(retained.payload).toBe(original.attempt.payload); expect(retained.original).toBe(original.attempt.original);
    expect(f.store.begin(f.who, f.record, 1, 'reject')).toBe(false); expect(f.store.begin(f.who, f.record, 2, 'propose')).toBe(false);
    expect(f.key).toHaveBeenCalledTimes(1); expect(f.state().busy).toBe(false);
    const durable = appliedSnapshot(); const later = { ...durable, lines: durable.lines.map(l => l.variant_id !== 1 ? l : { ...l, count_generation: 1n }) };
    expect(f.store.finishRead(f.store.beginRead(f.who, f.record)!, later)).toEqual([durable.operations[1]]);
    expect(f.state().attempts[0]).toMatchObject({ phase: 'confirmed', priorUncertainty: true, result: durable.operations[1], failure: null });
  });
  it.each([
    ['wrong status', Object.assign(new DispatchReconciliationAPIError('decision_conflict', 409, false), { status: 400 })],
    ['unknown code', Object.assign(new DispatchReconciliationAPIError('decision_conflict', 409, false), { code: 'private injected text' })],
    ['nonstring code', Object.assign(new DispatchReconciliationAPIError('decision_conflict', 409, false), { code: {} })],
    ['nonboolean uncertainty', Object.assign(new DispatchReconciliationAPIError('decision_conflict', 409, false), { uncertainReconciliation: 0 })],
    ['plain object', { code: 'decision_conflict', status: 409, uncertainReconciliation: false }],
    ['explicit unknown', new DispatchReconciliationAPIError('decision_conflict', 409, true)],
    ['service unavailable', new DispatchReconciliationAPIError('service_unavailable', 503, false)],
    ['network without flag', new DispatchReconciliationAPIError('network', null, false)],
    ['malformed response', new DispatchReconciliationAPIError('invalid_response', 409, false)],
  ])('does not unlock fresh work for %s', (_label, failure) => {
    const f = setup(true, 2); const ticket = prepare(f, 'accept'); f.store.failWrite(ticket, failure);
    expect(f.state().attempts[0]).toMatchObject({ phase: 'uncertain', priorUncertainty: true, result: null });
    expect(f.store.begin(f.who, f.record, 1, 'reject')).toBe(false); expect(f.key).toHaveBeenCalledTimes(1);
    expect(f.state().attempts[0].payload).toBe(ticket.attempt.payload); expect(f.state().error?.code).not.toBe('private injected text');
    if (['wrong status', 'unknown code', 'nonstring code', 'nonboolean uncertainty', 'plain object'].includes(_label as string)) {
      expect(f.state().error).toMatchObject({ code: 'invalid_response', status: null, uncertainReconciliation: true });
    }
  });
  it('cannot confirm a captured review while a newer selected-line read is unresolved', () => {
    const f = setup(); f.store.begin(f.who, f.record, 1, 'propose'); f.store.setReason(f.who, f.record, 'private'); f.store.review(f.who, f.record);
    const read = f.store.beginRead(f.who, f.record)!;
    expect(f.store.confirm(f.who, f.record)).toBeNull(); expect(f.state().attempts).toEqual([]);
    f.raw.lines[0].count_generation = '1'; f.store.finishRead(read, f.decode());
    expect(f.state().review).toBeNull(); expect(f.store.confirm(f.who, f.record)).toBeNull(); expect(f.key).toHaveBeenCalledTimes(1);
  });
  it('successful POST retires pre-write GET and requires fresh exact history before new work', () => {
    const f = setup(); const token = prepare(f); const beforeWrite = f.store.beginRead(f.who, f.record)!;
    expect(f.store.finishWrite(token, fixture(true).decode().operations[0])?.operation_key).toBe(operationKey);
    expect(f.state().snapshot).toBeNull(); expect(f.store.begin(f.who, f.record, 2, 'propose')).toBe(false);
    expect(f.store.finishRead(beforeWrite, f.decode())).toEqual([]); expect(f.state().snapshot).toBeNull();
    const stale = f.store.beginRead(f.who, f.record)!;
    expect(() => f.store.finishRead(stale, f.decode())).toThrow(); f.store.failRead(stale, new Error());
    expect(f.state().attempts[0].phase).toBe('confirmed'); expect(f.state().snapshot).toBeNull();
    f.store.finishRead(f.store.beginRead(f.who, f.record)!, fixture(true).decode()); expect(f.state().snapshot?.lines[0].workflow_revision).toBe(1n);
    expect(f.key).toHaveBeenCalledTimes(1);
  });
  it('captures Q=A and immutable receipt, single flight and no cached credentials', () => {
    const f = setup(); const token = prepare(f);
    expect(token.attempt.payload).toEqual({ variant_id: 1, operation_key: operationKey, expected_revision: 0n, reason: ' verified ', dispatch_quantity: 7n });
    expect(f.store.confirm(f.who, f.record)).toBeNull(); expect(f.store.begin(f.who, f.record, 1, 'propose')).toBe(false);
    expect(f.store.retry(f.who, f.record, 1)).toBeNull(); expect(f.key).toHaveBeenCalledTimes(1);
    expect(wire(token)).not.toMatch(/csrf|session|token/); expect(Object.isFrozen(token.attempt.original)).toBe(true);
    if (token.attempt.original.status !== 'received') throw new Error();
    expect(Object.isFrozen(token.attempt.original.receipt.items[0])).toBe(true);
    expect(f.state().busy).toBe(true);
  });
  it('unknown survives close/reopen and changed count; retry preserves exact intent', () => {
    const f = setup(); const token = prepare(f); f.store.release(token);
    f.store.select(f.who, null); expect(f.state().attempts).toEqual([]);
    f.store.select(f.who, { ...f.record });
    Object.assign(f.raw.lines[0], { count_generation: '2', count_applied_revision: '1', effective_actual: '4', effective_credit: '4' });
    f.store.finishRead(f.store.beginRead(f.who, f.record)!, f.decode());
    expect(f.state().attempts[0].phase).toBe('uncertain');
    expect(f.store.begin(f.who, f.record, 1, 'propose')).toBe(false);
    const retry = f.store.retry(f.who, f.record, 1)!;
    expect(retry.attempt.payload).toEqual(token.attempt.payload); expect(retry.attempt.original).toBe(token.attempt.original);
    f.store.release(token); expect(f.state().busy).toBe(true); expect(f.key).toHaveBeenCalledTimes(1);
  });
  it('missing GET never means rollback; mismatch conflicts; exact operation confirms only original', () => {
    const f = setup(); const token = prepare(f); f.store.failWrite(token, unknown());
    f.store.finishRead(f.store.beginRead(f.who, f.record)!, f.decode()); expect(f.state().attempts[0].phase).toBe('uncertain');
    const history = fixture(true); history.raw.operations[0].reason = 'other'; history.raw.lines[0].proposals[0].reason = 'other';
    f.store.finishRead(f.store.beginRead(f.who, f.record)!, history.decode()); expect(f.state().attempts[0].phase).toBe('conflict');
    const exact = fixture(true); f.store.finishRead(f.store.beginRead(f.who, f.record)!, exact.decode());
    expect(f.state().attempts[0].phase).toBe('confirmed'); expect(f.state().attempts[0].result?.reason).toBe(' verified ');
    expect(f.store.retry(f.who, f.record, 1)).toBeNull(); expect(f.key).toHaveBeenCalledTimes(1);
  });
  it.each(['account', 'location', 'epoch', 'generation'] as const)('retires private memory for changed %s; late callbacks cannot replace another flight', field => {
    const f = setup(); const old = prepare(f); const next = { ...f.who, [field]: f.who[field] + 1 };
    f.store.synchronize(next); expect(f.state().snapshot).toBeNull(); expect(f.state().draft).toBeNull(); expect(f.state().attempts).toEqual([]);
    f.store.select(next, f.record); f.store.finishWrite(old, f.op); f.store.failWrite(old, unknown()); f.store.release(old);
    expect(f.store.state(next, f.record).attempts).toEqual([]);
    f.store.synchronize(f.who); f.store.select(f.who, f.record); expect(f.state().attempts).toEqual([]);
  });
  it('superseded read tickets cannot overwrite snapshot, reason or fresh review', () => {
    const f = setup(); f.store.begin(f.who, f.record, 1, 'propose'); f.store.setReason(f.who, f.record, 'private'); f.store.review(f.who, f.record);
    const a = f.store.beginRead(f.who, f.record)!; const b = f.store.beginRead(f.who, f.record)!;
    f.raw.lines[1].count_generation = '1'; f.store.finishRead(b, f.decode());
    const current = f.state().snapshot; expect(f.state().review).not.toBeNull();
    expect(f.store.finishRead(a, fixture(true).decode())).toEqual([]); expect(f.state().snapshot).toBe(current);
    expect(f.state().draft?.reason).toBe('private');
  });
  it.each(['count_generation', 'restitution_generation'] as const)('%s alone retires review and prevents confirm', field => {
    const f = setup(); f.store.begin(f.who, f.record, 1, 'propose'); f.store.setReason(f.who, f.record, 'private'); f.store.review(f.who, f.record);
    f.raw.lines[0][field] = '1'; f.store.finishRead(f.store.beginRead(f.who, f.record)!, f.decode());
    expect(f.state().review).toBeNull(); expect(f.store.confirm(f.who, f.record)).toBeNull(); expect(f.state().attempts).toEqual([]);
  });
  it('confirms counterpart acceptance and permits a later fresh agreement after effective count changes', () => {
    const f = setup(true, 2); const token = prepare(f, 'accept'); const applied = appliedSnapshot();
    expect(token.attempt.payload.operation_key).toBe(decisionKey);
    expect(f.store.finishWrite(token, applied.operations[1])?.action).toBe('accept');
    f.store.finishRead(f.store.beginRead(f.who, f.record)!, applied); expect(f.state().attempts[0].phase).toBe('confirmed');
    expect(f.store.begin(f.who, f.record, 1, 'propose')).toBe(false);
    const changed = { ...applied, lines: applied.lines.map(l => l.variant_id !== 1 ? l : { ...l, count_generation: 2n, count_applied_revision: 1n, effective_actual: 6n, effective_credit: 6n }) };
    f.store.finishRead(f.store.beginRead(f.who, f.record)!, changed);
    f.key.mockReturnValue('dispatch-later-00001'); expect(f.store.begin(f.who, f.record, 1, 'propose')).toBe(true);
    f.store.setReason(f.who, f.record, 'later agreement'); expect(f.store.review(f.who, f.record)).toBe(true);
    expect(f.state().review?.preview).toEqual({ dispatch_quantity: 6n, source_delta: 1n, destination_delta: 0n });
    const later = f.store.confirm(f.who, f.record)!;
    expect(later.attempt.payload).toEqual({ variant_id: 1, operation_key: 'dispatch-later-00001', expected_revision: 1n, reason: 'later agreement', dispatch_quantity: 6n });
    expect(f.key).toHaveBeenCalledTimes(2);
  });
  it('allows stale counterpart reject independently of accept-only pins and exclusion', () => {
    const f = setup(true, 2); Object.assign(f.raw.lines[0], { count_generation: '2', count_applied_revision: '1', effective_actual: '4', effective_credit: '4', applied_retained_quantity: '1', restitution_generation: '2' });
    f.store.finishRead(f.store.beginRead(f.who, f.record)!, f.decode());
    expect(f.store.begin(f.who, f.record, 1, 'accept')).toBe(false); expect(prepare(f, 'reject').attempt.action).toBe('reject');
  });
  it('cannot allocate another intent on variant/target switch while an owned intent is unresolved', () => {
    const f = setup(); const token = prepare(f); f.store.release(token);
    expect(f.store.begin(f.who, f.record, 2, 'propose')).toBe(false);
    const other = fixture(); const record = { ...other.record, id: '124', reference: 'TR-124' };
    f.store.select(f.who, record); f.store.finishRead(f.store.beginRead(f.who, record)!, { ...other.decode(), request_id: 124n });
    expect(f.store.begin(f.who, record, 1, 'propose')).toBe(false);
    f.store.select(f.who, f.record); expect(f.store.retry(f.who, f.record, 1)?.attempt.payload).toEqual(token.attempt.payload);
    expect(f.key).toHaveBeenCalledTimes(1);
  });
  it('denies third actor, wrong target, variant and changed immutable receipt without losing old intent', () => {
    const third = setup(false, 3); expect(third.store.begin(third.who, third.record, 1, 'propose')).toBe(false); expect(third.key).not.toHaveBeenCalled();
    const f = setup(); const token = prepare(f); f.store.release(token);
    expect(f.store.retry(f.who, f.record, 2)).toBeNull();
    const other = { ...f.record, id: '124', reference: 'TR-124' }; f.store.select(f.who, other); expect(f.store.retry(f.who, other, 1)).toBeNull();
    const altered = fixture(); if (altered.record.status !== 'received') throw new Error();
    Object.assign(altered.record.receipt.items[0], { actual_quantity: 8n }); Object.assign(altered.record.receipt.exceptions[0], { quantity: 3n });
    f.store.select(f.who, altered.record); expect(f.store.retry(f.who, altered.record, 1)).toBeNull();
    f.store.select(f.who, f.record); expect(f.store.retry(f.who, f.record, 1)?.attempt.payload).toEqual(token.attempt.payload); expect(f.key).toHaveBeenCalledTimes(1);
  });
  it.each([401, 403, 404])('masks on private %s, explicit read alone restores; rejects malformed injected evidence', status => {
    const f = setup(); const token = prepare(f); f.store.failWrite(token, new DispatchReconciliationAPIError(status === 401 ? 'unauthenticated' : status === 403 ? 'forbidden' : 'not_found', status));
    expect(f.state().snapshot).toBeNull(); expect(f.state().draft).toBeNull(); expect(f.state().attempts).toEqual([]);
    f.store.finishRead(f.store.beginRead(f.who, f.record)!, f.decode()); expect(f.state().masked).toBe(true);
    expect(f.store.retry(f.who, f.record, 1)).toBeNull();
    f.store.finishRead(f.store.beginRead(f.who, f.record, true)!, f.decode()); expect(f.state().attempts[0].phase).toBe('uncertain');
    const retry = f.store.retry(f.who, f.record, 1)!;
    expect(() => f.store.finishWrite(retry, { ...f.op, reason: 'wrong' })).toThrow(); expect(f.state().busy).toBe(true);
    expect(() => f.store.finishRead(f.store.beginRead(f.who, f.record)!, { ...f.decode(), request_id: 123 })).toThrow();
  });
});
