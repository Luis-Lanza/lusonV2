// External verifier only. All Docker output stays private in the runner.
import { readFile, writeFile, realpath, lstat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { PROJECT, LABELS } from './l05-binding.mjs';

export const NSS_SCRIPT = 'umask 077; certutil -N --empty-password -d sql:/nss && certutil -A -n luson-owned-test-ca -t C,, -i /test-ca.crt -d sql:/nss';
const fullID = value => /^[a-f0-9]{64}$/.test(value ?? '');
const one = output => {
  const values = JSON.parse(output);
  if (!Array.isArray(values) || values.length !== 1) throw new Error('NSS tool inspection refused.');
  return values[0];
};
const ids = output => output.trim() ? output.trim().split(/\s+/) : [];

export class PrivateNSS {
  constructor({ owner, root, dockerfilePath, runToken = randomBytes(12).toString('hex') }) {
    if (!isAbsolute(root) || resolve(root) !== root || !/^luson-l05-[A-Za-z0-9_-]+$/.test(root.split('/').at(-1))
      || !/^[a-f0-9]{24}$/.test(runToken)) throw new Error('NSS tool private paths refused.');
    this.owner = owner;
    this.root = root;
    this.name = PROJECT+'-nss-'+runToken;
    this.image = this.name+':tool';
    this.nss = root+'/home/.pki/nssdb';
    this.ca = root+'/ca.crt';
    this.labels = { ...LABELS, 'luson.role': 'nss-tool', 'luson.tool-run': runToken };
    this.readDockerfile = () => readFile(dockerfilePath,'utf8');
    this.id = undefined;
    this.attempted = false;
  }
  async verifyFiles() {
    for (const [path, directory] of [[this.root,true],[this.nss,true],[this.ca,false]]) {
      const info = await lstat(path);
      if (await realpath(path) !== path || info.isSymbolicLink() || info.uid !== 1000 || info.gid !== 1000
        || (info.mode & 0o777) !== (directory ? 0o700 : 0o600) || (directory ? !info.isDirectory() : !info.isFile())) {
        throw new Error('NSS tool private file ownership refused.');
      }
    }
  }
  async persist() {
    await writeFile(this.root+'/nss-tool-state.json', JSON.stringify({ name: this.name, id: this.id, image: this.imageID, labels: this.labels }), { mode: 0o600 });
  }
  async guard(allowOwn = false) {
    await this.owner.fresh();
    const named = ids(await this.owner.docker(['ps','-aq','--no-trunc','--filter','name=^/'+PROJECT+'-nss-']));
    if (named.some(id => !allowOwn || id !== this.id)) throw new Error('NSS tool preexisting namespace refused.');
    const exact = ids(await this.owner.docker(['ps','-aq','--no-trunc','--filter','name=^/'+this.name+'$']));
    if (exact.some(id => !allowOwn || id !== this.id)) throw new Error('NSS tool preexisting name refused.');
  }
  async build() {
    await this.guard();
    await this.verifyFiles();
    if ((await this.owner.docker(['image','ls','-q','--no-trunc','--filter','reference='+this.image])).trim()) throw new Error('NSS tool preexisting image name refused.');
    // Dockerfile stdin gives Docker an EMPTY filesystem context. No CA, TLS key,
    // private HOME, database secret, source directory or daemon mount is sent.
    await this.owner.docker(['build','--tag',this.image,'-'], { input: await this.readDockerfile(), timeout: 600000 });
    this.imageID = one(await this.owner.docker(['image','inspect',this.image])).Id;
    if (!/^sha256:[a-f0-9]{64}$/.test(this.imageID ?? '')) throw new Error('NSS tool image identity refused.');
  }
  validate(container, expected = this.id) {
    const host = container.HostConfig;
    const config = container.Config;
    const mounts = container.Mounts;
    const matches = (source, destination, writable) => mounts?.filter(m => m.Type === 'bind' && m.Source === source && m.Destination === destination && m.RW === writable).length === 1;
    if (!fullID(expected) || container.Id !== expected || container.Name !== '/'+this.name || container.Image !== this.imageID
      || config?.Image !== this.image || config.User !== '1000:1000'
      || !Object.entries(this.labels).every(([key,value]) => config.Labels?.[key] === value)
      || JSON.stringify(config.Entrypoint) !== '["/bin/sh"]' || JSON.stringify(config.Cmd) !== JSON.stringify(['-ec',NSS_SCRIPT])
      || host?.NetworkMode !== 'none' || !host.ReadonlyRootfs || !host.CapDrop?.includes('ALL')
      || !host.SecurityOpt?.includes('no-new-privileges') || Object.keys(host.PortBindings ?? {}).length
      || mounts?.length !== 2 || !matches(this.nss,'/nss',true) || !matches(this.ca,'/test-ca.crt',false)) {
      throw new Error('NSS tool full identity or isolation refused.');
    }
    return container;
  }
  async inspect() { return this.validate(one(await this.owner.docker(['inspect','--type=container',this.id]))); }
  async recover() {
    if (this.id || !this.attempted) return;
    await this.owner.fresh();
    const found = ids(await this.owner.docker(['ps','-aq','--no-trunc','--filter','name=^/'+this.name+'$']));
    if (!found.length) return;
    if (found.length !== 1 || !fullID(found[0])) throw new Error('NSS tool recovery refused.');
    this.validate(one(await this.owner.docker(['inspect','--type=container',found[0]])),found[0]);
    this.id = found[0];
    await this.persist();
  }
  async create() {
    await this.guard();
    await this.verifyFiles();
    if (!this.imageID || one(await this.owner.docker(['image','inspect',this.image])).Id !== this.imageID) throw new Error('NSS tool image substitution refused.');
    this.attempted = true;
    try {
      const id = (await this.owner.docker(['create','--name',this.name,'--network','none','--read-only','--user','1000:1000',
        '--cap-drop','ALL','--security-opt','no-new-privileges',
        ...Object.entries(this.labels).flatMap(([key,value]) => ['--label',key+'='+value]),
        '--mount','type=bind,src='+this.nss+',dst=/nss', '--mount','type=bind,src='+this.ca+',dst=/test-ca.crt,readonly',
        '--entrypoint','/bin/sh',this.image,'-ec',NSS_SCRIPT])).trim();
      this.validate(one(await this.owner.docker(['inspect','--type=container',id])),id);
      this.id = id;
      await this.persist();
    } finally { await this.recover(); }
  }
  async start() {
    await this.guard(true); await this.inspect();
    await this.owner.docker(['start',this.id]);
    const code = await this.owner.docker(['wait',this.id], { timeout: 30000 });
    await this.guard(true);
    const container = await this.inspect();
    if (code.trim() !== '0' || container.State?.Status !== 'exited' || container.State.ExitCode !== 0) throw new Error('Private NSS initialization failed.');
  }
  async cleanup() {
    await this.recover();
    await this.guard(true);
    if (this.id) {
      await this.inspect();
      await this.owner.docker(['stop','--time','5',this.id]);
      await this.guard(true); await this.inspect();
      await this.owner.docker(['rm',this.id]);
      this.id = undefined;
      this.attempted = false;
      await this.persist();
    }
    await this.guard(); // No tool remains before app/db startup or TMP removal.
  }
}
