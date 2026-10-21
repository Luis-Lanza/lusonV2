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
function countRevisions(line: CountCorrectionLine) {
  return <dl className="count-revisions"><div><dt>Revisión de flujo</dt><dd>{line.workflow_revision.toString()}</dd></div>
    <div><dt>Revisión aplicada</dt><dd>{line.applied_revision.toString()}</dd></div></dl>;
}
function countTechnical(line: CountCorrectionLine) {
  return <details className="count-technical"><summary>Evidencia técnica del conteo</summary>{countRevisions(line)}</details>;
}
interface Draft {
  variant: number; action: CountAction; quantity: string; reason: string; trigger: HTMLElement;
}
interface Consultation {
  variant: number; trigger: HTMLElement;
  snapshot: NonNullable<TransferCountCorrectionsProps['corrections']['snapshot']>;
  pending: CountCorrectionLine['proposals'][number];
  workflow: bigint; applied: bigint; currentActual: bigint; currentCredit: bigint;
  credit: bigint; delta: bigint;
  reasons: { accept: string; reject: string };
}
function CounterpartyContext({ pin, reference, battery, sent, proposer, reviewer, destination, unexpected, decision = false }: {
  pin: Consultation; reference: string; battery: string; sent: bigint;
  proposer: string; reviewer: string; destination: string; unexpected: boolean; decision?: boolean;
}) {
  return <div className={decision ? 'count-decision-context' : 'count-modal-body count-consultation-body'}>
    <div><p>{reference} · Propuesta de {proposer}</p><p className="count-review-muted">{decision ? `Decisión de ${reviewer}` : `${reviewer} debe revisar esta propuesta.`}</p></div>
    <div className="count-review-battery"><div><p className="count-review-label">Batería a corregir</p><strong>{battery}</strong></div><span>Enviadas: {sent.toString()}</span></div>
    <table className="count-review-comparison" aria-label="Comparación de conteo">
      <thead><tr><th scope="col">Concepto</th><th scope="col">Vigente confirmado</th><th scope="col">Propuesto</th></tr></thead>
      <tbody><tr><th scope="row">Cantidad recibida</th><td>{pin.currentActual.toString()}</td><td>{pin.pending.actual_quantity.toString()}</td></tr>
        <tr><th scope="row">Crédito de esta recepción</th><td>{pin.currentCredit.toString()}</td><td>{pin.credit.toString()}</td></tr></tbody>
    </table>
    <div><p className="count-review-label">Motivo de {proposer}</p><p className="count-evidence count-review-reason">{pin.pending.reason}</p></div>
    {!decision && <><div className="count-review-warning">
      <p><strong>La propuesta pendiente no modifica el stock.</strong></p>
      <p>Si la aceptás, sujeto a validación: Efecto en destino: {signed(pin.delta)} · {destination}. Crédito limitado: {pin.credit.toString()}.</p>
      <p>Rechazar no modifica el conteo ni el stock. La recepción original se conserva.</p>
      <p>Sin restitución al origen, resolución automática de faltantes ni incorporación de excedentes. El crédito no es inventario actual.</p>
      {unexpected && <p>Solo auditoría: crédito y efecto cero. Procedencia e incorporación separadas.</p>}
    </div>
    <p className="count-review-muted">Ambas opciones requieren un motivo y revisión antes de confirmar.</p></>}
  </div>;
}
interface Review {
  draft: Draft; snapshot: NonNullable<TransferCountCorrectionsProps['corrections']['snapshot']>;
  input: CountProposalInput | CountDecisionInput; actual: bigint; revision: bigint; base: bigint; credit: bigint; delta: bigint;
  currentActual: bigint; currentCredit: bigint;
  decision?: Readonly<{ reference: string; battery: string; sent: bigint; proposer: string; reviewer: string;
    destination: string; origin: string; unexpected: boolean; originalReason: string }>;
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
  const [consultation, setConsultation] = useState<Consultation | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [message, setMessage] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const disclosureID = useId();
  const toggle = (key: string) => setExpanded(value => ({ ...value, [key]: !value[key] }));
  const dialog = useRef<HTMLDivElement>(null); const cancelButton = useRef<HTMLButtonElement>(null);
  const consultationHeading = useRef<HTMLHeadingElement>(null);
  const headingID = useId(); const quantityID = useId(); const reasonID = useId();
  const variantID = useId(); const quantityHelpID = useId();
  const snapshot = corrections.snapshot;
  const masked = isMasked(corrections);
  const validSnapshot = !masked && snapshot?.request_id.toString() === record.id ? snapshot : null;
  const recoveryVariant = record.status === 'received' ? record.receipt.items[0]?.variant_id : undefined;
  const attempts = masked ? [] : corrections.attempts.filter(a => a.requestID.toString() === record.id && sameCountOwner(a.owner, owner));
  const visibleReview = review && validSnapshot === review.snapshot && reviewCurrent(review) ? review : null;
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
  function consultationCurrent(pin: Consultation) {
    const line = lineFor(pin.variant); const pending = line?.proposals.find(p => p.state === 'pending');
    const original = pin.pending;
    return latest.current.corrections.snapshot === pin.snapshot && pin.snapshot.request_id.toString() === record.id
      && !!line && allowed(line, 'accept') && line.workflow_revision === pin.workflow
      && line.applied_revision === pin.applied && line.effective_actual === pin.currentActual
      && line.effective_credit === pin.currentCredit && !!pending
      && pending.revision === original.revision && pending.actual_quantity === original.actual_quantity
      && pending.reason === original.reason && pending.initiator_location_id === original.initiator_location_id
      && pending.base_revision === original.base_revision && pending.base_credit === original.base_credit
      && pending.operation_key === original.operation_key && pending.recorded_at === original.recorded_at;
  }
  function reviewCurrent(captured: Review) {
    return captured.draft.action === 'propose' || current() && !submitting.current
      && !latest.current.corrections.busy && !!consultation && consultationCurrent(consultation)
      && latest.current.corrections.snapshot === captured.snapshot;
  }
  const validConsultation = consultation && consultationCurrent(consultation) ? consultation : null;
  const consulting = !!validConsultation && !draft;
  const modalActive = (!!draft || consulting) && !!validSnapshot && (!consultation || !!validConsultation);
  const focusableControls = () => Array.from(dialog.current?.querySelectorAll<HTMLElement>(
    'input:not([type="hidden"]), select, textarea, button, a[href], details > summary:first-of-type, [tabindex]') ?? [])
    .filter(control => isTransferFocusTarget(control) && control.tabIndex >= 0
      && !control.closest('[hidden], [inert], [aria-hidden="true"]'))
    .filter(control => {
      const closed = control.closest('details:not([open])');
      return !closed || !!closed.querySelector(':scope > summary')?.contains(control);
    });
  // One isolation lifetime spans consultation, capture and review; restore before returning focus.
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
    if (modalActive) (consulting ? consultationHeading.current : visibleReview ? cancelButton.current : focusableControls()[0])?.focus();
  }, [modalActive, consulting, !!visibleReview]);
  function retire() {
    restoreAfterSend.current = consultation?.trigger ?? draft?.trigger ?? null;
    setConsultation(null); setReview(null); setDraft(null);
    setMessage('El conteo cambió. Revisá nuevamente antes de confirmar.');
  }
  useEffect(() => {
    if (review && !visibleReview || consultation && !validConsultation) retire();
  }, [review, visibleReview, consultation, validConsultation]);
  // A form is private too: clearing it on a mask cannot resurrect its contents
  // when explicit recovery later unmasks the same authority.
  useEffect(() => { if (masked) { setConsultation(null); setDraft(null); setReview(null); setMessage(''); } }, [masked]);
  function consult(variant: number, trigger: HTMLElement) {
    const line = lineFor(variant); const snap = latest.current.corrections.snapshot;
    if (!current() || !line || !snap || snap.request_id.toString() !== record.id
      || !allowed(line, 'accept') || submitting.current || latest.current.corrections.busy) return;
    const pending = line.proposals.find(p => p.state === 'pending')!;
    const item = record.items.find(i => i.variant_id === variant);
    const credit = item ? (pending.actual_quantity < item.quantity ? pending.actual_quantity : item.quantity) : 0n;
    setConsultation({ variant, trigger, snapshot: snap, pending: { ...pending },
      workflow: line.workflow_revision, applied: line.applied_revision,
      currentActual: line.effective_actual, currentCredit: line.effective_credit,
      credit, delta: item ? credit - line.effective_credit : 0n, reasons: { accept: '', reject: '' } });
    setDraft(null); setReview(null); setMessage('');
  }
  function open(variant: number, action: CountAction, trigger: HTMLElement) {
    const line = lineFor(variant);
    if (!current() || !line || !allowed(line, action) || submitting.current || latest.current.corrections.busy) return;
    if (action !== 'propose' && (!consultation || !consultationCurrent(consultation))) { retire(); return; }
    setMessage(''); setReview(null);
    setDraft({ variant, action, quantity: action === 'propose' ? '' : line.proposals.find(p => p.state === 'pending')!.actual_quantity.toString(), reason: action === 'propose' ? '' : consultation!.reasons[action], trigger });
  }
  function backToConsultation() {
    if (!current() || !draft || draft.action === 'propose' || submitting.current || latest.current.corrections.busy) return;
    if (!consultation || !consultationCurrent(consultation)) { retire(); return; }
    setConsultation({ ...consultation, reasons: { ...consultation.reasons, [draft.action]: draft.reason } });
    setDraft(null); setReview(null); setMessage('');
  }
  function decisionAdmitted(value: Draft, line: CountCorrectionLine) {
    try {
      normalizeCountDecision({ variant_id: value.variant, reason: value.reason,
        expected_revision: line.workflow_revision.toString(), operation_key: 'capture_validation' });
      return true;
    } catch { return false; }
  }
  function prepare() {
    if (!current() || !draft || submitting.current || latest.current.corrections.busy) return;
    if (draft.action !== 'propose' && (!consultation || !consultationCurrent(consultation))) { retire(); return; }
    const line = lineFor(draft.variant); const snap = latest.current.corrections.snapshot;
    if (!line || !snap || snap.request_id.toString() !== record.id || !allowed(line, draft.action)) return;
    if (draft.action !== 'propose' && !decisionAdmitted(draft, line)) {
      setMessage('Ingresá un motivo válido de 1 a 2000 caracteres, sin NUL ni Unicode mal formado.');
      return;
    }
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
        currentActual: line.effective_actual, currentCredit: line.effective_credit,
        credit, delta: draft.action === 'reject' || !item ? 0n : credit - line.effective_credit,
        decision: draft.action === 'propose' ? undefined : Object.freeze({ reference: record.reference,
          battery: name(draft.variant), sent: item?.quantity ?? 0n,
          proposer: location(pending!.initiator_location_id), reviewer: location(owner!.location),
          destination: record.destination_location_name, origin: record.origin_location_name,
          unexpected: !item, originalReason: pending!.reason }) });
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
      || captured.draft.action !== 'propose' && (!consultation || !consultationCurrent(consultation))
      || review !== captured || !line || !allowed(line, captured.draft.action)
      || line.workflow_revision.toString() !== (captured.draft.action === 'propose'
        ? captured.input.expected_revision : captured.revision.toString())) {
      if (current()) retire();
      return;
    }
    restoreAfterSend.current = captured.draft.trigger;
    void run(() => {
      setConsultation(null); setReview(null); setDraft(null);
      return captured.draft.action === 'propose' ? p.corrections.propose(captured.input as CountProposalInput)
        : p.corrections.decide(captured.draft.action, captured.input);
    });
  }
  function editProposal(captured: Review) {
    const p = latest.current; const line = lineFor(captured.draft.variant);
    if (!current() || submitting.current || p.corrections.busy || captured.draft.action !== 'propose') return;
    if (review !== captured || p.corrections.snapshot !== captured.snapshot || !line
      || !allowed(line, 'propose') || line.workflow_revision.toString() !== captured.input.expected_revision) {
      setReview(null); setDraft(null); setMessage('El conteo cambió. Revisá nuevamente antes de confirmar.');
      return;
    }
    // Keep the capture and isolation lifetime, but retire the reviewed transport identity.
    setDraft({ ...captured.draft }); setReview(null); setMessage('');
  }
  function editDecision(captured: Review) {
    if (!current() || submitting.current || latest.current.corrections.busy) return;
    if (review !== captured || captured.draft.action === 'propose' || !reviewCurrent(captured)) { retire(); return; }
    // Preserve the branch capture and isolation, never the old transport identity.
    setDraft({ ...captured.draft }); setReview(null); setMessage('');
  }
  function close() {
    if (!current() || submitting.current || latest.current.corrections.busy) return;
    restoreAfterSend.current = consultation?.trigger ?? draft?.trigger ?? null;
    setConsultation(null); setReview(null); setDraft(null);
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
  const routineVisible = props.contextVisible !== false || !!consultation || !!draft || !!review || sending;
  const sectionVisible = routineVisible || masked || corrections.busy || !!corrections.error
    || !validSnapshot || !!message || attempts.length > 0;
  const privateLines = validSnapshot?.lines.filter(line => record.status === 'received'
    && record.receipt.items.some(i => i.variant_id === line.variant_id)) ?? [];
  const proposalLines = privateLines.filter(line => allowed(line, 'propose'));
  const captureLine = draft && validSnapshot?.lines.find(line => line.variant_id === draft.variant);
  const captureReady = !!captureLine && !corrections.busy && !corrections.error;
  const decisionCapture = !!draft && draft.action !== 'propose' && !review;
  const decisionNoun = draft?.action === 'accept' ? 'aceptación' : 'rechazo';
  const decisionValid = !!draft && !!captureLine && captureReady && allowed(captureLine, draft.action)
    && decisionAdmitted(draft, captureLine);
  let proposalValid = false;
  if (draft?.action === 'propose' && captureReady && allowed(captureLine!, 'propose')) {
    try {
      // Admission only: the real immutable input and retry key are created in prepare.
      normalizeCountProposal({ variant_id: draft.variant, actual_quantity: draft.quantity,
        reason: draft.reason, expected_revision: captureLine!.workflow_revision.toString(),
        operation_key: 'capture_validation' });
      proposalValid = true;
    } catch { /* Keep review disabled without rewriting captured evidence. */ }
  }
  return <section className="count-corrections" aria-label="Correcciones de conteo" hidden={!sectionVisible}>
    <h2 ref={contextHeading} tabIndex={-1}>Correcciones de conteo</h2>
    <p className="count-context-note sr-only" hidden={!routineVisible}>La recepción original es inmutable. La transferencia sigue Recibida; estas correcciones conservan su evidencia original.</p>
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
      {validSnapshot && <h3 className="sr-only">Conteo efectivo confirmado</h3>}
      {validSnapshot && <table className="count-management" aria-label="Gestión de conteo">
        <thead><tr>{['Producto', 'Conteo vigente', 'Crédito en destino', 'Historial', 'Acción'].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead>
      {privateLines.map(line => {
        const unexpected = !record.items.some(i => i.variant_id === line.variant_id);
        const pending = line.proposals.find(p => p.state === 'pending');
        const historyKey = `history-${line.variant_id}`;
        const historyID = `${disclosureID}-${historyKey}`;
        return <tbody key={line.variant_id} aria-label={name(line.variant_id)}>
          <tr className="count-product-row">
            <th scope="row">{name(line.variant_id)}</th>
            <td data-label="Conteo vigente">{line.effective_actual.toString()}</td>
            <td data-label="Crédito en destino">{line.effective_credit.toString()}</td>
            <td data-label="Historial">{line.proposals.length ? <button type="button" aria-expanded={!!expanded[historyKey]} aria-controls={historyID}
              aria-label={`Historial completo · ${line.proposals.length} ${line.proposals.length === 1 ? 'revisión' : 'revisiones'}`}
              onClick={() => toggle(historyKey)}>{line.proposals.length} {line.proposals.length === 1 ? 'revisión' : 'revisiones'}</button> : 'Sin correcciones'}</td>
            <td data-label="Acción"><div className="count-actions">
              {allowed(line, 'propose') && <button disabled={sending} onClick={e => open(line.variant_id, 'propose', e.currentTarget)}>{pending ? 'Reemplazar propuesta' : 'Proponer corrección'}</button>}
              {allowed(line, 'accept') && <button disabled={sending || corrections.busy} onClick={e => consult(line.variant_id, e.currentTarget)}>Consultar propuesta</button>}
            </div></td>
          </tr>
          {pending && <tr><td colSpan={5}><div className="count-pending">
            <p className="count-pending-owner">{pending.initiator_location_id === owner?.location
              ? `Esperando revisión de ${location(owner.location === record.origin_location_id ? record.destination_location_id : record.origin_location_id)}`
              : `Propuesta de ${location(pending.initiator_location_id)} · Requiere tu revisión`}</p>
            <p>Conteo vigente: {line.effective_actual.toString()} → Propuesto: {pending.actual_quantity.toString()}</p>
            <p className="count-review-label">Motivo declarado</p><p className="count-evidence">{pending.reason}</p>
            <p>La propuesta pendiente no modifica el conteo ni el stock.</p>
          </div></td></tr>}
          {unexpected && <tr><td colSpan={5}>Solo auditoría: crédito y efecto en stock cero. La procedencia e incorporación se resuelven por separado.</td></tr>}
          {!!line.proposals.length && <tr hidden={!expanded[historyKey]} id={historyID} className="count-history-disclosure"><td colSpan={5}>
            <p>Resultado de la corrección; no indica movimiento de stock.</p>
            {countTechnical(line)}
            <table className="count-revision-table" aria-label={`Historial de ${name(line.variant_id)}`}>
              <thead><tr>{['Revisión', 'Cambio de conteo', 'Resultado', 'Fecha', 'Detalle'].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead>
              {line.proposals.map(p => {
                const base = p.base_revision === 0n && record.status === 'received'
                  ? record.receipt.items.find(i => i.variant_id === line.variant_id)?.actual_quantity
                  : line.proposals.find(prior => prior.revision === p.base_revision && prior.revision < p.revision && prior.state === 'applied')?.actual_quantity;
                const detailKey = `${line.variant_id}-${p.revision}`; const detailID = `${disclosureID}-${detailKey}`;
                return <tbody key={p.revision.toString()}>
                  <tr><th scope="row">Revisión {p.revision.toString()}</th>
                    <td data-label="Cambio de conteo">{base === undefined ? `Cantidad ${p.actual_quantity}` : `${base} → ${p.actual_quantity}`}</td>
                    <td data-label="Resultado">{states[p.state]}</td><td data-label="Fecha"><TransferDate value={p.recorded_at} /></td>
                    <td><button type="button" aria-label={`Ver detalle de revisión ${p.revision}`} aria-expanded={!!expanded[detailKey]} aria-controls={detailID} onClick={() => toggle(detailKey)}>Ver detalle</button></td></tr>
                  <tr hidden={!expanded[detailKey]} id={detailID} className="count-revision-detail"><td colSpan={5}>
                    <p>Iniciador {location(p.initiator_location_id)}</p><p className="count-evidence">Motivo: {p.reason}</p>
                    {p.decision && <><p>{p.decision.accepted ? 'Aceptada' : 'Rechazada'} por {location(p.decision.actor_location_id)} · <TransferDate value={p.decision.recorded_at} /></p>
                      <p className="count-evidence">Motivo de decisión: {p.decision.reason}</p></>}
                    {p.application && <><p>Aplicación: crédito {p.application.effective_credit.toString()} · Efecto {signed(p.application.delta)} · <TransferDate value={p.application.recorded_at} /></p>
                      {p.revision === line.applied_revision && p.state === 'applied' && <p>Efecto aplicado en destino: {signed(p.application.delta)}</p>}</>}
                    <details className="count-technical"><summary>Evidencia técnica de revisión {p.revision.toString()}</summary>
                      <p>Base {p.base_revision.toString()} · Crédito base {p.base_credit.toString()}</p><p>Clave {p.operation_key}</p>
                      {p.decision && <p>Clave de decisión {p.decision.operation_key}</p>}
                    </details>
                  </td></tr>
                </tbody>;
              })}
            </table>
          </td></tr>}
        </tbody>;
      })}
      </table>}
      {privateLines.some(line => !line.proposals.length) && <details className="count-technical count-empty-technical">
        <summary>Evidencia técnica del conteo</summary>
        {privateLines.filter(line => !line.proposals.length).map(line => <div key={line.variant_id}><p>{name(line.variant_id)}</p>{countRevisions(line)}</div>)}
      </details>}
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
      {modalActive && <div className="count-backdrop"><div ref={dialog} className={`count-modal${consulting ? ' count-consultation' : ''}${decisionCapture ? ' count-decision-capture' : visibleReview?.decision ? ' count-decision-review' : ''}${draft?.action === 'propose' ? review ? ' count-proposal-review' : ' count-proposal-capture' : ''}`} role="dialog" aria-modal="true" aria-labelledby={headingID} tabIndex={-1}
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
        {consulting ? <header className="count-consultation-heading">
          <h3 ref={consultationHeading} id={headingID} tabIndex={-1}>Propuesta de corrección de conteo</h3>
          <p className="count-consultation-status" role="status">Pendiente de decisión</p>
        </header> : <h3 id={headingID}>{visibleReview ? visibleReview.draft.action === 'propose' ? 'Revisar propuesta de conteo' : `Confirmar ${decisionNoun} de conteo` : draft?.action === 'propose' ? 'Corregir conteo' : `${actions[draft!.action]} propuesta de conteo`}</h3>}
        {message && <p role="alert">{message}</p>}
        {consulting && validConsultation && <>
          <CounterpartyContext pin={validConsultation} reference={record.reference}
            battery={name(validConsultation.variant)} sent={record.items.find(i => i.variant_id === validConsultation.variant)?.quantity ?? 0n}
            proposer={location(validConsultation.pending.initiator_location_id)} reviewer={location(owner!.location)}
            destination={record.destination_location_name} unexpected={!record.items.some(i => i.variant_id === validConsultation.variant)} />
          <footer><button disabled={sending || corrections.busy} onClick={() => open(validConsultation.variant, 'reject', validConsultation.trigger)}>Rechazar propuesta</button>
            <button disabled={sending || corrections.busy} onClick={() => open(validConsultation.variant, 'accept', validConsultation.trigger)}>Aceptar propuesta</button></footer>
        </>}
      {draft && !review && <form className="count-form" onSubmit={e => { e.preventDefault(); prepare(); }} aria-label="Editar corrección">
        {draft.action === 'propose' ? <>
          <p className="count-capture-subtitle">{record.reference} · {location(owner!.location)}</p>
          <p>Proponé una corrección para una variante de esta recepción.</p>
          <label htmlFor={variantID}>Batería a corregir</label>
          <select id={variantID} value={draft.variant} disabled={sending || corrections.busy} onChange={e => {
            const variant = Number(e.target.value); const line = lineFor(variant);
            if (!current() || submitting.current || latest.current.corrections.busy || !line || !allowed(line, 'propose')) return;
            setReview(null); setMessage(''); setDraft({ ...draft, variant, quantity: '', reason: '' });
          }}>
            {proposalLines.map(line => <option key={line.variant_id} value={line.variant_id}>{name(line.variant_id)}</option>)}
          </select>
          <div className="count-capture-context">
            <span>Enviadas originalmente: <strong>{record.items.find(i => i.variant_id === draft.variant)?.quantity.toString() ?? '0'}</strong></span>
            {captureReady ? <>
              <span>Conteo efectivo confirmado: <strong>{captureLine.effective_actual.toString()}</strong></span>
              <span>Crédito efectivo de esta recepción: <strong>{captureLine.effective_credit.toString()}</strong></span>
            </> : <span>Conteo pendiente de verificación.</span>}
          </div>
          <label htmlFor={quantityID}>Cantidad corregida</label><input id={quantityID} type="text" inputMode="numeric"
            aria-describedby={quantityHelpID} placeholder="Ingresá la cantidad total correcta"
            value={draft.quantity} onChange={e => setDraft({ ...draft, quantity: e.target.value })} required />
          <p id={quantityHelpID} className="count-capture-help">Es el total recibido de esta variante, no la diferencia.</p>
        </> : validConsultation && <CounterpartyContext pin={validConsultation} reference={record.reference}
          battery={name(validConsultation.variant)} sent={record.items.find(i => i.variant_id === validConsultation.variant)?.quantity ?? 0n}
          proposer={location(validConsultation.pending.initiator_location_id)} reviewer={location(owner!.location)}
          destination={record.destination_location_name} unexpected={!record.items.some(i => i.variant_id === validConsultation.variant)} decision />}
        <label htmlFor={reasonID}>{decisionCapture ? `Motivo de ${decisionNoun} (obligatorio)` : 'Motivo'}</label><textarea id={reasonID} value={draft.reason}
          placeholder={draft.action === 'propose' ? 'Explicá por qué debe corregirse el conteo' : `Explicá por qué ${draft.action === 'accept' ? 'aceptás' : 'rechazás'} esta corrección`}
          onChange={e => setDraft({ ...draft, reason: e.target.value })} required />
        {draft.action === 'propose' && <div className="count-capture-warning">
          <p>Enviar la propuesta no modifica el stock. {location(owner!.location === record.origin_location_id ? record.destination_location_id : record.origin_location_id)} deberá aceptarla para aplicar la corrección.</p>
          <p>La recepción original se conserva.</p>
          <p>Una propuesta nueva o reemplazada requiere un nuevo acuerdo de la contraparte; no conserva el consentimiento anterior.</p>
          {!record.items.some(i => i.variant_id === draft.variant) && <p>Solo auditoría: crédito y efecto en stock cero. La procedencia e incorporación se resuelven por separado.</p>}
        </div>}
        {decisionCapture && validConsultation && <>
          <p className="count-review-muted">Este motivo quedará registrado junto con tu decisión.</p>
          <div className="count-review-warning">
            {draft.action === 'accept' ? <>
              <p>Todavía no se aplicará ningún cambio.</p>
              <p>Al confirmar la aceptación, sujeto a validación: Efecto en destino: {signed(validConsultation.delta)} · {record.destination_location_name}. Crédito limitado: {validConsultation.credit.toString()}.</p>
            </> : <>
              <p>Rechazar esta propuesta no modifica el conteo efectivo ni el stock.</p>
              <p>Se mantienen {validConsultation.currentActual.toString()} baterías contabilizadas y {validConsultation.currentCredit.toString()} acreditadas en esta recepción.</p>
            </>}
            <p>La recepción original se conserva. Sin restitución al origen, resolución automática de faltantes ni incorporación de excedentes. El crédito no es inventario actual.</p>
            {!record.items.some(i => i.variant_id === draft.variant) && <p>Solo auditoría: crédito y efecto cero. Procedencia e incorporación separadas.</p>}
          </div>
        </>}
        <div className="count-actions"><button type="submit" disabled={sending || corrections.busy || (draft.action === 'propose' ? !proposalValid : !decisionValid)}>{decisionCapture ? `Revisar ${decisionNoun}` : 'Revisar corrección'}</button><button type="button" disabled={sending || corrections.busy} onClick={decisionCapture ? backToConsultation : close}>{decisionCapture ? 'Volver' : 'Cancelar'}</button></div>
      </form>}
      {visibleReview && <>
        {visibleReview.draft.action === 'propose' ? <div className="count-modal-body count-review-body">
          <div><p>{record.reference} · Propuesta de {location(owner!.location)}</p>
            <p className="count-review-muted">Revisión a cargo de {location(owner!.location === record.origin_location_id ? record.destination_location_id : record.origin_location_id)}</p></div>
          <div className="count-review-battery"><div><p className="count-review-label">Batería a corregir</p>
            <strong>{name(visibleReview.draft.variant)}</strong></div>
            <span>Enviadas: {record.items.find(i => i.variant_id === visibleReview.draft.variant)?.quantity.toString() ?? '0'}</span></div>
          <table className="count-review-comparison" aria-label="Comparación de conteo">
            <thead><tr><th scope="col">Concepto</th><th scope="col">Vigente confirmado</th><th scope="col">Propuesto</th></tr></thead>
            <tbody><tr><th scope="row">Cantidad recibida</th><td>{visibleReview.currentActual.toString()}</td><td>{visibleReview.actual.toString()}</td></tr>
              <tr><th scope="row">Crédito de esta recepción</th><td>{visibleReview.currentCredit.toString()}</td><td>{visibleReview.credit.toString()}</td></tr></tbody>
          </table>
          <div><p className="count-review-label">Motivo</p><p className="count-evidence count-review-reason">{visibleReview.input.reason}</p></div>
          <div className="count-review-warning">
            <p><strong>Enviar propuesta no modifica stock.</strong></p>
            <p>Si {location(owner!.location === record.origin_location_id ? record.destination_location_id : record.origin_location_id)} acepta, sujeto a validación: Efecto en destino: {signed(visibleReview.delta)} · {record.destination_location_name}. Crédito limitado: {visibleReview.credit.toString()}.</p>
            <p>La recepción original se conserva. Sin restitución al origen, resolución de pérdidas, incorporación de excedentes ni política de entregas posteriores. El crédito no es inventario actual.</p>
            <p>Una propuesta nueva o reemplazada requiere un nuevo acuerdo de la contraparte; no conserva el consentimiento anterior.</p>
            {!record.items.some(i => i.variant_id === visibleReview.draft.variant) && <p>Solo auditoría: crédito y efecto cero. Procedencia e incorporación separadas.</p>}
          </div>
          <details className="count-technical"><summary>Evidencia técnica de la propuesta</summary>
            <p>Clave {visibleReview.input.operation_key}</p>
            <p>Revisión de flujo esperada: {visibleReview.input.expected_revision} · Revisión: {visibleReview.revision.toString()} · Base aplicada: {visibleReview.base.toString()}</p>
            <p>Crédito efectivo actual: {visibleReview.currentCredit.toString()}</p>
          </details>
        </div> : visibleReview.decision && <div className="count-modal-body count-review-body">
          <div><p>{visibleReview.decision.reference} · Propuesta de {visibleReview.decision.proposer}</p>
            <p className="count-review-muted">Decisión de {visibleReview.decision.reviewer}</p></div>
          <div className="count-review-battery"><div><p className="count-review-label">Batería a corregir</p>
            <strong>{visibleReview.decision.battery}</strong></div><span>Enviadas: {visibleReview.decision.sent.toString()}</span></div>
          <table className="count-review-comparison" aria-label="Comparación de conteo">
            <thead><tr><th scope="col">Concepto</th><th scope="col">Vigente confirmado</th><th scope="col">{visibleReview.draft.action === 'accept' ? 'Al aceptar' : 'Propuesto'}</th></tr></thead>
            <tbody><tr><th scope="row">Cantidad recibida</th><td>{visibleReview.currentActual.toString()}</td><td>{visibleReview.actual.toString()}</td></tr>
              <tr><th scope="row">Crédito de esta recepción</th><td>{visibleReview.currentCredit.toString()}</td><td>{visibleReview.credit.toString()}</td></tr></tbody>
          </table>
          {visibleReview.draft.action === 'reject' && <p className="count-review-muted">La cantidad propuesta no se aplicará.</p>}
          <div><p className="count-review-label">Motivo de {visibleReview.decision.proposer}</p>
            <p className="count-evidence count-review-reason">{visibleReview.decision.originalReason}</p></div>
          <div><p className="count-review-label">Motivo de {decisionNoun} de {visibleReview.decision.reviewer}</p>
            <p className="count-evidence count-review-reason count-decision-reason">{visibleReview.input.reason}</p></div>
          <div className="count-review-warning">
            <p className="count-review-label">Efecto al confirmar</p>
            {visibleReview.draft.action === 'accept' ? <>
              <p><strong>Efecto en destino: {signed(visibleReview.delta)} · {visibleReview.decision.destination}</strong></p>
              <p>La aceptación se aplicará solo al confirmar y si las validaciones del sistema son satisfactorias.</p>
            </> : <><p>Sin cambios en el conteo efectivo ni en el stock.</p>
              <p>Se mantienen {visibleReview.currentActual.toString()} baterías contabilizadas y {visibleReview.currentCredit.toString()} acreditadas en esta recepción.</p></>}
            <p>La recepción original se conserva. El stock de {visibleReview.decision.origin} no cambia.</p>
            <p>Sin restitución al origen, resolución automática de faltantes ni incorporación de excedentes. El crédito no es inventario actual.</p>
            {visibleReview.decision.unexpected && <p>Solo auditoría: crédito y efecto cero. Procedencia e incorporación separadas.</p>}
          </div>
          <details className="count-technical"><summary>Evidencia técnica de la decisión</summary>
            <p>Clave {visibleReview.input.operation_key}</p>
            <p>Cantidad corregida: {visibleReview.actual.toString()} · Revisión: {visibleReview.revision.toString()} · Base aplicada: {visibleReview.base.toString()}</p>
            <p>Revisión de flujo esperada: {visibleReview.input.expected_revision}</p>
            <p>Crédito limitado: {visibleReview.credit.toString()} · Crédito efectivo actual: {visibleReview.currentCredit.toString()}</p>
            <p>Efecto en destino: {signed(visibleReview.delta)}</p>
          </details>
        </div>}<footer><button ref={cancelButton} disabled={sending || corrections.busy}
          onClick={() => visibleReview.draft.action === 'propose' ? editProposal(visibleReview) : editDecision(visibleReview)}>{visibleReview.draft.action === 'propose' ? 'Editar datos' : 'Editar motivo'}</button>
          <button disabled={sending || corrections.busy} onClick={() => submit(visibleReview)}>{visibleReview.draft.action === 'propose' ? 'Enviar propuesta' : visibleReview.draft.action === 'accept' ? 'Confirmar aceptación' : 'Confirmar rechazo'}</button></footer>
      </>}
        <button className="count-modal-close" aria-label="Cerrar corrección" disabled={sending || corrections.busy} onClick={close}>Cerrar</button>
      </div></div>}
    </>}
  </section>;
}
