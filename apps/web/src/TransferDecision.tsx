import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { TransferController } from './useInventory';
import type { useTransfers } from './useTransfers';
import type { TransferRecord } from './transferModel';
import { captureDecisionRecord, matchesDecisionRecord, satisfiesDecision, type TransferDecision as Action } from './transferDecisionRecovery';
import { detailAuthority, TransferItems, transferStatusLabel, type StockAdvice } from './TransferDetail';
import { transferViewOwner } from './TransferPending';
import { TransferAPIError } from './transferAPI';
import TransferDate from './TransferDate';
import { useTransferModalFocus, type TransferModalFocusBinding } from './transferModalFocus';

export interface TransferDecisionProps {
  controller: TransferController;
  ownerTag: string;
  transfers: ReturnType<typeof useTransfers>;
  record?: TransferRecord | null;
  stock?: StockAdvice;
  onPrivateUnavailable?: () => void;
  onStockRefresh?: () => void;
  renderDetail?: (actions: ReactNode) => ReactNode;
  modalFocus?: TransferModalFocusBinding;
}
export default function TransferDecision(props: TransferDecisionProps) {
  const { controller, ownerTag, transfers } = props;
  const latest = useRef(props);
  latest.current = props;
  const fence = detailAuthority(controller);
  const authority = controller.getTransferAuthority();
  const boundFence = useRef(fence);
  const permitted = !!fence && fence === boundFence.current && transferViewOwner(authority) === ownerTag;
  const [review, setReview] = useState<{ fence: string; record: TransferRecord; action: Action; trigger: HTMLElement } | null>(null);
  const dialog = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const mounted = useRef(false);
  const pendingCall = useRef(false);
  const current = () => mounted.current && permitted && detailAuthority(controller) === fence;
  const attempt = permitted ? transfers.decision : null;
  const busy = attempt?.phase === 'inFlight';
  const visibleReview = permitted && review?.fence === fence ? review : null;
  const focus = useTransferModalFocus({ active: !!visibleReview, id: props.record?.id, fence, current, binding: props.modalFocus });
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!visibleReview) return;
    if (busy) dialog.current?.focus();
    else close.current?.focus();
  }, [visibleReview, busy]);
  if (!permitted) return null;
  const record = props.record;
  const assigned = authority.session?.authenticated ? authority.session.identity.location.id : null;
  const canReview = record?.status === 'pending' && record.approver_location_id === assigned;
  const unresolved = attempt?.phase === 'uncertain' || busy;
  const result = attempt?.result;
  const reviewAttempt = visibleReview && attempt?.action === visibleReview.action
    && matchesDecisionRecord(visibleReview.record, attempt.original) ? attempt : null;
  const reviewResult = reviewAttempt?.result && reviewAttempt.result.status !== 'pending'
    && matchesDecisionRecord(reviewAttempt.original, reviewAttempt.result)
    && (reviewAttempt.phase === 'confirmed' || reviewAttempt.phase === 'conflict') ? reviewAttempt.result : null;
  const reviewConfirmed = !!reviewResult && reviewAttempt?.phase === 'confirmed' && satisfiesDecision(reviewAttempt.action, reviewResult);
  const failure = transfers.decisionError;
  const error = failure?.code === 'insufficient_stock' ? 'No hay disponibilidad suficiente para aprobar la solicitud completa.'
    : failure?.status === 403 || failure?.status === 404 ? 'La solicitud no está disponible.'
      : failure?.status === 401 ? 'No se pudo verificar la sesión.'
        : failure ? 'No se pudo confirmar la decisión con el servidor.' : '';
  const dismiss = () => {
    if (!current() || transfers.decision?.phase === 'inFlight' || pendingCall.current) return;
    if (visibleReview) focus.queue({ id: visibleReview.record.id, fence: visibleReview.fence, trigger: visibleReview.trigger });
    setReview(null);
  };
  const run = async (operation: () => Promise<TransferRecord>) => {
    if (!current() || pendingCall.current || transfers.decision?.phase === 'inFlight') return;
    pendingCall.current = true;
    try { await operation(); } catch (error: unknown) {
      // The hook masks its private recovery; also remove the selected private DTO.
      if (current() && error instanceof TransferAPIError && (error.status === 403 || error.status === 404)) {
        setReview(null);
        props.onPrivateUnavailable?.();
      }
      if (current() && error instanceof TransferAPIError && error.code === 'insufficient_stock') props.onStockRefresh?.();
    }
    finally { pendingCall.current = false; }
  };
  const open = (action: Action, trigger: HTMLElement) => {
    if (!current() || !record || record.status !== 'pending' || unresolved || pendingCall.current
      || latest.current.record?.id !== record.id || latest.current.record.status !== 'pending') return;
    const now = controller.getTransferAuthority();
    if (!now.session?.authenticated || now.session.identity.location.id !== record.approver_location_id) return;
    focus.begin();
    setReview({ fence, record: captureDecisionRecord(record), action, trigger });
  };
  const actions = canReview && !(result && result.id === record.id) ? <div className="transfer-decision-actions">
    <button type="button" className="primary" disabled={!!unresolved} onClick={event => open('approve', event.currentTarget)}>Aprobar {record.kind === 'send_to_warehouse' ? 'envío' : 'solicitud'}</button>
    <button type="button" className="transfer-reject" disabled={!!unresolved} onClick={event => open('reject', event.currentTarget)}>Rechazar {record.kind === 'send_to_warehouse' ? 'envío' : 'solicitud'}</button>
    <p>Cada acción abrirá un paso de confirmación.</p>
  </div> : null;
  return <div className="transfer-decision">
    {attempt && <section className="transfer-decision-recovery" aria-label="Recuperación de decisión">
      <h3>{unresolved ? 'Decisión pendiente de confirmación' : 'Resultado confirmado'}</h3>
      <p>{attempt.original.reference} · {attempt.action === 'approve' ? 'Aprobación' : 'Rechazo'} de la solicitud completa</p>
      {busy ? <p role="status">Consultando o enviando la decisión…</p> : unresolved ? <>
        <p role="status">El resultado sigue sin confirmar. La solicitud puede haberse decidido, aunque una consulta muestre Pending. No cambies la acción original.</p>
        <button type="button" onClick={() => void run(transfers.recoverDecision)}>Consultar resultado original</button>
        <button type="button" onClick={() => void run(transfers.retryDecision)}>Reintentar {attempt.action === 'approve' ? 'misma aprobación' : 'mismo rechazo'}</button>
      </> : result && <>
        <p role="status">Estado confirmado: {transferStatusLabel(result)}.</p>
        {attempt.phase === 'conflict' && <p>El servidor confirmó una decisión distinta de la acción original. Se muestra el resultado real, sin enviar otra decisión.</p>}
        {result.decided_at && <p>Decidida: <TransferDate value={result.decided_at} /></p>}
        {result.status === 'cancelled' && <p>Cancelada: <TransferDate value={result.cancelled_at} />. No se confirmó la acción original.</p>}
      </>}
      {error && <p role="alert">{error}</p>}
      <p>Volver o cerrar la confirmación no cancela una decisión enviada. La recuperación permanece en esta App; recargar o cerrar la pestaña pierde esta memoria.</p>
    </section>}
    {props.renderDetail ? props.renderDetail(actions) : actions}
    {visibleReview && <div className="transfer-decision-backdrop"><section ref={dialog} tabIndex={-1}
      className="transfer-decision-modal" role="dialog" aria-modal="true" aria-labelledby="decision-title" aria-busy={busy}
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
      <header><div><h2 id="decision-title">{reviewConfirmed ? `Solicitud ${transferStatusLabel(reviewResult)} confirmada` : reviewResult ? `Resultado de la solicitud: ${transferStatusLabel(reviewResult)}` : visibleReview.action === 'approve' ? 'Confirmar aprobación' : 'Confirmar rechazo'}</h2>
        <p>{visibleReview.record.reference} · {visibleReview.record.origin_location_name} → {visibleReview.record.destination_location_name}</p></div>
        <button ref={close} type="button" aria-label="Cerrar confirmación" disabled={busy} onClick={dismiss}>×</button>
      </header>
      <div className="transfer-decision-body">
        <TransferItems record={visibleReview.record} stock={props.stock ?? { catalog: null, busy: false, unavailable: true }} confirmation reject={visibleReview.action === 'reject'} />
        <div className="transfer-impact"><h3>{reviewResult ? 'Resultado de la decisión' : visibleReview.action === 'approve' ? 'Impacto de la confirmación' : 'Impacto del rechazo'}</h3>
          {reviewResult ? (reviewConfirmed ? <p role="status">{visibleReview.action === 'approve'
            ? 'Solicitud aprobada correctamente. Se autorizó y reservó la solicitud completa; no se movieron existencias ni se acreditó stock en destino.'
            : 'Solicitud rechazada correctamente. No se movieron existencias ni se modificaron reservas.'}</p>
            : <p role="alert">La acción original no se confirmó. Se muestra el estado real de la solicitud, sin enviar otra decisión.</p>) : visibleReview.action === 'approve' ? <>
            <p>Se revalidará toda la solicitud y se reservarán sus cantidades completas en {visibleReview.record.origin_location_name}.</p>
            <p>Si alguna variante no tiene suficiente disponible, no se aprobará ni se reservará ninguna batería.</p>
            <p>El stock mostrado es orientativo. Aprobar no mueve existencias ni aumenta el stock del destino.</p>
          </> : <>
            <p>Se rechazará la solicitud completa. Estado al confirmar: Rechazada.</p>
            <p>No se liberarán reservas ni se moverán existencias. El registro se conserva.</p>
            <p>Después de confirmar el rechazo, la solicitud no podrá aprobarse ni editarse.</p>
          </>}
        </div>
        {busy && <p role="status">Confirmando decisión…</p>}
        {error && <p role="alert">{error}</p>}
        {unresolved && !busy && <p role="status">Resultado sin confirmar. Usá la recuperación de la decisión original.</p>}
        {reviewResult && <p role="status">Estado confirmado: {transferStatusLabel(reviewResult)}.</p>}
      </div>
      <footer><button type="button" disabled={busy} onClick={dismiss}>Volver al detalle</button>
        {!unresolved && canReview && record.id === visibleReview.record.id && !(result && result.id === visibleReview.record.id) && <button type="button" className={visibleReview.action === 'approve' ? 'primary' : 'transfer-reject-confirm'} onClick={() => {
          if (current() && latest.current.record?.status === 'pending' && latest.current.record.id === visibleReview.record.id) {
            void run(() => transfers.decide(visibleReview.record, visibleReview.action));
          }
        }}>{visibleReview.action === 'approve' ? 'Confirmar aprobación' : 'Confirmar rechazo'}</button>}
      </footer>
    </section></div>}
  </div>;
}
