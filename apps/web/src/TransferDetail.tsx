import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { TransferController, SourceInventoryController } from './useInventory';
import { loadSourceInventory, SourceInventoryError, type SourceCatalog } from './sourceInventory';
import { transferQuantityTotal, type TransferRecord } from './transferModel';
import { transferViewOwner } from './TransferPending';

export type DetailController = TransferController & Partial<SourceInventoryController>;
export interface StockAdvice { catalog: SourceCatalog | null; busy: boolean; unavailable: boolean }
export interface TransferDetailProps {
  controller: DetailController;
  ownerTag: string;
  record: TransferRecord;
  actions?: (stock: StockAdvice) => ReactNode;
  onStock?: (stock: StockAdvice, recordID: string) => void;
  stockRefresh?: number;
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
  return record.status === 'pending' ? 'Pendiente de aprobación' : record.status === 'approved' ? 'Aprobada' : 'Rechazada';
}
function Stock({ stock, variant }: { stock: StockAdvice; variant: number }) {
  const row = stock.catalog?.rows.find(item => item.variant_id === variant);
  if (stock.busy) return <span>Consultando stock…</span>;
  if (!row) return <span>Disponibilidad no disponible</span>;
  return <span className="transfer-stock"><strong>{row.available.toString()} disponibles</strong>
    <small>Existencias: {row.existing.toString()} · Reservadas: {row.reserved.toString()}</small></span>;
}
export function TransferItems({ record, stock, confirmation = false, reject = false }: {
  record: TransferRecord; stock?: StockAdvice; confirmation?: boolean; reject?: boolean;
}) {
  const advice = stock && !reject;
  return <div className="table-scroll transfer-detail-items"><table>
    <caption className="sr-only">{confirmation ? 'Solicitud completa a confirmar' : 'Baterías solicitadas'}</caption>
    <thead><tr><th scope="col">Batería</th><th scope="col">Polaridad</th>
      <th scope="col">{confirmation && !reject ? 'Cantidad a reservar' : 'Cantidad solicitada'}</th>
      {advice && <th scope="col">Disponible en {record.origin_location_name} (orientativo)</th>}</tr></thead>
    <tbody>{record.items.map(item => <tr key={item.variant_id} data-variant-id={item.variant_id}>
      <td><strong>{item.brand} · {item.model}</strong><small>{item.capacity_ah} Ah</small></td>
      <td>{item.polarity === 'L' ? 'Izquierda [L]' : 'Derecha [R]'}</td><td>{item.quantity.toString()}</td>
      {advice && <td><Stock stock={stock} variant={item.variant_id} /></td>}
    </tr>)}</tbody>
    <tfoot><tr><td colSpan={advice ? 4 : 3}>{record.items.length} variantes · {transferQuantityTotal(record).toString()} baterías</td></tr></tfoot>
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
  const session = controller.getTransferAuthority().session;
  const warehouse = session?.authenticated && session.identity.location.id === 1;
  return <div className="transfer-detail">
    <header className="transfer-detail-heading"><h2>{record.reference}</h2>
      <span className="pending-status">{transferStatusLabel(record)}</span>
      <p>{record.kind === 'send_to_warehouse' ? 'Propuesta de envío a Almacén' : record.origin_location_id === 1 ? 'Solicitud a Almacén' : 'Solicitud entre sucursales'}</p>
    </header>
    <div className="transfer-detail-grid"><div>
      <section className="transfer-detail-route creation-route" aria-label="Ruta física">
        <div><span>Origen</span><strong>{record.origin_location_name}</strong>
          <small>{record.kind === 'send_to_warehouse' ? 'Emisor · solicita enviar su stock' : 'Suministra el stock solicitado'}</small></div>
        <b aria-hidden="true">→</b><div><span>Destino</span><strong>{record.destination_location_name}</strong>
          <small>{record.kind === 'send_to_warehouse' ? 'Receptor · requiere aprobación' : 'Ubicación solicitante'}</small></div>
      </section>
      <TransferItems record={record} stock={terminal ? undefined : stock} />
      {!terminal && <div className="transfer-advisory"><p>Stock de origen orientativo, no es una garantía de disponibilidad. El servidor revalida toda la solicitud al aprobar.</p>
        {stock.unavailable && <p role="alert">No se pudo consultar el stock de origen. La solicitud completa sigue disponible para revisión.</p>}
        <button type="button" disabled={stock.busy} onClick={() => { if (current()) refresh.current(); }}>Actualizar stock de origen</button>
      </div>}
      {warehouse && <div className="transfer-detail-cards" aria-label="Baterías solicitadas móvil">
        {record.items.map(item => <article key={item.variant_id} data-variant-id={item.variant_id}>
          <h3>{item.brand} · {item.model}</h3><p>{item.capacity_ah} Ah · {item.polarity === 'L' ? 'Izquierda [L]' : 'Derecha [R]'}</p>
          <p>Cantidad solicitada: <strong>{item.quantity.toString()}</strong></p>
          {!terminal && <><p>Disponible en {record.origin_location_name} (orientativo)</p><Stock stock={stock} variant={item.variant_id} /></>}
        </article>)}
      </div>}
    </div><aside className="transfer-detail-summary" aria-label="Resumen de solicitud">
      <h2>Solicitud {terminal ? transferStatusLabel(record) : 'Pending'}</h2>
      <p>{transferQuantityTotal(record).toString()} baterías solicitadas</p>
      <dl><dt>Ubicación creadora</dt><dd>{record.creator_location_name}</dd>
        <dt>Requiere aprobación de</dt><dd>{record.approver_location_name}</dd>
        <dt>Creada (UTC)</dt><dd><time>{record.created_at}</time></dd></dl>
      {terminal ? <><p>Decidida (UTC): <time>{record.decided_at}</time></p>
        <p>{record.status === 'approved' ? `La solicitud completa está reservada en ${record.origin_location_name}. Las existencias físicas no cambian y el destino no recibe stock por la aprobación.` : 'La solicitud completa fue rechazada. No reserva ni mueve stock.'}</p></>
        : <div className="transfer-impact"><p>Esta solicitud todavía no reserva ni mueve stock.</p>
          <p>Al aprobar se revalida y reserva la solicitud completa en {record.origin_location_name}. Si falta disponibilidad en alguna variante, no se reserva ninguna.</p>
          <p>Aprobar no mueve existencias ni aumenta el stock del destino.</p></div>}
      {props.actions?.(stock)}
    </aside></div>
  </div>;
}
