import {
  branchA, contractRows, expect, inventoryPage, kindFilter, loadedRows, openInventory, pagerRange,
  rangeLabel, stockTabs, test,
} from './harness';

/**
 * T2 · el filtro por ubicación (odd/tasks/e2e-all-flows.md, S2).
 *
 * La consulta a otro local es de solo lectura: el operador cambia la ubicación que mira sin que su
 * cuenta cambie de sucursal, y el listado que recibe es el de esa ubicación. Desde el propio local el
 * inventario lista los dos tipos de producto; la consulta a otro local es el listado de baterías que el
 * contrato publica cuando no se nombra el tipo, y por eso la pantalla no ofrece esa selección.
 *
 * La prueba contrasta la tabla con `GET /api/inventory` de la misma sesión y comprueba que la cuenta
 * sigue asignada a la sucursal A.
 */

test('el operador consulta otra ubicación y el inventario dice que es solo consulta', async ({ page, api }) => {
  const branch = await api.as(branchA);
  await openInventory(page);

  // El listado propio es el que arranca seleccionado, con su selección de tipo de producto.
  await expect(stockTabs(page).getByRole('button', { name: /^Sucursal A/ }))
    .toHaveAttribute('aria-pressed', 'true');
  await expect(kindFilter(page)).toBeVisible();

  // El acto: el operador consulta el Almacén.
  await stockTabs(page).getByRole('button', { name: /^Almacén/ }).click();

  // La tabla es la del Almacén y el tipo de producto ya no se elige: la consulta es de baterías.
  await expect(page.locator('table caption')).toHaveText('Inventario de Almacén');
  await expect(kindFilter(page)).toHaveCount(0);
  await expect(stockTabs(page).getByRole('button', { name: /^Almacén/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(stockTabs(page).getByRole('button', { name: /^Sucursal A/ }))
    .toHaveAttribute('aria-pressed', 'false');

  // La consulta no reasigna la cuenta ni cambia la sección: la sesión sigue siendo la de la sucursal A.
  await expect(page.locator('.app-header')).toContainText('Ubicación asignada: Sucursal A');
  await expect(page.locator('.sidebar .assigned-location')).toHaveText('Sucursal A');
  expect(new URL(page.url()).hash).toBe('#/inventario');

  // Las filas son las del contrato del Almacén: sin `kind` nombrado, el listado de baterías solas.
  const warehouse = await inventoryPage(branch, { locationId: 1 });
  expect(warehouse.location).toEqual({ id: 1, name: 'Almacén' });
  expect(warehouse.items.every(item => item.kind === 'battery')).toBe(true);
  expect(await loadedRows(page, warehouse.items.length)).toEqual(contractRows(warehouse));
  await expect(pagerRange(page)).toHaveText(rangeLabel(1, warehouse.items.length, warehouse.total_variants));

  // Y volver a su local restaura el listado propio, con la selección de tipo de producto.
  await stockTabs(page).getByRole('button', { name: /^Sucursal A/ }).click();
  await expect(page.locator('table caption')).toHaveText('Inventario de Sucursal A');
  await expect(kindFilter(page).getByRole('button', { name: 'Todas' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.app-header')).toContainText('Ubicación asignada: Sucursal A');
});
