import { test as setup } from '@playwright/test';
import { branchA, sessionFor, warehouseRole } from './warranty/harness';

/**
 * The floor every group assumes: a battery the branch can really sell.
 *
 * The warranty, sales, closing and adjustment groups all start from "the branch has a battery on the
 * shelf" and then really sell, count and settle it. That is the point of the suite, but it also means
 * the stock is consumed: after enough runs the priced batteries reach zero and twenty-two specs fail
 * with "la sucursal no tiene stock de ninguna batería para vender" — the suite stops proving anything
 * about the product and starts reporting the state of one database.
 *
 * Two things make this subtle, and both were learned the hard way:
 *
 *  - "In stock" is not "sellable": a variant needs a price in its own branch to be sold
 *    (`apps/api/internal/sales/sales.go`), and the catalogue lists unpriced variants too, with
 *    `sellable: false`. Topping up an unpriced variant leaves the counter exactly as empty.
 *  - The consumers read the **first page** of ten (`warranty/harness.ts:171`), so the variant this
 *    setup guarantees has to be on that page. A variant with plenty of stock forty rows down is
 *    invisible to them.
 *
 * So the floor is stated on a row of the page the specs actually read, through the same public acts
 * the two roles would use — the Almacén fixes the price, the branch counts its own stock — and it is
 * idempotent: when a sellable row on that page already holds the floor, nothing is written, so a
 * second run in a row leaves the drawer, the ledger and the balances where the first left them.
 */
const FLOOR = 40;
const PAGE = '/api/sales/sellable?kind=battery&page=1&page_size=10';

interface SellableRow {
  readonly variant_id: number;
  readonly catalog_entry_id: number;
  readonly suggested_price: string | null;
  readonly existing: number;
  readonly available: number;
}

async function page(session: Awaited<ReturnType<typeof sessionFor>>): Promise<readonly SellableRow[]> {
  const reply = await session.request.get(PAGE);
  if (reply.status() !== 200) {
    throw new Error(`GET ${PAGE} respondió ${reply.status()}: ${await reply.text()}`);
  }
  return ((await reply.json()) as { items: readonly SellableRow[] }).items;
}

setup('la sucursal tiene una batería vendible', async ({ playwright }) => {
  const branch = await sessionFor(playwright.request, branchA);
  const rows = await page(branch);
  const priced = (row: SellableRow) => row.suggested_price !== null && row.suggested_price !== undefined;
  if (rows.some(row => priced(row) && row.existing >= FLOOR)) return;

  const target = rows.find(priced) ?? rows[0];
  if (target === undefined) {
    throw new Error('la góndola de la sucursal no publica ninguna batería, así que no hay qué abastecer');
  }
  if (!priced(target)) {
    const warehouse = await sessionFor(playwright.request, warehouseRole);
    const prices = await warehouse.request.put('/api/catalog/prices', {
      headers: { 'X-CSRF-Token': warehouse.csrf },
      data: {
        catalog_entry_id: target.catalog_entry_id, min_price: '85000', suggested_price: '96000',
        branch_ids: [branchA.locationId],
      },
    });
    if (prices.status() !== 200) {
      throw new Error(`PUT /api/catalog/prices respondió ${prices.status()}: ${await prices.text()}`);
    }
  }

  const counted = await branch.request.post('/api/stock-adjustments', {
    headers: { 'X-CSRF-Token': branch.csrf },
    data: {
      operation_key: `abastecer-${crypto.randomUUID()}`,
      reason: 'Abastecer la góndola para la suite de punta a punta',
      detail: `Piso de ${FLOOR} unidades por corrida`,
      lines: [{ variant_id: target.variant_id, counted_quantity: FLOOR }],
    },
  });
  if (counted.status() !== 201) {
    throw new Error(`POST /api/stock-adjustments respondió ${counted.status()}: ${await counted.text()}`);
  }

  // The floor is only stated when the counter can see it: price without stock, stock without a price,
  // or stock on a row the specs never read all leave the suite exactly as broken as before.
  const after = await page(branch);
  if (!after.some(row => row.variant_id === target.variant_id && priced(row) && row.existing >= FLOOR)) {
    throw new Error(`la góndola no publica la variante ${target.variant_id} con ${FLOOR} unidades después del ajuste`);
  }
});
