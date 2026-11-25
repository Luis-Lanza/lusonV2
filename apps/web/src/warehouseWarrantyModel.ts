import {
  warrantyCustodyUnits, warrantyDaysSince, warrantyDestinations, warrantyNotice, warrantyReleased,
  warrantyUnitBoundForStock,
  type WarrantyAdvanceInput, type WarrantyCase, type WarrantyDestination, type WarrantyEvent,
  type WarrantyOrigin, type WarrantyPhase, type WarrantyVerdict,
} from './warrantyCasesModel';

/**
 * The warehouse's side of the battery warranty case (`apps/api/docs/warranty-cases.md`, S9, S10, S13,
 * S14, S15, S19). The Almacén moves the battery and nothing else: it receives, verifies and refuses
 * before the factory, ships with the file number it transcribes by hand, states the verdict and
 * authorises the release of the unit a claim holds in custody. It never opens a case, never lends,
 * never tells the client and never delivers — those are the branch's, and this module states no act
 * for them.
 *
 * Every figure here is derived from facts the contract publishes: the tray says the phase and the
 * instant of the admission, and the case says its verdict, its destinations and its append-only
 * history. The instant of a tramo is read from the history when the case is selected, because the
 * tray publishes the header of a case and never its events.
 */

// ---------------------------------------------------------------------------------
// The four questions of the desk
// ---------------------------------------------------------------------------------

/** The phases the warehouse has work in: what comes, what it must verify, what is at the factory, and
 * what came back waiting for a decision. It is the journey's own order, not an invented priority. */
export const warehousePhaseOrder = ['in_transit', 'at_warehouse', 'at_factory', 'resolved'] as const;
export type WarehousePhase = (typeof warehousePhaseOrder)[number];

export interface WarehouseBucket {
  readonly phase: WarehousePhase;
  readonly label: string;
  /** What the figure asks, in words: a number on this desk never travels alone. */
  readonly question: string;
}

export const warehouseBuckets: readonly WarehouseBucket[] = Object.freeze([
  { phase: 'in_transit', label: 'En tránsito',
    question: 'Salieron de la sucursal y todavía no llegaron al Almacén.' },
  { phase: 'at_warehouse', label: 'Para verificar',
    question: 'Esperan la verificación del Almacén antes de gastar el flete a fábrica.' },
  { phase: 'at_factory', label: 'En fábrica',
    question: 'Salieron con su legajo y esperan el veredicto de la fábrica.' },
  { phase: 'resolved', label: 'Devueltas sin decidir',
    question: 'Volvieron de fábrica y esperan el aviso, la liberación o la entrega de la sucursal.' },
] as const);

// ---------------------------------------------------------------------------------
// The acts the contract gives the warehouse, and only those
// ---------------------------------------------------------------------------------

/** The arrival is the first act the Almacén records, and only for what is already on its way (S9). */
export function warehouseArrivalAvailable(value: WarrantyCase): boolean {
  return value.phase === 'in_transit';
}

/** The shipment is never automatic: the warehouse verifies first and may refuse (S10). */
export function warehouseShipmentAvailable(value: WarrantyCase): boolean {
  return value.phase === 'at_warehouse';
}

/** At its gate the only verdict is the refusal; the factory's verdicts arrive at the factory (S10). */
export const warehouseGateVerdicts = ['refused_at_warehouse'] as const;
export const warehouseFactoryVerdicts = ['repaired', 'replaced', 'unrepairable', 'not_covered', 'lost'] as const;

/** The verdicts the desk may state on the phase the case holds: one gate per phase, never a choice. */
export function warehouseVerdicts(phase: WarrantyPhase): readonly WarrantyVerdict[] {
  if (phase === 'at_warehouse') return warehouseGateVerdicts;
  if (phase === 'at_factory') return warehouseFactoryVerdicts;
  return [];
}

export function warehouseVerdictAvailable(value: WarrantyCase): boolean {
  return warehouseVerdicts(value.phase).length > 0;
}

/**
 * Where the reported battery ends, for the verdict the desk is about to state. The contract states the
 * pair of a finding that returns its units and of an uncovered resolution; the rest of the vocabulary
 * stays open and the server's own matrix is what refuses a pair that does not belong (S11).
 */
export function warehouseReportedDestinations(origin: WarrantyOrigin,
  verdict: WarrantyVerdict): readonly WarrantyDestination[] {
  if (origin === 'stock_defect') {
    // S11: repaired or replaced units return to the branch's own sellable stock, and nowhere else.
    if (verdict === 'repaired' || verdict === 'replaced') return ['stock'];
    if (verdict === 'not_covered') return ['stock', 'scrap'];
  } else if (verdict === 'not_covered') {
    // The damaged unit goes to the used pool or out as scrap; the lent one stays with the client.
    return ['stock', 'scrap'];
  }
  return warrantyDestinations;
}

