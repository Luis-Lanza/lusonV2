import { useEffect, useRef, useState } from 'react';
import type { Metadata } from './model';
import { validSearch } from './model';
import { filterSourceInventory, loadSourceInventory, SourceInventoryError } from './sourceInventory';
import { addCartItem, cartStatus, createTransferCart, refreshCart, removeCartItem, setCartQuantity, reviewCart, restoreTransferCart } from './transferCart';
import { createTransferRecovery, type RecoveryFlight, type RecoverySnapshot } from './transferRecovery';
import { TransferAPIError, type TransferCreateResult } from './transferAPI';
import type { TransferCreateInput } from './transferModel';
import TransferReview from './TransferReview';
import type { TransferCart } from './transferCart';
import { transferDirection } from './transferModel';
import type { TransferFlow } from './transferModel';
import type { SourceInventoryController, TransferAuthority, TransferController } from './useInventory';

export interface TransferCreationProps {
  controller: TransferController & SourceInventoryController;
  metadata: Metadata;
  onBack: () => void;
  onDetail?: (id: string, ownerTag: string) => void;
  loader?: typeof loadSourceInventory;
  recovery?: ReturnType<typeof createTransferRecovery>;
}
function owner(authority: TransferAuthority): string | null {
  const session = authority.session;
  if (!session?.authenticated || ![2, 3].includes(session.identity.location.id)) return null;
  return `${authority.epoch}/${session.identity.account_id}/${session.identity.location.id}`;
}
type Flight = { sequence: number; abort: AbortController; dirty: boolean };
type Held = { owner: string; flow: TransferFlow; cart: TransferCart };

