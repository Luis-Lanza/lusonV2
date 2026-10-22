// Preparation only: importing this module performs no network or browser operations.
// Parent supplies a trusted browser and in-memory accounts; never enable tracing,
// HAR/video recording, Playwright debug logging, or external request-body logging.
// API: run({ browser, accounts: [{ locationId: 1|2|3, username, password }],
//            baseURL: 'https://localhost:4323', outputDir, stage = 'preflight' })
// Only preflight is implemented. It creates zero transfer records. Contexts close
// without logging out (no account changes). Parent retains ownership of browser.
import { createRequire } from 'node:module';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../../../apps/web/package.json', import.meta.url));
const { parse, LosslessNumber } = require('lossless-json');
const root = path.dirname(fileURLToPath(import.meta.url));
const check = (condition) => { if (!condition) throw new Error('preflight_validation_failed'); };
const integer = (value, maximum = 9223372036854775807n) => {
  check(value instanceof LosslessNumber && /^(0|[1-9]\d*)$/.test(value.toString()));
  const result = BigInt(value.toString());
  check(result <= maximum);
  return result;
};
const id = value => Number(integer(value, 190n));

export async function run({ browser, accounts, baseURL, outputDir, stage = 'preflight' }) {
  // Refuse unsupported stages BEFORE login or any other network operation.
  if (stage !== 'preflight') throw new Error('stage_not_implemented_no_operations_performed');
  const url = new URL(baseURL);
  check(url.origin === 'https://localhost:4323' && url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password);
  const output = path.resolve(outputDir);
  check(output === root || output.startsWith(root + path.sep));
  check(Array.isArray(accounts) && accounts.length === 3);
  check([1, 2, 3].every(location => accounts.filter(a => a.locationId === location).length === 1));
  check(accounts.every(a => typeof a.username === 'string' && a.username.length > 0 && typeof a.password === 'string' && a.password.length > 0));
  await mkdir(output, { recursive: true });
  const marker = `Aceptación QA ${randomUUID()}`;
  const evidencePath = path.join(output, `preflight-${marker.slice(14)}.jsonl`);
  // Exclusive creation prevents overwriting any prior run or parent evidence.
  const file = await open(evidencePath, 'wx', 0o600);
  const contexts = [];
  let step = 'plan';
  const emit = async value => { await file.write(JSON.stringify(value) + '\n'); await file.sync(); };
  const get = async (page, apiPath) => {
    // Use Chromium's established TLS trust, NOT the separate Node request client.
    const response = await page.evaluate(async apiPath => {
      const reply = await fetch(apiPath, { method: 'GET', credentials: 'same-origin',
        cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000) });
      const type = reply.headers.get('content-type') ?? '';
      let body = '';
      if (reply.status === 200 && /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(type)) {
        if (apiPath === '/api/auth/validate') {
          const session = await reply.json();
          // CSRF and cookies never cross into runner objects or evidence.
          body = JSON.stringify({ authenticated: session.authenticated,
            identity: { location: { id: session.identity?.location?.id }, username: session.identity?.username } });
        } else body = await reply.text();
      }
      return { status: reply.status, type, body };
    }, apiPath);
    await emit({ type: 'get', step, path: apiPath, status: response.status });
    check(response.status === 200);
    check(/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.type));
    return parse(response.body);
  };
  try {
    await emit({ type: 'plan', marker, stage, businessWrites: 0,
      revision: { expectedFromParent: 'cf2e162968fff8e7ed0e230a7a9c3e223aa25787', independentlyVerified: false },
      plannedMatrix: [
        { route: 'A requests warehouse', cases: ['happy', 'reject_pending', 'cancel_pending', 'cancel_approved'] },
        { route: 'A requests B', cases: ['happy', 'reject_pending', 'cancel_pending', 'cancel_approved'] },
        { route: 'A sends warehouse', cases: ['happy', 'reject_pending', 'cancel_pending', 'cancel_approved'] },
        { route: 'warehouse sends A', cases: ['happy', 'cancel_approved'] },
        { route: 'warehouse sends B', cases: ['happy', 'cancel_approved'] },
      ], limits: { newRecords: 20, quantityPerProductPerRecord: 3 },
      notImplemented: ['lifecycles', 'gestions', 'navigation', 'mobile', 'history', 'uncertain recovery'],
      notes: ['This phase authenticates and reads only; matrix is a plan, not coverage.',
        'Inventory pages are sequential observations, not an atomic snapshot.',
        'Creation has no reason input; no record-marker strategy is implemented.'] });
    const actors = [];
    // Authenticate ALL three physical roles before collecting stock or selecting candidates.
    for (const location of [1, 2, 3]) {
      step = `authenticate-${location}`;
      const account = accounts.find(a => a.locationId === location);
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: false });
      contexts.push(context);
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      page.setDefaultNavigationTimeout(15000);
      await page.goto(url.origin, { waitUntil: 'domcontentloaded' });
      // Flush before the one GUI login attempt. Do not log locator errors: fill
      // errors can contain input values. No response/request listeners or traces.
      await emit({ type: 'attempt', step, location, action: 'GUI login', attempts: 1 });
      await page.getByLabel('Usuario', { exact: true }).fill(account.username);
      await page.getByLabel('Contraseña', { exact: true }).fill(account.password);
      await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
      await page.getByRole('button', { name: 'Cerrar sesión', exact: true }).waitFor();
      const session = await get(page, '/api/auth/validate');
      check(session.authenticated === true && id(session.identity.location.id) === location);
      check(session.identity.username === account.username);
      // Persist only physical location, never session object/account identifiers.
      await emit({ type: 'authenticated', location, usernameMatchesInput: true });
      actors.push({ location, page });
    }
    const inventories = [];
    for (const { location, page: browserPage } of actors) {
      step = `inventory-${location}`;
      const items = [];
      let total;
      for (let page = 1; page <= 4; page++) {
        const data = await get(browserPage, `/api/inventory?location_id=${location}&page=${page}&page_size=50`);
        check(id(data.location.id) === location && id(data.page) === page && id(data.page_size) === 50);
        const nextTotal = Number(integer(data.total_variants, 190n));
        check(total === undefined || total === nextTotal);
        total = nextTotal;
        check(Array.isArray(data.items) && data.items.length === Math.min(50, Math.max(0, total - (page - 1) * 50)));
        for (const row of data.items) {
          const variant = id(row.variant_id);
          const existing = integer(row.existing), reserved = integer(row.reserved), available = integer(row.available);
          check(variant > 0 && (!items.length || variant > items.at(-1).variant_id));
          check(existing >= reserved && available === existing - reserved);
          // Explicit numeric allowlist; no raw DTOs or arbitrary strings in evidence.
          items.push({ variant_id: variant, existing: String(existing), reserved: String(reserved), available: String(available) });
        }
        if (items.length === total) break;
      }
      check(items.length === total);
      inventories.push({ location, items });
      await emit({ type: 'inventory', location, items });
    }
    const candidates = inventories.map(({ location, items }) => ({ location,
      // Availability is not proof of fictional trial stock; parent must identify it.
      availabilityCandidatesOnly: items.filter(item => BigInt(item.available) >= 3n).slice(0, 2).map(item => item.variant_id),
      selectedForMutation: [] }));
    await emit({ type: 'result', status: 'preflight_pass', businessWrites: 0, createdIds: [], candidates,
      coverage: { S1: 'NOT PROVED', S2: 'NOT PROVED', S3: 'NOT PROVED', S4: 'authentication only' } });
    return { status: 'preflight_pass', evidencePath, businessWrites: 0, createdIds: [] };
  } catch {
    // Do not rethrow Playwright errors, server bodies or account-bearing objects.
    await emit({ type: 'result', status: 'stopped', step, code: 'unexpected_outcome_no_retry', businessWrites: 0, createdIds: [] });
    return { status: 'stopped', step, evidencePath, businessWrites: 0, createdIds: [] };
  } finally {
    for (const context of contexts) { try { await context.close(); } catch { /* Never expose browser diagnostics. */ } }
    await file.close();
  }
}
