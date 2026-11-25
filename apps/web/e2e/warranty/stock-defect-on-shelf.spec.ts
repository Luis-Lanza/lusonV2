import type { Browser, Page } from '@playwright/test';
import {
  advance, arrangeShelfStock, branchA, caseByNumber, caseRecord, expect, openBranchTray, openCase,
  openDeskBucket, resolutionAttempt, sellableExisting, test, warehouseDeskPage, warehouseRole,
  type Api, type ArrangedShelf,
} from './harness';

/**
 * S35 (7) · S16, S11 · "el hallazgo en góndola".
 *
 * The branch finds one of its own batteries failed before selling it, so the case is opened with the
 * unit the shelf holds: the same act of the admission takes those units off `inventory_balances`, and
 * the verdict the factory answers is what returns them — the repaired ones or the replacement that
 * enters in their place — to the branch's own sellable stock, once.
 *
 * Two screens take part and the spec drives both: the branch registers the finding (that act is the
 * write-off, and the dialog publishes the shelf figure it is about to move), and the Almacén states the
 * verdict on its factory desk (that act is the replacement). The journey between the two doors is
 * arranged by the API, because it is the other specs' subject and not this one's, and it must move no
 * stock at all. The shelf is the seed's own — a finding never invents stock — and both tests write the
 * units off and get them back, so a run leaves the shelf as it found it.
 */

interface DefectFlow {
  readonly shelf: ArrangedShelf;
  readonly caseNumber: string;
  readonly caseId: number;
  /** The sellable `existing` of the variant before the branch registered the finding. */
  readonly before: number;
}

const quantity = 2;

/** The branch registers the finding on its screen, and the shelf loses the units in that same act. */
async function registerDefect(page: Page, api: Api): Promise<DefectFlow> {
  const branch = await api.as(branchA);
  const shelf = await arrangeShelfStock(branch, quantity);
  const before = await sellableExisting(branch, shelf.variantId);

  await openBranchTray(page);
  await page.getByRole('button', { name: 'Hallazgo en góndola' }).click();
  const dialog = page.getByRole('dialog', { name: 'Hallazgo en góndola' });
  await expect(dialog).toBeVisible();

  // La batería se elige de la góndola de la sucursal, y la pantalla publica antes del acto el mismo
  // stock vendible que el punto de venta lee.
  const variant = dialog.getByLabel('Batería que falló');
  await expect(variant).toHaveRole('combobox');
  await expect(variant.locator(`option[value="${shelf.variantId}"]`))
    .toHaveText([`${shelf.label} · disponibles ${shelf.available}`]);
  await variant.selectOption(String(shelf.variantId));
  await dialog.getByLabel('Cantidad de unidades').fill(String(quantity));
  await dialog.getByLabel('Qué falló').fill('No retiene carga');
  await dialog.getByLabel('Motivo de la baja de stock').fill('Probada en mostrador: no arranca');
  await dialog.getByRole('button', { name: 'Registrar el hallazgo' }).click();

  // La confirmación nombra el número guardado del caso, que es el único que la bandeja publica.
  const confirmation = page.getByRole('status').filter({ hasText: /Hallazgo C-[1-9][0-9]*-[0-9]+ registrado/ });
  await expect(confirmation).toHaveCount(1);
  const caseNumber = /Hallazgo (C-[1-9][0-9]*-[0-9]+) registrado/.exec(await confirmation.textContent() ?? '')?.[1];
  if (caseNumber === undefined) throw new Error('la confirmación del hallazgo no nombra el número del caso');
  const opened = await caseByNumber(branch, caseNumber);
  expect(opened.origin).toBe('stock_defect');

  // La baja es del acto del alta: el stock vendible de la variante bajó exactamente la cantidad.
  expect(await sellableExisting(branch, shelf.variantId)).toBe(before - quantity);
  const written = await caseRecord(branch, opened.id);
  expect(written.phase).toBe('received');
  expect(written.variant_id).toBe(shelf.variantId);
  expect(written.quantity).toBe(quantity);
  expect(written.reason).toBe('Probada en mostrador: no arranca');

  return { shelf, caseNumber, caseId: opened.id, before };
}

/** The journey to the factory's answer, arranged by the API, and it moves no stock. */
async function sendToFactory(api: Api, flow: DefectFlow): Promise<void> {
  const branch = await api.as(branchA);
  const warehouse = await api.as(warehouseRole);
  await advance(branch, flow.caseId, 'in_transit', 'Sale al Almacén');
  await advance(warehouse, flow.caseId, 'at_warehouse', 'Recibida en el Almacén');
  await advance(warehouse, flow.caseId, 'at_factory', 'Enviada a fábrica',
    `LEG-${Date.now().toString(36).toUpperCase()}`);
  expect((await caseRecord(branch, flow.caseId)).phase).toBe('at_factory');
}

