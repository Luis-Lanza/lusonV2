import {
  branchA, drawerForm, expect, movementsOfAmount, movementsSaying, motiveList, openDrawer, test,
  uniqueAmount, uniqueNote,
} from './harness';

/**
 * S2 · lo que la pantalla del cajón no deja escribir.
 *
 * Antes de mandar nada, el formulario juzga lo que le falta al movimiento: un gasto no se registra sin un
 * motivo de la lista cerrada (S1, S3), un aporte no se registra sin decir qué es (S4), y una foto que no es
 * una imagen no viaja junto al gasto (S1, S6). En los tres casos la pantalla dice qué falta, conserva lo
 * que el operador escribió y no escribe nada: la prueba lo afirma con la lectura del libro del contrato,
 * que es la que la pantalla hace, y no con la ausencia de un mensaje.
 */

test('un gasto sin motivo no se registra y el formulario dice qué falta', async ({ page, api }) => {
  const branch = await api.as(branchA);
  const amount = uniqueAmount();
  const note = uniqueNote('Gasto sin motivo');

  await openDrawer(page);
  const form = drawerForm(page);
  await form.getByLabel('Monto en bolivianos').fill(amount.typed);
  await form.getByLabel('Nota (opcional)').fill(note);
  await expect(form.getByLabel('Motivo', { exact: true })).toHaveValue('');

  await form.getByRole('button', { name: 'Registrar gasto' }).click();

  // El rechazo tiene las palabras del motivo y deja el formulario donde el operador lo dejó.
  await expect(form.getByRole('alert')).toHaveText('Elegí un motivo de la lista: un gasto sin motivo no se registra.');
  await expect(form.getByLabel('Monto en bolivianos')).toHaveValue(amount.typed);
  await expect(form.getByLabel('Motivo', { exact: true })).toHaveValue('');
  await expect(form.getByRole('status')).toHaveCount(0);

  // Y no se escribió nada: el libro no tiene ninguna fila con esa nota.
  expect(await movementsSaying(branch, note)).toHaveLength(0);
});

test('un aporte sin motivo no se registra y el formulario dice qué falta', async ({ page, api }) => {
  const branch = await api.as(branchA);
  const amount = uniqueAmount();

  await openDrawer(page);
  const form = drawerForm(page);
  await form.getByRole('button', { name: 'Aporte', exact: true }).click();
  await form.getByLabel('Monto en bolivianos').fill(amount.typed);
  await expect(form.getByLabel('Motivo', { exact: true })).toHaveValue('');

  await form.getByRole('button', { name: 'Registrar aporte' }).click();

  await expect(form.getByRole('alert')).toHaveText('Escribí el motivo del movimiento.');
  await expect(form.getByLabel('Monto en bolivianos')).toHaveValue(amount.typed);
  await expect(form.getByRole('status')).toHaveCount(0);

  // Ningún movimiento del período declara ese monto: el aporte no se registró.
  expect(await movementsOfAmount(branch, amount.wire)).toHaveLength(0);
});

test('un archivo que no es una foto no viaja con el gasto', async ({ page, api }) => {
  const branch = await api.as(branchA);
  const motives = await motiveList(branch);
  const motive = motives[0];
  if (motive === undefined) throw new Error('la lista de motivos no ofrece ninguna opción para un gasto');
  const amount = uniqueAmount();
  const note = uniqueNote('Gasto con comprobante ilegible');
  const file = { name: 'comprobante.txt', mimeType: 'text/plain', buffer: Buffer.from('no soy una foto') };

  await openDrawer(page);
  const form = drawerForm(page);

  // El acto: elegir un archivo que no es una imagen. La pantalla lo juzga en el acto y lo dice.
  await form.getByLabel('Comprobante (opcional)').setInputFiles(file);
  await expect(form.getByRole('alert')).toHaveText(
    'El comprobante tiene que ser una foto JPEG o PNG. Ese archivo no es una imagen de las que se aceptan.');
  // El archivo sigue en la tarjeta, con su nombre y su tamaño, para que el operador vea qué se rechazó.
  await expect(form.locator('.cash-evidence-name')).toHaveText(file.name);
  await expect(form.locator('.cash-evidence-size')).toHaveText(`${file.buffer.length} B`);
  await expect(form.getByRole('img', { name: 'Vista previa del comprobante' })).toHaveCount(0);

  // Un movimiento completo no sale con ese comprobante: el gasto espera a que el archivo se cambie.
  await form.getByLabel('Monto en bolivianos').fill(amount.typed);
  await form.getByLabel('Motivo', { exact: true }).selectOption({ label: motive.label });
  await form.getByLabel('Nota (opcional)').fill(note);
  await form.getByRole('button', { name: 'Registrar gasto' }).click();
  await expect(form.getByRole('status')).toHaveCount(0);
  await expect(form.getByRole('alert')).toHaveText(
    'El comprobante tiene que ser una foto JPEG o PNG. Ese archivo no es una imagen de las que se aceptan.');
  expect(await movementsSaying(branch, note)).toHaveLength(0);
});
