import type { Locator, Page } from '@playwright/test';
import { branchB, expect, test, warehouseRole, type Session } from '../warranty/harness';
import { branchBSession, warehouseSessionState } from '../warranty/sessions';

/**
 * El arnés de las transferencias (S2, T8): una solicitud de sucursal, la decisión del Almacén, el
 * envío directo, el despacho, la recepción, la cancelación y la conciliación unificada, cada acto
 * ejercido por el rol que lo posee.
 *
 * Reusa el arnés de la vertical de garantías tal cual —las sesiones que abrió el proyecto `sesiones`,
 * el fixture `api` que dispone una sesión por rol, el `test` y el `expect` de Playwright— y le agrega
 * sólo lo que la transferencia tiene de propio: la lectura del documento por el contrato que el
 * servidor ya publica (`apps/api/docs/transfers-api.md` y sus compañeros de conciliación), el saldo de
 * una variante en una ubicación, y los actos del operador, sin ningún atajo por API: aprobar, despachar,
 * recibir, cancelar y conciliar es justamente lo que las pruebas ejercen.
 *
 * El arreglo previo va por la API pública de la misma sesión (S3) y cubre sólo lo que el flujo no
 * ejercita: la transferencia que ya recorrió los actos anteriores y el stock de origen. Nada de acá
 * importa módulos de la aplicación, así que una prueba no puede pasar por coincidir con el código que
 * revisa.
 *
 * **La variante de cada corrida es un producto propio, no una batería del sembrado.** El catálogo de
 * origen de la pantalla de creación lee como mucho cuatro páginas de cincuenta variantes
 * (`loadSourceInventory`) y la base que comparten todos los grupos ya tiene más de doscientas baterías,
 * así que esa pantalla no puede armar el catálogo de baterías ni pedir una: la entrega usa el documento
 * de otros productos, que es el mismo acto de transferencia con la misma regla de stock, y de paso deja
 * las cifras de la corrida en una variante que nadie más mueve. La batería no cambia ninguna regla del
 * flujo (`apps/api/docs/transfers-api.md`, «One catalogue kind per document»).
 */

export { branchA, branchB, expect, origin, test, warehouseRole, type Session } from '../warranty/harness';
export { branchBSession, warehouseSessionState } from '../warranty/sessions';

// ---------------------------------------------------------------------------------
// Datos únicos: dos corridas de la suite nunca chocan en un producto, una nota ni una clave
// ---------------------------------------------------------------------------------

let sequence = 0;

