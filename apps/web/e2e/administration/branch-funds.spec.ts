import {
  balanceOf, branchBook, branchCard, branchBalances, createBranch, deleteBranch, expect, openBranchesPanel,
  test, uniqueTag, warehouseRole, warehouseSessionState,
} from './harness';

/**
 * S2 · la lectura de los saldos de una sucursal y la carga de sus fondos, recorridas en el navegador.
 *
 * Los dos números de la tarjeta son los que el servidor lee de los libros, no una cuenta que la pantalla
 * haga: el fondo de caja operativa es la expectativa del cajón y el fondo de compras es la suma firmada
 * de sus movimientos. Cargar fondos es un acto del Almacén y escribe dos aportes en un solo movimiento
 * de la historia: no se edita lo ya cargado, y lo que se equivocó se corrige con otro movimiento. Los
 * dos montos son obligatorios, y `0,00` es una respuesta dicha: no escribe nada y no es un error.
 *
 * La sucursal que recibe los fondos la crea esta prueba por el contrato público con su propio nombre y
 * sus dos cajones en cero, y la retira al final: las sucursales de la semilla nunca se tocan, y ninguna
 * sucursal con stock u operaciones se modifica (S4).
 */

test.use({ storageState: warehouseSessionState });

test('el Almacén lee los saldos de una sucursal y le carga fondos', async ({ page, api }) => {
  const warehouse = await api.as(warehouseRole);
  const tag = uniqueTag();
  const name = `Sucursal ${tag}`;
  const branch = await createBranch(warehouse, { name, opening_cash: '0.00', purchase_fund: '0.00' });

  await openBranchesPanel(page);
  const card = branchCard(page, name);
  await expect(card).toHaveCount(1);

  // La tarjeta publica los dos libros de la sucursal tal como el servidor los leyó: los dos en cero.
  const book = branchBook(page, name);
  await expect(book.getByText('Fondo de caja operativa', { exact: true })).toBeVisible();
  await expect(book.getByText('Fondo de compras', { exact: true })).toBeVisible();
  await expect(book.getByText('Bs 0,00', { exact: true })).toHaveCount(2);
  await expect(book.getByText('Rendición en curso')).toHaveCount(0);

  await card.getByRole('button', { name: 'Cargar fondos' }).click();
  // Los dos montos son obligatorios y la pantalla dice qué son y qué no se puede hacer con ellos.
  await expect(card.getByLabel('Fondo de caja operativa')).toHaveAttribute('required', '');
  await expect(card.getByLabel('Fondo de compras')).toHaveAttribute('required', '');
  await expect(card.getByText('Los dos montos son obligatorios y se suman como aporte del almacén. '
    + 'Lo ya cargado no se edita: una carga equivocada se corrige con un movimiento.')).toBeVisible();

  // Un monto que no es un importe de esta casa se rechaza antes del envío y no escribe nada.
  await card.getByLabel('Fondo de caja operativa').fill('500,005');
  await card.getByLabel('Fondo de compras').fill('300');
  await card.getByRole('button', { name: 'Confirmar carga' }).click();
  await expect(page.getByRole('alert'))
    .toContainText('Ingresá el fondo de caja operativa en bolivianos, con hasta dos decimales.');
  expect((await balanceOf(warehouse, branch.id)).cash_balance).toBe('0.00');
  expect(await book.getByText('Bs 0,00', { exact: true }).count()).toBe(2);

  // El acto: la carga de las dos cajas, con los montos como el operador los escribe.
  await card.getByLabel('Fondo de caja operativa').fill('1500,50');
  await card.getByLabel('Fondo de compras').fill('250');
  await card.getByRole('button', { name: 'Confirmar carga' }).click();

  await expect(page.getByRole('status').filter({ hasText: 'Fondos cargados' }))
    .toHaveText('Fondos cargados: quedaron asentados como aporte del almacén y la sucursal sigue operando.');
  // El formulario se cierra y la tarjeta publica los dos números nuevos del servidor.
  await expect(card.getByRole('button', { name: 'Cargar fondos' })).toBeVisible();
  await expect(book.getByText('Bs 1.500,50', { exact: true })).toBeVisible();
  await expect(book.getByText('Bs 250,00', { exact: true })).toBeVisible();

  const loaded = await balanceOf(warehouse, branch.id);
  expect(loaded.cash_balance).toBe('1500.50');
  expect(loaded.fund_balance).toBe('250.00');
  // Una carga no congela la sucursal: abre rendición sólo la rendición.
  expect(loaded.frozen).toBe(false);

  // Un 0,00 dicho es una respuesta, no un silencio: la pantalla lo avisa y la carga no escribe nada.
  await card.getByRole('button', { name: 'Cargar fondos' }).click();
  await card.getByLabel('Fondo de caja operativa').fill('0,00');
  await card.getByLabel('Fondo de compras').fill('0,00');
  await expect(card.getByRole('status').filter({ hasText: 'Declaraste 0,00' }))
    .toHaveText('Declaraste 0,00 en las dos cajas: la carga no escribe ningún movimiento.');
  await card.getByRole('button', { name: 'Confirmar carga' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Fondos cargados' })).toBeVisible();

  const unchanged = await balanceOf(warehouse, branch.id);
  expect(unchanged.cash_balance).toBe('1500.50');
  expect(unchanged.fund_balance).toBe('250.00');
  await expect(book.getByText('Bs 1.500,50', { exact: true })).toBeVisible();
  await expect(book.getByText('Bs 250,00', { exact: true })).toBeVisible();

  // La sucursal es de esta corrida: se retira por el contrato, sin tocar ninguna otra.
  await deleteBranch(warehouse, branch.id);
  expect((await branchBalances(warehouse)).some(row => row.branch_id === branch.id)).toBe(false);
});
