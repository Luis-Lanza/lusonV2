import { Component, Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import TransferDate from './TransferDate';
import {
  addToCart, cartTotal, changeQuantity, emptyCustomer, emptyPayments, fillRemaining, formatMoney,
  moneyCents, moneySumMessage, paymentBreakdown, posCustomerNameMessage, posEmptyCartMessage,
  posNotSellableReason, posQuantityMessage, posWarrantyMessage, prepareSale, removeFromCart, setPayment,
  setQuantity, setUnitPrice, setWarranty, settlement, typedMoney, variantLabel,
  type CartEdit, type CartLine, type PaymentSplit, type SaleCustomer, type SellablePage, type SellableVariant,
} from './pointOfSaleModel';
import {
  SalesAPIError, createSalesAPI, salesDefaultPageSize, salesErrorMessages, salesPageSizes, sellableUnavailable,
  warrantyPath, type SaleDocument, type SalesErrorCode,
} from './salesAPI';
import './point-of-sale.css';

/** The one message the reader sees when the counter itself fails. */
export const pointOfSaleFailureMessage =
  'La sección del punto de venta dejó de responder. El resto de la aplicación sigue funcionando.';
export const salesHistoryFailureMessage =
  'La sección del historial de ventas dejó de responder. El resto de la aplicación sigue funcionando.';

interface BoundaryProps { readonly children: ReactNode; readonly message?: string }
interface BoundaryState { readonly failed: boolean; readonly attempt: number }

/**
 * Contains a failing counter or history section: the shell keeps working and the
 * reader can retry. The retry remounts the section under a new key, so the new attempt
 * starts from a fresh read instead of the state that just threw.
 */
export class SalesSectionBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { failed: false, attempt: 0 };

  static getDerivedStateFromError(): { readonly failed: true } {
    return { failed: true };
  }

  private retry = () => {
    this.setState(current => ({ failed: false, attempt: current.attempt + 1 }));
  };

  render() {
    if (this.state.failed) {
      return <section className="point-of-sale" role="alert">
        <section className="pos-panel">
          <p className="pos-message">{this.props.message ?? pointOfSaleFailureMessage}</p>
          <button type="button" onClick={this.retry}>Reintentar sección</button>
        </section>
      </section>;
    }
    return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>;
  }
}

interface CatalogueState {
  readonly phase: 'loading' | 'ready' | 'error';
  readonly page: SellablePage | null;
  readonly problem: string;
}
/** What the seller has typed in one line, before it is admitted into the cart. */
interface LineDraft { readonly quantity: string; readonly warranty: string; readonly price: string }
interface PaymentDrafts { readonly cash: string; readonly transfer: string }

const noPayments: PaymentDrafts = { cash: '', transfer: '' };
const blockedReason = (variantID: number) => `pos-blocked-${variantID}`;
/** A zero field shows nothing instead of `0,00`, so the seller sees it as unpaid. */
const entryOf = (cents: bigint): string => cents === 0n ? '' : typedMoney(cents);
const draftOf = (line: CartLine): LineDraft => ({
  quantity: String(line.quantity), warranty: String(line.warranty_months), price: typedMoney(line.unit_price_cents),
});
const lineRefusals: Record<string, string> = {
  variant_not_sellable: 'no es vendible: no tiene precio en esta sucursal.',
  below_minimum: 'cobra menos que el precio mínimo de esta sucursal.',
  insufficient_stock: 'no tiene stock suficiente en esta sucursal.',
};

export interface PointOfSaleProps {
  /** The session fence: the parent remounts the section per session, so a rotated
   * CSRF token can never publish a sale into a newer branch session. */
  csrf: string;
  branch?: string;
  brands?: readonly string[];
  fetcher?: typeof globalThis.fetch;
}

