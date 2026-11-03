import { expect, it } from 'vitest';
import { parseTransferRecord, parseTransferPage, parseTransferCounts, validateTransferActions } from './transferModel';

const record = {
  id: '1', reference: 'TR-001', kind: 'request_stock', status: 'received',
  creator_location_id: 2, creator_location_name: 'Destination', origin_location_id: 1, origin_location_name: 'Origin',
  destination_location_id: 2, destination_location_name: 'Destination', approver_location_id: 1, approver_location_name: 'Origin',
  created_at: '2026-04-01T00:00:00Z', decision_location_id: 1, decided_at: '2026-04-01T00:00:01Z',
  dispatch_location_id: 1, dispatched_at: '2026-04-01T00:00:02Z', receipt_location_id: 2, received_at: '2026-04-01T00:00:03Z',
  items: [{ variant_id: 1, brand: 'B', model: 'M', capacity_ah: '35', polarity: 'L', quantity: '10' }],
  receipt: { items: [{ variant_id: 1, expected_quantity: '10', actual_quantity: '8', available_quantity: '8' }],
    exceptions: [{ variant_id: 1, kind: 'shortage', quantity: '2' }] },
};
const event = { category: 'unified', action: 'propose', actor: { account_id: '9007199254740993', username: '<ana>', display_name: '' },
  location_id: 1, location_name: 'Origin', recorded_at: '2026-04-01T00:00:04.123456789Z', variant_id: 1 };
const decode = (activity: unknown) => parseTransferRecord(JSON.stringify({ ...record, activity }));

it('admits all unified personal actions at either endpoint without rewriting original quantities', () => {
  for (const location_id of [1, 2]) for (const action of ['propose', 'accept', 'reject']) {
    const value = { ...event, location_id, action };
    const decoded = decode([value]);
    expect(decoded.activity).toEqual([value]);
    expect(Object.isFrozen(decoded.activity?.[0].actor)).toBe(true);
    expect(decoded.items[0].quantity).toBe(10n);
    expect(decoded.status === 'received' && decoded.receipt.items[0].actual_quantity).toBe(8n);
  }
});
it('uses the existing strict personal actor, participant, timestamp and variant boundary', () => {
  for (const patch of [{ category: 'unrecognized' }, { action: 'receive' }, { location_id: 3 }, { variant_id: undefined },
    { variant_id: 0 }, { recorded_at: 'yesterday' }, { recorded_at: '2026-03-31T00:00:00Z' },
    { actor: { ...event.actor, account_id: '01' } }, { actor: { ...event.actor, username: '' } },
    { actor: { ...event.actor, display_name: '\0' } }, { secret: true }]) {
    expect(() => decode([{ ...event, ...patch }])).toThrow('Invalid transfer response');
  }
});
it('preserves every legacy personal category through the same validator', () => {
  for (const category of ['count', 'restitution', 'reconciliation']) {
    expect(decode([{ ...event, category }]).activity?.[0].category).toBe(category);
  }
  expect(decode([{ ...event, category: 'transfer', action: 'receive', variant_id: undefined }]).activity?.[0].action).toBe('receive');
});
it('appends unified review advice in strict order for either participant and keeps lossless union counts', () => {
  const reason = 'review_unified_reconciliation';
  const page = (values = [reason]) => JSON.stringify({ page: 1, page_size: 25, status: 'all', total_count: '1', records: [record],
    requires_action: true, required_actions: { '1': values } });
  const parsed = parseTransferPage(page());
  expect(() => validateTransferActions(parsed, 2)).not.toThrow();
  const bilateral = parseTransferPage(page([reason]));
  for (const assigned of [1, 2]) expect(() => validateTransferActions(bilateral, assigned)).not.toThrow();
  for (const values of [[reason, 'receive'], [reason, reason], ['review_count'], ['unknown']]) expect(() => parseTransferPage(page(values))).toThrow();
  const actions = Object.fromEntries(['approve', 'dispatch', 'receive', reason].map(key => [key, '9007199254740993']));
  expect(parseTransferCounts(JSON.stringify({ pending_total: '0', action_count: '9007199254740993', actions })).actions?.review_unified_reconciliation).toBe(9007199254740993n);
  for (const value of ['9007199254740994', '01', 1, undefined]) {
    expect(() => parseTransferCounts(JSON.stringify({ pending_total: '0', action_count: '9007199254740993',
      actions: { ...actions, review_unified_reconciliation: value } }))).toThrow();
  }
  expect(parseTransferCounts('{"pending_total":"0","action_count":"0"}')).not.toHaveProperty('actions');
});
