import {
  arrangedProposal, branchB, branchBSession, closingDocument, ensureCommission, expect, freeBranch,
  knownBranchId, openBranchDecision, settleLiveClosing, statusTag, test, warehouseRole,
} from './harness';

/**
 * S2 · la propuesta que la sucursal recibe.
 *
 * La sucursal no arma el cierre: lee la oferta que el Almacén compuso y lo que cambia si la acepta. La
 * prueba deja una rendición propuesta por el contrato —el acto bajo prueba es la lectura de la
 * propuesta— y verifica que la pantalla publique la ronda que espera decisión, el panel con lo que
 * cambia la existencia y el recordatorio de que hasta que acepte la sucursal no vende ni carga gastos.
 */

freeBranch();

test.use({ storageState: branchBSession });

test('la sucursal lee la propuesta del Almacén y qué cambia si la acepta', async ({ page, api }) => {
  const warehouse = await api.as(warehouseRole);
  const branch = await api.as(branchB);
  await ensureCommission(warehouse, knownBranchId);
  const proposed = await arrangedProposal(warehouse, branch, knownBranchId);
  expect(proposed.status).toBe('proposed');

  await openBranchDecision(page);
  await expect(statusTag(page, 'Propuesta a la sucursal')).toBeVisible();
  await expect(page.getByText('Sucursal congelada')).toBeVisible();

  // La ronda: la única propuesta del cierre espera la decisión de la sucursal.
  const rounds = page.locator('section[aria-labelledby="closing-decision-rounds"]');
  await expect(rounds).toContainText('Propuesta 1');
  await expect(rounds).toContainText('Por decidir');
  await expect(rounds.locator('li')).toHaveCount(1);

  // La decisión: dos puertas, y el rechazo pide su motivo antes de enviarse.
  const answer = page.locator('section[aria-labelledby="closing-decision-answer"]');
  await expect(answer.getByRole('button', { name: 'Aceptar y cerrar la rendición' })).toBeEnabled();
  await expect(answer.getByRole('button', { name: 'Rechazar la propuesta' })).toBeEnabled();
  await expect(page.getByText('no puede vender ni cargar gastos')).toBeVisible();

  // Lo que cambia si acepta: la planilla contada del corte, sin ninguna diferencia contra el sistema.
  const changes = page.locator('section[aria-labelledby="closing-decision-changes"]');
  await expect(changes.getByText('Sin diferencias de stock')).toBeVisible();
  const countedLines = proposed.count_lines.filter(line => line.counted_quantity !== null);
  expect(countedLines.length).toBeGreaterThan(0);
  await expect(changes.locator('tbody tr')).toHaveCount(countedLines.length);
  await expect(changes).toContainText(countedLines[0].model ?? countedLines[0].name ?? '');
  await expect(changes).toContainText('El resto del stock no cambia.');

  // El documento que la pantalla describe es el que el contrato publica: una oferta sin decidir.
  const document = await closingDocument(warehouse, proposed.id);
  expect(document.status).toBe('proposed');
  expect(document.rounds.length).toBe(1);
  expect(document.rounds[0].decision).toBe('');
  expect(document.count_lines.length).toBe(proposed.count_lines.length);

  // La prueba cierra lo que propuso: la sucursal no queda congelada.
  const closed = await settleLiveClosing(warehouse, branch, knownBranchId);
  expect(closed?.id).toBe(document.id);
  expect(closed?.status).toBe('closed');
});
