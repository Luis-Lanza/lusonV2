import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import type { Location } from './model';
import TransferDate from './shared/TransferDate';
import {
  WarrantyCaseAPIError, createWarrantyCasesAPI, warrantyCaseErrorMessages, warrantyCaseUnavailable,
  warrantyTrayUnavailable,
} from './warrantyCasesAPI';
import {
  warrantyDaysSince, warrantyDestinationLabels, warrantyEventLabel, warrantyLoanFateLabels,
  warrantyNotice, warrantyNoticeDays, warrantyOriginLabels, warrantyPhaseShortLabel, warrantyPhaseTone,
  warrantyRowPhaseLabel, warrantyUnitsWrittenOff, warrantyVerdictLabels,
  type WarrantyCase,
  type WarrantyCaseRow, type WarrantyDestination, type WarrantyVerdict,
} from './warrantyCasesModel';
import {
  canonicalClaimResolutionBody, canonicalDefectResolutionBody, canonicalFactoryShipment,
  canonicalReleaseBody, canonicalWarehouseArrival, warehouseArrivalAvailable, warehouseBuckets,
  warehouseDaysInPhase, warehouseLoanDestinations, warehousePhaseOrder, warehouseReleaseAvailable,
  warehouseReleaseBlocked, warehouseReleaseSubjectKind, warehouseReportedDestinations,
  warehouseShipmentAvailable,
  warehouseStockCrossings, warehouseVerdictAvailable, warehouseVerdicts, type WarehouseCrossingState,
  type WarehousePhase,
} from './warehouseWarrantyModel';
import './warranty-cases.css';
import { subscribeWarrantyInvalidation } from './useInventory';
import './warehouse-warranty.css';

/**
 * The warehouse's factory desk of the battery warranty case (S9, S10, S13, S14, S15). The Almacén moves
 * the battery and nothing else: it receives what a branch sent, verifies it and may refuse before the
 * factory, ships it with the file number it transcribes by hand, states the verdict the factory
 * answered and authorises the release of the unit a claim holds in custody.
 *
 * The figures of the desk are its four questions — what is on its way, what waits for the verification,
 * what is at the factory and for how long, what came back and waits for a decision — and each figure is
 * the queue it names. The case detail is the branch pane's own facts, history and custody block,
 * because it is the same case: only the acts change, and the branch's acts never appear here (S19).
 */

export interface WarehouseWarrantyCasesProps {
  /** The session's CSRF token, captured by the shell that mounted this screen. */
  csrf: string;
  /** Every provisioned location: each case names the branch that owns it, and the warehouse is never one. */
  locations: readonly Location[];
  fetcher?: typeof globalThis.fetch;
  /** The clock the ages are measured against; the tests freeze it. */
  now?: () => Date;
}

interface TrayState {
  readonly phase: 'loading' | 'ready' | 'error';
  readonly rows: readonly WarrantyCaseRow[];
  readonly problem: string;
}
interface DetailState {
  readonly id: number;
  readonly phase: 'loading' | 'ready' | 'error';
  readonly record: WarrantyCase | null;
  readonly problem: string;
}

function failureMessage(failure: unknown, fallback: string): string {
  return failure instanceof WarrantyCaseAPIError ? warrantyCaseErrorMessages[failure.code] : fallback;
}
const locationName = (locations: readonly Location[], id: number): string =>
  locations.find(entry => entry.id === id)?.name ?? `Ubicación ${id}`;
const units = (quantity: number): string => `${quantity} ${quantity === 1 ? 'unidad' : 'unidades'}`;
const days = (value: number): string => value === 1 ? '1 día' : `${value} días`;
const bucketQuestions = new Map<WarehousePhase, string>(
  warehouseBuckets.map(bucket => [bucket.phase, bucket.question]));

