import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { closingDifferenceName, closingMaterialQuantityText, closingMoneyText } from './closingModel';
import TransferDate from './shared/TransferDate';
import {
  createMetricsAPI, metricsErrorMessages, metricsPeriodToken, MetricsAPIError,
  metricsUnavailable, type MetricsAnswer, type MetricsFundToday, type MetricsMaterials,
  type MetricsModel, type MetricsPeriod, type MetricsPeriodKind, type MetricsSource,
  type MetricsToday,
} from './metricsAPI';

export interface MetricsProps {
  /** The branch of the session: the only branch this contract publishes. */
  branch: string;
  fetcher?: typeof globalThis.fetch;
}

/** The period the screen opens on: the window since the last cut, when the branch has one (S10). */
const metricsDefaultToken = 'current';

/** The three states of one read, in the order the screen travels them. */
interface MetricsState {
  readonly phase: 'loading' | 'ready' | 'error';
  readonly answer: MetricsAnswer | null;
  readonly problem: string;
  /** The selector stays while a period is read and dies with a refused answer. */
  readonly periods: readonly MetricsPeriod[];
}

const initialMetricsState: MetricsState = Object.freeze({
  phase: 'loading', answer: null, problem: '', periods: [],
});

const money = (cents: bigint): string => closingMoneyText(cents);
/** A quantity is written by the settlement's own formatter: `78` units and `214,500` kilos. */
const units = (value: number): string => closingMaterialQuantityText('unit', BigInt(value) * 1000n);
const kilos = (value: bigint): string => closingMaterialQuantityText('kg', value);

/** Shown where a figure the contract does not state would otherwise be read as a zero (S8). */
const metricsNotCounted = 'Sin contar';
const metricsNoSheet =
  'El acumulado no tiene planilla: cada rendición se llevó la suya.';

/** The share of one amount in the period, in tenths: `43,0 %`. `—` when the period collected nothing. */
function moneyShareText(part: bigint, whole: bigint): string {
  if (whole <= 0n) return '—';
  const tenths = (part * 2000n + whole) / (whole * 2n);
  return `${tenths / 10n},${tenths % 10n} %`;
}

/** The length of one track of the collection mix, clamped to the strip that holds it. */
function mixWidth(part: bigint, whole: bigint): string {
  if (whole <= 0n) return '0%';
  const width = Math.min(100, Math.max(0, Number((part * 1000n) / whole) / 10));
  return `${width}%`;
}

/** The origin of the numbers, under the title, always in words (S6). */
function provenance(source: MetricsSource, period: MetricsPeriod): ReactNode {
  // The window is not a settlement: it starts at the last closed cut and moves with every sale.
  if (period.kind === 'current') {
    return <>Desde el corte del <TransferDate value={period.from ?? ''} /> · se mueve con cada venta</>;
  }
  if (source === 'settlement') {
    return <>Números al cierre del <TransferDate value={period.to} /></>;
  }
  if (source === 'live') return 'En vivo, se mueve con cada venta';
  return 'Todo el historial de la sucursal';
}

/** One of the four figures of the period: its name, its reading and the line that qualifies it. */
function Figure({ title, value, note }: { title: string; value: ReactNode; note: string }) {
  return <div className="metrics-figure">
    <dt>{title}</dt>
    <dd className="metrics-figure-value">{value}</dd>
    <dd className="metrics-figure-note">{note}</dd>
  </div>;
}

/** What the drawer of the period states: the count when there is one, the expectation when there is not. */
function cashReading(
  cash: MetricsAnswer['cash'], kind: MetricsPeriodKind,
): { value: ReactNode; note: string } {
  if (cash === null) {
    return { value: 'Sin caja', note: kind === 'current'
      ? 'se cuenta al rendir' : 'el acumulado no tiene caja' };
  }
  const difference = cash.difference_cents;
  if (cash.counted_cents === null) {
    return { value: money(cash.expected_cents), note: 'todavía no se contó' };
  }
  return {
    value: money(cash.counted_cents),
    note: difference === null ? 'contada' : `contada · ${closingDifferenceName(difference).toLowerCase()}`,
  };
}

/** What the warehouse leaves in the envelope: the next opening, or the words of its absence. */
function fundReading(
  fund: MetricsAnswer['fund'], kind: MetricsPeriodKind,
): { value: ReactNode; note: string } {
  if (fund === null) {
    return { value: 'Sin fondo', note: kind === 'current'
      ? 'lo declara el Almacén al rendir' : 'el acumulado no tiene fondo' };
  }
  if (fund.replacement_cents === null) {
    return { value: 'Sin declarar', note: 'el Almacén todavía no lo declaró' };
  }
  return { value: money(fund.replacement_cents), note: 'recambio del Almacén' };
}

