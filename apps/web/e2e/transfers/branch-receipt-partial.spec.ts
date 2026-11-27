import {
  arrangeInTransit, arrangeRunStock, balance, branchB, branchBSession, decideReconciliation, expect, filterTransfers,
  openTransfer, openTransferList, proposeReconciliation, test, transferRecord, warehouseRole,
} from './harness';

/**
 * S2 · el acto de recibir cuando llegó menos de lo que salió: la recepción parcial.
 *
 * La recepción admite una cantidad por variante y no exige que coincida con lo enviado
 * (`apps/api/docs/transfers-api.md:350`, «Destination-only finalized receipt»): lo que el destino cuenta
 * se acredita con el mínimo entre lo recibido y lo enviado (`transfers-api.md:385`), y el faltante queda
 * registrado como excepción inmutable. El envío no tiene equivalente —el despacho consume el documento
 * entero y la pantalla lo declara «sin selección parcial» (`apps/web/src/TransferDispatch.tsx:164`)—, así
 * que este es el único acto parcial que existe.
 *
 * La prueba cuenta 3 de las 4 unidades despachadas y afirma lo que el operador ve antes y después de
 * confirmar, y lo que queda en cada punta: el origen ya perdió las cuatro al despachar, el destino acredita
 * tres y la cuarta no está en ninguna góndola: es el faltante que el conteo efectivo publica y que la
 * conciliación unificada viene a resolver. Al final se resuelve por el contrato para no dejar la unidad
 * fuera de toda ubicación.
 */

test.use({ storageState: branchBSession });

