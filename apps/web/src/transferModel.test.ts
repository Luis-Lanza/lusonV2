import { describe, expect, it } from 'vitest';
import {
  canonicalTransferReceiptInput, previewTransferReceipt, canonicalTransferInput, newTransferRetryKey, parseTransferPage, parseTransferRecord, parseTransferCounts,
  transferDetailPath, transferDirection, transferListPath, transferQuantityTotal,
  type TransferCreateInput, type TransferFlow,
} from './transferModel';

// Flat DTO fixture matches httpapi.transferDTO, not the inventory wire format.
export function wireRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: '9007199254740993', reference: 'TR-9007199254740993', kind: 'request_stock', status: 'pending',
    creator_location_id: 2, creator_location_name: 'Sucursal A',
    origin_location_id: 1, origin_location_name: 'Almacén',
    destination_location_id: 2, destination_location_name: 'Sucursal A',
    approver_location_id: 1, approver_location_name: 'Almacén', created_at: '2026-04-02T12:34:56.123456789Z',
    items: [{ variant_id: 2147483647, brand: 'Brand', model: 'Model', capacity_ah: '0.000001', polarity: 'L', quantity: '9223372036854775807' }],
    ...overrides,
  };
}
export function createInput(): TransferCreateInput {
  return { kind: 'request_stock', counterparty_location_id: 1, retry_key: 'opaque_key_000001',
    items: [{ variant_id: 201, quantity: '9007199254740993' }, { variant_id: 1, quantity: '2' }] };
}
const parse = (o: unknown) => parseTransferRecord(JSON.stringify(o));

export function dispatchWire(overrides: Record<string, unknown> = {}) {
  return wireRecord({ status: 'in_transit', decision_location_id: 1,
    decided_at: '2026-04-03T00:00:00.000000001Z', dispatch_location_id: 1,
    dispatched_at: '2026-04-03T00:00:00.000000002Z', ...overrides });
}
export function receiptWire(overrides: Record<string, unknown> = {}) {
  return { ...dispatchWire(), status: 'received', receipt_location_id: 2,
    received_at: '2026-04-03T00:00:00.000000003Z',
    receipt: { items: [{ variant_id: 2147483647, expected_quantity: '9223372036854775807',
      actual_quantity: '9007199254740993', available_quantity: '9007199254740993' }],
    exceptions: [{ variant_id: 2147483647, kind: 'shortage', quantity: '9214364837600034814' }] }, ...overrides };
}

// C1 emits cancellation metadata, not a fabricated rejection or approval.
export function cancellationWire(approved = false, overrides: Record<string, unknown> = {}) {
  return wireRecord({ status: 'cancelled', cancellation_location_id: 2,
    cancelled_at: '2026-04-03T00:00:00.000000002Z',
    ...(approved ? { decision_location_id: 1, decided_at: '2026-04-03T00:00:00.000000001Z' } : {}),
    ...overrides });
}

describe('W2 direct shipment wire contract', () => {
  const direct = (destination: number, overrides: Record<string, unknown> = {}) => wireRecord({
    kind: 'direct_shipment', status: 'approved', creator_location_id: 1, creator_location_name: 'Almacén',
    destination_location_id: destination, destination_location_name: destination === 2 ? 'Sucursal A' : 'Sucursal B',
    decision_location_id: 1, decided_at: wireRecord().created_at, ...overrides,
  });
  it.each([2, 3])('admits reserved creation for destination %s with lossless frozen quantities', destination => {
    const wire = direct(destination);
    const record = parse(wire);
    expect(record).toMatchObject({ kind: 'direct_shipment', status: 'approved', creator_location_id: 1,
      origin_location_id: 1, destination_location_id: destination, approver_location_id: 1,
      decision_location_id: 1, decided_at: wire.created_at });
    expect(record.items[0].quantity).toBe(9223372036854775807n);
    for (const value of [record, record.items, record.items[0]]) expect(Object.isFrozen(value)).toBe(true);
    expect(record).not.toHaveProperty('dispatched_at');
    const page = parseTransferPage(JSON.stringify({ page: 1, page_size: 10, status: 'approved',
      total_count: '1', records: [wire] }));
    expect(page.records[0]).toEqual(record);
  });
  it.each([2, 3])('retains creation authorization through cancellation and transit for destination %s', destination => {
    for (const patch of [
      { status: 'cancelled', cancellation_location_id: 1, cancelled_at: '2026-04-03T00:00:00Z' },
      { status: 'in_transit', dispatch_location_id: 1, dispatched_at: '2026-04-03T00:00:00Z' },
    ]) {
      const record = parse(direct(destination, patch));
      expect(record).toMatchObject({ ...patch, creator_location_id: 1, decided_at: record.created_at });
      expect(record.items[0].quantity).toBe(9223372036854775807n);
    }
  });
  it.each([2, 3])('validates immutable direct receipt and original creation authorization for destination %s', destination => {
    const received = direct(destination, { status: 'received', dispatch_location_id: 1,
      dispatched_at: '2026-04-03T00:00:00.000000001Z', receipt_location_id: destination,
      received_at: '2026-04-03T00:00:00.000000002Z', receipt: receiptWire().receipt });
    const record = parse(received);
    expect(record.status).toBe('received'); expect(record.creator_location_id).toBe(1);
    expect(record.decided_at).toBe(record.created_at);
    if (record.status !== 'received') throw new Error('Expected receipt');
    expect(record.receipt.items[0].actual_quantity).toBe(9007199254740993n);
    for (const patch of [{ receipt_location_id: 1 }, { decision_location_id: destination },
      { decided_at: '2026-04-03T00:00:00.000000001Z' }, { creator_location_id: destination }, { dispatch_location_id: destination }])
      expect(() => parse({ ...received, ...patch })).toThrow('Invalid transfer response');
  });
  it('rejects direct pending and rejected states, invalid participants and fabricated authorization', () => {
    for (const patch of [
      { status: 'pending', decision_location_id: undefined, decided_at: undefined },
      { status: 'rejected' }, { destination_location_id: 1 },
      { creator_location_id: 2 }, { origin_location_id: 2 }, { approver_location_id: 2 },
      { decision_location_id: undefined }, { decided_at: undefined },
      { decision_location_id: null }, { decision_location_id: '1' }, { decision_location_id: 2 },
      { decided_at: '2026-04-02T12:34:56.123456788Z' },
      { decided_at: '2026-04-02T12:34:56.123456790Z' },
      { status: 'cancelled', cancellation_location_id: 1, cancelled_at: '2026-04-03T00:00:00Z',
        decision_location_id: undefined, decided_at: undefined },
    ]) expect(() => parse(direct(2, patch))).toThrow('Invalid transfer response');
  });
});

