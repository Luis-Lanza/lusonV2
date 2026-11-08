# Sale-level address and per-unit serial with optional warranty

Feature: `feat/sale-unit-serial-warranty` · Base: `feecf0a` (master) · Risk: item 1 (schema migration and a format change on `sale_lines`)

## Specs

S1. The sale records a free-text address/neighbourhood. User, L3: "Un solo campo libre". One optional field on the sale header, at most 200 characters, stored on the sale and visible in the sale detail and its history. A sale without an address is registered and shown as empty; 201 characters is refused.

S2. Every physical battery sold records the serial number the seller reads at the counter. User, L1: "numero de serie de cada bateria"; L2: "el numero de serie lo leera el vendedor en ese momento y lo anotara, solo es para trackear la bateria que se llevo el cliente, no para que este registrada en cada bateria de la sucursal". Free text, 1 to 64 characters after trimming, mandatory once per unit, never a reference to `inventory_balances` and never a stock identity.

S3. The warranty term belongs to the unit and is optional. User, L1: "duracion de la garantia. esta debe ser un numero que se introduce que representa los meses!" and "debe poder serleccionarse como opcional el asignarle garantia a cada bateria en caso de ser una venta multiple". Months are an integer from 1 to 120, or the explicit absence of warranty. There is no "0 months": absence is `null`, never zero.

S4. A multiple sale can assign a different term to each unit. User, L1: "si se llevan muchas baterias, debe poder asignarse una garantia diferente a cada bateria".

S5. A unit without warranty is recorded as such and named in the history, at both levels. User, L1: "Si se realizo una venta sin garantia debe quedar registrada en el el historial como que esa venta o esa bateria especifica de esa venta no tenia garantia!". The sale detail names each unit as "N meses" or "Sin garantía", and the history list tells the sale's position without unfolding it.

S6. The warranty PDF is always issued and names the absent warranty. User, L4: "Se emite y dice «sin garantía»". The document keeps its number, lists one row per physical unit with its serial and its term or "Sin garantía", and its row amounts still add up to the sale total.

S7. A sale without real data to migrate. User, L5: "No: sólo dev, sin ventas". The migration moves the term from the line to the unit without any backfill.

## Decisions

D1. The line stays commercial, the unit is physical. `sale_lines` keeps `PRIMARY KEY (sale_id, variant_id)` and `quantity`; a new `sale_units` table holds one row per physical battery. The `sale_lines.warranty_months` column is removed: a term per line cannot express a term per unit, and the unit is now the authority.

D2. The serial is unique in the system, compared after trimming and case folding. A physical battery cannot be sold twice, and a typo must be caught at the counter while the battery is in hand. A repeated serial refuses the sale with its own error code.

D3. Units are exactly as many as the line's quantity. A line of quantity 3 with two units is refused as a whole; the sale is atomic and nothing is stored.

D4. The sale stays immutable. Units are insert-only, like lines, and are never updated or deleted; a mistake is corrected forward, as with every other document in this repository.

D5. The seller keeps a per-line bulk action. Adding three units starts each with the same default term, and one action applies a term, or its absence, to every unit of that line, so a bulk sale is not eight manual entries.

D6. The wire contract, frozen here so the backend and the frontend can be built independently:

```
POST /api/sales
{"payments":[...unchanged...],
 "customer":{"name":"","phone":"","document":"","address":""},   // exactly 4 keys
 "lines":[{"variant_id":12,"quantity":2,"unit_price":"120.00",   // exactly 4 keys
           "units":[{"serial_number":"ABC123","warranty_months":12},   // exactly 2 keys
                    {"serial_number":"ABC124","warranty_months":null}]}]}
```

`units[].warranty_months` is an integer 1 to 120 or JSON `null`; the key is always present, never absent and never zero. `len(units)` equals `quantity`. `customer.address` is a string of at most 200 characters, empty when absent. The body limit rises from 64 KiB to **512 KiB** (T11: at 256 KiB the limit could not hold a thousand 64-character four-byte UTF-8 serials, measured at about 287 KiB) and one sale carries at most 1000 units in total, so the documented limits stay reachable.

The answered document replaces the line's `warranty_months` with its `units` array, and the history row gains `units_total` and `units_with_warranty` so S5 holds without unfolding.

D7. S1 reads "in the sale detail and its history": the address is answered in the creation document and in the sale detail, and it is **not** a key of the history list row, which D6 freezes. The history screen shows it when the sale is unfolded, which is where a reader looks for the client. Adding it as a list key would widen every row for a datum nobody scans.

D8. A repeated serial is refused as `409 serial_already_sold` with `{"error":"serial_already_sold","serial_number":"<trimmed serial>"}`. The client admits that code and names the battery, because a refusal that cannot say which serial is a refusal the counter cannot act on.

D9. Both sides canonicalize the address by trimming before they bound it and before they compare the answered document against the asked one. A trailing space must never turn a real sale into `invalid_response`.

