import {
  arrangeBatterySale, arrangeUsedPool, branchA, expect, openBranchTray, openCase, openClaim, test,
  warehouseRole,
} from './harness';
import {
  caseWithLoans, downloadReceipt, drawnText, pdfPageCount, receiptAnswer, receiptDateCandidates,
} from './loan-harness';

/**
 * S8 · "la entrega de la usada emite un comprobante de una página".
 *
 * The counter hands the used battery over on the case and the case publishes the paper the client
 * leaves with. The spec downloads it the way the operator does — the link of the detail, clicked —
 * and reads what the file really contains, because the renderer draws the page uncompressed
 * (`apps/api/internal/warrantycase/receipt.go:18`, `:159`): the case number, the warranty number of
 * the sale, the serial of the claimed unit, the model, the quantity, the source and the date of the
 * handover, and the conditions of the exchange, all as the database kept them (S8). The document
 * contract the server also promises is asserted on top: one A4 page, `%PDF-` bytes, a stable file
 * name, `application/pdf`, and the same bytes on a second download.
 *
 * The sale and the used pool are arranged by the API (S35): selling and buying are not this flow's
 * subject. The handover itself is the screen's own act, so the paper is born from the same act that
 * gives the client the battery — before it there is no link and the route answers `409 no_loan`.
 */
test('la entrega de la usada emite un comprobante de una página con los datos guardados que se descarga desde el caso',
  async ({ page, api }) => {
    const branch = await api.as(branchA);
    const warehouse = await api.as(warehouseRole);
    const sale = await arrangeBatterySale({ branch, warehouse }, 'comprobante');
    const model = await arrangeUsedPool({ branch, warehouse }, 'comprobante');
    const claim = await openClaim(branch, sale.serial, 'No arranca el motor');

    await openBranchTray(page);
    const detail = await openCase(page, claim.case_number);

    // El caso todavía no entregó ninguna usada: no hay papel que imprimir, ni link ni documento.
    await expect(detail.getByRole('link', { name: /Descargar el comprobante/ })).toHaveCount(0);
    const withoutLoan = await receiptAnswer(branch, claim.id);
    expect(withoutLoan.status).toBe(409);
    expect(JSON.parse(withoutLoan.bytes.toString('utf8'))).toEqual({ error: 'no_loan' });

    // El acto que entrega la usada es el que emite el comprobante: se registra desde la pantalla.
    await detail.getByRole('button', { name: 'Registrar préstamo' }).click();
    const modelField = detail.getByLabel('Modelo de la usada');
    await expect(modelField).toHaveValue('');
    await modelField.selectOption(model);
    await expect(detail.getByLabel('Cantidad')).toHaveValue('1');
    await detail.getByRole('button', { name: 'Registrar préstamo' }).click();
    await expect(page.getByText(
      `Usada registrada en ${claim.case_number}: ${model} · 1 unidad.`)).toBeVisible();

    // El caso ya publica el comprobante, con el nombre estable que el contrato nombra (S8, S20).
    const link = detail.getByRole('link', {
      name: `Descargar el comprobante de préstamo de ${claim.case_number}`,
    });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('download', `comprobante-${claim.case_number}.pdf`);

    // Se descarga desde la pantalla, como el operador, y se lee el archivo que el navegador guardó.
    const download = await downloadReceipt(page, claim.case_number);
    expect(download.filename).toBe(`comprobante-${claim.case_number}.pdf`);
    expect(download.bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(download.bytes.toString('latin1').trimEnd().endsWith('%%EOF')).toBe(true);
    expect(pdfPageCount(download.bytes)).toBe(1);
    expect(download.bytes.toString('latin1')).toContain('/MediaBox [0 0 595.28 841.89]');

    // El préstamo persistido es el que el papel tiene que imprimir, con su fecha y su origen.
    const stored = await caseWithLoans(branch, claim.id);
    expect(stored.loans).toHaveLength(1);
    const loan = stored.loans[0];
    expect(loan.ordinal).toBe(1);
    expect(loan.model).toBe(model);
    expect(loan.quantity).toBe(1);
    expect(loan.source_location_id).toBe(branch.locationId);
    expect(loan.fate).toBe('open');

    const drawn = drawnText(download.bytes);
    const dates = receiptDateCandidates(loan.given_at);
    // La fila de la usada dibuja modelo, cantidad, origen y fecha guardados, en ese orden.
    const rowDate = dates.find(date => drawn.includes(`${model} 1 ${branch.locationName} ${date}`));
    expect(rowDate, `el comprobante no dibuja la fila guardada del préstamo: ${drawn}`).toBeDefined();

    for (const wanted of [
      'COMPROBANTE DE PRÉSTAMO',
      `Caso N° ${claim.case_number}`,
      `Fecha: ${rowDate}`,
      `Nombre: ${sale.customerName}`,
      `Número de serie: ${sale.serial}`,
      `Garantía de la venta: ${sale.warrantyNumber}`,
      'No arranca el motor',
      'BATERÍA USADA ENTREGADA EN PRÉSTAMO',
      'CONDICIONES DEL CANJE',
      // Una condición de las que el cliente lee: el canje y el plazo que no se reinicia (S3, S8).
      'La batería usada se entrega en préstamo, sin cargo, para que el cliente pueda seguir usando su vehículo',
      'El plazo de garantía original no se extiende ni se reinicia por este préstamo.',
    ]) {
      expect(drawn, `el comprobante no dibuja «${wanted}»`).toContain(wanted);
    }

    // El mismo documento por el contrato: los encabezados de una descarga y los mismos bytes dos veces.
    const viaAPI = await receiptAnswer(branch, claim.id);
    expect(viaAPI.status).toBe(200);
    expect(viaAPI.contentType).toBe('application/pdf');
    expect(viaAPI.disposition).toBe(`attachment; filename="comprobante-${claim.case_number}.pdf"`);
    expect(viaAPI.bytes.equals(download.bytes)).toBe(true);
    const second = await receiptAnswer(branch, claim.id);
    expect(second.bytes.equals(viaAPI.bytes)).toBe(true);
  });
