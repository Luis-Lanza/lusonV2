import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Cash from './Cash';
import { cashErrorMessages, cashMaxEvidenceBytes } from './cashAPI';
import { notifyCatalogueInvalidation } from './useInventory';

// jsdom answers no image source of its own, so the preview is pinned on the URL the screen asks for: the
// browser is the one that turns the chosen file into something an <img> can show.
beforeEach(() => {
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:foto') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
});

/** The header of a PNG of the stated size, and enough of it for the screen to read it. */
function pngBytes(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

/** A JPEG of the stated size: the photo of a ticket, as the camera of a phone writes it. */
function jpegBytes(width: number, height: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00,
    0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff,
    0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xff, 0xd9,
  ]);
}

/** The one photo the screen may attach to an expense (S1). */
const photo = (bytes = jpegBytes(2, 2), name = 'factura.jpg') => new File([bytes], name,
  { type: 'image/jpeg' });

/** Picks one file with the picker of the card, as the operator does. */
function chooseFile(file: File) {
  fireEvent.change(screen.getByLabelText('Comprobante (opcional)'), { target: { files: [file] } });
}

const csrf = 'c'.repeat(43);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const minus = '\u2212';

// The closed settlement of the branch and the whole history: the two periods the metrics reader
// publishes with their instants, which is the only list of windows this contract offers (S8).
const closedPeriod = {
  kind: 'settlement', closing_id: 4, from: '2026-11-01T12:00:00Z', to: '2026-11-12T18:30:00Z',
  label: 'Rendición #4',
};
const allPeriod = { kind: 'all', closing_id: null, from: null, to: null, label: 'Todo el historial' };
const metricsAnswer = {
  periods: [closedPeriod, allPeriod], period: allPeriod, source: 'history',
  sales: { total: '0.00', cash: '0.00', card: '0.00', transfer: '0.00', qr: '0.00',
    commission: '0.00', sales: 0, units: 0 },
  cash: null, fund: null, materials: null, top_models: [], stock: { units: 0 },
  // A branch that sold nothing states the total and the battery base of its window, and no rate.
  today: { since: null, opening: '0.00', sales: '0.00', expenses: '0.00', effective: '0.00',
    expected: '0.00', rate: null, sold: '0.00', commission_base: '0.00', commission: '0.00',
    movements: [] },
  fund_today: { since: null, opening: '0.00', purchases: '0.00', effective: '0.00', balance: '0.00', documents: 0,
    used_units: 0, scrap_milli: 0 },
};

/** One row of the book: the positive amount the branch wrote, the signed effect it moved, and — on an
 * expense — the motive with the copy of the label it had when the row was written (S7, S8). */
const entry = (patch: Record<string, unknown> = {}) => {
  const row: Record<string, unknown> = {
    id: 21, kind: 'gasto', effect_kind: 'gasto', amount: '85.00', effective: '-85.00',
    description: 'Detergente y escobas', occurred_at: '2026-11-13T09:12:00Z',
    created_by_account_id: 2, corrects_id: null, category_id: 5, category_label: 'Limpieza',
    evidence: null, ...patch,
  };
  // A motive belongs to an expense alone: every other kind names none and states both keys as null (S4).
  if (row.kind !== 'gasto' && patch.category_id === undefined && patch.category_label === undefined) {
    row.category_id = null;
    row.category_label = null;
  }
  return row;
};

// The book of the screen: gasto, gasto, aporte, recaudación, un gasto corregido y su corrección.
// −85 −120 +500 −1200 −5000 +4500 = −1405.00, y 1850 + 6420 − 1405 = 6865.00.
const book = (patch: Record<string, unknown> = {}) => ({
  since: '2026-11-12T18:30:00Z', until: null, opening: '1850.00', sales: '6420.00',
  effective: '-1405.00', expected: '6865.00', truncated: false,
  movements: [
    entry(),
    entry({ id: 22, amount: '120.00', effective: '-120.00', description: 'Flete de baterías',
      occurred_at: '2026-11-13T15:40:00Z' }),
    entry({ id: 23, kind: 'aporte', effect_kind: 'aporte', amount: '500.00', effective: '500.00',
      description: 'Aporte del dueño', occurred_at: '2026-11-14T08:05:00Z' }),
    entry({ id: 24, kind: 'recaudacion', effect_kind: 'recaudacion', amount: '1200.00',
      effective: '-1200.00', description: 'Retiro del Almacén',
      occurred_at: '2026-11-14T17:22:00Z' }),
    entry({ id: 25, amount: '5000.00', effective: '-5000.00', description: 'Adelanto al proveedor',
      occurred_at: '2026-11-15T11:00:00Z' }),
    entry({ id: 26, kind: 'correccion', effect_kind: 'gasto', amount: '4500.00',
      effective: '4500.00', description: 'Devuelve el excedente',
      occurred_at: '2026-11-15T11:14:00Z', corrects_id: 25 }),
  ],
  ...patch,
});

// The closed list of motives the screen offers for an expense (S1, S2), in the order the API states.
const catalogueAnswer = {
  categories: [{ id: 1, label: 'Alquiler' }, { id: 2, label: 'Internet' },
    { id: 5, label: 'Limpieza' }, { id: 11, label: 'Otros gastos' }],
};

const recordedBody = (patch: Record<string, unknown> = {}) => ({
  id: 27, branch_location_id: 2, kind: 'gasto', amount: '85.00', description: 'Detergente y escobas',
  occurred_at: '2026-11-16T10:00:00Z', created_by_account_id: 2, ...patch,
});

