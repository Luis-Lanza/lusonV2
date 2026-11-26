import {
  arrangedClosure, branchA, closingHistory, ensureCommission, expect, freeBranch, knownBranchId,
  knownBranchName, openWarehouseClosings, selectBranch, statusTag, test, uniqueText, warehouseRole,
  warehouseSessionState,
} from './harness';

/**
 * S2 · la lista de rendiciones de una sucursal, tal como el Almacén la lee.
 *
 * La pantalla `#/rendiciones` no es un listado paginado: es el documento de trabajo de una sucursal,
 * y lo primero que el Almacén hace es elegir cuál. Lo que la pantalla publica de una sucursal sin
 * rendición abierta es su historia —la última rendición cerrada y cuántas hay—, así que la prueba
 * arma un cierre por el contrato y verifica que la pantalla describa ese mismo documento y no otro.
 */

freeBranch();

test.use({ storageState: warehouseSessionState });

test('el Almacén elige la sucursal y lee la última rendición de su historia',
  async ({ page, api }) => {
    const warehouse = await api.as(warehouseRole);
    const branch = await api.as(branchA);
    await ensureCommission(warehouse, knownBranchId);
    const observation = uniqueText('Cierre del historial');
    const closed = await arrangedClosure(warehouse, branch, knownBranchId, observation);
    expect(closed.status).toBe('closed');

    await openWarehouseClosings(page);
    // Rendiciones es la sección de la sesión: la navegación del Almacén la marca y su hash la restaura.
    await expect(page.getByRole('button', { name: 'Rendiciones' })).toHaveAttribute('aria-current', 'page');
    expect(new URL(page.url()).hash).toBe('#/rendiciones');
    // La pantalla arranca sin sucursal: no hay documento que describir todavía.
    await expect(page.locator('p.closing-note')).toHaveCount(0);

    await selectBranch(page);

    // La sucursal no tiene rendición abierta: la pantalla publica el último cierre de su historia.
    await expect(statusTag(page, 'Cerrada')).toBeVisible();
    await expect(page.getByText(`Mostrando la rendición #${closed.id} cerrada: no se reabre, se corrige con aprobación de la sucursal.`))
      .toBeVisible();
    await expect(page.getByRole('button', { name: 'Abrir rendición de cuentas' })).toBeVisible();
    // No está congelada: una rendición cerrada no retiene a la sucursal.
    await expect(page.getByText('Sucursal congelada')).toHaveCount(0);
    // La observación que el operador firmó en ese cierre se lee sobre el documento abierto.
    await expect(page.getByText(observation)).toBeVisible();

    // Y es la misma fila que la historia de la sucursal publica por el contrato.
    const history = await closingHistory(warehouse, knownBranchId);
    expect(history.total_closings).toBeGreaterThan(0);
    expect(history.closings[0].id).toBe(closed.id);
    expect(history.closings[0].status).toBe('closed');
    expect(history.closings[0].branch_location_id).toBe(knownBranchId);
    expect(history.closings[0].branch_name).toBe(knownBranchName);
    expect(history.closings[0].observation).toBe(observation);
  });
