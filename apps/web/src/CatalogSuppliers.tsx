import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { createSuppliersAPI, SuppliersAPIError } from './catalogSuppliersAPI';
import {
  canonicalSupplierOffers, supplierCatalogUnavailable, supplierDraftOf, supplierEntryDetail,
  supplierEntryLabel, supplierKindLabel, supplierOffersLabel, supplierOffersMessage, supplierStateLabel,
  suppliersErrorMessages, suppliersListUnavailable, supplierOffersUnavailable, validateSupplierDraft,
  type SupplierCatalogEntry, type SupplierKind, type SupplierListPage, type SupplierListRow,
  type SuppliersErrorCode,
} from './catalogSuppliersModel';
import { catalogPricesDefaultPageSize, catalogPricesPageSizes } from './catalogPricesModel';
// The catalogue's own layout, tokens and 44px targets: this screen adds no colour
// and no new spacing, so it reuses the price screen's sheet instead of a new one.
import './catalog-prices.css';

interface ListState { readonly phase: 'loading' | 'ready' | 'error'; readonly page: SupplierListPage | null; readonly problem: string }
/** One read of a set of catalogue entries: the entries, or the reason they were not read. */
interface EntriesState {
  readonly phase: 'loading' | 'ready' | 'error';
  readonly entries: readonly SupplierCatalogEntry[]; readonly problem: string;
}
/** The drafted supplier of the create form. */
interface CreateDraft { readonly name: string; readonly contact: string }
/** The editor of one listed supplier: the complete identity it will write. */
interface EditDraft { readonly id: number; readonly name: string; readonly contact: string }
/** The confirmation of a retirement: one way, so it names the supplier it retires. */
interface RetireDraft { readonly id: number; readonly name: string }
/** The selected supplier whose offer set is being edited. */
interface AssignDraft { readonly id: number; readonly name: string }

const errorMessages = suppliersErrorMessages;
const kindOptions = [['', 'Todos'], ['battery', 'Baterías'], ['other', 'Otros productos']] as const;

/** A refusal that concerns the whole read keeps the screen's own words. */
function readProblem(failure: unknown, fallback: string): string {
  const code: SuppliersErrorCode = failure instanceof SuppliersAPIError ? failure.code : 'invalid_response';
  if (code === 'unauthenticated' || code === 'forbidden') return errorMessages[code];
  return fallback;
}

export interface CatalogSuppliersProps {
  // The shell remounts this section per session fence, exactly like the price and
  // other-products screens, so a rotated session or CSRF token can never publish a
  // supplier into a newer one.
  csrf: string;
  fetcher?: typeof globalThis.fetch;
}

/**
 * The editor of the complete offer set of one supplier: every row toggles the
 * assignment locally and the whole set is written once, as one `PUT`. The set is
 * replaced, never merged, and removing an entry never erases a document that
 * already named it.
 */
