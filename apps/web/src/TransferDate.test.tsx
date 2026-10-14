import { render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import TransferDate from './TransferDate';

afterEach(() => vi.restoreAllMocks());

it.each([
  ['2028-01-01T00:00:00.123456789Z', '31/12/2027 · 20:00 (hora Bolivia)'],
  ['2028-02-29T04:05:59Z', '29/02/2028 · 00:05 (hora Bolivia)'],
  ['2028-01-01T02:30:00+02:00', '31/12/2027 · 20:30 (hora Bolivia)'],
  ['2028-01-01T20:30:00-04:00', '01/01/2028 · 20:30 (hora Bolivia)'],
  ['2000-01-01T03:59:59.999999999Z', '31/12/1999 · 23:59 (hora Bolivia)'],
])('presents %s in Bolivia while retaining exact evidence', (value, expected) => {
  const { container } = render(<TransferDate value={value} />);
  const time = container.querySelector('time');
  expect(time).toHaveTextContent(expected);
  expect(time?.textContent).toBe(expected);
  expect(time).toHaveAttribute('datetime', value);
  expect(time).toHaveAttribute('title', value);
});

it.each([null, undefined, '', 'garbage', '2028-01-01', '2028-01-01T00:00:00',
  '2028-02-30T00:00:00Z', '2027-02-29T00:00:00Z', '2028-13-01T00:00:00Z',
  '2028-01-01T24:00:00Z', '2028-01-01T00:00:60Z'])('does not fabricate a date for %j', value => {
  const { container } = render(<TransferDate value={value} />);
  expect(screen.getByText('Fecha no disponible')).toBeVisible();
  expect(container.querySelector('time')).toBeNull();
  if (value) expect(screen.getByText('Fecha no disponible')).toHaveAttribute('title', value);
});

it.each(['UTC', 'Asia/Tokyo', 'America/Los_Angeles'])(
  'ignores the device formatter default %s and uses a 24-hour clock', deviceZone => {
    const OriginalFormatter = Intl.DateTimeFormat;
    const formatter = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (locale, options) {
      return new OriginalFormatter(locale, { timeZone: deviceZone, ...options });
    });
    render(<TransferDate value="2028-01-01T04:00:00Z" />);
    expect(screen.getByText('01/01/2028 · 00:00 (hora Bolivia)')).toBeVisible();
    expect(formatter).toHaveBeenCalledWith('es-BO', expect.objectContaining({
      timeZone: 'America/La_Paz', hourCycle: 'h23',
    }));
  });
