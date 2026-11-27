import type { Locator, Page } from '@playwright/test';
import { expect, type Session } from '../warranty/harness';

/**
 * El arnés de la venta y de su historial (S2, T3): la góndola vendible de la sucursal, el documento
 * que el mostrador emite y la fila con la que el historial lo publica.
 *
 * Reusa el arnés de la vertical de garantías tal cual —la sesión de Sucursal A que abrió el proyecto
 * `sesiones`, el fixture `api` que dispone una sesión por rol y el `test`/`expect` de Playwright— y le
 * agrega sólo lo que la venta tiene de propio: la lectura del catálogo vendible y del documento por el
 * contrato que el servidor ya publica (`apps/api/docs/sales.md`), los formatos con los que la pantalla
 * imprime un monto y los actos del mostrador, sin ningún atajo por API: vender es justamente lo que la
 * prueba ejerce.
 *
 * El arreglo va por la API pública de la misma sesión (S3) y sólo cubre lo que el flujo no ejercita: la
 * góndola que el sembrado deja con stock, el precio que la sucursal necesita para venderla y, en el
 * historial, la venta que el historial lee. Nada de acá importa módulos de la aplicación, así que una
 * prueba no puede pasar por coincidir con el código que revisa.
 */

export { branchA, branchB, expect, origin, test, warehouseRole, type Session } from '../warranty/harness';

// ---------------------------------------------------------------------------------
// Montos: el contrato los publica como texto decimal canónico (`"96000.00"`)
// ---------------------------------------------------------------------------------

/** Los centavos exactos de un monto canónico del contrato. */
export function cents(amount: string): bigint {
  const [whole, fraction = ''] = amount.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}

/** El monto canónico de una cantidad exacta de centavos. */
export function amountOf(value: bigint): string {
  return `${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`;
}

/**
 * `Bs 96.000,00`: el formato de presentación del producto, el que imprimen el mostrador, el historial y
 * la garantía en PDF. Vive en el cliente, así que la prueba lo compone acá y no lo lee de la aplicación.
 */
export function money(amount: string): string {
  const [whole, fraction] = amount.split('.');
  return `Bs ${whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${fraction}`;
}

/** `96.000,00`, la forma que aceptan los campos de monto del mostrador (punto de miles, coma decimal). */
export function typed(amount: string): string {
  return money(amount).slice('Bs '.length);
}

// ---------------------------------------------------------------------------------
// Datos únicos: dos corridas de la suite nunca chocan en una serie, un cliente ni un documento
// ---------------------------------------------------------------------------------

let sequence = 0;

function stamp(): string {
  sequence += 1;
  return `${Date.now().toString(36)}${sequence}${Math.random().toString(36).slice(2, 5)}`.toUpperCase();
}

/** La serie que el mostrador lee de la batería: texto libre, único en toda la instalación. */
export function uniqueSerial(tag: string): string {
  return `${tag.toUpperCase()}${stamp()}`;
}

export interface CounterCustomer {
  readonly name: string;
  readonly phone: string;
  readonly document: string;
  readonly address: string;
}

/** El cliente de una venta con garantía: los tres datos del papel y la dirección que el papel no imprime. */
export function arrangeCustomer(tag: string): CounterCustomer {
  const mark = stamp();
  return {
    name: `Cliente ${tag.toUpperCase()} ${mark}`,
    phone: `7${mark.replace(/\D/g, '').slice(0, 6).padEnd(6, '0')}-${mark.slice(-4)}`,
    document: `CI-${mark}`,
    address: `Barrio ${mark}`,
  };
}

// ---------------------------------------------------------------------------------
// La góndola vendible de la sucursal y el documento que el servidor guardó
// ---------------------------------------------------------------------------------

/** Una fila de `GET /api/sales/sellable?kind=battery`: una polaridad con su precio y su saldo. */
interface SellableRow {
  readonly variant_id: number;
  readonly catalog_entry_id: number;
  readonly brand: string;
  readonly model: string;
  readonly capacity_ah: string;
  readonly polarity: string;
  readonly sellable: boolean;
  readonly suggested_price: string | null;
  readonly min_price: string | null;
  readonly existing: number;
  readonly available: number;
}

interface SellablePage {
  readonly page: number;
  readonly page_size: number;
  readonly total_variants: number;
  readonly items: readonly SellableRow[];
}

/** La batería con la que la prueba vende: la identidad y los precios que el servidor sostiene hoy. */
export interface CounterBattery {
  readonly variantId: number;
  readonly catalogEntryId: number;
  /** `CAR NS40ZL`: el nombre con el que la tarjeta de la góndola titula la batería. */
  readonly name: string;
  /** `CAR NS40ZL L`: el nombre que la línea del carrito da a cada campo suyo. */
  readonly label: string;
  readonly model: string;
  readonly brand: string;
  readonly capacityAh: string;
  readonly polarity: string;
  readonly suggestedPrice: string;
  readonly minPrice: string;
  readonly available: number;
}

