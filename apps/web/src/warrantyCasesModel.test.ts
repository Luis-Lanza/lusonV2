import { describe, expect, it } from 'vitest';
import {
  canonicalAdvanceBody, canonicalClaimBody, canonicalClaimSerial, canonicalDeclaration, canonicalDefectBody,
  canonicalDeliveryBody, canonicalLoanBody, canonicalLoanFateBody, canonicalLoanModel, canonicalLoanSerial,
  canonicalNoticeBody, warrantyLoanFatePath,
  parseWarrantyCase, parseWarrantyLoan, parseWarrantyPending, parseWarrantyTray, warrantyClosedByRelease,
  warrantyCustodyUnits, warrantyDaysSince, warrantyEventLabel,
  warrantyDeliveryAvailable, warrantyDispatchAvailable, warrantyCloseAvailable, warrantyNotice,
  warrantyNoticeAvailable, warrantyNoticeDays, warrantyPhaseShortLabel, warrantyPhaseShortLabels,
  warrantyRowPhaseLabel, warrantyReceiptAvailable,
  warrantyReceiptFileName,
  warrantyReceiptPath, warrantyReleased, warrantyTrayPath, warrantyLoanRegistered, warrantyPendingPath,
} from './warrantyCasesModel';

// The tray row is the header of a case and nothing else; the case adds its resolution, its sale, its
// loans and its append-only history. Numbers travel as JSON numbers, exactly as Go publishes them.
const row = (over: Record<string, unknown> = {}) => ({
  id: 1, case_number: 'C-2-000001', branch_location_id: 2, origin: 'warranty_claim', phase: 'received',
  variant_id: 1, serial_number: 'ABC123', quantity: null, declared_failure: 'No arranca el motor',
  reason: null, created_at: '2026-03-01T12:00:00Z', closed_by: null, ...over,
});
const loan = (over: Record<string, unknown> = {}) => ({
  ordinal: 1, model: 'NS60L', quantity: 1, serial_number: '', source_location_id: 1,
  given_at: '2026-03-01T12:05:00Z', fate: 'open', fate_decided_at: null, given_by_account_id: 2, ...over,
});
const event = (over: Record<string, unknown> = {}) => ({
  ordinal: 1, kind: 'phase', phase: 'received', factory_case_number: '', actor_account_id: 2,
  recorded_at: '2026-03-01T12:00:00Z', note: '', ...over,
});
const caseJSON = (over: Record<string, unknown> = {}) => JSON.stringify({
  ...row(), verdict: null, reported_destination: null, loan_destination: null, stock_destination: null,
  sale_id: 12, warranty_number: '2-000012', created_by_account_id: 2, loans: [], events: [], ...over,
});
const defectJSON = (over: Record<string, unknown> = {}) => JSON.stringify({
  ...row({ origin: 'stock_defect', serial_number: null, quantity: 2, reason: 'Probada en mostrador' }),
  verdict: null, reported_destination: null, loan_destination: null, stock_destination: null,
  sale_id: null, warranty_number: null, created_by_account_id: 2, loans: [], events: [], ...over,
});
// One claim whose factory verdict already came back and whose unit waits for the client (S13).
const resolvedEvents = () => [
  event({ ordinal: 1, phase: 'received' }),
  event({ ordinal: 2, phase: 'in_transit', recorded_at: '2026-03-02T12:00:00Z' }),
  event({ ordinal: 3, phase: 'at_warehouse', recorded_at: '2026-03-03T12:00:00Z' }),
  event({ ordinal: 4, phase: 'at_factory', factory_case_number: 'F-2214', recorded_at: '2026-03-04T12:00:00Z' }),
  event({ ordinal: 5, phase: 'resolved', recorded_at: '2026-03-05T12:00:00Z', note: 'Reparada por fábrica' }),
];
// The same resolved claim before the branch recorded its notice: it is still owed (S14).
const resolvedJSONWithoutNotice = (over: Record<string, unknown> = {}) => caseJSON({
  phase: 'resolved', verdict: 'repaired', reported_destination: 'customer', loan_destination: 'stock',
  events: resolvedEvents(), loans: [loan({ fate: 'open' })], ...over,
});
const resolvedJSON = (over: Record<string, unknown> = {}) => caseJSON({
  phase: 'resolved', verdict: 'repaired', reported_destination: 'customer', loan_destination: 'stock',
  events: [
    event({ ordinal: 1, phase: 'received' }),
    event({ ordinal: 2, phase: 'in_transit', recorded_at: '2026-03-02T12:00:00Z' }),
    event({ ordinal: 3, phase: 'at_warehouse', recorded_at: '2026-03-03T12:00:00Z' }),
    event({ ordinal: 4, phase: 'at_factory', factory_case_number: 'F-2214', recorded_at: '2026-03-04T12:00:00Z' }),
    event({ ordinal: 5, phase: 'resolved', recorded_at: '2026-03-05T12:00:00Z', note: 'Reparada por fábrica' }),
    event({ ordinal: 6, kind: 'notice', phase: 'resolved', recorded_at: '2026-03-06T12:00:00Z', note: 'Avisado por teléfono' }),
  ],
  loans: [loan({ fate: 'open' })], ...over,
});

