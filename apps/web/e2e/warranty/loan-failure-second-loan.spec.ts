import {
  addLoan, arrangeBatterySale, arrangeUsedPool, branchA, expect, openBranchTray, openCase, openClaim,
  test, warehouseRole,
} from './harness';
import { caseWithLoans, casesWithSerial, claimAttempt } from './loan-harness';

/**
 * S7 · "si una usada prestada falla, se marca ese préstamo como `failed` y se agrega otro al mismo
 * caso, sin abrir un caso nuevo".
 *
 * The first used battery is arranged by the API — the handover has its own spec — and the failure is
 * the screen's own act: it is declared by the fact that happened, with its confirmation, and it
 * cannot be offered as a field (S33). What the spec then proves is the shape of the case: the failed
 * loan keeps its own fate, the same case offers another used battery and records it as loan two, the
 * client's serial still has exactly one case, and a second claim of the same serial is refused with
 * `claim_already_open` because the case is still open (S7, `076`).
 */
test('una usada que falla se marca y el mismo caso recibe otra usada, sin abrir un segundo caso para el reclamo',
  async ({ page, api }) => {
    const branch = await api.as(branchA);
    const warehouse = await api.as(warehouseRole);
    const sale = await arrangeBatterySale({ branch, warehouse }, 'falla');
    const first = await arrangeUsedPool({ branch, warehouse }, 'fallauno');
    const second = await arrangeUsedPool({ branch, warehouse }, 'fallados');
    const claim = await openClaim(branch, sale.serial, 'No arranca el motor');
    await addLoan(branch, claim.id, { model: first, quantity: 1, source_location_id: branch.locationId });

    await openBranchTray(page);
    const detail = await openCase(page, claim.case_number);
    await expect(page.getByText('Préstamos de usadas (1)')).toBeVisible();
    await expect(detail.locator('table.warranty-loans tbody tr').first()).toContainText(first);

    // La usada que falló se marca por el hecho ocurrido, y el desenlace es definitivo: confirma.
    await page.getByRole('button', { name: 'La usada falló' }).click();
    const confirmation = page.getByRole('group', { name: 'Confirmar el desenlace del préstamo 1' });
    await expect(confirmation).toBeVisible();
    await expect(confirmation.getByText(
      'La usada falló: el desenlace es definitivo y no se puede editar.')).toBeVisible();
    await confirmation.getByRole('button', { name: 'Sí, registrar el desenlace' }).click();
    await expect(page.getByText(`Préstamo 1 de ${claim.case_number}: falló.`)).toBeVisible();
    await expect(detail.getByText('Falló', { exact: true })).toBeVisible();

    // El caso no se abrió de nuevo: el mismo caso ofrece otra usada al cliente.
    await expect(detail.getByRole('heading', { name: 'Prestar otra usada' })).toBeVisible();
    await detail.getByRole('button', { name: 'Registrar préstamo' }).click();
    const modelField = detail.getByLabel('Modelo de la usada');
    await expect(modelField).toHaveValue('');
    // La lista del origen ya no ofrece la usada que salió prestada y sí la que queda en el pool (S25, S30).
    await expect(modelField.locator(`option[value="${first}"]`)).toHaveCount(0);
    await expect(modelField.locator(`option[value="${second}"]`))
      .toHaveText([`${second} · 1 unidad`]);
    await modelField.selectOption(second);
    await detail.getByRole('button', { name: 'Registrar préstamo' }).click();
    await expect(page.getByText(
      `Usada registrada en ${claim.case_number}: ${second} · 1 unidad.`)).toBeVisible();

    // El mismo caso conserva los dos préstamos, cada uno con su propio desenlace.
    await expect(page.getByText('Préstamos de usadas (2)')).toBeVisible();
    const rows = detail.locator('table.warranty-loans tbody tr');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText(first);
    await expect(rows.nth(0)).toContainText('Falló');
    await expect(rows.nth(1)).toContainText(second);
    await expect(rows.nth(1)).toContainText('En préstamo');
    // El segundo préstamo arranca sin decidir: su desenlace se pide al cerrar el caso (S33).
    await expect(page.getByText('Desenlace: sin decidir · se pide al cerrar el caso')).toBeVisible();

    const stored = await caseWithLoans(branch, claim.id);
    expect(stored.case_number).toBe(claim.case_number);
    expect(stored.origin).toBe('warranty_claim');
    expect(stored.phase).toBe('received');
    expect(stored.loans.map(loan => [loan.ordinal, loan.model, loan.quantity, loan.fate])).toEqual([
      [1, first, 1, 'failed'],
      [2, second, 1, 'open'],
    ]);

    // El cliente nunca recibe un segundo caso por el mismo reclamo: su serial sigue en uno solo.
    const claimed = await casesWithSerial(branch, sale.serial);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toEqual({ id: claim.id, case_number: claim.case_number });
    const again = await claimAttempt(branch, sale.serial, 'Otra vez el mismo reclamo', 409);
    expect(again.body.error).toBe('claim_already_open');
    expect(await casesWithSerial(branch, sale.serial)).toHaveLength(1);
  });
