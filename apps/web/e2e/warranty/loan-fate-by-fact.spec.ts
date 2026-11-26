import {
  addLoan, arrangeBatterySale, arrangeUsedPool, branchA, caseRecord, expect, openBranchTray,
  openCase, openClaim, test, warehouseRole,
} from './harness';

/**
 * S35 (4) · S33, S7 · "el desenlace no se ofrece como campo: se declara por el hecho ocurrido y exige
 * confirmación".
 *
 * A decided fate is final (`LW012`) and it moves the pool's stock, so the screen never offers it as a
 * form: each loan says it is undecided, the four facts that can have happened are one action each, and
 * the action asks before it writes. The spec reads the absence of the field, the four facts, and — the
 * point of the confirmation — that nothing is written until the operator answers it.
 */
test('el desenlace no se ofrece como campo: se declara por el hecho ocurrido y exige confirmación',
  async ({ page, api }) => {
    const branch = await api.as(branchA);
    const warehouse = await api.as(warehouseRole);
    const sale = await arrangeBatterySale({ branch, warehouse }, 'desenlace');
    const model = await arrangeUsedPool({ branch, warehouse }, 'desenlace');
    const claim = await openClaim(branch, sale.serial, 'No arranca el motor');
    await addLoan(branch, claim.id, { model, quantity: 1, source_location_id: branch.locationId });

    await openBranchTray(page);
    const detail = await openCase(page, claim.case_number);

    // El préstamo se publica sin decidir, y su desenlace no es un campo del formulario.
    await expect(page.getByText('Desenlace: sin decidir · se pide al cerrar el caso')).toBeVisible();
    await expect(page.getByLabel(/desenlace/i)).toHaveCount(0);
    await expect(detail.getByText('En préstamo', { exact: true })).toBeVisible();

    // Los cuatro hechos que pueden haber ocurrido, uno por acción.
    for (const fact of ['La usada falló', 'El cliente la devolvió', 'El cliente se la quedó', 'Se perdió']) {
      await expect(page.getByRole('button', { name: fact })).toBeVisible();
    }

    // Declarar un hecho exige confirmación, y hasta que se confirma no se escribió nada.
    await page.getByRole('button', { name: 'El cliente la devolvió' }).click();
    const confirmation = page.getByRole('group', { name: 'Confirmar el desenlace del préstamo 1' });
    await expect(confirmation).toBeVisible();
    await expect(confirmation.getByText(
      'El cliente la devolvió: el desenlace es definitivo y no se puede editar.')).toBeVisible();
    await expect(detail.getByText('En préstamo', { exact: true })).toBeVisible();
    expect((await caseRecord(branch, claim.id)).loans.map(loan => loan.fate)).toEqual(['open']);

    // Cancelar vuelve a las opciones sin haber decidido.
    await page.getByRole('button', { name: 'Cancelar' }).click();
    await expect(page.getByRole('button', { name: 'Se perdió' })).toBeVisible();
    expect((await caseRecord(branch, claim.id)).loans.map(loan => loan.fate)).toEqual(['open']);

    // Confirmado el hecho, el desenlace queda guardado y la usada ya no se ofrece.
    await page.getByRole('button', { name: 'Se perdió' }).click();
    await page.getByRole('button', { name: 'Sí, registrar el desenlace' }).click();
    await expect(page.getByText(`Préstamo 1 de ${claim.case_number}: perdida.`)).toBeVisible();
    await expect(detail.getByText('Perdida')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Se perdió' })).toHaveCount(0);
    expect((await caseRecord(branch, claim.id)).loans.map(loan => loan.fate)).toEqual(['lost']);
  });
