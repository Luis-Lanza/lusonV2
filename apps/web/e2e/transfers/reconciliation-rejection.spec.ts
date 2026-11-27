import {
  arrangeReceived, arrangeRunStock, balance, branchB, expect, filterTransfers, openReconciliation, openTransfer,
  openTransferList, proposeReconciliation, reconciliationEffect, test, unifiedSnapshot, warehouseRole,
  warehouseSessionState,
} from './harness';

/**
 * S2 · el acto de conciliar cuando el conteo recibido no coincide: rechazar, del lado del origen.
 *
 * El destino propuso un conteo efectivo y el Almacén no lo acepta. El operador abre la propuesta desde su
 * bandeja, escribe por qué la rechaza, revisa que el rechazo no mueve nada y lo confirma. El conteo
 * efectivo sigue siendo el de la recepción original —con su faltante— y ninguna de las dos puntas cambia
 * su stock: el desacuerdo queda registrado, que es exactamente lo que el acto produce.
 */

test.use({ storageState: warehouseSessionState });

test('el Almacén rechaza la propuesta del destino y el conteo efectivo conserva su diferencia',
  async ({ page, api }) => {
    const branch = await api.as(branchB);
    const warehouse = await api.as(warehouseRole);
    const stock = await arrangeRunStock(warehouse);
    const units = 2;
    const received = await arrangeReceived(stock, { branch, warehouse }, units, 1);
    const proposalReason = `Conteo verificado en destino ${stock.name}`;
    await proposeReconciliation(branch, received.id, {
      variantId: stock.variantId, revision: '0', dispatch: units, arrival: units, retained: 0, reason: proposalReason,
    });
    const origin = await balance(warehouse, warehouse.locationId, stock.variantId);
    const destination = await balance(branch, branch.locationId, stock.variantId);

    await openTransferList(page);
    await filterTransfers(page, 'Recibidas');
    const row = page.getByRole('row').filter({ hasText: received.reference });
    await expect(row).toContainText('Revisar conciliación unificada');
    await openTransfer(page, received);

    const modal = await openReconciliation(page);
    await expect(modal.getByRole('heading', { name: 'Propuesta de la contraparte' })).toBeVisible();
    await expect(modal.getByText(proposalReason)).toBeVisible();
    const reason = `Rechazado por Almacén ${stock.name}`;
    await modal.getByLabel('Motivo y evidencia').fill(reason);
    await modal.getByRole('button', { name: 'Revisar rechazo' }).click();

    // El rechazo se revisa como cualquier otra decisión, y su efecto es ninguno.
    await expect(modal.getByRole('heading', { name: 'Revisar efectos' })).toBeVisible();
    await expect(modal.getByText(`rechazo · Variante ${stock.variantId}`)).toBeVisible();
    await expect(reconciliationEffect(modal, 'Cambio de existencias en origen')).toHaveText('0');
    await expect(reconciliationEffect(modal, 'Cambio de crédito destino')).toHaveText('0');
    await expect(modal.getByText('Proponer o rechazar no mueve stock.')).toBeVisible();
    await expect(modal.getByText(reason)).toBeVisible();
    await modal.getByRole('button', { name: 'Confirmar rechazo' }).click();

    // El detalle conserva el faltante del conteo efectivo: nada se sustituyó por la propuesta rechazada.
    const detail = page.getByRole('region', { name: 'Detalle de transferencia' });
    const effectiveRow = detail.getByRole('row').filter({ hasText: stock.name });
    await expect(effectiveRow.locator('td[data-label="Recibidas efectivas"]')).toHaveText('1');
    await expect(effectiveRow.locator('td[data-label="Crédito efectivo"]')).toHaveText('1');
    await expect(effectiveRow.getByText('Faltante: 1')).toBeVisible();

    // El documento persistido: la propuesta rechazada, con la decisión de la contraparte y su motivo.
    await expect.poll(async () => (await unifiedSnapshot(warehouse, received.id)).lines[0]?.proposals.at(-1)?.state)
      .toBe('rejected');
    const snapshot = await unifiedSnapshot(warehouse, received.id);
    const proposal = snapshot.lines[0]?.proposals.at(-1);
    expect(proposal?.state).toBe('rejected');
    expect(proposal?.decision?.accepted).toBe(false);
    expect(proposal?.decision?.actor_location_id).toBe(warehouse.locationId);
    expect(proposal?.decision?.reason).toBe(reason);
    expect(snapshot.current[0]?.effective_credit).toBe('1');
    expect(snapshot.current[0]?.source).toBe('legacy');

    // Ninguna de las dos puntas movió stock: el rechazo deja el desacuerdo registrado, no una corrección.
    expect(await balance(warehouse, warehouse.locationId, stock.variantId)).toEqual(origin);
    expect(await balance(branch, branch.locationId, stock.variantId)).toEqual(destination);
  });
