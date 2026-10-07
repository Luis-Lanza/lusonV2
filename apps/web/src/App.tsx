import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Brand, Icon } from './icons';
import { groupItems } from './model';
import type { Item } from './model';
import { useInventory } from './useInventory';
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
function Navigation({ mobile = false, pending, disabled, onInventory, onPending }: {
  mobile?: boolean; pending: boolean; disabled: boolean; onInventory: () => void; onPending: () => void;
}) {
  return <nav className={mobile ? 'bottom-nav' : 'side-nav'} aria-label={mobile ? 'Navegación móvil' : 'Navegación principal'}>
    <a href="#inventario" aria-current={!pending ? 'page' : undefined} aria-disabled={disabled} onClick={event => { event.preventDefault(); if (!disabled) onInventory(); }}><Icon name="inventory" /><span>Inventario</span></a>
    <button type="button" disabled={disabled} aria-current={pending ? 'page' : undefined} onClick={onPending}><Icon name="transfer" /><span>Transferencias</span></button>
  </nav>;
}
function InventoryView({ state, recovery }: { state: Controller; recovery: ReturnType<typeof createTransferRecovery> }) {
  if (!state.session?.authenticated) return null;
  const { identity } = state.session;
  const { metadata, query, data } = state;
  const warehouse = identity.location.id === 1;
  const [creationRequested, setCreation] = useState(false);
  const ownerTag = transferViewOwner(state.getTransferAuthority());
  const [creationOwner, setCreationOwner] = useState<string | null>(null);
  const creation = creationRequested && creationOwner === ownerTag && ownerTag !== null;
  const [pane, setPane] = useState<{ ownerTag: string; initialDetail?: { ownerTag: string; id: string } } | null>(null);
  const pending = ownerTag !== null && pane?.ownerTag === ownerTag;
  function navigate(toPending: boolean) {
    const latest = transferViewOwner(state.getTransferAuthority());
    if (!latest || latest !== ownerTag || creation || recovery.getCurrent(state.getTransferAuthority)?.phase === 'inFlight') return;
    setPane(toPending ? { ownerTag: latest } : null);
  }
  function openCreatedDetail(id: string, expectedOwner: string) {
    const latest = transferViewOwner(state.getTransferAuthority());
    if (!latest || latest !== expectedOwner || latest !== ownerTag || recovery.getCurrent(state.getTransferAuthority)?.phase === 'inFlight') return;
    setCreation(false);
    setPane({ ownerTag: latest, initialDetail: { ownerTag: latest, id } });
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
  const navigation = { pending, disabled: navDisabled, onInventory: () => navigate(false), onPending: () => navigate(true) };
  return <div className={'app-shell' + (warehouse ? ' warehouse' : '')}>
    <aside className="sidebar" hidden={mobile}><div><Brand /><Navigation {...navigation} /></div><div className="sidebar-footer"><div className="identity"><strong>{identity.username}</strong><small className="assigned-location">{identity.location.name}</small></div><button className="logout" type="button" disabled={state.authBusy} onClick={() => void state.logout()}><Icon name="logout" />Cerrar sesión</button></div></aside>
    <header className="app-header" hidden={mobile}><strong>Luson Inventario</strong><span><Icon name="warehouse" />Ubicación asignada: <b>{identity.location.name}</b></span></header>
    <header className="mobile-header" hidden={!mobile}><div><Brand /><button type="button" aria-label="Cerrar sesión" disabled={state.authBusy} onClick={() => void state.logout()}><Icon name="logout" /></button></div><div className="mobile-identity"><span><Icon name="warehouse" />{identity.location.name}</span><span>{identity.username}</span></div></header>
    <main id="inventario" className="inventory-main">
      {pending && pane ? <TransferPending key={pane.ownerTag} controller={state} ownerTag={pane.ownerTag} initialDetail={pane.initialDetail} onInventory={() => navigate(false)} />
        : creation && !warehouse && metadata ? <TransferCreation controller={state} metadata={metadata} recovery={recovery} onBack={() => setCreation(false)} onDetail={openCreatedDetail} /> : <>
      {recoverable && <section className="creation-recovery" aria-label="Recuperación de solicitud"><p>{recoverable.phase === 'ready' ? 'Tenés una revisión preparada, todavía no enviada.' : 'Tenés un intento pendiente de confirmación.'}</p>
        <button type="button" disabled={!metadata || recoverable.phase === 'inFlight'} onClick={() => {
          const latest = transferViewOwner(state.getTransferAuthority());
          if (latest && recovery.getCurrent(state.getTransferAuthority)) { setCreationOwner(latest); setCreation(true); }
        }}>{recoverable.phase === 'ready' ? 'Retomar revisión' : 'Retomar misma solicitud'}</button>
        <p>Recargar o cerrar la pestaña pierde esta recuperación en memoria.</p></section>}
      <section className="inventory-heading">
        <div className="title-row"><div><h1>Inventario</h1><p>Consulta de existencias y disponibilidad en almacén y red de sucursales.</p></div><button className="primary transfer-cta" type="button" disabled={warehouse || state.authBusy || !metadata} onClick={() => {
          const authority = state.getTransferAuthority();
          const latest = transferViewOwner(authority);
          if (latest && authority.session?.authenticated && [2, 3].includes(authority.session.identity.location.id)) { setCreationOwner(latest); setCreation(true); }
        }}><Icon name={warehouse ? 'transfer' : 'plus'} /><span className="desktop-cta">Nueva transferencia</span><span className="mobile-cta">Crear envío</span></button></div>
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
  return state.session?.authenticated ? <InventoryView state={state} recovery={recovery} /> : <Login state={state} />;
}
