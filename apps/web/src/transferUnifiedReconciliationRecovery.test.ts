import { expect, it } from 'vitest';
import { unifiedAgreement, unifiedFixture, wire } from './transferUnifiedReconciliationFixtures';
import { parseUnifiedReconciliations } from './transferUnifiedReconciliationModel';
import { captureUnifiedReconciliationAttempt, resolveUnifiedReconciliationAttempt } from './transferUnifiedReconciliationRecovery';

it('captures immutable exact proposal intent and resolves only matching durable operation evidence', () => {
  const f = unifiedAgreement('pending');
  const input = { variant_id: 1, operation_key: 'unified-proposal-0001', expected_revision: '0',
    dispatch_quantity: '4', arrival_quantity: '3', retained_quantity: '1', retained_at_origin: true, reason: ' verified ' };
  const a = captureUnifiedReconciliationAttempt(f.record, 1, 'propose', input);
  input.reason = 'changed';
  expect(a.payload.reason).toBe(' verified ');
  expect(Object.isFrozen(a.original)).toBe(true);
  expect(Object.isFrozen(a.original.status === 'received' && a.original.receipt.items)).toBe(true);
  expect(Object.isFrozen(a.payload)).toBe(true);
  const empty = unifiedFixture();
  expect(resolveUnifiedReconciliationAttempt(a, parseUnifiedReconciliations(wire(empty.raw), empty.record))).toEqual({ status: 'unresolved', operation: null });
  const snapshot = parseUnifiedReconciliations(wire(f.raw), f.record);
  expect(resolveUnifiedReconciliationAttempt(a, snapshot)).toEqual({ status: 'confirmed', operation: snapshot.operations[0] });
  const other = captureUnifiedReconciliationAttempt(f.record, 1, 'propose', { ...input, reason: 'different' });
  expect(resolveUnifiedReconciliationAttempt(other, snapshot)).toEqual({ status: 'conflict', operation: null });
});
it('rejects nonparticipants, unexpected variants and invalid origin attestation before intent exists', () => {
  const f = unifiedFixture();
  const p = { variant_id: 1, operation_key: 'unified-proposal-0001', expected_revision: '0',
    dispatch_quantity: '4', arrival_quantity: '3', retained_quantity: '1', retained_at_origin: true, reason: 'verified' };
  for (const [actor, input] of [[3, p], [2, p], [1, { ...p, variant_id: 999 }],
    [1, { ...p, retained_quantity: '2' }], [1, { ...p, retained_at_origin: false }]] as const) {
    expect(() => captureUnifiedReconciliationAttempt(f.record, actor, 'propose', input)).toThrow();
  }
});
