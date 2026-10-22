// Parent-only, once-only matrix. Importing does not invoke browser/network work.
// Pass in-memory accounts [{locationId:1|2|3, username, password}] and the parent's
// TLS-trusted/pinned Chromium. No tracing/debug logs/HAR, credential-file reads,
// raw exceptions, request payloads, cookies, session DTOs, or direct API writes.
// Existing matrix-journal.jsonl always refuses. There is NO resume/newRun switch.
import { createRequire } from 'node:module';
import { mkdir, open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const require = createRequire(new URL('../../../apps/web/package.json', import.meta.url));
const { parse } = require('lossless-json');
const root = path.dirname(fileURLToPath(import.meta.url));
const must = value => { if (!value) throw new Error('matrix_check_failed'); };
const number = value => { const s = String(value); must(/^(0|[1-9]\d*)$/.test(s)); const n = BigInt(s); must(n <= 9223372036854775807n); return n; };
const serial = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? String(v) : v);
const button = (page, name) => page.getByRole('button', { name, exact: true });
const variant = 1; // Pilot TR-006 used this variant; fresh stock is mandatory, not assumed.
const routes = [
  { flow: 'requestWarehouse', kind: 'request_stock', creator: 2, origin: 1, destination: 2, approver: 1 },
  { flow: 'requestOther', kind: 'request_stock', creator: 2, origin: 3, destination: 2, approver: 3 },
  { flow: 'sendWarehouse', kind: 'send_to_warehouse', creator: 2, origin: 2, destination: 1, approver: 1 },
  { flow: 'directA', kind: 'direct_shipment', creator: 1, origin: 1, destination: 2, approver: 1 },
  { flow: 'directB', kind: 'direct_shipment', creator: 1, origin: 1, destination: 3, approver: 1 },
];
const plan = routes.flatMap((route, index) => {
  const outcomes = index === 0 ? ['reject_pending', 'cancel_pending', 'cancel_approved']
    : index < 3 ? ['happy', 'reject_pending', 'cancel_pending', 'cancel_approved'] : ['happy', 'cancel_approved'];
  return outcomes.map(outcome => ({ ...route, caseId: `${route.flow}-${outcome}`, outcome,
    q: outcome === 'happy' ? index < 3 ? 3 : index === 3 ? 2 : 1 : 1,
    actual: outcome === 'happy' ? index < 3 ? 1 : 2 : null }));
});

