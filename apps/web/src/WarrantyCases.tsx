import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { Location } from './model';
import TransferDate from './shared/TransferDate';
import { warrantyLabel } from './pointOfSaleModel';
import { createSalesAPI, type SaleDetail } from './salesAPI';
import { usedStockUnavailable, type UsedStockRow } from './usedStockModel';
import {
  WarrantyCaseAPIError, createWarrantyCasesAPI, warrantyCaseErrorMessages, warrantyCaseUnavailable,
  warrantyCatalogueUnavailable, warrantySaleUnavailable, warrantyTrayUnavailable,
} from './warrantyCasesAPI';
import {
  canonicalAdvanceBody, canonicalClaimBody, canonicalDefectBody, canonicalDeliveryBody,
  canonicalLoanBody, canonicalLoanFateBody, canonicalNoticeBody, warrantyCustodyUnits,
  warrantyDeliveryFates, warrantyDestinationLabels, warrantyDispatchAvailable, warrantyEventKindLabels,
  warrantyCloseAvailable, warrantyDaysSince, warrantyDeliveryAvailable, warrantyLendAvailable,
  warrantyLoanFateLabels, warrantyLoanRegistered, warrantyNoticeAvailable,
  warrantyNotice, warrantyNoticeDays, warrantyOriginLabels, warrantyPhaseLabels, warrantyPhaseShortLabel,
  warrantyPhaseShortLabels, warrantyPhaseTone, warrantyPhases, warrantyReleased, warrantyReceiptAvailable,
  warrantyReceiptFileName, warrantyReceiptPath, warrantyUnitBoundForStock, warrantyVerdictLabels,
  type WarrantyCase, type WarrantyCaseRow, type WarrantyDeliveryFate, type WarrantyLoan,
  type WarrantyLoanFateStated,
  type WarrantyOriginFilter, type WarrantyPhaseFilter,
} from './warrantyCasesModel';
import { subscribeWarrantyInvalidation } from './useInventory';
import './warranty-cases.css';

/**
 * The branch's guarantee tray: its own cases, newest first, filtered by the phase of the journey and by
 * the door the case came through. The list is the tray the contract publishes — the header of each case
 * and nothing else — and the client, the battery, the sale and the notice age are read from the case
 * itself when it is selected, because that is the one read that carries the loans and the history.
 *
 * The branch owns the case and the relationship with the client (S19): it registers the claim or the
 * finding on its shelf, lends the used battery, tells the client and delivers the exchange. The
 * warehouse's own acts — the tramos it moves, the verdict, the release — never appear here.
 */

export interface WarrantyCasesProps {
  /** The session's CSRF token, captured by the shell that mounted this screen. */
  csrf: string;
  /** The name the screen says out loud: the branch of the session. */
  branch: string;
  /** Every provisioned location: the loan states which one its used battery came from (S6). */
  locations: readonly Location[];
  fetcher?: typeof globalThis.fetch;
  /** The clock the notice age is measured against; the tests freeze it. */
  now?: () => Date;
}

interface TrayState { readonly phase: 'loading' | 'ready' | 'error'; readonly rows: readonly WarrantyCaseRow[]; readonly problem: string }
interface DetailState { readonly id: number; readonly phase: 'loading' | 'ready' | 'error'; readonly record: WarrantyCase | null; readonly problem: string }
interface SaleState { readonly id: number; readonly phase: 'loading' | 'ready' | 'error'; readonly value: SaleDetail | null; readonly problem: string }
interface CatalogState { readonly phase: 'loading' | 'ready' | 'error'; readonly items: readonly SellableItem[]; readonly problem: string }
interface SellableItem { readonly variant_id: number; readonly name: string; readonly detail: string; readonly available: bigint }

function failureMessage(failure: unknown, fallback: string): string {
  return failure instanceof WarrantyCaseAPIError ? warrantyCaseErrorMessages[failure.code] : fallback;
}
/** Every control a reader can tab to inside one dialog, in document order. */
function dialogFocusables(container: HTMLElement | null): HTMLElement[] {
  return Array.from(container?.querySelectorAll<HTMLElement>(
    'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]') ?? [])
    .filter(node => node.isConnected);
}

/**
 * Keeps the keyboard inside an open dialog and gives it back to the control that opened it: Escape
 * closes, Tab cycles, and the focus the operator had never lands on the page behind the backdrop.
 */
