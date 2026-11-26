import {
  arrangeBatterySale, branchA, caseBySerial, expect, openBranchTray, openCase, test,
  warehouseRole,
} from './harness';

/**
 * S35 (1) · S1, S2 · "viene a reclamar con su garantía".
 *
 * The counter types the serial the client brought and what failed, and nothing else: the sale, its
 * client, its warranty number and its date are the server's reading of that serial. The spec proves it
 * twice — the dialog offers no field for the client or the date, and the case the screen publishes
 * carries the sale's own values — and the sale itself is arranged by the API, because selling is not
 * what this flow exercises (S35).
 */
test('el reclamo por serial abre el caso con los datos de la venta, sin tipear cliente ni fecha',
  async ({ page, api }) => {
    const branch = await api.as(branchA);
    const warehouse = await api.as(warehouseRole);
    const sale = await arrangeBatterySale({ branch, warehouse }, 'reclamo');

    await openBranchTray(page);

    await page.getByRole('button', { name: 'Registrar canje' }).click();
    const dialog = page.getByRole('dialog', { name: 'Registrar canje' });
    await expect(dialog).toBeVisible();
    // Lo único que el mostrador tipea es la serie y lo que falló: el cliente y la fecha son de la venta.
    await expect(dialog.getByRole('textbox')).toHaveCount(2);
    await expect(dialog.getByLabel('Número de serie de la batería reclamada')).toBeVisible();
    await expect(dialog.getByLabel('Qué falló')).toBeVisible();
    await expect(dialog.getByLabel(/cliente|fecha|documento|tel[eé]fono|direcci[oó]n|garant[ií]a/i)).toHaveCount(0);

    await dialog.getByLabel('Número de serie de la batería reclamada').fill(sale.serial);
    await dialog.getByLabel('Qué falló').fill('No arranca el motor');
    await dialog.getByRole('button', { name: 'Buscar la venta y abrir el caso' }).click();

    // El servidor leyó la venta de esa serie y el caso existe: la confirmación nombra el número guardado.
    const opened = dialog.getByText(/abierto por la serie/);
    await expect(opened).toContainText(sale.serial);
    const claim = await caseBySerial(branch, sale.serial);
    await expect(opened).toContainText(claim.case_number);

    // Y los datos de la venta que muestra son los de la venta, no algo que alguien tipeó acá.
    await expect(dialog.getByRole('term')).toHaveText(['Cliente', 'Venta', 'Batería', 'Plazo de la unidad']);
    const facts = dialog.getByRole('definition');
    await expect(facts.nth(0)).toHaveText(sale.customerName);
    await expect(facts.nth(1)).toContainText(sale.warrantyNumber);
    await expect(facts.nth(1).locator('time')).toHaveAttribute('datetime', sale.createdAt);
    await expect(facts.nth(2)).toHaveText(sale.battery);
    await expect(facts.nth(3)).toHaveText('12 meses');

    // Cerrado el canje, el caso queda en la bandeja con esos mismos datos persistidos.
    await dialog.getByRole('button', { name: 'Dejarlo para después' }).click();
    const detail = await openCase(page, claim.case_number);
    await expect(detail.getByRole('heading', { level: 2 })).toHaveText(sale.customerName);
    const serialFact = detail.getByRole('definition').filter({ hasText: sale.serial });
    await expect(serialFact).toBeVisible();
    const warrantyFact = detail.getByRole('definition').filter({ hasText: '12 meses' });
    await expect(warrantyFact).toBeVisible();
    const saleFact = detail.getByRole('definition').filter({ hasText: sale.warrantyNumber });
    await expect(saleFact.locator('time')).toHaveAttribute('datetime', sale.createdAt);

    // El caso nació por la garantía de esa venta, atado a ella.
    const persisted = await caseBySerial(branch, sale.serial);
    expect(persisted.origin).toBe('warranty_claim');
    expect(persisted.phase).toBe('received');
  });
