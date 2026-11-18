# Branch price list (Catálogo de precios)

The branch price list is the warehouse's administration surface for **what each
branch sells for**: one minimum price and one suggested price per (branch,
**catalogue entry**), and the entry is one of the catalogue's two kinds. A
**battery** is a catalogue entry — brand + model + capacity — so one price covers
**both polarities** of that battery: "el precio se aplica el mismo tanto a las
baterias con polaridad L y R del mismo medelo/marca". Two polarities of one battery
can never hold different prices, because there is exactly one row to hold them. An
**other product** is the second kind: a free name plus typed custom fields, with one
polarity-less variant, so its single entry row already covers it — there is no
per-variant price and no second table.

Prices are administered only by the warehouse (`Almacén`, account `1` with
location `1`), are assigned one branch at a time or in a block to several branches
at once, and are never deleted: a pair is replaced in place.

The warranty term is **not part of this contract**. It is chosen by the seller at
the point of sale, when the sale is made, and is recorded by the sales module; the
catalogue neither stores nor returns it.

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
GET /api/catalog/prices?kind=&search=&brand=&capacity=&page=&page_size=
```

* `kind` selects the one kind the page lists: `battery` or `other`. **Absent means
  `battery`**, so every answer that predates the second kind is unchanged. `all` is
  `400 invalid_request`: one page is one kind, because that is what the two tabs ask
  for and a mixed page has no second ordering key. The envelope is renamed to match:
  `batteries` is now `rows` and `total_batteries` is now `total`.
* `search` is a literal substring (case-insensitive); for a battery it reads `brand`
  and `model`, for a product it also reads the free name and the content of its typed
  fields, so a term the row displays finds the row. A `%` or `_` in the operator's own
  words never becomes a SQL wildcard.
* `brand` is an exact brand filter. It is a **battery** filter: naming it together
  with `kind=other` is `400 invalid_request`, never a silently ignored parameter.
* `capacity` is an exact catalogue capacity (`"45"`, `"6.5"`). It is validated as a
  catalogue decimal and compared as `numeric`, so `6,5` or `abc` is
  `400 invalid_request`. It is a **battery** filter too: `kind=other&capacity=45` is
  `400 invalid_request`.
* `page` is a canonical integer from 1 to 1000000 and defaults to 1.
* `page_size` is one of `10`, `25`, `50` and defaults to 10.
* The query is token-exact: repeated parameters, unknown keys, empty values, an
  unknown `kind`, a bare `?` and non-canonical integers (`01`, `+1`, `1e3`, `1.0`,
  `%31`) are all `400 invalid_request`. Parameter order is irrelevant. The free text
  is percent-decoded once, so a real search with spaces works.

There is **no polarity filter**: a price belongs to the entry, so every battery row of
the matrix carries both of its polarities. A `polarity` parameter is an unknown
key and is rejected.

A battery page:

```json
{"branches":[{"id":2,"name":"Sucursal A"}],
 "rows":[{"kind":"battery","catalog_entry_id":1,"brand":"CAR","model":"NS40ZL",
  "capacity_ah":"35","polarities":["L","R"],"cells":["B5","C5","D5"],
  "prices":[{"branch_location_id":2,"min_price":"85000.00",
   "suggested_price":"96000.00","updated_at":"2026-11-04T10:00:00Z",
   "updated_by_account_id":1,"updated_by_display_name":""}]}],
 "page":1,"page_size":10,"total":95}
```

A product page of the same contract:

```json
{"branches":[{"id":2,"name":"Sucursal A"}],
 "rows":[{"kind":"other","catalog_entry_id":96,"name":"Agua acidulada",
  "detail":"volumen en L: 5 L",
  "prices":[{"branch_location_id":2,"min_price":"1500.00",
   "suggested_price":"1900.00","updated_at":"2026-11-04T10:00:00Z",
   "updated_by_account_id":1,"updated_by_display_name":""}]}],
 "page":1,"page_size":10,"total":1}
