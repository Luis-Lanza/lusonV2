// Selected-data consistency only: this does not authenticate native origin or filesystem identity.
import { types } from 'node:util';

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const refuse = () => { throw new Error('R05 native stat refused.'); };

export function projectR05NativeStat(raw) {
  if (raw === null || typeof raw !== 'object' || types.isProxy(raw) || Array.isArray(raw)) refuse();
  const selected = {};
  for (const name of ['dev', 'ino', 'uid', 'mode']) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, name);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'bigint') refuse();
    selected[name] = descriptor.value;
  }
  const { dev, ino, uid, mode } = selected;
  if (dev < 1n || dev > MAX_SAFE || ino < 1n || ino > MAX_SAFE
    || uid < 0n || uid > MAX_SAFE || mode < 0n || mode > 0o177777n) refuse();
  const typeBits = mode & 0o170000n;
  if (typeBits !== 0o100000n && typeBits !== 0o040000n) refuse();
  return Object.freeze({
    device: Number(dev),
    inode: Number(ino),
    uid: Number(uid),
    mode: Number(mode & 0o7777n),
    type: typeBits === 0o100000n ? 'file' : 'directory',
    symlink: false,
  });
}
