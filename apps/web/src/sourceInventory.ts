import { initialQuery, parseInventory, queryURL, validSearch, type Item, type Location } from './model';
import { validTransferLocation, type TransferLocationID } from './transferModel';

export interface SourceCatalog {
  readonly location: Readonly<Location>;
  readonly rows: readonly Readonly<Item>[];
}
export interface SourceInventoryOptions { signal?: AbortSignal; reason?: 'manual' | 'passive' }
export class SourceInventoryError extends Error {
  constructor(public readonly code: 'invalid_source' | 'unauthenticated' | 'unavailable' | 'malformed' | 'canceled', public readonly status: number | null = null) {
    super(code);
    this.name = 'SourceInventoryError';
  }
}

// Complete catalog membership, NOT a transaction-wide quantity snapshot.
export async function loadSourceInventory(source: TransferLocationID, options: SourceInventoryOptions = {}, fetcher: typeof globalThis.fetch = globalThis.fetch): Promise<SourceCatalog> {
  if (!validTransferLocation(source)) throw new SourceInventoryError('invalid_source');
  const signal = options.signal;
  const passive = options.reason === 'passive';
  const checkCanceled = () => { if (signal?.aborted) throw new SourceInventoryError('canceled'); };
  const rows: Readonly<Item>[] = [];
  const seen = new Set<number>();
  let location: Readonly<Location> | undefined;
  let total: number | undefined;
  for (let page = 1; page <= 4; page++) {
    checkCanceled();
    let reply: Response;
    try {
      reply = await fetcher(queryURL({ ...initialQuery(source), page, size: 50 }), {
        method: 'GET', credentials: 'same-origin', cache: 'no-store', signal,
        headers: passive ? { 'X-Luson-Passive': '1' } : {},
      });
    } catch (error) {
      const aborted = signal?.aborted || (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError');
      throw new SourceInventoryError(aborted ? 'canceled' : 'unavailable');
    }
    checkCanceled();
    // Never consume or expose private error bodies, including proxy HTML.
    if (reply.status !== 200) throw new SourceInventoryError(reply.status === 401 ? 'unauthenticated' : 'unavailable', reply.status);
    const malformed = () => new SourceInventoryError('malformed', reply.status);
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(reply.headers.get('Content-Type') ?? '')) throw malformed();
    let raw: string;
    try { raw = await reply.text(); } catch { checkCanceled(); throw new SourceInventoryError('unavailable', reply.status); }
    checkCanceled();
    let data;
    try { data = parseInventory(raw); } catch { throw malformed(); }
    if (data.location.id !== source || data.page !== page || data.page_size !== 50
      || (total !== undefined && data.total_variants !== total)
      || (location && data.location.name !== location.name)) throw malformed();
    total = data.total_variants;
    location ??= Object.freeze({ ...data.location });
    const expected = Math.min(50, Math.max(0, total - (page - 1) * 50));
    if (data.items.length !== expected) throw malformed();
    for (const item of data.items) {
      if (seen.has(item.variant_id) || (rows.length > 0 && item.variant_id <= rows[rows.length - 1].variant_id)
        || item.available !== item.existing - item.reserved) throw malformed();
      seen.add(item.variant_id);
      rows.push(Object.freeze({ ...item }));
    }
    if (rows.length === total) {
      checkCanceled();
      return Object.freeze({ location, rows: Object.freeze(rows) });
    }
  }
  throw new SourceInventoryError('malformed');
}

export function filterSourceInventory(catalog: SourceCatalog, filter: { search?: string; brand?: string; polarity?: '' | 'L' | 'R' }): readonly Readonly<Item>[] {
  const search = filter.search ?? '';
  const brand = filter.brand ?? '';
  const polarity = filter.polarity ?? '';
  if (!validSearch(search) || !validSearch(brand) || !['', 'L', 'R'].includes(polarity)) throw new Error('Invalid source filter');
  const literal = search.toLowerCase();
  return Object.freeze(catalog.rows.filter(row => (!brand || row.brand === brand) && (!polarity || row.polarity === polarity)
    && (!literal || row.brand.toLowerCase().includes(literal) || row.model.toLowerCase().includes(literal))));
}
