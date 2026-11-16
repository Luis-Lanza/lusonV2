import { describe, expect, it } from 'vitest';
import { amountInput, branchFounding, commissionInput, commissionText, parseCommissions } from './administrationModel';

const listed = JSON.stringify([
  { branch_location_id: 2, commission_rate_percent: '4.50', updated_at: '2026-11-15T04:48:56Z', updated_by: 'Almacén' },
  { branch_location_id: 3, commission_rate_percent: '100.00', updated_at: '2026-11-15T04:49:00Z', updated_by: '' },
]);

describe('the two mandatory amounts of a founding', () => {
  it('turns what the operator types into the canonical amount the server states', () => {
    expect(amountInput('500')).toBe('500.00');
    expect(amountInput('500,5')).toBe('500.50');
    expect(amountInput(' 300.00 ')).toBe('300.00');
    expect(amountInput('0')).toBe('0.00');
    expect(amountInput('0,00')).toBe('0.00');
    expect(amountInput('9999999999.99')).toBe('9999999999.99');
    for (const refused of ['', '   ', '500,005', '-1', '1e3', '0500', '00', '500.000', 'mil', '12345678901.00']) {
      expect(amountInput(refused), refused).toBeNull();
    }
  });

  it('states the name and both amounts as the strict payload the server admits', () => {
    expect(branchFounding('Sucursal Sur', '500', '300,5')).toEqual({ name: 'Sucursal Sur', opening_cash: '500.00', purchase_fund: '300.50' });
    // 0,00 is a stated answer and it is sent as one (S3).
    expect(branchFounding('Sucursal Sur', '0', '0,00')).toEqual({ name: 'Sucursal Sur', opening_cash: '0.00', purchase_fund: '0.00' });
  });

  it('refuses to state a founding the server would not admit, naming what is missing', () => {
    // Both amounts are required (S1): silence is not an answer, and it never is 0,00.
    expect(() => branchFounding('Sucursal Sur', '', '300.00')).toThrow('Ingresá el fondo de caja operativa en bolivianos, con hasta dos decimales.');
    expect(() => branchFounding('Sucursal Sur', '500.00', '')).toThrow('Ingresá el fondo de compras en bolivianos, con hasta dos decimales.');
    expect(() => branchFounding('Sucursal Sur', '', '')).toThrow('Ingresá el fondo de caja operativa');
    expect(() => branchFounding('Sucursal Sur', '500.005', '300.00')).toThrow('Ingresá el fondo de caja operativa');
    expect(() => branchFounding('Sucursal Sur', '500.00', '-300')).toThrow('Ingresá el fondo de compras');
    expect(() => branchFounding(' ', '500.00', '300.00')).toThrow('Ingresá un nombre válido de hasta 128 bytes UTF-8.');
  });
});

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
