import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, chmod, lstat, unlink, rmdir, symlink, readFile, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createR05SelectedNodeReaders } from './r05-selected-node.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const project = 'luson-r05-abcdef0123456789';
const body = Buffer.from('PUBLIC R05a2f1 synthetic source bytes\n');
function binding() {
  return { project, volumeName: project+'-data', images: {
    app: 'a'.repeat(64), db: 'b'.repeat(64),
  }, binary: '/public/explicit/docker', cwd: '/public/explicit', env: { LANG: 'C' } };
}
function input(root = '/public/explicit/root') {
  return { approval: { project, root, uid: process.getuid(), manifest: root+'/manifest',
    dsn: root+'/dsn', sources: [{ path: root+'/source', sha256: sha(body) }] }, process: binding() };
}
function request(a) {
  return { kind: 'metadata', project,
    frame: { mode: 'lifecycle', attempt: 1, sequence: 1, request: 1 },
    paths: [a.root, a.manifest, a.dsn, ...a.sources.map(s => s.path)],
    source_paths: a.sources.map(s => s.path) };
}
function ancestors(path) {
  const result = [];
  for (let p = dirname(path); ; p = dirname(p)) {
    result.unshift(p);
    if (p === '/') return result;
  }
}
async function expected(q) {
  const paths = [...new Set(q.paths.flatMap(p => [...ancestors(p), p]))];
  const stats = new Map(await Promise.all(paths.map(async path => {
    const s = await lstat(path, { bigint: true });
    return [path, { device: Number(s.dev), inode: Number(s.ino), uid: Number(s.uid),
      mode: Number(s.mode & 0o7777n), type: s.isDirectory() ? 'directory' : 'file', symlink: false }];
  })));
  const row = path => {
    const { uid, mode, type, symlink } = stats.get(path);
    return { path, uid, mode, type, symlink,
      ...(q.source_paths.includes(path) ? { sha256: sha(body) } : {}) };
  };
  return { frame: q.frame, value: { root: row(q.paths[0]), files: q.paths.slice(1).map(row),
    sources: q.source_paths.map(row), handles: q.paths.map(path => {
      const { device, inode } = stats.get(path);
      return { path, device, inode, opened: { device, inode },
        ancestors: ancestors(path).map(p => ({ path: p, ...stats.get(p) })) };
    }) } };
}

async function identity(path) {
  const s = await lstat(path, { bigint: true });
  const type = s.isSymbolicLink() ? 'symlink' : s.isDirectory() ? 'directory' : s.isFile() ? 'file' : 'other';
  // Directory link counts change when other authorized suites create sibling fixtures.
  return { dev: s.dev, ino: s.ino, uid: s.uid, mode: s.mode, type,
    ...(type === 'directory' ? {} : { nlink: s.nlink }) };
}
async function publicFixture() {
  const root = await mkdtemp(resolve('apps/web/e2e/.r05a2f1-'));
  // Ownership begins immediately; only successful creations enter this exact-child ledger.
  const children = new Map(), parents = new Map();
  const f = { root, readEntered: false, closureConfirmed: false };
  let retained = false;
  let rootIdentity;
  async function gates() {
    for (const [path, saved] of parents) assert.deepEqual(await identity(path), saved);
    assert.deepEqual(await identity(root), rootIdentity);
    assert.deepEqual((await readdir(root)).sort(), [...children.keys()].sort());
    for (const [name, saved] of children) assert.deepEqual(await identity(root+'/'+name), saved);
  }
  f.cleanupOwned = async () => {
    assert.ok(!retained && (!f.readEntered || f.closureConfirmed),
      'unconfirmed native ownership retains fixture');
    for (const name of [...children.keys()]) {
      await gates();
      await unlink(root+'/'+name);
      children.delete(name);
    }
    await gates();
    await rmdir(root);
    await assert.rejects(lstat(root), error => error.code === 'ENOENT');
  };
  f.link = async () => {
    await symlink('source', root+'/link');
    children.set('link', null);
    children.set('link', await identity(root+'/link'));
  };
  f.read = async (reader, q) => {
    assert.ok(!retained && (!f.readEntered || f.closureConfirmed),
      'pending or UNKNOWN reads cannot be superseded by fresh closure evidence');
    f.readEntered = true;
    f.closureConfirmed = false; // Invalidate earlier evidence BEFORE entering every read.
    try {
      const reply = await reader.read(q);
      f.closureConfirmed = true; // Fulfilled read requires fulfilled closes in the frozen wrapper.
      return reply;
    } catch (error) {
      const status = reader.status();
      // This relies on the unchanged wrapper's settled-close contract, not an FD counter.
      f.closureConfirmed = !status.busy && !status.quarantined && status.owned === 0;
      if (!f.closureConfirmed) retained = true;
      throw error;
    }
  };
  f.run = async operation => {
    let result, original, failed = false;
    try {
      rootIdentity = await identity(root);
      assert.equal(rootIdentity.type, 'directory');
      assert.equal(rootIdentity.uid, BigInt(process.getuid()));
      for (const path of ancestors(root)) {
        const saved = await identity(path);
        assert.equal(saved.type, 'directory');
        assert.ok(saved.uid === 0n || saved.uid === rootIdentity.uid);
        assert.equal(saved.mode & 0o022n, 0n);
        parents.set(path, saved);
      }
      await chmod(root, 0o700);
      rootIdentity = await identity(root);
      for (const name of ['manifest', 'dsn', 'source']) {
        await writeFile(root+'/'+name, name === 'source' ? body : 'PUBLIC synthetic reference\n',
          { flag: 'wx', mode: 0o600 });
        children.set(name, null);
        const saved = await identity(root+'/'+name);
        children.set(name, saved);
        assert.equal(saved.type, 'file');
        assert.equal(saved.uid, rootIdentity.uid);
        assert.equal(saved.mode, 0o100600n);
        assert.equal(saved.nlink, 1n);
      }
      result = await operation(f);
    } catch (error) {
      original = error;
      failed = true;
    }
    let cleanupError;
    try {
      // Inert constructors/setup never entered read; they need no native close evidence.
      // Once a read starts, cleanupOwned requires fresh confirmed settlement instead.
      await f.cleanupOwned();
    } catch (error) {
      cleanupError = error;
      console.error('R05a2f1 OWN public fixture retained; cleanup evidence unconfirmed: '+root);
    }
    // Retention is reported separately and must never replace the operation's error.
    if (failed) throw original;
    if (cleanupError) throw cleanupError;
    return result;
  };
  return f;
}

