// COUNT-FIRST preparation unit. Parent invokes once with trusted/pinned Chromium
// and in-memory accounts [{locationId:1|2|3, username, password}]. No invocation on
// import, credentials-file/env reads, raw exceptions, traces, or direct API writes.
// Restitution, mobile/navigation, and third-role privacy remain a separate unit.
import { createRequire } from 'node:module';
import { mkdir, open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const require = createRequire(new URL('../../../apps/web/package.json', import.meta.url));
const { parse } = require('lossless-json');
const root = path.dirname(fileURLToPath(import.meta.url));
const must = value => { if (!value) throw new Error('gestions_check_failed'); };
const number = value => { const s = String(value); must(/^(0|[1-9]\d*)$/.test(s)); const n = BigInt(s); must(n <= 9223372036854775807n); return n; };
const serial = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? String(v) : v);
const canonical = value => typeof value === 'bigint' ? String(value) : Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
const same = (a, b) => serial(canonical(a)) === serial(canonical(b));
const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const plan = [
  { phase: 'count-propose-2', actor: 2, action: 'propose', actual: '2', revision: '1', states: ['pending'], effective: '1' },
  { phase: 'count-accept-2', actor: 3, action: 'accept', actual: null, revision: '1', states: ['applied'], effective: '2' },
  { phase: 'count-propose-1', actor: 2, action: 'propose', actual: '1', revision: '2', states: ['applied', 'pending'], effective: '2' },
  { phase: 'count-replace-3', actor: 2, action: 'propose', actual: '3', revision: '3', states: ['applied', 'superseded', 'pending'], effective: '2' },
  { phase: 'count-reject-3', actor: 3, action: 'reject', actual: null, revision: '3', states: ['applied', 'superseded', 'rejected'], effective: '2' },
];
// Business DTO allowlist only. Session endpoints never use this decoder.
const keys = new Set(('id reference kind status created_at decided_at dispatched_at received_at items variant_id brand model capacity_ah polarity quantity ' +
  'creator_location_id creator_location_name origin_location_id origin_location_name destination_location_id destination_location_name approver_location_id approver_location_name ' +
  'decision_location_id dispatch_location_id receipt_location_id receipt exceptions expected_quantity actual_quantity available_quantity ' +
  'request_id lines operations operation_key actor_location_id action expected_revision reason revision recorded_at initiator_location_id base_revision base_credit state decision application accepted effective_credit delta workflow_revision applied_revision effective_actual proposals').split(' '));
const checkedDTO = (value, marker) => {
  if (Array.isArray(value)) return value.map(v => checkedDTO(v, marker));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => {
    must(keys.has(k)); if (k === 'reason') must(typeof v === 'string' && v.startsWith(marker + ' — '));
    return [k, checkedDTO(v, marker)];
  }));
  must(value === null || ['string', 'boolean'].includes(typeof value) || (typeof value === 'number' && Number.isSafeInteger(value)));
  return value;
};
const normalizeCounts = d => ({ ...d, operations: [...d.operations].sort((a, b) => a.operation_key.localeCompare(b.operation_key)),
  lines: d.lines.map(l => ({ ...l, proposals: [...l.proposals].sort((a, b) => number(a.revision) < number(b.revision) ? -1 : 1) })) });

