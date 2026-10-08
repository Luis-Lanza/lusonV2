import test from 'node:test';
import assert from 'node:assert/strict';
import { createR05SelectedMetadataReader } from './r05-selected-metadata.mjs';
import { volumeFingerprint } from './r05-driver.mjs';
const h = n => n.toString(16).padStart(64, '0');
const project = 'luson-r05-abcdef0123456789', volumeName = project+'-data';
const frame = { mode: 'lifecycle', attempt: 1, sequence: 1, request: 1 };
const volume = { Name: volumeName, Driver: 'local', CreatedAt: '2026-01-01T00:00:00Z',
  Options: null, Scope: 'local', Labels: { scope: 'synthetic', 'com.docker.compose.project': project,
    'com.docker.compose.volume': 'data', 'com.docker.compose.version': 'synthetic-version' } };
const selector = (kind = 'volume', role = 'db') => kind === 'volume' ? { kind, project, frame, name: volumeName }
  : { kind, project, frame, role, id: h(role === 'db' ? 6 : 5) };
const refused = e => e.message === 'R05 selected metadata refused.' && e.cause === undefined;
function fixture(value = volume) {
  const calls = [], input = { project, volumeName, images: { app: h(5), db: h(6) },
    execute: async q => { calls.push(q); return { exitCode: 0, stdout: JSON.stringify(value) }; } };
  return { input, calls, reader: createR05SelectedMetadataReader(input) };
}
test('R05a2d1 selected volume preserves every native identity field and fingerprint', async () => {
  const f = fixture(); const result = await f.reader.read(selector());
  assert.deepEqual(result.frame, frame); assert.deepEqual(result.value, volume);
  assert.equal(volumeFingerprint(result.value), volumeFingerprint(volume));
  assert.equal(Object.isFrozen(result.value.Labels), true);
  assert.equal(f.calls.length, 1);
});
test('R05a2d1 fixed vectors select only six native volume fields and two image fields', async () => {
  const v = fixture(); await v.reader.read(selector());
  assert.deepEqual(v.calls[0].argv, ['volume', 'inspect', '--format',
    '{"Name":{{json .Name}},"Driver":{{json .Driver}},"CreatedAt":{{json .CreatedAt}},"Options":{{json .Options}},"Scope":{{json .Scope}},"Labels":{{json .Labels}}}', '--', volumeName]);
  const i = fixture({ Id: 'sha256:'+h(6), ConfiguredUser: '' });
  const result = await i.reader.read(selector('image'));
  assert.equal(result.value.ConfiguredUser, '');
  assert.deepEqual(i.calls[0].argv, ['image', 'inspect', '--format',
    '{"Id":{{json .Id}},"ConfiguredUser":{{json .Config.User}}}', '--', 'sha256:'+h(6)]);
  assert.deepEqual(Object.keys(i.calls[0]).sort(), ['argv', 'max_stderr_bytes', 'max_stdout_bytes', 'timeout_ms']);
  assert.equal(i.calls[0].timeout_ms, 5000); assert.equal(i.calls[0].max_stdout_bytes, 32768);
  assert.equal(i.calls[0].max_stderr_bytes, 0); assert.equal(Object.isFrozen(i.calls[0].argv), true);
});
for (const [name, change] of Object.entries({ project: q => q.project = 'other', name: q => q.name = 'other',
  kind: q => q.kind = 'container', args: q => q.argv = ['inspect'], format: q => q.format = '{{json .}}',
  executable: q => q.executable = 'other', host: q => q.host = 'other', flag: q => q.owned = true,
  frame: q => q.frame = { ...frame, request: 0 }, role: q => q.role = 'other', id: q => q.id = 'short' })) {
  test('R05a2d1 invalid selector '+name+' refuses before execution', async () => {
    const f = fixture(), q = selector(['role', 'id'].includes(name) ? 'image' : 'volume'); change(q);
    await assert.rejects(() => f.reader.read(q), refused); assert.equal(f.calls.length, 0);
  });
}
test('R05a2d1 image ID cannot cross approved role and returned targets must match', async () => {
  const f = fixture(); const q = selector('image'); q.id = h(5);
  await assert.rejects(() => f.reader.read(q), refused); assert.equal(f.calls.length, 0);
  for (const [value, query] of [[{ ...volume, Name: 'other' }, selector()],
    [{ Id: 'sha256:'+h(5), ConfiguredUser: '' }, selector('image')]])
    await assert.rejects(() => fixture(value).reader.read(query), refused);
});
for (const field of ['Env', 'Cmd', 'Entrypoint', 'History']) test('R05a2d1 forbidden stdout '+field+' refuses without redaction', async () => {
  for (const [value, query] of [[{ ...volume, [field]: 'synthetic-private-sentinel' }, selector()],
    [{ Id: 'sha256:'+h(6), ConfiguredUser: '', [field]: 'synthetic-private-sentinel' }, selector('image')]])
    await assert.rejects(() => fixture(value).reader.read(query), refused);
});
test('R05a2d1 malformed oversized and unsupported public JSON refuse generically', async () => {
  let deep = {}; for (let n = 0; n < 18; n++) deep = { nested: deep };
  for (const stdout of ['{', 'null', '[]', ' '.repeat(32769), JSON.stringify({ ...volume, Labels: { long: 'x'.repeat(4097) } }),
    JSON.stringify({ ...volume, Options: [] }), JSON.stringify({ ...volume, Labels: { invalid: 1 } }), JSON.stringify(deep)]) {
    const f = fixture(); f.input.execute = async () => ({ exitCode: 0, stdout });
    await assert.rejects(() => createR05SelectedMetadataReader(f.input).read(selector()), refused);
  }
});
test('R05a2d1 executor errors nonzero exits and stderr never become diagnostics', async () => {
  for (const execute of [async () => { throw new Error('synthetic-private-sentinel'); },
    async () => ({ exitCode: 1, stdout: 'synthetic-private-sentinel' }),
    async () => ({ exitCode: 0, stdout: JSON.stringify(volume), stderr: 'synthetic-private-sentinel' })]) {
    const f = fixture(); f.input.execute = execute;
    await assert.rejects(() => createR05SelectedMetadataReader(f.input).read(selector()), refused);
  }
});
test('R05a2d1 unresolved execution keeps instance busy without a timeout race', async () => {
  const f = fixture(); let release, entered, calls = 0;
  const started = new Promise(r => entered = r), wait = new Promise(r => release = r);
  f.input.execute = async () => { calls++; entered(); await wait; return { exitCode: 0, stdout: JSON.stringify(volume) }; };
  const reader = createR05SelectedMetadataReader(f.input), first = reader.read(selector()); await started;
  await assert.rejects(() => reader.read(selector()), refused); assert.equal(calls, 1);
  release(); await first; await reader.read(selector()); assert.equal(calls, 2);
});
for (const kind of ['getter', 'hidden', 'symbol', 'prototype', 'proxy']) test('R05a2d1 descriptor boundary rejects '+kind+' without invocation', async () => {
  const f = fixture(), q = selector(); let calls = 0;
  if (kind === 'getter') Object.defineProperty(q, 'name', { enumerable: true, get() { calls++; return volumeName; } });
  if (kind === 'hidden') Object.defineProperty(q, 'hidden', { value: 1 });
  if (kind === 'symbol') q[Symbol('hidden')] = 1;
  if (kind === 'prototype') Object.setPrototypeOf(q, { inherited: true });
  const value = kind === 'proxy' ? new Proxy(q, { ownKeys() { calls++; return []; } }) : q;
  await assert.rejects(() => f.reader.read(value), refused); assert.equal(calls, 0); assert.equal(f.calls.length, 0);
});
test('R05a2d1 factory and executor-result accessors never run', async () => {
  const f = fixture(); let calls = 0;
  Object.defineProperty(f.input, 'project', { enumerable: true, get() { calls++; return project; } });
  assert.throws(() => createR05SelectedMetadataReader(f.input), refused);
  const other = fixture(); other.input.execute = async () => Object.defineProperty({}, 'stdout',
    { enumerable: true, get() { calls++; throw new Error('synthetic-private-sentinel'); } });
  await assert.rejects(() => createR05SelectedMetadataReader(other.input).read(selector()), refused);
  assert.equal(calls, 0);
});
test('R05a2d1 approved bindings and request frames are cloned before awaiting execution', async () => {
  const f = fixture({ Id: 'sha256:'+h(6), ConfiguredUser: '' }), q = selector('image');
  f.input.images.db = h(5); f.input.project = 'other';
  const resultPromise = f.reader.read(q); q.frame = { ...frame, request: 9 }; q.id = h(5);
  const result = await resultPromise; assert.equal(result.frame.request, 1); assert.equal(result.value.Id, 'sha256:'+h(6));
  assert.equal(Object.isFrozen(result.frame), true); assert.throws(() => result.value.ConfiguredUser = 'changed', TypeError);
});
