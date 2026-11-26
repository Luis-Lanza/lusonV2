import {
  createBattery, expect, findPriceRow, openCatalogBatteries, priceRow, test, uniqueTag, warehouseRole,
  warehouseSessionState,
} from './harness';

/**
 * S2 · las baterías del catálogo, recorridas en el navegador.
 *
 * El Almacén da de alta la identidad de una batería —marca, modelo, capacidad y las polaridades en las
 * que existe—, después corrige esa identidad y, cuando la batería ya no se vende, la archiva: el archivo
 * reemplaza a eliminar y es de una sola vía. Crear no la pone en venta: nace sin precio en ninguna
 * sucursal, que es el estado que la lista publica. Editar manda la identidad completa y no toca las
 * variantes ni el precio, y la pantalla lo dice antes del acto.
 *
 * Cada prueba usa su propia marca y modelo (con el sello del run) y contrasta lo que quedó guardado con
 * la única lectura que el catálogo de baterías publica: la página de la matriz de precios (S3), que es
 * también la que deja de ofrecer un modelo archivado.
 */

test.use({ storageState: warehouseSessionState });

test('el Almacén crea una batería con sus dos variantes y queda sin precio', async ({ page, api }) => {
  const warehouse = await api.as(warehouseRole);
  const tag = uniqueTag();
  const brand = `PRUEBA${tag}`;
  const model = `MOD${tag}`;

  await openCatalogBatteries(page);
  await expect(page.getByText('ALMACÉN / CATÁLOGO')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Baterías', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(new URL(page.url()).hash).toBe('#/catalogo/baterias');

  const create = page.getByRole('region', { name: 'Nueva batería' });
  await create.getByLabel('Marca', { exact: true }).fill(brand);
  await create.getByLabel('Modelo', { exact: true }).fill(model);
  // La capacidad se guarda normalizada: lo tipeado con ceros y ceros finales vuelve canónico.
  await create.getByLabel('Capacidad (Ah)').fill('045.50');
  await create.getByRole('checkbox', { name: 'Polaridad L' }).check();
  await create.getByRole('checkbox', { name: 'Polaridad R' }).check();
  await expect(create.getByRole('checkbox', { name: 'Polaridad L' })).toBeChecked();
  await expect(create.getByRole('checkbox', { name: 'Polaridad R' })).toBeChecked();

  await create.getByRole('button', { name: 'Crear batería' }).click();

  // La confirmación nombra la batería, las variantes que el servidor asignó y su estado de venta.
  const notice = page.getByRole('status').filter({ hasText: 'creada con las variantes' });
  await expect(notice).toHaveCount(1);
  const said = (await notice.textContent()) ?? '';
  const created = /Batería #([1-9][0-9]*) creada/.exec(said)?.[1];
  if (created === undefined) throw new Error('la confirmación de la batería no nombra el identificador');
  await expect(notice).toHaveText(new RegExp(`^Batería #${created} creada con las variantes #[1-9][0-9]* L`
    + ` · #[1-9][0-9]* R\\. Todavía no es vendible: sin precio en ninguna sucursal\\.`
    + ' Cargá su precio en el catálogo de precios para poder venderla\\.$'));

  // El formulario vuelve vacío y la lista publica la batería con la capacidad ya normalizada.
  await expect(create.getByLabel('Marca', { exact: true })).toHaveValue('');
  await expect(create.getByLabel('Modelo', { exact: true })).toHaveValue('');
  await page.getByLabel('Buscar marca o modelo').fill(model);
  const row = page.locator(`tr[data-battery-id="${created}"]`);
  await expect(row).toBeVisible();
  await expect(row.locator('td[data-label="Batería"] strong')).toHaveText(`${brand} ${model}`);
  await expect(row.locator('td[data-label="Batería"] small')).toHaveText('45.5 Ah');
  await expect(row.locator('td[data-label="Variantes"] .catalog-chip')).toHaveText(['L', 'R']);
  await expect(row.locator('td[data-label="Venta"]')).toContainText('No vendible · sin precio');
  await expect(row.getByRole('button', { name: `Editar ${brand} ${model}` })).toBeVisible();

  // Lo persistido, leído por la página de la matriz: la identidad, sus polaridades y ningún precio.
  const persisted = await priceRow(warehouse, 'battery', model, Number(created));
  expect(persisted.brand).toBe(brand);
  expect(persisted.model).toBe(model);
  expect(persisted.capacity_ah).toBe('45.5');
  expect(persisted.polarities).toEqual(['L', 'R']);
  expect(persisted.prices).toEqual([]);
});

test('el Almacén edita la identidad de una batería y sus variantes no cambian', async ({ page, api }) => {
  const warehouse = await api.as(warehouseRole);
  const tag = uniqueTag();
  const brand = `PRUEBA${tag}`;
  const model = `MOD${tag}`;
  // La batería ya está en el catálogo: crearla es otro acto y tiene su propia prueba.
  const battery = await createBattery(warehouse, {
    brand, model, capacity_ah: '45', polarities: ['L', 'R'],
  });

  await openCatalogBatteries(page);
  await page.getByLabel('Buscar marca o modelo').fill(model);
  const row = page.locator(`tr[data-battery-id="${battery.id}"]`);
  await expect(row.locator('td[data-label="Batería"] small')).toHaveText('45 Ah');

  await row.getByRole('button', { name: `Editar ${brand} ${model}` }).click();
  const editor = page.getByRole('form', { name: `Editar ${brand} ${model}` });
  await expect(editor).toBeVisible();
  await expect(editor.getByText('Variantes: L · R · no cambian al editar la identidad')).toBeVisible();

  await editor.getByLabel('Nueva capacidad (Ah)').fill('60.25');
  await editor.getByRole('button', { name: 'Guardar cambios' }).click();

  // La confirmación nombra la batería y la identidad que quedó escrita, y recuerda que sigue sin precio.
  const notice = page.getByRole('status').filter({ hasText: 'actualizada' });
  await expect(notice).toHaveText(`Batería #${battery.id} actualizada: ${brand} ${model} · 60.25 Ah.`
    + ' Sigue sin precio en ninguna sucursal: no es vendible.');
  await expect(editor).toHaveCount(0);
  await expect(row.locator('td[data-label="Batería"] small')).toHaveText('60.25 Ah');
  await expect(row.locator('td[data-label="Variantes"] .catalog-chip')).toHaveText(['L', 'R']);

  // Lo persistido: la capacidad nueva sobre la misma entrada, con las mismas dos polaridades.
  const persisted = await priceRow(warehouse, 'battery', model, battery.id);
  expect(persisted.brand).toBe(brand);
  expect(persisted.model).toBe(model);
  expect(persisted.capacity_ah).toBe('60.25');
  expect(persisted.polarities).toEqual(['L', 'R']);
  expect(persisted.prices).toEqual([]);
});

test('el Almacén archiva una batería y el catálogo deja de ofrecer el modelo', async ({ page, api }) => {
  const warehouse = await api.as(warehouseRole);
  const tag = uniqueTag();
  const brand = `PRUEBA${tag}`;
  const model = `MOD${tag}`;
  // La batería que se archiva ya está en el catálogo: crearla es otro acto y tiene su propia prueba.
  const battery = await createBattery(warehouse, {
    brand, model, capacity_ah: '45', polarities: ['L'],
  });

  await openCatalogBatteries(page);
  await page.getByLabel('Buscar marca o modelo').fill(model);
  const row = page.locator(`tr[data-battery-id="${battery.id}"]`);
  await expect(row.locator('td[data-label="Batería"] strong')).toHaveText(`${brand} ${model}`);

  await row.getByRole('button', { name: `Archivar ${brand} ${model}` }).click();

  // La confirmación es la que la pantalla publica: qué sale del catálogo y con qué condición, para siempre.
  const confirmation = page.getByRole('group', { name: `Archivar ${brand} ${model}` });
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toContainText('la saca del catálogo para siempre: no se puede volver a activar');
  await expect(confirmation).toContainText('Sus existencias deben estar en cero y no puede tener transferencias pendientes.');
  await confirmation.getByRole('button', { name: 'Confirmar archivado' }).click();

  // La confirmación del acto nombra la batería archivada, y la fila sale de la lista editable en el acto.
  const notice = page.getByRole('status').filter({ hasText: 'archivada' });
  await expect(notice).toHaveText(
    `Batería #${battery.id} archivada. No se puede volver a activar y deja de aparecer en el catálogo.`);
  await expect(row).toHaveCount(0);
  await expect(page.getByText('Sin baterías para esta consulta.')).toBeVisible();

  // Y el modelo deja de ofrecerse: la página de la matriz ya no lo publica.
  expect(await findPriceRow(warehouse, 'battery', model, battery.id)).toBeNull();
});