/** The JSON object of one write, read from the plain body or from the `movement` part of an upload. */
async function sentBody(init: RequestInit): Promise<Record<string, unknown>> {
  if (init.body instanceof FormData) {
    return JSON.parse(await (init.body.get('movement') as Blob).text()) as Record<string, unknown>;
  }
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

/** The answer of a write repeats what was sent: the screen refuses a movement it did not write. */
async function echoWrite(init: RequestInit): Promise<Response> {
  const sent = await sentBody(init);
  return json(recordedBody({
    kind: sent.kind ?? 'correccion', amount: sent.amount, description: sent.description,
    ...(sent.corrects_id === undefined ? {} : { corrects_id: sent.corrects_id }),
  }), 201);
}

type Handlers = {
  metrics?: () => Response;
  ledger?: (url: string) => Response;
  categories?: () => Response;
  write?: (url: string, init: RequestInit) => Response | Promise<Response>;
};

function setup(handlers: Handlers = {}) {
  const metrics = handlers.metrics ?? (() => json(metricsAnswer));
  const ledger = handlers.ledger ?? (() => json(book()));
  const categories = handlers.categories ?? (() => json(catalogueAnswer));
  const write = handlers.write ?? ((_url, init) => echoWrite(init));
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith('/api/metrics?')) return metrics();
    if (url === '/api/closings/cash-categories') {
      // The list of motives is a read of the catalogue and never of the branch's money.
      expect(init.method ?? 'GET').toBe('GET');
      expect(init.body).toBeUndefined();
      return categories();
    }
    if (url.startsWith('/api/closings/cash-ledger')) {
      // Reading the book is a read: it never writes, whatever period is on screen.
      expect(init.method ?? 'GET').toBe('GET');
      expect(init.body).toBeUndefined();
      return ledger(url);
    }
    if (url === '/api/closings/cash-movements' || url === '/api/closings/cash-corrections') {
      expect(init.method).toBe('POST');
      return write(url, init);
    }
    throw new Error('Unexpected mocked URL: ' + url);
  });
  render(<Cash csrf={csrf} branch="Sucursal A" fetcher={fetch} />);
  const calls = () => fetch.mock.calls.map(([url]) => String(url));
  const posts = () => fetch.mock.calls.filter(([, init]) => init?.method === 'POST');
  const ledgerCalls = () => calls().filter(url => url.startsWith('/api/closings/cash-ledger'));
  const catalogueCalls = () => calls().filter(url => url === '/api/closings/cash-categories');
  return { fetch, calls, posts, ledgerCalls, catalogueCalls };
}

/** Picks one motive of the closed list the screen offers for an expense (S1). */
async function chooseMotive(label = 'Limpieza') {
  const option = catalogueAnswer.categories.find(category => category.label === label);
  if (option === undefined) throw new Error('The catalogue does not offer ' + label);
  const select = await screen.findByLabelText('Motivo');
  fireEvent.change(select, { target: { value: String(option.id) } });
  return select;
}

/** One cell of the band, addressed by the title the screen writes over its number. */
function bandCell(title: string) {
  const band = screen.getByRole('group', { name: 'Números del cajón' });
  return within(band).getByText(title).parentElement as HTMLElement;
}

const rowOf = (id: number) =>
  document.querySelector(`[data-movement-id="${id}"]`) as HTMLElement;

