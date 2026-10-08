import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from './r05-binding.mjs';
import { createR05Lifecycle } from './r05-lifecycle.mjs';

const h = n => n.toString(16).padStart(64, '0');
const clone = value => structuredClone(value);
const deny = fn => assert.throws(fn, /^Error: R05 admission refused\.$/);
function fixture() {
  const root = '/private/fake-r05';
  const labels = { scope: 'transfer-requests/R05', run_id: 'abcdef0123456789' };
  const project = 'luson-r05-'+labels.run_id;
  const config = { services: { app: { depends_on: { db: { condition: 'service_healthy' } } }, db: {} } };
  const file = name => ({ path: root+'/'+name, uid: 1000, mode: 0o600, type: 'file', symlink: false });
  const manifest = { schema: 'luson.r05/v1', phase: 'prepare', run_id: labels.run_id, project, uid: 1000,
    root, manifest: file('manifest'), dsn: file('dsn'), labels,
    sources: [{ ...file('compose'), sha256: h(8) }], config_digest: digest(config),
    network: { name: project+'-net', id: null }, volume: { name: project+'-data', id: null },
    services: {
      app: { id: null, image: h(5), compose_hash: h(7), user: '1000:1000', readonly: true,
        ports: [{ host: '127.0.0.1', published: 9443, target: 8443 }],
        mounts: [{ source: root+'/dsn', target: '/run/secrets/database_url', kind: 'bind', readonly: true }] },
      db: { id: null, image: h(6), compose_hash: h(9), user: '', readonly: false, ports: [],
        mounts: [{ source: project+'-data', target: '/var/lib/postgresql/data', kind: 'volume', readonly: false }] },
    } };
  const snapshot = { sequence: 1, root: { path: root, uid: 1000, mode: 0o700, type: 'directory', symlink: false },
    files: [manifest.manifest, manifest.dsn, ...manifest.sources], sources: manifest.sources,
    config, existing_names: [], network: null, volume: null, project_ids: [], volume_users: [], containers: [] };
  return { manifest, snapshot };
}
const startup = ['createNetwork','createVolume','createDB','startDB','createAPP','startAPP'];
const cleanup = ['stopAPP','stopDB','removeAPP','removeDB','removeVolume','removeNetwork'];
// Fake EFFECT model stays exclusively in tests. Every observation is copied afresh.
function harness() {
  const f = fixture();
  const l = createR05Lifecycle(f);
  let seq = 1;
  const provenance = { root: f.manifest.root, sources: f.manifest.sources.map(s => s.path),
    config_digest: f.manifest.config_digest };
  let s = clone(f.snapshot);
  const fresh = () => ({ ...clone(s), sequence: ++seq });
  function effect(operation) {
    const m = f.manifest;
    let result = null;
    if (operation === 'createNetwork') {
      s.network = { id: h(1), name: m.network.name, labels: m.labels, internal: true,
        driver: 'bridge', members: [], provenance }; result = { id: h(1) };
    } else if (operation === 'createVolume') {
      s.volume = { metadata: { Name: m.volume.name, Driver: 'local', CreatedAt: 'fake-creation-1',
        Options: null, Scope: 'local', Labels: { ...m.labels, project: m.project } }, users: [], provenance };
      result = { Name: m.volume.name };
    } else if (operation === 'createDB' || operation === 'createAPP') {
      const role = operation === 'createDB' ? 'db' : 'app';
      const id = role === 'db' ? h(2) : h(3);
      s.containers.push({ ...clone(m.services[role]), id, service: role, name: m.project+'-'+role+'-1',
        project: m.project, labels: m.labels, network_id: h(1), network_mode: m.network.name,
        state: 'created', provenance }); result = { id };
    } else if (operation === 'removeNetwork') s.network = null;
    else if (operation === 'removeVolume') s.volume = null;
    else {
      const role = operation.endsWith('APP') ? 'app' : 'db';
      if (operation.startsWith('remove')) s.containers = s.containers.filter(c => c.service !== role);
      else s.containers.find(c => c.service === role).state = operation.startsWith('start') ? 'running' : 'exited';
    }
    s.project_ids = s.containers.map(c => c.id);
    s.volume_users = s.containers.filter(c => c.service === 'db').map(c => c.id);
    if (s.volume) s.volume.users = s.volume_users;
    if (s.network) s.network.members = s.containers.filter(c => c.state === 'running').map(c => c.id);
    return result;
  }
  const plan = op => l.plan(op, fresh());
  const receipt = (p, result = effect(p.operation), snap = fresh()) =>
    l.admitReceipt(p.token, { attempt: p.attempt, operation: p.operation, result }, snap);
  const step = op => { const p = plan(op); receipt(p); return p; };
  const boot = (count = startup.length) => startup.slice(0,count).forEach(step);
  const settle = (outcome = 'passed') => l.settle({ checksSettled: true, outcome }, fresh());
  return { f, l, fresh, plan, receipt, step, boot, settle, effect };
}

