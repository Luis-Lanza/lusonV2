# Otros productos en stock, ingresos y ajustes

Feature branch `feat/other-products-stock`, cut from `master` `cff8ec0`. The catalog already
has a second kind (`feat/other-products-catalog`, merged): an `other` product is a free
`name` with typed custom fields, no brand/model/capacity/polarity, exactly one
polarity-less variant, and a zero balance row in every active location. This vertical
makes that product visible in the warehouse stock screen and acceptable in stock ingress
and stock adjustments. Price, branch counting and transfers stay out.

## Specs

S1. The stock screen lists both kinds in one list. A row is a name plus a detail, and the
detail is where the kind shows: a battery row reads `CAR · NS40ZL` / `35 Ah · L`, a product
row reads `Agua acidulada` / `volumen en L: 5 L`. The user's words for the row:
"Nombre más resumen de campos (Ejemplo: \"Agua acidulada · 5 L\". Los campos tipados son el
punto de tenerlos: mostralos)".

S2. The stock screen filters by kind with a control that offers all three states: both,
batteries only, products only. The user's answer: "Dos solapas: Baterías y Otros productos"
for the pickers, and the stock list is the one surface where both kinds are visible at once.

S3. `/api/inventory` keeps behaving exactly as today for every existing caller: with no
`kind` parameter it answers batteries only. A caller opts into the rest with
`kind=all|battery|other`. The closing count sheet, which reads this endpoint for branch
stock, is therefore unchanged and still counts no product.

S4. An ingress document is of one kind and never mixes. The user's words: "un ajuste puede
ser solo de baterias o solo de otros productos, no mezclar", extended to ingress by their
answer "No, un ingreso es de un tipo (El documento declara su tipo y el selector muestra sólo
ese tipo)". The kind is chosen before the catalog appears: artboard
`03-ingreso-tipo-primero.html` is the chosen direction, and the two others are alternatives.

S5. The kind of a document is derived from its lines, never stored: a request whose lines
name variants of both kinds is refused whole with `400 invalid_request`, and so is one that
would leave the document with an unknown kind. No migration is added for this vertical.

S6. The ingress catalog keeps its battery table unchanged and offers the product table as
`Producto · Detalle · Stock actual · Acción`, searching products by name and by the content
of their fields. The ingestion of a line is still a variant id and a quantity: nothing in
the wire line carries a battery attribute.

S7. A document must be readable after it is written: the ingress detail and the adjustment
detail label a product line without inventing battery attributes, and never fail because a
row has no brand. Today an adjustment on a product is applied and then its detail answers
`503`, and an ingress line for a product is refused only by a Go predicate.

S8. Adjustments gain the same two tabs and the same one-kind rule, with a `Tipo` column in
the history that lists documents of both kinds and adds no second list. The blind count is
preserved word for word: "Conteo ciego. No se muestra el stock esperado. Cargá lo que
contaste; la diferencia se conoce al aplicar." The product picker is
`Producto · Detalle · Contado` — no capacity, no polarity, no expected stock.

S9. Existing copy is preserved verbatim where it already exists:
"Registrá la mercadería que entra al depósito. El stock se aplica recién al confirmar.",
"Todo o nada: si una línea es inválida no se aplica ninguna. Una vez confirmado, el
documento no se edita ni se borra: se corrige con un contra-asiento que deja ambos
registros.", "Cada ajuste es un documento inmutable con el esperado, lo contado y la
diferencia. Las correcciones son contra-asientos."

S10. Authority does not change: only the warehouse administrator (account 1 in location 1,
with the password changed) reads and writes these surfaces; an anonymous caller gets `401`
and a branch account `403`, writes keep CSRF and same-origin, and a query string on a write
is `400`.

S11. Branch stock and transfers keep handling batteries only in this vertical. A product
can hold a positive balance in the warehouse and be unselable, because it has no price:
that is the next vertical, not a defect here.

## Contract

The variant identity every screen reads, replacing the battery-only shape:

