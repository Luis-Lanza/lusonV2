import { useEffect, useMemo, useRef, useState } from 'react';
import type { Item } from './model';
import { validSearch } from './model';
import TransferDate from './shared/TransferDate';
import { createStockEntryAPI, StockEntryAPIError, StockEntryDetailAPIError, StockEntryReversalAPIError } from './stockEntryAPI';
import {
  canonicalStockEntryInput, canonicalStockEntryReversalInput, canonicalStockEntryReversalReason,
  newStockEntryOperationKey, parseStockCatalog, stockCatalogPath, stockEntryDetailErrorMessages, stockEntryErrorMessages,
  stockEntryFailureIsDefinite, stockEntryHistoryDefaultPageSize, stockEntryHistoryMaxPage, stockEntryHistoryPageSizes,
  stockEntryHistoryUnavailable, stockEntryMaxNote, stockEntryMaxQuantity, stockEntryMaxReason,
  stockEntryReversalErrorMessages, stockEntryReversalFailureIsDefinite, stockEntryReversible, validStockQuantity,
  type StockEntryDetail, type StockEntryDetailErrorCode, type StockEntryErrorCode, type StockEntryHistoryPage,
  type StockEntryHistoryRow, type StockEntryInput, type StockEntryReversalErrorCode, type StockEntryReversalInput,
} from './stockEntryModel';
import './stock-entry.css';

interface DocumentLine {
  readonly variant_id: number; readonly brand: string; readonly model: string;
  readonly capacity_ah: string; readonly polarity: 'L' | 'R'; readonly quantity: string;
}
interface CatalogState { readonly phase: 'loading' | 'ready' | 'error'; readonly items: readonly Item[]; readonly problem: string }
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
const productLabel = (row: { brand: string; model: string }) => `${row.brand} · ${row.model}`;
const catalogUnavailable = 'No se pudo consultar el catálogo del Almacén. Revisá la conexión e intentá de nuevo.';

