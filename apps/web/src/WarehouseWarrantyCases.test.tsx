import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import WarehouseWarrantyCases from './WarehouseWarrantyCases';
import { notifyWarrantyInvalidation } from './useInventory';

const csrf = 'c'.repeat(43);
const locations = [{ id: 1, name: 'Almacén' }, { id: 2, name: 'Sucursal A' }, { id: 3, name: 'Sucursal B' }];
const frozenNow = () => new Date('2026-03-20T12:00:00Z');
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value),
  { status, headers: { 'Content-Type': 'application/json' } });
const failure = (code: string, status: number) => new Response(JSON.stringify({ error: code }),
  { status, headers: { 'Content-Type': 'application/json' } });

// The tray publishes the header of a case; the case adds its resolution, its loans and its history.
const row = (over: Record<string, unknown> = {}) => ({
  id: 1, case_number: 'C-2-000001', branch_location_id: 2, origin: 'warranty_claim', phase: 'received',
  variant_id: 1, serial_number: 'ABC123', quantity: null, declared_failure: 'No arranca el motor',
  reason: null, created_at: '2026-03-01T12:00:00Z', ...over,
});
const findingRow = (over: Record<string, unknown> = {}) => row({
  id: 5, case_number: 'C-3-000005', branch_location_id: 3, origin: 'stock_defect', variant_id: 4,
  serial_number: null, quantity: 2, reason: 'Probada en mostrador', declared_failure: 'No retiene carga',
  ...over,
});
const loan = (over: Record<string, unknown> = {}) => ({
  ordinal: 1, model: 'NS60L', quantity: 1, serial_number: '', source_location_id: 1,
  given_at: '2026-03-01T12:05:00Z', fate: 'open', fate_decided_at: null, given_by_account_id: 2, ...over,
});
const event = (over: Record<string, unknown> = {}) => ({
  ordinal: 1, kind: 'phase', phase: 'received', factory_case_number: '', actor_account_id: 2,
  recorded_at: '2026-03-01T12:00:00Z', note: '', ...over,
});
const tramos = () => [
  event({ ordinal: 1, phase: 'received', note: 'Reclamo registrado' }),
  event({ ordinal: 2, phase: 'in_transit', recorded_at: '2026-03-02T12:00:00Z', note: 'Sale al Almacén' }),
  event({ ordinal: 3, phase: 'at_warehouse', actor_account_id: 1, recorded_at: '2026-03-03T12:00:00Z', note: 'Recibida' }),
  event({ ordinal: 4, phase: 'at_factory', factory_case_number: 'F-2214', actor_account_id: 1,
    recorded_at: '2026-03-10T12:00:00Z', note: 'Salió a fábrica' }),
];
const claim = (over: Record<string, unknown> = {}) => ({
  ...row({ id: 2, case_number: 'C-2-000002', phase: 'at_factory' }), verdict: null, reported_destination: null,
  loan_destination: null, stock_destination: null, sale_id: 12, warranty_number: '2-000012',
  created_by_account_id: 2, loans: [loan()], events: tramos(), ...over,
});
const claimAtWarehouse = (over: Record<string, unknown> = {}) => claim({
  phase: 'at_warehouse', events: tramos().slice(0, 3), ...over,
});
const claimInTransit = (over: Record<string, unknown> = {}) => claim({
  id: 1, case_number: 'C-2-000001', phase: 'in_transit', events: tramos().slice(0, 2), ...over,
});
const finding = (over: Record<string, unknown> = {}) => ({
  ...findingRow({ phase: 'at_factory' }), verdict: null, reported_destination: null, loan_destination: null,
  stock_destination: null, sale_id: null, warranty_number: null, created_by_account_id: 2,
  loans: [], events: tramos().map(entry => ({ ...entry, actor_account_id: 2 })), ...over,
});
const resolvedClaim = ({ notice = true, release = false }: { notice?: boolean; release?: boolean } = {}) => claim({
  phase: 'resolved', verdict: 'repaired', reported_destination: 'customer', loan_destination: 'stock',
  events: [
    ...tramos(),
    event({ ordinal: 5, phase: 'resolved', actor_account_id: 1, recorded_at: '2026-03-12T12:00:00Z',
      note: 'Reparada por fábrica' }),
    ...(notice ? [event({ ordinal: 6, kind: 'notice', phase: 'resolved', actor_account_id: 2,
      recorded_at: '2026-03-16T12:00:00Z', note: 'Avisado por teléfono' })] : []),
    ...(release ? [event({ ordinal: 7, kind: 'release', phase: 'resolved', actor_account_id: 1,
      recorded_at: '2026-03-18T12:00:00Z', note: 'El cliente no volvió' })] : []),
  ],
});
/** The same claim, whose usable unit is destined to the branch's own shelf instead of to a client (S31). */
const resolvedStockBoundClaim = ({ verdict = 'repaired', closed = false, notice = true }:
{ verdict?: string; closed?: boolean; notice?: boolean } = {}) => claim({
  // The release that sells this unit is the act that closes the case: the server states `closed` in the
  // release itself and writes no tramo of the journey for it (073).
  phase: closed ? 'closed' : 'resolved', verdict, reported_destination: 'stock', loan_destination: 'customer',
  events: [
    ...tramos(),
    event({ ordinal: 5, phase: 'resolved', actor_account_id: 1, recorded_at: '2026-03-12T12:00:00Z',
      note: 'Reparada por fábrica' }),
    ...(notice ? [event({ ordinal: 6, kind: 'notice', phase: 'resolved', actor_account_id: 2,
      recorded_at: '2026-03-16T12:00:00Z', note: 'Avisado por teléfono' })] : []),
    ...(closed ? [event({ ordinal: 7, kind: 'release', phase: 'closed', actor_account_id: 1,
      recorded_at: '2026-03-18T12:00:00Z', note: 'El cliente no vino' })] : []),
  ],
});

