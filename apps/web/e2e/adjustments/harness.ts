import type { Locator, Page } from '@playwright/test';
import { expect, type Session } from '../warranty/harness';

/**
 * El arnés del ajuste de stock de la sucursal (S36).
 *
 * Reusa el arnés de la vertical de garantías tal cual: la sesión de la sucursal A (`branchA`, abierta
 * por `e2e/warranty/auth.setup.ts`), el fixture `api` que dispone las sesiones por rol, el `test` y el
 * `expect` de Playwright, y las lecturas de góndola (`sellableExisting`) con las que se mide el stock
 * antes y después de cada acto. Este archivo sólo agrega lo que el ajuste tiene de propio: los motivos
 * que la pantalla ofrece, la lectura del documento por el contrato que ya publica el servidor
 * (`apps/api/docs/stock-adjustments.md`) y los dos actos del operador —contar y aplicar— sin ningún
 * atajo por API: el alta del ajuste es justamente lo que la prueba ejerce.
 *
 * Nada de acá importa módulos de la aplicación: la prueba no puede pasar por coincidir con el código
 * que revisa.
 */

export { branchA, expect, test } from '../warranty/harness';

/** Uno de los cuatro motivos de la lista cerrada; el que la pantalla ofrece tal cual se envía. */
export const motive = 'Conteo físico periódico';

/** El documento que el servidor guardó, con la forma que publica su contrato. */
export interface AdjustmentDocument {
  readonly id: number;
  readonly location_id: number;
  readonly reason: string;
  readonly detail: string;
  readonly created_by_account_id: number;
  readonly reverses_adjustment_id: number | null;
  readonly lines: readonly {
    readonly variant_id: number;
    readonly expected_quantity: number;
    readonly counted_quantity: number;
    readonly difference: number;
  }[];
  readonly total_difference: number;
}

/** Una variante que la sucursal tiene en su propia góndola: el conteo es sobre su stock vendible. */
export interface CountedVariant {
  readonly variantId: number;
  readonly model: string;
  /** El nombre que la pantalla imprime de la variante: marca y modelo, como lo compone el servidor. */
  readonly name: string;
  /** Las existencias que la sucursal tiene ahora, que es lo que el ajuste puede contar. */
  readonly existing: number;
}

interface SellableRow {
  readonly variant_id: number;
  readonly brand: string;
  readonly model: string;
  readonly existing: number;
}

/**
 * La góndola de la sucursal, leída por el mismo catálogo del punto de venta. La prueba no inventa
 * stock: si no hay ninguna batería con existencias, el ajuste no tendría nada que contar.
 */
export async function arrangeCountedVariant(session: Session): Promise<CountedVariant> {
  const reply = await session.request.get('/api/sales/sellable?kind=battery&page=1&page_size=10');
  if (reply.status() !== 200) {
    throw new Error(`GET /api/sales/sellable respondió ${reply.status()}: ${await reply.text()}`);
  }
  const body = (await reply.json()) as { items: readonly SellableRow[] };
  const row = body.items.find(item => item.existing > 0);
  if (row === undefined) throw new Error('la góndola de la sucursal no tiene existencias de ninguna batería');
  return {
    variantId: row.variant_id, model: row.model, name: `${row.brand} · ${row.model}`, existing: row.existing,
  };
}

/** El documento aplicado, leído por el contrato de detalle del ajuste. */
export async function readAdjustment(session: Session, id: number): Promise<AdjustmentDocument> {
  const reply = await session.request.get(`/api/stock-adjustments/${id}`);
  if (reply.status() !== 200) {
    throw new Error(`GET /api/stock-adjustments/${id} respondió ${reply.status()}: ${await reply.text()}`);
  }
  return (await reply.json()) as AdjustmentDocument;
}

/** La pantalla del ajuste, por su hash propio: la sucursal entra al mismo acto que el Almacén. */
export async function openAdjustmentHistory(page: Page): Promise<void> {
  await page.goto('/#/ajustes');
  await expect(page.getByRole('heading', { name: 'Historial de ajustes' })).toBeVisible();
}

/**
 * La ficha del acto: el local cuyo stock se está moviendo. Es la línea que hace que una sucursal lea
 * «Sucursal A» y no un documento anónimo.
 */
export function actOfTheLocation(page: Page): Locator {
  return page.getByText(/El ajuste mueve el stock vendible de/);
}

/** El documento abierto en el historial, con sus líneas de esperado, contado y diferencia. */
export function appliedDocument(page: Page, id: number): Locator {
  return page.locator(`#adjustment-lines-${id}`);
}

/**
 * El acto completo del operador: abre el conteo, busca su variante en el catálogo ciego, carga lo que
 * contó, elige el motivo y aplica. Devuelve el documento que el servidor guardó, leído por su id —el
 * que la propia pantalla usa para abrirlo— y no por lo que la pantalla dijo.
 */
export async function applyCount(page: Page, session: Session, variant: CountedVariant,
  counted: number): Promise<AdjustmentDocument> {
  await page.getByRole('button', { name: 'Nuevo ajuste' }).click();
  const drawer = page.getByRole('dialog', { name: 'Nuevo ajuste' });
  await expect(drawer).toBeVisible();
  // El conteo es ciego por contrato: antes del acto no se publica el esperado ni ninguna cifra de stock.
  await expect(drawer.getByRole('note')).toContainText('Conteo ciego. No se muestra el stock esperado.');
  await expect(drawer.getByText(/Esperado|Existencias|Disponibles|Reservadas/)).toHaveCount(0);
  await expect(drawer.getByText('Sucursal A · un documento puntual por conteo')).toBeVisible();

  await drawer.getByLabel('Buscar variante').fill(variant.model);
  const line = drawer.locator(`tr[data-variant-id="${variant.variantId}"]`);
  await expect(line).toBeVisible();
  await line.getByRole('spinbutton').fill(String(counted));
  await drawer.getByLabel('Motivo del ajuste').selectOption({ label: motive });
  await drawer.getByRole('button', { name: 'Aplicar ajuste' }).click();

  // La confirmación nombra el documento; es el único número que la bandeja publica y con el que se lee.
  const status = page.getByRole('status').filter({ hasText: /Ajuste #[1-9][0-9]* aplicado/ });
  await expect(status).toHaveCount(1);
  const id = /Ajuste #([1-9][0-9]*) aplicado/.exec(await status.textContent() ?? '')?.[1];
  if (id === undefined) throw new Error('la confirmación del ajuste no nombra el documento aplicado');
  return readAdjustment(session, Number(id));
}