## Tasks

| ID | Spec | Route | Work | Commit |
| --- | --- | --- | --- | --- |
| T1 | S1-S3, S7, D2-D4 | inline | Migration 031: `sales.customer_address`, `sale_units`, drop `sale_lines.warranty_months`, ordinal and quantity-equality triggers, insert-only guard, normalized unique serial; schema tests | `5e1ca4c` |
| T2 | S2-S4, D3 | worker | Go domain: `Unit`, `LineInput.Units`, canonical serial, nullable term, unit count versus quantity, `Customer.Address` | `f4023ef` |
| T3 | S5, D1-D3 | worker | Go store: insert units, read them back in the sale, its detail and its history counts | `f4023ef` |
| T4 | S1-S5, D6 | worker | Go HTTP: token-exact nested decode, DTOs, guards, errors, `sales.md` | `5870294` |
| T5 | S6 | worker | Warranty PDF: one row per unit with serial and term or "Sin garantía" | `0150251` |
| T6 | S1-S4, D6 | worker | Frontend model: wire types, parsers, `prepareSale`, canonical payload and its echo check | `c72bbda` |
| T7 | S2-S4, D5 | worker | POS screen: one row per unit with serial and term, optional term, bulk apply | `c72bbda` |
| T8 | S5, S1 | worker | History screen: per-unit serial and "Sin garantía", address in the detail | `c72bbda` |
| T9 | all | inline | Full verification: go build/vet/tests against the fixture, vitest, typecheck, build, lint, then an independent read-only verifier for risk item 1 | pending |
| T10 | S1-S5, D8-D9 | worker | Reconcile the two halves: the client trims the address before bounding and sending it (`trimmedText`, `pointOfSaleModel.ts:502` and `:592`; `canonicalAddress`, `salesAPI.ts:648`), admits `serial_already_sold` as its own strict `{"error","serial_number"}` refusal (`salesAPI.ts:17,30,44,601`) and keeps the refused serial on the error (`SalesErrorDetail.serial_number`, `SalesAPIError.serialNumber`), naming the rows that carry it (`serialSoldProblem`, `pointOfSaleModel.ts:315`, wired at `PointOfSale.tsx:306`). Evidence: RED `expected '  Av. América 123  ' to be 'Av. América 123'` and `SalesAPIError: invalid_response`, `Error: Respuesta inválida del servidor.` then `Received: «Ese número de serie ya se vendió…»` where the row-naming message was asked; GREEN focused 198 passed, full suite 3264 passed / 1 skipped, typecheck, lint (exit 0) and build green | `c72bbda` |
| T11 | S2, S7, D2, D6, D8 | worker | Close the independent verifier's findings: the new table joins the bootstrap schema whitelist, the body limit really admits a thousand widest units, the `23505` path never answers a serial refusal without its serial, and the no-backfill and concurrent-sale regressions get their own tests. Evidence: RED `integration_test.go:107: unexpected domain tables` (fixed by adding `sale_units` to the whitelist, `bootstrap/integration_test.go:106`); RED `sales_test.go:145: the widest admitted sale must fit the new body limit, got 287186 bytes` (fixed by `saleBodyLimit = 512 << 10`, `httpapi/sales.go:30`, with the widest-framing test rewritten to 64-character four-byte UTF-8 serials, `httpapi/sales_test.go:128`); RED `store_refusal_test.go:23: the index refusal must name the serial it was inserting, got ""` (fixed by `mapUnitFailure`, `sales/store.go:694` and its use at `:129`, because `mapFailure` alone sees only the database error); RED `sale_units_schema_test.go:97: the unit migration must move no data: SELECT` (the naive assertion tripped on the guards' own bodies, so the rule now reads the migration's top-level statements only, `topLevelStatements`, `migrations/sale_units_schema_test.go:135`); new `TestSaleConcurrentSellersOfOneSerialAdmitOne` (`sales/store_test.go:1864`): eight simultaneous sellers of one battery, one admitted, seven refused naming the serial, one `sale_units` row, stock moved once. GREEN: `build`, `vet`, `gofmt` clean and the full fixture suite green (`internal/bootstrap` and every other package ok). Note: a manufactured 23505 through two overlapping sales is impossible because `lock_transfer_balances` (`migrations/005_transfer_decisions.sql:44`) takes a transaction-scoped advisory lock on every `inventory_balances` write, so the concurrent producer is proven by the mapping's own test and the contention regression proves the refusal names its serial end to end | `f206db8` |

## Delivery

The change is larger than one reviewable slice (~3 200 authored lines, tests
dominating), so it is delivered as sequential slices on one feature branch, each
self-contained and green on its own, in this order:

