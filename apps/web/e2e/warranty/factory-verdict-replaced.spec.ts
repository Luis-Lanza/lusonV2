import {
  addLoan, advance, arrangeBatterySale, arrangeUsedPool, branchA, caseRecord, expect,
  openBranchTray, openCase, openClaim, openDeskBucket, saleRecord, salesTotal, sellableExisting,
  test, warehouseDeskPage, warehouseRole, type Api, type ArrangedSale, type CaseRecord,
} from './harness';

/**
 * S3, S11 · "sigue con la venta original" y "el plazo no se reinicia".
 *
 * The factory answers `replaced`: a new battery comes back in the place of the one the client brought.
 * That replacement is delivered against the sale that sold the broken one — the case names that document
 * and no other — and it invents nothing: the term keeps counting from the original sale's own date, the
 * original sale keeps the single unit it recorded, and no second sale is issued for the exchange.
 *
 * The journey to the factory is arranged by the API; the verdict and the delivery are the screens' acts.
 */

interface ReplacedCase {
  readonly claim: CaseRecord;
  readonly sale: ArrangedSale;
}

/** A claim already shipped to the factory, waiting for the verdict that will replace its unit. */
async function arrangeAtFactory(api: Api): Promise<ReplacedCase> {
  const branch = await api.as(branchA);
  const warehouse = await api.as(warehouseRole);
  const sale = await arrangeBatterySale({ branch, warehouse }, 'reemplazo');
  const model = await arrangeUsedPool({ branch, warehouse }, 'reemplazo');
  const claim = await openClaim(branch, sale.serial, 'La batería se hinchó');
  await addLoan(branch, claim.id, { model, quantity: 1, source_location_id: branch.locationId });
  await advance(branch, claim.id, 'in_transit', 'Sale al Almacén');
  await advance(warehouse, claim.id, 'at_warehouse', 'Recibida en el Almacén');
  await advance(warehouse, claim.id, 'at_factory', 'Enviada a fábrica',
    `LEG-${Date.now().toString(36).toUpperCase()}`);
  return { claim, sale };
}

test('fábrica reemplaza la unidad: se entrega contra la venta original, el plazo no se reinicia y no se inventa otra unidad',
  async ({ page, browser, api }) => {
    const arranged = await arrangeAtFactory(api);
    const branch = await api.as(branchA);

    // Lo que la venta original declara antes de que la fábrica responda.
    const original = await saleRecord(branch, arranged.sale.saleId);
    const sales = await salesTotal(branch);
    const shelf = await sellableExisting(branch, arranged.sale.variantId);
    expect(original.lines.flatMap(line => line.units.map(unit => unit.warranty_months))).toEqual([12]);

    const desk = await warehouseDeskPage(browser);
    try {
      await openDeskBucket(desk, 'En fábrica');
      await openCase(desk, arranged.claim.case_number);
      await desk.getByLabel('Veredicto', { exact: true }).selectOption({ label: 'Reemplazada' });
      await desk.getByLabel('Unidad reclamada').selectOption({ label: 'Al cliente' });
      await desk.getByLabel('Usada prestada').selectOption({ label: 'A stock vendible' });
      await desk.getByLabel('Motivo del veredicto').fill('Fábrica entregó una unidad nueva en reemplazo');
      await desk.getByRole('button', { name: 'Registrar veredicto' }).click();
      await expect(desk.getByText(`${arranged.claim.case_number}: veredicto reemplazada.`)).toBeVisible();
    } finally {
      await desk.close();
    }

    const resolved = await caseRecord(branch, arranged.claim.id);
    expect(resolved.phase).toBe('resolved');
    expect(resolved.verdict).toBe('replaced');
    expect(resolved.sale_id).toBe(arranged.sale.saleId);

    // La sucursal entrega el reemplazo, y su detalle publica el plazo de la venta original.
    await openBranchTray(page);
    const detail = await openCase(page, arranged.claim.case_number);
    await expect(detail.getByRole('definition').filter({ hasText: '12 meses' })).toBeVisible();
    await expect(detail.getByText('Corre desde la venta y no se reinicia')).toBeVisible();
    await detail.getByLabel('Qué pasó con la usada').selectOption({ label: 'Volvió al local' });
    await detail.getByLabel('Palabras del mostrador')
      .fill('La clienta devolvió la usada y se llevó la unidad nueva de fábrica');
    await detail.getByRole('button', { name: 'Entregar canje' }).click();
    await expect(page.getByText(
      `Canje entregado en ${arranged.claim.case_number}: el caso queda cerrado y la usada, devuelta al canjear.`,
    )).toBeVisible();

    // El caso cerró por la entrega, y la venta contra la que se entregó es la original y ninguna otra.
    const delivered = await caseRecord(branch, arranged.claim.id);
    expect(delivered.phase).toBe('closed');
    expect(delivered.closed_by).toBe('delivery');
    expect(delivered.sale_id).toBe(arranged.sale.saleId);
    expect(delivered.warranty_number).toBe(arranged.sale.warrantyNumber);
    expect(delivered.variant_id).toBe(arranged.sale.variantId);

    // El plazo no se reinicia: la venta conserva su fecha, su número y exactamente las unidades que
    // vendió, con su serial y su término. Ninguna fila nueva de `sale_units` se inventó para el original.
    const after = await saleRecord(branch, arranged.sale.saleId);
    expect(after.created_at).toBe(original.created_at);
    expect(after.warranty_number).toBe(original.warranty_number);
    expect(after.branch_sequence).toBe(original.branch_sequence);
    expect(after.lines.map(line => ({ variant_id: line.variant_id, quantity: line.quantity, units: line.units })))
      .toEqual(original.lines.map(line => ({ variant_id: line.variant_id, quantity: line.quantity, units: line.units })));

    // Y no hay documento nuevo por el canje: la sucursal sigue con las mismas ventas que tenía.
    expect(await salesTotal(branch)).toBe(sales);

    // La unidad nueva llega de fábrica para el cliente: la entrega no escribe stock de la sucursal.
    expect(await sellableExisting(branch, arranged.sale.variantId)).toBe(shelf);

    // El caso entregado sigue nombrando el plazo de la venta original, sin reiniciarlo.
    await expect(detail.getByText('Entregada al cliente', { exact: true }).first()).toBeVisible();
    await expect(detail.getByRole('definition').filter({ hasText: '12 meses' })).toBeVisible();
    await expect(detail.getByText('Corre desde la venta y no se reinicia')).toBeVisible();
  });
