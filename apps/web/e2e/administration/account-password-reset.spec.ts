import {
  accountByUsername, accountEditor, accountRow, branchAId, createAccount, deleteAccount, expect,
  findAccount, openAdministration, origin, passwordHandoff, passwordResetForm, searchAccounts, signIn,
  test, uniqueTag, uniqueUsername, warehouseRole, warehouseSessionState,
} from './harness';

/**
 * S2 · el restablecimiento de la contraseña de una cuenta, recorrido en el navegador.
 *
 * El Almacén no puede leer la contraseña de nadie: sólo la reemplaza por una temporal que entrega en
 * privado. El restablecimiento cierra las sesiones de la cuenta y la deja obligada a cambiarla en el
 * próximo ingreso, y no la reactiva si estaba desactivada. Ese es el acto que esta prueba recorre, y su
 * única prueba observable es el ingreso: la temporal anterior deja de abrir la sesión y la nueva abre la
 * pantalla que exige cambiarla.
 *
 * La cuenta es propia de la corrida —se crea por el contrato público con su propia temporal y se retira
 * al final— porque restablecer la contraseña de una cuenta de la semilla rompería las demás suites que
 * corren contra la misma base (S4).
 */

test.use({ storageState: warehouseSessionState });

test('el Almacén restablece la contraseña de una cuenta y la anterior deja de servir', async ({ page, api, browser }) => {
  const warehouse = await api.as(warehouseRole);
  const tag = uniqueTag();
  const username = uniqueUsername(tag);
  const displayName = `Operador ${tag}`;
  const previous = `Temporal.${tag}.Uno`;
  const replaced = `Temporal.${tag}.Dos`;
  const account = await createAccount(warehouse, {
    username, display_name: displayName, location_id: branchAId, temporary_password: previous,
  });

  await openAdministration(page);
  await searchAccounts(page, username);
  await accountRow(page, username).getByRole('button', { name: `Gestionar ${username}`, exact: true }).click();

  const panel = accountEditor(page);
  await expect(panel.getByRole('heading', { name: `Gestionar ${username}` })).toBeVisible();
  // La pantalla dice qué hace el restablecimiento y qué no hace, antes del acto.
  await expect(panel.getByRole('heading', { name: 'Restablecer contraseña', exact: true })).toBeVisible();
  await expect(panel.getByText('No podés consultar la anterior.')).toBeVisible();
  await expect(panel.getByText('no reactiva una cuenta desactivada.')).toBeVisible();

  // Una temporal que no llega al mínimo no se envía.
  const reset = passwordResetForm(page);
  await reset.getByLabel('Contraseña temporal').fill('corta');
  await reset.getByRole('button', { name: 'Restablecer contraseña', exact: true }).click();
  await expect(panel.getByRole('alert')).toHaveText('Ingresá una temporal de 12 a 128 bytes UTF-8, sin NUL.');
  await expect(passwordHandoff(page)).toHaveCount(0);

  await reset.getByLabel('Contraseña temporal').fill(replaced);
  await reset.getByRole('button', { name: 'Restablecer contraseña', exact: true }).click();

  // La entrega privada publica la temporal nueva, y sólo ella.
  const delivery = passwordHandoff(page);
  await expect(delivery.getByLabel('Temporal para entrega')).toHaveValue(replaced);
  await delivery.getByRole('button', { name: 'Mostrar entrega' }).click();
  await expect(delivery.getByLabel('Temporal para entrega')).toHaveAttribute('type', 'text');
  await delivery.getByRole('button', { name: 'Cerrar entrega privada' }).click();
  await expect(passwordHandoff(page)).toHaveCount(0);
  // Ningún campo de la pantalla conserva la temporal entregada.
  expect(await page.locator('input').evaluateAll(
    (inputs, secret) => inputs.map(input => (input as HTMLInputElement).value).includes(secret), replaced))
    .toBe(false);

  // La cuenta sigue habilitada y vuelve a exigir el cambio: el restablecimiento no la reactiva ni la
  // desactiva.
  const afterReset = await accountByUsername(warehouse, username);
  expect(afterReset.enabled).toBe(true);
  expect(afterReset.must_change_password).toBe(true);

  // La prueba de lo que el servidor guardó es el ingreso: la temporal anterior ya no abre la sesión.
  const context = await browser.newContext({ baseURL: origin, storageState: { cookies: [], origins: [] } });
  const personal = await context.newPage();
  await signIn(personal, username, previous);
  await expect(personal.getByRole('alert')).toHaveText('Usuario o contraseña incorrectos.');
  await expect(personal.getByRole('heading', { name: 'Iniciar sesión' })).toBeVisible();

  // Y la nueva abre sólo la pantalla que obliga a cambiarla: la cuenta no opera todavía.
  await signIn(personal, username, replaced);
  await expect(personal.getByRole('heading', { name: 'Creá tu contraseña personal' })).toBeVisible();
  await expect(personal.getByRole('heading', { name: 'Inventario', exact: true })).toHaveCount(0);
  await context.close();

  await deleteAccount(warehouse, account.id);
  expect(await findAccount(warehouse, username)).toBeNull();
});
