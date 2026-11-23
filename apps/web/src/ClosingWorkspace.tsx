import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { validSearch, type Location } from './model';
import {
  canonicalCorrection, canonicalCountPayload, canonicalDrawerPayload, closingAccountLabel,
  closingAcceptedCorrections, closingAddLine, closingBalanceStrip, closingBalancesLabel,
  closingBlockReason, closingBlockers,
  closingCatalogueEmpty, closingCatalogueHelp, closingCatalogueHeldTag, closingCatalogueListedTag,
  closingCatalogueOptions, closingCatalogueUnavailable,
  closingCorrectedAmounts, closingCorrectedCounts, closingCorrectionDeltaText,
  closingCorrectionKindLabels, closingCorrectionPreview, closingCorrectionQuantityDeltaText,
  closingCorrectionReasonMessage, closingCorrectionStatusLabels, closingCorrectionValueMessage,
  closingCountChanges, closingDifferenceName, closingEnvelopeApartHelp, closingEnvelopeNewHelp,
  closingIsBatteryLine, closingIsEditable, closingIsLive, closingLineDifference,
  closingLineIsOutsideSystem, closingLineLabel,
  closingCountBatches, closingMaterialClearedMessage, closingMaterialDeliveryHelp,
  closingMaterialEmptySheet, closingMaterialLines, closingMaterialQuantityLabel,
  closingMaterialQuantityText, closingMaterialReading, closingMaterialSeed,
  closingMaterialShelfHelp, closingMaterialSignedText, closingMaterialWireText,
  closingMoneyText, closingMomentText, closingObservationMessage,
  closingPendingCorrection, closingPeriod,
  closingPeriodLabel,
  closingQuantityMessage, closingQuantityText, closingRateText, closingRail,
  closingRemoveLine, closingSearchMessage, closingSheetRows, closingSheetVariantIDs,
  closingSignedText, closingStatusLabels, closingOutsideSystemHelp, closingOutsideSystemTag,
  closingChangedTag, closingCountDifferenceText, closingCountMatchTag, closingCountReading,
  closingEvidencePath, closingEvidenceText,
  closingExpenseEffect, closingExpenseMotive, closingExpenseNote,
  closingSeedQuantity, closingTabAfter, closingTabLabels, closingTabMarker, closingTabOrder,
  closingTabsLabel,
  correctionDraftFrom, drawerDraftFrom,
  drawerView,
  emptyDrawerDraft, emptyMaterialDraft, emptyPurchaseFundDraft, filterCountLines,
  materialDraftFrom, purchaseFundDraftFrom, purchaseFundView,
  type Closing, type ClosingCatalogueVariant, type ClosingCountLine, type ClosingMaterialRow,
  type ClosingRail, type ClosingTab,
  type CorrectionDraft, type CorrectionBody,
  type DrawerDraft, type MaterialDraft, type PurchaseFundDraft,
} from './closingModel';
import {
  ClosingAPIError, closingErrorMessages, closingHistoryUnavailable, closingRefusalMessage,
  createClosingAPI, type ClosingRefusal,
} from './closingsAPI';
import { subscribeClosingInvalidation } from './useInventory';
import './closings.css';

export interface ClosingWorkspaceProps {
  // The parent remounts this section per warehouse session fence, so a rotated session or a
  // CSRF token can never publish an operation into a newer session.
  csrf: string;
  /** The branches this account may settle: the warehouse itself is never one of them. */
  branches: readonly Location[];
  fetcher?: typeof globalThis.fetch;
}

/** The fields the admin is typing; every row starts from the quantity the settlement publishes. */
function countDraftFrom(closing: Closing): Record<number, string> {
  const draft: Record<number, string> = {};
  for (const line of closing.count_lines) draft[line.variant_id] = closingSeedQuantity(line);
  return draft;
}

/** The catalogue search of the sheet: what it read, what it is doing and why it failed. */
interface CatalogueState {
  readonly phase: 'idle' | 'loading' | 'ready' | 'error';
  readonly variants: readonly ClosingCatalogueVariant[];
  readonly problem: string;
}

const emptyCatalogue: CatalogueState = Object.freeze({ phase: 'idle', variants: [], problem: '' });