```
{ "variant_id": 210,
  "kind": "other",
  "name": "Agua acidulada",
  "detail": "volumen en L: 5 L",
  "battery": null,
  "fields": [ { "name": "volumen en L", "kind": "number", "unit": "L", "number": "5" } ] }
```

For a battery: `kind` `"battery"`, `name` `"CAR · NS40ZL"`, `detail` `"35 Ah · L"`,
`battery` `{ "brand": "CAR", "model": "NS40ZL", "capacity_ah": "35", "polarity": "L" }`,
`fields` null. `name` and `detail` are never empty; `detail` is composed by the server so
every surface agrees, joining the first three fields as `nombre: valor unidad` with ` · ` and
appending ` · +N` when more exist.

Endpoints touched, all under the existing authority and envelopes:

- `GET /api/inventory` — new `kind=all|battery|other`, default `battery`. Items carry the
  identity above plus `existing`, `reserved`, `available`.
- `GET /api/stock-adjustments/catalog` — new `kind=all|battery|other`, default `battery`.
- `POST /api/stock-entries` — unchanged body; lines whose variants mix kinds are refused.
- `POST /api/stock-adjustments` — unchanged body; same refusal.
- `GET /api/stock-entries/{id}`, `GET /api/stock-adjustments/{id}` — lines carry the identity
  above instead of requiring brand, model, capacity and polarity.

Errors: `400 invalid_request` (a mixed document, an unknown `kind`, a malformed identity),
`401 unauthenticated`, `403 forbidden`, `404 not_found`, `409` conflicts as today,
`503 service_unavailable`. A document that mixes kinds answers `400` and writes nothing.

## Tasks

- T1 — Server identity contract. `internal/inventory`, `internal/stockentries`,
  `internal/stockadjustments`: one identity type with `kind`, `name`, `detail`, optional
  battery attributes and optional fields; `kind` query on inventory and the adjustment
  catalog with the battery default; per-kind validation replacing the battery-only guards;
  mixed-document refusal in both writes. Route: parent, inline, test first. Commit: T1.
- T2 — Stock screen. `apps/web/src/model.ts`, `useInventory.ts`, `App.tsx`: parse the union,
  render name plus detail, filter by kind, keep the battery columns meaningful. Route:
  parent, inline, test first. Commit: T2.
- T3 — Ingress. `stockEntryModel.ts`, `StockEntry.tsx`, and the server list read: kind chosen
  before the catalog, product table and search, product lines in the document and in the
  history detail. Route: parent, inline, test first. Commit: T3.
- T4 — Adjustments. `stockAdjustmentModel.ts`, `StockAdjustment.tsx`, adjustment catalog and
  detail reads: two tabs, product picker without capacity or polarity, `Tipo` in the
  history, blind count intact. Route: parent, inline, test first. Commit: T4.
- T5 — Docs and evidence. `apps/api/docs/other-products.md` extended, README index,
  `make test-pg` plus the web suite, and this log closed. Route: parent, inline.
  Commit: T5.

## Log

L1. User's request, verbatim: "bien, entonces ahora almacen tambien debe en almacen estos
productos y ademas en ingresos igual se deben hacer ingresos de estos productos nuevos que
se crean en catalogo! explora y dime como podemos hacerlo aun no implementes nada".

L2. Exploration found the variant identity hard-wired as battery in four layers (query
predicate, Go read guards, HTTP DTO, web parser), that the ingress picker reuses
`GET /api/inventory`, and that an adjustment on a product is accepted and applied today
while its detail fails closed.

L3. User, on adjustments: "lo que me refiero es que hay un seccion de ajustes que es
exclusivo para baterias, como seria ahora en este caso?" Then, on scope: "mmmm explora bien
porque hay una seccion de ajustes... sigue explorando la vertcial aun no hagas codigo".

L4. Exploration of adjustments: one dedicated section (`#/ajustes`), and warehouse counting
happens only there because closings cover branches 2..N. Its write path has no kind guard
anywhere; only the detail read breaks. Three decisions followed: an adjustment is of one
kind and never mixes ("no mezclar"); the history keeps one list with a `Tipo` column; the
product picker drops capacity, polarity and expected.

