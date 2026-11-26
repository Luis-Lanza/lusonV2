import type { APIResponse, Locator, Page } from '@playwright/test';
import { branchA, expect, test, warehouseRole, type Session } from '../warranty/harness';

/**
 * El arnés de las rendiciones (S2, T6): las dos pantallas del cierre —la del Almacén, `#/rendiciones`,
 * y la de la sucursal, `#/rendicion`—, el documento que el servidor publica de cada una y el acto del
 * operador tal como lo hace: elige la sucursal, cuenta, carga la caja, propone, decide y corrige.
 *
 * Reusa el arnés de la vertical de garantías tal cual —las sesiones que abrió el proyecto `sesiones`,
 * el fixture `api` que dispone una sesión por rol, el `test` y el `expect` de Playwright— y le agrega
 * sólo lo que la rendición tiene de propio: las lecturas del contrato que el servidor ya publica
 * (`apps/api/docs/closings.md`: la historia de una sucursal, el documento, la corrección y su
 * decisión), la configuración de la comisión y el arreglo de lo que cada flujo no ejercita.
 *
 * **Una rendición abierta congela su sucursal** (`branch_closure_blocker`): mientras el documento no
 * esté `closed` la sucursal no vende, no carga gastos ni recibe stock ni concilia. Por eso todo cierre
 * que una prueba abre, propone y decide vive sobre la **Sucursal A**, y toda prueba lo deja cerrado
 * antes de terminar: el gancho `freeBranch()` cierra por el contrato lo que una prueba haya dejado
 * abierto, de modo que una falla no deje a la sucursal congelada para las demás suites (S4).
 *
 * **Por qué la A y no la B.** Una rendición se abre con una línea de planilla por variante que la
 * sucursal tiene con existencia, y el documento se rechaza entero cuando la planilla pasa de
 * `MaxCountLines` (190) líneas, y la ruta publica `503 service_unavailable` sin escribir el documento
 * (`apps/api/internal/closings/closing.go:253`, `apps/api/internal/closings/store.go:2662`). Ese tope
 * quedó del catálogo cerrado y nunca acompañó a la migración `028_catalog_operational_authority.sql`,
 * que soltó la cota de 190 variantes de `catalog_variants`: hoy el catálogo crece y la planilla no.
 * Subirlo es un cambio de producto con migración, fuera de esta entrega. Con la base local la
 * Sucursal B tiene 235 variantes con existencia —184 baterías y las otras que dejaron las corridas de
 * transferencias— y por eso no se puede rendir; la Sucursal A está hoy debajo del tope y sí. El límite es un defecto
 * del producto y queda documentado para la migración que lo corrija; acá no se toca.
 *
 * Nada de acá importa los módulos de la aplicación: la prueba no puede pasar por coincidir con el
 * código que revisa. Cada arreglo previo va por la API pública de la misma sesión (S3) y lleva el
 * sello de la corrida, porque la base es una sola y los demás grupos corren contra ella al mismo
 * tiempo.
 */

export { branchA, expect, origin, test, warehouseRole } from '../warranty/harness';
export type { Session } from '../warranty/harness';
export { arrangeBatterySale } from '../warranty/harness';
export { branchASession, warehouseSessionState } from '../warranty/sessions';

/** La sucursal de toda rendición de esta suite: la que la planilla puede cubrir entera (ver arriba). */
export const knownBranchId = 2;
export const knownBranchName = 'Sucursal A';

/**
 * La tasa que esta suite deja configurada en la sucursal cuando el Almacén no fijó ninguna. Sin tasa el
 * servidor rechaza la propuesta (`409 commission_rate_missing`) y la pantalla ni siquiera habilita el
 * botón, así que el arreglo la fija por el contrato, con la ruta que el panel del Almacén usa, y una
 * tasa que ya exista se respeta: la prueba afirma la que el documento congela, no una impuesta por ella.
 */
export const knownCommissionRate = '10.00';

// ---------------------------------------------------------------------------------
// Dinero: el contrato publica texto decimal canónico y la pantalla lo escribe como lo lee
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

