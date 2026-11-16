import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  closingDifferenceName, closingMaterialQuantityText, closingMoneyText, closingSignedText,
  closingStatusLabels,
} from './closingModel';
import TransferDate from './shared/TransferDate';
import {
  createMetricsAPI, metricsErrorMessages, metricsPeriodToken, MetricsAPIError,
  metricsUnavailable, type MetricsAnswer, type MetricsCash, type MetricsFund,
  type MetricsMaterials, type MetricsModel, type MetricsMovementKind, type MetricsPeriod,
  type MetricsSource, type MetricsToday,
} from './metricsAPI';

export interface MetricsProps {
  /** The branch of the session: the only branch this contract publishes. */
  branch: string;
  fetcher?: typeof globalThis.fetch;
}

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
const metricsNoDrawer = 'El acumulado no tiene caja: la caja se cierra en cada rendición.';
const metricsNoSheet =
  'El acumulado no tiene planilla de materiales: cada rendición se llevó la suya.';

/** The average ticket of the period, computed in cents: the total divided by its sales. */
function ticketCents(total: bigint, sales: number): bigint | null {
  if (sales <= 0) return null;
  const divisor = BigInt(sales);
  // Rounded half up, so the canonical two decimals never read a cent below the period.
  return (total * 2n + divisor) / (divisor * 2n);
}

/** The share of one amount in the period, in tenths: `43,0 %`. `—` when the period collected nothing. */
function moneyShareText(part: bigint, whole: bigint): string {
  if (whole <= 0n) return '—';
  const tenths = (part * 2000n + whole) / (whole * 2n);
  return `${tenths / 10n},${tenths % 10n} %`;
}

/** The share of the period's units a model took, as the bar and the number beside it read it. */
function unitsShare(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.min(100, Math.round((part * 100) / whole));
}

/** The days the branch has been inside its live period, derived from the period's own opening. */
function daysWithoutSettling(from: string, now: number): number {
  const opened = Date.parse(from);
  if (!Number.isFinite(opened) || now <= opened) return 0;
  return Math.floor((now - opened) / 86_400_000);
}

/** One period of the selector in words: whether it is closed and where it was cut. */
function periodNote(period: MetricsPeriod): ReactNode {
  if (period.kind === 'all') {
    return `${period.label} · sin corte: todas las ventas registradas en la sucursal. Los números son los del acumulado.`;
  }
  const state = (period.kind === 'settlement' ? closingStatusLabels.closed
    : closingStatusLabels.open).toLowerCase();
  return <>
    {`${period.label} · ${state} · `}
    {period.kind === 'settlement' ? 'corte ' : 'corte previsto '}
    <TransferDate value={period.to} />
    {', período desde '}
    <TransferDate value={period.from} />
    {period.kind === 'settlement'
      ? '. Nada de este período se recalcula: se lee del cierre.'
      : '. Los números se derivan al leer y se mueven con cada venta.'}
  </>;
}

/** The origin of the numbers, beside the control, always in words (S6). */
function provenance(source: MetricsSource, period: MetricsPeriod): ReactNode {
  if (source === 'settlement') {
    return <>Números al cierre del <TransferDate value={period.to} /></>;
  }
  if (source === 'live') return 'En vivo, se mueve con cada venta';
  return 'Todo el historial de la sucursal';
}

/** One cell of the band; the sub-line says what the number is, never what it might have been. */
function BandCell({ title, value, note }: {
  title: string; value: ReactNode; note: string;
}) {
  return <div className="metrics-band-cell">
    <dt>{title}</dt>
    <dd>{value}<span className="metrics-band-sub">{note}</span></dd>
  </div>;
}

/** What the drawer of a period holds, when the period has one at all. */
function CashPanel({ cash }: { cash: MetricsCash }) {
  const difference = cash.difference_cents;
  return <section className="metrics-panel" aria-labelledby="metrics-cash-title">
    <h2 id="metrics-cash-title" className="metrics-panel-title">Caja operativa</h2>
    <table className="metrics-table">
      <caption className="sr-only">Caja operativa del período</caption>
      <tbody>
        <tr><td>Apertura declarada</td><td className="num">{money(cash.opening_cents)}</td></tr>
        <tr><td>Ventas en efectivo</td><td className="num">{closingSignedText(cash.sales_cents)}</td></tr>
        <tr><td>Gastos del período</td><td className="num">{closingSignedText(-cash.expenses_cents)}</td></tr>
        <tr className="total"><td>Debería haber</td><td className="num">{money(cash.expected_cents)}</td></tr>
        <tr><td>Se contó</td><td className="num">{cash.counted_cents === null
          ? metricsNotCounted : money(cash.counted_cents)}</td></tr>
        <tr><td>Diferencia</td><td className="num">{difference === null ? metricsNotCounted : <>
          {closingSignedText(difference)}
          <span className="metrics-difference-name">{closingDifferenceName(difference)}</span>
        </>}</td></tr>
      </tbody>
    </table>
  </section>;
}

