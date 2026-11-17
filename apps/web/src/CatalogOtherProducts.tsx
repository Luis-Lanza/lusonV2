import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { CatalogOtherProductsAPIError, createCatalogOtherProductsAPI } from './catalogOtherProductsAPI';
import {
  catalogOtherFieldLabel, catalogOtherFieldsCountLabel, catalogOtherProductDraftOf,
  catalogOtherProductsErrorMessages, catalogOtherProductsListUnavailable, catalogOtherProductsMaxFields,
  validateCatalogOtherProductDraft,
  type CatalogOtherFieldKind, type CatalogOtherProductDraft, type CatalogOtherProductPage,
  type CatalogOtherProductRecord, type CatalogOtherProductsErrorCode,
} from './catalogOtherProductsModel';
import { catalogPricesDefaultPageSize, catalogPricesPageSizes } from './catalogPricesModel';
// The catalogue's own layout, tokens and 44px targets: this screen adds no colour
// and no new spacing, so it reuses the price screen's sheet instead of a new one.
import './catalog-prices.css';

interface ListState { readonly phase: 'loading' | 'ready' | 'error'; readonly page: CatalogOtherProductPage | null; readonly problem: string }
/** One field row of the form: every box is a string, and the kind picks the value. */
interface FieldRow {
  readonly key: number; readonly name: string; readonly kind: CatalogOtherFieldKind;
  readonly unit: string; readonly number: string; readonly text: string;
}
/** The drafted product of the create form: its name and its repeatable field rows. */
interface CreateDraft { readonly name: string; readonly rows: readonly FieldRow[] }
/** The editor of one listed product: the complete identity it will write. */
interface EditDraft { readonly id: number; readonly name: string; readonly rows: readonly FieldRow[] }

/**
 * The draft both writes send: the name and the whole field set. The row key is a
 * React list identity, never part of the payload.
 */
function draftOf(name: string, rows: readonly FieldRow[]): CatalogOtherProductDraft {
  return {
    name,
    fields: rows.map(row => ({ name: row.name, kind: row.kind, unit: row.unit, number: row.number, text: row.text })),
  };
}

export interface CatalogOtherProductsProps {
  // The shell remounts this section per session fence, exactly like the battery and
  // price screens, so a rotated session or CSRF token can never publish a product
  // into a newer one.
  csrf: string;
  fetcher?: typeof globalThis.fetch;
}

const productLabel = (row: { name: string }) => row.name;

/**
 * The repeatable field rows: the operator picks number or text, writes the value,
 * and a number field admits an optional unit. A text field never offers a unit.
 */
