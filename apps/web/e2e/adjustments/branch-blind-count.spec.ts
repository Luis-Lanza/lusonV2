import {
  appliedDocument, applyCount, arrangeCountedVariant, branchA, expect, motive, openAdjustmentHistory, test,
} from './harness';
import { countDrawer, countLine, openCount, readLedger } from './actsHarness';
import { sellableExisting } from '../warranty/harness';

/**
 * T12 · los dos desenlaces del conteo de la sucursal que su spec no recorre.
 *
 * El ajuste de la sucursal (`branch-adjustment.spec.ts`) cubre el acto completo: abrir el historial,
 * contar sin ver el esperado y aplicarlo. Le faltan los dos desenlaces que un operador encuentra en el
 * mismo lugar: contar **de más** —el primero de sus conteos suma una unidad y después la devuelve, así
 * que la diferencia positiva sólo se lee de paso— y aplicar **sin motivo**, donde la pantalla se niega
 * antes de enviar nada y el documento, las líneas y el stock tienen que quedar exactamente igual.
 *
 * El conteo es sobre la góndola de la sucursal, leída por el mismo catálogo del punto de venta. La prueba
 * devuelve la góndola a donde estaba con otro conteo por pantalla, no con una corrección invisible: si el
 * segundo conteo no se aplicara, la corrida siguiente encontraría otro stock y el arreglo dejaría de ser
 * el mismo.
 */

test('el conteo ciego de la sucursal sube el stock cuando se cuenta de más', async ({ page, api }) => {
  const branch = await api.as(branchA);
  const variant = await arrangeCountedVariant(branch);
  const before = await sellableExisting(branch, variant.variantId);
  expect(before).toBe(variant.existing);

  // El acto: la sucursal cuenta dos unidades más de las que tiene y aplica el documento con un motivo.
  await openAdjustmentHistory(page);
  const counted = before + 2;
  const document = await applyCount(page, branch, variant, counted);

  // La diferencia es positiva y la aritmética del documento es la del acto, en el local de la sesión.
  expect(document.location_id).toBe(branch.locationId);
  expect(document.location_id).toBe(2);
  expect(document.reason).toBe(motive);
  expect(document.reverses_adjustment_id).toBeNull();
  expect(document.lines.map(row => [row.variant_id, row.expected_quantity, row.counted_quantity, row.difference]))
    .toEqual([[variant.variantId, before, counted, 2]]);
  expect(document.total_difference).toBe(2);

  // La góndola quedó con lo contado: el conteo de más suma stock, no lo resta.
  expect(await sellableExisting(branch, variant.variantId)).toBe(counted);

  // La pantalla abre el documento aplicado y muestra la diferencia con su signo.
  const panel = appliedDocument(page, document.id);
  await expect(panel).toBeVisible();
  const line = panel.locator(`tr[data-variant-id="${variant.variantId}"]`);
  await expect(line.locator('td[data-label="Esperado"]')).toHaveText(String(before));
  await expect(line.locator('td[data-label="Contado"]')).toHaveText(String(counted));
  await expect(line.locator('td[data-label="Diferencia"]')).toHaveText('+2');

  // La góndola vuelve a donde estaba: otro conteo por pantalla, nunca una corrección invisible.
  await openAdjustmentHistory(page);
  const restored = await applyCount(page, branch, variant, before);
  expect(restored.id).not.toBe(document.id);
  expect(restored.lines.map(row => [row.expected_quantity, row.counted_quantity, row.difference]))
    .toEqual([[counted, before, -2]]);
  expect(restored.total_difference).toBe(-2);
  expect(await sellableExisting(branch, variant.variantId)).toBe(before);
});

test('el ajuste sin motivo se rechaza en el borrador y no escribe ningún documento', async ({ page, api }) => {
  const branch = await api.as(branchA);
  const variant = await arrangeCountedVariant(branch);
  const before = await sellableExisting(branch, variant.variantId);
  const ledger = await readLedger(branch);

  // El operador carga lo que contó —una unidad más— y se olvida del motivo.
  await openAdjustmentHistory(page);
  const drawer = await openCount(page, 'Sucursal A');
  const counted = before + 1;
  await countLine(drawer, variant, counted);
  await drawer.getByRole('button', { name: 'Aplicar ajuste' }).click();

  // La pantalla se niega antes de enviar nada y lo dice como un aviso del borrador, no como progreso.
  await expect(drawer.getByRole('status')).toHaveText('Elegí un motivo del ajuste antes de aplicar.');
  // El borrador sigue abierto con el conteo cargado: nada se perdió y nada se aplicó.
  await expect(drawer).toBeVisible();
  await expect(drawer.locator(`tr[data-variant-id="${variant.variantId}"]`).getByRole('spinbutton'))
    .toHaveValue(String(counted));
  await expect(page.getByRole('status').filter({ hasText: /Ajuste #\d+ aplicado/ })).toHaveCount(0);

  // Nada se escribió: el historial del local no ganó ningún documento y el stock vendible no se movió.
  const after = await readLedger(branch);
  expect(after.total_adjustments).toBe(ledger.total_adjustments);
  expect(after.adjustments.map(row => row.id)).toEqual(ledger.adjustments.map(row => row.id));
  expect(await sellableExisting(branch, variant.variantId)).toBe(before);

  // El borrador sigue abierto con su conteo y el historial no ganó una fila: el acto no ocurrió.
  await expect(countDrawer(page)).toBeVisible();
  const newest = ledger.adjustments[0];
  if (newest !== undefined) {
    await expect(page.locator('tr.adjustment-row').first())
      .toHaveAttribute('data-adjustment-id', String(newest.id));
  }
});
