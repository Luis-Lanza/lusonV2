import { useEffect, useMemo, useRef, useState } from 'react';
import type { Item } from './model';
import { validSearch } from './model';
import { createStockEntryAPI, StockEntryAPIError } from './stockEntryAPI';
import {
  canonicalStockEntryInput, newStockEntryOperationKey, parseStockCatalog, stockCatalogPath, stockEntryErrorMessages,
  stockEntryFailureIsDefinite, stockEntryMaxNote, stockEntryMaxQuantity, validStockQuantity,
  type StockEntryErrorCode, type StockEntryInput,
} from './stockEntryModel';
import './stock-entry.css';

interface DocumentLine {
  readonly variant_id: number; readonly brand: string; readonly model: string;
  readonly capacity_ah: string; readonly polarity: 'L' | 'R'; readonly quantity: string;
}
interface CatalogState { readonly phase: 'loading' | 'ready' | 'error'; readonly items: readonly Item[]; readonly problem: string }

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
  const lifetime = useRef(new AbortController());
  const mounted = useRef(true);
  const pending = useRef(false);
  // One key per unchanged draft: an uncertain retry replays exactly, an edit becomes a new document.
  const operationKey = useRef<string | null>(null);
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

  const catalogCount = `${catalog.items.length} ${catalog.items.length === 1 ? 'variante' : 'variantes'}`;
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
  </section>;
}