/** Where the lent battery ends. An uncovered claim leaves it with the client and nowhere else (S11). */
export function warehouseLoanDestinations(verdict: WarrantyVerdict): readonly WarrantyDestination[] {
  return verdict === 'not_covered' ? ['customer'] : warrantyDestinations;
}

/**
 * The two units one release returns (S13, S14, S31). The destination states where a unit went and the
 * verdict states in what condition it came back, and the two subjects of this act are:
 *
 *   - `customer`: the single repaired unit a claim got back for its client, which leaves custody to the
 *     counter that will hand it over; and
 *   - `stock`: the usable unit a claim got back for the branch's own shelf, which enters the branch's
 *     sellable stock and closes the case with that act, because no client ever comes to collect it.
 */
export type WarehouseReleaseSubject = 'customer' | 'stock';

/**
 * Which of the two units the release would return, or null when the case holds none. It names the same pair
 * the case model names for the whole app (`warrantyUnitBoundForStock`, 073's
 * `warranty_case_unit_bound_for_stock()`): a claim, and either a unit destined to the client or a
 * `repaired`/`replaced` unit destined to the branch's shelf. The destination column alone never answers it,
 * and a `not_covered` unit with that same destination is the pool de usadas (LW025, S11).
 */
export function warehouseReleaseSubjectKind(value: WarrantyCase): WarehouseReleaseSubject | null {
  if (value.origin !== 'warranty_claim') return null;
  if (value.reported_destination === 'customer') return 'customer';
  return warrantyUnitBoundForStock(value) ? 'stock' : null;
}

/**
 * The unit a release returns, whether it goes to the client or to the branch's shelf. A unit the factory
 * kept, scrapped or sent to the used pool never comes back, so it has nothing to release (S14, S31).
 */
export function warehouseReleaseSubject(value: WarrantyCase): boolean {
  return warehouseReleaseSubjectKind(value) !== null;
}

/** A release needs the recorded notice, the resolved verdict and a unit still in custody (S14, S19). */
export function warehouseReleaseAvailable(value: WarrantyCase): boolean {
  return warehouseReleaseSubject(value) && value.phase === 'resolved'
    && warrantyNotice(value) !== null && !warrantyReleased(value);
}

/** Why the desk cannot authorise the release of this case, stated beside the act it cannot offer (S15). */
export function warehouseReleaseBlocked(value: WarrantyCase): string {
  if (value.origin !== 'warranty_claim') {
    return 'El hallazgo en góndola no tiene unidad en custodia: sus unidades volvieron con su veredicto a la sucursal.';
  }
  if (value.phase !== 'resolved') {
    return 'La liberación existe recién cuando la fábrica respondió y el caso quedó resuelto.';
  }
  if (!warehouseReleaseSubject(value)) {
    return 'La batería reclamada no volvió como una unidad vendible: la fábrica la retuvo, la descartó o la mandó al pool de usadas, así que el caso no tiene ninguna unidad que liberar.';
  }
  if (warrantyReleased(value)) {
    return 'La unidad ya se liberó a stock vendible: la liberación ocurre una sola vez.';
  }
  return 'Falta el aviso que registra la sucursal: sin aviso al cliente no hay liberación.';
}

// ---------------------------------------------------------------------------------
// The three crossings of stock, legible where they happen (S13, S16, S14)
// ---------------------------------------------------------------------------------

export type WarehouseCrossingKey = 'write_off' | 'custody' | 'release';
export type WarehouseCrossingState = 'absent' | 'written' | 'returned' | 'held' | 'pending' | 'released';

export interface WarehouseCrossing {
  readonly key: WarehouseCrossingKey;
  readonly title: string;
  /** The units the crossing moves, and never a sellable figure while they are held. */
  readonly units: number;
  readonly state: WarehouseCrossingState;
  readonly note: string;
}

const unitsText = (quantity: number): string => `${quantity} ${quantity === 1 ? 'unidad' : 'unidades'}`;
const dayFormat = new Intl.DateTimeFormat('es-BO',
  { timeZone: 'America/La_Paz', day: '2-digit', month: '2-digit', year: 'numeric' });
const day = (instant: string): string => dayFormat.format(new Date(instant));

/**
 * The three places the case crosses the line between stock and custody. Only two doors write stock in
 * this vertical — the write-off of a finding and the release of a claim — and the units a case holds
 * while it waits are custody, never sellable stock (S13).
 */
