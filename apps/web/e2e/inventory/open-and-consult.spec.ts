import {
  branchA, contractRows, currentPage, expect, inventoryPage, kindFilter, nextPage, openInventory,
  loadedRows, pageSize, pagerRange, previousPage, rangeLabel, results, shownTotal, stockTabs, test,
} from './harness';

/**
 * T2 · el inventario que el operador abre y consulta (odd/tasks/e2e-all-flows.md, S2 y S3).
 *
 * El acto de la pantalla no cambia nada: el operador entra a `#/inventario` y lee el stock que el
 * servidor le publica para su propia ubicación. Por eso la prueba no arregla datos: contrasta la tabla
 * contra `GET /api/inventory` de la misma sesión, fila por fila y con el total del paginador, de modo
 * que una pantalla que muestre otra cosa que el contrato queda en rojo.
 *
 * La disponibilidad no es una columna que la pantalla calcule por su cuenta: la publica el servidor
 * como existencias menos reservadas, y la prueba lee esa resta en las filas que la tabla muestra.
 */

/** La regla de cálculo que la pantalla publica arriba de la tabla, con su signo menos exacto. */
const availabilityRule = 'Regla de cálculo: Disponible = existencias \u2212 reservadas. '
  + 'Las unidades reservadas permanecen físicamente en almacén hasta confirmación de salida.';

test('el operador abre el inventario y consulta el stock de su ubicación', async ({ page, api }) => {
  const branch = await api.as(branchA);
  await openInventory(page);

  // La pantalla entró por su propio hash y la sección está activa en la navegación.
  expect(new URL(page.url()).hash).toBe('#/inventario');
  await expect(page.getByRole('link', { name: 'Inventario' })).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.app-header strong')).toHaveText('Luson Inventario');
  await expect(page.getByText('Consulta de existencias y disponibilidad en almacén y red de sucursales.'))
    .toBeVisible();

  // La consulta arranca en la ubicación asignada: la de la sesión, no otra.
  await expect(page.locator('.app-header')).toContainText('Ubicación asignada: Sucursal A');
  await expect(page.locator('.sidebar .assigned-location')).toHaveText('Sucursal A');
  await expect(stockTabs(page).getByRole('button', { name: /^Sucursal A/ }))
    .toHaveAttribute('aria-pressed', 'true');
  await expect(stockTabs(page).getByRole('button', { name: /^Sucursal A/ })).toContainText('Mi ubicación · Consulta');

  // El listado propio es el de los dos tipos de producto, con la tabla de la ubicación consultada.
  await expect(kindFilter(page).getByRole('button', { name: 'Todas' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('table caption')).toHaveText('Inventario de Sucursal A');
  for (const column of ['Producto', 'Detalle', 'Existencias', 'Reservadas', 'Disponibles']) {
    await expect(page.getByRole('columnheader', { name: column })).toBeVisible();
  }

  // Cada fila de la pantalla es la fila del contrato: identidad, detalle y los tres números de stock.
  const contract = await inventoryPage(branch, { locationId: branch.locationId, kind: 'all' });
  expect(contract.location.id).toBe(branch.locationId);
  expect(contract.items.length).toBeGreaterThan(0);
  expect(await loadedRows(page, contract.items.length)).toEqual(contractRows(contract));

  // La disponibilidad que el operador lee es la resta que la regla de cálculo publica.
  const shown = await loadedRows(page, contract.items.length);
  for (const row of shown) expect(row.available).toBe(row.existing - row.reserved);
  await expect(page.locator('.formula p')).toHaveText(availabilityRule);

  // El paginador publica la página que se está viendo y el total del contrato.
  const total = await shownTotal(page);
  expect(total).toBe(contract.total_variants);
  await expect(pagerRange(page)).toHaveText(rangeLabel(1, contract.items.length, total));
  await expect(currentPage(page)).toHaveText('1');
  await expect(previousPage(page)).toBeDisabled();
  await expect(pageSize(page)).toHaveValue('10');
  await expect(results(page)).toHaveAttribute('aria-busy', 'false');
  if (total > 10) await expect(nextPage(page)).toBeEnabled();
});
