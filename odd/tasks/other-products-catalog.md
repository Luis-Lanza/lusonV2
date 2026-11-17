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
| T1 | S2, S3, S6 | inline (schema is shared, high risk) | — |
| T2 | S2, S3 | inline (dependent on T1) | — |
| T3 | S1, S2, S3, S4 | inline (dependent on T2) | — |
| T4 | S1, S2, S3, S4 | inline (dependent on T3) | — |
| T5 | S1-S6 | inline | — |

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