function useDialogFocus(onClose: () => void) {
  const container = useRef<HTMLElement>(null);
  const trigger = useRef<Element | null>(null);
  const latest = useRef(onClose);
  latest.current = onClose;
  useEffect(() => {
    trigger.current = document.activeElement;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') { event.stopPropagation(); latest.current(); return; }
      if (event.key !== 'Tab') return;
      const nodes = dialogFocusables(container.current);
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;
      const inside = !!container.current && active instanceof Node && container.current.contains(active);
      if (event.shiftKey && (active === first || !inside)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (active === last || !inside)) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      const previous = trigger.current;
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return container;
}

const locationName = (locations: readonly Location[], id: number): string =>
  locations.find(entry => entry.id === id)?.name ?? `Ubicación ${id}`;
const units = (quantity: number): string => `${quantity} ${quantity === 1 ? 'unidad' : 'unidades'}`;
const days = (value: number): string => value === 1 ? '1 día' : `${value} días`;
/**
 * The four facts a lent battery can have become, in the words the counter says them and with the fate
 * each one records (S33). The fate is never chosen from a list: it is the fact that happened.
 */
const warrantyLoanFateFacts: readonly { readonly fate: WarrantyLoanFateStated; readonly label: string }[] = [
  { fate: 'failed', label: 'La usada falló' },
  { fate: 'returned', label: 'El cliente la devolvió' },
  { fate: 'kept_by_customer', label: 'El cliente se la quedó' },
  { fate: 'lost', label: 'Se perdió' },
];

/** The battery of the claim: the line and the unit of the sale the client brought back. */
function claimedUnit(sale: SaleDetail | null, serial: string | null) {
  if (!sale || serial === null) return null;
  for (const line of sale.lines) {
    const unit = line.units.find(entry => entry.serial_number === serial);
    if (unit) return { line, unit };
  }
  return null;
}
const batteryName = (sale: SaleDetail | null, serial: string | null, variant: number): string => {
  const claimed = claimedUnit(sale, serial);
  if (claimed?.line.identity) return `${claimed.line.identity.name} · ${claimed.line.identity.detail}`;
  if (claimed?.line.brand && claimed.line.model) {
    return `${claimed.line.brand} ${claimed.line.model} · ${claimed.line.capacity_ah} Ah · ${claimed.line.polarity}`;
  }
  return `Variante ${variant}`;
};

export default function WarrantyCases({ csrf, branch, locations, fetcher = globalThis.fetch,
  now = () => new Date() }: WarrantyCasesProps) {
  const api = useMemo(() => createWarrantyCasesAPI(fetcher), [fetcher]);
  const sales = useMemo(() => createSalesAPI(fetcher), [fetcher]);
  const [phaseFilter, setPhaseFilter] = useState<WarrantyPhaseFilter>('all');
  const [originFilter, setOriginFilter] = useState<WarrantyOriginFilter>('all');
  const [trayRevision, setTrayRevision] = useState(0);
  const [tray, setTray] = useState<TrayState>({ phase: 'loading', rows: [], problem: warrantyTrayUnavailable });
  const [selected, setSelected] = useState<number | null>(null);
  const [detailRevision, setDetailRevision] = useState(0);
  const [detail, setDetail] = useState<DetailState | null>(null);
  const [sale, setSale] = useState<SaleState | null>(null);
  const [status, setStatus] = useState('');
  const [exchange, setExchange] = useState(false);
  const [defect, setDefect] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let alive = true;
    setTray(current => ({ phase: 'loading', rows: current.rows, problem: warrantyTrayUnavailable }));
    void (async () => {
      try {
        const rows = await api.tray({ phase: phaseFilter, origin: originFilter }, controller.signal);
        if (!alive) return;
        setTray({ phase: 'ready', rows, problem: '' });
      } catch (failure) {
        if (!alive) return;
        setTray({ phase: 'error', rows: [], problem: failureMessage(failure, warrantyTrayUnavailable) });
      }
    })();
    return () => { alive = false; controller.abort(); };
  }, [api, phaseFilter, originFilter, trayRevision]);

  // One case read per selected case: the loans and the append-only history live on the case, not on the
  // tray row, so the detail is the only place they are published.
  useEffect(() => {
    if (selected === null) { setDetail(null); return; }
    const id = selected;
    const controller = new AbortController();
    let alive = true;
    setDetail({ id, phase: 'loading', record: null, problem: '' });
    void (async () => {
      try {
        const record = await api.detail(id, controller.signal);
        if (!alive || record.id !== id) return;
        setDetail({ id, phase: 'ready', record, problem: '' });
      } catch (failure) {
        if (!alive) return;
        setDetail({ id, phase: 'error', record: null, problem: failureMessage(failure, warrantyCaseUnavailable) });
      }
    })();
    return () => { alive = false; controller.abort(); };
  }, [api, selected, detailRevision]);

  // The other side's write reaches this screen without a reload: the participant invalidation of the
  // case re-reads the tray and the open case, and it never carries a record (S19, 070).
  useEffect(() => subscribeWarrantyInvalidation(() => {
    setTrayRevision(value => value + 1);
    setDetailRevision(value => value + 1);
  }), []);

  // The client of a claim is the sale's own: the case publishes the sale it was judged against and the
  // branch reads its own sale. A sale of another branch leaves the case readable and says so.
  const saleID = detail?.phase === 'ready' && detail.record !== null ? detail.record.sale_id : null;
  useEffect(() => {
    if (saleID === null) { setSale(null); return; }
    const id = saleID;
    const controller = new AbortController();
    let alive = true;
    setSale({ id, phase: 'loading', value: null, problem: '' });
    void (async () => {
      try {
        const value = await sales.detail(id, controller.signal);
        if (!alive || value.id !== id) return;
        setSale({ id, phase: 'ready', value, problem: '' });
      } catch {
        if (alive) setSale({ id, phase: 'error', value: null, problem: warrantySaleUnavailable });
      }
    })();
    return () => { alive = false; controller.abort(); };
  }, [sales, saleID]);

  const current = detail?.phase === 'ready' ? detail.record : null;
  const today = now();
  const rows = tray.rows;

  function accept(record: WarrantyCase, message: string) {
    setSelected(record.id);
    setDetail({ id: record.id, phase: 'ready', record, problem: '' });
    setStatus(message);
    setTrayRevision(value => value + 1);
  }
  function select(id: number) {
    setStatus('');
    if (id === selected) { setDetailRevision(value => value + 1); return; }
    setSelected(id);
  }

  return <section className="warranty-cases" aria-labelledby="warranty-title">
    <header className="warranty-heading">
      <small>Sucursal / Garantías</small>
      <h1 id="warranty-title">Casos de garantía</h1>
      <p>{`Todo lo que no es stock vendible en ${branch}: reclamos con la garantía de una venta, hallazgos en la propia góndola y unidades en custodia. La sucursal le debe la respuesta al cliente; el Almacén mueve la batería.`}</p>
      <div className="warranty-heading-actions">
        <button type="button" className="primary" onClick={() => { setStatus(''); setExchange(true); }}>Registrar canje</button>
        <button type="button" onClick={() => { setStatus(''); setDefect(true); }}>Hallazgo en góndola</button>
      </div>
    </header>

    <div className="warranty-filters">
      <div className="warranty-phase-tabs" role="group" aria-label="Filtrar casos por etapa del viaje">
        <button type="button" aria-pressed={phaseFilter === 'all'} onClick={() => setPhaseFilter('all')}>Todas las etapas</button>
        {warrantyPhases.map(value => <button type="button" key={value} aria-pressed={phaseFilter === value}
          onClick={() => setPhaseFilter(value)}>{warrantyPhaseShortLabels[value]}</button>)}
      </div>
      <div className="warranty-origin-field">
        <label htmlFor="warranty-origin">Origen</label>
        <select id="warranty-origin" value={originFilter}
          onChange={event => {
            const next = event.target.value;
            if (next === 'all' || next === 'warranty_claim' || next === 'stock_defect') setOriginFilter(next);
          }}>
          <option value="all">Los dos orígenes</option>
          <option value="warranty_claim">{warrantyOriginLabels.warranty_claim}</option>
          <option value="stock_defect">{warrantyOriginLabels.stock_defect}</option>
        </select>
      </div>
    </div>

    {status !== '' && <p className="warranty-status" role="status">{status}</p>}

    <div className={'warranty-layout' + (selected !== null ? ' warranty-detail-open' : '')}>
      <section className="warranty-list" aria-label="Bandeja de casos" aria-busy={tray.phase === 'loading'}>
        {tray.phase === 'loading' && <p className="warranty-message" role="status">Consultando los casos de la sucursal…</p>}
        {tray.phase === 'error' && <p className="warranty-message" role="alert">{tray.problem}
          <button type="button" onClick={() => setTrayRevision(value => value + 1)}>Reintentar bandeja</button></p>}
        {tray.phase === 'ready' && rows.length === 0 && <p className="warranty-message" role="status">
          No hay casos de garantía para esta consulta: ni reclamos ni hallazgos en góndola con esa etapa y ese origen.
        </p>}
        {rows.length > 0 && <div className="warranty-table-wrap">
          <table className="warranty-table">
            <caption>{`Casos de ${branch}, del más nuevo al más viejo. Los días cuentan desde el alta del caso: la antigüedad del aviso al cliente se lee en el detalle, que es donde el caso publica su historial.`}</caption>
            <thead><tr>
              <th scope="col">Caso</th>
              <th scope="col">Batería</th>
              <th scope="col">Origen</th>
              <th scope="col">Etapa</th>
              <th scope="col" className="num">Días</th>
            </tr></thead>
            <tbody>{rows.map(row => {
              const active = row.id === selected;
              const tone = warrantyPhaseTone(row.phase);
              return <tr key={row.id} className={active ? 'warranty-row active' : 'warranty-row'} aria-current={active ? 'true' : undefined}>
                <td data-label="Caso">
                  <button type="button" className="warranty-open" onClick={() => select(row.id)}
                    aria-label={`Ver el caso ${row.case_number}`} aria-pressed={active}>{row.case_number}</button>
                  <small className="warranty-sub">{row.reason ?? row.declared_failure}</small>
                </td>
                <td data-label="Batería">
                  <strong>{row.serial_number ?? `Variante ${row.variant_id}`}</strong>
                  <small className="warranty-sub">{row.serial_number === null ? `${units(row.quantity ?? 0)} de la góndola` : 'Serial de la unidad reclamada'}</small>
                </td>
                <td data-label="Origen"><span className={`warranty-pill ${row.origin === 'stock_defect' ? 'warn' : 'quiet'}`}>{warrantyOriginLabels[row.origin]}</span></td>
                <td data-label="Etapa"><span className={`warranty-pill ${tone}`}>{warrantyPhaseShortLabels[row.phase]}</span></td>
                <td data-label="Días" className="num warranty-days">{warrantyDaysSince(row.created_at, today)}</td>
              </tr>;
            })}</tbody>
          </table>
        </div>}
      </section>

      {selected !== null && <aside className="warranty-detail" aria-label="Detalle del caso">
        {detail !== null && detail.id === selected && detail.phase === 'loading' && <p className="warranty-message" role="status">Consultando el caso…</p>}
        {detail !== null && detail.id === selected && detail.phase === 'error' && <p className="warranty-message" role="alert">{detail.problem}
          <button type="button" onClick={() => setDetailRevision(value => value + 1)}>Reintentar caso</button>
          <button type="button" onClick={() => setSelected(null)}>Cerrar detalle</button></p>}
        {current !== null && current.id === selected && <CaseDetail key={current.id} record={current}
          sale={sale?.phase === 'ready' ? sale.value : null} saleProblem={sale?.phase === 'error' ? sale.problem : ''}
          api={api} csrf={csrf} locations={locations} today={today} onChanged={accept}
          onClose={() => setSelected(null)} />}
      </aside>}
    </div>

    {exchange && <ExchangeDialog api={api} sales={sales} csrf={csrf} branch={branch} locations={locations}
      onClose={() => setExchange(false)} onCase={record => { accept(record, `Caso ${record.case_number} abierto en la sucursal.`); }} />}
    {defect && <DefectDialog api={api} sales={sales} csrf={csrf} branch={branch}
      onClose={() => setDefect(false)} onCase={record => { accept(record, `Hallazgo ${record.case_number} registrado: ${units(record.quantity ?? 0)} dadas de baja de la góndola.`); }} />}
  </section>;
}

