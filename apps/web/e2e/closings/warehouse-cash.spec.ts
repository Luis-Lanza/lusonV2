import {
  actionBar, arrangedOpen, branchB, cashCountedField, cashFundField, cashObservationField, centsOf,
  closingDocument, ensureCommission, decideClosing, drawerPanel, expect, freeBranch, knownBranchId,
  moneyText, openWarehouseSettlement, proposeClosing, signedMoneyText, summaryValue, test, typedMoney,
  uniqueText, warehouseRole, warehouseSessionState, wire,
} from './harness';

/**
 * S2 · la caja del cierre: lo que el Almacén contó, el fondo que queda y la observación.
 *
 * La caja esperada es una identidad del servidor —el fondo heredado, las ventas en efectivo y el efecto
 * de los movimientos del período— y el Almacén sólo declara lo que contó. La prueba escribe la caja
 * contada con un sobrante, deja un fondo y firma una observación, lee en el rail la diferencia y lo que
 * se lleva al Almacén, guarda el borrador y contrasta los cuatro números con los que el documento
 * persiste y con los que el cierre publica después de aceptarlo la sucursal.
 */

freeBranch();

test.use({ storageState: warehouseSessionState });

test('el Almacén declara la caja contada, el fondo que queda y la observación del cierre',
  async ({ page, api }) => {
    const warehouse = await api.as(warehouseRole);
    const branch = await api.as(branchB);
    await ensureCommission(warehouse, knownBranchId);
    const opened = await arrangedOpen(warehouse, branch, knownBranchId);

    // La caja esperada es la del servidor: la prueba no la calcula, la lee.
    const expected = centsOf(opened.expected_cash);
    const counted = Math.max(expected, 0) + 1250;
    const fund = Math.max(expected, 0);
    const observation = uniqueText('Contado en persona');

    await openWarehouseSettlement(page);
    await expect(summaryValue(drawerPanel(page), /^Caja esperada$/)).toHaveText(moneyText(expected));
    await expect(summaryValue(drawerPanel(page), /^Caja contada$/)).toHaveText('Sin contar');

    // El acto: el Almacén cuenta el cajón, deja el fondo y escribe por qué.
    await cashCountedField(page).fill(typedMoney(counted));
    await cashFundField(page).fill(typedMoney(fund));
    await cashObservationField(page).fill(observation);

    // El rail responde a lo que se escribe, antes de guardar: la diferencia y lo que se lleva.
    await expect(drawerPanel(page).getByText('Sobrante', { exact: true })).toBeVisible();
    await expect(drawerPanel(page).getByText(signedMoneyText(1250), { exact: true }).first()).toBeVisible();
    await expect(summaryValue(drawerPanel(page), /^Te llevás al Almacén$/)).toHaveText(moneyText(1250));
    await expect(summaryValue(drawerPanel(page), /^Fondo que queda en la caja$/))
      .toHaveText(`− ${moneyText(fund)}`);

    await actionBar(page).getByRole('button', { name: 'Guardar borrador' }).click();
    await expect(page.locator('p.closing-status')).toHaveText(
      'Borrador guardado: el conteo y la caja quedan registrados y sobreviven a una recarga.');

    // La pantalla queda mostrando el borrador que el servidor ya guardó.
    await expect(cashCountedField(page)).toHaveValue(typedMoney(counted));
    await expect(cashFundField(page)).toHaveValue(typedMoney(fund));
    await expect(cashObservationField(page)).toHaveValue(observation);

    const saved = await closingDocument(warehouse, opened.id);
    expect(saved.counted_cash).toBe(wire(counted));
    expect(saved.closing_cash).toBe(wire(fund));
    expect(saved.contributed_cash).toBe('0.00');
    expect(saved.observation).toBe(observation);
    expect(centsOf(saved.cash_difference ?? '0.00')).toBe(1250);
    expect(centsOf(saved.taken_cash ?? '0.00')).toBe(1250);
    // La colecta electrónica se informa aparte y no entra en ninguna identidad de caja.
    await expect(summaryValue(drawerPanel(page), /^Tarjeta$/)).toHaveText(moneyText(centsOf(saved.card_total)));
    await expect(summaryValue(drawerPanel(page), /^Transferencia$/))
      .toHaveText(moneyText(centsOf(saved.transfer_total)));
    await expect(summaryValue(drawerPanel(page), /^QR$/)).toHaveText(moneyText(centsOf(saved.qr_total)));

    // La sucursal acepta: el cierre publica la caja que el Almacén declaró, sin reescribirla.
    const proposed = await proposeClosing(warehouse, opened.id);
    const closed = await decideClosing(branch, proposed.id, { decision: 'accepted' });
    expect(closed.status).toBe('closed');
    expect(closed.counted_cash).toBe(wire(counted));
    expect(closed.closing_cash).toBe(wire(fund));
    expect(closed.observation).toBe(observation);
  });
