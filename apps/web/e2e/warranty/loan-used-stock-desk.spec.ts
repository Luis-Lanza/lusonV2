import {
  addLoan, advance, arrangeBatterySale, arrangeUsedPool, branchA, expect, openClaim, resolveClaim,
  test, unitsLabel, warehouseDeskPage, warehouseRole,
} from './harness';
import { usedStockKey, usedStockSum, usedStockTable, type UsedStockTermRow } from './loan-harness';

/**
 * S2 (e2e-all-flows) · S24, S27, S28 · `#/garantias/usadas`, the screen the Almacén has of the used
 * batteries.
 *
 * The screen is **read-only**, and that is a fact of the product and not an omission of this spec:
 * `apps/web/src/UsedStock.tsx:17-22` says every number is derived and none is stored, and the only
 * button it ever renders is the retry of the read itself (`apps/web/src/UsedStock.tsx:99-100`). There
 * is no act on the pool, because there is no balance to adjust: what moves the number is the fact, and
 * the fact belongs to another screen. So this spec asserts what the screen publishes instead of
 * inventing an act — the five terms of every warehouse row and their signed sum, the same numbers from
 * every location and model, the copy that names where the units come from, and that a branch's model
 * never appears in the Almacén's own table.
 *
 * The two facts that put units in the pool are arranged by the API (S35): a used battery the branch
 * bought and lent, and a claim whose factory verdict is `not_covered` with the damaged unit back in
 * the pool — the return is the warehouse's, never the branch's (S27). The screen is then read as the
 * Almacén reads it and every published number is contrasted with the persisted read of the API
 * (e2e-all-flows, S3).
 */
