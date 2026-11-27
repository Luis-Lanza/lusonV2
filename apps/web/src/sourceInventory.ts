import { initialQuery, parseInventory, queryURL, validSearch, type Item, type Kind, type KindFilter, type Location } from './model';
import { validTransferLocation, type TransferLocationID } from './transferModel';

export interface SourceCatalog {
  readonly location: Readonly<Location>;
  readonly rows: readonly Readonly<Item>[];
}
/**
 * `kind` is the catalogue kind the caller asks for: the origin picker reads the
 * one kind its document carries, an advisory reader may ask for both, and a
 * reader that omits it keeps the battery-only default the endpoint has always
 * answered.
 */
export interface SourceInventoryOptions { signal?: AbortSignal; reason?: 'manual' | 'passive'; kind?: KindFilter }
export class SourceInventoryError extends Error {
  constructor(public readonly code: 'invalid_source' | 'unauthenticated' | 'unavailable' | 'malformed' | 'canceled', public readonly status: number | null = null) {
    super(code);
    this.name = 'SourceInventoryError';
  }
}

/**
 * A lie guard, not a catalog limit. The reader has no page count of its own: it
 * asks for every page the published total covers, however many that is. A total
 * far above any branch's catalog could only be a broken answer, so it is refused
 * after the first page instead of being paged through forever.
 */
const MAX_VARIANTS = 50000;
const PAGE_SIZE = 50;

// Complete catalog membership, NOT a transaction-wide quantity snapshot.
export async function loadSourceInventory(source: TransferLocationID, options: SourceInventoryOptions = {}, fetcher: typeof globalThis.fetch = globalThis.fetch): Promise<SourceCatalog> {
  if (!validTransferLocation(source)) throw new SourceInventoryError('invalid_source');
  const signal = options.signal;
  const passive = options.reason === 'passive';
  const kind = options.kind;
  const checkCanceled = () => { if (signal?.aborted) throw new SourceInventoryError('canceled'); };
  const rows: Readonly<Item>[] = [];
  const seen = new Set<number>();
  let location: Readonly<Location> | undefined;
  let total: number | undefined;
  // The page count is derived from the published total, so a catalog of any size
  // is read whole and a short, duplicated or reordered page is refused by the
  // checks below instead of leaving rows unread forever.
  let lastPage = 1;
  for (let page = 1; page <= lastPage; page++) {
    checkCanceled();
    let reply: Response;
    try {
      reply = await fetcher(queryURL({ ...initialQuery(source, kind), page, size: PAGE_SIZE }), {
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
    if (data.location.id !== source || data.page !== page || data.page_size !== PAGE_SIZE
      || (total !== undefined && data.total_variants !== total)
      || (location && data.location.name !== location.name)) throw malformed();
    total = data.total_variants;
    location ??= Object.freeze({ ...data.location });
    if (total > MAX_VARIANTS) throw malformed();
    lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const expected = Math.min(PAGE_SIZE, Math.max(0, total - (page - 1) * PAGE_SIZE));
    if (data.items.length !== expected) throw malformed();
    for (const item of data.items) {
      if (seen.has(item.variant_id) || (rows.length > 0 && item.variant_id <= rows[rows.length - 1].variant_id)
        || (kind !== undefined && kind !== 'all' && item.kind !== kind)
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

export interface SourceFilter {
  /** The one catalogue kind this document carries. */
  readonly kind: Kind;
  readonly search?: string; readonly brand?: string; readonly polarity?: '' | 'L' | 'R';
}
// A battery search matches the brand and the model it shows; a product search
// matches its free name and the content of its typed fields, because a term the
// row shows must find the row. The battery filters never apply to a product.
function productMatches(row: Item, literal: string): boolean {
  const fields = row.fields ?? [];
  const shown = [row.name, row.detail, ...fields.flatMap(field => [field.name, field.unit ?? '', field.number ?? '', field.text ?? ''])].join('\n');
  return shown.toLowerCase().includes(literal);
}
/**
 * Offers the rows of the one catalogue kind the document carries, narrowed by the
 * term inside that kind. A row of the other kind is never offered, and a retired
 * entry never reaches this catalogue in the first place.
 */
export function filterSourceInventory(catalog: SourceCatalog, filter: SourceFilter): readonly Readonly<Item>[] {
  const { kind } = filter;
  const search = filter.search ?? '';
  const brand = filter.brand ?? '';
  const polarity = filter.polarity ?? '';
  if ((kind !== 'battery' && kind !== 'other') || !validSearch(search) || !validSearch(brand)
    || !['', 'L', 'R'].includes(polarity)) throw new Error('Invalid source filter');
  const literal = search.toLowerCase();
  return Object.freeze(catalog.rows.filter(row => row.kind === kind && (kind === 'battery'
    ? (!brand || row.battery?.brand === brand) && (!polarity || row.battery?.polarity === polarity)
      && (!literal || row.battery?.brand.toLowerCase().includes(literal) || row.battery?.model.toLowerCase().includes(literal))
    : !literal || productMatches(row, literal))));
}
