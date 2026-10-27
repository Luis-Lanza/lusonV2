import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { TransferRecord } from './transferModel';
import type { useTransferDispatchReconciliations } from './useTransferDispatchReconciliations';
import { dispatchReconciliationActionHints, previewDispatchReconciliation, previewHistoricalDispatchReconciliation } from './transferDispatchReconciliationRecovery';
import { isTransferFocusTarget } from './transferModalFocus';
import TransferDate from './TransferDate';
import './transfer-dispatch-reconciliations.css';

/** A single owner-held hook supplies all state and actions. This view owns no transport. */
export interface TransferDispatchReconciliationsProps {
  record: TransferRecord | null;
  actorLocation: number | null;
  reconciliations: ReturnType<typeof useTransferDispatchReconciliations>;
}
const actions = { propose: 'Proponer', accept: 'Aceptar', reject: 'Rechazar' };
const states = { pending: 'Pendiente', superseded: 'Reemplazada', rejected: 'Rechazada', applied: 'Aplicada' };
const phases = { inFlight: 'En curso', uncertain: 'Resultado incierto', conflict: 'Conflicto', failed: 'Fallo definitivo', confirmed: 'Confirmada' };
const signed = (n: bigint) => n < 0n ? `−${-n}` : n > 0n ? `+${n}` : '0';
const errorCopy: Readonly<Record<string, string>> = {
  invalid_request: 'Revisá el motivo y la evidencia antes de continuar.',
  insufficient_stock: 'No se aplicó el ajuste: el stock debe mantener cubiertas las reservas.',
  retry_conflict: 'La operación no coincide con la evidencia registrada. Consultá su resultado.',
  decision_conflict: 'La evidencia cambió. Revisá nuevamente la propuesta.',
  unauthenticated: 'Regularización no disponible para esta sesión.',
  forbidden: 'Regularización no disponible para esta sesión.',
  not_found: 'Regularización no disponible para esta sesión.',
};

export default function TransferDispatchReconciliations(props: TransferDispatchReconciliationsProps) {
  const { record, actorLocation, reconciliations: r } = props;
  const masked = r.masked || [401, 403, 404].includes(r.error?.status ?? 0);
  const eligible = record?.status === 'received' && actorLocation !== null
    && (actorLocation === record.origin_location_id || actorLocation === record.destination_location_id);
  if (!eligible || masked) return <section className="dispatch-reconciliation" aria-label="Regularización de despacho">
    <p role="status">Regularización no disponible para esta sesión.</p>
    {eligible && <button disabled={r.busy} onClick={() => { void r.recover(); }}>Consultar recuperación autorizada</button>}
  </section>;
  // Remount only local disclosure/focus state when private context becomes unavailable.
  // No private snapshot, draft, reason, quantity or retry payload is copied into local state.
  const available = r.snapshot?.request_id.toString() === record.id;
  return <ReconciliationSection key={`${record.id}:${actorLocation}:${available ? 'ready' : 'empty'}`}
    {...props} record={record} actorLocation={actorLocation} />;
}