/** The delivery of the period: the counted units and kilos, never a zero nobody counted. */
function materialReading(
  materials: MetricsMaterials | null, kind: MetricsPeriodKind,
): { value: ReactNode; note: string } {
  if (materials === null) {
    return {
      value: 'Sin planilla',
      note: kind === 'current' ? 'se entrega al rendir'
        : kind === 'all' ? 'el acumulado no tiene planilla' : 'este período no tiene planilla',
    };
  }
  const note = 'baterías usadas y chatarra';
  if (materials.used_delivered_units === null || materials.scrap_delivered_milli === null) {
    return { value: 'Sin contar', note };
  }
  return {
    value: `${units(materials.used_delivered_units)} u · ${kilos(materials.scrap_delivered_milli)} kg`,
    note,
  };
}

/**
 * The period in four figures: the money it collected, the drawer it handed over, the envelope that is
 * left and the material it delivered (S3). Each figure carries one line of its own, and the absence of
 * a box or of a count is stated in words instead of a zero (S8).
 */
function PeriodFigures({ answer }: { answer: MetricsAnswer }) {
  const { sales } = answer;
  const cash = cashReading(answer.cash, answer.period.kind);
  const fund = fundReading(answer.fund, answer.period.kind);
  const materials = materialReading(answer.materials, answer.period.kind);
  return <section className="metrics-figures" aria-label="Lo que dejó el período">
    <dl>
      <Figure title="Plata del período" value={money(sales.total_cents)}
        note={sales.sales === 1 ? '1 venta' : `${sales.sales} ventas`} />
      <Figure title="Caja entregada" value={cash.value} note={cash.note} />
      <Figure title="Fondo que queda" value={fund.value} note={fund.note} />
      <Figure title="Material entregado" value={materials.value} note={materials.note} />
    </dl>
  </section>;
}

/** What the window bought, in the units of each kind: a zero is not a kind the branch bought. */
function boughtText(usedUnits: number, scrapMilli: bigint): string {
  const parts: string[] = [];
  if (usedUnits !== 0) parts.push(`${usedUnits} u`);
  if (scrapMilli !== 0n) parts.push(`${kilos(scrapMilli)} kg`);
  return parts.length === 0 ? 'Sin unidades ni kilos' : parts.join(' · ');
}

/**
 * Today in one line: the drawer and the envelope as they stand, and the two readings of the live
 * window -- what the branch sold since the last cut and the commission it is earning, never what it
 * collected (S12, S18, S19). The absence of a rate or of a sale is stated in words (S20).
 */
function TodayLine({ today, fundToday }: { today: MetricsToday; fundToday: MetricsFundToday }) {
  return <section className="metrics-today-line" aria-labelledby="metrics-today-title">
    <h2 id="metrics-today-title">Hoy</h2>
    {/* A branch without a closed settlement has no cut: its window is everything it ever did. */}
    <p className="metrics-today-since">{today.since === null
      ? 'desde el comienzo de la sucursal'
      : <>desde el corte del <TransferDate value={today.since} /></>}</p>
    <dl>
      <div><dt>Efectivo en el cajón</dt><dd>{money(today.expected_cents)}</dd></div>
      <div><dt>Fondo de compras disponible</dt><dd>{money(fundToday.balance_cents)}</dd></div>
      <div><dt>Vendido desde el corte</dt><dd>{today.sold_cents === 0n
        ? 'Sin ventas' : money(today.sold_cents)}</dd></div>
      <div><dt>Comisión devengada</dt><dd>{today.rate_percent === null
        ? 'Sin tasa'
        : today.commission_cents > 0n
          ? money(today.commission_cents)
          : 'Sin comisión todavía'}</dd></div>
      {/* The purchases of the window, because the envelope is what pays them: a branch that bought a
          used battery today reads it here instead of going back to Compras to check it landed (S15). */}
      <div><dt>Compras desde el corte</dt><dd>{fundToday.documents === 0
        ? 'Sin compras'
        : fundToday.documents === 1 ? '1 compra' : `${fundToday.documents} compras`}
        {fundToday.documents > 0 && <span className="metrics-today-note">
          {boughtText(fundToday.used_units, fundToday.scrap_milli)}
        </span>}
      </dd></div>
    </dl>
  </section>;
}

