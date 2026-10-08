import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from './r05-binding.mjs';
import { projectR05PublicConfig, restoreR05PublicConfig } from './r05-config-projection.mjs';

// Synthetic public SOURCE-shaped data, never an observed Docker config.
function fixture() {
  return {
    services: {
      app: {
        build: { context: '.', dockerfile: 'Dockerfile' },
        image: 'luson-local:latest', user: '1000:1000', read_only: true,
        cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'],
        environment: {
          LUSON_APP_UID: '1000', LUSON_APP_GID: '1000', LUSON_PROFILE: 'local-trial',
          LUSON_DATABASE_URL_FILE: '/run/secrets/database_url',
          LUSON_ORIGIN: 'https://localhost:8443', LUSON_LISTEN: '0.0.0.0:8443',
          LUSON_TLS_CERT: '/run/secrets/tls_cert', LUSON_TLS_KEY: '/run/secrets/tls_key',
          LUSON_WEB_DIR: '/srv/web',
        },
        ports: [{ host_ip: '127.0.0.1', published: '8443', target: 8443, protocol: 'tcp' }],
        secrets: ['database_url', 'tls_cert', 'tls_key'],
        depends_on: { db: { condition: 'service_healthy', required: true } },
        networks: { luson: null },
      },
      db: {
        image: 'postgres:17.9-bookworm',
        environment: {
          POSTGRES_USER: 'luson', POSTGRES_DB: 'luson',
          POSTGRES_PASSWORD_FILE: '/run/secrets/database_password',
        },
        secrets: [{ source: 'database_password', target: 'database_password' }],
        volumes: [{ type: 'volume', source: 'pgdata', target: '/var/lib/postgresql/data' }],
        healthcheck: {
          test: ['CMD-SHELL', 'pg_isready -U luson -d luson'], interval: '2s',
          timeout: '3s', retries: 30, start_period: '5s',
        },
        networks: { luson: null },
      },
    },
    secrets: Object.fromEntries(['database_password', 'database_url', 'tls_cert', 'tls_key']
      .map(name => [name, { file: `/private-fixture/${name}` }])),
    volumes: { pgdata: null }, networks: { luson: null },
  };
}
const refused = fn => assert.throws(fn, error => error instanceof Error
  && error.message === 'R05 public config refused.' && error.cause === undefined);
const rejectOriginal = mutate => {
  const value = fixture();
  mutate(value);
  refused(() => projectR05PublicConfig(value));
};
const rejectProjected = mutate => {
  const value = projectR05PublicConfig(fixture());
  mutate(value);
  refused(() => restoreR05PublicConfig(value));
};
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function reorder(value) {
  if (Array.isArray(value)) return value.map(reorder);
  return value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reorder(v)])) : value;
}

test('R05a2c1 complete public source config reverses with distinct projected digest', () => {
  const original = fixture();
  let projected;
  assert.doesNotThrow(() => { projected = projectR05PublicConfig(original); });
  assert.deepEqual(restoreR05PublicConfig(projected), original);
  assert.equal(projected.projection_record.schema, 'luson.r05.public-config/v1');
  assert.equal(projected.projection_record.full_config_digest, digest(original));
  assert.notEqual(digest(projected), digest(original));
  assert.equal(projected.services.app.environment, undefined);
  assert.deepEqual(projected.services.app.public_env_bindings, original.services.app.environment);
  assert.deepEqual(projected.services.app.depends_on, original.services.app.depends_on);
  assert.deepEqual(projected.projection_record.renamed_paths, [
    { original: ['services', 'app', 'environment'], projected: ['services', 'app', 'public_env_bindings'] },
    { original: ['services', 'app', 'secrets'], projected: ['services', 'app', 'public_secret_refs'] },
    { original: ['services', 'db', 'environment'], projected: ['services', 'db', 'public_env_bindings'] },
    { original: ['services', 'db', 'secrets'], projected: ['services', 'db', 'public_secret_refs'] },
    { original: ['secrets'], projected: ['public_secret_declarations'] },
  ]);
});

