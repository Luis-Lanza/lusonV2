import type { APIResponse, Locator, Page } from '@playwright/test';
import { expect, type Session } from '../warranty/harness';

/**
 * El arnés de la administración y de «Mi contraseña» (S2, S3, S4).
 *
 * Reusa el arnés de la vertical de garantías tal cual: la sesión del Almacén que abre
 * `e2e/warranty/auth.setup.ts` (`warehouseRole`), el fixture `api` que dispone una sesión por rol y el
 * `test`/`expect` de Playwright. Este archivo sólo agrega lo que estas pantallas tienen de propio: las
 * dos pantallas del panel —el directorio de cuentas y las sucursales— más el cambio de contraseña, el
 * alta por API de lo que el acto no ejercita (la cuenta cuyo acceso se cambia, la sucursal que recibe
 * fondos) y las lecturas con las que se contrasta lo que la pantalla afirmó: siempre el contrato que el
 * servidor ya publica (`apps/api/docs/administration.md` y `authentication.md`).
 *
 * Nada de acá importa módulos de la aplicación: la prueba no puede pasar por coincidir con el código
 * que revisa. Cada arreglo lleva su propio sello —usuario, nombre, sucursal y contraseñas únicas—
 * porque la base es una sola y las demás suites del pedido corren contra ella al mismo tiempo (S4).
 * Lo que estas pruebas crean es sólo suyo: las tres cuentas de la semilla (`bot_almacen`,
 * `bot_sucursal_a`, `bot_sucursal_b`) y las sucursales que ya existen nunca se modifican, se desactivan
 * ni se retiran, y ninguna sucursal con stock, usuarios u operaciones se toca.
 */

export { expect, test, origin, warehouseRole } from '../warranty/harness';
export type { Session } from '../warranty/harness';
export { warehouseSessionState } from '../warranty/sessions';

/** La sucursal A: la sucursal que existe a la que se asignan las cuentas de estas pruebas. */
export const branchAId = 2;
export const branchAName = 'Sucursal A';

// ---------------------------------------------------------------------------------
// Datos propios de cada corrida: ningún usuario ni sucursal se repite
// ---------------------------------------------------------------------------------

