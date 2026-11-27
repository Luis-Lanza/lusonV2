import {
  arrangeCount, arrangeInventoryBattery, branchA, expect, inventoryPage, openInventory, rowOf,
  searchBox, test,
} from './harness';
import { warehouseRole } from '../warranty/harness';

/**
 * T2 · el cambio en vivo (odd/tasks/e2e-all-flows.md, S2; contrato en `apps/api/docs/realtime.md`).
 *
 * El operador deja la consulta abierta y el stock de la variante que está mirando cambia en otra
 * sesión. El servidor publica una invalidación del inventario por el flujo de eventos de la propia
 * sesión, la pantalla vuelve a leer lo que estaba mostrando y la fila abierta pasa sola al valor nuevo:
 * el operador no recarga ni navega.
 *
 * El cambio se arregla por la API pública de la sucursal —el conteo de su propia góndola— sobre una
 * batería que sólo esta corrida conoce, así que ni otra prueba ni otro operador puede mover el número
 * que la prueba observa. La marca en la ventana prueba que la pantalla no se recargó: una recarga la
 * borra.
 */

interface Marker {
  inventoryMarker?: number;
}

test('el cambio de stock llega en vivo a la consulta que el operador tiene abierta', async ({ page, api }) => {
  const warehouse = await api.as(warehouseRole);
  const battery = await arrangeInventoryBattery(warehouse, 'VIVO');
  const branch = await api.as(branchA);
  await openInventory(page);

  // El operador acota la consulta a la batería de la corrida, que todavía no tiene existencias.
  await searchBox(page).fill(battery.model);
  const before = await inventoryPage(branch, {
    locationId: branch.locationId, kind: 'all', search: battery.model,
  });
  expect(before.items.map(item => [item.variant_id, item.existing, item.reserved, item.available]))
    .toEqual([[battery.variantId, 0, 0, 0]]);
  const row = rowOf(page, battery.variantId);
  await expect(row).toBeVisible();
  await expect(row.locator('td').nth(2)).toHaveText('0');
  await expect(row.locator('td').nth(4)).toContainText('Sin disponible');

  // La marca vive en la ventana: si la pantalla se recargara, desaparecería.
  await page.evaluate(() => { (window as unknown as Marker).inventoryMarker = Date.now(); });

  // El cambio: la sucursal cuenta tres unidades de esa batería y las aplica.
  const document = await arrangeCount(branch, battery.variantId, 3, 'vivo');
  expect(document.id).toBeGreaterThan(0);

  // Llega por el flujo de eventos: la fila abierta pasa a tres existencias sin recargar la pantalla.
  await expect(row.locator('td').nth(2)).toHaveText('3');
  await expect(row.locator('td').nth(3)).toHaveText('0');
  await expect(row.locator('td').nth(4)).toHaveText('3');
  await expect(row.getByText('Sin disponible')).toHaveCount(0);
  await expect(searchBox(page)).toHaveValue(battery.model);
  expect(await page.evaluate(() => (window as unknown as Marker).inventoryMarker !== undefined)).toBe(true);

  // Y el valor que la pantalla muestra es el que quedó persistido: el del contrato, no el de la fila.
  const after = await inventoryPage(branch, {
    locationId: branch.locationId, kind: 'all', search: battery.model,
  });
  expect(after.items.map(item => [item.variant_id, item.existing, item.reserved, item.available]))
    .toEqual([[battery.variantId, 3, 0, 3]]);
});
