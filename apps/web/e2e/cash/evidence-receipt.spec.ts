import { createHash } from 'node:crypto';
import {
  bandValue, bookMovement, branchA, centsOf, drawerForm, expect, moneyText, motiveList, openDrawer,
  readBook, receiptPhoto, rowMovementId, rowSaying, signedText, test, uniqueAmount, uniqueNote,
} from './harness';

/**
 * S2 · el comprobante del gasto: la foto del ticket que el operador adjunta al pago.
 *
 * Un gasto puede llevar una sola foto, y la pantalla la juzga antes de mandar nada: la muestra como vista
 * previa, con su nombre y su tamaño, y el movimiento se escribe con ella o no se escribe (S1, S6). La
 * prueba adjunta una imagen PNG real, registra el gasto y contrasta las tres cosas que el contrato publica
 * del comprobante —el tipo que el servidor validó, su tamaño y su SHA-256— y los bytes que sirve su propia
 * ruta (`GET /api/closings/cash-movements/{id}/evidence`, `closings.md`), que es la que la fila abre.
 */

test('el operador adjunta el comprobante del gasto y el libro lo publica', async ({ page, api }) => {
  const branch = await api.as(branchA);
  const motives = await motiveList(branch);
  const motive = motives.find(candidate => candidate.label === 'Limpieza') ?? motives[0];
  if (motive === undefined) throw new Error('la lista de motivos no ofrece ninguna opción para un gasto');
  const amount = uniqueAmount();
  const note = uniqueNote('Flete con comprobante');
  const sizeText = `${receiptPhoto.buffer.length} B`;
  const digest = createHash('sha256').update(receiptPhoto.buffer).digest('hex');

  await openDrawer(page);
  const form = drawerForm(page);
  await form.getByLabel('Monto en bolivianos').fill(amount.typed);
  await form.getByLabel('Motivo', { exact: true }).selectOption({ label: motive.label });
  await form.getByLabel('Nota (opcional)').fill(note);

  // El acto: elegir la foto. La pantalla la juzga en el acto y la muestra antes de que nada se envíe.
  await form.getByLabel('Comprobante (opcional)').setInputFiles(receiptPhoto);
  await expect(form.getByRole('img', { name: 'Vista previa del comprobante' })).toBeVisible();
  await expect(form.locator('.cash-evidence-name')).toHaveText(receiptPhoto.name);
  await expect(form.locator('.cash-evidence-size')).toHaveText(sizeText);
  await expect(form.getByRole('alert')).toHaveCount(0);

  await form.getByRole('button', { name: 'Registrar gasto' }).click();
  await expect(form.getByRole('status').filter({ hasText: 'Gasto registrado' }))
    .toHaveText('Gasto registrado en el libro de la caja.');

  // La fila nueva abre el comprobante y anuncia qué es: su tipo y su tamaño, nunca su contenido (S7).
  const row = rowSaying(page, note);
  await expect(row).toHaveCount(1);
  const id = await rowMovementId(row);
  const link = row.getByRole('link', { name: `Ver el comprobante del movimiento #${id}` });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('title', `Comprobante PNG · ${sizeText}`);
  await expect(link).toHaveAttribute('href', `/api/closings/cash-movements/${id}/evidence`);
  // El gasto, además, es el del registro: el tipo y el monto firmado siguen siendo los del acto.
  await expect(row.locator('.cash-kind')).toHaveText('Gasto');
  await expect(row.locator('td.cash-amount')).toHaveText(signedText(-amount.cents));

  // Lo persistido: el comprobante con el tipo que el servidor validó, su tamaño y el digest de esos bytes.
  const persisted = await bookMovement(branch, id);
  expect(persisted.kind).toBe('gasto');
  expect(persisted.category_id).toBe(motive.id);
  expect(persisted.description).toBe(note);
  expect(persisted.evidence).toEqual({
    type: 'image/png', size: receiptPhoto.buffer.length, sha256: digest,
  });

  // Y los bytes, servidos por la ruta que la fila abre: los mismos que el operador adjuntó.
  const served = await branch.request.get(`/api/closings/cash-movements/${id}/evidence`);
  expect(served.status()).toBe(200);
  expect(served.headers()['content-type']).toBe('image/png');
  expect(served.headers()['cache-control']).toBe('no-store');
  const bytes = await served.body();
  expect(bytes.equals(receiptPhoto.buffer)).toBe(true);
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(persisted.evidence?.sha256);

  // La banda sigue el libro del contrato, que ya cuenta el gasto con su comprobante.
  const book = await readBook(branch);
  await expect(bandValue(page, 'Esperado en el cajón')).toHaveText(moneyText(centsOf(book.expected)));
});
