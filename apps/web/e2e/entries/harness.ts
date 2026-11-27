import type { APIResponse, Locator, Page } from '@playwright/test';
import { expect, type Session } from '../warranty/harness';

/**
 * El arnés de los ingresos de almacén (odd/tasks/e2e-all-flows.md, T9).
 *
 * Reusa el arnés de la vertical de garantías tal cual: la sesión del Almacén abierta por
 * `e2e/warranty/auth.setup.ts`, el fixture `api` que dispone una sesión por rol y el `test` y el
 * `expect` de Playwright. Este archivo sólo agrega lo que el ingreso tiene de propio: la pantalla
 * `#/ingresos` con su selector de proveedor, su catálogo y su historial, el arreglo por la API pública
 * de la misma sesión —el proveedor, la batería y el documento que cada acto no ejercita— y las lecturas
 * con las que se contrasta lo que la pantalla afirmó, siempre por el contrato que el servidor ya
 * publica (`apps/api/docs/stock-entries.md`, `suppliers.md`, `catalog-batteries.md`,
 * `other-products.md` e `inventory-api.md`).
 *
 * Nada de acá importa módulos de la aplicación: la prueba no puede pasar por coincidir con el código
 * que revisa. Cada arreglo lleva el sello de la corrida —marca, modelo, nombre de proveedor y nota
 * únicos— porque la base es una sola y las demás suites del pedido corren contra ella al mismo tiempo
 * (S4). El proveedor se llama `ZZZ…` a propósito: ordena último en la lista que la pantalla publica, así
 * que sólo es elegible si esa lista es la completa y no la primera página. Antes se llamaba `AAA…` para
 * entrar en la única página que la pantalla pedía: ese arreglo tapaba el defecto que
 * `supplier-catalog.spec.ts` ahora prueba.
 */

export { expect, test, warehouseRole } from '../warranty/harness';
export type { Session } from '../warranty/harness';
export { warehouseSessionState } from '../warranty/sessions';

/** El almacén es el local 1: el único que registra ingresos y el que la pantalla rotula ALMACÉN. */
export const warehouseId = 1;

// ---------------------------------------------------------------------------------
// Datos únicos: dos corridas de la suite nunca chocan en una marca, un modelo ni una nota
// ---------------------------------------------------------------------------------

