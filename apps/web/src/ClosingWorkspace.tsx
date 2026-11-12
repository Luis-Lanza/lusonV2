import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { validSearch, type Location } from './model';
import {
  canonicalCountPayload, canonicalDrawerPayload, closingBlockReason, closingBlockers,
  closingDifferenceName, closingIsEditable, closingIsLive, closingLineDifference, closingLineLabel,
  closingCountBatches, closingMoneyText, closingObservationMessage, closingPendingTag, closingPeriod,
  closingPeriodLabel,
  closingProgress, closingQuantityMessage, closingQuantityText, closingRateText, closingRail,
  closingSearchMessage, closingSignedText, closingStatusLabels, drawerDraftFrom, drawerView,
  emptyDrawerDraft, filterCountLines,
  type Closing, type ClosingCountLine, type ClosingRail, type DrawerDraft,
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

/** The lines the admin changed, so a save sends only what was counted and never the whole sheet. */
function changedLines(closing: Closing, draft: Record<number, string>) {
  return closing.count_lines
    .filter(line => (draft[line.variant_id] ?? '') !== (line.counted_quantity === null ? '' : String(line.counted_quantity)))
    .map(line => ({ variant_id: line.variant_id, counted: draft[line.variant_id] ?? '' }));
}

function sameDrawer(left: DrawerDraft, right: DrawerDraft): boolean {
  return left.counted === right.counted && left.fund === right.fund
    && left.observation === right.observation;
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
  const [closing, setClosing] = useState<Closing | null>(null);
  const [counted, setCounted] = useState<Record<number, string>>({});
  const [draft, setDraft] = useState<DrawerDraft>(emptyDrawerDraft);
  const [search, setSearch] = useState('');
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
      setPhase('idle'); setClosing(null); setHistoryTotal(0); setResumed(null);
      setCounted({}); setDraft(emptyDrawerDraft); setProblem(''); setStatus('');
      return;
    }
    const controller = new AbortController();
    const alive = () => mounted.current && !controller.signal.aborted && !lifetime.current.signal.aborted;
    setPhase('loading'); setProblem(''); setStatus(''); setClosing(null); setResumed(null);
    void (async () => {
      try {
        const page = await api.history(branch, 1, 25, controller.signal);
        if (!alive()) return;
        setHistoryTotal(page.total_closings);
        const live = page.closings.find(row => closingIsLive(row.status));
        if (!live) { setPhase('ready'); return; }
        const document = await api.detail(live.id, controller.signal);
        if (!alive()) return;
        setClosing(document);
        setCounted(countDraftFrom(document));
        setDraft(drawerDraftFrom(document));
        setResumed(document.id);
        setPhase('ready');
        setStatus(`La sucursal ya tenía la rendición #${document.id} abierta: la retomamos con su conteo y su caja.`);
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
    setPhase('ready');
  }

  async function openSettlement() {
    if (branch === 0 || busy || pending.current) return;
    pending.current = true; setBusy(true); setProblem(''); setStatus('Abriendo la rendición…');
    try {
      const document = await api.open(branch, csrf, lifetime.current.signal);
      if (!mounted.current || lifetime.current.signal.aborted) return;
      apply(document);
      setResumed(null);
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

  async function save() {
    const current = closing;
    if (!current || busy || pending.current) return;
    if (!closingIsEditable(current.status)) {
      setStatus(''); setProblem('La rendición no admite cambios en este estado.');
      return;
    }
    const changed = changedLines(current, counted);
    let lines;
    try { lines = changed.length === 0 ? [] : canonicalCountPayload(changed); }
    catch (failure) {
      setStatus('');
      setProblem(failure instanceof Error && failure.message ? failure.message : closingQuantityMessage);
      return;
    }
    let drawer;
    try { drawer = canonicalDrawerPayload(draft, current.contributed_cash_cents); }
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
  const changed = closing === null ? [] : changedLines(closing, counted);
  const unsaved = closing !== null
    && (changed.length > 0 || !sameDrawer(draft, drawerDraftFrom(closing)));
  const blockers = closing === null || view === null ? [] : closingBlockers(closing, view, unsaved);
  const blocked = blockers.length > 0;
  const searchValid = validSearch(search);
  const rows = closing === null ? []
    : searchValid ? filterCountLines(closing.count_lines, search) : closing.count_lines;
  const progress = closing === null
    ? { total: 0, counted: 0, pending: 0 } : closingProgress(closing.count_lines);
  const reasonID = 'closing-block-reason';
  const period = closing === null ? null : closingPeriod(closing.period_start, closing.cut_at);
  // The rail answers to what is typed, over the facts the settlement holds: the difference and
  // what the warehouse takes move with the draft before anything is saved.
  const liveDifference = view === null ? null : view.difference_cents;
  const liveTaken = view === null ? null : view.taken_cents;

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
      {branch !== 0 && closing === null && phase === 'ready' && <>
        <p className="closing-note">La sucursal no tiene una rendición abierta.
          {historyTotal > 0 && ` ${historyTotal} ${historyTotal === 1 ? 'rendición anterior' : 'rendiciones anteriores'}.`}</p>
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
              <tbody onKeyDown={moveFocus}>{rows.map(line => {
                const typed = counted[line.variant_id];
                const difference = draftDifference(line, typed);
                const pendingRow = line.counted_quantity === null && (typed ?? '') === '';
                const differenceClass = difference === null || difference === 0 ? 'zero'
                  : difference < 0 ? 'neg' : 'pos';
                return <tr key={line.variant_id} data-variant-id={line.variant_id}
                  className={pendingRow ? 'pending' : undefined}>
                  <td>
                    {line.brand}{' '}
                    <small>{line.model} · {line.capacity_ah} Ah · {line.polarity}</small>
                    {pendingRow && <span className="closing-pending">{closingPendingTag}</span>}
                  </td>
                  <td className="num">{line.expected_quantity}</td>
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
            Las filas marcadas como pendientes todavía no permiten proponer.
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
              <dl className="closing-summary">
                <div><dt>Caja contada</dt>
                  <dd>{view.counted_cents === null ? 'Sin contar' : closingMoneyText(view.counted_cents)}</dd></div>
                {rail.contribution_cents !== 0n && <div><dt>Aporte del Almacén</dt>
                  <dd>{closingMoneyText(rail.contribution_cents)}</dd></div>}
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
