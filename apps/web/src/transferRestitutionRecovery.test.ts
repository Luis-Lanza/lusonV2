import { describe, expect, it } from 'vitest';
import { createTransferRestitutionRecovery, restitutionRetryPayload, type RestitutionReviewPin, type RestitutionFlight } from './transferRestitutionRecovery';
import { RestitutionAPIError } from './transferAPI';
import { captureCountCorrections } from './transferCountCorrectionRecovery';
import type { CountCorrections, CountProposal, CountOperation } from './transferCountCorrectionModel';
import type { RestitutionAction, RestitutionOperation, Restitutions } from './transferRestitutionModel';
import { parseTransferRecord, type TransferRecord } from './transferModel';
import { captureRestitutions } from './transferRestitutionModel';
const origin = { account: 11, location: 1, epoch: 1, generation: 1 };
const destination = { account: 22, location: 2, epoch: 1, generation: 1 };
const id = 9007199254740993n;
const stamp = '2026-04-02T00:00:00Z';
function record() {
  return parseTransferRecord(JSON.stringify({ id: id.toString(), reference: `TR-${id}`, kind: 'direct_shipment', status: 'received',
    created_at: stamp, creator_location_id: 1, creator_location_name: 'Origin', origin_location_id: 1, origin_location_name: 'Origin',
    destination_location_id: 2, destination_location_name: 'Destination', approver_location_id: 1, approver_location_name: 'Origin',
    decision_location_id: 1, decided_at: stamp, dispatch_location_id: 1, dispatched_at: stamp, receipt_location_id: 2, received_at: stamp,
    items: [{ variant_id: 201, brand: 'B', model: 'M', capacity_ah: '60', polarity: 'L', quantity: '5' }],
    receipt: { items: [{ variant_id: 201, expected_quantity: '5', actual_quantity: '4', available_quantity: '4' }],
      exceptions: [{ variant_id: 201, kind: 'shortage', quantity: '1' }] } }));
}
function proposalHistory() {
  return captureRestitutions({ request_id: id, lines: [{ variant_id: 201, expected_quantity: 5n, effective_dispatch: 5n, reconciliation_revision: 0n, original_credit: 4n,
    workflow_revision: 1n, applied_revision: 0n, count_generation: 0n, count_applied_revision: 0n, effective_credit: 4n,
    applied_retained_quantity: 0n, proposals: [{ revision: 1n, operation_key: 'retained_proposal_01', initiator_location_id: 1,
      retained_quantity: 1n, retained_at_origin: true, base_revision: 0n, count_generation: 0n, count_applied_revision: 0n,
      base_dispatch: 5n, base_credit: 4n, base_restitution: 0n, reason: ' retained at origin ', recorded_at: stamp, state: 'pending', decision: null, application: null }] }],
    operations: [{ operation_key: 'retained_proposal_01', request_id: id, variant_id: 201, actor_location_id: 1, action: 'propose',
      expected_revision: 0n, retained_quantity: 1n, retained_at_origin: true, reason: ' retained at origin ', revision: 1n,
      source_existing_before: null, source_existing_after: null, recorded_at: stamp }] });
}
const proposalInput = { variant_id: 201, operation_key: 'retained_proposal_01', expected_revision: '0',
  retained_quantity: '1', retained_at_origin: true as const, reason: ' retained at origin ' };
const decisionInput = { variant_id: 201, operation_key: 'retained_decision_01', expected_revision: '1', reason: ' destination checked ' };
const network = new RestitutionAPIError('network', null, true);
function emptyHistory() {
  const h = structuredClone(proposalHistory());
  return captureRestitutions({ ...h, operations: [], lines: [{ ...h.lines[0], workflow_revision: 0n, proposals: [] }] });
}
function emptyCount(): CountCorrections {
  return captureCountCorrections({ request_id: id, operations: [], lines: [{ variant_id: 201, expected_quantity: 5n, effective_dispatch: 5n, reconciliation_revision: 0n,
    actual_quantity: 4n, available_quantity: 4n, workflow_revision: 0n, applied_revision: 0n, effective_actual: 4n,
    effective_credit: 4n, proposals: [] }] });
}
// Independent fixture: propose, replace, reject, propose, accept (zero delta).
// Three proposal revisions, five persisted operations: they are NOT equivalent.
function countHistory(pending = false): CountCorrections {
  const operations: CountOperation[] = [];
  const proposals: CountProposal[] = [];
  for (let revision = 1; revision <= (pending ? 4 : 3); revision++) {
    const operation_key = `count_proposal_000${revision}`;
    const decided = revision === 2 || revision === 3;
    const accepted = revision === 3;
    const decision_key = `count_decision_000${revision}`;
    proposals.push({ revision: BigInt(revision), operation_key, initiator_location_id: 2, actual_quantity: 4n,
      base_revision: revision === 4 ? 3n : 0n, base_credit: 4n, reason: 'recount', recorded_at: stamp,
      state: revision === 1 ? 'superseded' : decided ? accepted ? 'applied' : 'rejected' : 'pending',
      decision: decided ? { operation_key: decision_key, actor_location_id: 1, accepted, reason: 'checked', recorded_at: stamp } : null,
      application: accepted ? { effective_credit: 4n, delta: 0n, recorded_at: stamp } : null });
    operations.push({ operation_key, request_id: id, variant_id: 201, actor_location_id: 2, action: 'propose',
      expected_revision: BigInt(revision - 1), actual_quantity: 4n, reason: 'recount', revision: BigInt(revision), recorded_at: stamp });
    if (decided) operations.push({ operation_key: decision_key, request_id: id, variant_id: 201, actor_location_id: 1,
      action: accepted ? 'accept' : 'reject', expected_revision: BigInt(revision), actual_quantity: null, reason: 'checked',
      revision: BigInt(revision), recorded_at: stamp });
  }
  return captureCountCorrections({ request_id: id, operations, lines: [{ ...emptyCount().lines[0], proposals,
    workflow_revision: pending ? 4n : 3n, applied_revision: 3n }] });
}
function countedRestitution(pending = false, stale = false): Restitutions {
  const h = proposalHistory();
  const count_generation = pending ? 6n : 5n;
  return captureRestitutions({ ...h, lines: [{ ...h.lines[0], count_generation, count_applied_revision: 3n,
    proposals: [{ ...h.lines[0].proposals[0], count_generation: stale ? 0n : count_generation, count_applied_revision: stale ? 0n : 3n }] }] });
}
function operation(action: RestitutionAction = 'propose'): RestitutionOperation {
  if (action === 'propose') return proposalHistory().operations[0];
  return { operation_key: decisionInput.operation_key, request_id: id, variant_id: 201, actor_location_id: 2,
    action, expected_revision: 1n, retained_quantity: null, retained_at_origin: null, reason: decisionInput.reason, revision: 1n,
    source_existing_before: action === 'accept' ? 10n : null, source_existing_after: action === 'accept' ? 11n : null, recorded_at: stamp };
}
function decidedHistory(action: 'accept' | 'reject'): Restitutions {
  const h = proposalHistory(); const op = operation(action); const accepted = action === 'accept';
  return captureRestitutions({ ...h, operations: [...h.operations, op], lines: [{ ...h.lines[0], applied_revision: accepted ? 1n : 0n,
    applied_retained_quantity: accepted ? 1n : 0n, proposals: [{ ...h.lines[0].proposals[0], state: accepted ? 'applied' : 'rejected',
      decision: { operation_key: op.operation_key, actor_location_id: 2, accepted, reason: op.reason, recorded_at: stamp },
      application: accepted ? { operation_key: op.operation_key, origin_location_id: 1, quantity: 1n, recorded_at: stamp } : null }] }] });
}
function setup(action: RestitutionAction = 'propose') {
  const r = createTransferRestitutionRecovery(); const owner = action === 'propose' ? origin : destination;
  r.observe(owner, action === 'propose' ? emptyHistory() : proposalHistory(), true);
  r.observeCount(owner, emptyCount(), true);
  const pin = r.review(owner, record(), 201, action)!;
  expect(pin).not.toBeNull();
  return { r, owner, pin, input: action === 'propose' ? proposalInput : decisionInput };
}

