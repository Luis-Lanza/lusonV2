import {
  arrangeBatterySupplier, arrangeEntry, confirmReversal, expect, openEntries, openReversal, readEntry,
  showEntryRow, test, uniqueTag, warehouseRole, warehouseSessionState, warehouseStock,
} from './harness';

// Anular un ingreso es un acto del Almacén: la sucursal ni siquiera alcanza este historial.
test.use({ storageState: warehouseSessionState });

/**
 * S2 · el contra-asiento de un ingreso, recorrido en el navegador (T9).
 *
 * Un documento confirmado no se edita ni se borra: se corrige con un contra-asiento que espeja sus líneas
 * en negativo, exige un motivo y deja los dos documentos a la vista. La prueba abre la anulación de la
 * fila, lee el espejo que la confirmación ofrece, escribe el motivo y confirma; después lee las dos filas
 * del historial —el original anulado y el contra-asiento negativo— y los dos documentos persistidos.
 *
 * El ingreso que se anula lo registra la API pública de la misma sesión: anular es el acto bajo prueba. El
 * stock de la variante se lee antes del ingreso y después del contra-asiento, para afirmar que la
 * mercadería anulada deja de contar como recibida.
 */

test('el contra-asiento anula un ingreso con su motivo y la mercadería deja de contar como recibida',
  async ({ page, api }) => {
    const warehouse = await api.as(warehouseRole);
    const supplier = await arrangeBatterySupplier(warehouse);
    const variant = supplier.variants[0];
    if (variant === undefined) throw new Error('el proveedor no publicó la variante de la batería creada');
    const before = await warehouseStock(warehouse, 'battery', supplier.model, variant.variantId);
    expect(before.existing).toBe(0);
    const document = await arrangeEntry(warehouse, {
      supplierId: supplier.supplierId,
      note: `Remito T9 ${uniqueTag()}`,
      lines: [{ variantId: variant.variantId, quantity: 4 }],
    });
    expect(document.total_units).toBe(4);
    expect((await warehouseStock(warehouse, 'battery', supplier.model, variant.variantId)).existing).toBe(4);

    await openEntries(page);
    const row = await showEntryRow(page, document.id);

    // La confirmación es el espejo exacto del documento y pide el motivo: sin él no se registra nada.
    const dialog = await openReversal(page, document.id);
    await expect(dialog.getByRole('term'))
      .toHaveText(['Líneas', 'Unidades del original', 'Unidades del contra-asiento']);
    await expect(dialog.getByRole('definition')).toHaveText(['1', '4', '-4']);
    await expect(dialog.getByText('Se registra un documento nuevo con las mismas líneas en negativo')).toBeVisible();
    await expect(dialog.getByLabel('Motivo del contra-asiento')).toHaveValue('');

    const reason = `Error de carga T9 ${uniqueTag()}`;
    const counter = await confirmReversal(page, warehouse, reason);
    const notice = page.getByRole('status')
      .filter({ hasText: `Contra-asiento registrado: documento ${counter.id}` });
    await expect(notice).toHaveText(`Contra-asiento registrado: documento ${counter.id} · -4 unidades.`);

    // El original sigue en el historial, ahora anulado, y ya no ofrece anularse otra vez.
    await expect(row.locator('td[data-label="Estado"]')).toHaveText('Anulado por contra-asiento');
    await expect(row.getByRole('button', { name: `Anular ingreso #${document.id}` })).toHaveCount(0);
    await expect(row.getByRole('button', { name: `Ver detalle del ingreso #${document.id}` })).toBeEnabled();

    // Y el contra-asiento es un documento aparte, con su total en negativo y sin acción de anulación.
    const counterRow = await showEntryRow(page, counter.id);
    await expect(counterRow.locator('td[data-label="Documento"]')).toHaveText(`#${counter.id}`);
    await expect(counterRow.locator('td[data-label="Líneas"]')).toHaveText('1');
    await expect(counterRow.locator('td[data-label="Unidades"]')).toHaveText('-4');
    await expect(counterRow.locator('td[data-label="Proveedor"]')).toHaveText(supplier.supplierName);
    await expect(counterRow.getByRole('button', { name: `Anular ingreso #${counter.id}` })).toHaveCount(0);

    // Lo persistido: el original apunta a su contra, y el contra espeja todo con el motivo escrito.
    const original = await readEntry(warehouse, document.id);
    expect(original.reversed_by).toBe(counter.id);
    expect(original.reverses_entry_id).toBeNull();
    expect(original.total_units).toBe(4);
    expect(counter.reverses_entry_id).toBe(document.id);
    expect(counter.reversed_by).toBeNull();
    expect(counter.reason).toBe(reason);
    expect(counter.note).toBe('');
    expect(counter.supplier?.id).toBe(supplier.supplierId);
    expect(counter.lines.map(line => [line.variant_id, line.quantity]))
      .toEqual([[variant.variantId, -4]]);
    expect(counter.total_units).toBe(-4);

    // El stock vuelve a donde estaba: la mercadería anulada ya no cuenta como recibida.
    const after = await warehouseStock(warehouse, 'battery', supplier.model, variant.variantId);
    expect(after.existing).toBe(before.existing);
    expect(after.reserved).toBe(before.reserved);
  });
