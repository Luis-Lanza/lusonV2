import {
  addBattery, addUnit, amountOf, arrangeCustomer, arrangeSale, arrangeSellableBattery, branchA, cartHeading,
  cartTotal, cents, chargeButton, counterCart, counterNotice, counterProblem, counterShelf, expect, fillCustomer,
  issuedPanel, lineTotal, money, openCounter, payCash, priceField, saleDetail, salesSearch, serialField, test,
  typed, uniqueSerial, warehouseRole, warrantyField, writeSerial, writeWarranty,
} from './harness';

/**
 * S2 · el punto de venta de la sucursal (T3), recorrido en el navegador: abrir el mostrador, agregar una
 * batería con la serie que se lee y el plazo que se promete, registrar el cobro y el cliente, y cobrar.
 *
 * Cada prueba es un acto del operador y afirma lo que la pantalla muestra; cuando el acto escribe, además
 * lee el documento guardado por el contrato que el servidor publica (`apps/api/docs/sales.md`) y lo
 * contrasta con lo que la pantalla dijo. Las precondiciones —la góndola con stock y el precio que la
 * sucursal necesita para venderla— se arreglan por esa misma API (S3); la venta que la prueba cobra la
 * hace siempre el mostrador.
 *
 * Las negativas que la pantalla misma sostiene también se recorren acá: una venta sin pago, una batería
 * sin serie, una serie que ya se vendió, una serie repetida en dos unidades y un precio por debajo del
 * mínimo de la sucursal. Cuando la negativa deja el documento sin registrar, la prueba lo comprueba: el
 * historial de la sucursal no gana ninguna venta con el cliente que el mostrador tipeó.
 */

test('la sucursal abre su punto de venta y consulta la góndola vendible del mostrador', async ({ page, api }) => {
  const branch = await api.as(branchA);
  const shelf = await counterShelf(branch);
  const variants = shelf.total_variants === 1 ? 'variante' : 'variantes';
  const lastRow = shelf.items.length;

  // El operador entra por su propia navegación, no por una URL tipeada.
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Inventario' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Punto de venta' })).toBeEnabled();
  await page.getByRole('button', { name: 'Punto de venta' }).click();

  await expect(page.getByRole('heading', { level: 1, name: 'Nueva venta' })).toBeVisible();
  expect(new URL(page.url()).hash).toBe('#/ventas');
  await expect(page.getByRole('button', { name: 'Punto de venta' })).toHaveAttribute('aria-current', 'page');
  // El mostrador es de la sucursal de la sesión y no de otra: el encabezado y la ayuda lo dicen.
  await expect(page.getByText('SUCURSAL / PUNTO DE VENTA')).toBeVisible();
  await expect(page.getByText(/Sólo las baterías con precio cargado en Sucursal A se pueden vender/)).toBeVisible();
  // Y no ganó ninguna sección del Almacén: el mostrador es lo único que se abrió de este lado.
  await expect(page.getByRole('button', { name: 'Ingresos' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Catálogo' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Rendiciones' })).toHaveCount(0);

  // La góndola es la que el contrato publica: las mismas variantes, el mismo total y la misma página.
  await expect(page.getByRole('heading', { level: 2, name: 'Baterías' })).toBeVisible();
  await expect(page.getByText(`${shelf.total_variants} ${variants} · las que no tienen precio quedan bloqueadas`))
    .toBeVisible();
  await expect(page.getByText(`${lastRow} en esta página`)).toBeVisible();
  await expect(page.getByText(`Mostrando 1–${lastRow} de ${shelf.total_variants} ${variants}`)).toBeVisible();

  // La venta en curso empieza vacía y el mostrador dice qué le falta para poder cobrar.
  await expect(cartHeading(page)).toContainText('0 líneas');
  await expect(counterNotice(page)).toHaveText('Agregá al menos un producto o una batería para cobrar.');
  await expect(chargeButton(page)).toBeDisabled();

  // El hash propio del mostrador lo restaura: recargar vuelve a la misma pantalla.
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Nueva venta' })).toBeVisible();
  expect(new URL(page.url()).hash).toBe('#/ventas');
});

