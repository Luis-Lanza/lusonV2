# Branch prices for other products

Feature branch `feat/other-products-prices`, cut from `master` `e7870ec`. Stock, ingress
and adjustments already accept the second catalogue kind. The branch price list does not:
the write path already admits an `other` entry (`branch_prices` is keyed by
`catalog_entries`, so migration `026_branch_prices_by_battery.sql:20,49` accepts any
entry and `pricing/store.go:319` `entryExists` never looks at the kind), but the read
matrix is closed by `kind='battery'` (`pricing/store.go:163`) and the published row only
knows battery attributes. This vertical opens the read and the screen. Selling the
priced product at the point of sale, branch counting and transfers stay out.

## Specs

S1. The price screen lists **one kind per page**, chosen with the same two tabs the stock
screen already uses: "Baterías" and "Otros productos". The user's words: "yo quiero que
se pueda asignar precios por sucursales y tal cual como funciona en las baterias pero
este caso para los otros productos".

S2. `GET /api/catalog/prices` accepts `kind=battery|other`. **Absent means `battery`**,
so every answer that predates this change is unchanged. `all` is refused with
`400 invalid_request`: one page is one kind, because that is what the tabs ask for and a
mixed page has no second ordering key. The envelope is renamed to match: `batteries`
becomes `rows` and `total_batteries` becomes `total`. This is a deliberate breaking
change of a published shape whose only consumer is `apps/web`, which is updated in the
same vertical; `apps/api/docs/branch-prices.md` records it.

S3. A row is a discriminated union on `kind`, and the `prices` array is **identical for
both kinds** — that is what "igual que en las baterías" means here. A battery row keeps
`{kind, catalog_entry_id, brand, model, capacity_ah, polarities, cells, prices}`. A
product row is `{kind, catalog_entry_id, name, detail, prices}` and carries no capacity,
no polarity, no cells and no null battery field.

S4. A product row's name and detail are the identity the rest of the application already
publishes, never a second composition: the name is the free name and the detail is the
summary of its typed fields, so a row reads `Agua acidulada` / `volumen en L: 5 L`. The
user's words for this row shape, already accepted for the stock screen: "Nombre más
resumen de campos (Ejemplo: \"Agua acidulada · 5 L\". Los campos tipados son el punto de
tenerlos: mostralos)".

S5. The price itself does not change. Same two amounts (`min_price` and
`suggested_price`, canonical two-decimal text, `suggested >= min`), same
`PUT {catalog_entry_id, min_price, suggested_price, branch_ids}` body, same upsert that
replaces and never deletes, same warehouse-only authority (account 1 in location 1),
same refusal of the warehouse as a price destination, same `LP00N` guards, same error
codes. A product has exactly one polarity-less variant, so its single entry row already
covers it: there is no per-variant price and no second table. The database keeps
deciding, so this vertical adds **no migration**.

S6. Search is the only filter that differs. `search` keeps matching brand and model for
batteries and also matches the free name and the content of the typed fields for
products, the same rule already shipped for the product picker in adjustments: a term
the row displays must find the row. `brand` and `capacity` are battery filters; naming
either one together with `kind=other` is refused with `400 invalid_request` rather than
silently ignored.

S7. The screen keeps its shape instead of gaining a second one: same table, same two
amount fields, same one checkbox per active branch, same "assign to every branch"
behaviour by checking them all. On the product tab the capacity selector and the
"un mismo precio para las dos polaridades" legend disappear, and the first column header
reads `Producto` instead of `Batería`, because none of those three things exists for a
product.

S8. Nothing becomes sellable. `internal/sales/store.go` keeps `kind='battery'` in the
sellable filter, so a priced product is still invisible at the point of sale and the
`LV003` refusal keeps its wording. Delivering a price does not open a sale; the user's
words: "si acepto aun no metamos POS aqui!".

S9. `apps/api/docs/branch-prices.md` documents the new filter, the renamed envelope, both
row shapes, the two refusals of S2 and S6, and says in one line that a price does not
make a product sellable. The README line for the screen stays true; if it names only
batteries, it is corrected.

## Tasks

| ID | Specs | Route | Commit |
| --- | --- | --- | --- |
| T1 | S2, S3, S4, S6 | parent inline (`apps/api/internal/pricing`) | `feat(prices): read the matrix of both catalogue kinds` |
| T2 | S2, S3, S5, S9 | worker `gentle-ai-worker` (`apps/api/internal/httpapi`, `apps/api/docs`) | `feat(prices): read the matrix of both catalogue kinds` |
| T3 | S1, S7, S8 | worker `gentle-ai-worker` (`apps/web`) | `feat(web): price other products from their own tab` || T4 | S8, S9 | parent inline (pins + docs sweep) | `test(prices): pin that a price never makes a product sellable` |