// The two acts that close a case, exactly as the server publishes them: the release of the unit bound for
// the branch's own shelf states the `closed` it writes (073), and the delivery of the client's unit states
// it with the last tramo of the journey.
const releasedStockJSON = (over: Record<string, unknown> = {}) => caseJSON({
  phase: 'closed', closed_by: 'release', verdict: 'repaired', reported_destination: 'stock',
  loan_destination: 'customer',
  events: [...resolvedEvents(),
    event({ ordinal: 6, kind: 'notice', phase: 'resolved', recorded_at: '2026-03-06T12:00:00Z', note: 'Avisado' }),
    event({ ordinal: 7, kind: 'release', phase: 'closed', recorded_at: '2026-03-18T12:00:00Z', note: 'Sin retiro' })],
  loans: [loan({ fate: 'returned', fate_decided_at: '2026-03-17T12:00:00Z' })], ...over,
});
const deliveredJSON = (over: Record<string, unknown> = {}) => caseJSON({
  phase: 'closed', closed_by: 'delivery', verdict: 'repaired', reported_destination: 'customer',
  loan_destination: 'stock',
  events: [...resolvedEvents(),
    event({ ordinal: 6, kind: 'notice', phase: 'resolved', recorded_at: '2026-03-06T12:00:00Z', note: 'Avisado' }),
    event({ ordinal: 7, phase: 'closed', recorded_at: '2026-03-07T12:00:00Z', note: 'Canje entregado' })],
  loans: [loan({ fate: 'returned', fate_decided_at: '2026-03-07T12:00:00Z' })], ...over,
});

describe('the tray of the branch', () => {
  it('reads the newest-first rows the contract publishes', () => {
    const rows = parseWarrantyTray(JSON.stringify({ cases: [row({ id: 2, case_number: 'C-2-000002' }), row()] }));
    expect(rows).toHaveLength(2);
    expect(rows[0].case_number).toBe('C-2-000002');
    expect(rows[1].serial_number).toBe('ABC123');
  });
  it('refuses a row that carries the shape of the other door', () => {
    expect(() => parseWarrantyTray(JSON.stringify({ cases: [row({ reason: 'Probada en mostrador' })] })))
      .toThrow('Respuesta inválida del servidor.');
    expect(() => parseWarrantyTray(JSON.stringify({ cases: [row({ quantity: 2 })] })))
      .toThrow('Respuesta inválida del servidor.');
  });
  it('refuses a value outside the frozen vocabulary and a number the database did not write', () => {
    expect(() => parseWarrantyTray(JSON.stringify({ cases: [row({ phase: 'in_factory' })] }))).toThrow();
    expect(() => parseWarrantyTray(JSON.stringify({ cases: [row({ origin: 'claim' })] }))).toThrow();
    expect(() => parseWarrantyTray(JSON.stringify({ cases: [row({ case_number: 'C-A-000038' })] }))).toThrow();
    expect(() => parseWarrantyTray(JSON.stringify({ cases: [row({ branch_location_id: 1 })] }))).toThrow();
  });
  it('refuses a tray that is not newest first, or that carries a key it does not publish', () => {
    expect(() => parseWarrantyTray(JSON.stringify({ cases: [row(), row({ id: 2, case_number: 'C-2-000002' })] }))).toThrow();
    expect(() => parseWarrantyTray(JSON.stringify({ cases: [row()], total: 1 }))).toThrow();
  });
});

