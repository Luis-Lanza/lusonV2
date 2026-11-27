import {
  arrangeInTransit, arrangeRunBattery, balance, branchB, branchBSession, expect, filterTransfers, openTransfer,
  openTransferList, test, transferRecord, warehouseRole,
} from './harness';

/**
 * S2 · el acto de recibir, hecho por la sucursal como destino físico.
 *
 * La solicitud despachada espera en Sucursal B. La operadora la abre desde su bandeja —la fila le dice
 * «Recibir»—, cuenta lo que llegó, revisa el conteo y lo confirma una sola vez. El resultado: el stock
 * disponible del destino se acredita con el mínimo entre lo recibido y lo enviado, y las existencias del
 * origen no cambian. Acá el conteo coincide con lo enviado, así que las unidades que salieron de Almacén
 * quedan acreditadas completas en Sucursal B: es la última estación de la ruta de una batería que la
 * corrida creó, pidió por pantalla y el Almacén aprobó y despachó.
 */

test.use({ storageState: branchBSession });

test('la sucursal recibe la batería completa y acredita el stock en su ubicación', async ({ page, api }) => {
  const branch = await api.as(branchB);
  const warehouse = await api.as(warehouseRole);
  const battery = await arrangeRunBattery(warehouse);
  const units = 3;
  const transit = await arrangeInTransit(battery.line, { branch, warehouse }, units);
  const shelf = { kind: 'battery' as const, search: battery.model };
  const origin = await balance(warehouse, warehouse.locationId, battery.line.variantId, shelf);
  const before = await balance(branch, branch.locationId, battery.line.variantId, shelf);

  // La bandeja del destino publica que la solicitud espera su recepción.
  await openTransferList(page);
  await filterTransfers(page, 'En tránsito');
  const row = page.getByRole('row').filter({ hasText: transit.reference });
  await expect(row).toContainText('En tránsito');
  await expect(row).toContainText('Recibir');

  const detail = await openTransfer(page, transit);
  await expect(detail.getByText('En tránsito', { exact: true })).toBeVisible();
  await detail.getByRole('button', { name: 'Recibir solicitud' }).click();

  // El conteo se carga a mano, contra lo enviado que la pantalla publica al lado del campo.
  const capture = page.getByRole('dialog', { name: 'Registrar cantidades recibidas' });
  await expect(capture).toBeVisible();
  await expect(capture.getByText('Contá lo que llegó e ingresá cada cantidad. Usá 0 si una variante no llegó.')).toBeVisible();
  await expect(capture.getByText('Todavía no se modifica el stock. Primero revisarás el conteo.')).toBeVisible();
  const captureRow = capture.getByRole('row').filter({ hasText: battery.name });
  await expect(captureRow).toContainText(battery.line.detail);
  await expect(captureRow.locator('td[data-label="Polaridad"]')).toHaveText('Izquierda [L]');
  await expect(captureRow.locator('td[data-label="Enviadas"]')).toHaveText(String(units));
  const received = capture.getByLabel(/^Cantidad recibida /);
  await expect(received).toHaveCount(1);
  await received.fill(String(units));
  await capture.getByRole('button', { name: 'Revisar recepción' }).click();

  // La revisión previa declara cuánto se acredita y que el conteo se guarda una sola vez.
  const review = page.getByRole('dialog', { name: 'Revisar recepción' });
  await expect(review).toBeVisible();
  await expect(review.getByText(`Se acreditarán ${units} baterías en Sucursal B al confirmar.`)).toBeVisible();
  await expect(review.getByText('El conteo coincide con lo enviado.')).toBeVisible();
  await expect(review.getByText('Al confirmar: Conteo original guardado una sola vez; no se podrá editar.')).toBeVisible();
  await review.getByRole('button', { name: 'Confirmar recepción' }).click();

  // La recepción confirmada publica la comparación línea por línea, sin discrepancias.
  const confirmed = page.getByRole('dialog', { name: 'Recepción confirmada' });
  await expect(confirmed).toBeVisible();
  await expect(confirmed.getByText('Recepción registrada correctamente.')).toBeVisible();
  const receiptRow = confirmed.getByRole('row').filter({ hasText: battery.name });
  await expect(receiptRow).toContainText(String(units));
  await expect(receiptRow).toContainText('Sin discrepancia');
  await confirmed.getByRole('button', { name: 'Volver al detalle' }).click();

  // El detalle del documento recibido publica el conteo efectivo de esta recepción.
  const document = page.getByRole('region', { name: 'Detalle de transferencia' });
  await expect(document.getByText('Recibida', { exact: true })).toBeVisible();
  await expect(document.getByText(/^Conteo efectivo confirmado · 1 variantes · /)).toBeVisible();
  await expect(document.getByText('✓ Sin diferencias de conteo').first()).toBeVisible();
  await expect(document.getByText('Ver recepción original')).toBeVisible();

  // El documento persistido y el saldo de las dos puntas: acreditado en destino, quieto en el origen.
  const record = await transferRecord(branch, transit.id);
  expect(record.status).toBe('received');
  expect(record.receipt_location_id).toBe(branch.locationId);
  expect(record.received_at).toBeDefined();
  expect(record.receipt?.items.map(line =>
    [line.variant_id, line.expected_quantity, line.actual_quantity, line.available_quantity]))
    .toEqual([[battery.line.variantId, String(units), String(units), String(units)]]);
  expect(record.receipt?.exceptions).toEqual([]);
  expect(await balance(branch, branch.locationId, battery.line.variantId, shelf)).toEqual({
    existing: before.existing + units, reserved: before.reserved, available: before.available + units,
  });
  expect(await balance(warehouse, warehouse.locationId, battery.line.variantId, shelf)).toEqual(origin);
});
