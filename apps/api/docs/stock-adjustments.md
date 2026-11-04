# Warehouse stock adjustment by physical count

Correction of the warehouse stock (`Almacén`, location 1) against a real physical
count. A document has one or more variant/counted lines, is applied atomically to
`inventory_balances`, and stays immutable forever; a mistake is corrected only by
a counter-entry. Only the warehouse adjusts its own stock, exactly like stock
ingress: there is no branch adjustment and no counting session, deferred close or
persisted draft in this domain.

## Blind count

The capture is blind by contract, not by convention:

* The client sends **only** the counted quantity of each line. The expected
  quantity and the difference are not part of the request body, so a client that
  tries to send `expected_quantity` or `difference` is rejected as an unknown key
  (`400 invalid_request`).
* The database takes the expected snapshot itself, inside the applying
  transaction and under the balance row lock. `expected_quantity` is never a
  caller promise, even though the insert statement must supply the `NOT NULL`
  column: the admission trigger overwrites it with its own locked value.
* The difference is derived as `counted - expected` on read, so it can never
  disagree with the two persisted facts it comes from.
* The capture catalogue (`GET /api/stock-adjustments/catalog`) is a separate,
  quantity-free projection: it carries the catalogue identity of a variant and no
  stock field at all. `/api/inventory` is not reused for the capture because its
  payload includes `existing`.
* The difference is revealed only **after** the document is applied, in the
  history and the detail. While capturing, no screen of this contract shows the
  expected quantity, the difference or any other stock number.

## Authorization

Only the warehouse administrator adjusts: the authenticated identity must be
account `1` assigned to location `1` with a completed password change. The store
also verifies the `auth_accounts` binding (`id` plus `location_id`) before
touching any document, so a forged identity is not evidence of an assignment.
Branches receive `403 forbidden`; they neither see nor reach these routes. The
database refuses `location_id <> 1` as well, so the scope is enforced twice.

## Routes

| Route | Method | Result |
|---|---|---|
| `/api/stock-adjustments` | POST | 201 on creation, 200 on an exact idempotent replay |
| `/api/stock-adjustments` | GET | 200 with one newest-first page of documents |
| `/api/stock-adjustments/catalog` | GET | 200 with one page of the blind capture catalogue |
| `/api/stock-adjustments/{id}` | GET | 200 with the full detail of one document |
| `/api/stock-adjustments/{id}/reverse` | POST | 201 on the counter-entry, 200 on an exact idempotent replay |

No other method and no other path is served by this contract (`405
method_not_allowed`, `Allow: GET, POST` for the collection, `Allow: GET` for the
catalogue and the detail, `Allow: POST` for the counter-entry). Mutations require
the usual same-origin session cookie, `Origin`, `Sec-Fetch-Site` and
`X-CSRF-Token`; every read requires the session only. A query string on either
POST or on the document detail is rejected.

Any other path below `/api/stock-adjustments/` is `404 not_found` as JSON. The
literal `catalog` route is registered beside the `{id}` pattern and is never
captured by it: `GET /api/stock-adjustments/catalog` is the catalogue, while a
`{id}` segment must be a canonical positive integer and a non-canonical spelling
(`01`, `+1`, `0`, `abc`, an integer above `bigint`) is `400 invalid_request`. An
ambiguous path is refused before it can be cleaned or redirected: a doubled
slash, a `.` or `..` segment, a backslash, a NUL, or an encoded alias (`%31` for
`1`, `%2F` for `/`, `%63atalog` for `catalog`) is `404 not_found`. A trailing
slash is `404 not_found`, never a redirect.

## Creation

### Request

```json
{"operation_key":"[A-Za-z0-9_-]{16,128}","reason":"string, 1..500 chars",
 "detail":"string, optional, <=500 chars",
 "lines":[{"variant_id":1,"counted_quantity":12}]}
```

* `lines` holds 1 to 190 entries, `variant_id` is unique per document and
  `counted_quantity` is between 0 and 1000000. A count of zero is a legitimate
  result of a physical count; a negative one is not expressible.
* `reason` is mandatory: valid UTF-8 without NUL, at most 500 characters, never
  blank once trimmed. The admitted reason is persisted trimmed, so an exact
  replay with different padding is still the same reason.
* `detail` is optional; when present it must be valid UTF-8 without NUL and at
  most 500 characters, and it is persisted verbatim.
* Decoding is token-exact: unknown keys (`expected_quantity`, `difference`,
  `location_id`, …), duplicate keys (including escaped-equivalent spellings),
  wrong types, non-canonical integers, trailing input and bodies above 16 KiB are
  rejected. The body limit is small on purpose: 190 lines plus a 500-character
  reason and detail is far below it.

