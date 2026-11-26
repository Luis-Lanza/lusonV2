# Battery warranty cases

One document per battery that leaves service: the client brought it back under the warranty of a sale
(`warranty_claim`) or the branch found it failed on its own shelf (`stock_defect`). The case follows
the battery to the warehouse, to the factory and back, lends the client a used battery in the
meantime, registers the verdict the factory reaches, notifies the client and delivers the exchange.

The branch **owns** the case and the relationship with the client; the warehouse moves the battery.
Nothing of this contract charges money, writes a cash row, or creates a transfer: the finding on the
shelf is the one write of stock the branch side makes, and the release is the one the warehouse side
makes.

## Routes

| Route | Method | Result |
|---|---|---|
| `/api/warranty-cases` | GET | 200 with the tray of the session's branch, newest first |
| `/api/warranty-cases/claims` | POST | 201 with the case opened by a warranty claim |
| `/api/warranty-cases/stock-defects` | POST | 201 with the case opened by a finding on the shelf |
| `/api/warranty-cases/{id}` | GET | 200 with the whole case, its loans and its history |
| `/api/warranty-cases/{id}/loans` | POST | 201 with the loan of a used battery |
| `/api/warranty-cases/{id}/loans/{ordinal}/fate` | POST | 200 with the loan and the fate it now states |
| `/api/warranty-cases/{id}/advance` | POST | 200 with the case and the tramo it entered |
| `/api/warranty-cases/{id}/resolution` | POST | 200 with the case, its verdict and its destinations |
| `/api/warranty-cases/{id}/notice` | POST | 200 with the case and the notice in its history |
| `/api/warranty-cases/{id}/release` | POST | 200 with the case and the release in its history |
| `/api/warranty-cases/{id}/delivery` | POST | 200 with the closed case and the settled loan |

No other method and no other path is served (`405 method_not_allowed` with `Allow: GET` on the two
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
| Record `in_transit` and `closed` | yes | `403 forbidden` |
| Record `at_warehouse` and `at_factory` | `403 forbidden` | yes |
| Record the verdict (resolution) | `403 forbidden` | yes |
| Register the notice | yes | `403 forbidden` |
| Authorise the release | `403 forbidden` | yes |
| Deliver the exchange | yes | `403 forbidden` |

A case of another branch is `403 forbidden` for a branch session and readable by the warehouse.

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
| `phase` | `received`, `in_transit`, `at_warehouse`, `at_factory`, `resolved` or `closed`. It is always the phase of the last `phase` tramo of the history |
| `verdict` | `null` until the case is resolved, then `repaired`, `replaced`, `unrepairable`, `not_covered`, `lost` or `refused_at_warehouse` |
| `reported_destination`, `loan_destination` | Where the reported battery and the lent one end: `customer`, `stock`, `scrap` or `retained_by_factory`; `null` until the verdict |
| `stock_destination` | Where the shelf of a finding ends. `null` on every claim and on every unresolved case: a claim never had branch stock in play |
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
a `notice` and a `release` carry the phase the case already holds, because neither moves it.
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
 "origin":"warranty_claim","phase":"at_warehouse","variant_id":1,"serial_number":"ABC123",
 "quantity":null,"declared_failure":"No arranca el motor","reason":null,
 "created_at":"2026-03-01T12:00:00Z"}]}
```

`phase` and `origin` are the only admitted query keys and each admitted value is one of the frozen
lists; anything else — an unknown key, an unknown value, a repeated key, an empty value or a stray
separator — is `400 invalid_request`. A row publishes the header of the case and never its loans or
its history: those are read from the case itself. A branch reads its own cases; the warehouse reads the
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
* `source_location_id` is the case's branch, the warehouse or another branch; the loan records it and
  moves nothing: no transfer, no balance and no used-battery stock.
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
* Only the warehouse records the verdict.

## The notice, the release and the delivery

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

The release is the warehouse's decision that the unit waiting in custody becomes sellable stock of the
case's branch, and it is the mirror of the write-off of a finding:

* `note` is mandatory: a blank motive is `400 reason_required`.
* The release requires a recorded notice (`409 notice_required`), it happens once
  (`409 already_released`) and it exists only once the factory has answered
  (`409 resolution_pending`).
* The units that return are the ones the case holds: the quantity a finding wrote off its own shelf,
  or the single repaired unit a claim got back for its client. A claim whose battery never came back —
  kept by the factory, scrapped or sent to the used pool — is `409 nothing_to_release`, and a branch
  that tries to authorise a release is `403 forbidden`.

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
* Only the branch delivers: the warehouse is `403 forbidden`.

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
| 409 | `claim_only` | A finding on the shelf is not resolved by this contract |
| 409 | `transition_not_allowed` | The phase is not the next edge of the journey; the body names `from` and `to` |
| 409 | `resolution_required` | A case reaches `resolved` through its resolution |
| 409 | `resolution_final` | The resolution of a case is already stated |
| 409 | `resolution_matrix` | The destinations do not match the verdict |
| 409 | `resolution_pending` | The factory has not answered the case yet |
| 409 | `warehouse_verdict` | The warehouse refuses at its gate with `refused_at_warehouse` and nothing else |
| 409 | `notice_required` | A release requires a recorded notice |
| 409 | `already_released` | The notice or the release of this case was already recorded |
| 409 | `nothing_to_release` | The case holds no unit: its battery never came back |
| 409 | `loan_fate_final` | A decided loan fate is final |
| 503 | `service_unavailable` | The store or the database could not answer |

A refusal names nothing it did not do: every one of them writes no case, no loan, no tramo and no
balance.

## The two stock writes of the vertical

The finding on the shelf takes its units off the branch that found them, in the transaction that
admits the case. The release puts the units the case holds back on that same branch, in the
transaction that records the authorisation. Both write `existing` and never `reserved`, both name the
case's own branch and the case's own variant, and nothing else of this contract touches
`inventory_balances`, `stock_entries`, `stock_adjustments`, any transfer or any cash row.

The settlement of the branch publishes those units on the count line as `held_in_case_quantity`: the
units of the variant a case holds instead of the branch having them in stock, derived on read and
never a term of the expected quantity nor of the closure. See
[closings](closings.md#count-sheet).
