import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import {
  closingAcceptance, closingAccountLabel, closingAcceptedCorrections, closingBalanceStrip,
  closingBalancesLabel, closingCorrectedAmounts,
  closingCorrectedCounts, closingCorrectionDeltaText, closingCorrectionPreview,
  closingCorrectionQuantityDeltaText, closingCorrectionStatusLabels, closingDecisionPayload,
  closingDecisionReadiness, closingDifferenceName, closingEnvelope, closingEnvelopeAcceptanceHelp,
  closingEnvelopeApartHelp, closingIsLive, closingMaterialDeliveryHelp, closingMaterialEmptySheet,
  closingEvidencePath, closingEvidenceText,
  closingExpenseEffect, closingExpenseMotive, closingExpenseNote,
  closingMaterialLines, closingMaterialQuantityLabel, closingMaterialQuantityText,
  closingMaterialReading, closingMaterialShelfHelp, closingMaterialSignedText,
  closingMaterialWireText, closingMoneyText,
  closingMomentText, closingPendingCorrection, closingPeriod, closingPeriodLabel, closingRail,
  closingRateText, closingRoundStateLabel, closingSheetChanges, closingSignedText,
  closingStatusLabels, closingAcceptanceMismatchMessage, closingTabAfter, closingTabLabels,
  closingTabMarker, closingTabOrder, closingTabsLabel,
  emptyMaterialDraft,
  type Closing, type ClosingAcceptance, type ClosingRail, type ClosingStockChange,
  type ClosingTab,
} from './closingModel';
import {
  ClosingAPIError, closingDocumentUnavailable, closingErrorMessages, closingRefusalMessage,
  createClosingAPI, type ClosingRefusal,
} from './closingsAPI';
import { subscribeClosingInvalidation } from './useInventory';
import './closings.css';

export interface ClosingDecisionProps {
  // The parent remounts this section per branch session fence, so a rotated session or a CSRF
  // token can never publish a decision into a newer session.
  csrf: string;
  /** The branch of the session itself: it is the only settlement this screen can reach. */
  branch: number;
  branchName: string;
  fetcher?: typeof globalThis.fetch;
}

function failureOf(error: unknown): ClosingAPIError {
  return error instanceof ClosingAPIError ? error : new ClosingAPIError('invalid_response', null);
}

function refusalMessage(error: ClosingAPIError): string {
  const refusal: ClosingRefusal | null = error.refusal;
  return refusal === null ? closingErrorMessages[error.code] : closingRefusalMessage(refusal);
}

function acceptanceOf(closing: Closing): ClosingAcceptance | null {
  try { return closingAcceptance(closing); } catch { return null; }
}

function stockDifferenceClass(change: ClosingStockChange): string {
  if (change.difference === 0) return 'zero';
  return change.difference < 0 ? 'neg' : 'pos';
}

/**
 * The branch's side of the rendición de cuentas: it reads the offer the warehouse composed and
 * only accepts or rejects it. Acceptance closes and applies the count; a rejection carries a
 * motive and applies nothing. Every round stays legible, and outside `proposed` the screen is
 * read-only and says why.
 */
