import { useEffect, useMemo, useRef, useState } from 'react';
import type { Kind, VariantIdentity } from './model';
import { identityOf, validSearch } from './model';
import TransferDate from './shared/TransferDate';
import { createStockEntryAPI, StockEntryAPIError, StockEntryDetailAPIError, StockEntryReversalAPIError } from './stockEntryAPI';
import {
  canonicalStockEntryInput, canonicalStockEntryReversalInput, canonicalStockEntryReversalReason,
  newStockEntryOperationKey, stockEntryDetailErrorMessages, stockEntryErrorMessages,
  stockEntryFailureIsDefinite, stockEntryHistoryDefaultPageSize, stockEntryHistoryMaxPage, stockEntryHistoryPageSizes,
  stockEntryHistoryUnavailable, stockEntryKindLabels, stockEntryKinds, stockEntryMaxNote,
  stockEntryMaxQuantity, stockEntryMaxReason,
  stockEntryReversalErrorMessages, stockEntryReversalFailureIsDefinite, stockEntryReversible,
  groupSupplierCatalog, supplierCatalogGroupDraftUnits, supplierCatalogGroupKeyOf, supplierCatalogProductCount,
  supplierCatalogProductDraftUnits,
  stockSupplierDraftNotOffered, stockSupplierNoOffers, stockSupplierPageSize, stockSupplierRequired,
  unofferedStockEntryVariantIDs, validStockQuantity,
  type StockEntryDetail, type StockEntryDetailErrorCode, type StockEntryDetailLine, type StockEntryErrorCode,
  type StockEntryHistoryPage, type StockEntryHistoryRow, type StockEntryInput, type StockEntryReversalErrorCode,
  type StockEntryReversalInput, type SupplierCatalogRow, type SupplierChoice, type SupplierListPage,
} from './stockEntryModel';
import './stock-entry.css';

// One line of the draft: the identity of the picked variant plus the quantity as
// the user typed it. Nothing battery-specific is added to a product line.
interface DocumentLine extends VariantIdentity { readonly quantity: string }
interface CatalogState {
  readonly phase: 'loading' | 'ready' | 'error';
  readonly items: readonly SupplierCatalogRow[];
  readonly problem: string;
}
// The suppliers the screen can choose from are their own read: a failed read
// never leaves a picker or a document behind.
interface SupplierState {
  readonly phase: 'loading' | 'ready' | 'error';
  readonly page: SupplierListPage | null;
  readonly problem: string;
}
// The history is its own state: a failed read never touches the draft document.
interface HistoryState {
  readonly phase: 'loading' | 'ready' | 'error';
  readonly page: StockEntryHistoryPage | null;
  readonly problem: string;
}
// The detail is its own read, tagged with the document it asked about so a reply
// for one row can never be rendered for another.
interface DetailState {
  readonly id: number;
  readonly phase: 'loading' | 'ready' | 'error';
  readonly document: StockEntryDetail | null;
  readonly problem: string;
}

export interface StockEntryProps {
  // The parent remounts this section per session fence, so a rotated session or
  // CSRF token can never publish a result into a newer warehouse session.
  csrf: string;
  fetcher?: typeof globalThis.fetch;
}
const supplierUnavailable = 'No se pudo consultar la lista de proveedores. Revisá la conexión e intentá de nuevo.';
const supplierCatalogUnavailable =
  'No se pudo consultar el catálogo del proveedor elegido. Revisá la conexión e intentá de nuevo.';
// A battery document keeps the columns it always had; a product document reads
// the name and the detail the server composes from its typed fields.
const detailBatteryLines = (lines: readonly StockEntryDetailLine[]) =>
  lines.flatMap(line => line.battery === null ? [] : [{ line, battery: line.battery }]);
// What the supplier brings in, said before choosing it, so an empty supplier is
// obvious and never a surprise inside the picker. One count per concept: the
// catalogue counts products and the document counts lines.
const offerCount = (choice: SupplierChoice) => choice.offers === 0
  ? 'Sin productos asignados'
  : `${choice.offers} ${choice.offers === 1 ? 'producto' : 'productos'}`;
const supplierName = (supplier: { readonly name: string } | null) => supplier === null ? 'sin proveedor' : supplier.name;
const countLabel = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
// The accessible name of a picker row. A battery is named by its brand and model
// because the row no longer repeats the brand inside the group.
const variantName = (row: SupplierCatalogRow) => row.battery === null ? row.name : `${row.battery.brand} ${row.battery.model}`;
// The draft names the exact variant, so the two lines of one product (its two
// polarities) are never two controls with the same accessible name.
const lineName = (line: VariantIdentity) =>
  line.battery === null ? line.name : `${line.name} polaridad ${line.battery.polarity}`;
const lineDetail = (line: VariantIdentity) =>
  line.battery === null ? line.detail : `${line.battery.capacity_ah} Ah · Polaridad ${line.battery.polarity}`;

