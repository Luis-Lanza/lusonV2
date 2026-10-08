import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createR05FilesystemMetadataReader } from './r05-filesystem-metadata.mjs';
import { createR05Collector } from './r05-collector.mjs';
import { digest } from './r05-binding.mjs';
import { projectR05PublicConfig } from './r05-config-projection.mjs';
import { mkdtemp, writeFile, lstat, open, unlink, rmdir, symlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
const sha = b => createHash('sha256').update(b).digest('hex');
const clone = v => structuredClone(v);
const refused = e => e.message === 'R05 filesystem metadata refused.' && e.cause === undefined;
function fixture() {
  const root = '/controlled/r05', body = Buffer.from('public compose snapshot');
  const approval = { project: 'luson-r05-abcdef0123456789', root, uid: 1000,
    manifest: root+'/manifest', dsn: root+'/dsn', sources: [{ path: root+'/compose', sha256: sha(body) }] };
  const paths = [root, approval.manifest, approval.dsn, approval.sources[0].path];
  const stats = new Map(['/', '/controlled', ...paths].map((path, i) => [path,
    { device: 1n, inode: BigInt(i+1), uid: path.startsWith(root) ? 1000n : 0n,
      mode: BigInt(path === root ? 0o700 : paths.includes(path) ? 0o600 : 0o755),
      type: paths.includes(path) && path !== root ? 'file' : 'directory', symlink: false }]));
  const owned = new Map(), calls = [], closed = [], reads = []; let hook = async () => {};
  const fs = {
    lstat: async p => { calls.push(['lstat', p]); await hook('lstat', p); return clone(stats.get(p)); },
    open: async (p, options) => { calls.push(['open', p, options]); await hook('open', p);
      const token = {}; owned.set(token, p); return token; },
    stat: async token => { const p = owned.get(token); calls.push(['stat', p]); await hook('stat', p); return clone(stats.get(p)); },
    read: async (token, options) => { const p = owned.get(token); reads.push([p, token, options]);
      await hook('read', p); return Buffer.from(body.subarray(options.offset, options.offset+options.length)); },
    close: async token => { const p = owned.get(token); closed.push(p); await hook('close', p); owned.delete(token); }
  };
  const request = { kind: 'metadata', project: approval.project,
    frame: { mode: 'lifecycle', attempt: 1, sequence: 1, request: 1 }, paths, source_paths: [approval.sources[0].path] };
  const file = (path, hashed = false) => ({ path, uid: 1000, mode: 0o600, type: 'file', symlink: false,
    ...(hashed ? { sha256: sha(body) } : {}) });
  const expected = { root: { path: root, uid: 1000, mode: 0o700, type: 'directory', symlink: false },
    files: [file(approval.manifest), file(approval.dsn), file(approval.sources[0].path, true)],
    sources: [file(approval.sources[0].path, true)] };
  return { approval, fs, request, expected, stats, calls, closed, owned, reads, body,
    hook: fn => { hook = fn; }, reader: () => createR05FilesystemMetadataReader({ ...approval, fs }) };
}
test('R05a2e1 first valid collector-compatible metadata reply', async () => {
  const f = fixture(); const reply = await f.reader().read(f.request);
  assert.deepEqual(reply.frame, f.request.frame);
  assert.deepEqual({ root: reply.value.root, files: reply.value.files, sources: reply.value.sources }, f.expected);
  assert.deepEqual(reply.value.handles.map(h => h.path), f.request.paths);
});
const requestCases = {
  project: q => { q.project += '0'; }, root: q => { q.paths[0] += 'other'; },
  reference: q => { q.paths[1] = q.paths[2]; }, source: q => { q.source_paths[0] += 'other'; },
  order: q => { q.paths.reverse(); }, duplicate: q => { q.source_paths.push(q.source_paths[0]); },
  kind: q => { q.kind = 'census'; }, frameMode: q => { q.frame.mode = 'prepare'; },
  frameSequence: q => { q.frame.sequence = 2; }, frameExtra: q => { q.frame.extra = 1; },
  frameAttempt: q => { q.frame.attempt = 0; }, extra: q => { q.config = {}; }
};
for (const [name, change] of Object.entries(requestCases)) test('R05a2e1 before-IO selector '+name, async () => {
  const f = fixture(), reader = f.reader(); change(f.request);
  await assert.rejects(reader.read(f.request), refused); assert.equal(f.calls.length, 0);
});
const approvalCases = {
  relative: a => { a.root = 'relative'; }, noncanonical: a => { a.manifest += '/..'; },
  duplicate: a => { a.dsn = a.manifest; }, outside: a => { a.sources[0].path = '/outside'; },
  nested: a => { a.sources[0].path += '/child'; }, badSHA: a => { a.sources[0].sha256 = 'bad'; },
  badUID: a => { a.uid = -1; }, exotic: a => Object.setPrototypeOf(a, null),
  sparse: a => { a.sources.length = 2; }, extra: a => { a.private = 'synthetic'; }
};
for (const [name, change] of Object.entries(approvalCases)) test('R05a2e1 unsafe approval '+name, () => {
  const f = fixture(), input = { ...f.approval, fs: f.fs }; change(input);
  assert.throws(() => createR05FilesystemMetadataReader(input), refused); assert.equal(f.calls.length, 0);
});
test('R05a2e1 getters proxies and exotic records never invoke traps', async () => {
  const f = fixture(); let invoked = 0;
  const getter = { get root() { invoked++; throw Error('synthetic body'); } };
  const proxy = new Proxy({}, { ownKeys() { invoked++; throw Error('synthetic body'); } });
  for (const value of [getter, proxy, new Date()]) {
    assert.throws(() => createR05FilesystemMetadataReader(value), refused);
    await assert.rejects(f.reader().read(value), refused);
  }
  const cap = { ...f.fs }; Object.defineProperty(cap, 'open', { enumerable: true, get() { invoked++; } });
  assert.throws(() => createR05FilesystemMetadataReader({ ...f.approval, fs: cap }), refused);
  f.fs.stat = async () => getter;
  await assert.rejects(f.reader().read(f.request), refused);
  assert.equal(invoked, 0); assert.equal(f.closed.length, 1);
});
test('R05a2e1 caller snapshots and output are detached deeply frozen JSON', async () => {
  const f = fixture(), reader = f.reader(), q = clone(f.request);
  f.approval.sources[0].sha256 = 'bad'; f.approval.root = '/elsewhere';
  const pending = reader.read(q); q.frame.attempt = 99; q.paths.reverse();
  const reply = await pending; assert.deepEqual(reply.frame, f.request.frame);
  assert.equal(JSON.stringify(reply).includes('public compose snapshot'), false);
  assert.throws(() => { reply.value.handles[0].ancestors[0].mode = 0; }, TypeError);
  assert.deepEqual(JSON.parse(JSON.stringify(reply)), reply);
  assert.deepEqual(reply.value.handles[0].ancestors.map(a => a.path), ['/', '/controlled']);
  assert.equal(f.owned.size, 0); assert.equal(f.closed.length, 6);
  assert.ok(f.calls.filter(c => c[0] === 'open').every(c => Object.isFrozen(c[2]) && c[2].readonly && c[2].nofollow && c[2].nonblock && c[2].bigint));
  assert.ok(f.reads.every(([p, token]) => p === f.request.source_paths[0] && f.calls.some(c => c[0] === 'stat' && c[1] === p) && token));
  assert.equal(new Set(f.reads.map(r => r[1])).size, 1);
});
const statCases = {
  zeroDevice: s => { s.device = 0n; }, negativeInode: s => { s.inode = -1n; },
  overflowInode: s => { s.inode = BigInt(Number.MAX_SAFE_INTEGER)+1n; },
  floatDevice: s => { s.device = 1.5; }, negativeUID: s => { s.uid = -1n; },
  overflowUID: s => { s.uid = BigInt(Number.MAX_SAFE_INTEGER)+1n; },
  wrongOwner: s => { s.uid = 1001n; }, fullSpecialMode: s => { s.mode = 0o4700n; },
  overflowMode: s => { s.mode = 0o10000n; }, symlink: s => { s.symlink = true; },
  type: s => { s.type = 'socket'; }, undefinedField: s => { s.inode = undefined; },
  coercion: s => { s.device = { valueOf() { throw Error('must not execute'); } }; }
};
for (const [name, change] of Object.entries(statCases)) test('R05a2e1 stat bounds '+name, async () => {
  const f = fixture(); change(f.stats.get(f.approval.root));
  await assert.rejects(f.reader().read(f.request), refused); assert.equal(f.owned.size, 0);
});
for (const [name, path, change] of [
  ['slash group-write', '/', s => { s.mode = 0o775n; }],
  ['ancestor owner', '/controlled', s => { s.uid = 2000n; }],
  ['reference special bits', '/controlled/r05/dsn', s => { s.mode = 0o4600n; }]
]) test('R05a2e1 '+name, async () => {
  const f = fixture(); change(f.stats.get(path)); await assert.rejects(f.reader().read(f.request), refused);
  assert.equal(f.owned.size, 0); assert.equal(f.reads.length, 0);
});
test('R05a2e1 exact safe BigInt maximum and full ancestor special bits retained', async () => {
  const f = fixture(); Object.assign(f.stats.get('/'), { device: BigInt(Number.MAX_SAFE_INTEGER), mode: 0o4755n });
  const reply = await f.reader().read(f.request);
  assert.equal(reply.value.handles[0].ancestors[0].device, Number.MAX_SAFE_INTEGER);
  assert.equal(reply.value.handles[0].ancestors[0].mode, 0o4755);
});
for (const phase of ['opened', 'after-open', 'repeat-ancestor', 'post-read']) test('R05a2e1 drift '+phase, async () => {
  const f = fixture(); let count = 0;
  f.hook(async (op, p) => {
    if (phase === 'opened' && op === 'stat' && p === '/') f.stats.get(p).inode++;
    if (phase === 'after-open' && op === 'lstat' && p === '/' && ++count === 2) f.stats.get(p).mode = 0o750n;
    if (phase === 'repeat-ancestor' && op === 'read') f.stats.get('/').inode++;
    if (phase === 'post-read' && op === 'read') f.stats.get(p).mode = 0o400n;
  });
  await assert.rejects(f.reader().read(f.request), refused); assert.equal(f.owned.size, 0);
});
for (const payload of ['oversized-chunk', 'infinite-bytes', 'text', 'proxy', 'wrong-hash']) test('R05a2e1 source refusal '+payload, async () => {
  const f = fixture(); let reads = 0;
  f.fs.read = async () => { reads++;
    if (payload === 'text') return 'public text';
    if (payload === 'proxy') return new Proxy(Buffer.from('x'), {});
    return Buffer.alloc(payload === 'oversized-chunk' ? 65537 : payload === 'infinite-bytes' ? 65536 : 0);
  };
  await assert.rejects(f.reader().read(f.request), refused);
  assert.ok(reads <= 17); assert.equal(f.closed.length, 6); assert.equal(f.owned.size, 0);
});
test('R05a2e1 every acquisition registered before bad stat and every close attempted', async () => {
  const f = fixture(); f.hook(async (op, p) => {
    if (op === 'stat' && p.endsWith('/dsn')) throw Error('synthetic private diagnostic');
    if (op === 'close' && p === '/') throw Error('synthetic private diagnostic');
  });
  const reader = f.reader(); await assert.rejects(reader.read(f.request), refused);
  assert.deepEqual(f.closed, ['/', '/controlled', f.approval.root, f.approval.manifest, f.approval.dsn]);
  assert.deepEqual(reader.status(), { busy: false, quarantined: true, owned: 1 });
  const before = f.calls.length; await assert.rejects(reader.read(f.request), refused);
  assert.equal(f.calls.length, before); assert.equal(f.owned.size, 1);
});
for (const token of [17, null, new Date(), new Proxy({}, {})]) test('R05a2e1 malformed handle safety '+String(token === null ? 'null' : typeof token), async () => {
  const f = fixture(); let closes = 0;
  f.fs.open = async () => token; f.fs.close = async v => { assert.equal(v, token); closes++; };
  const reader = f.reader(); await assert.rejects(reader.read(f.request), refused);
  assert.equal(closes, token !== null && typeof token === 'object' ? 1 : 0);
  assert.equal(reader.status().quarantined, closes === 0);
});
test('R05a2e1 busy until late closure refusal; no retry or success overwrite', async () => {
  const f = fixture(); let release, entered;
  const closing = new Promise(resolve => { entered = resolve; });
  f.hook(async (op, p) => { if (op === 'close' && p === '/') { entered(); await new Promise(resolve => { release = resolve; }); throw Error('unknown closure'); } });
  const reader = f.reader(), pending = reader.read(f.request); await closing;
  assert.deepEqual(reader.status(), { busy: true, quarantined: false, owned: 6 });
  const before = f.calls.length; await assert.rejects(reader.read(f.request), refused); assert.equal(f.calls.length, before);
  release(); await assert.rejects(pending, refused);
  assert.equal(f.closed.length, 6); assert.equal(reader.status().owned, 1);
  await assert.rejects(reader.read(f.request), refused); assert.equal(f.closed.length, 6);
});
test('R05a2e1 nested DTO and raw stat descriptors refuse without invocation', async () => {
  const f = fixture(); let invoked = 0;
  const proxy = new Proxy({}, { getPrototypeOf() { invoked++; throw Error('trap'); } });
  const getter = () => { invoked++; throw Error('getter'); };
  const bad = { ...f.stats.get('/') }; Object.defineProperty(bad, 'uid', { enumerable: true, get: getter });
  for (const raw of [bad, proxy, Object.create(null), { ...f.stats.get('/'), device: { valueOf: getter } }]) {
    f.fs.stat = async () => raw; await assert.rejects(f.reader().read(f.request), refused);
  }
  const q = clone(f.request); q.frame = proxy; await assert.rejects(f.reader().read(q), refused);
  const approval = { ...f.approval, sources: [{ path: f.approval.sources[0].path, get sha256() { return getter(); } }], fs: f.fs };
  assert.throws(() => createR05FilesystemMetadataReader(approval), refused); assert.equal(invoked, 0);
});
test('R05a2e1 hostile byte accessors ignored by intrinsic byte validation', async () => {
  const f = fixture(); let invoked = 0;
  f.fs.read = async (token, q) => {
    const b = Buffer.from(f.body.subarray(q.offset, q.offset+q.length));
    Object.defineProperty(b, 'byteLength', { get() { invoked++; throw Error('getter'); } });
    return b;
  };
  await f.reader().read(f.request); assert.equal(invoked, 0); assert.equal(f.owned.size, 0);
});
test('R05a2e1 source total checked before copying extra byte', async () => {
  const f = fixture(); let reads = 0;
  f.fs.read = async () => { reads++; return Buffer.alloc(reads <= 16 ? 65536 : 1); };
  await assert.rejects(f.reader().read(f.request), refused); assert.equal(reads, 17); assert.equal(f.owned.size, 0);
});
test('R05a2e1 multiple unknown closes retain each reference with count-only status', async () => {
  const f = fixture(); f.hook(async op => { if (op === 'close') throw Error('synthetic private body'); });
  const reader = f.reader(); await assert.rejects(reader.read(f.request), refused);
  assert.equal(f.closed.length, 6); assert.deepEqual(reader.status(), { busy: false, quarantined: true, owned: 6 });
  assert.deepEqual(Object.keys(reader), ['read', 'status']); assert.ok(Object.isFrozen(reader.status()));
});
test('R05a2e1 open failure closes prior handles; duplicate token never double closes', async () => {
  const f = fixture(); f.hook(async (op, p) => { if (op === 'open' && p.endsWith('/manifest')) throw Error('open failed'); });
  await assert.rejects(f.reader().read(f.request), refused); assert.equal(f.closed.length, 3); assert.equal(f.owned.size, 0);
  const g = fixture(), token = {}; let closes = 0;
  g.fs.open = async () => token; g.fs.stat = async () => g.stats.get('/');
  g.fs.close = async v => { assert.equal(v, token); closes++; };
  await assert.rejects(g.reader().read(g.request), refused); assert.equal(closes, 1);
});
test('R05a2e1 source byte boundary and active frame; no reference content reads', async () => {
  const f = fixture(), body = Buffer.alloc(1024*1024, 65);
  f.approval.sources[0].sha256 = sha(body); f.request.frame = { mode: 'active', attempt: 3, sequence: 2, request: 7 };
  f.fs.read = async (token, q) => {
    assert.equal(f.owned.get(token), f.request.source_paths[0]);
    return body.subarray(q.offset, q.offset+q.length);
  };
  const reply = await f.reader().read(f.request);
  assert.equal(reply.value.files[2].sha256, sha(body)); assert.deepEqual(reply.value.files[2], reply.value.sources[0]);
  assert.deepEqual(reply.frame, f.request.frame); assert.equal(f.owned.size, 0);
});
test('R05a2e1 multiple public sources retain order and use distinct owned FDs', async () => {
  const f = fixture(), path = f.approval.root+'/second';
  f.approval.sources.push({ path, sha256: sha(f.body) }); f.request.paths.push(path); f.request.source_paths.push(path);
  f.stats.set(path, { ...f.stats.get(f.approval.dsn), inode: 99n });
  const reply = await f.reader().read(f.request);
  assert.deepEqual(reply.value.sources.map(s => s.path), f.request.source_paths);
  assert.equal(new Set(f.reads.map(r => r[1])).size, 2); assert.equal(f.closed.length, 7); assert.equal(f.owned.size, 0);
});
test('R05a2e1 actual collector executes repeated metadata binding', async () => {
  const f = fixture(), reader = f.reader(), run_id = 'abcdef0123456789';
  const original = { services: {
    app: { environment: { LUSON_APP_UID: '1000', LUSON_APP_GID: '1000', LUSON_PROFILE: 'local-trial',
      LUSON_DATABASE_URL_FILE: '/run/secrets/database_url', LUSON_ORIGIN: 'https://localhost:8443',
      LUSON_LISTEN: '0.0.0.0:8443', LUSON_TLS_CERT: '/run/secrets/tls_cert',
      LUSON_TLS_KEY: '/run/secrets/tls_key', LUSON_WEB_DIR: '/srv/web' },
      secrets: ['database_url', 'tls_cert', 'tls_key'], depends_on: { db: { condition: 'service_healthy' } } },
    db: { environment: { POSTGRES_USER: 'luson', POSTGRES_DB: 'luson', POSTGRES_PASSWORD_FILE: '/run/secrets/database_password' },
      secrets: ['database_password'] } },
    secrets: Object.fromEntries(['database_url', 'database_password', 'tls_cert', 'tls_key'].map(n => [n, { file: f.approval.root+'/'+n }])) };
  const projected = projectR05PublicConfig(original), h = 'a'.repeat(64), project = f.approval.project;
  const manifest = { schema: 'luson.r05/v1', phase: 'prepare', run_id, project, uid: 1000, root: f.approval.root,
    manifest: f.expected.files[0], dsn: f.expected.files[1], sources: f.expected.sources,
    labels: { scope: 'transfer-requests/R05', run_id }, config_digest: digest(projected),
    network: { name: project+'-net', id: null }, volume: { name: project+'-data', id: null },
    services: { app: { id: null, image: h, compose_hash: h, user: '1000:1000', readonly: true,
      ports: [{ host: '127.0.0.1', published: 9443, target: 8443 }],
      mounts: [{ source: f.approval.dsn, target: '/run/secrets/database_url', kind: 'bind', readonly: true }] },
    db: { id: null, image: h, compose_hash: h, user: '', readonly: false, ports: [],
      mounts: [{ source: project+'-data', target: '/var/lib/postgresql/data', kind: 'volume', readonly: false }] } } };
  const transport = { read: async q => {
    if (q.kind === 'metadata') return reader.read(q);
    assert.ok(['public-config', 'census'].includes(q.kind));
    return { frame: q.frame, value: q.kind === 'public-config' ? { original, projected, service_hashes: { app: h, db: h } }
      : { project_ids: [], volume_users: [], containers: [], network: null, volume: null, conflicts: [] } };
  } };
  const collector = createR05Collector({ manifest, transport,
    labelPolicy: { scopeKey: 'org.luson.scope', runKey: 'org.luson.run', reservedOwnerKeys: ['org.luson.scope', 'org.luson.run'] } });
  const result = await collector.collectLifecycle({ sequence: 1, identities: { network: null, volume: null, db: null, app: null }, pending: null });
  assert.equal(result.sequence, 1); assert.deepEqual(result.sources, f.expected.sources);
  assert.equal(f.closed.length, 12); assert.equal(f.owned.size, 0);
});
test('R05a2e1 OWN synthetic native fixture verifies real ancestry, same FD and closures', async () => {
  const root = await mkdtemp(resolve('apps/web/e2e/.r05a2e1-'));
  const names = ['manifest', 'dsn', 'compose'], body = Buffer.from('PUBLIC synthetic bytes only');
  const handles = new Map(), reads = [], closures = []; let opened = 0, reader;
  const raw = s => ({ device: s.dev, inode: s.ino, uid: s.uid, mode: s.mode & 0o7777n,
    type: s.isDirectory() ? 'directory' : s.isFile() ? 'file' : 'unsupported', symlink: s.isSymbolicLink() });
  try {
    for (const name of names) await writeFile(root+'/'+name, body, { mode: 0o600, flag: 'wx' });
    const fs = {
      lstat: async p => raw(await lstat(p, { bigint: true })),
      open: async (p, q) => {
        assert.deepEqual(q, { readonly: true, nofollow: true, nonblock: true, directory: p === root || !p.startsWith(root+'/'), bigint: true });
        const fd = await open(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (q.directory ? constants.O_DIRECTORY : 0));
        const token = {}; handles.set(token, { fd, path: p }); opened++; return token;
      },
      stat: async token => raw(await handles.get(token).fd.stat({ bigint: true })),
      read: async (token, q) => { const h = handles.get(token); reads.push(h.path);
        const b = Buffer.alloc(q.length), { bytesRead } = await h.fd.read(b, 0, q.length, q.offset); return b.subarray(0, bytesRead); },
      close: async token => { const h = handles.get(token); await h.fd.close(); closures.push(h.path); handles.delete(token); }
    };
    const approval = { project: 'luson-r05-abcdef0123456789', root, uid: process.getuid(),
      manifest: root+'/manifest', dsn: root+'/dsn', sources: [{ path: root+'/compose', sha256: sha(body) }], fs };
    reader = createR05FilesystemMetadataReader(approval);
    const q = { kind: 'metadata', project: approval.project, frame: { mode: 'lifecycle', attempt: 1, sequence: 1, request: 1 },
      paths: [root, approval.manifest, approval.dsn, root+'/compose'], source_paths: [root+'/compose'] };
    const reply = await reader.read(q);
    assert.equal(reply.value.sources[0].sha256, sha(body)); assert.ok(reads.every(p => p === root+'/compose'));
    assert.equal(handles.size, 0); assert.equal(opened, closures.length);
    console.log('R05a2e1 OWN native FD acquisitions='+opened+' confirmed closures='+closures.length+' retained=0');
    await symlink('compose', root+'/link'); approval.sources = [{ path: root+'/link', sha256: sha(body) }];
    const linkReader = createR05FilesystemMetadataReader(approval); q.paths[3] = root+'/link'; q.source_paths[0] = root+'/link';
    await assert.rejects(linkReader.read(q), refused); assert.equal(handles.size, 0); assert.equal(opened, closures.length);
    console.log('R05a2e1 OWN native including symlink refusal acquisitions='+opened+' confirmed closures='+closures.length+' retained=0');
  } finally {
    // Unknown closure must retain ownership; never unlink an unconfirmed live fixture.
    assert.equal(handles.size, 0); if (reader) assert.equal(reader.status().quarantined, false);
    for (const name of [...names, 'link']) {
      try { await unlink(root+'/'+name); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    await rmdir(root);
  }
});
