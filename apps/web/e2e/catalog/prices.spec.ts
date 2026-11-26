import {
  branchAId, branchAName, createBattery, createOtherProduct, expect, openCatalogPrices, priceRow, test,
  uniqueTag, warehouseRole, warehouseSessionState,
} from './harness';

/**
 * S2 · el catálogo de precios, recorrido en el navegador.
 *
 * La primera pantalla de la sección es la matriz: una fila por entrada del catálogo y, debajo de la fila
 * elegida, el par mínimo/sugerido y las sucursales a las que se aplica. El acto del Almacén es siempre el
 * mismo para las dos clases de entrada —una batería y un producto—, así que cada clase tiene su prueba y
 * las dos recorren la pantalla: pestaña, búsqueda, despliegue, montos, sucursal y confirmación.
 *
 * Las entradas que se tasan son propias de esta corrida (marca y modelo, o nombre, con el sello del run):
 * un precio se escribe sobre la entrada y la sucursal, no sobre un identificador compartido, y las demás
 * suites del pedido tasan y venden contra la misma base al mismo tiempo (S4).
 */

test.use({ storageState: warehouseSessionState });

test('el Almacén carga el precio de una batería y la matriz lo publica en la sucursal elegida',
  async ({ page, api }) => {
    const warehouse = await api.as(warehouseRole);
    const tag = uniqueTag();
    const battery = await createBattery(warehouse, {
      brand: `PRUEBA${tag}`, model: `MOD${tag}`, capacity_ah: '45', polarities: ['L', 'R'],
    });

    // La pantalla se abre por su hash y arranca en la pestaña de baterías.
    await openCatalogPrices(page);
    await expect(page.getByText('ALMACÉN / CATÁLOGO')).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Baterías' })).toHaveAttribute('aria-selected', 'true');
    expect(new URL(page.url()).hash).toBe('#/catalogo');

    await page.getByLabel('Buscar marca o modelo').fill(battery.model);
    const row = page.locator(`#catalog-row-${battery.id}`);
    await expect(row).toBeVisible();
    await expect(row).toContainText(`${battery.brand} ${battery.model}`);
    // Una batería recién creada no tiene precio en ninguna sucursal, y la fila lo dice antes del acto.
    await expect(row.getByTitle(`${branchAName}: sin precio`)).toBeVisible();

    // El despliegue es el formulario: el mismo precio cubre las dos polaridades de la batería.
    await row.click();
    const detail = page.locator(`#catalog-detail-${battery.id}`);
    await expect(detail.getByRole('heading', { name: `Precios de ${battery.brand} ${battery.model}` }))
      .toBeVisible();
    await expect(detail.getByText('Un mismo precio para las polaridades L y R de esta batería.')).toBeVisible();
    await expect(detail.getByText('No se reemplaza ningún precio existente.')).toBeVisible();

    await detail.getByLabel('Precio mínimo de venta').fill('137000');
    await detail.getByLabel('Precio sugerido de venta').fill('149500');
    await detail.getByRole('checkbox', { name: `Aplicar a ${branchAName}` }).check();
    const apply = detail.getByRole('button', { name: 'Aplicar a 1 sucursal' });
    await expect(apply).toBeEnabled();
    await apply.click();

    // La confirmación nombra la entrada, el par aplicado y cuántas sucursales lo recibieron.
    const notice = page.getByRole('status').filter({ hasText: 'Precios aplicados' });
    await expect(notice).toHaveCount(1);
    await expect(notice).toHaveText(
      `Precios aplicados: ${battery.brand} · ${battery.model} · mínimo $ 137.000 · sugerido $ 149.500 en 1 sucursal.`);

    // El formulario se cierra y la fila pasa a publicar el par de la sucursal elegida.
    await expect(detail).toBeHidden();
    await expect(row.getByTitle(`${branchAName}: mínimo $ 137.000 · sugerido $ 149.500`)).toBeVisible();

    // Lo persistido, leído por el contrato público de la matriz: una fila por sucursal y entrada.
    const persisted = await priceRow(warehouse, 'battery', battery.model, battery.id);
    expect(persisted.brand).toBe(battery.brand);
    expect(persisted.model).toBe(battery.model);
    expect(persisted.capacity_ah).toBe('45');
    expect(persisted.polarities).toEqual(['L', 'R']);
    expect(persisted.prices.map(price => [price.branch_location_id, price.min_price, price.suggested_price]))
      .toEqual([[branchAId, '137000.00', '149500.00']]);
  });

test('el Almacén carga el precio de un producto en la otra pestaña de la matriz', async ({ page, api }) => {
  const warehouse = await api.as(warehouseRole);
  const tag = uniqueTag();
  const product = await createOtherProduct(warehouse, {
    name: `Agua de prueba ${tag}`,
    fields: [
      { name: 'volumen en L', kind: 'number', number: '5', unit: 'L' },
      { name: 'origen', kind: 'text', text: 'importado' },
    ],
  });

  await openCatalogPrices(page);
  await page.getByRole('tab', { name: 'Otros productos' }).click();
  await expect(page.getByRole('tab', { name: 'Otros productos' })).toHaveAttribute('aria-selected', 'true');
  // Una página de productos no nombra marca ni capacidad: esos filtros son de la pestaña de baterías.
  await expect(page.getByLabel('Marca')).toHaveCount(0);
  await expect(page.getByLabel('Capacidad')).toHaveCount(0);

  await page.getByLabel('Buscar nombre o dato del producto').fill(product.name);
  const row = page.locator(`#catalog-row-${product.id}`);
  await expect(row).toContainText(product.name);
  await row.click();

  const detail = page.locator(`#catalog-detail-${product.id}`);
  await expect(detail.getByRole('heading', { name: `Precios de ${product.name}` })).toBeVisible();
  // Un producto no tiene polaridades, así que la línea del precio compartido no se muestra.
  await expect(detail.getByText('Un mismo precio para')).toHaveCount(0);

  await detail.getByLabel('Precio mínimo de venta').fill('2400');
  await detail.getByLabel('Precio sugerido de venta').fill('3100');
  await detail.getByRole('checkbox', { name: `Aplicar a ${branchAName}` }).check();
  await detail.getByRole('button', { name: 'Aplicar a 1 sucursal' }).click();

  const notice = page.getByRole('status').filter({ hasText: 'Precios aplicados' });
  await expect(notice).toHaveText(
    `Precios aplicados: ${product.name} · mínimo $ 2.400 · sugerido $ 3.100 en 1 sucursal.`);
  await expect(row.getByTitle(`${branchAName}: mínimo $ 2.400 · sugerido $ 3.100`)).toBeVisible();

  const persisted = await priceRow(warehouse, 'other', product.name, product.id);
  expect(persisted.name).toBe(product.name);
  // El detalle del producto es el resumen de sus campos tipados, compuesto por el servidor.
  expect(persisted.detail).toBe('volumen en L: 5 L · origen: importado');
  expect(persisted.prices.map(price => [price.branch_location_id, price.min_price, price.suggested_price]))
    .toEqual([[branchAId, '2400.00', '3100.00']]);
});
