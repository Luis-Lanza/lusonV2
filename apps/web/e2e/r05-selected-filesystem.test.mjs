import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, lstat, open, chmod, symlink, unlink, rmdir, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import { createR05SelectedFilesystemReader } from './r05-selected-filesystem.mjs';
const sha = b => createHash('sha256').update(b).digest('hex');
const refused = e => e.message === 'R05 selected filesystem refused.' && e.cause === undefined;
const clone = v => structuredClone(v);
function fixture(body = Buffer.from('PUBLIC synthetic snapshot')) {
  const root = '/controlled/r05', source = root+'/source';
  const approval = { project: 'luson-r05-abcdef0123456789', root, uid: 1000,
    manifest: root+'/manifest', dsn: root+'/dsn', sources: [{ path: source, sha256: sha(body) }] };
  const paths = [root, approval.manifest, approval.dsn, source];
  const stats = new Map(['/', '/controlled', ...paths].map((p, i) => [p,
    { dev: 1n, ino: BigInt(i+1), uid: paths.includes(p) ? 1000n : 0n,
      mode: BigInt(paths.includes(p) && p !== root ? 0o100600 : p === root ? 0o040700 : 0o040755) }]));
  const handles = new Map(), calls = [], reads = [], closes = [];
  let hook = async () => {};
  const native = {
    flags: { O_RDONLY: 0, O_NOFOLLOW: 1, O_NONBLOCK: 2, O_DIRECTORY: 4 },
    lstatBigInt: async p => { calls.push(['lstat', p]); await hook('lstat', p); return clone(stats.get(p)); },
    openReadonly: async (p, flags) => { calls.push(['open', p, flags]); await hook('open', p);
      const h = {}; handles.set(h, p); return h; },
    fstatBigInt: async h => { const p = handles.get(h); calls.push(['stat', p]); await hook('stat', p); return clone(stats.get(p)); },
    readInto: async (h, buffer, offset, length, position) => {
      const p = handles.get(h); reads.push([p, h, offset, length, position]); await hook('read', p);
      const bytesRead = Math.min(length, Math.max(0, body.length-position));
      body.copy(buffer, offset, position, position+bytesRead); return { bytesRead, buffer };
    },
    closeHandle: async h => { const p = handles.get(h); closes.push(p); await hook('close', p); handles.delete(h); },
  };
  const request = { kind: 'metadata', project: approval.project,
    frame: { mode: 'lifecycle', attempt: 1, sequence: 1, request: 1 }, paths, source_paths: [source] };
  const row = p => ({ path: p, uid: 1000, mode: 0o600, type: 'file', symlink: false,
    ...(p === source ? { sha256: sha(body) } : {}) });
  const expected = { frame: clone(request.frame), value: {
    root: { path: root, uid: 1000, mode: 0o700, type: 'directory', symlink: false },
    files: paths.slice(1).map(row), sources: [row(source)],
    handles: paths.map(p => ({ path: p, device: 1, inode: Number(stats.get(p).ino),
      opened: { device: 1, inode: Number(stats.get(p).ino) },
      ancestors: (p === root ? ['/', '/controlled'] : ['/', '/controlled', root]).map(a => ({
        path: a, device: 1, inode: Number(stats.get(a).ino), uid: a === root ? 1000 : 0,
        mode: a === root ? 0o700 : 0o755, type: 'directory', symlink: false })) })) } };
  return { approval, native, request, expected, stats, handles, calls, reads, closes, body,
    hook: fn => { hook = fn; }, reader: () => createR05SelectedFilesystemReader({ approval, native }) };
}
test('R05a2e2b first complete native roundtrip', async () => {
  const f = fixture(), reader = f.reader(), reply = await reader.read(f.request);
  assert.deepEqual(reply, f.expected);
  assert.equal(f.reads.filter(r => r[0] !== f.request.source_paths[0]).length, 0);
  assert.equal(f.closes.length, 6); assert.equal(f.handles.size, 0);
  assert.deepEqual(reader.status(), { busy: false, quarantined: false, owned: 0 });
});
const selectorCases = {
  project: q => { q.project += '0'; }, root: q => { q.paths[0] += '/other'; },
  reference: q => { q.paths[1] = q.paths[2]; }, source: q => { q.source_paths[0] = q.paths[1]; },
  order: q => { q.paths.reverse(); }, privatePath: q => { q.paths[3] = '/private'; },
  kind: q => { q.kind = 'census'; }, frame: q => { q.frame.mode = 'prepare'; },
  sequence: q => { q.frame.sequence = 2; }, attempt: q => { q.frame.attempt = 0; },
};
for (const [name, change] of Object.entries(selectorCases)) test('R05a2e2b selector before IO '+name, async () => {
  const f = fixture(), reader = f.reader(); change(f.request);
  await assert.rejects(reader.read(f.request), refused); assert.equal(f.calls.length, 0);
});
const approvalCases = {
  relative: a => { a.root = 'relative'; }, canonical: a => { a.root += '/..'; },
  nested: a => { a.sources[0].path += '/nested'; }, referenceSource: a => { a.sources[0].path = a.dsn; },
  foreign: a => { a.manifest = '/elsewhere'; }, pin: a => { a.sources[0].sha256 = 'bad'; },
  uid: a => { a.uid = 0; }, inherited: a => Object.setPrototypeOf(a, { root: a.root }),
};
for (const [name, change] of Object.entries(approvalCases)) test('R05a2e2b approval before IO '+name, () => {
  const f = fixture(); change(f.approval); assert.throws(f.reader, refused); assert.equal(f.calls.length, 0);
});
for (const name of ['lstatBigInt', 'openReadonly', 'fstatBigInt', 'readInto', 'closeHandle']) {
  test('R05a2e2b capture function descriptors '+name, () => {
    const f = fixture(); let invoked = 0;
    Object.defineProperty(f.native, name, { enumerable: true, get() { invoked++; } });
    assert.throws(f.reader, refused); assert.equal(invoked, 0);
    f.native = { ...fixture().native, [name]: new Proxy(() => {}, { apply() { invoked++; } }) };
    assert.throws(() => createR05SelectedFilesystemReader({ approval: f.approval, native: f.native }), refused);
    assert.equal(invoked, 0);
  });
}
for (const name of ['O_RDONLY', 'O_NOFOLLOW', 'O_NONBLOCK', 'O_DIRECTORY']) {
  for (const value of [undefined, -1, 1.5, name === 'O_RDONLY' ? 1 : 0]) {
    test('R05a2e2b mandatory flag '+name+' '+String(value), () => {
      const f = fixture(); f.native.flags[name] = value; assert.throws(f.reader, refused);
      assert.equal(f.calls.length, 0);
    });
  }
}
test('R05a2e2b missing inherited flags and capabilities refuse without IO', () => {
  for (const change of [n => { delete n.flags.O_NOFOLLOW; }, n => { n.flags.O_RDONLY = 8; },
    n => { n.flags.O_DIRECTORY = n.flags.O_NONBLOCK; }, n => { delete n.readInto; },
    n => Object.setPrototypeOf(n, { readInto: n.readInto }),
    n => { Object.defineProperty(n.flags, 'O_RDONLY', { get() { throw Error('never called'); } }); }]) {
    const f = fixture(); change(f.native); assert.throws(f.reader, refused); assert.equal(f.calls.length, 0);
  }
});
test('R05a2e2b proxy and nested accessors never execute', async () => {
  let invoked = 0;
  const proxy = new Proxy({}, { get() { invoked++; }, ownKeys() { invoked++; }, getPrototypeOf() { invoked++; } });
  const f = fixture();
  for (const input of [proxy, { approval: proxy, native: f.native }, { approval: f.approval, native: proxy }]) {
    assert.throws(() => createR05SelectedFilesystemReader(input), refused);
  }
  Object.defineProperty(f.approval.sources[0], 'sha256', { enumerable: true, get() { invoked++; } });
  assert.throws(f.reader, refused);
  const g = fixture(); await assert.rejects(g.reader().read(proxy), refused);
  g.native.lstatBigInt = () => proxy; await assert.rejects(g.reader().read(g.request), refused);
  assert.equal(invoked, 0);
});
test('R05a2e2b caller mutation cannot replace captured approval flags or functions', async () => {
  const f = fixture(), reader = f.reader(), q = clone(f.request);
  f.approval.sources[0].sha256 = 'bad'; f.approval.root = '/foreign';
  f.native.flags.O_NOFOLLOW = 0; f.native.readInto = () => { throw Error('replacement'); };
  const pending = reader.read(q); q.paths.reverse(); q.frame.attempt = 99;
  const reply = await pending; assert.deepEqual(reply, f.expected);
  assert.throws(() => { reply.value.sources[0].sha256 = 'bad'; }, TypeError);
  assert.ok(f.calls.filter(c => c[0] === 'open').every(c => c[2] === (c[1].endsWith('/manifest')
    || c[1].endsWith('/dsn') || c[1].endsWith('/source') ? 3 : 7)));
});
const statCases = {
  uid: s => { s.uid = 1001n; }, special: s => { s.mode |= 0o4000n; },
  symlink: s => { s.mode = 0o120700n; }, fifo: s => { s.mode = 0o010700n; },
  lossy: s => { s.ino = BigInt(Number.MAX_SAFE_INTEGER)+1n; }, number: s => { s.dev = 1; },
};
for (const [name, change] of Object.entries(statCases)) test('R05a2e2b root raw stat '+name, async () => {
  const f = fixture(); change(f.stats.get(f.approval.root));
  await assert.rejects(f.reader().read(f.request), refused); assert.equal(f.handles.size, 0);
});
for (const path of ['/', '/controlled', '/controlled/r05/dsn']) test('R05a2e2b complete path policy '+path, async () => {
  const f = fixture(); f.stats.get(path).mode |= 0o020n;
  await assert.rejects(f.reader().read(f.request), refused); assert.equal(f.reads.length, 0); assert.equal(f.handles.size, 0);
});
for (const phase of ['opened', 'afterOpen', 'postReadSource', 'postReadAncestor']) test('R05a2e2b drift '+phase, async () => {
  const f = fixture(); let count = 0;
  f.hook(async (op, p) => {
    if (phase === 'opened' && op === 'stat' && p === '/') f.stats.get(p).ino++;
    if (phase === 'afterOpen' && op === 'lstat' && p === '/' && ++count === 2) f.stats.get(p).uid = 1001n;
    if (op === 'read' && phase === 'postReadSource') f.stats.get(p).mode = 0o100400n;
    if (op === 'read' && phase === 'postReadAncestor') f.stats.get('/').ino++;
  });
  await assert.rejects(f.reader().read(f.request), refused); assert.equal(f.handles.size, 0);
});
test('R05a2e2b UID zero full ancestor permissions and stat descriptor safety', async () => {
  const f = fixture(); f.stats.get('/').mode = 0o044755n;
  const reply = await f.reader().read(f.request); assert.equal(reply.value.handles[0].ancestors[0].mode, 0o4755);
  assert.equal(reply.value.handles[0].ancestors[0].uid, 0);
  const g = fixture(); let invoked = 0;
  g.native.fstatBigInt = () => ({ get dev() { invoked++; }, ino: 1n, uid: 0n, mode: 0o040755n });
  await assert.rejects(g.reader().read(g.request), refused); assert.equal(invoked, 0); assert.equal(g.closes.length, 1);
});
for (const kind of ['negative', 'negativeZero', 'fractional', 'overflow', 'nan', 'bigint', 'wrongBuffer', 'getter', 'proxy', 'array']) {
  test('R05a2e2b native read result '+kind, async () => {
    const f = fixture(); let invoked = 0;
    f.native.readInto = (h, buffer, offset, length) => {
      assert.equal(f.handles.get(h), f.request.source_paths[0]);
      if (kind === 'getter') return { get bytesRead() { invoked++; }, buffer };
      if (kind === 'proxy') return new Proxy({}, { get() { invoked++; }, ownKeys() { invoked++; } });
      if (kind === 'array') return [0, buffer];
      const bytesRead = { negative: -1, negativeZero: -0, fractional: 0.5, overflow: length+1, nan: NaN, bigint: 1n }[kind] ?? 0;
      return { bytesRead, buffer: kind === 'wrongBuffer' ? Buffer.alloc(length) : buffer };
    };
    await assert.rejects(f.reader().read(f.request), refused);
    assert.equal(invoked, 0); assert.equal(f.closes.length, 6); assert.equal(f.handles.size, 0);
  });
}
for (const length of [0, 65536, 1024*1024-1, 1024*1024]) test('R05a2e2b truthful positive-read EOF '+length, async () => {
  const f = fixture(Buffer.alloc(length, 65)), reader = f.reader();
  if (length === 1024*1024) await assert.rejects(reader.read(f.request), refused);
  else assert.equal((await reader.read(f.request)).value.sources[0].sha256, sha(f.body));
  assert.ok(f.reads.every(r => r[2] === 0 && r[3] > 0 && r[3] <= 65536 && r[4] < 1024*1024));
  assert.equal(f.handles.size, 0); assert.ok(f.reads.length <= 17);
});
test('R05a2e2b partial progress exhausts request budget before further allocation or IO', async () => {
  const f = fixture(); let charged = 0, reads = 0;
  f.native.readInto = (h, buffer, offset, length, position) => {
    charged += length; reads++; assert.equal(position, reads-1); assert.equal(buffer.length, length);
    buffer[0] = 65; return { bytesRead: 1, buffer };
  };
  await assert.rejects(f.reader().read(f.request), refused);
  assert.equal(reads, 17); assert.equal(charged, 1024*1024+65536); assert.equal(f.handles.size, 0);
});
test('R05a2e2b owned buffer slicing ignores hostile accessor and method shadows', async () => {
  const f = fixture(), read = f.native.readInto; let invoked = 0;
  f.native.readInto = async (...args) => {
    const result = await read(...args);
    for (const k of ['buffer', 'byteOffset', 'length', 'subarray']) {
      Object.defineProperty(args[1], k, { get() { invoked++; throw Error('hostile shadow'); } });
    }
    return result;
  };
  assert.deepEqual(await f.reader().read(f.request), f.expected); assert.equal(invoked, 0);
});
test('R05a2e2b SDK null-prototype result retains exact supplied buffer', async () => {
  const f = fixture(), read = f.native.readInto;
  f.native.readInto = async (...args) => Object.assign(Object.create(null), await read(...args));
  assert.deepEqual(await f.reader().read(f.request), f.expected);
});
test('R05a2e2b zero premature EOF cannot bypass pinned SHA', async () => {
  const f = fixture(); f.native.readInto = (h, buffer) => ({ bytesRead: 0, buffer });
  await assert.rejects(f.reader().read(f.request), refused); assert.equal(f.closes.length, 6);
});
for (const value of [17, null, new Proxy({}, {}), []]) test('R05a2e2b malformed acquisition '+String(value === null ? 'null' : typeof value), async () => {
  const f = fixture(); let closes = 0;
  f.native.openReadonly = () => value; f.native.closeHandle = h => { assert.equal(h, value); closes++; };
  const reader = f.reader(); await assert.rejects(reader.read(f.request), refused);
  const safe = Array.isArray(value); assert.equal(closes, safe ? 1 : 0);
  assert.equal(reader.status().owned, safe ? 0 : 1); assert.equal(reader.status().quarantined, !safe);
});
test('R05a2e2b proxy acquisition never invokes accessors or uncertain close', async () => {
  const f = fixture(); let invoked = 0;
  f.native.openReadonly = () => new Proxy({}, { get() { invoked++; }, getPrototypeOf() { invoked++; } });
  f.native.closeHandle = () => { invoked++; };
  const reader = f.reader(); await assert.rejects(reader.read(f.request), refused);
  assert.equal(invoked, 0); assert.deepEqual(reader.status(), { busy: false, quarantined: true, owned: 1 });
});
test('R05a2e2b duplicate native identity closes once; later reuse is quarantined', async () => {
  const f = fixture(), handle = {}; let closes = 0;
  f.native.openReadonly = () => handle; f.native.fstatBigInt = () => clone(f.stats.get('/'));
  f.native.closeHandle = h => { assert.equal(h, handle); closes++; };
  await assert.rejects(f.reader().read(f.request), refused); assert.equal(closes, 1);
  const g = fixture(), realOpen = g.native.openReadonly; let reuse = false, first;
  g.native.openReadonly = async (p, flags) => {
    if (reuse) return first;
    const acquired = await realOpen(p, flags); first ??= acquired; return acquired;
  };
  const reader = g.reader(); await reader.read(g.request); reuse = true;
  await assert.rejects(reader.read(g.request), refused);
  assert.equal(g.closes.length, 6);
  assert.deepEqual(reader.status(), { busy: false, quarantined: true, owned: 1 });
});
for (const failure of ['stat', 'open', 'read', 'close', 'closeValue']) test('R05a2e2b all acquired closures despite '+failure, async () => {
  const f = fixture();
  if (failure === 'closeValue') f.native.closeHandle = h => { f.closes.push(f.handles.get(h)); return true; };
  else f.hook(async (op, p) => {
    if (op === failure && (failure === 'read' || failure === 'close' || p.endsWith('/dsn'))) throw Error('PRIVATE synthetic body');
  });
  const reader = f.reader(); await assert.rejects(reader.read(f.request), refused);
  assert.equal(f.closes.length, failure === 'open' ? 4 : failure === 'stat' ? 5 : 6);
  if (failure.startsWith('close')) {
    assert.equal(reader.status().owned, 6); assert.equal(f.handles.size, 6);
    const before = f.calls.length; await assert.rejects(reader.read(f.request), refused);
    assert.equal(f.calls.length, before); assert.equal(f.closes.length, 6);
  } else assert.equal(f.handles.size, 0);
});
test('R05a2e2b pending late close counts actual handles; failure cannot become success', async () => {
  const f = fixture(); let entered, release;
  const closing = new Promise(r => { entered = r; });
  f.hook(async (op, p) => {
    if (op === 'close' && p === '/') { entered(); await new Promise(r => { release = r; }); throw Error('UNKNOWN'); }
  });
  const reader = f.reader(), pending = reader.read(f.request); await closing;
  assert.deepEqual(reader.status(), { busy: true, quarantined: false, owned: 6 });
  await assert.rejects(reader.read(f.request), refused); release(); await assert.rejects(pending, refused);
  assert.deepEqual(reader.status(), { busy: false, quarantined: true, owned: 1 });
  assert.equal(f.handles.size, 1); assert.equal(f.closes.length, 6);
  await assert.rejects(reader.read(f.request), refused); assert.equal(f.closes.length, 6);
});
test('R05a2e2b public API exposes no private token native handle or path capability', async () => {
  const f = fixture(), reader = f.reader();
  assert.deepEqual(Object.keys(reader), ['read', 'status']); assert.ok(Object.isFrozen(reader));
  assert.deepEqual(Object.keys(reader.status()), ['busy', 'quarantined', 'owned']);
  assert.ok(Object.isFrozen(reader.status()));
  const module = await import('./r05-selected-filesystem.mjs');
  assert.deepEqual(Object.keys(module), ['createR05SelectedFilesystemReader']);
  const source = await readFile(new URL('./r05-selected-filesystem.mjs', import.meta.url), 'utf8');
  assert.equal(/node:fs|\.test\.mjs/.test(source), false);
  assert.equal(f.calls.length, 0);
});
test('R05a2e2b multiple public sources have separate same-FD reads and pins in both lists', async () => {
  const f = fixture(), second = f.approval.root+'/second';
  f.approval.sources.push({ path: second, sha256: sha(f.body) });
  f.request.paths.push(second); f.request.source_paths.push(second);
  f.stats.set(second, { ...f.stats.get(f.approval.dsn), ino: 99n });
  f.request.frame = { mode: 'active', attempt: 3, sequence: 2, request: 7 };
  const reply = await f.reader().read(f.request);
  assert.deepEqual(reply.value.files.slice(2), reply.value.sources);
  assert.equal(new Set(f.reads.map(r => r[1])).size, 2); assert.equal(f.closes.length, 7);
});
test('R05a2e2b native handle accessors are not invoked by ownership registration', async () => {
  const f = fixture(); let invoked = 0, closed = 0;
  const handle = { get then() { invoked++; }, get fd() { invoked++; } };
  f.native.openReadonly = () => handle;
  f.native.fstatBigInt = () => { throw Error('malformed metadata'); };
  f.native.closeHandle = h => { assert.equal(h, handle); closed++; };
  await assert.rejects(f.reader().read(f.request), refused);
  assert.equal(invoked, 0); assert.equal(closed, 1);
});
test('R05a2e2b OWN public native SDK fixture confirms same-FD pins and all closures', async () => {
  const root = await mkdtemp(resolve('apps/web/e2e/.r05a2e2b-'));
  const names = ['manifest', 'dsn', 'source'], body = Buffer.from('PUBLIC native fixture bytes');
  const handles = new Map(), reads = [], opens = [], closes = [];
  let drift = false, approval, request;
  try {
    await chmod(root, 0o700);
    for (const name of names) await writeFile(root+'/'+name, body, { flag: 'wx', mode: 0o600 });
    const native = {
      flags: { O_RDONLY: constants.O_RDONLY, O_NOFOLLOW: constants.O_NOFOLLOW,
        O_NONBLOCK: constants.O_NONBLOCK, O_DIRECTORY: constants.O_DIRECTORY },
      lstatBigInt: p => lstat(p, { bigint: true }),
      openReadonly: async (p, flags) => {
        const directory = p === root || !p.startsWith(root+'/');
        assert.equal(flags, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
          | (directory ? constants.O_DIRECTORY : 0));
        const h = await open(p, flags); handles.set(h, p); opens.push(p); return h;
      },
      fstatBigInt: h => { assert.ok(handles.has(h)); return h.stat({ bigint: true }); },
      readInto: async (h, buffer, offset, length, position) => {
        const p = handles.get(h); assert.ok(p === root+'/source'); reads.push(p);
        const result = await h.read(buffer, offset, length, position);
        assert.equal(result.buffer, buffer);
        if (drift) { drift = false; await chmod(root+'/source', 0o400); }
        return result;
      },
      closeHandle: async h => {
        assert.ok(handles.has(h)); await h.close(); closes.push(handles.get(h)); handles.delete(h);
      },
    };
    approval = { project: 'luson-r05-abcdef0123456789', root, uid: process.getuid(),
      manifest: root+'/manifest', dsn: root+'/dsn', sources: [{ path: root+'/source', sha256: sha(body) }] };
    request = { kind: 'metadata', project: approval.project,
      frame: { mode: 'lifecycle', attempt: 1, sequence: 1, request: 1 },
      paths: [root, approval.manifest, approval.dsn, root+'/source'], source_paths: [root+'/source'] };
    const make = () => createR05SelectedFilesystemReader({ approval, native });
    const reply = await make().read(request);
    assert.deepEqual(reply.value.files[2], reply.value.sources[0]); assert.equal(reply.value.sources[0].sha256, sha(body));
    assert.equal(handles.size, 0); assert.equal(opens.length, closes.length);
    console.log('R05a2e2b OWN native success acquisitions='+opens.length+' confirmed closures='+closes.length+' retained=0');
    drift = true; await assert.rejects(make().read(request), refused);
    assert.equal(handles.size, 0); await chmod(root+'/source', 0o600);
    await symlink('source', root+'/link');
    approval.sources = [{ path: root+'/link', sha256: sha(body) }];
    request.paths[3] = root+'/link'; request.source_paths[0] = root+'/link';
    await assert.rejects(make().read(request), refused);
    assert.ok(reads.every(p => p === root+'/source')); assert.equal(handles.size, 0);
    assert.equal(opens.length, closes.length);
    console.log('R05a2e2b OWN native including permission drift and symlink acquisitions='+opens.length
      +' confirmed closures='+closes.length+' retained=0');
  } finally {
    // Only known closed OWN fixtures may be removed; no UNKNOWN real-FD cleanup experiment.
    assert.equal(handles.size, 0); assert.equal(opens.length, closes.length);
    for (const name of [...names, 'link']) {
      try { await unlink(root+'/'+name); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    await rmdir(root);
  }
});
