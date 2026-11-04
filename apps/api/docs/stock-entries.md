# Warehouse stock ingress

Registered ingress of merchandise into the warehouse (`Almacén`, location 1). A
document has one or more variant/quantity lines, is applied atomically to
`inventory_balances`, and stays immutable forever; a mistake is corrected only by
a counter-entry. This is a new domain beside transfers: no transfer workflow,
reservation, or reconciliation is replaced or reused.

## Authorization

Only the warehouse administrator registers ingress: the authenticated identity
must be account `1` assigned to location `1` with a completed password change.
The store also verifies the `auth_accounts` binding (`id` plus `location_id`)
before touching any document, so a forged identity is not evidence of an
assignment. Branches receive `403 forbidden`; they neither see nor reach this
route.

## Route

| Route | Method | Result |
|---|---|---|
| `/api/stock-entries` | POST | 201 on creation, 200 on an exact idempotent replay |
| `/api/stock-entries` | GET | 200 with one newest-first page of documents |
| `/api/stock-entries/{id}/reverse` | POST | 201 on the counter-entry, 200 on an exact idempotent replay |

No other method and no other path is served by this contract (`405
method_not_allowed`, `Allow: GET, POST` for the collection and `Allow: POST` for
the counter-entry). Mutations require the usual same-origin session cookie,
`Origin`, `Sec-Fetch-Site` and `X-CSRF-Token`; the read requires the session only.
A query string on either POST is rejected.

Any other path below `/api/stock-entries/` is `404 not_found` as JSON, and an
ambiguous path is refused before it can be cleaned or redirected: a doubled
slash, a `.` or `..` segment, a backslash, a NUL, or an encoded alias
(`%31` for `1`, `%2F` for `/`) is `404 not_found`. A trailing slash is
`404 not_found`, never a redirect.

### Request

```json
{"operation_key":"[A-Za-z0-9_-]{16,128}","note":"string, optional, <=500 chars",
 "lines":[{"variant_id":1,"quantity":2}]}
```

* `lines` holds 1 to 190 entries, `variant_id` is unique per document and
  `quantity` is between 1 and 1000000.
* `note` is optional; when present it must be valid UTF-8 without NUL and at most
  500 characters.
* Decoding is token-exact: unknown keys, duplicate keys (including
  escaped-equivalent spellings), wrong types, non-canonical integers, trailing
  input and bodies above 16 KiB are rejected. The body limit is small on purpose:
  190 lines plus a 500-character note is far below it.

### Success

```json
{"id":1,"location_id":1,"note":"","created_by_account_id":1,
 "created_at":"2026-02-03T04:05:06Z",
 "lines":[{"variant_id":1,"quantity":2}],"total_units":2}
```

`created_at` is RFC3339 in UTC, `lines` are ordered by `variant_id` and
`total_units` is the exact sum of the line quantities.

### Idempotency

`operation_key` identifies one intent. Resending the same canonical payload
(location, note, and the variant-ordered lines) returns `200` with the persisted
document and changes nothing. Sending a different payload under the same key
returns `409 retry_conflict` and writes nothing, because the first document is
already the truth. Only the operation key is serialized
(`pg_advisory_xact_lock`), so a concurrent duplicate submission resolves to a
replay instead of a unique violation.

## History

The read is the warehouse's own ledger of documents, with the per-line detail
left out:

```
GET /api/stock-entries?page=1&page_size=25
```

* `page` is a canonical integer from 1 to 1000000 and defaults to 1.
* `page_size` is one of `10`, `25`, `50` and defaults to 25.
* The query is token-exact: repeated parameters, unknown keys, empty values, a
  bare `?` and non-canonical integers (`01`, `+1`, `1e3`, `1.0`) are all
  `400 invalid_request`. Parameter order is irrelevant.

```json
{"page":1,"page_size":25,"total_entries":3,
 "entries":[{"id":6,"note":"Remito 0002-00045871","created_at":"2026-11-04T14:20:00Z",
  "lines":2,"total_units":18,"reversed_by":null}]}
```

`entries` is ordered by `id` descending, so the newest document is always first
and paging with a stable `page_size` never repeats or skips a document.
`total_entries` counts every document of the warehouse, independent of the
requested page, which makes an empty page beyond the last one harmless.

Each row is a summary of exactly six fields:

| Field | Meaning |
|---|---|
| `id` | Document number |
| `note` | Header note; empty string when absent |
| `created_at` | RFC3339 in UTC |
| `lines` | Number of lines in the document |
| `total_units` | Exact sum of the line quantities |
| `reversed_by` | Id of the counter-entry that reverses this document, or `null` |

`lines` and `total_units` are computed by the database in `bigint`/`numeric` and
come back as one page statement plus one total statement, never by summing every
line in the application. A counter-entry is itself a document, so it appears in
the history with its own negative `total_units`, and the document it reverses
reports its `id` in `reversed_by`.

Per-line detail never appears in this list: the document detail is a separate
contract. Because a document is never edited, the history only ever grows; a
correction adds the counter-entry beside the original and neither row is
rewritten.

## Counter-entry (contra-asiento)

A confirmed document is never edited and never deleted. The only correction is a
new document that negates it:

```
POST /api/stock-entries/{id}/reverse
```

### Path

`{id}` is the decimal id of the **original** document and only a canonical
positive integer is admitted: no leading zeros, no sign, no whitespace. An
aliased spelling (`01`, `+1`, `0`, `abc`, an integer above `bigint`) is
`400 invalid_request`, and an aliased or ambiguous path is `404 not_found`
(see above). Neither is cleaned, truncated or redirected.

