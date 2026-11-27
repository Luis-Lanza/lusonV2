import type { Page } from '@playwright/test';
import {
  addLoan, advance, arrangeBatterySale, arrangeUsedPool, branchA, caseRecord, decideLoanFate, expect,
  openBranchTray, openCase, openClaim, openDeskBucket, registerNotice, release,
  sellableExisting, test, warehouseDeskPage, warehouseRole, type Api, type ArrangedSale, type CaseRecord,
} from './harness';

/**
 * S9, S11 · "si está todo OK se devuelve arreglada".
 *
 * The factory answers `repaired` and the case enters `resolved`. What happens to the battery on the
 * stock side is not the verdict's to say: the destination the case declared is what decides, and the
 * contract names the pair (`unitBoundForStock`, `apps/api/internal/warrantycase/store.go:1009`). A
 * repaired battery destined to the client waits in custody — outside `inventory_balances`, not sellable
 * — and leaves with him when the counter delivers. A repaired battery destined to the branch's own
 * shelf enters its sellable stock once, through the release that authorises the warehouse and closes the
 * case. The same verdict, two different stock outcomes, and the spec reads both.
 *
 * The journey to the factory is arranged by the API; the verdict and the act that ends each case are the
 * screens' own.
 */

interface RepairedCase {
  readonly claim: CaseRecord;
  readonly sale: ArrangedSale;
}

/** A claim already shipped to the factory with its transcribed file number, waiting for the verdict. */
async function arrangeAtFactory(api: Api, tag: string): Promise<RepairedCase> {
  const branch = await api.as(branchA);
  const warehouse = await api.as(warehouseRole);
  const sale = await arrangeBatterySale({ branch, warehouse }, tag);
  const model = await arrangeUsedPool({ branch, warehouse }, tag);
  const claim = await openClaim(branch, sale.serial, 'No retiene carga');
  await addLoan(branch, claim.id, { model, quantity: 1, source_location_id: branch.locationId });
  await advance(branch, claim.id, 'in_transit', 'Sale al Almacén');
  await advance(warehouse, claim.id, 'at_warehouse', 'Recibida en el Almacén');
  await advance(warehouse, claim.id, 'at_factory', 'Enviada a fábrica',
    `LEG-${Date.now().toString(36).toUpperCase()}`);
  const shipped = await caseRecord(branch, claim.id);
  if (shipped.phase !== 'at_factory') {
    throw new Error(`el arrange no dejó el caso en fábrica: ${shipped.phase}`);
  }
  return { claim, sale };
}

/** The verdict as the desk states it: the vocabulary of the contract, chosen from its own controls. */
async function repairOnDesk(desk: Page, caseNumber: string, reported: string,
  loan: string): Promise<void> {
  await openDeskBucket(desk, 'En fábrica');
  await openCase(desk, caseNumber);
  await expect(desk.getByRole('heading', { name: 'Registrar el veredicto' })).toBeVisible();
  await desk.getByLabel('Veredicto', { exact: true }).selectOption({ label: 'Reparada' });
  await desk.getByLabel('Unidad reclamada').selectOption({ label: reported });
  await desk.getByLabel('Usada prestada').selectOption({ label: loan });
  await desk.getByLabel('Motivo del veredicto').fill('Reparada por fábrica');
  await desk.getByRole('button', { name: 'Registrar veredicto' }).click();
  await expect(desk.getByText(`${caseNumber}: veredicto reparada.`)).toBeVisible();
  // La resolución se dice una vez: el acto deja de ofrecerse (S11).
  await expect(desk.getByRole('button', { name: 'Registrar veredicto' })).toHaveCount(0);
}

