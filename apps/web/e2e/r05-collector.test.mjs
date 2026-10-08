import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from './r05-binding.mjs';
import { createR05Collector } from './r05-collector.mjs';
import { projectR05PublicConfig } from './r05-config-projection.mjs';
import { volumeFingerprint, createR05Driver } from './r05-driver.mjs';
import { createR05Lifecycle } from './r05-lifecycle.mjs';
const h = n => n.toString(16).padStart(64, '0');
const clone = x => structuredClone(x);
const refused = e => e.message === 'R05 collector refused.' && e.cause === undefined;
const policy = { scopeKey: 'org.luson.scope', runKey: 'org.luson.run',
  reservedOwnerKeys: ['org.luson.scope', 'org.luson.run'] };
// Entirely synthetic public DTOs. Nothing here observes files or an engine.
function fixture(active = false) {
  const root = '/private/r05-fake', run_id = 'abcdef0123456789', project = 'luson-r05-'+run_id;
  const original = { services: {
    app: { environment: { LUSON_APP_UID: '1000', LUSON_APP_GID: '1000', LUSON_PROFILE: 'local-trial',
      LUSON_DATABASE_URL_FILE: '/run/secrets/database_url', LUSON_ORIGIN: 'https://localhost:8443',
      LUSON_LISTEN: '0.0.0.0:8443', LUSON_TLS_CERT: '/run/secrets/tls_cert',
      LUSON_TLS_KEY: '/run/secrets/tls_key', LUSON_WEB_DIR: '/srv/web' },
      secrets: ['database_url', 'tls_cert', 'tls_key'], depends_on: { db: { condition: 'service_healthy' } } },
    db: { environment: { POSTGRES_USER: 'luson', POSTGRES_DB: 'luson',
      POSTGRES_PASSWORD_FILE: '/run/secrets/database_password' }, secrets: ['database_password'] } },
    secrets: Object.fromEntries(['database_password', 'database_url', 'tls_cert', 'tls_key']
      .map(n => [n, { file: root+'/'+n }])) };
  const projected = projectR05PublicConfig(original);
  const file = n => ({ path: root+'/'+n, uid: 1000, mode: 0o600, type: 'file', symlink: false });
  const labels = { scope: 'transfer-requests/R05', run_id };
  const nativeLabels = { [policy.scopeKey]: labels.scope, [policy.runKey]: run_id,
    'com.docker.compose.project': project };
  const volume = { Name: project+'-data', Driver: 'local', CreatedAt: '2026-01-01T00:00:00Z',
    Options: null, Scope: 'local', Labels: { ...nativeLabels, 'com.docker.compose.volume': 'data' } };
  const manifest = { schema: 'luson.r05/v1', phase: active ? 'active' : 'prepare', run_id, project,
    uid: 1000, root, manifest: file('manifest'), dsn: file('dsn'), labels,
    sources: [{ ...file('compose'), sha256: h(8) }], config_digest: digest(projected),
    network: { name: project+'-net', id: active ? h(1) : null },
    volume: { name: volume.Name, id: active ? volumeFingerprint(volume) : null },
    services: { app: { id: active ? h(3) : null, image: h(5), compose_hash: h(7), user: '1000:1000',
      readonly: true, ports: [{ host: '127.0.0.1', published: 9443, target: 8443 }],
      mounts: [{ source: root+'/dsn', target: '/run/secrets/database_url', kind: 'bind', readonly: true }] },
    db: { id: active ? h(4) : null, image: h(6), compose_hash: h(9), user: '', readonly: false, ports: [],
      mounts: [{ source: volume.Name, target: '/var/lib/postgresql/data', kind: 'volume', readonly: false }] } } };
  const paths = [root, ...[manifest.manifest, manifest.dsn, ...manifest.sources].map(f => f.path)];
  const metadata = { root: { path: root, uid: 1000, mode: 0o700, type: 'directory', symlink: false },
    files: [manifest.manifest, manifest.dsn, ...manifest.sources], sources: manifest.sources,
    handles: paths.map((path, i) => ({ path, device: 1, inode: i+10,
      opened: { device: 1, inode: i+10 }, ancestors: path.split('/').slice(1, -1).reduce((a, part) =>
        [...a, { path: a.at(-1).path === '/' ? '/'+part : a.at(-1).path+'/'+part,
          device: 1, inode: a.length === 2 ? 10 : a.length+20,
          uid: a.length === 2 ? 1000 : 0, mode: a.length === 2 ? 0o700 : 0o755,
          type: 'directory', symlink: false }],
      [{ path: '/', device: 1, inode: 1, uid: 0, mode: 0o755, type: 'directory', symlink: false }]) })) };
  const census = { project_ids: [], volume_users: [], containers: [], network: null, volume: null, conflicts: [] };
  const resources = { volume, network: { Id: h(1), Name: manifest.network.name, Labels: nativeLabels,
    Internal: true, Driver: 'bridge', Containers: {} }, containers: {} };
  function presence(role, state = 'running') {
    const spec = manifest.services[role], id = role === 'app' ? h(3) : h(4);
    census.containers.push({ id, role, name: project+'-'+role+'-1', state }); census.project_ids.push(id);
    if (role === 'db') census.volume_users.push(id);
    if (state === 'running') { census.network.members.push(id); resources.network.Containers[id] = { Name: project+'-'+role+'-1' }; }
    resources.containers[id] = { Id: id, Name: '/'+project+'-'+role+'-1', Image: 'sha256:'+spec.image,
      Config: { User: spec.user, Labels: { ...nativeLabels, 'com.docker.compose.service': role,
        'com.docker.compose.config-hash': spec.compose_hash } },
      HostConfig: { NetworkMode: manifest.network.name, ReadonlyRootfs: spec.readonly,
        PortBindings: role === 'app' ? { '8443/tcp': [{ HostIp: '127.0.0.1', HostPort: '9443' }] } : {} },
      Mounts: role === 'app' ? [{ Type: 'bind', Source: root+'/dsn', Destination: '/run/secrets/database_url', RW: false }]
        : [{ Type: 'volume', Name: volume.Name, Source: '/synthetic/volume', Destination: '/var/lib/postgresql/data', RW: true }],
      NetworkSettings: { Networks: { [manifest.network.name]: { NetworkID: h(1) } } },
      State: { Status: state, Running: state === 'running' } };
  }
  function networkPresence() { census.network = { id: h(1), name: manifest.network.name, members: [] }; }
  function volumePresence() { census.volume = { name: volume.Name, fingerprint: volumeFingerprint(volume) }; }
  const config = { original, projected, service_hashes: { app: h(7), db: h(9) } };
  const calls = []; let hook = () => {};
  const transport = { read: async q => { calls.push(clone(q)); await hook(q);
    let value;
    if (q.kind === 'metadata') value = metadata;
    else if (q.kind === 'public-config') value = config;
    else if (q.kind === 'census') value = census;
    else if (q.kind === 'network') value = resources.network;
    else if (q.kind === 'volume') value = resources.volume;
    else if (q.kind === 'container') {
      value = resources.containers[q.id];
      if (q.view === 'active') { value = clone(value); delete value.HostConfig.NetworkMode; }
    } else if (q.kind === 'image') value = { Id: 'sha256:'+q.id, ConfiguredUser: manifest.services[q.role].user };
    else throw new Error('unexpected fake selector');
    return { frame: clone(q.frame), value }; } };
  const identities = { network: active ? h(1) : null, volume: active ? clone(census.volume) : null,
    db: active ? h(4) : null, app: active ? h(3) : null };
  if (active) { networkPresence(); volumePresence(); identities.volume = clone(census.volume); presence('db'); presence('app'); }
  return { manifest, metadata, config, census, resources, identities, calls, transport,
    networkPresence, volumePresence, presence, setHook: fn => hook = fn };
}
const collector = f => createR05Collector({ manifest: f.manifest, labelPolicy: policy, transport: f.transport });
test('R05a2c2b complete empty collection returns frozen lifecycle frame after repeated bindings', async () => {
  const f = fixture(); const c = collector(f);
  const s = await c.collectLifecycle({ sequence: 1, identities: f.identities, pending: null });
  assert.equal(s.sequence, 1); assert.equal(s.network, null); assert.equal(s.volume, null);
  assert.deepEqual(s.containers, []); assert.deepEqual(s.config, f.config.projected);
  assert.equal(Object.isFrozen(s.config.projection_record), true);
  assert.deepEqual(f.calls.map(q => q.kind), ['metadata', 'public-config', 'census', 'metadata', 'public-config', 'census']);
});
const life = (c, f, sequence = 1, pending = null) => c.collectLifecycle({ sequence, identities: clone(f.identities), pending });
const pendingFor = (f, role, base_sequence, attempt = 1) => ({
  operation: { network: 'createNetwork', volume: 'createVolume', db: 'createDB', app: 'createAPP' }[role],
  attempt, base_sequence, expected_name: role === 'network' ? f.manifest.network.name
    : role === 'volume' ? f.manifest.volume.name : f.manifest.project+'-'+role+'-1',
  context: { project: f.manifest.project, root: f.manifest.root, config_digest: f.manifest.config_digest },
  result: role === 'volume' ? { Name: f.manifest.volume.name } : { id: role === 'network' ? h(1) : role === 'db' ? h(4) : h(3) },
});
test('R05a2c2b active raw frame uses exact scoped selectors and separately pinned config hashes', async () => {
  const f = fixture(true); const c = collector(f);
  const raw = await c.collectRawActive({ request: 1, identities: f.identities });
  assert.equal(raw.request, 1); assert.deepEqual(raw.volume, f.resources.volume);
  assert.equal(raw.config.projection_record.full_config_digest, digest(f.config.original));
  assert.notEqual(digest(raw.config), digest(f.config.original));
  assert.equal(raw.containers[0].Config.Labels['com.docker.compose.config-hash'], h(9));
  assert.notEqual(h(9), digest(f.config.original));
  assert.deepEqual(f.calls.slice(0, 3).map(q => q.kind), ['metadata', 'public-config', 'census']);
  const allowed = { metadata: 'frame kind paths project source_paths', 'public-config': 'frame kind project sources',
    census: 'frame kind planned_names project volume_name', network: 'frame id kind project',
    volume: 'frame kind name project', container: 'frame id kind project role view', image: 'frame id kind project role' };
  for (const q of f.calls) {
    assert.equal(Object.keys(q).sort().join(' '), allowed[q.kind]);
    if (q.kind === 'image') assert.equal(q.id, f.manifest.services[q.role].image);
    assert.equal(q.project, f.manifest.project);
  }
  assert.equal(Object.hasOwn(raw.files.find(v => v.path === f.manifest.dsn.path), 'sha256'), false);
  f.resources.volume.Labels['com.docker.compose.volume'] = 'changed';
  assert.equal(raw.volume.Labels['com.docker.compose.volume'], 'data');
  assert.equal(Object.isFrozen(raw.containers[0].Config), true);
});
for (const [name, mutate] of Object.entries({
  unknownProject: f => f.census.project_ids.push(h(20)),
  foreignExitedVolumeUser: f => f.census.volume_users.push(h(20)),
  foreignNetworkMember: f => f.census.network.members.push(h(20)),
  nameConflict: f => f.census.conflicts.push(f.manifest.project+'-app-1'),
  unselectedNetwork: f => f.census.network.id = h(20),
  unselectedVolume: f => f.census.volume.fingerprint = h(20),
  roleConfusion: f => f.census.containers[0].role = 'app',
})) test('R05a2c2b namespace contamination '+name+' denies before any resource inspection', async () => {
  const f = fixture(true); mutate(f); const c = collector(f);
  await assert.rejects(() => c.collectRawActive({ request: 1, identities: f.identities }), refused);
  assert.deepEqual(f.calls.map(q => q.kind), ['metadata', 'public-config', 'census']);
});
test('R05a2c2b retained identities are not fresh presence or name adoption', async () => {
  const f = fixture(); f.identities = { network: h(1), db: h(4), app: h(3),
    volume: { name: f.manifest.volume.name, fingerprint: volumeFingerprint(f.resources.volume) } };
  const s = await life(collector(f), f); assert.equal(s.network, null); assert.equal(s.volume, null);
  assert.deepEqual(s.containers, []);
  const other = fixture(); other.networkPresence();
  await assert.rejects(() => life(collector(other), other), refused);
  assert.equal(other.calls.some(q => q.kind === 'network'), false);
});
test('R05a2c2b pending responses require prior complete absence and exact parent context', async () => {
  const f = fixture(); const c = collector(f); const pending = pendingFor(f, 'network', 1);
  await assert.rejects(() => life(c, f, 2, pending), refused); assert.equal(f.calls.length, 0);
  await life(c, f); f.networkPresence();
  for (const wrong of [{ ...pending, context: { ...pending.context, root: '/other' } },
    { ...pending, expected_name: 'other' }, { ...pending, base_sequence: 9 }]) {
    const count = f.calls.length; await assert.rejects(() => life(c, f, 2, wrong), refused); assert.equal(f.calls.length, count);
  }
  const s = await life(c, f, 2, pending); assert.equal(s.network.id, h(1));
  const count = f.calls.length;
  await assert.rejects(() => life(c, f, 3, { ...pending, result: { id: h(10) } }), refused);
  assert.equal(f.calls.length, count);
});
test('R05a2c2b pending DB safety frame is created evidence, never active SQL ownership', async () => {
  const f = fixture(); f.networkPresence(); f.volumePresence();
  f.identities.network = h(1); f.identities.volume = clone(f.census.volume);
  const c = collector(f); await life(c, f); f.presence('db', 'created');
  const s = await life(c, f, 2, pendingFor(f, 'db', 1));
  assert.equal(s.containers[0].state, 'created'); assert.deepEqual(s.network.members, []);
  assert.deepEqual(s.volume_users, [h(4)]); assert.equal(f.identities.db, null);
  const count = f.calls.length;
  await assert.rejects(() => c.collectRawActive({ request: 1, identities: f.identities }), refused);
  assert.equal(f.calls.length, count);
});
test('R05a2c2b native full volume fingerprint stays unchanged and consumer ledger refuses Labels', async () => {
  const f = fixture(), c = collector(f); const start = await life(c, f);
  const ledger = createR05Lifecycle({ manifest: f.manifest, snapshot: start });
  const beforeNetwork = await life(c, f, 2), plan = ledger.plan('createNetwork', beforeNetwork);
  f.networkPresence(); const network = await life(c, f, 3, pendingFor(f, 'network', 2));
  ledger.admitReceipt(plan.token, { attempt: plan.attempt, operation: plan.operation, result: { id: h(1) } }, network);
  f.identities.network = h(1); const beforeVolume = await life(c, f, 4);
  const volumePlan = ledger.plan('createVolume', beforeVolume); f.volumePresence();
  const observed = await life(c, f, 5, pendingFor(f, 'volume', 4, 2));
  assert.deepEqual(observed.volume.metadata, f.resources.volume);
  assert.equal(volumeFingerprint(observed.volume.metadata), f.census.volume.fingerprint);
  assert.throws(() => ledger.admitReceipt(volumePlan.token, { attempt: volumePlan.attempt,
    operation: volumePlan.operation, result: { Name: f.manifest.volume.name } }, observed),
  e => e.message === 'R05 admission refused.');
  assert.equal(ledger.status().identities.volume, null);
});
for (const state of ['created', 'exited']) test('R05a2c2b actual '+state+' attachment is preserved and unavailable attachment refuses', async () => {
  const f = fixture(); f.networkPresence(); f.volumePresence(); f.presence('db', state);
  f.identities.network = h(1); f.identities.volume = clone(f.census.volume); f.identities.db = h(4);
  const c = collector(f); const s = await life(c, f);
  assert.equal(s.containers[0].state, state); assert.equal(s.containers[0].network_id, h(1));
  assert.equal(s.containers[0].network_mode, f.manifest.network.name); assert.deepEqual(s.network.members, []);
  f.resources.containers[h(4)].NetworkSettings.Networks = {};
  await assert.rejects(() => life(c, f, 2), refused);
});
for (const [name, kind, mutate] of [
  ['root', 'metadata', f => f.metadata.root.mode = 0o755],
  ['file', 'metadata', f => f.metadata.files[1].mode = 0o644],
  ['source', 'metadata', f => f.metadata.sources[0].sha256 = h(20)],
  ['inode', 'metadata', f => { f.metadata.handles[1].inode++; f.metadata.handles[1].opened.inode++; }],
  ['ancestor', 'metadata', f => f.metadata.handles[0].ancestors[0].inode++],
  ['config', 'public-config', f => f.config.original.services.app.depends_on.db.condition = 'service_started'],
  ['record', 'public-config', f => f.config.projected.projection_record.full_config_digest = h(20)],
  ['independentHash', 'public-config', f => f.config.service_hashes.db = h(20)],
  ['identity', 'container', f => f.resources.containers[h(4)].Id = h(20)],
  ['image', 'image', f => f.manifest.services.db.user = '999:999'],
  ['mount', 'container', f => f.resources.containers[h(4)].Mounts[0].RW = false],
  ['network', 'network', f => f.resources.network.Internal = false],
  ['volume', 'volume', f => f.resources.volume.CreatedAt = '2026-01-02T00:00:00Z'],
  ['census', 'census', f => f.census.volume_users.push(h(20))],
]) test('R05a2c2b repeated '+name+' drift refuses without advancing request completion', async () => {
  const f = fixture(true); let seen = 0;
  f.setHook(q => { if (q.kind === kind && ++seen === 2) mutate(f); });
  const c = collector(f);
  await assert.rejects(() => c.collectRawActive({ request: 1, identities: f.identities }), refused);
  f.setHook(() => {});
});
test('R05a2c2b config codec runs every collection and rejects recomputed forbidden SOURCE', async () => {
  const f = fixture(), c = collector(f); await life(c, f);
  f.config.original.services.app.command = 'unsupported';
  f.config.projected.services.app.command = 'unsupported';
  f.config.projected.projection_record.full_config_digest = digest(f.config.original);
  await assert.rejects(() => life(c, f, 2), refused);
  assert.equal(f.calls.filter(q => q.kind === 'census').length, 2);
});
test('R05a2c2b failed reads retain freshness and overlapping cross-mode calls cannot interleave', async () => {
  const f = fixture(), c = collector(f); let release, entered;
  const started = new Promise(r => entered = r), wait = new Promise(r => release = r);
  f.setHook(async () => { entered(); await wait; throw new Error('synthetic-private-sentinel'); });
  const first = life(c, f); await started;
  await assert.rejects(() => c.collectRawActive({ request: 1, identities: f.identities }), refused);
  release(); await assert.rejects(() => first, refused);
  f.setHook(() => {}); assert.equal((await life(c, f)).sequence, 1);
  const count = f.calls.length; await assert.rejects(() => life(c, f), refused); assert.equal(f.calls.length, count);
});
test('R05a2c2b active failed read can retry same request but successful request cannot replay', async () => {
  const f = fixture(true), c = collector(f); f.setHook(() => { throw new Error('synthetic-private-sentinel'); });
  await assert.rejects(() => c.collectRawActive({ request: 1, identities: f.identities }), refused);
  f.setHook(() => {}); assert.equal((await c.collectRawActive({ request: 1, identities: f.identities })).request, 1);
  const count = f.calls.length;
  await assert.rejects(() => c.collectRawActive({ request: 1, identities: f.identities }), refused); assert.equal(f.calls.length, count);
});
for (const kind of ['getter', 'hidden', 'symbol', 'prototype', 'sparse', 'cycle', 'deep', 'proxy']) {
  test('R05a2c2b caller '+kind+' denies before reads without invoking getters or traps', async () => {
    const f = fixture(), c = collector(f), q = { sequence: 1, identities: f.identities, pending: null }; let calls = 0;
    if (kind === 'getter') Object.defineProperty(q, 'sequence', { enumerable: true, get() { calls++; return 1; } });
    if (kind === 'hidden') Object.defineProperty(q, 'hidden', { value: 1 });
    if (kind === 'symbol') q[Symbol('hidden')] = 1;
    if (kind === 'prototype') Object.setPrototypeOf(q, { inherited: 1 });
    if (kind === 'sparse') q.identities.extra = Array(1);
    if (kind === 'cycle') q.identities.extra = q;
    if (kind === 'deep') { let x = q.identities; for (let i = 0; i < 34; i++) x = x.deep = {}; }
    const value = kind === 'proxy' ? new Proxy(q, { ownKeys() { calls++; return []; } }) : q;
    await assert.rejects(() => c.collectLifecycle(value), refused); assert.equal(calls, 0); assert.equal(f.calls.length, 0);
  });
}
test('R05a2c2b response getters and proxies refuse without execution or raw diagnostics', async () => {
  for (const proxy of [false, true]) {
    const f = fixture(); let calls = 0;
    f.transport.read = async () => proxy ? new Proxy({}, { ownKeys() { calls++; return []; } })
      : Object.defineProperty({}, 'value', { enumerable: true, get() { calls++; throw new Error('synthetic-private-sentinel'); } });
    await assert.rejects(() => life(collector(f), f), refused); assert.equal(calls, 0);
  }
});
test('R05a2c2b clones inputs before awaits, freezes selectors and detaches transport responses', async () => {
  const f = fixture(true); let mutated = false;
  const baseRead = f.transport.read;
  f.transport.read = async q => {
    assert.equal(Object.isFrozen(q.frame), true);
    assert.throws(() => q.project = 'other', TypeError);
    const response = await baseRead(q);
    if (!mutated) { mutated = true; f.identities.db = h(20); }
    return response;
  };
  const c = collector(f); const q = { request: 1, identities: f.identities }; const raw = await c.collectRawActive(q);
  assert.equal(raw.containers[0].Id, h(4));
  f.metadata.root.mode = 0; f.config.projected.services.db.public_env_bindings.POSTGRES_DB = 'changed';
  assert.equal(raw.root.mode, 0o700); assert.equal(raw.config.services.db.public_env_bindings.POSTGRES_DB, 'luson');
});
test('R05a2c2b factory getters and unpinned active identifiers deny before reads', async () => {
  let calls = 0; const f = fixture(true);
  const input = { labelPolicy: policy, transport: f.transport };
  Object.defineProperty(input, 'manifest', { enumerable: true, get() { calls++; return f.manifest; } });
  assert.throws(() => createR05Collector(input), refused); assert.equal(calls, 0);
  f.manifest.services.app.user = '';
  assert.throws(() => collector(f), refused); assert.equal(f.calls.length, 0);
  const good = fixture(true), c = collector(good); good.identities.db = h(20);
  await assert.rejects(() => c.collectRawActive({ request: 1, identities: good.identities }), refused);
  assert.equal(good.calls.length, 0);
});
test('R05a2c2b replayed transport correlation and completeness flags are not evidence', async () => {
  for (const kind of ['frame', 'metadataFlag', 'censusFlag', 'dsnHash']) {
    const f = fixture(), base = f.transport.read;
    f.transport.read = async q => {
      const response = await base(q);
      if (kind === 'frame') response.frame.request++;
      if (kind === 'metadataFlag' && q.kind === 'metadata') response.value.rootValid = true;
      if (kind === 'censusFlag' && q.kind === 'census') response.value.complete = true;
      if (kind === 'dsnHash' && q.kind === 'metadata') response.value.files[1].sha256 = h(20);
      return response;
    };
    await assert.rejects(() => life(collector(f), f), refused);
    assert.equal(f.calls.some(q => ['container', 'volume', 'network', 'image'].includes(q.kind)), false);
  }
});
test('R05a2c2b response ID mismatch cannot adopt census candidate by its planned name', async () => {
  const f = fixture(), c = collector(f); await life(c, f); f.networkPresence();
  const pending = pendingFor(f, 'network', 1); pending.result.id = h(20);
  await assert.rejects(() => life(c, f, 2, pending), refused);
  assert.equal(f.calls.some(q => q.kind === 'network'), false);
});
test('R05a2c2b stopped active SQL never reaches injected dispatch', async () => {
  const f = fixture(true), c = collector(f); let effects = 0;
  f.resources.containers[h(4)].State = { Status: 'exited', Running: false };
  const driver = createR05Driver({ manifest: f.manifest, labelPolicy: policy,
    collectRaw: context => c.collectRawActive({ request: context.request, identities: f.identities }),
    dispatchRaw: async () => effects++ });
  await assert.rejects(() => driver.sql({ text: 'SELECT $1', values: [17] }), e => e.message === 'R05 admission refused.');
  assert.equal(effects, 0);
});