function stamp(): string {
  sequence += 1;
  return `${Date.now().toString(36)}${sequence}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
}

/** Una clave de idempotencia del contrato: entre 16 y 128 caracteres de `[A-Za-z0-9_-]`. */
export function operationKey(prefix: string): string {
  sequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${sequence}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------------
// El contrato que el servidor publica: el documento, su recibo y su conciliación
// ---------------------------------------------------------------------------------

export type TransferKind = 'request_stock' | 'send_to_warehouse' | 'direct_shipment';
export type TransferStatus = 'pending' | 'approved' | 'rejected' | 'in_transit' | 'received' | 'cancelled';

/** Una línea publicada: la identidad del catálogo y la cantidad del documento, como texto decimal. */
export interface TransferLine {
  readonly variant_id: number;
  readonly kind: 'battery' | 'other';
  readonly name: string;
  readonly detail: string;
  readonly quantity: string;
}

export interface ReceiptLine {
  readonly variant_id: number;
  readonly expected_quantity: string;
  readonly actual_quantity: string;
  readonly available_quantity: string;
}

export interface ReceiptException {
  readonly variant_id: number;
  readonly kind: 'shortage' | 'excess' | 'unexpected';
  readonly quantity: string;
}

/** El documento que el servidor guardó, con la forma que publica su contrato de detalle. */
export interface TransferRecord {
  readonly id: string;
  readonly reference: string;
  readonly kind: TransferKind;
  readonly status: TransferStatus;
  readonly created_at: string;
  readonly creator_location_id: number;
  readonly creator_location_name: string;
  readonly origin_location_id: number;
  readonly origin_location_name: string;
  readonly destination_location_id: number;
  readonly destination_location_name: string;
  readonly approver_location_id: number;
  readonly approver_location_name: string;
  readonly items: readonly TransferLine[];
  readonly decision_location_id?: number;
  readonly decided_at?: string;
  readonly dispatch_location_id?: number;
  readonly dispatched_at?: string;
  readonly receipt_location_id?: number;
  readonly received_at?: string;
  readonly receipt?: { readonly items: readonly ReceiptLine[]; readonly exceptions: readonly ReceiptException[] };
  readonly cancellation_location_id?: number;
  readonly cancelled_at?: string;
}

/** Una propuesta de la conciliación unificada, tal como el snapshot la publica. */
export interface ReconciliationProposal {
  readonly revision: string;
  readonly operation_key: string;
  readonly initiator_location_id: number;
  readonly dispatch_quantity: string;
  readonly arrival_quantity: string;
  readonly retained_quantity: string;
  readonly reason: string;
  readonly state: 'pending' | 'superseded' | 'rejected' | 'applied';
  readonly decision: { readonly operation_key: string; readonly actor_location_id: number; readonly accepted: boolean;
    readonly reason: string } | null;
}

/** La lectura coordinada del conteo efectivo de una recepción (S2, conciliar). */
export interface UnifiedSnapshot {
  readonly schema: string;
  readonly request_id: string;
  readonly origin_location_id: number;
  readonly destination_location_id: number;
  readonly received_at: string;
  readonly original: readonly ReceiptLine[];
  readonly current: readonly {
    readonly variant_id: number;
    readonly owner: 'legacy' | 'unified';
    readonly source: 'legacy' | 'unified';
    readonly application_operation_key: string | null;
    readonly applied_revision: string;
    readonly effective_dispatch: string;
    readonly effective_actual: string;
    readonly effective_credit: string;
    readonly source_debit: string;
    readonly retained_quantity: string | null;
  }[];
  readonly lines: readonly { readonly variant_id: number; readonly expected_quantity: string;
    readonly actual_quantity: string; readonly available_quantity: string;
    readonly workflow_revision: string; readonly applied_revision: string;
    readonly proposals: readonly ReconciliationProposal[] }[];
}

interface BalanceRow {
  readonly variant_id: number;
  readonly existing: number;
  readonly reserved: number;
  readonly available: number;
}

/** El saldo de una variante en una ubicación: lo que la pantalla de inventario imprime de ella. */
export interface Balance {
  readonly existing: number;
  readonly reserved: number;
  readonly available: number;
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

async function send<T>(session: Session, method: 'post' | 'put', path: string, body: unknown,
  expected: number): Promise<T> {
  const reply = await session.request[method](path, {
    headers: { 'X-CSRF-Token': session.csrf }, data: body,
  });
  if (reply.status() !== expected) {
    throw new Error(`${method.toUpperCase()} ${path} respondió ${reply.status()} en vez de ${expected}: ${await reply.text()}`);
  }
  return json<T>(reply, `${method.toUpperCase()} ${path}`);
}

// ---------------------------------------------------------------------------------
// El arreglo: el stock de la corrida y la transferencia que ya recorrió sus actos
// ---------------------------------------------------------------------------------

/** La variante que la corrida mueve: un producto propio, su ingreso y las unidades disponibles. */
export interface RunStock {
  readonly catalogueEntryId: number;
  readonly variantId: number;
  /** El nombre que la fila del catálogo, la línea del carrito y el recibo imprimen del producto. */
  readonly name: string;
  /** El detalle que el servidor compone de sus campos, p. ej. `volumen en L: 7 L`. */
  readonly detail: string;
  /** Las unidades que el ingreso dejó en Almacén: lo único que esta corrida puede mover. */
  readonly units: number;
}

/**
 * Un producto nuevo de esta corrida con su stock en Almacén: los mismos actos que las pantallas de
 * catálogo, proveedores e ingresos hacen —el producto, el proveedor que lo ofrece y el documento de
 * ingreso— sin ningún atajo por la base. El nombre, el proveedor y la nota son únicos de la corrida.
 */
export async function arrangeRunStock(warehouse: Session, units = 25): Promise<RunStock> {
  const mark = stamp();
  const product = await send<{ id: number }>(warehouse, 'post', '/api/catalog/other-products', {
    name: `Producto flujo ${mark}`,
    fields: [{ name: 'volumen en L', kind: 'number', unit: 'L', number: '7' }],
  }, 201);
  const supplier = await send<{ id: number }>(warehouse, 'post', '/api/suppliers', {
    name: `Proveedor flujo ${mark}`, contact: '700-11111',
  }, 201);
  await send(warehouse, 'put', `/api/suppliers/${supplier.id}/offers`,
    { catalog_entry_ids: [product.id] }, 200);
  const catalog = await read<{ items: readonly { variant_id: number; name: string; detail: string }[] }>(
    warehouse, `/api/suppliers/${supplier.id}/catalog?kind=other`);
  const variant = catalog.items[0];
  if (variant === undefined) throw new Error(`el producto ${product.id} no publicó ninguna variante`);
  await send(warehouse, 'post', '/api/stock-entries', {
    operation_key: operationKey('ingreso'), supplier_id: supplier.id,
    note: `Ingreso del flujo ${mark}`, lines: [{ variant_id: variant.variant_id, quantity: units }],
  }, 201);
  return {
    catalogueEntryId: product.id, variantId: variant.variant_id,
    name: variant.name, detail: variant.detail, units,
  };
}

/**
 * El saldo de la variante de la corrida en una ubicación, leído por el mismo listado de inventario que
 * la pantalla consulta. Es la góndola de los otros productos, donde vive la variante de esta corrida:
 * el stock de las baterías compartidas se mueve mientras la suite corre y no sirve de medida.
 */
export async function balance(session: Session, locationId: number, variantId: number): Promise<Balance> {
  for (let page = 1; page <= 10; page += 1) {
    const body = await read<{ items: readonly BalanceRow[]; total_variants: number }>(session,
      `/api/inventory?location_id=${locationId}&page=${page}&page_size=50&kind=other`);
    const row = body.items.find(item => item.variant_id === variantId);
    if (row !== undefined) {
      return { existing: row.existing, reserved: row.reserved, available: row.available };
    }
    if (body.items.length === 0 || page * 50 >= body.total_variants) break;
  }
  throw new Error(`la variante ${variantId} no figura en el inventario de la ubicación ${locationId}`);
}

/** La solicitud que la sucursal crea y el Almacén todavía no decidió. */
export async function requestStock(branch: Session, variantId: number, units: number): Promise<TransferRecord> {
  return send<TransferRecord>(branch, 'post', '/api/transfers', {
    kind: 'request_stock', counterparty_location_id: 1, retry_key: operationKey('solicitud'),
    items: [{ variant_id: variantId, quantity: String(units) }],
  }, 201);
}

export async function approveTransfer(warehouse: Session, id: string): Promise<TransferRecord> {
  return send<TransferRecord>(warehouse, 'post', `/api/transfers/${id}/approve`, {}, 200);
}

export async function dispatchTransfer(warehouse: Session, id: string): Promise<TransferRecord> {
  return send<TransferRecord>(warehouse, 'post', `/api/transfers/${id}/dispatch`, {}, 200);
}

export async function receiveTransfer(destination: Session, id: string,
  actual: { readonly variantId: number; readonly units: number }): Promise<TransferRecord> {
  return send<TransferRecord>(destination, 'post', `/api/transfers/${id}/receive`, {
    items: [{ variant_id: actual.variantId, actual_quantity: String(actual.units) }],
  }, 200);
}

export async function cancelTransfer(creator: Session, id: string): Promise<TransferRecord> {
  return send<TransferRecord>(creator, 'post', `/api/transfers/${id}/cancel`, {}, 200);
}

export async function transferRecord(session: Session, id: string): Promise<TransferRecord> {
  return read<TransferRecord>(session, `/api/transfers/${id}`);
}

/**
 * El documento que la bandeja publica, buscado por la referencia que la pantalla imprimió. Es el camino
 * del operador —la bandeja de su ubicación— leído por el contrato, y no depende de que la corrida haya
 * guardado el id.
 */
export async function transferByReference(session: Session, status: TransferStatus,
  reference: string): Promise<TransferRecord> {
  for (let page = 1; page <= 10; page += 1) {
    const body = await read<{ records: readonly TransferRecord[]; total_count: string }>(session,
      `/api/transfers?page=${page}&page_size=25&status=${status}`);
    const row = body.records.find(record => record.reference === reference);
    if (row !== undefined) return row;
    if (body.records.length === 0) break;
  }
  throw new Error(`la transferencia ${reference} no figura entre las ${status} de la ubicación asignada`);
}

export interface TransferSessions { readonly branch: Session; readonly warehouse: Session }

/** Una solicitud pendiente de la corrida: el documento que el Almacén decide por pantalla. */
export async function arrangePending(stock: RunStock, sessions: TransferSessions, units: number): Promise<TransferRecord> {
  return requestStock(sessions.branch, stock.variantId, units);
}

/** Una solicitud ya aprobada: el documento que el origen despacha, cancela o recibe por pantalla. */
export async function arrangeApproved(stock: RunStock, sessions: TransferSessions, units: number): Promise<TransferRecord> {
  const pending = await arrangePending(stock, sessions, units);
  return approveTransfer(sessions.warehouse, pending.id);
}

/** Una solicitud ya despachada: el documento que el destino recibe por pantalla. */
export async function arrangeInTransit(stock: RunStock, sessions: TransferSessions, units: number): Promise<TransferRecord> {
  const approved = await arrangeApproved(stock, sessions, units);
  return dispatchTransfer(sessions.warehouse, approved.id);
}

/**
 * Una recepción con el conteo que la corrida declara. La diferencia entre lo enviado y lo recibido es la
 * que la conciliación unificada viene a resolver, y es el único dato que la prueba no puede inventar sin
 * que deje de ser una diferencia real.
 */
export async function arrangeReceived(stock: RunStock, sessions: TransferSessions,
  units: number, actual: number): Promise<TransferRecord> {
  const transit = await arrangeInTransit(stock, sessions, units);
  return receiveTransfer(sessions.branch, transit.id, { variantId: stock.variantId, units: actual });
}

/**
 * Un envío directo que el Almacén crea, despacha y la sucursal recibe: el camino por el que la corrida
 * deja stock propio en la sucursal para el acto que lo necesita de ese lado.
 */
export async function arrangeDirectShipment(stock: RunStock, sessions: TransferSessions,
  units: number): Promise<TransferRecord> {
  const created = await send<TransferRecord>(sessions.warehouse, 'post', '/api/transfers', {
    kind: 'direct_shipment', counterparty_location_id: sessions.branch.locationId,
    retry_key: operationKey('directo'), items: [{ variant_id: stock.variantId, quantity: String(units) }],
  }, 201);
  await dispatchTransfer(sessions.warehouse, created.id);
  return receiveTransfer(sessions.branch, created.id, { variantId: stock.variantId, units });
}

// ---------------------------------------------------------------------------------
// La conciliación unificada por su contrato público
// ---------------------------------------------------------------------------------

export async function unifiedSnapshot(session: Session, id: string): Promise<UnifiedSnapshot> {
  return read<UnifiedSnapshot>(session, `/api/transfers/${id}/unified-reconciliations`);
}

/** La propuesta de la contraparte, tal como la bandeja de revisión la va a encontrar. */
export async function proposeReconciliation(session: Session, id: string, proposal: {
  readonly variantId: number;
  readonly revision: string;
  readonly dispatch: number;
  readonly arrival: number;
  readonly retained: number;
  readonly reason: string;
}): Promise<void> {
  await send(session, 'post', `/api/transfers/${id}/unified-reconciliations/propose`, {
    variant_id: proposal.variantId, operation_key: operationKey('propuesta'),
    expected_revision: proposal.revision, retained_at_origin: false, reason: proposal.reason,
    dispatch_quantity: String(proposal.dispatch), arrival_quantity: String(proposal.arrival),
    retained_quantity: String(proposal.retained),
  }, 200);
}

/**
 * La decisión de la contraparte sobre esa propuesta. El arreglo la usa sólo para devolver el conteo a su
 * lugar cuando la prueba no ejerce la aceptación; el acto que la prueba ejerce es el de la pantalla.
 */
export async function decideReconciliation(session: Session, id: string, action: 'accept' | 'reject',
  decision: { readonly variantId: number; readonly revision: string; readonly reason: string }): Promise<void> {
  await send(session, 'post', `/api/transfers/${id}/unified-reconciliations/${action}`, {
    variant_id: decision.variantId, operation_key: operationKey(action), expected_revision: decision.revision,
    retained_at_origin: false, reason: decision.reason,
  }, 200);
}

// ---------------------------------------------------------------------------------
// El navegador: la bandeja de transferencias y el detalle de un documento
// ---------------------------------------------------------------------------------

/** La bandeja de la sesión: la lista de la que sale cada acto. */
export async function openTransferList(page: Page): Promise<void> {
  await page.goto('/#/transferencias');
  await expect(page.getByRole('heading', { level: 1, name: /^Transferencias/ })).toBeVisible();
}

/** El filtro de estado de la bandeja, con la etiqueta que la pantalla le da. */
export async function filterTransfers(page: Page, label: string): Promise<void> {
  await page.getByLabel('Estado de transferencia').selectOption({ label });
}

/**
 * La fila de un documento, nombrada por el número que su botón anuncia. Una corrida crea su documento
 * segundos antes de abrirlo y la lista ordena por id descendente, así que la fila es la primera de su
 * estado; el filtro por estado deja el conjunto todavía más corto.
 */
export function transferRow(page: Page, reference: string): Locator {
  return page.getByRole('row').filter({ has: page.getByRole('button', { name: `Ver detalle ${reference}` }) });
}

/** El acto de abrir un documento: el operador toca la fila y llega a su detalle. */
export async function openTransfer(page: Page, record: TransferRecord): Promise<Locator> {
  const row = transferRow(page, record.reference);
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: `Ver detalle ${record.reference}` }).click();
  const detail = page.getByRole('region', { name: 'Detalle de transferencia' });
  await expect(detail).toBeVisible();
  await expect(detail.getByRole('heading', { level: 1, name: record.reference })).toBeVisible();
  return detail;
}

/** Vuelve de un detalle a la bandeja por el botón que la propia pantalla ofrece. */
export async function backToTransfers(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Volver a (transferencias|pendientes|aprobadas|rechazadas|en tránsito|recibidas|canceladas)$/ })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: /^Transferencias/ })).toBeVisible();
}

// ---------------------------------------------------------------------------------
// La pantalla de creación: el tipo, el catálogo de origen y el carrito
// ---------------------------------------------------------------------------------

/** El paso del tipo: un documento nunca mezcla baterías y otros productos. */
export async function chooseProductsKind(page: Page): Promise<void> {
  await page.getByRole('group', { name: 'Tipo de producto de la transferencia' })
    .getByRole('button', { name: 'Otros productos', exact: true }).click();
  await expect(page.getByText('Esta transferencia es de Otros productos. Un documento nunca mezcla los dos tipos.')).toBeVisible();
}

/** El campo de búsqueda del catálogo de otros productos. */
function productSearch(page: Page): Locator {
  return page.getByLabel('Buscar nombre o dato del producto');
}

/** La fila del catálogo de origen que nombra la variante de la corrida. */
function sourceRow(page: Page, stock: RunStock): Locator {
  return page.getByRole('row').filter({ has: page.getByRole('button', { name: `Añadir ${stock.name}` }) });
}

/** La cantidad que el operador escribe en la fila del catálogo antes de añadirla. */
function sourceQuantity(page: Page, stock: RunStock): Locator {
  return page.getByLabel(`Cantidad ${stock.name}`, { exact: true });
}

/** El carrito de la solicitud o del envío, que la pantalla titula con su propio nombre. */
export function creationCart(page: Page): Locator {
  return page.getByRole('complementary', { name: 'Carrito de transferencia' });
}

/** El acto de agregar: busca la variante de la corrida, escribe la cantidad y la suma al carrito. */
export async function addToCart(page: Page, stock: RunStock, units: number): Promise<void> {
  await productSearch(page).fill(stock.name);
  const row = sourceRow(page, stock);
  await expect(row).toBeVisible();
  await expect(row).toContainText(stock.detail);
  await sourceQuantity(page, stock).fill(String(units));
  await row.getByRole('button', { name: `Añadir ${stock.name}` }).click();
  const cart = creationCart(page);
  await expect(cart.getByRole('heading', { level: 3, name: stock.name })).toBeVisible();
  await expect(cart.getByLabel(`Cantidad seleccionada ${stock.name}`)).toHaveValue(String(units));
}

/** El botón que abre la revisión: la solicitud y el envío lo nombran distinto. */
export async function openReview(page: Page, direct: boolean): Promise<Locator> {
  await creationCart(page).getByRole('button', { name: direct ? 'Revisar envío' : 'Revisar solicitud' }).click();
  const dialog = page.getByRole('dialog', { name: direct ? 'Revisar envío' : 'Revisar solicitud' });
  await expect(dialog).toBeVisible();
  return dialog;
}

// ---------------------------------------------------------------------------------
// La conciliación unificada: el acto de resolver la diferencia de una recepción
// ---------------------------------------------------------------------------------

/** La conciliación unificada se abre desde el detalle de una recepción. */
export async function openReconciliation(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Resolver diferencia' }).first().click();
  const modal = page.getByRole('dialog', { name: 'Resolver diferencia' });
  await expect(modal).toBeVisible();
  return modal;
}

/** El valor que la revisión de la conciliación publica al lado de una de sus etiquetas de efecto. */
export function reconciliationEffect(modal: Locator, label: string): Locator {
  return modal.locator('dl.unified-effects dt').filter({ hasText: label })
    .locator('xpath=following-sibling::dd[1]');
}