test('R05a2c1 canonical object order is irrelevant and all array orders remain exact', () => {
  const original = fixture();
  original.services.app.secrets.reverse();
  original.services.app.cap_drop = ['ALL', 'NET_RAW'];
  const projected = projectR05PublicConfig(original);
  assert.deepEqual(restoreR05PublicConfig(reorder(projected)), original);
  assert.equal(digest(projectR05PublicConfig(reorder(original))), digest(projected));
  assert.deepEqual(projected.services.app.cap_drop, ['ALL', 'NET_RAW']);
  assert.deepEqual(projected.services.db.healthcheck.test, original.services.db.healthcheck.test);
  rejectProjected(v => v.services.app.public_secret_refs.reverse());
});

test('R05a2c1 inputs remain immutable and outputs retain no caller references', () => {
  const original = freeze(fixture());
  const before = digest(original);
  const projected = projectR05PublicConfig(original);
  const restored = restoreR05PublicConfig(freeze(projected));
  restored.services.app.environment.LUSON_PROFILE = 'production';
  restored.services.app.cap_drop.push('NET_RAW');
  assert.equal(digest(original), before);
  assert.equal(projected.services.app.public_env_bindings.LUSON_PROFILE, 'local-trial');
  assert.deepEqual(projected.services.app.cap_drop, ['ALL']);
  const second = projectR05PublicConfig(original);
  second.projection_record.renamed_paths[0].original[0] = 'changed';
  assert.equal(projectR05PublicConfig(original).projection_record.renamed_paths[0].original[0], 'services');
});

test('R05a2c1 canonical file reference objects and public metadata are preserved', () => {
  const original = fixture();
  original.name = 'luson-local';
  for (const name of Object.keys(original.secrets)) original.secrets[name].name = `luson-local_${name}`;
  original.services.app.secrets = original.services.app.secrets.map(source => ({ source, target: `/run/secrets/${source}` }));
  const projected = projectR05PublicConfig(original);
  assert.deepEqual(projected.public_secret_declarations, original.secrets);
  assert.deepEqual(restoreR05PublicConfig(projected), original);
});

// Strict fixtures mirror BOTH frozen whole-key protocols, not engine authority.
// Driver has three additional dangerous keys; neither guard bans plural secrets.
const driverKeys = /^(?:__proto__|constructor|prototype|env|environment|contents|password|credentials|token|secret|dsn)$/i;
const lifecycleKeys = /^(?:env|environment|contents|password|credentials|token|secret|dsn)$/i;
function protocolAccepts(value, guard) {
  return !value || typeof value !== 'object' || Object.entries(value)
    .every(([key, child]) => !guard.test(key) && protocolAccepts(child, guard));
}
test('R05a2c1 projected aliases satisfy both exact-key metadata protocol fixtures', () => {
  const projected = projectR05PublicConfig(fixture());
  for (const guard of [driverKeys, lifecycleKeys]) {
    assert.equal(protocolAccepts(projected, guard), true);
    assert.equal(protocolAccepts(fixture(), guard), false);
    assert.equal(protocolAccepts({ secrets: [], public_secret_refs: [], public_secret_declarations: {} }, guard), true);
    assert.equal(protocolAccepts({ environment: {} }, guard), false);
  }
});