function OfferEditor({ name, busy, assigned, catalog, search, kind, pageSize, problem,
  onSearch, onKind, onPageSize, onToggle, onSave, onRetryAssigned, onRetryCatalog, onCancel }: {
  name: string; busy: boolean; assigned: EntriesState; catalog: EntriesState;
  search: string; kind: '' | SupplierKind; pageSize: number; problem: string;
  onSearch: (value: string) => void; onKind: (value: '' | SupplierKind) => void;
  onPageSize: (value: number) => void; onToggle: (entry: SupplierCatalogEntry) => void;
  onSave: (event: FormEvent) => void; onRetryAssigned: () => void; onRetryCatalog: () => void;
  onCancel: () => void;
}) {
  const assignedIDs = new Set(assigned.entries.map(entry => entry.catalog_entry_id));
  // The assigned entries stay visible even when the search no longer returns them,
  // so an unassignment never depends on typing the same search again.
  const rows = [...assigned.entries,
    ...catalog.entries.filter(entry => !assignedIDs.has(entry.catalog_entry_id))];
  return <form aria-label={`Productos que ofrece ${name}`} aria-busy={busy} onSubmit={onSave}>
    <h3>{`Productos que ofrece ${name}`}</h3>
    <p className="catalog-hint">Guardar reemplaza el conjunto completo de productos que ofrece el proveedor. Quitar un producto no borra los ingresos ya registrados: los documentos que lo nombran se siguen leyendo igual.</p>
    <p className="catalog-status" role="status">{`Productos asignados: ${assigned.entries.length}`}</p>
    <div className="catalog-filters">
      <label htmlFor="catalog-suppliers-entry-search">Buscar en el catálogo
        <input id="catalog-suppliers-entry-search" type="search" value={search} placeholder="Willard 12N24"
          disabled={busy} onChange={event => onSearch(event.target.value)} />
      </label>
      <label htmlFor="catalog-suppliers-entry-kind">Tipo de producto
        <select id="catalog-suppliers-entry-kind" value={kind} disabled={busy}
          onChange={event => onKind(event.target.value === 'battery' || event.target.value === 'other'
            ? event.target.value : '')}>
          {kindOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <label htmlFor="catalog-suppliers-entry-page-size">Resultados por página
        <select id="catalog-suppliers-entry-page-size" value={pageSize} disabled={busy}
          onChange={event => {
            const next = Number(event.target.value);
            if (catalogPricesPageSizes.includes(next)) onPageSize(next);
          }}>{catalogPricesPageSizes.map(value => <option key={value} value={value}>{value}</option>)}</select>
      </label>
    </div>
    {assigned.phase === 'loading' && <p className="catalog-message" role="status">Consultando los productos que ofrece el proveedor…</p>}
    {assigned.phase === 'error' && <p className="catalog-message" role="alert">{assigned.problem}
      <button type="button" disabled={busy} onClick={onRetryAssigned}>Reintentar productos del proveedor</button></p>}
    {assigned.phase === 'ready' && <fieldset className="catalog-branches">
      <legend>Productos del catálogo</legend>
      {rows.length === 0 && <p className="catalog-hint">Sin productos para esta consulta.</p>}
      {rows.map(entry => <label key={entry.catalog_entry_id} className="catalog-branch">
        <input type="checkbox" checked={assignedIDs.has(entry.catalog_entry_id)} disabled={busy}
          aria-label={`Ofrecer ${supplierEntryLabel(entry)}`} onChange={() => onToggle(entry)} />
        <span><strong>{supplierEntryLabel(entry)}</strong><small>{supplierEntryDetail(entry)}</small></span>
      </label>)}
    </fieldset>}
    {catalog.phase === 'loading' && <p className="catalog-message" role="status">Consultando el catálogo asignable…</p>}
    {catalog.phase === 'error' && <p className="catalog-message" role="alert">{catalog.problem}
      <button type="button" disabled={busy} onClick={onRetryCatalog}>Reintentar catálogo</button></p>}
    {problem !== '' && <p role="alert" className="catalog-status">{problem}</p>}
    <div className="catalog-actions">
      <button type="button" className="catalog-cancel" disabled={busy} onClick={onCancel}>Cancelar</button>
      <button type="submit" className="primary" disabled={busy || assigned.phase !== 'ready'}>Guardar asignación</button>
    </div>
  </form>;
}

export default function CatalogSuppliers({ csrf, fetcher = globalThis.fetch }: CatalogSuppliersProps) {
  const api = useMemo(() => createSuppliersAPI(fetcher), [fetcher]);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageSize, setPageSize] = useState(catalogPricesDefaultPageSize);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<ListState>({ phase: 'loading', page: null, problem: suppliersListUnavailable });
  const [create, setCreate] = useState<CreateDraft>({ name: '', contact: '' });
  const [edit, setEdit] = useState<EditDraft | null>(null);
  const [retire, setRetire] = useState<RetireDraft | null>(null);
  const [assigning, setAssigning] = useState<AssignDraft | null>(null);
  const [assigned, setAssigned] = useState<EntriesState>({ phase: 'loading', entries: [], problem: '' });
  const [catalogState, setCatalogState] = useState<EntriesState>({ phase: 'loading', entries: [], problem: '' });
  const [catalogSearch, setCatalogSearch] = useState('');
  const [catalogKind, setCatalogKind] = useState<'' | SupplierKind>('');
  const [catalogPageSize, setCatalogPageSize] = useState(catalogPricesDefaultPageSize);
  const [assignedRevision, setAssignedRevision] = useState(0);
  const [catalogRevision, setCatalogRevision] = useState(0);
  const [createProblem, setCreateProblem] = useState('');
  const [editProblem, setEditProblem] = useState('');
  const [listProblem, setListProblem] = useState('');
  const [assignProblem, setAssignProblem] = useState('');
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
    const current = () => mounted.current && !lifetime.current.signal.aborted && !controller.signal.aborted;
    setState(previous => ({ phase: 'loading', page: previous.page, problem: suppliersListUnavailable }));
    void (async () => {
      try {
        const page = await api.list({ page: pageNumber, page_size: pageSize }, controller.signal);
        if (!current()) return;
        setState({ phase: 'ready', page, problem: '' });
      } catch (failure) {
        if (!current()) return;
        setState({ phase: 'error', page: null, problem: readProblem(failure, suppliersListUnavailable) });
      }
    })();
    return () => controller.abort();
  }, [api, pageNumber, pageSize, revision]);

  // The assigned set is read from the supplier itself: the listing publishes the
  // count, never the entries.
  useEffect(() => {
    if (assigning === null) { setAssigned({ phase: 'loading', entries: [], problem: '' }); return; }
    const controller = new AbortController();
    const current = () => mounted.current && !lifetime.current.signal.aborted && !controller.signal.aborted;
    setAssigned({ phase: 'loading', entries: [], problem: supplierOffersUnavailable });
    void (async () => {
      try {
        const detail = await api.detail(assigning.id, controller.signal);
        if (!current()) return;
        setAssigned({ phase: 'ready', entries: detail.offers, problem: '' });
      } catch (failure) {
        if (!current()) return;
        setAssigned({ phase: 'error', entries: [], problem: readProblem(failure, supplierOffersUnavailable) });
      }
    })();
    return () => controller.abort();
  }, [api, assigning, assignedRevision]);

  // What can be assigned is the active catalogue, filtered by kind and search, and
  // it is the server's listing: the screen never offers a retired entry.
  useEffect(() => {
    if (assigning === null) return;
    const controller = new AbortController();
    const current = () => mounted.current && !lifetime.current.signal.aborted && !controller.signal.aborted;
    setCatalogState({ phase: 'loading', entries: [], problem: supplierCatalogUnavailable });
    void (async () => {
      try {
        const page = await api.catalog({ kind: catalogKind, search: catalogSearch, page_size: catalogPageSize },
          controller.signal);
        if (!current()) return;
        setCatalogState({ phase: 'ready', entries: page.entries, problem: '' });
      } catch (failure) {
        if (!current()) return;
        setCatalogState({ phase: 'error', entries: [], problem: readProblem(failure, supplierCatalogUnavailable) });
      }
    })();
    return () => controller.abort();
  }, [api, assigning, catalogKind, catalogSearch, catalogPageSize, catalogRevision]);

  const page = state.page;
  const rows = page?.rows ?? [];
  const total = page?.total_suppliers ?? 0;
  const firstRow = page && rows.length > 0 ? (page.page - 1) * page.page_size + 1 : 0;
  const lastRow = page && rows.length > 0 ? firstRow + rows.length - 1 : 0;

  function refused(failure: unknown): string {
    const code: SuppliersErrorCode = failure instanceof SuppliersAPIError ? failure.code : 'invalid_response';
    return errorMessages[code];
  }
  // Only one detail row can be open at a time: opening another closes the previous.
  function clearPanels() {
    setEdit(null); setRetire(null); setAssigning(null);
    setEditProblem(''); setAssignProblem(''); setListProblem(''); setNotice('');
  }

  async function createSupplier(event: FormEvent) {
    event.preventDefault();
    if (pending.current || !alive()) return;
    const validation = validateSupplierDraft(create);
    setNotice(''); setListProblem(''); setCreateProblem('');
    if (!validation.valid) { setCreateProblem(validation.message); return; }
    pending.current = true; setBusy(true);
    try {
      const record = await api.create(validation.input, csrf, lifetime.current.signal);
      if (!alive()) return;
      setCreate({ name: '', contact: '' });
      setNotice(`Proveedor #${record.id} creado: ${record.name}.`);
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

  function openEdit(row: SupplierListRow) {
    if (busy || pending.current || row.retired) return;
    clearPanels();
    const draft = supplierDraftOf(row);
    setEdit({ id: row.id, name: draft.name, contact: draft.contact });
  }
  function openRetire(row: SupplierListRow) {
    if (busy || pending.current || row.retired) return;
    clearPanels();
    setRetire({ id: row.id, name: row.name });
  }
  function openOffers(row: SupplierListRow) {
    if (busy || pending.current || row.retired) return;
    clearPanels();
    // Every opening starts from the whole catalogue again.
    setCatalogSearch(''); setCatalogKind(''); setCatalogPageSize(catalogPricesDefaultPageSize);
    setAssigning({ id: row.id, name: row.name });
  }
  function closeEditor() {
    if (busy) return;
    setEdit(null); setEditProblem('');
  }
  function closeAssign() {
    if (busy) return;
    setAssigning(null); setAssignProblem('');
  }

  async function saveEdit(event: FormEvent) {
    event.preventDefault();
    if (pending.current || !alive() || edit === null) return;
    const validation = validateSupplierDraft({ name: edit.name, contact: edit.contact });
    setNotice(''); setEditProblem('');
    if (!validation.valid) { setEditProblem(validation.message); return; }
    pending.current = true; setBusy(true);
    try {
      const record = await api.edit(edit.id, validation.input, csrf, lifetime.current.signal);
      if (!alive()) return;
      setEdit(null);
      setNotice(`Proveedor #${record.id} actualizado: ${record.name}.`);
      setRevision(value => value + 1);
    } catch (failure) {
      if (alive()) setEditProblem(refused(failure));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function retireSupplier(id: number) {
    if (pending.current || !alive() || retire === null || retire.id !== id) return;
    pending.current = true; setBusy(true); setNotice(''); setListProblem('');
    try {
      await api.retire(id, csrf, lifetime.current.signal);
      if (!alive()) return;
      setRetire(null);
      // A 204 is the retirement itself: the supplier is gone from the editable list
      // before the listing is read again. Retirement is one way: nothing restores it.
      setState(current => current.page === null ? current : {
        ...current,
        page: { ...current.page, rows: current.page.rows.filter(row => row.id !== id) },
      });
      setNotice(`Proveedor #${id} retirado. Deja de estar disponible en Ingresos y sus documentos ya registrados se siguen leyendo.`);
      setRevision(value => value + 1);
    } catch (failure) {
      // The confirmation closes so the operator reads the reason before retrying.
      if (alive()) { setRetire(null); setListProblem(refused(failure)); }
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  function toggleOffer(entry: SupplierCatalogEntry) {
    if (busy) return;
    setAssignProblem('');
    setAssigned(current => {
      if (current.phase !== 'ready') return current;
      const assigned = current.entries.some(held => held.catalog_entry_id === entry.catalog_entry_id);
      return { phase: 'ready', problem: '', entries: assigned
        ? current.entries.filter(held => held.catalog_entry_id !== entry.catalog_entry_id)
        : [...current.entries, entry] };
    });
  }

  async function saveOffers(event: FormEvent) {
    event.preventDefault();
    if (pending.current || !alive() || assigning === null || assigned.phase !== 'ready') return;
    let ids: readonly number[];
    try { ids = canonicalSupplierOffers(assigned.entries.map(entry => entry.catalog_entry_id)); }
    catch { setAssignProblem(supplierOffersMessage); return; }
    setNotice(''); setListProblem(''); setAssignProblem('');
    pending.current = true; setBusy(true);
    try {
      const detail = await api.saveOffers(assigning.id, ids, csrf, lifetime.current.signal);
      if (!alive()) return;
      setAssigned({ phase: 'ready', entries: detail.offers, problem: '' });
      setNotice(`Proveedor #${detail.id} actualizado: ofrece ${supplierOffersLabel(detail.offers.length)}.`);
      // The echo is the new set; the supplier is read again to confirm what it offers.
      setAssignedRevision(value => value + 1);
    } catch (failure) {
      // The selected set stays as the operator left it.
      if (alive()) setAssignProblem(refused(failure));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return <section className="catalog-prices" aria-labelledby="catalog-suppliers-title">
    <header className="catalog-heading">
      <small>ALMACÉN / CATÁLOGO</small>
      <h1 id="catalog-suppliers-title">Proveedores del almacén</h1>
      <p>El Almacén crea, edita y retira sus proveedores y les asigna los productos del catálogo que ofrecen. Un proveedor retirado deja de estar disponible en Ingresos y sus documentos ya registrados se siguen leyendo.</p>
    </header>
    <section className="catalog-panel" aria-labelledby="catalog-suppliers-create-title">
      <div className="catalog-panel-head">
        <div>
          <h2 id="catalog-suppliers-create-title">Nuevo proveedor</h2>
          <p className="catalog-hint">Nombre y contacto. El identificador lo asigna el servidor; el nombre es único entre los proveedores activos.</p>
        </div>
        <span className="catalog-tag">Catálogo activo</span>
      </div>
      <form aria-busy={busy} onSubmit={event => void createSupplier(event)}>
        <div className="catalog-pair">
          <label htmlFor="catalog-suppliers-name">Nombre
            <input id="catalog-suppliers-name" value={create.name} autoComplete="off" disabled={busy}
              aria-describedby="catalog-suppliers-name-hint"
              onChange={event => { setCreateProblem(''); setCreate(current => ({ ...current, name: event.target.value })); }} />
          </label>
          <label htmlFor="catalog-suppliers-contact">Contacto
            <input id="catalog-suppliers-contact" value={create.contact} autoComplete="off" disabled={busy}
              aria-describedby="catalog-suppliers-contact-hint"
              onChange={event => { setCreateProblem(''); setCreate(current => ({ ...current, contact: event.target.value })); }} />
          </label>
        </div>
        <p id="catalog-suppliers-name-hint" className="catalog-hint">Por ejemplo, Baterías del Sur. Entre 3 y 64 caracteres, sin espacios al principio ni al final.</p>
        <p id="catalog-suppliers-contact-hint" className="catalog-hint">Opcional: hasta 200 caracteres, sin caracteres de control.</p>
        <div className="catalog-actions">
          <button type="submit" className="primary" disabled={busy}>Crear proveedor</button>
        </div>
      </form>
      {createProblem !== '' && <p role="alert" className="catalog-status">{createProblem}</p>}
    </section>
    <section className="catalog-panel" aria-labelledby="catalog-suppliers-list-title" aria-busy={state.phase === 'loading'}>
      <div className="catalog-panel-head">
        <div>
          <h2 id="catalog-suppliers-list-title">Proveedores</h2>
          <p className="catalog-hint">{`${total} ${total === 1 ? 'proveedor' : 'proveedores'} · activos primero, retirados al final`}</p>
        </div>
        <span className="catalog-tag">{state.phase === 'ready' ? `${rows.length} en esta página` : 'Almacén'}</span>
      </div>
      {rows.length > 0 && <div className="catalog-table-wrap">
        <table className="catalog-table">
          <caption className="sr-only">Proveedores del almacén, con los productos que ofrecen y sus acciones</caption>
          <thead><tr>
            <th scope="col">Proveedor</th><th scope="col">Productos</th><th scope="col">Acciones</th>
          </tr></thead>
          <tbody>{rows.map(row => {
            const detailID = `catalog-supplier-detail-${row.id}`;
            const editing = edit !== null && edit.id === row.id;
            const retiring = retire !== null && retire.id === row.id;
            const offering = assigning !== null && assigning.id === row.id;
            const open = editing || retiring || offering;
            const detail = row.retired ? null : <tr key={`detail-${row.id}`} id={detailID} className="catalog-detail"
              hidden={!open}>
              <td colSpan={3}>
                {editing && edit !== null && <div className="catalog-detail-inner">
                  <form aria-label={`Editar ${row.name}`} aria-busy={busy} onSubmit={event => void saveEdit(event)}>
                    <h3>{`Editar ${row.name}`}</h3>
                    <p className="catalog-hint">La edición cambia el nombre y el contacto del proveedor. Los productos que ofrece se conservan y se editan aparte.</p>
                    <div className="catalog-pair">
                      <label htmlFor={`catalog-suppliers-new-name-${row.id}`}>Nuevo nombre
                        <input id={`catalog-suppliers-new-name-${row.id}`} value={edit.name} autoComplete="off" disabled={busy}
                          onChange={event => { setEditProblem(''); setEdit(current => current === null ? null
                            : { ...current, name: event.target.value }); }} />
                      </label>
                      <label htmlFor={`catalog-suppliers-new-contact-${row.id}`}>Contacto
                        <input id={`catalog-suppliers-new-contact-${row.id}`} value={edit.contact} autoComplete="off" disabled={busy}
                          onChange={event => { setEditProblem(''); setEdit(current => current === null ? null
                            : { ...current, contact: event.target.value }); }} />
                      </label>
                    </div>
                    <div className="catalog-actions">
                      <button type="button" className="catalog-cancel" disabled={busy} onClick={closeEditor}>Cancelar</button>
                      <button type="submit" className="primary" disabled={busy}>Guardar cambios</button>
                    </div>
                    {editProblem !== '' && <p role="alert" className="catalog-status">{editProblem}</p>}
                  </form>
                </div>}
                {retiring && retire !== null && <div className="catalog-detail-inner">
                  <fieldset className="catalog-branches">
                    <legend>{`Retirar ${row.name}`}</legend>
                    <p>Retirar a {row.name} es de una sola vía: deja de estar disponible para elegir en Ingresos y no puede recibir productos nuevos. Sus documentos ya registrados lo siguen mostrando y se pueden seguir leyendo.</p>
                    <div className="catalog-actions">
                      <button type="button" className="catalog-cancel" disabled={busy}
                        onClick={() => { if (!busy) setRetire(null); }}>Cancelar retiro</button>
                      <button type="button" className="primary" disabled={busy}
                        onClick={() => void retireSupplier(row.id)}>Confirmar retiro</button>
                    </div>
                  </fieldset>
                </div>}
                {offering && assigning !== null && <div className="catalog-detail-inner">
                  <OfferEditor name={assigning.name} busy={busy} assigned={assigned} catalog={catalogState}
                    search={catalogSearch} kind={catalogKind} pageSize={catalogPageSize} problem={assignProblem}
                    onSearch={value => { setAssignProblem(''); setCatalogSearch(value); }}
                    onKind={value => { setAssignProblem(''); setCatalogKind(value); }}
                    onPageSize={value => { setAssignProblem(''); setCatalogPageSize(value); }}
                    onToggle={toggleOffer} onSave={event => void saveOffers(event)}
                    onRetryAssigned={() => setAssignedRevision(value => value + 1)}
                    onRetryCatalog={() => setCatalogRevision(value => value + 1)}
                    onCancel={closeAssign} />
                </div>}
              </td>
            </tr>;
            return [<tr key={`row-${row.id}`} data-supplier-id={row.id} data-retired={row.retired ? 'true' : 'false'}
              className="catalog-row" aria-expanded={row.retired ? undefined : open}
              aria-controls={row.retired ? undefined : detailID}>
              <td data-label="Proveedor"><strong>{row.name}</strong>
                <small>{row.contact === '' ? 'Sin contacto' : row.contact}</small>
                <span className={'catalog-chip' + (row.retired ? ' short' : ' ok')}>{supplierStateLabel(row.retired)}</span></td>
              <td data-label="Productos"><strong>{supplierOffersLabel(row.offers)}</strong>
                <div className="catalog-chips">{row.kinds.length === 0
                  ? <span className="catalog-chip short">Sin productos asignados</span>
                  : row.kinds.map(kind => <span key={kind} className="catalog-chip">{supplierKindLabel(kind)}</span>)}</div></td>
              {row.retired
                ? <td data-label="Acciones"><span className="catalog-chip short">Solo lectura</span></td>
                : <td data-label="Acciones"><div className="catalog-actions">
                  <button type="button" disabled={busy} aria-label={`Asignar productos a ${row.name}`}
                    onClick={() => openOffers(row)}>Asignar productos</button>
                  <button type="button" disabled={busy} aria-label={`Editar ${row.name}`}
                    onClick={() => openEdit(row)}>Editar</button>
                  <button type="button" disabled={busy} aria-label={`Retirar ${row.name}`}
                    onClick={() => openRetire(row)}>Retirar</button>
                </div></td>}
            </tr>, detail];
          })}</tbody>
        </table>
      </div>}
      {state.phase === 'loading' && <p className="catalog-message" role="status">Consultando los proveedores…</p>}
      {state.phase === 'error' && <p className="catalog-message" role="alert">{state.problem}
        <button type="button" disabled={busy} onClick={() => setRevision(value => value + 1)}>Reintentar proveedores</button></p>}
      {state.phase === 'ready' && rows.length === 0 && <p className="catalog-message">Sin proveedores para esta página.</p>}
      {listProblem !== '' && <p role="alert" className="catalog-status">{listProblem}</p>}
      <footer className="pager" aria-label="Paginación de proveedores">
        <span className="range" aria-live="polite">{page
          ? `Mostrando ${firstRow}–${lastRow} de ${total} ${total === 1 ? 'proveedor' : 'proveedores'}`
          : 'Sin resultados cargados.'}</span>
        <div className="page-controls">
          <label htmlFor="catalog-suppliers-page-size">Proveedores por página</label>
          <select id="catalog-suppliers-page-size" value={pageSize} disabled={busy}
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
      <p className="catalog-hint">Retirar es de una sola vía: un proveedor retirado no se reactiva, deja de poder recibir productos nuevos y sus documentos pasados lo siguen nombrando.</p>
    </section>
  </section>;
}
