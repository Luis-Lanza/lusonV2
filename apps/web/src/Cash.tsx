import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  closingEvidencePath, closingEvidenceSizeText, closingEvidenceText, closingMoneyText,
  closingSignedText,
} from './closingModel';
import { centsToMoney, parseTypedMoney } from './pointOfSaleModel';
import TransferDate from './shared/TransferDate';
import { createMetricsAPI, metricsPeriodToken, MetricsAPIError, type MetricsPeriod } from './metricsAPI';
import { subscribeCatalogueInvalidation } from './useInventory';
import {
  CashAPIError, cashCatalogueUnavailable, cashErrorMessages, cashEvidenceRefusal, cashKindLabels,
  cashLedgerUnavailable, cashWrittenKinds, createCashAPI, type CashCategory, type CashLedger,
  type CashLedgerEntry, type CashMovementInput, type CashWrittenKind,
} from './cashAPI';

export interface CashProps {
  /** The token every write of the screen carries; a read never uses it. */
  csrf: string;
  /** The branch of the session: this screen never names another one (S12). */
  branch: string;
  fetcher?: typeof globalThis.fetch;
}

/** The words the form refuses with, before it ever asks the server for anything. */
const cashAmountMessage = 'Escribí un monto válido, con hasta dos decimales.';
const cashZeroMessage = 'Escribí un monto mayor a cero: el libro no registra movimientos en cero.';
const cashDescriptionMessage = 'Escribí el motivo del movimiento.';
/** The motive of an expense is chosen from the closed list and is mandatory: it is never typed (S1, S3). */
const cashMotiveMessage = 'Elegí un motivo de la lista: un gasto sin motivo no se registra.';
const cashMotiveCatalogueEmpty =
  'La lista de motivos está vacía: no hay ninguno para registrar un gasto. Los aportes y las recaudaciones siguen funcionando.';
/** A motive archived while the operator had it chosen is announced, never dropped in silence (S11, S4). */
const cashMotiveArchivedMessage = (label: string) =>
  `El motivo «${label}» ya no está disponible: se archivó mientras registrabas el gasto. Elegí otro de la lista.`;
const cashCorrectionRowReason = 'Las correcciones no se corrigen.';
const cashCorrectedRowReason = 'Ya está corregido por completo.';
const cashFrozenRowReason = 'La sucursal está congelada: no se corrige mientras dure la rendición.';
const cashClosedRowReason = 'Los movimientos de un período cerrado se resuelven en la rendición.';

/** The three states of the read of the book, in the order the screen travels them. */
interface BookState {
  readonly phase: 'loading' | 'ready' | 'error';
  readonly book: CashLedger | null;
  readonly problem: string;
}

const initialBookState: BookState = Object.freeze({ phase: 'loading', book: null, problem: '' });

/** The three states of the read of the closed list of motives, and its own failure (S1, S2). */
interface CatalogueState {
  readonly phase: 'loading' | 'ready' | 'error';
  readonly options: readonly CashCategory[];
  readonly problem: string;
}

const initialCatalogueState: CatalogueState = Object.freeze({
  phase: 'loading', options: [], problem: '',
});

/** One chosen photo of an expense: the file, the preview the browser shows of it and, while it has not
 * been judged yet, no preview at all (S1). */
interface Evidence {
  readonly file: File;
  readonly preview: string | null;
}

const money = (cents: bigint): string => closingMoneyText(cents);
const signed = (cents: bigint): string => closingSignedText(cents);

/** One cell of the band: the figure and, under it, what the figure is about. */
function BandCell({ title, value, note, tone }: {
  title: string; value: string; note: string; tone?: 'in' | 'out' | 'lead';
}) {
  const className = tone === undefined ? 'cash-band-value' : `cash-band-value cash-${tone}`;
  return <div className="cash-band-cell">
    <dt>{title}</dt>
    <dd><span className={className}>{value}</span><span className="cash-band-sub">{note}</span></dd>
  </div>;
}

/** The words of one movement of the book, in the order the counts of the band state them. */
function movementCount(count: number, one: string, many: string): string | null {
  if (count === 0) return null;
  return count === 1 ? `1 ${one}` : `${count} ${many}`;
}

