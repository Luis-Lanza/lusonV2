import {
  accountByUsername, accountCreation, accountRow, branchAId, branchAName, expect, findAccount,
  openAdministration, passwordHandoff, searchAccounts, test, uniqueTag, uniqueUsername, warehouseRole,
  warehouseSessionState,
} from './harness';
import { deleteAccount } from './harness';

/**
 * S2 · el alta de una cuenta de sucursal, recorrida en el navegador.
 *
 * El Almacén es el único que crea cuentas, y sólo de sucursal: el almacén no se crea ni se asigna. El
 * acto tiene dos mitades que la pantalla separa a propósito —el alta y la entrega privada de la
 * contraseña temporal—, porque la temporal se dice una sola vez y no se puede recuperar después. La
 * cuenta nace activa y con cambio obligatorio: la persona la cambia antes de operar.
 *
 * Lo que el acto no ejercita —la baja de la cuenta que esta prueba creó— se hace por el contrato
 * público para no dejar cuentas propias acumuladas en la base; la baja por pantalla tiene su propia
 * prueba. El usuario y el nombre llevan el sello del run, así que dos corridas nunca chocan (S4).
 */

test.use({ storageState: warehouseSessionState, permissions: ['clipboard-read', 'clipboard-write'] });

test('el Almacén crea un usuario de sucursal y le entrega su contraseña temporal', async ({ page, api }) => {
  const warehouse = await api.as(warehouseRole);
  const tag = uniqueTag();
  const username = uniqueUsername(tag);
  const displayName = `Operador ${tag}`;

  // La pantalla se abre por su hash y la navegación la marca como la sección actual.
  await openAdministration(page);
  await expect(page.getByText('ALMACÉN / ADMINISTRACIÓN')).toBeVisible();
  expect(new URL(page.url()).hash).toBe('#/administracion');
  await expect(page.getByRole('button', { name: 'Administración' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByText('Un solo almacén, un solo administrador.')).toBeVisible();
  await expect(page.getByRole('group', { name: 'Vistas de administración' })
    .getByRole('button', { name: 'Usuarios', exact: true })).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('button', { name: '+ Crear usuario' }).click();
  const panel = accountCreation(page);
  await expect(panel.getByRole('heading', { name: 'Crear usuario de sucursal' })).toBeVisible();
  // El almacén es contexto y nunca una sucursal asignable: la elección sólo ofrece sucursales.
  await expect(panel.getByLabel('Sucursal asignada').getByRole('option', { name: 'Almacén', exact: true }))
    .toHaveCount(0);
  await expect(panel.getByText('Operador: todas las operaciones de su sucursal. No otorga acceso administrativo.'))
    .toBeVisible();

  await panel.getByLabel('Nombre completo').fill(displayName);
  await panel.getByLabel('Usuario', { exact: true }).fill(username);
  await panel.getByLabel('Sucursal asignada').selectOption({ label: branchAName });

  // Una temporal que no llega al mínimo no se envía y no crea nada.
  await panel.getByLabel('Contraseña temporal').fill('corta');
  await panel.getByRole('button', { name: 'Crear usuario' }).click();
  await expect(panel.getByRole('alert')).toHaveText('Ingresá una temporal de 12 a 128 bytes UTF-8, sin NUL.');
  expect(await findAccount(warehouse, username)).toBeNull();

  // La pantalla genera la temporal y la muestra: es el único momento en que se puede leer.
  await panel.getByRole('button', { name: 'Generar temporal' }).click();
  const temporary = await panel.getByLabel('Contraseña temporal').inputValue();
  expect(new TextEncoder().encode(temporary).length).toBeGreaterThanOrEqual(12);
  await expect(panel.getByLabel('Contraseña temporal')).toHaveAttribute('type', 'password');
  await panel.getByRole('button', { name: 'Mostrar temporal' }).click();
  await expect(panel.getByLabel('Contraseña temporal')).toHaveAttribute('type', 'text');
  await expect(panel.getByLabel('Contraseña temporal')).toHaveValue(temporary);
  await panel.getByRole('button', { name: 'Ocultar temporal' }).click();
  await expect(panel.getByLabel('Contraseña temporal')).toHaveAttribute('type', 'password');

  await panel.getByRole('button', { name: 'Crear usuario' }).click();

  // La confirmación entrega el secreto en su propio panel, y dice cómo entregarlo.
  const delivery = passwordHandoff(page);
  await expect(delivery.getByRole('heading', { name: 'Contraseña temporal confirmada' })).toBeVisible();
  await expect(delivery.getByText('Entregala por un canal privado. La persona debe cambiarla al ingresar. '
    + 'Al cerrar se elimina de esta pantalla; no se puede recuperar la anterior.')).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Cuenta actualizada.' })).toBeVisible();
  const secret = delivery.getByLabel('Temporal para entrega');
  await expect(secret).toHaveAttribute('type', 'password');
  await expect(secret).toHaveValue(temporary);
  await delivery.getByRole('button', { name: 'Mostrar entrega' }).click();
  await expect(secret).toHaveAttribute('type', 'text');
  await delivery.getByRole('button', { name: 'Copiar temporal' }).click();
  await expect(delivery.getByRole('status')).toHaveText('Copiada. Borrá el portapapeles después de entregarla.');

  // Al cerrar la entrega el secreto se va de la pantalla, sin dejar rastro en ningún campo.
  await delivery.getByRole('button', { name: 'Cerrar entrega privada' }).click();
  await expect(passwordHandoff(page)).toHaveCount(0);
  // Ningún campo de la pantalla conserva el secreto.
  expect(await page.locator('input').evaluateAll(
    (inputs, secret) => inputs.map(input => (input as HTMLInputElement).value).includes(secret), temporary))
    .toBe(false);

  // El directorio publica la cuenta nueva: activa, en su sucursal y con cambio obligatorio.
  await searchAccounts(page, username);
  const row = accountRow(page, username);
  await expect(row).toHaveCount(1);
  await expect(row.getByText(displayName, { exact: true })).toBeVisible();
  await expect(row.getByText(username, { exact: true })).toBeVisible();
  await expect(row.getByText(branchAName, { exact: true })).toBeVisible();
  await expect(row.getByText('Activo', { exact: true })).toBeVisible();
  await expect(row.getByText('Cambio obligatorio', { exact: true })).toBeVisible();

  // Lo persistido, leído por el contrato del directorio.
  const created = await accountByUsername(warehouse, username);
  expect(created.display_name).toBe(displayName);
  expect(created.location_id).toBe(branchAId);
  expect(created.enabled).toBe(true);
  expect(created.must_change_password).toBe(true);

  // La cuenta es de esta corrida y se retira por el contrato, nunca una de la semilla.
  await deleteAccount(warehouse, created.id);
  expect(await findAccount(warehouse, username)).toBeNull();
});