/** The Almacén states the verdict of the finding on its desk: that act is the replacement. */
async function resolveOnDesk(browser: Browser, api: Api, flow: DefectFlow,
  answer: { readonly label: string; readonly verdict: string }): Promise<void> {
  const desk = await warehouseDeskPage(browser);
  try {
    await openDeskBucket(desk, 'En fábrica');
    await openCase(desk, flow.caseNumber);

    // Antes del veredicto la baja sigue en pie, y la mesa la publica con su cantidad y su motivo.
    const writeOff = desk.locator('li').filter({ hasText: 'Baja del hallazgo' });
    await expect(writeOff).toContainText('Dada de baja');
    await expect(writeOff).toContainText(`${quantity} unidades`);
    await expect(writeOff).toContainText('Probada en mostrador: no arranca');

    await desk.getByLabel('Veredicto', { exact: true }).selectOption({ label: answer.label });
    // El destino no se elige: el par veredicto y origen de un hallazgo que vuelve es el stock de la
    // sucursal, y la pantalla publica esa única salida.
    const destination = desk.getByLabel('Unidades de la góndola');
    await expect(destination).toHaveValue('stock');
    await expect(destination.locator('option')).toHaveText(['A stock vendible']);
    await desk.getByLabel('Motivo del veredicto').fill('Reparadas por fábrica');
    await desk.getByRole('button', { name: 'Registrar veredicto' }).click();
    await expect(desk.getByText(`${flow.caseNumber}: veredicto ${answer.verdict}.`)).toBeVisible();

    // El veredicto se registró una vez: el acto ya no se ofrece y la mesa publica la vuelta al stock.
    await expect(desk.getByRole('button', { name: 'Registrar veredicto' })).toHaveCount(0);
    await expect(desk.locator('li').filter({ hasText: 'Baja del hallazgo' }))
      .toContainText('Devuelta al stock');
    await expect(desk.getByText(
      `El veredicto devolvió ${quantity} unidades al stock vendible de la sucursal.`)).toBeVisible();
  } finally {
    await desk.close();
  }
}

/** The shelf is back where it started, and the case states the units the verdict returned. */
async function expectReturnedOnce(api: Api, flow: DefectFlow, verdict: string): Promise<void> {
  const branch = await api.as(branchA);
  const warehouse = await api.as(warehouseRole);
  expect(await sellableExisting(branch, flow.shelf.variantId)).toBe(flow.before);
  const resolved = await caseRecord(branch, flow.caseId);
  expect(resolved.phase).toBe('resolved');
  expect(resolved.verdict).toBe(verdict);
  expect(resolved.reported_destination).toBe('stock');
  expect(resolved.stock_destination).toBe('stock');

  // Una sola vez: la resolución ya está dicha y el saldo no se mueve por repetirla.
  const again = await resolutionAttempt(warehouse, flow.caseId,
    { verdict, reported_destination: 'stock', note: 'Otra resolución' }, 409);
  expect(again.body.error).toBe('resolution_final');
  expect(await sellableExisting(branch, flow.shelf.variantId)).toBe(flow.before);
}

test('el hallazgo en góndola descuenta el stock en el alta y el veredicto reparado lo devuelve una sola vez',
  async ({ page, browser, api }) => {
    const flow = await registerDefect(page, api);
    await sendToFactory(api, flow);

    // El viaje no devuelve nada: la baja sigue descontada hasta que la fábrica responde.
    const branch = await api.as(branchA);
    expect(await sellableExisting(branch, flow.shelf.variantId)).toBe(flow.before - quantity);

    await resolveOnDesk(browser, api, flow, { label: 'Reparada', verdict: 'reparada' });
    await expectReturnedOnce(api, flow, 'repaired');
  });

test('un hallazgo reemplazado vuelve al stock de la sucursal por la misma cantidad y una sola vez',
  async ({ page, browser, api }) => {
    const flow = await registerDefect(page, api);
    await sendToFactory(api, flow);

    const branch = await api.as(branchA);
    expect(await sellableExisting(branch, flow.shelf.variantId)).toBe(flow.before - quantity);

    await resolveOnDesk(browser, api, flow, { label: 'Reemplazada', verdict: 'reemplazada' });
    await expectReturnedOnce(api, flow, 'replaced');
  });
