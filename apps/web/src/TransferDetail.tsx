import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { TransferController, SourceInventoryController } from './useInventory';
import { loadSourceInventory, SourceInventoryError, type SourceCatalog } from './sourceInventory';
import { transferQuantityTotal, type TransferRecord } from './transferModel';
import { transferViewOwner } from './TransferPending';
import { ReceiptTable } from './TransferReceipt';
import TransferCountCorrections, { type TransferCountCorrectionsProps } from './TransferCountCorrections';
import TransferRestitutions from './TransferRestitutions';
import TransferDate from './TransferDate';
import { Icon } from './icons';
import './transfer-detail.css';

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
export function TransferItems({ record, stock, confirmation = false, reject = false, dispatch = false, compact = false }: {
  record: TransferRecord; stock?: StockAdvice; confirmation?: boolean; reject?: boolean; dispatch?: boolean; compact?: boolean;
}) {
  const advice = stock && !reject;
  const pendingDetail = compact && !confirmation;
  return <div className="table-scroll transfer-detail-items"><table>
    <caption className="sr-only">{confirmation ? 'Solicitud completa a confirmar' : 'Baterías solicitadas'}</caption>
    <thead><tr><th scope="col">{compact && confirmation ? 'Producto' : 'Batería'}</th><th scope="col">Polaridad</th>
      <th scope="col">{compact ? 'Solicitadas' : dispatch ? 'Cantidad a despachar' : (record.status === 'in_transit' || record.status === 'received') ? 'Cantidad enviada' : confirmation && !reject ? 'Cantidad a reservar' : 'Cantidad solicitada'}</th>
      {advice && <th scope="col">{compact ? 'Disponibles en origen' : `Disponible en ${record.origin_location_name} (orientativo)`}</th>}</tr></thead>
    <tbody>{record.items.map(item => <tr key={item.variant_id} data-variant-id={item.variant_id}>
      <td>{compact && confirmation ? <>{item.brand} {item.model} · <span>{item.capacity_ah} Ah</span></>
        : <><strong>{item.brand} · {item.model}</strong><small>{item.capacity_ah} Ah</small></>}</td>
      <td data-label={pendingDetail ? 'Polaridad' : undefined}>{item.polarity === 'L' ? 'Izquierda [L]' : 'Derecha [R]'}</td>
      <td data-label={pendingDetail ? 'Solicitadas' : undefined}>{item.quantity.toString()}</td>
      {advice && <td data-label={pendingDetail ? 'Disponibles en origen' : undefined}><Stock stock={stock} variant={item.variant_id} compact={compact} /></td>}
    </tr>)}</tbody>
    {(!compact || confirmation) && <tfoot><tr><td colSpan={advice ? 4 : 3}>{compact && confirmation ? 'Total: ' : ''}{record.items.length} variantes · {transferQuantityTotal(record).toString()} baterías</td></tr></tfoot>}
  </table></div>;
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
  const pendingApprover = pending && record.kind === 'request_stock'
    && session?.authenticated && session.identity.location.id === record.approver_location_id;
  const historyKey = JSON.stringify([fence, record.id]);
  const historyOpen = historyFor === historyKey;
  if (pendingApprover) return <div className="transfer-detail transfer-pending-detail">
    <header className="transfer-pending-heading">
      <div><h1>{record.reference}</h1><span className="pending-status status-pending">{transferStatusLabel(record)}</span></div>
      <button type="button" aria-expanded={historyOpen} aria-controls="pending-transfer-history"
        onClick={() => setHistoryFor(historyOpen ? null : historyKey)}><svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="12" cy="12" r="9" /><path d="M12 6v6l4 2" /></svg>Ver historial</button>
      <p>Solicitud de stock · <span aria-label="Ruta física">{record.origin_location_name} → {record.destination_location_name}</span></p>
    </header>
    <section className="transfer-pending-products" aria-label="Productos solicitados">
      <header><div><h2>Productos solicitados</h2><span> · {record.items.length} variantes · <span aria-label="Baterías solicitadas">{transferQuantityTotal(record).toString()}</span> baterías</span></div>
        <button type="button" disabled={stock.busy} onClick={() => { if (current()) refresh.current(); }}><svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M20 5v6h-6 M20 11a8 8 0 1 0-2 7" /></svg>Actualizar stock de origen</button>
      </header>
      <TransferItems record={record} stock={stock} compact />
      <div className="transfer-pending-advice">
        <p><Icon name="info" />Disponibilidad orientativa; se valida al aprobar.</p>
        {stock.unavailable && <p role="alert">No se pudo consultar el stock de origen. La solicitud completa sigue disponible para revisión.</p>}
      </div>
      <footer><p>Al aprobar se reservan las cantidades, sin mover stock.</p>{props.actions?.(stock)}</footer>
    </section>
    {historyOpen && <section id="pending-transfer-history" className="transfer-history pending" aria-label="Historial de la solicitud">
      <h2>Historial de la solicitud</h2>
      <ol><li><h3>Solicitud creada</h3><p>Ubicación: {record.creator_location_name}</p><TransferDate value={record.created_at} /></li></ol>
      <div aria-label="Resumen de solicitud">
        <dl><dt>Ubicación creadora</dt><dd>{record.creator_location_name}</dd>
          <dt>Requiere aprobación de</dt><dd>{record.approver_location_name}</dd></dl>
        <p>Al aprobar se revalida y reserva la solicitud completa en {record.origin_location_name}.</p>
        <p>Aprobar no mueve existencias ni aumenta el stock del destino.</p>
      </div>
    </section>}
  </div>;
  return <div className="transfer-detail">
    <header className="transfer-detail-heading"><h1>{record.reference}</h1>
      <span className={`pending-status status-${record.status}`}>{transferStatusLabel(record)}</span>
      <p>{direct ? 'Envío directo de Almacén' : record.kind === 'send_to_warehouse' ? 'Propuesta de envío a Almacén' : record.origin_location_id === 1 ? 'Solicitud a Almacén' : 'Solicitud entre sucursales'}</p>
    </header>
    <section className="transfer-detail-route creation-route" aria-label="Ruta física">
        <div><span>Origen</span><strong>{record.origin_location_name}</strong>
          <small>{direct ? 'Creador y origen físico' : record.kind === 'send_to_warehouse' ? 'Emisor · solicita enviar su stock' : 'Suministra el stock solicitado'}</small></div>
        <b aria-hidden="true">→</b><div><span>Destino</span><strong>{record.destination_location_name}</strong>
          <small>{direct ? 'Receptor · no requiere aprobación' : record.kind === 'send_to_warehouse' ? 'Receptor · requiere aprobación' : 'Ubicación solicitante'}</small></div>
    </section>
    {record.status === 'received' && <section className="transfer-receipt-overview" aria-label="Recepción original">
      <h2>Recepción original</h2>
      <section aria-label="Cantidades de la solicitud" className="transfer-outcome-metrics received">
        <dl><dt>Baterías enviadas</dt><dd>{transferQuantityTotal(record).toString()}</dd></dl>
        <dl><dt>Recibidas físicamente (original)</dt><dd>{record.receipt.items.reduce((total, line) => total + line.actual_quantity, 0n).toString()}</dd></dl>
        <dl><dt>Stock acreditado (recepción original)</dt><dd>{record.receipt.items.reduce((total, line) => total + line.available_quantity, 0n).toString()}</dd></dl>
      </section>
      <p>Evidencia inmutable de la recepción confirmada. Las correcciones posteriores muestran el conteo efectivo por separado; estos valores no son el stock actual.</p>
    </section>}
    <div className="transfer-detail-grid"><div>
      {record.status === 'received' ? <ReceiptTable receipt={record.receipt} record={record} detailPresentation />
        : <TransferItems record={record} stock={terminal ? undefined : stock} />}
      {props.corrections && <TransferCountCorrections record={record} controller={controller}
        corrections={props.corrections} requestID={props.correctionRequestID ?? null} enabled={props.correctionsEnabled ?? false} />}
      <TransferRestitutions controller={controller} record={record} requestID={props.restitutionRequestID ?? null}
        enabled={props.restitutionsEnabled ?? false} />
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
    </div><div className="transfer-detail-outcome"><aside className="transfer-detail-summary" aria-label="Resumen de solicitud">
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
    </aside>
      <section className={`transfer-history ${record.status}`} aria-label="Historial de la solicitud">
        <h2>Historial de la solicitud</h2>
        <ol>
          <li><h3>{direct ? 'Envío creado, autorizado y stock reservado' : 'Solicitud creada'}</h3>
            <p>Ubicación: {record.creator_location_name}</p>
            <TransferDate value={record.created_at} />
          </li>
          {terminal && !direct && record.decision_location_id !== undefined && <li><h3>{record.status !== 'rejected' ? 'Solicitud aprobada y stock reservado' : 'Solicitud rechazada'}</h3>
            {/* The validated decision location is the persisted approver, never the current viewer. */}
            <p>Ubicación: {record.approver_location_name}</p>
            <TransferDate value={record.decided_at} />
          </li>}
          {(record.status === 'in_transit' || record.status === 'received') && <li><h3>Solicitud despachada</h3>
            <p>Origen: {record.origin_location_name}</p>
            <TransferDate value={record.dispatched_at} />
            {record.status === 'in_transit' && <p>Pendiente de recepción en {record.destination_location_name}.</p>}
          </li>}
          {record.status === 'cancelled' && <li><h3>Solicitud cancelada</h3>
            <p>Ubicación: {record.creator_location_name}</p>
            <TransferDate value={record.cancelled_at} />
            {record.decision_location_id !== undefined && <p>Reserva propia liberada; existencias físicas sin cambios.</p>}
          </li>}
          {record.status === 'received' && <li><h3>Solicitud recibida</h3>
            <p>Destino: {record.destination_location_name}</p>
            <TransferDate value={record.received_at} />
            <p>Recepción finalizada una sola vez. Discrepancias registradas por separado.</p>
          </li>}
        </ol>
      </section>
    </div></div>
  </div>;
}
