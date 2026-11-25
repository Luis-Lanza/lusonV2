# Battery warranty cases

One document per battery that leaves service: the client brought it back under the warranty of a sale
(`warranty_claim`) or the branch found it failed on its own shelf (`stock_defect`). The case follows
the battery to the warehouse, to the factory and back, lends the client a used battery in the
meantime and hands him the one-page receipt of that loan, registers the verdict the factory reaches,
notifies the client and delivers the exchange.

The branch **owns** the case and the relationship with the client; the warehouse moves the battery.
Nothing of this contract charges money, writes a cash row, or creates a transfer: the finding on the
shelf is the one write of stock the branch side makes at the admission, the resolution of a finding is
what returns those units to that same shelf, and the release is the one a claim makes when the
warehouse authorises it.

## Routes

| Route | Method | Result |
|---|---|---|
| `/api/warranty-cases` | GET | 200 with the tray of the session's branch, newest first |
| `/api/warranty-cases/claims` | POST | 201 with the case opened by a warranty claim |
| `/api/warranty-cases/stock-defects` | POST | 201 with the case opened by a finding on the shelf |
| `/api/warranty-cases/used-stock` | GET | 200 with the derived stock of used batteries, per location and per model |
| `/api/warranty-cases/{id}` | GET | 200 with the whole case, its loans and its history |
| `/api/warranty-cases/{id}/loans` | POST | 201 with the loan of a used battery |
| `/api/warranty-cases/{id}/loans/{ordinal}/fate` | POST | 200 with the loan and the fate it now states |
| `/api/warranty-cases/{id}/advance` | POST | 200 with the case and the tramo it entered |
| `/api/warranty-cases/{id}/resolution` | POST | 200 with the case, its verdict and its destinations |
| `/api/warranty-cases/{id}/notice` | POST | 200 with the case and the notice in its history |
| `/api/warranty-cases/{id}/release` | POST | 200 with the case and the release in its history; the release of a unit bound for stock also closes the case |
| `/api/warranty-cases/{id}/delivery` | POST | 200 with the closed case and the settled loan; `409 unit_belongs_to_stock` when the unit is the branch's stock |
| `/api/warranty-cases/{id}/receipt.pdf` | GET | 200 with the loan receipt of the case, as a PDF download |

No other method and no other path is served (`405 method_not_allowed` with `Allow: GET` on the three
reads and `Allow: POST` on every mutation). Every mutation requires the same-origin session cookie,
`Origin`, `Sec-Fetch-Site` and `X-CSRF-Token`, and refuses a query string; every read requires the
session only. Any other path below `/api/warranty-cases/` is `404 not_found` as JSON, and an
ambiguous path — a doubled slash, a `.` or `..` segment, a backslash, a NUL, an encoded alias such as
`%31` — is `404 not_found` before any handler work. A `{id}` and an `{ordinal}` are canonical positive
integers: `01`, `+1`, `0` and `abc` are `400 invalid_request`.

## Who may do what

The split is enforced by this handler, by the store and by the database, so an account that asks the
API directly is refused exactly like a screen that shows the wrong button.

| Act | Branch that owns the case | Warehouse |
|---|---|---|
| Open a claim, open a finding | yes | `403 forbidden` |
| Read the case, read the tray | its own cases | every case it moves |
| Lend a used battery, state its fate | yes | `403 forbidden` |
| Record `in_transit` and `closed` | yes, except on a case whose unit is bound for stock | `403 forbidden` |
| Record `at_warehouse` and `at_factory` | `403 forbidden` | yes |
| Record the verdict (resolution) | `403 forbidden` | yes |
| Register the notice | yes, on a claim only | `403 forbidden` |
| Authorise the release | `403 forbidden` | yes, on a claim only |
| Deliver the exchange | yes | `403 forbidden` |
| Download the loan receipt | its own cases | every case it moves |

