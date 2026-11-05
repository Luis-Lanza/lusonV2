import { transferDetailPath } from './transferModel';

export type NavigationRoute = { section: 'inventory' } | { section: 'administration' } | { section: 'password' } | { section: 'stock' } | { section: 'adjustments' } | { section: 'catalog'; screen?: 'prices' | 'batteries' } | { section: 'sales' } | { section: 'salesHistory' } | { section: 'transfers'; id: string | null };

export function readNavigation(): NavigationRoute {
  const hash = window.location.hash;
  if (hash === '#/administracion') return { section: 'administration' };
  if (hash === '#/mi-contrasena') return { section: 'password' };
  if (hash === '#/ingresos') return { section: 'stock' };
  if (hash === '#/ajustes') return { section: 'adjustments' };
  // The catalogue holds two screens of the same section: its price matrix, which
  // stays at the section's own hash, and the battery catalogue beside it.
  if (hash === '#/catalogo/baterias') return { section: 'catalog', screen: 'batteries' };
  if (hash === '#/catalogo') return { section: 'catalog' };
  // The branch counter and its history: two screens of their own, reached from the sidebar.
  if (hash === '#/ventas') return { section: 'sales' };
  if (hash === '#/ventas/historial') return { section: 'salesHistory' };
  if (hash === '#/transferencias') return { section: 'transfers', id: null };
  const match = /^#\/transferencias\/([^/]+)$/.exec(hash);
  if (match) {
    try {
      transferDetailPath(match[1]);
      return { section: 'transfers', id: match[1] };
    } catch { /* Invalid routes never become API requests. */ }
  }
  return { section: 'inventory' };
}

export function navigationHash(route: NavigationRoute): string {
  if (route.section === 'administration') return '#/administracion';
  if (route.section === 'password') return '#/mi-contrasena';
  if (route.section === 'inventory') return '#/inventario';
  if (route.section === 'stock') return '#/ingresos';
  if (route.section === 'adjustments') return '#/ajustes';
  if (route.section === 'catalog') return route.screen === 'batteries' ? '#/catalogo/baterias' : '#/catalogo';
  if (route.section === 'sales') return '#/ventas';
  if (route.section === 'salesHistory') return '#/ventas/historial';
  return '#/transferencias' + (route.id === null ? '' : '/' + route.id);
}

export function writeNavigation(route: NavigationRoute, replace = false) {
  const hash = navigationHash(route);
  if (window.location.hash !== hash) window.history[replace ? 'replaceState' : 'pushState'](null, '', hash);
}
