import { test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { parse } from 'lossless-json';
import { fixtureSQL } from './owned-pg.mjs';

// TEST credentials live ONLY in the runner's private 0600 IPC file. No reporter
// receives credentials, requests, response bodies, cookies, DOM or screenshots.
const runtime = JSON.parse(await readFile(process.env.LUSON_E2E_CONTEXT_PATH, 'utf8'));
function check(condition, label) { if (!condition) throw new Error(`Check failed: ${label}`); }
const number = value => Number(value.toString());
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const urlFor = q => '/api/inventory?' + new URLSearchParams(q);
async function payload(response) {
  check(response.status() === 200, 'real inventory HTTP 200');
  return parse(await response.text());
}
async function settle(page) {
  await page.locator('.results[aria-busy="false"]').waitFor();
  check(await page.locator('#results-message [role="alert"]').count() === 0, 'no current results error');
}
async function change(page, action, params) {
  const [response] = await Promise.all([
    page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === '/api/inventory' && same([...url.searchParams].sort(), Object.entries(params).sort());
    }), action(),
  ]);
  const data = await payload(response);
  await settle(page);
  return data;
}
async function login(page, account, bad = false) {
  await page.getByLabel('Usuario', { exact: true }).fill(account.username);
  await page.getByLabel('Contraseña', { exact: true }).fill(bad ? 'wrong_' + account.password : account.password);
  await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).waitFor();
  // Wait for CSRF/session restoration, not a guessed delay.
  await page.waitForFunction(() => !document.querySelector('button[type=submit]').disabled);
  const [response] = await Promise.all([
    page.waitForResponse(r => new URL(r.url()).pathname === '/api/auth/login'),
    page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click(),
  ]);
  const req = response.request();
  check(req.method() === 'POST', 'login event POST');
  const body = req.postDataJSON();
  check(same(Object.keys(body).sort(), ['password', 'username']), 'exact login field set');
  check(body.username === account.username && body.password === (bad ? 'wrong_' + account.password : account.password), 'submitted private TEST inputs');
  const headers = await req.allHeaders();
  check(headers['content-type'] === 'application/json' && headers.origin === runtime.origin && /^[A-Za-z0-9_-]{43}$/.test(headers['x-csrf-token']), 'JSON/CSRF/browser Origin');
  check(response.status() === (bad ? 401 : 200), 'real login status');
  if (bad) {
    await page.getByRole('alert').waitFor();
    check(await page.getByLabel('Contraseña', { exact: true }).inputValue() === '', 'password cleared on failure');
    check(await page.locator('table,.product-card').count() === 0, 'bad login has no protected rows');
    await page.waitForFunction(() => !document.querySelector('button[type=submit]').disabled);
  } else {
    await page.locator('tbody tr,.variant').first().waitFor();
    await settle(page);
  }
}
async function allVariants(page, location) {
  const result = [];
  let total;
  for (let n = 1; n <= 4; n++) {
    const data = await payload(await page.request.get(urlFor({ location_id: String(location), page: String(n), page_size: '50' })));
    total = number(data.total_variants);
    result.push(...data.items);
  }
  check(result.length === total && total === 190, 'real 190-variant PostgreSQL inventory');
  return result;
}
async function assertRendered(page, data, mobile) {
  const selector = mobile ? '.variant[data-variant-id]' : 'tbody tr[data-variant-id]';
  check(same(await page.locator(selector).evaluateAll(rows => rows.map(row => Number(row.dataset.variantId))), data.items.map(i => number(i.variant_id))), 'rendered variant order matches server page');
  for (const item of data.items) {
    const row = page.locator(`${selector}[data-variant-id="${item.variant_id.toString()}"]`);
    const text = await row.textContent();
    if (mobile) {
      check(text.includes(item.existing.toString()) && text.includes(item.reserved.toString()), 'real existing/reserved card quantities');
      const card = page.locator(`.product-card[data-catalog-entry-id="${item.catalog_entry_id.toString()}"]`);
      check((await card.locator('h2').textContent()).includes(`${item.brand} · ${item.model} · ${item.capacity_ah.toString()} Ah`), 'real card catalog/capacity');
    } else {
      const cells = await row.locator('td').allTextContents();
      check(cells[0] === item.brand && cells[1] === item.model && cells[2] === item.capacity_ah.toString() + ' Ah', 'real table catalog/capacity');
      check(cells[4] === item.existing.toString() && cells[5] === item.reserved.toString(), 'real table quantities');
    }
    check((await row.locator('.available').textContent()).startsWith(item.available.toString()), 'server availability displayed without recomputation');
    check(await row.getByText('Sin disponible', { exact: true }).count() === (item.available.toString() === '0' ? 1 : 0), 'zero availability label only');
  }
  const first = data.items.length ? (number(data.page) - 1) * number(data.page_size) + 1 : 0;
  const last = data.items.length ? first + data.items.length - 1 : 0;
  const range = await page.locator('.range').textContent();
  check(range.includes(`${first}–${last}`) && range.includes(`de ${data.total_variants.toString()} variantes`), 'variant range, not card count');
  if (mobile) {
    const groups = [...new Set(data.items.map(i => number(i.catalog_entry_id)))];
    check(same(await page.locator('.product-card').evaluateAll(cards => cards.map(c => Number(c.dataset.catalogEntryId))), groups), 'page-only catalog grouping/order');
    check(await page.getByRole('table').count() === 0, 'mobile has cards only');
  } else check(await page.locator('.product-card').count() === 0, 'desktop has table only');
}
async function geometry(page, mobile) {
  await page.evaluate(() => document.fonts.ready);
  const measured = await page.evaluate(mobile => {
    const style = el => getComputedStyle(el);
    const box = selector => document.querySelector(selector)?.getBoundingClientRect();
    const rootStyle = style(document.documentElement);
    return {
      font: rootStyle.fontFamily, inter: document.fonts.check('14px Inter'),
      background: rootStyle.backgroundColor, text: rootStyle.color,
      wine: style(document.querySelector('.primary')).backgroundColor,
      border: style(document.querySelector(mobile ? '.product-card' : '.results')).borderTopColor,
      sidebar: box('.sidebar')?.width, header: box('.app-header')?.height,
      row: box('tbody tr')?.height, card: box('.login-card')?.width,
      shell: box('.warehouse')?.width, padding: style(document.querySelector('.inventory-main')).paddingLeft,
      clearance: mobile ? style(document.querySelector('.warehouse')).paddingBottom : null,
      nav: box('.bottom-nav')?.height, overflow: document.documentElement.scrollWidth > innerWidth,
      scroll: document.documentElement.scrollHeight, viewport: innerHeight,
    };
  }, mobile);
  // Values come from the definitive HTML/CSS, not raster pixels. Desktop export
  // is a scaled JPEG despite its .png suffix; 240/56/44 are CSS dimensions.
  check(measured.font.includes('Inter') && measured.inter, 'local Inter actually loaded');
  check(measured.background === 'rgb(248, 246, 244)' && measured.text === 'rgb(36, 33, 36)' && measured.wine === 'rgb(122, 31, 61)' && measured.border === 'rgb(222, 215, 218)', 'export palette');
  if (mobile) {
    check(measured.shell === 390 && measured.padding === '16px' && measured.nav === 64 && measured.clearance === '112px', '390 CSS width/16 spacing/64 navigation/112 clearance');
    check(!measured.overflow && measured.scroll > measured.viewport, 'full mobile scrolling without horizontal overflow');
    await page.locator('.pager').scrollIntoViewIfNeeded();
    const end = await page.evaluate(() => {
      window.scrollTo(0, document.documentElement.scrollHeight);
      return { bottom: document.querySelector('.pager').getBoundingClientRect().bottom, navTop: document.querySelector('.bottom-nav').getBoundingClientRect().top };
    });
    check(end.bottom <= end.navTop, 'pager readable above fixed navigation after full scroll');
  } else check(measured.sidebar === 240 && measured.header === 56 && measured.row === 44, 'desktop 240 sidebar/56 header/44 rows');
}

