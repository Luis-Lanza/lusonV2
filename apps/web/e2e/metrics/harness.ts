import type { Locator, Page } from '@playwright/test';
import { expect, type Session } from '../warranty/harness';

/**
 * El arnés de las métricas de la sucursal (odd/tasks/e2e-all-flows.md, T7).
 *
 * Reusa el arnés de la vertical de garantías tal cual —la sesión de la Sucursal A que abre el proyecto
 * `sesiones`, el fixture `api` que dispone una sesión por rol y el `test` y el `expect` de Playwright— y
 * le agrega sólo lo que la pantalla de métricas tiene de propio: la lectura del contrato que el servidor
 * ya publica (`GET /api/metrics`, `apps/api/docs/metrics.md`), las palabras con las que la pantalla
 * escribe cada cifra, y los localizadores de sus seis paneles.
 *
 * La pantalla es una lectura: no escribe nada, así que cada acto del operador se ejerce por la interfaz
 * —abrir la sección, elegir un período del selector, leer las figuras, el ranking, la comisión y el cajón
 * de hoy— y se contrasta con la respuesta de la API pública del mismo período. Nunca con un número
 * congelado: la base es una sola y las otras suites del pedido venden, mueven el cajón y compran en la
 * misma sucursal mientras esta prueba corre, así que la comparación se repite hasta que las dos lecturas
 * coinciden (véase `readOpening`).
 */

export { branchA, expect, test } from '../warranty/harness';
export type { Session } from '../warranty/harness';

// ---------------------------------------------------------------------------------
// Dinero y cantidades: el contrato publica texto decimal canónico y la pantalla lo escribe
// ---------------------------------------------------------------------------------

/** Los centavos de un monto del contrato (`"85.00"`, `"-85.00"`): la aritmética se hace con enteros. */
export function centsOf(wire: string): number {
  const match = /^(-?)(0|[1-9]\d*)\.(\d{2})$/.exec(wire);
  if (match === null) throw new Error(`el contrato publicó un monto fuera de su forma: ${wire}`);
  const magnitude = Number(match[2]) * 100 + Number(match[3]);
  return match[1] === '-' ? -magnitude : magnitude;
}

