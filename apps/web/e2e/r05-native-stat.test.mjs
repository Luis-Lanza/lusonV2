import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { projectR05NativeStat } from './r05-native-stat.mjs';
import { createR05FilesystemMetadataReader } from './r05-filesystem-metadata.mjs';

const MAX = BigInt(Number.MAX_SAFE_INTEGER);
class SyntheticStats {
  constructor(fields = {}) {
    Object.assign(this, { dev: 1n, ino: 2n, uid: 1000n, mode: 0o100600n }, fields);
    this.mtime = new Date(0);
  }
  isFile() { throw new Error('Must not invoke methods'); }
  isDirectory() { throw new Error('Must not invoke methods'); }
}

test('R05a2e2a first exact frozen DTO from Stats-shaped selected data', () => {
  const raw = new SyntheticStats();
  Object.defineProperty(raw, 'ctime', { get() { assert.fail('Unused getter invoked'); } });
  const row = projectR05NativeStat(raw);
  assert.deepEqual(row, { device: 1, inode: 2, uid: 1000, mode: 0o600, type: 'file', symlink: false });
  assert.ok(Object.isFrozen(row));
  assert.equal(JSON.stringify(row), '{"device":1,"inode":2,"uid":1000,"mode":384,"type":"file","symlink":false}');
});

const refused = raw => assert.throws(() => projectR05NativeStat(raw), error =>
  error.constructor === Error && error.message === 'R05 native stat refused.');

for (const field of ['dev', 'ino', 'uid', 'mode']) {
  for (const value of [undefined, null, 1, 1.5, NaN, Infinity, '1', Object(1n),
    { valueOf() { assert.fail('Coercion invoked'); } }]) {
    test(`R05a2e2a ${field} rejects wrong scalar ${String(typeof value)} ${String(value === null)}`, () => {
      refused(new SyntheticStats({ [field]: value }));
    });
  }
  test(`R05a2e2a ${field} missing inherited and accessor data refuse without invocation`, () => {
    const raw = new SyntheticStats();
    delete raw[field];
    refused(raw);
    Object.setPrototypeOf(raw, { [field]: 1n });
    refused(raw);
    Object.defineProperty(raw, field, { get() { assert.fail('Selected getter invoked'); } });
    refused(raw);
  });
}
for (const field of ['dev', 'ino']) {
  for (const value of [0n, -1n, MAX + 1n]) {
    test(`R05a2e2a ${field} refuses out of bounds ${value}`, () => refused(new SyntheticStats({ [field]: value })));
  }
  test(`R05a2e2a ${field} exact maximum`, () => {
    assert.equal(projectR05NativeStat(new SyntheticStats({ [field]: MAX }))[
      field === 'dev' ? 'device' : 'inode'], Number.MAX_SAFE_INTEGER);
  });
}
for (const uid of [0n, MAX]) {
  for (const mode of [0o100000n, 0o040700n]) {
    test(`R05a2e2a UID ${uid} allowed independently of root policy ${mode}`, () => {
      assert.equal(projectR05NativeStat(new SyntheticStats({ uid, mode })).uid, Number(uid));
    });
  }
}
for (const uid of [-1n, MAX + 1n]) {
  test(`R05a2e2a UID refuses ${uid}`, () => refused(new SyntheticStats({ uid })));
}
for (const mode of [0n, 0o7777n, -1n, 0o200000n, 0o177777n, 0o120600n,
  0o010600n, 0o060600n, 0o020600n, 0o140600n, 0o030600n, 0o110600n]) {
  test(`R05a2e2a refuses unsupported full native mode ${mode}`, () => refused(new SyntheticStats({ mode })));
}
for (const [bits, type] of [[0o100000n, 'file'], [0o040000n, 'directory']]) {
  for (const permissions of [0n, 0o600n, 0o700n, 0o4000n, 0o2000n, 0o1000n, 0o7777n]) {
    test(`R05a2e2a preserves all permission-special bits ${type} ${permissions}`, () => {
      const row = projectR05NativeStat(new SyntheticStats({ mode: bits | permissions }));
      assert.equal(row.type, type);
      assert.equal(row.mode, Number(permissions));
    });
  }
}
test('R05a2e2a refuses nonrecords and proxies before traps including revoked proxy', () => {
  for (const raw of [null, undefined, false, 1n, 'value', () => {}, []]) refused(raw);
  let traps = 0;
  const proxy = new Proxy(new SyntheticStats(), {
    get() { traps++; }, getOwnPropertyDescriptor() { traps++; },
    getPrototypeOf() { traps++; }, ownKeys() { traps++; },
  });
  refused(proxy);
  assert.equal(traps, 0);
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  refused(revoked.proxy);
});
test('R05a2e2a ignores prototype constructor methods and unrelated own fields', () => {
  const raw = Object.create(null);
  Object.defineProperties(raw, {
    dev: { value: 1n }, ino: { value: 2n }, uid: { value: 0n }, mode: { value: 0o040777n },
    isFile: { get() { assert.fail('Method property read'); } },
    isDirectory: { get() { assert.fail('Method property read'); } },
    constructor: { get() { assert.fail('Constructor read'); } },
  });
  assert.equal(projectR05NativeStat(raw).type, 'directory');
  Object.setPrototypeOf(raw, new Proxy({}, { get() { assert.fail('Prototype read'); } }));
  assert.equal(projectR05NativeStat(raw).uid, 0);
});
test('R05a2e2a detached immutable JSON without input mutation or native origin assertion', () => {
  const raw = new SyntheticStats();
  const before = Object.getOwnPropertyDescriptors(raw);
  const row = projectR05NativeStat(raw);
  assert.deepEqual(Object.getOwnPropertyDescriptors(raw), before);
  raw.dev = 99n;
  raw.mtime.setTime(1);
  assert.equal(row.device, 1);
  assert.throws(() => { row.uid = 9; }, TypeError);
  assert.deepEqual(JSON.parse(JSON.stringify(row)), row);
  assert.ok(Object.values(row).every(value => value === null || typeof value !== 'object'));
});

