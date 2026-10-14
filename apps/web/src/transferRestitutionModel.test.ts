import { describe, expect, it } from 'vitest';
import {
  captureRestitutionOperation, captureRestitutions, matchesRestitutionOperation, normalizeRestitutionDecision,
  normalizeRestitutionProposal, parseRestitutionError, parseRestitutionOperation, parseRestitutions,
  restitutionActorLocation, restitutionsPath, type RestitutionProposalInput,
} from './transferRestitutionModel';

const stamp = '2026-01-02T03:04:05.123456789Z';
const input = (): RestitutionProposalInput => ({ variant_id: 1, operation_key: 'restitution_key_001',
  expected_revision: '0', retained_quantity: '1', retained_at_origin: true, reason: '  retained ☃  ' });
const op = (action = 'propose', patch: Record<string, unknown> = {}) => ({
  operation_key: action === 'propose' ? input().operation_key : 'restitution_dec_001', request_id: '9007199254740993',
  variant_id: 1, actor_location_id: action === 'propose' ? 1 : 2, action, expected_revision: action === 'propose' ? '0' : '1',
  retained_quantity: action === 'propose' ? '1' : null, retained_at_origin: action === 'propose' ? true : null,
  reason: action === 'propose' ? input().reason : '  confirmed  ', revision: '1',
  source_existing_before: action === 'accept' ? '9007199254740993' : null,
  source_existing_after: action === 'accept' ? '9007199254740994' : null, recorded_at: stamp, ...patch,
});
const proposal = () => ({ revision: '1', operation_key: input().operation_key, initiator_location_id: 1,
  retained_quantity: '1', retained_at_origin: true, base_revision: '0', count_generation: '0', count_applied_revision: '0',
  base_credit: '4', base_restitution: '0', reason: input().reason, recorded_at: stamp, state: 'applied',
  decision: { operation_key: 'restitution_dec_001', actor_location_id: 2, accepted: true, reason: '  confirmed  ', recorded_at: stamp },
  application: { operation_key: 'restitution_dec_001', origin_location_id: 1, quantity: '1', recorded_at: stamp },
});
const snapshot = () => ({ request_id: '9007199254740993', lines: [{ variant_id: 1, expected_quantity: '5', original_credit: '4',
  workflow_revision: '1', applied_revision: '1', count_generation: '0', count_applied_revision: '0', effective_credit: '4',
  applied_retained_quantity: '1', proposals: [proposal()] }], operations: [op(), op('accept')] });
const parse = (value: unknown) => parseRestitutions(JSON.stringify(value));
type Snapshot = ReturnType<typeof snapshot>;

it('captures exact proposal bigint and retained evidence without trimming reason', () => {
  expect(normalizeRestitutionProposal({ ...input(), expected_revision: '9007199254740993', retained_quantity: '9223372036854775807' }))
    .toEqual({ ...input(), expected_revision: 9007199254740993n, retained_quantity: 9223372036854775807n });
});

