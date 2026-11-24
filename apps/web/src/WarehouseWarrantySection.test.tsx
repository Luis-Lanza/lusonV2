import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import WarehouseWarrantySection from './WarehouseWarrantySection';

const csrf = 'c'.repeat(43);
const locations = [{ id: 1, name: 'Almacén' }, { id: 2, name: 'Sucursal A' }];
const json = (value: unknown) => new Response(JSON.stringify(value),
  { status: 200, headers: { 'Content-Type': 'application/json' } });

function harness(screen_: 'desk' | 'used-stock') {
  const calls: string[] = [];
  const onScreen = vi.fn();
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url === '/api/warranty-cases/used-stock') return json({ stock: [] });
    return json({ cases: [] });
  });
  render(<WarehouseWarrantySection screen={screen_} onScreen={onScreen} csrf={csrf} locations={locations}
    fetcher={fetch as unknown as typeof globalThis.fetch} now={() => new Date('2026-03-20T12:00:00Z')} />);
  return { calls, onScreen };
}

describe('the two screens of the warehouse side', () => {
  it('opens on the factory desk and offers the used stock beside it', async () => {
    const { onScreen } = harness('desk');
    const tabs = await screen.findByRole('group', { name: 'Pantallas de garantías del Almacén' });
    const desk = within(tabs).getByRole('button', { name: 'Mesa de fábrica' });
    const stock = within(tabs).getByRole('button', { name: 'Stock de usadas' });
    expect(desk).toHaveAttribute('aria-pressed', 'true');
    expect(stock).toHaveAttribute('aria-pressed', 'false');
    await screen.findByRole('heading', { name: 'Mesa de fábrica' });
    fireEvent.click(stock);
    expect(onScreen).toHaveBeenCalledWith('used-stock');
  });

  it('shows the used stock as its own screen, with the desk out of the page', async () => {
    harness('used-stock');
    await screen.findByRole('heading', { name: 'Stock de usadas' });
    expect(screen.queryByRole('heading', { name: 'Mesa de fábrica' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Figuras de la mesa por etapa' })).not.toBeInTheDocument();
    const tabs = await screen.findByRole('group', { name: 'Pantallas de garantías del Almacén' });
    expect(within(tabs).getByRole('button', { name: 'Stock de usadas' }))
      .toHaveAttribute('aria-pressed', 'true');
  });

  it('keeps the desk reading its own four questions when it is the screen on page', async () => {
    const { calls } = harness('desk');
    await screen.findByRole('heading', { name: 'Mesa de fábrica' });
    await waitFor(() => expect(calls).toHaveLength(4));
    expect(calls.sort()).toEqual([
      '/api/warranty-cases?phase=at_factory', '/api/warranty-cases?phase=at_warehouse',
      '/api/warranty-cases?phase=in_transit', '/api/warranty-cases?phase=resolved',
    ]);
  });
});
