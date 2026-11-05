import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { CatalogBatteriesAPIError, createCatalogBatteriesAPI } from './catalogBatteriesAPI';
import {
  catalogBatteriesErrorMessages, catalogBatteriesListUnavailable, catalogBatteryPricingHint,
  catalogBatteryUnsellableLabel, pricedBranchesLabel, validateCatalogBatteryCreateDraft,
  validateCatalogBatteryIdentityDraft, variantsLabel,
  type CatalogBatteriesErrorCode, type CatalogBatteryPage, type CatalogBatteryRow, type CatalogPolarity,
} from './catalogBatteriesModel';
import { catalogPricesDefaultPageSize, catalogPricesPageSizes } from './catalogPricesModel';
// The catalogue's own layout, tokens and 44px targets: this screen adds no colour
// and no new spacing, so it reuses the price screen's sheet instead of a new one.
import './catalog-prices.css';

interface ListState { readonly phase: 'loading' | 'ready' | 'error'; readonly page: CatalogBatteryPage | null; readonly problem: string }
/** The drafted identity of a new battery, before it is validated. */
interface CreateDraft { readonly brand: string; readonly model: string; readonly capacity_ah: string; readonly polarities: readonly CatalogPolarity[] }
/** The editor of one listed battery: the complete identity it will write. */
interface EditDraft { readonly id: number; readonly brand: string; readonly model: string; readonly capacity_ah: string }
const emptyCreate: CreateDraft = { brand: '', model: '', capacity_ah: '', polarities: [] };
const polarities: readonly CatalogPolarity[] = ['L', 'R'];

export interface CatalogBatteriesProps {
  // The shell remounts this section per session fence, exactly like the price screen,
  // so a rotated session or CSRF token can never publish a battery into a newer one.
  csrf: string;
  fetcher?: typeof globalThis.fetch;
}

const productLabel = (row: { brand: string; model: string }) => `${row.brand} ${row.model}`;