describe('exact restitution requests', () => {
  it('freezes a detached capture and exposes exact decision members only', () => {
    const original = input();
    const captured = normalizeRestitutionProposal(original);
    Object.assign(original, { reason: 'changed', retained_quantity: '2', expected_revision: '1' });
    expect(captured).toEqual({ ...input(), expected_revision: 0n, retained_quantity: 1n });
    expect(Object.isFrozen(captured)).toBe(true);
    expect(normalizeRestitutionDecision({ variant_id: 1, operation_key: 'restitution_dec_001', expected_revision: '1', reason: '\t' }))
      .toEqual({ variant_id: 1, operation_key: 'restitution_dec_001', expected_revision: 1n, reason: '\t' });
  });
  it.each(['0', '9007199254740993', '9223372036854775806'])('accepts canonical expected revision %s', expected_revision => {
    expect(normalizeRestitutionProposal({ ...input(), expected_revision }).expected_revision).toBe(BigInt(expected_revision));
  });
  it.each(['1', '9007199254740993', '9223372036854775807'])('accepts canonical retained quantity %s', retained_quantity => {
    expect(normalizeRestitutionProposal({ ...input(), retained_quantity }).retained_quantity).toBe(BigInt(retained_quantity));
  });
  it.each(['', '00', '01', '-1', '+1', '1.0', '1e0', ' 1', '1 ', '9223372036854775808', '9'.repeat(100), 1, null, true, [], {}])
    ('rejects coerced/noncanonical decimal %j in both fields', value => {
      for (const member of ['expected_revision', 'retained_quantity']) {
        expect(() => normalizeRestitutionProposal({ ...input(), [member]: value } as never)).toThrow();
      }
    });
  it('enforces distinct expected and quantity bounds', () => {
    expect(() => normalizeRestitutionProposal({ ...input(), expected_revision: '9223372036854775807' })).toThrow();
    expect(() => normalizeRestitutionProposal({ ...input(), retained_quantity: '0' })).toThrow();
  });
  it.each([1, 2147483647])('accepts JSON int32 variant %s', variant_id => {
    expect(normalizeRestitutionProposal({ ...input(), variant_id }).variant_id).toBe(variant_id);
  });
  it.each([0, -1, 2147483648, 1.5, '1', null, NaN, Infinity])('rejects variant %j', variant_id => {
    expect(() => normalizeRestitutionProposal({ ...input(), variant_id } as never)).toThrow();
  });
  it.each(['a'.repeat(16), 'A_0-'.repeat(32)])('accepts operation key boundary', operation_key => {
    expect(normalizeRestitutionProposal({ ...input(), operation_key }).operation_key).toBe(operation_key);
  });
  it.each(['a'.repeat(15), 'a'.repeat(129), 'restitution key_001', ' restitution_key_001', 'restitution_key_001 ', '☃'.repeat(16), null])
    ('rejects key %j', operation_key => { expect(() => normalizeRestitutionProposal({ ...input(), operation_key } as never)).toThrow(); });
  it.each(['  retained ☃  ', '\t', '\n', '\u00a0', '☃'.repeat(2000), '😀'.repeat(2000), '  e\u0301  '])
    ('preserves backend-admitted reason %#', reason => {
      expect(normalizeRestitutionProposal({ ...input(), reason }).reason).toBe(reason);
      expect(normalizeRestitutionDecision({ variant_id: 1, operation_key: input().operation_key, expected_revision: '1', reason }).reason).toBe(reason);
    });
  it.each(['', '   ', '\0', 'x\0x', '☃'.repeat(2001), '😀'.repeat(2001), null, 1])('rejects reason %# for every action', reason => {
    expect(() => normalizeRestitutionProposal({ ...input(), reason } as never)).toThrow();
    expect(() => normalizeRestitutionDecision({ variant_id: 1, operation_key: input().operation_key, expected_revision: '1', reason } as never)).toThrow();
  });
  it.each([false, null, 'true', 1])('requires literal retention %j', retained_at_origin => {
    expect(() => normalizeRestitutionProposal({ ...input(), retained_at_origin } as never)).toThrow();
  });
  it('rejects every missing/null request member and every extra schema-specific member', () => {
    for (const [normalize, value] of [[normalizeRestitutionProposal, input()], [normalizeRestitutionDecision,
      { variant_id: 1, operation_key: input().operation_key, expected_revision: '1', reason: 'confirmed' }]] as const) {
      for (const member of Object.keys(value)) {
        const missing: Record<string, unknown> = { ...value }; delete missing[member];
        expect(() => normalize(missing as never)).toThrow();
        expect(() => normalize({ ...value, [member]: null } as never)).toThrow();
      }
      for (const member of ['actor_location_id', 'action', 'accept', 'quantity', 'base_revision', 'unknown']) {
        expect(() => normalize({ ...value, [member]: true } as never)).toThrow();
      }
    }
    for (const member of ['retained_quantity', 'retained_at_origin']) {
      expect(() => normalizeRestitutionDecision({ variant_id: 1, operation_key: input().operation_key,
        expected_revision: '1', reason: 'confirmed', [member]: input()[member as keyof RestitutionProposalInput] } as never)).toThrow();
    }
  });
  it('uses canonical route IDs and physical scalar actors', () => {
    expect(restitutionsPath('9223372036854775807')).toBe('/api/transfers/9223372036854775807/restitutions');
    for (const id of ['0', '01', '1?x', '1/accept', '9223372036854775808']) expect(() => restitutionsPath(id)).toThrow();
    for (const n of [1, 2, 3]) expect(restitutionActorLocation(n)).toBe(n);
    for (const n of [0, 4, 1.5, '1', null]) expect(() => restitutionActorLocation(n as number)).toThrow();
  });
});