export async function matrix({ browser, accounts, baseURL, outputDir }) {
  let file, phase = 'setup', currentCase = null, record = null, uncertain = false, result;
  let creationAttempts = 0, lastStock = null;
  const actors = new Map(), contexts = [], completed = [], created = [];
  const marker = `Aceptación QA ${randomUUID()}`, journal = path.join(root, 'matrix-journal.jsonl');
  const emit = async entry => { await file.write(serial({ time: new Date().toISOString(), caseId: currentCase?.caseId ?? null, phase, reference: record?.reference ?? null, ...entry }) + '\n'); await file.sync(); };
  const click = async (control, action) => { await emit({ type: 'ui_click', action }); await control.click(); };
  const get = async (page, apiPath) => {
    const reply = await page.evaluate(async apiPath => {
      const r = await fetch(apiPath, { method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000) });
      return { status: r.status, body: r.status === 200 ? await r.text() : '' };
    }, apiPath);
    await emit({ type: 'GET', path: apiPath, status: reply.status });
    must(reply.status === 200); return parse(reply.body);
  };
  const identity = async location => {
    const valid = await actors.get(location).evaluate(async ({ location, username }) => {
      const r = await fetch('/api/auth/validate', { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000) });
      if (r.status !== 200) return false;
      const s = await r.json(); return s.authenticated === true && s.identity?.location?.id === location && s.identity?.username === username;
    }, { location, username: accounts.find(a => a.locationId === location).username });
    must(valid);
  };
  const stocks = async () => {
    const snapshot = {};
    for (const location of [1, 2, 3]) {
      await identity(location);
      let total, count = 0, last = 0n;
      for (let page = 1; page <= 4; page++) {
        const d = await get(actors.get(location), `/api/inventory?location_id=${location}&page=${page}&page_size=50`);
        must(number(d.location.id) === BigInt(location) && number(d.page) === BigInt(page) && number(d.page_size) === 50n);
        const size = number(d.total_variants); must(size <= 190n && (total === undefined || total === size)); total = size;
        must(Array.isArray(d.items) && BigInt(d.items.length) === (size - BigInt(count) > 50n ? 50n : size - BigInt(count)));
        for (const row of d.items) {
          const id = number(row.variant_id), existing = number(row.existing), reserved = number(row.reserved), available = number(row.available);
          must(id > last && id <= 190n && existing >= reserved && available === existing - reserved); last = id;
          snapshot[`${location}/${id}`] = { existing, reserved, available }; count++;
        }
        if (BigInt(count) === total) break;
      }
      must(BigInt(count) === total && snapshot[`${location}/${variant}`]);
    }
    return snapshot;
  };
  const locator = d => {
    must(typeof d.id === 'string' && number(d.id) > 0n && d.reference === `TR-${d.id.padStart(3, '0')}`);
    return { id: d.id, reference: d.reference };
  };
  const sanitizedRecord = d => {
    const out = locator(d);
    must(['pending', 'approved', 'rejected', 'cancelled', 'in_transit', 'received'].includes(d.status));
    must(['request_stock', 'send_to_warehouse', 'direct_shipment'].includes(d.kind));
    Object.assign(out, { status: d.status, kind: d.kind });
    for (const k of ['creator_location_id', 'origin_location_id', 'destination_location_id', 'approver_location_id', 'decision_location_id', 'dispatch_location_id', 'receipt_location_id', 'cancellation_location_id']) {
      if (d[k] !== undefined) { const n = number(d[k]); must(n >= 1n && n <= 3n); out[k] = String(n); }
    }
    for (const k of ['created_at', 'decided_at', 'dispatched_at', 'received_at', 'cancelled_at']) {
      if (d[k] !== undefined) { must(typeof d[k] === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(d[k])); out[k] = d[k]; }
    }
    must(Array.isArray(d.items)); out.items = d.items.map(i => ({ variant_id: String(number(i.variant_id)), quantity: String(number(i.quantity)) }));
    if (d.receipt) {
      must(Array.isArray(d.receipt.items) && Array.isArray(d.receipt.exceptions));
      out.receipt = { items: d.receipt.items.map(i => Object.fromEntries(['variant_id', 'expected_quantity', 'actual_quantity', 'available_quantity'].map(k => [k, String(number(i[k]))]))),
        exceptions: d.receipt.exceptions.map(i => { must(['shortage', 'excess', 'unexpected'].includes(i.kind)); return { variant_id: String(number(i.variant_id)), kind: i.kind, quantity: String(number(i.quantity)) }; }) };
    }
    return out;
  };
  const validate = (d, state, previous) => {
    const c = currentCase;
    must(d.status === state && d.kind === c.kind && d.created_at);
    for (const [key, expected] of Object.entries({ creator: c.creator, origin: c.origin, destination: c.destination, approver: c.approver })) must(d[`${key}_location_id`] === String(expected));
    must(serial(d.items) === serial([{ variant_id: String(variant), quantity: String(c.q) }]));
    if (previous) for (const k of Object.keys(previous).filter(k => k !== 'status')) must(serial(d[k]) === serial(previous[k]));
    const decided = ['approved', 'rejected', 'in_transit', 'received'].includes(state) || (state === 'cancelled' && previous?.status === 'approved');
    if (decided) must(d.decision_location_id === String(c.approver) && d.decided_at);
    else must(d.decision_location_id === undefined && d.decided_at === undefined);
    if (c.kind === 'direct_shipment') must(d.decided_at === d.created_at && !['pending', 'rejected'].includes(state));
    if (['in_transit', 'received'].includes(state)) must(d.dispatch_location_id === String(c.origin) && d.dispatched_at);
    else must(d.dispatch_location_id === undefined && d.dispatched_at === undefined);
    if (state === 'cancelled') must(d.cancellation_location_id === String(c.creator) && d.cancelled_at);
    else must(d.cancellation_location_id === undefined && d.cancelled_at === undefined);
    if (state === 'received') {
      const q = BigInt(c.q), actual = BigInt(c.actual), credit = q < actual ? q : actual, difference = actual - q;
      const receipt = { items: [{ variant_id: String(variant), expected_quantity: String(q), actual_quantity: String(actual), available_quantity: String(credit) }],
        exceptions: difference ? [{ variant_id: String(variant), kind: difference < 0n ? 'shortage' : 'excess', quantity: String(difference < 0n ? -difference : difference) }] : [] };
      must(d.receipt_location_id === String(c.destination) && d.received_at && serial(d.receipt) === serial(receipt));
    } else must(d.receipt === undefined && d.receipt_location_id === undefined && d.received_at === undefined);
  };
  const mutate = async (location, control, action, state) => {
    const c = currentCase, creating = action === 'create', previous = creating ? null : record;
    must(!uncertain && (!creating || creationAttempts < 15));
    await identity(location);
    const before = await stocks(), expected = structuredClone(before), q = BigInt(c.q);
    const stable = lastStock === null || serial(lastStock) === serial(before);
    await emit({ type: 'stock_stability', pass: stable, ...(!stable ? { expected: lastStock, observed: before } : {}) }); must(stable);
    const origin = expected[`${c.origin}/${variant}`], destination = expected[`${c.destination}/${variant}`];
    if (creating || action === 'approve') must(origin.available >= q);
    if ((creating && c.kind === 'direct_shipment') || action === 'approve') { origin.reserved += q; origin.available -= q; }
    if (action === 'dispatch') { origin.existing -= q; origin.reserved -= q; }
    if (action === 'receive') { const actual = BigInt(c.actual), credit = actual < q ? actual : q; destination.existing += credit; destination.available += credit; }
    if (action === 'cancel' && previous.status === 'approved') { origin.reserved -= q; origin.available += q; }
    const apiPath = creating ? '/api/transfers' : `/api/transfers/${record.id}/${action}`;
    await emit({ type: 'mutation_attempt', marker, action, record, path: apiPath, before, expected, quantity: String(c.q) });
    if (creating) creationAttempts++;
    uncertain = true;
    const page = actors.get(location);
    const reply = page.waitForResponse(r => r.url() === baseURL + apiPath && r.request().method() === 'POST', { timeout: 20000 }).catch(() => null);
    let clicked = true; try { await control.click(); } catch { clicked = false; }
    const response = await reply;
    await emit({ type: 'mutation_response', status: response?.status() ?? null, clickCompleted: clicked });
    must(response && response.status() === (creating ? 201 : 200));
    const dto = parse(await response.text()), found = locator(dto);
    await emit({ type: 'record_locator', marker, ...found });
    if (creating) {
      must(!created.some(entry => entry.id === found.id) && found.id !== '6');
      record = found; created.push({ caseId: c.caseId, ...found });
    }
    const observed = sanitizedRecord(dto); await emit({ type: 'record', record: observed });
    validate(observed, state, previous); record = observed; must(clicked);
    const current = sanitizedRecord(await get(page, `/api/transfers/${record.id}`));
    must(serial(current) === serial(record));
    const after = await stocks(), pass = serial(after) === serial(expected);
    await emit({ type: 'stock_comparison', before, expected, observed: after, pass }); must(pass);
    lastStock = after; uncertain = false;
  };
  const detail = async location => {
    const page = actors.get(location); await identity(location);
    await page.goto(`${baseURL}/#/transferencias/${record.id}`, { waitUntil: 'domcontentloaded' }); return page;
  };
  const transition = async (location, trigger, confirmation, action, state) => {
    phase = action;
    const page = await detail(location);
    await click(button(page, trigger), trigger);
    await mutate(location, button(page.getByRole('dialog'), confirmation), action, state);
    if (action === 'cancel') await page.getByRole('dialog').waitFor({ state: 'detached' });
    else await click(button(page.getByRole('dialog'), 'Volver al detalle'), 'Volver al detalle');
  };
  try {
    must(baseURL === 'https://localhost:4323' && plan.length === 15);
    must(Array.isArray(accounts) && accounts.length === 3 && [1, 2, 3].every(id => accounts.filter(a => a.locationId === id && typeof a.username === 'string' && typeof a.password === 'string').length === 1));
    const output = path.resolve(outputDir); must(output === root || output.startsWith(root + path.sep));
    await mkdir(output, { recursive: true });
    file = await open(journal, 'wx', 0o600); // Global barrier, cannot bypass by changing outputDir.
    result = { status: 'stopped', journal };
    await emit({ type: 'plan', marker, variant, cases: plan, maxNewRecords: 15, maxQuantity: 3, priorPilotId: '6', totalPlannedRecordsIncludingPilot: 16, outputDir: output,
      notProved: ['backend negative authorization', 'nonparticipant controls', 'count corrections', 'restitutions', 'mobile', 'navigation', 'uncertain recovery'], fictionalLocalTrial: true });
    for (const location of [1, 2, 3]) {
      phase = `login-${location}`;
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: false }); contexts.push(context);
      const page = await context.newPage(); actors.set(location, page); page.setDefaultTimeout(15000); page.setDefaultNavigationTimeout(15000);
      await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
      const account = accounts.find(a => a.locationId === location);
      await page.getByLabel('Usuario', { exact: true }).fill(account.username);
      await page.getByLabel('Contraseña', { exact: true }).fill(account.password);
      await click(button(page, 'Iniciar sesión'), 'Iniciar sesión'); await button(page, 'Cerrar sesión').waitFor(); await identity(location);
    }
    lastStock = await stocks(); await emit({ type: 'initial_stock', observed: lastStock });
    for (const c of plan) {
      currentCase = c; record = null; phase = 'create'; must(c.q >= 1 && c.q <= 3);
      await emit({ type: 'case_start', marker, plan: c });
      const creator = actors.get(c.creator), direct = c.kind === 'direct_shipment';
      await identity(c.creator); await creator.goto(baseURL, { waitUntil: 'domcontentloaded' });
      await click(creator.getByRole('button', { name: /Nueva transferencia/ }), 'Nueva transferencia');
      await creator.getByRole('combobox', { name: 'Tipo de transferencia', exact: true }).selectOption(c.flow);
      const quantity = creator.locator(`#source-quantity-${variant}`); await quantity.fill(String(c.q));
      await click(quantity.locator('xpath=ancestor::tr').getByRole('button', { name: /^Añadir / }), 'Añadir variante');
      await click(button(creator, direct ? 'Revisar envío' : 'Revisar solicitud'), 'Revisar creación');
      const review = creator.getByRole('dialog');
      const lines = review.getByRole('table', { name: 'Selección inmutable', exact: true }).locator('tbody tr');
      must(await lines.count() === 1 && (await lines.locator('td').last().innerText()).trim() === String(c.q));
      await mutate(c.creator, button(review, direct ? 'Crear envío y reservar' : 'Enviar solicitud'), 'create', direct ? 'approved' : 'pending');
      await click(button(review, 'Ver detalle'), 'Ver detalle');
      if (c.outcome === 'reject_pending') {
        await transition(c.approver, c.kind === 'send_to_warehouse' ? 'Rechazar envío' : 'Rechazar solicitud', 'Confirmar rechazo', 'reject', 'rejected');
      } else if (c.outcome === 'cancel_pending') {
        await transition(c.creator, c.kind === 'send_to_warehouse' ? 'Cancelar propuesta' : 'Cancelar solicitud', 'Confirmar cancelación', 'cancel', 'cancelled');
      } else {
        if (!direct) await transition(c.approver, c.kind === 'send_to_warehouse' ? 'Aprobar envío' : 'Aprobar solicitud', 'Confirmar aprobación', 'approve', 'approved');
        if (c.outcome === 'cancel_approved') {
          await transition(c.creator, direct ? 'Cancelar envío' : c.kind === 'send_to_warehouse' ? 'Cancelar propuesta' : 'Cancelar solicitud', 'Confirmar cancelación', 'cancel', 'cancelled');
        } else {
          await transition(c.origin, c.kind === 'request_stock' ? 'Despachar solicitud' : 'Despachar envío', 'Confirmar despacho', 'dispatch', 'in_transit');
          phase = 'receive'; const receiver = await detail(c.destination);
          await click(button(receiver, c.kind === 'request_stock' ? 'Recibir solicitud' : 'Registrar recepción'), 'Capturar recepción');
          await receiver.getByRole('dialog').locator(`#receipt-quantity-${variant}`).fill(String(c.actual));
          await click(button(receiver.getByRole('dialog'), 'Revisar recepción'), 'Revisar recepción');
          await mutate(c.destination, button(receiver.getByRole('dialog'), 'Confirmar recepción'), 'receive', 'received');
          await click(button(receiver.getByRole('dialog'), 'Volver al detalle'), 'Volver al detalle');
        }
      }
      completed.push({ caseId: c.caseId, id: record.id, reference: record.reference, status: record.status });
      await emit({ type: 'case_completed', marker, record, completedCount: completed.length });
    }
    result = { ...result, status: 'matrix_pass', completed, created, creationAttempts };
    await emit({ type: 'result', ...result, coverage: '15 planned route/state cases only' });
  } catch {
    result = { ...result, status: 'stopped', phase, caseId: currentCase?.caseId ?? null, id: record?.id ?? null, uncertain, completed, created, creationAttempts, code: 'unexpected_or_existing_journal_no_retry' };
    if (file) {
      if (phase === 'create' && uncertain && !record && currentCase) try {
        const confirmed = actors.get(currentCase.creator).getByRole('region', { name: 'Resultado confirmado', exact: true });
        const match = (await confirmed.innerText({ timeout: 2000 })).match(/\bID: ([1-9]\d*)\b/);
        if (match) { record = { id: match[1], reference: `TR-${match[1].padStart(3, '0')}` }; result.id = record.id; await emit({ type: 'record_locator_from_UI', marker, ...record }); }
      } catch { /* Unknown creation remains unknown; never retry. */ }
      await emit({ type: 'stopped', ...result });
      if (record?.id && currentCase) try {
        await emit({ type: 'reconciliation_GET_only', record: sanitizedRecord(await get(actors.get(currentCase.creator), `/api/transfers/${record.id}`)) });
      } catch { await emit({ type: 'reconciliation_unavailable' }); }
    }
  } finally {
    for (const [location, page] of actors) {
      if (uncertain) { await emit({ type: 'logout_skipped_uncertain', location }); result.cleanupIncomplete = true; continue; }
      try {
        // No Escape. Settled success paths explicitly close their normal modals.
        // If a pre-submit modal remains, do not force it closed to reach logout.
        await click(button(page, 'Cerrar sesión'), 'Cerrar sesión'); await page.getByLabel('Usuario', { exact: true }).waitFor();
        await emit({ type: 'logout', location, pass: true });
      } catch { if (file) await emit({ type: 'logout', location, pass: false }); if (result) result.cleanupIncomplete = true; }
    }
    for (const context of contexts) try { await context.close(); } catch { if (result) result.cleanupIncomplete = true; }
    if (file) { await emit({ type: 'final_summary', ...result }); await file.close(); }
  }
  return result;
}