### Success

```json
{"id":1,"location_id":1,"reason":"conteo físico","detail":"pasillo 2",
 "created_by_account_id":1,"created_at":"2026-02-03T04:05:06Z",
 "reverses_adjustment_id":null,
 "lines":[{"variant_id":1,"expected_quantity":18,"counted_quantity":12,"difference":-6}],
 "total_difference":-6}
```

`created_at` is RFC3339 in UTC, `lines` are ordered by `variant_id` ascending,
each line carries the expected snapshot, the counted quantity and the derived
difference, and `total_difference` is the exact signed sum of the line
differences. `reverses_adjustment_id` is `null` for an original document.

### Idempotency

`operation_key` identifies one intent. Resending the same canonical payload
(location, reason, detail and the variant-ordered lines) returns `200` with the
persisted document and changes nothing. Sending a different payload under the
same key returns `409 retry_conflict` and writes nothing, because the first
document is already the truth. Only the operation key is serialized
(`pg_advisory_xact_lock`, in a key space separate from stock ingress), so a
concurrent duplicate submission resolves to a replay instead of a unique
violation.

## History

The read is the warehouse's own ledger of documents, with the per-line detail
left out:

```
GET /api/stock-adjustments?page=1&page_size=25
```

* `page` is a canonical integer from 1 to 1000000 and defaults to 1.
* `page_size` is one of `10`, `25`, `50` and defaults to 25.
* The query is token-exact: repeated parameters, unknown keys, empty values, a
  bare `?` and non-canonical integers (`01`, `+1`, `1e3`, `1.0`, `%31`) are all
  `400 invalid_request`. Parameter order is irrelevant.

```json
{"page":1,"page_size":25,"total_adjustments":3,
 "adjustments":[{"id":6,"reason":"conteo físico","detail":"pasillo 2",
  "created_at":"2026-11-04T14:20:00Z","lines":2,"total_difference":-4,
  "reverses_adjustment_id":null,"reversed_by":null}]}
```

`adjustments` is ordered by `id` descending, so the newest document is always
first and paging with a stable `page_size` never repeats or skips a document.
`total_adjustments` counts every document of the warehouse, independent of the
requested page, which makes an empty page beyond the last one harmless.

Each row is a summary of exactly eight fields:

| Field | Meaning |
|---|---|
| `id` | Document number |
| `reason` | The persisted motive of this document |
| `detail` | The persisted detail; empty string when absent |
| `created_at` | RFC3339 in UTC |
| `lines` | Number of lines in the document |
| `total_difference` | Exact signed sum of the line differences |
| `reverses_adjustment_id` | The original document when this one is a counter-entry, otherwise `null` |
| `reversed_by` | Id of the counter-entry that reverses this document, or `null` |

`lines` and `total_difference` are computed by the database in `bigint`, and the
difference total is cast to text before it becomes an integer, so an
out-of-range sum fails closed instead of wrapping. A counter-entry is itself a
document, so it appears in the history with its own (negated) `total_difference`
and a `reverses_adjustment_id`, and the document it reverses reports its `id` in
`reversed_by`.

Per-line detail never appears in this list: the document detail is a separate
contract. Because a document is never edited, the history only ever grows; a
correction adds the counter-entry beside the original and neither row is
rewritten.

## Document detail

The full document is read one document at a time, with the catalogue identity of
every line:

```
GET /api/stock-adjustments/{id}
```

`{id}` admits only a canonical positive integer (see the path rules above). A
query string is not part of this contract: `?page=1` and a bare `?` are `400
invalid_request`.

```json
{"id":1,"location_id":1,"reason":"conteo físico","detail":"pasillo 2",
 "created_at":"2026-11-04T14:20:00Z","created_by_account_id":1,
 "reverses_adjustment_id":null,"reversed_by":null,"reversed_by_reason":"",
 "lines":[{"variant_id":7,"catalog_entry_id":4,"brand":"TOYO","model":"NS60L",
  "capacity_ah":"45","polarity":"L",
  "expected_quantity":18,"counted_quantity":12,"difference":-6}],
 "total_difference":-6}
```

| Field | Meaning |
|---|---|
| `id` | Document number |
| `location_id` | Always `1`: the warehouse |
| `reason` | The persisted motive of this document |
| `detail` | The persisted detail; empty string when absent |
| `created_at` | RFC3339 in UTC |
| `created_by_account_id` | The warehouse administrator that confirmed the document |
| `reverses_adjustment_id` | The original document when this one is a counter-entry, otherwise `null` |
| `reversed_by` | The counter-entry that reverses this document, otherwise `null` |
| `reversed_by_reason` | The motive of that counter-entry, so the correction reads in one response; empty string when the document is not reversed |
| `lines` | The document lines, ordered by `variant_id` ascending |
| `total_difference` | Exact signed sum of the line differences |

