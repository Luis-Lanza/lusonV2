import { parse, LosslessNumber } from 'lossless-json';
import type { Location } from './model';

export interface Account {
  id: string; username: string; display_name: string; location_id: number;
  enabled: boolean; must_change_password: boolean;
}
function invalid(): never { throw new Error('Respuesta inválida del servidor.'); }
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof LosslessNumber) return invalid();
  const result = value as Record<string, unknown>;
  if (Object.keys(result).length !== keys.length || keys.some(key => !Object.hasOwn(result, key))) return invalid();
  return result;
}
function decode(raw: string): unknown { try { return parse(raw, null, { onDuplicateKey: invalid }); } catch { return invalid(); } }
function text(value: unknown, blank = false): string {
  if (typeof value !== 'string' || (!blank && !value) || !value.isWellFormed() || value.includes('\0')) return invalid();
  return value;
}
function locationID(value: unknown): number {
  if (!(value instanceof LosslessNumber) || !/^[1-9]\d*$/.test(value.toString())) return invalid();
  const id = BigInt(value.toString());
  if (id > 32767n) return invalid();
  return Number(id);
}
function account(value: unknown): Account {
  const item = object(value, ['id', 'username', 'display_name', 'location_id', 'enabled', 'must_change_password']);
  const id = text(item.id);
  if (!/^[1-9]\d*$/.test(id) || BigInt(id) > 9223372036854775807n
    || typeof item.enabled !== 'boolean' || typeof item.must_change_password !== 'boolean') return invalid();
  const location = locationID(item.location_id);
  if ((id === '1') !== (location === 1)) return invalid();
  return { id, username: text(item.username), display_name: text(item.display_name, true), location_id: location,
    enabled: item.enabled, must_change_password: item.must_change_password };
}
function branch(value: unknown): Location {
  const item = object(value, ['id', 'name']);
  return { id: locationID(item.id), name: text(item.name) };
}
export function parseAccount(raw: string): Account { return account(decode(raw)); }
export function parseBranch(raw: string): Location { return branch(decode(raw)); }
export function parseAccounts(raw: string): Account[] {
  const value = decode(raw);
  if (!Array.isArray(value)) return invalid();
  const items = value.map(account);
  if (items.some((item, index) => index > 0 && BigInt(items[index - 1].id) >= BigInt(item.id))) return invalid();
  return items;
}
export function parseBranches(raw: string): Location[] {
  const value = decode(raw);
  if (!Array.isArray(value)) return invalid();
  const items = value.map(branch);
  if (items.some((item, index) => index > 0 && items[index - 1].id >= item.id)) return invalid();
  return items;
}
export function validName(value: string): boolean {
  return !!value.trim() && value.isWellFormed() && !value.includes('\0') && new TextEncoder().encode(value).length <= 128;
}
export function accountPatch(before: Account, name: string, location: number, enabled: boolean): Record<string, string | number | boolean> {
  const patch: Record<string, string | number | boolean> = {};
  if (name !== before.display_name) { if (!validName(name)) throw new Error('Ingresá un nombre válido de hasta 128 bytes UTF-8.'); patch.display_name = name; }
  if (before.id !== '1') {
    if (location !== before.location_id) patch.location_id = location;
    if (enabled !== before.enabled) patch.enabled = enabled;
  }
  return patch;
}