export default function CatalogBatteries({ csrf, fetcher = globalThis.fetch }: CatalogBatteriesProps) {
  const api = useMemo(() => createCatalogBatteriesAPI(fetcher), [fetcher]);
  const [search, setSearch] = useState('');
  const [pageNumber, setPageNumber] = useState(1);
  const [pageSize, setPageSize] = useState(catalogPricesDefaultPageSize);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<ListState>({ phase: 'loading', page: null, problem: catalogBatteriesListUnavailable });
  const [create, setCreate] = useState<CreateDraft>(emptyCreate);
  const [edit, setEdit] = useState<EditDraft | null>(null);
  const [archive, setArchive] = useState<number | null>(null);
  const [createProblem, setCreateProblem] = useState('');
  const [editProblem, setEditProblem] = useState('');
  const [listProblem, setListProblem] = useState('');
  const [notice, setNotice] = useState('');
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
  // Every handler checks the same fence: a reply from an aborted or replaced mount
  // never mutates the state of the session that is reading now.
  const alive = () => mounted.current && !lifetime.current.signal.aborted;

  useEffect(() => {
    const controller = new AbortController();
    // The fence is read from the refs, so this effect depends on the query alone.
    const current = () => mounted.current && !lifetime.current.signal.aborted && !controller.signal.aborted;
    setState(previous => ({ phase: 'loading', page: previous.page, problem: catalogBatteriesListUnavailable }));
    void (async () => {
      try {
        const page = await api.list({ search, brand: '', capacity: '', page: pageNumber, page_size: pageSize }, controller.signal);
        if (!current()) return;
        setState({ phase: 'ready', page, problem: '' });
      } catch (failure) {
        if (!current()) return;
        const code: CatalogBatteriesErrorCode = failure instanceof CatalogBatteriesAPIError ? failure.code : 'invalid_response';
        const problem = code === 'unauthenticated' ? catalogBatteriesErrorMessages.unauthenticated
          : code === 'forbidden' ? catalogBatteriesErrorMessages.forbidden : catalogBatteriesListUnavailable;
        setState({ phase: 'error', page: null, problem });
      }
    })();
    return () => controller.abort();
  }, [api, search, pageNumber, pageSize, revision]);

  const page = state.page;
  const rows = page?.rows ?? [];
  const total = page?.total_batteries ?? 0;
  const firstRow = page && rows.length > 0 ? (page.page - 1) * page.page_size + 1 : 0;
  const lastRow = page && rows.length > 0 ? firstRow + rows.length - 1 : 0;

  function refused(failure: unknown): string {
    const code: CatalogBatteriesErrorCode = failure instanceof CatalogBatteriesAPIError ? failure.code : 'invalid_response';
    return catalogBatteriesErrorMessages[code];
  }
  function togglePolarity(tag: CatalogPolarity, checked: boolean) {
    setCreateProblem('');
    setCreate(current => ({
      ...current,
      polarities: checked ? [...current.polarities, tag] : current.polarities.filter(entry => entry !== tag),
    }));
  }

  async function createBattery(event: FormEvent) {
    event.preventDefault();
    if (pending.current || !alive()) return;
    const validation = validateCatalogBatteryCreateDraft(create);
    setNotice('');
    setListProblem('');
    setCreateProblem('');
    if (!validation.valid) { setCreateProblem(validation.message); return; }
    pending.current = true; setBusy(true);
    try {
      const record = await api.create(validation.input, csrf, lifetime.current.signal);
      if (!alive()) return;
      // The allocated id, the variant ids and the priced-branch count shown now are
      // the server's answer: nothing here was guessed by the client.
      setCreate(emptyCreate);
      setNotice(`Batería #${record.id} creada con las variantes ${variantsLabel(record.variants)}.`
        + (record.priced_branches === 0
          ? ` Todavía no es vendible: ${pricedBranchesLabel(0).toLowerCase()}. ${catalogBatteryPricingHint}`
          : ` ${pricedBranchesLabel(record.priced_branches)}.`));
      // Never assume the result: the list is read again.
      setRevision(value => value + 1);
    } catch (failure) {
      // The draft stays exactly as it was typed.
      if (alive()) setCreateProblem(refused(failure));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  function openEdit(row: CatalogBatteryRow) {
    if (busy || pending.current) return;
    setEditProblem(''); setListProblem(''); setNotice('');
    setArchive(null);
    setEdit({ id: row.id, brand: row.brand, model: row.model, capacity_ah: row.capacity_ah });
  }
  function openArchive(row: CatalogBatteryRow) {
    if (busy || pending.current) return;
    setEditProblem(''); setListProblem(''); setNotice('');
    setEdit(null);
    setArchive(row.id);
  }
  function closeEditor() {
    if (busy) return;
    setEdit(null); setEditProblem('');
  }

  async function saveEdit(event: FormEvent) {
    event.preventDefault();
    if (pending.current || !alive() || edit === null) return;
    const validation = validateCatalogBatteryIdentityDraft({
      brand: edit.brand, model: edit.model, capacity_ah: edit.capacity_ah,
    });
    setNotice('');
    setEditProblem('');
    if (!validation.valid) { setEditProblem(validation.message); return; }
    pending.current = true; setBusy(true);
    try {
      const record = await api.edit(edit.id, validation.input, csrf, lifetime.current.signal);
      if (!alive()) return;
      setEdit(null);
      setNotice(`Batería #${record.id} actualizada: ${productLabel(record)} · ${record.capacity_ah} Ah.`
        + (record.priced_branches === 0 ? ' Sigue sin precio en ninguna sucursal: no es vendible.' : ''));
      setRevision(value => value + 1);
    } catch (failure) {
      if (alive()) setEditProblem(refused(failure));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function archiveBattery(id: number) {
    if (pending.current || !alive() || archive !== id) return;
    pending.current = true; setBusy(true); setNotice(''); setListProblem('');
    try {
      await api.archive(id, csrf, lifetime.current.signal);
      if (!alive()) return;
      setArchive(null);
      // A 204 is the retirement itself: the battery has left the editable catalogue,
      // so it leaves this list at once and the list is read again to report the page
      // the server now holds. Retirement is one way: nothing here restores it.
      setState(current => current.page === null ? current : {
        ...current,
        page: { ...current.page, rows: current.page.rows.filter(row => row.id !== id) },
      });
      setNotice(`Batería #${id} archivada. No se puede volver a activar y deja de aparecer en el catálogo.`);
      setRevision(value => value + 1);
    } catch (failure) {
      // The confirmation closes so the operator reads the reason before retrying.
      if (alive()) { setArchive(null); setListProblem(refused(failure)); }
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return <section className="catalog-prices" aria-labelledby="catalog-batteries-title">
    <header className="catalog-heading">
      <small>ALMACÉN / CATÁLOGO</small>
      <h1 id="catalog-batteries-title">Baterías del catálogo</h1>
      <p>El Almacén crea, edita y archiva las baterías del catálogo. Crear una batería no la pone en venta: queda sin precio hasta que se cargue en el catálogo de precios.</p>
    </header>
    <section className="catalog-panel" aria-labelledby="catalog-batteries-create-title">
      <div className="catalog-panel-head">
        <div>
          <h2 id="catalog-batteries-create-title">Nueva batería</h2>
          <p className="catalog-hint">Marca, modelo, capacidad y al menos una polaridad. El identificador de la batería y el de cada variante los asigna el servidor.</p>
        </div>
        <span className="catalog-tag">Catálogo activo</span>
      </div>
      <form aria-busy={busy} onSubmit={event => void createBattery(event)}>
        <div className="catalog-pair">
          <label htmlFor="catalog-battery-brand">Marca
            <input id="catalog-battery-brand" value={create.brand} autoComplete="off" disabled={busy}
              onChange={event => { setCreateProblem(''); setCreate(current => ({ ...current, brand: event.target.value })); }} />
          </label>
          <label htmlFor="catalog-battery-model">Modelo
            <input id="catalog-battery-model" value={create.model} autoComplete="off" disabled={busy}
              onChange={event => { setCreateProblem(''); setCreate(current => ({ ...current, model: event.target.value })); }} />
          </label>
        </div>
        <div className="catalog-pair">
          <label htmlFor="catalog-battery-capacity">Capacidad (Ah)
            <input id="catalog-battery-capacity" inputMode="decimal" value={create.capacity_ah} autoComplete="off" disabled={busy}
              aria-describedby="catalog-battery-capacity-hint"
              onChange={event => { setCreateProblem(''); setCreate(current => ({ ...current, capacity_ah: event.target.value })); }} />
          </label>
        </div>
        <p id="catalog-battery-capacity-hint" className="catalog-hint">Capacidad positiva, hasta seis enteros y seis decimales. Se guarda normalizada: 045.50 queda como 45.5.</p>
        <fieldset className="catalog-branches">
          <legend>Polaridades en las que existe</legend>
          {polarities.map(tag => <label key={tag} className="catalog-branch">
            <input type="checkbox" checked={create.polarities.includes(tag)} disabled={busy}
              aria-label={`Polaridad ${tag}`} onChange={event => togglePolarity(tag, event.target.checked)} />
            <span><strong>{tag}</strong><small>{tag === 'L' ? 'Izquierda' : 'Derecha'}</small></span>
            <span className="catalog-branch-values"><span>{create.polarities.includes(tag) ? 'incluida' : 'no incluida'}</span></span>
          </label>)}
        </fieldset>
        <div className="catalog-actions">
          <button type="submit" className="primary" disabled={busy}>Crear batería</button>
        </div>
      </form>
      {createProblem !== '' && <p role="alert" className="catalog-status">{createProblem}</p>}
    </section>
    <section className="catalog-panel" aria-labelledby="catalog-batteries-list-title" aria-busy={state.phase === 'loading'}>
      <div className="catalog-panel-head">
        <div>
          <h2 id="catalog-batteries-list-title">Baterías</h2>
          <p className="catalog-hint">{`${total} ${total === 1 ? 'batería' : 'baterías'} · una fila por batería, con sus variantes y su estado de venta`}</p>
        </div>
        <span className="catalog-tag">{state.phase === 'ready' ? `${rows.length} en esta página` : 'Almacén'}</span>
      </div>
      <div className="catalog-filters">
        <label htmlFor="catalog-batteries-search">Buscar marca o modelo
          <input id="catalog-batteries-search" type="search" value={search} placeholder="NS40ZL, TOYO" disabled={busy}
            onChange={event => { setPageNumber(1); setSearch(event.target.value); }} />
        </label>
      </div>
      {rows.length > 0 && <div className="catalog-table-wrap">
        <table className="catalog-table">
          <caption className="sr-only">Baterías del catálogo activo, con sus variantes, su estado de venta y sus acciones</caption>
          <thead><tr>
            <th scope="col">Batería</th><th scope="col">Variantes</th>
            <th scope="col">Venta</th><th scope="col">Acciones</th>
          </tr></thead>
          <tbody>{rows.map(row => {
            const detailId = `catalog-battery-detail-${row.id}`;
            const editing = edit !== null && edit.id === row.id;
            const archiving = archive === row.id;
            return [
              <tr key={`row-${row.id}`} data-battery-id={row.id} className="catalog-row" aria-expanded={editing || archiving}
                aria-controls={detailId}>
                <td data-label="Batería"><strong>{row.brand} {row.model}</strong><small>{row.capacity_ah} Ah</small></td>
                {/* The listing publishes one polarity per variant; the allocated variant
                    ids only ever come from the echo of a write, never from this read. */}
                <td data-label="Variantes"><div className="catalog-chips">
                  {row.polarities.map(tag => <span key={tag} className="catalog-chip">{tag}</span>)}
                </div></td>
                <td data-label="Venta">{row.priced_branches === 0
                  ? <><span className="catalog-chip short">{catalogBatteryUnsellableLabel}</span>
                    <small>{catalogBatteryPricingHint}</small></>
                  : <span className="catalog-chip ok">{pricedBranchesLabel(row.priced_branches)}</span>}</td>
                <td data-label="Acciones"><div className="catalog-actions">
                  <button type="button" disabled={busy} aria-label={`Editar ${productLabel(row)}`}
                    onClick={() => openEdit(row)}>Editar</button>
                  <button type="button" disabled={busy} aria-label={`Archivar ${productLabel(row)}`}
                    onClick={() => openArchive(row)}>Archivar</button>
                </div></td>
              </tr>,
              <tr key={`detail-${row.id}`} id={detailId} className="catalog-detail" hidden={!editing && !archiving}>
                <td colSpan={4}>{editing && edit !== null && <div className="catalog-detail-inner">
                  <form aria-label={`Editar ${row.brand} ${row.model}`} aria-busy={busy}
                    onSubmit={event => void saveEdit(event)}>
                    <h3>{`Editar ${productLabel(row)}`}</h3>
                    <p className="catalog-hint">Se envían siempre la marca, el modelo y la capacidad completa: la edición nunca cambia los identificadores, las variantes ni el precio.</p>
                    <div className="catalog-pair">
                      <label htmlFor={`catalog-battery-new-brand-${row.id}`}>Nueva marca
                        <input id={`catalog-battery-new-brand-${row.id}`} value={edit.brand} autoComplete="off" disabled={busy}
                          onChange={event => { setEditProblem(''); setEdit(current => current === null ? null : { ...current, brand: event.target.value }); }} />
                      </label>
                      <label htmlFor={`catalog-battery-new-model-${row.id}`}>Nuevo modelo
                        <input id={`catalog-battery-new-model-${row.id}`} value={edit.model} autoComplete="off" disabled={busy}
                          onChange={event => { setEditProblem(''); setEdit(current => current === null ? null : { ...current, model: event.target.value }); }} />
                      </label>
                    </div>
                    <label htmlFor={`catalog-battery-new-capacity-${row.id}`}>Nueva capacidad (Ah)
                      <input id={`catalog-battery-new-capacity-${row.id}`} inputMode="decimal" value={edit.capacity_ah} autoComplete="off" disabled={busy}
                        onChange={event => { setEditProblem(''); setEdit(current => current === null ? null : { ...current, capacity_ah: event.target.value }); }} />
                    </label>
                    <p className="catalog-hint">{`Variantes: ${row.polarities.join(' · ')} · no cambian al editar la identidad`}</p>
                    <div className="catalog-actions">
                      <button type="button" className="catalog-cancel" disabled={busy} onClick={closeEditor}>Cancelar</button>
                      <button type="submit" className="primary" disabled={busy}>Guardar cambios</button>
                    </div>
                    {editProblem !== '' && <p role="alert" className="catalog-status">{editProblem}</p>}
                  </form>
                </div>}
                {archiving && <div className="catalog-detail-inner">
                  <fieldset className="catalog-branches">
                    <legend>{`Archivar ${productLabel(row)}`}</legend>
                    <p>Archivar {productLabel(row)} la saca del catálogo para siempre: no se puede volver a activar y las ventas, transferencias, ingresos y ajustes pasados la siguen mostrando. Sus existencias deben estar en cero y no puede tener transferencias pendientes.</p>
                    <div className="catalog-actions">
                      <button type="button" className="catalog-cancel" disabled={busy}
                        onClick={() => { if (!busy) setArchive(null); }}>Cancelar archivado</button>
                      <button type="button" className="primary" disabled={busy}
                        onClick={() => void archiveBattery(row.id)}>Confirmar archivado</button>
                    </div>
                  </fieldset>
                </div>}
                </td>
              </tr>,
            ];
          })}</tbody>
        </table>
      </div>}
      {state.phase === 'loading' && <p className="catalog-message" role="status">Consultando el catálogo de baterías…</p>}
      {state.phase === 'error' && <p className="catalog-message" role="alert">{state.problem}
        <button type="button" disabled={busy} onClick={() => setRevision(value => value + 1)}>Reintentar catálogo</button></p>}
      {state.phase === 'ready' && rows.length === 0 && <p className="catalog-message">Sin baterías para esta consulta.</p>}
      {listProblem !== '' && <p role="alert" className="catalog-status">{listProblem}</p>}
      <footer className="pager" aria-label="Paginación del catálogo de baterías">
        <span className="range" aria-live="polite">{page
          ? `Mostrando ${firstRow}–${lastRow} de ${total} baterías`
          : 'Sin resultados cargados.'}</span>
        <div className="page-controls">
          <label htmlFor="catalog-batteries-page-size">Baterías por página</label>
          <select id="catalog-batteries-page-size" value={pageSize} disabled={busy}
            onChange={event => {
              const next = Number(event.target.value);
              if (catalogPricesPageSizes.includes(next)) { setPageNumber(1); setPageSize(next); }
            }}>{catalogPricesPageSizes.map(value => <option key={value} value={value}>{value}</option>)}</select>
          <button type="button" disabled={busy || pageNumber <= 1} onClick={() => setPageNumber(value => Math.max(1, value - 1))}>Página anterior</button>
          <span className="current-page" aria-current="page">{pageNumber}</span>
          <button type="button" disabled={busy || page === null || pageNumber * pageSize >= total}
            onClick={() => setPageNumber(value => value + 1)}>Siguiente página</button>
        </div>
      </footer>
      <p role="status" className="catalog-notice">{notice}</p>
      <p className="catalog-hint">Una batería sin precio en ninguna sucursal existe en el catálogo pero no se puede vender: cargá su precio en el catálogo de precios. Archivar reemplaza a eliminar y no se deshace.</p>
    </section>
  </section>;
}
