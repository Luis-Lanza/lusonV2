// Parent-only restitution unit. No auto invocation or credential-file/env reads.
// Supply trusted/pinned Chromium and in-memory {locationId, username, password}
// accounts for 1/2/3. Disable tracing/debug/HAR. Existing journal always refuses.
// Only fictional local-trial retained units are attested; never real stock evidence.
import { createRequire } from 'node:module';
import { mkdir, open, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const require = createRequire(new URL('../../../apps/web/package.json', import.meta.url));
const { parse } = require('lossless-json');
const root = path.dirname(fileURLToPath(import.meta.url));
const must = value => { if (!value) throw new Error('restitution_check_failed'); };
const number = value => { const s = String(value); must(/^(0|[1-9]\d*)$/.test(s)); const n = BigInt(s); must(n <= 9223372036854775807n); return n; };
const serial = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? String(v) : v);
const canonical = value => typeof value === 'bigint' ? String(value) : Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
export const same = (a, b) => serial(canonical(a)) === serial(canonical(b));
const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const plan = [
  { id: '10', origin: 3, destination: 2, actor: 3, action: 'propose', phase: 'TR010-propose-1', revision: '1' },
  { id: '10', origin: 3, destination: 2, actor: 3, action: 'propose', phase: 'TR010-replace-1', revision: '2' },
  { id: '10', origin: 3, destination: 2, actor: 2, action: 'reject', phase: 'TR010-reject-1', revision: '2' },
  { id: '14', origin: 2, destination: 1, actor: 2, action: 'propose', phase: 'TR014-propose-1', revision: '1' },
  { id: '14', origin: 2, destination: 1, actor: 1, action: 'accept', phase: 'TR014-accept-1', revision: '1' },
];
const keys = new Set(('id reference kind status created_at decided_at dispatched_at received_at items variant_id brand model capacity_ah polarity quantity ' +
  'creator_location_id creator_location_name origin_location_id origin_location_name destination_location_id destination_location_name approver_location_id approver_location_name ' +
  'decision_location_id dispatch_location_id receipt_location_id receipt exceptions expected_quantity actual_quantity available_quantity ' +
  'request_id lines operations operation_key actor_location_id action expected_revision reason revision recorded_at initiator_location_id base_revision base_credit state decision application accepted effective_credit delta workflow_revision applied_revision effective_actual proposals ' +
  'retained_quantity retained_at_origin count_generation count_applied_revision base_restitution original_credit applied_retained_quantity source_existing_before source_existing_after').split(' '));
export const checkedDTO = value => {
  if (Array.isArray(value)) return value.map(checkedDTO);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => {
    must(keys.has(k)); if (k === 'reason') must(typeof v === 'string' && v.startsWith('Aceptación QA'));
    return [k, checkedDTO(v)];
  }));
  must(value === null || ['string', 'boolean'].includes(typeof value) || (typeof value === 'number' && Number.isSafeInteger(value))); return value;
};
const normalized = d => ({ ...d, operations: [...d.operations].sort((a, b) => a.operation_key.localeCompare(b.operation_key)),
  lines: d.lines.map(l => ({ ...l, proposals: [...l.proposals].sort((a, b) => number(a.revision) < number(b.revision) ? -1 : 1) })) });