export interface SalePayment { readonly method: string; readonly amount: string }
export interface SaleUnit { readonly serial_number: string; readonly warranty_months: number | null }
export interface SaleCustomerRecord {
  readonly name: string;
  readonly phone: string;
  readonly document: string;
  readonly address: string;
}
export interface SaleLine {
  readonly variant_id: number;
  readonly catalog_entry_id: number;
  readonly brand?: string;
  readonly model?: string;
  readonly capacity_ah?: string;
  readonly polarity?: string;
  readonly quantity: number;
  readonly unit_price: string;
  readonly min_price: string;
  readonly units: readonly SaleUnit[];
  readonly subtotal: string;
}

/** La venta que el servidor guardó, con la forma que publica su contrato de detalle. */
export interface SaleDetail {
  readonly id: number;
  readonly branch_sequence: number;
  readonly warranty_number: string;
  readonly payment_method: string;
  readonly payments: readonly SalePayment[];
  readonly customer_name: string;
  readonly customer: SaleCustomerRecord;
  readonly total: string;
  readonly created_at: string;
  readonly lines: readonly SaleLine[];
}

/** Una fila del historial de la sucursal. */
export interface SaleSummary {
  readonly id: number;
  readonly branch_sequence: number;
  readonly warranty_number: string;
  readonly payment_method: string;
  readonly customer_name: string;
  readonly total: string;
  readonly created_at: string;
  readonly lines: number;
  readonly units_total: number;
  readonly units_with_warranty: number;
}

export interface SalesPageSummary {
  readonly page: number;
  readonly page_size: number;
  readonly total_sales: number;
  readonly sales: readonly SaleSummary[];
}

/** La primera página que la pantalla pide: la del mostrador y la del historial comparten el tamaño. */
const firstPageSize = 10;

async function get<T>(session: Session, path: string): Promise<T> {
  const reply = await session.request.get(path);
  if (reply.status() !== 200) {
    throw new Error(`GET ${path} respondió ${reply.status()}: ${await reply.text()}`);
  }
  return (await reply.json()) as T;
}

async function send<T>(session: Session, method: 'post' | 'put', path: string, body: unknown,
  expected: number): Promise<T> {
  const reply = await session.request[method](path, {
    headers: { 'X-CSRF-Token': session.csrf }, data: body,
  });
  if (reply.status() !== expected) {
    throw new Error(`${method.toUpperCase()} ${path} respondió ${reply.status()} en vez de ${expected}: ${await reply.text()}`);
  }
  return (await reply.json()) as T;
}

/** La primera página de la góndola vendible: la misma que la pantalla pide al abrirse. */
export async function counterShelf(session: Session): Promise<SellablePage> {
  return get<SellablePage>(session, `/api/sales/sellable?kind=battery&page=1&page_size=${firstPageSize}`);
}

/** Toda la góndola vendible de la sucursal, para elegir la batería que el arreglo va a vender. */
async function wholeShelf(session: Session): Promise<readonly SellableRow[]> {
  const rows: SellableRow[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const body = await get<SellablePage>(session,
      `/api/sales/sellable?kind=battery&page=${page}&page_size=50`);
    rows.push(...body.items);
    if (rows.length >= body.total_variants || body.items.length === 0) break;
  }
  return rows;
}

function byStock(left: SellableRow, right: SellableRow): number {
  return right.available - left.available || left.variant_id - right.variant_id;
}

/**
 * La batería con la que esta corrida vende: la que la sucursal tiene en su góndola con más stock y, si
 * ninguna de las que ya tienen precio alcanza para la corrida, la que más tiene —cargándole el precio con
 * el mismo acto del catálogo que la sucursal necesita para venderla—.
 */
