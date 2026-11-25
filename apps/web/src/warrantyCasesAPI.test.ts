import { describe, expect, it, vi } from 'vitest';
import { WarrantyCaseAPIError, createWarrantyCasesAPI, warrantyCaseErrorMessages } from './warrantyCasesAPI';

const csrf = 'c'.repeat(43);
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value),
  { status, headers: { 'Content-Type': 'application/json' } });
const failure = (code: string, status: number) => new Response(JSON.stringify({ error: code }),
  { status, headers: { 'Content-Type': 'application/json' } });

const row = (over: Record<string, unknown> = {}) => ({
  id: 1, case_number: 'C-2-000001', branch_location_id: 2, origin: 'warranty_claim', phase: 'received',
  variant_id: 1, serial_number: 'ABC123', quantity: null, declared_failure: 'No arranca el motor',
  reason: null, created_at: '2026-03-01T12:00:00Z', ...over,
});
const loan = (over: Record<string, unknown> = {}) => ({
  ordinal: 1, model: 'NS60L', quantity: 1, serial_number: '', source_location_id: 1,
  given_at: '2026-03-01T12:05:00Z', fate: 'open', fate_decided_at: null, given_by_account_id: 2, ...over,
});
const event = (over: Record<string, unknown> = {}) => ({
  ordinal: 1, kind: 'phase', phase: 'received', factory_case_number: '', actor_account_id: 2,
  recorded_at: '2026-03-01T12:00:00Z', note: '', ...over,
});
const claimCase = (over: Record<string, unknown> = {}) => ({
  ...row(), verdict: null, reported_destination: null, loan_destination: null, stock_destination: null,
  sale_id: 12, warranty_number: '2-000012', created_by_account_id: 2, loans: [], events: [], ...over,
});
const resolvedCase = (over: Record<string, unknown> = {}) => claimCase({
  phase: 'resolved', verdict: 'repaired', reported_destination: 'customer', loan_destination: 'stock',
  events: [event({ ordinal: 1, phase: 'received' }), event({ ordinal: 2, phase: 'in_transit' }),
    event({ ordinal: 3, phase: 'at_warehouse' }), event({ ordinal: 4, phase: 'at_factory', factory_case_number: 'F-2214' }),
    event({ ordinal: 5, phase: 'resolved' })],
  loans: [loan()], ...over,
});

function stub(...replies: (Response | ((url: string, init: RequestInit) => Response))[]) {
  const mock = vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
    const reply = replies.shift() ?? failure('not_found', 404);
    return Promise.resolve(typeof reply === 'function' ? reply(String(input), init) : reply.clone());
  });
  return mock as unknown as typeof globalThis.fetch;
}