for (let accountIndex = 0; accountIndex < 3; accountIndex++) {
  test(`assigned account ${accountIndex + 1}: all three real inventories, auth and consultation`, async ({ page }) => {
    const mobile = accountIndex === 0;
    const account = runtime.accounts[accountIndex];
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1280, height: 1024 });
    await page.goto('/');
    // Empty login only: inspect actual reference card and palette without any screenshot.
    const loginCard = await page.locator('.login-card').boundingBox();
    check(Math.abs(loginCard.width - (mobile ? 358 : 420)) < 1, '420 login card constrained by 16px mobile gutters');
    await login(page, account, true);
    await login(page, account);
    const current = parse(await (await page.request.get('/api/auth/session')).text());
    check(current.authenticated && number(current.identity.location.id) === accountIndex + 1 && current.identity.username === account.username, 'real assigned account identity');
    const meta = parse(await (await page.request.get('/api/inventory/metadata')).text());
    check(meta.locations.length === 3 && meta.brands.length === 11, 'real PostgreSQL metadata');
    check(await page.getByRole('button', { name: 'Transferencias', exact: true }).isDisabled(), 'native disabled navigation');
    check(await page.locator('.transfer-cta').isDisabled(), 'native disabled transfer CTA');
    let consulted = String(accountIndex + 1);
    for (const location of meta.locations) {
      const id = location.id.toString();
      const params = { location_id: id, page: '1', page_size: '10' };
      let data;
      if (id === consulted) data = await payload(await page.request.get(urlFor(params)));
      else data = await change(page, () => mobile ? page.getByLabel('Consultar ubicación').selectOption(id) : page.getByRole('button', { name: new RegExp(location.name) }).click(), params);
      consulted = id;
      if (mobile) check(await page.getByLabel('Consultar ubicación').inputValue() === id, 'mobile selected consultation');
      else check(await page.getByRole('button', { name: new RegExp(location.name) }).getAttribute('aria-pressed') === 'true', 'desktop selected consultation');
      await assertRendered(page, data, mobile);
      const after = parse(await (await page.request.get('/api/auth/session')).text());
      check(number(after.identity.location.id) === accountIndex + 1 && after.identity.username === account.username, 'consultation never changes assigned identity');
      const full = await allVariants(page, id);
      const expectedBrands = [...new Set(full.map(i => i.brand))].sort();
      check(same([...meta.brands].sort(), expectedBrands), 'metadata is catalog-derived');
      // Exact filters are AND; variants and metadata come from real responses.
      const chosen = full.find(i => i.model.includes('_')) ?? full[0];
      const search = page.getByLabel('Buscar marca o modelo');
      const base = { location_id: id, page: '1', page_size: '10' };
      const searchText = chosen.model;
      await change(page, () => search.fill(searchText), { ...base, search: searchText });
      await change(page, () => page.getByLabel('Marca', { exact: true }).selectOption(chosen.brand), { ...base, search: searchText, brand: chosen.brand });
      data = await change(page, () => page.getByLabel('Polaridad', { exact: true }).selectOption('R'), { ...base, search: searchText, brand: chosen.brand, polarity: 'R' });
      const expected = full.filter(i => (i.brand.toLowerCase().includes(searchText.toLowerCase()) || i.model.toLowerCase().includes(searchText.toLowerCase())) && i.brand === chosen.brand && i.polarity === 'R');
      check(number(data.total_variants) === expected.length, 'literal brand/model AND exact brand AND polarity');
      await assertRendered(page, data, mobile);
      if (mobile) check(await page.locator('.product-card .variants .variant').count() === await page.locator('.product-card').count(), 'filtered singleton cards are valid');
      await change(page, () => page.getByLabel('Marca', { exact: true }).selectOption(''), { ...base, search: searchText, polarity: 'R' });
      await change(page, () => page.getByLabel('Polaridad', { exact: true }).selectOption(''), { ...base, search: searchText });
      for (const literal of ['_', '%', '\\', '6.5']) {
        data = await change(page, () => search.fill(literal), { ...base, search: literal });
        const literalCount = full.filter(i => i.brand.toLowerCase().includes(literal) || i.model.toLowerCase().includes(literal)).length;
        check(number(data.total_variants) === literalCount, 'literal special characters and no capacity search');
        await assertRendered(page, data, mobile);
      }
      data = await change(page, () => search.fill(''), base);
      await search.focus();
      // Browser keyboard change exercises selection and ordinary fetch focus.
      await page.getByLabel('Polaridad', { exact: true }).focus();
      data = await change(page, () => page.getByLabel('Polaridad', { exact: true }).selectOption('L'), { ...base, polarity: 'L' });
      check(await page.getByLabel('Polaridad', { exact: true }).evaluate(el => document.activeElement === el), 'ordinary fetch keeps filter focus');
      await assertRendered(page, data, mobile);
      await change(page, () => page.getByLabel('Polaridad', { exact: true }).selectOption(''), base);
      data = await change(page, () => page.getByRole('button', { name: 'Página siguiente' }).click(), { ...base, page: '2' });
      await assertRendered(page, data, mobile);
      data = await change(page, () => page.getByLabel('Filas por página').selectOption('25'), { ...base, page_size: '25' });
      check(number(data.page) === 1 && data.items.length === 25, 'size resets page atomically');
      await assertRendered(page, data, mobile);
      data = await change(page, () => page.getByLabel('Filas por página').selectOption('50'), { ...base, page_size: '50' });
      await assertRendered(page, data, mobile);
      await change(page, () => page.getByLabel('Filas por página').selectOption('10'), base);
    }
    // Return to assignment; actual styles and dimensions, not a fake sample.
    const assigned = String(accountIndex + 1);
    if (accountIndex !== 2) await change(page, () => mobile ? page.getByLabel('Consultar ubicación').selectOption(assigned) : page.getByRole('button', { name: new RegExp(current.identity.location.name) }).click(), { location_id: assigned, page: '1', page_size: '10' });
    await geometry(page, mobile);
    if (mobile) {
      const zero = page.locator(`.variant[data-variant-id="${runtime.zeroVariant}"]`);
      check(await zero.getByText('Sin disponible', { exact: true }).count() === 1 && !(await zero.textContent()).includes('Sin stock'), 'positive existing + server zero available');
      await page.setViewportSize({ width: 1280, height: 1024 });
      await page.getByRole('table').waitFor(); await geometry(page, false);
      await page.setViewportSize({ width: 390, height: 844 }); await page.locator('.product-card').first().waitFor();
    }
    await page.reload(); await settle(page);
    const reloaded = parse(await (await page.request.get('/api/auth/session')).text());
    check(reloaded.identity.username === account.username && number(reloaded.identity.location.id) === accountIndex + 1, 'session reload from real cookie');
    check(await page.evaluate(() => localStorage.length === 0 && sessionStorage.length === 0), 'no browser credential/token storage');
    const [logout] = await Promise.all([page.waitForResponse(r => new URL(r.url()).pathname === '/api/auth/logout'), page.getByRole('button', { name: 'Cerrar sesión', exact: true }).click()]);
    check(logout.status() === 204, 'real logout only 204');
    await page.getByLabel('Usuario', { exact: true }).waitFor();
    await page.waitForFunction(() => document.activeElement?.id === 'username');
    check(await page.locator('table,.product-card').count() === 0, 'logout clears protected content');
    const anon = parse(await (await page.request.get('/api/auth/session')).text());
    check(anon.authenticated === false && !!anon.csrf_token && !('expires_at' in anon), 'anonymous 200 refresh has CSRF and no expiry');
    check((await page.request.get(urlFor({ location_id: assigned }))).status() === 401, 'revoked browser cannot read inventory');
  });
}

