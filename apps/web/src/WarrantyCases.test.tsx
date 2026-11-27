import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import WarrantyCases from './WarrantyCases';
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
  reason: null, created_at: '2026-03-01T12:00:00Z', closed_by: null, ...over,
});
const loan = (over: Record<string, unknown> = {}) => ({
  ordinal: 1, model: 'NS60L', quantity: 1, serial_number: '', source_location_id: 1,
  given_at: '2026-03-01T12:05:00Z', fate: 'open', fate_decided_at: null, given_by_account_id: 2, ...over,
});
const event = (over: Record<string, unknown> = {}) => ({
  ordinal: 1, kind: 'phase', phase: 'received', factory_case_number: '', actor_account_id: 2,
  recorded_at: '2026-03-01T12:00:00Z', note: '', ...over,
});
const phasesToResolved = () => [
  event({ ordinal: 1, phase: 'received', note: 'Reclamo registrado' }),
  event({ ordinal: 2, phase: 'in_transit', recorded_at: '2026-03-02T12:00:00Z' }),
  event({ ordinal: 3, phase: 'at_warehouse', recorded_at: '2026-03-03T12:00:00Z' }),
  event({ ordinal: 4, phase: 'at_factory', factory_case_number: 'F-2214', recorded_at: '2026-03-04T12:00:00Z' }),
  event({ ordinal: 5, phase: 'resolved', recorded_at: '2026-03-05T12:00:00Z', note: 'Reparada por fábrica' }),
];
const receivedCase = (over: Record<string, unknown> = {}) => ({
  ...row(), verdict: null, reported_destination: null, loan_destination: null, stock_destination: null,
  sale_id: 12, warranty_number: '2-000126', created_by_account_id: 2, loans: [], events: [], ...over,
});
const resolvedCase = ({ noticed = true, loans = true }: { noticed?: boolean; loans?: boolean } = {}) => ({
  ...row({ id: 2, case_number: 'C-2-000002', phase: 'resolved' }),
  verdict: 'repaired', reported_destination: 'customer', loan_destination: 'stock', stock_destination: null,
  sale_id: 12, warranty_number: '2-000126', created_by_account_id: 2,
  loans: loans ? [loan({ fate: 'open' })] : [],
  events: noticed ? [...phasesToResolved(),
    event({ ordinal: 6, kind: 'notice', phase: 'resolved', recorded_at: '2026-03-16T12:00:00Z', note: 'Avisado por teléfono' })]
    : phasesToResolved(),
});
const noticeEvent = () => event({ ordinal: 6, kind: 'notice', phase: 'resolved',
  recorded_at: '2026-03-16T12:00:00Z', note: 'Avisado por teléfono' });
const releaseEvent = (phase: 'resolved' | 'closed') => event({ ordinal: 7, kind: 'release', phase,
  recorded_at: '2026-03-19T12:00:00Z', note: 'Liberada a stock vendible' });
// A claim whose unit the factory returned for the branch's own shelf (S31): it waits in custody, and the
// release is the act that enters it into the branch's stock and closes the case.
const stockBoundCase = (over: Record<string, unknown> = {}) => ({
  ...row({ id: 2, case_number: 'C-2-000002', phase: 'resolved' }),
  verdict: 'repaired', reported_destination: 'stock', loan_destination: 'customer', stock_destination: null,
  sale_id: 12, warranty_number: '2-000126', created_by_account_id: 2,
  loans: [loan({ fate: 'returned', fate_decided_at: '2026-03-18T12:00:00Z' })],
  events: [...phasesToResolved(), noticeEvent()],
  ...over,
});
// The same case once the Almacén released it: the release is its last event and it holds `closed`.
const releasedStockCase = () => stockBoundCase({ phase: 'closed', closed_by: 'release',
  events: [...phasesToResolved(), noticeEvent(), releaseEvent('closed')] });
// A claim the factory did not cover: the damaged unit goes to the used pool with that same destination and the
// lent battery stays with the client (LW025, S11). The server accepts this delivery and refuses its release, so
// the destination column alone never says which act closes the case.
const uncoveredStockCase = (over: Record<string, unknown> = {}) => ({
  ...resolvedCase({ noticed: false }),
  verdict: 'not_covered', reported_destination: 'stock', loan_destination: 'customer', ...over,
});
// The same uncovered case once the counter delivered the exchange: that act closed it.
const deliveredUncovered = () => uncoveredStockCase({ phase: 'closed', closed_by: 'delivery',
  loans: [loan({ fate: 'kept_by_customer', fate_decided_at: '2026-03-20T13:00:00Z' })],
  events: [...phasesToResolved(),
    event({ ordinal: 6, phase: 'closed', recorded_at: '2026-03-20T13:00:00Z', note: 'Canje entregado' })] });
// The sale the claim was judged against: the client, the sale date and the unit's own term.
const saleBody = {
  id: 12, branch_sequence: 126, warranty_number: '2-000126', payment_method: 'cash',
  payments: [{ method: 'cash', amount: '96000.00' }],
  customer_name: 'Marta Giménez',
  customer: { name: 'Marta Giménez', phone: '381 555 0198', document: '27.884.310', address: 'Av. América 123' },
  total: '96000.00', created_at: '2025-09-04T17:42:00Z',
  lines: [{
    variant_id: 1, catalog_entry_id: 1, brand: 'CAR', model: 'NS40ZL', capacity_ah: '35', polarity: 'L',
    quantity: 1, unit_price: '96000.00', min_price: '85000.00', subtotal: '96000.00',
    units: [{ serial_number: 'ABC123', warranty_months: 12 }],
  }],
};

type Handler = (url: string, init: RequestInit) => Response | undefined;
function harness(handler: Handler) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init = {}) => {
    const url = String(input);
    // The loan form asks for the closed list of models before anything is typed (S30).
    if (url === '/api/warranty-cases/used-stock') return usedStock();
    calls.push({ url, init });
    const reply = handler(url, init);
    if (!reply) throw new Error('Unexpected mocked URL: ' + url);
    return reply;
  });
  return {
    fetcher, calls,
    posts: () => calls.filter(call => (call.init.method ?? 'GET') === 'POST'),
  };
}
function renderScreen(h: ReturnType<typeof harness>) {
  render(<WarrantyCases csrf={csrf} branch="Sucursal A" locations={locations} fetcher={h.fetcher} now={frozenNow} />);
}
const tray = (cases: readonly unknown[]) => json({ cases });

// The closed list of S30: only the models the pool knows, with what each origin holds of them. The
// wire orders its rows by origin and then by model, so the fixture is written in that order.
const usedStockRow = (location_id: number, model: string, available: number) => ({
  location_id, model, purchased: String(available), factory_returns: '0', loans_returned: '0',
  delivered: '0', loans_given: '0', available: String(available),
});
const usedStock = () => json({ stock: [
  usedStockRow(1, 'NS60L', 4),
  usedStockRow(2, 'NS40L', 1),
  usedStockRow(2, 'NS60L', 3),
  usedStockRow(3, 'NS60L', 6),
] });
const receiptLink = () => screen.getByRole('link', { name: /comprobante de préstamo/ });

