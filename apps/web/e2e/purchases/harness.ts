import type { Locator, Page } from '@playwright/test';
import { expect, type Session } from '../warranty/harness';

/**
 * El arnés de compras (S2, T4): el mostrador que le compra a quien trae el material, sus dos libros de
 * referencia —los modelos del catálogo y los materiales— y los documentos que el acto produce.
 *
 * Reusa el arnés de la vertical de garantías tal cual —la sesión de Sucursal A que abrió el proyecto
 * `sesiones`, el fixture `api` que dispone una sesión por rol y el `test`/`expect` de Playwright— y le
 * agrega sólo lo que la compra tiene de propio: las lecturas del contrato que el servidor ya publica
 * (`apps/api/docs/purchases.md`), los formatos con los que la pantalla imprime un monto y un peso, y los
 * actos del mostrador, sin ningún atajo por API: registrar compras es justamente lo que la prueba
 * ejerce. El arreglo previo —el fondo de compras que paga el documento, el precio que ancla cada línea y
 * la compra que una pantalla de sólo lectura lista— va por la API pública de la misma sesión (S3).
 *
 * Nada de acá importa módulos de la aplicación: una prueba no puede pasar por coincidir con el código
 * que revisa.
 */

export { branchA, expect, origin, test, warehouseRole, type Session } from '../warranty/harness';

// ---------------------------------------------------------------------------------
// Montos y pesos: el contrato los publica como texto decimal canónico
// ---------------------------------------------------------------------------------

/** Los centavos exactos de un monto canónico del contrato, con su signo. */
export function cents(amount: string): bigint {
  const negative = amount.startsWith('-');
  const [whole, fraction = ''] = (negative ? amount.slice(1) : amount).split('.');
  const value = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return negative ? -value : value;
}

/** El monto canónico de una cantidad exacta de centavos: lo que el contrato guarda y publica. */
export function amountOf(value: bigint): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  return `${negative ? '-' : ''}${magnitude / 100n}.${(magnitude % 100n).toString().padStart(2, '0')}`;
}

/**
 * `Bs 25.000,00`: el formato de presentación del producto, el que imprimen el documento, la lista de
 * documentos y el comprobante. Vive en el cliente, así que la prueba lo compone acá.
 */
export function money(value: bigint): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const whole = (magnitude / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${negative ? '-' : ''}Bs ${whole},${(magnitude % 100n).toString().padStart(2, '0')}`;
}

/** `25.000,00`, la forma que aceptan los campos de monto del mostrador (punto de miles, coma decimal). */
export function typedMoney(value: bigint): string {
  return money(value).replace('Bs ', '');
}

/** Los milésimos exactos de un peso canónico del contrato (`"12.400"`), con su signo. */
export function milliFromWire(weight: string): bigint {
  const negative = weight.startsWith('-');
  const [whole, fraction] = (negative ? weight.slice(1) : weight).split('.');
  const value = BigInt(whole) * 1000n + BigInt(fraction);
  return negative ? -value : value;
}

/** El peso canónico de milésimos exactos: el texto que el contrato guarda. */
export function weightOf(milli: bigint): string {
  const negative = milli < 0n;
  const magnitude = negative ? -milli : milli;
  return `${negative ? '-' : ''}${magnitude / 1000n}.${(magnitude % 1000n).toString().padStart(3, '0')}`;
}

/** `12,400 kg`: el formato con el que la pantalla imprime un peso recibido. */
export function formatKg(milli: bigint): string {
  const negative = milli < 0n;
  const magnitude = negative ? -milli : milli;
  const whole = (magnitude / 1000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${negative ? '-' : ''}${whole},${(magnitude % 1000n).toString().padStart(3, '0')} kg`;
}

/** `12,400`, la forma que acepta el campo de kilogramos del mostrador. */
export function typedKg(milli: bigint): string {
  return formatKg(milli).slice(0, -' kg'.length);
}

/** El importe de una línea de chatarra: `kg × precio por kilo`, redondeado hacia arriba al centavo. */
export function scrapAmount(kgMilli: bigint, pricePerKg: bigint): bigint {
  return (kgMilli * pricePerKg + 500n) / 1000n;
}

// ---------------------------------------------------------------------------------
// Datos únicos: dos corridas de la suite nunca chocan en un modelo, una nota ni un documento
// ---------------------------------------------------------------------------------

let sequence = 0;