describe('reviewed acceptance evidence', () => {
  it('refuses a positive direct stock delta different from reviewed quantity', () => {
    const { r, owner, pin, input } = setup('accept'); const flight = r.start(pin, input)!;
    expect(() => r.finish(flight, { ...operation('accept'), source_existing_after: 12n })).toThrow();
    expect(r.isCurrent(flight, owner)).toBe(true); expect(r.consumeConfirmations(owner)).toEqual([]);
    r.fail(flight, new RestitutionAPIError('invalid_response', 200, true));
    expect(r.get(owner, id)[0].phase).toBe('uncertain');
    const retry = r.claim(owner, id, 201)!;
    expect(restitutionRetryPayload(retry.attempt)).toEqual(decisionInput);
    expect(r.finish(retry, operation('accept'))).toBe(true);
    expect(r.consumeConfirmations(owner)).toEqual([operation('accept')]);
  });
  it.each(['quantity', 'expected', 'original-credit', 'proposal-key', 'proposal-reason', 'predecessor', 'proposal-time', 'origin', 'destination', 'dispatch-pin'] as const)(
    'refuses internally valid rewritten historical %s', field => {
      const { r, owner, pin, input } = setup('accept'); const flight = r.start(pin, input)!; r.release(flight);
      const h = structuredClone(decidedHistory('accept')); const line = h.lines[0]; const p = line.proposals[0];
      if (field === 'quantity') {
        Object.assign(line, { expected_quantity: 6n, effective_dispatch: 6n, applied_retained_quantity: 2n });
        Object.assign(p, { base_dispatch: 6n, retained_quantity: 2n }); Object.assign(p.application!, { quantity: 2n });
        Object.assign(h.operations[0], { retained_quantity: 2n }); Object.assign(h.operations[1], { source_existing_after: 12n });
      }
      if (field === 'expected') {
        Object.assign(line, { expected_quantity: 6n, effective_dispatch: 6n });
        Object.assign(p, { base_dispatch: 6n });
      }
      if (field === 'original-credit') Object.assign(line, { original_credit: 3n, effective_credit: 3n });
      if (field === 'dispatch-pin') Object.assign(p, { base_dispatch: 6n });
      if (field === 'proposal-key') {
        Object.assign(p, { operation_key: 'rewritten_proposal_01' }); Object.assign(h.operations[0], { operation_key: p.operation_key });
      }
      if (field === 'proposal-reason') { Object.assign(p, { reason: 'changed agreement' }); Object.assign(h.operations[0], { reason: p.reason }); }
      if (field === 'predecessor') {
        Object.assign(line, { count_generation: 1n, count_applied_revision: 1n, effective_credit: 3n });
        Object.assign(p, { count_generation: 1n, count_applied_revision: 1n, base_credit: 3n });
      }
      if (field === 'proposal-time') { Object.assign(p, { recorded_at: '2026-04-01T00:00:00Z' }); Object.assign(h.operations[0], { recorded_at: p.recorded_at }); }
      if (field === 'origin') {
        Object.assign(p, { initiator_location_id: 3 }); Object.assign(p.application!, { origin_location_id: 3 });
        Object.assign(h.operations[0], { actor_location_id: 3 });
      }
      if (field === 'destination') {
        Object.assign(p.decision!, { actor_location_id: 3 }); Object.assign(h.operations[1], { actor_location_id: 3 });
      }
      // The wire parser accepts this self-consistent alternate agreement.
      const parsed = captureRestitutions(h); expect(parsed.lines[0].proposals[0].state).toBe('applied');
      r.observe(owner, parsed, true);
      expect(r.get(owner, id)[0].phase).toBe('uncertain'); expect(r.consumeConfirmations(owner)).toEqual([]);
      expect(r.review(owner, record(), 201, 'reject')).toBeNull();
      const retry = r.claim(owner, id, 201)!; expect(restitutionRetryPayload(retry.attempt)).toEqual(decisionInput);
      r.observe(owner, decidedHistory('accept'), true);
      expect(r.get(owner, id)[0].phase).toBe('confirmed'); expect(r.finish(retry, operation('accept'))).toBe(false);
      expect(r.consumeConfirmations(owner)).toEqual([operation('accept')]); expect(r.consumeConfirmations(owner)).toEqual([]);
    });
  it.each([10n, 100n])('accepts persisted direct stock evidence starting at %s without a current balance dependency', before => {
    const { r, owner, pin, input } = setup('accept'); const flight = r.start(pin, input)!;
    const op = { ...operation('accept'), source_existing_before: before, source_existing_after: before + 1n };
    expect(r.finish(flight, op)).toBe(true); expect(r.consumeConfirmations(owner)).toEqual([op]);
  });
  it('accepts GET before POST with advanced live count pins, preserving immutable predecessor and effect once', () => {
    const { r, owner, pin, input } = setup('accept'); const flight = r.start(pin, input)!;
    const h = decidedHistory('accept');
    const advanced = captureRestitutions({ ...h, lines: [{ ...h.lines[0], count_generation: 6n, count_applied_revision: 4n, effective_credit: 3n }] });
    r.invalidate(owner, id, 'header'); r.observeCount(owner, countHistory(true), true, true);
    r.observe(owner, advanced, false, true);
    expect(r.get(owner, id)[0].phase).toBe('confirmed'); expect(r.finish(flight, operation('accept'))).toBe(false);
    expect(r.consumeConfirmations(owner)).toEqual([operation('accept')]);
    r.observe(owner, advanced, true); expect(r.consumeConfirmations(owner)).toEqual([]);
  });
  it('captures private immutable consent across caller mutation and exact retry without adding decision fields', () => {
    const r = createTransferRestitutionRecovery(); const h = structuredClone(proposalHistory());
    const header = structuredClone(record()) as Extract<TransferRecord, { status: 'received' }>;
    r.observe(destination, h, true); r.observeCount(destination, emptyCount(), true);
    const pin = r.review(destination, header, 201, 'accept')!;
    Object.assign(h.lines[0].proposals[0], { retained_quantity: 2n, reason: 'mutated' });
    header.items[0].quantity = 6n; Object.assign(header.receipt.items[0], { available_quantity: 3n });
    const flight = r.start(pin, decisionInput)!; expect(flight).not.toBeNull(); r.release(flight);
    r.invalidate(destination, id, 'count'); r.select(destination, 2n, 202);
    const retry = r.claim(destination, id, 201)!;
    expect(restitutionRetryPayload(retry.attempt)).toEqual(decisionInput);
    expect(Object.keys(retry.attempt.payload).sort()).toEqual(Object.keys(decisionInput).sort());
    r.observe(destination, decidedHistory('accept'), true);
    expect(r.get(destination, id)[0].phase).toBe('confirmed'); expect(r.finish(retry, operation('accept'))).toBe(false);
    expect(r.consumeConfirmations(destination)).toEqual([operation('accept')]);
  });
  it('contradictory GET cannot replace a known exact result or repeat its effect', () => {
    const { r, owner, pin, input } = setup('accept'); r.finish(r.start(pin, input)!, operation('accept'));
    const h = decidedHistory('accept'); const p = h.lines[0].proposals[0];
    const changed = captureRestitutions({ ...h, operations: [{ ...h.operations[0], reason: 'rewritten' }, h.operations[1]],
      lines: [{ ...h.lines[0], proposals: [{ ...p, reason: 'rewritten' }] }] });
    r.observe(owner, changed, true);
    expect(r.get(owner, id)[0].result).toEqual(operation('accept')); expect(r.consumeConfirmations(owner)).toEqual([operation('accept')]);
    r.observe(owner, changed, true); expect(r.consumeConfirmations(owner)).toEqual([]);
  });
});

