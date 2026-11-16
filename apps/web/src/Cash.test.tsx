import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Cash from './Cash';

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
  today: { since: null, opening: '0.00', sales: '0.00', expenses: '0.00', effective: '0.00',
    expected: '0.00', rate: null, sold: '0.00', commission: '0.00', movements: [] },
  fund_today: { since: null, opening: '0.00', purchases: '0.00', balance: '0.00', documents: 0,
    used_units: 0, scrap_milli: 0 },
};

/** One row of the book: the positive amount the branch wrote and the signed effect it moved. */
const entry = (patch: Record<string, unknown> = {}) => ({
  id: 21, kind: 'gasto', effect_kind: 'gasto', amount: '85.00', effective: '-85.00',
  description: 'Detergente y escobas', occurred_at: '2026-11-13T09:12:00Z',
  created_by_account_id: 2, corrects_id: null, ...patch,
});

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

const recordedBody = (patch: Record<string, unknown> = {}) => ({
  id: 27, branch_location_id: 2, kind: 'gasto', amount: '85.00', description: 'Detergente y escobas',
  occurred_at: '2026-11-16T10:00:00Z', created_by_account_id: 2, ...patch,
});

/** The answer of a write repeats what was sent: the screen refuses a movement it did not write. */
function echoWrite(init: RequestInit): Response {
  const sent = JSON.parse(String(init.body)) as Record<string, unknown>;
  return json(recordedBody({
    kind: sent.kind ?? 'correccion', amount: sent.amount, description: sent.description,
    ...(sent.corrects_id === undefined ? {} : { corrects_id: sent.corrects_id }),
  }), 201);
}

type Handlers = {
  metrics?: () => Response;
  ledger?: (url: string) => Response;
  write?: (url: string, init: RequestInit) => Response;
};

function setup(handlers: Handlers = {}) {
  const metrics = handlers.metrics ?? (() => json(metricsAnswer));
  const ledger = handlers.ledger ?? (() => json(book()));
  const write = handlers.write ?? ((_url, init) => echoWrite(init));
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith('/api/metrics?')) return metrics();
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
  return { fetch, calls, posts, ledgerCalls };
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
    fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: 'Detergente' } });
    fireEvent.click(screen.getByRole('button', { name: 'Registrar gasto' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Escribí un monto mayor a cero');
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

  it('replaces the form with the frozen banner the server refused with', async () => {
    const { posts } = setup({
      write: () => json({ error: 'branch_frozen' }, 409),
    });
    await screen.findByText('Quedó al cerrar');
    fireEvent.change(screen.getByLabelText('Monto en bolivianos'), { target: { value: '85,00' } });
    fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: 'Detergente' } });
    fireEvent.click(screen.getByRole('button', { name: 'Registrar gasto' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'La sucursal está congelada por una rendición en curso.');
    expect(screen.getByRole('alert')).toHaveTextContent('Cuando la rendición se cierre');
    // While the branch is frozen the card is gone: there is nothing to fill in.
    expect(screen.queryByRole('button', { name: 'Registrar gasto' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Monto en bolivianos')).not.toBeInTheDocument();
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
