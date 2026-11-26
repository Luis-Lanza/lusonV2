import {
  addLoan, advance, arrangeBatterySale, arrangeUsedPool, branchA, caseRecord, deliver, expect,
  openBranchTray, openCase, openClaim, resolveClaim, sellableExisting, test, warehouseRole,
} from './harness';

/**
 * S35 (8) · S31, S4 · "la entrega al cliente".
 *
 * A resolved claim whose unit is destined for the client closes by delivering the exchange. That act
 * asks for the fate of the lent battery and starts with none chosen, because a decided fate is final
 * (`LW012`) and moves the used pool: without an answer the delivery does not go through and writes
 * nothing. Once the counter answers, the case ends `closed`, labelled as delivered to the client — and
 * never as closed by the release, which is the act of the other destination (S31).
 *
 * The journey to `resolved` and the sale that yields the serial are arranged by the API; the delivery
 * itself is the screen's own act.
 */
test('la entrega al cliente pide el desenlace del préstamo y cierra el caso como entregado, no por la liberación',
  async ({ page, api }) => {
    const branch = await api.as(branchA);
    const warehouse = await api.as(warehouseRole);
    const sale = await arrangeBatterySale({ branch, warehouse }, 'entrega');
    const model = await arrangeUsedPool({ branch, warehouse }, 'entrega');
    const claim = await openClaim(branch, sale.serial, 'No arranca el motor');
    await addLoan(branch, claim.id, { model, quantity: 1, source_location_id: branch.locationId });
    await advance(branch, claim.id, 'in_transit', 'Sale al Almacén');
    await advance(warehouse, claim.id, 'at_warehouse', 'Recibida en el Almacén');
    await advance(warehouse, claim.id, 'at_factory', 'Enviada a fábrica',
      `LEG-${Date.now().toString(36).toUpperCase()}`);
    const resolved = await resolveClaim(warehouse, claim.id, {
      verdict: 'repaired', reported_destination: 'customer', loan_destination: 'stock',
      note: 'Reparada por fábrica',
    });
    if (resolved.phase !== 'resolved' || resolved.reported_destination !== 'customer') {
      throw new Error(`el arrange no dejó el caso listo: ${resolved.phase} · ${resolved.reported_destination}`);
    }

    await openBranchTray(page);
    const detail = await openCase(page, claim.case_number);
    const before = await sellableExisting(branch, sale.variantId);

    // La entrega existe para la unidad que va al cliente, y el caso todavía espera al cliente.
    await expect(detail.getByRole('heading', { name: 'Entregar el canje' })).toBeVisible();
    await expect(detail.getByText('Esperando al cliente', { exact: true })).toBeVisible();

    // El acto pide el desenlace de la usada y arranca sin responder: ninguna opción viene elegida.
    const fate = detail.getByLabel('Qué pasó con la usada');
    await expect(fate).toHaveValue('');
    await expect(fate.locator('option')).toHaveText([
      'Elegí qué pasó con la usada', 'Volvió al local', 'Se la quedó el cliente',
    ]);
    const submit = detail.getByRole('button', { name: 'Entregar canje' });
    await expect(submit).toBeDisabled();
    await expect(detail.getByText(
      'Falta decir qué pasó con la usada prestada: ninguna pantalla elige ese desenlace por el mostrador.')).toBeVisible();

    // Sin desenlace la respuesta se rechaza y no escribe nada: el caso sigue resuelto y el préstamo abierto.
    const refused = await deliver(branch, claim.id, { note: 'Entregar sin decir qué pasó con la usada' }, 400);
    expect(refused.body.error).toBe('invalid_request');
    const untouched = await caseRecord(branch, claim.id);
    expect(untouched.phase).toBe('resolved');
    expect(untouched.loans.map(loan => loan.fate)).toEqual(['open']);
    expect(untouched.events.some(entry => entry.kind === 'release')).toBe(false);
    await expect(detail.getByText('Esperando al cliente', { exact: true })).toBeVisible();

    // Respondido el hecho, la entrega se habilita y el mismo acto entrega y cierra.
    await fate.selectOption({ label: 'Volvió al local' });
    await detail.getByLabel('Palabras del mostrador')
      .fill('La clienta devolvió la usada y se llevó la reparada');
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(page.getByText(
      `Canje entregado en ${claim.case_number}: el caso queda cerrado y la usada, devuelta al canjear.`)).toBeVisible();

    // El rótulo del cierre es el del acto que lo cerró: entregado al cliente, nunca cerrado por la liberación.
    // El rótulo del cierre y el tramo que lo cerró dicen los dos lo mismo: entregada al cliente.
    await expect(detail.getByText('Entregada al cliente', { exact: true }).first()).toBeVisible();
    await expect(detail.getByText('Cerrada por liberación')).toHaveCount(0);
    await expect(detail.getByRole('heading', { name: 'Entregar el canje' })).toHaveCount(0);
    await expect(detail.getByText('El caso está cerrado: no admite más acciones de la sucursal.')).toBeVisible();

    const delivered = await caseRecord(branch, claim.id);
    expect(delivered.phase).toBe('closed');
    expect(delivered.loans.map(loan => loan.fate)).toEqual(['returned']);
    const closing = delivered.events.filter(entry => entry.kind === 'phase').at(-1);
    expect(closing?.phase).toBe('closed');
    expect(delivered.events.some(entry => entry.kind === 'release')).toBe(false);

    // La entrega no escribe stock: la unidad salió con el cliente y la góndola no ganó nada.
    expect(await sellableExisting(branch, sale.variantId)).toBe(before);
  });
