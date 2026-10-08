// Source-only selected projections. CLI templates are NOT engine-verified.
import { types } from 'node:util';
import { volumeFingerprint } from './r05-driver.mjs';
const refuse = () => { throw new Error('R05 selected metadata refused.'); };
const check = v => { if (!v) refuse(); };
const hex = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const positive = v => Number.isSafeInteger(v) && v > 0;
const VOLUME = '{"Name":{{json .Name}},"Driver":{{json .Driver}},"CreatedAt":{{json .CreatedAt}},"Options":{{json .Options}},"Scope":{{json .Scope}},"Labels":{{json .Labels}}}';
const IMAGE = '{"Id":{{json .Id}},"ConfiguredUser":{{json .Config.User}}}';
function own(v) {
  check(v && typeof v === 'object' && !types.isProxy(v) && Object.getPrototypeOf(v) === Object.prototype);
  const ds = Object.getOwnPropertyDescriptors(v);
  check(Reflect.ownKeys(ds).every(k => typeof k === 'string' && ds[k].enumerable && 'value' in ds[k]));
  return ds;
}
function keys(v, expected) {
  const ds = own(v); check(Object.keys(ds).sort().join(' ') === expected.split(' ').sort().join(' ')); return ds;
}
function copy(input) {
  let nodes = 0, bytes = 0; const active = new Set();
  function visit(v, depth) {
    check(depth <= 16 && ++nodes <= 1024);
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'number') { check(Number.isSafeInteger(v) && !Object.is(v, -0)); return v; }
    if (typeof v === 'string') { bytes += Buffer.byteLength(v); check(v.length <= 4096 && bytes <= 32768); return v; }
    check(!active.has(v)); const ds = own(v), names = Object.keys(ds); check(names.length <= 128);
    const result = {}; active.add(v);
    for (const k of names) {
      bytes += k.length;
      check(bytes <= 32768 && /^[\x20-\x7e]{1,128}$/.test(k) && !['__proto__', 'constructor', 'prototype'].includes(k));
      result[k] = visit(ds[k].value, depth+1);
    }
    active.delete(v); return result;
  }
  return visit(input, 0);
}
function freeze(v) {
  if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v;
}
export function createR05SelectedMetadataReader(input) {
  try {
    const ds = keys(input, 'project volumeName images execute');
    const config = copy({ project: ds.project.value, volumeName: ds.volumeName.value, images: ds.images.value });
    check(/^luson-r05-[a-f0-9]{16,32}$/.test(config.project) && config.volumeName === config.project+'-data');
    keys(config.images, 'app db'); check(Object.values(config.images).every(hex));
    const execute = ds.execute.value; check(typeof execute === 'function' && !types.isProxy(execute));
    let busy = false;
    return Object.freeze({ read: async input => {
      check(!busy); busy = true;
      try {
        const q = copy(input); check(q.kind === 'volume' || q.kind === 'image');
        keys(q, q.kind === 'volume' ? 'kind project frame name' : 'kind project frame id role');
        check(q.project === config.project); keys(q.frame, 'mode attempt sequence request');
        check(['active', 'lifecycle'].includes(q.frame.mode) && [q.frame.attempt, q.frame.sequence, q.frame.request].every(positive));
        let argv;
        if (q.kind === 'volume') {
          check(q.name === config.volumeName); argv = ['volume', 'inspect', '--format', VOLUME, '--', config.volumeName];
        } else {
          check(['app', 'db'].includes(q.role) && hex(q.id) && q.id === config.images[q.role]);
          argv = ['image', 'inspect', '--format', IMAGE, '--', 'sha256:'+q.id];
        }
        // The trusted capability MUST enforce these bounds before buffering and
        // settle only after execution/cancellation ends. No adapter timeout race.
        const result = await execute(freeze({ argv, timeout_ms: 5000, max_stdout_bytes: 32768, max_stderr_bytes: 0 }));
        const response = keys(result, 'exitCode stdout');
        const stdout = response.stdout.value;
        check(response.exitCode.value === 0 && typeof stdout === 'string' && Buffer.byteLength(stdout) <= 32768);
        const value = copy(JSON.parse(stdout));
        if (q.kind === 'volume') {
          check(value.Name === config.volumeName); volumeFingerprint(value); // Full native metadata, no label filtering.
        } else {
          keys(value, 'Id ConfiguredUser'); check(value.Id === 'sha256:'+q.id && typeof value.ConfiguredUser === 'string');
        }
        return freeze({ frame: q.frame, value });
      } catch { refuse(); } finally { busy = false; }
    } });
  } catch { refuse(); }
}
