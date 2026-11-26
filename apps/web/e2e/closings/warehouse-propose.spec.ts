import {
  actionBar, arrangedOpen, blockReason, branchA, centsOf, closingDocument, ensureCommission,
  countedField, expect, freeBranch, knownBranchId, openWarehouseSettlement,
  plainDraft, saveCashDraft, settleLiveClosing, statusTag, test, warehouseRole, warehouseSessionState,
} from './harness';

/**
 * S2 · la propuesta del cierre a la sucursal.
 *
 * Proponer es el acto que congela la tasa, los totales del período y la oferta: desde ese instante la
 * rendición deja de ser un borrador y pasa a esperar la decisión de la sucursal. La prueba declara la
 * caja por el contrato —el acto bajo prueba es la propuesta, no el cajón—, toca el botón de la pantalla
 * y contrasta la ronda que el documento persiste: la única oferta que la sucursal puede aceptar o
 * rechazar.
 */

freeBranch();

test.use({ storageState: warehouseSessionState });

test('el Almacén propone el cierre y la oferta queda esperando a la sucursal', async ({ page, api }) => {
  const warehouse = await api.as(warehouseRole);
  const branch = await api.as(branchA);
  const rate = await ensureCommission(warehouse, knownBranchId);
  const opened = await arrangedOpen(warehouse, branch, knownBranchId);
  // La caja ya está declarada y guardada: lo único que falta es la propuesta.
  await saveCashDraft(warehouse, opened.id, plainDraft(opened));

  await openWarehouseSettlement(page);
  await expect(actionBar(page).getByRole('button', { name: 'Proponer a la sucursal' })).toBeEnabled();
  await expect(blockReason(page)).toHaveText('La rendición se puede proponer: la caja está declarada.');

  // El acto: el Almacén ofrece el cierre.
  await actionBar(page).getByRole('button', { name: 'Proponer a la sucursal' }).click();
  await expect(page.locator('p.closing-status')).toHaveText(
    'Rendición propuesta a la sucursal: ahora espera su aceptación o su rechazo con motivo.');
  await expect(statusTag(page, 'Propuesta a la sucursal')).toBeVisible();

  // La planilla ya no se edita y la barra explica por qué no se puede proponer otra vez.
  const line = opened.count_lines.find(row => row.expected_quantity > 0);
  if (line === undefined) throw new Error('la planilla del corte no tiene ninguna variante con existencia');
  await expect(countedField(page, line.variant_id)).toHaveCount(0);
  await expect(actionBar(page).getByRole('button', { name: 'Guardar borrador' })).toBeDisabled();
  await expect(actionBar(page).getByRole('button', { name: 'Proponer a la sucursal' })).toBeDisabled();
  await expect(blockReason(page)).toHaveText(
    'La propuesta espera la decisión de la sucursal: no se puede proponer otra vez.');

  // El documento persistido: una sola ronda, sin decisión todavía, con la tasa congelada y la oferta
  // que la sucursal va a leer.
  const document = await closingDocument(warehouse, opened.id);
  expect(document.status).toBe('proposed');
  expect(document.commission_rate_percent).toBe(rate);
  expect(document.rounds.length).toBe(1);
  expect(document.rounds[0].round).toBe(1);
  expect(document.rounds[0].decision).toBe('');
  expect(document.rounds[0].decision_reason).toBe('');
  expect(document.rounds[0].offer.commission_amount).toBe(document.commission_amount);
  expect(document.rounds[0].offer.counted_cash).toBe(document.counted_cash);
  expect(document.rounds[0].offer.closing_cash).toBe(document.closing_cash);
  expect(centsOf(document.commission_amount)).toBe(centsOf(document.rounds[0].offer.commission_amount));

  // La prueba cierra la rendición que propuso: la sucursal no queda congelada.
  const closed = await settleLiveClosing(warehouse, branch, knownBranchId);
  expect(closed?.id).toBe(document.id);
  expect(closed?.status).toBe('closed');
});
