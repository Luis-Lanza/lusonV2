import {
  arrangeInventoryProduct, brandFilter, branchA, contractRows, expect, inventoryPage, inventoryRows,
  kindFilter, loadedRows, openInventory, pagerRange, polarityFilter, rangeLabel, rowOf, searchBox, test,
} from './harness';
import { warehouseRole } from '../warranty/harness';

/**
 * T2 · la selección de tipo de producto (odd/tasks/e2e-all-flows.md, S2).
 *
 * La pantalla abre el listado de la propia ubicación con los dos tipos a la vez y ofrece la lista
 * cerrada de tres estados: «Todas», «Baterías» y «Otros productos». El operador elige uno y la tabla
 * queda de ese solo tipo. La prueba arregla un producto propio —nombre único de la corrida— para no
 * depender de los productos de otro flujo, y contrasta cada estado con `GET /api/inventory?kind=…`.
 */

test('el operador elige el tipo de producto y el inventario separa baterías de otros productos',
  async ({ page, api }) => {
    const warehouse = await api.as(warehouseRole);
    const product = await arrangeInventoryProduct(warehouse, 'TIPO');
    const branch = await api.as(branchA);

    // El producto recién creado nace con saldo cero en la sucursal: se ubica por su nombre.
    const other = await inventoryPage(branch, {
      locationId: branch.locationId, kind: 'other', search: product.name,
    });
    expect(other.total_variants).toBe(1);
    const productVariant = other.items[0];
    if (productVariant === undefined) throw new Error('el producto de la prueba no aparece en la consulta');

    await openInventory(page);
    const kind = kindFilter(page);
    await expect(kind.getByRole('button', { name: 'Todas' })).toHaveAttribute('aria-pressed', 'true');

    // Baterías: la tabla queda con las filas de batería del contrato y ninguna otra.
    await kind.getByRole('button', { name: 'Baterías' }).click();
    const batteries = await inventoryPage(branch, { locationId: branch.locationId, kind: 'battery' });
    await expect(kind.getByRole('button', { name: 'Baterías' })).toHaveAttribute('aria-pressed', 'true');
    expect(batteries.items.every(item => item.kind === 'battery')).toBe(true);
    expect(await loadedRows(page, batteries.items.length)).toEqual(contractRows(batteries));
    await expect(rowOf(page, productVariant.variant_id)).toHaveCount(0);
    await expect(pagerRange(page))
      .toHaveText(rangeLabel(1, batteries.items.length, batteries.total_variants));

    // Otros productos: la tabla queda con productos y la pantalla avisa que marca y polaridad son
    // atributos de las baterías, así que esos dos filtros no se pueden usar.
    await kind.getByRole('button', { name: 'Otros productos' }).click();
    const products = await inventoryPage(branch, { locationId: branch.locationId, kind: 'other' });
    await expect(kind.getByRole('button', { name: 'Otros productos' })).toHaveAttribute('aria-pressed', 'true');
    expect(products.items.every(item => item.kind === 'other')).toBe(true);
    expect(await loadedRows(page, products.items.length)).toEqual(contractRows(products));
    await expect(page.getByText('Marca y polaridad son atributos de las baterías: no se aplican a otros productos.'))
      .toBeVisible();
    await expect(brandFilter(page)).toBeDisabled();
    await expect(polarityFilter(page)).toBeDisabled();
    await expect(pagerRange(page)).toHaveText(rangeLabel(1, products.items.length, products.total_variants));

    // El producto de la corrida, buscado por su nombre único, es una fila de ese listado.
    await searchBox(page).fill(product.name);
    const ours = await inventoryPage(branch, {
      locationId: branch.locationId, kind: 'other', search: product.name,
    });
    const productRow = rowOf(page, productVariant.variant_id);
    await expect(productRow).toBeVisible();
    await expect(productRow.locator('td').nth(0).locator('.name')).toHaveText(product.name);
    await expect(productRow.getByText('Otro producto')).toBeVisible();
    expect(await loadedRows(page, ours.items.length)).toEqual(contractRows(ours));
    await expect(pagerRange(page)).toHaveText(rangeLabel(1, 1, 1));

    // «Todas» vuelve al listado de los dos tipos, que es el del contrato con `kind=all`.
    await searchBox(page).fill('');
    await kind.getByRole('button', { name: 'Todas' }).click();
    const both = await inventoryPage(branch, { locationId: branch.locationId, kind: 'all' });
    await expect(kind.getByRole('button', { name: 'Todas' })).toHaveAttribute('aria-pressed', 'true');
    expect(await loadedRows(page, both.items.length)).toEqual(contractRows(both));
    await expect(brandFilter(page)).toBeEnabled();
    await expect(polarityFilter(page)).toBeEnabled();
    await expect(inventoryRows(page)).toHaveCount(both.items.length);
  });
