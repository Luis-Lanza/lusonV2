// Parent invokes once AFTER restitution_pass. Business read-only; GUI auth only.
// No interception/mocking, credential-file/env reads, login screenshots, tracing,
// raw exception/request-body/header/session logging. Parent owns TLS trust/browser.
import { mkdir, open, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
import { checkedDTO, same } from './restitution.mjs';
const require = createRequire(new URL('../../../apps/web/package.json', import.meta.url));
const { parse } = require('lossless-json');
const root = path.dirname(fileURLToPath(import.meta.url));
const must = v => { if (!v) throw new Error('audit_check_failed'); };
const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const number = value => { const s = String(value); must(/^(0|[1-9]\d*)$/.test(s)); return BigInt(s); };
const pairs = [{ id: '10', actor: 2 }, { id: '10', actor: 3 }, { id: '14', actor: 2 }, { id: '14', actor: 1 }];

export async function auditViews({ browser, accounts, baseURL, outputDir }) {
  let file, phase = 'setup', result, baseline, initialStocks, output;
  const actors = new Map(), contexts = [], unexpected = [], completed = [], screenshots = [], unexpectedByRequest = new WeakMap();
  const journal = path.join(root, 'audit-journal.jsonl');
  const emit = async value => { await file.write(JSON.stringify({ time: new Date().toISOString(), phase, ...value }) + '\n'); await file.sync(); };
  const clean = async () => { if (unexpected.length) { await emit({ type: 'unexpected_business_write', requests: unexpected }); throw new Error('unexpected_business_write'); } };
  const click = async (control, action) => { await clean(); await emit({ type: 'ui_click', action }); await control.click(); await clean(); };
  const identity = async actor => {
    const valid = await actors.get(actor).evaluate(async ({ actor, username }) => {
      const r = await fetch('/api/auth/validate', { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000) });
      if (r.status !== 200) return false;
      const s = await r.json(); return s.authenticated === true && s.identity?.location?.id === actor && s.identity?.account_id === actor && s.identity?.username === username;
    }, { actor, username: accounts.find(a => a.locationId === actor).username }); must(valid);
  };
  const get = async (actor, apiPath, inventory = false) => {
    await clean();
    const r = await actors.get(actor).evaluate(async apiPath => {
      const response = await fetch(apiPath, { method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000) });
      return { status: response.status, body: response.status === 200 ? await response.text() : '' };
    }, apiPath);
    await emit({ type: 'GET', actor, path: apiPath, status: r.status }); must(r.status === 200);
    return inventory ? parse(r.body) : checkedDTO(JSON.parse(r.body));
  };
  const snapshot = async () => {
    await identity(2); const values = {};
    for (const id of ['10', '14']) for (const suffix of ['', '/count-corrections', '/restitutions']) values[id + suffix] = await get(2, `/api/transfers/${id}${suffix}`);
    return values;
  };
  const unchanged = async () => { const after = await snapshot(), pass = same(after, baseline); await emit({ type: 'immutable_history', pass }); must(pass); };
  const stocks = async () => {
    const out = {};
    for (const actor of [1, 2, 3]) {
      await identity(actor); let count = 0, last = 0n;
      for (let page = 1; page <= 4; page++) {
        const d = await get(actor, `/api/inventory?location_id=${actor}&page=${page}&page_size=50`, true);
        must(number(d.location.id) === BigInt(actor) && number(d.page) === BigInt(page) && number(d.page_size) === 50n && number(d.total_variants) === 190n);
        must(d.items.length === Math.min(50, 190 - count));
        for (const i of d.items) {
          const id = number(i.variant_id), existing = number(i.existing), reserved = number(i.reserved), available = number(i.available);
          must(id > last && id <= 190n && reserved <= existing && available === existing - reserved); last = id; count++;
          out[`${actor}/${id}`] = { existing: String(existing), reserved: String(reserved), available: String(available) };
        }
      }
      must(count === 190);
    }
    return out;
  };
  const usable = async (control, label) => {
    await control.scrollIntoViewIfNeeded();
    const geometry = await control.evaluate(el => {
      const r = el.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2, hit = document.elementFromPoint(x, y);
      return { x: r.x, y: r.y, width: r.width, height: r.height,
        inViewport: r.left >= 0 && r.right <= innerWidth && y >= 0 && y < innerHeight,
        unobscured: !!hit && (el === hit || el.contains(hit)) };
    });
    await emit({ type: 'control_geometry', label, ...geometry }); must(geometry.inViewport && geometry.unobscured);
  };
  const screenshot = async (actor, id, pane) => {
    await clean(); await identity(actor); const page = actors.get(actor);
    await page.getByRole('heading', { level: 1, name: `TR-${id.padStart(3, '0')}`, exact: true }).waitFor();
    must(await page.getByLabel('Contraseña', { exact: true }).count() === 0);
    const overflow = await page.evaluate(() => ({ width: innerWidth, documentWidth: document.documentElement.scrollWidth }));
    const name = `audit-${id}-actor-${actor}-${pane}-390.png`;
    // Capture the authenticated failure geometry too, never a login page.
    const image = await open(path.join(output, name), 'wx', 0o600);
    try { await image.writeFile(await page.screenshot({ fullPage: true })); await image.sync(); } finally { await image.close(); }
    screenshots.push(name);
    await emit({ type: 'screenshot', name, actor, id, ...overflow }); must(overflow.documentWidth <= overflow.width);
  };
  try {
    must(baseURL === 'https://localhost:4323');
    must(Array.isArray(accounts) && accounts.length === 3 && [1, 2, 3].every(id => accounts.filter(a => a.locationId === id && typeof a.username === 'string' && typeof a.password === 'string').length === 1));
    output = path.resolve(outputDir); must(output === root || output.startsWith(root + path.sep)); await mkdir(output, { recursive: true });
    file = await open(journal, 'wx', 0o600); result = { status: 'stopped', journal, businessWrites: 0 };
    const prior = (await readFile(new URL('./restitution-journal.jsonl', import.meta.url), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    must(prior.at(-1).status === 'restitution_pass');
    await emit({ type: 'plan', pairs, mobileWidth: 390, normalGuiDenials: [{ actor: 1, id: '10' }, { actor: 3, id: '14' }],
      backendWriteDenialTested: false, forcedFailures: false, uncertainRecovery: 'NOT PROVED' });
    for (const actor of [1, 2, 3]) {
      phase = `login-${actor}`;
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: false }); contexts.push(context);
      const page = await context.newPage(); actors.set(actor, page); page.setDefaultTimeout(15000); page.setDefaultNavigationTimeout(15000);
      // Observe only, never intercept or synthesize a request/response. No body/header reads.
      page.on('request', req => {
        const url = new URL(req.url()), method = req.method();
        if (url.origin === baseURL && url.pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(method)
          && !['/api/auth/login', '/api/auth/logout'].includes(url.pathname)) {
          const entry = { actor, method, path: /^\/api\/transfers(?:\/\d+)?(?:\/[a-z-]+)*$/.test(url.pathname) ? url.pathname : 'other-api-path', status: null };
          unexpected.push(entry); unexpectedByRequest.set(req, entry);
        }
      });
      page.on('response', response => { const entry = unexpectedByRequest.get(response.request()); if (entry) entry.status = response.status(); });
      await page.goto(baseURL, { waitUntil: 'domcontentloaded' }); const account = accounts.find(a => a.locationId === actor);
      await page.getByLabel('Usuario', { exact: true }).fill(account.username); await page.getByLabel('Contraseña', { exact: true }).fill(account.password);
      await click(button(page, 'Iniciar sesión'), 'Iniciar sesión'); await button(page, 'Cerrar sesión').waitFor(); await identity(actor);
    }
    phase = 'baseline'; baseline = await snapshot(); initialStocks = await stocks();
    must(baseline['10'].status === 'received' && baseline['14'].status === 'received');
    must(baseline['10/count-corrections'].lines[0].effective_credit === '2' && baseline['14/restitutions'].lines[0].applied_retained_quantity === '1');
    await emit({ type: 'baseline', history: baseline, stocks: initialStocks });
    for (const { actor, id } of pairs) {
      phase = `navigation-${id}-${actor}`; const page = actors.get(actor), ref = `TR-${id.padStart(3, '0')}`;
      await identity(actor); await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`${baseURL}/#/transferencias/${id}`, { waitUntil: 'domcontentloaded' });
      const heading = page.getByRole('heading', { level: 1, name: ref, exact: true }); await heading.waitFor();
      await page.reload({ waitUntil: 'domcontentloaded' }); await heading.waitFor();
      await emit({ type: 'reload_retains_reference', actor, id, pass: true });
      await click(page.getByRole('navigation', { name: 'Navegación de transferencia', exact: true }).getByRole('button', { name: /^Volver a / }), 'Volver a listado');
      await page.waitForURL(`${baseURL}/#/transferencias`); await page.getByRole('combobox', { name: 'Estado de transferencia', exact: true }).waitFor();
      await page.goBack(); await page.waitForURL(`${baseURL}/#/transferencias/${id}`); await heading.waitFor();
      await page.goForward(); await page.waitForURL(`${baseURL}/#/transferencias`); await page.getByRole('combobox', { name: 'Estado de transferencia', exact: true }).waitFor();
      await page.goBack(); await heading.waitFor(); await emit({ type: 'back_forward', actor, id, pass: true });
      await unchanged(); await page.setViewportSize({ width: 390, height: 900 });
      for (const pane of ['count', 'restitution']) {
        phase = `mobile-${id}-${actor}-${pane}`;
        await usable(button(page, 'Gestiones'), 'Gestiones'); await click(button(page, 'Gestiones'), 'Gestiones');
        const menu = page.getByRole('menuitem', { name: pane === 'count' ? 'Corregir conteo' : 'Restituciones de origen', exact: true });
        await usable(menu, pane); await click(menu, pane);
        const section = page.getByRole('region', { name: pane === 'count' ? 'Correcciones de conteo' : 'Restituciones de origen', exact: true });
        const item = baseline[id].items[0], label = `${item.brand} · ${item.model} · ${item.capacity_ah} Ah · ${item.polarity}`;
        const table = section.getByRole('table', { name: pane === 'count' ? 'Gestión de conteo' : 'Gestión de restituciones', exact: true });
        const group = table.getByRole('rowgroup', { name: label, exact: true }); await group.waitFor();
        if (pane === 'count') {
          must(await button(group, 'Proponer corrección').count() === 1);
          must(await button(group, 'Consultar propuesta').count() === 0 && await button(group, 'Reemplazar propuesta').count() === 0);
        } else {
          const consult = button(section, 'Consultar para revisar restitución'); await usable(consult, 'Consulta de restitución'); await click(consult, 'Consulta de restitución');
          await section.locator('.restitution-consultation button:not([disabled])').waitFor();
          const origin = actor === baseline[id].origin_location_id;
          if (origin) {
            must(await button(group, 'Aceptar restitución').count() === 0 && await button(group, 'Rechazar restitución').count() === 0);
            must(await button(group, 'Proponer restitución').isDisabled() === (id === '14'));
          } else {
            must(await button(group, 'Proponer restitución').count() === 0);
            must(await button(group, 'Aceptar restitución').isDisabled() && await button(group, 'Rechazar restitución').isDisabled());
          }
        }
        const history = baseline[id + (pane === 'count' ? '/count-corrections' : '/restitutions')].lines[0].proposals;
        if (history.length) {
          const toggle = group.getByRole('button', { name: /^Historial completo/ }); await usable(toggle, 'Historial completo');
          if (await toggle.getAttribute('aria-expanded') !== 'true') await click(toggle, 'Expandir historial');
          const revision = history.at(-1).revision;
          const disclosure = pane === 'count' ? button(group, `Ver detalle de revisión ${revision}`) : group.locator('summary').filter({ hasText: new RegExp(`^Ver detalle de propuesta ${revision}$`) });
          await usable(disclosure, 'Detalle de historial'); await click(disclosure, 'Detalle de historial');
          await emit({ type: 'history_disclosure', actor, id, pane, revision });
        } else await emit({ type: 'history_not_applicable', actor, id, pane, reason: 'no proposals' });
        await screenshot(actor, id, pane); await clean();
        await emit({ type: 'role_controls', actor, id, pane, pass: true, backendWriteDenialTested: false });
      }
      await unchanged(); completed.push({ actor, id, navigation: true, mobilePanes: 2 });
    }
    for (const { actor, id } of [{ actor: 1, id: '10' }, { actor: 3, id: '14' }]) {
      phase = `privacy-${id}-${actor}`; const page = actors.get(actor); await identity(actor); await page.setViewportSize({ width: 1280, height: 900 });
      const reply = page.waitForResponse(r => r.url() === `${baseURL}/api/transfers/${id}` && r.request().method() === 'GET', { timeout: 15000 }).catch(() => null);
      await page.goto(`${baseURL}/#/transferencias/${id}`, { waitUntil: 'domcontentloaded' });
      const response = await reply; await emit({ type: 'normal_GUI_detail_response', actor, id, status: response?.status() ?? null }); must(response?.status() === 404);
      await page.getByText('La solicitud no está disponible.', { exact: true }).waitFor();
      const main = page.getByRole('main'), text = await main.innerText();
      must(!text.includes(baseline[id].reference) && !text.includes(baseline[id].items[0].model) && !text.includes('TOYO'));
      must(await button(main, 'Gestiones').count() === 0 && await main.getByRole('table').count() === 0);
      must(await main.getByRole('button', { name: /^(Proponer|Aceptar|Rechazar|Aprobar|Despachar|Recibir|Registrar recepción|Cancelar)/ }).count() === 0);
      await emit({ type: 'privacy_denied', actor, id, privateReferenceProductTablesAbsent: true, businessActionControlsAbsent: true, backendGET404: true, backendWrite403Tested: false });
      const validId = actor === 1 ? '14' : '10'; await page.goto(`${baseURL}/#/transferencias/${validId}`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { level: 1, name: `TR-${validId.padStart(3, '0')}`, exact: true }).waitFor();
    }
    phase = 'final-read-only-check'; await clean(); await unchanged(); const finalStocks = await stocks();
    await emit({ type: 'stock_comparison', expected: initialStocks, observed: finalStocks, pass: same(finalStocks, initialStocks) }); must(same(finalStocks, initialStocks));
    result = { ...result, status: 'audit_views_pass', completed, screenshots, businessWrites: unexpected.length, privacyGET404Cases: 2, uncertainRecovery: 'NOT PROVED' };
    await emit({ type: 'result', ...result });
  } catch {
    result = { ...result, status: 'stopped', phase, completed, screenshots, businessWrites: unexpected.length, code: 'unexpected_or_existing_journal_no_retry' };
    if (file) await emit({ type: 'stopped', ...result, unexpected });
  } finally {
    for (const [actor, page] of actors) {
      if (unexpected.length) { await emit({ type: 'logout_skipped_unexpected_write', actor }); result.cleanupIncomplete = true; continue; }
      try { await page.setViewportSize({ width: 1280, height: 900 }); await click(button(page, 'Cerrar sesión'), 'Cerrar sesión'); await page.getByLabel('Usuario', { exact: true }).waitFor(); await emit({ type: 'logout', actor, pass: true }); }
      catch { if (file) await emit({ type: 'logout', actor, pass: false }); if (result) result.cleanupIncomplete = true; }
    }
    for (const context of contexts) try { await context.close(); } catch { if (result) result.cleanupIncomplete = true; }
    if (unexpected.length) result = { ...result, status: 'stopped', businessWrites: unexpected.length, code: 'unexpected_business_write' };
    if (file) { await emit({ type: 'final_summary', ...result, unexpected }); await file.close(); }
  }
  return result;
}
