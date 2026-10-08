// Pure R05a2b2 protocol. No collector, transport, SQL or effect authority.
import { admit, digest, refused } from './r05-binding.mjs';
import { volumeFingerprint } from './r05-driver.mjs';

const check = value => { if (!value) refused(); };
const same = (a, b) => digest(a) === digest(b);
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const keys = (value, names) => check(value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(' ') === names.split(' ').sort().join(' '));
// Copy only bounded, plain, own DATA properties; never invoke input getters.
function copy(value, depth = 0) {
  check(depth <= 32);
  if (typeof value === 'string') { check(value.length <= 4096); return value; }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') { check(Number.isSafeInteger(value)); return value; }
  check(value && typeof value === 'object');
  const array = Array.isArray(value);
  check(Object.getPrototypeOf(value) === (array ? Array.prototype : Object.prototype));
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Reflect.ownKeys(descriptors);
  check(names.length <= 256 && names.every(name => typeof name === 'string'));
  if (array) check(names.length === value.length+1 && value.length <= 128);
  const result = array ? [] : {};
  for (const name of names) {
    if (array && name === 'length') continue;
    const d = descriptors[name];
    check(d.enumerable && 'value' in d && !['__proto__','constructor','prototype'].includes(name));
    if (array) check(/^(0|[1-9][0-9]*)$/.test(name) && Number(name) < value.length);
    result[name] = copy(d.value, depth+1);
  }
  return result;
}
function ownData(value, name) {
  check(value && Object.getPrototypeOf(value) === Object.prototype);
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  check(descriptor && descriptor.enumerable && 'value' in descriptor);
  return descriptor.value;
}
function publicConfig(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    check(!/^(env|environment|contents|password|credentials|token|secret|dsn)$/i.test(key));
    publicConfig(child);
  }
}
function set(actual, expected) {
  check(Array.isArray(actual) && actual.length === expected.length
    && new Set(actual).size === actual.length && actual.every(v => expected.includes(v)));
}
const snapshotKeys = 'sequence root files sources config existing_names network volume project_ids volume_users containers';
const createOps = new Set(['createNetwork','createVolume','createDB','createAPP']);
const normal = {
  EMPTY: 'createNetwork', NETWORK: 'createVolume', VOLUME: 'createDB',
  DB_CREATED: 'startDB', DB_RUNNING: 'createAPP', APP_CREATED: 'startAPP',
  SETTLED: 'stopAPP', APP_STOPPED: 'stopDB', DB_STOPPED: 'removeAPP',
  APP_REMOVED: 'removeDB', DB_REMOVED: 'removeVolume', VOLUME_ABSENT: 'removeNetwork',
};
const next = {
  createNetwork: 'NETWORK', createVolume: 'VOLUME', createDB: 'DB_CREATED',
  startDB: 'DB_RUNNING', createAPP: 'APP_CREATED', startAPP: 'FULL_ACTIVE',
  stopAPP: 'APP_STOPPED', stopDB: 'DB_STOPPED', removeAPP: 'APP_REMOVED',
  removeDB: 'DB_REMOVED', removeVolume: 'VOLUME_ABSENT', removeNetwork: 'NETWORK_ABSENT',
};

