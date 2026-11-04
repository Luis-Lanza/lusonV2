import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { validSearch } from './model';
import TransferDate from './TransferDate';
import { createStockAdjustmentAPI, StockAdjustmentAPIError } from './stockAdjustmentAPI';
import {
  canonicalStockAdjustmentInput, canonicalStockAdjustmentReason, canonicalStockAdjustmentReversalInput,
  newStockAdjustmentOperationKey, stockAdjustmentApplyMessages, stockAdjustmentCatalogUnavailable,
  stockAdjustmentDefaultPageSize, stockAdjustmentFailureIsDefinite, stockAdjustmentHistoryUnavailable,
  stockAdjustmentMaxCounted, stockAdjustmentMaxPage, stockAdjustmentPageSizes,
  stockAdjustmentMotives, stockAdjustmentReadMessages, stockAdjustmentReversalMessages, stockAdjustmentReversible,
  validStockAdjustmentCounted, validStockAdjustmentHistoryQuery,
  type StockAdjustmentCatalogItem, type StockAdjustmentDetail, type StockAdjustmentErrorCode,
  type StockAdjustmentInput, type StockAdjustmentPage, type StockAdjustmentReversalInput,
  type StockAdjustmentSummary,
} from './stockAdjustmentModel';
import './stock-entry.css';
import './stock-adjustments.css';

/** The counted line of the local draft: the identity is for the operator, never for the payload. */
interface CountedLine {
  readonly variant_id: number; readonly brand: string; readonly model: string;
  readonly capacity_ah: string; readonly polarity: 'L' | 'R'; readonly counted: string;
}
interface CatalogState { readonly phase: 'loading' | 'ready' | 'error'; readonly items: readonly StockAdjustmentCatalogItem[]; readonly problem: string }
// The history is its own state: a failed read never touches the draft document.
interface HistoryState { readonly phase: 'loading' | 'ready' | 'error'; readonly page: StockAdjustmentPage | null; readonly problem: string }
// Every detail read is tagged with the document it asked about, so a reply for one
// row can never be rendered under another.
interface DetailState {
  readonly id: number;
  readonly phase: 'loading' | 'ready' | 'error';
  readonly document: StockAdjustmentDetail | null;
  readonly problem: string;
}

/**
 * The realtime seam this section needs: the existing inventory invalidation of the
 * app controller. A stock change made anywhere (ingress, transfer, another
 * adjustment) refreshes this ledger instead of leaving stale numbers on screen.
 */
export interface StockAdjustmentRealtime {
  subscribeSourceInventoryInvalidation: (listener: () => void) => () => void;
}

export interface StockAdjustmentProps {
  // The parent remounts this section per session fence, so a rotated session or
  // CSRF token can never publish a result into a newer warehouse session.
  csrf: string;
  fetcher?: typeof globalThis.fetch;
  realtime?: StockAdjustmentRealtime;
}

const productLabel = (row: { brand: string; model: string }) => `${row.brand} · ${row.model}`;
/** A difference is always shown with its sign, so a gain is never mistaken for a loss. */
const signed = (value: number) => value > 0 ? `+${value}` : String(value);
const deltaClass = (value: number) => value > 0 ? 'adjustment-delta positive' : value < 0 ? 'adjustment-delta negative' : 'adjustment-delta';
const focusableWithin = (element: HTMLElement | null) => Array.from(element?.querySelectorAll<HTMLElement>(
  'button:not(:disabled), textarea:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]') ?? []);

