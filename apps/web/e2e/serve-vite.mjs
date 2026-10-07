import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const web = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.env.LUSON_E2E_WEB_PORT);
const target = new URL(process.env.LUSON_E2E_API_URL);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || target.hostname !== '127.0.0.1' || target.protocol !== 'http:' || !target.port) throw new Error('Loopback fixture ports required.');
const server = await createServer({
  root: web, configFile: resolve(web, 'vite.config.ts'),
  cacheDir: resolve(process.env.LUSON_E2E_TEMP, 'vite-cache'),
  server: { host: '127.0.0.1', port, strictPort: true, proxy: { '/api': { target: target.origin, changeOrigin: false } } },
});
await server.listen();
let closing = false;
async function stop() { if (closing) return; closing = true; await server.close(); process.exit(0); }
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
