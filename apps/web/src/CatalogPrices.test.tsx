import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import CatalogPrices from './CatalogPrices';
import {
  catalogPriceBranchMessage, catalogPriceOrderMessage, catalogPricesErrorMessages, catalogPricesListUnavailable,
} from './catalogPricesModel';

const csrf = 'c'.repeat(43);
const json = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
const branches = [{ id: 2, name: 'Sucursal A' }, { id: 3, name: 'Sucursal B' }, { id: 4, name: 'Sucursal C' }];
const priceOf = (branch: number, min: string, suggested: string, updatedAt = '2026-11-04T10:00:00Z') => ({
  branch_location_id: branch, min_price: min, suggested_price: suggested, updated_at: updatedAt,
  updated_by_account_id: 1, updated_by_display_name: 'Almacén',
});
const variantOf = (overrides: Record<string, unknown> = {}) => ({
  variant_id: 1, catalog_entry_id: 1, brand: 'CAR', model: 'NS40ZL', capacity_ah: '35', polarity: 'L',
  cells: ['B5', 'C5', 'D5'], warranty_months: 6, warranty_updated_at: '2026-11-04T10:00:00Z',
  prices: [priceOf(2, '85000.00', '96000.00'), priceOf(3, '88000.00', '99000.00', '2026-11-02T10:00:00Z')], ...overrides,
});
const untimed = {
  variant_id: 3, catalog_entry_id: 3, brand: 'TOYO', model: 'NS60L', capacity_ah: '45', polarity: 'R',
  cells: ['F5'], warranty_months: null, warranty_updated_at: null, prices: [],
};
const pageBody = (variants: readonly unknown[] = [variantOf(), untimed]) => JSON.stringify({
  branches, variants, page: 1, page_size: 10, total_variants: 190,
});
const resultBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  variant_id: 1, written: 2, branch_ids: [2, 3], min_price: '85000.00', suggested_price: '96000.00',
  warranty_months: 6, ...overrides,
});

function harness(options: {
  page?: () => Response | Promise<Response>;
  write?: (body: string) => Response | Promise<Response>;
} = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === '/api/catalog/prices') return options.write?.(String(init.body)) ?? json(resultBody());
    if (url.startsWith('/api/catalog/prices?')) return options.page?.() ?? json(pageBody());
    throw new Error('Unexpected mocked URL: ' + url);
  });
  return { fetcher, calls, reads: () => calls.filter(call => call.url.startsWith('/api/catalog/prices?')),
    writes: () => calls.filter(call => call.url === '/api/catalog/prices') };
}

const pickRow = (label: string) => screen.getAllByRole('row')
  .find(row => row.hasAttribute('aria-controls') && (row.textContent ?? '').startsWith(label))!;
const detailOf = (label: string) => document.getElementById(pickRow(label).getAttribute('aria-controls')!)!;
const openRow = (label: string) => {
  fireEvent.click(pickRow(label));
  return detailOf(label);
};
const amount = (detail: HTMLElement, label: string) => within(detail).getByRole('textbox', { name: label });
async function ready(h: ReturnType<typeof harness>) {
  render(<CatalogPrices csrf={csrf} brands={['CAR', 'TOYO']} fetcher={h.fetcher} />);
  await screen.findByRole('table');
}

