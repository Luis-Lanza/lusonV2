import {
  actionBar, arrangeUsedPurchase, arrangedOpen, branchB, closingDocument, ensureCommission,
  expect, freeBranch, knownBranchId, materialRow, materialsPanel, openWarehouseSettlement,
  settleLiveClosing, test, warehouseRole, warehouseSessionState,
} from './harness';

/**
 * S2 · el conteo de materiales rendidos: la estantería de usadas y chatarra.
 *
 * El período entrega al Almacén lo que la sucursal compró y no rindió todavía, y la pestaña
 * «Chatarra» publica esa estantería frente a lo que hay: lo comprado, lo contado y la diferencia. La
 * prueba compra una batería usada de un modelo propio de esta corrida, cuenta la línea desde la
 * pantalla, guarda el borrador y contrasta el conteo con el que el documento publica. Al cerrar, la
 * rendición se lleva exactamente lo contado y la estantería de la sucursal arranca limpia (S8, S9).
 */

freeBranch();

test.use({ storageState: warehouseSessionState });

test('el Almacén cuenta la estantería de materiales rendidos y el cierre se lleva lo contado',
  async ({ page, api }) => {
    const warehouse = await api.as(warehouseRole);
    const branch = await api.as(branchB);
    await ensureCommission(warehouse, knownBranchId);
    // Lo que el período compró: una usada de un modelo que ninguna otra corrida usa (S4).
    const model = await arrangeUsedPurchase(warehouse, branch, knownBranchId);
    const opened = await arrangedOpen(warehouse, branch, knownBranchId);

    const line = opened.material_lines.find(row => row.kind === 'used' && row.model === model);
    if (line === undefined) {
      throw new Error(`la planilla de materiales no publicó la usada ${model} que el período compró`);
    }
    expect(line.expected_quantity).toBe('1');
    expect(line.counted_quantity).toBeNull();

    await openWarehouseSettlement(page);
    // La estantería vive en la segunda pestaña del mismo documento, no en otra pantalla.
    await page.getByRole('tab', { name: 'Chatarra' }).click();
    await expect(materialsPanel(page)).toBeVisible();
    await expect(materialsPanel(page).getByText('Baterías usadas · unidades por modelo')).toBeVisible();

    const row = materialRow(page, model);
    await expect(row.locator('td').nth(0)).toHaveText(model);
    await expect(row.locator('td').nth(1)).toHaveText('1');

    // El acto: el Almacén cuenta la unidad que hay en la estantería.
    await row.locator('input.count').fill('1');
    await expect(row.locator('input.count')).toHaveValue('1');
    await expect(row.locator('td').nth(3)).toHaveText('—');
    await expect(materialsPanel(page).locator('.closing-panel-head .closing-tag')).toHaveText('Sin diferencia');

    await actionBar(page).getByRole('button', { name: 'Guardar borrador' }).click();
    await expect(page.locator('p.closing-status')).toHaveText(
      'Borrador guardado: el conteo y la caja quedan registrados y sobreviven a una recarga.');

    // El documento guardó lo contado y la diferencia que produce, en la unidad de su línea.
    const saved = await closingDocument(warehouse, opened.id);
    const savedLine = saved.material_lines.find(entry => entry.kind === 'used' && entry.model === model);
    expect(savedLine?.counted_quantity).toBe('1');
    expect(savedLine?.expected_quantity).toBe('1');
    expect(savedLine?.delivered_quantity).toBe('1');

    // El cierre se lleva todo lo contado: la línea queda entregada al Almacén en el documento cerrado.
    const closed = await settleLiveClosing(warehouse, branch, knownBranchId);
    expect(closed?.status).toBe('closed');
    const delivered = closed?.material_lines.find(entry => entry.kind === 'used' && entry.model === model);
    expect(delivered?.counted_quantity).toBe('1');
    expect(delivered?.delivered_quantity).toBe('1');
  });
