import { resolve, isAbsolute } from 'node:path';

export function manifestPath(root, value) {
  if (typeof root !== 'string' || !isAbsolute(root) || typeof value !== 'string' || !value.trim()) throw new Error('Canonical root and explicit manifest path required.');
  return isAbsolute(value) ? value : resolve(root, value);
}
export function parseDescriptor(raw) {
  try { return JSON.parse(raw); } catch { throw new Error('Malformed L04 test-network descriptor.'); }
}

export const NETWORK_NAME = 'luson-l04-test-isolated-44fea1f86fda';
export const NETWORK_ID = '91c985a0206d0859f8ee42aa042e6817dc7aa222d9f37dcd498eb04e08a0a34a';
export const LABELS = Object.freeze({
  'luson.feature': 'login-inventory', 'luson.task': 'L04',
  'luson.owner': 'parent-session-luson-v2', 'luson.lifecycle': 'ephemeral-test-only',
});
function exactLabels(value) {
  return value && typeof value === 'object' && Object.keys(value).length === 4
    && Object.entries(LABELS).every(([key, label]) => value[key] === label);
}
export function validateBinding(env, manifest, inspection) {
  const fail = () => { throw new Error('L04 test-network binding refused before fixture creation.'); };
  if (!env || env.LUSON_TEST_NETWORK !== NETWORK_NAME || (typeof env.LUSON_TEST_NETWORK_MANIFEST !== 'string' || !env.LUSON_TEST_NETWORK_MANIFEST.trim())) fail();
  if (!manifest || manifest.schema !== 'luson.test-network/v1' || manifest.status !== 'active'
    || manifest.name !== NETWORK_NAME || manifest.id !== NETWORK_ID || !exactLabels(manifest.labels)) fail();
  if (!inspection || inspection.Name !== NETWORK_NAME || inspection.Id !== NETWORK_ID
    || !exactLabels(inspection.Labels) || !inspection.Containers || Object.keys(inspection.Containers).length !== 0) fail();
  return true;
}