describe('catalogue matrix', () => {
  it('lists one row per variant with its product data, its branch chips and its action', async () => {
    const h = harness();
    await ready(h);
    const car = pickRow('CAR NS40ZL');
    expect(within(car).getByText('35 Ah · Polaridad L · 6 meses de garantía')).toBeInTheDocument();
    expect(within(car).getByText('A')).toBeInTheDocument();
    expect(within(car).getByText('B')).toBeInTheDocument();
    expect(within(car).getByText('C sin precio')).toBeInTheDocument();
    expect(within(car).getByText('Desplegar +')).toBeInTheDocument();
    expect(car).toHaveAttribute('aria-expanded', 'false');
    expect(car).toHaveAttribute('tabindex', '0');
    expect(within(car).getByText('Almacén')).toBeInTheDocument();
    expect(within(pickRow('TOYO NS60L')).getByText('45 Ah · Polaridad R · sin plazo de garantía')).toBeInTheDocument();
    expect(h.reads()[0].url).toBe('/api/catalog/prices?page=1&page_size=10');
    expect(h.reads()[0].init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store' });
  });

  it('reports an unavailable matrix and reads it again on demand', async () => {
    let failing = true;
    const h = harness({ page: () => failing ? json('{"error":"service_unavailable"}', 503) : json(pageBody()) });
    render(<CatalogPrices csrf={csrf} brands={['CAR', 'TOYO']} fetcher={h.fetcher} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(catalogPricesListUnavailable);
    failing = false;
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar catálogo' }));
    await screen.findByText('CAR NS40ZL');
    expect(h.reads()).toHaveLength(2);
  });

  it('refilters from the panel and keeps the read contract in the query', async () => {
    const h = harness();
    await ready(h);
    fireEvent.change(screen.getByLabelText('Marca'), { target: { value: 'CAR' } });
    await waitFor(() => expect(h.reads().at(-1)?.url).toBe('/api/catalog/prices?brand=CAR&page=1&page_size=10'));
    fireEvent.change(screen.getByLabelText('Polaridad'), { target: { value: 'R' } });
    await waitFor(() => expect(h.reads().at(-1)?.url).toBe('/api/catalog/prices?brand=CAR&polarity=R&page=1&page_size=10'));
  });
});

describe('catalogue unfolding', () => {
  it('unfolds the detail under the row with aria-expanded and aria-controls', async () => {
    const h = harness();
    await ready(h);
    const car = pickRow('CAR NS40ZL');
    const detail = openRow('CAR NS40ZL');
    expect(car).toHaveAttribute('aria-expanded', 'true');
    expect(car).toHaveAttribute('aria-controls', detail.id);
    expect(detail).not.toHaveAttribute('hidden');
    expect(within(car).getByText('Cerrar −')).toBeInTheDocument();
    expect(within(detail).getByRole('heading', { name: 'Precios de CAR NS40ZL' })).toBeInTheDocument();
    expect(within(detail).getByText('35 Ah · Polaridad L · 3 celdas de origen (B5, C5, D5)')).toBeInTheDocument();
  });

  it.each([['Enter'], [' ']])('unfolds and folds again with the %s key', async key => {
    const h = harness();
    await ready(h);
    const car = pickRow('CAR NS40ZL');
    fireEvent.keyDown(car, { key });
    expect(car).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(car, { key });
    expect(car).toHaveAttribute('aria-expanded', 'false');
    expect(detailOf('CAR NS40ZL')).toHaveAttribute('hidden');
  });

  it('closes the open row when another row is unfolded', async () => {
    const h = harness();
    await ready(h);
    openRow('CAR NS40ZL');
    const toyo = pickRow('TOYO NS60L');
    openRow('TOYO NS60L');
    expect(pickRow('CAR NS40ZL')).toHaveAttribute('aria-expanded', 'false');
    expect(detailOf('CAR NS40ZL')).toHaveAttribute('hidden');
    expect(toyo).toHaveAttribute('aria-expanded', 'true');
    expect(within(detailOf('TOYO NS60L')).getByRole('heading', { name: 'Precios de TOYO NS60L' })).toBeInTheDocument();
  });

  it('closes with Cancelar and returns focus to the row', async () => {
    const h = harness();
    await ready(h);
    const detail = openRow('CAR NS40ZL');
    fireEvent.click(within(detail).getByRole('button', { name: 'Cancelar' }));
    const car = pickRow('CAR NS40ZL');
    expect(car).toHaveAttribute('aria-expanded', 'false');
    expect(detail).toHaveAttribute('hidden');
    expect(car).toHaveFocus();
    expect(h.writes()).toHaveLength(0);
  });
});

describe('catalogue detail form', () => {
  it('shows the pair, the read-only term, the per-branch values and the replaced-prices notice', async () => {
    const h = harness();
    await ready(h);
    const detail = openRow('CAR NS40ZL');
    expect(amount(detail, 'Precio mínimo de venta')).toHaveValue('85000');
    expect(amount(detail, 'Precio sugerido de venta')).toHaveValue('96000');
    const term = within(detail).getByRole('textbox', { name: 'Plazo de garantía de la variante' });
    expect(term).toHaveValue('6 meses');
    expect(term).toHaveAttribute('readonly');
    const a = within(detail).getByRole('checkbox', { name: 'Aplicar a Sucursal A' });
    const b = within(detail).getByRole('checkbox', { name: 'Aplicar a Sucursal B' });
    const c = within(detail).getByRole('checkbox', { name: 'Aplicar a Sucursal C' });
    expect(a).toBeChecked(); expect(b).toBeChecked(); expect(c).not.toBeChecked();
    const optionA = a.closest('label')!; const optionB = b.closest('label')!;
    expect(within(optionA).getByText('mín $ 85.000')).toBeInTheDocument();
    expect(within(optionA).getByText('sug $ 96.000')).toBeInTheDocument();
    expect(within(optionB).getByText('mín $ 88.000')).toBeInTheDocument();
    expect(within(c.closest('label')!).getByText('sin precio')).toBeInTheDocument();
    expect(within(detail).getByText('Se van a reemplazar 2 precios existentes.')).toBeInTheDocument();
    expect(within(detail).getByRole('button', { name: 'Aplicar a 2 sucursales' })).toBeInTheDocument();
  });

  it('follows the checked branches in the notice and the action', async () => {
    const h = harness();
    await ready(h);
    const detail = openRow('CAR NS40ZL');
    fireEvent.click(within(detail).getByRole('checkbox', { name: 'Aplicar a Sucursal B' }));
    fireEvent.click(within(detail).getByRole('checkbox', { name: 'Aplicar a Sucursal C' }));
    expect(within(detail).getByText('Se van a reemplazar 1 precio existente.')).toBeInTheDocument();
    expect(within(detail).getByRole('button', { name: 'Aplicar a 2 sucursales' })).toBeInTheDocument();
    fireEvent.click(within(detail).getByRole('checkbox', { name: 'Aplicar a Sucursal A' }));
    expect(within(detail).getByText('No se reemplaza ningún precio existente.')).toBeInTheDocument();
    expect(within(detail).getByRole('button', { name: 'Aplicar a 1 sucursal' })).toBeInTheDocument();
  });

  it('mirrors the server rules before sending anything', async () => {
    const h = harness();
    await ready(h);
    const detail = openRow('CAR NS40ZL');
    fireEvent.change(amount(detail, 'Precio sugerido de venta'), { target: { value: '80000' } });
    fireEvent.click(within(detail).getByRole('button', { name: /^Aplicar a / }));
    expect(within(detail).getByRole('alert')).toHaveTextContent(catalogPriceOrderMessage);
    expect(h.writes()).toHaveLength(0);
    fireEvent.change(amount(detail, 'Precio sugerido de venta'), { target: { value: '96000.123' } });
    fireEvent.click(within(detail).getByRole('button', { name: /^Aplicar a / }));
    expect(within(detail).getByRole('alert')).toHaveTextContent('hasta dos decimales');
    expect(h.writes()).toHaveLength(0);
    fireEvent.change(amount(detail, 'Precio sugerido de venta'), { target: { value: '96000' } });
    fireEvent.click(within(detail).getByRole('checkbox', { name: 'Aplicar a Sucursal A' }));
    fireEvent.click(within(detail).getByRole('checkbox', { name: 'Aplicar a Sucursal B' }));
    fireEvent.click(within(detail).getByRole('button', { name: 'Aplicar a 0 sucursales' }));
    expect(within(detail).getByRole('alert')).toHaveTextContent(catalogPriceBranchMessage);
    expect(h.writes()).toHaveLength(0);
  });

  it('keeps the typed values and shows the server rejection', async () => {
    const h = harness({ write: () => json('{"error":"invalid_request"}', 400) });
    await ready(h);
    const detail = openRow('CAR NS40ZL');
    fireEvent.change(amount(detail, 'Precio mínimo de venta'), { target: { value: '86000' } });
    fireEvent.click(within(detail).getByRole('checkbox', { name: 'Aplicar a Sucursal C' }));
    fireEvent.click(within(detail).getByRole('button', { name: 'Aplicar a 3 sucursales' }));
    await within(detail).findByRole('alert');
    expect(within(detail).getByRole('alert')).toHaveTextContent(catalogPricesErrorMessages.invalid_request);
    expect(amount(detail, 'Precio mínimo de venta')).toHaveValue('86000');
    expect(within(detail).getByRole('checkbox', { name: 'Aplicar a Sucursal C' })).toBeChecked();
    expect(pickRow('CAR NS40ZL')).toHaveAttribute('aria-expanded', 'true');
    expect(h.writes()).toHaveLength(1);
  });

  it('names a retired branch, drops it from the checklist and keeps the typed amounts', async () => {
    const h = harness({ write: () => json('{"error":"retired_branch","branch_id":3}', 400) });
    await ready(h);
    const detail = openRow('CAR NS40ZL');
    fireEvent.change(amount(detail, 'Precio mínimo de venta'), { target: { value: '86000' } });
    fireEvent.click(within(detail).getByRole('button', { name: 'Aplicar a 2 sucursales' }));
    await within(detail).findByRole('alert');
    expect(within(detail).getByRole('alert'))
      .toHaveTextContent('La sucursal Sucursal B fue retirada: quitala de la lista y volvé a intentar. No se escribió ningún precio.');
    expect(within(detail).getByRole('checkbox', { name: 'Aplicar a Sucursal B' })).not.toBeChecked();
    expect(within(detail).getByRole('checkbox', { name: 'Aplicar a Sucursal A' })).toBeChecked();
    expect(amount(detail, 'Precio mínimo de venta')).toHaveValue('86000');
  });

  it('asks for the term only when the variant has none and sends it with the block', async () => {
    const h = harness({ write: () => json(resultBody({ variant_id: 3, written: 1, branch_ids: [2], warranty_months: 6 })) });
    await ready(h);
    const detail = openRow('TOYO NS60L');
    const term = within(detail).getByRole('textbox', { name: 'Plazo de garantía de la variante' });
    expect(term).not.toHaveAttribute('readonly');
    expect(term).toHaveValue('');
    fireEvent.change(amount(detail, 'Precio mínimo de venta'), { target: { value: '78000' } });
    fireEvent.change(amount(detail, 'Precio sugerido de venta'), { target: { value: '89000' } });
    fireEvent.change(term, { target: { value: '6' } });
    fireEvent.click(within(detail).getByRole('checkbox', { name: 'Aplicar a Sucursal A' }));
    fireEvent.click(within(detail).getByRole('button', { name: 'Aplicar a 1 sucursal' }));
    await waitFor(() => expect(h.writes()).toHaveLength(1));
    expect(JSON.parse(String(h.writes()[0].init.body))).toEqual({
      variant_id: 3, min_price: '78000', suggested_price: '89000', warranty_months: 6, branch_ids: [2],
    });
  });
});

describe('catalogue write outcome', () => {
  it('writes the block, collapses the row, refreshes the chips and reports what was written', async () => {
    let written = false;
    const h = harness({
      page: () => json(pageBody([variantOf(written
        ? { prices: [priceOf(2, '85000.00', '96000.00', '2026-11-05T10:00:00Z'), priceOf(3, '85000.00', '96000.00', '2026-11-05T10:00:00Z'), priceOf(4, '50000.00', '96000.00', '2026-11-05T10:00:00Z')] }
        : {}), untimed])),
      write: () => { written = true; return json(resultBody({ written: 3, branch_ids: [2, 3, 4] })); },
    });
    await ready(h);
    const detail = openRow('CAR NS40ZL');
    fireEvent.change(amount(detail, 'Precio mínimo de venta'), { target: { value: '85000' } });
    fireEvent.click(within(detail).getByRole('checkbox', { name: 'Aplicar a Sucursal C' }));
    fireEvent.click(within(detail).getByRole('button', { name: 'Aplicar a 3 sucursales' }));
    await waitFor(() => expect(h.writes()).toHaveLength(1));
    expect(h.writes()[0].init).toMatchObject({ method: 'PUT', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf } });
    expect(JSON.parse(String(h.writes()[0].init.body))).toEqual({
      variant_id: 1, min_price: '85000', suggested_price: '96000', branch_ids: [2, 3, 4],
    });
    await screen.findByText('Precios aplicados: CAR · NS40ZL · mínimo $ 85.000 · sugerido $ 96.000 en 3 sucursales.');
    expect(pickRow('CAR NS40ZL')).toHaveAttribute('aria-expanded', 'false');
    expect(detailOf('CAR NS40ZL')).toHaveAttribute('hidden');
    await waitFor(() => expect(within(pickRow('CAR NS40ZL')).getByText('C')).toBeInTheDocument());
    expect(within(pickRow('CAR NS40ZL')).queryByText('C sin precio')).not.toBeInTheDocument();
    expect(h.reads().length).toBeGreaterThan(1);
  });
});
