import {
  addBatteryToCart, arrangeRunBattery, balance, branchB, branchBSession, cancelTransfer, chooseBatteryKind,
  chooseProductsKind, creationCart, expect, filterTransfers, openReview, openTransferList, test,
  transferByReference, warehouseRole,
} from './harness';

/**
 * S2 · el acto de solicitar, hecho por la sucursal que lo pide.
 *
 * La sucursal B entra por su bandeja de transferencias, elige el documento de baterías, busca la batería
 * que el Almacén tiene, escribe la cantidad de cada polaridad, las suma al carrito, lee la revisión y
 * envía. El documento queda Pending, esperando la aprobación del Almacén: crear no reserva ni mueve stock,
 * y eso es justamente lo que la prueba deja afirmado después.
 *
 * La batería es de esta corrida —marca y modelo propios, dos polaridades, su proveedor y su ingreso en
 * Almacén (`arrangeRunBattery`)—, así que el stock que la corrida nombra es el suyo y no el de una batería
 * del sembrado que otro grupo esté vendiendo mientras la suite corre. El catálogo de origen de la pantalla
 * se lee entero aunque la base comparta más de quinientas baterías, y el paso del tipo se recorre en los
 * dos sentidos antes de elegir: un documento no mezcla los dos tipos.
 */

test.use({ storageState: branchBSession });

test('la sucursal solicita las dos polaridades de una batería y la solicitud queda pendiente de aprobación',
  async ({ page, api }) => {
    const branch = await api.as(branchB);
    const warehouse = await api.as(warehouseRole);
    const battery = await arrangeRunBattery(warehouse);
    const left = battery.variants.find(variant => variant.polarity === 'L');
    const right = battery.variants.find(variant => variant.polarity === 'R');
    if (left === undefined || right === undefined) {
      throw new Error(`la batería ${battery.name} no publicó sus dos polaridades`);
    }
    const shelf = { kind: 'battery' as const, search: battery.model };
    const originLeft = await balance(warehouse, warehouse.locationId, left.variantId, shelf);
    const originRight = await balance(warehouse, warehouse.locationId, right.variantId, shelf);
    const leftUnits = 2;
    const rightUnits = 1;

    // El acto: la sucursal arma la solicitud con el stock de su origen físico.
    await openTransferList(page);
    await page.getByRole('button', { name: 'Nueva transferencia' }).click();
    // El paso del tipo se recorre en los dos sentidos y el catálogo cambia con él.
    await chooseProductsKind(page);
    await expect(page.getByLabel('Buscar nombre o dato del producto')).toBeVisible();
    await chooseBatteryKind(page);
    await expect(page.getByLabel('Buscar marca o modelo')).toBeVisible();

    // La ruta es la del documento: el Almacén suministra y la sucursal B recibe, sin reserva inmediata.
    await expect(page.getByLabel('Tipo de transferencia')).toHaveValue('requestWarehouse');
    await expect(page.getByText('Requiere aprobación de Almacén · No genera reserva inmediata de stock')).toBeVisible();
    await addBatteryToCart(page, battery, left, leftUnits);
    await addBatteryToCart(page, battery, right, rightUnits);
    await expect(creationCart(page).getByText('Este borrador no reserva ni mueve existencias.')).toBeVisible();
    await expect(creationCart(page).getByLabel('Total a transferir')).toHaveText(`${leftUnits + rightUnits} baterías`);

    // La revisión declara el efecto exacto del acto y nombra cada polaridad con su cantidad.
    const review = await openReview(page, false);
    await expect(review.getByText('La solicitud quedará Pending, pendiente de aprobación de Almacén.')).toBeVisible();
    await expect(review.getByText('Enviar la solicitud no reserva ni mueve stock. La aprobación deberá revalidar y reservar la solicitud completa.')).toBeVisible();
    const leftRow = review.getByRole('row').filter({ hasText: left.detail });
    const rightRow = review.getByRole('row').filter({ hasText: right.detail });
    await expect(leftRow).toContainText(battery.name);
    await expect(leftRow.locator('td[data-label="Polaridad"]')).toHaveText('L');
    await expect(leftRow.locator('td[data-label="Cantidad a transferir"]')).toHaveText(String(leftUnits));
    await expect(rightRow.locator('td[data-label="Polaridad"]')).toHaveText('R');
    await expect(rightRow.locator('td[data-label="Cantidad a transferir"]')).toHaveText(String(rightUnits));
    await expect(review.getByLabel('Total a transferir')).toHaveText(`${leftUnits + rightUnits} baterías`);

    // El envío manual, con la confirmación que el operador lee antes de tocar el botón.
    await review.getByRole('button', { name: 'Enviar solicitud' }).click();
    const confirmed = page.getByRole('dialog', { name: 'Solicitud Pending confirmada' });
    await expect(confirmed).toBeVisible();
    await expect(confirmed.getByText('El servidor creó la solicitud.')).toBeVisible();
    await expect(confirmed.getByText('Estado: Pending · Pendiente de aprobación')).toBeVisible();
    const reference = /TR-[0-9]+/.exec(await confirmed.innerText())?.[0];
    if (reference === undefined) throw new Error('la confirmación de la solicitud no publica su referencia');

    // El documento persistido es el de la pantalla, con las dos polaridades de la batería de la corrida.
    const pending = await transferByReference(branch, 'pending', reference);
    await expect(confirmed.getByText(`ID: ${pending.id}`)).toBeVisible();
    expect(pending.kind).toBe('request_stock');
    expect(pending.status).toBe('pending');
    expect(pending.creator_location_id).toBe(branch.locationId);
    expect(pending.origin_location_id).toBe(warehouse.locationId);
    expect(pending.destination_location_id).toBe(branch.locationId);
    expect(pending.approver_location_id).toBe(warehouse.locationId);
    const pendingLine = (variantId: number) => pending.items.find(line => line.variant_id === variantId);
    expect(pending.items).toHaveLength(2);
    expect(pendingLine(left.variantId)?.kind).toBe('battery');
    expect(pendingLine(left.variantId)?.quantity).toBe(String(leftUnits));
    expect(pendingLine(right.variantId)?.kind).toBe('battery');
    expect(pendingLine(right.variantId)?.quantity).toBe(String(rightUnits));
    expect(pending.decision_location_id).toBeUndefined();
    expect(await balance(warehouse, warehouse.locationId, left.variantId, shelf)).toEqual(originLeft);
    expect(await balance(warehouse, warehouse.locationId, right.variantId, shelf)).toEqual(originRight);

    // La fila de la bandeja publica el estado y a quién le toca: el Almacén, no la sucursal.
    await confirmed.getByRole('button', { name: 'Volver a transferencias' }).click();
    await filterTransfers(page, 'Pendientes');
    const row = page.getByRole('row').filter({ hasText: reference });
    await expect(row).toContainText('Pendiente de aprobación');
    await expect(row).toContainText('Esperando a Almacén');

    // La solicitud se retira con la cancelación del creador, que por estar pendiente no mueve nada: las
    // unidades que esta corrida nombró quedan conservadas en Almacén.
    await cancelTransfer(branch, pending.id);
    expect(await balance(warehouse, warehouse.locationId, left.variantId, shelf)).toEqual(originLeft);
    expect(await balance(warehouse, warehouse.locationId, right.variantId, shelf)).toEqual(originRight);
  });
