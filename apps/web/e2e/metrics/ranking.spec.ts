import {
  branchA, centsOf, contractRanking, expect, isBattery, moneyText, rankingHint, rankingPanel,
  rankingRows, rankingVolumeText, readOpening, shownRanking, test,
} from './harness';

/**
 * S2 · el ranking de lo más vendido del período.
 *
 * La pantalla ordena por unidades y publica la plata de cada fila como lectura secundaria (S4): una
 * batería se lista con la identidad que la pantalla compone y su capacidad, y un producto con su nombre y
 * ninguna capacidad inventada (S6). Debajo de la tabla, una línea dice el volumen que las filas toman del
 * período, y un período que no vendió nada no muestra una tabla vacía sino las palabras que lo dicen.
 *
 * La prueba lee las filas de la pantalla —puesto, modelo, unidades y plata— y las contrasta con el
 * ranking que la respuesta del mismo período publica, en su mismo orden, más la línea de volumen y la
 * regla de orden: las unidades nunca crecen y el ranking no pasa de cinco filas.
 */

test('la sucursal lee el ranking del período por unidades y el volumen que esas filas toman',
  async ({ page, api }) => {
    const branch = await api.as(branchA);
    const answer = await readOpening(page, branch, shownRanking, contractRanking);
    const rows = await shownRanking(page);

    // El ranking publica como mucho cinco modelos y los ordena por unidades, nunca por plata.
    expect(answer.top_models.length).toBeLessThanOrEqual(5);
    expect(rows.length).toBe(answer.top_models.length);
    const units = rows.map(row => Number(row.units));
    expect(units).toEqual([...units].sort((left, right) => right - left));

    // Cada fila es la del contrato: el puesto, el modelo con su identidad, sus unidades y su plata.
    for (const [index, model] of answer.top_models.entries()) {
      const row = rankingRows(page).nth(index);
      await expect(row.locator('td').nth(0)).toHaveText(String(index + 1));
      if (isBattery(model)) {
        await expect(row.locator('td.model')).toContainText(`${model.brand} ${model.model}`);
        await expect(row.locator('td.model')).toContainText(`${model.capacity_ah} Ah`);
      } else {
        // Un producto es su nombre y no lleva la capacidad de una batería que no tiene.
        await expect(row.locator('td.model')).toHaveText(model.name);
        await expect(row.locator('td.model')).not.toContainText('Ah');
      }
      await expect(row.locator('td').nth(2)).toHaveText(String(model.units));
      await expect(row.locator('td').nth(3)).toHaveText(moneyText(centsOf(model.money)));
    }

    // La línea de volumen: las unidades de las filas sobre las unidades del período, como las suma el
    // contrato. Un período sin ventas no tiene tabla y lo dice en palabras.
    if (answer.top_models.length === 0) {
      await expect(rankingPanel(page)).toContainText('El período no vendió nada: no hay ranking que mostrar.');
    } else {
      await expect(rankingHint(page)).toHaveText(rankingVolumeText(answer));
    }
  });