describe('one case with its loans and its history', () => {
  it('reads the claim as the branch registers it', () => {
    const record = parseWarrantyCase(caseJSON());
    expect(record.origin).toBe('warranty_claim');
    expect(record.serial_number).toBe('ABC123');
    expect(record.sale_id).toBe(12);
    expect(record.verdict).toBeNull();
    expect(record.loans).toEqual([]);
  });
  it('refuses a header that disagrees with the last tramo of its history (S9)', () => {
    expect(() => parseWarrantyCase(caseJSON({ phase: 'at_warehouse' }))).toThrow();
    expect(() => parseWarrantyCase(caseJSON({ events: [event({ phase: 'in_transit' })] }))).toThrow();
  });
  it('reads the two acts that close a case and still refuses a header that disagrees (S9, S19, S31)', () => {
    // The release of the unit bound for the branch's own shelf is the act that closes that case: the server
    // states `closed` in the release itself and writes no tramo of the journey for it (073).
    const released = parseWarrantyCase(releasedStockJSON());
    expect(released.phase).toBe('closed');
    expect(warrantyClosedByRelease(released)).toBe(true);
    // The delivery of the client's unit closes the case with the last tramo of the journey, as before.
    const delivered = parseWarrantyCase(deliveredJSON());
    expect(delivered.phase).toBe('closed');
    expect(warrantyClosedByRelease(delivered)).toBe(false);
    // Whichever act closed it, the header says what the history says and nothing else.
    expect(() => parseWarrantyCase(caseJSON({ phase: 'closed', events: resolvedEvents() }))).toThrow();
    expect(() => parseWarrantyCase(releasedStockJSON({ phase: 'resolved' }))).toThrow();
    expect(() => parseWarrantyCase(deliveredJSON({ phase: 'resolved' }))).toThrow();
  });
  it('keeps each door to the units it has (S11)', () => {
    expect(() => parseWarrantyCase(caseJSON({ stock_destination: 'stock' }))).toThrow();
    expect(() => parseWarrantyCase(resolvedJSON({ loan_destination: null }))).toThrow();
    expect(() => parseWarrantyCase(defectJSON({ phase: 'resolved', verdict: 'repaired',
      reported_destination: 'stock', stock_destination: 'stock',
      events: [event({ ordinal: 1, phase: 'received' }), event({ ordinal: 2, phase: 'in_transit' }),
        event({ ordinal: 3, phase: 'at_warehouse' }), event({ ordinal: 4, phase: 'at_factory', factory_case_number: 'F-1' }),
        event({ ordinal: 5, phase: 'resolved' })],
      loan_destination: 'stock' }))).toThrow();
  });
  it('refuses a loan whose fate and instant disagree, and a file number off the shipment (S5, S9)', () => {
    expect(() => parseWarrantyCase(resolvedJSON({ loans: [loan({ fate: 'returned' })] }))).toThrow();
    expect(() => parseWarrantyCase(resolvedJSON({ loans: [loan({ fate: 'open', fate_decided_at: '2026-03-02T12:00:00Z' })] }))).toThrow();
    expect(() => parseWarrantyCase(resolvedJSON({ events: [event({ factory_case_number: 'F-9' })], phase: 'received' }))).toThrow();
  });
  it('reads one loan of a used battery on its own, keyed by model and quantity (S5)', () => {
    const parsed = parseWarrantyLoan(JSON.stringify(loan({ quantity: 2 })));
    expect(parsed.model).toBe('NS60L');
    expect(parsed.quantity).toBe(2);
    expect(parsed.serial_number).toBe('');
    expect(parsed.fate).toBe('open');
  });
});

