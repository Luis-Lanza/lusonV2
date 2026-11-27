import {
  arrangeReceived, arrangeRunStock, balance, branchB, expect, filterTransfers, openReconciliation, openTransfer,
  openTransferList, proposeReconciliation, reconciliationEffect, test, unifiedSnapshot, warehouseRole,
  warehouseSessionState,
} from './harness';

/**
 * S2 · el acto de conciliar cuando el conteo recibido no coincide: aceptar, del lado del origen.
 *
 * La recepción de la corrida quedó con un faltante y el destino ya propuso el conteo efectivo. El Almacén,
 * que es la contraparte, ve la propuesta en la bandeja («Revisar conciliación unificada»), la abre, lee
 * lo que declaró el otro lado, escribe su propio motivo, revisa los efectos y acepta. La aceptación aplica
 * todos los efectos juntos: el crédito del destino sube a lo declarado y la diferencia desaparece del
 * conteo efectivo.
 */

test.use({ storageState: warehouseSessionState });

test('el Almacén acepta la propuesta del destino y el conteo efectivo deja de tener diferencia',
  async ({ page, api }) => {
    const branch = await api.as(branchB);
    const warehouse = await api.as(warehouseRole);
    const stock = await arrangeRunStock(warehouse);
    const units = 2;
    const received = await arrangeReceived(stock, { branch, warehouse }, units, 1);
    const reason = `Conteo verificado en destino ${stock.name}`;
    await proposeReconciliation(branch, received.id, {
      variantId: stock.variantId, revision: '0', dispatch: units, arrival: units, retained: 0, reason,
    });
    const origin = await balance(warehouse, warehouse.locationId, stock.variantId);
    const destination = await balance(branch, branch.locationId, stock.variantId);

    // La bandeja del origen publica la revisión pendiente, y el detalle sigue mostrando el faltante.
    await openTransferList(page);
    await filterTransfers(page, 'Recibidas');
    const row = page.getByRole('row').filter({ hasText: received.reference });
    await expect(row).toContainText('Recibida');
    await expect(row).toContainText('Revisar conciliación unificada');

    const detail = await openTransfer(page, received);
    await expect(detail.getByText('Faltante: 1').first()).toBeVisible();

    // La propuesta de la contraparte se lee completa antes de decidir.
    const modal = await openReconciliation(page);
    await expect(modal.getByRole('heading', { name: 'Propuesta de la contraparte' })).toBeVisible();
    await expect(modal.getByText(`Salieron: ${units} · Llegaron: ${units} · Retenidas: 0`)).toBeVisible();
    await expect(modal.getByText(reason)).toBeVisible();
    // El motivo es de quien decide: la pantalla no lo hereda de la propuesta.
    await modal.getByLabel('Motivo y evidencia').fill(`Aceptado por Almacén ${stock.name}`);
    await modal.getByRole('button', { name: 'Revisar aceptación' }).click();

    // La revisión declara el efecto real de la aceptación sobre el origen y sobre el crédito del destino.
    await expect(modal.getByRole('heading', { name: 'Revisar efectos' })).toBeVisible();
    await expect(modal.getByText(`aceptación · Variante ${stock.variantId}`)).toBeVisible();
    await expect(reconciliationEffect(modal, 'Cambio de existencias en origen')).toHaveText('0');
    await expect(reconciliationEffect(modal, 'Cambio de crédito destino')).toHaveText('1');
    await expect(modal.getByText('La aceptación aplica todos los efectos juntos o ninguno, sujetos a validaciones vigentes.')).toBeVisible();
    await modal.getByRole('button', { name: 'Confirmar aceptación' }).click();

    // El conteo efectivo del detalle ya no tiene diferencia: lo declarado es lo acreditado.
    const settledDetail = page.getByRole('region', { name: 'Detalle de transferencia' });
    await expect(settledDetail.getByRole('heading', { level: 2, name: 'Conteo efectivo confirmado' })).toBeVisible();
    const effectiveRow = settledDetail.getByRole('row').filter({ hasText: stock.name });
    await expect(effectiveRow.locator('td[data-label="Recibidas efectivas"]')).toHaveText(String(units));
    await expect(effectiveRow.locator('td[data-label="Crédito efectivo"]')).toHaveText(String(units));
    await expect(effectiveRow.getByText('✓ Sin diferencias de conteo')).toBeVisible();
    // La recepción original se conserva tal cual se guardó: la conciliación corrige el conteo efectivo,
    // nunca la evidencia firmada una sola vez.
    await expect(settledDetail.getByText(/^Faltante/)).toHaveCount(1);

    // El documento persistido: la propuesta aplicada, con su aceptación y la operación que la aplicó.
    await expect.poll(async () => (await unifiedSnapshot(warehouse, received.id)).lines[0]?.proposals.at(-1)?.state)
      .toBe('applied');
    const snapshot = await unifiedSnapshot(warehouse, received.id);
    const proposal = snapshot.lines[0]?.proposals.at(-1);
    expect(proposal?.state).toBe('applied');
    expect(proposal?.decision?.accepted).toBe(true);
    expect(proposal?.decision?.actor_location_id).toBe(warehouse.locationId);
    expect(snapshot.current[0]?.owner).toBe('unified');
    expect(snapshot.current[0]?.application_operation_key).not.toBeNull();
    expect(snapshot.current[0]?.effective_dispatch).toBe(String(units));
    expect(snapshot.current[0]?.effective_actual).toBe(String(units));
    expect(snapshot.current[0]?.effective_credit).toBe(String(units));

    // El saldo de las dos puntas: el origen no se movió y el destino acreditó la unidad declarada.
    expect(await balance(warehouse, warehouse.locationId, stock.variantId)).toEqual(origin);
    expect(await balance(branch, branch.locationId, stock.variantId)).toEqual({
      existing: destination.existing + 1, reserved: destination.reserved, available: destination.available + 1,
    });
  });
