import {
  actionBar, arrangedOpen, branchB, centsOf, closingDocument, ensureCommission, countRow,
  countedField, expect, freeBranch, knownBranchId, openWarehouseSettlement, settleLiveClosing, stockOf,
  test, warehouseRole, warehouseSessionState,
} from './harness';

/**
 * S2 · el conteo físico de materiales del Almacén: la planilla del stock.
 *
 * La planilla arranca coincidiendo con el sistema, y el operador escribe sólo las variantes que contó
 * distintas. La prueba cuenta una batería de más, lee la diferencia en la fila y en la barra, guarda el
 * borrador y contrasta el número con el que el documento persiste. Antes de contar afirma la planilla
 * entera de la sucursal grande —una línea por variante con existencia, más de las 190 que antes la
 * truncaban (S1)—, porque un conteo sobre una planilla recortada no probaría nada. Después devuelve la
 * fila al sistema antes de cerrar, así el cierre de la prueba no mueve la góndola de la sucursal: lo
 * contado es exactamente lo que el sistema ya tenía (S4).
 */

freeBranch();

test.use({ storageState: warehouseSessionState });

test('el Almacén cuenta una variante, la planilla muestra la diferencia y el borrador la guarda',
  async ({ page, api }) => {
    const warehouse = await api.as(warehouseRole);
    const branch = await api.as(branchB);
    await ensureCommission(warehouse, knownBranchId);
    const opened = await arrangedOpen(warehouse, branch, knownBranchId);

    // La planilla es la del catálogo y no la de un tope (S1): una línea por variante con existencia, sin
    // recortes, y esta sucursal tiene más de las 190 que antes truncaban la lectura.
    const shelf = await stockOf(warehouse, knownBranchId);
    const inStock = [...shelf].filter(([, existing]) => existing > 0).map(([variant]) => variant);
    const sheet = new Set(opened.count_lines.map(row => row.variant_id));
    expect(inStock.filter(variant => !sheet.has(variant))).toEqual([]);
    expect(opened.count_lines.length).toBeGreaterThan(190);

    // La fila que esta prueba cuenta: una batería con existencia esperada en el corte.
    const line = opened.count_lines.find(row => row.expected_quantity > 0 && row.brand !== undefined);
    if (line === undefined) throw new Error('la planilla del corte no tiene ninguna batería con existencia');
    const before = shelf.get(line.variant_id);
    expect(before).toBe(line.expected_quantity);

    await openWarehouseSettlement(page);
    const row = countRow(page, line.variant_id);
    await expect(row).toContainText(line.model ?? '');
    await expect(row.locator('td').nth(1)).toHaveText(String(line.expected_quantity));

    // El acto: el Almacén cuenta una unidad más de la que el sistema espera.
    const counted = line.expected_quantity + 1;
    await countedField(page, line.variant_id).fill(String(counted));
    await expect(row.locator('td').nth(3)).toHaveText('+1');
    await expect(row.getByText('No coincide')).toBeVisible();
    await expect(page.getByText('1 diferencia contra el sistema').first()).toBeVisible();

    await actionBar(page).getByRole('button', { name: 'Guardar borrador' }).click();
    await expect(page.locator('p.closing-status')).toHaveText(
      'Borrador guardado: el conteo y la caja quedan registrados y sobreviven a una recarga.');

    // Lo que el documento guardó es exactamente lo contado, con la esperada del corte intacta.
    const saved = await closingDocument(warehouse, opened.id);
    const savedLine = saved.count_lines.find(entry => entry.variant_id === line.variant_id);
    expect(savedLine?.counted_quantity).toBe(counted);
    expect(savedLine?.expected_quantity).toBe(line.expected_quantity);
    // Guardar el borrador no movió la góndola: el stock se aplica al cerrar, nunca al contar.
    expect((await stockOf(warehouse, knownBranchId)).get(line.variant_id)).toBe(before);

    // La prueba devuelve la fila al sistema y cierra: la sucursal queda como estaba.
    await countedField(page, line.variant_id).fill(String(line.expected_quantity));
    await actionBar(page).getByRole('button', { name: 'Guardar borrador' }).click();
    await expect.poll(async () => (await closingDocument(warehouse, opened.id)).count_lines
      .find(entry => entry.variant_id === line.variant_id)?.counted_quantity).toBe(line.expected_quantity);

    const closed = await settleLiveClosing(warehouse, branch, knownBranchId);
    expect(closed?.status).toBe('closed');
    expect((await stockOf(warehouse, knownBranchId)).get(line.variant_id)).toBe(line.expected_quantity);
    expect(centsOf(closed?.counted_cash ?? '0.00')).toBe(centsOf(opened.expected_cash));
  });
