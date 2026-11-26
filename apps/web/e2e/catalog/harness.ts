import type { APIResponse, Locator, Page } from '@playwright/test';
import { expect, type Session } from '../warranty/harness';

/**
 * El arnés del catálogo (S2, S3, S4).
 *
 * Reusa el arnés de la vertical de garantías tal cual: la sesión del Almacén abierta por
 * `e2e/warranty/auth.setup.ts` (`warehouseRole`), el fixture `api` que dispone una sesión por rol, el
 * `test` y el `expect` de Playwright. Este archivo sólo agrega lo que el catálogo tiene de propio: las
 * cuatro pantallas de la sección, el alta por API de lo que el acto no ejercita —la batería que se
 * edita, el producto que se edita, el proveedor que se edita— y las lecturas con las que se contrasta
 * lo que la pantalla afirmó, siempre por el contrato que el servidor ya publica (`apps/api/docs/`:
 * `branch-prices.md`, `catalog-batteries.md`, `other-products.md`, `suppliers.md`).
 *
 * Nada de acá importa módulos de la aplicación: la prueba no puede pasar por coincidir con el código
 * que revisa. Cada arreglo lleva su propio sello —marca, modelo, nombre y contacto únicos— porque la
 * base es una sola y las demás suites del pedido corren contra ella al mismo tiempo (S4).
 */

export { expect, test, warehouseRole } from '../warranty/harness';
export type { Session } from '../warranty/harness';
export { warehouseSessionState } from '../warranty/sessions';

/** El local de la sucursal A: el destino que la pantalla de precios ofrece con su nombre. */
export const branchAName = 'Sucursal A';
export const branchAId = 2;

// ---------------------------------------------------------------------------------
// Datos propios de cada corrida: ningún modelo, precio ni proveedor se repite
// ---------------------------------------------------------------------------------