describe('the branch guarantee tray', () => {
  it('lists the cases the tray publishes and filters them by phase and by origin', async () => {
    const h = harness(url => {
      if (url.startsWith('/api/warranty-cases?') || url === '/api/warranty-cases') {
        return tray([row({ id: 2, case_number: 'C-2-000002', phase: 'resolved' }), row()]);
      }
      return undefined;
    });
    renderScreen(h);
    const table = await screen.findByRole('table');
    expect(within(table).getByRole('button', { name: 'Ver el caso C-2-000002' })).toBeInTheDocument();
    expect(within(table).getAllByText('ABC123')).toHaveLength(2);
    expect(within(table).getAllByText('Garantía')).toHaveLength(2);
    expect(within(table).getByText('Esperando al cliente')).toBeInTheDocument();
    // The first read asks for the whole tray: a blank filter is absent, never sent empty.
    expect(h.calls[0].url).toBe('/api/warranty-cases');
    expect(within(table).getAllByText('19')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'En el Almacén' }));
    await waitFor(() => expect(h.calls.at(-1)?.url).toBe('/api/warranty-cases?phase=at_warehouse'));
    fireEvent.change(screen.getByLabelText('Origen'), { target: { value: 'stock_defect' } });
    await waitFor(() => expect(h.calls.at(-1)?.url)
      .toBe('/api/warranty-cases?phase=at_warehouse&origin=stock_defect'));
  });

  it('reads the selected case with its client, its history, the custody block and the receipt (S8, S13)', async () => {
    const h = harness(url => {
      if (url === '/api/warranty-cases') return tray([row({ id: 2, case_number: 'C-2-000002', phase: 'resolved' })]);
      if (url === '/api/warranty-cases/2') return json(resolvedCase());
      if (url === '/api/sales/12') return json(saleBody);
      return undefined;
    });
    renderScreen(h);
    fireEvent.click(await screen.findByRole('button', { name: 'Ver el caso C-2-000002' }));
    expect(await screen.findByRole('heading', { name: 'Marta Giménez' })).toBeInTheDocument();
    // The sale and its term are the persisted ones, and the term is stated from the sale.
    expect(screen.getByText(/2-000126/)).toBeInTheDocument();
    expect(screen.getByText('12 meses')).toBeInTheDocument();
    // The unit that waits for the client is not sellable stock.
    expect(screen.getByText('En custodia por garantía: 1 unidad')).toBeInTheDocument();
    // The unit of a claim destined to the client still leaves custody by the release or the delivery.
    expect(screen.getByText(/Sale de custodia cuando el Almacén la libera o cuando se entrega el canje/))
      .toBeInTheDocument();
    // The history is the append-only one, including the factory file number and the notice age.
    expect(screen.getByText('Reparada por fábrica')).toBeInTheDocument();
    expect(screen.getByText(/Legajo de fábrica F-2214/)).toBeInTheDocument();
    expect(screen.getByText(/Último aviso al cliente: 4 días/)).toBeInTheDocument();
    // The receipt is downloadable at the address the contract names, with a stable file name.
    expect(receiptLink()).toHaveAttribute('href', '/api/warranty-cases/2/receipt.pdf');
    expect(receiptLink()).toHaveAttribute('download', 'comprobante-C-2-000002.pdf');
    // The loan is identified by model and quantity, and its optional serial says it was not written.
    expect(screen.getByText('Sin serial anotado')).toBeInTheDocument();
    expect(screen.getByText('Almacén')).toBeInTheDocument();
  });

  it('registers the notice to the client and posts only its words (S14)', async () => {
    let noticed = false;
    const h = harness((url, init) => {
      if (url === '/api/warranty-cases') return tray([row({ id: 2, case_number: 'C-2-000002', phase: 'resolved' })]);
      if (url === '/api/warranty-cases/2') return json(resolvedCase({ noticed }));
      if (url === '/api/sales/12') return json(saleBody);
      if (url === '/api/warranty-cases/2/notice' && init.method === 'POST') {
        noticed = true;
        return json(resolvedCase());
      }
      return undefined;
    });
    renderScreen(h);
    fireEvent.click(await screen.findByRole('button', { name: 'Ver el caso C-2-000002' }));
    const field = await screen.findByLabelText('Qué se le dijo al cliente');
    fireEvent.change(field, { target: { value: 'Avisado por teléfono' } });
    fireEvent.click(screen.getByRole('button', { name: 'Registrar aviso' }));
    await screen.findByText(/Aviso registrado en C-2-000002/);
    const post = h.posts()[0];
    expect(post.url).toBe('/api/warranty-cases/2/notice');
    expect((post.init.headers as Record<string, string>)['X-CSRF-Token']).toBe(csrf);
    expect(JSON.parse(String(post.init.body))).toEqual({ note: 'Avisado por teléfono' });
    // Once the notice exists it is not offered again: it is recorded once.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Registrar aviso' })).not.toBeInTheDocument());
  });

  it('marks a failed used battery and scales the case with another loan, never a second case (S7)', async () => {
    const failed = loan({ fate: 'failed', fate_decided_at: '2026-03-09T12:00:00Z' });
    const second = loan({ ordinal: 2, model: 'NS40L', quantity: 1, source_location_id: 2,
      given_at: '2026-03-09T12:30:00Z' });
    let failedMarked = false;
    const h = harness((url, init) => {
      if (url === '/api/warranty-cases') return tray([row({ id: 2, case_number: 'C-2-000002', phase: 'resolved' })]);
      if (url === '/api/warranty-cases/2') return json({ ...resolvedCase(), loans: failedMarked ? [failed] : [loan()] });
      if (url === '/api/sales/12') return json(saleBody);
      if (url === '/api/warranty-cases/2/loans/1/fate' && init.method === 'POST') {
        failedMarked = true;
        return json(failed);
      }
      if (url === '/api/warranty-cases/2/loans' && init.method === 'POST') return json(second, 201);
      return undefined;
    });
    renderScreen(h);
    fireEvent.click(await screen.findByRole('button', { name: 'Ver el caso C-2-000002' }));
    // The fate is stated by the fact that happened, and the fact asks for confirmation first (S33).
    await screen.findByText('Desenlace: sin decidir · se pide al cerrar el caso');
    fireEvent.click(screen.getByRole('button', { name: 'La usada falló' }));
    fireEvent.click(within(await screen.findByRole('group', { name: 'Confirmar el desenlace del préstamo 1' }))
      .getByRole('button', { name: 'Sí, registrar el desenlace' }));
    await screen.findByText(/Préstamo 1 de C-2-000002: falló/);
    expect(h.posts()[0].url).toBe('/api/warranty-cases/2/loans/1/fate');
    expect(JSON.parse(String(h.posts()[0].init.body))).toEqual({ fate: 'failed' });
    expect(await screen.findByText('Falló')).toBeInTheDocument();
    // The case is still one case: the failed battery is replaced by another loan of the same case.
    fireEvent.click(screen.getByRole('button', { name: 'Registrar préstamo' }));
    // The list is read before the loan is stated, so the field waits for the stock of the origin.
    fireEvent.change(await screen.findByLabelText('Modelo de la usada'), { target: { value: 'NS40L' } });
    fireEvent.click(screen.getByRole('button', { name: 'Registrar préstamo' }));
    await screen.findByText(/Usada registrada en C-2-000002/);
    expect(h.posts().at(-1)?.url).toBe('/api/warranty-cases/2/loans');
    expect(JSON.parse(String(h.posts().at(-1)!.init.body))).toEqual({
      model: 'NS40L', quantity: 1, serial_number: '', source_location_id: 2,
    });
    // Both loans stay on the one case, each with its own outcome, and no second case exists.
    expect(await screen.findByText('NS60L')).toBeInTheDocument();
    expect(screen.getByText('NS40L')).toBeInTheDocument();
    expect(screen.queryByText('C-2-000003')).not.toBeInTheDocument();
  });

  it('lends only a model the chosen origin holds, and says so when it holds none (S30)', async () => {
    // A fourth branch of the session: it never bought, received or got back a used battery of any model.
    const branches = [...locations, { id: 4, name: 'Sucursal C' }];
    let refused = true;
    const handed = loan({ model: 'NS40L', quantity: 1, source_location_id: 2 });
    const h = harness((url, init) => {
      if (url === '/api/warranty-cases') return tray([row({ id: 2, case_number: 'C-2-000002', phase: 'resolved' })]);
      if (url === '/api/warranty-cases/2') return json(resolvedCase({ loans: false }));
      if (url === '/api/sales/12') return json(saleBody);
      if (url === '/api/warranty-cases/2/loans' && init.method === 'POST') {
        if (refused) { refused = false; return failure('loan_model_unknown', 409); }
        return json(handed, 201);
      }
      return undefined;
    });
    render(<WarrantyCases csrf={csrf} branch="Sucursal A" locations={branches} fetcher={h.fetcher} now={frozenNow} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Ver el caso C-2-000002' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Registrar préstamo' }));
    // The model is never typed: the case's own branch offers what it holds, and nothing else.
    const models = await screen.findByLabelText('Modelo de la usada');
    expect(models.tagName).toBe('SELECT');
    expect(screen.queryByRole('textbox', { name: 'Modelo de la usada' })).toBeNull();
    expect(within(models).getAllByRole('option').map(option => option.textContent))
      .toEqual(['Elegí el modelo', 'NS40L · 1 unidad', 'NS60L · 3 unidades']);
    const submit = () => screen.getByRole('button', { name: 'Registrar préstamo' });
    expect(submit()).toBeDisabled();
    // An origin that holds no used battery of any model offers no model at all and names itself.
    fireEvent.change(screen.getByLabelText('De dónde sale'), { target: { value: '4' } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Sucursal C no tiene usadas de ningún modelo');
    expect(screen.queryByText('Modelo de la usada')).toBeNull();
    expect(screen.queryByLabelText('Modelo de la usada')).toBeNull();
    expect(submit()).toBeDisabled();
    // Another origin is another list: the model chosen before is gone with it.
    fireEvent.change(screen.getByLabelText('De dónde sale'), { target: { value: '2' } });
    const again = await screen.findByLabelText('Modelo de la usada');
    expect(again).toHaveValue('');
    expect(submit()).toBeDisabled();
    fireEvent.change(again, { target: { value: 'NS40L' } });
    fireEvent.click(submit());
    // A model the pool refuses is stated in the contract's own words, never as a transport error.
    expect(await screen.findByRole('alert'))
      .toHaveTextContent('Ese modelo no está en el stock de usadas: elegí uno de la lista. No se registró nada.');
    expect(JSON.parse(String(h.posts().at(-1)!.init.body))).toEqual({
      model: 'NS40L', quantity: 1, serial_number: '', source_location_id: 2,
    });
    // The chosen model and its origin are what the case records, and the form goes with the loan.
    fireEvent.click(submit());
    await screen.findByText(/Usada registrada en C-2-000002/);
    expect(h.posts().at(-1)?.url).toBe('/api/warranty-cases/2/loans');
    expect(JSON.parse(String(h.posts().at(-1)!.init.body))).toEqual({
      model: 'NS40L', quantity: 1, serial_number: '', source_location_id: 2,
    });
    expect(screen.queryByLabelText('Modelo de la usada')).toBeNull();
  });

  it('delivers the exchange only when the used battery is registered, and settles the loan (S4)', async () => {
    let withLoan = false;
    let delivered = false;
    const closed = { phase: 'closed', loans: [loan({ fate: 'kept_by_customer', fate_decided_at: '2026-03-20T13:00:00Z' })],
      events: [...phasesToResolved(), event({ ordinal: 6, phase: 'closed', recorded_at: '2026-03-20T13:00:00Z' })] };
    const h = harness((url, init) => {
      // The tray is the header of the case and never its history: the row of a closed case carries the act
      // that closed it, so the pill of the bandeja names the delivery without reading the case (S34).
      if (url === '/api/warranty-cases') {
        return tray([row({ id: 2, case_number: 'C-2-000002', phase: delivered ? 'closed' : 'resolved',
          closed_by: delivered ? 'delivery' : null })]);
      }
      if (url === '/api/warranty-cases/2') {
        if (delivered) return json({ ...resolvedCase(), ...closed });
        return json(withLoan ? resolvedCase() : resolvedCase({ loans: false }));
      }
      if (url === '/api/sales/12') return json(saleBody);
      if (url === '/api/warranty-cases/2/delivery' && init.method === 'POST') {
        delivered = true;
        return json({ ...resolvedCase(), ...closed });
      }
      return undefined;
    });
    renderScreen(h);
    fireEvent.click(await screen.findByRole('button', { name: 'Ver el caso C-2-000002' }));
    const button = await screen.findByRole('button', { name: 'Entregar canje' });
    // Without a registered used battery the delivery is disabled, with the reason beside it.
    expect(button).toBeDisabled();
    expect(screen.getByText(/Falta registrar la usada que se entregó al cliente/)).toBeInTheDocument();
    withLoan = true;
    fireEvent.click(screen.getByRole('button', { name: 'Ver el caso C-2-000002' }));
    const enabled = await screen.findByRole('button', { name: 'Entregar canje' });
    // The used battery is registered, but the counter still has to state its fate (S31).
    expect(enabled).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Qué pasó con la usada'), { target: { value: 'kept_by_customer' } });
    fireEvent.change(screen.getByLabelText('Palabras del mostrador'), { target: { value: 'Se la quedó el cliente' } });
    expect(enabled).toBeEnabled();
    fireEvent.click(enabled);
    await screen.findByText(/Canje entregado en C-2-000002/);
    const post = h.posts().at(-1)!;
    expect(post.url).toBe('/api/warranty-cases/2/delivery');
    expect(JSON.parse(String(post.init.body))).toEqual({ loan_fate: 'kept_by_customer', note: 'Se la quedó el cliente' });
    // The closed case is named by the act that closed it, in the pane and in its own tray row.
    const trayRow = screen.getByRole('button', { name: 'Ver el caso C-2-000002' }).closest('tr')!;
    await waitFor(() => expect(within(trayRow).getByText('Entregada al cliente')).toBeInTheDocument());
    // The delivery is still the act that closed this case, and the pill of the detail keeps saying so.
    const pane = screen.getByRole('complementary', { name: 'Detalle del caso' });
    const top = pane.querySelector('.warranty-detail-top') as HTMLElement;
    expect(within(top).getByText('Entregada al cliente')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Entregar canje' })).not.toBeInTheDocument();
  });
});

