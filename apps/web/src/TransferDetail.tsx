import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { TransferController, SourceInventoryController } from './useInventory';
import { loadSourceInventory, SourceInventoryError, type SourceCatalog } from './sourceInventory';
import { transferQuantityTotal, type TransferRecord } from './transferModel';
import { transferViewOwner } from './TransferPending';
import { ReceiptTable } from './TransferReceipt';
import TransferCountCorrections, { type TransferCountCorrectionsProps } from './TransferCountCorrections';
import TransferRestitutions from './TransferRestitutions';
import TransferDispatchReconciliations from './TransferDispatchReconciliations';
import TransferDate from './TransferDate';
import TransferActivity from './TransferActivity';
import { Icon } from './icons';
import './transfer-detail.css';
import './transfer-approved.css';
import './transfer-transit.css';
import './transfer-received.css';
import { projectTransferReceived, type ReceivedQuantities } from './transferReceivedModel';
import type { DispatchReconciliationLine, DispatchReconciliations } from './transferDispatchReconciliationModel';
import type { useTransferDispatchReconciliations } from './useTransferDispatchReconciliations';
import type { CountCorrectionLine, CountProposal } from './transferCountCorrectionModel';

export type DetailController = TransferController & Partial<SourceInventoryController>;
export interface StockAdvice { catalog: SourceCatalog | null; busy: boolean; unavailable: boolean }
export interface TransferDetailProps {
  controller: DetailController;
  ownerTag: string;
  record: TransferRecord;
  actions?: (stock: StockAdvice) => ReactNode;
  onStock?: (stock: StockAdvice, recordID: string) => void;
  stockRefresh?: number;
  corrections?: TransferCountCorrectionsProps['corrections'];
  correctionRequestID?: string | null;
  correctionsEnabled?: boolean;
  restitutionRequestID?: string | null;
  restitutionsEnabled?: boolean;
  reconciliations?: ReturnType<typeof useTransferDispatchReconciliations>;
  reconciliationRequestID?: string | null;
  reconciliationsEnabled?: boolean;
}

// Local render/handler fence only. Nothing here becomes a decision/retry identity.
export function detailAuthority(controller: TransferController): string {
  const a = controller.getTransferAuthority();
  const s = a.session;
  return a.ready && s?.authenticated ? JSON.stringify([a.epoch, a.sessionGeneration ?? 0,
    s.identity.account_id, s.identity.username, s.identity.location.id, s.identity.location.name,
    s.csrf_token, s.expires_at]) : '';
}
export function transferStatusLabel(record: TransferRecord) {
  return record.status === 'pending' ? 'Pendiente de aprobación' : record.status === 'approved' ? record.kind === 'direct_shipment' ? 'Pendiente de despacho' : 'Aprobada' : record.status === 'in_transit' ? 'En tránsito' : record.status === 'received' ? 'Recibida' : record.status === 'cancelled' ? 'Cancelada' : 'Rechazada';
}
function Stock({ stock, variant, compact = false }: { stock: StockAdvice; variant: number; compact?: boolean }) {
  const row = stock.catalog?.rows.find(item => item.variant_id === variant);
  if (stock.busy) return <span>Consultando stock…</span>;
  if (!row) return <span>Disponibilidad no disponible</span>;
  if (compact) return <span>{row.available.toString()} uds.</span>;
  return <span className="transfer-stock"><strong>{row.available.toString()} disponibles</strong>
    <small>Existencias: {row.existing.toString()} · Reservadas: {row.reserved.toString()}</small></span>;
}
export function TransferItems({ record, stock, confirmation = false, reject = false, dispatch = false, compact = false, approved = false, sent = false, cancellation = false }: {
  record: TransferRecord; stock?: StockAdvice; confirmation?: boolean; reject?: boolean; dispatch?: boolean; compact?: boolean; approved?: boolean; sent?: boolean; cancellation?: boolean;
}) {
  const advice = stock && !reject && !approved && !sent && !cancellation;
  const pendingDetail = compact && !confirmation;
  const closed = compact && (record.status === 'rejected' || record.status === 'cancelled');
  const proposed = compact && record.kind === 'send_to_warehouse' && (record.status === 'pending' || record.status === 'approved' || closed);
  const directClosed = closed && record.kind === 'direct_shipment';
  const directApproved = compact && record.kind === 'direct_shipment' && record.status === 'approved';
  const quantityLabel = cancellation ? 'A cancelar' : directClosed ? 'Previstas' : directApproved ? 'A despachar' : proposed ? 'Propuestas' : 'Solicitadas';
  const reservationLabel = `Reservadas para ${directApproved ? 'este envío' : proposed ? 'esta propuesta' : 'esta solicitud'}`;
  return <div className="table-scroll transfer-detail-items"><table>
    <caption className="sr-only">{cancellation ? `${record.kind === 'direct_shipment' ? 'Envío completo' : record.kind === 'send_to_warehouse' ? 'Propuesta completa' : 'Solicitud completa'} a cancelar` : confirmation ? directApproved ? 'Envío completo a confirmar' : proposed ? 'Propuesta completa a confirmar' : 'Solicitud completa a confirmar' : sent ? 'Baterías enviadas' : directClosed ? 'Baterías previstas' : directApproved ? 'Baterías a despachar' : proposed ? 'Baterías propuestas' : 'Baterías solicitadas'}</caption>
    <thead><tr><th scope="col">{compact && confirmation ? 'Producto' : 'Batería'}</th><th scope="col">Polaridad</th>
      <th scope="col">{cancellation ? quantityLabel : sent ? 'Enviadas' : compact && dispatch ? 'A despachar' : compact ? quantityLabel : dispatch ? 'Cantidad a despachar' : (record.status === 'in_transit' || record.status === 'received') ? 'Cantidad enviada' : confirmation && !reject ? 'Cantidad a reservar' : 'Cantidad solicitada'}</th>
      {approved && <th scope="col">{reservationLabel}</th>}
      {advice && <th scope="col">{compact ? 'Disponibles en origen' : `Disponible en ${record.origin_location_name} (orientativo)`}</th>}</tr></thead>
    <tbody>{record.items.map(item => <tr key={item.variant_id} data-variant-id={item.variant_id}>
      <td>{compact && confirmation ? <>{item.brand} {item.model} · <span>{item.capacity_ah} Ah</span></>
        : <><strong>{item.brand} · {item.model}</strong><small>{item.capacity_ah} Ah</small></>}</td>
      <td data-label={pendingDetail ? 'Polaridad' : undefined}>{item.polarity === 'L' ? 'Izquierda [L]' : 'Derecha [R]'}</td>
      <td data-label={sent ? 'Enviadas' : pendingDetail ? quantityLabel : undefined}>{item.quantity.toString()}</td>
      {/* Approved records reserve the entire immutable request, not a live inventory balance. */}
      {approved && <td data-label={reservationLabel}>{item.quantity.toString()} uds.</td>}
      {advice && <td data-label={pendingDetail ? 'Disponibles en origen' : undefined}><Stock stock={stock} variant={item.variant_id} compact={compact} /></td>}
    </tr>)}</tbody>
    {(!compact || confirmation) && <tfoot><tr><td colSpan={advice ? 4 : 3}>{compact && confirmation ? 'Total: ' : ''}{record.items.length} variantes · {transferQuantityTotal(record).toString()} baterías</td></tr></tfoot>}
  </table></div>;
}

