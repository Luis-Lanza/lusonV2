// Pure normalized evidence admission. The parent owns evidence provenance.
import { createHash } from 'node:crypto';
import { isAbsolute, resolve, dirname } from 'node:path';
export const refused = () => { throw new Error('R05 admission refused.'); };
const check = value => { if (!value) refused(); };
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const keys = (value, names) => check(value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === names.split(' ').sort().join(','));
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const equal = (a, b) => digest(a) === digest(b);
const sameSet = (a, b) => Array.isArray(a) && a.length === b.length && new Set(a).size === a.length
  && a.every(value => b.includes(value));
function metadata(file, root, uid, hashed = false) {
  keys(file, 'path uid mode type symlink'+(hashed ? ' sha256' : ''));
  check(typeof file.path === 'string' && isAbsolute(file.path) && resolve(file.path) === file.path
    && dirname(file.path) === root && file.uid === uid && file.mode === 0o600
    && file.type === 'file' && file.symlink === false && (!hashed || hex(file.sha256)));
}
function validate(manifest, snapshot, phase) {
  keys(manifest, 'schema phase run_id project uid root manifest dsn labels sources config_digest network volume services');
  const m = manifest;
  check(m.schema === 'luson.r05/v1' && m.phase === phase && ['prepare','active'].includes(phase)
    && /^[a-f0-9]{16,32}$/.test(m.run_id) && m.project === 'luson-r05-'+m.run_id
    && Number.isSafeInteger(m.uid) && m.uid > 0 && isAbsolute(m.root) && resolve(m.root) === m.root && m.root !== '/');
  keys(m.labels, 'scope run_id');
  check(m.labels.scope === 'transfer-requests/R05' && m.labels.run_id === m.run_id);
  metadata(m.manifest, m.root, m.uid); metadata(m.dsn, m.root, m.uid);
  check(Array.isArray(m.sources) && m.sources.length > 0 && m.sources.length <= 32 && hex(m.config_digest));
  m.sources.forEach(f => metadata(f, m.root, m.uid, true));
  const files = [m.manifest, m.dsn, ...m.sources];
  check(new Set(files.map(f => f.path)).size === files.length);
  keys(m.network, 'name id'); keys(m.volume, 'name id'); keys(m.services, 'app db');
  check(m.network.name === m.project+'-net' && m.volume.name === m.project+'-data');
  const ids = [m.network.id, m.volume.id, m.services.app.id, m.services.db.id];
  check(phase === 'active' ? ids.every(hex) && new Set(ids).size === 4 : ids.every(id => id === null));
  for (const [service, spec] of Object.entries(m.services)) {
    keys(spec, 'id image compose_hash user readonly ports mounts');
    check(hex(spec.image) && hex(spec.compose_hash) && Array.isArray(spec.ports) && Array.isArray(spec.mounts));
    check(service === 'app' ? spec.user === m.uid+':'+m.uid && spec.readonly === true
      : /^[1-9][0-9]*:[1-9][0-9]*$/.test(spec.user) && spec.readonly === false);
    if (service === 'app') {
      check(spec.ports.length === 1); keys(spec.ports[0], 'host published target');
      check(spec.ports[0].host === '127.0.0.1' && spec.ports[0].target === 8443
        && Number.isInteger(spec.ports[0].published) && spec.ports[0].published > 1023 && spec.ports[0].published <= 65535);
    } else check(spec.ports.length === 0);
    check(spec.mounts.length > 0 && new Set(spec.mounts.map(v => v.target)).size === spec.mounts.length);
    for (const mount of spec.mounts) {
      keys(mount, 'source target kind readonly');
      check(typeof mount.target === 'string' && isAbsolute(mount.target) && resolve(mount.target) === mount.target);
      if (mount.kind === 'bind') check(files.some(f => f.path === mount.source) && mount.readonly === true);
      else check(service === 'db' && mount.kind === 'volume' && mount.source === m.volume.name
        && mount.target === '/var/lib/postgresql/data' && mount.readonly === false);
      if (service === 'app') check(mount.kind === 'bind' && mount.readonly === true);
    }
    if (service === 'db') check(spec.mounts.filter(v => v.kind === 'volume').length === 1);
  }
  keys(snapshot, 'sequence root files sources config existing_names network volume project_ids containers');
  const s = snapshot;
  keys(s.root, 'path uid mode type symlink');
  check(equal(s.root, { path: m.root, uid: m.uid, mode: 0o700, type: 'directory', symlink: false })
    && Number.isSafeInteger(s.sequence) && s.sequence > 0 && Array.isArray(s.files) && s.files.length === files.length);
  for (const file of files) {
    const observed = s.files.find(v => v.path === file.path);
    metadata(observed, m.root, m.uid, 'sha256' in file); check(equal(file, observed));
  }
  check(equal(s.sources, m.sources) && digest(s.config) === m.config_digest && Array.isArray(s.existing_names));
  keys(s.config.services, 'app db');
  const app = s.config.services.app; const db = s.config.services.db;
  check(app && db && typeof app === 'object' && typeof db === 'object');
  keys(app.depends_on, 'db');
  check(app.depends_on.db?.condition === 'service_healthy' && Object.keys(db.depends_on ?? {}).length === 0);
  for (const service of [app, db]) check(!['privileged','links','volumes_from','network_mode','ipc','pid'].some(key => key in service));
  if (phase === 'prepare') {
    check(s.existing_names.length === 0 && s.network === null && s.volume === null
      && sameSet(s.project_ids, []) && Array.isArray(s.containers) && s.containers.length === 0);
    return;
  }
  const containerIDs = [m.services.app.id, m.services.db.id];
  keys(s.network, 'name id labels internal driver members'); keys(s.volume, 'name id labels users');
  check(s.network.id === m.network.id && s.network.name === m.network.name && equal(s.network.labels, m.labels)
    && s.network.internal === true && s.network.driver === 'bridge' && sameSet(s.network.members, containerIDs)
    && s.volume.id === m.volume.id && s.volume.name === m.volume.name && equal(s.volume.labels, m.labels)
    && sameSet(s.volume.users, [m.services.db.id]) && sameSet(s.project_ids, containerIDs) && s.existing_names.length === 0);
  check(Array.isArray(s.containers) && s.containers.length === 2 && sameSet(s.containers.map(c => c.id), containerIDs));
  for (const [service, spec] of Object.entries(m.services)) {
    const c = s.containers.find(v => v.id === spec.id);
    keys(c, 'id image compose_hash user readonly ports mounts service name project labels network_id');
    check(equal(c, { ...spec, service, name: m.project+'-'+service+'-1', project: m.project,
      labels: m.labels, network_id: m.network.id }));
  }
}
export function admit(manifest, snapshot, phase) {
  try { validate(manifest, snapshot, phase); return true; } catch { refused(); }
}
