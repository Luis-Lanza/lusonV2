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
 * borrador y contrasta el número con el que el documento persiste. Antes de contar afirma la regla de la
 * planilla entera de la sucursal grande: una línea por **cada** variante con existencia, sin faltar una
 * —la cobertura, que es la dirección que importa—, porque un conteo sobre una planilla recortada no
 * probaría nada. El tamaño no se exige: la prueba de que una planilla por encima del viejo tope de 190
 * líneas se lee entera vive en `TestClosingsBranchAboveTheOldSheetBoundSettles` (apps/api/internal/httpapi),
 * donde armar 190+ variantes con existencia es trabajo del fixture efímero y no de esta base. Después
 * devuelve la fila al sistema antes de cerrar, así el cierre de la prueba no mueve la góndola de la
 * sucursal: lo contado es exactamente lo que el sistema ya tenía (S4).
 */

/**
 * El tope de líneas que el servidor aplicaba a la planilla antes de S1 (`MaxCountLines`). La migración 028
 * lo soltó del catálogo y la planilla no tiene tope propio: se afirma sólo cuando esta sucursal pasa ese
 * tamaño por sí sola, nunca como requisito de la prueba.
 */
const oldSheetBound = 190;

freeBranch();

test.use({ storageState: warehouseSessionState });

test('el Almacén cuenta una variante, la planilla muestra la diferencia y el borrador la guarda',
  async ({ page, api }) => {
    const warehouse = await api.as(warehouseRole);
    const branch = await api.as(branchB);
    await ensureCommission(warehouse, knownBranchId);
    const opened = await arrangedOpen(warehouse, branch, knownBranchId);

    // La planilla es la del catálogo y no la de un tope (S1): una línea por variante con existencia, sin
    // faltar una. Esa cobertura es lo que esta base puede afirmar; el tamaño lo afirma el test de Go
    // `TestClosingsBranchAboveTheOldSheetBoundSettles`, que arma 190+ variantes sobre el fixture efímero y
    // corre el cierre entero arriba de ese tope. Acá el viejo tope se afirma sólo si esta sucursal lo pasa
    // por su propio tamaño, nunca como requisito: exigirlo sería afirmar el tamaño de la base, no la regla.
    const shelf = await stockOf(warehouse, knownBranchId);
    const inStock = [...shelf].filter(([, existing]) => existing > 0).map(([variant]) => variant);
    const sheet = new Set(opened.count_lines.map(row => row.variant_id));
    expect(inStock.filter(variant => !sheet.has(variant))).toEqual([]);
    if (inStock.length > oldSheetBound) {
      expect(opened.count_lines.length).toBeGreaterThan(oldSheetBound);
    }

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
