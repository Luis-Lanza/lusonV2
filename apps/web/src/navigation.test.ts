import { describe, expect, it } from 'vitest';
import { navigationHash, readNavigation, writeNavigation } from './navigation';

describe('T6 private navigation and existing transfer paths', () => {
  it.each([['administration', '#/administracion'], ['password', '#/mi-contrasena'], ['inventory', '#/inventario'], ['stock', '#/ingresos'], ['catalog', '#/catalogo'], ['sales', '#/ventas'], ['salesHistory', '#/ventas/historial'], ['purchases', '#/compras']] as const)('roundtrips %s without private data in the URL', (section, hash) => {
    writeNavigation({ section }); expect(window.location.hash).toBe(hash); expect(readNavigation()).toEqual({ section });
  });
  it('routes the warehouse adjustment history without private data in the URL', () => {
    writeNavigation({ section: 'adjustments' });
    expect(window.location.hash).toBe('#/ajustes');
    expect(readNavigation()).toEqual({ section: 'adjustments' });
    window.history.replaceState(null, '', '/#/ajustes');
    expect(readNavigation()).toEqual({ section: 'adjustments' });
  });
  it('keeps the counter and its history apart, so neither swallows the other', () => {
    expect(navigationHash({ section: 'sales' })).toBe('#/ventas');
    expect(navigationHash({ section: 'salesHistory' })).toBe('#/ventas/historial');
    window.history.replaceState(null, '', '/#/ventas');
    expect(readNavigation()).toEqual({ section: 'sales' });
    window.history.replaceState(null, '', '/#/ventas/historial');
    expect(readNavigation()).toEqual({ section: 'salesHistory' });
    // A path below the history is not a screen of this application.
    window.history.replaceState(null, '', '/#/ventas/historial/7');
    expect(readNavigation()).toEqual({ section: 'inventory' });
  });
  it('keeps purchases on its own hash apart from the counter and its history', () => {
    expect(navigationHash({ section: 'purchases' })).toBe('#/compras');
    window.history.replaceState(null, '', '/#/compras');
    expect(readNavigation()).toEqual({ section: 'purchases' });
    window.history.replaceState(null, '', '/#/compras/7');
    expect(readNavigation()).toEqual({ section: 'inventory' });
  });
  it('preserves list/detail navigation and malformed-path refusal', () => {
    expect(navigationHash({ section: 'transfers', id: null })).toBe('#/transferencias');
    writeNavigation({ section: 'transfers', id: '9007199254740993' });
    expect(readNavigation()).toEqual({ section: 'transfers', id: '9007199254740993' });
    window.history.replaceState(null, '', '/#/transferencias/not-an-id');
    expect(readNavigation()).toEqual({ section: 'inventory' });
  });
});
