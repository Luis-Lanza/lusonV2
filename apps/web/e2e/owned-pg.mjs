import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { LABELS } from './binding.mjs';

const execute = promisify(execFile);
export async function inspectOwned(id, name) {
  if (!/^[a-f0-9]{64}$/.test(id) || !/^luson-l04-pg-[a-f0-9]{24}$/.test(name)) throw new Error('Fixture ownership refused.');
  const { stdout } = await execute('docker', ['inspect', '--type=container', '--format', '{{json .Id}}\n{{json .Name}}\n{{json .Config.Labels}}', id], { timeout: 10000, maxBuffer: 65536 });
  const [actualID, actualName, labels] = stdout.trim().split('\n').map(line => JSON.parse(line));
  if (actualID !== id || actualName !== '/' + name || !labels || Object.keys(labels).length !== 4
    || !Object.entries(LABELS).every(([key, value]) => labels[key] === value)) throw new Error('Fixture ownership refused.');
}
export async function fixtureSQL(fixture, sql) {
  await inspectOwned(fixture.id, fixture.name);
  // TEST container-local trust connection. No DSN/password in argv or output.
  const { stdout } = await execute('docker', ['exec', fixture.id, 'psql', '-U', 'luson_l04', '-d', 'luson_l04', '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql], { timeout: 10000, maxBuffer: 65536 });
  return stdout.trim();
}
