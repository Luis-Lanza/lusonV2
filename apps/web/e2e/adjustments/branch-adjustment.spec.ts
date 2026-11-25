import {
  actOfTheLocation, appliedDocument, applyCount, arrangeCountedVariant, branchA, expect, motive,
  openAdjustmentHistory, test,
} from './harness';
import { sellableExisting } from '../warranty/harness';

/**
 * S36 · el ajuste de la sucursal, recorrido en el navegador.
 *
 * El ajuste existía sólo para el Almacén (`LS005`), así que una diferencia real de la sucursal no tenía
 * ninguna salida: la única forma de arreglarla era falsear una transferencia, que afirma un recorrido que
 * no ocurrió. El mismo documento ahora pertenece al local de la sesión, y esta prueba recorre ese acto
 * como lo hace el operador de la sucursal: entra por su propia navegación, cuenta su stock vendible sin
 * ver el esperado, lo aplica con un motivo y lee el documento que quedó guardado en su local.
 *
 * La góndola es la del sembrado y la prueba la devuelve a donde estaba: el segundo conteo —también por
 * pantalla— la deja con las mismas existencias con las que empezó. Lo único que queda es el historial de
 * los dos documentos, que es lo que el acto produce y no se borra nunca.
 *
 * Lo que el flujo no ejercita —el cierre de la rendición que congela la sucursal— se cubre en el test de
 * modelo y de componente del `409 branch_frozen`: abrir una rendición de verdad congelaría a la sucursal
 * para el resto de la suite, que vende y ajusta en ella.
 */

test('la sucursal abre el ajuste de su propio stock y el acto dice de qué local es', async ({ page }) => {
  await openAdjustmentHistory(page);

  // El local del acto es el de la sesión: la sucursal ve su nombre y no el ajuste del Almacén.
  await expect(actOfTheLocation(page)).toContainText('El ajuste mueve el stock vendible de Sucursal A.');
  await expect(page.getByText('SUCURSAL A / AJUSTES')).toBeVisible();
  await expect(page.getByText('ALMACÉN / AJUSTES')).toHaveCount(0);

  // La sección está en la navegación de la sucursal y su hash propio la restaura.
  await expect(page.getByRole('button', { name: 'Ajustes' })).toHaveAttribute('aria-current', 'page');
  expect(new URL(page.url()).hash).toBe('#/ajustes');

  // Y no ganó ninguna sección del Almacén: el ajuste es lo único que se abrió de este lado.
  await expect(page.getByRole('button', { name: 'Ingresos' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Catálogo' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Rendiciones' })).toHaveCount(0);
});

test('el conteo de la sucursal aplica el documento de su local y mueve su stock vendible',
  async ({ page, api }) => {
    const branch = await api.as(branchA);
    const variant = await arrangeCountedVariant(branch);
    const before = await sellableExisting(branch, variant.variantId);
    expect(before).toBe(variant.existing);

    // El acto: la sucursal cuenta una unidad más de las que tiene y lo aplica con un motivo.
    await openAdjustmentHistory(page);
    const counted = before + 1;
    const document = await applyCount(page, branch, variant, counted);

    // El documento abierto por la propia pantalla publica el esperado, lo contado y la diferencia.
    const panel = appliedDocument(page, document.id);
    await expect(panel).toBeVisible();
    const line = panel.locator(`tr[data-variant-id="${variant.variantId}"]`);
    await expect(line).toContainText(variant.name);
    await expect(line.locator('td[data-label="Esperado"]')).toHaveText(String(before));
    await expect(line.locator('td[data-label="Contado"]')).toHaveText(String(counted));
    await expect(line.locator('td[data-label="Diferencia"]')).toHaveText('+1');
    await expect(panel).toContainText(motive);

    // El documento es de la sucursal, no del Almacén, y su aritmética es la del acto.
    expect(document.location_id).toBe(branch.locationId);
    expect(document.location_id).toBe(2);
    expect(document.reason).toBe(motive);
    expect(document.reverses_adjustment_id).toBeNull();
    expect(document.lines.map(row => [row.variant_id, row.expected_quantity, row.counted_quantity, row.difference]))
      .toEqual([[variant.variantId, before, counted, 1]]);
    expect(document.total_difference).toBe(1);

    // El stock vendible de la sucursal quedó exactamente en lo contado.
    expect(await sellableExisting(branch, variant.variantId)).toBe(counted);

    // La góndola vuelve a donde estaba: otro conteo por pantalla, nunca una corrección invisible.
    await openAdjustmentHistory(page);
    const restored = await applyCount(page, branch, variant, before);
    expect(restored.id).not.toBe(document.id);
    expect(restored.location_id).toBe(2);
    expect(restored.lines.map(row => row.difference)).toEqual([-1]);
    expect(await sellableExisting(branch, variant.variantId)).toBe(before);
  });