L5. Decisions on ingress: "No, un ingreso es de un tipo"; picker with "Dos solapas: Baterías
y Otros productos"; stock row shows "Nombre más resumen de campos".

L6. Design `design/other-products-stock/` written and approved: "me gusta en general como se
ven". Artboards: `01-stock-dos-tipos.html` (stock screen), `02-ingreso-tipo-declarado.html`
and `03-ingreso-tipo-primero.html` (ingress, two directions), `04-ajustes-dos-solapas.html`
(adjustments). The ingress direction chosen for implementation is `03-ingreso-tipo-primero`;
`02` stays as the alternative. No `feature` link was needed when the boards were written.

L7. Design self-check: boards use only system tokens (wine, hover, tint, page, border, muted,
ink, surface, soft and modal shadows, action-alert), `sans-serif` only, no external resource.

L8. T1 delivered (`e45afbe`). `catalog.Identity` is the one shape both languages validate
against, the number and field grammar of `otherproducts` moved into it, `/api/inventory` and
the adjustment catalogue apply `kind` with the battery default, and both writes refuse a
mixed document before any insert. A product adjustment now reads back instead of failing
closed.

L9. T2 (`9beb070`) hit the real size of the change: `Item` in the web model is read by
transfers, the transfer cart and its recovery, the ingress catalogue and the closings count
sheet, so changing it broke ten files. Decision: the readers travel in the same change
rather than leaving the branch uncompilable, `catalog_entry_id` returns to the wire where
transfers and pricing key on it, and `kind=all` is reserved to the warehouse. The strict
parser was not relaxed for any legacy fixture; the fixtures moved to the identity.

L10. T3 (`27e02fd`). Ingress asks the kind before showing a catalogue, the product picker
searches name and field content, and a product line reads back in the draft, the detail and
the history. Two corrections: the kind control and the kind query now both follow the
listed location, so neither promises what the other does not serve. A differential probe
over 186 battery-only queries was identical before and after.

L11. T4 (`d683fcf`). The history derives each document's kind from its lines and publishes
no kind when they disagree, because a document written before the one-kind rule could mix
them; the screen shows a dash. Two tabs in the drawer, product picker without capacity,
polarity or expected, blind count untouched.

L12. T5 and closing evidence. `inventory-api.md`, `stock-entries.md`,
`stock-adjustments.md`, `other-products.md` and `README.md` now describe the code as it is.
The full suite then caught a real regression of T1 that no focused run could see:
`internal/transfers` `TestUR4PopulatedPrefixUpgrade` built `inventory.Item` by hand and
compared it with the store's read through `reflect.DeepEqual`, so the embedded identity the
store now fills made every row differ. The fix composes the identity with the production
constructor (`catalog.Row.Identity`) exactly as the store does; the comparison was not
loosened, and two mutations (a divergent name, a one-unit stock change) proved it still
fails on a real difference. `make test-pg` is green in one cycle over every package and the
web suite is green with 4046 tests.

L13. Independent verification (Risk items 3 and 1) reproduced the whole vertical against
the base binary on the same database: 23 battery queries identical, a mixed document
refused with its balances unchanged (md5 equal before and after), a product ingress and
adjustment written and read back, the blind count verbatim, a branch still battery-only,
and the contract keys exact. It found one blocker: the adjustment detail chose its table
shape from `lines[0]`, so a document whose lines disagree — writable by the base binary,
whose detail then answered 503 — rendered one row where two were persisted. Each line is
now rendered by its own identity, one table per kind, and the regression test asserts both
rows of a mixed document with their own shapes. The same round pinned S3 with a test that a
stocked product whose name matches the search never enters a default listing, and widened
the product search to field names and units, so a term the row displays finds the row.
`make test-pg` is green over all twenty packages and the web suite is green with 4047 tests.