function FieldEditor({ prefix, rows, disabled, onAdd, onRemove, onChange }: {
  prefix: string; rows: readonly FieldRow[]; disabled: boolean;
  onAdd: () => void; onRemove: (key: number) => void; onChange: (key: number, patch: Partial<FieldRow>) => void;
}) {
  return <fieldset className="catalog-branches">
    <legend>Campos personalizados</legend>
    {rows.length === 0 && <p className="catalog-hint">Sin campos: el producto se guarda solo con su nombre.</p>}
    {rows.map((row, index) => <fieldset key={row.key} className="catalog-branches" aria-label={`Campo ${index + 1}`}>
      <div className="catalog-pair">
        <label htmlFor={`${prefix}-field-name-${row.key}`}>Nombre del campo
          <input id={`${prefix}-field-name-${row.key}`} value={row.name} autoComplete="off" disabled={disabled}
            onChange={event => onChange(row.key, { name: event.target.value })} />
        </label>
        <label htmlFor={`${prefix}-field-kind-${row.key}`}>Tipo
          <select id={`${prefix}-field-kind-${row.key}`} value={row.kind} disabled={disabled}
            onChange={event => onChange(row.key, { kind: event.target.value === 'text' ? 'text' : 'number' })}>
            <option value="number">Número</option>
            <option value="text">Texto</option>
          </select>
        </label>
      </div>
      <div className="catalog-pair">
        {row.kind === 'number' && <label htmlFor={`${prefix}-field-unit-${row.key}`}>Unidad (opcional)
          <input id={`${prefix}-field-unit-${row.key}`} value={row.unit} autoComplete="off" disabled={disabled}
            onChange={event => onChange(row.key, { unit: event.target.value })} />
        </label>}
        <label htmlFor={`${prefix}-field-value-${row.key}`}>Valor
          <input id={`${prefix}-field-value-${row.key}`} inputMode={row.kind === 'number' ? 'decimal' : undefined}
            value={row.kind === 'number' ? row.number : row.text} autoComplete="off" disabled={disabled}
            onChange={event => onChange(row.key, row.kind === 'number'
              ? { number: event.target.value } : { text: event.target.value })} />
        </label>
      </div>
      <div className="catalog-actions">
        <button type="button" className="catalog-cancel" disabled={disabled}
          aria-label={`Quitar campo ${index + 1}`} onClick={() => onRemove(row.key)}>Quitar campo</button>
      </div>
    </fieldset>)}
    <div className="catalog-actions">
      <button type="button" className="catalog-cancel" disabled={disabled || rows.length >= catalogOtherProductsMaxFields}
        onClick={onAdd}>Agregar campo</button>
    </div>
  </fieldset>;
}

