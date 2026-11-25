import { describe, expect, it } from 'vitest';
import { parseWarrantyCase, canonicalAdvanceBody } from './warrantyCasesModel';
import {
  canonicalClaimResolutionBody, canonicalDefectResolutionBody, canonicalFactoryShipment,
  canonicalReleaseBody, canonicalWarehouseArrival, warehouseBuckets, warehouseDaysInPhase,
  warehouseLoanDestinations, warehousePhaseSince, warehouseReleaseAvailable, warehouseReleaseBlocked,
  warehouseReleaseSubject, warehouseReleaseSubjectKind, warehouseReportedDestinations,
  warehouseShipmentAvailable, warehouseStockCrossings,
  warehouseVerdicts, warehouseVerdictAvailable, warehouseArrivalAvailable, warehouseResolutionPath,
  warehouseReleasePath,
} from './warehouseWarrantyModel';

// The tray row is the header of a case and nothing else; the case adds its resolution, its loans and
// its append-only history. Numbers travel as JSON numbers, exactly as Go publishes them.
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
const claimJSON = (over: Record<string, unknown> = {}) => JSON.stringify({
  ...row(), verdict: null, reported_destination: null, loan_destination: null, stock_destination: null,
  sale_id: 12, warranty_number: '2-000012', created_by_account_id: 2, loans: [], events: [], ...over,
});
const findingJSON = (over: Record<string, unknown> = {}) => JSON.stringify({
  ...row({ origin: 'stock_defect', serial_number: null, quantity: 2, reason: 'Probada en mostrador' }),
  verdict: null, reported_destination: null, loan_destination: null, stock_destination: null,
  sale_id: null, warranty_number: null, created_by_account_id: 2, loans: [], events: [], ...over,
});
// The tramos the warehouse moves before the factory answers, with the file number it transcribes (S9).
const atFactoryEvents = () => [
  event({ ordinal: 1, phase: 'received', recorded_at: '2026-03-01T12:00:00Z' }),
  event({ ordinal: 2, phase: 'in_transit', recorded_at: '2026-03-02T12:00:00Z' }),
  event({ ordinal: 3, phase: 'at_warehouse', recorded_at: '2026-03-03T12:00:00Z' }),
  event({ ordinal: 4, phase: 'at_factory', factory_case_number: 'F-2214', recorded_at: '2026-03-10T12:00:00Z' }),
];
const findingEvents = () => [
  event({ ordinal: 1, phase: 'received', recorded_at: '2026-03-01T12:00:00Z' }),
  event({ ordinal: 2, phase: 'in_transit', recorded_at: '2026-03-02T12:00:00Z' }),
  event({ ordinal: 3, phase: 'at_warehouse', recorded_at: '2026-03-03T12:00:00Z' }),
  event({ ordinal: 4, phase: 'at_factory', factory_case_number: 'F-2214', recorded_at: '2026-03-10T12:00:00Z' }),
];
/** A claim the factory answered and whose unit came back for the client, still in custody (S13). */
const resolvedClaim = (over: Record<string, unknown> = {}) => parseWarrantyCase(claimJSON({
  phase: 'resolved', verdict: 'repaired', reported_destination: 'customer', loan_destination: 'stock',
  loans: [loan()],
  events: [...atFactoryEvents(),
    event({ ordinal: 5, phase: 'resolved', recorded_at: '2026-03-12T12:00:00Z', note: 'Reparada por fábrica' })],
  ...over,
}));
const noticedClaim = (over: Record<string, unknown> = {}) => parseWarrantyCase(claimJSON({
  phase: 'resolved', verdict: 'repaired', reported_destination: 'customer', loan_destination: 'stock',
  loans: [loan()],
  events: [...atFactoryEvents(),
    event({ ordinal: 5, phase: 'resolved', recorded_at: '2026-03-12T12:00:00Z', note: 'Reparada por fábrica' }),
    event({ ordinal: 6, kind: 'notice', phase: 'resolved', recorded_at: '2026-03-16T12:00:00Z', note: 'Avisado por teléfono' })],
  ...over,
}));
const releasedClaim = (over: Record<string, unknown> = {}) => parseWarrantyCase(claimJSON({
  phase: 'resolved', verdict: 'repaired', reported_destination: 'customer', loan_destination: 'stock',
  loans: [loan()],
  events: [...atFactoryEvents(),
    event({ ordinal: 5, phase: 'resolved', recorded_at: '2026-03-12T12:00:00Z', note: 'Reparada por fábrica' }),
    event({ ordinal: 6, kind: 'notice', phase: 'resolved', recorded_at: '2026-03-16T12:00:00Z', note: 'Avisado' }),
    event({ ordinal: 7, kind: 'release', phase: 'resolved', recorded_at: '2026-03-18T12:00:00Z', note: 'El cliente no volvió' })],
  ...over,
}));
const atWarehouseClaim = (over: Record<string, unknown> = {}) => parseWarrantyCase(claimJSON({
  phase: 'at_warehouse',
  events: atFactoryEvents().slice(0, 3), ...over,
}));
/** A claim whose usable unit is destined to the branch's own shelf: no client comes to collect it (S31). */
const stockBoundClaim = ({ verdict = 'repaired', notice = true, released = false }:
{ verdict?: string; notice?: boolean; released?: boolean } = {}) => parseWarrantyCase(claimJSON({
  // The release of this unit is the act that closes the case, and it states that `closed` itself (073).
  phase: released ? 'closed' : 'resolved', closed_by: released ? 'release' : null, verdict,
  reported_destination: 'stock', loan_destination: 'customer',
  loans: [loan()],
  events: [...atFactoryEvents(),
    event({ ordinal: 5, phase: 'resolved', recorded_at: '2026-03-12T12:00:00Z', note: 'Reparada por fábrica' }),
    ...(notice ? [event({ ordinal: 6, kind: 'notice', phase: 'resolved',
      recorded_at: '2026-03-16T12:00:00Z', note: 'Avisado por teléfono' })] : []),
    ...(released ? [event({ ordinal: 7, kind: 'release', phase: 'closed',
      recorded_at: '2026-03-18T12:00:00Z', note: 'El cliente no vino' })] : [])],
}));
const resolvedFinding = (over: Record<string, unknown> = {}) => parseWarrantyCase(findingJSON({
  phase: 'resolved', verdict: 'repaired', reported_destination: 'stock', stock_destination: 'stock',
  events: [...findingEvents(),
    event({ ordinal: 5, phase: 'resolved', recorded_at: '2026-03-12T12:00:00Z', note: 'Reparadas por fábrica' })],
  ...over,
}));
const now = () => new Date('2026-03-20T12:00:00Z');

