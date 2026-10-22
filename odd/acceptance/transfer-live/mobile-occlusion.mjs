// Parent-only, exactly-once diagnostic. No auto invocation. Supply pinned Chromium
// and in-memory accounts; disable tracing/HAR/debug. Only GUI auth and read views.
import { mkdir, open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { checkedDTO, same } from './restitution.mjs';
const root = path.dirname(fileURLToPath(import.meta.url));
const must = value => { if (!value) throw new Error('diagnostic_check_failed'); };
const button = (page, name) => page.getByRole('button', { name, exact: true });

export async function diagnoseOcclusion({ browser, accounts, baseURL, outputDir }) {
  let file, context, page, baseline, stage = 'setup', authenticated = false;
  let result = { status: 'stopped' };
  const writes = [];
  const emit = async entry => { await file.write(JSON.stringify({ stage, ...entry }) + '\n'); await file.sync(); };
  const clean = () => must(writes.length === 0);
  const identity = async () => {
    const valid = await page.evaluate(async username => {
      const r = await fetch('/api/auth/validate', { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000) });
      if (r.status !== 200) return false;
      const s = await r.json();
      return s.authenticated === true && s.identity?.account_id === 1 && s.identity?.location?.id === 1 && s.identity?.username === username;
    }, accounts.find(a => a.locationId === 1).username);
    must(valid);
  };
  const snapshot = async () => {
    await identity(); const out = {};
    for (const suffix of ['', '/count-corrections', '/restitutions']) {
      const apiPath = `/api/transfers/14${suffix}`;
      const r = await page.evaluate(async url => {
        const response = await fetch(url, { method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000) });
        return { status: response.status, body: response.status === 200 ? await response.json() : null };
      }, apiPath);
      await emit({ type: 'GET', path: apiPath, status: r.status }); must(r.status === 200);
      out[suffix || 'detail'] = checkedDTO(r.body);
    }
    return out;
  };
  const geometry = async label => {
    const data = await button(page, 'Gestiones').evaluate(el => {
      const rect = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
      const describe = node => {
        if (!node) return null;
        // Never emit arbitrary page text or identity/auth content. Recognized static
        // navigation labels only; class/role are bounded and no attributes/values read.
        const text = node.closest('.identity,.mobile-identity,.mobile-header,.sidebar-footer') ? '[redacted]'
          : ['Gestiones', 'Inventario', 'Transferencias'].filter(s => node.textContent?.includes(s)).join(' ').slice(0, 80);
        return { tag: node.tagName, class: typeof node.className === 'string' ? node.className.slice(0, 160) : '', role: node.getAttribute('role')?.slice(0, 40) ?? null, text, bounds: rect(node), position: getComputedStyle(node).position };
      };
      const r = el.getBoundingClientRect(), center = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      const hit = document.elementFromPoint(center.x, center.y), ancestors = [];
      for (let n = el.parentElement; n; n = n.parentElement) {
        const s = getComputedStyle(n);
        if (n.scrollHeight > n.clientHeight || /(auto|scroll|hidden|clip)/.test(s.overflowY)) ancestors.push({ ...describe(n), overflowY: s.overflowY, scrollTop: n.scrollTop, clientHeight: n.clientHeight, scrollHeight: n.scrollHeight });
      }
      return { button: rect(el), center, hit: describe(hit), hitAncestors: hit ? [describe(hit.parentElement), describe(hit.parentElement?.parentElement)] : [],
        unobscured: !!hit && (el === hit || el.contains(hit)), inViewport: center.x >= 0 && center.x < innerWidth && center.y >= 0 && center.y < innerHeight,
        focused: document.activeElement === el, scrollY, clientHeight: document.documentElement.clientHeight, documentHeight: document.documentElement.scrollHeight,
        viewport: { width: innerWidth, height: innerHeight }, shells: [...document.querySelectorAll('.mobile-header,.bottom-nav,.app-header')].map(describe), scrollAncestors: ancestors };
    });
    await emit({ type: 'geometry', label, ...data }); return data;
  };
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const menuOpen = () => page.getByRole('menuitem', { name: 'Corregir conteo', exact: true }).isVisible();
  const closeMenu = async () => { if (await menuOpen()) { clean(); await button(page, 'Gestiones').click(); clean(); must(!await menuOpen()); } };
  const probeClick = async label => {
    clean(); let outcome = 'returned';
    try { await button(page, 'Gestiones').click({ timeout: 2500 }); }
    catch (error) { if (error?.name !== 'TimeoutError') throw error; outcome = 'TimeoutError'; }
    clean(); const opened = await menuOpen();
    await emit({ type: 'ordinary_click', label, outcome, opened }); await geometry(`${label}-after-click`);
    await closeMenu(); return opened;
  };
  try {
    must(baseURL === 'https://localhost:4323');
    must(Array.isArray(accounts) && accounts.filter(a => a.locationId === 1 && typeof a.username === 'string' && typeof a.password === 'string').length === 1);
    const output = path.resolve(outputDir); must(output === root || output.startsWith(root + path.sep));
    // Root-scoped lock prevents reruns even with a different screenshot directory.
    file = await open(path.join(root, 'mobile-occlusion-journal.jsonl'), 'wx', 0o600);
    await mkdir(output, { recursive: true });
    await emit({ type: 'plan', actor: 1, transfer: 'TR-014', businessWritesAllowed: 0, paneOrSubmitFlows: false });
    context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: false });
    context.on('request', req => {
      const u = new URL(req.url());
      if (u.origin === baseURL && u.pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(req.method()) && !['/api/auth/login', '/api/auth/logout'].includes(u.pathname)) {
        writes.push({ method: req.method(), path: /^\/api\/transfers(?:\/\d+)?(?:\/[a-z-]+)*$/.test(u.pathname) ? u.pathname : 'other-api-path' });
      }
    });
    page = await context.newPage(); page.setDefaultTimeout(15000); page.setDefaultNavigationTimeout(15000);
    stage = 'login'; await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
    const account = accounts.find(a => a.locationId === 1);
    await page.getByLabel('Usuario', { exact: true }).fill(account.username);
    await page.getByLabel('Contraseña', { exact: true }).fill(account.password);
    await button(page, 'Iniciar sesión').click(); await button(page, 'Cerrar sesión').waitFor(); await identity(); authenticated = true;
    stage = 'baseline'; baseline = await snapshot(); must(baseline.detail.status === 'received'); await emit({ type: 'baseline', snapshot: baseline });
    stage = 'audit-navigation';
    const url = `${baseURL}/#/transferencias/14`, list = `${baseURL}/#/transferencias`;
    const heading = page.getByRole('heading', { level: 1, name: 'TR-014', exact: true });
    await page.goto(url, { waitUntil: 'domcontentloaded' }); await heading.waitFor();
    await page.reload({ waitUntil: 'domcontentloaded' }); await heading.waitFor();
    clean(); await page.getByRole('navigation', { name: 'Navegación de transferencia', exact: true }).getByRole('button', { name: /^Volver a / }).click();
    await page.waitForURL(list); await page.getByRole('combobox', { name: 'Estado de transferencia', exact: true }).waitFor();
    await page.goBack(); await page.waitForURL(url); await heading.waitFor();
    await page.goForward(); await page.waitForURL(list); await page.getByRole('combobox', { name: 'Estado de transferencia', exact: true }).waitFor();
    await page.goBack(); await heading.waitFor();
    await page.setViewportSize({ width: 390, height: 900 });
    stage = 'original-scroll'; await button(page, 'Gestiones').scrollIntoViewIfNeeded();
    const original = await geometry('audit-scrollIntoViewIfNeeded');
    await identity(); must(await page.locator('input').count() === 0); await heading.waitFor();
    const image = await open(path.join(output, 'mobile-occlusion-original-390.png'), 'wx', 0o600);
    try { await image.writeFile(await page.screenshot({ fullPage: false, mask: [page.locator('.identity,.mobile-identity,.sidebar-footer,.app-header > span')] })); await image.sync(); } finally { await image.close(); }
    await emit({ type: 'screenshot', name: 'mobile-occlusion-original-390.png' });
    stage = 'ordinary-click'; const originalClickOpened = await probeClick('original');
    stage = 'manual-scroll';
    // Wheel is ordinary input; never click the known blocked coordinates or force.
    const scrollResults = [];
    for (const delta of [300, -300]) {
      await page.mouse.move(195, 450); await page.mouse.wheel(0, delta); await settle();
      const observed = await geometry(`wheel-${delta}`);
      scrollResults.push({ delta, unobscured: observed.unobscured, opened: await probeClick(`wheel-${delta}`) });
    }
    stage = 'keyboard';
    let reached = false, tabs = 0;
    for (; tabs < 60; tabs++) {
      clean(); await page.keyboard.press('Tab');
      if (await button(page, 'Gestiones').evaluate(el => document.activeElement === el)) { reached = true; tabs++; break; }
    }
    await geometry('tab-focus'); let keyboardOpened = false;
    if (reached) {
      await button(page, 'Gestiones').scrollIntoViewIfNeeded(); await geometry('focused-scrollIntoViewIfNeeded');
      clean(); await page.keyboard.press('Enter'); clean(); keyboardOpened = await menuOpen(); await closeMenu();
    }
    await emit({ type: 'keyboard', reached, tabs, opened: keyboardOpened });
    result = { status: 'diagnostic_complete', originalOccluded: !original.unobscured, originalClickOpened, scrollResults, keyboardOpened };
  } catch (error) {
    result = { status: 'stopped', stage, name: error?.name === 'TimeoutError' ? 'TimeoutError' : 'Error' };
    if (file) await emit({ type: 'stopped', ...result });
  } finally {
    if (baseline && page) {
      try {
        stage = 'after-snapshot'; const after = await snapshot(); const unchanged = same(baseline, after);
        await emit({ type: 'after', snapshot: after, unchanged }); result.unchanged = unchanged;
        if (!unchanged) result.status = 'stopped';
      } catch { result.status = 'stopped'; result.afterSnapshotFailed = true; }
    }
    if (authenticated && !writes.length) {
      try { stage = 'logout'; await page.setViewportSize({ width: 1280, height: 900 }); await button(page, 'Cerrar sesión').click(); await page.getByLabel('Usuario', { exact: true }).waitFor(); await emit({ type: 'logout', pass: true }); }
      catch { result.status = 'stopped'; result.cleanupIncomplete = true; }
    }
    if (context) try { await context.close(); } catch { result.status = 'stopped'; result.cleanupIncomplete = true; }
    result.businessWrites = writes.length; result.businessPOST = writes.filter(w => w.method === 'POST').length;
    if (writes.length) result.status = 'stopped';
    if (file) { await emit({ type: 'final', ...result, writes }); await file.close(); }
  }
  return result;
}
