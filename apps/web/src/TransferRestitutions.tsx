import { useEffect, useId, useRef, useState } from 'react';
import TransferDate from './TransferDate';
import { useTransferRestitutions } from './useTransferRestitutions';
import { decisionOwner } from './transferDecisionRecovery';
import { newTransferRetryKey, type TransferRecord } from './transferModel';
import { normalizeRestitutionDecision, normalizeRestitutionProposal, type RestitutionAction,
  type RestitutionDecisionInput, type RestitutionProposalInput } from './transferRestitutionModel';
import type { RestitutionReviewPin } from './transferRestitutionRecovery';
import type { TransferController } from './useInventory';
export interface TransferRestitutionsProps { controller: TransferController; record: TransferRecord; requestID: string | null; enabled: boolean }
const ownerKey = (c: TransferController) => {
  const authority = c.getTransferAuthority();
  const owner = decisionOwner(authority);
  return owner ? JSON.stringify([owner, authority.session]) : '';
};
function eligible(p: TransferRestitutionsProps) {
  const owner = decisionOwner(p.controller.getTransferAuthority());
  return p.enabled && p.requestID === p.record.id && p.record.status === 'received' && !!owner
    && (owner.location === p.record.origin_location_id || owner.location === p.record.destination_location_id);
}
export default function TransferRestitutions(props: TransferRestitutionsProps) {
  // Legacy read-only callers have no recovery; never create a pane-local substitute.
  if (!eligible(props) || !props.controller.restitutionRecovery) return null;
  return <Section key={`${ownerKey(props.controller)}/${props.requestID}`} {...props} />;
}
interface Draft { action: RestitutionAction; pin: RestitutionReviewPin; quantity: string; reason: string; attested: boolean; trigger: HTMLElement }
const labels = { propose: 'Proponer restitución', accept: 'Aceptar restitución', reject: 'Rechazar restitución' };
const confirms = { propose: 'Confirmar propuesta', accept: 'Confirmar aceptación', reject: 'Confirmar rechazo' };
const states = { pending: 'Pendiente', superseded: 'Reemplazada', rejected: 'Rechazada', applied: 'Aplicada' };
function Section(props: TransferRestitutionsProps) {
  const { controller, record } = props;
  const boundOwner = useRef(ownerKey(controller));
  const [variant, setVariant] = useState<number | null>(record.items[0]?.variant_id ?? null);
  const hook = useTransferRestitutions({ controller, recovery: controller.restitutionRecovery!, record,
    requestID: props.requestID, enabled: eligible(props), variantID: variant, onConfirmation: controller.confirmTransferRestitution });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [review, setReview] = useState<{ draft: Draft; input: RestitutionProposalInput | RestitutionDecisionInput; snapshot: typeof hook.snapshot } | null>(null);
  const [message, setMessage] = useState('');
  const mounted = useRef(false); const sending = useRef(false);
  const modal = useRef<HTMLDivElement>(null); const cancel = useRef<HTMLButtonElement>(null);
  const restoreAfterSend = useRef<HTMLElement | null>(null);
  const consultation = useRef<HTMLButtonElement>(null);
  const selectID = useId(); const quantityID = useId(); const reasonID = useId(); const attestationID = useId(); const headingID = useId();
  const current = () => mounted.current && eligible(props) && ownerKey(controller) === boundOwner.current;
  const snapshot = hook.snapshot; const masked = hook.masked;
  const line = snapshot?.lines.find(l => l.variant_id === variant && record.items.some(i => i.variant_id === l.variant_id));
  const closed = !!line && line.applied_revision > 0n;
  const selectedItem = record.items.find(i => i.variant_id === variant);
  const receipt = record.status === 'received' ? record.receipt.items.find(i => i.variant_id === variant) : null;
  const visibleReview = review && !masked && !hook.busy && review.snapshot === snapshot && current()
    && hook.review(review.draft.action) ? review : null;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setDraft(null); setReview(null); setMessage(''); }, [variant, record, masked, hook.busy, snapshot]);
  useEffect(() => { if (review && !visibleReview) { setDraft(null); setReview(null); } }, [review, visibleReview]);
  useEffect(() => {
    if (!visibleReview) return;
    cancel.current?.focus();
    return () => { if (current()) visibleReview.draft.trigger.focus(); };
  }, [visibleReview]);
  useEffect(() => {
    if (!hook.busy && !masked && current() && restoreAfterSend.current) {
      const trigger = restoreAfterSend.current;
      if (trigger instanceof HTMLButtonElement && trigger.disabled) consultation.current?.focus(); else trigger.focus();
      restoreAfterSend.current = null;
    }
  }, [hook.busy, masked]);
  function close() { if (current() && !sending.current) { setReview(null); setDraft(null); draft?.trigger.focus(); } }
  function open(action: RestitutionAction, trigger: HTMLElement) {
    if (!current() || hook.busy || masked || sending.current) return;
    const pin = hook.review(action); if (!pin) return;
    setMessage(''); setReview(null); setDraft({ action, pin, quantity: '', reason: '', attested: false, trigger });
  }
  function prepare() {
    if (!current() || !draft || !line || hook.busy || masked || sending.current || !hook.review(draft.action)) return;
    try {
      if (draft.action === 'propose' && !draft.attested) throw new Error('Attestation required');
      const input = Object.freeze({ variant_id: variant!, operation_key: newTransferRetryKey(), expected_revision: line.workflow_revision.toString(), reason: draft.reason,
        ...(draft.action === 'propose' ? { retained_quantity: draft.quantity, retained_at_origin: true as const } : {}) });
      if (draft.action === 'propose') {
        const normalized = normalizeRestitutionProposal(input as RestitutionProposalInput);
        if (normalized.retained_quantity > line.expected_quantity - line.effective_credit - line.applied_retained_quantity) throw new Error('Exceeds outstanding debit');
      } else normalizeRestitutionDecision(input);
      setReview({ draft: { ...draft }, input, snapshot }); setMessage('');
    } catch { setMessage('Ingresá una cantidad positiva decimal canónica, un motivo válido y confirmá la retención física en origen. No se enviará nada sin una clave segura.'); }
  }
  async function run(operation: () => Promise<void>) {
    if (!current() || sending.current) return;
    sending.current = true;
    try { await operation(); } catch { if (current()) setMessage('No se pudo verificar el resultado. Consultá la recuperación.'); }
    finally { sending.current = false; }
  }
  const actions: RestitutionAction[] = decisionOwner(controller.getTransferAuthority())?.account === record.destination_location_id
    ? ['accept', 'reject'] : decisionOwner(controller.getTransferAuthority())?.account === record.origin_location_id ? ['propose'] : [];
  return <section className={`transfer-restitutions${closed ? ' restitution-is-closed' : ''}`} aria-label="Restituciones de origen">
    <h2>Restituciones de origen</h2>
    {masked ? <><p role="status">Restituciones no disponibles para esta sesión.</p><button disabled={hook.busy} onClick={() => { if (current()) void run(hook.recover); }}>Consultar recuperación autorizada</button></> : <>
      {line && <section className="restitution-outcome" aria-label="Resultado de restitución de la variante seleccionada">
        <div className="restitution-outcome-heading"><h3>{selectedItem?.brand} · {selectedItem?.model} · {selectedItem?.capacity_ah} Ah · {selectedItem?.polarity}</h3>
          {closed && <span className="restitution-closed">Restitución cerrada</span>}</div>
        <dl className="restitution-quantities"><div><dt>Crédito efectivo en destino</dt><dd>{line.effective_credit.toString()}</dd></div>
          <div><dt>Restitución aplicada en origen</dt><dd>{line.applied_retained_quantity.toString()}</dd></div></dl>
        <p>{closed && <><span>Una aplicación, incluso parcial, cierra esta restitución.</span>{' '}</>}
          <span className="restitution-immutable">El despacho y la recepción original son inmutables.</span></p>
      </section>}
      {!closed && <div className="restitution-safety">
        <p>La falta en destino no prueba retención. Proponer o rechazar no mueve stock. Aceptar acredita existencias en origen una sola vez; destino y reservas no cambian.</p>
        <p>Una aplicación, incluso parcial, cierra esta restitución. El despacho y la recepción original son inmutables.</p>
      </div>}
      <div className="restitution-consultation"><div>
        <label htmlFor={selectID}>Variante de restitución</label><select id={selectID} value={variant ?? ''} disabled={hook.busy} onChange={e => {
          if (current()) { setDraft(null); setReview(null); setVariant(Number(e.target.value)); }
        }}>{record.items.map(i => <option key={i.variant_id} value={i.variant_id}>{i.brand} · {i.model} · {i.capacity_ah} Ah · {i.polarity}</option>)}</select>
      </div><button ref={consultation} disabled={hook.busy} onClick={() => { if (current()) void run(hook.refresh); }}>Consultar para revisar restitución</button></div>
      {hook.busy && <p role="status">Consultando o enviando restitución…</p>}
      {hook.error && <p role="alert">No se pudo verificar la restitución. Consultá el estado antes de enviar.</p>}
      {message && <p role="alert">{message}</p>}
      {!line && !hook.busy && <p role="status">Evidencia de restitución no disponible.</p>}
      {line && <article className="restitution-card">
        <dl><dt>Despacho original</dt><dd>{line.expected_quantity.toString()}</dd>
          <dt>Recepción original (cantidad física)</dt><dd>{receipt?.actual_quantity.toString()}</dd>
          <dt>Crédito original en destino</dt><dd>{line.original_credit.toString()}</dd></dl>
        <div className="restitution-actions">{actions.map(action => <button key={action} disabled={hook.busy || !hook.review(action)} onClick={e => open(action, e.currentTarget)}>{labels[action]}</button>)}</div>
        <h3>Historial inmutable de restitución</h3>
        {!line.proposals.length && <p>Sin propuestas de restitución.</p>}
        <ol>{line.proposals.map(p => <li key={p.revision.toString()}>
          <section aria-label={`Propuesta ${p.revision}`}><h4>{states[p.state]} · Propuesta {p.revision.toString()}</h4>
            <p>Retenidas en origen: {p.retained_quantity.toString()} · Retención física atestada explícitamente</p>
            <p>Origen: {p.initiator_location_id} · <TransferDate value={p.recorded_at} /></p>
            <p className="restitution-evidence">Motivo: {p.reason}</p>
            <details className="restitution-technical"><summary>Evidencia técnica</summary>
              <p>Clave: {p.operation_key}</p>
              <p>Revisión base: {p.base_revision.toString()} · Crédito base: {p.base_credit.toString()} · Restitución base: {p.base_restitution.toString()}</p>
              <p>Generación de conteo: {p.count_generation.toString()} · Revisión de conteo aplicada: {p.count_applied_revision.toString()}</p>
            </details></section>
          {p.decision && <section aria-label={`Decisión ${p.revision}`}><h4>{p.decision.accepted ? 'Aceptada' : 'Rechazada'}</h4>
            <p>Destino: {p.decision.actor_location_id} · <TransferDate value={p.decision.recorded_at} /></p><p className="restitution-evidence">Motivo de decisión: {p.decision.reason}</p>
            <details className="restitution-technical"><summary>Evidencia técnica</summary><p>Clave: {p.decision.operation_key}</p></details></section>}
          {p.application && <section aria-label={`Aplicación ${p.revision}`}><h4>Aplicación en origen</h4><p>Origen: {p.application.origin_location_id} · Existencias acreditadas: +{p.application.quantity.toString()} · <TransferDate value={p.application.recorded_at} /></p>
            <details className="restitution-technical"><summary>Evidencia técnica</summary><p>Clave: {p.application.operation_key}</p>
              {snapshot?.operations.filter(o => o.operation_key === p.application!.operation_key && o.action === 'accept').map(o => <p key={o.operation_key}>Existencias de origen registradas: {o.source_existing_before?.toString()} → {o.source_existing_after?.toString()}</p>)}
            </details></section>}
        </li>)}</ol>
      </article>}
      {hook.attempts.map(a => <article className="restitution-card" key={a.payload.operation_key} aria-label={`Recuperación de restitución ${a.payload.variant_id}`}>
        <h3>Operación {a.phase}</h3><p>{labels[a.action]} · Variante {a.payload.variant_id} · Cuenta {a.owner.account} · Revisión {a.payload.expected_revision.toString()} · Clave {a.payload.operation_key}</p>
        <p className="restitution-evidence">Motivo capturado: {a.payload.reason}</p>
        {'retained_quantity' in a.payload && <p>Retenidas: {a.payload.retained_quantity.toString()} · Retención física atestada</p>}
        {a.priorUncertainty && a.phase !== 'confirmed' && <p>Resultado incierto. No crees otra operación para esta variante.</p>}
        <div className="restitution-actions"><button disabled={hook.busy} onClick={() => { if (current()) void run(hook.recover); }}>Consultar resultado de restitución</button>
          {(a.phase === 'uncertain' || a.phase === 'conflict') && <button disabled={hook.busy} onClick={() => { if (current()) void run(() => hook.retry(a.payload.variant_id)); }}>Reintentar carga exacta</button>}</div>
      </article>)}
      {draft && !review && line && <form className="restitution-form" aria-label="Editar restitución" onSubmit={e => { e.preventDefault(); prepare(); }}>
        <h3>{labels[draft.action]}</h3>
        {draft.action === 'propose' && <><label htmlFor={quantityID}>Cantidad retenida</label><input id={quantityID} inputMode="numeric" required value={draft.quantity} onChange={e => setDraft({ ...draft, quantity: e.target.value })} />
          <label htmlFor={attestationID}><input id={attestationID} type="checkbox" required checked={draft.attested} onChange={e => setDraft({ ...draft, attested: e.target.checked })} />Confirmo que estas unidades permanecen físicamente en origen</label></>}
        <label htmlFor={reasonID}>Motivo de restitución</label><textarea id={reasonID} required value={draft.reason} onChange={e => setDraft({ ...draft, reason: e.target.value })} />
        <div className="restitution-actions"><button type="submit">Revisar restitución</button><button type="button" onClick={close}>Cancelar</button></div>
      </form>}
      {visibleReview && <div className="restitution-backdrop"><div ref={modal} className="restitution-modal" role="dialog" aria-modal="true" aria-labelledby={headingID} tabIndex={-1} onKeyDown={e => {
        if (e.key === 'Escape') { e.preventDefault(); close(); }
        if (e.key === 'Tab') { const controls = Array.from(modal.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []); const first = controls[0]; const last = controls.at(-1);
          if (e.shiftKey && (document.activeElement === first || document.activeElement === modal.current)) { e.preventDefault(); last?.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); } }
      }}><h3 id={headingID}>Revisar restitución</h3><div className="restitution-modal-body">
        <p>{labels[visibleReview.draft.action]} · Variante {variant} · Revisión {visibleReview.input.expected_revision}</p>
        <p>Retenidas: {'retained_quantity' in visibleReview.input ? visibleReview.input.retained_quantity : line?.proposals.find(p => p.state === 'pending')?.retained_quantity.toString()}</p>
        <p className="restitution-evidence">Motivo exacto: {visibleReview.input.reason}</p>
        <p>{visibleReview.draft.action === 'accept' ? `Acredita origen ${record.origin_location_name} una vez. Destino sin cambios. No cambia reservas.` : 'No mueve stock ni cambia reservas.'}</p>
        <p>La falta en destino no prueba retención. Una aplicación, incluso parcial, cierra esta restitución. El despacho y la recepción original son inmutables.</p>
        {visibleReview.draft.action === 'propose' && <p>Confirmaste que estas unidades permanecen físicamente en origen.</p>}
      </div><footer><button ref={cancel} onClick={close}>Cancelar</button><button onClick={() => {
        if (!current() || hook.busy || sending.current || snapshot !== visibleReview.snapshot) return;
        const captured = visibleReview; restoreAfterSend.current = captured.draft.trigger; setReview(null); setDraft(null);
        void run(() => hook.submit(captured.draft.pin, captured.input));
      }}>{confirms[visibleReview.draft.action]}</button></footer></div></div>}
    </>}
  </section>;
}