/** The collection of the period by method: its amount and its share, never the total again. */
function CollectionMix({ answer }: { answer: MetricsAnswer }) {
  const { sales } = answer;
  const methods: readonly (readonly [string, bigint])[] = [
    ['Efectivo', sales.cash_cents], ['Tarjeta', sales.card_cents],
    ['Transferencia', sales.transfer_cents], ['QR', sales.qr_cents],
  ];
  return <section aria-labelledby="metrics-mix-title">
    <h2 id="metrics-mix-title">Cómo se cobró</h2>
    <ul className="metrics-mix">
      {methods.map(([label, cents]) => <li key={label}>
        <span>{label}</span>
        <span className="metrics-mix-track" aria-hidden="true">
          <span className="metrics-mix-fill" style={{ width: mixWidth(cents, sales.total_cents) }} />
        </span>
        <span className="metrics-mix-amount">{money(cents)}</span>
        <span className="metrics-mix-pct">{moneyShareText(cents, sales.total_cents)}</span>
      </li>)}
    </ul>
  </section>;
}

/**
 * What the period sold, by kind of product: the battery lines, the other products the client derives
 * from the total and the total that sums them (S1-S3). An amount the period never collected is said in
 * words -- `Sin ventas`, never `Bs 0,00` -- and the total is stated once, as the sum of the two readings
 * above it, so no figure of this block is repeated in prose (S4, S5).
 */
function SoldByKind({ answer }: { answer: MetricsAnswer }) {
  const { sales } = answer;
  const reading = (cents: bigint): ReactNode => cents === 0n ? 'Sin ventas' : money(cents);
  return <section className="metrics-sold" aria-labelledby="metrics-sold-title">
    <h2 id="metrics-sold-title">Qué se vendió</h2>
    <dl>
      <div><dt>Baterías</dt><dd>{reading(sales.batteries_cents)}</dd></div>
      <div><dt>Otros productos</dt><dd>{reading(sales.other_cents)}</dd></div>
      <div className="metrics-sold-total"><dt>Total</dt><dd>{reading(sales.total_cents)}</dd></div>
    </dl>
  </section>;
}

/**
 * The ranking of the period: units first, the money of each row as the secondary reading (S4). A row of
 * either catalogue kind is listed by its own identity, so a product is its name and carries no capacity
 * suffix (S6). The volume the rows take is one line under the table.
 */
function Ranking({ models, total }: { models: readonly MetricsModel[]; total: number }) {
  const sum = models.reduce((units, model) => units + model.units, 0);
  return <section aria-labelledby="metrics-ranking-title">
    <h2 id="metrics-ranking-title">Más vendidas</h2>
    {models.length === 0
      ? <p className="metrics-empty">El período no vendió nada: no hay ranking que mostrar.</p>
      : <>
        <table className="metrics-table">
          <thead>
            <tr><th scope="col" className="rank" aria-label="Puesto" /><th scope="col">Modelo</th>
              <th scope="col" className="num">Unidades</th>
              <th scope="col" className="num">Plata</th></tr>
          </thead>
          <tbody>
            {models.map((model, index) => <tr key={model.catalog_entry_id}>
              <td className="rank">{index + 1}</td>
              <td className="model">{'capacity_ah' in model
                ? <>{model.brand} {model.model}<small>{model.capacity_ah} Ah</small></>
                : model.name}</td>
              <td className="num">{model.units}</td>
              <td className="num">{money(model.money_cents)}</td>
            </tr>)}
          </tbody>
        </table>
        <p className="metrics-hint">{`${sum} de ${total} unidades`}</p>
      </>}
  </section>;
}

/** The scrap the branch delivered, by material and in total, as one strip under the two columns. */
function ScrapStrip({ materials, fundToday, kind }: {
  materials: MetricsMaterials | null; fundToday: MetricsFundToday; kind: MetricsPeriodKind;
}) {
  // The strip states what the period BOUGHT, never what it delivered: the delivery is counted at the
  // settlement, and the branch reads its purchases here.
  const window = kind === 'current';
  return <section className="metrics-scrap" aria-labelledby="metrics-scrap-title">
    <h2 id="metrics-scrap-title">Chatarra comprada</h2>
    {materials !== null
      ? (materials.materials.length === 0
        ? <p className="metrics-empty">El período no compró chatarra.</p>
        : <dl>
          {materials.materials.map(line => <div key={line.material_id}>
            <dt>{line.material}</dt>
            <dd>{`${kilos(line.bought_milli)} kg`}</dd>
          </div>)}
          {materials.materials.length > 1 && <div className="metrics-scrap-total">
            <dt>Total</dt>
            <dd>{`${kilos(materials.scrap_milli)} kg`}</dd>
          </div>}
        </dl>)
      // A window has no sheet: it states the kilos the branch bought since the cut, and the breakdown
      // by material arrives with the settlement that counts it.
      : window
        ? <dl>
          <div>
            <dt>Comprada desde el corte</dt>
            <dd>{fundToday.documents === 0
              ? 'Sin compras' : `${kilos(fundToday.scrap_milli)} kg`}</dd>
          </div>
        </dl>
        : <p className="metrics-empty">{kind === 'all'
          ? metricsNoSheet : 'Sin planilla de materiales en este período.'}</p>}
  </section>;
}

