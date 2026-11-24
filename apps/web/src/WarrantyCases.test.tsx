import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import WarrantyCases from './WarrantyCases';

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
    const fate = await screen.findByLabelText('Préstamo 1 · NS60L · 1 unidad');
    // Nothing is stated by accident: the fate starts unanswered and its button waits for it.
    expect(screen.getByRole('button', { name: 'Registrar desenlace' })).toBeDisabled();
    fireEvent.change(fate, { target: { value: 'failed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Registrar desenlace' }));
    await screen.findByText(/Préstamo 1 de C-2-000002: falló/);
    expect(h.posts()[0].url).toBe('/api/warranty-cases/2/loans/1/fate');
    expect(JSON.parse(String(h.posts()[0].init.body))).toEqual({ fate: 'failed' });
    expect(await screen.findByText('Falló')).toBeInTheDocument();
    // The case is still one case: the failed battery is replaced by another loan of the same case.
    fireEvent.click(screen.getByRole('button', { name: 'Registrar préstamo' }));
    fireEvent.change(screen.getByLabelText('Modelo de la usada'), { target: { value: 'NS40L' } });
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

  it('delivers the exchange only when the used battery is registered, and settles the loan (S4)', async () => {
    let withLoan = false;
    let delivered = false;
    const closed = { phase: 'closed', loans: [loan({ fate: 'kept_by_customer', fate_decided_at: '2026-03-20T13:00:00Z' })],
      events: [...phasesToResolved(), event({ ordinal: 6, phase: 'closed', recorded_at: '2026-03-20T13:00:00Z' })] };
    const h = harness((url, init) => {
      if (url === '/api/warranty-cases') return tray([row({ id: 2, case_number: 'C-2-000002', phase: 'resolved' })]);
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
    expect(enabled).toBeEnabled();
    fireEvent.change(screen.getByLabelText('Qué pasó con la usada'), { target: { value: 'kept_by_customer' } });
    fireEvent.change(screen.getByLabelText('Palabras del mostrador'), { target: { value: 'Se la quedó el cliente' } });
    fireEvent.click(enabled);
    await screen.findByText(/Canje entregado en C-2-000002/);
    const post = h.posts().at(-1)!;
    expect(post.url).toBe('/api/warranty-cases/2/delivery');
    expect(JSON.parse(String(post.init.body))).toEqual({ loan_fate: 'kept_by_customer', note: 'Se la quedó el cliente' });
    // The closed case is stated in the pane and in its own tray row.
    await waitFor(() => expect(screen.getAllByText('Entregada').length).toBeGreaterThan(0));
    expect(screen.queryByRole('button', { name: 'Entregar canje' })).not.toBeInTheDocument();
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
    fireEvent.change(within(dialog).getByLabelText('Modelo de la usada'), { target: { value: 'ns60l' } });
    fireEvent.change(within(dialog).getByLabelText('Cantidad'), { target: { value: '2' } });
    fireEvent.change(within(dialog).getByLabelText('De dónde sale la usada'), { target: { value: '3' } });
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

describe('the battery the branch found failed on its own shelf', () => {
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