export async function arrangeSellableBattery(
  sessions: { readonly branch: Session; readonly warehouse: Session },
): Promise<CounterBattery> {
  const shelf = await wholeShelf(sessions.branch);
  const stocked = shelf.filter(row => row.available > 0);
  if (stocked.length === 0) throw new Error('la sucursal no tiene ninguna batería con stock para vender');
  const chosen = stocked.filter(row => row.sellable).sort(byStock).find(row => row.available >= 5)
    ?? stocked.sort(byStock)[0];
  // La sucursal sólo vende lo que tiene precio: sin él la batería está en la góndola, bloqueada. Cargarlo
  // es el acto del Almacén que publica `apps/api/docs/branch-prices.md`, nunca un atajo por la base.
  if (!chosen.sellable) {
    await send(sessions.warehouse, 'put', '/api/catalog/prices', {
      catalog_entry_id: chosen.catalog_entry_id, min_price: '85000', suggested_price: '96000',
      branch_ids: [sessions.branch.locationId],
    }, 200);
  }
  const priced = (await wholeShelf(sessions.branch)).find(row => row.variant_id === chosen.variant_id);
  if (priced === undefined || !priced.sellable
    || priced.suggested_price === null || priced.min_price === null) {
    throw new Error(`la batería ${chosen.variant_id} quedó sin precio en la sucursal`);
  }
  const battery: CounterBattery = {
    variantId: priced.variant_id, catalogEntryId: priced.catalog_entry_id,
    name: `${priced.brand} ${priced.model}`,
    label: `${priced.brand} ${priced.model} ${priced.polarity}`,
    brand: priced.brand, model: priced.model,
    capacityAh: priced.capacity_ah, polarity: priced.polarity,
    suggestedPrice: priced.suggested_price, minPrice: priced.min_price,
    available: priced.available,
  };
  return battery;
}

/** El total exacto de una línea de `quantity` baterías al precio que la góndola publica. */
export function lineTotal(battery: CounterBattery, quantity = 1): string {
  return amountOf(cents(battery.suggestedPrice) * BigInt(quantity));
}

export interface ArrangedSale {
  readonly id: number;
  readonly sequence: number;
  readonly warrantyNumber: string;
  readonly total: string;
  readonly createdAt: string;
  readonly serial: string;
  readonly months: number;
  readonly customer: CounterCustomer;
}

/**
 * Una venta de una batería con su serie y su plazo, registrada por el contrato que el servidor publica.
 * El historial sólo lee documentos: la venta que lista es el arreglo, nunca el acto de la prueba.
 */
export async function arrangeSale(branch: Session, battery: CounterBattery,
  months = 12): Promise<ArrangedSale> {
  const serial = uniqueSerial('HIST');
  const customer = arrangeCustomer('historial');
  const created = await send<{ sale: { id: number; branch_sequence: number; warranty_number: string; total: string; created_at: string } }>(
    branch, 'post', '/api/sales', {
      payments: [{ method: 'cash', amount: battery.suggestedPrice }],
      customer: {
        name: customer.name, phone: customer.phone, document: customer.document, address: customer.address,
      },
      lines: [{
        variant_id: battery.variantId, quantity: 1, unit_price: battery.suggestedPrice,
        units: [{ serial_number: serial, warranty_months: months }],
      }],
    }, 201);
  return {
    id: created.sale.id, sequence: created.sale.branch_sequence,
    warrantyNumber: created.sale.warranty_number, total: created.sale.total,
    createdAt: created.sale.created_at, serial, months, customer,
  };
}

/** La página del historial de la sucursal, con el filtro de la pantalla. */
export async function salesSearch(session: Session, term: string): Promise<SalesPageSummary> {
  return get<SalesPageSummary>(session,
    `/api/sales?search=${encodeURIComponent(term)}&page=1&page_size=${firstPageSize}`);
}

/** El documento guardado, leído por el id con el que la propia pantalla lo abre. */
export async function saleDetail(session: Session, id: number): Promise<SaleDetail> {
  return get<SaleDetail>(session, `/api/sales/${id}`);
}

// ---------------------------------------------------------------------------------
// El navegador: la sucursal, su mostrador y el historial
// ---------------------------------------------------------------------------------

export async function openCounter(page: Page): Promise<void> {
  await page.goto('/#/ventas');
  await expect(page.getByRole('heading', { level: 1, name: 'Nueva venta' })).toBeVisible();
}

export async function openHistory(page: Page): Promise<void> {
  await page.goto('/#/ventas/historial');
  await expect(page.getByRole('heading', { level: 1, name: 'Historial de ventas' })).toBeVisible();
}

/**
 * El panel donde el mostrador arma la venta, cobra y ve el documento que emitió: el `aside` que el carrito
 * nombra con su título, nunca la barra lateral de la aplicación (que es el otro `complementary` de la
 * pantalla y publica sus propios contadores).
 */
export function counterCart(page: Page): Locator {
  return page.getByRole('complementary', { name: 'Venta en curso' });
}

/** La venta en curso: su título lleva la cuenta de líneas que el mostrador lleva cargadas. */
export function cartHeading(page: Page): Locator {
  return counterCart(page).getByRole('heading', { level: 2, name: 'Venta en curso' });
}

export function chargeButton(page: Page): Locator {
  return counterCart(page).getByRole('button', { name: 'Cobrar y emitir garantía' });
}

