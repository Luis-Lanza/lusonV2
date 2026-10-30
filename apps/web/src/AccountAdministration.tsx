import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Location } from './model';
import type { PrivateController } from './useInventory';
import { accountPatch, parseAccount, parseAccounts, parseBranch, parseBranches, validName, type Account } from './administrationModel';
import { generateTemporaryPassword, validPassword } from './passwordModel';
import './administration.css';

function publicError(failure: unknown): string {
  const message = failure instanceof Error ? failure.message : '';
  return /^(Solicitud|No tenés|Debés|El usuario|La cuenta|La sucursal|Demasiados|Servicio|Respuesta inválida|Ingresá)/.test(message)
    ? message : 'No se pudo confirmar la operación. Consultá los datos antes de volver a enviarla; no se reintentó automáticamente.';
}
function TemporaryPassword({ value, onChange, disabled, permitted }: { value: string; onChange: (value: string) => void; disabled: boolean; permitted: () => boolean }) {
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState('');
  return <div className="admin-secret"><label>Contraseña temporal<input type={visible ? 'text' : 'password'} autoComplete="new-password" required value={value} disabled={disabled} onChange={event => onChange(event.target.value)} /></label>
    <div className="admin-actions"><button type="button" disabled={disabled} aria-pressed={visible} onClick={() => { if (!permitted()) { onChange(''); setVisible(false); return; } setVisible(previous => !previous); }}>{visible ? 'Ocultar temporal' : 'Mostrar temporal'}</button>
      <button type="button" disabled={disabled} onClick={() => { if (!permitted()) { onChange(''); return; } try { onChange(generateTemporaryPassword()); setError(''); } catch { setError('No se pudo generar una contraseña segura. Ingresala de forma privada.'); } }}>Generar temporal</button></div>{error && <p role="alert">{error}</p>}</div>;
}
function Handoff({ secret, onClose, permitted }: { secret: string; onClose: () => void; permitted: () => boolean }) {
  const [visible, setVisible] = useState(false);
  const [copied, setCopied] = useState('');
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);
  return <section className="admin-panel" aria-label="Entrega privada de contraseña">
    <h2>Contraseña temporal confirmada</h2><p>Entregala por un canal privado. La persona debe cambiarla al ingresar. Al cerrar se elimina de esta pantalla; no se puede recuperar la anterior.</p>
    <label>Temporal para entrega<input readOnly type={visible ? 'text' : 'password'} value={secret} autoComplete="off" /></label>
    <div className="admin-actions"><button type="button" aria-pressed={visible} onClick={() => { if (!permitted()) { onClose(); return; } setVisible(previous => !previous); }}>{visible ? 'Ocultar entrega' : 'Mostrar entrega'}</button>
      <button type="button" onClick={() => {
        if (!permitted()) { onClose(); return; }
        if (!navigator.clipboard?.writeText) { setCopied('Copiado no disponible. Podés mostrarla y copiarla manualmente.'); return; }
        void navigator.clipboard.writeText(secret).then(() => { if (live.current && permitted()) setCopied('Copiada. Borrá el portapapeles después de entregarla.'); }, () => { if (live.current && permitted()) setCopied('No se pudo copiar.'); });
      }}>Copiar temporal</button><button type="button" onClick={onClose}>Cerrar entrega privada</button></div><p role="status">{copied}</p>
  </section>;
}
function AccountEditor({ account, branches, controller, owner, onClose, onSaved, onHandoff, onDeleted }: {
  account: Account | null; branches: Location[]; controller: PrivateController; owner: string;
  onClose: () => void; onSaved: () => void; onHandoff: (secret: string) => void; onDeleted: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [name, setName] = useState(account?.display_name ?? '');
  const [username, setUsername] = useState('');
  const [location, setLocation] = useState(account?.location_id ?? 0);
  const [enabled, setEnabled] = useState(account?.enabled ?? true);
  const [temporary, setTemporary] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const lifetime = useRef(new AbortController());
  useEffect(() => { const signal = lifetime.current; return () => { signal.abort(); }; }, []);
  const protectedAccount = account?.id === '1';
  const current = () => !lifetime.current.signal.aborted && controller.privateOwner('admin') === owner;
  async function submit(event: FormEvent, reset = false) {
    event.preventDefault();
    if (pending.current) return;
    if (!current()) { setTemporary(''); return; }
    let patch: Record<string, string | number | boolean> = {};
    try {
      if (reset || !account) {
        if (!validPassword(temporary)) throw new Error('Ingresá una temporal de 12 a 128 bytes UTF-8, sin NUL.');
      }
      if (!reset) {
        if (account) patch = accountPatch(account, name, location, enabled);
        else if (!validName(name) || !/^[A-Za-z0-9_.-]{3,64}$/.test(username)) throw new Error('Ingresá un nombre válido y un usuario de 3 a 64 letras ASCII, números, guion, punto o guion bajo.');
        if (!protectedAccount && (!branches.some(branch => branch.id === location && branch.id !== 1))) throw new Error('Ingresá una sucursal válida.');
        if (account && Object.keys(patch).length === 0) { setError('No hay cambios para guardar.'); return; }
      }
    } catch (failure) { setError(publicError(failure)); return; }
    pending.current = true; setBusy(true); setError('');
    const submittedTemporary = temporary;
    setTemporary('');
    try {
      if (reset && account && !protectedAccount) {
        await controller.privateRequest(owner, 'admin', `/api/admin/accounts/${account.id}/password`, lifetime.current.signal, 'POST', { temporary_password: submittedTemporary }, 204);
      } else if (account) {
        await controller.privateRequest(owner, 'admin', `/api/admin/accounts/${account.id}`, lifetime.current.signal, 'PATCH', patch, 204);
      } else {
        const raw = await controller.privateRequest(owner, 'admin', '/api/admin/accounts', lifetime.current.signal, 'POST',
          { username, display_name: name, location_id: location, temporary_password: submittedTemporary }, 201);
        parseAccount(raw);
      }
      if (!current()) return;
      onSaved();
      if (reset || !account) onHandoff(submittedTemporary); else onClose();
    } catch (failure) { if (current()) setError(publicError(failure)); }
    finally { pending.current = false; if (current()) setBusy(false); }
  }
  async function deleteAccount() {
    if (pending.current || !current() || !account || protectedAccount || !confirmDelete) return;
    pending.current = true; setBusy(true); setError(''); setTemporary('');
    try {
      await controller.privateRequest(owner, 'admin', `/api/admin/accounts/${account.id}`, lifetime.current.signal, 'DELETE', undefined, 204);
      if (current()) onDeleted();
    } catch (failure) { if (current()) { setConfirmDelete(false); setError(publicError(failure)); } }
    finally { pending.current = false; if (current()) setBusy(false); }
  }
  return <section className="admin-panel admin-editor" aria-label={account ? 'Gestión de cuenta' : 'Creación de cuenta'}>
    <div className="admin-row"><h2>{account ? `Gestionar ${account.username}` : 'Crear usuario de sucursal'}</h2><button type="button" onClick={() => { setTemporary(''); onClose(); }}>{account ? 'Cerrar gestión' : 'Cancelar creación'}</button></div>
    <form onSubmit={event => void submit(event)} aria-busy={busy}>
      <label>Nombre completo<input value={name} autoComplete="off" disabled={busy} onChange={event => setName(event.target.value)} /></label>
      {!account && <label>Usuario<input required value={username} autoComplete="off" disabled={busy} onChange={event => setUsername(event.target.value)} /></label>}
      {!protectedAccount && <><label>Sucursal asignada<select required value={location} disabled={busy} onChange={event => setLocation(Number(event.target.value))}><option value={0}>Seleccionar sucursal</option>{branches.filter(branch => branch.id !== 1).map(branch => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label>
        {account && <label>Acceso<select value={enabled ? 'enabled' : 'disabled'} disabled={busy} onChange={event => setEnabled(event.target.value === 'enabled')}><option value="enabled">Activo</option><option value="disabled">Desactivado</option></select></label>}
        <p>Operador: todas las operaciones de su sucursal. No otorga acceso administrativo.</p></>}
      {protectedAccount && <p>Administrador único protegido. Solo podés editar su nombre. Usá Mi contraseña para tu propio cambio.</p>}
      {!account && <TemporaryPassword value={temporary} onChange={setTemporary} disabled={busy} permitted={current} />}
      <button className="primary" disabled={busy}>{account ? 'Guardar cambios' : 'Crear usuario'}</button>
    </form>
    {account && !protectedAccount && <form onSubmit={event => void submit(event, true)} aria-busy={busy}><h3>Restablecer contraseña</h3><p>No podés consultar la anterior. El restablecimiento cierra las sesiones y exige un cambio al ingresar; no reactiva una cuenta desactivada.</p><TemporaryPassword value={temporary} onChange={setTemporary} disabled={busy} permitted={current} /><button disabled={busy}>Restablecer contraseña</button></form>}
    {account && !protectedAccount && <div className="admin-actions">
      {confirmDelete ? <><p>Eliminar a {account.username} cierra su acceso y lo oculta del directorio. Se conserva su historial; no es una desactivación temporal.</p><button type="button" disabled={busy} onClick={() => void deleteAccount()}>Confirmar eliminación</button><button type="button" disabled={busy} onClick={() => setConfirmDelete(false)}>Cancelar</button></>
        : <button type="button" disabled={busy} onClick={() => { if (current()) { setTemporary(''); setConfirmDelete(true); } }}>Eliminar usuario</button>}
    </div>}
    {busy && <p role="status">Guardando…</p>}{error && <p role="alert">{error}</p>}
  </section>;
}
export default function AccountAdministration({ controller, owner }: { controller: PrivateController; owner: string }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [branches, setBranches] = useState<Location[]>([]);
  const [tab, setTab] = useState<'accounts' | 'branches'>('accounts');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [branchFilter, setBranchFilter] = useState(0);
  const [editor, setEditor] = useState<Account | 'create' | null>(null);
  const [handoff, setHandoff] = useState('');
  const [branchName, setBranchName] = useState('');
  const [deleteBranch, setDeleteBranch] = useState<Location | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const pending = useRef(false);
  const lifetime = useRef(new AbortController());
  useEffect(() => { const signal = lifetime.current; return () => { signal.abort(); }; }, []);
  const current = () => !lifetime.current.signal.aborted && controller.privateOwner('admin') === owner;
  useEffect(() => {
    const read = new AbortController(); setBusy(true); setError(''); setAccounts([]); setBranches([]);
    void Promise.all([
      controller.privateRequest(owner, 'admin', '/api/admin/accounts', read.signal).then(parseAccounts),
      controller.privateRequest(owner, 'admin', '/api/admin/branches', read.signal).then(parseBranches),
    ]).then(([users, locations]) => {
      if (read.signal.aborted || !current()) return;
      if (users.some(user => !locations.some(location => user.location_id === location.id))) throw new Error('Respuesta inválida del servidor.');
      setAccounts(users); setBranches(locations);
    }).catch(failure => { if (!read.signal.aborted && current()) setError(publicError(failure)); })
      .finally(() => { if (!read.signal.aborted && current()) setBusy(false); });
    return () => read.abort();
    // A revision is an explicit refetch, not an automatic mutation retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, revision]);
  function closePrivate() { setEditor(null); setHandoff(''); setDeleteBranch(null); }
  async function retireBranch() {
    if (pending.current || !current() || !deleteBranch || deleteBranch.id === 1) return;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    try {
      await controller.privateRequest(owner, 'admin', `/api/admin/branches/${deleteBranch.id}`, lifetime.current.signal, 'DELETE', undefined, 204);
      if (!current()) return;
      closePrivate(); setNotice('Sucursal eliminada del directorio. Se conserva su historial.');
      controller.refreshBranches(owner); setRevision(previous => previous + 1);
    } catch (failure) { if (current()) { setDeleteBranch(null); setError(publicError(failure)); } }
    finally { pending.current = false; if (current()) setBusy(false); }
  }
  async function createBranch(event: FormEvent) {
    event.preventDefault();
    if (pending.current || !current()) return;
    if (!validName(branchName)) { setError('Ingresá un nombre válido de hasta 128 bytes UTF-8.'); return; }
    pending.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const result = parseBranch(await controller.privateRequest(owner, 'admin', '/api/admin/branches', lifetime.current.signal, 'POST', { name: branchName }, 201));
      if (!current()) return;
      if (result.id === 1) throw new Error('Respuesta inválida del servidor.');
      setBranchName(''); setNotice(`Sucursal creada: ${result.name}. Stock inicial cero.`);
      controller.refreshBranches(owner); setRevision(previous => previous + 1);
    } catch (failure) { if (current()) setError(publicError(failure)); }
    finally { pending.current = false; if (current()) setBusy(false); }
  }
  if (controller.privateOwner('admin') !== owner) return null;
  const filtered = accounts.filter(account => (!search || `${account.username} ${account.display_name}`.toLocaleLowerCase('es').includes(search.toLocaleLowerCase('es')))
    && (!branchFilter || account.location_id === branchFilter) && (status === 'all' || (status === 'enabled' ? account.enabled : status === 'disabled' ? !account.enabled : account.must_change_password)));
  return <section className="account-administration" aria-labelledby="admin-title">
    <header><small>ALMACÉN / ADMINISTRACIÓN</small><h1 id="admin-title">Usuarios y sucursales</h1><p>Gestioná las cuentas personales y su sucursal asignada.</p></header>
    <div className="admin-notice"><strong>Un solo almacén, un solo administrador.</strong> Las cuentas nuevas pertenecen a sucursales. No hay registro público ni creación de almacenes.</div>
    <div className="admin-tabs" role="group" aria-label="Vistas de administración"><button aria-pressed={tab === 'accounts'} onClick={() => { closePrivate(); setTab('accounts'); }}>Usuarios</button><button aria-pressed={tab === 'branches'} onClick={() => { closePrivate(); setTab('branches'); }}>Sucursales</button></div>
    {busy && <p role="status">Consultando o guardando datos…</p>}{error && <div role="alert">{error}<button type="button" disabled={busy} onClick={() => { closePrivate(); setRevision(previous => previous + 1); }}>Actualizar directorio</button></div>}{notice && <p role="status">{notice}</p>}
    {handoff ? <Handoff secret={handoff} onClose={() => setHandoff('')} permitted={current} /> : null}
    {tab === 'accounts' ? <div className="admin-grid"><section className="admin-panel">
      <div className="admin-row"><h2>Usuarios</h2><button className="primary" disabled={busy} onClick={() => { if (!current()) return; setHandoff(''); setEditor('create'); }}>+ Crear usuario</button></div>
      <div className="admin-filters"><label>Buscar usuario<input type="search" value={search} onChange={event => setSearch(event.target.value)} /></label><label>Estado de cuenta<select value={status} onChange={event => setStatus(event.target.value)}><option value="all">Todos</option><option value="enabled">Activos</option><option value="disabled">Desactivados</option><option value="temporary">Cambio obligatorio</option></select></label><label>Filtrar sucursal<select value={branchFilter} onChange={event => setBranchFilter(Number(event.target.value))}><option value={0}>Todas</option>{branches.map(branch => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label></div>
      <div className="admin-table"><table><caption className="sr-only">Directorio de cuentas</caption><thead><tr><th>Usuario</th><th>Ubicación</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>{filtered.map(account => <tr key={account.id}><td><strong>{account.display_name || account.username}</strong><small>{account.username}</small></td><td>{branches.find(branch => branch.id === account.location_id)?.name}</td><td><span className="admin-tag">{account.id === '1' ? 'Protegido' : account.enabled ? 'Activo' : 'Desactivado'}</span>{account.must_change_password && <small>Cambio obligatorio</small>}</td><td><button type="button" disabled={busy} aria-label={`Gestionar ${account.username}`} onClick={() => { if (!current()) return; setHandoff(''); setEditor(account); }}>Gestionar</button></td></tr>)}</tbody></table></div>
      {!busy && !filtered.length && <p>No hay cuentas para estos filtros.</p>}
    </section>{editor ? <AccountEditor key={editor === 'create' ? 'create' : editor.id} account={editor === 'create' ? null : editor} branches={branches} controller={controller} owner={owner} onClose={() => setEditor(null)} onSaved={() => { setNotice('Cuenta actualizada.'); setRevision(previous => previous + 1); }} onHandoff={secret => { setEditor(null); setHandoff(secret); }} onDeleted={() => { closePrivate(); setNotice('Usuario eliminado del directorio. Se conserva su historial.'); setRevision(previous => previous + 1); }} />
      : <aside className="admin-panel"><span className="admin-tag">Acceso bajo control</span><h2>Ciclo de una cuenta</h2><ol><li>Creás el usuario y asignás su sucursal.</li><li>Entregás una contraseña temporal en privado.</li><li>La persona la cambia antes de operar.</li></ol><p>Podés reasignar, desactivar o reactivar el acceso. Cada operador tiene todas las operaciones de su sucursal.</p><p>La actividad y el último ingreso no están disponibles en este directorio.</p></aside>}</div>
      : <><section className="admin-panel"><h2>Sucursales</h2><p>El almacén único es contexto, no una sucursal asignable.</p><div className="admin-branches">{branches.map(branch => <article key={branch.id}><h3>{branch.name}</h3><p>{branch.id === 1 ? 'Almacén protegido' : `${accounts.filter(account => account.location_id === branch.id).length} cuentas asignadas`}</p>{branch.id !== 1 && <button type="button" disabled={busy} onClick={() => { if (current()) { closePrivate(); setNotice(''); setDeleteBranch(branch); } }}>Eliminar sucursal</button>}</article>)}</div>{deleteBranch && <div className="admin-actions"><p>Eliminar {deleteBranch.name} la oculta de las operaciones nuevas. Se conserva su historial. Resolvé stock, usuarios y operaciones pendientes antes de eliminarla.</p><button type="button" disabled={busy} onClick={() => void retireBranch()}>Confirmar eliminación</button><button type="button" disabled={busy} onClick={() => setDeleteBranch(null)}>Cancelar</button></div>}</section><section className="admin-panel"><h2>Crear sucursal</h2><p>Empieza con stock cero. Recibe mercadería mediante transferencias.</p><form onSubmit={event => void createBranch(event)}><label>Nombre de sucursal<input required value={branchName} disabled={busy} onChange={event => setBranchName(event.target.value)} /></label><button className="primary" disabled={busy}>Crear sucursal</button></form></section></>}
  </section>;
}