function stamp(): string {
  sequence += 1;
  return `${Date.now().toString(36)}${sequence}${Math.random().toString(36).slice(2, 5)}`.toUpperCase();
}

/**
 * Un código de modelo que esta corrida compra por primera vez: letras y dígitos, como el contrato
 * admite, y fuera del catálogo, que es el caso que la pantalla resuelve con el modelo tipeado a mano.
 */
export function uniqueModel(tag: string): string {
  return `${tag.toUpperCase()}${stamp()}`;
}

/** Una nota del documento, única de esta corrida: lo único libre que el acto deja escrito. */
export function uniqueNote(tag: string): string {
  return `Nota ${tag} ${stamp()}`;
}

/** La clave de operación que el contrato exige para que un reintento no cree un segundo documento. */
export function operationKey(): string {
  return `compra-${stamp()}-${stamp()}`;
}

// ---------------------------------------------------------------------------------
// El contrato que el servidor publica (apps/api/docs/purchases.md)
// ---------------------------------------------------------------------------------

export interface PurchaseUsedLine {
  readonly model: string;
  readonly quantity: number;
  readonly unit_price: string;
  readonly amount: string;
}

export interface PurchaseScrapLine {
  readonly material_id: number;
  readonly name: string;
  readonly kg: string;
  readonly price_per_kg: string;
  readonly amount: string;
}

/** El documento persistido, con la forma que publica su contrato de detalle. */
export interface PurchaseDocument {
  readonly id: number;
  readonly location_id: number;
  readonly note: string;
  readonly total: string;
  readonly paid_cash: string;
  readonly paid_transfer: string;
  readonly created_by_account_id: number;
  readonly created_at: string;
  readonly reverses_purchase_id: number | null;
  readonly reversed_by: number | null;
  readonly reason: string;
  readonly used_lines: readonly PurchaseUsedLine[];
  readonly scrap_lines: readonly PurchaseScrapLine[];
}

/** Una fila de la lista de documentos de la sucursal. */
export interface PurchaseSummary {
  readonly id: number;
  readonly created_at: string;
  readonly total: string;
  readonly reverses_purchase_id: number | null;
  readonly reversed_by: number | null;
  readonly used_units: number;
  readonly scrap_lines: number;
}

/** Un período del selector: el saldo abierto, una rendición cerrada, la viva o todo el historial. */
export interface PurchasePeriod {
  readonly kind: 'pending' | 'settlement' | 'open' | 'all';
  readonly closing_id: number | null;
  readonly from: string | null;
  readonly to: string | null;
  readonly label: string;
}

/** La página de documentos con el selector de períodos y la cabecera del período elegido. */
export interface PurchaseListing {
  readonly page: number;
  readonly page_size: number;
  readonly total_purchases: number;
  readonly purchases: readonly PurchaseSummary[];
  readonly periods: readonly PurchasePeriod[];
  readonly period: PurchasePeriod;
  readonly totals: { readonly money: string | null; readonly used_units: string; readonly scrap_kg: string };
  readonly balance: {
    readonly used: readonly { readonly model: string; readonly bought: string; readonly delivered: string; readonly balance: string }[];
    readonly scrap: readonly { readonly material_id: number; readonly bought: string; readonly delivered: string; readonly balance: string }[];
  } | null;
}

export interface PurchaseLastPrices {
  readonly models: readonly { readonly model: string; readonly unit_price: string; readonly purchased_at: string }[];
  readonly materials: readonly { readonly material_id: number; readonly price_per_kg: string; readonly purchased_at: string }[];
}

export interface PurchaseMaterial {
  readonly id: number;
  readonly name: string;
}

/** Lo que la sucursal recibió, derivado de sus documentos: la suma de las líneas de cada modelo. */
export interface PurchaseReceived {
  readonly used: readonly { readonly model: string; readonly quantity: number; readonly value: string }[];
  readonly scrap: readonly { readonly material_id: number; readonly name: string; readonly kg: string; readonly value: string }[];
}

async function get<T>(session: Session, path: string): Promise<T> {
  const reply = await session.request.get(path);
  if (reply.status() !== 200) {
    throw new Error(`GET ${path} respondió ${reply.status()}: ${await reply.text()}`);
  }
  return (await reply.json()) as T;
}

async function post<T>(session: Session, path: string, body: unknown, expected: number): Promise<T> {
  const reply = await session.request.post(path, {
    headers: { 'X-CSRF-Token': session.csrf }, data: body,
  });
  if (reply.status() !== expected) {
    throw new Error(`POST ${path} respondió ${reply.status()} en vez de ${expected}: ${await reply.text()}`);
  }
  if (expected === 204) return undefined as T;
  return (await reply.json()) as T;
}

