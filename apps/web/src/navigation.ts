import { transferDetailPath } from './transferModel';

export type NavigationRoute = { section: 'inventory' } | { section: 'administration' } | { section: 'password' } | { section: 'transfers'; id: string | null };

export function readNavigation(): NavigationRoute {
  const hash = window.location.hash;
  if (hash === '#/administracion') return { section: 'administration' };
  if (hash === '#/mi-contrasena') return { section: 'password' };
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
  return '#/transferencias' + (route.id === null ? '' : '/' + route.id);
}

export function writeNavigation(route: NavigationRoute, replace = false) {
  const hash = navigationHash(route);
  if (window.location.hash !== hash) window.history[replace ? 'replaceState' : 'pushState'](null, '', hash);
}
