import {
  addLoan, advance, advanceAttempt, arrangeBatterySale, arrangeUsedPool, branchA, caseRecord,
  expect, openBranchTray, openCase, openClaim, openDeskBucket, test, warehouseDeskPage, warehouseRole,
  type Api, type CaseRecord,
} from './harness';

/**
 * S9, S10 · "almacén la envía a fábrica".
 *
 * The Almacén receives what the branch sent, verifies it and ships it to the factory transcribing the
 * factory's file number by hand. The shipment is never automatic: until the unit is verified the desk
 * offers no legajo field and no shipment at all, and once it does, the field is the one the screen
 * demands and the tramo is the one the server keeps — with the legajo, the account that wrote it and
 * the instant, in the append-only history the branch reads back.
 *
 * The sale, the loan and the departure are arranged by the API: they are the other acts' subject (S35),
 * and what this spec drives is what the Almacén does when the case arrives at its door.
 */

/** A claim on its way to the warehouse with the loan that let it leave the branch (S4). */
async function arrangeInTransit(api: Api): Promise<CaseRecord> {
  const branch = await api.as(branchA);
  const warehouse = await api.as(warehouseRole);
  const sale = await arrangeBatterySale({ branch, warehouse }, 'legajo');
  const model = await arrangeUsedPool({ branch, warehouse }, 'legajo');
  const claim = await openClaim(branch, sale.serial, 'La batería no arranca el motor');
  await addLoan(branch, claim.id, { model, quantity: 1, source_location_id: branch.locationId });
  await advance(branch, claim.id, 'in_transit', 'Sale al Almacén');
  return claim;
}