function ReceivedDifferences({ quantities }: { quantities: ReceivedQuantities }) {
  return <>{quantities.shortage > 0n && <span className="received-difference">Faltante: {quantities.shortage.toString()}</span>}
    {quantities.excess > 0n && <span className="received-difference">Exceso: {quantities.excess.toString()}</span>}
    {quantities.unexpected > 0n && <span className="received-difference">No enviada: {quantities.unexpected.toString()}</span>}
    {quantities.shortage === 0n && quantities.excess === 0n && quantities.unexpected === 0n
      && <span className="received-matched">✓ Sin diferencias de conteo</span>}</>;
}

// Presentation proof only: the effective table remains the GET projection.
// Revisions are per variant; decisions retain their proposal's revision.
function countResultProof(line: CountCorrectionLine, record: TransferRecord, reconciliation?: DispatchReconciliationLine) {
  const quantity = (n: bigint) => n >= 0n && n <= 9223372036854775807n;
  const credit = (n: bigint) => n < line.expected_quantity ? n : line.expected_quantity;
  const participant = (id: number) => id === record.origin_location_id || id === record.destination_location_id;
  const proposals = new Map<bigint, CountProposal>();
  const keys = new Set<string>();
  if (![line.expected_quantity, line.actual_quantity, line.available_quantity, line.effective_actual,
    line.effective_credit, line.workflow_revision, line.applied_revision].every(quantity)
    || line.available_quantity !== credit(line.actual_quantity)) return null;
  for (const p of line.proposals) {
    if (!quantity(p.revision) || p.revision === 0n || proposals.has(p.revision)
      || !quantity(p.actual_quantity) || !quantity(p.base_revision) || !quantity(p.base_credit)
      || !participant(p.initiator_location_id) || keys.has(p.operation_key)) return null;
    proposals.set(p.revision, p); keys.add(p.operation_key);
    if (p.decision) {
      if (!participant(p.decision.actor_location_id) || p.decision.actor_location_id === p.initiator_location_id
        || keys.has(p.decision.operation_key)) return null;
      keys.add(p.decision.operation_key);
    }
  }
  const applied = line.proposals.filter(p => p.state === 'applied');
  const latestRevision = line.proposals.reduce((max, p) => p.revision > max ? p.revision : max, 0n);
  const appliedRevision = applied.reduce((max, p) => p.revision > max ? p.revision : max, 0n);
  if (line.workflow_revision !== latestRevision || line.applied_revision !== appliedRevision) return null;
  // Strictly decreasing references exclude cycles. Every predecessor must be
  // the latest earlier application, not an arbitrary pending/rejected proposal.
  const verified = new Map<bigint, { actual: bigint; credit: bigint }>();
  // Generations count operations, NOT proposal revisions. Each decision is a
  // separate operation; superseded proposals have no decision. Reconciliation
  // never changes actual count. Its accepted credit can replace the predecessor
  // only when its pin is after that predecessor's acceptance.
  const before = (p: CountProposal) => line.proposals.reduce((n, item) =>
    item.revision < p.revision ? n + 1n + (item.decision ? 1n : 0n) : n, 0n);
  const reconciledBefore = (generation: bigint) => reconciliation?.proposals.filter(p =>
    p.state === 'applied' && p.count_generation <= generation).at(-1);
  const dispatchBefore = (p: CountProposal) => reconciledBefore(before(p))?.dispatch_quantity ?? line.expected_quantity;
  function baseline(p: CountProposal): { actual: bigint; credit: bigint } | null {
    const previous = applied.reduce((max, item) => item.revision < p.revision && item.revision > max ? item.revision : max, 0n);
    if (p.base_revision !== previous || p.base_revision >= p.revision) return null;
    const base = previous === 0n ? { actual: line.actual_quantity, credit: line.available_quantity }
      : proveApplied(proposals.get(previous)!);
    const reconciled = reconciledBefore(before(p));
    const previousGeneration = previous === 0n ? 0n : before(proposals.get(previous)!) + 2n;
    const effectiveBase = base && reconciled && reconciled.count_generation >= previousGeneration
      ? { actual: base.actual, credit: reconciled.dispatch_quantity } : base;
    return effectiveBase && p.base_credit === effectiveBase.credit ? effectiveBase : null;
  }
  function proveApplied(p: CountProposal): { actual: bigint; credit: bigint } | null {
    const cached = verified.get(p.revision);
    if (cached) return cached;
    const base = baseline(p);
    if (!base || p.state !== 'applied' || p.decision?.accepted !== true || !p.application
      || p.application.recorded_at !== p.decision.recorded_at
      || p.application.effective_credit !== (p.actual_quantity < dispatchBefore(p) ? p.actual_quantity : dispatchBefore(p))
      || p.application.delta !== p.application.effective_credit - base.credit) return null;
    const value = { actual: p.actual_quantity, credit: p.application.effective_credit };
    verified.set(p.revision, value);
    return value;
  }
  for (const p of line.proposals) {
    if (p.state === 'applied') { if (!proveApplied(p)) return null; }
    else if (!baseline(p) || p.application !== null
      || (p.state === 'rejected' ? p.decision?.accepted !== false
        : p.decision !== null || p.state !== (p.revision === latestRevision ? 'pending' : 'superseded'))) return null;
  }
  const current = appliedRevision === 0n ? { actual: line.actual_quantity, credit: line.available_quantity }
    : verified.get(appliedRevision);
  const latestReconciliation = reconciliation?.proposals.filter(p => p.state === 'applied').at(-1);
  const lastCountGeneration = appliedRevision === 0n ? 0n : before(proposals.get(appliedRevision)!) + 2n;
  const currentCredit = latestReconciliation && latestReconciliation.count_generation >= lastCountGeneration
    ? latestReconciliation.dispatch_quantity : current?.credit;
  if (!current || current.actual !== line.effective_actual || currentCredit !== line.effective_credit) return null;
  // Cross-ledger pins must agree with the count history at that operation
  // generation. A reconciliation between proposal and acceptance would retire
  // that count consent, so an eventual application cannot straddle it.
  for (const r of reconciliation?.proposals ?? []) {
    const earlier = applied.reduce<CountProposal | undefined>((latest, p) => before(p) + 2n <= r.count_generation
      && (!latest || p.revision > latest.revision) ? p : latest, undefined);
    const actual = earlier ? earlier.actual_quantity : line.actual_quantity;
    if (r.base_actual !== actual || applied.some(p => before(p) + 1n === r.count_generation)) return null;
  }
  const application = proposals.get(appliedRevision);
  const latest = proposals.get(latestRevision);
  return { application, rejected: latest?.state === 'rejected' ? latest : undefined,
    baseline: (p: CountProposal) => baseline(p)! };
}