let sequence = 0;
/** Letras y dígitos en mayúscula: lo que admiten una marca, un modelo y un nombre de proveedor. */
function stamp(): string {
  sequence += 1;
  return `${Date.now().toString(36)}${sequence}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
}

/**
 * El nombre del proveedor de la corrida. Ordena **último** en la lista que publica `GET /api/suppliers`
 * (`lower(name), id`, con los retirados al final), que es lo que el selector de Ingresos tiene que
 * publicar entero para poder elegirlo: el contrato de esa lectura admite sólo `page` y `page_size`, sin
 * búsqueda, así que un selector que pidiera una sola página dejaría este proveedor afuera. Un nombre
 * "natural", además: el `AAA…` anterior existía únicamente por ese defecto.
 */
function supplierName(tag: string): string {
  return `ZZZ T9 ${tag}`;
}

/** El sello de la corrida, para que las notas y los motivos tampoco se repitan. */
export function uniqueTag(): string {
  return stamp();
}

function operationKey(tag: string): string {
  return `t9-entry-${tag.toLowerCase()}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
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

async function write<T>(session: Session, method: 'post' | 'put', path: string, body: unknown,
  expected: number): Promise<T> {
  const reply = await session.request[method](path, { headers: { 'X-CSRF-Token': session.csrf }, data: body });
  return answered<T>(reply, `${method.toUpperCase()} ${path}`, expected);
}

// ---------------------------------------------------------------------------------
// El arreglo: un proveedor nuevo, su producto y su stock, que ninguna otra prueba toca
// ---------------------------------------------------------------------------------

export interface BatteryRecord {
  readonly id: number;
  readonly brand: string;
  readonly model: string;
  readonly capacity_ah: string;
  readonly variants: readonly { readonly id: number; readonly polarity: 'L' | 'R' }[];
}

/** Una batería del catálogo, creada por el contrato público: el ingreso es el acto que se ejerce. */
export async function createBattery(session: Session, draft: {
  readonly brand: string; readonly model: string; readonly capacityAh: string;
  readonly polarities: readonly ('L' | 'R')[];
}): Promise<BatteryRecord> {
  return write<BatteryRecord>(session, 'post', '/api/catalog/batteries', {
    brand: draft.brand, model: draft.model, capacity_ah: draft.capacityAh, polarities: draft.polarities,
  }, 201);
}

export interface OtherProductRecord {
  readonly id: number;
  readonly name: string;
}

/** Un producto del catálogo libre: el otro tipo que un ingreso puede traer. */
export async function createOtherProduct(session: Session, name: string): Promise<OtherProductRecord> {
  return write<OtherProductRecord>(session, 'post', '/api/catalog/other-products', {
    name, fields: [{ name: 'origen', kind: 'text', text: `lote ${stamp()}` }],
  }, 201);
}

export interface SupplierRecord {
  readonly id: number;
  readonly name: string;
  readonly contact: string;
}

/** Un proveedor del almacén, creado por el contrato público: elegirlo es el acto que se ejerce. */
export async function createSupplier(session: Session, name: string, contact = ''): Promise<SupplierRecord> {
  return write<SupplierRecord>(session, 'post', '/api/suppliers', { name, contact }, 201);
}

export interface SupplierDetailRecord {
  readonly id: number;
  readonly name: string;
  readonly retired: boolean;
  readonly offers: readonly { readonly catalog_entry_id: number; readonly kind: 'battery' | 'other' }[];
  readonly kinds: readonly ('battery' | 'other')[];
}

/** El conjunto completo de lo que el proveedor ofrece, que es lo que el ingreso puede nombrar. */
export async function assignOffers(session: Session, supplierId: number,
  catalogEntryIds: readonly number[]): Promise<SupplierDetailRecord> {
  return write<SupplierDetailRecord>(session, 'put', `/api/suppliers/${supplierId}/offers`,
    { catalog_entry_ids: catalogEntryIds }, 200);
}

export interface SupplierCatalogVariant {
  readonly variant_id: number;
  readonly kind: 'battery' | 'other';
  readonly name: string;
  readonly detail: string;
  readonly catalog_entry_id: number;
  readonly battery: { readonly brand: string; readonly model: string; readonly capacity_ah: string;
    readonly polarity: 'L' | 'R' } | null;
}

/**
 * Las variantes que el proveedor ofrece, que es el único catálogo que un ingreso puede nombrar. La
 * prueba toma de acá los ids que después busca en el documento persistido, nunca de una lista propia.
 */
export async function supplierCatalog(session: Session, supplierId: number, kind: 'battery' | 'other',
  search = ''): Promise<readonly SupplierCatalogVariant[]> {
  const params = new URLSearchParams({ kind });
  if (search !== '') params.set('search', search);
  const page = await read<{ items: readonly SupplierCatalogVariant[]; page_size: number }>(
    session, `/api/suppliers/${supplierId}/catalog?${params.toString()}`);
  return page.items;
}

export interface ArrangedBatterySupplier {
  readonly supplierId: number;
  readonly supplierName: string;
  readonly batteryId: number;
  readonly brand: string;
  readonly model: string;
  readonly capacityAh: string;
  readonly variants: readonly { readonly variantId: number; readonly polarity: 'L' | 'R' }[];
}

/**
 * Un proveedor nuevo que ofrece una sola batería nueva, con marca y modelo únicos: es el proveedor que la
 * pantalla lista **último** por su nombre y el producto que su catálogo publica. La batería nace con saldo
 * cero en todo local, así que el stock que el ingreso mueve es exactamente el de esta corrida.
 */
export async function arrangeBatterySupplier(session: Session,
  options: { readonly polarities?: readonly ('L' | 'R')[]; readonly capacityAh?: string } = {}):
  Promise<ArrangedBatterySupplier> {
  const tag = stamp();
  const brand = `T9B${tag}`;
  const model = `T9M${tag}`;
  const capacityAh = options.capacityAh ?? '45';
  const battery = await createBattery(session, {
    brand, model, capacityAh, polarities: options.polarities ?? ['L'],
  });
  const name = supplierName(tag);
  const supplier = await createSupplier(session, name);
  const detail = await assignOffers(session, supplier.id, [battery.id]);
  if (!detail.kinds.includes('battery')) throw new Error('el proveedor no quedó ofreciendo la batería creada');
  const items = await supplierCatalog(session, supplier.id, 'battery');
  return {
    supplierId: supplier.id, supplierName: name, batteryId: battery.id, brand, model, capacityAh,
    variants: items.flatMap(item => item.battery === null ? []
      : [{ variantId: item.variant_id, polarity: item.battery.polarity }]),
  };
}

export interface ArrangedMixedSupplier {
  readonly supplierId: number;
  readonly supplierName: string;
  readonly battery: ArrangedBatterySupplier;
  readonly productId: number;
  readonly productName: string;
  readonly productVariantId: number;
}

/**
 * Un proveedor que ofrece una batería y un producto libre: es el único caso en que la pantalla tiene
 * que preguntar el tipo del documento antes de abrir un catálogo, porque un documento nunca mezcla.
 */
export async function arrangeMixedSupplier(session: Session): Promise<ArrangedMixedSupplier> {
  const tag = stamp();
  const brand = `T9B${tag}`;
  const model = `T9M${tag}`;
  const battery = await createBattery(session, { brand, model, capacityAh: '45', polarities: ['L'] });
  const productName = `Producto T9 ${tag}`;
  const product = await createOtherProduct(session, productName);
  const name = supplierName(tag);
  const supplier = await createSupplier(session, name);
  const detail = await assignOffers(session, supplier.id, [battery.id, product.id]);
  if (detail.kinds.length !== 2) throw new Error('el proveedor no quedó ofreciendo los dos tipos');
  const items = await supplierCatalog(session, supplier.id, 'battery');
  const variants = items.flatMap(item => item.battery === null ? []
    : [{ variantId: item.variant_id, polarity: item.battery.polarity }]);
  const products = await supplierCatalog(session, supplier.id, 'other');
  const productVariant = products[0];
  if (productVariant === undefined) throw new Error('el catálogo del proveedor no publicó el producto ofrecido');
  return {
    supplierId: supplier.id, supplierName: name, productId: product.id, productName,
    productVariantId: productVariant.variant_id,
    battery: {
      supplierId: supplier.id, supplierName: name, batteryId: battery.id, brand, model, capacityAh: '45', variants,
    },
  };
}

// ---------------------------------------------------------------------------------
// Los documentos: el contrato de creación, de detalle y del historial
// ---------------------------------------------------------------------------------

export interface EntryLine {
  readonly variant_id: number;
  readonly kind: 'battery' | 'other';
  readonly name: string;
  readonly detail: string;
  readonly battery: { readonly brand: string; readonly model: string; readonly capacity_ah: string;
    readonly polarity: 'L' | 'R' } | null;
  readonly quantity: number;
}

/** Un documento persistido, con la forma que publica el contrato de detalle. */
export interface EntryDetail {
  readonly id: number;
  readonly location_id: number;
  readonly note: string;
  readonly created_at: string;
  readonly created_by_account_id: number;
  readonly supplier: { readonly id: number; readonly name: string } | null;
  readonly reverses_entry_id: number | null;
  readonly reversed_by: number | null;
  readonly reason: string;
  readonly lines: readonly EntryLine[];
  readonly total_units: number;
}

/** El documento guardado, leído por el contrato de detalle: nunca por lo que la pantalla dijo. */
export async function readEntry(session: Session, id: number): Promise<EntryDetail> {
  return read<EntryDetail>(session, `/api/stock-entries/${id}`);
}

export interface HistoryRow {
  readonly id: number;
  readonly note: string;
  readonly created_at: string;
  readonly supplier: { readonly id: number; readonly name: string } | null;
  readonly lines: number;
  readonly total_units: number;
  readonly reversed_by: number | null;
}

export interface HistoryPage {
  readonly page: number;
  readonly page_size: number;
  readonly total_entries: number;
  readonly entries: readonly HistoryRow[];
}

/** Una página del historial, del más nuevo al más viejo: la misma lectura que la pantalla hace. */
export async function readHistory(session: Session, page = 1, pageSize = 50): Promise<HistoryPage> {
  return read<HistoryPage>(session, `/api/stock-entries?page=${page}&page_size=${pageSize}`);
}

/**
 * Un documento de ingreso, escrito por el contrato público de la misma sesión: registrar y anular son
 * los actos que las pruebas ejercen, así que el documento que sólo hace de punto de partida se arregla
 * por API. La clave de operación y la nota son de esta corrida.
 */
export async function arrangeEntry(session: Session, draft: {
  readonly supplierId: number;
  readonly note?: string;
  readonly lines: readonly { readonly variantId: number; readonly quantity: number }[];
}): Promise<EntryDetail> {
  const created = await write<{ readonly id: number }>(session, 'post', '/api/stock-entries', {
    operation_key: operationKey(stamp()),
    supplier_id: draft.supplierId,
    ...(draft.note === undefined ? {} : { note: draft.note }),
    lines: draft.lines.map(line => ({ variant_id: line.variantId, quantity: line.quantity })),
  }, 201);
  return readEntry(session, created.id);
}

export interface StockRow {
  readonly variant_id: number;
  readonly existing: number;
  readonly reserved: number;
  readonly available: number;
}

/** El stock del Almacén de una variante concreta: lo que el ingreso suma y el contra-asiento devuelve. */
export async function warehouseStock(session: Session, kind: 'battery' | 'other', search: string,
  variantId: number): Promise<StockRow> {
  const params = new URLSearchParams({
    location_id: String(warehouseId), kind, search, page: '1', page_size: '10',
  });
  const page = await read<{ items: readonly StockRow[] }>(session, `/api/inventory?${params.toString()}`);
  const row = page.items.find(item => item.variant_id === variantId);
  if (row === undefined) {
    throw new Error(`la variante ${variantId} no aparece en el inventario del Almacén con la búsqueda «${search}»`);
  }
  return row;
}

// ---------------------------------------------------------------------------------
// La pantalla: el contexto, el catálogo, el documento y el historial por sus propias etiquetas
// ---------------------------------------------------------------------------------

/** La pantalla del ingreso, por su hash propio: el Almacén entra desde su navegación. */
export async function openEntries(page: Page): Promise<void> {
  await page.goto('/#/ingresos');
  await expect(page.getByRole('heading', { level: 1, name: 'Nuevo ingreso de stock' })).toBeVisible();
  await expect(page.getByText('ALMACÉN / INGRESOS')).toBeVisible();
}

/**
 * El rótulo de una opción del selector: el nombre del proveedor y lo que ofrece, como lo compone la
 * pantalla —el proveedor sin productos asignados también, porque el control lo publica así—.
 */
export function supplierOptionLabel(supplierName: string, offers: number): string {
  const count = offers === 0 ? 'Sin productos asignados'
    : `${offers} ${offers === 1 ? 'producto' : 'productos'}`;
  return `${supplierName} · ${count}`;
}

/**
 * El rótulo exacto con el que el selector publica una fila de la lista del contrato: el nombre, lo que
 * ofrece y, si el proveedor está retirado, la marca con la que la pantalla lo dice. La lista del contrato
 * ordena los retirados al final, así que la comparación de opciones se hace contra esta misma forma.
 */
export function supplierOptionText(listed: ListedSupplier): string {
  return supplierOptionLabel(listed.name, listed.offers) + (listed.retired ? ' · Retirado' : '');
}

/** La opción que no es un proveedor: la pantalla pide elegir uno antes de abrir un catálogo. */
export const supplierPlaceholderOption = 'Elegí un proveedor';

/**
 * El selector de proveedor del documento: la primera decisión, y sin ella nada se lee ni se guarda. Se
 * nombra por su id porque la ficha del documento repite «Proveedor» en su propia etiqueta accesible.
 */
export function supplierSelect(page: Page): Locator {
  return page.locator('select#stock-supplier');
}

/**
 * Los rótulos que el selector publica, en el orden en que los publica: la primera opción es el pedido de
 * elegir uno y desde la segunda van los proveedores. Es lo que el operador puede elegir, leído del control
 * y no del contrato, para poder contrastar los dos.
 */
export async function supplierOptions(page: Page): Promise<readonly string[]> {
  return (await supplierSelect(page).locator('option').allTextContents()).map(text => text.trim());
}

/** Uno de los proveedores que la pantalla publica, con lo que ofrece y si está retirado. */
export interface ListedSupplier {
  readonly id: number;
  readonly name: string;
  readonly contact: string;
  readonly retired: boolean;
  readonly kinds: readonly ('battery' | 'other')[];
  readonly offers: number;
}

/**
 * La lista que el selector de Ingresos lee, pedida exactamente como la pide la pantalla: la página más
 * ancha que admite el contrato (`GET /api/suppliers?page=&page_size=`, `apps/api/docs/suppliers.md`),
 * sin búsqueda, porque esa lectura no tiene ninguna.
 */
export interface ListedSupplierPage {
  readonly suppliers: readonly ListedSupplier[];
  readonly page: number;
  readonly page_size: number;
  readonly total_suppliers: number;
}

/** La página más ancha del contrato: la que la pantalla pide en cada paso de su lectura. */
const supplierPageSize = 50;

/**
 * Todas las páginas que el contrato publica de proveedores, leídas como las camina la pantalla: desde la
 * primera hasta cubrir el `total_suppliers` que el propio servidor contó, y cortando en una página vacía.
 * Es la lista completa que el operador tiene que poder elegir.
 */
export async function allSupplierPages(session: Session): Promise<readonly ListedSupplierPage[]> {
  const pages: ListedSupplierPage[] = [];
  let total = 0;
  for (let page = 1; page <= 1_000_000; page += 1) {
    const current = await read<ListedSupplierPage>(session,
      `/api/suppliers?page=${page}&page_size=${supplierPageSize}`);
    pages.push(current);
    total = Math.max(total, current.total_suppliers);
    if (current.suppliers.length === 0 || page >= Math.ceil(total / supplierPageSize)) return pages;
  }
  throw new Error('la lectura de proveedores no terminó: el servidor publicó más páginas que su propio total');
}

/** La lista completa de proveedores que el selector tiene que publicar, en el orden del contrato. */
export async function allListedSuppliers(session: Session): Promise<readonly ListedSupplier[]> {
  return (await allSupplierPages(session)).flatMap(page => page.suppliers);
}

/**
 * El proveedor de la corrida dentro de la lista completa que el selector publica, o el motivo por el que
 * no está: elegir un proveedor que la pantalla no lista es imposible, y esta lectura lo dice antes de
 * intentar un clic que nunca podría funcionar.
 */
export async function listedSupplier(session: Session, supplierId: number): Promise<ListedSupplier> {
  const suppliers = await allListedSuppliers(session);
  const row = suppliers.find(candidate => candidate.id === supplierId);
  if (row === undefined) {
    throw new Error(`el selector de Ingresos publica ${suppliers.length} proveedores y el ${supplierId} ` +
      'no está en ninguno: la lista que el operador puede elegir está incompleta');
  }
  return row;
}

/**
 * Elige un proveedor que el selector realmente publica: primero afirma que la opción está en el control
 * con la etiqueta que compone el contrato (nombre y cantidad de productos) y recién después la elige.
 * Devuelve la fila leída del contrato.
 */
export async function chooseSupplier(page: Page, session: Session, supplierId: number):
  Promise<ListedSupplier> {
  const row = await listedSupplier(session, supplierId);
  const label = supplierOptionLabel(row.name, row.offers);
  const option = supplierSelect(page).locator(`option[value="${row.id}"]`);
  await expect(option).toHaveText(label);
  await supplierSelect(page).selectOption({ label });
  return row;
}

/** El grupo de tipo del documento: existe sólo cuando el proveedor ofrece los dos tipos. */
export function kindGroup(page: Page): Locator {
  return page.getByRole('group', { name: 'Tipo de producto del ingreso' });
}

/** El rótulo del tipo, que la pantalla imprime en el documento y en la ficha del contexto. */
export const kindLabels = { battery: 'Baterías', other: 'Otros productos' } as const;

/** El panel del catálogo del proveedor, con su búsqueda, sus grupos y sus contadores. */
export function catalogPanel(page: Page): Locator {
  return page.locator('.stock-catalog-panel');
}

/** Las filas del catálogo: una por producto ofrecido, con sus polaridades dentro. */
export function catalogRows(page: Page): Locator {
  return page.getByRole('region', { name: 'Productos del catálogo' }).locator('tbody tr[data-product-id]');
}

/** La fila de un producto por su entrada de catálogo, que es el id de la batería o del producto. */
export function catalogRow(page: Page, catalogEntryId: number): Locator {
  return catalogPanel(page).locator(`tr[data-product-id="${catalogEntryId}"]`);
}

/** El buscador del catálogo: su etiqueta depende del tipo que el documento declara. */
export function catalogSearch(page: Page, kind: 'battery' | 'other'): Locator {
  return page.getByLabel(kind === 'battery' ? 'Buscar marca, modelo o capacidad' : 'Buscar nombre o dato del producto');
}

/** El botón de una polaridad de una batería, por su nombre accesible completo. */
export function addBattery(page: Page, brand: string, model: string, polarity: 'L' | 'R'): Locator {
  return page.getByRole('button', { name: `Agregar ${brand} ${model} polaridad ${polarity}` });
}

/** El botón de un producto libre del catálogo. */
export function addProduct(page: Page, name: string): Locator {
  return page.getByRole('button', { name: `Agregar ${name}` });
}

/** El panel del documento que se está armando: sus líneas, su nota y sus totales. */
export function documentPanel(page: Page): Locator {
  return page.locator('.stock-document-panel');
}

/** Una línea del borrador, por la variante que declara. */
export function draftRow(page: Page, variantId: number): Locator {
  return page.getByRole('region', { name: 'Líneas del documento' })
    .locator(`tr[data-variant-id="${variantId}"]`);
}

/** La cantidad de una línea del borrador, por la variante que declara. */
export function draftQuantity(page: Page, variantId: number): Locator {
  return draftRow(page, variantId).getByRole('spinbutton');
}

/** Los totales del documento: las líneas y las unidades que la pantalla suma. */
export function draftTotals(page: Page): Locator {
  return documentPanel(page).locator('dl.stock-totals');
}

/** La nota del documento: el remito que el operador escribe y que se guarda con el ingreso. */
export function noteField(page: Page): Locator {
  return page.getByLabel('Nota (opcional)');
}

/** El botón que aplica el documento entero, con el total que la pantalla calculó. */
export function confirmButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Confirmar ingreso' });
}