```

| Field | Meaning |
|---|---|
| `branches` | The active branches, in `id` order. Retired branches and the warehouse are never listed |
| `rows` | One page of the asked kind, in `catalog_entry_id` order |
| `page`, `page_size` | The admitted page |
| `total` | Every row of the asked kind matching the filters, independent of the page |

A row is a discriminated union on `kind`, and the `prices` array is **identical for
both kinds**: that is what "igual que en las baterías" means here. A battery row is:

| Field | Meaning |
|---|---|
| `kind` | `battery` |
| `catalog_entry_id` | The battery: brand + model + capacity |
| `brand`, `model` | Catalogue entry brand and model |
| `capacity_ah` | Canonical catalogue capacity as a string (`"35"`, `"6.5"`), never a float |
| `polarities` | The polarities that exist for this battery, ascending (`["L","R"]`) |
| `cells` | The three source cells of the catalogue entry |
| `prices` | The pairs of the listed active branches, in `branch_location_id` order; an empty array when the battery has no price |

A battery row never carries `name` or `detail`. A product row is:

| Field | Meaning |
|---|---|
| `kind` | `other` |
| `catalog_entry_id` | The product entry |
| `name` | The free name the rest of the application publishes |
| `detail` | The summary of its typed fields (`volumen en L: 5 L`), or its own name when it declares none — never a second composition |
| `prices` | The pairs of the listed active branches, in `branch_location_id` order; an empty array when the product has no price |

A product row carries no `capacity_ah`, no `polarities`, no `cells` and no null
battery field: the key is absent, not empty.

Each price is:

| Field | Meaning |
|---|---|
| `branch_location_id` | The branch that holds this pair |
| `min_price` | The sale floor of this branch, canonical with two decimals |
| `suggested_price` | The suggested sale price, canonical with two decimals, never below `min_price` |
| `updated_at` | RFC3339 in UTC: when this pair was last written |
| `updated_by_account_id` | The account that wrote it |
| `updated_by_display_name` | That account's display name, empty when the account has none |

An entry the branch has no price for appears with an empty `prices` array: that is
exactly the "not sellable in this branch" case of the point of sale, and for a battery
it applies to **both** of its polarities at once. A price of a branch that was later
retired stays persisted (prices are never deleted) but is no longer advertised here,
because it is not a sale price any more.

A price does not make a product sellable: the point of sale still sells batteries
only, so a product price is a recorded amount, never a ticket to sell it.

## Write: individual or block assignment

```
PUT /api/catalog/prices
```

### Request

```json
{"catalog_entry_id":1,"min_price":"85000","suggested_price":"96000",
 "branch_ids":[2,3]}
```

* `catalog_entry_id` is a canonical positive integer of an existing catalogue entry of
  either kind: a battery or an other product.
* `min_price` and `suggested_price` are JSON **strings** holding a positive
  decimal amount with at most two decimals. They are canonicalized to exactly two
  decimals (`"85000"` → `"85000.00"`, `"96000.5"` → `"96000.50"`).
* `branch_ids` holds 1 to 50 unique ids, each greater than 1 and each an active
  branch. The warehouse (`1`) is never a destination.
* Decoding is token-exact: unknown keys (`actor_id`, `location_id`, …), duplicate
  keys (including escaped-equivalent spellings), wrong types, a JSON number where
  a canonical amount string is required, trailing input and bodies above 4 KiB are
  rejected. A **removed** field is an unknown field: a body that still sends
  `variant_id` or `warranty_months` is `400 invalid_request`, never silently
  ignored.

### Success

```json
{"catalog_entry_id":1,"written":2,"branch_ids":[2,3],
 "min_price":"85000.00","suggested_price":"96000.00"}