test('el mostrador agrega una batería a la venta con la serie que lee y el plazo que promete',
  async ({ page, api }) => {
    const branch = await api.as(branchA);
    const warehouse = await api.as(warehouseRole);
    const battery = await arrangeSellableBattery({ branch, warehouse });
    const serial = uniqueSerial('VTA');

    await openCounter(page);
    await addBattery(page, battery);

    // La línea nace con una unidad, al precio sugerido de la sucursal y con su piso a la vista.
    await expect(cartHeading(page)).toContainText('1 línea');
    await expect(priceField(page, battery)).toHaveValue(typed(battery.suggestedPrice));
    await expect(counterCart(page).getByText(`Mínimo autorizado ${money(battery.minPrice)}`)).toBeVisible();
    await expect(cartTotal(page)).toContainText(money(battery.suggestedPrice));

    // Cada batería es una unidad con su serie y su plazo; el de la venta empieza en doce meses.
    await expect(counterCart(page).getByText('Unidad 1')).toBeVisible();
    await expect(counterCart(page).getByText('12 meses')).toBeVisible();
    await expect(serialField(page, battery)).toHaveValue('');
    await expect(warrantyField(page, battery)).toHaveValue('12');

    // El mostrador lee la serie de la batería que tiene en la mano.
    await writeSerial(page, battery, serial);
    await expect(serialField(page, battery)).toHaveValue(serial);

    // Y escribe el plazo que promete: el de la unidad manda sobre el de la línea.
    await writeWarranty(page, battery, 18);
    await expect(warrantyField(page, battery)).toHaveValue('18');
    await expect(counterCart(page).getByText('18 meses')).toBeVisible();
    await expect(counterCart(page).getByText('12 meses')).toHaveCount(0);

    // El acto todavía no escribe nada: el documento nace recién cuando el mostrador cobra.
    await expect(chargeButton(page)).toBeDisabled();
  });

test('el mostrador registra el cobro y los datos del cliente antes de cobrar la venta',
  async ({ page, api }) => {
    const branch = await api.as(branchA);
    const warehouse = await api.as(warehouseRole);
    const battery = await arrangeSellableBattery({ branch, warehouse });
    const customer = arrangeCustomer('cobro');
    const total = money(battery.suggestedPrice);

    await openCounter(page);
    await addBattery(page, battery);
    await writeSerial(page, battery, uniqueSerial('VTA'));

    // Sin pago la venta no se puede cobrar, y el mostrador dice cuánto falta en vez de callarse.
    await expect(counterCart(page).getByText(`Faltan ${total} para cubrir el total.`)).toBeVisible();
    await expect(counterNotice(page)).toHaveCount(0);
    await expect(chargeButton(page)).toBeDisabled();

    // Un solo monto cubre el total: el cobro queda cerrado.
    await payCash(page, battery.suggestedPrice);
    await expect(counterCart(page).getByText(`Suma ${total} · cubre el total`)).toBeVisible();

    // El cobro no alcanza: la garantía nombra al cliente, y la pantalla pide el dato exacto que falta.
    await expect(chargeButton(page)).toBeDisabled();
    await expect(counterNotice(page)).toHaveText('Escribí el nombre del cliente: la garantía lo exige.');
    await counterCart(page).getByLabel('Cliente').fill(customer.name);
    await expect(counterNotice(page)).toHaveText('Escribí el teléfono del cliente: la garantía lo exige.');
    await counterCart(page).getByLabel('Teléfono').fill(customer.phone);
    await expect(counterNotice(page)).toHaveText('Escribí el documento del cliente: la garantía lo exige.');
    await counterCart(page).getByLabel('Documento').fill(customer.document);

    // Con el papel completo el mostrador ya puede cobrar; la dirección no es obligatoria.
    await expect(counterNotice(page)).toHaveCount(0);
    await expect(chargeButton(page)).toBeEnabled();
    await counterCart(page).getByLabel('Dirección o barrio').fill(customer.address);
    await expect(chargeButton(page)).toBeEnabled();
    await expect(counterCart(page).getByLabel('Dirección o barrio')).toHaveValue(customer.address);
  });

