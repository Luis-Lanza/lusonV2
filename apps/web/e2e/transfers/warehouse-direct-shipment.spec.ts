import {
  addBatteryToCart, arrangeRunBattery, balance, cancelTransfer, chooseBatteryKind, creationCart, expect, openReview,
  openTransferList, test, transferByReference, warehouseRole, warehouseSessionState,
} from './harness';

/**
 * S2 · el acto de enviar desde el Almacén: el envío directo, creado por el Almacén que lo posee.
 *
 * El Almacén elige el destino, arma el envío con su propio stock, lee la revisión y lo crea. El documento
 * no pasa por Pending ni espera aprobación del destino: la creación autoriza y reserva el envío completo
 * en Almacén, queda pendiente de despacho y el destino no recibe stock todavía. La variante es la batería
 * de la corrida, así que el saldo reservado que la prueba afirma no lo mueve ningún otro grupo.
 *
 * La reserva se retira al final con la cancelación del creador, así la unidad que esta corrida nombró
 * vuelve a quedar disponible en Almacén.
 */

test.use({ storageState: warehouseSessionState });

test('el Almacén crea un envío directo de una batería a una sucursal y lo deja pendiente de despacho',
  async ({ page, api }) => {
    const warehouse = await api.as(warehouseRole);
    const battery = await arrangeRunBattery(warehouse);
    const units = 2;
    const shelf = { kind: 'battery' as const, search: battery.model };
    const before = await balance(warehouse, warehouse.locationId, battery.line.variantId, shelf);

    await openTransferList(page);
    await page.getByRole('button', { name: 'Crear envío' }).click();
    await chooseBatteryKind(page);

    // La ruta del envío directo: origen fijo en el Almacén y la sucursal B como destino.
    await expect(page.getByLabel('Tipo de transferencia')).toHaveValue('directA');
    await page.getByLabel('Tipo de transferencia').selectOption({ label: 'Enviar a Sucursal B' });
    await expect(page.getByLabel('Tipo de transferencia')).toHaveValue('directB');
    await expect(page.getByText('Origen · Fijo')).toBeVisible();
    await expect(page.getByText('La creación autoriza y reserva el envío completo. No requiere aprobación del destino; el despacho se confirma por separado.')).toBeVisible();

    await addBatteryToCart(page, battery, battery.line, units);
    await expect(creationCart(page).getByRole('heading', { level: 2, name: 'Baterías en el envío' })).toBeVisible();
    await expect(creationCart(page).getByLabel('Total a transferir')).toHaveText(`${units} baterías`);

    const review = await openReview(page, true);
    await expect(review.getByText('La creación autoriza y reserva todas las cantidades en Almacén, sin mover existencias ni acreditar el destino.')).toBeVisible();
    await expect(review.getByText('Queda Pendiente de despacho. El despacho es una acción separada; podés cancelar antes de despachar. El destino no debe aprobar.')).toBeVisible();
    await expect(review.getByRole('row').filter({ hasText: battery.name }).locator('td[data-label="Cantidad a transferir"]'))
      .toHaveText(String(units));
    await review.getByRole('button', { name: 'Crear envío y reservar' }).click();

    // La confirmación nombra el documento y su estado de creación autorizada.
    const confirmed = page.getByRole('dialog', { name: 'Solicitud Pendiente de despacho confirmada' });
    await expect(confirmed).toBeVisible();
    await expect(confirmed.getByText('Estado: Pendiente de despacho')).toBeVisible();
    await expect(confirmed.getByText('Autorizada y reservada al crear:')).toBeVisible();
    const reference = /TR-[0-9]+/.exec(await confirmed.innerText())?.[0];
    if (reference === undefined) throw new Error('la confirmación del envío directo no publica su referencia');

    // El documento persistido: autorizado y reservado al crear, sin decisión posterior.
    const record = await transferByReference(warehouse, 'approved', reference);
    await expect(confirmed.getByText(`ID: ${record.id}`)).toBeVisible();
    expect(record.kind).toBe('direct_shipment');
    expect(record.status).toBe('approved');
    expect(record.creator_location_id).toBe(warehouse.locationId);
    expect(record.origin_location_id).toBe(warehouse.locationId);
    expect(record.destination_location_id).toBe(3);
    expect(record.approver_location_id).toBe(warehouse.locationId);
    expect(record.decision_location_id).toBe(warehouse.locationId);
    expect(record.decided_at).toBe(record.created_at);
    expect(record.dispatched_at).toBeUndefined();
    expect(record.items.map(line => [line.variant_id, line.kind, line.quantity]))
      .toEqual([[battery.line.variantId, 'battery', String(units)]]);
    expect(await balance(warehouse, warehouse.locationId, battery.line.variantId, shelf)).toEqual({
      existing: before.existing, reserved: before.reserved + units, available: before.available - units,
    });

    // El detalle del documento recién creado, por el botón que la confirmación ofrece.
    await confirmed.getByRole('button', { name: 'Ver detalle' }).click();
    const detail = page.getByRole('region', { name: 'Detalle de transferencia' });
    await expect(detail.getByRole('heading', { level: 1, name: record.reference })).toBeVisible();
    await expect(detail.getByText('Pendiente de despacho', { exact: true })).toBeVisible();
    await expect(detail.getByText(`Las ${units} baterías están reservadas en Almacén. Pendiente de despacho.`)).toBeVisible();
    await expect(detail.getByRole('button', { name: 'Despachar envío' })).toBeVisible();

    // La reserva se retira con la cancelación del creador: el origen vuelve a estar como estaba.
    await cancelTransfer(warehouse, record.id);
    expect(await balance(warehouse, warehouse.locationId, battery.line.variantId, shelf)).toEqual(before);
  });
