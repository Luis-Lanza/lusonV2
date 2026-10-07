import { useEffect, useRef, useState } from 'react';
import type { Metadata } from './model';
import { validSearch } from './model';
import { filterSourceInventory, loadSourceInventory, SourceInventoryError } from './sourceInventory';
import { addCartItem, cartStatus, createTransferCart, refreshCart, removeCartItem, setCartQuantity } from './transferCart';
import type { TransferCart } from './transferCart';
import { transferDirection } from './transferModel';
import type { TransferFlow } from './transferModel';
import type { SourceInventoryController, TransferAuthority, TransferController } from './useInventory';

export interface TransferCreationProps {
  controller: TransferController & SourceInventoryController;
  metadata: Metadata;
  onBack: () => void;
  loader?: typeof loadSourceInventory;
}
function owner(authority: TransferAuthority): string | null {
  const session = authority.session;
  if (!session?.authenticated || ![2, 3].includes(session.identity.location.id)) return null;
  return `${authority.epoch}/${session.identity.account_id}/${session.identity.location.id}`;
}
type Flight = { sequence: number; abort: AbortController; dirty: boolean };
type Held = { owner: string; flow: TransferFlow; cart: TransferCart };

export default function TransferCreation({ controller, metadata, onBack, loader = loadSourceInventory }: TransferCreationProps) {
  // Fence every raw private read before effects: readiness is not a saved permission.
  const authority = controller.getTransferAuthority();
  const key = owner(authority);
  const allowed = authority.ready && key !== null;
  const [flow, setFlow] = useState<TransferFlow>('requestWarehouse');
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
  const [pending, setPending] = useState<TransferFlow | 'back' | null>(null);
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
      const cart = previous?.owner === key && previous.flow === selectedFlow
        ? refreshCart(previous.cart, latest, catalog) : createTransferCart(latest, selectedFlow, catalog);
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
      heldRef.current = null; setHeld(null); flowRef.current = 'requestWarehouse'; setFlow('requestWarehouse');
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
  useEffect(() => { if (pending) cancel.current?.focus(); }, [pending]);

  // Do not even inspect held.cart, error strings or row inputs outside this fence.
  if (!allowed) return <section className="transfer-creation"><p role="status">La creación requiere una sesión activa de sucursal.</p></section>;
  if (activeKey.current !== key || (held !== null && held.owner !== key)) return <section className="transfer-creation"><p role="status">Preparando catálogo de la sesión activa…</p></section>;
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
    if (!latest || !fresh.current) return null;
    const previous = heldRef.current;
    if (!previous || previous.owner !== key || previous.flow !== flowRef.current) return null;
    return { latest, previous };
  }
  function editCart(operation: (cart: TransferCart, latest: TransferAuthority) => TransferCart) {
    const checked = guardedCart();
    if (!checked) return false;
    try {
      const next = { ...checked.previous, cart: operation(checked.previous.cart, checked.latest) };
      heldRef.current = next; setHeld(next); setQuantityError(''); return true;
    } catch { setQuantityError('Ingresá una cantidad entera positiva, sin ceros iniciales y dentro del disponible (máximo int64).'); return false; }
  }
  function focusAdd(id: number) {
    const input = document.getElementById(`source-quantity-${id}`);
    if (input instanceof HTMLInputElement && !input.disabled) input.focus();
    else document.getElementById('creation-retry')?.focus();
  }
  function changeFlow(next: TransferFlow | 'back') {
    if (!current()) return;
    if (next === flowRef.current) return;
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
  function closeDialog() { if (!current()) return; setPending(null); trigger.current?.focus(); }
  function changeFilter(next: typeof filter) {
    if (!current()) return;
    if (!validSearch(next.search) || !validSearch(next.brand)) return;
    setFilter(next); setPage(1);
  }
  return <section className="transfer-creation" aria-labelledby="creation-title">
    <p className="creation-breadcrumb">Inventario / Transferencias / {title}</p>
    <button id="creation-back" type="button" className="creation-back" onClick={() => changeFlow('back')}>← Volver al inventario</button>
    <h1 id="creation-title">{title}</h1>
    <p>Prepará una solicitud con el stock de su origen físico. La consulta de inventario no cambia tu ubicación asignada.</p>
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
        <p>Este borrador no reserva ni mueve existencias.</p><button type="button" className="primary" disabled>Revisar solicitud</button>
        <p>La revisión y el envío se habilitarán en la próxima etapa.</p>
      </aside>
    </div>
    {pending && <div className="creation-dialog-backdrop"><section role="dialog" aria-modal="true" aria-labelledby="discard-title" className="creation-dialog" onKeyDown={e => {
      if (e.key === 'Escape') { e.preventDefault(); closeDialog(); }
      if (e.key === 'Tab') {
        const buttons = e.currentTarget.querySelectorAll('button');
        if (e.shiftKey && document.activeElement === buttons[0]) { e.preventDefault(); buttons[1]?.focus(); }
        else if (!e.shiftKey && document.activeElement === buttons[1]) { e.preventDefault(); buttons[0]?.focus(); }
      }
    }}><h2 id="discard-title">¿Descartar la selección?</h2><p>Se eliminarán las líneas para cambiar de origen o volver al inventario.</p>
      <button ref={cancel} type="button" onClick={closeDialog}>Conservar selección</button><button type="button" onClick={() => { if (current() && pending) applyFlow(pending); }}>Descartar selección</button>
    </section></div>}
  </section>;
}