function projectCountCorrectionResults(record: TransferRecord, corrections: TransferCountCorrectionsProps['corrections'], reconciliations?: DispatchReconciliations | null) {
  if (record.status !== 'received' || !corrections.snapshot || corrections.attempts.some(a => a.phase === 'inFlight' || a.phase === 'uncertain'
    || a.phase === 'conflict' || a.phase !== 'confirmed' && a.priorUncertainty)) return null;
  const location = (id: number) => id === record.origin_location_id ? record.origin_location_name : record.destination_location_name;
  const snapshot = corrections.snapshot;
  const rows = record.receipt.items.map(original => {
    const line = snapshot.lines.find(item => item.variant_id === original.variant_id)!;
    const proof = countResultProof(line, record, reconciliations?.lines.find(l => l.variant_id === line.variant_id));
    const product = record.items.find(item => item.variant_id === line.variant_id);
    const label = product ? product.polarity === 'L' ? 'Izquierda [L]' : 'Derecha [R]' : `Variante ${line.variant_id}`;
    const result = (p: CountProposal | undefined) => p && proof ? {
      proposal: p, before: proof.baseline(p).actual, proposer: location(p.initiator_location_id),
      decider: location(p.decision!.actor_location_id), delta: p.application?.delta,
    } : undefined;
    return { variant_id: line.variant_id, coherent: !!proof, product, label,
      application: result(proof?.application), rejected: result(proof?.rejected),
      shortage: line.effective_actual < line.effective_dispatch };
  });
  return { rows, corrected: rows.every(row => row.coherent) && rows.some(row => row.application) };
}

type CountResults = NonNullable<ReturnType<typeof projectCountCorrectionResults>>;
function CountCorrectionResults({ results }: { results: CountResults | null }) {
  const content = results?.rows.flatMap(row => [row.application, row.rejected].flatMap(result => {
    if (!result) return [];
    const { proposal: p, before, proposer, decider, delta } = result;
    return [<p className={`count-evidence count-evidence-${p.state}`} key={`${row.variant_id}:${p.revision}`}>
      <strong>{p.state === 'applied' ? 'Corrección aplicada vigente' : 'Propuesta de corrección rechazada'} en {row.label}: {before.toString()} → {p.actual_quantity.toString()}.</strong>
      <span>Variante {row.variant_id}{row.product && <> · {row.product.brand} {row.product.model}</>}. Propuesta de {proposer} · {p.state === 'applied' ? 'Aceptada' : 'Rechazada'} por {decider}.
        {delta !== undefined ? <> Cambio de crédito registrado en destino: {delta > 0n ? '+' : ''}{delta.toString()}.</>
          : <> Sin cambios en el conteo ni en el stock por este rechazo.{row.shortage && ' El faltante permanece.'}</>}</span>
    </p>];
  }));
  return content?.length ? <section className="received-result-provenance" aria-label="Resultados de corrección confirmados">{content}</section> : null;
}

function OriginalReceiptOverview({ record }: { record: TransferRecord }) {
  if (record.status !== 'received') return null;
  return <section className="transfer-receipt-overview" aria-label="Recepción original">
    <h2>Recepción original</h2>
    <section aria-label="Cantidades de la solicitud" className="transfer-outcome-metrics received">
      <dl><dt>Baterías enviadas</dt><dd>{transferQuantityTotal(record).toString()}</dd></dl>
      <dl><dt>Recibidas físicamente (original)</dt><dd>{record.receipt.items.reduce((total, line) => total + line.actual_quantity, 0n).toString()}</dd></dl>
      <dl><dt>Stock acreditado (recepción original)</dt><dd>{record.receipt.items.reduce((total, line) => total + line.available_quantity, 0n).toString()}</dd></dl>
    </section>
    <p>Evidencia inmutable de la recepción confirmada. Las correcciones posteriores muestran el conteo efectivo por separado; estos valores no son el stock actual.</p>
  </section>;
}

type ManagementContext = 'count' | 'restitution' | 'reconciliation';
function ManagementMenu({ count, restitution, reconciliation, onSelect }: {
  count: boolean; restitution: boolean; reconciliation: boolean; onSelect: (context: ManagementContext) => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const entries: { context: ManagementContext; label: string }[] = [
    ...(count ? [{ context: 'count' as const, label: 'Corregir conteo' }] : []),
    ...(restitution ? [{ context: 'restitution' as const, label: 'Restituciones de origen' }] : []),
    ...(reconciliation ? [{ context: 'reconciliation' as const, label: 'Regularizar despacho' }] : []),
  ];
  useEffect(() => { if (open) menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus(); }, [open]);
  return <div className="received-management" onBlur={e => {
    if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);
  }}>
    <button ref={trigger} type="button" aria-haspopup="menu" aria-expanded={open}
      onClick={() => setOpen(!open)}>Gestiones<span aria-hidden="true"> {open ? '▴' : '▾'}</span></button>
    {open && <div ref={menu} role="menu" aria-label="Gestiones" onKeyDown={e => {
      if (e.key === 'Escape') { e.preventDefault(); setOpen(false); trigger.current?.focus(); }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
        e.preventDefault();
        const visible = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
        const index = visible.indexOf(document.activeElement as HTMLButtonElement);
        const next = e.key === 'Home' ? 0 : e.key === 'End' ? visible.length - 1
          : (index + (e.key === 'ArrowDown' ? 1 : -1) + visible.length) % visible.length;
        visible[next]?.focus();
      }
    }}>
      {entries.map(entry => <button key={entry.context} type="button" role="menuitem" onClick={() => {
        setOpen(false); onSelect(entry.context);
      }}>{entry.label}</button>)}
    </div>}
  </div>;
}

