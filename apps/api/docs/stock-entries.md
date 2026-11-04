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

No other method and no other path is served by this contract (`405
method_not_allowed`). Mutations require the usual same-origin session cookie,
`Origin`, `Sec-Fetch-Site` and `X-CSRF-Token`. A query string is rejected.

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

## Errors

Every failure returns exactly `{"error":"<code>"}`.

| Status | Code | Meaning |
|---|---|---|
| 400 | `invalid_request` | Malformed body, bad field, duplicate variant, or an exceeded limit |
| 403 | `forbidden` | The caller is not the warehouse administrator |
| 409 | `insufficient_stock` | The line would leave `existing < reserved` |
| 409 | `retry_conflict` | The operation key is bound to a different payload |
| 503 | `service_unavailable` | Pool, database, or any unmapped failure |

Failures never leak driver, SQL, or configuration details; only the database's
own rejection is trusted.

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
is corrected, never rewritten. This HTTP contract exposes creation only; a
reversal route is a separate contract, but the invariants above already hold for
any writer.

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
