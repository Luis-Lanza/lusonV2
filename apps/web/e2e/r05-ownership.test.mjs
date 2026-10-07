import test from 'node:test';
import assert from 'node:assert/strict';
import { digest, admit } from './r05-binding.mjs';
import { R05OwnedCompose } from './r05-owned-compose.mjs';
const h = n => n.toString(16).padStart(64, '0');
const copy = x => structuredClone(x);
function fixture(phase = 'active') {
  const root = '/private/r05-fixture';
  const labels = { scope: 'transfer-requests/R05', run_id: 'abcdef0123456789' };
  const config = { services: { app: { depends_on: { db: { condition: 'service_healthy' } } }, db: {} } };
  const file = name => ({ path: root+'/'+name, uid: 1000, mode: 0o600, type: 'file', symlink: false });
  const mount = (source, target, kind = 'bind', readonly = true) => ({ source, target, kind, readonly });
  const manifest = { schema: 'luson.r05/v1', phase, run_id: labels.run_id, project: 'luson-r05-'+labels.run_id,
    uid: 1000, root, manifest: file('manifest'), dsn: file('dsn'), labels,
    sources: [{ ...file('compose'), sha256: h(8) }], config_digest: digest(config),
    network: { name: 'luson-r05-'+labels.run_id+'-net', id: phase === 'active' ? h(1) : null },
    volume: { name: 'luson-r05-'+labels.run_id+'-data', id: phase === 'active' ? h(2) : null },
    services: {
      app: { id: phase === 'active' ? h(3) : null, image: h(5), compose_hash: h(7), user: '1000:1000', readonly: true,
        ports: [{ host: '127.0.0.1', published: 9443, target: 8443 }], mounts: [mount(root+'/dsn','/run/secrets/database_url')] },
      db: { id: phase === 'active' ? h(4) : null, image: h(6), compose_hash: h(9), user: '999:999', readonly: false,
        ports: [], mounts: [mount('luson-r05-'+labels.run_id+'-data','/var/lib/postgresql/data','volume',false)] },
    } };
  const snapshot = { sequence: 1, root: { path: root, uid: 1000, mode: 0o700, type: 'directory', symlink: false },
    files: [manifest.manifest, manifest.dsn, ...manifest.sources], sources: manifest.sources,
    config, existing_names: [],
    network: { ...manifest.network, labels, internal: true, driver: 'bridge', members: [h(3),h(4)] },
    volume: { ...manifest.volume, labels, users: [h(4)] }, project_ids: [h(3),h(4)],
    containers: Object.entries(manifest.services).map(([service, value]) => ({ ...value, service,
      name: manifest.project+'-'+service+'-1', project: manifest.project, labels, network_id: h(1) })) };
  if (phase === 'prepare') { snapshot.network = null; snapshot.volume = null; snapshot.containers = []; snapshot.project_ids = []; }
  return { manifest, snapshot };
}
test('R05a1 valid active binding and canonical digest', () => {
  const { manifest, snapshot } = fixture();
  assert.equal(admit(manifest, snapshot, 'active'), true);
  assert.equal(digest({ b: 2, a: 1 }), digest({ a: 1, b: 2 }));
});
for (const phase of ['prepare', 'active']) {
  test('R05a2b1 explicit DB default admits '+phase, () => {
    const f = fixture(phase); f.manifest.services.db.user = '';
    if (phase === 'active') f.snapshot.containers[1].user = '';
    assert.equal(admit(f.manifest, f.snapshot, phase), true);
  });
  for (const [name, user] of Object.entries({ missing: undefined, undefined: undefined, null: null, number: 999,
    object: { toString: () => '999:999' }, whitespace: ' ', username: 'postgres', root: '0:0' })) {
    test('R05a2b1 invalid DB declaration '+name+' refuses '+phase, () => {
      const f = fixture(phase); f.manifest.services.db.user = user;
      if (name === 'missing') delete f.manifest.services.db.user;
      if (phase === 'active') f.snapshot.containers[1].user = user;
      assert.throws(() => admit(f.manifest, f.snapshot, phase), /R05 admission refused/);
    });
  }
  test('R05a2b1 empty app declaration refuses '+phase, () => {
    const f = fixture(phase); f.manifest.services.db.user = ''; f.manifest.services.app.user = '';
    if (phase === 'active') { f.snapshot.containers[1].user = ''; f.snapshot.containers[0].user = ''; }
    assert.throws(() => admit(f.manifest, f.snapshot, phase), /R05 admission refused/);
  });
}
const mutations = {
  scope: f => f.manifest.labels.scope = 'R01',
  phase: f => delete f.manifest.phase,
  containerLabels: f => f.snapshot.containers[0].labels = { ...f.manifest.labels, run_id: 'foreign' },
  network: f => f.snapshot.containers[0].network_id = h(10),
  duplicateMember: f => f.snapshot.network.members = [h(3),h(3)],
  unknownNested: f => f.manifest.network.adopt = true,
  project: f => f.manifest.project = 'retired',
  run: f => f.snapshot.network.labels = { ...f.manifest.labels, run_id: 'other' },
  unknown: f => f.manifest.extra = true,
  shortID: f => f.manifest.services.app.id = 'abcdef',
  missingID: f => f.manifest.services.db.id = null,
  duplicateID: f => f.manifest.services.db.id = f.manifest.services.app.id,
  foreignMember: f => f.snapshot.network.members.push(h(10)),
  partialMembership: f => f.snapshot.network.members.pop(),
  foreignVolumeUser: f => f.snapshot.volume.users.push(h(10)),
  foreignProject: f => f.snapshot.project_ids.push(h(10)),
  image: f => f.snapshot.containers[0].image = h(10),
  composeHash: f => f.snapshot.containers[0].compose_hash = h(10),
  config: f => f.snapshot.config.services.tool = {},
  boundThirdService: f => { f.snapshot.config.services.tool = {}; f.manifest.config_digest = digest(f.snapshot.config); },
  privilegedConfig: f => { f.snapshot.config.services.app.privileged = true; f.manifest.config_digest = digest(f.snapshot.config); },
  nameCollision: f => f.snapshot.existing_names.push('foreign'),
  source: f => f.snapshot.sources = [{ ...f.manifest.sources[0], sha256: h(10) }],
  mount: f => f.snapshot.containers[0].mounts[0].source = '/foreign',
  appUser: f => f.snapshot.containers[0].user = '0:0',
  writableApp: f => f.snapshot.containers[0].readonly = false,
  publicApp: f => f.snapshot.containers[0].ports[0].host = '0.0.0.0',
  publicDB: f => f.snapshot.containers[1].ports.push({ host: '127.0.0.1', published: 5432, target: 5432 }),
  rootMode: f => f.snapshot.root.mode = 0o755,
  fileMode: f => f.snapshot.files[1] = { ...f.snapshot.files[1], mode: 0o644 },
  uid: f => f.snapshot.files[1] = { ...f.snapshot.files[1], uid: 0 },
  symlink: f => f.snapshot.files[1] = { ...f.snapshot.files[1], symlink: true },
  outsideRoot: f => f.manifest.dsn.path = '/other/dsn',
};
for (const [name, mutate] of Object.entries(mutations)) test('R05a1 rejects '+name+' before effects', async () => {
  const f = fixture(); mutate(f); let effects = 0;
  const owned = new R05OwnedCompose({ manifest: f.manifest, inspect: async () => f.snapshot,
    dispatch: async () => { effects++; } });
  await assert.rejects(() => owned.sql({ text: 'SELECT $1', values: ['dummy'] }), /R05 admission refused/);
  assert.equal(effects, 0);
});
for (const [name, mutate] of Object.entries(mutations)) test('R05a2b1 DB default retains guard '+name, () => {
  const f = fixture(); f.manifest.services.db.user = ''; f.snapshot.containers[1].user = '';
  mutate(f);
  assert.throws(() => admit(f.manifest, f.snapshot, 'active'), /R05 admission refused/);
});
test('R05a1 prepare cannot adopt existing resources or authorize SQL', async () => {
  const f = fixture('prepare');
  assert.equal(admit(f.manifest, f.snapshot, 'prepare'), true);
  f.snapshot.existing_names.push(f.manifest.project);
  assert.throws(() => admit(f.manifest, f.snapshot, 'prepare'), /R05 admission refused/);
  f.snapshot.existing_names = []; let effects = 0;
  const owned = new R05OwnedCompose({ manifest: f.manifest, inspect: async () => f.snapshot, dispatch: async () => effects++ });
  await assert.rejects(() => owned.sql({ text: 'SELECT 1', values: [] }));
  assert.equal(effects, 0);
});
test('R05a1 fresh inspection exact-ID SQL and explicit cleanup plan', async () => {
  const f = fixture(); const calls = [];
  const owned = new R05OwnedCompose({ manifest: f.manifest, inspect: async () => copy(f.snapshot), dispatch: async x => calls.push(x) });
  const plan = await owned.cleanupPlan();
  assert.equal(calls.length, 0);
  assert.equal(plan.containers.join(','), [h(3),h(4)].join(','));
  f.snapshot.sequence++;
  await owned.sql({ text: 'SELECT $1', values: [17] });
  assert.equal(calls[0].id, h(4));
  assert.equal(calls[0].operation, 'sql');
  assert.equal(calls[0].stdin.values[0], 17);
  assert.equal('env' in calls[0] || 'argv' in calls[0], false);
  await assert.rejects(() => owned.sql({ text: 'SELECT 1', values: [] }), /R05 admission refused/);
  assert.equal(calls.length, 1);
  f.snapshot.sequence++;
  await owned.cleanup(plan, { settled: true });
  assert.equal(calls[1].operation, 'cleanup-exact');
  assert.equal(calls[1].network, h(1));
});
test('R05a1 cleanup requires settled instance plan and checks drift again', async () => {
  const f = fixture(); let effects = 0;
  const owned = new R05OwnedCompose({ manifest: f.manifest, inspect: async () => copy(f.snapshot), dispatch: async () => effects++ });
  const plan = await owned.cleanupPlan();
  await assert.rejects(() => owned.cleanup(plan, { settled: false }));
  await assert.rejects(() => owned.cleanup({ ...plan }, { settled: true }));
  f.snapshot.sequence++; f.snapshot.containers[0].image = h(10);
  await assert.rejects(() => owned.cleanup(plan, { settled: true }));
  assert.equal(effects, 0);
});
test('R05a1 preparing records only a fresh creation plan without effect', async () => {
  const f = fixture('prepare'); let effects = 0;
  const owned = new R05OwnedCompose({ manifest: f.manifest, inspect: async () => copy(f.snapshot), dispatch: async () => effects++ });
  const plan = await owned.createPlan();
  assert.equal(plan.project, f.manifest.project);
  assert.equal(plan.operation, 'prepare-new'); assert.equal(effects, 0);
  await assert.rejects(() => owned.cleanupPlan());
});
test('R05a1 no fallback and sanitized driver failures', async () => {
  assert.throws(() => new R05OwnedCompose({}), /R05 admission refused/);
  const f = fixture();
  const owned = new R05OwnedCompose({ manifest: f.manifest, inspect: async () => { throw Error('private diagnostic'); }, dispatch: async () => {} });
  await assert.rejects(() => owned.cleanupPlan(), e => e.message === 'R05 admission refused.');
});