describe('C2 cancelled wire contract', () => {
  it.each([false, true])('preserves immutable original identity and optional approval (approved=%s)', approved => {
    const wire = cancellationWire(approved);
    const decoded = parse(wire);
    expect(decoded).toMatchObject({ id: wire.id, reference: wire.reference, status: 'cancelled',
      created_at: wire.created_at, cancellation_location_id: 2, cancelled_at: '2026-04-03T00:00:00.000000002Z' });
    expect(decoded.items[0]).toMatchObject({ quantity: 9223372036854775807n, capacity_ah: '0.000001' });
    if (approved) expect(decoded).toMatchObject({ decision_location_id: 1, decided_at: '2026-04-03T00:00:00.000000001Z' });
    else {
      expect(decoded).not.toHaveProperty('decision_location_id');
      expect(decoded).not.toHaveProperty('decided_at');
    }
    for (const value of [decoded, decoded.items, decoded.items[0]]) expect(Object.isFrozen(value)).toBe(true);
    for (const field of ['dispatch_location_id', 'dispatched_at', 'receipt_location_id', 'received_at', 'receipt']) {
      expect(decoded).not.toHaveProperty(field);
    }
  });
  it.each([2, 3])('derives cancellation authority from creator %s in all three flows', creator => {
    for (const flow of ['requestWarehouse', 'requestOther', 'sendWarehouse'] as const) {
      const direction = transferDirection(creator, flow);
      const { counterparty_location_id: _counterparty, ...participants } = direction;
      for (const approved of [false, true]) {
        const wire = cancellationWire(approved, { ...participants, cancellation_location_id: creator,
          ...(approved ? { decision_location_id: direction.approver_location_id } : {}) });
        expect(parse(wire)).toMatchObject({ status: 'cancelled', creator_location_id: creator,
          cancellation_location_id: creator, origin_location_id: direction.origin_location_id,
          destination_location_id: direction.destination_location_id });
      }
    }
  });
  it.each([false, true])('filters cancelled pages and rejects mismatched or duplicate records (approved=%s)', approved => {
    const wire = cancellationWire(approved);
    expect(transferListPath({ status: 'cancelled' as never })).toBe('/api/transfers?page=1&page_size=25&status=cancelled');
    const page = { page: 1, page_size: 10, status: 'cancelled', total_count: '1', records: [wire] };
    expect(parseTransferPage(JSON.stringify(page)).records[0]).toEqual(parse(wire));
    expect(() => parseTransferPage(JSON.stringify({ ...page, status: 'approved' }))).toThrow();
    expect(() => parseTransferPage(JSON.stringify({ ...page, total_count: '2', records: [wire, wire] }))).toThrow();
  });
  it.each([false, true])('requires exact creator metadata and canonical chronological UTC (approved=%s)', approved => {
    for (const patch of [
      { cancellation_location_id: undefined }, { cancellation_location_id: null }, { cancellation_location_id: '2' },
      { cancellation_location_id: 1 }, { cancellation_location_id: 3 }, { cancellation_location_id: 2.5 },
      { cancelled_at: undefined }, { cancelled_at: null }, { cancelled_at: '2026-02-30T00:00:00Z' },
      { cancelled_at: '2026-04-03T00:00:00+00:00' }, { cancelled_at: '2026-04-03T00:00:00.100Z' },
      { cancelled_at: '2026-04-02T12:34:56.123456788Z' },
      { dispatch_location_id: 1 }, { dispatched_at: '2026-04-03T00:00:00.000000003Z' },
      { receipt_location_id: 2 }, { receipt: {} }, { retry_key: 'private' }, { released_at: 'private' },
      { allocations: [] }, { private_fingerprint: 'private' },
    ]) expect(() => parse(cancellationWire(approved, patch))).toThrow();
    const earliest = approved ? '2026-04-03T00:00:00.000000001Z' : wireRecord().created_at;
    expect(parse(cancellationWire(approved, { cancelled_at: earliest })).status).toBe('cancelled');
    if (approved) expect(() => parse(cancellationWire(true, { cancelled_at: '2026-04-03T00:00:00Z' }))).toThrow();
  });
  it('requires either complete preserved approval or none, never null or a different actor', () => {
    for (const patch of [{ decision_location_id: 1 }, { decided_at: '2026-04-03T00:00:00Z' },
      { decision_location_id: null, decided_at: null },
      { decision_location_id: 2, decided_at: '2026-04-03T00:00:00Z' }]) {
      expect(() => parse(cancellationWire(false, patch))).toThrow();
    }
    for (const status of ['pending', 'approved', 'rejected', 'in_transit', 'received']) {
      expect(() => parse(cancellationWire(true, { status }))).toThrow();
    }
  });
  it.each(['cancelled_at', 'cancellation_location_id'])('rejects identical and different duplicate %s values and escaped keys', key => {
    const wire = cancellationWire();
    const raw = JSON.stringify(wire);
    const same = JSON.stringify(Reflect.get(wire, key));
    const different = JSON.stringify(key === 'cancelled_at' ? '2026-04-03T00:00:00.000000003Z' : 3);
    const escapedKey = key.replace('_', '\\u005f');
    for (const value of [same, different]) {
      for (const spelling of [key, escapedKey]) {
        expect(() => parseTransferRecord(raw.replace('{', `{"${spelling}":${value},`))).toThrow('Invalid transfer response');
      }
    }
  });
  it('rejects nested identical, different and escaped-equivalent item keys inside arrays', () => {
    const raw = JSON.stringify(cancellationWire());
    for (const spelling of ['brand', 'br\\u0061nd']) {
      for (const value of ['Brand', 'Different']) {
        const duplicate = raw.replace('"brand":"Brand"', `"brand":"Brand","${spelling}":${JSON.stringify(value)}`);
        expect(() => parseTransferRecord(duplicate)).toThrow('Invalid transfer response');
      }
    }
  });
  it('keeps object key sets independent and skips key-like strings with quotes, slashes and braces', () => {
    const brand = 'Brand "cancelled_at": {"brand":"value"}, ["items"] \\ tail';
    const model = 'Escaped \\u005f key text: "cancellation_location_id": 2';
    const wire = cancellationWire(true, { items: [1, 2].map(variant_id => ({ ...wireRecord().items[0], variant_id, brand, model })) });
    const decoded = parse(wire);
    expect(decoded.items.map(item => item.variant_id)).toEqual([1, 2]);
    expect(decoded.items.map(item => item.brand)).toEqual([brand, brand]);
    expect(decoded.items.map(item => item.model)).toEqual([model, model]);
    const escapedRaw = JSON.stringify(wire).replaceAll('"brand":', '"br\\u0061nd" \n\t:');
    expect(parseTransferRecord(escapedRaw)).toEqual(decoded);
    expect(transferQuantityTotal(decoded)).toBe(18446744073709551614n);
    const second = { ...wire, id: '9007199254740992', reference: 'TR-9007199254740992' };
    const page = parseTransferPage(JSON.stringify({ page: 1, page_size: 10, status: 'cancelled', total_count: '2', records: [wire, second] }));
    expect(page.records.map(item => item.id)).toEqual(['9007199254740993', '9007199254740992']);
    expect(page.records[1].items[0].quantity).toBe(9223372036854775807n);
  });
  it('rejects duplicate cancellation keys, trailing data and noncanonical original quantities', () => {
    const raw = JSON.stringify(cancellationWire());
    for (const extra of [' {}', 'null', 'x']) expect(() => parseTransferRecord(raw + extra)).toThrow();
    for (const key of ['cancelled_at', 'cancellation_location_id']) {
      const value = JSON.stringify(Reflect.get(cancellationWire(), key));
      expect(() => parseTransferRecord(raw.replace('{', `{"${key}":${value},`))).toThrow();
    }
    const escaped = raw.replace('{', '{"cancellation\\u005flocation_id":2,');
    expect(() => parseTransferRecord(escaped)).toThrow();
    for (const quantity of ['01', '0', '-1', '9223372036854775808', 1]) {
      expect(() => parse(cancellationWire(false, { items: [{ ...wireRecord().items[0], quantity }] }))).toThrow();
    }
  });
});

