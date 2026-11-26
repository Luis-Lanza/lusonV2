import {
  branchA, boughtText, centsOf, contractToday, dateText, expect, kilosText, moneyText, readOpening,
  shownToday, test, todaySince, todayValue,
} from './harness';

/**
 * S2 · el cajón y el sobre de compras de hoy, la ventana que se mueve.
 *
 * La línea de hoy publica el cajón y el sobre de la sucursal como están ahora, en cualquier período que
 * el selector ofrezca (S12, S15): lo que dejó el último corte, el efectivo que vendió, el neto del libro y
 * lo que debería haber; y el saldo del sobre con las compras que la ventana pagó. Es la única lectura que
 * una sucursal sin rendiciones tiene de sus dos cajas.
 *
 * La prueba lee la línea entera de la pantalla y la contrasta con la respuesta del contrato del mismo
 * período, y además afirma las dos identidades que el contrato publica: el cajón de hoy es lo que dejó el
 * corte más el efectivo más el efecto firmado del libro, y el sobre es lo heredado más el efecto de la
 * ventana. Ninguna de las dos incluye la comisión, que es una proyección.
 */

test('la sucursal lee el cajón y el sobre de compras de hoy contra el contrato del período', async ({ page, api }) => {
  const branch = await api.as(branchA);
  const answer = await readOpening(page, branch, shownToday, contractToday);
  const { today, fund_today: fundToday } = answer;

  // Desde cuándo: el corte del último cierre, o el comienzo de la sucursal cuando todavía no cerró uno.
  if (today.since === null) {
    await expect(todaySince(page)).toHaveText('desde el comienzo de la sucursal');
  } else {
    await expect(todaySince(page)).toHaveText(`desde el corte del ${dateText(today.since)}`);
  }

  // El cajón: lo esperado, que es la identidad del contrato y no un número aparte.
  expect(centsOf(today.expected))
    .toBe(centsOf(today.opening) + centsOf(today.sales) + centsOf(today.effective));
  await expect(todayValue(page, 'Efectivo en el cajón')).toHaveText(moneyText(centsOf(today.expected)));

  // El sobre de compras: lo heredado más el efecto de la ventana, y la pantalla publica ese saldo.
  expect(centsOf(fundToday.balance))
    .toBe(centsOf(fundToday.opening) + centsOf(fundToday.effective));
  await expect(todayValue(page, 'Fondo de compras disponible'))
    .toHaveText(moneyText(centsOf(fundToday.balance)));

  // Las compras de la ventana: cuántos documentos y qué compraron, que es lo que el sobre pagó.
  const documents = fundToday.documents;
  await expect(todayValue(page, 'Compras desde el corte')).toContainText(documents === 0
    ? 'Sin compras' : documents === 1 ? '1 compra' : `${documents} compras`);
  const note = todayValue(page, 'Compras desde el corte').locator('.metrics-today-note');
  if (documents === 0) {
    await expect(note).toHaveCount(0);
  } else if (fundToday.used_units === 0 && fundToday.scrap_milli === 0) {
    // Una ventana que sólo revirtió compras no compró nada: la pantalla lo dice en palabras.
    await expect(note).toHaveText('Sin unidades ni kilos');
  } else {
    // Lo comprado, con las dos cantidades que el contrato publica: unidades y kilos.
    const bought = boughtText(fundToday.used_units, fundToday.scrap_milli);
    await expect(note).toHaveText(bought);
    if (fundToday.used_units !== 0) await expect(note).toContainText(`${fundToday.used_units} u`);
    if (fundToday.scrap_milli !== 0) {
      await expect(note).toContainText(`${kilosText(fundToday.scrap_milli)} kg`);
    }
  }

  // Lo vendido en esa misma ventana y la comisión devengada, cada una con sus palabras cuando falta.
  const sold = centsOf(today.sold);
  await expect(todayValue(page, 'Vendido desde el corte'))
    .toHaveText(sold === 0 ? 'Sin ventas' : moneyText(sold));
  await expect(todayValue(page, 'Comisión devengada')).toHaveText(today.rate === null ? 'Sin tasa'
    : centsOf(today.commission) > 0 ? moneyText(centsOf(today.commission)) : 'Sin comisión todavía');
});
