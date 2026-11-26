import {
  arrangeInventoryBattery, brandFilter, branchA, contractRows, expect, inventoryPage, inventoryRows,
  loadedRows, openInventory, pagerRange, polarityFilter, rangeLabel, results, rowOf, test,
} from './harness';
import { warehouseRole } from '../warranty/harness';

/**
 * T2 · los filtros de atributos de una batería: marca y polaridad (odd/tasks/e2e-all-flows.md, S2).
 *
 * El operador elige una marca de la lista cerrada que el servidor publica y después una polaridad; los
 * dos filtros se combinan con el resto de la consulta. La prueba arregla una batería con marca propia
 * —una sola variante, polaridad L— de modo que el resultado de cada combinación es exactamente una fila
 * o ninguna, y lo contrasta con `GET /api/inventory` de la misma sesión.
 */

test('el operador filtra por marca y polaridad y el inventario descarta el resto', async ({ page, api }) => {
  const warehouse = await api.as(warehouseRole);
  const battery = await arrangeInventoryBattery(warehouse, 'MARCA');
  const branch = await api.as(branchA);
  await openInventory(page);

  // La marca de la corrida está en la lista cerrada que la pantalla ofrece, y elegirla filtra la tabla.
  await brandFilter(page).selectOption({ label: battery.brand });
  const byBrand = await inventoryPage(branch, {
    locationId: branch.locationId, kind: 'all', brand: battery.brand,
  });
  expect(byBrand.items.map(item => item.variant_id)).toEqual([battery.variantId]);
  await expect(inventoryRows(page)).toHaveCount(1);
  const row = rowOf(page, battery.variantId);
  await expect(row).toBeVisible();
  expect(await loadedRows(page, byBrand.items.length)).toEqual(contractRows(byBrand));
  await expect(pagerRange(page)).toHaveText(rangeLabel(1, 1, 1));

  // La polaridad acota el mismo listado: la variante de la corrida es L.
  await polarityFilter(page).selectOption('L');
  const left = await inventoryPage(branch, {
    locationId: branch.locationId, kind: 'all', brand: battery.brand, polarity: 'L',
  });
  expect(left.items.map(item => item.variant_id)).toEqual([battery.variantId]);
  await expect(rowOf(page, battery.variantId)).toBeVisible();
  expect(await loadedRows(page, left.items.length)).toEqual(contractRows(left));

  // La otra polaridad no existe para esa marca: la pantalla lo dice y el contrato devuelve cero.
  await polarityFilter(page).selectOption('R');
  await expect(results(page).getByText('No hay variantes para esta consulta.')).toBeVisible();
  await expect(inventoryRows(page)).toHaveCount(0);
  const right = await inventoryPage(branch, {
    locationId: branch.locationId, kind: 'all', brand: battery.brand, polarity: 'R',
  });
  expect(right.total_variants).toBe(0);
  expect(right.items).toEqual([]);
  await expect(pagerRange(page)).toHaveText(rangeLabel(0, 0, 0));

  // Y quitar la polaridad devuelve la fila de la marca, que es lo que el operador tenía antes.
  await polarityFilter(page).selectOption({ label: 'Todas' });
  await expect(rowOf(page, battery.variantId)).toBeVisible();
  await expect(inventoryRows(page)).toHaveCount(1);
});
