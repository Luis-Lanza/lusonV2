import {
  addBattery, addProduct, arrangeMixedSupplier, catalogSearch, chooseSupplier, confirmIngress, documentPanel,
  draftRow, draftTotals, expect, kindGroup, kindLabels, openEntries, readEntry, showEntryRow, test,
  warehouseRole, warehouseSessionState, warehouseStock,
} from './harness';

// El ingreso de otros productos es del Almacén, igual que el de baterías: una sola sesión, una sola pantalla.
test.use({ storageState: warehouseSessionState });

/**
 * S2 · el tipo del documento y el ingreso de otros productos (T9).
 *
 * Un documento es de un solo tipo y nunca mezcla. Cuando el proveedor elegido ofrece los dos tipos, la
 * pantalla tiene que preguntarlo antes de abrir un catálogo; con un borrador ya cargado, cambiar de tipo
 * descarta el borrador entero y lo confirma antes de hacerlo. La prueba recorre ese camino como el
 * operador —elige la batería, la agrega, cambia a otros productos, confirma el descarte, agrega el
 * producto y confirma el ingreso— y lee el documento persistido y el stock del producto.
 *
 * El proveedor mixto —una batería y un producto libre— lo arma la API pública de la misma sesión: armar
 * el catálogo no es el acto, el ingreso sí.
 */

test('el operador elige el tipo del documento, descarta el borrador de la batería e ingresa un producto',
  async ({ page, api }) => {
    const warehouse = await api.as(warehouseRole);
    const supplier = await arrangeMixedSupplier(warehouse);
    const batteryVariant = supplier.battery.variants[0];
    if (batteryVariant === undefined) throw new Error('el proveedor no publicó la variante de la batería creada');
    const before = await warehouseStock(warehouse, 'other', supplier.productName, supplier.productVariantId);
    expect(before.existing).toBe(0);

    await openEntries(page);
    await chooseSupplier(page, warehouse, supplier.supplierId);

    // El proveedor ofrece los dos tipos: la pantalla pregunta y todavía no leyó ningún catálogo.
    await expect(kindGroup(page)).toBeVisible();
    await expect(kindGroup(page).getByRole('button')).toHaveText([kindLabels.battery, kindLabels.other]);
    await expect(kindGroup(page).getByRole('button', { name: kindLabels.battery })).toHaveAttribute('aria-pressed', 'false');
    await expect(documentPanel(page)).toHaveCount(0);

    // Con la batería elegida, el catálogo es el de baterías y la línea entra en el borrador.
    await kindGroup(page).getByRole('button', { name: kindLabels.battery }).click();
    await catalogSearch(page, 'battery').fill(supplier.battery.model);
    await addBattery(page, supplier.battery.brand, supplier.battery.model, batteryVariant.polarity).click();
    await expect(draftRow(page, batteryVariant.variantId)).toBeVisible();
    await expect(draftTotals(page).getByRole('definition')).toHaveText(['1', '1']);

    // Cambiar de tipo con un borrador cargado pide confirmación y descarta las líneas del otro tipo.
    await kindGroup(page).getByRole('button', { name: kindLabels.other }).click();
    const switchDialog = page.getByRole('dialog', { name: 'Cambiar el tipo del ingreso' });
    await expect(switchDialog).toBeVisible();
    await expect(switchDialog.getByText('Un documento nunca mezcla los dos tipos.')).toBeVisible();
    await switchDialog.getByRole('button', { name: 'Descartar borrador y cambiar tipo' }).click();
    await expect(switchDialog).toBeHidden();

    // El documento quedó vacío, del tipo elegido, y el catálogo ahora es el de otros productos.
    await expect(kindGroup(page).getByRole('button', { name: kindLabels.other })).toHaveAttribute('aria-pressed', 'true');
    await expect(documentPanel(page).getByRole('note', { name: 'Tipo del documento' })).toHaveText(kindLabels.other);
    await expect(documentPanel(page).getByText('Todavía no agregaste líneas.')).toBeVisible();
    await expect(draftTotals(page).getByRole('definition')).toHaveText(['0', '0']);
    await expect(catalogSearch(page, 'other')).toBeVisible();

    // El producto libre se busca por su nombre, entra al documento y se confirma con su cantidad.
    await catalogSearch(page, 'other').fill(supplier.productName);
    await addProduct(page, supplier.productName).click();
    await expect(draftRow(page, supplier.productVariantId)).toContainText(supplier.productName);
    await draftRow(page, supplier.productVariantId).getByRole('spinbutton').fill('2');
    await expect(draftTotals(page).getByRole('definition')).toHaveText(['1', '2']);
    const confirmed = await confirmIngress(page);
    expect(confirmed.units).toBe(2);

    // El historial publica el documento de dos unidades con su proveedor.
    const row = await showEntryRow(page, confirmed.id);
    await expect(row.locator('td[data-label="Unidades"]')).toHaveText('2');
    await expect(row.locator('td[data-label="Proveedor"]')).toHaveText(supplier.supplierName);

    // Lo persistido: una línea de otros productos, con su identidad y sin atributos de batería.
    const entry = await readEntry(warehouse, confirmed.id);
    expect(entry.supplier?.id).toBe(supplier.supplierId);
    expect(entry.lines.map(line => [line.variant_id, line.kind, line.name, line.quantity, line.battery]))
      .toEqual([[supplier.productVariantId, 'other', supplier.productName, 2, null]]);
    expect(entry.total_units).toBe(2);
    expect(entry.reverses_entry_id).toBeNull();

    // Y el stock del producto en el Almacén es el que el ingreso aplicó.
    const after = await warehouseStock(warehouse, 'other', supplier.productName, supplier.productVariantId);
    expect(after.existing).toBe(before.existing + 2);
  });
