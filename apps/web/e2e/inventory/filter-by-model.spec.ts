import {
  arrangeInventoryBattery, branchA, contractRows, expect, inventoryPage, inventoryRows, openInventory,
  loadedRows, pagerRange, rangeLabel, results, rowOf, searchBox, test,
} from './harness';
import { warehouseRole } from '../warranty/harness';

/**
 * T2 · la búsqueda por marca o modelo (odd/tasks/e2e-all-flows.md, S2).
 *
 * El operador escribe en el buscador y el inventario deja sólo las variantes cuya marca o modelo
 * coinciden. La prueba arregla una batería propia —marca y modelo únicos de la corrida— para que el
 * resultado no dependa de lo que otro flujo haya movido: nace sin saldo, así que sus tres números son
 * cero y ninguna otra prueba la toca.
 *
 * La fila que queda se contrasta con `GET /api/inventory?search=…` de la misma sesión, y una búsqueda
 * sin coincidencias se contrasta con el listado vacío del contrato.
 */

test('el operador busca por modelo y el inventario muestra solo las variantes que coinciden',
  async ({ page, api }) => {
    const warehouse = await api.as(warehouseRole);
    const battery = await arrangeInventoryBattery(warehouse, 'BUSCA');
    const branch = await api.as(branchA);
    await openInventory(page);

    // El acto: el operador escribe el modelo en el buscador.
    await searchBox(page).fill(battery.model);

    // Queda una sola fila, y es la variante que el contrato devuelve para esa búsqueda.
    const found = await inventoryPage(branch, {
      locationId: branch.locationId, kind: 'all', search: battery.model,
    });
    expect(found.total_variants).toBe(1);
    expect(found.items.map(item => item.variant_id)).toEqual([battery.variantId]);
    await expect(inventoryRows(page)).toHaveCount(1);
    const row = rowOf(page, battery.variantId);
    await expect(row).toBeVisible();
    expect(await loadedRows(page, found.items.length)).toEqual(contractRows(found));

    // La fila nombra la marca y el modelo de la corrida y la batería nace sin existencias.
    await expect(row.locator('td').nth(0).locator('.name')).toHaveText(`${battery.brand} · ${battery.model}`);
    await expect(row).toHaveAttribute('data-kind', 'battery');
    await expect(row.locator('td').nth(2)).toHaveText('0');
    await expect(row.locator('td').nth(3)).toHaveText('0');
    await expect(row.locator('td').nth(4)).toContainText('Sin disponible');
    await expect(pagerRange(page)).toHaveText(rangeLabel(1, 1, 1));

    // Una búsqueda que no coincide con nada deja la tabla vacía, y el contrato también la deja vacía.
    await searchBox(page).fill(`${battery.model} NO EXISTE`);
    await expect(results(page).getByText('No hay variantes para esta consulta.')).toBeVisible();
    await expect(inventoryRows(page)).toHaveCount(0);
    const empty = await inventoryPage(branch, {
      locationId: branch.locationId, kind: 'all', search: `${battery.model} NO EXISTE`,
    });
    expect(empty.total_variants).toBe(0);
    expect(empty.items).toEqual([]);
    await expect(pagerRange(page)).toHaveText(rangeLabel(0, 0, 0));

    // Borrar la búsqueda devuelve el listado completo de la primera página, como al entrar.
    await searchBox(page).fill('');
    const all = await inventoryPage(branch, { locationId: branch.locationId, kind: 'all' });
    await expect(inventoryRows(page)).toHaveCount(all.items.length);
    expect(await loadedRows(page, all.items.length)).toEqual(contractRows(all));
  });