describe('the four questions of the desk', () => {
  it('says what each figure of the mesa is, in the order of the journey (S9, S10, S13, S14)', () => {
    expect(warehouseBuckets.map(bucket => bucket.phase))
      .toEqual(['in_transit', 'at_warehouse', 'at_factory', 'resolved']);
    expect(warehouseBuckets.map(bucket => bucket.label))
      .toEqual(['En tránsito', 'Para verificar', 'En fábrica', 'Devueltas sin decidir']);
    // Every figure says in words what it asks, so the number never travels alone.
    for (const bucket of warehouseBuckets) expect(bucket.question.length).toBeGreaterThan(20);
  });
});

describe('the acts the contract gives the warehouse', () => {
  it('receives only what is on its way and ships only what it already verified (S9, S10)', () => {
    const transit = parseWarrantyCase(claimJSON({ phase: 'in_transit', events: atFactoryEvents().slice(0, 2) }));
    expect(warehouseArrivalAvailable(transit)).toBe(true);
    expect(warehouseShipmentAvailable(transit)).toBe(false);
    expect(warehouseShipmentAvailable(atWarehouseClaim())).toBe(true);
    expect(warehouseArrivalAvailable(atWarehouseClaim())).toBe(false);
    const factory = parseWarrantyCase(claimJSON({ phase: 'at_factory', events: atFactoryEvents() }));
    expect(warehouseArrivalAvailable(factory)).toBe(false);
    expect(warehouseShipmentAvailable(factory)).toBe(false);
  });

  it('opens the verdict at the two gates it owns and nowhere else (S10, S11)', () => {
    expect(warehouseVerdicts('at_warehouse')).toEqual(['refused_at_warehouse']);
    expect(warehouseVerdicts('at_factory')).toEqual(['repaired', 'replaced', 'unrepairable', 'not_covered', 'lost']);
    expect(warehouseVerdicts('in_transit')).toEqual([]);
    expect(warehouseVerdicts('resolved')).toEqual([]);
    expect(warehouseVerdictAvailable(atWarehouseClaim())).toBe(true);
    expect(warehouseVerdictAvailable(resolvedClaim())).toBe(false);
  });

  it('states the destinations the contract states per door and per verdict (S11)', () => {
    // A finding that returns its units returns them to the branch's own sellable stock, and nowhere else.
    expect(warehouseReportedDestinations('stock_defect', 'repaired')).toEqual(['stock']);
    expect(warehouseReportedDestinations('stock_defect', 'replaced')).toEqual(['stock']);
    expect(warehouseReportedDestinations('stock_defect', 'not_covered')).toEqual(['stock', 'scrap']);
    // A claim never states the shelf's destination, and a refused bank of the factory leaves it out.
    expect(warehouseReportedDestinations('warranty_claim', 'repaired')).toContain('customer');
    // S11: the uncovered claim leaves the lent battery with the client and nothing else.
    expect(warehouseLoanDestinations('not_covered')).toEqual(['customer']);
    expect(warehouseLoanDestinations('repaired')).toContain('stock');
  });
});

