// Pure L05 validation. No Docker calls, defaults, descriptor writes or secrets.
export const PROJECT = 'luson-l05-test-6100cb8ee3ed';
export const NETWORK_ID = '5b00841fad4161beb8195c6defde38b7ef8038aa7d70fd314c47f01b93cb8fb1';
export const NETWORK_NAME = PROJECT + '-net';
export const VOLUME_NAME = PROJECT + '-pgdata';
export const CREATED_AT = '2026-10-06T22:01:56-04:00';
export const LABELS = Object.freeze({
  'luson.feature': 'login-inventory', 'luson.task': 'L05',
  'luson.owner': 'parent-session-luson-v2', 'luson.lifecycle': 'ephemeral-test-only',
});
const fullID = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const labelsMatch = (value, exact = true) => value && (!exact || Object.keys(value).length === 4)
  && Object.entries(LABELS).every(([key, expected]) => value[key] === expected);
const volumeMatch = value => value && value.Name === VOLUME_NAME && value.Driver === 'local'
  && value.CreatedAt === CREATED_AT && value.Options === null && value.Scope === 'local' && labelsMatch(value.Labels);

export function validateBinding(env, manifest, network, volume, owned = []) {
  const fail = () => { throw new Error('L05 binding refused before effects.'); };
  if (!env || typeof env.LUSON_TEST_COMPOSE_MANIFEST !== 'string' || !env.LUSON_TEST_COMPOSE_MANIFEST.trim()) fail();
  if (!manifest || manifest.schema !== 'luson.compose-test/v1' || manifest.status !== 'active' || manifest.project !== PROJECT
    || !Array.isArray(manifest.services) || manifest.services.length !== 2 || [...manifest.services].sort().join(',') !== 'app,db'
    || manifest.app_uid !== 1000 || manifest.app_gid !== 1000 || !labelsMatch(manifest.labels)
    || manifest.network?.id !== NETWORK_ID || manifest.network?.name !== NETWORK_NAME || !labelsMatch(manifest.network?.labels)
    || !volumeMatch(manifest.volume)) fail();
  if (!network || network.Id !== NETWORK_ID || network.Name !== NETWORK_NAME || !labelsMatch(network.Labels)
    || !network.Containers || typeof network.Containers !== 'object' || !volumeMatch(volume)
    || !Array.isArray(owned) || owned.some(id => !fullID(id)) || Object.keys(network.Containers).some(id => !owned.includes(id))) fail();
  return true;
}
export function validateContainer(id, service, container, configHash, detached = false) {
  const fail = () => { throw new Error('L05 container refused before effects.'); };
  const labels = container?.Config?.Labels;
  const networks = container?.NetworkSettings?.Networks;
  if (!fullID(id) || !['app', 'db'].includes(service) || container?.Id !== id || !labelsMatch(labels, false)
    || labels['com.docker.compose.project'] !== PROJECT || labels['com.docker.compose.service'] !== service
    || !fullID(labels['com.docker.compose.config-hash']) || (configHash && labels['com.docker.compose.config-hash'] !== configHash)
    || labels['com.docker.compose.container-number'] !== '1' || labels['com.docker.compose.oneoff'] !== 'False'
    || container.Name !== '/' + PROJECT + '-' + service + '-1'
    || !networks || Object.keys(networks).length !== 1
    || (networks[NETWORK_NAME]?.NetworkID !== NETWORK_ID && !(detached && ['created','exited'].includes(container.State?.Status)
      && container.HostConfig?.NetworkMode === NETWORK_NAME && networks[NETWORK_NAME]?.NetworkID === ''))) fail();
  return true;
}
