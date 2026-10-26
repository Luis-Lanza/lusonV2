import { describe, expect, it } from 'vitest';
import { normalizeCountDecision, normalizeCountProposal, parseCountCorrections, parseCountOperation } from './transferCountCorrectionModel';

const operation = () => ({ operation_key: 'count_proposal_0001', request_id: '9007199254740993', variant_id: 201,
  actor_location_id: 1, action: 'propose', expected_revision: '9007199254740993', actual_quantity: '9223372036854775807',
  reason: '  physical recount  ', revision: '9007199254740994', recorded_at: '2026-01-02T12:00:00.000000001Z' });

const proposal = (state = 'pending') => ({ revision: '1', operation_key: 'count_proposal_0001',
  initiator_location_id: 1, actual_quantity: '0', base_revision: '0', base_credit: '9223372036854775807',
  reason: 'recount', recorded_at: '2026-01-02T12:00:00Z', state,
  decision: state === 'applied' || state === 'rejected' ? { operation_key: 'count_decision_0001', actor_location_id: 2,
    accepted: state === 'applied', reason: 'verified', recorded_at: '2026-01-02T12:01:00Z' } : null,
  application: state === 'applied' ? { effective_credit: '0', delta: '-9223372036854775807', recorded_at: '2026-01-02T12:01:00Z' } : null });
const line = () => ({ variant_id: 201, expected_quantity: '9223372036854775807', effective_dispatch: '9223372036854775807', reconciliation_revision: '0', actual_quantity: '9223372036854775807',
  available_quantity: '9223372036854775807', workflow_revision: '4', applied_revision: '1',
  effective_actual: '0', effective_credit: '0', proposals: ['applied', 'superseded', 'rejected', 'pending'].map(proposal) });
const snapshot = () => ({ request_id: '9007199254740993', lines: [line()], operations: [operation()] });
const parse = (value: unknown) => parseCountOperation(JSON.stringify(value));

function expectFrozen(value: unknown): void {
  if (value && typeof value === 'object') {
    expect(Object.isFrozen(value)).toBe(true);
    Object.values(value).forEach(expectFrozen);
  }
}

describe('count correction operation', () => {
  it('preserves exact persisted quantities above 2^53 and original reason', () => {
    expect(parseCountOperation(JSON.stringify(operation()))).toMatchObject({ request_id: 9007199254740993n,
      expected_revision: 9007199254740993n, actual_quantity: 9223372036854775807n, reason: '  physical recount  ' });
  });
  it.each(['accept', 'reject'])('accepts immutable historical %s independently of current proposal state', action => {
    const op = parse({ ...operation(), action, expected_revision: '9007199254740994', actual_quantity: null });
    expect(op.actual_quantity).toBeNull();
    expectFrozen(op);
  });
  it('accepts maximum proposal revision and actual zero', () => {
    expect(parse({ ...operation(), expected_revision: '9223372036854775806', revision: '9223372036854775807', actual_quantity: '0' }))
      .toMatchObject({ revision: 9223372036854775807n, actual_quantity: 0n });
  });
  it.each(['request_id', 'expected_revision', 'actual_quantity', 'revision'])('rejects noncanonical and coerced %s', field => {
    for (const value of [null, 1, 9007199254740992, {}, [], true, '01', '-0', '-1', '+1', '1e2', '1.0', ' 1', '', '9223372036854775808']) {
      expect(() => parse({ ...operation(), [field]: value })).toThrow('Invalid count correction response');
    }
  });
  it.each([
    { request_id: '0' }, { expected_revision: '9223372036854775807' }, { revision: '0' }, { revision: '2' },
    { action: 'approve' }, { action: null }, { action: 'accept' }, { actual_quantity: null },
    { variant_id: '201' }, { variant_id: 0 }, { variant_id: 2147483648 }, { variant_id: 1.5 },
    { actor_location_id: 0 }, { actor_location_id: 4 }, { actor_location_id: '1' },
    { operation_key: 'short' }, { operation_key: 'a'.repeat(129) }, { operation_key: 'non-ascii-é-key-01' },
    { reason: '   ' }, { reason: 'nul\0reason' }, { reason: '\ud800' }, { reason: 'x'.repeat(2001) },
    { recorded_at: '2026-02-30T00:00:00Z' }, { recorded_at: '2026-01-02T12:00:00+00:00' },
    { recorded_at: '2026-01-02T12:00:00.100Z' }, { private_history: 'PRIVATE' },
  ])('rejects invalid operation patch %j', patch => {
    expect(() => parse({ ...operation(), ...patch })).toThrow('Invalid count correction response');
  });
  it('rejects every missing operation member and duplicate escaped/equal members', () => {
    for (const field of Object.keys(operation())) {
      const value: Record<string, unknown> = operation(); delete value[field];
      expect(() => parse(value)).toThrow();
    }
    const raw = JSON.stringify(operation());
    expect(() => parseCountOperation(raw.replace('{', '{"request_id":"9007199254740993",'))).toThrow();
    expect(() => parseCountOperation(raw.replace('{', '{"request_\\u0069d":"9007199254740993",'))).toThrow();
    for (const token of ['2.01e2', '201.0', '9007199254740993']) {
      expect(() => parseCountOperation(raw.replace('"variant_id":201', '"variant_id":' + token))).toThrow();
    }
  });
});