describe('reviewed rejection', () => {
  it('allows destination to review a clean latest proposal without count evidence', () => {
    const r = createTransferRestitutionRecovery();
    r.observe(destination, proposalHistory(), true);
    expect(r.review(destination, record(), 201, 'reject')).not.toBeNull();
  });
  it('does not grant the origin destination decision authority', () => {
    const r = createTransferRestitutionRecovery();
    r.observe(origin, proposalHistory(), true);
    expect(r.review(origin, record(), 201, 'reject')).toBeNull();
  });
});

describe('physical header and explicit history authority', () => {
  it.each(['propose', 'accept', 'reject'] as const)('requires the actual %s actor role, with a valid control', action => {
    const { r, owner } = setup(action);
    expect(r.review(owner, record(), 201, action)).not.toBeNull();
    expect(r.review({ ...owner, location: action === 'propose' ? 2 : 1 }, record(), 201, action)).toBeNull();
  });
  it.each(['status', 'endpoint', 'request', 'variant', 'quantity', 'receipt', 'unknown-field'] as const)('refuses %s without authority from actor history', guard => {
    const { r, owner } = setup('reject'); const value = structuredClone(record());
    if (guard === 'status') {
      const { receipt: _receipt, receipt_location_id: _location, received_at: _stamp, ...rest } = value as Extract<TransferRecord, { status: 'received' }>;
      expect(r.review(owner, { ...rest, status: 'in_transit' }, 201, 'reject')).toBeNull(); return;
    }
    if (guard === 'endpoint') Object.assign(value, { origin_location_id: 3 });
    if (guard === 'request') Object.assign(value, { id: '2', reference: 'TR-002' });
    if (guard === 'quantity') value.items[0].quantity = 6n;
    if (guard === 'receipt') Object.assign(value, { receipt_location_id: 1 });
    if (guard === 'unknown-field') Object.assign(value, { invented: true });
    expect(r.review(owner, value, guard === 'variant' ? 202 : 201, 'reject')).toBeNull();
  });
  it.each([false, true])('dirty=%s cannot create fresh consent even when the head label is pending', dirty => {
    const r = createTransferRestitutionRecovery();
    r.observe(destination, proposalHistory(), dirty, dirty);
    expect(r.review(destination, record(), 201, 'reject')).toBeNull();
    r.observe(destination, proposalHistory(), true, false);
    expect(r.review(destination, record(), 201, 'reject')).not.toBeNull();
  });
  it('mismatching inferred historical endpoints are not physical header authority', () => {
    const r = createTransferRestitutionRecovery(); const h = proposalHistory();
    r.observe(destination, captureRestitutions({ ...h, operations: [{ ...h.operations[0], actor_location_id: 3 }],
      lines: [{ ...h.lines[0], proposals: [{ ...h.lines[0].proposals[0], initiator_location_id: 3 }] }] }), true);
    expect(r.review(destination, record(), 201, 'reject')).toBeNull();
  });
  it('captures mutable headers and history without later caller mutations', () => {
    const r = createTransferRestitutionRecovery(); const h = structuredClone(proposalHistory()); const header = structuredClone(record());
    r.observe(destination, h, true); const pin = r.review(destination, header, 201, 'reject')!;
    Object.assign(h.lines[0].proposals[0], { reason: 'mutated' }); header.items[0].quantity = 9n;
    expect(r.eligibility(destination, pin).eligible).toBe(true);
    expect(r.start(pin, decisionInput)).not.toBeNull();
  });
});

describe('owned references and retirement', () => {
  it('rejects forged pins, copied pins and cross-controller capabilities', () => {
    const { r, owner, pin, input } = setup(); const other = setup().r;
    for (const fake of [{ kind: 'restitution-review' } as RestitutionReviewPin, { ...pin }]) {
      expect(r.eligibility(owner, fake)).toEqual({ eligible: false, blocker: 'retired' });
      expect(r.start(fake, input)).toBeNull();
    }
    expect(other.start(pin, input)).toBeNull(); expect(r.start(pin, input)).not.toBeNull();
  });
  it.each(['account', 'location', 'epoch', 'generation'] as const)('retires every capability on owner %s replacement and return', field => {
    const { r, owner, pin, input } = setup(); const flight = r.start(pin, input)!;
    r.synchronize({ ...owner, [field]: owner[field] + 1 }); r.synchronize(owner);
    expect(r.get(owner, id)).toEqual([]); expect(r.start(pin, input)).toBeNull();
    expect(r.isCurrent(flight, owner)).toBe(false); expect(r.finish(flight, operation())).toBe(false);
    expect(r.consumeConfirmations(owner)).toEqual([]);
  });
  it('retires on owner unavailability', () => {
    const { r, owner, pin } = setup(); r.synchronize(null);
    expect(r.eligibility(owner, pin).blocker).toBe('retired');
  });
  it.each(['request', 'variant', 'clear'] as const)('selection %s retires consent but not exact historical retry', change => {
    const { r, owner, pin, input } = setup(); const flight = r.start(pin, input)!; r.release(flight);
    const fresh = setup('reject');
    fresh.r.select(fresh.owner, change === 'clear' ? null : change === 'request' ? 2n : id, change === 'clear' ? null : change === 'variant' ? 202 : 201);
    expect(fresh.r.eligibility(fresh.owner, fresh.pin).blocker).toBe('retired');
    r.select(owner, 2n, 202); expect(r.claim(owner, id, 201)).not.toBeNull();
  });
  it('changed captured header retires earlier consent even with unchanged selection', () => {
    const { r, owner, pin } = setup('reject'); const header = structuredClone(record()); header.origin_location_name = 'Updated';
    expect(r.review(owner, header, 201, 'reject')).not.toBeNull();
    expect(r.eligibility(owner, pin).blocker).toBe('retired');
  });
  it('does not release or settle forged, copied, foreign or consumed flights', () => {
    const { r, owner, pin, input } = setup(); const flight = r.start(pin, input)!;
    const foreign = setup(); const foreignFlight = foreign.r.start(foreign.pin, foreign.input)!;
    for (const fake of [{ ...flight }, { attempt: { ...flight.attempt } } as RestitutionFlight, foreignFlight]) {
      expect(r.finish(fake, operation())).toBe(false); r.release(fake); r.fail(fake, network);
      expect(r.isCurrent(flight, owner)).toBe(true);
    }
    r.release(flight); const retry = r.claim(owner, id, 201)!;
    expect(r.finish(flight, operation())).toBe(false); r.release(flight);
    expect(r.isCurrent(retry, owner)).toBe(true); expect(r.finish(retry, operation())).toBe(true);
    expect(r.finish(retry, operation())).toBe(false);
  });
  it('captures immutable attempts, forms, owners and exact retry payloads', () => {
    const { r, owner, pin } = setup(); const form = { ...proposalInput }; const who = { ...owner };
    const flight = r.start(pin, form)!; form.reason = 'edited'; form.expected_revision = '5'; form.retained_quantity = '9'; who.location = 3;
    r.release(flight); const retry = r.claim(owner, id, 201)!;
    expect(restitutionRetryPayload(retry.attempt)).toEqual(proposalInput);
    expect(retry.attempt.owner).toEqual(origin);
    for (const object of [flight, flight.attempt, flight.attempt.owner, flight.attempt.payload, r.get(owner, id), restitutionRetryPayload(retry.attempt)]) {
      expect(Object.isFrozen(object)).toBe(true);
    }
    expect(flight.attempt.phase).toBe('inFlight'); expect(r.eligibility(owner, pin).blocker).toBe('consumed');
  });
});