/** Every figure says what it asks, so a count of the desk never travels alone. */
function figureNote(phase: WarehousePhase, state: TrayState, today: Date): string {
  if (state.phase === 'error') return state.problem;
  if (state.phase === 'loading' && state.rows.length === 0) return 'Consultando los casos…';
  if (state.rows.length === 0) {
    return phase === 'at_factory' ? 'Ningún caso en fábrica' : bucketQuestions.get(phase) ?? '';
  }
  // The tray publishes the header of a case: the age of a row is the age of its admission, and the
  // time in the phase the case holds today is read from its history in the detail.
  const oldest = state.rows[state.rows.length - 1];
  const age = warrantyDaysSince(oldest.created_at, today);
  if (phase === 'at_factory') {
    const stale = state.rows.filter(row => warrantyDaysSince(row.created_at, today) > 30).length;
    return stale === 0 ? 'Ninguno pasa los 30 días desde el alta' : `${stale} con más de 30 días desde el alta`;
  }
  return `El más antiguo, ${days(age)} desde el alta`;
}

const crossingStateLabels: Record<WarehouseCrossingState, string> = {
  absent: 'Sin movimiento',
  written: 'Dada de baja',
  returned: 'Devuelta al stock',
  held: 'En custodia',
  pending: 'Lista para liberar',
  released: 'Liberada a stock',
};
const crossingStateTones: Record<WarehouseCrossingState, string> = {
  absent: 'quiet',
  written: 'warn',
  returned: 'ok',
  held: 'wine',
  pending: 'warn',
  released: 'ok',
};