describe('count correction history', () => {
  it.each(['0', '3', '7', '9007199254740993', '9223372036854775807'])('T4c preserves exact current dispatch %s independently of originals', dispatch => {
    const value = { ...snapshot(), lines: [{ ...line(), expected_quantity: '5', available_quantity: '5',
      effective_dispatch: dispatch, reconciliation_revision: '9007199254740993' }] };
    expect(parseCountCorrections(JSON.stringify(value)).lines[0]).toMatchObject({ expected_quantity: 5n,
      available_quantity: 5n, effective_dispatch: BigInt(dispatch), reconciliation_revision: 9007199254740993n });
  });
  it('T4c requires current evidence and rejects contradictory zero revision and unexpected dispatch', () => {
    for (const field of ['effective_dispatch', 'reconciliation_revision']) {
      for (const bad of [undefined, null, 7, '01', '-1', '9223372036854775808']) {
        expect(() => parseCountCorrections(JSON.stringify({ ...snapshot(), lines: [{ ...line(), [field]: bad }] }))).toThrow();
      }
    }
    for (const patch of [{ effective_dispatch: '7' },
      { expected_quantity: '0', effective_dispatch: '7', reconciliation_revision: '1' },
      { expected_quantity: '0', effective_dispatch: '0', reconciliation_revision: '1' }]) {
      expect(() => parseCountCorrections(JSON.stringify({ ...snapshot(), lines: [{ ...line(), ...patch }] }))).toThrow();
    }
    expect(parseCountCorrections(JSON.stringify({ ...snapshot(), lines: [{ ...line(), expected_quantity: '0',
      available_quantity: '0', effective_dispatch: '0', effective_credit: '0' }] })).lines[0].effective_dispatch).toBe(0n);
  });
  it.each(['7', '9223372036854775807'])('preserves reconciled credit %s above original dispatch without a count application', credit => {
    const value = { request_id: '9007199254740993', operations: [], lines: [{ variant_id: 201,
      expected_quantity: '5', effective_dispatch: credit, reconciliation_revision: '1', actual_quantity: '7', available_quantity: '5', workflow_revision: '0', applied_revision: '0',
      effective_actual: credit, effective_credit: credit, proposals: [] }] };
    expect(parseCountCorrections(JSON.stringify(value)).lines[0]).toMatchObject({ expected_quantity: 5n,
      available_quantity: 5n, applied_revision: 0n, effective_actual: BigInt(credit), effective_credit: BigInt(credit) });
  });
  it('preserves all persisted states, original/effective evidence, signed delta and deep immutability', () => {
    const result = parseCountCorrections(JSON.stringify(snapshot()));
    expect(result.lines[0].proposals.map(p => p.state)).toEqual(['applied', 'superseded', 'rejected', 'pending']);
    expect(result.lines[0].proposals[0].application?.delta).toBe(-9223372036854775807n);
    expect(result.operations[0].actual_quantity).toBe(9223372036854775807n);
    expectFrozen(result);
  });
  it('accepts empty arrays, absent history and the full signed int64 range', () => {
    expect(parseCountCorrections('{"request_id":"1","lines":[],"operations":[]}')).toEqual({ request_id: 1n, lines: [], operations: [] });
    const value = snapshot(); value.lines[0].proposals = [];
    expect(parseCountCorrections(JSON.stringify(value)).lines[0].proposals).toEqual([]);
    const applied = proposal('applied'); applied.application!.delta = '-9223372036854775808';
    value.lines[0].proposals = [applied];
    expect(parseCountCorrections(JSON.stringify(value)).lines[0].proposals[0].application?.delta).toBe(-9223372036854775808n);
  });
  it.each(['-0', '+1', '-01', '1e2', '1.1', '-9223372036854775809', '9223372036854775808', 1, null])('rejects invalid signed delta %s', delta => {
    const value = snapshot(); const p = value.lines[0].proposals[0];
    expect(() => parseCountCorrections(JSON.stringify({ ...value, lines: [{ ...line(), proposals: [{ ...p,
      application: { ...p.application, delta } }] }] }))).toThrow();
  });
  it('requires strict keys recursively and present nullable members', () => {
    const valid = snapshot();
    const nodes: Record<string, unknown>[] = [valid, valid.lines[0], ...valid.lines[0].proposals,
      valid.lines[0].proposals[0].decision!, valid.lines[0].proposals[0].application!, valid.operations[0]];
    for (const node of nodes) {
      node.extra = 'PRIVATE'; expect(() => parseCountCorrections(JSON.stringify(valid))).toThrow(); delete node.extra;
      for (const field of Object.keys(node)) {
        const saved = node[field]; delete node[field];
        expect(() => parseCountCorrections(JSON.stringify(valid))).toThrow(); node[field] = saved;
      }
    }
  });
  it('rejects null arrays, wrong states, wrong decision/application nullability and foreign operations', () => {
    for (const patch of [{ lines: null }, { operations: null }, { operations: [{ ...operation(), request_id: '1' }] }]) {
      expect(() => parseCountCorrections(JSON.stringify({ ...snapshot(), ...patch }))).toThrow();
    }
    for (const p of [{ ...proposal(), state: 'accepted' }, { ...proposal(), decision: {} },
      { ...proposal(), application: {} }, { ...proposal('applied'), application: null },
      { ...proposal('applied'), decision: null }, { ...proposal('rejected'), decision: { ...proposal('rejected').decision, accepted: true } }]) {
      expect(() => parseCountCorrections(JSON.stringify({ ...snapshot(), lines: [{ ...line(), proposals: [p] }] }))).toThrow();
    }
    expect(() => parseCountCorrections(JSON.stringify({ ...snapshot(), lines: [{ ...line(), proposals: null }] }))).toThrow();
    const raw = JSON.stringify(snapshot());
    expect(() => parseCountCorrections(raw.replace('"delta":', '"delta":"-9223372036854775807","delta":'))).toThrow();
  });
});

