import {
  activeMotiveRow, adminMotiveByLabel, adminMotives, archivedMotives, arrangeMotive, branchA,
  branchDrawerPage, expect, motiveList, openMotivesTab, test, uniqueTag, warehouseRole,
  warehouseSessionState,
} from './harness';

/**
 * S2 · la pestaña «Motivos de caja» del catálogo del Almacén: el alta, la edición y el archivo.
 *
 * La lista de motivos es una sola para todas las sucursales y la administra el Almacén: el alta agrega al
 * final, el renombre conserva la identidad y el lugar, y el archivo saca el motivo del selector sin
 * borrarlo nunca (S3, S4, S5, S13). La pestaña es local —el hash sigue siendo el de la sección del
 * catálogo— y cada efecto se contrasta con el catálogo que el contrato publica
 * (`GET /api/admin/cash-categories`) y con el selector que la sucursal lee (`GET
 * /api/closings/cash-categories`), que es lo que el operador del mostrador ve.
 *
 * El acto que cada prueba no ejercita —el motivo que se renombra o se archiva— se arregla por la ruta
 * pública de la administración, con su sello del run: la base es una sola y las demás suites del pedido
 * corren contra ella al mismo tiempo (S4).
 */

test.use({ storageState: warehouseSessionState });

test('el Almacén crea un motivo de caja y la sucursal lo ve en su selector', async ({ page, api, browser }) => {
  const warehouse = await api.as(warehouseRole);
  const branch = await api.as(branchA);
  const label = `Fletes ${uniqueTag()}`;
  const before = (await adminMotives(warehouse)).filter(row => row.state === 'active');

  await openMotivesTab(page);
  await expect(page.getByText('ALMACÉN / CATÁLOGO')).toBeVisible();
  // La pestaña es local: el hash sigue siendo el de la sección del catálogo y ninguna otra pestaña queda
  // apretada con ella.
  expect(new URL(page.url()).hash).toBe('#/catalogo');
  await expect(page.getByRole('group', { name: 'Secciones del catálogo' })
    .getByRole('button', { name: 'Precios', exact: true })).toHaveAttribute('aria-pressed', 'false');

  // El acto: escribir el motivo y agregarlo al final.
  const form = page.getByRole('form', { name: 'Agregar un motivo' });
  await form.getByLabel('Agregar un motivo').fill(label);
  await form.getByRole('button', { name: 'Agregar al final' }).click();

  await expect(page.getByRole('status').filter({ hasText: 'agregado al final de la lista' }))
    .toHaveText(`Motivo «${label}» agregado al final de la lista.`);
  await expect(form.getByLabel('Agregar un motivo')).toHaveValue('');

  // La lista lo publica al final, activo y con su lugar en la lista.
  const created = await adminMotiveByLabel(warehouse, label);
  expect(created.state).toBe('active');
  expect(created.retired_at).toBeNull();
  expect(created.retired_by).toBeNull();
  const active = (await adminMotives(warehouse)).filter(row => row.state === 'active');
  expect(active).toHaveLength(before.length + 1);
  expect(created.sort_order).toBe(Math.max(...active.map(row => row.sort_order)));
  await expect(page.locator('.catalog-tag')).toHaveText(`${active.length} activos`);
  const row = activeMotiveRow(page, created.id);
  await expect(row).toHaveCount(1);
  await expect(row.locator('td[data-label="Motivo"] strong')).toHaveText(label);
  await expect(row.locator('td[data-label="Estado"]')).toHaveText('Activo');
  await expect(page.locator('tr.catalog-row[data-motive-id]').last())
    .toHaveAttribute('data-motive-id', String(created.id));

  // Y la sucursal lo ve en el selector de su cajón sin que nadie toque esa pantalla.
  const branchView = await branchDrawerPage(browser);
  await expect(branchView.locator('#cash-category')).toContainText(label);
  await expect(branchView.locator(`#cash-category option[value="${created.id}"]`)).toHaveText(label);
  await branchView.context().close();
  expect((await motiveList(branch)).map(option => option.label)).toContain(label);
});

