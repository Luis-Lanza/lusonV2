import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { validSearch, type Location } from './model';
import {
  canonicalCorrection, canonicalCountPayload, canonicalDrawerPayload, closingAccountLabel,
  closingAcceptedCorrections, closingAddLine, closingBlockReason, closingBlockers,
  closingCatalogueEmpty, closingCatalogueHelp, closingCatalogueHeldTag, closingCatalogueListedTag,
  closingCatalogueOptions, closingCatalogueUnavailable,
  closingCorrectedAmounts, closingCorrectedCounts, closingCorrectionDeltaText,
  closingCorrectionKindLabels, closingCorrectionPreview, closingCorrectionQuantityDeltaText,
  closingCorrectionReasonMessage, closingCorrectionStatusLabels, closingCorrectionValueMessage,
  closingCountChanges, closingDifferenceName, closingIsEditable, closingIsLive, closingLineDifference,
  closingLineIsOutsideSystem, closingLineLabel,
  closingCountBatches, closingMoneyText, closingMomentText, closingObservationMessage,
  closingPendingCorrection, closingPendingTag, closingPeriod,
  closingPeriodLabel,
  closingProgress, closingQuantityMessage, closingQuantityText, closingRateText, closingRail,
  closingRemoveLine, closingSearchMessage, closingSheetRows, closingSheetVariantIDs,
  closingSignedText, closingStatusLabels, closingOutsideSystemHelp, closingOutsideSystemTag,
  correctionDraftFrom, drawerDraftFrom,
  drawerView,
  emptyDrawerDraft, filterCountLines,
  type Closing, type ClosingCatalogueVariant, type ClosingCountLine, type ClosingRail,
  type CorrectionDraft, type CorrectionBody,
  type DrawerDraft,
} from './closingModel';
import {
  ClosingAPIError, closingErrorMessages, closingHistoryUnavailable, closingRefusalMessage,
  createClosingAPI, type ClosingRefusal,
} from './closingsAPI';
import './closings.css';

export interface ClosingWorkspaceProps {
  // The parent remounts this section per warehouse session fence, so a rotated session or a
  // CSRF token can never publish an operation into a newer session.
  csrf: string;
  /** The branches this account may settle: the warehouse itself is never one of them. */
  branches: readonly Location[];
  fetcher?: typeof globalThis.fetch;
}

/** The fields the admin is typing; a field the settlement already holds is restored on load. */
function countDraftFrom(closing: Closing): Record<number, string> {
  const draft: Record<number, string> = {};
  for (const line of closing.count_lines) {
    draft[line.variant_id] = line.counted_quantity === null ? '' : String(line.counted_quantity);
  }
  return draft;
}

/** The catalogue search of the sheet: what it read, what it is doing and why it failed. */
interface CatalogueState {
  readonly phase: 'idle' | 'loading' | 'ready' | 'error';
  readonly variants: readonly ClosingCatalogueVariant[];
  readonly problem: string;
}

const emptyCatalogue: CatalogueState = Object.freeze({ phase: 'idle', variants: [], problem: '' });

function sameDrawer(left: DrawerDraft, right: DrawerDraft): boolean {
  return left.counted === right.counted && left.contribution === right.contribution
    && left.fund === right.fund && left.observation === right.observation;
}

/** The difference of a row over what is typed, so the running difference is never a step behind. */
function draftDifference(line: ClosingCountLine, typed: string | undefined): number | null {
  const text = (typed ?? '').trim();
  if (text === '') return closingLineDifference(line);
  if (!/^\d{1,7}$/.test(text) || Number(text) > 1_000_000) return null;
  return Number(text) - line.expected_quantity;
}

function failureOf(error: unknown): ClosingAPIError {
  return error instanceof ClosingAPIError
    ? error : new ClosingAPIError('invalid_response', null);
}

function refusalMessage(error: ClosingAPIError): string {
  const refusal: ClosingRefusal | null = error.refusal;
  return refusal === null ? closingErrorMessages[error.code] : closingRefusalMessage(refusal);
}

/**
 * The warehouse writes the count sheet and the drawer of one settlement: the expected quantity is
 * the database's snapshot at the cut, the commission is reported beside the drawer and is inside
 * no cash identity, and the offer only leaves once the server's own contract admits it.
 */