export default function CatalogOtherProducts({ csrf, fetcher = globalThis.fetch }: CatalogOtherProductsProps) {
  const api = useMemo(() => createCatalogOtherProductsAPI(fetcher), [fetcher]);
  const [search, setSearch] = useState('');
  const [pageNumber, setPageNumber] = useState(1);
  const [pageSize, setPageSize] = useState(catalogPricesDefaultPageSize);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<ListState>({ phase: 'loading', page: null, problem: catalogOtherProductsListUnavailable });
  // Field rows are identified by a key of their own, so reordering never reuses a row.
  const nextKey = useRef(1);
  const newRow = (): FieldRow => ({ key: nextKey.current++, name: '', kind: 'number', unit: '', number: '', text: '' });
  // The create form starts with one empty row: the operator writes a field or adds another.
  const [create, setCreate] = useState<CreateDraft>(() => ({ name: '', rows: [newRow()] }));
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
    setState(previous => ({ phase: 'loading', page: previous.page, problem: catalogOtherProductsListUnavailable }));
    void (async () => {
      try {
        const page = await api.list({ search, page: pageNumber, page_size: pageSize }, controller.signal);
        if (!current()) return;
        setState({ phase: 'ready', page, problem: '' });
      } catch (failure) {
        if (!current()) return;
        const code: CatalogOtherProductsErrorCode = failure instanceof CatalogOtherProductsAPIError ? failure.code : 'invalid_response';
        const problem = code === 'unauthenticated' ? catalogOtherProductsErrorMessages.unauthenticated
          : code === 'forbidden' ? catalogOtherProductsErrorMessages.forbidden : catalogOtherProductsListUnavailable;
        setState({ phase: 'error', page: null, problem });
      }
    })();
    return () => controller.abort();
  }, [api, search, pageNumber, pageSize, revision]);

  const page = state.page;
  const rows = page?.rows ?? [];
  const total = page?.total_products ?? 0;
  const firstRow = page && rows.length > 0 ? (page.page - 1) * page.page_size + 1 : 0;
  const lastRow = page && rows.length > 0 ? firstRow + rows.length - 1 : 0;

  function refused(failure: unknown): string {
    const code: CatalogOtherProductsErrorCode = failure instanceof CatalogOtherProductsAPIError ? failure.code : 'invalid_response';
    return catalogOtherProductsErrorMessages[code];
  }
  function patchCreate(key: number, patch: Partial<FieldRow>) {
    setCreateProblem('');
    setCreate(current => ({ ...current, rows: current.rows.map(row => row.key === key ? { ...row, ...patch } : row) }));
  }
  function patchEdit(key: number, patch: Partial<FieldRow>) {
    setEditProblem('');
    setEdit(current => current === null ? null
      : { ...current, rows: current.rows.map(row => row.key === key ? { ...row, ...patch } : row) });
  }

  async function createProduct(event: FormEvent) {
    event.preventDefault();
    if (pending.current || !alive()) return;
    const validation = validateCatalogOtherProductDraft(draftOf(create.name, create.rows));
    setNotice('');
    setListProblem('');
    setCreateProblem('');
    if (!validation.valid) { setCreateProblem(validation.message); return; }
    pending.current = true; setBusy(true);
    try {
      const record = await api.create(validation.input, csrf, lifetime.current.signal);
      if (!alive()) return;
      // The allocated id shown now is the server's answer: nothing here was guessed.
      setCreate({ name: '', rows: [newRow()] });
      setNotice(`Producto #${record.id} creado: ${record.name} · ${catalogOtherFieldsCountLabel(record.fields)}.`);
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

  function openEdit(row: CatalogOtherProductRecord) {
    if (busy || pending.current) return;
    setEditProblem(''); setListProblem(''); setNotice('');
    setArchive(null);
    const draft = catalogOtherProductDraftOf(row);
    setEdit({ id: row.id, name: draft.name, rows: draft.fields.map(field => ({
      key: nextKey.current++, name: field.name, kind: field.kind === 'text' ? 'text' : 'number',
      unit: field.unit ?? '', number: field.number ?? '', text: field.text ?? '',
    })) });
  }
  function openArchive(row: CatalogOtherProductRecord) {
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
    const validation = validateCatalogOtherProductDraft(draftOf(edit.name, edit.rows));
    setNotice('');
    setEditProblem('');
    if (!validation.valid) { setEditProblem(validation.message); return; }
    pending.current = true; setBusy(true);
    try {
      const record = await api.edit(edit.id, validation.input, csrf, lifetime.current.signal);
      if (!alive()) return;
      setEdit(null);
      setNotice(`Producto #${record.id} actualizado: ${record.name} · ${catalogOtherFieldsCountLabel(record.fields)}.`);
      setRevision(value => value + 1);
    } catch (failure) {
      if (alive()) setEditProblem(refused(failure));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function archiveProduct(id: number) {
    if (pending.current || !alive() || archive !== id) return;
    pending.current = true; setBusy(true); setNotice(''); setListProblem('');
    try {
      await api.archive(id, csrf, lifetime.current.signal);
      if (!alive()) return;
      setArchive(null);
      // A 204 is the retirement itself: the product has left the editable catalogue,
      // so it leaves this list at once and the list is read again to report the page
      // the server now holds. Retirement is one way: nothing here restores it.
      setState(current => current.page === null ? current : {
        ...current,
        page: { ...current.page, rows: current.page.rows.filter(row => row.id !== id) },
      });
      setNotice(`Producto #${id} retirado. No se puede volver a activar y deja de aparecer en el catálogo.`);
      setRevision(value => value + 1);
    } catch (failure) {
      // The confirmation closes so the operator reads the reason before retrying.
      if (alive()) { setArchive(null); setListProblem(refused(failure)); }
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return <section className="catalog-prices" aria-labelledby="catalog-other-products-title">
    <header className="catalog-heading">
      <small>ALMACÉN / CATÁLOGO</small>
      <h1 id="catalog-other-products-title">Otros productos del catálogo</h1>
      <p>El Almacén crea, edita y retira los productos que no son baterías. Cada producto lleva su nombre y los campos que le correspondan: un número con su unidad, o un texto.</p>
    </header>
    <section className="catalog-panel" aria-labelledby="catalog-other-products-create-title">
      <div className="catalog-panel-head">
        <div>
          <h2 id="catalog-other-products-create-title">Nuevo producto</h2>
          <p className="catalog-hint">Nombre del producto y sus campos. El identificador lo asigna el servidor; el nombre es único entre los productos activos.</p>
        </div>
        <span className="catalog-tag">Catálogo activo</span>
      </div>
      <form aria-busy={busy} onSubmit={event => void createProduct(event)}>
        <div className="catalog-pair">
          <label htmlFor="catalog-other-products-name">Nombre
            <input id="catalog-other-products-name" value={create.name} autoComplete="off" disabled={busy}
              aria-describedby="catalog-other-products-name-hint"
              onChange={event => { setCreateProblem(''); setCreate(current => ({ ...current, name: event.target.value })); }} />
          </label>
        </div>
        <p id="catalog-other-products-name-hint" className="catalog-hint">Por ejemplo, Agua acidulada. Entre 3 y 64 bytes, sin espacios al principio ni al final.</p>
        <FieldEditor prefix="catalog-other-products-create" rows={create.rows} disabled={busy}
          onAdd={() => { setCreateProblem(''); setCreate(current => ({ ...current, rows: [...current.rows, newRow()] })); }}
          onRemove={key => { setCreateProblem(''); setCreate(current => ({ ...current, rows: current.rows.filter(row => row.key !== key) })); }}
          onChange={patchCreate} />
        <div className="catalog-actions">
          <button type="submit" className="primary" disabled={busy}>Crear producto</button>
        </div>
      </form>
      {createProblem !== '' && <p role="alert" className="catalog-status">{createProblem}</p>}
    </section>
    <section className="catalog-panel" aria-labelledby="catalog-other-products-list-title" aria-busy={state.phase === 'loading'}>
      <div className="catalog-panel-head">
        <div>
          <h2 id="catalog-other-products-list-title">Otros productos</h2>
          <p className="catalog-hint">{`${total} ${total === 1 ? 'producto' : 'productos'} · cada uno con sus campos personalizados`}</p>
        </div>
        <span className="catalog-tag">{state.phase === 'ready' ? `${rows.length} en esta página` : 'Almacén'}</span>
      </div>
      <div className="catalog-filters">
        <label htmlFor="catalog-other-products-search">Buscar producto
          <input id="catalog-other-products-search" type="search" value={search} placeholder="Agua acidulada" disabled={busy}
            onChange={event => { setPageNumber(1); setSearch(event.target.value); }} />
        </label>
      </div>
      {rows.length > 0 && <div className="catalog-table-wrap">
        <table className="catalog-table">
          <caption className="sr-only">Otros productos del catálogo activo, con sus campos y sus acciones</caption>
          <thead><tr>
            <th scope="col">Producto</th><th scope="col">Campos</th><th scope="col">Acciones</th>
          </tr></thead>
          <tbody>{rows.map(row => {
            const detailId = `catalog-other-product-detail-${row.id}`;
            const editing = edit !== null && edit.id === row.id;
            const archiving = archive === row.id;
            return [
              <tr key={`row-${row.id}`} data-product-id={row.id} className="catalog-row" aria-expanded={editing || archiving}
                aria-controls={detailId}>
                <td data-label="Producto"><strong>{row.name}</strong>
                  <small>{catalogOtherFieldsCountLabel(row.fields)}</small></td>
                <td data-label="Campos"><div className="catalog-chips">
                  {row.fields.length === 0
                    ? <span className="catalog-chip short">Sin campos</span>
                    : row.fields.map(field => <span key={field.name} className="catalog-chip">{catalogOtherFieldLabel(field)}</span>)}
                </div></td>
                <td data-label="Acciones"><div className="catalog-actions">
                  <button type="button" disabled={busy} aria-label={`Editar ${productLabel(row)}`}
                    onClick={() => openEdit(row)}>Editar</button>
                  <button type="button" disabled={busy} aria-label={`Retirar ${productLabel(row)}`}
                    onClick={() => openArchive(row)}>Retirar</button>
                </div></td>
              </tr>,
              <tr key={`detail-${row.id}`} id={detailId} className="catalog-detail" hidden={!editing && !archiving}>
                <td colSpan={3}>{editing && edit !== null && <div className="catalog-detail-inner">
                  <form aria-label={`Editar ${row.name}`} aria-busy={busy} onSubmit={event => void saveEdit(event)}>
                    <h3>{`Editar ${row.name}`}</h3>
                    <p className="catalog-hint">La edición reemplaza todos los campos del producto: los que quites no se conservan y los nuevos se guardan en su lugar.</p>
                    <label htmlFor={`catalog-other-products-new-name-${row.id}`}>Nuevo nombre
                      <input id={`catalog-other-products-new-name-${row.id}`} value={edit.name} autoComplete="off" disabled={busy}
                        onChange={event => { setEditProblem(''); setEdit(current => current === null ? null : { ...current, name: event.target.value }); }} />
                    </label>
                    <FieldEditor prefix={`catalog-other-products-edit-${row.id}`} rows={edit.rows} disabled={busy}
                      onAdd={() => { setEditProblem(''); setEdit(current => current === null ? null : { ...current, rows: [...current.rows, newRow()] }); }}
                      onRemove={key => { setEditProblem(''); setEdit(current => current === null ? null : { ...current, rows: current.rows.filter(entry => entry.key !== key) }); }}
                      onChange={patchEdit} />
                    <div className="catalog-actions">
                      <button type="button" className="catalog-cancel" disabled={busy} onClick={closeEditor}>Cancelar</button>
                      <button type="submit" className="primary" disabled={busy}>Guardar cambios</button>
                    </div>
                    {editProblem !== '' && <p role="alert" className="catalog-status">{editProblem}</p>}
                  </form>
                </div>}
                {archiving && <div className="catalog-detail-inner">
                  <fieldset className="catalog-branches">
                    <legend>{`Retirar ${row.name}`}</legend>
                    <p>Retirar {row.name} lo saca del catálogo para siempre: no se puede volver a activar y las transferencias e ingresos pasados lo siguen mostrando. Sus existencias deben estar en cero y no puede tener transferencias pendientes.</p>
                    <div className="catalog-actions">
                      <button type="button" className="catalog-cancel" disabled={busy}
                        onClick={() => { if (!busy) setArchive(null); }}>Cancelar retiro</button>
                      <button type="button" className="primary" disabled={busy}
                        onClick={() => void archiveProduct(row.id)}>Confirmar retiro</button>
                    </div>
                  </fieldset>
                </div>}
                </td>
              </tr>,
            ];
          })}</tbody>
        </table>
      </div>}
      {state.phase === 'loading' && <p className="catalog-message" role="status">Consultando el catálogo de otros productos…</p>}
      {state.phase === 'error' && <p className="catalog-message" role="alert">{state.problem}
        <button type="button" disabled={busy} onClick={() => setRevision(value => value + 1)}>Reintentar catálogo</button></p>}
      {state.phase === 'ready' && rows.length === 0 && <p className="catalog-message">Sin productos para esta consulta.</p>}
      {listProblem !== '' && <p role="alert" className="catalog-status">{listProblem}</p>}
      <footer className="pager" aria-label="Paginación del catálogo de otros productos">
        <span className="range" aria-live="polite">{page
          ? `Mostrando ${firstRow}–${lastRow} de ${total} ${total === 1 ? 'producto' : 'productos'}`
          : 'Sin resultados cargados.'}</span>
        <div className="page-controls">
          <label htmlFor="catalog-other-products-page-size">Productos por página</label>
          <select id="catalog-other-products-page-size" value={pageSize} disabled={busy}
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
      <p className="catalog-hint">Retirar reemplaza a eliminar y no se deshace. Un producto retirado deja de aparecer en el catálogo aunque sus operaciones pasadas lo sigan nombrando.</p>
    </section>
  </section>;
}
