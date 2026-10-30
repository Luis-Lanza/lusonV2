const paths = {
  inventory: 'M3 3h18v5H3z M5 8v13h14V8 M9 12h6',
  transfer: 'M3 7h17m-4-4 4 4-4 4 M21 17H4m4-4-4 4 4 4',
  logout: 'M10 3H4v18h6 M9 12h12m-5-5 5 5-5 5',
  administration: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M22 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75',
  password: 'M7 11V7a5 5 0 0 1 10 0v4 M5 11h14v10H5z M12 15v2',
  search: 'M21 21l-6-6 M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
  info: 'M12 11v6 M12 7h.01 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12 M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  arrow: 'M4 12h16m-6-6 6 6-6 6',
  plus: 'M12 4v16 M4 12h16',
  warehouse: 'M3 21V7l9-4 9 4v14 M7 21V11h10v10 M10 15h4v6',
};
export function Icon({ name }: { name: keyof typeof paths }) {
  return <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={paths[name]} /></svg>;
}
export function Brand() {
  return <div className="brand"><span className="logo">L</span><div><strong>Luson</strong><small>Control de Baterías</small></div></div>;
}