describe('split evidence dependencies', () => {
  it.each(['propose', 'accept', 'reject'] as const)('restitution invalidation immediately retires %s consent before a GET', action => {
    const { r, owner, pin, input } = setup(action);
    r.invalidate(owner, id, 'restitution'); expect(r.eligibility(owner, pin).blocker).toBe('history');
    expect(r.start(pin, input)).toBeNull();
    r.observe(owner, action === 'propose' ? emptyHistory() : proposalHistory(), true);
    expect(r.start(pin, input)).toBeNull(); expect(r.review(owner, record(), 201, action)).not.toBeNull();
  });
  it.each(['propose', 'accept'] as const)('count invalidation immediately retires %s consent', action => {
    const { r, owner, pin } = setup(action); r.invalidate(owner, id, 'count');
    expect(r.eligibility(owner, pin).blocker).toBe('count-history');
    r.observeCount(owner, emptyCount(), true);
    expect(r.eligibility(owner, pin).blocker).toBe('count-history');
    expect(r.review(owner, record(), 201, action)).not.toBeNull();
  });
  it('count unavailable, dirty, pending or mismatched does not retire rejection', () => {
    const { r, owner, pin } = setup('reject');
    r.invalidate(owner, id, 'count'); expect(r.eligibility(owner, pin).eligible).toBe(true);
    r.readFailure(owner, id, 'count', new RestitutionAPIError('service_unavailable', 503));
    expect(r.eligibility(owner, pin).eligible).toBe(true);
    r.observeCount(owner, countHistory(true), true, true); expect(r.eligibility(owner, pin).eligible).toBe(true);
    r.observeCount(owner, countHistory(true), true); expect(r.eligibility(owner, pin).eligible).toBe(true);
    expect(r.start(pin, decisionInput)).not.toBeNull();
  });
  it('header invalidation requires a new review plus restitution GET, never a count GET for reject', () => {
    const { r, owner, pin } = setup('reject'); r.invalidate(owner, id, 'header');
    expect(r.eligibility(owner, pin).blocker).toBe('header');
    expect(r.review(owner, record(), 201, 'reject')).toBeNull();
    r.observe(owner, proposalHistory(), true); expect(r.review(owner, record(), 201, 'reject')).not.toBeNull();
  });
  it.each(['propose', 'accept'] as const)('missing or nonexplicit count reads block fresh %s', action => {
    const r = createTransferRestitutionRecovery(); const owner = action === 'propose' ? origin : destination;
    r.observe(owner, action === 'propose' ? emptyHistory() : proposalHistory(), true);
    expect(r.review(owner, record(), 201, action)).toBeNull();
    r.observeCount(owner, emptyCount()); expect(r.review(owner, record(), 201, action)).toBeNull();
    r.observeCount(owner, emptyCount(), true, true); expect(r.review(owner, record(), 201, action)).toBeNull();
    r.observeCount(owner, emptyCount(), true); expect(r.review(owner, record(), 201, action)).not.toBeNull();
  });
});

