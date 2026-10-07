// AUTHOR-ONLY for bounded writer. Execute only through the external verifier.
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { readFile, writeFile, mkdtemp, chmod, mkdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { request } from 'node:https';
import { OwnedCompose } from './l05-owned-compose.mjs';
import { PrivateNSS } from './l05-nss.mjs';
import { PROJECT, NETWORK_NAME, VOLUME_NAME, LABELS } from './l05-binding.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, '..');
const root = await realpath(resolve(web, '../..'));
const chrome = '/home/luis/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const children = new Set();
const groups = new Set();
const pause = ms => new Promise(done => setTimeout(done, ms));
const token = () => randomBytes(24).toString('hex');
const check = (condition, label) => { if (!condition) throw new Error(label); };
let temp, owner, env, ca, origin, nssTool;
let cancelled = false;
let cleaning = false;
let stage = 'explicit binding';
let passed = false;

function alive(pid) {
  try { process.kill(-pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw new Error('Owned group inspection failed.'); }
}
async function stop(child) {
  if (!child?.pid) return;
  if (alive(child.pid)) process.kill(-child.pid, 'SIGTERM');
  for (let i = 0; i < 100 && alive(child.pid); i++) await pause(50);
  if (alive(child.pid)) process.kill(-child.pid, 'SIGKILL');
  for (let i = 0; i < 100 && alive(child.pid); i++) await pause(50);
  check(!alive(child.pid), 'Owned child did not stop.');
}
async function command(binary, args, options = {}) {
  if (cancelled && !cleaning) throw new Error('Verification interrupted.');
  const { timeout = 30000, input, privateInput, ...spawnOptions } = options;
  const child = spawn(binary, args, { cwd: root, env: env ?? process.env, detached: true,
    stdio: ['pipe','pipe','pipe', ...(privateInput === undefined ? [] : ['pipe'])], ...spawnOptions });
  children.add(child);
  if (child.pid) groups.add(child.pid);
  let output = '';
  let oversized = false;
  child.stdout.on('data', data => { if (output.length + data.length <= 2<<20) output += data.toString(); else oversized = true; });
  child.stderr.resume(); // never dump Docker/config/SQL/PTY/browser diagnostics
  child.stdin.on('error', () => {});
  child.stdin.end(input ?? '');
  if (privateInput !== undefined) { child.stdio[3].on('error', () => {}); child.stdio[3].end(JSON.stringify(privateInput)); }
  return new Promise((done, reject) => {
    let finished = false;
    const finish = async (code, timedOut = false) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { await stop(child); }
      catch { code = 1; }
      children.delete(child);
      if (child.pid && !alive(child.pid)) groups.delete(child.pid);
      if (code !== 0 || oversized || timedOut) reject(new Error('Bounded private verification command failed.'));
      else done(output.trim());
    };
    const timer = setTimeout(() => { void finish(1, true); }, timeout);
    child.once('error', () => { void finish(1); });
    child.once('close', code => { void finish(code); });
  });
}
async function privateFile(name, contents) {
  const path = join(temp, name);
  await writeFile(path, contents, { flag: 'wx', mode: 0o600 });
  return path;
}
async function freePort() {
  const server = createServer();
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const selected = server.address().port;
  await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
  check(selected > 0 && selected <= 65535, 'Nonzero loopback port required.');
  return selected;
}
async function tlsGet(path) {
  return new Promise((done, reject) => {
    const req = request(origin+path, { ca, minVersion: 'TLSv1.2', timeout: 2000 }, res => {
      const protocol = res.socket.getProtocol();
      res.resume();
      res.once('end', () => done({ status: res.statusCode, protocol }));
    });
    req.once('timeout', () => req.destroy());
    req.once('error', () => reject(new Error('Trusted TLS request unavailable.')));
    req.end();
  });
}
async function readiness() {
  for (let i = 0; i < 100 && !cancelled; i++) {
    await owner.guard('db');
    const db = await owner.inspect('db');
    if (db.State?.Health?.Status === 'healthy') return;
    check(db.State?.Status !== 'exited', 'Owned database exited.');
    await pause(250);
  }
  throw new Error('Bounded PostgreSQL health readiness failed.');
}
async function appReady() {
  for (let i = 0; i < 120 && !cancelled; i++) {
    await owner.guard('app');
    const app = await owner.inspect('app');
    check(app.State?.Status !== 'exited', 'Owned application exited.');
    try {
      const result = await tlsGet('/api/auth/session');
      if (result.status === 200) {
        check(['TLSv1.2','TLSv1.3'].includes(result.protocol), 'TLS 1.2 or newer required.');
        const bindings = app.HostConfig.PortBindings;
        check(Object.keys(bindings).length === 1 && bindings['8443/tcp']?.length === 1
          && bindings['8443/tcp'][0].HostIp === '127.0.0.1' && Number(bindings['8443/tcp'][0].HostPort) === Number(new URL(origin).port), 'Loopback-only publication required.');
        return;
      }
    } catch { /* bounded startup wait; do not disclose errors or response contents */ }
    await pause(250);
  }
  throw new Error('Bounded trusted HTTPS readiness failed.');
}
async function bootstrap(accounts, mode) {
  await owner.guard('app');
  await command('python3', [join(here,'l05-bootstrap-pty.py'), owner.owned.get('app'), mode], { privateInput: accounts, timeout: 70000 });
}
// Each ordered table snapshot is private; emit neither raw rows nor hashes.
const snapshotQuery = `SELECT json_build_object(
 'accounts',(SELECT json_agg(t ORDER BY location_id) FROM auth_accounts t),
 'sessions',(SELECT json_agg(t ORDER BY token_hash) FROM auth_sessions t),
 'locations',(SELECT json_agg(t ORDER BY id) FROM locations t),
 'catalog',(SELECT json_agg(t ORDER BY id) FROM catalog_entries t),
 'variants',(SELECT json_agg(t ORDER BY id) FROM catalog_variants t),
 'balances',(SELECT json_agg(t ORDER BY location_id,variant_id) FROM inventory_balances t),
 'provenance',(SELECT json_agg(t ORDER BY id) FROM initialization_metadata t),
 'migrations',(SELECT json_agg(t ORDER BY version) FROM schema_migrations t));`;
const snapshot = async () => createHash('sha256').update(await owner.sql(snapshotQuery)).digest('hex');
async function browser(phase, contextPath) {
  await owner.guard('app');
  const configPath = await privateFile('playwright-'+phase+'.mjs', 'export default '+JSON.stringify({
    testDir: here, testMatch: 'l05-compose.spec.mjs', workers: 1, fullyParallel: false, retries: 0,
    timeout: 180000, expect: { timeout: 10000 }, outputDir: join(temp, 'results-'+phase),
    reporter: [[join(temp, 'safe-reporter.mjs')]],
    use: { baseURL: origin, headless: true, ignoreHTTPSErrors: false, trace: 'off', video: 'off', screenshot: 'off',
      launchOptions: { executablePath: chrome } },
  })+';\n');
  const result = await command(process.execPath, [join(web,'node_modules/@playwright/test/cli.js'), 'test', '--config', configPath], {
    env: { ...env, HOME: join(temp,'home'), XDG_CONFIG_HOME: join(temp,'home/config'), NODE_EXTRA_CA_CERTS: join(temp,'ca.crt'),
      LUSON_L05_CONTEXT: contextPath, LUSON_L05_PHASE: phase, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' }, timeout: 600000,
  });
  // Reporter is unchanged and emits only numeric outcomes. Never print arbitrary
  // captured output: enforce successful counts, no skipped or unexpected tests.
  check(result === `L05_BROWSER passed=${phase === 'initial' ? 3 : 1} failed=0 skipped=0`, 'Browser reporter requires all expected checks, zero failures/skips.');
}
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => {
  cancelled = true;
  for (const child of children) if (child.pid) { try { process.kill(-child.pid,'SIGTERM'); } catch { /* already reaped */ } }
});

try {
  const binding = process.env.LUSON_TEST_COMPOSE_MANIFEST;
  check(typeof binding === 'string' && binding.trim(), 'Explicit parent manifest required.');
  const manifestPath = isAbsolute(binding) ? binding : resolve(root,binding);
  // No private artifacts or effects until the parent network+volume+empty
  // project/volume attachments have actually been freshly inspected.
  owner = new OwnedCompose({ command, manifestPath, composePath: join(root,'compose.yaml'), overridePath: '', env: process.env });
  await owner.fresh();
  stage = 'cached verifier prerequisites';
  check(process.getuid() === 1000 && process.getgid() === 1000, 'Host private-file UID/GID must match explicit app identity.');
  const pw = JSON.parse(await readFile(join(web,'node_modules/@playwright/test/package.json'), 'utf8'));
  check(pw.version === '1.62.1', 'Pinned Playwright required.');
  check(/\b151\./.test(await command(chrome,['--version'])), 'Cached Chrome 151 required.');
  await command('openssl',['version']);
  process.umask(0o077);
  temp = await mkdtemp(join(resolve(tmpdir()), 'luson-l05-'));
  await chmod(temp,0o700);
  await mkdir(join(temp,'home/.pki/nssdb'), { recursive: true, mode: 0o700 });
  stage = 'private TEST file secrets and trusted TLS';
  const password = token();
  const passwordPath = await privateFile('database-password', password+'\n');
  const urlPath = await privateFile('database-url', `postgres://luson:${password}@db:5432/luson?sslmode=disable\n`);
  const extensions = await privateFile('tls-extensions', 'subjectAltName=IP:127.0.0.1,DNS:localhost\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n');
  await command('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-sha256','-days','1','-subj','/CN=Luson owned TEST CA', '-addext','basicConstraints=critical,CA:TRUE','-keyout',join(temp,'ca.key'),'-out',join(temp,'ca.crt')]);
  await command('openssl',['req','-new','-newkey','rsa:2048','-nodes','-subj','/CN=localhost','-keyout',join(temp,'tls.key'),'-out',join(temp,'tls.csr')]);
  await command('openssl',['x509','-req','-in',join(temp,'tls.csr'),'-CA',join(temp,'ca.crt'),'-CAkey',join(temp,'ca.key'),'-set_serial','2','-days','1','-sha256','-extfile',extensions,'-out',join(temp,'tls.crt')]);
  for (const name of ['ca.key','ca.crt','tls.key','tls.crt','tls.csr']) await chmod(join(temp,name),0o600);
  ca = await readFile(join(temp,'ca.crt'));
  stage = 'isolated project NSS tool and private CA import';
  nssTool = new PrivateNSS({ owner, root: temp, dockerfilePath: join(here,'l05-nss.Dockerfile') });
  try { await nssTool.build(); await nssTool.create(); await nssTool.start(); }
  finally { await nssTool.cleanup(); }
  nssTool = undefined; // Exact namespace verified empty before any app/db creation.
  const selected = await freePort();
  origin = 'https://127.0.0.1:'+selected;
  env = { PATH: process.env.PATH, HOME: join(temp,'home'), TMPDIR: temp,
    LUSON_TEST_COMPOSE_MANIFEST: manifestPath, LUSON_PROFILE: 'local-trial', LUSON_APP_UID: '1000', LUSON_APP_GID: '1000',
    LUSON_DB_PASSWORD_FILE: passwordPath, LUSON_DATABASE_URL_FILE: urlPath, LUSON_TLS_CERT_FILE: join(temp,'tls.crt'), LUSON_TLS_KEY_FILE: join(temp,'tls.key'),
    LUSON_ORIGIN: origin, LUSON_HTTPS_PORT: String(selected), COMPOSE_DISABLE_ENV_FILE: '1' };
  // Do not inherit a generated-test environment DSN or implicit Compose files.
  for (const key of ['LUSON_DATABASE_URL','COMPOSE_FILE','COMPOSE_PROJECT_NAME','COMPOSE_PROFILES','COMPOSE_ENV_FILES']) delete env[key];
  const overridePath = await privateFile('compose-override.json', JSON.stringify({
    services: { app: { image: PROJECT+':candidate', labels: LABELS }, db: { labels: LABELS } },
    networks: { luson: { external: true, name: NETWORK_NAME } }, volumes: { pgdata: { external: true, name: VOLUME_NAME } },
  }));
  owner = new OwnedCompose({ command, manifestPath, composePath: join(root,'compose.yaml'), overridePath, env, statePath: join(temp,'owned-state.json') });
  stage = 'one project image build';
  await owner.configure(); await owner.build();
  stage = 'exact two-service TEST runtime';
  await owner.create('db'); await readiness();
  await owner.create('app'); await appReady();
  stage = 'private nine-input bootstrap and initial data';
  const accounts = Array.from({ length: 3 }, (_, i) => ({ username: `l05_${i+1}_${token().slice(0,16)}`, password: token() }));
  await bootstrap(accounts,'initial');
  check(await owner.sql("SELECT (SELECT count(*) FROM catalog_entries)||':'||(SELECT count(*) FROM catalog_variants)||':'||count(*)||':'||count(*) FILTER (WHERE reserved=0) FROM inventory_balances;") === '95:190:570:570', 'Initial real catalog/balance contract.');
  check(await owner.sql("SELECT stock_origin FROM initialization_metadata;") === 'fictional-local-trial-v1', 'Explicit fictional provenance.');
  check(await owner.sql('SELECT count(*) FROM schema_migrations;') === '2', 'Both migration checksums tracked.');
  await privateFile('safe-reporter.mjs', `export default class {
  passed=0; failed=0; skipped=0;
  onTestEnd(_test,result) {
    if(result.status==='passed') this.passed++;
    else if(result.status==='skipped') this.skipped++;
    else this.failed++;
  }
  onEnd(result) {
    if(result.status!=='passed' && this.failed===0) this.failed++;
    console.log('L05_BROWSER passed='+this.passed+' failed='+this.failed+' skipped='+this.skipped);
  }
  printsToStdio(){return true;}
}\n`);
  const contextPath = await privateFile('context.json',JSON.stringify({ origin, accounts, manifestPath, composePath: join(root,'compose.yaml'), overridePath,
    statePath: join(temp,'owned-state.json'), env, cookiePath: join(temp,'persisted-cookie.json') }));
  stage = 'same-origin real HTTPS browser initial phase';
  await browser('initial',contextPath);
  stage = 'own TEST mutation and exact ordinary recreation';
  check(await owner.sql('WITH changed AS (UPDATE inventory_balances SET existing=existing+1 WHERE location_id=1 AND variant_id=1 RETURNING existing) SELECT count(*) FROM changed;') === '1', 'Exactly one own TEST balance mutation.');
  const before = await snapshot();
  const oldIDs = new Map(owner.owned);
  await owner.remove('app'); await owner.remove('db');
  await owner.create('db'); await readiness(); await owner.create('app'); await appReady();
  check(['app','db'].every(service => owner.owned.get(service) !== oldIDs.get(service)), 'New full container IDs required.');
  check(await snapshot() === before, 'Accounts/sessions/catalog/provenance/quantities/migration checksums survive.');
  stage = 'bootstrap replay refusal without reset';
  await bootstrap(accounts,'replay');
  check(await snapshot() === before, 'Private replay preserves all durable state.');
  stage = 'persisted cookie plus isolated expiry browser phase';
  await browser('persisted',contextPath);
  passed = true;
} catch {
  console.error('L05 verifier failed at: '+stage+'. No PASS credited.');
} finally {
  cleaning = true;
  let clean = true;
  for (const child of [...children]) { try { await stop(child); } catch { clean = false; } }
  for (const pid of [...groups]) { try { await stop({ pid }); } catch { clean = false; } }
  if (nssTool) { try { await nssTool.cleanup(); } catch { clean = false; } }
  if (owner) { try { await owner.cleanup(); } catch { clean = false; } }
  if (clean && temp) {
    try {
      check(await realpath(temp) === temp && temp.startsWith(resolve(tmpdir())+'/luson-l05-'), 'Exact private directory ownership.');
      await rm(temp,{ recursive: true });
    } catch { clean = false; }
  }
  if (!clean) {
    passed = false;
    console.error('L05 exact cleanup incomplete; parent inspection required. Parent network/volume remain untouched.');
  } else console.log('L05 cleanup: own containers/processes/private files removed; exact parent network empty, volume preserved.');
}
if (passed) console.log('L05 runtime PASS: real HTTPS browser, two services and durable recreation; not operational acceptance.');
process.exitCode = passed ? 0 : 1;
