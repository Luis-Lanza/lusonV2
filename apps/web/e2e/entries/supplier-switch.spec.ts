import {
  addBattery, arrangeBatterySupplier, catalogRow, catalogSearch, chooseSupplier, documentPanel, draftRow,
  draftTotals, expect, listedSupplier, openEntries, supplierOptionLabel, supplierSelect, test, warehouseRole,
  warehouseSessionState, warehouseStock,
} from './harness';

// Cambiar de proveedor es un acto del documento del Almacén: sin sesión de almacén no hay documento.
test.use({ storageState: warehouseSessionState });

/**
 * S2 · el cambio de proveedor que descarta el borrador (T9).
 *
 * Un ingreso es de un solo proveedor: no hay documento mixto ni líneas migradas de un catálogo al otro. La
 * prueba arma un borrador con una línea del primer proveedor, elige el segundo en la misma lista y pasa por
 * la confirmación de la pantalla, que avisa que el borrador se descarta entero; después lee el documento
 * vacío, con el proveedor nuevo y su catálogo.
 *
 * Los dos proveedores y sus baterías los crea la API pública de la misma sesión: elegir y cambiar de
 * proveedor es el acto que se ejerce. Como el borrador no se confirma, el stock de la línea descartada se
 * lee antes y después para probar que el cambio no aplicó nada.
 */

test('cambiar de proveedor con un borrador cargado pide confirmación y descarta las líneas',
  async ({ page, api }) => {
    const warehouse = await api.as(warehouseRole);
    const first = await arrangeBatterySupplier(warehouse);
    const second = await arrangeBatterySupplier(warehouse);
    const firstVariant = first.variants[0];
    if (firstVariant === undefined) throw new Error('el primer proveedor no publicó su variante');
    const stockBefore = await warehouseStock(warehouse, 'battery', first.model, firstVariant.variantId);

    await openEntries(page);
    await chooseSupplier(page, warehouse, first.supplierId);
    await expect(supplierSelect(page)).toHaveValue(String(first.supplierId));
    await catalogSearch(page, 'battery').fill(first.model);
    await addBattery(page, first.brand, first.model, firstVariant.polarity).click();
    await expect(draftRow(page, firstVariant.variantId)).toBeVisible();
    await expect(draftTotals(page).getByRole('definition')).toHaveText(['1', '1']);

    // Elegir el otro proveedor con una línea cargada abre la confirmación y no cambia nada todavía. La
    // opción tiene que estar publicada por el selector: se afirma antes de elegirla.
    const secondListed = await listedSupplier(warehouse, second.supplierId);
    const secondOptionLabel = supplierOptionLabel(secondListed.name, secondListed.offers);
    await expect(supplierSelect(page).locator(`option[value="${second.supplierId}"]`))
      .toHaveText(secondOptionLabel);
    await supplierSelect(page).selectOption({ label: secondOptionLabel });
    const dialog = page.getByRole('dialog', { name: 'Cambiar de proveedor' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(`Documento de ${first.supplierName} · 1 línea`)).toBeVisible();
    await expect(dialog.getByText('El ingreso es de un solo proveedor.')).toBeVisible();
    await expect(dialog.getByText(second.supplierName, { exact: true })).toBeVisible();
    await expect(supplierSelect(page)).toHaveValue(String(first.supplierId));

    await dialog.getByRole('button', { name: 'Descartar borrador y cambiar proveedor' }).click();
    await expect(dialog).toBeHidden();

    // El documento queda vacío y con el proveedor nuevo: las líneas no se migraron.
    await expect(supplierSelect(page)).toHaveValue(String(second.supplierId));
    await expect(documentPanel(page).getByRole('note', { name: 'Proveedor del documento' }))
      .toHaveText(second.supplierName);
    await expect(documentPanel(page).getByText('Todavía no agregaste líneas.')).toBeVisible();
    await expect(draftTotals(page).getByRole('definition')).toHaveText(['0', '0']);
    await expect(draftRow(page, firstVariant.variantId)).toHaveCount(0);

    // El catálogo es el del proveedor nuevo: el producto del anterior ya no se ofrece.
    await catalogSearch(page, 'battery').fill(second.model);
    await expect(catalogRow(page, second.batteryId)).toBeVisible();
    await expect(catalogRow(page, first.batteryId)).toHaveCount(0);

    // Nada se aplicó: la mercadería descartada nunca entró al stock del Almacén.
    const stockAfter = await warehouseStock(warehouse, 'battery', first.model, firstVariant.variantId);
    expect(stockAfter.existing).toBe(stockBefore.existing);
    expect(stockAfter.reserved).toBe(stockBefore.reserved);
  });
