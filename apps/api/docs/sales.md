# Branch point of sale (Punto de venta)

The point of sale is the branch's counter: it registers an **immutable sale document**
with one or more lines and decrements the stock of the branch that sold it. Only a
branch sells — "ojo que solo es en sucursales esto" — and only the branch's own
provisioned account registers a sale there: the warehouse (`Almacén`, account `1`
with location `1`) receives `403 forbidden` and never has this section.

The warranty number belongs to the document, not to the unit: one sale emits one
warranty, and every **physical battery** the sale carries is a row of its own with the
serial number the seller read at the counter and, optionally, the term stated for that
battery (`1` to `120` months). The term is **not** a catalogue datum: the price list
neither stores nor validates it, and the sale never consults a product warranty table.

The line stays **commercial**, the unit is **physical**: a line states the variant, the
sold quantity and the price, and a separate `sale_units` row holds one physical battery
per sold piece, with its serial and its own term. The units of one line are exactly as
many as its quantity, and one sale carries at most **1000** units.

The serial is what tracks the battery the client left with — "solo es para trackear la
bateria que se llevo el cliente" — never a stock identity: it is written down at the
counter, it is never looked up, and it has no counterpart in `inventory_balances`. It is
unique in the whole installation **after trimming and case folding**, because one
physical battery cannot be sold twice and a typo is cheaper to catch at the counter than
a year later.

The absence of a warranty is **sold data, not missing data**: a battery the client took
without warranty is stored with a `NULL` term, is answered as
`"warranty_months": null` in the sale and in its detail, is counted in
`units_with_warranty` in the history, and the warranty PDF names it "Sin garantía"
instead of printing a term. There is **no zero months**.

The sale also records the client's **address or neighbourhood**: one free-text field on
the document header, at most 200 characters, empty when the sale carries none.

The database is the final authority for the price rules. The charged price can never
go under the branch's stored minimum for the battery of the sold variant
(`below_minimum`), a variant whose battery has no price in that branch cannot be sold
at all (`variant_not_sellable`), and a sale the branch cannot cover is refused
(`insufficient_stock`). A refused document writes nothing: no sale, no line, and no
stock movement.

Money is a **canonical decimal string** end to end (`"85000.00"`), stored in
`numeric(12,2)` and never parsed into a binary float. The presentation format
`Bs 1.234,56` belongs to the client and to the warranty PDF, never to this contract.
Capacities are catalogue decimals **as strings** too (`"35"`, `"6.5"`).

How the total was paid is a **settlement of amounts, not a chosen label**: one sale
records how much was paid with each admitted method (`cash`, `card`, `transfer`), and the
amounts must add up to the total exactly. A sale can therefore be settled partly in cash
and partly by transfer. The label `payment_method` is **derived by the database** from
those amounts — `cash`, `card`, `transfer` or `mixed` — and is never an input.

## Authorization

The authenticated identity must be a completed branch session: an account with
`id > 1` assigned to an active location with `id > 1`, and a completed password
change. Authority always comes from the session — the request body never carries an
actor, a branch or a location, and a forged identity is not evidence of a branch.

Refusals by actor:

| Actor | Result |
|---|---|
| Branch account selling in its own branch | admitted |
| Branch account of another branch | `403 forbidden` |
| Warehouse (account `1`, location `1`) | `403 forbidden` |
| Branch without a provisioned account | `403 forbidden` |
| Session that must still change its password | `403 forbidden` |
| Retired branch or retired account | `403 forbidden` |
| No session | `401 unauthenticated` |

The store re-verifies the `auth_accounts` → `locations` binding before touching any
row, and the database refuses a sale whose branch is the warehouse as well, so the
sale scope is enforced twice.

## Routes

| Route | Method | Result |
|---|---|---|
| `/api/sales` | POST | `201` with the created document |
| `/api/sales` | GET | `200` with one page of the branch history |
| `/api/sales/sellable` | GET | `200` with one page of the sellable catalogue |
| `/api/sales/{id}` | GET | `200` with the document and its catalogue-resolved lines |
| `/api/sales/{id}/warranty.pdf` | GET | `200` with the warranty of the document as a PDF download |

Any other method is `405 method_not_allowed`: the collection advertises
`Allow: GET, POST` and the three reads advertise `Allow: GET`.

The mutation requires the usual same-origin session cookie, `Origin`,
`Sec-Fetch-Site: same-origin` and `X-CSRF-Token`; the reads require the session only.
A query string on the mutation is rejected.

