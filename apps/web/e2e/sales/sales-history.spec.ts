import {
  arrangeSale, arrangeSellableBattery, branchA, expect, historyRow, money, openHistory, saleDetail,
  saleDetailPanel, salesSearch, test, warehouseRole,
} from './harness';

/**
 * S2 · el historial de ventas de la sucursal (T3), recorrido en el navegador: la venta aparece en la
 * lista con sus datos, su detalle se despliega en la fila y su garantía se descarga desde esa misma fila.
 *
 * El historial sólo lee: la venta que lista la arregla la API pública de la misma sesión (S3) y cada
 * afirmación de la pantalla se contrasta con esa misma lectura del contrato (`apps/api/docs/sales.md`),
 * nunca con una estructura interna. El documento se busca por el número de garantía, que es el número
 * que la propia fila imprime, así que ninguna otra venta de la base puede confundir la aserción.
 */

test('el historial lista la venta con su número, su cliente, su cobro y su total', async ({ page, api }) => {
  const branch = await api.as(branchA);
  const warehouse = await api.as(warehouseRole);
  const battery = await arrangeSellableBattery({ branch, warehouse });
  const sale = await arrangeSale(branch, battery);

  // El operador entra por su propia navegación y busca la venta por su número de garantía.
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Historial de ventas' })).toBeEnabled();
  await page.getByRole('button', { name: 'Historial de ventas' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Historial de ventas' })).toBeVisible();
  expect(new URL(page.url()).hash).toBe('#/ventas/historial');
  await expect(page.getByRole('button', { name: 'Historial de ventas' })).toHaveAttribute('aria-current', 'page');

  await page.getByLabel('Buscar venta').fill(sale.warrantyNumber);
  await expect(page.getByText('Mostrando 1–1 de 1 ventas')).toBeVisible();

  // La fila publica los datos del documento: número de venta, garantía, fecha, cliente, cobro y total.
  const row = historyRow(page, sale.sequence);
  await expect(row).toBeVisible();
  const cells = row.getByRole('cell');
  await expect(cells.nth(0)).toHaveText(`#${sale.sequence}`);
  await expect(cells.nth(1)).toHaveText(sale.warrantyNumber);
  await expect(cells.nth(2).locator('time')).toHaveAttribute('datetime', sale.createdAt);
  await expect(cells.nth(3)).toHaveText(sale.customer.name);
  await expect(cells.nth(4)).toHaveText('Efectivo');
  await expect(cells.nth(5)).toHaveText('1');
  await expect(cells.nth(6)).toHaveText('1 con garantía');
  await expect(cells.nth(7)).toHaveText(money(sale.total));
  // Y las dos acciones de la fila son las del documento: abrirlo y bajar su garantía.
  await expect(row.getByRole('button', { name: `Ver la venta ${sale.sequence}` })).toBeEnabled();
  await expect(row.getByRole('link', { name: `Descargar la garantía ${sale.warrantyNumber}` }))
    .toHaveAttribute('href', `/api/sales/${sale.id}/warranty.pdf`);

  // La lista es la del contrato: exactamente esa venta, con los mismos valores persistidos.
  const listed = await salesSearch(branch, sale.warrantyNumber);
  expect(listed.total_sales).toBe(1);
  expect(listed.sales[0]).toMatchObject({
    id: sale.id, branch_sequence: sale.sequence, warranty_number: sale.warrantyNumber,
    payment_method: 'cash', customer_name: sale.customer.name, total: sale.total,
    created_at: sale.createdAt, lines: 1, units_total: 1, units_with_warranty: 1,
  });
});

test('el detalle de la venta se despliega en su fila con sus series, su plazo y su cobro',
  async ({ page, api }) => {
    const branch = await api.as(branchA);
    const warehouse = await api.as(warehouseRole);
    const battery = await arrangeSellableBattery({ branch, warehouse });
    const sale = await arrangeSale(branch, battery, 24);

    await openHistory(page);
    await page.getByLabel('Buscar venta').fill(sale.warrantyNumber);
    const row = historyRow(page, sale.sequence);
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: `Ver la venta ${sale.sequence}` }).click();

    // El documento desplegado es el de la fila: su número, su fecha y el cliente del papel.
    const detail = saleDetailPanel(page, sale.sequence);
    await expect(detail).toBeVisible();
    await expect(detail.getByRole('heading', { level: 3 }))
      .toHaveText(`Venta #${sale.sequence} · Garantía ${sale.warrantyNumber}`);
    await expect(detail.locator('time').first()).toHaveAttribute('datetime', sale.createdAt);
    await expect(detail).toContainText(
      `${sale.customer.name} · ${sale.customer.address} · ${sale.customer.phone} · ${sale.customer.document}`);

    // La línea conserva la batería, el precio cobrado y el piso que la sucursal tenía al vender.
    await expect(detail.locator('td[data-label="Batería"]')).toContainText(`${battery.brand} ${battery.model}`);
    await expect(detail.locator('td[data-label="Batería"]'))
      .toContainText(`${battery.capacityAh} Ah · ${battery.polarity}`);
    await expect(detail.locator('td[data-label="Cantidad"]')).toHaveText(`1 × ${money(sale.total)}`);
    await expect(detail.locator('td[data-label="Precio unitario"]')).toContainText(money(sale.total));
    await expect(detail.locator('td[data-label="Precio unitario"]'))
      .toContainText(`Mínimo al vender ${money(battery.minPrice)}`);
    // Cada batería con la serie que se llevó el cliente y el plazo que se le prometió.
    await expect(detail.locator('td[data-label="Unidades"]')).toContainText(sale.serial);
    await expect(detail.locator('td[data-label="Unidades"]')).toContainText('24 meses');
    await expect(detail.locator('td[data-label="Subtotal"]')).toHaveText(money(sale.total));
    // Y el cobro, con el monto con el que se pagó y el total del documento.
    const payment = detail.getByRole('listitem').filter({ hasText: 'Efectivo' });
    await expect(payment).toContainText(money(sale.total));
    await expect(detail.getByText('Total', { exact: true }).locator('..')).toContainText(money(sale.total));

    // Lo desplegado es lo guardado: el detalle del contrato dice lo mismo.
    const persisted = await saleDetail(branch, sale.id);
    expect(persisted.lines.map(line => [line.variant_id, line.brand, line.model, line.capacity_ah, line.polarity]))
      .toEqual([[battery.variantId, battery.brand, battery.model, battery.capacityAh, battery.polarity]]);
    expect(persisted.lines[0].units).toEqual([{ serial_number: sale.serial, warranty_months: 24 }]);
    expect(persisted.payments).toEqual([{ method: 'cash', amount: sale.total }]);
    expect(persisted.customer_name).toBe(sale.customer.name);
    expect(persisted.total).toBe(sale.total);

    // El detalle se vuelve a cerrar en la misma fila.
    await row.getByRole('button', { name: `Ver la venta ${sale.sequence}` }).click();
    await expect(detail).toBeHidden();
  });

