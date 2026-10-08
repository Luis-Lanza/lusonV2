// Injected public DTO protocol only. No engine/filesystem client or effect API.
import { types } from 'node:util';
import { dirname, resolve } from 'node:path/posix';
import { admit, digest } from './r05-binding.mjs';
import { normalizeR05Evidence, normalizeR05LifecycleEvidence, volumeFingerprint } from './r05-driver.mjs';
import { projectR05PublicConfig, restoreR05PublicConfig } from './r05-config-projection.mjs';
const refuse = () => { throw new Error('R05 collector refused.'); };
const check = v => { if (!v) refuse(); };
const hex = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const positive = v => Number.isSafeInteger(v) && v > 0;
const same = (a, b) => digest(a) === digest(b);
function descriptors(value) {
  check(value && typeof value === 'object' && !types.isProxy(value)
    && Object.getPrototypeOf(value) === Object.prototype);
  const ds = Object.getOwnPropertyDescriptors(value);
  check(Reflect.ownKeys(ds).every(k => typeof k === 'string' && ds[k].enumerable && 'value' in ds[k]));
  return ds;
}
function keys(value, names) {
  const ds = descriptors(value);
  check(Object.keys(ds).sort().join(' ') === names.split(' ').sort().join(' '));
}
// Bound total work before access/hash; accessors and proxy traps never execute.
function copy(input) {
  let nodes = 0, bytes = 0; const active = new Set();
  function visit(v, depth) {
    check(depth <= 32 && ++nodes <= 16384);
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'number') { check(Number.isSafeInteger(v) && !Object.is(v, -0)); return v; }
    if (typeof v === 'string') { bytes += Buffer.byteLength(v); check(v.length <= 4096 && bytes <= 262144); return v; }
    check(v && typeof v === 'object' && !types.isProxy(v) && !active.has(v));
    const array = Array.isArray(v);
    check(Object.getPrototypeOf(v) === (array ? Array.prototype : Object.prototype));
    const ds = Object.getOwnPropertyDescriptors(v), names = Reflect.ownKeys(ds);
    check(names.length <= 256 && names.every(k => typeof k === 'string'));
    if (array) check(ds.length.value <= 128 && names.length === ds.length.value+1);
    const result = array ? [] : {}; active.add(v);
    for (const k of names) {
      if (array && k === 'length') continue;
      const d = ds[k]; bytes += k.length;
      check(bytes <= 262144 && d.enumerable && 'value' in d && /^[\x20-\x7e]{1,128}$/.test(k)
        && !['__proto__', 'constructor', 'prototype'].includes(k));
      if (array) check(/^(0|[1-9][0-9]*)$/.test(k) && Number(k) < ds.length.value);
      result[k] = visit(d.value, depth+1);
    }
    active.delete(v); return result;
  }
  return visit(input, 0);
}
function freeze(v) {
  if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); }
  return v;
}
function set(a, b) {
  check(Array.isArray(a) && new Set(a).size === a.length && a.length === b.length && a.every(v => b.includes(v)));
}
function prepare(m) {
  return { ...m, phase: 'prepare', network: { ...m.network, id: null }, volume: { ...m.volume, id: null },
    services: Object.fromEntries(Object.entries(m.services).map(([role, spec]) => [role, { ...spec, id: null }])) };
}
function emptyRaw(m, config) {
  return { request: 1, root: { path: m.root, uid: m.uid, mode: 0o700, type: 'directory', symlink: false },
    files: [m.manifest, m.dsn, ...m.sources], sources: m.sources, config,
    existing_names: [], network: null, volume: null, project_ids: [], volume_users: [], containers: [] };
}
export function createR05Collector(input) {
  try {
    keys(input, 'manifest labelPolicy transport');
    const ds = descriptors(input);
    const m = copy(ds.manifest.value), p = copy(ds.labelPolicy.value), transport = ds.transport.value;
    keys(transport, 'read'); const read = descriptors(transport).read.value;
    check(typeof read === 'function' && !types.isProxy(read));
    // Static declaration/policy validation, not synthetic evidence of resources.
    check(['prepare', 'active'].includes(m.phase) && hex(m.config_digest));
    const pm = prepare(m), config = { services: { app: { depends_on: { db: { condition: 'service_healthy' } } }, db: {} } };
    const declaration = { ...pm, config_digest: digest(config) };
    admit(declaration, normalizeR05Evidence({ manifest: declaration, labelPolicy: p,
      raw: emptyRaw(declaration, config), sequence: 1 }), 'prepare');
    const pinned = [m.network.id, m.volume.id, m.services.db.id, m.services.app.id];
    check(m.phase === 'active' ? pinned.every(hex) && new Set(pinned).size === 4 : pinned.every(v => v === null));
    return collector(m, pm, p, read);
  } catch { refuse(); }
}
function collector(m, pm, p, read) {
  let busy = false, attempt = 0, sequence = 0, request = 0, last = null, latch = null;
  const paths = [m.root, m.manifest.path, m.dsn.path, ...m.sources.map(f => f.path)];
  const planned = { network: m.network.name, volume: m.volume.name, db: m.project+'-db-1', app: m.project+'-app-1' };
  function selections(ids, pending, mode) {
    keys(ids, 'network volume db app');
    const full = [ids.network, ids.db, ids.app].filter(v => v !== null);
    check(full.every(hex) && new Set(full).size === full.length);
    if (ids.volume !== null) { keys(ids.volume, 'name fingerprint'); check(ids.volume.name === m.volume.name && hex(ids.volume.fingerprint)); }
    if (mode === 'active') {
      check(pending === null && same(ids, { network: m.network.id, db: m.services.db.id, app: m.services.app.id,
        volume: m.volume.id === null ? null : { name: m.volume.name, fingerprint: m.volume.id } }));
      return { ids, safety: null };
    }
    check(m.phase === 'prepare');
    if (pending === null) return { ids, safety: null };
    keys(pending, 'operation attempt base_sequence context expected_name result');
    const roles = { createNetwork: 'network', createVolume: 'volume', createDB: 'db', createAPP: 'app' };
    const role = roles[pending.operation]; check(role && positive(pending.attempt));
    check(pending.expected_name === planned[role] && same(pending.context,
      { project: m.project, root: m.root, config_digest: m.config_digest }) && ids[role] === null);
    if (role === 'volume') { keys(pending.result, 'Name'); check(pending.result.Name === m.volume.name); }
    else { keys(pending.result, 'id'); check(hex(pending.result.id) && !full.includes(pending.result.id)); }
    if (latch && latch.pending.attempt === pending.attempt) check(same(latch.pending, pending) && same(latch.ids, ids));
    else {
      check(last && pending.base_sequence === last.sequence && same(last.ids, ids)
        && (!latch || pending.attempt > latch.pending.attempt));
      check(role === 'network' || role === 'volume' ? last.census[role] === null
        : !last.census.containers.some(c => c.role === role));
      check(!last.census.conflicts.includes(planned[role]));
      latch = { pending: copy(pending), ids: copy(ids) }; // Safety binding, never owned identities.
    }
    const selected = copy(ids);
    selected[role] = role === 'volume' ? { name: pending.result.Name, fingerprint: null } : pending.result.id;
    return { ids: selected, safety: role };
  }
  function census(c, selected) {
    keys(c, 'project_ids volume_users containers network volume conflicts');
    check(Array.isArray(c.containers) && Array.isArray(c.conflicts) && c.conflicts.length === 0);
    for (const row of c.containers) {
      keys(row, 'id role name state'); check(['db', 'app'].includes(row.role) && hex(row.id)
        && row.id === selected.ids[row.role] && row.name === planned[row.role]
        && ['created', 'running', 'exited'].includes(row.state));
    }
    check(new Set(c.containers.map(v => v.role)).size === c.containers.length);
    set(c.project_ids, c.containers.map(v => v.id));
    set(c.volume_users, c.containers.filter(v => v.role === 'db').map(v => v.id));
    if (c.network !== null) {
      keys(c.network, 'id name members'); check(hex(c.network.id) && c.network.id === selected.ids.network && c.network.name === planned.network);
      set(c.network.members, c.containers.filter(v => v.state === 'running').map(v => v.id));
    } else check(c.containers.length === 0);
    if (c.volume !== null) {
      keys(c.volume, 'name fingerprint'); check(selected.ids.volume && c.volume.name === selected.ids.volume.name && hex(c.volume.fingerprint));
      if (selected.safety !== 'volume') check(c.volume.fingerprint === selected.ids.volume.fingerprint);
    } else check(c.volume_users.length === 0);
    // Unknown namespace IDs/shared users/members fail here, before ANY inspection.
    return c;
  }
  function handles(data) {
    keys(data, 'root files sources handles');
    check(Array.isArray(data.handles)); set(data.handles.map(v => v.path), paths);
    const observed = new Map();
    function record(path, device, inode, uid, mode, type, symlink) {
      const value = { device, inode, uid, mode, type, symlink };
      check(positive(device) && positive(inode) && Number.isSafeInteger(uid) && uid >= 0
        && Number.isSafeInteger(mode) && mode >= 0 && mode <= 0o7777 && symlink === false);
      if (observed.has(path)) check(same(observed.get(path), value)); else observed.set(path, value);
    }
    for (const handle of data.handles) {
      keys(handle, 'path device inode opened ancestors'); keys(handle.opened, 'device inode');
      check(same(handle.opened, { device: handle.device, inode: handle.inode }));
      const stat = [data.root, ...data.files].find(v => v.path === handle.path); check(stat);
      record(handle.path, handle.device, handle.inode, stat.uid, stat.mode, stat.type, stat.symlink);
      const parents = []; let parent = dirname(handle.path);
      while (true) { parents.unshift(parent); if (parent === '/') break; parent = dirname(parent); }
      check(Array.isArray(handle.ancestors) && handle.ancestors.length === parents.length);
      handle.ancestors.forEach((a, i) => {
        keys(a, 'path device inode uid mode type symlink');
        check(a.path === parents[i] && resolve(a.path) === a.path && a.type === 'directory'
          && (a.uid === 0 || a.uid === m.uid) && (a.mode & 0o022) === 0);
        record(a.path, a.device, a.inode, a.uid, a.mode, a.type, a.symlink);
      });
    }
  }
  async function collect(mode, input) {
    check(!busy); busy = true;
    try {
      const q = copy(input);
      keys(q, mode === 'active' ? 'request identities' : 'sequence identities pending');
      check(mode === 'active' ? positive(q.request) && q.request > request : positive(q.sequence) && q.sequence > sequence);
      const next = mode === 'active' ? sequence+1 : q.sequence; check(positive(next) && positive(attempt+1));
      const selected = selections(q.identities, mode === 'active' ? null : q.pending, mode);
      const frame = { mode, attempt: ++attempt, sequence: next, request: mode === 'active' ? q.request : next };
      const query = async selector => {
        const response = copy(await read(freeze(copy({ ...selector, project: m.project, frame }))));
        keys(response, 'frame value'); check(same(response.frame, frame)); return response.value;
      };
      async function bindings() {
        const data = await query({ kind: 'metadata', paths, source_paths: m.sources.map(f => f.path) }); handles(data);
        const config = await query({ kind: 'public-config', sources: m.sources.map(f => f.path) });
        keys(config, 'original projected service_hashes'); keys(config.service_hashes, 'app db');
        const projected = projectR05PublicConfig(config.original), original = restoreR05PublicConfig(config.projected);
        check(same(projected, config.projected) && same(original, config.original) && digest(projected) === m.config_digest);
        for (const role of ['app', 'db']) check(config.service_hashes[role] === m.services[role].compose_hash);
        const raw = { ...emptyRaw(pm, projected), root: data.root, files: data.files, sources: data.sources };
        admit(pm, normalizeR05Evidence({ manifest: pm, raw, labelPolicy: p, sequence: next }), 'prepare');
        const view = census(await query({ kind: 'census', planned_names: planned, volume_name: m.volume.name }), selected);
        return { data, config, census: view };
      }
      const first = await bindings();
      async function resources() {
        const c = first.census;
        const network = c.network === null ? null : await query({ kind: 'network', id: c.network.id });
        if (network) {
          check(network.Id === c.network.id && network.Name === c.network.name);
          set(Object.keys(network.Containers), c.network.members);
        }
        const volume = c.volume === null ? null : await query({ kind: 'volume', name: c.volume.name });
        if (volume) check(volume.Name === c.volume.name && volumeFingerprint(volume) === c.volume.fingerprint);
        const containers = [], images = [];
        for (const role of ['db', 'app']) {
          const row = c.containers.find(v => v.role === role); if (!row) continue;
          const container = await query({ kind: 'container', id: row.id, role, view: mode });
          check(container.Id === row.id && container.Name === '/'+row.name && container.State.Status === row.state
            && container.Config.Labels['com.docker.compose.service'] === role);
          containers.push(container);
          const image = await query({ kind: 'image', id: m.services[role].image, role });
          keys(image, 'Id ConfiguredUser'); check(image.Id === 'sha256:'+m.services[role].image
            && image.ConfiguredUser === m.services[role].user); images.push(image);
        }
        return { network, volume, containers, images };
      }
      const observed = await resources(); const repeated = await resources();
      check(same(observed, repeated));
      const second = await bindings(); check(same(first, second));
      const raw = { request: frame.request, root: first.data.root, files: first.data.files, sources: first.data.sources,
        config: first.config.projected, existing_names: first.census.conflicts,
        network: observed.network, volume: observed.volume, project_ids: first.census.project_ids,
        volume_users: first.census.volume_users, containers: observed.containers };
      let result;
      if (mode === 'active') {
        const normalized = normalizeR05Evidence({ manifest: m, raw, labelPolicy: p, sequence: next });
        admit(m, normalized, m.phase); result = raw;
      } else {
        result = normalizeR05LifecycleEvidence({ manifest: pm, raw, labelPolicy: p, sequence: next });
        // Pin service observations independently, without copying a private validator.
        for (const c of result.containers) {
          const spec = m.services[c.service];
          check(c.image === spec.image && c.compose_hash === spec.compose_hash && c.user === spec.user
            && c.readonly === spec.readonly && same(c.ports, spec.ports) && same(c.mounts, spec.mounts));
        }
      }
      const detached = freeze(copy(result));
      const completed = { sequence: next, ids: copy(q.identities), census: copy(first.census) };
      sequence = next; if (mode === 'active') request = q.request;
      last = completed;
      return detached;
    } catch { refuse(); } finally { busy = false; }
  }
  return Object.freeze({ collectRawActive: input => collect('active', input), collectLifecycle: input => collect('lifecycle', input) });
}
