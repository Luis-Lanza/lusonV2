import {
  arrangeGasto, bandValue, bookMovement, bookRow, branchA, centsOf, drawerForm, expect, moneyText,
  motiveList, openDrawer, readBook, rowMovementId, signedText, test, typedMoney, uniqueAmount,
  uniqueNote, wireMoney,
} from './harness';

/**
 * S2 · la corrección de un movimiento del cajón.
 *
 * El libro es inmutable: una fila equivocada no se edita ni se borra, se responde con otra del signo
 * contrario que la referencia, y el tope es lo que todavía falta corregir de ese movimiento (S6). La
 * prueba arregla por la ruta pública el gasto que el acto no escribe, y después hace lo que hace el
 * operador: abre la corrección de la fila desde el libro, escribe el monto, el motivo y confirma. Lo que
 * afirma es lo que la pantalla muestra y lo que el contrato publica del libro (`closings.md`,
 * «Corrections of the drawer's book»): la fila nueva con su `corrects_id`, la fila original intacta y el
 * saldo de lo que falta corregir.
 */

/**
 * La parte que esta corrección devuelve del gasto: **la mitad del monto que la prueba misma registró**, no
 * un número fijo. El tope de una corrección es lo que todavía falta corregir de su movimiento
 * (`closings.md`, «Corrections of the drawer's book»): con un monto fijo, un gasto más chico que ese tope
 * —el arreglo sortea montos desde Bs 10,00— se rechaza con `409 correction_exceeds` y el acto nunca deja su
 * confirmación. Derivarla del gasto mantiene la corrección parcial, su signo contrario y su tope, siempre.
 */
test('el operador corrige un movimiento con otro del signo contrario', async ({ page, api }) => {
  const branch = await api.as(branchA);
  const motives = await motiveList(branch);
  const motive = motives[0];
  if (motive === undefined) throw new Error('la lista de motivos no ofrece ninguna opción para un gasto');
  const amount = uniqueAmount();
  const part = Math.floor(amount.cents / 2);
  const partWire = wireMoney(part);
  const partTyped = typedMoney(part);
  const note = uniqueNote('Insumos del mostrador');
  // El arreglo: el gasto que la corrección responde, registrado por la misma ruta pública de la pantalla.
  const id = await arrangeGasto(branch, { amount, note, categoryId: motive.id });
  const reason = uniqueNote('El gasto estaba mal cargado');

  await openDrawer(page);
  const original = bookRow(page, id);
  await expect(original).toBeVisible();
  await expect(original.locator('td.cash-motive')).toContainText(note);
  await expect(original.locator('td.cash-amount')).toHaveText(signedText(-amount.cents));

  // El acto: abrir la corrección de esa fila con su botón.
  await original.getByRole('button', { name: `Corregir el movimiento #${id}` }).click();
  const panel = page.getByRole('group', { name: `Corrección del movimiento #${id}` });
  await expect(panel.getByRole('heading', { level: 3 })).toHaveText(`Corregir el movimiento #${id}`);
  await expect(panel).toContainText(`Gasto · ${moneyText(amount.cents)}`);
  await expect(panel).toContainText(
    `Quedan ${moneyText(amount.cents)} de ${moneyText(amount.cents)} por corregir.`);
  await expect(panel).toContainText('El movimiento original no se edita');

  // El acto: el monto parcial, su motivo y la confirmación.
  await panel.getByLabel('Monto de la corrección').fill(partTyped);
  await panel.getByLabel('Motivo de la corrección').fill(reason);
  await panel.getByRole('button', { name: 'Registrar corrección' }).click();
  await expect(drawerForm(page).getByRole('status').filter({ hasText: 'Corrección registrada' }))
    .toHaveText(`Corrección registrada para el movimiento #${id}.`);
  // La confirmación es lo único que cierra el panel: si el servidor hubiera rechazado la corrección
  // (por ejemplo `correction_exceeds`), el panel seguiría abierto con su alerta y nada se habría escrito.
  await expect(panel).toHaveCount(0);

  // La fila nueva del libro: se llama corrección, dice a quién responde y suma lo que el gasto sacó.
  const correction = page.locator('tr[data-movement-id]').filter({ hasText: reason });
  await expect(correction).toHaveCount(1);
  const correctionID = await rowMovementId(correction);
  expect(correctionID).not.toBe(id);
  await expect(correction.locator('.cash-kind')).toHaveText('Corrección');
  await expect(correction.locator('td.cash-motive')).toContainText(`Corrige el movimiento #${id}`);
  await expect(correction.locator('td.cash-amount')).toHaveText(signedText(part));

  // La corrección no se corrige: su botón está deshabilitado y la fila dice por qué.
  const fix = correction.getByRole('button', { name: `Corregir el movimiento #${correctionID}` });
  await expect(fix).toBeDisabled();
  await expect(fix).toHaveAttribute('title', 'Las correcciones no se corrigen.');
  await expect(correction.locator('.cash-reason')).toHaveText('Las correcciones no se corrigen.');

  // Lo persistido: la corrección con su objetivo y su dirección, y el original sin tocar.
  const persisted = await bookMovement(branch, correctionID);
  expect(persisted.kind).toBe('correccion');
  expect(persisted.effect_kind).toBe('gasto');
  expect(persisted.amount).toBe(partWire);
  expect(persisted.effective).toBe(partWire);
  expect(persisted.corrects_id).toBe(id);
  expect(persisted.description).toBe(reason);
  expect(persisted.category_id).toBeNull();
  const untouched = await bookMovement(branch, id);
  expect(untouched.amount).toBe(amount.wire);
  expect(untouched.description).toBe(note);
  await expect(original.locator('td.cash-amount')).toHaveText(signedText(-amount.cents));

  // El tope: la fila ofrece corregir sólo lo que todavía falta, y no el monto original otra vez.
  await original.getByRole('button', { name: `Corregir el movimiento #${id}` }).click();
  await expect(panel).toContainText(
    `Quedan ${moneyText(amount.cents - part)} de ${moneyText(amount.cents)} por corregir.`);
  await panel.getByRole('button', { name: 'Cancelar' }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Registrar gasto' })).toBeVisible();

  // La banda muestra el libro del contrato, que ya cuenta la corrección.
  const book = await readBook(branch);
  await expect(bandValue(page, 'Neto del libro')).toHaveText(signedText(centsOf(book.effective)));
  await expect(bandValue(page, 'Esperado en el cajón')).toHaveText(moneyText(centsOf(book.expected)));
});