describe('the destination of the unit decides the act that closes the case (S31)', () => {
  it('never states the fate of the lent battery on its own: it starts unanswered and gates the delivery (S31)', async () => {
    let delivered = false;
    const closed = { phase: 'closed', loans: [loan({ fate: 'returned', fate_decided_at: '2026-03-20T13:00:00Z' })],
      events: [...phasesToResolved(), event({ ordinal: 6, phase: 'closed', recorded_at: '2026-03-20T13:00:00Z' })] };
    const h = harness((url, init) => {
      if (url === '/api/warranty-cases') return tray([row({ id: 2, case_number: 'C-2-000002', phase: 'resolved' })]);
      if (url === '/api/warranty-cases/2') return json(delivered ? { ...resolvedCase(), ...closed } : resolvedCase());
      if (url === '/api/sales/12') return json(saleBody);
      if (url === '/api/warranty-cases/2/delivery' && init.method === 'POST') {
        delivered = true;
        return json({ ...resolvedCase(), ...closed });
      }
      return undefined;
    });
    renderScreen(h);
    fireEvent.click(await screen.findByRole('button', { name: 'Ver el caso C-2-000002' }));
    const fate = await screen.findByLabelText('Qué pasó con la usada');
    // A fate that moves the used pool's stock is never answered by the screen: it starts unanswered.
    expect(fate).toHaveValue('');
    // The two fates the counter can state are the two it always offered, and no third one.
    expect(within(fate).getAllByRole('option').map(option => option.textContent))
      .toEqual(['Elegí qué pasó con la usada', 'Volvió al local', 'Se la quedó el cliente']);
    fireEvent.change(screen.getByLabelText('Palabras del mostrador'), { target: { value: 'Volvió la usada' } });
    const submit = () => screen.getByRole('button', { name: 'Entregar canje' });
    expect(submit()).toBeDisabled();
    // The disabled submit says why: the counter owes the fate, not the screen.
    expect(screen.getByText(/Falta decir qué pasó con la usada prestada/)).toBeInTheDocument();
    // Nothing is posted: not by the disabled button, and not by forcing the form to submit.
    fireEvent.click(submit());
    fireEvent.submit(submit().closest('form')!);
    await waitFor(() => expect(screen.queryByText(/Canje entregado/)).toBeNull());
    expect(h.posts()).toHaveLength(0);
    // The moment the counter states it, the delivery states that one fate and nothing else.
    fireEvent.change(fate, { target: { value: 'returned' } });
    expect(submit()).toBeEnabled();
    fireEvent.click(submit());
    await screen.findByText(/Canje entregado en C-2-000002/);
    expect(h.posts()).toHaveLength(1);
    expect(h.posts()[0].url).toBe('/api/warranty-cases/2/delivery');
    expect(JSON.parse(String(h.posts()[0].init.body))).toEqual({ loan_fate: 'returned', note: 'Volvió la usada' });
  });

  it('publishes no delivery for a unit that goes to stock, and names the release as its close (S31)', async () => {
    // The client kept the used battery, so the unit that came back from the factory goes to sellable stock.
    const toStock = { ...resolvedCase({ noticed: false }), reported_destination: 'stock',
      loan_destination: 'customer' };
    const h = harness(url => {
      if (url === '/api/warranty-cases') return tray([row({ id: 2, case_number: 'C-2-000002', phase: 'resolved' })]);
      if (url === '/api/warranty-cases/2') return json(toStock);
      if (url === '/api/sales/12') return json(saleBody);
      return undefined;
    });
    renderScreen(h);
    fireEvent.click(await screen.findByRole('button', { name: 'Ver el caso C-2-000002' }));
    await screen.findByRole('heading', { name: 'Marta Giménez' });
    // The unit enters sellable stock by the release: no client receives it, so nothing offers to hand it over.
    expect(screen.queryByRole('button', { name: 'Entregar canje' })).toBeNull();
    expect(screen.queryByLabelText('Qué pasó con la usada')).toBeNull();
    expect(screen.queryByLabelText('Palabras del mostrador')).toBeNull();
    expect(screen.getByText('A stock vendible')).toBeInTheDocument();
    // The screen says which act closes this case instead of leaving the counter without an answer.
    expect(screen.getByRole('heading', { name: 'El caso cierra con la liberación' })).toBeInTheDocument();
    expect(screen.getByText(/aviso al cliente y la liberación que autoriza el Almacén/)).toBeInTheDocument();
    // The branch's own act before that close is still offered: the notice it has not registered yet.
    expect(screen.getByLabelText('Qué se le dijo al cliente')).toBeInTheDocument();
    expect(h.posts()).toHaveLength(0);
  });

  it('offers the delivery of an uncovered unit bound for stock and never names the release (S31)', async () => {
    let delivered = false;
    const h = harness((url, init) => {
      if (url === '/api/warranty-cases') return tray([row({ id: 2, case_number: 'C-2-000002', phase: 'resolved' })]);
      if (url === '/api/warranty-cases/2') return json(delivered ? deliveredUncovered() : uncoveredStockCase());
      if (url === '/api/sales/12') return json(saleBody);
      if (url === '/api/warranty-cases/2/delivery' && init.method === 'POST') {
        delivered = true;
        return json(deliveredUncovered());
      }
      return undefined;
    });
    renderScreen(h);
    fireEvent.click(await screen.findByRole('button', { name: 'Ver el caso C-2-000002' }));
    await screen.findByRole('heading', { name: 'Marta Giménez' });
    // The damaged unit is the used pool's and never the branch's shelf, so this case is not one the release
    // closes: the act the server accepts is the delivery, and it is offered exactly as it is for the client's.
    expect(screen.getByRole('heading', { name: 'Entregar el canje' })).toBeInTheDocument();
    const fate = screen.getByLabelText('Qué pasó con la usada');
    expect(fate).toHaveValue('');
    // The screen never announces a close the server does not perform for this case.
    expect(screen.queryByRole('heading', { name: 'El caso cierra con la liberación' })).toBeNull();
    expect(screen.queryByText(/con el aviso al cliente y la liberación que autoriza el Almacén/)).toBeNull();
    // The act is the client's repaired one: it writes the fate the counter states and nothing else.
    fireEvent.change(fate, { target: { value: 'kept_by_customer' } });
    fireEvent.change(screen.getByLabelText('Palabras del mostrador'), { target: { value: 'Se la quedó el cliente' } });
    fireEvent.click(screen.getByRole('button', { name: 'Entregar canje' }));
    await screen.findByText(/Canje entregado en C-2-000002/);
    expect(h.posts()).toHaveLength(1);
    expect(h.posts()[0].url).toBe('/api/warranty-cases/2/delivery');
    expect(JSON.parse(String(h.posts()[0].init.body)))
      .toEqual({ loan_fate: 'kept_by_customer', note: 'Se la quedó el cliente' });
  });

  it('keeps a replaced unit bound for stock out of the delivery and closed by the release (S31)', async () => {
    const h = harness(url => {
      if (url === '/api/warranty-cases') return tray([row({ id: 2, case_number: 'C-2-000002', phase: 'resolved' })]);
      if (url === '/api/warranty-cases/2') return json(stockBoundCase({ verdict: 'replaced' }));
      if (url === '/api/sales/12') return json(saleBody);
      return undefined;
    });
    renderScreen(h);
    fireEvent.click(await screen.findByRole('button', { name: 'Ver el caso C-2-000002' }));
    await screen.findByRole('heading', { name: 'Marta Giménez' });
    // The pair is what decides the act: the same destination with a returning verdict hands the unit to the shelf.
    expect(screen.queryByRole('heading', { name: 'Entregar el canje' })).toBeNull();
    expect(screen.queryByLabelText('Qué pasó con la usada')).toBeNull();
    expect(screen.getByRole('heading', { name: 'El caso cierra con la liberación' })).toBeInTheDocument();
    expect(screen.getByText(/a ningún cliente se le entrega/)).toBeInTheDocument();
    expect(h.posts()).toHaveLength(0);
  });

  it('names a case closed by the release by that act, never as delivered (S31)', async () => {
    const h = harness(url => {
      if (url === '/api/warranty-cases') {
        return tray([row({ id: 2, case_number: 'C-2-000002', phase: 'closed', closed_by: 'release' })]);
      }
      if (url === '/api/warranty-cases/2') return json(releasedStockCase());
      if (url === '/api/sales/12') return json(saleBody);
      return undefined;
    });
    renderScreen(h);
    fireEvent.click(await screen.findByRole('button', { name: 'Ver el caso C-2-000002' }));
    await screen.findByRole('heading', { name: 'Marta Giménez' });
    const pane = screen.getByRole('complementary', { name: 'Detalle del caso' });
    const top = pane.querySelector('.warranty-detail-top') as HTMLElement;
    // The unit entered the branch's sellable stock: the release is the act that closed the case, and
    // the pill of the detail names it instead of claiming a delivery that never happened.
    expect(within(top).getByText('Cerrada por liberación')).toBeInTheDocument();
    expect(within(top).queryByText('Entregada al cliente')).not.toBeInTheDocument();
    // The tray row names the same act out of the act the row publishes, and it never needed the history.
    const trayRow = screen.getByRole('button', { name: 'Ver el caso C-2-000002' }).closest('tr')!;
    expect(within(trayRow).getByText('Cerrada por liberación')).toBeInTheDocument();
    expect(within(trayRow).queryByText('Entregada al cliente')).not.toBeInTheDocument();
    // The closed case admits no further act of the branch.
    expect(screen.getByText('El caso está cerrado: no admite más acciones de la sucursal.')).toBeInTheDocument();
  });

  it('tells the truth about the custody of a unit bound for stock, before and after the release (S31)', async () => {
    let released = false;
    const h = harness(url => {
      if (url === '/api/warranty-cases') {
        return tray([row({ id: 2, case_number: 'C-2-000002', phase: released ? 'closed' : 'resolved' })]);
      }
      if (url === '/api/warranty-cases/2') return json(released ? releasedStockCase() : stockBoundCase());
      if (url === '/api/sales/12') return json(saleBody);
      return undefined;
    });
    renderScreen(h);
    fireEvent.click(await screen.findByRole('button', { name: 'Ver el caso C-2-000002' }));
    await screen.findByRole('heading', { name: 'Marta Giménez' });
    // While it waits, the unit is in custody and its destination is already stated: the shelf.
    expect(screen.getByText('En custodia por garantía: 1 unidad')).toBeInTheDocument();
    expect(screen.getByText(/su destino es el stock vendible de la sucursal/)).toBeInTheDocument();
    expect(screen.getByText(/Entra al stock con la liberación que autoriza el Almacén, y el caso cierra con ese acto/))
      .toBeInTheDocument();
    // No client ever receives it, so the block never promises a delivery as the way out of custody.
    expect(screen.queryByText(/cuando se entrega el canje/)).toBeNull();

    // The release sold the unit: it left custody and the case closed with that act, not open to a client.
    released = true;
    act(() => notifyWarrantyInvalidation());
    expect(await screen.findByText(
      'El Almacén liberó la unidad al stock vendible de la sucursal: ya no está en custodia y el caso cerró con ese acto.'))
      .toBeInTheDocument();
    expect(screen.queryByText('En custodia por garantía: 1 unidad')).toBeNull();
    expect(screen.queryByText(/sigue esperando al cliente/)).toBeNull();
  });

  it('keeps the release of a unit destined for the client stated as it was (S13, S14)', async () => {
    // A release that does not close the case: this unit leaves custody for the counter, not for the shelf.
    const releasedToClient = { ...resolvedCase(),
      events: [...phasesToResolved(), noticeEvent(), releaseEvent('resolved')] };
    const h = harness(url => {
      if (url === '/api/warranty-cases') return tray([row({ id: 2, case_number: 'C-2-000002', phase: 'resolved' })]);
      if (url === '/api/warranty-cases/2') return json(releasedToClient);
      if (url === '/api/sales/12') return json(saleBody);
      return undefined;
    });
    renderScreen(h);
    fireEvent.click(await screen.findByRole('button', { name: 'Ver el caso C-2-000002' }));
    await screen.findByRole('heading', { name: 'Marta Giménez' });
    expect(screen.queryByText('En custodia por garantía: 1 unidad')).toBeNull();
    expect(screen.getByText(
      'El Almacén liberó la unidad a stock vendible: ya no está en custodia y el caso sigue esperando al cliente.'))
      .toBeInTheDocument();
  });

  it('states the refusal of a delivery whose unit belongs to stock in the contract words (S31)', async () => {
    const h = harness((url, init) => {
      if (url === '/api/warranty-cases') return tray([row({ id: 2, case_number: 'C-2-000002', phase: 'resolved' })]);
      if (url === '/api/warranty-cases/2') return json(resolvedCase());
      if (url === '/api/sales/12') return json(saleBody);
      if (url === '/api/warranty-cases/2/delivery' && init.method === 'POST') {
        return failure('unit_belongs_to_stock', 409);
      }
      return undefined;
    });
    renderScreen(h);
    fireEvent.click(await screen.findByRole('button', { name: 'Ver el caso C-2-000002' }));
    fireEvent.change(await screen.findByLabelText('Qué pasó con la usada'), { target: { value: 'kept_by_customer' } });
    fireEvent.change(screen.getByLabelText('Palabras del mostrador'), { target: { value: 'Se la quedó el cliente' } });
    fireEvent.click(screen.getByRole('button', { name: 'Entregar canje' }));
    // The refusal is the contract's own code, with its Spanish message, never a transport error.
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('La unidad de este caso va al stock vendible: sale por la liberación que autoriza el Almacén, no por la entrega. No se registró nada.');
    expect(alert).not.toHaveTextContent('La respuesta del servidor no es válida');
    // Nothing was closed and the attempt stays readable: the screen does not claim the delivery happened.
    expect(screen.queryByText(/Canje entregado/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Entregar canje' })).toBeEnabled();
    expect(h.posts()).toHaveLength(1);
  });
});

describe('the fate of a lent battery is registered by the fact that happened (S33)', () => {
  // The four facts the counter can state, each one its own act and its own fate.
  const loanFacts = [
    ['La usada falló', 'failed'],
    ['El cliente la devolvió', 'returned'],
    ['El cliente se la quedó', 'kept_by_customer'],
    ['Se perdió', 'lost'],
  ] as const;
  const undecided = 'Desenlace: sin decidir · se pide al cerrar el caso';
  const confirmation = () => screen.findByRole('group', { name: 'Confirmar el desenlace del préstamo 1' });
  const openCase = (loans: readonly unknown[]) => harness((url, init) => {
    if (url === '/api/warranty-cases') return tray([row({ id: 2, case_number: 'C-2-000002', phase: 'resolved' })]);
    if (url === '/api/warranty-cases/2') return json({ ...resolvedCase(), loans });
    if (url === '/api/sales/12') return json(saleBody);
    if (url === '/api/warranty-cases/2/loans/1/fate' && init.method === 'POST') {
      return json(loan({ fate: 'failed', fate_decided_at: '2026-03-20T13:00:00Z' }));
    }
    return undefined;
  });

  it('states each open loan as undecided and offers the four facts, never a dropdown (S33)', async () => {
    const h = openCase([loan()]);
    renderScreen(h);
    fireEvent.click(await screen.findByRole('button', { name: 'Ver el caso C-2-000002' }));
    // The state line says what the stage is: the answer is not owed at the counter, it is asked on closing.
    expect(await screen.findByText(undecided)).toBeInTheDocument();
    // There is no field to leave empty and no button waiting behind a placeholder.
    expect(screen.queryByRole('combobox', { name: /Préstamo 1/ })).toBeNull();
    expect(screen.queryByText('Elegí el desenlace')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Registrar desenlace' })).toBeNull();
    for (const [fact] of loanFacts) expect(screen.getByRole('button', { name: fact })).toBeEnabled();
    expect(h.posts()).toHaveLength(0);
  });

  it('asks for confirmation before writing and sends nothing when the counter cancels (S33)', async () => {
    const h = openCase([loan()]);
    renderScreen(h);
    fireEvent.click(await screen.findByRole('button', { name: 'Ver el caso C-2-000002' }));
    fireEvent.click(await screen.findByRole('button', { name: 'La usada falló' }));
    // The confirmation says the decision is final: a decided fate is never rewritten (LW012).
    const asked = await confirmation();
    expect(asked).toHaveTextContent('La usada falló: el desenlace es definitivo y no se puede editar.');
    expect(h.posts()).toHaveLength(0);
    // Cancelling writes nothing and gives the four facts back.
    fireEvent.click(within(asked).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Confirmar el desenlace del préstamo 1' })).toBeNull());
    expect(screen.getByText(undecided)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'La usada falló' })).toBeEnabled();
    // Forcing the panel to submit changes nothing either: the fate is only written by its own fact.
    expect(h.posts()).toHaveLength(0);
  });

  it.each(loanFacts)('registers the fact %s as the fate %s once confirmed (S33)', async (fact, fate) => {
    const settled = loan({ fate, fate_decided_at: '2026-03-20T13:00:00Z' });
    const h = harness((url, init) => {
      if (url === '/api/warranty-cases') return tray([row({ id: 2, case_number: 'C-2-000002', phase: 'resolved' })]);
      if (url === '/api/warranty-cases/2') return json(resolvedCase());
      if (url === '/api/sales/12') return json(saleBody);
      if (url === '/api/warranty-cases/2/loans/1/fate' && init.method === 'POST') return json(settled);
      return undefined;
    });
    renderScreen(h);
    fireEvent.click(await screen.findByRole('button', { name: 'Ver el caso C-2-000002' }));
    fireEvent.click(await screen.findByRole('button', { name: fact }));
    const asked = await confirmation();
    expect(h.posts()).toHaveLength(0);
    fireEvent.click(within(asked).getByRole('button', { name: 'Sí, registrar el desenlace' }));
    await screen.findByText(/Préstamo 1 de C-2-000002/);
    const posts = h.posts();
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe('/api/warranty-cases/2/loans/1/fate');
    expect((posts[0].init.headers as Record<string, string>)['X-CSRF-Token']).toBe(csrf);
    expect(JSON.parse(String(posts[0].init.body))).toEqual({ fate });
    // The fate is stated on the loan and no longer offered as an act.
    await waitFor(() => expect(screen.queryByRole('button', { name: fact })).toBeNull());
    expect(screen.queryByText(undecided)).toBeNull();
  });

  it('keeps the decided fate of a loan and offers no action to rewrite it (S33)', async () => {
    const decided = loan({ fate: 'returned', fate_decided_at: '2026-03-10T12:00:00Z' });
    const h = openCase([decided]);
    renderScreen(h);
    fireEvent.click(await screen.findByRole('button', { name: 'Ver el caso C-2-000002' }));
    // The loan states what became of it, and nothing offers to state it again.
    expect(await screen.findByText('Devuelta al canjear')).toBeInTheDocument();
    expect(screen.queryByText(undecided)).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Desenlace de la usada' })).toBeNull();
    for (const [fact] of loanFacts) expect(screen.queryByRole('button', { name: fact })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Registrar desenlace' })).toBeNull();
    expect(h.posts()).toHaveLength(0);
  });
});

describe('the branch actions follow their dependency (S34)', () => {
  it('lists the loan before the departure it unblocks (S34)', async () => {
    const h = harness(url => {
      if (url === '/api/warranty-cases') return tray([row()]);
      if (url === '/api/warranty-cases/1') return json(receivedCase({ loans: [loan()] }));
      if (url === '/api/sales/12') return json(saleBody);
      return undefined;
    });
    renderScreen(h);
    fireEvent.click(await screen.findByRole('button', { name: 'Ver el caso C-2-000001' }));
    await screen.findByRole('heading', { name: 'Marta Giménez' });
    const titles = screen.getAllByRole('heading', { level: 4 }).map(node => node.textContent);
    // What is missing comes first; the departure it unblocks comes after.
    expect(titles).toContain('Prestar otra usada');
    expect(titles.indexOf('Prestar otra usada')).toBeLessThan(titles.indexOf('Sale de la sucursal'));
    expect(h.posts()).toHaveLength(0);
  });

  it('names a departure refused for the missing loan in the contract words (S4)', async () => {
    const h = harness((url, init) => {
      if (url === '/api/warranty-cases') return tray([row()]);
      if (url === '/api/warranty-cases/1') return json(receivedCase({ loans: [loan()] }));
      if (url === '/api/sales/12') return json(saleBody);
      if (url === '/api/warranty-cases/1/advance' && init.method === 'POST') return failure('loan_required', 409);
      return undefined;
    });
    renderScreen(h);
    fireEvent.click(await screen.findByRole('button', { name: 'Ver el caso C-2-000001' }));
    await screen.findByRole('heading', { name: 'Marta Giménez' });
    fireEvent.change(screen.getByLabelText('Motivo del envío'), { target: { value: 'Sale al Almacén' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar al Almacén' }));
    // The refusal is the contract's own code, with the sentence the closed map publishes for it, never
    // a transport error: the operator reads that the client has no used battery in hand yet.
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'Un reclamo no sale de la sucursal sin que el cliente tenga una usada en la mano: registrá el préstamo. No se registró nada.');
    expect(alert).not.toHaveTextContent('La respuesta del servidor no es válida');
    // The refused tramo wrote nothing, and the departure still says what it was asked to send.
    expect(h.posts()).toHaveLength(1);
    expect(JSON.parse(String(h.posts()[0].init.body)))
      .toEqual({ phase: 'in_transit', factory_case_number: '', note: 'Sale al Almacén' });
  });

  it('keeps every other branch action where it was (S34)', async () => {
    const h = harness(url => {
      if (url === '/api/warranty-cases') return tray([row({ id: 2, case_number: 'C-2-000002', phase: 'resolved' })]);
      if (url === '/api/warranty-cases/2') return json(resolvedCase({ noticed: false }));
      if (url === '/api/sales/12') return json(saleBody);
      return undefined;
    });
    renderScreen(h);
    fireEvent.click(await screen.findByRole('button', { name: 'Ver el caso C-2-000002' }));
    await screen.findByRole('heading', { name: 'Marta Giménez' });
    const titles = screen.getAllByRole('heading', { level: 4 }).map(node => node.textContent);
    // The notice the branch owes and the delivery it closes with keep their order after the loan.
    expect(titles.indexOf('Prestar otra usada')).toBeLessThan(titles.indexOf('Avisar al cliente'));
    expect(titles.indexOf('Avisar al cliente')).toBeLessThan(titles.indexOf('Entregar el canje'));
    expect(h.posts()).toHaveLength(0);
  });

  it('confirms the opened case in a neutral notice, never as an alert (S34)', async () => {
    const h = harness((url, init) => {
      if (url === '/api/warranty-cases') return tray([]);
      if (url === '/api/warranty-cases/claims' && init.method === 'POST') return json(receivedCase(), 201);
      if (url === '/api/sales/12') return json(saleBody);
      return undefined;
    });
    renderScreen(h);
    fireEvent.click(await screen.findByRole('button', { name: 'Registrar canje' }));
    fireEvent.change(screen.getByLabelText('Número de serie de la batería reclamada'), { target: { value: 'ABC123' } });
    fireEvent.change(screen.getByLabelText('Qué falló'), { target: { value: 'No arranca el motor' } });
    fireEvent.click(screen.getByRole('button', { name: 'Buscar la venta y abrir el caso' }));
    const dialog = await screen.findByRole('dialog');
    const notice = await within(dialog).findByText('Caso C-2-000001 abierto por la serie ABC123.');
    // A good news is announced as a status, in the confirmation style, not in the colour of a problem.
    expect(notice).toHaveAttribute('role', 'status');
    expect(notice).toHaveClass('warranty-confirm');
    expect(notice).not.toHaveClass('warranty-problem');
    expect(notice).not.toHaveClass('warranty-dialog-case');
    expect(within(dialog).queryByRole('alert')).toBeNull();
  });
});

describe('registering the exchange from the tray', () => {
  it('opens the claim, shows the sale and its term, registers the loan and offers the receipt (S4, S5, S8)', async () => {
    let opened = false;
    const withLoan = { ...receivedCase(), loans: [loan()] };
    const h = harness((url, init) => {
      if (url === '/api/warranty-cases') return tray(opened ? [row()] : []);
      if (url === '/api/warranty-cases/claims' && init.method === 'POST') {
        opened = true;
        return json(receivedCase(), 201);
      }
      if (url === '/api/sales/12') return json(saleBody);
      if (url === '/api/warranty-cases/1') return json(withLoan);
      if (url === '/api/warranty-cases/1/loans' && init.method === 'POST') {
        return json(loan({ quantity: 2, source_location_id: 3 }), 201);
      }
      return undefined;
    });
    renderScreen(h);
    fireEvent.click(await screen.findByRole('button', { name: 'Registrar canje' }));
    fireEvent.change(screen.getByLabelText('Número de serie de la batería reclamada'), { target: { value: ' ABC123 ' } });
    fireEvent.change(screen.getByLabelText('Qué falló'), { target: { value: 'No arranca el motor' } });
    fireEvent.click(screen.getByRole('button', { name: 'Buscar la venta y abrir el caso' }));
    // The sale and its term are shown before the loan is chosen.
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Marta Giménez')).toBeInTheDocument();
    expect(within(dialog).getByText(/2-000126/)).toBeInTheDocument();
    expect(within(dialog).getByText('12 meses')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('De dónde sale la usada'), { target: { value: '3' } });
    // The list is the one of the chosen origin, and every option is already canonical.
    const models = await within(dialog).findByLabelText('Modelo de la usada');
    expect(within(models).queryByRole('option', { name: /NS40L/ })).toBeNull();
    fireEvent.change(models, { target: { value: 'NS60L' } });
    fireEvent.change(within(dialog).getByLabelText('Cantidad'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Registrar el préstamo' }));
    const [claimPost, loanPost] = h.posts();
    expect(claimPost.url).toBe('/api/warranty-cases/claims');
    expect(JSON.parse(String(claimPost.init.body))).toEqual({ serial_number: 'ABC123', declared_failure: 'No arranca el motor' });
    expect(loanPost.url).toBe('/api/warranty-cases/1/loans');
    expect(JSON.parse(String(loanPost.init.body))).toEqual({
      model: 'NS60L', quantity: 2, serial_number: '', source_location_id: 3,
    });
    expect(await within(dialog).findByText(/el cliente ya tiene su usada/)).toBeInTheDocument();
    const receipt = within(dialog).getByRole('link', { name: /comprobante de préstamo/ });
    expect(receipt).toHaveAttribute('href', '/api/warranty-cases/1/receipt.pdf');
    expect(receipt).toHaveAttribute('download', 'comprobante-C-2-000001.pdf');
  });

  it('states the three refusals of the claim door and writes nothing else (S2)', async () => {
    const h = harness((url, init) => {
      if (url === '/api/warranty-cases') return tray([]);
      if (url === '/api/warranty-cases/claims' && init.method === 'POST') return failure('serial_not_sold', 409);
      return undefined;
    });
    renderScreen(h);
    fireEvent.click(await screen.findByRole('button', { name: 'Registrar canje' }));
    fireEvent.change(screen.getByLabelText('Número de serie de la batería reclamada'), { target: { value: 'NADIE' } });
    fireEvent.change(screen.getByLabelText('Qué falló'), { target: { value: 'No arranca' } });
    fireEvent.click(screen.getByRole('button', { name: 'Buscar la venta y abrir el caso' }));
    expect(await screen.findByRole('alert'))
      .toHaveTextContent('Ese número de serie no figura en ninguna venta');
    // The refusal wrote nothing: one claim attempt and no case behind it.
    expect(h.posts()).toHaveLength(1);
    expect(h.calls.some(call => call.url === '/api/sales/12')).toBe(false);
  });

  it('names a second open claim of the same serial in the contract words (S7)', async () => {
    const h = harness((url, init) => {
      if (url === '/api/warranty-cases') return tray([]);
      if (url === '/api/warranty-cases/claims' && init.method === 'POST') return failure('claim_already_open', 409);
      return undefined;
    });
    renderScreen(h);
    fireEvent.click(await screen.findByRole('button', { name: 'Registrar canje' }));
    fireEvent.change(screen.getByLabelText('Número de serie de la batería reclamada'), { target: { value: 'ABC123' } });
    fireEvent.change(screen.getByLabelText('Qué falló'), { target: { value: 'No arranca el motor' } });
    fireEvent.click(screen.getByRole('button', { name: 'Buscar la venta y abrir el caso' }));
    // The refusal is the contract's own code, with the sentence the closed map publishes for it, never
    // a transport error: the operator reads that the serial carries one open claim at a time.
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'Ese número de serie ya tiene un reclamo abierto: un serial lleva un reclamo a la vez. No se registró nada.');
    expect(alert).not.toHaveTextContent('La respuesta del servidor no es válida');
    // The refused claim wrote nothing: one attempt, and no second case confirmed behind it.
    expect(h.posts()).toHaveLength(1);
    expect(screen.queryByText(/Caso C-2-000001 abierto/)).toBeNull();
  });

  it('offers no model at all when the chosen origin holds no used battery, and never a typed one (S30)', async () => {
    // A fourth branch of the session: it never bought, received or got back a used battery of any model.
    const branches = [...locations, { id: 4, name: 'Sucursal C' }];
    const h = harness((url, init) => {
      if (url === '/api/warranty-cases') return tray([]);
      if (url === '/api/warranty-cases/claims' && init.method === 'POST') return json(receivedCase(), 201);
      if (url === '/api/sales/12') return json(saleBody);
      return undefined;
    });
    render(<WarrantyCases csrf={csrf} branch="Sucursal A" locations={branches} fetcher={h.fetcher} now={frozenNow} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Registrar canje' }));
    fireEvent.change(screen.getByLabelText('Número de serie de la batería reclamada'), { target: { value: 'ABC123' } });
    fireEvent.change(screen.getByLabelText('Qué falló'), { target: { value: 'No arranca el motor' } });
    fireEvent.click(screen.getByRole('button', { name: 'Buscar la venta y abrir el caso' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('12 meses');
    // The model is never typed: the case's own branch offers the models it holds, and nothing else.
    const models = await within(dialog).findByLabelText('Modelo de la usada');
    expect(models.tagName).toBe('SELECT');
    expect(within(dialog).queryByRole('textbox', { name: 'Modelo de la usada' })).toBeNull();
    expect(within(models).getAllByRole('option').map(option => option.textContent))
      .toEqual(['Elegí el modelo', 'NS40L · 1 unidad', 'NS60L · 3 unidades']);
    fireEvent.change(models, { target: { value: 'NS60L' } });
    expect(within(dialog).getByRole('button', { name: 'Registrar el préstamo' })).toBeEnabled();
    // An origin that holds no used battery of any model offers no model at all, says so by name and
    // forgets the model the other origin had chosen.
    fireEvent.change(within(dialog).getByLabelText('De dónde sale la usada'), { target: { value: '4' } });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Sucursal C no tiene usadas de ningún modelo');
    // No model field at all, not even a label pointing at one that is not there.
    expect(within(dialog).queryByText('Modelo de la usada')).toBeNull();
    expect(within(dialog).queryByLabelText('Modelo de la usada')).toBeNull();
    expect(within(dialog).queryByRole('combobox', { name: 'Modelo de la usada' })).toBeNull();
    expect(within(dialog).queryByRole('textbox', { name: 'Modelo de la usada' })).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Registrar el préstamo' })).toBeDisabled();
    // Nothing is posted: not by the button, and not by forcing the form to submit without a model.
    expect(h.posts()).toHaveLength(1);
    fireEvent.submit(within(dialog).getByRole('button', { name: 'Registrar el préstamo' }).closest('form')!);
    expect(h.posts()).toHaveLength(1);
    expect(h.calls.some(call => call.url === '/api/warranty-cases/1/loans')).toBe(false);
  });
});

describe('the accessible shape of the screen', () => {
  it('keeps the keyboard inside the dialog and gives it back to the control that opened it', async () => {
    const h = harness(url => {
      if (url === '/api/warranty-cases') return tray([]);
      return undefined;
    });
    renderScreen(h);
    const trigger = await screen.findByRole('button', { name: 'Registrar canje' });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole('dialog');
    // The dialog states its own name and lands the focus on its first field.
    expect(dialog).toHaveAccessibleName('Registrar canje');
    expect(screen.getByLabelText('Número de serie de la batería reclamada')).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });
  it('announces the phase filter as a pressed group, never by colour alone', async () => {
    const h = harness(url => {
      if (url === '/api/warranty-cases') return tray([]);
      return undefined;
    });
    renderScreen(h);
    const group = await screen.findByRole('group', { name: 'Filtrar casos por etapa del viaje' });
    expect(within(group).getByRole('button', { name: 'Todas las etapas' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(group).getByRole('button', { name: 'En fábrica' }));
    expect(within(group).getByRole('button', { name: 'En fábrica' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(group).getByRole('button', { name: 'Todas las etapas' })).toHaveAttribute('aria-pressed', 'false');
  });
});

/** Registers one finding of `quantity` units on the shelf and hands back the screen's harness (S34). */
async function registerFinding(quantity: string) {
  const writtenOff = Number(quantity);
  const findingRow = row({ id: 5, case_number: 'C-2-000005', origin: 'stock_defect', variant_id: 4,
    serial_number: null, quantity: writtenOff, reason: 'Probada en mostrador', declared_failure: 'No retiene carga' });
  const finding = { ...findingRow, verdict: null, reported_destination: null, loan_destination: null,
    stock_destination: null, sale_id: null, warranty_number: null, created_by_account_id: 2, loans: [], events: [] };
  const h = harness((url, init) => {
    if (url === '/api/warranty-cases') return tray([findingRow]);
    if (url === '/api/warranty-cases/5') return json(finding);
    if (url.startsWith('/api/sales/sellable?')) {
      return json({ page: 1, page_size: 50, total_variants: 1, items: [{
        variant_id: 4, catalog_entry_id: 4, brand: 'Moura', model: '12N5L', capacity_ah: '5', polarity: 'L',
        sellable: true, suggested_price: '45000.00', min_price: '40000.00',
        existing: 6, reserved: 0, available: 6,
      }] });
    }
    if (url === '/api/warranty-cases/stock-defects' && init.method === 'POST') return json(finding, 201);
    return undefined;
  });
  renderScreen(h);
  fireEvent.click(await screen.findByRole('button', { name: 'Hallazgo en góndola' }));
  const select = await screen.findByLabelText('Batería que falló');
  await waitFor(() => expect(within(select).getByRole('option', { name: /Moura/ })).toBeInTheDocument());
  fireEvent.change(select, { target: { value: '4' } });
  fireEvent.change(screen.getByLabelText('Cantidad de unidades'), { target: { value: quantity } });
  fireEvent.change(screen.getByLabelText('Qué falló'), { target: { value: 'No retiene carga' } });
  fireEvent.change(screen.getByLabelText('Motivo de la baja de stock'), { target: { value: 'Probada en mostrador' } });
  fireEvent.click(screen.getByRole('button', { name: 'Registrar el hallazgo' }));
  return h;
}

describe('the battery the branch found failed on its own shelf', () => {
  it('says one unit was written off when the finding is a single battery (S34)', async () => {
    await registerFinding('1');
    expect(await screen.findByText('Hallazgo C-2-000005 registrado: 1 unidad dada de baja de la góndola.'))
      .toBeInTheDocument();
  });

  it('says several units were written off when the finding takes more than one battery (S34)', async () => {
    await registerFinding('2');
    expect(await screen.findByText('Hallazgo C-2-000005 registrado: 2 unidades dadas de baja de la góndola.'))
      .toBeInTheDocument();
  });

  it('registers the finding with its motive and deselects nothing of the tray (S16)', async () => {
    const findingRow = row({ id: 5, case_number: 'C-2-000005', origin: 'stock_defect', variant_id: 4,
      serial_number: null, quantity: 2, reason: 'Probada en mostrador', declared_failure: 'No retiene carga' });
    const finding = { ...findingRow, verdict: null, reported_destination: null, loan_destination: null,
      stock_destination: null, sale_id: null, warranty_number: null, created_by_account_id: 2, loans: [], events: [] };
    let created = false;
    const h = harness((url, init) => {
      if (url === '/api/warranty-cases') return tray(created ? [findingRow] : []);
      if (url === '/api/warranty-cases/5') return json(finding);
      if (url.startsWith('/api/sales/sellable?')) {
        return json({ page: 1, page_size: 50, total_variants: 1, items: [{
          variant_id: 4, catalog_entry_id: 4, brand: 'Moura', model: '12N5L', capacity_ah: '5', polarity: 'L',
          sellable: true, suggested_price: '45000.00', min_price: '40000.00',
          existing: 6, reserved: 0, available: 6,
        }] });
      }
      if (url === '/api/warranty-cases/stock-defects' && init.method === 'POST') {
        created = true;
        return json(finding, 201);
      }
      return undefined;
    });
    renderScreen(h);
    fireEvent.click(await screen.findByRole('button', { name: 'Hallazgo en góndola' }));
    const select = await screen.findByLabelText('Batería que falló');
    await waitFor(() => expect(within(select).getByRole('option', { name: /Moura/ })).toBeInTheDocument());
    fireEvent.change(select, { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('Cantidad de unidades'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Qué falló'), { target: { value: 'No retiene carga' } });
    fireEvent.change(screen.getByLabelText('Motivo de la baja de stock'), { target: { value: 'Probada en mostrador' } });
    fireEvent.click(screen.getByRole('button', { name: 'Registrar el hallazgo' }));
    await screen.findByText(/Hallazgo C-2-000005 registrado/);
    const post = h.posts().at(-1)!;
    expect(post.url).toBe('/api/warranty-cases/stock-defects');
    expect(JSON.parse(String(post.init.body))).toEqual({
      variant_id: 4, quantity: 2, declared_failure: 'No retiene carga', reason: 'Probada en mostrador',
    });
    // The new case is in the tray and the tray was read again after the write.
    expect(await screen.findByRole('button', { name: 'Ver el caso C-2-000005' })).toBeInTheDocument();
  });

  it('says the branch cannot give more units than it has, and shows no case opened (S16)', async () => {
    const h = harness((url, init) => {
      if (url === '/api/warranty-cases') return tray([]);
      if (url.startsWith('/api/sales/sellable?')) {
        return json({ page: 1, page_size: 50, total_variants: 1, items: [{
          variant_id: 4, catalog_entry_id: 4, brand: 'Moura', model: '12N5L', capacity_ah: '5', polarity: 'L',
          sellable: true, suggested_price: '45000.00', min_price: '40000.00',
          existing: 1, reserved: 0, available: 1,
        }] });
      }
      if (url === '/api/warranty-cases/stock-defects' && init.method === 'POST') return failure('no_stock', 409);
      return undefined;
    });
    renderScreen(h);
    fireEvent.click(await screen.findByRole('button', { name: 'Hallazgo en góndola' }));
    const select = await screen.findByLabelText('Batería que falló');
    await waitFor(() => expect(within(select).getByRole('option', { name: /Moura/ })).toBeInTheDocument());
    fireEvent.change(select, { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('Cantidad de unidades'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Qué falló'), { target: { value: 'No retiene carga' } });
    fireEvent.change(screen.getByLabelText('Motivo de la baja de stock'), { target: { value: 'Probada' } });
    fireEvent.click(screen.getByRole('button', { name: 'Registrar el hallazgo' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('La sucursal no tiene esa cantidad de baterías');
  });
});

describe('the branch tray on the warranty invalidation', () => {
  it('re-reads the tray and the open case when the other side writes, without a reload', async () => {
    let moved = false;
    const h = harness(url => {
      if (url === '/api/warranty-cases') {
        return tray([row({ phase: moved ? 'in_transit' : 'received' })]);
      }
      if (url === '/api/warranty-cases/1') {
        return json(receivedCase(moved ? {
          phase: 'in_transit',
          events: [event({ ordinal: 1, phase: 'received' }), event({ ordinal: 2, phase: 'in_transit' })],
        } : {}));
      }
      if (url === '/api/sales/12') return json(saleBody);
      return undefined;
    });
    renderScreen(h);
    const table = await screen.findByRole('table');
    expect(within(table).getByText('En la sucursal')).toBeInTheDocument();
    fireEvent.click(within(table).getByRole('button', { name: 'Ver el caso C-2-000001' }));
    await screen.findByRole('heading', { name: 'Marta Giménez' });
    const reads = () => h.calls.filter(call => call.url === '/api/warranty-cases').length;
    const before = reads();
    moved = true;
    act(() => notifyWarrantyInvalidation());
    await waitFor(() => expect(reads()).toBe(before + 1));
    await waitFor(() => expect(within(screen.getByRole('table')).getByText('En viaje')).toBeInTheDocument());
    // The open case is read again as well: the detail is not left stating the phase the tray lost.
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Marta Giménez' })).toBeInTheDocument());
    expect(h.posts()).toHaveLength(0);
  });
});
