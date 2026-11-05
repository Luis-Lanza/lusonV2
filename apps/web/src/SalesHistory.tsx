import { useEffect, useMemo, useRef, useState } from 'react';
import TransferDate from './TransferDate';
import { formatMoney, moneyCents, paymentLabel, type SaleCustomer } from './pointOfSaleModel';
import {
  SalesAPIError, createSalesAPI, salesDefaultPageSize, salesErrorMessages, salesHistoryUnavailable, salesPageSizes,
  warrantyPath, type SaleDetail, type SalesPage, type SalesErrorCode,
} from './salesAPI';
import './point-of-sale.css';

interface HistoryState {
  readonly phase: 'loading' | 'ready' | 'error';
  readonly page: SalesPage | null;
  readonly problem: string;
}
/** The document unfolded under its own row, or the reason it could not be read. */
interface OpenDocument {
  readonly id: number;
  readonly phase: 'loading' | 'ready' | 'error';
  readonly detail: SaleDetail | null;
  readonly problem: string;
}

type PaymentFilter = '' | 'cash' | 'card' | 'transfer' | 'mixed';
const paymentFilters: readonly PaymentFilter[] = ['', 'cash', 'transfer', 'card', 'mixed'];

export interface SalesHistoryProps {
  branch?: string;
  fetcher?: typeof globalThis.fetch;
}

const customerLine = (customer: SaleCustomer): string =>
  [customer.phone, customer.document].filter(part => part !== '').join(' · ');

