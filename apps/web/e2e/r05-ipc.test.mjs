import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, lstat, readFile, readdir, rename, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import net from 'node:net';
import { CredentialBridge, requestCredentials } from './r05-ipc.mjs';
const hash = x => createHash('sha256').update(x).digest('hex');
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'r05a1-'));
  await chmod(root, 0o700);
  const run_id = randomBytes(8).toString('hex');
  const endpoint = join(root, 'account.sock');
  const records = ['W','A','B'].map(role => ({ role, username: 'synthetic-'+role, password: randomBytes(24).toString('hex') }));
  let accesses = 0;
  const options = { root, endpoint, run_id, uid: process.getuid(), provider: async () => { accesses++; return records; } };
  return { root, endpoint, run_id, records, options, accesses: () => accesses };
}
const client = f => ({ root: f.root, endpoint: f.endpoint, run_id: f.run_id, uid: process.getuid() });
test('R05a1 private memory exchange deep copies and lifecycle', async () => {
  const f = await setup(); const bridge = new CredentialBridge(f.options);
  await bridge.start();
  try {
    assert.equal((await lstat(f.endpoint)).mode & 0o777, 0o600);
    const received = await requestCredentials(client(f));
    assert.equal(received.length === 3 && received.every((v, i) => hash(v.password) === hash(f.records[i].password)), true);
    received[0].password = 'changed';
    const second = await requestCredentials(client(f));
    assert.equal(hash(second[0].password) === hash(f.records[0].password), true);
    assert.equal(f.accesses(), 2);
    assert.equal((await readdir(f.root)).join(','), 'account.sock');
    assert.equal(Object.values(process.env).some(v => f.records.some(r => v.includes(r.password))), false);
    assert.equal(process.argv.some(v => f.records.some(r => v.includes(r.password))), false);
  } finally { await bridge.stop(); }
  assert.equal(await lstat(f.endpoint).then(() => false, () => true), true);
  await assert.rejects(() => requestCredentials(client(f)), e => e.message === 'R05 credential IPC refused.');
  await assert.rejects(() => bridge.start());
});
for (const kind of ['differentRun','rootMode','missingRoot','outsideRoot','collision','symlink','uid']) {
  test('R05a1 IPC denies '+kind+' before provider', async () => {
    const f = await setup(); let bridge;
    if (kind === 'differentRun') {
      bridge = new CredentialBridge(f.options); await bridge.start();
      await assert.rejects(() => requestCredentials({ ...client(f), run_id: '0'.repeat(16) }));
    } else {
      const options = { ...f.options };
      if (kind === 'rootMode') await chmod(f.root, 0o755);
      if (kind === 'missingRoot') options.root = join(f.root, 'missing');
      if (kind === 'outsideRoot') options.endpoint = join(tmpdir(), 'not-owned.sock');
      if (kind === 'collision') await writeFile(f.endpoint, 'foreign', { mode: 0o600 });
      if (kind === 'symlink') await symlink(f.root, f.endpoint);
      if (kind === 'uid') options.uid++;
      bridge = new CredentialBridge(options);
      await assert.rejects(() => bridge.start(), e => e.message === 'R05 credential IPC refused.');
    }
    assert.equal(f.accesses(), 0);
    await bridge.stop();
    if (kind === 'collision') assert.equal(await readFile(f.endpoint, 'utf8'), 'foreign');
  });
}
test('R05a1 IPC replacement inode is never removed', async () => {
  const f = await setup(); const bridge = new CredentialBridge(f.options); await bridge.start();
  await rename(f.endpoint, join(f.root, 'captured.sock'));
  await writeFile(f.endpoint, 'replacement', { mode: 0o600 });
  await bridge.stop();
  assert.equal(await readFile(f.endpoint, 'utf8'), 'replacement');
  assert.equal((await lstat(f.root)).mode & 0o777, 0o700);
});
function raw(endpoint, payload) {
  return new Promise(resolve => {
    const socket = net.createConnection(endpoint); let output = '';
    socket.on('error', () => resolve(output)); socket.on('data', b => output += b);
    socket.on('close', () => resolve(output)); socket.on('connect', () => socket.end(payload));
  });
}
test('R05a1 IPC bounded malformed messages disconnect and sanitized errors', async () => {
  const f = await setup(); const bridge = new CredentialBridge({ ...f.options, maxRequests: 4 }); await bridge.start();
  try {
    for (const payload of ['bad\n', 'x'.repeat(5000), JSON.stringify({ run_id: f.run_id, password: f.records[0].password })+'\n', '']) {
      const output = await raw(f.endpoint, payload);
      assert.equal(output.includes(f.records[0].password), false);
    }
    assert.equal(f.accesses(), 0);
    await assert.rejects(() => requestCredentials(client(f)));
  } finally { await bridge.stop(); }
});
for (const kind of ['throw','extra','duplicate','missing','oversize']) test('R05a1 IPC sanitizes provider '+kind, async () => {
  const f = await setup();
  const bridge = new CredentialBridge({ ...f.options, provider: async () => {
    if (kind === 'throw') throw Error(f.records[0].password);
    if (kind === 'extra') return f.records.map(r => ({ ...r, csrf: f.records[0].password }));
    if (kind === 'duplicate') return [f.records[0],f.records[0],f.records[2]];
    if (kind === 'missing') return f.records.slice(0,2);
    return f.records.map(r => ({ ...r, password: 'x'.repeat(5000) }));
  } });
  await bridge.start();
  try { await assert.rejects(() => requestCredentials(client(f)), e => e.message === 'R05 credential IPC refused.'); }
  finally { await bridge.stop(); }
});
test('R05a1 IPC rechecks socket permissions and replacement before provider', async () => {
  const f = await setup(); const bridge = new CredentialBridge(f.options); await bridge.start();
  try {
    await chmod(f.endpoint, 0o644);
    await assert.rejects(() => requestCredentials(client(f)));
    assert.equal(f.accesses(), 0);
    await chmod(f.endpoint, 0o600);
    await rename(f.endpoint, join(f.root, 'moved.sock'));
    const output = await raw(join(f.root, 'moved.sock'), JSON.stringify({ run_id: f.run_id }));
    assert.equal(output.length, 0); assert.equal(f.accesses(), 0);
  } finally { await bridge.stop(); }
});
test('R05a1 IPC cancels provider on disconnected request', async () => {
  const f = await setup(); let entered; let cancelled;
  const ready = new Promise(r => entered = r); const aborted = new Promise(r => cancelled = r);
  const bridge = new CredentialBridge({ ...f.options, provider: ({ signal }) => {
    signal.addEventListener('abort', cancelled, { once: true }); entered(); return new Promise(() => {});
  } });
  await bridge.start();
  try {
    const socket = net.createConnection(f.endpoint);
    socket.on('error', () => {});
    socket.on('connect', () => socket.end(JSON.stringify({ run_id: f.run_id })));
    await ready; socket.destroy(); await aborted;
  } finally { await bridge.stop(); }
});
test('R05a1 stop refuses current mode drift without mutating permissions', async () => {
  const servers = () => process._getActiveHandles().filter(h => h instanceof net.Server).length;
  const before = servers();
  const f = await setup(); const bridge = new CredentialBridge(f.options);
  await bridge.start(); const original = await lstat(f.root);
  try {
    await chmod(f.root, 0o500);
    await assert.rejects(() => bridge.stop(), e => e.message === 'R05 credential IPC refused.');
    const current = await lstat(f.root);
    assert.equal(current.ino === original.ino && current.dev === original.dev, true);
    assert.equal(current.mode & 0o777, 0o500);
    assert.equal(f.accesses(), 0);
    await chmod(f.root, 0o700); // Caller restores its own admitted directory.
    const output = await raw(f.endpoint, JSON.stringify({ run_id: f.run_id }));
    assert.equal(output.length, 0); assert.equal(f.accesses(), 0);
  } finally {
    await chmod(f.root, 0o700);
    await bridge.stop();
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(servers(), before);
  assert.equal(await lstat(f.endpoint).then(() => false, () => true), true);
});
test('R05a1 stop restores admitted mode on close error and retains safe retry', async t => {
  const servers = () => process._getActiveHandles().filter(h => h instanceof net.Server).length;
  const before = servers();
  const f = await setup(); const bridge = new CredentialBridge(f.options); await bridge.start();
  const close = t.mock.method(net.Server.prototype, 'close', function(callback) {
    queueMicrotask(() => callback(new Error(f.records[0].password))); return this;
  });
  try {
    const refused = await bridge.stop().then(() => false, error => error.message === 'R05 credential IPC refused.');
    assert.equal(refused, true);
    assert.equal((await lstat(f.root)).mode & 0o777, 0o700);
    assert.equal((await lstat(f.endpoint)).isSocket(), true);
    assert.equal(servers(), before + 1); // Still owned, not an unref-hidden orphan.
    const output = await raw(f.endpoint, JSON.stringify({ run_id: f.run_id }));
    assert.equal(output.length, 0); assert.equal(f.accesses(), 0);
  } finally { close.mock.restore(); await bridge.stop(); }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(servers(), before);
  assert.equal(await lstat(f.endpoint).then(() => false, () => true), true);
});
test('R05a1 stop refuses changed root pathname and retries only captured ownership', async () => {
  const servers = () => process._getActiveHandles().filter(h => h instanceof net.Server).length;
  const before = servers();
  const f = await setup(); const bridge = new CredentialBridge(f.options); await bridge.start();
  const moved = f.root+'-moved';
  await rename(f.root, moved);
  try {
    await assert.rejects(() => bridge.stop(), e => e.message === 'R05 credential IPC refused.');
    assert.equal((await lstat(moved)).mode & 0o777, 0o700);
    assert.equal(f.accesses(), 0); assert.equal(servers(), before + 1);
  } finally { await rename(moved, f.root); await bridge.stop(); }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(servers(), before);
  assert.equal(await lstat(f.endpoint).then(() => false, () => true), true);
});
test('R05a1 stop refuses restoration after root changes during awaited close', { timeout: 2000 }, async t => {
  const servers = () => process._getActiveHandles().filter(h => h instanceof net.Server).length;
  const before = servers();
  const f = await setup(); const bridge = new CredentialBridge(f.options); await bridge.start();
  const moved = f.root+'-archive';
  const replacement = await mkdtemp(join(tmpdir(), 'r05a1-replacement-'));
  await chmod(replacement, 0o700); const replacementStat = await lstat(replacement);
  const originalClose = net.Server.prototype.close;
  let archived = false; let replaced = false;
  const close = t.mock.method(net.Server.prototype, 'close', function(callback) {
    return originalClose.call(this, error => {
      if (error) { callback(error); return; }
      (async () => {
        await rename(f.root, moved); archived = true;
        await rename(replacement, f.root); replaced = true;
        callback(); // Path change occurs inside the awaited-close boundary.
      })().catch(callback);
    });
  });
  try {
    await assert.rejects(() => bridge.stop(), e => e.message === 'R05 credential IPC refused.');
    assert.equal((await lstat(moved)).mode & 0o777, 0o500);
    const current = await lstat(f.root);
    assert.equal(current.ino === replacementStat.ino && current.dev === replacementStat.dev, true);
    assert.equal(current.mode & 0o777, 0o700);
    assert.equal((await readdir(f.root)).length, 0); assert.equal(f.accesses(), 0);
  } finally {
    close.mock.restore();
    // Park only our empty replacement off-path; preserve it rather than delete.
    if (replaced) await rename(f.root, replacement);
    if (archived) await rename(moved, f.root);
    await chmod(f.root, 0o700); await bridge.stop();
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(servers(), before);
  assert.equal(await lstat(f.endpoint).then(() => false, () => true), true);
});
test('R05a1 refused stop cancels pending credentials before cleanup retry', { timeout: 2000 }, async () => {
  const f = await setup(); let entered; let cancelled;
  const ready = new Promise(resolve => entered = resolve);
  const aborted = new Promise(resolve => cancelled = resolve);
  const bridge = new CredentialBridge({ ...f.options, provider: ({ signal }) => {
    signal.addEventListener('abort', cancelled, { once: true }); entered(); return new Promise(() => {});
  } });
  await bridge.start();
  const request = requestCredentials(client(f)).then(() => false, () => true);
  await ready;
  try {
    await chmod(f.root, 0o500);
    await assert.rejects(() => bridge.stop(), e => e.message === 'R05 credential IPC refused.');
    await aborted; assert.equal(await request, true);
    assert.equal((await lstat(f.root)).mode & 0o777, 0o500);
    await assert.rejects(() => bridge.stop()); // Refusal is retryable, not cached success.
  } finally { await chmod(f.root, 0o700); await bridge.stop(); }
});
test('R05a1 IPC stop settles blocked provider without sending credentials', { timeout: 2000 }, async () => {
  const f = await setup(); let release; let entered;
  const waiting = new Promise(r => entered = r);
  const bridge = new CredentialBridge({ ...f.options, provider: () => { entered(); return new Promise(r => release = r); } });
  await bridge.start();
  const request = requestCredentials(client(f)).then(() => false, () => true);
  await waiting; await bridge.stop(); release(f.records);
  assert.equal(await request, true);
});
