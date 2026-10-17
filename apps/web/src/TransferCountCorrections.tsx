import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { isTransferFocusTarget } from './transferModalFocus';
import './transfer-count-corrections.css';
import TransferDate from './TransferDate';
import { newTransferRetryKey, type TransferRecord } from './transferModel';
import type { TransferController } from './useInventory';
import type { useTransferCountCorrections } from './useTransferCountCorrections';
import { decisionOwner } from './transferDecisionRecovery';
import { sameCountOwner } from './transferCountCorrectionRecovery';
import { normalizeCountDecision, normalizeCountProposal, type CountAction, type CountCorrectionLine,
  type CountDecisionInput, type CountProposalInput } from './transferCountCorrectionModel';

/** C4b owns hook mounting and must pass its exact selected request and enablement. */
export interface TransferCountCorrectionsProps {
  record: TransferRecord;
  controller: TransferController;
  corrections: ReturnType<typeof useTransferCountCorrections>;
  requestID: string | null;
  enabled?: boolean;
  contextVisible?: boolean;
  entryFocusKey?: number;
}
const states = { pending: 'Pendiente', superseded: 'Reemplazada', rejected: 'Rechazada', applied: 'Aplicada' };
const actions = { propose: 'Proponer', accept: 'Aceptar', reject: 'Rechazar' };
const phases = { inFlight: 'En curso', uncertain: 'Resultado incierto', failed: 'Fallo definitivo', conflict: 'Conflicto', confirmed: 'Confirmada' };
const signed = (n: bigint) => n > 0n ? `+${n}` : n.toString();
const isMasked = (corrections: TransferCountCorrectionsProps['corrections']) => corrections.masked
  || corrections.error?.status === 403 || corrections.error?.status === 404;
const authorityKey = (controller: TransferController) => {
  const owner = decisionOwner(controller.getTransferAuthority());
  return owner ? JSON.stringify(owner) : '';
};
// useInventory returns fresh wrappers; only these stable seams own authority.
const controllerSeams = (controller: TransferController) => [controller.getTransferAuthority,
  controller.subscribeTransferInvalidation, controller.settleUnauthorized,
  controller.confirmTransferCountCorrection, controller.countCorrectionRecovery] as const;
function eligible(props: TransferCountCorrectionsProps) {
  const { record, requestID, enabled = true, controller } = props;
  const owner = decisionOwner(controller.getTransferAuthority());
  return enabled && record.status === 'received' && requestID === record.id && !!owner
    && (owner.location === record.origin_location_id || owner.location === record.destination_location_id);
}