export function warehouseStockCrossings(value: WarrantyCase): readonly WarehouseCrossing[] {
  const writeOff: WarehouseCrossing = value.origin === 'stock_defect'
    ? (value.stock_destination === 'stock'
      ? { key: 'write_off', title: 'Baja del hallazgo', units: value.quantity ?? 0, state: 'returned',
        note: `El veredicto devolvió ${unitsText(value.quantity ?? 0)} al stock vendible de la sucursal.` }
      : { key: 'write_off', title: 'Baja del hallazgo', units: value.quantity ?? 0, state: 'written',
        note: `La sucursal descontó ${unitsText(value.quantity ?? 0)} de su stock vendible al abrir el caso${value.reason === null ? '' : `, con el motivo «${value.reason}»`}. Hasta que un veredicto las devuelva, la baja sigue en pie.` })
    : { key: 'write_off', title: 'Baja del hallazgo', units: 0, state: 'absent',
      note: 'El caso entró por la garantía de una venta: la sucursal no descontó stock al abrirlo.' };

  const subject = warehouseReleaseSubjectKind(value);
  // The custody of the case is the case model's own reading, and this desk reads the same figure the branch
  // reads: the unit of a claim waits there whether a client will collect it or the release will sell it.
  const custodyUnits = warrantyCustodyUnits(value);
  const release = value.events.filter(entry => entry.kind === 'release').at(-1) ?? null;
  const custody: WarehouseCrossing = custodyUnits > 0
    ? { key: 'custody', title: 'Unidades en custodia', units: custodyUnits, state: 'held',
      note: `La unidad que volvió de fábrica está en custodia del caso, fuera de inventory_balances: no se cuenta como stock vendible, el punto de venta no puede venderla y la rendición la publica en una línea aparte.` }
    : { key: 'custody', title: 'Unidades en custodia', units: 0, state: 'absent',
      note: value.origin === 'stock_defect'
        ? 'El hallazgo en góndola no retiene ninguna unidad: su stock vuelve a la sucursal con el veredicto.'
        : release !== null
          ? subject === 'stock'
            ? 'El Almacén liberó la unidad al stock vendible de la sucursal y el caso cerró con ese acto: no queda ninguna unidad en custodia.'
            : 'El Almacén liberó la unidad a stock vendible: ya no está en custodia y el caso sigue esperando al cliente.'
          : value.reported_destination === 'stock'
            ? 'El caso no retiene ninguna unidad vendible: la batería que la fábrica no cubrió es del pool de usadas.'
            : 'El caso no retiene ninguna unidad mientras la fábrica no devuelva la que volverá al cliente.' };

  const releaseCrossing: WarehouseCrossing = value.origin !== 'warranty_claim'
    ? { key: 'release', title: 'Liberación a stock', units: 0, state: 'absent',
      note: 'El hallazgo en góndola no se libera: sus unidades son de la sucursal y vuelven con su veredicto.' }
    : release !== null
      ? { key: 'release', title: 'Liberación a stock', units: 1, state: 'released',
        note: `El Almacén liberó 1 unidad al stock vendible de la sucursal el ${day(release.recorded_at)} con la cuenta ${release.actor_account_id}${release.note === '' ? '' : `: «${release.note}»`}.${subject === 'stock' ? ' El caso cerró con ese acto.' : ''} La liberación ocurre una sola vez.` }
      : warehouseReleaseAvailable(value)
        ? { key: 'release', title: 'Liberación a stock', units: 1, state: 'pending',
          note: subject === 'stock'
            ? 'La unidad sigue en custodia: la liberación la suma al stock vendible de la sucursal, la saca de custodia y cierra el caso, en un solo acto y con motivo.'
            : 'La unidad sigue en custodia: la liberación la suma al stock vendible de la sucursal y la saca de custodia, en un solo acto y con motivo.' }
        : { key: 'release', title: 'Liberación a stock', units: 0, state: 'absent',
          note: warehouseReleaseBlocked(value) };

  return [writeOff, custody, releaseCrossing];
}

// ---------------------------------------------------------------------------------
// How long the case has been where it is (S9, S15)
// ---------------------------------------------------------------------------------

/** The tramo that put the case in the phase it holds: the last one of its history that states it. */
export function warehousePhaseSince(value: WarrantyCase): WarrantyEvent | null {
  return [...value.events].reverse().find(entry => entry.kind === 'phase' && entry.phase === value.phase) ?? null;
}

