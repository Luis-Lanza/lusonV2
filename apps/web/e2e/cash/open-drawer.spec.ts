import {
  bandValue, bookOfPeriod, branchA, centsOf, expect, kindLabels, moneyText, readBook,
  settlementWindows, signedText, test,
} from './harness';

/**
 * S2 · la caja operativa de la sucursal, abierta por la navegación y leída en pantalla.
 *
 * El cajón del mostrador es una pantalla propia de la sucursal: sus cuatro números —lo que dejó el último
 * corte, el efectivo que vendió, el neto del libro y lo que la rendición va a pedir— y el libro de la
 * ventana, que firma cada movimiento con su tipo, su motivo, su autor y su momento. La prueba entra por la
 * navegación, como el operador, y contrasta lo que la pantalla muestra con el libro que el contrato ya
 * publica (`GET /api/closings/cash-ledger`, `closings.md`), que es la única lectura que la propia pantalla
 * hace (S3).
 *
 * Los números son de la sucursal y de su ventana en curso: otra suite del pedido puede vender o mover su
 * cajón mientras esta prueba corre, así que el libro se lee en el mismo momento en que la pantalla lo
 * muestra y una diferencia por esa carrera se vuelve a correr, nunca se debilita.
 */

/** El texto de una celda sin sus espacios: la comparación no depende de cómo el JSX los separe. */
const squash = (value: string): string => value.replace(/\s+/g, '');

/** Lo que la celda del motivo de una fila del libro escribe, en el orden en que lo escribe (S7, S8). */
function motiveText(row: {
  readonly category_label: string | null; readonly description: string;
  readonly corrects_id: number | null; readonly evidence: unknown;
}): string {
  const parts: string[] = [];
  if (row.category_label !== null) {
    parts.push(row.category_label);
    if (row.description !== '') parts.push(row.description);
  } else {
    parts.push(row.description);
  }
  if (row.corrects_id !== null) parts.push(`Corrige el movimiento #${row.corrects_id}`);
  if (row.evidence !== null) parts.push('Ver comprobante');
  return squash(parts.join(''));
}

test('la sucursal abre la caja operativa y lee su saldo y el libro del período', async ({ page, api }) => {
  const branch = await api.as(branchA);

  // El acto de entrar: la caja está en la navegación de la sucursal y su hash propio la restaura.
  await page.goto('/');
  await page.getByRole('button', { name: 'Caja', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Caja operativa' })).toBeVisible();
  expect(new URL(page.url()).hash).toBe('#/caja');
  await expect(page.getByRole('button', { name: 'Caja', exact: true })).toHaveAttribute('aria-current', 'page');

  // La pantalla dice de quién es el cajón y de qué caja no se trata.
  await expect(page.getByText('El libro del cajón del mostrador de Sucursal A')).toBeVisible();
  await expect(page.getByText('Las compras de chatarra y baterías usadas salen del fondo de compras', { exact: false })).toBeVisible();

  // El período en curso, que es el que arranca en el corte del último cierre, y las ventanas cerradas que
  // el propio lector de métricas publica: la pantalla no ofrece ningún período que el servidor no nombre.
  const period = page.getByRole('group', { name: 'Período del libro' });
  const windows = await settlementWindows(branch);
  await expect(period.getByLabel('Período')).toHaveValue('live');
  await expect(period.getByLabel('Período').locator('option'))
    .toHaveText(['En curso · desde el último corte', ...windows.map(window => window.label)]);
  await expect(period).toContainText('En vivo · el cajón se mueve hasta el próximo corte');

  // Los cuatro números, leídos del libro que el contrato publica en este mismo momento.
  const book = await readBook(branch);
  await expect(page.getByRole('heading', { name: 'Qué debería haber en el cajón' })).toBeVisible();
  await expect(bandValue(page, 'Quedó al cerrar')).toHaveText(moneyText(centsOf(book.opening)));
  await expect(bandValue(page, 'Ventas en efectivo')).toHaveText(moneyText(centsOf(book.sales)));
  await expect(bandValue(page, 'Neto del libro')).toHaveText(signedText(centsOf(book.effective)));
  await expect(bandValue(page, 'Esperado en el cajón')).toHaveText(moneyText(centsOf(book.expected)));

  // La ventana que los números describen: el corte del último cierre, o el comienzo de la sucursal.
  const note = page.locator('.cash-period-note');
  if (book.since === null) {
    await expect(note).toHaveText('Desde el comienzo de la sucursal: todavía no hay un cierre que haya dejado un saldo.');
  } else {
    await expect(note).toContainText('Desde el corte del');
    await expect(note).toContainText('con lo que ese cierre dejó en el cajón.');
    await expect(note.locator('time')).toHaveAttribute('datetime', book.since);
  }

  // El libro: el mismo que el contrato publica, fila por fila y en su orden.
  const ledger = bookOfPeriod(page);
  await expect(ledger.getByRole('heading', { name: 'Libro del período' })).toBeVisible();
  await expect(ledger.locator('caption'))
    .toHaveText('Cada movimiento queda firmado con su autor y su momento. Nada se edita ni se borra.');
  await expect(ledger.getByRole('columnheader')).toHaveText(['Momento', 'Tipo', 'Motivo', 'Autor', 'Monto', 'Acciones']);
  await expect(ledger.locator('tfoot td.cash-total')).toHaveText(signedText(centsOf(book.effective)));
  await expect(ledger.locator('.cash-truncated')).toHaveCount(book.truncated ? 1 : 0);

  const rows = ledger.locator('tbody tr[data-movement-id]');
  await expect(rows).toHaveCount(book.movements.length);
  const rendered = (await rows.evaluateAll(nodes => nodes.map(node => ({
    id: Number(node.getAttribute('data-movement-id')),
    kind: node.querySelector('.cash-kind')?.textContent ?? '',
    amount: node.querySelector('td.cash-amount')?.textContent ?? '',
    author: node.querySelector('td.cash-author')?.textContent ?? '',
    moment: node.querySelector('time')?.getAttribute('datetime') ?? '',
    motive: node.querySelector('td.cash-motive')?.textContent ?? '',
  })))).map(row => ({ ...row, motive: squash(row.motive) }));
  expect(rendered).toEqual(book.movements.map(row => ({
    id: row.id,
    kind: kindLabels[row.kind],
    amount: signedText(centsOf(row.effective)),
    author: `Cuenta #${row.created_by_account_id}`,
    moment: row.occurred_at,
    motive: motiveText(row),
  })));

  if (book.movements.length === 0) {
    // El período sin movimientos no es una tabla vacía: es un estado que dice qué no pasó.
    await expect(ledger).toContainText('Todavía no hay movimientos desde el corte');
  } else {
    // Y la fila más nueva lleva su motivo completo, con la nota y el tipo que la firma.
    const newest = book.movements[book.movements.length - 1];
    await expect(ledger.locator('tbody tr[data-movement-id]').last().locator('td.cash-motive'))
      .toContainText(newest.description);
  }
});
