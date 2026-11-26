import {
  arrangeApproved, arrangePending, arrangeRunStock, backToTransfers, balance, branchB, branchBSession, expect,
  filterTransfers, openTransfer, openTransferList, test, transferRecord, warehouseRole,
} from './harness';

/**
 * S2 · el acto de cancelar, hecho por la ubicación creadora mientras el documento no salió.
 *
 * Sucursal B cancela dos veces el mismo acto, porque el efecto no es el mismo: una solicitud todavía
 * pendiente se cierra sin tocar el inventario, y una ya aprobada libera únicamente la reserva propia de
 * esa solicitud en el origen. Después del despacho no hay cancelación, y por eso la prueba se queda de
 * este lado del tránsito.
 */

test.use({ storageState: branchBSession });

test('la sucursal cancela antes del despacho y el documento cerrado conserva lo que ya tenía',
  async ({ page, api }) => {
    const branch = await api.as(branchB);
    const warehouse = await api.as(warehouseRole);
    const stock = await arrangeRunStock(warehouse);
    const start = await balance(warehouse, warehouse.locationId, stock.variantId);

    // Los dos documentos de esta corrida: uno pendiente y otro que el Almacén ya aprobó.
    const units = 2;
    const pending = await arrangePending(stock, { branch, warehouse }, units);
    const approvedUnits = 3;
    const approved = await arrangeApproved(stock, { branch, warehouse }, approvedUnits);
    const reserved = await balance(warehouse, warehouse.locationId, stock.variantId);
    expect(reserved).toEqual({
      existing: start.existing, reserved: start.reserved + approvedUnits, available: start.available - approvedUnits,
    });

    // Primer acto: la solicitud pendiente. Cancelarla no reserva ni mueve nada.
    await openTransferList(page);
    await filterTransfers(page, 'Pendientes');
    const pendingDetail = await openTransfer(page, pending);
    await pendingDetail.getByRole('button', { name: 'Cancelar solicitud' }).click();
    const pendingDialog = page.getByRole('dialog', { name: 'Confirmar cancelación' });
    await expect(pendingDialog).toBeVisible();
    await expect(pendingDialog.getByText('Se cancelará la solicitud completa antes del despacho. El registro original se conserva y no podrá editarse ni volver a activarse.')).toBeVisible();
    await expect(pendingDialog.getByText(/Si sigue pendiente, no cambia el inventario\./)).toBeVisible();
    await pendingDialog.getByRole('button', { name: 'Confirmar cancelación' }).click();

    // La cancelación se confirma sin paso posterior: el detalle pasa al estado cerrado.
    const cancelledPending = page.getByRole('region', { name: 'Detalle de transferencia' });
    await expect(cancelledPending.getByText('Estado confirmado: Cancelada.')).toBeVisible();
    await expect(cancelledPending.getByText('Cancelada', { exact: true })).toBeVisible();
    await expect(cancelledPending.getByText('La solicitud completa fue cancelada. No reserva ni mueve stock.')).toBeVisible();
    const closedPending = await transferRecord(branch, pending.id);
    expect(closedPending.status).toBe('cancelled');
    expect(closedPending.cancellation_location_id).toBe(branch.locationId);
    expect(closedPending.cancelled_at).toBeDefined();
    // Una solicitud pendiente no inventa una decisión: sólo se conserva lo que ya tenía.
    expect(closedPending.decision_location_id).toBeUndefined();
    expect(closedPending.dispatched_at).toBeUndefined();
    expect(await balance(warehouse, warehouse.locationId, stock.variantId)).toEqual(reserved);

    // Segundo acto: la solicitud aprobada. Cancelarla libera sólo su reserva, no las existencias.
    await backToTransfers(page);
    await filterTransfers(page, 'Aprobadas');
    const approvedDetail = await openTransfer(page, approved);
    await approvedDetail.getByRole('button', { name: 'Cancelar solicitud' }).click();
    const approvedDialog = page.getByRole('dialog', { name: 'Confirmar cancelación' });
    await expect(approvedDialog).toBeVisible();
    await expect(approvedDialog.getByText('Si ya fue aprobada, se liberará únicamente su reserva en Almacén. Las existencias físicas, otras reservas y el stock del destino no cambian.')).toBeVisible();
    await approvedDialog.getByRole('button', { name: 'Confirmar cancelación' }).click();

    const cancelledApproved = page.getByRole('region', { name: 'Detalle de transferencia' });
    await expect(cancelledApproved.getByText('Cancelada', { exact: true })).toBeVisible();
    await expect(cancelledApproved.getByText('La solicitud completa fue cancelada. Se liberó únicamente su reserva en Almacén; las existencias físicas, otras reservas y el stock del destino no cambian.')).toBeVisible();
    const closedApproved = await transferRecord(branch, approved.id);
    expect(closedApproved.status).toBe('cancelled');
    expect(closedApproved.cancellation_location_id).toBe(branch.locationId);
    // La aprobación anterior se conserva tal cual: la cancelación no la reescribe.
    expect(closedApproved.decision_location_id).toBe(warehouse.locationId);
    expect(closedApproved.decided_at).toBe(approved.decided_at);
    expect(closedApproved.dispatched_at).toBeUndefined();

    // El saldo del origen: la reserva liberada, las existencias físicas intactas.
    expect(await balance(warehouse, warehouse.locationId, stock.variantId)).toEqual(start);
  });
