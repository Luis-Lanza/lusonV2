import {
  actionBar, blockReason, branchA, closeEverything, closingDocument, ensureCommission, expect,
  freeBranch, knownBranchId, knownBranchName, liveClosing, openWarehouseSettlement, refused, statusTag,
  test, warehouseRole, warehouseSessionState,
} from './harness';

/**
 * S2 · el Almacén abre la rendición de una sucursal.
 *
 * Abrir es el acto que congela: el corte del período, la foto del stock y el sobre del fondo quedan
 * tomados en ese instante y la sucursal no vuelve a vender ni a cargar gastos hasta que acepte. La
 * prueba lo hace desde el botón de la pantalla —no por el contrato— y después contrasta el documento
 * que quedó abierto y la segunda apertura que el servidor rechaza, porque una sucursal sostiene una
 * sola rendición viva.
 */

freeBranch();

test.use({ storageState: warehouseSessionState });

test('el Almacén abre la rendición de la sucursal y la deja congelada', async ({ page, api }) => {
  const warehouse = await api.as(warehouseRole);
  const branch = await api.as(branchA);
  await ensureCommission(warehouse, knownBranchId);
  // El punto de partida es una sucursal libre: la corrida no hereda un cierre de otra prueba.
  await closeEverything(warehouse, branch, knownBranchId);

  await openWarehouseSettlement(page);
  await expect(page.getByRole('button', { name: 'Abrir rendición de cuentas' })).toBeVisible();
  await expect(statusTag(page, 'Abierta')).toHaveCount(0);

  // El acto: el botón que abre el cierre de la sucursal que el operador eligió.
  await page.getByRole('button', { name: 'Abrir rendición de cuentas' }).click();
  await expect(statusTag(page, 'Abierta')).toBeVisible();

  const live = await liveClosing(warehouse, knownBranchId);
  if (live === null) throw new Error('la rendición abierta no aparece en la historia de la sucursal');
  // La pantalla nombra el documento que el servidor abrió y avisa qué le pasó a la sucursal.
  await expect(page.locator('p.closing-status'))
    .toHaveText(`Rendición #${live.id} abierta: la sucursal queda congelada hasta que la acepte.`);
  await expect(page.getByText('Sucursal congelada')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Abrir rendición de cuentas' })).toHaveCount(0);

  // Una rendición recién abierta no tiene caja declarada: proponerla todavía no se puede.
  await expect(actionBar(page).getByRole('button', { name: 'Proponer a la sucursal' })).toBeDisabled();
  await expect(blockReason(page)).toHaveText(
    'Falta la caja contada y el fondo que queda en la caja: el cierre no puede proponerse sin eso.');

  // El documento persistido es el que la pantalla describe: abierto, de la sucursal de la sesión y
  // con su planilla tomada del corte, sin ninguna ronda propuesta todavía.
  const document = await closingDocument(warehouse, live.id);
  expect(document.status).toBe('open');
  expect(document.branch_location_id).toBe(knownBranchId);
  expect(document.branch_name).toBe(knownBranchName);
  expect(document.closed_at).toBeNull();
  expect(document.commission_rate_percent).toBeNull();
  expect(document.rounds).toEqual([]);
  expect(document.count_lines.length).toBeGreaterThan(0);

  // Una sucursal sostiene una sola rendición viva: la segunda apertura no escribe nada.
  const again = await refused(warehouse, '/api/closings', { branch_location_id: knownBranchId }, 409);
  expect(again.error).toBe('settlement_live');
  expect((await closingDocument(warehouse, live.id)).id).toBe(live.id);
});