/** The words of every kind the branch's cash ledger writes. */
const movementKindLabels: Record<MetricsMovementKind, string> = {
  aporte: 'Aporte', recaudacion: 'Recaudación', gasto: 'Gasto',
};

/**
 * The cash of today: the drawer of the branch as it stands, rendered whatever period is on screen and
 * above the accounts of the period, so a branch that has only closed settlements still reads it
 * (S12). The expectation is the settlement's own identity — what the last cut left in the drawer plus
 * the cash the sales collected after it minus the expenses paid out of it after it — and the movements
 * of the ledger are listed beside it as information, never as terms of that sum (S13, S14).
 */
function TodayPanel({ today, live }: { today: MetricsToday; live: boolean }) {
  return <section className="metrics-panel metrics-today" aria-labelledby="metrics-today-title">
    <h2 id="metrics-today-title" className="metrics-panel-title">Caja de hoy</h2>
    <p className="metrics-big">
      <span className="metrics-amount">{money(today.expected_cents)}</span>
      <span className="metrics-big-note">Debería haber en el cajón</span>
    </p>
    <p className="metrics-note">
      Lo que quedó en el cajón al cerrar el último corte + ventas en efectivo − gastos.
    </p>
    <div className="metrics-split">
      <span>Cubre</span>
      {/* A branch without a closed settlement has no cut: its window is everything it ever did. */}
      <strong>{today.since === null
        ? 'Desde el comienzo de la sucursal'
        : <>Desde el corte del <TransferDate value={today.since} /></>}</strong>
    </div>
    <dl className="metrics-summary">
      <div><dt>Quedó al cerrar el último corte</dt><dd>{money(today.opening_cents)}</dd></div>
      <div><dt>Ventas en efectivo desde el corte</dt><dd>{closingSignedText(today.sales_cents)}</dd></div>
      <div><dt>Gastos desde el corte</dt><dd>{closingSignedText(-today.expenses_cents)}</dd></div>
    </dl>
    {today.movements.length === 0
      ? <p className="metrics-note">Sin movimientos desde el último corte.</p>
      : <>
        <table className="metrics-table">
          <caption className="metrics-caption">Movimientos de caja desde el último corte</caption>
          <thead>
            <tr><th scope="col">Movimiento</th><th scope="col" className="num">Monto</th>
              <th scope="col">Momento</th></tr>
          </thead>
          <tbody>
            {today.movements.map((movement, index) => <tr
              key={`${movement.kind}-${movement.occurred_at}-${index}`}>
              <td className="metrics-today-kind">{movementKindLabels[movement.kind]}</td>
              <td className="num">{money(movement.amount_cents)}</td>
              <td className="metrics-today-moment"><TransferDate value={movement.occurred_at} /></td>
            </tr>)}
          </tbody>
        </table>
        <p className="metrics-note">
          Los movimientos son información: no se suman ni se restan del esperado, que es el de la rendición.
        </p>
      </>}
    {/* The same drawer the period below counts, said in words while the period is the live one. */}
    {live && <p className="metrics-note">
      Es el mismo cajón que cuenta el período de abajo: los dos se mueven con cada venta.
    </p>}
  </section>;
}

/** The purchase envelope, with the amount the warehouse leaves in it as its own reading. */
function FundPanel({ fund }: { fund: MetricsFund }) {
  const difference = fund.difference_cents;
  return <section className="metrics-panel" aria-labelledby="metrics-fund-title">
    <h2 id="metrics-fund-title" className="metrics-panel-title">Fondo de compras</h2>
    <table className="metrics-table">
      <caption className="sr-only">Fondo de compras del período</caption>
      <tbody>
        <tr><td>Saldo con el que arrancó</td><td className="num">{money(fund.opening_cents)}</td></tr>
        <tr><td>Compras en efectivo del período</td><td className="num">{closingSignedText(-fund.purchases_cents)}</td></tr>
        <tr className="total"><td>Debería haber</td><td className="num">{money(fund.expected_cents)}</td></tr>
        <tr><td>Se contó</td><td className="num">{fund.counted_cents === null
          ? metricsNotCounted : money(fund.counted_cents)}</td></tr>
        <tr><td>Diferencia</td><td className="num">{difference === null ? metricsNotCounted : <>
          {closingSignedText(difference)}
          <span className="metrics-difference-name">{closingDifferenceName(difference)}</span>
        </>}</td></tr>
      </tbody>
    </table>
    {/* The replacement is the opening of the next period, not a term of this one's expectation. */}
    <div className="metrics-split">
      <span>Recambio que dejó el Almacén</span>
      <strong>{fund.replacement_cents === null ? 'Sin declarar' : money(fund.replacement_cents)}</strong>
    </div>
    <p className="metrics-note">Es el saldo con el que arranca el período siguiente; no entra en la cuenta de esta caja.</p>
  </section>;
}