describe('cross-workflow reconciliation and conservation', () => {
  function reconciled() {
    const h = structuredClone(countedRestitution()); const c = structuredClone(countHistory());
    Object.assign(h.lines[0], { effective_dispatch: 7n, reconciliation_revision: 1n, effective_credit: 6n });
    Object.assign(h.lines[0].proposals[0], { base_dispatch: 7n, base_credit: 6n });
    Object.assign(c.lines[0], { effective_dispatch: 7n, reconciliation_revision: 1n, effective_credit: 6n, effective_actual: 6n });
    // Reconciliation happened before the third count proposal; the preceding count credit was 4.
    Object.assign(c.lines[0].proposals[2], { base_credit: 7n, actual_quantity: 6n,
      application: { effective_credit: 6n, delta: -1n, recorded_at: stamp } });
    Object.assign(c.operations[3], { actual_quantity: 6n });
    return { h, c };
  }
  it('T4c uses summed cross-workflow credit and current dispatch, preserving exact acceptance retry', () => {
    const { h, c } = reconciled(); const r = createTransferRestitutionRecovery();
    r.observe(destination, h, true); r.observeCount(destination, c, true);
    const pin = r.review(destination, record(), 201, 'accept'); expect(pin).not.toBeNull();
    const flight = r.start(pin!, decisionInput)!; expect(flight).not.toBeNull(); r.release(flight);
    r.invalidate(destination, id, 'count');
    const retry = r.claim(destination, id, 201)!;
    expect(restitutionRetryPayload(retry.attempt)).toEqual(decisionInput);
    expect(r.finish(retry, operation('accept'))).toBe(true);
    expect(r.consumeConfirmations(destination)).toEqual([operation('accept')]);
    expect(r.consumeConfirmations(destination)).toEqual([]);
  });
  it.each(['dispatch', 'reconciliation', 'closed-budget', 'historical-pin'] as const)('T4c blocks %s mismatch without gating rejection', field => {
    const { h, c } = reconciled(); const r = createTransferRestitutionRecovery();
    r.observe(destination, h, true); r.observeCount(destination, c, true);
    expect(r.review(destination, record(), 201, 'accept')).not.toBeNull();
    if (field === 'dispatch') Object.assign(c.lines[0], { effective_dispatch: 8n });
    if (field === 'reconciliation') Object.assign(c.lines[0], { reconciliation_revision: 2n });
    if (field === 'closed-budget') {
      Object.assign(h.lines[0], { effective_dispatch: 6n, reconciliation_revision: 2n });
      Object.assign(c.lines[0], { effective_dispatch: 6n, reconciliation_revision: 2n });
    }
    if (field === 'historical-pin') Object.assign(h.lines[0].proposals[0], { base_dispatch: 8n });
    r.observe(destination, h, true); r.observeCount(destination, c, true);
    expect(r.review(destination, record(), 201, 'accept')).toBeNull();
    expect(r.get(destination, id)).toEqual([]); expect(r.consumeConfirmations(destination)).toEqual([]);
    const reject = r.review(destination, record(), 201, 'reject'); expect(reject).not.toBeNull();
    expect(r.start(reject!, decisionInput)).not.toBeNull();
  });
  it.each(['effective_dispatch', 'reconciliation_revision'] as const)('T4c retires prior consent when only %s changes', field => {
    const { h, c } = reconciled(); const r = createTransferRestitutionRecovery();
    r.observe(destination, h, true); r.observeCount(destination, c, true);
    const pin = r.review(destination, record(), 201, 'accept'); expect(pin).not.toBeNull();
    Object.assign(c.lines[0], { [field]: c.lines[0][field] + 1n }); r.observeCount(destination, c, true);
    expect(r.start(pin!, decisionInput)).toBeNull(); expect(r.get(destination, id)).toEqual([]);
  });
  it('T4c has no restitution budget after reconciliation without a count application', () => {
    const h = structuredClone(emptyHistory()); const c = structuredClone(emptyCount()); const header = structuredClone(record());
    Object.assign(header, { receipt: { items: [{ variant_id: 201, expected_quantity: 5n, actual_quantity: 7n, available_quantity: 5n }],
      exceptions: [{ variant_id: 201, kind: 'excess', quantity: 2n }] } });
    Object.assign(h.lines[0], { original_credit: 5n, effective_dispatch: 7n, reconciliation_revision: 1n, effective_credit: 7n });
    Object.assign(c.lines[0], { actual_quantity: 7n, available_quantity: 5n, effective_actual: 7n,
      effective_dispatch: 7n, reconciliation_revision: 1n, effective_credit: 7n });
    const r = createTransferRestitutionRecovery(); r.observe(origin, h, true); r.observeCount(origin, c, true);
    // No remaining budget: reconciliation is not proof of retained stock.
    expect(r.review(origin, header, 201, 'propose')).toBeNull(); expect(r.get(origin, id)).toEqual([]);
  });
  it('counts replacement, rejection and zero-delta acceptance as operations, not proposal revisions', () => {
    const r = createTransferRestitutionRecovery(); const history = countedRestitution();
    r.observe(destination, history, true); r.observeCount(destination, countHistory(), true);
    expect(countHistory().operations).toHaveLength(5); expect(countHistory().lines[0].workflow_revision).toBe(3n);
    expect(r.review(destination, record(), 201, 'accept')).not.toBeNull();
    const incorrect = captureRestitutions({ ...history, lines: [{ ...history.lines[0], count_generation: 3n,
      proposals: [{ ...history.lines[0].proposals[0], count_generation: 3n }] }] });
    r.observe(destination, incorrect, true); expect(r.review(destination, record(), 201, 'accept')).toBeNull();
  });
  it.each(['propose', 'accept'] as const)('pending count blocks fresh %s with matched generation and tuple', action => {
    const r = createTransferRestitutionRecovery(); const owner = action === 'propose' ? origin : destination;
    const h = countedRestitution(true);
    r.observe(owner, action === 'propose' ? captureRestitutions({ ...h, operations: [], lines: [{ ...h.lines[0], workflow_revision: 0n, proposals: [] }] }) : h, true);
    r.observeCount(owner, countHistory(true), true); expect(r.review(owner, record(), 201, action)).toBeNull();
  });
  it('rejection ignores count predecessor changes, but acceptance requires exact proposal predecessor', () => {
    const r = createTransferRestitutionRecovery(); r.observe(destination, countedRestitution(false, true), true);
    r.observeCount(destination, countHistory(), true);
    expect(r.review(destination, record(), 201, 'reject')).not.toBeNull();
    expect(r.review(destination, record(), 201, 'accept')).toBeNull();
  });
  it.each(['expected', 'applied', 'credit', 'generation', 'base', 'actor', 'decision-actor', 'missing-operation', 'duplicate-operation', 'duplicate-line', 'receipt-actual', 'available', 'delta', 'effective-actual'] as const)('refuses count %s inconsistency rather than granting consent from a label', field => {
    const r = createTransferRestitutionRecovery(); const h = countedRestitution(); const c = structuredClone(countHistory());
    r.observe(destination, h, true); r.observeCount(destination, c, true);
    expect(r.review(destination, record(), 201, 'accept')).not.toBeNull();
    const line = c.lines[0];
    if (field === 'expected') Object.assign(line, { expected_quantity: 6n, effective_dispatch: 6n });
    if (field === 'applied') Object.assign(line, { applied_revision: 2n });
    if (field === 'credit') Object.assign(line, { effective_credit: 3n });
    if (field === 'generation' || field === 'missing-operation') Object.assign(c, { operations: c.operations.slice(1) });
    if (field === 'base') Object.assign(line.proposals[2], { base_credit: 3n });
    if (field === 'actor') Object.assign(c.operations[0], { actor_location_id: 3 });
    if (field === 'decision-actor') Object.assign(c.operations[2], { actor_location_id: 2 });
    if (field === 'duplicate-operation') Object.assign(c, { operations: [...c.operations, c.operations[0]] });
    if (field === 'duplicate-line') Object.assign(c, { lines: [...c.lines, c.lines[0]] });
    if (field === 'receipt-actual') Object.assign(line, { actual_quantity: 3n });
    if (field === 'available') Object.assign(line, { available_quantity: 3n });
    if (field === 'delta') Object.assign(line.proposals[2].application!, { delta: 1n });
    if (field === 'effective-actual') Object.assign(line, { effective_actual: 3n });
    r.observeCount(destination, c, true); expect(r.review(destination, record(), 201, 'accept')).toBeNull();
  });
  it('supports count proposals initiated by either physical endpoint and decisions by the other', () => {
    const r = createTransferRestitutionRecovery(); const c = countHistory();
    const swapped = captureCountCorrections({ ...c, operations: c.operations.map(op => ({ ...op, actor_location_id: op.actor_location_id === 1 ? 2 : 1 })),
      lines: [{ ...c.lines[0], proposals: c.lines[0].proposals.map(p => ({ ...p, initiator_location_id: 1,
        decision: p.decision ? { ...p.decision, actor_location_id: 2 } : null })) }] });
    r.observe(destination, countedRestitution(), true); r.observeCount(destination, swapped, true);
    expect(r.review(destination, record(), 201, 'accept')).not.toBeNull();
  });
  it('one application even partial is terminal; current stock evidence is not fresh permission', () => {
    const r = createTransferRestitutionRecovery(); r.observe(origin, decidedHistory('accept'), true); r.observeCount(origin, emptyCount(), true);
    expect(r.review(origin, record(), 201, 'propose')).toBeNull();
    r.synchronize(destination); r.observe(destination, decidedHistory('accept'), true);
    expect(r.review(destination, record(), 201, 'accept')).toBeNull();
    expect(r.review(destination, record(), 201, 'reject')).toBeNull(); expect(r.consumeConfirmations(destination)).toEqual([]);
  });
  it('supports new proposal after rejection, and decision binds the latest revision', () => {
    const r = createTransferRestitutionRecovery(); r.observe(origin, decidedHistory('reject'), true); r.observeCount(origin, emptyCount(), true);
    const pin = r.review(origin, record(), 201, 'propose')!; expect(pin).not.toBeNull();
    expect(r.start(pin, { ...proposalInput, operation_key: 'fresh_proposal_002', expected_revision: '0' })).toBeNull();
    expect(r.start(pin, { ...proposalInput, operation_key: 'fresh_proposal_002', expected_revision: '1' })).not.toBeNull();
  });
  it('refuses proposals exceeding remaining debit, with the cap boundary as valid control', () => {
    const { r, pin } = setup();
    expect(r.start(pin, { ...proposalInput, retained_quantity: '2' })).toBeNull();
    expect(r.start(pin, proposalInput)).not.toBeNull();
  });
  it('refuses zero capacity for fresh proposals', () => {
    const { r, owner } = setup(); const h = emptyHistory();
    const noShortage = structuredClone(record()) as Extract<TransferRecord, { status: 'received' }>;
    Object.assign(noShortage, { receipt: { items: [{ variant_id: 201, expected_quantity: 5n, actual_quantity: 5n, available_quantity: 5n }], exceptions: [] } });
    r.observe(owner, captureRestitutions({ ...h, lines: [{ ...h.lines[0], original_credit: 5n, effective_credit: 5n }] }), true);
    r.observeCount(owner, captureCountCorrections({ ...emptyCount(), lines: [{ ...emptyCount().lines[0], actual_quantity: 5n, available_quantity: 5n, effective_actual: 5n, effective_credit: 5n }] }), true);
    expect(r.review(owner, noShortage, 201, 'propose')).toBeNull();
  });
});