export async function gestions({ browser, accounts, baseURL, outputDir }) {
  let file, phase = 'setup', uncertain = false, result, lastStocks, currentCounts;
  const actors = new Map(), contexts = [], completed = [], originals = new Map();
  const marker = `Aceptación QA — escenario simulado local ${randomUUID()}`;
  const journal = path.join(root, 'gestions-journal.jsonl');
  const emit = async entry => { await file.write(serial({ time: new Date().toISOString(), phase, reference: 'TR-010', ...entry }) + '\n'); await file.sync(); };
  const click = async (control, action) => { await emit({ type: 'ui_click', action }); await control.click(); };
  const identity = async location => {
    const valid = await actors.get(location).evaluate(async ({ location, username }) => {
      const r = await fetch('/api/auth/validate', { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000) });
      if (r.status !== 200) return false;
      const s = await r.json(); return s.authenticated === true && s.identity?.location?.id === location && s.identity?.username === username;
    }, { location, username: accounts.find(a => a.locationId === location).username });
    must(valid); // No raw session leaves browser memory.
  };
  const get = async (location, apiPath, inventory = false) => {
    const r = await actors.get(location).evaluate(async apiPath => {
      const response = await fetch(apiPath, { method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000) });
      return { status: response.status, body: response.status === 200 ? await response.text() : '' };
    }, apiPath);
    await emit({ type: 'GET', actor: location, path: apiPath, status: r.status }); must(r.status === 200);
    return inventory ? parse(r.body) : checkedDTO(JSON.parse(r.body), marker);
  };
  const stocks = async () => {
    const snapshot = {};
    for (const location of [1, 2, 3]) {
      await identity(location); let total, count = 0, last = 0n;
      for (let page = 1; page <= 4; page++) {
        const d = await get(location, `/api/inventory?location_id=${location}&page=${page}&page_size=50`, true);
        must(number(d.location.id) === BigInt(location) && number(d.page) === BigInt(page) && number(d.page_size) === 50n);
        const size = number(d.total_variants); must(size === 190n && (total === undefined || total === size)); total = size;
        must(Array.isArray(d.items) && BigInt(d.items.length) === (size - BigInt(count) > 50n ? 50n : size - BigInt(count)));
        for (const row of d.items) {
          const id = number(row.variant_id), existing = number(row.existing), reserved = number(row.reserved), available = number(row.available);
          must(id > last && id <= 190n && existing >= reserved && available === existing - reserved); last = id;
          snapshot[`${location}/${id}`] = { existing, reserved, available }; count++;
        }
        if (BigInt(count) === total) break;
      }
      must(BigInt(count) === total);
    }
    must(Object.keys(snapshot).length === 570); return snapshot;
  };
  const countLine = d => {
    must(d.request_id === '10' && d.lines.length === 1 && d.lines[0].variant_id === 1 && Array.isArray(d.operations));
    const l = d.lines[0]; must(l.expected_quantity === '3' && l.actual_quantity === '1' && l.available_quantity === '1'); return l;
  };
  const countPath = '/api/transfers/10/count-corrections';
  const readCounts = location => get(location, countPath);
  let otherCounts;
  const immutable = async () => {
    for (const id of ['10', '14']) {
      const now = await get(2, `/api/transfers/${id}`), pass = same(now, originals.get(id));
      await emit({ type: 'immutable_transfer', id, pass }); must(pass);
    }
    const now = await get(2, '/api/transfers/14/count-corrections');
    const pass = same(now, otherCounts); await emit({ type: 'other_count_history_unchanged', id: '14', pass }); must(pass);
  };
  const expectation = (before, op, step, reason) => {
    const l = countLine(before), expectedRevision = l.workflow_revision;
    must(op.request_id === '10' && op.variant_id === 1 && op.actor_location_id === step.actor && op.action === step.action);
    must(op.expected_revision === expectedRevision && op.revision === step.revision && op.reason === reason && op.actual_quantity === step.actual);
    must(/^[A-Za-z0-9_-]{16,128}$/.test(op.operation_key) && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(op.recorded_at));
    must(!before.operations.some(prior => prior.operation_key === op.operation_key));
    const expected = structuredClone(before), line = expected.lines[0]; expected.operations.push(op);
    if (step.action === 'propose') {
      must(number(op.revision) === number(expectedRevision) + 1n);
      for (const p of line.proposals) if (p.state === 'pending') { must(p.initiator_location_id === step.actor); p.state = 'superseded'; }
      line.workflow_revision = op.revision;
      line.proposals.push({ revision: op.revision, operation_key: op.operation_key, initiator_location_id: step.actor,
        actual_quantity: step.actual, base_revision: line.applied_revision, base_credit: line.effective_credit,
        reason, recorded_at: op.recorded_at, state: 'pending', decision: null, application: null });
    } else {
      const proposal = line.proposals.find(p => p.revision === expectedRevision);
      must(proposal?.state === 'pending' && proposal.initiator_location_id !== step.actor);
      const accepted = step.action === 'accept'; proposal.state = accepted ? 'applied' : 'rejected';
      proposal.decision = { operation_key: op.operation_key, actor_location_id: step.actor, accepted, reason, recorded_at: op.recorded_at };
      if (accepted) {
        const actual = number(proposal.actual_quantity), sent = number(line.expected_quantity), credit = actual < sent ? actual : sent;
        proposal.application = { effective_credit: String(credit), delta: String(credit - number(line.effective_credit)), recorded_at: op.recorded_at };
        line.applied_revision = proposal.revision; line.effective_actual = proposal.actual_quantity; line.effective_credit = String(credit);
      }
    }
    return expected;
  };
  try {
    must(baseURL === 'https://localhost:4323');
    must(Array.isArray(accounts) && accounts.length === 3 && [1, 2, 3].every(id => accounts.filter(a => a.locationId === id && typeof a.username === 'string' && typeof a.password === 'string').length === 1));
    const output = path.resolve(outputDir); must(output === root || output.startsWith(root + path.sep)); await mkdir(output, { recursive: true });
    file = await open(journal, 'wx', 0o600); // No override, rerun, or automatic resume.
    result = { status: 'stopped', journal, newTransfers: 0 };
    await emit({ type: 'plan', marker, steps: plan, allowedRecordIds: ['10', '14'], mutatedRecordIds: ['10'], newTransfers: 0, existingQATransfers: 16,
      deferred: ['restitution reject on TR-010', 'partial restitution accept on TR-014', 'mobile/navigation', 'third-role privacy'], uncertainRecovery: 'NOT PROVED' });
    for (const location of [1, 2, 3]) {
      phase = `login-${location}`;
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: false }); contexts.push(context);
      const page = await context.newPage(); actors.set(location, page); page.setDefaultTimeout(15000); page.setDefaultNavigationTimeout(15000);
      await page.goto(baseURL, { waitUntil: 'domcontentloaded' }); const account = accounts.find(a => a.locationId === location);
      await page.getByLabel('Usuario', { exact: true }).fill(account.username); await page.getByLabel('Contraseña', { exact: true }).fill(account.password);
      await click(button(page, 'Iniciar sesión'), 'Iniciar sesión'); await button(page, 'Cerrar sesión').waitFor(); await identity(location);
    }
    phase = 'baseline';
    for (const [id, origin, destination, kind] of [['10', 3, 2, 'request_stock'], ['14', 2, 1, 'send_to_warehouse']]) {
      const d = await get(2, `/api/transfers/${id}`);
      must(d.id === id && d.reference === `TR-${id.padStart(3, '0')}` && d.kind === kind && d.status === 'received' && d.creator_location_id === 2 && d.origin_location_id === origin && d.destination_location_id === destination);
      must(d.items.length === 1 && d.items[0].variant_id === 1 && d.items[0].quantity === '3');
      must(same(d.receipt, { items: [{ variant_id: 1, expected_quantity: '3', actual_quantity: '1', available_quantity: '1' }], exceptions: [{ variant_id: 1, kind: 'shortage', quantity: '2' }] }));
      originals.set(id, d); await emit({ type: 'original_transfer', record: d });
    }
    currentCounts = await readCounts(2); const initial = countLine(currentCounts);
    must(initial.workflow_revision === '0' && initial.applied_revision === '0' && initial.effective_actual === '1' && initial.effective_credit === '1' && initial.proposals.length === 0 && currentCounts.operations.length === 0);
    otherCounts = await get(2, '/api/transfers/14/count-corrections');
    lastStocks = await stocks(); await emit({ type: 'baseline', counts: currentCounts, otherCounts, stocks: lastStocks });
    const item = originals.get('10').items[0], groupName = `${item.brand} · ${item.model} · ${item.capacity_ah} Ah · ${item.polarity}`;
    for (const step of plan) {
      phase = step.phase; const page = actors.get(step.actor), reason = `${marker} — ${phase}; conteo ficticio de prueba, sin verificación física real`;
      await identity(step.actor); await page.goto(`${baseURL}/#/transferencias/10`, { waitUntil: 'domcontentloaded' });
      await click(button(page, 'Gestiones'), 'Gestiones');
      await click(page.getByRole('menuitem', { name: 'Corregir conteo', exact: true }), 'Corregir conteo');
      const group = page.getByRole('table', { name: 'Gestión de conteo', exact: true }).getByRole('rowgroup', { name: groupName, exact: true });
      const beforeCounts = await readCounts(step.actor); must(same(normalizeCounts(beforeCounts), normalizeCounts(currentCounts)));
      if (step.action === 'propose') {
        const replacing = countLine(beforeCounts).proposals.some(p => p.state === 'pending');
        await click(button(group, replacing ? 'Reemplazar propuesta' : 'Proponer corrección'), replacing ? 'Reemplazar propuesta' : 'Proponer corrección');
        await page.getByRole('dialog').getByLabel('Cantidad corregida', { exact: true }).fill(step.actual);
        await page.getByRole('dialog').getByLabel('Motivo', { exact: true }).fill(reason);
        await click(button(page.getByRole('dialog'), 'Revisar corrección'), 'Revisar corrección');
      } else {
        await click(button(group, 'Consultar propuesta'), 'Consultar propuesta');
        await click(button(page.getByRole('dialog'), step.action === 'accept' ? 'Aceptar propuesta' : 'Rechazar propuesta'), 'Elegir decisión');
        const noun = step.action === 'accept' ? 'aceptación' : 'rechazo';
        await page.getByRole('dialog').getByLabel(`Motivo de ${noun} (obligatorio)`, { exact: true }).fill(reason);
        await click(button(page.getByRole('dialog'), `Revisar ${noun}`), `Revisar ${noun}`);
      }
      const before = await stocks(); await emit({ type: 'stock_stability', pass: same(before, lastStocks), observed: before }); must(same(before, lastStocks));
      await immutable(); await identity(step.actor);
      const expectedStocks = structuredClone(before);
      if (step.action === 'accept') { expectedStocks['2/1'].existing += 1n; expectedStocks['2/1'].available += 1n; }
      const apiPath = `${countPath}/${step.action}`;
      await emit({ type: 'mutation_attempt', actor: step.actor, action: step.action, reason, beforeCounts, beforeStocks: before, expectedStocks, expectedRevision: countLine(beforeCounts).workflow_revision, expectedAfter: step });
      uncertain = true;
      const responsePromise = page.waitForResponse(r => r.url() === baseURL + apiPath && r.request().method() === 'POST', { timeout: 20000 }).catch(() => null);
      let clicked = true;
      try { await button(page.getByRole('dialog'), step.action === 'propose' ? 'Enviar propuesta' : step.action === 'accept' ? 'Confirmar aceptación' : 'Confirmar rechazo').click(); } catch { clicked = false; }
      const response = await responsePromise; await emit({ type: 'mutation_response', status: response?.status() ?? null, clickCompleted: clicked }); must(response?.status() === 200);
      const operation = checkedDTO(JSON.parse(await response.text()), marker); await emit({ type: 'operation', operation });
      const expectedCounts = expectation(beforeCounts, operation, step, reason), observedCounts = await readCounts(step.actor);
      const countsPass = same(normalizeCounts(observedCounts), normalizeCounts(expectedCounts));
      await emit({ type: 'count_comparison', expected: expectedCounts, observed: observedCounts, pass: countsPass }); must(countsPass && clicked);
      const line = countLine(observedCounts);
      must(line.workflow_revision === step.revision && line.effective_actual === step.effective && line.effective_credit === step.effective);
      must(line.applied_revision === (completed.length === 0 ? '0' : '1'));
      must(same(normalizeCounts(observedCounts).lines[0].proposals.map(p => p.state), step.states));
      await immutable(); const after = await stocks(), pass = same(after, expectedStocks);
      await emit({ type: 'stock_comparison', before, expected: expectedStocks, observed: after, pass }); must(pass);
      currentCounts = observedCounts; lastStocks = after; uncertain = false;
      await page.getByRole('dialog').waitFor({ state: 'detached' });
      completed.push({ phase, operation_key: operation.operation_key, revision: operation.revision, action: step.action });
      await emit({ type: 'step_completed', completedCount: completed.length, counts: currentCounts });
    }
    result = { ...result, status: 'count_phase_pass', completed, mutatedRecordIds: ['10'], restPrepared: false, navigationPrepared: false };
    await emit({ type: 'result', ...result });
  } catch {
    result = { ...result, status: 'stopped', phase, uncertain, completed, newTransfers: 0, code: 'unexpected_or_existing_journal_no_retry' };
    if (file) {
      await emit({ type: 'stopped', ...result });
      if (uncertain && currentCounts && actors.has(2)) try { await emit({ type: 'reconciliation_GET_only', counts: await readCounts(2) }); } catch { await emit({ type: 'reconciliation_unavailable' }); }
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
