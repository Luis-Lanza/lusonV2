import type { Locator, Page } from '@playwright/test';
import { expect, type CountedVariant } from './harness';
import type { Session } from '../warranty/harness';

/**
 * Los actos del ajuste que el arnés de la sucursal no cubre (T12).
 *
 * El arnés del ajuste (`./harness.ts`) es de la sucursal: su conteo fija «Sucursal A» y su documento se
 * lee por el contrato de detalle. El mismo acto es del Almacén sobre su propio stock, y el conteo tiene
 * además dos desenlaces que aquel spec no recorre: contar de más y aplicar sin motivo. Este archivo sólo
 * agrega eso: el conteo del Almacén sobre el inventario de su local —leído por la consulta de inventario
 * que el producto ya publica—, el acto del contra-asiento y la bandeja del historial tal como la publica
 * `apps/api/docs/stock-adjustments.md`.
 *
 * Las lecturas son de la API pública de la aplicación: ninguna prueba importa módulos de la aplicación ni
 * escribe SQL, así que no puede pasar por coincidir con el código que revisa.
 */

/** Un motivo de la lista cerrada y distinto del que aplica el conteo: el del contra-asiento. */
export const counterMotive = 'Diferencia detectada en preparación';

interface InventoryItem {
  readonly variant_id: number;
  readonly name: string;
  readonly battery: {
    readonly brand: string;
    readonly model: string;
    readonly capacity_ah: string;
    readonly polarity: string;
  } | null;
  readonly existing: number;
  readonly reserved: number;
  readonly available: number;
}

/**
 * Una página del inventario del Almacén. La consulta es la del producto (`GET /api/inventory`), que
 * publica las existencias de cada local: es la cifra que el conteo del Almacén tiene que fotografiar.
 */
async function inventoryPage(session: Session, page: number, search = ''): Promise<readonly InventoryItem[]> {
  const path = search === ''
    ? `/api/inventory?location_id=1&page=${page}&page_size=50`
    : `/api/inventory?location_id=1&page=1&page_size=50&search=${encodeURIComponent(search)}`;
  const reply = await session.request.get(path);
  if (reply.status() !== 200) {
    throw new Error(`GET ${path} respondió ${reply.status()}: ${await reply.text()}`);
  }
  return ((await reply.json()) as { items: readonly InventoryItem[] }).items;
}

function countedVariant(item: InventoryItem): CountedVariant {
  if (item.battery === null) throw new Error(`la variante ${item.variant_id} del Almacén no es una batería`);
  return { variantId: item.variant_id, model: item.battery.model, name: item.name, existing: item.existing };
}

/**
 * Una batería del propio catálogo del Almacén, con las existencias que tiene ahora. El conteo ciego no
 * necesita stock previo para aplicarse —contar de más siempre es admisible—, pero una variante con
 * existencias hace que el esperado que el documento publica sea una cifra del local y no un cero.
 */
export async function arrangeWarehouseVariant(session: Session): Promise<CountedVariant> {
  let fallback: InventoryItem | undefined;
  for (const page of [1, 2, 3, 4]) {
    for (const item of await inventoryPage(session, page)) {
      fallback ??= item;
      if (item.existing > 0) return countedVariant(item);
    }
  }
  if (fallback === undefined) throw new Error('el Almacén no publica ninguna batería en su inventario');
  return countedVariant(fallback);
}

/** Las existencias de una variante en el Almacén, leídas de su propio inventario y no del documento. */
export async function warehouseExisting(session: Session, variant: CountedVariant): Promise<number> {
  const row = (await inventoryPage(session, 1, variant.model))
    .find(item => item.variant_id === variant.variantId);
  if (row === undefined) {
    throw new Error(`la variante ${variant.variantId} no figura en el inventario del Almacén`);
  }
  return row.existing;
}

/** Una fila del historial: los nueve campos con los que el contrato resume un documento. */
export interface LedgerRow {
  readonly id: number;
  readonly reason: string;
  readonly detail: string;
  readonly created_at: string;
  readonly lines: number;
  readonly kind: 'battery' | 'other' | null;
  readonly total_difference: number;
  readonly reverses_adjustment_id: number | null;
  readonly reversed_by: number | null;
}

/** La bandeja de documentos del local de la sesión, del más nuevo al más viejo. */
export interface Ledger {
  readonly page: number;
  readonly page_size: number;
  readonly total_adjustments: number;
  readonly adjustments: readonly LedgerRow[];
}

export async function readLedger(session: Session, pageSize = 10): Promise<Ledger> {
  const path = `/api/stock-adjustments?page=1&page_size=${pageSize}`;
  const reply = await session.request.get(path);
  if (reply.status() !== 200) {
    throw new Error(`GET ${path} respondió ${reply.status()}: ${await reply.text()}`);
  }
  return (await reply.json()) as Ledger;
}

/** Una línea del documento, con la identidad de su variante y su aritmética persistida. */
export interface DocumentLine {
  readonly variant_id: number;
  readonly catalog_entry_id: number;
  readonly kind: 'battery' | 'other';
  readonly name: string;
  readonly detail: string;
  readonly battery: {
    readonly brand: string;
    readonly model: string;
    readonly capacity_ah: string;
    readonly polarity: string;
  } | null;
  readonly expected_quantity: number;
  readonly counted_quantity: number;
  readonly difference: number;
}

