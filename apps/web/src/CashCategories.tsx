import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import TransferDate from './shared/TransferDate';
import { subscribeCatalogueInvalidation } from './useInventory';
import {
  CashCategoriesAPIError, cashCategoriesArchivedEmpty, cashCategoriesEmpty, cashCategoriesErrorMessages,
  cashCategoriesListUnavailable, cashCategoriesLoading, cashCategoryDuplicateMessage,
  cashCategoryLastActiveReason, cashCategoryPinnedReason, createCashCategoriesAPI,
  validateCashCategoryLabel, type AdminCashCategory,
} from './cashCategoriesAPI';
// The catalogue's own layout, tokens and 44px targets: this screen adds no colour
// and no new spacing, so it reuses the price screen's sheet instead of a new one.
import './catalog-prices.css';

/** The cajón de sastre: named here because the server pins this one motive and never archives it (S10). */
export const pinnedCashMotiveLabel = 'Otros gastos';

interface CatalogueState {
  readonly phase: 'loading' | 'ready' | 'error';
  readonly categories: readonly AdminCashCategory[];
  readonly problem: string;
}

const initialCatalogueState: CatalogueState = Object.freeze({
  phase: 'loading', categories: [], problem: '',
});

/** The row being renamed: the identity and the label the field starts with (S4). */
interface RenameDraft { readonly id: number; readonly label: string }

export interface CashCategoriesProps {
  // The shell remounts this section per session fence, exactly like the other catalogue
  // screens, so a rotated session can never publish a motive into a newer one.
  csrf: string;
  fetcher?: typeof globalThis.fetch;
}

const place = (index: number) => String(index + 1).padStart(2, '0');

/**
 * The administration of the closed catalogue of cash motives (S3, S4, S5, S10, S13): a tab of
 * Almacén › Catálogo that lists the active motives in their order, creates at the foot, renames in
 * place, confirms the archival and keeps the archived ones in a collapsed block with their
 * reactivation. Every write re-reads the list, and so does the catalogue's realtime invalidation.
 */
