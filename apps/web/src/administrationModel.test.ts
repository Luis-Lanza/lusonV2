import { describe, expect, it } from 'vitest';
import { accountPatch, parseAccount, parseAccounts, parseBranch, parseBranches, validName } from './administrationModel';
import { validPassword, generateTemporaryPassword } from './passwordModel';

const account = { id: '4', username: 'legacy.c', display_name: '', location_id: 4, enabled: false, must_change_password: true };
describe('T6 strict administration DTOs and mutation policy', () => {
  it('keeps canonical account strings, independent location integers and legacy blank names', () => {
    expect(parseAccount(JSON.stringify(account))).toEqual(account);
    expect(parseAccount(JSON.stringify({ ...account, id: '9007199254740993' })).id).toBe('9007199254740993');
    expect(parseBranches('[{"id":1,"name":"Almacén"},{"id":32767,"name":"Sucursal"}]')).toEqual([{ id: 1, name: 'Almacén' }, { id: 32767, name: 'Sucursal' }]);
  });
  it.each([{ id: 4 }, { id: '04' }, { id: '0' }, { id: '9223372036854775808' }, { location_id: '4' }, { location_id: 32768 }, { location_id: 1 }, { id: '1' }, { enabled: 1 }, { must_change_password: null }, { display_name: '\0' }, { role: 'admin' }, { temporary_password: 'private' }])('rejects malformed account fields %j', patch => {
    expect(() => parseAccount(JSON.stringify({ ...account, ...patch }))).toThrow('Respuesta inválida');
  });
  it.each(['{"id":4,"name":"Sucursal","kind":"warehouse"}', '{"id":4.0,"name":"Sucursal"}', '{"id":4e0,"name":"Sucursal"}', '{"id":0,"name":"Sucursal"}', '{"id":4,"name":""}'])('rejects malformed branch DTO %s', raw => {
    expect(() => parseBranch(raw)).toThrow('Respuesta inválida');
  });
  it('rejects unordered/duplicate list IDs and malformed JSON', () => {
    expect(() => parseAccounts(JSON.stringify([account, account]))).toThrow();
    expect(() => parseBranches('[{"id":2,"name":"A"},{"id":1,"name":"B"}]')).toThrow();
    expect(() => parseAccounts('{')).toThrow();
    expect(() => parseAccounts('{}')).toThrow();
  });
  it('omits unchanged legacy blank display names and protected-account fields', () => {
    expect(accountPatch(account, '', 2, true)).toEqual({ location_id: 2, enabled: true });
    expect(accountPatch(account, '', 4, false)).toEqual({});
    expect(accountPatch({ ...account, id: '1', location_id: 1 }, 'Admin', 4, false)).toEqual({ display_name: 'Admin' });
    expect(() => accountPatch(account, ' ', 4, false)).toThrow();
  });
  it('validates names by bytes without rewriting valid spaces', () => {
    expect(validName(' Nombre ')).toBe(true); expect(validName('é'.repeat(64))).toBe(true);
    expect(validName('é'.repeat(65))).toBe(false); expect(validName('  ')).toBe(false); expect(validName('name\0')).toBe(false);
  });
  it.each([['a'.repeat(11), false], ['a'.repeat(12), true], ['é'.repeat(64), true], ['é'.repeat(65), false], ['a'.repeat(128), true], ['a'.repeat(129), false], ['  spaced value  ', true], ['a\0'.repeat(12), false], ['\ud800'.repeat(12), false]])('keeps the existing UTF-8 password policy (%s)', (value, valid) => {
    expect(validPassword(String(value))).toBe(valid);
  });
  it('generates a valid private temporary value only on an explicit function call', () => {
    const first = generateTemporaryPassword();
    expect(first).toMatch(/^[A-Za-z0-9_-]{24}$/); expect(validPassword(first)).toBe(true);
  });
});