/** El documento completo, con los campos de la corrección que el resumen del historial no publica. */
export interface DocumentDetail {
  readonly id: number;
  readonly location_id: number;
  readonly reason: string;
  readonly detail: string;
  readonly created_at: string;
  readonly created_by_account_id: number;
  readonly reverses_adjustment_id: number | null;
  readonly reversed_by: number | null;
  readonly reversed_by_reason: string;
  readonly lines: readonly DocumentLine[];
  readonly total_difference: number;
}

export async function readDocument(session: Session, id: number): Promise<DocumentDetail> {
  const path = `/api/stock-adjustments/${id}`;
  const reply = await session.request.get(path);
  if (reply.status() !== 200) {
    throw new Error(`GET ${path} respondió ${reply.status()}: ${await reply.text()}`);
  }
  return (await reply.json()) as DocumentDetail;
}

/** El borrador del conteo, por el nombre con el que la bandeja lo abre. */
export function countDrawer(page: Page): Locator {
  return page.getByRole('dialog', { name: 'Nuevo ajuste' });
}

/**
 * Abre el conteo y afirma su contrato de lectura: la bandeja es ciega —no publica el esperado ni ninguna
 * otra cifra de stock— y dice de qué local es el documento antes de cargar una sola línea.
 */
export async function openCount(page: Page, locationName: string): Promise<Locator> {
  await page.getByRole('button', { name: 'Nuevo ajuste' }).click();
  const drawer = countDrawer(page);
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('note')).toContainText('Conteo ciego. No se muestra el stock esperado.');
  await expect(drawer.getByText(/Esperado|Existencias|Disponibles|Reservadas/)).toHaveCount(0);
  await expect(drawer.getByText(`${locationName} · un documento puntual por conteo`)).toBeVisible();
  return drawer;
}

/** Busca la variante en el catálogo ciego del local y carga lo que el operador contó. */
export async function countLine(drawer: Locator, variant: CountedVariant, counted: number): Promise<void> {
  await drawer.getByLabel('Buscar variante').fill(variant.model);
  const line = drawer.locator(`tr[data-variant-id="${variant.variantId}"]`);
  await expect(line).toBeVisible();
  await line.getByRole('spinbutton').fill(String(counted));
  await expect(line.getByRole('spinbutton')).toHaveValue(String(counted));
}

export async function chooseMotive(drawer: Locator, motive: string): Promise<void> {
  await drawer.getByLabel('Motivo del ajuste').selectOption({ label: motive });
}

/**
 * Toca «Aplicar ajuste» como el operador y devuelve el número del documento que la confirmación nombra:
 * el único que la bandeja publica y con el que se lee el documento por el contrato de detalle.
 */
export async function submitCount(page: Page): Promise<number> {
  await countDrawer(page).getByRole('button', { name: 'Aplicar ajuste' }).click();
  const status = page.getByRole('status').filter({ hasText: /Ajuste #[1-9][0-9]* aplicado/ });
  await expect(status).toHaveCount(1);
  const id = /Ajuste #([1-9][0-9]*) aplicado/.exec(await status.textContent() ?? '')?.[1];
  if (id === undefined) throw new Error('la confirmación del ajuste no nombra el documento aplicado');
  await expect(countDrawer(page)).toBeHidden();
  return Number(id);
}

/** El acto completo del conteo, sobre el local que la pantalla está mostrando. */
export async function applyDocument(page: Page, session: Session, variant: CountedVariant, counted: number,
  motive: string, locationName: string): Promise<DocumentDetail> {
  const drawer = await openCount(page, locationName);
  await countLine(drawer, variant, counted);
  await chooseMotive(drawer, motive);
  return readDocument(session, await submitCount(page));
}

/** La fila del historial de un documento, por el número que su celda publica. */
export function documentRow(page: Page, id: number): Locator {
  return page.locator(`tr[data-adjustment-id="${id}"]`);
}

/** La confirmación del historial que nombra un contra-asiento, abierta por el botón de su fila. */
export async function openReversal(page: Page, id: number): Promise<Locator> {
  await page.getByRole('button', { name: `Revertir ajuste #${id}` }).click();
  const dialog = page.getByRole('dialog', { name: 'Registrar contra-asiento' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(`Documento #${id}`);
  return dialog;
}

/** Elige el motivo del contra-asiento y confirma, como el operador; devuelve el documento nuevo. */
export async function confirmReversal(page: Page, motive: string): Promise<number> {
  const dialog = page.getByRole('dialog', { name: 'Registrar contra-asiento' });
  await dialog.getByLabel('Motivo del contra-asiento').selectOption({ label: motive });
  await dialog.getByRole('button', { name: 'Confirmar contra-asiento' }).click();
  const status = page.getByRole('status').filter({ hasText: /Contra-asiento registrado: documento #[1-9][0-9]*/ });
  await expect(status).toHaveCount(1);
  const found = /Contra-asiento registrado: documento #([1-9][0-9]*)/.exec(await status.textContent() ?? '');
  if (found === null) throw new Error('la confirmación del contra-asiento no nombra el documento');
  await expect(page.getByRole('dialog', { name: 'Registrar contra-asiento' })).toBeHidden();
  return Number(found[1]);
}