test('la reparada con destino al cliente resuelve el caso y deja la unidad en custodia, fuera del stock vendible',
  async ({ page, browser, api }) => {
    const arranged = await arrangeAtFactory(api, 'reparadacliente');
    const branch = await api.as(branchA);
    const before = await sellableExisting(branch, arranged.sale.variantId);

    const desk = await warehouseDeskPage(browser);
    try {
      await repairOnDesk(desk, arranged.claim.case_number, 'Al cliente', 'A stock vendible');
    } finally {
      await desk.close();
    }

    // El veredicto movió la etapa del caso y quedó guardado, con los dos destinos que se declararon.
    const resolved = await caseRecord(branch, arranged.claim.id);
    expect(resolved.phase).toBe('resolved');
    expect(resolved.verdict).toBe('repaired');
    expect(resolved.reported_destination).toBe('customer');
    expect(resolved.loan_destination).toBe('stock');
    expect(resolved.stock_destination).toBeNull();
    expect(resolved.events.map(entry => entry.phase))
      .toEqual(['in_transit', 'at_warehouse', 'at_factory', 'resolved']);

    // El destino declarado manda en el stock: una unidad al cliente no entra al stock vendible, y el
    // resolver no escribe balance alguno.
    expect(await sellableExisting(branch, arranged.sale.variantId)).toBe(before);

    // La unidad reparada espera en custodia del caso: el punto de venta no puede venderla todavía.
    await openBranchTray(page);
    const detail = await openCase(page, arranged.claim.case_number);
    await expect(detail.getByText('En custodia por garantía: 1 unidad')).toBeVisible();
    await expect(detail.getByText(
      'La unidad reparada no es stock vendible mientras espera al cliente: el punto de venta no puede venderla y la rendición la publica en una línea aparte. Sale de custodia cuando el Almacén la libera o cuando se entrega el canje.',
    )).toBeVisible();
    await expect(detail.getByRole('definition').filter({ hasText: 'Al cliente' })).toBeVisible();

    // Y la custodia no es un saldo: el stock de la variante sigue exactamente donde estaba.
    expect(await sellableExisting(branch, arranged.sale.variantId)).toBe(before);
  });

test('la reparada con destino a stock vuelve al stock vendible una sola vez y el caso cierra por la liberación',
  async ({ browser, api }) => {
    const arranged = await arrangeAtFactory(api, 'reparadastock');
    const branch = await api.as(branchA);
    const warehouse = await api.as(warehouseRole);
    const before = await sellableExisting(branch, arranged.sale.variantId);

    const desk = await warehouseDeskPage(browser);
    try {
      await repairOnDesk(desk, arranged.claim.case_number, 'A stock vendible', 'Al cliente');
    } finally {
      await desk.close();
    }

    // La resolución deja el caso resuelto y no toca el balance: la unidad sigue en custodia.
    const resolved = await caseRecord(branch, arranged.claim.id);
    expect(resolved.phase).toBe('resolved');
    expect(resolved.verdict).toBe('repaired');
    expect(resolved.reported_destination).toBe('stock');
    expect(await sellableExisting(branch, arranged.sale.variantId)).toBe(before);

    // El aviso es de la sucursal que recibió la unidad (S14) y es lo que habilita la liberación.
    await registerNotice(branch, arranged.claim.id, 'Avisado el cliente: la batería volvió de fábrica');
    // El desenlace de la usada es de la sucursal y lo decide antes: la liberación que cierra el caso se
    // niega mientras un préstamo siga abierto (`LW036`, S32), porque el pool de usadas se deriva de él.
    await decideLoanFate(branch, arranged.claim.id, 1, 'returned');

    const releasing = await warehouseDeskPage(browser);
    try {
      await openDeskBucket(releasing, 'Devueltas sin decidir');
      await openCase(releasing, arranged.claim.case_number);
      await expect(releasing.getByRole('heading', { name: 'Autorizar la liberación' })).toBeVisible();
      await expect(releasing.getByText(
        'La unidad vuelve al stock vendible de la sucursal y el caso cierra con este acto, con actor y motivo, y una sola vez. El aviso al cliente ya está registrado por la sucursal.',
      )).toBeVisible();
      await releasing.getByLabel('Motivo de la liberación').fill('La unidad va al stock de la sucursal');
      await releasing.getByRole('button', { name: 'Autorizar la liberación a stock' }).click();
      await expect(releasing.getByText(
        `${arranged.claim.case_number}: la unidad liberada a stock vendible quedó fuera de custodia.`,
      )).toBeVisible();
    } finally {
      await releasing.close();
    }

    // El mismo veredicto, el otro destino: la unidad entró al stock vendible y el caso cerró con ese acto.
    const closed = await caseRecord(branch, arranged.claim.id);
    expect(closed.phase).toBe('closed');
    expect(closed.closed_by).toBe('release');
    expect(await sellableExisting(branch, arranged.sale.variantId)).toBe(before + 1);

    // Una sola vez: la segunda liberación se niega y el saldo no se mueve.
    const again = await release(warehouse, arranged.claim.id, 'Otra liberación de la misma unidad', 409);
    expect(again.body.error).toBe('already_released');
    expect(await sellableExisting(branch, arranged.sale.variantId)).toBe(before + 1);
  });