describe('the custody and the release (S13, S14, S19)', () => {
  it('offers the release of a usable unit bound for stock, the pair the contract names (S31)', () => {
    // The backend names this pair in warranty_case_unit_bound_for_stock(): a claim whose destination is
    // `stock` and whose verdict is repaired or replaced is released by the Almacén, and that release is
    // the act that closes the case. The screen reads the same pair and never the destination alone.
    expect(warehouseReleaseSubject(stockBoundClaim())).toBe(true);
    expect(warehouseReleaseSubjectKind(stockBoundClaim())).toBe('stock');
    expect(warehouseReleaseSubject(stockBoundClaim({ verdict: 'replaced' }))).toBe(true);
    expect(warehouseReleaseSubjectKind(stockBoundClaim({ verdict: 'replaced' }))).toBe('stock');
    // The rest of the gate does not move: the notice, the resolved verdict and the single act stay (S14).
    expect(warehouseReleaseAvailable(stockBoundClaim())).toBe(true);
    expect(warehouseReleaseAvailable(stockBoundClaim({ notice: false }))).toBe(false);
    // Once released the case is closed: the same act that sells the unit ends it, and it happens once.
    expect(warehouseReleaseAvailable(stockBoundClaim({ released: true }))).toBe(false);
    expect(warehouseReleaseAvailable(parseWarrantyCase(claimJSON({
      phase: 'at_factory', events: atFactoryEvents(),
    })))).toBe(false);
    // The destination never answers it alone: an uncovered unit is the used pool's (LW025, S11), and the
    // client's own unit is the other subject of the same act.
    const pooled = stockBoundClaim({ verdict: 'not_covered' });
    expect(warehouseReleaseSubject(pooled)).toBe(false);
    expect(warehouseReleaseSubjectKind(pooled)).toBeNull();
    expect(warehouseReleaseAvailable(pooled)).toBe(false);
    expect(warehouseReleaseBlocked(pooled)).toMatch(/pool de usadas/);
    expect(warehouseReleaseSubject(noticedClaim())).toBe(true);
    expect(warehouseReleaseSubjectKind(noticedClaim())).toBe('customer');
  });

  it('publishes the release of a stock-bound unit as the act that closes the case (S31)', () => {
    const pending = warehouseStockCrossings(stockBoundClaim());
    // The unit waits in custody exactly like the one a client will collect, and the release says that
    // this act is the one that closes the case, never that a battery went back to a client.
    expect(pending[1]).toMatchObject({ key: 'custody', units: 1, state: 'held' });
    expect(pending[2]).toMatchObject({ key: 'release', units: 1, state: 'pending' });
    expect(pending[2].note).toMatch(/cierra el caso/);
    expect(pending[2].note).not.toMatch(/cliente/);

    const closed = warehouseStockCrossings(stockBoundClaim({ released: true }));
    expect(closed[1].units).toBe(0);
    expect(closed[2].state).toBe('released');
    expect(closed[2].note).toMatch(/cerró con ese acto/);

    // The uncovered unit is the pool de usadas', and the crossing says so instead of naming a client.
    const pooled = warehouseStockCrossings(stockBoundClaim({ verdict: 'not_covered' }));
    expect(pooled[1].state).toBe('absent');
    expect(pooled[1].note).toMatch(/pool de usadas/);
    expect(pooled[2].state).toBe('absent');
  });

  it('offers the release only to a resolved claim whose notice is on record', () => {
    expect(warehouseReleaseAvailable(noticedClaim())).toBe(true);
    expect(warehouseReleaseAvailable(resolvedClaim())).toBe(false);
    expect(warehouseReleaseAvailable(releasedClaim())).toBe(false);
  });

  it('offers no release when the battery never came back or the door was a finding', () => {
    const keptByFactory = parseWarrantyCase(claimJSON({
      phase: 'resolved', verdict: 'unrepairable', reported_destination: 'retained_by_factory',
      loan_destination: 'customer',
      events: [...atFactoryEvents(),
        event({ ordinal: 5, phase: 'resolved', recorded_at: '2026-03-12T12:00:00Z', note: 'Sin reparación' }),
        event({ ordinal: 6, kind: 'notice', phase: 'resolved', recorded_at: '2026-03-16T12:00:00Z', note: 'Avisado' })],
    }));
    expect(warehouseReleaseAvailable(keptByFactory)).toBe(false);
    expect(warehouseReleaseBlocked(keptByFactory)).toMatch(/no volvió/);
    expect(warehouseReleaseAvailable(resolvedFinding())).toBe(false);
    expect(warehouseReleaseBlocked(resolvedFinding())).toMatch(/no tiene unidad en custodia/);
    expect(warehouseReleaseBlocked(resolvedClaim())).toMatch(/aviso/);
    expect(warehouseReleaseBlocked(releasedClaim())).toMatch(/una sola vez/);
  });

  it('publishes the three crossings of stock and never calls custody units sellable stock', () => {
    const claim = warehouseStockCrossings(resolvedClaim());
    expect(claim.map(crossing => crossing.key)).toEqual(['write_off', 'custody', 'release']);
    // A claim wrote no stock at its admission: the shelf was never touched.
    expect(claim[0].state).toBe('absent');
    expect(claim[1].units).toBe(1);
    expect(claim[1].state).toBe('held');
    expect(claim[1].note).toMatch(/no se cuenta como stock vendible/);
    // Without the notice the bank is not there: the crossing says why, and it says it in words.
    expect(claim[2].state).toBe('absent');
    expect(claim[2].note).toMatch(/aviso/);
    const ready = warehouseStockCrossings(noticedClaim());
    expect(ready[2].state).toBe('pending');
    expect(ready[2].units).toBe(1);
    expect(ready[2].note).toMatch(/stock vendible/);

    const returned = warehouseStockCrossings(resolvedFinding());
    expect(returned[0].units).toBe(2);
    expect(returned[0].state).toBe('returned');
    expect(returned[0].note).toMatch(/devolvió 2 unidades al stock vendible/);

    const writtenOff = warehouseStockCrossings(parseWarrantyCase(findingJSON({
      phase: 'resolved', verdict: 'not_covered', reported_destination: 'scrap',
      events: [...findingEvents(),
        event({ ordinal: 5, phase: 'resolved', recorded_at: '2026-03-12T12:00:00Z', note: 'No cubierta' })],
    })));
    expect(writtenOff[0].state).toBe('written');
    expect(writtenOff[0].note).toMatch(/Probada en mostrador/);

    const released = warehouseStockCrossings(releasedClaim());
    expect(released[1].units).toBe(0);
    expect(released[2].state).toBe('released');
    expect(released[2].note).toMatch(/18\/03\/2026|2026-03-18/);
  });

  it('decides the custody sentence by the pair of destination and verdict, never by the destination (S31)', () => {
    // The usable unit bound for the branch's shelf is not the used pool's, and the destination alone cannot
    // tell the two apart: this case states a repair, so no sentence may claim the factory did not cover it.
    const boundBeforeResolution = parseWarrantyCase(claimJSON({
      phase: 'at_factory', verdict: 'repaired', reported_destination: 'stock', loan_destination: 'customer',
      loans: [loan()], events: atFactoryEvents(),
    }));
    const bound = warehouseStockCrossings(boundBeforeResolution)[1];
    expect(bound).toMatchObject({ key: 'custody', units: 0, state: 'absent' });
    expect(bound.note).not.toMatch(/pool de usadas/);
    expect(bound.note).not.toMatch(/no cubrió/);
    expect(bound.note).toMatch(/stock vendible de la sucursal/);
    expect(bound.note).toMatch(/liberación del Almacén/);

    // The uncovered unit is the pool's, and that sentence stays word for word (S11).
    const pool = warehouseStockCrossings(stockBoundClaim({ verdict: 'not_covered' }))[1];
    expect(pool.note).toBe('El caso no retiene ninguna unidad vendible: la batería que la fábrica no cubrió es del pool de usadas.');
  });

  it('reads how long the case has been where it is from its own history (S9, S15)', () => {
    const factory = parseWarrantyCase(claimJSON({ phase: 'at_factory', events: atFactoryEvents() }));
    expect(warehousePhaseSince(factory)?.recorded_at).toBe('2026-03-10T12:00:00Z');
    expect(warehouseDaysInPhase(factory, now())).toBe(10);
    // A clock behind the last tramo never counts backwards.
    expect(warehouseDaysInPhase(factory, new Date('2026-03-09T12:00:00Z'))).toBe(0);
  });
});