export default function ClosingDecision({ csrf, branch, branchName, fetcher = globalThis.fetch }: ClosingDecisionProps) {
  const api = useMemo(() => createClosingAPI(fetcher), [fetcher]);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading');
  const [revision, setRevision] = useState(0);
  const [closing, setClosing] = useState<Closing | null>(null);
  // The two tabs are navigation over one document, never two decisions (S10).
  const [tab, setTab] = useState<ClosingTab>('caja');
  const [motive, setMotive] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [correctionMotive, setCorrectionMotive] = useState('');
  const [rejectingCorrection, setRejectingCorrection] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [problem, setProblem] = useState('');
  const mounted = useRef(true);
  const lifetime = useRef(new AbortController());
  const pending = useRef(false);
  // Whether the branch is working on an answer right now: an operation in flight, or a motive it has
  // already typed. A live hint must not read the document again over either of them, because reading
  // it again is what clears them; the hint is remembered instead and applied once they are gone.
  const answering = useRef(false);
  answering.current = busy || motive.trim() !== '' || correctionMotive.trim() !== '';
  // The frame that arrived while the branch was answering: it waits here instead of being lost.
  const waiting = useRef(false);
  // The roving tab index of the two tabs, the same one the purchases screen uses.
  const tabButtons = useRef<Record<ClosingTab, HTMLButtonElement | null>>({ caja: null, chatarra: null });

  useEffect(() => {
    const flight = lifetime.current;
    mounted.current = true;
    return () => { mounted.current = false; flight.abort(); };
  }, []);

  // The settlement the warehouse opens or proposes arrives on the branch's own stream (058): the
  // screen reads its history and its document again instead of waiting for a reload, so the notice
  // of the frozen branch and the acceptance appear in place (S10).
  useEffect(() => subscribeClosingInvalidation(() => {
    if (!mounted.current || lifetime.current.signal.aborted) return;
    if (answering.current) { waiting.current = true; return; }
    setRevision(value => value + 1);
  }), []);

  // A hint that arrived while the branch was answering is applied as soon as the answer is out of the
  // way -- the motive cleared or the request finished -- exactly once, so a settlement the warehouse
  // proposed while the branch was typing still lands without a reload (S10).
  useEffect(() => {
    if (!waiting.current || !mounted.current || lifetime.current.signal.aborted || answering.current) return;
    waiting.current = false;
    setRevision(value => value + 1);
  }, [busy, motive, correctionMotive]);

  // The branch reads its own history: the live settlement when there is one, and the last
  // closure otherwise, so a reload after the closure still describes the settlement it answered.
  useEffect(() => {
    const controller = new AbortController();
    const alive = () => mounted.current && !controller.signal.aborted && !lifetime.current.signal.aborted;
    setPhase('loading'); setProblem(''); setStatus('');
    setClosing(null); setMotive(''); setRejecting(false);
    setCorrectionMotive(''); setRejectingCorrection(false);
    void (async () => {
      try {
        const page = await api.history(branch, 1, 25, controller.signal);
        if (!alive()) return;
        const live = page.closings.find(row => closingIsLive(row.status));
        const target = live ?? page.closings[0];
        if (target === undefined) { setPhase('empty'); return; }
        const document = await api.detail(target.id, controller.signal);
        if (!alive()) return;
        // The server already refuses another branch's document; this screen never describes one
        // either, and never offers a decision it could not make.
        if (document.branch_location_id !== branch) {
          setPhase('error'); setProblem(closingErrorMessages.not_found); return;
        }
        setClosing(document);
        setPhase('ready');
      } catch (failure) {
        if (!alive()) return;
        const error = failureOf(failure);
        setPhase('error');
        setProblem(error.code === 'invalid_response' ? closingDocumentUnavailable : refusalMessage(error));
      }
    })();
    return () => controller.abort();
  }, [api, branch, revision]);

  function apply(document: Closing) {
    setClosing(document);
    setMotive('');
    setRejecting(false);
    setCorrectionMotive('');
    setRejectingCorrection(false);
    setPhase('ready');
    setProblem('');
  }

  async function decide(answer: 'accepted' | 'rejected') {
    const current = closing;
    if (!current || busy || pending.current) return;
    if (!closingDecisionReadiness(current).awaiting) return;
    let payload;
    try { payload = closingDecisionPayload(answer, motive); }
    catch (failure) {
      setStatus('');
      setProblem(failure instanceof Error && failure.message ? failure.message : closingErrorMessages.invalid_request);
      return;
    }
    pending.current = true; setBusy(true); setProblem('');
    setStatus(answer === 'accepted' ? 'Cerrando la rendición…' : 'Enviando el rechazo al Almacén…');
    try {
      const document = await api.decision(current.id, payload, csrf, lifetime.current.signal);
      if (!mounted.current || lifetime.current.signal.aborted) return;
      apply(document);
      setStatus(answer === 'accepted'
        ? 'Rendición cerrada: la sucursal vuelve a operar.'
        : 'Rechazo enviado al Almacén: la rendición vuelve al Almacén y la sucursal sigue congelada.');
    } catch (failure) {
      if (!mounted.current || lifetime.current.signal.aborted) return;
      setStatus('');
      // The refusal is the server's, named by the fact it is about: the screen never guesses.
      setProblem(refusalMessage(failureOf(failure)));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  /**
   * The branch's answer to the correction of its closed settlement: acceptance applies the deltas
   * the warehouse stated, a rejection carries its mandatory motive and applies nothing. The screen
   * reads the settlement again afterwards, so it describes what the server applied (S16).
   */
  async function decideCorrection(answer: 'accepted' | 'rejected') {
    const current = closing;
    const waiting = current === null ? null : closingPendingCorrection(current);
    if (current === null || waiting === null || busy || pending.current) return;
    let payload;
    try { payload = closingDecisionPayload(answer, correctionMotive); }
    catch (failure) {
      setStatus('');
      setProblem(failure instanceof Error && failure.message ? failure.message
        : closingErrorMessages.invalid_request);
      return;
    }
    pending.current = true; setBusy(true); setProblem('');
    setStatus(answer === 'accepted' ? 'Aceptando la corrección…' : 'Enviando el rechazo de la corrección…');
    try {
      await api.correctionDecision(waiting.id, payload, csrf, lifetime.current.signal);
      if (!mounted.current || lifetime.current.signal.aborted) return;
      const document = await api.detail(current.id, lifetime.current.signal);
      if (!mounted.current || lifetime.current.signal.aborted) return;
      if (document.branch_location_id !== branch) {
        setPhase('error'); setProblem(closingErrorMessages.not_found); return;
      }
      apply(document);
      setStatus(answer === 'accepted'
        ? 'Corrección aceptada: la rendición sigue cerrada y sus números corregidos son los que quedan.'
        : 'Rechazo enviado al Almacén: la corrección no se aplicó y nada cambió.');
    } catch (failure) {
      if (!mounted.current || lifetime.current.signal.aborted) return;
      setStatus('');
      setProblem(refusalMessage(failureOf(failure)));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  const readiness = closing === null ? null : closingDecisionReadiness(closing);
  const pendingCorrection = closing === null ? null : closingPendingCorrection(closing);
  const correctionPreview = closing === null ? null : closingCorrectionPreview(closing);
  const acceptedCorrections = closing === null ? [] : closingAcceptedCorrections(closing);
  const correctedAmounts = closing === null ? [] : closingCorrectedAmounts(closing);
  const correctedCounts = closing === null ? [] : closingCorrectedCounts(closing);
  const canRejectCorrection = !busy && correctionMotive.trim() !== '';
  const acceptance = closing === null ? null : acceptanceOf(closing);
  // The envelope the branch is accepting: the offer's own frozen count and new amount (S5, S6).
  const envelope = closing === null ? null : closingEnvelope(closing, acceptance?.offer ?? null);
  const mismatch = closing !== null && closing.status === 'proposed' && acceptance === null;
  const rail: ClosingRail | null = acceptance?.rail ?? (closing === null ? null : closingRail(closing));
  // A settlement the warehouse still holds has no offer: its sheet is the draft of an offer the
  // branch was not asked to accept, so the panel waits for the proposal instead of rendering it.
  const offerPending = closing !== null && closing.status === 'open';
  const changes: readonly ClosingStockChange[] = acceptance?.changes
    ?? (closing === null || offerPending ? [] : closingSheetChanges(closing));
  const changesCount = changes.filter(change => change.difference !== 0).length;
  const awaiting = readiness?.awaiting === true && acceptance !== null;
  const currentRound = acceptance?.round ?? (closing === null ? null : closing.rounds[closing.rounds.length - 1] ?? null);
  const period = closing === null ? null : closingPeriod(closing.period_start, closing.cut_at);
  const observation = acceptance?.offer.observation ?? closing?.observation ?? '';
  const canReject = !busy && motive.trim() !== '';
  // The third account as the branch reads it: the sheet of the document, with no input and no
  // draft, so a count it never typed is never invented (S8, S9).
  const materialReading = closingMaterialReading(closing === null ? [] : closingMaterialLines(closing),
    emptyMaterialDraft);
  // The same three balances the warehouse reads, over the offer the branch is deciding (S13): the
  // drawer of the offer, the envelope of the offer and the materials it delivers.
  const balances = closingBalanceStrip({
    cash_counted_cents: rail === null ? null : rail.counted_cents,
    cash_expected_cents: rail === null ? 0n : rail.expected_cents,
    cash_difference_cents: rail === null ? null : rail.difference_cents,
    fund_counted_cents: envelope === null ? null : envelope.counted_cents,
    fund_expected_cents: envelope === null ? null : envelope.expected_cents,
    fund_difference_cents: envelope === null ? null : envelope.difference_cents,
    materials: materialReading,
  });

  /** The arrows move the two tabs of the decision, exactly like the purchases tabs. */
  function moveTab(event: KeyboardEvent<HTMLDivElement>) {
    const next = closingTabAfter(tab, event.key);
    if (next === null) return;
    event.preventDefault();
    setTab(next);
    tabButtons.current[next]?.focus();
  }

  return <section className="closing-workspace closing-decision" aria-labelledby="closing-decision-title">
    <header className="closing-heading">
      <div>
        <small>SUCURSAL / RENDICIÓN DE CUENTAS</small>
        <h1 id="closing-decision-title">{`Rendición de cuentas · ${branchName}`}</h1>
        <p>El Almacén cuenta y propone. Vos aceptás y cerrás, o rechazás con el motivo. Nada se aplica hasta que aceptes.</p>
      </div>
      {closing !== null && <span className={`closing-tag ${closingIsLive(closing.status) ? 'frozen' : 'closed'}`}>
        {closingStatusLabels[closing.status]}
      </span>}
    </header>

    {closing !== null && period !== null && <section className="closing-scope" aria-label="Alcance de la rendición">
      <span className="closing-tag period">{closingPeriodLabel(period)}</span>
      {closingIsLive(closing.status) && <span className="closing-tag frozen">Sucursal congelada</span>}
      {currentRound !== null && <span className="closing-tag">Propuesta {currentRound.round} de {closing.rounds.length}</span>}
      <small className="closing-muted">Sucursal {branchName} · sólo la rendición de esta sucursal</small>
    </section>}

    <p role="status" className="closing-status">{status}</p>
    {problem !== '' && <p role="alert" className="closing-problem">{problem}
      {phase !== 'empty' && <button type="button" disabled={busy}
        onClick={() => setRevision(value => value + 1)}>Recargar la rendición</button>}
    </p>}
    {mismatch && <p role="alert" className="closing-problem">{closingAcceptanceMismatchMessage}</p>}

    {phase === 'loading' && <p role="status" className="closing-muted">Consultando la rendición de la sucursal…</p>}
    {phase === 'empty' && <p className="closing-note">La sucursal no tiene una rendición abierta ni cerrada todavía.</p>}

    {closing !== null && rail !== null && <>
      {readiness !== null && !readiness.awaiting && pendingCorrection === null
        && <p className="closing-readonly">{closing.status === 'closed'
          ? 'La rendición ya está cerrada y no tiene una corrección esperando tu decisión: el Almacén no puede reabrirla.'
          : readiness.reason}</p>}

      {pendingCorrection !== null && correctionPreview !== null
        && <section className="closing-panel closing-correction" aria-labelledby="closing-correction-pending">
          <header className="closing-panel-head">
            <h2 id="closing-correction-pending">Corrección pendiente</h2>
            <span className="closing-tag warn">{closingCorrectionStatusLabels.proposed}</span>
            <small className="closing-muted">Nada se aplica hasta que la aceptes.</small>
          </header>
          <div className="closing-group">
            <p className="closing-round-motive">{pendingCorrection.reason}</p>
            <small>Propuesta por {closingAccountLabel(pendingCorrection.proposed_by_account_id)} el
              {' '}{closingMomentText(pendingCorrection.proposed_at)}</small>
            <div className="closing-table-wrap">
              <table className="closing-table closing-correction-preview">
                <caption className="sr-only">Qué cambiaría la corrección si la aceptás</caption>
                <thead>
                  <tr>
                    <th scope="col">Concepto</th>
                    <th scope="col" className="num">Ahora</th>
                    <th scope="col" className="num">Quedaría</th>
                    <th scope="col" className="num">Cambio</th>
                  </tr>
                </thead>
                <tbody>
                  {correctionPreview.amounts.map(step => <tr key={step.kind} data-kind={step.kind}>
                    <td>{step.label}</td>
                    <td className="num">{closingMoneyText(step.current_cents)}</td>
                    <td className="num">{closingMoneyText(step.proposed_cents)}</td>
                    <td className={`num ${step.delta_cents < 0n ? 'neg' : 'pos'}`}>
                      {closingCorrectionDeltaText(step.delta_cents)}</td>
                  </tr>)}
                  {correctionPreview.counts.map(step => <tr key={`variant-${step.variant_id}`}
                    data-variant-id={step.variant_id}>
                    <td>{step.label}</td>
                    <td className="num">{step.current_quantity}</td>
                    <td className="num">{step.proposed_quantity}</td>
                    <td className={`num ${step.delta < 0 ? 'neg' : 'pos'}`}>
                      {closingCorrectionQuantityDeltaText(step.delta)}</td>
                  </tr>)}
                </tbody>
              </table>
            </div>
            {/* The identities over the drawer the correction would leave: the commission is reported
                beside them and enters none of them, and the expected cash is untouched (S8-S10). */}
            <dl className="closing-summary">
              <div><dt>Caja esperada</dt><dd>{closingMoneyText(correctionPreview.expected_cents)}</dd></div>
              <div><dt>Caja contada con la corrección</dt>
                <dd>{correctionPreview.counted_cents === null ? 'Sin contar'
                  : closingMoneyText(correctionPreview.counted_cents)}</dd></div>
              <div><dt>Diferencia</dt>
                <dd className={correctionPreview.difference_cents === null
                  || correctionPreview.difference_cents === 0n ? 'zero'
                  : correctionPreview.difference_cents < 0n ? 'neg' : 'pos'}>
                  <span>{correctionPreview.difference_cents === null ? 'Sin contar'
                    : closingSignedText(correctionPreview.difference_cents)}</span>
                  {correctionPreview.difference_cents !== null
                    && <span className="closing-difference-name">
                      {closingDifferenceName(correctionPreview.difference_cents)}</span>}
                </dd></div>
              {correctionPreview.contribution_cents > 0n && <div><dt>Aporte del Almacén</dt>
                <dd>{closingMoneyText(correctionPreview.contribution_cents)}</dd></div>}
              <div><dt>Comisión del período</dt>
                <dd>{closingMoneyText(correctionPreview.commission_cents)}</dd></div>
              <div className="total"><dt>Fondo que queda en la caja</dt>
                <dd>{correctionPreview.fund_cents === null ? 'Sin contar'
                  : closingMoneyText(correctionPreview.fund_cents)}</dd></div>
              <div className="total"><dt>Te llevás al Almacén</dt>
                <dd>{correctionPreview.taken_cents === null ? 'Sin contar'
                  : closingMoneyText(correctionPreview.taken_cents)}</dd></div>
            </dl>
            <div className="closing-decision-actions">
              <button type="button" className="primary" disabled={busy}
                onClick={() => void decideCorrection('accepted')}>Aceptar la corrección</button>
              <button type="button" className="closing-reject-toggle" disabled={busy}
                aria-expanded={rejectingCorrection} aria-controls="closing-correction-motive"
                onClick={() => setRejectingCorrection(value => !value)}>Rechazar la corrección</button>
              {rejectingCorrection && <div className="closing-motive" id="closing-correction-motive">
                <label htmlFor="closing-correction-motive-text">Motivo del rechazo de la corrección</label>
                <textarea id="closing-correction-motive-text" rows={3} value={correctionMotive}
                  aria-describedby="closing-correction-motive-help"
                  onChange={event => setCorrectionMotive(event.target.value)} />
                <small id="closing-correction-motive-help">Es obligatorio: sin motivo no se puede rechazar
                  la corrección. Nada se aplica mientras no la aceptes.</small>
                <button type="button" className="closing-reject" disabled={!canRejectCorrection}
                  onClick={() => void decideCorrection('rejected')}>Enviar rechazo de la corrección</button>
              </div>}
            </div>
          </div>
        </section>}

      {acceptedCorrections.length > 0
        && <section className="closing-panel closing-correction" aria-labelledby="closing-correction-accepted">
          <header className="closing-panel-head">
            <h2 id="closing-correction-accepted">Correcciones aceptadas</h2>
            <span className="closing-tag ok">
              {acceptedCorrections.length} {acceptedCorrections.length === 1 ? 'aceptada' : 'aceptadas'}
            </span>
            <small className="closing-muted">Los números corregidos no son los que firmaste: cada uno lleva su delta.</small>
          </header>
          {(correctedAmounts.length > 0 || correctedCounts.length > 0) && <div className="closing-table-wrap">
            <table className="closing-table closing-corrected">
              <caption className="sr-only">Números corregidos del cierre</caption>
              <thead>
                <tr>
                  <th scope="col">Concepto</th>
                  <th scope="col" className="num">Firmado</th>
                  <th scope="col" className="num">Corregido</th>
                  <th scope="col" className="num">Cambio</th>
                </tr>
              </thead>
              <tbody>
                {correctedAmounts.map(amount => <tr key={amount.kind} className="closing-correction-value"
                  data-kind={amount.kind}>
                  <td>{amount.label}</td>
                  <td className="num">{closingMoneyText(amount.signed_cents)}</td>
                  <td className="num corrected">{closingMoneyText(amount.corrected_cents)}
                    <span className="closing-pending">Corregido</span></td>
                  <td className={`num ${amount.delta_cents < 0n ? 'neg' : 'pos'}`}>
                    {closingCorrectionDeltaText(amount.delta_cents)}</td>
                </tr>)}
                {correctedCounts.map(count => <tr key={`variant-${count.variant_id}`}
                  className="closing-correction-value" data-variant-id={count.variant_id}>
                  <td>{count.label}</td>
                  <td className="num">{count.signed_quantity}</td>
                  <td className="num corrected">{count.corrected_quantity}
                    <span className="closing-pending">Corregido</span></td>
                  <td className={`num ${count.delta < 0 ? 'neg' : 'pos'}`}>
                    {closingCorrectionQuantityDeltaText(count.delta)}</td>
                </tr>)}
              </tbody>
            </table>
          </div>}
          <ol className="closing-rounds">{acceptedCorrections.map(entry => <li key={entry.id}>
            <div className="closing-round-head">
              <strong>Corrección #{entry.id}</strong>
              <span className="closing-tag ok">{closingCorrectionStatusLabels.accepted}</span>
            </div>
            <p className="closing-round-motive">{entry.reason}</p>
            <small>Propuesta por {closingAccountLabel(entry.proposed_by_account_id)} el {closingMomentText(entry.proposed_at)}</small>
            {entry.decided_by_account_id !== null && entry.decided_at !== null
              && <small>Aceptada por {closingAccountLabel(entry.decided_by_account_id)} el {closingMomentText(entry.decided_at)}</small>}
          </li>)}</ol>
        </section>}

      {balances.length > 0 && <>
        {/* S13: the branch confirms the three accounts before accepting, and every balance leads to
            the tab it belongs to. No money figure and no kilogram is ever added to another. */}
        <div className="closing-balances" role="group" aria-label={closingBalancesLabel}>
          {balances.map(balance => <button key={balance.key} type="button"
            className={`closing-balance ${balance.tone}`} aria-pressed={tab === balance.tab}
            onClick={() => setTab(balance.tab)}>
            <small>{balance.label}</small>
            <strong className={balance.tone}>{balance.value}</strong>
            <em>{balance.detail}</em>
          </button>)}
        </div>

        <div className="closing-tabs" role="tablist" aria-label={closingTabsLabel} onKeyDown={moveTab}>
          {closingTabOrder.map(key => {
            const marker = closingTabMarker(balances, key);
            return <button key={key} type="button" role="tab" id={`closing-decision-tab-${key}`}
              aria-selected={tab === key} aria-controls={`closing-decision-panel-${key}`}
              tabIndex={tab === key ? 0 : -1}
              ref={element => { tabButtons.current[key] = element; }}
              onClick={() => setTab(key)}>
              {closingTabLabels[key]}
              {marker !== null && <span className="closing-tab-marker">{marker}</span>}
            </button>;
          })}
        </div>
      </>}

      <div className="closing-layout">
        <div>
          <div id="closing-decision-panel-caja" role="tabpanel"
            aria-labelledby="closing-decision-tab-caja" hidden={tab !== 'caja'}>
          <section className="closing-panel" aria-labelledby="closing-decision-changes">
            <header className="closing-panel-head">
              <h2 id="closing-decision-changes">Qué cambia si aceptás</h2>
              {!offerPending && <span className={`closing-tag ${changesCount === 0 ? 'ok' : 'warn'}`}>
                {changesCount === 0 ? 'Sin diferencias de stock'
                  : `${changesCount} ${changesCount === 1 ? 'diferencia' : 'diferencias'} de stock`}
              </span>}
            </header>
            {changes.length === 0
              ? <p className="closing-help">{awaiting
                ? 'La propuesta no cambia ninguna existencia.'
                : offerPending
                  ? 'El Almacén todavía no propuso esta rendición: cuando lo haga vas a ver acá qué cambia.'
                  : 'La rendición no tiene conteo que mostrar.'}</p>
              : <div className="closing-table-wrap">
                <table className="closing-table">
                  <caption className="sr-only">Existencias que cambian al aceptar</caption>
                  <thead>
                    <tr>
                      <th scope="col">Batería</th>
                      <th scope="col" className="num">Sistema</th>
                      <th scope="col" className="num">Contado</th>
                      <th scope="col" className="num">Queda en</th>
                    </tr>
                  </thead>
                  <tbody>{changes.map(change => <tr key={change.variant_id} data-variant-id={change.variant_id}>
                    <td>{change.label}</td>
                    <td className="num">{change.system_quantity}</td>
                    <td className="num">{change.counted_quantity}</td>
                    <td className={`num ${stockDifferenceClass(change)}`}>{change.becomes_quantity}</td>
                  </tr>)}</tbody>
                </table>
              </div>}
            <p className="closing-help">El resto del stock no cambia. Al aceptar, las existencias del sistema quedan <b>exactamente iguales a lo que se contó en el local</b>.</p>
          </section>

          <section className="closing-panel" aria-labelledby="closing-decision-cash">
            <header className="closing-panel-head"><h2 id="closing-decision-cash">Caja y pago</h2></header>
            <div className="closing-group">
              <dl className="closing-summary">
                <div><dt>Fondo heredado</dt><dd>{closingMoneyText(rail.opening_cents)}</dd></div>
                <div><dt>Ventas en efectivo</dt><dd>{closingMoneyText(rail.cash_sales_cents)}</dd></div>
                <div><dt>Gastos cargados</dt>
                  <dd>{rail.cash_expenses_cents === 0n ? closingMoneyText(0n) : `− ${closingMoneyText(rail.cash_expenses_cents)}`}</dd></div>
                <div className="total"><dt>Caja esperada</dt><dd>{closingMoneyText(rail.expected_cents)}</dd></div>
                {rail.contribution_cents !== null && rail.contribution_cents > 0n && (
                  <div><dt>Aporte del Almacén</dt>
                    <dd>{closingMoneyText(rail.contribution_cents)}</dd></div>)}
                <div><dt>Caja contada</dt>
                  <dd>{rail.counted_cents === null ? 'Sin contar' : closingMoneyText(rail.counted_cents)}</dd></div>
                <div><dt>Diferencia</dt>
                  <dd className={rail.difference_cents === null || rail.difference_cents === 0n ? 'zero'
                    : rail.difference_cents < 0n ? 'neg' : 'pos'}>
                    <span>{rail.difference_cents === null ? 'Sin contar' : closingSignedText(rail.difference_cents)}</span>
                    {rail.difference_cents !== null && <span className="closing-difference-name">{closingDifferenceName(rail.difference_cents)}</span>}
                  </dd></div>
                <div><dt>Ventas sobre precio de venta</dt>
                  <dd>{closingMoneyText(rail.sales_total_cents)}</dd></div>
                <div><dt>Comisión del período <small>{closingRateText(rail.rate_percent)}</small></dt>
                  <dd>{closingMoneyText(rail.commission_cents)}</dd></div>
                <div className="total"><dt>Fondo que queda en la caja</dt>
                  <dd>{rail.fund_cents === null ? 'Sin contar' : closingMoneyText(rail.fund_cents)}</dd></div>
              </dl>
              <p className="closing-help">La comisión se calcula sobre todo lo vendido en el período, también lo cobrado por QR: no depende de cómo se pagó. Se informa aparte y no se descuenta de la caja. La diferencia de caja queda registrada tal cual: no se borra al cerrar y no se reparte.</p>
              {/* The expenses the total above is made of, each one with the motive it was recorded with
                  and the note beside it: the branch reads the reason the drawer moved, not only the
                  number it is being charged for (S8, S13). */}
              {closing.expenses.length > 0 && <div className="closing-expenses" role="group"
                aria-label="Gastos del período">
                <h3>Gastos del período</h3>
                <ul>
                  {closing.expenses.map(expense => <li key={expense.id} data-expense-id={expense.id}>
                    <span className="closing-expense-motive">{closingExpenseMotive(expense)}</span>
                    {closingExpenseNote(expense) !== null &&
                      <small className="closing-expense-note closing-muted">
                        {closingExpenseNote(expense)}</small>}
                    {expense.corrects_id !== null && <span className="closing-expense-ref">
                      {`Corrige el gasto #${expense.corrects_id}`}</span>}
                    {/* The pay-out that carries a receipt opens the photo itself; a row without one shows
                        nothing extra, and the acta publishes the metadata alone (S1, S7). */}
                    {expense.evidence !== null && <a className="closing-expense-evidence"
                      href={closingEvidencePath(expense.id)} target="_blank" rel="noreferrer"
                      aria-label={`Ver el comprobante del gasto #${expense.id}`}
                      title={closingEvidenceText(expense.evidence)}>Ver comprobante</a>}
                    <strong className={`num ${expense.kind === 'gasto' ? 'neg' : 'pos'}`}>
                      {closingSignedText(closingExpenseEffect(expense))}</strong>
                  </li>)}
                </ul>
              </div>}
            </div>
            {/* The same block the warehouse reads (ClosingWorkspace), with the offer's own rail: the
                electronic collection is reported on its own and enters no cash identity of the
                drawer, so a branch that collected by transfer never reads an unexplained sobrante
                (S2, S3). */}
            <div className="closing-group">
              <h2>Electrónico · fuera de la caja</h2>
              <dl className="closing-summary">
                <div><dt>Tarjeta</dt><dd>{closingMoneyText(rail.card_cents)}</dd></div>
                <div><dt>Transferencia</dt><dd>{closingMoneyText(rail.transfer_cents)}</dd></div>
                <div><dt>QR</dt><dd>{closingMoneyText(rail.qr_cents)}</dd></div>
              </dl>
              <small className="closing-muted">Ese dinero no está en la caja física: se informa y no se suma a ninguna igualdad de caja.</small>
            </div>
          </section>

          {observation !== '' && <section className="closing-panel" aria-labelledby="closing-decision-observation">
            <header className="closing-panel-head"><h2 id="closing-decision-observation">Observación del Almacén</h2></header>
            <div className="closing-group"><p className="closing-motive-note">{observation}</p></div>
          </section>}
          </div>

          {/* The other tab of the same document: the envelope the branch accepts and the material
              sheet the warehouse counted, both read-only and both inside the one acceptance (S9, S10). */}
          <div id="closing-decision-panel-chatarra" role="tabpanel"
            aria-labelledby="closing-decision-tab-chatarra" hidden={tab !== 'chatarra'}>
          {/* The second envelope the branch accepts, read-only: the warehouse counts it and leaves the
              amount that opens the next period; here the branch reads what it is accepting of it and
              what its purchase fund becomes (S1, S5, S6). */}
          {envelope !== null && <section className="closing-panel"
            aria-labelledby="closing-decision-envelope">
            <header className="closing-panel-head">
              <h2 id="closing-decision-envelope">Fondo de compras</h2>
              <span className="closing-muted">Sobre aparte de la caja</span>
            </header>
            <div className="closing-group">
              <dl className="closing-summary">
                <div><dt>Saldo heredado</dt><dd>{closingMoneyText(envelope.opening_cents)}</dd></div>
                <div><dt>Compras del período</dt>
                  <dd>{closingSignedText(-envelope.purchases_cash_cents)}</dd></div>
                <div><dt>Fondo esperado</dt><dd>{closingMoneyText(envelope.expected_cents)}</dd></div>
                <div><dt>Fondo contado</dt>
                  <dd>{envelope.counted_cents === null ? 'Sin contar'
                    : closingMoneyText(envelope.counted_cents)}</dd></div>
                <div className="total"><dt>Diferencia</dt>
                  <dd className={envelope.difference_cents === null || envelope.difference_cents === 0n
                    ? 'zero' : envelope.difference_cents < 0n ? 'neg' : 'pos'}>
                    <span>{envelope.difference_cents === null ? 'Sin contar'
                      : closingSignedText(envelope.difference_cents)}</span>
                    {envelope.difference_cents !== null
                      && <span className="closing-difference-name">
                        {closingDifferenceName(envelope.difference_cents)}</span>}
                  </dd></div>
              </dl>
              <small className="closing-muted">{closingEnvelopeApartHelp}</small>
            </div>
            <div className="closing-group">
              <h2>Si aceptás</h2>
              <dl className="closing-summary">
                <div className="total"><dt>Tu fondo de compras arranca con</dt>
                  <dd>{envelope.new_cents === null ? 'Sin declarar'
                    : closingMoneyText(envelope.new_cents)}</dd></div>
              </dl>
              <small className="closing-muted">{closingEnvelopeAcceptanceHelp}</small>
            </div>
          </section>}

          {/* The third account the branch is accepting (S7, S8, S9): what the period bought against
              what the warehouse counted, and what acceptance delivers to the warehouse. */}
          <section className="closing-panel" aria-labelledby="closing-decision-materials">
            <header className="closing-panel-head">
              <h2 id="closing-decision-materials">Materiales rendidos</h2>
              <span className={`closing-tag ${materialReading.differing === 0 ? 'ok' : 'warn'}`}>
                {materialReading.empty ? 'Sin materiales'
                  : materialReading.differing === 0 ? 'Sin diferencia'
                    : `${materialReading.differing} ${materialReading.differing === 1
                      ? 'diferencia' : 'diferencias'}`}
              </span>
              <small className="closing-muted">No editable desde la sucursal</small>
            </header>
            {materialReading.empty
              ? <p className="closing-help">{closingMaterialEmptySheet}</p>
              : <>
                <p className="closing-help">{closingMaterialShelfHelp}</p>
                {materialReading.groups.map(group => <div className="closing-materials" key={group.kind}>
                  <table className="closing-table closing-materials-table">
                    <caption>{group.unit === 'kg'
                      ? `${group.label} · kilogramos por material`
                      : `${group.label} · unidades por modelo`}</caption>
                    <thead>
                      <tr>
                        <th scope="col">{group.unit === 'kg' ? 'Material' : 'Modelo'}</th>
                        <th scope="col" className="num">{group.unit === 'kg' ? 'Comprados' : 'Compradas'}</th>
                        <th scope="col" className="num">{group.unit === 'kg' ? 'Contados' : 'Contadas'}</th>
                        <th scope="col" className="num">Dif.</th>
                      </tr>
                    </thead>
                    <tbody>{group.lines.map(row => {
                      const differenceClass = row.difference_milli === null || row.difference_milli === 0n
                        ? 'zero' : row.difference_milli < 0n ? 'neg' : 'pos';
                      return <tr key={row.key} data-material-key={row.key}>
                        <td>{row.label}</td>
                        <td className="num">
                          {closingMaterialQuantityLabel(row.unit, row.line.expected_quantity)}</td>
                        <td className="num">{row.counted_milli === null ? 'Sin contar'
                          : closingMaterialQuantityLabel(row.unit,
                            closingMaterialWireText(row.unit, row.counted_milli))}</td>
                        <td className={`num ${differenceClass}`}>
                          {closingMaterialSignedText(row.unit, row.difference_milli ?? 0n)}</td>
                      </tr>;
                    })}</tbody>
                    {group.lines.length > 1 && <tfoot>
                      <tr>
                        <td>Total</td>
                        <td className="num">{closingMaterialQuantityLabel(group.unit,
                          closingMaterialWireText(group.unit, group.expected_milli))}</td>
                        <td className="num">{group.counted_milli === null ? 'Sin contar'
                          : closingMaterialQuantityLabel(group.unit,
                            closingMaterialWireText(group.unit, group.counted_milli))}</td>
                        <td className={`num ${group.difference_milli === 0n ? 'zero'
                          : group.difference_milli < 0n ? 'neg' : 'pos'}`}>
                          {group.complete
                            ? closingMaterialSignedText(group.unit, group.difference_milli) : '—'}</td>
                      </tr>
                    </tfoot>}
                  </table>
                </div>)}
                <div className="closing-group">
                  <h2>Si aceptás</h2>
                  <dl className="closing-summary">
                    <div><dt>Usadas que se lleva el Almacén</dt>
                      <dd>{materialReading.used.counted_milli === null ? 'Sin contar'
                        : closingMaterialQuantityText('unit', materialReading.used.counted_milli)}</dd></div>
                    <div><dt>Chatarra que se lleva el Almacén</dt>
                      <dd>{materialReading.scrap.counted_milli === null ? 'Sin contar'
                        : `${closingMaterialQuantityText('kg', materialReading.scrap.counted_milli)} kg`}</dd></div>
                    <div className="total"><dt>Queda en tu estantería</dt><dd>cero</dd></div>
                  </dl>
                  <small className="closing-muted">{materialReading.delivery}
                    {' '}{closingMaterialDeliveryHelp}</small>
                </div>
              </>}
          </section>
          </div>
        </div>

        <aside>
          {awaiting && acceptance !== null && <section className="closing-panel" aria-labelledby="closing-decision-answer">
            <header className="closing-panel-head">
              <h2 id="closing-decision-answer">Tu decisión</h2>
              <span className="closing-muted">Propuesta {acceptance.round.round}</span>
            </header>
            <div className="closing-group closing-decision-actions">
              <p>Podés aceptar y cerrar, o rechazar y explicar qué está mal. El Almacén corrige y vuelve a proponer las veces que haga falta.</p>
              <button type="button" className="primary" disabled={busy}
                onClick={() => void decide('accepted')}>Aceptar y cerrar la rendición</button>
              <button type="button" className="closing-reject-toggle" disabled={busy}
                aria-expanded={rejecting} aria-controls="closing-motive"
                onClick={() => setRejecting(value => !value)}>Rechazar la propuesta</button>
              {rejecting && <div className="closing-motive" id="closing-motive">
                <label htmlFor="closing-motive-text">Motivo del rechazo</label>
                <textarea id="closing-motive-text" rows={3} value={motive}
                  aria-describedby="closing-motive-help"
                  onChange={event => setMotive(event.target.value)} />
                <small id="closing-motive-help">Es obligatorio: sin motivo no se puede enviar el rechazo. Queda guardado con tu cuenta y la fecha, y nada se aplica hasta que aceptes.</small>
                <button type="button" className="closing-reject" disabled={!canReject}
                  onClick={() => void decide('rejected')}>Enviar rechazo al Almacén</button>
              </div>}
            </div>
          </section>}

          <section className="closing-panel" aria-labelledby="closing-decision-rounds">
            <header className="closing-panel-head"><h2 id="closing-decision-rounds">Rondas de esta rendición</h2></header>
            <div className="closing-group">
              {closing.rounds.length === 0
                ? <p className="closing-muted">El Almacén todavía no propuso el cierre.</p>
                : <ol className="closing-rounds">{closing.rounds.map(entry => <li key={entry.id}>
                  <div className="closing-round-head">
                    <strong>Propuesta {entry.round}</strong>
                    <span className={`closing-tag ${entry.decision === 'rejected' ? 'short'
                      : entry.decision === 'accepted' ? 'ok' : 'warn'}`}>
                      {closingRoundStateLabel(entry.decision)}
                    </span>
                  </div>
                  <small>Enviada por {closingAccountLabel(entry.proposed_by_account_id)} el {closingMomentText(entry.proposed_at)}</small>
                  {entry.decision !== '' && entry.decided_by_account_id !== null && entry.decided_at !== null
                    && <small>{entry.decision === 'accepted' ? 'Aceptada' : 'Rechazada'} por {closingAccountLabel(entry.decided_by_account_id)} el {closingMomentText(entry.decided_at)}</small>}
                  {entry.decision === 'rejected' && <p className="closing-round-motive">{entry.decision_reason}</p>}
                </li>)}</ol>}
            </div>
          </section>

          <p className="closing-help">Mientras no aceptes, la sucursal <b>no puede vender ni cargar gastos</b>. Si hay algo mal, rechazá cuanto antes: la rendición sigue abierta hasta que la aceptes.</p>
        </aside>
      </div>
    </>}
  </section>;
}
