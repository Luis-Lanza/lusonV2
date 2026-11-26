import {
  arrangePurchase, branchA, cents, expect, kindButton, lastPrices, loadPurchaseFund, milliFromWire, money,
  openPurchaseDialog, openPurchases, publishedMaterials, scrapPriceField, scrapMaterialField, test,
  uniqueModel, uniqueNote, usedModelField, usedPriceField, warehouseRole,
} from './harness';

/**
 * S2 · el precio de la última compra, recorrido en el navegador (T4).
 *
 * El mostrador no sabe de memoria a cuánto compró la sucursal, así que la pantalla ancla cada campo de
 * precio en la última compra de ese modelo y de ese material, y lo dice con la fecha del documento que
 * la sostiene. La prueba compra dos veces el mismo modelo a precios distintos para que el ancla tenga que
 * ser la última y no la primera, y un modelo que nadie compró para que el campo lo declare en vez de
 * callarse.
 *
 * El ancla de la chatarra se contrasta con la lectura del contrato en el mismo instante
 * (`apps/api/docs/purchases.md`): el material es una lista de referencia compartida, así que el precio
 * no puede ser un valor que la prueba recuerde de su propio arreglo. Las compras las registra la API
 * pública de la misma sesión (S3).
 */

test('la pantalla ancla el precio de cada línea en la última compra de la sucursal', async ({ page, api }) => {
  const branch = await api.as(branchA);
  const warehouse = await api.as(warehouseRole);
  await loadPurchaseFund({ branch, warehouse }, cents('1000000.00'));
  const materials = await publishedMaterials(branch);
  const copper = materials.find(entry => entry.name === 'Cobre');
  if (copper === undefined) throw new Error('el contrato no publica el material Cobre');

  // Dos compras del mismo modelo: el ancla tiene que ser la segunda, la más reciente.
  const model = uniqueModel('ANCLA');
  await arrangePurchase(branch, {
    note: uniqueNote('ancla-uno'), used: [{ model, quantity: 1, priceCents: cents('18000.00') }],
  });
  const latest = await arrangePurchase(branch, {
    note: uniqueNote('ancla-dos'), used: [{ model, quantity: 1, priceCents: cents('19000.00') }],
  });
  const copperPrice = cents('7200.00');
  await arrangePurchase(branch, {
    note: uniqueNote('ancla-chatarra'),
    scrap: [{ materialId: copper.id, kgMilli: milliFromWire('2.000'), pricePerKg: copperPrice }],
  });
  const never = uniqueModel('SINCOMPRA');

  // El ancla que la pantalla va a mostrar, leída del contrato justo antes de abrirla.
  const anchors = await lastPrices(branch);
  const modelAnchor = anchors.models.find(entry => entry.model === model);
  if (modelAnchor === undefined) throw new Error(`el contrato no publica el ancla del modelo ${model}`);
  const materialAnchor = anchors.materials.find(entry => entry.material_id === copper.id);
  if (materialAnchor === undefined) throw new Error(`el contrato no publica el ancla del material ${copper.id}`);

  await openPurchases(page);
  const dialog = await openPurchaseDialog(page);

  // La usada: al tipear el modelo, el precio dice a cuánto se compró la última vez.
  await usedModelField(dialog).fill(model);
  const modelHint = usedPriceField(dialog).locator('..');
  await expect(modelHint.getByText(`Última: ${money(cents(modelAnchor.unit_price))}`)).toBeVisible();
  await expect(modelHint.getByText(`Última: ${money(cents('19000.00'))}`)).toBeVisible();
  await expect(modelHint.getByText('sin compras previas de este modelo')).toHaveCount(0);

  // Un modelo que nadie compró no trae ancla: el campo lo dice en vez de callarse.
  await usedModelField(dialog).fill(never);
  await expect(modelHint.getByText('sin compras previas de este modelo')).toBeVisible();
  await expect(modelHint.getByText(/^Última:/)).toHaveCount(0);

  // La chatarra: el material es el que sostiene el precio de la última compra del kilo.
  await kindButton(dialog, 'scrap').click();
  await scrapMaterialField(dialog).selectOption(String(copper.id));
  await expect(scrapPriceField(dialog).locator('..')
    .getByText(`Última: ${money(cents(materialAnchor.price_per_kg))}`)).toBeVisible();

  // Las dos anclas son las únicas que la sucursal tiene para esos dos documentos.
  expect(modelAnchor).toEqual({
    model, unit_price: '19000.00', purchased_at: latest.document.created_at,
  });
  expect(materialAnchor).toMatchObject({ material_id: copper.id, price_per_kg: '7200.00' });
  expect(anchors.models.some(entry => entry.model === never)).toBe(false);
});
