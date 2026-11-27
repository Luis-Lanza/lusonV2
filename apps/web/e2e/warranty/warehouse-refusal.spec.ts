import {
  addLoan, advance, arrangeBatterySale, arrangeUsedPool, branchA, caseRecord, expect, openBranchTray,
  openCase, openClaim, openDeskBucket, resolutionAttempt, test, warehouseDeskPage, warehouseRole,
  type Api, type CaseRecord,
} from './harness';

/**
 * S10 · "almacén la envía a fábrica no es automático".
 *
 * The warehouse verifies before it spends the freight, and it may refuse. The gate admits one verdict —
 * the refusal — and demands its motive; the refused case ends its journey at the branch: it holds
 * `resolved` with the refusal stated, it never enters the factory tramo and no file number is ever
 * written on it, so the branch gets its battery back without a shipment behind it.
 *
 * The sale, the loan and the trip to the warehouse's door are arranged by the API; the gate is the
 * screen's own act.
 */

/** A claim already received at the warehouse, where the gate waits for the verification. */
async function arrangeAtGate(api: Api): Promise<CaseRecord> {
  const branch = await api.as(branchA);
  const warehouse = await api.as(warehouseRole);
  const sale = await arrangeBatterySale({ branch, warehouse }, 'rechazo');
  const model = await arrangeUsedPool({ branch, warehouse }, 'rechazo');
  const claim = await openClaim(branch, sale.serial, 'Falló a los dos días de la venta');
  await addLoan(branch, claim.id, { model, quantity: 1, source_location_id: branch.locationId });
  await advance(branch, claim.id, 'in_transit', 'Sale al Almacén');
  await advance(warehouse, claim.id, 'at_warehouse', 'Recibida en el Almacén');
  return claim;
}

test('el Almacén rechaza el caso antes de fábrica: queda devuelto con su motivo y sin envío ni legajo',
  async ({ page, browser, api }) => {
    const claim = await arrangeAtGate(api);
    const branch = await api.as(branchA);
    const warehouse = await api.as(warehouseRole);
    const onGate = await caseRecord(branch, claim.id);
    expect(onGate.phase).toBe('at_warehouse');
    const motive = 'No se puede reparar: la unidad volvió doblada del viaje';

    const desk = await warehouseDeskPage(browser);
    try {
      await openDeskBucket(desk, 'Para verificar');
      await openCase(desk, claim.case_number);

      // La compuerta del Almacén: el único veredicto posible es el rechazo, y la mesa lo dice.
      await expect(desk.getByRole('heading', { name: 'Rechazar antes de fábrica' })).toBeVisible();
      await expect(desk.getByText(
        'En la puerta del Almacén el único veredicto posible es el rechazo, con su motivo: la unidad vuelve a la sucursal sin haber gastado el flete a fábrica.',
      )).toBeVisible();
      // En la puerta la mesa ofrece los dos actos, y el que se elige acá es el rechazo: el envío a
      // fábrica exigiría el legajo, que este caso nunca transcribe.
      const verdict = desk.getByLabel('Veredicto', { exact: true });
      await expect(verdict).toHaveValue('refused_at_warehouse');
      await expect(verdict.locator('option')).toHaveText(['Rechazada en el Almacén']);

      // El motivo es obligatorio: elegidos los dos destinos, el acto sigue sin habilitarse.
      await desk.getByLabel('Unidad reclamada').selectOption({ label: 'A stock vendible' });
      await desk.getByLabel('Usada prestada').selectOption({ label: 'Al cliente' });
      const submit = desk.getByRole('button', { name: 'Registrar veredicto' });
      await expect(submit).toBeDisabled();
      await expect(desk.getByText(
        'Falta el destino de cada unidad y el motivo: el veredicto se registra una sola vez y es definitivo.',
      )).toBeVisible();

      // Y el servidor exige lo mismo a quien pide la ruta: sin motivo la negativa es 400 y no escribe nada.
      const noMotive = await resolutionAttempt(warehouse, claim.id,
        { verdict: 'refused_at_warehouse', reported_destination: 'stock', loan_destination: 'customer', note: '' }, 400);
      expect(noMotive.body.error).toBe('reason_required');
      // La puerta no dicta el veredicto de la fábrica: eso llega con el tramo de fábrica (S10).
      const factoryVerdict = await resolutionAttempt(warehouse, claim.id,
        { verdict: 'repaired', reported_destination: 'customer', loan_destination: 'stock', note: 'Reparada' }, 409);
      expect(factoryVerdict.body.error).toBe('warehouse_verdict');
      const unchanged = await caseRecord(branch, claim.id);
      expect(unchanged.phase).toBe('at_warehouse');
      expect(unchanged.verdict).toBeNull();
      expect(unchanged.events.length).toBe(onGate.events.length);

      // Con su motivo, la devolución se registra y el caso deja la puerta del Almacén.
      await desk.getByLabel('Motivo del veredicto').fill(motive);
      await expect(submit).toBeEnabled();
      await submit.click();
      await expect(desk.getByText(`${claim.case_number}: veredicto rechazada en el almacén.`)).toBeVisible();
      // La mesa ya no ofrece ni el envío ni el legajo: el caso no gastó el flete.
      await expect(desk.getByRole('heading', { name: 'Enviar a fábrica' })).toHaveCount(0);
      await expect(desk.getByLabel('Número de legajo de fábrica')).toHaveCount(0);
    } finally {
      await desk.close();
    }

    // El caso quedó en su estado de devolución: resuelto por el rechazo, con su motivo y sus destinos.
    const returned = await caseRecord(branch, claim.id);
    expect(returned.phase).toBe('resolved');
    expect(returned.verdict).toBe('refused_at_warehouse');
    expect(returned.reported_destination).toBe('stock');
    expect(returned.loan_destination).toBe('customer');
    expect(returned.stock_destination).toBeNull();
    expect(returned.events.map(entry => entry.phase)).toEqual(['in_transit', 'at_warehouse', 'resolved']);
    const refusal = returned.events.at(-1);
    if (refusal === undefined) throw new Error('el caso no publica el tramo de la resolución');
    expect(refusal.note).toBe(motive);
    expect(refusal.actor_account_id).toBe(warehouse.accountId);

    // No hay envío a fábrica ni legajo: ningún tramo entró a esa etapa y ninguno transcribió un número.
    expect(returned.events.some(entry => entry.phase === 'at_factory')).toBe(false);
    expect(returned.events.filter(entry => entry.factory_case_number !== '')).toEqual([]);

    // La sucursal recibe el caso de vuelta: su historia no tiene fábrica y su veredicto es el rechazo.
    await openBranchTray(page);
    const detail = await openCase(page, claim.case_number);
    await expect(detail.getByText('Rechazada en el Almacén', { exact: true })).toBeVisible();
    await expect(detail.getByText('En fábrica', { exact: true })).toHaveCount(0);
    await expect(detail.getByText(/Legajo de fábrica/)).toHaveCount(0);
  });
