import { describe, it, expect } from 'vitest';
import { PROJECT, NETWORK_ID, NETWORK_NAME, VOLUME_NAME, CREATED_AT, LABELS, validateBinding, validateContainer } from './l05-binding.mjs';

import { OwnedCompose } from './l05-owned-compose.mjs';
import { PrivateNSS, NSS_SCRIPT } from './l05-nss.mjs';

const id = 'a'.repeat(64);
const env = { LUSON_TEST_COMPOSE_MANIFEST: '/explicit/manifest.json' };
const manifest = { schema: 'luson.compose-test/v1', status: 'active', project: PROJECT, services: ['app', 'db'], labels: LABELS,
  network: { id: NETWORK_ID, name: NETWORK_NAME, labels: LABELS },
  volume: { Name: VOLUME_NAME, Driver: 'local', CreatedAt: CREATED_AT, Labels: LABELS, Options: null, Scope: 'local' }, app_uid: 1000, app_gid: 1000 };
const network = { Id: NETWORK_ID, Name: NETWORK_NAME, Labels: LABELS, Containers: {} };
const volume = manifest.volume;
const container = { Id: id, Name: '/'+PROJECT+'-app-1', Config: { Labels: { ...LABELS, 'com.docker.compose.project': PROJECT,
  'com.docker.compose.service': 'app', 'com.docker.compose.config-hash': 'b'.repeat(64), 'com.docker.compose.container-number': '1', 'com.docker.compose.oneoff': 'False' } },
  NetworkSettings: { Networks: { [NETWORK_NAME]: { NetworkID: NETWORK_ID } } } };
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

