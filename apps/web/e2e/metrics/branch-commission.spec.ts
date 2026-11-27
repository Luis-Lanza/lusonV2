import {
  branchA, centsOf, contractToday, expect, moneyText, readOpening, shownToday, test, todayValue,
} from './harness';

/**
 * S2 · la comisión que la sucursal está devengando.
 *
 * La comisión no es plata en una caja: se devenga sobre lo vendido y se estatuye recién cuando la
 * rendición se propone (S18, S19). La pantalla la publica en la línea de hoy junto a lo vendido desde el
 * corte, y cuando la sucursal no tiene una tasa configurada lo dice con palabras —`Sin tasa`—, porque la
 * ausencia de una tasa es un estado propio y nunca un cero por ciento disfrazado de tasa (S20).
 *
 * La prueba contrasta las dos lecturas con el contrato del mismo período —lo vendido y lo devengado— y
 * afirma la aritmética que las ata: la comisión es la tasa del contrato aplicada a la base de baterías,
 * redondeada una sola vez, y no es un término de lo que el cajón debería tener.
 */

test('la sucursal lee la comisión devengada y lo vendido desde el corte contra el contrato', async ({ page, api }) => {
  const branch = await api.as(branchA);
  const answer = await readOpening(page, branch, shownToday, contractToday);
  const today = answer.today;
  const sold = centsOf(today.sold);
  const commission = centsOf(today.commission);

  // Lo vendido desde el corte es el total del contrato de esa ventana, y la pantalla lo dice en palabras
  // cuando no vendió nada.
  await expect(todayValue(page, 'Vendido desde el corte'))
    .toHaveText(sold === 0 ? 'Sin ventas' : moneyText(sold));

  if (today.rate === null) {
    // Sin tasa configurada la pantalla lo dice, y el contrato no puede devengar nada: la comisión es cero.
    await expect(todayValue(page, 'Comisión devengada')).toHaveText('Sin tasa');
    expect(commission).toBe(0);
  } else {
    // La comisión es la tasa aplicada a la base de baterías, redondeada una sola vez: la misma aritmética
    // que el cierre aplica. El redondeo se hace con enteros, como el contrato (S1, S3).
    const [whole, fraction] = today.rate.split('.');
    const hundredths = BigInt(whole) * 100n + BigInt(fraction);
    const earned = (BigInt(centsOf(today.commission_base)) * hundredths + 5000n) / 10000n;
    expect(BigInt(commission)).toBe(earned);
    await expect(todayValue(page, 'Comisión devengada')).toHaveText(commission > 0
      ? moneyText(commission) : 'Sin comisión todavía');
  }

  // La comisión no entra en el cajón: la expectativa del contrato es lo que dejó el corte más el efectivo
  // vendido más el neto del libro, y la pantalla publica ese número (`Efectivo en el cajón`), no el de la
  // plata que la sucursal está ganando.
  expect(centsOf(today.expected))
    .toBe(centsOf(today.opening) + centsOf(today.sales) + centsOf(today.effective));
  await expect(todayValue(page, 'Efectivo en el cajón')).toHaveText(moneyText(centsOf(today.expected)));
});
