import {
  addScrapLine, amountOf, branchA, cashField, cents, confirmButton, draftLine, expect, formatKg,
  kindButton, loadPurchaseFund, milliFromWire, money, noteField, openPurchaseDialog, openPurchases,
  purchaseDocument, purchasesTab, scrapAmount, scrapMaterialField, scrapPriceField,
  settlementNote, test, totalToPay, typedKg, typedMoney, uniqueNote, waitReceipt, warehouseRole,
  publishedMaterials, weightOf,
} from './harness';

/**
 * S2 · la compra de chatarra, recorrida en el navegador (T4).
 *
 * La chatarra se compra por kilogramo: el material es una lista cerrada de referencia y el peso y el
 * precio del kilo los tipea el vendedor. La prueba abre el documento desde la pestaña de la chatarra
 * —el tipo de línea que el mostrador ya estaba mirando—, pesa, agrega y confirma, y contrasta el
 * comprobante con el documento guardado leído por el contrato (`apps/api/docs/purchases.md`).
 *
 * El peso viaja con tres decimales y el contrato redondea el importe de la línea al centavo, así que la
 * prueba compone ese redondeo con la misma regla en vez de leerlo de la aplicación.
 */

test('el mostrador registra la compra de chatarra por kilogramo desde su propia pestaña',
  async ({ page, api }) => {
    const branch = await api.as(branchA);
    const warehouse = await api.as(warehouseRole);
    await loadPurchaseFund({ branch, warehouse }, cents('1000000.00'));
    const materials = await publishedMaterials(branch);
    const copper = materials.find(entry => entry.name === 'Cobre');
    if (copper === undefined) throw new Error('el contrato no publica el material Cobre');

    const kg = milliFromWire('12.500');
    const pricePerKg = cents('8000.00');
    const amount = scrapAmount(kg, pricePerKg);
    const note = uniqueNote('chatarra');

    await openPurchases(page);
    // El mostrador elige la pestaña de la chatarra y abre el documento desde ahí.
    await purchasesTab(page, /^Chatarra/).click();
    await expect(purchasesTab(page, /^Chatarra/)).toHaveAttribute('aria-selected', 'true');
    const dialog = await openPurchaseDialog(page);
    // El documento nace en el tipo de la pestaña y arranca en el material, que es lo primero que se elige.
    await expect(kindButton(dialog, 'scrap')).toHaveAttribute('aria-pressed', 'true');
    await expect(scrapMaterialField(dialog)).toBeFocused();

    // El material no se tipea: es la lista cerrada de referencia del contrato.
    await expect(scrapMaterialField(dialog).locator('option'))
      .toHaveText(['Elegí un material', ...materials.map(entry => entry.name)]);

    await addScrapLine(dialog, { materialId: copper.id, name: copper.name, kgMilli: kg, pricePerKg });
    const row = draftLine(dialog, copper.name);
    await expect(row).toHaveCount(1);
    // La línea muestra el peso con tres decimales y el precio del kilo, y su importe es el de la línea.
    await expect(dialog.getByLabel(`Kilogramos de ${copper.name}`)).toHaveValue(typedKg(kg));
    await expect(dialog.getByLabel(`Precio por kg de ${copper.name}`)).toHaveValue(typedMoney(pricePerKg));
    await expect(row.locator('td[data-label="Importe"]')).toHaveText(money(amount));
    await expect(totalToPay(dialog)).toHaveText(money(amount));

    await noteField(dialog).fill(note);
    await cashField(dialog).fill(typedMoney(amount));
    await expect(settlementNote(dialog)).toHaveText(`Suma ${money(amount)} · cubre el total`);
    await confirmButton(dialog).click();
    await expect(dialog).toBeHidden();

    // El comprobante imprime el material, el peso con sus tres decimales y el precio del kilogramo.
    const receipt = await waitReceipt(page);
    const printed = receipt.dialog.locator('tbody tr').filter({ hasText: copper.name });
    await expect(printed.locator('td[data-label="Cantidad o kilogramos"]')).toHaveText(formatKg(kg));
    await expect(printed.locator('td[data-label="Precio"]')).toHaveText(`${money(pricePerKg)} por kg`);
    await expect(printed.locator('td[data-label="Importe"]')).toHaveText(money(amount));
    await expect(receipt.dialog.getByText(`Total: ${money(amount)}`)).toBeVisible();

    // Y lo guardado es la línea espejo de lo que el papel imprimió, sin usadas en el documento.
    const persisted = await purchaseDocument(branch, receipt.id);
    expect(persisted.used_lines).toEqual([]);
    expect(persisted.scrap_lines).toEqual([{
      material_id: copper.id, name: copper.name, kg: weightOf(kg),
      price_per_kg: '8000.00', amount: amountOf(amount),
    }]);
    expect(persisted.total).toBe(amountOf(amount));
    expect(persisted.paid_cash).toBe(amountOf(amount));
    expect(persisted.paid_transfer).toBe('0.00');
    expect(persisted.note).toBe(note);
    expect(persisted.location_id).toBe(branch.locationId);
  });
