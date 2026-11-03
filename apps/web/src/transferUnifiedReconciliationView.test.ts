import { describe, expect, it } from 'vitest';
import { parseUnifiedReconciliations } from './transferUnifiedReconciliationModel';
import { unifiedAgreement, unifiedFixture, wire } from './transferUnifiedReconciliationFixtures';
import { projectUnifiedReceived, reconciliationEffects, reconciliationCurrentRows } from './transferUnifiedReconciliationView';

describe('coordinated received projection states', () => {
  it('reports a first read in flight as loading, never as unavailable', () => {
    const f = unifiedAgreement();
    expect(projectUnifiedReceived(f.record, null, true, null, false)).toEqual({ status: 'loading' });
    // Settled without evidence is still unavailability: loading must not mask it.
    expect(projectUnifiedReceived(f.record, null, false, null, false)).toEqual({ status: 'unavailable', reason: 'absent' });
  });
  it('keeps masked and failed reads unavailable even while busy', () => {
    const f = unifiedAgreement();
    expect(projectUnifiedReceived(f.record, null, true, null, true)).toEqual({ status: 'unavailable', reason: 'masked' });
    expect(projectUnifiedReceived(f.record, null, true, new Error('offline'), false)).toEqual({ status: 'unavailable', reason: 'error' });
  });
  it('keeps retained evidence updating instead of dropping it during a refresh', () => {
    const f = unifiedAgreement();
    const snapshot = parseUnifiedReconciliations(wire(f.raw), f.record);
    expect(projectUnifiedReceived(f.record, snapshot, true, null, false).status).toBe('updating');
    expect(projectUnifiedReceived(f.record, snapshot, false, null, false).status).toBe('available');
  });
});

describe('unified reconciliation presentation rules', () => {
  it('projects authoritative Current without using nested Legacy as current', () => {
    const f = unifiedAgreement();
    const snapshot = parseUnifiedReconciliations(wire(f.raw), f.record);
    expect(reconciliationCurrentRows(snapshot)![0]).toMatchObject({ variant_id: 1,
      dispatch: 4n, actual: 3n, credit: 3n, source: 'unified' });
    expect(snapshot.legacy.count.lines[0].effective_actual).toBe(7n);
    expect(reconciliationCurrentRows(null)).toBeNull();
  });
  it.each(['pending', 'rejected'] as const)('does not turn a %s proposal into current', state => {
    const f = unifiedAgreement(state);
    const snapshot = parseUnifiedReconciliations(wire(f.raw), f.record);
    expect(reconciliationCurrentRows(snapshot)![0]).toMatchObject({ dispatch: 5n, actual: 7n,
      credit: 5n, source: 'legacy' });
  });
  it('keeps an earlier accepted Current while a later proposal is pending or rejected', () => {
    const f = unifiedAgreement();
    const snapshot = parseUnifiedReconciliations(wire(f.raw), f.record);
    // The presentation consumes only validated Current, never the latest proposal.
    const pending = { ...snapshot.lines[0].proposals[0], state: 'pending' as const,
      dispatch_quantity: 0n, arrival_quantity: 0n, retained_quantity: 0n };
    for (const state of ['pending', 'rejected'] as const) {
      const later = { ...snapshot, lines: [{ ...snapshot.lines[0], proposals: [
        ...snapshot.lines[0].proposals, { ...pending, state } ] }, ...snapshot.lines.slice(1)] };
      expect(reconciliationCurrentRows(later)).toEqual(reconciliationCurrentRows(snapshot));
    }
  });
  it('calculates the approved 10/9/8/1 effects without inventing loss closure', () => {
    expect(reconciliationEffects(10n, 10n, 8n, '9', '8', '1')).toEqual({ dispatch: 9n,
      arrival: 8n, retained: 1n, sourceDelta: 1n, destinationDelta: 0n,
      sourceDebit: 9n, destinationCredit: 8n, originUnknown: 0n, transitUnknown: 1n, excess: 0n });
    expect(reconciliationEffects(10n, 9n, 8n, '9', '8', '1')?.sourceDelta).toBe(0n);
  });
  it.each([
    ['12', '13', '0', 0n, 0n, 1n],
    ['9', '8', '0', 1n, 1n, 0n],
    ['8', '7', '1', 1n, 1n, 0n],
    ['0', '0', '0', 10n, 0n, 0n],
  ] as const)('allows dispatch %s arrival %s retention %s', (d, a, r, originUnknown, transitUnknown, excess) => {
    expect(reconciliationEffects(10n, 10n, 8n, d, a, r)).toMatchObject({ originUnknown, transitUnknown, excess });
  });
  it.each([['12', '8', '1'], ['9', '8', '2'], ['01', '8', '0'],
    ['1e2', '8', '0'], ['1.5', '8', '0'], ['-1', '8', '0'],
    ['', '8', '0'], ['9223372036854775808', '8', '0']])('rejects invalid facts %s/%s/%s', (d, a, r) => {
    expect(reconciliationEffects(10n, 10n, 8n, d, a, r)).toBeNull();
  });
  it('preserves exact quantities beyond Number precision', () => {
    const f = unifiedFixture();
    expect(f.record.status).toBe('received');
    expect(reconciliationEffects(9007199254740993n, 9007199254740993n, 0n,
      '9007199254740992', '0', '1')?.sourceDelta).toBe(1n);
  });
});