describe('normalization and exact operation identity', () => {
  it.each([
    ['variant', { variant_id: 202 }, false], ['key', { operation_key: 'bad' }, true],
    ['revision', { expected_revision: '1' }, false], ['noncanonical-revision', { expected_revision: '00' }, true],
    ['quantity', { retained_quantity: '0' }, true], ['noncanonical-quantity', { retained_quantity: '01' }, true],
    ['attestation', { retained_at_origin: false }, true], ['empty-reason', { reason: '   ' }, true],
    ['surrogate', { reason: '\ud800' }, true], ['nul', { reason: 'a\0b' }, true],
    ['unknown-field', { secret: 'not retained' }, true],
  ] as const)('validates %s before consuming a reviewed pin', (_name, patch, throws) => {
    const { r, pin } = setup(); const bad = { ...proposalInput, ...patch } as typeof proposalInput;
    if (throws) expect(() => r.start(pin, bad)).toThrow(); else expect(r.start(pin, bad)).toBeNull();
    expect(r.start(pin, proposalInput)).not.toBeNull();
  });
  it.each(['request_id', 'actor_location_id', 'reason', 'retained_quantity', 'retained_at_origin', 'operation_key', 'variant_id', 'action', 'expected_revision', 'unknown-field', 'unsafe-number'] as const)('refuses injected operation %s without consuming the real flight', field => {
    const { r, owner, pin, input } = setup(); const flight = r.start(pin, input)!;
    const op = { ...operation() };
    if (field === 'request_id') Object.assign(op, { request_id: 2n });
    if (field === 'actor_location_id') Object.assign(op, { actor_location_id: 2 });
    if (field === 'reason') Object.assign(op, { reason: 'retained at origin' });
    if (field === 'retained_quantity') Object.assign(op, { retained_quantity: 2n });
    if (field === 'retained_at_origin') Object.assign(op, { retained_at_origin: false });
    if (field === 'operation_key') Object.assign(op, { operation_key: 'other_operation_01' });
    if (field === 'variant_id') Object.assign(op, { variant_id: 202 });
    if (field === 'action') Object.assign(op, { action: 'reject', retained_quantity: null, retained_at_origin: null });
    if (field === 'expected_revision') Object.assign(op, { expected_revision: 1n, revision: 2n });
    if (field === 'unknown-field') Object.assign(op, { extra: true });
    if (field === 'unsafe-number') Object.assign(op, { request_id: Number(id) });
    expect(() => r.finish(flight, op)).toThrow(); expect(r.isCurrent(flight, owner)).toBe(true);
    expect(r.finish(flight, operation())).toBe(true);
  });
  it('decision input cannot carry proposal-only fields or a changed reviewed revision', () => {
    const { r, pin } = setup('accept');
    expect(() => r.start(pin, { ...decisionInput, retained_quantity: '1', retained_at_origin: true })).toThrow();
    expect(r.start(pin, { ...decisionInput, expected_revision: '0' })).toBeNull();
    expect(r.start(pin, decisionInput)).not.toBeNull();
  });
});

describe('sticky write certainty and independent read privacy', () => {
  it.each([
    new RestitutionAPIError('network', null, true), new RestitutionAPIError('aborted', null, true),
    new RestitutionAPIError('service_unavailable', 503, true), new RestitutionAPIError('invalid_response', 200, true),
  ])('retains $code uncertainty through missing/failed reads and later definite errors', failure => {
    const { r, owner, pin, input } = setup(); const flight = r.start(pin, input)!; r.fail(flight, failure);
    r.observe(owner, emptyHistory(), true); r.readFailure(owner, id, 'restitution', new RestitutionAPIError('service_unavailable', 503));
    expect(r.get(owner, id)[0].priorUncertainty).toBe(true);
    const retry = r.claim(owner, id, 201)!; expect(retry).not.toBeNull();
    r.fail(retry, new RestitutionAPIError('decision_conflict', 409));
    expect(r.get(owner, id)[0].phase).toBe('uncertain'); expect(r.get(owner, id)[0].priorUncertainty).toBe(true);
    expect(r.review(owner, record(), 201, 'propose')).toBeNull();
  });
  it.each([new RestitutionAPIError('invalid_request', 400), new RestitutionAPIError('decision_conflict', 409),
    new RestitutionAPIError('insufficient_stock', 409)])('initial definite $code permits only a new reviewed key, not same-key fresh writes', failure => {
    const { r, owner, pin, input } = setup(); const flight = r.start(pin, input)!; r.fail(flight, failure);
    expect(r.get(owner, id)[0].phase).toBe('failed'); expect(r.get(owner, id)[0].priorUncertainty).toBe(false);
    expect(r.claim(owner, id, 201)).toBeNull();
    const fresh = r.review(owner, record(), 201, 'propose')!; expect(fresh).not.toBeNull();
    expect(r.start(fresh, proposalInput)).toBeNull();
    expect(r.start(fresh, { ...proposalInput, operation_key: 'fresh_proposal_002' })).not.toBeNull();
  });
  it('the restitution uncertainty flag wins even for an otherwise definite 409', () => {
    const { r, owner, pin, input } = setup(); const flight = r.start(pin, input)!;
    r.fail(flight, new RestitutionAPIError('decision_conflict', 409, true));
    expect(r.get(owner, id)[0].phase).toBe('uncertain');
  });
  it('unknown same-key conflicting payload remains distinct from an exact immutable retry', () => {
    const { r, owner, pin } = setup(); const flight = r.start(pin, { ...proposalInput, reason: 'different consent' })!;
    r.fail(flight, new RestitutionAPIError('retry_conflict', 409)); r.observe(owner, proposalHistory(), true);
    expect(r.get(owner, id)[0].phase).toBe('conflict'); expect(r.get(owner, id)[0].result).toBeNull();
    expect(r.consumeConfirmations(owner)).toEqual([]); expect(r.review(owner, record(), 201, 'propose')).toBeNull();
    const retry = r.claim(owner, id, 201)!; expect(restitutionRetryPayload(retry.attempt).reason).toBe('different consent');
  });
  it.each([403, 404])('GET %s masks private evidence without proving write failure or enabling consent', status => {
    const { r, owner, pin, input } = setup(); const flight = r.start(pin, input)!; r.fail(flight, network);
    r.readFailure(owner, id, 'restitution', new RestitutionAPIError(status === 403 ? 'forbidden' : 'not_found', status));
    expect(r.isRequestMasked(owner, id)).toBe(true); expect(r.get(owner, id)).toEqual([]);
    expect(r.claim(owner, id, 201)).toBeNull(); expect(r.review(owner, record(), 201, 'propose')).toBeNull();
    r.observe(owner, proposalHistory()); expect(r.get(owner, id)).toEqual([]); expect(r.consumeConfirmations(owner)).toEqual([]);
    r.observe(owner, emptyHistory(), true); expect(r.get(owner, id)[0].priorUncertainty).toBe(true);
    expect(r.review(owner, record(), 201, 'propose')).toBeNull(); expect(r.claim(owner, id, 201)).not.toBeNull();
  });
  it.each([403, 404])('POST %s masks and fences an old flight independently of retry uncertainty', status => {
    const { r, owner, pin, input } = setup(); const flight = r.start(pin, input)!;
    r.fail(flight, new RestitutionAPIError(status === 403 ? 'forbidden' : 'not_found', status));
    expect(r.get(owner, id)).toEqual([]); expect(r.finish(flight, operation())).toBe(false);
    r.observe(owner, proposalHistory(), true); expect(r.get(owner, id)[0].phase).toBe('confirmed');
    expect(r.consumeConfirmations(owner)).toEqual([operation()]);
  });
  it('GET 503 cannot erase known success, but blocks fresh consent until explicit clean evidence', () => {
    const { r, owner, pin, input } = setup(); const flight = r.start(pin, input)!; r.finish(flight, operation());
    r.readFailure(owner, id, 'restitution', new RestitutionAPIError('service_unavailable', 503));
    r.observe(owner, emptyHistory(), false, true);
    expect(r.get(owner, id)[0].phase).toBe('confirmed'); expect(r.get(owner, id)[0].result).toEqual(operation());
    expect(r.review(owner, record(), 201, 'propose')).toBeNull(); expect(r.claim(owner, id, 201)).toBeNull();
  });
  it('retains only a frozen typed failure, never arbitrary transport properties', () => {
    const { r, owner, pin, input } = setup(); const flight = r.start(pin, input)!;
    const failure = Object.assign(new RestitutionAPIError('network', null, true), { credential: 'not retained' });
    r.fail(flight, failure); const captured = r.get(owner, id)[0].failure!;
    expect(captured).not.toBe(failure); expect(Object.isFrozen(captured)).toBe(true); expect(captured).not.toHaveProperty('credential');
  });
});

