import { describe, expect, it } from 'vitest';
import {
  canonicalTransferInput, newTransferRetryKey, parseTransferPage, parseTransferRecord,
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
    for (const q of [{ page: 0 }, { page: 1000001 }, { page: 1.5 }, { page_size: 20 }, { status: 'approved' }, { search: 'private' }]) {
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
      { records: null }, { page: 0 }, { page_size: 20 }, { status: 'all' }, { global_count: '1' }, { records: [wireRecord()] }]) {
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
