import {
  amountOf, arrangePurchase, branchA, cents, expect, formatKg, loadPurchaseFund, milliFromWire, money,
  openPurchases, purchaseDocument, purchaseListing, receiptLine, showDocumentRow, test, uniqueModel,
  uniqueNote, waitReceipt, warehouseRole, publishedMaterials,
} from './harness';

/**
 * S2 · el comprobante de una compra, abierto desde su fila (T4).
 *
 * La lista de documentos no imprime el papel: cada fila abre el comprobante interno del documento, con
 * su número, su fecha, quién lo recibió, la forma de pago, la nota del acto y las líneas. El acto de
 * esta prueba es abrirlo y volver; el documento lo registra la API pública de la misma sesión (S3) y lo
 * que el papel imprime se contrasta con la lectura del contrato (`apps/api/docs/purchases.md`).
 */

test('el comprobante de una compra se abre desde su fila con su nota, sus líneas y su pago',
  async ({ page, api }) => {
    const branch = await api.as(branchA);
    const warehouse = await api.as(warehouseRole);
    await loadPurchaseFund({ branch, warehouse }, cents('1000000.00'));
    const materials = await publishedMaterials(branch);
    const copper = materials.find(entry => entry.name === 'Cobre');
    if (copper === undefined) throw new Error('el contrato no publica el material Cobre');

    const model = uniqueModel('DETALLE');
    const kg = milliFromWire('4.500');
    const scrapPrice = cents('6500.00');
    const arranged = await arrangePurchase(branch, {
      note: uniqueNote('detalle'),
      used: [
        { model, quantity: 2, priceCents: cents('14000.00') },
        { model: uniqueModel('DETALLE'), quantity: 1, priceCents: cents('9500.00') },
      ],
      scrap: [{ materialId: copper.id, kgMilli: kg, pricePerKg: scrapPrice }],
    });
    const document = arranged.document;

    await openPurchases(page);
    const row = await showDocumentRow(page, document.id);
    await row.getByRole('button', { name: `Ver el detalle de la compra #${document.id}` }).click();

    // El papel que se abre es el del documento de esa fila.
    const receipt = await waitReceipt(page);
    expect(receipt.id).toBe(document.id);
    await expect(receipt.dialog.getByRole('term'))
      .toHaveText(['Documento', 'Fecha', 'Recibió', 'Forma de pago', 'Nota']);
    const facts = receipt.dialog.getByRole('definition');
    await expect(facts.nth(0)).toHaveText(`#${document.id}`);
    await expect(facts.nth(1).locator('time')).toHaveAttribute('datetime', document.created_at);
    await expect(facts.nth(2)).toHaveText(`Cuenta #${document.created_by_account_id}`);
    await expect(facts.nth(3)).toHaveText('Efectivo');
    await expect(facts.nth(4)).toHaveText(document.note);

    // Las líneas del papel son las del documento, con su cantidad, su precio y su importe.
    for (const line of document.used_lines) {
      const printed = receiptLine(receipt.dialog, line.model);
      await expect(printed.locator('td[data-label="Cantidad o kilogramos"]')).toHaveText(String(line.quantity));
      await expect(printed.locator('td[data-label="Precio"]')).toHaveText(money(cents(line.unit_price)));
      await expect(printed.locator('td[data-label="Importe"]')).toHaveText(money(cents(line.amount)));
    }
    for (const line of document.scrap_lines) {
      const printed = receiptLine(receipt.dialog, line.name);
      await expect(printed.locator('td[data-label="Cantidad o kilogramos"]'))
        .toHaveText(formatKg(milliFromWire(line.kg)));
      await expect(printed.locator('td[data-label="Precio"]'))
        .toHaveText(`${money(cents(line.price_per_kg))} por kg`);
      await expect(printed.locator('td[data-label="Importe"]')).toHaveText(money(cents(line.amount)));
    }
    // El papel imprime las líneas en el orden del documento: primero las usadas por modelo, después la
    // chatarra por material.
    expect(await receipt.dialog.locator('tbody tr td[data-label="Modelo o material"] strong').allTextContents())
      .toEqual([
        ...document.used_lines.map(line => line.model),
        ...document.scrap_lines.map(line => line.name),
      ]);
    await expect(receipt.dialog.getByText(`Total: ${money(arranged.totalCents)}`)).toBeVisible();
    await expect(receipt.dialog.getByRole('button', { name: 'Imprimir comprobante' })).toBeEnabled();

    // El comprobante se cierra y el operador vuelve a la lista con la fila donde la dejó.
    await receipt.dialog.getByRole('button', { name: 'Volver' }).click();
    await expect(receipt.dialog).toBeHidden();
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute('data-purchase-id', String(document.id));

    // Lo que el papel imprimió es lo persistido, leído por el mismo id que la pantalla abrió.
    const persisted = await purchaseDocument(branch, document.id);
    expect(persisted).toMatchObject({
      id: document.id, location_id: branch.locationId, note: document.note,
      total: amountOf(arranged.totalCents), paid_cash: amountOf(arranged.totalCents),
      paid_transfer: '0.00', reverses_purchase_id: null, reversed_by: null, reason: '',
    });
    expect(persisted.scrap_lines.map(line => [line.material_id, line.kg, line.price_per_kg]))
      .toEqual([[copper.id, '4.500', '6500.00']]);
    // Y sigue en la lista de documentos con sus tres líneas.
    const listing = await purchaseListing(branch, { pageSize: 10 });
    expect(listing.purchases.find(entry => entry.id === document.id)).toMatchObject({
      id: document.id, total: amountOf(arranged.totalCents), used_units: 3, scrap_lines: 1,
    });
  });