test('el Almacén recibe la unidad, transcribe el legajo a mano y el caso llega a fábrica con legajo, actor y fecha',
  async ({ page, browser, api }) => {
    const claim = await arrangeInTransit(api);
    const branch = await api.as(branchA);
    const warehouse = await api.as(warehouseRole);
    const legajo = `LEG-${Date.now().toString(36).toUpperCase()}`;
    const startedAt = Date.now();
    const onArrival = await caseRecord(branch, claim.id);

    const desk = await warehouseDeskPage(browser);
    try {
      await openDeskBucket(desk, 'En tránsito');
      await openCase(desk, claim.case_number);

      // Llegar no es enviar: la recepción es el acto que la mesa ofrece primero, y el envío no existe
      // todavía. El caso se verifica antes de gastar el flete (S10).
      await expect(desk.getByRole('heading', { name: 'Recibir en el Almacén' })).toBeVisible();
      await expect(desk.getByRole('heading', { name: 'Enviar a fábrica' })).toHaveCount(0);
      await expect(desk.getByLabel('Número de legajo de fábrica')).toHaveCount(0);

      // Lo que la pantalla exige para recibir: sus palabras, en un campo obligatorio.
      const arrivalNote = desk.getByLabel('Qué llegó al Almacén');
      await expect(arrivalNote).toHaveAttribute('required', '');
      await arrivalNote.fill('Llegó la batería con su caja original');
      await desk.getByRole('button', { name: 'Registrar la recepción' }).click();
      await expect(desk.getByText(
        `${claim.case_number} recibida en el Almacén: el caso espera la verificación antes de fábrica.`,
      )).toBeVisible();

      // Recién recibida, la mesa abre el envío con el legajo que se transcribe a mano.
      await expect(desk.getByRole('heading', { name: 'Enviar a fábrica' })).toBeVisible();
      await expect(desk.getByRole('heading', { name: 'Recibir en el Almacén' })).toHaveCount(0);
      const legajoField = desk.getByLabel('Número de legajo de fábrica');
      await expect(legajoField).toHaveAttribute('required', '');
      await expect(legajoField).toHaveValue('');
      // La etapa que el caso declara en la mesa es la del Almacén: su compuerta de verificación.
      await expect(desk.getByRole('heading', { name: 'Rechazar antes de fábrica' })).toBeVisible();

      // Sin legajo el formulario no sale: el campo es obligatorio para la pantalla.
      await desk.getByLabel('Motivo del envío').fill('Verificada: va a fábrica');
      await desk.getByRole('button', { name: 'Enviar a fábrica' }).click();
      expect(await legajoField.evaluate((field: HTMLInputElement) => field.validity.valueMissing)).toBe(true);
      const blocked = await caseRecord(branch, claim.id);
      expect(blocked.phase).toBe('at_warehouse');
      expect(blocked.events.length).toBe(onArrival.events.length + 1);

      // Y el servidor lo exige también a quien pide la ruta directamente: el envío sin legajo es 400 y
      // no escribe nada, y el legajo en cualquier otro tramo es 400 y tampoco.
      const missing = await advanceAttempt(warehouse, claim.id, 'at_factory', 'Enviada sin legajo', '', 400);
      expect(missing.body.error).toBe('factory_file_required');
      const misplaced = await advanceAttempt(warehouse, claim.id, 'at_warehouse', 'Otra recepción', legajo, 400);
      expect(misplaced.body.error).toBe('factory_file_not_allowed');
      const untouched = await caseRecord(branch, claim.id);
      expect(untouched.phase).toBe('at_warehouse');
      expect(untouched.events.length).toBe(blocked.events.length);

      // Con el legajo transcripto, el envío se registra y el caso queda en fábrica.
      await legajoField.fill(legajo);
      await desk.getByLabel('Motivo del envío').fill('Verificada: va a fábrica con su legajo');
      await desk.getByRole('button', { name: 'Enviar a fábrica' }).click();
      await expect(desk.getByText(`${claim.case_number} en fábrica con el legajo ${legajo}.`)).toBeVisible();
      await expect(desk.getByRole('heading', { name: 'Enviar a fábrica' })).toHaveCount(0);
    } finally {
      await desk.close();
    }

    // El caso llegó a su etapa de fábrica y el tramo es un hecho guardado, no un clic local.
    const inFactory = await caseRecord(branch, claim.id);
    expect(inFactory.phase).toBe('at_factory');
    expect(inFactory.events.map(entry => entry.phase)).toEqual(['in_transit', 'at_warehouse', 'at_factory']);

    // El tramo de fábrica lleva el legajo, el actor del Almacén y su fecha.
    const shipment = inFactory.events.at(-1);
    if (shipment === undefined) throw new Error('el caso no publica el tramo del envío a fábrica');
    expect(shipment.kind).toBe('phase');
    expect(shipment.phase).toBe('at_factory');
    expect(shipment.factory_case_number).toBe(legajo);
    expect(shipment.actor_account_id).toBe(warehouse.accountId);
    expect(shipment.actor_account_id).not.toBe(branch.accountId);
    expect(shipment.note).toBe('Verificada: va a fábrica con su legajo');
    const stamped = Date.parse(shipment.recorded_at);
    expect(Number.isNaN(stamped)).toBe(false);
    expect(stamped).toBeGreaterThanOrEqual(startedAt - 1_000);
    expect(stamped).toBeLessThanOrEqual(Date.now() + 1_000);

    // El legajo viaja en ese tramo y en ningún otro.
    expect(inFactory.events.filter(entry => entry.factory_case_number !== '')
      .map(entry => entry.phase)).toEqual(['at_factory']);

    // La sucursal lee el mismo tramo con lo mismo que se guardó: el legajo, la cuenta y la fecha.
    await openBranchTray(page);
    const detail = await openCase(page, claim.case_number);
    const tramo = detail.locator('li').filter({ hasText: `Legajo de fábrica ${legajo}` });
    await expect(tramo).toBeVisible();
    await expect(tramo).toContainText('En fábrica');
    await expect(tramo.locator('time')).toHaveAttribute('datetime', shipment.recorded_at);
    await expect(tramo).toContainText(`Cuenta ${warehouse.accountId}`);
  });
