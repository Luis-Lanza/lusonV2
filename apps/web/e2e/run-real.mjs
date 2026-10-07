// Execution belongs ONLY to the parent-delegated external-runtime verifier.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdtemp, chmod, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { LABELS, NETWORK_ID, NETWORK_NAME, validateBinding, manifestPath, parseDescriptor } from './binding.mjs';
import { fixtureSQL, inspectOwned } from './owned-pg.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, '..');
const root = await realpath(resolve(web, '../..'));
const children = new Set();
const groups = new Set();
function groupAlive(pid) {
  try { process.kill(-pid, 0); return true; } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw new Error('Owned process-group inspection failed.');
  }
}
let temp;
let fixture;
let pendingName;
let cidfile;
let stage = 'network binding';
let cancelled = false;
const token = () => randomBytes(12).toString('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function child(command, args, options = {}) {
  if (cancelled) throw new Error('Fixture cancelled.');
  const processChild = spawn(command, args, { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'], ...options });
  children.add(processChild);
  if (processChild.pid) groups.add(processChild.pid);
  processChild.once('exit', () => {
    // These groups were created by this runner; do not target arbitrary processes.
    // Reap descendants (notably a browser) even if its CLI has already exited.
    try { process.kill(-processChild.pid, 'SIGTERM'); } catch { /* group already gone */ }
    try { if (processChild.pid && !groupAlive(processChild.pid)) groups.delete(processChild.pid); } catch { /* retained for strict cleanup */ }
    children.delete(processChild);
  });
  processChild.once('error', () => children.delete(processChild));
  return processChild;
}
async function stop(processChild) {
  if (!processChild || processChild.exitCode !== null || processChild.signalCode !== null) return;
  try { process.kill(-processChild.pid, 'SIGTERM'); } catch { processChild.kill('SIGTERM'); }
  for (let n = 0; n < 200 && processChild.exitCode === null && processChild.signalCode === null; n++) await pause(50);
  if (processChild.exitCode === null && processChild.signalCode === null) {
    try { process.kill(-processChild.pid, 'SIGKILL'); } catch { processChild.kill('SIGKILL'); }
    for (let n = 0; n < 100 && processChild.exitCode === null && processChild.signalCode === null; n++) await pause(50);
    if (processChild.exitCode === null && processChild.signalCode === null) throw new Error('Owned process did not reap.');
  }
}
async function execute(command, args, options = {}, timeout = 30000, privateInput) {
  const processChild = child(command, args, options);
  let output = '';
  processChild.stdout?.on('data', bytes => { if (output.length < 1048576) output += bytes.toString(); });
  // Always consume and suppress error output, even for nonsecret commands.
  processChild.stderr?.resume();
  if (privateInput !== undefined) processChild.stdio[3].end(JSON.stringify(privateInput));
  return await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => { void stop(processChild).finally(() => reject(new Error('Bounded fixture command timed out.'))); }, timeout);
    processChild.once('error', () => { clearTimeout(timer); reject(new Error('Fixture command unavailable.')); });
    processChild.once('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error('Fixture command failed.'));
      else resolvePromise(output.trim());
    });
  });
}
async function boundNetwork() {
  // Reload descriptor and inspect Docker every time. Relative paths resolve from
  // canonical repository root, never caller cwd. No defaults or retired binding.
  const env = process.env;
  if (env.LUSON_TEST_NETWORK !== NETWORK_NAME || !env.LUSON_TEST_NETWORK_MANIFEST) throw new Error('Both L04 bindings required.');
  const path = manifestPath(root, env.LUSON_TEST_NETWORK_MANIFEST);
  const descriptor = parseDescriptor(await readFile(path, 'utf8'));
  const inspected = JSON.parse(await execute('docker', ['network', 'inspect', NETWORK_ID]));
  if (!Array.isArray(inspected) || inspected.length !== 1) throw new Error('Network inspection refused.');
  validateBinding(env, descriptor, inspected[0]);
  return inspected[0];
}
async function port() {
  const socket = createServer();
  await new Promise((resolvePromise, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolvePromise); });
  const selected = socket.address().port;
  await new Promise((resolvePromise, reject) => socket.close(error => error ? reject(error) : resolvePromise()));
  if (!selected) throw new Error('Nonzero loopback port required.');
  return selected;
}
async function ready(url, processChild, milliseconds = 15000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline && !cancelled) {
    if (processChild.exitCode !== null || processChild.signalCode !== null) return false;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.status === 200) { await response.body?.cancel(); return true; }
      await response.body?.cancel();
    } catch { /* startup is bounded; no request URLs or private response logs */ }
    await pause(100);
  }
  return false;
}
async function startPair(databaseURL) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const apiPort = await port();
    const webPort = await port();
    if (apiPort === webPort) continue;
    const origin = `http://127.0.0.1:${webPort}`;
    const apiOrigin = `http://127.0.0.1:${apiPort}`;
    const server = child(join(temp, 'server'), [], { env: {
      ...process.env, LUSON_DATABASE_URL: databaseURL, LUSON_PROFILE: 'local-trial',
      LUSON_ORIGIN: origin, LUSON_LISTEN: `127.0.0.1:${apiPort}`, LUSON_TLS_CERT: '', LUSON_TLS_KEY: '',
    } });
    server.stdout.resume(); server.stderr.resume();
    // Initialization must complete BEFORE private account bootstrap.
    if (!await ready(apiOrigin + '/api/auth/session', server, 40000)) { await stop(server); continue; }
    const vite = child(process.execPath, [join(here, 'serve-vite.mjs')], { env: {
      ...process.env, LUSON_E2E_WEB_PORT: String(webPort), LUSON_E2E_API_URL: apiOrigin, LUSON_E2E_TEMP: temp,
    } });
    vite.stdout.resume(); vite.stderr.resume();
    if (await ready(origin, vite)) return { origin, server, vite };
    await stop(vite); await stop(server);
  }
  throw new Error('Loopback server readiness failed after bounded retries.');
}
async function recoverPendingFixture() {
  if (fixture || !pendingName || !cidfile) return;
  try {
    const id = (await readFile(cidfile, 'utf8')).trim();
    await inspectOwned(id, pendingName);
    fixture = { id, name: pendingName };
  } catch {
    // A cidfile can be absent on interrupted docker run. Resolve ONLY the exact
    // fresh random name, then require full-ID and the four ownership labels.
    const id = await execute('docker', ['inspect', '--type=container', '--format', '{{.Id}}', pendingName]).catch(() => '');
    if (id) { await inspectOwned(id, pendingName); fixture = { id, name: pendingName }; }
  }
}
async function cleanup() {
  // Signals prevent new fixture starts but permit these exact owned cleanup calls.
  cancelled = false;
  const failures = [];
  for (const processChild of [...children]) { try { await stop(processChild); } catch { failures.push('process'); } }
  for (const pid of [...groups]) {
    try {
      if (groupAlive(pid)) process.kill(-pid, 'SIGTERM');
      for (let n = 0; n < 200 && groupAlive(pid); n++) await pause(50);
      if (groupAlive(pid)) process.kill(-pid, 'SIGKILL');
      for (let n = 0; n < 100 && groupAlive(pid); n++) await pause(50);
      if (groupAlive(pid)) throw new Error('Owned group remains.');
      groups.delete(pid);
    } catch { failures.push('process group'); }
  }
  try { await recoverPendingFixture(); } catch { failures.push('container recovery'); }
  if (fixture) {
    try {
      await inspectOwned(fixture.id, fixture.name);
      await execute('docker', ['stop', '--time', '5', fixture.id]);
      await inspectOwned(fixture.id, fixture.name);
      await execute('docker', ['rm', fixture.id]);
      const remaining = await execute('docker', ['ps', '-aq', '--filter', `name=^/${fixture.name}$`]);
      if (remaining) throw new Error('Owned fixture remains.');
    } catch { failures.push('container'); }
  }
  try { await boundNetwork(); } catch { failures.push('parent network binding/emptiness'); }
  if (temp) {
    try {
      const actual = await realpath(temp);
      if (actual !== temp || !temp.startsWith(resolve(tmpdir()) + '/luson-l04-')) throw new Error('Private directory ownership refused.');
      await rm(temp, { recursive: true });
    } catch { failures.push('private directory'); }
  }
  if (failures.length) throw new Error('Strict cleanup incomplete.');
  console.log('Cleanup: own processes/container/private files removed; parent network exactly bound and empty.');
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  cancelled = true;
  for (const processChild of children) {
    try { process.kill(-processChild.pid, 'SIGTERM'); } catch { processChild.kill('SIGTERM'); }
  }
});

