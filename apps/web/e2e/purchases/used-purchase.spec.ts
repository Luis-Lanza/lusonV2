import {
  addUsedLine, amountOf, branchA, cashField, cents, confirmButton, draftLine, expect, kindButton,
  loadPurchaseFund, money, noteField, openPurchaseDialog, purchaseDocument, purchaseListing,
  settlementNote, test, totalToPay, typedMoney, uniqueModel, uniqueNote, waitReceipt, warehouseRole,
} from './harness';

/**
 * S2 · la compra de baterías usadas, recorrida en el navegador (T4).
 *
 * El mostrador escribe el modelo, las unidades y el precio de cada línea, y la pantalla compone el
 * importe y el total. La prueba recorre ese acto como lo hace el operador —incluida la corrección de una
 * cantidad ya cargada— y contrasta lo que la pantalla dice con el documento que el contrato publica
 * (`apps/api/docs/purchases.md`), leído por su id y nunca por la base.
 *
 * La usada no es stock de venta ni entra al catálogo: lo que el acto deja es un documento con lo que se
 * recibió y lo que costó. Tampoco queda nada de quien trae el material —el contrato lo dice con todas
 * las letras—, así que la prueba afirma esa ausencia en vez de inventar un campo que la pantalla no
 * tiene. El fondo de compras con el que se paga lo carga el Almacén por la API, que es el acto de
 * Administración y no el de esta pantalla (S3).
 */