```

`branch_ids` is the applied set in ascending order, `written` is how many branch
rows were written (it always equals `len(branch_ids)`) and the amounts are
canonical with two decimals. There is no warranty field: the term is not part of
this contract.

### Semantics

* One entry, one pair, N branches. The value of the operation is the catalogue entry, so
  the same `min_price`/`suggested_price` pair is written to every chosen branch and
  covers both polarities of a battery there; a later individual write can
  diverge one branch from the rest. A product has exactly one variant, so its single
  entry row covers it the same way.
* One write creates **exactly one row per (branch, entry)**, never one row per
  polarity. Writing again replaces that row in place.
* Two branches may hold different amounts for the same entry; nothing in this
  contract propagates a pair to branches that were not chosen.
* The whole operation is one transaction: either every chosen branch receives the
  pair, or nothing is written at all. If one id in the list is unknown, retired,
  repeated or the warehouse, no row changes — not even the rows of the valid
  branches.
* A pair is replaced, never appended and never deleted: writing again updates the
  amounts, the account and `updated_at` of the same row.
* The writing account is always the session identity.

### Failures

| Status | Code | Meaning |
|---|---|---|
| 400 | `invalid_request` | Unknown entry, non-positive amount, more than two decimals, suggested price below the minimum, empty/duplicate/out-of-range `branch_ids`, the warehouse in `branch_ids`, an unknown branch id, or an unknown extra key (including a leftover `variant_id` or `warranty_months`) |
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
| 400 | `invalid_request` | Malformed body, bad amount, bad branch list, bad query (`kind=all`, an unknown `kind`, `brand` or `capacity` with `kind=other`), wrong amount pair |
| 400 | `retired_branch` | A named branch of the block was retired; nothing was written |
| 401 | `unauthenticated` | No session |
| 403 | `forbidden` | The caller is not the warehouse administrator |
| 405 | `method_not_allowed` | Any method other than `GET` or `PUT` |
| 404 | `not_found` | Any path below `/api/catalog/prices`, or an aliased path |
| 503 | `service_unavailable` | Pool, database, or any unmapped failure |

Failures never leak driver, SQL, or configuration details; only the database's own
rejection is trusted.

## Database invariants

This contract owns one table:

| Table | Shape |
|---|---|
| `branch_prices` | primary key `(branch_location_id, catalog_entry_id)`, `min_price numeric(12,2) > 0`, `suggested_price numeric(12,2) >= min_price`, `updated_by_account_id`, `updated_at`, plus an index on `catalog_entry_id` |

The primary key **is** the rule that the two polarities of a battery cannot
diverge: there is only one row per (branch, battery), so an L price and an R price
of the same battery in the same branch cannot exist. Migration `024` created the
table keyed by `variant_id`; migration `026` (additive, `024` and `025` untouched)
reshapes it:

1. `catalog_entry_id` is added and backfilled from `catalog_variants.variant_id`.
2. Two polarity rows of one battery collapse into one. The duplicate is resolved
   **deterministically: the most recently updated row wins**, and an exact tie is
   broken by the larger `variant_id`, so the same data always collapses to the same
   surviving pair. That collapse is the only moment a price row is deleted: the
   replace-not-delete trigger is disabled for those statements and enabled again
   right after them.
3. The old primary key, the `variant_id` reverse index and the `variant_id` column
   are dropped, and the new primary key `(branch_location_id, catalog_entry_id)`
   plus a `catalog_entry_id` index are created.
4. The sale line trigger of `025` is replaced so it resolves the pair through the
   sold variant's `catalog_entry_id`.

The amounts cannot be `NaN` (`min_price <> 'NaN'::numeric`,
`suggested_price <> 'NaN'::numeric`), so a non-finite value is rejected by the
schema itself.

`variant_warranties` (migration 024) still exists in the database but is not used
by this contract: this API neither reads nor writes it. The warranty term of a sale
is chosen by the seller at sale time and lives in the sales module.

The database, not the application, decides the sale scope, with one stable
SQLSTATE:

| SQLSTATE | Guard |
|---|---|
| `LP00N` | `branch_location_id = 1`: the warehouse never keeps sale prices |
| `LP00N` | A retired branch (`locations.deleted_at IS NOT NULL`): it never receives a price |
| `LP00N` | `DELETE` or `TRUNCATE` of a pair |

The sale-scope trigger runs on `INSERT` **and** on `UPDATE`, so a branch retired
between two writes cannot keep receiving prices through the replace path. Prices
are replaced, never deleted: the persisted record of what a branch could sell for
is never erased.

The sale tables are untouched and a sale line is still one variant, because a sale
sells a polarity: `sale_lines` keeps its `variant_id`, its frozen `unit_price` and
`min_price`, and the seller's `warranty_months`. What the database decides from the
battery is the pair those frozen values come from (SQLSTATE `LV003` when the battery
has no pair in the branch, `LV004` under the branch floor), so an L sale and an R
sale of the same battery always freeze the same floor.

Writes are applied in ascending `branch_location_id` order inside one transaction,
so row locks are taken in a deterministic order and a rejected assignment leaves no
partial row behind.

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
