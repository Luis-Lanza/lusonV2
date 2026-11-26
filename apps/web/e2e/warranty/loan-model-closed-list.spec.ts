import {
  arrangeBatterySale, arrangeUsedPool, branchA, caseRecord, expect, openBranchTray, openCase,
  openClaim, test, unitsLabel, usedStock, warehouseRole,
} from './harness';

/**
 * S35 (3) · S30, S5 · "el modelo del préstamo se elige de una lista cerrada y sin modelo el préstamo no
 * se registra".
 *
 * The pool the spec fills holds one model the catalogue never saw, so a select that offered it can only
 * be reading the used pool of the origin and not a catalogue list: the model is one of the installation's
 * used flows, typed where it entered (`apps/api/docs/warranty-cases.md`, S30). The spec reads three
 * things: the field is a list and not free text, the list is exactly what the origin holds, and with no
 * model chosen the click can never become a loan.
 */
test('el modelo del préstamo se elige de una lista cerrada y sin modelo no se registra el préstamo',
  async ({ page, api }) => {
    const branch = await api.as(branchA);
    const warehouse = await api.as(warehouseRole);
    const sale = await arrangeBatterySale({ branch, warehouse }, 'modelo');
    const model = await arrangeUsedPool({ branch, warehouse }, 'modelo');
    const claim = await openClaim(branch, sale.serial, 'No arranca el motor');

    await openBranchTray(page);
    await openCase(page, claim.case_number);

    await page.getByRole('button', { name: 'Registrar préstamo' }).click();
    const modelField = page.getByLabel('Modelo de la usada');
    await expect(modelField).toBeVisible();
    await expect(modelField).toHaveRole('combobox');
    // La lista cerrada es el pool de usadas del origen, leído del mismo contrato que la pantalla lee
    // (S24, S30): los modelos que el origen tiene, sin uno solo que no haya entrado por sus flujos.
    const held = (await usedStock(branch))
      .filter(row => row.location_id === branch.locationId && row.available > 0)
      .sort((left, right) => left.model.localeCompare(right.model));
    await expect(modelField.locator('option')).toHaveText([
      'Elegí el modelo',
      ...held.map(row => `${row.model} · ${unitsLabel(row.available)}`),
    ]);
    await expect(modelField.locator(`option[value="${model}"]`)).toHaveText([`${model} · 1 unidad`]);
    // Ningún campo de modelo se escribe a mano: en la pantalla no hay input de modelo.
    await expect(page.getByRole('textbox', { name: /modelo/i })).toHaveCount(0);

    const submit = page.getByRole('button', { name: 'Registrar préstamo' });
    await expect(submit).toBeDisabled();
    await page.getByLabel('Cantidad').fill('1');
    await expect(submit).toBeDisabled();
    // Sin modelo no se registró nada, ni en la pantalla ni en el caso.
    await expect(page.getByText('Préstamos de usadas (0)')).toBeVisible();
    expect((await caseRecord(branch, claim.id)).loans).toHaveLength(0);

    // Elegir de la lista sí registra el préstamo que la lista ofreció.
    await modelField.selectOption(model);
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(page.getByText(`Usada registrada en ${claim.case_number}: ${model} · 1 unidad.`)).toBeVisible();
    await expect(page.getByText('Préstamos de usadas (1)')).toBeVisible();
    const handed = (await caseRecord(branch, claim.id)).loans;
    expect(handed.map(loan => [loan.model, loan.fate])).toEqual([[model, 'open']]);
  });