T1 and T2 share one commit: the domain rename leaves `apps/api/internal/httpapi` uncompilable
until the published row is updated, so a commit carrying only T1 would not build. They are one
work unit — the read contract — of roughly 600 authored lines.

T3 also carries the battery catalogue screen: `apps/web/src/catalogPricesModel.ts` and
`catalogPricesAPI.ts` are shared by the price screen and by `CatalogBatteries.tsx`, which reads
the same matrix (`CatalogBatteries.tsx:67`, `catalogBatteriesModel.ts:225-234`). Renaming the
envelope and requiring `kind` is therefore one transaction across both consumers, and the
battery screen keeps its behaviour and copy untouched. Its surface: `CatalogPrices.tsx`,
`catalogPricesModel.ts`, `catalogPricesAPI.ts`, `catalog-prices.css` and their tests, plus
`CatalogBatteries.tsx`, `catalogBatteriesModel.ts`, `CatalogBatteries.test.tsx`,
`catalogBatteriesModel.test.ts`, `catalogBatteriesAPI.test.ts` and `App.test.tsx` for the old
envelope fixtures.

## Log

L1. "bien ya terminamos la vertical de otros productos"

L2. "recuerdas que esta vercial era hasta aqui, pero luego quedaba pendiente utilizar el
mismo motor de transferencias para enviar estos otros productos a las otras sucursales,
recuerdas?"

L3. "bien entonces nos falta poder agregarle precio a esos productos, explora como
funciona agregar precios desde catalogo a las baterias, debe ser similar pero para los
otros productos igual que agregar precios diferentes por sucursal, etc.\n\nexplora y dime
que encuentras antes de escribir codigo"

L4. "como me recoemiendas? \nporque yo quiero que se pueda asignar precios por sucursales
y tal cual como funciona en las baterias pero este caso para los otros productos"

L5. "si acepto aun no metamos POS aqui! entonces creamos una rama y arrancamos"

L6. Exploration (read-only, delegated to `gentle-ai-explore`) established, with
`path:line` evidence, the facts this document rests on: `branch_prices` is keyed by
`(branch_location_id, catalog_entry_id)` with no kind check (`026:20,49`, `024:22-30`);
there is no global price list and the warehouse is refused as a price destination
(`024:43`); a write is an upsert that replaces, and deletion is refused by trigger
(`024:57-65`); the read is closed by one predicate, `matrixFilter` (`pricing/store.go:163`);
row validation refuses a non-battery row as `ErrUnavailable` rather than rendering it
blank (`store.go:106-107,144-160`); the sale trigger resolves the entry from the variant
and is already kind-agnostic (`026:71-85`), while the POS filter is not
(`sales/store.go:692`). The write path already accepts an `other` entry today, which
makes this vertical a read-and-screen change and must be pinned by a test rather than
assumed.

L7. T1 landed green on the fixture (`./scripts/test-pg-fixture.sh run -- sh -euc 'go -C
apps/api test -count=1 ./internal/pricing'` → ok, 4.5s): the matrix reads both kinds, the
product row carries name plus field summary and no battery attribute, the absent kind is still
the battery listing, and the battery listing never answers a product even when the product's
name matches the search. Two corrections came out of writing the tests honestly: the search now
also matches the number and unit as the row displays them (`trim_scale(number) || ' ' || unit`),
because "5 L" typed by the operator found nothing while the row shows exactly that; and a test
that expected `kind=all` to be admitted was wrong — S2 refuses it.

L8. T3's first attempt stopped without editing and reported a real coupling: the read envelope
of this contract is shared by two `apps/web` screens, not one. `CatalogBatteries.tsx:67` builds
the same query and `catalogBatteriesModel.ts:225-234` reads `matrix.batteries` and
`matrix.total_batteries`, so the rename of S2 and the required `kind` break the battery
catalogue screen and four of its suites. The decision taken here is the worker's recommended
one: the rename is one transaction across both consumers, the battery screen is migrated with
its behaviour and copy unchanged, and no lenient parse admits the old keys — a silently
diverging screen would be worse than the wider diff. The alternative (two envelope sections,
one per kind) was rejected because it would freeze a split contract forever to save six files.

