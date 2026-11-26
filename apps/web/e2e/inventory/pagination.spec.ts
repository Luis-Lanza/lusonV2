import {
  branchA, contractRows, currentPage, expect, inventoryPage, loadedRows, nextPage, openInventory,
  pageSize, pagerRange, previousPage, rangeLabel, test,
} from './harness';

/**
 * T2 · el paginador del inventario (odd/tasks/e2e-all-flows.md, S2).
 *
 * El operador pasa a la página siguiente y cambia las filas por página; el paginador publica el rango
 * que está mirando y el total del contrato. La prueba no arregla datos: el sembrado ya tiene más de una
 * página de baterías, y cada página se contrasta con `GET /api/inventory` para esa página y ese tamaño.
 */

test('el operador pagina el inventario y cada página trae sus propias variantes', async ({ page, api }) => {
  const branch = await api.as(branchA);
  await openInventory(page);

  // La primera página arranca con diez filas y el total del contrato.
  const first = await inventoryPage(branch, { locationId: branch.locationId, kind: 'all', page: 1, size: 10 });
  expect(first.total_variants).toBeGreaterThan(first.page_size);
  expect(await loadedRows(page, first.items.length)).toEqual(contractRows(first));
  await expect(pagerRange(page)).toHaveText(rangeLabel(1, first.items.length, first.total_variants));
  await expect(currentPage(page)).toHaveText('1');
  await expect(previousPage(page)).toBeDisabled();
  await expect(pageSize(page)).toHaveValue('10');

  // El acto: la página siguiente, con las variantes que el contrato devuelve para la página 2.
  await nextPage(page).click();
  const second = await inventoryPage(branch, { locationId: branch.locationId, kind: 'all', page: 2, size: 10 });
  expect(second.page).toBe(2);
  await expect(currentPage(page)).toHaveText('2');
  await expect(pagerRange(page)).toHaveText(rangeLabel(11, 10 + second.items.length, second.total_variants));
  await expect(previousPage(page)).toBeEnabled();
  expect(await loadedRows(page, second.items.length)).toEqual(contractRows(second));

  // Ninguna variante de la segunda página repite una de la primera: el paginador no salta ni repite.
  const firstIds = new Set(first.items.map(item => item.variant_id));
  expect(second.items.filter(item => firstIds.has(item.variant_id))).toEqual([]);

  // Y el tamaño de página: veinticinco filas, de vuelta en la primera página.
  await pageSize(page).selectOption({ label: '25' });
  const wide = await inventoryPage(branch, { locationId: branch.locationId, kind: 'all', page: 1, size: 25 });
  await expect(pageSize(page)).toHaveValue('25');
  await expect(currentPage(page)).toHaveText('1');
  await expect(pagerRange(page)).toHaveText(rangeLabel(1, wide.items.length, wide.total_variants));
  expect(await loadedRows(page, wide.items.length)).toEqual(contractRows(wide));

  // La página anterior vuelve a su rango, con las filas del contrato.
  await nextPage(page).click();
  await expect(currentPage(page)).toHaveText('2');
  await previousPage(page).click();
  await expect(currentPage(page)).toHaveText('1');
  await expect(pagerRange(page)).toHaveText(rangeLabel(1, wide.items.length, wide.total_variants));
  expect(await loadedRows(page, wide.items.length)).toEqual(contractRows(wide));
});