export default function TransferCreation({ controller, metadata, onBack, loader = loadSourceInventory, recovery: injectedRecovery, onDetail }: TransferCreationProps) {
  const [isolatedRecovery] = useState(createTransferRecovery);
  const recovery = injectedRecovery ?? isolatedRecovery;
  const cachedFlow = () => {
    const snapshot = recovery.getCurrent(controller.getTransferAuthority);
    return snapshot ? snapshot.attempt.kind === 'send_to_warehouse' ? 'sendWarehouse'
      : snapshot.attempt.counterparty_location_id === 1 ? 'requestWarehouse' : 'requestOther' : 'requestWarehouse';
  };
  // Fence every raw private read before effects: readiness is not a saved permission.
  const authority = controller.getTransferAuthority();
  const key = owner(authority);
  const allowed = authority.ready && key !== null;
  const [flow, setFlow] = useState<TransferFlow>(cachedFlow);
  const flowRef = useRef(flow);
  const [held, setHeld] = useState<Held | null>(null);
  const heldRef = useRef(held);
  heldRef.current = held;
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState('');
  const [quantityError, setQuantityError] = useState('');
  const [quantities, setQuantities] = useState<Record<number, string>>({});
  const [filter, setFilter] = useState({ search: '', brand: '', polarity: '' as '' | 'L' | 'R' });
  const [page, setPage] = useState(1);
  const [pending, setPending] = useState<TransferFlow | 'back' | 'edit' | 'discard' | null>(null);
  const [review, setReview] = useState<{ owner: string; snapshot: RecoverySnapshot } | null>(null);
  const [outcome, setOutcome] = useState<{ owner: string; result: TransferCreateResult } | null>(null);
  const [sendError, setSendError] = useState<{ owner: string; text: string } | null>(null);
  const [sending, setSending] = useState(false);
  const sendLock = useRef<{ owner: string; token: RecoveryFlight } | null>(null);
  const reviewTrigger = useRef<HTMLElement | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const picker = useRef<HTMLSelectElement>(null);
  const mounted = useRef(false);
  const sequence = useRef(0);
  const flight = useRef<Flight | null>(null);
  const fresh = useRef(false);
  const renderOwner = useRef(key);
  if (!allowed || renderOwner.current !== key) fresh.current = false;
  renderOwner.current = key;
  const activeKey = useRef<string | null>(null);
  const draftOwner = useRef(key);
  const read = useRef<(reason: 'manual' | 'passive') => void>(() => {});

  function current() {
    const latest = controller.getTransferAuthority();
    return latest.ready && owner(latest) === key && activeKey.current === key && mounted.current ? latest : null;
  }
  function abortRead() {
    sequence.current++;
    flight.current?.abort.abort();
    flight.current = null;
  }
  read.current = reason => {
    const captured = current();
    if (!captured || !captured.session?.authenticated) return;
    const selectedFlow = flowRef.current;
    const source = transferDirection(captured.session.identity.location.id, selectedFlow).origin_location_id;
    const dirty = flight.current?.dirty ?? false;
    abortRead();
    const job: Flight = { sequence: ++sequence.current, abort: new AbortController(), dirty };
    flight.current = job;
    setBusy(true); setError('');
    const valid = () => current() !== null && flight.current === job && sequence.current === job.sequence && flowRef.current === selectedFlow;
    void loader(source, { signal: job.abort.signal, reason }).then(catalog => {
      if (!valid()) return;
      const latest = controller.getTransferAuthority();
      const previous = heldRef.current;
      const snapshot = recovery.getCurrent(controller.getTransferAuthority);
      const cart = previous?.owner === key && previous.flow === selectedFlow
        ? refreshCart(previous.cart, latest, catalog) : snapshot
          ? restoreTransferCart(latest, catalog, snapshot) : createTransferCart(latest, selectedFlow, catalog);
      const next = { owner: key!, flow: selectedFlow, cart };
      heldRef.current = next; fresh.current = true;
      setHeld(next); setStale(false);
    }).catch((failure: unknown) => {
      if (!valid()) return;
      setStale(true);
      setError('No se pudo actualizar el catálogo completo. Reintentá la consulta.');
      if (failure instanceof SourceInventoryError && failure.status === 401) void controller.settleUnauthorized(captured.epoch);
    }).finally(() => {
      if (!valid()) return;
      flight.current = null; setBusy(false);
      if (job.dirty) read.current('passive');
    });
  };
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; abortRead(); };
  }, []);
  useEffect(() => {
    abortRead(); activeKey.current = allowed ? key : null;
    if (!allowed) return;
    if (draftOwner.current !== key) {
      draftOwner.current = key;
      heldRef.current = null; setHeld(null);
      const nextFlow = cachedFlow(); flowRef.current = nextFlow; setFlow(nextFlow);
      // Old promises retain their opaque token, but cannot unlock a newer owner's job.
      sendLock.current = null; setSending(false); setReview(null); setOutcome(null); setSendError(null);
      setQuantities({}); setFilter({ search: '', brand: '', polarity: '' }); setPage(1);
    }
    setPending(null); setQuantityError('');
    read.current('manual');
    const detach = controller.subscribeSourceInventoryInvalidation(() => {
      if (!current()) return;
      if (flight.current) flight.current.dirty = true;
      else read.current('passive');
    });
    return () => { detach(); abortRead(); activeKey.current = null; };
  }, [allowed, key, controller.getTransferAuthority, controller.subscribeSourceInventoryInvalidation, loader]);
  useEffect(() => { if (pending) cancel.current?.focus(); else trigger.current?.focus(); }, [pending]);

  // Do not even inspect held.cart, error strings or row inputs outside this fence.
  if (!allowed) return <section className="transfer-creation"><p role="status">La creación requiere una sesión activa de sucursal.</p></section>;
  if (activeKey.current !== key || (held !== null && held.owner !== key)) return <section className="transfer-creation"><p role="status">Preparando catálogo de la sesión activa…</p></section>;
  const snapshot = recovery.getCurrent(controller.getTransferAuthority);
  const inFlight = snapshot?.phase === 'inFlight' || (sending && sendLock.current?.owner === key);
  const visibleReview = review?.owner === key && review.snapshot.epoch === authority.epoch ? review : null;
  const visibleOutcome = outcome?.owner === key ? outcome.result : null;
  const visible = fresh.current && held?.owner === key && held.flow === flow;
  const cart = visible ? held.cart : null;
  const assigned = authority.session?.authenticated ? authority.session.identity.location.id : 2;
  const direction = transferDirection(assigned, flow);
  const location = (id: number) => metadata.locations.find(l => l.id === id)?.name ?? 'Ubicación no disponible';
  const sourceName = location(direction.origin_location_id);
  const status = cart ? cartStatus(cart, authority) : null;
  const rows = cart ? filterSourceInventory(cart.catalog, filter) : [];
  const lastPage = Math.max(1, Math.ceil(rows.length / 25));
  const displayedPage = Math.min(page, lastPage);
  const pageRows = rows.slice((displayedPage - 1) * 25, displayedPage * 25);
  const title = flow === 'sendWarehouse' ? 'Proponer envío a Almacén' : flow === 'requestOther' ? 'Solicitar a otra sucursal' : 'Solicitar baterías';

  function guardedCart() {
    const latest = current();
    if (!latest || !fresh.current || recovery.getCurrent(controller.getTransferAuthority)?.phase === 'inFlight') return null;
    const previous = heldRef.current;
    if (!previous || previous.owner !== key || previous.flow !== flowRef.current) return null;
    return { latest, previous };
  }
  function editCart(operation: (cart: TransferCart, latest: TransferAuthority) => TransferCart) {
    const checked = guardedCart();
    if (!checked || sendLock.current?.owner === key) return false;
    const archived = recovery.getCurrent(controller.getTransferAuthority);
    if (archived?.phase === 'unknown') { requestCaution('edit'); return false; }
    try {
      const edited = operation(checked.previous.cart, checked.latest);
      if (archived && edited.attempt !== checked.previous.cart.attempt
        && !recovery.discardCurrent(controller.getTransferAuthority, archived.handle, false)) return false;
      const next = { ...checked.previous, cart: edited };
      heldRef.current = next; setHeld(next); setQuantityError(''); return true;
    } catch { setQuantityError('Ingresá una cantidad entera positiva, sin ceros iniciales y dentro del disponible (máximo int64).'); return false; }
  }
  function focusAdd(id: number) {
    const input = document.getElementById(`source-quantity-${id}`);
    if (input instanceof HTMLInputElement && !input.disabled) input.focus();
    else document.getElementById('creation-retry')?.focus();
  }
  function changeFlow(next: TransferFlow | 'back') {
    if (!current() || inFlight || sendLock.current?.owner === key) return;
    if (next === flowRef.current) return;
    if (recovery.getCurrent(controller.getTransferAuthority)) { requestCaution(next); return; }
    const previous = heldRef.current;
    if (previous?.owner === key && previous.cart.lines.length) {
      trigger.current = next === 'back' ? document.getElementById('creation-back') : picker.current;
      setPending(next); return;
    }
    applyFlow(next);
  }
  function applyFlow(next: TransferFlow | 'back') {
    if (!current()) return;
    if (next === 'back') { onBack(); return; }
    abortRead(); fresh.current = false;
    heldRef.current = null; setHeld(null); flowRef.current = next; setFlow(next);
    setPending(null); setQuantities({}); setQuantityError(''); setError(''); setStale(false);
    setFilter({ search: '', brand: '', polarity: '' }); setPage(1);
    read.current('manual'); picker.current?.focus();
  }
  function closeDialog() { if (!current() || inFlight) return; setPending(null); trigger.current?.focus(); }
  function requestCaution(action: TransferFlow | 'back' | 'edit' | 'discard') {
    if (!current() || sendLock.current?.owner === key) return;
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setReview(null); setPending(action);
  }
  function acknowledge() {
    const latest = current(); const archived = recovery.getCurrent(controller.getTransferAuthority);
    if (!latest || !pending || inFlight) return;
    if (pending === 'back' && archived) { setPending(null); onBack(); return; }
    if (archived) {
      const selected = heldRef.current;
      // Preparation must succeed before user-authorized discard, even for source changes.
      if (!fresh.current || !selected || selected.owner !== key) {
        setQuantityError('La edición requiere un catálogo completo actual. Se conserva la solicitud; podés reintentarla sin catálogo.'); return;
      }
      try {
        const restored = restoreTransferCart(latest, selected.cart.catalog, archived);
        if (!recovery.discardCurrent(controller.getTransferAuthority, archived.handle, true)) return;
        const next = { ...selected, cart: restored }; heldRef.current = next; setHeld(next);
      } catch { setQuantityError('No se pudo preparar la selección. Se conserva la solicitud para reintentar.'); return; }
    }
    const action = pending; setPending(null); setQuantityError('');
    if (action === 'edit' || action === 'discard') { trigger.current?.focus(); return; }
    applyFlow(action);
  }
  function openReview(sourceTrigger?: HTMLElement) {
    if (!current() || inFlight || sendLock.current?.owner === key) return;
    try {
      let archived = recovery.getCurrent(controller.getTransferAuthority);
      if (!archived) {
        const checked = guardedCart(); if (!checked) return;
        const reviewed = reviewCart(checked.previous.cart, checked.latest);
        recovery.capture(controller.getTransferAuthority, reviewed);
        const next = { ...checked.previous, cart: reviewed }; heldRef.current = next; setHeld(next);
        archived = recovery.getCurrent(controller.getTransferAuthority);
      }
      if (!archived) return;
      reviewTrigger.current = sourceTrigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
      setOutcome(null); setSendError(null); setReview({ owner: key!, snapshot: archived });
    } catch { setQuantityError('No se pudo preparar una revisión segura. No se envió ninguna solicitud.'); }
  }
  function closeReview() {
    if (!current() || sendLock.current?.owner === key || recovery.getCurrent(controller.getTransferAuthority)?.phase === 'inFlight') return;
    if (outcome?.owner === key) { onBack(); return; }
    setReview(null);
  }
  async function send(submit: (input: TransferCreateInput) => Promise<TransferCreateResult>) {
    if (!current() || sendLock.current?.owner === key) return;
    const archived = recovery.getCurrent(controller.getTransferAuthority);
    if (!archived || archived.phase === 'inFlight') return;
    let token: RecoveryFlight;
    try { token = recovery.begin(controller.getTransferAuthority, archived.handle); } catch { return; }
    const job = { owner: key!, token }; sendLock.current = job; setSending(true); setSendError(null);
    setReview({ owner: key!, snapshot: recovery.getCurrent(controller.getTransferAuthority)! });
    try {
      const result = await submit(archived.attempt);
      if (!current() || sendLock.current !== job || !recovery.confirmSuccess(controller.getTransferAuthority, token)) {
        recovery.markUnknown(token); return;
      }
      // Publish only actual parsed 201/200 data after exact-flight confirmation.
      setOutcome({ owner: key!, result }); setReview({ owner: key!, snapshot: archived });
      heldRef.current = null; setHeld(null); fresh.current = false;
    } catch (failure: unknown) {
      recovery.markUnknown(token);
      if (!current() || sendLock.current !== job) return;
      const code = failure instanceof TransferAPIError ? failure.code : 'invalid_response';
      const messages: Partial<Record<typeof code, string>> = {
        insufficient_stock: 'El servidor rechazó la creación por stock insuficiente. No confirmó una solicitud creada. Revisá la selección o reintentá la misma solicitud.',
        retry_conflict: 'La clave corresponde a otro contenido. No se reemplazó la solicitud. Conservá este intento y consultá al responsable.',
        forbidden: 'No tenés permiso para enviar esta solicitud. Se conserva el intento.',
        unauthenticated: 'La sesión debe validarse nuevamente. Se conserva el intento.',
        service_unavailable: 'El servicio no está disponible. Se conserva el intento para reintentar manualmente.',
      };
      setSendError({ owner: key!, text: messages[code] ?? 'No pudimos confirmar el resultado. Conservamos la misma solicitud para reintentar manualmente.' });
      const retained = recovery.getCurrent(controller.getTransferAuthority);
      if (retained) setReview({ owner: key!, snapshot: retained });
    } finally {
      if (sendLock.current === job) { sendLock.current = null; if (current()) setSending(false); }
    }
  }
  function changeFilter(next: typeof filter) {
    if (!current()) return;
    if (!validSearch(next.search) || !validSearch(next.brand)) return;
    setFilter(next); setPage(1);
  }
  return <section className="transfer-creation" aria-labelledby="creation-title">
    <p className="creation-breadcrumb">Inventario / Transferencias / {title}</p>
    <button id="creation-back" type="button" disabled={inFlight} className="creation-back" onClick={() => changeFlow('back')}>← Volver al inventario</button>
    <h1 id="creation-title">{title}</h1>
    <p>Prepará una solicitud con el stock de su origen físico. La consulta de inventario no cambia tu ubicación asignada.</p>
    {snapshot && !visibleReview && <div className="creation-recovery" role="status"><p>{snapshot.phase === 'ready' ? 'Tenés una revisión preparada, todavía no enviada.' : 'Tenés un intento pendiente de confirmación.'}</p>
      <button type="button" disabled={inFlight} onClick={event => openReview(event.currentTarget)}>{snapshot.phase === 'ready' ? 'Retomar revisión' : 'Retomar misma solicitud'}</button>
      <button type="button" disabled={inFlight} onClick={() => requestCaution('edit')}>Editar selección conservada</button>
      <p>Recargar o cerrar la pestaña pierde esta memoria.</p></div>}
    <fieldset className="creation-workspace" disabled={inFlight || !!visibleReview || !!pending}>
    <label className="creation-flow">Tipo de transferencia<select ref={picker} value={flow} onChange={e => {
      if (!current()) return;
      const value = e.target.value;
      if (value === 'requestWarehouse' || value === 'requestOther' || value === 'sendWarehouse') changeFlow(value);
    }}><option value="requestWarehouse">Solicitar a Almacén</option><option value="requestOther">Solicitar a {location(assigned === 2 ? 3 : 2)}</option><option value="sendWarehouse">Proponer envío a Almacén</option></select></label>
    <section className="creation-route" aria-label="Ruta física">
      <div><span>Origen</span><strong>{sourceName}</strong></div><b aria-hidden="true">→</b><div><span>Destino</span><strong>{location(direction.destination_location_id)}</strong></div>
      <p>Requiere aprobación de {location(direction.approver_location_id)} · No genera reserva inmediata de stock</p>
    </section>
    <div className="creation-grid">
      <section className="creation-catalog" aria-label="Catálogo de origen" aria-busy={busy}>
        <header><h2>Disponibilidad en {sourceName}</h2><p>Disponibilidad orientativa. El servidor validará todas las cantidades al enviar; las páginas no son una foto atómica del stock.</p>
          <div className="creation-filters"><label>Buscar marca o modelo<input type="search" value={filter.search} onChange={e => changeFilter({ ...filter, search: e.target.value })} /></label>
            <label>Marca<select value={filter.brand} onChange={e => changeFilter({ ...filter, brand: e.target.value })}><option value="">Todas las marcas</option>{metadata.brands.map(brand => <option key={brand}>{brand}</option>)}</select></label>
            <label>Polaridad<select value={filter.polarity} onChange={e => {
              const polarity = e.target.value;
              if (polarity === '' || polarity === 'L' || polarity === 'R') changeFilter({ ...filter, polarity });
            }}><option value="">Todas</option><option value="L">Izquierda [L]</option><option value="R">Derecha [R]</option></select></label></div>
        </header>
        {busy && <p className="message" role="status">Actualizando catálogo completo…</p>}
        {stale && visible && <p className="message" role="status">Disponibilidad desactualizada: se conserva la última consulta completa.</p>}
        {error && <p className="message" role="alert">{error}</p>}
        <button id="creation-retry" type="button" className="creation-retry" onClick={() => { if (current()) read.current('manual'); }}>Reintentar catálogo</button>
        <div className="creation-table"><table><caption className="sr-only">Catálogo de {sourceName}</caption><thead><tr>{['Batería', 'Polaridad', 'Disponible', 'Cantidad', 'Acción'].map(text => <th key={text} scope="col">{text}</th>)}</tr></thead>
          <tbody>{pageRows.map(row => <tr key={row.variant_id}>
            <td><strong>{row.brand} · {row.model}</strong><small>{row.capacity_ah} Ah</small></td><td><span className="polarity">{row.polarity}</span></td><td>{row.available.toString()}{row.available === 0n && <small>Sin disponible</small>}</td>
            <td><input id={`source-quantity-${row.variant_id}`} aria-label={`Cantidad ${row.model} ${row.polarity}`} inputMode="numeric" value={quantities[row.variant_id] ?? '1'} disabled={row.available === 0n} onChange={e => {
              if (!guardedCart()) return;
              setQuantities(previous => ({ ...previous, [row.variant_id]: e.target.value }));
            }} /></td><td><button type="button" disabled={row.available === 0n} aria-label={`Añadir ${row.model} ${row.polarity}`} onClick={() => {
              if (!guardedCart()) return;
              if (editCart((draft, latest) => addCartItem(draft, latest, row.variant_id, quantities[row.variant_id] ?? '1'))) focusAdd(row.variant_id);
            }}>Añadir</button></td>
          </tr>)}</tbody></table></div>
        {visible && rows.length === 0 && <p role="status" className="message">No hay variantes para esta consulta.</p>}
        <footer className="creation-pager"><span>Mostrando {rows.length ? (displayedPage - 1) * 25 + 1 : 0}–{Math.min(displayedPage * 25, rows.length)} de {rows.length} variantes</span>
          <button type="button" aria-label="Página anterior" disabled={displayedPage <= 1} onClick={() => { if (current()) setPage(displayedPage - 1); }}>Anterior</button><span>{displayedPage} / {lastPage}</span>
          <button type="button" aria-label="Página siguiente" disabled={displayedPage >= lastPage} onClick={() => { if (current()) setPage(displayedPage + 1); }}>Siguiente</button></footer>
      </section>
      <aside className="creation-cart" aria-label="Carrito de transferencia"><h2>Solicitud</h2><p>{cart?.lines.length ?? 0} variantes · {status?.total.toString() ?? '0'} baterías</p>
        {!cart?.lines.length && <p>Agregá baterías del catálogo de origen.</p>}
        {cart?.lines.map(line => <article key={line.item.variant_id}>
          <h3>{line.item.brand} · {line.item.model}</h3><p>{line.item.capacity_ah} Ah · Polaridad {line.item.polarity}</p>
          <p>Disponible: {line.available === null ? 'Variante ausente' : line.available.toString()}</p>
          {status?.invalid.includes(line.item.variant_id) && <p className="message" role="alert">Selección inválida: revisá la cantidad o quitá la variante. No se ajustó automáticamente.</p>}
          <div className="creation-stepper"><button type="button" aria-label={`Reducir ${line.item.model}`} onClick={() => {
            if (!guardedCart()) return;
            if (line.quantity === 1n) { if (editCart((draft, latest) => removeCartItem(draft, latest, line.item.variant_id))) focusAdd(line.item.variant_id); }
            else editCart((draft, latest) => setCartQuantity(draft, latest, line.item.variant_id, line.quantity - 1n));
          }}>−</button><input aria-label={`Cantidad seleccionada ${line.item.model}`} inputMode="numeric" value={line.quantity.toString()} onChange={e => {
            if (!guardedCart()) return;
            if (e.target.value === '0') { if (editCart((draft, latest) => removeCartItem(draft, latest, line.item.variant_id))) focusAdd(line.item.variant_id); }
            else editCart((draft, latest) => setCartQuantity(draft, latest, line.item.variant_id, e.target.value));
          }} /><button type="button" aria-label={`Aumentar ${line.item.model}`} onClick={() => {
            if (!guardedCart()) return;
            editCart((draft, latest) => setCartQuantity(draft, latest, line.item.variant_id, line.quantity + 1n));
          }}>+</button></div>
          <button type="button" aria-label={`Quitar ${line.item.model}`} onClick={() => {
            if (editCart((draft, latest) => removeCartItem(draft, latest, line.item.variant_id))) focusAdd(line.item.variant_id);
          }}>Quitar</button>
        </article>)}
        {quantityError && <p className="message" role="alert">{quantityError}</p>}
        <p>Este borrador no reserva ni mueve existencias.</p><button type="button" className="primary" disabled={!snapshot && !status?.ready} onClick={event => openReview(event.currentTarget)}>Revisar solicitud</button>
        <p>El envío es manual desde la revisión. Recargar o cerrar la pestaña pierde la recuperación en memoria.</p>
      </aside>
    </div>
    </fieldset>
    {visibleReview && <TransferReview controller={controller} metadata={metadata} ownerTag={key!} snapshot={visibleReview.snapshot}
      busy={inFlight} error={sendError?.owner === key ? sendError.text : ''} result={visibleOutcome} returnFocus={reviewTrigger.current}
      onClose={closeReview} onEdit={() => {
        const archived = recovery.getCurrent(controller.getTransferAuthority);
        if (archived?.phase === 'unknown') requestCaution('edit'); else closeReview();
      }} onBack={() => { if (current() && !inFlight) onBack(); }} onSend={submit => { void send(submit); }}
      onDetail={onDetail ? id => {
        if (current() && !inFlight && outcome?.owner === key && outcome.result.record.id === id) onDetail(id, key!);
      } : undefined} />}
    {pending && <div className="creation-dialog-backdrop"><section role="dialog" aria-modal="true" aria-labelledby="discard-title" className="creation-dialog" onKeyDown={e => {
      if (e.key === 'Escape') { e.preventDefault(); closeDialog(); }
      if (e.key === 'Tab') {
        const buttons = e.currentTarget.querySelectorAll('button');
        if (e.shiftKey && document.activeElement === buttons[0]) { e.preventDefault(); buttons[1]?.focus(); }
        else if (!e.shiftKey && document.activeElement === buttons[1]) { e.preventDefault(); buttons[0]?.focus(); }
      }
    }}><h2 id="discard-title">{snapshot ? 'Antes de cambiar la solicitud' : '¿Descartar la selección?'}</h2>
      <p>{snapshot ? snapshot.phase === 'unknown' ? 'La solicitud puede haberse creado. Cambiarla puede generar otra solicitud; reintentá primero la misma para comprobarlo.' : 'Se conserva la revisión hasta que confirmes el cambio.' : 'Se eliminarán las líneas para cambiar de origen o volver al inventario.'}</p>
      {snapshot && <p>{pending === 'back' ? 'Al volver se conserva el intento en esta App, no al recargar o cerrar la pestaña.' : 'Primero se restaurarán todas las cantidades con el catálogo actual; no se ajustarán automáticamente. Un cambio real requerirá una nueva revisión.'}</p>}
      {quantityError && <p role="alert">{quantityError}</p>}
      <button ref={cancel} type="button" onClick={closeDialog}>Conservar selección</button><button type="button" onClick={acknowledge}>{snapshot ? pending === 'back' ? 'Volver conservando el intento' : 'Entiendo el riesgo, habilitar edición' : 'Descartar selección'}</button>
    </section></div>}
  </section>;
}