/** El mensaje de la confirmación, que nombra el documento y las unidades aplicadas. */
export async function confirmIngress(page: Page): Promise<{ readonly id: number; readonly units: number }> {
  await confirmButton(page).click();
  const status = page.getByRole('status').filter({ hasText: /Ingreso confirmado: documento [1-9][0-9]*/ });
  await expect(status).toHaveCount(1);
  const match = /Ingreso confirmado: documento ([1-9][0-9]*) · ([0-9]+) (?:unidad|unidades)\./
    .exec((await status.textContent()) ?? '');
  if (match === null) throw new Error('la confirmación del ingreso no nombra el documento y sus unidades');
  return { id: Number(match[1]), units: Number(match[2]) };
}

/** La región del historial: la bandeja de documentos del Almacén con su paginador. */
export function historyPanel(page: Page): Locator {
  return page.getByRole('region', { name: 'Historial de ingresos' });
}

/** La fila de un documento del historial, por el id que la propia fila declara. */
export function historyRow(page: Page, id: number): Locator {
  return historyPanel(page).locator(`tr[data-entry-id="${id}"]`);
}

/** El total de la bandeja, tal como la propia cabecera del historial lo publica («65 ingresos»). */
async function historyTotal(page: Page): Promise<number> {
  const tag = historyPanel(page).locator('.stock-panel-head .stock-tag');
  await expect(tag).toHaveText(/\d+ ingresos?/);
  const match = /(\d+)/.exec((await tag.textContent()) ?? '');
  if (match === null) throw new Error('el historial no publicó su total de ingresos');
  return Number(match[1]);
}