function grouped(whole: number): string {
  return String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/** El monto como la pantalla lo imprime: `Bs 1.234,56`, y con su signo cuando el contrato lo publica. */
export function moneyText(cents: number): string {
  if (cents < 0) return `− ${moneyText(-cents)}`;
  return `Bs ${grouped(Math.floor(cents / 100))},${String(cents % 100).padStart(2, '0')}`;
}

/**
 * Los centavos de un monto tal como la pantalla lo escribe (`Bs 1.234,56`), para sumar dos lecturas de la
 * pantalla entre sí sin volver al contrato.
 */
export function screenCents(shown: string): number {
  const match = /^(− )?Bs (\d{1,3}(?:\.\d{3})*),(\d{2})$/.exec(shown);
  if (match === null) throw new Error(`la pantalla escribió un monto fuera de su forma: ${shown}`);
  const magnitude = Number(match[2].replace(/\./g, '')) * 100 + Number(match[3]);
  return match[1] === undefined ? magnitude : -magnitude;
}

/** Los kilos como la pantalla los cuenta: `214,500`, en milésimos de kilogramo. */
export function kilosText(milli: number): string {
  const magnitude = Math.abs(milli);
  return `${Math.floor(magnitude / 1000)},${String(magnitude % 1000).padStart(3, '0')}`;
}

/** Lo que el período compró, como la línea de hoy lo cuenta: `184 u · 108,000 kg`. */
export function boughtText(usedUnits: number, scrapMilli: number): string {
  const parts: string[] = [];
  if (usedUnits !== 0) parts.push(`${usedUnits} u`);
  if (scrapMilli !== 0) parts.push(`${kilosText(scrapMilli)} kg`);
  return parts.length === 0 ? 'Sin unidades ni kilos' : parts.join(' · ');
}

/** El nombre de una diferencia, que la pantalla escribe en minúscula: `contada · faltante`. */
export function differenceName(cents: number): string {
  if (cents < 0) return 'Faltante';
  if (cents > 0) return 'Sobrante';
  return 'Sin diferencia';
}

/** Un texto del DOM sin sus espacios: la comparación no depende de cómo el JSX los separe. */
export function squash(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Un instante del contrato como la pantalla lo fecha (`shared/TransferDate`): el mismo día, la misma
 * hora de Bolivia y las mismas palabras, compuestas acá con la zona que la pantalla declara.
 */
export function dateText(value: string): string {
  const parts = new Intl.DateTimeFormat('es-BO', {
    timeZone: 'America/La_Paz', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find(entry => entry.type === type)?.value ?? '';
  return `${part('day')}/${part('month')}/${part('year')} · ${part('hour')}:${part('minute')} (hora Bolivia)`;
}

// ---------------------------------------------------------------------------------
// El contrato: la respuesta de `GET /api/metrics` de un período, con sus propios nombres
// ---------------------------------------------------------------------------------

export type MetricsPeriodKind = 'current' | 'settlement' | 'open' | 'all';
export type MetricsSource = 'settlement' | 'live' | 'history';

/** Un período del selector: la ventana, una rendición, la que está en curso o todo el historial. */
export interface MetricsPeriod {
  readonly kind: MetricsPeriodKind;
  readonly closing_id: number | null;
  readonly from: string | null;
  readonly to: string | null;
  readonly label: string;
}

export interface MetricsSales {
  readonly total: string;
  readonly batteries: string;
  readonly cash: string;
  readonly card: string;
  readonly transfer: string;
  readonly qr: string;
  readonly commission: string;
  readonly sales: number;
  readonly units: number;
}

export interface MetricsCash {
  readonly opening: string;
  readonly sales: string;
  readonly expenses: string;
  readonly expected: string;
  readonly counted: string | null;
  readonly difference: string | null;
}

export interface MetricsFund {
  readonly opening: string;
  readonly purchases: string;
  readonly expected: string;
  readonly counted: string | null;
  readonly difference: string | null;
  readonly replacement: string | null;
}

export interface MetricsMaterialLine {
  readonly material_id: number;
  readonly material: string;
  readonly bought_milli: number;
  readonly delivered_milli: number | null;
}

export interface MetricsMaterials {
  readonly used_units: number;
  readonly used_delivered_units: number | null;
  readonly scrap_milli: number;
  readonly scrap_delivered_milli: number | null;
  readonly materials: readonly MetricsMaterialLine[];
}

/** Una batería del ranking: su identidad de catálogo y su capacidad, nunca un nombre libre. */
export interface MetricsBatteryModel {
  readonly catalog_entry_id: number;
  readonly brand: string;
  readonly model: string;
  readonly capacity_ah: string;
  readonly units: number;
  readonly money: string;
}

/** Un producto del ranking: su nombre y ninguna columna de batería. */
export interface MetricsProductModel {
  readonly catalog_entry_id: number;
  readonly name: string;
  readonly units: number;
  readonly money: string;
}

/** La forma de la fila es su propio discriminante, como en el contrato. */
export type MetricsModel = MetricsBatteryModel | MetricsProductModel;

export interface MetricsMovement {
  readonly kind: 'aporte' | 'recaudacion' | 'gasto' | 'correccion';
  readonly amount: string;
  readonly effective: string;
  readonly occurred_at: string;
}

export interface MetricsToday {
  readonly since: string | null;
  readonly opening: string;
  readonly sales: string;
  readonly expenses: string;
  readonly effective: string;
  readonly expected: string;
  readonly rate: string | null;
  readonly sold: string;
  readonly commission_base: string;
  readonly commission: string;
  readonly movements: readonly MetricsMovement[];
}

export interface MetricsFundToday {
  readonly since: string | null;
  readonly opening: string;
  readonly purchases: string;
  readonly effective: string;
  readonly balance: string;
  readonly documents: number;
  readonly used_units: number;
  readonly scrap_milli: number;
}

export interface MetricsAnswer {
  readonly periods: readonly MetricsPeriod[];
  readonly period: MetricsPeriod;
  readonly source: MetricsSource;
  readonly sales: MetricsSales;
  readonly cash: MetricsCash | null;
  readonly fund: MetricsFund | null;
  readonly materials: MetricsMaterials | null;
  readonly top_models: readonly MetricsModel[];
  readonly stock: { readonly units: number };
  readonly today: MetricsToday;
  readonly fund_today: MetricsFundToday;
}

/** Una fila del ranking es una batería cuando publica su marca, y un producto cuando no. */
export function isBattery(model: MetricsModel): model is MetricsBatteryModel {
  return 'brand' in model;
}

/** El testigo del período en la URL y en el selector: el id de la rendición, o el nombre del tipo. */
export function periodToken(period: MetricsPeriod): string {
  return period.closing_id === null ? period.kind : String(period.closing_id);
}

/**
 * `GET /api/metrics?period=…`: la respuesta del contrato de un período de la sucursal de la sesión.
 * La lectura es evidencia sólo cuando repite el período que se pidió, así que eso también se afirma.
 */
export async function metricsAnswer(session: Session, token: string): Promise<MetricsAnswer> {
  const path = `/api/metrics?period=${encodeURIComponent(token)}`;
  const reply = await session.request.get(path);
  if (reply.status() !== 200) {
    throw new Error(`GET ${path} respondió ${reply.status()}: ${await reply.text()}`);
  }
  const answer = (await reply.json()) as MetricsAnswer;
  if (periodToken(answer.period) !== token) {
    throw new Error(`GET ${path} publicó el período ${periodToken(answer.period)} en vez de ${token}`);
  }
  return answer;
}

/**
 * El período con el que la pantalla abre: la ventana desde el último corte cuando el servidor la
 * publica, y si no el historial, que es el único que una sucursal sin rendiciones cerradas tiene. Es la
 * misma regla que la pantalla aplica (S10): no es un período que la prueba elija.
 */
export function openingPeriod(periods: readonly MetricsPeriod[]): MetricsPeriod {
  const first = periods[0];
  if (first !== undefined && first.kind === 'current') return first;
  const history = periods.find(period => period.kind === 'all');
  if (history === undefined) {
    throw new Error('el contrato no publica el historial: no hay período en el que la pantalla pueda abrir');
  }
  return history;
}

/** Las palabras con las que la pantalla dice de dónde vienen los números (S6). */
export function provenanceText(answer: MetricsAnswer): string {
  const { period, source } = answer;
  if (period.kind === 'current') {
    return `Desde el corte del ${dateText(period.from ?? '')} · se mueve con cada venta`;
  }
  if (source === 'settlement') return `Números al cierre del ${dateText(period.to ?? '')}`;
  if (source === 'live') return 'En vivo, se mueve con cada venta';
  return 'Todo el historial de la sucursal';
}

// ---------------------------------------------------------------------------------
// La pantalla: sus seis paneles, sus etiquetas y sus cifras, como el operador las lee
// ---------------------------------------------------------------------------------

export async function openMetrics(page: Page): Promise<void> {
  await page.goto('/#/metricas');
  await expect(page.getByRole('heading', { level: 1, name: 'Métricas de la sucursal' })).toBeVisible();
  await waitForAnswer(page);
}

export function periodSelect(page: Page): Locator {
  return page.getByLabel('Período', { exact: true });
}

/** El sello que dice de dónde vienen los números: el corte, el cierre o el historial. */
export function stamp(page: Page): Locator {
  return page.locator('.metrics-stamp');
}

/** Las cuatro figuras del período: la plata, la caja, el fondo y el material. */
export function figuresPanel(page: Page): Locator {
  return page.getByRole('region', { name: 'Lo que dejó el período' });
}

function figureBlock(page: Page, title: string): Locator {
  return figuresPanel(page).locator('.metrics-figure').filter({ hasText: title }).first();
}

export function figureValue(page: Page, title: string): Locator {
  return figureBlock(page, title).locator('.metrics-figure-value');
}

export function figureNote(page: Page, title: string): Locator {
  return figureBlock(page, title).locator('.metrics-figure-note');
}

/** La línea de hoy: el cajón, el sobre de compras, lo vendido y la comisión devengada. */
export function todayPanel(page: Page): Locator {
  return page.getByRole('region', { name: 'Hoy' });
}

export function todaySince(page: Page): Locator {
  return todayPanel(page).locator('.metrics-today-since');
}

export function todayValue(page: Page, term: string): Locator {
  return todayPanel(page).locator('dl > div').filter({ hasText: term }).first().locator('dd').first();
}

export function soldPanel(page: Page): Locator {
  return page.getByRole('region', { name: 'Qué se vendió' });
}

export function soldValue(page: Page, label: string): Locator {
  return soldPanel(page).locator('dl > div').filter({ hasText: label }).first().locator('dd').first();
}

export function rankingPanel(page: Page): Locator {
  return page.getByRole('region', { name: 'Más vendidas' });
}

export function rankingRows(page: Page): Locator {
  return rankingPanel(page).locator('tbody tr');
}

/** La línea que el ranking publica bajo la tabla: `63 de 78 unidades`. */
export function rankingHint(page: Page): Locator {
  return rankingPanel(page).locator('.metrics-hint');
}

/**
 * Elige un período en el selector, como el operador: la opción queda elegida y la pantalla queda leyendo
 * ese período. El contraste de las cifras lo hace el llamador (`expectSamePeriod`), que es el que sabe
 * volver a abrir la pantalla si la lectura le llegó tarde.
 */
export async function selectPeriod(page: Page, token: string): Promise<void> {
  const select = periodSelect(page);
  // Elegir la opción que ya está elegida no dispara un acto del operador: no hay nada que esperar.
  if (await select.inputValue() === token) return;
  await select.selectOption(token);
  try {
    await expect(select).toHaveValue(token, { timeout: 10_000 });
  } catch {
    const problem = page.getByRole('alert');
    const reason = await problem.isVisible() ? await text(problem)
      : 'la pantalla no volvió a publicar el selector';
    throw new Error(`la pantalla no mostró el período ${token}: ${reason}`);
  }
  await waitForAnswer(page);
}

/**
 * La pantalla ya respondió: sus paneles, o la alerta con la que rechaza una respuesta que no puede
 * creer. La alerta se convierte en el error visible del intento, para que el reintento no espere en vano.
 */
async function waitForAnswer(page: Page): Promise<void> {
  const problem = page.getByRole('alert');
  await expect(figuresPanel(page).or(problem)).toBeVisible();
  if (await problem.isVisible()) {
    throw new Error(`la pantalla rechazó la respuesta del servidor: ${await text(problem)}`);
  }
}

// ---------------------------------------------------------------------------------
// El contraste: la pantalla contra el contrato del mismo período, leídos a la vez
// ---------------------------------------------------------------------------------

async function text(box: Locator): Promise<string> {
  return squash((await box.textContent()) ?? '');
}

/**
 * El período con el que la pantalla abre, leído del contrato en este momento: la ventana desde el último
 * corte cuando el servidor la publica y el historial cuando no. Se vuelve a leer en cada intento porque
 * una rendición que se abre o se cierra cambia el selector mientras la suite corre.
 */
export async function openingOf(session: Session): Promise<MetricsPeriod> {
  const catalogue = await metricsAnswer(session, 'all');
  return openingPeriod(catalogue.periods);
}

/**
 * Contrasta la pantalla del período con el que abre contra la respuesta del contrato de ese mismo período.
 *
 * Las dos lecturas no son simultáneas: la base es una sola y las otras suites del pedido escriben en la
 * misma sucursal, así que una cifra puede moverse entre la pantalla y la API. Cuando eso pasa la prueba
 * vuelve a abrir la pantalla y a leer el contrato —nunca debilita la afirmación— hasta que las dos
 * lecturas coinciden, que es lo que el contrato admite: la pantalla contra la respuesta de su período.
 */
export async function readOpening<T>(page: Page, session: Session,
  shown: (page: Page) => Promise<T>,
  contract: (answer: MetricsAnswer) => T): Promise<MetricsAnswer> {
  let observed: MetricsAnswer | null = null;
  await expect(async () => {
    const opening = await openingOf(session);
    const token = periodToken(opening);
    await openAt(page, token);
    const answer = await metricsAnswer(session, token);
    observed = answer;
    await expectSamePeriod(page, answer, shown, contract);
  }).toPass({ timeout: 75_000, intervals: [250, 1_000, 3_000] });
  if (observed === null) throw new Error('no se pudo contrastar la pantalla con el contrato del período');
  return observed;
}

/**
 * La pantalla y el contrato de un mismo período, leídos juntos: el sello que ata las cifras a su período y
 * la proyección que el test declara. Lo usa cada spec, y también el del selector cuando tiene que repetir
 * el contraste de un período que acaba de elegir.
 */
export async function expectSamePeriod<T>(page: Page, answer: MetricsAnswer,
  shown: (page: Page) => Promise<T>, contract: (answer: MetricsAnswer) => T,
  timeout = 15_000): Promise<void> {
  // El sello ata las cifras al período del que salieron: una pantalla vieja no pasa por coincidencia.
  await expect(stamp(page)).toHaveText(provenanceText(answer), { timeout });
  await waitForAnswer(page);
  // La comparación es de valores: la proyección de la pantalla contra la del contrato.
  expect<unknown>(await shown(page)).toEqual(contract(answer));
}

/** Abre (o vuelve a abrir) la pantalla en el período pedido: el acto de elegirlo cuando hace falta. */
async function openAt(page: Page, token: string): Promise<void> {
  if (new URL(page.url()).hash === '#/metricas') await page.reload();
  else await page.goto('/#/metricas');
  await expect(page.getByRole('heading', { level: 1, name: 'Métricas de la sucursal' })).toBeVisible();
  // El selector llega con la primera respuesta: mientras la ventana se lee, la pantalla todavía no lo
  // publica, así que esta espera es también la de la lectura que decidió el período de apertura.
  await expect(periodSelect(page)).toBeVisible();
  // El acto de elegir: la pantalla queda en el período pedido o el reintento vuelve a empezar.
  await selectPeriod(page, token);
}

// ---------------------------------------------------------------------------------
// Lo que cada panel tiene que decir, proyectado del contrato con las palabras de la pantalla
// ---------------------------------------------------------------------------------

/** Las cuatro figuras del período, con la línea que califica a cada una. */
export interface PeriodFigures {
  readonly money: string; readonly moneyNote: string;
  readonly cash: string; readonly cashNote: string;
  readonly fund: string; readonly fundNote: string;
  readonly material: string; readonly materialNote: string;
}

export async function shownFigures(page: Page): Promise<PeriodFigures> {
  return {
    money: await text(figureValue(page, 'Plata del período')),
    moneyNote: await text(figureNote(page, 'Plata del período')),
    cash: await text(figureValue(page, 'Caja entregada')),
    cashNote: await text(figureNote(page, 'Caja entregada')),
    fund: await text(figureValue(page, 'Fondo que queda')),
    fundNote: await text(figureNote(page, 'Fondo que queda')),
    material: await text(figureValue(page, 'Material entregado')),
    materialNote: await text(figureNote(page, 'Material entregado')),
  };
}

/** Lo que el contrato dice que esas cuatro figuras tienen que decir, con sus mismas palabras (S3, S8). */
export function contractFigures(answer: MetricsAnswer): PeriodFigures {
  const { sales, cash, fund, materials } = answer;
  const kind = answer.period.kind;
  const counted = cash === null ? null : cash.counted === null ? null : centsOf(cash.counted);
  const difference = cash === null || cash.difference === null ? null : centsOf(cash.difference);
  return {
    money: moneyText(centsOf(sales.total)),
    moneyNote: sales.sales === 1 ? '1 venta' : `${sales.sales} ventas`,
    cash: cash === null ? 'Sin caja' : moneyText(counted ?? centsOf(cash.expected)),
    cashNote: cash === null
      ? (kind === 'current' ? 'se cuenta al rendir' : 'el acumulado no tiene caja')
      : counted === null ? 'todavía no se contó'
        : difference === null ? 'contada' : `contada · ${differenceName(difference).toLowerCase()}`,
    fund: fund === null ? 'Sin fondo'
      : fund.replacement === null ? 'Sin declarar' : moneyText(centsOf(fund.replacement)),
    fundNote: fund === null
      ? (kind === 'current' ? 'lo declara el Almacén al rendir' : 'el acumulado no tiene fondo')
      : fund.replacement === null ? 'el Almacén todavía no lo declaró' : 'recambio del Almacén',
    material: materials === null ? 'Sin planilla'
      : materials.used_delivered_units === null || materials.scrap_delivered_milli === null
        ? 'Sin contar'
        : `${materials.used_delivered_units} u · ${kilosText(materials.scrap_delivered_milli)} kg`,
    materialNote: materials === null
      ? (kind === 'current' ? 'se entrega al rendir'
        : kind === 'all' ? 'el acumulado no tiene planilla' : 'este período no tiene planilla')
      : 'baterías usadas y chatarra',
  };
}

/** El período en cinco lecturas: desde cuándo, el cajón, el sobre, lo vendido y la comisión. */
export interface TodayLine {
  readonly since: string;
  readonly cash: string;
  readonly fund: string;
  readonly sold: string;
  readonly commission: string;
  readonly purchases: string;
}

export async function shownToday(page: Page): Promise<TodayLine> {
  return {
    since: await text(todaySince(page)),
    cash: await text(todayValue(page, 'Efectivo en el cajón')),
    fund: await text(todayValue(page, 'Fondo de compras disponible')),
    sold: await text(todayValue(page, 'Vendido desde el corte')),
    commission: await text(todayValue(page, 'Comisión devengada')),
    purchases: await text(todayValue(page, 'Compras desde el corte')),
  };
}

/**
 * Lo que la línea de hoy tiene que decir. Es la lectura del cajón y del sobre de la sucursal, que se
 * publican en cualquier período, más las dos lecturas de la ventana: lo vendido y lo devengado (S12-S20).
 */
export function contractToday(answer: MetricsAnswer): TodayLine {
  const { today, fund_today } = answer;
  const commission = centsOf(today.commission);
  const documents = fund_today.documents;
  const purchases = documents === 0 ? 'Sin compras' : documents === 1 ? '1 compra' : `${documents} compras`;
  const bought = documents === 0
    ? '' : boughtText(fund_today.used_units, fund_today.scrap_milli);
  return {
    since: today.since === null ? 'desde el comienzo de la sucursal'
      : `desde el corte del ${dateText(today.since)}`,
    cash: moneyText(centsOf(today.expected)),
    fund: moneyText(centsOf(fund_today.balance)),
    sold: centsOf(today.sold) === 0 ? 'Sin ventas' : moneyText(centsOf(today.sold)),
    commission: today.rate === null ? 'Sin tasa'
      : commission > 0 ? moneyText(commission) : 'Sin comisión todavía',
    // La línea de compras pega el conteo y lo comprado sin separador: el JSX no escribe un espacio
    // entre las dos expresiones, así que la lectura de la pantalla las concatena.
    purchases: squash(`${purchases}${bought}`),
  };
}

/** Lo que se vendió por tipo de producto: las baterías, el resto del total y el total que los suma. */
export interface SoldByKind {
  readonly batteries: string;
  readonly other: string;
  readonly total: string;
}

export async function shownSoldByKind(page: Page): Promise<SoldByKind> {
  return {
    batteries: await text(soldValue(page, 'Baterías')),
    other: await text(soldValue(page, 'Otros productos')),
    total: await text(soldValue(page, 'Total')),
  };
}

export function contractSoldByKind(answer: MetricsAnswer): SoldByKind {
  const total = centsOf(answer.sales.total);
  const batteries = centsOf(answer.sales.batteries);
  const reading = (cents: number): string => cents === 0 ? 'Sin ventas' : moneyText(cents);
  return { batteries: reading(batteries), other: reading(total - batteries), total: reading(total) };
}

/** Una fila del ranking como la pantalla la escribe: el puesto, el modelo, sus unidades y su plata. */
export interface RankingRow {
  readonly rank: string;
  readonly model: string;
  readonly units: string;
  readonly money: string;
}

export async function shownRanking(page: Page): Promise<readonly RankingRow[]> {
  return rankingRows(page).evaluateAll(nodes => nodes.map(node => {
    const cells = Array.from(node.querySelectorAll('td'));
    const cell = (index: number): string => (cells[index]?.textContent ?? '').replace(/\s+/g, ' ').trim();
    return { rank: cell(0), model: cell(1), units: cell(2), money: cell(3) };
  }));
}

export function contractRanking(answer: MetricsAnswer): readonly RankingRow[] {
  return answer.top_models.map((model, index) => ({
    rank: String(index + 1),
    // Una batería conserva la identidad que la pantalla compone; un producto es su nombre y nada más.
    model: isBattery(model) ? `${model.brand} ${model.model}${model.capacity_ah} Ah` : model.name,
    units: String(model.units),
    money: moneyText(centsOf(model.money)),
  }));
}

/** La línea de volumen del ranking, que la pantalla compone con las filas que muestra y las del período. */
export function rankingVolumeText(answer: MetricsAnswer): string {
  const shown = answer.top_models.reduce((sum, model) => sum + model.units, 0);
  return `${shown} de ${answer.sales.units} unidades`;
}
