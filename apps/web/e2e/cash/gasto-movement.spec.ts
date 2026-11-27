import {
  bandValue, bookMovement, branchA, centsOf, drawerForm, expect, moneyText, motiveList, openDrawer,
  readBook, recordGasto, signedText, test, uniqueAmount, uniqueNote,
} from './harness';

/**
 * S2 · el gasto del cajón: el retiro que paga algo de la tienda.
 *
 * Un gasto no escribe un motivo de texto libre: elige uno de la lista cerrada que administra el Almacén y
 * lleva, al lado, una nota opcional (S1, S3). La prueba hace el acto como el operador —entra a la caja,
 * escribe el monto, elige el motivo, agrega la nota y toca el botón— y contrasta lo que la fila nueva
 * afirma con el libro que el contrato publica, que guarda el motivo, la copia de la etiqueta con la que se
 * registró y el efecto firmado que movió el cajón (`closings.md`, «The operational drawer»).
 */

test('el operador registra un gasto con su motivo y el libro lo firma', async ({ page, api }) => {
  const branch = await api.as(branchA);
  const motives = await motiveList(branch);
  const motive = motives.find(candidate => candidate.label === 'Limpieza') ?? motives[0];
  if (motive === undefined) throw new Error('la lista de motivos no ofrece ninguna opción para un gasto');
  const amount = uniqueAmount();
  const note = uniqueNote('Detergente');

  await openDrawer(page);
  const form = drawerForm(page);

  // El tipo por defecto es el gasto y su motivo es una opción de la lista: la pantalla no ofrece texto libre.
  await expect(form.getByRole('button', { name: 'Gasto', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(form.getByLabel('Motivo', { exact: true }).locator('option'))
    .toHaveText(['Elegí un motivo…', ...motives.map(option => option.label)]);

  // El acto.
  const recorded = await recordGasto(page, { amount, note, motive });

  // La fila nueva: el tipo, el motivo con su nota al lado, el monto con el signo que lo saca del cajón.
  const row = recorded.row;
  await expect(row.locator('.cash-kind')).toHaveText('Gasto');
  await expect(row.locator('td.cash-motive')).toContainText(motive.label);
  await expect(row.locator('td.cash-motive')).toContainText(note);
  await expect(row.locator('td.cash-amount')).toHaveText(signedText(-amount.cents));

  // El formulario queda vacío, listo para el movimiento siguiente.
  await expect(form.getByLabel('Monto en bolivianos')).toHaveValue('');
  await expect(form.getByLabel('Motivo', { exact: true })).toHaveValue('');
  await expect(form.getByLabel('Nota (opcional)')).toHaveValue('');

  // Lo persistido, leído por el libro del contrato: el motivo, la copia de su etiqueta y el efecto firmado.
  const persisted = await bookMovement(branch, recorded.id);
  expect(persisted.kind).toBe('gasto');
  expect(persisted.effect_kind).toBe('gasto');
  expect(persisted.amount).toBe(amount.wire);
  expect(persisted.effective).toBe(`-${amount.wire}`);
  expect(persisted.description).toBe(note);
  expect(persisted.category_id).toBe(motive.id);
  expect(persisted.category_label).toBe(motive.label);
  expect(persisted.corrects_id).toBeNull();
  expect(persisted.evidence).toBeNull();

  // La fila firma con el autor y el momento que el servidor guardó, no con los que la pantalla supone.
  await expect(row.locator('td.cash-author')).toHaveText(`Cuenta #${persisted.created_by_account_id}`);
  await expect(row.locator('time')).toHaveAttribute('datetime', persisted.occurred_at);

  // Y el cajón bajó por el gasto: la banda muestra el libro que el contrato lee en este momento.
  const book = await readBook(branch);
  await expect(bandValue(page, 'Neto del libro')).toHaveText(signedText(centsOf(book.effective)));
  await expect(bandValue(page, 'Esperado en el cajón')).toHaveText(moneyText(centsOf(book.expected)));
});