describe('the bodies and the paths of the warehouse writes', () => {
  it('receives with no file number and ships the factory file number it transcribes (S9, S10)', () => {
    expect(canonicalWarehouseArrival(' Llegó al Almacén ')).toEqual({
      phase: 'at_warehouse', factory_case_number: '', note: 'Llegó al Almacén',
    });
    expect(canonicalFactoryShipment(' F-2214 ', 'Salió a fábrica')).toEqual({
      phase: 'at_factory', factory_case_number: 'F-2214', note: 'Salió a fábrica',
    });
    expect(() => canonicalFactoryShipment('   ', 'Salió a fábrica')).toThrow(/legajo/);
    expect(() => canonicalFactoryShipment('F-2214', '  ')).toThrow(/motivo/);
  });

  it('states the verification refusal and the factory verdict, each door with its own units (S10, S11)', () => {
    expect(canonicalClaimResolutionBody('refused_at_warehouse', 'customer', 'stock', 'No pasa la prueba'))
      .toEqual({ verdict: 'refused_at_warehouse', reported_destination: 'customer',
        loan_destination: 'stock', note: 'No pasa la prueba' });
    // A finding lends nothing, so its body states no loan destination at all.
    expect(canonicalDefectResolutionBody('repaired', 'stock', 'Reparadas por fábrica'))
      .toEqual({ verdict: 'repaired', reported_destination: 'stock', note: 'Reparadas por fábrica' });
    expect(() => canonicalClaimResolutionBody('repaired', 'customer', null, 'Reparada')).toThrow(/usada/);
    expect(() => canonicalDefectResolutionBody('repaired', 'customer', 'Reparadas')).toThrow(/stock/);
    expect(() => canonicalDefectResolutionBody('repaired', 'stock', ' ')).toThrow(/motivo/);
  });

  it('releases with the motive the decision carries and nothing else (S14)', () => {
    expect(canonicalReleaseBody(' El cliente no volvió ')).toEqual({ note: 'El cliente no volvió' });
    expect(() => canonicalReleaseBody('')).toThrow(/motivo/);
  });

  it('names the two routes of the contract and refuses a case that does not exist', () => {
    expect(warehouseResolutionPath(1)).toBe('/api/warranty-cases/1/resolution');
    expect(warehouseReleasePath(7)).toBe('/api/warranty-cases/7/release');
    expect(() => warehouseResolutionPath(0)).toThrow();
    expect(() => warehouseReleasePath(1.5)).toThrow();
  });

  it('leaves the branch\'s own two tramos exactly as they were (S19)', () => {
    // The warehouse widened the tramo vocabulary of the contract, never the branch's own bodies.
    expect(canonicalAdvanceBody('in_transit', ' Sale al Almacén ')).toEqual({
      phase: 'in_transit', factory_case_number: '', note: 'Sale al Almacén',
    });
    expect(canonicalAdvanceBody('closed', 'Cerrado por la sucursal')).toEqual({
      phase: 'closed', factory_case_number: '', note: 'Cerrado por la sucursal',
    });
  });
});