/** The material sheet: the used units, the scrap by material and the shelf as it stands today. */
function ScrapPanel({ materials, shelf, history }: {
  materials: MetricsMaterials | null; shelf: number; history: boolean;
}) {
  return <section className="metrics-panel" aria-labelledby="metrics-scrap-title">
    <h2 id="metrics-scrap-title" className="metrics-panel-title">Recambio</h2>
    {materials === null
      ? <p className="metrics-note">{history
        ? metricsNoSheet : 'Sin planilla de materiales en este período.'}</p>
      : <>
        <table className="metrics-table">
          <caption className="metrics-caption">Chatarra comprada y entregada, en kilos</caption>
          <thead>
            <tr><th scope="col">Material</th><th scope="col" className="num">Comprado</th>
              <th scope="col" className="num">Entregado</th></tr>
          </thead>
          <tbody>
            {materials.materials.length === 0
              ? <tr><td colSpan={3}>El período no compró chatarra.</td></tr>
              : materials.materials.map(line => <tr key={line.material_id}>
                <td>{line.material}</td>
                <td className="num">{kilos(line.bought_milli)}</td>
                <td className="num">{line.delivered_milli === null
                  ? metricsNotCounted : kilos(line.delivered_milli)}</td>
              </tr>)}
          </tbody>
          {materials.materials.length > 1 && <tfoot>
            <tr className="total"><td>Total</td><td className="num">{kilos(materials.scrap_milli)}</td>
              <td className="num">{materials.scrap_delivered_milli === null
                ? metricsNotCounted : kilos(materials.scrap_delivered_milli)}</td></tr>
          </tfoot>}
        </table>
        <dl className="metrics-summary">
          <div><dt>Baterías usadas compradas</dt><dd>{units(materials.used_units)} u</dd></div>
          <div><dt>Entregadas al Almacén</dt><dd>{materials.used_delivered_units === null
            ? metricsNotCounted : `${units(materials.used_delivered_units)} u`}</dd></div>
          <div><dt>Stock en estantería hoy</dt><dd>{units(shelf)} u</dd></div>
        </dl>
      </>}
    {materials === null && <dl className="metrics-summary">
      <div><dt>Stock en estantería hoy</dt><dd>{units(shelf)} u</dd></div>
    </dl>}
  </section>;
}

/** The ranking of the period: units first, the money of each row as the secondary reading (S4). */
function RankingPanel({ models, total }: { models: readonly MetricsModel[]; total: number }) {
  return <section className="metrics-panel" aria-labelledby="metrics-ranking-title">
    <h2 id="metrics-ranking-title" className="metrics-panel-title">Baterías más vendidas</h2>
    {models.length === 0
      ? <p className="metrics-note">El período no vendió ninguna batería: no hay ranking que mostrar.</p>
      : <table className="metrics-table">
        <caption className="metrics-caption">Top 5 por unidades vendidas en el período</caption>
        <thead>
          <tr><th scope="col" className="rank" aria-label="Puesto" /><th scope="col">Modelo</th>
            <th scope="col" className="num">Unidades</th><th scope="col">Parte</th>
            <th scope="col" className="num">Plata</th></tr>
        </thead>
        <tbody>
          {models.map((model, index) => {
            const share = unitsShare(model.units, total);
            return <tr key={model.catalog_entry_id}>
              <td className="rank">{index + 1}</td>
              <td className="model">{model.brand} {model.model}
                <small>{model.capacity_ah} Ah</small></td>
              <td className="num">{model.units}</td>
              <td>
                <span className="metrics-share">
                  <span className="metrics-share-track" aria-hidden="true">
                    <span className="metrics-share-fill" style={{ width: `${share}%` }} />
                  </span>
                  <span className="metrics-share-pct">{total > 0 ? `${share} %` : '—'}</span>
                </span>
              </td>
              <td className="num">{money(model.money_cents)}</td>
            </tr>;
          })}
        </tbody>
      </table>}
    {models.length > 0 && <p className="metrics-note">
      {'El top 5 son '}<strong>{models.reduce((sum, model) => sum + model.units, 0)} de {total}</strong>
      {' unidades del período. El ranking es por unidades, no por plata.'}
    </p>}
  </section>;
}

