// Concrete Node SDK composition only; the frozen readers own all selection and lifetime policy.
import { lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { types } from 'node:util';
import { createR05SelectedFilesystemReader } from './r05-selected-filesystem.mjs';
import { createR05SelectedProcessReader } from './r05-selected-process.mjs';

// Capture actual imported references at module initialization, never caller providers.
const nativeLstat = lstat, nativeOpen = open, nativeSpawn = spawn;
const nativeFlags = Object.freeze({
  O_RDONLY: constants.O_RDONLY,
  O_NOFOLLOW: constants.O_NOFOLLOW,
  O_NONBLOCK: constants.O_NONBLOCK,
  O_DIRECTORY: constants.O_DIRECTORY,
});
const refuse = () => { throw new Error('R05 selected Node refused.'); };
function data(value, names) {
  if (!value || typeof value !== 'object' || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) refuse();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (!Reflect.ownKeys(descriptors).every(key => typeof key === 'string'
    && descriptors[key].enumerable && 'value' in descriptors[key])
    || Object.keys(descriptors).sort().join(' ') !== names.split(' ').sort().join(' ')) refuse();
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}

export function createR05SelectedNodeReaders(input) {
  try {
    // Check records before any spreads/property reads; nested data is validated and
    // detached by the existing reader constructors before it can be used for I/O.
    const args = data(input, 'approval process');
    const approval = data(args.approval, 'project root uid manifest dsn sources');
    const binding = data(args.process, 'project volumeName images binary cwd env');
    if (approval.project !== binding.project) refuse();
    const filesystem = createR05SelectedFilesystemReader({ approval, native: {
      flags: nativeFlags,
      lstatBigInt: path => nativeLstat(path, { bigint: true }),
      openReadonly: (path, flags) => nativeOpen(path, flags),
      fstatBigInt: handle => handle.stat({ bigint: true }),
      readInto: (handle, buffer, offset, length, position) => handle.read(buffer, offset, length, position),
      closeHandle: async handle => { await handle.close(); },
    } });
    const metadata = createR05SelectedProcessReader({ ...binding, spawn: nativeSpawn });
    return Object.freeze({ filesystem, metadata });
  } catch { refuse(); }
}
