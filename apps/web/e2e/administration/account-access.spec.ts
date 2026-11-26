import {
  accountByUsername, accountEditor, accountRow, branchAId, createAccount, deleteAccount, expect, findAccount,
  openAdministration, origin, searchAccounts, signIn, test, uniqueTag, uniqueUsername, warehouseRole,
  warehouseSessionState,
} from './harness';

/**
 * S2 · el acceso de una cuenta, habilitado y deshabilitado desde el panel del Almacén.
 *
 * Desactivar cierra el acceso sin borrar la cuenta: la fila sigue en el directorio, marcada, y puede
 * reactivarse. La pantalla dice que no es lo mismo que eliminar, y el efecto se ve en el servidor: la
 * sesión que la cuenta tenía abierta deja de valer en cuanto se desactiva, y reactivarla no la revive.
 *
 * La sesión que pierde la cuenta es la de la cuenta propia de esta corrida, abierta con su contraseña
 * temporal: las cuentas de la semilla nunca se desactivan (S4).
 */

test.use({ storageState: warehouseSessionState });

test('el Almacén desactiva un acceso y la cuenta desactivada pierde su sesión', async ({ page, api, browser }) => {
  const warehouse = await api.as(warehouseRole);
  const tag = uniqueTag();
  const username = uniqueUsername(tag);
  const temporary = `Temporal.${tag}.Uno`;
  const account = await createAccount(warehouse, {
    username, display_name: `Operador ${tag}`, location_id: branchAId, temporary_password: temporary,
  });

  // La cuenta entra con su temporal: el acceso está activo y sólo le falta cambiar la contraseña.
  const context = await browser.newContext({ baseURL: origin, storageState: { cookies: [], origins: [] } });
  const personal = await context.newPage();
  await signIn(personal, username, temporary);
  await expect(personal.getByRole('heading', { name: 'Creá tu contraseña personal' })).toBeVisible();

  await openAdministration(page);
  await searchAccounts(page, username);
  await accountRow(page, username).getByRole('button', { name: `Gestionar ${username}`, exact: true }).click();

  const panel = accountEditor(page);
  await expect(panel.getByLabel('Acceso')).toHaveValue('enabled');
  // El acceso es temporal y la pantalla lo separa de la baja definitiva, antes del acto.
  await expect(panel.getByRole('button', { name: 'Eliminar usuario', exact: true })).toBeVisible();

  await panel.getByLabel('Acceso').selectOption('disabled');
  await panel.getByRole('button', { name: 'Guardar cambios' }).click();

  await expect(accountEditor(page)).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'Cuenta actualizada.' })).toBeVisible();
  const row = accountRow(page, username);
  await expect(row.getByText('Desactivado', { exact: true })).toBeVisible();
  await expect(row.getByText('Cambio obligatorio', { exact: true })).toBeVisible();

  // El filtro de estado del directorio es local y encuentra la cuenta desactivada.
  await page.getByLabel('Estado de cuenta').selectOption('disabled');
  await expect(accountRow(page, username)).toHaveCount(1);
  await page.getByLabel('Estado de cuenta').selectOption('enabled');
  await expect(accountRow(page, username)).toHaveCount(0);
  await page.getByLabel('Estado de cuenta').selectOption('all');

  const disabled = await accountByUsername(warehouse, username);
  expect(disabled.enabled).toBe(false);
  // Desactivar no borra la cuenta: sigue en el directorio y conserva su cambio obligatorio.
  expect(disabled.must_change_password).toBe(true);

  // La sesión que la cuenta tenía abierta ya no vale: la cuenta desactivada no opera.
  await personal.reload();
  await expect(personal.getByRole('heading', { name: 'Iniciar sesión' })).toBeVisible();
  await expect(personal.getByLabel('Usuario')).toBeVisible();
  await expect(personal.getByRole('heading', { name: 'Creá tu contraseña personal' })).toHaveCount(0);

  // Reactivarla es un acto aparte, y la pantalla publica el acceso nuevo.
  await accountRow(page, username).getByRole('button', { name: `Gestionar ${username}`, exact: true }).click();
  const reopened = accountEditor(page);
  await expect(reopened.getByLabel('Acceso')).toHaveValue('disabled');
  await reopened.getByLabel('Acceso').selectOption('enabled');
  await reopened.getByRole('button', { name: 'Guardar cambios' }).click();

  await expect(accountEditor(page)).toHaveCount(0);
  await expect(accountRow(page, username).getByText('Activo', { exact: true })).toBeVisible();
  expect((await accountByUsername(warehouse, username)).enabled).toBe(true);
  await context.close();

  await deleteAccount(warehouse, account.id);
  expect(await findAccount(warehouse, username)).toBeNull();
});
