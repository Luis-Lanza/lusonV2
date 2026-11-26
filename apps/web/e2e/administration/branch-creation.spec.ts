import {
  administrationTab, balanceOf, branchBalances, branchByName, branchBook, branchCard, branchCreation,
  expect, findBranch, openBranchesPanel, test, uniqueTag, warehouseRole, warehouseSessionState,
} from './harness';

/**
 * S2 · el alta de una sucursal, recorrida en el navegador.
 *
 * Una sucursal nace con stock cero y con la plata que el Almacén declara: el fondo de caja operativa es
 * el cajón con el que arranca y el fondo de compras es lo que puede gastar en mercadería. Los dos montos
 * son obligatorios, y el panel publica acto seguido los dos saldos que el servidor lee de los libros,
 * más la comisión que todavía no tiene y las cuentas que todavía no se le asignaron.
 *
 * La última mitad del acto es la baja: la sucursal que esta prueba acaba de crear no tiene stock,
 * usuarios ni operaciones pendientes, así que puede retirarse con la confirmación de la pantalla. Sólo
 * se elimina esa: las sucursales que ya existían nunca se tocan (S4).
 */

test.use({ storageState: warehouseSessionState });

test('el Almacén crea una sucursal con su plata, lee sus saldos en cero y la retira', async ({ page, api }) => {
  const warehouse = await api.as(warehouseRole);
  const tag = uniqueTag();
  const name = `Sucursal ${tag}`;

  // La pestaña de sucursales tiene su hash propio y arranca en ella.
  await openBranchesPanel(page);
  await expect(page.getByText('ALMACÉN / ADMINISTRACIÓN')).toBeVisible();
  expect(new URL(page.url()).hash).toBe('#/administracion/sucursales');
  await expect(page.getByRole('button', { name: 'Administración' })).toHaveAttribute('aria-current', 'page');
  await expect(administrationTab(page, 'Sucursales')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('El almacén único es contexto, no una sucursal asignable.')).toBeVisible();

  // Las dos pestañas del panel son dos pantallas: el mismo toque que el operador da para cambiar.
  await administrationTab(page, 'Usuarios').click();
  await expect(page.getByRole('heading', { name: 'Usuarios', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '+ Crear usuario' })).toBeVisible();
  await administrationTab(page, 'Sucursales').click();
  await expect(page.getByRole('heading', { name: 'Crear sucursal', exact: true })).toBeVisible();

  const create = branchCreation(page);
  await expect(create.getByText('Los dos montos son obligatorios. Se declaran en bolivianos, con hasta dos decimales.'))
    .toBeVisible();

  await create.getByLabel('Nombre de sucursal').fill(name);
  await create.getByLabel('Fondo de caja operativa').fill('2500,50');
  await create.getByLabel('Fondo de compras').fill('750');
  await create.getByRole('button', { name: 'Crear sucursal' }).click();

  // La confirmación nombra la sucursal y el estado en que nace.
  await expect(page.getByRole('status').filter({ hasText: 'Sucursal creada' }))
    .toHaveText(`Sucursal creada: ${name}. Stock inicial cero.`);
  // El formulario vuelve vacío: la sucursal creada no se vuelve a enviar.
  await expect(create.getByLabel('Nombre de sucursal')).toHaveValue('');
  await expect(create.getByLabel('Fondo de caja operativa')).toHaveValue('');
  await expect(create.getByLabel('Fondo de compras')).toHaveValue('');

  // La tarjeta nueva publica lo que le falta y los dos saldos con los que nació.
  const card = branchCard(page, name);
  await expect(card).toHaveCount(1);
  await expect(card.getByText('0 cuentas asignadas', { exact: true })).toBeVisible();
  await expect(card.getByText('Sin configurar', { exact: true })).toBeVisible();
  await expect(card.getByText('sin eso la sucursal no puede proponer su rendición')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Cargar fondos' })).toBeVisible();
  const book = branchBook(page, name);
  await expect(book.getByText('Fondo de caja operativa', { exact: true })).toBeVisible();
  await expect(book.getByText('Fondo de compras', { exact: true })).toBeVisible();
  await expect(book.getByText('Bs 2.500,50', { exact: true })).toBeVisible();
  await expect(book.getByText('Bs 750,00', { exact: true })).toBeVisible();

  // Lo persistido, leído por el contrato de la administración: la sucursal y sus dos libros.
  const created = await branchByName(warehouse, name);
  expect(created.id).toBeGreaterThan(1);
  const balance = await balanceOf(warehouse, created.id);
  expect(balance.cash_balance).toBe('2500.50');
  expect(balance.fund_balance).toBe('750.00');
  expect(balance.frozen).toBe(false);

  // La baja: sólo la sucursal propia, y con la confirmación de la pantalla.
  await card.getByRole('button', { name: 'Eliminar sucursal' }).click();
  await expect(page.getByText(`Eliminar ${name} la oculta de las operaciones nuevas. Se conserva su historial.`))
    .toBeVisible();
  await page.getByRole('button', { name: 'Confirmar eliminación', exact: true }).click();

  await expect(page.getByRole('status').filter({ hasText: 'Sucursal eliminada' }))
    .toHaveText('Sucursal eliminada del directorio. Se conserva su historial.');
  await expect(branchCard(page, name)).toHaveCount(0);
  expect(await findBranch(warehouse, name)).toBeNull();
  expect((await branchBalances(warehouse)).some(row => row.branch_id === created.id)).toBe(false);

  // Y las sucursales que ya estaban siguen publicadas: la baja alcanzó a la sucursal propia.
  expect(await findBranch(warehouse, 'Sucursal A')).not.toBeNull();
});
