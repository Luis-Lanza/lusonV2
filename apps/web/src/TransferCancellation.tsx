import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { TransferController } from './useInventory';
import type { useTransfers } from './useTransfers';
import type { TransferRecord } from './transferModel';
import { captureDecisionRecord } from './transferDecisionRecovery';
import { detailAuthority, TransferItems, transferStatusLabel } from './TransferDetail';
import { transferViewOwner } from './TransferPending';
import { TransferAPIError } from './transferAPI';
import TransferDate from './TransferDate';

export interface TransferCancellationProps {
  controller: TransferController; ownerTag: string; transfers: ReturnType<typeof useTransfers>;
  record?: TransferRecord | null; onPrivateUnavailable?: () => void;
  renderDetail?: (actions: ReactNode) => ReactNode;
}
export default function TransferCancellation(props: TransferCancellationProps) {
  const { controller, ownerTag, transfers } = props;
  const latest = useRef(props); latest.current = props;
  const fence = detailAuthority(controller); const boundFence = useRef(fence);
  const permitted = !!fence && fence === boundFence.current && transferViewOwner(controller.getTransferAuthority()) === ownerTag;
  const [review, setReview] = useState<{ fence: string; record: TransferRecord; trigger: HTMLElement } | null>(null);
  const dialog = useRef<HTMLElement>(null); const close = useRef<HTMLButtonElement>(null);
  const mounted = useRef(false); const pendingCall = useRef(false);
  const current = () => mounted.current && permitted && detailAuthority(controller) === fence;
  const attempt = permitted ? transfers.cancellationAttempt : null;
  const busy = attempt?.phase === 'inFlight';
  const unresolved = busy || attempt?.phase === 'uncertain';
  const visibleReview = permitted && review?.fence === fence ? review : null;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (visibleReview) { if (busy) dialog.current?.focus(); else close.current?.focus(); }
  }, [visibleReview, busy]);
  useEffect(() => {
    if (!visibleReview) return;
    const trigger = visibleReview.trigger;
    return () => { if (detailAuthority(controller) === visibleReview.fence) trigger.focus(); };
  }, [visibleReview, controller]);
  if (!permitted) return null;
  const record = props.record;
  const session = controller.getTransferAuthority().session;
  const assigned = session?.authenticated ? session.identity.location.id : null;
  const cancellable = (value: TransferRecord | null | undefined) => !!value && (value.status === 'pending' || value.status === 'approved')
    && value.creator_location_id === assigned;
  const result = attempt?.result;
  const canCancel = cancellable(record) && !(result && result.id === record?.id);
  const error = transfers.cancellationError;
  const errorText = error?.status === 401 ? 'No se pudo verificar la sesión.'
    : error?.code === 'decision_conflict' ? 'El estado cambió. Consultá el resultado original.'
      : error ? 'No se pudo confirmar la cancelación con el servidor.' : '';
  const dismiss = () => {
    if (current() && !pendingCall.current && transfers.cancellationAttempt?.phase !== 'inFlight') setReview(null);
  };
  const run = async (operation: () => Promise<TransferRecord>) => {
    if (!current() || pendingCall.current || transfers.cancellationAttempt?.phase === 'inFlight') return;
    pendingCall.current = true;
    try {
      const outcome = await operation();
      if (current() && outcome.status !== 'pending' && outcome.status !== 'approved') setReview(null);
    } catch (error) {
      if (current() && error instanceof TransferAPIError && (error.status === 403 || error.status === 404)) {
        setReview(null); latest.current.onPrivateUnavailable?.();
      }
    } finally { pendingCall.current = false; }
  };
  const open = (trigger: HTMLElement) => {
    if (!current() || !canCancel || !record || unresolved || pendingCall.current
      || latest.current.record?.id !== record.id || !cancellable(latest.current.record)) return;
    setReview({ fence, record: captureDecisionRecord(record), trigger });
  };
  const actions = canCancel ? <div className="transfer-decision-actions">
    <button type="button" disabled={!!unresolved} onClick={event => open(event.currentTarget)}>Cancelar solicitud</button>
    <p>Solo la ubicación creadora puede cancelar antes del despacho.</p>
  </div> : null;
  return <div className="transfer-cancellation">
    {attempt && <section className="transfer-decision-recovery" aria-label="Recuperación de cancelación">
      <h3>{unresolved ? 'Cancelación pendiente de confirmación' : 'Resultado confirmado'}</h3>
      <p>{attempt.original.reference} · Cancelación de la solicitud completa</p>
      {busy ? <p role="status">Consultando o enviando la cancelación…</p> : unresolved ? <>
        <p role="status">El resultado sigue sin confirmar. Una consulta Pendiente o Aprobada no prueba que la cancelación falló.</p>
        <button type="button" onClick={() => void run(transfers.recoverCancellation)}>Consultar resultado original</button>
        <button type="button" onClick={() => void run(transfers.retryCancellation)}>Reintentar misma cancelación</button>
      </> : result && <>
        <p role="status">Estado confirmado: {transferStatusLabel(result)}.</p>
        {attempt.phase === 'conflict' && <p>La solicitud ya no puede cancelarse. Se muestra el estado real, sin afirmar que fue cancelada.</p>}
        {result.status === 'cancelled' && <p>Cancelada en {result.creator_location_name}: <TransferDate value={result.cancelled_at} /></p>}
      </>}
      {errorText && <p role="alert">{errorText}</p>}
      <p>Cerrar o volver no deshace una cancelación enviada. La recuperación permanece en esta App; recargar o cerrar la pestaña pierde esta memoria.</p>
    </section>}
    {props.renderDetail ? props.renderDetail(actions) : actions}
    {visibleReview && <div className="transfer-decision-backdrop"><section ref={dialog} tabIndex={-1}
      className="transfer-decision-modal" role="dialog" aria-modal="true" aria-labelledby="cancellation-title" aria-busy={busy}
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
      <header><div><h2 id="cancellation-title">Confirmar cancelación</h2>
        <p>{visibleReview.record.reference} · {visibleReview.record.origin_location_name} → {visibleReview.record.destination_location_name}</p></div>
        <button ref={close} type="button" aria-label="Cerrar confirmación de cancelación" disabled={busy} onClick={dismiss}>×</button></header>
      <div className="transfer-decision-body">
        <TransferItems record={visibleReview.record} />
        <div className="transfer-impact"><h3>Impacto de la cancelación</h3>
          <p>Se cancelará la solicitud completa antes del despacho. El registro original se conserva y no podrá editarse ni volver a activarse.</p>
          <p>Si ya fue aprobada, se liberará únicamente su reserva en {visibleReview.record.origin_location_name}. Las existencias físicas, otras reservas y el stock del destino no cambian.</p>
          <p>Si sigue pendiente, no cambia el inventario. El servidor confirma el estado actual y conserva cualquier aprobación anterior.</p>
        </div>
        {busy && <p role="status">Confirmando cancelación…</p>}
        {errorText && <p role="alert">{errorText}</p>}
        {unresolved && !busy && <p role="status">Resultado sin confirmar. Usá la recuperación de la cancelación original.</p>}
      </div>
      <footer><button type="button" disabled={busy} onClick={dismiss}>Volver al detalle</button>
        <button type="button" className="primary" disabled={!!unresolved || !canCancel} onClick={() => {
          if (current() && latest.current.record?.id === visibleReview.record.id && cancellable(latest.current.record)) {
            void run(() => transfers.cancel(visibleReview.record));
          }
        }}>Confirmar cancelación</button></footer>
    </section></div>}
  </div>;
}
