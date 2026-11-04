import { useEffect, useMemo, useRef, useState } from 'react';
import TransferDate from './TransferDate';
import { CatalogPricesAPIError, createCatalogPricesAPI } from './catalogPricesAPI';
import {
  branchTag, catalogAmountEntry, catalogPricesDefaultPageSize, catalogPricesErrorMessages, catalogPricesListUnavailable,
  catalogPricesPageSizes, formatCatalogMoney, polaritiesLabel, sharedPriceLabel, validateCatalogPriceDraft,
  type CatalogBattery, type CatalogPricesErrorCode, type CatalogPricesPage, type CatalogPricesQuery,
} from './catalogPricesModel';
import './catalog-prices.css';

interface PricesState { readonly phase: 'loading' | 'ready' | 'error'; readonly page: CatalogPricesPage | null; readonly problem: string }
/** The unfolded row: which battery, and the draft its form currently holds. */
interface OpenRow { readonly entryId: number; readonly draft: Draft }
interface Draft {
  readonly min: string; readonly suggested: string; readonly checked: readonly number[];
}

export interface CatalogPricesProps {
  // The parent remounts this section per session fence, so a rotated session or
  // CSRF token can never publish a price block into a newer warehouse session.
  csrf: string;
  brands?: readonly string[];
  fetcher?: typeof globalThis.fetch;
}

const productLabel = (row: { brand: string; model: string }) => `${row.brand} · ${row.model}`;
const branchWord = (count: number) => count === 1 ? 'sucursal' : 'sucursales';

