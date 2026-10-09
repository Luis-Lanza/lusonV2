import { useCallback, useEffect, useRef, useState } from 'react';
import type { TransferAuthority } from './useInventory';
import { useTransfers } from './useTransfers';
import { transferQuantityTotal, type TransferRecord } from './transferModel';
import TransferDetail, { detailAuthority, type DetailController, type StockAdvice } from './TransferDetail';
import TransferDecision from './TransferDecision';

// No session or CSRF retained in routing state. Epoch changes invalidate this tag.
export function transferViewOwner(authority: TransferAuthority): string | null {
  const session = authority.session;
  return authority.ready && session?.authenticated && [1, 2, 3].includes(session.identity.location.id)
    ? `${authority.epoch}/${session.identity.account_id}/${session.identity.location.id}` : null;
}
export interface TransferPendingProps {
  controller: DetailController;
  ownerTag: string;
  initialDetail?: { ownerTag: string; id: string };
  onInventory: () => void;
  creationAvailable?: boolean;
  onCreate?: () => void;
}
function kindLabel(record: TransferRecord) {
  if (record.kind === 'send_to_warehouse') return 'Propuesta de envío a Almacén';
  return record.origin_location_id === 1 ? 'Solicitud a Almacén' : 'Solicitud entre sucursales';
}
function statusLabel(record: TransferRecord) {
  return record.status === 'pending' ? 'Pendiente de aprobación' : record.status === 'approved' ? 'Aprobada' : 'Rechazada';
}
function Status({ record }: { record: TransferRecord }) { return <span className={`pending-status status-${record.status}`}>{statusLabel(record)}</span>; }
const statusOptions = [
  { value: 'pending', label: 'Pendientes', plural: 'pendientes' },
  { value: 'approved', label: 'Aprobadas', plural: 'aprobadas' },
  { value: 'rejected', label: 'Rechazadas', plural: 'rechazadas' },
] as const;
export default function TransferPending(props: TransferPendingProps) {
  const authority = props.controller.getTransferAuthority();
  const permitted = transferViewOwner(authority) === props.ownerTag;
  const transfers = useTransfers({ controller: props.controller, listEnabled: permitted, detailEnabled: permitted, countsEnabled: permitted });
  const consumed = useRef(false);
  const [masked, setMasked] = useState<{ fence: string; id: string } | null>(null);
  const [stock, setStock] = useState<{ fence: string; id: string; advice: StockAdvice } | null>(null);
  const receiveStock = useCallback((advice: StockAdvice, id: string) => {
    if (transferViewOwner(props.controller.getTransferAuthority()) === props.ownerTag) {
      setStock({ fence: detailAuthority(props.controller), id, advice });
    }
  }, [props.controller.getTransferAuthority, props.ownerTag]);
  const [stockRefresh, setStockRefresh] = useState(0);
  const fence = detailAuthority(props.controller);
  const current = () => !!fence && detailAuthority(props.controller) === fence
    && transferViewOwner(props.controller.getTransferAuthority()) === props.ownerTag;
  useEffect(() => {
    if (consumed.current || !current()) return;
    // Inspect even the routed ID only after checking the minimal owner metadata.
    if (props.initialDetail?.ownerTag !== props.ownerTag) return;
    consumed.current = true;
    transfers.selectDetail(props.initialDetail.id);
  }, [permitted, props.ownerTag, props.initialDetail, transfers.selectDetail]);
  // Fence private DTOs, error objects, IDs and totals before their getters are read.
  if (!permitted) return <section className="transfer-pending"><p role="status">Verificando acceso a transferencias…</p></section>;
  const page = transfers.page;
  const selected = transfers.selectedID;
  const decision = transfers.decision;
  // A confirmed POST/GET is immediately truthful even while the passive detail refresh is pending.
  const privateUnavailable = masked?.fence === fence && masked.id === selected;
  const record = privateUnavailable ? null : decision?.result?.id === selected ? decision.result : transfers.detail;
  const unavailable = transfers.detailError;
  const listError = transfers.listError;
  const counts = transfers.counts;
  const countsBusy = transfers.countsBusy;
  const countsError = transfers.countsError;
  const warehouse = authority.session?.authenticated && authority.session.identity.location.id === 1;
  const queryPage = transfers.query.page ?? 1;
  const size = transfers.query.page_size ?? 25;
  const status = transfers.query.status ?? 'pending';
  const plural = statusOptions.find(option => option.value === status)!.plural;
  const approverLabel = (row: TransferRecord) => row.status === 'pending' ? 'Requiere aprobación de' : 'Ubicación aprobadora';
  const open = (row: TransferRecord) => { if (current()) transfers.selectDetail(row.id); };
  const back = () => { if (current()) transfers.selectDetail(null); };
  const inventory = () => { if (current()) props.onInventory(); };
  // This is the selected-status participant total, not the independent Pending/action counters.
  const pageCount = <p className="pending-count" aria-live="polite">{page ? `${page.total_count.toString()} solicitudes ${plural}` : `Consultando solicitudes ${plural}…`}</p>;
  return <section className={'transfer-pending' + (warehouse ? ' pending-warehouse' : '')} aria-labelledby="pending-title">
    <button type="button" className="creation-back" onClick={inventory}>Volver al inventario</button>
    <header className="pending-heading"><div><h1 id="pending-title">{selected ? 'Detalle de solicitud' : `Transferencias ${plural}`}</h1>
      <p>{selected ? 'El detalle muestra el estado actual de la solicitud.' : `Solicitudes ${plural} de tu ubicación asignada.`} La consulta de inventario no cambia los participantes.</p></div>
      {!selected && !warehouse ? <div className="pending-heading-actions">
        <button type="button" className="primary transfer-cta" disabled={!props.creationAvailable || !props.onCreate} onClick={() => {
          const latest = props.controller.getTransferAuthority();
          if (current() && latest.session?.authenticated && [2, 3].includes(latest.session.identity.location.id)
            && props.creationAvailable) props.onCreate?.();
        }}>Nueva transferencia</button>
        {pageCount}
      </div> : pageCount}
    </header>
    <section className="transfer-request-counters" aria-label="Contadores de solicitudes" aria-live="polite" aria-busy={countsBusy}>
      {counts && !countsBusy && !countsError ? <dl>
        <div><dt>Pendientes de tu ubicación</dt><dd>{counts.pending_total.toString()}</dd></div>
        <div><dt>Requieren tu aprobación</dt><dd>{counts.action_count.toString()}</dd></div>
      </dl> : <p>{countsError ? 'Contadores no disponibles.' : 'Consultando contadores…'}</p>}
      <small>Solicitudes pendientes participantes y asignadas a tu aprobación. Consulta independiente del listado.</small>
    </section>
    {selected ? <>
      <button type="button" className="creation-back" onClick={back}>Volver a {plural}</button>
      {transfers.detailBusy && <p role="status">Consultando solicitud…</p>}
      {(unavailable || privateUnavailable) && <div role="alert" className="message"><p>{privateUnavailable || unavailable?.code === 'not_found' || unavailable?.status === 403 ? 'La solicitud no está disponible.' : 'No se pudo consultar la solicitud.'}</p>
        <button type="button" onClick={() => { if (current()) { setMasked(null); transfers.retryDetail(); } }}>Reintentar detalle</button></div>}
      <TransferDecision controller={props.controller} ownerTag={props.ownerTag} transfers={transfers} record={record}
        stock={stock?.fence === fence && stock.id === record?.id ? stock.advice : { catalog: null, busy: false, unavailable: true }}
        onPrivateUnavailable={() => { if (current() && selected) setMasked({ fence, id: selected }); }}
        onStockRefresh={() => { if (current()) setStockRefresh(value => value + 1); }}
        renderDetail={actions => record && <TransferDetail controller={props.controller} ownerTag={props.ownerTag} record={record}
          onStock={receiveStock} stockRefresh={stockRefresh} actions={() => actions} />} />
    </> : <>
      <div className="transfer-status-toolbar">
        <label htmlFor="transfer-status">Estado de transferencia</label>
        <select id="transfer-status" value={status} onChange={event => {
          const next = event.target.value;
          if (current() && (next === 'pending' || next === 'approved' || next === 'rejected')) transfers.changeQuery({ status: next });
        }}>{statusOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
      </div>
      <TransferDecision controller={props.controller} ownerTag={props.ownerTag} transfers={transfers} />
      {transfers.listBusy && <p role="status">Actualizando solicitudes {plural}…</p>}
      {listError && <div role="alert" className="message"><p>{status === 'pending' ? 'No se pudieron consultar las solicitudes.' : `No se pudieron consultar las solicitudes ${plural}.`}</p>
        <button type="button" onClick={() => { if (current()) transfers.retryList(); }}>Reintentar {plural}</button></div>}
      {page?.total_count === 0n && <p role="status">No hay solicitudes {plural} para tu ubicación.</p>}
      {page && page.records.length > 0 && <>
        <div className="table-scroll pending-table"><table><caption className="sr-only">Solicitudes {plural} participantes</caption>
          <thead><tr>{['Transferencia', 'Origen', 'Destino', 'Estado', 'Unidades', status === 'pending' ? 'Requiere aprobación de' : 'Ubicación aprobadora', 'Detalle'].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead>
          <tbody>{page.records.map(row => <tr key={row.id}><td><strong>{row.reference}</strong><small>{kindLabel(row)}</small></td>
            <td>{row.origin_location_name}</td><td>{row.destination_location_name}</td><td><Status record={row} /></td>
            <td>{transferQuantityTotal(row).toString()}</td><td>{row.approver_location_name}</td>
            <td><button type="button" onClick={() => open(row)} aria-label={`Ver detalle ${row.reference}`}>Ver detalle</button></td></tr>)}</tbody>
        </table></div>
        {warehouse && <div className="pending-cards">{page.records.map(row => <article key={row.id}>
          <header><h2>{row.reference}</h2><span>{transferQuantityTotal(row).toString()} unidades</span></header><p>{kindLabel(row)}</p><Status record={row} />
          <p>{row.origin_location_name} → {row.destination_location_name}</p>
          <p>Ubicación creadora: {row.creator_location_name}</p><p>{approverLabel(row)}: {row.approver_location_name}</p>
          <ul>{row.items.map(item => <li key={item.variant_id}>{item.brand} · {item.model} · {item.capacity_ah} Ah · {item.polarity} · {item.quantity.toString()} unidades</li>)}</ul>
          <button type="button" onClick={() => open(row)} aria-label={`Ver detalle móvil ${row.reference}`}>Ver detalle</button>
        </article>)}</div>}
      </>}
      <footer className="pager"><form className="page-controls" onSubmit={event => {
        event.preventDefault();
        if (!current()) return;
        const value = new FormData(event.currentTarget).get('pending-page');
        if (typeof value === 'string' && /^[1-9][0-9]{0,6}$/.test(value)) {
          const next = Number(value);
          if (next <= 1000000) transfers.changeQuery({ page: next });
        }
      }}><label htmlFor="pending-page">Ir a página</label><input key={queryPage} id="pending-page" name="pending-page" inputMode="numeric" defaultValue={queryPage} />
        <button type="submit">Consultar página</button></form><div className="page-controls">
        <label htmlFor="pending-size">Solicitudes por página</label><select id="pending-size" value={size} onChange={event => {
          const next = Number(event.target.value);
          if (current() && (next === 10 || next === 25 || next === 50)) transfers.changeQuery({ page_size: next });
        }}>{[10, 25, 50].map(value => <option key={value}>{value}</option>)}</select>
        <button type="button" disabled={!page || queryPage <= 1} onClick={() => { if (current() && queryPage > 1) transfers.changeQuery({ page: queryPage - 1 }); }}>Anterior {plural}</button>
        <span aria-current="page">Página {queryPage}</span>
        <button type="button" disabled={!page || queryPage >= 1000000 || BigInt(queryPage) * BigInt(size) >= page.total_count}
          onClick={() => { if (current() && page && queryPage < 1000000 && BigInt(queryPage) * BigInt(size) < page.total_count) transfers.changeQuery({ page: queryPage + 1 }); }}>Siguiente {plural}</button>
      </div></footer>
    </>}
  </section>;
}
