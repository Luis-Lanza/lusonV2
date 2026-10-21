import { readNavigation, writeNavigation, type NavigationRoute } from './navigation';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Brand, Icon } from './icons';
import { groupItems } from './model';
import type { Item } from './model';
import { useInventory } from './useInventory';
import { useTransfers } from './useTransfers';
import TransferCreation from './TransferCreation';
import TransferPending, { transferViewOwner } from './TransferPending';
import { createTransferRecovery } from './transferRecovery';

type Controller = ReturnType<typeof useInventory>;
function Login({ state }: { state: Controller }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false);
  const userInput = useRef<HTMLInputElement>(null);
  useEffect(() => { if (state.focusLogin) userInput.current?.focus(); }, [state.focusLogin]);
  function submit(event: FormEvent) {
    event.preventDefault();
    if (state.authBusy) return;
    const submitted = password;
    setPassword(''); setVisible(false);
    void state.login(username, submitted);
  }
  return <div className="login-page">
    <header className="login-header"><Brand /><span className="internal"><i />Sistema Interno</span></header>
    <main className="login-main">
      <section className="login-card" aria-labelledby="login-title">
        <div className="login-intro"><span className="logo">L</span><h1 id="login-title">Iniciar sesión</h1><p>Acceso para personal autorizado</p></div>
        <form onSubmit={submit} aria-busy={state.authBusy}>
          <label htmlFor="username">Usuario</label>
          <input ref={userInput} id="username" name="username" autoComplete="username" placeholder="Ingresá tu usuario" required value={username} onChange={e => setUsername(e.target.value)} />
          <label htmlFor="password">Contraseña</label>
          <div className="password-field"><input id="password" name="password" type={visible ? 'text' : 'password'} autoComplete="current-password" placeholder="Ingresá tu contraseña" required value={password} onChange={e => setPassword(e.target.value)} />
            <button type="button" className="eye" aria-label={visible ? 'Ocultar contraseña' : 'Mostrar contraseña'} aria-pressed={visible} onClick={() => setVisible(v => !v)}><Icon name="eye" /></button></div>
          <div className="login-notice"><Icon name="info" /><p>Tu cuenta tiene una ubicación asignada según el perfil operativo registrado.</p></div>
          {state.formError && <p className="message" role="alert">{state.formError}</p>}
          {state.authBusy && <p className="message" role="status">Verificando sesión…</p>}
          {!state.session && !state.authBusy && <button type="button" className="refresh" onClick={() => void state.retrySession()}>Reintentar conexión</button>}
          <button className="primary login-submit" type="submit" disabled={state.authBusy || !state.session}>Iniciar sesión<Icon name="arrow" /></button>
        </form>
      </section>
    </main>
    <footer className="login-footer"><span>Luson Baterías • Plataforma Operativa de Inventario y Transferencias</span><span>Uso interno restringido</span></footer>
  </div>;
}
function Available({ item }: { item: Item }) {
  return <span className={item.available === 0n ? 'available zero' : 'available'}>{item.available.toString()}{item.available === 0n && <small className="badge">Sin disponible</small>}</span>;
}
function Cards({ items }: { items: Item[] }) {
  return <div className="cards">{groupItems(items).map(group => {
    const first = group[0];
    return <article className="product-card" key={first.catalog_entry_id} data-catalog-entry-id={first.catalog_entry_id}>
      <header><h2><i />{first.brand} · {first.model} · {first.capacity_ah} Ah</h2><small className="badge">{group.length} {group.length === 1 ? 'variante' : 'variantes'}</small></header>
      <div className="variants">{group.map(item => <div className="variant" key={item.variant_id} data-variant-id={item.variant_id}>
        <div className="variant-top"><div className="polarity-label"><b className="polarity">{item.polarity}</b><strong>Polaridad {item.polarity === 'L' ? 'Izquierda' : 'Derecha'}</strong></div><div className="quantity"><small>Disponibles</small><Available item={item} /></div></div>
        <div className="variant-bottom"><span>Existencias: <b>{item.existing.toString()}</b></span><span>Reservadas: <b>{item.reserved.toString()}</b></span></div>
      </div>)}</div>
    </article>;
  })}</div>;
}
function Pager({ state }: { state: Controller }) {
  const { data, query } = state;
  const total = data?.total_variants ?? 0;
  const first = data?.items.length ? (data.page - 1) * data.page_size + 1 : 0;
  const last = data?.items.length ? first + data.items.length - 1 : 0;
  return <footer className="pager">
    <span className="range" aria-live="polite">{data ? <>Mostrando <strong>{first}–{last}</strong> de <strong>{total}</strong> variantes</> : state.loading ? 'Consultando variantes…' : 'Sin resultados cargados.'}</span>
    <div className="page-controls"><label htmlFor="page-size">Filas por página</label><select id="page-size" value={query.size} disabled={state.authBusy} onChange={e => state.change({ size: Number(e.target.value) })}>{[10, 25, 50].map(n => <option key={n} value={n}>{n}</option>)}</select>
      <button type="button" aria-label="Página anterior" disabled={!data || query.page <= 1 || state.authBusy} onClick={() => state.change({ page: query.page - 1 }, true)}>‹<span>Anterior</span></button>
      <span className="current-page" aria-current="page">{query.page}</span>
      <button type="button" aria-label="Página siguiente" disabled={!data || query.page * query.size >= total || query.page >= 1000000 || state.authBusy} onClick={() => state.change({ page: query.page + 1 }, true)}><span>Siguiente</span>›</button>
    </div>
  </footer>;
}
function Navigation({ mobile = false, transfers, disabled, actionCount, countUnavailable, onInventory, onPending }: {
  mobile?: boolean; transfers: boolean; disabled: boolean; actionCount: string | null; countUnavailable: boolean;
  onInventory: () => void; onPending: () => void;
}) {
  const statusID = mobile ? 'mobile-transfer-count' : 'desktop-transfer-count';
  const countStatus = actionCount !== null ? `Acciones requeridas: ${actionCount}`
    : countUnavailable ? 'Contador de acciones no disponible.' : 'Consultando acciones requeridas…';
  return <nav className={mobile ? 'bottom-nav' : 'side-nav'} aria-label={mobile ? 'Navegación móvil' : 'Navegación principal'}>
    <a href="#inventario" aria-current={!transfers ? 'page' : undefined} aria-disabled={disabled} onClick={event => { event.preventDefault(); if (!disabled) onInventory(); }}><Icon name="inventory" /><span>Inventario</span></a>
    <button type="button" disabled={disabled} aria-current={transfers ? 'page' : undefined} aria-describedby={statusID} onClick={onPending}><Icon name="transfer" /><span>Transferencias</span>
      <span className={'transfer-action-badge' + (actionCount === null ? ' unknown' : actionCount === '0' ? ' zero' : '')} aria-hidden="true">{actionCount ?? (countUnavailable ? '—' : '…')}</span>
    </button>
    <span id={statusID} className="sr-only" role="status">{countStatus}</span>
  </nav>;
}
function InventoryView({ state, recovery }: { state: Controller; recovery: ReturnType<typeof createTransferRecovery> }) {
  if (!state.session?.authenticated) return null;
  const { identity } = state.session;
  const { metadata, query, data } = state;
  const warehouse = identity.location.id === 1;
  const [creationRequested, setCreation] = useState(false);
  const ownerTag = transferViewOwner(state.getTransferAuthority());
  // Independent from Pending's lane: overlapping reads and differing snapshots are intentional.
  const shellTransfers = useTransfers({ controller: state, countsEnabled: ownerTag !== null });
  const counts = shellTransfers.counts;
  const countUnavailable = ownerTag !== null && !!shellTransfers.countsError;
  const actionCount = ownerTag !== null && counts && !shellTransfers.countsBusy && !countUnavailable
    ? counts.action_count.toString() : null;
  const [creationOwner, setCreationOwner] = useState<string | null>(null);
  const creation = creationRequested && creationOwner === ownerTag && ownerTag !== null;
  const [route, setRoute] = useState<NavigationRoute>(readNavigation);
  const routeOwner = useRef(ownerTag);
  function changeRoute(next: NavigationRoute) {
    writeNavigation(next); setRoute(next);
  }
  useEffect(() => {
    // An identity change must not carry private navigation into another session.
    if (routeOwner.current !== null && routeOwner.current !== ownerTag) {
      const next = { section: 'inventory' } as const;
      writeNavigation(next, true); setRoute(next);
    }
    routeOwner.current = ownerTag;
  }, [ownerTag]);
  useEffect(() => {
    const restore = () => {
      const latest = transferViewOwner(state.getTransferAuthority());
      if (!ownerTag || latest !== ownerTag || creation || recovery.getCurrent(state.getTransferAuthority)?.phase === 'inFlight') {
        writeNavigation(route, true); return;
      }
      setRoute(readNavigation());
    };
    window.addEventListener('popstate', restore);
    window.addEventListener('hashchange', restore);
    return () => {
      window.removeEventListener('popstate', restore);
      window.removeEventListener('hashchange', restore);
    };
  }, [ownerTag, creation, route, recovery, state.getTransferAuthority]);
  const pending = ownerTag !== null && route.section === 'transfers';
  const transfers = pending || creation;
  const creationAvailable = !state.authBusy && !!metadata && !!ownerTag
    && recovery.getCurrent(state.getTransferAuthority)?.phase !== 'inFlight';
  function openCreation() {
    const authority = state.getTransferAuthority();
    const latest = transferViewOwner(authority);
    if (!creationAvailable || creation || !latest || latest !== ownerTag || !authority.session?.authenticated
      || ![1, 2, 3].includes(authority.session.identity.location.id)
      || recovery.getCurrent(state.getTransferAuthority)?.phase === 'inFlight') return;
    setCreationOwner(latest); setCreation(true);
  }
  function returnToTransfers() {
    const latest = transferViewOwner(state.getTransferAuthority());
    if (!latest || latest !== ownerTag || latest !== creationOwner
      || recovery.getCurrent(state.getTransferAuthority)?.phase === 'inFlight') return;
    setCreation(false); changeRoute({ section: 'transfers', id: null });
  }
  function navigate(toPending: boolean) {
    const latest = transferViewOwner(state.getTransferAuthority());
    if (!latest || latest !== ownerTag || creation || recovery.getCurrent(state.getTransferAuthority)?.phase === 'inFlight') return;
    changeRoute(toPending ? { section: 'transfers', id: null } : { section: 'inventory' });
  }
  function openCreatedDetail(id: string, expectedOwner: string) {
    const latest = transferViewOwner(state.getTransferAuthority());
    if (!latest || latest !== expectedOwner || latest !== ownerTag || recovery.getCurrent(state.getTransferAuthority)?.phase === 'inFlight') return;
    setCreation(false);
    changeRoute({ section: 'transfers', id });
  }
  const [narrow, setNarrow] = useState(() => window.matchMedia?.('(max-width: 767px)').matches ?? false);
  useEffect(() => {
    const media = window.matchMedia?.('(max-width: 767px)');
    if (!media) return;
    const update = () => setNarrow(media.matches);
    update(); media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const mobile = warehouse && narrow;
  const selected = metadata?.locations.find(l => l.id === query.location);
  const recoverable = recovery.getCurrent(state.getTransferAuthority);
  const navDisabled = !ownerTag || creation || recoverable?.phase === 'inFlight';
  const navigation = { transfers, disabled: navDisabled, actionCount, countUnavailable, onInventory: () => navigate(false), onPending: () => navigate(true) };
  return <div className={'app-shell' + (warehouse ? ' warehouse' : '')}>
    <aside className="sidebar" hidden={mobile}><div><Brand />{!mobile && <Navigation {...navigation} />}</div><div className="sidebar-footer"><div className="identity"><strong>{identity.username}</strong><small className="assigned-location">{identity.location.name}</small></div><button className="logout" type="button" disabled={state.authBusy} onClick={() => void state.logout()}><Icon name="logout" />Cerrar sesión</button></div></aside>
    <header className="app-header" hidden={mobile}><strong>Luson {transfers ? 'Transferencias' : 'Inventario'}</strong><span><Icon name="warehouse" />Ubicación asignada: <b>{identity.location.name}</b></span></header>
    <header className="mobile-header" hidden={!mobile}><div><Brand /><button type="button" aria-label="Cerrar sesión" disabled={state.authBusy} onClick={() => void state.logout()}><Icon name="logout" /></button></div><div className="mobile-identity"><span><Icon name="warehouse" />{identity.location.name}</span><span>{identity.username}</span></div></header>
    <main id={transfers ? 'transferencias' : 'inventario'} className="inventory-main">
      {creation && metadata ? <TransferCreation controller={state} metadata={metadata} recovery={recovery} onBack={returnToTransfers} onDetail={openCreatedDetail} />
        : pending && ownerTag && route.section === 'transfers' ? <TransferPending key={ownerTag} controller={state} ownerTag={ownerTag} routedDetail={route.id} onRouteDetail={id => changeRoute({ section: 'transfers', id })} onInventory={() => navigate(false)} creationAvailable={creationAvailable} onCreate={openCreation} /> : <>
      {recoverable && <section className="creation-recovery" aria-label="Recuperación de solicitud"><p>{recoverable.phase === 'ready' ? 'Tenés una revisión preparada, todavía no enviada.' : 'Tenés un intento pendiente de confirmación.'}</p>
        <button type="button" disabled={!creationAvailable} onClick={openCreation}>{recoverable.phase === 'ready' ? 'Retomar revisión' : 'Retomar misma solicitud'}</button>
        <p>Recargar o cerrar la pestaña pierde esta recuperación en memoria.</p></section>}
      <section className="inventory-heading">
        <div className="title-row"><div><h1>Inventario</h1><p>Consulta de existencias y disponibilidad en almacén y red de sucursales.</p></div><button className="primary transfer-cta" type="button" disabled={!creationAvailable} onClick={openCreation}><Icon name={warehouse ? 'transfer' : 'plus'} /><span className="desktop-cta">Nueva transferencia</span><span className="mobile-cta">Crear envío</span></button></div>
        <div className="location-tabs" hidden={mobile} role="group" aria-label="Vista de stock"><span>Vista de stock:</span>{metadata?.locations.map(l => <button type="button" key={l.id} aria-pressed={query.location === l.id} disabled={state.authBusy} onClick={() => state.change({ location: l.id })}>{l.name}<small>{l.id === identity.location.id ? 'Mi ubicación · Consulta' : 'Solo consulta'}</small></button>)}</div>
      </section>
      <section className="mobile-location" hidden={!mobile}>
        <label htmlFor="consult-location">Consultar ubicación</label><select id="consult-location" value={query.location} disabled={!metadata || state.authBusy} onChange={e => state.change({ location: Number(e.target.value) })}>{metadata?.locations.map(l => <option key={l.id} value={l.id}>{l.name} ({l.id === identity.location.id ? 'Mi ubicación · Consulta' : 'Solo consulta'})</option>)}</select>
        <strong>Estado: {selected?.id === identity.location.id ? 'Mi ubicación · Solo consulta' : 'Solo consulta'}</strong><p>La consulta a otras ubicaciones es de solo lectura y no reasigna la cuenta activa.</p>
      </section>
      <section className="filters" aria-label="Filtros de inventario"><div className="search-field"><Icon name="search" /><label className="sr-only" htmlFor="search">Buscar marca o modelo</label><input id="search" type="search" placeholder="Buscar marca o modelo…" value={query.search} disabled={state.authBusy} onChange={e => state.change({ search: e.target.value })} aria-describedby="results-message" /></div>
        <div className="filter-pair"><div><label htmlFor="brand">Marca</label><select id="brand" value={query.brand} disabled={!metadata || state.authBusy} onChange={e => state.change({ brand: e.target.value })}><option value="">Todas las marcas</option>{metadata?.brands.map(b => <option key={b} value={b}>{b}</option>)}</select></div>
          <div><label htmlFor="polarity">Polaridad</label><select id="polarity" value={query.polarity} disabled={state.authBusy} onChange={e => state.change({ polarity: e.target.value as '' | 'L' | 'R' })}><option value="">Todas</option><option value="L">Izquierda [L]</option><option value="R">Derecha [R]</option></select></div></div>
      </section>
      <div className="formula"><Icon name="info" /><p><strong>Regla de cálculo:</strong> Disponible = existencias − reservadas. Las unidades reservadas permanecen físicamente en almacén hasta confirmación de salida.</p></div>
      <section className="results" aria-label="Resultados de inventario" aria-busy={state.loading}>
        <div id="results-message" aria-live="polite">{state.loading && <p role="status" className="message">Cargando inventario…</p>}{state.resultsError && <div className="message" role="alert">{state.resultsError}<button type="button" onClick={state.retryInventory} disabled={state.authBusy}>Reintentar</button></div>}{data?.items.length === 0 && <p role="status" className="message">No hay variantes para esta consulta.</p>}</div>
        {data && data.items.length > 0 && <>{!mobile && <div className="table-scroll"><table><caption className="sr-only">Inventario de {data.location.name}</caption><thead><tr>{['Marca', 'Modelo', 'Capacidad (Ah)', 'Polaridad', 'Existencias', 'Reservadas', 'Disponibles'].map(h => <th key={h} scope="col">{h}</th>)}</tr></thead><tbody>{data.items.map(item => <tr key={item.variant_id} data-variant-id={item.variant_id}><td>{item.brand}</td><td>{item.model}</td><td>{item.capacity_ah} Ah</td><td><span className="polarity">{item.polarity}</span></td><td>{item.existing.toString()}</td><td>{item.reserved.toString()}</td><td><Available item={item} /></td></tr>)}</tbody></table></div>}{mobile && <Cards items={data.items} />}</>}
        <Pager state={state} />
      </section>
      </>}
    </main>
    {mobile && <Navigation mobile {...navigation} />}
  </div>;
}
export default function App() {
  // Above every authentication return: independent A/B slots survive child unmounts.
  const [recovery] = useState(createTransferRecovery);
  const state = useInventory();
  const wasAuthenticated = useRef(false);
  useEffect(() => {
    const authenticated = state.session?.authenticated === true;
    if (wasAuthenticated.current && !authenticated) writeNavigation({ section: 'inventory' }, true);
    wasAuthenticated.current = authenticated;
  }, [state.session?.authenticated]);
  return state.session?.authenticated ? <InventoryView state={state} recovery={recovery} /> : <Login state={state} />;
}