export default function SalesHistory({ branch = 'esta sucursal', fetcher = globalThis.fetch }: SalesHistoryProps) {
  const api = useMemo(() => createSalesAPI(fetcher), [fetcher]);
  const [search, setSearch] = useState('');
  const [method, setMethod] = useState<PaymentFilter>('');
  const [pageNumber, setPageNumber] = useState(1);
  const [pageSize, setPageSize] = useState(salesDefaultPageSize);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<HistoryState>({ phase: 'loading', page: null, problem: salesHistoryUnavailable });
  const [open, setOpen] = useState<OpenDocument | null>(null);
  const lifetime = useRef(new AbortController());
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const flight = new AbortController();
    lifetime.current = flight;
    return () => { mounted.current = false; flight.abort(); };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const alive = () => mounted.current && !controller.signal.aborted && !lifetime.current.signal.aborted;
    setState(current => ({ phase: 'loading', page: current.page, problem: salesHistoryUnavailable }));
    void (async () => {
      try {
        const page = await api.history({ search, payment_method: method, page: pageNumber, page_size: pageSize },
          controller.signal);
        if (!alive()) return;
        setState({ phase: 'ready', page, problem: '' });
      } catch (failure) {
        if (!alive()) return;
        const code: SalesErrorCode = failure instanceof SalesAPIError ? failure.code : 'invalid_response';
        const message = code === 'unauthenticated' ? salesErrorMessages.unauthenticated
          : code === 'forbidden' ? salesErrorMessages.forbidden : salesHistoryUnavailable;
        setState({ phase: 'error', page: null, problem: message });
      }
    })();
    return () => controller.abort();
  }, [api, search, method, pageNumber, pageSize, revision]);

  const sales = state.page?.sales ?? [];
  const total = state.page?.total_sales ?? 0;
  const firstRow = state.page && sales.length > 0 ? (state.page.page - 1) * state.page.page_size + 1 : 0;
  const lastRow = state.page && sales.length > 0 ? firstRow + sales.length - 1 : 0;

  async function unfold(id: number) {
    if (open?.id === id) { setOpen(null); return; }
    setOpen({ id, phase: 'loading', detail: null, problem: '' });
    try {
      const detail = await api.detail(id, lifetime.current.signal);
      if (!mounted.current || lifetime.current.signal.aborted) return;
      setOpen(current => current?.id === id ? { id, phase: 'ready', detail, problem: '' } : current);
    } catch (failure) {
      if (!mounted.current || lifetime.current.signal.aborted) return;
      const code: SalesErrorCode = failure instanceof SalesAPIError ? failure.code : 'invalid_response';
      const message = code === 'unauthenticated' ? salesErrorMessages.unauthenticated
        : code === 'forbidden' ? salesErrorMessages.forbidden : salesErrorMessages[code];
      setOpen(current => current?.id === id ? { id, phase: 'error', detail: null, problem: message } : current);
    }
  }

  return <section className="point-of-sale sales-history" aria-labelledby="sales-history-title">
    <header className="pos-heading">
      <small>SUCURSAL / PUNTO DE VENTA</small>
      <h1 id="sales-history-title">Historial de ventas</h1>
      <p>{`Todas las ventas de ${branch}, de la más nueva a la más vieja. Cada una conserva el precio y el plazo que se cobraron ese día, y su garantía se descarga desde la misma fila.`}</p>
    </header>
    <section className="pos-panel" aria-labelledby="sales-history-list" aria-busy={state.phase === 'loading'}>
      <div className="pos-panel-head">
        <div>
          <h2 id="sales-history-list">Ventas emitidas</h2>
          <p className="pos-hint">{`${total} ${total === 1 ? 'venta' : 'ventas'} · el detalle se despliega en su fila`}</p>
        </div>
        <span className="pos-tag">{state.phase === 'ready' ? `${sales.length} en esta página` : 'Sucursal'}</span>
      </div>
      <div className="pos-filters pos-history-filters">
        <label htmlFor="sales-search">Buscar venta
          <input id="sales-search" type="search" value={search} placeholder="Número de garantía o cliente"
            onChange={event => { setPageNumber(1); setSearch(event.target.value); }} />
        </label>
        <label htmlFor="sales-payment">Forma de pago
          <select id="sales-payment" value={method}
            onChange={event => { setPageNumber(1); setMethod(event.target.value as PaymentFilter); }}>
            {paymentFilters.map(value => <option key={value || 'all'} value={value}>{value === '' ? 'Todas' : paymentLabel(value)}</option>)}
          </select>
        </label>
      </div>
      {sales.length > 0 && <div className="pos-table-wrap">
        <table className="sales-table">
          <caption className="sr-only">Ventas de {branch}, de la más nueva a la más vieja</caption>
          <thead><tr>
            <th scope="col">Venta</th><th scope="col">Garantía</th><th scope="col">Fecha y hora</th>
            <th scope="col">Cliente</th><th scope="col">Forma de pago</th><th scope="col" className="num">Líneas</th>
            <th scope="col" className="num">Total</th><th scope="col">Acciones</th>
          </tr></thead>
          <tbody>{sales.map(sale => {
            const unfolded = open?.id === sale.id;
            const detailID = `sales-detail-${sale.id}`;
            return [
              <tr key={`row-${sale.id}`} className="sales-row" id={`sales-row-${sale.id}`} aria-expanded={unfolded}
                aria-controls={detailID}>
                <td data-label="Venta" className="pos-doc">{`#${sale.branch_sequence}`}</td>
                <td data-label="Garantía" className="pos-doc">{sale.warranty_number}</td>
                <td data-label="Fecha y hora"><TransferDate value={sale.created_at} /></td>
                <td data-label="Cliente">{sale.customer_name}</td>
                <td data-label="Forma de pago"><span className={`pos-tag ${sale.payment_method}`}>{paymentLabel(sale.payment_method)}</span></td>
                <td data-label="Líneas" className="num">{sale.lines}</td>
                <td data-label="Total" className="num">{formatMoney(moneyCents(sale.total))}</td>
                <td data-label="Acciones"><div className="sales-actions">
                  <button type="button" className="pos-quiet" aria-label={`Ver la venta ${sale.branch_sequence}`}
                    aria-expanded={unfolded} aria-controls={detailID}
                    onClick={() => void unfold(sale.id)}>{unfolded ? 'Cerrar' : 'Ver'}</button>
                  <a className="pos-quiet" href={warrantyPath(sale.id)} download
                    aria-label={`Descargar la garantía ${sale.warranty_number}`}>PDF</a>
                </div></td>
              </tr>,
              <tr key={`detail-${sale.id}`} id={detailID} className="sales-detail" hidden={!unfolded}>
                <td colSpan={8}>{unfolded && open &&
                  <section className="sales-detail-inner" aria-label={`Venta ${sale.branch_sequence}`}>
                    {open.phase === 'loading' && <p className="pos-message" role="status">Consultando la venta…</p>}
                    {open.phase === 'error' && <p className="pos-message" role="alert">{open.problem}</p>}
                    {open.phase === 'ready' && open.detail && <>
                      <header>
                        <h3>{`Venta #${open.detail.branch_sequence} · Garantía ${open.detail.warranty_number}`}</h3>
                        <p className="pos-hint"><TransferDate value={open.detail.created_at} />
                          {` · ${open.detail.customer.name}${customerLine(open.detail.customer) === '' ? '' : ` · ${customerLine(open.detail.customer)}`}`}
                        </p>
                      </header>
                      <div className="pos-table-wrap">
                        <table className="sales-detail-lines">
                          <caption className="sr-only">Líneas de la venta {open.detail.branch_sequence}</caption>
                          <thead><tr>
                            <th scope="col">Batería</th><th scope="col">Cantidad</th><th scope="col">Precio unitario</th>
                            <th scope="col">Plazo</th><th scope="col" className="num">Subtotal</th>
                          </tr></thead>
                          <tbody>{open.detail.lines.map(line => <tr key={line.variant_id}>
                            <td data-label="Batería">
                              <strong>{`${line.brand} ${line.model}`}</strong>
                              <small>{`${line.capacity_ah} Ah · ${line.polarity}`}</small>
                            </td>
                            <td data-label="Cantidad">{`${line.quantity} × ${formatMoney(moneyCents(line.unit_price))}`}</td>
                            <td data-label="Precio unitario">{formatMoney(moneyCents(line.unit_price))}
                              <small>{`Mínimo al vender ${formatMoney(moneyCents(line.min_price))}`}</small></td>
                            <td data-label="Plazo">{`${line.warranty_months} meses`}</td>
                            <td data-label="Subtotal" className="num">{formatMoney(moneyCents(line.subtotal))}</td>
                          </tr>)}</tbody>
                        </table>
                      </div>
                      <div className="sales-detail-payments">
                        <div>
                          <h4>Formas de pago</h4>
                          <ul>{open.detail.payments.map(payment => <li key={payment.method}>
                            <span>{paymentLabel(payment.method)}</span>
                            <span className="pos-num">{formatMoney(moneyCents(payment.amount))}</span>
                          </li>)}</ul>
                        </div>
                        <div className="pos-row pos-grand"><span>Total</span>
                          <span>{formatMoney(moneyCents(open.detail.total))}</span></div>
                      </div>
                    </>}
                  </section>}
                </td>
              </tr>,
            ];
          })}</tbody>
        </table>
      </div>}
      {state.phase === 'loading' && <p className="pos-message" role="status">Consultando el historial de ventas…</p>}
      {state.phase === 'error' && <p className="pos-message" role="alert">{state.problem}
        <button type="button" onClick={() => setRevision(value => value + 1)}>Reintentar historial</button>
      </p>}
      {state.phase === 'ready' && sales.length === 0 && <p className="pos-message">Sin ventas para esta consulta.</p>}
      <footer className="pager" aria-label="Paginación del historial de ventas">
        <span className="range" aria-live="polite">{state.page
          ? <>Mostrando <strong>{firstRow}–{lastRow}</strong> de <strong>{total}</strong> ventas</>
          : 'Sin resultados cargados.'}</span>
        <div className="page-controls">
          <label htmlFor="sales-page-size">Ventas por página</label>
          <select id="sales-page-size" value={pageSize}
            onChange={event => {
              const next = Number(event.target.value);
              if (salesPageSizes.includes(next)) { setPageNumber(1); setPageSize(next); }
            }}>{salesPageSizes.map(value => <option key={value} value={value}>{value}</option>)}</select>
          <button type="button" aria-label="Página anterior" disabled={pageNumber <= 1}
            onClick={() => setPageNumber(value => Math.max(1, value - 1))}>‹<span>Anterior</span></button>
          <span className="current-page" aria-current="page">{pageNumber}</span>
          <button type="button" aria-label="Página siguiente" disabled={state.page === null || pageNumber * pageSize >= total}
            onClick={() => setPageNumber(value => value + 1)}><span>Siguiente</span>›</button>
        </div>
      </footer>
      <p className="pos-hint">El historial es de la sucursal de la sesión: otra sucursal nunca ve estas ventas. El precio cobrado y el plazo de cada línea quedan congelados en el documento, así que cambiar un precio hoy no altera una venta de ayer.</p>
    </section>
  </section>;
}
