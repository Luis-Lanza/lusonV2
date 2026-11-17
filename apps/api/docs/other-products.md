# Catalog other products

The warehouse administrator's second catalog kind. A battery is identified by a
brand, a model, a capacity and one or two polarities; an other product is
identified by a free name and carries typed custom fields. Both live in the same
catalog identity, so the balance matrix, the branch fan-out and the transfer
engine keep one item to work with instead of two.

## Where it sits

`catalog_entries` gained `kind` (`'battery'` | `'other'`) and `name`;
`brand`, `model` and `capacity_ah` stopped being table-wide obligations and became
a rule of the battery kind (`catalog_entries_kind_shape`). Every pre-existing row
defaults to `kind='battery'`, so no battery query changes meaning.

An other product owns exactly one **polarity-less** variant
(`catalog_variants.polarity` is nullable and `catalog_variants_single_other`
admits one such row per entry). The existing `initialize_variant_inventory`
trigger therefore opens a zero balance row in every active location without any
new code: availability is already modelled the way a transfer will need it.

This slice delivers the catalog only: no price, no stock, no transfer. Battery
screens do not list these products — `internal/inventory`, the price matrix, the
adjustment catalog and the purchase model suggestions all restrict themselves to
`kind='battery'`, and `internal/httpapi/other_product_leak_test.go` pins that.

## Authorization

Every route requires the warehouse administrator identity, the same authority
`/api/administration` and `/api/catalog/batteries` use: account 1 assigned to
location 1 with a completed password change. A branch administrator is refused
`403 {"error":"forbidden"}` and an unauthenticated caller
`401 {"error":"unauthenticated"}`. A mutation also needs the ordinary same-origin
and CSRF header check; a write with a query string is `400`.

## Routes

| Method | Path | Success | Meaning |
| --- | --- | --- | --- |
| `GET` | `/api/catalog/other-products?search=&page=&page_size=` | `200` page | Active products, name search |
| `POST` | `/api/catalog/other-products` | `201` record | Create the product, its variant and its fields atomically |
| `PATCH` | `/api/catalog/other-products/{id}` | `200` record | Replace the name and the whole field set of an active product |
| `DELETE` | `/api/catalog/other-products/{id}` | `204` | Retire the product, one way |

The body of `POST` and `PATCH` is the record without its id:

```json
{"name":"Agua acidulada",
 "fields":[{"name":"volumen en L","kind":"number","unit":"L","number":"5"},
           {"name":"origen","kind":"text","text":"importado"}]}
```

Numbers travel as canonical decimal strings, like `capacity_ah` does. `PATCH`
replaces the field set instead of merging it, matching how a battery edit refuses
a partial body.

## Limits

All of them are enforced by the server; the form is never the authority.

- Name: 3-64 bytes, trimmed, no control characters, unique among active products
  ignoring case. A retired product frees its name.
- At most 20 fields per product.
- Field name: 1-40 bytes, unique inside its product ignoring case.
- `number`: the `number` value is required and canonical — an optional minus, at
  most 12 integral and 6 fractional digits, which is the column's own
  `numeric(18,6)`; zero and negative values are values, so this is deliberately
  not the positive-only battery capacity grammar. `unit` is optional and 1-8
  bytes.
- `text`: the `text` value is required, 1-200 bytes; no unit.

## Errors

| Status | Code | Cause |
| --- | --- | --- |
| `400` | `invalid_request` | Non-canonical body, name, field or value, or a query string on a write |
| `401` | `unauthenticated` | No session |
| `403` | `forbidden` | Not the warehouse administrator, or a bad origin/CSRF token |
| `404` | `not_found` | Unknown product, or editing a retired one |
| `409` | `conflict` | An active product already holds that name |
| `409` | `catalog_product_has_stock` | Stock or reservations still reference the product |
| `409` | `catalog_product_has_pending` | An open transfer operation references the product |
| `503` | `service_unavailable` | The catalog authority is unavailable |

## Retirement

There is no physical deletion. Retiring is a one-way `deleted_at` update that
`catalog_entry_retirement_blocker` refuses while stock, reservations or an open
transfer operation still reference the product — the same gate the battery catalog
uses. The fields of a retired product are frozen rather than deleted, because the
product they describe is evidence of what was catalogued.
