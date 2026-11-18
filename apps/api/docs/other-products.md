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

## Variant identity

Every surface that names a variant reads one shape for both kinds, so a screen
never invents an attribute a row does not have. The kind is visible in the name
and the detail, and the two optional blocks carry the kind's own attributes:

```json
{ "variant_id": 210,
  "kind": "other",
  "name": "Agua acidulada",
  "detail": "volumen en L: 5 L",
  "battery": null,
  "fields": [ { "name": "volumen en L", "kind": "number", "unit": "L", "number": "5" } ] }
```

For a battery: `kind` `"battery"`, `name` `"CAR · NS40ZL"`, `detail` `"35 Ah · L"`,
`battery` `{ "brand": "CAR", "model": "NS40ZL", "capacity_ah": "35",
"polarity": "L" }` and `fields` `null`. A product always carries a non-null
`fields` array and a `null` `battery`.

`name` and `detail` are composed by the server, so every surface agrees: a battery
name is `brand · model` and its detail is `capacity Ah · polarity`; a product name
is its free name and its detail joins the first three typed fields as
`nombre: valor unidad` with ` · `, appending ` · +N` when more fields exist. A
product with no field falls back to its own name, because neither `name` nor
`detail` is ever empty. `capacity_ah` travels as the canonical decimal **text**
(`"35"`, `"6.5"`), like the rest of the catalogue.

## Where the second kind is visible today

The catalogue slice alone wrote no stock. The stock vertical
(`odd/tasks/other-products-stock.md`) puts the product into the warehouse ledger
and its documents, so these surfaces read and write both kinds:

- `GET /api/inventory` lists both kinds in one list behind the three-state `kind`
  parameter (`all` | `battery` | `other`, default `battery`); the stock screen and
  the ingress product picker read it. A product row carries its identity and the
  same three stock numbers a battery row carries.
- `POST /api/stock-entries` admits a product-only document, and its detail labels
  each product line with the product identity instead of failing on the missing
  brand.
- `POST /api/stock-adjustments` counts a product, `GET
  /api/stock-adjustments/catalog` offers the product picker behind the same `kind`
  parameter, its detail labels the product line, and the history states each
  document's `kind`.

A document of either write is of one kind and never mixes: the kind is derived
from its lines and never stored, so a body naming variants of both kinds is refused
whole with `400 invalid_request` and writes nothing.

These surfaces still handle batteries only in this vertical:

- Branch counting and every closing document. The closing count sheet reads
  `/api/inventory` with no `kind`, which is the battery-only listing, so it keeps
  counting no product and its count lines stay battery rows.
- Transfers, their items, receipts and reconciliations.
- Prices: the branch price matrix and the sale catalog, because a product has no
  price, and the purchase model suggestions.

That split is safe because the absent `kind` is the battery-only listing every
caller had before the second kind existed.
`internal/httpapi/other_product_leak_test.go` still pins those battery-only
answers: the default inventory listing, the brand list and the price matrix.

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