describe('el libro de la caja operativa', () => {
  it('states the four numbers of the band and the net the book produces', async () => {
    setup();
    await screen.findByText('Quedó al cerrar');
    const band = screen.getByRole('group', { name: 'Números del cajón' });
    expect(within(band).getAllByRole('term')).toHaveLength(4);
    expect(bandCell('Quedó al cerrar')).toHaveTextContent('Bs 1.850,00');
    expect(bandCell('Ventas en efectivo')).toHaveTextContent('Bs 6.420,00');
    expect(bandCell('Neto del libro')).toHaveTextContent(`${minus} Bs 1.405,00`);
    expect(bandCell('Esperado en el cajón')).toHaveTextContent('Bs 6.865,00');
    // Every movement of the window is listed with its kind written in words, never by colour alone.
    for (const [id, label] of [[21, 'Gasto'], [23, 'Aporte'], [24, 'Recaudación'], [26, 'Corrección']] as const) {
      expect(within(rowOf(id)).getByText(label)).toBeInTheDocument();
    }
  });

  it('reads a correction row as money coming back to the drawer', async () => {
    setup();
    await screen.findByText('Quedó al cerrar');
    const correction = rowOf(26);
    expect(within(correction).getByText('Corrección')).toBeInTheDocument();
    expect(within(correction).getByText(`+ Bs 4.500,00`)).toBeInTheDocument();
    // The row names the movement it answers, so the pair is legible as one correction.
    expect(within(correction).getByText(/Corrige el movimiento #25/)).toBeInTheDocument();
    // A gasto leaves the drawer and says so with its sign.
    expect(within(rowOf(21)).getByText(`${minus} Bs 85,00`)).toBeInTheDocument();
    // The per-row action is disabled on a correction, with its reason written beside it.
    const correctionAction = within(correction).getByRole('button', { name: /Corregir el movimiento #26/ });
    expect(correctionAction).toBeDisabled();
    expect(within(correction).getByText('Las correcciones no se corrigen.')).toBeInTheDocument();
  });

  it('refuses a zero amount before it asks the server for anything', async () => {
    const { posts } = setup();
    await screen.findByText('Quedó al cerrar');
    fireEvent.change(screen.getByLabelText('Monto en bolivianos'), { target: { value: '0,00' } });
    await chooseMotive('Limpieza');
    fireEvent.click(screen.getByRole('button', { name: 'Registrar gasto' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Escribí un monto mayor a cero');
    expect(posts()).toHaveLength(0);
  });

  it('refuses a gasto with no motive before any request leaves the screen (S3)', async () => {
    const { posts } = setup();
    await screen.findByText('Quedó al cerrar');
    // The selector is there and nothing of it was picked: the amount is complete and the motive is not.
    const select = await screen.findByLabelText('Motivo');
    expect(select).toHaveValue('');
    fireEvent.change(screen.getByLabelText('Monto en bolivianos'), { target: { value: '85,00' } });
    fireEvent.change(screen.getByLabelText('Nota (opcional)'), { target: { value: 'Detergente' } });
    fireEvent.click(screen.getByRole('button', { name: 'Registrar gasto' }));
    expect(await screen.findByRole('alert'))
      .toHaveTextContent('Elegí un motivo de la lista: un gasto sin motivo no se registra.');
    // The form is still the operator's: the amount and the note were not thrown away.
    expect(screen.getByLabelText('Monto en bolivianos')).toHaveValue('85,00');
    expect(screen.getByLabelText('Nota (opcional)')).toHaveValue('Detergente');
    expect(posts()).toHaveLength(0);
  });

  it('registers a movement with the kind on the control and the amount as canonical text', async () => {
    const ledger = vi.fn(() => json(book()));
    const { posts } = setup({ ledger });
    await screen.findByText('Quedó al cerrar');
    fireEvent.click(screen.getByRole('button', { name: 'Aporte' }));
    expect(screen.getByRole('button', { name: 'Aporte' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.change(screen.getByLabelText('Monto en bolivianos'), { target: { value: '500,50' } });
    fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: '  Cambio para el cajón  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Registrar aporte' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    const written = posts()[0]?.[1];
    expect(JSON.parse(String(written?.body))).toEqual({
      kind: 'aporte', amount: '500.50', description: 'Cambio para el cajón',
    });
    // The book is read again after the movement is written.
    await waitFor(() => expect(ledger.mock.calls.length).toBeGreaterThan(1));
  });

  it('offers the motives of the closed list as the selector of an expense, and no free text (S1)', async () => {
    const { catalogueCalls, ledgerCalls } = setup();
    await screen.findByText('Quedó al cerrar');
    const select = await screen.findByLabelText('Motivo');
    expect(select.tagName).toBe('SELECT');
    expect(within(select).getAllByRole('option').map(option => option.textContent)).toEqual(
      ['Elegí un motivo…', 'Alquiler', 'Internet', 'Limpieza', 'Otros gastos']);
    // There is no path on this screen to type the motive of an expense by hand.
    expect(screen.queryByRole('textbox', { name: 'Motivo' })).not.toBeInTheDocument();
    // The note beside the motive is the only free text of an expense, and it says it is optional (S3).
    expect(screen.getByLabelText('Nota (opcional)').tagName).toBe('TEXTAREA');
    // The list is a read of its own, made once when the screen loads.
    expect(catalogueCalls()).toHaveLength(1);
    expect(ledgerCalls().length).toBeGreaterThan(0);
  });

  it('keeps the hand-typed motive of an aporte and of a recaudación (S4)', async () => {
    setup();
    await screen.findByText('Quedó al cerrar');
    await screen.findByLabelText('Motivo');
    for (const label of ['Aporte', 'Recaudación'] as const) {
      fireEvent.click(screen.getByRole('button', { name: label }));
      expect(screen.getByLabelText('Motivo').tagName).toBe('TEXTAREA');
      // A kind that names no motive offers no list of motives and no note beside one.
      expect(screen.queryByRole('combobox', { name: 'Motivo' })).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Nota (opcional)')).not.toBeInTheDocument();
    }
    // Going back to a gasto offers the closed list again.
    fireEvent.click(screen.getByRole('button', { name: 'Gasto' }));
    expect(screen.getByLabelText('Motivo').tagName).toBe('SELECT');
  });

  it('sends the chosen motive and the note of a gasto, and sends an empty note as an empty note (S3)', async () => {
    const writes: string[] = [];
    const { posts, ledgerCalls } = setup({
      write: (_url, init) => { writes.push(String(init.body)); return echoWrite(init); },
    });
    await screen.findByText('Quedó al cerrar');
    fireEvent.change(screen.getByLabelText('Monto en bolivianos'), { target: { value: '85,00' } });
    await chooseMotive('Limpieza');
    fireEvent.change(screen.getByLabelText('Nota (opcional)'), { target: { value: '  Detergente  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Registrar gasto' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    // The body of an expense states its motive and its note, in the text the contract stores.
    expect(writes[0])
      .toBe('{"kind":"gasto","amount":"85.00","category_id":5,"description":"Detergente"}');
    expect(await screen.findByText('Gasto registrado en el libro de la caja.')).toBeInTheDocument();
    await waitFor(() => expect(ledgerCalls().length).toBeGreaterThan(1));
    // A gasto whose note says nothing is legitimate: its motive already states what the money paid for.
    fireEvent.change(screen.getByLabelText('Monto en bolivianos'), { target: { value: '100,00' } });
    await chooseMotive('Alquiler');
    fireEvent.click(screen.getByRole('button', { name: 'Registrar gasto' }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(writes[1])
      .toBe('{"kind":"gasto","amount":"100.00","category_id":1,"description":""}');
    // The answer of a gasto with no note is admitted whole: the write is not refused by its own echo.
    expect(await screen.findByText(/Gasto registrado en el libro de la caja/)).toBeInTheDocument();
    expect(screen.queryByText(cashErrorMessages.invalid_response)).not.toBeInTheDocument();
  });

  it('shows the motive of an expense and its note, and keeps the historical free-text motive (S7)', async () => {
    setup({ ledger: () => json(book({
      effective: '195.00', expected: '8465.00',
      movements: [
        entry({ id: 31 }),
        entry({ id: 32, amount: '100.00', effective: '-100.00', category_id: 1,
          category_label: 'Alquiler', description: '', occurred_at: '2026-11-13T15:40:00Z' }),
        // A row recorded before the closed list existed: it keeps its free-text motive (S7).
        entry({ id: 33, amount: '120.00', effective: '-120.00', category_id: null,
          category_label: null, description: 'Flete viejo de baterías',
          occurred_at: '2026-11-14T08:05:00Z' }),
        entry({ id: 34, kind: 'aporte', effect_kind: 'aporte', amount: '500.00', effective: '500.00',
          description: 'Aporte del dueño', occurred_at: '2026-11-14T09:05:00Z' }),
      ],
    })) });
    await screen.findByText('Quedó al cerrar');
    // The motive of the row is the label of the closed list, and the note is still visible beside it.
    const withNote = rowOf(31);
    expect(within(withNote).getByText('Limpieza')).toBeInTheDocument();
    expect(within(withNote).getByText('Detergente y escobas')).toBeInTheDocument();
    // A motive with no note renders the motive alone: no empty artefact and no null.
    const noNote = rowOf(32);
    expect(within(noNote).getByText('Alquiler')).toBeInTheDocument();
    expect(noNote.querySelector('.cash-motive-note')).toBeNull();
    expect(noNote.textContent).not.toContain('null');
    // A historical row still reads its own free-text motive, visibly, and names no motive in the new sense.
    const historical = rowOf(33);
    expect(within(historical).getByText('Flete viejo de baterías')).toBeInTheDocument();
    expect(historical.querySelector('.cash-motive-label')).toBeNull();
    // An aporte keeps the text it was written with and is not mistaken for a motive of the list.
    expect(within(rowOf(34)).getByText('Aporte del dueño')).toBeInTheDocument();
  });

  it('says the list of motives could not be read and still records an aporte (S1, S4)', async () => {
    const { posts, catalogueCalls } = setup({
      categories: () => json({ error: 'service_unavailable' }, 503),
    });
    await screen.findByText('Quedó al cerrar');
    const problem = await screen.findByRole('alert');
    expect(problem).toHaveTextContent('No se pudo leer la lista de motivos');
    // The screen never offers an empty selector in place of the list.
    expect(screen.queryByLabelText('Motivo')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Nota (opcional)')).not.toBeInTheDocument();
    // Its own failure state has its own way out: asking again reads the list once more.
    fireEvent.click(within(problem).getByRole('button', { name: 'Reintentar motivos' }));
    await waitFor(() => expect(catalogueCalls()).toHaveLength(2));
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo leer la lista de motivos');
    // A gasto cannot be registered at all, and nothing leaves the screen when it is attempted.
    fireEvent.change(screen.getByLabelText('Monto en bolivianos'), { target: { value: '85,00' } });
    const submit = screen.getByRole('button', { name: 'Registrar gasto' });
    expect(submit).toBeDisabled();
    fireEvent.click(submit);
    const form = document.querySelector('form.cash-form') as HTMLFormElement;
    const attempt = new Event('submit', { bubbles: true, cancelable: true });
    form.dispatchEvent(attempt);
    expect(attempt.defaultPrevented).toBe(true);
    await waitFor(() => expect(posts()).toHaveLength(0));
    // An aporte names no motive of the list, so it keeps working exactly as before.
    fireEvent.click(screen.getByRole('button', { name: 'Aporte' }));
    fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: 'Cambio para el cajón' } });
    fireEvent.click(screen.getByRole('button', { name: 'Registrar aporte' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(String(posts()[0]?.[1]?.body))).toEqual({
      kind: 'aporte', amount: '85.00', description: 'Cambio para el cajón',
    });
  });

  it('says an empty catalogue out loud instead of offering an empty selector (S1)', async () => {
    const { posts } = setup({ categories: () => json({ categories: [] }) });
    await screen.findByText('Quedó al cerrar');
    expect(await screen.findByRole('alert')).toHaveTextContent('La lista de motivos está vacía');
    expect(screen.queryByRole('combobox', { name: 'Motivo' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Registrar gasto' })).toBeDisabled();
    expect(posts()).toHaveLength(0);
  });

  it('replaces the form with the frozen banner the server refused with', async () => {
    const { posts } = setup({
      write: () => json({ error: 'branch_frozen' }, 409),
    });
    await screen.findByText('Quedó al cerrar');
    fireEvent.change(screen.getByLabelText('Monto en bolivianos'), { target: { value: '85,00' } });
    await chooseMotive('Limpieza');
    fireEvent.click(screen.getByRole('button', { name: 'Registrar gasto' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'La sucursal está congelada por una rendición en curso.');
    expect(screen.getByRole('alert')).toHaveTextContent('Cuando la rendición se cierre');
    // While the branch is frozen the card is gone: there is nothing to fill in.
    expect(screen.queryByRole('button', { name: 'Registrar gasto' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Monto en bolivianos')).not.toBeInTheDocument();
  });

  it('cancels the submit of the movement form instead of letting the browser navigate', async () => {
    const { posts } = setup();
    await screen.findByText('Quedó al cerrar');
    const form = document.querySelector('form.cash-form') as HTMLFormElement;
    expect(form).not.toBeNull();
    // A real submit would reload the page and lose the draft the operator typed; the handler states that
    // it answered the event, so the form is cancelled before anything is written.
    const submit = new Event('submit', { bubbles: true, cancelable: true });
    form.dispatchEvent(submit);
    expect(submit.defaultPrevented).toBe(true);
    // The handler ran (the amount it cannot read is refused on the screen) and the server was asked nothing.
    expect(await screen.findByRole('alert'))
      .toHaveTextContent('Escribí un monto válido, con hasta dos decimales.');
    expect(posts()).toHaveLength(0);
  });

  it('states both quantities when the till does not hold the movement', async () => {
    setup({
      write: () => json({ error: 'drawer_insufficient', balance: '50.00', requested: '85.00' }, 409),
    });
    await screen.findByText('Quedó al cerrar');
    fireEvent.change(screen.getByLabelText('Monto en bolivianos'), { target: { value: '85,00' } });
    await chooseMotive('Limpieza');
    fireEvent.click(screen.getByRole('button', { name: 'Registrar gasto' }));
    // The refusal is the till's own (S1, S4): the screen names the gap instead of a generic conflict,
    // and it is definite, so the form stays as the operator left it to state a smaller amount.
    expect(await screen.findByRole('alert')).toHaveTextContent('La caja no tiene ese dinero');
    expect(screen.getByRole('alert')).toHaveTextContent('El cajón tiene Bs');
    expect(screen.getByRole('alert')).toHaveTextContent('el movimiento pide Bs 85,00');
    expect(screen.getByLabelText('Monto en bolivianos')).toHaveValue('85,00');
  });

  it('states the till the screen read, never the numbers of the envelope', async () => {
    setup({ write: () => json({ error: 'drawer_insufficient', balance: '-50.00', requested: '-85.00' }, 409) });
    await screen.findByText('Quedó al cerrar');
    fireEvent.change(screen.getByLabelText('Monto en bolivianos'), { target: { value: '85,00' } });
    await chooseMotive('Limpieza');
    fireEvent.click(screen.getByRole('button', { name: 'Registrar gasto' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('el movimiento pide');
    expect(alert).toHaveTextContent('85,00');
    expect(alert).not.toHaveTextContent('-85');
    // The drawer the screen states is its own read (6865.00), never the --50.00 the envelope carried.
    expect(alert).toHaveTextContent('El cajón tiene Bs 6.865,00');
    expect(alert).not.toHaveTextContent('50,00');
    expect(alert).not.toHaveTextContent('\u221250');
  });

  it('states an empty book with the first action of the screen', async () => {
    setup({ ledger: () => json(book({ movements: [], effective: '0.00', expected: '8270.00' })) });
    expect(await screen.findByText('Todavía no hay movimientos desde el corte')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Registrar el primer movimiento' })).toBeInTheDocument();
  });

  it('shows the error with a retry that asks the server again', async () => {
    let attempts = 0;
    const { ledgerCalls } = setup({
      ledger: () => {
        attempts += 1;
        return attempts === 1
          ? json({ error: 'service_unavailable' }, 503)
          : json(book());
      },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('El servicio no está disponible');
    expect(screen.queryByRole('group', { name: 'Números del cajón' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    await screen.findByText('Quedó al cerrar');
    expect(ledgerCalls().length).toBe(2);
    expect(ledgerCalls()[0]).toBe('/api/closings/cash-ledger');
  });

  it('says the list is the newest 500 while the numbers cover the whole period', async () => {
    const rows = Array.from({ length: 500 }, (_, index) => entry({
      id: index + 1, amount: '1.00', effective: '-1.00', description: `Gasto ${index + 1}`,
      occurred_at: `2026-11-13T${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}:00Z`,
    }));
    setup({ ledger: () => json(book({
      movements: rows, effective: '-500.00', opening: '0.00', sales: '0.00', expected: '-500.00',
      truncated: true,
    })) });
    await screen.findByText('Quedó al cerrar');
    expect(await screen.findByText(/los 500 movimientos más nuevos/)).toHaveTextContent(
      'Este período tiene más movimientos de los que se listan acá: la lista son los 500 movimientos más nuevos y los cuatro números de arriba cuentan el período completo.');
  });

  it('opens the correction of one movement with the amount it still has to answer and Esc closes it', async () => {
    const corrections: string[] = [];
    setup({
      write: (_url, init) => {
        corrections.push(String(init.body));
        return echoWrite(init);
      },
    });
    await screen.findByText('Quedó al cerrar');
    fireEvent.click(screen.getByRole('button', { name: 'Corregir el movimiento #25' }));
    const panel = await screen.findByRole('group', { name: 'Corrección del movimiento #25' });
    expect(panel).toHaveTextContent('Quedan Bs 500,00 de Bs 5.000,00 por corregir.');
    expect(screen.queryByRole('button', { name: 'Registrar gasto' })).not.toBeInTheDocument();
    fireEvent.change(within(panel).getByLabelText('Monto de la corrección'), { target: { value: '500,00' } });
    fireEvent.change(within(panel).getByLabelText('Motivo de la corrección'),
      { target: { value: 'Devuelve el resto del adelanto' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Registrar corrección' }));
    await waitFor(() => expect(corrections).toHaveLength(1));
    expect(JSON.parse(corrections[0])).toEqual({
      corrects_id: 25, amount: '500.00', description: 'Devuelve el resto del adelanto',
    });
    // A correction leaves the panel closed: Esc is the other way out, and it never writes.
    await waitFor(() => expect(screen.queryByRole('group', { name: /Corrección del movimiento/ }))
      .not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Corregir el movimiento #21' }));
    await screen.findByRole('group', { name: 'Corrección del movimiento #21' });
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('group', { name: /Corrección del movimiento/ }))
      .not.toBeInTheDocument());
    expect(corrections).toHaveLength(1);
  });

  it('reads a closed period with its own window when the selector changes', async () => {
    const { ledgerCalls } = setup({
      ledger: url => url.includes('from=')
        // The closed window: one gasto of its own period, and a row the backend would refuse to correct
        // because that period was already signed (S7).
        ? json(book({ since: '2026-11-01T12:00:00Z', until: '2026-11-12T18:30:00Z',
          opening: '0.00', effective: '-85.00', expected: '6335.00',
          movements: [entry({ id: 11, occurred_at: '2026-11-02T09:00:00Z' })] }))
        : json(book()),
    });
    await screen.findByText('Quedó al cerrar');
    // The live window still states the expectation as the promise it is: what the next rendición will ask.
    expect(screen.getByText('lo que la rendición va a pedir')).toBeInTheDocument();
    const select = screen.getByLabelText('Período') as HTMLSelectElement;
    await waitFor(() => expect(within(select).getAllByRole('option')).toHaveLength(2));
    fireEvent.change(select, { target: { value: '4' } });
    await waitFor(() => expect(ledgerCalls()).toContain(
      '/api/closings/cash-ledger?from=2026-11-01T12%3A00%3A00Z&to=2026-11-12T18%3A30%3A00Z'));
    // The book of the closed window names its own period, and its rows are answered in the rendición.
    const closedRow = await waitFor(() => {
      const row = rowOf(11);
      expect(row).not.toBeNull();
      return row;
    });
    expect(within(closedRow).getByRole('button', { name: 'Corregir el movimiento #11' }))
      .toBeDisabled();
    expect(within(closedRow).getByText('Los movimientos de un período cerrado se resuelven en la rendición.'))
      .toBeInTheDocument();
    // A settled window states what that settlement already asked for: the same number read as the fact
    // it is, never as a promise about a period that is closed.
    expect(screen.getByText('lo que esa rendición pidió')).toBeInTheDocument();
    expect(screen.queryByText('lo que la rendición va a pedir')).not.toBeInTheDocument();
  });

  it('names the purchase fund as the other box of the branch', async () => {
    setup();
    await screen.findByText('Quedó al cerrar');
    expect(screen.getByText(/El fondo de compras/)).toHaveTextContent(
      'El fondo de compras se ve en Métricas y se repone en cada rendición. Es otra caja: las compras de chatarra y baterías usadas nunca salen de acá, y un gasto de tienda nunca descuenta del fondo.');
  });
});

// The receipt of a pay-out: one optional photo of the ticket (S1), offered only by a gasto (S2), judged
// on the screen before anything leaves it, and published in the book as metadata alone (S7).
describe('el comprobante del gasto (S1, S2, S7)', () => {
  /** Fills the amount and the motive of an expense, so a submit has something to write. */
  async function fillGasto(amount = '85,00', motive = 'Limpieza') {
    fireEvent.change(screen.getByLabelText('Monto en bolivianos'), { target: { value: amount } });
    await chooseMotive(motive);
  }

  it('offers the photo of an expense and no way to attach one to anything else (S1, S2)', async () => {
    setup();
    await screen.findByText('Quedó al cerrar');
    const picker = await screen.findByLabelText('Comprobante (opcional)');
    // The picker is a file input that offers the two formats the server decodes, and it says the photo
    // is optional and single.
    expect(picker).toHaveAttribute('type', 'file');
    expect(picker).toHaveAttribute('accept', 'image/jpeg,image/png');
    // The copy of the picker states the two limits of the contract, which are the server's own (S6).
    const hint = screen.getByText(/Una sola foto por gasto/);
    expect(hint).toHaveTextContent('8 MB');
    expect(hint).toHaveTextContent('6000 × 6000');
    expect(hint).not.toHaveTextContent('10000');
    expect(screen.getByText(/Una sola foto por gasto/)).toBeInTheDocument();
    expect(screen.getByText(/sólo un gasto lleva comprobante/i)).toBeInTheDocument();
    // A contribution and a collection have no picker at all, not a disabled one.
    for (const label of ['Aporte', 'Recaudación'] as const) {
      fireEvent.click(screen.getByRole('button', { name: label }));
      expect(screen.queryByLabelText('Comprobante (opcional)')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Quitar el comprobante' })).not.toBeInTheDocument();
    }
    // Going back to an expense offers the picker again, empty: nothing of the other kind was kept.
    fireEvent.click(screen.getByRole('button', { name: 'Gasto' }));
    expect(await screen.findByLabelText('Comprobante (opcional)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Corregir el movimiento #21' }));
    const panel = await screen.findByRole('group', { name: 'Corrección del movimiento #21' });
    // A correction answers a movement and offers no file either (S2).
    expect(within(panel).queryByLabelText('Comprobante (opcional)')).not.toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Quitar el comprobante' })).not.toBeInTheDocument();
  });

  it('shows the chosen photo with its size, replaces it with a second one and lets it go (S1)', async () => {
    setup();
    await screen.findByText('Quedó al cerrar');
    await screen.findByLabelText('Motivo');
    const file = photo();
    chooseFile(file);
    // The photo is shown before it is sent, with the size it has and the way to take it back.
    const preview = await screen.findByAltText('Vista previa del comprobante');
    expect(preview).toHaveAttribute('src', 'blob:foto');
    expect(screen.getByText('factura.jpg')).toBeInTheDocument();
    expect(screen.getByText('41 B')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Quitar el comprobante' })).toBeInTheDocument();
    // A second photo replaces the first: the card never holds two (S1).
    chooseFile(new File([pngBytes(1, 1)], 'ticket.png', { type: 'image/png' }));
    await waitFor(() => expect(screen.getByText('ticket.png')).toBeInTheDocument());
    expect(screen.queryByText('factura.jpg')).not.toBeInTheDocument();
    expect(screen.getAllByAltText('Vista previa del comprobante')).toHaveLength(1);
    expect(screen.getByText('33 B')).toBeInTheDocument();
    // Removing it leaves the card as it was before the choice: no photo and no size.
    fireEvent.click(screen.getByRole('button', { name: 'Quitar el comprobante' }));
    await waitFor(() =>
      expect(screen.queryByAltText('Vista previa del comprobante')).not.toBeInTheDocument());
    expect(screen.queryByText('ticket.png')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Quitar el comprobante' })).not.toBeInTheDocument();
  });

  it('admits the photo of exactly the pixel cap and refuses one pixel more (S6)', async () => {
    const { posts } = setup();
    await screen.findByText('Quedó al cerrar');
    // Exactly 6000 pixels a side is a receipt the screen offers with its preview, before sending it.
    chooseFile(photo(pngBytes(6_000, 6_000), 'limite.png'));
    await screen.findByAltText('Vista previa del comprobante');
    expect(screen.getByText('limite.png')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // One pixel more is the refusal of the contract, in the operator's words and before any request.
    chooseFile(photo(pngBytes(6_001, 6_001), 'pasado.png'));
    const problem = await screen.findByRole('alert');
    expect(problem).toHaveTextContent(cashErrorMessages.evidence_dimensions);
    expect(problem).not.toHaveTextContent('evidence_dimensions');
    expect(problem).toHaveTextContent('6000');
    expect(problem).not.toHaveTextContent('10000');
    expect(screen.queryByAltText('Vista previa del comprobante')).not.toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });

  it.each([
    ['evidence_empty', () => photo(new Uint8Array(0), 'vacio.jpg')],
    ['evidence_too_large', () => photo(new Uint8Array(cashMaxEvidenceBytes + 1), 'pesada.jpg')],
    ['evidence_unsupported', () =>
      new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], 'comprobante.svg',
        { type: 'image/svg+xml' })],
    ['evidence_dimensions', () => photo(pngBytes(6_001, 6_001), 'enorme.png')],
  ] as const)('refuses %s on the screen, before any request leaves it (S1, S6)', async (code, make) => {
    const { posts } = setup();
    await screen.findByText('Quedó al cerrar');
    chooseFile(make());
    // The refusal is written in the operator's words, never as the code the contract names it with.
    const problem = await screen.findByRole('alert');
    expect(problem).toHaveTextContent(cashErrorMessages[code]);
    expect(problem).not.toHaveTextContent(code);
    expect(screen.queryByAltText('Vista previa del comprobante')).not.toBeInTheDocument();
    // The movement is complete and the photo is not: nothing is sent at all.
    await fillGasto();
    fireEvent.click(screen.getByRole('button', { name: 'Registrar gasto' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(cashErrorMessages[code]));
    expect(posts()).toHaveLength(0);
  });

  it('sends the photo as multipart and the same expense as plain JSON when there is none (S1, S9)', async () => {
    const writes: RequestInit[] = [];
    const { posts, ledgerCalls } = setup({
      write: (_url, init) => { writes.push(init); return echoWrite(init); },
    });
    await screen.findByText('Quedó al cerrar');
    await screen.findByLabelText('Motivo');
    chooseFile(photo());
    await screen.findByAltText('Vista previa del comprobante');
    await fillGasto();
    fireEvent.click(screen.getByRole('button', { name: 'Registrar gasto' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    const upload = writes[0];
    // The body is the two-part form of the contract, and the browser states its own boundary.
    expect(upload.body).toBeInstanceOf(FormData);
    expect(new Headers(upload.headers).get('Content-Type')).toBeNull();
    const form = upload.body as FormData;
    expect([...form.keys()]).toEqual(['movement', 'evidence']);
    expect(form.getAll('evidence')).toHaveLength(1);
    // The `movement` part is exactly the JSON the plain route receives, byte for byte.
    expect(await (form.get('movement') as Blob).text())
      .toBe('{"kind":"gasto","amount":"85.00","category_id":5,"description":""}');
    const part = form.get('evidence') as File;
    expect(part.name).toBe('factura.jpg');
    expect([...new Uint8Array(await part.arrayBuffer())]).toEqual([...jpegBytes(2, 2)]);
    expect(await screen.findByText('Gasto registrado en el libro de la caja.')).toBeInTheDocument();
    // The book is read again: the receipt is published by the book, not by the answer of the write.
    await waitFor(() => expect(ledgerCalls().length).toBeGreaterThan(1));
    // The card is ready for the next movement: the photo was sent and the field is empty again.
    expect(screen.queryByAltText('Vista previa del comprobante')).not.toBeInTheDocument();
    // A gasto with no photo is the JSON body this route always took (S9).
    await fillGasto('100,00', 'Alquiler');
    fireEvent.click(screen.getByRole('button', { name: 'Registrar gasto' }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(writes[1].body).toBe('{"kind":"gasto","amount":"100.00","category_id":1,"description":""}');
    expect(new Headers(writes[1].headers).get('Content-Type')).toBe('application/json');
  });

  it('reads the refusal of the server in the same words the screen refuses with (S1)', async () => {
    const { posts } = setup({
      write: () => json({ error: 'evidence_dimensions' }, 400),
    });
    await screen.findByText('Quedó al cerrar');
    await screen.findByLabelText('Motivo');
    chooseFile(photo());
    await screen.findByAltText('Vista previa del comprobante');
    await fillGasto();
    fireEvent.click(screen.getByRole('button', { name: 'Registrar gasto' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    // The server's code is read as the same sentence the screen writes, never as the code itself.
    const problem = await screen.findByRole('alert');
    expect(problem).toHaveTextContent(cashErrorMessages.evidence_dimensions);
    expect(problem).not.toHaveTextContent('evidence_dimensions');
    // The chosen photo is not thrown away: the operator can take it back and send the expense without it.
    expect(screen.getByAltText('Vista previa del comprobante')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Quitar el comprobante' })).toBeInTheDocument();
  });

  it('offers the photo only on the rows that carry one (S7)', async () => {
    setup({ ledger: () => json(book({
      effective: '-95.00', expected: '8175.00',
      movements: [
        entry({ id: 41, evidence: { type: 'image/jpeg', size: 482_913, sha256: 'a'.repeat(64) } }),
        entry({ id: 42, amount: '10.00', effective: '-10.00', category_id: null,
          category_label: null, description: 'Flete del flete',
          occurred_at: '2026-11-13T10:00:00Z' }),
      ],
    })) });
    await screen.findByText('Quedó al cerrar');
    // The row with a receipt opens the image itself, same-origin with the session of the screen.
    const withPhoto = rowOf(41);
    const open = within(withPhoto).getByRole('link', {
      name: 'Ver el comprobante del movimiento #41',
    });
    expect(open).toHaveAttribute('href', '/api/closings/cash-movements/41/evidence');
    expect(open).toHaveAttribute('target', '_blank');
    expect(open).toHaveTextContent('Ver comprobante');
    // The badge states what the row publishes — never the bytes, which travel nowhere (S7).
    expect(open).toHaveAttribute('title', 'Comprobante JPEG · 472 KB');
    expect(withPhoto.textContent).not.toContain('sha256');
    // A row without a receipt shows nothing extra at all.
    const withoutPhoto = rowOf(42);
    expect(within(withoutPhoto).queryByRole('link')).not.toBeInTheDocument();
    expect(withoutPhoto.textContent).not.toContain('comprobante');
  });
});

describe('los motivos del catálogo en vivo', () => {
  it('re-reads the list on a catalogue invalidation and keeps the motive already chosen', async () => {
    const { catalogueCalls } = setup();
    await chooseMotive('Limpieza');
    await waitFor(() => expect(catalogueCalls()).toHaveLength(1));
    act(() => notifyCatalogueInvalidation());
    await waitFor(() => expect(catalogueCalls()).toHaveLength(2));
    // The re-read never blanks the form: the choice stands while the list it came from still offers it.
    expect((screen.getByLabelText('Motivo') as HTMLSelectElement).value).toBe('5');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('announces the motive archived while it was chosen and asks for another', async () => {
    let reads = 0;
    setup({
      categories: () => json(reads++ === 0
        ? catalogueAnswer
        : { categories: catalogueAnswer.categories.filter(category => category.label !== 'Limpieza') }),
    });
    await chooseMotive('Limpieza');
    act(() => notifyCatalogueInvalidation());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('«Limpieza»');
    expect(alert.textContent).toContain('Elegí otro de la lista');
    expect((screen.getByLabelText('Motivo') as HTMLSelectElement).value).toBe('');
  });
  it('says nothing about a motive archived after the expense that used it was recorded', async () => {
    let reads = 0;
    setup({
      categories: () => json(reads++ === 0
        ? catalogueAnswer
        : { categories: catalogueAnswer.categories.filter(category => category.label !== 'Limpieza') }),
    });
    await screen.findByText('Quedó al cerrar');
    fireEvent.change(screen.getByLabelText('Monto en bolivianos'), { target: { value: '85,00' } });
    await chooseMotive('Limpieza');
    fireEvent.change(screen.getByLabelText('Nota (opcional)'), { target: { value: 'Detergente' } });
    fireEvent.click(screen.getByRole('button', { name: 'Registrar gasto' }));
    // The write clears the form, so no motive is chosen any more when the list comes back without it.
    await waitFor(() => expect(screen.getByLabelText('Motivo')).toHaveValue(''));
    act(() => notifyCatalogueInvalidation());
    await waitFor(() => expect(reads).toBeGreaterThan(1));
    // Announcing a choice that disappeared would be a lie: the operator had already recorded the expense.
    expect(screen.queryByText(/ya no está disponible/)).not.toBeInTheDocument();
  });
});
