import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import TransferActivity from './TransferActivity';
import type { TransferRecord } from './transferModel';

afterEach(cleanup);
it('T10 displays Spanish actions, snapshot names, locations and times with escaped fallback', () => {
  const activity = [
    { category: 'transfer', action: 'create', actor: { account_id: '20', username: 'ana', display_name: '<Ana>' }, location_id: 2, location_name: 'Sucursal A', recorded_at: '2026-04-02T12:34:56Z' },
    { category: 'count', action: 'accept', actor: { account_id: '21', username: '<peer>', display_name: '' }, location_id: 1, location_name: 'Almacén', recorded_at: '2026-04-02T12:35:56Z', variant_id: 1 },
  ] as unknown as NonNullable<TransferRecord['activity']>;
  const { container } = render(<TransferActivity activity={activity} />);
  expect(screen.getByRole('region', { name: 'Autoría personal' })).toBeTruthy();
  expect(screen.getByText('Transferencia creada')).toBeTruthy();
  expect(screen.getByText('Corrección de conteo aceptada')).toBeTruthy();
  expect(screen.getByText('<Ana>')).toBeTruthy();
  expect(screen.getByText('<peer>')).toBeTruthy();
  expect(container.querySelector('ana')).toBeNull();
  expect(container.querySelectorAll('time[datetime]')).toHaveLength(2);
  expect(container.textContent).toContain('Sucursal A');
  expect(container.textContent).toContain('Almacén');
});
it('T10 never invents a personal author for legacy history', () => {
  render(<TransferActivity />);
  expect(screen.getByText('Sin autor personal registrado; la responsabilidad histórica corresponde a la ubicación.')).toBeTruthy();
  expect(screen.queryByRole('list')).toBeNull();
});
