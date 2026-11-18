# Other products in the transfer engine

Feature branch `feat/other-products-transfers`, cut from `master` `d22de04`. The transfer
engine is already kind-neutral where it matters: every transfer table keys by
`variant_id` and carries no battery attribute (`003`–`020`), and reserving, dispatching,
receiving, cancelling, correcting and restituting touch `inventory_balances` only. A
product is one catalogue entry with exactly one polarity-less variant, so it is already a
first-class item there. What blocks it is a read and a picker: `transfers/store.go:204`
projects `brand/model/capacity_ah/polarity` without a coalesce, so any document holding a
product fails `ErrUnavailable` in every path that loads it, and the branch inventory
screen hides the kind switch for its own location. Selling products at the counter and the
branch count sheet stay out.

## Specs

S1. A transfer document carries one kind: batteries or other products, never both. The
user's words: "1. no, solo es de un tipo". The kind is chosen before the catalogue
appears, the same way ingress asks it, and it is **derived from the document's own
lines**, never stored: a body whose lines name variants of both kinds is refused whole
with `400 invalid_request` and writes nothing.

S2. This vertical adds **no migration**. `transfer_requests`, `transfer_request_items`,
`transfer_request_allocations`, `transfer_receipt_lines`, `transfer_receipt_exceptions`,
the count-correction, restitution, dispatch-reconciliation, unified-reconciliation and
recovery tables are keyed by `(request_id, variant_id)` and quantities only. No transfer
trigger mentions a catalogue kind, and no transfer column carries a polarity, a capacity,
a serial or a warranty.

S3. The line the server publishes is the shared catalogue identity, replacing the six
battery fields. The user's words: "2. reemplaza entonces pa". A line becomes
`{variant_id, kind, name, detail, battery, fields, quantity}` — the same shape inventory,
ingress, adjustments and prices already read — where a battery's name is
`marca · modelo` and its detail is `capacidad Ah · polaridad`, and a product's name is its
free name and its detail is the summary of its typed fields. `brand`, `model`,
`capacity_ah` and `polarity` disappear from the published transfer line.

S4. The published document names its own catalogue kind as `catalogue_kind` — never `kind`, a name
already taken by the request kind (`request_stock`/`send_to_warehouse`/`direct_shipment`) —
derived on read from its lines, and empty exactly when those lines disagree. Such a document
still renders, line by line, each in its own shape: a reader never picks one shape from the
first line. This is the rule the adjustment detail already carries, kept here so no read can
hide a line.

S5. Everything that moves stock stays untouched: approval reserves, dispatch deducts,
receipt credits, cancellation releases, count corrections and restitution each apply to
`(location, variant)` and nothing else. The one write-side predicate that must hold is the
origin availability check, which today filters a retired entry and must keep doing exactly
that for both kinds. No new availability rule is invented for a product with zero stock:
pending does not reserve, approval refuses the same way it refuses an empty battery.

S6. The origin picker offers one kind and only that kind. Searching inside the battery
kind keeps the columns it has; inside the product kind it reads the free name and the
content of the typed fields, because a term the row shows must find the row. A retired
entry is offered by neither.

S7. A branch can read its own product stock. The user's screenshot is the argument: the
warehouse screen counts 191 variants with the kind switch, and the branch of the same
database counts 190 with no switch at all. The kind control appears for a branch's own
location as well, and the branch read stops stripping the kind. Reading another location
remains read-only ("Solo consulta"), which is existing deliberate behaviour and does not
change.

S8. Receipt, count, restitution and reconciliation screens label each line by its own
identity, and none of them invents a battery attribute for a product or fails because a
row has no brand. The transfer cart, its recovery store and the pending list keep working
for both kinds.

S9. Existing behaviour is preserved word for word where it exists: the rule line
"Disponible = existencias − reservadas. Las unidades reservadas permanecen físicamente en
almacén hasta confirmación de salida.", the direction derived only from the authenticated
identity, idempotent creation by retry key and payload fingerprint, the propose → decide →
apply shape of every post-receipt operation, and the "Solo consulta" label of a location
that is not the caller's own.

S10. The published bounds and their wording are corrected, not widened: a document keeps
1..190 items, but the docs no longer claim an item "must belong to the immutable preloaded
catalog", because the catalogue now holds operational entries of both kinds.

S11. The point of sale, the branch count sheet of a closing, purchases and prices do not
change. A transfer moves stock; it never makes anything sellable and never counts in a
rendición.

S12. `apps/api/docs/transfers-api.md` documents the identity line, the document kind, the
one-kind refusal and the corrected bounds.

## Tasks

| ID | Specs | Route | Commit |
| --- | --- | --- | --- |
| T1 | S1, S3, S4, S5, S6 | worker `gentle-ai-worker` (`apps/api/internal/transfers`, `apps/api/internal/httpapi`) | `feat(transfers): read and publish the catalogue identity of a line` |
| T2 | S12, S10 | worker `gentle-ai-worker` (`apps/api/docs`) | with T1 |
| T3 | S1, S6, S7, S8, S9 | worker `gentle-ai-worker` (`apps/web`) | `feat(web): transfer either catalogue kind` |
| T4 | S5, S11 | parent inline (pins) | `test(transfers): pin that a product cannot enter a battery document` |
| T5 | all | independent `gentle-ai-verify` | — |

## Log

L1. "bien, comencemos por las transferencias, pero al implementar transferencias tambien
debe haber el inventario de otros productos en las sucursales no?"

L2. "exploremos y veamos como implementar transferencias reutilizando el motor, investiga
en codigo y en charlas persistidas en engram"

