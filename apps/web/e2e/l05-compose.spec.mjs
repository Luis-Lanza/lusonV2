// External real-runtime tests only. No business-route intercepts, secret logs,
// traces, video, screenshots, installations or operational fixture writes.
import { test } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { parse } from 'lossless-json';
import { OwnedCompose } from './l05-owned-compose.mjs';

const runtime = JSON.parse(await readFile(process.env.LUSON_L05_CONTEXT, 'utf8'));
const phase = process.env.LUSON_L05_PHASE;
const check = (condition, label) => { if (!condition) throw new Error('L05 check failed: '+label); };
const number = value => Number(value.toString());
const params = location => '/api/inventory?'+new URLSearchParams({ location_id: String(location), page: '1', page_size: '10' });
async function data(response) {
  check(response.status() === 200, 'actual protected response HTTP 200');
  return parse(await response.text());
}
async function settle(page) {
  await page.locator('.results[aria-busy="false"]').waitFor();
  check(await page.locator('#results-message [role="alert"]').count() === 0, 'no current inventory error');
}
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
async function rendered(page, payload, mobile) {
  const selector = mobile ? '.variant[data-variant-id]' : 'tbody tr[data-variant-id]';
  const ordered = payload.items.map(item => item.variant_id.toString());
  const total = number(payload.total_variants);
  const first = ordered.length ? (number(payload.page)-1)*number(payload.page_size)+1 : 0;
  const last = ordered.length ? first+ordered.length-1 : 0;
  await page.waitForFunction(({ selector, ordered, range }) => {
    const actual = [...document.querySelectorAll(selector)].map(row => row.dataset.variantId);
    return JSON.stringify(actual) === JSON.stringify(ordered) && document.querySelector('.range')?.textContent.includes(range);
  }, { selector, ordered, range: `${first}–${last}` });
  check((await page.locator('.range').textContent()).includes(`de ${total} variantes`), 'range counts server variants');
  check((await page.locator('.current-page').textContent()) === payload.page.toString(), 'current page matches response');
  for (const item of payload.items) {
    const row = page.locator(`${selector}[data-variant-id="${item.variant_id.toString()}"]`);
    check((await row.locator('.available').textContent()).startsWith(item.available.toString()), 'exact server availability');
    if (mobile) {
      const quantities = await row.locator('.variant-bottom b').allTextContents();
      check(same(quantities,[item.existing.toString(),item.reserved.toString()]), 'exact mobile quantities');
      const card = page.locator(`.product-card[data-catalog-entry-id="${item.catalog_entry_id.toString()}"]`);
      check((await card.locator('h2').textContent()).includes(`${item.brand} · ${item.model} · ${item.capacity_ah.toString()} Ah`), 'exact mobile catalog/capacity');
    } else {
      const cells = await row.locator('td').allTextContents();
      check(same(cells.slice(0,3),[item.brand,item.model,item.capacity_ah.toString()+' Ah'])
        && cells[4] === item.existing.toString() && cells[5] === item.reserved.toString(), 'exact desktop catalog/capacity/quantities');
    }
    check((await row.locator('.polarity').textContent()) === item.polarity, 'explicit server polarity');
  }
  if (mobile) {
    const groups = [...new Set(payload.items.map(item => item.catalog_entry_id.toString()))];
    check(same(await page.locator('.product-card').evaluateAll(cards => cards.map(card => card.dataset.catalogEntryId)),groups), 'page-only ordered mobile groups');
  }
}
async function filterAndPager(page, location, mobile, account, assigned) {
  const base = { location_id: String(location), page: '1', page_size: '10' };
  const full = [];
  for (let pageNumber = 1; pageNumber <= 4; pageNumber++) {
    const payload = await data(await page.request.get('/api/inventory?'+new URLSearchParams({ ...base, page: String(pageNumber), page_size: '50' })));
    check(number(payload.total_variants) === 190, 'real complete variant total');
    full.push(...payload.items);
  }
  check(full.length === 190 && new Set(full.map(item => item.variant_id.toString())).size === 190, 'complete unique server inventory');
  const matches = (item,q) => (!q.search || item.brand.toLowerCase().includes(q.search.toLowerCase()) || item.model.toLowerCase().includes(q.search.toLowerCase()))
    && (!q.brand || item.brand === q.brand) && (!q.polarity || item.polarity === q.polarity);
  async function change(action,q) {
    const requested = [];
    const observe = req => { if (new URL(req.url()).pathname === '/api/inventory') requested.push([...new URL(req.url()).searchParams].sort()); };
    page.on('request',observe);
    let payload;
    try {
      const [response] = await Promise.all([
        page.waitForResponse(r => new URL(r.url()).pathname === '/api/inventory' && same([...new URL(r.url()).searchParams].sort(),Object.entries(q).sort())),
        action(),
      ]);
      payload = await data(response); await settle(page); await rendered(page,payload,mobile);
    } finally { page.off('request',observe); }
    check(requested.length > 0 && requested.every(query => same(query,Object.entries(q).sort())), 'atomic query reset without intermediate wrong page');
    const expected = full.filter(item => matches(item,q));
    const offset = (Number(q.page)-1)*Number(q.page_size);
    const values = item => [item.variant_id.toString(),item.capacity_ah.toString(),item.existing.toString(),item.reserved.toString(),item.available.toString()];
    check(number(payload.total_variants) === expected.length && same(payload.items.map(values),expected.slice(offset,offset+Number(q.page_size)).map(values)), 'literal AND filters/page/order/quantities match actual catalog');
    const identity = await data(await page.request.get('/api/auth/session'));
    check(identity.identity.username === account.username && number(identity.identity.location.id) === assigned, 'filter/pager preserves assigned actor');
    return payload;
  }
  const search = page.getByLabel('Buscar marca o modelo');
  const fractional = full.filter(item => item.capacity_ah.toString() === '6.5');
  check(fractional.length > 0 && fractional.every(item => !matches(item,{ search: '6.5' })), 'fractional capacities exist but are not brand/model matches');
  const chosen = fractional[0];
  await change(() => search.fill(chosen.model),{ ...base, search: chosen.model });
  await change(() => page.getByLabel('Marca', { exact: true }).selectOption(chosen.brand),{ ...base, search: chosen.model, brand: chosen.brand });
  await change(() => page.getByLabel('Polaridad', { exact: true }).selectOption('R'),{ ...base, search: chosen.model, brand: chosen.brand, polarity: 'R' });
  if (mobile) check(await page.locator('.variant').count() === await page.locator('.product-card').count(), 'single-polarity mobile groups retain singleton variants');
  await change(() => page.getByLabel('Marca', { exact: true }).selectOption(''),{ ...base, search: chosen.model, polarity: 'R' });
  await change(() => page.getByLabel('Polaridad', { exact: true }).selectOption(''),{ ...base, search: chosen.model });
  for (const literal of ['_','%','\\','6.5']) await change(() => search.fill(literal),{ ...base, search: literal });
  await change(() => search.fill(''),base);
  const next = page.getByRole('button', { name: 'Página siguiente' });
  const previous = page.getByRole('button', { name: 'Página anterior' });
  check(await previous.isDisabled(), 'first page cannot go backwards');
  await change(() => next.click(),{ ...base, page: '2' });
  await change(() => previous.click(),base);
  await change(() => next.click(),{ ...base, page: '2' });
  await change(() => page.getByLabel('Filas por página').selectOption('25'),{ ...base, page_size: '25' });
  await change(() => next.click(),{ ...base, page: '2', page_size: '25' });
  await change(() => page.getByLabel('Filas por página').selectOption('50'),{ ...base, page_size: '50' });
  for (const n of [2,3,4]) await change(() => next.click(),{ ...base, page: String(n), page_size: '50' });
  check(await next.isDisabled(), 'last page cannot invent an out-of-range GUI control');
  // Existing GUI correctly disables next. Assert out-of-range via a real browser
  // request only, never add a UI control or claim an unrendered empty UI range.
  const outside = await data(await page.request.get('/api/inventory?'+new URLSearchParams({ ...base, page: '5', page_size: '50' })));
  check(number(outside.total_variants) === 190 && outside.items.length === 0 && number(outside.page) === 5, 'valid out-of-range real server response');
  await change(() => page.getByLabel('Filas por página').selectOption('10'),base);
}
async function login(page, account, wrong = false) {
  await page.getByLabel('Usuario', { exact: true }).fill(account.username);
  await page.getByLabel('Contraseña', { exact: true }).fill(wrong ? 'wrong_'+account.password : account.password);
  await page.waitForFunction(() => !document.querySelector('button[type=submit]').disabled);
  const [response] = await Promise.all([
    page.waitForResponse(r => new URL(r.url()).pathname === '/api/auth/login'),
    page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click(),
  ]);
  check(response.status() === (wrong ? 401 : 200), 'real credential status');
  if (wrong) {
    await page.getByRole('alert').waitFor();
    check(await page.getByLabel('Contraseña', { exact: true }).inputValue() === '', 'failed password cleared');
    await page.waitForFunction(() => !document.querySelector('button[type=submit]').disabled);
  } else {
    await page.locator('tbody tr,.variant').first().waitFor(); await settle(page);
    const cookies = await page.context().cookies();
    const session = cookies.find(cookie => cookie.name === 'luson_session');
    check(session?.secure && session.httpOnly && session.sameSite === 'Strict' && session.path === '/', 'real TLS session flags');
  }
}
async function raw(path, method = 'GET') {
  return new Promise((done, reject) => {
    const req = request(runtime.origin, { path, method, minVersion: 'TLSv1.2', timeout: 5000 }, response => {
      let body = '';
      const protocol = response.socket.getProtocol();
      response.on('data', bytes => { if (body.length < 2<<20) body += bytes.toString(); });
      response.once('end', () => done({ status: response.statusCode, headers: response.headers, body, protocol }));
    });
    req.once('error', () => reject(new Error('Private trusted TLS request failed.')));
    req.once('timeout', () => req.destroy()); req.end();
  });
}
async function staticChecks(page) {
  const index = await raw('/');
  check(index.status === 200 && index.headers['content-type'] === 'text/html; charset=utf-8' && index.headers['cache-control'] === 'no-cache', 'compiled index MIME/revalidation');
  check(['TLSv1.2','TLSv1.3'].includes(index.protocol), 'actual negotiated TLS');
  check((await raw('/index.html')).body === index.body, 'exact index route');
  const assetPaths = [...index.body.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)].map(match => match[1]);
  check(assetPaths.some(path => path.endsWith('.js')) && assetPaths.some(path => path.endsWith('.css')), 'actual build-owned hashed JS/CSS');
  let css = '';
  for (const path of assetPaths) {
    const get = await raw(path), head = await raw(path,'HEAD');
    check(get.status === 200 && get.headers['cache-control'] === 'public, max-age=31536000, immutable'
      && get.headers['x-content-type-options'] === 'nosniff' && head.status === 200 && head.body === ''
      && head.headers['content-length'] === get.headers['content-length'] && head.headers['content-type'] === get.headers['content-type'], 'hashed assets GET/HEAD/cache/nosniff');
    check(get.headers['content-type'] === (path.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8'), 'asset MIME');
    if (path.endsWith('.css')) css += get.body;
  }
  const fonts = [...css.matchAll(/url\(["']?([^\)"']+\.woff2?)["']?\)/g)].map(match => match[1]);
  check(fonts.length > 0, 'compiled local font URLs');
  for (const font of new Set(fonts)) {
    const path = new URL(font, runtime.origin+'/assets/index.css').pathname;
    const response = await raw(path);
    check(path.startsWith('/assets/') && response.status === 200 && response.headers['content-type'] === (path.endsWith('.woff2') ? 'font/woff2' : 'font/woff'), 'font actually served by Go');
  }
  const head = await raw('/','HEAD');
  check(head.body === '' && head.headers['content-length'] === index.headers['content-length'] && head.headers['cache-control'] === 'no-cache', 'index HEAD parity');
  const post = await raw('/','POST');
  check(post.status === 405 && post.headers.allow === 'GET, HEAD', 'static 405 Allow');
  for (const path of ['/unknown','/login','/src/main.tsx','/.env','/run/secrets/database_url','/assets/index-missing1.js','/assets/source.ts','/assets/../index.html','/assets/%2e%2e/index.html','/assets%2findex.html','/assets%5cindex.html','/%2e/index.html',assetPaths[0]+'.map','/api','/api/unknown']) {
    const response = await raw(path);
    check(response.status === 404 && !response.body.includes('id="root"'), 'static/API unknown and unsafe paths do not fall back');
  }
  check((await page.request.get('/api/inventory?location_id=1')).status() === 401, 'anonymous protected API denial');
}
async function geometry(page, mobile) {
  await page.evaluate(() => document.fonts.ready);
  const value = await page.evaluate(mobile => {
    const style = selector => getComputedStyle(document.querySelector(selector));
    const box = selector => document.querySelector(selector)?.getBoundingClientRect();
    return { inter: document.fonts.check('14px Inter'), font: style('html').fontFamily,
      background: style('html').backgroundColor, text: style('html').color, wine: style('.primary').backgroundColor,
      overflow: document.documentElement.scrollWidth > innerWidth,
      sidebar: box('.sidebar')?.width, header: box('.app-header')?.height, row: box('tbody tr')?.height,
      shell: box('.warehouse')?.width, nav: box('.bottom-nav')?.height,
      padding: style('.inventory-main').paddingLeft, clearance: mobile ? style('.warehouse').paddingBottom : null,
    };
  }, mobile);
  check(value.inter && value.font.includes('Inter'), 'local Inter rendered');
  check(value.background === 'rgb(248, 246, 244)' && value.text === 'rgb(36, 33, 36)' && value.wine === 'rgb(122, 31, 61)', 'unchanged reference palette');
  check(!value.overflow, 'no horizontal overflow');
  if (mobile) {
    check(value.shell === 390 && value.nav === 64 && value.padding === '16px' && value.clearance === '112px', '390px warehouse layout');
    await page.locator('.pager').scrollIntoViewIfNeeded();
    check(await page.evaluate(() => document.querySelector('.pager').getBoundingClientRect().bottom <= document.querySelector('.bottom-nav').getBoundingClientRect().top), 'scroll reaches pager above fixed navigation');
  } else check(value.sidebar === 240 && value.header === 56 && value.row === 44, 'desktop sidebar/header/table');
}

if (phase === 'initial') {
  for (let i = 0; i < 3; i++) test('L05 account '+(i+1)+' all real inventories and HTTPS/static/auth', async ({ page }) => {
    const mobile = i === 0;
    const account = runtime.accounts[i];
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1280, height: 1024 });
    await page.goto('/');
    if (i === 0) await staticChecks(page);
    await login(page,account,true); await login(page,account);
    const metadata = await data(await page.request.get('/api/inventory/metadata'));
    check(metadata.locations.length === 3 && metadata.brands.length === 11, 'real catalog metadata');
    let consulted = String(i+1);
    for (const location of metadata.locations) {
      const selected = location.id.toString();
      if (selected !== consulted) {
        await Promise.all([
          page.waitForResponse(r => new URL(r.url()).pathname === '/api/inventory' && new URL(r.url()).searchParams.get('location_id') === selected),
          mobile ? page.getByLabel('Consultar ubicación').selectOption(selected) : page.getByRole('button', { name: new RegExp(location.name) }).click(),
        ]);
        await settle(page); consulted = selected;
      }
      const inventory = await data(await page.request.get(params(selected)));
      check(number(inventory.total_variants) === 190 && inventory.items.length === 10 && number(inventory.location.id) === number(location.id), 'real per-location 190 variants');
      for (const item of inventory.items) {
        const row = page.locator(`${mobile ? '.variant' : 'tbody tr'}[data-variant-id="${item.variant_id.toString()}"]`);
        check((await row.locator('.available').textContent()).startsWith(item.available.toString()), 'server quantity rendered exactly');
      }
      const session = await data(await page.request.get('/api/auth/session'));
      check(session.identity.username === account.username && number(session.identity.location.id) === i+1, 'consultation cannot alter assigned actor');
      check((await page.request.get(params(selected)+'&actor_id=2')).status() === 400, 'client actor cannot override identity');
      await filterAndPager(page,selected,mobile,account,i+1);
    }
    if (i !== 2) {
      await Promise.all([page.waitForResponse(r => new URL(r.url()).pathname === '/api/inventory'),
        mobile ? page.getByLabel('Consultar ubicación').selectOption(String(i+1)) : page.getByRole('button', { name: new RegExp(i === 0 ? 'Almacén' : 'Sucursal A') }).click()]);
      await settle(page);
    }
    await geometry(page,mobile);
    check(await page.getByRole('button', { name: 'Transferencias', exact: true }).isDisabled() && await page.locator('.transfer-cta').isDisabled(), 'native disabled transfer controls');
    await page.getByLabel('Buscar marca o modelo').focus(); await page.keyboard.press('Tab');
    check(await page.getByLabel('Marca', { exact: true }).evaluate(el => document.activeElement === el), 'keyboard filter access');
    await page.reload(); await settle(page);
    check(await page.evaluate(() => localStorage.length === 0 && sessionStorage.length === 0), 'no browser credential storage');
    const previousCookies = await page.context().cookies();
    const [logout] = await Promise.all([page.waitForResponse(r => new URL(r.url()).pathname === '/api/auth/logout'), page.getByRole('button', { name: 'Cerrar sesión', exact: true }).click()]);
    check(logout.status() === 204, 'real persisted logout');
    await page.getByLabel('Usuario', { exact: true }).waitFor();
    check((await page.request.get(params(i+1), { headers: { Cookie: previousCookies.filter(c => c.name === 'luson_session').map(c => c.name+'='+c.value).join('; ') } })).status() === 401, 'revoked cookie denied');
    check(await page.locator('table,.product-card').count() === 0, 'logout clears inventory');
    if (i === 0) {
      await login(page,account);
      // Session persistence cookie is private IPC, never a committed fixture.
      await writeFile(runtime.cookiePath, JSON.stringify(await page.context().storageState()), { flag: 'wx', mode: 0o600 });
    }
  });
} else if (phase === 'persisted') {
  test('L05 retained session after container recreation and isolated expiry', async ({ browser }) => {
    const context = await browser.newContext({ baseURL: runtime.origin, storageState: JSON.parse(await readFile(runtime.cookiePath,'utf8')), ignoreHTTPSErrors: false, viewport: { width: 390, height: 844 } });
    try {
      const page = await context.newPage(); await page.goto('/'); await settle(page);
      const session = await data(await page.request.get('/api/auth/session'));
      check(session.identity.username === runtime.accounts[0].username && number(session.identity.location.id) === 1, 'persisted private cookie authenticates after recreation');
      const inventory = await data(await page.request.get(params(1)));
      check(inventory.items[0].existing.toString() === '19', 'one fixture mutation survives and was not reseeded');
      const cookie = (await context.cookies()).find(c => c.name === 'luson_session');
      const hash = createHash('sha256').update(cookie.value).digest('hex');
      const state = JSON.parse(await readFile(runtime.statePath,'utf8'));
      const command = async (binary,args,options = {}) => new Promise((done,reject) => {
        const child = spawn(binary,args,{ env: runtime.env, stdio: ['pipe','pipe','pipe'] });
        let output = ''; child.stderr.resume();
        child.stdout.on('data', bytes => { if (output.length < 65536) output += bytes.toString(); });
        child.stdin.on('error', () => {}); child.stdin.end(options.input ?? '');
        const timer = setTimeout(() => child.kill('SIGTERM'),15000);
        child.once('error', () => { clearTimeout(timer); reject(new Error('Bounded fixture SQL unavailable.')); });
        child.once('close', code => { clearTimeout(timer); code === 0 ? done(output.trim()) : reject(new Error('Private fixture SQL failed.')); });
      });
      const owner = new OwnedCompose({ command, manifestPath: runtime.manifestPath, composePath: runtime.composePath, overridePath: runtime.overridePath, env: runtime.env });
      owner.owned = new Map(Object.entries(state.ids)); owner.hashes = new Map(Object.entries(state.hashes));
      check(await owner.sql(`WITH expired AS (UPDATE auth_sessions SET idle_deadline=now()-interval '1 second' WHERE token_hash=decode('${hash}','hex') AND revoked_at IS NULL RETURNING account_id) SELECT count(*) FROM expired;`) === '1', 'expire only retained own TEST session after persistence phase');
      await page.getByLabel('Buscar marca o modelo').fill('expiry');
      await page.getByLabel('Usuario', { exact: true }).waitFor();
      await page.waitForFunction(() => document.activeElement?.id === 'username');
      check(await page.locator('table,.product-card,.identity').count() === 0 && (await page.request.get(params(1))).status() === 401, 'real expiry removes protected content and denies reads');
    } finally { await context.close(); }
  });
} else throw new Error('Explicit L05 phase required; no skipped acceptance.');
