import {
  branchA, expect, kindButton, openPurchaseDialog, openPurchases, publishedMaterials, publishedModels,
  scrapMaterialField, test, usedModelField,
} from './harness';

/**
 * S2 · los dos libros de referencia que la pantalla consulta (T4).
 *
 * El campo de modelo no es una lista cerrada: se tipea, y la pantalla ofrece detrás los modelos del
 * catálogo —sin repetir marcas y ya canónicos— porque el contrato los publica así. El material, en
 * cambio, no se tipea: es la lista cerrada de referencia, toda pesada en kilogramos.
 *
 * El catálogo lo cambian otras pantallas y otras suites mientras esta corre, así que la lista de modelos
 * se lee antes y después de abrir la pantalla y se contrasta lo que existía en los dos momentos: lo que
 * el arnés midió como estable es lo que la pantalla tiene que estar ofreciendo. Los materiales son
 * datos de referencia y se contrastan enteros.
 */

test('la pantalla publica los modelos del catálogo y los materiales de referencia del contrato',
  async ({ page, api }) => {
    const branch = await api.as(branchA);
    const modelsBefore = await publishedModels(branch);
    const materials = await publishedMaterials(branch);

    await openPurchases(page);
    const dialog = await openPurchaseDialog(page);

    // El modelo es texto libre con la lista del catálogo detrás, y la pantalla lo dice con sus palabras.
    await expect(usedModelField(dialog)).toHaveAttribute('list', 'purchase-model-options');
    await expect(dialog.getByText('Lista del catálogo, sin repetir marcas. Si no está, se tipea.')).toBeVisible();
    const options = dialog.locator('#purchase-model-options option');
    await expect(options.first()).toHaveCount(1);
    const offered = await options.evaluateAll(nodes => nodes.map(node => (node as HTMLOptionElement).value));

    // Cada valor es el código canónico del catálogo y ninguna marca lo repite.
    for (const model of offered) {
      expect(model).toBe(model.trim().toUpperCase());
      expect(model).toMatch(/^[A-Z0-9][A-Z0-9 .,_/-]{0,39}$/);
    }
    expect(new Set(offered).size).toBe(offered.length);
    const modelsAfter = await publishedModels(branch);
    const stable = modelsBefore.filter(model => modelsAfter.includes(model));
    expect(stable.length).toBeGreaterThan(0);
    for (const model of stable) expect(offered).toContain(model);

    // El material, en cambio, es una lista cerrada: no hay campo libre que tipear.
    await kindButton(dialog, 'scrap').click();
    const materialOptions = scrapMaterialField(dialog).locator('option');
    await expect(materialOptions).toHaveText(['Elegí un material', ...materials.map(entry => entry.name)]);
    for (const [index, material] of materials.entries()) {
      await expect(materialOptions.nth(index + 1)).toHaveAttribute('value', String(material.id));
    }
    await expect(dialog.getByText('cobre, aluminio, plomo y bronce')).toBeVisible();
    await expect(scrapMaterialField(dialog)).toHaveValue('');

    // Y lo mismo que la pantalla ofrece es lo que el contrato publica: el catálogo, ya canónico.
    for (const model of modelsAfter) expect(model).toBe(model.trim().toUpperCase());
    expect(materials.map(entry => entry.name)).toEqual(['Cobre', 'Aluminio', 'Plomo', 'Bronce']);
  });