test('R05a2f1 first complete real Node filesystem frame and source SHA', async () => {
  const fixture = await publicFixture();
  await fixture.run(async f => {
    const args = input(f.root), q = request(args.approval), want = await expected(q);
    const readers = createR05SelectedNodeReaders(args);
    const reply = await f.read(readers.filesystem, q);
    assert.deepEqual(reply, want);
    assert.equal(reply.value.sources[0].sha256, sha(body));
    assert.ok(reply.value.files.slice(0, 2).every(row => !('sha256' in row)));
    assert.ok(Object.isFrozen(reply) && Object.isFrozen(reply.value.sources[0]));
  });
});

const bridgeRefusal = e => e.message === 'R05 selected Node refused.' && e.cause === undefined;
const fsRefusal = e => e.message === 'R05 selected filesystem refused.' && e.cause === undefined;
const metadataRefusal = e => e.message === 'R05 selected metadata refused.' && e.cause === undefined;

test('R05a2f1 wrong-volume constructor refusal preserves error and removes OWN fixture', async () => {
  const fixture = await publicFixture();
  try {
    let original;
    try {
      await fixture.run(async f => {
        const args = input(f.root);
        args.process.volumeName += '-invalid';
        createR05SelectedNodeReaders(args);
      });
    } catch (error) { original = error; }
    // Absence is asserted first: the old gate's masked error cannot hide cleanup RED.
    await assert.rejects(lstat(fixture.root), error => error.code === 'ENOENT');
    assert.ok(bridgeRefusal(original), 'original constructor refusal must survive cleanup');
  } finally {
    // RED-only fallback: this exact newly created root never entered any native read.
    let exists = true;
    try { await lstat(fixture.root); }
    catch (error) { if (error.code === 'ENOENT') exists = false; else throw error; }
    if (exists) {
      assert.equal(fixture.readEntered, false);
      await fixture.cleanupOwned();
    }
  }
});

test('R05a2f1 prefixed-image constructor refusal preserves error and removes OWN fixture', async () => {
  const fixture = await publicFixture();
  await assert.rejects(fixture.run(async f => {
    const args = input(f.root);
    args.process.images.app = 'sha256:'+args.process.images.app;
    createR05SelectedNodeReaders(args);
  }), bridgeRefusal);
  await assert.rejects(lstat(fixture.root), error => error.code === 'ENOENT');
});

test('R05a2f1 bare image SHA constructor control removes never-read OWN fixture', async () => {
  const fixture = await publicFixture();
  await fixture.run(async f => {
    const readers = createR05SelectedNodeReaders(input(f.root));
    assert.ok(Object.isFrozen(readers));
    assert.equal(f.readEntered, false);
  });
  await assert.rejects(lstat(fixture.root), error => error.code === 'ENOENT');
});

