import {
  branchA, centsOf, contractFigures, expect, figureNote, figureValue, moneyText, readOpening,
  shownFigures, test,
} from './harness';

/**
 * S2 · las cuatro figuras del período que la pantalla abre.
 *
 * Lo que dejó el período se lee en cuatro figuras: la plata que cobró, la caja que entregó, el fondo que
 * queda y el material que entregó (S3). Cada una lleva su línea, y la ausencia de una caja, de un fondo o
 * de una planilla se dice en palabras —`Sin caja`, `Sin fondo`, `Sin planilla`— y nunca como un cero que
 * nadie contó (S8).
 *
 * La prueba lee las cuatro de la pantalla y las contrasta con la respuesta del contrato del mismo
 * período: la plata es el total que el servidor publicó, la caja es la contada o la esperada, el fondo es
 * el recambio que el Almacén dejó y el material es lo que el Almacén contó. La sucursal A todavía no
 * cerró ninguna rendición, así que el período que la pantalla abre es el historial y las tres cuentas que
 * sólo un cierre estatuye llegan en null: eso también es una lectura que la pantalla tiene que decir.
 */

test('la sucursal lee las cuatro figuras del período contra la respuesta del contrato', async ({ page, api }) => {
  const branch = await api.as(branchA);
  // El período que el operador tiene delante: el que la pantalla abre, leído del contrato en este momento.
  const answer = await readOpening(page, branch, shownFigures, contractFigures);

  // La plata del período y la cantidad de ventas que la acompaña: el total del contrato, no otro número.
  await expect(figureValue(page, 'Plata del período'))
    .toHaveText(moneyText(centsOf(answer.sales.total)));
  await expect(figureNote(page, 'Plata del período'))
    .toHaveText(answer.sales.sales === 1 ? '1 venta' : `${answer.sales.sales} ventas`);

  // La caja entregada: la contada cuando el cierre la contó, la esperada cuando todavía no, y las
  // palabras cuando el período no tiene caja que entregar (el acumulado y la ventana).
  if (answer.cash === null) {
    await expect(figureValue(page, 'Caja entregada')).toHaveText('Sin caja');
    await expect(figureNote(page, 'Caja entregada')).toHaveText(answer.period.kind === 'current'
      ? 'se cuenta al rendir' : 'el acumulado no tiene caja');
  } else if (answer.cash.counted === null) {
    await expect(figureValue(page, 'Caja entregada')).toHaveText(moneyText(centsOf(answer.cash.expected)));
    await expect(figureNote(page, 'Caja entregada')).toHaveText('todavía no se contó');
  } else {
    await expect(figureValue(page, 'Caja entregada')).toHaveText(moneyText(centsOf(answer.cash.counted)));
    await expect(figureNote(page, 'Caja entregada')).toContainText('contada');
  }

  // El fondo que queda: el recambio que el Almacén dejó en el sobre, `Sin declarar` mientras no lo
  // declaró y `Sin fondo` en un período que no tiene sobre.
  if (answer.fund === null) {
    await expect(figureValue(page, 'Fondo que queda')).toHaveText('Sin fondo');
    await expect(figureNote(page, 'Fondo que queda')).toHaveText(answer.period.kind === 'current'
      ? 'lo declara el Almacén al rendir' : 'el acumulado no tiene fondo');
  } else if (answer.fund.replacement === null) {
    await expect(figureValue(page, 'Fondo que queda')).toHaveText('Sin declarar');
    await expect(figureNote(page, 'Fondo que queda')).toHaveText('el Almacén todavía no lo declaró');
  } else {
    await expect(figureValue(page, 'Fondo que queda'))
      .toHaveText(moneyText(centsOf(answer.fund.replacement)));
    await expect(figureNote(page, 'Fondo que queda')).toHaveText('recambio del Almacén');
  }

  // El material entregado: lo que el Almacén contó del período, `Sin contar` mientras falte una línea y
  // `Sin planilla` cuando el período no tiene planilla que contar.
  if (answer.materials === null) {
    await expect(figureValue(page, 'Material entregado')).toHaveText('Sin planilla');
    await expect(figureNote(page, 'Material entregado')).toHaveText(answer.period.kind === 'current'
      ? 'se entrega al rendir'
      : answer.period.kind === 'all' ? 'el acumulado no tiene planilla' : 'este período no tiene planilla');
  } else if (answer.materials.used_delivered_units === null
    || answer.materials.scrap_delivered_milli === null) {
    await expect(figureValue(page, 'Material entregado')).toHaveText('Sin contar');
    await expect(figureNote(page, 'Material entregado')).toHaveText('baterías usadas y chatarra');
  } else {
    await expect(figureNote(page, 'Material entregado')).toHaveText('baterías usadas y chatarra');
  }
});