test('el mostrador cobra la venta y emite la garantía con la serie y el plazo que registró',
  async ({ page, api }) => {
    const branch = await api.as(branchA);
    const warehouse = await api.as(warehouseRole);
    const battery = await arrangeSellableBattery({ branch, warehouse });
    const customer = arrangeCustomer('emitida');
    const serial = uniqueSerial('VTA');

    await openCounter(page);
    await addBattery(page, battery);
    await writeSerial(page, battery, serial);
    await writeWarranty(page, battery, 24);
    await payCash(page, battery.suggestedPrice);
    await fillCustomer(page, customer);
    await expect(chargeButton(page)).toBeEnabled();
    await chargeButton(page).click();

    // La pantalla publica el documento emitido con el número que asignó el servidor.
    const issued = issuedPanel(page);
    await expect(issued.getByRole('heading', { name: 'Venta emitida' })).toBeVisible();
    const listed = await salesSearch(branch, customer.name);
    expect(listed.total_sales).toBe(1);
    const [summary] = listed.sales;
    await expect(issued.getByText(`Venta #${summary.branch_sequence} · Garantía ${summary.warranty_number}`))
      .toBeVisible();
    await expect(issued).toContainText(`1 línea · ${money(battery.suggestedPrice)}`);
    await expect(issued).toContainText(`Efectivo: ${money(battery.suggestedPrice)}`);
    // El comprobante se descarga desde el mismo documento emitido.
    await expect(issued.getByRole('link', { name: 'Descargar PDF' }))
      .toHaveAttribute('href', `/api/sales/${summary.id}/warranty.pdf`);

    // La venta en curso quedó vacía: el documento se cerró y el mostrador empieza otra.
    await expect(cartHeading(page)).toContainText('0 líneas');
    await expect(chargeButton(page)).toBeDisabled();

    // Y lo guardado es lo que la pantalla dijo: la serie, su plazo, el cliente y el cobro, tal cual.
    expect(summary.payment_method).toBe('cash');
    expect(summary.total).toBe(battery.suggestedPrice);
    expect(summary.units_total).toBe(1);
    expect(summary.units_with_warranty).toBe(1);
    expect(summary.lines).toBe(1);
    const persisted = await saleDetail(branch, summary.id);
    expect(persisted.lines.map(line => [line.variant_id, line.quantity, line.unit_price, line.min_price]))
      .toEqual([[battery.variantId, 1, battery.suggestedPrice, battery.minPrice]]);
    expect(persisted.lines[0].units).toEqual([{ serial_number: serial, warranty_months: 24 }]);
    expect(persisted.customer).toEqual({
      name: customer.name, phone: customer.phone, document: customer.document, address: customer.address,
    });
    expect(persisted.payments).toEqual([{ method: 'cash', amount: battery.suggestedPrice }]);
    expect(persisted.total).toBe(battery.suggestedPrice);
    expect(persisted.created_at).toBe(summary.created_at);
  });

test('no cobra una venta sin pago: el mostrador ve cuánto falta y no se registra nada',
  async ({ page, api }) => {
    const branch = await api.as(branchA);
    const warehouse = await api.as(warehouseRole);
    const battery = await arrangeSellableBattery({ branch, warehouse });
    const customer = arrangeCustomer('sinpago');

    await openCounter(page);
    await addBattery(page, battery);
    await writeSerial(page, battery, uniqueSerial('VTA'));
    await fillCustomer(page, customer);

    // Todo está cargado salvo el cobro: el mostrador ve la diferencia exacta y no puede cobrar.
    await expect(counterCart(page).getByText(`Faltan ${money(battery.suggestedPrice)} para cubrir el total.`))
      .toBeVisible();
    await expect(chargeButton(page)).toBeDisabled();
    await expect(counterProblem(page)).toHaveCount(0);

    // Y nada se registró: el historial de la sucursal no tiene ninguna venta de este cliente.
    expect((await salesSearch(branch, customer.name)).total_sales).toBe(0);
  });

