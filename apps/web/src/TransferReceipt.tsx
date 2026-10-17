import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import './transfer-receipt.css';
import type { TransferController } from './useInventory';
import type { useTransfers } from './useTransfers';
import { canonicalTransferReceiptInput, previewTransferReceipt, type TransferReceiptData, type TransferReceiptInput, type TransferRecord } from './transferModel';
import { captureDecisionRecord } from './transferDecisionRecovery';
import { detailAuthority } from './TransferDetail';
import { transferViewOwner } from './TransferPending';
import { loadSourceInventory, SourceInventoryError, type SourceCatalog } from './sourceInventory';
import { TransferAPIError } from './transferAPI';
import { useTransferModalFocus, type TransferModalFocusBinding } from './transferModalFocus';

const exceptionLabel = { shortage: 'Faltante', excess: 'Exceso', unexpected: 'Inesperada' };
export function ReceiptTable({ receipt, record, detailPresentation = false }: {
  receipt: TransferReceiptData; record: TransferRecord; detailPresentation?: boolean;
}) {
  const labels = detailPresentation
    ? ['Batería', 'Enviadas', 'Recibidas físicamente', 'Crédito original', 'Discrepancia original']
    : ['Variante', 'Cantidad enviada', 'Cantidad recibida', 'Stock disponible acreditado', 'Discrepancia'];
  return <div className={`table-scroll transfer-detail-items${detailPresentation ? ' receipt-detail-comparison' : ''}`}><table>
    <caption>Detalle de recepción</caption>
    <thead><tr>{labels.map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead>
    <tbody>{receipt.items.map(line => {
      const item = record.items.find(item => item.variant_id === line.variant_id);
      const exception = receipt.exceptions.find(exception => exception.variant_id === line.variant_id);
      return <tr key={line.variant_id} data-variant-id={line.variant_id}>
        <td data-label={labels[0]}>{item ? <>{`${item.brand} · ${item.model}`}
          {detailPresentation && <small>{item.capacity_ah} Ah · {item.polarity === 'L' ? 'Izquierda [L]' : 'Derecha [R]'}</small>}</>
          : `Variante inesperada ${line.variant_id}`}</td>
        <td data-label={labels[1]}>{line.expected_quantity.toString()}</td>
        <td data-label={labels[2]}>{line.actual_quantity.toString()}</td>
        <td data-label={labels[3]}>{line.available_quantity.toString()}</td>
        <td data-label={labels[4]}><span className={detailPresentation ? `receipt-discrepancy ${exception?.kind ?? 'matched'}` : undefined}>
          {exception ? `${exceptionLabel[exception.kind]}: ${exception.quantity.toString()}` : 'Sin discrepancia'}</span></td></tr>;
    })}</tbody>
  </table></div>;
}
// Preview only: persisted receipt history retains its original labels and evidence.
interface CatalogIdentity {
  readonly brand: string; readonly model: string; readonly capacity_ah: string; readonly polarity: 'L' | 'R';
  readonly destinationLocationID: TransferRecord['destination_location_id'];
}
export function ReceiptPreview({ receipt, record, identities }: {
  receipt: TransferReceiptData; record: TransferRecord; identities: Readonly<Record<number, CatalogIdentity>>;
}) {
  const identity = (id: number) => record.items.find(item => item.variant_id === id) ?? identities[id];
  const product = (id: number) => {
    const item = identity(id);
    return item ? <><strong>{item.brand} {item.model}</strong>{' · '}
      <small>{item.capacity_ah} Ah · {item.polarity === 'L' ? 'Izquierda [L]' : 'Derecha [R]'}</small></>
      : <><strong>Variante {id}</strong><small>Identidad no disponible. Consultá el catálogo del destino.</small></>;
  };
  const labels = ['Producto', 'Enviadas', 'Recibidas', 'A acreditar', 'Diferencia'];
  const totals = receipt.items.reduce((sum, line) => ({
    sent: sum.sent + line.expected_quantity, physical: sum.physical + line.actual_quantity,
    credit: sum.credit + line.available_quantity,
  }), { sent: 0n, physical: 0n, credit: 0n });
  const difference = (kind: string, quantity: bigint) => `${kind === 'shortage' ? 'Faltante' : kind === 'unexpected' ? 'No enviada' : 'Exceso'}: ${quantity.toString()}`;
  const summary = ['shortage', 'excess', 'unexpected'].map(kind => ({ kind,
    quantity: receipt.exceptions.filter(line => line.kind === kind).reduce((sum, line) => sum + line.quantity, 0n),
  })).filter(line => line.quantity > 0n);
  return <div className="receipt-preview">
    <p className="receipt-preview-intro">Revisá el conteo antes de registrarlo. <small>Se acreditará el mínimo recibido/enviado por variante.</small></p>
    <div className="receipt-preview-table"><table>
      <caption className="sr-only">Revisión de cantidades recibidas</caption>
      <thead><tr>{labels.map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead>
      <tbody>{receipt.items.map(line => {
        const exception = receipt.exceptions.find(exception => exception.variant_id === line.variant_id);
        return <tr key={line.variant_id} data-variant-id={line.variant_id} className={exception ? 'receipt-preview-discrepant' : undefined}>
          <td data-label={labels[0]}>{product(line.variant_id)}
            {exception?.kind === 'unexpected' && identity(line.variant_id) && <small className="receipt-preview-provenance">Identidad del catálogo del destino al agregar.</small>}</td>
          <td data-label={labels[1]}>{line.expected_quantity.toString()}</td>
          <td data-label={labels[2]}>{line.actual_quantity.toString()}</td>
          <td data-label={labels[3]}>{line.available_quantity.toString()}</td>
          <td data-label={labels[4]}><span className={`receipt-preview-difference ${exception ? 'different' : 'matched'}`}>
            <svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <path d={exception ? 'M12 3 2 21h20L12 3 M12 9v5 M12 17v.01' : 'm5 12 4 4L19 6'} />
            </svg>{exception ? difference(exception.kind, exception.quantity) : 'Sin diferencias'}</span></td>
        </tr>;
      })}</tbody>
      <tfoot><tr><td>Total: {receipt.items.length} variantes</td>
        <td data-label={labels[1]}>{totals.sent.toString()}</td>
        <td data-label={labels[2]}>{totals.physical.toString()}</td>
        <td data-label={labels[3]}>{totals.credit.toString()}</td>
        <td data-label={labels[4]}>{summary.length ? summary.map(line => <span key={line.kind}>
          {difference(line.kind, line.quantity)}</span>) : 'Sin diferencias'}</td>
      </tr></tfoot>
    </table></div>
    <section className="receipt-preview-effect" aria-label="Efecto al confirmar">
      <p><strong>{totals.credit === 1n ? 'Se acreditará' : 'Se acreditarán'} {totals.credit.toString()} {totals.credit === 1n ? 'batería' : 'baterías'} en {record.destination_location_name} al confirmar.</strong>{' '}
        <small>No es inventario actual.</small></p>
      {!receipt.exceptions.length && <p>El conteo coincide con lo enviado.</p>}
      {receipt.exceptions.map(exception => {
        const item = identity(exception.variant_id);
        return <div className="receipt-preview-exception" key={exception.variant_id}>
          <p>{difference(exception.kind, exception.quantity)} · {item ? <>{item.brand} {item.model} · {item.capacity_ah} Ah · {item.polarity === 'L' ? 'Izquierda [L]' : 'Derecha [R]'}</> : `Variante ${exception.variant_id} · Identidad no disponible`}.</p>
          <p className="receipt-preview-warning">{exception.kind === 'shortage' ? 'El faltante quedará registrado; no se resuelve automáticamente.'
            : exception.kind === 'unexpected' ? 'La variante no enviada quedará registrada por separado; no se acreditará automáticamente al stock disponible ni se resolverá esta diferencia.'
              : 'El exceso quedará registrado por separado; no se sumará automáticamente al stock disponible.'}</p>
        </div>;
      })}
      <p className="receipt-preview-immutable">Al confirmar: Conteo original guardado una sola vez; no se podrá editar.</p>
    </section>
  </div>;
}
export interface TransferReceiptProps {
  controller: TransferController; ownerTag: string; transfers: ReturnType<typeof useTransfers>;
  record?: TransferRecord | null; onPrivateUnavailable?: () => void;
  renderDetail?: (actions: ReactNode) => ReactNode;
  modalFocus?: TransferModalFocusBinding;
}
interface Review {
  fence: string; record: TransferRecord; trigger: HTMLElement;
  values: Record<number, string>; unexpected: number[]; step: 'capture' | 'review';
  // Display-only identity and catalog membership captured at selection, never receipt history or payload.
  identities: Readonly<Record<number, CatalogIdentity>>;
}
export default function TransferReceipt(props: TransferReceiptProps) {
  const { controller, ownerTag, transfers } = props;
  const latest = useRef(props); latest.current = props;
  const fence = detailAuthority(controller); const boundFence = useRef(fence);
  const permitted = !!fence && fence === boundFence.current && transferViewOwner(controller.getTransferAuthority()) === ownerTag;
  const [review, setReview] = useState<Review | null>(null);
  const [catalog, setCatalog] = useState<{ fence: string; record: TransferRecord; data: SourceCatalog | null; failed: boolean } | null>(null);
  const [selectedUnexpected, setSelectedUnexpected] = useState('');
  const mounted = useRef(false); const pendingCall = useRef(false);
  const dialog = useRef<HTMLElement>(null); const close = useRef<HTMLButtonElement>(null);
  const current = () => mounted.current && permitted && detailAuthority(controller) === fence;
  const visibleReview = permitted && review?.fence === fence ? review : null;
  const receiptPresentation = visibleReview?.record.kind === 'request_stock' && visibleReview.record.status === 'in_transit';
  // Cleanup must precede the focus hook's layout-effect restoration.
  useLayoutEffect(() => {
    const backdrop = dialog.current?.parentElement;
    if (!receiptPresentation || !backdrop) return;
    const previous = new Map<Element, string | null>();
    const isolateSiblings = () => {
      for (let branch: Element | null = backdrop; branch && branch !== document.body; branch = branch.parentElement) {
        for (const sibling of branch.parentElement?.children ?? []) {
          if (sibling === branch || previous.has(sibling)) continue;
          previous.set(sibling, sibling.getAttribute('inert'));
          if (!sibling.hasAttribute('inert')) sibling.setAttribute('inert', '');
        }
      }
    };
    isolateSiblings();
    const observer = new MutationObserver(isolateSiblings);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      for (const [element, value] of previous) {
        if (value === null) element.removeAttribute('inert');
        else element.setAttribute('inert', value);
      }
    };
  }, [receiptPresentation]);
  const focus = useTransferModalFocus({ active: !!visibleReview, id: props.record?.id, fence, current, binding: props.modalFocus });
  const attempt = permitted ? transfers.receiptAttempt : null;
  const busy = attempt?.phase === 'inFlight';
  const unresolved = attempt?.phase === 'uncertain' || busy;
  const result = attempt?.result;
  const reviewAttempt = visibleReview && attempt?.original.id === visibleReview.record.id ? attempt : null;
  const reviewResult = reviewAttempt?.result?.status === 'received'
    && reviewAttempt.result.id === visibleReview?.record.id
    && (reviewAttempt.phase === 'confirmed' || reviewAttempt.phase === 'conflict') ? reviewAttempt.result : null;
  const reviewConfirmed = !!reviewResult && reviewAttempt?.phase === 'confirmed';
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (visibleReview) { if (busy) dialog.current?.focus(); else close.current?.focus(); }
  }, [visibleReview?.record, visibleReview?.step, busy]);
  useEffect(() => {
    const original = visibleReview?.record;
    if (!original) return;
    const abort = new AbortController(); let active = true;
    setCatalog({ fence, record: original, data: null, failed: false });
    void loadSourceInventory(original.destination_location_id, { signal: abort.signal, reason: 'passive' }).then(data => {
      if (active && current()) setCatalog({ fence, record: original, data, failed: false });
    }).catch((error: unknown) => {
      if (!active || !current()) return;
      setCatalog({ fence, record: original, data: null, failed: true });
      if (error instanceof SourceInventoryError && error.status === 401) void controller.settleUnauthorized(controller.getTransferAuthority().epoch);
    });
    return () => { active = false; abort.abort(); };
  }, [visibleReview?.record, controller.getTransferAuthority]);
  if (!permitted) return null;
  const record = props.record;
  const authority = controller.getTransferAuthority();
  const assigned = authority.session?.authenticated ? authority.session.identity.location.id : null;
  const canReceive = record?.status === 'in_transit' && record.destination_location_id === assigned;
  const failure = transfers.receiptError;
  const error = failure?.code === 'retry_conflict' ? 'Ya existe una recepción con cantidades diferentes. Consultá el resultado original.'
    : failure?.code === 'decision_conflict' ? 'El estado de la solicitud cambió. Consultá el resultado original.'
      : failure?.status === 401 ? 'No se pudo verificar la sesión.' : failure ? 'No se pudo confirmar la recepción con el servidor.' : '';
  const dismiss = () => {
    if (!current() || transfers.receiptAttempt?.phase === 'inFlight' || pendingCall.current) return;
    if (visibleReview) focus.queue({ id: visibleReview.record.id, fence: visibleReview.fence, trigger: visibleReview.trigger });
    setReview(null);
  };
  const run = async (operation: () => Promise<TransferRecord>) => {
    if (!current() || pendingCall.current || transfers.receiptAttempt?.phase === 'inFlight') return;
    pendingCall.current = true;
    try { await operation(); } catch (error: unknown) {
      if (current() && error instanceof TransferAPIError && (error.status === 403 || error.status === 404)) {
        setReview(null); latest.current.onPrivateUnavailable?.();
      }
    } finally { pendingCall.current = false; }
  };
  const open = (trigger: HTMLElement) => {
    if (!current() || !record || !canReceive || unresolved || pendingCall.current || latest.current.record?.id !== record.id
      || latest.current.record.status !== 'in_transit' || (attempt?.original.id === record.id && result)) return;
    const original = captureDecisionRecord(record);
    focus.begin();
    setSelectedUnexpected('');
    setReview({ fence, record: original, trigger, values: Object.fromEntries(original.items.map(item => [item.variant_id, ''])), unexpected: [], identities: {}, step: 'capture' });
  };
  const source = catalog?.fence === fence && catalog.record === visibleReview?.record ? catalog.data : null;
  const candidates = source?.rows.filter(row => !visibleReview?.record.items.some(item => item.variant_id === row.variant_id)
    && !visibleReview?.unexpected.includes(row.variant_id)) ?? [];
  let input: TransferReceiptInput | null = null;
  let preview: TransferReceiptData | null = null;
  if (visibleReview) {
    try {
      input = canonicalTransferReceiptInput({ items: [...visibleReview.record.items.map(item => item.variant_id), ...visibleReview.unexpected]
        .map(variant_id => ({ variant_id, actual_quantity: visibleReview.values[variant_id] })) }, visibleReview.record);
      if (visibleReview.unexpected.some(id => visibleReview.identities[id]?.destinationLocationID !== visibleReview.record.destination_location_id
        && !source?.rows.some(row => row.variant_id === id))) throw new Error();
      preview = previewTransferReceipt(input, visibleReview.record);
    } catch { input = null; }
  }
  const editValue = (variant: number, value: string) => {
    if (!current() || busy || pendingCall.current) return;
    setReview(before => before && before.fence === fence ? { ...before, values: { ...before.values, [variant]: value } } : before);
  };
  const catalogPicker = <>
      <select id="receipt-unexpected" value={selectedUnexpected} disabled={!source || busy} onChange={event => setSelectedUnexpected(event.target.value)}>
        <option value="">Elegir variante del catálogo</option>{candidates.map(row => <option key={row.variant_id} value={row.variant_id}>{row.brand} · {row.model} · {row.capacity_ah} Ah · {row.polarity}</option>)}
      </select>
      <button type="button" aria-label="Agregar variante inesperada" disabled={!candidates.some(row => String(row.variant_id) === selectedUnexpected) || busy} onClick={() => {
        const row = candidates.find(row => String(row.variant_id) === selectedUnexpected);
        if (!current() || !row || busy) return;
        setReview(before => before && !before.unexpected.includes(row.variant_id)
          ? { ...before, unexpected: [...before.unexpected, row.variant_id], values: { ...before.values, [row.variant_id]: '' },
            identities: { ...before.identities, [row.variant_id]: Object.freeze({
              brand: row.brand, model: row.model, capacity_ah: String(row.capacity_ah), polarity: row.polarity,
              destinationLocationID: before.record.destination_location_id,
            }) } } : before);
        setSelectedUnexpected('');
      }}>{receiptPresentation ? 'Agregar variante' : 'Agregar variante inesperada'}</button>
  </>;
  const catalogControls = <>
    <label htmlFor="receipt-unexpected" className={receiptPresentation ? 'sr-only' : undefined}>Variante inesperada</label>
    {receiptPresentation ? <div className="receipt-catalog-controls">{catalogPicker}</div> : catalogPicker}
    {catalog?.failed && <p role="alert">Catálogo del destino no disponible. No se pueden agregar variantes inesperadas.</p>}
    {!source && !catalog?.failed && <p role="status">Consultando catálogo del destino…</p>}
  </>;
  const captureLines = visibleReview ? [
    ...visibleReview.record.items.map(item => ({ ...item, sent: item.quantity, unexpected: false })),
    ...visibleReview.unexpected.map(variant_id => ({ ...visibleReview.identities[variant_id],
      variant_id, sent: 0n, unexpected: true })),
  ] : [];
  const previewPresentation = receiptPresentation && visibleReview.step === 'review' && !reviewResult;
  const completeInvalidCapture = !input && captureLines.length > 0
    && captureLines.every(line => visibleReview?.values[line.variant_id] !== '');
  const actions = canReceive && !(attempt?.original.id === record.id && result) ? <div className="transfer-decision-actions">
    <button type="button" className="primary" disabled={!!unresolved} onClick={event => open(event.currentTarget)}>Recibir solicitud</button>
    <p>Registrá las cantidades que llegaron al destino. La recepción se confirma una sola vez.</p>
  </div> : null;
  return <div className="transfer-receipt">
    {attempt && <section className="transfer-decision-recovery" aria-label="Recuperación de recepción">
      <h3>{unresolved ? 'Recepción pendiente de confirmación' : 'Recepción confirmada'}</h3>
      <p>{attempt.original.reference} · Cantidades originales enviadas para recepción</p>
      <ul>{attempt.input.items.map(line => <li key={line.variant_id}>Variante {line.variant_id}: {line.actual_quantity}</li>)}</ul>
      {busy ? <p role="status">Consultando o enviando la recepción…</p> : unresolved ? <>
        <p role="status">El resultado sigue sin confirmar. La recepción puede haberse registrado aunque una consulta muestre En tránsito. No envíes otra recepción.</p>
        <button type="button" onClick={() => void run(transfers.recoverReceipt)}>Consultar resultado original de la recepción</button>
        <button type="button" onClick={() => void run(transfers.retryReceipt)}>Reintentar misma recepción</button>
      </> : result?.status === 'received' && <>
        <p role="status">Estado confirmado: Recibida.</p>
        {attempt.phase === 'conflict' && <p role="alert">La recepción persistida tiene cantidades diferentes de las enviadas en este intento. No se reemplazaron las cantidades originales ni se reintentará la recepción.</p>}
        <ReceiptTable receipt={result.receipt} record={result} />
      </>}
      {error && <p role="alert">{error}</p>}
      <p>Cerrar o volver no cancela una recepción enviada. La recuperación permanece en esta App; recargar o cerrar la pestaña pierde esta memoria.</p>
    </section>}
    {props.renderDetail ? props.renderDetail(actions) : actions}
    {visibleReview && <div className={`transfer-decision-backdrop${receiptPresentation ? ' transfer-receipt-backdrop' : ''}`}><section ref={dialog} tabIndex={-1}
      className={`transfer-decision-modal${receiptPresentation ? ' transfer-receipt-modal' : ''}${previewPresentation ? ' receipt-expected-review' : ''}`}
      role="dialog" aria-modal="true" aria-labelledby="receipt-title" aria-busy={busy} onKeyDown={event => {
        if (!current() || event.nativeEvent.isComposing || event.defaultPrevented) return;
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss(); }
        if (event.key === 'Tab') {
          const controls = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled)');
          if (!controls?.length) { event.preventDefault(); return; }
          const first = controls[0]; const last = controls[controls.length - 1];
          if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first.focus(); }
        }
      }}>
      <header><div><h2 id="receipt-title">{reviewConfirmed ? 'Recepción confirmada' : reviewResult ? 'Recepción con conflicto'
        : receiptPresentation ? visibleReview.step === 'capture' ? 'Registrar cantidades recibidas' : 'Revisar recepción' : 'Confirmar recepción'}</h2>
        {receiptPresentation ? <div className="transfer-receipt-context">
          <p>{visibleReview.record.reference} · {visibleReview.record.origin_location_name} → {visibleReview.record.destination_location_name}</p>
          {!reviewResult && <span className="transfer-receipt-step">{visibleReview.step === 'capture'
            ? 'Conteo · Luego revisarás la recepción' : 'Revisión previa a confirmar'}</span>}
        </div> : <p>{visibleReview.record.reference} · {visibleReview.record.destination_location_name}</p>}</div>
        <button ref={close} type="button" aria-label="Cerrar confirmación de recepción" disabled={busy} onClick={dismiss}>×</button></header>
      <div className="transfer-decision-body">
        {reviewResult ? <>
          {reviewConfirmed ? <p role="status">Recepción registrada correctamente.</p>
            : <p role="alert">La recepción persistida tiene cantidades diferentes de las enviadas en este intento. No se reemplazaron las cantidades originales ni se reintentará la recepción.</p>}
          <ReceiptTable receipt={reviewResult.receipt} record={reviewResult} />
        </> : visibleReview.step === 'capture' && receiptPresentation ? <div className="receipt-capture">
          <p className="receipt-capture-intro">Contá lo que llegó e ingresá cada cantidad. Usá 0 si una variante no llegó.</p>
          <div className="receipt-capture-table"><table>
            <caption className="sr-only">Cantidades recibidas</caption>
            <thead><tr>{['Producto', 'Polaridad', 'Enviadas', 'Recibidas'].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead>
            <tbody>{captureLines.map(line => {
              const label = line.model ? `${line.brand} · ${line.model}` : `Variante ${line.variant_id}`;
              const polarity = line.polarity === 'L' ? 'Izquierda [L]' : line.polarity === 'R' ? 'Derecha [R]' : 'No disponible';
              return <tr key={line.variant_id}>
                <td><strong>{label}</strong>{line.capacity_ah !== undefined && <small>{line.capacity_ah} Ah</small>}
                  {line.unexpected && <small>No enviada · Variante inesperada</small>}</td>
                <td data-label="Polaridad">{polarity}</td>
                <td data-label="Enviadas">{line.sent.toString()}</td>
                <td data-label="Recibidas"><label className="sr-only" htmlFor={`receipt-quantity-${line.variant_id}`}>Cantidad recibida {label} · {polarity}</label>
                  <input id={`receipt-quantity-${line.variant_id}`} type="text" inputMode="numeric" autoComplete="off" placeholder="Cantidad"
                    aria-describedby="receipt-capture-rules" value={visibleReview.values[line.variant_id]} disabled={busy}
                    onChange={event => editValue(line.variant_id, event.target.value)} />
                  {line.unexpected && <button type="button" disabled={busy} aria-label={`Quitar variante inesperada ${label}`} onClick={() => {
                    if (current() && !busy) setReview(before => before ? { ...before, unexpected: before.unexpected.filter(id => id !== line.variant_id) } : before);
                  }}>Quitar variante</button>}</td>
              </tr>;
            })}</tbody>
          </table></div>
          <section className="receipt-catalog-panel" aria-labelledby="receipt-catalog-title">
            <h3 id="receipt-catalog-title">¿Llegó otra variante?</h3>
            <p>Agregala para registrar lo que llegó fuera de lo enviado.</p>
            {catalogControls}
          </section>
          <div className="receipt-capture-advisory">
            <p>Todavía no se modifica el stock. Primero revisarás el conteo.</p>
            <p id="receipt-capture-rules">Cantidades enteras, sin negativos. Completá todas las filas; no puede quedar todo en 0.</p>
          </div>
          {completeInvalidCapture && <p role="alert">Revisá las cantidades: solo enteros sin signos, espacios ni ceros iniciales, hasta 9223372036854775807. Al menos una cantidad debe ser positiva; las variantes inesperadas requieren cantidades positivas.</p>}
        </div> : visibleReview.step === 'capture' ? <>
          <p>Ingresá cada cantidad recibida, incluido 0 si no llegó esa variante. No se limita por disponibilidad del destino.</p>
          <div className="receipt-quantities">{[...visibleReview.record.items.map(item => ({ id: item.variant_id, label: `${item.brand} · ${item.model}`, sent: item.quantity })),
            ...visibleReview.unexpected.map(id => ({ id, label: visibleReview.identities[id]?.model ?? `Variante ${id}`, sent: 0n }))].map(line => <div key={line.id}>
              <label htmlFor={`receipt-quantity-${line.id}`}>Cantidad recibida {line.label}</label><small>Cantidad enviada: {line.sent.toString()}</small>
              <input id={`receipt-quantity-${line.id}`} type="text" inputMode="numeric" autoComplete="off" value={visibleReview.values[line.id]} disabled={busy}
                onChange={event => editValue(line.id, event.target.value)} />
              {visibleReview.unexpected.includes(line.id) && <button type="button" onClick={() => {
                if (current() && !busy) setReview(before => before ? { ...before, unexpected: before.unexpected.filter(id => id !== line.id) } : before);
              }}>Quitar variante inesperada {line.label}</button>}
            </div>)}</div>
          {catalogControls}
          <p>Solo enteros sin signos, espacios ni ceros iniciales, hasta 9223372036854775807. Las variantes inesperadas requieren cantidades positivas; una recepción totalmente en cero no es válida.</p>
        </> : preview && receiptPresentation ?
          <ReceiptPreview receipt={preview} record={visibleReview.record} identities={visibleReview.identities} /> : preview && <>
          <ReceiptTable receipt={preview} record={visibleReview.record} />
          <p>Solo el mínimo entre lo recibido y lo enviado de cada variante esperada se acredita como stock disponible. Faltantes, excesos y variantes inesperadas quedan registrados por separado; no se acreditan ni se resuelven automáticamente.</p>
          <p>Confirmar finaliza la recepción una sola vez. No se podrá modificar después.</p>
        </>}
        {busy && <p role="status">Confirmando recepción…</p>}
        {error && <p role="alert">{error}</p>}
        {unresolved && !busy && <p role="status">Resultado sin confirmar. Usá la recuperación de la recepción original.</p>}
      </div>
      <footer><button type="button" disabled={busy} onClick={dismiss}>Volver al detalle</button>
        {visibleReview.step === 'capture' ? <button type="button" className="primary" disabled={!input || busy} onClick={() => {
          if (current() && input && !busy) setReview(before => before ? { ...before, step: 'review' } : before);
        }}>Revisar recepción</button> : <>
          {!reviewAttempt && <button type="button" onClick={() => { if (current()) setReview(before => before ? { ...before, step: 'capture' } : before); }}>Editar cantidades</button>}
          {(!reviewAttempt || busy) && <button type="button" className="primary" disabled={busy || !input} onClick={() => {
            const now = latest.current.record;
            if (current() && input && now?.status === 'in_transit' && now.id === visibleReview.record.id) void run(() => transfers.receive(visibleReview.record, input!));
          }}>Confirmar recepción</button>}
        </>}
      </footer>
    </section></div>}
  </div>;
}