A case of another branch is `403 forbidden` for a branch session and readable by the warehouse. The
notice and the release are a claim's two facts: a finding has no client to call and no unit in custody,
so on the side that may ask — the branch for the notice, the warehouse for the release — both are
`409 claim_only` on it.

## The case

```json
{"id":1,"case_number":"C-2-000001","branch_location_id":2,"origin":"warranty_claim",
 "phase":"received","verdict":null,"reported_destination":null,"loan_destination":null,
 "stock_destination":null,"sale_id":12,"warranty_number":"2-000012","variant_id":1,
 "serial_number":"ABC123","quantity":null,"declared_failure":"No arranca el motor",
 "reason":null,"created_by_account_id":2,"created_at":"2026-03-01T12:00:00Z",
 "loans":[],"events":[]}
```

| Field | Content |
|---|---|
| `case_number` | The persisted number, `C-<branch>-<sequence>` (S20). It is the branch's own correlative and never the warranty numbering of the sale, and no client states it |
| `branch_location_id` | The branch that owns the case; never the warehouse |
| `origin` | `warranty_claim` or `stock_defect` |
| `phase` | `received`, `in_transit`, `at_warehouse`, `at_factory`, `resolved` or `closed`. It is always the phase the last event of the history states: a `phase` tramo enters it, and the release of a unit bound for stock writes `closed` |
| `closed_by` | The act that closed the case (S34): `delivery` when the last event is a `phase` tramo entering `closed`, `release` when it is the release event that sells the unit bound for stock, and `null` while the case is not closed — and also `null` on a closed case whose last event is neither, because the last event of a closed case can be a notice registered after the close and that states no act. It is derived from the same last event the phase is derived from, and a document where the two disagree is never published |
| `verdict` | `null` until the case is resolved, then `repaired`, `replaced`, `unrepairable`, `not_covered`, `lost` or `refused_at_warehouse` |
| `reported_destination` | Where the reported battery ends: `customer`, `stock`, `scrap` or `retained_by_factory`; `null` until the verdict |
| `loan_destination` | Where the lent battery ends, in the same vocabulary; `null` until the verdict on a claim and always `null` on a finding, which lends none |
| `stock_destination` | Where the shelf of a finding ends: `stock` when the verdict returns its units to the branch, `null` on every claim and whenever the write-off stands |
| `sale_id`, `warranty_number` | The claimed sale and its printed warranty number (S8); both `null` on a finding, which was never sold |
| `variant_id` | The battery: the unit's on a claim, the shelf's on a finding |
| `serial_number` | The serial the client brought. Stated on a claim, `null` on a finding |
| `quantity` | How many batteries of the shelf failed. Stated on a finding, `null` on a claim |
| `declared_failure` | What failed, in the words of whoever registered the case |
| `reason` | The motive of the write-off of a finding (S16); `null` on a claim |
| `created_by_account_id`, `created_at` | Who registered the case and when |
| `loans` | The used batteries handed over, in ordinal order |
| `events` | The append-only history, in ordinal order |

A loan:

```json
{"ordinal":1,"model":"NS60L","quantity":1,"serial_number":"","source_location_id":1,
 "given_at":"2026-03-01T12:05:00Z","fate":"open","fate_decided_at":null,
 "given_by_account_id":2}
```

`ordinal` is the database's own sequence inside the case, `model` and `quantity` are what the loan
identifies — never a serial as an identity — and `serial_number` is optional free text that keys
nothing. `source_location_id` is where the used battery came from: the case's branch, the warehouse or
another branch; nothing moves between locations. `fate` is `open`, `returned`, `kept_by_customer`,
`failed` or `lost`, and `fate_decided_at` is `null` exactly while the loan is open.

An event:

```json
{"ordinal":1,"kind":"phase","phase":"in_transit","factory_case_number":"",
 "actor_account_id":2,"recorded_at":"2026-03-01T13:00:00Z","note":"Sale al Almacén"}
```