test('el mostrador registra la compra de baterías usadas y el total que la pantalla suma es el que se guarda',
  async ({ page, api }) => {
    const branch = await api.as(branchA);
    const warehouse = await api.as(warehouseRole);
    await loadPurchaseFund({ branch, warehouse }, cents('1000000.00'));

    const first = { model: uniqueModel('USADA'), quantity: 2, priceCents: cents('12500.00') };
    const second = { model: uniqueModel('USADA'), quantity: 1, priceCents: cents('8000.00') };
    const note = uniqueNote('usadas');
    // Lo que la pantalla va a sumar: dos líneas, una de ellas corregida antes de confirmar.
    const total = cents('12500.00') * 3n + cents('8000.00');

    // El operador entra por su propia navegación, no por la URL del hash.
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Compras' })).toBeEnabled();
    await page.getByRole('button', { name: 'Compras' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Compras' })).toBeVisible();
    expect(new URL(page.url()).hash).toBe('#/compras');

    const dialog = await openPurchaseDialog(page);
    // El documento no pide nada de quien trae el material: la compra se registra a nombre de la sucursal.
    await expect(dialog.getByText('no se piden datos de quien trae el material')).toBeVisible();
    await expect(dialog.getByLabel(/vendedor|proveedor|cliente|documento|tel[eé]fono|direcci[oó]n/i))
      .toHaveCount(0);
    await expect(kindButton(dialog, 'used')).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog.getByText('Todavía no agregaste líneas.')).toBeVisible();

    // La primera usada: el modelo, las unidades y el precio, con el importe calculado mientras se tipea.
    await addUsedLine(dialog, first);
    const firstRow = draftLine(dialog, first.model);
    await expect(firstRow).toHaveCount(1);
    await expect(dialog.getByLabel(`Cantidad de ${first.model}`)).toHaveValue('2');
    await expect(dialog.getByLabel(`Precio de ${first.model}`)).toHaveValue(typedMoney(first.priceCents));
    await expect(firstRow.locator('td[data-label="Importe"]')).toHaveText(money(cents('25000.00')));
    await expect(totalToPay(dialog)).toHaveText(money(cents('25000.00')));

    // El mostrador corrige las unidades sobre la línea ya cargada y el documento se recompone solo.
    await dialog.getByLabel(`Cantidad de ${first.model}`).fill('3');
    await expect(firstRow.locator('td[data-label="Importe"]')).toHaveText(money(cents('37500.00')));
    await expect(totalToPay(dialog)).toHaveText(money(cents('37500.00')));

    // La segunda usada entra con su propio modelo y su propio precio.
    await addUsedLine(dialog, second);
    await expect(draftLine(dialog, second.model)).toHaveCount(1);
    await expect(dialog.getByLabel(`Precio de ${second.model}`)).toHaveValue(typedMoney(second.priceCents));
    await expect(totalToPay(dialog)).toHaveText(money(total));

    await noteField(dialog).fill(note);

    // El pago es en efectivo del fondo de compras y tiene que ser el total exacto, ni menos ni más.
    await cashField(dialog).fill(typedMoney(cents('30000.00')));
    await expect(settlementNote(dialog)).toHaveText(`Faltan ${money(cents('15500.00'))} para cubrir el total.`);
    await expect(confirmButton(dialog)).toBeDisabled();
    await cashField(dialog).fill(typedMoney(cents('50000.00')));
    await expect(settlementNote(dialog)).toHaveText(
      `Sobran ${money(cents('4500.00'))}: la suma no puede superar el total.`);
    await expect(confirmButton(dialog)).toBeDisabled();
    await cashField(dialog).fill(typedMoney(total));
    await expect(settlementNote(dialog)).toHaveText(`Suma ${money(total)} · cubre el total`);
    await expect(confirmButton(dialog)).toBeEnabled();

    await confirmButton(dialog).click();
    await expect(dialog).toBeHidden();

    // El documento registrado abre su comprobante, y su número es el que el servidor le dio.
    const receipt = await waitReceipt(page);
    const persisted = await purchaseDocument(branch, receipt.id);
    expect(persisted.total).toBe(amountOf(total));
    await expect(receipt.dialog.getByRole('term'))
      .toHaveText(['Documento', 'Fecha', 'Recibió', 'Forma de pago', 'Nota']);
    const facts = receipt.dialog.getByRole('definition');
    await expect(facts.nth(0)).toHaveText(`#${receipt.id}`);
    await expect(facts.nth(1).locator('time')).toHaveAttribute('datetime', persisted.created_at);
    await expect(facts.nth(2)).toHaveText(`Cuenta #${persisted.created_by_account_id}`);
    await expect(facts.nth(3)).toHaveText('Efectivo');
    await expect(facts.nth(4)).toHaveText(note);
    // Las dos líneas del papel son las dos usadas, con su cantidad, su precio y su importe.
    const printed = receipt.dialog.locator('tbody tr').filter({ hasText: first.model });
    await expect(printed.locator('td[data-label="Cantidad o kilogramos"]')).toHaveText('3');
    await expect(printed.locator('td[data-label="Precio"]')).toHaveText(money(first.priceCents));
    await expect(printed.locator('td[data-label="Importe"]')).toHaveText(money(cents('37500.00')));
    await expect(receipt.dialog.locator('tbody tr').filter({ hasText: second.model })).toHaveCount(1);
    await expect(receipt.dialog.getByText(`Total: ${money(total)}`)).toBeVisible();

    // Cerrado el comprobante, la pantalla deja el aviso del documento emitido.
    await receipt.dialog.getByRole('button', { name: 'Volver' }).click();
    await expect(receipt.dialog).toBeHidden();
    await expect(page.getByRole('status').filter({ hasText: 'Compra registrada' }))
      .toHaveText(`Compra registrada: documento #${receipt.id} · ${money(total)}.`);

    // Lo persistido, leído por el contrato público: el documento de la sucursal con sus dos líneas.
    expect(persisted.location_id).toBe(branch.locationId);
    expect(persisted.note).toBe(note);
    expect(persisted.paid_cash).toBe(amountOf(total));
    expect(persisted.paid_transfer).toBe('0.00');
    expect(persisted.reverses_purchase_id).toBeNull();
    expect(persisted.reversed_by).toBeNull();
    const persistedLines = new Map(persisted.used_lines.map(line => [line.model, line]));
    expect(persistedLines.size).toBe(2);
    expect(persistedLines.get(first.model))
      .toEqual({ model: first.model, quantity: 3, unit_price: '12500.00', amount: '37500.00' });
    expect(persistedLines.get(second.model))
      .toEqual({ model: second.model, quantity: 1, unit_price: '8000.00', amount: '8000.00' });
    expect(persisted.scrap_lines).toEqual([]);
    // El documento no tiene ningún campo donde escribir quién trajo el material.
    expect(Object.keys(persisted).sort()).toEqual([
      'created_at', 'created_by_account_id', 'id', 'location_id', 'note', 'paid_cash', 'paid_transfer',
      'reason', 'reversed_by', 'reverses_purchase_id', 'scrap_lines', 'total', 'used_lines',
    ]);

    // Y la página del contrato repite el documento que el mostrador acaba de registrar.
    const listing = await purchaseListing(branch, { pageSize: 50 });
    const listed = listing.purchases.find(entry => entry.id === receipt.id);
    expect(listed).toMatchObject({
      created_at: persisted.created_at, total: amountOf(total), reverses_purchase_id: null,
      reversed_by: null, used_units: 4, scrap_lines: 0,
    });
  });
