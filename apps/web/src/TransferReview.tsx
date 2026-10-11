import { useEffect, useRef } from 'react';
import type { Metadata } from './model';
import type { RecoverySnapshot } from './transferRecovery';
import type { TransferCreateInput } from './transferModel';
import type { TransferCreateResult } from './transferAPI';
import type { TransferController } from './useInventory';
import { useTransfers } from './useTransfers';

export interface TransferReviewProps {
  controller: TransferController;
  metadata: Metadata;
  ownerTag: string;
  snapshot: RecoverySnapshot;
  busy: boolean;
  error: string;
  result: TransferCreateResult | null;
  returnFocus: HTMLElement | null;
  onClose: () => void;
  onEdit: () => void;
  onBack: () => void;
  onDetail?: (id: string) => void;
  onSend: (submit: (attempt: TransferCreateInput) => Promise<TransferCreateResult>) => void;
}

// This hook exists only during explicit review. Its participant reads remain disabled.
export default function TransferReview(props: TransferReviewProps) {
  const transfers = useTransfers({ controller: props.controller, listEnabled: false, detailEnabled: false });
  const dialog = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const authority = props.controller.getTransferAuthority();
  const session = authority.session;
  const permitted = authority.ready && session?.authenticated && [2, 3].includes(session.identity.location.id)
    && props.ownerTag === `${authority.epoch}/${session.identity.account_id}/${session.identity.location.id}`;
  const blocked = props.busy || (permitted && props.snapshot.epoch === authority.epoch && props.snapshot.phase === 'inFlight');
  useEffect(() => {
    if (permitted && blocked) dialog.current?.focus();
    else if (permitted) close.current?.focus();
  }, [permitted, blocked]);
  useEffect(() => {
    if (!permitted) return;
    const trigger = props.returnFocus;
    return () => {
      const now = props.controller.getTransferAuthority(); const s = now.session;
      if (now.ready && s?.authenticated && props.ownerTag === `${now.epoch}/${s.identity.account_id}/${s.identity.location.id}`) trigger?.focus();
    };
  }, [permitted, props.ownerTag, props.controller, props.returnFocus]);
  // Check owner metadata before snapshot or result getters, not just before effects.
  if (!permitted || props.snapshot.epoch !== authority.epoch) return null;
  const { snapshot, result } = props;
  const outcomeLabel = result?.record.status === 'approved' ? 'Aprobada' : result?.record.status === 'rejected' ? 'Rechazada' : result?.record.status === 'in_transit' ? 'En tránsito' : result?.record.status === 'received' ? 'Recibida' : 'Pending';
  const location = (id: number) => props.metadata.locations.find(l => l.id === id)?.name ?? 'Ubicación no disponible';
  const total = snapshot.items.reduce((sum, line) => sum + BigInt(line.quantity), 0n);
  return <div className="review-backdrop"><section ref={dialog} tabIndex={-1} className="transfer-review" role="dialog" aria-modal="true" aria-labelledby="review-title" aria-busy={blocked} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); if (!blocked) props.onClose(); }
    if (event.key === 'Tab') {
      const buttons = dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
      if (!buttons?.length) { event.preventDefault(); return; }
      const first = buttons[0]; const last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  }}>
    <header><div><h2 id="review-title">{result ? `Solicitud ${outcomeLabel} confirmada` : 'Revisar solicitud'}</h2>
      <p>{result ? (result.replayed ? 'El servidor devolvió la solicitud original.' : 'El servidor creó la solicitud.') : 'Comprobá las cantidades y la ruta antes del envío manual.'}</p></div>
      <button ref={close} type="button" aria-label="Cerrar revisión" disabled={blocked} onClick={props.onClose}>×</button></header>
    <div className="review-body">
      <div className="review-route"><div><span>Origen</span><strong>{location(snapshot.direction.origin_location_id)}</strong></div><b aria-hidden="true">→</b>
        <div><span>Destino</span><strong>{location(snapshot.direction.destination_location_id)}</strong></div></div>
      {result && <section className="review-result" aria-label="Resultado confirmado">
        <h3>{result.record.reference}</h3><p>ID: {result.record.id}</p><p>Creada (UTC): <time>{result.record.created_at}</time></p><p>Estado: {result.record.status === 'pending' ? 'Pending · Pendiente de aprobación' : outcomeLabel}</p>
        {result.record.status !== 'pending' && <p>Decidida (UTC): <time>{result.record.decided_at}</time></p>}
        {(result.record.status === 'in_transit' || result.record.status === 'received') && <p>Despachada desde {result.record.origin_location_name} (UTC): <time>{result.record.dispatched_at}</time></p>}
        {result.record.status === 'in_transit' && <p>Reserva propia consumida; baterías enviadas. Pendiente de recepción en {result.record.destination_location_name}, sin crédito de stock en destino.</p>}
        {result.record.status === 'received' && <><p>Recibida en {result.record.destination_location_name} (UTC): <time>{result.record.received_at}</time></p>
          <p>La recepción ya está finalizada. Solo se acreditaron unidades esperadas recibidas hasta lo enviado; las discrepancias permanecen registradas por separado.</p></>}
      </section>}
      <div className="review-table"><table><caption className="sr-only">Selección inmutable</caption><thead><tr><th scope="col">Batería</th><th scope="col">Polaridad</th><th scope="col">Cantidad solicitada</th></tr></thead>
        <tbody>{snapshot.items.map(line => <tr key={line.variant_id}><td><strong>{line.brand} · {line.model}</strong><small>{line.capacity_ah} Ah</small></td>
          <td><span className="polarity">{line.polarity}</span></td><td>{line.quantity}</td></tr>)}</tbody>
        <tfoot><tr><td colSpan={3}>{snapshot.items.length} variantes · {total.toString()} baterías</td></tr></tfoot></table></div>
      {(!result || result.record.status === 'pending') && <div className="review-notice"><p>La solicitud quedará Pending, pendiente de aprobación de {location(snapshot.direction.approver_location_id)}.</p>
        <p>Enviar la solicitud no reserva ni mueve stock. La aprobación deberá revalidar y reservar la solicitud completa.</p>
        <p>El servidor comprobará la disponibilidad al crear. Un reintento con la misma solicitud puede devolver el registro original.</p></div>}
      {!result && snapshot.phase === 'ready' && <p>Revisión preparada, todavía no enviada.</p>}
      {!result && snapshot.phase === 'unknown' && <p role="status">No pudimos confirmar el resultado. La solicitud puede haberse creado. Reintentá esta misma solicitud para comprobarlo.</p>}
      {props.error && <p role="alert" className="message">{props.error}</p>}
      {blocked && <p role="status">Enviando solicitud… No cambies la selección mientras se resuelve.</p>}
      <p className="review-memory">La recuperación se conserva solamente mientras esta App está abierta. Recargar o cerrar la pestaña pierde esta memoria.</p>
    </div>
    <footer>{result ? <><button type="button" disabled={!props.onDetail || blocked} onClick={() => {
        const now = props.controller.getTransferAuthority(); const s = now.session;
        if (!props.busy && now.ready && s?.authenticated && props.ownerTag === `${now.epoch}/${s.identity.account_id}/${s.identity.location.id}`
          && props.snapshot.epoch === now.epoch && props.result) props.onDetail?.(props.result.record.id);
      }}>{props.onDetail ? 'Ver detalle' : 'Ver detalle (próxima etapa)'}</button><button type="button" className="primary" disabled={blocked} onClick={() => {
        const now = props.controller.getTransferAuthority(); const s = now.session;
        if (!props.busy && now.ready && s?.authenticated && props.ownerTag === `${now.epoch}/${s.identity.account_id}/${s.identity.location.id}`
          && props.snapshot.epoch === now.epoch && props.result) props.onBack();
      }}>Volver a transferencias</button></>
      : <><button type="button" disabled={blocked} onClick={props.onEdit}>Volver a editar</button>
        <button type="button" className="primary" disabled={blocked} onClick={() => props.onSend(transfers.submit)}>{snapshot.phase === 'unknown' ? 'Reintentar misma solicitud' : 'Enviar solicitud'}</button></>}</footer>
  </section></div>;
}