// ---------------------------------------------------------------------------------
// The selected case: its facts, its history, the custody block and the branch's acts
// ---------------------------------------------------------------------------------

interface CaseDetailProps {
  record: WarrantyCase;
  sale: SaleDetail | null;
  saleProblem: string;
  api: ReturnType<typeof createWarrantyCasesAPI>;
  csrf: string;
  locations: readonly Location[];
  today: Date;
  onChanged: (record: WarrantyCase, message: string) => void;
  onClose: () => void;
}

function CaseDetail({ record, sale, saleProblem, api, csrf, locations, today, onChanged, onClose }: CaseDetailProps) {
  const [notice, setNotice] = useState({ note: '', busy: false, problem: '' });
  const [delivery, setDelivery] = useState<{ fate: WarrantyDeliveryFate | ''; note: string; busy: boolean; problem: string }>({
    fate: '', note: '', busy: false, problem: '',
  });
  const [dispatch, setDispatch] = useState({ note: '', busy: false, problem: '' });
  const [closing, setClosing] = useState({ note: '', busy: false, problem: '' });
  const [lending, setLending] = useState(false);
  const claimed = claimedUnit(sale, record.serial_number);
  const custody = warrantyCustodyUnits(record);
  const noticeEntry = warrantyNotice(record);
  const noticeAge = warrantyNoticeDays(record, today);
  const lastLoan = record.loans.at(-1) ?? null;
  const openLoans = record.loans.filter(loan => loan.fate === 'open');
  const openLoan = openLoans.at(-1) ?? null;
  const tone = warrantyPhaseTone(record.phase);

  async function submitNotice(event: FormEvent) {
    event.preventDefault();
    if (notice.busy) return;
    setNotice(current => ({ ...current, busy: true, problem: '' }));
    try {
      const body = canonicalNoticeBody(notice.note);
      const updated = await api.notice(record.id, () => body, csrf);
      setNotice({ note: '', busy: false, problem: '' });
      onChanged(updated, `Aviso registrado en ${updated.case_number}: el cliente ya sabe que su batería volvió.`);
    } catch (failure) {
      setNotice(current => ({ ...current, busy: false, problem: failureMessage(failure, 'No se pudo registrar el aviso.') }));
    }
  }
  async function submitDelivery(event: FormEvent) {
    event.preventDefault();
    // The fate of the lent battery moves the used pool's stock, so an unanswered one posts nothing: the
    // screen never decides for the counter, and a decided fate is final (S31).
    if (delivery.busy || delivery.fate === '') return;
    const fate = delivery.fate;
    setDelivery(current => ({ ...current, busy: true, problem: '' }));
    try {
      const body = canonicalDeliveryBody(fate, delivery.note);
      const updated = await api.deliver(record.id, body, csrf);
      setDelivery({ fate: '', note: '', busy: false, problem: '' });
      onChanged(updated, `Canje entregado en ${updated.case_number}: el caso queda cerrado y la usada, ${warrantyLoanFateLabels[fate].toLowerCase()}.`);
    } catch (failure) {
      setDelivery(current => ({ ...current, busy: false, problem: failureMessage(failure, 'No se pudo entregar el canje.') }));
    }
  }
  async function submitDispatch(event: FormEvent) {
    event.preventDefault();
    if (dispatch.busy) return;
    setDispatch(current => ({ ...current, busy: true, problem: '' }));
    try {
      const body = canonicalAdvanceBody('in_transit', dispatch.note);
      const updated = await api.advance(record.id, body, csrf);
      setDispatch({ note: '', busy: false, problem: '' });
      onChanged(updated, `${updated.case_number} sale de la sucursal hacia el Almacén.`);
    } catch (failure) {
      setDispatch(current => ({ ...current, busy: false, problem: failureMessage(failure, 'No se pudo registrar la salida.') }));
    }
  }
  async function submitClose(event: FormEvent) {
    event.preventDefault();
    if (closing.busy) return;
    setClosing(current => ({ ...current, busy: true, problem: '' }));
    try {
      const body = canonicalAdvanceBody('closed', closing.note);
      const updated = await api.advance(record.id, body, csrf);
      setClosing({ note: '', busy: false, problem: '' });
      onChanged(updated, `${updated.case_number} queda cerrado.`);
    } catch (failure) {
      setClosing(current => ({ ...current, busy: false, problem: failureMessage(failure, 'No se pudo cerrar el caso.') }));
    }
  }

  return <>
    <div className="warranty-detail-top">
      <span className="warranty-doc">{record.case_number}</span>
      <span className={`warranty-pill ${tone}`}>{warrantyPhaseShortLabel(record)}</span>
      <button type="button" className="warranty-close" onClick={onClose} aria-label="Cerrar el detalle del caso">Cerrar</button>
    </div>
    <h2>{record.origin === 'warranty_claim'
      ? sale?.customer_name ?? 'Cliente de la venta'
      : `${branchLabel(record, locations)} · góndola`}</h2>
    {record.origin === 'warranty_claim' && sale === null && saleProblem === '' && <p className="warranty-message" role="status">Consultando la venta de la unidad…</p>}
    {record.origin === 'warranty_claim' && sale !== null && <p className="warranty-client-line">
      {[sale.customer.phone, sale.customer.document, sale.customer.address].filter(part => part.trim() !== '').join(' · ') || 'Sin datos de contacto registrados'}
    </p>}
    {record.origin === 'warranty_claim' && saleProblem !== '' && <p className="warranty-note">{saleProblem}</p>}

    <dl className="warranty-facts">
      <div><dt>Batería {record.origin === 'warranty_claim' ? 'reclamada' : 'de la góndola'}</dt>
        <dd>{batteryName(sale, record.serial_number, record.variant_id)}</dd></div>
      {record.serial_number !== null
        ? <div><dt>Serial</dt><dd className="warranty-doc">{record.serial_number}</dd></div>
        : <div><dt>Cantidad</dt><dd>{units(record.quantity ?? 0)}</dd></div>}
      {record.origin === 'warranty_claim' && (record.warranty_number !== null || sale !== null) && <div><dt>Venta</dt><dd>
        {record.warranty_number ?? (sale === null ? '' : `#${sale.branch_sequence}`)}
        {sale !== null && <> · <TransferDate value={sale.created_at} /></>}
      </dd></div>}
      {record.origin === 'warranty_claim' && <div><dt>Garantía</dt><dd>
        {claimed === null ? 'La unidad vendida de esa serie' : warrantyLabel(claimed.unit.warranty_months)}
        {claimed !== null && claimed.unit.warranty_months !== null && <small className="warranty-sub">Corre desde la venta y no se reinicia</small>}
      </dd></div>}
      {record.origin === 'warranty_claim' && <div><dt>Préstamo</dt><dd>
        {lastLoan === null ? 'Sin usada entregada' : `${lastLoan.model} · ${units(lastLoan.quantity)} · ${locationName(locations, lastLoan.source_location_id)}`}
      </dd></div>}
      {record.origin === 'stock_defect' && <div><dt>Motivo de la baja</dt><dd>{record.reason}</dd></div>}
      <div><dt>Qué falló</dt><dd>{record.declared_failure}</dd></div>
      {record.verdict !== null && <div><dt>Veredicto</dt><dd>{warrantyVerdictLabels[record.verdict]}</dd></div>}
      {record.reported_destination !== null && <div><dt>Unidad reclamada</dt><dd>{warrantyDestinationLabels[record.reported_destination]}</dd></div>}
      {record.loan_destination !== null && <div><dt>Usada prestada</dt><dd>{warrantyDestinationLabels[record.loan_destination]}</dd></div>}
      {record.stock_destination !== null && <div><dt>Stock de la góndola</dt><dd>{warrantyDestinationLabels[record.stock_destination]}</dd></div>}
      {record.origin === 'warranty_claim' && <div><dt>Costo al cliente</dt><dd>Sin costo</dd></div>}
    </dl>

    {custody > 0 && <div className="warranty-custody">
      <strong>{`En custodia por garantía: ${units(custody)}`}</strong>
      {/* The custody block states the destination the case already published (S31): a unit bound for the
          branch's shelf leaves custody by the release that sells it and closes the case, and no client
          ever collects it, so the delivery is never the way out it is for the repaired unit. */}
      <p>{warrantyUnitBoundForStock(record)
        ? 'La unidad que volvió de fábrica está en custodia del caso y su destino es el stock vendible de la sucursal: mientras espera no es stock vendible, el punto de venta no puede venderla y la rendición la publica en una línea aparte. Entra al stock con la liberación que autoriza el Almacén, y el caso cierra con ese acto: a ningún cliente se le entrega.'
        : 'La unidad reparada no es stock vendible mientras espera al cliente: el punto de venta no puede venderla y la rendición la publica en una línea aparte. Sale de custodia cuando el Almacén la libera o cuando se entrega el canje.'}</p>
    </div>}
    {record.origin === 'warranty_claim' && warrantyReleased(record) && <p className="warranty-note">
      {warrantyUnitBoundForStock(record)
        ? 'El Almacén liberó la unidad al stock vendible de la sucursal: ya no está en custodia y el caso cerró con ese acto.'
        : 'El Almacén liberó la unidad a stock vendible: ya no está en custodia y el caso sigue esperando al cliente.'}
    </p>}

    <h3 className="warranty-section-title">Historial del caso</h3>
    <ol className="warranty-timeline">
      {record.events.map(entry => <li key={entry.ordinal} data-kind={entry.kind}>
        <div className="warranty-timeline-head">
          <strong>{entry.kind === 'phase' ? warrantyPhaseLabels[entry.phase] : warrantyEventKindLabels[entry.kind]}</strong>
          <time dateTime={entry.recorded_at}>{new Intl.DateTimeFormat('es-BO', { timeZone: 'America/La_Paz', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(entry.recorded_at))}</time>
        </div>
        {entry.note !== '' && <p>{entry.note}</p>}
        <p className="warranty-timeline-meta">
          {entry.factory_case_number !== '' ? `Legajo de fábrica ${entry.factory_case_number} · ` : ''}
          {`Cuenta ${entry.actor_account_id}`}
        </p>
      </li>)}
    </ol>
    {noticeEntry !== null && <p className="warranty-note">
      {`Último aviso al cliente: ${days(noticeAge ?? 0)} (${noticeEntry.note === '' ? 'sin palabras registradas' : noticeEntry.note}).`}
    </p>}

    <h3 className="warranty-section-title">{`Préstamos de usadas (${record.loans.length})`}</h3>
    {record.loans.length === 0
      ? <p className="warranty-note">{record.origin === 'warranty_claim'
        ? 'El caso no entregó ninguna usada todavía. Sin préstamo no puede salir de la sucursal.'
        : 'El hallazgo en góndola no presta ninguna batería: no tiene cliente.'}</p>
      : <div className="warranty-table-wrap">
        <table className="warranty-loans">
          <caption>Usadas entregadas por el caso, en el orden en que salieron del mostrador</caption>
          <thead><tr>
            <th scope="col">#</th><th scope="col">Modelo</th><th scope="col" className="num">Cantidad</th>
            <th scope="col">Serial anotado</th><th scope="col">Sale de</th><th scope="col">Entregada</th><th scope="col">Desenlace</th>
          </tr></thead>
          <tbody>{record.loans.map(loan => <tr key={loan.ordinal}>
            <td>{loan.ordinal}</td>
            <td><strong>{loan.model}</strong></td>
            <td className="num">{loan.quantity}</td>
            <td>{loan.serial_number === '' ? <span className="warranty-quiet">Sin serial anotado</span> : <span className="warranty-doc">{loan.serial_number}</span>}</td>
            <td>{locationName(locations, loan.source_location_id)}</td>
            <td><TransferDate value={loan.given_at} /></td>
            <td><span className={`warranty-pill ${loan.fate === 'open' ? 'wine' : 'quiet'}`}>{warrantyLoanFateLabels[loan.fate]}</span>
              {loan.fate_decided_at !== null && <small className="warranty-sub"><TransferDate value={loan.fate_decided_at} /></small>}</td>
          </tr>)}</tbody>
        </table>
      </div>}

    {openLoans.length > 0 && record.phase !== 'closed' && <div className="warranty-action">
      <h4>Desenlace de la usada</h4>
      <p className="warranty-note">Si la usada prestada falló, se marca acá y se agrega otra al mismo caso: el cliente nunca queda sin batería y el caso sigue siendo uno solo.</p>
      {openLoans.map(entry => <LoanFateActions key={entry.ordinal} record={record} loan={entry} api={api} csrf={csrf}
        onChanged={onChanged} />)}
    </div>}

    {warrantyReceiptAvailable(record) && <p className="warranty-receipt">
      <a href={warrantyReceiptPath(record.id)} download={warrantyReceiptFileName(record)}>
        {`Descargar el comprobante de préstamo de ${record.case_number}`}
      </a>
      <span className="warranty-note">Una página con el número de caso, la garantía de la venta, la serie reclamada y cada usada prestada: son los valores guardados, sin recalcular nada.</span>
    </p>}

    <h3 className="warranty-section-title">Acciones de la sucursal</h3>
    <div className="warranty-actions">
      {/* The order follows the dependency: the loan is what the departure waits for, so it comes first (S34). */}
      {warrantyLendAvailable(record) && (lending
        ? <LendForm record={record} api={api} csrf={csrf} locations={locations}
          onCancel={() => setLending(false)}
          onChanged={(loanRecord, message) => {
            setLending(false);
            onChanged(loanRecord, message);
          }} />
        : <div className="warranty-action">
          <h4>{record.loans.length === 0 ? 'Prestar la usada del cliente' : 'Prestar otra usada'}</h4>
          <p className="warranty-note">{openLoan === null
            ? 'El cliente nunca queda sin batería: la usada se presta por modelo y cantidad, y su serial es opcional.'
            : `El caso tiene ${units(openLoan.quantity)} del modelo ${openLoan.model} en préstamo. Si esa usada falla, se marca y se agrega otra al mismo caso.`}</p>
          <button type="button" onClick={() => setLending(true)}>Registrar préstamo</button>
        </div>)}

      {warrantyDispatchAvailable(record) && <form className="warranty-action" onSubmit={submitDispatch}>
        <h4>Sale de la sucursal</h4>
        <p className="warranty-note">El viaje lo sigue el Almacén: acá sólo se registra que la batería dejó el local.</p>
        <label htmlFor={`dispatch-note-${record.id}`}>Motivo del envío</label>
        <input id={`dispatch-note-${record.id}`} value={dispatch.note} maxLength={500} required
          onChange={event => setDispatch(current => ({ ...current, note: event.target.value }))} />
        <button type="submit" disabled={dispatch.busy || !warrantyLoanRegistered(record)}>Enviar al Almacén</button>
        {!warrantyLoanRegistered(record) && <p className="warranty-reason">
          La usada del cliente todavía no está registrada: el caso no puede salir de la sucursal sin préstamo.
        </p>}
        {dispatch.problem !== '' && <p className="warranty-problem" role="alert">{dispatch.problem}</p>}
      </form>}

      {warrantyNoticeAvailable(record) && <form className="warranty-action" onSubmit={submitNotice}>
        <h4>Avisar al cliente</h4>
        <p className="warranty-note">El aviso lo registra la sucursal que recibió la unidad. Habilita la liberación a stock que autoriza el Almacén.</p>
        <label htmlFor={`notice-note-${record.id}`}>Qué se le dijo al cliente</label>
        <textarea id={`notice-note-${record.id}`} value={notice.note} maxLength={500} required rows={3}
          onChange={event => setNotice(current => ({ ...current, note: event.target.value }))} />
        <button type="submit" disabled={notice.busy}>Registrar aviso</button>
        {notice.problem !== '' && <p className="warranty-problem" role="alert">{notice.problem}</p>}
      </form>}

      {/* The unit bound for the branch's shelf leaves by the release and never with a client (S31): the rule is
          the pair of the destination and the verdict, read from the case model where the whole app reads it, so an
          uncovered unit with that same destination — the used pool's (LW025) — keeps its delivery. */}
      {warrantyDeliveryAvailable(record) && !warrantyUnitBoundForStock(record) && <form className="warranty-action" onSubmit={submitDelivery}>
        <h4>Entregar el canje</h4>
        <p className="warranty-note">Se entrega la batería que volvió de fábrica y el caso queda cerrado, con la usada resuelta en el mismo acto.</p>
        <label htmlFor={`delivery-fate-${record.id}`}>Qué pasó con la usada</label>
        <select id={`delivery-fate-${record.id}`} value={delivery.fate}
          onChange={event => {
            const next = event.target.value;
            if (warrantyDeliveryFates.includes(next as WarrantyDeliveryFate) || next === '') {
              setDelivery(current => ({ ...current, fate: next as WarrantyDeliveryFate | '' }));
            }
          }}>
          <option value="">Elegí qué pasó con la usada</option>
          <option value="returned">Volvió al local</option>
          <option value="kept_by_customer">Se la quedó el cliente</option>
        </select>
        <label htmlFor={`delivery-note-${record.id}`}>Palabras del mostrador</label>
        <textarea id={`delivery-note-${record.id}`} value={delivery.note} maxLength={500} required rows={2}
          onChange={event => setDelivery(current => ({ ...current, note: event.target.value }))} />
        <button type="submit" className="primary"
          disabled={delivery.busy || delivery.fate === '' || !warrantyLoanRegistered(record)}>Entregar canje</button>
        {delivery.fate === '' && <p className="warranty-reason">
          Falta decir qué pasó con la usada prestada: ninguna pantalla elige ese desenlace por el mostrador.
        </p>}
        {!warrantyLoanRegistered(record) && <p className="warranty-reason">
          Falta registrar la usada que se entregó al cliente: sin préstamo el canje no se cierra.
        </p>}
        {delivery.problem !== '' && <p className="warranty-problem" role="alert">{delivery.problem}</p>}
      </form>}

      {warrantyUnitBoundForStock(record) && record.phase !== 'closed' && <div className="warranty-action">
        <h4>El caso cierra con la liberación</h4>
        <p className="warranty-note">La unidad de este caso va al stock vendible de la sucursal: no se entrega a ningún cliente. El caso queda cerrado con el aviso al cliente y la liberación que autoriza el Almacén, no con la entrega.</p>
      </div>}

      {warrantyCloseAvailable(record) && <form className="warranty-action" onSubmit={submitClose}>
        <h4>Cerrar el caso</h4>
        <p className="warranty-note">El hallazgo en góndola lo cierra su propia sucursal cuando ya no queda nada que mover.</p>
        <label htmlFor={`close-note-${record.id}`}>Palabras del cierre</label>
        <input id={`close-note-${record.id}`} value={closing.note} maxLength={500} required
          onChange={event => setClosing(current => ({ ...current, note: event.target.value }))} />
        <button type="submit" disabled={closing.busy}>Cerrar el caso</button>
        {closing.problem !== '' && <p className="warranty-problem" role="alert">{closing.problem}</p>}
      </form>}

      {record.phase === 'closed' && <p className="warranty-note">El caso está cerrado: no admite más acciones de la sucursal.</p>}
    </div>
  </>;
}
function branchLabel(record: WarrantyCase, locations: readonly Location[]): string {
  return locationName(locations, record.branch_location_id);
}

function LoanFateActions({ record, loan, api, csrf, onChanged }: {
  record: WarrantyCase;
  loan: WarrantyLoan;
  api: ReturnType<typeof createWarrantyCasesAPI>;
  csrf: string;
  onChanged: (record: WarrantyCase, message: string) => void;
}) {
  const [confirming, setConfirming] = useState<WarrantyLoanFateStated | ''>('');
  const [state, setState] = useState({ busy: false, problem: '' });
  async function submit(fate: WarrantyLoanFateStated) {
    if (state.busy) return;
    setState({ busy: true, problem: '' });
    try {
      const body = canonicalLoanFateBody(fate);
      const settled = await api.decideLoan(record.id, loan.ordinal, body.fate, csrf);
      const updated = { ...record, loans: record.loans.map(entry => entry.ordinal === loan.ordinal ? settled : entry) };
      setConfirming('');
      onChanged(updated, `Préstamo ${loan.ordinal} de ${record.case_number}: ${warrantyLoanFateLabels[settled.fate].toLowerCase()}.`);
    } catch (failure) {
      setState({ busy: false, problem: failureMessage(failure, 'No se pudo registrar el desenlace del préstamo.') });
    }
  }
  const labelled = warrantyLoanFateFacts.find(fact => fact.fate === confirming)?.label ?? '';
  return <div className="warranty-fate">
    <strong>{`Préstamo ${loan.ordinal} · ${loan.model} · ${units(loan.quantity)}`}</strong>
    <p className="warranty-fate-state">Desenlace: sin decidir · se pide al cerrar el caso</p>
    {confirming === ''
      ? <div className="warranty-action-row">
        {warrantyLoanFateFacts.map(fact => <button type="button" key={fact.fate}
          onClick={() => { setState({ busy: false, problem: '' }); setConfirming(fact.fate); }}>{fact.label}</button>)}
      </div>
      : <div className="warranty-fate-ask" role="group" aria-label={`Confirmar el desenlace del préstamo ${loan.ordinal}`}>
        <p className="warranty-fate-confirm">{`${labelled}: el desenlace es definitivo y no se puede editar.`}</p>
        <div className="warranty-action-row">
          <button type="button" className="primary" disabled={state.busy}
            onClick={() => void submit(confirming)}>Sí, registrar el desenlace</button>
          <button type="button" disabled={state.busy} onClick={() => setConfirming('')}>Cancelar</button>
        </div>
      </div>}
    {state.problem !== '' && <p className="warranty-problem" role="alert">{state.problem}</p>}
  </div>;
}

function LendForm({ record, api, csrf, locations, onCancel, onChanged }: {
  record: WarrantyCase;
  api: ReturnType<typeof createWarrantyCasesAPI>;
  csrf: string;
  locations: readonly Location[];
  onCancel: () => void;
  onChanged: (record: WarrantyCase, message: string) => void;
}) {
  const [draft, setDraft] = useState({ model: '', quantity: '1', serial: '', source: record.branch_location_id });
  const [state, setState] = useState({ busy: false, problem: '' });
  // The closed list of S30, the same read the counter uses: a model the pool never saw cannot be lent.
  const [stock, setStock] = useState<{ phase: 'loading' | 'ready' | 'error'; rows: readonly UsedStockRow[] }>({ phase: 'loading', rows: [] });
  const field = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    setStock({ phase: 'loading', rows: [] });
    void api.usedStock(controller.signal).then(
      rows => { if (!controller.signal.aborted) setStock({ phase: 'ready', rows }); },
      () => { if (!controller.signal.aborted) setStock({ phase: 'error', rows: [] }); });
    return () => controller.abort();
  }, [api]);
  // The model field is the first thing the operator has to answer, and it waits for its own list.
  useEffect(() => { if (stock.phase === 'ready') field.current?.focus(); }, [stock.phase]);
  const lendable = useMemo(() => stock.rows
    .filter(row => row.location_id === draft.source && row.available > 0)
    .slice()
    .sort((left, right) => left.model.localeCompare(right.model)), [stock.rows, draft.source]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (state.busy) return;
    setState({ busy: true, problem: '' });
    try {
      const body = canonicalLoanBody(draft.model, draft.quantity, draft.serial, draft.source);
      const handed = await api.addLoan(record.id, () => body, csrf);
      const updated = { ...record, loans: [...record.loans, handed] };
      onChanged(updated, `Usada registrada en ${updated.case_number}: ${body.model} · ${units(body.quantity)}.`);
    } catch (failure) {
      setState({ busy: false, problem: failureMessage(failure, 'No se pudo registrar el préstamo.') });
    }
  }
  return <form className="warranty-action" onSubmit={submit}>
    <h4>Prestar una usada</h4>
    {stock.phase === 'loading' && <p className="warranty-note" role="status">Consultando el stock de usadas…</p>}
    {stock.phase === 'error' && <p className="warranty-problem" role="alert">{usedStockUnavailable}</p>}
    {/* The label travels with its control: an origin with nothing to lend publishes no field at
        all, so the form says why instead of pointing at a model that cannot be chosen (S30). */}
    {stock.phase === 'ready' && (lendable.length === 0
      ? <p className="warranty-problem" role="alert">
        {`${locationName(locations, draft.source)} no tiene usadas de ningún modelo. El préstamo sale del stock de usadas que el origen ya tiene: probá con otro origen.`}
      </p>
      : <>
        <label htmlFor={`lend-model-${record.id}`}>Modelo de la usada</label>
        <select ref={field} id={`lend-model-${record.id}`} value={draft.model} required
          onChange={event => setDraft(current => ({ ...current, model: event.target.value }))}>
          <option value="">Elegí el modelo</option>
          {lendable.map(row => <option key={row.model} value={row.model}>
            {`${row.model} · ${units(row.available)}`}
          </option>)}
        </select>
      </>)}
    <label htmlFor={`lend-quantity-${record.id}`}>Cantidad</label>
    <input id={`lend-quantity-${record.id}`} inputMode="numeric" value={draft.quantity} required
      onChange={event => setDraft(current => ({ ...current, quantity: event.target.value }))} />
    <label htmlFor={`lend-serial-${record.id}`}>Serial de la usada (opcional)</label>
    <input id={`lend-serial-${record.id}`} value={draft.serial} maxLength={64}
      onChange={event => setDraft(current => ({ ...current, serial: event.target.value }))} />
    <label htmlFor={`lend-source-${record.id}`}>De dónde sale</label>
    <select id={`lend-source-${record.id}`} value={draft.source}
      onChange={event => setDraft(current => ({ ...current, source: Number(event.target.value), model: '' }))}>
      {locations.map(entry => <option key={entry.id} value={entry.id}>{entry.id === record.branch_location_id ? `${entry.name} (sucursal del caso)` : entry.name}</option>)}
    </select>
    <p className="warranty-note">El préstamo no mueve stock ni crea una transferencia: registra de dónde salió la usada. Sólo se presta un modelo que el sistema ya conoce, y sólo si el origen lo tiene.</p>
    <div className="warranty-action-row">
      <button type="submit" className="primary"
        disabled={state.busy || draft.model === '' || stock.phase !== 'ready'}>Registrar préstamo</button>
      <button type="button" onClick={onCancel} disabled={state.busy}>Cancelar</button>
    </div>
    {state.problem !== '' && <p className="warranty-problem" role="alert">{state.problem}</p>}
  </form>;
}

