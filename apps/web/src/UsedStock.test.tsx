import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import UsedStock from './UsedStock';
import { notifyWarrantyInvalidation } from './useInventory';

const locations = [{ id: 1, name: 'Almacén' }, { id: 2, name: 'Sucursal A' }, { id: 3, name: 'Sucursal B' }];
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value),
  { status, headers: { 'Content-Type': 'application/json' } });
const row = (over: Record<string, unknown> = {}) => ({
  location_id: 1, model: 'NS60ZL', purchased: '0', factory_returns: '2', loans_returned: '0',
  delivered: '3', loans_given: '1', available: '4', ...over,
});
const stock = (...rows: Record<string, unknown>[]) => json({ stock: rows });

function harness(...replies: (() => Response)[]) {
  const calls: string[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const reply = replies.shift() ?? (() => stock());
    return reply();
  });
  render(<UsedStock locations={locations} fetcher={fetch as unknown as typeof globalThis.fetch} />);
  return { calls, fetch };
}

describe('the warehouse view of the used batteries', () => {
  it('publishes the five facts of the warehouse and their sum, per model', async () => {
    harness(() => stock(row({ model: 'NS40ZL', factory_returns: '1', delivered: '0',
      loans_given: '0', available: '1' }), row()));    const panel = await screen.findByRole('region', { name: 'Stock del Almacén' });
    const table = within(panel).getByRole('table');
    const first = (await within(table).findByText('NS60ZL')).closest('tr')!;
    // What the branches delivered, what the factory returned, what went out and what came back.
    expect(within(first).getByText('3')).toBeInTheDocument();
    expect(within(first).getByText('2')).toBeInTheDocument();
    expect(within(first).getByText('1')).toBeInTheDocument();
    // The row is the derived stock and never a stored balance.
    expect(within(panel).getByText('4')).toBeInTheDocument();
    expect(within(panel).getByText(/2 modelos · 5 unidades/)).toBeInTheDocument();
  });

  it('says the number is derived, that nothing is stored and that it is not sellable stock', async () => {
    harness(() => stock(row()));
    const notice = await screen.findByText(/stock derivado/i);
    const block = notice.closest('div')!;
    expect(block).toHaveTextContent(/no hay ningún saldo guardado/i);
    expect(block).toHaveTextContent(/no puede quedar desfasado/i);
    // Never presented as sellable stock: the used battery is not in the catalogue nor the counter.
    expect(block).toHaveTextContent(/no es stock vendible/i);
    expect(block).toHaveTextContent(/el punto de venta no puede venderla/i);
  });

  it('shows where a used battery is and invents no row for a model nobody moved', async () => {
    harness(() => stock(row(), row({ location_id: 2, model: 'NS60ZL', purchased: '4',
      factory_returns: '0', delivered: '2', loans_given: '1', loans_returned: '1', available: '2' })));
    const everywhere = await screen.findByRole('region', { name: 'Dónde está la usada' });
    const table = within(everywhere).getByRole('table');
    const branch = (await within(table).findByText('Sucursal A')).closest('tr')!;
    expect(within(branch).getByText('NS60ZL')).toBeInTheDocument();
    expect(within(branch).getByText('2')).toBeInTheDocument();
    // A model no document states is not a zero: it has no row at all.
    expect(within(table).queryByText('NS40ZL')).not.toBeInTheDocument();
  });

  it('refreshes the stock on the warranty invalidation, without a reload', async () => {
    const { calls } = harness(() => stock(row()), () => stock(row({ loans_given: '0', available: '5' })));
    const panel = await screen.findByRole('region', { name: 'Stock del Almacén' });
    const line = async () => (await within(panel).findByText('NS60ZL')).closest('tr') as HTMLElement;
    expect(within(await line()).getByText('4')).toBeInTheDocument();
    act(() => notifyWarrantyInvalidation());
    // A loan takes a unit out: the screen reads again instead of keeping the number it showed.
    await waitFor(async () => expect(within(await line()).getByText('5')).toBeInTheDocument());
    expect(calls).toEqual(['/api/warranty-cases/used-stock', '/api/warranty-cases/used-stock']);
  });

  it('reports a refusal and reads again when the operator retries', async () => {
    harness(() => json({ error: 'service_unavailable' }, 503), () => stock(row()));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/no se pudo consultar el stock de usadas/i);
    fireEvent.click(within(alert).getByRole('button', { name: 'Reintentar stock' }));
    const panel = await screen.findByRole('region', { name: 'Stock del Almacén' });
    expect(await within(panel).findByText('NS60ZL')).toBeInTheDocument();
  });

  it('states the empty stock in words instead of an invented zero', async () => {
    harness(() => stock());
    expect(await screen.findByText(/no tiene ninguna usada registrada/i)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