test('el Almacén renombra un motivo y la sucursal lee la etiqueta nueva', async ({ page, api, browser }) => {
  const warehouse = await api.as(warehouseRole);
  const branch = await api.as(branchA);
  const created = await arrangeMotive(warehouse, `Insumos ${uniqueTag()}`);
  const renamed = `${created.label} del día`;
  // Otra etiqueta del catálogo: el renombre no admite dos motivos con el mismo nombre (S13).
  const other = (await adminMotives(warehouse)).find(row => row.id !== created.id);
  if (other === undefined) throw new Error('el catálogo no tiene otro motivo con el que probar la etiqueta repetida');

  await openMotivesTab(page);
  const row = activeMotiveRow(page, created.id);
  await expect(row.locator('td[data-label="Motivo"] strong')).toHaveText(created.label);

  // El acto: abrir el renombre de esa fila.
  await page.getByRole('button', { name: `Renombrar ${created.label}` }).click();
  const form = page.getByRole('form', { name: `Renombrar ${created.label}` });
  const field = form.getByLabel('Nuevo nombre');
  await expect(field).toHaveValue(created.label);
  await expect(form).toContainText('Los gastos ya registrados conservan la etiqueta con la que se guardaron');

  // Un nombre que el catálogo ya tiene se rechaza nombrando la etiqueta: el motivo queda como estaba.
  await field.fill(other.label);
  await form.getByRole('button', { name: 'Guardar nombre' }).click();
  await expect(form.getByRole('alert')).toHaveText(`Ya existe un motivo llamado «${other.label}». Elegí otro nombre.`);
  await expect(field).toHaveValue(other.label);
  expect((await adminMotiveByLabel(warehouse, created.label)).label).toBe(created.label);

  // El acto: el nombre nuevo.
  await field.fill(renamed);
  await form.getByRole('button', { name: 'Guardar nombre' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Motivo renombrado' })).toHaveText(
    `Motivo renombrado: «${renamed}». Los gastos ya registrados conservan la etiqueta anterior.`);
  await expect(form).toHaveCount(0);

  // La fila y el catálogo: la misma identidad, el mismo lugar y la etiqueta nueva.
  await expect(activeMotiveRow(page, created.id).locator('td[data-label="Motivo"] strong')).toHaveText(renamed);
  const persisted = await adminMotiveByLabel(warehouse, renamed);
  expect(persisted.id).toBe(created.id);
  expect(persisted.sort_order).toBe(created.sort_order);
  expect(persisted.state).toBe('active');

  // Y la sucursal lee la etiqueta nueva en la opción del mismo motivo.
  expect((await motiveList(branch)).map(option => option.label)).toContain(renamed);
  const branchView = await branchDrawerPage(browser);
  await expect(branchView.locator(`#cash-category option[value="${created.id}"]`)).toHaveText(renamed);
  await branchView.context().close();
});

test('el Almacén archiva un motivo y lo reactiva sin borrarlo', async ({ page, api }) => {
  const warehouse = await api.as(warehouseRole);
  const branch = await api.as(branchA);
  const created = await arrangeMotive(warehouse, `Archivable ${uniqueTag()}`);
  expect((await motiveList(branch)).map(option => option.label)).toContain(created.label);

  await openMotivesTab(page);
  await expect(activeMotiveRow(page, created.id)).toHaveCount(1);

  // El acto: archivar, que pide su confirmación.
  await page.getByRole('button', { name: `Archivar ${created.label}` }).click();
  const confirm = page.getByRole('group', { name: `Archivar ${created.label}` });
  await expect(confirm).toContainText('es reversible');
  await confirm.getByRole('button', { name: 'Confirmar archivo' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'archivado' })).toHaveText(
    `Motivo «${created.label}» archivado. Podés reactivarlo desde «Archivados».`);

  // Sale de los activos y deja de ofrecerse a la sucursal, pero no se borra: queda en «Archivados».
  await expect(activeMotiveRow(page, created.id)).toHaveCount(0);
  const retired = await adminMotiveByLabel(warehouse, created.label);
  expect(retired.state).toBe('retired');
  expect(retired.retired_at).not.toBeNull();
  expect(retired.retired_by).not.toBeNull();
  expect((await motiveList(branch)).map(option => option.label)).not.toContain(created.label);

  const archived = (await adminMotives(warehouse)).filter(row => row.state === 'retired');
  await expect(archivedMotives(page).locator('summary')).toHaveText(`Archivados (${archived.length})`);
  await archivedMotives(page).locator('summary').click();
  const archivedRow = archivedMotives(page).locator(`tr[data-motive-id="${created.id}"]`);
  await expect(archivedRow.locator('td[data-label="Estado"]')).toHaveText('Archivado');

  // El acto: reactivarlo desde el bloque de archivados.
  await archivedRow.getByRole('button', { name: `Reactivar ${created.label}` }).click();
  await expect(page.getByRole('status').filter({ hasText: 'reactivado' })).toHaveText(
    `Motivo «${created.label}» reactivado: vuelve a ofrecerse en las sucursales.`);

  const active = await adminMotiveByLabel(warehouse, created.label);
  expect(active.id).toBe(created.id);
  expect(active.state).toBe('active');
  expect(active.retired_at).toBeNull();
  expect(active.retired_by).toBeNull();
  await expect(activeMotiveRow(page, created.id)).toHaveCount(1);
  expect((await motiveList(branch)).map(option => option.label)).toContain(created.label);
});