/**
 * La fila de un documento, buscada como la busca el operador: el historial publica una página y el
 * paginador la recorre. Las demás suites escriben ingresos al mismo tiempo (S4), así que la fila de la
 * corrida puede no estar en la primera página: se pide la página más ancha y se avanza hasta hallarla.
 *
 * Cada paso espera a que la página pedida esté completa —el total de la cabecera dice cuántas filas
 * admite— porque durante la recarga la tabla se vacía y avanzar antes de tiempo se saltearía la página
 * donde está el documento.
 */
export async function showEntryRow(page: Page, id: number): Promise<Locator> {
  const panel = historyPanel(page);
  const row = historyRow(page, id);
  const current = panel.locator('.pager span[aria-current="page"]');
  const rows = panel.locator('tbody tr[data-entry-id]');
  const size = 50;
  // El cambio de tamaño vuelve siempre a la primera página; alternar dos tamaños lo garantiza aunque el
  // control ya estuviera en 50 y la bandeja hubiera quedado en otra página.
  await page.getByLabel('Ingresos por página').selectOption('10');
  await page.getByLabel('Ingresos por página').selectOption(String(size));
  await expect(current).toHaveText('Página 1');
  const total = await historyTotal(page);
  const rowsOn = (number: number) => Math.max(0, Math.min(size, total - (number - 1) * size));
  let number = 1;
  for (;;) {
    await expect(rows).toHaveCount(rowsOn(number));
    if (await row.count() > 0) return row;
    const next = page.getByRole('button', { name: 'Siguiente página' });
    if (await next.isDisabled()) break;
    await next.click();
    number += 1;
    await expect(current).toHaveText(`Página ${number}`);
  }
  await expect(row).toHaveCount(1);
  return row;
}