describe('exact historical recovery and once-only confirmation', () => {
  it.each(['propose', 'accept', 'reject'] as const)('confirms only locally captured exact %s, even from dirty historical reads', action => {
    const { r, owner, pin, input } = setup(action); const flight = r.start(pin, input)!; r.release(flight);
    const history = action === 'propose' ? proposalHistory() : decidedHistory(action);
    r.observe(owner, history, false, true);
    expect(r.get(owner, id)[0].phase).toBe('confirmed'); expect(r.get(owner, id)[0].result).toEqual(operation(action));
    expect(r.consumeConfirmations(owner)).toEqual([operation(action)]); expect(r.consumeConfirmations(owner)).toEqual([]);
    r.observe(owner, history, true); expect(r.consumeConfirmations(owner)).toEqual([]);
    expect(r.finish(flight, operation(action))).toBe(false); expect(r.consumeConfirmations(owner)).toEqual([]);
  });
  it.each(['propose', 'accept', 'reject'] as const)('exact %s retry bypasses only fresh consent, not owner fences', action => {
    const { r, owner, pin, input } = setup(action); const flight = r.start(pin, input)!; r.fail(flight, network);
    r.invalidate(owner, id, 'header'); r.invalidate(owner, id, 'count');
    r.observeCount(owner, countHistory(true), true, true);
    expect(r.review(owner, record(), 201, action)).toBeNull();
    const retry = r.claim(owner, id, 201)!; expect(retry).not.toBeNull();
    expect(restitutionRetryPayload(retry.attempt)).toEqual(input);
    expect(r.finish(retry, operation(action))).toBe(true); expect(r.consumeConfirmations(owner)).toEqual([operation(action)]);
  });
  it('GET before POST completion confirms once and consumes the outstanding flight', () => {
    const { r, owner, pin, input } = setup(); const flight = r.start(pin, input)!;
    r.observe(owner, proposalHistory(), true); expect(r.isCurrent(flight, owner)).toBe(false);
    expect(r.finish(flight, operation())).toBe(false); expect(r.consumeConfirmations(owner)).toEqual([operation()]);
    expect(r.consumeConfirmations(owner)).toEqual([]);
  });
  it('replayed immutable key via POST settles once, late finish and later GET cannot repeat effects', () => {
    const { r, owner, pin, input } = setup('accept'); const flight = r.start(pin, input)!; r.release(flight);
    const retry = r.claim(owner, id, 201)!; const result = structuredClone(operation('accept'));
    expect(r.finish(retry, result)).toBe(true); Object.assign(result, { source_existing_after: 99n });
    expect(r.get(owner, id)[0].result?.source_existing_after).toBe(11n);
    r.observe(owner, decidedHistory('accept'), true); expect(r.finish(retry, operation('accept'))).toBe(false);
    const events = r.consumeConfirmations(owner); expect(events).toEqual([operation('accept')]);
    expect(Object.isFrozen(events)).toBe(true); expect(Object.isFrozen(events[0])).toBe(true);
    expect(r.consumeConfirmations(owner)).toEqual([]);
  });
  it('never confirms unsolicited historical operations or mismatched local payloads', () => {
    const r = createTransferRestitutionRecovery(); r.observe(origin, proposalHistory(), true);
    expect(r.consumeConfirmations(origin)).toEqual([]);
    const local = setup(); const flight = local.r.start(local.pin, { ...proposalInput, reason: 'changed bytes' })!; local.r.release(flight);
    local.r.observe(local.owner, proposalHistory(), true); expect(local.r.get(local.owner, id)[0].result).toBeNull();
    expect(local.r.consumeConfirmations(local.owner)).toEqual([]);
  });
  it('busy and unresolved entries prohibit fresh keys while other selected variants remain independent', () => {
    const { r, owner, pin, input } = setup(); const unusedPin = r.review(owner, record(), 201, 'propose')!;
    const flight = r.start(pin, input)!;
    expect(r.eligibility(owner, unusedPin).blocker).toBe('busy');
    expect(r.start(unusedPin, { ...proposalInput, operation_key: 'fresh_proposal_002' })).toBeNull();
    r.release(flight); expect(r.eligibility(owner, unusedPin).blocker).toBe('unresolved');
    expect(r.review(owner, record(), 201, 'propose')).toBeNull();
    expect(r.claim(owner, 2n, 201)).toBeNull(); expect(r.claim(owner, id, 202)).toBeNull();
    expect(r.claim(owner, id, 201)).not.toBeNull();
  });
  it('read masking preserves known success and its unconsumed private confirmation until unmask', () => {
    const { r, owner, pin, input } = setup(); r.finish(r.start(pin, input)!, operation());
    r.mask(owner, id); expect(r.get(owner, id)).toEqual([]); expect(r.consumeConfirmations(owner)).toEqual([]);
    r.observe(owner, emptyHistory(), true); expect(r.get(owner, id)[0].phase).toBe('confirmed');
    expect(r.get(owner, id)[0].result).toEqual(operation()); expect(r.consumeConfirmations(owner)).toEqual([operation()]);
    r.observe(owner, proposalHistory(), true); expect(r.consumeConfirmations(owner)).toEqual([]);
    expect(r.review(owner, record(), 201, 'propose')).not.toBeNull();
  });
});