### Request

```json
{"operation_key":"[A-Za-z0-9_-]{16,128}","reason":"1..500 characters"}
```

Exactly these two fields, each once, both strings, nothing else. `reason` is
mandatory: valid UTF-8 without NUL, at most 500 characters, and never blank once
trimmed. The admitted reason is persisted trimmed, so an exact replay with
different padding is still the same reason.

**The client never sends quantities or lines.** The server derives them from the
persisted original, so a partial reversal, a reversal of another document's
lines, or an invented quantity cannot be expressed through this contract.

### Derived lines

The counter-entry has exactly one line per original line, in ascending
`variant_id` order, with `quantity = -original.quantity`. Its `total_units` is
therefore the exact negation of the original total, and the original document is
never touched: both documents stay visible forever, and the original reports its
counter-entry through `reversed_by` in the history.

One counter-entry per document: the partial unique index on
`reverses_entry_id` admits at most one, a counter-entry is not itself a reversal
target, and a document is never its own target.

### Success

```json
{"id":2,"location_id":1,"note":"","created_by_account_id":1,
 "created_at":"2026-02-03T04:06:11Z",
 "lines":[{"variant_id":1,"quantity":-2},{"variant_id":2,"quantity":-3}],
 "total_units":-5}
```

The shape is exactly the creation shape. The counter-entry has no note of its
own (`note` is always the empty string) and its lines and total are negative.

### Idempotency

The `operation_key` identifies one correction intent, serialized by the same
`pg_advisory_xact_lock` scheme as creation. Resending the same key with the same
target and the same canonical reason returns `200` with the persisted
counter-entry and changes nothing. The same key with another target or another
reason is `409 retry_conflict` and writes nothing.

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

### Counters and totals

`inventory_balances` is the only stock state, and a counter-entry subtracts
exactly what the original added, so applying a document and then its
counter-entry leaves `existing` and `reserved` as they were before the ingress.
In the history, `total_entries` counts documents, not ingress or corrections, so
the original and its counter-entry are two rows; the counter-entry contributes
the negative number of units it removes, which is why `total_units` is signed.
Summing `total_units` over a whole history therefore yields the net units still
registered by this domain.

## Errors

Every failure returns exactly `{"error":"<code>"}`.

| Status | Code | Meaning |
|---|---|---|
| 400 | `invalid_request` | Malformed body, bad field, duplicate variant, an exceeded limit, or an inadmissible `page`/`page_size` |
| 403 | `forbidden` | The caller is not the warehouse administrator |
| 409 | `insufficient_stock` | The line would leave `existing < reserved` |
| 409 | `retry_conflict` | The operation key is bound to a different payload |
| 503 | `service_unavailable` | Pool, database, or any unmapped failure |

Failures never leak driver, SQL, or configuration details; only the database's
own rejection is trusted. The counter-entry route adds `401 unauthenticated`,
`404 not_found` and `409 decision_conflict` to this vocabulary; its own table is
above.

## Database invariants

`stock_entries` (header) and `stock_entry_lines` are append-only: `UPDATE`,
`DELETE` and `TRUNCATE` raise an exception. The database, not the application,
decides the following, with stable SQLSTATEs:

| SQLSTATE | Guard | Public code |
|---|---|---|
| `LS001` | `existing + quantity < reserved` (also covers negative) | 409 `insufficient_stock` |
| `LS002` | Wrong sign, or a reversal line that does not mirror an original line | 400 `invalid_request` |
| `LS003` | A reversal that does not mirror **every** original line (checked at commit) | 400 `invalid_request` |
| `LS004` | Missing balance row (or missing document for a line) | 503 `service_unavailable` |
| `LS005` | `location_id <> 1` | 400 `invalid_request` |
| `LS006` | Reversal target missing, in another location, or itself a reversal | 400 `invalid_request` |
| `LS007` | The resulting `existing` would exceed `bigint` | 400 `invalid_request` |

Ingress only ever adds to `existing` and never touches `reserved`. Balance rows
are locked and updated line by line in ascending `variant_id` order, so the
document's lock order is deterministic. Quantities are summed with an explicit
`bigint` bound check instead of wrapping.

### Counter-entries

A reversal is another document with `reverses_entry_id` set and a mandatory
`reason`; its lines carry the exact negation of the original ones. A partial
unique index admits at most one reversal per original document, `reverses_entry_id
<> id` prevents self-reversal, and a reversal of a reversal is rejected. The
original document keeps its bytes: both documents stay visible and the original
is corrected, never rewritten. The frozen route above derives those lines from the
persisted original inside one transaction; the database still decides the
outcome, and the trigger rejections (`LS001`, `LS002`, `LS003`, `LS006`) are
reported through the public codes in the table above.

## Realtime

No new notification code exists in this domain. Migration 004 already installs
`invalidate_balance_change` on `inventory_balances`, so applying an ingress line
invalidates the `inventory` scope and notifies listeners in the same transaction.

## Wiring

The server composes `NewWithStockEntries(service, cfg, inventoryStore,
transferStore, stockEntryStore, broker)`. It returns `(http.Handler, error)` and
rejects required nil dependencies and inconsistent authentication configuration;
the broker is optional and only adds the event stream. Legacy factories
(`New`, `NewWithTransfers`, `NewWithRealtime`) keep their behavior and never
register this route, which stays `404` for them.
