import {
  accountByUsername, accountEditor, accountRow, branchAId, createAccount, expect, findAccount,
  openAdministration, searchAccounts, test, uniqueTag, uniqueUsername, warehouseRole, warehouseSessionState,
} from './harness';

/**
 * S2 · la baja de una cuenta personal, recorrida en el navegador.
 *
 * Eliminar es distinto de desactivar: cierra el acceso para siempre y oculta la cuenta del directorio,
 * conservando su historial. La pantalla lo dice en la confirmación y pide un segundo toque; cancelar no
 * envía nada. El efecto observable es la fila que deja de publicarse y la lectura del directorio, que es
 * la misma que la pantalla hace.
 *
 * La cuenta eliminada es la que esta corrida creó, nunca una de la semilla: el resto de las suites
 * opera con `bot_almacen`, `bot_sucursal_a` y `bot_sucursal_b` contra la misma base (S4).
 */

test.use({ storageState: warehouseSessionState });

test('el Almacén elimina un usuario del directorio y la fila deja de publicarse', async ({ page, api }) => {
  const warehouse = await api.as(warehouseRole);
  const tag = uniqueTag();
  const username = uniqueUsername(tag);
  const displayName = `Operador ${tag}`;
  const account = await createAccount(warehouse, {
    username, display_name: displayName, location_id: branchAId, temporary_password: `Temporal.${tag}.Uno`,
  });

  await openAdministration(page);
  await searchAccounts(page, username);
  const row = accountRow(page, username);
  await expect(row).toHaveCount(1);
  await row.getByRole('button', { name: `Gestionar ${username}`, exact: true }).click();

  const panel = accountEditor(page);
  await panel.getByRole('button', { name: 'Eliminar usuario', exact: true }).click();
  await expect(panel.getByText(`Eliminar a ${username} cierra su acceso y lo oculta del directorio.`)).toBeVisible();
  await expect(panel.getByText('Se conserva su historial; no es una desactivación temporal.')).toBeVisible();

  // Cancelar no elimina nada: ni la fila ni la cuenta del servidor cambian.
  await panel.getByRole('button', { name: 'Cancelar', exact: true }).click();
  expect(await findAccount(warehouse, username)).not.toBeNull();
  await expect(accountRow(page, username)).toHaveCount(1);

  // Confirmar la eliminación sí: la fila deja de publicarse y la cuenta sale del directorio.
  await panel.getByRole('button', { name: 'Eliminar usuario', exact: true }).click();
  await panel.getByRole('button', { name: 'Confirmar eliminación', exact: true }).click();

  await expect(accountEditor(page)).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'Usuario eliminado' }))
    .toHaveText('Usuario eliminado del directorio. Se conserva su historial.');
  await expect(accountRow(page, username)).toHaveCount(0);
  await expect(page.getByText('No hay cuentas para estos filtros.')).toBeVisible();
  expect(await findAccount(warehouse, username)).toBeNull();

  // El resto del directorio sigue publicado: la baja alcanzó a la cuenta propia y a ninguna otra.
  const others = await accountByUsername(warehouse, 'bot_sucursal_a');
  expect(others.enabled).toBe(true);
  expect(account.id).not.toBe(others.id);
});
