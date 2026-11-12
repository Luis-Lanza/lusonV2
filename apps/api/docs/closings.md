# Branch account settlement (rendición de cuentas)

The warehouse visits a branch in person, freezes its period, counts the stock and the
drawer, settles a commission on what the branch sold and leaves the fund the next period
starts with. In this document the act and the document are always the **rendición de
cuentas**; its period is always the range between two of them, from the closure of the
previous one to the cut instant of this one (the first one of a branch settles an empty
period that starts with the system).

The vertical is one settlement per branch at a time, with the database as its authority
(migrations 034, 035, 036 and 037): it decides the cut instant, the period start, the
inherited fund and the expected stock snapshot; it admits one live settlement per branch;
it decides when the count sheet and the fields of the drawer may be drafted; it reads and
freezes the commission rate when the warehouse proposes; it keeps the proposal rounds
immutable; and when the branch accepts it applies the counted stock and writes the cash
ledger itself, in one transaction. This contract never restates those rules: it sends the
request, publishes the database's own decision as one status and one stable code and reads
back what the database wrote.

The branch is not only settled: it records the small expenses it pays out of its own till as
they happen, and the settlement whose period covers them is charged for them. The warehouse
has no till of its own and records none.

A closed settlement is never reopened. An error is corrected by an appended correction
that the branch itself approves — **that contract does not exist yet** (see
[Not served yet](#not-served-yet)): there is no correction route here, and the settlement it
would correct stays readable and immutable in the meantime.

## Vocabulary and money

* `arqueo` appears nowhere: not in a route, an identifier, a stored value, an error code or
  this documentation.
* Every amount is canonical two-decimal **text** (`"0.00"`, `"96000.00"`), never a JSON
  number and never a binary float. A padded integer (`"096000.00"`), a missing fraction
  (`"96000"`), three decimals, a negative amount or a comma are all `400 invalid_request`.
* Every percentage is canonical two-decimal text between `0` and `100` (`"12.50"`), exactly
  like the `numeric(5,2)` column that stores it.
* Instants are RFC3339 in UTC.
* The commission of a period is the frozen rate over the sum of the sold subtotals of the
  period, rounded **once** on the total, half a cent up (`0.005` up). It is one amount for the
  whole branch: there is no seller and no manager name anywhere in this contract.

## Authorization

The commission rate is configured by the warehouse administrator: account `1` assigned to
location `1` with a completed password change. The store also verifies the `auth_accounts`
binding (`id` plus `location_id`) before touching anything, so a forged identity is not
evidence of an assignment; the database refuses a different actor with its own SQLSTATE
(`LC015`).

* **Opening, counting, drafting the drawer and proposing** are the warehouse's alone. A
  branch account receives `403 forbidden` on all of them.
* **Recording an expense** is the branch's alone: the till the money comes out of belongs to the
  branch that records it, so the warehouse is refused (`403 forbidden`) and every branch records
  only in its own.
* **Deciding** is the branch's alone: any enabled account of the branch the settlement
  belongs to accepts or rejects. The warehouse cannot decide (`403 forbidden`), and neither
  can another branch.
* **Reading** a settlement is the warehouse's for every branch and the branch's for its own;
  a settlement of another branch is `404 not_found`, exactly like another branch's documents.
  The commission rate of a branch is read by the warehouse and by that branch only.

Branch scope is therefore enforced twice: by the store, with the identity taken from the
session and never from the request body, and by the database's own admission functions. No
route takes an actor, a location or a role from JSON.

## Routes

| Route | Method | Result |
|---|---|---|
| `/api/closings` | GET | 200 with one newest-first page of one branch's settlements |
| `/api/closings` | POST | 201 with the opened settlement |
| `/api/closings/branches/{branch}/commission` | GET | 200 with the configured percentage |
| `/api/closings/branches/{branch}/commission` | POST | 200 with the written percentage |
| `/api/closings/{id}` | GET | 200 with the whole settlement |
| `/api/closings/{id}/count` | POST | 200 with the settlement and its count sheet |
| `/api/closings/{id}/cash` | POST | 200 with the settlement and its drawer |
| `/api/closings/{id}/propose` | POST | 200 with the settlement and the round it now offers |
| `/api/closings/{id}/decision` | POST | 200 with the settlement and the branch's answer |
| `/api/closings/expenses` | POST | 201 with the recorded expense |

No other method and no other path is served by this contract: `405 method_not_allowed` with
an explicit `Allow` header (`GET, POST` for the collection, `GET, POST` for the commission,
`POST` for the expenses, `GET` for one settlement, `POST` for each operation). Every mutation
requires the usual same-origin session cookie, `Origin`, `Sec-Fetch-Site` and `X-CSRF-Token`;
every read requires the session only. A query string is not part of any route here except the
branch history (`GET /api/closings`), where it is the query itself: on every other route
`?page=1` and a bare `?` are `400 invalid_request`.

`{id}` and `{branch}` admit only canonical positive integers: `01`, `+1`, `0`, `1.0`, `abc`
and an integer outside the column range are `400 invalid_request`, never a cleaned or
redirected path. Any other path below `/api/closings/` is `404 not_found` as JSON, and an
ambiguous path is refused before it can be cleaned: a doubled slash, a `.` or `..` segment, a
backslash, a NUL or an encoded alias (`%31` for `1`, `%2F` for `/`) is `404 not_found`. A
trailing slash is `404 not_found`, never a redirect.

The commission path is a longer literal path than a settlement id, so it is never captured by
`{id}` and never collides with the suffix of an operation. `expenses` is a literal path beside
`{id}` for the same reason: it is never read as a settlement id, and it names no settlement at all.

## Commission rate

The percentage a branch's settlement pays on its period sales, configured per branch.

```
POST /api/closings/branches/2/commission
{"commission_rate_percent":"12.50"}
```

```json
{"branch_location_id":2,"commission_rate_percent":"12.50"}
```

* Only the warehouse writes it; a branch that tries is `403 forbidden`, and the warehouse
  never settles a commission to itself (`400 invalid_request` for branch `1`).
* The percentage is stored as written and read back as the same canonical text. A value the
  column cannot hold (`"100.01"`, `"-1.00"`) or a value that is not canonical (`"12.5"`) is
  `400 invalid_request`.
* A branch without a configured rate has no setting: `GET` answers `404 not_found`, and a
  proposal for that branch is refused with `409 commission_rate_missing`.
* The rate is frozen when the warehouse proposes and never rewritten afterwards: changing the
  configured percentage does not alter a proposed or a closed settlement, and neither does
  changing catalogue prices, because the sale freezes its own price per line.

## Opening a settlement

```
POST /api/closings
{"branch_location_id":2}
```

```json
{"id":1,"branch_location_id":2,"branch_name":"Sucursal A","status":"open",
 "period_start":"2026-02-23T18:00:00Z","cut_at":"2026-03-23T18:30:00Z","closed_at":null,
 "commission_rate_percent":null,"opening_cash":"100.00",
 "cash_sales":"0.00","cash_expenses":"0.00","expected_cash":"100.00",
 "counted_cash":null,"cash_difference":null,"contributed_cash":"0.00","closing_cash":null,
 "taken_cash":null,"sales_total":"0.00","commission_amount":"0.00","card_total":"0.00",
 "transfer_total":"0.00","qr_total":"0.00","observation":"","opened_by_account_id":1,
 "count_lines":[{"variant_id":1,"catalog_entry_id":1,"brand":"TOYO","model":"NS40ZL",
  "capacity_ah":"45","polarity":"L","expected_quantity":28,"counted_quantity":null}],
 "rounds":[]}
```

* `branch_location_id` is the only field of the body. The cut instant, the period start, the
  inherited fund and the expected snapshot are the database's facts: a client that states one
  of them is rejected as an unknown key.
* The warehouse is not a branch: branch `1`, `0` and everything above the column range are
  `400 invalid_request`.
* Opening freezes the branch (it can no longer sell, load an expense, receive a transfer,
  receive stock or reconcile), freezes the cut instant of the period, seeds the count sheet
  with the branch's own stock at that instant and inherits the fund left by the previous
  closure (`opening_cash`; `"0.00"` for the first settlement).
* **A branch holds one live settlement at a time**: a second opening is
  `409 {"error":"settlement_live","branch_location_id":2}` and writes nothing. `open`,
  `proposed` and `rejected` are all live, so only a closed settlement leaves the branch free.
* A retired branch is refused by name: `409 {"error":"branch_retired","branch_location_id":3}`.

The first settlement of a branch is the bootstrap: it settles an empty period (`period_start`
equals `cut_at`), pays no commission and leaves the fund the warehouse declares as a
contribution (`contributed_cash`) — the drawer starts at zero, so nothing else could leave a
fund there.

## Count sheet

```
POST /api/closings/1/count
{"lines":[{"variant_id":1,"counted_quantity":27}]}
```

* The body states **only** what was counted, per variant. The expected quantity, the
  difference, the branch and the settlement are not part of it at all, so a blinded count
  cannot even be expressed; `expected_quantity` or `difference` in a line is `400
  invalid_request`.
* `lines` holds 1 to 190 entries, `variant_id` is unique per request and `counted_quantity` is
  a whole number from `0` to `1000000`. `0` is a legitimate result of a physical count.
* A line that already exists only changes its counted quantity; a line the system did not have
  is added with the database's own snapshot of `0`. The expected quantity is the snapshot the
  database took at open and is never recalculated, so the sheet stays a fact of the cut.
* The sheet may be written **only while the warehouse holds the settlement**: `open` and
  `rejected`. While the branch is deciding (`proposed`) it is `409 count_frozen`, and forever
  after the closure too. No line is ever removed.
* Every variant the branch held at the cut is seeded as a line with a null
  `counted_quantity`; a line that stays pending is what blocks the proposal and the closure,
  and the refusal names it.

## Drawer draft

```
POST /api/closings/1/cash
{"counted_cash":"96000.00","contributed_cash":"0.00","closing_cash":"6000.00",
 "observation":"contado en persona"}
```

All four keys are mandatory: an amount the warehouse has not counted yet is the explicit JSON
`null`, never an absent key and never an invented zero. `contributed_cash` is the money the
warehouse puts into the drawer (it is `"0.00"` in the normal case and the declared fund in the
first settlement); `observation` is free text of at most 1000 characters, persisted verbatim.

* The cash sales and the cash expenses of the period are **not** part of this body: they are
  facts of the ledgers — the branch's immutable sales and the expenses it recorded as they
  happened — and the server reads them. A draft can therefore never state a number the ledger
  contradicts.
* The fund left behind never exceeds the drawer: `closing_cash <= counted_cash +
  contributed_cash`. A fund above it is `409 {"error":"fund_exceeds_drawer","excess":"50.00"}`,
  which names the exact amount to correct. This is what makes the first settlement possible
  with a drawer of zero and a declared fund.
* Drafting is admitted while the settlement is `open` or `rejected`. On a `proposed`
  settlement the drawer is the offer the branch is deciding, so a draft is `409
  state_conflict`; after the closure it is refused too.

## Derived money: published as computed

Three numbers of the drawer are **never persisted**. They are derived from the facts that
produce them on every read, so they cannot disagree with those facts:

| Field | Identity |
|---|---|
| `expected_cash` | `opening_cash + cash_sales - cash_expenses` |
| `cash_difference` | `counted_cash - expected_cash`, with its sign: negative is a shortage (`-100.00`), positive a surplus, zero when it matches |
| `taken_cash` | `counted_cash + contributed_cash - closing_cash`, never negative by the fund bound |

`cash_difference` and `taken_cash` are `null` until the drawer states what they need:
`cash_difference` needs `counted_cash`, and `taken_cash` needs `counted_cash` and
`closing_cash`.

`commission_amount`, `card_total`, `transfer_total` and `qr_total` are **reported beside** the
drawer and are part of no cash identity in this document: the commission is never subtracted
from the counted cash, never generates a cash movement and never enters any of the three
identities above. Card, transfer and QR are money the branch collected and never holds in its
drawer, so they are published as their own amounts and are never added to `cash_sales`,
`expected_cash`, `cash_difference` or `taken_cash`.

From the proposal on, `cash_expenses` is the sum of the `expenses` the same document publishes —
the ledger of its own window — so the total and its breakdown always describe one period.

While the settlement is `open` or `rejected`, `sales_total`, `cash_sales`, `cash_expenses`,
`card_total`, `transfer_total`, `qr_total` and `commission_amount` read `"0.00"`: the database
records the offer of the period when the warehouse proposes (it is the offer the branch will
accept, and it must not move afterwards). The drawer draft still shows its own identities over
the facts known at that moment, which is why a draft can show a difference that the proposal
later restates precisely. `expenses` is the exception in that window: it is the branch's ledger
and is published while the warehouse holds the settlement, so the admin reads the exact amounts
the proposal is about to subtract; the proposal then freezes their total in `cash_expenses` and
the two never disagree again.

## Expenses of the branch

The branch records the small expenses it pays out of its own till as they happen (S12): no approval
precedes them and no settlement is named, because the settlement that covers an expense is the one
whose period contains the instant it was recorded.

```
POST /api/closings/expenses
{"amount":"45.50","description":"Flete"}
```

```json
{"id":12,"branch_location_id":2,"amount":"45.50","description":"Flete",
 "occurred_at":"2026-03-02T09:15:00Z","created_by_account_id":2}
```

* Both keys are mandatory and there are no others. `amount` is canonical two-decimal text and is
  never zero; `description` is valid UTF-8 without NUL, at most 500 characters and never blank
  once trimmed, and it is published exactly as it is stored, so a padded `" Flete "` is `400
  invalid_request` instead of a silently trimmed one.
* The branch is the **session's own**: `branch_location_id` and `created_by_account_id` are the
  account's, never the body's, and `occurred_at` is the database's, so no caller records an
  expense in another till nor backdates one into an already settled period.
* Only the branch records an expense, because the till the money comes out of is the branch's. The
  warehouse has no till of its own and is refused with `403 forbidden`.
* While a settlement holds the branch the expense is refused with `409 branch_frozen`: the drawer
  that would move is the one being counted (S3). A refusal writes nothing at all — no movement, no
  counter, no change to the settlement.
* A recorded expense is immutable: it is never edited and never deleted, and a wrong one is
  corrected with its opposite movement. This contract does not serve that correction yet (see
  [Not served yet](#not-served-yet)).
* The expense is not attached to a settlement by the caller: it belongs to the period whose window
  `[period_start, cut_at)` contains its instant, and that settlement publishes it.

## Proposal (offer to the branch)

```
POST /api/closings/1/propose
```

No body is admitted at all: the offer is composed from the ledgers of the period and never
from a client promise. An empty body is required; anything else is `400 invalid_request`.

The proposal is refused, naming what is missing, when:

| Refusal | Status and body |
|---|---|
| A variant of the sheet is still pending | `409 {"error":"count_pending","variant_id":7}` |
| The count sheet changed while the offer was being recorded | `409 {"error":"proposal_stale","variant_id":7}` |
| The drawer is not stated | `409 {"error":"cash_not_stated"}` |
| The fund exceeds the drawer | `409 {"error":"fund_exceeds_drawer","excess":"50.00"}` |
| The branch has no configured rate | `409 {"error":"commission_rate_missing"}` |
| The settlement is not held (already proposed or closed) | `409 {"error":"state_conflict"}` |

`count_pending` and `proposal_stale` are the two sides of the same fact. `count_pending` is
what the store answers when it reads the sheet before proposing; `proposal_stale` is the
database's own `LC019`, raised when a line of the sheet lost its counted quantity between that
read and the transition that records the offer. Both are conflicts: the warehouse re-reads the
settlement and proposes again, and neither is an outage.

On success the database freezes the configured rate on the settlement, records the period
totals and the commission and the warehouse's round is added to the history:

```json
{"id":1,"status":"proposed","commission_rate_percent":"10.00",
 "opening_cash":"100.00","cash_sales":"96000.00","expected_cash":"96100.00",
 "counted_cash":"96000.00","cash_difference":"-100.00","contributed_cash":"0.00",
 "closing_cash":"6000.00","taken_cash":"90000.00","sales_total":"96000.00",
 "commission_amount":"9600.00","card_total":"0.00","transfer_total":"0.00","qr_total":"0.00",
 "rounds":[{"id":1,"round":1,"decision":"","decision_reason":"",
  "offer":{"period_start":"2026-02-23T18:00:00Z","cut_at":"2026-03-23T18:30:00Z",
   "sales_total":"96000.00","commission_rate_percent":"10.00","commission_amount":"9600.00",
   "cash_sales":"96000.00","cash_expenses":"0.00","card_total":"0.00","transfer_total":"0.00",
   "qr_total":"0.00","counted_cash":"96000.00","contributed_cash":"0.00",
   "closing_cash":"6000.00","observation":"","count_lines":[]}}]}
```

The round's `offer` is the payload stored verbatim at proposal: the period, the collection by
payment method, the reported commission and the drawer. It is what the branch is accepting,
and it is never rewritten by a later round.

## Decision

```
POST /api/closings/1/decision
{"decision":"accepted"}
{"decision":"rejected","reason":"faltó contar la bodega"}
```

* `accepted` is the only thing that **closes** the settlement, and closing is the only moment
  stock moves: every counted variant is left with exactly its counted quantity, in both
  directions, and the cash ledger of the drawer is written in the same transaction.
* `rejected` states a **mandatory reason** (valid UTF-8 without NUL, at most 1000 characters,
  never blank once trimmed, persisted trimmed). It applies nothing, unfreezes nothing and
  returns the settlement to the warehouse as `rejected`, where the sheet and the drawer are
  editable again. There is no limit of rounds.
* An acceptance that carries a reason is `400 invalid_request`: the two decisions are
  exclusive.
* A decision on a settlement that is not `proposed` is `409 state_conflict`; a decision by
  another branch or by the warehouse is `403 forbidden`.
* The closure is refused with `409 {"error":"reserved_stock","variant_id":7}` while a variant
  of the branch still holds a reservation, and with
  `409 {"error":"stock_moved","variant_id":7}` while a variant no longer holds the quantity the
  count sheet photographed: both name the variant in conflict, because both are the line of the
  sheet the warehouse has to resolve. The closure is also refused with `409 round_not_accepted`
  if the latest round was not accepted — a warehouse-only transition that never applies an offer
  the branch did not accept.
* A difference of cash of any size is admitted and persisted with its observation: it is never
  distributed, never discounted from the commission and never absorbed by the stock.

## The settlement document

Every route of this contract answers the whole settlement, with exactly these keys:

| Field | Meaning |
|---|---|
| `id` | Settlement number |
| `branch_location_id`, `branch_name` | The branch it settles |
| `status` | `open`, `proposed`, `rejected` or `closed` |
| `period_start`, `cut_at`, `closed_at` | The period it settles; `closed_at` is `null` until the closure |
| `commission_rate_percent` | The frozen rate; `null` while the settlement is `open` |
| `opening_cash` | The fund inherited from the previous closure (`"0.00"` for the first) |
| `cash_sales`, `cash_expenses` | The cash the branch collected and the expenses it recorded in the period |
| `expected_cash` | Derived, see above |
| `counted_cash`, `cash_difference` | What was counted and its sign against the expected drawer; `null` while uncounted |
| `contributed_cash`, `closing_cash`, `taken_cash` | The contribution, the fund left behind and what the warehouse takes; see above |
| `sales_total`, `commission_amount` | The commission base and the reported commission of the period |
| `card_total`, `transfer_total`, `qr_total` | The electronic collection of the period, published on its own |
| `observation` | The free text of the drawer |
| `opened_by_account_id` | The warehouse account that opened it |
| `count_lines` | The sheet, ordered by `variant_id`, with `expected_quantity` and a `counted_quantity` that is `null` while pending |
| `expenses` | The expenses of the branch inside this settlement's own window, in the order they were recorded |
| `rounds` | The proposal history, oldest first |

Each `count_lines` entry also carries the catalogue identity of its variant — `catalog_entry_id`,
`brand`, `model`, `capacity_ah` (canonical decimal text) and `polarity` — so the sheet is legible
without a second read. Each `expenses` entry carries `id`, `branch_location_id`, `amount`,
`description`, `occurred_at` and `created_by_account_id`, which is exactly the shape the recording
route answers, so the branch reads its own expense the same way in both places. Each `rounds`
entry carries `id`, `round` (the database's own sequence), `offer`, `proposed_by_account_id`,
`proposed_at`, `decision` (`""` while pending, `accepted` or `rejected`), `decision_reason`,
`decided_by_account_id` and `decided_at`; a decided round states who answered it and when, and a
rejected one always states its motive.

The published document is revalidated before it is written: a settlement whose money is not
canonical, whose derived numbers do not follow their own identity, whose sheet or rounds are out
of order, or whose round states a decision it cannot have, is answered `503
service_unavailable` instead of being described.

## History of a branch

```
GET /api/closings?branch_location_id=2&page=1&page_size=25
```

* `branch_location_id` is mandatory: this read is **one branch's own history**, never a listing
  of every branch at once. `page` is a canonical integer from 1 to 1000000 and defaults to 1;
  `page_size` is one of `10`, `25`, `50` and defaults to 25.
* The query is token-exact: repeated parameters, unknown keys (`status`, `pageSize`), empty
  values, a bare `?`, a non-canonical integer (`01`, `%31`, `+1`) and a branch below the first
  branch are all `400 invalid_request`. Parameter order is irrelevant.
* The warehouse reads any branch; a branch reads only its own, and another branch is `403
  forbidden`, exactly like its commission rate. An unknown branch is `404 not_found` and a
  retired one is `409 branch_retired`, exactly like an opening.

```json
// abbreviated: every row carries all 27 keys of the settlement document
{"page":1,"page_size":25,"total_closings":2,
 "closings":[
  {"id":2,"branch_location_id":2,"branch_name":"Sucursal A","status":"open",
   "period_start":"2026-03-23T18:30:00Z","cut_at":"2026-04-23T18:30:00Z","closed_at":null,
   "commission_rate_percent":null,"expected_cash":"100.00","counted_cash":null,
   "cash_difference":null,"commission_amount":"0.00","closing_cash":null,"taken_cash":null,
   "count_lines":[],"rounds":[],"expenses":[]},
  {"id":1,"branch_location_id":2,"branch_name":"Sucursal A","status":"closed",
   "period_start":"2026-02-23T18:00:00Z","cut_at":"2026-03-23T18:30:00Z",
   "closed_at":"2026-03-23T18:31:10Z","commission_rate_percent":"10.00",
   "expected_cash":"0.00","counted_cash":"0.00","cash_difference":"0.00",
   "commission_amount":"0.00","closing_cash":"100.00","taken_cash":"0.00",
   "count_lines":[],"rounds":[],"expenses":[]}]}
```

Rows are ordered by the **cut instant, newest first**, with the newer settlement first when two
share one instant, so paging with a stable `page_size` never repeats or skips a settlement.
`total_closings` counts every settlement of that branch, independent of the requested page,
which makes an empty page beyond the last one harmless.

Every row is the **same document projection** the single read publishes — the whole settlement
shape of the table above, already validated and with its derived money computed from its own
facts — so a history row and the settlement it summarises can never disagree. The count sheet, the
expenses and the proposal rounds belong to the single read: a row publishes them as empty arrays and
`GET /api/closings/{id}` unfolds them.

## Errors

Failures are exactly one of these; the four refusals an operator acts on name the fact they are
about instead of a generic code.

| Status | Code | Companion key | Meaning |
|---|---|---|---|
| 400 | `invalid_request` | — | Malformed body or framing, an unknown or duplicate key, a non-canonical amount, percentage, id, branch or page, an inadmissible query, a query string outside the history, or a body above 32 KiB |
| 401 | `unauthenticated` | — | No session |
| 403 | `forbidden` | — | The caller is not the actor of this operation (branch on a warehouse route, warehouse on an expense, warehouse or another branch on a decision) |
| 404 | `not_found` | — | No such settlement for this caller, no setting for that branch, or an aliased path |
| 409 | `settlement_live` | `branch_location_id`, `closing_id` | The branch already has a live settlement, named by the refusal; only one exists at a time |
| 409 | `branch_retired` | `branch_location_id` | The branch was retired and is not settled |
| 409 | `count_pending` | `variant_id` | A variant of the sheet has no counted quantity |
| 409 | `proposal_stale` | `variant_id` | The count sheet lost a counted quantity while the offer was being recorded; re-read and propose again |
| 409 | `cash_not_stated` | — | The proposal needs the counted cash and the fund |
| 409 | `fund_exceeds_drawer` | `excess` | The fund exceeds the counted cash plus the contribution by that amount |
| 409 | `commission_rate_missing` | — | The branch has no configured commission rate |
| 409 | `count_frozen` | — | The count sheet is not writable in this state |
| 409 | `state_conflict` | — | The settlement's state does not admit this operation |
| 409 | `closure_refused` | — | The closure's own money rule refused the settlement |
| 409 | `reserved_stock` | `variant_id` | A variant of the branch still holds a reservation |
| 409 | `stock_moved` | `variant_id` | A variant moved during the settlement, so the count is stale |
| 409 | `round_not_accepted` | — | The settlement has no accepted proposal round |
| 409 | `branch_frozen` | — | The branch is frozen by a live settlement and cannot record an expense |
| 503 | `service_unavailable` | — | Pool, database, or any unmapped failure |

Failures never leak driver, SQL or configuration details: only the database's own rejection is
trusted, and it is mapped by SQLSTATE. The refusals that name a variant read it back from the
count sheet and the balances — the same rows and the same predicates the database used — instead
of parsing the message of the trigger, so the number in the body is the line that actually
refused the operation. Every other failure of the vertical is `service_unavailable`, including a
stored shape this domain never wrote. The only SQLSTATEs of this vertical that still land there
are the ones the store cannot reach at all: `LC012`, `LC013`, `LC014`, `LC021`, `LC022` and
`LC023` belong to the corrections journal, whose routes are not served yet, and `LC020` is the
provenance of a settlement ledger row, which only the closure's own trigger writes.

## Database invariants

`branch_closings`, `closing_count_lines`, `closing_proposals`, `branch_cash_movements` and
`branch_settings` are the settlement's own tables; the closed settlement, its rounds and the
cash ledger are immutable. The database, not the application, decides the following, with
stable SQLSTATEs:

| SQLSTATE | Guard | Published as |
|---|---|---|
| `LC001` | The branch is frozen by a live settlement and cannot operate (sale, purchase, transfer, stock ingress, reconciliation, expense) | `409 branch_frozen` on the expense route, `409 state_conflict` from the document's own routes |
| `LC002` | Only the warehouse settles a branch, and the warehouse is never settled | 403 `forbidden` |
| `LC003` | The branch has no configured commission rate | 409 `commission_rate_missing` |
| `LC004` | Count lines are written only while the warehouse holds the settlement; only the counted quantity moves | 409 `count_frozen` |
| `LC005` | Unsupported transition, frozen identity, draft of a proposed or closed settlement, period totals that are not drafts | 409 `state_conflict` |
| `LC006` | The closure's money rule: the fund above the drawer, the drawer not stated, a pending variant | 409 `fund_exceeds_drawer`, `cash_not_stated`, `count_pending` or `closure_refused` |
| `LC007` | A variant still holds reserved stock | 409 `reserved_stock` with `variant_id` |
| `LC008` | A proposal belongs to a live settlement and only the warehouse proposes | 409 `state_conflict` |
| `LC009` | Rounds are never deleted and a decided round is final | 409 `state_conflict` |
| `LC010` | Only a proposed settlement is decided, and only by an enabled account of its branch | 403 `forbidden` or 409 `state_conflict` |
| `LC011`, `LC020` | The cash ledger's admission (only the branch records its own expenses; only the closure writes the money of a settlement) and the provenance of a settlement movement | `403 forbidden` from the expense route, 503 `service_unavailable` elsewhere |
| `LC015` | Only the warehouse configures a branch commission, and never to itself | 400 `invalid_request` or 403 `forbidden` |
| `LC016` | The latest proposal round is not accepted, is still undecided, or is not rejected | 409 `round_not_accepted` |
| `LC017` | The branch was retired | 409 `branch_retired` |
| `LC018` | A variant moved during the settlement | 409 `stock_moved` with `variant_id` |
| `LC019` | A variant has no counted quantity at the proposal | 409 `proposal_stale` with `variant_id` when the store's own read missed it; `409 count_pending` when the store refuses first |

One live settlement per branch is a unique index, reported as `409 settlement_live`; a
reference to a settlement that does not exist is reported as `404 not_found`.

The closure is one transaction: the counted stock, the cash ledger rows of the drawer
(`aporte` for the contribution, `recaudacion` for what the warehouse takes), the state and the
unfreezing of the branch all commit together or not at all. A closure of a settlement whose
branch traded during the period is refused (`LC018`, `409 stock_moved`) instead of restoring
stale stock, and one of a branch that still owes a reserved unit is refused (`LC007`, `409
reserved_stock`); neither applies anything, so resolving the line and accepting again closes the
same settlement.

## Not served yet

One operation of the vertical has no store method yet and is therefore **not** part of this
contract, rather than guessed at here: **corrections of a closed settlement** (S16). There is
no `POST /api/closings/{id}/correct` and no approval route. Migration 036 already stores the
journal a correction would apply — a mandatory motive, the branch's approval and compensating
deltas against the open period — and the documentation of that contract will be written with
the routes. Until then a closed settlement stays readable, immutable and correctable only by the
next vertical slice.

The corrective **counter-movement of a recorded expense** (S12: an expense is never edited nor
deleted, a wrong one is corrected by its opposite) has no route here either: the ledger admits no
inverting movement of a `gasto` today, exactly as it admits no edit and no deletion of one. What
this contract does guarantee is the immutable side — a recorded expense is never rewritten and
never removed — and the reversal belongs to the corrections contract above, which is the only one
allowed to append movement to a period that is already settled.

## Wiring

The server composes `NewWithClosings(api, service, cfg, closings.New(pool))` after the purchase
ledger, so the settlement owns only its own path and every composed surface keeps its exact
behaviour. The factory returns `(http.Handler, error)` and refuses a nil base handler, a nil
authentication service and an inconsistent authentication configuration. **The store is
optional**: without it the settlement routes stay unregistered and every request is forwarded to
the composed handler unchanged, exactly like stock ingress on the legacy factories — a missing
settlement store never breaks the server.