L9. T1+T2 are committed as `a0b7fc1` (reading and publishing the union, ~1.150 authored lines)
and the counter pin as `5d03d29`. This is deliberately past the ~400-line slice and the reason
is structural: the domain rename leaves `apps/api/internal/httpapi` uncompilable, so any commit
below that size would not build and would break bisection. The unquestionably separate pieces
are the counter pin (its own commit) and the web transaction (its own commit). Reading order for
review: `pricing/pricing.go` (the filter and the row), `pricing/store.go` (the query and the
per-kind row admission), `httpapi/branch_prices.go` (the published union), then the doc. The
worker proved the union with its own reading of the wire: five envelope keys, no
`batteries`/`total_batteries`, an eight-key battery row without `name`/`detail`, a five-key
product row without any battery key, and `"cells":[]` kept for a cell-less battery.

L10. T3 is `e4c8c8f`, after the parent re-ran the web checks itself rather than trusting the
worker's numbers: `npm --prefix apps/web run typecheck` clean and `npm --prefix apps/web test`
4082 passed / 1 skipped (baseline 4047, so +35), plus `lint` 181 files with 265 warnings against
a 267 baseline and a clean `build`. The worker's two decisions are recorded because they are
real: the product tab also hides the `Marca` selector (S6 refuses `brand` with the product kind,
so keeping it would make the screen send a 400), and the read now refuses a page that answers a
kind the caller did not ask for, so the screen can never mix shapes. The T4 sweep found nothing
left: `README.md` names no price at all, and the contract document was rewritten in `a0b7fc1`.

The slice boundary of this feature: three commits totalling ~2.100 authored lines — the read
contract (`a0b7fc1`, server only, unsplittable because the domain rename must compile), the
counter pin (`5d03d29`, independent and tiny), and the web transaction (`e4c8c8f`, both screens
that share the decoders). The seed fixture of `apps/web` was where the shape change surfaced as
red, which is why the web commit carries its migrated fixtures rather than a lenient parse.

L11. The full suite caught what the filtered run could not: `make test-pg` failed in
`internal/httpapi` with `TestOtherProductsStayOutOfBatteryScreens` — "seeded batteries: got 0 want
95". The cause was the rename, not the new behaviour: that test of the previous vertical decoded
the matrix into `TotalBatteries int64 \`json:"total_batteries"\``, and a renamed key does not break
a Go compilation — it leaves the field at zero. Fixed in `d6eb2c3` and re-proven green on the whole
package (`internal/httpapi`, 232s). The lesson recorded here: a contract rename must be searched by
key name across every decoder, including tests of other verticals, and the gate is the full suite,
never the filtered run. The same class of defect is what the web strict decoder would have caught
for free, because it rejects unknown keys instead of zeroing a field.

L12. Independent verification (state: no blockers, every S satisfied) ran its own probes on the
branch `d6eb2c3` against a `git archive` of `origin/master`: the absent-kind page is identical to
the baseline after the documented rename (95 batteries, same pages, same canonical money, same
`brand`/`capacity` filtering), the six refusal shapes answer `400 invalid_request` with a byte-equal
database snapshot, the product row is exactly `{kind,catalog_entry_id,name,detail,prices}` and a
battery row never carries `name`/`detail`, the unchanged `PUT` body prices a product for two
branches as two rows and replaces in place, the warehouse stays refused and `DELETE` still raises
`LP00N`, the product search answers by name, field name, unit and the displayed `5 L`, the product
tab hides `Marca`/`Capacidad`/legend and writes the four-key body, and the counter is untouched. Its
own probe of the matrix record also proved `total < rows` is refused.

Three advisories, all reproduced on the baseline and therefore outside this vertical:
1. `sales.Store.Create` accepts a sale of a *priced product* when a caller supplies the variant id
   directly. The counter (`Sellable`) excludes products, the write does not. This is exactly the
   surface the next vertical (selling products) must own — it is not a regression of this change and
   it is why S8 was written about the counter and not about the sale write. Declared gap, not fixed.
2. The doc's parameter template shows empty values (`?kind=&search=…`) while the same doc rejects
   them; pre-existing style, the baseline had it without `kind`.
3. `matrixFilter` searches `e.name` and `catalog_entry_fields` regardless of kind. Harmless today
   because the schema keeps a battery without a name and without typed fields, but a hand-inserted
   field row on a battery entry would widen a battery search. Recorded, not fixed.

The verifier's durable probes were not committed: they duplicate pins this feature already carries,
and adding four probe files to the review would raise the reading cost without adding a rule. Its
findings live here as evidence.
