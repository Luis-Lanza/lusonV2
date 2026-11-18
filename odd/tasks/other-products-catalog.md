# Other products catalog

Third tab of the warehouse catalog: free-named products with typed custom fields,
living in the same catalog identity as batteries so the future transfer vertical
reuses the existing engine.

## Specs

S1. In Almacén, inside Catálogo, a third tab appears beside the existing two:
     "[precios] [baterias]" now also shows "Otros productos". The tab lists the
     products and allows creating them from that same screen.

S2. A product is identified by a free-form name, not by brand/model/capacity.
     The user's example is the product "Agua acidulada".

S3. A product carries custom fields assigned per product. Field types are
     number and text; a number field may declare a unit. The user's example:
     a field "volumen en L" that is numeric and holds "5L".

S4. Life cycle matches batteries: create, edit, retire. Retirement replaces
     physical deletion, exactly as the battery catalog already does.

S5. Quantities are integers, "Entera, como las baterías" — recorded here because
     it constrains the later transfer vertical, not because this vertical moves
     stock.

S6. Data model decision: one catalog identity with a kind discriminator
     (battery | other), and the later transfer vertical shares the existing
     transfer engine instead of a parallel one. This vertical delivers the
     catalog only: no price, no stock, no transfer.

## Contract (shared by T3 and T4)

Authority is the warehouse administrator, the same gate `/api/administration` and
`/api/catalog/batteries` use: account 1 in location 1 with a completed password
change. Branch administrator `403 {"error":"forbidden"}`, anonymous
`401 {"error":"unauthenticated"}`, missing CSRF or foreign origin `403`, and a
write carrying a query string `400`. Every response is `Cache-Control: no-store`.

| Method | Path | Success |
| --- | --- | --- |
| `GET` | `/api/catalog/other-products?search=&page=&page_size=` | `200` page |
| `POST` | `/api/catalog/other-products` | `201` record |
| `PATCH` | `/api/catalog/other-products/{id}` | `200` record |
| `DELETE` | `/api/catalog/other-products/{id}` | `204` |

Record, and the body of `POST`/`PATCH` is the same shape:

```json
{"id":113,"name":"Agua acidulada",
 "fields":[{"name":"volumen en L","kind":"number","unit":"L","number":"5"},
           {"name":"origen","kind":"text","text":"importado"}]}
```

Numbers travel as canonical decimal strings, exactly like `capacity_ah` does.
`PATCH` replaces the whole field set rather than merging it, matching how the
battery edit refuses a partial body.

Limits, all enforced by the server (the form is never the authority): name
3-64 bytes, trimmed, no control characters, unique among active products
ignoring case; at most 20 fields per product; field name 1-40 bytes, unique
inside its product ignoring case; `number` requires `number` and admits an
optional `unit` of 1-8 bytes; `text` requires `text` of 1-200 bytes and admits
no unit.

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

## Tasks

| ID | Spec | Route | Commit |
| --- | --- | --- | --- |
| T1 | S2, S3, S6 | inline (schema is shared, high risk) | `d7e4d64` |
| T2 | S1, S2, S6 | inline (shared read paths) | `a8e7a50` |
| T3 | S2, S3, S4 | worker, then a delegated fixture cycle | `14dda67` |
| T4 | S1, S2, S3, S4 | worker | `1ff867c` |
| T5 | S1-S6 | inline | this commit |

Slice boundaries, recorded because the cumulative feature is far past the review
slice: T1 is the schema and its exhaustive schema test (one commit, because an
unproven schema rule has no evidence), T2 is the kind predicate sweep plus its
leak test, T3 is the Go contract with its two suites, T4 is the web screen with
its three suites, and T5 is documentation only. Each commit stands alone and the
last one closes the feature.

## Log

L1. User request, verbatim:

> mira creemos una rama y quiero trabajar en lo siguiente!, en almacen debe haber
> una seccion donde se pueda crear productos, Ejemplo Agua acidulada, y se le
> puede asignar campos personalizados, por ejemplo creamos el producto
> Agua acidulada y se le puege agrar un campo que sea volumen en L que sea
> numerico y ahi colocar 5L.
>
> me entiendes? [Image#1] aqui en la imagen ya tenemos un catalogo actualmente,
> pero este catalogo es solamente de baterias quiero ahi crear una pestania nueva
> dentro de catalogo que diga "Otros productos" ahi arriba donde dice [precios ]
> [baterias] ahora debe haber otro que diga [Otros productos] y ahi se debe poder
> crear y ver los productos, me vas entendiendo?
>
> luego en otra vertical estos productos igual podran ser enviados en una
> transferencia hacia una sucursal exactamente igual que como hacemos con las
> baterias, pero de momento hagamos el catalogo.
>
> explora y dime quetal lo vez!

L2. User answers to the four scoping questions, verbatim:

> 1. ¿Dónde vive un "otro producto"? — que me recomiendas? porque esos otros
> productos igual deben ser enviados a las sucursales, creo que hacerlas por
> transferencia es lo mejor no? pero nose si deberia ser la misma transferencia
> que en baterias! talvez podriamos crear una transferencias que tenga las mismas
> condiciones se comporte similar con la resolucion de diferencies, pero solo
> para estos "otros productos"
> 2. Cantidad — Entera, como las baterías
> 3. Tipos de campo — Número y texto
> 4. Alcance — Crear, editar y retirar (paridad con baterías)

L3. Architecture answer after the recommendation: "Catálogo único + motor de
transferencias compartido".

L4. Branch `feat/other-products-catalog` created from master `d22fc0c`.

L5. Delivery strategy: one commit per task. T1 is deliberately the largest slice
(577 authored lines) because a schema rule that is not exhaustively proven by its
schema test has no evidence at all; it stays a single commit rather than being cut
into unproven halves. Every later task is a separate, smaller commit.

L6. T1 evidence: `go test ./migrations` green on the admitted fixture, including
the 028 and 029 schema tests. Commit `d7e4d64`. A first attempt replaced
`guard_catalog_variant_identity`, which silently dropped the retired-battery
refusal 029 owns; `TestCatalogVariantRetiredBattery` caught it and the rule now
lives in its own `protect_variant_kind` trigger, with the replacement forbidden in
the structure test.

L7. T2 evidence: `go test` green on `internal/inventory`, `internal/pricing`,
`internal/stockentries`, `internal/stockadjustments`, `internal/purchases`,
`internal/httpapi` and `migrations` in one fixture cycle. `TestOtherProductsStay-
OutOfBatteryScreens` proves a created product leaves the brand list at 11, the
inventory total at 190, the price matrix at 95 and matches no search. Commit
`a8e7a50`.

L8. T3 evidence: the delegated fixture cycle ran the whole `otherproducts`
package (8 database tests) and the whole `internal/httpapi` package (255s) green.
Two defects were found and both were in the parent's new database test, not in the
implementation: it inserted a battery identity the seeded fixture already owns
(`TOYO`/`NS40ZL`), and it asserted a field count of zero for a product created
without fields, which proved nothing. The second was strengthened rather than
weakened: the product is now created with the two example fields and the test
requires both rows to survive retirement with `number_value=5`, `unit='L'` and
the text intact. `go build ./...` and `go vet ./...` clean. Commit `14dda67`.

The number grammar departed from the handoff on purpose: `catalog.ParseDecimal`
is the positive capacity grammar, while the column is `numeric(18,6)` with no
positivity rule, so a number field admits a sign and zero. The web reader and the
SQL column already agreed with that reading.

L9. T4 evidence: `npm test` green twice (3981 passed, 1 skipped), plus
`npm run typecheck`, `npm run lint` and `npm run build`. The third tab keeps the
same warehouse gate, the per-owner remount and the hash symmetry of the other two
screens. Commit `1ff867c`.

L10. Declared gaps, not silently closed:
- `catalog_product_has_pending` is proven at the error-mapping layer only. The
database path needs the transfer engine, which is the next vertical.
- One `internal/httpapi` run failed once without a captured assertion and ten
subsequent runs were green, including the whole package. Unreproduced, not
retried.
- `testpg.Open` fails closed, so `go test ./internal/otherproducts` without the
fixture fails by design; the repository's own command, `make test-pg`, runs it
inside the audited fixture.

L11. Closing evidence: the whole Go suite on the fixture (`make test-pg`) ran every
package green except `internal/bootstrap`, whose `TestPostgres/schema_seed_and_preservation`
pins the exact inventory of base tables — and 055 adds `catalog_entry_fields`. That
is the assertion doing its job, not a defect in the migration: the table is
deliberate, so the inventory gained it with its own comment. `./internal/bootstrap`
is green again inside one fixture cycle after the correction. Everything else in
that same cycle was already green, including `internal/transfers` (442s) and
`internal/httpapi` (291s).

L12. Independent verification (Risk items 1 and 3) found a blocker the parent's own
leak test missed, and it was found by reproduction, not by reading:

- B1, blocker: the branch point of sale never gained the kind predicate, so with one
  product present `GET /api/sales/sellable` counted 191 instead of 190 and the later
  pages answered `503` — the POS paginates, so it was an ordinary path. Fixed in
  `internal/sales/store.go` on the shared filter, with
  `TestSellableCatalogueStaysBatteryOnly` pinned on five page/size windows.
- A2: `DELETE /api/catalog/batteries/{id}` answered 204 on a product id and retired
  it. The battery edit and archive now address `kind='battery'`, so a product id is
  `404` exactly like an unknown one, and
  `TestCatalogAdminBatteryRoutesNeverTouchProducts` also preserves the battery round
  trip.
- A4: the list's search was bounded by bytes while the shipped client bounds it by
  runes; the server now counts runes at the same 128 limit
  (`TestOtherProductsSearchBoundIsRunes`).

Gaps recorded rather than closed: the schema does not bound `text_value` length (the
server does; tightening it needs a new migration, because an applied version cannot
change its checksum), identifier validations reached only by crafted ids in
adjustments, closings and the price entry probe carry no kind predicate, and
`catalog_product_has_pending` is still proven at the mapping layer only.