test('R05a2f1 pre-read operation failure preserves exact error and removes OWN fixture', async () => {
  const fixture = await publicFixture(), original = new Error('PUBLIC synthetic operation refusal');
  await assert.rejects(fixture.run(async () => { throw original; }), error => error === original);
  await assert.rejects(lstat(fixture.root), error => error.code === 'ENOENT');
});

test('R05a2f1 construction is inert with explicit nonexistent public bindings', () => {
  const readers = createR05SelectedNodeReaders(input());
  assert.deepEqual(Object.keys(readers), ['filesystem', 'metadata']);
  assert.deepEqual(Object.keys(readers.filesystem), ['read', 'status']);
  assert.deepEqual(Object.keys(readers.metadata), ['read']);
  for (const value of [readers, readers.filesystem, readers.metadata, readers.filesystem.status()]) {
    assert.ok(Object.isFrozen(value));
  }
  assert.deepEqual(readers.filesystem.status(), { busy: false, quarantined: false, owned: 0 });
});

const invalidBindings = {
  projectMismatch: a => { a.process.project = 'luson-r05-'+'c'.repeat(16); },
  missingBinary: a => { delete a.process.binary; },
  relativeBinary: a => { a.process.binary = 'docker'; },
  missingCwd: a => { delete a.process.cwd; },
  relativeCwd: a => { a.process.cwd = '.'; },
  missingEnv: a => { delete a.process.env; },
  ambientEnv: a => { a.process.env = { PATH: '/public' }; },
  wrongVolume: a => { a.process.volumeName += '-other'; },
  wrongImage: a => { a.process.images.app = 'latest'; },
  missingImage: a => { delete a.process.images.db; },
  badUid: a => { a.approval.uid = 0; },
  nestedSource: a => { a.approval.sources[0].path += '/child'; },
  badPin: a => { a.approval.sources[0].sha256 = 'bad'; },
};
for (const [name, change] of Object.entries(invalidBindings)) {
  test('R05a2f1 inert binding refusal '+name, () => {
    const args = input(); change(args);
    assert.throws(() => createR05SelectedNodeReaders(args), bridgeRefusal);
  });
}
for (const record of ['top', 'approval', 'process']) {
  for (const field of ['native', 'spawn', 'clock', 'debug']) {
    test('R05a2f1 rejects caller capability '+record+'/'+field, () => {
      const args = input(), target = record === 'top' ? args : args[record];
      target[field] = () => { assert.fail('caller hook invoked'); };
      assert.throws(() => createR05SelectedNodeReaders(args), bridgeRefusal);
    });
  }
  for (const shape of ['accessor', 'hidden', 'symbol', 'proxy', 'prototype']) {
    test('R05a2f1 safe own-data record '+record+'/'+shape, () => {
      let args = input(), target = record === 'top' ? args : args[record], invoked = 0;
      const key = record === 'top' ? 'approval' : 'project';
      if (shape === 'accessor') Object.defineProperty(target, key, { enumerable: true,
        get() { invoked++; throw Error('PUBLIC accessor marker'); } });
      if (shape === 'hidden') Object.defineProperty(target, 'hidden', { value: 'PUBLIC hidden' });
      if (shape === 'symbol') target[Symbol('PUBLIC')] = 'PUBLIC';
      if (shape === 'prototype') Object.setPrototypeOf(target, { inherited: true });
      if (shape === 'proxy') {
        target = new Proxy(target, { ownKeys() { invoked++; throw Error('PUBLIC proxy marker'); } });
        if (record === 'top') args = target; else args[record] = target;
      }
      assert.throws(() => createR05SelectedNodeReaders(args), bridgeRefusal);
      assert.equal(invoked, 0);
    });
  }
}
for (const location of ['images', 'env', 'sources']) {
  test('R05a2f1 nested caller proxies are refused without traps '+location, () => {
    const args = input(); let invoked = 0;
    const parent = location === 'sources' ? args.approval : args.process;
    parent[location] = new Proxy(parent[location], {
      get() { invoked++; throw Error('PUBLIC marker'); },
      ownKeys() { invoked++; throw Error('PUBLIC marker'); },
    });
    assert.throws(() => createR05SelectedNodeReaders(args), bridgeRefusal);
    assert.equal(invoked, 0);
  });
}

for (const location of ['images', 'env', 'source']) {
  test('R05a2f1 nested accessors are refused without invocation '+location, () => {
    const args = input(); let invoked = 0;
    const target = location === 'source' ? args.approval.sources[0] : args.process[location];
    const key = location === 'source' ? 'path' : location === 'images' ? 'app' : 'LANG';
    Object.defineProperty(target, key, { enumerable: true,
      get() { invoked++; throw Error('PUBLIC accessor marker'); } });
    assert.throws(() => createR05SelectedNodeReaders(args), bridgeRefusal);
    assert.equal(invoked, 0);
  });
}

