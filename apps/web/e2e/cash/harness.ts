import type { APIResponse, Browser, Locator, Page } from '@playwright/test';
import { expect, origin, type Session } from '../warranty/harness';
import { branchASession } from '../warranty/sessions';

/**
 * El arnés de la caja operativa (S2, S3).
 *
 * Reusa el arnés de la vertical de garantías tal cual: la sesión de la sucursal A (`branchA`, abierta por
 * `e2e/warranty/auth.setup.ts`), el fixture `api` que dispone una sesión por rol y el `test` y el `expect`
 * de Playwright. Este archivo sólo agrega lo que el cajón tiene de propio: la pantalla con sus cuatro
 * números y su libro, el formulario que escribe un gasto, un aporte o una recaudación, la corrección de
 * una fila, las pestañas del catálogo de motivos y las lecturas con las que se contrasta lo que la
 * pantalla afirmó — siempre por el contrato que el servidor ya publica (`apps/api/docs/closings.md`):
 * `GET /api/closings/cash-ledger`, `GET /api/closings/cash-categories` y, del lado del Almacén,
 * `GET /api/admin/cash-categories`.
 *
 * Nada de acá importa módulos de la aplicación: la prueba no puede pasar por coincidir con el código que
 * revisa. Lo único que se arregla por API es lo que el acto bajo prueba no ejercita —el movimiento que se
 * corrige, el motivo que se renombra o se archiva—, y cada arreglo lleva el sello del run porque la base
 * es una sola y las demás suites del pedido corren contra ella al mismo tiempo (S4).
 */

export { branchA, expect, origin, test, warehouseRole } from '../warranty/harness';
export type { Session } from '../warranty/harness';
export { branchASession, warehouseSessionState } from '../warranty/sessions';

// ---------------------------------------------------------------------------------
// Dinero: el contrato publica texto decimal canónico y la pantalla lo escribe como lo lee
// ---------------------------------------------------------------------------------

/** Los centavos de un monto del contrato (`"85.00"`, `"-85.00"`): el único signo admitido es el de un
 * efectivo, y la aritmética de la prueba se hace con enteros. */
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

/** El texto canónico del contrato para un monto exacto de centavos: `"123.45"`. */
export function wireMoney(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error(`monto inválido: ${cents}`);
  return `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

/** El mismo monto como el operador lo escribe en un campo: `123,45`. */
export function typedMoney(cents: number): string {
  return wireMoney(cents).replace('.', ',');
}

/** El efectivo con su signo, que es la única cifra firmada del libro: `− Bs 85,00`, `+ Bs 500,00`. */
export function signedText(cents: number): string {
  if (cents < 0) return `\u2212 ${moneyText(cents)}`;
  if (cents > 0) return `+ ${moneyText(cents)}`;
  return moneyText(0);
}

/** El nombre con el que la pantalla escribe cada tipo del libro (S8). */
export const kindLabels: Readonly<Record<string, string>> = Object.freeze({
  gasto: 'Gasto', aporte: 'Aporte', recaudacion: 'Recaudación', correccion: 'Corrección',
});

// ---------------------------------------------------------------------------------
// Datos propios de cada corrida: ningún monto, nota ni motivo se repite
// ---------------------------------------------------------------------------------

let sequence = 0;

/** El sello del run: lo que hace único cada nota, cada etiqueta y cada archivo del comprobante. */
export function uniqueTag(): string {
  sequence += 1;
  return `${Date.now().toString(36)}${sequence}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
}

/** Lo que el operador escribe en la nota de un gasto o en el motivo de un aporte. */
export function uniqueNote(prefix: string): string {
  return `${prefix} ${uniqueTag()}`;
}

/** Un monto de esta corrida, en las tres formas que hacen falta: centavos, contrato y lo que se tipea. */
export interface Amount {
  readonly cents: number;
  /** El texto canónico del contrato: `"123.45"`. */
  readonly wire: string;
  /** Lo que el operador escribe en el campo: `123,45`. */
  readonly typed: string;
}

export function uniqueAmount(): Amount {
  const cents = 1_000 + Math.floor(Math.random() * 89_000);
  return { cents, wire: wireMoney(cents), typed: typedMoney(cents) };
}

// ---------------------------------------------------------------------------------
// La API de la misma sesión: el arreglo previo y la lectura de lo persistido
// ---------------------------------------------------------------------------------