let passed = false;
try {
  await boundNetwork();
  stage = 'cached runtime preflight';
  const playwright = JSON.parse(await readFile(join(web, 'node_modules/@playwright/test/package.json'), 'utf8'));
  if (playwright.version !== '1.62.1') throw new Error('Pinned Playwright runtime required.');
  const chrome = await execute('/home/luis/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome', ['--version']);
  if (!/\b151\./.test(chrome)) throw new Error('Cached Chrome 151 required.');
  process.umask(0o077);
  temp = await mkdtemp(join(resolve(tmpdir()), 'luson-l04-'));
  await chmod(temp, 0o700);
  stage = 'unchanged Go binary build';
  // Offline dependency resolution; private compilation cache and binaries.
  const moduleCache = await execute('go', ['env', 'GOMODCACHE'], { cwd: resolve(root, 'apps/api') });
  const goEnv = { ...process.env, GOCACHE: join(temp, 'go-cache'), GOTMPDIR: temp, GOMODCACHE: moduleCache, GOPROXY: 'off', GOTOOLCHAIN: 'local', GOFLAGS: '-mod=readonly' };
  for (const binary of ['server', 'bootstrap-accounts']) {
    await execute('go', ['build', '-o', join(temp, binary), `./cmd/${binary}`], { cwd: resolve(root, 'apps/api'), env: goEnv }, 180000);
  }
  stage = 'fresh TEST PostgreSQL creation';
  const password = randomBytes(32).toString('hex');
  pendingName = 'luson-l04-pg-' + token();
  cidfile = join(temp, 'pg.cid');
  // Fresh manifest + inspection immediately BEFORE this one own creation.
  await boundNetwork();
  const id = await execute('docker', ['run', '-d', '--cidfile', cidfile, '--name', pendingName,
    '--network', NETWORK_ID, ...Object.entries(LABELS).flatMap(([key, value]) => ['--label', `${key}=${value}`]),
    '--tmpfs', '/var/lib/postgresql/data:rw', '-p', '127.0.0.1::5432',
    '-e', 'POSTGRES_USER=luson_l04', '-e', 'POSTGRES_DB=luson_l04', '-e', 'POSTGRES_PASSWORD', 'postgres:17.9'],
    { env: { ...process.env, POSTGRES_PASSWORD: password } }, 60000);
  fixture = { id, name: pendingName };
  await inspectOwned(fixture.id, fixture.name);
  const mapped = await execute('docker', ['port', fixture.id, '5432/tcp']);
  const match = /^127\.0\.0\.1:(\d+)$/.exec(mapped);
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535) throw new Error('Private PostgreSQL port refused.');
  const databaseURL = `postgres://luson_l04:${password}@127.0.0.1:${match[1]}/luson_l04?sslmode=disable`;
  stage = 'TEST PostgreSQL readiness';
  let pgReady = false;
  for (let attempt = 0; attempt < 100 && !cancelled; attempt++) {
    await inspectOwned(fixture.id, fixture.name);
    try { await execute('docker', ['exec', fixture.id, 'pg_isready', '-U', 'luson_l04', '-d', 'luson_l04'], {}, 2000); pgReady = true; break; } catch { await pause(100); }
  }
  if (!pgReady) throw new Error('PostgreSQL readiness failed.');
  stage = 'Go initialization and Vite readiness';
  const pair = await startPair(databaseURL);
  stage = 'private controlling-PTY bootstrap';
  const accounts = Array.from({ length: 3 }, (_, index) => ({ username: `l04_${index + 1}_${token()}`, password: randomBytes(24).toString('hex') }));
  await execute('python3', [join(here, 'bootstrap-pty.py'), join(temp, 'bootstrap-accounts')], {
    env: { ...process.env, LUSON_DATABASE_URL: databaseURL, LUSON_PROFILE: 'local-trial' },
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  }, 70000, accounts);
  stage = 'isolated fixture invariants';
  const seeded = await fixtureSQL(fixture, "SELECT count(*) || ':' || count(*) FILTER (WHERE reserved=0) FROM inventory_balances");
  if (seeded !== '570:570') throw new Error('Trial reservation baseline mismatch.');
  // ONE balance in this new TEST database only. No API writes, holds or transfer
  // state: verify server available=0 with existing>0 is not labeled Sin stock.
  const changed = await fixtureSQL(fixture, 'WITH chosen AS (SELECT location_id,variant_id FROM inventory_balances WHERE location_id=1 AND existing>0 ORDER BY variant_id LIMIT 1), updated AS (UPDATE inventory_balances b SET reserved=b.existing FROM chosen c WHERE b.location_id=c.location_id AND b.variant_id=c.variant_id RETURNING b.variant_id) SELECT variant_id FROM updated');
  if (!/^\d+$/.test(changed)) throw new Error('Zero-availability TEST case setup failed.');
  const contextPath = join(temp, 'context.json');
  await writeFile(contextPath, JSON.stringify({ origin: pair.origin, accounts, fixture, zeroVariant: Number(changed) }), { mode: 0o600, flag: 'wx' });
  const configPath = join(temp, 'playwright.config.mjs');
  const config = {
    testDir: here, testMatch: 'real.spec.mjs', workers: 1, fullyParallel: false, retries: 0,
    timeout: 180000, expect: { timeout: 10000 }, outputDir: join(temp, 'results'),
    reporter: [[join(here, 'reporter.mjs')]],
    use: { baseURL: pair.origin, headless: true, trace: 'off', video: 'off', screenshot: 'off',
      launchOptions: { executablePath: '/home/luis/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome' } },
  };
  await writeFile(configPath, 'export default ' + JSON.stringify(config) + ';\n', { mode: 0o600, flag: 'wx' });
  stage = 'real Go/PostgreSQL browser assertions';
  const result = await execute(process.execPath, [join(web, 'node_modules/@playwright/test/cli.js'), 'test', '--config', configPath], {
    env: { ...process.env, LUSON_E2E_CONTEXT_PATH: contextPath, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' },
  }, 600000);
  console.log(result);
  passed = true;
} catch {
  // Stage names are fixed nonsecret text; never dump child output or Error data.
  console.error(`Real fixture failed at: ${stage}. No PASS credited.`);
} finally {
  try { await cleanup(); } catch {
    passed = false;
    console.error('Strict fixture cleanup failed. Parent inspection required; network was not removed.');
    if (pendingName) console.error(`Owned TEST fixture name for inspection: ${pendingName}`);
  }
}
process.exitCode = passed ? 0 : 1;
