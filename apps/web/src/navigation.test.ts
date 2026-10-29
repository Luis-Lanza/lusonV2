import { describe, expect, it } from 'vitest';
import { navigationHash, readNavigation, writeNavigation } from './navigation';

describe('T6 private navigation and existing transfer paths', () => {
  it.each([['administration', '#/administracion'], ['password', '#/mi-contrasena'], ['inventory', '#/inventario']] as const)('roundtrips %s without private data in the URL', (section, hash) => {
    writeNavigation({ section }); expect(window.location.hash).toBe(hash); expect(readNavigation()).toEqual({ section });
  });
  it('preserves list/detail navigation and malformed-path refusal', () => {
    expect(navigationHash({ section: 'transfers', id: null })).toBe('#/transferencias');
    writeNavigation({ section: 'transfers', id: '9007199254740993' });
    expect(readNavigation()).toEqual({ section: 'transfers', id: '9007199254740993' });
    window.history.replaceState(null, '', '/#/transferencias/not-an-id');
    expect(readNavigation()).toEqual({ section: 'inventory' });
  });
});
