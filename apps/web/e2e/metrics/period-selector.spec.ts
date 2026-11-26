import {
  branchA, contractFigures, expect, expectSamePeriod, metricsAnswer, openMetrics, openingOf, periodSelect,
  periodToken, provenanceText, selectPeriod, shownFigures, stamp, test, type MetricsPeriod,
} from './harness';

/**
 * S2 · el operador cambia el período que el selector ofrece.
 *
 * Las métricas se cortan por rendición y nunca por mes calendario (S2): el selector publica la ventana
 * desde el último corte, cada rendición cerrada, la que está en curso y el historial, en el orden que el
 * contrato congela. La prueba ejerce el acto de cambiarlo —elige otra opción del selector y espera la
 * respuesta de ese período— y afirma que la pantalla muestra el período elegido, su sello y sus figuras,
 * y no los del anterior.
 *
 * **Una rendición sólo existe si alguien la abrió, y abrirla congela la sucursal**: la prueba no abre
 * ninguna —rompería a todas las demás suites, que venden, cobran y compran en la Sucursal A— así que el
 * selector se afirma contra las ventanas que `GET /api/metrics` publica en ese momento. El selector cambia
 * mientras la suite corre: una rendición que se abre reemplaza la ventana por «En curso» y una que se
 * cierra la devuelve. Por eso el contraste se repite hasta que la pantalla y el contrato coinciden, y por
 * eso el período elegido es el más estable que el servidor publica: una rendición cerrada, cuyos números
 * ya nadie puede mover.
 */

/** El período estable que el test elige para cambiar de ventana: una rendición cerrada, o la última. */
function pickOther(periods: readonly MetricsPeriod[], opening: string): string | null {
  const others = periods.filter(period => periodToken(period) !== opening);
  const chosen = others.find(period => period.kind === 'settlement') ?? others[0];
  return chosen === undefined ? null : periodToken(chosen);
}

test('la sucursal elige un período del selector y la pantalla muestra el período que el contrato publica',
  async ({ page, api }) => {
    const branch = await api.as(branchA);

    await expect(async () => {
      // Las ventanas que el servidor publica ahora: se releen en cada intento, porque el selector de una
      // sucursal que se está rindiendo cambia mientras la prueba corre.
      const periods = (await metricsAnswer(branch, 'all')).periods;
      const opening = await openingOf(branch);

      // El selector ofrece exactamente los períodos que el contrato publica, en su orden, y ninguno más.
      await openMetrics(page);
      await expect(periodSelect(page).locator('option'))
        .toHaveText(periods.map(period => period.label), { timeout: 3_000 });
      await expect(periodSelect(page).locator('option')).toHaveCount(periods.length, { timeout: 3_000 });
      await expect(periodSelect(page)).toHaveValue(periodToken(opening), { timeout: 3_000 });

      const token = pickOther(periods, periodToken(opening));
      if (token === null) {
        // La sucursal no tiene otra ventana que elegir y el selector no inventa una: la única opción es el
        // historial. La ventana desde el último corte no existe sin un cierre y el servidor la rechaza con
        // su propio código; la pantalla no ofrece un período que el contrato no publique (S4, S7).
        expect(periods.map(period => period.kind)).toEqual(['all']);
        await expect(periodSelect(page).locator('option')).toHaveText([opening.label]);
        await expect(stamp(page)).toHaveText('Todo el historial de la sucursal');
        const refused = await branch.request.get('/api/metrics?period=current');
        expect(refused.status()).toBe(404);
        expect(await refused.json()).toEqual({ error: 'not_found' });
        return;
      }

      // El acto: el operador elige el otro período y la pantalla pasa a mostrarlo, contrastado con la
      // respuesta de ese mismo período.
      await selectPeriod(page, token);
      const answer = await metricsAnswer(branch, token);
      await expectSamePeriod(page, answer, shownFigures, contractFigures);
      expect(periodToken(answer.period)).toBe(token);
      await expect(periodSelect(page)).toHaveValue(token);
      await expect(stamp(page)).toHaveText(provenanceText(answer));

      // Y la elección no queda pegada: volver al período de apertura es otro acto del mismo selector.
      const home = periodToken(opening);
      await selectPeriod(page, home);
      await expect(periodSelect(page)).toHaveValue(home);
      await expect(stamp(page)).toHaveText(provenanceText(await metricsAnswer(branch, home)));
    }).toPass({ timeout: 75_000, intervals: [250, 1_000, 2_500] });
  });