describe('the transport of the case contract', () => {
  it('reads the tray with exactly the two admitted filters', async () => {
    const fetch = stub(json({ cases: [row()] }), json({ cases: [] }));
    const api = createWarrantyCasesAPI(fetch);
    expect((await api.tray({ phase: 'received', origin: 'warranty_claim' }))[0].case_number).toBe('C-2-000001');
    await api.tray();
    const calls = (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
    expect(calls[0][0]).toBe('/api/warranty-cases?phase=received&origin=warranty_claim');
    expect(calls[1][0]).toBe('/api/warranty-cases');
    expect(calls[0][1]).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store' });
  });
  it('surfaces the refusal of the tray as the contract code, never as a parsed page', async () => {
    const api = createWarrantyCasesAPI(stub(failure('forbidden', 403)));
    await expect(api.tray()).rejects.toMatchObject({ code: 'forbidden', status: 403 });
    const page = createWarrantyCasesAPI(stub(new Response('<html>', { status: 200, headers: { 'Content-Type': 'text/html' } })));
    await expect(page.tray()).rejects.toMatchObject({ code: 'invalid_response' });
  });
  it('reads one case and refuses a reply about another one', async () => {
    const api = createWarrantyCasesAPI(stub(json(claimCase())));
    expect((await api.detail(1)).id).toBe(1);
    const other = createWarrantyCasesAPI(stub(json(claimCase({ id: 2, case_number: 'C-2-000002' }))));
    await expect(other.detail(1)).rejects.toMatchObject({ code: 'invalid_response' });
  });
  it('opens the claim with the serial and the failure and freezes the payload before the wait', async () => {
    const fetch = vi.fn(() => Promise.resolve(json(claimCase({ declared_failure: 'No arranca' }), 201))) as unknown as typeof globalThis.fetch;
    const api = createWarrantyCasesAPI(fetch);
    const draft = { serial: ' ABC123 ', failure: 'No arranca' };
    const { canonicalClaimBody } = await import('./warrantyCasesModel');
    const record = await api.openClaim(() => canonicalClaimBody(draft.serial, draft.failure), csrf);
    draft.serial = 'OTRA';
    expect(record.origin).toBe('warranty_claim');
    const [url, init] = (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(url).toBe('/api/warranty-cases/claims');
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin' });
    expect((init.headers as Record<string, string>)['X-CSRF-Token']).toBe(csrf);
    expect(JSON.parse(String(init.body))).toEqual({ serial_number: 'ABC123', declared_failure: 'No arranca' });
  });
  it('states each refusal of the claim door as its own code (S2)', async () => {
    for (const code of ['serial_not_sold', 'no_warranty', 'warranty_expired']) {
      const api = createWarrantyCasesAPI(stub(failure(code, 409)));
      await expect(api.openClaim(() => ({ serial_number: 'ABC123', declared_failure: 'Falla' }), csrf))
        .rejects.toMatchObject({ code, status: 409 });
    }
  });
  it('never writes without a CSRF token and never admits a reply of the other door', async () => {
    const fetch = vi.fn(() => Promise.resolve(json(claimCase(), 201))) as unknown as typeof globalThis.fetch;
    const api = createWarrantyCasesAPI(fetch);
    await expect(api.openClaim(() => ({ serial_number: 'A', declared_failure: 'F' }), ''))
      .rejects.toMatchObject({ code: 'invalid_request' });
    expect((fetch as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);
    // A claim door answered with a finding is not the case that was asked for.
    const finding = { ...row({ origin: 'stock_defect', serial_number: null, quantity: 1, reason: 'Probada' }),
      verdict: null, reported_destination: null, loan_destination: null, stock_destination: null,
      sale_id: null, warranty_number: null, created_by_account_id: 2, loans: [], events: [] };
    const wrong = createWarrantyCasesAPI(stub(json(finding, 201)));
    await expect(wrong.openClaim(() => ({ serial_number: 'A', declared_failure: 'F' }), csrf))
      .rejects.toMatchObject({ code: 'invalid_response' });
  });
  it('opens a finding on the shelf and states its own refusals (S16)', async () => {
    const finding = { ...row({ origin: 'stock_defect', serial_number: null, quantity: 2, reason: 'Probada en mostrador' }),
      verdict: null, reported_destination: null, loan_destination: null, stock_destination: null,
      sale_id: null, warranty_number: null, created_by_account_id: 2, loans: [], events: [] };
    const api = createWarrantyCasesAPI(stub(json(finding, 201)));
    const record = await api.openDefect(() => ({ variant_id: 1, quantity: 2, declared_failure: 'No arranca el motor',
      reason: 'Probada en mostrador' }), csrf);
    expect(record.quantity).toBe(2);
    await expect(createWarrantyCasesAPI(stub(failure('no_stock', 409))).openDefect(() => ({ variant_id: 1, quantity: 2,
      declared_failure: 'Falla', reason: 'Motivo' }), csrf)).rejects.toMatchObject({ code: 'no_stock' });
  });
  it('lends a used battery and requires the loan the reply states to be the one that was sent (S5)', async () => {
    const api = createWarrantyCasesAPI(stub(json(loan({ quantity: 2 }), 201)));
    const handed = await api.addLoan(1, () => ({ model: 'NS60L', quantity: 2, serial_number: '', source_location_id: 1 }), csrf);
    expect(handed.quantity).toBe(2);
    const wrong = createWarrantyCasesAPI(stub(json(loan({ model: 'OTRO' }), 201)));
    await expect(wrong.addLoan(1, () => ({ model: 'NS60L', quantity: 1, serial_number: '', source_location_id: 1 }), csrf))
      .rejects.toMatchObject({ code: 'invalid_response' });
    // The two questions a loan answers apart (S25, S30): a model the pool never saw and an origin that
    // does not hold it. Each keeps its own code, so neither is ever published as the other.
    for (const code of ['loan_model_unknown', 'loan_source_stock']) {
      await expect(createWarrantyCasesAPI(stub(failure(code, 409)))
        .addLoan(1, () => ({ model: 'NS60L', quantity: 1, serial_number: '', source_location_id: 1 }), csrf))
        .rejects.toMatchObject({ code, status: 409 });
    }
  });
  it('states the fate of one lent battery and keeps the decision final (S7)', async () => {
    const failed = loan({ fate: 'failed', fate_decided_at: '2026-03-09T12:00:00Z' });
    const api = createWarrantyCasesAPI(stub(json(failed)));
    const settled = await api.decideLoan(1, 1, 'failed', csrf);
    expect(settled.fate).toBe('failed');
    expect(settled.fate_decided_at).toBe('2026-03-09T12:00:00Z');
    // A fate that did not change the loan is not a fate that was recorded.
    await expect(createWarrantyCasesAPI(stub(json(loan()))).decideLoan(1, 1, 'failed', csrf))
      .rejects.toMatchObject({ code: 'invalid_response' });
    await expect(createWarrantyCasesAPI(stub(failure('loan_fate_final', 409))).decideLoan(1, 1, 'failed', csrf))
      .rejects.toMatchObject({ code: 'loan_fate_final', status: 409 });
  });
  it('records the notice, the delivery and the tramo and refuses a reply that did not do it (S14, S4)', async () => {
    const noticed = resolvedCase({ events: [...resolvedCase().events,
      event({ ordinal: 6, kind: 'notice', phase: 'resolved', note: 'Avisado' })] });
    const api = createWarrantyCasesAPI(stub(json(noticed)));
    const afterNotice = await api.notice(1, () => ({ note: 'Avisado' }), csrf);
    expect(afterNotice.events.at(-1)?.kind).toBe('notice');
    // A notice the case does not carry is not a notice that was recorded.
    await expect(createWarrantyCasesAPI(stub(json(resolvedCase()))).notice(1, () => ({ note: 'Avisado' }), csrf))
      .rejects.toMatchObject({ code: 'invalid_response' });

    const closed = resolvedCase({ phase: 'closed', loans: [loan({ fate: 'returned', fate_decided_at: '2026-03-10T12:00:00Z' })],
      events: [...resolvedCase().events, event({ ordinal: 6, phase: 'closed' })] });
    const deliver = createWarrantyCasesAPI(stub(json(closed)));
    expect((await deliver.deliver(1, { loan_fate: 'returned', note: 'Entregada' }, csrf)).phase).toBe('closed');
    await expect(createWarrantyCasesAPI(stub(json(resolvedCase()))).deliver(1, { loan_fate: 'returned', note: 'Entregada' }, csrf))
      .rejects.toMatchObject({ code: 'invalid_response' });

    const transit = claimCase({ phase: 'in_transit', events: [event({ ordinal: 1, phase: 'received' }),
      event({ ordinal: 2, phase: 'in_transit', recorded_at: '2026-03-02T12:00:00Z', note: 'Sale al Almacén' })] });
    const advance = createWarrantyCasesAPI(stub(json(transit)));
    expect((await advance.advance(1, { phase: 'in_transit', factory_case_number: '', note: 'Sale al Almacén' }, csrf)).phase)
      .toBe('in_transit');
    await expect(createWarrantyCasesAPI(stub(failure('transition_not_allowed', 409)))
      .advance(1, { phase: 'in_transit', factory_case_number: '', note: 'Sale' }, csrf))
      .rejects.toMatchObject({ code: 'transition_not_allowed' });
  });
  it('reads the derived stock of used batteries as one table and refuses any other shape', async () => {
    const stockRow = { location_id: 1, model: 'NS60ZL', purchased: '0', factory_returns: '2',
      loans_returned: '1', delivered: '3', loans_given: '1', available: '5' };
    const fetch = stub(json({ stock: [stockRow] }));
    const rows = await createWarrantyCasesAPI(fetch).usedStock();
    expect(rows[0]).toMatchObject({ location_id: 1, model: 'NS60ZL', available: 5 });
    const calls = (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
    expect(calls[0][0]).toBe('/api/warranty-cases/used-stock');
    expect(calls[0][1]).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store' });
    // A refusal is the contract's own code, and a table of another shape is never published as stock.
    await expect(createWarrantyCasesAPI(stub(failure('service_unavailable', 503))).usedStock())
      .rejects.toMatchObject({ code: 'service_unavailable', status: 503 });
    await expect(createWarrantyCasesAPI(stub(json({ stock: [{ location_id: 1 }] }))).usedStock())
      .rejects.toMatchObject({ code: 'invalid_response' });
    await expect(createWarrantyCasesAPI(stub(json({ stock: [{ ...stockRow, available: '9' }] }))).usedStock())
      .rejects.toMatchObject({ code: 'invalid_response' });
  });
  it('admits the refusal of a unit that belongs to stock as its own code and message (S31)', async () => {
    const api = createWarrantyCasesAPI(stub(failure('unit_belongs_to_stock', 409)));
    await expect(api.deliver(1, { loan_fate: 'returned', note: 'Entregada' }, csrf))
      .rejects.toMatchObject({ code: 'unit_belongs_to_stock', status: 409 });
    // The message names the reason: the unit goes to stock and is released, not delivered.
    expect(warrantyCaseErrorMessages.unit_belongs_to_stock).toBe(
      'La unidad de este caso va al stock vendible: sale por la liberación que autoriza el Almacén, no por la entrega. No se registró nada.');
  });
  it('admits the refusal of a release with an open loan as its own code and message (S32)', async () => {
    const api = createWarrantyCasesAPI(stub(failure('loan_fate_open', 409)));
    await expect(api.release(1, () => ({ note: 'Liberada' }), csrf))
      .rejects.toMatchObject({ code: 'loan_fate_open', status: 409 });
    // The message names the missing decision: the release does not choose the fate, it demands it.
    expect(warrantyCaseErrorMessages.loan_fate_open).toBe(
      'El caso tiene un préstamo sin desenlace: decidí qué pasó con la usada antes de cerrarlo.');
  });
  it('reports a lost connection and an aborted read as their own codes', async () => {
    const offline = createWarrantyCasesAPI(vi.fn(() => Promise.reject(new Error('offline'))) as unknown as typeof globalThis.fetch);
    await expect(offline.tray()).rejects.toBeInstanceOf(WarrantyCaseAPIError);
    await expect(offline.tray()).rejects.toMatchObject({ code: 'network' });
    const controller = new AbortController();
    controller.abort();
    const aborting = vi.fn(() => Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    const aborted = createWarrantyCasesAPI(aborting as unknown as typeof globalThis.fetch);
    await expect(aborted.tray({}, controller.signal)).rejects.toMatchObject({ code: 'aborted' });
  });
});