/** Whole days in the current phase, read from the history; null while the case states no such tramo. */
export function warehouseDaysInPhase(value: WarrantyCase, now: Date): number | null {
  const tramo = warehousePhaseSince(value);
  return tramo === null ? null : warrantyDaysSince(tramo.recorded_at, now);
}

// ---------------------------------------------------------------------------------
// The paths and the bodies of the warehouse's writes
// ---------------------------------------------------------------------------------

const maxID = 9_007_199_254_740_991;
const maxNote = 500;
const maxFile = 200;

function caseID(id: number): number {
  if (!Number.isInteger(id) || id < 1 || id > maxID) throw new Error('Caso inválido.');
  return id;
}

export function warehouseResolutionPath(id: number): string {
  return `/api/warranty-cases/${caseID(id)}/resolution`;
}
export function warehouseReleasePath(id: number): string {
  return `/api/warranty-cases/${caseID(id)}/release`;
}

function boundedWords(value: string, message: string): string {
  const words = value.trim();
  if (words === '' || [...words].length > maxNote || !words.isWellFormed() || words.includes('\0')) {
    throw new Error(message);
  }
  return words;
}

/** The motive of an act: every tramo, every verdict and every release state one, and it is the evidence. */
function motive(value: string): string {
  return boundedWords(value, `Escribí el motivo, de 1 a ${maxNote} caracteres.`);
}

/** The arrival at the Almacén carries no file number: the shipment to the factory is the only one (S9). */
export function canonicalWarehouseArrival(note: string): WarrantyAdvanceInput {
  return Object.freeze({ phase: 'at_warehouse', factory_case_number: '', note: motive(note) });
}

/** The shipment to the factory transcribes the file number by hand, and it is required (S9, S10). */
export function canonicalFactoryShipment(fileNumber: string, note: string): WarrantyAdvanceInput {
  const file = fileNumber.trim();
  if (file === '' || [...file].length > maxFile || !file.isWellFormed() || file.includes('\0')) {
    throw new Error(`El envío a fábrica exige el número de legajo, de 1 a ${maxFile} caracteres.`);
  }
  return Object.freeze({ phase: 'at_factory', factory_case_number: file, note: motive(note) });
}

/** The body of a claim's verdict: it states the reported unit and the lent one (S11). */
export interface WarrantyClaimResolutionInput {
  readonly verdict: WarrantyVerdict;
  readonly reported_destination: WarrantyDestination;
  readonly loan_destination: WarrantyDestination;
  readonly note: string;
}

/** The body of a finding's verdict: it states the shelf's units and no loan at all (S11). */
export interface WarrantyDefectResolutionInput {
  readonly verdict: WarrantyVerdict;
  readonly reported_destination: WarrantyDestination;
  readonly note: string;
}

function verdictGate(verdict: WarrantyVerdict, origin: WarrantyOrigin, reported: WarrantyDestination): void {
  if (origin === 'stock_defect') {
    if ((verdict === 'repaired' || verdict === 'replaced') && reported !== 'stock') {
      throw new Error('El veredicto que devuelve unidades las devuelve al stock vendible de la sucursal.');
    }
    if (verdict === 'not_covered' && reported !== 'stock' && reported !== 'scrap') {
      throw new Error('La unidad no cubierta queda en el pool de usadas o sale como chatarra.');
    }
  }
  if (origin === 'warranty_claim' && verdict === 'not_covered'
    && reported !== 'stock' && reported !== 'scrap') {
    throw new Error('La unidad dañada y no cubierta queda en el pool de usadas o sale como chatarra.');
  }
}

export function canonicalClaimResolutionBody(verdict: WarrantyVerdict, reported: WarrantyDestination,
  loanDestination: WarrantyDestination | null, note: string): WarrantyClaimResolutionInput {
  verdictGate(verdict, 'warranty_claim', reported);
  if (loanDestination === null) {
    throw new Error('El veredicto de un reclamo dice también qué pasa con la usada prestada.');
  }
  if (verdict === 'not_covered' && loanDestination !== 'customer') {
    throw new Error('La garantía no cubierta deja la usada con el cliente.');
  }
  return Object.freeze({
    verdict, reported_destination: reported, loan_destination: loanDestination, note: motive(note),
  });
}

export function canonicalDefectResolutionBody(verdict: WarrantyVerdict, reported: WarrantyDestination,
  note: string): WarrantyDefectResolutionInput {
  verdictGate(verdict, 'stock_defect', reported);
  return Object.freeze({ verdict, reported_destination: reported, note: motive(note) });
}

/** The release states its motive and nothing else: the unit is the contract's own reading (S14). */
export function canonicalReleaseBody(note: string): { readonly note: string } {
  return Object.freeze({ note: motive(note) });
}
