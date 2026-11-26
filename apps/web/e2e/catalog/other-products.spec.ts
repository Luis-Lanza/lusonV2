import {
  createOtherProduct, expect, openCatalogOtherProducts, otherProductByName, test, uniqueTag,
  warehouseRole, warehouseSessionState,
} from './harness';

/**
 * S2 · los otros productos del catálogo, recorridos en el navegador.
 *
 * Un producto no es una batería: se identifica por un nombre libre y lleva los campos que el Almacén le
 * asigne —un número con su unidad, o un texto—. El alta escribe el nombre y el conjunto de campos, y la
 * edición reemplaza ese conjunto: los campos que se quitan no se conservan, y la pantalla lo dice antes
 * del acto junto al aviso de que el identificador lo asigna el servidor.
 *
 * Cada prueba nombra su producto con el sello del run y contrasta lo guardado con la lista activa del
 * contrato público (`other-products.md`), que es la lectura que la pantalla hace (S3).
 */

test.use({ storageState: warehouseSessionState });

test('el Almacén crea un producto con sus campos y el catálogo lo publica', async ({ page, api }) => {
  const warehouse = await api.as(warehouseRole);
  const tag = uniqueTag();
  const name = `Agua de prueba ${tag}`;

  await openCatalogOtherProducts(page);
  await expect(page.getByText('ALMACÉN / CATÁLOGO')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Otros productos', exact: true }))
    .toHaveAttribute('aria-pressed', 'true');
  expect(new URL(page.url()).hash).toBe('#/catalogo/otros-productos');

  const create = page.getByRole('region', { name: 'Nuevo producto' });
  await create.getByLabel('Nombre', { exact: true }).fill(name);

  // El primer campo es un número con su unidad.
  const first = create.getByRole('group', { name: 'Campo 1' });
  await first.getByLabel('Nombre del campo').fill('volumen en L');
  await first.getByLabel('Unidad (opcional)').fill('L');
  await first.getByLabel('Valor').fill('5');

  // El segundo es un texto: al elegir el tipo, la unidad deja de ofrecerse en esa fila.
  await create.getByRole('button', { name: 'Agregar campo' }).click();
  const second = create.getByRole('group', { name: 'Campo 2' });
  await second.getByLabel('Nombre del campo').fill('origen');
  await second.getByLabel('Tipo').selectOption({ label: 'Texto' });
  await expect(second.getByLabel('Unidad (opcional)')).toHaveCount(0);
  await second.getByLabel('Valor').fill('importado');

  await create.getByRole('button', { name: 'Crear producto' }).click();

  // La confirmación nombra el producto, el identificador asignado y cuántos campos quedaron guardados.
  const notice = page.getByRole('status').filter({ hasText: 'creado' });
  await expect(notice).toHaveCount(1);
  const said = (await notice.textContent()) ?? '';
  const created = /Producto #([1-9][0-9]*) creado/.exec(said)?.[1];
  if (created === undefined) throw new Error('la confirmación del producto no nombra el identificador');
  await expect(notice).toHaveText(`Producto #${created} creado: ${name} · 2 campos.`);

  // El formulario vuelve a su fila vacía y la lista publica el producto con sus campos.
  await expect(create.getByLabel('Nombre', { exact: true })).toHaveValue('');
  await page.getByLabel('Buscar producto').fill(name);
  const row = page.locator(`tr[data-product-id="${created}"]`);
  await expect(row).toBeVisible();
  await expect(row.locator('td[data-label="Producto"] strong')).toHaveText(name);
  await expect(row.locator('td[data-label="Producto"] small')).toHaveText('2 campos');
  await expect(row.locator('td[data-label="Campos"] .catalog-chip'))
    .toHaveText(['volumen en L: 5 L', 'origen: importado']);
  await expect(row.getByRole('button', { name: `Editar ${name}` })).toBeVisible();

  // Lo persistido, leído por la lista activa del contrato.
  const persisted = await otherProductByName(warehouse, name);
  expect(persisted.id).toBe(Number(created));
  expect(persisted.fields).toHaveLength(2);
  expect(persisted.fields).toEqual(expect.arrayContaining([
    { name: 'volumen en L', kind: 'number', number: '5', unit: 'L' },
    { name: 'origen', kind: 'text', text: 'importado' },
  ]));
});

test('el Almacén edita un producto y la edición reemplaza sus campos', async ({ page, api }) => {
  const warehouse = await api.as(warehouseRole);
  const tag = uniqueTag();
  const original = `Agua de prueba ${tag}`;
  const renamed = `Agua de prueba ${tag} II`;
  // El producto que se edita ya está en el catálogo: crearlo es otro acto y tiene su propia prueba.
  const product = await createOtherProduct(warehouse, {
    name: original,
    fields: [
      { name: 'volumen en L', kind: 'number', number: '5', unit: 'L' },
      { name: 'origen', kind: 'text', text: 'importado' },
    ],
  });

  await openCatalogOtherProducts(page);
  await page.getByLabel('Buscar producto').fill(original);
  const row = page.locator(`tr[data-product-id="${product.id}"]`);
  await expect(row.locator('td[data-label="Campos"] .catalog-chip'))
    .toHaveText(['volumen en L: 5 L', 'origen: importado']);

  await row.getByRole('button', { name: `Editar ${original}` }).click();
  const editor = page.getByRole('form', { name: `Editar ${original}` });
  await expect(editor).toBeVisible();
  await expect(editor.getByText('La edición reemplaza todos los campos del producto: los que quites no se'
    + ' conservan y los nuevos se guardan en su lugar.')).toBeVisible();

  await editor.getByLabel('Nuevo nombre').fill(renamed);
  // El segundo campo se quita y el número cambia de valor: la edición es el conjunto nuevo.
  await editor.getByRole('button', { name: 'Quitar campo 2' }).click();
  await expect(editor.getByRole('group', { name: 'Campo 2' })).toHaveCount(0);
  await editor.getByLabel('Valor').fill('7.5');
  await editor.getByRole('button', { name: 'Guardar cambios' }).click();

  const notice = page.getByRole('status').filter({ hasText: 'actualizado' });
  await expect(notice).toHaveText(`Producto #${product.id} actualizado: ${renamed} · 1 campo.`);
  await expect(editor).toHaveCount(0);
  await expect(row.locator('td[data-label="Producto"] strong')).toHaveText(renamed);
  await expect(row.locator('td[data-label="Producto"] small')).toHaveText('1 campo');
  await expect(row.locator('td[data-label="Campos"] .catalog-chip')).toHaveText(['volumen en L: 7.5 L']);

  // Lo persistido: el nombre nuevo y el conjunto nuevo, sin el campo quitado.
  const persisted = await otherProductByName(warehouse, renamed);
  expect(persisted.id).toBe(product.id);
  expect(persisted.fields).toEqual([{ name: 'volumen en L', kind: 'number', number: '7.5', unit: 'L' }]);
});
