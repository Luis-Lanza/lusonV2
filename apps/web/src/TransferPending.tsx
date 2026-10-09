import { useEffect, useRef } from 'react';
import type { TransferAuthority, TransferController } from './useInventory';
import { useTransfers } from './useTransfers';
import { transferQuantityTotal, type TransferRecord } from './transferModel';

// No session or CSRF retained in routing state. Epoch changes invalidate this tag.
export function transferViewOwner(authority: TransferAuthority): string | null {
  const session = authority.session;
  return authority.ready && session?.authenticated && [1, 2, 3].includes(session.identity.location.id)
    ? `${authority.epoch}/${session.identity.account_id}/${session.identity.location.id}` : null;
}
export interface TransferPendingProps {
  controller: TransferController;
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
function Status({ record }: { record: TransferRecord }) { return <span className="pending-status">{statusLabel(record)}</span>; }
function Items({ record }: { record: TransferRecord }) {
  return <table><caption className="sr-only">Baterías solicitadas</caption><thead><tr>
    <th scope="col">Batería</th><th scope="col">Capacidad (Ah)</th><th scope="col">Polaridad</th><th scope="col">Cantidad solicitada</th>
  </tr></thead><tbody>{record.items.map(item => <tr key={item.variant_id}>
    <td>{item.brand} · {item.model}</td><td>{item.capacity_ah} Ah</td>
    <td>{item.polarity === 'L' ? 'Izquierda [L]' : 'Derecha [R]'}</td><td>{item.quantity.toString()}</td>
  </tr>)}</tbody></table>;
}
export default function TransferPending(props: TransferPendingProps) {
  const authority = props.controller.getTransferAuthority();
  const permitted = transferViewOwner(authority) === props.ownerTag;
  const transfers = useTransfers({ controller: props.controller, listEnabled: permitted, detailEnabled: permitted });
  const consumed = useRef(false);
  const current = () => transferViewOwner(props.controller.getTransferAuthority()) === props.ownerTag;
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
  const record = transfers.detail;
  const unavailable = transfers.detailError;
  const listError = transfers.listError;
  const warehouse = authority.session?.authenticated && authority.session.identity.location.id === 1;
  const queryPage = transfers.query.page ?? 1;
  const size = transfers.query.page_size ?? 25;
  const open = (row: TransferRecord) => { if (current()) transfers.selectDetail(row.id); };
  const back = () => { if (current()) transfers.selectDetail(null); };
  const inventory = () => { if (current()) props.onInventory(); };
  const pendingCount = <p className="pending-count" aria-live="polite">{page ? `${page.total_count.toString()} solicitudes pendientes` : 'Consultando solicitudes pendientes…'}</p>;
  return <section className={'transfer-pending' + (warehouse ? ' pending-warehouse' : '')} aria-labelledby="pending-title">
    <button type="button" className="creation-back" onClick={inventory}>Volver al inventario</button>
    <header className="pending-heading"><div><h1 id="pending-title">{selected ? 'Detalle de solicitud' : 'Transferencias pendientes'}</h1>
      <p>Solicitudes Pending de tu ubicación asignada. La consulta de inventario no cambia los participantes.{selected && ' El detalle muestra el estado actual de la solicitud.'}</p></div>
      {!selected && !warehouse ? <div className="pending-heading-actions">
        <button type="button" className="primary transfer-cta" disabled={!props.creationAvailable || !props.onCreate} onClick={() => {
          const latest = props.controller.getTransferAuthority();
          if (current() && latest.session?.authenticated && [2, 3].includes(latest.session.identity.location.id)
            && props.creationAvailable) props.onCreate?.();
        }}>Nueva transferencia</button>
        {pendingCount}
      </div> : pendingCount}
    </header>
    {selected ? <>
      <button type="button" className="creation-back" onClick={back}>Volver a pendientes</button>
      {transfers.detailBusy && <p role="status">Consultando solicitud…</p>}
      {unavailable && <div role="alert" className="message"><p>{unavailable.code === 'not_found' ? 'La solicitud no está disponible.' : 'No se pudo consultar la solicitud.'}</p>
        <button type="button" onClick={() => { if (current()) transfers.retryDetail(); }}>Reintentar detalle</button></div>}
      {record && <>
        <header className="pending-record-heading"><div><h2>{record.reference}</h2><p>{kindLabel(record)}</p></div><Status record={record} /></header>
        <section className="creation-route" aria-label="Ruta física"><div><span>Origen</span><strong>{record.origin_location_name}</strong></div><b aria-hidden="true">→</b>
          <div><span>Destino</span><strong>{record.destination_location_name}</strong></div></section>
        <div className="pending-detail-grid"><div className="table-scroll pending-items"><Items record={record} /></div>
          <aside className="pending-summary" aria-label="Resumen de solicitud"><h2>Solicitud {record.status === 'pending' ? 'Pending' : statusLabel(record)}</h2>
            <p>{transferQuantityTotal(record).toString()} baterías solicitadas</p>
            <dl><dt>Ubicación creadora</dt><dd>{record.creator_location_name}</dd>
              <dt>Requiere aprobación de</dt><dd>{record.approver_location_name}</dd>
              <dt>Creada (UTC)</dt><dd><time>{record.created_at}</time></dd></dl>
            {record.status === 'pending' ? <><p>Esta solicitud todavía no reserva ni mueve stock.</p><p>La aprobación deberá revalidar y reservar la solicitud completa. La aprobación no está disponible en esta etapa.</p></>
              : <p>Decidida (UTC): <time>{record.decided_at}</time></p>}
          </aside></div>
      </>}
    </> : <>
      {transfers.listBusy && <p role="status">Actualizando solicitudes pendientes…</p>}
      {listError && <div role="alert" className="message"><p>No se pudieron consultar las solicitudes.</p>
        <button type="button" onClick={() => { if (current()) transfers.retryList(); }}>Reintentar pendientes</button></div>}
      {page?.total_count === 0n && <p role="status">No hay solicitudes pendientes para tu ubicación.</p>}
      {page && page.records.length > 0 && <>
        <div className="table-scroll pending-table"><table><caption className="sr-only">Solicitudes pendientes participantes</caption>
          <thead><tr>{['Transferencia', 'Origen', 'Destino', 'Estado', 'Unidades', 'Requiere aprobación de', 'Detalle'].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead>
          <tbody>{page.records.map(row => <tr key={row.id}><td><strong>{row.reference}</strong><small>{kindLabel(row)}</small></td>
            <td>{row.origin_location_name}</td><td>{row.destination_location_name}</td><td><Status record={row} /></td>
            <td>{transferQuantityTotal(row).toString()}</td><td>{row.approver_location_name}</td>
            <td><button type="button" onClick={() => open(row)} aria-label={`Ver detalle ${row.reference}`}>Ver detalle</button></td></tr>)}</tbody>
        </table></div>
        {warehouse && <div className="pending-cards">{page.records.map(row => <article key={row.id}>
          <header><h2>{row.reference}</h2><span>{transferQuantityTotal(row).toString()} unidades</span></header><p>{kindLabel(row)}</p><Status record={row} />
          <p>{row.origin_location_name} → {row.destination_location_name}</p>
          <p>Ubicación creadora: {row.creator_location_name}</p><p>Requiere aprobación de: {row.approver_location_name}</p>
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
        <button type="button" disabled={!page || queryPage <= 1} onClick={() => { if (current() && queryPage > 1) transfers.changeQuery({ page: queryPage - 1 }); }}>Anterior pendientes</button>
        <span aria-current="page">Página {queryPage}</span>
        <button type="button" disabled={!page || queryPage >= 1000000 || BigInt(queryPage) * BigInt(size) >= page.total_count}
          onClick={() => { if (current() && page && queryPage < 1000000 && BigInt(queryPage) * BigInt(size) < page.total_count) transfers.changeQuery({ page: queryPage + 1 }); }}>Siguiente pendientes</button>
      </div></footer>
    </>}
  </section>;
}