async function answered<T>(reply: APIResponse, where: string, expected: number): Promise<T> {
  if (reply.status() !== expected) {
    throw new Error(`${where} respondió ${reply.status()} en vez de ${expected}: ${await reply.text()}`);
  }
  return (await reply.json()) as T;
}

async function read<T>(session: Session, path: string): Promise<T> {
  return answered<T>(await session.request.get(path), `GET ${path}`, 200);
}

async function write<T>(session: Session, path: string, body: unknown, expected: number): Promise<T> {
  const reply = await session.request.post(path, { headers: { 'X-CSRF-Token': session.csrf }, data: body });
  return answered<T>(reply, `POST ${path}`, expected);
}

/** El comprobante de un gasto como lo publica el libro: el tipo que el servidor validó, su tamaño y su
 * digest, y nunca los bytes, que se sirven por su propia ruta (S7). */
export interface EvidenceRecord {
  readonly type: string;
  readonly size: number;
  readonly sha256: string;
}

/** Una fila del libro, con la dirección que lleva y el efecto firmado que movió el cajón. */
export interface LedgerMovement {
  readonly id: number;
  readonly kind: string;
  readonly effect_kind: string;
  readonly amount: string;
  readonly effective: string;
  readonly description: string;
  readonly occurred_at: string;
  readonly created_by_account_id: number;
  readonly corrects_id: number | null;
  readonly category_id: number | null;
  readonly category_label: string | null;
  readonly evidence: EvidenceRecord | null;
}

/** El libro de una ventana: los cuatro números que la pantalla imprime y las filas que lista. */
export interface Book {
  readonly since: string | null;
  readonly until: string | null;
  readonly opening: string;
  readonly sales: string;
  readonly effective: string;
  readonly expected: string;
  readonly truncated: boolean;
  readonly movements: readonly LedgerMovement[];
}

/**
 * El libro del cajón tal como la pantalla lo pide: sin ventana es el período en curso —el que arranca en
 * el corte del último cierre—, y con las dos cotas es la ventana de una rendición cerrada.
 */
export async function readBook(session: Session,
  window: { readonly from?: string; readonly to?: string } = {}): Promise<Book> {
  const params = new URLSearchParams();
  if (window.from !== undefined) params.set('from', window.from);
  if (window.to !== undefined) params.set('to', window.to);
  const query = params.toString();
  return read<Book>(session, `/api/closings/cash-ledger${query === '' ? '' : `?${query}`}`);
}

/** Una fila del libro por su identificador: el que la pantalla publica en la fila y la confirmación no dice. */
export async function bookMovement(session: Session, id: number): Promise<LedgerMovement> {
  const book = await readBook(session);
  const row = book.movements.find(candidate => candidate.id === id);
  if (row === undefined) throw new Error(`el movimiento #${id} no aparece en el libro del cajón de la sucursal`);
  return row;
}

/** Las filas que dicen exactamente un texto: la forma de afirmar que un acto no escribió nada. */
export async function movementsSaying(session: Session, text: string): Promise<readonly LedgerMovement[]> {
  const book = await readBook(session);
  return book.movements.filter(row => row.description === text);
}

/** Los movimientos del período que declaran exactamente un monto: lo que un rechazo no dejó guardado. */
export async function movementsOfAmount(session: Session, wire: string): Promise<readonly LedgerMovement[]> {
  const book = await readBook(session);
  return book.movements.filter(row => row.amount === wire);
}

/** Una opción de la lista cerrada de motivos, tal como la sucursal la recibe (S1, S2). */
export interface CashMotive {
  readonly id: number;
  readonly label: string;
}

/** La lista que el selector de la sucursal ofrece: sólo los motivos activos, en su orden. */
export async function motiveList(session: Session): Promise<readonly CashMotive[]> {
  const answer = await read<{ categories: readonly CashMotive[] }>(session, '/api/closings/cash-categories');
  return answer.categories;
}

/** Un motivo del catálogo del Almacén, con su lugar, su estado y sus sellos de archivo (S3, S4). */
export interface AdminMotive {
  readonly id: number;
  readonly label: string;
  readonly sort_order: number;
  readonly state: 'active' | 'retired';
  readonly retired_at: string | null;
  readonly retired_by: string | null;
}

