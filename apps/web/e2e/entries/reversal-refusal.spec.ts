import {
  arrangeBatterySupplier, arrangeEntry, expect, openEntries, readEntry, reversalDialog, showEntryRow, test,
  uniqueTag, warehouseRole, warehouseSessionState, warehouseStock,
} from './harness';

// La negativa del contra-asiento también es del Almacén: el motivo obligatorio es una regla del servidor.
test.use({ storageState: warehouseSessionState });

/**
 * S2 · la negativa del contra-asiento cuando falta el motivo (T9).
 *
 * El motivo es obligatorio y el contrato lo rechaza sin escribir nada (`400 invalid_request`). La prueba
 * recorre la negativa por la pantalla: abre la anulación, confirma sin escribir el motivo y lee el aviso
 * de la confirmación, que sigue abierta. Después afirma que nada se escribió —el original no tiene
 * contra-asiento, su fila sigue ofreciendo anularse y el stock sigue siendo el que el ingreso aplicó—
 * porque una negativa no es evidencia de nada si el documento cambió igual.
 *
 * El ingreso lo registra la API pública de la misma sesión: lo que se ejerce es la negativa del acto.
 */

test('el contra-asiento sin motivo se niega en la pantalla y no escribe ningún documento',
  async ({ page, api }) => {
    const warehouse = await api.as(warehouseRole);
    const supplier = await arrangeBatterySupplier(warehouse);
    const variant = supplier.variants[0];
    if (variant === undefined) throw new Error('el proveedor no publicó la variante de la batería creada');
    const document = await arrangeEntry(warehouse, {
      supplierId: supplier.supplierId,
      note: `Remito T9 ${uniqueTag()}`,
      lines: [{ variantId: variant.variantId, quantity: 2 }],
    });
    const received = (await warehouseStock(warehouse, 'battery', supplier.model, variant.variantId)).existing;
    expect(received).toBe(2);

    await openEntries(page);
    const row = await showEntryRow(page, document.id);
    await row.getByRole('button', { name: `Anular ingreso #${document.id}` }).click();
    const dialog = reversalDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Motivo del contra-asiento')).toHaveValue('');

    // Confirmar sin motivo no cierra la confirmación ni registra el contra-asiento.
    await dialog.getByRole('button', { name: 'Confirmar contra-asiento' }).click();
    await expect(dialog.getByRole('alert'))
      .toHaveText('El motivo es obligatorio: escribí entre 1 y 500 caracteres.');
    await expect(dialog).toBeVisible();

    // Nada se escribió: el original sigue sin contra-asiento y su mercadería sigue recibida.
    const original = await readEntry(warehouse, document.id);
    expect(original.reversed_by).toBeNull();
    expect(original.total_units).toBe(2);
    expect((await warehouseStock(warehouse, 'battery', supplier.model, variant.variantId)).existing)
      .toBe(received);

    // Cancelar cierra la confirmación y deja la fila como estaba, ofreciendo anularse.
    await dialog.getByRole('button', { name: 'Cancelar' }).click();
    await expect(dialog).toBeHidden();
    await expect(row.locator('td[data-label="Estado"]')).toHaveText('Aplicado');
    await expect(row.getByRole('button', { name: `Anular ingreso #${document.id}` })).toBeEnabled();
  });