describe('R2 receipt wire contract', () => {
  it('normalizes an immutable receipt payload, including explicit zeros, without numeric aggregate limits', () => {
    const original = parse(dispatchWire({ items: [1, 2].map(variant_id => ({ ...wireRecord().items[0], variant_id, quantity: '2' })) }));
    const input = { items: [
      { variant_id: 3, actual_quantity: '9223372036854775807' },
      { variant_id: 2, actual_quantity: '9223372036854775807' },
      { variant_id: 1, actual_quantity: '0' },
    ] };
    const before = JSON.stringify(input); const canonical = canonicalTransferReceiptInput(input, original);
    expect(JSON.stringify(input)).toBe(before);
    expect(canonical.items.map(line => line.variant_id)).toEqual([1, 2, 3]);
    for (const value of [canonical, canonical.items, ...canonical.items]) expect(Object.isFrozen(value)).toBe(true);
    expect(previewTransferReceipt(canonical, original)).toMatchObject({ items: [
      { variant_id: 1, available_quantity: 0n }, { variant_id: 2, available_quantity: 2n }, { variant_id: 3, available_quantity: 0n },
    ], exceptions: [ { kind: 'shortage', quantity: 2n }, { kind: 'excess', quantity: 9223372036854775805n },
      { kind: 'unexpected', quantity: 9223372036854775807n } ] });
    for (const bad of [ { items: input.items.slice(0, 2) }, { items: [...input.items, input.items[0]] },
      { items: input.items.map(line => ({ ...line, actual_quantity: '0' })) },
      { items: input.items.map(line => line.variant_id === 3 ? { ...line, actual_quantity: '0' } : line) },
      { ...input, actor: 2 }, { items: input.items.map(line => ({ ...line, actual_quantity: 1 })) } ]) {
      expect(() => canonicalTransferReceiptInput(bad as never, original)).toThrow();
    }
  });
  it('admits action obligations independently of Pending participant totals', () => {
    expect(parseTransferCounts('{"pending_total":"0","action_count":"1"}'))
      .toEqual({ pending_total: 0n, action_count: 1n });
    expect(parseTransferCounts('{"pending_total":"2","action_count":"9223372036854775807"}'))
      .toEqual({ pending_total: 2n, action_count: 9223372036854775807n });
  });
  it('decodes immutable Received history losslessly, retaining original sent units and nanoseconds', () => {
    const decoded = parse(receiptWire());
    expect(decoded).toMatchObject({ status: 'received', receipt_location_id: 2,
      received_at: '2026-04-03T00:00:00.000000003Z',
      receipt: { items: [{ variant_id: 2147483647, expected_quantity: 9223372036854775807n,
        actual_quantity: 9007199254740993n, available_quantity: 9007199254740993n }],
      exceptions: [{ variant_id: 2147483647, kind: 'shortage', quantity: 9214364837600034814n }] } });
    expect(decoded.items[0].quantity).toBe(9223372036854775807n);
    // Reflect avoids narrowing the pre-R2 union; this is the proposed nested bigint DTO.
    const receipt = Reflect.get(decoded, 'receipt');
    for (const value of [decoded, decoded.items, decoded.items[0], receipt,
      receipt.items, receipt.items[0], receipt.exceptions, receipt.exceptions[0]]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
  });
  it('filters and paginates Received records without changing original reference semantics', () => {
    expect(transferListPath({ status: 'received' as never })).toBe('/api/transfers?page=1&page_size=25&status=received');
    const page = parseTransferPage(JSON.stringify({ page: 1, page_size: 10, status: 'received', total_count: '1', records: [receiptWire()] }));
    expect(page.records[0].status).toBe('received');
    expect(page.records[0].reference).toBe('TR-9007199254740993');
    expect(() => parseTransferPage(JSON.stringify({ page: 1, page_size: 10, status: 'in_transit', total_count: '1', records: [receiptWire()] }))).toThrow();
  });
  it('accepts shortages, excess and unexpected units without crediting exceptions', () => {
    const sent = wireRecord().items[0];
    const receipt = { items: [
      { variant_id: 1, expected_quantity: '2', actual_quantity: '0', available_quantity: '0' },
      { variant_id: 2, expected_quantity: '2', actual_quantity: '5', available_quantity: '2' },
      { variant_id: 3, expected_quantity: '0', actual_quantity: '9223372036854775807', available_quantity: '0' },
    ], exceptions: [
      { variant_id: 1, kind: 'shortage', quantity: '2' },
      { variant_id: 2, kind: 'excess', quantity: '3' },
      { variant_id: 3, kind: 'unexpected', quantity: '9223372036854775807' },
    ] };
    expect(parse(receiptWire({ items: [1, 2].map(variant_id => ({ ...sent, variant_id, quantity: '2' })), receipt })))
      .toMatchObject({ receipt: { items: [{ available_quantity: 0n }, { available_quantity: 2n }, { available_quantity: 0n }] } });
    expect(parse(receiptWire({ receipt: { items: [{ variant_id: 2147483647,
      expected_quantity: sent.quantity, actual_quantity: sent.quantity, available_quantity: sent.quantity }], exceptions: [] } })))
      .toMatchObject({ receipt: { exceptions: [] } });
  });
  it('admits unexpected-only receipts but rejects total-zero and zero unexpected lines', () => {
    const expected = { variant_id: 2147483647, expected_quantity: '9223372036854775807', actual_quantity: '0', available_quantity: '0' };
    const shortage = { variant_id: 2147483647, kind: 'shortage', quantity: '9223372036854775807' };
    const unexpected = { variant_id: 1, expected_quantity: '0', actual_quantity: '9223372036854775807', available_quantity: '0' };
    const receipt = { items: [unexpected, expected], exceptions: [
      { variant_id: 1, kind: 'unexpected', quantity: '9223372036854775807' }, shortage,
    ] };
    expect(parse(receiptWire({ receipt }))).toMatchObject({ receipt: { items: [{ available_quantity: 0n }, { actual_quantity: 0n }] } });
    expect(() => parse(receiptWire({ receipt: { items: [expected], exceptions: [shortage] } }))).toThrow();
    expect(() => parse(receiptWire({ receipt: { ...receipt, items: [{ ...unexpected, actual_quantity: '0' }, expected] } }))).toThrow();
    expect(() => parse(receiptWire({ receipt: { ...receipt, items: [{ ...unexpected, available_quantity: '1' }, expected] } }))).toThrow();
  });
  it('requires destination receipt metadata and nanosecond chronological ordering', () => {
    for (const patch of [{ receipt_location_id: 1 }, { receipt_location_id: '2' }, { receipt_location_id: undefined },
      { received_at: undefined }, { received_at: '2026-04-03T00:00:00.000000001Z' },
      { received_at: '2026-02-30T00:00:00Z' }, { received_at: '2026-04-03T00:00:00+00:00' },
      { dispatched_at: undefined }, { receipt: undefined }, { private_fingerprint: 'hidden' }]) {
      expect(() => parse(receiptWire(patch))).toThrow();
    }
    expect(parse(receiptWire({ received_at: '2026-04-03T00:00:00.000000002Z' })).status).toBe('received');
    for (const status of ['pending', 'approved', 'rejected', 'in_transit']) expect(() => parse(receiptWire({ status }))).toThrow();
  });
  it('rejects forged credit, incomplete expected lines and noncanonical receipt quantities', () => {
    const good = receiptWire().receipt;
    for (const items of [[], [good.items[0], good.items[0]],
      [{ ...good.items[0], expected_quantity: '1' }], [{ ...good.items[0], available_quantity: '9223372036854775807' }],
      [{ ...good.items[0], variant_id: 1 }]]) {
      expect(() => parse(receiptWire({ receipt: { ...good, items } }))).toThrow();
    }
    for (const field of ['expected_quantity', 'actual_quantity', 'available_quantity']) {
      for (const value of ['01', '-1', '+1', '1e2', '1.0', '9223372036854775808', 1, null]) {
        expect(() => parse(receiptWire({ receipt: { ...good, items: [{ ...good.items[0], [field]: value }] } }))).toThrow();
      }
    }
    for (const exceptions of [[], [good.exceptions[0], good.exceptions[0]],
      [{ ...good.exceptions[0], kind: 'loss' }], [{ ...good.exceptions[0], quantity: '0' }],
      [{ ...good.exceptions[0], quantity: '1' }], [{ ...good.exceptions[0], variant_id: 1 }]]) {
      expect(() => parse(receiptWire({ receipt: { ...good, exceptions } }))).toThrow();
    }
  });
});

describe('D2 dispatch model', () => {
  it('preserves exact transit identity, approval and nanoseconds on pages and replay', () => {
    const record = parse(dispatchWire());
    expect(record).toMatchObject({ status: 'in_transit', dispatch_location_id: 1,
      dispatched_at: '2026-04-03T00:00:00.000000002Z', decided_at: '2026-04-03T00:00:00.000000001Z' });
    expect(record.items[0].quantity).toBe(9223372036854775807n);
    expect(transferListPath({ status: 'in_transit' })).toContain('status=in_transit');
    expect(parseTransferPage(JSON.stringify({ page: 1, page_size: 10, status: 'in_transit', total_count: '1', records: [dispatchWire()] })).records[0]).toEqual(record);
  });
  it('requires origin dispatch metadata only in transit and compares time without millisecond rounding', () => {
    for (const invalid of [{ dispatch_location_id: 2 }, { dispatch_location_id: '1' },
      { dispatch_location_id: undefined }, { dispatched_at: undefined }, { dispatched_at: null },
      { dispatched_at: '2026-04-03T00:00:00Z' }, { dispatched_at: '2026-04-03T00:00:00.000000000Z' },
      { dispatched_at: '2026-02-30T00:00:00Z' }, { dispatched_at: '2026-04-03T00:00:00+00:00' }]) {
      expect(() => parse(dispatchWire(invalid))).toThrow();
    }
    expect(parse(dispatchWire({ dispatched_at: '2026-04-03T00:00:00.000000001Z' })).status).toBe('in_transit');
    for (const status of ['pending', 'approved', 'rejected']) expect(() => parse(dispatchWire({ status }))).toThrow();
  });
});

describe('A05a outcome and count contracts', () => {
  it.each(['approved', 'rejected'] as const)('decodes lossless %s in every physical flow', status => {
    for (const flow of ['requestWarehouse', 'requestOther', 'sendWarehouse'] as const) {
      const direction = transferDirection(2, flow);
      const wire = wireRecord({ ...direction, status, decision_location_id: direction.approver_location_id,
        decided_at: '2028-02-29T23:59:59.000000001Z' });
      delete (wire as Record<string, unknown>).counterparty_location_id;
      const outcome = parse(wire);
      expect(outcome).toMatchObject({ status, decision_location_id: direction.approver_location_id,
        decided_at: '2028-02-29T23:59:59.000000001Z', created_at: wire.created_at, reference: wire.reference });
      expect(outcome.items[0].quantity).toBe(9223372036854775807n);
      expect(outcome.items[0].capacity_ah).toBe('0.000001');
    }
  });
  it.each(['pending', 'approved', 'rejected'] as const)('selects only %s records with unchanged pagination', status => {
    const record = wireRecord(status === 'pending' ? {} : { status, decision_location_id: 1, decided_at: '2026-04-03T00:00:00Z' });
    const page = { page: 1, page_size: 10, status, total_count: '1', records: [record] };
    expect(transferListPath({ status })).toBe(`/api/transfers?page=1&page_size=25&status=${status}`);
    expect(parseTransferPage(JSON.stringify(page)).records[0].status).toBe(status);
    expect(() => parseTransferPage(JSON.stringify({ ...page, status: status === 'pending' ? 'approved' : 'pending' }))).toThrow();
    expect(() => parseTransferPage(JSON.stringify({ ...page, total_count: '2', records: [record, record] }))).toThrow();
    expect(parseTransferPage(JSON.stringify({ ...page, page: 2, records: [] })).total_count).toBe(1n);
  });
  it('rejects metadata on Pending and incomplete, foreign or noncanonical terminal decisions', () => {
    for (const metadata of [{ decision_location_id: 1 }, { decided_at: '2026-04-03T00:00:00Z' },
      { decision_location_id: null, decided_at: null }]) expect(() => parse(wireRecord(metadata))).toThrow();
    for (const status of ['approved', 'rejected']) {
      const terminal = { status, decision_location_id: 1, decided_at: '2026-04-03T00:00:00.123456789Z' };
      for (const invalid of [{ decision_location_id: undefined }, { decided_at: undefined }, { decision_location_id: '1' },
        { decision_location_id: 2 }, { decision_location_id: 0 }, { decision_location_id: 4 }, { decision_location_id: 1.5 },
        { decided_at: '2026-02-30T00:00:00Z' }, { decided_at: '2026-04-03T00:00:00+00:00' },
        { decided_at: '2026-04-03T00:00:00.100Z' }, { decided_at: '2026-04-03T00:00:00.1234567891Z' },
        { private_allocation: 'secret' }, { status: 'dispatched' }]) expect(() => parse(wireRecord({ ...terminal, ...invalid }))).toThrow();
    }
  });
  it.each(['approved', 'rejected'] as const)('retains item order, precision and strict original fields on %s', status => {
    const wire = wireRecord({ status, decision_location_id: 1, decided_at: '2028-02-29T00:00:00Z' });
    wire.items.push({ ...wire.items[0], variant_id: 1, capacity_ah: '999999.999999', quantity: '9007199254740993' });
    const decoded = parse(wire);
    expect(decoded.items.map(item => item.variant_id)).toEqual([2147483647, 1]);
    expect(decoded.items[1]).toMatchObject({ capacity_ah: '999999.999999', quantity: 9007199254740993n });
    for (const invalid of [{ id: '9223372036854775808' }, { reference: 'TR-001' }, { origin_location_id: 3 },
      { items: [{ ...wire.items[0], quantity: '-1' }] }, { items: [{ ...wire.items[0], capacity_ah: '35.0' }] },
      { items: [{ ...wire.items[0], private_stock: '1' }] }, { created_at: '2028-02-30T00:00:00Z' }]) {
      expect(() => parse({ ...wire, ...invalid })).toThrow();
    }
  });
  it('admits exactly two bounded canonical nonnegative counts, never an inferred badge', () => {
    expect(parseTransferCounts('{"pending_total":"9223372036854775807","action_count":"9007199254740993"}'))
      .toEqual({ pending_total: 9223372036854775807n, action_count: 9007199254740993n });
    expect(parseTransferCounts('{"pending_total":"0","action_count":"0"}')).toEqual({ pending_total: 0n, action_count: 0n });
    for (const invalid of [{ pending_total: '01', action_count: '0' },
      { pending_total: '9223372036854775808', action_count: '0' }, { pending_total: 2, action_count: '0' },
      { pending_total: '2', action_count: '-1' }, { pending_total: '2', action_count: '1e0' },
      { pending_total: '2', action_count: 1 }, { pending_total: '2' }, { pending_total: '2', action_count: '1', warehouse: 1 }]) {
      expect(() => parseTransferCounts(JSON.stringify(invalid))).toThrow();
    }
  });
});

describe('all transfer filter', () => {
  it('serializes all and admits mixed lifecycle records without weakening record validation', () => {
    expect(transferListPath({ status: 'all' as never })).toBe('/api/transfers?page=1&page_size=25&status=all');
    const records = [wireRecord(), cancellationWire(false, { id: '1', reference: 'TR-001' })];
    const page = { page: 1, page_size: 25, status: 'all', total_count: '2', records };
    expect(parseTransferPage(JSON.stringify(page)).records.map(r => r.status)).toEqual(['pending', 'cancelled']);
    expect(() => parseTransferPage(JSON.stringify({ ...page, status: 'pending' }))).toThrow();
    expect(() => parse(wireRecord({ status: 'all' }))).toThrow();
  });
});

describe('R04 pure transfer model', () => {
  it('keeps wire strings lossless and sums beyond int64', () => {
    const wire = wireRecord();
    wire.items.push({ ...wire.items[0], variant_id: 1 });
    const record = parse(wire);
    expect(record.id).toBe('9007199254740993');
    expect(record.items[0].capacity_ah).toBe('0.000001');
    expect(record.items[0].quantity).toBe(9223372036854775807n);
    expect(transferQuantityTotal(record)).toBe(18446744073709551614n);
  });
  it.each(['1', '999', '1000', '9223372036854775807'])('verifies global reference %s', id => {
    expect(parse(wireRecord({ id, reference: `TR-${id.padStart(3, '0')}` })).id).toBe(id);
  });
  it.each(['0', '01', '+1', '-1', '1e2', '1.2', '9223372036854775808', 9007199254740992])('rejects invalid id %s', id => {
    expect(() => parse(wireRecord({ id }))).toThrow('Invalid transfer response');
  });
  it.each(['0', '01', '+1', '-1', '1e2', '1.2', '9223372036854775808', 2])('rejects invalid quantity %s', quantity => {
    const wire = wireRecord();
    expect(() => parse({ ...wire, items: [{ ...wire.items[0], quantity }] })).toThrow();
  });
  it.each(['0', '0001', '1.0', '1.0000001', '1000000', '-2', '1e2', 35])('rejects noncanonical catalog capacity %s', capacity_ah => {
    const wire = wireRecord();
    expect(() => parse({ ...wire, items: [{ ...wire.items[0], capacity_ah }] })).toThrow();
  });
  it.each(['35', '35.5', '999999.999999'])('preserves exact capacity %s', capacity_ah => {
    const wire = wireRecord();
    expect(parse({ ...wire, items: [{ ...wire.items[0], capacity_ah }] }).items[0].capacity_ah).toBe(capacity_ah);
  });
  it.each([
    { status: 'approved' }, { kind: 'ship' }, { creator_location_id: 1 }, { origin_location_id: 4 },
    { destination_location_id: 3 }, { approver_location_id: 2 }, { creator_location_name: '' },
    { reference: 'TR-001' }, { created_at: '2026-02-30T00:00:00Z' },
    { created_at: '2026-04-02T00:00:00+00:00' }, { created_at: '2026-04-02T00:00:00.100Z' },
    { items: null }, { items: [] }, { retry_key: 'private' },
  ])('rejects invalid record shape or route %j', overrides => expect(() => parse(wireRecord(overrides))).toThrow());
  it('rejects duplicate variants, bad item fields and framing', () => {
    const wire = wireRecord();
    expect(() => parse({ ...wire, items: [wire.items[0], wire.items[0]] })).toThrow();
    for (const fields of [{ variant_id: 0 }, { variant_id: 2147483648 }, { variant_id: 1.5 }, { polarity: 'X' }, { brand: '' }, { secret: true }]) {
      expect(() => parse({ ...wire, items: [{ ...wire.items[0], ...fields }] })).toThrow();
    }
    expect(() => parse({ ...wire, items: Array.from({ length: 191 }, (_, i) => ({ ...wire.items[0], variant_id: i + 1 })) })).toThrow();
    for (const raw of ['null', '[]', '{} {}', '<html>', JSON.stringify(wire) + 'x']) expect(() => parseTransferRecord(raw)).toThrow();
  });
  it('accepts the full 190-line cap without clamping aggregates', () => {
    const wire = wireRecord();
    const items = Array.from({ length: 190 }, (_, i) => ({ ...wire.items[0], variant_id: i + 1 }));
    expect(transferQuantityTotal(parse({ ...wire, items }))).toBe(190n * 9223372036854775807n);
    const canonical = canonicalTransferInput({ ...createInput(), items: items.map(i => ({ variant_id: i.variant_id, quantity: i.quantity })) });
    expect(canonical.items).toHaveLength(190);
    expect(() => canonicalTransferInput({ ...canonical, items: [...canonical.items, { variant_id: 191, quantity: '1' }] })).toThrow();
  });
  it.each([2, 3])('derives all three physical flows from assigned branch %s', assigned => {
    const other = assigned === 2 ? 3 : 2;
    for (const [flow, origin, destination, approver, counterpart, kind] of [
      ['requestWarehouse', 1, assigned, 1, 1, 'request_stock'],
      ['requestOther', other, assigned, other, other, 'request_stock'],
      ['sendWarehouse', assigned, 1, 1, 1, 'send_to_warehouse'],
    ] as const) {
      const direction = transferDirection(assigned, flow);
      expect(direction).toEqual({ kind, counterparty_location_id: counterpart, creator_location_id: assigned,
        origin_location_id: origin, destination_location_id: destination, approver_location_id: approver });
      expect(parse(wireRecord({ kind, creator_location_id: assigned, origin_location_id: origin,
        destination_location_id: destination, approver_location_id: approver })).kind).toBe(kind);
    }
  });
  it('refuses warehouse or unknown creation roles and flows', () => {
    for (const actor of [1, 0, 4, NaN]) expect(() => transferDirection(actor, 'requestWarehouse')).toThrow();
    expect(() => transferDirection(2, 'unknown' as TransferFlow)).toThrow();
    expect(() => parse(wireRecord({ kind: 'send_to_warehouse', origin_location_id: 2, destination_location_id: 3 }))).toThrow();
  });
  it('admits only bounded private list query fields and canonical detail IDs', () => {
    expect(transferListPath()).toBe('/api/transfers?page=1&page_size=25&status=pending');
    expect(transferListPath({ page: 1000000, page_size: 50 })).toContain('page=1000000&page_size=50');
    expect(transferDetailPath('9007199254740993')).toBe('/api/transfers/9007199254740993');
    for (const q of [{ page: 0 }, { page: 1000001 }, { page: 1.5 }, { page_size: 20 }, { status: 'ALL' }, { search: 'private' }]) {
      expect(() => transferListPath(q as never)).toThrow();
    }
    for (const id of ['01', '0', '1?x=1', '../1', '9223372036854775808']) expect(() => transferDetailPath(id)).toThrow();
  });
  it('parses zero and large authorized counts with strict page metadata', () => {
    const page = { page: 1, page_size: 25, status: 'pending', total_count: '0', records: [] };
    expect(parseTransferPage(JSON.stringify(page)).total_count).toBe(0n);
    const records = Array.from({ length: 25 }, (_, i) => {
      const id = String(1000 - i);
      return wireRecord({ id, reference: `TR-${id}` });
    });
    expect(parseTransferPage(JSON.stringify({ ...page, total_count: '9007199254740993', records })).total_count).toBe(9007199254740993n);
    expect(parseTransferPage(JSON.stringify({ ...page, total_count: '9223372036854775807', records })).total_count).toBe(9223372036854775807n);
    expect(parseTransferPage(JSON.stringify({ ...page, page: 1000000, total_count: '1' })).records).toEqual([]);
    expect(() => parseTransferPage(JSON.stringify({ ...page, total_count: '25', records: records.reverse() }))).toThrow();
    for (const invalid of [{ total_count: 2 }, { total_count: '01' }, { total_count: '-1' }, { total_count: '9223372036854775808' },
      { records: null }, { page: 0 }, { page_size: 20 }, { status: 'ALL' }, { global_count: '1' }, { records: [wireRecord()] }]) {
      expect(() => parseTransferPage(JSON.stringify({ ...page, ...invalid }))).toThrow();
    }
  });
  it('clones and sorts the stable attempt without numeric quantities or actor payload', () => {
    const input = createInput();
    const original = JSON.stringify(input);
    const canonical = canonicalTransferInput(input);
    expect(canonical.items.map(i => i.variant_id)).toEqual([1, 201]);
    expect(canonical.retry_key).toBe(input.retry_key);
    expect(JSON.stringify(input)).toBe(original);
    expect(canonical.items).not.toBe(input.items);
    expect(Object.isFrozen(canonical)).toBe(true);
    expect(Object.isFrozen(canonical.items[0])).toBe(true);
    expect(JSON.stringify(canonical)).toContain('"quantity":"9007199254740993"');
    for (const invalid of [{ actor: 2 }, { counterparty_location_id: 4 }, { kind: 'ship' }, { retry_key: 'short' },
      { kind: 'send_to_warehouse', counterparty_location_id: 2 }, { retry_key: 'a'.repeat(129) }, { retry_key: 'a'.repeat(15) + '!' }, { items: [] }, { items: [input.items[0], input.items[0]] },
      { items: [{ variant_id: 1, quantity: 2 }] }]) expect(() => canonicalTransferInput({ ...input, ...invalid } as never)).toThrow();
    for (const length of [16, 128]) expect(canonicalTransferInput({ ...input, retry_key: 'a'.repeat(length) }).retry_key).toHaveLength(length);
  });
  it('generates keys only with explicit secure randomness and fails closed', () => {
    const crypto = { getRandomValues: <T extends ArrayBufferView | null>(array: T): T => {
      if (array instanceof Uint8Array) array.fill(255);
      return array;
    } };
    expect(newTransferRetryKey(crypto)).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(newTransferRetryKey(crypto)).toBe('ff'.repeat(16));
    expect(() => newTransferRetryKey(null as never)).toThrow('Secure randomness unavailable');
    expect(() => newTransferRetryKey({ getRandomValues: () => { throw new Error('private failure'); } })).toThrow('Secure randomness unavailable');
  });
});