describe('what the screen derives from the persisted facts', () => {
  const now = new Date('2026-03-20T12:00:00Z');
  it('counts whole days from a persisted instant and never backwards', () => {
    expect(warrantyDaysSince('2026-03-01T12:00:00Z', now)).toBe(19);
    expect(warrantyDaysSince('2026-03-21T12:00:00Z', now)).toBe(0);
  });
  it('reads the days since the branch told the client, and nothing before the first notice (S15)', () => {
    const resolved = parseWarrantyCase(resolvedJSON());
    expect(warrantyNotice(resolved)?.note).toBe('Avisado por teléfono');
    expect(warrantyNoticeDays(resolved, now)).toBe(14);
    expect(warrantyNoticeDays(parseWarrantyCase(caseJSON()), now)).toBeNull();
  });
  it('holds the unit that waits for the client out of sellable stock, until it is released (S13, S14)', () => {
    const waiting = parseWarrantyCase(resolvedJSON());
    expect(warrantyCustodyUnits(waiting)).toBe(1);
    expect(warrantyReleased(waiting)).toBe(false);
    const released = parseWarrantyCase(resolvedJSON({ events: [
      event({ ordinal: 1, phase: 'received' }), event({ ordinal: 2, phase: 'in_transit' }),
      event({ ordinal: 3, phase: 'at_warehouse' }), event({ ordinal: 4, phase: 'at_factory', factory_case_number: 'F-2214' }),
      event({ ordinal: 5, phase: 'resolved' }), event({ ordinal: 6, kind: 'notice', phase: 'resolved' }),
      event({ ordinal: 7, kind: 'release', phase: 'resolved', note: 'El cliente no volvió' }),
    ] }));
    expect(warrantyReleased(released)).toBe(true);
    expect(warrantyCustodyUnits(released)).toBe(0);
    // The usable unit bound for the branch's own shelf waits in custody exactly like the client's: it is not
    // sellable stock until the release enters it, and this is the one figure both screens read (S13, S31).
    const shelf = parseWarrantyCase(caseJSON({
      phase: 'resolved', verdict: 'repaired', reported_destination: 'stock', loan_destination: 'customer',
      events: resolvedEvents(), loans: [loan()],
    }));
    expect(warrantyCustodyUnits(shelf)).toBe(1);
    expect(warrantyCustodyUnits(parseWarrantyCase(releasedStockJSON()))).toBe(0);
    // An uncovered unit is the pool de usadas': it never waits in custody as a sellable unit (LW025, S11).
    const pooled = parseWarrantyCase(caseJSON({
      phase: 'resolved', verdict: 'not_covered', reported_destination: 'stock', loan_destination: 'customer',
      events: resolvedEvents(), loans: [loan()],
    }));
    expect(warrantyCustodyUnits(pooled)).toBe(0);
    // A finding holds nothing: its units are the branch's own and came back at its resolution.
    expect(warrantyCustodyUnits(parseWarrantyCase(defectJSON()))).toBe(0);
  });
  it('counts no custody for a unit the factory kept or could not repair, whatever the case declared (S11, S13)',
    () => {
      const custody = (verdict: string, destination = 'customer') => warrantyCustodyUnits(
        parseWarrantyCase(resolvedJSON({ verdict, reported_destination: destination })));
      // 077's guard read from the client: the unit that waits is the one the factory gave back as a usable
      // battery, and the destination only says where it went. A case declared to the client whose factory
      // answer was `lost`, `unrepairable`, `not_covered` or `refused_at_warehouse` held nothing, and the
      // screen showed one unit in custody that never existed.
      for (const verdict of ['lost', 'unrepairable', 'not_covered', 'refused_at_warehouse']) {
        expect(custody(verdict)).toBe(0);
      }
      // The two verdicts that handed a usable battery back do hold it, in either destination that returns
      // the unit to the branch (S11, S31).
      expect(custody('repaired')).toBe(1);
      expect(custody('replaced')).toBe(1);
      expect(custody('repaired', 'stock')).toBe(1);
      expect(custody('replaced', 'stock')).toBe(1);
      // The destination is the other half of the same pair: a repaired unit out as scrap or kept by the
      // factory did not come back to the branch either.
      expect(custody('repaired', 'scrap')).toBe(0);
      expect(custody('replaced', 'retained_by_factory')).toBe(0);
      // A case the factory never answered fails closed.
      expect(warrantyCustodyUnits(parseWarrantyCase(caseJSON({ phase: 'resolved', events: resolvedEvents() }))))
        .toBe(0);
    });
  it('names the phase of a closed case by the act that closed it, never by the phase alone (S19, S31)', () => {
    // The release sold the unit: the case is not `Entregada al cliente`, which is the delivery's reading.
    expect(warrantyPhaseShortLabel(parseWarrantyCase(releasedStockJSON()))).toBe('Cerrada por liberación');
    expect(warrantyPhaseShortLabel(parseWarrantyCase(deliveredJSON()))).toBe('Entregada al cliente');
    // A finding on the shelf is closed by its own branch: nothing was ever delivered to a client.
    const finding = parseWarrantyCase(defectJSON({ phase: 'closed', events: [
      event({ ordinal: 1, phase: 'received' }), event({ ordinal: 2, phase: 'closed' })] }));
    expect(warrantyPhaseShortLabel(finding)).toBe('Cerrada por la sucursal');
    // Every other phase is read from the phase it holds: the act only decides the close.
    expect(warrantyPhaseShortLabel(parseWarrantyCase(resolvedJSON()))).toBe('Esperando al cliente');
    expect(warrantyPhaseShortLabel(parseWarrantyCase(caseJSON()))).toBe('En la sucursal');
  });
  it('publishes the act that closed the row, and refuses one the row cannot state (S34)', () => {
    // The row of a closed case carries the act, because the row is the header and has no history: the
    // server derives it from the last tramo, exactly as it derives the phase.
    const released = parseWarrantyTray(JSON.stringify({ cases: [
      row({ id: 2, case_number: 'C-2-000002', phase: 'closed', closed_by: 'release' })] }));
    expect(released[0].closed_by).toBe('release');
    const delivered = parseWarrantyTray(JSON.stringify({ cases: [
      row({ id: 2, case_number: 'C-2-000002', phase: 'closed', closed_by: 'delivery' })] }));
    expect(delivered[0].closed_by).toBe('delivery');
    // The selected case carries it too, so the pane and the tray read one fact.
    expect(parseWarrantyCase(releasedStockJSON()).closed_by).toBe('release');
    expect(parseWarrantyCase(deliveredJSON()).closed_by).toBe('delivery');
    // An open row states no act, and a row that carries its own key set refuses an act it cannot have.
    expect(parseWarrantyTray(JSON.stringify({ cases: [row()] }))[0].closed_by).toBeNull();
    expect(() => parseWarrantyTray(JSON.stringify({ cases: [
      row({ phase: 'resolved', closed_by: 'delivery' })] }))).toThrow();
    expect(() => parseWarrantyTray(JSON.stringify({ cases: [
      row({ phase: 'closed', closed_by: 'factory' })] }))).toThrow();
    const missing: Record<string, unknown> = row({ phase: 'closed' });
    delete missing.closed_by;
    expect(() => parseWarrantyTray(JSON.stringify({ cases: [missing] }))).toThrow();
  });
  it('names the pill of a row by the act it publishes, and never guesses one (S34)', () => {
    const label = (over: Record<string, unknown>) => warrantyRowPhaseLabel(
      parseWarrantyTray(JSON.stringify({ cases: [row(over)] }))[0]);
    // The two acts read as themselves, and the door says who received the unit.
    expect(label({ phase: 'closed', closed_by: 'delivery' })).toBe('Entregada al cliente');
    expect(label({ phase: 'closed', closed_by: 'release' })).toBe('Cerrada por liberación');
    expect(label({ origin: 'stock_defect', variant_id: 4, serial_number: null, quantity: 2,
      reason: 'Probada en mostrador', phase: 'closed', closed_by: 'delivery' }))
      .toBe('Cerrada por la sucursal');
    // A closed row without a published act says only what it knows, and never claims a delivery.
    expect(label({ phase: 'closed' })).toBe('Cerrada');
    // Every other phase is read from the phase it holds.
    expect(label({ phase: 'resolved' })).toBe('Esperando al cliente');
    expect(label({})).toBe('En la sucursal');
    // The map a phase-only context reads never claims a delivery either.
    expect(warrantyPhaseShortLabels.closed).toBe('Cerrada');
  });
  it('names the tramo that entered `closed` by the act of the case, not by the phase alone (S34)', () => {
    // The delivery states the phase, so the tramo of the history reads the act of the case that wrote it.
    const delivered = parseWarrantyCase(deliveredJSON());
    expect(warrantyEventLabel(delivered, delivered.events.at(-1)!)).toBe('Entregada al cliente');
    // The release is its own kind: the history names the act, never a phase it did not write.
    const released = parseWarrantyCase(releasedStockJSON());
    expect(warrantyEventLabel(released, released.events.at(-1)!)).toBe('Liberación a stock');
    // A finding closes with a tramo of its own and no client ever received those units.
    const finding = parseWarrantyCase(defectJSON({ phase: 'closed', events: [
      event({ ordinal: 1, phase: 'received' }), event({ ordinal: 2, phase: 'closed' })] }));
    expect(warrantyEventLabel(finding, finding.events.at(-1)!)).toBe('Cerrada por la sucursal');
    // Every other tramo keeps the label it always had.
    expect(warrantyEventLabel(delivered, delivered.events[0])).toBe('Recibida en la sucursal');
    const notice = parseWarrantyCase(resolvedJSON()).events.at(-1)!;
    expect(warrantyEventLabel(parseWarrantyCase(resolvedJSON()), notice)).toBe('Aviso al cliente');
  });
  it('offers the notice and the delivery only where the contract admits them (S4, S14)', () => {
    // The same case before the branch told the client anything: the notice is still owed.
    const waiting = parseWarrantyCase(resolvedJSONWithoutNotice());
    expect(warrantyNoticeAvailable(waiting)).toBe(true);
    expect(warrantyDeliveryAvailable(waiting)).toBe(true);
    expect(warrantyLoanRegistered(waiting)).toBe(true);
    expect(warrantyCloseAvailable(waiting)).toBe(false);
    const withoutLoan = parseWarrantyCase(resolvedJSON({ loans: [] }));
    expect(warrantyLoanRegistered(withoutLoan)).toBe(false);
    const noticed = parseWarrantyCase(resolvedJSON({ events: [
      event({ ordinal: 1, phase: 'received' }), event({ ordinal: 2, phase: 'in_transit' }),
      event({ ordinal: 3, phase: 'at_warehouse' }), event({ ordinal: 4, phase: 'at_factory', factory_case_number: 'F-2214' }),
      event({ ordinal: 5, phase: 'resolved' }), event({ ordinal: 6, kind: 'notice', phase: 'resolved' }),
    ] }));
    expect(warrantyNoticeAvailable(noticed)).toBe(false);
    expect(warrantyNoticeAvailable(parseWarrantyCase(defectJSON()))).toBe(false);
  });
  it('lets the case leave the branch only from reception and with its loan (S4)', () => {
    expect(warrantyDispatchAvailable(parseWarrantyCase(caseJSON()))).toBe(true);
    expect(warrantyDispatchAvailable(parseWarrantyCase(resolvedJSON()))).toBe(false);
  });
  it('prints a receipt only for a claim that handed a used battery over (S8)', () => {
    expect(warrantyReceiptAvailable(parseWarrantyCase(resolvedJSON()))).toBe(true);
    expect(warrantyReceiptAvailable(parseWarrantyCase(caseJSON()))).toBe(false);
    expect(warrantyReceiptAvailable(parseWarrantyCase(defectJSON()))).toBe(false);
    expect(warrantyReceiptPath(1)).toBe('/api/warranty-cases/1/receipt.pdf');
    expect(warrantyReceiptFileName(parseWarrantyCase(resolvedJSON()))).toBe('comprobante-C-2-000001.pdf');
  });
});

