import {
  arrangedClosure, branchA, centsOf, closingDocument, ensureCommission, decideCorrection, expect,
  freeBranch, knownBranchId, moneyText, openWarehouseSettlement, statusTag, test, typedMoney,
  uniqueText, warehouseRole, warehouseSessionState, wire,
} from './harness';

/**
 * S2 · la corrección de una rendición ya decidida.
 *
 * Un cierre no se reabre: se corrige. El Almacén dice qué número estaba mal y por qué, y la sucursal
 * decide. La prueba arma un cierre cerrado por el contrato, propone la corrección desde la pantalla
 * —motivo y caja contada corregida—, lee la corrección pendiente con su «Quedaría» y contrasta el
 * payload que el documento persiste. Después la sucursal la acepta por el contrato y el documento
 * publica el número corregido: la prueba deja el cierre sin correcciones esperando.
 */

freeBranch();

test.use({ storageState: warehouseSessionState });

test('el Almacén corrige un cierre decidido y la corrección espera a la sucursal',
  async ({ page, api }) => {
    const warehouse = await api.as(warehouseRole);
    const branch = await api.as(branchA);
    await ensureCommission(warehouse, knownBranchId);
    const observation = uniqueText('Cierre corregible');
    const closed = await arrangedClosure(warehouse, branch, knownBranchId, observation);
    expect(closed.status).toBe('closed');

    const counted = centsOf(closed.counted_cash ?? '0.00');
    const corrected = counted + 1000;
    const reason = uniqueText('El cajón tenía un billete que no se contó');

    await openWarehouseSettlement(page);
    await expect(statusTag(page, 'Cerrada')).toBeVisible();
    const corrections = page.locator('section[aria-labelledby="closing-corrections-title"]');
    await expect(corrections).toBeVisible();
    await expect(corrections).toContainText('El cierre no tiene correcciones');

    // El acto: el motivo y el número que el cierre debió publicar.
    await page.getByLabel('Motivo de la corrección', { exact: true }).fill(reason);
    await page.getByLabel('Caja contada corregida (Bs)', { exact: true }).fill(typedMoney(corrected));
    await page.getByRole('button', { name: 'Proponer corrección' }).click();
    await expect(page.locator('p.closing-status')).toHaveText(
      'Corrección propuesta a la sucursal: espera su aceptación o su rechazo con motivo.');

    // La pantalla publica la corrección que espera, con lo que cambiaría si la sucursal la acepta.
    await expect(corrections).toContainText('Todavía no aplicada');
    await expect(corrections).toContainText(reason);
    const preview = corrections.locator('table.closing-correction-preview');
    await expect(preview.locator('tbody tr[data-kind="counted_cash"] td').nth(1)).toHaveText(moneyText(counted));
    await expect(preview.locator('tbody tr[data-kind="counted_cash"] td').nth(2)).toHaveText(moneyText(corrected));

    // El documento persiste la corrección con su motivo y el valor que toca, sin aplicarlo todavía.
    const withCorrection = await closingDocument(warehouse, closed.id);
    expect(withCorrection.status).toBe('closed');
    expect(withCorrection.corrections.length).toBe(1);
    expect(withCorrection.corrections[0].status).toBe('proposed');
    expect(withCorrection.corrections[0].reason).toBe(reason);
    expect(withCorrection.corrections[0].payload.counted_cash).toBe(wire(corrected));
    expect(withCorrection.corrections[0].payload.closing_cash).toBeUndefined();
    expect(withCorrection.corrections[0].effects).toEqual([]);
    // Nada se aplicó: el cierre sigue publicando el número firmado.
    expect(withCorrection.counted_cash).toBe(closed.counted_cash);

    // La sucursal la acepta: el cierre sigue cerrado y publica el número corregido con su delta.
    const decided = await decideCorrection(branch, withCorrection.corrections[0].id,
      { decision: 'accepted' });
    expect(decided.status).toBe('accepted');
    const correctedDoc = await closingDocument(warehouse, closed.id);
    expect(correctedDoc.status).toBe('closed');
    expect(correctedDoc.counted_cash).toBe(wire(corrected));
    expect(correctedDoc.corrections.length).toBe(1);
    expect(correctedDoc.corrections[0].effects.map(effect => effect.kind)).toEqual(['counted_cash']);
    expect(centsOf(correctedDoc.corrections[0].effects[0].amount_delta ?? '0.00')).toBe(1000);
  });
