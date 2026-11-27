import {
  amountOf, arrangePurchase, branchA, cents, expect, loadPurchaseFund, money, openPurchases,
  purchaseDocument, reversalDialog, showDocumentRow, test, uniqueModel, uniqueNote, warehouseRole,
} from './harness';

/**
 * S2 · la anulación de una compra, recorrida en el navegador (T4).
 *
 * Un documento no se edita: se corrige con un contra-documento que espeja sus líneas y su total, exige un
 * motivo y deja los dos documentos a la vista para siempre. La prueba recorre el acto como el operador
 * —abre la anulación de la fila, confirma sin motivo y lee la negativa, escribe el motivo y confirma— y
 * contrasta las dos filas de la lista y los dos documentos con el contrato (`apps/api/docs/purchases.md`).
 *
 * La compra que se anula la registra la API pública de la misma sesión (S3): anular es el acto que se
 * ejerce, registrar no.
 */

test('la anulación exige el motivo, deja el contra-documento y el original ya no se puede anular',
  async ({ page, api }) => {
    const branch = await api.as(branchA);
    const warehouse = await api.as(warehouseRole);
    await loadPurchaseFund({ branch, warehouse }, cents('1000000.00'));

    const model = uniqueModel('ANULA');
    const total = cents('15000.00') * 2n;
    const arranged = await arrangePurchase(branch, {
      note: uniqueNote('anula'),
      used: [{ model, quantity: 2, priceCents: cents('15000.00') }],
    });
    const document = arranged.document;

    await openPurchases(page);
    const row = await showDocumentRow(page, document.id);
    await row.getByRole('button', { name: `Anular la compra #${document.id}` }).click();

    // La confirmación del acto ofrece el espejo exacto del documento y pide el motivo.
    const dialog = reversalDialog(page, document.id);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('term')).toHaveText(['Total de la compra', 'Contra-documento']);
    const mirror = dialog.getByRole('definition');
    await expect(mirror.nth(0)).toHaveText(money(total));
    await expect(mirror.nth(1)).toHaveText(money(-total));
    await expect(dialog.getByText('El original nunca cambia: queda anulado en el historial')).toBeVisible();
    await expect(dialog.getByLabel('Motivo de la anulación')).toHaveValue('');

    // Sin motivo no hay anulación: la confirmación lo exige antes de escribir nada.
    await dialog.getByRole('button', { name: 'Confirmar anulación' }).click();
    await expect(dialog.getByRole('alert'))
      .toHaveText('El motivo es obligatorio: escribí entre 1 y 500 caracteres.');
    await expect(dialog).toBeVisible();
    await expect((await purchaseDocument(branch, document.id)).reversed_by).toBeNull();

    // Con el motivo, el acto registra el contra-documento y lo nombra.
    const reason = uniqueNote('motivo');
    await dialog.getByLabel('Motivo de la anulación').fill(reason);
    await dialog.getByRole('button', { name: 'Confirmar anulación' }).click();
    await expect(dialog).toBeHidden();

    const status = page.getByRole('status').filter({ hasText: 'Anulación registrada' });
    await expect(status).toHaveCount(1);
    const counterID = /contra-documento #([1-9][0-9]*)/.exec((await status.textContent()) ?? '')?.[1];
    if (counterID === undefined) throw new Error('la confirmación de la anulación no nombra el contra-documento');
    await expect(status).toHaveText(
      `Anulación registrada: contra-documento #${counterID} de la compra #${document.id}.`);

    // El original queda anulado en su fila y ya no ofrece anularse otra vez.
    await expect(row.locator('td[data-label="Estado"]')).toHaveText(`Revertida por #${counterID}`);
    await expect(row.getByRole('button', { name: `Anular la compra #${document.id}` })).toHaveCount(0);
    await expect(row.getByRole('button', { name: `Ver el detalle de la compra #${document.id}` })).toBeEnabled();

    // Y el contra-documento aparece como documento aparte, con su total en negativo.
    const counterRow = await showDocumentRow(page, Number(counterID));
    await expect(counterRow.locator('td[data-label="Estado"]')).toHaveText('Contra-documento');
    await expect(counterRow.locator('td[data-label="Total"]')).toHaveText(money(-total));
    await expect(counterRow.locator('td[data-label="Contenido"]')).toHaveText('2 usadas');
    await expect(counterRow.getByRole('button', { name: `Anular la compra #${counterID}` })).toHaveCount(0);

    // Lo persistido: el original apunta a su contra y el contra espeja todo, con el motivo escrito.
    const original = await purchaseDocument(branch, document.id);
    expect(original.reversed_by).toBe(Number(counterID));
    expect(original.total).toBe(amountOf(total));
    const counter = await purchaseDocument(branch, Number(counterID));
    expect(counter.reverses_purchase_id).toBe(document.id);
    expect(counter.reason).toBe(reason);
    expect(counter.total).toBe(amountOf(-total));
    expect(counter.paid_cash).toBe(amountOf(-total));
    expect(counter.paid_transfer).toBe('0.00');
    expect(counter.used_lines).toEqual([{
      model, quantity: -2, unit_price: '15000.00', amount: amountOf(-total),
    }]);
    expect(counter.scrap_lines).toEqual([]);
  });
