import {
  addLoan, arrangeBatterySale, arrangeUsedPool, branchA, casesInPhase, expect, openBranchTray,
  openCase, openClaim, test, warehouseRole,
} from './harness';

/**
 * S35 (2) · S4, S34 · "sin préstamo registrado la sucursal no puede enviar el caso al Almacén".
 *
 * The departure is what the loan unblocks, so the spec reads the gate before the loan and after it: the
 * button is not enabled and the screen says why, and the one fact that changes that is the loan itself.
 * Registering a loan by the API keeps the spec on the gate it is about — the loan has its own spec — and
 * the departure is still the screen's own act, so the last assertion reads the tramo the server kept.
 */
test('sin préstamo registrado la sucursal no puede enviar el caso al Almacén', async ({ page, api }) => {
  const branch = await api.as(branchA);
  const warehouse = await api.as(warehouseRole);
  const sale = await arrangeBatterySale({ branch, warehouse }, 'salida');
  const model = await arrangeUsedPool({ branch, warehouse }, 'salida');
  const claim = await openClaim(branch, sale.serial, 'No retiene carga');

  await openBranchTray(page);
  await openCase(page, claim.case_number);

  const dispatch = page.getByRole('button', { name: 'Enviar al Almacén' });
  await expect(dispatch).toBeDisabled();
  await expect(page.getByText(
    'La usada del cliente todavía no está registrada: el caso no puede salir de la sucursal sin préstamo.')).toBeVisible();
  await expect(page.getByText('Préstamos de usadas (0)')).toBeVisible();

  // El hecho que la desbloquea es el préstamo, y sólo él.
  await addLoan(branch, claim.id, { model, quantity: 1, source_location_id: branch.locationId });
  await page.getByRole('button', { name: `Ver el caso ${claim.case_number}` }).click();
  await expect(page.getByText('Préstamos de usadas (1)')).toBeVisible();
  await expect(dispatch).toBeEnabled();

  await page.getByLabel('Motivo del envío').fill('Sale al Almacén');
  await dispatch.click();
  await expect(page.getByText(`${claim.case_number} sale de la sucursal hacia el Almacén.`)).toBeVisible();

  // La salida es un tramo persistido: el Almacén ya tiene el caso en tránsito, no un clic local.
  expect(await casesInPhase(warehouse, 'in_transit')).toContain(claim.case_number);
});