// ---------------------------------------------------------------------------------
// Registrar canje: the claim, the sale it is judged against and the loan
// ---------------------------------------------------------------------------------

function ExchangeDialog({ api, sales, csrf, branch, locations, onClose, onCase }: {
  api: ReturnType<typeof createWarrantyCasesAPI>;
  sales: ReturnType<typeof createSalesAPI>;
  csrf: string;
  branch: string;
  locations: readonly Location[];
  onClose: () => void;
  onCase: (record: WarrantyCase) => void;
}) {
  const [step, setStep] = useState<'claim' | 'loan' | 'done'>('claim');
  const [claim, setClaim] = useState({ serial: '', failure: '' });
  const [created, setCreated] = useState<WarrantyCase | null>(null);
  const [sale, setSale] = useState<{ phase: 'loading' | 'ready' | 'error'; value: SaleDetail | null; problem: string }>({ phase: 'loading', value: null, problem: '' });
  const [loan, setLoan] = useState({ model: '', quantity: '1', serial: '', source: 0 });
  // The closed list of S30: the models the used pool already knows, with what the origin holds of each.
  const [stock, setStock] = useState<{ phase: 'loading' | 'ready' | 'error'; rows: readonly UsedStockRow[] }>({ phase: 'loading', rows: [] });
  const [state, setState] = useState({ busy: false, problem: '' });
  const serialField = useRef<HTMLInputElement>(null);
  const modelField = useRef<HTMLSelectElement>(null);
  const dialog = useDialogFocus(onClose);
  useEffect(() => {
    if (step !== 'loan') return;
    const controller = new AbortController();
    setStock({ phase: 'loading', rows: [] });
    void api.usedStock(controller.signal).then(
      rows => { if (!controller.signal.aborted) setStock({ phase: 'ready', rows }); },
      () => { if (!controller.signal.aborted) setStock({ phase: 'error', rows: [] }); });
    return () => controller.abort();
  }, [api, step]);
  // The case's own branch is where the counter looks first, and the list follows the origin it picks.
  useEffect(() => {
    if (created !== null) {
      setLoan(current => current.source === 0
        ? { ...current, source: created.branch_location_id } : current);
    }
  }, [created]);
  const lendable = useMemo(() => stock.rows
    .filter(row => row.location_id === loan.source && row.available > 0)
    .slice()
    .sort((left, right) => left.model.localeCompare(right.model)), [stock.rows, loan.source]);
  useEffect(() => {
    if (step === 'claim') serialField.current?.focus();
    else if (step === 'loan') modelField.current?.focus();
  }, [step]);

  // The sale the claim was judged against is the client's: it is read once the case exists.
  useEffect(() => {
    if (created === null || created.sale_id === null) return;
    const controller = new AbortController();
    const id = created.sale_id;
    void (async () => {
      try {
        const value = await sales.detail(id, controller.signal);
        setSale({ phase: 'ready', value, problem: '' });
      } catch {
        if (!controller.signal.aborted) setSale({ phase: 'error', value: null, problem: warrantySaleUnavailable });
      }
    })();
    return () => controller.abort();
  }, [sales, created]);

  async function submitClaim(event: FormEvent) {
    event.preventDefault();
    if (state.busy) return;
    setState({ busy: true, problem: '' });
    try {
      const body = canonicalClaimBody(claim.serial, claim.failure);
      const record = await api.openClaim(() => body, csrf);
      setCreated(record);
      setLoan(current => ({ ...current, source: record.branch_location_id }));
      setStep('loan');
      setState({ busy: false, problem: '' });
      onCase(record);
    } catch (failure) {
      setState({ busy: false, problem: failureMessage(failure, 'No se pudo abrir el caso.') });
    }
  }
  async function submitLoan(event: FormEvent) {
    event.preventDefault();
    if (state.busy || created === null) return;
    setState({ busy: true, problem: '' });
    try {
      const body = canonicalLoanBody(loan.model, loan.quantity, loan.serial, loan.source);
      const handed = await api.addLoan(created.id, () => body, csrf);
      const updated = { ...created, loans: [...created.loans, handed] };
      setCreated(updated);
      setStep('done');
      setState({ busy: false, problem: '' });
      onCase(updated);
    } catch (failure) {
      setState({ busy: false, problem: failureMessage(failure, 'No se pudo registrar el préstamo.') });
    }
  }

  return <div className="warranty-backdrop">
    <section ref={dialog} className="warranty-dialog" role="dialog" aria-modal="true" aria-labelledby="warranty-exchange-title">
      <header>
        <h2 id="warranty-exchange-title">Registrar canje</h2>
        <button type="button" onClick={onClose} aria-label="Cerrar el registro del canje">Cerrar</button>
      </header>
      <p className="warranty-note">{`El reclamo entra con la serie de la batería vendida. La venta, su plazo y el número de garantía los lee el servidor de esa misma serie; la usada se elige después, en ${branch}.`}</p>

      {step === 'claim' && <form onSubmit={submitClaim}>
        <label htmlFor="warranty-claim-serial">Número de serie de la batería reclamada</label>
        <input ref={serialField} id="warranty-claim-serial" value={claim.serial} maxLength={64} required autoComplete="off"
          onChange={event => setClaim(current => ({ ...current, serial: event.target.value }))} />
        <label htmlFor="warranty-claim-failure">Qué falló</label>
        <textarea id="warranty-claim-failure" value={claim.failure} maxLength={500} required rows={3}
          onChange={event => setClaim(current => ({ ...current, failure: event.target.value }))} />
        <div className="warranty-action-row">
          <button type="submit" className="primary" disabled={state.busy}>Buscar la venta y abrir el caso</button>
          <button type="button" onClick={onClose} disabled={state.busy}>Cancelar</button>
        </div>
        {state.problem !== '' && <p className="warranty-problem" role="alert">{state.problem}</p>}
      </form>}

      {step === 'loan' && created !== null && <>
        <p className="warranty-confirm" role="status">{`Caso ${created.case_number} abierto por la serie ${created.serial_number ?? ''}.`}</p>
        {sale.phase === 'loading' && <p className="warranty-message" role="status">Leyendo la venta de la serie…</p>}
        {sale.phase === 'error' && <p className="warranty-note">{sale.problem}</p>}
        {sale.phase === 'ready' && sale.value !== null && (() => {
          const claimed = claimedUnit(sale.value, created.serial_number);
          return <dl className="warranty-facts warranty-sale-facts">
            <div><dt>Cliente</dt><dd>{sale.value.customer_name}</dd></div>
            <div><dt>Venta</dt><dd>{sale.value.warranty_number} · <TransferDate value={sale.value.created_at} /></dd></div>
            <div><dt>Batería</dt><dd>{batteryName(sale.value, created.serial_number, created.variant_id)}</dd></div>
            <div><dt>Plazo de la unidad</dt><dd>{claimed === null ? 'No figura en esta venta' : warrantyLabel(claimed.unit.warranty_months)}</dd></div>
          </dl>;
        })()}
        <form onSubmit={submitLoan}>
          {stock.phase === 'loading' && <p className="warranty-note" role="status">Consultando el stock de usadas…</p>}
          {stock.phase === 'error' && <p className="warranty-problem" role="alert">{usedStockUnavailable}</p>}
          {/* The label travels with its control: an origin with nothing to offer publishes no field at
              all, so the form says why instead of pointing at a model that cannot be chosen (S30). */}
          {stock.phase === 'ready' && (lendable.length === 0
            ? <p className="warranty-problem" role="alert">
              {`${locationName(locations, loan.source)} no tiene usadas de ningún modelo. El préstamo sale del stock de usadas que el origen ya tiene: probá con otro origen.`}
            </p>
            : <>
              <label htmlFor="warranty-loan-model">Modelo de la usada</label>
              <select ref={modelField} id="warranty-loan-model" value={loan.model} required
                onChange={event => setLoan(current => ({ ...current, model: event.target.value }))}>
                <option value="">Elegí el modelo</option>
                {lendable.map(row => <option key={row.model} value={row.model}>
                  {`${row.model} · ${units(row.available)}`}
                </option>)}
              </select>
            </>)}
          <label htmlFor="warranty-loan-quantity">Cantidad</label>
          <input id="warranty-loan-quantity" inputMode="numeric" value={loan.quantity} required
            onChange={event => setLoan(current => ({ ...current, quantity: event.target.value }))} />
          <label htmlFor="warranty-loan-serial">Serial de la usada (opcional)</label>
          <input id="warranty-loan-serial" value={loan.serial} maxLength={64}
            onChange={event => setLoan(current => ({ ...current, serial: event.target.value }))} />
          <label htmlFor="warranty-loan-source">De dónde sale la usada</label>
          <select id="warranty-loan-source" value={loan.source}
            onChange={event => setLoan(current => ({ ...current, source: Number(event.target.value), model: '' }))}>
            {locations.map(entry => <option key={entry.id} value={entry.id}>{entry.id === created.branch_location_id ? `${entry.name} (sucursal del caso)` : entry.name}</option>)}
          </select>
          <p className="warranty-note">La usada se identifica por modelo y cantidad: el serial es texto libre y no es identidad. Sólo se presta un modelo que el sistema ya conoce, y sólo si el origen lo tiene; el préstamo no mueve stock.</p>
          <div className="warranty-action-row">
            <button type="submit" className="primary"
              disabled={state.busy || loan.model === '' || stock.phase !== 'ready'}>Registrar el préstamo</button>
            <button type="button" onClick={onClose} disabled={state.busy}>Dejarlo para después</button>
          </div>
          {state.problem !== '' && <p className="warranty-problem" role="alert">{state.problem}</p>}
        </form>
      </>}

      {step === 'done' && created !== null && <>
        <p className="warranty-dialog-case" role="status">{`Caso ${created.case_number}: el cliente ya tiene su usada y el caso queda en la sucursal.`}</p>
        <p className="warranty-receipt">
          <a href={warrantyReceiptPath(created.id)} download={warrantyReceiptFileName(created)}>
            {`Descargar el comprobante de préstamo de ${created.case_number}`}
          </a>
        </p>
        <div className="warranty-action-row">
          <button type="button" className="primary" onClick={() => { onCase(created); onClose(); }}>Ver el caso en la bandeja</button>
        </div>
      </>}
    </section>
  </div>;
}

