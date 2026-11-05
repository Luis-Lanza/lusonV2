import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PointOfSale, {
  SalesSectionBoundary, pointOfSaleFailureMessage, salesHistoryFailureMessage,
} from './PointOfSale';
import { posEmptyCartMessage, posNotSellableReason, posPriceFloorMessage, posMissingMessage } from './pointOfSaleModel';
import { sellableUnavailable } from './salesAPI';

const csrf = 'c'.repeat(43);
const json = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'application/json' } });

const item = (overrides: Record<string, unknown> = {}) => ({
  variant_id: 1, catalog_entry_id: 1, brand: 'CAR', model: 'NS40ZL', capacity_ah: '35', polarity: 'L',
  sellable: true, existing: 12, reserved: 0, available: 12,
  suggested_price: '96000.00', min_price: '85000.00', ...overrides,
});
const unpriced = {
  variant_id: 5, catalog_entry_id: 4, brand: 'HYBRID', model: 'BT54L', capacity_ah: '54', polarity: 'L',
  sellable: false, existing: 4, reserved: 0, available: 4, suggested_price: null, min_price: null,
};
const sellableBody = (items: readonly unknown[] = [item(), unpriced]) => JSON.stringify({
  page: 1, page_size: 10, total_variants: 190, items,
});
const issuedBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  sale: {
    id: 7, branch_location_id: 2, branch_sequence: 126, warranty_number: '2-000126',
    payment_method: 'mixed',
    payments: [{ method: 'cash', amount: '50000.00' }, { method: 'transfer', amount: '46000.00' }],
    customer: { name: 'Marta Giménez', phone: '', document: '' },
    total: '96000.00', created_by_account_id: 2, created_at: '2026-11-04T17:42:00Z',
    lines: [{ variant_id: 1, quantity: 1, unit_price: '96000.00', min_price: '85000.00',
      warranty_months: 12, subtotal: '96000.00' }],
    ...overrides,
  },
});

function harness(options: { page?: () => Response | Promise<Response>; sale?: () => Response | Promise<Response> } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === '/api/sales') return options.sale?.() ?? new Response(issuedBody(), { status: 201, headers: { 'Content-Type': 'application/json' } });
    if (url.startsWith('/api/sales/sellable?')) return options.page?.() ?? json(sellableBody());
    throw new Error('Unexpected mocked URL: ' + url);
  });
  return { fetcher, calls,
    reads: () => calls.filter(call => call.url.startsWith('/api/sales/sellable?')),
    writes: () => calls.filter(call => call.url === '/api/sales') };
}

const cardOf = (title: string) => screen.getByRole('heading', { name: title }).closest('article')!;
const cartLine = (label: string) => screen.getByLabelText(`Cantidad de ${label}`).closest('.pos-line') as HTMLElement;
async function ready(h: ReturnType<typeof harness>) {
  render(<PointOfSale csrf={csrf} branch="Sucursal A" brands={['CAR', 'HYBRID']} fetcher={h.fetcher} />);
  await screen.findByRole('heading', { name: 'CAR NS40ZL' });
}
function addToSale(title: string) {
  fireEvent.click(within(cardOf(title)).getByRole('button', { name: 'Agregar a la venta' }));
}
function nameClient(name = 'Marta Giménez') {
  fireEvent.change(screen.getByLabelText('Cliente'), { target: { value: name } });
}
const charge = () => screen.getByRole('button', { name: 'Cobrar y emitir garantía' });

