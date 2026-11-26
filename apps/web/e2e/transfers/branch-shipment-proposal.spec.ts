import {
  addToCart, arrangeDirectShipment, arrangeRunStock, balance, branchB, branchBSession, cancelTransfer,
  chooseProductsKind, creationCart, expect, filterTransfers, openReview, openTransferList, test,
  transferByReference, warehouseRole,
} from './harness';

/**
 * S2 · el acto de enviar desde la sucursal: la propuesta de envío al Almacén.
 *
 * Es la tercera ruta de la misma pantalla de creación, y la única en la que la sucursal es el origen físico:
 * propone mandar su propio stock al Almacén, que decide. La creación no reserva ni mueve nada; el documento
 * queda Pending en la mesa del Almacén y la propuesta se retira después con la cancelación del creador.
 *
 * El stock que la propuesta nombra es de la corrida: un envío directo del Almacén, despachado y recibido
 * con el mismo contrato, deja esas unidades en Sucursal B antes del acto.
 */

test.use({ storageState: branchBSession });

test('la sucursal propone un envío al Almacén y la propuesta queda pendiente de aprobación',
  async ({ page, api }) => {
    const branch = await api.as(branchB);
    const warehouse = await api.as(warehouseRole);
    const stock = await arrangeRunStock(warehouse);
    await arrangeDirectShipment(stock, { branch, warehouse }, 5);
    const before = await balance(branch, branch.locationId, stock.variantId);
    const units = 3;

    await openTransferList(page);
    await page.getByRole('button', { name: 'Nueva transferencia' }).click();
    await chooseProductsKind(page);
    await page.getByLabel('Tipo de transferencia').selectOption({ label: 'Proponer envío a Almacén' });

    // La ruta invertida: el origen es la sucursal y el Almacén recibe y decide, sin reserva inmediata.
    await expect(page.getByRole('heading', { level: 1, name: 'Proponer envío a Almacén' })).toBeVisible();
    await expect(page.getByText('Requiere aprobación de Almacén · No genera reserva inmediata de stock')).toBeVisible();
    await addToCart(page, stock, units);
    await expect(creationCart(page).getByLabel('Total a transferir')).toHaveText(`${units} productos`);

    const review = await openReview(page, false);
    await expect(review.getByText('La solicitud quedará Pending, pendiente de aprobación de Almacén.')).toBeVisible();
    await review.getByRole('button', { name: 'Enviar solicitud' }).click();

    const confirmed = page.getByRole('dialog', { name: 'Solicitud Pending confirmada' });
    await expect(confirmed).toBeVisible();
    await expect(confirmed.getByText('Estado: Pending · Pendiente de aprobación')).toBeVisible();
    const reference = /TR-[0-9]+/.exec(await confirmed.innerText())?.[0];
    if (reference === undefined) throw new Error('la confirmación de la propuesta no publica su referencia');

    // El documento persistido invierte la ruta de la solicitud: la sucursal es origen y creadora.
    const record = await transferByReference(branch, 'pending', reference);
    await expect(confirmed.getByText(`ID: ${record.id}`)).toBeVisible();
    expect(record.kind).toBe('send_to_warehouse');
    expect(record.status).toBe('pending');
    expect(record.creator_location_id).toBe(branch.locationId);
    expect(record.origin_location_id).toBe(branch.locationId);
    expect(record.destination_location_id).toBe(warehouse.locationId);
    expect(record.approver_location_id).toBe(warehouse.locationId);
    expect(record.items.map(line => [line.variant_id, line.quantity])).toEqual([[stock.variantId, String(units)]]);
    expect(await balance(branch, branch.locationId, stock.variantId)).toEqual(before);

    // La bandeja la publica como propuesta de envío y le dice a la sucursal a quién espera.
    await confirmed.getByRole('button', { name: 'Volver a transferencias' }).click();
    await filterTransfers(page, 'Pendientes');
    const row = page.getByRole('row').filter({ hasText: reference });
    await expect(row).toContainText('Propuesta de envío a Almacén');
    await expect(row).toContainText('Pendiente de aprobación');
    await expect(row).toContainText('Esperando a Almacén');

    // La propuesta se retira con la cancelación del creador, que por estar pendiente no mueve stock.
    await cancelTransfer(branch, record.id);
    expect(await balance(branch, branch.locationId, stock.variantId)).toEqual(before);
  });