export default function CashCategories({ csrf, fetcher = globalThis.fetch }: CashCategoriesProps) {
  const api = useMemo(() => createCashCategoriesAPI(fetcher), [fetcher]);
  const [state, setState] = useState<CatalogueState>(initialCatalogueState);
  const [revision, setRevision] = useState(0);
  const [label, setLabel] = useState('');
  const [createProblem, setCreateProblem] = useState('');
  const [rename, setRename] = useState<RenameDraft | null>(null);
  const [renameProblem, setRenameProblem] = useState('');
  const [archive, setArchive] = useState<number | null>(null);
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
  // Every handler checks the same fence: a reply from an aborted or replaced mount never
  // mutates the state of the session that is reading now.
  const alive = () => mounted.current && !lifetime.current.signal.aborted;

  useEffect(() => {
    const controller = new AbortController();
    // The fence is read from the refs, so this effect depends on the revision alone.
    const current = () => mounted.current && !lifetime.current.signal.aborted && !controller.signal.aborted;
    // A re-read of a list already on screen keeps it: the operator still has motives to work
    // with, and the last read is a fact of the catalogue, not of this attempt.
    setState(previous => previous.phase === 'ready'
      ? previous : { phase: 'loading', categories: previous.categories, problem: '' });
    void (async () => {
      try {
        const categories = await api.list(controller.signal);
        if (!current()) return;
        setState({ phase: 'ready', categories, problem: '' });
      } catch (failure) {
        if (!current()) return;
        if (failure instanceof CashCategoriesAPIError && failure.code === 'aborted') return;
        const code = failure instanceof CashCategoriesAPIError ? failure.code : 'invalid_response';
        const problem = code === 'forbidden'
          ? cashCategoriesErrorMessages.forbidden : cashCategoriesListUnavailable;
        setState(previous => previous.phase === 'ready' ? previous
          : { phase: 'error', categories: [], problem });
      }
    })();
    return () => controller.abort();
  }, [api, revision]);

  // The catalogue is global, so its frame reaches every session: a motive created or archived
  // anywhere arrives here without a reload (S8, S13).
  useEffect(() => subscribeCatalogueInvalidation(
    () => setRevision(value => value + 1)), []);

  const categories = state.categories;
  const active = categories.filter(category => category.state === 'active');
  const archived = categories.filter(category => category.state === 'retired');

  /** One refusal in the words of the operation: the duplicate is the one that names the label (S13). */
  function refused(failure: unknown, typed: string): string {
    const code = failure instanceof CashCategoriesAPIError ? failure.code : 'invalid_response';
    return code === 'duplicate_label'
      ? cashCategoryDuplicateMessage(typed)
      : cashCategoriesErrorMessages[code] ?? cashCategoriesErrorMessages.invalid_response;
  }

  function retry() {
    setListProblem('');
    setRevision(value => value + 1);
  }

  async function createCategory(event: FormEvent) {
    event.preventDefault();
    if (pending.current || !alive()) return;
    const validation = validateCashCategoryLabel(label);
    setNotice(''); setListProblem(''); setCreateProblem('');
    if (!validation.valid) { setCreateProblem(validation.message); return; }
    pending.current = true; setBusy(true);
    try {
      const created = await api.create(validation.label, csrf, lifetime.current.signal);
      if (!alive()) return;
      // The typed label stays only while the server refused it; a created motive clears the field.
      setLabel('');
      setNotice(`Motivo «${created.label}» agregado al final de la lista.`);
      // Never assume the result: the list is read again.
      setRevision(value => value + 1);
    } catch (failure) {
      // The field keeps exactly what was typed, so the operator can correct it.
      if (alive()) setCreateProblem(refused(failure, validation.label));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  function openRename(row: AdminCashCategory) {
    if (busy || pending.current) return;
    setCreateProblem(''); setRenameProblem(''); setListProblem(''); setNotice('');
    setArchive(null);
    setRename({ id: row.id, label: row.label });
  }
  function closeRename() {
    if (busy) return;
    setRename(null); setRenameProblem('');
  }
  function openArchive(row: AdminCashCategory) {
    if (busy || pending.current) return;
    setCreateProblem(''); setRenameProblem(''); setListProblem(''); setNotice('');
    setRename(null);
    setArchive(row.id);
  }
  function closeArchive() {
    if (busy) return;
    setArchive(null);
  }

  async function saveRename(event: FormEvent) {
    event.preventDefault();
    if (pending.current || !alive() || rename === null) return;
    const validation = validateCashCategoryLabel(rename.label);
    setNotice(''); setRenameProblem('');
    if (!validation.valid) { setRenameProblem(validation.message); return; }
    pending.current = true; setBusy(true);
    try {
      const saved = await api.rename(rename.id, validation.label, csrf, lifetime.current.signal);
      if (!alive()) return;
      setRename(null);
      setNotice(`Motivo renombrado: «${saved.label}». Los gastos ya registrados conservan la etiqueta anterior.`);
      setRevision(value => value + 1);
    } catch (failure) {
      if (alive()) setRenameProblem(refused(failure, validation.label));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function retireCategory(row: AdminCashCategory) {
    if (pending.current || !alive() || archive !== row.id) return;
    pending.current = true; setBusy(true); setNotice(''); setListProblem('');
    try {
      await api.retire(row.id, csrf, lifetime.current.signal);
      if (!alive()) return;
      setArchive(null);
      setNotice(`Motivo «${row.label}» archivado. Podés reactivarlo desde «Archivados».`);
      setRevision(value => value + 1);
    } catch (failure) {
      // The confirmation closes so the operator reads the reason before retrying.
      if (alive()) { setArchive(null); setListProblem(refused(failure, row.label)); }
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function reactivateCategory(row: AdminCashCategory) {
    if (pending.current || !alive()) return;
    pending.current = true; setBusy(true); setNotice(''); setListProblem('');
    try {
      await api.reactivate(row.id, csrf, lifetime.current.signal);
      if (!alive()) return;
      setNotice(`Motivo «${row.label}» reactivado: vuelve a ofrecerse en las sucursales.`);
      setRevision(value => value + 1);
    } catch (failure) {
      if (alive()) setListProblem(refused(failure, row.label));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return <section className="catalog-prices cash-motives" aria-labelledby="cash-motives-title">
    <header className="catalog-heading">
      <small>ALMACÉN / CATÁLOGO</small>
      <h1 id="cash-motives-title">Motivos de caja</h1>
      <p>Las opciones que la sucursal elige cuando registra un gasto. Un motivo archivado deja de
        ofrecerse y <strong>nunca se borra</strong>: los gastos que lo usaron siguen explicándose con
        su etiqueta. La lista es la misma para todas las sucursales.</p>
    </header>
    <section className="catalog-panel" aria-labelledby="cash-motives-active-title"
      aria-busy={state.phase === 'loading' || busy}>
      <div className="catalog-panel-head">
        <div>
          <h2 id="cash-motives-active-title">Motivos activos</h2>
          <p className="catalog-hint">En el orden en que la sucursal los ve en el selector. El que se agrega va al final.</p>
        </div>
        <span className="catalog-tag">{`${active.length} ${active.length === 1 ? 'activo' : 'activos'}`}</span>
      </div>

      {state.phase === 'loading' && <p className="catalog-message" role="status">{cashCategoriesLoading}</p>}
      {state.phase === 'error' && <p className="catalog-message" role="alert">{state.problem}
        <button type="button" disabled={busy} onClick={retry}>Reintentar catálogo de motivos</button></p>}

      {state.phase === 'ready' && <>
        {active.length === 0
          ? <p className="catalog-message">{cashCategoriesEmpty}</p>
          : <div className="catalog-table-wrap">
            <table className="catalog-table">
              <caption className="catalog-hint">Un motivo nuevo tarda lo que tarda el aviso en llegar: la sucursal lo ve sin recargar la página.</caption>
              <thead><tr>
                <th scope="col">Nº</th><th scope="col">Motivo</th><th scope="col">Estado</th><th scope="col">Acciones</th>
              </tr></thead>
              <tbody>{active.map((row, index) => {
                const pinned = row.label === pinnedCashMotiveLabel;
                // The last active motive is never archived either: without motives the branch
                // could not record an expense, so the server refuses it and the screen says why.
                const lastActive = active.length === 1;
                const blocked = pinned ? cashCategoryPinnedReason
                  : lastActive ? cashCategoryLastActiveReason : '';
                const reasonId = `cash-motives-blocked-${row.id}`;
                const detailId = `cash-motives-detail-${row.id}`;
                const renaming = rename !== null && rename.id === row.id;
                const archiving = archive === row.id;
                return [
                  <tr key={`row-${row.id}`} data-motive-id={row.id} className="catalog-row"
                    aria-expanded={renaming || archiving} aria-controls={detailId}>
                    <td data-label="Nº"><span className="cash-motives-place">{place(index)}</span></td>
                    <td data-label="Motivo"><strong>{row.label}</strong></td>
                    <td data-label="Estado"><span className="cash-motives-state active">Activo</span></td>
                    <td data-label="Acciones"><div className="catalog-actions">
                      <button type="button" disabled={busy} aria-label={`Renombrar ${row.label}`}
                        aria-expanded={renaming} aria-controls={detailId}
                        onClick={() => openRename(row)}>Renombrar</button>
                      <button type="button" disabled={busy || blocked !== ''} aria-label={`Archivar ${row.label}`}
                        aria-describedby={blocked === '' ? undefined : reasonId}
                        aria-expanded={archiving} aria-controls={detailId}
                        onClick={() => openArchive(row)}>Archivar</button>
                    </div>
                    {blocked !== '' && <small id={reasonId} className="cash-motives-reason">{blocked}</small>}
                    </td>
                  </tr>,
                  <tr key={`detail-${row.id}`} id={detailId} className="catalog-detail"
                    hidden={!renaming && !archiving}>
                    <td colSpan={4}>
                      {renaming && rename !== null && <div className="catalog-detail-inner">
                        <form aria-label={`Renombrar ${row.label}`} aria-busy={busy}
                          onSubmit={event => void saveRename(event)}>
                          <h3>{`Renombrar ${row.label}`}</h3>
                          <div className="catalog-pair">
                            <label htmlFor={`cash-motives-rename-${row.id}`}>Nuevo nombre
                              <input id={`cash-motives-rename-${row.id}`} value={rename.label} autoComplete="off"
                                disabled={busy} onChange={event => {
                                  setRenameProblem('');
                                  setRename(current => current === null ? null
                                    : { ...current, label: event.target.value });
                                }} />
                            </label>
                          </div>
                          <p className="catalog-hint">Los gastos ya registrados conservan la etiqueta con la que
                            se guardaron: renombrar no reescribe la historia.</p>
                          <div className="catalog-actions">
                            <button type="button" className="catalog-cancel" disabled={busy}
                              onClick={closeRename}>Cancelar</button>
                            <button type="submit" className="primary" disabled={busy}>Guardar nombre</button>
                          </div>
                          {renameProblem !== '' && <p role="alert" className="catalog-status">{renameProblem}</p>}
                        </form>
                      </div>}
                      {archiving && <div className="catalog-detail-inner">
                        <fieldset className="catalog-branches">
                          <legend>{`Archivar ${row.label}`}</legend>
                          <p>{`Archivar «${row.label}» es reversible: deja de ofrecerse en las sucursales y podés reactivarlo cuando quieras. No toca ningún movimiento ya registrado.`}</p>
                          <div className="catalog-actions">
                            <button type="button" className="catalog-cancel" disabled={busy}
                              onClick={closeArchive}>Cancelar</button>
                            <button type="button" className="primary" disabled={busy}
                              onClick={() => void retireCategory(row)}>Confirmar archivo</button>
                          </div>
                        </fieldset>
                      </div>}
                    </td>
                  </tr>,
                ];
              })}</tbody>
            </table>
          </div>}

        {active.length > 0 && <div className="cash-motives-guard" id="cash-motives-guard">
          <span aria-hidden="true">◆</span>
          <p><b>«Otros gastos» no se archiva.</b> Es el cajón de sastre; sin él un gasto que no encaja
            en ningún motivo no tendría dónde ir. <b>Tampoco se puede archivar el último motivo
              activo:</b> sin ninguno, la sucursal no podría registrar un gasto.</p>
        </div>}

        <div className="cash-motives-create">
          <form aria-label="Agregar un motivo" aria-busy={busy} noValidate
            onSubmit={event => void createCategory(event)}>
            <div className="cash-motives-inline">
              <label htmlFor="cash-motives-new">Agregar un motivo
                <input id="cash-motives-new" value={label} autoComplete="off" disabled={busy}
                  aria-invalid={createProblem !== ''}
                  aria-describedby={createProblem === ''
                    ? 'cash-motives-new-hint' : 'cash-motives-new-hint cash-motives-new-error'}
                  onChange={event => { setCreateProblem(''); setLabel(event.target.value); }} />
              </label>
              <button type="submit" className="primary" disabled={busy}>Agregar al final</button>
            </div>
            <p id="cash-motives-new-hint" className="catalog-hint">Se agrega al final de la lista y aparece
              al final del selector de las sucursales. Hasta 500 caracteres, sin espacios al principio ni al final.</p>
            {createProblem !== '' && <p id="cash-motives-new-error" role="alert" className="catalog-status">
              <span aria-hidden="true">▲</span> {createProblem}</p>}
          </form>
        </div>

        <details className="cash-motives-archived">
          <summary>{`Archivados (${archived.length})`}</summary>
          {archived.length === 0
            ? <p className="catalog-message">{cashCategoriesArchivedEmpty}</p>
            : <div className="catalog-table-wrap">
              <table className="catalog-table">
                <caption className="catalog-hint">No se ofrecen en el selector. Los gastos que los usaron los siguen mostrando.</caption>
                <thead><tr><th scope="col">Motivo</th><th scope="col">Estado</th><th scope="col">Acciones</th></tr></thead>
                <tbody>{archived.map(row => <tr key={row.id} data-motive-id={row.id}>
                  <td data-label="Motivo"><strong>{row.label}</strong>
                    <small>Archivado el <TransferDate value={row.retired_at} /> por {row.retired_by}</small></td>
                  <td data-label="Estado"><span className="cash-motives-state retired">Archivado</span></td>
                  <td data-label="Acciones"><div className="catalog-actions">
                    <button type="button" disabled={busy} aria-label={`Reactivar ${row.label}`}
                      onClick={() => void reactivateCategory(row)}>Reactivar</button>
                  </div></td>
                </tr>)}</tbody>
              </table>
            </div>}
        </details>
      </>}

      {listProblem !== '' && <p role="alert" className="catalog-status">{listProblem}</p>}
      {notice !== '' && <p role="status" className="catalog-notice">{notice}</p>}
    </section>
  </section>;
}
