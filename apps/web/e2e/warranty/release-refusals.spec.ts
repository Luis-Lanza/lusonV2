import {
  addLoan, advance, arrangeBatterySale, arrangeUsedPool, branchA, caseRecord, expect, openCase, openClaim,
  openDeskBucket, registerNotice, release, resolveClaim, sellableExisting, test, warehouseDeskPage,
  warehouseRole,
} from './harness';

/**
 * S11, S13, S14, S31 · the release of a case whose unit never came back.
 *
 * The release returns the single unit a claim got back from the factory as a sellable battery, and the
 * verdict is the fact that says whether there is one: the factory returned it `repaired` or `replaced`,
 * or it never came back as something the branch may sell (077). A claim the factory answered `lost` —
 * the unit stayed with whoever kept it — declared to the client holds nothing in custody, so the desk of
 * the Almacén offers no release for it and the route answers `409 nothing_to_release`, writing no event
 * and no balance: one unit of stock that never existed is the defect this closes.
 *
 * The journey to the factory's answer is arranged through the API, with a serial unique to this run; the
 * refusal is read from the route itself and from the desk's own words, and the branch's sellable balance
 * is read before and after so the negative is a figure and not a promise.
 */
test('un caso cuya unidad la fábrica no devolvió no ofrece liberación, la ruta responde nothing_to_release y el saldo no se mueve',
  async ({ browser, api }) => {
    const branch = await api.as(branchA);
    const warehouse = await api.as(warehouseRole);
    // El armado es del API (S35): la venta que da el serial único, la usada que el préstamo necesita para
    // que el reclamo salga de la sucursal, y el viaje hasta el veredicto de la fábrica.
    const sale = await arrangeBatterySale({ branch, warehouse }, 'norelease');
    const model = await arrangeUsedPool({ branch, warehouse }, 'norelease');
    const claim = await openClaim(branch, sale.serial, 'No arranca el motor');
    await addLoan(branch, claim.id, { model, quantity: 1, source_location_id: branch.locationId });
    await advance(branch, claim.id, 'in_transit', 'Sale al Almacén');
    await advance(warehouse, claim.id, 'at_warehouse', 'Recibida en el Almacén');
    await advance(warehouse, claim.id, 'at_factory', 'Enviada a fábrica',
      `LEG-${Date.now().toString(36).toUpperCase()}`);
    // La fábrica retuvo la unidad y el caso la declaró al cliente: no volvió nada que la sucursal pueda vender.
    const resolved = await resolveClaim(warehouse, claim.id, {
      verdict: 'lost', reported_destination: 'customer', loan_destination: 'customer',
      note: 'La fábrica retuvo la unidad: no volvió',
    });
    if (resolved.phase !== 'resolved' || resolved.verdict !== 'lost') {
      throw new Error(`el arrange no dejó el caso listo: ${resolved.phase} · ${resolved.verdict}`);
    }
    // El aviso es de la sucursal y la liberación lo exige: se registra acá para que la negativa que esta
    // prueba lee sea la de la unidad y no la del aviso que falta.
    await registerNotice(branch, claim.id, 'Avisado el cliente: la batería no volvió de fábrica');
    const before = await sellableExisting(branch, sale.variantId);

    // La mesa del Almacén no ofrece la liberación de una unidad que no existe.
    const desk = await warehouseDeskPage(browser);
    try {
      await openDeskBucket(desk, 'Devueltas sin decidir');
      await openCase(desk, claim.case_number);
      await expect(desk.getByRole('heading', { name: 'Autorizar la liberación' })).toHaveCount(0);
      await expect(desk.getByRole('button', { name: 'Autorizar la liberación a stock' })).toHaveCount(0);
      await expect(desk.getByLabel('Motivo de la liberación')).toHaveCount(0);
      // Y lo dice con las palabras del acto que no ofrece: la fábrica la retuvo, así que no hay unidad que
      // liberar. La frase aparece en el cruce de la liberación y en el cierre de los actos del Almacén, que
      // son el mismo hecho dicho dos veces; alcanza con que la diga.
      await expect(desk.getByText('no tiene ninguna unidad que liberar').first()).toBeVisible();
    } finally {
      await desk.close();
    }

    // La ruta se niega con su propio código, y la negativa no escribe el evento.
    const refused = await release(warehouse, claim.id, 'El cliente no vino: la unidad no volvió', 409);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('nothing_to_release');

    // El caso conserva lo que era: resuelto, `lost`, sin liberación en su historia.
    const untouched = await caseRecord(branch, claim.id);
    expect(untouched.phase).toBe('resolved');
    expect(untouched.verdict).toBe('lost');
    expect(untouched.events.some(entry => entry.kind === 'release')).toBe(false);

    // Y el saldo vendible no se movió: ninguna unidad de stock que nunca existió.
    expect(await sellableExisting(branch, sale.variantId)).toBe(before);
  });