/** El monto como la pantalla lo imprime: `Bs 1.234,56`. */
export function moneyText(cents: number): string {
  const magnitude = Math.abs(cents);
  return `Bs ${grouped(Math.floor(magnitude / 100))},${String(magnitude % 100).padStart(2, '0')}`;
}

/** El monto con su signo, como la pantalla firma una diferencia: `− Bs 85,00`, `+ Bs 12,50`. */
export function signedMoneyText(cents: number): string {
  if (cents === 0) return moneyText(0);
  return `${cents < 0 ? '−' : '+'} ${moneyText(cents)}`;
}

/** El monto como el operador lo escribe en un campo: `1.234,56`, sin moneda. */
export function typedMoney(cents: number): string {
  return `${grouped(Math.floor(cents / 100))},${String(cents % 100).padStart(2, '0')}`;
}

/** El monto como lo publica el contrato: `1234.56`, canónico y sin signo. */
export function wire(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) throw new Error(`monto fuera de rango: ${cents}`);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------------
// Datos únicos: dos corridas nunca chocan en una observación, un motivo ni un modelo
// ---------------------------------------------------------------------------------

let sequence = 0;

/** Un sello en mayúsculas y dígitos, que es lo que el contrato admite en un modelo de usada. */
export function stamp(): string {
  sequence += 1;
  return `${Date.now().toString(36)}${sequence}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
}

/** Un texto propio de esta corrida: la observación, el motivo o el modelo que la prueba afirma. */
export function uniqueText(prefix: string): string {
  return `${prefix} ${stamp()}`;
}

// ---------------------------------------------------------------------------------
// El contrato: el documento de la rendición y las lecturas con las que se contrasta
// ---------------------------------------------------------------------------------

export type ClosingStatus = 'open' | 'proposed' | 'rejected' | 'closed';

export interface ClosingCountLine {
  readonly variant_id: number;
  readonly catalog_entry_id: number;
  readonly expected_quantity: number;
  readonly counted_quantity: number | null;
  readonly held_in_case_quantity: number;
  readonly brand?: string;
  readonly model?: string;
  readonly capacity_ah?: string;
  readonly polarity?: string;
  readonly name?: string;
  readonly detail?: string;
}

export interface ClosingMaterialLine {
  readonly kind: 'used' | 'scrap';
  readonly model: string | null;
  readonly material_id: number | null;
  readonly material: string | null;
  readonly unit: 'unit' | 'kg';
  readonly expected_quantity: string;
  readonly counted_quantity: string | null;
  readonly difference: string | null;
  readonly delivered_quantity: string | null;
}

export interface ClosingOffer {
  readonly period_start: string;
  readonly cut_at: string;
  readonly sales_total: string;
  readonly commission_rate_percent: string;
  readonly commission_amount: string;
  readonly cash_sales: string;
  readonly cash_expenses: string;
  readonly counted_cash: string;
  readonly closing_cash: string;
  readonly observation: string;
}

export interface ClosingRound {
  readonly id: number;
  readonly round: number;
  readonly offer: ClosingOffer;
  readonly decision: '' | 'accepted' | 'rejected';
  readonly decision_reason: string;
}

export interface ClosingExpense {
  readonly id: number;
  readonly kind: 'gasto' | 'correccion';
  readonly amount: string;
  readonly description: string;
  readonly corrects_id: number | null;
  readonly category_id: number | null;
  readonly category_label: string | null;
}

export interface ClosingCorrectionEffect {
  readonly kind: 'stock' | 'counted_cash' | 'commission' | 'fund';
  readonly variant_id: number | null;
  readonly quantity_delta: number | null;
  readonly amount_delta: string | null;
}

export interface ClosingCorrection {
  readonly id: number;
  readonly closing_id: number;
  readonly status: 'proposed' | 'accepted';
  readonly reason: string;
  readonly payload: {
    readonly counted_quantities?: readonly { readonly variant_id: number; readonly counted_quantity: number }[];
    readonly counted_cash?: string;
    readonly commission_amount?: string;
    readonly closing_cash?: string;
  };
  readonly effects: readonly ClosingCorrectionEffect[];
}

/** Las siete claves del sobre del fondo de compras, tal como el documento las publica. */
export interface ClosingPurchaseFund {
  readonly opening: string;
  readonly purchases_cash: string;
  readonly expected: string;
  readonly counted: string | null;
  readonly difference: string | null;
  readonly cash: string | null;
}

/** El documento que publica cada ruta del cierre, ya tipado: la prueba lee de acá lo que afirma. */
export interface ClosingDocument {
  readonly id: number;
  readonly branch_location_id: number;
  readonly branch_name: string;
  readonly status: ClosingStatus;
  readonly period_start: string;
  readonly cut_at: string;
  readonly closed_at: string | null;
  readonly commission_rate_percent: string | null;
  readonly opening_cash: string;
  readonly cash_sales: string;
  readonly cash_expenses: string;
  readonly cash_effective: string;
  readonly expected_cash: string;
  readonly counted_cash: string | null;
  readonly cash_difference: string | null;
  readonly contributed_cash: string;
  readonly closing_cash: string | null;
  readonly taken_cash: string | null;
  readonly sales_total: string;
  readonly commission_base: string | null;
  readonly commission_amount: string;
  readonly card_total: string;
  readonly transfer_total: string;
  readonly qr_total: string;
  readonly observation: string;
  readonly count_lines: readonly ClosingCountLine[];
  readonly material_lines: readonly ClosingMaterialLine[];
  readonly rounds: readonly ClosingRound[];
  readonly expenses: readonly ClosingExpense[];
  readonly corrections: readonly ClosingCorrection[];
  readonly purchase_fund: ClosingPurchaseFund | null;
}

interface RawDocument extends Omit<ClosingDocument, 'purchase_fund'> {
  readonly purchase_fund_opening?: string;
  readonly purchases_cash?: string;
  readonly purchase_fund_expected?: string;
  readonly purchase_fund_counted?: string | null;
  readonly purchase_fund_difference?: string | null;
  readonly purchase_fund_cash?: string | null;
}

function withFund(raw: RawDocument): ClosingDocument {
  const fund = raw.purchase_fund_opening === undefined ? null : Object.freeze({
    opening: raw.purchase_fund_opening,
    purchases_cash: raw.purchases_cash ?? '0.00',
    expected: raw.purchase_fund_expected ?? '0.00',
    counted: raw.purchase_fund_counted ?? null,
    difference: raw.purchase_fund_difference ?? null,
    cash: raw.purchase_fund_cash ?? null,
  });
  return { ...raw, purchase_fund: fund };
}

async function json<T>(reply: APIResponse, where: string): Promise<T> {
  try {
    return (await reply.json()) as T;
  } catch {
    throw new Error(`${where}: la respuesta no es JSON`);
  }
}

async function read<T>(session: Session, path: string): Promise<T> {
  const reply = await session.request.get(path);
  if (reply.status() !== 200) {
    throw new Error(`GET ${path} respondió ${reply.status()}: ${await reply.text()}`);
  }
  return json<T>(reply, `GET ${path}`);
}

async function send<T>(session: Session, method: 'post', path: string, body: unknown,
  expected: number): Promise<T> {
  const reply = await session.request[method](path, {
    headers: { 'X-CSRF-Token': session.csrf }, data: body,
  });
  if (reply.status() !== expected) {
    throw new Error(`${method.toUpperCase()} ${path} respondió ${reply.status()} en vez de ${expected}: ${await reply.text()}`);
  }
  if (expected === 204) return undefined as T;
  return json<T>(reply, `${method.toUpperCase()} ${path}`);
}

/**
 * Una escritura sin cuerpo: la propuesta no admite ninguno —un cuerpo, aunque sea `null`, es
 * `400 invalid_request`— así que la petición viaja con su testigo y nada más.
 */
async function sendEmpty<T>(session: Session, path: string, expected: number): Promise<T> {
  const reply = await session.request.post(path, { headers: { 'X-CSRF-Token': session.csrf } });
  if (reply.status() !== expected) {
    throw new Error(`POST ${path} respondió ${reply.status()} en vez de ${expected}: ${await reply.text()}`);
  }
  return json<T>(reply, `POST ${path}`);
}

/** Una escritura que la prueba espera que el servidor rechace: se lee el estado y el código. */
export async function refused(session: Session, path: string, body: unknown,
  expected: number): Promise<{ readonly status: number; readonly error: string }> {
  const reply = await session.request.post(path, {
    headers: { 'X-CSRF-Token': session.csrf }, data: body,
  });
  const answer = await json<{ readonly error?: string }>(reply, `POST ${path}`);
  if (reply.status() !== expected) {
    throw new Error(`POST ${path} respondió ${reply.status()} en vez de ${expected}: ${JSON.stringify(answer)}`);
  }
  return { status: reply.status(), error: answer.error ?? '' };
}

/** Una página de la historia de una sucursal: sus filas, la más nueva primero. */
export async function closingHistory(session: Session, branch: number,
  page = 1, pageSize = 25): Promise<{
    readonly page: number;
    readonly total_closings: number;
    readonly closings: readonly ClosingDocument[];
  }> {
  const answer = await read<{
    page: number; page_size: number; total_closings: number; closings: readonly RawDocument[];
  }>(session, `/api/closings?branch_location_id=${branch}&page=${page}&page_size=${pageSize}`);
  return { page: answer.page, total_closings: answer.total_closings,
    closings: answer.closings.map(withFund) };
}

/** El documento entero de una rendición, que es lo que cada operación vuelve a publicar. */
export async function closingDocument(session: Session, id: number): Promise<ClosingDocument> {
  return withFund(await read<RawDocument>(session, `/api/closings/${id}`));
}

/** La rendición viva de la sucursal, o `null` cuando está libre: sólo una existe a la vez. */
export async function liveClosing(session: Session, branch: number): Promise<ClosingDocument | null> {
  const page = await closingHistory(session, branch);
  const row = page.closings.find(entry => entry.status !== 'closed');
  return row === undefined ? null : closingDocument(session, row.id);
}

/** La última rendición de la sucursal, cerrada o no: es la que su pantalla describe. */
export async function latestClosing(session: Session, branch: number): Promise<ClosingDocument | null> {
  const page = await closingHistory(session, branch);
  const row = page.closings[0];
  return row === undefined ? null : closingDocument(session, row.id);
}

/** La comisión que la sucursal tiene configurada, o `null` cuando el Almacén no fijó ninguna. */
export async function configuredCommission(session: Session, branch: number): Promise<string | null> {
  const reply = await session.request.get(`/api/closings/branches/${branch}/commission`);
  if (reply.status() === 404) return null;
  if (reply.status() !== 200) {
    throw new Error(`GET /api/closings/branches/${branch}/commission respondió ${reply.status()}: ${await reply.text()}`);
  }
  const answer = await json<{ commission_rate_percent: string }>(reply,
    `GET /api/closings/branches/${branch}/commission`);
  return answer.commission_rate_percent;
}

/**
 * La tasa con la que la sucursal va a rendir: la que el Almacén ya fijó, o la de esta suite cuando no
 * hay ninguna. Sin tasa la propuesta se rechaza con `commission_rate_missing` y la pantalla ni
 * habilita el botón de proponer, así que el arreglo la fija por el contrato —la misma ruta que el
 * panel del Almacén— y devuelve la tasa que el documento va a congelar (S5).
 */
export async function ensureCommission(warehouse: Session, branch: number,
  fallback = knownCommissionRate): Promise<string> {
  const configured = await configuredCommission(warehouse, branch);
  if (configured !== null) return configured;
  await send(warehouse, 'post', `/api/closings/branches/${branch}/commission`,
    { commission_rate_percent: fallback }, 200);
  return fallback;
}

/** Abre la rendición de una sucursal: la sucursal queda congelada desde ese instante. */
export async function openClosing(warehouse: Session, branch: number): Promise<ClosingDocument> {
  return withFund(await send<RawDocument>(warehouse, 'post', '/api/closings',
    { branch_location_id: branch }, 201));
}

export interface CashDraft {
  readonly counted_cash: string | null;
  readonly contributed_cash: string;
  readonly closing_cash: string | null;
  readonly observation: string;
}

/** El borrador de la caja: lo que el Almacén contó, el aporte, el fondo y la observación. */
export async function saveCashDraft(warehouse: Session, id: number,
  draft: CashDraft): Promise<ClosingDocument> {
  return withFund(await send<RawDocument>(warehouse, 'post', `/api/closings/${id}/cash`, draft, 200));
}

/** Propone el cierre a la sucursal: congela la tasa, los totales del período y la oferta. */
export async function proposeClosing(warehouse: Session, id: number): Promise<ClosingDocument> {
  return withFund(await sendEmpty<RawDocument>(warehouse, `/api/closings/${id}/propose`, 200));
}

export type ClosingAnswer =
  | { readonly decision: 'accepted' }
  | { readonly decision: 'rejected'; readonly reason: string };

/** La respuesta de la sucursal: aceptar cierra y aplica el conteo; rechazar no aplica nada. */
export async function decideClosing(branch: Session, id: number,
  answer: ClosingAnswer): Promise<ClosingDocument> {
  return withFund(await send<RawDocument>(branch, 'post', `/api/closings/${id}/decision`, answer, 200));
}

/** La corrección que el Almacén propone sobre un cierre decidido, con su motivo obligatorio. */
export async function proposeCorrection(warehouse: Session, id: number, body: {
  readonly reason: string;
  readonly payload: ClosingCorrection['payload'];
}): Promise<ClosingCorrection> {
  return send<ClosingCorrection>(warehouse, 'post', `/api/closings/${id}/corrections`, body, 201);
}

/** La respuesta de la sucursal a la corrección que espera su decisión. */
export async function decideCorrection(branch: Session, correction: number,
  answer: ClosingAnswer): Promise<ClosingCorrection> {
  return send<ClosingCorrection>(branch, 'post',
    `/api/closings/corrections/${correction}/decision`, answer, 200);
}

// ---------------------------------------------------------------------------------
// El arreglo previo: la rendición que cada prueba necesita, armada por el contrato
// ---------------------------------------------------------------------------------

/**
 * Un borrador que declara todo el cajón contado y lo deja en la sucursal: es la forma más barata de
 * llevar una rendición a `proposed` sin inventar una diferencia ni sacar nada de la caja.
 */
export function plainDraft(document: ClosingDocument, observation = ''): CashDraft {
  const counted = Math.max(centsOf(document.expected_cash), 0);
  // El cajón contado se deja entero en la sucursal: el cierre no le saca plata ni le inventa un
  // aporte, y el período siguiente hereda exactamente lo que había.
  return { counted_cash: wire(counted), contributed_cash: '0.00', closing_cash: wire(counted),
    observation: observation === '' ? document.observation : observation };
}

/** Abre la rendición de la sucursal y la deja en `open`: lo que la pantalla del Almacén edita. */
export async function arrangedOpen(warehouse: Session, branch: Session,
  branchId: number): Promise<ClosingDocument> {
  await closeEverything(warehouse, branch, branchId);
  return openClosing(warehouse, branchId);
}

/** Abre la rendición, declara la caja y la propone: lo que la sucursal ve como su decisión. */
export async function arrangedProposal(warehouse: Session, branch: Session,
  branchId: number, observation = ''): Promise<ClosingDocument> {
  const opened = await arrangedOpen(warehouse, branch, branchId);
  await saveCashDraft(warehouse, opened.id, plainDraft(opened, observation));
  return proposeClosing(warehouse, opened.id);
}

/**
 * Abre, propone y cierra una rendición por el contrato, para las pruebas cuyo acto necesita un cierre
 * ya decidido. La observación sella el documento de esta corrida.
 */
export async function arrangedClosure(warehouse: Session, branch: Session,
  branchId: number, observation = ''): Promise<ClosingDocument> {
  const proposed = await arrangedProposal(warehouse, branch, branchId, observation);
  return decideClosing(branch, proposed.id, { decision: 'accepted' });
}

/**
 * Cierra por el contrato lo que una prueba haya dejado abierto: la sucursal nunca queda congelada
 * para las demás suites. Una rendición `open` recibe el cajón contado que le falta; una `proposed`
 * se acepta tal como está.
 */
export async function settleLiveClosing(warehouse: Session, branch: Session,
  branchId: number): Promise<ClosingDocument | null> {
  let current = await liveClosing(warehouse, branchId);
  if (current === null) return null;
  if (current.status !== 'proposed') {
    await saveCashDraft(warehouse, current.id, plainDraft(current));
    current = await proposeClosing(warehouse, current.id);
  }
  current = await decideClosing(branch, current.id, { decision: 'accepted' });
  if (current.status !== 'closed') {
    throw new Error(`la rendición ${current.id} quedó en ${current.status} en vez de cerrada`);
  }
  return current;
}

/** Rechaza la corrección que haya quedado esperando: un cierre no se queda con una pendiente. */
export async function rejectPendingCorrection(warehouse: Session, branch: Session,
  branchId: number): Promise<void> {
  const document = await latestClosing(warehouse, branchId);
  if (document === null || document.status !== 'closed') return;
  const pending = document.corrections.find(entry => entry.status === 'proposed');
  if (pending === undefined) return;
  await decideCorrection(branch, pending.id,
    { decision: 'rejected', reason: 'La corrida no la decidió: no se aplica nada.' });
}

/** Cierra la rendición y rechaza la corrección pendiente: el estado limpio de la sucursal. */
export async function closeEverything(warehouse: Session, branch: Session,
  branchId: number): Promise<void> {
  await rejectPendingCorrection(warehouse, branch, branchId);
  await settleLiveClosing(warehouse, branch, branchId);
}

/**
 * El gancho que cada spec registra: pase lo que pase en la prueba, la sucursal no queda congelada ni
 * con una corrección esperando. Corre después de la prueba, con las sesiones todavía abiertas.
 */
export function freeBranch(): void {
  test.afterEach(async ({ api }) => {
    const warehouse = await api.as(warehouseRole);
    const branch = await api.as(branchA);
    await closeEverything(warehouse, branch, knownBranchId);
  });
}

// ---------------------------------------------------------------------------------
// La estantería de la sucursal: contra esto se contrasta lo que el cierre movió
// ---------------------------------------------------------------------------------

interface InventoryRow {
  readonly variant_id: number;
  readonly existing: number;
  readonly reserved: number;
}

/**
 * Las existencias de **todas** las variantes de una ubicación, leídas por páginas del contrato.
 *
 * La planilla del cierre tiene una línea por variante con existencia, así que la estantería contra la
 * que se la contrasta tiene que estar entera: la lectura camina las páginas hasta cubrir el total que
 * el contrato publica, sin un número fijo de páginas —el inventario de la sucursal crece con cada
 * grupo de la suite y ya pasó de las 500 variantes que dejaba leer un tope de diez páginas—. Si una
 * escritura de otra suite entra entre dos páginas y corre el orden por `variant_id`, la fila del
 * borde se saltea; el total publicado es la cota que se exige cubrir, así que la lectura se repite
 * hasta cubrirlo y, si no lo logra, falla en vez de comparar contra una estantería incompleta.
 */
export async function stockOf(session: Session, location: number): Promise<ReadonlyMap<number, number>> {
  const pageSize = 50;
  let stock = new Map<number, number>();
  let total = 0;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    stock = new Map<number, number>();
    for (let page = 1; ; page += 1) {
      const answer = await read<{ items: readonly InventoryRow[]; total_variants: number }>(
        session, `/api/inventory?location_id=${location}&page=${page}&page_size=${pageSize}&kind=all`);
      for (const row of answer.items) stock.set(row.variant_id, row.existing);
      total = answer.total_variants;
      if (answer.items.length === 0 || page * pageSize >= answer.total_variants) break;
    }
    if (stock.size >= total) return stock;
  }
  throw new Error(`la lectura del inventario de la ubicación ${location} quedó incompleta: `
    + `${stock.size} de ${total} variantes`);
}

/** Los motivos del cajón que el catálogo cerrado ofrece, para registrar un gasto con uno. */
export async function expenseMotive(branch: Session): Promise<{ id: number; label: string }> {
  const answer = await read<{ categories: readonly { id: number; label: string }[] }>(
    branch, '/api/closings/cash-categories');
  const motive = answer.categories[0];
  if (motive === undefined) throw new Error('el catálogo de motivos del cajón está vacío');
  return { id: motive.id, label: motive.label };
}

/** Un gasto del período, registrado por la sucursal como lo registra su pantalla de caja. */
export async function recordExpense(branch: Session, categoryId: number, amount: string,
  description: string): Promise<ClosingExpense> {
  return send<ClosingExpense>(branch, 'post', '/api/closings/expenses',
    { amount, category_id: categoryId, description }, 201);
}

/** Un aporte del período: plata que entra al cajón y mueve el efectivo del cierre. */
export async function recordContribution(branch: Session, amount: string,
  description: string): Promise<void> {
  await send<unknown>(branch, 'post', '/api/closings/cash-movements',
    { kind: 'aporte', amount, description }, 201);
}

interface BalanceRow {
  readonly branch_id: number;
  readonly cash_balance: string;
  readonly fund_balance: string;
  readonly frozen: boolean;
}

/** El saldo del sobre de compras de la sucursal, que es lo que una compra puede gastar. */
export async function fundBalance(warehouse: Session, branch: number): Promise<string> {
  const answer = await read<readonly BalanceRow[]>(warehouse, '/api/admin/branches/balances');
  const row = answer.find(entry => entry.branch_id === branch);
  if (row === undefined) throw new Error(`la sucursal ${branch} no publica su saldo`);
  return row.fund_balance;
}

/**
 * Compra una batería usada de un modelo propio de esta corrida, después de cargar en el sobre
 * exactamente lo que la compra cuesta: la estantería de materiales del cierre la publica como su
 * línea, y el modelo único hace que la prueba afirme su propia fila y ninguna otra (S4).
 */
export async function arrangeUsedPurchase(warehouse: Session, branch: Session,
  branchId: number, unitPrice = '25000.00'): Promise<string> {
  const model = `T6${stamp()}`;
  const held = centsOf(await fundBalance(warehouse, branchId));
  const price = centsOf(unitPrice);
  if (held < price) {
    await send<unknown>(warehouse, 'post', `/api/admin/branches/${branchId}/funds`,
      { opening_cash: '0.00', purchase_fund: wire(price - held) }, 204);
  }
  await send<unknown>(branch, 'post', '/api/purchases', {
    operation_key: `t6-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    note: '',
    used_lines: [{ model, quantity: 1, unit_price: unitPrice }],
    scrap_lines: [],
    paid_cash: unitPrice,
    paid_transfer: '0.00',
  }, 201);
  return model;
}