export default function StockEntry({ csrf, fetcher = globalThis.fetch }: StockEntryProps) {
  const api = useMemo(() => createStockEntryAPI(fetcher), [fetcher]);
  // The document names the supplier whose products it brings in: the supplier is
  // chosen first and nothing is read or saved until it is.
  const [supplier, setSupplier] = useState<SupplierChoice | null>(null);
  const [supplierSwitch, setSupplierSwitch] = useState<{ next: SupplierChoice; trigger: HTMLElement } | null>(null);
  const supplierDialog = useRef<HTMLElement>(null);
  const [suppliersState, setSuppliersState] = useState<SupplierState>(
    { phase: 'loading', page: null, problem: supplierUnavailable });
  const [suppliersRevision, setSuppliersRevision] = useState(0);
  // The document declares its kind, and the kind is chosen before any catalog or
  // document appears: one document never mixes the two kinds.
  const [kind, setKind] = useState<Kind | null>(null);
  const [kindSwitch, setKindSwitch] = useState<{ next: Kind; trigger: HTMLButtonElement } | null>(null);
  const kindDialog = useRef<HTMLElement>(null);
  const [search, setSearch] = useState('');
  const [revision, setRevision] = useState(0);
  const [catalog, setCatalog] = useState<CatalogState>(
    { phase: 'loading', items: [], problem: supplierCatalogUnavailable });
  // The catalogue is shown as products grouped by brand (H): the group where the
  // operator is working opens by default, everything else stays collapsed, and
  // 'all' is the state the "Ver todos los productos" row sets.
  const [expandedGroups, setExpandedGroups] = useState<readonly string[] | 'all' | null>(null);
  const [lines, setLines] = useState<readonly DocumentLine[]>([]);
  const [note, setNote] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  // Every variant the chosen supplier actually offered while this document was
  // being typed: a line outside it can never be confirmed (S5).
  const offered = useRef<Set<number>>(new Set());
  const [historyPage, setHistoryPage] = useState(1);
  const [historySize, setHistorySize] = useState(stockEntryHistoryDefaultPageSize);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [history, setHistory] = useState<HistoryState>({ phase: 'loading', page: null, problem: stockEntryHistoryUnavailable });
  const lifetime = useRef(new AbortController());
  const mounted = useRef(true);
  const pending = useRef(false);
  // One key per unchanged draft: an uncertain retry replays exactly, an edit becomes a new document.
  const operationKey = useRef<string | null>(null);
  // The counter-entry dialog: one row at a time, its own reason and its own key.
  const [reversal, setReversal] = useState<{ row: StockEntryHistoryRow; trigger: HTMLButtonElement } | null>(null);
  const [reversalReason, setReversalReason] = useState('');
  const [reversalProblem, setReversalProblem] = useState('');
  const [reversalNotice, setReversalNotice] = useState('');
  const [reversalBusy, setReversalBusy] = useState(false);
  const reversalDialog = useRef<HTMLElement>(null);
  const reversalReasonField = useRef<HTMLTextAreaElement>(null);
  const reversalNoticeArea = useRef<HTMLParagraphElement>(null);
  // One key per (target, canonical reason): an uncertain retry replays exactly,
  // and a different motive becomes a different counter-entry intent.
  const reversalAttempt = useRef<{ target: number; reason: string; key: string } | null>(null);
  // The detail dialog: the row that opened it, the focusable action to return to
  // and its own read, which is discarded the moment another row is opened.
  const [detail, setDetail] = useState<{ row: StockEntryHistoryRow; trigger: HTMLButtonElement } | null>(null);
  const [detailLoad, setDetailLoad] = useState<DetailState>({ id: 0, phase: 'loading', document: null, problem: '' });
  const [detailRevision, setDetailRevision] = useState(0);
  const detailDialog = useRef<HTMLElement>(null);
  useEffect(() => {
    const flight = lifetime.current;
    mounted.current = true;
    return () => { mounted.current = false; flight.abort(); };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const alive = () => mounted.current && !controller.signal.aborted && !lifetime.current.signal.aborted;
    setSuppliersState(current => ({ phase: 'loading', page: current.page, problem: supplierUnavailable }));
    void (async () => {
      try {
        const page = await api.suppliers(1, stockSupplierPageSize, controller.signal);
        if (!alive()) return;
        setSuppliersState({ phase: 'ready', page, problem: '' });
      } catch {
        if (alive()) setSuppliersState(current => ({ ...current, phase: 'error', problem: supplierUnavailable }));
      }
    })();
    return () => controller.abort();
  }, [api, suppliersRevision]);

  useEffect(() => {
    // Nothing is read before the supplier and its kind are chosen, and only that
    // supplier's catalogue is read after: there is no all-products path.
    if (supplier === null || kind === null) return;
    if (!validSearch(search)) {
      setCatalog({ phase: 'error', items: [], problem: 'La búsqueda admite hasta 128 bytes UTF-8, sin caracteres inválidos.' });
      return;
    }
    const controller = new AbortController();
    const alive = () => mounted.current && !controller.signal.aborted && !lifetime.current.signal.aborted;
    setCatalog({ phase: 'loading', items: [], problem: supplierCatalogUnavailable });
    void (async () => {
      try {
        const items = await api.supplierCatalog(supplier.id, kind, search, controller.signal);
        if (!alive()) return;
        // Every row the supplier answered with is a variant this draft may name,
        // whatever the current search hides afterwards.
        for (const item of items) offered.current.add(item.variant_id);
        setCatalog({ phase: 'ready', items, problem: '' });
      } catch {
        if (alive()) setCatalog({ phase: 'error', items: [], problem: supplierCatalogUnavailable });
      }
    })();
    return () => controller.abort();
  }, [api, supplier, kind, search, revision]);

  const catalogGroups = useMemo(() => groupSupplierCatalog(catalog.items), [catalog.items]);
  // A group key of a catalogue that is gone is dropped, so a search never leaves
  // every group closed behind it.
  useEffect(() => {
    setExpandedGroups(current => {
      if (current === null || current === 'all') return current;
      const kept = current.filter(key => catalogGroups.some(group => group.key === key));
      return kept.length === current.length ? current : kept;
    });
  }, [catalogGroups]);

  useEffect(() => {
    const controller = new AbortController();
    const alive = () => mounted.current && !controller.signal.aborted && !lifetime.current.signal.aborted;
    setHistory(current => ({ phase: 'loading', page: current.page, problem: stockEntryHistoryUnavailable }));
    void (async () => {
      try {
        const page = await api.history(historyPage, historySize, controller.signal);
        if (!alive()) return;
        setHistory({ phase: 'ready', page, problem: '' });
      } catch {
        if (alive()) setHistory(current => ({ ...current, phase: 'error', problem: stockEntryHistoryUnavailable }));
      }
    })();
    return () => controller.abort();
  }, [api, historyPage, historySize, historyRevision]);

  // One document detail per open dialog: the read is aborted when the dialog closes
  // or another row is opened, and only a reply for the requested id is stored.
  useEffect(() => {
    if (!detail) return;
    const id = detail.row.id;
    const controller = new AbortController();
    const alive = () => mounted.current && !controller.signal.aborted && !lifetime.current.signal.aborted;
    setDetailLoad({ id, phase: 'loading', document: null, problem: '' });
    void (async () => {
      try {
        const document = await api.detail(id, controller.signal);
        if (!alive() || document.id !== id) return;
        setDetailLoad({ id, phase: 'ready', document, problem: '' });
      } catch (failure) {
        if (!alive()) return;
        const code: StockEntryDetailErrorCode = failure instanceof StockEntryDetailAPIError ? failure.code : 'invalid_response';
        setDetailLoad({ id, phase: 'error', document: null, problem: stockEntryDetailErrorMessages[code] });
      }
    })();
    return () => controller.abort();
  }, [api, detail, detailRevision]);

  function forgetAttempt() { operationKey.current = null; }
  // The supplier is the first decision of the document: choosing another one is a
  // new document, and no line is ever migrated to the new supplier's catalogue.
  function applySupplier(next: SupplierChoice) {
    forgetAttempt();
    offered.current = new Set();
    setSupplier(next);
    setSupplierSwitch(null);
    setKindSwitch(null);
    // A supplier that offers a single kind needs no second decision, and a
    // supplier without products needs no picker at all.
    setKind(next.kinds.length === 1 ? next.kinds[0] : null);
    setSearch('');
    setCatalog({ phase: 'loading', items: [], problem: supplierCatalogUnavailable });
    setExpandedGroups(null);
    setLines([]);
    setNote('');
    setStatus('');
  }
  function chooseSupplier(next: SupplierChoice, trigger: HTMLElement) {
    if (busy || pending.current || supplierSwitch || kindSwitch || next.retired || next.id === supplier?.id) return;
    // With nothing typed the change costs nothing; a draft with a line is
    // discarded only after the deliberate confirmation.
    if (lines.length === 0) { applySupplier(next); return; }
    setSupplierSwitch({ next, trigger });
  }
  function closeSupplierSwitch() {
    const trigger = supplierSwitch?.trigger;
    setSupplierSwitch(null);
    if (trigger?.isConnected) trigger.focus();
  }
  // Focus moves into the confirmation as soon as it exists.
  useEffect(() => {
    if (supplierSwitch) supplierDialog.current?.focus();
  }, [supplierSwitch]);
  // A kind change is a new document: the draft of the other kind is discarded
  // whole, and no line is ever migrated to the new kind.
  function applyKind(next: Kind) {
    forgetAttempt();
    offered.current = new Set();
    setKind(next);
    setKindSwitch(null);
    setSearch('');
    setExpandedGroups(null);
    setLines([]);
    setNote('');
    setStatus('');
  }
  function chooseKind(next: Kind, trigger: HTMLButtonElement) {
    if (busy || pending.current || kindSwitch || next === kind) return;
    // Only the kinds the chosen supplier offers are ever offered here.
    if (supplier === null || !supplier.kinds.includes(next)) return;
    // With nothing loaded the change costs nothing; a document with a line is
    // discarded only after the deliberate confirmation.
    if (lines.length === 0) { applyKind(next); return; }
    setKindSwitch({ next, trigger });
  }
  function closeKindSwitch() {
    const trigger = kindSwitch?.trigger;
    setKindSwitch(null);
    if (trigger?.isConnected) trigger.focus();
  }
  // Focus moves into the confirmation as soon as it exists.
  useEffect(() => {
    if (kindSwitch) kindDialog.current?.focus();
  }, [kindSwitch]);

  function add(row: SupplierCatalogRow, groupKey: string | null) {
    // Only a row of the chosen supplier's catalogue is a line of this document.
    if (!offered.current.has(row.variant_id)) { setStatus(stockSupplierDraftNotOffered); return; }
    forgetAttempt();
    // Adding never hides the row that was just used: an explicit grouping keeps
    // the group of the new line open.
    setExpandedGroups(current => current === null || current === 'all' || groupKey === null
      || current.includes(groupKey) ? current : [...current, groupKey]);
    const label = lineName(identityOf(row));
    const current = lines.find(line => line.variant_id === row.variant_id);
    if (current) {
      const previous = Number(current.quantity);
      const quantity = validStockQuantity(previous) ? Math.min(previous + 1, stockEntryMaxQuantity) : 1;
      setLines(lines.map(line => line.variant_id === row.variant_id ? { ...line, quantity: String(quantity) } : line));
      setStatus(`${label} ya estaba en el documento: ahora ${quantity} ${quantity === 1 ? 'unidad' : 'unidades'}.`);
      return;
    }
    setLines([...lines, { ...identityOf(row), quantity: '1' }]);
    setStatus(`${label} agregado al documento.`);
  }
  function setQuantity(variant: number, value: string) {
    if (!/^\d{0,7}$/.test(value)) return;
    forgetAttempt(); setStatus('');
    setLines(lines.map(line => line.variant_id === variant ? { ...line, quantity: value } : line));
  }
  function removeLine(variant: number) {
    forgetAttempt(); setStatus('');
    setLines(lines.filter(line => line.variant_id !== variant));
  }

  const quantitiesValid = lines.every(line => validStockQuantity(Number(line.quantity)));
  const totalUnits = lines.reduce((total, line) => total + (validStockQuantity(Number(line.quantity)) ? Number(line.quantity) : 0), 0);

  async function confirm() {
    if (busy || pending.current) return;
    if (supplier === null) { setStatus(stockSupplierRequired); return; }
    // A supplier without assigned products cannot receive an ingress at all.
    if (supplier.offers === 0) { setStatus(stockSupplierNoOffers); return; }
    if (!lines.length) { setStatus('Agregá al menos una línea antes de confirmar.'); return; }
    if (!quantitiesValid) { setStatus('Cantidad inválida: ingresá un entero entre 1 y 1.000.000 en cada línea.'); return; }
    // The offer list is a rule of the document, not only of the picker: a line the
    // supplier does not offer is refused whole before anything is sent.
    if (unofferedStockEntryVariantIDs(offered.current, lines.map(line => line.variant_id)).length > 0) {
      setStatus(stockSupplierDraftNotOffered);
      return;
    }
    if (operationKey.current === null) {
      try { operationKey.current = newStockEntryOperationKey(); }
      catch { setStatus('No se pudo generar una clave segura para este ingreso. No se envió nada.'); return; }
    }
    const input: StockEntryInput = { operation_key: operationKey.current, supplier_id: supplier.id, note,
      lines: lines.map(line => ({ variant_id: line.variant_id, quantity: Number(line.quantity) })) };
    let prepared: StockEntryInput;
    try { prepared = canonicalStockEntryInput(input); } catch { setStatus('El documento no es válido. Revisá las líneas y la nota.'); return; }
    pending.current = true; setBusy(true); setStatus('Confirmando ingreso…');
    try {
      const result = await api.create(prepared, csrf, lifetime.current.signal);
      if (!mounted.current || lifetime.current.signal.aborted) return;
      const units = result.record.total_units;
      setLines([]); setNote(''); forgetAttempt(); setRevision(value => value + 1);
      // The new document has the newest id, so the history restarts at page one
      // and refetches before the confirmation message is read.
      setHistoryPage(1); setHistoryRevision(value => value + 1);
      setStatus(`Ingreso confirmado: documento ${result.record.id} · ${units} ${units === 1 ? 'unidad' : 'unidades'}${result.replayed ? ' (reintento sin duplicar)' : ''}.`);
    } catch (failure) {
      if (!mounted.current || lifetime.current.signal.aborted) return;
      const code: StockEntryErrorCode = failure instanceof StockEntryAPIError ? failure.code : 'invalid_response';
      // A definite rejection wrote nothing; anything else keeps the key for an idempotent retry.
      if (stockEntryFailureIsDefinite(code)) forgetAttempt();
      setStatus(stockEntryErrorMessages[code]);
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  // ---- counter-entry ----------------------------------------------------------
  const focusableWithin = (element: HTMLElement | null) => Array.from(element?.querySelectorAll<HTMLElement>(
    'button:not(:disabled), textarea:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]') ?? []);
  // Focus never escapes a dialog: Tab and Shift+Tab cycle its own controls.
  function trapFocus(event: React.KeyboardEvent, element: HTMLElement | null) {
    if (event.key !== 'Tab') return;
    const focusable = focusableWithin(element);
    if (!focusable.length) { event.preventDefault(); return; }
    const first = focusable[0]; const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === element)) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === element)) {
      event.preventDefault(); first.focus();
    }
  }

  function openReversal(row: StockEntryHistoryRow, trigger: HTMLButtonElement) {
    if (reversal || detail || reversalBusy || !stockEntryReversible(row)) return;
    reversalAttempt.current = null;
    setReversal({ row, trigger });
    setReversalReason('');
    setReversalProblem('');
    setReversalNotice('');
  }
  function closeReversal() {
    if (reversalBusy) return;
    const trigger = reversal?.trigger;
    setReversal(null);
    setReversalReason('');
    setReversalProblem('');
    if (trigger?.isConnected) trigger.focus();
  }
  // Focus moves into the dialog as soon as it exists, so keyboard and screen
  // reader users are never left behind on the history table.
  useEffect(() => {
    if (reversal) reversalReasonField.current?.focus();
    // The row that triggered the dialog may no longer offer the action, so the
    // announced result is the focus target once the dialog is gone.
    else if (reversalNotice) reversalNoticeArea.current?.focus();
  }, [reversal, reversalNotice]);

  async function confirmReversal() {
    const open = reversal;
    if (!open || reversalBusy || pending.current) return;
    let canonicalReason: string;
    try { canonicalReason = canonicalStockEntryReversalReason(reversalReason); }
    catch { setReversalProblem('El motivo es obligatorio: escribí entre 1 y 500 caracteres.'); return; }
    if (reversalAttempt.current === null || reversalAttempt.current.target !== open.row.id
      || reversalAttempt.current.reason !== canonicalReason) {
      try {
        reversalAttempt.current = { target: open.row.id, reason: canonicalReason, key: newStockEntryOperationKey() };
      } catch {
        setReversalProblem('No se pudo generar una clave segura para este contra-asiento. No se envió nada.');
        return;
      }
    }
    const attempt = reversalAttempt.current;
    let input: StockEntryReversalInput;
    try { input = canonicalStockEntryReversalInput({ operation_key: attempt.key, reason: canonicalReason }); }
    catch { setReversalProblem('El motivo del contra-asiento no es válido. Revisá el texto e intentá de nuevo.'); return; }
    pending.current = true; setReversalBusy(true); setReversalProblem(''); setReversalNotice('');
    try {
      const result = await api.reverse(open.row, input, csrf, lifetime.current.signal);
      if (!mounted.current || lifetime.current.signal.aborted) return;
      reversalAttempt.current = null;
      const units = result.record.total_units;
      const counter = result.record.id;
      const replayed = result.replayed;
      setReversal(null); setReversalReason('');
      // The counter-entry is the newest document, so the ledger restarts at page
      // one; the catalog is refreshed because the balances moved.
      setHistoryPage(1); setHistoryRevision(value => value + 1); setRevision(value => value + 1);
      setReversalNotice(`Contra-asiento registrado: documento ${counter} · ${units} ${units === -1 ? 'unidad' : 'unidades'}${replayed ? ' (reintento sin duplicar)' : ''}.`);
    } catch (failure) {
      if (!mounted.current || lifetime.current.signal.aborted) return;
      const code: StockEntryReversalErrorCode = failure instanceof StockEntryReversalAPIError ? failure.code : 'invalid_response';
      // A definite rejection wrote nothing: the next attempt is a new intent.
      if (stockEntryReversalFailureIsDefinite(code)) reversalAttempt.current = null;
      // A stale row is not a reason to keep a dialog open on a document the
      // server already resolved; the history is reloaded instead.
      if (code === 'not_found' || code === 'decision_conflict') {
        setReversal(null); setReversalReason('');
        setHistoryRevision(value => value + 1);
        setReversalNotice(stockEntryReversalErrorMessages[code]);
      } else {
        setReversalProblem(stockEntryReversalErrorMessages[code]);
      }
    } finally {
      pending.current = false;
      if (mounted.current) setReversalBusy(false);
    }
  }

  // ---- document detail --------------------------------------------------------
  function openDetail(row: StockEntryHistoryRow, trigger: HTMLButtonElement) {
    if (detail || reversal || reversalBusy) return;
    // The previous document is dropped before the new read starts, so no render can
    // pair a new row with the detail of the one before it.
    setDetailLoad({ id: row.id, phase: 'loading', document: null, problem: '' });
    setDetail({ row, trigger });
  }
  function closeDetail() {
    const trigger = detail?.trigger;
    setDetail(null);
    setDetailLoad({ id: 0, phase: 'loading', document: null, problem: '' });
    if (trigger?.isConnected) trigger.focus();
  }
  // Focus moves into the dialog as soon as it exists, so keyboard and screen
  // reader users are never left behind on the history table.
  useEffect(() => {
    if (detail) detailDialog.current?.focus();
  }, [detail]);

  const supplierChoices = suppliersState.phase === 'ready' && suppliersState.page ? suppliersState.page.suppliers : [];
  // Only the kinds this supplier actually offers are offered here: choosing it
  // never shows a kind that would open an empty catalogue.
  const offeredKinds = supplier === null ? [] : stockEntryKinds.filter(option => supplier.kinds.includes(option));
  // The picker reads products, so the counters and the rows count products even
  // when the catalogue answered two polarities for one of them.
  const catalogProducts = supplierCatalogProductCount(catalogGroups);
  const draftUnits = new Map(lines.map(line => [line.variant_id,
    validStockQuantity(Number(line.quantity)) ? Number(line.quantity) : 0] as const));
  // The group where the operator is working: the brand of the most recently added
  // line, or the first group while the document is empty.
  const lastLine = lines.length > 0 ? lines[lines.length - 1] : null;
  const activeGroupKey = (lastLine === null ? null : supplierCatalogGroupKeyOf(catalogGroups, lastLine.variant_id))
    ?? (catalogGroups.length > 0 ? catalogGroups[0].key : null);
  const openGroupKeys = expandedGroups === null
    ? (activeGroupKey === null ? [] : [activeGroupKey])
    : expandedGroups === 'all' ? catalogGroups.map(group => group.key) : expandedGroups;
  const groupIsOpen = (key: string) => openGroupKeys.includes(key);
  // A group header opens and closes its own rows in place; with every group open
  // it closes only the one that was clicked.
  function toggleGroup(key: string) {
    setExpandedGroups(groupIsOpen(key)
      ? openGroupKeys.filter(candidate => candidate !== key)
      : [...openGroupKeys, key]);
  }
  const historyRows = history.phase === 'ready' && history.page ? history.page.entries : [];
  // A detail is only ever rendered for the document that asked for it.
  const detailView = detail && detailLoad.id === detail.row.id ? detailLoad : null;
  const detailDocument = detailView?.phase === 'ready' ? detailView.document : null;
  // A document is of one kind, so the detail table of a product document reads the
  // name and the detail of every line and never invents a battery attribute.
  const detailKind = detailDocument && detailDocument.lines.length > 0 ? detailDocument.lines[0].kind : null;
  const historyTotal = history.page ? history.page.total_entries : 0;
  const historyCount = history.phase === 'ready'
    ? `${historyTotal} ${historyTotal === 1 ? 'ingreso' : 'ingresos'}` : 'Almacén';
  const nextHistoryPage = () => {
    if (history.page && historyPage < stockEntryHistoryMaxPage && historyPage * historySize < history.page.total_entries) {
      setHistoryPage(historyPage + 1);
    }
  };
  return <section className="stock-entry" aria-labelledby="stock-entry-title">
    <header className="stock-entry-heading">
      <small>ALMACÉN / INGRESOS</small>
      <h1 id="stock-entry-title">Nuevo ingreso de stock</h1>
      <p>Registrá la mercadería que entra al depósito. El stock se aplica recién al confirmar.</p>
    </header>
    {/* One compact strip: the supplier is the context of the document, and the
        kind is a fact when the supplier offers one and a control only when it
        offers both. No sentence explains a step that does not exist (S4). */}
    <section className="stock-entry-panel stock-context" aria-label="Contexto del documento"
      aria-busy={suppliersState.phase === 'loading'}>
      <label className="stock-context-field stock-context-supplier" htmlFor="stock-supplier">Proveedor
        <select id="stock-supplier" value={supplier?.id ?? ''} disabled={busy || suppliersState.phase !== 'ready'}
          onChange={event => {
            const next = supplierChoices.find(choice => String(choice.id) === event.target.value);
            if (next) chooseSupplier(next, event.currentTarget);
          }}>
          <option value="">Elegí un proveedor</option>
          {supplierChoices.map(choice => <option key={choice.id} value={choice.id} disabled={choice.retired}>
            {choice.name} · {offerCount(choice)}{choice.retired ? ' · Retirado' : ''}
          </option>)}
        </select>
      </label>
      <span className="stock-tag">{supplier === null ? 'Sin elegir' : offerCount(supplier)}</span>
      {kind !== null && offeredKinds.length === 1 && <span className="stock-chip" role="note"
        aria-label="Tipo del documento">{stockEntryKindLabels[kind]}</span>}
      {offeredKinds.length > 1 && <div className="stock-context-kind" role="group" aria-label="Tipo de producto del ingreso">
        {offeredKinds.map(option => <button type="button" key={option} className="stock-context-kind-choice"
          aria-pressed={kind === option} disabled={busy}
          onClick={event => chooseKind(option, event.currentTarget)}>{stockEntryKindLabels[option]}</button>)}
      </div>}
      {supplier !== null && supplier.offers === 0 && <span className="stock-tag">Sin productos</span>}
      {suppliersState.phase === 'loading' && <p className="stock-hint" role="status">Consultando proveedores…</p>}
      {suppliersState.phase === 'error' && <p className="stock-message" role="alert">{suppliersState.problem}
        <button type="button" disabled={busy} onClick={() => setSuppliersRevision(value => value + 1)}>Reintentar proveedores</button></p>}
      {suppliersState.phase === 'ready' && supplierChoices.length === 0 &&
        <p className="stock-message">Todavía no hay proveedores cargados. Creá uno en Catálogo → Proveedores y volvé a intentar.</p>}
      {supplier === null && suppliersState.phase === 'ready' && supplierChoices.length > 0 &&
        <p className="stock-hint" role="status">Elegí el proveedor para ver los productos que podés ingresar.</p>}
    </section>
    {/* A supplier without assigned products cannot receive an ingress: it says so
        instead of opening a picker that could never fill a document (S5). */}
    {supplier !== null && supplier.offers === 0 && <section className="stock-entry-panel stock-empty-panel"
      aria-labelledby="stock-empty-title">
      <div className="stock-panel-head">
        <div><h2 id="stock-empty-title">Proveedor sin productos</h2><p className="stock-hint">{supplier.name}</p></div>
        <span className="stock-tag">Sin productos</span>
      </div>
      <p className="stock-message">{stockSupplierNoOffers}</p>
    </section>}
    {supplier !== null && kind !== null && <div className="stock-entry-panels">
      {/* The catalogue is a bounded region: the search above it, the column head
          pinned inside its own scroll and the counters in a footer of its own, so
          a supplier with 40 products never grows the page (F). Its order is the
          brand groups of H: the group of the last added line open. */}
      <section className="stock-entry-panel stock-catalog-panel" aria-labelledby="stock-catalog-title"
        aria-busy={catalog.phase === 'loading'}>
        <div className="stock-panel-head">
          <div><h2 id="stock-catalog-title">Catálogo</h2>
            <p className="stock-hint">{`${supplier.name} · ${stockEntryKindLabels[kind]} · ${countLabel(catalogGroups.length,
              kind === 'battery' ? 'marca' : 'grupo', kind === 'battery' ? 'marcas' : 'grupos')}`}</p></div>
          <span className="stock-tag">{countLabel(catalogProducts, 'producto', 'productos')}</span>
        </div>
        <label className="stock-search">{kind === 'other' ? 'Buscar nombre o dato del producto' : 'Buscar marca, modelo o capacidad'}
          <input type="search" value={search} placeholder={kind === 'other' ? 'Agua acidulada, 5 L' : 'NS40ZL, TOYO, 45 Ah'}
            onChange={event => setSearch(event.target.value)} />
        </label>
        {catalog.phase === 'ready' && catalog.items.length > 0 && <>
          <section className="stock-catalog-scroll" aria-label="Productos del catálogo">
            <div className="stock-groups">
              {catalogGroups.map((group, index) => {
                const open = groupIsOpen(group.key);
                const headID = `stock-group-head-${index}`;
                const panelID = `stock-group-panel-${index}`;
                const groupUnits = supplierCatalogGroupDraftUnits(group, draftUnits);
                return <div className="stock-group" key={group.key} data-group-key={group.key}>
                  <button type="button" id={headID} className="stock-group-head" aria-expanded={open}
                    aria-controls={panelID} onClick={() => toggleGroup(group.key)}>
                    <span className="stock-group-label">{group.label}</span>
                    <span className="stock-tag">{countLabel(group.products.length, 'producto', 'productos')}</span>
                    {groupUnits > 0 && <span className="stock-tag wine">{groupUnits} u.</span>}
                    <span className="stock-group-mark" aria-hidden="true">▾</span>
                  </button>
                  <div className="stock-group-body" id={panelID}>
                    {open && <table className="stock-table stock-catalog-table">
                      <caption className="sr-only">{`Productos ${group.label} que ofrece ${supplier.name}`}</caption>
                      <thead><tr>
                        <th scope="col">Producto</th>
                        <th scope="col">{kind === 'other' ? 'Agregar' : 'Polaridad'}</th>
                        <th scope="col" className="stock-num">En el documento</th>
                      </tr></thead>
                      <tbody>{group.products.map(product => {
                        const productUnits = supplierCatalogProductDraftUnits(product, draftUnits);
                        return <tr key={product.catalog_entry_id} data-product-id={product.catalog_entry_id}>
                          <td data-label="Producto"><strong>{product.name}</strong><small>{product.detail}</small></td>
                          <td data-label={kind === 'other' ? 'Agregar' : 'Polaridad'}>
                            {kind === 'other'
                              ? <button type="button" className="stock-add" aria-label={`Agregar ${product.name}`}
                                onClick={() => { const variant = product.variants[0]; if (variant) add(variant, group.key); }}>Agregar</button>
                              : <div className="stock-polarities">{product.variants.flatMap(variant => variant.battery === null ? [] : [
                                <button key={variant.variant_id} type="button" className="stock-polarity"
                                  aria-label={`Agregar ${variantName(variant)} polaridad ${variant.battery.polarity}`}
                                  data-variant-id={variant.variant_id}
                                  data-in={draftUnits.has(variant.variant_id) ? 'true' : 'false'}
                                  onClick={() => add(variant, group.key)}>
                                  <span aria-hidden="true">{variant.battery.polarity}</span>
                                  <span aria-hidden="true" className="stock-polarity-count">{draftUnits.get(variant.variant_id) ?? 0}</span>
                                </button>])}</div>}
                          </td>
                          <td data-label="En el documento" className="stock-num"><strong>{`${productUnits} u.`}</strong></td>
                        </tr>;
                      })}</tbody>
                    </table>}
                  </div>
                </div>;
              })}
            </div>
            <button type="button" className="stock-group-all" onClick={() => setExpandedGroups('all')}>
              Ver todos los productos ({catalogProducts})
            </button>
          </section>
          <div className="stock-catalog-foot">
            <p><b>{countLabel(catalogProducts, 'producto', 'productos')}</b> · <b>{countLabel(lines.length, 'línea', 'líneas')}</b> en el documento · <b>{totalUnits} u.</b></p>
            <p>{countLabel(catalogGroups.length, kind === 'battery' ? 'marca' : 'grupo', kind === 'battery' ? 'marcas' : 'grupos')} · un producto que no aparezca acá no se puede ingresar: se asigna en Catálogo → Proveedores.</p>
          </div>
        </>}
        {catalog.phase === 'loading' && <p className="stock-message" role="status">Consultando el catálogo del proveedor…</p>}
        {catalog.phase === 'error' && <p className="stock-message" role="alert">{catalog.problem}
          <button type="button" disabled={busy} onClick={() => setRevision(value => value + 1)}>Reintentar catálogo</button></p>}
        {catalog.phase === 'ready' && catalog.items.length === 0 && <p className="stock-message">Sin coincidencias en el catálogo.</p>}
      </section>
      {/* The document gets the same bounded treatment: the context and the note
          pinned above, the lines in their own scroll with a sticky column head,
          and the totals with the confirmation pinned below (F). */}
      <section className="stock-entry-panel stock-document-panel" aria-labelledby="stock-document-title">
        <div className="stock-doc-head">
          <div className="stock-doc-title">
            <h2 id="stock-document-title">Documento</h2>
            <p className="stock-doc-context">
              <span className="stock-chip" role="note" aria-label="Proveedor del documento">{supplier.name}</span>
              <span className="stock-chip" role="note" aria-label="Tipo del documento">{stockEntryKindLabels[kind]}</span>
              <span className="stock-chip">Sin aplicar</span>
            </p>
          </div>
          <label className="stock-note">Nota (opcional)
            <input value={note} maxLength={stockEntryMaxNote} placeholder="Remito 0002-00045871"
              onChange={event => { forgetAttempt(); setNote(event.target.value); }} />
          </label>
        </div>
        <section className="stock-doc-scroll" aria-label="Líneas del documento">
          {lines.length > 0
            ? <table className="stock-table stock-lines">
              <caption className="sr-only">Líneas del documento</caption>
              <thead><tr><th scope="col">Producto</th><th scope="col" className="stock-num">Cantidad</th>
                <th scope="col"><span className="sr-only">Quitar</span></th></tr></thead>
              <tbody>{lines.map(line => <tr key={line.variant_id} data-variant-id={line.variant_id}>
                <td data-label="Producto"><strong>{line.name}</strong><small>{lineDetail(line)}</small></td>
                <td data-label="Cantidad" className="stock-num"><input className="stock-quantity" type="number" inputMode="numeric"
                  min={1} max={stockEntryMaxQuantity} step={1}
                  aria-label={`Cantidad de ${lineName(line)}`} value={line.quantity}
                  onChange={event => setQuantity(line.variant_id, event.target.value)} /></td>
                <td data-label="Quitar"><button type="button" className="stock-remove"
                  aria-label={`Quitar ${lineName(line)}`} onClick={() => removeLine(line.variant_id)}>×</button></td>
              </tr>)}</tbody>
            </table>
            : <p className="stock-message">Todavía no agregaste líneas.</p>}
        </section>
        <div className="stock-doc-foot">
          <dl className="stock-totals">
            <div><dt>Líneas</dt><dd>{lines.length}</dd></div>
            <div className="stock-units-total"><dt>Unidades</dt><dd>{totalUnits}</dd></div>
          </dl>
          <button type="button" className="primary stock-confirm" disabled={busy || lines.length === 0}
            aria-describedby="stock-confirm-reason" onClick={() => void confirm()}>Confirmar ingreso</button>
          <p className="stock-note" id="stock-confirm-reason">{lines.length === 0
            ? 'Agregá al menos una línea para confirmar. El stock no se toca hasta que confirmes.'
            : 'Se aplica todo junto; al confirmar el documento queda fijo y se corrige con un contra-asiento.'}</p>
          <p role="status" className="stock-status">{status}</p>
        </div>
      </section>
    </div>}
    <section className="stock-entry-panel stock-history" aria-labelledby="stock-history-title" aria-busy={history.phase === 'loading'}>
      <div className="stock-panel-head">
        <div><h2 id="stock-history-title">Historial de ingresos</h2>
          <p className="stock-hint">Los documentos confirmados no se editan ni se borran: se corrigen con un contra-asiento.</p></div>
        <span className="stock-tag">{historyCount}</span>
      </div>
      {historyRows.length > 0 && <div className="stock-table-wrap">
        <table className="stock-table stock-history-table">
          <caption className="sr-only">Historial de ingresos del Almacén</caption>
          <thead><tr><th scope="col">Documento</th><th scope="col">Fecha</th><th scope="col">Nota</th><th scope="col">Líneas</th><th scope="col">Unidades</th><th scope="col">Estado</th><th scope="col">Proveedor</th><th scope="col">Acción</th></tr></thead>
          <tbody>{historyRows.map(row => <tr key={row.id} data-entry-id={row.id}>
            <td data-label="Documento"><strong>#{row.id}</strong></td>
            <td data-label="Fecha"><TransferDate value={row.created_at} /></td>
            <td data-label="Nota">{row.note || '—'}</td>
            <td data-label="Líneas">{row.lines}</td>
            <td data-label="Unidades">{row.total_units}</td>
            <td data-label="Estado">{row.reversed_by === null
              ? <span className="stock-tag">Aplicado</span>
              : <span className="stock-tag reversed">Anulado por contra-asiento</span>}</td>
            {/* A historical document written before suppliers existed keeps its
                null supplier: it is shown as sin proveedor and stays reversible. */}
            <td data-label="Proveedor">{supplierName(row.supplier)}</td>
            <td data-label="Acción"><div className="stock-row-actions">
              <button type="button" className="stock-detail" aria-label={`Ver detalle del ingreso #${row.id}`}
                disabled={reversalBusy} onClick={event => openDetail(row, event.currentTarget)}>Ver detalle</button>
              {stockEntryReversible(row) && <button type="button" className="stock-reverse" aria-label={`Anular ingreso #${row.id}`} disabled={reversalBusy}
                onClick={event => openReversal(row, event.currentTarget)}>Anular</button>}
            </div></td>
          </tr>)}</tbody>
        </table>
      </div>}
      {reversalNotice && <p className="stock-status" role="status" tabIndex={-1} ref={reversalNoticeArea}>{reversalNotice}</p>}
      {history.phase === 'loading' && <p className="stock-message" role="status">Consultando el historial de ingresos…</p>}
      {history.phase === 'error' && <p className="stock-message" role="alert">{history.problem}
        <button type="button" onClick={() => setHistoryRevision(value => value + 1)}>Reintentar historial</button></p>}
      {history.phase === 'ready' && historyRows.length === 0 && <p className="stock-message">Todavía no hay ingresos registrados.</p>}
      <footer className="pager" aria-label="Paginación del historial de ingresos"><div className="page-controls">
        <label htmlFor="stock-history-size">Ingresos por página</label>
        <select id="stock-history-size" value={historySize} onChange={event => {
          const next = Number(event.target.value);
          if (stockEntryHistoryPageSizes.includes(next)) { setHistoryPage(1); setHistorySize(next); }
        }}>{stockEntryHistoryPageSizes.map(value => <option key={value}>{value}</option>)}</select>
        <button type="button" disabled={historyPage <= 1} onClick={() => { if (historyPage > 1) setHistoryPage(historyPage - 1); }}>Anterior página</button>
        <span aria-current="page">Página {historyPage}</span>
        <button type="button" disabled={historyPage >= stockEntryHistoryMaxPage || historyPage * historySize >= historyTotal}
          onClick={nextHistoryPage}>Siguiente página</button>
      </div></footer>
    </section>
    {supplierSwitch && <div className="transfer-decision-backdrop"><section ref={supplierDialog} tabIndex={-1}
      className="transfer-decision-modal stock-supplier-modal" role="dialog" aria-modal="true"
      aria-labelledby="stock-supplier-title" aria-describedby="stock-supplier-notice"
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); closeSupplierSwitch(); return; }
        trapFocus(event, supplierDialog.current);
      }}>
      <header><div><h2 id="stock-supplier-title">Cambiar de proveedor</h2>
        <p>Documento de {supplierName(supplier)} · {lines.length} {lines.length === 1 ? 'línea' : 'líneas'}</p></div>
        <button type="button" aria-label="Cerrar cambio de proveedor" disabled={busy} onClick={closeSupplierSwitch}>×</button></header>
      <div className="stock-detail-body">
        <p id="stock-supplier-notice" className="stock-hint">El ingreso es de un solo proveedor. Si cambiás a
          {' '}<strong>{supplierSwitch.next.name}</strong>, se descarta el borrador completo: las líneas cargadas no
          se convierten ni se migran al catálogo del otro proveedor.</p>
      </div>
      <footer><button type="button" disabled={busy} onClick={closeSupplierSwitch}>Cancelar</button>
        <button type="button" className="primary" disabled={busy}
          onClick={() => applySupplier(supplierSwitch.next)}>Descartar borrador y cambiar proveedor</button></footer>
    </section></div>}
    {kindSwitch && <div className="transfer-decision-backdrop"><section ref={kindDialog} tabIndex={-1}
      className="transfer-decision-modal stock-kind-modal" role="dialog" aria-modal="true"
      aria-labelledby="stock-kind-title" aria-describedby="stock-kind-notice"
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); closeKindSwitch(); return; }
        trapFocus(event, kindDialog.current);
      }}>
      <header><div><h2 id="stock-kind-title">Cambiar el tipo del ingreso</h2>
        <p>Documento de {kind === null ? '' : stockEntryKindLabels[kind]} · {lines.length} {lines.length === 1 ? 'línea' : 'líneas'}</p></div>
        <button type="button" aria-label="Cerrar cambio de tipo" disabled={busy} onClick={closeKindSwitch}>×</button></header>
      <div className="stock-detail-body">
        <p id="stock-kind-notice" className="stock-hint">Un documento nunca mezcla los dos tipos. Si cambiás a
          {' '}<strong>{stockEntryKindLabels[kindSwitch.next]}</strong>, se descarta el borrador completo: las líneas
          cargadas no se convierten ni se migran.</p>
      </div>
      <footer><button type="button" disabled={busy} onClick={closeKindSwitch}>Cancelar</button>
        <button type="button" className="primary" disabled={busy}
          onClick={() => applyKind(kindSwitch.next)}>Descartar borrador y cambiar tipo</button></footer>
    </section></div>}
    {reversal && <div className="transfer-decision-backdrop"><section ref={reversalDialog} tabIndex={-1}
      className="transfer-decision-modal stock-reversal-modal" role="dialog" aria-modal="true"
      aria-labelledby="stock-reversal-title" aria-describedby="stock-reversal-notice" aria-busy={reversalBusy}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); closeReversal(); return; }
        trapFocus(event, reversalDialog.current);
      }}>
      <header><div><h2 id="stock-reversal-title">Registrar contra-asiento</h2>
        <p>Documento #{reversal.row.id} · <TransferDate value={reversal.row.created_at} /> · {reversal.row.note || 'sin nota'}</p></div>
        <button type="button" aria-label="Cerrar contra-asiento" disabled={reversalBusy} onClick={closeReversal}>×</button></header>
      <div className="stock-reversal-body">
        <dl className="stock-reversal-summary">
          <div><dt>Líneas</dt><dd>{reversal.row.lines}</dd></div>
          <div><dt>Unidades del original</dt><dd>{reversal.row.total_units}</dd></div>
          <div><dt>Unidades del contra-asiento</dt><dd>{-reversal.row.total_units}</dd></div>
        </dl>
        <p id="stock-reversal-notice" className="stock-hint">Se registra un documento nuevo con las mismas líneas en negativo y este motivo.
          El contra-asiento hereda el proveedor del original: no se pide de nuevo.
          El original nunca cambia: queda Aplicado en el historial y el contra-asiento aparece como documento aparte.</p>
        <label className="stock-reversal-reason" htmlFor="stock-reversal-reason">Motivo del contra-asiento
          <textarea id="stock-reversal-reason" ref={reversalReasonField} required maxLength={stockEntryMaxReason}
            aria-describedby="stock-reversal-required" value={reversalReason}
            onChange={event => setReversalReason(event.target.value)} />
        </label>
        <p id="stock-reversal-required" className="stock-hint">Obligatorio: entre 1 y {stockEntryMaxReason} caracteres. {Array.from(reversalReason).length}/{stockEntryMaxReason}</p>
        {reversalBusy && <p role="status" className="stock-status">Registrando contra-asiento…</p>}
        {reversalProblem && <p role="alert" className="stock-status">{reversalProblem}</p>}
      </div>
      <footer><button type="button" disabled={reversalBusy} onClick={closeReversal}>Cancelar</button>
        <button type="button" className="primary" disabled={reversalBusy} onClick={() => void confirmReversal()}>Confirmar contra-asiento</button></footer>
    </section></div>}
    {detail && <div className="transfer-decision-backdrop"><section ref={detailDialog} tabIndex={-1}
      className="transfer-decision-modal stock-detail-modal" role="dialog" aria-modal="true"
      aria-labelledby="stock-detail-title" aria-busy={detailView?.phase !== 'ready'}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); closeDetail(); return; }
        trapFocus(event, detailDialog.current);
      }}>
      <header><div><h2 id="stock-detail-title">Detalle del ingreso #{detail.row.id}</h2>
        <p>Documento #{detail.row.id} · <TransferDate value={detail.row.created_at} /> · {detail.row.note || 'sin nota'}</p></div>
        <button type="button" aria-label="Cerrar detalle del ingreso" onClick={closeDetail}>×</button></header>
      <div className="stock-detail-body">
        {(!detailView || detailView.phase === 'loading') && <p role="status" className="stock-message">Consultando el detalle del ingreso…</p>}
        {detailView?.phase === 'error' && <p role="alert" className="stock-message">{detailView.problem}
          <button type="button" onClick={() => setDetailRevision(value => value + 1)}>Reintentar detalle</button></p>}
        {detailView?.phase === 'ready' && detailView.document && <>
          <dl className="stock-detail-summary">
            <div><dt>Documento</dt><dd>#{detailView.document.id}</dd></div>
            <div><dt>Fecha</dt><dd><TransferDate value={detailView.document.created_at} /></dd></div>
            <div><dt>Proveedor</dt><dd>{supplierName(detailView.document.supplier)}</dd></div>
            <div><dt>Estado</dt><dd>{detailView.document.reverses_entry_id !== null
              ? 'Contra-asiento'
              : detailView.document.reversed_by !== null
                ? `Anulado por contra-asiento #${detailView.document.reversed_by}`
                : 'Aplicado'}</dd></div>
            {detailView.document.note !== '' && <div><dt>Nota</dt><dd>{detailView.document.note}</dd></div>}
            {detailView.document.reverses_entry_id !== null &&
              <div><dt>Contra-asiento del documento</dt><dd>#{detailView.document.reverses_entry_id}</dd></div>}
            {detailView.document.reverses_entry_id !== null &&
              <div><dt>Motivo</dt><dd>{detailView.document.reason}</dd></div>}
          </dl>
          <div className="stock-table-wrap">
            {detailKind === 'other'
              ? <table className="stock-table stock-detail-table">
                <caption className="sr-only">Unidades que entraron con este documento</caption>
                <thead><tr><th scope="col">Producto</th><th scope="col">Detalle</th><th scope="col">Cantidad</th></tr></thead>
                <tbody>{detailView.document.lines.map(line => <tr key={line.variant_id} data-variant-id={line.variant_id}>
                  <td data-label="Producto"><strong>{line.name}</strong></td>
                  <td data-label="Detalle">{line.detail}</td>
                  <td data-label="Cantidad">{line.quantity}</td>
                </tr>)}</tbody>
              </table>
              : <table className="stock-table stock-detail-table">
                <caption className="sr-only">Unidades que entraron con este documento</caption>
                <thead><tr><th scope="col">Producto</th><th scope="col">Capacidad</th><th scope="col">Polaridad</th><th scope="col">Cantidad</th></tr></thead>
                <tbody>{detailBatteryLines(detailView.document.lines).map(({ line, battery }) => <tr key={line.variant_id} data-variant-id={line.variant_id}>
                  <td data-label="Producto"><strong>{line.name}</strong></td>
                  <td data-label="Capacidad">{battery.capacity_ah} Ah</td>
                  <td data-label="Polaridad"><span className="polarity">{battery.polarity}</span></td>
                  <td data-label="Cantidad">{line.quantity}</td>
                </tr>)}</tbody>
              </table>}
          </div>
          <p className="stock-detail-total">{`Unidades del documento: ${detailView.document.total_units}`}</p>
          <p className="stock-hint">Un documento confirmado no se edita ni se borra: estas son las líneas que se aplicaron al stock del Almacén.</p>
        </>}
      </div>
      <footer><button type="button" onClick={closeDetail}>Volver</button></footer>
    </section></div>}
  </section>;
}