test('R05a2e2a actual projected rows compose with frozen metadata reader using only local fake capability', async () => {
  const root = '/public-r05-fixture';
  const project = 'luson-r05-0123456789abcdef';
  const source = `${root}/source.mjs`, manifest = `${root}/manifest`, dsn = `${root}/dsn`;
  const content = Buffer.from('public synthetic source\n');
  const sha256 = createHash('sha256').update(content).digest('hex');
  const paths = [root, manifest, dsn, source];
  const raw = new Map(['/', ...paths].map((path, index) => [path, new SyntheticStats({
    ino: BigInt(index + 1), uid: path === '/' ? 0n : 1000n,
    mode: path === '/' ? 0o040755n : path === root ? 0o040700n : 0o100600n,
  })]));
  const opened = new Map(), closed = [];
  const reader = createR05FilesystemMetadataReader({ project, root, uid: 1000, manifest, dsn,
    sources: [{ path: source, sha256 }], fs: {
      async lstat(path) { return projectR05NativeStat(raw.get(path)); },
      async open(path) { const token = {}; opened.set(token, path); return token; },
      async stat(token) { return projectR05NativeStat(raw.get(opened.get(token))); },
      async read(token, { offset, length }) {
        assert.equal(opened.get(token), source, 'References are metadata only');
        return content.subarray(offset, offset + length);
      },
      async close(token) { assert.ok(opened.has(token)); closed.push(opened.get(token)); opened.delete(token); },
    } });
  const frame = { mode: 'active', attempt: 1, sequence: 1, request: 1 };
  const reply = await reader.read({ kind: 'metadata', project, frame, paths, source_paths: [source] });
  assert.equal(opened.size, 0, 'Every fake acquisition closed before publication');
  assert.deepEqual(closed, ['/', ...paths]);
  assert.deepEqual(reader.status(), { busy: false, quarantined: false, owned: 0 });
  assert.deepEqual(reply.frame, frame);
  assert.equal(reply.value.root.mode, 0o700);
  assert.ok(reply.value.files.every(row => row.mode === 0o600));
  assert.equal(reply.value.files.find(row => row.path === source).sha256, sha256);
  assert.equal(reply.value.sources[0].sha256, sha256);
  assert.ok(reply.value.files.filter(row => row.path !== source).every(row => !Object.hasOwn(row, 'sha256')));
  for (const handle of reply.value.handles) {
    const projected = projectR05NativeStat(raw.get(handle.path));
    assert.equal(handle.device, projected.device);
    assert.equal(handle.inode, projected.inode);
    assert.deepEqual(handle.opened, { device: projected.device, inode: projected.inode });
    assert.equal(handle.ancestors[0].path, '/');
    assert.ok(Object.isFrozen(handle));
  }
  assert.ok(Object.isFrozen(reply.value.sources[0]));
});