for (const [name, mutate] of [
  ['environment value', v => { v.services.app.public_env_bindings.LUSON_PROFILE = 'production'; }],
  ['source field', v => { v.services.db.image = 'postgres:other'; }],
  ['full digest', v => { v.projection_record.full_config_digest = '0'.repeat(64); }],
  ['missing record', v => { delete v.projection_record; }],
  ['unknown version', v => { v.projection_record.schema = 'luson.r05.public-config/v2'; }],
  ['extra record field', v => { v.projection_record.extra = true; }],
  ['missing path', v => { v.projection_record.renamed_paths.pop(); }],
  ['duplicate path', v => { v.projection_record.renamed_paths[1] = v.projection_record.renamed_paths[0]; }],
  ['path order', v => { v.projection_record.renamed_paths.reverse(); }],
  ['dotted path', v => { v.projection_record.renamed_paths[0].original = ['services.app.environment']; }],
  ['extra path property', v => { v.projection_record.renamed_paths[0].extra = true; }],
  ['missing alias', v => { delete v.services.app.public_env_bindings; }],
  ['restoration collision', v => { v.services.app.environment = {}; }],
  ['undescribed alias', v => { v.services.db.public_secret_declarations = {}; }],
]) test(`R05a2c1 restore refuses tampered ${name}`, () => rejectProjected(mutate));

for (const [name, mutate] of [
  ['already projected', v => { v.projection_record = {}; }],
  ['env alias collision', v => { v.services.app.public_env_bindings = {}; }],
  ['ref alias collision', v => { v.services.db.public_secret_refs = []; }],
  ['declaration alias collision', v => { v.public_secret_declarations = {}; }],
  ['third service', v => { v.services.extra = {}; }],
  ['unknown env', v => { v.services.app.environment.EXTRA = 'opaque'; }],
  ['inline database URL', v => { v.services.app.environment.LUSON_DATABASE_URL = 'postgresql://fixture.invalid/db'; }],
  ['inline password key', v => { v.services.db.environment.POSTGRES_PASSWORD = 'synthetic-invalid'; }],
  ['credential origin', v => { v.services.app.environment.LUSON_ORIGIN = 'https://synthetic:invalid@localhost:8443'; }],
  ['origin query', v => { v.services.app.environment.LUSON_ORIGIN += '?token=synthetic-invalid'; }],
  ['http origin', v => { v.services.app.environment.LUSON_ORIGIN = 'http://localhost:8443'; }],
  ['zero uid', v => { v.services.app.environment.LUSON_APP_UID = '0'; }],
  ['overflow gid', v => { v.services.app.environment.LUSON_APP_GID = '4294967296'; }],
  ['nonstring env', v => { v.services.app.environment.LUSON_APP_UID = 1000; }],
  ['wrong profile', v => { v.services.app.environment.LUSON_PROFILE = 'development'; }],
  ['public db identifier', v => { v.services.db.environment.POSTGRES_DB = 'invalid identifier'; }],
  ['wrong secret target', v => { v.services.db.environment.POSTGRES_PASSWORD_FILE = '/other'; }],
  ['env array', v => { v.services.app.environment = ['LUSON_PROFILE=local-trial']; }],
  ['declaration contents', v => { v.secrets.database_url.contents = 'synthetic-invalid'; }],
  ['external provider', v => { v.secrets.database_url = { external: true }; }],
  ['relative file', v => { v.secrets.database_url.file = 'relative'; }],
  ['noncanonical file', v => { v.secrets.database_url.file = '/fixture/../other'; }],
  ['URI file', v => { v.secrets.database_url.file = 'postgresql://fixture.invalid/db'; }],
  ['duplicate refs', v => { v.services.app.secrets[1] = 'database_url'; }],
  ['missing ref', v => { v.services.app.secrets.pop(); }],
  ['unknown declaration', v => { v.secrets.extra = { file: '/fixture/extra' }; }],
  ['conflicting target', v => { v.services.db.secrets[0].target = 'other'; }],
  ['ref type provider', v => { v.services.db.secrets[0].type = 'opaque'; }],
  ['nested forbidden key', v => { v.services.app.build.environment = {}; }],
  ['unknown carrier field', v => { v.services.app.build.access_token = 'synthetic-invalid'; }],
  ['opaque build args', v => { v.services.app.build.args = { VALUE: 'synthetic-invalid' }; }],
  ['credential URL field', v => { v.services.app.build.context = 'https://synthetic:invalid@fixture.invalid'; }],
  ['inline DSN field', v => { v.services.app.image = 'postgresql://fixture.invalid/db'; }],
  ['command carrier', v => { v.services.app.command = ['opaque']; }],
  ['unknown nested build field', v => { v.services.app.build.opaque = 'synthetic-invalid'; }],
  ['unknown public resource', v => { v.networks.foreign = null; }],
]) test(`R05a2c1 projection refuses unsupported ${name}`, () => rejectOriginal(mutate));

