import {
  arrangedClosure, branchB, branchBSession, centsOf, closingDocument, ensureCommission,
  expect, freeBranch, knownBranchId, moneyText, openBranchDecision,
  pendingCorrectionPanel, proposeCorrection, signedMoneyText, statusTag, summaryValue, test, uniqueText,
  warehouseRole,
  wire,
} from './harness';

/**
 * S2 · la sucursal decide la corrección de un cierre.
 *
 * La corrección de un cierre no se aplica sola: el Almacén la propone y la sucursal la acepta o la
 * rechaza. La prueba deja el cierre cerrado con una corrección pendiente propuesta por el contrato
 * —el acto bajo prueba es la decisión de la sucursal—, lee en la pantalla qué cambiaría si la acepta y
 * la acepta desde el botón. Después contrasta el número corregido con el que el documento publica.
 */

freeBranch();

test.use({ storageState: branchBSession });

test('la sucursal acepta la corrección de un cierre y el documento queda con el número corregido',
  async ({ page, api }) => {
    const warehouse = await api.as(warehouseRole);
    const branch = await api.as(branchB);
    await ensureCommission(warehouse, knownBranchId);
    const closed = await arrangedClosure(warehouse, branch, knownBranchId,
      uniqueText('Cierre con una corrección pendiente'));
    expect(closed.status).toBe('closed');
    const counted = centsOf(closed.counted_cash ?? '0.00');
    const corrected = counted + 700;
    const reason = uniqueText('Se contó el cajón antes de recibir un billete');
    const pending = await proposeCorrection(warehouse, closed.id,
      { reason, payload: { counted_cash: wire(corrected) } });
    expect(pending.status).toBe('proposed');

    await openBranchDecision(page);
    await expect(statusTag(page, 'Cerrada')).toBeVisible();

    // La corrección que espera: qué cambiaría, en qué número y con qué motivo.
    const panel = pendingCorrectionPanel(page);
    await expect(panel).toBeVisible();
    await expect(panel.getByText('Corrección pendiente')).toBeVisible();
    await expect(panel).toContainText(reason);
    await expect(panel.getByText('Nada se aplica hasta que la aceptes.')).toBeVisible();
    await expect(summaryValue(panel, /^Caja contada con la corrección$/)).toHaveText(moneyText(corrected));
    await expect(panel.locator('tbody tr[data-kind="counted_cash"] td').nth(2))
      .toHaveText(moneyText(corrected));

    // El acto: la sucursal acepta la corrección.
    await panel.getByRole('button', { name: 'Aceptar la corrección' }).click();

    // La pantalla relee el documento después de la decisión: se afirma lo que queda publicado, no el
    // aviso transitorio de la operación. El cierre sigue cerrado con el número corregido y su delta.
    await expect(statusTag(page, 'Cerrada')).toBeVisible();
    await expect(pendingCorrectionPanel(page)).toHaveCount(0);
    const accepted = page.locator('section[aria-labelledby="closing-correction-accepted"]');
    await expect(accepted).toBeVisible();
    await expect(accepted.getByText('1 aceptada')).toBeVisible();
    await expect(accepted).toContainText(reason);
    const correctedRow = accepted.locator('tr[data-kind="counted_cash"]');
    await expect(correctedRow.locator('td').nth(2)).toContainText(moneyText(corrected));
    await expect(correctedRow.locator('td').nth(3)).toHaveText(signedMoneyText(700));

    // Y el documento que el servidor publica es el que la pantalla describe.
    const document = await closingDocument(warehouse, closed.id);
    expect(document.status).toBe('closed');
    expect(document.counted_cash).toBe(wire(corrected));
    expect(document.corrections.length).toBe(1);
    expect(document.corrections[0].id).toBe(pending.id);
    expect(document.corrections[0].status).toBe('accepted');
    expect(document.corrections[0].effects.map(effect => effect.kind)).toEqual(['counted_cash']);
    expect(centsOf(document.corrections[0].effects[0].amount_delta ?? '0.00')).toBe(700);
    // La corrección ya está decidida: la fila de la decisión quedó registrada.
    expect(document.corrections[0].status).toBe('accepted');
    // La prueba no deja nada pendiente: la única corrección del cierre es la que aceptó.
    expect(document.corrections.filter(entry => entry.status === 'proposed')).toEqual([]);
  });
