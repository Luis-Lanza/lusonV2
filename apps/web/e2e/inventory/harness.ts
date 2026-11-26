import type { Locator, Page } from '@playwright/test';
import { expect, type Session } from '../warranty/harness';

/**
 * El arnés de la pantalla de inventario (odd/tasks/e2e-all-flows.md, T2).
 *
 * Reusa el arnés de la vertical de garantías tal cual: la sesión de la sucursal A que abre el
 * proyecto `sesiones`, el fixture `api` que dispone una sesión por rol, y el `test` y el `expect` de
 * Playwright. Este archivo agrega lo que la consulta de stock tiene de propio: la lectura del
 * contrato que el servidor ya publica (`apps/api/docs/inventory-api.md` y `docs/realtime.md`), los
 * datos únicos de cada corrida y los localizadores de la pantalla —la tabla, el paginador y los
 * filtros—. Ningún acto del operador tiene atajo: la consulta y sus filtros se ejercen por la
 * pantalla.
 *
 * El arreglo previo —la batería nueva que la corrida no comparte con nadie y el documento que mueve
 * su stock— va por la API pública de la sesión, nunca por SQL ni por los módulos internos de la
 * aplicación, así que la prueba no puede pasar por coincidir con el código que revisa.
 */

export { branchA, expect, test } from '../warranty/harness';

// ---------------------------------------------------------------------------------
// Datos únicos: dos corridas de la suite nunca chocan en una marca, un modelo ni una clave
// ---------------------------------------------------------------------------------