describe('alternate and historical controls', () => {
  it('incomplete clean GET preserves known success but cannot establish fresh consent', () => {
    const { r, owner, pin, input } = setup(); r.finish(r.start(pin, input)!, operation());
    r.observe(owner, emptyHistory(), true);
    expect(r.get(owner, id)[0].phase).toBe('confirmed'); expect(r.get(owner, id)[0].result).toEqual(operation());
    expect(r.review(owner, record(), 201, 'propose')).toBeNull();
    r.observe(owner, proposalHistory(), true); expect(r.review(owner, record(), 201, 'propose')).not.toBeNull();
  });
  it('latest proposal replacement retires reviewed identity while preserving exact earlier-key confirmation', () => {
    const { r, owner, pin, input } = setup(); const flight = r.start(pin, input)!; r.release(flight);
    const h = proposalHistory(); const old = h.lines[0].proposals[0];
    const newOp = { ...h.operations[0], operation_key: 'retained_proposal_02', expected_revision: 1n, revision: 2n, reason: 'second review' };
    const successor = captureRestitutions({ ...h, operations: [...h.operations, newOp], lines: [{ ...h.lines[0], workflow_revision: 2n,
      proposals: [{ ...old, state: 'superseded' }, { ...old, revision: 2n, base_revision: 1n,
        operation_key: newOp.operation_key, reason: newOp.reason }] }] });
    const destinationCore = setup('accept'); destinationCore.r.observe(destinationCore.owner, successor, true);
    expect(destinationCore.r.eligibility(destinationCore.owner, destinationCore.pin).blocker).toBe('history');
    const newPin = destinationCore.r.review(destinationCore.owner, record(), 201, 'accept')!;
    expect(newPin).not.toBeNull(); expect(destinationCore.r.start(newPin, decisionInput)).toBeNull();
    expect(destinationCore.r.start(newPin, { ...decisionInput, expected_revision: '2' })).not.toBeNull();
    r.observe(owner, successor, false, true); expect(r.consumeConfirmations(owner)).toEqual([operation()]);
    expect(r.get(owner, id)[0].result?.revision).toBe(1n);
  });
  it('partial application still forbids another application despite a remaining shortage', () => {
    const r = createTransferRestitutionRecovery(); const h = decidedHistory('accept'); const header = structuredClone(record()) as Extract<TransferRecord, { status: 'received' }>;
    header.items[0].quantity = 6n;
    Object.assign(header, { receipt: { items: [{ variant_id: 201, expected_quantity: 6n, actual_quantity: 4n, available_quantity: 4n }],
      exceptions: [{ variant_id: 201, kind: 'shortage', quantity: 2n }] } });
    const partial = captureRestitutions({ ...h, lines: [{ ...h.lines[0], expected_quantity: 6n, effective_dispatch: 6n,
      proposals: h.lines[0].proposals.map(p => ({ ...p, base_dispatch: 6n })) }] });
    const count = captureCountCorrections({ ...emptyCount(), lines: [{ ...emptyCount().lines[0], expected_quantity: 6n, effective_dispatch: 6n }] });
    r.observe(origin, partial, true); r.observeCount(origin, count, true);
    expect(partial.lines[0].expected_quantity - partial.lines[0].effective_credit - partial.lines[0].applied_retained_quantity).toBe(1n);
    expect(r.review(origin, header, 201, 'propose')).toBeNull();
  });
  it('changed effective credit blocks acceptance but never introduces an artificial reject guard', () => {
    const r = createTransferRestitutionRecovery(); const h = countedRestitution(false, true); const c = structuredClone(countHistory());
    Object.assign(c.lines[0].proposals[2], { actual_quantity: 5n, application: { effective_credit: 5n, delta: 1n, recorded_at: stamp } });
    Object.assign(c.operations[3], { actual_quantity: 5n }); Object.assign(c.lines[0], { effective_actual: 5n, effective_credit: 5n });
    r.observeCount(destination, c, true);
    r.observe(destination, captureRestitutions({ ...h, lines: [{ ...h.lines[0], effective_credit: 5n }] }), true);
    expect(r.review(destination, record(), 201, 'accept')).toBeNull();
    expect(r.review(destination, record(), 201, 'reject')).not.toBeNull();
  });
  it('keeps independent attempts per variant and request while selection retires only fresh pins', () => {
    const { r, owner, pin, input } = setup(); const first = r.start(pin, input)!; r.release(first);
    const h = emptyHistory(); const c = emptyCount(); const header = structuredClone(record()) as Extract<TransferRecord, { status: 'received' }>;
    header.items.push({ ...header.items[0], variant_id: 202 });
    Object.assign(header, { receipt: { items: [...header.receipt.items, { ...header.receipt.items[0], variant_id: 202 }],
      exceptions: [...header.receipt.exceptions, { ...header.receipt.exceptions[0], variant_id: 202 }] } });
    r.observe(owner, captureRestitutions({ ...h, lines: [...h.lines, { ...h.lines[0], variant_id: 202 }] }), true);
    r.observeCount(owner, captureCountCorrections({ ...c, lines: [...c.lines, { ...c.lines[0], variant_id: 202 }] }), true);
    const secondPin = r.review(owner, header, 202, 'propose')!; expect(secondPin).not.toBeNull();
    const second = r.start(secondPin, { ...proposalInput, variant_id: 202, operation_key: 'variant_202_key_01' })!; r.release(second);
    const thirdHeader = structuredClone(record()); Object.assign(thirdHeader, { id: '2', reference: 'TR-002' });
    r.observe(owner, captureRestitutions({ ...h, request_id: 2n }), true);
    r.observeCount(owner, captureCountCorrections({ ...c, request_id: 2n }), true);
    const thirdPin = r.review(owner, thirdHeader, 201, 'propose')!;
    const third = r.start(thirdPin, { ...proposalInput, operation_key: 'request_002_key_01' })!; r.release(third);
    expect(r.get(owner, id).map(a => a.payload.variant_id)).toEqual([201, 202]); expect(r.get(owner, 2n)).toHaveLength(1);
    expect(r.claim(owner, id, 201)).not.toBeNull(); expect(r.claim(owner, id, 202)).not.toBeNull(); expect(r.claim(owner, 2n, 201)).not.toBeNull();
  });
  it('captures caller-owned owner data before later mutation', () => {
    const r = createTransferRestitutionRecovery(); const who = { ...origin };
    r.observe(who, emptyHistory(), true); r.observeCount(who, emptyCount(), true);
    const pin = r.review(who, structuredClone(record()), 201, 'propose')!; const flight = r.start(pin, proposalInput)!;
    who.account = 99; who.location = 3; who.epoch = 9; who.generation = 9;
    expect(flight.attempt.owner).toEqual(origin); expect(r.isCurrent(flight, origin)).toBe(true);
  });
  it('malformed history cannot publish confirmations or overwrite a valid existing flight', () => {
    const { r, owner, pin, input } = setup(); const flight = r.start(pin, input)!;
    const h = proposalHistory();
    expect(() => r.observe(owner, { ...h, operations: [{ ...h.operations[0], request_id: 2n }] }, true)).toThrow();
    expect(r.isCurrent(flight, owner)).toBe(true); expect(r.consumeConfirmations(owner)).toEqual([]);
    r.observe(owner, proposalHistory(), true); expect(r.consumeConfirmations(owner)).toEqual([operation()]);
  });
});

describe('retained evidence across successive attempts', () => {
  it('cannot erase an earlier confirmed proposal by replacing its attempt and reading incomplete history', () => {
    const { r, owner, pin, input } = setup(); r.finish(r.start(pin, input)!, operation()); r.consumeConfirmations(owner);
    r.observe(owner, proposalHistory(), true);
    const replacement = r.review(owner, record(), 201, 'propose')!;
    const flight = r.start(replacement, { ...proposalInput, operation_key: 'retained_proposal_02', expected_revision: '1' })!;
    r.fail(flight, new RestitutionAPIError('invalid_request', 400));
    r.observe(owner, emptyHistory(), true);
    expect(r.get(owner, id)[0].phase).toBe('failed'); expect(r.review(owner, record(), 201, 'propose')).toBeNull();
    r.observe(owner, proposalHistory(), true); expect(r.review(owner, record(), 201, 'propose')).not.toBeNull();
    expect(r.consumeConfirmations(owner)).toEqual([]);
  });
  it('fresh consent cannot reuse an operation key already observed in history', () => {
    const { r, owner } = setup('reject');
    const pin = r.review(owner, record(), 201, 'reject')!;
    expect(r.start(pin, { ...decisionInput, operation_key: proposalInput.operation_key })).toBeNull();
    expect(r.start(pin, decisionInput)).not.toBeNull();
  });
});

describe('reentrant notification owner fences', () => {
  it('stops publication and returns no flight after a start subscriber replaces the owner', () => {
    const { r, owner, pin, input } = setup(); let later = 0;
    r.subscribe(() => r.synchronize({ ...owner, generation: 2 })); r.subscribe(() => { later++; });
    expect(r.start(pin, input)).toBeNull(); expect(later).toBe(0); expect(r.get(owner, id)).toEqual([]);
  });
  it.each(['finish', 'observe'] as const)('retires queued private confirmation when a %s subscriber replaces the owner', method => {
    const { r, owner, pin, input } = setup(); const flight = r.start(pin, input)!; let later = 0;
    r.subscribe(() => r.synchronize(null)); r.subscribe(() => { later++; });
    if (method === 'finish') expect(r.finish(flight, operation())).toBe(false);
    else r.observe(owner, proposalHistory(), true);
    expect(later).toBe(0); expect(r.consumeConfirmations(owner)).toEqual([]); expect(r.get(owner, id)).toEqual([]);
  });
  it('rechecks owner capability after capturing caller-owned form getters', () => {
    const { r, owner, pin } = setup();
    const input = { ...proposalInput, get reason() { r.synchronize({ ...owner, generation: 2 }); return proposalInput.reason; } };
    expect(r.start(pin, input)).toBeNull(); expect(r.get(owner, id)).toEqual([]);
  });
  it('rechecks flights after capturing injected result getters', () => {
    const { r, owner, pin, input } = setup(); const flight = r.start(pin, input)!;
    const result = { ...operation(), get reason() { r.synchronize(null); return proposalInput.reason; } };
    expect(r.finish(flight, result)).toBe(false); expect(r.consumeConfirmations(owner)).toEqual([]);
  });
  it('isolates throwing and detached subscribers without duplicate confirmations', () => {
    const { r, owner, pin, input } = setup(); let calls = 0;
    const unsubscribe = r.subscribe(() => { throw new Error('detached'); });
    r.subscribe(() => { calls++; }); const flight = r.start(pin, input)!; unsubscribe();
    r.finish(flight, operation()); expect(calls).toBe(2); expect(r.consumeConfirmations(owner)).toHaveLength(1);
  });
});
