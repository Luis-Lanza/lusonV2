// Trusted exclusive local fixture only; repeated identity checks are not atomic same-UID protection.
import { types } from 'node:util';
import { dirname, resolve } from 'node:path/posix';
import { createHash } from 'node:crypto';
const refuse = () => { throw new Error('R05 filesystem metadata refused.'); };
const check = v => { if (!v) refuse(); };
const positive = v => Number.isSafeInteger(v) && v > 0;
const hex = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function own(v, array = false) {
  check(v && typeof v === 'object' && !types.isProxy(v)
    && Object.getPrototypeOf(v) === (array ? Array.prototype : Object.prototype));
  const ds = Object.getOwnPropertyDescriptors(v);
  check(Reflect.ownKeys(ds).every(k => typeof k === 'string' && 'value' in ds[k]
    && (array && k === 'length' || ds[k].enumerable)));
  return ds;
}
function keys(v, names) {
  const ds = own(v); check(Object.keys(ds).sort().join(' ') === names.split(' ').sort().join(' ')); return ds;
}
function copy(input) {
  let nodes = 0, bytes = 0; const active = new Set();
  function visit(v, depth) {
    check(++nodes <= 2048 && depth <= 16);
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'number') { check(Number.isSafeInteger(v) && !Object.is(v, -0)); return v; }
    if (typeof v === 'string') { bytes += Buffer.byteLength(v); check(v.length <= 4096 && bytes <= 65536); return v; }
    check(!active.has(v)); const array = Array.isArray(v), ds = own(v, array), names = Object.keys(ds);
    check(names.length <= 129);
    if (array) check(ds.length.value <= 128 && names.length === ds.length.value+1);
    active.add(v); const out = array ? [] : {};
    for (const k of names) {
      if (array && k === 'length') continue;
      bytes += k.length;
      check(bytes <= 65536 && /^[\x20-\x7e]{1,128}$/.test(k) && !['__proto__', 'constructor', 'prototype'].includes(k));
      if (array) check(/^(0|[1-9][0-9]*)$/.test(k) && Number(k) < ds.length.value);
      out[k] = visit(ds[k].value, depth+1);
    }
    active.delete(v); return out;
  }
  return visit(input, 0);
}
function freeze(v) {
  if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const canonical = p => typeof p === 'string' && p.startsWith('/') && !p.includes('\0') && resolve(p) === p;
function integer(v, min, max) {
  if (typeof v === 'bigint') { check(v >= BigInt(min) && v <= BigInt(max)); return Number(v); }
  check(Number.isSafeInteger(v) && !Object.is(v, -0) && v >= min && v <= max); return v;
}
function stat(raw) {
  const ds = keys(raw, 'device inode uid mode type symlink'), val = k => ds[k].value;
  check(['directory', 'file'].includes(val('type')) && val('symlink') === false);
  return { device: integer(val('device'), 1, Number.MAX_SAFE_INTEGER), inode: integer(val('inode'), 1, Number.MAX_SAFE_INTEGER),
    uid: integer(val('uid'), 0, Number.MAX_SAFE_INTEGER), mode: integer(val('mode'), 0, 0o7777),
    type: val('type'), symlink: false };
}
const OPEN_DIRECTORY = freeze({ readonly: true, nofollow: true, nonblock: true, directory: true, bigint: true });
const OPEN_FILE = freeze({ readonly: true, nofollow: true, nonblock: true, directory: false, bigint: true });
const MAX_SOURCE = 1024*1024, CHUNK = 65536;
const typed = Object.getPrototypeOf(Uint8Array.prototype);
const byteGetter = name => Object.getOwnPropertyDescriptor(typed, name).get;
const byteLength = byteGetter('byteLength'), byteOffset = byteGetter('byteOffset'), byteBuffer = byteGetter('buffer');
function bytes(raw, limit) {
  check(raw && !types.isProxy(raw) && types.isUint8Array(raw));
  const length = byteLength.call(raw), buffer = byteBuffer.call(raw), offset = byteOffset.call(raw);
  check(length <= limit && !types.isSharedArrayBuffer(buffer));
  return Buffer.from(new Uint8Array(buffer, offset, length));
}
export function createR05FilesystemMetadataReader(input) {
  try {
    const ds = keys(input, 'project root uid manifest dsn sources fs');
    const fsds = keys(ds.fs.value, 'lstat open stat read close');
    const fs = Object.fromEntries(Object.entries(fsds).map(([k, d]) => {
      check(typeof d.value === 'function' && !types.isProxy(d.value)); return [k, d.value];
    }));
    const a = copy(Object.fromEntries(Object.entries(ds).filter(([k]) => k !== 'fs').map(([k, d]) => [k, d.value])));
    check(/^luson-r05-[a-f0-9]{16,32}$/.test(a.project) && canonical(a.root) && a.root !== '/'
      && positive(a.uid) && Array.isArray(a.sources) && a.sources.length > 0 && a.sources.length <= 32);
    a.sources.forEach(s => { keys(s, 'path sha256'); check(hex(s.sha256)); });
    const paths = [a.root, a.manifest, a.dsn, ...a.sources.map(s => s.path)];
    check(new Set(paths).size === paths.length && paths.slice(1).every(p => canonical(p) && dirname(p) === a.root));
    return reader(freeze(a), freeze(paths), fs);
  } catch { refuse(); }
}
function reader(a, paths, fs) {
  let busy = false, quarantined = false, activeOwned = []; const retained = [];
  async function read(input) {
    check(!busy && !quarantined); busy = true;
    const owned = [], observed = new Map(); activeOwned = owned; let result, failed = false;
    try {
      const q = copy(input); keys(q, 'kind project frame paths source_paths'); keys(q.frame, 'mode attempt sequence request');
      check(q.kind === 'metadata' && q.project === a.project && same(q.paths, paths)
        && same(q.source_paths, a.sources.map(s => s.path)) && ['active', 'lifecycle'].includes(q.frame.mode)
        && [q.frame.attempt, q.frame.sequence, q.frame.request].every(positive)
        && (q.frame.mode !== 'lifecycle' || q.frame.request === q.frame.sequence));
      const ancestors = p => { const out = []; let parent = dirname(p);
        while (true) { out.unshift(parent); if (parent === '/') return out; parent = dirname(parent); } };
      function allowed(p, s) {
        if (p === a.root) check(s.uid === a.uid && s.mode === 0o700 && s.type === 'directory');
        else if (paths.includes(p)) check(s.uid === a.uid && s.mode === 0o600 && s.type === 'file');
        else check(s.type === 'directory' && (s.uid === 0 || s.uid === a.uid) && (s.mode & 0o022) === 0);
      }
      async function acquire(p) {
        if (observed.has(p)) return observed.get(p);
        const before = stat(await fs.lstat(p)); allowed(p, before);
        const token = await fs.open(p, before.type === 'directory' ? OPEN_DIRECTORY : OPEN_FILE);
        // Register even malformed safety candidates before validation; never interpret numeric FDs.
        // A repeated token is already owned, not permission to close it twice.
        check(!owned.some(entry => entry.token === token));
        const entry = { token, opaque: token !== null && (typeof token === 'object' || typeof token === 'function') };
        owned.push(entry);
        check(entry.opaque && typeof token === 'object' && !types.isProxy(token)
          && Object.getPrototypeOf(token) === Object.prototype);
        const opened = stat(await fs.stat(token)), after = stat(await fs.lstat(p));
        check(same(before, opened) && same(before, after));
        const row = { token, stat: opened }; observed.set(p, row); return row;
      }
      for (const p of paths) { for (const parent of ancestors(p)) await acquire(parent); await acquire(p); }
      const hashes = new Map();
      for (const source of a.sources) {
        const row = observed.get(source.path), hash = createHash('sha256'); let offset = 0;
        while (true) {
          const length = Math.min(CHUNK, MAX_SOURCE-offset+1);
          const chunk = bytes(await fs.read(row.token, freeze({ offset, length })), Math.min(length, MAX_SOURCE-offset));
          check(offset+chunk.length <= MAX_SOURCE);
          if (chunk.length === 0) break;
          hash.update(chunk); offset += chunk.length;
        }
        check(same(row.stat, stat(await fs.stat(row.token))));
        const sha256 = hash.digest('hex'); check(sha256 === source.sha256); hashes.set(source.path, sha256);
      }
      for (const [p, row] of observed) {
        check(same(row.stat, stat(await fs.stat(row.token))) && same(row.stat, stat(await fs.lstat(p))));
      }
      const metadata = p => { const s = observed.get(p).stat;
        return { path: p, uid: s.uid, mode: s.mode, type: s.type, symlink: false,
          ...(hashes.has(p) ? { sha256: hashes.get(p) } : {}) }; };
      const handles = paths.map(p => {
        const s = observed.get(p).stat;
        return { path: p, device: s.device, inode: s.inode, opened: { device: s.device, inode: s.inode },
          ancestors: ancestors(p).map(parent => ({ path: parent, ...observed.get(parent).stat })) };
      });
      result = freeze({ frame: q.frame, value: { root: metadata(a.root), files: paths.slice(1).map(metadata),
        sources: a.sources.map(s => metadata(s.path)), handles } });
    } catch { failed = true; }
    for (const entry of owned) {
      try { check(entry.opaque); await fs.close(entry.token); entry.confirmed = true; }
      catch { quarantined = true; failed = true; }
    }
    retained.push(...owned.filter(entry => !entry.confirmed)); activeOwned = [];
    busy = false;
    if (failed || quarantined) refuse();
    return result;
  }
  return Object.freeze({ read, status: () => Object.freeze({ busy, quarantined,
    owned: retained.length+activeOwned.filter(entry => !entry.confirmed).length }) });
}