type Handler = (url: string, init: RequestInit) => Response | undefined;
function harness(handler: Handler) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const reply = handler(url, init);
    if (!reply) throw new Error('Unexpected mocked URL: ' + url);
    return reply;
  });
  return {
    fetcher, calls,
    posts: () => calls.filter(call => (call.init.method ?? 'GET') === 'POST'),
    trayReads: () => calls.filter(call => call.url.startsWith('/api/warranty-cases?')
      || call.url === '/api/warranty-cases'),
  };
}
/** A desk where every question is answered: one claim in transit, one at the gate, one in the factory. */
function desk(handler: (url: string, init: RequestInit) => Response | undefined = () => undefined) {
  return harness((url, init) => {
    const custom = handler(url, init);
    if (custom) return custom;
    if (url === '/api/warranty-cases?phase=in_transit') return json({ cases: [row({ phase: 'in_transit' })] });
    if (url === '/api/warranty-cases?phase=at_warehouse') {
      return json({ cases: [row({ id: 2, case_number: 'C-2-000002', phase: 'at_warehouse' })] });
    }
    if (url === '/api/warranty-cases?phase=at_factory') return json({ cases: [row({ id: 3, case_number: 'C-2-000003', phase: 'at_factory' })] });
    if (url === '/api/warranty-cases?phase=resolved') return json({ cases: [] });
    return undefined;
  });
}
const tray = (cases: readonly unknown[]) => json({ cases });
function renderDesk(h: ReturnType<typeof harness>) {
  render(<WarehouseWarrantyCases csrf={csrf} locations={locations} fetcher={h.fetcher} now={frozenNow} />);
}