function sameDrawer(left: DrawerDraft, right: DrawerDraft, leftEnvelope: PurchaseFundDraft,
  rightEnvelope: PurchaseFundDraft): boolean {
  return left.counted === right.counted && left.contribution === right.contribution
    && left.fund === right.fund && left.observation === right.observation
    && leftEnvelope.counted === rightEnvelope.counted
    && leftEnvelope.cash === rightEnvelope.cash;
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
  const [tab, setTab] = useState<ClosingTab>('caja');
  // Whether the branch has a commission the warehouse fixed: read beside the document because
  // the document carries the rate it froze, not the one configured for the next proposal (S5).
  const [commissionMissing, setCommissionMissing] = useState(false);
  const [counted, setCounted] = useState<Record<number, string>>({});
  const [draft, setDraft] = useState<DrawerDraft>(emptyDrawerDraft);
  // The second envelope: its own draft, saved through the same cash draft as the drawer (S1, S5).
  const [envelope, setEnvelope] = useState<PurchaseFundDraft>(emptyPurchaseFundDraft);
  // The third account: the counts of the material sheet, saved beside the drawer (S8).
  const [materials, setMaterials] = useState<MaterialDraft>(emptyMaterialDraft);
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
  // Whether this screen is working on the document right now: an operation in flight, or work typed
  // and not saved yet. A live hint must never read the document again over either of them, because
  // reading it again is what discards the draft; the hint is remembered instead and applied once the
  // screen is idle.
  const working = useRef(false);
  // The frame that arrived while this screen was working: it waits here instead of being lost.
  const waiting = useRef(false);
  // The roving tab index of the two tabs: the tabs are navigation, never two life cycles (S10).
  const tabButtons = useRef<Record<ClosingTab, HTMLButtonElement | null>>({ caja: null, chatarra: null });

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
      setTab('caja');
      setCounted({}); setDraft(emptyDrawerDraft); setEnvelope(emptyPurchaseFundDraft);
      setMaterials(emptyMaterialDraft);
      setCorrection(null); setProblem(''); setStatus('');
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
        // A branch without a configured commission cannot propose: the rail says so, and the
        // button waits for the administration panel instead of a refusal.
        const commission = await api.commission(branch, controller.signal).catch(() => 'unknown' as const);
        if (!alive()) return;
        setCommissionMissing(commission === null);
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
    setEnvelope(purchaseFundDraftFrom(document));
    setMaterials(materialDraftFrom(document));
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
   * Searches the branch's own catalogue for a variant the count sheet does not have: the sheet is the
   * snapshot of the cut, so a battery or a product the branch counted without having it in the system
   * has no row to type into until the admin adds one (S4, S5).
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
    try { drawer = canonicalDrawerPayload(draft, envelope); }
    catch (failure) {
      setStatus('');
      setProblem(failure instanceof Error && failure.message ? failure.message : closingObservationMessage);
      return;
    }
    // A count of the material sheet that cannot be read is named instead of being saved: the two
    // sheets travel together, so the drawer is never written without the counts beside it (S8).
    if (materialReading.problem !== '') {
      setStatus(''); setProblem(materialReading.problem);
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
      // The counts of the materials go in the same draft as the drawer, in their own route: only
      // the lines the warehouse typed, in the shape each kind takes (S8, S10).
      if (materialReading.changes.length > 0) {
        saved = await api.materials(current.id, materialReading.changes, csrf, lifetime.current.signal);
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
    // A row the document already states is never blanked: an empty cell is exactly the "still to
    // count" marker this contract does not have, and the closure always reads a quantity (S1, S2).
    if (value === '' && closingSeedQuantity(line) !== '') {
      setProblem('La cantidad de una variante no se borra, se corrige: la planilla arranca coincidiendo con el sistema.');
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

  /**
   * Moves the selection between the two tabs with the arrows, the one interaction model the screens
   * share with the purchases tabs: the focus follows the tab the arrow selects.
   */
  function moveTab(event: KeyboardEvent<HTMLDivElement>) {
    const next = closingTabAfter(tab, event.key);
    if (next === null) return;
    event.preventDefault();
    setTab(next);
    tabButtons.current[next]?.focus();
  }

  /**
   * Types one counted quantity of the material sheet. A count the document already holds is never
   * blanked — the delivery is exactly what was counted — and a cell that cannot be read is left as
   * it is, so the difference on screen never disagrees with what would be saved (S8, S9).
   */
  function setMaterialValue(row: ClosingMaterialRow, value: string) {
    const shape = row.unit === 'kg' ? /^\d{0,9}(,\d{0,3})?$/ : /^\d{0,9}$/;
    if (!shape.test(value)) return;
    if (value.trim() === '' && closingMaterialSeed(row.line) !== '') {
      setProblem(closingMaterialClearedMessage);
      return;
    }
    setProblem('');
    setMaterials(current => ({ ...current, [row.key]: value }));
  }

  const rail: ClosingRail | null = closing === null ? null : closingRail(closing);
  const view = rail === null ? null : drawerView(rail, draft);
  // The second envelope, over the facts the document publishes and the draft it typed (S1, S5).
  const fund = closing === null ? null : closing.purchase_fund;
  const fundView = fund === null ? null : purchaseFundView(fund, envelope);
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
  // The third account over the draft: its rows, its totals, the head the strip names and the lines
  // that are about to travel with the drawer (S7, S8, S9).
  const materialReading = closingMaterialReading(closing === null ? [] : closingMaterialLines(closing),
    materials);
  // The three balances above the tabs: the drawer, the envelope and the materials, live over the
  // draft and never summed into one another (S13).
  const balances = closingBalanceStrip({
    cash_counted_cents: view === null ? null : view.counted_cents,
    cash_expected_cents: view === null ? 0n : view.expected_cents,
    cash_difference_cents: view === null ? null : view.difference_cents,
    fund_counted_cents: fundView === null ? null : fundView.counted_cents,
    fund_expected_cents: fundView === null ? null : fundView.expected_cents,
    fund_difference_cents: fundView === null ? null : fundView.difference_cents,
    materials: materialReading,
  });
  const unsaved = closing !== null
    && (changed.length > 0 || added.length > 0 || materialReading.unsaved
      || !sameDrawer(draft, drawerDraftFrom(closing), envelope, purchaseFundDraftFrom(closing)));
  working.current = busy || unsaved;

  // The settlement of the branch arrives on the branch's own stream (058): the screen reads its
  // history and its document again instead of waiting for a reload, so a settlement another window
  // opened and a decision the branch made appear here in place (S10).
  useEffect(() => subscribeClosingInvalidation(() => {
    if (!mounted.current || lifetime.current.signal.aborted) return;
    if (working.current) { waiting.current = true; return; }
    setRevision(value => value + 1);
  }), []);

  // A hint that arrived while the sheet was being typed or saved is applied as soon as the screen is
  // idle -- the draft submitted, dismissed or back to the document -- exactly once, so the settlement
  // that changed meanwhile still lands without a reload and without discarding the draft (S10).
  useEffect(() => {
    if (!waiting.current || !mounted.current || lifetime.current.signal.aborted || working.current) return;
    waiting.current = false;
    setRevision(value => value + 1);
  }, [busy, unsaved]);
  const blockers = closing === null || view === null ? [] : closingBlockers(closing, view, unsaved, commissionMissing);
  const blocked = blockers.length > 0;
  const searchValid = validSearch(search);
  const visibleRows = searchValid ? filterCountLines(rows, search) : rows;
  // The count of the draft against the system: purely local, it is neither sent nor stored (S2).
  const countReading = closingCountReading(rows, counted);
  const changedIDs = new Set(countReading.differences.map(entry => entry.variant_id));
  const countTag = countReading.differing === 0
    ? closingCountMatchTag : closingCountDifferenceText(countReading.differing);
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
    {/* With a settlement on screen the refusal belongs beside the action that caused it: the
        button lives in the bottom bar, and an alert rendered at the top of a long sheet is a
        refusal the operator never sees. */}
    {problem !== '' && closing === null && <p role="alert" className="closing-problem">{problem}
      {branch !== 0 && <button type="button" disabled={busy} onClick={() => setRevision(value => value + 1)}>Recargar la rendición</button>}
    </p>}

    {closing !== null && rail !== null && view !== null && <>
      {/* S13: the three balances above the tabs. Each one names its difference — or says there is
          none — in its own unit, and each one selects the tab it belongs to, so the warehouse
          verifies without changing tabs. A kilogram is never added to a peso or to a unit. */}
      <div className="closing-balances" role="group" aria-label={closingBalancesLabel}>
        {balances.map(balance => <button key={balance.key} type="button"
          className={`closing-balance ${balance.tone}`} aria-pressed={tab === balance.tab}
          onClick={() => setTab(balance.tab)}>
          <small>{balance.label}</small>
          <strong className={balance.tone}>{balance.value}</strong>
          <em>{balance.detail}</em>
        </button>)}
      </div>

      {/* One settlement, one closure, one acceptance: the two tabs are navigation (S10). The marker
          of a tab is the difference of its accounts in words, never a bare dot (S13). */}
      <div className="closing-tabs" role="tablist" aria-label={closingTabsLabel} onKeyDown={moveTab}>
        {closingTabOrder.map(key => {
          const marker = closingTabMarker(balances, key);
          return <button key={key} type="button" role="tab" id={`closing-tab-${key}`}
            aria-selected={tab === key} aria-controls={`closing-panel-${key}`}
            tabIndex={tab === key ? 0 : -1}
            ref={element => { tabButtons.current[key] = element; }}
            onClick={() => setTab(key)}>
            {closingTabLabels[key]}
            {marker !== null && <span className="closing-tab-marker">{marker}</span>}
          </button>;
        })}
      </div>

      <div id="closing-panel-caja" role="tabpanel" aria-labelledby="closing-tab-caja"
        hidden={tab !== 'caja'}>
      <div className="closing-layout">
        <section className="closing-panel" aria-labelledby="closing-count-title">
          <header className="closing-panel-head">
            <h2 id="closing-count-title">Conteo de stock</h2>
            <span className={`closing-tag ${countReading.differing === 0 ? 'ok' : 'warn'}`}>
              {countTag}
            </span>
            <small className="closing-muted">
              {countReading.differing === 0
                ? 'La planilla arranca coincidiendo con el sistema: escribí sólo las variantes que no coincidan'
                : 'Las filas marcadas mueven la existencia al cerrar: el resto queda como el sistema lo tiene'}
            </small>
          </header>
          <div className="closing-search">
            <input type="search" aria-label="Buscar en la planilla"
              placeholder="Buscar marca, modelo, nombre o detalle"
              value={search} onChange={event => setSearch(event.target.value)} />
            <small><kbd>Tab</kbd> avanza · <kbd>Enter</kbd> confirma · <kbd>↑</kbd><kbd>↓</kbd> mueven</small>
          </div>
          {!searchValid && <p role="alert" className="closing-problem">{closingSearchMessage}</p>}
          {/* The sheet is the snapshot of the cut, so a variant the system did not have -- a battery or a
              product -- is only countable once the admin adds it from the branch's own catalogue (S4, S5). */}
          {editable && <section className="closing-catalogue" aria-labelledby="closing-catalogue-title">
            <h3 id="closing-catalogue-title">Agregar una batería o un producto que el sistema no tiene</h3>
            <p className="closing-muted">{closingCatalogueHelp}</p>
            <div className="closing-catalogue-search">
              <input type="search" aria-label="Buscar en el catálogo de la sucursal"
                placeholder="Marca, modelo, nombre o detalle" value={catalogueSearch}
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
                  // The row of the catalogue is labelled with the identity of its kind: the battery
                  // attributes of a battery and the name and detail of a product (S3).
                  const chosen = option.variant;
                  const label = closingLineLabel(closingIsBatteryLine(chosen)
                    ? { variant_id: chosen.variant_id, catalog_entry_id: chosen.catalog_entry_id,
                      brand: chosen.brand, model: chosen.model, capacity_ah: chosen.capacity_ah,
                      polarity: chosen.polarity, expected_quantity: 0, counted_quantity: null }
                    : { variant_id: chosen.variant_id, catalog_entry_id: chosen.catalog_entry_id,
                      name: chosen.name, detail: chosen.detail, expected_quantity: 0,
                      counted_quantity: null });
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
                  <th scope="col">Artículo</th>
                  <th scope="col" className="num">Sistema</th>
                  <th scope="col" className="num">Contado</th>
                  <th scope="col" className="num">Dif.</th>
                </tr>
              </thead>
              <tbody onKeyDown={moveFocus}>{visibleRows.map(line => {
                const typed = counted[line.variant_id];
                const difference = draftDifference(line, typed);
                const changedRow = changedIDs.has(line.variant_id);
                // A row added by hand is not a row of the cut: the system had none of it, so it
                // carries no expected quantity and says so at a glance.
                const outside = closingLineIsOutsideSystem(line);
                const removal = added.some(entry => entry.variant_id === line.variant_id);
                const differenceClass = difference === null || difference === 0 ? 'zero'
                  : difference < 0 ? 'neg' : 'pos';
                return <tr key={line.variant_id} data-variant-id={line.variant_id}
                  data-outside={outside ? 'true' : undefined}
                  data-changed={changedRow ? 'true' : undefined}
                  className={[changedRow ? 'changed' : '', outside ? 'outside' : '']
                    .filter(name => name !== '').join(' ') || undefined}>
                  <td>
                    {closingIsBatteryLine(line)
                      ? <>{line.brand}{' '}
                        <small>{line.model} · {line.capacity_ah} Ah · {line.polarity}</small></>
                      : <>{line.name}{' '}
                        <small>{line.detail}</small></>}
                    {outside && <span className="closing-outside" title={closingOutsideSystemHelp}>
                      {closingOutsideSystemTag}</span>}
                    {changedRow && <span className="closing-changed">{closingChangedTag}</span>}
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
            La planilla arranca <b>coincidiendo con el sistema</b>: escribí sólo las variantes que contaste
            distintas y la fila queda marcada como diferencia. Al cerrar, cada variante contada queda con su
            existencia <b>exactamente igual a lo contado</b>. Una fila agregada por vos queda
            <b>fuera del sistema</b>: no lleva cantidad esperada porque la sucursal no la tenía.
          </p>
        </section>

        <aside className="closing-rail" aria-label="Números de la caja">
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
              {/* The expenses the total above is made of, each one with the motive it was recorded with
                  and the note beside it: the warehouse reads what it is subtracting, exactly as the
                  branch reads what it is being charged for (S8, S13). */}
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

            {/* The electronic collection sits with the drawer it explains, before the commission that
                is calculated over it: it is the answer to "the sales say 2,500 and the till holds
                3,000" while the warehouse is counting, not a footnote below the fold. */}
            <div className="closing-group">
              <h2>Electrónico · fuera de la caja</h2>
              <dl className="closing-summary">
                <div><dt>Tarjeta</dt><dd>{closingMoneyText(rail.card_cents)}</dd></div>
                <div><dt>Transferencia</dt><dd>{closingMoneyText(rail.transfer_cents)}</dd></div>
                <div><dt>QR</dt><dd>{closingMoneyText(rail.qr_cents)}</dd></div>
              </dl>
              <small className="closing-muted">Ese dinero no está en la caja física: se informa, no se suma a ninguna igualdad de caja y sí cuenta para la comisión.</small>
            </div>

            <div className="closing-group">
              <h2>Comisión del período</h2>
              <dl className="closing-summary">
                <div><dt>Ventas del período</dt><dd>{closingMoneyText(rail.sales_total_cents)}</dd></div>
                <div><dt>Baterías del período (base)</dt><dd>{rail.commission_base_cents === null
                  ? 'Sin base registrada' : closingMoneyText(rail.commission_base_cents)}</dd></div>
                <div><dt>Porcentaje congelado</dt><dd>{closingRateText(rail.rate_percent)}</dd></div>
                <div className="total"><dt>Comisión</dt><dd>{closingMoneyText(rail.commission_cents)}</dd></div>
              </dl>
              <small className="closing-muted">Sólo las baterías pagan comisión: los demás productos del catálogo no. No depende de cómo se cobró, también lo cobrado por QR, y se informa aparte: no se descuenta de la caja.</small>
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
      </div>

      {/* The third account, read beside the envelope that bought it: the materials of the period
          against what the shelf holds, and the fund the warehouse counted and leaves behind. Both
          are one account of the same settlement, never a second life cycle (S10, S14). */}
      <div id="closing-panel-chatarra" role="tabpanel" aria-labelledby="closing-tab-chatarra"
        hidden={tab !== 'chatarra'}>
        <div className="closing-layout">
          <section className="closing-panel" aria-labelledby="closing-materials-title">
            <header className="closing-panel-head">
              <h2 id="closing-materials-title">Materiales rendidos</h2>
              <span className={`closing-tag ${materialReading.differing === 0 ? 'ok' : 'warn'}`}>
                {materialReading.empty ? 'Sin materiales'
                  : materialReading.differing === 0 ? 'Sin diferencia'
                    : `${materialReading.differing} ${materialReading.differing === 1
                      ? 'diferencia' : 'diferencias'}`}
              </span>
              <small className="closing-muted">Comprado en el período contra lo que hay en la estantería</small>
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
                        <td className="num">{editable
                          ? <input className="count"
                            inputMode={row.unit === 'kg' ? 'decimal' : 'numeric'} placeholder="—"
                            aria-label={row.unit === 'kg'
                              ? `Contados kg de ${row.label}` : `Contadas modelo ${row.label}`}
                            value={materials[row.key] ?? ''}
                            onChange={event => setMaterialValue(row, event.target.value)} />
                          : <span>{row.counted_milli === null ? 'Sin contar'
                            : closingMaterialQuantityLabel(row.unit,
                              closingMaterialWireText(row.unit, row.counted_milli))}</span>}</td>
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
                <p className="closing-help">{materialReading.delivery} {closingMaterialDeliveryHelp}</p>
              </>}
          </section>

          <aside className="closing-rail" aria-label="Números del fondo de compras">
            <section className="closing-panel">
              {/* The purchase fund is the branch's second envelope: counted apart from the drawer, fed
                  by no sale and inside no cash identity (S1, S12). Its count and the amount the
                  warehouse leaves are drafted here and travel in the same cash draft (S5, S6). */}
              {fund !== null && fundView !== null
                ? <div className="closing-group">
                  <h2>Fondo de compras</h2>
                  <dl className="closing-summary">
                    <div><dt>Saldo heredado</dt><dd>{closingMoneyText(fund.opening_cents)}</dd></div>
                    <div><dt>Compras del período</dt>
                      <dd>{closingSignedText(-fund.purchases_cash_cents)}</dd></div>
                    <div className="total"><dt>Fondo esperado</dt>
                      <dd>{closingMoneyText(fundView.expected_cents)}</dd></div>
                  </dl>
                  <div className="closing-field">
                    <label htmlFor="closing-purchase-counted">Fondo contado (Bs)</label>
                    {editable
                      ? <input id="closing-purchase-counted" inputMode="decimal" value={envelope.counted}
                        onChange={event => setEnvelope(current => ({ ...current, counted: event.target.value }))} />
                      : <strong>{fundView.counted_cents === null ? 'Sin contar'
                        : closingMoneyText(fundView.counted_cents)}</strong>}
                    <div className="closing-difference">
                      <small>Diferencia</small>
                      <strong className={fundView.difference_cents === null
                        || fundView.difference_cents === 0n ? 'zero'
                        : fundView.difference_cents < 0n ? 'neg' : 'pos'} aria-live="polite">
                        <span>{fundView.difference_cents === null ? 'Sin contar'
                          : closingSignedText(fundView.difference_cents)}</span>
                        {fundView.difference_cents !== null
                          && <span className="closing-difference-name">
                            {closingDifferenceName(fundView.difference_cents)}</span>}
                      </strong>
                    </div>
                    {fundView.problem !== '' && <small className="closing-muted">{fundView.problem}</small>}
                  </div>
                  <div className="closing-field">
                    <label htmlFor="closing-purchase-cash">Monto nuevo que dejás (Bs)</label>
                    {editable
                      ? <input id="closing-purchase-cash" inputMode="decimal" value={envelope.cash}
                        onChange={event => setEnvelope(current => ({ ...current, cash: event.target.value }))} />
                      : <strong>{fundView.new_cents === null ? 'Sin declarar'
                        : closingMoneyText(fundView.new_cents)}</strong>}
                    <small className="closing-muted">{closingEnvelopeNewHelp}</small>
                  </div>
                  <small className="closing-muted">{closingEnvelopeApartHelp}</small>
                </div>
                : <div className="closing-group">
                  <h2>Fondo de compras</h2>
                  <p className="closing-muted">Esta rendición no publica el sobre del fondo de compras.</p>
                </div>}
            </section>
          </aside>
        </div>
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
                  <th scope="col">Artículo</th>
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
          <span className={`closing-tag ${countReading.differing === 0 ? 'ok' : 'warn'}`}>
            {countTag}
          </span>
          {liveDifference !== null && <span className={`closing-tag ${liveDifference < 0n ? 'short' : 'ok'}`}>
            {`Diferencia de caja ${closingSignedText(liveDifference)}`}
          </span>}
          <small id={reasonID}>{closingBlockReason(blockers)}</small>
          {/* The blocker names its own fix: the panel where the warehouse fixes the rate. */}
          {commissionMissing && <a className="closing-block-link" href="#/administracion/sucursales">
            Configurar la comisión de esta sucursal
          </a>}
          {problem !== '' && <small role="alert" className="closing-bar-problem">{problem}</small>}
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
