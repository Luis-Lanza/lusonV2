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

`units[].warranty_months` is an integer 1 to 120 or JSON `null`; the key is always present, never absent and never zero. `len(units)` equals `quantity`. `customer.address` is a string of at most 200 characters, empty when absent. The body limit rises from 64 KiB to 256 KiB and one sale carries at most 1000 units in total, so the documented limits stay reachable.

The answered document replaces the line's `warranty_months` with its `units` array, and the history row gains `units_total` and `units_with_warranty` so S5 holds without unfolding.

## Tasks

| ID | Spec | Route | Work | Commit |
| --- | --- | --- | --- | --- |
| T1 | S1-S3, S7, D2-D4 | inline | Migration 031: `sales.customer_address`, `sale_units`, drop `sale_lines.warranty_months`, ordinal and quantity-equality triggers, insert-only guard, normalized unique serial; schema tests | pending |
| T2 | S2-S4, D3 | worker | Go domain: `Unit`, `LineInput.Units`, canonical serial, nullable term, unit count versus quantity, `Customer.Address` | pending |
| T3 | S5, D1-D3 | worker | Go store: insert units, read them back in the sale, its detail and its history counts | pending |
| T4 | S1-S5, D6 | worker | Go HTTP: token-exact nested decode, DTOs, guards, errors, `sales.md` | pending |
| T5 | S6 | worker | Warranty PDF: one row per unit with serial and term or "Sin garantía" | pending |
| T6 | S1-S4, D6 | worker | Frontend model: wire types, parsers, `prepareSale`, canonical payload and its echo check | pending |
| T7 | S2-S4, D5 | worker | POS screen: one row per unit with serial and term, optional term, bulk apply | pending |
| T8 | S5, S1 | worker | History screen: per-unit serial and "Sin garantía", address in the detail | pending |
| T9 | all | inline | Full verification: go build/vet/tests against the fixture, vitest, typecheck, build, lint, then an independent read-only verifier for risk item 1 | pending |

## Log

L1. "bueno para mi la siguiente vertical sera: durante la venta, en el punto de venta!, se debe poder agregar 2 datos mas!, Direccion/Barrio, numero de serie de cada bateria, y duracion de la garantia. esta debe ser un numero que se introduce que representa los meses!. Ademas debe poder serleccionarse como opcional el asignarle garantia a cada bateria en caso de ser una venta multiple. Si se realizo una venta sin garantia debe quedar registrada en el el historial como que esa venta o esa bateria especifica de esa venta no tenia garantia! cachas? pero si se llevan muchas baterias, debe poder asignarse una garantia diferente a cada bateria me vas entendiendo?"

L2. Serial scope: "aqui no te preocupes mucho por eso!, el numero de serie lo leera el vendedor en ese momento y lo anotara, solo es para trackear la bateria que se llevo el cliente, no para que este registrada en cada bateria de la sucursal, cachas?" — no serial registry, no stock identity.

L3. Address shape: "Un solo campo libre".

L4. PDF without any warranty: "Se emite y dice «sin garantía»".

L5. Existing real sales: "No: sólo dev, sin ventas".

L6. Findings that fix the base: `sale_lines.warranty_months` already exists as a mandatory 1..120 term per line (`apps/api/migrations/025_sales.sql:89`); `sale_lines` has `PRIMARY KEY (sale_id, variant_id)` (`:91`), so one line holds quantity > 1 and cannot carry one serial; every catalog entry is a battery (brand, model, capacity, polarity), there is no accessory concept, so serial and warranty apply to every unit; there is no address field anywhere in the sales contract.