for (const [name, make] of [
  ['custom prototype', () => Object.create({ inherited: true })],
  ['date', () => new Date(0)], ['map', () => new Map()],
  ['proxy', () => new Proxy({}, { ownKeys() { throw new Error('must not run'); } })],
  ['NaN', () => NaN], ['infinity', () => Infinity], ['negative zero', () => -0],
  ['undefined', () => undefined], ['bigint', () => 1n], ['function', () => () => {}],
  ['symbol value', () => Symbol('synthetic')],
  ['symbol property', () => ({ [Symbol('synthetic')]: true })],
  ['hidden property', () => Object.defineProperty({}, 'hidden', { value: true })],
  ['sparse array', () => new Array(2)],
  ['array extra', () => Object.assign([], { extra: true })],
  ['dangerous key', () => JSON.parse('{"__proto__":{}}')],
  ['constructor key', () => ({ constructor: true })],
  ['prototype key', () => ({ prototype: true })],
  ['cycle', () => { const v = {}; v.self = v; return v; }],
  ['depth', () => { let v = {}; for (let i = 0; i < 34; i++) v = { nested: v }; return v; }],
  ['oversize string', () => 'x'.repeat(8193)],
  ['oversize array', () => Array(4097).fill(null)],
  ['total byte bound', () => Array(40).fill('x'.repeat(8192))],
  ['total node bound', () => Array.from({ length: 5 }, () => Array(4096).fill(null))],
]) test(`R05a2c1 rejects nonplain or unbounded ${name} before digest`, () => {
  const value = fixture();
  value.services.app.build.context = make();
  refused(() => projectR05PublicConfig(value));
  refused(() => restoreR05PublicConfig(value));
});

// Both entry points must refuse even when the caller recomputes the full SHA.
const carriers = [
  ['healthcheck assignment', v => { v.services.db.healthcheck.test[1] = 'PGPASSWORD=synthetic-invalid pg_isready -U luson -d luson'; }],
  ['object build context', v => { v.services.app.build.context = { secrets: ['synthetic-invalid'] }; }],
  ['shell chain', v => { v.services.db.healthcheck.test[1] += ' && true'; }],
  ['shell newline', v => { v.services.db.healthcheck.test[1] += '\ntrue'; }],
  ['unknown program', v => { v.services.db.healthcheck.test[1] = 'true'; }],
  ['extra argument', v => { v.services.db.healthcheck.test[1] += ' -h localhost'; }],
  ['private variable', v => { v.services.db.healthcheck.test[1] = 'pg_isready -U $PGPASSWORD -d luson'; }],
  ['unsupported public variable', v => { v.services.db.healthcheck.test[1] = 'pg_isready -U $POSTGRES_USER -d luson'; }],
  ['argv form', v => { v.services.db.healthcheck.test = ['CMD', 'pg_isready', '-U', 'luson', '-d', 'luson']; }],
  ['object duration', v => { v.services.db.healthcheck.interval = { secrets: ['synthetic-invalid'] }; }],
  ['array duration', v => { v.services.db.healthcheck.timeout = ['2s']; }],
  ['invalid duration', v => { v.services.db.healthcheck.start_period = '0s'; }],
  ['unbounded duration', v => { v.services.db.healthcheck.interval = '999999h'; }],
  ['object retries', v => { v.services.db.healthcheck.retries = { secrets: ['synthetic-invalid'] }; }],
  ['fractional retries', v => { v.services.db.healthcheck.retries = 1.5; }],
  ['unbounded retries', v => { v.services.db.healthcheck.retries = 1001; }],
  ['app healthcheck', v => { v.services.app.healthcheck = v.services.db.healthcheck; }],
  ['db build', v => { v.services.db.build = v.services.app.build; }],
  ['array dockerfile', v => { v.services.app.build.dockerfile = ['Dockerfile']; }],
  ['null build context', v => { v.services.app.build.context = null; }],
  ['object dependency condition', v => { v.services.app.depends_on.db.condition = { secrets: ['synthetic-invalid'] }; }],
  ['unknown dependency condition', v => { v.services.app.depends_on.db.condition = 'opaque'; }],
  ['object required', v => { v.services.app.depends_on.db.required = { secrets: ['synthetic-invalid'] }; }],
  ['string restart', v => { v.services.app.depends_on.db.restart = 'false'; }],
];
for (const [name, mutate] of carriers) {
  for (const operation of ['project', 'restore']) {
    test(`R05a2c1 ${operation} refuses ${name} even with recomputed digest`, () => {
      const original = fixture();
      const projected = projectR05PublicConfig(original);
      mutate(original);
      if (operation === 'project') refused(() => projectR05PublicConfig(original));
      else {
        mutate(projected);
        projected.projection_record.full_config_digest = digest(original);
        refused(() => restoreR05PublicConfig(projected));
      }
    });
  }
}

