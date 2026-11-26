import {
  amountOf, arrangePurchase, branchA, cents, documentRow, expect, loadPurchaseFund, milliFromWire, money,
  openPurchases, publishedMaterials, purchaseListing, showDocuments, showDocumentRow, test, uniqueModel,
  uniqueNote, warehouseRole,
} from './harness';

/**
 * S2 · la lista de documentos de la sucursal, recorrida en el navegador (T4).
 *
 * Cada compra es un documento con sus líneas y su pago, y la pestaña de documentos los publica del más
 * nuevo al más viejo con lo que cada uno recibió, lo que costó y el estado en el que está. El acto de
 * esta prueba es consultar: la compra que la lista publica la registra la API pública de la misma sesión
 * (S3), así que la fila se busca por su número y nunca por el orden en que llegó.
 */

test('la lista de documentos publica la compra con su contenido, su total y su estado',
  async ({ page, api }) => {
    const branch = await api.as(branchA);
    const warehouse = await api.as(warehouseRole);
    await loadPurchaseFund({ branch, warehouse }, cents('1000000.00'));
    const materials = await publishedMaterials(branch);
    const copper = materials.find(entry => entry.name === 'Cobre');
    if (copper === undefined) throw new Error('el contrato no publica el material Cobre');

    // Un documento con las dos clases de línea: dos usadas de un modelo y una línea de chatarra.
    const model = uniqueModel('LISTA');
    const arranged = await arrangePurchase(branch, {
      note: uniqueNote('lista'),
      used: [{ model, quantity: 2, priceCents: cents('15000.00') }],
      scrap: [{ materialId: copper.id, kgMilli: milliFromWire('3.000'), pricePerKg: cents('6000.00') }],
    });
    const document = arranged.document;

    await openPurchases(page);
    const panel = await showDocuments(page);
    // La pantalla dice qué es un documento y cómo se corrige antes de listarlo.
    await expect(panel.getByText('Cada compra es un documento con sus líneas y su pago.')).toBeVisible();
    await expect(panel.getByText('Se corrige con una anulación que deja ambos documentos.')).toBeVisible();
    // El pager ofrece los tres tamaños de página que el contrato publica.
    await expect(panel.getByLabel('Compras por página').locator('option')).toHaveText(['10', '25', '50']);

    const row = await showDocumentRow(page, document.id);
    await expect(row).toHaveCount(1);
    const cells = row.getByRole('cell');
    // El documento: su número, su fecha con el instante del contrato, su contenido, su total y su estado.
    await expect(cells.nth(0)).toHaveText(`#${document.id}`);
    await expect(cells.nth(1).locator('time')).toHaveAttribute('datetime', document.created_at);
    await expect(cells.nth(2)).toHaveText('2 usadas · 1 chatarra');
    await expect(cells.nth(3)).toHaveText(money(arranged.totalCents));
    await expect(cells.nth(4)).toHaveText('Vigente');
    // Y las dos acciones del documento vivo: verlo y anularlo.
    await expect(row.getByRole('button', { name: `Ver el detalle de la compra #${document.id}` })).toBeEnabled();
    await expect(row.getByRole('button', { name: `Anular la compra #${document.id}` })).toBeEnabled();

    // Lo listado es lo guardado: la página del contrato repite el documento y su contenido derivado.
    const listing = await purchaseListing(branch, { pageSize: 50 });
    const listed = listing.purchases.find(entry => entry.id === document.id);
    expect(listed).toMatchObject({
      created_at: document.created_at, total: amountOf(arranged.totalCents),
      reverses_purchase_id: null, reversed_by: null, used_units: 2, scrap_lines: 1,
    });
    expect(listing.total_purchases).toBeGreaterThanOrEqual(1);
    expect(listing.page).toBe(1);
    expect(listing.page_size).toBe(50);

    // El documento sigue en la lista cuando el operador vuelve a pedir la primera página.
    await expect(panel.getByRole('button', { name: 'Anterior página' })).toBeDisabled();
    await expect(documentRow(panel, document.id)).toHaveCount(1);
  });