export default function TransferDetail(props: TransferDetailProps) {
  const { controller, ownerTag } = props;
  const fence = detailAuthority(controller);
  const boundFence = useRef(fence);
  const permitted = !!fence && fence === boundFence.current && transferViewOwner(controller.getTransferAuthority()) === ownerTag;
  // Check minimal owner metadata before reading the record.
  const record = permitted ? props.record : null;
  const source = record?.origin_location_id;
  const id = record?.id;
  const pending = record?.status === 'pending';
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const managementScope = JSON.stringify([fence, ownerTag, id, record?.status, record?.kind,
    record?.origin_location_id, record?.destination_location_id,
    props.correctionRequestID, props.correctionsEnabled, props.restitutionRequestID, props.restitutionsEnabled,
    props.reconciliationRequestID, props.reconciliationsEnabled]);
  const [management, setManagement] = useState<{ scope: string; context: ManagementContext; token: number } | null>(null);
  const entrySerial = useRef(0);
  useEffect(() => { setManagement(null); }, [managementScope]);
  const [state, setState] = useState<{ fence: string; id: string; stock: StockAdvice } | null>(null);
  const mounted = useRef(false);
  const flight = useRef<{ abort: AbortController; dirty: boolean } | null>(null);
  const refresh = useRef<() => void>(() => {});
  const current = () => mounted.current && permitted && detailAuthority(controller) === fence;
  useEffect(() => {
    mounted.current = true;
    if (!permitted || !pending || !source || !id) return () => { mounted.current = false; };
    let active = true;
    const valid = () => active && current();
    const read = () => {
      if (!valid()) return;
      setState({ fence, id, stock: { catalog: null, busy: true, unavailable: false } });
      if (flight.current) { flight.current.dirty = true; return; }
      const job = { abort: new AbortController(), dirty: false };
      flight.current = job;
      void loadSourceInventory(source, { signal: job.abort.signal, reason: 'passive' }).then(catalog => {
        if (valid() && flight.current === job && !job.dirty) {
          setState({ fence, id, stock: { catalog, busy: false, unavailable: false } });
        }
      }).catch((error: unknown) => {
        if (!valid() || flight.current !== job || job.dirty) return;
        setState({ fence, id, stock: { catalog: null, busy: false, unavailable: true } });
        if (error instanceof SourceInventoryError && error.status === 401) void controller.settleUnauthorized(controller.getTransferAuthority().epoch);
      }).finally(() => {
        if (!valid() || flight.current !== job) return;
        flight.current = null;
        if (job.dirty) read();
      });
    };
    refresh.current = read;
    read();
    const detach = controller.subscribeSourceInventoryInvalidation?.(read);
    return () => {
      active = false;
      mounted.current = false;
      detach?.();
      flight.current?.abort.abort();
      flight.current = null;
      refresh.current = () => {};
    };
  }, [controller.getTransferAuthority, controller.subscribeSourceInventoryInvalidation, permitted, fence, source, id, pending, props.stockRefresh]);
  const stock: StockAdvice = state?.fence === fence && state.id === id && pending
    ? state.stock : { catalog: null, busy: pending, unavailable: false };
  useEffect(() => {
    if (permitted && record) props.onStock?.(stock, record.id);
  }, [props.onStock, state, permitted, id, pending]);
  if (!permitted || !record) return null;
  const terminal = record.status !== 'pending';
  const direct = record.kind === 'direct_shipment';
  const session = controller.getTransferAuthority().session;
  const warehouse = session?.authenticated && session.identity.location.id === 1;
  const pendingParticipant = pending && !direct && session?.authenticated
    && (session.identity.location.id === record.origin_location_id || session.identity.location.id === record.destination_location_id);
  const pendingApprover = pendingParticipant && session.identity.location.id === record.approver_location_id;
  const proposal = record.kind === 'send_to_warehouse';
  const pendingProducts = proposal ? 'Productos propuestos' : 'Productos solicitados';
  const approvedParticipant = record.status === 'approved' && session?.authenticated
    && (session.identity.location.id === record.origin_location_id || session.identity.location.id === record.destination_location_id);
  const closedParticipant = (record.status === 'cancelled' || record.status === 'rejected' && !direct)
    && session?.authenticated && (session.identity.location.id === record.origin_location_id || session.identity.location.id === record.destination_location_id);
  const subject = direct ? 'Envío' : proposal ? 'Propuesta' : 'Solicitud';
  const approvedProducts = direct ? closedParticipant ? 'Productos previstos' : 'Productos a despachar' : pendingProducts;
  const released = record.status === 'cancelled' && record.decision_location_id !== undefined;
  const closedImpact = released
    ? `Se liberó únicamente su reserva en ${record.origin_location_name}; las existencias físicas, otras reservas y el stock del destino no cambian.`
    : 'No reserva ni mueve stock.';
  const transitParticipant = record.status === 'in_transit' && session?.authenticated
    && (session.identity.location.id === record.origin_location_id || session.identity.location.id === record.destination_location_id);
  const transitHistoryLabel = direct ? 'Historial del envío'
    : record.kind === 'send_to_warehouse' ? 'Historial de la propuesta' : 'Historial de la solicitud';
  const historyKey = JSON.stringify([fence, record.id, ...(closedParticipant ? [record.status] : [])]);
  const historyOpen = historyFor === historyKey;
  if (pendingParticipant) return <div className="transfer-detail transfer-pending-detail">
    <header className="transfer-pending-heading">
      <div><h1>{record.reference}</h1><span className="pending-status status-pending">{transferStatusLabel(record)}</span></div>
      <button type="button" aria-expanded={historyOpen} aria-controls="pending-transfer-history"
        onClick={() => setHistoryFor(historyOpen ? null : historyKey)}><svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="12" cy="12" r="9" /><path d="M12 6v6l4 2" /></svg>Ver historial</button>
      <p>{proposal ? 'Propuesta de envío a Almacén' : 'Solicitud de stock'} · <span aria-label="Ruta física">{record.origin_location_name} → {record.destination_location_name}</span></p>
    </header>
    <section className="transfer-pending-products" aria-label={pendingProducts}>
      <header><div><h2>{pendingProducts}</h2><span> · {record.items.length} variantes · <span aria-label={proposal ? 'Baterías propuestas' : 'Baterías solicitadas'}>{transferQuantityTotal(record).toString()}</span> baterías</span></div>
        <button type="button" disabled={stock.busy} onClick={() => { if (current()) refresh.current(); }}><svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M20 5v6h-6 M20 11a8 8 0 1 0-2 7" /></svg>Actualizar stock de origen</button>
      </header>
      <TransferItems record={record} stock={stock} compact />
      <div className="transfer-pending-advice">
        <p><Icon name="info" />Disponibilidad orientativa; se valida al aprobar.</p>
        {stock.unavailable && <p role="alert">No se pudo consultar el stock de origen. La {proposal ? 'propuesta' : 'solicitud'} completa sigue disponible para revisión.</p>}
      </div>
      <footer><p>{!pendingApprover && <>Pendiente de aprobación de {record.approver_location_name}.<br /></>}
        {proposal ? 'Esta propuesta todavía no reserva ni mueve stock. ' : ''}Al aprobar se reservan las cantidades, sin mover stock.</p>{props.actions?.(stock)}</footer>
    </section>
    {historyOpen && <section id="pending-transfer-history" className="transfer-history pending" aria-label={transitHistoryLabel}>
      <h2>{transitHistoryLabel}</h2>
      <TransferActivity activity={record.activity} />
      <ol><li><h3>{proposal ? 'Propuesta creada' : 'Solicitud creada'}</h3><p>Ubicación: {record.creator_location_name}</p><TransferDate value={record.created_at} /></li></ol>
      <div aria-label={proposal ? 'Resumen de propuesta' : 'Resumen de solicitud'}>
        <dl><dt>Ubicación creadora</dt><dd>{record.creator_location_name}</dd>
          <dt>Requiere aprobación de</dt><dd>{record.approver_location_name}</dd></dl>
        <p>Al aprobar se revalida y reserva {proposal ? 'la propuesta' : 'la solicitud'} completa en {record.origin_location_name}.</p>
        <p>Aprobar no mueve existencias ni aumenta el stock del destino.</p>
      </div>
    </section>}
  </div>;
  if (approvedParticipant || closedParticipant) return <div className={`transfer-detail ${closedParticipant ? 'transfer-terminal-detail' : 'transfer-approved-detail'}`}>
    <header className="transfer-approved-heading">
      <div><h1>{record.reference}</h1><span className={`pending-status status-${record.status}`}>{transferStatusLabel(record)}</span></div>
      <button type="button" aria-expanded={historyOpen} aria-controls="approved-transfer-history"
        onClick={() => setHistoryFor(historyOpen ? null : historyKey)}><svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="12" cy="12" r="9" /><path d="M12 6v6l4 2" /></svg>Ver historial</button>
      <p>{direct ? 'Envío directo de Almacén' : proposal ? 'Propuesta de envío a Almacén' : 'Solicitud de stock'} · <span aria-label="Ruta física">{record.origin_location_name} → {record.destination_location_name}</span></p>
    </header>
    <section className="transfer-approved-products" aria-label={approvedProducts}>
      <header><h2>{approvedProducts}</h2><span> · {record.items.length} variantes · <span aria-label={direct ? closedParticipant ? 'Baterías previstas' : 'Baterías a despachar' : proposal ? 'Baterías propuestas' : 'Baterías solicitadas'}>{transferQuantityTotal(record).toString()}</span> baterías</span></header>
      <TransferItems record={record} compact approved={!closedParticipant} />
      <footer><p>{closedParticipant ? <>{direct ? 'El envío completo fue cancelado' : `La ${subject.toLowerCase()} completa fue ${transferStatusLabel(record).toLowerCase()}`}. {closedImpact}</> : <>Las {transferQuantityTotal(record).toString()} baterías están reservadas en {record.origin_location_name}. Pendiente de despacho{session.identity.location.id !== record.origin_location_id && <> desde {record.origin_location_name}</>}.</>}</p>
        {props.actions?.(stock)}</footer>
    </section>
    {historyOpen && <section id="approved-transfer-history" className={`transfer-history ${record.status}`} aria-label={transitHistoryLabel}>
      <h2>{transitHistoryLabel}</h2>
      <TransferActivity activity={record.activity} />
      <ol>
        <li><h3>{direct ? 'Envío creado, autorizado y stock reservado' : proposal ? 'Propuesta creada' : 'Solicitud creada'}</h3><p>Ubicación: {record.creator_location_name}</p><TransferDate value={record.created_at} /></li>
        {!direct && record.decision_location_id !== undefined && <li><h3>{record.status === 'rejected' ? `${subject} rechazada` : `${subject} aprobada y stock reservado`}</h3><p>Ubicación: {record.approver_location_name}</p><TransferDate value={record.decided_at} /></li>}
        {record.status === 'cancelled' && <li><h3>{subject} {direct ? 'cancelado' : 'cancelada'}</h3><p>Ubicación: {record.creator_location_name}</p><TransferDate value={record.cancelled_at} />
          {released && <p>Reserva propia liberada; existencias físicas sin cambios.</p>}</li>}
      </ol>
      {!closedParticipant && <p>{direct ? 'El envío completo fue autorizado y reservado al crear' : proposal ? 'La aprobación reserva la propuesta completa' : 'La aprobación reserva la solicitud completa'}; no mueve existencias físicas ni acredita stock al destino.</p>}
    </section>}
  </div>;
  if (transitParticipant) return <div className="transfer-detail transfer-transit-detail">
    <header className="transfer-transit-heading">
      <div><h1>{record.reference}</h1><span className="pending-status status-in_transit">En tránsito</span></div>
      <button type="button" aria-expanded={historyOpen} aria-controls="transit-transfer-history"
        onClick={() => setHistoryFor(historyOpen ? null : historyKey)}><svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="12" cy="12" r="9" /><path d="M12 6v6l4 2" /></svg>Ver historial</button>
      <p>{direct ? 'Envío directo de Almacén' : record.kind === 'send_to_warehouse' ? 'Propuesta de envío a Almacén' : 'Solicitud de stock'} · <span aria-label="Ruta física">{record.origin_location_name} → {record.destination_location_name}</span></p>
    </header>
    <section className="transfer-transit-products" aria-label="Productos enviados">
      <header><h2>Productos enviados</h2><span> · {record.items.length} variantes · <span aria-label="Baterías enviadas">{transferQuantityTotal(record).toString()}</span> baterías</span></header>
      <TransferItems record={record} compact sent />
      <footer><p>Pendiente de recepción en {record.destination_location_name}. El stock todavía no fue acreditado.</p>
        {props.actions?.(stock)}</footer>
    </section>
    {historyOpen && <section id="transit-transfer-history" className="transfer-history in_transit" aria-label={transitHistoryLabel}>
      <h2>{transitHistoryLabel}</h2>
      <TransferActivity activity={record.activity} />
      <ol>
        <li><h3>{direct ? 'Envío creado, autorizado y stock reservado' : record.kind === 'send_to_warehouse' ? 'Propuesta creada' : 'Solicitud creada'}</h3><p>Ubicación: {record.creator_location_name}</p><TransferDate value={record.created_at} /></li>
        {!direct && <li><h3>{record.kind === 'send_to_warehouse' ? 'Propuesta aprobada y stock reservado' : 'Solicitud aprobada y stock reservado'}</h3><p>Ubicación: {record.approver_location_name}</p><TransferDate value={record.decided_at} /></li>}
        <li><h3>{record.kind === 'request_stock' ? 'Solicitud despachada' : 'Envío despachado'}</h3><p>Origen: {record.origin_location_name}</p><TransferDate value={record.dispatched_at} /></li>
      </ol>
    </section>}
  </div>;
  const receivedParticipant = record.status === 'received'
    && session?.authenticated === true && (session.identity.location.id === record.origin_location_id
      || session.identity.location.id === record.destination_location_id);
  // Do not read private hook evidence until both the mount-bound authority and
  // the caller's selected-record enablement agree. The hook owns head freshness.
  const effectiveContext = receivedParticipant && props.correctionsEnabled === true
    && props.correctionRequestID === record.id;
  const countEntry = effectiveContext && !!props.corrections;
  const restitutionEntry = receivedParticipant && props.restitutionsEnabled === true
    && props.restitutionRequestID === record.id && !!controller.restitutionRecovery;
  const selected = management?.scope === managementScope ? management : null;
  const corrections = effectiveContext ? props.corrections : undefined;
  const reconciliationContext = effectiveContext && props.reconciliationsEnabled === true
    && props.reconciliationRequestID === record.id;
  const reconciliations = reconciliationContext ? props.reconciliations : undefined;
  const effective = receivedParticipant ? projectTransferReceived({ record,
    snapshot: corrections?.snapshot ?? null,
    reconciliations: props.reconciliationsEnabled === undefined ? undefined : reconciliations?.snapshot ?? null,
    busy: (corrections?.busy ?? false) || (reconciliations?.busy ?? false),
    error: corrections?.error ?? reconciliations?.error ?? null,
    masked: (corrections?.masked ?? false) || (reconciliations?.masked ?? false), contextValid: effectiveContext }) : null;
  const countResults = effective?.status === 'available' && corrections
    ? projectCountCorrectionResults(record, corrections, reconciliations?.snapshot) : null;
  const receivedHistoryLabel = receivedParticipant
    ? direct ? 'Historial del envío' : record.kind === 'send_to_warehouse' ? 'Historial de la propuesta' : 'Historial de la solicitud'
    : 'Historial de la solicitud';
  return <div className={`transfer-detail${receivedParticipant ? ' transfer-received-detail' : ''}`}>
    <header className={receivedParticipant ? 'transfer-received-heading' : 'transfer-detail-heading'}><h1>{record.reference}</h1>
      <span className={`pending-status status-${record.status}`}>{transferStatusLabel(record)}</span>
      {countResults?.corrected && <span className="received-result-badge">Conteo corregido</span>}
      {countResults && effective?.status === 'available' && (effective.totals.shortage > 0n || effective.totals.excess > 0n || effective.totals.unexpected > 0n)
        && <span className="received-result-differences"><ReceivedDifferences quantities={effective.totals} /></span>}
      {receivedParticipant && <button type="button" aria-expanded={historyOpen} aria-controls="received-transfer-history"
        onClick={() => setHistoryFor(historyOpen ? null : historyKey)}><span aria-hidden="true">◷ </span>Ver historial</button>}
      <p>{receivedParticipant ? <>{direct ? 'Envío directo de Almacén' : record.kind === 'send_to_warehouse' ? 'Propuesta de envío a Almacén' : 'Solicitud de stock'} · <span aria-label="Ruta física">{record.origin_location_name} → {record.destination_location_name}</span></> : direct ? 'Envío directo de Almacén' : record.kind === 'send_to_warehouse' ? 'Propuesta de envío a Almacén' : record.origin_location_id === 1 ? 'Solicitud a Almacén' : 'Solicitud entre sucursales'}</p>
    </header>
    {!receivedParticipant && <section className="transfer-detail-route creation-route" aria-label="Ruta física">
        <div><span>Origen</span><strong>{record.origin_location_name}</strong>
          <small>{direct ? 'Creador y origen físico' : record.kind === 'send_to_warehouse' ? 'Emisor · solicita enviar su stock' : 'Suministra el stock solicitado'}</small></div>
        <b aria-hidden="true">→</b><div><span>Destino</span><strong>{record.destination_location_name}</strong>
          <small>{direct ? 'Receptor · no requiere aprobación' : record.kind === 'send_to_warehouse' ? 'Receptor · requiere aprobación' : 'Ubicación solicitante'}</small></div>
    </section>}
    {receivedParticipant && effective && <section className="transfer-received-products" aria-busy={effective.status === 'updating'}
      aria-label={effective.status === 'available' ? 'Conteo efectivo confirmado' : 'Conteo efectivo de recepción'}>
      {effective.status === 'unavailable' ? <div className="received-unavailable" data-reason={effective.reason}>
        <h2>Conteo efectivo no disponible</h2>
        <p>No se muestran cantidades originales como conteo efectivo. Consultá el estado y los controles de recuperación en Correcciones de conteo.</p>
        {corrections && !corrections.masked && <button type="button" disabled={corrections.busy}
          onClick={() => { if (current() && effectiveContext) { void corrections.refresh(); void reconciliations?.refresh(); } }}>Reintentar conteo efectivo</button>}
      </div> : <>
        <header><h2>{effective.status === 'updating' ? 'Actualizando conteo efectivo…' : 'Conteo efectivo confirmado'}</h2>
          <span> · {effective.rows.length} variantes · {effective.totals.actual.toString()} {effective.totals.actual === 1n ? 'batería contabilizada' : 'baterías contabilizadas'}</span></header>
        {effective.status === 'updating' && <p role="status">Actualizando: evidencia retenida, pendiente de consulta; no confirma el estado más reciente.</p>}
        <div className="received-table"><table><caption className="sr-only">Conteo efectivo</caption>
          <thead><tr>{['Batería', 'Enviadas', 'Recibidas efectivas', 'Crédito efectivo', 'Diferencia'].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead>
          <tbody>{effective.rows.map(row => {
            const application = countResults?.rows.find(result => result.variant_id === row.variant_id)?.application;
            return <tr key={row.variant_id} data-variant-id={row.variant_id}
              className={`${row.shortage || row.excess || row.unexpected ? 'received-discrepant' : ''}${application ? ' received-result-applied' : ''}`}>
              <td>{row.product ? <>{row.product.brand} {row.product.model}<small>{row.product.capacity_ah} Ah · {row.product.polarity === 'L' ? 'Izquierda [L]' : 'Derecha [R]'}</small></>
                : <>Variante {row.variant_id} · identidad no disponible</>}
                {application && <small className="received-corrected">Conteo corregido: {application.before.toString()} → {application.proposal.actual_quantity.toString()}</small>}</td>
              <td data-label="Enviadas">{row.expected.toString()}</td><td data-label="Recibidas efectivas">{row.actual.toString()}</td>
              <td data-label="Crédito efectivo">{row.credit.toString()}</td><td data-label="Diferencia"><ReceivedDifferences quantities={row} /></td>
            </tr>;
          })}</tbody>
          <tfoot><tr><th scope="row">Total · {effective.rows.length} variantes</th><td data-label="Enviadas">{effective.totals.expected.toString()}</td>
            <td data-label="Recibidas efectivas">{effective.totals.actual.toString()}</td><td data-label="Crédito efectivo">{effective.totals.credit.toString()}</td>
            <td data-label="Diferencia"><ReceivedDifferences quantities={effective.totals} /></td></tr></tfoot>
        </table></div>
        <p className="received-scope"><Icon name="info" />Estas cantidades reflejan el conteo efectivo de esta recepción, no el stock actual de {record.destination_location_name}.</p>
      </>}
      <footer className="received-result-band">
        <div className="received-result-summary"><CountCorrectionResults results={countResults} />
          {effective.status !== 'unavailable' && <>
            <ReceivedDifferences quantities={effective.totals} />
            {(effective.totals.shortage > 0n || effective.totals.excess > 0n || effective.totals.unexpected > 0n)
              && <p>Las diferencias se registran por variante, sin compensarse ni resolverse automáticamente.</p>}
          </>}
        </div>
        {(countEntry || restitutionEntry || !!reconciliations) && <ManagementMenu
          key={managementScope} count={countEntry} restitution={restitutionEntry} reconciliation={!!reconciliations} onSelect={context => {
            if (current()) setManagement({ scope: managementScope, context, token: ++entrySerial.current });
          }} />}
      </footer>
      {props.actions?.(stock)}
    </section>}
    {receivedParticipant && record.status === 'received' ? <footer className="received-original-footer">
      <details className="received-original" key={historyKey}>
        <summary>Ver recepción original</summary>
        <OriginalReceiptOverview record={record} />
        <ReceiptTable receipt={record.receipt} record={record} detailPresentation />
      </details>
    </footer> : <OriginalReceiptOverview record={record} />}
    <div className="transfer-detail-grid"><div>
      {record.status === 'received' ? !receivedParticipant && <ReceiptTable receipt={record.receipt} record={record} detailPresentation />
        : <TransferItems record={record} stock={terminal ? undefined : stock} />}
      {props.corrections && <TransferCountCorrections record={record} controller={controller}
        corrections={props.corrections} requestID={props.correctionRequestID ?? null} enabled={props.correctionsEnabled ?? false}
        contextVisible={!receivedParticipant || selected?.context === 'count'}
        entryFocusKey={selected?.context === 'count' ? selected.token : undefined} />}
      <TransferRestitutions controller={controller} record={record} requestID={props.restitutionRequestID ?? null}
        enabled={props.restitutionsEnabled ?? false} contextVisible={!receivedParticipant || selected?.context === 'restitution'}
        entryFocusKey={selected?.context === 'restitution' ? selected.token : undefined} />
      {reconciliations && <TransferDispatchReconciliations
        key={`${fence}:${record.id}:${record.kind}:${record.origin_location_id}:${record.destination_location_id}`}
        record={record} actorLocation={session?.authenticated ? session.identity.location.id : null}
        reconciliations={reconciliations} contextVisible={selected?.context === 'reconciliation'}
        entryFocusKey={selected?.context === 'reconciliation' ? selected.token : undefined} />}
      {!terminal && <div className="transfer-advisory"><p>Stock de origen orientativo, no es una garantía de disponibilidad. El servidor revalida toda la solicitud al aprobar.</p>
        {stock.unavailable && <p role="alert">No se pudo consultar el stock de origen. La solicitud completa sigue disponible para revisión.</p>}
        <button type="button" disabled={stock.busy} onClick={() => { if (current()) refresh.current(); }}>Actualizar stock de origen</button>
      </div>}
      {warehouse && record.status !== 'received' && <div className="transfer-detail-cards" aria-label="Baterías solicitadas móvil">
        {record.items.map(item => <article key={item.variant_id} data-variant-id={item.variant_id}>
          <h3>{item.brand} · {item.model}</h3><p>{item.capacity_ah} Ah · {item.polarity === 'L' ? 'Izquierda [L]' : 'Derecha [R]'}</p>
          <p>{record.status === 'in_transit' ? 'Cantidad enviada' : 'Cantidad solicitada'}: <strong>{item.quantity.toString()}</strong></p>
          {!terminal && <><p>Disponible en {record.origin_location_name} (orientativo)</p><Stock stock={stock} variant={item.variant_id} /></>}
        </article>)}
      </div>}
    </div><div className="transfer-detail-outcome">{!receivedParticipant && <aside className="transfer-detail-summary" aria-label="Resumen de solicitud">
      <h2>Solicitud {terminal ? transferStatusLabel(record) : 'Pending'}</h2>
      {record.status !== 'received' && <section aria-label="Cantidades de la solicitud" className={`transfer-outcome-metrics ${record.status}`}>
        <dl><dt>Baterías solicitadas</dt>
          <dd aria-label="Baterías solicitadas">{transferQuantityTotal(record).toString()}</dd></dl>
        {terminal && record.status !== 'in_transit' && <dl><dt>Baterías reservadas en esta solicitud</dt>
          {/* Validated Approved records guarantee exact whole-request allocations, not global balances. */}
          <dd aria-label="Baterías reservadas en esta solicitud">{record.status === 'approved' ? transferQuantityTotal(record).toString() : '0'}</dd></dl>}
        {record.status === 'in_transit' && <>
          <dl><dt>Baterías enviadas</dt><dd>{transferQuantityTotal(record).toString()}</dd></dl>
          <dl><dt>Reserva propia consumida</dt><dd>{transferQuantityTotal(record).toString()}</dd></dl>
          <dl><dt>Recepción en destino</dt><dd>Pendiente de recepción</dd></dl>
        </>}
      </section>}
      <dl><dt>Ubicación creadora</dt><dd>{record.creator_location_name}</dd>
        <dt>{direct ? 'Autorizado al crear por' : 'Requiere aprobación de'}</dt><dd>{record.approver_location_name}</dd>
        <dt>Creada</dt><dd><TransferDate value={record.created_at} /></dd></dl>
      {terminal ? <>{record.decided_at && <p>{direct ? 'Autorizada y reservada al crear:' : 'Decidida:'} <TransferDate value={record.decided_at} /></p>}
        <p>{record.status === 'cancelled' ? (record.decision_location_id !== undefined ? `La solicitud completa fue cancelada. Se liberó únicamente su reserva en ${record.origin_location_name}; las existencias físicas, otras reservas y el stock del destino no cambian.` : 'La solicitud pendiente fue cancelada. No reserva ni mueve stock.') : record.status === 'received' ? `La recepción se confirmó en ${record.destination_location_name}. Solo las cantidades esperadas recibidas, hasta lo enviado, se acreditaron como stock disponible. Las discrepancias permanecen registradas, sin resolución automática.` : record.status === 'in_transit' ? `Se despachó la solicitud completa desde ${record.origin_location_name}, consumiendo su reserva y descontando existencias. ${record.destination_location_name} todavía no recibe stock; la recepción está pendiente.` : record.status === 'approved' && direct ? 'El envío completo fue autorizado y reservado al crear. Las existencias físicas no cambian ni se acredita el destino. El despacho es separado; podés cancelar antes de despachar.' : record.status === 'approved' ? `La solicitud completa está reservada en ${record.origin_location_name}. Las existencias físicas no cambian y el destino no recibe stock por la aprobación.` : 'La solicitud completa fue rechazada. No reserva ni mueve stock.'}</p></>
        : <div className="transfer-impact"><p>Esta solicitud todavía no reserva ni mueve stock.</p>
          <p>Al aprobar se revalida y reserva la solicitud completa en {record.origin_location_name}. Si falta disponibilidad en alguna variante, no se reserva ninguna.</p>
          <p>Aprobar no mueve existencias ni aumenta el stock del destino.</p></div>}
      {(record.status === 'in_transit' || record.status === 'received') && <p>Despachada desde {record.origin_location_name}: <TransferDate value={record.dispatched_at} /></p>}
      {record.status === 'received' && <p>Recibida en {record.destination_location_name}: <TransferDate value={record.received_at} /></p>}
      {record.status === 'cancelled' && <p>Cancelada en {record.creator_location_name}: <TransferDate value={record.cancelled_at} /></p>}
      {props.actions?.(stock)}
    </aside>}
      {(!receivedParticipant || historyOpen) && <section id={receivedParticipant ? 'received-transfer-history' : undefined} className={`transfer-history ${record.status}`} aria-label={receivedHistoryLabel}>
        <h2>{receivedHistoryLabel}</h2>
        {session?.authenticated && (session.identity.location.id === record.origin_location_id
          || session.identity.location.id === record.destination_location_id) && <TransferActivity activity={record.activity} />}
        <ol>
          <li><h3>{direct ? 'Envío creado, autorizado y stock reservado' : receivedParticipant && record.kind === 'send_to_warehouse' ? 'Propuesta creada' : 'Solicitud creada'}</h3>
            <p>Ubicación: {record.creator_location_name}</p>
            <TransferDate value={record.created_at} />
          </li>
          {terminal && !direct && record.decision_location_id !== undefined && <li><h3>{record.status !== 'rejected' ? receivedParticipant && record.kind === 'send_to_warehouse' ? 'Propuesta aprobada y stock reservado' : 'Solicitud aprobada y stock reservado' : 'Solicitud rechazada'}</h3>
            {/* The validated decision location is the persisted approver, never the current viewer. */}
            <p>Ubicación: {record.approver_location_name}</p>
            <TransferDate value={record.decided_at} />
          </li>}
          {(record.status === 'in_transit' || record.status === 'received') && <li><h3>{receivedParticipant && record.kind !== 'request_stock' ? 'Envío despachado' : 'Solicitud despachada'}</h3>
            <p>Origen: {record.origin_location_name}</p>
            <TransferDate value={record.dispatched_at} />
            {record.status === 'in_transit' && <p>Pendiente de recepción en {record.destination_location_name}.</p>}
          </li>}
          {record.status === 'cancelled' && <li><h3>Solicitud cancelada</h3>
            <p>Ubicación: {record.creator_location_name}</p>
            <TransferDate value={record.cancelled_at} />
            {record.decision_location_id !== undefined && <p>Reserva propia liberada; existencias físicas sin cambios.</p>}
          </li>}
          {record.status === 'received' && <li><h3>{receivedParticipant && record.kind !== 'request_stock' ? 'Envío recibido' : 'Solicitud recibida'}</h3>
            <p>Destino: {record.destination_location_name}</p>
            <TransferDate value={record.received_at} />
            <p>Recepción finalizada una sola vez. Discrepancias registradas por separado.</p>
          </li>}
        </ol>
      </section>}
    </div></div>
  </div>;
}
