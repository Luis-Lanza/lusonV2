// ACCOUNT data is transient. Never log provider/request/transport failures.
import net from 'node:net';
import { lstat, chmod, unlink, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
const fail = () => { throw new Error('R05 credential IPC refused.'); };
const MAX = 4096;
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).sort().join(',') === keys.split(' ').sort().join(',');
const sameInode = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino;
async function absent(path) {
  try { await lstat(path); return false; } catch (e) { if (e.code === 'ENOENT') return true; throw e; }
}
async function binding(options, socket = false) {
  const { root, endpoint, run_id, uid } = options;
  if (typeof root !== 'string' || typeof endpoint !== 'string' || !isAbsolute(root)
    || resolve(root) !== root || root === '/' || dirname(endpoint) !== root || resolve(endpoint) !== endpoint
    || Buffer.byteLength(endpoint) > 100 || !/^[a-f0-9]{16,32}$/.test(run_id)
    || !Number.isSafeInteger(uid) || uid <= 0 || uid !== process.getuid()) fail();
  for (let path = root; path !== '/'; path = dirname(path)) {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail();
  }
  const directory = await lstat(root);
  if (directory.uid !== uid || (directory.mode & 0o777) !== 0o700) fail();
  if (!socket) return directory;
  const stat = await lstat(endpoint);
  if (!stat.isSocket() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o777) !== 0o600) fail();
  return { directory, stat };
}
function records(value) {
  if (!Array.isArray(value) || value.length !== 3) fail();
  const result = value.map(v => {
    if (!exact(v, 'role username password') || !['W','A','B'].includes(v.role)
      || typeof v.username !== 'string' || !v.username.length || v.username.length > 128
      || typeof v.password !== 'string' || !v.password.length || v.password.length > 512) fail();
    return { role: v.role, username: v.username, password: v.password };
  });
  if (new Set(result.map(v => v.role)).size !== 3 || new Set(result.map(v => v.username)).size !== 3) fail();
  return result;
}
export class CredentialBridge {
  #options; #provider; #server; #inode; #root; #directory; #state = 'new'; #sockets = new Set(); #count = 0; #stopping;
  constructor({ provider, maxRequests = 32, timeout = 2000, ...options } = {}) {
    if (typeof provider !== 'function' || !Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 128
      || !Number.isInteger(timeout) || timeout < 10 || timeout > 10000) fail();
    this.#provider = provider; this.#options = { ...options, maxRequests, timeout };
  }
  async start() {
    try {
      if (this.#state !== 'new') fail();
      this.#state = 'starting';
      this.#root = await binding(this.#options);
      if (!await absent(this.#options.endpoint)) fail();
      this.#directory = await open(this.#options.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      if (!sameInode(await this.#directory.stat(), this.#root)) fail();
      const server = net.createServer({ allowHalfOpen: true }, socket => this.#accept(socket));
      this.#server = server;
      server.on('error', () => {}); // Listen failure is sanitized below; never raw diagnostics.
      await new Promise((yes, no) => { server.once('error', no); server.listen(this.#options.endpoint, () => { server.removeListener('error', no); yes(); }); });
      this.#inode = await lstat(this.#options.endpoint);
      await chmod(this.#options.endpoint, 0o600);
      const current = await binding(this.#options, true);
      if (!sameInode(current.stat, this.#inode) || !sameInode(current.directory, this.#root)) fail();
      this.#state = 'running';
      return Object.freeze({ root: this.#options.root, endpoint: this.#options.endpoint, run_id: this.#options.run_id, uid: this.#options.uid });
    } catch { await this.stop(); fail(); }
  }
  #accept(socket) {
    this.#sockets.add(socket);
    let chunks = []; let bytes = 0; let processed = false;
    const abort = new AbortController();
    const cancelled = new Promise((_, reject) => abort.signal.addEventListener('abort', () => reject(new Error('R05 credential IPC refused.')), { once: true }));
    cancelled.catch(() => {});
    const deny = () => { chunks = []; abort.abort(); socket.destroy(); };
    socket.on('error', deny); socket.on('close', () => { chunks = []; abort.abort(); this.#sockets.delete(socket); });
    socket.setTimeout(this.#options.timeout, deny);
    if (this.#state !== 'running' || ++this.#count > this.#options.maxRequests || this.#sockets.size > 8) { deny(); return; }
    socket.on('data', chunk => {
      if (processed || (bytes += chunk.length) > MAX) { deny(); return; }
      chunks.push(chunk);
    });
    socket.on('end', async () => {
      if (processed || socket.destroyed) return;
      processed = true;
      try {
        const request = JSON.parse(Buffer.concat(chunks).toString('utf8')); chunks = [];
        if (!exact(request, 'run_id') || request.run_id !== this.#options.run_id) fail();
        const current = await binding(this.#options, true);
        if (this.#state !== 'running' || !sameInode(current.stat, this.#inode) || !sameInode(current.directory, this.#root)) fail();
        // Capture only after all binding checks. Cancellation drops late results.
        let value = await Promise.race([this.#provider({ signal: abort.signal }), cancelled]);
        if (this.#state !== 'running' || socket.destroyed) { value = null; return; }
        const after = await binding(this.#options, true);
        if (!sameInode(after.stat, this.#inode) || !sameInode(after.directory, this.#root)) fail();
        let payload = JSON.stringify({ run_id: this.#options.run_id, records: records(value) }); value = null;
        if (Buffer.byteLength(payload) > MAX) fail();
        socket.end(payload); payload = null;
      } catch { deny(); }
    });
  }
  async stop() {
    this.#state = 'stopped'; this.#provider = null;
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    if (this.#stopping) return this.#stopping;
    this.#stopping = this.#cleanup().catch(() => fail());
    try { await this.#stopping; } catch { fail(); }
    finally { this.#stopping = null; }
  }
  async #cleanup() {
    // Retain ownership on refusal: an inert listener and its directory FD
    // remain controlled for stop() retry, never disowned or hidden by unref.
    const server = this.#server; const directory = this.#directory;
    const eligible = stat => sameInode(stat, this.#root) && stat.isDirectory()
      && stat.uid === this.#options.uid && stat.uid === process.getuid() && stat.uid > 0;
    if (directory) {
      const current = await directory.stat(); const pathname = await binding(this.#options);
      if (!eligible(current) || !eligible(pathname) || (current.mode & 0o777) !== 0o700) fail();
      const admittedMode = current.mode & 0o777;
      if (server?.listening) {
        // libuv unlinks by PATH on close. Temporarily deny that unlink only
        // after current handle AND pathname ownership/mode admission.
        await directory.chmod(0o500);
        try {
          const handle = await directory.stat(); const path = await lstat(this.#options.root);
          if (!eligible(handle) || !eligible(path) || (handle.mode & 0o777) !== 0o500
            || (path.mode & 0o777) !== 0o500) fail();
          await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        } finally {
          // Restore only while both captured FD and CURRENT pathname still
          // bind our eligible object in our temporary mode; otherwise retry
          // requires the caller to repair its own path and permissions.
          const retained = await directory.stat(); const path = await lstat(this.#options.root);
          if (!eligible(retained) || !eligible(path) || (retained.mode & 0o777) !== 0o500
            || (path.mode & 0o777) !== 0o500) fail();
          await directory.chmod(admittedMode);
        }
      }
      const after = await binding(this.#options);
      if (!eligible(after)) fail();
      try {
        const socket = await lstat(this.#options.endpoint);
        if (sameInode(socket, this.#inode) && socket.isSocket() && socket.uid === this.#options.uid
          && (socket.mode & 0o777) === 0o600) await unlink(this.#options.endpoint);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await directory.close(); this.#directory = null;
    } else if (server?.listening) fail();
    this.#server = null; this.#inode = null; this.#root = null;
  }
}
export async function requestCredentials(options) {
  let socket;
  try {
    const before = await binding(options, true);
    return await new Promise((yes, no) => {
      let chunks = []; let bytes = 0; let done = false;
      const reject = () => { if (done) return; done = true; chunks = []; socket.destroy(); no(new Error('R05 credential IPC refused.')); };
      socket = net.createConnection({ path: options.endpoint, allowHalfOpen: true });
      socket.setTimeout(2000, reject);
      socket.on('error', reject);
      socket.on('connect', async () => {
        try {
          const after = await binding(options, true);
          if (!sameInode(before.stat, after.stat) || !sameInode(before.directory, after.directory)) fail();
          socket.end(JSON.stringify({ run_id: options.run_id }));
        } catch { reject(); }
      });
      socket.on('data', chunk => { if ((bytes += chunk.length) > MAX) reject(); else chunks.push(chunk); });
      socket.on('end', () => {
        try {
          if (done) return;
          const response = JSON.parse(Buffer.concat(chunks).toString('utf8')); chunks = [];
          if (!exact(response, 'run_id records') || response.run_id !== options.run_id) fail();
          const value = records(response.records); done = true; socket.destroy(); yes(value);
        } catch { reject(); }
      });
      socket.on('close', () => { if (!done) reject(); });
    });
  } catch { socket?.destroy(); fail(); }
}