export default function StockAdjustment({ csrf, fetcher = globalThis.fetch, realtime }: StockAdjustmentProps) {
  const api = useMemo(() => createStockAdjustmentAPI(fetcher), [fetcher]);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [catalogRevision, setCatalogRevision] = useState(0);
  const [catalog, setCatalog] = useState<CatalogState>({ phase: 'loading', items: [], problem: stockAdjustmentCatalogUnavailable });
  const [lines, setLines] = useState<readonly CountedLine[]>([]);
  const [motive, setMotive] = useState('');
  const [drawerStatus, setDrawerStatus] = useState('');
  const [drawerProblem, setDrawerProblem] = useState('');
  const [applyBusy, setApplyBusy] = useState(false);
  const [historyStatus, setHistoryStatus] = useState('');
  const [historyPage, setHistoryPage] = useState(1);
  const [historySize, setHistorySize] = useState(stockAdjustmentDefaultPageSize);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [history, setHistory] = useState<HistoryState>({ phase: 'loading', page: null, problem: stockAdjustmentHistoryUnavailable });
  const [expanded, setExpanded] = useState<number | null>(null);
  const [detail, setDetail] = useState<DetailState | null>(null);
  const [detailRevision, setDetailRevision] = useState(0);
  // The counter-entry dialog: one document at a time, its own motive and its own key.
  const [reversal, setReversal] = useState<{ row: StockAdjustmentSummary; trigger: HTMLButtonElement } | null>(null);
  const [reversalMotive, setReversalMotive] = useState('');
  const [reversalProblem, setReversalProblem] = useState('');
  const [reversalBusy, setReversalBusy] = useState(false);
  const drawerDialog = useRef<HTMLElement>(null);
  const drawerTrigger = useRef<HTMLButtonElement>(null);
  const searchField = useRef<HTMLInputElement>(null);
  const reversalDialog = useRef<HTMLElement>(null);
  const reversalMotiveField = useRef<HTMLSelectElement>(null);
  const lifetime = useRef(new AbortController());
  const mounted = useRef(true);
  const pending = useRef(false);
  // One key per unchanged draft: an uncertain retry replays exactly, an edit becomes a new document.
  const operationKey = useRef<string | null>(null);
  // One key per (target, motive): an uncertain retry replays exactly, and another
  // motive becomes another counter-entry intent.
  const reversalAttempt = useRef<{ target: number; reason: string; key: string } | null>(null);

  useEffect(() => {
    const flight = lifetime.current;
    mounted.current = true;
    return () => { mounted.current = false; flight.abort(); };
  }, []);

  // The capture catalogue is a quantity-free projection, so it is read only while
  // the operator is actually counting. It never replaces the inventory read.
  useEffect(() => {
    if (!open) return;
    if (!validSearch(search)) {
      setCatalog({ phase: 'error', items: [], problem: 'La búsqueda admite hasta 128 bytes UTF-8, sin caracteres inválidos.' });
      return;
    }
    const controller = new AbortController();
    const alive = () => mounted.current && !controller.signal.aborted && !lifetime.current.signal.aborted;
    setCatalog({ phase: 'loading', items: [], problem: stockAdjustmentCatalogUnavailable });
    void (async () => {
      try {
        const page = await api.catalog(search, controller.signal);
        if (!alive()) return;
        setCatalog({ phase: 'ready', items: page.items, problem: '' });
      } catch (failure) {
        if (!alive()) return;
        const code: StockAdjustmentErrorCode = failure instanceof StockAdjustmentAPIError ? failure.code : 'invalid_response';
        setCatalog({ phase: 'error', items: [], problem: stockAdjustmentReadMessages[code] });
      }
    })();
    return () => controller.abort();
  }, [api, open, search, catalogRevision]);

  useEffect(() => {
    const controller = new AbortController();
    const alive = () => mounted.current && !controller.signal.aborted && !lifetime.current.signal.aborted;
    setHistory(current => ({ phase: 'loading', page: current.page, problem: stockAdjustmentHistoryUnavailable }));
    void (async () => {
      try {
        const page = await api.history(historyPage, historySize, controller.signal);
        if (!alive()) return;
        setHistory({ phase: 'ready', page, problem: '' });
      } catch {
        if (alive()) setHistory(current => ({ ...current, phase: 'error', problem: stockAdjustmentHistoryUnavailable }));
      }
    })();
    return () => controller.abort();
  }, [api, historyPage, historySize, historyRevision]);

  // One document read per expanded row: the read is aborted when the row closes or
  // another opens, and only a reply for the requested id is stored.
  useEffect(() => {
    if (expanded === null) return;
    const id = expanded;
    const controller = new AbortController();
    const alive = () => mounted.current && !controller.signal.aborted && !lifetime.current.signal.aborted;
    setDetail({ id, phase: 'loading', document: null, problem: '' });
    void (async () => {
      try {
        const document = await api.detail(id, controller.signal);
        if (!alive() || document.id !== id) return;
        setDetail({ id, phase: 'ready', document, problem: '' });
      } catch (failure) {
        if (!alive()) return;
        const code: StockAdjustmentErrorCode = failure instanceof StockAdjustmentAPIError ? failure.code : 'invalid_response';
        setDetail({ id, phase: 'error', document: null, problem: stockAdjustmentReadMessages[code] });
      }
    })();
    return () => controller.abort();
  }, [api, expanded, detailRevision]);

  // A stock change elsewhere invalidates this ledger: the history, the expanded
  // document and the capture catalogue are read again instead of showing stale numbers.
  const subscribeInventory = realtime?.subscribeSourceInventoryInvalidation;
  useEffect(() => {
    if (!subscribeInventory) return;
    return subscribeInventory(() => {
      if (!mounted.current || pending.current) return;
      setCatalogRevision(value => value + 1);
      setHistoryRevision(value => value + 1);
      setDetailRevision(value => value + 1);
    });
  }, [subscribeInventory]);

  useEffect(() => { if (open) searchField.current?.focus(); }, [open]);
  useEffect(() => { if (reversal) reversalMotiveField.current?.focus(); }, [reversal]);

  function forgetAttempt() { operationKey.current = null; }
  function toggleRow(id: number) {
    if (expanded === id) { setExpanded(null); return; }
    setDetail({ id, phase: 'loading', document: null, problem: '' });
    setExpanded(id);
  }
  function setCounted(item: StockAdjustmentCatalogItem, value: string) {
    if (!/^\d{0,7}$/.test(value)) return;
    forgetAttempt(); setDrawerStatus(''); setDrawerProblem('');
    if (value === '') {
      setLines(lines.filter(line => line.variant_id !== item.variant_id));
      return;
    }
    const line: CountedLine = { variant_id: item.variant_id, brand: item.brand, model: item.model,
      capacity_ah: item.capacity_ah, polarity: item.polarity, counted: value };
    const current = lines.find(entry => entry.variant_id === item.variant_id);
    setLines(current ? lines.map(entry => entry.variant_id === item.variant_id ? line : entry) : [...lines, line]);
  }
  function openDrawer() {
    if (applyBusy) return;
    forgetAttempt(); setLines([]); setMotive(''); setDrawerStatus(''); setDrawerProblem(''); setSearch('');
    setOpen(true);
  }
  function closeDrawer() {
    if (applyBusy) return;
    setOpen(false);
    if (drawerTrigger.current?.isConnected) drawerTrigger.current.focus();
  }
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

  const countedValid = lines.every(line => validStockAdjustmentCounted(Number(line.counted)));
  const motiveValid = stockAdjustmentMotives.includes(motive as (typeof stockAdjustmentMotives)[number]);

  async function apply() {
    if (applyBusy || pending.current) return;
    if (!lines.length) { setDrawerStatus('Agregá al menos una variante contada antes de aplicar.'); return; }
    if (!motiveValid) { setDrawerStatus('Elegí un motivo del ajuste antes de aplicar.'); return; }
    if (!countedValid) { setDrawerStatus('Cantidad inválida: ingresá un entero entre 0 y 1.000.000 en cada línea contada.'); return; }
    if (operationKey.current === null) {
      try { operationKey.current = newStockAdjustmentOperationKey(); }
      catch { setDrawerStatus('No se pudo generar una clave segura para este ajuste. No se envió nada.'); return; }
    }
    const input: StockAdjustmentInput = { operation_key: operationKey.current, reason: motive,
      lines: lines.map(line => ({ variant_id: line.variant_id, counted_quantity: Number(line.counted) })) };
    let prepared: StockAdjustmentInput;
    try { prepared = canonicalStockAdjustmentInput(input); }
    catch { setDrawerStatus('El documento no es válido. Revisá las cantidades contadas y el motivo.'); return; }
    pending.current = true; setApplyBusy(true); setDrawerStatus('Aplicando el ajuste…'); setDrawerProblem('');
    try {
      const result = await api.create(prepared, csrf, lifetime.current.signal);
      if (!mounted.current || lifetime.current.signal.aborted) return;
      forgetAttempt();
      setLines([]); setMotive(''); setDrawerStatus(''); setDrawerProblem('');
      // The operator only learns the expected quantity and the difference once the
      // document is applied, so the panel closes and the new document opens by itself.
      setOpen(false);
      setCatalogRevision(value => value + 1);
      setHistoryPage(1); setHistoryRevision(value => value + 1);
      setDetail({ id: result.record.id, phase: 'loading', document: null, problem: '' });
      setExpanded(result.record.id);
      setHistoryStatus(`Ajuste #${result.record.id} aplicado: diferencia total ${signed(result.record.total_difference)}.`
        + `${result.replayed ? ' Reintento sin duplicar.' : ''} Abrimos el documento para ver el esperado, lo contado y la diferencia.`);
    } catch (failure) {
      if (!mounted.current || lifetime.current.signal.aborted) return;
      const code: StockAdjustmentErrorCode = failure instanceof StockAdjustmentAPIError ? failure.code : 'invalid_response';
      // A definite rejection wrote nothing; anything else keeps the key for a replay.
      if (stockAdjustmentFailureIsDefinite(code)) forgetAttempt();
      // A rejection is announced as an error, never as progress, and nothing is retried.
      setDrawerStatus(''); setDrawerProblem(stockAdjustmentApplyMessages[code]);
    } finally {
      pending.current = false;
      if (mounted.current) setApplyBusy(false);
    }
  }

  // ---- counter-entry ----------------------------------------------------------
  function openReversal(row: StockAdjustmentSummary, trigger: HTMLButtonElement) {
    if (reversal || reversalBusy || !stockAdjustmentReversible(row)) return;
    reversalAttempt.current = null;
    setReversalMotive(''); setReversalProblem('');
    setReversal({ row, trigger });
  }
  function closeReversal() {
    if (reversalBusy) return;
    const trigger = reversal?.trigger;
    setReversal(null); setReversalMotive(''); setReversalProblem('');
    if (trigger?.isConnected) trigger.focus();
  }
  async function confirmReversal() {
    const openReversalRow = reversal;
    if (!openReversalRow || reversalBusy || pending.current) return;
    let canonicalReason: string;
    try { canonicalReason = canonicalStockAdjustmentReason(reversalMotive); }
    catch {
      setReversalProblem('El motivo del contra-asiento es obligatorio: elegí uno de los motivos de la lista.');
      return;
    }
    if (reversalAttempt.current === null || reversalAttempt.current.target !== openReversalRow.row.id
      || reversalAttempt.current.reason !== canonicalReason) {
      try {
        reversalAttempt.current = { target: openReversalRow.row.id, reason: canonicalReason, key: newStockAdjustmentOperationKey() };
      } catch {
        setReversalProblem('No se pudo generar una clave segura para este contra-asiento. No se envió nada.');
        return;
      }
    }
    const attempt = reversalAttempt.current;
    let input: StockAdjustmentReversalInput;
    try { input = canonicalStockAdjustmentReversalInput({ operation_key: attempt.key, reason: canonicalReason }); }
    catch { setReversalProblem('El motivo del contra-asiento no es válido. Elegí un motivo e intentá de nuevo.'); return; }
    pending.current = true; setReversalBusy(true); setReversalProblem('');
    try {
      const result = await api.reverse(openReversalRow.row, input, csrf, lifetime.current.signal);
      if (!mounted.current || lifetime.current.signal.aborted) return;
      reversalAttempt.current = null;
      setReversal(null); setReversalMotive('');
      setCatalogRevision(value => value + 1);
      setHistoryPage(1); setHistoryRevision(value => value + 1);
      setDetail({ id: result.record.id, phase: 'loading', document: null, problem: '' });
      setExpanded(result.record.id);
      setHistoryStatus(`Contra-asiento registrado: documento #${result.record.id}. Diferencia total ${signed(result.record.total_difference)}.`
        + `${result.replayed ? ' Reintento sin duplicar.' : ''} El original y su contra-asiento quedan visibles.`);
    } catch (failure) {
      if (!mounted.current || lifetime.current.signal.aborted) return;
      const code: StockAdjustmentErrorCode = failure instanceof StockAdjustmentAPIError ? failure.code : 'invalid_response';
      // A definite rejection wrote nothing: the next attempt is a new intent.
      if (stockAdjustmentFailureIsDefinite(code)) reversalAttempt.current = null;
      // A document the server already resolved is not worth a dialog: reload the ledger.
      if (code === 'not_found' || code === 'decision_conflict') {
        setReversal(null); setReversalMotive('');
        setHistoryRevision(value => value + 1); setCatalogRevision(value => value + 1);
        setHistoryStatus(stockAdjustmentReversalMessages[code]);
      } else {
        setReversalProblem(stockAdjustmentReversalMessages[code]);
      }
    } finally {
      pending.current = false;
      if (mounted.current) setReversalBusy(false);
    }
  }

  // ---- rendering --------------------------------------------------------------
  const rows = history.phase === 'ready' && history.page ? history.page.adjustments : [];
  const historyTotal = history.page ? history.page.total_adjustments : 0;
  const historyCount = history.phase === 'ready'
    ? `${historyTotal} ${historyTotal === 1 ? 'documento' : 'documentos'}` : 'Almacén';
  const badgeOf = (row: StockAdjustmentSummary) => row.reversed_by !== null
    ? <span className="adjustment-tag reversed">Revertido</span>
    : row.reverses_adjustment_id !== null
      ? <span className="adjustment-tag counter">Contra-asiento</span>
      : <span className="adjustment-tag applied">Aplicado</span>;

  function detailPanel(row: StockAdjustmentSummary) {
    const view = detail && detail.id === row.id ? detail : { id: row.id, phase: 'loading' as const, document: null, problem: '' };
    return <div className="adjustment-lines" aria-busy={view.phase === 'loading'}>
      {view.phase === 'loading' && <p className="stock-message">Consultando el detalle del ajuste…</p>}
      {view.phase === 'error' && <p role="alert" className="stock-message">{view.problem}
        <button type="button" onClick={() => setDetailRevision(value => value + 1)}>Reintentar detalle</button></p>}
      {view.phase === 'ready' && view.document && <>
        <dl className="adjustment-summary">
          <div><dt>Documento</dt><dd>#{view.document.id}</dd></div>
          <div><dt>Fecha</dt><dd><TransferDate value={view.document.created_at} /></dd></div>
          <div><dt>Motivo</dt><dd>{view.document.reason}</dd></div>
          <div><dt>Diferencia total</dt><dd><span className={deltaClass(view.document.total_difference)}>{signed(view.document.total_difference)}</span></dd></div>
          {view.document.detail !== '' && <div><dt>Detalle</dt><dd>{view.document.detail}</dd></div>}
        </dl>
        <div className="stock-table-wrap">
          <table className="stock-table adjustment-line-table">
            <caption className="sr-only">Líneas del ajuste #{view.document.id} con esperado, contado y diferencia</caption>
            <thead><tr><th scope="col">Producto</th><th scope="col">Capacidad</th><th scope="col">Polaridad</th>
              <th scope="col">Esperado</th><th scope="col">Contado</th><th scope="col">Diferencia</th></tr></thead>
            <tbody>{view.document.lines.map(line => <tr key={line.variant_id} data-variant-id={line.variant_id}>
              <td data-label="Producto"><strong>{productLabel(line)}</strong></td>
              <td data-label="Capacidad">{line.capacity_ah} Ah</td>
              <td data-label="Polaridad"><span className="polarity">{line.polarity}</span></td>
              <td data-label="Esperado">{line.expected_quantity}</td>
              <td data-label="Contado">{line.counted_quantity}</td>
              <td data-label="Diferencia"><span className={deltaClass(line.difference)}>{signed(line.difference)}</span></td>
            </tr>)}</tbody>
          </table>
        </div>
        {view.document.reverses_adjustment_id !== null &&
          <p className="stock-hint">{`Contra-asiento del documento #${view.document.reverses_adjustment_id}.`}</p>}
        {view.document.reversed_by !== null &&
          <p className="stock-hint">{`Revertido por el contra-asiento #${view.document.reversed_by} · motivo: “${view.document.reversed_by_reason}”.`}</p>}
        <p className="stock-hint">El esperado es la foto del momento del ajuste: el stock actual puede haber cambiado.</p>
      </>}
    </div>;
  }

  return <section className="stock-adjustment" aria-labelledby="adjustment-title">
    <header className="adjustment-heading">
      <div className="stock-entry-heading">
        <small>ALMACÉN / AJUSTES</small>
        <h1 id="adjustment-title">Historial de ajustes</h1>
        <p>Cada ajuste es un documento inmutable con el esperado, lo contado y la diferencia. Las correcciones son contra-asientos.</p>
      </div>
      <button type="button" className="primary" ref={drawerTrigger} disabled={applyBusy} onClick={openDrawer}>Nuevo ajuste</button>
    </header>
    <section className="stock-entry-panel" aria-labelledby="adjustment-history-title" aria-busy={history.phase === 'loading'}>
      <div className="stock-panel-head">
        <div><h2 id="adjustment-history-title">Documentos</h2>
          <p className="stock-hint">Abrí un documento para ver sus líneas con esperado, contado y diferencia.</p></div>
        <span className="stock-tag">{historyCount}</span>
      </div>
      <p role="status" className="stock-status">{historyStatus}</p>
      {rows.length > 0 && <div className="stock-table-wrap">
        <table className="stock-table adjustment-table">
          <caption className="sr-only">Historial de ajustes del Almacén</caption>
          <thead><tr><th scope="col">Documento</th><th scope="col">Fecha</th><th scope="col">Motivo</th>
            <th scope="col">Líneas</th><th scope="col">Diferencia</th><th scope="col">Estado</th><th scope="col">Acción</th></tr></thead>
          <tbody>{rows.map(row => {
            const isOpen = expanded === row.id;
            return <Fragment key={row.id}>
              <tr className="adjustment-row" data-adjustment-id={row.id} data-expanded={isOpen}
                onClick={event => {
                  if ((event.target as HTMLElement).closest('button, a, input, select')) return;
                  toggleRow(row.id);
                }}>
                <td data-label="Documento"><button type="button" className="adjustment-disclosure"
                  aria-expanded={isOpen} aria-controls={`adjustment-lines-${row.id}`}
                  onClick={event => { event.stopPropagation(); toggleRow(row.id); }}><strong>#{row.id}</strong></button></td>
                <td data-label="Fecha"><TransferDate value={row.created_at} /></td>
                <td data-label="Motivo">{row.reason}{row.detail !== '' && <small>{row.detail}</small>}</td>
                <td data-label="Líneas">{row.lines}</td>
                <td data-label="Diferencia"><span className={deltaClass(row.total_difference)}>{signed(row.total_difference)}</span></td>
                <td data-label="Estado">{badgeOf(row)}</td>
                <td data-label="Acción">{stockAdjustmentReversible(row) && <button type="button" className="adjustment-reverse"
                  aria-label={`Revertir ajuste #${row.id}`} disabled={reversalBusy}
                  onClick={event => openReversal(row, event.currentTarget)}>Revertir</button>}</td>
              </tr>
              {isOpen && <tr className="adjustment-detail-row" id={`adjustment-lines-${row.id}`}>
                <td colSpan={7}>{detailPanel(row)}</td>
              </tr>}
            </Fragment>;
          })}</tbody>
        </table>
      </div>}
      {history.phase === 'loading' && <p className="stock-message">Consultando el historial de ajustes…</p>}
      {history.phase === 'error' && <p role="alert" className="stock-message">{history.problem}
        <button type="button" onClick={() => setHistoryRevision(value => value + 1)}>Reintentar historial</button></p>}
      {history.phase === 'ready' && rows.length === 0 && <p className="stock-message">Todavía no hay ajustes registrados.</p>}
      <footer className="pager" aria-label="Paginación del historial de ajustes"><div className="page-controls">
        <label htmlFor="adjustment-history-size">Ajustes por página</label>
        <select id="adjustment-history-size" value={historySize} onChange={event => {
          const next = Number(event.target.value);
          if (validStockAdjustmentHistoryQuery(1, next)) { setHistoryPage(1); setHistorySize(next); }
        }}>{stockAdjustmentPageSizes.map(value => <option key={value}>{value}</option>)}</select>
        <button type="button" disabled={historyPage <= 1} onClick={() => { if (historyPage > 1) setHistoryPage(historyPage - 1); }}>Anterior página</button>
        <span aria-current="page">Página {historyPage}</span>
        <button type="button" disabled={historyPage >= stockAdjustmentMaxPage || historyPage * historySize >= historyTotal}
          onClick={() => { if (historyPage < stockAdjustmentMaxPage) setHistoryPage(historyPage + 1); }}>Siguiente página</button>
      </div></footer>
    </section>
    {open && <div className="adjustment-drawer-backdrop">
      <aside className="adjustment-drawer" role="dialog" aria-modal="true" aria-labelledby="adjustment-drawer-title"
        ref={drawerDialog} aria-busy={applyBusy}
        onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); closeDrawer(); return; }
          trapFocus(event, drawerDialog.current);
        }}>
        <header className="adjustment-drawer-head">
          <div><h2 id="adjustment-drawer-title">Nuevo ajuste</h2>
            <p className="stock-hint">Almacén · un documento puntual por conteo</p></div>
          <button type="button" aria-label="Cerrar el ajuste" disabled={applyBusy} onClick={closeDrawer}>×</button>
        </header>
        <div className="adjustment-blind" role="note">
          <strong>Conteo ciego.</strong>
          <p>No se muestra el stock esperado. Cargá lo que contaste; la diferencia se conoce al aplicar.</p>
        </div>
        <label className="stock-search">Buscar variante
          <input ref={searchField} type="search" value={search} placeholder="NS40ZL, TOYO, 45 Ah"
            onChange={event => setSearch(event.target.value)} />
        </label>
        {catalog.phase === 'loading' && <p className="stock-message">Consultando el catálogo del Almacén…</p>}
        {catalog.phase === 'error' && <p role="alert" className="stock-message">{catalog.problem}
          <button type="button" onClick={() => setCatalogRevision(value => value + 1)}>Reintentar catálogo</button></p>}
        {catalog.phase === 'ready' && catalog.items.length === 0 &&
          <p className="stock-message">Sin variantes para esa búsqueda.</p>}
        {catalog.phase === 'ready' && catalog.items.length > 0 && <div className="stock-table-wrap">
          <table className="stock-table adjustment-capture">
            <caption className="sr-only">Variantes del catálogo del Almacén para contar</caption>
            <thead><tr><th scope="col">Producto</th><th scope="col">Capacidad</th><th scope="col">Polaridad</th><th scope="col">Contado</th></tr></thead>
            <tbody>{catalog.items.map(item => {
              const line = lines.find(entry => entry.variant_id === item.variant_id);
              return <tr key={item.variant_id} data-variant-id={item.variant_id}>
                <td data-label="Producto"><strong>{productLabel(item)}</strong></td>
                <td data-label="Capacidad">{item.capacity_ah} Ah</td>
                <td data-label="Polaridad"><span className="polarity">{item.polarity}</span></td>
                <td data-label="Contado"><input className="stock-quantity" type="number" inputMode="numeric" min={0}
                  max={stockAdjustmentMaxCounted} step={1} placeholder="—"
                  aria-label={`Contado de ${productLabel(item)}`} value={line ? line.counted : ''}
                  onChange={event => setCounted(item, event.target.value)} /></td>
              </tr>;
            })}</tbody>
          </table>
        </div>}
        <label className="adjustment-reason" htmlFor="adjustment-reason">Motivo del ajuste
          <select id="adjustment-reason" value={motive} onChange={event => { forgetAttempt(); setMotive(event.target.value); }}>
            <option value="">Elegí un motivo</option>
            {stockAdjustmentMotives.map(option => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>
        <div className="stock-totalbar">
          <dl className="stock-totals"><div><dt>Variantes contadas</dt><dd>{lines.length}</dd></div></dl>
          <div className="adjustment-drawer-actions">
            <button type="button" disabled={applyBusy} onClick={closeDrawer}>Cancelar</button>
            <button type="button" className="primary" disabled={applyBusy} onClick={() => void apply()}>Aplicar ajuste</button>
          </div>
        </div>
        <p role="status" className="stock-status">{drawerStatus}</p>
        {drawerProblem && <p role="alert" className="stock-status">{drawerProblem}</p>}
      </aside>
    </div>}
    {reversal && <div className="adjustment-drawer-backdrop">
      <section className="transfer-decision-modal adjustment-reversal-modal" role="dialog" aria-modal="true"
        aria-labelledby="adjustment-reversal-title" aria-describedby="adjustment-reversal-notice"
        aria-busy={reversalBusy} tabIndex={-1} ref={reversalDialog}
        onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); closeReversal(); return; }
          trapFocus(event, reversalDialog.current);
        }}>
        <header><div><h2 id="adjustment-reversal-title">Registrar contra-asiento</h2>
          <p>Documento #{reversal.row.id} · <TransferDate value={reversal.row.created_at} /></p></div>
          <button type="button" aria-label="Cerrar contra-asiento" disabled={reversalBusy} onClick={closeReversal}>×</button></header>
        <div className="adjustment-reversal-body">
          <dl className="adjustment-summary">
            <div><dt>Motivo del original</dt><dd>{reversal.row.reason}</dd></div>
            <div><dt>Líneas</dt><dd>{reversal.row.lines}</dd></div>
            <div><dt>Diferencia del original</dt><dd><span className={deltaClass(reversal.row.total_difference)}>{signed(reversal.row.total_difference)}</span></dd></div>
            <div><dt>Diferencia del contra-asiento</dt><dd><span className={deltaClass(-reversal.row.total_difference)}>{signed(-reversal.row.total_difference)}</span></dd></div>
          </dl>
          <p id="adjustment-reversal-notice" className="stock-hint">Se registra un documento nuevo con las líneas espejadas y este motivo.
            El original nunca cambia: ambos documentos quedan visibles en el historial.</p>
          <label className="adjustment-reason" htmlFor="adjustment-reversal-reason">Motivo del contra-asiento
            <select id="adjustment-reversal-reason" ref={reversalMotiveField} required value={reversalMotive}
              onChange={event => setReversalMotive(event.target.value)}>
              <option value="">Elegí un motivo</option>
              {stockAdjustmentMotives.map(option => <option key={option} value={option}>{option}</option>)}
            </select>
          </label>
          <p className="stock-hint">Obligatorio: elegí uno de los motivos de la lista.</p>
          {reversalBusy && <p role="status" className="stock-status">Registrando contra-asiento…</p>}
          {reversalProblem && <p role="alert" className="stock-status">{reversalProblem}</p>}
        </div>
        <footer><button type="button" disabled={reversalBusy} onClick={closeReversal}>Cancelar</button>
          <button type="button" className="primary" disabled={reversalBusy} onClick={() => void confirmReversal()}>Confirmar contra-asiento</button></footer>
      </section>
    </div>}
  </section>;
}
