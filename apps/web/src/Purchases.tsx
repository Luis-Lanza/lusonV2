import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import TransferDate from './shared/TransferDate';
import { formatMoney, parseTypedMoney, settlement, typedMoney, type PaymentSplit } from './pointOfSaleModel';
import {
  buildPurchaseInput, canonicalPurchaseModelCode, canonicalPurchaseReason, canonicalPurchaseReversalInput,
  formatKg, formatSignedMoney, lineAmountCents, newPurchaseOperationKey,
  parseTypedKg, purchaseDraftProblem, purchaseHistoryDefaultPageSize, purchaseHistoryMaxPage, purchaseHistoryPageSizes,
  purchaseMaxLines, purchaseMaxNote, purchaseMaxReason, purchaseReversible, purchaseSharePercent, purchaseTotalCents,
  typedKg, scrapPurchaseLine, usedPurchaseLine,
  type PurchaseDraft, type PurchaseHistoryRow, type PurchaseLine, type PurchaseReversalInput,
} from './purchaseModel';
import {
  createPurchaseAPI, PurchaseAPIError, purchaseErrorMessages, purchaseFailureIsDefinite, purchaseHistoryUnavailable,
  purchaseModelsUnavailable, purchasePeriodToken, purchaseReceivedUnavailable, type PurchaseBalance,
  type PurchaseDocument, type PurchaseErrorCode, type PurchaseLastPrices, type PurchaseMaterial,
  type PurchasePeriod, type PurchaseReceived, type PurchaseTotals,
} from './purchasesAPI';
import './administration.css';
import './stock-entry.css';

/** The received hero tabs: the two material kinds plus the documents themselves. */
type PurchaseTab = 'used' | 'scrap' | 'documents';
const purchaseTabs: readonly PurchaseTab[] = ['used', 'scrap', 'documents'];

/** The kind of line the open document is composing. */
type DraftKind = 'used' | 'scrap';

interface UsedDraftLine {
  readonly kind: 'used';
  readonly model: string;
  readonly quantity: string;
  readonly price: string;
}
interface ScrapDraftLine {
  readonly kind: 'scrap';
  readonly material_id: number;
  readonly name: string;
  readonly kg: string;
  readonly price: string;
}
type DraftLine = UsedDraftLine | ScrapDraftLine;

interface ReceivedState {
  readonly phase: 'loading' | 'ready' | 'error';
  readonly received: PurchaseReceived | null;
  readonly problem: string;
}
interface CatalogState {
  readonly models: readonly string[];
  readonly materials: readonly PurchaseMaterial[];
  readonly lastPrices: PurchaseLastPrices | null;
  readonly problem: string;
}
interface ListingState {
  readonly phase: 'loading' | 'ready' | 'error';
  readonly rows: readonly PurchaseHistoryRow[];
  readonly total: number;
  readonly periods: readonly PurchasePeriod[];
  readonly period: PurchasePeriod | null;
  readonly totals: PurchaseTotals | null;
  readonly balance: PurchaseBalance | null;
  readonly problem: string;
}
interface ReceiptState {
  readonly phase: 'loading' | 'ready' | 'error';
  readonly document: PurchaseDocument | null;
  readonly problem: string;
}

export interface PurchasesProps {
  // The parent remounts this section per session fence, so a rotated session or
  // CSRF token can never publish a result into a newer branch session.
  csrf: string;
  branch?: string;
  fetcher?: typeof globalThis.fetch;
}

const draftLineKey = (line: DraftLine): string =>
  line.kind === 'used' ? `used:${line.model}` : `scrap:${line.material_id}`;

const draftProblem = 'Revisá el modelo o material, la cantidad y el precio de cada línea.';

function parsedLine(line: DraftLine): PurchaseLine | null {
  try {
    if (line.kind === 'used') {
      return usedPurchaseLine(line.model, Number(line.quantity), parseTypedMoney(line.price));
    }
    return scrapPurchaseLine(line.material_id, line.name, parseTypedKg(line.kg),
      parseTypedMoney(line.price));
  } catch { return null; }
}

function typedCents(text: string): bigint | null {
  if (text.trim() === '') return 0n;
  try { return parseTypedMoney(text); } catch { return null; }
}

/** What a history row received, in the artboard's "1 usada · 1 chatarra" shape. */
function purchaseContent(row: PurchaseHistoryRow): string {
  const parts: string[] = [];
  const units = Math.abs(row.used_units);
  if (units > 0) parts.push(`${units} ${units === 1 ? 'usada' : 'usadas'}`);
  const scrap = Math.abs(row.scrap_lines);
  if (scrap > 0) parts.push(`${scrap} chatarra`);
  return parts.length > 0 ? parts.join(' · ') : 'Sin líneas';
}

const receivedFigure = (value: string, ready: boolean): string => (ready ? value : '—');

/** The payment method the document itself proves; a counter-document keeps its sign. */
function receiptPayment(document: PurchaseDocument): string {
  const cash = document.paid_cash_cents !== 0n;
  const transfer = document.paid_transfer_cents !== 0n;
  if (cash && transfer) return 'Efectivo y transferencia';
  if (cash) return 'Efectivo';
  if (transfer) return 'Transferencia';
  return 'Sin pago';
}

/** The printable receipt is the document, with the whole page kept out of the paper. */
const receiptPrintStyle = `@media print {
  body * { visibility: hidden; }
  .purchase-receipt, .purchase-receipt * { visibility: visible; }
  .purchase-receipt { position: absolute; left: 0; top: 0; width: 100%; padding: 0; }
}`;