describe('closed lossless wire evidence', () => {
  it('parses all six DTO shapes and deeply captures immutable stock evidence', () => {
    const result = parse(snapshot());
    expect(result.request_id).toBe(9007199254740993n);
    expect(result.lines[0]).toMatchObject({ expected_quantity: 5n, applied_retained_quantity: 1n });
    expect(result.operations[1]).toMatchObject({ retained_quantity: null, retained_at_origin: null,
      source_existing_before: 9007199254740993n, source_existing_after: 9007199254740994n });
    expect(result.lines[0].proposals[0].application).toMatchObject({ quantity: 1n });
    expect(captureRestitutions(result)).toEqual(result);
    expect(captureRestitutionOperation(result.operations[0])).toEqual(result.operations[0]);
    const visit = (value: unknown): void => {
      if (value !== null && typeof value === 'object') {
        expect(Object.isFrozen(value)).toBe(true);
        for (const child of Object.values(value)) visit(child);
      }
    };
    visit(result);
  });
  it('preserves MaxInt64 and high predecessor revisions without JS rounding', () => {
    const value = op('propose', { request_id: '9223372036854775807', expected_revision: '9223372036854775806',
      revision: '9223372036854775807', retained_quantity: '9223372036854775807', variant_id: 2147483647 });
    expect(parseRestitutionOperation(JSON.stringify(value))).toMatchObject({ request_id: 9223372036854775807n,
      expected_revision: 9223372036854775806n, revision: 9223372036854775807n, retained_quantity: 9223372036854775807n });
  });
  it.each(['2026-01-02T03:04:05Z', '2026-01-02T03:04:05.1Z', '2026-01-02T03:04:05.000001Z',
    '2026-01-02T03:04:05.123456789Z', '0001-01-01T00:00:00.000000001Z', '0000-02-29T00:00:00Z'])
    ('accepts actual UTC RFC3339Nano %s', recorded_at => {
      expect(parseRestitutionOperation(JSON.stringify(op('propose', { recorded_at }))).recorded_at).toBe(recorded_at);
    });
  it.each(['2026-02-30T03:04:05Z', '2026-01-02T24:00:00Z', '2026-01-02T03:04:60Z', '2026-01-02T03:04:05+00:00',
    '2026-01-02T03:04:05.100Z', '2026-01-02T03:04:05.1234567891Z', '2026-01-02', '0001-01-01T00:00:00Z'])
    ('rejects timestamps not emitted by backend %s', recorded_at => {
      expect(() => parseRestitutionOperation(JSON.stringify(op('propose', { recorded_at })))).toThrow();
    });
  it.each(['null', '[]', '{}', 'true', '', '{', JSON.stringify(snapshot()) + '{}'])('rejects invalid root %#', raw => {
    expect(() => parseRestitutions(raw)).toThrow();
  });
  it('rejects missing and unknown members at every DTO level without partial history', () => {
    const targets: ((s: Snapshot) => Record<string, unknown>)[] = [s => s, s => s.lines[0], s => s.operations[0],
      s => s.lines[0].proposals[0], s => s.lines[0].proposals[0].decision, s => s.lines[0].proposals[0].application];
    for (const target of targets) {
      const members = Object.keys(target(snapshot()));
      for (const member of members) {
        const s = snapshot(); delete target(s)[member]; expect(() => parse(s)).toThrow();
      }
      const s = snapshot(); target(s).unknown = true; expect(() => parse(s)).toThrow();
    }
  });
  it('rejects null required fields and arrays while keeping explicit nullable evidence', () => {
    const targets: ((s: Snapshot) => Record<string, unknown>)[] = [s => s, s => s.lines[0], s => s.operations[0],
      s => s.lines[0].proposals[0], s => s.lines[0].proposals[0].decision, s => s.lines[0].proposals[0].application];
    for (const target of targets) for (const member of Object.keys(target(snapshot()))) {
      if (target(snapshot())[member] === null) continue;
      const s = snapshot(); target(s)[member] = null;
      expect(() => parse(s)).toThrow();
    }
    const s = snapshot(); s.lines[0].proposals = []; s.lines[0].workflow_revision = '0'; s.lines[0].applied_revision = '0';
    s.lines[0].applied_retained_quantity = '0'; s.operations = [];
    expect(parse(s).lines[0].proposals).toEqual([]);
  });
  it('rejects escaped equal-valued duplicates at every nested object', () => {
    for (const member of ['request_id', 'expected_quantity', 'retained_quantity', 'initiator_location_id', 'accepted', 'quantity']) {
      const raw = JSON.stringify(snapshot());
      const token = new RegExp(`"${member}":("[^"]*"|true|[0-9]+)`);
      const escaped = member.replace(/./, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
      const duplicate = raw.replace(token, (_match, value: string) => `"${member}":${value},"${escaped}":${value}`);
      expect(duplicate).not.toBe(raw);
      expect(() => parseRestitutions(duplicate)).toThrow();
    }
  });
  it.each(['1.0', '1e0', '9007199254740993', '-1', '0'])('rejects numeric token variant %s without coercion', token => {
    expect(() => parseRestitutionOperation(JSON.stringify(op()).replace('"variant_id":1', '"variant_id":' + token))).toThrow();
  });
  it('requires canonical strings across every bigint field', () => {
    const targets: ((s: Snapshot) => Record<string, unknown>)[] = [s => s, s => s.lines[0], s => s.operations[1],
      s => s.lines[0].proposals[0], s => s.lines[0].proposals[0].application];
    for (const target of targets) for (const [member, value] of Object.entries(target(snapshot()))) {
      if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) continue;
      for (const bad of [Number(value), '0' + value, '9223372036854775808']) {
        const s = snapshot(); target(s)[member] = bad; expect(() => parse(s)).toThrow();
      }
    }
  });
  it.each([{ retained_quantity: null }, { retained_at_origin: false }, { revision: '2' }, { source_existing_before: '0' },
    { request_id: '0' }, { actor_location_id: 4 }, { reason: '   ' }, { action: 'approve' }])('rejects invalid proposal operation %j', patch => {
    expect(() => parseRestitutionOperation(JSON.stringify(op('propose', patch)))).toThrow();
  });
  it.each(['accept', 'reject'])('enforces %s null retention and persisted stock evidence', action => {
    expect(parseRestitutionOperation(JSON.stringify(op(action))).action).toBe(action);
    for (const patch of [{ retained_quantity: '1' }, { retained_at_origin: true }, { expected_revision: '0' }, { revision: '2' }]) {
      expect(() => parseRestitutionOperation(JSON.stringify(op(action, patch)))).toThrow();
    }
    const patches = action === 'accept' ? [{ source_existing_before: null }, { source_existing_after: null },
      { source_existing_after: '9007199254740993' }, { source_existing_before: '-1' }]
      : [{ source_existing_before: '0' }, { source_existing_after: '1' }];
    for (const patch of patches) expect(() => parseRestitutionOperation(JSON.stringify(op(action, patch)))).toThrow();
  });
  it('matches every invocation field and does not compare stock snapshots with current inventory', () => {
    const normalized = normalizeRestitutionProposal(input());
    const parsed = parseRestitutionOperation(JSON.stringify(op()));
    expect(matchesRestitutionOperation(parsed, 9007199254740993n, 1, 'propose', normalized)).toBe(true);
    for (const patch of [{ request_id: 1n }, { actor_location_id: 2 }, { action: 'reject' }, { variant_id: 2 },
      { operation_key: 'another_key_00001' }, { expected_revision: 1n }, { retained_quantity: 2n },
      { retained_at_origin: null }, { reason: 'retained ☃' }]) {
      expect(matchesRestitutionOperation({ ...parsed, ...patch } as never, 9007199254740993n, 1, 'propose', normalized)).toBe(false);
    }
    const decision = normalizeRestitutionDecision({ variant_id: 1, operation_key: 'restitution_dec_001', expected_revision: '1', reason: '  confirmed  ' });
    const accepted = parseRestitutionOperation(JSON.stringify(op('accept')));
    expect(matchesRestitutionOperation(accepted, 9007199254740993n, 2, 'accept', decision)).toBe(true);
    expect(matchesRestitutionOperation({ ...accepted, source_existing_before: 10n, source_existing_after: 11n },
      9007199254740993n, 2, 'accept', decision)).toBe(true);
  });
  it('admits only exact closed duplicate-free error envelopes', () => {
    expect(parseRestitutionError('{"error":"decision_conflict"}')).toBe('decision_conflict');
    for (const raw of ['null', '{}', '{"error":null}', '{"error":"x","detail":"private"}',
      '{"error":"x","err\\u006fr":"x"}', '{"error":"x"} {}']) expect(() => parseRestitutionError(raw)).toThrow();
  });
});

