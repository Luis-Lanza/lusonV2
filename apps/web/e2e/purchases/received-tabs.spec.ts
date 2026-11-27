import {
  arrangePurchase, branchA, cents, expect, formatKg, loadPurchaseFund, milliFromWire, money,
  openPurchases, periodNote, periodSelect, publishedMaterials, purchasesPanel, purchasesTab,
  purchaseListing, receivedTotals, test, uniqueModel, uniqueNote, warehouseRole,
} from './harness';

/**
 * S2 · lo que la sucursal recibió y lo que todavía guarda, consultado por sus pestañas (T4).
 *
 * La pantalla abre en el saldo abierto del período: lo comprado menos lo que contaron las rendiciones
 * cerradas, por modelo y por material. Al elegir el historial entero, las mismas pestañas publican lo
 * recibido con su valor, que es la suma de las líneas de cada documento.
 *
 * Las dos pruebas consultan: la compra que cada pestaña publica la registra la API pública de la misma
 * sesión (S3). La usada se busca por su modelo, que es único de esta corrida; la chatarra es una lista de
 * referencia compartida, así que su fila se contrasta con la lectura del contrato en el mismo instante
 * (`apps/api/docs/purchases.md`) en vez de con un número que la prueba recuerde.
 */

test('la pestaña de usadas publica el saldo pendiente del modelo que la sucursal acaba de comprar',
  async ({ page, api }) => {
    const branch = await api.as(branchA);
    const warehouse = await api.as(warehouseRole);
    await loadPurchaseFund({ branch, warehouse }, cents('1000000.00'));
    const model = uniqueModel('SALDO');
    await arrangePurchase(branch, {
      note: uniqueNote('saldo'), used: [{ model, quantity: 2, priceCents: cents('9000.00') }],
    });

    await openPurchases(page);
    // La pantalla arranca en el saldo abierto y lo dice con sus palabras, sin tooltip.
    await expect(periodSelect(page)).toHaveValue('pending');
    await expect(periodNote(page).filter({ hasText: 'saldo abierto' })).toHaveText(
      'Pendiente · saldo abierto, sin corte: lo comprado menos lo que contaron las rendiciones cerradas.');

    await purchasesTab(page, /^Baterías usadas/).click();
    const panel = purchasesPanel(page, /^Baterías usadas/);
    const row = panel.locator(`tr[data-model="${model}"]`);
    await expect(row).toHaveCount(1);
    // Lo comprado, lo entregado y el saldo del modelo, con los préstamos del mostrador en cero.
    await expect(row.locator('td[data-label="Compradas"]')).toHaveText('2');
    await expect(row.locator('td[data-label="Entregadas"]')).toHaveText('0');
    await expect(row.locator('td[data-label="Prestadas"]')).toHaveText('0');
    await expect(row.locator('td[data-label="Devueltas"]')).toHaveText('0');
    await expect(row.locator('td[data-label="Saldo"]')).toHaveText(/^2\s*unidades$/);

    // El saldo es el del contrato: lo comprado menos lo entregado, sin un número que lo repita.
    const listing = await purchaseListing(branch, { pageSize: 25, period: 'pending' });
    expect(listing.balance?.used.find(entry => entry.model === model))
      .toEqual({ model, bought: '2', delivered: '0', balance: '2' });
    expect(listing.period).toMatchObject({ kind: 'pending', label: 'Pendiente' });
    expect(listing.periods[0]).toMatchObject({ kind: 'pending', label: 'Pendiente' });
  });

test('la pestaña de chatarra publica lo recibido por material cuando el período es todo el historial',
  async ({ page, api }) => {
    const branch = await api.as(branchA);
    const warehouse = await api.as(warehouseRole);
    await loadPurchaseFund({ branch, warehouse }, cents('1000000.00'));
    const materials = await publishedMaterials(branch);
    const copper = materials.find(entry => entry.name === 'Cobre');
    if (copper === undefined) throw new Error('el contrato no publica el material Cobre');

    const kg = milliFromWire('5.000');
    await arrangePurchase(branch, {
      note: uniqueNote('recibido'),
      scrap: [{ materialId: copper.id, kgMilli: kg, pricePerKg: cents('7000.00') }],
    });
    // Lo que el contrato publica como recibido de ese material, leído antes de abrir la pantalla.
    const scrap = (await receivedTotals(branch)).scrap.find(entry => entry.material_id === copper.id);
    if (scrap === undefined) throw new Error('la sucursal no tiene chatarra recibida de este material');

    await openPurchases(page);
    // El operador deja el saldo y elige el historial entero: el corte deja de ser el del saldo.
    await periodSelect(page).selectOption('all');
    await expect(periodNote(page).filter({ hasText: 'Todo el historial' })).toHaveText(
      'Todo el historial · sin corte: todos los documentos registrados en la sucursal.');

    await purchasesTab(page, /^Chatarra/).click();
    const panel = purchasesPanel(page, /^Chatarra/);
    const row = panel.locator(`tr[data-material-id="${copper.id}"]`);
    await expect(row).toHaveCount(1);
    // El peso y el valor recibidos de ese material son los que la sucursal compró.
    await expect(row.locator('td[data-label="Material"]')).toHaveText(copper.name);
    await expect(row.locator('td[data-label="Peso recibido"]')).toHaveText(formatKg(milliFromWire(scrap.kg)));
    await expect(row.locator('td[data-label="Valor recibido"]')).toHaveText(money(cents(scrap.value)));
    // Y la pestaña de usadas, en el mismo período, sigue publicando lo recibido por modelo.
    await expect(purchasesTab(page, /^Baterías usadas/).locator('.count')).toBeVisible();
  });
