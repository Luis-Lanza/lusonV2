// Runtime-only ownership guard; pure tests inject the command and manifest reader.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PROJECT, NETWORK_ID, NETWORK_NAME, VOLUME_NAME, validateBinding, validateContainer } from './l05-binding.mjs';

const one = output => {
  const array = JSON.parse(output);
  if (!Array.isArray(array) || array.length !== 1) throw new Error('Single resource inspection required.');
  return array[0];
};
const ids = output => output.trim() ? output.trim().split(/\s+/) : [];
const fingerprint = config => createHash('sha256').update(JSON.stringify(config, (_key,value) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key,value[key]])) : value)).digest('hex');

export class OwnedCompose {
  constructor({ command, manifestPath, composePath, overridePath, env, statePath }) {
    this.command = command;
    this.manifestPath = manifestPath;
    this.files = ['-f', composePath, '-f', overridePath];
    this.env = env;
    this.statePath = statePath;
    this.owned = new Map();
    this.hashes = new Map();
    this.creationAttempted = new Set();
    this.beforeCreation = new Map();
    this.readManifest = async () => JSON.parse(await readFile(this.manifestPath, 'utf8'));
  }
  async docker(args, options) { return this.command('docker', args, { env: this.env, ...options }); }
  async fresh(planned = new Map()) {
    const manifest = await this.readManifest();
    const network = one(await this.docker(['network', 'inspect', NETWORK_ID]));
    const volume = one(await this.docker(['volume', 'inspect', VOLUME_NAME]));
    const expected = new Map([...this.owned, ...planned]);
    const owned = [...expected.values()];
    validateBinding(this.env, manifest, network, volume, owned);
    // Network inspection cannot see a stopped container referencing a volume.
    const users = ids(await this.docker(['ps', '-aq', '--no-trunc', '--filter', 'volume='+VOLUME_NAME]));
    if (users.some(id => !owned.includes(id))) throw new Error('Preexisting volume attachment refused.');
    const project = ids(await this.docker(['ps', '-aq', '--no-trunc', '--filter', 'label=com.docker.compose.project='+PROJECT]));
    if (project.some(id => !owned.includes(id))) throw new Error('Preexisting project resource refused.');
    for (const service of ['app','db']) {
      const named = ids(await this.docker(['ps', '-aq', '--no-trunc', '--filter', 'name=^/'+PROJECT+'-'+service+'-1$']));
      if (named.some(id => id !== expected.get(service))) throw new Error('Preexisting exact container name refused.');
    }
    return { network, volume };
  }
  async inspect(service, detached = false) {
    const id = this.owned.get(service);
    const container = one(await this.docker(['inspect', '--type=container', id]));
    validateContainer(id, service, container, this.hashes.get(service), detached);
    if (service === 'db') {
      const mounts = container.Mounts?.filter(mount => mount.Type === 'volume');
      if (mounts?.length !== 1 || mounts[0].Name !== VOLUME_NAME || mounts[0].Destination !== '/var/lib/postgresql/data'
        || Object.keys(container.HostConfig?.PortBindings ?? {}).length) throw new Error('Database storage/publication refused.');
    } else if (container.Config.User !== '1000:1000' || !container.HostConfig?.ReadonlyRootfs
      || container.Mounts?.some(mount => mount.RW)) throw new Error('App identity or immutable mounts refused.');
    return container;
  }
  async guard(service, detached = false) {
    await this.fresh();
    for (const current of this.owned.keys()) await this.inspect(current, current === service ? detached : true);
  }
  async compose(args, timeout = 60000) {
    return this.docker(['compose', '--project-name', PROJECT, ...this.files, ...args], { timeout });
  }
  async persist() {
    if (this.statePath) await writeFile(this.statePath, JSON.stringify({ ids: Object.fromEntries(this.owned), hashes: Object.fromEntries(this.hashes) }), { mode: 0o600 });
  }
  async configuration() {
    // Capture normalized configuration privately, never print or persist it.
    const config = JSON.parse(await this.compose(['config', '--format', 'json']));
    const services = config?.services;
    const dependency = services?.app?.depends_on?.db;
    if (!services || Object.keys(services).sort().join(',') !== 'app,db'
      || Object.keys(services.app.depends_on ?? {}).join(',') !== 'db'
      || Object.keys(services.db.depends_on ?? {}).length || dependency?.condition !== 'service_healthy'
      || ![undefined,true].includes(dependency.required) || ![undefined,false].includes(dependency.restart)
      || Object.values(services).some(service => ['links','volumes_from','network_mode','ipc','pid'].some(key => key in service))) {
      throw new Error('Compose dependency closure refused.');
    }
    return config;
  }
  async configure() {
    await this.fresh();
    this.configDigest = fingerprint(await this.configuration());
    const services = (await this.compose(['config', '--services'])).split(/\s+/).sort().join(',');
    if (services !== 'app,db') throw new Error('Exactly two services required.');
    for (const service of ['app','db']) {
      const hash = (await this.compose(['config', '--hash', service])).trim().split(/\s+/);
      if (hash.length !== 2 || hash[0] !== service || !/^[a-f0-9]{64}$/.test(hash[1])) throw new Error('Compose config identity required.');
      this.hashes.set(service, hash[1]);
    }
  }
  async build() {
    await this.guard();
    await this.compose(['build', 'app'], 600000);
  }
  async checkCreateConfig(service) {
    if (!this.configDigest || fingerprint(await this.configuration()) !== this.configDigest
      || !/^[a-f0-9]{64}$/.test(this.hashes.get(service) ?? '')) throw new Error('Configured create identity refused.');
    if (service === 'app') {
      if (!this.owned.has('db') || !/^[a-f0-9]{64}$/.test(this.hashes.get('db') ?? '')) throw new Error('Untracked app dependency refused.');
      const db = await this.inspect('db');
      if (db.State?.Status !== 'running' || db.State?.Health?.Status !== 'healthy') throw new Error('Ready owned dependency required.');
    }
  }
  async create(service) {
    if (!['app','db'].includes(service) || this.owned.has(service)) throw new Error('Creation ownership refused.');
    await this.guard();
    await this.checkCreateConfig(service);
    await this.guard();
    // Supported create may visit dependencies: only the already-owned healthy
    // DB is permitted, and --no-recreate must preserve every prior full ID.
    this.beforeCreation.set(service, new Map(this.owned));
    this.creationAttempted.add(service);
    try { await this.compose(['create', '--no-build', '--no-recreate', service]); }
    finally { await this.recover(service); }
    await this.checkCreateConfig(service);
    await this.guard(service, true);
    await this.compose(['start', service]);
    await this.assertPrevious(service);
    await this.guard(service);
  }
  async assertPrevious(service) {
    for (const [previous,id] of this.beforeCreation.get(service) ?? []) {
      if (this.owned.get(previous) !== id || !/^[a-f0-9]{64}$/.test(this.hashes.get(previous) ?? '')) throw new Error('Previous owned identity changed.');
      await this.inspect(previous, true);
    }
  }
  async recover(service) {
    if (!this.creationAttempted.has(service)) return;
    await this.assertPrevious(service);
    const hash = this.hashes.get(service);
    if (!/^[a-f0-9]{64}$/.test(hash ?? '')) throw new Error('Recovery config identity refused.');
    if (this.owned.has(service)) return;
    let output;
    try { output = await this.docker(['inspect', '--type=container', PROJECT+'-'+service+'-1']); }
    catch { return; } // No container exists if create was refused before effect.
    const container = one(output);
    validateContainer(container.Id, service, container, hash, true);
    // Admit only this validated planned ID while checking fresh resource lists.
    // Unexpected dependencies/expansion refuse recovery, never broaden adoption.
    await this.fresh(new Map([[service,container.Id]]));
    this.owned.set(service, container.Id);
    await this.persist();
  }
  async remove(service) {
    if (!this.owned.has(service)) return;
    await this.guard(service, true);
    const id = this.owned.get(service);
    await this.docker(['stop', '--time', '5', id]);
    await this.guard(service, true);
    await this.docker(['rm', id]); // No volume flags; never down/prune.
    const remaining = ids(await this.docker(['ps', '-aq', '--no-trunc', '--filter', 'id='+id]));
    if (remaining.length) throw new Error('Owned container remains.');
    this.owned.delete(service);
    this.creationAttempted.delete(service);
    this.beforeCreation.delete(service);
    await this.persist();
    await this.fresh();
  }
  async sql(query) {
    await this.guard('db');
    // Only fixture SQL, never credentials in argv or stdout. Caller holds output
    // privately; no generic reporter receives rows, hashes or errors.
    return this.docker(['exec', '-i', this.owned.get('db'), 'psql', '-X', '-U', 'luson', '-d', 'luson', '-v', 'ON_ERROR_STOP=1', '-At'], { input: query, timeout: 15000 });
  }
  async cleanup() {
    for (const service of this.creationAttempted) await this.recover(service);
    for (const service of ['app','db']) await this.remove(service);
    const { network } = await this.fresh();
    if (Object.keys(network.Containers).length || this.owned.size) throw new Error('Parent network not empty.');
  }
}