let sequence = 0;
/** Mayúsculas y dígitos: lo que admiten el nombre de una sucursal y el de una persona. */
export function uniqueTag(): string {
  sequence += 1;
  return `${Date.now().toString(36)}${sequence}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
}

/** Un usuario de 3 a 64 letras ASCII, números, punto, guion o guion bajo, propio de la corrida. */
export function uniqueUsername(tag: string): string {
  return `op.${tag.toLowerCase()}`;
}

// ---------------------------------------------------------------------------------
// La API de la misma sesión: el arreglo previo y la lectura de lo persistido
// ---------------------------------------------------------------------------------

async function answered<T>(reply: APIResponse, where: string, expected: number): Promise<T> {
  if (reply.status() !== expected) {
    throw new Error(`${where} respondió ${reply.status()} en vez de ${expected}: ${await reply.text()}`);
  }
  if (expected === 204) return undefined as T;
  return (await reply.json()) as T;
}

async function read<T>(session: Session, path: string): Promise<T> {
  return answered<T>(await session.request.get(path), `GET ${path}`, 200);
}

async function write<T>(session: Session, method: 'post' | 'patch' | 'delete', path: string,
  body: unknown, expected: number): Promise<T> {
  const reply = await session.request[method](path, { headers: { 'X-CSRF-Token': session.csrf }, data: body });
  return answered<T>(reply, `${method.toUpperCase()} ${path}`, expected);
}

/** Una cuenta del directorio, tal como el contrato la publica. */
export interface AccountRecord {
  readonly id: string;
  readonly username: string;
  readonly display_name: string;
  readonly location_id: number;
  readonly enabled: boolean;
  readonly must_change_password: boolean;
}

/** Una sucursal del directorio: el mismo par `{id, name}` de todas las lecturas de ubicación. */
export interface BranchRecord {
  readonly id: number;
  readonly name: string;
}

/** Los dos saldos de una sucursal, con el signo que el servidor leyó de los libros. */
export interface BalanceRecord {
  readonly branch_id: number;
  readonly cash_balance: string;
  readonly fund_balance: string;
  readonly frozen: boolean;
}

/** La comisión configurada de una sucursal, con la cuenta y el momento que la fijaron. */
export interface CommissionRecord {
  readonly branch_location_id: number;
  readonly commission_rate_percent: string;
  readonly updated_at: string;
  readonly updated_by: string;
}

export interface AccountDraft {
  readonly username: string;
  readonly display_name: string;
  readonly location_id: number;
  readonly temporary_password: string;
}

export interface BranchDraft {
  readonly name: string;
  readonly opening_cash: string;
  readonly purchase_fund: string;
}

/** El directorio de cuentas: la lectura que la pestaña «Usuarios» hace. */
export async function listAccounts(session: Session): Promise<readonly AccountRecord[]> {
  return read<AccountRecord[]>(session, '/api/admin/accounts');
}

/**
 * La cuenta por su usuario en el directorio, o `null` cuando ya no está: un usuario retirado deja de
 * publicarse en la misma lectura, que es la única forma de afirmar su baja sin mirar la base (S3).
 */
export async function findAccount(session: Session, username: string): Promise<AccountRecord | null> {
  const accounts = await listAccounts(session);
  return accounts.find(account => account.username === username) ?? null;
}

/** La cuenta por su usuario: el directorio, o el motivo por el que no está. */
export async function accountByUsername(session: Session, username: string): Promise<AccountRecord> {
  const account = await findAccount(session, username);
  if (account === null) throw new Error(`la cuenta «${username}» no aparece en el directorio`);
  return account;
}

/** Una cuenta de sucursal creada por el contrato público: crearla por pantalla es otro acto. */
export async function createAccount(session: Session, draft: AccountDraft): Promise<AccountRecord> {
  return write<AccountRecord>(session, 'post', '/api/admin/accounts', draft, 201);
}

/** La baja de una cuenta propia de la corrida: retirar la que el acto creó, nunca una de otro. */
export async function deleteAccount(session: Session, id: string): Promise<void> {
  await write<void>(session, 'delete', `/api/admin/accounts/${id}`, undefined, 204);
}

/** El directorio de sucursales, con el Almacén como contexto. */
export async function listBranches(session: Session): Promise<readonly BranchRecord[]> {
  return read<BranchRecord[]>(session, '/api/admin/branches');
}

export async function findBranch(session: Session, name: string): Promise<BranchRecord | null> {
  const branches = await listBranches(session);
  return branches.find(branch => branch.name === name) ?? null;
}

export async function branchByName(session: Session, name: string): Promise<BranchRecord> {
  const branch = await findBranch(session, name);
  if (branch === null) throw new Error(`la sucursal «${name}» no aparece en el directorio`);
  return branch;
}

/** Una sucursal con su plata de nacimiento, creada por el contrato público. */
export async function createBranch(session: Session, draft: BranchDraft): Promise<BranchRecord> {
  return write<BranchRecord>(session, 'post', '/api/admin/branches', draft, 201);
}

/** La baja de una sucursal propia de la corrida: la que el acto creó y nadie más usa. */
export async function deleteBranch(session: Session, id: number): Promise<void> {
  await write<void>(session, 'delete', `/api/admin/branches/${id}`, undefined, 204);
}

/** Los dos libros de cada sucursal viva: la lectura que la tarjeta de la pantalla publica. */
export async function branchBalances(session: Session): Promise<readonly BalanceRecord[]> {
  return read<BalanceRecord[]>(session, '/api/admin/branches/balances');
}

export async function balanceOf(session: Session, branchId: number): Promise<BalanceRecord> {
  const books = await branchBalances(session);
  const book = books.find(row => row.branch_id === branchId);
  if (book === undefined) throw new Error(`la sucursal ${branchId} no publica saldos`);
  return book;
}

/** Las comisiones configuradas: la lectura que el panel usa para decir quién fijó qué tasa y cuándo. */
export async function commissions(session: Session): Promise<readonly CommissionRecord[]> {
  return read<CommissionRecord[]>(session, '/api/closings/branches/commissions');
}

export async function commissionOf(session: Session, branchId: number): Promise<CommissionRecord | null> {
  const rates = await commissions(session);
  return rates.find(rate => rate.branch_location_id === branchId) ?? null;
}

// ---------------------------------------------------------------------------------
// Las pantallas, por su hash propio: el operador entra por la navegación
// ---------------------------------------------------------------------------------

/** El directorio de cuentas, que vive en el hash de la sección. */
export async function openAdministration(page: Page): Promise<void> {
  await page.goto('/#/administracion');
  await expect(page.getByRole('heading', { name: 'Usuarios y sucursales' })).toBeVisible();
}

/** La pestaña de sucursales, que tiene su hash propio. */
export async function openBranchesPanel(page: Page): Promise<void> {
  await page.goto('/#/administracion/sucursales');
  await expect(page.getByRole('heading', { name: 'Sucursales', exact: true })).toBeVisible();
}

/** Las dos pestañas del panel: la misma tira que el Almacén usa para cambiar de pantalla. */
export function administrationTab(page: Page, name: 'Usuarios' | 'Sucursales'): Locator {
  return page.getByRole('group', { name: 'Vistas de administración' })
    .getByRole('button', { name, exact: true });
}

/** La búsqueda del directorio, que es cómo el operador llega a una cuenta entre muchas. */
export async function searchAccounts(page: Page, term: string): Promise<void> {
  await page.getByLabel('Buscar usuario').fill(term);
}

/** La fila de una cuenta en el directorio, alcanzada por su botón de gestión. */
export function accountRow(page: Page, username: string): Locator {
  return page.getByRole('row').filter({ has: page.getByRole('button', { name: `Gestionar ${username}`, exact: true }) });
}

/** El panel de gestión de una cuenta: el que edita su nombre, su sucursal y su acceso. */
export function accountEditor(page: Page): Locator {
  return page.getByRole('region', { name: 'Gestión de cuenta' });
}

/** El panel de alta de una cuenta de sucursal. */
export function accountCreation(page: Page): Locator {
  return page.getByRole('region', { name: 'Creación de cuenta' });
}

/** La entrega privada de la contraseña temporal, la única vez que el secreto se puede leer. */
export function passwordHandoff(page: Page): Locator {
  return page.getByRole('region', { name: 'Entrega privada de contraseña' });
}

/** El formulario de restablecimiento, que es el segundo formulario del panel de gestión. */
export function passwordResetForm(page: Page): Locator {
  return accountEditor(page).locator('form')
    .filter({ has: page.getByRole('heading', { name: 'Restablecer contraseña', exact: true }) });
}

/** La tarjeta de una sucursal en la pestaña de sucursales: su nombre es el título del artículo. */
export function branchCard(page: Page, name: string): Locator {
  return page.getByRole('heading', { name, level: 3, exact: true }).locator('..');
}

/** Los dos saldos que la tarjeta de una sucursal publica. */
export function branchBook(page: Page, name: string): Locator {
  return page.getByRole('region', { name: `Saldos de ${name}` });
}

/** El formulario de alta de sucursal: el único de la pantalla que no vive en una tarjeta. */
export function branchCreation(page: Page): Locator {
  return page.getByRole('heading', { name: 'Crear sucursal', exact: true }).locator('..');
}

/**
 * El ingreso del operador, por el formulario real. Estas pruebas firman sesiones propias sólo cuando
 * el acto es el ingreso mismo —una contraseña temporal que se usa, una cuenta desactivada que pierde su
 * sesión, la contraseña nueva que abre la cuenta—: el resto corre sobre la sesión del Almacén que el
 * proyecto de sesiones ya abrió, porque el servidor admite diez ingresos por minuto y por dirección.
 */
export async function signIn(page: Page, username: string, password: string): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Usuario').fill(username);
  // El botón del ojo lleva «Contraseña» en su etiqueta accesible: el campo se nombra por su rol.
  await page.getByRole('textbox', { name: 'Contraseña' }).fill(password);
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();
}