test('la sucursal recibe menos unidades de las enviadas y el faltante queda registrado sin acreditarse',
  async ({ page, api }) => {
    const branch = await api.as(branchB);
    const warehouse = await api.as(warehouseRole);
    const stock = await arrangeRunStock(warehouse);
    const dispatched = 4;
    const arrived = 3;
    const missing = dispatched - arrived;
    const transit = await arrangeInTransit(stock, { branch, warehouse }, dispatched);
    const origin = await balance(warehouse, warehouse.locationId, stock.variantId);
    const destination = await balance(branch, branch.locationId, stock.variantId);

    await openTransferList(page);
    await filterTransfers(page, 'En tránsito');
    await openTransfer(page, transit);
    await page.getByRole('button', { name: 'Recibir solicitud' }).click();

    // El conteo se carga a mano contra lo enviado: el campo llega vacío y la fila publica las cuatro.
    const capture = page.getByRole('dialog', { name: 'Registrar cantidades recibidas' });
    await expect(capture).toBeVisible();
    const captureRow = capture.getByRole('row').filter({ hasText: stock.name });
    await expect(captureRow.locator('td[data-label="Enviadas"]')).toHaveText(String(dispatched));
    const received = capture.getByLabel(/^Cantidad recibida /);
    await expect(received).toHaveValue('');
    await received.fill(String(arrived));
    await capture.getByRole('button', { name: 'Revisar recepción' }).click();

    // La revisión previa compara línea por línea y declara el faltante antes de confirmar.
    const review = page.getByRole('dialog', { name: 'Revisar recepción' });
    await expect(review).toBeVisible();
    await expect(review.getByText(`Se acreditarán ${arrived} baterías en Sucursal B al confirmar.`)).toBeVisible();
    const previewRow = review.getByRole('row').filter({ hasText: stock.name });
    await expect(previewRow.locator('td[data-label="Enviadas"]')).toHaveText(String(dispatched));
    await expect(previewRow.locator('td[data-label="Recibidas"]')).toHaveText(String(arrived));
    await expect(previewRow.locator('td[data-label="A acreditar"]')).toHaveText(String(arrived));
    await expect(previewRow.locator('td[data-label="Diferencia"]')).toContainText(`Faltante: ${missing}`);
    await expect(review.getByText(`Faltante: ${missing} · ${stock.name} · ${stock.detail}.`)).toBeVisible();
    await expect(review.getByText('El faltante quedará registrado; no se resuelve automáticamente.')).toBeVisible();
    await expect(review.getByText('El conteo coincide con lo enviado.')).toHaveCount(0);
    await review.getByRole('button', { name: 'Confirmar recepción' }).click();

    // La recepción confirmada publica el conteo original con su discrepancia.
    const confirmed = page.getByRole('dialog', { name: 'Recepción confirmada' });
    await expect(confirmed).toBeVisible();
    await expect(confirmed.getByText('Recepción registrada correctamente.')).toBeVisible();
    const confirmedRow = confirmed.getByRole('row').filter({ hasText: stock.name });
    await expect(confirmedRow.locator('td[data-label="Cantidad enviada"]')).toHaveText(String(dispatched));
    await expect(confirmedRow.locator('td[data-label="Cantidad recibida"]')).toHaveText(String(arrived));
    await expect(confirmedRow.locator('td[data-label="Stock disponible acreditado"]')).toHaveText(String(arrived));
    await expect(confirmedRow.locator('td[data-label="Discrepancia"]')).toContainText(`Faltante: ${missing}`);
    await confirmed.getByRole('button', { name: 'Volver al detalle' }).click();

    // El detalle publica lo que el conteo efectivo contabilizó y lo que todavía reclama.
    const document = page.getByRole('region', { name: 'Detalle de transferencia' });
    await expect(document.getByText('Recibida', { exact: true })).toBeVisible();
    await expect(document.getByText(`Conteo efectivo confirmado · 1 variantes · ${arrived} baterías contabilizadas`)).toBeVisible();
    const effective = document.getByRole('region', { name: 'Conteo efectivo confirmado' });
    const effectiveRow = effective.getByRole('row').filter({ hasText: stock.name });
    await expect(effectiveRow.locator('td[data-label="Enviadas"]')).toHaveText(String(dispatched));
    await expect(effectiveRow.locator('td[data-label="Recibidas efectivas"]')).toHaveText(String(arrived));
    await expect(effectiveRow.locator('td[data-label="Crédito efectivo"]')).toHaveText(String(arrived));
    await expect(effectiveRow.locator('td[data-label="Diferencia"]')).toContainText(`Faltante: ${missing}`);
    await expect(effective.getByText('Las diferencias se registran por variante, sin compensarse ni resolverse automáticamente.')).toBeVisible();
    await expect(effective.getByRole('button', { name: 'Resolver diferencia' })).toBeVisible();

    // El documento persistido: la evidencia cuenta tres de cuatro y la excepción queda registrada.
    const record = await transferRecord(branch, transit.id);
    expect(record.status).toBe('received');
    expect(record.receipt_location_id).toBe(branch.locationId);
    expect(record.receipt?.items.map(line =>
      [line.variant_id, line.expected_quantity, line.actual_quantity, line.available_quantity]))
      .toEqual([[stock.variantId, String(dispatched), String(arrived), String(arrived)]]);
    expect(record.receipt?.exceptions)
      .toEqual([{ variant_id: stock.variantId, kind: 'shortage', quantity: String(missing) }]);

    // Las dos puntas: el origen ya había perdido lo despachado y la recepción no lo toca; el destino
    // acredita sólo lo que contó, así que la unidad faltante no está en ninguna góndola.
    expect(await balance(warehouse, warehouse.locationId, stock.variantId)).toEqual(origin);
    expect(await balance(branch, branch.locationId, stock.variantId)).toEqual({
      existing: destination.existing + arrived, reserved: destination.reserved,
      available: destination.available + arrived,
    });

    // La unidad que el conteo no vio la contabiliza la conciliación: el destino declara que llegó todo y
    // el origen acepta, y el crédito del destino cierra la diferencia que la recepción dejó abierta.
    await proposeReconciliation(branch, transit.id, {
      variantId: stock.variantId, revision: '0', dispatch: dispatched, arrival: dispatched, retained: 0,
      reason: `Conteo verificado en destino ${stock.name}`,
    });
    await decideReconciliation(warehouse, transit.id, 'accept', {
      variantId: stock.variantId, revision: '1', reason: `Aceptación del arreglo ${stock.name}`,
    });
    expect(await balance(branch, branch.locationId, stock.variantId)).toEqual({
      existing: destination.existing + dispatched, reserved: destination.reserved,
      available: destination.available + dispatched,
    });
    expect(await balance(warehouse, warehouse.locationId, stock.variantId)).toEqual(origin);
  });
