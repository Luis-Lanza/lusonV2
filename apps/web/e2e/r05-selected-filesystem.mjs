// Parent-selected SDK functions only; observational controlled-local binding, not atomic path authority.
import { types } from 'node:util';
import { dirname } from 'node:path/posix';
import { createR05FilesystemMetadataReader } from './r05-filesystem-metadata.mjs';
import { projectR05NativeStat } from './r05-native-stat.mjs';

const refuse = () => { throw new Error('R05 selected filesystem refused.'); };
const check = value => { if (!value) refuse(); };
const MAX_SOURCE = 1024*1024, CHUNK = 65536, REQUEST_BUDGET = MAX_SOURCE+CHUNK;
function data(value, names, sdkResult = false) {
  check(value && typeof value === 'object' && !types.isProxy(value));
  const prototype = Object.getPrototypeOf(value);
  check(prototype === Object.prototype || (sdkResult && prototype === null));
  const ds = Object.getOwnPropertyDescriptors(value);
  check(Reflect.ownKeys(ds).every(k => typeof k === 'string' && 'value' in ds[k] && ds[k].enumerable));
  check(Object.keys(ds).sort().join(' ') === names.split(' ').sort().join(' '));
  return Object.fromEntries(Object.entries(ds).map(([k, d]) => [k, d.value]));
}
// Called only after the frozen policy constructor has validated this entire data tree.
function detach(value) {
  if (!value || typeof value !== 'object') return value;
  const out = Array.isArray(value) ? [] : {};
  for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (k !== 'length') out[k] = detach(d.value);
  }
  return Object.freeze(out);
}
export function createR05SelectedFilesystemReader(input) {
  try {
    const args = data(input, 'approval native');
    const n = data(args.native, 'lstatBigInt openReadonly fstatBigInt readInto closeHandle flags');
    for (const k of ['lstatBigInt', 'openReadonly', 'fstatBigInt', 'readInto', 'closeHandle']) {
      check(typeof n[k] === 'function' && !types.isProxy(n[k]));
    }
    const flags = data(n.flags, 'O_RDONLY O_NOFOLLOW O_NONBLOCK O_DIRECTORY');
    check(flags.O_RDONLY === 0
      && Object.values(flags).every(v => Number.isInteger(v) && v >= 0 && v <= 0x7fffffff));
    const bits = [flags.O_NOFOLLOW, flags.O_NONBLOCK, flags.O_DIRECTORY];
    check(bits.every(v => v > 0 && (v & (v-1)) === 0));
    check(bits.every((v, i) => bits.slice(i+1).every(w => (v & w) === 0))
      && bits.every(v => (v & flags.O_RDONLY) === 0));
    const approval = data(args.approval, 'project root uid manifest dsn sources');
    // No I/O occurs at construction; this is the sole approval-policy validator.
    const inert = Object.fromEntries(['lstat', 'open', 'stat', 'read', 'close'].map(k => [k, refuse]));
    createR05FilesystemMetadataReader({ ...approval, fs: inert });
    return compose(detach(approval), Object.freeze(n), Object.freeze(flags));
  } catch { refuse(); }
}
function compose(a, n, flags) {
  const selected = [a.root, a.manifest, a.dsn, ...a.sources.map(s => s.path)];
  const whitelist = new Set(selected), sources = new Set(a.sources.map(s => s.path));
  for (const path of selected) {
    let parent = dirname(path);
    while (true) { whitelist.add(parent); if (parent === '/') break; parent = dirname(parent); }
  }
  const owned = new Map(), identities = new WeakSet();
  let busy = false, quarantined = false;
  function entry(token) {
    const e = owned.get(token);
    check(e && e.state === 'open' && e.safe);
    return e;
  }
  const fs = {
    lstat: async path => {
      check(whitelist.has(path));
      const observation = n.lstatBigInt(path);
      return projectR05NativeStat(types.isPromise(observation) ? await observation : observation);
    },
    open: async (path, options) => {
      check(whitelist.has(path));
      const directory = !selected.includes(path) || path === a.root;
      check(options.readonly === true && options.nofollow === true && options.nonblock === true
        && options.bigint === true && options.directory === directory);
      const openFlags = flags.O_RDONLY | flags.O_NOFOLLOW | flags.O_NONBLOCK | (directory ? flags.O_DIRECTORY : 0);
      const acquisition = n.openReadonly(path, openFlags);
      const handle = types.isPromise(acquisition) ? await acquisition : acquisition;
      // Retain the actual acquisition before any shape or metadata checks.
      const token = Object.freeze({});
      const e = { handle, path, safe: false, state: 'open', offset: 0, requested: 0, eof: false };
      owned.set(token, e);
      const object = handle !== null && typeof handle === 'object';
      if (object && identities.has(handle)) {
        // Prior ownership is not a new permission to close this identity twice.
        const stillOwned = [...owned.values()].some(other => other !== e && other.handle === handle);
        if (stillOwned) owned.delete(token);
        else e.state = 'unknown';
        quarantined = true; refuse();
      }
      if (object) identities.add(handle);
      e.safe = object && !types.isProxy(handle);
      if (!e.safe) { e.state = 'unknown'; quarantined = true; refuse(); }
      if (Array.isArray(handle)) {
        // A known own object is closeable by the selected external function, but not usable.
        try { await close(token); } catch { /* retained by close */ }
        refuse();
      }
      return token;
    },
    stat: async token => {
      const observation = n.fstatBigInt(entry(token).handle);
      return projectR05NativeStat(types.isPromise(observation) ? await observation : observation);
    },
    read: async (token, request) => {
      const e = entry(token), q = data(request, 'offset length');
      check(sources.has(e.path) && !e.eof && Number.isSafeInteger(q.offset) && q.offset === e.offset
        && Number.isSafeInteger(q.length) && q.length > 0 && q.length <= CHUNK && e.offset < MAX_SOURCE);
      const length = Math.min(q.length, MAX_SOURCE-e.offset);
      check(e.requested+length <= REQUEST_BUDGET);
      e.requested += length; // Charge allocation and native request bytes before either operation.
      const buffer = Buffer.alloc(length), backing = buffer.buffer, base = buffer.byteOffset;
      const reading = n.readInto(e.handle, buffer, 0, length, e.offset);
      const result = data(types.isPromise(reading) ? await reading : reading, 'bytesRead buffer', true);
      check(result.buffer === buffer && Number.isInteger(result.bytesRead) && !Object.is(result.bytesRead, -0)
        && result.bytesRead >= 0 && result.bytesRead <= length);
      check(e.offset+result.bytesRead < MAX_SOURCE); // Exact maximum cannot prove EOF within this range.
      e.offset += result.bytesRead;
      e.eof = result.bytesRead === 0; // Only a positive-length native read can establish EOF.
      return new Uint8Array(backing, base, result.bytesRead);
    },
    close,
  };
  async function close(token) {
    const e = entry(token);
    e.state = 'closing';
    try {
      const closing = n.closeHandle(e.handle);
      check((types.isPromise(closing) ? await closing : closing) === undefined);
      owned.delete(token); // Confirmed fulfillment releases the actual native reference.
    } catch {
      e.state = 'unknown'; quarantined = true; refuse();
    }
  }
  const policy = createR05FilesystemMetadataReader({ ...a, fs });
  async function read(request) {
    check(!busy && !quarantined); busy = true;
    let result, failed = false;
    try { result = await policy.read(request); } catch { failed = true; }
    // An open refusal may precede token delivery to the policy. Close every remaining known own handle.
    for (const [token, e] of owned) {
      if (e.safe && e.state === 'open') {
        try { await close(token); } catch { failed = true; }
      }
    }
    busy = false;
    if (failed || quarantined || owned.size) refuse();
    return result;
  }
  return Object.freeze({ read, status: () => Object.freeze({ busy, quarantined, owned: owned.size }) });
}