describe('L05 supported create and dependency ownership (Docker mocked)', () => {
  function fixture(strictCLI = true) {
    const calls: string[][] = [];
    const records = new Map<string, any>();
    const graph: any = { services: { app: { depends_on: { db: { condition: 'service_healthy', required: true } } }, db: {} } };
    let sequence = 0;
    let replaceDB = false;
    let expand = false;
    let interrupt = false;
    const record = (service: string, fullID: string) => ({ ...copy(container), Id: fullID, Name: '/'+PROJECT+'-'+service+'-1',
      Config: { User: '1000:1000', Labels: { ...container.Config.Labels, 'com.docker.compose.service': service } },
      HostConfig: { ReadonlyRootfs: true, PortBindings: {} }, State: { Status: 'running', Health: { Status: 'healthy' } },
      Mounts: service === 'db' ? [{ Type: 'volume', Name: VOLUME_NAME, Destination: '/var/lib/postgresql/data' }] : [] });
    const owner = new OwnedCompose({ command: async (_binary: string, args: string[]) => {
      calls.push(args);
      if (args[0] === 'network') return JSON.stringify([{ ...network, Containers: Object.fromEntries([...records.values()].map(c => [c.Id,{}])) }]);
      if (args[0] === 'volume') return JSON.stringify([volume]);
      if (args[0] === 'inspect') {
        const c = [...records.values()].find(c => c.Id === args.at(-1) || c.Name === '/'+args.at(-1));
        if (!c) throw new Error('Missing mocked container');
        return JSON.stringify([c]);
      }
      if (args[0] === 'ps') {
        const filter = args.at(-1)!;
        return [...records.values()].filter(c => filter.startsWith('volume=') ? c.Config.Labels['com.docker.compose.service'] === 'db'
          : filter.startsWith('name=') ? filter === 'name=^'+c.Name+'$' : filter.startsWith('id=') ? filter === 'id='+c.Id : true).map(c => c.Id).join('\n');
      }
      if (args[0] === 'rm') { for (const [service,c] of records) if (c.Id === args[1]) records.delete(service); return ''; }
      if (args[0] === 'stop') return '';
      if (args[0] === 'compose') {
        if (args.includes('config')) {
          if (args.includes('--services')) return 'app\ndb';
          if (args.includes('--hash')) return args.at(-1)+' '+'b'.repeat(64);
          return JSON.stringify(graph);
        }
        if (args.includes('create')) {
          if (strictCLI && args.includes('--no-deps')) throw new Error('Unsupported create --no-deps');
          const service = args.at(-1)!;
          records.set(service,record(service,['e','f','c','d'][sequence++].repeat(64)));
          if (replaceDB && service === 'app') records.get('db').Id = '9'.repeat(64);
          if (expand) records.set('unexpected',record('unexpected','8'.repeat(64)));
          if (interrupt) throw new Error('Interrupted mocked create');
        }
        return '';
      }
      throw new Error('Unexpected mock command');
    }, manifestPath: '/not-read', composePath: '/not-read', overridePath: '/not-read', env, statePath: undefined });
    owner.readManifest = async () => copy(manifest);
    return { owner, calls, graph, records, trackDB: () => { records.set('db',record('db',id)); owner.owned.set('db',id); },
      replace: () => { replaceDB = true; }, expand: () => { expand = true; }, interrupt: () => { interrupt = true; } };
  }
  it('uses only supported create flags and preserves the tracked DB across app recreation', async () => {
    const f = fixture(); await f.owner.configure(); await f.owner.create('db');
    const dbID = f.owner.owned.get('db');
    await f.owner.create('app'); const firstApp = f.owner.owned.get('app');
    await f.owner.remove('app'); await f.owner.create('app');
    expect(f.owner.owned.get('app')).not.toBe(firstApp);
    expect(f.owner.owned.get('db')).toBe(dbID); expect(f.records.get('db').Id).toBe(dbID);
    const creates = f.calls.filter(args => args.includes('create'));
    expect(creates.map(args => args.slice(args.indexOf('create')))).toEqual([
      ['create','--no-build','--no-recreate','db'], ['create','--no-build','--no-recreate','app'], ['create','--no-build','--no-recreate','app'],
    ]);
    expect(f.calls.some(args => args.includes('up'))).toBe(false);
  });
  for (const scenario of ['app-first','untracked-db','missing-db-hash','config-drift','unknown-dependency','db-has-dependency']) {
    it('refuses '+scenario+' before create effects', async () => {
      const f = fixture(false); await f.owner.configure();
      if (scenario !== 'app-first') f.trackDB();
      if (scenario === 'untracked-db') f.owner.owned.delete('db');
      if (scenario === 'missing-db-hash') f.owner.hashes.delete('db');
      if (scenario === 'config-drift') f.graph.services.app.image = 'unexpected:changed';
      if (scenario === 'unknown-dependency') f.graph.services.app.depends_on.extra = { condition: 'service_started' };
      if (scenario === 'db-has-dependency') { f.records.clear(); f.owner.owned.clear(); f.graph.services.db.depends_on = { app: {} }; }
      f.calls.length = 0;
      await expect(f.owner.create(scenario === 'db-has-dependency' ? 'db' : 'app')).rejects.toThrow();
      expect(f.calls.some(args => args.includes('create'))).toBe(false);
    });
  }
  for (const scenario of ['replace-db','unexpected-expansion']) {
    it('does not adopt app or arbitrary resources after '+scenario, async () => {
      const f = fixture(false); await f.owner.configure(); f.trackDB();
      scenario === 'replace-db' ? f.replace() : f.expand();
      await expect(f.owner.create('app')).rejects.toThrow();
      expect(f.owner.owned.has('app')).toBe(false); expect(f.owner.owned.get('db')).toBe(id);
      expect(f.calls.some(args => args.includes('start'))).toBe(false);
    });
  }
  it('recovers only the planned app after interrupted CLI and leaves the previous DB identity intact', async () => {
    const f = fixture(false); await f.owner.configure(); f.trackDB(); f.interrupt();
    await expect(f.owner.create('app')).rejects.toThrow('Interrupted mocked create');
    expect(f.owner.owned.get('db')).toBe(id); expect(f.owner.owned.get('app')).toBe('e'.repeat(64));
    await f.owner.cleanup();
    expect(f.records.size).toBe(0);
  });
});