let sequence = 0;
/** Letras y dígitos en mayúscula, que es lo que una marca y un modelo admiten. */
function stamp(): string {
  sequence += 1;
  return `${Date.now().toString(36)}${sequence}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
}

/** La clave de operación del documento que mueve el stock: `[A-Za-z0-9_-]{16,128}`. */
function operationKey(tag: string): string {
  return `t2-inv-${tag.toLowerCase()}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------------
// La lectura del contrato publicado: una página de inventario tal como la sirve el servidor
// ---------------------------------------------------------------------------------

/** Los tres números de stock de una fila, con la identidad que la pantalla imprime. */
export interface InventoryRow {
  readonly variant_id: number;
  readonly kind: 'battery' | 'other';
  readonly name: string;
  readonly detail: string;
  readonly existing: number;
  readonly reserved: number;
  readonly available: number;
}

export interface InventoryPage {
  readonly location: { readonly id: number; readonly name: string };
  readonly items: readonly InventoryRow[];
  readonly page: number;
  readonly page_size: number;
  readonly total_variants: number;
}

/** Una consulta de stock: los mismos términos que la pantalla arma en su URL. */
export interface InventoryRead {
  readonly locationId: number;
  /** Ausente es el listado de baterías solas, que es el que publica el contrato por defecto. */
  readonly kind?: 'all' | 'battery' | 'other';
  readonly search?: string;
  readonly brand?: string;
  readonly polarity?: 'L' | 'R';
  readonly page?: number;
  readonly size?: number;
}

async function json<T>(reply: { json(): Promise<unknown> }, where: string): Promise<T> {
  try {
    return (await reply.json()) as T;
  } catch {
    throw new Error(`${where}: la respuesta no es JSON`);
  }
}

async function read<T>(session: Session, path: string): Promise<T> {
  const reply = await session.request.get(path);
  if (reply.status() !== 200) throw new Error(`GET ${path} respondió ${reply.status()}: ${await reply.text()}`);
  return json<T>(reply, `GET ${path}`);
}

async function post<T>(session: Session, path: string, body: unknown, expected: number): Promise<T> {
  const reply = await session.request.post(path, { headers: { 'X-CSRF-Token': session.csrf }, data: body });
  if (reply.status() !== expected) {
    throw new Error(`POST ${path} respondió ${reply.status()} en vez de ${expected}: ${await reply.text()}`);
  }
  return json<T>(reply, `POST ${path}`);
}

/** `GET /api/inventory`: la consulta de stock de una ubicación, con sus filtros y su página. */
export async function inventoryPage(session: Session, read_: InventoryRead): Promise<InventoryPage> {
  const params = new URLSearchParams({
    location_id: String(read_.locationId),
    page: String(read_.page ?? 1),
    page_size: String(read_.size ?? 10),
  });
  if (read_.kind !== undefined) params.set('kind', read_.kind);
  if (read_.search) params.set('search', read_.search);
  if (read_.brand) params.set('brand', read_.brand);
  if (read_.polarity) params.set('polarity', read_.polarity);
  return read<InventoryPage>(session, '/api/inventory?' + params.toString());
}

// ---------------------------------------------------------------------------------
// El arreglo: la batería que la corrida no comparte con nadie
// ---------------------------------------------------------------------------------

export interface ArrangedBattery {
  readonly brand: string;
  readonly model: string;
  /** La variante de polaridad L que el Almacén acaba de abrir: nace con saldo cero en todo local. */
  readonly variantId: number;
}

/**
 * Una batería nueva del Almacén, con marca y modelo únicos. No inventa stock: el catálogo abre una
 * fila de saldo cero en cada local activo, y por eso la sucursal A la lista —y la puede contar— sin
 * que ninguna otra prueba de la corrida la toque.
 */
export async function arrangeInventoryBattery(warehouse: Session, tag: string): Promise<ArrangedBattery> {
  const brand = `T2B${tag.toUpperCase()}${stamp()}`;
  const model = `T2M${tag.toUpperCase()}${stamp()}`;
  const created = await post<{ readonly variants: readonly { readonly id: number }[] }>(
    warehouse, '/api/catalog/batteries', { brand, model, capacity_ah: '45', polarities: ['L'] }, 201);
  const variant = created.variants[0];
  if (variant === undefined) throw new Error('el catálogo no devolvió la variante de la batería creada');
  return { brand, model, variantId: variant.id };
}

export interface ArrangedProduct {
  readonly id: number;
  readonly name: string;
}

/**
 * Un producto nuevo del Almacén, con un nombre único, que la sucursal A lista con saldo cero. Es el
 * otro tipo de producto que el filtro de tipo tiene que separar de las baterías sin inventar stock.
 */
export async function arrangeInventoryProduct(warehouse: Session, tag: string): Promise<ArrangedProduct> {
  const name = `Producto T2 ${tag.toUpperCase()} ${stamp()}`;
  const created = await post<{ readonly id: number }>(warehouse, '/api/catalog/other-products', {
    name, fields: [{ name: 'origen', kind: 'text', text: `lote ${stamp()}` }],
  }, 201);
  return { id: created.id, name };
}

/**
 * El arreglo del cambio en vivo: la sucursal cuenta lo que hay sobre su propia góndola y lo aplica, y
 * esa diferencia es la que tiene que llegar a la pantalla abierta. Va por la API pública porque lo que
 * la prueba ejerce es el viaje del cambio hasta la pantalla, no la captura del conteo (esa es la prueba
 * del ajuste).
 */
export async function arrangeCount(branch: Session, variantId: number, counted: number,
  tag: string): Promise<{ readonly id: number }> {
  return post<{ readonly id: number }>(branch, '/api/stock-adjustments', {
    operation_key: operationKey(tag),
    reason: `Conteo de la consulta en vivo ${stamp()}`,
    lines: [{ variant_id: variantId, counted_quantity: counted }],
  }, 201);
}

// ---------------------------------------------------------------------------------
// La pantalla: la tabla, el paginador y los filtros, por sus propias etiquetas
// ---------------------------------------------------------------------------------

/** El inventario de la sesión: la pantalla que la consulta de stock publica en `#/inventario`. */
export async function openInventory(page: Page): Promise<void> {
  await page.goto('/#/inventario');
  await expect(page.getByRole('heading', { level: 1, name: 'Inventario' })).toBeVisible();
  await expect(inventoryRows(page).first()).toBeVisible();
}

/** La sección de resultados, que es la que dice si está cargando, vacía o rota. */
export function results(page: Page): Locator {
  return page.getByRole('region', { name: 'Resultados de inventario' });
}

/** Las filas de la tabla, cada una con la variante que la pantalla nombró. */
export function inventoryRows(page: Page): Locator {
  return results(page).locator('tbody tr[data-variant-id]');
}

/** La fila de una variante, por el id que la propia fila declara. */
export function rowOf(page: Page, variantId: number): Locator {
  return page.locator(`tbody tr[data-variant-id="${variantId}"]`);
}

/** Las pestañas de ubicación: consultar otro local nunca reasigna la cuenta. */
export function stockTabs(page: Page): Locator {
  return page.getByRole('group', { name: 'Vista de stock' });
}

/** La selección de tipo de producto, que sólo existe sobre el listado del propio local. */
export function kindFilter(page: Page): Locator {
  return page.getByRole('group', { name: 'Filtrar por tipo de producto' });
}

export function searchBox(page: Page): Locator {
  return page.getByLabel('Buscar marca, modelo o nombre', { exact: true });
}

export function brandFilter(page: Page): Locator {
  return page.getByLabel('Marca', { exact: true });
}

export function polarityFilter(page: Page): Locator {
  return page.getByLabel('Polaridad', { exact: true });
}

/** El rango que el paginador publica: «Mostrando 1–10 de 190 variantes». */
export function pagerRange(page: Page): Locator {
  return page.locator('.pager .range');
}

export function pageSize(page: Page): Locator {
  return page.getByLabel('Filas por página', { exact: true });
}

export function previousPage(page: Page): Locator {
  return page.getByRole('button', { name: 'Página anterior' });
}

export function nextPage(page: Page): Locator {
  return page.getByRole('button', { name: 'Página siguiente' });
}

export function currentPage(page: Page): Locator {
  return page.locator('.pager .current-page');
}

/** El guion que el paginador y la tabla usan entre dos números: `–`, no un guion corto. */
const enDash = '\u2013';

/** La etiqueta exacta del rango, compuesta como la pantalla la compone. */
export function rangeLabel(first: number, last: number, total: number): string {
  return `Mostrando ${first}${enDash}${last} de ${total} variantes`;
}

/** El total que el paginador está publicando en este momento. */
export async function shownTotal(page: Page): Promise<number> {
  const text = (await pagerRange(page).textContent()) ?? '';
  const match = /de\s+(\d+)\s+variantes/.exec(text);
  if (match === null) throw new Error(`el paginador no publica el total: «${text}»`);
  return Number(match[1]);
}

/** Una fila leída de la pantalla, con la forma con la que el contrato la publica. */
export type ScreenRow = InventoryRow;

/**
 * Las filas que la pantalla está mostrando ahora, en su orden. La celda de «Disponibles» lleva el
 * distintivo de la fila sin disponibilidad, así que se lee el número y no el texto entero.
 */
export async function screenRows(page: Page): Promise<ScreenRow[]> {
  const rows = inventoryRows(page);
  const count = await rows.count();
  const read: ScreenRow[] = [];
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    const cells = row.locator('td');
    const available = ((await cells.nth(4).textContent()) ?? '').replace(/Sin disponible/g, '').trim();
    read.push({
      variant_id: Number(await row.getAttribute('data-variant-id')),
      kind: (await row.getAttribute('data-kind')) === 'other' ? 'other' : 'battery',
      name: ((await cells.nth(0).locator('.name').textContent()) ?? '').trim(),
      detail: ((await cells.nth(1).textContent()) ?? '').trim(),
      existing: Number(((await cells.nth(2).textContent()) ?? '').trim()),
      reserved: Number(((await cells.nth(3).textContent()) ?? '').trim()),
      available: Number(available),
    });
  }
  return read;
}

/**
 * Las filas de la consulta ya cargada. La pantalla vacía la tabla mientras lee —una consulta manual
 * deja la sección sin filas hasta que vuelve la respuesta—, así que se espera a que publique la
 * cantidad de filas de la página que el contrato devuelve, y recién entonces se leen.
 */
export async function loadedRows(page: Page, expected: number): Promise<ScreenRow[]> {
  await expect(inventoryRows(page)).toHaveCount(expected);
  return screenRows(page);
}

/** Las mismas filas, pero del contrato: es con esto que la pantalla se contrasta. La celda de detalle
 * de la tabla calla el detalle cuando repite el nombre, así que el contrato se lee con esa misma
 * regla y no con una segunda forma de la fila.
 */
export function contractRows(page: InventoryPage): ScreenRow[] {
  return page.items.map(item => ({
    variant_id: item.variant_id, kind: item.kind, name: item.name,
    detail: item.detail === item.name ? '' : item.detail,
    existing: item.existing, reserved: item.reserved, available: item.available,
  }));
}