/**
 * The screen of the operational drawer (S1, S2, S8): the book of the period with its four numbers, the
 * card that writes a gasto, an aporte or a recaudación, and the correction of one row. It is not the
 * purchase fund: the two boxes are named apart and neither moves the other (S3).
 */
export default function Cash({ csrf, branch, fetcher = globalThis.fetch }: CashProps) {
  const api = useMemo(() => createCashAPI(fetcher), [fetcher]);
  const metrics = useMemo(() => createMetricsAPI(fetcher), [fetcher]);
  const [state, setState] = useState<BookState>(initialBookState);
  const [periods, setPeriods] = useState<readonly MetricsPeriod[]>([]);
  const [periodsProblem, setPeriodsProblem] = useState('');
  /** The chosen window: the live one (no bounds) or the id of one closed settlement. */
  const [selection, setSelection] = useState('live');
  const [revision, setRevision] = useState(0);

  const [kind, setKind] = useState<CashWrittenKind>('gasto');
  const [amount, setAmount] = useState('');
  /** The motive of an expense: the identity of the option of the closed list, never typed text (S1). */
  const [category, setCategory] = useState('');
  /** The note beside the motive of an expense: optional, and the empty string is a legitimate note (S3). */
  const [note, setNote] = useState('');
  /** The hand-typed motive of an aporte and of a recaudación, which keeps working as it does today (S4). */
  const [reason, setReason] = useState('');
  const [formProblem, setFormProblem] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [frozen, setFrozen] = useState(false);
  const [catalogue, setCatalogue] = useState<CatalogueState>(initialCatalogueState);
  /** The attempts of the read of the catalogue: one when the screen loads, one per retry and one per
   * catalogue invalidation the shell receives from the stream (S8). */
  const [catalogueAttempt, setCatalogueAttempt] = useState(0);
  /** Why the chosen motive is gone, in the words of the operator; empty when the choice still stands. */
  const [motiveNotice, setMotiveNotice] = useState('');
  /** The motive the operator chose, kept beside the select so a re-read can tell whether it survived. */
  const chosenMotive = useRef({ id: '', label: '' });

  /** The photo of the expense being written: at most one, always optional (S1). */
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  /** Why the chosen photo cannot be sent, in the words of the operator; empty when it can. */
  const [evidenceProblem, setEvidenceProblem] = useState('');
  /** Whether the chosen photo is still being judged, so no submit leaves before there is an answer. */
  const [checkingEvidence, setCheckingEvidence] = useState(false);
  const evidenceInput = useRef<HTMLInputElement>(null);
  /** The object URL of the preview, given back as soon as it is replaced or let go. */
  const previewURL = useRef<string | null>(null);
  /** The attempt of the last chosen photo: a judgement still in flight never lands on a later choice. */
  const evidenceAttempt = useRef(0);

  const [correcting, setCorrecting] = useState<CashLedgerEntry | null>(null);
  const [correctionAmount, setCorrectionAmount] = useState('');
  const [correctionReason, setCorrectionReason] = useState('');
  const [correctionProblem, setCorrectionProblem] = useState('');
  const amountInput = useRef<HTMLInputElement>(null);
  const correctionInput = useRef<HTMLInputElement>(null);

  // The closed list of motives is read when the screen loads and again on every invalidation of the
  // catalogue, with its own state: an expense cannot be registered without it, while an aporte and a
  // recaudación name no motive of the list (S1, S4). A re-read keeps the options already shown instead of
  // blanking the form, and a motive archived while it was chosen is announced, never dropped in silence (S8, S11).
  useEffect(() => {
    const controller = new AbortController();
    setCatalogue(current => current.phase === 'error' ? initialCatalogueState : current);
    void (async () => {
      try {
        const options = await api.categories(controller.signal);
        if (controller.signal.aborted) return;
        setCatalogue({ phase: 'ready', options, problem: '' });
        const chosen = chosenMotive.current;
        if (chosen.id !== '' && !options.some(option => String(option.id) === chosen.id)) {
          chosenMotive.current = { id: '', label: '' };
          setCategory('');
          setMotiveNotice(cashMotiveArchivedMessage(chosen.label));
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof CashAPIError && error.code === 'aborted') return;
        // A failed re-read of a list already on screen keeps it: the operator still has motives to choose
        // from, and the last read is a fact of the catalogue, not of this attempt.
        setCatalogue(current => current.phase === 'ready'
          ? current
          : { phase: 'error', options: [], problem: cashCatalogueUnavailable });
      }
    })();
    return () => controller.abort();
  }, [api, catalogueAttempt]);

  // The catalogue is global, so its frame reaches every session: a motive created or archived by the
  // administration arrives here without a reload (S8).
  useEffect(() => subscribeCatalogueInvalidation(
    () => setCatalogueAttempt(current => current + 1)), []);

  // The windows the screen may ask for are the ones the metrics reader already publishes with their
  // instants: the closed settlements. The live one is the store's own default window, which starts at
  // the last cut with the amount that closure left in the drawer, so no instant is invented here (S12).
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const answer = await metrics.read('all', controller.signal);
        if (controller.signal.aborted) return;
        setPeriods(answer.periods);
        setPeriodsProblem('');
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof MetricsAPIError && error.code === 'aborted') return;
        setPeriods([]);
        setPeriodsProblem(
          'No se pudieron leer los cierres de la sucursal: el libro muestra el período en curso. Reintentar los vuelve a pedir.');
      }
    })();
    return () => controller.abort();
  }, [metrics, revision]);

  const windows = periods.filter(period => period.kind === 'settlement');
  const chosen = windows.find(period => metricsPeriodToken(period) === selection) ?? null;
  const from = chosen === null ? null : chosen.from;
  const to = chosen === null ? null : chosen.to;

  useEffect(() => {
    const controller = new AbortController();
    // Every figure waits for the same answer: a book of another window is never shown beside this one.
    setState({ phase: 'loading', book: null, problem: '' });
    void (async () => {
      try {
        const book = await api.ledger(from, to, controller.signal);
        if (!controller.signal.aborted) setState({ phase: 'ready', book, problem: '' });
      } catch (error) {
        if (controller.signal.aborted) return;
        const code = error instanceof CashAPIError ? error.code : 'invalid_response';
        if (code === 'aborted') return;
        setState({ phase: 'error', book: null,
          problem: code === 'invalid_response' ? cashErrorMessages.invalid_response
            : code === 'network' ? cashLedgerUnavailable
              : cashErrorMessages[code] ?? cashLedgerUnavailable });
      }
    })();
    return () => controller.abort();
  }, [api, from, to, revision]);

  useEffect(() => {
    if (correcting !== null) correctionInput.current?.focus();
  }, [correcting]);

  // Esc closes the correction: it is the other way out of the panel, and it never writes.
  useEffect(() => {
    if (correcting === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setCorrecting(null);
      setCorrectionProblem('');
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [correcting]);

  const book = state.book;
  /** Whether an expense can be recorded at all: the list offers at least one motive to pick. */
  const gastoReady = catalogue.phase === 'ready' && catalogue.options.length > 0;

  /** The money a movement still has to answer: its own amount minus the corrections already written. */
  function remainingOf(entry: CashLedgerEntry): bigint {
    if (book === null) return entry.amount_cents;
    const corrected = book.movements
      .filter(movement => movement.corrects_id === entry.id)
      .reduce((total, movement) => total + movement.amount_cents, 0n);
    return entry.amount_cents - corrected;
  }

  /** Why a row cannot be corrected, in words; `null` when it can. */
  function blockedReason(entry: CashLedgerEntry): string | null {
    if (frozen) return cashFrozenRowReason;
    if (entry.kind === 'correccion') return cashCorrectionRowReason;
    if (remainingOf(entry) <= 0n) return cashCorrectedRowReason;
    // A movement of a period a closure already signed is answered in the rendición, never here (S7).
    if (chosen !== null) return cashClosedRowReason;
    return null;
  }

  /** The typed amount, in cents, or the message that says why it cannot be sent. */
  function typedCents(typed: string): { cents: bigint } | { problem: string } {
    let cents: bigint;
    try { cents = parseTypedMoney(typed); } catch { return { problem: cashAmountMessage }; }
    if (cents <= 0n) return { problem: cashZeroMessage };
    return { cents };
  }

  function refuse(error: unknown): string {
    if (error instanceof CashAPIError) {
      if (error.code === 'branch_frozen') {
        // The branch is frozen by a live settlement (S9): the card is replaced by the reason.
        setFrozen(true);
        setFormProblem('');
        setCorrectionProblem('');
        setCorrecting(null);
        return cashErrorMessages.branch_frozen;
      }
      return cashErrorMessages[error.code] ?? cashErrorMessages.invalid_response;
    }
    return cashErrorMessages.invalid_response;
  }

  /** The refusal of the till states both quantities -- what the drawer holds and what the movement asked
   * -- so the operator reads the gap instead of a rule (S4). `null` when the refusal is another one. */
  function drawerRefusal(problem: unknown, requested: bigint): string | null {
    if (!(problem instanceof CashAPIError) || problem.code !== 'drawer_insufficient') return null;
    if (book === null) return cashErrorMessages.drawer_insufficient;
    return `${cashErrorMessages.drawer_insufficient} El cajón tiene ${closingMoneyText(
      book.expected_cents)} y el movimiento pide ${closingMoneyText(requested)}.`;
  }

  /** The browser's own URL of the chosen file: the preview an <img> can show before anything is sent. */
  function setPreview(file: File | null): string | null {
    if (previewURL.current !== null) URL.revokeObjectURL(previewURL.current);
    previewURL.current = file === null ? null : URL.createObjectURL(file);
    return previewURL.current;
  }

  /** One photo is chosen at a time: a second choice replaces the first and is never added to it (S1). */
  async function chooseEvidence(file: File) {
    evidenceAttempt.current += 1;
    const attempt = evidenceAttempt.current;
    setEvidence({ file, preview: null });
    setEvidenceProblem('');
    setCheckingEvidence(true);
    const refusal = await cashEvidenceRefusal(file);
    if (attempt !== evidenceAttempt.current) return;
    setCheckingEvidence(false);
    if (refusal !== null) {
      // The file stays in the card with its name and its size, so the operator sees what was refused
      // and how big it is, and the movement is not written without the photo they attached (S6).
      setEvidenceProblem(cashErrorMessages[refusal]);
      return;
    }
    setEvidence({ file, preview: setPreview(file) });
  }

  /** Lets the chosen photo go, with its preview and the field the operator picked it from. */
  function removeEvidence() {
    evidenceAttempt.current += 1;
    setPreview(null);
    setEvidence(null);
    setEvidenceProblem('');
    setCheckingEvidence(false);
    if (evidenceInput.current !== null) evidenceInput.current.value = '';
  }

  // The preview belongs to the browser and is given back when the card goes away.
  useEffect(() => () => { if (previewURL.current !== null) URL.revokeObjectURL(previewURL.current); }, []);

  async function submitMovement(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setFormProblem(''); setNotice('');
    const typed = typedCents(amount);
    if ('problem' in typed) { setFormProblem(typed.problem); return; }
    let input: CashMovementInput;
    // Only an expense may carry a photo, and only when the operator chose one (S1, S2).
    let photo: File | null = null;
    if (kind === 'gasto') {
      // Without the closed list there is nothing to pick, and the card already says why.
      if (!gastoReady) return;
      const option = catalogue.options.find(entry => String(entry.id) === category);
      // A gasto writes no motive of its own: it either names one of the list or it is not recorded (S1, S3).
      if (option === undefined) { setFormProblem(cashMotiveMessage); return; }
      // The photo is judged on this side before anything leaves the screen: a movement is never written
      // without the receipt the operator attached to it (S1, S6).
      if (checkingEvidence) return;
      if (evidenceProblem !== '') return;
      input = { kind, amount: centsToMoney(typed.cents), category_id: option.id, description: note };
      photo = evidence === null ? null : evidence.file;
    } else {
      const motive = reason.trim();
      if (motive === '') { setFormProblem(cashDescriptionMessage); return; }
      input = { kind, amount: centsToMoney(typed.cents), description: motive };
    }
    setBusy(true);
    try {
      await api.record(input, csrf, undefined, photo);
      setAmount(''); setCategory(''); setNote(''); setReason('');
      // The form states no motive any more, so nothing can be announced as archived from under it: a later
      // archival of the motive that was just written must not read as a choice that disappeared.
      chosenMotive.current = { id: '', label: '' };
      setMotiveNotice('');
      removeEvidence();
      setNotice(`${cashKindLabels[kind]} registrado en el libro de la caja.`);
      // The book is read again, so the band and the list describe the movement that was just written.
      setRevision(value => value + 1);
    } catch (error) {
      setFormProblem(drawerRefusal(error, typed.cents) ?? refuse(error));
    } finally {
      setBusy(false);
    }
  }

  async function submitCorrection(event: FormEvent) {
    event.preventDefault();
    if (busy || correcting === null) return;
    setCorrectionProblem(''); setNotice('');
    const typed = typedCents(correctionAmount);
    if ('problem' in typed) { setCorrectionProblem(typed.problem); return; }
    const motive = correctionReason.trim();
    if (motive === '') { setCorrectionProblem(cashDescriptionMessage); return; }
    setBusy(true);
    try {
      await api.correct({ corrects_id: correcting.id, amount: centsToMoney(typed.cents),
        description: motive }, csrf);
      setCorrecting(null); setCorrectionAmount(''); setCorrectionReason('');
      setNotice(`Corrección registrada para el movimiento #${correcting.id}.`);
      setRevision(value => value + 1);
    } catch (error) {
      setCorrectionProblem(drawerRefusal(error, typed.cents) ?? refuse(error));
    } finally {
      setBusy(false);
    }
  }

  function openCorrection(entry: CashLedgerEntry) {
    setCorrecting(entry);
    setCorrectionAmount('');
    setCorrectionReason('');
    setCorrectionProblem('');
    setFormProblem(''); setNotice('');
  }

  const kinds = book === null ? null : {
    gasto: book.movements.filter(movement => movement.kind === 'gasto').length,
    aporte: book.movements.filter(movement => movement.kind === 'aporte').length,
    recaudacion: book.movements.filter(movement => movement.kind === 'recaudacion').length,
    correccion: book.movements.filter(movement => movement.kind === 'correccion').length,
  };
  const netNote = kinds === null ? 'los movimientos del período'
    : [
      movementCount(kinds.gasto, 'gasto', 'gastos'),
      movementCount(kinds.aporte, 'aporte', 'aportes'),
      movementCount(kinds.recaudacion, 'recaudación', 'recaudaciones'),
      movementCount(kinds.correccion, 'corrección', 'correcciones'),
    ].filter(note => note !== null).join(' · ') || 'sin movimientos en el período';

  return <section className="cash-workspace" aria-labelledby="cash-title">
    <header className="cash-heading">
      <h1 id="cash-title">Caja operativa</h1>
      <p className="cash-lede">
        {`El libro del cajón del mostrador de ${branch}: de acá sale el detergente y la escoba. `}
        <strong>Las compras de chatarra y baterías usadas salen del fondo de compras</strong>
        {', que es otra caja.'}
      </p>
    </header>

    <div className="cash-period" role="group" aria-label="Período del libro">
      <div className="cash-period-field">
        <label htmlFor="cash-period">Período</label>
        <select id="cash-period" value={chosen === null ? 'live' : selection}
          disabled={state.phase === 'loading'}
          onChange={event => {
            const picked = event.target.value;
            // Only a window this server published can be asked for.
            if (picked !== 'live' && !windows.some(period => metricsPeriodToken(period) === picked)) return;
            // The correction belongs to the row of the window on screen: changing the window closes it.
            setCorrecting(null);
            setSelection(picked);
          }}>
          <option value="live">En curso · desde el último corte</option>
          {windows.map(period => <option key={metricsPeriodToken(period)}
            value={metricsPeriodToken(period)}>{period.label}</option>)}
        </select>
      </div>
      <p className="cash-provenance">
        <span className="cash-dot" aria-hidden="true" />
        {chosen === null ? 'En vivo · el cajón se mueve hasta el próximo corte'
          : <>Al cierre del <TransferDate value={chosen.to} /></>}
      </p>
      <p className="cash-period-note">
        {periodsProblem !== ''
          ? periodsProblem
          : chosen !== null
            ? <>{`${chosen.label} · cerrada · corte `}<TransferDate value={chosen.to} />
              {', período desde '}<TransferDate value={chosen.from} />
              {'. El libro y los cuatro números son los de ese cierre.'}</>
            : book !== null && book.since !== null
              ? <>Desde el corte del <TransferDate value={book.since} />
                {', con lo que ese cierre dejó en el cajón.'}</>
              : 'Desde el comienzo de la sucursal: todavía no hay un cierre que haya dejado un saldo.'}
      </p>
    </div>

    {state.phase === 'loading' && <p role="status" className="cash-note">Consultando el libro de la caja…</p>}

    {state.phase === 'error' && <p role="alert" className="cash-problem">
      {state.problem}
      <button type="button" onClick={() => setRevision(value => value + 1)}>Reintentar</button>
    </p>}

    {book !== null && <>
      <section className="cash-band-section" aria-labelledby="cash-band-title">
        <h2 id="cash-band-title" className="cash-section-title">Qué debería haber en el cajón</h2>
        <div role="group" aria-label="Números del cajón">
          <dl className="cash-band">
            <BandCell title="Quedó al cerrar" value={money(book.opening_cents)}
              note={book.since === null
                ? 'Sin cierre previo: la caja arranca en este período'
                : 'lo que dejó el último corte'} />
            <BandCell title="Ventas en efectivo" value={money(book.sales_cents)}
              note={chosen === null ? 'desde el corte' : 'del período del cierre'} />
            <BandCell title="Neto del libro" value={signed(book.effective_cents)}
              tone={book.effective_cents < 0n ? 'out' : book.effective_cents > 0n ? 'in' : undefined}
              note={netNote} />
            {/* The expectation of a settled window is what that settlement already asked for, and the
                live one is still what the next rendición is going to ask: the same number read as the
                fact it is instead of a promise about a period that is closed (S4, S13). */}
            <BandCell title="Esperado en el cajón" value={money(book.expected_cents)}
              tone="lead" note={chosen === null ? 'lo que la rendición va a pedir'
                : 'lo que esa rendición pidió'} />
          </dl>
        </div>
      </section>

      <div className="cash-columns">
        <section className="cash-ledger" aria-labelledby="cash-ledger-title">
          <h2 id="cash-ledger-title" className="cash-section-title">Libro del período</h2>
          <div className="cash-panel">
            {book.movements.length === 0
              ? <div className="cash-empty">
                <p>{chosen === null
                  ? 'Todavía no hay movimientos desde el corte'
                  : 'Este período no tiene movimientos en el libro.'}</p>
                <p className="cash-note">
                  Cada movimiento queda firmado con su autor y su momento: nada se edita ni se borra.
                </p>
                {!frozen && <button type="button" className="cash-first"
                  onClick={() => amountInput.current?.focus()}>
                  Registrar el primer movimiento
                </button>}
              </div>
              : <div className="cash-table-wrap">
                <table className="cash-table">
                  <caption className="cash-caption">
                    Cada movimiento queda firmado con su autor y su momento. Nada se edita ni se borra.
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Momento</th>
                      <th scope="col">Tipo</th>
                      <th scope="col">Motivo</th>
                      <th scope="col" className="cash-col-author">Autor</th>
                      <th scope="col" className="num">Monto</th>
                      <th scope="col"><span className="sr-only">Acciones</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {book.movements.map(entry => {
                      const blocked = blockedReason(entry);
                      return <tr key={entry.id} data-movement-id={entry.id}>
                        <td className="cash-when"><TransferDate value={entry.occurred_at} /></td>
                        <td><span className={`cash-kind cash-kind-${entry.kind}`}>
                          {cashKindLabels[entry.kind]}</span></td>
                        <td className="cash-motive">
                          {entry.category_label !== null && <span className="cash-motive-label">
                            {entry.category_label}</span>}
                          {entry.category_label === null
                            ? entry.description
                            : entry.description !== ''
                              && <span className="cash-motive-note">{entry.description}</span>}
                          {entry.corrects_id !== null && <span className="cash-ref">
                            {`Corrige el movimiento #${entry.corrects_id}`}
                          </span>}
                          {/* The row that carries a receipt opens the image itself: the book publishes
                              the metadata alone, and a row without a photo shows nothing extra (S7). */}
                          {entry.evidence !== null && <a className="cash-evidence-link"
                            href={closingEvidencePath(entry.id)} target="_blank" rel="noreferrer"
                            aria-label={`Ver el comprobante del movimiento #${entry.id}`}
                            title={closingEvidenceText(entry.evidence)}>Ver comprobante</a>}
                        </td>
                        <td className="cash-author cash-col-author">
                          {`Cuenta #${entry.created_by_account_id}`}
                        </td>
                        <td className={`num cash-amount ${entry.effective_cents < 0n ? 'cash-out' : 'cash-in'}`}>
                          {signed(entry.effective_cents)}
                        </td>
                        <td className="cash-action">
                          <button type="button" className="cash-fix"
                            aria-label={`Corregir el movimiento #${entry.id}`}
                            title={blocked ?? undefined}
                            disabled={blocked !== null || busy}
                            onClick={() => openCorrection(entry)}>Corregir</button>
                          {blocked !== null && <span className="cash-reason">{blocked}</span>}
                        </td>
                      </tr>;
                    })}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={4} className="cash-total-label">Neto del libro</td>
                      <td className="num cash-amount cash-total">{signed(book.effective_cents)}</td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>}
            {book.truncated && <p className="cash-truncated" role="status">
              Este período tiene más movimientos de los que se listan acá: la lista son los 500
              movimientos más nuevos y los cuatro números de arriba cuentan el período completo.
            </p>}
          </div>
        </section>

        <aside className="cash-rail" aria-label="Registrar movimiento">
          <h2 className="cash-section-title">Registrar movimiento</h2>
          <div className="cash-panel">
            {frozen
              ? <div className="cash-frozen" role="alert">
                <strong>La sucursal está congelada por una rendición en curso.</strong>
                <p>
                  El Almacén está rindiendo el cajón de esta sucursal: mientras la rendición esté
                  abierta no se registran gastos, aportes, recaudaciones ni correcciones, porque el
                  dinero que se cuenta no puede moverse debajo del conteo.
                </p>
                <p>Cuando la rendición se cierre vas a poder volver a registrar.</p>
              </div>
              : correcting !== null
                ? <form className="cash-form" role="group"
                  aria-label={`Corrección del movimiento #${correcting.id}`}
                  onSubmit={event => void submitCorrection(event)}>
                  <h3 className="cash-form-title">{`Corregir el movimiento #${correcting.id}`}</h3>
                  <dl className="cash-correction-facts">
                    <div><dt>Movimiento</dt>
                      <dd>{`${cashKindLabels[correcting.kind]} · ${money(correcting.amount_cents)}`}</dd></div>
                    <div><dt>Queda por corregir</dt>
                      <dd>{`Quedan ${money(remainingOf(correcting))} de ${money(correcting.amount_cents)} por corregir.`}</dd></div>
                  </dl>
                  <label htmlFor="cash-correction-amount">Monto de la corrección</label>
                  <input ref={correctionInput} id="cash-correction-amount" inputMode="decimal"
                    value={correctionAmount} disabled={busy}
                    onChange={event => setCorrectionAmount(event.target.value)} />
                  <label htmlFor="cash-correction-reason">Motivo de la corrección</label>
                  <textarea id="cash-correction-reason" value={correctionReason} disabled={busy}
                    onChange={event => setCorrectionReason(event.target.value)} />
                  <p className="cash-note">
                    El movimiento original no se edita: se responde con otro del signo contrario y el
                    tope es lo que todavía falta corregir.
                  </p>
                  {correctionProblem !== '' && <p role="alert" className="cash-problem">{correctionProblem}</p>}
                  <div className="cash-actions">
                    <button type="button" disabled={busy} onClick={() => setCorrecting(null)}>Cancelar</button>
                    <button type="submit" className="primary" disabled={busy}>Registrar corrección</button>
                  </div>
                </form>
                : <form className="cash-form" onSubmit={event => void submitMovement(event)}>
                  <div className="cash-kinds" role="group" aria-label="Tipo de movimiento">
                    {cashWrittenKinds.map(option => <button key={option} type="button"
                      aria-pressed={kind === option} disabled={busy}
                      onClick={() => {
                        // Only a gasto carries a receipt: choosing another kind lets the photo go (S2).
                        if (option !== 'gasto') removeEvidence();
                        setKind(option);
                      }}>{cashKindLabels[option]}</button>)}
                  </div>
                  <label htmlFor="cash-amount">Monto en bolivianos</label>
                  <input ref={amountInput} id="cash-amount" inputMode="decimal" value={amount}
                    disabled={busy} onChange={event => setAmount(event.target.value)} />
                  {kind === 'gasto'
                    ? catalogue.phase === 'error'
                      ? <p role="alert" className="cash-problem">
                        {catalogue.problem}
                        <button type="button"
                          onClick={() => setCatalogueAttempt(value => value + 1)}>
                          Reintentar motivos
                        </button>
                      </p>
                      : catalogue.phase === 'loading'
                        ? <p role="status" className="cash-note">Consultando los motivos…</p>
                        : catalogue.options.length === 0
                          ? <p role="alert" className="cash-problem">{cashMotiveCatalogueEmpty}</p>
                          : <>
                            {/* The motive of an expense is picked from the closed list: this screen offers no
                                path to type one by hand (S1). */}
                            {motiveNotice !== '' && <p role="alert" className="cash-problem">{motiveNotice}</p>}
                            <label htmlFor="cash-category">Motivo</label>
                            <select id="cash-category" value={category} disabled={busy}
                              onChange={event => {
                                const id = event.target.value;
                                setCategory(id);
                                setMotiveNotice('');
                                chosenMotive.current = {
                                  id, label: catalogue.options.find(option => String(option.id) === id)?.label ?? '',
                                };
                              }}>
                              <option value="">Elegí un motivo…</option>
                              {catalogue.options.map(option => <option key={option.id}
                                value={String(option.id)}>{option.label}</option>)}
                            </select>
                            <label htmlFor="cash-note">Nota (opcional)</label>
                            <textarea id="cash-note" value={note} disabled={busy}
                              onChange={event => setNote(event.target.value)} />
                            {/* The one optional photo of the ticket (S1): offered by an expense only, with
                                its preview and its size on the card, before anything is sent (S2, S7). */}
                            <label htmlFor="cash-evidence">Comprobante (opcional)</label>
                            <input ref={evidenceInput} id="cash-evidence" type="file" disabled={busy}
                              accept="image/jpeg,image/png"
                              onChange={event => {
                                const file = event.target.files?.[0] ?? null;
                                if (file !== null) void chooseEvidence(file);
                              }} />
                            <p className="cash-note">
                              Una sola foto por gasto: si elegís otra, reemplaza la que está. Sólo un
                              gasto lleva comprobante; es una foto JPEG o PNG de hasta 8 MB y
                              6000 × 6000 píxeles.
                            </p>
                            {evidence !== null && <div className="cash-evidence">
                              {evidence.preview !== null && <img className="cash-evidence-preview"
                                src={evidence.preview} alt="Vista previa del comprobante" />}
                              <p className="cash-evidence-name">{evidence.file.name}</p>
                              <p className="cash-evidence-size">
                                {closingEvidenceSizeText(evidence.file.size)}</p>
                              <button type="button" disabled={busy} onClick={removeEvidence}>
                                Quitar el comprobante
                              </button>
                            </div>}
                            {evidenceProblem !== '' && <p role="alert" className="cash-problem">
                              {evidenceProblem}
                            </p>}
                          </>
                    : <>
                      {/* Aporte y recaudación no cambian: siguen con su motivo de texto libre (S4). */}
                      <label htmlFor="cash-reason">Motivo</label>
                      <textarea id="cash-reason" value={reason} disabled={busy}
                        onChange={event => setReason(event.target.value)} />
                    </>}
                  <p className="cash-stamp">
                    La hora y el autor los pone el sistema, no se escriben.
                  </p>
                  {formProblem !== '' && <p role="alert" className="cash-problem">{formProblem}</p>}
                  <button type="submit" className="primary cash-submit"
                    disabled={busy || (kind === 'gasto' && (!gastoReady || checkingEvidence))}>
                    {`Registrar ${cashKindLabels[kind].toLowerCase()}`}
                  </button>
                </form>}
            {notice !== '' && <p role="status" className="cash-notice">{notice}</p>}
            {!frozen && <div className="cash-rule">
              <b>Si un movimiento salió mal</b>
              <ul>
                <li>No se edita ni se borra: se corrige con otro movimiento que lo referencia.</li>
                <li>El tope es el monto original, y una corrección no se corrige.</li>
                <li>Un movimiento que una rendición ya usó se resuelve en la rendición.</li>
              </ul>
            </div>}
          </div>
        </aside>
      </div>
    </>}

    <p className="cash-footnote">
      El fondo de compras se ve en Métricas y se repone en cada rendición. Es otra caja: las compras de
      chatarra y baterías usadas nunca salen de acá, y un gasto de tienda nunca descuenta del fondo.
    </p>
  </section>;
}