| Slice | Contents | Risk | Commit |
| --- | --- | --- | --- |
| 1 | Feature document | none | `f85d667`, `b36ffb4` |
| 2 | Migration 031 and its guards | item 1 (migration, format change) | `5e1ca4c` |
| 3 | Domain and store of the sold unit | item 1 (atomicity of a sale) | `f4023ef` |
| 4 | The sale contract, its decoder and its document | none beyond 3 | `5870294` |
| 5 | One warranty row per sold unit | none | `0150251` |
| 6 | The counter and its history | none | `c72bbda` |
| 7 | Delivery evidence in this document | none | pending |

If a reviewer wants more than one pull request, slices 2-3 are the data
foundation and must merge first: 4-6 are meaningless against the old schema and
the old contract.

## Log

L1. "bueno para mi la siguiente vertical sera: durante la venta, en el punto de venta!, se debe poder agregar 2 datos mas!, Direccion/Barrio, numero de serie de cada bateria, y duracion de la garantia. esta debe ser un numero que se introduce que representa los meses!. Ademas debe poder serleccionarse como opcional el asignarle garantia a cada bateria en caso de ser una venta multiple. Si se realizo una venta sin garantia debe quedar registrada en el el historial como que esa venta o esa bateria especifica de esa venta no tenia garantia! cachas? pero si se llevan muchas baterias, debe poder asignarse una garantia diferente a cada bateria me vas entendiendo?"

L2. Serial scope: "aqui no te preocupes mucho por eso!, el numero de serie lo leera el vendedor en ese momento y lo anotara, solo es para trackear la bateria que se llevo el cliente, no para que este registrada en cada bateria de la sucursal, cachas?" — no serial registry, no stock identity.

L3. Address shape: "Un solo campo libre".

L4. PDF without any warranty: "Se emite y dice «sin garantía»".

L5. Existing real sales: "No: sólo dev, sin ventas".

L6. Findings that fix the base: `sale_lines.warranty_months` already exists as a mandatory 1..120 term per line (`apps/api/migrations/025_sales.sql:89`); `sale_lines` has `PRIMARY KEY (sale_id, variant_id)` (`:91`), so one line holds quantity > 1 and cannot carry one serial; every catalog entry is a battery (brand, model, capacity, polarity), there is no accessory concept, so serial and warranty apply to every unit; there is no address field anywhere in the sales contract.

L7. Independent verifier verdict on the finished candidate: S1-S7 and D1-D7/D9 met and asserted, BLOCKED by one gate defect — `sale_units` is missing from the bootstrap schema whitelist at `apps/api/internal/bootstrap/integration_test.go:106`, so the whole Go suite fails on `internal/bootstrap` while every sale, HTTP, warranty and migration suite is green (confirmed by `make test-pg`: all packages ok, FAIL). Three advisories: the 256 KiB body limit cannot hold a thousand 64-character non-ASCII serials (284 186 bytes measured), the `23505` mapping can answer `serial_already_sold` without the serial while the client rejects exactly that envelope, and S7's "no backfill" is unasserted. The verifier's own concurrency probe: eight simultaneous sellers of one serial, one admitted, seven refused by name.

L8. Delivery evidence. The whole Go gate is green in one fixture cycle: every package `ok`, `internal/testpg` first, teardown clean — including `internal/bootstrap` after the whitelist fix. The frontend is green: 3 264 tests passed and 1 skipped across 68 files, `tsc --noEmit` clean, lint at its 227-warning baseline with none of them in the touched files, and the production build succeeds. The independent verifier's verdict was BLOCKED on the single gate defect, now fixed; its three advisories are closed with their own tests (a 512 KiB body limit that really holds a thousand widest units, a `23505` path that never answers without its serial, and the no-backfill rule), plus the concurrent-sale regression it proposed. The dev instance was migrated to 31 and serves the new bundle, so the vertical is reviewable by hand.

L9. Native review of the data foundation. The whole-feature candidate was refused with `lens_context_budget_exceeded`: a candidate is the whole range from its base ref, so the nine work-unit commits did not make it smaller. The migration slice was therefore reviewed alone as `feecf0a..<migration commit>`. The reliability lens found one candidate-caused CRITICAL: the duplicate-serial guard was a bare `EXISTS`, so two concurrent sellers could both pass it and collide on the unique index with a `23505` the contract never promised. The correction declared 70 diff lines, used about 25, and gave the battery its own `pg_advisory_xact_lock` so the second writer waits and is refused with `LV009`; the index stays the last authority. A two-sale concurrency test proved impossible to write in this repository — every sale serializes on the balance lock first, so the probe deadlocked on my own fixture — and the mechanism is pinned in the schema structure test instead, honestly, as a mechanism assertion rather than a race proof. Verdict: APPROVED, authority burned (`gentle-ai.review-acknowledged/v1`). Two non-blocking advisories stand as later work, never as a reason to re-review: R3-002 (WARNING) at `sale_units_schema_test.go:253-259` and R3-003 (SUGGESTION) at `031_sale_unit_serial_warranty.sql:99-102`.
