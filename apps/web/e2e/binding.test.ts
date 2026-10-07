import { describe, expect, it } from 'vitest';
import { LABELS, NETWORK_ID, NETWORK_NAME, validateBinding, manifestPath, parseDescriptor } from './binding.mjs';

const env = { LUSON_TEST_NETWORK: NETWORK_NAME, LUSON_TEST_NETWORK_MANIFEST: '/root/manifest.json' };
const manifest = { schema: 'luson.test-network/v1', status: 'active', name: NETWORK_NAME, id: NETWORK_ID, labels: LABELS };
const inspection = { Name: NETWORK_NAME, Id: NETWORK_ID, Labels: LABELS, Containers: {} };
describe('L04 binding fail-closed before fixture creation (in-memory inspection)', () => {
  it('resolves relative descriptor from canonical root, retains absolute path', () => {
    expect(manifestPath('/canonical/repo', 'odd/evidence/manifest.json')).toBe('/canonical/repo/odd/evidence/manifest.json');
    expect(manifestPath('/canonical/repo', '/private/manifest.json')).toBe('/private/manifest.json');
    expect(() => manifestPath('/canonical/repo', '')).toThrow();
  });
  it('parses valid descriptor and rejects malformed JSON without resource access', () => {
    expect(parseDescriptor(JSON.stringify(manifest))).toEqual(manifest);
    expect(() => parseDescriptor('{')).toThrow();
  });
  it('accepts only exact active parent-owned binding', () => expect(validateBinding(env, manifest, inspection)).toBe(true));
  it.each([
    [{}, manifest, inspection], [{ ...env, LUSON_TEST_NETWORK_MANIFEST: '' }, manifest, inspection],
    [env, { ...manifest, status: 'retired' }, inspection], [env, { ...manifest, schema: 'other' }, inspection],
    [env, { ...manifest, id: 'short' }, inspection], [env, { ...manifest, name: 'luson-l03-test' }, inspection],
    [env, { ...manifest, labels: { ...LABELS, extra: 'no' } }, inspection],
    [env, manifest, { ...inspection, Id: '0'.repeat(64) }],
    [env, manifest, { ...inspection, Labels: { ...LABELS, 'luson.task': 'L03' } }],
    [env, null, inspection], [env, manifest, null],
    [env, manifest, { ...inspection, Containers: { foreign: {} } }],
  ])('rejects invalid binding %#', (e, m, i) => expect(() => validateBinding(e, m, i)).toThrow());
});
