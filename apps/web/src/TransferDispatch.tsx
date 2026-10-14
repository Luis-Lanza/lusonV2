import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { TransferController } from './useInventory';
import type { useTransfers } from './useTransfers';
import type { TransferRecord } from './transferModel';
import { captureDecisionRecord } from './transferDecisionRecovery';
import { detailAuthority, TransferItems } from './TransferDetail';
import { transferViewOwner } from './TransferPending';
import { TransferAPIError } from './transferAPI';
import TransferDate from './TransferDate';

export interface TransferDispatchProps {
  controller: TransferController; ownerTag: string; transfers: ReturnType<typeof useTransfers>;
  record?: TransferRecord | null; onPrivateUnavailable?: () => void;
  renderDetail?: (actions: ReactNode) => ReactNode;
}
export default function TransferDispatch(props: TransferDispatchProps) {
  const { controller, ownerTag, transfers } = props;
  const latest = useRef(props); latest.current = props;
  const fence = detailAuthority(controller);
  const boundFence = useRef(fence);
  const permitted = !!fence && fence === boundFence.current && transferViewOwner(controller.getTransferAuthority()) === ownerTag;
  const [review, setReview] = useState<{ fence: string; record: TransferRecord; trigger: HTMLElement } | null>(null);
  const dialog = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const mounted = useRef(false);
  const pendingCall = useRef(false);
  const current = () => mounted.current && permitted && detailAuthority(controller) === fence;
  const attempt = permitted ? transfers.dispatchAttempt : null;
  const busy = attempt?.phase === 'inFlight';
  const visibleReview = permitted && review?.fence === fence ? review : null;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!visibleReview) return;
    if (busy) dialog.current?.focus();
    else close.current?.focus();
  }, [visibleReview, busy]);
  useEffect(() => {
    if (!visibleReview) return;
    const trigger = visibleReview.trigger;
    return () => { if (detailAuthority(controller) === visibleReview.fence) trigger.focus(); };
  }, [visibleReview, controller]);
  if (!permitted) return null;
  const record = props.record;
  const authority = controller.getTransferAuthority();
  const assigned = authority.session?.authenticated ? authority.session.identity.location.id : null;
  const canDispatch = record?.status === 'approved' && record.origin_location_id === assigned;
  const unresolved = attempt?.phase === 'uncertain' || busy;
  const result = attempt?.result;
  const failure = transfers.dispatchError;
  const error = failure?.status === 401 ? 'No se pudo verificar la sesión.'
    : failure?.code === 'decision_conflict' ? 'El estado de la solicitud cambió. Consultá el resultado original.'
      : failure ? 'No se pudo confirmar el despacho con el servidor.' : '';
  const dismiss = () => {
    if (!current() || transfers.dispatchAttempt?.phase === 'inFlight' || pendingCall.current) return;
    setReview(null);
  };
  const run = async (operation: () => Promise<TransferRecord>) => {
    if (!current() || pendingCall.current || transfers.dispatchAttempt?.phase === 'inFlight') return;
    pendingCall.current = true;
    try { await operation(); } catch (error: unknown) {
      if (current() && error instanceof TransferAPIError && (error.status === 403 || error.status === 404)) {
        setReview(null); latest.current.onPrivateUnavailable?.();
      }
    } finally { pendingCall.current = false; }
  };
  const open = (trigger: HTMLElement) => {
    if (!current() || !canDispatch || !record || unresolved || pendingCall.current
      || latest.current.record?.id !== record.id || latest.current.record.status !== 'approved') return;
    const now = controller.getTransferAuthority();
    if (!now.session?.authenticated || now.session.identity.location.id !== record.origin_location_id) return;
    setReview({ fence, record: captureDecisionRecord(record), trigger });
  };
  const actions = canDispatch && !(result && result.id === record.id) ? <div className="transfer-decision-actions">
    <button type="button" className="primary" disabled={!!unresolved} onClick={event => open(event.currentTarget)}>Despachar solicitud</button>
    <p>El despacho completo requiere confirmación desde el origen físico.</p>
  </div> : null;
  return <div className="transfer-dispatch">
    {attempt && <section className="transfer-decision-recovery" aria-label="Recuperación de despacho">
      <h3>{unresolved ? 'Despacho pendiente de confirmación' : attempt.phase === 'conflict' ? 'Resultado confirmado' : 'Despacho confirmado'}</h3>
      <p>{attempt.original.reference} · Despacho de la solicitud completa</p>
      {busy ? <p role="status">Consultando o enviando el despacho…</p> : unresolved ? <>
        <p role="status">El resultado sigue sin confirmar. La solicitud puede haberse despachado, aunque una consulta muestre Aprobada. No envíes otra solicitud.</p>
        <button type="button" onClick={() => void run(transfers.recoverDispatch)}>Consultar resultado original del despacho</button>
        <button type="button" onClick={() => void run(transfers.retryDispatch)}>Reintentar mismo despacho</button>
      </> : (result?.status === 'in_transit' || result?.status === 'received') && <>
        <p role="status">Estado confirmado: {result.status === 'received' ? 'Recibida' : 'En tránsito'}.</p>
        <p>Despachada desde {result.origin_location_name}: <TransferDate value={result.dispatched_at} /></p>
        {result.status === 'in_transit' ? <p>Pendiente de recepción en {result.destination_location_name}; todavía no recibe stock.</p>
          : <p>Recepción finalizada en {result.destination_location_name}: <TransferDate value={result.received_at} /></p>}
      </>}
      {result?.status === 'cancelled' && <p role="status">Estado confirmado: Cancelada: <TransferDate value={result.cancelled_at} />. No se confirmó un despacho.</p>}
      {error && <p role="alert">{error}</p>}
      <p>Volver o cerrar la confirmación no cancela un despacho enviado. La recuperación permanece en esta App; recargar o cerrar la pestaña pierde esta memoria.</p>
    </section>}
    {props.renderDetail ? props.renderDetail(actions) : actions}
    {visibleReview && <div className="transfer-decision-backdrop"><section ref={dialog} tabIndex={-1}
      className="transfer-decision-modal" role="dialog" aria-modal="true" aria-labelledby="dispatch-title" aria-busy={busy}
      onKeyDown={event => {
        if (!current()) return;
        if (event.key === 'Escape') { event.preventDefault(); dismiss(); }
        if (event.key === 'Tab') {
          const buttons = dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
          if (!buttons?.length) { event.preventDefault(); return; }
          const first = buttons[0]; const last = buttons[buttons.length - 1];
          if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first.focus(); }
        }
      }}>
      <header><div><h2 id="dispatch-title">{result?.id === visibleReview.record.id ? result.status === 'cancelled' ? 'Solicitud Cancelada' : 'Despacho confirmado' : 'Confirmar despacho'}</h2>
        <p>{visibleReview.record.reference} · {visibleReview.record.origin_location_name} → {visibleReview.record.destination_location_name}</p></div>
        <button ref={close} type="button" aria-label="Cerrar confirmación de despacho" disabled={busy} onClick={dismiss}>×</button>
      </header>
      <div className="transfer-decision-body">
        <TransferItems record={visibleReview.record} dispatch />
        <div className="transfer-impact"><h3>Impacto del despacho</h3>
          <p>Se despacharán todas las baterías, sin selección parcial, desde {visibleReview.record.origin_location_name}.</p>
          <p>Se descontarán existencias y se consumirá la reserva propia de esta solicitud por las mismas cantidades. La disponibilidad sin reservar no cambia; otras reservas se conservan.</p>
          <p>El destino no recibe stock con el despacho. La solicitud quedará En tránsito, pendiente de recepción.</p>
        </div>
        {busy && <p role="status">Confirmando despacho…</p>}
        {error && <p role="alert">{error}</p>}
        {unresolved && !busy && <p role="status">Resultado sin confirmar. Usá la recuperación del despacho original.</p>}
        {result?.id === visibleReview.record.id && <p role="status">Estado confirmado: {result.status === 'cancelled' ? 'Cancelada' : result.status === 'received' ? 'Recibida' : 'En tránsito'}.</p>}
      </div>
      <footer><button type="button" disabled={busy} onClick={dismiss}>Volver al detalle</button>
        {!unresolved && canDispatch && record.id === visibleReview.record.id && !(result && result.id === visibleReview.record.id) &&
          <button type="button" className="primary" onClick={() => {
            if (current() && latest.current.record?.status === 'approved' && latest.current.record.id === visibleReview.record.id) {
              void run(() => transfers.dispatch(visibleReview.record));
            }
          }}>Confirmar despacho</button>}
      </footer>
    </section></div>}
  </div>;
}
