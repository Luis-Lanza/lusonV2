import {
  addBattery, allListedSuppliers, arrangeBatterySupplier, catalogPanel, catalogRow, catalogRows, catalogSearch,
  chooseSupplier, confirmButton, documentPanel, draftQuantity, draftRow, draftTotals, expect, openEntries,
  supplierCatalog, supplierOptionText, supplierOptions, supplierPlaceholderOption, supplierSelect, test,
  warehouseRole, warehouseSessionState,
} from './harness';

// El catálogo que el ingreso nombra es el del proveedor elegido: la pantalla es del Almacén.
test.use({ storageState: warehouseSessionState });

/**
 * S2 · la búsqueda en el catálogo del proveedor que llena las líneas del documento (T9).
 *
 * El ingreso no tiene un catálogo general: el documento se llena con los productos del proveedor elegido y
 * de ningún otro. La prueba recorre ese acto como el operador —busca, lee la fila que queda, agrega la
 * polaridad, vuelve a agregarla para sumar una unidad, escribe una cantidad y quita la línea— y afirma el
 * borrador que la pantalla arma: las líneas, las unidades y los contadores de la cabecera.
 *
 * El arreglo previo —el proveedor y su batería— va por la API pública de la misma sesión, que es también
 * la lectura con la que se contrasta qué variante ofreció el proveedor. Este acto no escribe nada: el
 * borrador no toca el stock hasta confirmar, y por eso no hay documento que leer.
 *
 * El selector de Ingresos tiene que publicar la lista **entera** de proveedores del contrato, no su primera
 * página: el control pedía una sola página de cincuenta y el operador no podía elegir a los proveedores que
 * ordenaban después. Ese es el defecto que esta prueba cubre, y se afirma donde se ve —en las opciones del
 * control—: se leen todas las páginas publicadas y las opciones tienen que ser exactamente esas filas, en
 * ese orden y con esos nombres. El proveedor de la corrida ordena **último** entre los activos por
 * construcción (`supplierName`, en el arnés), así que elegirlo obliga a la lista a llegar hasta el final.
 * En una base acumulada esta igualdad falla en voz alta si el selector lee una sola página; en una base
 * fresca —once proveedores sembrados— sigue valiendo, porque la lista completa también entra en una.
 * Ninguna otra aserción de este acto cambia.
 */

test('la búsqueda en el catálogo del proveedor filtra sus productos y llena las líneas del documento',
  async ({ page, api }) => {
    const warehouse = await api.as(warehouseRole);
    const supplier = await arrangeBatterySupplier(warehouse);
    const variant = supplier.variants[0];
    if (variant === undefined) throw new Error('el proveedor no publicó la variante de la batería creada');
    const offered = await supplierCatalog(warehouse, supplier.supplierId, 'battery');
    expect(offered.map(item => item.variant_id)).toEqual([variant.variantId]);

    // La lista completa que el operador tiene que poder elegir, leída del contrato página por página.
    const published = await allListedSuppliers(warehouse);
    const active = published.filter(listed => !listed.retired);
    // El proveedor de la corrida es el último activo: el control tiene que llegar hasta él.
    expect(active.at(-1)?.id).toBe(supplier.supplierId);

    await openEntries(page);
    // Las opciones del selector son la lista publicada entera, con sus nombres y en su orden: la primera
    // opción es el pedido de elegir un proveedor y las demás son las filas del contrato, retirados al final.
    await expect(supplierSelect(page).locator('option')).toHaveCount(published.length + 1);
    await expect.poll(() => supplierOptions(page)).toEqual([
      supplierPlaceholderOption, ...published.map(listed => supplierOptionText(listed)),
    ]);

    await chooseSupplier(page, warehouse, supplier.supplierId);
    // Elegirlo es un acto real: el contexto del documento queda con el proveedor que ordena último.
    await expect(supplierSelect(page)).toHaveValue(String(supplier.supplierId));

    // La búsqueda del catálogo publica exactamente el producto del proveedor de esta corrida.
    await catalogSearch(page, 'battery').fill(supplier.model);
    const product = catalogRow(page, supplier.batteryId);
    await expect(product).toBeVisible();
    await expect(product).toContainText(`${supplier.capacityAh} Ah`);
    await expect(catalogRows(page)).toHaveCount(1);

    // Una búsqueda sin coincidencias no inventa filas y lo dice con las palabras de la pantalla.
    await catalogSearch(page, 'battery').fill(`sin-coincidencia-${supplier.model}`);
    await expect(catalogPanel(page).getByText('Sin coincidencias en el catálogo.')).toBeVisible();
    await expect(catalogRows(page)).toHaveCount(0);

    // El operador agrega la polaridad que trae el proveedor: la línea entra con una unidad.
    await catalogSearch(page, 'battery').fill(supplier.model);
    await addBattery(page, supplier.brand, supplier.model, variant.polarity).click();
    const line = draftRow(page, variant.variantId);
    await expect(line).toBeVisible();
    await expect(line).toContainText(`${supplier.capacityAh} Ah · Polaridad ${variant.polarity}`);
    await expect(draftQuantity(page, variant.variantId)).toHaveValue('1');
    await expect(draftTotals(page).getByRole('definition')).toHaveText(['1', '1']);

    // Volver a tocar la misma polaridad suma una unidad en vez de duplicar la línea.
    await addBattery(page, supplier.brand, supplier.model, variant.polarity).click();
    await expect(draftQuantity(page, variant.variantId)).toHaveValue('2');
    await expect(documentPanel(page).getByRole('status'))
      .toHaveText(`${supplier.brand} · ${supplier.model} polaridad ${variant.polarity} ya estaba en el documento: ahora 2 unidades.`);
    await expect(draftTotals(page).getByRole('definition')).toHaveText(['1', '2']);

    // La cantidad escrita a mano es la que la pantalla suma en el pie del catálogo y en los totales.
    await draftQuantity(page, variant.variantId).fill('5');
    await expect(catalogPanel(page).locator('.stock-catalog-foot')).toContainText('1 producto');
    await expect(catalogPanel(page).locator('.stock-catalog-foot')).toContainText('1 línea en el documento');
    await expect(catalogPanel(page).locator('.stock-catalog-foot')).toContainText('5 u.');
    await expect(draftTotals(page).getByRole('definition')).toHaveText(['1', '5']);

    // Quitar la línea deja el documento vacío y la confirmación apagada: nada se aplicó.
    await line.getByRole('button', { name: `Quitar ${supplier.brand} · ${supplier.model} polaridad ${variant.polarity}` })
      .click();
    await expect(documentPanel(page).getByText('Todavía no agregaste líneas.')).toBeVisible();
    await expect(draftTotals(page).getByRole('definition')).toHaveText(['0', '0']);
    await expect(confirmButton(page)).toBeDisabled();
  });