/** The money of the period: what it collected, in how many sales, and how it was collected. */
function SalesPanel({ answer }: { answer: MetricsAnswer }) {
  const { sales } = answer;
  const ticket = ticketCents(sales.total_cents, sales.sales);
  const methods: readonly (readonly [string, bigint])[] = [
    ['Efectivo', sales.cash_cents], ['Tarjeta', sales.card_cents],
    ['Transferencia', sales.transfer_cents], ['QR', sales.qr_cents],
  ];
  return <section className="metrics-panel" aria-labelledby="metrics-sales-title">
    <h2 id="metrics-sales-title" className="metrics-panel-title">Plata del período</h2>
    <p className="metrics-big">
      <span className="metrics-amount">{money(sales.total_cents)}</span>
      <span className="metrics-big-note">{sales.sales === 1 ? 'en 1 venta' : `en ${sales.sales} ventas`}</span>
    </p>
    <p className="metrics-note">
      {`Ticket promedio ${ticket === null ? '—' : money(ticket)} · `}
      {sales.units === 1 ? '1 batería vendida' : `${sales.units} baterías vendidas`}
      {` · comisión ${money(sales.commission_cents)} (${moneyShareText(sales.commission_cents, sales.total_cents)})`}
    </p>
    <table className="metrics-table">
      <caption className="metrics-caption">Cómo se cobró</caption>
      <thead>
        <tr><th scope="col">Medio</th><th scope="col" className="num">Monto</th>
          <th scope="col" className="num">Parte</th></tr>
      </thead>
      <tbody>
        {methods.map(([label, cents]) => <tr key={label}>
          <td>{label}</td><td className="num">{money(cents)}</td>
          <td className="num">{moneyShareText(cents, sales.total_cents)}</td>
        </tr>)}
        <tr className="total"><td>Total</td><td className="num">{money(sales.total_cents)}</td>
          <td className="num">{sales.total_cents === 0n ? '—' : '100 %'}</td></tr>
      </tbody>
    </table>
  </section>;
}

/**
 * The metrics of the branch cut by settlement period (S1, S2). Everything a settlement freezes is
 * read from the closing — never recalculated — and the period is chosen with the same control Compras
 * uses, so the two screens offer the same periods in the same order. A period the server could not
 * have written is refused whole with its own words (S8).
 */
