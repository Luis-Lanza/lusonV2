# Compras: baterías usadas y chatarra (Purchases)

The branch buys material from whoever brings it: **used batteries**, identified
only by their model code, and **scrap**, bought by the kilogram. This is the
system's first **money-out** document, and it is a document of its own: a sale is
registered normally at full price, and buying from a customer is registered here,
afterwards, in this section. One same document serves a purchase next to a sale
and a customer who only comes to sell.

A used battery is **never resold**. It does not enter the catalogue, the point of
sale, the price matrix or `inventory_balances`; what it produces is a record of
what was received and of what it cost, which is what closes the month's accounts.
Nothing about the person who brings the material is recorded: the document names
the model or the material and the price, and nothing else.

Utility of the received totals is **derived, never stored**: every read below is
the sum of the persisted lines, so a reversal nets out by construction and there
is no second balance to drift.

## Authorization

The authenticated identity must be a completed **branch** session: an account with
`id > 1` assigned to an active location with `id > 1`, and a completed password
change. Authority always comes from the session — the request body never carries
an actor, a branch or a location. The warehouse (`Almacén`, account `1` with
location `1`) receives `403 forbidden` on every route of this contract.

| Actor | Result |
|---|---|
| Branch account in its own branch | admitted |
| Branch account of another branch | `403 forbidden` |
| Warehouse (account `1`, location `1`) | `403 forbidden` |
| Session that must still change its password | `403 forbidden` |
| Retired branch or retired account | `403 forbidden` |

## Formats

Money is a **canonical decimal string** with exactly two decimals (`"25000.00"`),
stored in `numeric(12,2)`, never parsed into a binary float, and admits at most
twelve significant digits. Weight is a **canonical decimal string** with exactly
three decimals (`"12.400"`), stored in `numeric(12,3)`: the request may send
`"12.4"`, the answer is always `"12.400"`. A model code is trimmed and upper-cased
and must match `^[A-Z0-9][A-Z0-9 .,_/-]{0,39}$` (`NS60ZL`, `12N5-3B`, `12N6,5_3B`).
The comma is admitted because the catalogue itself serves codes such as `12N6,5_3B`
and `YB6,5_BS`.

Line and document amounts:

- a used line amount is `quantity × unit_price`, exact;
- a scrap line amount is `kg × price_per_kg` rounded **half up** to the cent,
  the rounding this contract accepts and its tests pin;
- the document `total` is the sum of every line amount, and
  `paid_cash + paid_transfer` must equal it exactly.

## The document

`purchases` — branch, model, note (≤500), `total`, `paid_cash`, `paid_transfer`,
the account that received it, `created_at`, and the reversal binding
(`reverses_purchase_id`, `reason`). `purchase_used_lines` holds one line per model
code (`quantity`, `unit_price`); `purchase_scrap_lines` holds one line per
material (`kg`, `price_per_kg`). `materials` is reference data: `1 Cobre`,
`2 Aluminio`, `3 Plomo`, `4 Bronce`, all in kilograms.

A document is **immutable**, carries **at least one line** between the two kinds,
and is corrected only by a **counter-document** that mirrors it exactly: the same
lines with negated `quantity` and `kg`, the same prices, negated `total`,
`paid_cash` and `paid_transfer`, and a stated `reason`. At most one counter-document
exists per original, both stay visible forever, and a counter-document is itself
immutable and can never be reversed.

A refused document writes nothing. The database decides the branch, the totals,
the sign rules and the mirror; the boundary publishes only its SQLSTATE
(`LP001` branch only, `LP002` totals mismatch, `LP003` reversal does not mirror,
`LP004` already reversed, `LP005` line or sign rule).

This document moves **no** `inventory_balances` row and extends no realtime
scope: the received totals are read on request by the screen that shows them.

## Routes

Every answer is JSON with `Cache-Control: no-store` and
`X-Content-Type-Options: nosniff`. A mutation requires the session's CSRF token
exactly as the other mutation routes do, and a `Content-Type` of exactly
`application/json` (an optional `charset=utf-8` only). The body is decoded token by
token: unknown keys, duplicate keys, wrong types and trailing input are
`400 invalid_request`.

### `POST /api/purchases`

```json
{
  "operation_key": "5f0b1c2d3e4f5a6b",
  "note": "",
  "used_lines": [{"model": "NS60ZL", "quantity": 1, "unit_price": "25000.00"}],
  "scrap_lines": [{"material_id": 1, "kg": "12.400", "price_per_kg": "8000.00"}],
  "paid_cash": "124200.00",
  "paid_transfer": "0.00"
}
```

`operation_key` matches `^[A-Za-z0-9_-]{16,128}$`. Either line array may be empty,
but not both. At most 190 lines per kind; `quantity` is `1..1000000`; money is
greater than zero; `kg` is greater than zero; `material_id` must exist. The same
operation key with the same payload answers the persisted document (`201`); with a
different payload it is `409 retry_conflict` and never a second document.