/** Lo que el mostrador está viendo del cobro: el mensaje del acto, no un botón deshabilitado a secas. */
export function counterNotice(page: Page): Locator {
  return counterCart(page).getByRole('status');
}

/** Lo que el mostrador está viendo del rechazo. */
export function counterProblem(page: Page): Locator {
  return counterCart(page).getByRole('alert');
}

/** El documento emitido, con su número, su total y el comprobante que se descarga. */
export function issuedPanel(page: Page): Locator {
  return page.getByRole('region', { name: 'Venta emitida' });
}

/**
 * El acto de encontrar la batería: el mostrador filtra la góndola por el modelo que el cliente pide, con
 * el tamaño de página que la pantalla ofrece, y llega a la tarjeta de esa polaridad.
 */
export async function findBattery(page: Page, battery: CounterBattery): Promise<Locator> {
  await page.getByLabel('Baterías por página').selectOption('50');
  await page.getByLabel('Buscar batería').fill(battery.model);
  const card = page.locator(`[data-variant-id="${battery.variantId}"]`);
  await expect(card).toBeVisible();
  await expect(card.getByRole('heading', { level: 3, name: battery.name })).toBeVisible();
  return card;
}

/** Agrega la batería a la venta en curso: la línea nace con una unidad y el plazo por defecto. */
export async function addBattery(page: Page, battery: CounterBattery): Promise<void> {
  const card = await findBattery(page, battery);
  await card.getByRole('button', { name: 'Agregar a la venta' }).click();
  await expect(unitField(page, battery, 'Número de serie', 1)).toBeVisible();
}

function unitField(page: Page, battery: CounterBattery, field: string, unit: number): Locator {
  return counterCart(page).getByLabel(`${field} de la unidad ${unit} de ${battery.label}`);
}

/** El campo donde el mostrador anota la serie que leyó de una unidad de la línea. */
export function serialField(page: Page, battery: CounterBattery, unit = 1): Locator {
  return unitField(page, battery, 'Número de serie', unit);
}

/** El plazo en meses de una unidad, tal como el campo lo muestra. */
export function warrantyField(page: Page, battery: CounterBattery, unit = 1): Locator {
  return unitField(page, battery, 'Garantía en meses', unit);
}

/** El precio unitario que la línea cobra, que nace con el sugerido de la sucursal. */
export function priceField(page: Page, battery: CounterBattery): Locator {
  return counterCart(page).getByLabel(`Precio unitario de ${battery.label}`);
}

/** El total exacto de la venta en curso, como el carrito lo imprime. */
export function cartTotal(page: Page): Locator {
  return counterCart(page).getByText('Total', { exact: true }).locator('..');
}

/** El mostrador lee de la batería su número de serie y lo anota en la unidad. */
export async function writeSerial(page: Page, battery: CounterBattery, serial: string,
  unit = 1): Promise<void> {
  await unitField(page, battery, 'Número de serie', unit).fill(serial);
}

/** El plazo que la venta promete por esa batería, en meses; el campo vacío es su ausencia explícita. */
export async function writeWarranty(page: Page, battery: CounterBattery, months: number | '',
  unit = 1): Promise<void> {
  await unitField(page, battery, 'Garantía en meses', unit).fill(String(months));
}

/** Suma una unidad más a la línea, con el paso que ofrece el carrito. */
export async function addUnit(page: Page, battery: CounterBattery): Promise<void> {
  await counterCart(page).getByRole('button', { name: `Sumar una unidad de ${battery.label}` }).click();
}

/** El monto con el que el cliente paga en efectivo. */
export async function payCash(page: Page, amount: string): Promise<void> {
  await counterCart(page).getByLabel('Efectivo').fill(typed(amount));
}

/** Los datos con los que la garantía nombra al cliente y la dirección que el papel no imprime. */
export async function fillCustomer(page: Page, customer: CounterCustomer): Promise<void> {
  const cart = counterCart(page);
  await cart.getByLabel('Cliente').fill(customer.name);
  await cart.getByLabel('Teléfono').fill(customer.phone);
  await cart.getByLabel('Documento').fill(customer.document);
  await cart.getByLabel('Dirección o barrio').fill(customer.address);
}

/** La fila del historial que publica una venta, nombrada por el número que su botón anuncia. */
export function historyRow(page: Page, sequence: number): Locator {
  return page.getByRole('row').filter({ has: page.getByRole('button', { name: `Ver la venta ${sequence}` }) });
}

/** El documento desplegado bajo su fila. */
export function saleDetailPanel(page: Page, sequence: number): Locator {
  return page.getByRole('region', { name: `Venta ${sequence}` });
}