// ---------------------------------------------------------------------------------
// El navegador: las dos pantallas del cierre, con sus etiquetas y sus roles
// ---------------------------------------------------------------------------------

/** La pantalla del Almacén, sin sucursal elegida todavía: la lista de rendiciones de una sucursal. */
export async function openWarehouseClosings(page: Page): Promise<void> {
  await page.goto('/#/rendiciones');
  await expect(page.getByRole('heading', { level: 1, name: 'Rendición de cuentas', exact: true }))
    .toBeVisible();
  await expect(page.getByText('ALMACÉN / RENDICIONES')).toBeVisible();
}

/** Elige la sucursal que se rinde: desde acá la pantalla publica la rendición que esa sucursal tiene. */
export async function selectBranch(page: Page, name = knownBranchName): Promise<void> {
  await page.locator('#closing-branch').selectOption({ label: name });
  await expect(page.getByRole('heading', { level: 1, name: `Rendición de cuentas · ${name}` }))
    .toBeVisible();
}

/** Abre la pantalla del Almacén sobre la sucursal de esta suite: el punto de partida de los actos. */
export async function openWarehouseSettlement(page: Page, name = knownBranchName): Promise<void> {
  await openWarehouseClosings(page);
  await selectBranch(page, name);
}

/** La pantalla de la sucursal: la única rendición que puede decidir es la suya. */
export async function openBranchDecision(page: Page): Promise<void> {
  await page.goto('/#/rendicion');
  await expect(page.getByRole('heading', { level: 1, name: `Rendición de cuentas · ${knownBranchName}` }))
    .toBeVisible();
  await expect(page.getByText('SUCURSAL / RENDICIÓN DE CUENTAS')).toBeVisible();
}

