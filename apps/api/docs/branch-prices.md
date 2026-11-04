# Branch price list (Catálogo de precios)

The branch price list is the warehouse's administration surface for **what each
branch sells for**: one minimum price and one suggested price per (branch,
variant), plus the warranty term of the variant itself. Prices are administered
only by the warehouse (`Almacén`, account `1` with location `1`), are assigned one
branch at a time or in a block to several branches at once, and are never deleted:
a pair is replaced in place.

Money is a **canonical decimal string** end to end (`"85000.00"`), stored in
`numeric(12,2)` and never parsed into a binary float. The currency symbol is a
presentation concern of the client and is not part of this contract.

## Authorization

Only the warehouse administrator reads and writes this contract: the
authenticated identity must be account `1` assigned to location `1` with a
completed password change. The store also verifies the `auth_accounts` binding
(`id` plus `location_id`) before touching any row, so a forged identity is not
evidence of an assignment. A branch session receives `403 forbidden` on the read
and on the write; the database refuses `branch_location_id = 1` as well, so the
sale scope is enforced twice.

Authority always comes from the session. The request body never carries an actor,
a location or a display name.

## Routes

| Route | Method | Result |
|---|---|---|
| `/api/catalog/prices` | GET | 200 with one page of the price matrix |
| `/api/catalog/prices` | PUT | 200 with the applied assignment |

No other method is served (`405 method_not_allowed`, `Allow: GET, PUT`). The write
requires the usual same-origin session cookie, `Origin`, `Sec-Fetch-Site` and
`X-CSRF-Token`; the read requires the session only. A query string on the write is
rejected.

Any other path below `/api/catalog/prices/` is `404 not_found` as JSON, and an
ambiguous path is refused before it can be cleaned or redirected: a doubled slash,
a `.` or `..` segment, a backslash, a NUL, or an encoded alias (`%31` for `1`,
`%70rices` for `prices`) is `404 not_found`. There is no path parameter in this
contract.

## Read: the price matrix

```
GET /api/catalog/prices?search=&brand=&capacity=&polarity=&page=&page_size=
```

* `search` is a literal substring over `brand` and `model` (case-insensitive); a
  `%` or `_` in the operator's own words never becomes a SQL wildcard.
* `brand` is an exact brand filter.
* `capacity` is an exact catalogue capacity (`"45"`, `"6.5"`). It is validated as a
  catalogue decimal and compared as `numeric`, so `6,5` or `abc` is
  `400 invalid_request`.
* `polarity` is `L` or `R`.
* `page` is a canonical integer from 1 to 1000000 and defaults to 1.
* `page_size` is one of `10`, `25`, `50` and defaults to 10.
* The query is token-exact: repeated parameters, unknown keys, empty values, a
  bare `?` and non-canonical integers (`01`, `+1`, `1e3`, `1.0`, `%31`) are all
  `400 invalid_request`. Parameter order is irrelevant. The free text is
  percent-decoded once, so a real search with spaces works.

```json
{"branches":[{"id":2,"name":"Sucursal A"}],
 "variants":[{"variant_id":1,"catalog_entry_id":1,"brand":"CAR","model":"NS40ZL",
  "capacity_ah":"35","polarity":"L","cells":["B5","C5","D5"],
  "warranty_months":6,"warranty_updated_at":"2026-11-04T10:00:00Z",
  "prices":[{"branch_location_id":2,"min_price":"85000.00",
   "suggested_price":"96000.00","updated_at":"2026-11-04T10:00:00Z",
   "updated_by_account_id":1,"updated_by_display_name":"Almacén"}]}],
 "page":1,"page_size":10,"total_variants":190}
```

| Field | Meaning |
|---|---|
| `branches` | The active branches, in `id` order. Retired branches and the warehouse are never listed |
| `variants` | One page of catalogue variants, in `variant_id` order |
| `page`, `page_size` | The admitted page |
| `total_variants` | Every variant matching the filters, independent of the page |

Each variant row is:

| Field | Meaning |
|---|---|
| `variant_id`, `catalog_entry_id` | Variant identity and its catalogue entry |
| `brand`, `model` | Catalogue entry brand and model |
| `capacity_ah` | Canonical catalogue capacity as a string (`"35"`, `"6.5"`), never a float |
| `polarity` | `L` or `R` |
| `cells` | The three source cells of the catalogue entry |
| `warranty_months` | The warranty term in force, or `null` when the variant has none |
| `warranty_updated_at` | RFC3339 in UTC; `null` exactly when `warranty_months` is `null` |
| `prices` | The pairs of the listed active branches, in `branch_location_id` order; an empty array when the variant has no price |

Each price is:

| Field | Meaning |
|---|---|
| `branch_location_id` | The branch that holds this pair |
| `min_price` | The sale floor of this branch, canonical with two decimals |
| `suggested_price` | The suggested sale price, canonical with two decimals, never below `min_price` |
| `updated_at` | RFC3339 in UTC: when this pair was last written |
| `updated_by_account_id` | The account that wrote it |
| `updated_by_display_name` | That account's display name |

A variant the branch has no price for appears with an empty `prices` array: that
is exactly the "not sellable in this branch" case of the point of sale. A price of
a branch that was later retired stays persisted (prices are never deleted) but is
no longer advertised here, because it is not a sale price any more.

## Write: individual or block assignment

```
PUT /api/catalog/prices
```

### Request

```json
{"variant_id":1,"min_price":"85000","suggested_price":"96000",
 "warranty_months":6,"branch_ids":[2,3]}
```

* `variant_id` is a canonical positive integer of an existing catalogue variant.
* `min_price` and `suggested_price` are JSON **strings** holding a positive
  decimal amount with at most two decimals. They are canonicalized to exactly two
  decimals (`"85000"` → `"85000.00"`, `"96000.5"` → `"96000.50"`).