/**
 * El fondo de compras de la sucursal, cargado por el Almacén: el único dinero con el que se paga una
 * compra y el que la pantalla gasta al confirmar. Es un `aporte` del libro, así que cargarlo dos veces
 * suma y nunca reemplaza.
 */
export async function loadPurchaseFund(
  sessions: { readonly branch: Session; readonly warehouse: Session }, amountCents: bigint,
): Promise<void> {
  await post<void>(sessions.warehouse, `/api/admin/branches/${sessions.branch.locationId}/funds`,
    { opening_cash: '0.00', purchase_fund: amountOf(amountCents) }, 204);
}

/** Una línea de usada de un arreglo: el modelo, las unidades y el precio de cada una. */
export interface UsedLineInput {
  readonly model: string;
  readonly quantity: number;
  readonly priceCents: bigint;
}

/** Una línea de chatarra de un arreglo: el material, los kilos y el precio del kilo. */
export interface ScrapLineInput {
  readonly materialId: number;
  readonly kgMilli: bigint;
  readonly pricePerKg: bigint;
}

/** El total exacto de un documento: la suma de lo que valen sus líneas. */
export function purchaseTotal(used: readonly UsedLineInput[], scrap: readonly ScrapLineInput[]): bigint {
  const usedTotal = used.reduce((total, line) => total + line.priceCents * BigInt(line.quantity), 0n);
  const scrapTotal = scrap.reduce((total, line) => total + scrapAmount(line.kgMilli, line.pricePerKg), 0n);
  return usedTotal + scrapTotal;
}

export interface ArrangedPurchase {
  readonly document: PurchaseDocument;
  /** El total que el arreglo comprobó antes de enviar: el documento tiene que repetirlo. */
  readonly totalCents: bigint;
}

/**
 * Una compra registrada por el contrato que la sucursal ya publica. El arrastre de la lista de
 * documentos y del comprobante sólo lee, así que la compra que listan es el arreglo, nunca el acto de la
 * prueba.
 */
export async function arrangePurchase(branch: Session, purchase: {
  readonly note: string;
  readonly used?: readonly UsedLineInput[];
  readonly scrap?: readonly ScrapLineInput[];
}): Promise<ArrangedPurchase> {
  const used = purchase.used ?? [];
  const scrap = purchase.scrap ?? [];
  const total = purchaseTotal(used, scrap);
  const document = await post<PurchaseDocument>(branch, '/api/purchases', {
    operation_key: operationKey(),
    note: purchase.note,
    used_lines: used.map(line => ({
      model: line.model, quantity: line.quantity, unit_price: amountOf(line.priceCents),
    })),
    scrap_lines: scrap.map(line => ({
      material_id: line.materialId, kg: weightOf(line.kgMilli), price_per_kg: amountOf(line.pricePerKg),
    })),
    paid_cash: amountOf(total),
    paid_transfer: '0.00',
  }, 201);
  return { document, totalCents: total };
}

/** El documento guardado, leído por el id con el que la propia pantalla lo abre. */
export async function purchaseDocument(session: Session, id: number): Promise<PurchaseDocument> {
  return get<PurchaseDocument>(session, `/api/purchases/${id}`);
}

/**
 * La lista de documentos de la sucursal. Sin período es la que la pantalla pide al abrirse —el saldo
 * pendiente—, y con `all` el historial entero; las dos listan todos los documentos de la sucursal.
 */
export async function purchaseListing(session: Session, query: {
  readonly page?: number; readonly pageSize?: number; readonly period?: string;
} = {}): Promise<PurchaseListing> {
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 25;
  const period = query.period === undefined ? '' : `&period=${query.period}`;
  return get<PurchaseListing>(session, `/api/purchases?page=${page}&page_size=${pageSize}${period}`);
}

/** Los modelos que el catálogo publica: la lista del campo de modelo, sin repetir marcas. */
export async function publishedModels(session: Session): Promise<readonly string[]> {
  return (await get<{ models: readonly string[] }>(session, '/api/purchases/models')).models;
}

/** Los materiales de referencia, todos pesados en kilogramos. */
export async function publishedMaterials(session: Session): Promise<readonly PurchaseMaterial[]> {
  return (await get<{ materials: readonly PurchaseMaterial[] }>(session, '/api/purchases/materials')).materials;
}