Each line carries the catalogue identity of its variant — `catalog_entry_id`,
`brand`, `model`, `capacity_ah` and `polarity` — plus `expected_quantity`,
`counted_quantity` and `difference`. `capacity_ah` is the canonical decimal
**text** of the inventory read (`"45"`, `"6.5"`), so no float rounding and no
trailing zeros reach the client.

A persisted document keeps its own arithmetic: `expected_quantity` is the
snapshot the database took when the document was applied and `counted_quantity`
is what the warehouse declared, so the detail stays readable and exact after the
current stock has changed again. Nothing here is inferred from the client: a
document of another location, an unknown id and an aliased id are all
`not_found`. A reversed document's detail also includes the counter-entry's
own motive in `reversed_by_reason`, read with the same statement, so the
correction is legible without a second request; that field is the empty string
for a document that is not reversed. The response carries no stored column
outside the table above: no operation key, no account detail and no stock column
of any other contract.

## Counter-entry (contra-asiento)

A confirmed document is never edited and never deleted. The only correction is a
new document that mirrors it:

```
POST /api/stock-adjustments/{id}/reverse
```

`{id}` is the decimal id of the **original** document, with the same canonical
path rules.

### Request

```json
{"operation_key":"[A-Za-z0-9_-]{16,128}","reason":"1..500 characters"}
```

Exactly these two fields, each once, both strings, nothing else. `reason` is
mandatory and canonicalized exactly like creation.

**The client never sends lines, expected quantities, counted quantities or a
difference.** The server derives them from the persisted original, so a partial
reversal, a reversal of another document's lines, or an invented quantity cannot
be expressed through this contract.

### Derived lines

The counter-entry has exactly one line per original line, in ascending
`variant_id` order, with `expected_quantity` and `counted_quantity` swapped. Its
per-line difference is therefore the exact negation of the original difference,
its `total_difference` is the negation of the original total, and the original
document is never touched: both documents stay visible forever, and the original
reports its counter-entry through `reversed_by`.

One counter-entry per document: the partial unique index on
`reverses_adjustment_id` admits at most one, a counter-entry is not itself a
reversal target, and a document is never its own target.

### Success

```json
{"id":2,"location_id":1,"reason":"conteo mal tomado","detail":"",
 "created_by_account_id":1,"created_at":"2026-02-03T04:06:11Z",
 "reverses_adjustment_id":1,
 "lines":[{"variant_id":1,"expected_quantity":12,"counted_quantity":18,"difference":6}],
 "total_difference":6}
```

The shape is exactly the creation shape, the counter-entry has no detail of its
own (`detail` is always the empty string) and its lines mirror the original.

### Idempotency

The `operation_key` identifies one correction intent, serialized by the same
advisory-lock scheme as creation. Resending the same key with the same target and
the same canonical reason returns `200` with the persisted counter-entry and
changes nothing. The same key with another target or another reason is `409
retry_conflict` and writes nothing.

### Failure semantics

The counter-entry is applied whole or not at all. If any line would leave
`existing < reserved` after the reversal, the entire reversal is rejected with
`409 insufficient_stock`: nothing is written, no partial counter-entry exists,
and the original document, its lines and `inventory_balances` are unchanged.
Stock is never invented and never compensated automatically.

| Status | Code | Meaning |
|---|---|---|
| 400 | `invalid_request` | Malformed body, bad or missing `reason`, bad operation key, or a non-canonical `{id}` |
| 401 | `unauthenticated` | No session |
| 403 | `forbidden` | The caller is not the warehouse administrator |
| 404 | `not_found` | No such document in this warehouse, or an aliased path |
| 409 | `decision_conflict` | The target is itself a counter-entry, or it already has one |
| 409 | `retry_conflict` | The operation key is bound to another target or reason |
| 409 | `insufficient_stock` | The reversal would leave `existing < reserved` |
| 503 | `service_unavailable` | Pool, database, or any unmapped failure |

## Capture catalogue

```
GET /api/stock-adjustments/catalog?search=&brand=&polarity=&page=1&page_size=25
```

* `search` is a literal substring over `brand` and `model` (case-insensitive); a
  `%` or `_` in the operator's own words never becomes a SQL wildcard.
* `brand` is an exact brand filter and `polarity` is `L` or `R`.
* `page` and `page_size` are the history contract's, and the numeric parameters
  are admitted only in their canonical raw spelling. The free-text filters are
  percent-decoded once, so a real search with spaces works and an encoded digit
  is still not a page number.