// Remount private local state on every authority/selection transition, including
// transitions observed by an invalidation callback before React next renders.
export default function TransferCountCorrections(props: TransferCountCorrectionsProps) {
  const [, update] = useState(0);
  const latest = useRef(props); latest.current = props;
  const authority = authorityKey(props.controller);
  const boundary = useRef({ authority, seams: controllerSeams(props.controller),
    record: props.record, status: props.record.status, requestID: props.requestID,
    enabled: props.enabled, masked: isMasked(props.corrections), serial: 0 });
  function synchronize() {
    const p = latest.current; const b = boundary.current;
    const authority = authorityKey(p.controller); const seams = controllerSeams(p.controller);
    if (b.authority !== authority || b.seams.some((seam, index) => seam !== seams[index])
      || b.record !== p.record || b.status !== p.record.status || b.requestID !== p.requestID
      || b.enabled !== p.enabled || b.masked !== isMasked(p.corrections)) {
      boundary.current = { authority, seams, record: p.record, status: p.record.status, requestID: p.requestID,
        enabled: p.enabled, masked: isMasked(p.corrections), serial: b.serial + 1 };
    }
  }
  synchronize();
  useEffect(() => props.controller.subscribeTransferInvalidation(() => {
    synchronize(); update(n => n + 1);
  }), [props.controller.getTransferAuthority, props.controller.subscribeTransferInvalidation,
    props.controller.settleUnauthorized, props.controller.confirmTransferCountCorrection,
    props.controller.countCorrectionRecovery, authority]);
  if (!eligible(props)) return null;
  const serial = boundary.current.serial;
  return <CorrectionSection key={serial} {...props}
    isBoundaryCurrent={() => { synchronize(); return serial === boundary.current.serial; }} />;
}
interface Draft {
  variant: number; action: CountAction; quantity: string; reason: string; trigger: HTMLElement;
}
interface Review {
  draft: Draft; snapshot: NonNullable<TransferCountCorrectionsProps['corrections']['snapshot']>;
  input: CountProposalInput | CountDecisionInput; actual: bigint; revision: bigint; base: bigint; credit: bigint; delta: bigint;
}
function CorrectionSection(props: TransferCountCorrectionsProps & { isBoundaryCurrent: () => boolean }) {
  const { record, controller, corrections } = props;
  const owner = decisionOwner(controller.getTransferAuthority());
  const boundOwner = useRef(owner);
  const latest = useRef(props); latest.current = props;
  const mounted = useRef(false); const submitting = useRef(false);
  const restoreAfterSend = useRef<HTMLElement | null>(null);
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [message, setMessage] = useState('');
  const dialog = useRef<HTMLDivElement>(null); const cancelButton = useRef<HTMLButtonElement>(null);
  const headingID = useId(); const quantityID = useId(); const reasonID = useId();
  const snapshot = corrections.snapshot;
  const masked = isMasked(corrections);
  const validSnapshot = !masked && snapshot?.request_id.toString() === record.id ? snapshot : null;
  const recoveryVariant = record.status === 'received' ? record.receipt.items[0]?.variant_id : undefined;
  const attempts = masked ? [] : corrections.attempts.filter(a => a.requestID.toString() === record.id && sameCountOwner(a.owner, owner));
  const visibleReview = review && validSnapshot === review.snapshot ? review : null;
  function current() {
    const p = latest.current;
    return mounted.current && p.isBoundaryCurrent() && eligible(p)
      && sameCountOwner(boundOwner.current, decisionOwner(p.controller.getTransferAuthority()))
      && !p.corrections.masked && p.corrections.error?.status !== 403 && p.corrections.error?.status !== 404;
  }
  function lineFor(variant: number) {
    return latest.current.corrections.snapshot?.lines.find(l => l.variant_id === variant
      && latest.current.record.status === 'received' && latest.current.record.receipt.items.some(i => i.variant_id === variant));
  }
  function blocked(variant: number) {
    return latest.current.corrections.attempts.some(a => a.payload.variant_id === variant
      && (a.phase === 'inFlight' || a.phase !== 'confirmed' && a.priorUncertainty));
  }
  function allowed(line: CountCorrectionLine, action: CountAction) {
    if (blocked(line.variant_id)) return false;
    const pending = line.proposals.find(p => p.state === 'pending');
    const location = decisionOwner(controller.getTransferAuthority())?.location;
    return action === 'propose' ? !pending || pending.initiator_location_id === location
      : !!pending && pending.revision === line.workflow_revision && pending.initiator_location_id !== location;
  }
  function name(variant: number) {
    const item = record.items.find(i => i.variant_id === variant);
    return item ? `${item.brand} · ${item.model} · ${item.capacity_ah} Ah · ${item.polarity}` : `Variante inesperada ${variant}`;
  }
  function location(id: number) {
    return id === record.origin_location_id ? record.origin_location_name
      : id === record.destination_location_id ? record.destination_location_name : `Ubicación ${id}`;
  }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const modalActive = !!draft && !!validSnapshot;
  const focusableControls = () => Array.from(dialog.current?.querySelectorAll<HTMLElement>(
    'input:not([type="hidden"]), select, textarea, button, a[href], [tabindex]') ?? [])
    .filter(control => isTransferFocusTarget(control) && control.tabIndex >= 0
      && !control.closest('[hidden], [inert], [aria-hidden="true"]'));
  // One isolation lifetime spans capture and review; restore before returning focus.
  useLayoutEffect(() => {
    const backdrop = dialog.current?.parentElement;
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
        if (value === null) element.removeAttribute('inert');
        else element.setAttribute('inert', value);
      }
    };
  }, [modalActive]);
  useLayoutEffect(() => {
    const target = restoreAfterSend.current;
    if (modalActive || sending || !target) return;
    restoreAfterSend.current = null;
    if (!current()) return;
    const fallback = contextHeading.current;
    if (isTransferFocusTarget(target) && !target.closest('[hidden], [inert]')) target.focus();
    else if (isTransferFocusTarget(fallback) && !fallback.closest('[hidden], [inert]')) fallback.focus();
  });
  useLayoutEffect(() => {
    if (modalActive) (visibleReview ? cancelButton.current : focusableControls()[0])?.focus();
  }, [modalActive, !!visibleReview]);
  useEffect(() => {
    if (review && !visibleReview) { setReview(null); setDraft(null); setMessage('El conteo cambió. Revisá nuevamente antes de confirmar.'); }
  }, [review, visibleReview]);
  // A form is private too: clearing it on a mask cannot resurrect its contents
  // when explicit recovery later unmasks the same authority.
  useEffect(() => { if (masked) { setDraft(null); setReview(null); setMessage(''); } }, [masked]);
  function open(variant: number, action: CountAction, trigger: HTMLElement) {
    const line = lineFor(variant);
    if (!current() || !line || !allowed(line, action) || submitting.current) return;
    setMessage(''); setReview(null);
    setDraft({ variant, action, quantity: action === 'propose' ? '' : line.proposals.find(p => p.state === 'pending')!.actual_quantity.toString(), reason: '', trigger });
  }
  function prepare() {
    if (!current() || !draft || submitting.current) return;
    const line = lineFor(draft.variant); const snap = latest.current.corrections.snapshot;
    if (!line || !snap || snap.request_id.toString() !== record.id || !allowed(line, draft.action)) return;
    try {
      // Generate once per explicitly reviewed new submission; failure sends nothing.
      const operation_key = newTransferRetryKey();
      const pending = line.proposals.find(p => p.state === 'pending');
      const input = Object.freeze({ variant_id: draft.variant, operation_key,
        expected_revision: (draft.action === 'propose' ? line.workflow_revision : pending!.revision).toString(), reason: draft.reason,
        ...(draft.action === 'propose' ? { actual_quantity: draft.quantity } : {}) });
      let actual: bigint;
      if (draft.action === 'propose') actual = normalizeCountProposal(input as CountProposalInput).actual_quantity;
      else { normalizeCountDecision(input); actual = pending!.actual_quantity; }
      const item = record.items.find(i => i.variant_id === draft.variant);
      const credit = item ? (actual < item.quantity ? actual : item.quantity) : 0n;
      setReview({ draft: { ...draft }, snapshot: snap, input, actual,
        revision: draft.action === 'propose' ? line.workflow_revision + 1n : pending!.revision,
        base: draft.action === 'propose' ? line.applied_revision : pending!.base_revision,
        credit, delta: draft.action === 'reject' || !item ? 0n : credit - line.effective_credit });
      setMessage('');
    } catch { setMessage('Ingresá cantidad decimal canónica entre 0 y 9223372036854775807 y un motivo válido. Si no se puede crear una clave segura, no se enviará nada.'); }
  }
  async function run(operation: () => Promise<void>) {
    if (!current() || submitting.current) return;
    submitting.current = true; setSending(true);
    try { await operation(); }
    catch { if (current()) setMessage('No se pudo confirmar el resultado. Consultá la recuperación antes de volver a enviar.'); }
    finally { submitting.current = false; if (current()) setSending(false); }
  }
  function submit(captured: Review) {
    const p = latest.current; const line = lineFor(captured.draft.variant);
    if (!current() || submitting.current || p.corrections.busy || p.corrections.snapshot !== captured.snapshot
      || review !== captured || !line || !allowed(line, captured.draft.action)
      || line.workflow_revision.toString() !== (captured.draft.action === 'propose'
        ? captured.input.expected_revision : captured.revision.toString())) {
      if (current()) { setReview(null); setDraft(null); setMessage('El conteo cambió. Revisá nuevamente antes de confirmar.'); }
      return;
    }
    restoreAfterSend.current = captured.draft.trigger;
    void run(() => {
      setReview(null); setDraft(null);
      return captured.draft.action === 'propose' ? p.corrections.propose(captured.input as CountProposalInput)
        : p.corrections.decide(captured.draft.action, captured.input);
    });
  }
  function close() {
    if (!current() || submitting.current || latest.current.corrections.busy) return;
    restoreAfterSend.current = draft?.trigger ?? null;
    setReview(null); setDraft(null);
  }
  const contextHeading = useRef<HTMLHeadingElement>(null);
  const lastEntry = useRef(props.entryFocusKey);
  useEffect(() => {
    if (props.entryFocusKey !== lastEntry.current) {
      lastEntry.current = props.entryFocusKey;
      if (props.entryFocusKey !== undefined && props.contextVisible !== false && !modalActive) contextHeading.current?.focus();
    }
  }, [props.entryFocusKey, props.contextVisible]);
  // Presentation never participates in the private authority boundary.
  const routineVisible = props.contextVisible !== false || !!draft || !!review || sending;
  const sectionVisible = routineVisible || masked || corrections.busy || !!corrections.error
    || !validSnapshot || !!message || attempts.length > 0;
  const privateLines = validSnapshot?.lines.filter(line => record.status === 'received'
    && record.receipt.items.some(i => i.variant_id === line.variant_id)) ?? [];
  return <section className="count-corrections" aria-label="Correcciones de conteo" hidden={!sectionVisible}>
    <h2 ref={contextHeading} tabIndex={-1}>Correcciones de conteo</h2>
    <p hidden={!routineVisible}>La recepción original es inmutable. La solicitud sigue Recibida; estas correcciones conservan su evidencia original.</p>
    {masked ? <div className="count-recovery"><p role="status">Correcciones no disponibles para esta sesión.</p>
      <button disabled={sending || corrections.busy || recoveryVariant === undefined} onClick={() => {
        if (!mounted.current || !latest.current.isBoundaryCurrent() || !eligible(latest.current)
          || submitting.current || recoveryVariant === undefined) return;
        // Authorized explicit GET only; do not unmask locally or retry a write.
        submitting.current = true; setSending(true);
        void latest.current.corrections.recover(recoveryVariant).catch(() => {}).finally(() => {
          submitting.current = false; if (mounted.current) setSending(false);
        });
      }}>Consultar recuperación autorizada</button></div> : <>
      {corrections.busy && <p role="status">Consultando o enviando correcciones…</p>}
      {corrections.error && <p role="alert">No se pudo verificar el conteo con el servidor. Consultá el estado antes de enviar.</p>}
      {!validSnapshot && <p role="status">Conteo no disponible.</p>}
      {message && !modalActive && <p role="alert">{message}</p>}
      <div className="workflow-routine" hidden={!routineVisible}>
      {validSnapshot && <h3>Conteo efectivo confirmado</h3>}
      {privateLines.map(line => {
        const unexpected = !record.items.some(i => i.variant_id === line.variant_id);
        const pending = line.proposals.find(p => p.state === 'pending');
        const applied = line.proposals.find(p => p.revision === line.applied_revision && p.state === 'applied')?.application;
        return <article className="count-card" key={line.variant_id} aria-label={name(line.variant_id)}>
          <h4>{name(line.variant_id)}</h4>
          <dl className="count-metrics"><div><dt>Cantidad efectiva</dt><dd>{line.effective_actual.toString()}</dd></div>
            <div><dt>Crédito efectivo de esta recepción</dt><dd>{line.effective_credit.toString()}</dd></div></dl>
          {applied && <p className="count-outcome">Efecto aplicado en destino: {signed(applied.delta)}</p>}
          {unexpected && <p>Solo auditoría: crédito y efecto en stock cero. La procedencia e incorporación se resuelven por separado.</p>}
          <div className="count-actions">
            {allowed(line, 'propose') && <button disabled={sending} onClick={e => open(line.variant_id, 'propose', e.currentTarget)}>{pending ? 'Reemplazar propuesta' : 'Proponer corrección'}</button>}
            {allowed(line, 'accept') && <><button disabled={sending} onClick={e => open(line.variant_id, 'accept', e.currentTarget)}>Aceptar revisión {pending!.revision.toString()}</button>
              <button disabled={sending} onClick={e => open(line.variant_id, 'reject', e.currentTarget)}>Rechazar revisión {pending!.revision.toString()}</button></>}
          </div>
          <details className="count-technical">
            <summary>Evidencia técnica del conteo</summary>
            <dl className="count-revisions"><div><dt>Revisión de flujo</dt><dd>{line.workflow_revision.toString()}</dd></div>
              <div><dt>Revisión aplicada</dt><dd>{line.applied_revision.toString()}</dd></div></dl>
          </details>
          <h5>Historial completo</h5>
          {!line.proposals.length && <p>Sin correcciones anteriores.</p>}
          <ol className="count-history">{line.proposals.map(p => <li key={p.revision.toString()}>
            <p><strong>{states[p.state]} · Revisión {p.revision.toString()}</strong> · Cantidad {p.actual_quantity.toString()}</p>
            <p>Iniciador {location(p.initiator_location_id)} · <TransferDate value={p.recorded_at} /></p>
            <p className="count-evidence">Motivo: {p.reason}</p>
            {p.decision && <><p>{p.decision.accepted ? 'Aceptada' : 'Rechazada'} por {location(p.decision.actor_location_id)} · <TransferDate value={p.decision.recorded_at} /></p>
              <p className="count-evidence">Motivo de decisión: {p.decision.reason}</p></>}
            {p.application && <p>Aplicación: crédito {p.application.effective_credit.toString()} · Efecto {signed(p.application.delta)} · <TransferDate value={p.application.recorded_at} /></p>}
            <details className="count-technical">
              <summary>Evidencia técnica de revisión {p.revision.toString()}</summary>
              <p>Base {p.base_revision.toString()} · Crédito base {p.base_credit.toString()}</p>
              <p>Clave {p.operation_key}</p>
              {p.decision && <p>Clave de decisión {p.decision.operation_key}</p>}
            </details>
          </li>)}</ol>
        </article>;
      })}
      </div>
      {attempts.map(a => <article className="count-recovery" key={a.payload.variant_id} aria-label={`Recuperación ${a.payload.variant_id}`}>
        <h3>{phases[a.phase]} · {name(a.payload.variant_id)}</h3>
        <p>{actions[a.action]} · Actor {location(a.owner.location)}</p>
        <p>Cantidad capturada: {'actual_quantity' in a.payload ? a.payload.actual_quantity.toString() : 'No enviada (decisión)'}</p>
        <p className="count-evidence">Motivo capturado: {a.payload.reason}</p>
        <details className="count-technical">
          <summary>Evidencia técnica de recuperación</summary>
          <p>Clave {a.payload.operation_key} · Revisión exacta {a.payload.expected_revision.toString()}</p>
          <p>Actor {location(a.owner.location)} · Cuenta {a.owner.account}</p>
        </details>
        {a.priorUncertainty && a.phase !== 'confirmed' && <p>Resultado aún incierto. No crees otra propuesta para esta línea.</p>}
        {a.phase === 'failed' && !a.priorUncertainty && <p>No se confirmó esta operación. Podés revisar una nueva propuesta explícita.</p>}
        <div className="count-actions">
          <button disabled={sending || a.phase === 'inFlight'} onClick={() => { if (current() && latest.current.corrections.attempts.includes(a)) void run(() => latest.current.corrections.recover(a.payload.variant_id)); }}>Consultar resultado</button>
          {(a.phase === 'uncertain' || a.phase === 'conflict') && <button disabled={sending || corrections.busy}
            onClick={() => { if (current() && latest.current.corrections.attempts.includes(a)) void run(() => latest.current.corrections.retry(a.payload.variant_id)); }}>Reintentar carga exacta</button>}
        </div>
      </article>)}
      {modalActive && <div className="count-backdrop"><div ref={dialog} className="count-modal" role="dialog" aria-modal="true" aria-labelledby={headingID} tabIndex={-1}
        onKeyDown={e => {
          if (e.key === 'Escape' && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); close(); }
          if (e.key === 'Tab') {
            const controls = focusableControls();
            const first = controls[0]; const last = controls.at(-1);
            if (!first) { e.preventDefault(); dialog.current?.focus(); }
            else if (e.shiftKey && (document.activeElement === first || !controls.includes(document.activeElement as HTMLElement))) { e.preventDefault(); last?.focus(); }
            else if (!e.shiftKey && (document.activeElement === last || !controls.includes(document.activeElement as HTMLElement))) { e.preventDefault(); first.focus(); }
          }
        }}>
        <h3 id={headingID}>{visibleReview ? 'Revisar corrección de conteo' : 'Capturar corrección de conteo'}</h3>
        {message && <p role="alert">{message}</p>}
      {draft && !review && <form className="count-form" onSubmit={e => { e.preventDefault(); prepare(); }} aria-label="Editar corrección">
        <h3>{actions[draft.action]} · {name(draft.variant)}</h3>
        {draft.action === 'propose' && <><label htmlFor={quantityID}>Cantidad corregida</label><input id={quantityID} type="text" inputMode="numeric"
          value={draft.quantity} onChange={e => setDraft({ ...draft, quantity: e.target.value })} required /></>}
        <label htmlFor={reasonID}>Motivo</label><textarea id={reasonID} value={draft.reason} onChange={e => setDraft({ ...draft, reason: e.target.value })} required />
        <div className="count-actions"><button type="submit" disabled={sending || corrections.busy}>Revisar corrección</button><button type="button" disabled={sending || corrections.busy} onClick={close}>Cancelar</button></div>
      </form>}
      {visibleReview && <>
        <div className="count-modal-body"><p>{name(visibleReview.draft.variant)}</p>
          <p>Cantidad corregida: {visibleReview.actual.toString()} · Revisión: {visibleReview.revision.toString()} · Base aplicada: {visibleReview.base.toString()}</p>
          <p>Revisión de flujo esperada: {visibleReview.input.expected_revision}</p>
          <p>Crédito limitado: {visibleReview.credit.toString()} · Crédito efectivo actual: {lineFor(visibleReview.draft.variant)?.effective_credit.toString()}</p>
          <p>Efecto en destino: {signed(visibleReview.delta)} · Destino: {record.destination_location_name}</p>
          <p className="count-evidence">Motivo exacto: {visibleReview.input.reason}</p>
          {!record.items.some(i => i.variant_id === visibleReview.draft.variant) && <p>Solo auditoría: crédito y efecto cero. Procedencia e incorporación separadas.</p>}
          {visibleReview.draft.action === 'reject' ? <p>Rechazar no tiene efecto en inventario.</p> : <p>Sin restitución al origen, resolución de pérdidas, incorporación de excedentes ni política de entregas posteriores.</p>}
          {visibleReview.draft.action === 'propose' && <p>Una propuesta nueva o reemplazada requiere un nuevo acuerdo de la contraparte; no conserva el consentimiento anterior.</p>}
        </div><footer><button ref={cancelButton} disabled={sending || corrections.busy} onClick={close}>Cancelar</button>
          <button disabled={sending || corrections.busy} onClick={() => submit(visibleReview)}>{visibleReview.draft.action === 'propose' ? 'Confirmar propuesta' : visibleReview.draft.action === 'accept' ? 'Confirmar aceptación' : 'Confirmar rechazo'}</button></footer>
      </>}
        <button className="count-modal-close" aria-label="Cerrar corrección" disabled={sending || corrections.busy} onClick={close}>Cerrar</button>
      </div></div>}
    </>}
  </section>;
}
