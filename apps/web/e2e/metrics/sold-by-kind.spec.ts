import {
  branchA, centsOf, contractSoldByKind, expect, moneyText, readOpening, screenCents, shownSoldByKind,
  soldValue, test,
} from './harness';

/**
 * S2 · lo que el período vendió, por tipo de producto.
 *
 * La pantalla separa la plata de las baterías de la del resto del catálogo y publica el total como la
 * suma de las dos lecturas (S1-S3): el total no se repite en prosa, se compone. Un período que no vendió
 * un tipo lo dice con palabras —`Sin ventas`— y nunca con un cero, porque un cero es una venta de cero
 * pesos y no una ausencia (S5).
 *
 * La prueba lee las tres de la pantalla y las contrasta con la respuesta del contrato del mismo período:
 * `batteries` es la parte del total que el servidor publica y `otros productos` es el resto, que el
 * cliente deriva de esa misma respuesta. Además afirma la suma sobre lo que la pantalla muestra, para que
 * las tres lecturas no puedan venir de dos respuestas distintas.
 */

test('la sucursal lee qué se vendió por tipo de producto y el total como la suma de las dos lecturas',
  async ({ page, api }) => {
    const branch = await api.as(branchA);
    const answer = await readOpening(page, branch, shownSoldByKind, contractSoldByKind);

    // Las baterías son la parte del total que el servidor publica, y el resto del catálogo es lo que falta
    // para el total: las dos lecturas que la pantalla escribe.
    await expect(soldValue(page, 'Baterías')).toHaveText(contractSoldByKind(answer).batteries);
    await expect(soldValue(page, 'Otros productos')).toHaveText(contractSoldByKind(answer).other);
    // El total se dice en palabras cuando el período no cobró nada: `Sin ventas`, nunca `Bs 0,00`.
    await expect(soldValue(page, 'Total')).toHaveText(contractSoldByKind(answer).total);

    // La pantalla compone el total: las dos lecturas que muestra suman la tercera, en sus propias cifras.
    const shown = await shownSoldByKind(page);
    if (shown.batteries === 'Sin ventas' || shown.other === 'Sin ventas') {
      // Un período de un solo tipo: la lectura ausente se dice en palabras y el total es la otra.
      expect([shown.batteries, shown.other]).toContain('Sin ventas');
      expect(shown.total).toBe(shown.batteries === 'Sin ventas' ? shown.other : shown.batteries);
    } else {
      expect(screenCents(shown.batteries) + screenCents(shown.other)).toBe(screenCents(shown.total));
    }

    // Y el total es el mismo que el bloque de las figuras del período publica como su plata.
    await expect(page.locator('.metrics-figure').filter({ hasText: 'Plata del período' })
      .locator('.metrics-figure-value')).toHaveText(moneyText(centsOf(answer.sales.total)));
  });
