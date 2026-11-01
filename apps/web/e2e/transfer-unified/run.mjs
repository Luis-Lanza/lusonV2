import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repo = path.resolve(web, '../..');
const require = createRequire(path.join(web, 'package.json'));
const check = (ok, message) => { if (!ok) throw new Error(message); };
const args = process.argv.slice(2);
check(args.length === 2 && args[0] === '--output', 'Usage: node apps/web/e2e/transfer-unified/run.mjs --output odd/verification/transfer-unified-reconciliation/browser-FRESH');
check(/^odd\/verification\/transfer-unified-reconciliation\/browser-[A-Za-z0-9_-]+$/.test(args[1]), 'Output must be a fresh repository-relative browser-* directory');
const output = path.join(repo, args[1]);
// The sole optional short root is the explicitly authorized canonical clone.
// Validate before any writes; sharing a directory name is not clone identity.
const scratchOverride = process.env.LUSON_UNIFIED_BROWSER_SCRATCH_ROOT;
const scratchRoot = scratchOverride === undefined ? repo : scratchOverride;
if (scratchOverride !== undefined) {
  check(scratchRoot === '/home/luis/velay/luson_v2', 'Unauthorized browser scratch root');
  check(await fs.realpath(scratchRoot) === scratchRoot, 'Browser scratch root must be canonical');
  const commonDir = root => execFileSync('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', env: { PATH: process.env.PATH } }).trim();
  check(await fs.realpath(commonDir(scratchRoot)) === await fs.realpath(commonDir(repo)), 'Browser scratch root must share the delivery Git common directory');
}
// Refuse symlink ancestors before creating anything, including the scratch parent.
check(await fs.realpath(repo) === repo, `Repository path contains symlink ancestors: ${repo}`);
let ancestor = repo;
for (const part of args[1].split('/').slice(0, -1)) {
  ancestor = path.join(ancestor, part);
  check((await fs.lstat(ancestor)).isDirectory() && !(await fs.lstat(ancestor)).isSymbolicLink(), `Unsafe output ancestor: ${ancestor}`);
}
await fs.mkdir(output);
for (const name of ['home', 'tmp', 'cache', 'profile', 'dist']) await fs.mkdir(path.join(output, name));
const originalPath = process.env.PATH;
let executable;
for (const name of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']) {
  try { executable = execFileSync('/bin/sh', ['-c', 'command -v "$1"', 'resolve-browser', name], { env: { PATH: originalPath }, encoding: 'utf8' }).trim(); if (executable) break; } catch { /* next normal binary name */ }
}
const load = name => import(pathToFileURL(require.resolve(name)).href);
const result = { status: 'running', kind: 'synthetic UI/request proof, not backend E2E', cases: [], unavailable: ['Backend atomicity, authorization, stock persistence and HTTP integration', 'E10/D9/A8/R1 browser sample; this harness uses coherent E5/A7/credit5', 'Successful durable mutation responses and post-accept accounting'] };
let context;
try {
  const playwright = await load('@playwright/test');
  // Node's CJS import namespace need not expose properties of module.exports.
  const chromium = playwright.chromium ?? playwright.default?.chromium;
  check(typeof chromium?.executablePath === 'function' && typeof chromium?.launchPersistentContext === 'function',
    'Installed Playwright module does not expose the Chromium browser API');
  if (!executable) {
    const candidate = chromium.executablePath(); // API calculation only; no filesystem inspection.
    // Human-approved exception is this executable only, never its cache directory.
    const approvedExternalExecutable = '/home/luis/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
    if (!candidate.startsWith(repo + path.sep) && candidate !== approvedExternalExecutable) {
      result.authorizationRequired = candidate;
      throw new Error(`External cached browser requires parent authorization (not inspected): ${candidate}`);
    }
    executable = candidate;
  }
  result.executable = executable;
  // No inherited credentials or user browser/cache paths. Build state stays under output.
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, { HOME: path.join(output, 'home'), TMPDIR: path.join(output, 'tmp'), XDG_CACHE_HOME: path.join(output, 'cache'), XDG_CONFIG_HOME: path.join(output, 'home'), PATH: originalPath, NODE_ENV: 'production' });
  const [vite, react, tailwind] = await Promise.all([load('vite'), load('@vitejs/plugin-react'), load('@tailwindcss/vite')]);
  await vite.build({ configFile: false, envFile: false, root: web, plugins: [react.default(), tailwind.default()], cacheDir: path.join(output, 'cache/vite'), build: { outDir: path.join(output, 'dist'), emptyOutDir: false, rollupOptions: { input: path.join(web, 'e2e/transfer-unified/index.html') } } });
  const assets = new Map();
  async function collect(dir) { for (const entry of await fs.readdir(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) await collect(file); else { check(entry.isFile(), 'Nonregular built asset'); assets.set('/' + path.relative(path.join(output, 'dist'), file).split(path.sep).join('/'), await fs.readFile(file)); } } }
  await collect(path.join(output, 'dist'));
  // Exclusive short repository-local scratch avoids Chromium's Unix socket path limit.
  // Leave only this owned tree for parent cleanup; never traverse or delete other scratch.
  const scratch = await fs.mkdtemp(path.join(scratchRoot, '.uc-'));
  result.browserScratch = scratch;
  for (const name of ['t', 'p', 'c']) await fs.mkdir(path.join(scratch, name), { mode: 0o700 });
  const browserTmp = path.join(scratch, 't');
  const socketBudgetPath = path.join(browserTmp, 'org.chromium.Chromium.XXXXXXXXXXXX', 'SingletonSocket');
  result.socketPathBudget = { path: socketBudgetPath, bytes: Buffer.byteLength(socketBudgetPath), limit: 107 };
  check(result.socketPathBudget.bytes <= 107, `Chromium socket path budget exceeded: ${socketBudgetPath}`);
  // Record ownership before launch, even if Chromium aborts. No external writable roots.
  await fs.writeFile(path.join(output, 'browser-scratch.json'), JSON.stringify({ scratch, socketPathBudget: result.socketPathBudget }, null, 2));
  process.env.TMPDIR = browserTmp;
  process.env.XDG_CACHE_HOME = path.join(scratch, 'c');
  context = await chromium.launchPersistentContext(path.join(scratch, 'p'), { executablePath: executable, headless: true, serviceWorkers: 'block', acceptDownloads: false, env: { ...process.env }, args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run', `--disk-cache-dir=${path.join(scratch, 'c/chromium')}`] });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    const key = url.pathname === '/' ? '/e2e/transfer-unified/index.html' : url.pathname;
    const bytes = assets.get(key);
    if (url.origin !== 'https://unified.invalid' || route.request().method() !== 'GET' || !bytes) return route.abort('blockedbyclient');
    const type = key.endsWith('.html') ? 'text/html' : key.endsWith('.js') ? 'text/javascript' : key.endsWith('.css') ? 'text/css' : 'application/octet-stream';
    await route.fulfill({ contentType: type, body: bytes });
  });
  for (const actor of [1, 2]) for (const width of [390, 1280]) for (const scene of ['proposal', 'counterpart']) {
    const page = await context.newPage();
    const record = { actor, width, height: width === 390 ? 844 : 1022, scene, assertions: [], errors: [] };
    result.cases.push(record);
    page.on('pageerror', e => record.errors.push(String(e)));
    page.setDefaultTimeout(6000);
    await page.setViewportSize({ width, height: record.height });
    const posts = () => page.evaluate(() => window.__UNIFIED.calls.filter(c => c.method === 'POST'));
    const noPost = async label => { check((await posts()).length === 0, `Unexpected POST: ${label}`); record.assertions.push(label); };
    const open = async () => { await page.getByRole('button', { name: 'Gestiones', exact: true }).click(); check(await page.getByRole('menuitem', { name: 'Resolver diferencia', exact: true }).count() === 1, 'Single unified entry'); for (const name of ['Regularizar despacho', 'Restituir a origen', 'Corregir conteo']) check(await page.getByRole('menuitem', { name, exact: true }).count() === 0, `Legacy entry ${name}`); await page.getByRole('menuitem', { name: 'Resolver diferencia', exact: true }).click(); await page.getByRole('dialog').waitFor(); };
    try {
      await page.goto(`https://unified.invalid/?actor=${actor}&scene=${scene}`);
      await page.getByRole('table', { name: 'Conteo efectivo', exact: true }).waitFor();
      const cells = await page.getByRole('table', { name: 'Conteo efectivo', exact: true }).getByRole('row').nth(1).getByRole('cell').allTextContents();
      check(['5', '7', '5'].every(value => cells.includes(value)), 'E5/A7/credit5 current row');
      await page.getByRole('button', { name: 'Ver historial' }).click();
      await page.getByRole('region', { name: 'Historial de conciliación unificada', exact: true }).waitFor();
      if (scene === 'counterpart') await page.getByRole('heading', { name: 'Pendiente de contraparte', exact: true }).waitFor();
      await noPost('mount and preserved history GET only');
      await page.getByText('Ver recepción original', { exact: true }).click();
      check((await page.getByRole('region', { name: 'Recepción original' }).innerText()).includes('14'), 'Original receipt total14 preserved');
      await open(); await noPost('open GET only');
      const dialog = page.getByRole('dialog');
      check(await page.evaluate(() => document.querySelectorAll('[inert]').length > 0), 'Background inert');
      const enabled = await dialog.locator('button:enabled,input:enabled,select:enabled,textarea:enabled').count();
      for (const key of ['Tab', 'Shift+Tab']) for (let n = 0; n <= enabled; n++) { await page.keyboard.press(key); check(await dialog.evaluate(el => el.contains(document.activeElement)), `Native ${key} containment`); }
      check(await dialog.evaluate(el => el.getBoundingClientRect().left >= 0 && el.getBoundingClientRect().right <= innerWidth && el.scrollWidth <= el.clientWidth + 1), 'Modal horizontal overflow');
      await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
      record.escapeFocus = await page.evaluate(() => ({
        tag: document.activeElement?.tagName,
        text: document.activeElement?.textContent,
        management: document.activeElement === document.querySelector('.received-management > button'),
      }));
      check(record.escapeFocus.management, 'Escape restores Gestiones focus');
      await noPost('native focus and Escape cancel'); await open();
      if (scene === 'proposal') {
        if (actor === 1) {
          await page.getByLabel('Salieron realmente').fill('4'); await page.getByLabel('Llegaron realmente').fill('3');
          await page.getByLabel('Quedaron físicamente en origen').fill('1'); await page.getByLabel('Motivo y evidencia').fill('Synthetic evidence');
          await page.getByRole('button', { name: 'Revisar propuesta', exact: true }).click();
          check(await page.getByRole('region', { name: 'Revisión de conciliación' }).count() === 0, 'Origin positive retention requires attestation');
          await noPost('missing origin attestation rejected');
        }
        for (const [D, A, R, valid] of [['4','3','0',true], ['0','0','0',true], ['7','7','0',true], ['7','7','1',false], ['4','3','1',true]]) {
          await page.getByLabel('Salieron realmente').fill(D); await page.getByLabel('Llegaron realmente').fill(A); await page.getByLabel('Quedaron físicamente en origen').fill(R); await page.getByLabel('Motivo y evidencia').fill('Synthetic evidence');
          if (actor === 1) await page.getByRole('checkbox').check();
          await page.getByRole('button', { name: 'Revisar propuesta', exact: true }).click();
          check(await page.getByRole('region', { name: 'Revisión de conciliación' }).count() === Number(valid), `D${D} A${A} R${R} review validity`);
          await noPost(`edit/review ${D}/${A}/${R}`);
          if (valid) await page.getByRole('button', { name: 'Volver a editar', exact: true }).click();
        }
        await page.getByRole('button', { name: 'Revisar propuesta', exact: true }).click();
      } else {
        await page.getByLabel('Motivo y evidencia').fill('Counterpart evidence');
        if (actor === 1) await page.getByRole('checkbox').check();
        await page.getByRole('button', { name: 'Revisar rechazo', exact: true }).click(); await noPost('counterpart rejection review');
        await page.getByRole('button', { name: 'Volver a editar', exact: true }).click();
        await page.getByRole('button', { name: 'Revisar aceptación', exact: true }).click(); await noPost('counterpart acceptance review');
      }
      await page.getByRole('button', { name: /^Confirmar / }).click();
      await page.getByRole('heading', { name: 'Resultado incierto', exact: true }).waitFor();
      check((await posts()).length === 1, 'One explicit confirm POST');
      await page.getByRole('button', { name: 'Consultar operación', exact: true }).click();
      await page.getByRole('button', { name: 'Consultar operación', exact: true }).waitFor({ state: 'visible' });
      check((await posts()).length === 1, 'Recovery GET never reposts');
      await page.getByRole('button', { name: 'Reintentar exactamente la misma operación', exact: true }).click();
      await page.waitForFunction(() => window.__UNIFIED.calls.filter(c => c.method === 'POST').length === 2);
      const writes = await posts(); check(writes[0].body === writes[1].body && writes[0].path === writes[1].path, 'Exact retry payload/key');
      await page.evaluate(() => window.__UNIFIED.switchAuthority());
      await page.getByText('Verificando acceso a transferencias…', { exact: true }).waitFor();
      check((await posts()).length === 2, 'Authority switch does not POST');
      check(!(await page.evaluate(() => window.__UNIFIED.failures)).length && !record.errors.length, 'No unrecognized transport or page errors');
      record.assertions.push('explicit confirm; uncertain reply; GET recovery; exact explicit retry; authority masking');
    } finally { record.transport = await page.evaluate(() => window.__UNIFIED?.calls); await page.close(); }
  }
  result.status = 'passed';
} catch (error) {
  result.status = 'failed'; result.error = error.stack ?? String(error);
  console.error(result.error); // Authorization path must be visible without opening result.json.
  process.exitCode = 1;
}
finally { if (context) await context.close(); await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2)); }