export function createR05Lifecycle(input) {
  try { return ledger(copy(input)); } catch { refused(); }
}
function ledger(input) {
  keys(input, 'manifest snapshot');
  const m = input.manifest;
  const provenance = { root: m.root, sources: m.sources.map(f => f.path), config_digest: m.config_digest };
  const volumeLabels = { ...m.labels, project: m.project };
  let sequence = 0;
  let phase = 'EMPTY';
  let settled = null;
  let pending = null;
  let serial = 0;
  // Removed identities remain in history. Presence is tracked independently.
  let owned = { network: null, volume: null, db: null, app: null };
  let topology = { network: false, volume: false, db: null, app: null };
  function guard(s, identities = owned, state = topology) {
    keys(s, snapshotKeys);
    check(Number.isSafeInteger(s.sequence) && s.sequence > sequence);
    publicConfig(s.config);
    // Reuse complete declaration/root/source/file/config admission, NOT active admission.
    // Empty topology here is only the metadata validator projection. Below independently
    // requires the observed exact phase topology; no running-only collector is reused.
    admit(m, { sequence: s.sequence, root: s.root, files: s.files, sources: s.sources,
      config: s.config, existing_names: [], network: null, volume: null,
      project_ids: [], containers: [] }, 'prepare');
    set(s.existing_names, []);
    const roles = ['db','app'].filter(role => state[role] !== null);
    const ids = roles.map(role => identities[role]);
    check(ids.every(hex) && new Set(ids).size === ids.length);
    set(s.project_ids, ids);
    set(s.volume_users, state.db === null ? [] : [identities.db]);
    check(Array.isArray(s.containers) && s.containers.length === roles.length);
    set(s.containers.map(c => c.id), ids);
    for (const role of roles) {
      const c = s.containers.find(v => v.id === identities[role]);
      const expected = { ...m.services[role], id: identities[role], service: role,
        name: m.project+'-'+role+'-1', project: m.project, labels: m.labels,
        network_id: identities.network, network_mode: m.network.name,
        state: state[role], provenance };
      check(same(c, expected));
    }
    if (!state.network) check(s.network === null);
    else {
      check(hex(identities.network));
      const members = roles.filter(role => state[role] === 'running').map(role => identities[role]);
      keys(s.network, 'id name labels internal driver members provenance');
      set(s.network.members, members);
      check(same({ ...s.network, members: [] }, { id: identities.network, name: m.network.name,
        labels: m.labels, internal: true, driver: 'bridge', members: [], provenance }));
    }
    if (!state.volume) check(s.volume === null);
    else {
      keys(s.volume, 'metadata users provenance');
      set(s.volume.users, state.db === null ? [] : [identities.db]);
      check(same(s.volume.provenance, provenance)
        && same(s.volume.metadata, identities.volume)
        && s.volume.metadata.Name === m.volume.name
        && s.volume.metadata.Driver === 'local' && s.volume.metadata.Scope === 'local'
        && s.volume.metadata.Options === null && same(s.volume.metadata.Labels, volumeLabels));
      volumeFingerprint(s.volume.metadata); // ALL identity fields, not a name hash.
    }
  }
  guard(input.snapshot);
  sequence = input.snapshot.sequence;
  function safe(fn) {
    try { return fn(); } catch { refused(); }
  }
  function status() {
    return copy({ phase, sequence, settled, pending: pending ? {
      operation: pending.operation, attempt: pending.attempt, from: pending.from,
      candidate: pending.candidate,
    } : null, identities: { network: owned.network, db: owned.db, app: owned.app,
      volume: owned.volume ? { name: owned.volume.Name, fingerprint: volumeFingerprint(owned.volume) } : null } });
  }
  function cleanupOperation() {
    if (topology.app === 'running' || topology.app === 'created') return 'stopAPP';
    if (topology.db === 'running' || topology.db === 'created') return 'stopDB';
    if (topology.app !== null) return 'removeAPP';
    if (topology.db !== null) return 'removeDB';
    if (topology.volume) return 'removeVolume';
    if (topology.network) return 'removeNetwork';
    return null;
  }
  function changed(operation) {
    const state = copy(topology);
    switch (operation) {
      case 'createNetwork': state.network = true; break;
      case 'createVolume': state.volume = true; break;
      case 'createDB': state.db = 'created'; break;
      case 'startDB': state.db = 'running'; break;
      case 'createAPP': state.app = 'created'; break;
      case 'startAPP': state.app = 'running'; break;
      case 'stopAPP': state.app = 'exited'; break;
      case 'stopDB': state.db = 'exited'; break;
      case 'removeAPP': state.app = null; break;
      case 'removeDB': state.db = null; break;
      case 'removeVolume': state.volume = false; break;
      case 'removeNetwork': state.network = false; break;
      default: refused();
    }
    return state;
  }
  function target(operation) {
    if (operation === 'createNetwork') return { name: m.network.name };
    if (operation === 'createVolume') return { name: m.volume.name };
    if (operation === 'createDB' || operation === 'createAPP') {
      const role = operation === 'createDB' ? 'db' : 'app';
      return { name: m.project+'-'+role+'-1', specification: m.services[role],
        network_id: owned.network, network_mode: m.network.name,
        volume: role === 'db' ? owned.volume : null };
    }
    if (operation === 'removeVolume') return { metadata: owned.volume, fingerprint: volumeFingerprint(owned.volume) };
    if (operation === 'removeNetwork') return { id: owned.network, name: m.network.name };
    const role = operation.endsWith('APP') ? 'app' : 'db';
    return { id: owned[role], name: m.project+'-'+role+'-1' };
  }
  return Object.freeze({
    status: () => safe(status),
    plan: (operation, snapshot) => safe(() => {
      check(!pending && typeof operation === 'string');
      check(operation === (settled === 'failed' ? cleanupOperation() : normal[phase]));
      const s = copy(snapshot); guard(s);
      const selection = target(operation);
      const token = Object.freeze({}); // Opaque object identity, local to this ledger.
      const plan = copy({ operation, attempt: ++serial, from: phase, target: selection,
        project: m.project, labels: m.labels, provenance });
      pending = { ...copy(plan), token, candidate: null };
      sequence = s.sequence;
      return Object.freeze({ token, ...plan });
    }),
    settle: (fact, snapshot) => safe(() => {
      check(!pending && settled === null);
      const f = copy(fact); keys(f, 'checksSettled outcome');
      check(f.checksSettled === true && (f.outcome === 'passed' || f.outcome === 'failed'));
      check(f.outcome === 'passed' ? phase === 'FULL_ACTIVE'
        : ['EMPTY','NETWORK','VOLUME','DB_CREATED','DB_RUNNING','APP_CREATED','FULL_ACTIVE'].includes(phase));
      const s = copy(snapshot); guard(s);
      settled = f.outcome;
      phase = f.outcome === 'failed' && !topology.network ? 'NETWORK_ABSENT' : 'SETTLED';
      sequence = s.sequence;
      return status();
    }),
    admitReceipt: (token, receipt, snapshot) => safe(() => {
      check(pending && token === pending.token);
      const r = copy(receipt); keys(r, 'attempt operation result');
      check(r.attempt === pending.attempt && r.operation === pending.operation);
      const operation = pending.operation;
      const candidate = copy(owned);
      if (createOps.has(operation)) {
        if (operation === 'createVolume') {
          keys(r.result, 'Name'); check(r.result.Name === m.volume.name);
        } else {
          keys(r.result, 'id'); check(hex(r.result.id));
          check(!Object.values(owned).includes(r.result.id));
        }
        // Safety retention is deliberate: a validated THIS-attempt response survives
        // failed proof. It is NOT admitted ownership, topology or cleanup authority.
        if (pending.candidate) check(same(pending.candidate.result, r.result));
        else pending.candidate = { result: copy(r.result), volume: null };
        if (operation === 'createVolume') {
          // Learn only structurally valid, declaration-bound full metadata, before
          // copying unrelated snapshot fields (whose accessors may refuse).
          const metadata = copy(ownData(ownData(snapshot, 'volume'), 'metadata'));
          const fingerprint = volumeFingerprint(metadata);
          check(metadata.Name === m.volume.name && metadata.Driver === 'local'
            && metadata.Scope === 'local' && metadata.Options === null
            && same(metadata.Labels, volumeLabels));
          if (pending.candidate.volume) check(same(pending.candidate.volume.metadata, metadata));
          else pending.candidate.volume = { metadata, fingerprint };
          candidate.volume = copy(pending.candidate.volume.metadata);
        } else {
          const role = operation === 'createNetwork' ? 'network' : operation === 'createDB' ? 'db' : 'app';
          candidate[role] = pending.candidate.result.id;
        }
      } else check(r.result === null);
      const s = copy(snapshot); const state = changed(operation);
      guard(s, candidate, state); // Only the pending safety latch may mutate on refusal.
      owned = candidate; topology = state; sequence = s.sequence;
      phase = settled === 'failed' ? (state.network ? 'FAILED_CLEANUP' : 'NETWORK_ABSENT') : next[operation];
      pending = null;
      return status();
    }),
  });
}