export default function PointOfSale({ csrf, branch = 'esta sucursal', brands = [], fetcher = globalThis.fetch }: PointOfSaleProps) {
  const api = useMemo(() => createSalesAPI(fetcher), [fetcher]);
  const [search, setSearch] = useState('');
  const [brand, setBrand] = useState('');
  const [capacity, setCapacity] = useState('');
  const [polarity, setPolarity] = useState<'' | 'L' | 'R'>('');
  const [pageNumber, setPageNumber] = useState(1);
  const [pageSize, setPageSize] = useState(salesDefaultPageSize);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<CatalogueState>({ phase: 'loading', page: null, problem: sellableUnavailable });
  const [cart, setCart] = useState<readonly CartLine[]>([]);
  const [split, setSplit] = useState<PaymentSplit>(emptyPayments);
  const [customer, setCustomer] = useState<SaleCustomer>(emptyCustomer);
  const [drafts, setDrafts] = useState<Readonly<Record<number, LineDraft>>>({});
  const [payDrafts, setPayDrafts] = useState<PaymentDrafts>(noPayments);
  const [problem, setProblem] = useState('');
  const [issued, setIssued] = useState<SaleDocument | null>(null);
  const [busy, setBusy] = useState(false);
  const lifetime = useRef(new AbortController());
  const mounted = useRef(true);
  const pending = useRef(false);

  useEffect(() => {
    mounted.current = true;
    const flight = new AbortController();
    lifetime.current = flight;
    return () => { mounted.current = false; flight.abort(); };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const alive = () => mounted.current && !controller.signal.aborted && !lifetime.current.signal.aborted;
    setState(current => ({ phase: 'loading', page: current.page, problem: sellableUnavailable }));
    void (async () => {
      try {
        const page = await api.sellable({ search, brand, capacity, polarity, page: pageNumber, page_size: pageSize },
          controller.signal);
        if (!alive()) return;
        setState({ phase: 'ready', page, problem: '' });
      } catch (failure) {
        if (!alive()) return;
        const code: SalesErrorCode = failure instanceof SalesAPIError ? failure.code : 'invalid_response';
        const message = code === 'unauthenticated' ? salesErrorMessages.unauthenticated
          : code === 'forbidden' ? salesErrorMessages.forbidden : sellableUnavailable;
        setState({ phase: 'error', page: null, problem: message });
      }
    })();
    return () => controller.abort();
  }, [api, search, brand, capacity, polarity, pageNumber, pageSize, revision]);

  const items = state.page?.items ?? [];
  const total = state.page?.total_variants ?? 0;
  const firstRow = state.page && items.length > 0 ? (state.page.page - 1) * state.page.page_size + 1 : 0;
  const lastRow = state.page && items.length > 0 ? firstRow + items.length - 1 : 0;
  const capacities = useMemo(() => {
    const present = [...new Set(items.map(item => item.capacity_ah))];
    if (capacity !== '' && !present.includes(capacity)) present.push(capacity);
    return present.sort((left, right) => Number(left) - Number(right));
  }, [items, capacity]);
  const saleTotal = cartTotal(cart);
  const open = settlement(saleTotal, split);
  const nameMissing = customer.name.trim() === '';
  const closable = open.status === 'exact';
  const canCharge = !busy && cart.length > 0 && closable && !nameMissing;
  // The sum already states what is missing, so the hint only covers what it cannot say.
  const hint = busy ? 'Emitiendo la venta…'
    : cart.length === 0 ? posEmptyCartMessage
    : closable && nameMissing ? posCustomerNameMessage : '';

  function draftFor(line: CartLine): LineDraft {
    return drafts[line.variant_id] ?? draftOf(line);
  }
  function patchDraft(line: CartLine, patch: Partial<LineDraft>) {
    setDrafts(current => ({ ...current, [line.variant_id]: { ...(current[line.variant_id] ?? draftOf(line)), ...patch } }));
  }
  function commit(edit: CartEdit): boolean {
    if (!edit.ok) { setProblem(edit.message); return false; }
    setProblem(''); setCart(edit.cart);
    return true;
  }

  function add(variant: SellableVariant) {
    if (busy) return;
    setProblem('');
    const added = addToCart(cart, variant);
    if (!added.ok) { setProblem(added.message); return; }
    const line = added.cart.find(entry => entry.variant_id === variant.variant_id);
    if (line) patchDraft(line, draftOf(line));
    setCart(added.cart);
  }
  function remove(variantID: number) {
    if (busy) return;
    setProblem('');
    setCart(removeFromCart(cart, variantID));
    setDrafts(current => { const next = { ...current }; delete next[variantID]; return next; });
  }
  function step(line: CartLine, delta: number) {
    if (busy) return;
    const edit = changeQuantity(cart, line.variant_id, delta);
    if (!edit.ok) { setProblem(edit.message); return; }
    const next = edit.cart.find(entry => entry.variant_id === line.variant_id);
    commit(edit);
    if (next) patchDraft(next, { quantity: String(next.quantity) });
  }
  function typeQuantity(line: CartLine, value: string) {
    patchDraft(line, { quantity: value });
    if (!/^\d+$/.test(value)) { setProblem(posQuantityMessage); return; }
    const edit = setQuantity(cart, line.variant_id, Number(value));
    if (!edit.ok) { setProblem(edit.message); return; }
    commit(edit);
  }
  function typeWarranty(line: CartLine, value: string) {
    patchDraft(line, { warranty: value });
    if (!/^\d+$/.test(value)) { setProblem(posWarrantyMessage); return; }
    const edit = setWarranty(cart, line.variant_id, Number(value));
    if (!edit.ok) { setProblem(edit.message); return; }
    commit(edit);
  }
  function typePrice(line: CartLine, value: string) {
    patchDraft(line, { price: value });
    commit(setUnitPrice(cart, line.variant_id, value));
  }
  function typePayment(method: 'cash' | 'transfer', value: string) {
    setPayDrafts(current => ({ ...current, [method]: value }));
    const edit = setPayment(split, method, value);
    if (!edit.ok) { setProblem(edit.message); return; }
    setProblem(''); setSplit(edit.split);
  }
  function rest() {
    const filled = fillRemaining(split, saleTotal);
    if (filled === null) return;
    setProblem('');
    setSplit(filled);
    setPayDrafts({ cash: entryOf(filled.cash_cents), transfer: entryOf(filled.transfer_cents) });
  }

  async function charge() {
    if (busy || pending.current) return;
    const prepared = prepareSale(cart, split, customer);
    if (!prepared.ok) { setProblem(prepared.message); return; }
    pending.current = true; setBusy(true); setProblem('');
    try {
      const sale = await api.create(prepared.input, csrf, lifetime.current.signal);
      if (!mounted.current || lifetime.current.signal.aborted) return;
      setIssued(sale);
      setCart([]); setDrafts({}); setSplit(emptyPayments); setPayDrafts(noPayments); setCustomer(emptyCustomer);
      // The catalogue is re-read because the branch stock just changed.
      setRevision(value => value + 1);
    } catch (failure) {
      if (!mounted.current || lifetime.current.signal.aborted) return;
      const code: SalesErrorCode = failure instanceof SalesAPIError ? failure.code : 'invalid_response';
      const mismatch = failure instanceof SalesAPIError ? failure.mismatch : null;
      const variantID = failure instanceof SalesAPIError ? failure.variantId : null;
      if (code === 'payments_mismatch' && mismatch !== null) {
        setProblem(mismatch.side === 'missing'
          ? `Faltan ${formatMoney(moneyCents(mismatch.amount))} para cubrir el total.`
          : `Sobran ${formatMoney(moneyCents(mismatch.amount))}: la suma no puede superar el total.`);
        return;
      }
      const named = variantID === null ? null : cart.find(line => line.variant_id === variantID) ?? null;
      if (named !== null && lineRefusals[code] !== undefined) {
        setProblem(`${variantLabel(named)}: ${lineRefusals[code]} No se registró nada.`);
        return;
      }
      setProblem(salesErrorMessages[code]);
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return <section className="point-of-sale" aria-labelledby="point-of-sale-title">
    <header className="pos-heading">
      <small>SUCURSAL / PUNTO DE VENTA</small>
      <h1 id="point-of-sale-title">Nueva venta</h1>
      <p>{`Sólo las baterías con precio cargado en ${branch} se pueden vender. El precio mínimo es un piso: por debajo de él la venta se rechaza.`}</p>
    </header>
    <div className="pos-layout">
      <section className="pos-panel pos-catalogue" aria-labelledby="pos-catalogue-title" aria-busy={state.phase === 'loading'}>
        <div className="pos-panel-head">
          <div>
            <h2 id="pos-catalogue-title">Baterías</h2>
            <p className="pos-hint">{`${total} ${total === 1 ? 'variante' : 'variantes'} · las que no tienen precio quedan bloqueadas`}</p>
          </div>
          <span className="pos-tag">{state.phase === 'ready' ? `${items.length} en esta página` : 'Sucursal'}</span>
        </div>
        <div className="pos-filters">
          <label htmlFor="pos-search">Buscar batería
            <input id="pos-search" type="search" value={search} placeholder="Marca o modelo" disabled={busy}
              onChange={event => { setPageNumber(1); setSearch(event.target.value); }} />
          </label>
          <label htmlFor="pos-brand">Marca
            <select id="pos-brand" value={brand} disabled={busy}
              onChange={event => { setPageNumber(1); setBrand(event.target.value); }}>
              <option value="">Todas</option>
              {brands.map(value => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label htmlFor="pos-capacity">Capacidad
            <select id="pos-capacity" value={capacity} disabled={busy}
              onChange={event => { setPageNumber(1); setCapacity(event.target.value); }}>
              <option value="">Todas</option>
              {capacities.map(value => <option key={value} value={value}>{value} Ah</option>)}
            </select>
          </label>
          <label htmlFor="pos-polarity">Polaridad
            <select id="pos-polarity" value={polarity} disabled={busy}
              onChange={event => { setPageNumber(1); setPolarity(event.target.value as '' | 'L' | 'R'); }}>
              <option value="">Todas</option>
              <option value="L">Izquierda [L]</option>
              <option value="R">Derecha [R]</option>
            </select>
          </label>
        </div>
        {items.length > 0 && <div className="pos-cards">{items.map(item => {
          const label = variantLabel(item);
          const reasonID = blockedReason(item.variant_id);
          return <article className={'pos-card' + (item.sellable ? '' : ' blocked')} key={item.variant_id}
            data-variant-id={item.variant_id}>
            <h3>{`${item.brand} ${item.model}`}</h3>
            <div className="pos-meta">
              <span className="pos-tag">{`${item.capacity_ah} Ah`}</span>
              <span className="pos-tag">{item.polarity}</span>
            </div>
            <div className="pos-figures">
              <span className="pos-price">{item.sellable && item.suggested_price !== null
                ? formatMoney(moneyCents(item.suggested_price)) : 'Bs —'}</span>
              <span className="pos-stock">{`${item.available.toString()} disp.`}</span>
            </div>
            {!item.sellable && <p className="pos-banner" id={reasonID}>{posNotSellableReason}</p>}
            <button type="button" className="primary" disabled={!item.sellable || busy}
              aria-describedby={item.sellable ? undefined : reasonID}
              onClick={() => add(item)}>Agregar a la venta</button>
            {!item.sellable && <small>No vendible</small>}
          </article>;
        })}</div>}
        {state.phase === 'loading' && <p className="pos-message" role="status">Consultando el catálogo vendible…</p>}
        {state.phase === 'error' && <p className="pos-message" role="alert">{state.problem}
          <button type="button" disabled={busy} onClick={() => setRevision(value => value + 1)}>Reintentar catálogo vendible</button>
        </p>}
        {state.phase === 'ready' && items.length === 0 && <p className="pos-message">Sin baterías para esta consulta.</p>}
        <footer className="pager" aria-label="Paginación del catálogo vendible">
          <span className="range" aria-live="polite">{state.page
            ? <>Mostrando <strong>{firstRow}–{lastRow}</strong> de <strong>{total}</strong> variantes</>
            : 'Sin resultados cargados.'}</span>
          <div className="page-controls">
            <label htmlFor="pos-page-size">Baterías por página</label>
            <select id="pos-page-size" value={pageSize} disabled={busy}
              onChange={event => {
                const next = Number(event.target.value);
                if (salesPageSizes.includes(next)) { setPageNumber(1); setPageSize(next); }
              }}>{salesPageSizes.map(value => <option key={value} value={value}>{value}</option>)}</select>
            <button type="button" disabled={busy || pageNumber <= 1} onClick={() => setPageNumber(value => Math.max(1, value - 1))}>Anterior página</button>
            <span className="current-page" aria-current="page">{pageNumber}</span>
            <button type="button" disabled={busy || state.page === null || pageNumber * pageSize >= total}
              onClick={() => setPageNumber(value => value + 1)}>Siguiente página</button>
          </div>
        </footer>
      </section>

      <aside className="pos-cart" aria-labelledby="pos-cart-title">
        <section className="pos-panel">
          <h2 id="pos-cart-title">Venta en curso <span className="pos-tag">{`${cart.length} ${cart.length === 1 ? 'línea' : 'líneas'}`}</span></h2>
          <div className="pos-lines">{cart.map(line => {
            const label = variantLabel(line);
            const draft = draftFor(line);
            const adjusted = line.suggested_price_cents > line.unit_price_cents;
            return <div className="pos-line" key={line.variant_id}>
              <div className="pos-line-head">
                <div><strong>{`${line.brand} ${line.model}`}</strong><small>{`${line.capacity_ah} Ah · ${line.polarity}`}</small></div>
                <span className="pos-num">{formatMoney(line.unit_price_cents * BigInt(line.quantity))}</span>
              </div>
              <div className="pos-line-controls">
                <div className="pos-qty">
                  <button type="button" aria-label={`Restar una unidad de ${label}`} disabled={busy}
                    onClick={() => step(line, -1)}>−</button>
                  <input aria-label={`Cantidad de ${label}`} inputMode="numeric" value={draft.quantity} disabled={busy}
                    onChange={event => typeQuantity(line, event.target.value)} />
                  <button type="button" aria-label={`Sumar una unidad de ${label}`} disabled={busy}
                    onClick={() => step(line, 1)}>+</button>
                </div>
                <label htmlFor={`pos-warranty-${line.variant_id}`}>Garantía (meses)
                  <input id={`pos-warranty-${line.variant_id}`} aria-label={`Garantía en meses de ${label}`}
                    inputMode="numeric" value={draft.warranty} disabled={busy}
                    onChange={event => typeWarranty(line, event.target.value)} />
                </label>
              </div>
              <label htmlFor={`pos-price-${line.variant_id}`}>Precio unitario
                <input id={`pos-price-${line.variant_id}`} aria-label={`Precio unitario de ${label}`}
                  inputMode="decimal" value={draft.price} disabled={busy}
                  onChange={event => typePrice(line, event.target.value)} />
              </label>
              <small className="pos-hint">{`Mínimo autorizado ${formatMoney(line.min_price_cents)}`}
                {adjusted && ` · ajustado ${formatMoney(line.suggested_price_cents - line.unit_price_cents)} por debajo del sugerido`}</small>
              <button type="button" className="pos-remove" aria-label={`Quitar ${label}`} disabled={busy}
                onClick={() => remove(line.variant_id)}>Quitar</button>
            </div>;
          })}</div>
          <div className="pos-totals">
            {cart.map(line => <div className="pos-row" key={line.variant_id}>
              <span className="pos-hint">{`${line.quantity} × ${line.brand} ${line.model}`}</span>
              <span>{formatMoney(line.unit_price_cents * BigInt(line.quantity))}</span>
            </div>)}
            <div className="pos-row pos-grand"><span>Total</span><span>{formatMoney(saleTotal)}</span></div>
          </div>
          <fieldset className="pos-payments">
            <legend>{`Formas de pago · total ${formatMoney(saleTotal)}`}</legend>
            <label htmlFor="pos-payment-cash">Efectivo
              <input id="pos-payment-cash" inputMode="decimal" value={payDrafts.cash} disabled={busy}
                onChange={event => typePayment('cash', event.target.value)} />
            </label>
            <label htmlFor="pos-payment-transfer">Transferencia
              <input id="pos-payment-transfer" inputMode="decimal" value={payDrafts.transfer} disabled={busy}
                onChange={event => typePayment('transfer', event.target.value)} />
            </label>
          </fieldset>
          <div className="pos-pay-sum">
            <span className={open.status === 'exact' ? 'pos-tag ok' : 'pos-tag short'}>{moneySumMessage(saleTotal, split)}</span>
            <button type="button" className="pos-rest" disabled={busy || fillRemaining(split, saleTotal) === null}
              onClick={rest}>Resto</button>
          </div>
          <p className="pos-hint">Un solo monto es una venta normal; más de uno queda como Mixto. Si la suma no es exactamente el total, el cobro queda deshabilitado.</p>
          <div className="pos-customer">
            <label htmlFor="pos-customer-name">Cliente
              <input id="pos-customer-name" value={customer.name} disabled={busy} autoComplete="off" maxLength={120}
                onChange={event => setCustomer({ ...customer, name: event.target.value })} />
            </label>
            <label htmlFor="pos-customer-phone">Teléfono
              <input id="pos-customer-phone" inputMode="tel" value={customer.phone} disabled={busy} maxLength={40}
                onChange={event => setCustomer({ ...customer, phone: event.target.value })} />
            </label>
            <label htmlFor="pos-customer-document">Documento
              <input id="pos-customer-document" inputMode="numeric" value={customer.document} disabled={busy} maxLength={40}
                onChange={event => setCustomer({ ...customer, document: event.target.value })} />
            </label>
          </div>
          <button type="button" className="primary pos-charge" disabled={!canCharge} onClick={() => void charge()}>Cobrar y emitir garantía</button>
          {problem !== '' && <p className="pos-status" role="alert">{problem}</p>}
          {hint !== '' && <p className="pos-hint" role="status">{hint}</p>}
        </section>

        {issued !== null && <section className="pos-issued" aria-labelledby="pos-issued-title">
          <h3 id="pos-issued-title">Venta emitida</h3>
          <span className="pos-issued-number">{`Venta #${issued.branch_sequence} · Garantía ${issued.warranty_number}`}</span>
          <small><TransferDate value={issued.created_at} />
            {` · ${issued.lines.length} ${issued.lines.length === 1 ? 'línea' : 'líneas'} · ${formatMoney(moneyCents(issued.total))}`}
          </small>
          <small>{paymentBreakdown(issued.payments)}</small>
          <div className="pos-issued-actions">
            <a className="primary pos-pdf" href={warrantyPath(issued.id)} download>Descargar PDF</a>
          </div>
        </section>}
      </aside>
    </div>
  </section>;
}