/** La etiqueta de estado que la cabecera publica del documento. */
export function statusTag(page: Page, label: string): Locator {
  return page.locator('.closing-heading .closing-tag').filter({ hasText: label });
}

/** El panel de la pestaña de la caja, que es donde viven el conteo y los números del cajón. */
export function drawerPanel(page: Page): Locator {
  return page.locator('#closing-panel-caja');
}

/** El panel de la pestaña de los materiales y del sobre de compras. */
export function materialsPanel(page: Page): Locator {
  return page.locator('#closing-panel-chatarra');
}

/** Una fila del conteo por la variante que el documento publica: la celda que el acto escribe. */
export function countRow(page: Page, variantId: number): Locator {
  return page.locator(`tr[data-variant-id="${variantId}"]`).first();
}

/** El campo «Contado» de una fila del conteo. */
export function countedField(page: Page, variantId: number): Locator {
  return countRow(page, variantId).locator('input.count');
}

/**
 * El número que el rail publica de un término del resumen (`Caja esperada`, `Comisión`, …): la celda
 * que el término del mismo renglón publica al lado, buscada por su texto exacto.
 */
export function summaryValue(scope: Locator | Page, term: RegExp): Locator {
  return scope.locator('dl.closing-summary dt', { hasText: term })
    .locator('xpath=following-sibling::dd[1]').first();
}

