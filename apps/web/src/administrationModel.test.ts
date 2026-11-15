import { describe, expect, it } from 'vitest';
import { commissionInput, commissionText, parseCommissions } from './administrationModel';

const listed = JSON.stringify([
  { branch_location_id: 2, commission_rate_percent: '4.50', updated_at: '2026-11-15T04:48:56Z', updated_by: 'Almacén' },
  { branch_location_id: 3, commission_rate_percent: '100.00', updated_at: '2026-11-15T04:49:00Z', updated_by: '' },
]);

describe('the configured commissions of the panel', () => {
  it('reads every configured branch in branch order, with its author and the way it is shown', () => {
    const items = parseCommissions(listed);
    expect(items).toEqual([
      { branch_id: 2, rate: '4.50', updated_at: '2026-11-15T04:48:56Z', updated_by: 'Almacén' },
      { branch_id: 3, rate: '100.00', updated_at: '2026-11-15T04:49:00Z', updated_by: '' },
    ]);
    expect(commissionText(items[0].rate)).toBe('4,50 %');
  });

  it('accepts an installation with nothing configured and refuses anything it could not have produced', () => {
    expect(parseCommissions('[]')).toEqual([]);
    for (const refused of [
      // A rate is canonical or it is not this server's answer.
      JSON.stringify([{ branch_location_id: 2, commission_rate_percent: '4.5', updated_at: '2026-11-15T04:48:56Z', updated_by: 'Almacén' }]),
      JSON.stringify([{ branch_location_id: 2, commission_rate_percent: '100.01', updated_at: '2026-11-15T04:48:56Z', updated_by: 'Almacén' }]),
      // The author and the moment are the point of the shape.
      JSON.stringify([{ branch_location_id: 2, commission_rate_percent: '4.50', updated_at: 'ayer', updated_by: 'Almacén' }]),
      // A branch the warehouse never settles cannot carry a configured rate.
      JSON.stringify([{ branch_location_id: 1, commission_rate_percent: '4.50', updated_at: '2026-11-15T04:48:56Z', updated_by: 'Almacén' }]),
      // Extra keys, unsorted branches and a payload that is not a list.
      JSON.stringify([{ branch_location_id: 2, commission_rate_percent: '4.50', updated_at: '2026-11-15T04:48:56Z', updated_by: 'Almacén', extra: 1 }]),
      JSON.stringify([
        { branch_location_id: 3, commission_rate_percent: '4.50', updated_at: '2026-11-15T04:48:56Z', updated_by: 'Almacén' },
        { branch_location_id: 2, commission_rate_percent: '4.50', updated_at: '2026-11-15T04:48:56Z', updated_by: 'Almacén' },
      ]),
      JSON.stringify({ branch_location_id: 2 }),
      'no es json',
    ]) {
      expect(() => parseCommissions(refused), refused).toThrow('Respuesta inválida del servidor.');
    }
  });

  it('turns what the operator types into the canonical rate, and refuses what the server would', () => {
    expect(commissionInput('4')).toBe('4.00');
    expect(commissionInput('4,5')).toBe('4.50');
    expect(commissionInput(' 4.50 ')).toBe('4.50');
    expect(commissionInput('0')).toBe('0.00');
    expect(commissionInput('100')).toBe('100.00');
    for (const refused of ['', '   ', '4,505', '100.01', '101', '-1', '4%', 'cuatro', '0004']) {
      expect(commissionInput(refused), refused).toBeNull();
    }
  });
});