test('la garantía de la venta se descarga como PDF desde su fila del historial', async ({ page, api }) => {
  const branch = await api.as(branchA);
  const warehouse = await api.as(warehouseRole);
  const battery = await arrangeSellableBattery({ branch, warehouse });
  const sale = await arrangeSale(branch, battery);
  const fileName = `garantia-${sale.warrantyNumber}.pdf`;

  // El contrato publica la descarga: el mismo nombre estable, el mismo tipo y el documento entero.
  const reply = await branch.request.get(`/api/sales/${sale.id}/warranty.pdf`);
  expect(reply.status()).toBe(200);
  expect(reply.headers()['content-type']).toBe('application/pdf');
  expect(reply.headers()['content-disposition']).toBe(`attachment; filename="${fileName}"`);
  const published = await reply.body();
  expect(published.subarray(0, 5).toString()).toBe('%PDF-');

  // Y el operador la baja desde la fila de la venta, con la acción PDF de esa misma fila.
  await openHistory(page);
  await page.getByLabel('Buscar venta').fill(sale.warrantyNumber);
  const row = historyRow(page, sale.sequence);
  const link = row.getByRole('link', { name: `Descargar la garantía ${sale.warrantyNumber}` });
  await expect(link).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);

  expect(download.suggestedFilename()).toBe(fileName);
  expect(await download.failure()).toBeNull();
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const delivered = Buffer.concat(chunks);
  expect(delivered.subarray(0, 5).toString()).toBe('%PDF-');
  expect(delivered.length).toBe(published.length);
});
