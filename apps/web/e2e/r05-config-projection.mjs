// Source-only opt-in codec; does not authenticate observations or grant effects.
import { types } from 'node:util';
import { isAbsolute, normalize } from 'node:path/posix';
import { digest } from './r05-binding.mjs';

const SCHEMA = 'luson.r05.public-config/v1';
const REFUSED = 'R05 public config refused.';
const dangerous = /^(?:__proto__|constructor|prototype)$/i;
const forbidden = /^(?:env|environment|contents|password|credentials|token|secret|dsn)$/i;
const reserved = new Set(['projection_record', 'public_env_bindings',
  'public_secret_refs', 'public_secret_declarations']);
const names = ['database_password', 'database_url', 'tls_cert', 'tls_key'];
const roleRefs = { app: ['database_url', 'tls_cert', 'tls_key'], db: ['database_password'] };
const envKeys = {
  app: ['LUSON_APP_UID', 'LUSON_APP_GID', 'LUSON_PROFILE', 'LUSON_DATABASE_URL_FILE',
    'LUSON_ORIGIN', 'LUSON_LISTEN', 'LUSON_TLS_CERT', 'LUSON_TLS_KEY', 'LUSON_WEB_DIR'],
  db: ['POSTGRES_USER', 'POSTGRES_DB', 'POSTGRES_PASSWORD_FILE'],
};
const serviceKeys = new Set(['build', 'image', 'user', 'read_only', 'cap_drop', 'security_opt',
  'environment', 'ports', 'secrets', 'depends_on', 'networks', 'volumes', 'healthcheck']);
