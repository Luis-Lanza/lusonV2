import { transferDetailPath } from './transferModel';

export type NavigationRoute = { section: 'inventory' } | { section: 'administration'; screen?: 'branches' } | { section: 'password' } | { section: 'stock' } | { section: 'adjustments' } | { section: 'catalog'; screen?: 'prices' | 'batteries' | 'other-products' } | { section: 'sales' } | { section: 'salesHistory' } | { section: 'purchases' } | { section: 'cash' } | { section: 'metrics' } | { section: 'settlements' } | { section: 'settlementDecision' } | { section: 'transfers'; id: string | null };

export function readNavigation(): NavigationRoute {
  const hash = window.location.hash;
  if (hash === '#/administracion') return { section: 'administration' };
  // The branches tab of the panel is its own screen: the settlement sends the warehouse there
  // when the branch has no commission to settle with.
  if (hash === '#/administracion/sucursales') return { section: 'administration', screen: 'branches' };
  if (hash === '#/mi-contrasena') return { section: 'password' };
  if (hash === '#/ingresos') return { section: 'stock' };
  if (hash === '#/ajustes') return { section: 'adjustments' };
  // The catalogue holds three screens of the same section: its price matrix, which
  // stays at the section's own hash, the battery catalogue and the other products.
  if (hash === '#/catalogo/baterias') return { section: 'catalog', screen: 'batteries' };
  if (hash === '#/catalogo/otros-productos') return { section: 'catalog', screen: 'other-products' };
  if (hash === '#/catalogo') return { section: 'catalog' };
  // The branch counter and its history: two screens of their own, reached from the sidebar.
  if (hash === '#/ventas') return { section: 'sales' };
  if (hash === '#/ventas/historial') return { section: 'salesHistory' };
  // Compras is a section of its own: used batteries and scrap, never part of a sale.
  if (hash === '#/compras') return { section: 'purchases' };
  // Caja is the operational drawer of the branch: its own section, never a query of the settlement.
  if (hash === '#/caja') return { section: 'cash' };
  // The metrics of the branch are cut by settlement period, so they are a section of their own and
  // never a query of the settlement screen.
  if (hash === '#/metricas') return { section: 'metrics' };
  // The two settlement screens live in the hash like every other section: the warehouse
  // workspace and the branch decision, each behind its own identity gate.
  if (hash === '#/rendiciones') return { section: 'settlements' };
  if (hash === '#/rendicion') return { section: 'settlementDecision' };
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
  if (route.section === 'administration') return route.screen === 'branches' ? '#/administracion/sucursales' : '#/administracion';
  if (route.section === 'password') return '#/mi-contrasena';
  if (route.section === 'inventory') return '#/inventario';
  if (route.section === 'stock') return '#/ingresos';
  if (route.section === 'adjustments') return '#/ajustes';
  if (route.section === 'catalog') {
    return route.screen === 'batteries' ? '#/catalogo/baterias'
      : route.screen === 'other-products' ? '#/catalogo/otros-productos' : '#/catalogo';
  }
  if (route.section === 'sales') return '#/ventas';
  if (route.section === 'salesHistory') return '#/ventas/historial';
  if (route.section === 'purchases') return '#/compras';
  if (route.section === 'cash') return '#/caja';
  if (route.section === 'metrics') return '#/metricas';
  if (route.section === 'settlements') return '#/rendiciones';
  if (route.section === 'settlementDecision') return '#/rendicion';
  return '#/transferencias' + (route.id === null ? '' : '/' + route.id);
}

export function writeNavigation(route: NavigationRoute, replace = false) {
  const hash = navigationHash(route);
  if (window.location.hash !== hash) window.history[replace ? 'replaceState' : 'pushState'](null, '', hash);
}