describe('the counter catalogue', () => {
  it('shows every variant with its price and availability, and blocks the unpriced one', async () => {
    const h = harness();
    await ready(h);
    const car = cardOf('CAR NS40ZL');
    expect(within(car).getByText('35 Ah')).toBeInTheDocument();
    expect(within(car).getByText('L')).toBeInTheDocument();
    expect(within(car).getByText('Bs 96.000,00')).toBeInTheDocument();
    expect(within(car).getByText('12 disp.')).toBeInTheDocument();
    expect(within(car).getByRole('button', { name: 'Agregar a la venta' })).toBeEnabled();

    const hybrid = cardOf('HYBRID BT54L');
    // S7: the row is shown with its action disabled and the reason spelled out, never a price.
    expect(within(hybrid).getByText('Bs —')).toBeInTheDocument();
    expect(within(hybrid).getByText(posNotSellableReason)).toBeInTheDocument();
    expect(within(hybrid).getByText('No vendible')).toBeInTheDocument();
    const blocked = within(hybrid).getByRole('button', { name: 'Agregar a la venta' });
    expect(blocked).toBeDisabled();
    expect(blocked).toHaveAttribute('aria-describedby');
    expect(within(hybrid).getByText('4 disp.')).toBeInTheDocument();
    expect(h.reads()[0].url).toBe('/api/sales/sellable?page=1&page_size=10');
    expect(h.reads()[0].init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store' });
  });

  it('searches and paginates the catalogue with the read contract', async () => {
    const h = harness();
    await ready(h);
    fireEvent.change(screen.getByLabelText('Buscar batería'), { target: { value: 'NS40' } });
    await waitFor(() => expect(h.reads().at(-1)?.url).toBe('/api/sales/sellable?search=NS40&page=1&page_size=10'));
    fireEvent.change(screen.getByLabelText('Polaridad'), { target: { value: 'R' } });
    await waitFor(() => expect(h.reads().at(-1)?.url).toBe('/api/sales/sellable?search=NS40&polarity=R&page=1&page_size=10'));
  });

  it('states what could not be loaded when the catalogue read fails, and retries', async () => {
    let failing = true;
    const h = harness({ page: () => failing ? json('{"error":"service_unavailable"}', 503) : json(sellableBody()) });
    render(<PointOfSale csrf={csrf} branch="Sucursal A" fetcher={h.fetcher} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(sellableUnavailable);
    failing = false;
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar catálogo vendible' }));
    await screen.findByRole('heading', { name: 'CAR NS40ZL' });
    expect(h.reads()).toHaveLength(2);
  });
});

describe('the counter cart', () => {
  it('adds a line from the catalogue and removes it again', async () => {
    const h = harness();
    await ready(h);
    expect(screen.getByText(posEmptyCartMessage)).toBeInTheDocument();
    addToSale('CAR NS40ZL');
    const line = cartLine('CAR NS40ZL L');
    expect(within(line).getByLabelText('Cantidad de CAR NS40ZL L')).toHaveValue('1');
    expect(within(line).getByLabelText('Garantía en meses de CAR NS40ZL L')).toHaveValue('12');
    expect(within(line).getByLabelText('Precio unitario de CAR NS40ZL L')).toHaveValue('96.000,00');
    expect(within(line).getByText(`Mínimo autorizado Bs 85.000,00`)).toBeInTheDocument();
    // One line per variant: adding again bumps the quantity.
    addToSale('CAR NS40ZL');
    expect(screen.getAllByLabelText(/^Cantidad de /)).toHaveLength(1);
    expect(within(cartLine('CAR NS40ZL L')).getByLabelText('Cantidad de CAR NS40ZL L')).toHaveValue('2');
    fireEvent.click(within(cartLine('CAR NS40ZL L')).getByRole('button', { name: 'Quitar CAR NS40ZL L' }));
    expect(screen.queryByLabelText('Cantidad de CAR NS40ZL L')).not.toBeInTheDocument();
    expect(screen.getByText(posEmptyCartMessage)).toBeInTheDocument();
    expect(h.writes()).toHaveLength(0);
  });

  it('never lets the charged price go under the branch minimum', async () => {
    const h = harness();
    await ready(h);
    addToSale('CAR NS40ZL');
    const price = () => within(cartLine('CAR NS40ZL L')).getByLabelText('Precio unitario de CAR NS40ZL L');
    fireEvent.change(price(), { target: { value: '84.000,00' } });
    expect(await screen.findByRole('alert')).toHaveTextContent(posPriceFloorMessage(8_500_000n));
    fireEvent.change(price(), { target: { value: '85.000,00' } });
    await waitFor(() => expect(within(cartLine('CAR NS40ZL L')).getByText('Bs 85.000,00')).toBeInTheDocument());
    nameClient();
    fireEvent.change(screen.getByLabelText('Efectivo'), { target: { value: '85.000,00' } });
    expect(charge()).toBeEnabled();
    expect(h.writes()).toHaveLength(0);
  });
});

describe('the counter settlement', () => {
  it('keeps the charge disabled until the sum closes exactly, and issues the warranty', async () => {
    const h = harness();
    await ready(h);
    addToSale('CAR NS40ZL');
    nameClient();
    expect(charge()).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Efectivo'), { target: { value: '50.000,00' } });
    expect(charge()).toBeDisabled();
    expect(screen.getByText('Faltan Bs 46.000,00 para cubrir el total.')).toBeInTheDocument();
    // The Resto shortcut fills the open amount in the method that has none.
    fireEvent.click(screen.getByRole('button', { name: 'Resto' }));
    expect(screen.getByLabelText('Transferencia')).toHaveValue('46.000,00');
    expect(screen.getByText('Suma Bs 96.000,00 · cubre el total')).toBeInTheDocument();
    expect(charge()).toBeEnabled();

    fireEvent.click(charge());
    const issued = await screen.findByText('Venta #126 · Garantía 2-000126');
    expect(issued).toBeInTheDocument();
    expect(h.writes()).toHaveLength(1);
    expect(h.writes()[0].init).toMatchObject({ method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf } });
    expect(JSON.parse(String(h.writes()[0].init.body))).toEqual({
      payments: [{ method: 'cash', amount: '50000.00' }, { method: 'transfer', amount: '46000.00' }],
      customer: { name: 'Marta Giménez', phone: '', document: '' },
      lines: [{ variant_id: 1, quantity: 1, unit_price: '96000.00', warranty_months: 12 }],
    });
    // The issued sale carries its warranty number and its stable PDF download.
    expect(screen.getByRole('link', { name: 'Descargar PDF' })).toHaveAttribute('href', '/api/sales/7/warranty.pdf');
    expect(screen.getByText(/Mixto: Bs 50.000,00 efectivo \+ Bs 46.000,00 transferencia/)).toBeInTheDocument();
    // A new sale starts from an empty cart.
    expect(screen.getByText(posEmptyCartMessage)).toBeInTheDocument();
  });

  it('surfaces the amount the server says is missing', async () => {
    const h = harness({ sale: () => json('{"error":"payments_mismatch","missing":"15000.00"}', 400) });
    await ready(h);
    addToSale('CAR NS40ZL');
    nameClient();
    fireEvent.change(screen.getByLabelText('Efectivo'), { target: { value: '96.000,00' } });
    fireEvent.click(charge());
    expect(await screen.findByRole('alert')).toHaveTextContent(posMissingMessage(1_500_000n));
    // Nothing is lost: the line and the settlement stay as the seller wrote them.
    expect(cartLine('CAR NS40ZL L')).toBeInTheDocument();
    expect(screen.getByLabelText('Efectivo')).toHaveValue('96.000,00');
    expect(screen.queryByText(/Garantía 2-000126/)).not.toBeInTheDocument();
  });

  it('refuses to charge without a client name, and says why', async () => {
    const h = harness();
    await ready(h);
    addToSale('CAR NS40ZL');
    fireEvent.change(screen.getByLabelText('Efectivo'), { target: { value: '96.000,00' } });
    expect(charge()).toBeDisabled();
    expect(screen.getByText('Escribí el nombre del cliente: la garantía lo exige.')).toBeInTheDocument();
    nameClient();
    expect(charge()).toBeEnabled();
  });
});

describe('the counter section boundary', () => {
  const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {});
  afterEach(() => { vi.restoreAllMocks(); });
  function Boom(): never { throw new Error('el punto de venta arrojó'); }
  const shell = (children: ReactNode) => <div>
    <p>Resto de la aplicación</p>
    <SalesSectionBoundary>{children}</SalesSectionBoundary>
  </div>;

  it('contains a failing section instead of blanking the application', () => {
    quiet();
    expect(() => render(shell(<Boom />))).not.toThrow();
    expect(screen.getByRole('alert')).toHaveTextContent(pointOfSaleFailureMessage);
    expect(screen.getByText('Resto de la aplicación')).toBeInTheDocument();
    expect(screen.queryByText('el punto de venta arrojó')).not.toBeInTheDocument();
  });

  it('names the history screen when the history is what failed', () => {
    quiet();
    render(<div><SalesSectionBoundary message={salesHistoryFailureMessage}><Boom /></SalesSectionBoundary></div>);
    expect(screen.getByRole('alert')).toHaveTextContent(salesHistoryFailureMessage);
  });
});
