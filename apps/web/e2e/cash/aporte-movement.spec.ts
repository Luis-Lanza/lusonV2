import {
  bandValue, bookMovement, branchA, centsOf, drawerForm, expect, moneyText, openDrawer, readBook,
  recordAporte, signedText, test, uniqueAmount, uniqueNote,
} from './harness';

/**
 * S2 · el aporte del cajón: el efectivo que entra al mostrador para trabajar.
 *
 * Un aporte no lleva motivo de la lista cerrada: escribe qué es en texto libre, y la pantalla lo dice al
 * cambiar de tipo —el selector de motivos y el comprobante desaparecen, y el motivo vuelve a ser una nota—
 * (S4). El acto es el del operador: elige el tipo, escribe el monto y el motivo, y toca el botón. Lo
 * persistido se contrasta con el libro que el contrato publica: dirección `aporte`, sin motivo y con el
 * efectivo sumando al cajón (`closings.md`, «The operational drawer»).
 */

test('el operador registra un aporte de efectivo y el cajón lo recibe', async ({ page, api }) => {
  const branch = await api.as(branchA);
  const amount = uniqueAmount();
  const reason = uniqueNote('Cambio para el cajón');

  await openDrawer(page);
  const form = drawerForm(page);

  // El acto empieza eligiendo el tipo: sólo un gasto lleva motivo de la lista y comprobante (S2, S4).
  await form.getByRole('button', { name: 'Aporte', exact: true }).click();
  await expect(form.getByRole('button', { name: 'Aporte', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(form.locator('#cash-category')).toHaveCount(0);
  await expect(form.locator('#cash-evidence')).toHaveCount(0);
  // El motivo de un aporte es una nota de texto libre, y sigue siendo obligatorio.
  await expect(form.getByLabel('Motivo', { exact: true })).toBeEditable();

  // El acto.
  const recorded = await recordAporte(page, { amount, reason });

  // La fila nueva: el tipo, el motivo escrito, el monto con el signo que entra al cajón.
  const row = recorded.row;
  await expect(row.locator('.cash-kind')).toHaveText('Aporte');
  await expect(row.locator('td.cash-motive')).toHaveText(reason);
  await expect(row.locator('td.cash-amount')).toHaveText(signedText(amount.cents));

  // El tipo elegido se queda para el movimiento siguiente; lo escrito se va.
  await expect(form.getByRole('button', { name: 'Aporte', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(form.getByLabel('Monto en bolivianos')).toHaveValue('');
  await expect(form.getByLabel('Motivo', { exact: true })).toHaveValue('');

  // Lo persistido: una dirección que suma, sin motivo de la lista y con el efectivo que entró.
  const persisted = await bookMovement(branch, recorded.id);
  expect(persisted.kind).toBe('aporte');
  expect(persisted.effect_kind).toBe('aporte');
  expect(persisted.amount).toBe(amount.wire);
  // El contrato publica el efectivo con el signo de la dirección: sin signo cuando suma.
  expect(persisted.effective).toBe(amount.wire);
  expect(persisted.description).toBe(reason);
  expect(persisted.category_id).toBeNull();
  expect(persisted.category_label).toBeNull();
  expect(persisted.corrects_id).toBeNull();
  expect(persisted.evidence).toBeNull();

  // La fila firma con el autor y el momento del servidor.
  await expect(row.locator('td.cash-author')).toHaveText(`Cuenta #${persisted.created_by_account_id}`);
  await expect(row.locator('time')).toHaveAttribute('datetime', persisted.occurred_at);

  // La banda muestra el libro del contrato, que ya cuenta el aporte.
  const book = await readBook(branch);
  await expect(bandValue(page, 'Neto del libro')).toHaveText(signedText(centsOf(book.effective)));
  await expect(bandValue(page, 'Esperado en el cajón')).toHaveText(moneyText(centsOf(book.expected)));
});
