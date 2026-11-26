import {
  branchA, expect, figuresPanel, periodSelect, periodToken, provenanceText, readOpening, stamp, test,
} from './harness';

/**
 * S2 · la sucursal abre las métricas de su propia sucursal.
 *
 * La pantalla es una sección de la sucursal y de nadie más: el Almacén tiene su lectura consolidada en
 * otra vertical y no la alcanza desde acá. La prueba entra como el operador —por el botón de la
 * navegación— y afirma lo que la pantalla publica al abrirse: su título, su hash, el local del que son
 * los números y el período con el que arranca.
 *
 * El período de apertura no lo elige la prueba: el contrato publica el selector y la pantalla abre en la
 * ventana desde el último corte cuando el servidor la publica —y el servidor sólo la publica si la
 * sucursal cerró alguna rendición y no está dentro de una—, y en el historial cuando no (S10). El sello
 * de arriba ata las cifras a ese período y se contrasta con la respuesta que el servidor da de él.
 */

test('la sucursal abre las métricas desde la navegación y la pantalla arranca en el período que el contrato publica',
  async ({ page, api }) => {
    const branch = await api.as(branchA);

    // El acto de entrar: la sección está en la navegación de la sucursal y su hash propio la restaura.
    await page.goto('/');
    await page.getByRole('button', { name: 'Métricas', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Métricas de la sucursal' })).toBeVisible();
    expect(new URL(page.url()).hash).toBe('#/metricas');
    await expect(page.getByRole('button', { name: 'Métricas', exact: true }))
      .toHaveAttribute('aria-current', 'page');

    // La cabecera nombra la sección y el local: las métricas son las de Sucursal A y de nadie más.
    await expect(page.getByText('Luson Métricas', { exact: true })).toBeVisible();
    await expect(page.getByText('Ubicación asignada:', { exact: false })).toContainText('Sucursal A');

    // Y no ganó ninguna sección del Almacén: el consolidado de todas las sucursales no es esta pantalla.
    await expect(page.getByRole('button', { name: 'Ingresos', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Catálogo', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Rendiciones', exact: true })).toHaveCount(0);

    // El período con el que la pantalla abre es el que el contrato pone primero, con su etiqueta y sus
    // figuras: el selector lo publica elegido y el sello dice de dónde vienen los números.
    const answer = await readOpening(page, branch, async shown => ({
      period: await periodSelect(shown).inputValue(),
      label: ((await periodSelect(shown).locator('option:checked').textContent()) ?? '').trim(),
      figures: await figuresPanel(shown).isVisible(),
    }), from => ({
      period: periodToken(from.period),
      label: from.period.label,
      figures: true,
    }));

    await expect(periodSelect(page)).toHaveValue(periodToken(answer.period));
    await expect(stamp(page)).toHaveText(provenanceText(answer));
  });
