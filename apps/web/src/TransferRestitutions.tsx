import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { isTransferFocusTarget } from './transferModalFocus';
import './transfer-restitutions.css';
import TransferDate from './TransferDate';
import { useTransferRestitutions } from './useTransferRestitutions';
import { decisionOwner } from './transferDecisionRecovery';
import { newTransferRetryKey, type TransferRecord } from './transferModel';
import { normalizeRestitutionDecision, normalizeRestitutionProposal, type RestitutionAction,
  type RestitutionDecisionInput, type RestitutionProposalInput, type Restitutions, type RestitutionLine } from './transferRestitutionModel';
import type { RestitutionReviewPin } from './transferRestitutionRecovery';
import type { TransferController } from './useInventory';
export interface TransferRestitutionsProps {
  controller: TransferController; record: TransferRecord; requestID: string | null; enabled: boolean;
  contextVisible?: boolean;
  entryFocusKey?: number;
}
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
interface Draft { action: RestitutionAction; pin: RestitutionReviewPin; quantity: string; reason: string; attested: boolean; trigger: HTMLElement;
  capture: { record: TransferRecord; snapshot: Restitutions; line: RestitutionLine } }
const balance = (line: RestitutionLine) => line.expected_quantity - line.effective_credit - line.applied_retained_quantity;
const labels = { propose: 'Proponer restitución', accept: 'Aceptar restitución', reject: 'Rechazar restitución' };
const confirms = { propose: 'Confirmar propuesta', accept: 'Confirmar aceptación', reject: 'Confirmar rechazo' };
const states = { pending: 'Pendiente', superseded: 'Reemplazada', rejected: 'Rechazada', applied: 'Aplicada' };
function Section(props: TransferRestitutionsProps) {
  const { controller, record } = props;
  const boundOwner = useRef(ownerKey(controller));
  const [variant, setVariant] = useState<number | null>(record.items[0]?.variant_id ?? null);
  const hook = useTransferRestitutions({ controller, recovery: controller.restitutionRecovery!, record,
    requestID: props.requestID, enabled: eligible(props) && ownerKey(controller) === boundOwner.current,
    variantID: variant, onConfirmation: controller.confirmTransferRestitution });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [review, setReview] = useState<{ draft: Draft; input: RestitutionProposalInput | RestitutionDecisionInput; snapshot: typeof hook.snapshot } | null>(null);
  const [message, setMessage] = useState('');
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const disclosureID = useId();
  const toggleHistory = (id: number) => setExpanded(value => ({ ...value, [id]: !value[id] }));
  const mounted = useRef(false); const sending = useRef(false);
  const modal = useRef<HTMLDivElement>(null); const cancel = useRef<HTMLButtonElement>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const restoreAfterSend = useRef<{ target: HTMLElement; record: TransferRecord; variant: number | null } | null>(null);
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
  const proposalReview = visibleReview?.draft.action === 'propose' && 'retained_quantity' in visibleReview.input
    ? { capture: visibleReview.draft.capture, input: visibleReview.input, attested: visibleReview.draft.attested } : null;
  const reviewedItem = proposalReview?.capture.record.items.find(i => i.variant_id === proposalReview.capture.line.variant_id);
  const decisionDraft = visibleReview ? visibleReview.draft.action !== 'propose' ? visibleReview.draft : null
    : !review && draft?.action !== 'propose' ? draft : null;
  const decisionCapture = decisionDraft?.capture;
  const decisionProposal = decisionCapture?.line.proposals.find(p => p.state === 'pending' && p.revision === decisionCapture.line.workflow_revision);
  const decisionItem = decisionCapture?.record.items.find(i => i.variant_id === decisionCapture.line.variant_id);
  const decisionTitle = decisionDraft?.action === 'accept' ? 'Confirmar aceptación de restitución' : 'Confirmar rechazo de restitución';
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setDraft(null); setReview(null); setMessage(''); }, [variant, record, masked, hook.busy, snapshot]);
  useEffect(() => { if (review && !visibleReview) { setDraft(null); setReview(null); } }, [review, visibleReview]);
  const modalActive = !!draft && !!line && !masked && !hook.busy && current() && !!hook.review(draft.action);
  const focusEligible = (target: HTMLElement | null): target is HTMLElement => {
    if (!isTransferFocusTarget(target) || target.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    for (let node: HTMLElement | null = target; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    const closedDetails = target.closest('details:not([open])');
    return !closedDetails || !!closedDetails.querySelector(':scope > summary')?.contains(target);
  };
  const controls = () => Array.from(modal.current?.querySelectorAll<HTMLElement>(
    'input:not([type="hidden"]), select, textarea, button, a[href], details > summary:first-of-type, [tabindex]') ?? [])
    .filter(target => focusEligible(target) && target.tabIndex >= 0);
  // The isolation lifetime spans both steps; cleanup runs before queued focus return.
  useLayoutEffect(() => {
    const backdrop = modal.current?.parentElement;
    if (!modalActive || !backdrop) return;
    const previous = new Map<Element, string | null>();
    const isolate = () => {
      for (let branch: Element | null = backdrop; branch && branch !== document.body; branch = branch.parentElement) {
        for (const sibling of branch.parentElement?.children ?? []) {
          if (sibling === branch || previous.has(sibling)) continue;
          previous.set(sibling, sibling.getAttribute('inert'));
          if (!sibling.hasAttribute('inert')) sibling.setAttribute('inert', '');
        }
      }
    };
    isolate();
    const observer = new MutationObserver(isolate);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      for (const [element, value] of previous) {
        if (value === null) element.removeAttribute('inert'); else element.setAttribute('inert', value);
      }
    };
  }, [modalActive]);
  useLayoutEffect(() => {
    const pending = restoreAfterSend.current;
    if (!pending) return;
    if (!current() || masked || pending.record !== record || pending.variant !== variant) {
      restoreAfterSend.current = null; return;
    }
    if (modalActive || hook.busy) return;
    restoreAfterSend.current = null;
    if (focusEligible(pending.target)) pending.target.focus();
    else if (focusEligible(contextHeading.current)) contextHeading.current.focus();
  });
  useLayoutEffect(() => {
    if (!modalActive) return;
    if (proposalReview || visibleReview && decisionDraft) {
      reviewHeading.current?.focus({ preventScroll: true });
      if (modal.current) modal.current.scrollTop = 0;
    } else (visibleReview ? cancel.current : modal.current?.querySelector<HTMLElement>('select, input, textarea'))?.focus();
  }, [modalActive, !!visibleReview]);
  function queueFocus(target: HTMLElement) { restoreAfterSend.current = { target, record, variant }; }
  function close() {
    if (current() && !sending.current) {
      if (draft) queueFocus(draft.trigger);
      setReview(null); setDraft(null);
    }
  }
  function open(action: RestitutionAction, trigger: HTMLElement) {
    if (!current() || !line || !snapshot || hook.busy || masked || sending.current) return;
    const pin = hook.review(action); if (!pin) return;
    setMessage(''); setReview(null); setDraft({ action, pin, quantity: '', reason: '', attested: false, trigger,
      capture: { record, snapshot, line } });
  }
  function proposalValid(value: Draft) {
    const captured = value.capture;
    if (!current() || hook.busy || masked || sending.current || value.action !== 'propose' || !value.attested
      || decisionOwner(controller.getTransferAuthority())?.account !== record.origin_location_id
      || record !== captured.record || snapshot !== captured.snapshot || variant !== captured.line.variant_id
      || !controller.restitutionRecovery!.eligibility(decisionOwner(controller.getTransferAuthority()), value.pin).eligible) return false;
    try {
      const normalized = normalizeRestitutionProposal({ operation_key: 'capture_validation', variant_id: captured.line.variant_id,
        expected_revision: captured.line.workflow_revision.toString(), retained_quantity: value.quantity,
        reason: value.reason, retained_at_origin: true });
      return normalized.retained_quantity <= balance(captured.line);
    } catch { return false; }
  }
  const proposalCapture = draft?.action === 'propose' && !review ? draft.capture : null;
  const proposalReady = !!draft && proposalValid(draft);
  function prepare() {
    if (!current() || !draft || !line || hook.busy || masked || sending.current || !hook.review(draft.action)) return;
    try {
      // Admission uses the original consent token and pure model validation before randomness.
      if (draft.action === 'propose' && !proposalValid(draft)) return;
      const input = Object.freeze({ variant_id: variant!, operation_key: newTransferRetryKey(), expected_revision: line.workflow_revision.toString(), reason: draft.reason,
        ...(draft.action === 'propose' ? { retained_quantity: draft.quantity, retained_at_origin: true as const } : {}) });
      if (draft.action === 'propose') {
        const normalized = normalizeRestitutionProposal(input as RestitutionProposalInput);
        if (normalized.retained_quantity > line.expected_quantity - line.effective_credit - line.applied_retained_quantity) throw new Error('Exceeds outstanding debit');
      } else normalizeRestitutionDecision(input);
      setReview({ draft: { ...draft }, input, snapshot }); setMessage('');
    } catch { setMessage(draft.action === 'propose'
      ? 'Ingresá una cantidad positiva decimal canónica, un motivo válido y confirmá la retención física en origen. No se enviará nada sin una clave segura.'
      : 'Ingresá un motivo válido para la decisión. No se enviará nada sin una clave segura.'); }
  }
  function editProposal(captured: NonNullable<typeof review>) {
    if (sending.current) return;
    if (!current() || masked || hook.busy || review !== captured || snapshot !== captured.snapshot
      || !proposalValid(captured.draft)) {
      close(); setReview(null); setDraft(null); setMessage('');
      return;
    }
    // Preserve raw capture and original consent, never the prepared transport identity.
    setDraft({ ...captured.draft }); setReview(null); setMessage('');
  }
  async function run(operation: () => Promise<void>) {
    if (!current() || sending.current) return;
    sending.current = true;
    try { await operation(); } catch { if (current()) setMessage('No se pudo verificar el resultado. Consultá la recuperación.'); }
    finally { sending.current = false; }
  }
  const contextHeading = useRef<HTMLHeadingElement>(null);
  const lastEntry = useRef(props.entryFocusKey);
  useEffect(() => {
    if (props.entryFocusKey !== lastEntry.current) {
      lastEntry.current = props.entryFocusKey;
      if (props.entryFocusKey !== undefined && props.contextVisible !== false && !modalActive) contextHeading.current?.focus();
    }
  }, [props.entryFocusKey, props.contextVisible]);
  // Keep action triggers available for existing form/review focus restoration.
  const routineVisible = props.contextVisible !== false || !!draft || !!review || sending.current;
  const sectionVisible = routineVisible || masked || hook.busy || !!hook.error || !!message
    || !line || hook.attempts.length > 0;
  const actions: RestitutionAction[] = decisionOwner(controller.getTransferAuthority())?.account === record.destination_location_id
    ? ['accept', 'reject'] : decisionOwner(controller.getTransferAuthority())?.account === record.origin_location_id ? ['propose'] : [];
  const decisionEvidence = decisionCapture && decisionProposal && <>
    <div className="decision-context"><p>{decisionCapture.record.reference} · {decisionCapture.record.origin_location_name} → {decisionCapture.record.destination_location_name}</p>
      <p>Propuesta de {decisionProposal.initiator_location_id === decisionCapture.record.origin_location_id ? decisionCapture.record.origin_location_name : `Ubicación ${decisionProposal.initiator_location_id}`} · Decisión a cargo de {decisionCapture.record.destination_location_name}</p></div>
    <section aria-label="Propuesta de origen"><h4>Propuesta de origen · Revisión {decisionProposal.revision.toString()}</h4>
      <div className="decision-battery"><p className="decision-product">{decisionItem
        ? `${decisionItem.brand} · ${decisionItem.model} · ${decisionItem.capacity_ah} Ah · ${decisionItem.polarity}` : 'Identidad no disponible'}</p>
        <dl className="decision-counters"><div><dt>Enviadas</dt><dd>{decisionCapture.line.expected_quantity.toString()}</dd></div>
          <div><dt>Crédito efectivo en destino</dt><dd>{decisionCapture.line.effective_credit.toString()}</dd></div>
          <div><dt>Restituido en origen</dt><dd>{decisionCapture.line.applied_retained_quantity.toString()}</dd></div>
          <div><dt>Saldo pendiente</dt><dd>{balance(decisionCapture.line).toString()}</dd></div></dl>
        <p className="decision-quantity">Cantidad retenida propuesta: <strong>{decisionProposal.retained_quantity.toString()} batería(s)</strong></p>
        <p>Propuesta registrada: <TransferDate value={decisionProposal.recorded_at} /></p></div>
      <h4>Motivo original de la propuesta</h4><p className="decision-reason">{decisionProposal.reason}</p>
    </section>
  </>;
  const decisionEffects = decisionCapture && decisionProposal && <div className="decision-effects"><p>{decisionDraft?.action === 'accept'
      ? `Si el servidor valida la aceptación, se acreditarán ${decisionProposal.retained_quantity.toString()} batería(s) en ${decisionCapture.record.origin_location_name} una sola vez como stock disponible. Una aplicación, incluso parcial, cierra esta restitución.`
      : 'Rechazar no mueve stock ni cambia reservas; la propuesta no se aplica.'}</p>
      <p>El stock y el crédito de destino, los conteos y las reservas no cambian. No resuelve automáticamente faltantes ni conteos. El despacho y la recepción original son inmutables.</p></div>;
  function selectVariant(id: number) {
    if (current()) { setDraft(null); setReview(null); setVariant(id); }
  }
  const variantSelector = <div><label htmlFor={selectID}>{proposalCapture ? 'Batería a restituir' : 'Variante de restitución'}</label><select id={selectID} value={variant ?? ''} disabled={hook.busy} onChange={e => selectVariant(Number(e.target.value))}>{(proposalCapture?.record ?? decisionCapture?.record ?? record).items.map(i => <option key={i.variant_id} value={i.variant_id}>{i.brand} · {i.model} · {i.capacity_ah} Ah · {i.polarity}</option>)}</select></div>;
  return <section className={`transfer-restitutions${closed ? ' restitution-is-closed' : ''}`} aria-label="Restituciones de origen" hidden={!sectionVisible}>
    <h2 ref={contextHeading} tabIndex={-1}>Restituciones de origen</h2>
    {masked ? <><p role="status">Restituciones no disponibles para esta sesión.</p><button disabled={hook.busy} onClick={() => { if (current()) void run(hook.recover); }}>Consultar recuperación autorizada</button></> : <>
      <div className="workflow-routine" hidden={!routineVisible}>
      <p className="restitution-helper">El faltante no prueba retención. Proponer no mueve stock.</p>
      </div>
      {/* Consultation is recovery too; it must not depend on routine selection. */}
      <div className="workflow-routine" hidden={!sectionVisible}>
      <div className="restitution-consultation"><p>Variante seleccionada: {selectedItem?.brand} · {selectedItem?.model} · {selectedItem?.capacity_ah} Ah · {selectedItem?.polarity}. Seleccioná otro producto en la tabla; después consultá para habilitar su revisión.</p><button ref={consultation} disabled={hook.busy} onClick={() => { if (current()) void run(hook.refresh); }}>Consultar para revisar restitución</button></div>
      </div>
      {hook.busy && <p role="status">Consultando o enviando restitución…</p>}
      {hook.error && <p role="alert">No se pudo verificar la restitución. Consultá el estado antes de enviar.</p>}
      {message && <p role="alert">{message}</p>}
      {!line && !hook.busy && <p role="status">Evidencia de restitución no disponible.</p>}
      <div className="workflow-routine" hidden={!routineVisible}>
      {snapshot && <table className="restitution-management" aria-label="Gestión de restituciones">
        <thead><tr><th scope="col">Producto</th><th scope="col">Enviadas</th>
          <th scope="col">Crédito efectivo en destino</th><th scope="col">Restitución aplicada en origen</th>
          <th scope="col">Máximo a proponer</th><th scope="col">Historial</th><th scope="col">Acción</th></tr></thead>
        {record.items.map(item => {
          const evidence = !hook.busy ? snapshot.lines.find(l => l.variant_id === item.variant_id) : undefined;
          const pending = evidence?.proposals.find(p => p.state === 'pending' && p.revision === evidence.workflow_revision);
          const historyID = `${disclosureID}-${item.variant_id}`;
          const identity = `${item.brand} · ${item.model} · ${item.capacity_ah} Ah · ${item.polarity}`;
          const selected = item.variant_id === variant;
          return <tbody key={item.variant_id} aria-label={identity}><tr>
            <th scope="row">{identity}{evidence && evidence.applied_revision > 0n && <span className="restitution-closed">Restitución cerrada</span>}</th>
            <td data-label="Enviadas">{item.quantity.toString()}</td>
            <td data-label="Crédito efectivo en destino">{evidence?.effective_credit.toString() ?? 'No disponible'}</td>
            <td data-label="Restitución aplicada en origen">{evidence?.applied_retained_quantity.toString() ?? 'No disponible'}</td>
            <td data-label="Máximo a proponer">{evidence ? balance(evidence).toString() : 'No disponible'}</td>
            <td data-label="Historial">{evidence ? evidence.proposals.length ? <button aria-expanded={!!expanded[item.variant_id]} aria-controls={historyID}
              aria-label={`Historial completo · ${evidence.proposals.length} propuesta(s)`} onClick={() => toggleHistory(item.variant_id)}>{evidence.proposals.length} propuesta(s)</button>
              : 'Sin propuestas de restitución.' : 'No disponible'}</td>
            <td data-label="Acción">{selected ? <div className="restitution-actions">{actions.map(action =>
              <button key={action} disabled={hook.busy || !hook.review(action)} onClick={e => open(action, e.currentTarget)}>{labels[action]}</button>)}</div>
              : <button disabled={hook.busy} aria-label={`Seleccionar ${identity}`} onClick={() => selectVariant(item.variant_id)}>Seleccionar producto</button>}</td>
          </tr>
          {pending && <tr className="restitution-pending"><td colSpan={7}>
            <p className="restitution-pending-title">{decisionOwner(controller.getTransferAuthority())?.location === record.origin_location_id
              ? `Esperando revisión de ${record.destination_location_name}`
              : `Propuesta de ${record.origin_location_name} · Requiere revisión en ${record.destination_location_name}`}</p>
            <p>Cantidad retenida propuesta: <strong>{pending.retained_quantity.toString()} batería(s)</strong></p>
            <p>Restitución aplicada en origen: {evidence!.applied_retained_quantity.toString()} batería(s). La propuesta todavía no se aplica.</p>
            <p>{record.origin_location_name} declara que estas {pending.retained_quantity.toString()} batería(s) permanecen físicamente en origen.</p>
            <p className="restitution-evidence">{pending.reason}</p>
          </td></tr>}
          {!!evidence?.proposals.length && <tr id={historyID} hidden={!expanded[item.variant_id]} className="restitution-history"><td colSpan={7}>
            <ol>{evidence.proposals.map(p => <li key={p.revision.toString()}>
              <p>{states[p.state]} · Propuesta {p.revision.toString()} · {p.retained_quantity.toString()} batería(s) · <TransferDate value={p.recorded_at} /></p>
              <details><summary>Ver detalle de propuesta {p.revision.toString()}</summary>
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
                    {snapshot.operations.filter(o => o.operation_key === p.application!.operation_key && o.action === 'accept').map(o => <p key={o.operation_key}>Existencias de origen registradas: {o.source_existing_before?.toString() ?? 'No disponible'} → {o.source_existing_after?.toString() ?? 'No disponible'}</p>)}
                  </details></section>}
              </details>
            </li>)}</ol>
          </td></tr>}
          </tbody>;
        })}
      </table>}
      {line && !hook.busy && <details className="restitution-originals"><summary>Registros originales de la variante seleccionada</summary>
        <dl><dt>Despacho original</dt><dd>{line.expected_quantity.toString()}</dd>
          <dt>Recepción original (cantidad física)</dt><dd>{receipt?.actual_quantity.toString() ?? 'No disponible'}</dd>
          <dt>Crédito original en destino</dt><dd>{line.original_credit.toString()}</dd></dl>
      </details>}
      <details className="restitution-rules"><summary>¿Cómo funciona la restitución de origen?</summary>
        <p>El máximo es capacidad matemática: enviadas menos crédito efectivo en destino menos restitución aplicada. No confirma retención física ni inventario disponible.</p>
        <p>Proponer o rechazar no mueve stock. Aceptar acredita existencias en origen una sola vez; destino, conteos y reservas no cambian.</p>
        <p>{record.origin_location_name} debe declarar la retención física; {record.destination_location_name} revisa la propuesta. Las acciones habilitadas abren motivo y revisión, no ejecutan cambios directos.</p>
        <p>Una consulta no garantiza que una acción esté habilitada: también debe cumplir las condiciones vigentes de la transferencia.</p>
        <p><span>Una aplicación, incluso parcial, cierra esta restitución.</span>{' '}El despacho y la recepción original son inmutables.</p>
      </details>
      </div>
      {hook.attempts.map(a => <article className="restitution-card" key={a.payload.operation_key} aria-label={`Recuperación de restitución ${a.payload.variant_id}`}>
        <h3>Operación {a.phase}</h3><p>{labels[a.action]} · Variante {a.payload.variant_id} · Cuenta {a.owner.account} · Revisión {a.payload.expected_revision.toString()} · Clave {a.payload.operation_key}</p>
        <p className="restitution-evidence">Motivo capturado: {a.payload.reason}</p>
        {'retained_quantity' in a.payload && <p>Retenidas: {a.payload.retained_quantity.toString()} · Retención física atestada</p>}
        {a.priorUncertainty && a.phase !== 'confirmed' && <p>Resultado incierto. No crees otra operación para esta variante.</p>}
        <div className="restitution-actions"><button disabled={hook.busy} onClick={() => { if (current()) void run(hook.recover); }}>Consultar resultado de restitución</button>
          {(a.phase === 'uncertain' || a.phase === 'conflict') && <button disabled={hook.busy} onClick={() => { if (current()) void run(() => hook.retry(a.payload.variant_id)); }}>Reintentar carga exacta</button>}</div>
      </article>)}
      {modalActive && <div className="restitution-backdrop"><div ref={modal} className={`restitution-modal${proposalCapture ? ' restitution-proposal-capture' : proposalReview ? ' restitution-proposal-review' : decisionDraft ? ` restitution-decision restitution-decision-${visibleReview ? 'review' : 'capture'}` : ''}`} role="dialog" aria-modal="true" aria-labelledby={headingID} tabIndex={-1} onKeyDown={e => {
        if (e.key === 'Escape' && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); close(); }
        if (e.key === 'Tab') {
          const available = controls(); const first = available[0]; const last = available.at(-1);
          if (!first) { e.preventDefault(); modal.current?.focus(); }
          else if (e.shiftKey && (document.activeElement === first || document.activeElement === modal.current
            || ((proposalReview || decisionDraft) && document.activeElement === reviewHeading.current))) { e.preventDefault(); last?.focus(); }
          else if (!e.shiftKey && (document.activeElement === last || document.activeElement === modal.current
            || ((proposalReview || decisionDraft) && document.activeElement === reviewHeading.current))) { e.preventDefault(); first.focus(); }
        }
      }}><h3 id={headingID} ref={reviewHeading} tabIndex={proposalReview || decisionDraft && visibleReview ? -1 : undefined}>{proposalReview ? 'Revisar propuesta de restitución' : visibleReview ? decisionTitle : proposalCapture ? 'Proponer restitución de origen' : labels[draft.action]}</h3>
      {proposalCapture && <form className="restitution-form" aria-label="Editar restitución" onSubmit={e => { e.preventDefault(); prepare(); }}>
        <div className="proposal-context"><p>{proposalCapture.record.reference} · {proposalCapture.record.origin_location_name} → revisión de {proposalCapture.record.destination_location_name}</p>
          <p>Solo para unidades que permanecen físicamente en {proposalCapture.record.origin_location_name}.</p></div>
        <div className="proposal-battery">{variantSelector}
          <div className="proposal-counters"><span>Enviadas: <strong>{proposalCapture.line.expected_quantity.toString()}</strong></span>{' '}
            <span>Crédito efectivo en destino: <strong>{proposalCapture.line.effective_credit.toString()}</strong></span>{' '}
            <span>Restituido en origen: <strong>{proposalCapture.line.applied_retained_quantity.toString()}</strong></span></div>
          <p>Máximo a proponer: <strong>{balance(proposalCapture.line).toString()} batería(s)</strong> (según balance de transferencia)</p></div>
        <div><label htmlFor={quantityID}>Cantidad retenida en origen *</label>
          <input id={quantityID} inputMode="numeric" required placeholder="Ingresá la cantidad retenida" value={draft.quantity} onChange={e => setDraft({ ...draft, quantity: e.target.value })} />
          <p>Cantidad positiva, hasta {balance(proposalCapture.line).toString()} batería(s) en este caso.</p></div>
        <div><label htmlFor={reasonID}>Motivo de restitución (obligatorio) *</label>
          <textarea id={reasonID} required placeholder="Explicá por qué estas unidades permanecen en origen" value={draft.reason} onChange={e => setDraft({ ...draft, reason: e.target.value })} /></div>
        <div className="proposal-attestation"><label htmlFor={attestationID}><input id={attestationID} type="checkbox" required checked={draft.attested} onChange={e => setDraft({ ...draft, attested: e.target.checked })} />Confirmo que estas unidades permanecen físicamente en origen</label>
          <p>El faltante en destino no prueba retención en origen.</p></div>
        <div className="proposal-effects"><p>Enviar la propuesta no mueve stock ni cambia reservas.</p>
          <p>Si {proposalCapture.record.destination_location_name} la acepta y se valida, se acreditarán en {proposalCapture.record.origin_location_name} las unidades propuestas; destino y reservas no cambian.</p>
          <p>Una aplicación, incluso parcial, cierra esta restitución. No resuelve automáticamente faltantes ni conteos. El despacho y la recepción original se conservan.</p></div>
        {message && <p role="alert">{message}</p>}
        <footer><button type="button" onClick={close}>Cancelar</button><button type="submit" disabled={!proposalReady}>Revisar restitución</button></footer>
      </form>}
      {draft && !review && draft.action !== 'propose' && <form className="restitution-form" aria-label="Editar restitución" onSubmit={e => { e.preventDefault(); prepare(); }}>
        {variantSelector}
        {decisionEvidence}
        {message && <p role="alert">{message}</p>}
        <label htmlFor={reasonID}>{draft.action === 'accept' ? 'Motivo de aceptación (obligatorio)' : 'Motivo de rechazo (obligatorio)'}</label><textarea id={reasonID} required value={draft.reason} onChange={e => setDraft({ ...draft, reason: e.target.value })} />
        {decisionEffects}
        <footer><button type="button" onClick={close}>Cancelar</button><button type="submit">Revisar restitución</button></footer>
      </form>}
      {proposalReview && <div className="restitution-proposal-review-body">
        <div className="review-context"><p>{proposalReview.capture.record.reference} · Propuesta de {proposalReview.capture.record.origin_location_name}</p>
          <p>Revisión a cargo de {proposalReview.capture.record.destination_location_name}</p></div>
        <section aria-label="Batería a restituir"><h4>Batería a restituir</h4>
          <div className="review-battery"><p className="review-product">{reviewedItem
            ? `${reviewedItem.brand} · ${reviewedItem.model} · ${reviewedItem.capacity_ah} Ah · ${reviewedItem.polarity}`
            : `Variante ${proposalReview.capture.line.variant_id} · Identidad no disponible`}</p>
            <div className="review-counters"><span>Enviadas: <strong>{proposalReview.capture.line.expected_quantity.toString()}</strong></span>
              <span>Crédito efectivo en destino: <strong>{proposalReview.capture.line.effective_credit.toString()}</strong></span>
              <span>Restituido en origen: <strong>{proposalReview.capture.line.applied_retained_quantity.toString()}</strong></span></div>
            <p className="review-quantity"><span>Cantidad retenida propuesta</span><strong>{proposalReview.input.retained_quantity} batería(s)</strong></p>
          </div>
        </section>
        <section aria-label="Motivo de restitución"><h4>Motivo de restitución</h4>
          <p className="review-reason">{proposalReview.input.reason}</p></section>
        {proposalReview.attested && <div className="review-attestation"><span aria-hidden="true">✓</span><div>
          <p>Confirmaste que estas unidades permanecen físicamente en {proposalReview.capture.record.origin_location_name}.</p>
          <p>El faltante en destino no prueba retención en origen.</p></div></div>}
        <div className="review-effects"><p>Enviar la propuesta no mueve stock ni cambia reservas.</p>
          <p>Si {proposalReview.capture.record.destination_location_name} la acepta y se valida, se acreditarán en {proposalReview.capture.record.origin_location_name} {proposalReview.input.retained_quantity} batería(s). Destino y reservas no cambian.</p>
          <p>Una aplicación, incluso parcial, cierra esta restitución. No resuelve automáticamente faltantes ni conteos. El despacho y la recepción original son inmutables.</p></div>
      </div>}
      {visibleReview && <>{!proposalReview && <div className="restitution-decision-body">
        {decisionEvidence}
        <section aria-label="Motivo de decisión"><h4>Motivo de decisión</h4><p className="decision-reason">{visibleReview.input.reason}</p></section>
        {decisionEffects}
      </div>}<footer><button ref={cancel} onClick={() => {
        if (visibleReview.draft.action === 'propose') editProposal(visibleReview); else close();
      }}>{visibleReview.draft.action === 'propose' ? 'Editar datos' : 'Cancelar'}</button><button onClick={() => {
        if (!current() || hook.busy || sending.current || snapshot !== visibleReview.snapshot) return;
        const captured = visibleReview; queueFocus(captured.draft.trigger); setReview(null); setDraft(null);
        void run(() => hook.submit(captured.draft.pin, captured.input));
      }}>{proposalReview ? 'Enviar propuesta' : confirms[visibleReview.draft.action]}</button></footer></>}
      <button className="restitution-modal-close" aria-label="Cerrar restitución" disabled={sending.current} onClick={close}>×</button>
      </div></div>}
    </>}
  </section>;
}
