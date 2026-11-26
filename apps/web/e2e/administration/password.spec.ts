import {
  branchAId, branchAName, createAccount, deleteAccount, expect, findAccount, origin, signIn, test,
  uniqueTag, uniqueUsername, warehouseRole, warehouseSessionState,
} from './harness';

/**
 * S2 · «Mi contraseña»: una cuenta cambiando su propia contraseña, en el navegador.
 *
 * La pantalla tiene dos caras del mismo acto. La primera es la que ve quien ingresa con una contraseña
 * temporal: no opera nada hasta cambiarla, así que la pantalla se le impone y no ofrece la navegación
 * del producto. La segunda es la del operador que ya tiene contraseña propia y decide cambiarla: para
 * eso necesita conocer la actual, y si no la conoce el servidor rechaza el intento sin tocar la cuenta.
 * En los dos casos el cambio cierra todas las sesiones de la cuenta, y la contraseña nueva es la única
 * que vuelve a abrirla.
 *
 * La cuenta es propia de la corrida: cambiar la contraseña de `bot_sucursal_a`, `bot_sucursal_b` o
 * `bot_almacen` dejaría sin sesión a las demás suites que corren contra la misma base (S4). Esa cuenta
 * se retira al final por el contrato público.
 */

test.use({ storageState: warehouseSessionState });

test('una cuenta cambia su propia contraseña y la anterior deja de servir', async ({ page, api, browser }) => {
  const warehouse = await api.as(warehouseRole);
  const tag = uniqueTag();
  const username = uniqueUsername(tag);
  const temporary = `Temporal.${tag}.Uno`;
  const first = `Personal.${tag}.Dos`;
  const second = `Personal.${tag}.Tres`;
  const account = await createAccount(warehouse, {
    username, display_name: `Operador ${tag}`, location_id: branchAId, temporary_password: temporary,
  });

  const context = await browser.newContext({ baseURL: origin, storageState: { cookies: [], origins: [] } });
  const personal = await context.newPage();

  // Quien ingresa con una temporal no opera hasta cambiarla: la pantalla se impone y lo dice.
  await signIn(personal, username, temporary);
  await expect(personal.getByRole('heading', { name: 'Creá tu contraseña personal' })).toBeVisible();
  await expect(personal.getByText('Ingresaste con una contraseña temporal. '
    + 'Cambiala antes de acceder al sistema.')).toBeVisible();
  await expect(personal.getByText('El cambio cierra todas tus sesiones.')).toBeVisible();
  // La pantalla forzada no ofrece la navegación del producto.
  await expect(personal.getByRole('button', { name: 'Mi contraseña' })).toHaveCount(0);
  await expect(personal.getByRole('heading', { name: 'Inventario', exact: true })).toHaveCount(0);

  // La misma contraseña no es una nueva, y las dos escrituras de la nueva tienen que coincidir.
  await personal.getByLabel('Contraseña actual', { exact: true }).fill(temporary);
  await personal.getByLabel('Nueva contraseña', { exact: true }).fill(temporary);
  await personal.getByLabel('Confirmar nueva contraseña', { exact: true }).fill(temporary);
  await personal.getByRole('button', { name: 'Guardar contraseña' }).click();
  await expect(personal.getByRole('alert'))
    .toHaveText('Usá contraseñas diferentes de 12 a 128 bytes UTF-8, sin NUL.');

  await personal.getByLabel('Nueva contraseña', { exact: true }).fill(first);
  await personal.getByLabel('Confirmar nueva contraseña', { exact: true }).fill(`${first}.otra`);
  await personal.getByRole('button', { name: 'Guardar contraseña' }).click();
  await expect(personal.getByRole('alert')).toHaveText('Las contraseñas no coinciden.');

  // El acto: la temporal se cambia por la contraseña personal y el cambio cierra la sesión.
  await personal.getByLabel('Contraseña actual', { exact: true }).fill(temporary);
  await personal.getByLabel('Nueva contraseña', { exact: true }).fill(first);
  await personal.getByLabel('Confirmar nueva contraseña', { exact: true }).fill(first);
  await personal.getByRole('button', { name: 'Guardar contraseña' }).click();
  await expect(personal.getByRole('status').filter({ hasText: 'Contraseña actualizada' }))
    .toHaveText('Contraseña actualizada. Iniciá sesión nuevamente.');
  await expect(personal.getByRole('heading', { name: 'Iniciar sesión' })).toBeVisible();

  // Con su contraseña propia la cuenta ya opera, y «Mi contraseña» está en su navegación.
  await signIn(personal, username, first);
  await expect(personal.getByText(`Ubicación asignada: ${branchAName}`)).toBeVisible();
  const nav = personal.getByRole('button', { name: 'Mi contraseña' });
  await expect(nav).toBeEnabled();
  await nav.click();

  await expect(personal.getByRole('heading', { name: 'Cambiar mi contraseña' })).toBeVisible();
  await expect(nav).toHaveAttribute('aria-current', 'page');
  await expect(personal.getByText('Luson Mi contraseña')).toBeVisible();
  expect(new URL(personal.url()).hash).toBe('#/mi-contrasena');
  await expect(personal.getByText('Para cambiarla necesitás conocer la actual.')).toBeVisible();

  // La contraseña actual equivocada se rechaza: la cuenta no cambia y la sesión sigue siendo la misma.
  await personal.getByLabel('Contraseña actual', { exact: true }).fill(`Equivocada.${tag}.Cuatro`);
  await personal.getByLabel('Nueva contraseña', { exact: true }).fill(second);
  await personal.getByLabel('Confirmar nueva contraseña', { exact: true }).fill(second);
  await personal.getByRole('button', { name: 'Guardar contraseña' }).click();
  await expect(personal.getByRole('alert')).toHaveText('La contraseña actual es incorrecta.');
  await expect(personal.getByRole('heading', { name: 'Cambiar mi contraseña' })).toBeVisible();
  // El intento rechazado dejó los campos vacíos y no cerró la sesión: la cuenta sigue adentro.
  await expect(personal.getByLabel('Contraseña actual', { exact: true })).toHaveValue('');
  await expect(personal.getByLabel('Nueva contraseña', { exact: true })).toHaveValue('');
  expect(new URL(personal.url()).hash).toBe('#/mi-contrasena');

  // El cambio real, con la actual y la nueva que el operador decide.
  await personal.getByLabel('Contraseña actual', { exact: true }).fill(first);
  await personal.getByLabel('Nueva contraseña', { exact: true }).fill(second);
  await personal.getByLabel('Confirmar nueva contraseña', { exact: true }).fill(second);
  await personal.getByRole('button', { name: 'Guardar contraseña' }).click();
  await expect(personal.getByRole('status').filter({ hasText: 'Contraseña actualizada' }))
    .toHaveText('Contraseña actualizada. Iniciá sesión nuevamente.');
  await expect(personal.getByRole('heading', { name: 'Iniciar sesión' })).toBeVisible();

  // La contraseña nueva es la que abre la cuenta: la anterior ya no es la de la persona.
  await signIn(personal, username, second);
  await expect(personal.getByText(`Ubicación asignada: ${branchAName}`)).toBeVisible();
  await expect(personal.getByRole('heading', { name: 'Inventario', exact: true })).toBeVisible();
  await context.close();

  await deleteAccount(warehouse, account.id);
  expect(await findAccount(warehouse, username)).toBeNull();
});
