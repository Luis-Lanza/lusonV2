import {
  arrangePending, arrangeRunStock, balance, branchB, expect, filterTransfers, openTransfer, openTransferList,
  test, transferRecord, warehouseRole, warehouseSessionState,
} from './harness';

/**
 * S2 · el acto de rechazar, hecho por el Almacén que lo posee.
 *
 * El Almacén abre la solicitud pendiente de la sucursal B, confirma el rechazo de la solicitud completa y
 * lee el resultado. Rechazar no reserva, no libera y no mueve nada: el saldo del origen queda igual, el
 * documento se conserva y la solicitud ya no podrá aprobarse ni editarse. No hace falta devolver stock:
 * el acto no lo toca.
 */

test.use({ storageState: warehouseSessionState });

test('el Almacén rechaza la solicitud completa sin mover stock', async ({ page, api }) => {
  const branch = await api.as(branchB);
  const warehouse = await api.as(warehouseRole);
  const stock = await arrangeRunStock(warehouse);
  const units = 2;
  const pending = await arrangePending(stock, { branch, warehouse }, units);
  const before = await balance(warehouse, warehouse.locationId, stock.variantId);

  await openTransferList(page);
  await filterTransfers(page, 'Pendientes');
  await expect(page.getByRole('row').filter({ hasText: pending.reference })).toContainText('Pendiente de aprobación');

  const detail = await openTransfer(page, pending);
  await detail.getByRole('button', { name: 'Rechazar solicitud' }).click();
  const confirmation = page.getByRole('dialog', { name: 'Confirmar rechazo' });
  await expect(confirmation).toBeVisible();
  await expect(confirmation.getByText('Se rechazará la solicitud completa y se conservará el registro.')).toBeVisible();
  await expect(confirmation.getByText('No se moverán existencias ni se modificarán reservas.')).toBeVisible();
  await expect(confirmation.getByText('Después de confirmar, esta solicitud no podrá aprobarse ni editarse.')).toBeVisible();
  await confirmation.getByRole('button', { name: 'Confirmar rechazo' }).click();

  const confirmed = page.getByRole('dialog', { name: 'Solicitud Rechazada confirmada' });
  await expect(confirmed).toBeVisible();
  await expect(confirmed.getByText('Solicitud rechazada correctamente. No se movieron existencias ni se modificaron reservas.')).toBeVisible();
  await expect(confirmed.getByText('Estado confirmado: Rechazada.')).toBeVisible();
  await confirmed.getByRole('button', { name: 'Volver al detalle' }).click();

  // El detalle del documento cerrado publica el rechazo y su efecto nulo sobre el inventario.
  const rejected = page.getByRole('region', { name: 'Detalle de transferencia' });
  await expect(rejected.getByText('Rechazada', { exact: true })).toBeVisible();
  await expect(rejected.getByText('La solicitud completa fue rechazada. No reserva ni mueve stock.')).toBeVisible();

  const record = await transferRecord(warehouse, pending.id);
  expect(record.status).toBe('rejected');
  expect(record.decision_location_id).toBe(warehouse.locationId);
  expect(record.decided_at).toBeDefined();
  expect(record.dispatch_location_id).toBeUndefined();
  expect(record.cancellation_location_id).toBeUndefined();
  expect(await balance(warehouse, warehouse.locationId, stock.variantId)).toEqual(before);
});