let sequence = 0;
/** Mayúsculas y dígitos: lo que admite el nombre de una marca, un modelo o un proveedor. */
export function uniqueTag(): string {
  sequence += 1;
  return `${Date.now().toString(36)}${sequence}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
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

async function write<T>(session: Session, method: 'post' | 'patch' | 'put' | 'delete', path: string,
  body: unknown, expected: number): Promise<T> {
  const reply = await session.request[method](path, { headers: { 'X-CSRF-Token': session.csrf }, data: body });
  return answered<T>(reply, `${method.toUpperCase()} ${path}`, expected);
}

/** Un par mínimo/sugerido de una sucursal, con los dos montos como texto decimal canónico. */
export interface BranchPrice {
  readonly branch_location_id: number;
  readonly min_price: string;
  readonly suggested_price: string;
}

/** Una fila de la matriz de precios: una batería o un producto, discriminados por su tipo. */
export interface MatrixRow {
  readonly kind: 'battery' | 'other';
  readonly catalog_entry_id: number;
  readonly brand?: string;
  readonly model?: string;
  readonly capacity_ah?: string;
  readonly polarities?: readonly string[];
  readonly cells?: readonly string[];
  readonly name?: string;
  readonly detail?: string;
  readonly prices: readonly BranchPrice[];
}

export interface PriceMatrix {
  readonly branches: readonly { readonly id: number; readonly name: string }[];
  readonly rows: readonly MatrixRow[];
  readonly page: number;
  readonly page_size: number;
  readonly total: number;
}

/**
 * Una página de la matriz, la misma que la pantalla lee: es la única lectura que publica el catálogo
 * de baterías y la que hace comparables las dos pestañas de precios.
 */
export async function priceMatrix(session: Session, kind: 'battery' | 'other' | '', search: string,
  pageSize = 10): Promise<PriceMatrix> {
  const params = new URLSearchParams();
  if (kind !== '') params.set('kind', kind);
  if (search !== '') params.set('search', search);
  params.set('page', '1');
  params.set('page_size', String(pageSize));
  return read<PriceMatrix>(session, `/api/catalog/prices?${params.toString()}`);
}

/** La fila de una entrada concreta, buscada por su identidad: la matriz o el motivo de no estar. */
export async function priceRow(session: Session, kind: 'battery' | 'other', search: string,
  entryId: number): Promise<MatrixRow> {
  const matrix = await priceMatrix(session, kind, search);
  const row = matrix.rows.find(candidate => candidate.catalog_entry_id === entryId);
  if (row === undefined) {
    throw new Error(`la entrada ${entryId} no aparece en la matriz de precios de ${kind} con la búsqueda «${search}»`);
  }
  return row;
}

export interface BatteryDraft {
  readonly brand: string;
  readonly model: string;
  readonly capacity_ah: string;
  readonly polarities: readonly ('L' | 'R')[];
}

export interface BatteryRecord {
  readonly id: number;
  readonly brand: string;
  readonly model: string;
  readonly capacity_ah: string;
  readonly variants: readonly { readonly id: number; readonly polarity: 'L' | 'R' }[];
  readonly priced_branches: number;
}

/** Una batería del catálogo, creada por el contrato público: crear no es lo que la edición ejercita. */
export async function createBattery(session: Session, draft: BatteryDraft): Promise<BatteryRecord> {
  return write<BatteryRecord>(session, 'post', '/api/catalog/batteries', draft, 201);
}

export type OtherFieldInput =
  | { readonly name: string; readonly kind: 'number'; readonly number: string; readonly unit?: string }
  | { readonly name: string; readonly kind: 'text'; readonly text: string };

export type OtherFieldRecord =
  | { readonly name: string; readonly kind: 'number'; readonly number: string; readonly unit: string | null }
  | { readonly name: string; readonly kind: 'text'; readonly text: string };

export interface OtherProductRecord {
  readonly id: number;
  readonly name: string;
  readonly fields: readonly OtherFieldRecord[];
}

export interface OtherProductPage {
  readonly products: readonly OtherProductRecord[];
  readonly page: number;
  readonly page_size: number;
  readonly total_products: number;
}

/** Un producto del catálogo, creado por el contrato público. */
export async function createOtherProduct(session: Session,
  draft: { readonly name: string; readonly fields: readonly OtherFieldInput[] }): Promise<OtherProductRecord> {
  return write<OtherProductRecord>(session, 'post', '/api/catalog/other-products', draft, 201);
}

/** El producto por su nombre, leído de la lista activa: la lectura que la pantalla hace. */
export async function otherProductByName(session: Session, name: string): Promise<OtherProductRecord> {
  const params = new URLSearchParams({ search: name, page: '1', page_size: '10' });
  const page = await read<OtherProductPage>(session, `/api/catalog/other-products?${params.toString()}`);
  const record = page.products.find(candidate => candidate.name === name);
  if (record === undefined) throw new Error(`el producto «${name}» no aparece en el catálogo activo`);
  return record;
}

export interface SupplierRecord {
  readonly id: number;
  readonly name: string;
  readonly contact: string;
}

/** Una entrada de catálogo que un proveedor ofrece: la batería por marca y modelo, el producto por nombre. */
export interface SupplierOffer {
  readonly catalog_entry_id: number;
  readonly kind: 'battery' | 'other';
  readonly brand: string | null;
  readonly model: string | null;
  readonly capacity_ah: string | null;
  readonly name: string | null;
}

export interface SupplierDetail {
  readonly id: number;
  readonly name: string;
  readonly contact: string;
  readonly retired: boolean;
  readonly offers: readonly SupplierOffer[];
  readonly kinds: readonly string[];
}

/** Un proveedor del almacén, creado por el contrato público. */
export async function createSupplier(session: Session,
  draft: { readonly name: string; readonly contact: string }): Promise<SupplierRecord> {
  return write<SupplierRecord>(session, 'post', '/api/suppliers', draft, 201);
}

/** El proveedor con el conjunto completo de lo que ofrece: la lectura que la pantalla usa. */
export async function supplierDetail(session: Session, id: number): Promise<SupplierDetail> {
  return read<SupplierDetail>(session, `/api/suppliers/${id}`);
}

export interface SupplierCatalogItem {
  readonly variant_id: number;
  readonly kind: 'battery' | 'other';
  readonly name: string;
  readonly detail: string;
  readonly catalog_entry_id: number;
}

/**
 * El catálogo del proveedor: las variantes de las entradas que ofrece, que es lo que Ingresos lee para
 * elegir un producto. Una batería ofrecida se publica con sus dos polaridades; un producto, con la suya.
 */
export async function supplierCatalog(session: Session, id: number,
  search = ''): Promise<readonly SupplierCatalogItem[]> {
  // La lectura no lleva página: el contrato publica el conjunto entero y acepta sólo tipo y búsqueda.
  const params = new URLSearchParams();
  if (search !== '') params.set('search', search);
  const query = params.toString();
  const page = await read<{ items: readonly SupplierCatalogItem[]; page_size: number }>(
    session, `/api/suppliers/${id}/catalog${query === '' ? '' : `?${query}`}`);
  return page.items;
}

// ---------------------------------------------------------------------------------
// Las cuatro pantallas, por su hash propio: el operador entra por la navegación
// ---------------------------------------------------------------------------------

/** La matriz de precios, que vive en el hash de la sección. */
export async function openCatalogPrices(page: Page): Promise<void> {
  await page.goto('/#/catalogo');
  await expect(page.getByRole('heading', { name: 'Catálogo de precios' })).toBeVisible();
}

export async function openCatalogBatteries(page: Page): Promise<void> {
  await page.goto('/#/catalogo/baterias');
  await expect(page.getByRole('heading', { name: 'Baterías del catálogo' })).toBeVisible();
}

export async function openCatalogOtherProducts(page: Page): Promise<void> {
  await page.goto('/#/catalogo/otros-productos');
  await expect(page.getByRole('heading', { name: 'Otros productos del catálogo' })).toBeVisible();
}

export async function openCatalogSuppliers(page: Page): Promise<void> {
  await page.goto('/#/catalogo/proveedores');
  await expect(page.getByRole('heading', { name: 'Proveedores del almacén' })).toBeVisible();
}

/** Las pestañas de la sección: la misma tira que el Almacén usa para cambiar de pantalla. */
export function catalogTab(page: Page, name: 'Precios' | 'Baterías' | 'Otros productos' | 'Proveedores'): Locator {
  return page.getByRole('group', { name: 'Secciones del catálogo' })
    .getByRole('button', { name, exact: true });
}

/**
 * La fila de un proveedor en la lista. La pantalla no tiene búsqueda, así que la única forma de llegar a
 * un proveedor es la que el operador tiene: elegir la página más ancha y recorrer las páginas hasta la
 * fila. La espera es la del pager, que publica el rango de la página ya leída, nunca un tiempo fijo.
 */
export async function showSupplierRow(page: Page, id: number): Promise<Locator> {
  const row = page.locator(`tr[data-supplier-id="${id}"]`);
  const range = page.locator('.range');
  const current = page.locator('.current-page');
  const pageSize = 50;
  await page.getByLabel('Proveedores por página').selectOption(String(pageSize));
  await expect(range).toContainText(`Mostrando 1–`);
  for (let number = 1; number <= 20; number += 1) {
    if (await row.count() > 0) return row;
    const next = page.getByRole('button', { name: 'Siguiente página' });
    if (await next.isDisabled()) break;
    await next.click();
    await expect(current).toHaveText(String(number + 1));
    await expect(range).toContainText(`Mostrando ${number * pageSize + 1}–`);
  }
  await expect(row).toHaveCount(1);
  return row;
}