test('la pantalla del stock de usadas del Almacén publica el stock derivado por sus hechos y no ofrece ningún acto',
  async ({ browser, api }) => {
    const branch = await api.as(branchA);
    const warehouse = await api.as(warehouseRole);
    // Una usada comprada por la sucursal y prestada desde ella: el hecho la saca de la sucursal.
    const bought = await arrangeUsedPool({ branch, warehouse }, 'usadas');
    const sale = await arrangeBatterySale({ branch, warehouse }, 'usadas');
    const claim = await openClaim(branch, sale.serial, 'No retiene carga');
    await addLoan(branch, claim.id, { model: bought, quantity: 1, source_location_id: branch.locationId });
    await advance(branch, claim.id, 'in_transit', 'Sale al Almacén');
    await advance(warehouse, claim.id, 'at_warehouse', 'Recibida en el Almacén');
    await advance(warehouse, claim.id, 'at_factory', 'Enviada a fábrica',
      `LEG-${Date.now().toString(36).toUpperCase()}`);

    // La devolución de fábrica no cubierta: el hecho que suma al Almacén y a la sucursal no (S27).
    const before = await usedStockTable(warehouse);
    await resolveClaim(warehouse, claim.id, {
      verdict: 'not_covered', reported_destination: 'stock', loan_destination: 'customer',
      note: 'Fábrica rechazó la garantía: la unidad queda en el pool de usadas',
    });
    const after = await usedStockTable(warehouse);

    const prior = new Map(before.map(row => [usedStockKey(row), row]));
    const moved = after.filter(row => {
      const old = prior.get(usedStockKey(row));
      return old === undefined || old.available !== row.available
        || old.factory_returns !== row.factory_returns;
    });
    expect(moved).toHaveLength(1);
    const returned = moved[0];
    if (returned === undefined) throw new Error('la devolución de fábrica no movió ninguna fila del pool');
    const oldReturned = prior.get(usedStockKey(returned));
    expect(returned.location_id).toBe(1);
    expect(returned.factory_returns).toBe((oldReturned?.factory_returns ?? 0) + 1);
    expect(returned.available).toBe((oldReturned?.available ?? 0) + 1);
    // Una devolución de fábrica no compra, no entrega al Almacén, no presta ni devuelve un préstamo.
    for (const term of ['purchased', 'loans_returned', 'delivered', 'loans_given'] as const) {
      expect(returned[term]).toBe(oldReturned?.[term] ?? 0);
    }
    // El precio de la compra no mueve nada: la usada prestada salió de la sucursal por su préstamo.
    const boughtRow = after.find(row => row.location_id === branch.locationId && row.model === bought);
    if (boughtRow === undefined) throw new Error(`la compra de ${bought} no figura en el stock de usadas`);
    expect(boughtRow.purchased).toBe(1);
    expect(boughtRow.loans_given).toBe(1);
    expect(boughtRow.available).toBe(0);
    expect(usedStockSum(boughtRow)).toBe(boughtRow.available);
    expect(usedStockSum(returned)).toBe(returned.available);

    const desk = await warehouseDeskPage(browser);
    try {
      // La pantalla del stock es la otra lectura de la misma sección, y se entra por su pestaña.
      const tab = desk.getByRole('group', { name: 'Pantallas de garantías del Almacén' })
        .getByRole('button', { name: 'Stock de usadas' });
      await tab.click();
      await expect(tab).toHaveAttribute('aria-pressed', 'true');
      await expect(desk.getByRole('heading', { level: 1, name: 'Stock de usadas' })).toBeVisible();

      // Lo que la pantalla publica es el stock derivado: no hay saldo guardado ni usada vendible.
      await expect(desk.getByText('Es un stock derivado: no hay ningún saldo guardado.')).toBeVisible();
      await expect(desk.getByText(/ninguna tabla guarda un total/)).toBeVisible();
      await expect(desk.getByText(
        /No es stock vendible: la usada no entra al catálogo, no se revende y el punto de venta no puede venderla\./))
        .toBeVisible();
      // Y de dónde salen las unidades del pool, en las palabras de la pantalla (S24, S27).
      await expect(desk.getByText(/lo que entregaron las sucursales en sus rendiciones cerradas/))
        .toBeVisible();
      await expect(desk.getByText(/lo que fábrica devolvió al no cubrir una garantía/)).toBeVisible();
      await expect(desk.getByText(/lo que salió prestado a un cliente y lo que volvió del préstamo/))
        .toBeVisible();

      // La tabla del Almacén: una fila por modelo, los cinco términos y su suma.
      const held = desk.getByRole('region', { name: 'Stock del Almacén' });
      await expect(held).toHaveAttribute('aria-busy', 'false');
      const row = held.locator(`tr[data-model="${returned.model}"]`);
      await expect(row).toHaveCount(1);
      const cells = row.locator('td');
      await expect(cells.nth(0)).toHaveText(returned.model);
      await expect(cells.nth(1)).toHaveText(String(returned.purchased));
      await expect(cells.nth(2)).toHaveText(String(returned.factory_returns));
      await expect(cells.nth(3)).toHaveText(String(returned.delivered));
      await expect(cells.nth(4)).toHaveText(String(returned.loans_given));
      await expect(cells.nth(5)).toHaveText(String(returned.loans_returned));
      await expect(cells.nth(6)).toContainText(String(returned.available));
      await expect(cells.nth(6)).toContainText('unidades');

      // El total es la suma término por término de las filas que el Almacén tiene, no otra cuenta.
      const warehouseRows = after.filter(entry => entry.location_id === warehouse.locationId);
      const total = (term: keyof UsedStockTermRow): number =>
        warehouseRows.reduce((sum, entry) => sum + Number(entry[term]), 0);
      const footer = held.locator('tfoot td');
      await expect(footer).toHaveCount(7);
      await expect(footer.nth(0)).toHaveText(`${warehouseRows.length} `
        + `${warehouseRows.length === 1 ? 'modelo' : 'modelos'} · ${unitsLabel(total('available'))}`);
      await expect(footer.nth(1)).toHaveText(String(total('purchased')));
      await expect(footer.nth(2)).toHaveText(String(total('factory_returns')));
      await expect(footer.nth(3)).toHaveText(String(total('delivered')));
      await expect(footer.nth(4)).toHaveText(String(total('loans_given')));
      await expect(footer.nth(5)).toHaveText(String(total('loans_returned')));
      await expect(footer.nth(6)).toHaveText(String(total('available')));

      // "Dónde está la usada": el mismo número por ubicación y modelo, incluida la sucursal del caso.
      const everywhere = desk.getByRole('region', { name: 'Dónde está la usada' });
      const boughtScreen = everywhere.locator(
        `tr[data-location="${branch.locationId}"][data-model="${bought}"]`);
      await expect(boughtScreen).toHaveCount(1);
      await expect(boughtScreen.locator('td').nth(0)).toHaveText(branch.locationName);
      await expect(boughtScreen.locator('td').nth(1)).toHaveText(bought);
      await expect(boughtScreen.locator('td').nth(2)).toContainText(String(boughtRow.available));
      // La fila del Almacén publica la misma suma que la tabla del Almacén.
      const returnedScreen = everywhere.locator(
        `tr[data-location="${warehouse.locationId}"][data-model="${returned.model}"]`);
      await expect(returnedScreen.locator('td').nth(2)).toContainText(String(returned.available));
      const everywhereFooter = everywhere.locator('tfoot td');
      await expect(everywhereFooter).toHaveCount(3);
      await expect(everywhereFooter.nth(0)).toHaveText(`${after.length} `
        + `${after.length === 1 ? 'modelo' : 'modelos'} en toda la instalación`);
      await expect(everywhereFooter.nth(2)).toHaveText(
        String(after.reduce((sum, entry) => sum + entry.available, 0)));

      // El stock de la sucursal no es el del Almacén: su modelo comprado no entra en la tabla de arriba.
      await expect(held.locator(`tr[data-model="${bought}"]`)).toHaveCount(0);

      // Es una lectura: la pantalla no tiene formulario, campo ni acto sobre la usada.
      const screen = desk.locator('section.used-stock');
      await expect(screen).toHaveCount(1);
      await expect(screen.locator('form')).toHaveCount(0);
      await expect(screen.getByRole('textbox')).toHaveCount(0);
      await expect(screen.getByRole('combobox')).toHaveCount(0);
      await expect(screen.getByRole('button')).toHaveCount(0);
      await expect(screen.getByRole('link')).toHaveCount(0);
    } finally {
      await desk.close();
    }
  });
