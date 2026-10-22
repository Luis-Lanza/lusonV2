// Parent invokes exactly once with pinned Chromium and in-memory accounts.
// No auto invocation, credential-file/env reads, interception, traces or raw errors.
// Remaining views only; never invokes business actions or opens submit flows.
import { mkdir, open, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
import { checkedDTO, same } from './restitution.mjs';
const require = createRequire(new URL('../../../apps/web/package.json', import.meta.url));
const { parse } = require('lossless-json');
const root = path.dirname(fileURLToPath(import.meta.url));
const must = value => { if (!value) throw new Error('continuation_check_failed'); };
const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const number = value => { const s = String(value); must(/^(0|[1-9]\d*)$/.test(s)); return BigInt(s); };
const journalRows = async name => (await readFile(path.join(root, name), 'utf8')).trim().split('\n').map(JSON.parse);

export async function auditContinuation({ browser, accounts, baseURL, outputDir }) {
  let file, phase = 'setup', baseline, initialStocks, output;
  let result = { status: 'stopped' };
  const actors = new Map(), contexts = [], authenticated = new Set(), writes = [], screenshots = [], completed = [];
  const emit = async entry => { await file.write(JSON.stringify({ phase, ...entry }) + '\n'); await file.sync(); };
  const clean = () => must(writes.length === 0);
  const identity = async actor => {
    clean();
    const valid = await actors.get(actor).evaluate(async ({ actor, username }) => {
      const r = await fetch('/api/auth/validate', { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000) });
      if (r.status !== 200) return false;
      const s = await r.json(); return s.authenticated === true && s.identity?.location?.id === actor && s.identity?.account_id === actor && s.identity?.username === username;
    }, { actor, username: accounts.find(a => a.locationId === actor).username }); must(valid); clean();
  };
  const get = async (actor, apiPath, inventory = false) => {
    clean();
    const r = await actors.get(actor).evaluate(async url => {
      const response = await fetch(url, { method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000) });
      return { status: response.status, body: response.status === 200 ? await response.text() : '' };
    }, apiPath);
    clean(); await emit({ type: 'GET', actor, path: apiPath, status: r.status }); must(r.status === 200);
    return inventory ? parse(r.body) : checkedDTO(JSON.parse(r.body));
  };
  const snapshot = async () => {
    await identity(2); const out = {};
    for (const id of ['10', '14']) for (const suffix of ['', '/count-corrections', '/restitutions']) out[id + suffix] = await get(2, `/api/transfers/${id}${suffix}`);
    return out;
  };
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
    must(Object.keys(out).length === 570); return out;
  };
  const compare = async label => {
    const history = await snapshot(), inventory = await stocks();
    const historySame = same(history, baseline), stocksSame = same(inventory, initialStocks);
    await emit({ type: 'baseline_comparison', label, history, stocks: inventory, historySame, stocksSame }); must(historySame && stocksSame);
  };
  const click = async control => { clean(); await control.click(); clean(); };
  const geometry = async (control, label) => {
    const g = await control.evaluate(el => {
      const r = el.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2, hit = document.elementFromPoint(x, y);
      const shell = hit?.closest('.bottom-nav,.mobile-header,.app-header');
      return { x: r.x, y: r.y, width: r.width, height: r.height, center: { x, y }, scrollY,
        inViewport: x >= 0 && x < innerWidth && y >= 0 && y < innerHeight,
        unobscured: !!hit && (el === hit || el.contains(hit)),
        hit: hit ? { tag: hit.tagName, class: typeof hit.className === 'string' ? hit.className.slice(0, 120) : '' } : null,
        shell: shell ? { class: shell.className, position: getComputedStyle(shell).position, y: shell.getBoundingClientRect().y, height: shell.getBoundingClientRect().height } : null };
    });
    await emit({ type: 'geometry', label, ...g }); return g;
  };
  const safeClick = async (page, control, label, remains = true) => {
    clean(); await control.scrollIntoViewIfNeeded(); let g = await geometry(control, `${label}-before`);
    for (let n = 0; n < 2 && !g.unobscured && g.shell && ['fixed', 'sticky'].includes(g.shell.position); n++) {
      const delta = g.shell.y > 450 ? 300 : -300;
      await page.mouse.move(195, 450); await page.mouse.wheel(0, delta);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      g = await geometry(control, `${label}-wheel-${n + 1}`); clean();
    }
    // Locator actionability may resolve a transient edge overlap; never force.
    await click(control); await emit({ type: 'ordinary_click', label, returned: true });
    if (remains) {
      const after = await geometry(control, `${label}-after`);
      must(after.inViewport && after.unobscured);
    }
  };
  try {
    must(baseURL === 'https://localhost:4323');
    must(Array.isArray(accounts) && accounts.length === 3 && [1, 2, 3].every(id => accounts.filter(a => a.locationId === id && typeof a.username === 'string' && typeof a.password === 'string').length === 1));
    output = path.resolve(outputDir); must(output === root || output.startsWith(root + path.sep));
    file = await open(path.join(root, 'audit-continuation-journal.jsonl'), 'wx', 0o600); await mkdir(output, { recursive: true });
    const audit = await journalRows('audit-journal.jsonl'), diagnostic = await journalRows('mobile-occlusion-journal.jsonl');
    const prior = audit.filter(r => r.type === 'baseline'); must(prior.length === 1);
    baseline = Object.fromEntries(Object.entries(prior[0].history).map(([key, value]) => [key, checkedDTO(value)])); initialStocks = prior[0].stocks;
    must(Object.keys(initialStocks).length === 570 && audit.at(-1).businessWrites === 0);
    must(audit.at(-1).completed.length === 3 && audit.at(-1).status === 'stopped');
    const last = diagnostic.at(-1); must(last.status === 'diagnostic_complete' && last.unchanged && last.businessWrites === 0 && last.businessPOST === 0 && last.originalClickOpened);
    for (const type of ['baseline', 'after']) {
      const rows = diagnostic.filter(r => r.type === type); must(rows.length === 1);
      for (const suffix of ['', '/count-corrections', '/restitutions']) must(same(checkedDTO(rows[0].snapshot[suffix || 'detail']), baseline[`14${suffix}`]));
    }
    await emit({ type: 'plan', mobile: { actor: 1, id: '14', panes: ['count', 'restitution'] }, privacy: [{ actor: 1, id: '10' }, { actor: 3, id: '14' }], priorAuditPreserved: true, backendWrite403Tested: false });
    for (const actor of [1, 2, 3]) {
      phase = `login-${actor}`;
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: false }); contexts.push(context);
      context.on('request', req => {
        const u = new URL(req.url());
        if (u.origin === baseURL && u.pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(req.method()) && !['/api/auth/login', '/api/auth/logout'].includes(u.pathname)) writes.push({ actor, method: req.method(), path: /^\/api\/transfers(?:\/\d+)?(?:\/[a-z-]+)*$/.test(u.pathname) ? u.pathname : 'other-api-path' });
      });
      const page = await context.newPage(); actors.set(actor, page); page.setDefaultTimeout(15000); page.setDefaultNavigationTimeout(15000);
      await page.goto(baseURL, { waitUntil: 'domcontentloaded' }); const account = accounts.find(a => a.locationId === actor);
      await page.getByLabel('Usuario', { exact: true }).fill(account.username); await page.getByLabel('Contraseña', { exact: true }).fill(account.password);
      await click(button(page, 'Iniciar sesión')); await button(page, 'Cerrar sesión').waitFor(); await identity(actor); authenticated.add(actor);
    }
    phase = 'before'; await compare('before');
    const page = actors.get(1); await page.goto(`${baseURL}/#/transferencias/14`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { level: 1, name: 'TR-014', exact: true }).waitFor(); await page.setViewportSize({ width: 390, height: 900 });
    for (const pane of ['count', 'restitution']) {
      phase = `mobile-14-1-${pane}`; await safeClick(page, button(page, 'Gestiones'), 'Gestiones');
      const menu = page.getByRole('menuitem', { name: pane === 'count' ? 'Corregir conteo' : 'Restituciones de origen', exact: true });
      await menu.waitFor(); await emit({ type: 'menu_open', pane, pass: true }); await safeClick(page, menu, pane, false);
      const section = page.getByRole('region', { name: pane === 'count' ? 'Correcciones de conteo' : 'Restituciones de origen', exact: true });
      const item = baseline['14'].items[0], label = `${item.brand} · ${item.model} · ${item.capacity_ah} Ah · ${item.polarity}`;
      const group = section.getByRole('table', { name: pane === 'count' ? 'Gestión de conteo' : 'Gestión de restituciones', exact: true }).getByRole('rowgroup', { name: label, exact: true }); await group.waitFor();
      if (pane === 'count') {
        must(baseline['14/count-corrections'].lines[0].proposals.length === 0);
        must(await button(group, 'Proponer corrección').count() === 1 && await button(group, 'Consultar propuesta').count() === 0 && await button(group, 'Reemplazar propuesta').count() === 0);
        must(await group.getByRole('button', { name: /^Historial completo/ }).count() === 0);
        await emit({ type: 'history_not_applicable', reason: 'no count proposals' });
      } else {
        await safeClick(page, button(section, 'Consultar para revisar restitución'), 'Consultar restitución');
        await section.locator('.restitution-consultation button:not([disabled])').waitFor();
        await group.getByText('Restitución cerrada', { exact: true }).waitFor();
        must(await button(group, 'Proponer restitución').count() === 0 && await button(group, 'Aceptar restitución').isDisabled() && await button(group, 'Rechazar restitución').isDisabled());
        const history = baseline['14/restitutions'].lines[0].proposals; must(history.length === 1 && history[0].state === 'applied');
        const toggle = group.getByRole('button', { name: /^Historial completo/ });
        if (await toggle.getAttribute('aria-expanded') !== 'true') await safeClick(page, toggle, 'Historial completo');
        must(await toggle.getAttribute('aria-expanded') === 'true');
        const disclosure = group.locator('summary').filter({ hasText: /^Ver detalle de propuesta 1$/ });
        await safeClick(page, disclosure, 'Detalle aplicado');
        must(await disclosure.evaluate(el => el.parentElement.open));
        await group.getByRole('region', { name: 'Aplicación 1', exact: true }).waitFor();
        await emit({ type: 'closed_applied_history', pass: true, revision: '1' });
      }
      clean(); await identity(1); must(await page.getByLabel('Contraseña', { exact: true }).count() === 0);
      await page.getByRole('heading', { level: 1, name: 'TR-014', exact: true }).waitFor();
      const overflow = await page.evaluate(() => ({ width: innerWidth, documentWidth: document.documentElement.scrollWidth })); must(overflow.width === 390 && overflow.documentWidth <= overflow.width);
      const name = `audit-continuation-14-actor-1-${pane}-390.png`, image = await open(path.join(output, name), 'wx', 0o600);
      try { await image.writeFile(await page.screenshot({ fullPage: true, mask: [page.locator('.identity,.mobile-identity,.sidebar-footer,.app-header > span')] })); await image.sync(); } finally { await image.close(); }
      screenshots.push(name); completed.push({ actor: 1, id: '14', pane }); await emit({ type: 'mobile_pass', pane, name, ...overflow });
    }
    for (const { actor, id } of [{ actor: 1, id: '10' }, { actor: 3, id: '14' }]) {
      phase = `privacy-${actor}-${id}`; const page = actors.get(actor); await identity(actor); await page.setViewportSize({ width: 1280, height: 900 });
      const reply = page.waitForResponse(r => r.url() === `${baseURL}/api/transfers/${id}` && r.request().method() === 'GET').catch(() => null);
      clean(); await page.goto(`${baseURL}/#/transferencias/${id}`, { waitUntil: 'domcontentloaded' }); const response = await reply; clean();
      await emit({ type: 'GUI_detail_response', actor, id, status: response?.status() ?? null }); must(response?.status() === 404);
      await page.getByText('La solicitud no está disponible.', { exact: true }).waitFor();
      const main = page.getByRole('main'), text = await main.innerText();
      must(!text.includes(baseline[id].reference) && baseline[id].items.every(i => !text.includes(i.model) && !text.includes(i.brand)));
      must(await main.getByRole('table').count() === 0 && await button(main, 'Gestiones').count() === 0);
      must(await main.getByRole('button', { name: /^(Proponer|Aceptar|Rechazar|Aprobar|Despachar|Recibir|Registrar recepción|Cancelar)/ }).count() === 0);
      completed.push({ actor, id, privacyGET404: true }); await emit({ type: 'privacy_pass', actor, id, backendWrite403Tested: false });
      const validId = actor === 1 ? '14' : '10'; await page.goto(`${baseURL}/#/transferencias/${validId}`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { level: 1, name: `TR-${validId.padStart(3, '0')}`, exact: true }).waitFor();
    }
    // Actor 2 participated only in immutable baseline observations; restore a valid detail too.
    await actors.get(2).goto(`${baseURL}/#/transferencias/10`, { waitUntil: 'domcontentloaded' });
    await actors.get(2).getByRole('heading', { level: 1, name: 'TR-010', exact: true }).waitFor();
    phase = 'final'; await compare('final'); clean(); result = { status: 'audit_continuation_pass' };
  } catch (error) {
    result = { status: 'stopped', phase, name: error?.name === 'TimeoutError' ? 'TimeoutError' : 'Error' };
    if (file) await emit({ type: 'stopped', ...result });
  } finally {
    for (const actor of authenticated) {
      if (writes.length) { result.status = 'stopped'; result.cleanupIncomplete = true; continue; }
      try { const page = actors.get(actor); await page.setViewportSize({ width: 1280, height: 900 }); await click(button(page, 'Cerrar sesión')); await page.getByLabel('Usuario', { exact: true }).waitFor(); await emit({ type: 'logout', actor, pass: true }); }
      catch { result.status = 'stopped'; result.cleanupIncomplete = true; if (file) await emit({ type: 'logout', actor, pass: false }); }
    }
    for (const context of contexts) try { await context.close(); } catch { result.status = 'stopped'; result.cleanupIncomplete = true; }
    if (writes.length) result.status = 'stopped';
    result = { ...result, completed, screenshots, businessWrites: writes.length, businessPOST: writes.filter(w => w.method === 'POST').length };
    if (file) { await emit({ type: 'final_summary', ...result, writes }); await file.close(); }
  }
  return result;
}