export async function restitution({ browser, accounts, baseURL, outputDir }) {
  let file, phase = 'setup', currentId = null, uncertain = false, result, lastStocks;
  const actors = new Map(), contexts = [], originals = new Map(), counts = new Map(), rests = new Map(), completed = [];
  const marker = `Aceptación QA — escenario simulado local ${randomUUID()}`;
  const journal = path.join(root, 'restitution-journal.jsonl');
  const emit = async entry => { await file.write(serial({ time: new Date().toISOString(), phase, id: currentId, reference: currentId ? `TR-${currentId.padStart(3, '0')}` : null, ...entry }) + '\n'); await file.sync(); };
  const click = async (control, action) => { await emit({ type: 'ui_click', action }); await control.click(); };
  const identity = async location => {
    const valid = await actors.get(location).evaluate(async ({ location, username }) => {
      const r = await fetch('/api/auth/validate', { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000) });
      if (r.status !== 200) return false;
      const s = await r.json(); return s.authenticated === true && s.identity?.location?.id === location && s.identity?.account_id === location && s.identity?.username === username;
    }, { location, username: accounts.find(a => a.locationId === location).username }); must(valid);
  };
  const get = async (location, apiPath, inventory = false) => {
    const r = await actors.get(location).evaluate(async apiPath => {
      const response = await fetch(apiPath, { method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000) });
      return { status: response.status, body: response.status === 200 ? await response.text() : '' };
    }, apiPath);
    await emit({ type: 'GET', actor: location, path: apiPath, status: r.status }); must(r.status === 200);
    return inventory ? parse(r.body) : checkedDTO(JSON.parse(r.body));
  };
  const stocks = async () => {
    const snapshot = {};
    for (const location of [1, 2, 3]) {
      await identity(location); let count = 0, last = 0n;
      for (let page = 1; page <= 4; page++) {
        const d = await get(location, `/api/inventory?location_id=${location}&page=${page}&page_size=50`, true);
        must(number(d.location.id) === BigInt(location) && number(d.page) === BigInt(page) && number(d.page_size) === 50n && number(d.total_variants) === 190n);
        must(Array.isArray(d.items) && d.items.length === Math.min(50, 190 - count));
        for (const row of d.items) {
          const id = number(row.variant_id), existing = number(row.existing), reserved = number(row.reserved), available = number(row.available);
          must(id > last && id <= 190n && existing >= reserved && available === existing - reserved); last = id;
          snapshot[`${location}/${id}`] = { existing, reserved, available }; count++;
        }
      }
      must(count === 190);
    }
    must(Object.keys(snapshot).length === 570); return snapshot;
  };
  const restPath = id => `/api/transfers/${id}/restitutions`;
  const lineOf = (d, id) => {
    must(d.request_id === id && d.lines.length === 1 && d.lines[0].variant_id === 1 && Array.isArray(d.operations));
    const line = d.lines[0], count = counts.get(id).lines[0];
    must(line.expected_quantity === '3' && line.original_credit === '1' && line.effective_credit === count.effective_credit && line.count_applied_revision === count.applied_revision);
    must(number(line.count_generation) === BigInt(counts.get(id).operations.length)); return line;
  };
  const immutable = async () => {
    for (const id of ['10', '14']) {
      const record = await get(2, `/api/transfers/${id}`), count = await get(2, `/api/transfers/${id}/count-corrections`);
      const pass = same(record, originals.get(id)) && same(normalized(count), normalized(counts.get(id)));
      await emit({ type: 'immutable_receipt_transfer_count', id, pass }); must(pass);
    }
  };
  const openPane = async (location, id) => {
    await identity(location); const page = actors.get(location);
    await page.goto(`${baseURL}/#/transferencias/${id}`, { waitUntil: 'domcontentloaded' });
    await click(button(page, 'Gestiones'), 'Gestiones');
    await click(page.getByRole('menuitem', { name: 'Restituciones de origen', exact: true }), 'Restituciones de origen');
    const section = page.getByRole('region', { name: 'Restituciones de origen', exact: true });
    await click(button(section, 'Consultar para revisar restitución'), 'Consultar para revisar restitución');
    await section.locator('.restitution-consultation button:not([disabled])').waitFor();
    const item = originals.get(id).items[0];
    const group = section.getByRole('table', { name: 'Gestión de restituciones', exact: true }).getByRole('rowgroup', { name: `${item.brand} · ${item.model} · ${item.capacity_ah} Ah · ${item.polarity}`, exact: true });
    return { page, section, group };
  };
  const expectation = (before, op, step, reason, beforeStocks) => {
    const line = lineOf(before, step.id), proposing = step.action === 'propose';
    must(op.request_id === step.id && op.variant_id === 1 && op.actor_location_id === step.actor && op.action === step.action && op.reason === reason);
    must(op.expected_revision === line.workflow_revision && op.revision === step.revision && op.retained_quantity === (proposing ? '1' : null) && op.retained_at_origin === (proposing ? true : null));
    must(/^[A-Za-z0-9_-]{16,128}$/.test(op.operation_key) && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(op.recorded_at) && !before.operations.some(p => p.operation_key === op.operation_key));
    if (step.action === 'accept') {
      const existing = beforeStocks[`${step.origin}/1`].existing;
      must(op.source_existing_before === String(existing) && op.source_existing_after === String(existing + 1n));
    } else must(op.source_existing_before === null && op.source_existing_after === null);
    const expected = structuredClone(before), l = expected.lines[0]; expected.operations.push(op);
    if (proposing) {
      must(number(op.revision) === number(l.workflow_revision) + 1n);
      for (const p of l.proposals) if (p.state === 'pending') { must(p.initiator_location_id === step.origin); p.state = 'superseded'; }
      l.proposals.push({ revision: op.revision, operation_key: op.operation_key, initiator_location_id: step.origin, retained_quantity: '1', retained_at_origin: true,
        base_revision: l.workflow_revision, count_generation: l.count_generation, count_applied_revision: l.count_applied_revision, base_credit: l.effective_credit,
        base_restitution: l.applied_retained_quantity, reason, recorded_at: op.recorded_at, state: 'pending', decision: null, application: null });
      l.workflow_revision = op.revision;
    } else {
      const p = l.proposals.find(p => p.revision === l.workflow_revision); must(p?.state === 'pending');
      const accepted = step.action === 'accept'; p.state = accepted ? 'applied' : 'rejected';
      p.decision = { operation_key: op.operation_key, actor_location_id: step.destination, accepted, reason, recorded_at: op.recorded_at };
      if (accepted) {
        p.application = { operation_key: op.operation_key, origin_location_id: step.origin, quantity: '1', recorded_at: op.recorded_at };
        l.applied_revision = p.revision; l.applied_retained_quantity = '1';
      }
    }
    return expected;
  };
  try {
    must(baseURL === 'https://localhost:4323');
    must(Array.isArray(accounts) && accounts.length === 3 && [1, 2, 3].every(id => accounts.filter(a => a.locationId === id && typeof a.username === 'string' && typeof a.password === 'string').length === 1));
    const output = path.resolve(outputDir); must(output === root || output.startsWith(root + path.sep)); await mkdir(output, { recursive: true });
    file = await open(journal, 'wx', 0o600); result = { status: 'stopped', journal, newTransfers: 0 };
    await emit({ type: 'plan', marker, steps: plan, newTransfers: 0, existingQATransfers: 16, simulatedAttestationOnly: true, auditViewsExecuted: false });
    // Public sanitized acceptance evidence only, never account-file discovery.
    const prior = (await readFile(new URL('./gestions-journal.jsonl', import.meta.url), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    must(prior.at(-1).status === 'count_phase_pass');
    const priorCounts = checkedDTO(prior.filter(e => e.type === 'step_completed').at(-1).counts);
    for (const location of [1, 2, 3]) {
      phase = `login-${location}`;
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: false }); contexts.push(context);
      const page = await context.newPage(); actors.set(location, page); page.setDefaultTimeout(15000); page.setDefaultNavigationTimeout(15000);
      await page.goto(baseURL, { waitUntil: 'domcontentloaded' }); const account = accounts.find(a => a.locationId === location);
      await page.getByLabel('Usuario', { exact: true }).fill(account.username); await page.getByLabel('Contraseña', { exact: true }).fill(account.password);
      await click(button(page, 'Iniciar sesión'), 'Iniciar sesión'); await button(page, 'Cerrar sesión').waitFor(); await identity(location);
    }
    phase = 'baseline';
    for (const [id, origin, destination, credit, generation] of [['10', 3, 2, '2', '5'], ['14', 2, 1, '1', '0']]) {
      const record = await get(2, `/api/transfers/${id}`), count = await get(2, `/api/transfers/${id}/count-corrections`);
      must(record.id === id && record.reference === `TR-${id.padStart(3, '0')}` && record.status === 'received' && record.origin_location_id === origin && record.destination_location_id === destination && record.creator_location_id === 2);
      must(record.items.length === 1 && record.items[0].variant_id === 1 && record.items[0].quantity === '3');
      must(same(record.receipt, { items: [{ variant_id: 1, expected_quantity: '3', actual_quantity: '1', available_quantity: '1' }], exceptions: [{ variant_id: 1, kind: 'shortage', quantity: '2' }] }));
      must(count.request_id === id && count.lines.length === 1 && count.lines[0].variant_id === 1 && count.lines[0].effective_credit === credit && count.lines[0].effective_actual === credit);
      must(!count.lines[0].proposals.some(p => p.state === 'pending') && String(count.operations.length) === generation);
      if (id === '10') must(same(normalized(count), normalized(priorCounts)));
      originals.set(id, record); counts.set(id, count);
      const rest = await get(2, restPath(id)); rests.set(id, rest); const l = lineOf(rest, id);
      must(l.workflow_revision === '0' && l.applied_revision === '0' && l.applied_retained_quantity === '0' && l.proposals.length === 0 && rest.operations.length === 0);
      await emit({ type: 'baseline_history', id, record, count, restitution: rest, capacity: String(number(l.expected_quantity) - number(l.effective_credit)) });
    }
    lastStocks = await stocks(); await emit({ type: 'initial_stocks', stocks: lastStocks });
    for (const step of plan) {
      phase = step.phase; currentId = step.id;
      const reason = `${marker} — ${phase}. Dentro de esta simulación se declara 1 unidad ficticia retenida en origen; no acredita observación ni verificación física de unidades reales.`;
      const { page, group } = await openPane(step.actor, step.id);
      const beforeRest = await get(step.actor, restPath(step.id)); must(same(normalized(beforeRest), normalized(rests.get(step.id))));
      const line = lineOf(beforeRest, step.id);
      must(line.applied_revision === '0' && number(line.expected_quantity) - number(line.effective_credit) - number(line.applied_retained_quantity) >= 1n);
      const actionName = step.action === 'propose' ? 'Proponer restitución' : step.action === 'accept' ? 'Aceptar restitución' : 'Rechazar restitución';
      await click(button(group, actionName), actionName); const dialog = page.getByRole('dialog');
      if (step.action === 'propose') {
        await dialog.getByRole('textbox', { name: /Cantidad retenida en origen/ }).fill('1');
        await dialog.getByRole('textbox', { name: /Motivo de restitución/ }).fill(reason);
        await emit({ type: 'simulated_attestation', reason, quantity: '1', origin: step.origin, realPhysicalVerification: false });
        await dialog.getByRole('checkbox', { name: 'Confirmo que estas unidades permanecen físicamente en origen', exact: true }).check();
      } else await dialog.getByRole('textbox', { name: step.action === 'accept' ? 'Motivo de aceptación (obligatorio)' : 'Motivo de rechazo (obligatorio)', exact: true }).fill(reason);
      await click(button(dialog, 'Revisar restitución'), 'Revisar restitución');
      const before = await stocks(); await emit({ type: 'stock_stability', observed: before, pass: same(before, lastStocks) }); must(same(before, lastStocks));
      await immutable(); await identity(step.actor);
      const expectedStocks = structuredClone(before);
      if (step.action === 'accept') { expectedStocks[`${step.origin}/1`].existing += 1n; expectedStocks[`${step.origin}/1`].available += 1n; }
      await emit({ type: 'mutation_attempt', actor: step.actor, path: `${restPath(step.id)}/${step.action}`, reason, beforeRest, beforeStocks: before, expectedStocks, expectedRevision: line.workflow_revision, expectedAfterRevision: step.revision });
      uncertain = true; const apiPath = `${restPath(step.id)}/${step.action}`;
      const waiting = page.waitForResponse(r => r.url() === baseURL + apiPath && r.request().method() === 'POST', { timeout: 20000 }).catch(() => null);
      let clicked = true; try { await button(dialog, step.action === 'propose' ? 'Enviar propuesta' : step.action === 'accept' ? 'Confirmar aceptación' : 'Confirmar rechazo').click(); } catch { clicked = false; }
      const response = await waiting; await emit({ type: 'mutation_response', status: response?.status() ?? null, clickCompleted: clicked }); must(response?.status() === 200);
      const operation = checkedDTO(JSON.parse(await response.text())); await emit({ type: 'operation', operation });
      const expectedRest = expectation(beforeRest, operation, step, reason, before), observedRest = await get(step.actor, restPath(step.id));
      const pass = same(normalized(expectedRest), normalized(observedRest)); await emit({ type: 'restitution_comparison', expected: expectedRest, observed: observedRest, pass }); must(pass && clicked);
      rests.set(step.id, observedRest); await immutable();
      const other = step.id === '10' ? '14' : '10'; must(same(normalized(await get(2, restPath(other))), normalized(rests.get(other))));
      const after = await stocks(), stockPass = same(after, expectedStocks);
      await emit({ type: 'stock_comparison', before, expected: expectedStocks, observed: after, pass: stockPass }); must(stockPass);
      lastStocks = after; uncertain = false; await page.getByRole('dialog').waitFor({ state: 'detached' });
      completed.push({ phase, id: step.id, operation_key: operation.operation_key, revision: operation.revision }); await emit({ type: 'step_completed', completedCount: completed.length, restitution: observedRest });
    }
    phase = 'partial-application-closed'; currentId = '14';
    const finalLine = lineOf(rests.get('14'), '14');
    must(finalLine.applied_revision === '1' && finalLine.applied_retained_quantity === '1' && number(finalLine.expected_quantity) - number(finalLine.effective_credit) - number(finalLine.applied_retained_quantity) === 1n);
    for (const location of [2, 1]) {
      const { group } = await openPane(location, '14'); await group.getByText('Restitución cerrada', { exact: true }).waitFor();
      must((await group.locator(':scope > tr:first-child > td').nth(3).innerText()).trim() === '1');
      const names = location === 2 ? ['Proponer restitución'] : ['Aceptar restitución', 'Rechazar restitución'];
      for (const name of names) must(await button(group, name).isDisabled());
      for (const name of location === 2 ? ['Aceptar restitución', 'Rechazar restitución'] : ['Proponer restitución']) must(await button(group, name).count() === 0);
      await emit({ type: 'closed_UI', actor: location, mathematicalRemaining: '1', disabled: names, backendWriteDenialTested: false });
    }
    await immutable(); for (const id of ['10', '14']) must(same(normalized(await get(2, restPath(id))), normalized(rests.get(id))));
    const finalStocks = await stocks(); must(same(finalStocks, lastStocks));
    result = { ...result, status: 'restitution_pass', completed, newTransfers: 0, closedPartialApplication: true, auditViewsExecuted: false };
    await emit({ type: 'result', ...result });
  } catch {
    result = { ...result, status: 'stopped', phase, id: currentId, uncertain, completed, newTransfers: 0, code: 'unexpected_or_existing_journal_no_retry' };
    if (file) { await emit({ type: 'stopped', ...result });
      if (uncertain && currentId && rests.has(currentId)) try { await emit({ type: 'reconciliation_GET_only', restitution: await get(2, restPath(currentId)) }); } catch { await emit({ type: 'reconciliation_unavailable' }); }
    }
  } finally {
    for (const [location, page] of actors) {
      if (uncertain) { await emit({ type: 'logout_skipped_uncertain', location }); result.cleanupIncomplete = true; continue; }
      try { await click(button(page, 'Cerrar sesión'), 'Cerrar sesión'); await page.getByLabel('Usuario', { exact: true }).waitFor(); await emit({ type: 'logout', location, pass: true }); }
      catch { if (file) await emit({ type: 'logout', location, pass: false }); if (result) result.cleanupIncomplete = true; }
    }
    for (const context of contexts) try { await context.close(); } catch { if (result) result.cleanupIncomplete = true; }
    if (file) { await emit({ type: 'final_summary', ...result }); await file.close(); }
  }
  return result;
}