describe('L05 private NSS ownership (Docker mocked)', () => {
  function fixture() {
    const calls: string[][] = [];
    const root = '/tmp/luson-l05-mocked';
    const name = PROJECT+'-nss-'+'d'.repeat(24);
    const image = name+':tool';
    const inspection: any = { Id: id, Name: '/'+name, Image: 'sha256:'+'e'.repeat(64),
      Config: { Image: image, User: '1000:1000', Labels: { ...LABELS, 'luson.role': 'nss-tool', 'luson.tool-run': 'd'.repeat(24) },
        Entrypoint: ['/bin/sh'], Cmd: ['-ec', NSS_SCRIPT] },
      HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], PortBindings: {} },
      Mounts: [{ Type: 'bind', Source: root+'/home/.pki/nssdb', Destination: '/nss', RW: true },
        { Type: 'bind', Source: root+'/ca.crt', Destination: '/test-ca.crt', RW: false }], State: { Status: 'exited', ExitCode: 0 } };
    let occupied = false;
    let refused = false;
    let lostCreate = false;
    const owner = { fresh: async () => { calls.push(['fresh']); if (refused) throw new Error('binding refused'); },
      docker: async (args: string[]) => {
        calls.push(args);
        if (args[0] === 'ps') return occupied ? id : '';
        if (args[0] === 'image') return args[1] === 'ls' ? '' : JSON.stringify([{ Id: inspection.Image }]);
        if (args[0] === 'inspect') return JSON.stringify([inspection]);
        if (args[0] === 'create') { occupied = true; if (lostCreate) throw new Error('Interrupted create'); return id; }
        if (args[0] === 'rm') { occupied = false; return id; }
        if (args[0] === 'wait') return '0';
        return '';
      } };
    const tool = new PrivateNSS({ owner, root, runToken: 'd'.repeat(24), dockerfilePath: '/not-read' });
    tool.verifyFiles = async () => {};
    tool.readDockerfile = async () => 'FROM node:26.8.1-bookworm-slim\n';
    tool.persist = async () => {};
    return { tool, calls, inspection, occupy: () => { occupied = true; }, refuse: () => { refused = true; }, loseCreate: () => { lostCreate = true; } };
  }
  it('refuses preexisting tool names before build/create effects', async () => {
    for (const action of ['build','create'] as const) {
      const f = fixture(); f.occupy();
      await expect(f.tool[action]()).rejects.toThrow(/tool.*refused/);
      expect(f.calls.some(args => args[0] === action)).toBe(false);
    }
  });
  it('freshly rejects a changed parent binding before start/cleanup', async () => {
    for (const action of ['start','cleanup'] as const) {
      const f = fixture(); await f.tool.build(); await f.tool.create(); f.calls.length = 0; f.refuse();
      await expect(f.tool[action]()).rejects.toThrow(/binding refused/);
      expect(f.calls.some(args => ['start','stop','rm'].includes(args[0]))).toBe(false);
    }
  });
  for (const scenario of ['wrong-id','wrong-role','extra-mount','writable-ca','network','root-user','writable-root']) {
    it('refuses unsafe NSS '+scenario+' before starting', async () => {
      const f = fixture(); await f.tool.build(); await f.tool.create(); f.calls.length = 0;
      switch (scenario) {
        case 'wrong-id': f.inspection.Id = 'f'.repeat(64); break;
        case 'wrong-role': f.inspection.Config.Labels['luson.role'] = 'app'; break;
        case 'extra-mount': f.inspection.Mounts.push({ Source: '/private', Destination: '/secrets', RW: true }); break;
        case 'writable-ca': f.inspection.Mounts[1].RW = true; break;
        case 'network': f.inspection.HostConfig.NetworkMode = 'bridge'; break;
        case 'root-user': f.inspection.Config.User = '0:0'; break;
        case 'writable-root': f.inspection.HostConfig.ReadonlyRootfs = false; break;
      }
      await expect(f.tool.start()).rejects.toThrow(/tool.*refused/);
      expect(f.calls.some(args => args[0] === 'start')).toBe(false);
    });
  }
  it('recovers an interrupted create only by exact name/full identity, then removes that ID', async () => {
    const f = fixture(); await f.tool.build(); f.loseCreate();
    await expect(f.tool.create()).rejects.toThrow('Interrupted create');
    expect(f.tool.id).toBe(id);
    await f.tool.cleanup();
    expect(f.calls.find(args => args[0] === 'rm')).toEqual(['rm', id]);
  });
  it('builds with Dockerfile-only context, mounts only NSS RW/CA RO and removes exact ID', async () => {
    const f = fixture(); await f.tool.build(); await f.tool.create(); await f.tool.start(); await f.tool.cleanup();
    const build = f.calls.find(args => args[0] === 'build')!;
    expect(build.at(-1)).toBe('-');
    const create = f.calls.find(args => args[0] === 'create')!;
    expect(create).toContain('none'); expect(create).toContain('--read-only'); expect(create).toContain('1000:1000');
    expect(create.filter(arg => arg === '--mount')).toHaveLength(2);
    expect(f.calls.find(args => args[0] === 'rm')).toEqual(['rm', id]);
  });
});

