import { describe, expect, it } from 'vitest';
import { TransferAPIError } from './transferAPI';
import { captureCountCorrections, countRetryPayload, createTransferCountCorrectionRecovery } from './transferCountCorrectionRecovery';
import type { CountOperation } from './transferCountCorrectionModel';
const owner = { account: 2, location: 2, epoch: 1, generation: 1 };
const id = '9007199254740993';
const input = { variant_id: 201, operation_key: 'stable_count_key_01', expected_revision: '0', actual_quantity: '5', reason: ' original reason ' };
const network = new TransferAPIError('network', null, false, false, false, false, false, true);
function operation(action: 'propose' | 'accept' | 'reject' = 'propose'): CountOperation {
  return { operation_key: input.operation_key, request_id: BigInt(id), variant_id: 201, actor_location_id: 2,
    action, expected_revision: action === 'propose' ? 0n : 1n, actual_quantity: action === 'propose' ? 5n : null,
    reason: input.reason, revision: 1n, recorded_at: '2026-04-02T00:00:00Z' };
}
function snapshot(head = 0n, operations: CountOperation[] = []) {
  return captureCountCorrections({ request_id: BigInt(id), operations, lines: [{ variant_id: 201, expected_quantity: 6n,
    actual_quantity: 6n, available_quantity: 6n, workflow_revision: head, applied_revision: 0n, effective_actual: 6n,
    effective_credit: 6n, proposals: [] }] });
}
it('captures independent immutable attempts for different variant lines', () => {
  const r = createTransferCountCorrectionRecovery();
  const a = r.start(id, 'propose', input, owner)!;
  const b = r.start(id, 'propose', { ...input, variant_id: 202 }, owner)!;
  expect(a).not.toBeNull(); expect(b).not.toBeNull();
  r.fail(a, network); r.release(b);
  expect(r.get(owner, BigInt(id)).map(a => a.phase)).toEqual(['uncertain', 'uncertain']);
  expect(r.get(owner, BigInt(id))[0].payload.expected_revision).toBe(0n);
  expect(Object.isFrozen(a.attempt.payload)).toBe(true);
  expect(Object.isFrozen(a.attempt.owner)).toBe(true);
});
it('captures defensive full payload and retries original decimal evidence', () => {
  const r = createTransferCountCorrectionRecovery(); const form = { ...input, actual_quantity: '9223372036854775807' };
  const who = { ...owner }; const a = r.start(id, 'propose', form, who)!;
  form.reason = 'replacement'; form.expected_revision = '5'; who.location = 1;
  r.fail(a, network); const retry = r.claim(owner, BigInt(id), 201)!;
  expect(countRetryPayload(retry.attempt)).toEqual({ ...input, actual_quantity: '9223372036854775807' });
  expect(retry.attempt.owner.location).toBe(2);
  expect(r.start(id, 'propose', { ...input, operation_key: 'fresh_count_key_02' }, owner)).toBeNull();
});
it('obsolete tokens cannot settle or release a replacement flight', () => {
  const r = createTransferCountCorrectionRecovery(); const a = r.start(id, 'propose', input, owner)!;
  r.release(a); const b = r.claim(owner, BigInt(id), 201)!;
  expect(r.finish(a, operation())).toBeNull(); r.release(a); r.fail(a, network);
  expect(r.isCurrent(b, owner)).toBe(true);
  expect(r.finish(b, operation())).toEqual(operation()); expect(r.finish(b, operation())).toBeNull();
});
describe('authority privacy', () => {
  it.each(['account', 'location', 'epoch', 'generation'] as const)('clears on %s changes, including return to old authority', field => {
    const r = createTransferCountCorrectionRecovery(); const a = r.start(id, 'propose', input, owner)!;
    const next = { ...owner, [field]: owner[field] + 1 };
    expect(r.get(next, BigInt(id))).toEqual([]); expect(r.get(owner, BigInt(id))).toEqual([]);
    expect(r.finish(a, operation())).toBeNull();
  });
  it('clears when authority becomes unavailable', () => {
    const r = createTransferCountCorrectionRecovery(); r.start(id, 'propose', input, owner);
    expect(r.get(null, BigInt(id))).toEqual([]); expect(r.get(owner, BigInt(id))).toEqual([]);
  });
});
it.each(['propose', 'accept', 'reject'] as const)('confirms historical %s independently of current applied revision', action => {
  const r = createTransferCountCorrectionRecovery();
  const payload = action === 'propose' ? input : { variant_id: 201, operation_key: input.operation_key, expected_revision: '1', reason: input.reason };
  const a = r.start(id, action, payload, owner)!; r.fail(a, network);
  const history = snapshot(9n, [operation(action)]);
  expect(r.observe(owner, history)).toEqual([operation(action)]);
  expect(r.get(owner, BigInt(id))[0].phase).toBe('confirmed');
  expect(r.observe(owner, history)).toEqual([]);
});
it('missing operations distinguish unchanged, advanced and dirty workflow heads without replacement', () => {
  const r = createTransferCountCorrectionRecovery(); const a = r.start(id, 'propose', input, owner)!; r.fail(a, network);
  r.observe(owner, snapshot()); expect(r.get(owner, BigInt(id))[0].phase).toBe('uncertain');
  r.observe(owner, snapshot(2n), false, true); expect(r.get(owner, BigInt(id))[0].phase).toBe('uncertain');
  r.observe(owner, snapshot(2n)); expect(r.get(owner, BigInt(id))[0].phase).toBe('conflict');
  expect(r.start(id, 'propose', { ...input, operation_key: 'replacement_key_01' }, owner)).toBeNull();
});
it.each([400, 409])('initial %s is definite but cannot erase earlier uncertainty', status => {
  const r = createTransferCountCorrectionRecovery(); const a = r.start(id, 'propose', input, owner)!;
  const failure = new TransferAPIError(status === 400 ? 'invalid_request' : 'decision_conflict', status);
  r.fail(a, failure); expect(r.get(owner, BigInt(id))[0].phase).toBe('failed');
  const b = r.start(id, 'propose', { ...input, operation_key: 'fresh_count_key_02' }, owner)!;
  r.fail(b, network); const retry = r.claim(owner, BigInt(id), 201)!;
  r.fail(retry, failure); expect(r.get(owner, BigInt(id))[0].phase).toBe('uncertain');
  expect(r.get(owner, BigInt(id))[0].priorUncertainty).toBe(true);
});
it.each([403, 404])('masks %s until explicit authorized history, never passive reads', status => {
  const r = createTransferCountCorrectionRecovery(); const a = r.start(id, 'propose', input, owner)!;
  r.fail(a, new TransferAPIError(status === 403 ? 'forbidden' : 'not_found', status)); r.mask(owner, BigInt(id));
  expect(r.get(owner, BigInt(id))).toEqual([]); expect(r.claim(owner, BigInt(id), 201)).toBeNull();
  expect(r.observe(owner, snapshot(1n, [operation()]))).toEqual([]);
  expect(r.observe(owner, snapshot(1n, [operation()]), true)).toEqual([operation()]);
  expect(r.get(owner, BigInt(id))[0].phase).toBe('confirmed');
});
it.each(['request_id', 'actor_location_id', 'reason', 'expected_revision', 'actual_quantity', 'operation_key', 'variant_id', 'action'] as const)('rejects mismatched injected operation %s without losing flight', field => {
  const r = createTransferCountCorrectionRecovery(); const a = r.start(id, 'propose', input, owner)!;
  const bad = { ...operation(), [field]: field === 'request_id' ? 1n : field === 'actor_location_id' ? 1 : field === 'variant_id' ? 202
    : field === 'expected_revision' ? 1n : field === 'actual_quantity' ? 4n : field === 'action' ? 'reject' : 'different_key_01' };
  expect(() => r.finish(a, bad)).toThrow(); expect(r.isCurrent(a, owner)).toBe(true);
});
it('retains an immutable defensive failure without transport-local properties', () => {
  const r = createTransferCountCorrectionRecovery(); const a = r.start(id, 'propose', input, owner)!;
  const error = Object.assign(new TransferAPIError('network', null), { privateTransportTag: 'not retained' });
  r.fail(a, error);
  const retained = r.get(owner, BigInt(id))[0].failure!;
  expect(retained).not.toBe(error); expect(Object.isFrozen(retained)).toBe(true);
  expect(retained).not.toHaveProperty('privateTransportTag');
});
it('rejects unsafe numeric injected bigint fields and unknown response fields', () => {
  const r = createTransferCountCorrectionRecovery(); const a = r.start(id, 'propose', input, owner)!;
  expect(() => r.finish(a, { ...operation(), request_id: Number(id) })).toThrow();
  expect(() => r.finish(a, { ...operation(), extra: true })).toThrow();
});