The answer is the persisted document:

```json
{
  "id": 7,
  "location_id": 2,
  "note": "",
  "total": "124200.00",
  "paid_cash": "124200.00",
  "paid_transfer": "0.00",
  "created_by_account_id": 3,
  "created_at": "2026-11-11T18:20:00Z",
  "reverses_purchase_id": null,
  "reversed_by": null,
  "reason": "",
  "used_lines": [{"model": "NS60ZL", "quantity": 1, "unit_price": "25000.00", "amount": "25000.00"}],
  "scrap_lines": [{"material_id": 1, "name": "Cobre", "kg": "12.400", "price_per_kg": "8000.00", "amount": "99200.00"}]
}
```

A counter-document answers the same shape with negative `quantity`, `kg`, `amount`,
`total`, `paid_cash` and `paid_transfer`, `reverses_purchase_id` set and a non-empty
`reason`. Used lines are ordered by model code, scrap lines by `material_id`.

### `GET /api/purchases?page=1&page_size=25`

`page` is `1..1000000`, `page_size` is one of `10`, `25`, `50`, and `25` when
absent. Newest first.

```json
{
  "page": 1,
  "page_size": 25,
  "total_purchases": 3,
  "purchases": [
    {"id": 7, "created_at": "2026-11-11T18:20:00Z", "total": "124200.00",
     "reverses_purchase_id": null, "reversed_by": null, "used_units": 1, "scrap_lines": 1}
  ]
}
```

`used_units` is the sum of the used quantities of the document (negative for a
counter-document) and `scrap_lines` is how many scrap lines it carries.

### `GET /api/purchases/{id}`

The persisted document exactly as `POST` answers it. An id that is not a positive
integer, does not exist, or belongs to another branch is `404 not_found`.

### `POST /api/purchases/{id}/reverse`

```json
{"operation_key": "6a7b8c9d0e1f2a3b", "reason": "pesaje mal tipeado"}
```

The client never supplies lines: they are derived from the persisted original.
`reason` is trimmed and must be `1..500` characters. The answer is the
counter-document with `201`. A target that is already reversed, or that is itself a
counter-document, is `409 already_reversed`; an unknown or foreign target is
`404 not_found`; the same operation key with the same target and reason is a
replay and answers the persisted counter-document.

### `GET /api/purchases/models`

```json
{"models": ["12N5-3B", "NS40ZL", "NS60ZL"]}
```

The distinct `model` values of the active catalogue entries (`deleted_at IS NULL`),
ascending, deduplicated across brands — "modelos sin repetir entre marcas". There
is no mirror list to maintain: a model created in the catalogue appears here by
itself. A model that is not in the catalogue is still typed freely in a purchase
and then shows up in `GET /api/purchases/received`, never in this list.

### `GET /api/purchases/materials`

```json
{"materials": [{"id": 1, "name": "Cobre"}, {"id": 2, "name": "Aluminio"},
                {"id": 3, "name": "Plomo"}, {"id": 4, "name": "Bronce"}]}
```

Reference data, ordered by id, all weighed in kilograms.

### `GET /api/purchases/last-prices`

The anchor the counter shows next to each input: the most recent price paid for a
model and for a material in this branch, taken from the latest line with a positive
quantity of a document that is not a counter-document.

```json
{
  "models": [{"model": "NS60ZL", "unit_price": "25000.00", "purchased_at": "2026-11-10T14:02:00Z"}],
  "materials": [{"material_id": 1, "price_per_kg": "8000.00", "purchased_at": "2026-11-10T14:02:00Z"}]
}
```

A model or material never bought in this branch is simply absent from its array.

### `GET /api/purchases/received`

What the branch has received, derived from every persisted document of the branch
(counter-documents net out):

```json
{
  "used": [{"model": "NS60ZL", "quantity": 12, "value": "300000.00"}],
  "scrap": [{"material_id": 1, "name": "Cobre", "kg": "120.500", "value": "964000.00"}]
}
```

`value` is the sum of the line amounts, so it is the money the branch spent. Rows
whose net quantity or weight is zero are omitted; used rows are ordered by model
code and scrap rows by `material_id`.

## Refusals

| Status | Token | When |
|---|---|---|
| `400` | `invalid_request` | a shape, bound, decimal or rule of this contract is broken |
| `403` | `forbidden` | the identity is not a provisioned branch account of an active branch |
| `404` | `not_found` | the document is unknown, foreign to the branch, or the path is ambiguous |
| `409` | `retry_conflict` | the operation key already exists with a different payload |
| `409` | `already_reversed` | the target already has its counter-document, or is one |
| `503` | `service_unavailable` | the store is unreachable or the persisted state fails closed |