/** El campo «Caja contada (Bs)» del cajón. */
export function cashCountedField(page: Page): Locator {
  return page.getByLabel('Caja contada (Bs)', { exact: true });
}

/** El campo «Monto que dejás en la caja (Bs)». */
export function cashFundField(page: Page): Locator {
  return page.getByLabel('Monto que dejás en la caja (Bs)', { exact: true });
}

/** El campo «Aporte del Almacén (Bs)». */
export function cashContributionField(page: Page): Locator {
  return page.getByLabel('Aporte del Almacén (Bs)', { exact: true });
}

/** La observación del cierre. */
export function cashObservationField(page: Page): Locator {
  return page.getByLabel('Observación del cierre', { exact: true });
}

/** La barra de acciones del cierre, que es donde el Almacén guarda y propone. */
export function actionBar(page: Page): Locator {
  return page.getByRole('region', { name: 'Acciones de la rendición' });
}

/** Lo que la barra dice de por qué la rendición todavía no se puede proponer. */
export function blockReason(page: Page): Locator {
  return page.locator('#closing-block-reason');
}

/** La fila del sobre del fondo de compras y de la estantería de materiales de un modelo. */
export function materialRow(page: Page, model: string): Locator {
  return page.locator(`tr[data-material-key="used:${model}"]`);
}

/** El panel de la corrección pendiente en la pantalla de la sucursal. */
export function pendingCorrectionPanel(page: Page): Locator {
  return page.locator('section[aria-labelledby="closing-correction-pending"]');
}

/** El panel de la caja de la pantalla de la sucursal: sus números, con la oferta de la ronda. */
export function branchCashPanel(page: Page): Locator {
  return page.locator('section[aria-labelledby="closing-decision-cash"]');
}
