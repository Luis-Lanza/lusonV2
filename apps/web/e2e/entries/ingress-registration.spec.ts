import {
  addBattery, arrangeBatterySupplier, catalogRow, catalogSearch, chooseSupplier, confirmButton, confirmIngress,
  documentPanel, draftQuantity, draftRow, draftTotals, expect, historyRow, kindGroup, noteField, openEntries,
  readEntry, showEntryRow, supplierSelect, test, uniqueTag, warehouseRole, warehouseSessionState, warehouseStock,
} from './harness';

// El ingreso es del Almacén: la pantalla vive detrás de su sesión y de ninguna otra.
test.use({ storageState: warehouseSessionState });

/**
 * S2 · el ingreso de mercadería del Almacén, recorrido en el navegador (T9).
 *
 * El documento se arma como lo arma el operador: elige el proveedor de la lista, busca el producto en el
 * catálogo de ese proveedor, agrega la línea, escribe la cantidad que contó y la nota del remito, y
 * confirma. La pantalla suma las líneas y las unidades —el ingreso no lleva costo ni precio: el
 * contrato lo dice explícitamente (`apps/api/docs/suppliers.md`, «No cost, no catalog mutation»)— y sólo
 * aplica el stock al confirmar.
 *
 * La prueba afirma lo que el operador ve —la confirmación con el número de documento y las unidades, la
 * fila del historial con su nota, su proveedor y su estado— y lo contrasta con el documento persistido,
 * leído por el contrato público, y con el stock del Almacén de la variante, que nace en cero porque la
 * batería la crea esta misma corrida.
 */

test('el Almacén registra un ingreso con el proveedor elegido y el stock se aplica recién al confirmar',
  async ({ page, api }) => {
    const warehouse = await api.as(warehouseRole);
    const supplier = await arrangeBatterySupplier(warehouse);
    const variant = supplier.variants[0];
    if (variant === undefined) throw new Error('el proveedor no publicó la variante de la batería creada');
    const before = await warehouseStock(warehouse, 'battery', supplier.model, variant.variantId);
    expect(before.existing).toBe(0);

    await openEntries(page);
    // La sección es la del Almacén y su hash propio la restaura.
    await expect(page.getByRole('button', { name: 'Ingresos' })).toHaveAttribute('aria-current', 'page');
    expect(new URL(page.url()).hash).toBe('#/ingresos');

    // El proveedor es la primera decisión: el selector publica la página de proveedores del contrato y
    // el de esta corrida está en ella; el documento lo publica en su ficha y no pregunta el tipo, porque
    // este proveedor ofrece uno solo.
    await chooseSupplier(page, warehouse, supplier.supplierId);
    await expect(supplierSelect(page)).toHaveValue(String(supplier.supplierId));
    await expect(page.getByRole('note', { name: 'Tipo del documento' }).first()).toHaveText('Baterías');
    await expect(kindGroup(page)).toHaveCount(0);

    // El catálogo del proveedor se busca por el modelo y la fila del producto dice lo que trae.
    await catalogSearch(page, 'battery').fill(supplier.model);
    const product = catalogRow(page, supplier.batteryId);
    await expect(product).toBeVisible();
    await expect(product).toContainText(supplier.model);
    await expect(product).toContainText(`${supplier.capacityAh} Ah`);
    await addBattery(page, supplier.brand, supplier.model, variant.polarity).click();

    // La línea entra con una unidad y el operador escribe la cantidad que contó.
    const line = draftRow(page, variant.variantId);
    await expect(line).toBeVisible();
    await expect(line).toContainText(`${supplier.brand} · ${supplier.model}`);
    await draftQuantity(page, variant.variantId).fill('3');
    const note = `Remito T9 ${uniqueTag()}`;
    await noteField(page).fill(note);

    // Los totales son la aritmética de la pantalla: una línea, tres unidades, nada aplicado todavía.
    await expect(draftTotals(page).getByRole('term')).toHaveText(['Líneas', 'Unidades']);
    await expect(draftTotals(page).getByRole('definition')).toHaveText(['1', '3']);
    await expect(documentPanel(page).getByText('Sin aplicar', { exact: true })).toBeVisible();

    const confirmed = await confirmIngress(page);
    expect(confirmed.units).toBe(3);

    // El documento queda fijo: el borrador se vacía y no hay nada más que confirmar.
    await expect(documentPanel(page).getByText('Todavía no agregaste líneas.')).toBeVisible();
    await expect(confirmButton(page)).toBeDisabled();

    // La fila del historial publica el documento, la nota, el proveedor y el estado.
    const row = await showEntryRow(page, confirmed.id);
    await expect(row.locator('td[data-label="Documento"]')).toHaveText(`#${confirmed.id}`);
    await expect(row.locator('td[data-label="Nota"]')).toHaveText(note);
    await expect(row.locator('td[data-label="Líneas"]')).toHaveText('1');
    await expect(row.locator('td[data-label="Unidades"]')).toHaveText('3');
    await expect(row.locator('td[data-label="Estado"]')).toHaveText('Aplicado');
    await expect(row.locator('td[data-label="Proveedor"]')).toHaveText(supplier.supplierName);
    await expect(row.getByRole('button', { name: `Anular ingreso #${confirmed.id}` })).toBeEnabled();
    await expect(historyRow(page, confirmed.id)).toHaveCount(1);

    // Lo persistido: el documento nombra al proveedor elegido y la única línea con su cantidad.
    const entry = await readEntry(warehouse, confirmed.id);
    expect(entry.location_id).toBe(1);
    expect(entry.supplier?.id).toBe(supplier.supplierId);
    expect(entry.supplier?.name).toBe(supplier.supplierName);
    expect(entry.note).toBe(note);
    expect(entry.reverses_entry_id).toBeNull();
    expect(entry.reversed_by).toBeNull();
    expect(entry.reason).toBe('');
    expect(entry.lines.map(line_ => [line_.variant_id, line_.kind, line_.quantity]))
      .toEqual([[variant.variantId, 'battery', 3]]);
    expect(entry.total_units).toBe(3);

    // Y el stock del Almacén es el que el ingreso aplicó: exactamente las tres unidades.
    const after = await warehouseStock(warehouse, 'battery', supplier.model, variant.variantId);
    expect(after.existing).toBe(before.existing + 3);
    expect(after.reserved).toBe(before.reserved);
  });
