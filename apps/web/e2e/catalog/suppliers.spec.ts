import {
  createBattery, createOtherProduct, createSupplier, expect, openCatalogSuppliers, showSupplierRow,
  supplierCatalog, supplierDetail, test, uniqueTag, warehouseRole, warehouseSessionState,
} from './harness';

/**
 * S2 · los proveedores del almacén, recorridos en el navegador.
 *
 * El Almacén registra a quién le compra, corrige su nombre y su contacto, y le asigna los productos del
 * catálogo que ese proveedor ofrece. Una oferta es una entrada del catálogo —una batería por su marca y
 * modelo, un producto por su nombre—, y es lo que Ingresos lee para elegir qué se está recibiendo: una
 * batería ofrecida se publica con sus dos polaridades y un producto con la suya.
 *
 * Cada prueba registra su propio proveedor y su propia entrada con el sello del run, y contrasta lo que
 * quedó guardado con el detalle y el catálogo del proveedor que publica `suppliers.md` (S3). La lista no
 * tiene búsqueda, así que la fila se alcanza como la alcanza el operador: con la página más ancha y
 * recorriendo las páginas.
 */

test.use({ storageState: warehouseSessionState });

test('el Almacén registra un proveedor y la lista lo publica como activo', async ({ page, api }) => {
  const warehouse = await api.as(warehouseRole);
  const tag = uniqueTag();
  const name = `Proveedor ${tag}`;
  const contact = `Contacto ${tag} 700-11111`;

  await openCatalogSuppliers(page);
  await expect(page.getByText('ALMACÉN / CATÁLOGO')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Proveedores', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(new URL(page.url()).hash).toBe('#/catalogo/proveedores');

  const create = page.getByRole('region', { name: 'Nuevo proveedor' });
  await create.getByLabel('Nombre', { exact: true }).fill(name);
  await create.getByLabel('Contacto', { exact: true }).fill(contact);
  await create.getByRole('button', { name: 'Crear proveedor' }).click();

  // La confirmación nombra el proveedor y el identificador que asignó el servidor.
  const notice = page.getByRole('status').filter({ hasText: 'creado' });
  await expect(notice).toHaveCount(1);
  const said = (await notice.textContent()) ?? '';
  const created = /Proveedor #([1-9][0-9]*) creado/.exec(said)?.[1];
  if (created === undefined) throw new Error('la confirmación del proveedor no nombra el identificador');
  await expect(notice).toHaveText(`Proveedor #${created} creado: ${name}.`);
  await expect(create.getByLabel('Nombre', { exact: true })).toHaveValue('');

  // La fila publica el contacto, el estado y que todavía no ofrece ningún producto.
  const row = await showSupplierRow(page, Number(created));
  await expect(row.locator('td[data-label="Proveedor"] strong')).toHaveText(name);
  await expect(row.locator('td[data-label="Proveedor"] small')).toHaveText(contact);
  await expect(row.locator('td[data-label="Proveedor"] .catalog-chip')).toHaveText('Activo');
  await expect(row.locator('td[data-label="Productos"] strong')).toHaveText('sin productos');
  await expect(row.locator('td[data-label="Productos"] .catalog-chip')).toHaveText('Sin productos asignados');
  await expect(row.getByRole('button', { name: `Asignar productos a ${name}` })).toBeVisible();

  // Lo persistido, leído por el detalle del contrato: activo, con su contacto y sin ofertas.
  const persisted = await supplierDetail(warehouse, Number(created));
  expect(persisted.name).toBe(name);
  expect(persisted.contact).toBe(contact);
  expect(persisted.retired).toBe(false);
  expect(persisted.offers).toEqual([]);
  expect(persisted.kinds).toEqual([]);
});

test('el Almacén edita el nombre y el contacto de un proveedor', async ({ page, api }) => {
  const warehouse = await api.as(warehouseRole);
  const tag = uniqueTag();
  const original = `Proveedor ${tag}`;
  const renamed = `Proveedor ${tag} II`;
  const corrected = `Contacto corregido ${tag} 700-22222`;
  // El proveedor ya está registrado: registrarlo es otro acto y tiene su propia prueba.
  const supplier = await createSupplier(warehouse, { name: original, contact: `Contacto ${tag} 700-11111` });

  await openCatalogSuppliers(page);
  const row = await showSupplierRow(page, supplier.id);
  await row.getByRole('button', { name: `Editar ${original}` }).click();
  const editor = page.getByRole('form', { name: `Editar ${original}` });
  await expect(editor).toBeVisible();
  await expect(editor.getByText('La edición cambia el nombre y el contacto del proveedor.'
    + ' Los productos que ofrece se conservan y se editan aparte.')).toBeVisible();

  await editor.getByLabel('Nuevo nombre').fill(renamed);
  await editor.getByLabel('Contacto', { exact: true }).fill(corrected);
  await editor.getByRole('button', { name: 'Guardar cambios' }).click();

  const notice = page.getByRole('status').filter({ hasText: 'actualizado' });
  await expect(notice).toHaveText(`Proveedor #${supplier.id} actualizado: ${renamed}.`);
  await expect(editor).toHaveCount(0);

  // La lista vuelve a leer el proveedor: la fila muestra el nombre y el contacto nuevos.
  const updated = await showSupplierRow(page, supplier.id);
  await expect(updated.locator('td[data-label="Proveedor"] strong')).toHaveText(renamed);
  await expect(updated.locator('td[data-label="Proveedor"] small')).toHaveText(corrected);

  // Lo persistido, y lo que la edición no toca: el proveedor sigue activo y su conjunto de ofertas sigue vacío.
  const persisted = await supplierDetail(warehouse, supplier.id);
  expect(persisted.name).toBe(renamed);
  expect(persisted.contact).toBe(corrected);
  expect(persisted.retired).toBe(false);
  expect(persisted.offers).toEqual([]);
});

test('el Almacén asigna a un proveedor la batería del catálogo que ofrece', async ({ page, api }) => {
  const warehouse = await api.as(warehouseRole);
  const tag = uniqueTag();
  const supplier = await createSupplier(warehouse, { name: `Proveedor ${tag}`, contact: `Contacto ${tag}` });
  const battery = await createBattery(warehouse, {
    brand: `PRUEBA${tag}`, model: `MOD${tag}`, capacity_ah: '45', polarities: ['L', 'R'],
  });

  await openCatalogSuppliers(page);
  const row = await showSupplierRow(page, supplier.id);
  await row.getByRole('button', { name: `Asignar productos a ${supplier.name}` }).click();

  const editor = page.getByRole('form', { name: `Productos que ofrece ${supplier.name}` });
  await expect(editor).toBeVisible();
  await expect(editor.getByText('Guardar reemplaza el conjunto completo de productos que ofrece el'
    + ' proveedor.')).toBeVisible();
  const assigned = editor.getByRole('status').filter({ hasText: 'Productos asignados' });
  await expect(assigned).toHaveText('Productos asignados: 0');

  // El catálogo asignable se busca por el modelo: el proveedor no ofrece nada todavía.
  await editor.getByLabel('Buscar en el catálogo').fill(battery.model);
  const offer = editor.getByRole('checkbox', { name: `Ofrecer ${battery.brand} ${battery.model}` });
  await expect(offer).not.toBeChecked();
  await offer.check();
  await expect(assigned).toHaveText('Productos asignados: 1');

  await editor.getByRole('button', { name: 'Guardar asignación' }).click();

  // La confirmación cuenta lo que el proveedor ofrece después de guardar.
  const notice = page.getByRole('status').filter({ hasText: 'actualizado' });
  await expect(notice).toHaveText(`Proveedor #${supplier.id} actualizado: ofrece 1 producto.`);
  await expect(assigned).toHaveText('Productos asignados: 1');

  // Lo persistido: la oferta es la entrada de esa batería, con su marca, su modelo y su capacidad.
  const persisted = await supplierDetail(warehouse, supplier.id);
  expect(persisted.kinds).toEqual(['battery']);
  expect(persisted.offers.map(entry => [entry.catalog_entry_id, entry.kind, entry.brand, entry.model,
    entry.capacity_ah])).toEqual([[battery.id, 'battery', battery.brand, battery.model, '45']]);

  // Y el catálogo del proveedor —lo que Ingresos lee— publica las dos polaridades de esa batería.
  const offered = await supplierCatalog(warehouse, supplier.id);
  expect(offered.map(item => [item.kind, item.name, item.detail])).toEqual([
    ['battery', `${battery.brand} · ${battery.model}`, '45 Ah · L'],
    ['battery', `${battery.brand} · ${battery.model}`, '45 Ah · R'],
  ]);
});

test('el Almacén asigna un producto del catálogo y el catálogo del proveedor lo publica', async ({ page, api }) => {
  const warehouse = await api.as(warehouseRole);
  const tag = uniqueTag();
  const supplier = await createSupplier(warehouse, { name: `Proveedor ${tag}`, contact: `Contacto ${tag}` });
  const product = await createOtherProduct(warehouse, {
    name: `Agua de prueba ${tag}`,
    fields: [{ name: 'volumen en L', kind: 'number', number: '5', unit: 'L' }],
  });

  await openCatalogSuppliers(page);
  const row = await showSupplierRow(page, supplier.id);
  await row.getByRole('button', { name: `Asignar productos a ${supplier.name}` }).click();

  const editor = page.getByRole('form', { name: `Productos que ofrece ${supplier.name}` });
  await expect(editor).toBeVisible();
  // El catálogo asignable se filtra por tipo y por nombre, como lo haría el operador.
  await editor.getByLabel('Tipo de producto').selectOption({ label: 'Otros productos' });
  await editor.getByLabel('Buscar en el catálogo').fill(product.name);
  const entry = editor.getByRole('checkbox', { name: `Ofrecer ${product.name}` });
  await expect(entry).toBeVisible();
  await entry.check();
  await expect(editor.getByRole('status').filter({ hasText: 'Productos asignados' }))
    .toHaveText('Productos asignados: 1');

  await editor.getByRole('button', { name: 'Guardar asignación' }).click();
  const notice = page.getByRole('status').filter({ hasText: 'actualizado' });
  await expect(notice).toHaveText(`Proveedor #${supplier.id} actualizado: ofrece 1 producto.`);

  // Lo persistido: el proveedor ofrece esa entrada de catálogo, que es un producto y no una batería.
  const persisted = await supplierDetail(warehouse, supplier.id);
  expect(persisted.kinds).toEqual(['other']);
  expect(persisted.offers.map(entry => [entry.catalog_entry_id, entry.kind, entry.name]))
    .toEqual([[product.id, 'other', product.name]]);

  // Y su catálogo publica la entrada con la identidad que Ingresos lee: el nombre del producto.
  const offered = await supplierCatalog(warehouse, supplier.id);
  expect(offered.map(item => [item.catalog_entry_id, item.kind, item.name]))
    .toEqual([[product.id, 'other', product.name]]);
});