test('real protocol denials and persisted session expiry clear the UI', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1024 }); await page.goto('/');
  const denial = await page.evaluate(async () => {
    const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'unprovisioned-test', password: 'unprovisioned-test-input' }) });
    return response.status;
  });
  check(denial === 403, 'actual missing CSRF denied');
  await login(page, runtime.accounts[0]);
  const metadata = parse(await (await page.request.get('/api/inventory/metadata')).text());
  await page.getByLabel('Buscar marca o modelo').focus();
  await page.keyboard.press('Tab');
  check(await page.getByLabel('Marca', { exact: true }).evaluate(el => document.activeElement === el), 'keyboard reaches brand filter');
  await change(page, () => page.keyboard.press('ArrowDown'), { location_id: '1', page: '1', page_size: '10', brand: metadata.brands[0] });
  check((await page.request.get('/api/inventory?location_id=1&actor_id=2')).status() === 400, 'actor query cannot alter assignment');
  check((await page.request.get('/api/inventory?location_id=1&location_id=2')).status() === 400, 'ambiguous location denied');
  const changed = await fixtureSQL(runtime.fixture, "WITH expired AS (UPDATE auth_sessions SET idle_deadline=now()-interval '1 second' WHERE revoked_at IS NULL RETURNING account_id) SELECT count(*) FROM expired");
  check(Number(changed) >= 1, 'only own TEST persisted sessions expired');
  await page.getByLabel('Buscar marca o modelo').fill('expiry-check');
  await page.getByLabel('Usuario', { exact: true }).waitFor();
  await page.waitForFunction(() => document.activeElement?.id === 'username' && !document.querySelector('button[type=submit]').disabled);
  check(await page.locator('table,.product-card,.identity').count() === 0, 'real 401 removes protected identity/rows');
});