export default function Metrics({ branch, fetcher = globalThis.fetch }: MetricsProps) {
  const api = useMemo(() => createMetricsAPI(fetcher), [fetcher]);
  // The whole history is the only default this contract has, and the selector names it from the
  // first answer on: no period is ever guessed (S2, S6).
  const [periodToken, setPeriodToken] = useState('all');
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
        // An answer this client cannot trust is refused whole: no selector, no figure, no panel.
        setState({ phase: 'error', answer: null, periods: [],
          problem: metricsErrorMessages[code] ?? metricsUnavailable });
      }
    })();
    return () => controller.abort();
  }, [api, periodToken, revision]);

  const answer = state.answer;
  const periods = state.periods;
  const open = periods.find(period => period.kind === 'open') ?? null;
  const now = Date.now();

  return <section className="metrics-workspace" aria-labelledby="metrics-title">
    <header className="metrics-heading">
      <h1 id="metrics-title">Métricas de la sucursal</h1>
      <p className="metrics-lede">
        {`Lo que pasó en ${branch} en un período de rendición, con la misma numeración del acta.`}
      </p>
    </header>

    <div className="metrics-period" role="group" aria-label="Período de las métricas">
      {periods.length > 0 && <div className="metrics-period-field">
        <label htmlFor="metrics-period">Período</label>
        <select id="metrics-period" value={periodToken} disabled={state.phase === 'loading'}
          onChange={event => {
            const chosen = event.target.value;
            // Only a period this server published can be asked for.
            if (!periods.some(period => metricsPeriodToken(period) === chosen)) return;
            setPeriodToken(chosen);
          }}>
          {periods.map(period => <option key={metricsPeriodToken(period)}
            value={metricsPeriodToken(period)}>{period.label}</option>)}
        </select>
      </div>}
      {answer !== null && <>
        <p className="metrics-provenance">
          <span className="metrics-dot" aria-hidden="true" />
          {provenance(answer.source, answer.period)}
        </p>
        <p className="metrics-period-note">{periodNote(answer.period)}</p>
      </>}
      {answer === null && state.problem === '' &&
        <p className="metrics-note" role="status">Consultando las métricas de la sucursal…</p>}
    </div>

    {state.problem !== '' && <p className="metrics-problem" role="alert">{state.problem}
      <button type="button" onClick={() => setRevision(value => value + 1)}>Reintentar</button>
    </p>}

    {answer !== null && <>
      {/* The drawer of today comes first and is always rendered: it is the one reading a branch that
          has only closed settlements would otherwise never see (S12). */}
      <TodayPanel today={answer.today} live={answer.source === 'live'} />

      <section className="metrics-band-section" aria-labelledby="metrics-left-title">
        <h2 id="metrics-left-title" className="metrics-section-title">Lo que dejó el período</h2>
        <dl className="metrics-band">
          <BandCell title="Caja operativa entregada"
            value={answer.cash === null ? 'Sin caja' : answer.cash.counted_cents === null
              ? money(answer.cash.expected_cents) : money(answer.cash.counted_cents)}
            note={answer.cash === null ? 'El acumulado no tiene caja'
              : answer.cash.counted_cents === null
                ? 'Todavía no se contó: es la expectativa'
                : 'Contada y rendida al Almacén'} />
          <BandCell title="Fondo de compras que queda"
            value={answer.fund === null ? 'Sin fondo'
              : answer.fund.replacement_cents === null
                ? 'Sin declarar' : money(answer.fund.replacement_cents)}
            note={answer.fund === null ? 'El acumulado no tiene fondo'
              : answer.fund.replacement_cents === null
                ? 'El Almacén todavía no lo declaró'
                : 'Monto nuevo que escribió el Almacén'} />
          <BandCell title="Material entregado"
            value={answer.materials === null ? 'Sin planilla'
              : answer.materials.used_delivered_units === null
                  || answer.materials.scrap_delivered_milli === null
                ? 'Sin contar'
                : `${units(answer.materials.used_delivered_units)} u · ${kilos(answer.materials.scrap_delivered_milli)} kg`}
            note={answer.materials === null ? answer.source === 'history'
              ? 'El acumulado no tiene planilla'
              : 'Este período no tiene planilla'
              : 'Baterías usadas y chatarra'} />
          {/* Only a published open period has days to count: without one the band says nothing (S11). */}
          {open !== null && <BandCell title="Días sin rendir"
            value={`${daysWithoutSettling(open.from ?? '', now)} días`}
            note="desde la apertura del período en curso" />}
        </dl>
      </section>

      <div className="metrics-columns">
        <SalesPanel answer={answer} />
        {/* The history has no drawer: the screen says it with words instead of a column of zeros (S9). */}
        {answer.cash === null
          ? <section className="metrics-panel metrics-nocash" aria-labelledby="metrics-nocash-title">
            <h2 id="metrics-nocash-title" className="metrics-panel-title">Caja y fondo del acumulado</h2>
            <p className="metrics-note">{metricsNoDrawer}</p>
          </section>
          : <CashPanel cash={answer.cash} />}
      </div>

      {answer.fund !== null && <FundPanel fund={answer.fund} />}

      <div className="metrics-columns">
        <RankingPanel models={answer.top_models} total={answer.sales.units} />
        <ScrapPanel materials={answer.materials} shelf={answer.stock.units}
          history={answer.source === 'history'} />
      </div>

      {/* The acta froze the money and the counts; the shelf is today's and the ranking is the
          period's own, so the footnote names what is frozen instead of saying "everything". */}
      <p className="metrics-footnote">
        <strong>Cómo leer estos números:</strong>
        {answer.source === 'settlement'
          ? <> la plata y los conteos del cierre están congelados en el cierre del{' '}
            <TransferDate value={answer.period.to} />
            {' y no cambian. La estantería es la de hoy y el ranking es del período.'}</>
          : answer.source === 'live'
            ? ' el período en curso se deriva al leer: la plata y los conteos se mueven con cada venta, la estantería es la de hoy y el ranking es del período.'
            : ' el acumulado suma las ventas de la sucursal y publica su ranking y su estantería: no tiene caja, no tiene fondo y no tiene planilla, porque cada rendición cierra y se lleva las suyas.'}
      </p>
    </>}
  </section>;
}