/** El ancla de cada precio: la última compra de la sucursal, por modelo y por material. */
export async function lastPrices(session: Session): Promise<PurchaseLastPrices> {
  return get<PurchaseLastPrices>(session, '/api/purchases/last-prices');
}

/** Lo que la sucursal recibió, derivado de sus documentos: los contras restan solos. */
export async function receivedTotals(session: Session): Promise<PurchaseReceived> {
  return get<PurchaseReceived>(session, '/api/purchases/received');
}

// ---------------------------------------------------------------------------------
// El navegador: la pantalla de compras, su documento abierto y sus dos pestañas de material
// ---------------------------------------------------------------------------------

/** El local del acto: la compra es de la sucursal de la sesión y la pantalla lo dice. */
export async function openPurchases(page: Page): Promise<void> {
  await page.goto('/#/compras');
  await expect(page.getByRole('heading', { level: 1, name: 'Compras' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Compras' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByText('Ubicación asignada: Sucursal A')).toBeVisible();
}

/** El documento que el mostrador está armando: sus líneas, su nota y su pago. */
export function purchaseDialog(page: Page): Locator {
  return page.getByRole('dialog', { name: 'Nueva compra' });
}

export async function openPurchaseDialog(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Registrar compra' }).click();
  const dialog = purchaseDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { level: 2, name: 'Nueva compra' })).toBeVisible();
  return dialog;
}

/** Los dos tipos de línea del documento: el que la pestaña elegida ya dejó puesto. */
export function kindButton(dialog: Locator, kind: 'used' | 'scrap'): Locator {
  return dialog.getByRole('button', { name: kind === 'used' ? 'Batería usada' : 'Chatarra por kg' });
}

export function usedModelField(dialog: Locator): Locator {
  return dialog.getByLabel('Modelo', { exact: true });
}
export function usedQuantityField(dialog: Locator): Locator {
  return dialog.getByLabel('Cantidad', { exact: true });
}
export function usedPriceField(dialog: Locator): Locator {
  return dialog.getByLabel('Precio por batería (Bs)', { exact: true });
}
export function scrapMaterialField(dialog: Locator): Locator {
  return dialog.getByLabel('Material', { exact: true });
}
export function scrapKgField(dialog: Locator): Locator {
  return dialog.getByLabel('Kilogramos', { exact: true });
}
export function scrapPriceField(dialog: Locator): Locator {
  return dialog.getByLabel('Precio por kilogramo (Bs)', { exact: true });
}

/** El importe de la línea que se está tipeando, calculado antes de agregarla al documento. */
export function liveAmount(dialog: Locator): Locator {
  return dialog.locator('p.purchase-amount');
}

/** La fila de una línea ya agregada, nombrada por el modelo o el material que imprimen sus campos. */
export function draftLine(dialog: Locator, label: string): Locator {
  return dialog.getByRole('table').locator('tbody tr').filter({ hasText: label });
}

export function cashField(dialog: Locator): Locator {
  return dialog.getByLabel('Efectivo del fondo de compras');
}
export function noteField(dialog: Locator): Locator {
  return dialog.getByLabel('Nota (opcional)');
}

/** El total del documento que el mostrador ve antes de confirmarlo. */
export function totalToPay(dialog: Locator): Locator {
  return dialog.getByText('Total a pagar', { exact: true }).locator('..').locator('strong');
}

/** Lo que la pantalla dice de la diferencia entre el efectivo y el total: falta, sobra o cubre. */
export function settlementNote(dialog: Locator): Locator {
  return dialog.getByRole('status');
}

/** El botón que registra el documento: el mismo de la silla y el del pie, éste es el del pie. */
export function confirmButton(dialog: Locator): Locator {
  return dialog.getByRole('button', { name: 'Registrar compra' });
}

/** El acto de la usada: el modelo, las unidades, el precio y el importe que la pantalla calcula. */
export async function addUsedLine(dialog: Locator, line: UsedLineInput): Promise<void> {
  await kindButton(dialog, 'used').click();
  await expect(kindButton(dialog, 'used')).toHaveAttribute('aria-pressed', 'true');
  await usedModelField(dialog).fill(line.model);
  await usedQuantityField(dialog).fill(String(line.quantity));
  await usedPriceField(dialog).fill(typedMoney(line.priceCents));
  await expect(liveAmount(dialog)).toHaveText(money(line.priceCents * BigInt(line.quantity)));
  await dialog.getByRole('button', { name: 'Agregar batería' }).click();
}

/** El acto de la chatarra: el material, los kilogramos, el precio del kilo y su importe. */
export async function addScrapLine(dialog: Locator, line: ScrapLineInput & { readonly name: string }): Promise<void> {
  await kindButton(dialog, 'scrap').click();
  await expect(kindButton(dialog, 'scrap')).toHaveAttribute('aria-pressed', 'true');
  await scrapMaterialField(dialog).selectOption(String(line.materialId));
  await scrapKgField(dialog).fill(typedKg(line.kgMilli));
  await scrapPriceField(dialog).fill(typedMoney(line.pricePerKg));
  await expect(liveAmount(dialog)).toHaveText(money(scrapAmount(line.kgMilli, line.pricePerKg)));
  await dialog.getByRole('button', { name: 'Agregar material' }).click();
}

/** La pestaña de los documentos: la lista de compras registradas en la sucursal. */
export function purchasesTab(page: Page, name: RegExp): Locator {
  return page.getByRole('tab', { name });
}

export function purchasesPanel(page: Page, name: RegExp): Locator {
  return page.getByRole('tabpanel', { name });
}

export function documentsPanel(page: Page): Locator {
  return purchasesPanel(page, /^Documentos/);
}

export async function showDocuments(page: Page): Promise<Locator> {
  await purchasesTab(page, /^Documentos/).click();
  const panel = documentsPanel(page);
  await expect(panel.getByRole('heading', { level: 2, name: 'Documentos' })).toBeVisible();
  return panel;
}

export function documentRow(panel: Locator, id: number): Locator {
  return panel.locator(`tr[data-purchase-id="${id}"]`);
}

/**
 * La fila de un documento en la lista. La pantalla no tiene búsqueda, así que la única forma de llegar a
 * un documento es la que el operador tiene: elegir la página más ancha y recorrer las páginas hasta la
 * fila. La espera es la del pager, que publica la página ya leída, nunca un tiempo fijo.
 */
export async function showDocumentRow(page: Page, id: number): Promise<Locator> {
  const panel = await showDocuments(page);
  await panel.getByLabel('Compras por página').selectOption('50');
  const row = documentRow(panel, id);
  const current = panel.locator('[aria-current="page"]');
  await expect(current).toHaveText('Página 1');
  for (let number = 1; number <= 20; number += 1) {
    await expect(panel).toHaveAttribute('aria-busy', 'false');
    if (await row.count() > 0) return row;
    const next = panel.getByRole('button', { name: 'Siguiente página' });
    if (await next.isDisabled()) break;
    await next.click();
    await expect(current).toHaveText(`Página ${number + 1}`);
  }
  await expect(row).toHaveCount(1);
  return row;
}

/** El comprobante de una compra: el papel que la pantalla abre al registrar y al mirar el detalle. */
export function receiptDialog(page: Page): Locator {
  return page.getByRole('dialog', { name: /^Comprobante de compra/ });
}

/** El comprobante ya leído: su título nombra el documento que el servidor devolvió. */
export async function waitReceipt(page: Page): Promise<{ readonly dialog: Locator; readonly id: number }> {
  const dialog = receiptDialog(page);
  await expect(dialog).toBeVisible();
  const title = dialog.getByRole('heading', { level: 2 });
  await expect(title).toHaveText(/^Comprobante de compra #[1-9][0-9]*$/);
  const id = /#([1-9][0-9]*)$/.exec((await title.textContent()) ?? '')?.[1];
  if (id === undefined) throw new Error('el comprobante no nombra el documento registrado');
  return { dialog, id: Number(id) };
}

/** La anulación de un documento, con el motivo que el acto exige y el espejo que ofrece. */
export function reversalDialog(page: Page, id: number): Locator {
  return page.getByRole('dialog', { name: `Anular compra #${id}` });
}

/** Una línea del comprobante, nombrada por el modelo o el material que imprime en negrita. */
export function receiptLine(dialog: Locator, label: string): Locator {
  return dialog.locator('tbody tr').filter({ hasText: label });
}

/** El selector de período del período que la pantalla está mostrando. */
export function periodSelect(page: Page): Locator {
  return page.getByLabel('Período', { exact: true });
}

/** La frase que dice cuál es el período en pantalla, en palabras y sin tooltip. */
export function periodNote(page: Page): Locator {
  return page.getByRole('status').filter({ hasText: /período|historial|saldo/i });
}
