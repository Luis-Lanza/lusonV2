import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createR05SelectedProcessReader } from './r05-selected-process.mjs';
const project = 'luson-r05-abcdef0123456789', name = project+'-data';
const h = n => n.toString(16).padStart(64, '0');
const volume = { Name: name, Driver: 'local', CreatedAt: 'synthetic', Options: null, Scope: 'local', Labels: {} };
const query = () => ({ kind: 'volume', name, project, frame: { mode: 'lifecycle', request: 1, sequence: 1, attempt: 1 } });
const denied = e => /R05 selected (?:metadata|process) refused\./.test(e.message) && !e.cause;
function child() {
  const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
  c.exitCode = null; c.signalCode = null; c.kills = 0; c.kill = () => { c.kills++; return true; };
  c.end = (code = 0, signal = null) => { c.exitCode = code; c.signalCode = signal; c.emit('exit', code, signal); };
  c.close = (code = 0, signal = null) => { c.stdout.emit('close'); c.stderr.emit('close'); c.emit('close', code, signal); };
  return c;
}
function fixture() {
  const c = child(), calls = []; let now = 0, alarm = null, clears = 0;
  const clock = { now: () => now, setTimeout: fn => { alarm = fn; return 1; }, clearTimeout: () => { alarm = null; clears++; } };
  const input = { project, volumeName: name, images: { app: h(5), db: h(6) }, binary: process.execPath,
    cwd: '/synthetic-public', env: { LC_ALL: 'C' }, clock,
    spawn: (binary, argv, options) => { calls.push({ binary, argv, options }); return c; } };
  return { c, calls, input, time: n => now = n,
    fire: () => { const fn = alarm; alarm = null; fn?.(); }, alarm: () => alarm, clears: () => clears };
}
test('R05a2d2 complete owned process and closed pipes return selected volume', async () => {
  const f = fixture(), reader = createR05SelectedProcessReader(f.input), result = reader.read(query());
  f.c.stdout.emit('data', Buffer.from(JSON.stringify(volume))); f.c.end(); f.c.close();
  assert.deepEqual((await result).value, volume); assert.equal(f.c.kills, 0); assert.equal(f.alarm(), null);
});
test('R05a2d2 immutable bindings use fixed spawn options and frozen reader vectors', async () => {
  const f = fixture(), reader = createR05SelectedProcessReader(f.input);
  f.input.env.NODE_OPTIONS = 'unsupported'; f.input.cwd = '/changed'; f.input.binary = '/changed';
  const p = reader.read(query()), buffer = Buffer.from(JSON.stringify(volume));
  f.c.stdout.emit('data', buffer); buffer.fill(0); f.c.end(); f.c.close(); await p;
  assert.equal(f.calls[0].binary, process.execPath);
  assert.deepEqual(f.calls[0].options, { cwd: '/synthetic-public', env: { LC_ALL: 'C' },
    shell: false, detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.deepEqual(Object.keys(reader), ['read']);
  assert.deepEqual(f.calls[0].argv.slice(0, 3), ['volume', 'inspect', '--format']);
  assert.equal(f.calls[0].argv.at(-1), name); assert.equal(Object.isFrozen(f.calls[0].options.env), true);
});
for (const cause of ['timeout', 'overflow', 'stderr', 'streamError', 'stderrError', 'childError', 'nonzero', 'signal']) {
  test('R05a2d2 irreversible '+cause+' failure waits for close and retains reader quarantine', async () => {
    const f = fixture(), reader = createR05SelectedProcessReader(f.input), p = reader.read(query());
    if (cause === 'timeout') { f.time(5000); f.fire(); }
    if (cause === 'overflow') f.c.stdout.emit('data', Buffer.from('é'.repeat(17000)));
    if (cause === 'stderr') f.c.stderr.emit('data', Buffer.from('synthetic-public-error'));
    if (cause === 'streamError') f.c.stdout.emit('error', new Error('synthetic-private-sentinel'));
    if (cause === 'stderrError') f.c.stderr.emit('error', new Error('synthetic-private-sentinel'));
    if (cause === 'childError') f.c.emit('error', new Error('synthetic-private-sentinel'));
    if (cause === 'nonzero') f.c.end(1);
    if (cause === 'signal') f.c.end(null, 'SIGTERM');
    await assert.rejects(() => reader.read(query()), denied);
    assert.equal(f.calls.length, 1); assert.equal(f.alarm(), null);
    assert.equal(f.c.kills, ['nonzero', 'signal'].includes(cause) ? 0 : 1);
    f.c.stdout.emit('data', Buffer.alloc(65536)); f.c.end(); f.c.close(); await assert.rejects(() => p, denied);
    assert.equal(f.c.listenerCount('close'), 0);
  });
}
for (const outcome of ['false', 'throw', 'error']) test('R05a2d2 cancellation '+outcome+' never repeats or claims termination', async () => {
  const f = fixture(); f.c.kill = () => { f.c.kills++;
    if (outcome === 'throw') throw new Error('synthetic-private-sentinel');
    if (outcome === 'error') f.c.emit('error', new Error('synthetic-private-sentinel')); return false; };
  const reader = createR05SelectedProcessReader(f.input), p = reader.read(query()); f.time(5000); f.fire();
  f.fire(); await assert.rejects(() => reader.read(query()), denied); assert.equal(f.c.kills, 1);
  f.c.end(); f.c.close(); await assert.rejects(() => p, denied);
});
for (const evidence of ['exit', 'exitCode', 'signalCode']) test('R05a2d2 '+evidence+' prevents signalling a draining process', async () => {
  const f = fixture(), reader = createR05SelectedProcessReader(f.input), p = reader.read(query());
  if (evidence === 'exit') f.c.end(); else f.c[evidence] = evidence === 'exitCode' ? 0 : 'SIGTERM';
  f.time(6000); f.fire(); assert.equal(f.c.kills, 0); await assert.rejects(() => reader.read(query()), denied);
  f.c.close(); await assert.rejects(() => p, denied);
});
test('R05a2d2 exit and child close alone cannot bypass unclosed pipes or late monotonic time', async () => {
  const f = fixture(), reader = createR05SelectedProcessReader(f.input), p = reader.read(query());
  f.c.stdout.emit('data', Buffer.from(JSON.stringify(volume))); f.c.end();
  f.c.emit('close', 0, null); await assert.rejects(() => reader.read(query()), denied);
  f.time(5001); f.c.stdout.emit('close'); f.c.stderr.emit('close');
  await assert.rejects(() => p, denied); assert.equal(f.c.kills, 0); assert.equal(f.alarm(), null);
});
test('R05a2d2 absent-stdio spawn failure still requires child close, unlike synchronous throw', async () => {
  const f = fixture(); f.c.stdout = null; f.c.stderr = null; f.c.exitCode = -2;
  const reader = createR05SelectedProcessReader(f.input), p = reader.read(query());
  f.c.emit('error', new Error('synthetic-private-sentinel'));
  await assert.rejects(() => reader.read(query()), denied); assert.equal(f.c.kills, 0);
  f.c.emit('close', -2, null); await assert.rejects(() => p, denied);
  const other = fixture(); other.input.spawn = () => { throw new Error('synthetic-private-sentinel'); };
  const immediate = createR05SelectedProcessReader(other.input);
  await assert.rejects(() => immediate.read(query()), denied); assert.equal(other.alarm(), null);
});
test('R05a2d2 eventual failure settlement releases exactly once for a fresh owned handle', async () => {
  const f = fixture(), second = child(); let calls = 0;
  f.input.spawn = () => ++calls === 1 ? f.c : second;
  const reader = createR05SelectedProcessReader(f.input), p = reader.read(query());
  f.c.stderr.emit('data', Buffer.from('x')); f.c.end(); f.c.close(); await assert.rejects(() => p, denied);
  f.c.close(); const success = reader.read(query()); second.stdout.emit('data', Buffer.from(JSON.stringify(volume)));
  second.end(); second.close(); assert.deepEqual((await success).value, volume); assert.equal(calls, 2);
});
test('R05a2d2 killtrue and killed flag do not settle a never-close fake handle', async () => {
  const f = fixture(); f.c.kill = () => { f.c.kills++; f.c.killed = true; return true; };
  const reader = createR05SelectedProcessReader(f.input), p = reader.read(query()); let finished = false;
  p.then(() => finished = true, () => finished = true); f.time(5000); f.fire();
  await assert.rejects(() => reader.read(query()), denied); await Promise.resolve();
  assert.equal(finished, false); assert.equal(f.c.kills, 1); assert.equal(f.alarm(), null);
  assert.equal(f.c.listenerCount('close'), 1); // Still quarantined, not disposed; no real process/timer exists.
});
test('R05a2d2 explicit public home config and unix endpoint references are snapshotted', async () => {
  const f = fixture(); f.input.env = { HOME: '/public/home', DOCKER_CONFIG: '/public/config', DOCKER_HOST: 'unix:///public/socket' };
  const reader = createR05SelectedProcessReader(f.input), expected = { ...f.input.env }; f.input.env.HOME = '/changed';
  const p = reader.read(query()); f.c.stdout.emit('data', Buffer.from(JSON.stringify(volume))); f.c.end(); f.c.close(); await p;
  assert.deepEqual(f.calls[0].options.env, expected);
});
test('R05a2d2 invalid UTF8 and regressing clock fail without rewritten output', async () => {
  for (const backwards of [false, true]) {
    const f = fixture(), p = createR05SelectedProcessReader(f.input).read(query());
    if (backwards) f.time(-1); f.c.stdout.emit('data', Buffer.from([255])); f.c.end(); f.c.close();
    await assert.rejects(() => p, denied);
  }
});
test('R05a2d2 exact raw-byte cap accepts UTF8 boundary and preserves configured image User', async () => {
  const f = fixture(), value = { Id: 'sha256:'+h(6), ConfiguredUser: '' };
  const q = { ...query(), kind: 'image', id: h(6), role: 'db' }; delete q.name;
  const reader = createR05SelectedProcessReader(f.input), p = reader.read(q);
  const json = Buffer.from(JSON.stringify(value)), padding = Buffer.alloc(32768-json.length, 32);
  f.c.stdout.emit('data', json); f.c.stdout.emit('data', padding); f.c.end(); f.c.close();
  assert.deepEqual((await p).value, value);
});
test('R05a2d2 timer scheduling failure quarantines the already-returned owned handle', async () => {
  const f = fixture(); f.input.clock.setTimeout = () => { throw new Error('synthetic-private-sentinel'); };
  const reader = createR05SelectedProcessReader(f.input), p = reader.read(query());
  await assert.rejects(() => reader.read(query()), denied); assert.equal(f.c.kills, 1);
  f.c.end(); f.c.close(); await assert.rejects(() => p, denied);
});
for (const kind of ['getter', 'proxy', 'hidden', 'symbol', 'prototype', 'NODE_OPTIONS', 'LD_PRELOAD', 'implicitHOME', 'relative']) {
  test('R05a2d2 unsafe factory '+kind+' refuses before spawning', () => {
    const f = fixture(); let calls = 0;
    if (kind === 'getter') Object.defineProperty(f.input, 'binary', { enumerable: true, get() { calls++; return process.execPath; } });
    if (kind === 'symbol') f.input[Symbol('hidden')] = 1;
    if (kind === 'hidden') Object.defineProperty(f.input, 'hidden', { value: true });
    if (kind === 'prototype') Object.setPrototypeOf(f.input.env, { inherited: true });
    if (kind === 'NODE_OPTIONS' || kind === 'LD_PRELOAD') f.input.env[kind] = 'unsupported';
    if (kind === 'implicitHOME') f.input.env.HOME = '/public-home';
    if (kind === 'relative') f.input.binary = 'node';
    const input = kind === 'proxy' ? new Proxy(f.input, { ownKeys() { calls++; return []; } }) : f.input;
    assert.throws(() => createR05SelectedProcessReader(input), denied); assert.equal(calls, 0); assert.equal(f.calls.length, 0);
  });
}
// These four real children run only inline synthetic Node programs, NOT Docker.
for (const scenario of ['success', 'bytes', 'stderr', 'timeout']) test('R05a2d2 OWN local Node '+scenario+' closes before settlement', { timeout: 30000 }, async t => {
  const f = fixture(); delete f.input.clock; f.input.cwd = process.cwd(); let c, closed, exitSeen = false, kills = 0, didClose = false;
  const program = scenario === 'success' ? 'process.stdout.write('+JSON.stringify(JSON.stringify(volume))+')'
    : scenario === 'bytes' ? "process.stdout.write('é'.repeat(17000));setInterval(()=>{},1000)"
      : scenario === 'stderr' ? "process.stderr.write('synthetic-public-error');setInterval(()=>{},1000)" : 'setInterval(()=>{},1000)';
  f.input.spawn = (binary, argv, options) => {
    c = spawn(binary, ['-e', program], options); // Visible synthetic substitution of the fixed selected argv.
    const kill = c.kill.bind(c); c.kill = () => { kills++; return kill(); };
    c.once('exit', () => exitSeen = true); closed = new Promise(r => c.once('close', () => { didClose = true; r(); })); return c;
  };
  t.after(async () => { if (c && !didClose && !exitSeen && c.exitCode === null && c.signalCode === null && kills === 0) c.kill(); if (closed) await closed; });
  const start = performance.now(), reader = createR05SelectedProcessReader(f.input);
  if (scenario === 'success') assert.deepEqual((await reader.read(query())).value, volume);
  else await assert.rejects(() => reader.read(query()), denied);
  await closed; assert.equal(didClose, true); assert.equal(c.stdout.closed, true); assert.equal(c.stderr.closed, true);
  assert.equal(kills, scenario === 'success' ? 0 : 1);
  if (scenario === 'timeout') assert.ok(performance.now()-start >= 4500);
});
