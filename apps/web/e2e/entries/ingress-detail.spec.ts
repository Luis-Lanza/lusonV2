import {
  arrangeBatterySupplier, arrangeEntry, detailDialog, expect, openEntries, readEntry, showEntryRow, test,
  uniqueTag, warehouseRole, warehouseSessionState, warehouseStock,
} from './harness';

// La lectura del documento es la del Almacén: un ingreso no se consulta desde una sucursal.
test.use({ storageState: warehouseSessionState });

/**
 * S2 · la lectura de un ingreso y de sus líneas, recorrida en el navegador (T9).
 *
 * El historial publica documentos y no líneas: el detalle es la lectura aparte que dice qué entró, con la
 * identidad de cada variante —producto, capacidad y polaridad— y el total de unidades del documento. La
 * prueba abre la fila del historial y lee el detalle como lo lee el operador, y contrasta cada renglón con
 * el contrato de detalle (`GET /api/stock-entries/{id}`).
 *
 * El documento de dos líneas lo registra la API pública de la misma sesión: registrar es el acto de otro
 * spec, y acá lo que se ejerce es la lectura. Abrir el detalle no escribe nada, así que el stock de las dos
 * variantes se lee antes y después para probarlo.
 */

test('el operador lee el detalle del ingreso con sus líneas, su total y su proveedor',
  async ({ page, api }) => {
    const warehouse = await api.as(warehouseRole);
    const supplier = await arrangeBatterySupplier(warehouse, { polarities: ['L', 'R'], capacityAh: '55.5' });
    expect(supplier.variants.map(variant => variant.polarity)).toEqual(['L', 'R']);
    const [left, right] = supplier.variants;
    if (left === undefined || right === undefined) throw new Error('la batería no abrió sus dos polaridades');
    const note = `Remito T9 ${uniqueTag()}`;
    const document = await arrangeEntry(warehouse, {
      supplierId: supplier.supplierId,
      note,
      lines: [{ variantId: left.variantId, quantity: 2 }, { variantId: right.variantId, quantity: 5 }],
    });
    const before = await Promise.all(supplier.variants.map(variant =>
      warehouseStock(warehouse, 'battery', supplier.model, variant.variantId)));

    await openEntries(page);
    const row = await showEntryRow(page, document.id);
    await expect(row.locator('td[data-label="Unidades"]')).toHaveText('7');
    await row.getByRole('button', { name: `Ver detalle del ingreso #${document.id}` }).click();

    // El detalle es el documento abierto: su número, su proveedor, su nota y su estado.
    const dialog = detailDialog(page, document.id);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('term')).toHaveText(['Documento', 'Fecha', 'Proveedor', 'Estado', 'Nota']);
    const values = dialog.getByRole('definition');
    await expect(values.nth(0)).toHaveText(`#${document.id}`);
    expect(await values.nth(1).textContent()).toBeTruthy();
    await expect(values.nth(2)).toHaveText(supplier.supplierName);
    await expect(values.nth(3)).toHaveText('Aplicado');
    await expect(values.nth(4)).toHaveText(note);

    // Y sus líneas: cada polaridad con el producto, la capacidad y la cantidad que entraron.
    await expect(dialog.locator('tbody tr[data-variant-id]')).toHaveCount(2);
    for (const variant of [left, right]) {
      const line = dialog.locator(`tr[data-variant-id="${variant.variantId}"]`);
      await expect(line.locator('td[data-label="Producto"]')).toHaveText(`${supplier.brand} · ${supplier.model}`);
      await expect(line.locator('td[data-label="Capacidad"]')).toHaveText('55.5 Ah');
      await expect(line.locator('td[data-label="Polaridad"]')).toHaveText(variant.polarity);
    }
    await expect(dialog.locator(`tr[data-variant-id="${left.variantId}"] td[data-label="Cantidad"]`)).toHaveText('2');
    await expect(dialog.locator(`tr[data-variant-id="${right.variantId}"] td[data-label="Cantidad"]`)).toHaveText('5');
    await expect(dialog.getByText('Unidades del documento: 7')).toBeVisible();
    await expect(dialog.getByText('Un documento confirmado no se edita ni se borra')).toBeVisible();

    // Lo persistido repite exactamente las dos líneas que la pantalla mostró.
    const persisted = await readEntry(warehouse, document.id);
    expect(persisted.supplier?.id).toBe(supplier.supplierId);
    expect(persisted.note).toBe(note);
    expect(persisted.lines.map(line => [line.variant_id, line.quantity, line.battery?.polarity]))
      .toEqual([[left.variantId, 2, 'L'], [right.variantId, 5, 'R']]);
    expect(persisted.total_units).toBe(7);

    // Volver cierra el detalle y no movió el stock de ninguna de las dos variantes.
    await dialog.getByRole('button', { name: 'Volver' }).click();
    await expect(dialog).toBeHidden();
    const after = await Promise.all(supplier.variants.map(variant =>
      warehouseStock(warehouse, 'battery', supplier.model, variant.variantId)));
    expect(after.map(row_ => [row_.existing, row_.reserved]))
      .toEqual(before.map(row_ => [row_.existing, row_.reserved]));
  });