describe('the factory desk of the warehouse', () => {
  it('asks the four questions of the desk and reads one tray per question (S9, S10, S13)', async () => {
    const h = desk();
    renderDesk(h);
    const group = await screen.findByRole('group', { name: 'Figuras de la mesa por etapa' });
    await waitFor(() => {
      // Every figure names the phase it counts, and the phase is the only filter the desk asks for.
      expect(within(group).getAllByRole('button')).toHaveLength(4);
      expect(within(group).getByRole('button', { name: /En tránsito/ })).toHaveTextContent('1');
      expect(within(group).getByRole('button', { name: /Para verificar/ })).toHaveTextContent('1');
      expect(within(group).getByRole('button', { name: /En fábrica/ })).toHaveTextContent('1');
      expect(within(group).getByRole('button', { name: /Devueltas sin decidir/ })).toHaveTextContent('0');
    });
    expect(h.trayReads().map(call => call.url).sort()).toEqual([
      '/api/warranty-cases?phase=at_factory', '/api/warranty-cases?phase=at_warehouse',
      '/api/warranty-cases?phase=in_transit', '/api/warranty-cases?phase=resolved',
    ]);
    // The selected figure is stated as pressed, never by colour alone.
    expect(within(group).getByRole('button', { name: /Para verificar/ })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(group).getByRole('button', { name: /En tránsito/ }));
    expect(within(group).getByRole('button', { name: /En tránsito/ })).toHaveAttribute('aria-pressed', 'true');
    // The queue is the tray of that phase, with the branch that owns each case named.
    const table = screen.getByRole('table');
    expect(within(table).getByRole('caption').textContent).toMatch(/desde el alta/);
    expect(within(table).getByRole('button', { name: 'Ver el caso C-2-000001' })).toBeInTheDocument();
    expect(within(table).getByText('Sucursal A')).toBeInTheDocument();
    // Nothing was written by looking at the desk.
    expect(h.posts()).toHaveLength(0);
  });

  it('opens the case with the facts, the history and the custody block of the branch pane (S13, S14)', async () => {
    const h = desk(url => url === '/api/warranty-cases/2' ? json(resolvedClaim()) : undefined);
    renderDesk(h);
    fireEvent.click(await screen.findByRole('button', { name: 'Ver el caso C-2-000002' }));
    expect(await screen.findByRole('heading', { name: 'Sucursal A' })).toBeInTheDocument();
    const pane = screen.getByRole('complementary', { name: 'Detalle del caso' });
    // The same facts the branch reads, including the printed warranty number of the claimed sale.
    expect(within(pane).getByText('ABC123')).toBeInTheDocument();
    expect(within(pane).getByText('Garantía 2-000012')).toBeInTheDocument();
    expect(within(pane).getByText('No arranca el motor')).toBeInTheDocument();
    expect(within(pane).getByText('Reparada')).toBeInTheDocument();
    // The history is the append-only one, with the tramo that put the case where it is.
    expect(within(pane).getByText('Salió a fábrica')).toBeInTheDocument();
    expect(within(pane).getByText(/Legajo de fábrica F-2214/)).toBeInTheDocument();
    expect(within(pane).getByText(/Hace 8 días/)).toBeInTheDocument();
    // The unit that waits for the client is custody, and it is never written as sellable stock.
    expect(within(pane).getByText('En custodia por garantía: 1 unidad')).toBeInTheDocument();
    expect(within(pane).getByText(/no es stock vendible/)).toBeInTheDocument();
    // The three crossings are legible where they happen.
    expect(within(pane).getByRole('heading', { name: 'Stock, custodia y liberación' })).toBeInTheDocument();
    expect(within(pane).getByText('Baja del hallazgo')).toBeInTheDocument();
    expect(within(pane).getByText('Liberación a stock')).toBeInTheDocument();
  });

  it('states a failed tray read and reads it again on demand', async () => {
    let attempts = 0;
    const h = harness((url, init) => {
      if (url === '/api/warranty-cases?phase=at_factory' || url === '/api/warranty-cases?phase=resolved'
        || url === '/api/warranty-cases?phase=in_transit') return tray([]);
      if (url === '/api/warranty-cases?phase=at_warehouse') {
        attempts += 1;
        return attempts === 1 ? failure('service_unavailable', 503) : tray([]);
      }
      return undefined;
    });
    renderDesk(h);
    expect(await screen.findByRole('alert')).toHaveTextContent(/El servicio no está disponible/);
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar la mesa' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(attempts).toBe(2);
  });
});