export default function StockEntry({ csrf, fetcher = globalThis.fetch }: StockEntryProps) {
  const api = useMemo(() => createStockEntryAPI(fetcher), [fetcher]);
  const [search, setSearch] = useState('');
  const [revision, setRevision] = useState(0);
  const [catalog, setCatalog] = useState<CatalogState>({ phase: 'loading', items: [], problem: catalogUnavailable });
  const [lines, setLines] = useState<readonly DocumentLine[]>([]);
  const [note, setNote] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
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
    if (!validSearch(search)) {
      setCatalog({ phase: 'error', items: [], problem: 'La búsqueda admite hasta 128 bytes UTF-8, sin caracteres inválidos.' });
      return;
    }
    const controller = new AbortController();
    const alive = () => mounted.current && !controller.signal.aborted && !lifetime.current.signal.aborted;
    setCatalog({ phase: 'loading', items: [], problem: catalogUnavailable });
    void (async () => {
      try {
        const reply = await fetcher(stockCatalogPath(search), { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
        if (!alive()) return;
        if (reply.status !== 200) throw new Error('catalog status');
        const items = parseStockCatalog(await reply.text());
        if (!alive()) return;
        setCatalog({ phase: 'ready', items, problem: '' });
      } catch {
        if (alive()) setCatalog({ phase: 'error', items: [], problem: catalogUnavailable });
      }
    })();
    return () => controller.abort();
  }, [search, revision, fetcher]);

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
  function add(row: Item) {
    forgetAttempt();
    const current = lines.find(line => line.variant_id === row.variant_id);
    if (current) {
      const previous = Number(current.quantity);
      const quantity = validStockQuantity(previous) ? Math.min(previous + 1, stockEntryMaxQuantity) : 1;
      setLines(lines.map(line => line.variant_id === row.variant_id ? { ...line, quantity: String(quantity) } : line));
      setStatus(`${productLabel(row)} ya estaba en el documento: ahora ${quantity} ${quantity === 1 ? 'unidad' : 'unidades'}.`);
      return;
    }
    setLines([...lines, { variant_id: row.variant_id, brand: row.brand, model: row.model,
      capacity_ah: row.capacity_ah, polarity: row.polarity, quantity: '1' }]);
    setStatus(`${productLabel(row)} agregado al documento.`);
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
    if (!lines.length) { setStatus('Agregá al menos una línea antes de confirmar.'); return; }
    if (!quantitiesValid) { setStatus('Cantidad inválida: ingresá un entero entre 1 y 1.000.000 en cada línea.'); return; }
    if (operationKey.current === null) {
      try { operationKey.current = newStockEntryOperationKey(); }
      catch { setStatus('No se pudo generar una clave segura para este ingreso. No se envió nada.'); return; }
    }
    const input: StockEntryInput = { operation_key: operationKey.current, note,
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

  const catalogCount = `${catalog.items.length} ${catalog.items.length === 1 ? 'variante' : 'variantes'}`;
  const historyRows = history.phase === 'ready' && history.page ? history.page.entries : [];
  // A detail is only ever rendered for the document that asked for it.
  const detailView = detail && detailLoad.id === detail.row.id ? detailLoad : null;
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
    <div className="stock-entry-grid">
      <section className="stock-entry-panel" aria-labelledby="stock-catalog-title" aria-busy={catalog.phase === 'loading'}>
        <div className="stock-panel-head">
          <h2 id="stock-catalog-title">Catálogo</h2>
          <span className="stock-tag">{catalog.phase === 'ready' ? catalogCount : 'Almacén'}</span>
        </div>
        <label className="stock-search">Buscar marca, modelo o capacidad
          <input type="search" value={search} placeholder="NS40ZL, TOYO, 45 Ah" onChange={event => setSearch(event.target.value)} />
        </label>
        {catalog.phase === 'ready' && catalog.items.length > 0 && <div className="stock-table-wrap">
          <table className="stock-table">
            <caption className="sr-only">Variantes del catálogo del Almacén</caption>
            <thead><tr><th scope="col">Producto</th><th scope="col">Capacidad</th><th scope="col">Polaridad</th><th scope="col">Stock actual</th><th scope="col">Acción</th></tr></thead>
            <tbody>{catalog.items.map(row => <tr key={row.variant_id} data-variant-id={row.variant_id}>
              <td data-label="Producto"><strong>{productLabel(row)}</strong></td>
              <td data-label="Capacidad">{row.capacity_ah} Ah</td>
              <td data-label="Polaridad"><span className="polarity">{row.polarity}</span></td>
              <td data-label="Stock actual">{row.existing.toString()}</td>
              <td data-label="Acción"><button type="button" className="stock-add" aria-label={`Agregar ${productLabel(row)}`} onClick={() => add(row)}>Agregar</button></td>
            </tr>)}</tbody>
          </table>
        </div>}
        {catalog.phase === 'loading' && <p className="stock-message" role="status">Consultando catálogo del almacén…</p>}
        {catalog.phase === 'error' && <p className="stock-message" role="alert">{catalog.problem}
          <button type="button" disabled={busy} onClick={() => setRevision(value => value + 1)}>Reintentar catálogo</button></p>}
        {catalog.phase === 'ready' && catalog.items.length === 0 && <p className="stock-message">Sin coincidencias en el catálogo.</p>}
        <p className="stock-hint">El stock que ves acá es el actual del Almacén. Suma unidades del documento y se vuelve a consultar al confirmar.</p>
      </section>
      <section className="stock-entry-panel" aria-labelledby="stock-document-title">
        <div className="stock-panel-head">
          <div><h2 id="stock-document-title">Documento de ingreso</h2><p className="stock-hint">Se numera al confirmar.</p></div>
          <span className="stock-tag wine">Borrador local</span>
        </div>
        <label className="stock-note">Nota del documento (opcional)
          <input value={note} maxLength={stockEntryMaxNote} placeholder="Remito 0002-00045871 · Proveedor del norte"
            onChange={event => { forgetAttempt(); setNote(event.target.value); }} />
        </label>
        {lines.length > 0 && <div className="stock-table-wrap">
          <table className="stock-table stock-lines">
            <caption className="sr-only">Líneas que se aplican al stock</caption>
            <thead><tr><th scope="col">Producto</th><th scope="col">Cantidad</th><th scope="col">Quitar</th></tr></thead>
            <tbody>{lines.map(line => <tr key={line.variant_id}>
              <td data-label="Producto"><strong>{productLabel(line)}</strong><small>{line.capacity_ah} Ah · Polaridad {line.polarity}</small></td>
              <td data-label="Cantidad"><input className="stock-quantity" type="number" inputMode="numeric" min={1} max={stockEntryMaxQuantity} step={1}
                aria-label={`Cantidad de ${productLabel(line)}`} value={line.quantity}
                onChange={event => setQuantity(line.variant_id, event.target.value)} /></td>
              <td data-label="Quitar"><button type="button" className="stock-remove" aria-label={`Quitar ${productLabel(line)}`} onClick={() => removeLine(line.variant_id)}>Quitar</button></td>
            </tr>)}</tbody>
          </table>
        </div>}
        {lines.length === 0 && <p className="stock-message">Todavía no agregaste líneas.</p>}
        <div className="stock-totalbar">
          <dl className="stock-totals">
            <div><dt>Variantes</dt><dd>{lines.length}</dd></div>
            <div><dt>Unidades</dt><dd>{totalUnits}</dd></div>
          </dl>
          <button type="button" className="primary" disabled={busy} onClick={() => void confirm()}>Confirmar ingreso</button>
        </div>
        <p role="status" className="stock-status">{status}</p>
        <p className="stock-notices">Todo o nada: si una línea es inválida no se aplica ninguna. Una vez confirmado, el documento no se edita ni se borra: se corrige con un contra-asiento que deja ambos registros.</p>
      </section>
    </div>
    <section className="stock-entry-panel stock-history" aria-labelledby="stock-history-title" aria-busy={history.phase === 'loading'}>
      <div className="stock-panel-head">
        <div><h2 id="stock-history-title">Historial de ingresos</h2>
          <p className="stock-hint">Los documentos confirmados no se editan ni se borran: se corrigen con un contra-asiento.</p></div>
        <span className="stock-tag">{historyCount}</span>
      </div>
      {historyRows.length > 0 && <div className="stock-table-wrap">
        <table className="stock-table stock-history-table">
          <caption className="sr-only">Historial de ingresos del Almacén</caption>
          <thead><tr><th scope="col">Documento</th><th scope="col">Fecha</th><th scope="col">Nota</th><th scope="col">Líneas</th><th scope="col">Unidades</th><th scope="col">Estado</th><th scope="col">Acción</th></tr></thead>
          <tbody>{historyRows.map(row => <tr key={row.id} data-entry-id={row.id}>
            <td data-label="Documento"><strong>#{row.id}</strong></td>
            <td data-label="Fecha"><TransferDate value={row.created_at} /></td>
            <td data-label="Nota">{row.note || '—'}</td>
            <td data-label="Líneas">{row.lines}</td>
            <td data-label="Unidades">{row.total_units}</td>
            <td data-label="Estado">{row.reversed_by === null
              ? <span className="stock-tag">Aplicado</span>
              : <span className="stock-tag reversed">Anulado por contra-asiento</span>}</td>
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
            <table className="stock-table stock-detail-table">
              <caption className="sr-only">Unidades que entraron con este documento</caption>
              <thead><tr><th scope="col">Producto</th><th scope="col">Capacidad</th><th scope="col">Polaridad</th><th scope="col">Cantidad</th></tr></thead>
              <tbody>{detailView.document.lines.map(line => <tr key={line.variant_id} data-variant-id={line.variant_id}>
                <td data-label="Producto"><strong>{productLabel(line)}</strong></td>
                <td data-label="Capacidad">{line.capacity_ah} Ah</td>
                <td data-label="Polaridad"><span className="polarity">{line.polarity}</span></td>
                <td data-label="Cantidad">{line.quantity}</td>
              </tr>)}</tbody>
            </table>
          </div>
          <p className="stock-detail-total">{`Unidades del documento: ${detailView.document.total_units}`}</p>
          <p className="stock-hint">Un documento confirmado no se edita ni se borra: estas son las líneas que se aplicaron al stock del Almacén.</p>
        </>}
      </div>
      <footer><button type="button" onClick={closeDetail}>Volver</button></footer>
    </section></div>}
  </section>;
}