function ReconciliationSection({ record, actorLocation, reconciliations: r }: TransferDispatchReconciliationsProps & {
  record: TransferRecord; actorLocation: number;
}) {
  const snapshot = r.snapshot?.request_id.toString() === record.id ? r.snapshot : null;
  const [consultation, setConsultation] = useState<number | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const modal = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const restore = useRef(false);
  const titleID = useId(); const quantityID = useId(); const reasonID = useId(); const helpID = useId();
  const location = (id: number) => id === record.origin_location_id ? record.origin_location_name : record.destination_location_name;
  const name = (variant: number) => {
    const item = record.items.find(i => i.variant_id === variant);
    return item ? `${item.brand} · ${item.model} · ${item.capacity_ah} Ah · ${item.polarity}` : `Variante ${variant}`;
  };
  const attempts = r.attempts.filter(a => a.original.id === record.id && a.actor === actorLocation);
  const unresolved = attempts.some(a => !['confirmed', 'failed'].includes(a.phase));
  const draft = snapshot ? r.draft : null;
  const review = snapshot ? r.reviewState : null;
  const variant = review?.attempt.payload.variant_id ?? draft?.variantID ?? consultation;
  const line = snapshot?.lines.find(l => l.variant_id === variant);
  const pending = line?.proposals.at(-1)?.state === 'pending' ? line.proposals.at(-1)! : null;
  const hints = line && snapshot ? dispatchReconciliationActionHints(record, snapshot, line.variant_id, actorLocation) : null;
  const consulting = !draft && !review && consultation !== null && !!pending && !!hints?.reject;
  const active = !!snapshot && !!line && (!!draft || !!review || consulting);
  const action = review?.attempt.action ?? draft?.action;
  const preview = review?.preview ?? (line ? action === 'propose' ? previewDispatchReconciliation(line)
    : pending ? previewHistoricalDispatchReconciliation(pending) : null : null);
  const quantity = review && 'dispatch_quantity' in review.attempt.payload ? review.attempt.payload.dispatch_quantity
    : action === 'propose' ? line?.effective_actual : pending?.dispatch_quantity;
  const controls = () => Array.from(modal.current?.querySelectorAll<HTMLElement>('button, input, textarea, [tabindex]') ?? [])
    .filter(el => el.tabIndex >= 0 && isTransferFocusTarget(el) && !el.closest('[inert], [hidden]'));
  function close() {
    restore.current = true; setConsultation(null); r.cancel();
  }
  function begin(variantID: number, next: 'propose' | 'accept' | 'reject', trigger: HTMLElement) {
    if (r.busy || unresolved) return;
    if (!active) opener.current = trigger;
    r.begin(variantID, next);
  }
  // Match the existing count-correction isolation lifetime, including newly inserted siblings.
  useLayoutEffect(() => {
    const backdrop = modal.current?.parentElement;
    if (!active || !backdrop) return;
    const previous = new Map<Element, string | null>();
    const isolate = () => {
      for (let branch: Element | null = backdrop; branch && branch !== document.body; branch = branch.parentElement) {
        for (const sibling of branch.parentElement?.children ?? []) {
          if (sibling === branch || previous.has(sibling)) continue;
          previous.set(sibling, sibling.getAttribute('inert')); sibling.setAttribute('inert', '');
        }
      }
    };
    isolate(); const observer = new MutationObserver(isolate);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      for (const [el, value] of previous) { if (value === null) el.removeAttribute('inert'); else el.setAttribute('inert', value); }
    };
  }, [active]);
  useLayoutEffect(() => {
    if (active) (controls()[0] ?? modal.current)?.focus();
  }, [active, consulting, !!review, action]);
  useLayoutEffect(() => {
    if (active || !restore.current) return;
    restore.current = false;
    const target = opener.current;
    if (isTransferFocusTarget(target) && !target.closest('[inert], [hidden]')) target.focus();
    else heading.current?.focus();
  });
  return <section className="dispatch-reconciliation" aria-label="Regularización de despacho">
    <button onClick={() => heading.current?.focus()}>Gestiones · Regularizar despacho</button>
    <header><h2 ref={heading} tabIndex={-1}>Regularización de despacho</h2>
      <p>Confirma cuánto salió realmente; no registra otro envío físico.</p></header>
    {r.busy && <p role="status">Consultando o enviando regularizaciones…</p>}
    {r.error && <p role="alert">{Object.hasOwn(errorCopy, r.error.code) ? errorCopy[r.error.code] : 'No se pudo confirmar el resultado. Consultá el estado antes de volver a enviar.'}</p>}
    {!snapshot && <p role="status">Regularización no disponible.</p>}
    <p className="dispatch-reconciliation-notice">Solo variantes incluidas en el envío. Ambos lugares deben confirmar la procedencia.
      Enviar una propuesta no cambia existencias ni reservas. Cada nueva revisión requiere otro acuerdo.</p>
    {snapshot && <table aria-label="Comparación de despacho"><thead><tr>
      {['Batería', 'Despacho vigente', 'Recibidas efectivas', 'Crédito efectivo', 'Gestión'].map(t => <th scope="col" key={t}>{t}</th>)}
    </tr></thead><tbody>{snapshot.lines.map(l => {
      const h = dispatchReconciliationActionHints(record, snapshot, l.variant_id, actorLocation);
      const p = l.proposals.at(-1); const waiting = p?.state === 'pending';
      return <tr key={l.variant_id}><th scope="row">{name(l.variant_id)}</th>
        <td data-label="Despacho vigente">{l.effective_dispatch.toString()}</td>
        <td data-label="Recibidas efectivas">{l.effective_actual.toString()}</td>
        <td data-label="Crédito efectivo">{l.effective_credit.toString()}</td><td><div className="dispatch-reconciliation-actions">
          {h.propose && !unresolved && <button disabled={r.busy} onClick={e => begin(l.variant_id, 'propose', e.currentTarget)}>{waiting ? 'Reemplazar propuesta' : 'Proponer regularización'}</button>}
          {h.reject && !unresolved && <button disabled={r.busy} onClick={e => { opener.current = e.currentTarget; setConsultation(l.variant_id); }}>Consultar propuesta</button>}
          {waiting && <><p>{p.initiator_location_id === actorLocation ? `Esperando revisión de ${location(actorLocation === record.origin_location_id ? record.destination_location_id : record.origin_location_id)}` : `Propuesta de ${location(p.initiator_location_id)} · Requiere tu revisión`}</p>
            <p>Propuesto: {p.dispatch_quantity.toString()} · {p.reason}</p>
            <button disabled={r.busy} onClick={() => { void r.recover(); }}>Consultar estado</button></>}
          {l.applied_retained_quantity > 0n && <p>No disponible: esta variante tiene una restitución aplicada.</p>}
          {l.effective_dispatch === l.effective_actual && <p>Despacho y recepción vigente coinciden. No hay otra regularización para proponer.</p>}
        </div></td></tr>;
    })}</tbody></table>}
    <p>Cantidades de esta recepción, no inventario actual.</p>
    {snapshot && <details><summary>Ver historial de regularizaciones</summary>
      {!snapshot.operations.length && <p>Sin regularizaciones aplicadas.</p>}
      {snapshot.lines.map(l => l.proposals.map(p => <article className="dispatch-reconciliation-history" key={`${l.variant_id}:${p.revision}`}>
        <h3>Revisión {p.revision.toString()} · {states[p.state]} · {name(l.variant_id)}</h3>
        <p>Despacho {p.base_dispatch.toString()} → {p.dispatch_quantity.toString()} · Propone {location(p.initiator_location_id)}</p>
        <p className="dispatch-reconciliation-evidence">Motivo: {p.reason}</p><TransferDate value={p.recorded_at} />
        {p.decision && <p>{p.decision.accepted ? 'Aceptada' : 'Rechazada'} por {location(p.decision.actor_location_id)} · Motivo: {p.decision.reason}</p>}
        {p.application && <p>Efecto registrado: {record.origin_location_name} {signed(p.application.source_delta)} · {record.destination_location_name} {signed(p.application.destination_delta)}</p>}
        {!p.application && <p>Sin aplicación de ajustes.</p>}
      </article>))}
      {!!snapshot.operations.length && <details><summary>Saldos históricos de la operación; no inventario actual</summary>
        {snapshot.operations.filter(o => o.action === 'accept').map(o => <p key={o.operation_key}>
          {name(o.variant_id)} · {record.origin_location_name}: {o.source_existing_before?.toString()} → {o.source_existing_after?.toString()} ·
          {' '}{record.destination_location_name}: {o.destination_existing_before?.toString()} → {o.destination_existing_after?.toString()}
        </p>)}
      </details>}
    </details>}
    <details><summary>Ver recepción original</summary>{record.status === 'received' && record.receipt.items.map(i => <p key={i.variant_id}>
      {name(i.variant_id)} · Despacho registrado: {i.expected_quantity.toString()} · Recibidas originalmente: {i.actual_quantity.toString()} · Crédito original: {i.available_quantity.toString()}
    </p>)}<p>Esta evidencia se conserva después de cada regularización.</p></details>
    {attempts.map(a => <article className="dispatch-reconciliation-recovery" key={a.payload.operation_key}>
      <h3>{phases[a.phase]} · {name(a.payload.variant_id)}</h3>
      <p>{actions[a.action]} · Actor {location(a.actor)}</p>
      <p className="dispatch-reconciliation-evidence">Motivo capturado: {a.payload.reason}</p>
      {a.phase === 'failed' && <p>La operación fue rechazada definitivamente; no es una aplicación ni un resultado incierto.</p>}
      {a.priorUncertainty && a.phase !== 'confirmed' && <p>Resultado aún incierto. No crees otra propuesta ni reemplaces la operación original.</p>}
      {a.phase === 'confirmed' && <p>Operación confirmada mediante evidencia exacta.</p>}
      <div className="dispatch-reconciliation-actions">
        {!['confirmed', 'failed'].includes(a.phase) && <button disabled={r.busy} onClick={() => { void r.recover(); }}>Consultar resultado</button>}
        {['uncertain', 'conflict'].includes(a.phase) && <button disabled={r.busy} onClick={() => { void r.retry(a.payload.variant_id); }}>Reintentar carga exacta</button>}
      </div>
    </article>)}
    {active && line && <div className="dispatch-reconciliation-backdrop"><div ref={modal} className="dispatch-reconciliation-modal"
      role="dialog" aria-modal="true" aria-labelledby={titleID} tabIndex={-1} onKeyDown={e => {
        if (e.key === 'Escape' && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); close(); }
        if (e.key === 'Tab') {
          const items = controls(); const first = items[0]; const last = items.at(-1);
          if (!first) { e.preventDefault(); modal.current?.focus(); }
          else if (e.shiftKey && (document.activeElement === first || !items.includes(document.activeElement as HTMLElement))) { e.preventDefault(); last?.focus(); }
          else if (!e.shiftKey && (document.activeElement === last || !items.includes(document.activeElement as HTMLElement))) { e.preventDefault(); first.focus(); }
        }
      }}>
      <h3 id={titleID}>{consulting ? 'Revisar regularización recibida' : review ? 'Revisar propuesta de despacho' : `${actions[action!]} regularización`}</h3>
      <p>{record.reference} · Vista de {location(actorLocation)} · {name(line.variant_id)}</p>
      <p className="dispatch-reconciliation-notice">Despacho original: {line.expected_quantity.toString()} · Despacho vigente: {line.effective_dispatch.toString()} · Conteo recibido vigente: {line.effective_actual.toString()}</p>
      {pending && <p className="dispatch-reconciliation-evidence">Motivo de {location(pending.initiator_location_id)}: {pending.reason}</p>}
      <label htmlFor={quantityID}>Cantidad total realmente despachada</label>
      <input id={quantityID} readOnly value={(quantity ?? pending?.dispatch_quantity)?.toString() ?? ''} aria-describedby={helpID} />
      <p id={helpID}>Debe coincidir con el conteo recibido vigente. No es la diferencia. Si ese conteo está mal, corregilo primero en Correcciones de conteo.</p>
      {!consulting && (review ? <><p>Motivo y confirmación de lo ocurrido</p>
        <p className="dispatch-reconciliation-evidence">{review.attempt.payload.reason}</p></>
        : <><label htmlFor={reasonID}>Motivo y confirmación de lo ocurrido</label>
          <textarea id={reasonID} value={draft?.reason ?? ''} disabled={r.busy} onChange={e => r.setReason(e.target.value)} required maxLength={2000} /></>)}
      {action === 'reject' ? <p>Sin cambios en el conteo ni en el stock.</p> : preview && <>
        <div className="dispatch-reconciliation-comparison"><div>{record.origin_location_name} · efecto al aceptar<strong>{signed(preview.source_delta)}</strong></div>
          <div>{record.destination_location_name} · efecto al aceptar<strong>{signed(preview.destination_delta)}</strong></div></div>
        <p>Crédito de esta recepción: {line.effective_credit.toString()} → {preview.dispatch_quantity.toString()}. No representa el saldo actual del destino.</p>
      </>}
      <p className="dispatch-reconciliation-warning">Verificá que esta cantidad salió realmente del origen; recibirla no demuestra por sí solo su procedencia.
        Al aceptar, ambos ajustes se aplican juntos, sujetos a validación de stock y reservas. No se modifica el registro original.</p>
      {r.error && <p role="alert">{Object.hasOwn(errorCopy, r.error.code) ? errorCopy[r.error.code] : 'No se pudo preparar la revisión. Verificá la evidencia y el motivo.'}</p>}
      <div className="dispatch-reconciliation-actions">
        {consulting ? <><button disabled={r.busy || unresolved || !hints?.accept} onClick={e => begin(line.variant_id, 'accept', e.currentTarget)}>Aceptar propuesta</button>
          <button disabled={r.busy || unresolved || !hints?.reject} onClick={e => begin(line.variant_id, 'reject', e.currentTarget)}>Rechazar propuesta</button></>
          : review ? <button className="dispatch-reconciliation-primary" disabled={r.busy || unresolved || !hints?.[review.attempt.action]}
            onClick={() => { restore.current = true; setConsultation(null); void r.confirm(); }}>
            {review.attempt.action === 'propose' ? 'Enviar propuesta' : review.attempt.action === 'accept' ? 'Confirmar aceptación' : 'Confirmar rechazo'}</button>
          : <button className="dispatch-reconciliation-primary" disabled={r.busy || unresolved || !draft?.reason.trim()} onClick={() => r.review()}>Ver revisión de propuesta</button>}
        <button onClick={close}>Cerrar</button>
      </div>
    </div></div>}
  </section>;
}