describe('normalized immutable request evidence', () => {
  const input = () => ({ variant_id: 201, operation_key: 'count_proposal_0001', expected_revision: '9007199254740993',
    actual_quantity: '9223372036854775807', reason: '  😀 recount\t  ' });
  it('copies and freezes inputs without trimming reason or coercing decimals', () => {
    const original = input(); const normalized = normalizeCountProposal(original); original.reason = 'changed';
    expect(normalized).toEqual({ ...input(), expected_revision: 9007199254740993n, actual_quantity: 9223372036854775807n });
    expectFrozen(normalized);
    const { actual_quantity: _actual, ...decision } = input();
    expectFrozen(normalizeCountDecision(decision));
    expect(normalizeCountProposal({ ...input(), reason: '😀'.repeat(2000) }).reason).toHaveLength(4000);
  });
  it('rejects decision actual, unknown authority and out-of-bounds/coerced input', () => {
    expect(() => normalizeCountDecision(input())).toThrow();
    expect(() => normalizeCountProposal({ ...input(), actor_location_id: 1 } as never)).toThrow();
    for (const patch of [{ expected_revision: '9223372036854775807' }, { actual_quantity: 1 }, { actual_quantity: null }, { reason: '  ' }]) {
      expect(() => normalizeCountProposal({ ...input(), ...patch } as never)).toThrow();
    }
  });
});
