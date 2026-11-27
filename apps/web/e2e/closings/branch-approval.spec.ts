import {
  arrangedProposal, branchB, branchBSession, closingDocument, ensureCommission, expect, freeBranch,
  knownBranchId, openBranchDecision, statusTag, stockOf, test, warehouseRole,
} from './harness';

/**
 * S2 · la sucursal acepta y cierra la rendición.
 *
 * Aceptar es el único acto que cierra el período y mueve el stock: cada variante contada queda con
 * exactamente lo contado, en las dos direcciones. La prueba acepta desde el botón de la pantalla —no
 * por el contrato—, lee que la sucursal vuelve a operar y contrasta el cierre con la estantería real de
 * la sucursal: después de la aceptación, la existencia de cada línea de la planilla es la que se contó.
 */

freeBranch();

test.use({ storageState: branchBSession });

test('la sucursal acepta la propuesta, cierra la rendición y la existencia queda en lo contado',
  async ({ page, api }) => {
    const warehouse = await api.as(warehouseRole);
    const branch = await api.as(branchB);
    await ensureCommission(warehouse, knownBranchId);
    const proposed = await arrangedProposal(warehouse, branch, knownBranchId);
    expect(proposed.status).toBe('proposed');
    const stockBefore = await stockOf(warehouse, knownBranchId);

    await openBranchDecision(page);
    await expect(statusTag(page, 'Propuesta a la sucursal')).toBeVisible();

    // El acto: la sucursal acepta y cierra.
    await page.getByRole('button', { name: 'Aceptar y cerrar la rendición' }).click();
    // La pantalla vuelve a leer el documento que el cierre acaba de publicar (el aviso de la
    // operación es transitorio y lo reemplaza esa lectura), así que lo que se afirma es el estado
    // que queda: la rendición cerrada y la sucursal operando otra vez.
    await expect(statusTag(page, 'Cerrada')).toBeVisible();

    // Cerrada no se reabre y no queda nada por decidir: la pantalla lo dice en lugar de ofrecer botones.
    await expect(page.getByText(
      'La rendición ya está cerrada y no tiene una corrección esperando tu decisión: el Almacén no puede reabrirla.'))
      .toBeVisible();
    await expect(page.getByRole('button', { name: 'Aceptar y cerrar la rendición' })).toHaveCount(0);
    await expect(page.getByText('Sucursal congelada')).toHaveCount(0);

    // El documento persistido: cerrado, con la hora del cierre y la misma planilla que se aceptó.
    const document = await closingDocument(warehouse, proposed.id);
    expect(document.status).toBe('closed');
    expect(document.closed_at).not.toBeNull();
    expect(document.rounds.length).toBe(1);
    expect(document.rounds[0].decision).toBe('accepted');
    expect(document.commission_rate_percent).not.toBeNull();

    // El cierre dejó cada variante contada con exactamente su conteo, y no movió el resto.
    const stockAfter = await stockOf(warehouse, knownBranchId);
    for (const line of document.count_lines) {
      if (line.counted_quantity === null) continue;
      expect(stockAfter.get(line.variant_id)).toBe(line.counted_quantity);
    }
    // La corrida cerró una rendición que se alineó con el sistema: la góndola no cambió.
    for (const line of document.count_lines) {
      expect(stockBefore.get(line.variant_id)).toBe(stockAfter.get(line.variant_id));
    }
  });