`/api/sales/sellable` is registered as a literal beside `/api/sales/{id}`, so the
catalogue can never be read as a document id, and `/api/sales/{id}/warranty.pdf` is
registered as a literal suffix of the document, so the id is still one segment. Any other
path below the collection is `404 not_found` as JSON, and an ambiguous path is refused
before it can be cleaned or redirected: a doubled slash, a `.` or `..` segment, a
backslash, a NUL, or an encoded alias (`%31` for `1`, `%70ellable` for `sellable`) is
`404 not_found`.

## Create a sale

```
POST /api/sales
```

### Request

```json
{"payments":[{"method":"cash","amount":"40000.00"},
  {"method":"transfer","amount":"152000.00"}],
 "customer":{"name":"Cliente Mostrador","phone":"700-00000","document":"V-123","address":"Av. Colón 1234"},
 "lines":[{"variant_id":1,"quantity":2,"unit_price":"96000.00",
   "units":[{"serial_number":"ABC123","warranty_months":12},
            {"serial_number":"ABC124","warranty_months":null}]}]}
```

* `payments` is the settlement: `1` to `3` objects, each exactly `method` and `amount`.
  * `method` is one of `cash`, `card`, `transfer`, each **at most once** per document.
    The derived `mixed` is **never** an input: a body that sends it is
    `400 invalid_request`.
  * `amount` is how much was paid with that method, as **canonical two-decimal text
    above zero** (`"96000.00"`). A JSON number, `"96000"`, `"96000.5"`, `"0.00"` or a
    negative amount is `400 invalid_request`.
  * The amounts must add up to the total of the document **exactly**. The sum is the
    store's rule and the database's constraint, so a settlement that falls short or
    overshoots is `400 payments_mismatch` with the amount that is missing or left over
    (see [Errors](#errors)).
* `customer` holds exactly the four keys above. `name` is mandatory and is trimmed;
  `phone`, `document` and `address` may be empty. The address is one free field of the
  document header, trimmed, at most **200** characters. A text outside the database's
  own bounds is refused.
* `lines` holds `1` to `190` lines. Each line is exactly `variant_id`, `quantity`,
  `unit_price` and `units`:
  * `variant_id` is a canonical positive integer (the sold **polarity**).
  * `quantity` is a canonical positive integer, at most `1000000`.
  * `unit_price` is the price the counter charges, as **canonical two-decimal text**
    (`"96000.00"`). A JSON number, `"96000"`, `"96000.5"`, `"96000.001"`, `"0.00"`
    or a negative amount is `400 invalid_request`.
  * `units` carries one object per **physical battery** of that line, and its length must
    equal `quantity`: a line of three with two units is refused **as a whole**, so nothing
    is stored. Each unit is exactly `serial_number` and `warranty_months`:
    * `serial_number` is the serial the seller reads on the battery: free text, `1` to
      `64` characters after trimming, valid UTF-8 and without a NUL. It is stored
      trimmed, it is compared case-folded against every battery ever sold, and a repeated
      serial is `409 serial_already_sold` (see [Errors](#errors)).
    * `warranty_months` is **always present** and is either a canonical integer from `1`
      to `120` or JSON `null`. `null` is the explicit absence of warranty; the key is
      never absent and `0` is never the absence — `0`, a negative, a padded (`06`), a
      text or a floating value is `400 invalid_request`.
    * Two units of one line, and the units of different lines, may state different terms:
      that is what a per-unit term is for.
  * Each variant appears once: a repeated variant is `400 invalid_request`.
* One sale carries at most **1000 units** in total, so a document above that bound is
  `400 invalid_request` before any database work.
* The body limit is **512 KiB**: a sale admits 1000 units of the widest framing, and a
  thousand serials of 64 four-byte UTF-8 characters each measure about 287 KiB, so the
  largest document every stated bound allows is still reachable.
* Decoding is token-exact: unknown keys (`total`, `actor_id`, `branch_location_id`,
  `min_price`, `payment_method`, …), duplicate keys (including escaped-equivalent
  spellings), wrong types, missing keys, trailing input and a body that is not valid
  UTF-8 are all `400 invalid_request`. A key the body does not carry is never defaulted.

### Success

```json
{"sale":{"id":1,"branch_location_id":2,"branch_sequence":1,"warranty_number":"2-000001",
 "payment_method":"mixed",
 "payments":[{"method":"cash","amount":"40000.00"},
  {"method":"transfer","amount":"152000.00"}],
 "customer":{"name":"Cliente Mostrador","phone":"700-00000","document":"V-123","address":"Av. Colón 1234"},
 "total":"192000.00","created_by_account_id":2,"created_at":"2026-11-04T23:35:02Z",
 "lines":[{"variant_id":1,"quantity":2,"unit_price":"96000.00","min_price":"85000.00",
  "units":[{"serial_number":"ABC123","warranty_months":12},
           {"serial_number":"ABC124","warranty_months":null}],
  "subtotal":"192000.00"}]}}
```

| Field | Meaning |
|---|---|
| `id` | The sale document |
| `branch_location_id` | The branch that sold: always the actor's own location |
| `branch_sequence` | The branch's own correlative, allocated by the database |
| `warranty_number` | The warranty number of this document (see below) |
| `payment_method` | The **derived** label of the settlement: `cash`, `card`, `transfer` or `mixed` |
| `payments` | The settlement itself: one entry per method that actually paid, with its amount, in the frozen order `cash`, `card`, `transfer` |
| `customer` | The client of the warranty, exactly as persisted |
| `total` | The exact sum of the line subtotals, canonical |
| `created_by_account_id` | The session account that registered the sale |
| `created_at` | RFC3339 in UTC |
| `lines` | The persisted lines, ascending by `variant_id` |

Each line carries the **frozen** price of the sale: `unit_price` is what was charged,
`min_price` is the branch minimum in force at that moment, `units` are the physical
batteries that were sold — in the order the seller registered them, one per piece, each
with its `serial_number` (stored trimmed) and its `warranty_months`, which is an integer
or `null` — and `subtotal` is `unit_price × quantity` in integer cents.
`min_price` is never part of the request: it is the database's own reading of the
branch's stored pair for the battery of that variant. A later price change does not
alter an emitted document.

The answered document replaces the line's old line-level `warranty_months` with this
`units` array: the promise has one authority, the unit, and a line never states a term of
its own again.

`payments` and `payment_method` are two views of one fact and they always agree: the
label is what the amounts derive (`mixed` when more than one method paid, otherwise the
single method that paid). Methods that paid **nothing** are not part of `payments`, so a
single-method sale carries exactly one entry and the history keeps reading its
`payment_method` without the settlement.

### Warranty number

```
<branch id>-<sequence padded to 6 digits>
```

`2-000001` is the first sale of branch `2`; branch `3` starts its own numbering at
`3-000001`, so two branches never share a warranty number and never share a
correlative. Both values are allocated by the database under a branch lock; a client
can neither send nor influence them. The full document, including this number, is
what the warranty PDF renders.

## Read the history

```
GET /api/sales?search=&payment_method=&page=&page_size=
```

* `search` is a literal substring over the warranty number and the client name
  (case-insensitive); a `%` or `_` in the operator's own words never becomes a SQL
  wildcard.
* `payment_method` filters by a label the document can carry: one of `cash`, `card`,
  `transfer` or the derived `mixed`. An unknown or empty label is `400 invalid_request`.
* `page` is a canonical integer from 1 to 1000000 and defaults to 1.
* `page_size` is one of `10`, `25`, `50` and defaults to 25.
* The query is token-exact: repeated parameters, unknown keys, empty values, a bare
  `?` and non-canonical integers (`01`, `+1`, `1e3`, `1.0`, `%31`) are all
  `400 invalid_request`. Parameter order is irrelevant.

The history is always the actor's own branch, newest first. A sale of another branch
is simply absent from it.

```json
{"page":1,"page_size":10,"total_sales":1,
 "sales":[{"id":1,"branch_sequence":1,"warranty_number":"2-000001",
  "payment_method":"mixed","customer_name":"Cliente Mostrador","total":"192000.00",
  "created_at":"2026-11-04T23:35:02Z","lines":1,
  "units_total":2,"units_with_warranty":1}]}
```

| Field | Meaning |
|---|---|
| `page`, `page_size` | The admitted page |
| `total_sales` | Every sale of the branch matching the filters, independent of the page |
| `sales[].id` | The document, for the detail read |
| `sales[].branch_sequence`, `warranty_number` | The database's own document numbers |
| `sales[].payment_method` | The derived label of the settlement, so a mixed sale is a legible and filterable row |
| `sales[].customer_name`, `total`, `created_at` | The rest of the document header |
| `sales[].lines` | How many lines the document holds (a count, not the lines) |
| `sales[].units_total` | How many physical batteries the sale carries |
| `sales[].units_with_warranty` | How many of those units were sold **with** a warranty; the rest were taken without one, so the history names an unwarranted sale without unfolding it |

A sale issued **before** this contract has no units at all: its lines were stored when a
term belonged to the line and a serial was not recorded. Such a document answers
`units_total: 0` and `units_with_warranty: 0`, and it is history, not corruption and not
"no warranty" — the history names it as a document without recorded series, and the detail
answers an empty `units` array per line. A document that carries some units but fewer than
its sold pieces is a different thing: it is refused, because a partly recorded sale cannot
be described without inventing what is missing.

A page beyond the last one is legitimately empty and reports the same `total_sales`.
The history never carries prices, the settlement, the serials or the address: the detail
read does. It does carry the two unit counts, so a battery sold without warranty is
legible from the list itself. A mixed sale is selected with `payment_method=mixed`, and the single-method
filters (`cash`, `card`, `transfer`) never select it.

## Read one sale

```
GET /api/sales/{id}
```

`{id}` is a canonical positive integer. A segment that is not one (`abc`, `0`, `01`,
`-1`) is `404 not_found`, exactly like an unknown document, and a sale of another
branch is not found either. A query string on this read is `400 invalid_request`.

```json
{"id":1,"branch_sequence":1,"warranty_number":"2-000001","payment_method":"mixed",
 "payments":[{"method":"cash","amount":"40000.00"},
  {"method":"transfer","amount":"152000.00"}],
 "customer_name":"Cliente Mostrador",
 "customer":{"name":"Cliente Mostrador","phone":"700-00000","document":"V-123","address":"Av. Colón 1234"},
 "total":"192000.00",
 "created_at":"2026-11-04T23:35:02Z",
 "lines":[{"variant_id":1,"catalog_entry_id":1,"brand":"CAR","model":"NS40ZL",
  "capacity_ah":"35","polarity":"L","quantity":2,"unit_price":"96000.00",
  "min_price":"85000.00",
  "units":[{"serial_number":"ABC123","warranty_months":12},
           {"serial_number":"ABC124","warranty_months":null}],
  "subtotal":"192000.00"}]}
```

The header is the history row's header — `payment_method` stays the derived label —
plus the **client of the warranty** (`customer`, the same four keys the request carries,
address included) and the **settlement** (`payments`, one entry per method that paid, in
the frozen order `cash`, `card`, `transfer`). `lines` is the full array instead of counts.
Each line adds the catalogue identity of its variant — `catalog_entry_id` (the battery),
`brand`, `model`, `capacity_ah` as a string and `polarity` — beside the prices of the sale
and its `units`, so the document stays legible with the amounts that were actually charged
and with the serial and the term of **every battery** that left the branch. A unit with
`"warranty_months": null` is a battery the client took without warranty, and the screen
names it `Sin garantía`; a unit with a number is named `<n> meses`.

## Read the sellable catalogue

```
GET /api/sales/sellable?search=&brand=&capacity=&polarity=&page=&page_size=
```

* `search` is a literal substring over `brand` and `model`.
* `brand` is an exact brand filter.
* `capacity` is an exact catalogue capacity (`"35"`, `"6.5"`), validated as a
  catalogue decimal.
* `polarity` is `L` or `R`.
* `page` and `page_size` are the history read's (`10`, `25`, `50`; default 25).
* The term is not a filter here: `warranty_months` is an unknown key and is refused.

```json
{"page":1,"page_size":10,"total_variants":190,
 "items":[{"variant_id":1,"catalog_entry_id":1,"brand":"CAR","model":"NS40ZL",
   "capacity_ah":"35","polarity":"L","sellable":true,
   "suggested_price":"96000.00","min_price":"85000.00",
   "existing":12,"reserved":2,"available":10},
  {"variant_id":3,"catalog_entry_id":2,"brand":"TOYO","model":"NS40ZL",
   "capacity_ah":"35","polarity":"L","sellable":false,
   "suggested_price":null,"min_price":null,
   "existing":7,"reserved":1,"available":6}]}
```

Every variant of the catalogue comes back **once**, in `variant_id` order and counted in
`total_variants`, priced or not. `sellable` says whether the branch can sell that variant
**right now**: a battery without a price in this branch is `false`, and then
`suggested_price` and `min_price` are **JSON null**. That is why the counter can show the
blocked row with its `Agregar` action disabled (S7) instead of hiding it: the row exists,
the prices do not.

The price belongs to the battery, so `L` and `R` of one battery always show the same pair
and a price change never touches one polarity only. `existing`, `reserved` and `available`
are the branch's own balance, the same shape the inventory payload exposes, so the counter
knows how much it can add without asking a second read; a variant without a balance row is
`0/0/0`. The warranty term is not part of this shape because the seller states it on the
sale.

## Errors

| Status | Code | Meaning |
|---|---|---|
| 400 | `invalid_request` | Malformed body, unknown or duplicate key, a missing key, non-canonical amount, quantity or term out of bounds, a line whose units are not exactly as many as its quantity, a serial outside 1..64 characters, an address above 200 characters, a sale above 1000 units, `mixed` sent as an input, a repeated method, bad query, a query string on the mutation |
| 400 | `payments_mismatch` | The settlement does not close against the total; the body names `missing` or `excess` |
| 401 | `unauthenticated` | No session |
| 403 | `forbidden` | The actor is not a completed branch session of this branch, or the mutation guard failed |
| 404 | `not_found` | Unknown document, a sale of another branch, a non-canonical id, any other path below the collection, or an aliased path |
| 405 | `method_not_allowed` | Any method the route does not serve |
| 409 | `variant_not_sellable` | The variant's battery has no price in this branch |
| 409 | `below_minimum` | The line charges less than the branch minimum |
| 409 | `insufficient_stock` | The branch cannot cover the line (existing stock would fall below zero or below `reserved`) |
| 409 | `serial_already_sold` | One of the serials of the document was already sold; the refusal names the serial |
| 503 | `service_unavailable` | Pool, database, or any unmapped failure |

The three line refusals name the offending variant beside the error code, because the
counter must point at the exact row it has to fix:

```json
{"error":"below_minimum","variant_id":1}
```

```json
{"error":"variant_not_sellable","variant_id":3}
```

```json
{"error":"insufficient_stock","variant_id":19}
```

A battery that was already sold is its own refusal, and it names the serial the counter
has to correct. The serial is published trimmed, exactly as the sale stores it, so the
seller can find the battery in hand; a refusal that could not read the serial is answered
with the house envelope alone instead of an invented one.

```json
{"error":"serial_already_sold","serial_number":"ABC123"}
```

A settlement that does not close is its own refusal, and it carries **exactly one** of
`missing` or `excess` with the canonical amount beside it, so the counter can say how much
is still to pay or how much was charged too much instead of only rejecting the document:

```json
{"error":"payments_mismatch","missing":"46000.00"}
```

```json
{"error":"payments_mismatch","excess":"4000.00"}
```

Every other failure is the house envelope `{"error":"<code>"}`. A refused document is
atomic: one offending line, one repeated serial or an open settlement leaves the sale
tables and every stock balance exactly as they were, so no header, line or unit is
stored, `existing` never changes and `reserved` never changes.
Failures never leak driver, SQL or configuration details; only the database's own
rejection is trusted.

## Database invariants

This contract owns three tables, created by migration `025`, extended by `027` and
reshaped by `031`:

| Table | Shape |
|---|---|
| `sales` | the branch, the branch correlative, the warranty number, how much was paid with each method, the **derived** label, the client and its free-text `customer_address` (at most 200 characters, default empty), the total, the account and the moment; unique on `(branch_location_id, branch_sequence)` and `(branch_location_id, warranty_number)` |
| `sale_lines` | the sold variant, the quantity, the frozen `unit_price` and `min_price` and the derived subtotal. It carries **no** warranty term: the unit is the authority |
| `sale_units` | one row per physical battery: its line (`sale_id`, `variant_id`), a `unit_ordinal` inside that line (`1..n`), the `serial_number` the seller read and the optional `warranty_months` (`1..120` or `NULL`); primary key `(sale_id, variant_id, unit_ordinal)` and a unique index on the trimmed, upper-cased serial |

The database, not the application, decides the sale rules, with stable SQLSTATEs:

| SQLSTATE | Guard |
|---|---|
| `LV001` | Sale scope: only an active branch, only its own account, never the warehouse |
| `LV003` | The variant's battery has no price in this branch: not sellable |
| `LV004` | The charged price is under the branch's stored minimum |
| `LV005` | The branch has no balance row, or the sale exceeds `existing`, or it falls below `reserved` |
| `LV009` | The serial number was already sold, compared after trimming and case folding |
| `LV010` | A unit claims a line that was never persisted |
| `LV011` | A unit ordinal exceeds the quantity of its line |
| `LV012` | A line does not carry exactly one unit per sold piece, or a sale carries none |
| `LV013` | The sale exceeds one thousand units |

The line trigger resolves the pair of the **battery** of the sold variant
(`catalog_entry_id`), so an `L` sale and an `R` sale of one battery freeze the same
floor, while each line still sells one polarity. A unit is admitted only against a
persisted line of its own sale and variant, and only up to that line's quantity; the
serial is unique across the installation. The document itself is validated by deferred
triggers: a document without lines, whose total is not the exact sum of its lines, whose
lines do not each carry exactly one unit per sold piece, or that carries more than one
thousand units is refused at commit. A sale is all-or-nothing: a refused unit leaves no
header, no line, no unit and no stock movement behind. Stock is decremented inside the same transaction, so
the realtime inventory invalidation of the existing ledger covers this write too. A
sale is append-only: nothing in this contract updates or deletes a document.

Migration `027` adds `cash_amount`, `card_amount` and `transfer_amount`, makes
`payment_method` a generated `STORED` column derived from them and installs three
constraints: no method holds a negative amount, at least one method actually paid, and the
three amounts close against the total **exactly**. The label therefore cannot contradict
its own money, and a settlement the application would accept is still refused by the
database if it does not add up.

## Warranty PDF

```
GET /api/sales/{id}/warranty.pdf
```

This route prints the persisted sale as an A4 warranty and downloads it. It carries the
same guards as the detail read: `GET` only (`405` with `Allow: GET`), a completed branch
session (`401` without a session, `403` for the warehouse, a branch that is not the
seller's own or a session that must still change its password), no query string
(`400 invalid_request`), and a sale of another branch is `404 not_found` exactly like an
unknown document, so two branches never print each other's warranties. It is registered
beside `/api/sales/{id}`, so the document id is still one path segment.

The response is the document itself:

| Header | Value |
|---|---|
| `Content-Type` | `application/pdf` |
| `Content-Disposition` | `attachment; filename="garantia-<warranty number>.pdf"` |
| `Content-Length` | The exact length of the PDF |
| `Cache-Control` | `no-store` |
| `X-Content-Type-Options` | `nosniff` |

The file name is **stable and ASCII only**, derived from the number the database
allocated: the first sale of branch `2` downloads as `garantia-2-000001.pdf`, and it is
the same name on every download of that document. A render failure is
`503 service_unavailable`: a warranty is either the whole document or nothing.

The document is the sale, not a recalculation of it: the number, the branch that sold,
the date and time of the sale, the client (name, phone and document), **one row per
physical battery** with the brand, model, capacity and polarity of its variant, the
`Serie` the seller read at the counter and its term — `12 meses` — or `Sin garantía` when
the battery was sold without warranty, one row per **payment method with its amount**
and the stored total. Every price and every row amount are printed **as persisted**, and
the row amount is the frozen unit price, so the rows of a sale add up to its total:
changing a branch price afterwards never alters an emitted warranty. The renderer never
adds the payments up either: it prints the rows and the total the sale recorded. Money is
printed in the presentation format of the product (`Bs 1.234,56`).

The warranty is **always issued**, also when every battery of the sale was taken without
warranty: "Se emite y dice «sin garantía»". A render failure is still
`503 service_unavailable`.

## Wiring

The point of sale mounts on the handler the branch price factory already returns:

```go
api, err := httpapi.NewWithStockEntries(service, cfg, inventoryStore, transferStore,
    stockEntryStore, broker, stockAdjustmentStore)
api, err = httpapi.NewWithBranchPrices(api, service, cfg, pricing.New(pool))
api, err = httpapi.NewWithSales(api, service, cfg, sales.New(pool))
```

`NewWithSales(base, service, cfg, store)` refuses a nil base handler, a nil service, a
nil store and an inconsistent authentication configuration. Without the store the
sale routes stay unregistered (`404`) and every other request is forwarded to the
composed handler unchanged, including its response headers and its path safety.