/** El detalle del ingreso que la fila abre: sus líneas, su total y sus dos referencias de reverso. */
export function detailDialog(page: Page, id: number): Locator {
  return page.getByRole('dialog', { name: `Detalle del ingreso #${id}` });
}

/** La confirmación del contra-asiento: el espejo del documento y el motivo obligatorio. */
export function reversalDialog(page: Page): Locator {
  return page.getByRole('dialog', { name: 'Registrar contra-asiento' });
}

/**
 * Abre la confirmación del contra-asiento de una fila del historial, como lo hace el operador: la fila
 * publica su acción y la confirmación aparece con el espejo del documento.
 */
export async function openReversal(page: Page, id: number): Promise<Locator> {
  const row = await showEntryRow(page, id);
  await row.getByRole('button', { name: `Anular ingreso #${id}` }).click();
  const dialog = reversalDialog(page);
  await expect(dialog).toBeVisible();
  return dialog;
}

/**
 * El motivo y la confirmación del acto abierto. Devuelve el contra-asiento que el servidor guardó,
 * leído por el id que la propia confirmación nombró.
 */
export async function confirmReversal(page: Page, session: Session, reason: string): Promise<EntryDetail> {
  const dialog = reversalDialog(page);
  await dialog.getByLabel('Motivo del contra-asiento').fill(reason);
  await dialog.getByRole('button', { name: 'Confirmar contra-asiento' }).click();
  await expect(dialog).toBeHidden();
  const status = page.getByRole('status').filter({ hasText: /Contra-asiento registrado: documento [1-9][0-9]*/ });
  await expect(status).toHaveCount(1);
  const match = /Contra-asiento registrado: documento ([1-9][0-9]*)/.exec((await status.textContent()) ?? '');
  if (match === null) throw new Error('la confirmación del contra-asiento no nombra el documento registrado');
  return readEntry(session, Number(match[1]));
}

/** El acto completo de anular: abrir la confirmación de la fila, escribir el motivo y confirmar. */
export async function reverseEntry(page: Page, session: Session, id: number, reason: string):
  Promise<EntryDetail> {
  await openReversal(page, id);
  return confirmReversal(page, session, reason);
}