describe('Store history consistency', () => {
  const mutations: [string, (s: Snapshot) => void][] = [
    ['empty expected lines', s => { s.lines = []; }],
    ['duplicate variants', s => { s.lines.push(structuredClone(s.lines[0])); }],
    ['unordered variants', s => { s.lines.unshift({ ...structuredClone(s.lines[0]), variant_id: 2 }); }],
    ['zero dispatched quantity', s => { s.lines[0].expected_quantity = '0'; }],
    ['original credit above dispatch', s => { s.lines[0].original_credit = '6'; }],
    ['effective credit above dispatch', s => { s.lines[0].effective_credit = '6'; }],
    ['count applied above generation', s => { s.lines[0].count_applied_revision = '1'; }],
    ['zero applied changed credit', s => { s.lines[0].effective_credit = '3'; }],
    ['conservation violation', s => { s.lines[0].effective_credit = '5'; s.lines[0].original_credit = '5'; }],
    ['workflow not proposal count', s => { s.lines[0].workflow_revision = '2'; }],
    ['wrong applied revision', s => { s.lines[0].applied_revision = '0'; }],
    ['wrong applied quantity', s => { s.lines[0].applied_retained_quantity = '0'; }],
    ['operation wrong transfer', s => { s.operations[0].request_id = '1'; }],
    ['duplicate operation key', s => { s.operations.push(structuredClone(s.operations[0])); }],
    ['unused operation', s => { s.operations.push(op('reject', { operation_key: 'orphan_key_000001' })); }],
    ['missing proposal operation', s => { s.operations.shift(); }],
    ['wrong proposal variant', s => { s.operations[0].variant_id = 2; }],
    ['wrong proposal revision', s => { s.operations[0].expected_revision = '1'; s.operations[0].revision = '2'; }],
    ['noncontiguous proposal revision', s => { s.lines[0].proposals[0].revision = '2'; }],
    ['wrong predecessor', s => { s.lines[0].proposals[0].base_revision = '1'; }],
    ['wrong initiator', s => { s.lines[0].proposals[0].initiator_location_id = 3; }],
    ['proposal quantity mismatch', s => { s.lines[0].proposals[0].retained_quantity = '2'; }],
    ['proposal reason mismatch', s => { s.lines[0].proposals[0].reason = 'retained ☃'; }],
    ['proposal timestamp mismatch', s => { s.lines[0].proposals[0].recorded_at = '2026-01-02T03:04:06Z'; }],
    ['generation pin from future', s => { s.lines[0].proposals[0].count_generation = '1'; }],
    ['applied pin above proposal generation', s => { s.lines[0].count_generation = '2'; s.lines[0].count_applied_revision = '2'; s.lines[0].proposals[0].count_applied_revision = '1'; }],
    ['applied pin from future', s => { s.lines[0].count_generation = '2'; s.lines[0].proposals[0].count_generation = '2'; s.lines[0].proposals[0].count_applied_revision = '1'; }],
    ['base credit above debit', s => { s.lines[0].proposals[0].base_credit = '6'; }],
    ['nonzero predecessor restitution', s => { s.lines[0].proposals[0].base_restitution = '1'; }],
    ['proposal exceeds outstanding debit', s => { s.lines[0].proposals[0].base_credit = '5'; }],
    ['wrong proposal state', s => { s.lines[0].proposals[0].state = 'pending'; }],
    ['missing decision operation', s => { s.operations.pop(); }],
    ['wrong decision action', s => { s.operations[1] = op('reject'); }],
    ['wrong decision variant', s => { s.operations[1].variant_id = 2; }],
    ['wrong decision revision', s => { s.operations[1].expected_revision = '2'; s.operations[1].revision = '2'; }],
    ['wrong decision actor', s => { s.lines[0].proposals[0].decision.actor_location_id = 3; }],
    ['wrong decision reason', s => { s.lines[0].proposals[0].decision.reason = 'confirmed'; }],
    ['wrong decision timestamp', s => { s.lines[0].proposals[0].decision.recorded_at = '2026-01-02T03:04:06Z'; }],
    ['decision before proposal', s => { const earlier = '2026-01-02T03:04:05.123456788Z'; s.operations[1].recorded_at = earlier;
      s.lines[0].proposals[0].decision.recorded_at = earlier; s.lines[0].proposals[0].application.recorded_at = earlier; }],
    ['same source and destination', s => { s.operations[1].actor_location_id = 1; s.lines[0].proposals[0].decision.actor_location_id = 1; }],
    ['wrong application key', s => { s.lines[0].proposals[0].application.operation_key = input().operation_key; }],
    ['wrong application origin', s => { s.lines[0].proposals[0].application.origin_location_id = 3; }],
    ['wrong application quantity', s => { s.lines[0].proposals[0].application.quantity = '2'; }],
    ['wrong application timestamp', s => { s.lines[0].proposals[0].application.recorded_at = '2026-01-02T03:04:06Z'; }],
    ['wrong persisted stock delta', s => { s.operations[1].source_existing_after = '9007199254740995'; }],
  ];
  it.each(mutations)('rejects %s without exposing partial evidence', (_name, mutate) => {
    const s = snapshot(); mutate(s); expect(() => parse(s)).toThrow();
  });
  // A rejected predecessor followed by a later pending proposal is valid even
  // when intervening count operations advance generation far beyond revisions.
  const gap = () => {
    const s = snapshot(); const first = s.lines[0].proposals[0];
    first.state = 'rejected'; first.decision.accepted = false; first.application = null as never;
    first.count_generation = '3'; first.count_applied_revision = '1';
    s.operations[1] = op('reject');
    const next = { ...structuredClone(first), revision: '2', base_revision: '1', operation_key: 'restitution_key_002',
      count_generation: '10', count_applied_revision: '2', state: 'pending', decision: null, application: null };
    s.lines[0].proposals.push(next as never);
    s.operations.push(op('propose', { operation_key: next.operation_key, expected_revision: '1', revision: '2' }));
    Object.assign(s.lines[0], { workflow_revision: '2', applied_revision: '0', applied_retained_quantity: '0',
      count_generation: '20', count_applied_revision: '4' });
    return s;
  };
  it('keeps MaxInt64 line conservation and operation-count pins lossless', () => {
    const s = snapshot(); const l = s.lines[0]; const p = l.proposals[0];
    Object.assign(l, { expected_quantity: '9223372036854775807', original_credit: '9007199254740993',
      effective_credit: '9007199254740993', count_generation: '9223372036854775807', count_applied_revision: '9007199254740994' });
    Object.assign(p, { base_credit: '9007199254740993', count_generation: '9007199254740995', count_applied_revision: '9007199254740994' });
    expect(parse(s).lines[0]).toMatchObject({ expected_quantity: 9223372036854775807n,
      effective_credit: 9007199254740993n, count_generation: 9223372036854775807n });
    l.effective_credit = '9223372036854775807';
    expect(() => parse(s)).toThrow();
    l.effective_credit = '9223372036854775806';
    expect(parse(s).lines[0].applied_retained_quantity).toBe(1n);
  });
  it('accepts generation gaps and earlier historical count application pins', () => {
    expect(parse(gap()).lines[0]).toMatchObject({ count_generation: 20n, count_applied_revision: 4n, applied_revision: 0n });
  });
  it('accepts equal historical pins/timestamps and superseded undecided predecessors', () => {
    const s = gap(); const first = s.lines[0].proposals[0];
    first.state = 'superseded'; first.decision = null as never; s.operations.splice(1, 1);
    Object.assign(s.lines[0].proposals[1], { count_generation: '3', count_applied_revision: '1' });
    expect(parse(s).lines[0].proposals.map(p => p.state)).toEqual(['superseded', 'pending']);
  });
  it.each(['generation', 'applied', 'timestamp', 'after-application', 'reused-decision', 'rejection-application',
    'undecided-application', 'accepted-no-application', 'roles-across-lines'])('rejects alternate history guard %s', mode => {
    const s = gap(); const next = s.lines[0].proposals[1];
    if (mode === 'generation') next.count_generation = '2';
    if (mode === 'applied') next.count_applied_revision = '0';
    if (mode === 'timestamp') {
      next.recorded_at = '2026-01-02T03:04:05.123456788Z'; s.operations[2].recorded_at = next.recorded_at;
    }
    if (mode === 'after-application') {
      const applied = snapshot(); s.lines[0].proposals[0] = applied.lines[0].proposals[0]; s.operations[1] = applied.operations[1];
    }
    if (mode === 'reused-decision') { next.decision = structuredClone(s.lines[0].proposals[0].decision); next.state = 'rejected'; }
    if (mode === 'rejection-application') s.lines[0].proposals[0].application = proposal().application;
    if (mode === 'undecided-application') next.application = proposal().application;
    if (mode === 'accepted-no-application') { s.lines[0].proposals[0].decision.accepted = true;
      s.lines[0].proposals[0].state = 'applied'; s.operations[1] = op('accept'); }
    if (mode === 'roles-across-lines') {
      const extra = structuredClone(s.lines[0]); extra.variant_id = 2; extra.proposals = [];
      Object.assign(extra, { workflow_revision: '0', applied_revision: '0', applied_retained_quantity: '0' });
      const p = { ...proposal(), operation_key: 'other_origin_00001', initiator_location_id: 3, state: 'pending', decision: null, application: null };
      extra.proposals.push(p as never); extra.workflow_revision = '1';
      s.lines.push(extra); s.operations.push(op('propose', { variant_id: 2, actor_location_id: 3, operation_key: p.operation_key }));
    }
    expect(() => parse(s)).toThrow();
  });
  it('orders nanoseconds correctly when fractional precision differs', () => {
    const s = gap(); const first = s.lines[0].proposals[0];
    first.recorded_at = '2026-01-02T03:04:05.1Z'; first.decision.recorded_at = first.recorded_at;
    s.operations[0].recorded_at = first.recorded_at; s.operations[1].recorded_at = first.recorded_at;
    s.lines[0].proposals[1].recorded_at = '2026-01-02T03:04:05.100000001Z';
    s.operations[2].recorded_at = s.lines[0].proposals[1].recorded_at;
    expect(parse(s).lines[0].proposals).toHaveLength(2);
  });
});
