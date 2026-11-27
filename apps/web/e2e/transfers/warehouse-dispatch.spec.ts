import {
  arrangeApproved, arrangeRunBattery, balance, branchB, expect, filterTransfers, openTransfer,
  openTransferList, receiveTransfer, test, transferRecord, warehouseRole, warehouseSessionState,
} from './harness';

/**
 * S2 · el acto de despachar, hecho por el Almacén como origen físico.
 *
 * La solicitud aprobada espera en el origen. El Almacén la abre desde su bandeja —la fila le dice que le
 * toca despachar—, confirma el despacho completo y ve el resultado: las unidades salen de Almacén, la
 * reserva propia de esta solicitud se consume y Sucursal B todavía no recibe stock. El despacho no admite
 * selección parcial: la pantalla despacha todas las unidades del documento
 * (`apps/web/src/TransferDispatch.tsx:164`), y por eso no hay un acto «despachar menos» que probar.
 *
 * El despacho no tiene vuelta: la recepción del destino es la única salida. La prueba la registra al final
 * con el mismo contrato público para que las unidades que salieron queden contabilizadas donde llegaron.
 */

test.use({ storageState: warehouseSessionState });

test('el Almacén despacha la solicitud completa de una batería y la deja en tránsito', async ({ page, api }) => {
  const branch = await api.as(branchB);
  const warehouse = await api.as(warehouseRole);
  const battery = await arrangeRunBattery(warehouse);
  const units = 3;
  const approved = await arrangeApproved(battery.line, { branch, warehouse }, units);
  const shelf = { kind: 'battery' as const, search: battery.model };
  const before = await balance(warehouse, warehouse.locationId, battery.line.variantId, shelf);

  // La bandeja le dice al origen que la solicitud espera su despacho.
  await openTransferList(page);
  await filterTransfers(page, 'Aprobadas');
  const row = page.getByRole('row').filter({ hasText: approved.reference });
  await expect(row).toContainText('Aprobada');
  await expect(row).toContainText('Despachar');

  const detail = await openTransfer(page, approved);
  await expect(detail.getByText('Aprobada', { exact: true })).toBeVisible();
  await detail.getByRole('button', { name: 'Despachar solicitud' }).click();

  const confirmation = page.getByRole('dialog', { name: 'Confirmar despacho' });
  await expect(confirmation).toBeVisible();
  await expect(confirmation.getByText(`Saldrán las ${units} baterías de Almacén y se consumirá la reserva propia de esta solicitud.`)).toBeVisible();
  await expect(confirmation.getByText('La disponibilidad libre y las reservas de otras transferencias no cambian.')).toBeVisible();
  await expect(confirmation.getByText('Quedará En tránsito. Sucursal B recibirá stock solo al confirmar la recepción.')).toBeVisible();
  await confirmation.getByRole('button', { name: 'Confirmar despacho' }).click();

  const confirmed = page.getByRole('dialog', { name: 'Despacho confirmado' });
  await expect(confirmed).toBeVisible();
  await expect(confirmed.getByText('Despacho registrado correctamente. La solicitud está En tránsito; la recepción en destino sigue pendiente y todavía no se acreditó stock.')).toBeVisible();
  await expect(confirmed.getByText('Estado confirmado: En tránsito.')).toBeVisible();
  await confirmed.getByRole('button', { name: 'Volver al detalle' }).click();

  const transit = page.getByRole('region', { name: 'Detalle de transferencia' });
  await expect(transit.getByText('En tránsito', { exact: true })).toBeVisible();
  await expect(transit.getByRole('heading', { level: 2, name: 'Productos enviados' })).toBeVisible();
  await expect(transit.getByText('Pendiente de recepción en Sucursal B. El stock todavía no fue acreditado.')).toBeVisible();

  // El documento persistido y el saldo del origen: existencias descontadas y reserva consumida.
  const record = await transferRecord(warehouse, approved.id);
  expect(record.status).toBe('in_transit');
  expect(record.dispatch_location_id).toBe(warehouse.locationId);
  expect(record.dispatched_at).toBeDefined();
  expect(record.receipt_location_id).toBeUndefined();
  expect(new Date(record.dispatched_at ?? 0).getTime())
    .toBeGreaterThanOrEqual(new Date(record.decided_at ?? 0).getTime());
  expect(await balance(warehouse, warehouse.locationId, battery.line.variantId, shelf)).toEqual({
    existing: before.existing - units, reserved: before.reserved - units, available: before.available,
  });

  // La única salida del tránsito es la recepción: las unidades siguen su ruta y quedan acreditadas en
  // Sucursal B, no perdidas en el camino.
  const destination = await balance(branch, branch.locationId, battery.line.variantId, shelf);
  const received = await receiveTransfer(branch, approved.id, { variantId: battery.line.variantId, units });
  expect(received.status).toBe('received');
  expect(await balance(branch, branch.locationId, battery.line.variantId, shelf)).toEqual({
    existing: destination.existing + units, reserved: destination.reserved,
    available: destination.available + units,
  });
});