L3. Screenshots of the same database as `dev_sucursal_a`: viewing the warehouse shows
"Mostrando 1-10 de 191 variantes" with the tabs "Todas / Baterías / Otros productos";
viewing its own branch shows "de 190 variantes" and no tabs at all. The user's reading:
"si bien aqui en alamcen si se logra ver el stock de productos desde una sucursal en mi
sucursal no se puede ver mi stock de productos no?"

L4. "okey. 1. no, solo es de un tipo 2. reemplza entonces pa"

L5. Exploration (delegated, read-only) established with `path:line` evidence: the balance
fan-out is older than the second kind and kind-blind (`028:130` triggers `029:19-30`), so a
product already holds a zero balance in every active location and
`apps/api/internal/otherproducts/other_product_catalog_schema_test.go:166-169` pins it; a
branch can already read it through `GET /api/inventory?...&kind=other`; the transfer
schema carries no battery column and no kind-sensitive trigger; every stock-moving
statement is `(location, variant)`; the single blocking read is
`transfers/store.go:204-218`, which fails `ErrUnavailable` for a product in every path that
loads a document; and `transferItemDTO` (`httpapi/transfers.go:290`) is the only published
transfer shape that still speaks battery. The branch screens hide the kind switch at
`App.tsx:277` and strip it at `useInventory.ts:88,217`. The "Solo consulta" tabs make the
cross-location branch read deliberate, not a gap, so S7 keeps it.

L6. T1+T2 are `10c7b43` (812 authored lines: the read, the refusal, the published identity and the
docs). It is past the ~400-line slice and, as with the price matrix, it is structural: the line
shape is a single change the compiler holds together — the domain type, the store projection, the
HTTP DTO and every fixture that builds a line must move at once or `apps/api` does not build. The
web transaction stays its own commit. Review order: `transfers/contract.go` (`Item`, `NewItem`,
`CatalogueKind`), `transfers/store.go` (`mixedCatalogueKinds` and the identity projection),
`httpapi/transfers.go` (`catalogue_kind` beside the untouched `kind`), then the doc.

L7. Two surfaces were missing when the worker started and both were my error, not its: I listed two
`apps/api/internal/httpapi` filenames that do not exist, and I did not foresee that four transfer
HTTP test files pin the record's business-field count and build a line by hand. Approved both sets;
the counts (21→22, 16→17, 18→19) each gained an explicit `catalogue_kind` assertion beside them,
because a bumped number alone does not prove the field exists.

L8. The three "prefix upgrade" tests broke and the remedy was a design decision. Their premise was
"the store reads no post-prefix column": they installed migrations 001..018/019 and drove the
current store against that partial schema. The identity read needs `catalog_entries.kind` and
`name`, which 055 adds, so the premise is dead — and it never described production, because the
engine applies every missing migration in one locked transaction before serving. The fixtures now
complete the schema and seed the historical document with era SQL, and the UR4 comparison is
era-SQL truth against the current read, which is a stronger statement than before. No assertion was
dropped, relaxed or renamed; the reader and safety diffs are one call-site argument each.

L9. T3 is `da26e3f` and the counter/closing pin `3d9adc5`. While reviewing the web diff I checked the
one thing the feature is most likely to break by accident: the closing count sheet reads the branch
catalogue from `/api/inventory` with **no** `kind`, so it keeps the battery default, and it refuses a
row without battery attributes outright (`closingsAPI.ts:1118-1127`). There was no test pinning that,
so T4 adds one: a product row with real branch stock answers `invalid_response` to the sheet's read
and the read never asks for the other kind. That is S11 made checkable instead of assumed.

The feature's slice boundary: three commits, ~2.000 authored lines — the read and the refusal
(`10c7b43`, unsplittable because the line shape is one change the compiler holds together), the web
transaction (`da26e3f`, where two screens share decoders and four fixture files pin the wire), and
the counter pin (`3d9adc5`, independent). The web worker needed four surfaces I had failed to list,
and then one more (`transferDecisionRecovery.ts`) whose comparison guards an uncertain outcome: the
lesson is that a shape change enumerates its surfaces by *reading what the consumers do*, not by
grepping the type name, because the files that must change are the ones that *pin* the shape.

L10. Independent verification: **no blockers, S1–S12 satisfied**, on a packed copy of `da26e3f`
against a `git archive` of `d22de04`. The findings worth keeping:
- The battery wire is unchanged: six captured blocks (CREATE, two DETAIL, LIST, APPROVE, COUNTS) are
  field-by-field identical to the baseline once `items` is normalised and `catalogue_kind` removed.
  That is the evidence the contract change is exactly the two documented changes and nothing else.
- The mixed cart is refused with the database **byte-identical** (md5 over four tables, zero rows
  written) for all three request kinds, and the baseline answered `503` there — so the defect this
  vertical fixes was real, not theoretical: before it, a product simply could not be transferred.
- A product moves stock exactly like a battery: approve reserves, dispatch deducts, receive credits,
  cancel releases, and a correction and a restitution apply the same deltas. A product with zero
  stock is refused with the same `insufficient_stock` and writes nothing, and no balance went
  negative in any flow.
- The branch read is unchanged server-side: all eight requests answer byte-identically to the
  baseline, so S7 is a client-side change and could not have widened a server surface.
- S11 holds where it matters: a product stocked and priced still never reaches the counter listing
  nor the count sheet, and the sheet's read refuses a product row.
- One nuance recorded for honesty: the verifier's own probes were run with an `env -i` wrapper that
  had to forward `LUSON_TEST_PG_MANIFEST`; the fixture's admission requires it, and two earlier
  attempts failed for that reason alone.