* `warranty_months` is optional. Absent leaves the stored term unchanged; present
  it must be an integer from 1 to 120 and replaces the term. `null` is not
  accepted: it is not a serialization of "absent".
* `branch_ids` holds 1 to 50 unique ids, each greater than 1 and each an active
  branch. The warehouse (`1`) is never a destination.
* Decoding is token-exact: unknown keys (`actor_id`, `location_id`, …), duplicate
  keys (including escaped-equivalent spellings), wrong types, a JSON number where
  a canonical amount string is required, trailing input and bodies above 4 KiB are
  rejected.

### Success

```json
{"variant_id":1,"written":2,"branch_ids":[2,3],
 "min_price":"85000.00","suggested_price":"96000.00","warranty_months":6}
```

`branch_ids` is the applied set in ascending order, `written` is how many branch
rows were written (it always equals `len(branch_ids)`), the amounts are canonical
with two decimals, and `warranty_months` is the term **in force after** the write:
the written one, the preserved one, or `null` when the variant still has none.

### Semantics

* One variant, one pair, N branches. The value of the operation is the battery: the
  same `min_price`/`suggested_price` pair is written to every chosen branch, and a
  later individual write can diverge one branch from the rest.
* Two branches may hold different amounts for the same variant; nothing in this
  contract propagates a pair to branches that were not chosen.
* The whole operation is one transaction: either every chosen branch receives the
  pair and the warranty term is written, or nothing is written at all. If one id in
  the list is unknown, retired, repeated or the warehouse, no row changes — not
  even the rows of the valid branches.
* A pair is replaced, never appended and never deleted: writing again updates the
  amounts, the account and `updated_at` of the same row.
* The writing account is always the session identity.

### Failures

| Status | Code | Meaning |
|---|---|---|
| 400 | `invalid_request` | Unknown variant, non-positive amount, more than two decimals, suggested price below the minimum, empty/duplicate/out-of-range `branch_ids`, the warehouse in `branch_ids`, an unknown branch id, or an unknown extra key |
| 400 | `retired_branch` | One of the chosen branches was retired; the body names it (see below) |
| 401 | `unauthenticated` | No session |
| 403 | `forbidden` | The caller is not the warehouse administrator, or the mutation guard failed |
| 503 | `service_unavailable` | Pool, database, or any unmapped failure |

A retired branch is answered with the offending id beside the error code, because
the client must know exactly which row to drop:

```json
{"error":"retired_branch","branch_id":4}
```

Every other failure is the house envelope `{"error":"<code>"}`.

## Errors

| Status | Code | Meaning |
|---|---|---|
| 400 | `invalid_request` | Malformed body, bad amount, bad branch list, bad query, wrong amount pair |
| 400 | `retired_branch` | A named branch of the block was retired; nothing was written |
| 401 | `unauthenticated` | No session |
| 403 | `forbidden` | The caller is not the warehouse administrator |
| 405 | `method_not_allowed` | Any method other than `GET` or `PUT` |
| 404 | `not_found` | Any path below `/api/catalog/prices`, or an aliased path |
| 503 | `service_unavailable` | Pool, database, or any unmapped failure |

Failures never leak driver, SQL, or configuration details; only the database's own
rejection is trusted.

## Database invariants

Two additive tables own this domain:

| Table | Shape |
|---|---|
| `variant_warranties` | `variant_id` primary key, `warranty_months smallint` between 1 and 120, `updated_by_account_id`, `updated_at` |
| `branch_prices` | primary key `(branch_location_id, variant_id)`, `min_price numeric(12,2) > 0`, `suggested_price numeric(12,2) >= min_price`, `updated_by_account_id`, `updated_at`, plus an index on `variant_id` |

The amounts cannot be `NaN` (`min_price <> 'NaN'::numeric`,
`suggested_price <> 'NaN'::numeric`), so a non-finite value is rejected by the
schema itself.

The database, not the application, decides the sale scope, with one stable
SQLSTATE:

| SQLSTATE | Guard |
|---|---|
| `LP00N` | `branch_location_id = 1`: the warehouse never keeps sale prices |
| `LP00N` | A retired branch (`locations.deleted_at IS NOT NULL`): it never receives a price |
| `LP00N` | `DELETE` or `TRUNCATE` of a pair or of a warranty term |

The sale-scope trigger runs on `INSERT` **and** on `UPDATE`, so a branch retired
between two writes cannot keep receiving prices through the replace path. Prices
and warranty terms are replaced, never deleted: the persisted record of what a
branch could sell for is never erased.

Writes are applied in ascending `branch_location_id` order inside one
transaction, so row locks are taken in a deterministic order and a rejected
assignment leaves no partial row behind.

## Realtime

This domain adds no realtime scope and no notification code. Catalog prices are
re-read on navigation, so the existing `realtime_revisions` scope set is untouched
(no `prices:` audience exists and none is needed).

## Wiring

The price list mounts on the handler the stock entry factory already returns:

```go
api, err := httpapi.NewWithStockEntries(service, cfg, inventoryStore, transferStore,
    stockEntryStore, broker, stockAdjustmentStore)
api, err = httpapi.NewWithBranchPrices(api, service, cfg, pricing.New(pool))
```

`NewWithBranchPrices(base, service, cfg, store)` refuses a nil base handler, a nil
service, a nil store and an inconsistent authentication configuration. The stock
entry constructor keeps its own contract untouched: without the price wrapper the
price routes stay unregistered (`404`), exactly like ingress on the legacy
factories (`New`, `NewWithTransfers`, `NewWithRealtime`). Every request outside
`/api/catalog/prices` is forwarded to the composed handler unchanged, including
its response headers and its path safety.