/** El catálogo entero, archivados incluidos: la lectura con la que la administración reactiva uno. */
export async function adminMotives(session: Session): Promise<readonly AdminMotive[]> {
  const answer = await read<{ categories: readonly AdminMotive[] }>(session, '/api/admin/cash-categories');
  return answer.categories;
}

/** El motivo por su etiqueta, o el motivo por el que no está; nunca un valor inventado. */
export async function adminMotiveByLabel(session: Session, label: string): Promise<AdminMotive> {
  const catalogue = await adminMotives(session);
  const row = catalogue.find(candidate => candidate.label === label);
  if (row === undefined) throw new Error(`el motivo «${label}» no aparece en el catálogo del Almacén`);
  return row;
}

/**
 * Un motivo que el acto bajo prueba no crea: renombrar y archivar se ejercitan sobre una fila que ya
 * existe, y el alta por API la deja donde el acto la va a encontrar. El sello del run evita chocar con
 * el mismo motivo de otra corrida.
 */
export async function arrangeMotive(session: Session, label: string): Promise<AdminMotive> {
  const created = await write<{ category: AdminMotive }>(session, '/api/admin/cash-categories', { label }, 201);
  return created.category;
}

/**
 * Un gasto que el acto bajo prueba no escribe: la corrección se ejercita sobre un movimiento que ya está
 * en el libro. Se registra por la ruta pública del cajón, con la misma sesión y el mismo CSRF que usa la
 * pantalla, y el libro que lo publica es el que la prueba lee después.
 */
export async function arrangeGasto(session: Session,
  draft: { readonly amount: Amount; readonly note: string; readonly categoryId: number }): Promise<number> {
  const created = await write<{ id: number }>(session, '/api/closings/cash-movements', {
    kind: 'gasto', amount: draft.amount.wire, description: draft.note, category_id: draft.categoryId,
  }, 201);
  return created.id;
}

/** Las ventanas cerradas que la pantalla ofrece en su selector de período: las que el lector de métricas
 * ya publica con sus instantes, y ninguna inventada por la prueba (S8). */
export interface SettlementWindow {
  readonly closing_id: number;
  readonly from: string;
  readonly to: string;
  readonly label: string;
}

export async function settlementWindows(session: Session): Promise<readonly SettlementWindow[]> {
  const answer = await read<{ periods: readonly { kind: string; closing_id: number | null; from: string | null; to: string | null; label: string }[] }>(
    session, '/api/metrics?period=all');
  return answer.periods
    .filter(period => period.kind === 'settlement' && period.closing_id !== null
      && period.from !== null && period.to !== null)
    .map(period => ({
      closing_id: period.closing_id as number, from: period.from as string,
      to: period.to as string, label: period.label,
    }));
}

// ---------------------------------------------------------------------------------
// La pantalla del cajón: el libro, la banda y el formulario
// ---------------------------------------------------------------------------------