`kind` is `phase` for a tramo of the journey, `notice` for the notice the branch registers and
`release` for the release the warehouse authorises. A `phase` event enters a phase the case was not in;
a `notice` and a `release` carry the phase the case already holds, because neither moves it — except
the release of a unit bound for stock, which states the `closed` it writes (see
[the notice, the release and the delivery](#the-notice-the-release-and-the-delivery)).
`factory_case_number` is the file number the warehouse transcribes by hand: it is stated on the
`at_factory` tramo, required there and empty everywhere else.

## Opening a claim

```
POST /api/warranty-cases/claims
{"serial_number":"ABC123","declared_failure":"No arranca el motor"}
```

* The serial is the identity the client brings. The sale, the variant and the case number are the
  database's reading of it: a client that states `sale_id`, `variant_id`, `quantity`, `reason` or any
  other key is `400 invalid_request`.
* The claim is judged against the sale: a serial nobody sold is `409 serial_not_sold`, a unit sold
  without a warranty term — a recorded decision, never missing data — is `409 no_warranty`, and a term
  that has already run out is `409 warranty_expired`. None of the three writes a case.
* The term counts from the sale's own date and never restarts, so a factory replacement does not
  renew it.
* Only the branch opens a claim: the warehouse is `403 forbidden`.

## Opening a finding on the shelf

```
POST /api/warranty-cases/stock-defects
{"variant_id":1,"quantity":2,"declared_failure":"No retiene carga",
 "reason":"Probada en mostrador: no arranca"}
```

* `quantity` is a whole number of batteries from `1` to `1000000`; `reason` is the motive of taking
  them off the branch's own books, a text of one to five hundred characters, required here and
  forbidden on a claim.
* The admission takes `quantity` off `inventory_balances` of the case's own branch, for the case's own
  variant, in the same transaction. A quantity the branch does not have is `409 no_stock`; a write-off
  that would leave `existing` below `reserved` is `409 reserved_stock`; neither writes a case.
* Only the branch opens a finding: the warehouse is `403 forbidden`. A claim never writes stock.

## The tray

```
GET /api/warranty-cases?phase=at_warehouse&origin=warranty_claim
```

```json
{"cases":[{"id":1,"case_number":"C-2-000001","branch_location_id":2,
 "origin":"warranty_claim","phase":"at_warehouse","closed_by":null,"variant_id":1,
 "serial_number":"ABC123","quantity":null,"declared_failure":"No arranca el motor","reason":null,
 "created_at":"2026-03-01T12:00:00Z"}]}
```

`phase` and `origin` are the only admitted query keys and each admitted value is one of the frozen
lists; anything else — an unknown key, an unknown value, a repeated key, an empty value or a stray
separator — is `400 invalid_request`. A row publishes the header of the case, the act that closed it
in `closed_by` and never its loans or its history: those are read from the case itself. The act is
published here and not derived by the screen because the row carries no history, and two cases that
hold `closed` were closed by two different acts: the delivery handed the unit to the client, and the
release sold the unit bound for the branch's stock. A row is `closed` with `closed_by` null only when
the case closed and its last event states no act, and then the screen says the case is closed and
nothing else. A branch reads its own cases; the warehouse reads the
cases of every branch, which is why each row states `branch_location_id`. The tray is the newest
`200` cases of the query.

## Reading one case

```
GET /api/warranty-cases/1
```

The answer is the whole case of [The case](#the-case), with its `loans` and its `events` in ordinal
order. A query string is `400 invalid_request`; an unknown case is `404 not_found`; a case of another
branch is `403 forbidden` for a branch session.

## Lending a used battery

```
POST /api/warranty-cases/1/loans
{"model":"NS60L","quantity":1,"serial_number":"","source_location_id":1}
```

* All four keys are required; `serial_number` is the explicit empty text when nobody wrote the used
  battery's serial down. `model` follows the model contract of a used battery — trimmed and
  upper-cased, `1` to `40` characters — and `quantity` is from `1` to `10000`.
* `model` must also be one the used pool already knows (S30): the closed list is what the flows that
  bring a battery into the pool ever stated — the used batteries bought, the used lines of a closed
  settlement and the batteries the factory refused and sent back — and a loan is never one of those
  sources, so a model cannot enter the system by being lent. A code outside that list is refused with
  `409 loan_model_unknown`, and no row is written. The list is judged before the shelf, so a typo is
  refused for being unknown and not for naming an empty origin.
* `source_location_id` is the case's branch, the warehouse or another branch. The origin must hold the
  requested model: it is the derived stock of [the stock of used batteries](#the-stock-of-used-batteries)
  and the database refuses the loan with `409 loan_source_stock` when it does not, inside the
  transaction of the handover (S25). Existence and availability are two questions and never one: a
  model the pool knows with nothing left in that origin is `loan_source_stock`, and a model it never
  saw is `loan_model_unknown`. Two loans never consume one unit: the write takes a lock on the
  origin and the model before it reads the stock. The loan still writes no transfer and no balance —
  the battery it takes out is the loan itself, and the stock is what those loans sum.
* A loan is born `open`; a case holds as many loans as it needs, and a failed used battery is marked
  and replaced on the same case. Only the branch that owns the case lends: the warehouse is
  `403 forbidden`.

```
POST /api/warranty-cases/1/loans/1/fate
{"fate":"failed"}
```

`fate` is `returned`, `kept_by_customer`, `failed` or `lost`; `open` is not a fate a caller states.
The instant of the decision is the database's own. A fate once decided is final
(`409 loan_fate_final`), and a `failed` battery is replaced by another loan of the same case, never by
rewriting the one that failed.

## The stock of used batteries

```
GET /api/warranty-cases/used-stock
{"stock":[{"location_id":1,"model":"NS60ZL","purchased":"0","factory_returns":"2",
           "loans_returned":"0","delivered":"3","loans_given":"0","available":"5"}]}
```

The stock of used batteries of every location and every model, derived from the facts already
registered (S24). There is no balance row, no stored total and no second inventory (S18): a fifth
number would be the one that desynchronises, so the read is the sum of the documents and the
documents are the only truth. One row per location and model, and every number is a decimal string.

| Field | Meaning |
|---|---|
| `location_id` | The branch or the warehouse (`1`) |
| `model` | The only identity of a used battery: trimmed and upper-cased, exactly like a purchase line, so `ns60zl` and ` NS60ZL ` are one row (S26) |
| `purchased` | What the location bought of the model, counter-documents included as they are stored |
| `factory_returns` | The units the factory refused and sent back to the used pool. The warehouse's only (S27) |
| `loans_returned` | The units of this location's loans the counter got back |
| `delivered` | What the closed settlements counted of the model. A branch delivered it; the warehouse received it |
| `loans_given` | The units handed to the client of a case out of this location |
| `available` | `purchased + factory_returns + loans_returned + delivered - loans_given` for the warehouse and `purchased + factory_returns + loans_returned - delivered - loans_given` for a branch: the same units counted once on each side of a delivery |

A location with no fact of a model has no row; the read never invents a zero. `available` may be
negative, because it is the sum of the whole history and never a clamp — a loan that was handed over
before this contract checked the origin still counts. Every branch and warehouse session reads the
whole table: the counter has to see the stock of the three of them before it promises a battery from
one (S6).

A factory return is never the branch of the case (S27). The warehouse shipped the battery to the
factory and the warehouse receives it back, so the units enter the warehouse's row — and they are not
a term of the branch's settlement sheet either, which is why the two numbers never disagree: at a
cut, a branch's `expected_quantity` per model is exactly its `available` at that cut, and a branch
that delivers everything it holds ends at zero with the same quantity on the warehouse's row (S29).

## The loan receipt

The paper the client leaves with when the branch hands the used battery over (S8). It is one A4 page
rendered from the persisted case and never from a fresh calculation: the case number, the serial of
the battery that stayed, the warranty number of the sale it came from, the model, the quantity and
the source of every loan, the declared failure, the date, the branch and the client are the stored
values, drawn unchanged.

```
GET /api/warranty-cases/1/receipt.pdf
```

* The download is named after the number the database wrote: `comprobante-C-2-000001.pdf`. The
document prints that same persisted number (S20) and never the letter form of a mockup.
* The date of the paper is the instant the database stamped on the handover, not the instant of the
print. A case that lent more than one used battery prints one row per loan with its own date, in the
order the counter handed them over (S7).
* The conditions of the exchange are frozen product copy and state what this contract decides: the
claimed battery stays in the branch for its review, the used one is a free loan, the exchange
happens when the battery comes back from the factory, a client who does not come when told keeps the
loan and the replacement is released, a factory that does not cover the damage leaves the loan with
the client, and the original term neither extends nor restarts (S3).
* A case with no loan to print is `409 no_loan`, and a finding on the shelf is `409 claim_only`: it
names the client of a sale and a handover a finding never had.
* The authority is the case read's own: the branch that owns the case and the warehouse that moves it.
A case of another branch is `403 forbidden`. A query string is `400 invalid_request`, and the download
is either the whole document or `503 service_unavailable`.

## The journey

```
POST /api/warranty-cases/1/advance
{"phase":"in_transit","factory_case_number":"","note":"Sale al Almacén"}
```

* The three keys are required and `factory_case_number` is the explicit empty text on every tramo that
  is not the factory shipment.
* The order is fixed: `received` → `in_transit` → `at_warehouse` → `at_factory` → `resolved` →
  `closed`. A tramo outside that edge is `409
  {"error":"transition_not_allowed","from":"received","to":"at_factory"}`, and it writes nothing.
* `resolved` is reached through the resolution and never through a bare tramo:
  `409 resolution_required`.
* The shipment to the factory carries its file number: `at_factory` without one is
  `400 factory_file_required`, and a file number on any other tramo is `400 factory_file_not_allowed`.
* `note` is the reason of the tramo, at most five hundred characters.
* The branch records `in_transit` and `closed`; the warehouse records `at_warehouse` and `at_factory`.

## The verdict

The same route resolves both doors, and each door states the units it has: a claim states the reported
battery and the lent one, a finding states the units of its own shelf.

A claim:

```
POST /api/warranty-cases/1/resolution
{"verdict":"repaired","reported_destination":"customer","loan_destination":"stock",
 "note":"Reparada por fábrica"}
```

* `verdict` is `repaired`, `replaced`, `unrepairable`, `not_covered`, `lost` or
  `refused_at_warehouse`; both destinations are `customer`, `stock`, `scrap` or
  `retained_by_factory`.
* The gate before the factory is the warehouse's: at `at_warehouse` the only admitted verdict is
  `refused_at_warehouse` and `note` is mandatory (`409 warehouse_verdict`,
  `400 reason_required`). The factory verdicts arrive at `at_factory`.
* `not_covered` leaves the lent battery with the client and the damaged unit in the used pool or out as
  scrap: any other pair is `409 resolution_matrix`.
* A resolution is stated once and is final (`409 resolution_final`). The stock destination of a claim
  is never stated here: a client that sends `stock_destination` is `400 invalid_request`, and the case
  keeps the field `null`.
* `loan_destination` is required on a claim: a body without it is `400 invalid_request`.
* Only the warehouse records the verdict.

A finding on the shelf (S11):

```
POST /api/warranty-cases/2/resolution
{"verdict":"repaired","reported_destination":"stock","note":"Reparadas por fábrica"}
```

* The same two gates and the same frozen vocabulary, and one rule of its own: a finding lends no
  battery, so it states no `loan_destination`, and a body that sends one is `400 invalid_request`.
* `repaired` and `replaced` return the case's units to the branch's own sellable stock: the repaired
  ones, or the replacement that enters in their place. They are the branch's own, so
  `reported_destination` is `stock` and any other value is `409 resolution_matrix`. The resolution
  states `stock_destination` as `stock` and the balance gains the case's `quantity`, once, in the same
  transaction.
* `not_covered` keeps the write-off of the admission: the factory refused the warranty, the damaged
  units stay in the used pool or leave as scrap (`reported_destination` is `stock` or `scrap`, anything
  else is `409 resolution_matrix`), the balance does not move and `stock_destination` stays `null`.
  `unrepairable`, `lost` and `refused_at_warehouse` return no sellable unit either, so neither moves a
  balance and both keep `stock_destination` `null`.
* `stock_destination` is the verdict's own reading and is never the caller's: sending it is
  `400 invalid_request`.
* Only the warehouse records the verdict, on both doors. The case is closed by its branch, through the
  `closed` tramo.

## The notice, the release and the delivery

The notice and the release belong to a claim. A finding on the shelf has no client to call and no unit
in custody, so on the side that may ask — the branch for the notice, the warehouse for the release —
both are `409 claim_only` on it, and it is closed with the `closed` tramo of its journey by its own
branch.

```
POST /api/warranty-cases/1/notice
{"note":"Avisado el cliente"}
```

The notice is the branch's: it states that the client was told about the battery back from the
factory. It is recorded once (`409 already_released` names the rule), it moves no phase, and it exists
only once the factory has answered (`409 resolution_pending`). The warehouse is `403 forbidden`.

```
POST /api/warranty-cases/1/release
{"note":"El cliente no volvió"}
```

The release is the warehouse's decision that the unit a claim holds in custody becomes sellable stock
of the case's branch, and it is the mirror of the write-off of a finding:

* `note` is mandatory: a blank motive is `400 reason_required`.
* The release requires a recorded notice (`409 notice_required`), it happens once
  (`409 already_released`) and it exists only once the factory has answered
  (`409 resolution_pending`).
* The unit that returns is the single unit a claim got back as a sellable battery: the one the factory
  returned repaired or replaced, whether its destination is the client or the branch's own shelf. A
  claim whose battery never came back as a usable unit — kept by the factory, scrapped or the damaged
  battery of a `not_covered` verdict, which belongs to the used pool — is `409 nothing_to_release`; a
  branch that tries to authorise a release is `403 forbidden`, and a finding is `409 claim_only`,
  because its units are the branch's own and came back at its resolution.
* The release of a case whose `reported_destination` is `stock` and whose verdict is `repaired` or
  `replaced` **closes the case**: the factory gave a usable battery back that the client never came to
  collect, so it is the branch's sellable stock and it never leaves with anyone. That release states
  the `closed` it writes, and the answer of the route carries the closed case.
* A case does not close with an undecided loan: while one of its loans is still `open`, that release is
  `409 loan_fate_open` (`LW036`) and writes nothing. The used pool is derived from the fate of every
  loan, so closing without it leaves the unit counted in the wrong place for ever. The release does not
  decide the loan fate, it refuses to close while one is open; the branch decides it.

```
POST /api/warranty-cases/1/delivery
{"loan_fate":"returned","note":"Entregada la reparada"}
```

The delivery hands the battery to the client and closes the case, in one act:

* `loan_fate` is `returned` or `kept_by_customer`: on the same counter the client gave the used battery
  back or kept it. Every loan still open is settled with that fate and the database stamps the
  instant.
* The case must be `resolved`: any other phase is `409
  {"error":"transition_not_allowed","from":"in_transit","to":"closed"}`.
* The delivery writes no stock and no cash: the unit leaves the branch with the client.
* A case whose unit is bound for stock is never delivered: `409 unit_belongs_to_stock`, and no tramo,
  no loan fate and no balance is written. The delivery asserts that the battery went out with the
  client, and that battery is the branch's shelf; the release above is the act that ends that case, and
  a `closed` tramo of it is refused with the same code.
* Only the branch delivers: the warehouse is `403 forbidden`.

**Which act closes a case.** A claim destined to the client (`reported_destination` `customer`) closes
with the delivery, which hands the battery over. A claim whose usable unit is destined to the branch's
shelf (`stock` with `repaired` or `replaced`) closes with the warehouse's release, and so does the unit
it sells. A finding on the shelf closes with the `closed` tramo of its journey, by its own branch,
because it has no client and its units came back at its resolution.

## Error codes

| Status | `error` | Meaning |
|---|---|---|
| 400 | `invalid_request` | A malformed body, an unknown or duplicated key, a value outside the frozen vocabulary, a non-canonical id, an ambiguous path or query |
| 400 | `factory_file_required` | The shipment to the factory states no file number |
| 400 | `factory_file_not_on_shipment` | A file number on a tramo that is not the factory shipment |
| 400 | `reason_required` | The refusal at the warehouse or the release states no motive |
| 403 | `forbidden` | The session does not act from the side the act belongs to, or the case belongs to another branch |
| 404 | `not_found` | No such case, no such route, or an ambiguous path |
| 409 | `serial_not_sold` | The claimed serial was never sold |
| 409 | `no_warranty` | The claimed unit was sold without a warranty term |
| 409 | `warranty_expired` | The term of the claimed unit has run out |
| 409 | `no_stock` | The branch does not have that many batteries to write off |
| 409 | `reserved_stock` | The write-off would take stock the branch already promised |
| 409 | `claim_only` | A finding on the shelf states no notice, no release and no loan receipt: it has no client to call, no unit in custody and no used battery handed over |
| 409 | `transition_not_allowed` | The phase is not the next edge of the journey; the body names `from` and `to` |
| 409 | `resolution_required` | A case reaches `resolved` through its resolution |
| 409 | `resolution_final` | The resolution of a case is already stated |
| 409 | `resolution_matrix` | The destinations do not match the verdict |
| 409 | `resolution_pending` | The factory has not answered the case yet |
| 409 | `warehouse_verdict` | The warehouse refuses at its gate with `refused_at_warehouse` and nothing else |
| 409 | `notice_required` | A release requires a recorded notice |
| 409 | `already_released` | The notice or the release of this case was already recorded |
| 409 | `nothing_to_release` | The case holds no unit: its battery never came back as a sellable unit |
| 409 | `unit_belongs_to_stock` | The unit of the case is the branch's sellable stock: the release sells it and closes the case, and the delivery never does |
| 409 | `loan_fate_open` | The release would close the case while one of its loans is still undecided: the branch decides the fate first, and the release never decides it |
| 409 | `loan_fate_final` | A decided loan fate is final |
| 409 | `loan_model_unknown` | The model of the loan is one the used pool never saw; the closed list is the one the flows state |
| 409 | `loan_source_stock` | The origin of the loan does not hold the requested model, or another loan already took the last unit |
| 409 | `no_loan` | The case has not handed a used battery over, so it has no loan receipt to print |
| 503 | `service_unavailable` | The store or the database could not answer |

A refusal names nothing it did not do: every one of them writes no case, no loan, no tramo and no
balance.

## The three stock writes of the vertical

The finding on the shelf takes its units off the branch that found them, in the transaction that
admits the case. The resolution of that finding puts them back on that same branch when the verdict
returns them `repaired` or `replaced`, in the transaction of the tramo that resolves the case. The
release of a claim puts back the single unit the claim held — the one the factory returned repaired or
replaced, destined to the client or to the branch's own shelf — in the transaction that records the
warehouse's authorisation. The three write `existing` and never `reserved`, all name the case's own
branch and the case's own variant, and nothing else of this contract touches `inventory_balances`,
`stock_entries`, `stock_adjustments`, any transfer or any cash row.

The used batteries are the fourth stock of this vertical and they are written nowhere: a purchase,
a settlement, a loan and a factory return are the facts, and
[the stock of used batteries](#the-stock-of-used-batteries) is their signed sum. Nothing of this
vertical writes a used-battery balance, because there is none.

The settlement of the branch publishes those units on the count line as `held_in_case_quantity`: the
units of the variant a case holds instead of the branch having them in stock, derived on read and
never a term of the expected quantity nor of the closure. See
[closings](closings.md#count-sheet).