test('no cobra una batería sin número de serie: la serie se lee de la batería y se anota',
  async ({ page, api }) => {
    const branch = await api.as(branchA);
    const warehouse = await api.as(warehouseRole);
    const battery = await arrangeSellableBattery({ branch, warehouse });
    const customer = arrangeCustomer('sinserie');

    await openCounter(page);
    await addBattery(page, battery);
    await payCash(page, battery.suggestedPrice);
    await fillCustomer(page, customer);

    // El resto de la venta está cerrado, pero la unidad no tiene serie: el mostrador no cobra.
    await expect(counterNotice(page))
      .toHaveText('Cada batería lleva su número de serie: leelo de la batería y anotalo.');
    await expect(chargeButton(page)).toBeDisabled();
    expect((await salesSearch(branch, customer.name)).total_sales).toBe(0);
  });

test('rechaza una serie que ya se vendió, la nombra y no registra nada', async ({ page, api }) => {
  const branch = await api.as(branchA);
  const warehouse = await api.as(warehouseRole);
  const battery = await arrangeSellableBattery({ branch, warehouse });
  const sold = await arrangeSale(branch, battery);
  const customer = arrangeCustomer('repetida');

  await openCounter(page);
  await addBattery(page, battery);
  await writeSerial(page, battery, sold.serial);
  await payCash(page, battery.suggestedPrice);
  await fillCustomer(page, customer);
  await expect(chargeButton(page)).toBeEnabled();
  await chargeButton(page).click();

  // El servidor comparó la serie y la pantalla nombra la unidad de esta venta que la lleva.
  await expect(counterProblem(page)).toHaveText(
    `El número de serie ${sold.serial} ya se vendió: lo lleva la unidad 1 de ${battery.label}.`
    + ' Corregí ese serial antes de cobrar. No se registró nada.');
  // El mostrador conserva la venta armada para corregir la serie, y nada quedó registrado.
  await expect(serialField(page, battery)).toHaveValue(sold.serial);
  expect((await salesSearch(branch, customer.name)).total_sales).toBe(0);
  // La venta que ya tenía esa serie sigue siendo la única: la serie se vendió una sola vez.
  expect((await salesSearch(branch, sold.warrantyNumber)).total_sales).toBe(1);
  expect((await saleDetail(branch, sold.id)).lines[0].units)
    .toEqual([{ serial_number: sold.serial, warranty_months: sold.months }]);
});

test('no cobra dos unidades de la venta con el mismo número de serie', async ({ page, api }) => {
  const branch = await api.as(branchA);
  const warehouse = await api.as(warehouseRole);
  const battery = await arrangeSellableBattery({ branch, warehouse });
  const customer = arrangeCustomer('duplicada');
  const serial = uniqueSerial('VTA');

  await openCounter(page);
  await addBattery(page, battery);
  await addUnit(page, battery);
  await writeSerial(page, battery, serial, 1);
  await writeSerial(page, battery, serial, 2);
  await payCash(page, lineTotal(battery, 2));
  await fillCustomer(page, customer);

  // Dos unidades con la misma serie no son dos baterías: la pantalla lo dice antes de cobrar.
  await expect(counterNotice(page))
    .toHaveText('Ese número de serie ya está en esta venta: cada batería se vende una sola vez.');
  await expect(chargeButton(page)).toBeDisabled();
  expect((await salesSearch(branch, customer.name)).total_sales).toBe(0);
});

test('el precio por debajo del mínimo de la sucursal se rechaza y no rebaja la venta',
  async ({ page, api }) => {
    const branch = await api.as(branchA);
    const warehouse = await api.as(warehouseRole);
    const battery = await arrangeSellableBattery({ branch, warehouse });
    const below = amountOf(cents(battery.minPrice) - 100n);

    await openCounter(page);
    await addBattery(page, battery);
    await priceField(page, battery).fill(typed(below));

    // El piso autorizado no se negocia en el mostrador: la pantalla lo nombra.
    await expect(counterProblem(page))
      .toHaveText(`El precio no puede quedar por debajo del mínimo autorizado ${money(battery.minPrice)}.`);
    // Y la línea conserva el precio sugerido: el intento no rebajó la venta que se va a cobrar.
    await expect(cartTotal(page)).toContainText(money(battery.suggestedPrice));
  });