test('R05a2f1 mutable caller data cannot retarget filesystem approval', async () => {
  const args = input(), readers = createR05SelectedNodeReaders(args), q = request(args.approval);
  args.approval.project += '0'; args.approval.root += '/changed';
  args.approval.sources[0].path += '/changed'; args.approval.sources[0].sha256 = 'c'.repeat(64);
  q.project = args.approval.project;
  await assert.rejects(readers.filesystem.read(q), fsRefusal);
  assert.deepEqual(readers.filesystem.status(), { busy: false, quarantined: false, owned: 0 });
});

test('R05a2f1 mutable caller process data cannot admit changed selectors', async () => {
  const args = input(), readers = createR05SelectedNodeReaders(args);
  args.process.project += '0'; args.process.volumeName += '-changed';
  args.process.images.app = 'c'.repeat(64); args.process.binary += '-changed';
  args.process.cwd += '/changed'; args.process.env.LANG = 'other';
  const frame = { mode: 'lifecycle', attempt: 1, sequence: 1, request: 1 };
  await assert.rejects(readers.metadata.read({ kind: 'volume', project, frame,
    name: args.process.volumeName }), metadataRefusal);
  await assert.rejects(readers.metadata.read({ kind: 'image', project, frame,
    id: args.process.images.app, role: 'app' }), metadataRefusal);
});

for (const kind of ['census', 'container', 'command']) {
  test('R05a2f1 unsupported process selector without launching '+kind, async () => {
    const readers = createR05SelectedNodeReaders(input());
    await assert.rejects(readers.metadata.read({ kind }), metadataRefusal);
  });
}

test('R05a2f1 real public filesystem detachment, pin and permission drift, and symlink refusal', async () => {
  const fixture = await publicFixture();
  await fixture.run(async f => {
    const root = f.root;
    let readers;
    const args = input(root), q = request(args.approval);
    readers = createR05SelectedNodeReaders(args);
    // Change every caller binding after construction; no captured native reference is exposed.
    args.approval.root += '/changed'; args.approval.sources[0].sha256 = 'c'.repeat(64);
    args.process.env.LANG = 'other'; args.process.binary += '-changed';
    let reply = await f.read(readers.filesystem, q);
    assert.equal(reply.value.sources[0].sha256, sha(body));
    async function refusal() {
      await assert.rejects(f.read(readers.filesystem, q), fsRefusal);
    }
    await writeFile(root+'/source', 'PUBLIC changed source bytes\n');
    await refusal();
    await writeFile(root+'/source', body);
    await chmod(root+'/source', 0o400);
    await refusal();
    await chmod(root+'/source', 0o600);
    await chmod(root, 0o755);
    await refusal();
    await chmod(root, 0o700);
    await f.link();
    const linkArgs = input(root);
    linkArgs.approval.sources[0].path = root+'/link';
    readers = createR05SelectedNodeReaders(linkArgs);
    const linkRequest = request(linkArgs.approval);
    await assert.rejects(f.read(readers.filesystem, linkRequest), fsRefusal);
    readers = createR05SelectedNodeReaders(input(root));
    reply = await f.read(readers.filesystem, q);
    assert.equal(reply.value.sources[0].sha256, sha(body));
    assert.ok(reply.value.files.slice(0, 2).every(row => !('sha256' in row)));
    console.log('R05a2f1 OWN public fixture settled; acquisition/closure counts unobservable through bridge API');
  });
});

test('R05a2f1 captured native references and same-handle SDK composition are structural', async () => {
  // Read only this PUBLIC implementation; no loader mock or module monkeypatch.
  const source = await readFile(new URL('./r05-selected-node.mjs', import.meta.url), 'utf8');
  assert.match(source, /import \{ lstat, open \} from 'node:fs\/promises'/);
  assert.match(source, /import \{ spawn \} from 'node:child_process'/);
  assert.match(source, /nativeLstat = lstat, nativeOpen = open, nativeSpawn = spawn/);
  assert.match(source, /createR05SelectedProcessReader\(\{ \.\.\.binding, spawn: nativeSpawn \}\)/);
  assert.match(source, /nativeLstat\(path, \{ bigint: true \}\)/);
  assert.match(source, /nativeOpen\(path, flags\)/);
  assert.match(source, /handle\.stat\(\{ bigint: true \}\)/);
  assert.match(source, /handle\.read\(buffer, offset, length, position\)/);
  assert.match(source, /await handle\.close\(\)/);
  for (const flag of ['O_RDONLY', 'O_NOFOLLOW', 'O_NONBLOCK', 'O_DIRECTORY']) {
    assert.ok(source.includes(flag+': constants.'+flag));
  }
  assert.doesNotMatch(source, /process\.env|export (?:const|function) (?!createR05SelectedNodeReaders)/);
});