export default function ClosingWorkspace({ csrf, branches, fetcher = globalThis.fetch }: ClosingWorkspaceProps) {
  const api = useMemo(() => createClosingAPI(fetcher), [fetcher]);
  const [branch, setBranch] = useState(0);
  const [revision, setRevision] = useState(0);
  const [phase, setPhase] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [historyTotal, setHistoryTotal] = useState(0);
  const [resumed, setResumed] = useState<number | null>(null);
  const [closedView, setClosedView] = useState<number | null>(null);
  const [closing, setClosing] = useState<Closing | null>(null);
  const [counted, setCounted] = useState<Record<number, string>>({});
  const [draft, setDraft] = useState<DrawerDraft>(emptyDrawerDraft);
  const [correction, setCorrection] = useState<CorrectionDraft | null>(null);
  const [search, setSearch] = useState('');
  // The battery the admin counted and the cut did not know: a row the closure honours upward (S5).
  const [added, setAdded] = useState<readonly ClosingCatalogueVariant[]>([]);
  const [catalogueSearch, setCatalogueSearch] = useState('');
  const [catalogue, setCatalogue] = useState<CatalogueState>(emptyCatalogue);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [problem, setProblem] = useState('');
  const mounted = useRef(true);
  const lifetime = useRef(new AbortController());
  const pending = useRef(false);

  useEffect(() => {
    const flight = lifetime.current;
    mounted.current = true;
    return () => { mounted.current = false; flight.abort(); };
  }, []);

  // The settlement the branch already holds is resumed instead of opened again, so the admin
  // never has to guess whether the count sheet is the one on screen.
  useEffect(() => {
    if (branch === 0) {
      setPhase('idle'); setClosing(null); setHistoryTotal(0); setResumed(null); setClosedView(null);
      setCounted({}); setDraft(emptyDrawerDraft); setCorrection(null); setProblem(''); setStatus('');
      setAdded([]); setCatalogue(emptyCatalogue); setCatalogueSearch('');
      return;
    }
    const controller = new AbortController();
    const alive = () => mounted.current && !controller.signal.aborted && !lifetime.current.signal.aborted;
    setPhase('loading'); setProblem(''); setStatus('');
    setClosing(null); setResumed(null); setClosedView(null); setCorrection(null);
    // The rows added for another branch are not rows of this one, and the catalogue is not shared.
    setAdded([]); setCatalogue(emptyCatalogue);
    void (async () => {
      try {
        const page = await api.history(branch, 1, 25, controller.signal);
        if (!alive()) return;
        setHistoryTotal(page.total_closings);
        const live = page.closings.find(row => closingIsLive(row.status));
        // The live settlement is the work of the warehouse; without one, the last closure is what it
        // reads, because that is the document a correction is proposed against (S16).
        const target = live ?? page.closings[0];
        if (target === undefined) { setPhase('ready'); return; }
        const document = await api.detail(target.id, controller.signal);
        if (!alive()) return;
        apply(document);
        if (live) {
          setResumed(document.id);
          setStatus(`La sucursal ya tenía la rendición #${document.id} abierta: la retomamos con su conteo y su caja.`);
        } else {
          setClosedView(document.id);
        }
        setPhase('ready');
      } catch (failure) {
        if (!alive()) return;
        const error = failureOf(failure);
        setPhase('error');
        setProblem(error.code === 'invalid_response' ? closingHistoryUnavailable : refusalMessage(error));
      }
    })();
    return () => controller.abort();
  }, [api, branch, revision]);

  function apply(document: Closing) {
    setClosing(document);
    setCounted(countDraftFrom(document));
    setDraft(drawerDraftFrom(document));
    setCorrection(document.status === 'closed' ? correctionDraftFrom(document) : null);
    // A row the server now holds is a line of the sheet, so it is no longer a local addition.
    setAdded(current => current.filter(line =>
      !document.count_lines.some(row => row.variant_id === line.variant_id)));
    setPhase('ready');
  }

  async function openSettlement() {
    if (branch === 0 || busy || pending.current) return;
    pending.current = true; setBusy(true); setProblem(''); setStatus('Abriendo la rendición…');
    setAdded([]); setCatalogue(emptyCatalogue);
    try {
      const document = await api.open(branch, csrf, lifetime.current.signal);
      if (!mounted.current || lifetime.current.signal.aborted) return;
      apply(document);
      setResumed(null);
      setClosedView(null);
      setHistoryTotal(total => total + 1);
      setStatus(`Rendición #${document.id} abierta: la sucursal queda congelada hasta que la acepte.`);
    } catch (failure) {
      if (!mounted.current || lifetime.current.signal.aborted) return;
      const error = failureOf(failure);
      setStatus('');
      setProblem(refusalMessage(error));
      // A branch that already holds a settlement is not an error to correct: it is the document
      // the admin has to work on, and the server named it.
      if (error.code === 'settlement_live') setRevision(value => value + 1);
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  /**
   * Searches the branch's own catalogue for a battery the count sheet does not have: the sheet is the
   * snapshot of the cut, so a variant the branch counted without having it in the system has no row
   * to type into until the admin adds one (S4, S5).
   */
  async function searchCatalogue() {
    const current = closing;
    if (current === null || busy || pending.current) return;
    if (!validSearch(catalogueSearch)) {
      setCatalogue({ phase: 'error', variants: [], problem: closingSearchMessage });
      return;
    }
    setCatalogue(state => ({ ...state, phase: 'loading', problem: '' }));
    try {
      const variants = await api.catalogue(current.branch_location_id, catalogueSearch.trim(),
        lifetime.current.signal);
      if (!mounted.current || lifetime.current.signal.aborted) return;
      setCatalogue({ phase: 'ready', variants, problem: '' });
    } catch (failure) {
      if (!mounted.current || lifetime.current.signal.aborted) return;
      // The refusal of this read is about the catalogue, never about the settlement: a failure of
      // the settlement's own vocabulary would name the wrong document.
      const error = failureOf(failure);
      setCatalogue({ phase: 'error', variants: [],
        problem: error.code === 'unauthenticated'
          ? closingErrorMessages.unauthenticated : closingCatalogueUnavailable });
    }
  }

  async function save() {
    const current = closing;
    if (!current || busy || pending.current) return;
    if (!closingIsEditable(current.status)) {
      setStatus(''); setProblem('La rendición no admite cambios en este estado.');
      return;
    }
    // A save sends only what was counted: the rows whose count changed, added rows included.
    const changed = closingCountChanges(rows, counted);
    let lines;
    try { lines = changed.length === 0 ? [] : canonicalCountPayload(changed); }
    catch (failure) {
      setStatus('');
      setProblem(failure instanceof Error && failure.message ? failure.message : closingQuantityMessage);
      return;
    }
    let drawer;
    try { drawer = canonicalDrawerPayload(draft); }
    catch (failure) {
      setStatus('');
      setProblem(failure instanceof Error && failure.message ? failure.message : closingObservationMessage);
      return;
    }
    pending.current = true; setBusy(true); setStatus('Guardando el borrador…'); setProblem('');
    let saved: Closing | null = null;
    try {
      // A sheet longer than one request is saved in order, so no counted line is ever left out.
      for (const batch of closingCountBatches(lines)) {
        saved = await api.count(current.id, batch, csrf, lifetime.current.signal);
        if (!mounted.current || lifetime.current.signal.aborted) return;
      }
      const document = await api.cash(current.id, drawer, csrf, lifetime.current.signal);
      if (!mounted.current || lifetime.current.signal.aborted) return;
      apply(document);
      setStatus('Borrador guardado: el conteo y la caja quedan registrados y sobreviven a una recarga.');
    } catch (failure) {
      if (!mounted.current || lifetime.current.signal.aborted) return;
      // What the server already wrote is kept: a refused drawer never discards a saved count.
      if (saved !== null) apply(saved);
      setStatus('');
      setProblem(refusalMessage(failureOf(failure)));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function propose() {
    const current = closing;
    if (!current || busy || pending.current) return;
    pending.current = true; setBusy(true); setStatus('Proponiendo la rendición a la sucursal…'); setProblem('');
    try {
      const document = await api.propose(current.id, csrf, lifetime.current.signal);
      if (!mounted.current || lifetime.current.signal.aborted) return;
      apply(document);
      setStatus('Rendición propuesta a la sucursal: ahora espera su aceptación o su rechazo con motivo.');
    } catch (failure) {
      if (!mounted.current || lifetime.current.signal.aborted) return;
      const error = failureOf(failure);
      setStatus('');
      // The refusal is the server's, named with the fact it is about: the sheet on screen may be
      // older than the settlement the server holds, and only the server knows which one counts.
      setProblem(refusalMessage(error));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  /**
   * Proposes one correction of the closed settlement: the reason and the values that changed, and
   * nothing else. The screen reads the settlement again after it, so what it publishes is the
   * correction the server holds and not a copy the warehouse typed (S16).
   */
  async function proposeCorrection() {
    const current = closing;
    const typed = correction;
    if (!current || typed === null || busy || pending.current) return;
    let body: CorrectionBody;
    try { body = canonicalCorrection(current, typed); }
    catch (failure) {
      setStatus(''); setProblem(failure instanceof Error && failure.message
        ? failure.message : closingCorrectionValueMessage);
      return;
    }
    pending.current = true; setBusy(true); setStatus('Proponiendo la corrección a la sucursal…'); setProblem('');
    try {
      await api.correction(current.id, body, csrf, lifetime.current.signal);
      if (!mounted.current || lifetime.current.signal.aborted) return;
      const document = await api.detail(current.id, lifetime.current.signal);
      if (!mounted.current || lifetime.current.signal.aborted) return;
      apply(document);
      setStatus('Corrección propuesta a la sucursal: espera su aceptación o su rechazo con motivo.');
    } catch (failure) {
      if (!mounted.current || lifetime.current.signal.aborted) return;
      setStatus('');
      setProblem(refusalMessage(failureOf(failure)));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  function setCountedValue(line: ClosingCountLine, value: string) {
    if (!/^\d{0,7}$/.test(value)) return;
    if (value === '' && line.counted_quantity !== null) {
      setProblem('Una variante ya contada conserva su cantidad: el conteo no se borra, se corrige.');
      return;
    }
    setProblem('');
    setCounted(current => ({ ...current, [line.variant_id]: value }));
  }

  function moveFocus(event: KeyboardEvent<HTMLTableSectionElement>) {
    if (event.key !== 'Enter' && event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const inputs = Array.from(event.currentTarget.querySelectorAll<HTMLInputElement>('input'));
    const index = inputs.indexOf(document.activeElement as HTMLInputElement);
    if (index < 0) return;
    const next = event.key === 'ArrowUp' ? index - 1 : index + 1;
    if (next < 0 || next >= inputs.length) return;
    event.preventDefault();
    inputs[next].focus();
  }

  const rail: ClosingRail | null = closing === null ? null : closingRail(closing);
  const view = rail === null ? null : drawerView(rail, draft);
  const editable = closing !== null && closingIsEditable(closing.status);
  // The sheet the admin works on: the snapshot of the cut plus the rows added by hand (S5).
  const rows = closing === null ? [] : closingSheetRows(closing, added);
  const takenIds = closing === null ? new Set<number>() : closingSheetVariantIDs(closing, added);
  const options = closingCatalogueOptions(catalogue.variants, takenIds);
  const addableCount = options.filter(option => option.state === 'addable').length;

  /** Adds one variant of the branch catalogue as a row with no expected quantity at all. */
  function addLine(variant: ClosingCatalogueVariant) {
    try { setAdded(current => closingAddLine(current, variant, takenIds)); }
    catch (failure) {
      setStatus('');
      setProblem(failure instanceof Error && failure.message ? failure.message
        : closingCatalogueEmpty);
    }
  }

  const changed = closing === null ? [] : closingCountChanges(rows, counted);
  const unsaved = closing !== null
    && (changed.length > 0 || added.length > 0 || !sameDrawer(draft, drawerDraftFrom(closing)));
  const blockers = closing === null || view === null ? [] : closingBlockers(closing, view, unsaved, rows);
  const blocked = blockers.length > 0;
  const searchValid = validSearch(search);
  const visibleRows = searchValid ? filterCountLines(rows, search) : rows;
  const progress = closingProgress(rows);
  const reasonID = 'closing-block-reason';
  const period = closing === null ? null : closingPeriod(closing.period_start, closing.cut_at);
  // The rail answers to what is typed, over the facts the settlement holds: the difference and
  // what the warehouse takes move with the draft before anything is saved.
  const liveDifference = view === null ? null : view.difference_cents;
  const liveTaken = view === null ? null : view.taken_cents;
  // The corrections of a closed settlement: what the accepted ones already changed and, when there
  // is one, the correction that still waits for the branch. A live settlement has neither, and no
  // correction figure is ever shown for one (S16).
  const acceptedCorrections = closing === null ? [] : closingAcceptedCorrections(closing);
  const pendingCorrection = closing === null ? null : closingPendingCorrection(closing);
  const correctedAmounts = closing === null ? [] : closingCorrectedAmounts(closing);
  const correctedCounts = closing === null ? [] : closingCorrectedCounts(closing);
  const preview = closing === null ? null : closingCorrectionPreview(closing);
  const correctionIssue: { body: CorrectionBody | null; problem: string } = (() => {
    if (closing === null || correction === null) {
      return { body: null, problem: closingCorrectionValueMessage };
    }
    try { return { body: canonicalCorrection(closing, correction), problem: '' }; }
    catch (failure) {
      return { body: null, problem: failure instanceof Error && failure.message
        ? failure.message : closingCorrectionReasonMessage };
    }
  })();

  return <section className="closing-workspace" aria-labelledby="closing-title">
    <header className="closing-heading">
      <div>
        <small>ALMACÉN / RENDICIONES</small>
        <h1 id="closing-title">{closing === null ? 'Rendición de cuentas' : `Rendición de cuentas · ${closing.branch_name}`}</h1>
        <p>Contá y cargá sin soltar el teclado. Los números del cierre quedan siempre a la vista.</p>
      </div>
      {closing !== null && <span className={`closing-tag ${closingIsLive(closing.status) ? 'live' : 'closed'}`}>
        {closingStatusLabels[closing.status]}
      </span>}
    </header>

    <section className="closing-scope" aria-label="Sucursal a rendir">
      <label htmlFor="closing-branch">Sucursal</label>
      <select id="closing-branch" value={branch === 0 ? '' : String(branch)} disabled={busy}
        onChange={event => setBranch(Number(event.target.value) || 0)}>
        <option value="">Elegí la sucursal que vas a rendir</option>
        {branches.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
      </select>
      {closing !== null && period !== null && <>
        <span className="closing-tag period">{closingPeriodLabel(period)}</span>
        {closingIsLive(closing.status) && <span className="closing-tag frozen">Sucursal congelada</span>}
        {period.empty && <small className="closing-muted">Primera rendición: el período arranca y corta en el mismo instante.</small>}
      </>}
      {resumed !== null && <p role="status" className="closing-note">
        La sucursal ya tenía la rendición #{resumed} abierta: la retomamos.
      </p>}
      {branch !== 0 && phase === 'ready' && (closing === null || closing.status === 'closed') && <>
        <p className="closing-note">
          {closing === null
            ? <>La sucursal no tiene una rendición abierta.{historyTotal > 0
              && ` ${historyTotal} ${historyTotal === 1 ? 'rendición anterior' : 'rendiciones anteriores'}.`}</>
            : <>Mostrando la rendición #{closedView ?? closing.id} cerrada: no se reabre, se corrige con
              aprobación de la sucursal.</>}
        </p>
        <button type="button" className="primary" disabled={busy} onClick={() => void openSettlement()}>
          Abrir rendición de cuentas
        </button>
      </>}
      {phase === 'loading' && <p role="status" className="closing-muted">Consultando las rendiciones de la sucursal…</p>}
    </section>

    <p role="status" className="closing-status">{status}</p>
    {problem !== '' && <p role="alert" className="closing-problem">{problem}
      {branch !== 0 && <button type="button" disabled={busy} onClick={() => setRevision(value => value + 1)}>Recargar la rendición</button>}
    </p>}

    {closing !== null && rail !== null && view !== null && <>
      <div className="closing-layout">
        <section className="closing-panel" aria-labelledby="closing-count-title">
          <header className="closing-panel-head">
            <h2 id="closing-count-title">Conteo de stock</h2>
            <span className={`closing-tag ${progress.pending === 0 ? 'ok' : 'warn'}`}>
              {progress.counted} de {progress.total} {progress.total === 1 ? 'contada' : 'contadas'}
            </span>
            <small className="closing-muted">
              {progress.pending === 0 ? 'Todas las variantes con existencia están contadas'
                : `Quedan ${progress.pending} ${progress.pending === 1 ? 'variante' : 'variantes'} por contar`}
            </small>
          </header>
          <div className="closing-search">
            <input type="search" aria-label="Buscar batería" placeholder="Buscar marca, modelo o amperaje"
              value={search} onChange={event => setSearch(event.target.value)} />
            <small><kbd>Tab</kbd> avanza · <kbd>Enter</kbd> confirma · <kbd>↑</kbd><kbd>↓</kbd> mueven</small>
          </div>
          {!searchValid && <p role="alert" className="closing-problem">{closingSearchMessage}</p>}
          {/* The sheet is the snapshot of the cut, so a battery the system did not have is only
              countable once the admin adds it from the branch's own catalogue (S4, S5). */}
          {editable && <section className="closing-catalogue" aria-labelledby="closing-catalogue-title">
            <h3 id="closing-catalogue-title">Agregar una batería que el sistema no tiene</h3>
            <p className="closing-muted">{closingCatalogueHelp}</p>
            <div className="closing-catalogue-search">
              <input type="search" aria-label="Buscar batería en el catálogo de la sucursal"
                placeholder="Marca, modelo o amperaje" value={catalogueSearch}
                onChange={event => setCatalogueSearch(event.target.value)}
                onKeyDown={event => {
                  if (event.key !== 'Enter') return;
                  event.preventDefault();
                  void searchCatalogue();
                }} />
              <button type="button" disabled={busy || catalogue.phase === 'loading'}
                onClick={() => void searchCatalogue()}>Buscar en el catálogo</button>
            </div>
            {catalogue.phase === 'loading' && <p role="status" className="closing-muted">
              Consultando el catálogo de la sucursal…</p>}
            {catalogue.phase === 'error' && <p role="alert" className="closing-problem">
              {catalogue.problem}</p>}
            {catalogue.phase === 'ready' && addableCount === 0
              && <p className="closing-muted">{closingCatalogueEmpty}</p>}
            {catalogue.phase === 'ready' && options.length > 0
              && <ul className="closing-catalogue-list" aria-label="Variantes del catálogo para agregar">
                {options.map(option => {
                  const label = closingLineLabel({ variant_id: option.variant.variant_id,
                    catalog_entry_id: option.variant.catalog_entry_id, brand: option.variant.brand,
                    model: option.variant.model, capacity_ah: option.variant.capacity_ah,
                    polarity: option.variant.polarity, expected_quantity: 0, counted_quantity: null });
                  return <li key={option.variant.variant_id} data-variant-id={option.variant.variant_id}
                    data-state={option.state}>
                    <span>{label}</span>
                    {option.state === 'addable' && <button type="button" disabled={busy}
                      onClick={() => addLine(option.variant)}>{`Agregar ${label}`}</button>}
                    {option.state === 'listed' && <span className="closing-tag">
                      {closingCatalogueListedTag}</span>}
                    {option.state === 'held' && <span className="closing-tag warn">
                      {closingCatalogueHeldTag}</span>}
                  </li>;
                })}
              </ul>}
          </section>}
          <div className="closing-table-wrap">
            <table className="closing-table">
              <caption className="sr-only">Conteo de stock de {closing.branch_name}</caption>
              <thead>
                <tr>
                  <th scope="col">Batería</th>
                  <th scope="col" className="num">Sistema</th>
                  <th scope="col" className="num">Contado</th>
                  <th scope="col" className="num">Dif.</th>
                </tr>
              </thead>
              <tbody onKeyDown={moveFocus}>{visibleRows.map(line => {
                const typed = counted[line.variant_id];
                const difference = draftDifference(line, typed);
                const pendingRow = line.counted_quantity === null && (typed ?? '') === '';
                // A row added by hand is not a row of the cut: the system had none of it, so it
                // carries no expected quantity and says so at a glance.
                const outside = closingLineIsOutsideSystem(line);
                const removal = added.some(entry => entry.variant_id === line.variant_id);
                const differenceClass = difference === null || difference === 0 ? 'zero'
                  : difference < 0 ? 'neg' : 'pos';
                return <tr key={line.variant_id} data-variant-id={line.variant_id}
                  data-outside={outside ? 'true' : undefined}
                  className={[pendingRow ? 'pending' : '', outside ? 'outside' : '']
                    .filter(name => name !== '').join(' ') || undefined}>
                  <td>
                    {line.brand}{' '}
                    <small>{line.model} · {line.capacity_ah} Ah · {line.polarity}</small>
                    {outside && <span className="closing-outside" title={closingOutsideSystemHelp}>
                      {closingOutsideSystemTag}</span>}
                    {pendingRow && <span className="closing-pending">{closingPendingTag}</span>}
                    {editable && removal && <button type="button" className="closing-unadd" disabled={busy}
                      aria-label={`Quitar ${closingLineLabel(line)} del borrador`}
                      onClick={() => setAdded(current => closingRemoveLine(current, line.variant_id))}>
                      Quitar
                    </button>}
                  </td>
                  <td className="num">{outside ? '—' : line.expected_quantity}</td>
                  <td className="num">{editable
                    ? <input className="count" inputMode="numeric" placeholder="—"
                      aria-label={`Contado de ${closingLineLabel(line)}`} value={typed ?? ''}
                      onChange={event => setCountedValue(line, event.target.value)} />
                    : <span>{line.counted_quantity ?? '—'}</span>}</td>
                  <td className={`num ${differenceClass}`}>{closingQuantityText(difference)}</td>
                </tr>;
              })}</tbody>
            </table>
          </div>
          <p className="closing-help">
            Al cerrar, cada variante contada queda con su existencia <b>exactamente igual a lo contado</b>.
            Las filas marcadas como pendientes todavía no permiten proponer. Una fila agregada por vos
            queda <b>fuera del sistema</b>: no lleva cantidad esperada porque la sucursal no la tenía.
          </p>
        </section>

        <aside className="closing-rail" aria-label="Números de la rendición">
          <section className="closing-panel">
            <div className="closing-group">
              <h2>Caja</h2>
              <dl className="closing-summary">
                <div><dt>Fondo heredado</dt><dd>{closingMoneyText(rail.opening_cents)}</dd></div>
                <div><dt>Ventas en efectivo</dt><dd>{closingMoneyText(rail.cash_sales_cents)}</dd></div>
                <div><dt>Gastos del período</dt>
                  <dd>{rail.cash_expenses_cents === 0n ? closingMoneyText(0n) : `− ${closingMoneyText(rail.cash_expenses_cents)}`}</dd></div>
                <div className="total"><dt>Caja esperada</dt><dd>{closingMoneyText(view.expected_cents)}</dd></div>
              </dl>
              <div className="closing-field">
                <label htmlFor="closing-counted">Caja contada (Bs)</label>
                {editable
                  ? <input id="closing-counted" inputMode="decimal" value={draft.counted}
                    onChange={event => setDraft(current => ({ ...current, counted: event.target.value }))} />
                  : <strong>{view.counted_cents === null ? 'Sin contar' : closingMoneyText(view.counted_cents)}</strong>}
                <div className="closing-difference">
                  <small>Diferencia</small>
                  <strong className={liveDifference === null || liveDifference === 0n ? 'zero'
                    : liveDifference < 0n ? 'neg' : 'pos'} aria-live="polite">
                    <span>{liveDifference === null ? 'Sin contar' : closingSignedText(liveDifference)}</span>
                    {liveDifference !== null && <span className="closing-difference-name">{closingDifferenceName(liveDifference)}</span>}
                  </strong>
                </div>
              </div>
            </div>

            <div className="closing-group">
              <h2>Comisión del período</h2>
              <dl className="closing-summary">
                <div><dt>Ventas sobre precio de venta</dt><dd>{closingMoneyText(rail.sales_total_cents)}</dd></div>
                <div><dt>Porcentaje congelado</dt><dd>{closingRateText(rail.rate_percent)}</dd></div>
                <div className="total"><dt>Comisión</dt><dd>{closingMoneyText(rail.commission_cents)}</dd></div>
              </dl>
              <small className="closing-muted">Sólo baterías nuevas. Se informa aparte: no se descuenta de la caja.</small>
            </div>

            <div className="closing-group">
              <h2>Fondo que queda</h2>
              <div className="closing-field">
                <label htmlFor="closing-fund">Monto que dejás en la caja (Bs)</label>
                {editable
                  ? <input id="closing-fund" inputMode="decimal" value={draft.fund}
                    onChange={event => setDraft(current => ({ ...current, fund: event.target.value }))} />
                  : <strong>{view.fund_cents === null ? 'Sin contar' : closingMoneyText(view.fund_cents)}</strong>}
              </div>
              {/* Beside the fund and not in a panel of its own: the contribution is the money the
                  warehouse puts into the till for this settlement, and it lifts the fund bound. */}
              <div className="closing-field closing-contribution">
                <label htmlFor="closing-contribution">Aporte del Almacén (Bs)</label>
                {editable
                  ? <input id="closing-contribution" inputMode="decimal" value={draft.contribution}
                    onChange={event => setDraft(current => ({ ...current, contribution: event.target.value }))} />
                  : <strong>{view.contribution_cents === null ? 'Sin declarar'
                    : closingMoneyText(view.contribution_cents)}</strong>}
                <small>Plata que ponés en la caja para esta rendición. No es una venta y no entra en la
                  comisión: sólo sube el tope del fondo que podés dejar.</small>
              </div>
              <dl className="closing-summary">
                <div><dt>Caja contada</dt>
                  <dd>{view.counted_cents === null ? 'Sin contar' : closingMoneyText(view.counted_cents)}</dd></div>
                {view.contribution_cents !== null && view.contribution_cents !== 0n && <div>
                  <dt>Aporte del Almacén</dt><dd>{closingMoneyText(view.contribution_cents)}</dd></div>}
                <div><dt>Fondo que queda en la caja</dt>
                  <dd>{view.fund_cents === null ? 'Sin contar' : `− ${closingMoneyText(view.fund_cents)}`}</dd></div>
                <div className="total"><dt>Te llevás al Almacén</dt>
                  <dd>{liveTaken === null ? 'Sin contar' : closingMoneyText(liveTaken)}</dd></div>
              </dl>
            </div>

            <div className="closing-group">
              <h2>Electrónico · fuera de la caja</h2>
              <dl className="closing-summary">
                <div><dt>Tarjeta</dt><dd>{closingMoneyText(rail.card_cents)}</dd></div>
                <div><dt>Transferencia</dt><dd>{closingMoneyText(rail.transfer_cents)}</dd></div>
                <div><dt>QR</dt><dd>{closingMoneyText(rail.qr_cents)}</dd></div>
              </dl>
              <small className="closing-muted">Ese dinero no está en la caja física: se informa y no se suma a ninguna igualdad de caja.</small>
            </div>

            <div className="closing-group">
              <h2>Observación</h2>
              {editable
                ? <div className="closing-field">
                  <label htmlFor="closing-observation">Observación del cierre</label>
                  <textarea id="closing-observation" rows={3} value={draft.observation}
                    onChange={event => setDraft(current => ({ ...current, observation: event.target.value }))} />
                </div>
                : <p className="closing-muted">{closing.observation === '' ? 'Sin observación.' : closing.observation}</p>}
            </div>
          </section>
        </aside>
      </div>

      {closing.status === 'closed' && <section className="closing-panel closing-corrections"
        aria-labelledby="closing-corrections-title">
        <header className="closing-panel-head">
          <h2 id="closing-corrections-title">Correcciones del cierre</h2>
          {pendingCorrection !== null
            ? <span className="closing-tag warn">{closingCorrectionStatusLabels.proposed}</span>
            : acceptedCorrections.length > 0
              ? <span className="closing-tag ok">
                {acceptedCorrections.length} {acceptedCorrections.length === 1 ? 'aceptada' : 'aceptadas'}
              </span>
              : <span className="closing-tag">Sin correcciones</span>}
          <small className="closing-muted">Un cierre no se reabre: se corrige con aprobación de la sucursal.</small>
        </header>

        {acceptedCorrections.length === 0 && pendingCorrection === null
          && <p className="closing-help">El cierre no tiene correcciones: los números de arriba son los que
            la sucursal firmó y ninguno está corregido.</p>}

        {(correctedAmounts.length > 0 || correctedCounts.length > 0) && <div className="closing-table-wrap">
          <table className="closing-table closing-corrected">
            <caption className="sr-only">Números corregidos del cierre</caption>
            <thead>
              <tr>
                <th scope="col">Concepto</th>
                <th scope="col" className="num">Firmado</th>
                <th scope="col" className="num">Corregido</th>
                <th scope="col" className="num">Diferencia</th>
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

        {acceptedCorrections.length > 0 && <div className="closing-group">
          <h2>Correcciones aceptadas</h2>
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
        </div>}

        {pendingCorrection !== null && preview !== null && <div className="closing-group">
          <div className="closing-round-head">
            <strong>Corrección #{pendingCorrection.id}</strong>
            <span className="closing-muted">Todavía no aplicada</span>
          </div>
          <p className="closing-round-motive">{pendingCorrection.reason}</p>
          <small>Propuesta por {closingAccountLabel(pendingCorrection.proposed_by_account_id)} el
            {' '}{closingMomentText(pendingCorrection.proposed_at)}</small>
          <div className="closing-table-wrap">
            <table className="closing-table closing-correction-preview">
              <caption className="sr-only">Qué cambiaría la corrección pendiente</caption>
              <thead>
                <tr>
                  <th scope="col">Concepto</th>
                  <th scope="col" className="num">Ahora</th>
                  <th scope="col" className="num">Quedaría</th>
                  <th scope="col" className="num">Diferencia</th>
                </tr>
              </thead>
              <tbody>
                {preview.amounts.map(step => <tr key={step.kind} data-kind={step.kind}>
                  <td>{step.label}</td>
                  <td className="num">{closingMoneyText(step.current_cents)}</td>
                  <td className="num">{closingMoneyText(step.proposed_cents)}</td>
                  <td className={`num ${step.delta_cents < 0n ? 'neg' : 'pos'}`}>
                    {closingCorrectionDeltaText(step.delta_cents)}</td>
                </tr>)}
                {preview.counts.map(step => <tr key={`variant-${step.variant_id}`} data-variant-id={step.variant_id}>
                  <td>{step.label}</td>
                  <td className="num">{step.current_quantity}</td>
                  <td className="num">{step.proposed_quantity}</td>
                  <td className={`num ${step.delta < 0 ? 'neg' : 'pos'}`}>
                    {closingCorrectionQuantityDeltaText(step.delta)}</td>
                </tr>)}
              </tbody>
            </table>
          </div>
          <p className="closing-help">Nada de esto está aplicado: se aplica sólo si la sucursal acepta.
            Mientras espera su decisión no se puede proponer otra corrección.</p>
        </div>}

        {pendingCorrection === null && correction !== null && <div className="closing-group closing-correction-form">
          <h2>Proponer una corrección</h2>
          <p className="closing-help">Corregí lo que esté mal, con su motivo. La sucursal la acepta o la
            rechaza: el cierre no se reabre y los números publicados son los firmados más lo aceptado.</p>
          <div className="closing-field">
            <label htmlFor="closing-correction-reason">Motivo de la corrección</label>
            <textarea id="closing-correction-reason" rows={3} value={correction.reason}
              onChange={event => setCorrection(current => current === null ? current
                : { ...current, reason: event.target.value })} />
          </div>
          <div className="closing-field">
            <label htmlFor="closing-correction-cash">Caja contada corregida (Bs)</label>
            <input id="closing-correction-cash" inputMode="decimal" value={correction.counted_cash}
              onChange={event => setCorrection(current => current === null ? current
                : { ...current, counted_cash: event.target.value })} />
          </div>
          <div className="closing-field">
            <label htmlFor="closing-correction-commission">Comisión corregida (Bs)</label>
            <input id="closing-correction-commission" inputMode="decimal" value={correction.commission}
              onChange={event => setCorrection(current => current === null ? current
                : { ...current, commission: event.target.value })} />
          </div>
          <div className="closing-field">
            <label htmlFor="closing-correction-fund">Fondo corregido (Bs)</label>
            <input id="closing-correction-fund" inputMode="decimal" value={correction.fund}
              onChange={event => setCorrection(current => current === null ? current
                : { ...current, fund: event.target.value })} />
          </div>
          <div className="closing-table-wrap">
            <table className="closing-table">
              <caption className="sr-only">Conteo corregido de {closing.branch_name}</caption>
              <thead>
                <tr>
                  <th scope="col">Batería</th>
                  <th scope="col" className="num">Sistema</th>
                  <th scope="col" className="num">Firmado</th>
                  <th scope="col" className="num">Corregido</th>
                </tr>
              </thead>
              <tbody>{closing.count_lines.map(line => <tr key={line.variant_id}>
                <td>{closingLineLabel(line)}</td>
                <td className="num">{line.expected_quantity}</td>
                <td className="num">{line.counted_quantity ?? '—'}</td>
                <td className="num">
                  <input className="count" inputMode="numeric"
                    aria-label={`Contado corregido de ${closingLineLabel(line)}`}
                    value={correction.counted[line.variant_id] ?? ''}
                    onChange={event => {
                      const value = event.target.value;
                      if (!/^\d{0,7}$/.test(value)) return;
                      setCorrection(current => current === null ? current
                        : { ...current, counted: { ...current.counted, [line.variant_id]: value } });
                    }} />
                </td>
              </tr>)}</tbody>
            </table>
          </div>
          <div className="closing-bar-action closing-correction-submit">
            <button type="button" className="primary" disabled={busy || correctionIssue.body === null}
              aria-describedby="closing-correction-issue" onClick={() => void proposeCorrection()}>
              Proponer corrección
            </button>
            <small id="closing-correction-issue">{correctionIssue.problem}</small>
          </div>
        </div>}
      </section>}

      <div className="closing-bar" role="region" aria-label="Acciones de la rendición">
        <div className="closing-bar-state">
          <span className={`closing-tag ${progress.pending === 0 ? 'ok' : 'warn'}`}>
            {progress.pending === 0 ? 'Conteo completo' : `Faltan ${progress.pending} ${progress.pending === 1 ? 'variante' : 'variantes'} por contar`}
          </span>
          {liveDifference !== null && <span className={`closing-tag ${liveDifference < 0n ? 'short' : 'ok'}`}>
            {`Diferencia de caja ${closingSignedText(liveDifference)}`}
          </span>}
          <small id={reasonID}>{closingBlockReason(blockers)}</small>
        </div>
        <div className="closing-bar-action">
          <button type="button" disabled={busy || !editable} onClick={() => void save()}>Guardar borrador</button>
          <button type="button" className="primary" disabled={busy || blocked} aria-describedby={reasonID}
            onClick={() => void propose()}>Proponer a la sucursal</button>
        </div>
      </div>
    </>}
  </section>;
}
