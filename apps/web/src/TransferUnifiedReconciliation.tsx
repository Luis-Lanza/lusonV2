import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { TransferController } from './useInventory';
import { newTransferRetryKey, type TransferRecord } from './transferModel';
import type { useTransferUnifiedReconciliations } from './useTransferUnifiedReconciliations';
import { detailAuthority } from './TransferDetail';
import { useTransferModalFocus, type TransferModalFocusBinding } from './transferModalFocus';
import { reconciliationEffects } from './transferUnifiedReconciliationView';
import type { UnifiedReconciliationAction } from './transferUnifiedReconciliationModel';
import './TransferUnifiedReconciliation.css';

export interface TransferUnifiedReconciliationProps {
  controller: TransferController; record: TransferRecord;
  reconciliations: ReturnType<typeof useTransferUnifiedReconciliations>;
  modalFocus?: TransferModalFocusBinding; entryFocusKey?: number; entryTrigger?: HTMLElement; showEntry?: boolean;
}
const labels = { propose: 'propuesta', accept: 'aceptación', reject: 'rechazo' };
export default function TransferUnifiedReconciliation({ controller, record, reconciliations: hook,
  modalFocus, entryFocusKey, entryTrigger, showEntry = true }: TransferUnifiedReconciliationProps) {
  const fence = detailAuthority(controller), bound = useRef(fence);
  const [opening, setOpening] = useState<{ id: string; fence: string; trigger: HTMLElement } | null>(null);
  const [variant, setVariant] = useState(record.items[0]?.variant_id ?? 0);
  const [dispatch, setDispatch] = useState(''), [arrival, setArrival] = useState(''), [retained, setRetained] = useState('0');
  const [reason, setReason] = useState(''), [attested, setAttested] = useState(false), [message, setMessage] = useState('');
  const modal = useRef<HTMLDivElement>(null), title = useId();
  const current = () => !!fence && bound.current === fence && detailAuthority(controller) === fence;
  const snapshot = current() && !hook.masked ? hook.snapshot : null;
  const active = !!opening && opening.id === record.id && opening.fence === fence && current() && !hook.masked;
  const focus = useTransferModalFocus({ active, id: record.id, fence, current, binding: modalFocus });
  const session = controller.getTransferAuthority().session;
  const actor = session?.authenticated ? session.identity.location.id : null;
  const origin = actor === record.origin_location_id;
  const line = snapshot?.lines.find(l => l.variant_id === variant);
  const baseline = snapshot?.current.find(l => l.variant_id === variant);
  const original = snapshot?.original.find(l => l.variant_id === variant);
  const head = line?.proposals.at(-1), pending = head?.state === 'pending' ? head : null;
  const counterparty = pending && pending.initiator_location_id !== actor;
  const prepared = active ? hook.prepared : null;
  const p = prepared?.payload;
  const effects = original && baseline ? reconciliationEffects(original.expected_quantity, baseline.source_debit,
    baseline.effective_credit, prepared?.action === 'propose' && p && 'dispatch_quantity' in p ? p.dispatch_quantity.toString() : pending?.dispatch_quantity.toString() ?? dispatch,
    prepared?.action === 'propose' && p && 'arrival_quantity' in p ? p.arrival_quantity.toString() : pending?.arrival_quantity.toString() ?? arrival,
    prepared?.action === 'propose' && p && 'retained_quantity' in p ? p.retained_quantity.toString() : pending?.retained_quantity.toString() ?? retained) : null;
  const unresolved = hook.attempts.some(a => a.phase !== 'confirmed' && a.phase !== 'failed');
  function open(trigger: HTMLElement) {
    if (!current() || hook.masked) return;
    focus.begin(); setOpening({ id: record.id, fence, trigger }); setMessage('');
    setDispatch(''); setArrival(''); setRetained('0'); setReason(''); setAttested(false); hook.cancel();
  }
  function close() {
    if (opening) focus.queue({ id: opening.id, fence: opening.fence, trigger: opening.trigger });
    hook.cancel(); setOpening(null);
  }
  // The selected menu item is removed before this effect. Preserve its stable
  // Gestiones opener instead of capturing body (or a detached menu item).
  useEffect(() => { if (entryFocusKey !== undefined) open(entryTrigger ?? document.activeElement as HTMLElement); }, [entryFocusKey, entryTrigger]);
  useEffect(() => { setOpening(null); }, [record, fence]);
  useLayoutEffect(() => {
    if (!active || !modal.current) return;
    const backdrop = modal.current.parentElement!;
    const siblings = new Map<Element, string | null>();
    const isolate = () => {
      for (let branch: Element | null = backdrop; branch && branch !== document.body; branch = branch.parentElement) {
        for (const sibling of branch.parentElement?.children ?? []) if (sibling !== branch && !siblings.has(sibling)) {
          siblings.set(sibling, sibling.getAttribute('inert')); sibling.setAttribute('inert', '');
        }
      }
    };
    isolate(); const observer = new MutationObserver(isolate);
    observer.observe(document.body, { childList: true, subtree: true });
    const overflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    modal.current.querySelector<HTMLElement>('button')?.focus();
    return () => { observer.disconnect(); document.body.style.overflow = overflow; for (const [node, value] of siblings) {
      if (value === null) node.removeAttribute('inert'); else node.setAttribute('inert', value);
    } };
  }, [active]);
  function review(action: UnifiedReconciliationAction) {
    if (!current() || !line || !original || !baseline || hook.busy || unresolved) return;
    if (action === 'propose' && (!reconciliationEffects(original.expected_quantity, baseline.source_debit, baseline.effective_credit, dispatch, arrival, retained)
      || origin && retained !== '0' && !attested)) { setMessage('Revisá las cantidades y la confirmación física de origen.'); return; }
    const input = { variant_id: variant, operation_key: newTransferRetryKey(), expected_revision: line.workflow_revision.toString(),
      reason, retained_at_origin: action !== 'reject' && origin && attested,
      ...(action === 'propose' ? { dispatch_quantity: dispatch, arrival_quantity: arrival, retained_quantity: retained } : {}) };
    if (!hook.prepare(action, input)) setMessage('No se pudo preparar. Revisá motivo, evidencia y estado vigente.');
    else setMessage('');
  }
  if (!current()) return null;
  return <section className="unified-reconciliation" aria-label="Conciliación unificada">
    {showEntry && <button type="button" disabled={hook.masked} onClick={e => open(e.currentTarget)}>Resolver diferencia</button>}
    {hook.error && !active && <p role="alert">No se pudo consultar la conciliación. No se sustituyen cantidades vigentes por evidencia histórica.</p>}
    {active && <div className="unified-backdrop" onClick={e => { if (e.target === e.currentTarget) close(); }}>
      <div className="unified-modal" ref={modal} role="dialog" aria-modal="true" aria-labelledby={title} onKeyDown={e => {
        if (e.key === 'Escape') { e.preventDefault(); close(); }
        if (e.key === 'Tab') {
          const controls = Array.from(modal.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)') ?? []);
          const first = controls[0], last = controls.at(-1);
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
        }
      }}>
        <header><div><small>{record.reference}</small><h2 id={title}>Resolver diferencia</h2></div><button type="button" onClick={close} aria-label="Cerrar y volver al detalle">×</button></header>
        <div className="unified-body">
          {!snapshot ? <><p role="status">Conciliación no disponible. No se muestra historia como estado vigente.</p><button onClick={() => void hook.refresh()}>Consultar conciliación</button></> : <>
            <label>Variante<select value={variant} disabled={!!prepared || hook.busy} onChange={e => {
              setVariant(Number(e.target.value)); hook.cancel(); setDispatch(''); setArrival(''); setRetained('0'); setReason(''); setAttested(false);
            }}>{record.items.map(item => <option key={item.variant_id} value={item.variant_id}>{item.brand} {item.model} · {item.polarity} · Variante {item.variant_id}</option>)}</select></label>
            {original && <p className="unified-notice">Declaradas originalmente: {original.expected_quantity.toString()} · Recibidas originalmente: {original.actual_quantity.toString()} · Crédito original: {original.available_quantity.toString()}. Estos registros se conservan.</p>}
            {prepared ? <section aria-label="Revisión de conciliación"><h3>Revisar efectos</h3>
              <p>{labels[prepared.action]} · Variante {prepared.payload.variant_id}</p>
              <p>Revisión de flujo esperada: {prepared.payload.expected_revision.toString()}</p>
              {effects && <dl className="unified-effects"><dt>Salieron</dt><dd>{effects.dispatch.toString()}</dd><dt>Llegaron</dt><dd>{effects.arrival.toString()}</dd><dt>Retenidas</dt><dd>{effects.retained.toString()}</dd>
                <dt>Cambio de existencias en origen</dt><dd>{prepared.action === 'reject' ? '0' : prepared.action === 'accept' ? effects.sourceDelta.toString() : `Hipotético: ${effects.sourceDelta}`}</dd>
                <dt>Cambio de crédito destino</dt><dd>{prepared.action === 'reject' ? '0' : prepared.action === 'accept' ? effects.destinationDelta.toString() : `Hipotético: ${effects.destinationDelta}`}</dd>
                <dt>Sin localizar en origen</dt><dd>{effects.originUnknown.toString()}</dd><dt>Sin localizar en tránsito</dt><dd>{effects.transitUnknown.toString()}</dd><dt>Exceso sin acreditar</dt><dd>{effects.excess.toString()}</dd></dl>}
              <p>{prepared.payload.reason}</p><p className="unified-notice">Sin localizar no equivale a pérdida autorizada. No se cierra ni se compensa automáticamente.</p>
              <p>{prepared.action === 'accept' ? 'La aceptación aplica todos los efectos juntos o ninguno, sujetos a validaciones vigentes.' : 'Proponer o rechazar no mueve stock.'}</p>
              <button onClick={() => hook.cancel()}>Volver a editar</button>
              <button className="primary" disabled={hook.busy} onClick={() => { if (current()) void hook.confirm(); }}>Confirmar {labels[prepared.action]}</button>
            </section> : <>
              {counterparty ? <><h3>Propuesta de la contraparte</h3><p>Salieron: {pending.dispatch_quantity.toString()} · Llegaron: {pending.arrival_quantity.toString()} · Retenidas: {pending.retained_quantity.toString()}</p><p>{pending.reason}</p></> : <div className="unified-fields">
                <label>Salieron realmente<input inputMode="numeric" value={dispatch} onChange={e => setDispatch(e.target.value)} /></label>
                <label>Llegaron realmente<input inputMode="numeric" value={arrival} onChange={e => setArrival(e.target.value)} /></label>
                <label>Quedaron físicamente en origen<input inputMode="numeric" value={retained} onChange={e => setRetained(e.target.value)} /></label>
              </div>}
              {origin && <label className="unified-check"><input type="checkbox" checked={attested} onChange={e => setAttested(e.target.checked)} />Verifiqué físicamente la cantidad retenida en origen.</label>}
              <label>Motivo y evidencia<textarea value={reason} onChange={e => setReason(e.target.value)} /></label>
              <p>Cualquiera de las dos ubicaciones puede proponer. La contraparte debe aceptar; solo origen confirma retención física positiva.</p>
              {counterparty ? <><button disabled={hook.busy || unresolved} onClick={() => review('accept')}>Revisar aceptación</button><button disabled={hook.busy || unresolved} onClick={() => review('reject')}>Revisar rechazo</button></> : <button disabled={hook.busy || unresolved} onClick={() => review('propose')}>Revisar propuesta</button>}
            </>}
          </>}
          {hook.attempts.map(attempt => <section className="unified-notice" key={attempt.payload.operation_key} aria-label="Estado de operación">
            <h3>{({ uncertain: 'Resultado incierto', conflict: 'Conflicto de operación', inFlight: 'Operación en curso', failed: 'Operación rechazada', confirmed: 'Operación confirmada' })[attempt.phase]}</h3>
            <p>Variante {attempt.payload.variant_id} · {labels[attempt.action]} · Clave: {attempt.payload.operation_key} · Revisión esperada: {attempt.payload.expected_revision.toString()}</p>
            {'dispatch_quantity' in attempt.payload && <p>Salieron: {attempt.payload.dispatch_quantity.toString()} · Llegaron: {attempt.payload.arrival_quantity.toString()} · Retenidas: {attempt.payload.retained_quantity.toString()}</p>}
            <p>{attempt.payload.reason}</p>
            {['uncertain', 'conflict'].includes(attempt.phase) && <><p>No envíes otra operación con una clave nueva. Consultá el resultado exacto antes de decidir.</p>
              <button disabled={hook.busy} onClick={() => void hook.recover()}>Consultar operación</button>
              {attempt.phase === 'uncertain' && <button disabled={hook.busy} onClick={() => void hook.retry(attempt.payload.variant_id)}>Reintentar exactamente la misma operación</button>}
            </>}
          </section>)}
          {message && <p role="alert">{message}</p>}
          {hook.error && <p role="alert">No se confirmó el resultado. Consultá la operación; no se aplican cambios locales.</p>}
        </div><footer><button onClick={close}>Volver al detalle</button></footer>
      </div>
    </div>}
  </section>;
}