const refuse = () => { throw new Error(REFUSED); };
const check = value => { if (!value) refuse(); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => check(object(value)
  && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0'));
const same = (a, b) => digest(a) === digest(b);

// Inspect descriptors BEFORE reading any caller values. Proxies cannot be safely
// inspected; reject them outright. Limits bound both recursion and total work.
function cloneData(input) {
  const active = new Set();
  let nodes = 0;
  let bytes = 0;
  function copy(value, depth) {
    check(depth <= 32 && ++nodes <= 16384);
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      check(Number.isFinite(value) && !Object.is(value, -0));
      return value;
    }
    if (typeof value === 'string') {
      bytes += Buffer.byteLength(value);
      check(value.length <= 8192 && bytes <= 262144);
      return value;
    }
    check(typeof value === 'object' && !types.isProxy(value) && !active.has(value));
    const array = Array.isArray(value);
    const proto = Object.getPrototypeOf(value);
    check(array ? proto === Array.prototype : proto === Object.prototype || proto === null);
    const keys = Reflect.ownKeys(value);
    check(keys.length <= (array ? 4097 : 4096));
    const descriptors = Object.getOwnPropertyDescriptors(value);
    active.add(value);
    const result = array ? [] : {};
    if (array) {
      const length = descriptors.length;
      check(length && 'value' in length && Number.isInteger(length.value)
        && length.value <= 4096 && keys.length === length.value + 1);
      for (let i = 0; i < length.value; i++) {
        const d = descriptors[String(i)];
        check(d && d.enumerable && 'value' in d);
        result.push(copy(d.value, depth + 1));
      }
    } else {
      for (const key of keys) {
        check(typeof key === 'string' && /^[\x20-\x7e]{1,128}$/.test(key) && !dangerous.test(key));
        const d = descriptors[key];
        check(d.enumerable && 'value' in d);
        bytes += key.length;
        check(bytes <= 262144);
        result[key] = copy(d.value, depth + 1);
      }
    }
    active.delete(value);
    return result;
  }
  return copy(input, 0);
}

function path(value) {
  check(typeof value === 'string' && isAbsolute(value) && normalize(value) === value
    && value !== '/' && !/[\s\x00-\x1f\x7f]/.test(value) && !value.includes('://'));
}
function identity(value) {
  check(typeof value === 'string' && /^[1-9][0-9]*$/.test(value)
    && Number(value) <= 4294967295);
}
function identifier(value) {
  check(typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(value));
}
function environment(value, role) {
  exact(value, envKeys[role]);
  check(Object.values(value).every(v => typeof v === 'string'));
  if (role === 'app') {
    identity(value.LUSON_APP_UID); identity(value.LUSON_APP_GID);
    check(['production', 'local-trial'].includes(value.LUSON_PROFILE));
    let origin;
    try { origin = new URL(value.LUSON_ORIGIN); } catch { refuse(); }
    check(origin.protocol === 'https:' && origin.hostname && !origin.username && !origin.password
      && !origin.search && !origin.hash && origin.origin === value.LUSON_ORIGIN);
    check(value.LUSON_LISTEN === '0.0.0.0:8443' && value.LUSON_WEB_DIR === '/srv/web'
      && value.LUSON_DATABASE_URL_FILE === '/run/secrets/database_url'
      && value.LUSON_TLS_CERT === '/run/secrets/tls_cert'
      && value.LUSON_TLS_KEY === '/run/secrets/tls_key');
  } else {
    identifier(value.POSTGRES_USER); identifier(value.POSTGRES_DB);
    check(value.POSTGRES_PASSWORD_FILE === '/run/secrets/database_password');
  }
}
function declarations(value) {
  exact(value, names);
  for (const name of names) {
    const entry = value[name];
    check(object(entry));
    exact(entry, 'name' in entry ? ['file', 'name'] : ['file']);
    path(entry.file);
    if ('name' in entry) check(typeof entry.name === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(entry.name));
  }
}
function references(value, role) {
  check(Array.isArray(value) && value.length === roleRefs[role].length);
  const seen = new Set();
  for (const entry of value) {
    let source;
    if (typeof entry === 'string') source = entry;
    else {
      exact(entry, 'target' in entry ? ['source', 'target'] : ['source']);
      source = entry.source;
      if ('target' in entry) check(entry.target === source || entry.target === '/run/secrets/' + source);
    }
    check(roleRefs[role].includes(source) && !seen.has(source));
    seen.add(source);
  }
}

// Other admitted SOURCE fields are retained, not converted to a hidden encoding.
// This is deliberately not a generic Docker DSL (commands, arbitrary env/build
// args, credential providers and opaque extensions are outside the contract).
function publicTree(value) {
  if (typeof value === 'string') {
    check(!/[a-z][a-z0-9+.-]*:\/\/[^\s/]*@/i.test(value)
      && !/\b(?:postgres(?:ql)?):\/\//i.test(value)
      && !/\b(?:password|token|credentials|dsn)\s*=/i.test(value)
      && !/-----BEGIN[^\r\n]*PRIVATE KEY-----/.test(value));
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      check(!forbidden.test(key) && !reserved.has(key)
        && !/^(?:args|command|entrypoint|env_file|credential_spec)$/i.test(key)
        && !/(?:^|[_-])(?:password|credentials?|tokens?|dsn|authorization|api[_-]?key)(?:$|[_-])/i.test(key));
      publicTree(child);
    }
  }
}
function allowedKeys(value, keys) {
  check(object(value) && Object.keys(value).every(k => keys.includes(k)));
}
function buildPath(value) {
  check(typeof value === 'string' && value.length > 0 && value.length <= 4096
    && normalize(value) === value && !value.split('/').includes('..')
    && !/[\s\x00-\x1f\x7f:$`\\]/.test(value));
}
function duration(value) {
  check(typeof value === 'string' && /^[1-9][0-9]{0,5}(?:ms|s|m|h)$/.test(value));
  const [, amount, unit] = /^([0-9]+)(ms|s|m|h)$/.exec(value);
  check(Number(amount) * { ms: 1, s: 1000, m: 60000, h: 3600000 }[unit] <= 86400000);
}
function healthcheck(value, env) {
  exact(value, ['test', 'interval', 'timeout', 'retries', 'start_period']);
  // SOURCE uses precisely this CMD-SHELL vector, with public DB identifiers.
  // No variable expansion is used by SOURCE; do not admit arbitrary shell DSL.
  check(Array.isArray(value.test) && value.test.length === 2 && value.test[0] === 'CMD-SHELL'
    && value.test[1] === `pg_isready -U ${env.POSTGRES_USER} -d ${env.POSTGRES_DB}`);
  for (const field of ['interval', 'timeout', 'start_period']) duration(value[field]);
  check(Number.isSafeInteger(value.retries) && value.retries > 0 && value.retries <= 1000);
}
function sourceFields(service, role) {
  if ('build' in service) {
    check(role === 'app');
    exact(service.build, ['context', 'dockerfile']);
    buildPath(service.build.context); buildPath(service.build.dockerfile);
  }
  if ('healthcheck' in service) {
    check(role === 'db');
    healthcheck(service.healthcheck, service.environment);
  }
  if ('depends_on' in service) {
    allowedKeys(service.depends_on, role === 'app' ? ['db'] : []);
    if ('db' in service.depends_on) {
      const dependency = service.depends_on.db;
      allowedKeys(dependency, ['condition', 'required', 'restart']);
      check(dependency.condition === 'service_healthy');
      for (const flag of ['required', 'restart']) {
        if (flag in dependency) check(typeof dependency[flag] === 'boolean');
      }
    }
  }
  if ('networks' in service) {
    check(Array.isArray(service.networks) ? service.networks.every(v => v === 'luson')
      : object(service.networks) && Object.keys(service.networks).every(k => k === 'luson')
        && Object.values(service.networks).every(v => v === null));
  }
  for (const key of ['ports', 'volumes']) {
    if (!(key in service)) continue;
    check(Array.isArray(service[key]));
    for (const entry of service[key]) {
      if (typeof entry === 'string') continue;
      allowedKeys(entry, key === 'ports' ? ['host_ip', 'published', 'target', 'protocol', 'mode']
        : ['type', 'source', 'target', 'read_only', 'volume']);
      if (key === 'volumes' && 'volume' in entry) allowedKeys(entry.volume, ['nocopy']);
    }
  }
}
function sourceResource(value, name) {
  exact(value, [name]);
  if (value[name] !== null) allowedKeys(value[name], ['name']);
}
function validateOriginal(config) {
  check(object(config) && Object.keys(config).every(k => ['name', 'services', 'secrets', 'volumes', 'networks'].includes(k)));
  exact(config.services, ['app', 'db']);
  declarations(config.secrets);
  for (const role of ['app', 'db']) {
    const service = config.services[role];
    check(object(service) && Object.keys(service).every(k => serviceKeys.has(k)));
    environment(service.environment, role);
    references(service.secrets, role);
    sourceFields(service, role);
    for (const [key, value] of Object.entries(service)) {
      if (key !== 'environment' && key !== 'secrets') publicTree(value);
    }
  }
  if ('networks' in config) sourceResource(config.networks, 'luson');
  if ('volumes' in config) sourceResource(config.volumes, 'pgdata');
  for (const [key, value] of Object.entries(config)) {
    if (key !== 'services' && key !== 'secrets') publicTree(value);
  }
}

// Fixed segment paths eliminate ambiguous dotted keys, duplicate mappings,
// third-role adoption and mapping-order ambiguity. Array order is never sorted.
const renamedPaths = [
  { original: ['services', 'app', 'environment'], projected: ['services', 'app', 'public_env_bindings'] },
  { original: ['services', 'app', 'secrets'], projected: ['services', 'app', 'public_secret_refs'] },
  { original: ['services', 'db', 'environment'], projected: ['services', 'db', 'public_env_bindings'] },
  { original: ['services', 'db', 'secrets'], projected: ['services', 'db', 'public_secret_refs'] },
  { original: ['secrets'], projected: ['public_secret_declarations'] },
];
function move(config, from, to) {
  let parent = config;
  for (const part of from.slice(0, -1)) {
    check(object(parent) && Object.hasOwn(parent, part));
    parent = parent[part];
  }
  check(object(parent) && Object.hasOwn(parent, from.at(-1)) && !Object.hasOwn(parent, to.at(-1)));
  parent[to.at(-1)] = parent[from.at(-1)];
  delete parent[from.at(-1)];
}
function projectClone(original) {
  validateOriginal(original);
  const fullDigest = digest(original);
  for (const mapping of renamedPaths) move(original, mapping.original, mapping.projected);
  original.projection_record = {
    schema: SCHEMA, full_config_digest: fullDigest, renamed_paths: cloneData(renamedPaths),
  };
  return original;
}

export function projectR05PublicConfig(original) {
  // All failures are generic, including URL/parser/type failures. Never retain
  // raw invalid inputs in causes, diagnostics, closures or serialized records.
  try { return projectClone(cloneData(original)); } catch { refuse(); }
}

export function restoreR05PublicConfig(projected) {
  try {
    const config = cloneData(projected);
    check(object(config) && Object.hasOwn(config, 'projection_record'));
    const record = config.projection_record;
    exact(record, ['schema', 'full_config_digest', 'renamed_paths']);
    check(record.schema === SCHEMA && typeof record.full_config_digest === 'string'
      && /^[a-f0-9]{64}$/.test(record.full_config_digest) && same(record.renamed_paths, renamedPaths));
    const original = cloneData(config);
    delete original.projection_record;
    for (const mapping of renamedPaths) move(original, mapping.projected, mapping.original);
    // Reconstructed public data is validated AGAIN, before hashing it.
    validateOriginal(original);
    check(digest(original) === record.full_config_digest);
    check(same(projectClone(cloneData(original)), config));
    return original;
  } catch { refuse(); }
}
