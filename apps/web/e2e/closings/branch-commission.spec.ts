import {
  arrangeBatterySale, arrangedOpen, branchB, branchBSession, branchCashPanel, centsOf, closingDocument,
  ensureCommission, expect, expenseMotive, freeBranch, knownBranchId, moneyText,
  openBranchDecision, plainDraft, proposeClosing, recordContribution, recordExpense, saveCashDraft, stamp,
  summaryValue, test, uniqueText, warehouseRole,
} from './harness';

/**
 * S2 · la rendición de sucursal: la comisión del período, con sus gastos y sus movimientos de caja.
 *
 * La sucursal no calcula nada: lee lo que el Almacén ofreció y lo que el servidor publica. La prueba
 * arma un período con lo único que la pantalla no puede inventar —una venta en efectivo de una batería,
 * un aporte al cajón y un gasto con su motivo—, deja el cierre propuesto y abre `#/rendicion` como lo
 * abre el operador de la sucursal. Lo que afirma de la comisión, de los gastos y de la caja es lo que
 * el documento publica, y las tres identidades que la pantalla escribe se contrastan con él.
 */

freeBranch();

test.use({ storageState: branchBSession });

test('la sucursal lee su comisión del período con los gastos y los movimientos de caja',
  async ({ page, api }) => {
    const warehouse = await api.as(warehouseRole);
    const branch = await api.as(branchB);
    const configuredRate = await ensureCommission(warehouse, knownBranchId);
    // El período: una venta de batería (la única base de la comisión), un aporte al cajón y un gasto.
    const sale = await arrangeBatterySale({ branch, warehouse }, `C${stamp()}`);
    const motive = await expenseMotive(branch);
    const contribution = uniqueText('Cambio para el cajón');
    const note = uniqueText('Flete del período');
    await recordContribution(branch, '100.00', contribution);
    const expense = await recordExpense(branch, motive.id, '45.50', note);

    const opened = await arrangedOpen(warehouse, branch, knownBranchId);
    await saveCashDraft(warehouse, opened.id, plainDraft(opened));
    const proposed = await proposeClosing(warehouse, opened.id);
    expect(proposed.status).toBe('proposed');

    const document = await closingDocument(warehouse, proposed.id);
    const rate = document.commission_rate_percent ?? '';
    const commission = centsOf(document.commission_amount);
    const base = centsOf(document.commission_base ?? '0.00');
    const salesTotal = centsOf(document.sales_total);
    const cashSales = centsOf(document.cash_sales);
    const cashExpenses = centsOf(document.cash_expenses);
    const opening = centsOf(document.opening_cash);
    const effective = centsOf(document.cash_effective);
    const expected = centsOf(document.expected_cash);
    const counted = centsOf(document.counted_cash ?? '0.00');
    const fund = centsOf(document.closing_cash ?? '0.00');

    // La venta de la batería está en el período y es la base de la comisión (S3).
    expect(rate).toBe(configuredRate);
    expect(base).toBeGreaterThanOrEqual(96000);
    expect(commission).toBe(Math.floor((base * centsOf(rate) + 5000) / 10000));
    expect(commission).toBeGreaterThan(0);
    expect(salesTotal).toBeGreaterThanOrEqual(96000);
    // La caja esperada es la identidad del servidor: fondo heredado + ventas en efectivo + movimientos.
    expect(opening + cashSales + effective).toBe(expected);

    await openBranchDecision(page);
    // La sección es la de la sucursal y su hash propio la restaura.
    await expect(page.getByRole('button', { name: 'Rendición de cuentas' }))
      .toHaveAttribute('aria-current', 'page');
    expect(new URL(page.url()).hash).toBe('#/rendicion');
    await expect(page.getByText('Sucursal congelada')).toBeVisible();
    await expect(page.getByText('Propuesta 1 de 1')).toBeVisible();

    const panel = branchCashPanel(page);
    // La comisión: la tasa congelada y el monto que el documento publica, fuera de la caja.
    await expect(summaryValue(panel, /^Ventas sobre precio de venta$/)).toHaveText(moneyText(salesTotal));
    await expect(summaryValue(panel, /^Comisión del período/)).toHaveText(moneyText(commission));
    await expect(panel.locator('dt').filter({ hasText: /^Comisión del período/ }))
      .toContainText(`${rate.replace('.', ',')} %`);
    // La caja: las tres identidades que el servidor deriva, y los gastos que el período pagó.
    await expect(summaryValue(panel, /^Fondo heredado$/)).toHaveText(moneyText(opening));
    await expect(summaryValue(panel, /^Ventas en efectivo$/)).toHaveText(moneyText(cashSales));
    await expect(summaryValue(panel, /^Gastos cargados$/))
      .toHaveText(cashExpenses === 0 ? moneyText(0) : `− ${moneyText(cashExpenses)}`);
    await expect(summaryValue(panel, /^Caja esperada$/)).toHaveText(moneyText(expected));
    await expect(summaryValue(panel, /^Caja contada$/)).toHaveText(moneyText(counted));
    await expect(summaryValue(panel, /^Fondo que queda en la caja$/)).toHaveText(moneyText(fund));

    // Los gastos del período: cada fila con el motivo con el que se registró y su nota.
    const expenses = panel.getByRole('group', { name: 'Gastos del período' });
    await expect(expenses.locator('li')).toHaveCount(document.expenses.length);
    const row = expenses.locator(`li[data-expense-id="${expense.id}"]`);
    await expect(row).toContainText(motive.label);
    await expect(row).toContainText(note);
    await expect(row).toContainText(`− ${moneyText(centsOf(expense.amount))}`);
    // El aporte es plata del cajón, no un gasto del período: mueve el efectivo y no es una fila acá.
    await expect(expenses).not.toContainText(contribution);

    // La colecta electrónica se informa aparte de la caja y no se suma a ninguna identidad.
    await expect(summaryValue(panel, /^Tarjeta$/)).toHaveText(moneyText(centsOf(document.card_total)));
    await expect(summaryValue(panel, /^Transferencia$/)).toHaveText(moneyText(centsOf(document.transfer_total)));
    await expect(summaryValue(panel, /^QR$/)).toHaveText(moneyText(centsOf(document.qr_total)));

    // La venta que la prueba hizo es la que el documento publica: el período y la base no son invento.
    expect(sale.saleId).toBeGreaterThan(0);
    expect(document.branch_location_id).toBe(knownBranchId);
    expect(document.expenses.map(entry => entry.id)).toContain(expense.id);
  });
