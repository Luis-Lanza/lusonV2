// Parent-only execution. No automatic invocation, credential-file/env reads, traces,
// screenshots, raw errors, request bodies, or header logging. Browser must already
// trust the local certificate (parent's pinned SPKI); certificate checks stay on.
// accounts: [{locationId: 1|2|3, username, password}]. newRun=true is an EXPLICIT
// authorization for another run, never recovery: inspect the previous journal first.
import { createRequire } from 'node:module';
import { readFile, mkdir, open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const require = createRequire(new URL('../../../apps/web/package.json', import.meta.url));
const { parse } = require('lossless-json');
const root = path.dirname(fileURLToPath(import.meta.url));
const must = value => { if (!value) throw new Error('pilot_check_failed'); };
const number = value => { const s = String(value); must(/^(0|[1-9]\d*)$/.test(s)); const n = BigInt(s); must(n <= 9223372036854775807n); return n; };
const serial = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? String(v) : v);
const button = (page, name) => page.getByRole('button', { name, exact: true });

export async function pilot({ browser, accounts, baseURL, outputDir, newRun = false }) {
  let file, phase = 'setup', record = null, attempted = false, result;
  const actors = new Map(), contexts = [], marker = `Aceptación QA ${randomUUID()}`;
  const emit = async entry => { await file.write(serial({ time: new Date().toISOString(), phase, ...entry }) + '\n'); await file.sync(); };
  const get = async (page, apiPath) => {
    const reply = await page.evaluate(async apiPath => {
      const r = await fetch(apiPath, { method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000) });
      return { status: r.status, body: r.status === 200 ? await r.text() : '' };
    }, apiPath);
    await emit({ type: 'GET', path: apiPath, status: reply.status });
    must(reply.status === 200); return parse(reply.body);
  };
  const identity = async location => {
    const page = actors.get(location), account = accounts.find(a => a.locationId === location);
    const valid = await page.evaluate(async ({ location, username }) => {
      const r = await fetch('/api/auth/validate', { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000) });
      if (r.status !== 200) return false;
      const s = await r.json(); return s.authenticated === true && s.identity?.location?.id === location && s.identity?.username === username;
    }, { location, username: account.username });
    must(valid); // Only a boolean leaves browser memory; no session/CSRF artifact.
  };
  let variant;
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
  const sanitizedRecord = d => {
    must(typeof d.id === 'string' && number(d.id) > 0n && d.reference === `TR-${d.id.padStart(3, '0')}`);
    // Capture identity before validating the lifecycle, so unexpected results retain a locator.
    const out = { id: d.id, reference: d.reference };
    must(['pending', 'approved', 'in_transit', 'received'].includes(d.status));
    Object.assign(out, { status: d.status, kind: d.kind });
    for (const k of ['creator_location_id', 'origin_location_id', 'destination_location_id', 'approver_location_id', 'decision_location_id', 'dispatch_location_id', 'receipt_location_id']) {
      if (d[k] !== undefined) out[k] = String(number(d[k]));
    }
    for (const k of ['created_at', 'decided_at', 'dispatched_at', 'received_at']) {
      if (d[k] !== undefined) { must(typeof d[k] === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(d[k])); out[k] = d[k]; }
    }
    must(Array.isArray(d.items)); out.items = d.items.map(i => ({ variant_id: String(number(i.variant_id)), quantity: String(number(i.quantity)) }));
    if (d.receipt) {
      must(Array.isArray(d.receipt.items) && Array.isArray(d.receipt.exceptions));
      out.receipt = { items: d.receipt.items.map(i => Object.fromEntries(['variant_id', 'expected_quantity', 'actual_quantity', 'available_quantity'].map(k => [k, String(number(i[k]))]))), exceptionCount: d.receipt.exceptions.length };
    }
    return out;
  };
  const validate = (d, state, previous) => {
    must(d.status === state && d.kind === 'request_stock' && d.creator_location_id === '2' && d.origin_location_id === '1' && d.destination_location_id === '2' && d.approver_location_id === '1');
    must(d.created_at && serial(d.items) === serial([{ variant_id: String(variant), quantity: '1' }]));
    if (state !== 'pending') must(d.decision_location_id === '1' && d.decided_at);
    if (['in_transit', 'received'].includes(state)) must(d.dispatch_location_id === '1' && d.dispatched_at);
    if (previous) for (const k of Object.keys(previous).filter(k => k !== 'status')) must(serial(d[k]) === serial(previous[k]));
    if (state === 'received') must(d.receipt_location_id === '2' && d.received_at && serial(d.receipt) === serial({ items: [{ variant_id: String(variant), expected_quantity: '1', actual_quantity: '1', available_quantity: '1' }], exceptionCount: 0 }));
  };
  const mutate = async (location, apiPath, control, state, changes) => {
    await identity(location);
    const before = await stocks(), expected = structuredClone(before);
    if (state === 'pending') must(before[`1/${variant}`].available >= 3n);
    if (state === 'approved') must(before[`1/${variant}`].available >= 1n);
    for (const [key, delta] of Object.entries(changes)) for (const [field, amount] of Object.entries(delta)) expected[key][field] += BigInt(amount);
    await emit({ type: 'mutation_attempt', marker, record, path: apiPath, before, expected, maxNewRecords: 1, quantity: '1' });
    attempted = true;
    const page = actors.get(location);
    // Install before clicking; catch immediately to prevent raw unhandled errors.
    const reply = page.waitForResponse(r => r.url() === baseURL + apiPath && r.request().method() === 'POST', { timeout: 20000 }).catch(() => null);
    let clicked = true;
    try { await control.click(); } catch { clicked = false; }
    const response = await reply;
    await emit({ type: 'mutation_response', status: response?.status() ?? null, clickCompleted: clicked });
    must(response && response.status() === (state === 'pending' ? 201 : 200));
    const dto = parse(await response.text());
    if (typeof dto.id === 'string' && /^[1-9]\d*$/.test(dto.id) && dto.reference === `TR-${dto.id.padStart(3, '0')}`) {
      await emit({ type: 'record_locator', marker, id: dto.id, reference: dto.reference });
      if (!record) record = { id: dto.id, reference: dto.reference };
    }
    const previous = record?.status ? record : null, observed = sanitizedRecord(dto);
    await emit({ type: 'record', record: observed });
    validate(observed, state, previous); record = observed;
    must(clicked);
    const current = sanitizedRecord(await get(page, `/api/transfers/${record.id}`));
    must(serial(current) === serial(record));
    const after = await stocks();
    await emit({ type: 'stock_comparison', before, expected, observed: after, pass: serial(after) === serial(expected) });
    must(serial(after) === serial(expected));
  };
  try {
    must(baseURL === 'https://localhost:4323' && typeof newRun === 'boolean');
    must(Array.isArray(accounts) && [1, 2, 3].every(id => accounts.filter(a => a.locationId === id && typeof a.username === 'string' && typeof a.password === 'string').length === 1));
    const output = path.resolve(outputDir); must(output === root || output.startsWith(root + path.sep));
    await mkdir(output, { recursive: true });
    // Root-scoped exclusive journal is a durable rerun barrier, independent of outputDir.
    const journal = path.join(root, newRun ? `pilot-explicit-new-${randomUUID()}.jsonl` : 'pilot-journal.jsonl');
    file = await open(journal, 'wx', 0o600);
    result = { status: 'stopped', journal };
    const preflight = JSON.parse(await readFile(new URL('./parent-preflight.json', import.meta.url), 'utf8'));
    const source = parse(preflight.inventory.find(p => p.location === 1 && p.page === 1).raw);
    const candidate = source.items.find(i => number(i.variant_id) <= 25n && number(i.available) >= 3n);
    must(candidate); variant = Number(number(candidate.variant_id));
    await emit({ type: 'plan', marker, case: 'A-request-warehouse-exact-one', variant, quantity: '1', historicalAvailable: String(number(candidate.available)), phases: ['create', 'approve', 'dispatch', 'receive'], journal, outputDir: output, fictionalLocalTrial: true });
    for (const location of [1, 2, 3]) {
      phase = `login-${location}`;
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: false }); contexts.push(context);
      const page = await context.newPage(); actors.set(location, page); page.setDefaultTimeout(15000); page.setDefaultNavigationTimeout(15000);
      await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
      const account = accounts.find(a => a.locationId === location);
      await page.getByLabel('Usuario', { exact: true }).fill(account.username);
      await page.getByLabel('Contraseña', { exact: true }).fill(account.password);
      await emit({ type: 'login_attempt', location }); await button(page, 'Iniciar sesión').click();
      await button(page, 'Cerrar sesión').waitFor(); await identity(location);
    }
    const a = actors.get(2), warehouse = actors.get(1);
    phase = 'create';
    await a.getByRole('button', { name: /Nueva transferencia/ }).click();
    await a.getByRole('combobox', { name: 'Tipo de transferencia', exact: true }).selectOption('requestWarehouse');
    const quantity = a.locator(`#source-quantity-${variant}`); await quantity.fill('1');
    await quantity.locator('xpath=ancestor::tr').getByRole('button', { name: /^Añadir / }).click();
    await button(a, 'Revisar solicitud').click();
    const review = a.getByRole('dialog');
    const lines = review.getByRole('table', { name: 'Selección inmutable', exact: true }).locator('tbody tr');
    must(await lines.count() === 1 && (await lines.locator('td').last().innerText()).trim() === '1');
    await mutate(2, '/api/transfers', button(review, 'Enviar solicitud'), 'pending', {});
    await button(review, 'Ver detalle').click();
    phase = 'approve';
    await warehouse.goto(`${baseURL}/#/transferencias/${record.id}`, { waitUntil: 'domcontentloaded' });
    await button(warehouse, 'Aprobar solicitud').click();
    await mutate(1, `/api/transfers/${record.id}/approve`, button(warehouse.getByRole('dialog'), 'Confirmar aprobación'), 'approved', { [`1/${variant}`]: { reserved: 1, available: -1 } });
    await button(warehouse.getByRole('dialog'), 'Volver al detalle').click();
    phase = 'dispatch';
    await button(warehouse, 'Despachar solicitud').click();
    await mutate(1, `/api/transfers/${record.id}/dispatch`, button(warehouse.getByRole('dialog'), 'Confirmar despacho'), 'in_transit', { [`1/${variant}`]: { existing: -1, reserved: -1 } });
    await button(warehouse.getByRole('dialog'), 'Volver al detalle').click();
    phase = 'receive';
    await a.goto(`${baseURL}/#/transferencias/${record.id}`, { waitUntil: 'domcontentloaded' });
    await button(a, 'Recibir solicitud').click();
    await a.getByRole('dialog').locator(`#receipt-quantity-${variant}`).fill('1');
    await button(a.getByRole('dialog'), 'Revisar recepción').click();
    await mutate(2, `/api/transfers/${record.id}/receive`, button(a.getByRole('dialog'), 'Confirmar recepción'), 'received', { [`2/${variant}`]: { existing: 1, available: 1 } });
    await button(a.getByRole('dialog'), 'Volver al detalle').click();
    result = { ...result, status: 'pilot_pass', id: record.id, reference: record.reference };
    await emit({ type: 'result', ...result, coverage: 'one happy request_stock lifecycle only' });
  } catch {
    result = { ...result, status: 'stopped', phase, attempted, id: record?.id ?? null, code: 'unexpected_or_existing_journal_no_retry' };
    if (file) {
      // Creation may have completed despite a lost response. Read only its GUI
      // result, never search/mutate old business records or submit another attempt.
      if (phase === 'create' && attempted && !record && actors.has(2)) try {
        const confirmed = actors.get(2).getByRole('region', { name: 'Resultado confirmado', exact: true });
        const match = (await confirmed.innerText({ timeout: 2000 })).match(/\bID: ([1-9]\d*)\b/);
        if (match) { record = { id: match[1], reference: `TR-${match[1].padStart(3, '0')}` }; result.id = record.id; await emit({ type: 'record_locator_from_UI', marker, ...record }); }
      } catch { /* Unknown creation stays unknown; no retry. */ }
      await emit({ type: 'stopped', ...result });
      if (record?.id && actors.has(2)) try {
        await emit({ type: 'reconciliation_GET_only', record: sanitizedRecord(await get(actors.get(2), `/api/transfers/${record.id}`)) });
      } catch { await emit({ type: 'reconciliation_unavailable' }); }
    }
  } finally {
    for (const [location, page] of actors) {
      try {
        // Escape only dismisses a settled dialog; never retries a business mutation.
        await page.keyboard.press('Escape');
        await emit({ type: 'logout_attempt', location });
        await button(page, 'Cerrar sesión').click(); await page.getByLabel('Usuario', { exact: true }).waitFor();
        await emit({ type: 'logout', location, pass: true });
      } catch { if (file) await emit({ type: 'logout', location, pass: false }); if (result) result.cleanupIncomplete = true; }
    }
    for (const context of contexts) try { await context.close(); } catch { if (result) result.cleanupIncomplete = true; }
    if (file) await file.close();
  }
  return result;
}
