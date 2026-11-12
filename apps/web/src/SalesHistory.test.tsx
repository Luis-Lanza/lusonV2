import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import SalesHistory from './SalesHistory';
import { salesHistoryUnavailable } from './salesAPI';

const json = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'application/json' } });

const summary = (overrides: Record<string, unknown> = {}) => ({
  id: 2, branch_sequence: 126, warranty_number: '2-000126', payment_method: 'mixed',
  customer_name: 'Marta Giménez', total: '96000.00', created_at: '2026-11-04T17:42:00Z', lines: 1,
  units_total: 3, units_with_warranty: 2, ...overrides,
});
const pageBody = (sales: readonly unknown[] = [summary(), summary({
  id: 1, branch_sequence: 125, warranty_number: '2-000125', payment_method: 'cash',
  customer_name: 'Ramón Ibarra', total: '214000.00', created_at: '2026-11-04T16:10:00Z', lines: 2,
  units_total: 2, units_with_warranty: 0,
})], overrides: Record<string, unknown> = {}) => JSON.stringify({
  page: 1, page_size: 10, total_sales: 87, sales, ...overrides,
});
const detailBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  id: 2, branch_sequence: 126, warranty_number: '2-000126', payment_method: 'cash',
  payments: [{ method: 'cash', amount: '320000.00' }],
  customer_name: 'Marta Giménez',
  customer: { name: 'Marta Giménez', phone: '381 555 0198', document: '27.884.310', address: 'Av. América 123' },
  total: '320000.00', created_at: '2026-11-04T17:42:00Z',
  lines: [
    {
      variant_id: 1, catalog_entry_id: 1, brand: 'CAR', model: 'NS40ZL', capacity_ah: '35', polarity: 'L',
      quantity: 1, unit_price: '96000.00', min_price: '85000.00', subtotal: '96000.00',
      units: [{ serial_number: 'ABC123', warranty_months: 12 }],
    },
    {
      variant_id: 3, catalog_entry_id: 3, brand: 'TOYO', model: 'NS60L', capacity_ah: '45', polarity: 'R',
      quantity: 2, unit_price: '112000.00', min_price: '100000.00', subtotal: '224000.00',
      units: [{ serial_number: 'TOYO-9', warranty_months: null }, { serial_number: 'TOYO-10', warranty_months: 24 }],
    },
  ],
  ...overrides,
});

function harness(options: { page?: () => Response | Promise<Response>; detail?: () => Response | Promise<Response> } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (/^\/api\/sales\/[1-9]\d*$/.test(url)) return options.detail?.() ?? json(detailBody());
    if (url.startsWith('/api/sales?')) return options.page?.() ?? json(pageBody());
    throw new Error('Unexpected mocked URL: ' + url);
  });
  return { fetcher, calls,
    reads: () => calls.filter(call => call.url.startsWith('/api/sales?')),
    details: () => calls.filter(call => /^\/api\/sales\/[1-9]\d*$/.test(call.url)) };
}
const rowOf = (sequence: number) => screen.getByText(`#${sequence}`).closest('tr')!;
async function ready(h: ReturnType<typeof harness>) {
  render(<SalesHistory branch="Sucursal A" fetcher={h.fetcher} />);
  await screen.findByRole('table');
}

