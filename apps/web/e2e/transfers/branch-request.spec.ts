import {
  addToCart, arrangeRunStock, balance, branchB, branchBSession, cancelTransfer, chooseProductsKind, creationCart,
  expect, filterTransfers, openReview, openTransferList, test, transferByReference, warehouseRole,
} from './harness';

/**
 * S2 · el acto de solicitar, hecho por la sucursal que lo pide.
 *
 * La sucursal B entra por su bandeja de transferencias, elige el documento de productos, busca la
 * variante que el Almacén tiene, escribe la cantidad, la suma al carrito, lee la revisión y envía. El
 * documento queda Pending, esperando la aprobación del Almacén: crear no reserva ni mueve stock, y eso
 * es justamente lo que la prueba deja afirmado después.
 *
 * La variante es un producto de esta corrida con su ingreso en Almacén (`arrangeRunStock`), así que el
 * stock que la corrida nombra es el suyo y no el de una batería del sembrado que otro grupo esté
 * vendiendo mientras la suite corre.
 */

test.use({ storageState: branchBSession });

test('la sucursal solicita stock al Almacén y la solicitud queda pendiente de aprobación',
  async ({ page, api }) => {
    const branch = await api.as(branchB);
    const warehouse = await api.as(warehouseRole);
    const stock = await arrangeRunStock(warehouse);
    const before = await balance(warehouse, warehouse.locationId, stock.variantId);
    const units = 4;

    // El acto: la sucursal arma la solicitud con el stock de su origen físico.
    await openTransferList(page);
    await page.getByRole('button', { name: 'Nueva transferencia' }).click();
    await chooseProductsKind(page);

    // La ruta es la del documento: el Almacén suministra y la sucursal B recibe, sin reserva inmediata.
    await expect(page.getByLabel('Tipo de transferencia')).toHaveValue('requestWarehouse');
    await expect(page.getByText('Requiere aprobación de Almacén · No genera reserva inmediata de stock')).toBeVisible();
    await addToCart(page, stock, units);
    await expect(creationCart(page).getByText('Este borrador no reserva ni mueve existencias.')).toBeVisible();
    await expect(creationCart(page).getByLabel('Total a transferir')).toHaveText(`${units} productos`);

    const review = await openReview(page, false);
    // La revisión declara el efecto exacto del acto: el documento queda Pending y nada se reserva.
    await expect(review.getByText('La solicitud quedará Pending, pendiente de aprobación de Almacén.')).toBeVisible();
    await expect(review.getByText('Enviar la solicitud no reserva ni mueve stock. La aprobación deberá revalidar y reservar la solicitud completa.')).toBeVisible();
    await expect(review.getByRole('row').filter({ hasText: stock.name })).toContainText(String(units));

    // El envío manual, con la confirmación que el operador lee antes de tocar el botón.
    await review.getByRole('button', { name: 'Enviar solicitud' }).click();
    const confirmed = page.getByRole('dialog', { name: 'Solicitud Pending confirmada' });
    await expect(confirmed).toBeVisible();
    await expect(confirmed.getByText('El servidor creó la solicitud.')).toBeVisible();
    await expect(confirmed.getByText('Estado: Pending · Pendiente de aprobación')).toBeVisible();
    const reference = /TR-[0-9]+/.exec(await confirmed.innerText())?.[0];
    if (reference === undefined) throw new Error('la confirmación de la solicitud no publica su referencia');

    // El documento persistido es el de la pantalla, y todavía no tocó el stock del origen.
    const pending = await transferByReference(branch, 'pending', reference);
    await expect(confirmed.getByText(`ID: ${pending.id}`)).toBeVisible();
    expect(pending.kind).toBe('request_stock');
    expect(pending.status).toBe('pending');
    expect(pending.creator_location_id).toBe(branch.locationId);
    expect(pending.origin_location_id).toBe(warehouse.locationId);
    expect(pending.destination_location_id).toBe(branch.locationId);
    expect(pending.approver_location_id).toBe(warehouse.locationId);
    expect(pending.items.map(line => [line.variant_id, line.quantity])).toEqual([[stock.variantId, String(units)]]);
    expect(pending.decision_location_id).toBeUndefined();
    expect(await balance(warehouse, warehouse.locationId, stock.variantId)).toEqual(before);

    // La fila de la bandeja publica el estado y a quién le toca: el Almacén, no la sucursal.
    await confirmed.getByRole('button', { name: 'Volver a transferencias' }).click();
    await filterTransfers(page, 'Pendientes');
    const row = page.getByRole('row').filter({ hasText: reference });
    await expect(row).toContainText('Pendiente de aprobación');
    await expect(row).toContainText('Esperando a Almacén');

    // La solicitud se retira con la cancelación del creador, que por estar pendiente no mueve nada: la
    // unidad que esta corrida nombró queda conservada en Almacén.
    await cancelTransfer(branch, pending.id);
    expect(await balance(warehouse, warehouse.locationId, stock.variantId)).toEqual(before);
  });