test('R05a2b2 nominal ordered lifecycle preserves captured history after fresh absence', () => {
  const x = harness();
  assert.equal(x.l.status().phase, 'EMPTY');
  const phases = ['NETWORK','VOLUME','DB_CREATED','DB_RUNNING','APP_CREATED','FULL_ACTIVE'];
  startup.forEach((op, i) => { x.step(op); assert.equal(x.l.status().phase, phases[i]); });
  deny(() => x.plan('stopAPP'));
  x.settle();
  const stopped = ['APP_STOPPED','DB_STOPPED','APP_REMOVED','DB_REMOVED','VOLUME_ABSENT','NETWORK_ABSENT'];
  cleanup.forEach((op, i) => { const p = x.step(op); assert.equal(x.l.status().phase, stopped[i]);
    if (op === 'removeDB') assert.equal(p.target.id, h(2));
    if (op === 'removeVolume') assert.equal(p.target.metadata.CreatedAt, 'fake-creation-1'); });
  assert.equal(x.l.status().identities.db, h(2));
  assert.equal(x.l.status().pending, null);
  deny(() => x.plan('createNetwork'));
});
for (let count = 0; count <= 6; count++) {
  test('R05a2b2 settled failed startup cleans only known subset '+count, () => {
    const x = harness(); x.boot(count); x.settle('failed');
    const expected = cleanup.filter(op => op.endsWith('APP') ? count >= 5
      : op.endsWith('DB') ? count >= 3 : op === 'removeVolume' ? count >= 2 : count >= 1);
    expected.forEach(x.step);
    assert.equal(x.l.status().pending, null);
    assert.equal(x.l.status().phase, 'NETWORK_ABSENT');
    deny(() => x.plan('createNetwork'));
  });
}
test('R05a2b2 plans serialize attempts and reject foreign tokens replay and order', () => {
  const x = harness(); const y = harness();
  deny(() => x.plan('createDB'));
  const p = x.plan('createNetwork'); const q = y.plan('createNetwork');
  deny(() => x.plan('createNetwork'));
  const result = x.effect(p.operation); const s = x.fresh();
  const r = { attempt: p.attempt, operation: p.operation, result };
  deny(() => x.l.admitReceipt(q.token, r, s));
  deny(() => x.l.admitReceipt(p.token, { ...r, attempt: 99 }, s));
  deny(() => x.l.admitReceipt(p.token, { ...r, operation: 'createDB' }, s));
  x.l.admitReceipt(p.token, r, s);
  deny(() => x.l.admitReceipt(p.token, r, x.fresh()));
});
for (const kind of ['missing','wrongID','shortID','extra','stale','incomplete']) {
  test('R05a2b2 creation ambiguity retains pending attempt '+kind, () => {
    const x = harness(); const p = x.plan('createNetwork');
    let result = x.effect(p.operation); const s = x.fresh();
    if (kind === 'missing') result = null;
    if (kind === 'wrongID') result.id = h(99);
    if (kind === 'shortID') result.id = 'abc';
    if (kind === 'extra') result.extra = true;
    if (kind === 'stale') s.sequence = x.l.status().sequence;
    if (kind === 'incomplete') delete s.files;
    deny(() => x.receipt(p, result, s));
    assert.equal(x.l.status().phase, 'EMPTY');
    assert.equal(x.l.status().identities.network, null);
    assert.equal(x.l.status().pending.attempt, p.attempt);
    deny(() => x.plan('createNetwork')); deny(() => x.settle('failed'));
  });
}
const drift = {
  root: s => s.root.mode = 0o755,
  uid: s => s.files[0].uid = 0,
  fileMode: s => s.files[1].mode = 0o644,
  symlink: s => s.root.symlink = true,
  source: s => s.sources[0].sha256 = h(99),
  config: s => s.config.services.db.extra = true,
  collision: s => s.existing_names.push('foreign'),
  projectID: s => s.project_ids.push(h(99)),
  unknownStopped: s => s.containers.push({ id: h(99), state: 'exited' }),
  volumeUser: s => s.volume_users.push(h(99)),
  volumeUsersIndependent: s => s.volume.users.push(h(99)),
  networkMember: s => s.network.members.push(h(99)),
  duplicateMember: s => s.network.members.push(s.network.members[0]),
  labels: s => s.containers[0].labels.run_id = 'foreign',
  name: s => s.containers[0].name = 'foreign',
  image: s => s.containers[0].image = h(99),
  hash: s => s.containers[0].compose_hash = h(99),
  user: s => s.containers[0].user = '999:999',
  mount: s => s.containers[0].mounts[0].source = 'foreign',
  readonly: s => s.containers[1].readonly = false,
  port: s => s.containers[1].ports[0].host = '0.0.0.0',
  declaredNetwork: s => s.containers[0].network_mode = 'foreign',
  attachment: s => s.containers[0].network_id = h(99),
  resourceSource: s => s.containers[0].provenance.sources = ['/foreign'],
  networkRoot: s => s.network.provenance.root = '/foreign',
  volumeCreation: s => s.volume.metadata.CreatedAt = 'fake-replacement',
  volumeDriver: s => s.volume.metadata.Driver = 'foreign',
  volumeOptions: s => s.volume.metadata.Options = { device: 'foreign' },
  volumeScope: s => s.volume.metadata.Scope = 'global',
  volumeLabel: s => s.volume.metadata.Labels.extra = 'foreign',
  missingField: s => delete s.volume_users,
  unknownField: s => s.owned = true,
};
for (const [name, mutate] of Object.entries(drift)) {
  test('R05a2b2 refuse before cleanup and retain IDs on drift '+name, () => {
    const x = harness(); x.boot(); x.settle();
    const s = x.fresh(); mutate(s);
    deny(() => x.l.plan('stopAPP', s));
    assert.equal(x.l.status().pending, null);
    assert.equal(x.l.status().identities.db, h(2));
    x.step('stopAPP');
  });
}
test('R05a2b2 failed cleanup readback retains attempt and removal identity', () => {
  const x = harness(); x.boot(); x.settle();
  x.step('stopAPP'); x.step('stopDB');
  const p = x.plan('removeAPP');
  deny(() => x.receipt(p, null, x.fresh())); // still present: absence not proven
  assert.equal(x.l.status().identities.app, h(3));
  assert.equal(x.l.status().pending.operation, 'removeAPP');
  deny(() => x.plan('removeDB'));
  x.effect('removeAPP'); x.receipt(p, null, x.fresh());
  assert.equal(x.l.status().phase, 'APP_REMOVED');
});
test('R05a2b2 volume Name response needs immediate full metadata readback', () => {
  const x = harness(); x.step('createNetwork'); const p = x.plan('createVolume');
  const r = x.effect(p.operation); const s = x.fresh(); delete s.volume.metadata.CreatedAt;
  deny(() => x.receipt(p, r, s));
  assert.equal(x.l.status().identities.volume, null);
  x.receipt(p, r, x.fresh());
  assert.match(x.l.status().identities.volume.fingerprint, /^[a-f0-9]{64}$/);
});
test('R05a2b2 metadata expectations plans receipts and status have no retained references', () => {
  const x = harness(); x.f.manifest.services.db.user = '999:999';
  x.f.snapshot.root.mode = 0o755;
  x.step('createNetwork'); x.step('createVolume');
  const p = x.plan('createDB'); p.target.specification.user = 'foreign';
  // Fake effect still uses original expected configured default, not mutated caller declaration.
  x.f.manifest.services.db.user = '';
  const r = x.effect('createDB'); const s = x.fresh(); x.receipt(p, r, s);
  r.id = h(99); s.containers[0].user = 'foreign';
  const status = x.l.status(); status.identities.db = h(99);
  assert.equal(x.l.status().identities.db, h(2)); x.step('startDB');
});
test('R05a2b2 getters symbols inherited and sparse input refuse without invoking getters', () => {
  for (const mutate of [
    f => Object.defineProperty(f.snapshot.root, 'mode', { get() { throw new Error('not invoked'); }, enumerable: true }),
    f => f.snapshot.root[Symbol('extra')] = true,
    f => Object.setPrototypeOf(f.snapshot.root, { mode: 0o700 }),
    f => delete f.snapshot.files[0],
  ]) { const f = fixture(); mutate(f); deny(() => createR05Lifecycle(f)); }
  let reads = 0; const f = fixture();
  Object.defineProperty(f.snapshot, 'config', { get() { reads++; return {}; }, enumerable: true });
  deny(() => createR05Lifecycle(f)); assert.equal(reads, 0);
});
for (const name of ['root','file','config','name','ids','user','environment']) {
  test('R05a2b2 empty phase validates complete prepared bindings '+name, () => {
    const f = fixture();
    if (name === 'root') f.snapshot.root.symlink = true;
    if (name === 'file') f.snapshot.files.pop();
    if (name === 'config') f.snapshot.config.services.db.extra = true;
    if (name === 'name') f.snapshot.existing_names.push(f.manifest.network.name);
    if (name === 'ids') f.manifest.network.id = h(1);
    if (name === 'user') f.manifest.services.app.user = '';
    if (name === 'environment') {
      f.snapshot.config.services.db.environment = { PUBLIC_FILE: '/fake/path' };
      f.manifest.config_digest = digest(f.snapshot.config);
    }
    deny(() => createR05Lifecycle(f));
  });
}
for (let count = 0; count <= 6; count++) {
  test('R05a2b2 independent all-state unknown roles deny partial phase '+count, () => {
    const x = harness(); x.boot(count);
    const operation = count < 6 ? startup[count] : 'stopAPP';
    if (count === 6) x.settle();
    for (const mutate of [
      s => s.containers.push({ id: h(99), state: 'exited' }),
      s => s.volume_users.push(h(99)),
      s => s.project_ids.push(h(99)),
      s => s.existing_names.push(x.f.manifest.project+'-app-1'),
      s => s.files[0].symlink = true,
    ]) { const s = x.fresh(); mutate(s); deny(() => x.l.plan(operation, s)); }
    assert.equal(x.l.status().pending, null);
  });
}
for (const [operation, count] of [['createNetwork',0], ['createVolume',1], ['createDB',2], ['createAPP',4]]) {
  test('R05a2b2 creation capture requires exact immediate inspect '+operation, () => {
    const x = harness(); x.boot(count); const p = x.plan(operation);
    const result = x.effect(operation); const s = x.fresh();
    if (operation === 'createNetwork') s.network.name = 'foreign';
    else if (operation === 'createVolume') s.volume.metadata.Labels.project = 'foreign';
    else s.containers.find(c => c.service === (operation === 'createDB' ? 'db' : 'app')).image = h(99);
    deny(() => x.receipt(p, result, s));
    const role = operation === 'createNetwork' ? 'network' : operation === 'createVolume' ? 'volume'
      : operation === 'createDB' ? 'db' : 'app';
    assert.equal(x.l.status().identities[role], null);
    assert.equal(x.l.status().pending.operation, operation);
    x.receipt(p, result, x.fresh());
  });
}
for (const operation of ['removeVolume','removeNetwork']) {
  test('R05a2b2 removal requires fresh absence and retains identity '+operation, () => {
    const x = harness(); x.boot(2); x.settle('failed');
    if (operation === 'removeNetwork') x.step('removeVolume');
    const before = x.l.status().identities;
    const p = x.plan(operation);
    deny(() => x.receipt(p, null, x.fresh()));
    assert.deepEqual(x.l.status().identities, before);
    assert.equal(x.l.status().pending.operation, operation);
    x.effect(operation); x.receipt(p, null, x.fresh());
    assert.deepEqual(x.l.status().identities, before);
  });
}
for (const [operation, count] of [['createNetwork',0], ['createDB',2], ['createAPP',4]]) {
  test('R05a2b2 latch response before failed proof forbids substitution '+operation, () => {
    const x = harness(); x.boot(count); const p = x.plan(operation);
    const result = x.effect(operation); const before = x.l.status();
    const bad = x.fresh(); bad.root.mode = 0o755;
    deny(() => x.receipt(p, result, bad));
    // Independently valid B inspect must not replace the already learned A result.
    const replacement = JSON.parse(JSON.stringify(x.fresh()).replaceAll(result.id, h(99)));
    deny(() => x.receipt(p, { id: h(99) }, replacement));
    const candidate = x.l.status().pending.candidate;
    assert.deepEqual(candidate.result, result);
    candidate.result.id = h(99);
    for (const r of [null, { id: 'short' }, { id: h(99), extra: true }]) {
      deny(() => x.receipt(p, r, x.fresh()));
    }
    deny(() => x.l.admitReceipt({}, { attempt: p.attempt, operation, result: { id: h(99) } }, x.fresh()));
    deny(() => x.l.admitReceipt(p.token, { attempt: p.attempt+1, operation, result: { id: h(99) } }, x.fresh()));
    deny(() => x.l.admitReceipt(p.token, { attempt: p.attempt, operation: 'foreign', result }, x.fresh()));
    assert.deepEqual(x.l.status().identities, before.identities);
    assert.equal(x.l.status().sequence, before.sequence);
    assert.equal(x.l.status().phase, before.phase);
    assert.deepEqual(x.l.status().pending.candidate.result, result);
    const getter = x.fresh(); let reads = 0;
    Object.defineProperty(getter, 'root', { enumerable: true, get() { reads++; return {}; } });
    deny(() => x.receipt(p, result, getter)); assert.equal(reads, 0);
    x.receipt(p, result, x.fresh());
    deny(() => x.receipt(p, result, x.fresh()));
    const z = harness(); z.boot(count); const q = z.plan(operation);
    const zr = z.effect(operation); const zs = z.fresh();
    Object.defineProperty(zs, 'root', { enumerable: true, get() { reads++; return {}; } });
    deny(() => z.receipt(q, zr, zs)); assert.equal(reads, 0);
    assert.deepEqual(z.l.status().pending.candidate.result, zr);
  });
}
test('R05a2b2 volume latch retains Name and full fingerprint before failed proof', () => {
  const x = harness(); x.boot(1); const p = x.plan('createVolume');
  const result = x.effect(p.operation); const before = x.l.status();
  const getter = x.fresh(); let reads = 0;
  Object.defineProperty(getter, 'volume', { enumerable: true, get() { reads++; return {}; } });
  deny(() => x.receipt(p, result, getter)); assert.equal(reads, 0);
  assert.deepEqual(x.l.status().pending.candidate, { result, volume: null });
  const malformed = x.fresh(); malformed.volume.metadata.CreatedAt = null;
  deny(() => x.receipt(p, result, malformed));
  assert.equal(x.l.status().pending.candidate.volume, null);
  const foreign = x.fresh(); foreign.volume.metadata.Labels.project = 'foreign';
  deny(() => x.receipt(p, result, foreign));
  assert.equal(x.l.status().pending.candidate.volume, null);
  const bad = x.fresh(); bad.root.mode = 0o755;
  deny(() => x.receipt(p, result, bad));
  const captured = x.l.status().pending.candidate;
  assert.deepEqual(captured.volume.metadata, bad.volume.metadata);
  assert.equal(captured.volume.fingerprint, digest(bad.volume.metadata));
  bad.volume.metadata.CreatedAt = 'mutated'; captured.volume.metadata.CreatedAt = 'mutated';
  const replacement = x.fresh(); replacement.volume.metadata.CreatedAt = 'replacement';
  deny(() => x.receipt(p, result, replacement));
  deny(() => x.receipt(p, { Name: 'foreign' }, x.fresh()));
  assert.equal(x.l.status().pending.candidate.volume.metadata.CreatedAt, 'fake-creation-1');
  assert.deepEqual(x.l.status().identities, before.identities);
  assert.equal(x.l.status().sequence, before.sequence);
  x.receipt(p, result, x.fresh());
  assert.equal(x.l.status().identities.volume.fingerprint, captured.volume.fingerprint);
});
test('R05a2b2 settlement is explicit factual outcome not resource permission', () => {
  const x = harness();
  deny(() => x.settle());
  deny(() => x.l.settle({ checksSettled: true, outcome: 'failed', maintenance: true }, x.fresh()));
  x.boot(); deny(() => x.plan('removeNetwork')); x.settle(); deny(() => x.settle());
  assert.deepEqual(Object.keys(x.l).sort(), ['admitReceipt','plan','settle','status']);
});