/**
 * The metrics of the branch cut by settlement period (S1, S2). Everything a settlement freezes is
 * read from the closing — never recalculated — and the period is chosen with the same control Compras
 * uses, so the two screens offer the same periods in the same order. A period the server could not
 * have written is refused whole with its own words (S8).
 *
 * The screen reads as four figures, one line of today, the collection of the period, the ranking and
 * the scrap the branch delivered; the detail of each account stays in Rendición de cuentas. `branch`
 * remains part of the contract the shell passes — the header of the app names the branch, so the
 * screen does not repeat it.
 */
export default function Metrics({ fetcher = globalThis.fetch }: MetricsProps) {
  const api = useMemo(() => createMetricsAPI(fetcher), [fetcher]);
  // The whole history is the only default this contract has, and the selector names it from the
  // first answer on: no period is ever guessed (S2, S6).
  // The screen opens on the window since the last cut, the only period that moves with the branch
  // today; a branch that never closed a settlement has none, and falls back to its whole history.
  const [periodToken, setPeriodToken] = useState(metricsDefaultToken);
  // Read inside the read's error path only, so the fallback below cannot re-trigger the read.
  const picked = useRef(false);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<MetricsState>(initialMetricsState);

  useEffect(() => {
    const controller = new AbortController();
    // The selector stays while a period is read; every figure waits for the same answer.
    setState(current => ({ phase: 'loading', answer: null, problem: '',
      periods: current.periods }));
    void (async () => {
      try {
        const answer = await api.read(periodToken, controller.signal);
        if (!controller.signal.aborted) {
          setState({ phase: 'ready', answer, problem: '', periods: answer.periods });
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        const code = error instanceof MetricsAPIError ? error.code : 'invalid_response';
        if (code === 'aborted') return;
        // The window is the default, not an error: a branch without a closed settlement has none, and
        // it opens on the whole history the way it always did. Only a period a human picked is refused
        // with words, and the fallback never overrides that choice.
        if (!picked.current && periodToken === metricsDefaultToken
          && (code === 'not_found' || code === 'invalid_request')) {
          setPeriodToken('all');
          return;
        }
        // An answer this client cannot trust is refused whole: no selector, no figure, no panel.
        setState({ phase: 'error', answer: null, periods: [],
          problem: metricsErrorMessages[code] ?? metricsUnavailable });
      }
    })();
    return () => controller.abort();
  }, [api, periodToken, revision]);

  const answer = state.answer;
  const periods = state.periods;

  return <section className="metrics-workspace" aria-labelledby="metrics-title">
    <div className="metrics-topline">
      <div className="metrics-heading">
        <h1 id="metrics-title">Métricas de la sucursal</h1>
        {/* Where the numbers come from, in words, under the title: no pill, no dot (S6). */}
        {answer !== null && <p className="metrics-stamp">
          {provenance(answer.source, answer.period)}
        </p>}
      </div>

      {periods.length > 0 && <div className="metrics-period-field">
        <label htmlFor="metrics-period">Período</label>
        <select id="metrics-period" value={periodToken} disabled={state.phase === 'loading'}
          onChange={event => {
            const chosen = event.target.value;
            // Only a period this server published can be asked for.
            if (!periods.some(period => metricsPeriodToken(period) === chosen)) return;
            picked.current = true;
            setPeriodToken(chosen);
          }}>
          {periods.map(period => <option key={metricsPeriodToken(period)}
            value={metricsPeriodToken(period)}>{period.label}</option>)}
        </select>
      </div>}
    </div>

    {answer === null && state.problem === ''
      && <p className="metrics-note" role="status">Consultando las métricas de la sucursal…</p>}

    {state.problem !== '' && <p className="metrics-problem" role="alert">{state.problem}
      <button type="button" onClick={() => setRevision(value => value + 1)}>Reintentar</button>
    </p>}

    {answer !== null && <>
      <PeriodFigures answer={answer} />
      <TodayLine today={answer.today} fundToday={answer.fund_today} />
      <div className="metrics-bottom">
        {/* The left column reads the money of the period: how it was collected and what was sold (S6). */}
        <div className="metrics-bottom-left">
          <CollectionMix answer={answer} />
          <SoldByKind answer={answer} />
        </div>
        <Ranking models={answer.top_models} total={answer.sales.units} />
      </div>
      <ScrapStrip materials={answer.materials} fundToday={answer.fund_today}
          kind={answer.period.kind} />
    </>}
  </section>;
}
