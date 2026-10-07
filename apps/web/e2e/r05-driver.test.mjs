import test from 'node:test';
import assert from 'node:assert/strict';
import { digest, admit } from './r05-binding.mjs';
import { normalizeR05Evidence, volumeFingerprint, createR05Driver } from './r05-driver.mjs';
const h = n => n.toString(16).padStart(64, '0');
const copy = x => structuredClone(x);
const labelPolicy = { scopeKey: 'org.luson.r05.scope', runKey: 'org.luson.r05.run',
  reservedOwnerKeys: ['org.luson.r05.scope', 'org.luson.r05.run', 'org.luson.old.owner'] };
// Numeric DB user is synthetic positive evidence, NOT official postgres defaults.
function fixture(phase = 'active') {
  const root = '/private/r05-synthetic';
  const run_id = 'abcdef0123456789';
  const project = 'luson-r05-'+run_id;
  const labels = { scope: 'transfer-requests/R05', run_id };
  const rawLabels = { [labelPolicy.scopeKey]: labels.scope, [labelPolicy.runKey]: run_id,
    'com.docker.compose.project': project };
  const config = { services: { app: { depends_on: { db: { condition: 'service_healthy' } } }, db: {} } };
  const file = name => ({ path: root+'/'+name, uid: 1000, mode: 0o600, type: 'file', symlink: false });
  const volume = { Name: project+'-data', Driver: 'local', CreatedAt: '2026-01-01T00:00:00Z',
    Options: null, Scope: 'local', Labels: { ...rawLabels, 'com.docker.compose.volume': 'data' } };
  const manifest = { schema: 'luson.r05/v1', phase, run_id, project, uid: 1000, root,
    manifest: file('manifest'), dsn: file('dsn'), labels,
    sources: [{ ...file('compose'), sha256: h(8) }], config_digest: digest(config),
    network: { name: project+'-net', id: phase === 'active' ? h(1) : null },
    volume: { name: volume.Name, id: phase === 'active' ? digest(volume) : null },
    services: {
      app: { id: phase === 'active' ? h(3) : null, image: h(5), compose_hash: h(7),
        user: '1000:1000', readonly: true, ports: [{ host: '127.0.0.1', published: 9443, target: 8443 }],
        mounts: [{ source: root+'/dsn', target: '/run/secrets/database_url', kind: 'bind', readonly: true }] },
      db: { id: phase === 'active' ? h(4) : null, image: h(6), compose_hash: h(9), user: '999:999',
        readonly: false, ports: [], mounts: [{ source: volume.Name, target: '/var/lib/postgresql/data',
          kind: 'volume', readonly: false }] },
    } };
  const containers = Object.entries(manifest.services).map(([service, spec]) => ({
    Id: spec.id, Name: '/'+project+'-'+service+'-1', Image: 'sha256:'+spec.image,
    Config: { User: spec.user, Labels: { ...rawLabels, 'com.docker.compose.service': service,
      'com.docker.compose.config-hash': spec.compose_hash } },
    HostConfig: { ReadonlyRootfs: spec.readonly, PortBindings: service === 'app'
      ? { '8443/tcp': [{ HostIp: '127.0.0.1', HostPort: '9443' }] } : {} },
    Mounts: service === 'app'
      ? [{ Type: 'bind', Source: root+'/dsn', Destination: '/run/secrets/database_url', RW: false }]
      : [{ Type: 'volume', Name: volume.Name, Source: '/var/lib/docker/volumes/synthetic/_data',
        Destination: '/var/lib/postgresql/data', RW: true }],
    NetworkSettings: { Networks: { [project+'-net']: { NetworkID: h(1) } } },
    State: { Status: 'running', Running: true },
  }));
  const raw = { request: 1, root: { path: root, uid: 1000, mode: 0o700, type: 'directory', symlink: false },
    files: [manifest.manifest, manifest.dsn, ...manifest.sources], sources: manifest.sources,
    config, existing_names: [], project_ids: [h(3), h(4)], volume_users: [h(4)], containers,
    network: { Id: h(1), Name: project+'-net', Labels: rawLabels, Internal: true, Driver: 'bridge',
      Containers: { [h(3)]: { Name: project+'-app-1' }, [h(4)]: { Name: project+'-db-1' } } }, volume };
  if (phase === 'prepare') {
    raw.network = null; raw.volume = null; raw.containers = []; raw.project_ids = []; raw.volume_users = [];
  }
  return { manifest, raw };
}
const normalize = f => normalizeR05Evidence({ ...f, labelPolicy, sequence: 1 });
const refusal = e => e.message === 'R05 admission refused.';
test('R05a2a rejects malformed full ID without inventing evidence', () => {
  const f = fixture(); f.raw.containers[0].Id = 'short';
  assert.throws(() => normalize(f), refusal);
});
test('R05a2a complete synthetic active and absent prepare snapshots admit', () => {
  for (const phase of ['active', 'prepare']) {
    const f = fixture(phase); const s = normalize(f);
    assert.equal(admit(f.manifest, s, phase), true);
    assert.equal(s.sequence, 1);
    if (phase === 'active') {
      assert.equal(s.containers[1].mounts[0].source, f.manifest.volume.name);
      assert.equal(s.volume.id, digest(f.raw.volume));
    } else assert.equal(s.volume, null);
  }
});
test('R05a2a empty official-default User is preserved and active admission refuses', () => {
  const f = fixture(); f.raw.containers[1].Config.User = '';
  const s = normalize(f);
  assert.equal(s.containers[1].user, '');
  assert.throws(() => admit(f.manifest, s, 'active'), refusal);
});
const malformed = {
  truncatedNetwork: f => f.raw.network.Id = 'abcd',
  unprefixedImage: f => f.raw.containers[0].Image = h(5),
  doubledImagePrefix: f => f.raw.containers[0].Image = 'sha256:sha256:'+h(5),
  imageTag: f => f.raw.containers[0].Image = 'postgres:17',
  duplicateContainer: f => f.raw.containers[1].Id = h(3),
  duplicateProject: f => f.raw.project_ids.push(h(3)),
  duplicateVolumeUser: f => f.raw.volume_users.push(h(4)),
  malformedProjectArray: f => f.raw.project_ids = {},
  malformedContainersArray: f => f.raw.containers = {},
  missingContainer: f => f.raw.containers.pop(),
  missingNetwork: f => f.raw.network = null,
  missingVolume: f => f.raw.volume = null,
  missingFile: f => delete f.raw.files[0].mode,
  fileContents: f => f.raw.files[0].contents = 'synthetic-private-sentinel',
  rootContents: f => f.raw.root.contents = 'synthetic-private-sentinel',
  unknownEnvelope: f => f.raw.provider = 'synthetic-private-sentinel',
  rawEnv: f => f.raw.containers[0].Config.Env = ['synthetic-private-sentinel'],
  configEnvironment: f => f.raw.config.services.db.environment = { PASSWORD: 'synthetic-private-sentinel' },
  stringUID: f => f.raw.root.uid = '1000',
  stringMode: f => f.raw.files[0].mode = '0600',
  missingSymlink: f => delete f.raw.root.symlink,
  malformedSourceHash: f => f.raw.sources = [{ ...f.raw.sources[0], sha256: 'sha256:'+h(8) }],
  duplicateFile: f => f.raw.files.push(copy(f.raw.files[0])),
  invalidName: f => f.raw.containers[0].Name = '//'+f.manifest.project+'-app-1',
  pathName: f => f.raw.containers[0].Name = '/foreign/'+f.manifest.project+'-app-1',
  missingSlash: f => f.raw.containers[0].Name = f.manifest.project+'-app-1',
  inventedBool: f => f.raw.containers[0].HostConfig.ReadonlyRootfs = 'true',
  stringRW: f => f.raw.containers[0].Mounts[0].RW = 'false',
  unsupportedMount: f => f.raw.containers[0].Mounts[0].Type = 'tmpfs',
  noncanonicalBind: f => f.raw.containers[0].Mounts[0].Source = '/private/../private/r05-synthetic/dsn',
  unnamedVolume: f => delete f.raw.containers[1].Mounts[0].Name,
  missingLabels: f => delete f.raw.network.Labels[labelPolicy.scopeKey],
  wrongScope: f => f.raw.network.Labels[labelPolicy.scopeKey] = 'R01',
  wrongRun: f => f.raw.volume.Labels[labelPolicy.runKey] = 'foreign',
  reservedConflict: f => f.raw.volume.Labels['org.luson.old.owner'] = 'foreign',
  unknownOwner: f => f.raw.containers[0].Config.Labels['org.other.owner'] = 'foreign',
  unknownCompose: f => f.raw.volume.Labels['com.docker.compose.unreviewed'] = 'foreign',
  stringLabels: f => f.raw.volume.Labels = 'foreign',
  emptyBindings: f => f.raw.containers[0].HostConfig.PortBindings['8443/tcp'] = [],
  udp: f => f.raw.containers[0].HostConfig.PortBindings = { '8443/udp': [] },
  badPort: f => f.raw.containers[0].HostConfig.PortBindings['8443/tcp'][0].HostPort = '9443junk',
  highTarget: f => f.raw.containers[0].HostConfig.PortBindings = { '65536/tcp': [] },
  highPort: f => f.raw.containers[0].HostConfig.PortBindings['8443/tcp'][0].HostPort = '65536',
  zeroPort: f => f.raw.containers[0].HostConfig.PortBindings['8443/tcp'][0].HostPort = '0',
  extraAttachment: f => f.raw.containers[0].NetworkSettings.Networks.foreign = { NetworkID: h(10) },
  wrongAttachment: f => f.raw.containers[0].NetworkSettings.Networks[f.manifest.network.name].NetworkID = h(10),
  memberNameNotID: f => f.raw.network.Containers = { app: { Name: 'app' } },
  exited: f => f.raw.containers[1].State = { Status: 'exited', Running: false },
  created: f => f.raw.containers[1].State = { Status: 'created', Running: false },
  optionsArray: f => f.raw.volume.Options = [],
};
for (const [name, mutate] of Object.entries(malformed)) {
  test('R05a2a malformed '+name+' refuses before dispatch', async () => {
    const f = fixture(); mutate(f); let effects = 0;
    const driver = createR05Driver({ manifest: f.manifest, labelPolicy,
      collectRaw: async c => ({ ...copy(f.raw), request: c.request }), dispatchRaw: async () => effects++ });
    await assert.rejects(() => driver.sql({ text: 'SELECT $1', values: [17] }), refusal);
    assert.equal(effects, 0);
  });
}
const drift = {
  emptyDBUser: f => f.raw.containers[1].Config.User = '',
  foreignBind: f => f.raw.containers[0].Mounts[0].Source = '/foreign',
  foreignVolume: f => f.raw.containers[1].Mounts[0].Name = 'foreign',
  stoppedForeignVolumeUser: f => f.raw.volume_users.push(h(10)),
  createdForeignProject: f => f.raw.project_ids.push(h(10)),
  foreignMember: f => f.raw.network.Containers[h(10)] = { Name: 'foreign' },
  missingMember: f => delete f.raw.network.Containers[h(4)],
  wildcard: f => f.raw.containers[0].HostConfig.PortBindings['8443/tcp'][0].HostIp = '0.0.0.0',
  emptyHost: f => f.raw.containers[0].HostConfig.PortBindings['8443/tcp'][0].HostIp = '',
  dbPublished: f => f.raw.containers[1].HostConfig.PortBindings = {
    '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '5432' }] },
  appWritable: f => f.raw.containers[0].HostConfig.ReadonlyRootfs = false,
  rootPermissions: f => f.raw.root.mode = 0o755,
  filePermissions: f => f.raw.files[1].mode = 0o644,
  symlink: f => f.raw.root.symlink = true,
  foreignUID: f => f.raw.files[1].uid = 999,
  sourceBytes: f => f.raw.sources = [{ ...f.raw.sources[0], sha256: h(10) }],
  config: f => f.raw.config.services.app.depends_on.db.condition = 'service_started',
  image: f => f.raw.containers[0].Image = 'sha256:'+h(10),
  composeHash: f => f.raw.containers[0].Config.Labels['com.docker.compose.config-hash'] = h(10),
  exactDBID: f => f.raw.containers[1].Id = h(10),
  nameCollision: f => f.raw.existing_names.push('foreign'),
  volumeDriver: f => f.raw.volume.Driver = 'foreign',
  volumeCreatedAt: f => f.raw.volume.CreatedAt = '2026-01-02T00:00:00Z',
  volumeOptions: f => f.raw.volume.Options = { type: 'tmpfs' },
  volumeScope: f => f.raw.volume.Scope = 'global',
  volumeComposeLabel: f => f.raw.volume.Labels['com.docker.compose.version'] = 'new-version',
};
for (const [name, mutate] of Object.entries(drift)) {
  test('R05a2a per-SQL drift '+name+' has zero subsequent effects', async () => {
    const f = fixture(); let effects = 0; let collections = 0;
    const driver = createR05Driver({ manifest: f.manifest, labelPolicy,
      collectRaw: async c => { collections++; return { ...copy(f.raw), request: c.request }; },
      dispatchRaw: async () => effects++ });
    await driver.sql({ text: 'SELECT $1', values: [17] });
    assert.equal(effects, 1);
    mutate(f);
    await assert.rejects(() => driver.sql({ text: 'SELECT $1', values: [18] }), refusal);
    assert.equal(effects, 1); assert.equal(collections, 2);
  });
}
test('R05a2a full volume identity canonicalizes keys but retains all metadata', () => {
  const f = fixture(); const base = volumeFingerprint(f.raw.volume);
  const reordered = Object.fromEntries(Object.entries(f.raw.volume).reverse());
  assert.equal(volumeFingerprint(reordered), base);
  for (const [name, mutate] of Object.entries(drift).filter(([name]) => name.startsWith('volume'))) {
    const other = fixture(); mutate(other);
    assert.notEqual(volumeFingerprint(other.raw.volume), base);
  }
  assert.notEqual(digest({ a: [1, 2] }), digest({ a: [2, 1] }));
  assert.equal(digest({ b: 2, a: 1 }), digest({ a: 1, b: 2 }));
});
test('R05a2a fresh per-instance sequence and cloned bound inputs', async () => {
  const f = fixture(); const p = copy(labelPolicy); let collections = 0;
  const driver = createR05Driver({ manifest: f.manifest, labelPolicy: p,
    collectRaw: async c => { collections++; return { ...copy(f.raw), request: c.request }; }, dispatchRaw: async () => {} });
  f.manifest.services.db.id = h(20); p.scopeKey = 'foreign';
  const a = await driver.inspect(); a.root.mode = 0;
  const b = await driver.inspect();
  assert.equal(a.sequence, 1); assert.equal(b.sequence, 2);
  assert.equal(b.root.mode, 0o700); assert.equal(collections, 2);
  const g = fixture();
  const other = createR05Driver({ manifest: g.manifest, labelPolicy,
    collectRaw: async c => ({ ...copy(g.raw), request: c.request }), dispatchRaw: async () => {} });
  assert.equal((await other.inspect()).sequence, 1);
});
test('R05a2a failed observation consumes request but not positive sequence', async () => {
  const f = fixture(); let calls = 0;
  const driver = createR05Driver({ manifest: f.manifest, labelPolicy,
    collectRaw: async c => {
      calls++; const r = copy(f.raw); r.request = c.request;
      if (calls === 1) r.root.mode = 0; return r;
    }, dispatchRaw: async () => {} });
  await assert.rejects(() => driver.inspect(), refusal);
  assert.equal((await driver.inspect()).sequence, 1);
});
test('R05a2a causal request replay and simultaneous effects refuse', async () => {
  const f = fixture(); let effects = 0;
  const replay = createR05Driver({ manifest: f.manifest, labelPolicy,
    collectRaw: async () => copy(f.raw), dispatchRaw: async () => effects++ });
  await replay.sql({ text: 'SELECT 1', values: [] });
  await assert.rejects(() => replay.sql({ text: 'SELECT 1', values: [] }), refusal);
  assert.equal(effects, 1);
  let release;
  const held = createR05Driver({ manifest: f.manifest, labelPolicy,
    collectRaw: c => new Promise(resolve => { release = () => resolve({ ...copy(f.raw), request: c.request }); }),
    dispatchRaw: async () => effects++ });
  const first = held.sql({ text: 'SELECT 1', values: [] });
  await assert.rejects(() => held.sql({ text: 'SELECT 1', values: [] }), refusal);
  release(); await first; assert.equal(effects, 2);
});
test('R05a2a exact owned SQL stdin protocol and no transport output exposure', async () => {
  const f = fixture(); let shapeOK = false;
  const driver = createR05Driver({ manifest: f.manifest, labelPolicy,
    collectRaw: async c => {
      assert.equal(Object.keys(c).sort().join(','), 'operation,phase,request');
      assert.equal(c.operation, 'inspect'); assert.equal(Object.isFrozen(c), true);
      return { ...copy(f.raw), request: c.request };
    }, dispatchRaw: async op => {
      shapeOK = Object.keys(op).sort().join(',') === 'id,operation,stdin'
        && op.id === h(4) && op.operation === 'sql' && op.stdin.text === 'SELECT $1'
        && op.stdin.values[0] === 17;
      return { private: 'synthetic-private-sentinel' };
    } });
  assert.equal(await driver.sql({ text: 'SELECT $1', values: [17] }), undefined);
  assert.equal(shapeOK, true);
  await assert.rejects(() => driver.sql({ text: 'SELECT 1', values: [], argv: [] }), refusal);
});
test('R05a2a prepare plan is inert; lifecycle operations cannot dispatch', async () => {
  const f = fixture('prepare'); let effects = 0; let collections = 0;
  const driver = createR05Driver({ manifest: f.manifest, labelPolicy,
    collectRaw: async c => { collections++; return { ...copy(f.raw), request: c.request }; },
    dispatchRaw: async () => effects++ });
  assert.equal((await driver.createPlan()).operation, 'prepare-new');
  for (const verb of ['create', 'build', 'start', 'remove', 'dispatch']) assert.equal(verb in driver, false);
  await assert.rejects(() => driver.cleanupPlan(), refusal);
  await assert.rejects(() => driver.cleanup({}, { settled: true }), refusal);
  await assert.rejects(() => driver.sql({ text: 'SELECT 1', values: [] }), refusal);
  assert.equal(effects, 0); assert.equal(collections, 2);
  f.raw.existing_names.push(f.manifest.network.name);
  await assert.rejects(() => driver.createPlan(), refusal);
  f.raw.existing_names = []; f.raw.network = fixture().raw.network;
  await assert.rejects(() => driver.createPlan(), refusal);
});
test('R05a2a missing injection/policy and private collector/transport failures sanitize', async () => {
  assert.throws(() => createR05Driver({}), refusal);
  const f = fixture();
  assert.throws(() => createR05Driver({ manifest: f.manifest, labelPolicy: {},
    collectRaw: async () => {}, dispatchRaw: async () => {} }), refusal);
  for (const transportFailure of [false, true]) {
    const driver = createR05Driver({ manifest: f.manifest, labelPolicy,
      collectRaw: async c => {
        if (!transportFailure) JSON.parse('synthetic-private-sentinel');
        return { ...copy(f.raw), request: c.request };
      }, dispatchRaw: async () => { throw Error('synthetic-private-sentinel'); } });
    await assert.rejects(() => driver.sql({ text: 'SELECT $1', values: [17] }), refusal);
  }
});