describe('the paths and the bodies of the writes', () => {
  it('sends the two admitted tray filters and nothing else', () => {
    expect(warrantyTrayPath()).toBe('/api/warranty-cases');
    expect(warrantyTrayPath({ phase: 'at_warehouse', origin: 'warranty_claim' }))
      .toBe('/api/warranty-cases?phase=at_warehouse&origin=warranty_claim');
    expect(warrantyTrayPath({ phase: 'all', origin: 'all' })).toBe('/api/warranty-cases');
    expect(() => warrantyTrayPath({ phase: 'in_factory' as never })).toThrow();
  });
  it('freezes the two doors and the claim that the serial is the only identity (S1, S2)', () => {
    expect(canonicalClaimBody('  ABC123 ', ' No arranca ')).toEqual({
      serial_number: 'ABC123', declared_failure: 'No arranca',
    });
    expect(() => canonicalClaimSerial('   ')).toThrow();
    expect(() => canonicalDeclaration('')).toThrow();
    expect(() => canonicalClaimBody('x'.repeat(65), 'Falla')).toThrow();
    expect(canonicalDefectBody(4, '2', 'No retiene carga', ' Probada en mostrador ')).toEqual({
      variant_id: 4, quantity: 2, declared_failure: 'No retiene carga', reason: 'Probada en mostrador',
    });
    expect(() => canonicalDefectBody(4, 0, 'Falla', 'Motivo')).toThrow();
    expect(() => canonicalDefectBody(4, 1, 'Falla', '  ')).toThrow();
  });
  it('identifies a loan by model and quantity, never by a serial (S5, S6)', () => {
    expect(canonicalLoanModel('  ns60l ')).toBe('NS60L');
    expect(() => canonicalLoanModel('MARCA NS60L CON SERIAL 123456789012345678901234567890')).toThrow();
    expect(canonicalLoanSerial('')).toBe('');
    expect(canonicalLoanBody('ns60l', '2', '  ', 3)).toEqual({
      model: 'NS60L', quantity: 2, serial_number: '', source_location_id: 3,
    });
    expect(() => canonicalLoanBody('NS60L', 0, '', 3)).toThrow();
    expect(() => canonicalLoanBody('NS60L', 1, '', 0)).toThrow();
  });
  it('states what became of one lent battery and refuses to state `open` again (S7)', () => {
    expect(canonicalLoanFateBody('failed')).toEqual({ fate: 'failed' });
    expect(canonicalLoanFateBody('kept_by_customer')).toEqual({ fate: 'kept_by_customer' });
    expect(() => canonicalLoanFateBody('open' as never)).toThrow();
    expect(warrantyLoanFatePath(2, 3)).toBe('/api/warranty-cases/2/loans/3/fate');
    expect(() => warrantyLoanFatePath(2, 0)).toThrow();
    expect(() => warrantyLoanFatePath(2, 101)).toThrow();
  });
  it('states the delivery fate, the notice and the two branch tramos', () => {
    expect(canonicalDeliveryBody('returned', 'Entregada la reparada')).toEqual({
      loan_fate: 'returned', note: 'Entregada la reparada',
    });
    expect(() => canonicalDeliveryBody('open' as never, 'x')).toThrow();
    expect(canonicalNoticeBody(' Avisado por teléfono ')).toEqual({ note: 'Avisado por teléfono' });
    expect(canonicalAdvanceBody('in_transit', 'Sale al Almacén')).toEqual({
      phase: 'in_transit', factory_case_number: '', note: 'Sale al Almacén',
    });
    expect(() => canonicalAdvanceBody('closed', '   ')).toThrow();
  });
});

describe('the notification count of the section', () => {
  it('reads the one decimal string the contract publishes, including an exact zero', () => {
    expect(parseWarrantyPending('{"action_count":"0"}')).toBe(0n);
    expect(parseWarrantyPending('{"action_count":"3"}')).toBe(3n);
    expect(warrantyPendingPath).toBe('/api/warranty-cases/counts');
  });
  it.each([
    '{}', '{"action_count":0}', '{"action_count":-1}', '{"action_count":"01"}',
    '{"action_count":" 1"}', '{"action_count":"3","pending_total":"3"}', '{"action_count":""}',
    '{"action_count":"9223372036854775808"}', '[]', 'null',
  ])('refuses a count this contract could not have published: %s', raw => {
    expect(() => parseWarrantyPending(raw)).toThrow();
  });
});
