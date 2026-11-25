import {
  addLoan, advance, arrangeBatterySale, arrangeUsedPool, branchA, caseRecord, decideLoanFate, expect,
  openBranchTray, openCase, openClaim, openDeskBucket, registerNotice, release, resolveClaim,
  sellableExisting, test, warehouseDeskPage, warehouseRole, type Api, type ArrangedSale, type CaseRecord,
} from './harness';

/**
 * S35 (5) and (6) · S31, S32 · the unit bound for the branch's own shelf.
 *
 * A claim whose repaired battery is destined to `stock` is never delivered: the delivery asserts the
 * battery left with the client and this battery is the branch's stock. The act that ends that case is
 * the Almacén's release, it requires the branch's notice, and it refuses to close while a loan of the
 * case is still undecided (`LW036`) because the used pool is derived from that fate. Once the fate is
 * decided the release closes the case and the unit becomes sellable stock exactly once.
 *
 * The journey to `resolved` is arranged by the API — it is the other specs' subject, not this one — and
 * both acts under test are the screens' own.
 */

interface StockBoundCase {
  readonly claim: CaseRecord;
  readonly sale: ArrangedSale;
}

/** A resolved claim whose unit is bound for stock, with the notice the release will require. */
async function arrangeStockBoundCase(api: Api): Promise<StockBoundCase> {
  const branch = await api.as(branchA);
  const warehouse = await api.as(warehouseRole);
  const sale = await arrangeBatterySale({ branch, warehouse }, 'stock');
  const model = await arrangeUsedPool({ branch, warehouse }, 'stock');
  const claim = await openClaim(branch, sale.serial, 'La batería no arranca');
  await addLoan(branch, claim.id, { model, quantity: 1, source_location_id: branch.locationId });
  await advance(branch, claim.id, 'in_transit', 'Sale al Almacén');
  await advance(warehouse, claim.id, 'at_warehouse', 'Recibida en el Almacén');
  await advance(warehouse, claim.id, 'at_factory', 'Enviada a fábrica',
    `LEG-${Date.now().toString(36).toUpperCase()}`);
  const resolved = await resolveClaim(warehouse, claim.id, {
    verdict: 'repaired', reported_destination: 'stock', loan_destination: 'customer',
    note: 'Reparada por fábrica',
  });
  if (resolved.phase !== 'resolved' || resolved.reported_destination !== 'stock') {
    throw new Error(`el arrange no dejó el caso listo: ${resolved.phase} · ${resolved.reported_destination}`);
  }
  await registerNotice(branch, claim.id, 'Avisado el cliente: la batería volvió de fábrica');
  return { claim, sale };
}

test('un caso de destino stock no ofrece la entrega y la liberación se niega con LW036 mientras el préstamo siga sin desenlace',
  async ({ page, browser, api }) => {
    const branch = await api.as(branchA);
    const arranged = await arrangeStockBoundCase(api);

    await openBranchTray(page);
    const detail = await openCase(page, arranged.claim.case_number);

    // S31: la entrega afirma que la unidad salió con el cliente, y esta unidad es stock de la sucursal.
    await expect(detail.getByRole('heading', { name: 'El caso cierra con la liberación' })).toBeVisible();
    await expect(detail.getByText(
      'La unidad de este caso va al stock vendible de la sucursal: no se entrega a ningún cliente.')).toBeVisible();
    await expect(detail.getByRole('heading', { name: 'Entregar el canje' })).toHaveCount(0);
    await expect(detail.getByRole('button', { name: 'Entregar canje' })).toHaveCount(0);
    await expect(detail.getByLabel('Qué pasó con la usada')).toHaveCount(0);

    // S32: la liberación es del Almacén, y con un préstamo sin desenlace se niega con LW036.
    const desk = await warehouseDeskPage(browser);
    try {
      await openDeskBucket(desk, 'Devueltas sin decidir');
      await openCase(desk, arranged.claim.case_number);
      // El acto que cierra este caso (S31) es esta liberación: la mesa tiene que ofrecerla.
      await expect(desk.getByRole('heading', { name: 'Autorizar la liberación' })).toBeVisible({ timeout: 5_000 });
      await desk.getByLabel('Motivo de la liberación').fill('El cliente no vino: la unidad queda en stock');
      await desk.getByRole('button', { name: 'Autorizar la liberación a stock' }).click();
      await expect(desk.getByRole('alert')).toHaveText(
        'El caso tiene un préstamo sin desenlace: decidí qué pasó con la usada antes de cerrarlo.');
      // La negativa no escribió nada: el caso sigue resuelto y sin liberación, y el préstamo sigue abierto.
      const refused = await caseRecord(branch, arranged.claim.id);
      expect(refused.phase).toBe('resolved');
      expect(refused.events.some(entry => entry.kind === 'release')).toBe(false);
      expect(refused.loans.map(loan => loan.fate)).toEqual(['open']);
    } finally {
      await desk.close();
    }
  });

test('decidido el desenlace, la liberación cierra el caso y la unidad entra al stock vendible una sola vez',
  async ({ browser, api }) => {
    const branch = await api.as(branchA);
    const warehouse = await api.as(warehouseRole);
    const arranged = await arrangeStockBoundCase(api);
    // El desenlace es de la sucursal y es previo: la liberación no lo decide, se niega a cerrar sin él.
    await decideLoanFate(branch, arranged.claim.id, 1, 'returned');
    const before = await sellableExisting(branch, arranged.sale.variantId);

    const desk = await warehouseDeskPage(browser);
    try {
      await openDeskBucket(desk, 'Devueltas sin decidir');
      await openCase(desk, arranged.claim.case_number);
      // El acto que cierra este caso (S31) es esta liberación: la mesa tiene que ofrecerla.
      await expect(desk.getByRole('heading', { name: 'Autorizar la liberación' })).toBeVisible({ timeout: 5_000 });
      await desk.getByLabel('Motivo de la liberación').fill('El cliente no vino: la unidad queda en stock');
      await desk.getByRole('button', { name: 'Autorizar la liberación a stock' }).click();
      await expect(desk.getByText(
        `${arranged.claim.case_number}: la unidad liberada a stock vendible quedó fuera de custodia.`)).toBeVisible();
      await expect(desk.getByText('El caso está cerrado: no admite más actos del Almacén.')).toBeVisible();

      // El caso cerró y la unidad entró al stock vendible de la sucursal, una sola vez.
      expect((await caseRecord(branch, arranged.claim.id)).phase).toBe('closed');
      expect(await sellableExisting(branch, arranged.sale.variantId)).toBe(before + 1);

      // Y una sola vez: la segunda liberación se niega y el saldo no se mueve.
      const again = await release(warehouse, arranged.claim.id, 'Otra liberación', 409);
      expect(again.body.error).toBe('already_released');
      expect(await sellableExisting(branch, arranged.sale.variantId)).toBe(before + 1);
    } finally {
      await desk.close();
    }
  });
