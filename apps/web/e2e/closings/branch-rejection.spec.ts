import {
  arrangedProposal, branchB, branchBSession, closingDocument, ensureCommission, decideClosing,
  expect, freeBranch, knownBranchId, openBranchDecision, proposeClosing, statusTag, test, uniqueText,
  warehouseRole,
} from './harness';

/**
 * S2 · la sucursal rechaza la propuesta con su motivo.
 *
 * Rechazar es la otra mitad de la decisión: no aplica nada, no descongela la sucursal y devuelve el
 * cierre al Almacén con el motivo escrito. La prueba lo hace desde la pantalla —abre el motivo, lo
 * escribe y envía el rechazo— y contrasta la ronda que el documento persiste. Después la sucursal
 * acepta una segunda propuesta por el contrato: la rendición queda cerrada y la sucursal libre.
 */

freeBranch();

test.use({ storageState: branchBSession });

test('la sucursal rechaza la propuesta con su motivo y el cierre vuelve al Almacén',
  async ({ page, api }) => {
    const warehouse = await api.as(warehouseRole);
    const branch = await api.as(branchB);
    await ensureCommission(warehouse, knownBranchId);
    const proposed = await arrangedProposal(warehouse, branch, knownBranchId);
    expect(proposed.status).toBe('proposed');
    const motive = uniqueText('Faltó contar la bodega');

    await openBranchDecision(page);
    const answer = page.locator('section[aria-labelledby="closing-decision-answer"]');
    await answer.getByRole('button', { name: 'Rechazar la propuesta' }).click();

    // El motivo es obligatorio: sin él el envío está cerrado.
    const motiveField = page.getByLabel('Motivo del rechazo', { exact: true });
    await expect(motiveField).toBeVisible();
    await expect(page.getByRole('button', { name: 'Enviar rechazo al Almacén' })).toBeDisabled();

    // El acto: el motivo escrito y el rechazo enviado.
    await motiveField.fill(motive);
    await expect(page.getByRole('button', { name: 'Enviar rechazo al Almacén' })).toBeEnabled();
    await page.getByRole('button', { name: 'Enviar rechazo al Almacén' }).click();
    // La pantalla vuelve a leer el documento que la respuesta acaba de publicar, así que el aviso de
    // la operación es transitorio y se afirma el estado que queda: la rendición devuelta.
    await expect(statusTag(page, 'Devuelta por la sucursal')).toBeVisible();

    // La ronda queda legible con su estado y el motivo que la sucursal firmó.
    const rounds = page.locator('section[aria-labelledby="closing-decision-rounds"]');
    await expect(rounds).toContainText('Rechazada');
    await expect(rounds).toContainText(motive);
    // Y la sucursal sigue congelada: el rechazo no cierra el período.
    await expect(page.getByText('Sucursal congelada')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Aceptar y cerrar la rendición' })).toHaveCount(0);

    // El documento persiste la ronda rechazada con su motivo, y nada se aplicó.
    const document = await closingDocument(warehouse, proposed.id);
    expect(document.status).toBe('rejected');
    expect(document.closed_at).toBeNull();
    expect(document.rounds.length).toBe(1);
    expect(document.rounds[0].decision).toBe('rejected');
    expect(document.rounds[0].decision_reason).toBe(motive);

    // El Almacén corrige y vuelve a proponer; la sucursal acepta: el cierre queda cerrado.
    const again = await proposeClosing(warehouse, proposed.id);
    expect(again.rounds.length).toBe(2);
    const closed = await decideClosing(branch, again.id, { decision: 'accepted' });
    expect(closed.status).toBe('closed');
    expect(closed.rounds.map(round => round.decision)).toEqual(['rejected', 'accepted']);
  });