describe('the acts the warehouse owns', () => {
  it('receives what is on its way and writes the tramo with its motive (S9)', async () => {
    const receivedCase = claimAtWarehouse({ id: 1, case_number: 'C-2-000001' });
    let received = false;
    const h = desk((url, init) => {
      if (url === '/api/warranty-cases/1') return json(received ? receivedCase : claimInTransit());
      if (url === '/api/warranty-cases/1/advance' && init.method === 'POST') {
        received = true;
        return json(receivedCase);
      }
      return undefined;
    });
    renderDesk(h);
    fireEvent.click(await screen.findByRole('button', { name: /En tránsito/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Ver el caso C-2-000001' }));
    fireEvent.change(await screen.findByLabelText('Qué llegó al Almacén'), { target: { value: ' Llegó completa ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Registrar la recepción' }));
    await screen.findByText(/C-2-000001 recibida en el Almacén/);
    const post = h.posts()[0];
    expect(post.url).toBe('/api/warranty-cases/1/advance');
    expect(JSON.parse(String(post.init.body))).toEqual({
      phase: 'at_warehouse', factory_case_number: '', note: 'Llegó completa',
    });
    expect((post.init.headers as Record<string, string>)['X-CSRF-Token']).toBe(csrf);
    // Once received, the case waits for the verification: the shipment is the next act, not automatic.
    expect(await screen.findByLabelText('Número de legajo de fábrica')).toBeInTheDocument();
  });

  it('ships to the factory with the file number it transcribes and never without it (S9, S10)', async () => {
    let shipped = false;
    const h = desk((url, init) => {
      if (url === '/api/warranty-cases/2') return json(shipped ? claim() : claimAtWarehouse());
      if (url === '/api/warranty-cases/2/advance' && init.method === 'POST') {
        shipped = true;
        return json(claim());
      }
      return undefined;
    });
    renderDesk(h);
    fireEvent.click(await screen.findByRole('button', { name: 'Ver el caso C-2-000002' }));
    fireEvent.change(await screen.findByLabelText('Motivo del envío'), { target: { value: 'Salió a fábrica' } });
    // The shipment carries its file number: the screen states the rule and writes nothing without it.
    fireEvent.submit(screen.getByLabelText('Número de legajo de fábrica').closest('form')!);
    expect(await screen.findByRole('alert')).toHaveTextContent(/exige el número de legajo/);
    expect(h.posts()).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('Número de legajo de fábrica'), { target: { value: ' F-2214 ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar a fábrica' }));
    await screen.findByText(/C-2-000002 en fábrica con el legajo F-2214/);
    expect(JSON.parse(String(h.posts().at(-1)!.init.body))).toEqual({
      phase: 'at_factory', factory_case_number: 'F-2214', note: 'Salió a fábrica',
    });
  });

  it('refuses before the factory with the only verdict of its gate and a mandatory motive (S10)', async () => {
    let refused = false;
    const h = desk((url, init) => {
      if (url === '/api/warranty-cases/2') return json(refused ? claim({
        phase: 'resolved', verdict: 'refused_at_warehouse', reported_destination: 'customer',
        loan_destination: 'stock', events: [...tramos().slice(0, 3),
          event({ ordinal: 4, phase: 'resolved', actor_account_id: 1, recorded_at: '2026-03-11T12:00:00Z',
            note: 'No pasa la prueba' })],
      }) : claimAtWarehouse());
      if (url === '/api/warranty-cases/2/resolution' && init.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        if (body.note === '') return failure('reason_required', 400);
        refused = true;
        return json(claim({
          phase: 'resolved', verdict: 'refused_at_warehouse', reported_destination: 'customer',
          loan_destination: 'stock', events: [...tramos().slice(0, 3),
            event({ ordinal: 4, phase: 'resolved', actor_account_id: 1, recorded_at: '2026-03-11T12:00:00Z',
              note: 'No pasa la prueba' })],
        }));
      }
      return undefined;
    });
    renderDesk(h);
    fireEvent.click(await screen.findByRole('button', { name: 'Ver el caso C-2-000002' }));
    const verdict = await screen.findByLabelText('Veredicto');
    // The gate admits one verdict and nothing else: it is stated, not chosen between five.
    expect(within(verdict).getAllByRole('option').map(option => option.textContent))
      .toEqual(['Rechazada en el Almacén']);
    fireEvent.change(screen.getByLabelText('Unidad reclamada'), { target: { value: 'customer' } });
    fireEvent.change(screen.getByLabelText('Usada prestada'), { target: { value: 'stock' } });
    // Without a motive the screen writes nothing at all.
    fireEvent.submit(verdict.closest('form')!);
    expect(await screen.findByRole('alert')).toHaveTextContent(/motivo/);
    expect(h.posts()).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('Motivo del veredicto'),
      { target: { value: 'No pasa la prueba de carga' } });
    fireEvent.click(screen.getByRole('button', { name: 'Registrar veredicto' }));
    await screen.findByText(/C-2-000002: veredicto rechazada en el almacén/);
    expect(JSON.parse(String(h.posts().at(-1)!.init.body))).toEqual({
      verdict: 'refused_at_warehouse', reported_destination: 'customer',
      loan_destination: 'stock', note: 'No pasa la prueba de carga',
    });
  });

  it('states the factory verdict of a claim with the destination of its lent battery (S11)', async () => {
    const factoryClaim = { id: 3, case_number: 'C-2-000003' };
    const h = desk((url, init) => {
      if (url === '/api/warranty-cases/3') return json(claim(factoryClaim));
      if (url === '/api/warranty-cases/3/resolution' && init.method === 'POST') {
        return json(claim({ ...factoryClaim, phase: 'resolved', verdict: 'repaired', reported_destination: 'customer',
          loan_destination: 'stock', events: [...tramos(),
            event({ ordinal: 5, phase: 'resolved', actor_account_id: 1,
              recorded_at: '2026-03-19T12:00:00Z', note: 'Reparada por fábrica' })] }));
      }
      return undefined;
    });
    renderDesk(h);
    // The claim states where its reported battery and its lent one end: two fields, one resolution.
    fireEvent.click(await screen.findByRole('button', { name: /En fábrica/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Ver el caso C-2-000003' }));
    fireEvent.change(await screen.findByLabelText('Veredicto'), { target: { value: 'repaired' } });
    fireEvent.change(screen.getByLabelText('Unidad reclamada'), { target: { value: 'customer' } });
    fireEvent.change(screen.getByLabelText('Usada prestada'), { target: { value: 'stock' } });
    fireEvent.change(screen.getByLabelText('Motivo del veredicto'), { target: { value: 'Reparada por fábrica' } });
    fireEvent.click(screen.getByRole('button', { name: 'Registrar veredicto' }));
    await screen.findByText(/C-2-000003: veredicto reparada/);
    expect(JSON.parse(String(h.posts().at(-1)!.init.body))).toEqual({
      verdict: 'repaired', reported_destination: 'customer', loan_destination: 'stock',
      note: 'Reparada por fábrica',
    });
  });

  it('says one unit left the branch stock when the finding is a single battery (S34)', async () => {
    const h = desk(url => {
      if (url === '/api/warranty-cases?phase=at_factory') return tray([findingRow({ phase: 'at_factory', quantity: 1 })]);
      if (url === '/api/warranty-cases/5') return json(finding({ quantity: 1 }));
      return undefined;
    });
    renderDesk(h);
    fireEvent.click(await screen.findByRole('button', { name: /En fábrica/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Ver el caso C-3-000005' }));
    const pane = await screen.findByRole('complementary', { name: 'Detalle del caso' });
    expect(within(pane).getByText('Hallazgo en góndola: 1 unidad dada de baja del stock de la sucursal.'))
      .toBeInTheDocument();
  });

  it('says several units left the branch stock when the finding takes more than one battery (S34)', async () => {
    const h = desk(url => {
      if (url === '/api/warranty-cases?phase=at_factory') return tray([findingRow({ phase: 'at_factory', quantity: 2 })]);
      if (url === '/api/warranty-cases/5') return json(finding({ quantity: 2 }));
      return undefined;
    });
    renderDesk(h);
    fireEvent.click(await screen.findByRole('button', { name: /En fábrica/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Ver el caso C-3-000005' }));
    const pane = await screen.findByRole('complementary', { name: 'Detalle del caso' });
    expect(within(pane).getByText('Hallazgo en góndola: 2 unidades dadas de baja del stock de la sucursal.'))
      .toBeInTheDocument();
  });

  it('states the factory verdict of a finding on its own shelf, with no borrowed battery at all (S11)', async () => {
    const h = desk((url, init) => {
      if (url === '/api/warranty-cases?phase=at_factory') return tray([findingRow({ phase: 'at_factory' })]);
      if (url === '/api/warranty-cases/5') return json(finding());
      if (url === '/api/warranty-cases/5/resolution' && init.method === 'POST') {
        return json(finding({ phase: 'resolved', verdict: 'repaired', reported_destination: 'stock',
          stock_destination: 'stock', events: [...tramos(),
            event({ ordinal: 5, phase: 'resolved', actor_account_id: 1,
              recorded_at: '2026-03-19T12:00:00Z', note: 'Reparadas por fábrica' })] }));
      }
      return undefined;
    });
    renderDesk(h);
    fireEvent.click(await screen.findByRole('button', { name: /En fábrica/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Ver el caso C-3-000005' }));
    fireEvent.change(await screen.findByLabelText('Veredicto'), { target: { value: 'repaired' } });
    // A finding lends nothing, so the loan has no field, and its units return to the shelf's own stock.
    expect(screen.queryByLabelText('Usada prestada')).not.toBeInTheDocument();
    const reported = screen.getByLabelText('Unidades de la góndola');
    expect(within(reported).getAllByRole('option').map(option => option.textContent)).toEqual(['A stock vendible']);
    fireEvent.change(screen.getByLabelText('Motivo del veredicto'), { target: { value: 'Reparadas por fábrica' } });
    fireEvent.click(screen.getByRole('button', { name: 'Registrar veredicto' }));
    await screen.findByText(/C-3-000005: veredicto reparada/);
    expect(JSON.parse(String(h.posts().at(-1)!.init.body))).toEqual({
      verdict: 'repaired', reported_destination: 'stock', note: 'Reparadas por fábrica',
    });
  });

  it('releases the unit a claim holds in custody once the notice is on record (S13, S14)', async () => {
    let released = false;
    const h = desk((url, init) => {
      if (url === '/api/warranty-cases/2') return json(resolvedClaim({ release: released }));
      if (url === '/api/warranty-cases/2/release' && init.method === 'POST') {
        released = true;
        return json(resolvedClaim({ release: true }));
      }
      return undefined;
    });
    renderDesk(h);
    fireEvent.click(await screen.findByRole('button', { name: 'Ver el caso C-2-000002' }));
    fireEvent.change(await screen.findByLabelText('Motivo de la liberación'),
      { target: { value: ' El cliente no volvió ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Autorizar la liberación a stock' }));
    await screen.findByText(/C-2-000002: la unidad liberada a stock vendible/);
    const post = h.posts()[0];
    expect(post.url).toBe('/api/warranty-cases/2/release');
    expect(JSON.parse(String(post.init.body))).toEqual({ note: 'El cliente no volvió' });
    // The unit left custody: the crossing says who released it and when, and the act is gone.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Autorizar la liberación a stock' }))
      .not.toBeInTheDocument());
    expect(screen.getByText(/El Almacén liberó 1 unidad al stock vendible/)).toBeInTheDocument();
  });

  it('offers the release that closes a case whose unit is bound for stock (S31)', async () => {
    let released = false;
    const h = desk((url, init) => {
      if (url === '/api/warranty-cases/2') {
        return json(released ? resolvedStockBoundClaim({ closed: true }) : resolvedStockBoundClaim());
      }
      if (url === '/api/warranty-cases/2/release' && init.method === 'POST') {
        released = true;
        return json(resolvedStockBoundClaim({ closed: true }));
      }
      return undefined;
    });
    renderDesk(h);
    fireEvent.click(await screen.findByRole('button', { name: 'Ver el caso C-2-000002' }));
    // The act the case waits for is offered: this unit is sold by the release, never delivered (S31).
    expect(await screen.findByRole('heading', { name: 'Autorizar la liberación' })).toBeInTheDocument();
    // Its crossing stops saying the case has nothing to release, and it says what this act does.
    const crossings = () => screen.getByText('Baja del hallazgo').closest('ul')!;
    const crossing = within(crossings()).getByText('Liberación a stock').closest('li')!;
    expect(crossing).toHaveAttribute('data-state', 'pending');
    expect(within(crossing).getByText('Lista para liberar')).toBeInTheDocument();
    expect(within(crossing).queryByText('Sin movimiento')).not.toBeInTheDocument();
    expect(within(crossing).getByText(/cierra el caso/)).toBeInTheDocument();
    // The unit is still custody, never sellable stock, and it does not wait for a client.
    expect(screen.getByText('En custodia por garantía: 1 unidad')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Motivo de la liberación'),
      { target: { value: ' El cliente no vino: la unidad queda en stock ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Autorizar la liberación a stock' }));
    await screen.findByText(/C-2-000002: la unidad liberada a stock vendible/);
    expect(JSON.parse(String(h.posts()[0].init.body))).toEqual({ note: 'El cliente no vino: la unidad queda en stock' });
    expect(h.posts()[0].url).toBe('/api/warranty-cases/2/release');
    // The release closed the case: the desk has no act left on it, says so, and names the act that closed it.
    expect(await screen.findByText('El caso está cerrado: no admite más actos del Almacén.')).toBeInTheDocument();
    const closedCrossing = within(crossings()).getByText('Liberación a stock').closest('li')!;
    expect(within(closedCrossing).getByText('Liberada a stock')).toBeInTheDocument();
    expect(within(closedCrossing).getByText(/caso cerró con ese acto/)).toBeInTheDocument();
    // The pill of the case names the act that closed it: the release sold the unit, no client took it.
    const pane = screen.getByRole('complementary', { name: 'Detalle del caso' });
    const top = pane.querySelector('.warranty-detail-top') as HTMLElement;
    expect(within(top).getByText('Cerrada por liberación')).toBeInTheDocument();
    expect(within(top).queryByText('Entregada')).not.toBeInTheDocument();
  });

  it('offers nothing for the stock-bound unit that went to the used pool, and says why (S31, S11)', async () => {
    const h = desk(url => url === '/api/warranty-cases/2'
      ? json(resolvedStockBoundClaim({ verdict: 'not_covered' })) : undefined);
    renderDesk(h);
    fireEvent.click(await screen.findByRole('button', { name: 'Ver el caso C-2-000002' }));
    await screen.findByRole('heading', { name: 'Sucursal A' });
    // The destination alone never opens this act: an uncovered unit is the pool de usadas' (LW025).
    expect(screen.queryByRole('heading', { name: 'Autorizar la liberación' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Motivo de la liberación')).not.toBeInTheDocument();
    // Both the crossing and the act block say why: no unit came back that the branch could sell (LW025).
    expect(screen.getAllByText(/no tiene ninguna unidad que liberar/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/pool de usadas/).length).toBeGreaterThan(0);
    expect(h.posts()).toHaveLength(0);
  });

  it('offers no release while the notice is missing, and says what is missing (S14)', async () => {
    const h = desk(url => url === '/api/warranty-cases/2' ? json(resolvedClaim({ notice: false })) : undefined);
    renderDesk(h);
    fireEvent.click(await screen.findByRole('button', { name: 'Ver el caso C-2-000002' }));
    await screen.findByRole('heading', { name: 'Sucursal A' });
    expect(screen.queryByRole('button', { name: 'Autorizar la liberación a stock' })).not.toBeInTheDocument();
    expect(screen.getAllByText(/Falta el aviso que registra la sucursal/).length).toBeGreaterThan(0);
    expect(h.posts()).toHaveLength(0);
  });
});

describe('the actor split of the desk (S19)', () => {
  it('never offers the warehouse an act the contract gives to the branch', async () => {
    const h = desk(url => url === '/api/warranty-cases/2' ? json(resolvedClaim({ notice: true })) : undefined);
    renderDesk(h);
    fireEvent.click(await screen.findByRole('button', { name: 'Ver el caso C-2-000002' }));
    await screen.findByRole('heading', { name: 'Sucursal A' });
    const branchActs = ['Registrar canje', 'Hallazgo en góndola', 'Registrar préstamo', 'Registrar aviso',
      'Entregar canje', 'Cerrar el caso', 'Enviar al Almacén'];
    for (const name of branchActs) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
    // The case belongs to the branch and the screen says it, so a missing act is never a mystery.
    expect(screen.getByText(/La entrega al cliente y el cierre del caso son de la sucursal/)).toBeInTheDocument();
  });

  it('reads the tray of every branch but never opens a case of its own (S19)', async () => {
    const h = desk();
    renderDesk(h);
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Sucursal A')).toBeInTheDocument();
    // The desk offers no door of its own: it only moves what a branch already opened.
    expect(screen.queryByRole('button', { name: /Registrar canje/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Hallazgo en góndola/ })).not.toBeInTheDocument();
    expect(h.posts()).toHaveLength(0);
  });
});

describe('the factory desk on the warranty invalidation', () => {
  it('asks its four questions again when the branch writes, without a reload', async () => {
    const h = desk();
    renderDesk(h);
    await screen.findByRole('table');
    await waitFor(() => expect(h.trayReads()).toHaveLength(4));
    act(() => notifyWarrantyInvalidation());
    await waitFor(() => expect(h.trayReads()).toHaveLength(8));
    expect(h.posts()).toHaveLength(0);
  });
});
