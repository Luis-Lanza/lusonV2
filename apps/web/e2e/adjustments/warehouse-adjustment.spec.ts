import { actOfTheLocation, appliedDocument, expect, motive, openAdjustmentHistory, test } from './harness';
import {
  applyDocument, arrangeWarehouseVariant, confirmReversal, counterMotive, documentRow, openReversal,
  readDocument, readLedger, warehouseExisting,
} from './actsHarness';
import { warehouseRole } from '../warranty/harness';
import { warehouseSessionState } from '../warranty/sessions';

/**
 * T12 · el ajuste del Almacén, recorrido en el navegador.
 *
 * El ajuste nació como un acto del Almacén (`LS005`) y hoy es el mismo documento para cualquier local
 * (`S36`): este spec recorre esa mitad que el arnés de la sucursal no toca. El Almacén entra por su propia
 * navegación, cuenta a ciegas su stock del almacén —no el de una sucursal—, lo aplica con su motivo, lee el
 * historial de documentos aplicados y corrige uno con su contra-asiento.
 *
 * El stock que se cuenta es el del propio Almacén (`location_id` 1), leído por la consulta de inventario
 * que publica el producto: el esperado del documento tiene que ser esa cifra. Cada documento es inmutable,
 * así que la suite no lo borra; el conteo sube las existencias y el contra-asiento las devuelve a donde
 * estaban, que es la corrección real y no una limpieza invisible.
 *
 * La sesión es la del Almacén y por eso este archivo la fija para todas sus pruebas: los actos de acá no
 * son los de la sucursal. Los documentos que quedan de una corrida no estorban a la siguiente, porque cada
 * prueba arregla su variante y lee sólo su propio documento.
 */

test.use({ storageState: warehouseSessionState });