export default function WarehouseWarrantyCases({ csrf, locations, fetcher = globalThis.fetch,
  now = () => new Date() }: WarehouseWarrantyCasesProps) {
  const api = useMemo(() => createWarrantyCasesAPI(fetcher), [fetcher]);
  const [bucket, setBucket] = useState<WarehousePhase>('at_warehouse');
  const [revision, setRevision] = useState(0);
  const [trays, setTrays] = useState<Record<WarehousePhase, TrayState>>(() => {
    const idle = (): TrayState => ({ phase: 'loading', rows: [], problem: warrantyTrayUnavailable });
    return { in_transit: idle(), at_warehouse: idle(), at_factory: idle(), resolved: idle() };
  });
  const [selected, setSelected] = useState<number | null>(null);
  const [detailRevision, setDetailRevision] = useState(0);
  const [detail, setDetail] = useState<DetailState | null>(null);
  const [status, setStatus] = useState('');

  // One read per question of the desk: the phase filter is the contract's own, and a failed question
  // never hides the others.
  useEffect(() => {
    const controller = new AbortController();
    let alive = true;
    setTrays(current => {
      const next = { ...current };
      for (const phase of warehousePhaseOrder) {
        next[phase] = { phase: 'loading', rows: current[phase].rows, problem: warrantyTrayUnavailable };
      }
      return next;
    });
    for (const phase of warehousePhaseOrder) {
      void (async () => {
        try {
          const rows = await api.tray({ phase }, controller.signal);
          if (!alive) return;
          setTrays(current => ({ ...current, [phase]: { phase: 'ready', rows, problem: '' } }));
        } catch (failure) {
          if (!alive) return;
          setTrays(current => ({
            ...current,
            [phase]: { phase: 'error', rows: [], problem: failureMessage(failure, warrantyTrayUnavailable) },
          }));
        }
      })();
    }
    return () => { alive = false; controller.abort(); };
  }, [api, revision]);

  // One case read per selected case: the loans and the append-only history live on the case and never
  // on the tray row, so the detail is the only place they are published.
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

  // The branch's write reaches the desk without a reload: the participant invalidation re-reads the
  // four questions of the desk and the open case, and it never carries a record (S19, 070).
  useEffect(() => subscribeWarrantyInvalidation(() => {
    setRevision(value => value + 1);
    setDetailRevision(value => value + 1);
  }), []);

  const current = detail?.phase === 'ready' ? detail.record : null;
  const today = now();
  const active = trays[bucket];
  const activeBucket = warehouseBuckets.find(entry => entry.phase === bucket) ?? warehouseBuckets[0];
  const busy = warehousePhaseOrder.some(phase => trays[phase].phase === 'loading');

  function accept(record: WarrantyCase, message: string) {
    setSelected(record.id);
    setDetail({ id: record.id, phase: 'ready', record, problem: '' });
    setStatus(message);
    setRevision(value => value + 1);
  }
  function select(id: number) {
    setStatus('');
    if (id === selected) { setDetailRevision(value => value + 1); return; }
    setSelected(id);
  }

  return <section className="warranty-desk" aria-labelledby="warranty-desk-title">
    <header className="warranty-heading">
      <small>Almacén / Garantías</small>
      <h1 id="warranty-desk-title">Mesa de fábrica</h1>
      <p>El Almacén mueve la batería: recibe lo que sale de las sucursales, verifica antes de gastar el flete, transcribe el legajo de fábrica y autoriza la liberación a stock. El caso y la respuesta al cliente siguen siendo de la sucursal que lo abrió.</p>
      <div className="warranty-heading-actions">
        <button type="button" onClick={() => setRevision(value => value + 1)} disabled={busy}>
          Actualizar la mesa
        </button>
      </div>
    </header>

    {status !== '' && <p className="warranty-status" role="status">{status}</p>}

    <div className="warranty-desk-figures" role="group" aria-label="Figuras de la mesa por etapa">
      {warehouseBuckets.map(entry => {
        const state = trays[entry.phase];
        const pressed = entry.phase === bucket;
        const count = state.phase === 'error' ? '—'
          : state.phase === 'ready' || state.rows.length > 0 ? state.rows.length : '…';
        return <button type="button" key={entry.phase} aria-pressed={pressed}
          className={'warranty-desk-figure' + (entry.phase === 'resolved' ? ' hot' : '')}
          onClick={() => { setStatus(''); setBucket(entry.phase); }}>
          <span className="warranty-desk-figure-label">{entry.label}</span>
          <span className="warranty-desk-figure-value">{count}</span>
          <span className="warranty-desk-figure-note">{figureNote(entry.phase, state, today)}</span>
        </button>;
      })}
    </div>

    <div className={'warranty-layout' + (selected !== null ? ' warranty-detail-open' : '')}>
      <section className="warranty-list" aria-label={`Casos de la mesa: ${activeBucket.label}`}
        aria-busy={active.phase === 'loading'}>
        {active.phase === 'loading' && active.rows.length === 0
          && <p className="warranty-message" role="status">Consultando los casos del Almacén…</p>}
        {active.phase === 'error' && <p className="warranty-message" role="alert">{active.problem}
          <button type="button" onClick={() => setRevision(value => value + 1)}>Reintentar la mesa</button></p>}
        {active.phase === 'ready' && active.rows.length === 0 && <p className="warranty-message" role="status">
          {`${activeBucket.label}: ${activeBucket.question.toLowerCase()} No hay ningún caso en esta etapa.`}
        </p>}
        {active.rows.length > 0 && <div className="warranty-table-wrap">
          <table className="warranty-table">
            <caption>{`${activeBucket.label}: ${activeBucket.question} Del más nuevo al más viejo, de todas las sucursales. Los días de la última columna cuentan desde el alta del caso: el tiempo en la etapa que hoy tiene se lee en el detalle, que es donde el caso publica su historial.`}</caption>
            <thead><tr>
              <th scope="col">Caso</th>
              <th scope="col">Sucursal</th>
              <th scope="col">Batería</th>
              <th scope="col">Origen</th>
              <th scope="col">Etapa</th>
              <th scope="col" className="num">Días</th>
            </tr></thead>
            <tbody>{active.rows.map(row => {
              const isCurrent = row.id === selected;
              return <tr key={row.id} className={isCurrent ? 'warranty-row active' : 'warranty-row'}
                aria-current={isCurrent ? 'true' : undefined}>
                <td data-label="Caso">
                  <button type="button" className="warranty-open" onClick={() => select(row.id)}
                    aria-label={`Ver el caso ${row.case_number}`} aria-pressed={isCurrent}>{row.case_number}</button>
                  <small className="warranty-sub">{row.reason ?? row.declared_failure}</small>
                </td>
                <td data-label="Sucursal">{locationName(locations, row.branch_location_id)}</td>
                <td data-label="Batería">
                  <strong>{row.serial_number ?? `Variante ${row.variant_id}`}</strong>
                  <small className="warranty-sub">{row.serial_number === null
                    ? `${units(row.quantity ?? 0)} de la góndola`
                    : `Variante ${row.variant_id}`}</small>
                </td>
                <td data-label="Origen"><span className={`warranty-pill ${row.origin === 'stock_defect' ? 'warn' : 'quiet'}`}>
                  {warrantyOriginLabels[row.origin]}</span></td>
                <td data-label="Etapa"><span className={`warranty-pill ${warrantyPhaseTone(row.phase)}`}>
                  {warrantyRowPhaseLabel(row)}</span></td>
                <td data-label="Días" className="num warranty-days">{warrantyDaysSince(row.created_at, today)}</td>
              </tr>;
            })}</tbody>
          </table>
        </div>}
      </section>

      {selected !== null && <aside className="warranty-detail" aria-label="Detalle del caso">
        {detail !== null && detail.id === selected && detail.phase === 'loading'
          && <p className="warranty-message" role="status">Consultando el caso…</p>}
        {detail !== null && detail.id === selected && detail.phase === 'error'
          && <p className="warranty-message" role="alert">{detail.problem}
            <button type="button" onClick={() => setDetailRevision(value => value + 1)}>Reintentar caso</button>
            <button type="button" onClick={() => setSelected(null)}>Cerrar detalle</button></p>}
        {current !== null && current.id === selected && <WarehouseCaseDetail key={current.id}
          record={current} api={api} csrf={csrf} locations={locations} today={today}
          onChanged={accept} onClose={() => setSelected(null)} />}
      </aside>}
    </div>
  </section>;
}