export default function Purchases({ csrf, branch = 'esta sucursal', fetcher = globalThis.fetch }: PurchasesProps) {
  const api = useMemo(() => createPurchaseAPI(fetcher), [fetcher]);
  const [tab, setTab] = useState<PurchaseTab>('used');
  const [revision, setRevision] = useState(0);
  const [received, setReceived] = useState<ReceivedState>({ phase: 'loading', received: null, problem: purchaseReceivedUnavailable });
  const [catalog, setCatalog] = useState<CatalogState>({ models: [], materials: [], lastPrices: null, problem: '' });
  const [periodToken, setPeriodToken] = useState<string>('pending');
  const [historyPage, setHistoryPage] = useState(1);
  const [historySize, setHistorySize] = useState(purchaseHistoryDefaultPageSize);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [listing, setListing] = useState<ListingState>({ phase: 'loading', rows: [], total: 0,
    periods: [], period: null, totals: null, balance: null, problem: purchaseHistoryUnavailable });

  const [draftOpen, setDraftOpen] = useState(false);
  const [kind, setKind] = useState<DraftKind>('used');
  const [lines, setLines] = useState<readonly DraftLine[]>([]);
  const [note, setNote] = useState('');
  const [modelText, setModelText] = useState('');
  const [quantityText, setQuantityText] = useState('');
  const [priceText, setPriceText] = useState('');
  const [materialText, setMaterialText] = useState('');
  const [kgText, setKgText] = useState('');
  const [scrapPriceText, setScrapPriceText] = useState('');
  const [cashText, setCashText] = useState('');
  const [draftMessage, setDraftMessage] = useState('');
  const [draftFailure, setDraftFailure] = useState('');
  const [busy, setBusy] = useState(false);

  const [issuedStatus, setIssuedStatus] = useState('');
  const [receipt, setReceipt] = useState<ReceiptState | null>(null);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [detailRevision, setDetailRevision] = useState(0);

  const [reversal, setReversal] = useState<{ row: PurchaseHistoryRow; trigger: HTMLButtonElement } | null>(null);
  const [reversalReason, setReversalReason] = useState('');
  const [reversalProblem, setReversalProblem] = useState('');
  const [reversalBusy, setReversalBusy] = useState(false);

  const lifetime = useRef(new AbortController());
  const mounted = useRef(true);
  const pending = useRef(false);
  // The document opens over the page and gives focus back to the button that opened it.
  const registerTrigger = useRef<HTMLButtonElement>(null);
  const picker = useRef<HTMLInputElement | HTMLSelectElement>(null);
  const documentDialog = useRef<HTMLElement>(null);
  const returnFocus = useRef(false);
  const tabButtons = useRef<Partial<Record<PurchaseTab, HTMLButtonElement | null>>>({});
  // One key per unchanged draft: an uncertain retry replays exactly, an edit becomes a new document.
  const operationKey = useRef<string | null>(null);
  // One key per (target, canonical reason): an uncertain retry replays exactly.
  const reversalAttempt = useRef<{ target: number; reason: string; key: string } | null>(null);

  useEffect(() => {
    const flight = lifetime.current;
    mounted.current = true;
    return () => { mounted.current = false; flight.abort(); };
  }, []);

  useEffect(() => {
    // The counter is the refetch trigger after a purchase or its reversal.
    void revision;
    const controller = new AbortController();
    const alive = () => mounted.current && !controller.signal.aborted && !lifetime.current.signal.aborted;
    setReceived({ phase: 'loading', received: null, problem: purchaseReceivedUnavailable });
    void (async () => {
      try {
        const value = await api.received(controller.signal);
        if (alive()) setReceived({ phase: 'ready', received: value, problem: '' });
      } catch { if (alive()) setReceived({ phase: 'error', received: null, problem: purchaseReceivedUnavailable }); }
    })();
    return () => controller.abort();
  }, [api, revision]);

  useEffect(() => {
    // The counter is the refetch trigger after a purchase or its reversal.
    void revision;
    const controller = new AbortController();
    const alive = () => mounted.current && !controller.signal.aborted && !lifetime.current.signal.aborted;
    void (async () => {
      try {
        const [models, materials, lastPrices] = await Promise.all([
          api.models(controller.signal), api.materials(controller.signal), api.lastPrices(controller.signal),
        ]);
        if (alive()) setCatalog({ models, materials, lastPrices, problem: '' });
      } catch { if (alive()) setCatalog({ models: [], materials: [], lastPrices: null, problem: purchaseModelsUnavailable }); }
    })();
    return () => controller.abort();
  }, [api, revision]);

  useEffect(() => {
    // Both counters are refetch triggers: a new purchase and a retried listing. The period is one
    // read of its own, so the documents, the count and the balance always belong to one answer.
    void revision; void historyRevision;
    const controller = new AbortController();
    const alive = () => mounted.current && !controller.signal.aborted && !lifetime.current.signal.aborted;
    // The selector stays while a period is read; every figure waits for that same answer.
    setListing(current => ({ phase: 'loading', rows: [], total: 0, periods: current.periods,
      period: null, totals: null, balance: null, problem: purchaseHistoryUnavailable }));
    void (async () => {
      try {
        const answer = await api.listing(historyPage, historySize, controller.signal, periodToken);
        if (alive()) setListing({ phase: 'ready', rows: answer.purchases, total: answer.total_purchases,
          periods: answer.periods, period: answer.period, totals: answer.totals,
          balance: answer.balance, problem: '' });
      } catch {
        // An answer this client cannot trust is refused whole: no selector, no figure, no row.
        if (alive()) setListing({ phase: 'error', rows: [], total: 0, periods: [], period: null,
          totals: null, balance: null, problem: purchaseHistoryUnavailable });
      }
    })();
    return () => controller.abort();
  }, [api, historyPage, historySize, historyRevision, revision, periodToken]);

  useEffect(() => {
    // The page behind the open document is attenuated and cannot be reached.
    const backdrop = documentDialog.current?.parentElement;
    if (!draftOpen || !backdrop) return;
    const previous = new Map<Element, string | null>();
    const isolateSiblings = () => {
      for (let branchElement: Element | null = backdrop; branchElement && branchElement !== document.body;
        branchElement = branchElement.parentElement) {
        for (const sibling of branchElement.parentElement?.children ?? []) {
          if (sibling === branchElement || previous.has(sibling)) continue;
          previous.set(sibling, sibling.getAttribute('inert'));
          if (!sibling.hasAttribute('inert')) sibling.setAttribute('inert', '');
        }
      }
    };
    isolateSiblings();
    return () => {
      for (const [element, value] of previous) {
        if (value === null) element.removeAttribute('inert');
        else element.setAttribute('inert', value);
      }
    };
  }, [draftOpen]);

  // The document opens on its picker and returns focus to its trigger when it closes.
  useEffect(() => {
    if (draftOpen) { picker.current?.focus(); return; }
    if (!returnFocus.current) return;
    returnFocus.current = false;
    if (registerTrigger.current?.isConnected) registerTrigger.current.focus();
  }, [draftOpen]);

  useEffect(() => {
    if (detailId === null) return;
    // The retry counter is read here so a failed receipt can be asked for again.
    void detailRevision;
    const controller = new AbortController();
    const alive = () => mounted.current && !controller.signal.aborted && !lifetime.current.signal.aborted;
    void (async () => {
      try {
        const document = await api.detail(detailId, controller.signal);
        if (alive() && document.id === detailId) setReceipt({ phase: 'ready', document, problem: '' });
      } catch (failure) {
        if (!alive()) return;
        const code: PurchaseErrorCode = failure instanceof PurchaseAPIError ? failure.code : 'invalid_response';
        setReceipt({ phase: 'error', document: null, problem: purchaseErrorMessages[code] });
      }
    })();
    return () => controller.abort();
  }, [api, detailId, detailRevision]);

  function forgetAttempt() { operationKey.current = null; }
  function resetForms() {
    setModelText(''); setQuantityText(''); setPriceText('');
    setMaterialText(''); setKgText(''); setScrapPriceText('');
  }
  function openDraft() {
    if (busy) return;
    forgetAttempt();
    setLines([]); setNote(''); setCashText('');
    setDraftMessage(''); setDraftFailure('');
    // The document opens on the kind the operator was looking at.
    setKind(tab === 'scrap' ? 'scrap' : 'used');
    resetForms();
    returnFocus.current = true;
    setDraftOpen(true);
  }
  function closeDraft() {
    if (busy) return;
    setDraftOpen(false);
    setDraftMessage(''); setDraftFailure('');
  }
  function dismissDocument() {
    if (busy) return;
    returnFocus.current = true;
    closeDraft();
  }

  function addLine(line: PurchaseLine) {
    const entry: DraftLine = line.kind === 'used'
      ? { kind: 'used', model: line.model, quantity: String(line.quantity),
        price: typedMoney(line.unit_price_cents) }
      : { kind: 'scrap', material_id: line.material_id, name: line.name,
        kg: typedKg(line.kg_milli), price: typedMoney(line.price_per_kg_cents) };
    const key = draftLineKey(entry);
    const index = lines.findIndex(current => draftLineKey(current) === key);
    if (index >= 0) {
      setLines(lines.map((current, position) => position === index ? entry : current));
    } else {
      const sameKind = lines.filter(current => current.kind === entry.kind).length;
      if (sameKind >= purchaseMaxLines) {
        setDraftFailure(`Una compra lleva como máximo ${purchaseMaxLines} líneas de cada tipo.`);
        return false;
      }
      setLines([...lines, entry]);
    }
    setDraftFailure('');
    setDraftMessage('');
    return true;
  }

  function addUsed() {
    try {
      const line = usedPurchaseLine(modelText, Number(quantityText), parseTypedMoney(priceText));
      if (addLine(line)) resetForms();
    } catch { setDraftFailure(draftProblem); }
  }

  function addScrap() {
    const material = catalog.materials.find(entry => String(entry.id) === materialText);
    if (!material) { setDraftFailure('Elegí un material de la lista.'); return; }
    try {
      const kgMilli = parseTypedKg(kgText);
      const line = scrapPurchaseLine(material.id, material.name, kgMilli, parseTypedMoney(scrapPriceText));
      if (addLine(line)) { setKgText(''); resetForms(); }
    } catch { setDraftFailure(draftProblem); }
  }

  function updateLine(line: DraftLine, field: 'quantity' | 'price' | 'kg', value: string) {
    const allowed = field === 'kg' ? /^\d{0,3}(?:(\.\d{0,3})|(,\d{0,3}))?$/ : field === 'quantity' ? /^\d{0,7}$/ : null;
    if (allowed && !allowed.test(value)) return;
    forgetAttempt();
    setDraftFailure('');
    setLines(current => current.map(entry => draftLineKey(entry) === draftLineKey(line)
      ? { ...entry, [field]: value } as DraftLine : entry));
  }

  function removeLine(line: DraftLine) {
    forgetAttempt();
    setDraftFailure('');
    setLines(lines.filter(current => draftLineKey(current) !== draftLineKey(line)));
  }

  const parsed = lines.map(parsedLine);
  const allLinesValid = parsed.every((line): line is PurchaseLine => line !== null);
  const totalCents = purchaseTotalCents(parsed.filter((line): line is PurchaseLine => line !== null));
  const noteValid = Array.from(note).length <= purchaseMaxNote;
  const cashCents = typedCents(cashText);
  // A branch purchase is paid in cash from the purchase fund, so the transfer side of the
  // settlement is always zero and the total is derived from the cash actually paid: the two
  // amounts of the document are not interchangeable.
  const split: PaymentSplit | null = cashCents === null
    ? null : { cash_cents: cashCents, transfer_cents: 0n };
  const settlementState = split === null ? null : settlement(totalCents, split);
  const settled = settlementState?.status === 'exact';
  const canConfirm = !busy && lines.length > 0 && allLinesValid && noteValid && settled && totalCents > 0n;

  const settlementMessage = split === null
    ? 'Escribí un monto válido, con hasta dos decimales.'
    : settlementState?.status === 'exact'
      ? `Suma ${formatMoney(totalCents)} · cubre el total`
      : settlementState?.status === 'missing'
        ? `Faltan ${formatMoney(settlementState.remaining)} para cubrir el total.`
        : settlementState === null ? '' : `Sobran ${formatMoney(settlementState.excess)}: la suma no puede superar el total.`;

  const anchorModel = (() => {
    try { return canonicalPurchaseModelCode(modelText); } catch { return ''; }
  })();
  const anchorModelPrice = anchorModel === '' ? undefined
    : catalog.lastPrices?.models.find(price => price.model === anchorModel);
  const anchorMaterial = catalog.materials.find(entry => String(entry.id) === materialText);
  const anchorMaterialPrice = anchorMaterial === undefined ? undefined
    : catalog.lastPrices?.materials.find(price => price.material_id === anchorMaterial.id);

  // The line being typed, priced as it is typed, before it joins the document.
  const pendingLineCents = (() => {
    try {
      if (kind === 'used') {
        return lineAmountCents(usedPurchaseLine(modelText, Number(quantityText), parseTypedMoney(priceText)));
      }
      const material = catalog.materials.find(entry => String(entry.id) === materialText);
      if (!material) return null;
      return lineAmountCents(scrapPurchaseLine(material.id, material.name, parseTypedKg(kgText),
        parseTypedMoney(scrapPriceText)));
    } catch { return null; }
  })();

  async function confirmPurchase() {
    if (busy || pending.current) return;
    if (!lines.length) { setDraftFailure('Agregá al menos una línea antes de confirmar la compra.'); return; }
    if (!allLinesValid) { setDraftFailure(draftProblem); return; }
    if (!noteValid) { setDraftFailure(`La nota lleva hasta ${purchaseMaxNote} caracteres.`); return; }
    if (cashCents === null) {
      setDraftFailure('Escribí un monto válido para el efectivo del fondo de compras.'); return;
    }
    const draft: PurchaseDraft = { lines: parsed.filter((line): line is PurchaseLine => line !== null), note,
      cash_cents: cashCents, transfer_cents: 0n };
    const problem = purchaseDraftProblem(draft);
    if (problem !== null) { setDraftFailure(problem); return; }
    if (operationKey.current === null) {
      try { operationKey.current = newPurchaseOperationKey(); }
      catch { setDraftFailure('No se pudo generar una clave segura para esta compra. No se envió nada.'); return; }
    }
    let input: ReturnType<typeof buildPurchaseInput>;
    try { input = buildPurchaseInput(draft, operationKey.current); }
    catch { setDraftFailure('El documento no es válido. Revisá las líneas y el pago.'); return; }
    pending.current = true; setBusy(true); setDraftFailure(''); setDraftMessage('Registrando la compra…');
    try {
      const document = await api.create(input, csrf, lifetime.current.signal);
      if (!mounted.current || lifetime.current.signal.aborted) return;
      forgetAttempt();
      // The receipt opens next; focus does not fall back to the trigger behind it.
      returnFocus.current = false;
      setDraftOpen(false); setDraftMessage(''); setDraftFailure('');
      setRevision(value => value + 1); setHistoryPage(1); setHistoryRevision(value => value + 1);
      setReceipt({ phase: 'ready', document, problem: '' });
      setIssuedStatus(`Compra registrada: documento #${document.id} · ${formatSignedMoney(document.total_cents)}.`);
    } catch (failure) {
      if (!mounted.current || lifetime.current.signal.aborted) return;
      const code: PurchaseErrorCode = failure instanceof PurchaseAPIError ? failure.code : 'invalid_response';
      if (purchaseFailureIsDefinite(code)) forgetAttempt();
      setDraftMessage(''); setDraftFailure(purchaseErrorMessages[code]);
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  // ---- reversal ---------------------------------------------------------------
  function openReversal(row: PurchaseHistoryRow, trigger: HTMLButtonElement) {
    if (reversal || reversalBusy || !purchaseReversible(row)) return;
    reversalAttempt.current = null;
    setReversal({ row, trigger }); setReversalReason(''); setReversalProblem('');
  }
  function closeReversal() {
    if (reversalBusy) return;
    const trigger = reversal?.trigger;
    setReversal(null); setReversalReason(''); setReversalProblem('');
    if (trigger?.isConnected) trigger.focus();
  }
  async function confirmReversal() {
    const open = reversal;
    if (!open || reversalBusy || pending.current) return;
    let canonicalReason: string;
    try { canonicalReason = canonicalPurchaseReason(reversalReason); }
    catch { setReversalProblem(`El motivo es obligatorio: escribí entre 1 y ${purchaseMaxReason} caracteres.`); return; }
    if (reversalAttempt.current === null || reversalAttempt.current.target !== open.row.id
      || reversalAttempt.current.reason !== canonicalReason) {
      try {
        reversalAttempt.current = { target: open.row.id, reason: canonicalReason, key: newPurchaseOperationKey() };
      } catch { setReversalProblem('No se pudo generar una clave segura. No se envió nada.'); return; }
    }
    const attempt = reversalAttempt.current;
    let input: PurchaseReversalInput;
    try { input = canonicalPurchaseReversalInput({ operation_key: attempt.key, reason: canonicalReason }); }
    catch { setReversalProblem('El motivo de la anulación no es válido. Revisá el texto e intentá de nuevo.'); return; }
    pending.current = true; setReversalBusy(true); setReversalProblem('');
    try {
      const document = await api.reverse(open.row, input, csrf, lifetime.current.signal);
      if (!mounted.current || lifetime.current.signal.aborted) return;
      reversalAttempt.current = null;
      setReversal(null); setReversalReason('');
      setRevision(value => value + 1); setHistoryPage(1); setHistoryRevision(value => value + 1);
      setIssuedStatus(`Anulación registrada: contra-documento #${document.id} de la compra #${open.row.id}.`);
    } catch (failure) {
      if (!mounted.current || lifetime.current.signal.aborted) return;
      const code: PurchaseErrorCode = failure instanceof PurchaseAPIError ? failure.code : 'invalid_response';
      if (purchaseFailureIsDefinite(code)) reversalAttempt.current = null;
      if (code === 'not_found' || code === 'already_reversed') {
        setReversal(null); setReversalReason('');
        setRevision(value => value + 1); setHistoryRevision(value => value + 1);
        setIssuedStatus(purchaseErrorMessages[code]);
      } else {
        setReversalProblem(purchaseErrorMessages[code]);
      }
    } finally {
      pending.current = false;
      if (mounted.current) setReversalBusy(false);
    }
  }

  // ---- receipt ----------------------------------------------------------------
  function openDetail(row: PurchaseHistoryRow) {
    setDetailId(row.id);
    setReceipt({ phase: 'loading', document: null, problem: '' });
  }
  function closeReceipt() {
    setReceipt(null); setDetailId(null);
  }

  const used = received.received?.used ?? [];
  const scrap = received.received?.scrap ?? [];
  const rows = listing.rows;
  const receivedReady = received.phase === 'ready';
  // The listing is the only answer that says which period is on screen, so nothing is described
  // before it arrives: a figure under the wrong period is worse than no figure.
  const listingReady = listing.phase === 'ready' && listing.period !== null;
  const pendingView = listingReady && listing.period?.kind === 'pending';
  const balance = pendingView ? listing.balance : null;
  const pendingUsedRows = balance?.used ?? [];
  const pendingScrapRows = balance?.scrap ?? [];
  // A key whose balance is zero is not a position: it disappears from the pending reading while
  // the bought and delivered figures that explain the zero stay in the header.
  const pendingUsed = pendingUsedRows.filter(row => row.balance !== 0);
  const pendingScrap = pendingScrapRows.filter(row => row.balance_milli !== 0n);
  const pendingUnits = pendingUsedRows.reduce((sum, row) => sum + row.balance, 0);
  const pendingBought = pendingUsedRows.reduce((sum, row) => sum + row.bought, 0);
  const pendingDelivered = pendingUsedRows.reduce((sum, row) => sum + row.delivered, 0);
  const pendingKg = pendingScrapRows.reduce((sum, row) => sum + row.balance_milli, 0n);
  const pendingBoughtKg = pendingScrapRows.reduce((sum, row) => sum + row.bought_milli, 0n);
  const pendingDeliveredKg = pendingScrapRows.reduce((sum, row) => sum + row.delivered_milli, 0n);
  // The three numbers of the band are the totals of the chosen period, for every period: a window
  // states what it received and the pending one what the branch still holds, so nothing on the band is
  // a number of another period and nothing needs to say "acumulado".
  const overviewReady = listingReady;
  const totals = listing.totals;
  const periodUnits = totals?.used_units ?? 0;
  const periodKg = totals?.scrap_kg_milli ?? 0n;
  const periodMoney = totals?.money_cents ?? null;
  // The tabs still read the received detail row by row, so their counts wait for that answer; the
  // pending tabs read the balance and need nothing else.
  const detailReady = pendingView || (listingReady && receivedReady);
  const usedUnits = used.reduce((sum, row) => sum + row.quantity, 0);
  const usedValue = used.reduce((sum, row) => sum + row.value_cents, 0n);
  const scrapKg = scrap.reduce((sum, row) => sum + row.kg_milli, 0n);
  const scrapValue = scrap.reduce((sum, row) => sum + row.value_cents, 0n);
  /** A material of the balance is named by the reference table the catalog already asked for. */
  const materialName = (id: number): string =>
    catalog.materials.find(entry => entry.id === id)?.name ?? `Material #${id}`;
  const documentsCount = listingReady
    ? `${listing.total} ${listing.total === 1 ? 'documento' : 'documentos'}` : 'Documentos';
  const historyCount = listingReady
    ? `${listing.total} ${listing.total === 1 ? 'compra' : 'compras'}` : 'Sucursal';
  const usedCount = pendingView ? `${pendingUnits} u.` : `${usedUnits} u. · ${formatMoney(usedValue)}`;
  const scrapCount = pendingView ? formatKg(pendingKg) : `${formatKg(scrapKg)} · ${formatMoney(scrapValue)}`;
  const documentsTabCount = listingReady ? String(listing.total) : '…';
  const nextHistoryPage = () => {
    if (historyPage < purchaseHistoryMaxPage && historyPage * historySize < listing.total) {
      setHistoryPage(historyPage + 1);
    }
  };
  const moveTab = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const index = purchaseTabs.indexOf(tab);
    const next = purchaseTabs[(index + (event.key === 'ArrowRight' ? 1 : purchaseTabs.length - 1))
      % purchaseTabs.length];
    setTab(next);
    tabButtons.current[next]?.focus();
  };

  return <section className="stock-entry purchases" aria-labelledby="purchases-title">
    <header className="purchases-heading"><h1 id="purchases-title">Compras</h1></header>
    {/* Only after a document is issued; never a permanent row above the metrics. */}
    {issuedStatus !== '' && <p role="status" className="stock-status">{issuedStatus}</p>}

    <section className="purchases-received" aria-labelledby="purchase-received-title"
      aria-busy={received.phase === 'loading'}>
      <h2 id="purchase-received-title" className="sr-only">Resumen del período</h2>

      <dl className="purchases-metrics">
        {pendingView ? <>
          <div className="purchases-metric purchases-metric-total">
            <dt>Baterías usadas</dt>
            <dd>{receivedFigure(`${periodUnits} u.`, overviewReady)}</dd>
            <span className="purchases-metric-sub">{overviewReady
              ? `${pendingBought} compradas · ${pendingDelivered} entregadas` : 'Lo que queda en la sucursal'}</span>
          </div>
          <div className="purchases-metric">
            <dt>Chatarra</dt>
            <dd>{receivedFigure(formatKg(periodKg), overviewReady)}</dd>
            <span className="purchases-metric-sub">{overviewReady
              ? `${formatKg(pendingBoughtKg)} compradas · ${formatKg(pendingDeliveredKg)} entregadas`
              : 'Materiales por kilogramo'}</span>
          </div>
          <div className="purchases-metric">
            <dt>Documentos</dt>
            <dd>{receivedFigure(String(listing.total), overviewReady)}</dd>
            <span className="purchases-metric-sub">lo registrado en la sucursal, sin filtro</span>
          </div>
        </> : <>
          <div className="purchases-metric purchases-metric-total">
            <dt>Total recibido</dt>
            <dd>{receivedFigure(periodMoney === null ? '—' : formatMoney(periodMoney), overviewReady)}</dd>
            <span className="purchases-metric-sub">{overviewReady
              ? `${documentsCount} · lo que salió de caja` : 'Lo que salió de caja'}</span>
          </div>
          <div className="purchases-metric">
            <dt>Baterías usadas</dt>
            <dd>{receivedFigure(`${periodUnits} u.`, overviewReady)}</dd>
            <span className="purchases-metric-sub">{overviewReady
              ? 'no se revenden' : 'Lo que entró por modelo'}</span>
          </div>
          <div className="purchases-metric">
            <dt>Chatarra</dt>
            <dd>{receivedFigure(formatKg(periodKg), overviewReady)}</dd>
            <span className="purchases-metric-sub">{overviewReady
              ? 'cobre, aluminio, plomo y bronce' : 'Materiales por kilogramo'}</span>
          </div>
        </>}
      </dl>

      <div className="purchases-period">
        {listing.phase === 'error' && <p className="stock-message" role="alert">{listing.problem}
          <button type="button" onClick={() => setHistoryRevision(value => value + 1)}>Reintentar historial</button></p>}
        {listing.phase !== 'error' && listing.periods.length === 0
          && <p className="stock-message" role="status">Consultando los períodos de la sucursal…</p>}
        {listing.phase !== 'error' && listing.periods.length > 0 && <>
          <div className="page-controls">
            <label htmlFor="purchases-period">Período</label>
            <select id="purchases-period" value={periodToken}
              onChange={event => {
                const chosen = event.target.value;
                // Only a period this server published can be asked for.
                if (!listing.periods.some(entry => purchasePeriodToken(entry) === chosen)) return;
                setHistoryPage(1);
                setPeriodToken(chosen);
              }}>
              {listing.periods.map(entry => <option key={purchasePeriodToken(entry)}
                value={purchasePeriodToken(entry)}>{entry.label}</option>)}
            </select>
            {/* One line, in words, never a tooltip: which period is on screen, whether it is closed
                and where it was cut. Nothing on this page is a total of an unnamed period. */}
            <p className="stock-hint" role="status">
              {!listingReady ? 'Consultando el período elegido…'
                : listing.period?.kind === 'pending'
                  ? `${listing.period.label} · saldo abierto, sin corte: lo comprado menos lo que contaron las rendiciones cerradas.`
                  : listing.period?.kind === 'all'
                    ? `${listing.period.label} · sin corte: todos los documentos registrados en la sucursal.`
                    : <>{`${listing.period?.label} · ${listing.period?.kind === 'settlement' ? 'cerrada' : 'abierta'}`}
                      {` · ${listing.period?.kind === 'settlement' ? 'corte' : 'corte previsto'} `}
                      <TransferDate value={listing.period?.to} />
                      {', período desde '}
                      <TransferDate value={listing.period?.from} />
                      {'. Los números y los documentos son los de este período.'}</>}
            </p>
          </div>
        </>}
      </div>

      <div className="purchases-tabs-row">
        <div className="purchases-tabs" role="tablist" aria-label="Materiales y documentos del período"
          onKeyDown={moveTab}>
          <button ref={element => { tabButtons.current.used = element; }} type="button" role="tab"
            id="purchases-tab-used" aria-selected={tab === 'used'} aria-controls="purchases-panel-used"
            tabIndex={tab === 'used' ? 0 : -1} onClick={() => setTab('used')}>
            Baterías usadas <span className="count">{detailReady ? usedCount : '…'}</span>
          </button>
          <button ref={element => { tabButtons.current.scrap = element; }} type="button" role="tab"
            id="purchases-tab-scrap" aria-selected={tab === 'scrap'} aria-controls="purchases-panel-scrap"
            tabIndex={tab === 'scrap' ? 0 : -1} onClick={() => setTab('scrap')}>
            Chatarra <span className="count">{detailReady ? scrapCount : '…'}</span>
          </button>
          <button ref={element => { tabButtons.current.documents = element; }} type="button" role="tab"
            id="purchases-tab-documents" aria-selected={tab === 'documents'}
            aria-controls="purchases-panel-documents" tabIndex={tab === 'documents' ? 0 : -1}
            onClick={() => setTab('documents')}>
            Documentos <span className="count">{documentsTabCount}</span>
          </button>
        </div>
        <button ref={registerTrigger} type="button" className="primary purchases-register"
          disabled={busy} onClick={openDraft}>Registrar compra</button>
      </div>

      <div className="stock-entry-panel purchases-panel" id="purchases-panel-used" role="tabpanel"
        aria-labelledby="purchases-tab-used" hidden={tab !== 'used'}>
        {pendingView && (pendingUsed.length === 0
          ? <p className="stock-message">No queda saldo pendiente de baterías usadas: todo lo comprado ya se entregó en las rendiciones cerradas.</p>
          : <div className="stock-table-wrap"><table className="stock-table purchases-table">
            <caption className="sr-only">Saldo pendiente de baterías usadas por modelo</caption>
            <thead><tr>
              <th scope="col">Modelo</th>
              <th scope="col" className="num">Compradas</th>
              <th scope="col" className="num">Entregadas</th>
              <th scope="col" className="num">Saldo</th>
            </tr></thead>
            <tbody>{pendingUsed.map(row => <tr key={row.model} data-model={row.model}>
              <td data-label="Modelo"><strong>{row.model}</strong></td>
              <td data-label="Compradas" className="num">{row.bought}</td>
              <td data-label="Entregadas" className="num">{row.delivered}</td>
              <td data-label="Saldo" className="num">{row.balance}
                <span className="purchases-unit">unidades</span></td>
            </tr>)}</tbody>
            <tfoot><tr>
              <td className="label">{`${pendingUsed.length} modelos · ${pendingUnits} unidades`}</td>
              <td className="num">{pendingBought}</td>
              <td className="num">{pendingDelivered}</td>
              <td className="num">{pendingUnits}</td>
            </tr></tfoot>
          </table></div>)}
        {listingReady && !pendingView && received.phase === 'loading'
          && <p className="stock-message" role="status">Consultando lo recibido…</p>}
        {listingReady && !pendingView && received.phase === 'error'
          && <p className="stock-message" role="alert">{received.problem}
            <button type="button" onClick={() => setRevision(value => value + 1)}>Reintentar recibido</button></p>}
        {listingReady && !pendingView && receivedReady && (used.length === 0
          ? <p className="stock-message">Todavía no se recibieron baterías usadas.</p>
          : <div className="stock-table-wrap"><table className="stock-table purchases-table">
            <caption className="sr-only">Baterías usadas recibidas con su valor</caption>
            <thead><tr>
              <th scope="col">Modelo</th>
              <th scope="col" className="num">Cantidad</th>
              <th scope="col" className="num">Valor recibido</th>
              <th scope="col" className="num">Participación</th>
            </tr></thead>
            <tbody>{used.map(row => {
              const share = purchaseSharePercent(row.value_cents, usedValue);
              return <tr key={row.model} data-model={row.model}>
                <td data-label="Modelo"><strong>{row.model}</strong></td>
                <td data-label="Cantidad" className="num">{row.quantity}
                  <span className="purchases-unit">unidades</span></td>
                <td data-label="Valor recibido" className="num">{formatMoney(row.value_cents)}</td>
                <td data-label="Participación"><div className="purchases-share">
                  <span className="purchases-bar" aria-hidden="true">
                    <i style={{ width: `${share}%` }} />
                  </span>
                  <span className="purchases-pct">{`${share} %`}</span>
                </div></td>
              </tr>;
            })}</tbody>
            <tfoot><tr>
              <td className="label">{`${usedUnits} unidades`}</td>
              <td className="num" />
              <td className="num">{formatMoney(usedValue)}</td>
              <td className="num">100 %</td>
            </tr></tfoot>
          </table></div>)}
        <p className="purchases-note">{pendingView
          ? <><strong>Es saldo, no stock de venta.</strong> Estas baterías usadas no se revenden ni entran al
            catálogo: el saldo es lo que la sucursal todavía no entregó al almacén.</>
          : <><strong>Es recibido, no es stock de venta.</strong> Estas baterías
            usadas no se revenden, no entran al catálogo ni descuentan stock de venta. La cifra es lo que la
            sucursal gastó.</>}</p>
        <p className="purchases-footline">{pendingView
          ? 'El saldo es lo comprado menos lo que contaron las rendiciones cerradas: una anulación lo descuenta sola y lo contado de menos sigue a la vista.'
          : 'El acumulado sale de las líneas de cada documento: una anulación lo descuenta sola y no hay un saldo aparte que pueda quedar desfasado.'}</p>
      </div>

      <div className="stock-entry-panel purchases-panel" id="purchases-panel-scrap" role="tabpanel"
        aria-labelledby="purchases-tab-scrap" hidden={tab !== 'scrap'}>
        {pendingView && (pendingScrap.length === 0
          ? <p className="stock-message">No queda saldo pendiente de chatarra: todo lo comprado ya se entregó en las rendiciones cerradas.</p>
          : <div className="stock-table-wrap"><table className="stock-table purchases-table">
            <caption className="sr-only">Saldo pendiente de chatarra por material</caption>
            <thead><tr>
              <th scope="col">Material</th>
              <th scope="col" className="num">Compradas</th>
              <th scope="col" className="num">Entregadas</th>
              <th scope="col" className="num">Saldo</th>
            </tr></thead>
            <tbody>{pendingScrap.map(row => <tr key={row.material_id} data-material-id={row.material_id}>
              <td data-label="Material"><strong>{materialName(row.material_id)}</strong></td>
              <td data-label="Compradas" className="num">{formatKg(row.bought_milli)}</td>
              <td data-label="Entregadas" className="num">{formatKg(row.delivered_milli)}</td>
              <td data-label="Saldo" className="num">{formatKg(row.balance_milli)}</td>
            </tr>)}</tbody>
            <tfoot><tr>
              <td className="label">{`${pendingScrap.length} materiales · ${formatKg(pendingKg)}`}</td>
              <td className="num">{formatKg(pendingBoughtKg)}</td>
              <td className="num">{formatKg(pendingDeliveredKg)}</td>
              <td className="num">{formatKg(pendingKg)}</td>
            </tr></tfoot>
          </table></div>)}
        {listingReady && !pendingView && received.phase === 'loading'
          && <p className="stock-message" role="status">Consultando lo recibido…</p>}
        {listingReady && !pendingView && received.phase === 'error'
          && <p className="stock-message" role="alert">{received.problem}
            <button type="button" onClick={() => setRevision(value => value + 1)}>Reintentar recibido</button></p>}
        {listingReady && !pendingView && receivedReady && (scrap.length === 0
          ? <p className="stock-message">Todavía no se recibió chatarra.</p>
          : <div className="stock-table-wrap"><table className="stock-table purchases-table">
            <caption className="sr-only">Chatarra recibida por material con su valor</caption>
            <thead><tr>
              <th scope="col">Material</th>
              <th scope="col" className="num">Peso recibido</th>
              <th scope="col" className="num">Valor recibido</th>
            </tr></thead>
            <tbody>{scrap.map(row => <tr key={row.material_id} data-material-id={row.material_id}>
              <td data-label="Material"><strong>{row.name}</strong></td>
              <td data-label="Peso recibido" className="num">{formatKg(row.kg_milli)}</td>
              <td data-label="Valor recibido" className="num">{formatMoney(row.value_cents)}</td>
            </tr>)}</tbody>
            <tfoot><tr>
              <td className="label">{formatKg(scrapKg)}</td>
              <td className="num" />
              <td className="num">{formatMoney(scrapValue)}</td>
            </tr></tfoot>
          </table></div>)}
        <p className="purchases-note">{pendingView
          ? <><strong>Se pesa y se compra.</strong> El saldo es lo comprado que el almacén todavía no contó;
            no hay documento de salida ni material para vender.</>
          : <><strong>Se pesa y se compra.</strong> Chatarra solo de entrada en
            esta fase: no hay documento de salida ni material para vender.</>}</p>
        <p className="purchases-footline">{pendingView
          ? 'El saldo es lo comprado menos lo que contaron las rendiciones cerradas: lo contado de menos sigue a la vista.'
          : 'El precio por kilogramo lo tipea el vendedor; el acumulado sale de las líneas, no de un saldo aparte.'}</p>
      </div>

      <div className="stock-entry-panel purchases-panel" id="purchases-panel-documents" role="tabpanel"
        aria-labelledby="purchases-tab-documents" hidden={tab !== 'documents'}
        aria-busy={listing.phase === 'loading'}>
        <div className="stock-panel-head">
          <div><h2 id="purchase-history-title">Documentos</h2>
            <p className="stock-hint">Cada compra es un documento con sus líneas y su pago. Se corrige con
              una anulación que deja ambos documentos.</p></div>
          <span className="stock-tag">{historyCount}</span>
        </div>
        {rows.length > 0 && <div className="stock-table-wrap"><table className="stock-table purchases-table">
          <caption className="sr-only">Compras registradas en {branch}</caption>
          <thead><tr>
            <th scope="col">Documento</th>
            <th scope="col">Fecha</th>
            <th scope="col">Contenido</th>
            <th scope="col" className="num">Total</th>
            <th scope="col">Estado</th>
            <th scope="col">Acciones</th>
          </tr></thead>
          <tbody>{rows.map(row => <tr key={row.id} data-purchase-id={row.id}>
            <td data-label="Documento"><strong>#{row.id}</strong></td>
            <td data-label="Fecha"><TransferDate value={row.created_at} /></td>
            <td data-label="Contenido">{purchaseContent(row)}</td>
            <td data-label="Total" className="num">{formatSignedMoney(row.total_cents)}</td>
            <td data-label="Estado">{row.reverses_purchase_id !== null
              ? <span className="stock-tag">Contra-documento</span>
              : row.reversed_by !== null
                ? <span className="stock-tag reversed">{`Revertida por #${row.reversed_by}`}</span>
                : <span className="stock-tag">Vigente</span>}</td>
            <td data-label="Acciones"><div className="stock-row-actions">
              <button type="button" className="stock-detail" aria-label={`Ver el detalle de la compra #${row.id}`}
                disabled={reversalBusy} onClick={() => openDetail(row)}>Ver detalle</button>
              {purchaseReversible(row) && <button type="button" className="stock-reverse"
                aria-label={`Anular la compra #${row.id}`} disabled={reversalBusy}
                onClick={event => openReversal(row, event.currentTarget)}>Anular</button>}
            </div></td>
          </tr>)}</tbody>
        </table></div>}
        {listingReady && rows.length === 0 && <p className="stock-message">
          {listing.period?.kind === 'pending'
            ? 'Todavía no hay compras registradas en la sucursal.'
            : listing.period?.kind === 'all'
              ? 'Todavía no hay compras registradas.'
              : 'Este período no tiene compras registradas.'}</p>}
        <footer className="pager"><div className="page-controls">
          <label htmlFor="purchase-history-size">Compras por página</label>
          <select id="purchase-history-size" value={historySize} onChange={event => {
            const next = Number(event.target.value);
            if (purchaseHistoryPageSizes.includes(next)) { setHistoryPage(1); setHistorySize(next); }
          }}>{purchaseHistoryPageSizes.map(value => <option key={value}>{value}</option>)}</select>
          <button type="button" disabled={historyPage <= 1}
            onClick={() => { if (historyPage > 1) setHistoryPage(historyPage - 1); }}>Anterior página</button>
          <span aria-current="page">Página {historyPage}</span>
          <button type="button" disabled={!listingReady || historyPage >= purchaseHistoryMaxPage
            || historyPage * historySize >= listing.total}
            onClick={nextHistoryPage}>Siguiente página</button>
        </div></footer>
      </div>
    </section>

    {draftOpen && <div className="transfer-decision-backdrop"><section ref={documentDialog}
      className="transfer-decision-modal purchase-document" role="dialog" aria-modal="true"
      aria-labelledby="purchase-draft-title" aria-describedby="purchase-draft-sub" aria-busy={busy}
      onKeyDown={event => { if (event.key === 'Escape' && !busy) { event.preventDefault(); dismissDocument(); } }}>
      <header><div>
        <p className="purchase-doc-meta">Comprobante · se numera al registrar · {branch}</p>
        <h2 id="purchase-draft-title">Nueva compra</h2>
        <p id="purchase-draft-sub">Un solo modelo o material por línea. El valor lo tipeás vos y no se
          piden datos de quien trae el material.</p>
      </div>
        <button type="button" aria-label="Cerrar la compra" disabled={busy} onClick={dismissDocument}>×</button>
      </header>
      <div className="transfer-decision-body purchase-document-body">
        {catalog.problem !== '' && <p role="alert" className="stock-message">{catalog.problem}
          <button type="button" onClick={() => setRevision(value => value + 1)}>Reintentar catálogo</button></p>}
        <fieldset className="purchase-kind">
          <legend className="sr-only">Tipo de material</legend>
          <button type="button" aria-pressed={kind === 'used'} disabled={busy}
            onClick={() => setKind('used')}>Batería usada</button>
          <button type="button" aria-pressed={kind === 'scrap'} disabled={busy}
            onClick={() => setKind('scrap')}>Chatarra por kg</button>
        </fieldset>

        {kind === 'used' && <div className="purchase-line">
          <div className="purchase-field">
            <label htmlFor="purchase-model">Modelo</label>
            <input id="purchase-model" ref={element => { picker.current = element; }} list="purchase-model-options"
              autoComplete="off" value={modelText}
              onChange={event => { forgetAttempt(); setModelText(event.target.value); }} />
            <span className="stock-hint">Lista del catálogo, sin repetir marcas. Si no está, se tipea.</span>
          </div>
          <div className="purchase-field">
            <label htmlFor="purchase-quantity">Cantidad</label>
            <input id="purchase-quantity" className="num" type="number" inputMode="numeric" min={1} step={1}
              value={quantityText}
              onChange={event => { if (/^\d{0,7}$/.test(event.target.value)) { forgetAttempt(); setQuantityText(event.target.value); } }} />
            <span className="stock-hint">en unidades</span>
          </div>
          <div className="purchase-field">
            <label htmlFor="purchase-price">Precio por batería (Bs)</label>
            <input id="purchase-price" className="num" inputMode="decimal" value={priceText}
              onChange={event => { forgetAttempt(); setPriceText(event.target.value); }} />
            {anchorModelPrice
              ? <span className="stock-hint">{`Última: ${formatMoney(anchorModelPrice.unit_price_cents)}`}</span>
              : <span className="stock-hint">sin compras previas de este modelo</span>}
          </div>
          <div className="purchase-field">
            <span>Importe</span>
            <p className="purchase-amount" aria-live="polite">
              {pendingLineCents === null ? '—' : formatMoney(pendingLineCents)}</p>
            <span className="stock-hint">se calcula</span>
          </div>
          <div className="purchase-add">
            <button type="button" className="primary" disabled={busy} onClick={addUsed}>Agregar batería</button>
          </div>
        </div>}
        <datalist id="purchase-model-options">{catalog.models.map(model =>
          <option key={model} value={model} />)}</datalist>

        {kind === 'scrap' && <div className="purchase-line">
          <div className="purchase-field">
            <label htmlFor="purchase-material">Material</label>
            <select id="purchase-material" ref={element => { picker.current = element; }} value={materialText}
              onChange={event => { forgetAttempt(); setMaterialText(event.target.value); }}>
              <option value="">Elegí un material</option>
              {catalog.materials.map(material => <option key={material.id} value={material.id}>{material.name}</option>)}
            </select>
            <span className="stock-hint">cobre, aluminio, plomo y bronce</span>
          </div>
          <div className="purchase-field">
            <label htmlFor="purchase-kg">Kilogramos</label>
            <input id="purchase-kg" className="num" inputMode="decimal" value={kgText}
              onChange={event => { forgetAttempt(); setKgText(event.target.value); }} />
            <span className="stock-hint">en kilogramos</span>
          </div>
          <div className="purchase-field">
            <label htmlFor="purchase-scrap-price">Precio por kilogramo (Bs)</label>
            <input id="purchase-scrap-price" className="num" inputMode="decimal" value={scrapPriceText}
              onChange={event => { forgetAttempt(); setScrapPriceText(event.target.value); }} />
            {anchorMaterialPrice
              ? <span className="stock-hint">{`Última: ${formatMoney(anchorMaterialPrice.price_per_kg_cents)}`}</span>
              : <span className="stock-hint">sin compras previas de este material</span>}
          </div>
          <div className="purchase-field">
            <span>Importe</span>
            <p className="purchase-amount" aria-live="polite">
              {pendingLineCents === null ? '—' : formatMoney(pendingLineCents)}</p>
            <span className="stock-hint">se calcula</span>
          </div>
          <div className="purchase-add">
            <button type="button" className="primary" disabled={busy} onClick={addScrap}>Agregar material</button>
          </div>
        </div>}

        {lines.length > 0 && <div className="stock-table-wrap"><table className="stock-table stock-lines purchases-table">
          <caption className="sr-only">Líneas de la compra</caption>
          <thead><tr><th scope="col">Modelo o material</th><th scope="col">Cantidad o kilogramos</th>
            <th scope="col">Precio</th><th scope="col">Importe</th><th scope="col">Quitar</th></tr></thead>
          <tbody>{lines.map(line => {
            const parsedEntry = parsedLine(line);
            return <tr key={draftLineKey(line)}>
              <td data-label="Modelo o material">
                <strong>{line.kind === 'used' ? line.model : line.name}</strong></td>
              <td data-label="Cantidad o kilogramos">
                {line.kind === 'used'
                  ? <input className="stock-quantity" type="number" inputMode="numeric" min={1} step={1}
                    aria-label={`Cantidad de ${line.model}`} value={line.quantity}
                    onChange={event => updateLine(line, 'quantity', event.target.value)} />
                  : <input className="stock-quantity" inputMode="decimal"
                    aria-label={`Kilogramos de ${line.name}`} value={line.kg}
                    onChange={event => updateLine(line, 'kg', event.target.value)} />}
              </td>
              <td data-label="Precio">
                {line.kind === 'used'
                  ? <input className="stock-quantity" inputMode="decimal" aria-label={`Precio de ${line.model}`}
                    value={line.price} onChange={event => updateLine(line, 'price', event.target.value)} />
                  : <input className="stock-quantity" inputMode="decimal" aria-label={`Precio por kg de ${line.name}`}
                    value={line.price} onChange={event => updateLine(line, 'price', event.target.value)} />}
              </td>
              <td data-label="Importe">{parsedEntry ? formatMoney(lineAmountCents(parsedEntry)) : '—'}</td>
              <td data-label="Quitar"><button type="button" className="stock-remove"
                aria-label={`Quitar ${line.kind === 'used' ? line.model : line.name}`}
                disabled={busy} onClick={() => removeLine(line)}>Quitar</button></td>
            </tr>;
          })}</tbody>
        </table></div>}
        {lines.length === 0 && <p className="stock-message">Todavía no agregaste líneas.</p>}

        <div className="stock-note">
          <label htmlFor="purchase-note">Nota (opcional)</label>
          <textarea id="purchase-note" maxLength={purchaseMaxNote} value={note}
            placeholder="Ej.: vino con la carcasa rota, se pesa igual"
            onChange={event => { forgetAttempt(); setNote(event.target.value); }} />
        </div>

        <p className="purchases-note">El documento no se edita después: si algo salió mal se corrige con un
          contra-documento con motivo. Nada de esto toca el stock de venta.</p>

        <div className="purchase-settle">
          <div className="purchase-settle-total">
            <span>Total a pagar</span><strong>{formatMoney(totalCents)}</strong>
          </div>
          <div className="purchase-field">
            <label htmlFor="purchase-cash">Efectivo del fondo de compras</label>
            <input id="purchase-cash" className="num" inputMode="decimal" value={cashText}
              onChange={event => { forgetAttempt(); setCashText(event.target.value); }} />
            <span className="stock-hint">no se paga por transferencia</span>
          </div>
          <div className="purchase-field">
            <span>Diferencia</span>
            <p className={settled ? 'stock-hint' : 'stock-status'} role="status">{settlementMessage}</p>
          </div>
        </div>
        <p className="stock-hint">La compra se paga en efectivo del fondo de compras: el efectivo tiene
          que ser el total exacto y nunca más de lo que el fondo tiene disponible. Se registra a
          nombre de la sucursal, no de la persona.</p>
        {draftMessage && <p role="status" className="stock-status">{draftMessage}</p>}
        {draftFailure && <p role="alert" className="stock-status">{draftFailure}</p>}
      </div>
      <footer>
        <button type="button" disabled={busy} onClick={dismissDocument}>Cancelar</button>
        <button type="button" className="primary" disabled={!canConfirm}
          onClick={() => void confirmPurchase()}>Registrar compra</button>
      </footer>
    </section></div>}

    {reversal && <div className="transfer-decision-backdrop"><section className="transfer-decision-modal purchase-reversal"
      role="dialog" aria-modal="true" aria-labelledby="purchase-reversal-title" aria-busy={reversalBusy}
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); closeReversal(); } }}>
      <header><div><h2 id="purchase-reversal-title">{`Anular compra #${reversal.row.id}`}</h2>
        <p>Se registra un contra-documento con las líneas espejadas y el motivo.</p></div>
        <button type="button" aria-label="Cerrar la anulación" disabled={reversalBusy} onClick={closeReversal}>×</button></header>
      <div className="transfer-decision-body">
        <dl className="stock-totals">
          <div><dt>Total de la compra</dt><dd>{formatSignedMoney(reversal.row.total_cents)}</dd></div>
          <div><dt>Contra-documento</dt><dd>{formatSignedMoney(-reversal.row.total_cents)}</dd></div>
        </dl>
        <p className="stock-hint">El original nunca cambia: queda anulado en el historial y el contra-documento aparece como documento aparte.</p>
        <label className="stock-search" htmlFor="purchase-reversal-reason">Motivo de la anulación
          <textarea id="purchase-reversal-reason" required maxLength={purchaseMaxReason} value={reversalReason}
            onChange={event => setReversalReason(event.target.value)} />
        </label>
        <p className="stock-hint">{`Obligatorio: entre 1 y ${purchaseMaxReason} caracteres. ${Array.from(reversalReason).length}/${purchaseMaxReason}`}</p>
        {reversalBusy && <p role="status" className="stock-status">Registrando la anulación…</p>}
        {reversalProblem && <p role="alert" className="stock-status">{reversalProblem}</p>}
      </div>
      <footer><button type="button" disabled={reversalBusy} onClick={closeReversal}>Cancelar</button>
        <button type="button" className="primary" disabled={reversalBusy}
          onClick={() => void confirmReversal()}>Confirmar anulación</button></footer>
    </section></div>}

    {receipt && <div className="transfer-decision-backdrop"><section className="transfer-decision-modal purchase-receipt-dialog"
      role="dialog" aria-modal="true" aria-labelledby="purchase-receipt-title" aria-busy={receipt.phase === 'loading'}
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); closeReceipt(); } }}>
      <style>{receiptPrintStyle}</style>
      <header><div><h2 id="purchase-receipt-title">{receipt.document
        ? `Comprobante de compra #${receipt.document.id}` : 'Comprobante de compra'}</h2>
        <p>{branch} · comprobante interno de la compra</p></div>
        <button type="button" aria-label="Cerrar el comprobante" onClick={closeReceipt}>×</button></header>
      <div className="transfer-decision-body">
        {receipt.phase === 'loading' && <p role="status" className="stock-message">Consultando el comprobante…</p>}
        {receipt.phase === 'error' && <p role="alert" className="stock-message">{receipt.problem}
          <button type="button" onClick={() => setDetailRevision(value => value + 1)}>Reintentar comprobante</button></p>}
        {receipt.phase === 'ready' && receipt.document && <article className="purchase-receipt">
          <header><h3>Luson Baterías · Compras</h3><p>{branch}</p></header>
          <dl className="purchase-receipt-meta">
            <div><dt>Documento</dt><dd>{`#${receipt.document.id}`}</dd></div>
            <div><dt>Fecha</dt><dd><TransferDate value={receipt.document.created_at} /></dd></div>
            <div><dt>Recibió</dt><dd>{`Cuenta #${receipt.document.created_by_account_id}`}</dd></div>
            <div><dt>Forma de pago</dt><dd>{receiptPayment(receipt.document)}</dd></div>
            {receipt.document.note !== '' && <div><dt>Nota</dt><dd>{receipt.document.note}</dd></div>}
            {receipt.document.reverses_purchase_id !== null &&
              <div><dt>Anula la compra</dt><dd>{`#${receipt.document.reverses_purchase_id}`}</dd></div>}
            {receipt.document.reason !== '' && <div><dt>Motivo</dt><dd>{receipt.document.reason}</dd></div>}
          </dl>
          <table className="stock-table purchase-receipt-lines">
            <caption className="sr-only">Líneas del comprobante de compra</caption>
            <thead><tr><th scope="col">Modelo o material</th><th scope="col">Cantidad o kilogramos</th>
              <th scope="col">Precio</th><th scope="col">Importe</th></tr></thead>
            <tbody>
              {receipt.document.used_lines.map(line => <tr key={`used-${line.model}`}>
                <td data-label="Modelo o material"><strong>{line.model}</strong></td>
                <td data-label="Cantidad o kilogramos">{line.quantity}</td>
                <td data-label="Precio">{formatMoney(line.unit_price_cents)}</td>
                <td data-label="Importe">{formatSignedMoney(line.amount_cents)}</td>
              </tr>)}
              {receipt.document.scrap_lines.map(line => <tr key={`scrap-${line.material_id}`}>
                <td data-label="Modelo o material"><strong>{line.name}</strong></td>
                <td data-label="Cantidad o kilogramos">{formatKg(line.kg_milli)}</td>
                <td data-label="Precio">{`${formatMoney(line.price_per_kg_cents)} por kg`}</td>
                <td data-label="Importe">{formatSignedMoney(line.amount_cents)}</td>
              </tr>)}
            </tbody>
          </table>
          <p className="purchase-receipt-total">{`Total: ${formatSignedMoney(receipt.document.total_cents)}`}</p>
          <p className="purchase-receipt-signature">Firma: ______________________________</p>
        </article>}
      </div>
      <footer>
        {receipt.phase === 'ready' && receipt.document &&
          <button type="button" onClick={() => { if (typeof window.print === 'function') window.print(); }}>Imprimir comprobante</button>}
        <button type="button" onClick={closeReceipt}>Volver</button>
      </footer>
    </section></div>}
  </section>;
}