test('el Almacén abre el ajuste desde su navegación y el acto dice que es el del Almacén',
  async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Ubicación asignada: Almacén')).toBeVisible();

    // El acto se abre como el operador: el botón de la sección, no un hash tipeado.
    await page.getByRole('button', { name: 'Ajustes' }).click();
    await expect(page.getByRole('heading', { name: 'Historial de ajustes' })).toBeVisible();

    // El local del acto es el de la sesión: el Almacén lee su nombre y no el de una sucursal.
    await expect(actOfTheLocation(page)).toContainText('El ajuste mueve el stock vendible de Almacén.');
    await expect(page.getByText('ALMACÉN / AJUSTES')).toBeVisible();
    await expect(page.getByText('SUCURSAL A / AJUSTES')).toHaveCount(0);

    // La sección está en la navegación del Almacén y su hash propio la restaura.
    await expect(page.getByRole('button', { name: 'Ajustes' })).toHaveAttribute('aria-current', 'page');
    expect(new URL(page.url()).hash).toBe('#/ajustes');
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Historial de ajustes' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Ajustes' })).toHaveAttribute('aria-current', 'page');

    // El Almacén conserva sus secciones y no ganó ninguna de la sucursal.
    await expect(page.getByRole('button', { name: 'Ingresos' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Catálogo' })).toBeVisible();
    for (const branchOnly of ['Punto de venta', 'Caja', 'Compras', 'Rendición de cuentas', 'Métricas']) {
      await expect(page.getByRole('button', { name: branchOnly })).toHaveCount(0);
    }
  });

test('el conteo ciego del Almacén cuenta su propio stock del almacén y aplica el documento con su motivo',
  async ({ page, api }) => {
    const warehouse = await api.as(warehouseRole);
    const variant = await arrangeWarehouseVariant(warehouse);
    const before = await warehouseExisting(warehouse, variant);
    expect(before).toBe(variant.existing);

    // El acto: el Almacén cuenta tres unidades más de las que tiene y lo aplica con un motivo.
    // La bandeja no publica el esperado en ningún momento —lo afirma `openCount`— porque el conteo es
    // ciego: la cifra sólo aparece después, en el documento aplicado.
    await openAdjustmentHistory(page);
    const counted = before + 3;
    const document = await applyDocument(page, warehouse, variant, counted, motive, 'Almacén');

    // El documento es del Almacén —no de una sucursal— y su aritmética es la del acto.
    expect(document.location_id).toBe(warehouse.locationId);
    expect(document.location_id).toBe(1);
    expect(document.reason).toBe(motive);
    expect(document.reverses_adjustment_id).toBeNull();
    expect(document.reversed_by).toBeNull();
    expect(document.lines.map(row => [row.variant_id, row.expected_quantity, row.counted_quantity, row.difference]))
      .toEqual([[variant.variantId, before, counted, 3]]);
    expect(document.total_difference).toBe(3);

    // El esperado es la foto del stock del Almacén: las existencias quedaron exactamente en lo contado.
    expect(await warehouseExisting(warehouse, variant)).toBe(counted);

    // La confirmación y el documento abierto dicen lo mismo, con el esperado, lo contado y la diferencia.
    await expect(page.getByRole('status').filter({ hasText: /diferencia total \+3/ })).toHaveCount(1);
    const panel = appliedDocument(page, document.id);
    await expect(panel).toBeVisible();
    const line = panel.locator(`tr[data-variant-id="${variant.variantId}"]`);
    await expect(line.locator('td[data-label="Producto"]')).toContainText(variant.name);
    await expect(line.locator('td[data-label="Esperado"]')).toHaveText(String(before));
    await expect(line.locator('td[data-label="Contado"]')).toHaveText(String(counted));
    await expect(line.locator('td[data-label="Diferencia"]')).toHaveText('+3');
    await expect(panel).toContainText(motive);
    // El resumen del panel nombra el documento que la fila del historial abrió.
    await expect(panel.locator('dd').filter({ hasText: `#${document.id}` })).toHaveText(`#${document.id}`);
  });

test('el historial del Almacén lista los documentos aplicados y abre sus líneas al leerlos',
  async ({ page, api }) => {
    const warehouse = await api.as(warehouseRole);
    const variant = await arrangeWarehouseVariant(warehouse);
    const before = await warehouseExisting(warehouse, variant);

    await openAdjustmentHistory(page);
    const document = await applyDocument(page, warehouse, variant, before + 1, motive, 'Almacén');

    // La bandeja y el contrato cuentan lo mismo: el contador de la pantalla es el total persistido.
    const ledger = await readLedger(warehouse);
    const total = ledger.total_adjustments;
    await expect(page.getByText(`${total} ${total === 1 ? 'documento' : 'documentos'}`, { exact: true }))
      .toBeVisible();
    // El historial va del más nuevo al más viejo: el documento recién aplicado encabeza la lista, y la
    // fila publica el tipo, el motivo, las líneas, la diferencia y el estado que el contrato resume.
    expect(ledger.adjustments[0]?.id).toBe(document.id);
    const row = documentRow(page, document.id);
    await expect(page.locator('tr.adjustment-row').first()).toHaveAttribute('data-adjustment-id',
      String(document.id));
    await expect(row).toBeVisible();
    await expect(row.locator('td[data-label="Documento"]')).toHaveText(`#${document.id}`);
    await expect(row.locator('td[data-label="Tipo"]')).toHaveText('Baterías');
    await expect(row.locator('td[data-label="Motivo"]')).toContainText(motive);
    await expect(row.locator('td[data-label="Líneas"]')).toHaveText('1');
    await expect(row.locator('td[data-label="Diferencia"]')).toHaveText('+1');
    await expect(row.locator('td[data-label="Estado"]')).toHaveText('Aplicado');

    // Leer el documento es abrirlo: la fila se cierra y se vuelve a abrir con su botón, y el panel
    // publica el esperado, lo contado y la diferencia de cada línea.
    const panel = appliedDocument(page, document.id);
    const disclosure = row.getByRole('button', { name: `#${document.id}`, exact: true });
    await expect(panel).toBeVisible();
    await disclosure.click();
    await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    await expect(panel).toHaveCount(0);
    await disclosure.click();
    await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    await expect(panel).toBeVisible();
    const line = panel.locator(`tr[data-variant-id="${variant.variantId}"]`);
    await expect(line.locator('td[data-label="Esperado"]')).toHaveText(String(before));
    await expect(line.locator('td[data-label="Contado"]')).toHaveText(String(before + 1));
    await expect(line.locator('td[data-label="Diferencia"]')).toHaveText('+1');
    await expect(panel.locator('dd').filter({ hasText: `#${document.id}` })).toHaveText(`#${document.id}`);
  });

test('el Almacén revierte un documento aplicado y el contra-asiento queda visible en el historial',
  async ({ page, api }) => {
    const warehouse = await api.as(warehouseRole);
    const variant = await arrangeWarehouseVariant(warehouse);
    const before = await warehouseExisting(warehouse, variant);

    await openAdjustmentHistory(page);
    const counted = before + 2;
    const document = await applyDocument(page, warehouse, variant, counted, motive, 'Almacén');
    const applied = documentRow(page, document.id);
    await expect(applied.locator('td[data-label="Estado"]')).toHaveText('Aplicado');
    expect(await warehouseExisting(warehouse, variant)).toBe(counted);

    // El operador corrige: abre el contra-asiento del documento y lee lo que va a pasar antes de confirmar.
    const dialog = await openReversal(page, document.id);
    await expect(dialog).toContainText(motive);
    await expect(dialog).toContainText('Diferencia del original');
    await expect(dialog).toContainText('Diferencia del contra-asiento');
    await expect(dialog).toContainText('+2');
    await expect(dialog).toContainText('-2');

    const counterId = await confirmReversal(page, counterMotive);
    expect(counterId).not.toBe(document.id);

    // El contra-asiento es un documento nuevo del mismo local, con las líneas espejadas y su propio motivo.
    const counter = await readDocument(warehouse, counterId);
    expect(counter.reverses_adjustment_id).toBe(document.id);
    expect(counter.location_id).toBe(1);
    expect(counter.reason).toBe(counterMotive);
    expect(counter.detail).toBe('');
    expect(counter.lines.map(row => [row.variant_id, row.expected_quantity, row.counted_quantity, row.difference]))
      .toEqual([[variant.variantId, counted, before, -2]]);
    expect(counter.total_difference).toBe(-2);

    // El original no cambia: queda visible y publica quién lo revirtió y con qué motivo.
    const original = await readDocument(warehouse, document.id);
    expect(original.reversed_by).toBe(counterId);
    expect(original.reversed_by_reason).toBe(counterMotive);
    expect(original.lines.map(row => [row.expected_quantity, row.counted_quantity, row.difference]))
      .toEqual([[before, counted, 2]]);

    // Y las existencias del Almacén vuelven a donde estaban antes del conteo.
    expect(await warehouseExisting(warehouse, variant)).toBe(before);

    // En pantalla los dos documentos quedan: el original dice «Revertido» y ya no ofrece revertirse otra vez.
    const originalRow = documentRow(page, document.id);
    await expect(originalRow.locator('td[data-label="Estado"]')).toHaveText('Revertido');
    await expect(originalRow.getByRole('button', { name: `Revertir ajuste #${document.id}` })).toHaveCount(0);
    const counterRow = documentRow(page, counterId);
    await expect(counterRow.locator('td[data-label="Estado"]')).toHaveText('Contra-asiento');
    await expect(counterRow.locator('td[data-label="Diferencia"]')).toHaveText('-2');
    await expect(counterRow.getByRole('button', { name: `Revertir ajuste #${counterId}` })).toHaveCount(0);

    // La pantalla abre el contra-asiento con sus líneas espejadas…
    const counterPanel = appliedDocument(page, counterId);
    await expect(counterPanel).toBeVisible();
    const counterLine = counterPanel.locator(`tr[data-variant-id="${variant.variantId}"]`);
    await expect(counterLine.locator('td[data-label="Esperado"]')).toHaveText(String(counted));
    await expect(counterLine.locator('td[data-label="Contado"]')).toHaveText(String(before));
    await expect(counterLine.locator('td[data-label="Diferencia"]')).toHaveText('-2');
    await expect(counterPanel).toContainText(`Contra-asiento del documento #${document.id}.`);

    // …y el original, leído de nuevo, dice que fue revertido y con qué motivo.
    await originalRow.getByRole('button', { name: `#${document.id}`, exact: true }).click();
    const originalPanel = appliedDocument(page, document.id);
    await expect(originalPanel).toBeVisible();
    await expect(originalPanel).toContainText(new RegExp(`Revertido por el contra-asiento #${counterId}`));
    await expect(originalPanel).toContainText(counterMotive);
  });