export default function CatalogPrices({ csrf, brands = [], fetcher = globalThis.fetch }: CatalogPricesProps) {
  const api = useMemo(() => createCatalogPricesAPI(fetcher), [fetcher]);
  const [search, setSearch] = useState('');
  const [brand, setBrand] = useState('');
  const [capacity, setCapacity] = useState('');
  const [pageNumber, setPageNumber] = useState(1);
  const [pageSize, setPageSize] = useState(catalogPricesDefaultPageSize);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<PricesState>({ phase: 'loading', page: null, problem: catalogPricesListUnavailable });
  const [open, setOpen] = useState<OpenRow | null>(null);
  const [problem, setProblem] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const lifetime = useRef(new AbortController());
  const mounted = useRef(true);
  const pending = useRef(false);
  const rowRefs = useRef(new Map<number, HTMLTableRowElement>());

  useEffect(() => {
    mounted.current = true;
    const flight = new AbortController();
    lifetime.current = flight;
    return () => { mounted.current = false; flight.abort(); };
  }, []);

  const query: CatalogPricesQuery = { search, brand, capacity, page: pageNumber, page_size: pageSize };
  useEffect(() => {
    const controller = new AbortController();
    const alive = () => mounted.current && !controller.signal.aborted && !lifetime.current.signal.aborted;
    setState(current => ({ phase: 'loading', page: current.page, problem: catalogPricesListUnavailable }));
    void (async () => {
      try {
        const page = await api.list({ search, brand, capacity, page: pageNumber, page_size: pageSize }, controller.signal);
        if (!alive()) return;
        setState({ phase: 'ready', page, problem: '' });
      } catch (failure) {
        if (!alive()) return;
        const code: CatalogPricesErrorCode = failure instanceof CatalogPricesAPIError ? failure.code : 'invalid_response';
        const message = code === 'unauthenticated' ? catalogPricesErrorMessages.unauthenticated
          : code === 'forbidden' ? catalogPricesErrorMessages.forbidden : catalogPricesListUnavailable;
        setState({ phase: 'error', page: null, problem: message });
      }
    })();
    return () => controller.abort();
  }, [api, search, brand, capacity, pageNumber, pageSize, revision]);

  const page = state.page;
  const branches = page?.branches ?? [];
  const batteries = page?.batteries ?? [];
  const capacities = useMemo(() => {
    const present = [...new Set(batteries.map(battery => battery.capacity_ah))];
    if (capacity !== '' && !present.includes(capacity)) present.push(capacity);
    return present.sort((left, right) => Number(left) - Number(right));
  }, [batteries, capacity]);
  const total = page?.total_batteries ?? 0;
  const firstRow = page && batteries.length > 0 ? (page.page - 1) * page.page_size + 1 : 0;
  const lastRow = page && batteries.length > 0 ? firstRow + batteries.length - 1 : 0;
  const current = open === null ? null : batteries.find(battery => battery.catalog_entry_id === open.entryId) ?? null;

  /** The draft an unfolded row starts with: its first persisted pair and its priced branches. */
  function draftFor(battery: CatalogBattery, matrix: readonly { id: number }[]): Draft {
    const priced = matrix
      .map(branch_ => battery.prices.find(price => price.branch_location_id === branch_.id))
      .filter((price): price is NonNullable<typeof price> => price !== undefined);
    const first = priced[0];
    return {
      min: first ? catalogAmountEntry(first.min_price) : '',
      suggested: first ? catalogAmountEntry(first.suggested_price) : '',
      checked: priced.map(price => price.branch_location_id),
    };
  }

  function toggle(battery: CatalogBattery) {
    if (busy) return;
    setProblem(''); setNotice('');
    if (open?.entryId === battery.catalog_entry_id) { setOpen(null); return; }
    setOpen({ entryId: battery.catalog_entry_id, draft: draftFor(battery, branches) });
  }
  function close(entryId: number) {
    if (busy) return;
    setOpen(null); setProblem('');
    // Cancelar returns the reader to the row it came from.
    rowRefs.current.get(entryId)?.focus();
  }
  function edit(patch: Partial<Draft>) {
    setProblem('');
    setOpen(current_ => current_ === null ? null : { ...current_, draft: { ...current_.draft, ...patch } });
  }
  function toggleBranch(branchId: number, checked: boolean) {
    if (!open) return;
    const next = checked ? [...open.draft.checked, branchId] : open.draft.checked.filter(id => id !== branchId);
    edit({ checked: next });
  }

  async function apply(battery: CatalogBattery) {
    if (busy || pending.current || !open || open.entryId !== battery.catalog_entry_id) return;
    const validation = validateCatalogPriceDraft(battery.catalog_entry_id, {
      min_price: open.draft.min, suggested_price: open.draft.suggested, branch_ids: open.draft.checked,
    });
    setNotice('');
    if (!validation.valid) { setProblem(validation.message); return; }
    pending.current = true; setBusy(true); setProblem('');
    try {
      const result = await api.apply(validation.input, csrf, lifetime.current.signal);
      if (!mounted.current || lifetime.current.signal.aborted) return;
      setOpen(null);
      // The matrix is re-read so the chips and the per-branch values show what was written.
      setRevision(value => value + 1);
      setNotice(`Precios aplicados: ${productLabel(battery)} · mínimo ${formatCatalogMoney(result.min_price)} · sugerido ${formatCatalogMoney(result.suggested_price)} en ${result.written} ${branchWord(result.written)}.`);
    } catch (failure) {
      if (!mounted.current || lifetime.current.signal.aborted) return;
      const code: CatalogPricesErrorCode = failure instanceof CatalogPricesAPIError ? failure.code : 'invalid_response';
      const retired = failure instanceof CatalogPricesAPIError ? failure.branchId : null;
      // The typed values stay in the draft: only the message — and, when the server
      // names a retired branch, that one checkbox — is replaced.
      if (code === 'retired_branch' && retired !== null) {
        const named = branches.find(branch_ => branch_.id === retired);
        edit({ checked: open.draft.checked.filter(id => id !== retired) });
        setProblem(`La sucursal ${named ? named.name : `#${retired}`} fue retirada: quitala de la lista y volvé a intentar. No se escribió ningún precio.`);
        return;
      }
      setProblem(catalogPricesErrorMessages[code]);
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  const replaced = open === null || current === null ? 0 : open.draft.checked
    .filter(id => current.prices.some(price => price.branch_location_id === id)).length;
  const latest = (battery: CatalogBattery) => battery.prices.reduce<(typeof battery.prices)[number] | null>(
    (newest, price) => newest === null || Date.parse(price.updated_at) >= Date.parse(newest.updated_at) ? price : newest, null);

  return <section className="catalog-prices" aria-labelledby="catalog-prices-title">
    <header className="catalog-heading">
      <small>ALMACÉN / CATÁLOGO</small>
      <h1 id="catalog-prices-title">Catálogo de precios</h1>
      <p>El Almacén define el precio mínimo y el sugerido de cada batería y elige a qué sucursales se les aplica. El precio vale para las dos polaridades de la batería y cada sucursal mantiene sus propios valores.</p>
    </header>
    <section className="catalog-panel" aria-labelledby="catalog-list-title" aria-busy={state.phase === 'loading'}>
      <div className="catalog-panel-head">
        <div>
          <h2 id="catalog-list-title">Baterías</h2>
          <p className="catalog-hint">{`${total} ${total === 1 ? 'batería' : 'baterías'} · desplegá una batería para cargar o cambiar sus precios`}</p>
        </div>
        <span className="catalog-tag">{state.phase === 'ready' ? `${batteries.length} en esta página` : 'Almacén'}</span>
      </div>
      <div className="catalog-filters">
        <label htmlFor="catalog-search">Buscar marca o modelo
          <input id="catalog-search" type="search" value={search} placeholder="NS40ZL, TOYO" disabled={busy}
            onChange={event => { setPageNumber(1); setSearch(event.target.value); }} />
        </label>
        <label htmlFor="catalog-brand">Marca
          <select id="catalog-brand" value={brand} onChange={event => { setPageNumber(1); setBrand(event.target.value); }}>
            <option value="">Todas</option>
            {brands.map(value => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <label htmlFor="catalog-capacity">Capacidad
          <select id="catalog-capacity" value={capacity} onChange={event => { setPageNumber(1); setCapacity(event.target.value); }}>
            <option value="">Todas</option>
            {capacities.map(value => <option key={value} value={value}>{value} Ah</option>)}
          </select>
        </label>
      </div>
      {batteries.length > 0 && <div className="catalog-table-wrap">
        <table className="catalog-table">
          <caption className="sr-only">Baterías del catálogo de precios, con sus polaridades, sus sucursales y su última actualización</caption>
          <thead><tr>
            <th scope="col">Batería</th><th scope="col">Sucursales con precio</th>
            <th scope="col">Última actualización</th><th scope="col">Acción</th>
          </tr></thead>
          <tbody>{batteries.map(battery => {
            const expanded = open?.entryId === battery.catalog_entry_id;
            const detailId = `catalog-detail-${battery.catalog_entry_id}`;
            const rowId = `catalog-row-${battery.catalog_entry_id}`;
            const updated = latest(battery);
            return [
              <tr key={`row-${battery.catalog_entry_id}`} id={rowId} className="catalog-row" tabIndex={0}
                aria-expanded={expanded} aria-controls={detailId}
                ref={element => { if (element) rowRefs.current.set(battery.catalog_entry_id, element); else rowRefs.current.delete(battery.catalog_entry_id); }}
                onClick={() => toggle(battery)}
                onKeyDown={event => {
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault(); toggle(battery);
                }}>
                <td data-label="Batería"><strong>{battery.brand} {battery.model}</strong>
                  <small>{battery.capacity_ah} Ah · {polaritiesLabel(battery.polarities)}</small></td>
                <td data-label="Sucursales con precio"><div className="catalog-chips">{branches.map(branch_ => {
                  const price = battery.prices.find(entry => entry.branch_location_id === branch_.id);
                  return price
                    ? <span key={branch_.id} className="catalog-chip ok" title={`${branch_.name}: mínimo ${formatCatalogMoney(price.min_price)} · sugerido ${formatCatalogMoney(price.suggested_price)}`}>{branchTag(branch_.name)}</span>
                    : <span key={branch_.id} className="catalog-chip short" title={`${branch_.name}: sin precio`}>{branchTag(branch_.name)} sin precio</span>;
                })}</div></td>
                <td data-label="Última actualización">{updated
                  ? <><TransferDate value={updated.updated_at} />{updated.updated_by_display_name !== ''
                    && <small>{updated.updated_by_display_name}</small>}</>
                  : <small>Sin precio cargado</small>}</td>
                <td data-label="Acción"><span className="catalog-openaction">{expanded ? 'Cerrar −' : 'Desplegar +'}</span></td>
              </tr>,
              <tr key={`detail-${battery.catalog_entry_id}`} id={detailId} className="catalog-detail" hidden={!expanded}>
                <td colSpan={4}>{expanded && open && current !== null && current.catalog_entry_id === battery.catalog_entry_id &&
                  <div className="catalog-detail-inner">
                    <header>
                      <div>
                        <h3>Precios de {battery.brand} {battery.model}</h3>
                        <p>{battery.capacity_ah} Ah · {polaritiesLabel(battery.polarities)}
                          {battery.cells.length > 0 && ` · ${battery.cells.length} ${battery.cells.length === 1 ? 'celda de origen' : 'celdas de origen'} (${battery.cells.join(', ')})`}</p>
                      </div>
                      <span className="catalog-tag">Mínimo y sugerido por sucursal</span>
                    </header>
                    <p className="catalog-shared">{sharedPriceLabel(battery.polarities)}</p>
                    <div className="catalog-form">
                      <div>
                        <div className="catalog-pair">
                          <label htmlFor={`catalog-min-${battery.catalog_entry_id}`}>Precio mínimo de venta
                            <input id={`catalog-min-${battery.catalog_entry_id}`} inputMode="decimal" value={open.draft.min}
                              aria-describedby={`catalog-amounts-${battery.catalog_entry_id}`} disabled={busy}
                              onChange={event => edit({ min: event.target.value })} />
                          </label>
                          <label htmlFor={`catalog-suggested-${battery.catalog_entry_id}`}>Precio sugerido de venta
                            <input id={`catalog-suggested-${battery.catalog_entry_id}`} inputMode="decimal" value={open.draft.suggested}
                              aria-describedby={`catalog-amounts-${battery.catalog_entry_id}`} disabled={busy}
                              onChange={event => edit({ suggested: event.target.value })} />
                          </label>
                        </div>
                        <p id={`catalog-amounts-${battery.catalog_entry_id}`} className="catalog-hint">Montos con dos decimales. El sugerido nunca puede quedar por debajo del mínimo: por debajo del mínimo la sucursal no puede vender.</p>
                      </div>
                      <div>
                        <fieldset className="catalog-branches">
                          <legend>Sucursales a las que se aplica este precio</legend>
                          {branches.map(branch_ => {
                            const price = battery.prices.find(entry => entry.branch_location_id === branch_.id);
                            const checked = open.draft.checked.includes(branch_.id);
                            return <label key={branch_.id} className="catalog-branch">
                              <input type="checkbox" checked={checked} disabled={busy} aria-label={`Aplicar a ${branch_.name}`}
                                onChange={event => toggleBranch(branch_.id, event.target.checked)} />
                              <span><strong>{branch_.name}</strong><small>activo</small></span>
                              <span className="catalog-branch-values">{price
                                ? <><span>{`mín ${formatCatalogMoney(price.min_price)}`}</span><span>{`sug ${formatCatalogMoney(price.suggested_price)}`}</span></>
                                : <span>sin precio</span>}</span>
                            </label>;
                          })}
                        </fieldset>
                        <div className="catalog-note">
                          <strong>{replaced === 0
                            ? 'No se reemplaza ningún precio existente.'
                            : `Se van a reemplazar ${replaced} ${replaced === 1 ? 'precio existente' : 'precios existentes'}.`}</strong>{' '}
                          Las sucursales sin tildar no se tocan: las que hoy tienen precio quedan con este par mínimo/sugerido.
                        </div>
                        <div className="catalog-actions">
                          <button type="button" className="catalog-cancel" disabled={busy}
                            onClick={() => close(battery.catalog_entry_id)}>Cancelar</button>
                          <button type="button" className="primary" disabled={busy}
                            onClick={() => void apply(battery)}>{`Aplicar a ${open.draft.checked.length} ${branchWord(open.draft.checked.length)}`}</button>
                        </div>
                        {problem !== '' && <p role="alert" className="catalog-status">{problem}</p>}
                      </div>
                    </div>
                  </div>}
                </td>
              </tr>,
            ];
          })}</tbody>
        </table>
      </div>}
      {state.phase === 'loading' && <p className="catalog-message" role="status">Consultando el catálogo de precios…</p>}
      {state.phase === 'error' && <p className="catalog-message" role="alert">{state.problem}
        <button type="button" disabled={busy} onClick={() => setRevision(value => value + 1)}>Reintentar catálogo</button></p>}
      {state.phase === 'ready' && batteries.length === 0 && <p className="catalog-message">Sin baterías para esta consulta.</p>}
      <footer className="pager" aria-label="Paginación del catálogo de precios">
        <span className="range" aria-live="polite">{page ? <>Mostrando <strong>{firstRow}–{lastRow}</strong> de <strong>{total}</strong> baterías</> : 'Sin resultados cargados.'}</span>
        <div className="page-controls">
          <label htmlFor="catalog-page-size">Baterías por página</label>
          <select id="catalog-page-size" value={pageSize} disabled={busy}
            onChange={event => {
              const next = Number(event.target.value);
              if (catalogPricesPageSizes.includes(next)) { setPageNumber(1); setPageSize(next); }
            }}>{catalogPricesPageSizes.map(value => <option key={value} value={value}>{value}</option>)}</select>
          <button type="button" disabled={busy || pageNumber <= 1} onClick={() => setPageNumber(value => Math.max(1, value - 1))}>Anterior página</button>
          <span className="current-page" aria-current="page">{pageNumber}</span>
          <button type="button" disabled={busy || page === null || pageNumber * pageSize >= total}
            onClick={() => setPageNumber(value => value + 1)}>Siguiente página</button>
        </div>
      </footer>
      <p role="status" className="catalog-notice">{notice}</p>
      <p className="catalog-hint">Una fila por batería y un solo precio para sus polaridades. El formulario se despliega debajo de la fila elegida y se cierra con Cancelar.</p>
    </section>
  </section>;
}