// ---------------------------------------------------------------------------------
// Hallazgo en góndola: la batería que la sucursal descubre fallada en su propio stock
// ---------------------------------------------------------------------------------

function DefectDialog({ api, sales, csrf, branch, onClose, onCase }: {
  api: ReturnType<typeof createWarrantyCasesAPI>;
  sales: ReturnType<typeof createSalesAPI>;
  csrf: string;
  branch: string;
  onClose: () => void;
  onCase: (record: WarrantyCase) => void;
}) {
  const [search, setSearch] = useState('');
  const [catalog, setCatalog] = useState<CatalogState>({ phase: 'loading', items: [], problem: warrantyCatalogueUnavailable });
  const [draft, setDraft] = useState({ variant: 0, quantity: '1', failure: '', reason: '' });
  const [state, setState] = useState({ busy: false, problem: '' });
  const first = useRef<HTMLInputElement>(null);
  const dialog = useDialogFocus(onClose);
  useEffect(() => { first.current?.focus(); }, []);

  // The branch's own catalogue is the shelf the battery came from: the finding names a variant of it.
  useEffect(() => {
    const controller = new AbortController();
    let alive = true;
    setCatalog(current => ({ phase: 'loading', items: current.items, problem: warrantyCatalogueUnavailable }));
    void (async () => {
      try {
        const page = await sales.sellable({ search, brand: '', capacity: '', polarity: '', kind: 'battery', page: 1, page_size: 50 },
          controller.signal);
        if (!alive) return;
        setCatalog({
          phase: 'ready',
          problem: '',
          items: page.items.map(item => ({
            variant_id: item.variant_id,
            name: item.identity?.name ?? [item.brand, item.model].filter(Boolean).join(' '),
            detail: item.identity?.detail ?? [item.capacity_ah && `${item.capacity_ah} Ah`, item.polarity].filter(Boolean).join(' · '),
            available: item.available,
          })),
        });
      } catch {
        if (alive) setCatalog({ phase: 'error', items: [], problem: warrantyCatalogueUnavailable });
      }
    })();
    return () => { alive = false; controller.abort(); };
  }, [sales, search]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (state.busy) return;
    setState({ busy: true, problem: '' });
    try {
      const body = canonicalDefectBody(draft.variant, draft.quantity, draft.failure, draft.reason);
      const record = await api.openDefect(() => body, csrf);
      setState({ busy: false, problem: '' });
      onCase(record);
      onClose();
    } catch (failure) {
      setState({ busy: false, problem: failureMessage(failure, 'No se pudo registrar el hallazgo.') });
    }
  }

  return <div className="warranty-backdrop">
    <section ref={dialog} className="warranty-dialog" role="dialog" aria-modal="true" aria-labelledby="warranty-defect-title">
      <header>
        <h2 id="warranty-defect-title">Hallazgo en góndola</h2>
        <button type="button" onClick={onClose} aria-label="Cerrar el registro del hallazgo">Cerrar</button>
      </header>
      <p className="warranty-note">{`La sucursal encontró una batería fallada en su propio stock antes de venderla. La baja descuenta la cantidad de ${branch} en el mismo acto del alta del caso y deja el motivo en la evidencia.`}</p>
      <form onSubmit={submit}>
        <label htmlFor="warranty-defect-search">Buscar en el catálogo de la sucursal</label>
        <input ref={first} id="warranty-defect-search" type="search" value={search}
          onChange={event => setSearch(event.target.value)} />
        {catalog.phase === 'loading' && <p className="warranty-message" role="status">Consultando el catálogo…</p>}
        {catalog.phase === 'error' && <p className="warranty-problem" role="alert">{catalog.problem}</p>}
        <label htmlFor="warranty-defect-variant">Batería que falló</label>
        <select id="warranty-defect-variant" value={draft.variant === 0 ? '' : String(draft.variant)} required
          onChange={event => setDraft(current => ({ ...current, variant: Number(event.target.value) }))}>
          <option value="">Elegí la variante</option>
          {catalog.items.map(item => <option key={item.variant_id} value={item.variant_id}>
            {`${item.name}${item.detail === '' ? '' : ` · ${item.detail}`} · disponibles ${item.available.toString()}`}
          </option>)}
        </select>
        <label htmlFor="warranty-defect-quantity">Cantidad de unidades</label>
        <input id="warranty-defect-quantity" inputMode="numeric" value={draft.quantity} required
          onChange={event => setDraft(current => ({ ...current, quantity: event.target.value }))} />
        <label htmlFor="warranty-defect-failure">Qué falló</label>
        <textarea id="warranty-defect-failure" value={draft.failure} maxLength={500} required rows={2}
          onChange={event => setDraft(current => ({ ...current, failure: event.target.value }))} />
        <label htmlFor="warranty-defect-reason">Motivo de la baja de stock</label>
        <textarea id="warranty-defect-reason" value={draft.reason} maxLength={500} required rows={2}
          onChange={event => setDraft(current => ({ ...current, reason: event.target.value }))} />
        <div className="warranty-action-row">
          <button type="submit" className="primary" disabled={state.busy}>Registrar el hallazgo</button>
          <button type="button" onClick={onClose} disabled={state.busy}>Cancelar</button>
        </div>
        {state.problem !== '' && <p className="warranty-problem" role="alert">{state.problem}</p>}
      </form>
    </section>
  </div>;
}