describe('L05 binding without runtime effects', () => {
  it('accepts only explicit active parent identity and real volume metadata', () => {
    expect(validateBinding(env, manifest, network, volume)).toBe(true);
  });
  for (const scenario of ['missing-env', 'inactive', 'schema', 'project', 'extra-service', 'uid', 'gid', 'network-id', 'network-name', 'network-label', 'extra-label', 'attached', 'volume-name', 'volume-time', 'volume-driver', 'volume-scope', 'volume-options', 'volume-label', 'manifest-volume-time']) {
    it('refuses '+scenario+' before effects', () => {
      const e = copy(env), m = copy(manifest), n: any = copy(network), v: any = copy(volume);
      switch (scenario) {
        case 'missing-env': e.LUSON_TEST_COMPOSE_MANIFEST = ''; break;
        case 'inactive': m.status = 'retired'; break;
        case 'schema': m.schema = 'luson.test-network/v1'; break;
        case 'project': m.project = 'other'; break;
        case 'extra-service': m.services.push('vite'); break;
        case 'uid': m.app_uid = 0; break;
        case 'gid': m.app_gid = 0; break;
        case 'network-id': n.Id = 'c'.repeat(64); break;
        case 'network-name': n.Name += '-other'; break;
        case 'network-label': n.Labels['luson.task'] = 'L04'; break;
        case 'extra-label': n.Labels.extra = 'unexpected'; break;
        case 'attached': n.Containers[id] = {}; break;
        case 'volume-name': v.Name += '-other'; break;
        case 'volume-time': v.CreatedAt = '2026-10-07T00:00:00Z'; break;
        case 'volume-driver': v.Driver = 'other'; break;
        case 'volume-scope': v.Scope = 'global'; break;
        case 'volume-options': v.Options = {}; break;
        case 'volume-label': v.Labels['luson.task'] = 'L03'; break;
        case 'manifest-volume-time': m.volume.CreatedAt = 'changed'; break;
      }
      expect(() => validateBinding(e, m, n, v)).toThrow(/binding refused/);
    });
  }
  it('accepts only recorded full owned IDs in attached network', () => {
    const n: any = copy(network); n.Containers[id] = {};
    expect(validateBinding(env, manifest, n, volume, [id])).toBe(true);
    n.Containers['c'.repeat(64)] = {};
    expect(() => validateBinding(env, manifest, n, volume, [id])).toThrow();
  });
  it('refuses an unlabelled preexisting exact container name before image effects', async () => {
    const calls: string[][] = [];
    const owner = new OwnedCompose({ command: async (_command: string, args: string[]) => {
      calls.push(args);
      if (args[0] === 'network') return JSON.stringify([network]);
      if (args[0] === 'volume') return JSON.stringify([volume]);
      if (args[0] === 'ps') return args.some(arg => arg.startsWith('name=')) ? id : '';
      if (args[0] === 'compose') return '';
      throw new Error('Unexpected mock effect');
    }, manifestPath: '/not-read', composePath: '/not-read', overridePath: '/not-read', env, statePath: undefined });
    owner.readManifest = async () => copy(manifest);
    await expect(owner.build()).rejects.toThrow(/Preexisting.*name/);
    expect(calls.some(args => args[0] === 'compose')).toBe(false);
  });
  it('revalidates before SQL and stops before effects on changed binding', async () => {
    const calls: string[][] = [];
    const n: any = copy(network); n.Containers[id] = {};
    const c: any = copy(container);
    c.Config.Labels['com.docker.compose.service'] = 'db'; c.Name = '/'+PROJECT+'-db-1';
    c.Mounts = [{ Type: 'volume', Name: VOLUME_NAME, Destination: '/var/lib/postgresql/data' }];
    c.HostConfig = { PortBindings: {} };
    const owner = new OwnedCompose({ command: async (_command: string, args: string[]) => {
      calls.push(args);
      if (args[0] === 'network') return JSON.stringify([n]);
      if (args[0] === 'volume') return JSON.stringify([volume]);
      if (args[0] === 'ps') return args.some(arg => arg === 'name=^/'+PROJECT+'-app-1$') ? '' : id;
      if (args[0] === 'inspect') return JSON.stringify([c]);
      if (args[0] === 'exec') return 'private-result';
      throw new Error('Unexpected mock effect');
    }, manifestPath: '/not-read', composePath: '/not-read', overridePath: '/not-read', env, statePath: undefined });
    owner.readManifest = async () => copy(manifest);
    owner.owned.set('db', id); owner.hashes.set('db', 'b'.repeat(64));
    expect(await owner.sql('SELECT 1')).toBe('private-result');
    calls.length = 0; n.Id = 'c'.repeat(64);
    await expect(owner.sql('SELECT 1')).rejects.toThrow(/binding refused/);
    expect(calls.some(args => args[0] === 'exec')).toBe(false);
  });
  it('allows only labeled expected detached containers during creation/stop', () => {
    const c: any = copy(container); c.State = { Status: 'created' };
    c.HostConfig = { NetworkMode: NETWORK_NAME }; c.NetworkSettings.Networks[NETWORK_NAME].NetworkID = '';
    expect(validateContainer(id, 'app', c, 'b'.repeat(64), true)).toBe(true);
    expect(() => validateContainer(id, 'app', c, 'b'.repeat(64))).toThrow();
    c.State.Status = 'running';
    expect(() => validateContainer(id, 'app', c, 'b'.repeat(64), true)).toThrow();
  });
  it('allows required custom and standard Compose labels together', () => {
    expect(validateContainer(id, 'app', container, 'b'.repeat(64))).toBe(true);
  });
  for (const scenario of ['short-id', 'wrong-id', 'wrong-service', 'wrong-project', 'wrong-task', 'missing-hash', 'changed-hash', 'wrong-network', 'extra-network']) {
    it('refuses container '+scenario, () => {
      const c: any = copy(container); let expected = id;
      switch (scenario) {
        case 'short-id': expected = id.slice(0,12); break;
        case 'wrong-id': c.Id = 'c'.repeat(64); break;
        case 'wrong-service': c.Config.Labels['com.docker.compose.service'] = 'db'; break;
        case 'wrong-project': c.Config.Labels['com.docker.compose.project'] = 'other'; break;
        case 'wrong-task': c.Config.Labels['luson.task'] = 'L04'; break;
        case 'missing-hash': delete c.Config.Labels['com.docker.compose.config-hash']; break;
        case 'changed-hash': c.Config.Labels['com.docker.compose.config-hash'] = 'c'.repeat(64); break;
        case 'wrong-network': c.NetworkSettings.Networks[NETWORK_NAME].NetworkID = 'c'.repeat(64); break;
        case 'extra-network': c.NetworkSettings.Networks.bridge = {}; break;
      }
      expect(() => validateContainer(expected, 'app', c, 'b'.repeat(64))).toThrow(/container refused/);
    });
  }
});