test('R05a2c1 typed source fields retain alternate public identifiers and exact metadata', () => {
  const original = fixture();
  original.services.app.build.context = '/public-fixture/source';
  original.services.db.environment.POSTGRES_USER = 'public_user';
  original.services.db.environment.POSTGRES_DB = 'public_db';
  original.services.db.healthcheck.test[1] = 'pg_isready -U public_user -d public_db';
  original.services.db.healthcheck.interval = '2000ms';
  original.services.app.depends_on.db.restart = false;
  assert.deepEqual(restoreR05PublicConfig(projectR05PublicConfig(original)), original);
});

test('R05a2c1 4096 array elements are admitted without counting length as an entry', () => {
  const original = fixture();
  original.services.app.cap_drop = Array(4096).fill('ALL');
  let projected;
  assert.doesNotThrow(() => { projected = projectR05PublicConfig(original); });
  assert.deepEqual(restoreR05PublicConfig(projected), original);
});

test('R05a2c1 accessors and toJSON are refused without invocation', () => {
  let calls = 0;
  const value = fixture();
  Object.defineProperty(value.services.app, 'environment', { enumerable: true, get() { calls++; return {}; } });
  refused(() => projectR05PublicConfig(value));
  refused(() => restoreR05PublicConfig(value));
  const other = fixture();
  other.toJSON = () => { calls++; return {}; };
  refused(() => projectR05PublicConfig(other));
  const array = [];
  Object.defineProperty(array, '0', { enumerable: true, get() { calls++; return null; } });
  other.toJSON = array;
  refused(() => restoreR05PublicConfig(other));
  assert.equal(calls, 0);
});

test('R05a2c1 rewritten digest cannot authorize invalid reconstructed environment', () => {
  const original = fixture();
  const projected = projectR05PublicConfig(original);
  original.services.app.environment.LUSON_ORIGIN = 'https://synthetic:invalid@localhost:8443';
  projected.services.app.public_env_bindings.LUSON_ORIGIN = original.services.app.environment.LUSON_ORIGIN;
  projected.projection_record.full_config_digest = digest(original);
  refused(() => restoreR05PublicConfig(projected));
});

test('R05a2c1 null-prototype plain data is cloned and reprojection is refused', () => {
  const original = fixture();
  original.services.app.environment = Object.assign(Object.create(null), original.services.app.environment);
  const projected = projectR05PublicConfig(original);
  assert.equal(Object.getPrototypeOf(projected.services.app.public_env_bindings), Object.prototype);
  assert.equal(digest(restoreR05PublicConfig(projected)), digest(original));
  refused(() => projectR05PublicConfig(projected));
});
