import {
  arrangeReceived, arrangeRunStock, balance, branchB, branchBSession, decideReconciliation, expect, filterTransfers,
  openReconciliation, openTransfer, openTransferList, test, unifiedSnapshot, warehouseRole,
} from './harness';

/**
 * S2 · el acto de conciliar cuando el conteo recibido no coincide: proponer.
 *
 * La recepción de la corrida quedó con un faltante real, así que el conteo efectivo declarado es menor que
 * lo enviado. La sucursal, que es el destino físico, abre «Resolver diferencia», declara cuánto salió,
 * cuánto llegó y qué quedó en origen, lee los efectos hipotéticos de su propuesta y la envía. Proponer no
 * mueve stock ni cierra la diferencia: la contraparte tiene que aceptarla.
 */

test.use({ storageState: branchBSession });

test('la sucursal propone el conteo efectivo de una recepción con diferencia y la diferencia sigue abierta',
  async ({ page, api }) => {
    const branch = await api.as(branchB);
    const warehouse = await api.as(warehouseRole);
    const stock = await arrangeRunStock(warehouse);
    const units = 2;
    const received = await arrangeReceived(stock, { branch, warehouse }, units, 1);
    const origin = await balance(warehouse, warehouse.locationId, stock.variantId);
    const destination = await balance(branch, branch.locationId, stock.variantId);
    const reason = `Conteo verificado en destino ${stock.name}`;

    // El detalle de la recepción publica el faltante: la diferencia que el acto viene a resolver.
    await openTransferList(page);
    await filterTransfers(page, 'Recibidas');
    await expect(page.getByRole('row').filter({ hasText: received.reference })).toContainText('Recibida');
    const detail = await openTransfer(page, received);
    await expect(detail.getByText('Faltante: 1').first()).toBeVisible();

    const modal = await openReconciliation(page);
    await expect(modal.getByText(`Declaradas originalmente: ${units} · Recibidas originalmente: 1 · Crédito original: 1. Estos registros se conservan.`)).toBeVisible();
    await modal.getByLabel('Salieron realmente').fill(String(units));
    await modal.getByLabel('Llegaron realmente').fill(String(units));
    await modal.getByLabel('Quedaron físicamente en origen').fill('0');
    await modal.getByLabel('Motivo y evidencia').fill(reason);
    await modal.getByRole('button', { name: 'Revisar propuesta' }).click();

    // La revisión declara el efecto hipotético: no es una garantía de stock ni una escritura.
    await expect(modal.getByRole('heading', { name: 'Revisar efectos' })).toBeVisible();
    await expect(modal.getByText(`propuesta · Variante ${stock.variantId}`)).toBeVisible();
    await expect(modal.getByText('Hipotético: 1')).toBeVisible();
    await expect(modal.getByText('Proponer o rechazar no mueve stock.')).toBeVisible();
    await expect(modal.getByText(reason)).toBeVisible();
    await modal.getByRole('button', { name: 'Confirmar propuesta' }).click();

    // La propuesta quedó registrada y sin decidir: el conteo efectivo todavía es el de la recepción. La
    // pantalla cierra el paso de confirmación cuando su lectura se refresca, así que el documento se
    // espera con la misma paciencia que la interfaz, no con una foto de un instante.
    await expect.poll(async () => (await unifiedSnapshot(branch, received.id)).lines[0]?.workflow_revision)
      .toBe('1');
    const snapshot = await unifiedSnapshot(branch, received.id);
    const line = snapshot.lines[0];
    const proposal = line?.proposals.at(-1);
    expect(line?.workflow_revision).toBe('1');
    expect(proposal?.state).toBe('pending');
    expect(proposal?.initiator_location_id).toBe(branch.locationId);
    expect([proposal?.dispatch_quantity, proposal?.arrival_quantity, proposal?.retained_quantity])
      .toEqual([String(units), String(units), '0']);
    expect(proposal?.reason).toBe(reason);
    expect(snapshot.current[0]?.effective_credit).toBe('1');

    // La misma operación, reabierta por el operador: su clave y sus cantidades, ya confirmadas.
    const again = await openReconciliation(page);
    await expect(again.getByRole('heading', { name: 'Operación confirmada' })).toBeVisible();
    await expect(again.getByText(new RegExp(`^Variante ${stock.variantId} · propuesta · Clave: [A-Za-z0-9_-]+ · Revisión esperada: 0$`))).toBeVisible();
    await expect(again.getByText(`Salieron: ${units} · Llegaron: ${units} · Retenidas: 0`)).toBeVisible();
    await expect(again.getByText(reason)).toBeVisible();

    // La propuesta no movió nada: el saldo de las dos puntas es el que la recepción dejó.
    expect(await balance(warehouse, warehouse.locationId, stock.variantId)).toEqual(origin);
    expect(await balance(branch, branch.locationId, stock.variantId)).toEqual(destination);

    // La unidad que el conteo daba por perdida se contabiliza con la aceptación de la contraparte, el acto
    // que la prueba siguiente ejerce por pantalla; acá cierra el arreglo para no dejar stock en el aire.
    await decideReconciliation(warehouse, received.id, 'accept', {
      variantId: stock.variantId, revision: '1', reason: `Aceptación del arreglo ${stock.name}`,
    });
    const settled = await balance(branch, branch.locationId, stock.variantId);
    expect(settled.existing).toBe(destination.existing + 1);
  });