// ---------------------------------------------------------------------------------
// The selected case: the branch pane's own facts and history, and the Almacén's acts
// ---------------------------------------------------------------------------------

interface WarehouseCaseDetailProps {
  record: WarrantyCase;
  api: ReturnType<typeof createWarrantyCasesAPI>;
  csrf: string;
  locations: readonly Location[];
  today: Date;
  onChanged: (record: WarrantyCase, message: string) => void;
  onClose: () => void;
}

function WarehouseCaseDetail({ record, api, csrf, locations, today, onChanged, onClose }: WarehouseCaseDetailProps) {
  const [arrival, setArrival] = useState({ note: '', busy: false, problem: '' });
  const [shipment, setShipment] = useState({ file: '', note: '', busy: false, problem: '' });
  const [release, setRelease] = useState({ note: '', busy: false, problem: '' });
  const inPhase = warehouseDaysInPhase(record, today);
  const noticeEntry = warrantyNotice(record);
  const noticeAge = warrantyNoticeDays(record, today);
  const lastLoan = record.loans.at(-1) ?? null;
  const custody = record.origin === 'warranty_claim'
    ? warehouseStockCrossings(record).find(entry => entry.key === 'custody')?.units ?? 0
    : 0;
  const tone = warrantyPhaseTone(record.phase);

  async function submitArrival(event: FormEvent) {
    event.preventDefault();
    if (arrival.busy) return;
    let body: ReturnType<typeof canonicalWarehouseArrival>;
    try {
      body = canonicalWarehouseArrival(arrival.note);
    } catch (invalid) {
      // A body this screen can already refuse never leaves it, and the operator reads why.
      setArrival(current => ({ ...current, problem: invalid instanceof Error
        ? invalid.message : 'No se pudo registrar la recepción.' }));
      return;
    }
    setArrival(current => ({ ...current, busy: true, problem: '' }));
    try {
      const updated = await api.advance(record.id, body, csrf);
      setArrival({ note: '', busy: false, problem: '' });
      onChanged(updated, `${updated.case_number} recibida en el Almacén: el caso espera la verificación antes de fábrica.`);
    } catch (failure) {
      setArrival(current => ({ ...current, busy: false,
        problem: failureMessage(failure, 'No se pudo registrar la recepción.') }));
    }
  }
  async function submitShipment(event: FormEvent) {
    event.preventDefault();
    if (shipment.busy) return;
    let body: ReturnType<typeof canonicalFactoryShipment>;
    try {
      body = canonicalFactoryShipment(shipment.file, shipment.note);
    } catch (invalid) {
      setShipment(current => ({ ...current, problem: invalid instanceof Error
        ? invalid.message : 'No se pudo registrar el envío a fábrica.' }));
      return;
    }
    setShipment(current => ({ ...current, busy: true, problem: '' }));
    try {
      const updated = await api.advance(record.id, body, csrf);
      setShipment({ file: '', note: '', busy: false, problem: '' });
      onChanged(updated, `${updated.case_number} en fábrica con el legajo ${body.factory_case_number}.`);
    } catch (failure) {
      setShipment(current => ({ ...current, busy: false,
        problem: failureMessage(failure, 'No se pudo registrar el envío a fábrica.') }));
    }
  }
  async function submitRelease(event: FormEvent) {
    event.preventDefault();
    if (release.busy) return;
    let body: ReturnType<typeof canonicalReleaseBody>;
    try {
      body = canonicalReleaseBody(release.note);
    } catch (invalid) {
      setRelease(current => ({ ...current, problem: invalid instanceof Error
        ? invalid.message : 'No se pudo autorizar la liberación.' }));
      return;
    }
    setRelease(current => ({ ...current, busy: true, problem: '' }));
    try {
      const updated = await api.release(record.id, () => body, csrf);
      setRelease({ note: '', busy: false, problem: '' });
      onChanged(updated, `${updated.case_number}: la unidad liberada a stock vendible quedó fuera de custodia.`);
    } catch (failure) {
      setRelease(current => ({ ...current, busy: false,
        problem: failureMessage(failure, 'No se pudo autorizar la liberación.') }));
    }
  }

  return <>
    <div className="warranty-detail-top">
      <span className="warranty-doc">{record.case_number}</span>
      <span className={`warranty-pill ${tone}`}>{warrantyPhaseShortLabel(record)}</span>
      <button type="button" className="warranty-close" onClick={onClose} aria-label="Cerrar el detalle del caso">Cerrar</button>
    </div>
    <h2>{locationName(locations, record.branch_location_id)}</h2>
    <p className="warranty-client-line">{record.origin === 'warranty_claim'
      ? 'Reclamo con la garantía de una venta: el cliente y su respuesta son de la sucursal.'
      : `Hallazgo en góndola: ${warrantyUnitsWrittenOff(record.quantity ?? 0)} del stock de la sucursal.`}</p>

    <dl className="warranty-facts">
      <div><dt>{record.origin === 'warranty_claim' ? 'Serial reclamado' : 'Unidades de la góndola'}</dt>
        <dd>{record.origin === 'warranty_claim'
          ? <span className="warranty-doc">{record.serial_number}</span>
          : <span>{units(record.quantity ?? 0)}</span>}</dd></div>
      <div><dt>Batería</dt><dd>{`Variante ${record.variant_id}`}</dd></div>
      <div><dt>Sucursal</dt><dd>{locationName(locations, record.branch_location_id)}</dd></div>
      <div><dt>En esta etapa</dt><dd>{inPhase === null ? 'Sin tramo registrado' : `Hace ${days(inPhase)}`}</dd></div>
      {record.warranty_number !== null && <div><dt>Venta</dt><dd>{`Garantía ${record.warranty_number}`}</dd></div>}
      {record.origin === 'stock_defect' && <div><dt>Motivo de la baja</dt><dd>{record.reason}</dd></div>}
      <div><dt>Qué falló</dt><dd>{record.declared_failure}</dd></div>
      {record.origin === 'warranty_claim' && <div><dt>Préstamo</dt><dd>{lastLoan === null
        ? 'Sin usada entregada'
        : `${lastLoan.model} · ${units(lastLoan.quantity)} · ${locationName(locations, lastLoan.source_location_id)}`}</dd></div>}
      {record.verdict !== null && <div><dt>Veredicto</dt><dd>{warrantyVerdictLabels[record.verdict]}</dd></div>}
      {record.reported_destination !== null && <div><dt>Unidad reclamada</dt>
        <dd>{warrantyDestinationLabels[record.reported_destination]}</dd></div>}
      {record.loan_destination !== null && <div><dt>Usada prestada</dt>
        <dd>{warrantyDestinationLabels[record.loan_destination]}</dd></div>}
      {record.stock_destination !== null && <div><dt>Stock de la góndola</dt>
        <dd>{warrantyDestinationLabels[record.stock_destination]}</dd></div>}
    </dl>

    {custody > 0 && <div className="warranty-custody">
      <strong>{`En custodia por garantía: ${units(custody)}`}</strong>
      <p>{warehouseReleaseSubjectKind(record) === 'stock'
        ? 'La unidad reparada no es stock vendible y no espera a ningún cliente: va al stock de la sucursal. Sale de custodia cuando el Almacén autoriza la liberación, que es el acto que cierra el caso.'
        : 'La unidad reparada no es stock vendible mientras espera al cliente: el punto de venta no puede venderla y la rendición la publica en una línea aparte. Sale de custodia cuando el Almacén la libera o cuando la sucursal entrega el canje.'}</p>
    </div>}

    <h3 className="warranty-section-title">Historial del caso</h3>
    <ol className="warranty-timeline">
      {record.events.map(entry => <li key={entry.ordinal} data-kind={entry.kind}>
        <div className="warranty-timeline-head">
          <strong>{warrantyEventLabel(record, entry)}</strong>
          <time dateTime={entry.recorded_at}>{new Intl.DateTimeFormat('es-BO',
            { timeZone: 'America/La_Paz', day: '2-digit', month: '2-digit', year: 'numeric' })
            .format(new Date(entry.recorded_at))}</time>
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

    <h3 className="warranty-section-title">Stock, custodia y liberación</h3>
    <ul className="warranty-crossings">
      {warehouseStockCrossings(record).map(crossing => <li key={crossing.key} data-state={crossing.state}>
        <div className="warranty-crossing-head">
          <strong>{crossing.title}</strong>
          <span className={`warranty-pill ${crossingStateTones[crossing.state]}`}>
            {crossingStateLabels[crossing.state]}
          </span>
          {crossing.units > 0 && <span className="warranty-crossing-units">{units(crossing.units)}</span>}
        </div>
        <p>{crossing.note}</p>
      </li>)}
    </ul>

    <h3 className="warranty-section-title">{`Usadas entregadas por la sucursal (${record.loans.length})`}</h3>
    {record.loans.length === 0
      ? <p className="warranty-note">{record.origin === 'warranty_claim'
        ? 'El caso no entregó ninguna usada al cliente.'
        : 'El hallazgo en góndola no presta ninguna batería: no tiene cliente.'}</p>
      : <div className="warranty-table-wrap">
        <table className="warranty-loans">
          <caption>Las usadas del caso, en el orden en que salieron del mostrador de la sucursal</caption>
          <thead><tr>
            <th scope="col">#</th><th scope="col">Modelo</th><th scope="col" className="num">Cantidad</th>
            <th scope="col">Sale de</th><th scope="col">Entregada</th><th scope="col">Desenlace</th>
          </tr></thead>
          <tbody>{record.loans.map(loan => <tr key={loan.ordinal}>
            <td>{loan.ordinal}</td>
            <td><strong>{loan.model}</strong></td>
            <td className="num">{loan.quantity}</td>
            <td>{locationName(locations, loan.source_location_id)}</td>
            <td><TransferDate value={loan.given_at} /></td>
            <td><span className={`warranty-pill ${loan.fate === 'open' ? 'wine' : 'quiet'}`}>
              {warrantyLoanFateLabels[loan.fate]}</span></td>
          </tr>)}</tbody>
        </table>
      </div>}

    <h3 className="warranty-section-title">Actos del Almacén</h3>
    <div className="warranty-actions">
      {warehouseArrivalAvailable(record) && <form className="warranty-action" onSubmit={submitArrival}>
        <h4>Recibir en el Almacén</h4>
        <p className="warranty-note">La sucursal registró la salida; acá entra al Almacén. Después hay que verificarla antes de mandarla a fábrica: el envío no es automático.</p>
        <label htmlFor={`arrival-note-${record.id}`}>Qué llegó al Almacén</label>
        <input id={`arrival-note-${record.id}`} value={arrival.note} maxLength={500} required
          onChange={event => setArrival(current => ({ ...current, note: event.target.value }))} />
        <button type="submit" className="primary" disabled={arrival.busy}>Registrar la recepción</button>
        {arrival.problem !== '' && <p className="warranty-problem" role="alert">{arrival.problem}</p>}
      </form>}

      {warehouseShipmentAvailable(record) && <form className="warranty-action" onSubmit={submitShipment}>
        <h4>Enviar a fábrica</h4>
        <p className="warranty-note">El Almacén verifica la unidad y transcribe a mano el número de legajo que la fábrica asigna. El legajo viaja en este tramo y en ningún otro.</p>
        <label htmlFor={`shipment-file-${record.id}`}>Número de legajo de fábrica</label>
        <input id={`shipment-file-${record.id}`} value={shipment.file} maxLength={200} required
          onChange={event => setShipment(current => ({ ...current, file: event.target.value }))} />
        <label htmlFor={`shipment-note-${record.id}`}>Motivo del envío</label>
        <input id={`shipment-note-${record.id}`} value={shipment.note} maxLength={500} required
          onChange={event => setShipment(current => ({ ...current, note: event.target.value }))} />
        <button type="submit" className="primary" disabled={shipment.busy}>Enviar a fábrica</button>
        {shipment.problem !== '' && <p className="warranty-problem" role="alert">{shipment.problem}</p>}
      </form>}

      {warehouseVerdictAvailable(record) && <VerdictForm record={record} api={api} csrf={csrf}
        onChanged={onChanged} />}

      {record.origin === 'warranty_claim' && record.phase === 'resolved' && warehouseReleaseAvailable(record)
        && <form className="warranty-action" onSubmit={submitRelease}>
          <h4>Autorizar la liberación</h4>
          <p className="warranty-note">{warehouseReleaseSubjectKind(record) === 'stock'
            ? 'La unidad vuelve al stock vendible de la sucursal y el caso cierra con este acto, con actor y motivo, y una sola vez. El aviso al cliente ya está registrado por la sucursal.'
            : 'La unidad que el caso tiene en custodia pasa al stock vendible de la sucursal, con actor y motivo, y una sola vez. El aviso al cliente ya está registrado por la sucursal.'}</p>
          <label htmlFor={`release-note-${record.id}`}>Motivo de la liberación</label>
          <textarea id={`release-note-${record.id}`} value={release.note} maxLength={500} required rows={2}
            onChange={event => setRelease(current => ({ ...current, note: event.target.value }))} />
          <button type="submit" className="primary" disabled={release.busy}>Autorizar la liberación a stock</button>
          {release.problem !== '' && <p className="warranty-problem" role="alert">{release.problem}</p>}
        </form>}

      {!warehouseArrivalAvailable(record) && !warehouseShipmentAvailable(record)
        && !warehouseVerdictAvailable(record) && !warehouseReleaseAvailable(record)
        && <p className="warranty-note">
          {record.phase === 'closed'
            ? 'El caso está cerrado: no admite más actos del Almacén.'
            : warehouseReleaseBlocked(record)}
        </p>}
    </div>
    <p className="warranty-note warranty-desk-boundary">La entrega al cliente y el cierre del caso son de la sucursal, salvo el caso cuya unidad va al stock vendible: ese cierra con la liberación del Almacén. El Almacén registra los tramos que mueve la batería, el veredicto y la liberación, y nada más.</p>
  </>;
}

/** The verdict of the gate and of the factory: one vocabulary, and the units of each door (S10, S11). */
function VerdictForm({ record, api, csrf, onChanged }: {
  record: WarrantyCase;
  api: ReturnType<typeof createWarrantyCasesAPI>;
  csrf: string;
  onChanged: (record: WarrantyCase, message: string) => void;
}) {
  const allowed = warehouseVerdicts(record.phase);
  const [verdict, setVerdict] = useState<WarrantyVerdict | ''>(allowed.length === 1 ? allowed[0] : '');
  const [reported, setReported] = useState<WarrantyDestination | ''>('');
  const [loan, setLoan] = useState<WarrantyDestination | ''>('');
  const [note, setNote] = useState('');
  const [state, setState] = useState({ busy: false, problem: '' });
  const reportedOptions = verdict === '' ? [] : warehouseReportedDestinations(record.origin, verdict);
  const loanOptions = verdict === '' ? [] : warehouseLoanDestinations(verdict);
  const reportedValue = reportedOptions.includes(reported as WarrantyDestination)
    ? reported : reportedOptions.length === 1 ? reportedOptions[0] : '';
  const loanValue = loanOptions.includes(loan as WarrantyDestination)
    ? loan : loanOptions.length === 1 ? loanOptions[0] : '';
  const gate = record.phase === 'at_warehouse';
  const ready = verdict !== '' && reportedValue !== '' && note.trim() !== ''
    && (record.origin === 'stock_defect' || loanValue !== '');

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (state.busy || verdict === '') return;
    let body: ReturnType<typeof canonicalClaimResolutionBody> | ReturnType<typeof canonicalDefectResolutionBody>;
    try {
      body = record.origin === 'warranty_claim'
        ? canonicalClaimResolutionBody(verdict, reportedValue as WarrantyDestination,
          (loanValue === '' ? null : loanValue) as WarrantyDestination | null, note)
        : canonicalDefectResolutionBody(verdict, reportedValue as WarrantyDestination, note);
    } catch (invalid) {
      // The motive and the pair of destinations are judged here, before anything is sent.
      setState({ busy: false, problem: invalid instanceof Error
        ? invalid.message : 'No se pudo registrar el veredicto.' });
      return;
    }
    setState({ busy: true, problem: '' });
    try {
      const updated = await api.resolution(record.id, body, csrf);
      setNote('');
      setState({ busy: false, problem: '' });
      onChanged(updated, `${updated.case_number}: veredicto ${warrantyVerdictLabels[verdict].toLowerCase()}.`);
    } catch (failure) {
      setState({ busy: false, problem: failureMessage(failure, 'No se pudo registrar el veredicto.') });
    }
  }

  return <form className="warranty-action" onSubmit={submit}>
    <h4>{gate ? 'Rechazar antes de fábrica' : 'Registrar el veredicto'}</h4>
    <p className="warranty-note">{gate
      ? 'En la puerta del Almacén el único veredicto posible es el rechazo, con su motivo: la unidad vuelve a la sucursal sin haber gastado el flete a fábrica.'
      : 'El veredicto de la fábrica y el destino de cada unidad son campos distintos: la misma resolución mueve la unidad reclamada y, en un reclamo, también la usada prestada.'}</p>
    <label htmlFor={`verdict-${record.id}`}>Veredicto</label>
    <select id={`verdict-${record.id}`} value={verdict} onChange={event => {
      const next = event.target.value;
      if (allowed.includes(next as WarrantyVerdict)) {
        setVerdict(next as WarrantyVerdict);
        setReported('');
        setLoan('');
      }
    }}>
      {verdict === '' && <option value="">Elegí el veredicto</option>}
      {allowed.map(value => <option key={value} value={value}>{warrantyVerdictLabels[value]}</option>)}
    </select>
    {verdict !== '' && <>
      <label htmlFor={`verdict-reported-${record.id}`}>
        {record.origin === 'warranty_claim' ? 'Unidad reclamada' : 'Unidades de la góndola'}
      </label>
      <select id={`verdict-reported-${record.id}`} value={reportedValue}
        onChange={event => setReported(event.target.value as WarrantyDestination)}>
        {reportedValue === '' && <option value="">Elegí el destino</option>}
        {reportedOptions.map(value => <option key={value} value={value}>{warrantyDestinationLabels[value]}</option>)}
      </select>
      {record.origin === 'warranty_claim' && <>
        <label htmlFor={`verdict-loan-${record.id}`}>Usada prestada</label>
        <select id={`verdict-loan-${record.id}`} value={loanValue}
          onChange={event => setLoan(event.target.value as WarrantyDestination)}>
          {loanValue === '' && <option value="">Elegí el destino</option>}
          {loanOptions.map(value => <option key={value} value={value}>{warrantyDestinationLabels[value]}</option>)}
        </select>
      </>}
    </>}
    <label htmlFor={`verdict-note-${record.id}`}>Motivo del veredicto</label>
    <textarea id={`verdict-note-${record.id}`} value={note} maxLength={500} required rows={2}
      onChange={event => setNote(event.target.value)} />
    <button type="submit" className="primary" disabled={state.busy || !ready}>Registrar veredicto</button>
    {verdict !== '' && !ready && <p className="warranty-reason">
      Falta el destino de cada unidad y el motivo: el veredicto se registra una sola vez y es definitivo.
    </p>}
    {state.problem !== '' && <p className="warranty-problem" role="alert">{state.problem}</p>}
  </form>;
}