describe('the sales history', () => {
  it('lists one row per sale with its number, its client, its label and both actions', async () => {
    const h = harness();
    await ready(h);
    const row = rowOf(126);
    expect(within(row).getByText('2-000126')).toBeInTheDocument();
    expect(within(row).getByText(/04\/11\/2026/)).toBeInTheDocument();
    expect(within(row).getByText('Marta Giménez')).toBeInTheDocument();
    expect(within(row).getByText('Mixto')).toBeInTheDocument();
    expect(within(row).getByText('1')).toBeInTheDocument();
    expect(within(row).getByText('Bs 96.000,00')).toBeInTheDocument();
    // The list states the warranty position without unfolding the document (S5).
    expect(within(row).getByText('2 de 3 con garantía')).toBeInTheDocument();
    expect(within(rowOf(125)).getByText('Sin garantía')).toBeInTheDocument();
    // Ver y PDF, both from the same row.
    expect(within(row).getByRole('button', { name: 'Ver la venta 126' })).toBeEnabled();
    const pdf = within(row).getByRole('link', { name: 'Descargar la garantía 2-000126' });
    expect(pdf).toHaveAttribute('href', '/api/sales/2/warranty.pdf');
    expect(pdf).toHaveTextContent('PDF');
    expect(within(rowOf(125)).getByText('Efectivo')).toBeInTheDocument();
    expect(screen.getByText(/87 ventas/)).toBeInTheDocument();
    expect(h.reads()[0].url).toBe('/api/sales?page=1&page_size=10');
    expect(h.reads()[0].init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store' });
  });

  it('unfolds the document under its own row when Ver is used', async () => {
    const h = harness();
    await ready(h);
    fireEvent.click(screen.getByRole('button', { name: 'Ver la venta 126' }));
    const detail = await screen.findByRole('region', { name: 'Venta 126' });
    expect(within(detail).getByText('CAR NS40ZL')).toBeInTheDocument();
    expect(within(detail).getByText('35 Ah · L')).toBeInTheDocument();
    expect(within(detail).getByText('1 × Bs 96.000,00')).toBeInTheDocument();
    // Every physical battery is named with its serial and its term or its absence.
    expect(within(detail).getByText('ABC123')).toBeInTheDocument();
    expect(within(detail).getByText('12 meses')).toBeInTheDocument();
    expect(within(detail).getByText('TOYO-9')).toBeInTheDocument();
    expect(within(detail).getByText('TOYO-10')).toBeInTheDocument();
    expect(within(detail).getByText('24 meses')).toBeInTheDocument();
    expect(within(detail).getByText('Sin garantía')).toBeInTheDocument();
    expect(within(detail).getByText('Efectivo')).toBeInTheDocument();
    expect(within(detail).getAllByText('Bs 320.000,00').length).toBeGreaterThanOrEqual(2);
    // The unit price, the subtotal and the total all read the frozen amount.
    expect(within(detail).getAllByText('Bs 96.000,00').length).toBeGreaterThanOrEqual(2);
    expect(within(detail).getByText(/381 555 0198 · 27.884.310/)).toBeInTheDocument();
    // The address the seller wrote is part of the document.
    expect(within(detail).getByText(/Av\. América 123/)).toBeInTheDocument();
    expect(h.details().map(call => call.url)).toEqual(['/api/sales/2']);
    // The row keeps working while its document is unfolded.
    expect(within(rowOf(126)).getByRole('link', { name: 'Descargar la garantía 2-000126' }))
      .toHaveAttribute('href', '/api/sales/2/warranty.pdf');
    fireEvent.click(screen.getByRole('button', { name: 'Ver la venta 126' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Venta 126' })).not.toBeInTheDocument());
  });

  it('shows no address line for a sale registered without one', async () => {
    const h = harness({ detail: () => json(detailBody({ customer: { name: 'Marta Giménez', phone: '', document: '',
      address: '' } })) });
    await ready(h);
    fireEvent.click(screen.getByRole('button', { name: 'Ver la venta 126' }));
    const detail = await screen.findByRole('region', { name: 'Venta 126' });
    expect(within(detail).getByText(/Marta Giménez/)).toBeInTheDocument();
    expect(within(detail).queryByText(/Av\. América 123/)).not.toBeInTheDocument();
  });

  it('names a sale issued before per-unit series as having no recorded series', async () => {
    // T12/S7: the sale was stored before the counter registered the series and the term of
    // each battery, so nothing was ever recorded for it. Calling it "Sin garantía" would
    // claim an absent warranty that was never stated; the list and the detail name the
    // document instead.
    const staggered = {
      id: 2, branch_sequence: 126, warranty_number: '2-000126', payment_method: 'cash',
      customer_name: 'Marta Giménez', total: '320000.00', created_at: '2026-11-04T17:42:00Z', lines: 2,
      units_total: 0, units_with_warranty: 0,
    };
    const h = harness({
      page: () => json(pageBody([staggered])),
      detail: () => json(detailBody({ total: '320000.00', lines: [
        { variant_id: 1, catalog_entry_id: 1, brand: 'CAR', model: 'NS40ZL', capacity_ah: '35',
          polarity: 'L', quantity: 1, unit_price: '96000.00', min_price: '85000.00',
          subtotal: '96000.00', units: [] },
        { variant_id: 3, catalog_entry_id: 3, brand: 'TOYO', model: 'NS60L', capacity_ah: '45',
          polarity: 'R', quantity: 2, unit_price: '112000.00', min_price: '100000.00',
          subtotal: '224000.00', units: [] },
      ] })),
    });
    await ready(h);
    const row = rowOf(126);
    expect(within(row).getByText('Sin series registradas')).toBeInTheDocument();
    expect(within(row).queryByText('Sin garantía')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Ver la venta 126' }));
    const detail = await screen.findByRole('region', { name: 'Venta 126' });
    expect(within(detail).getByText(/Venta emitida antes de que el punto de venta registrara la serie y la garantía de cada batería/)).toBeInTheDocument();
    expect(within(detail).queryByText('Sin garantía')).not.toBeInTheDocument();
    // Its lines and its frozen prices are still the document's own.
    expect(within(detail).getByText('CAR NS40ZL')).toBeInTheDocument();
    expect(within(detail).getByText('2 × Bs 112.000,00')).toBeInTheDocument();
  });

  it('states when every battery of the sale carries a warranty', async () => {
    const h = harness({ page: () => json(pageBody([summary({ units_total: 2, units_with_warranty: 2 })])) });
    await ready(h);
    expect(within(rowOf(126)).getByText('2 con garantía')).toBeInTheDocument();
  });

  it('filters by search and by payment method, including Mixto', async () => {
    const h = harness();
    await ready(h);
    fireEvent.change(screen.getByLabelText('Buscar venta'), { target: { value: '2-00012' } });
    await waitFor(() => expect(h.reads().at(-1)?.url).toBe('/api/sales?search=2-00012&page=1&page_size=10'));
    fireEvent.change(screen.getByLabelText('Forma de pago'), { target: { value: 'mixed' } });
    await waitFor(() => expect(h.reads().at(-1)?.url)
      .toBe('/api/sales?search=2-00012&payment_method=mixed&page=1&page_size=10'));
    const options = within(screen.getByLabelText('Forma de pago')).getAllByRole('option').map(option => option.textContent);
    expect(options).toEqual(['Todas', 'Efectivo', 'Transferencia', 'Tarjeta', 'QR', 'Mixto']);
  });

  // S13: a sale collected by QR reads like the others, and the filter admits it.
  it('shows a QR payment like the others and filters by it', async () => {
    const h = harness({
      page: () => json(pageBody([summary({ payment_method: 'qr' })])),
      detail: () => json(detailBody({
        payment_method: 'mixed',
        payments: [{ method: 'cash', amount: '100000.00' }, { method: 'qr', amount: '220000.00' }],
      })),
    });
    await ready(h);
    expect(within(rowOf(126)).getByText('QR')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Forma de pago'), { target: { value: 'qr' } });
    await waitFor(() => expect(h.reads().at(-1)?.url).toBe('/api/sales?payment_method=qr&page=1&page_size=10'));
    // The unfolded document names the QR amount beside the cash one.
    fireEvent.click(screen.getByRole('button', { name: 'Ver la venta 126' }));
    const detail = await screen.findByRole('region', { name: 'Venta 126' });
    expect(within(detail).getByText('QR')).toBeInTheDocument();
    expect(within(detail).getByText('Bs 220.000,00')).toBeInTheDocument();
  });

  it('paginates the branch history', async () => {
    const h = harness();
    await ready(h);
    expect(screen.getByRole('button', { name: 'Página anterior' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Página siguiente' }));
    await waitFor(() => expect(h.reads().at(-1)?.url).toBe('/api/sales?page=2&page_size=10'));
  });

  it('states what could not be loaded when the history fails, and retries', async () => {
    let failing = true;
    const h = harness({ page: () => failing ? json('{"error":"service_unavailable"}', 503) : json(pageBody()) });
    render(<SalesHistory branch="Sucursal A" fetcher={h.fetcher} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(salesHistoryUnavailable);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    failing = false;
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar historial' }));
    await screen.findByRole('table');
    expect(h.reads()).toHaveLength(2);
  });

  it('says so when the branch has no sale for this query', async () => {
    const h = harness({ page: () => json(pageBody([], { total_sales: 0 })) });
    render(<SalesHistory branch="Sucursal A" fetcher={h.fetcher} />);
    expect(await screen.findByText('Sin ventas para esta consulta.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