* Repeated parameters, unknown keys (including any stock parameter such as
  `existing`), empty values, a bare `?` and malformed escapes are `400
  invalid_request`.

```json
{"page":1,"page_size":25,"total_variants":190,
 "items":[{"variant_id":1,"catalog_entry_id":1,"brand":"TOYO","model":"NS60L",
  "capacity_ah":"45","polarity":"L"}]}
```

Each item is exactly the catalogue identity of one variant of this warehouse:
`variant_id`, `catalog_entry_id`, `brand`, `model`, `capacity_ah`, `polarity`.
**No stock quantity field exists on this response** — not `existing`, not
`reserved`, not `available`, not `expected_quantity`, not `difference` — so the
blind capture cannot leak the number the warehouse is supposed to count. The
query joins `inventory_balances` only to prove the variant belongs to this
warehouse's ledger; it reads no stock value. `total_variants` counts every
matching variant of the warehouse, independent of the requested page.

## Errors

Every failure returns exactly `{"error":"<code>"}`.

| Status | Code | Meaning |
|---|---|---|
| 400 | `invalid_request` | Malformed body, bad field, a client-supplied `expected_quantity`/`difference`, duplicate variant, an exceeded limit, a non-canonical `{id}`, or an inadmissible query |
| 401 | `unauthenticated` | No session |
| 403 | `forbidden` | The caller is not the warehouse administrator |
| 404 | `not_found` | No such document in this warehouse, or an aliased path |
| 409 | `decision_conflict` | The target is itself a counter-entry, or it already has one |
| 409 | `retry_conflict` | The operation key is bound to a different payload, target or reason |
| 409 | `insufficient_stock` | The applied difference would leave `existing < reserved` |
| 503 | `service_unavailable` | Pool, database, or any unmapped failure |

Failures never leak driver, SQL, or configuration details; only the database's own
rejection is trusted.

## Database invariants

`stock_adjustments` (header) and `stock_adjustment_lines` are append-only:
`UPDATE`, `DELETE` and `TRUNCATE` raise an exception. The database, not the
application, decides the following, with stable SQLSTATEs:

| SQLSTATE | Guard | Public code |
|---|---|---|
| `LS001` | The applied line would leave `existing < reserved` | 409 `insufficient_stock` |
| `LS002` | Counted quantity out of bounds, or a counter-entry line that does not mirror the original | 400 `invalid_request` |
| `LS003` | A counter-entry that does not mirror **every** original line (checked at commit) | 400 `invalid_request` |
| `LS004` | Missing balance row or missing document for a line | 503 `service_unavailable` |
| `LS005` | `location_id <> 1` | 400 `invalid_request` |
| `LS006` | Reversal target missing, in another location, or itself a reversal | 400 `invalid_request` |
| `LS007` | The resulting `existing` would leave `bigint` | 400 `invalid_request` |

Lines are applied immediately, one by one, in ascending `variant_id` order, so
balance rows are locked in a deterministic order and each line's expected
snapshot is taken under its own row lock. `reserved` is never modified by this
domain, and the total is checked on an exact numeric value before the `bigint`
cast, so nothing wraps. A rejected document writes nothing anywhere: no header,
no line and no balance movement.

### Counter-entries

A reversal is another document with `reverses_adjustment_id` set and its own
mandatory `reason`; its lines carry the mirror of the original ones (expected and
counted swapped). A partial unique index admits at most one reversal per original
document, `reverses_adjustment_id <> id` prevents self-reversal, and a reversal
of a reversal is rejected. The original document keeps its bytes: both documents
stay visible and the original is corrected, never rewritten. The frozen route
above derives those lines from the persisted original inside one transaction; the
database still decides the outcome, and the trigger rejections (`LS001`, `LS002`,
`LS003`, `LS006`) are reported through the public codes in the table above.

## Realtime

No new notification code exists in this domain. Migration 004 already installs
`invalidate_balance_change` on `inventory_balances`, so every difference applied
by an adjustment line invalidates the `inventory` scope and notifies listeners in
the same transaction.

## Wiring

The server composes `NewWithStockEntries(service, cfg, inventoryStore,
transferStore, stockEntryStore, broker, stockAdjustmentStore)`. It returns
`(http.Handler, error)` and rejects required nil dependencies, an inconsistent
authentication configuration and more than one adjustment store; the broker only
adds the event stream and the adjustment store is the optional last argument.
Without it the adjustment routes stay unregistered (`404`), exactly like ingress
on the legacy factories (`New`, `NewWithTransfers`, `NewWithRealtime`), whose
behavior is unchanged.
