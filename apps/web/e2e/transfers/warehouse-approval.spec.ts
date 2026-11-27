import {
  arrangePending, arrangeRunBattery, balance, branchB, cancelTransfer, expect, filterTransfers,
  openTransfer, openTransferList, test, transferRecord, warehouseRole, warehouseSessionState,
} from './harness';

/**
 * S2 · el acto de aprobar, hecho por el Almacén que lo posee.
 *
 * La solicitud de la sucursal B espera en la mesa del Almacén. El operador la abre desde su bandeja —
 * la fila le dice «Pendiente de aprobación» y que le toca a él—, lee el impacto de la confirmación,
 * aprueba y ve el resultado: la solicitud completa queda reservada en Almacén, las existencias físicas no
 * cambian y el destino no recibe stock. La batería es de esta corrida, con sus dos polaridades y su
 * ingreso propios, así que el saldo que la prueba afirma es el suyo.
 *
 * La reserva que el acto deja abierta se retira al final con la cancelación del creador, que es el único
 * camino que no despacha: así la unidad que esta corrida nombró vuelve a quedar disponible en Almacén.
 */

test.use({ storageState: warehouseSessionState });

test('el Almacén aprueba la solicitud completa de una batería y reserva sus unidades en el origen',
  async ({ page, api }) => {
    const branch = await api.as(branchB);
    const warehouse = await api.as(warehouseRole);
    const battery = await arrangeRunBattery(warehouse);
    const units = 3;
    const pending = await arrangePending(battery.line, { branch, warehouse }, units);
    const shelf = { kind: 'battery' as const, search: battery.model };
    const before = await balance(warehouse, warehouse.locationId, battery.line.variantId, shelf);

    // La bandeja le dice al Almacén qué le toca en esa fila, antes de abrirla.
    await openTransferList(page);
    await filterTransfers(page, 'Pendientes');
    const row = page.getByRole('row').filter({ hasText: pending.reference });
    await expect(row).toContainText('Pendiente de aprobación');
    await expect(row).toContainText('Aprobar o rechazar');
    await expect(row).toContainText('Requiere aprobación de: Almacén');

    const detail = await openTransfer(page, pending);
    await expect(detail.getByText('Pendiente de aprobación', { exact: true })).toBeVisible();
    await expect(detail.getByText('Solicitud de stock · Almacén → Sucursal B')).toBeVisible();

    // La línea del documento publica la batería, su polaridad y la cantidad pedida.
    const line = detail.getByRole('row').filter({ hasText: battery.name });
    await expect(line).toContainText(battery.line.detail);
    await expect(line.locator('td[data-label="Solicitadas"]')).toHaveText(String(units));

    // El paso de confirmación declara el efecto exacto del acto sobre el stock.
    await detail.getByRole('button', { name: 'Aprobar solicitud' }).click();
    const confirmation = page.getByRole('dialog', { name: 'Confirmar aprobación' });
    await expect(confirmation).toBeVisible();
    await expect(confirmation.getByText(`Se validará la disponibilidad y se reservarán las ${units} baterías en Almacén.`)).toBeVisible();
    await expect(confirmation.getByText('Si falta stock de alguna variante, no se aprobará ni reservará ninguna batería.')).toBeVisible();
    await expect(confirmation.getByText('No se moverán existencias ni aumentará el stock de Sucursal B.')).toBeVisible();
    await confirmation.getByRole('button', { name: 'Confirmar aprobación' }).click();

    // El resultado confirmado es el de la decisión completa, no el de una línea.
    const confirmed = page.getByRole('dialog', { name: 'Solicitud Aprobada confirmada' });
    await expect(confirmed).toBeVisible();
    await expect(confirmed.getByText('Solicitud aprobada correctamente. Se autorizó y reservó la solicitud completa; no se movieron existencias ni se acreditó stock en destino.')).toBeVisible();
    await expect(confirmed.getByText('Estado confirmado: Aprobada.')).toBeVisible();
    await confirmed.getByRole('button', { name: 'Volver al detalle' }).click();

    // El detalle del documento aprobado publica la reserva completa de esta solicitud en su origen.
    const approved = page.getByRole('region', { name: 'Detalle de transferencia' });
    await expect(approved.getByText('Aprobada', { exact: true })).toBeVisible();
    await expect(approved.getByRole('columnheader', { name: 'Reservadas para esta solicitud' })).toBeVisible();
    await expect(approved.getByRole('row').filter({ hasText: battery.name })).toContainText(`${units} uds.`);
    await expect(approved.getByText(`Las ${units} baterías están reservadas en Almacén. Pendiente de despacho.`)).toBeVisible();

    // El documento persistido y el saldo del origen: reservado, sin mover existencias.
    const record = await transferRecord(warehouse, pending.id);
    expect(record.status).toBe('approved');
    expect(record.decision_location_id).toBe(warehouse.locationId);
    expect(record.decided_at).toBeDefined();
    expect(record.dispatch_location_id).toBeUndefined();
    expect(record.items.map(line => [line.variant_id, line.kind, line.quantity]))
      .toEqual([[battery.line.variantId, 'battery', String(units)]]);
    expect(await balance(warehouse, warehouse.locationId, battery.line.variantId, shelf)).toEqual({
      existing: before.existing, reserved: before.reserved + units, available: before.available - units,
    });

    // La reserva se retira con la cancelación del creador: el origen vuelve a estar como estaba.
    await cancelTransfer(branch, pending.id);
    expect(await balance(warehouse, warehouse.locationId, battery.line.variantId, shelf)).toEqual(before);
  });
