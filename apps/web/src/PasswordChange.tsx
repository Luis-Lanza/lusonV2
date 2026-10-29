import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { PrivateController } from './useInventory';
import { validPassword } from './passwordModel';
import './password.css';

export default function PasswordChange({ controller, owner, forced = false, onBack }: {
  controller: PrivateController; owner: string; forced?: boolean; onBack?: () => void;
}) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const lifetime = useRef(new AbortController());
  useEffect(() => {
    const request = lifetime.current;
    return () => { request.abort(); };
  }, []);
  function clear() { setCurrent(''); setNext(''); setConfirm(''); setVisible(false); }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending.current || lifetime.current.signal.aborted) return;
    if (controller.privateOwner('password') !== owner) { clear(); setError('La sesión cambió. Cerrá esta pantalla.'); return; }
    if (!validPassword(current) || !validPassword(next) || next === current) {
      setError('Usá contraseñas diferentes de 12 a 128 bytes UTF-8, sin NUL.'); return;
    }
    if (next !== confirm) { setError('Las contraseñas no coinciden.'); return; }
    pending.current = true; setBusy(true); setError('');
    const submittedCurrent = current; const submittedNext = next;
    clear();
    try { await controller.changePassword(owner, submittedCurrent, submittedNext, lifetime.current.signal); }
    catch (failure) {
      if (!lifetime.current.signal.aborted && controller.privateOwner('password') === owner) {
        const message = failure instanceof Error ? failure.message : '';
        setError(message.startsWith('La contraseña') || message.startsWith('Solicitud') || message.startsWith('No tenés')
          || message.startsWith('Demasiados') || message.startsWith('Servicio') || message.startsWith('Respuesta')
          ? message : 'No se pudo confirmar el cambio. No se reintentó automáticamente.');
      }
    } finally {
      pending.current = false;
      if (!lifetime.current.signal.aborted && controller.privateOwner('password') === owner) setBusy(false);
    }
  }
  return <section className="password-change" aria-labelledby="password-change-title">
    <h1 id="password-change-title">{forced ? 'Creá tu contraseña personal' : 'Cambiar mi contraseña'}</h1>
    <p>{forced ? 'Ingresaste con una contraseña temporal. Cambiala antes de acceder al sistema.' : 'Para cambiarla necesitás conocer la actual.'}</p>
    <p>De 12 a 128 bytes UTF-8, sin NUL. Los espacios forman parte de la contraseña. El cambio cierra todas tus sesiones.</p>
    <form onSubmit={event => void submit(event)} aria-busy={busy}>
      <label>Contraseña actual<input type={visible ? 'text' : 'password'} autoComplete="current-password" required value={current} disabled={busy} onChange={event => setCurrent(event.target.value)} /></label>
      <label>Nueva contraseña<input type={visible ? 'text' : 'password'} autoComplete="new-password" required value={next} disabled={busy} onChange={event => setNext(event.target.value)} /></label>
      <label>Confirmar nueva contraseña<input type={visible ? 'text' : 'password'} autoComplete="new-password" required value={confirm} disabled={busy} onChange={event => setConfirm(event.target.value)} /></label>
      <button type="button" aria-pressed={visible} disabled={busy} onClick={() => { if (controller.privateOwner('password') !== owner) { clear(); return; } setVisible(value => !value); }}>{visible ? 'Ocultar contraseñas' : 'Mostrar contraseñas'}</button>
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status">Cambiando contraseña…</p>}
      <div className="password-actions">{onBack && <button type="button" onClick={() => { clear(); onBack(); }}>Volver</button>}<button className="primary" disabled={busy}>Guardar contraseña</button></div>
    </form>
    <p>Si perdiste el acceso, pedile al administrador una contraseña temporal. La cuenta de almacén se recupera únicamente desde el servidor; no hay recuperación pública ni por correo.</p>
  </section>;
}