/** La caja operativa, por su hash propio: la sucursal entra al cajón de su propio mostrador. */
export async function openDrawer(page: Page): Promise<void> {
  await page.goto('/#/caja');
  await expect(page.getByRole('heading', { level: 1, name: 'Caja operativa' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Números del cajón' })).toBeVisible();
}

/** La columna que escribe el operador: el formulario de un movimiento o el de una corrección. */
export function drawerForm(page: Page): Locator {
  return page.getByRole('complementary', { name: 'Registrar movimiento' });
}

/** Uno de los cuatro números de la banda, por el título que la pantalla le pone. */
export function bandValue(page: Page, title: string): Locator {
  return page.locator('dl.cash-band > div.cash-band-cell')
    .filter({ has: page.locator('dt', { hasText: title }) })
    .locator('span.cash-band-value');
}

/** El libro del período: la tabla que firma cada movimiento con su autor y su momento. */
export function bookOfPeriod(page: Page): Locator {
  return page.getByRole('region', { name: 'Libro del período' });
}

/** Una fila del libro por el movimiento que publica: el número que la confirmación no dice. */
export function bookRow(page: Page, id: number): Locator {
  return page.locator(`tr[data-movement-id="${id}"]`);
}

/** La fila que dice un texto único del run: la forma de encontrar el movimiento que el acto acaba de escribir. */
export function rowSaying(page: Page, text: string): Locator {
  return page.locator('tr[data-movement-id]').filter({ hasText: text });
}

/** El identificador que la propia fila publica. */
export async function rowMovementId(row: Locator): Promise<number> {
  const value = await row.getAttribute('data-movement-id');
  if (value === null) throw new Error('la fila del libro no publica el movimiento que describe');
  return Number(value);
}

export interface Recorded {
  readonly id: number;
  readonly row: Locator;
}

/** El acto completo de un gasto: el monto, el motivo de la lista cerrada, la nota y el botón. */
export async function recordGasto(page: Page,
  draft: { readonly amount: Amount; readonly note: string; readonly motive: CashMotive }): Promise<Recorded> {
  const form = drawerForm(page);
  await expect(form.getByRole('button', { name: 'Gasto', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await form.getByLabel('Monto en bolivianos').fill(draft.amount.typed);
  await form.getByLabel('Motivo', { exact: true }).selectOption({ label: draft.motive.label });
  await form.getByLabel('Nota (opcional)').fill(draft.note);
  await form.getByRole('button', { name: 'Registrar gasto' }).click();
  await expect(form.getByRole('status').filter({ hasText: 'Gasto registrado' }))
    .toHaveText('Gasto registrado en el libro de la caja.');
  const row = rowSaying(page, draft.note);
  await expect(row).toHaveCount(1);
  return { id: await rowMovementId(row), row };
}

/** El acto completo de un aporte: el monto, el motivo de texto libre y el botón. */
export async function recordAporte(page: Page,
  draft: { readonly amount: Amount; readonly reason: string }): Promise<Recorded> {
  const form = drawerForm(page);
  await form.getByRole('button', { name: 'Aporte', exact: true }).click();
  await expect(form.getByRole('button', { name: 'Aporte', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await form.getByLabel('Monto en bolivianos').fill(draft.amount.typed);
  await form.getByLabel('Motivo', { exact: true }).fill(draft.reason);
  await form.getByRole('button', { name: 'Registrar aporte' }).click();
  await expect(form.getByRole('status').filter({ hasText: 'Aporte registrado' }))
    .toHaveText('Aporte registrado en el libro de la caja.');
  const row = rowSaying(page, draft.reason);
  await expect(row).toHaveCount(1);
  return { id: await rowMovementId(row), row };
}

/** Una foto JPEG o PNG de un píxel: el comprobante que el contrato decodifica entero, sin recortes. */
export const receiptPhoto: { readonly name: string; readonly mimeType: string; readonly buffer: Buffer } = {
  name: 'comprobante.png',
  mimeType: 'image/png',
  buffer: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
    'base64'),
};

// ---------------------------------------------------------------------------------
// El catálogo de motivos: la pestaña local del Almacén y el selector de la sucursal
// ---------------------------------------------------------------------------------

/**
 * «Motivos de caja» no tiene hash propio: es la pestaña local del catálogo, así que se abre como la abre
 * el operador, desde la tira de secciones de la pantalla de precios.
 */
export async function openMotivesTab(page: Page): Promise<void> {
  await page.goto('/#/catalogo');
  await expect(page.getByRole('heading', { name: 'Catálogo de precios' })).toBeVisible();
  await motivesTab(page).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Motivos de caja' })).toBeVisible();
  await expect(motivesTab(page)).toHaveAttribute('aria-pressed', 'true');
}

/** La pestaña dentro de la tira de secciones del catálogo. */
export function motivesTab(page: Page): Locator {
  return page.getByRole('group', { name: 'Secciones del catálogo' })
    .getByRole('button', { name: 'Motivos de caja', exact: true });
}

/** La fila activa de un motivo: la tabla de archivados repite el atributo y no lleva esta clase. */
export function activeMotiveRow(page: Page, id: number): Locator {
  return page.locator(`tr.catalog-row[data-motive-id="${id}"]`);
}

/** El bloque colapsado de los archivados: su resumen es el que el operador despliega. */
export function archivedMotives(page: Page): Locator {
  return page.locator('details.cash-motives-archived');
}

/**
 * Una segunda pestaña del navegador sobre la sesión de la sucursal A: la pestaña de motivos es del
 * Almacén, así que el efecto sobre el selector de la sucursal se lee desde su propia sesión (S3).
 */
export async function branchDrawerPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ baseURL: origin, storageState: branchASession });
  const page = await context.newPage();
  await openDrawer(page);
  return page;
}
