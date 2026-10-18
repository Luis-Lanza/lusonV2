import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { TransferAuthority } from './useInventory';
import { useTransfers } from './useTransfers';
import { transferQuantityTotal, type TransferRecord } from './transferModel';
import TransferDetail, { detailAuthority, type DetailController, type StockAdvice } from './TransferDetail';
import TransferDecision from './TransferDecision';
import { Icon } from './icons';
import TransferDispatch from './TransferDispatch';
import TransferReceipt from './TransferReceipt';
import TransferCancellation from './TransferCancellation';
import { useTransferCountCorrections } from './useTransferCountCorrections';
import { isTransferFocusTarget, type TransferModalFocusBinding } from './transferModalFocus';

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
  if (record.kind === 'direct_shipment') return 'Envío directo de Almacén';
  if (record.kind === 'send_to_warehouse') return 'Propuesta de envío a Almacén';
  return record.origin_location_id === 1 ? 'Solicitud a Almacén' : 'Solicitud entre sucursales';
}
function unitsLabel(quantity: bigint) { return `${quantity.toString()} ${quantity === 1n ? 'unidad' : 'unidades'}`; }
function statusLabel(record: TransferRecord) {
  return record.status === 'pending' ? 'Pendiente de aprobación' : record.status === 'approved' ? record.kind === 'direct_shipment' ? 'Pendiente de despacho' : 'Aprobada' : record.status === 'in_transit' ? 'En tránsito' : record.status === 'received' ? 'Recibida' : record.status === 'cancelled' ? 'Cancelada' : 'Rechazada';
}
function Status({ record }: { record: TransferRecord }) { return <span className={`pending-status status-${record.status}`}>{statusLabel(record)}</span>; }
const statusOptions = [
  { value: 'pending', label: 'Pendientes', plural: 'pendientes', singular: 'pendiente' },
  { value: 'approved', label: 'Aprobadas', plural: 'aprobadas', singular: 'aprobada' },
  { value: 'rejected', label: 'Rechazadas', plural: 'rechazadas', singular: 'rechazada' },
  { value: 'in_transit', label: 'En tránsito', plural: 'en tránsito', singular: 'en tránsito' },
  { value: 'received', label: 'Recibidas', plural: 'recibidas', singular: 'recibida' },
  { value: 'cancelled', label: 'Canceladas', plural: 'canceladas', singular: 'cancelada' },
] as const;
export default function TransferPending(props: TransferPendingProps) {
  const authority = props.controller.getTransferAuthority();
  const permitted = transferViewOwner(authority) === props.ownerTag;
  const transfers = useTransfers({ controller: props.controller, listEnabled: permitted, detailEnabled: permitted, countsEnabled: permitted });
  const consumed = useRef(false);
  const detailPane = useRef<HTMLElement>(null);
  const detailBack = useRef<HTMLButtonElement>(null);
  const focusMounted = useRef(false);
  const focusScope = useRef({ id: null as string | null, fence: '', blocked: false, token: {} });
  const focusLatest = useRef({ props, selected: null as string | null, fence: '', available: false });
  useLayoutEffect(() => { focusMounted.current = true; return () => { focusMounted.current = false; }; }, []);
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
  // Fence private DTOs and IDs before reading getters, while keeping hooks unconditional.
  const selected = permitted ? transfers.selectedID : null;
  const decision = permitted ? transfers.decision : null;
  // A confirmed POST/GET is immediately truthful even while the passive detail refresh is pending.
  const privateUnavailable = masked?.fence === fence && masked.id === selected;
  const dispatchResult = permitted ? transfers.dispatchAttempt?.result : null;
  const detail = permitted ? transfers.detail : null;
  const receiptResult = permitted ? transfers.receiptAttempt?.result : null;
  const cancellation = permitted ? transfers.cancellationAttempt : null;
  const cancellationResult = cancellation?.result;
  const record = privateUnavailable ? null : detail?.status === 'cancelled' ? detail
    : cancellationResult?.id === selected ? cancellationResult
      : detail?.status === 'pending' && cancellation?.current.id === selected && cancellation.current.status === 'approved' ? cancellation.current
        : detail?.status === 'received' ? detail
    : receiptResult?.id === selected ? receiptResult : dispatchResult?.id === selected ? dispatchResult
      : detail?.status === 'in_transit' ? detail : decision?.result?.id === selected ? decision.result : detail;
  if (focusScope.current.id !== selected || focusScope.current.fence !== fence) focusScope.current = { id: selected, fence, blocked: false, token: {} };
  focusLatest.current = { props, selected, fence, available: !!record && record.id === selected && !privateUnavailable && !transfers.detailError };
  // Use the very same authoritative record as the detail, including a just-confirmed receipt.
  const actor = authority.session?.authenticated ? authority.session.identity.location.id : null;
  // Match TransferDetail's mount-bound fence: a retired private pane must not read history.
  const correctionAuthority = useRef(fence);
  const correctionsEnabled = permitted && !!fence && fence === correctionAuthority.current && !privateUnavailable && record?.status === 'received'
    && record.id === selected && (actor === record.origin_location_id || actor === record.destination_location_id);
  const correctionRequestID = correctionsEnabled ? record.id : null;
  const corrections = useTransferCountCorrections({ controller: props.controller,
    requestID: correctionRequestID, enabled: correctionsEnabled });
  const modalFocus: TransferModalFocusBinding = {
    scope: focusScope.current.token,
    restore: request => {
      const now = focusLatest.current;
      const scope = focusScope.current;
      if (!focusMounted.current || scope.blocked || scope.token !== request.scope
        || !now.available || now.selected !== request.id || now.fence !== request.fence) return;
      if (detailAuthority(now.props.controller) !== request.fence || transferViewOwner(now.props.controller.getTransferAuthority()) !== now.props.ownerTag) return;
      const target = isTransferFocusTarget(request.trigger) && detailPane.current?.contains(request.trigger)
        ? request.trigger : detailBack.current;
      if (isTransferFocusTarget(target) && detailPane.current?.contains(target)) target.focus();
    },
  };
  if (!permitted) return <section className="transfer-pending"><p role="status">Verificando acceso a transferencias…</p></section>;
  const page = transfers.page;
  const unavailable = transfers.detailError;
  const listError = transfers.listError;
  const counts = transfers.counts;
  const countsBusy = transfers.countsBusy;
  const countsError = transfers.countsError;
  const warehouse = authority.session?.authenticated && authority.session.identity.location.id === 1;
  const pendingParticipant = record?.status === 'pending' && record.kind !== 'direct_shipment'
    && (actor === record.origin_location_id || actor === record.destination_location_id);
  const approvedParticipant = record?.status === 'approved'
    && (actor === record.origin_location_id || actor === record.destination_location_id);
  const transitParticipant = record?.status === 'in_transit'
    && (actor === record.origin_location_id || actor === record.destination_location_id);
  const receivedParticipant = record?.status === 'received'
    && (actor === record.origin_location_id || actor === record.destination_location_id);
  const compactDetail = pendingParticipant || approvedParticipant || transitParticipant || receivedParticipant;
  const queryPage = transfers.query.page ?? 1;
  const size = transfers.query.page_size ?? 25;
  const status = transfers.query.status ?? 'pending';
  const { plural, singular } = statusOptions.find(option => option.value === status)!;
  const approverLabel = (row: TransferRecord) => row.status === 'pending' ? 'Requiere aprobación de' : 'Ubicación aprobadora';
  const open = (row: TransferRecord) => { if (current()) { focusScope.current.blocked = true; transfers.selectDetail(row.id); } };
  const back = () => { if (current()) { focusScope.current.blocked = true; transfers.selectDetail(null); } };
  const inventory = () => { if (current()) { focusScope.current.blocked = true; props.onInventory(); } };
  // This is the selected-status participant total, not the independent Pending/action counters.
  const pageCount = <p className="pending-count" aria-live="polite">{page ? `${page.total_count.toString()} ${page.total_count === 1n ? `solicitud ${singular}` : `solicitudes ${plural}`}` : `Consultando solicitudes ${plural}…`}</p>;
  const counters = <section className="transfer-request-counters" aria-label="Contadores de solicitudes" aria-live="polite" aria-busy={countsBusy}>
    {counts && !countsBusy && !countsError ? <dl>
      <div><dt>Pendientes de tu ubicación</dt><dd>{counts.pending_total.toString()}</dd></div>
      <div><dt>Acciones requeridas</dt><dd>{counts.action_count.toString()}</dd></div>
    </dl> : <p>{countsError ? 'Contadores no disponibles.' : 'Consultando contadores…'}</p>}
    <details className="pending-counter-help"><summary>Sobre los totales</summary>
      <small>Totales independientes del filtro: pendientes de tu ubicación y acciones asignadas (aprobar, despachar o recibir).</small>
    </details>
  </section>;
  return <section ref={detailPane} className={'transfer-pending' + (warehouse ? ' pending-warehouse' : '') + (selected ? ' pending-selected' : ' pending-list')}
    aria-labelledby={selected ? undefined : 'pending-title'} aria-label={selected ? 'Detalle de transferencia' : undefined}>
    {selected ? <nav className={`pending-detail-navigation${pendingParticipant ? ' pending-approver-navigation' : approvedParticipant ? ' approved-origin-navigation' : transitParticipant ? ' transit-destination-navigation' : receivedParticipant ? ' received-participant-navigation' : ''}`} aria-label="Navegación de transferencia">
      <button ref={detailBack} type="button" className="creation-back" onClick={back}>{compactDetail && <Icon name="arrow" />}Volver a {plural}</button>
      {compactDetail && <span aria-hidden="true">·</span>}
      <button type="button" className="creation-back" onClick={inventory}>Volver al inventario</button>
    </nav> : <>
    <button type="button" className="creation-back" onClick={inventory}>Volver al inventario</button>
    <header className="pending-heading"><div><h1 id="pending-title" aria-label={`Transferencias ${plural}`}>Transferencias<span className="sr-only"> {plural}</span></h1>
      <p>Consultá las transferencias de tu ubicación asignada.</p></div>
      <div className="pending-heading-actions">
        <button type="button" className="primary transfer-cta" disabled={!props.creationAvailable || !props.onCreate} onClick={() => {
          const latest = props.controller.getTransferAuthority();
          if (current() && latest.session?.authenticated && [1, 2, 3].includes(latest.session.identity.location.id)
            && props.creationAvailable) props.onCreate?.();
        }}>{warehouse ? 'Crear envío' : 'Nueva transferencia'}</button>
        {pageCount}
      </div>
    </header>
    {counters}
    </>}
    {selected ? <>
      {transfers.detailBusy && <p role="status">Consultando solicitud…</p>}
      {(unavailable || privateUnavailable) && <div role="alert" className="message"><p>{privateUnavailable || unavailable?.code === 'not_found' || unavailable?.status === 403 ? 'La solicitud no está disponible.' : 'No se pudo consultar la solicitud.'}</p>
        <button type="button" onClick={() => { if (current()) { setMasked(null); transfers.retryDetail(); } }}>Reintentar detalle</button></div>}
      <TransferDecision controller={props.controller} ownerTag={props.ownerTag} transfers={transfers} record={record} modalFocus={modalFocus}
        stock={stock?.fence === fence && stock.id === record?.id ? stock.advice : { catalog: null, busy: false, unavailable: true }}
        onPrivateUnavailable={() => { if (current() && selected) setMasked({ fence, id: selected }); }}
        onStockRefresh={() => { if (current()) setStockRefresh(value => value + 1); }}
        renderDetail={actions => <TransferDispatch controller={props.controller} ownerTag={props.ownerTag} transfers={transfers} record={record} modalFocus={modalFocus}
          onPrivateUnavailable={() => { if (current() && selected) setMasked({ fence, id: selected }); }}
          renderDetail={dispatchActions => <TransferReceipt controller={props.controller} ownerTag={props.ownerTag} transfers={transfers} record={record} modalFocus={modalFocus}
            onPrivateUnavailable={() => { if (current() && selected) setMasked({ fence, id: selected }); }}
            renderDetail={receiptActions => <TransferCancellation controller={props.controller} ownerTag={props.ownerTag} transfers={transfers} record={record}
              onPrivateUnavailable={() => { if (current() && selected) setMasked({ fence, id: selected }); }}
              renderDetail={cancellationActions => record && <TransferDetail controller={props.controller} ownerTag={props.ownerTag} record={record}
                corrections={corrections} correctionRequestID={correctionRequestID} correctionsEnabled={correctionsEnabled}
                restitutionRequestID={correctionRequestID} restitutionsEnabled={correctionsEnabled}
                onStock={receiveStock} stockRefresh={stockRefresh} actions={() => <>{actions}{dispatchActions}{receiptActions}{cancellationActions}</>} />} />} />} />} />
      {!compactDetail && counters}
    </> : <>
      <div className="transfer-status-toolbar">
        <label htmlFor="transfer-status">Estado de transferencia</label>
        <select id="transfer-status" value={status} onChange={event => {
          const next = event.target.value;
          if (current() && (next === 'pending' || next === 'approved' || next === 'rejected' || next === 'in_transit' || next === 'received' || next === 'cancelled')) transfers.changeQuery({ status: next });
        }}>{statusOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
      </div>
      <TransferDecision controller={props.controller} ownerTag={props.ownerTag} transfers={transfers} />
      <TransferDispatch controller={props.controller} ownerTag={props.ownerTag} transfers={transfers} />
      <TransferReceipt controller={props.controller} ownerTag={props.ownerTag} transfers={transfers} />
      <TransferCancellation controller={props.controller} ownerTag={props.ownerTag} transfers={transfers} />
      <section className="pending-results" aria-label="Listado de transferencias">
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
          <header><div className="pending-card-identity"><h2>{row.reference}</h2>
            <span className="pending-flow" title={kindLabel(row)}>{row.kind === 'direct_shipment' ? 'Envío directo' : row.kind === 'send_to_warehouse' ? 'Envío a Almacén' : kindLabel(row)}</span></div>
            <span className="pending-unit-total">{unitsLabel(transferQuantityTotal(row))}</span></header>
          <Status record={row} />
          <div className="pending-card-route"><p><span>Ruta:</span> {row.origin_location_name} → {row.destination_location_name}</p>
            <div className="pending-card-participants"><p>Ubicación creadora: <strong>{row.creator_location_name}</strong></p>
              <p>{approverLabel(row)}: <strong>{row.approver_location_name}</strong></p></div>
          </div>
          <section className="pending-card-variants"><h3>Detalle del envío ({row.items.length} {row.items.length === 1 ? 'variante' : 'variantes'})</h3>
            <ul>{row.items.map(item => <li key={item.variant_id}>
              <span>{item.brand} · {item.model} · {item.capacity_ah} Ah · <span className="polarity">{item.polarity}</span></span>
              <strong className="pending-variant-quantity">{unitsLabel(item.quantity)}</strong>
            </li>)}</ul>
          </section>
          <button type="button" onClick={() => open(row)} aria-label={`Ver detalle móvil ${row.reference}`}>Ver detalle</button>
        </article>)}</div>}
      </>}
      <footer className="pager" aria-label="Paginación de transferencias"><form className="page-controls" onSubmit={event => {
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
      </section>
    </>}
  </section>;
}
