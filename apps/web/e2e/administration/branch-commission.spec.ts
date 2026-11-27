import {
  branchCard, commissionOf, createBranch, deleteBranch, expect, openBranchesPanel, test, uniqueTag,
  warehouseRole, warehouseSessionState,
} from './harness';

/**
 * S2 · la comisión de una sucursal, configurada desde el panel del Almacén en el navegador.
 *
 * La comisión es el porcentaje que la rendición de esa sucursal paga sobre sus ventas del período, y la
 * fija sólo el Almacén. Sin tasa la sucursal no puede proponer su rendición, y la pantalla lo dice en la
 * tarjeta. La tarjeta publica la tasa, la cuenta que la fijó y el momento en que lo hizo: un parámetro
 * de plata nunca se muestra anónimo.
 *
 * La sucursal es propia de la corrida —se crea por el contrato público con sus dos cajones en cero y se
 * retira al final—: la comisión que se escribe acá no altera la rendición de ninguna sucursal que ya
 * exista ni la de las demás suites (S4).
 */

test.use({ storageState: warehouseSessionState });

test('el Almacén configura y corrige la comisión de una sucursal y la tarjeta la publica', async ({ page, api }) => {
  const warehouse = await api.as(warehouseRole);
  const tag = uniqueTag();
  const name = `Sucursal ${tag}`;
  const branch = await createBranch(warehouse, { name, opening_cash: '0.00', purchase_fund: '0.00' });

  await openBranchesPanel(page);
  const card = branchCard(page, name);
  await expect(card).toHaveCount(1);
  // Sin tasa configurada la sucursal no puede proponer su rendición, y la tarjeta lo dice.
  await expect(card.getByText('Sin configurar', { exact: true })).toBeVisible();

  // Cancelar el formulario no escribe nada.
  await card.getByRole('button', { name: 'Configurar comisión' }).click();
  await expect(card.getByLabel('Porcentaje de comisión')).toHaveValue('');
  await card.getByRole('button', { name: 'Cancelar', exact: true }).click();
  await expect(card.getByLabel('Porcentaje de comisión')).toHaveCount(0);
  expect(await commissionOf(warehouse, branch.id)).toBeNull();

  // El acto: la tasa se escribe como el operador la dice, con coma y un decimal.
  await card.getByRole('button', { name: 'Configurar comisión' }).click();
  await card.getByLabel('Porcentaje de comisión').fill('12,5');
  await card.getByRole('button', { name: 'Guardar comisión' }).click();

  await expect(page.getByRole('status').filter({ hasText: 'Comisión actualizada' }))
    .toHaveText('Comisión actualizada: rige para la próxima rendición que se proponga.');
  // La tarjeta publica la tasa canónica, la cuenta que la fijó y el momento del acto.
  await expect(card).toContainText('12,50 %');
  await expect(card.getByText(/\d{2}\/\d{2}\/\d{4},? \d{2}:\d{2}/)).toBeVisible();
  await expect(card.getByText('Sin configurar', { exact: true })).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Cambiar comisión' })).toBeVisible();

  const configured = await commissionOf(warehouse, branch.id);
  if (configured === null) throw new Error(`la sucursal ${branch.id} no publica su comisión`);
  expect(configured.commission_rate_percent).toBe('12.50');
  expect(configured.updated_by).toBe('');
  expect(Number.isNaN(Date.parse(configured.updated_at))).toBe(false);

  // Un porcentaje que el servidor no admitiría se rechaza antes del envío y no pisa la tasa vigente.
  await card.getByRole('button', { name: 'Cambiar comisión' }).click();
  await card.getByLabel('Porcentaje de comisión').fill('100,01');
  await card.getByRole('button', { name: 'Guardar comisión' }).click();
  await expect(page.getByRole('alert'))
    .toContainText('Ingresá un porcentaje entre 0 y 100, con hasta dos decimales.');
  expect((await commissionOf(warehouse, branch.id))?.commission_rate_percent).toBe('12.50');

  // Corregir la tasa reemplaza la anterior: la tarjeta y el contrato publican la nueva.
  await card.getByLabel('Porcentaje de comisión').fill('5');
  await card.getByRole('button', { name: 'Guardar comisión' }).click();
  await expect(card).toContainText('5,00 %');
  expect((await commissionOf(warehouse, branch.id))?.commission_rate_percent).toBe('5.00');

  // La sucursal es de esta corrida: se retira por el contrato y su tasa deja de publicarse.
  await deleteBranch(warehouse, branch.id);
  expect(await commissionOf(warehouse, branch.id)).toBeNull();
});
