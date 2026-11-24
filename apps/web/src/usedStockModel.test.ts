import { describe, expect, it } from 'vitest';
import {
  parseUsedStock, usedStockAt, usedStockLoansOf, usedStockTotals, usedStockUnits,
} from './usedStockModel';

// One row per location and model, every number a canonical decimal string, exactly as the contract
// publishes the derived stock of used batteries (`apps/api/docs/warranty-cases.md`).
const row = (over: Record<string, unknown> = {}) => ({
  location_id: 2, model: 'NS60ZL', purchased: '12', factory_returns: '0', loans_returned: '1',
  delivered: '10', loans_given: '1', available: '2', ...over,
});
// The warehouse receives what a branch's closed settlement delivered, so the same units are an
// inflow on its row and an outflow on the branch's.
const warehouseRow = (over: Record<string, unknown> = {}) => row({
  location_id: 1, model: 'NS60ZL', purchased: '0', factory_returns: '2', loans_returned: '0',
  delivered: '3', loans_given: '0', available: '5', ...over,
});
const reply = (...rows: Record<string, unknown>[]) => JSON.stringify({ stock: rows });

describe('the derived stock of used batteries', () => {
  it('reads one row per location and model with its five terms and their signed sum', () => {
    const [branch] = parseUsedStock(reply(row()));
    expect(branch).toEqual({
      location_id: 2, model: 'NS60ZL', purchased: 12, factory_returns: 0, loans_returned: 1,
      delivered: 10, loans_given: 1, available: 2,
    });
    const [warehouse] = parseUsedStock(reply(warehouseRow()));
    // The delivery is the branch's outflow and the warehouse's inflow: zero bought, five available.
    expect(warehouse.available).toBe(5);
    expect(warehouse.delivered).toBe(3);
    expect(parseUsedStock(reply())).toEqual([]);
  });

  it('publishes a negative position as it is, because it is a sum and never a clamp', () => {
    const [short] = parseUsedStock(reply(row({ purchased: '0', delivered: '0', loans_returned: '0',
      loans_given: '3', available: '-3' })));
    expect(short.available).toBe(-3);
  });

  it('refuses a reply that is not the contract shape', () => {
    const refused = [
      // An unknown key, a missing key and a row that is not an object.
      reply({ ...row(), extra: '1' }),
      reply({ ...row(), available: undefined }),
      JSON.stringify({ stock: [1] }),
      // A number instead of a decimal string, and a decimal that is not canonical.
      reply(row({ purchased: 12 })),
      reply(row({ purchased: '012' })),
      reply(row({ purchased: '12.5' })),
      reply(row({ loans_given: '-1' })),
      reply(row({ available: '-0' })),
      reply(row({ available: '4' })),
      // A location outside the installation and a model that is not the canonical key.
      reply(row({ location_id: 0 })),
      reply(row({ location_id: 1.5 })),
      reply(row({ model: 'ns60zl' })),
      reply(row({ model: ' NS60ZL ' })),
      // Two rows of one key, and a list that is not ordered as the contract publishes it.
      reply(row(), row()),
      reply(row({ location_id: 3 }), row()),
      reply(row({ model: 'NS40ZL' }), row({ model: 'NS60ZL' }), row()),
      // The envelope itself.
      JSON.stringify({ stock: [], cases: [] }),
      JSON.stringify([]),
      'not json',
    ];
    for (const raw of refused) expect(() => parseUsedStock(raw), raw).toThrow();
  });

  it('reads the rows of one location and the loan terms of one model', () => {
    const rows = parseUsedStock(reply(warehouseRow(), row()));
    expect(usedStockAt(rows, 2)).toEqual([rows[1]]);
    expect(usedStockAt(rows, 3)).toEqual([]);
    // A model no document moved has no row, so it has no loan term either: nothing is invented.
    expect(usedStockLoansOf(rows, 2, 'NS60ZL')).toEqual({ given: 1, returned: 1 });
    expect(usedStockLoansOf(rows, 2, 'NS40ZL')).toEqual({ given: 0, returned: 0 });
    expect(usedStockLoansOf(rows, 3, 'NS60ZL')).toEqual({ given: 0, returned: 0 });
  });

  it('sums the rows of a location without inventing a zero for a model nobody moved', () => {
    const rows = parseUsedStock(reply(warehouseRow(), row({ model: 'NS40ZL', purchased: '1',
      delivered: '0', loans_returned: '0', loans_given: '0', available: '1' }), row()));
    expect(usedStockTotals(usedStockAt(rows, 2))).toEqual({
      purchased: 13, factory_returns: 0, loans_returned: 1, delivered: 10, loans_given: 1, available: 3,
    });
    expect(usedStockTotals([])).toEqual({
      purchased: 0, factory_returns: 0, loans_returned: 0, delivered: 0, loans_given: 0, available: 0,
    });
    expect(usedStockUnits(1)).toBe('1 unidad');
    expect(usedStockUnits(0)).toBe('0 unidades');
  });
});
