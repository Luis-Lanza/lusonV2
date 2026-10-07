// R05a2a: injected evidence only; no resource client or lifecycle authority.
import { isAbsolute, resolve } from 'node:path';
import { digest, admit, refused } from './r05-binding.mjs';
import { R05OwnedCompose } from './r05-owned-compose.mjs';

const check = value => { if (!value) refused(); };
const object = value => check(value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype);
const keys = (value, names) => {
  object(value);
  check(Object.keys(value).sort().join(',') === names.split(' ').sort().join(','));
};
const array = value => check(Array.isArray(value));
const text = value => check(typeof value === 'string');
const boolean = value => check(typeof value === 'boolean');
const id = value => check(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value));
const name = value => check(typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value));
const path = value => check(typeof value === 'string' && isAbsolute(value) && resolve(value) === value);
const integer = value => check(Number.isSafeInteger(value) && value >= 0);
function ids(values) {
  array(values); values.forEach(id); check(new Set(values).size === values.length);
}
function strings(value) {
  object(value); Object.values(value).forEach(text);
}
// Metadata protocol deliberately excludes contents, Env, argv and private diagnostics.
function json(value, depth = 0) {
  check(depth <= 64);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') { check(Number.isFinite(value)); return; }
  if (Array.isArray(value)) { value.forEach(v => json(v, depth+1)); return; }
  object(value);
  for (const [key, child] of Object.entries(value)) {
    check(!/^(?:__proto__|constructor|prototype|env|environment|contents|password|credentials|token|secret|dsn)$/i.test(key));
    json(child, depth+1);
  }
}
function metadata(value, hashed = false) {
  keys(value, 'path uid mode type symlink'+(hashed ? ' sha256' : ''));
  path(value.path); integer(value.uid); integer(value.mode); text(value.type); boolean(value.symlink);
  if (hashed) id(value.sha256);
}
const composeKeys = new Set([
  'com.docker.compose.project', 'com.docker.compose.service', 'com.docker.compose.config-hash',
  'com.docker.compose.container-number', 'com.docker.compose.oneoff', 'com.docker.compose.version',
  'com.docker.compose.project.config_files', 'com.docker.compose.project.working_dir',
  'com.docker.compose.image', 'com.docker.compose.depends_on', 'com.docker.compose.network',
  'com.docker.compose.volume', 'com.docker.compose.replace',
]);
function policy(value) {
  keys(value, 'scopeKey runKey reservedOwnerKeys');
  text(value.scopeKey); text(value.runKey); array(value.reservedOwnerKeys);
  check(value.scopeKey !== value.runKey && value.scopeKey.length > 0 && value.runKey.length > 0);
  value.reservedOwnerKeys.forEach(key => { text(key); check(key.length > 0 && !composeKeys.has(key)); });
  check(new Set(value.reservedOwnerKeys).size === value.reservedOwnerKeys.length
    && value.reservedOwnerKeys.includes(value.scopeKey) && value.reservedOwnerKeys.includes(value.runKey));
}
function labels(raw, m, p) {
  strings(raw);
  for (const key of Object.keys(raw)) {
    check(key === p.scopeKey || key === p.runKey || composeKeys.has(key));
    check(!p.reservedOwnerKeys.includes(key) || key === p.scopeKey || key === p.runKey);
  }
  check(raw[p.scopeKey] === m.labels.scope && raw[p.runKey] === m.labels.run_id
    && raw['com.docker.compose.project'] === m.project);
  return { scope: raw[p.scopeKey], run_id: raw[p.runKey] };
}
function fingerprint(raw) {
  keys(raw, 'Name Driver CreatedAt Options Scope Labels');
  name(raw.Name); text(raw.Driver); text(raw.CreatedAt); text(raw.Scope); strings(raw.Labels);
  check(raw.Driver.length > 0 && raw.CreatedAt.length > 0 && raw.Scope.length > 0);
  if (raw.Options !== null) strings(raw.Options);
  // No Docker native volume ID exists. ALL identity fields/labels participate.
  return digest(raw);
}
export function volumeFingerprint(raw) {
  try { return fingerprint(structuredClone(raw)); } catch { refused(); }
}
function ports(raw) {
  object(raw);
  const result = [];
  for (const [target, bindings] of Object.entries(raw)) {
    check(/^[1-9][0-9]*\/tcp$/.test(target));
    const port = Number(target.slice(0, -4)); check(port <= 65535);
    array(bindings); check(bindings.length > 0);
    for (const binding of bindings) {
      keys(binding, 'HostIp HostPort'); text(binding.HostIp); text(binding.HostPort);
      check(/^[1-9][0-9]*$/.test(binding.HostPort));
      const published = Number(binding.HostPort); check(published <= 65535);
      // Empty/wildcard/IPv6 HostIp remains exactly observed: admission rejects it.
      result.push({ host: binding.HostIp, published, target: port });
    }
  }
  return result;
}
function mounts(raw) {
  array(raw);
  return raw.map(m => {
    check(m?.Type === 'bind' || m?.Type === 'volume');
    keys(m, m.Type === 'bind' ? 'Type Source Destination RW' : 'Type Name Source Destination RW');
    path(m.Source); path(m.Destination); boolean(m.RW);
    if (m.Type === 'volume') name(m.Name);
    return { source: m.Type === 'volume' ? m.Name : m.Source, target: m.Destination,
      kind: m.Type, readonly: !m.RW };
  });
}
function container(raw, m, p) {
  keys(raw, 'Id Name Image Config HostConfig Mounts NetworkSettings State');
  id(raw.Id); text(raw.Name); text(raw.Image);
  check(/^sha256:[a-f0-9]{64}$/.test(raw.Image));
  // Docker prefixes one slash. Never use basename or erase multiple slashes.
  check(raw.Name.startsWith('/')); const normalizedName = raw.Name.slice(1); name(normalizedName);
  keys(raw.Config, 'User Labels'); text(raw.Config.User);
  const owner = labels(raw.Config.Labels, m, p);
  const service = raw.Config.Labels['com.docker.compose.service'];
  check(service === 'app' || service === 'db');
  id(raw.Config.Labels['com.docker.compose.config-hash']);
  keys(raw.HostConfig, 'ReadonlyRootfs PortBindings'); boolean(raw.HostConfig.ReadonlyRootfs);
  keys(raw.NetworkSettings, 'Networks'); object(raw.NetworkSettings.Networks);
  check(Object.keys(raw.NetworkSettings.Networks).length === 1
    && Object.keys(raw.NetworkSettings.Networks)[0] === m.network.name);
  const attachment = raw.NetworkSettings.Networks[m.network.name]; keys(attachment, 'NetworkID');
  id(attachment.NetworkID); check(attachment.NetworkID === m.network.id);
  keys(raw.State, 'Status Running');
  check(raw.State.Status === 'running' && raw.State.Running === true);
  return { id: raw.Id, name: normalizedName, image: raw.Image.slice(7),
    compose_hash: raw.Config.Labels['com.docker.compose.config-hash'], user: raw.Config.User,
    readonly: raw.HostConfig.ReadonlyRootfs, ports: ports(raw.HostConfig.PortBindings),
    mounts: mounts(raw.Mounts), service, project: raw.Config.Labels['com.docker.compose.project'],
    labels: owner, network_id: attachment.NetworkID };
}
function normalize({ manifest: m, raw: r, labelPolicy: p, sequence }) {
  policy(p); integer(sequence); check(sequence > 0);
  keys(r, 'request root files sources config existing_names network volume project_ids volume_users containers');
  integer(r.request); check(r.request > 0);
  metadata(r.root); array(r.files); array(r.sources);
  r.files.forEach(f => metadata(f, 'sha256' in f)); r.sources.forEach(f => metadata(f, true));
  check(new Set(r.files.map(f => f.path)).size === r.files.length
    && new Set(r.sources.map(f => f.path)).size === r.sources.length);
  json(r.config); array(r.existing_names); r.existing_names.forEach(name);
  check(new Set(r.existing_names).size === r.existing_names.length);
  ids(r.project_ids); ids(r.volume_users); array(r.containers);
  check(m.phase === 'prepare' || m.phase === 'active');
  let network = null; let volume = null; let containers = [];
  if (m.phase === 'prepare') {
    check(r.network === null && r.volume === null && r.containers.length === 0
      && r.project_ids.length === 0 && r.volume_users.length === 0);
  } else {
    keys(r.network, 'Id Name Labels Internal Driver Containers');
    id(r.network.Id); name(r.network.Name); boolean(r.network.Internal); text(r.network.Driver);
    object(r.network.Containers);
    const members = Object.keys(r.network.Containers); ids(members);
    for (const member of Object.values(r.network.Containers)) { keys(member, 'Name'); name(member.Name); }
    network = { id: r.network.Id, name: r.network.Name, labels: labels(r.network.Labels, m, p),
      internal: r.network.Internal, driver: r.network.Driver, members };
    const volumeId = fingerprint(r.volume);
    volume = { id: volumeId, name: r.volume.Name, labels: labels(r.volume.Labels, m, p), users: r.volume_users };
    check(r.containers.length === 2);
    containers = r.containers.map(c => container(c, m, p)); ids(containers.map(c => c.id));
  }
  return { sequence, root: r.root, files: r.files, sources: r.sources, config: r.config,
    existing_names: r.existing_names, network, volume, project_ids: r.project_ids, containers };
}
// Normalization preserves observations, including Config.User === ''. Admission is separate.
export function normalizeR05Evidence(input) {
  try { return normalize(structuredClone(input)); } catch { refused(); }
}
export function createR05Driver({ manifest, labelPolicy, collectRaw, dispatchRaw } = {}) {
  try {
    check(typeof collectRaw === 'function' && typeof dispatchRaw === 'function');
    const m = structuredClone(manifest); const p = structuredClone(labelPolicy); policy(p);
    let sequence = 0; let request = 0; let busy = false;
    const inspect = async () => {
      check(Number.isSafeInteger(request+1) && Number.isSafeInteger(sequence+1));
      const context = Object.freeze({ operation: 'inspect', phase: m.phase, request: ++request });
      const raw = await collectRaw(context);
      check(raw?.request === context.request);
      const snapshot = normalizeR05Evidence({ manifest: m, raw, labelPolicy: p, sequence: sequence+1 });
      admit(m, snapshot, m.phase);
      sequence++; // Only after complete collection, normalization AND admission.
      return snapshot;
    };
    const dispatch = async operation => {
      keys(operation, 'operation id stdin');
      check(operation.operation === 'sql' && operation.id === m.services.db.id);
      // This callback is reachable only from the immediately preceding full active guard.
      // No arbitrary operation API or cleanup-exact translation exists.
      await dispatchRaw(structuredClone(operation));
      // Never expose untrusted transport responses or diagnostics to callers.
    };
    const owned = new R05OwnedCompose({ manifest: m, inspect, dispatch });
    const serialized = async action => {
      check(!busy); busy = true;
      try { return await action(); } catch { refused(); } finally { busy = false; }
    };
    return Object.freeze({
      inspect: () => serialized(inspect),
      createPlan: () => serialized(() => owned.createPlan()),
      sql: query => serialized(() => owned.sql(query)),
      // Full active admission cannot authorize partial/removed/stopped cleanup topologies.
      cleanupPlan: async () => refused(),
      cleanup: async () => refused(),
    });
  } catch { refused(); }
}
