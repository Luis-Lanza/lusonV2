# Branch account settlement (rendición de cuentas)

The warehouse visits a branch in person, freezes its period, counts the stock and the
drawer, settles a commission on what the branch sold and leaves the fund the next period
starts with. In this document the act and the document are always the **rendición de
cuentas**; its period is always the range between two of them, from the closure of the
previous one to the cut instant of this one (the first one of a branch settles an empty
period that starts with the system).

The vertical is one settlement per branch at a time, with the database as its authority
(migrations 034 to 040): it decides the cut instant, the period start, the inherited fund and
the expected stock snapshot; it admits one live settlement per branch; it decides when the
count sheet and the fields of the drawer may be drafted; it reads and freezes the commission
rate when the warehouse proposes; it keeps the proposal rounds and the corrections immutable;
and when the branch accepts a round it applies the counted stock and writes the cash ledger
itself, in one transaction. This contract never restates those rules: it sends the request,
publishes the database's own decision as one status and one stable code and reads back what the
database wrote.

The branch is not only settled: it writes its own operational drawer as it happens — the small
expenses it pays out of its till, the aportes it receives and the recaudaciones it gives up —
corrects a wrong movement with its compensating one, and reads the book of any window with the
drawer it expects. The settlement whose period covers a movement is charged for it. The warehouse
has no drawer of its own: it writes no movement there and reads none through that book.

A closed settlement is never reopened. An error is corrected by an appended correction that
the branch itself approves: the warehouse states what was wrong and why, and only an accepted
correction applies — as compensating deltas against the open period, never by rewriting the
closed document. The settlement publishes the corrections it accepted beside the numbers they
moved, so a corrected number is legible as one, and it publishes the correction that is still
waiting for the branch with its status, so the branch can see what it has to decide and who
proposed it.

## Vocabulary and money

* `arqueo` appears nowhere: not in a route, an identifier, a stored value, an error code or
  this documentation.
* Every amount is canonical two-decimal **text** (`"0.00"`, `"96000.00"`), never a JSON
  number and never a binary float. A padded integer (`"096000.00"`), a missing fraction
  (`"96000"`), three decimals, a negative amount or a comma are all `400 invalid_request`.
* Every percentage is canonical two-decimal text between `0` and `100` (`"12.50"`), exactly
  like the `numeric(5,2)` column that stores it.
* Instants are RFC3339 in UTC, at the precision the column holds: the seconds are always stated and
  the fraction is published whenever the instant has one (`2026-03-02T09:15:00.123456Z`), never
  truncated to the whole second. A window bound taken from a published instant is therefore the
  instant the database holds, so the half-open interval it describes counts the rows recorded in the
  same second on the side the settlement put them.
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
* **Proposing a correction** of a closed settlement is the warehouse's alone, for the same
  reason: a correction is the warehouse's reading of the cut it performed. A branch account is
  refused with `403 forbidden`.
* **Recording an expense** is the branch's alone: the till the money comes out of belongs to the
  branch that records it, so the warehouse is refused (`403 forbidden`) and every branch records
  only in its own.
* **Recording a movement of the operational drawer** — an expense, an aporte or a recaudación — and
  **correcting one** is the branch's alone, for the same reason: the drawer is the branch's own and the
  warehouse has none, so it is refused with `403 forbidden` and every branch writes only its own.
* **Reading the book of the drawer** is the branch's for its own. The warehouse is refused with `403
  forbidden`: it sees the movements inside the settlement (S10), never through the branch's own book.
* **Deciding** is the branch's alone: any enabled account of the branch the settlement
  belongs to accepts or rejects. The warehouse cannot decide (`403 forbidden`), and neither
  can another branch. The same rule decides a correction of that branch's closed settlement.
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
| `/api/closings/branches/commissions` | GET | 200 with every configured commission, its author and its moment |
| `/api/closings/{id}` | GET | 200 with the whole settlement |
| `/api/closings/{id}/count` | POST | 200 with the settlement and its count sheet |
| `/api/closings/{id}/materials` | POST | 200 with the settlement and its material sheet |
| `/api/closings/{id}/cash` | POST | 200 with the settlement and its drawer |
| `/api/closings/{id}/propose` | POST | 200 with the settlement and the round it now offers |
| `/api/closings/{id}/decision` | POST | 200 with the settlement and the branch's answer |
| `/api/closings/{id}/corrections` | POST | 201 with the proposed correction |
| `/api/closings/corrections/{correction}/decision` | POST | 200 with the correction and the branch's answer |
| `/api/closings/expenses` | POST | 201 with the recorded expense |
| `/api/closings/cash-movements` | POST | 201 with the recorded movement of the operational drawer |
| `/api/closings/cash-corrections` | POST | 201 with the recorded correction of one movement |
| `/api/closings/cash-ledger` | GET | 200 with the book of the drawer over one window |

No other method and no other path is served by this contract: `405 method_not_allowed` with
an explicit `Allow` header (`GET, POST` for the collection, `GET, POST` for the commission,
`POST` for the expenses and for the two writes of the drawer, `GET` for the book of the drawer and
for one settlement, `POST` for each operation). Every mutation
requires the usual same-origin session cookie, `Origin`, `Sec-Fetch-Site` and `X-CSRF-Token`;
every read requires the session only. A query string is not part of any route here except the
branch history (`GET /api/closings`) and the book of the drawer (`GET
/api/closings/cash-ledger`), where it is the query itself: on every other route `?page=1` and a
bare `?` are `400 invalid_request`.

`{id}`, `{branch}` and `{correction}` admit only canonical positive integers: `01`, `+1`, `0`,
`1.0`, `abc` and an integer outside the column range are `400 invalid_request`, never a cleaned
or redirected path. Any other path below `/api/closings/` is `404 not_found` as JSON, and an
ambiguous path is refused before it can be cleaned: a doubled slash, a `.` or `..` segment, a
backslash, a NUL or an encoded alias (`%31` for `1`, `%2F` for `/`) is `404 not_found`. A
trailing slash is `404 not_found`, never a redirect.

The commission path is a longer literal path than a settlement id, so it is never captured by
`{id}` and never collides with the suffix of an operation. `expenses` is a literal path beside
`{id}` for the same reason: it is never read as a settlement id, and it names no settlement at all.
`corrections` is the literal suffix of one settlement's own collection, so it is never read as an
id either, and `count`, `materials` and `cash` are the same kind of literal suffix, which is why the
three sheets of a settlement are never confused with a document id. The decision of a correction is
named by the correction's **own** id:
`corrections/{correction}/decision`. The branch decides the correction the database locked, and
the settlement it belongs to is stated in its body, so no route has to guess which document the
path meant.

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
 "cash_sales":"0.00","cash_expenses":"0.00","cash_effective":"0.00","expected_cash":"100.00",
 "counted_cash":null,"cash_difference":null,"contributed_cash":"0.00","closing_cash":null,
 "taken_cash":null,"sales_total":"0.00","commission_amount":"0.00","card_total":"0.00",
 "transfer_total":"0.00","qr_total":"0.00","observation":"","opened_by_account_id":1,
 "count_lines":[{"variant_id":1,"catalog_entry_id":1,"brand":"TOYO","model":"NS40ZL",
  "capacity_ah":"45","polarity":"L","expected_quantity":28,"counted_quantity":28}],
 "rounds":[]}
```

* `branch_location_id` is the only field of the body. The cut instant, the period start, the
  inherited fund and the expected snapshot are the database's facts: a client that states one
  of them is rejected as an unknown key.
* The warehouse is not a branch: branch `1`, `0` and everything above the column range are
  `400 invalid_request`.
* Opening freezes the branch (it can no longer sell, load an expense, receive a transfer,
  receive stock or reconcile), freezes the cut instant of the period, seeds the count sheet
  with the branch's own stock at that instant — every line already stating the quantity the
  system expects — seeds the material sheet with what the period bought (see
  [the third account](#the-third-account-materials)) and inherits the fund left by the previous
  closure (`opening_cash`; `"0.00"` for the first settlement).
* **A branch holds one live settlement at a time**: a second opening is
  `409 {"error":"settlement_live","branch_location_id":2}` and writes nothing. `open`,
  `proposed` and `rejected` are all live, so only a closed settlement leaves the branch free.
* A retired branch is refused by name: `409 {"error":"branch_retired","branch_location_id":3}`.

The answer is the whole settlement document, so a period the branch already sold shows its money
here too: the settlement above is the first one of a branch, whose window is empty, and a later
one publishes the derived `cash_sales`, `cash_expenses`, `cash_effective`, `sales_total`,
`card_total`, `transfer_total`, `qr_total` and `commission_amount` of its own window (see
[Frozen from the proposal, derived before it](#frozen-from-the-proposal-derived-before-it)).

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
* The sheet opens **aligned with the system**: every variant the branch held at the cut is
  seeded with `counted_quantity` equal to the `expected_quantity` the database photographed. No
  variant is pending, so the warehouse writes only the lines where its count disagrees with the
  system and proposing needs no count edit at all. A line it never writes stays exactly as the
  system read it, so an untouched variant and one counted at that same number are one and the
  same row: this contract keeps no mark of "counted" or "assumed". A line without a counted
  quantity can only come from a sheet written before that seeding, and the defensive refusal
  that names it is documented with the proposal.

## Drawer draft

```
POST /api/closings/1/cash
{"counted_cash":"96000.00","contributed_cash":"0.00","closing_cash":"6000.00",
 "observation":"contado en persona","purchase_fund_counted":"240.00",
 "purchase_fund_cash":"400.00"}
```

The four keys of the drawer are mandatory: an amount the warehouse has not counted yet is the
explicit JSON `null`, never an absent key and never an invented zero. `contributed_cash` is the
money the warehouse puts into the drawer (it is `"0.00"` in the normal case and the declared fund
in the first settlement); `observation` is free text of at most 1000 characters, persisted
verbatim.

The two keys of the purchase envelope are the only optional ones (see
[the purchase fund](#the-purchase-fund-the-second-envelope)): a body without them states an
envelope nobody counted, which is exactly the state of a settlement whose warehouse has not opened
the envelope yet.

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

Four numbers of the drawer are **never persisted**. They are derived from the facts that
produce them on every read, so they cannot disagree with those facts:

| Field | Identity |
|---|---|
| `cash_effective` | The **signed** effect of every movement the branch wrote inside the window, read from `branch_cash_ledger` over `[period_start, cut_at)` with `closing_id` null: `+` for an `aporte`, `−` for a `gasto` or a `recaudacion`, and for a `correccion` the opposite direction of the movement it answers. It is the same term the book of the drawer publishes as `effective` and the metrics card publishes as `today.effective` |
| `expected_cash` | `opening_cash + cash_sales + cash_effective` — the drawer's one rule, shared with the book of the same window (`GET /api/closings/cash-ledger`) and with the metrics card, so the acta and the book of one period can never state two numbers (S4, S13) |
| `cash_difference` | `counted_cash - expected_cash`, with its sign: negative is a shortage (`-100.00`), positive a surplus, zero when it matches |
| `taken_cash` | `counted_cash + contributed_cash - closing_cash`, never negative by the fund bound |

The net `cash_expenses` of the document is **already one term of `cash_effective`** — the `gasto`
rows and the corrections that answer them are among the movements that effect sums — so it is
reported beside the drawer, as what the branch paid, and it is **never subtracted a second time**.
A period that inherited 100.00, paid out 45.50 and received 30.00 has an effect of `-15.50` and an
expectation of `84.50`; the same 84.50 the book of that window publishes.

`cash_difference` and `taken_cash` are `null` until the drawer states what they need:
`cash_difference` needs `counted_cash`, and `taken_cash` needs `counted_cash` and
`closing_cash`.

On a closed settlement, `counted_cash` and `closing_cash` are the numbers the branch signed plus
the deltas its accepted corrections journalled, so the three identities above always describe the
drawer as it reads after them; how much a correction moved is published in its own `effects`.

`commission_amount`, `card_total`, `transfer_total` and `qr_total` are **reported beside** the
drawer and are part of no cash identity in this document: the commission is never subtracted
from the counted cash, never generates a cash movement and never enters any of the three
identities above. Card, transfer and QR are money the branch collected and never holds in its
drawer, so they are published as their own amounts and are never added to `cash_sales`,
`expected_cash`, `cash_difference` or `taken_cash`.

From the proposal on, `cash_expenses` is the sum of the `expenses` the same document publishes —
the ledger of its own window — so the total and its breakdown always describe one period. While the
settlement is `open`, the same document publishes the `expenses` of its window and derives that
total from them, so the operator reads the exact amounts the proposal is about to subtract.

### Frozen from the proposal, derived before it

`sales_total`, `cash_sales`, `cash_expenses`, `card_total`, `transfer_total`, `qr_total` and
`commission_amount` are **frozen by the database when the warehouse proposes**, over the window
`[period_start, cut_at)` of the settlement: they are the offer the branch is asked to accept, so
nothing rewrites them afterwards — not a later sale, not a later change of the configured rate, not
the closure.

| State | What those seven fields publish |
|---|---|
| `open` | **Derived**, from the same ledgers and the same window the proposal uses: the sale subtotals, the collection by payment method and the branch's expense ledger. Nothing is written; the row still holds its zeros. |
| `proposed` | The columns the proposal froze: the offer the branch is deciding. |
| `rejected` | The columns the proposal froze: the offer the branch answered. A later read never re-derives it, so a rejection keeps showing exactly what was rejected. |
| `closed` | The columns the closure froze: the history its branch signed. |

Before the proposal there is nothing to freeze, so an `open` settlement publishes the period its
ledgers hold at that instant — the cash in the drawer, the expenses of the window, the signed
effect of its movements, the total sold, the electronic collection and the commission — and
`expected_cash` follows from it (`opening_cash + cash_sales + cash_effective`). This is what makes the expectation of an open
settlement real instead of zero, and it is the same arithmetic, over the same window, that the
proposal records: the draft is a preview of exactly the numbers the branch will be asked to accept.

The previewed commission uses the branch's **currently configured** rate, which is the one a
proposal made at that instant would freeze; `commission_rate_percent` itself stays `null` while
the settlement is `open`, because nothing is frozen yet. Only a rate change *between* the read and
the proposal makes the preview differ from the offer, and the proposal then publishes the frozen
rate and amount. A branch without a configured rate has no commission to preview: the settlement
opens anyway, publishes its period with `commission_amount` `"0.00"`, and the proposal is the
route that refuses it with `409 commission_rate_missing`.

The values of a `rejected` or `closed` settlement are never re-derived, and this is deliberate: a
rejection keeps the offer the branch answered, and a closure is the history its branch signed, so
deriving them would let a later rate change rewrite what was accepted.

## The purchase fund: the second envelope

The branch holds a second envelope of physical money, apart from the operating drawer: the purchase
fund ("fondo de compras"), which pays for used batteries and scrap and for nothing else (S1, S2).
It is counted apart from the drawer, it is settled in the same document, and it participates in
**none** of the drawer's three identities and in no part of the commission: no money of a sale
feeds it, and the drawer above is exactly what it was before this envelope existed (S12). A branch
purchase is charged by the document itself, never by a ledger row of this vertical: there is no
`branch_cash_movements` movement for the envelope. The envelope has a book of its own instead
(`branch_fund_movements`, migration 048), and **its only balance is the signed sum of
`purchase_fund_ledger`**: the load of a branch (`aporte`), the `compra` of every purchase
document, the `reposicion` a closure writes with the fund it leaves, the `devolucion` a closure
writes with the surplus it takes back, and the `correccion` that answers any of them. The direction
of a movement is its **kind** and never its amount (migration 052): every amount is positive, so
`devolucion` is how the book says money left the fund, and the signed effect of a row is computed
in one place -- `branch_fund_effective` -- which the view publishes and the admission of the ledger
measures with, so the guard and the balance it guards cannot disagree.

| Field | Identity |
|---|---|
| `purchase_fund_opening` | The fund the previous `closed` settlement of the same branch published — the last closure at or before this settlement's `period_start`, by `closed_at` descending; `"0.00"` when there is none. It is that closure's own `purchase_fund_cash`, read by the one rule of a closed settlement's fund (`settled_purchase_fund`, migration 052), and never the live branch state: a closed row never changes, so a period's opening is frozen by construction, and a history row of an old period never reads the envelope of a later one |
| `purchases_total`, `purchases_cash` | The sums of `total` and `paid_cash` of the branch purchases inside `[period_start, cut_at)`. Counter-documents are stored with negative amounts, so they subtract by themselves and are never filtered out (S11) |
| `purchase_fund_expected` | `purchase_fund_opening - purchases_cash`, signed: a period that spent more than it inherited is a shortage |
| `purchase_fund_counted` | What the warehouse counted in the envelope: the column, `null` while it has not counted |
| `purchase_fund_difference` | `purchase_fund_counted - purchase_fund_expected`, with its sign; `null` while `purchase_fund_counted` is `null` |
| `purchase_fund_cash` | The amount the warehouse leaves in the envelope, which opens the next period (S5, S6, S9). On a **closed** settlement it is the number that settlement published, read where that rule lives (`settled_purchase_fund`, migration 052): the signed sum of `purchase_fund_ledger` at its own `closed_at` when its closure wrote the movement that reconciled the book to it, and the amount it stated otherwise -- a settlement closed before a closure settled the fund through its book keeps the number it published, and a historical acta is never recalculated; on a live one it is the draft or the offer the warehouse stated, `null` until it states one |

The opening, the purchases and the expectation are **derived on every read** from those tables,
exactly like the drawer's three numbers, so a published amount can never disagree with the facts
that produce it. `purchase_fund_counted` and `purchase_fund_cash` are the two columns migration 044
adds, drafted through the drawer draft and frozen by the proposal. From the closure on, the second
one stops being the arithmetic: **the fund's balance is the signed sum of `purchase_fund_ledger`**
(migration 048) and is computed nowhere else — the closure reconciles the book to the amount the
warehouse stated (migration 051) and every reader publishes the book, so the column is the statement
the branch accepted and never a second number that could differ from it:

* **While `open` or `rejected`** both are drafts of the warehouse, exactly like the drawer. Both are
  optional and both are canonical non-negative amounts. The new amount is **not** bounded by the
  counted one: the warehouse brings money from outside the branch, so it may leave more than it
  found.
* **From `proposed` on** both are the offer the branch decides, and the database freezes them with
  the rest of the drawer (LC005): the closure applies exactly the envelope that was offered, and
  there is no route that writes them afterwards.
* The **difference never blocks**. Like `cash_difference` it is informational and published with its
  sign; a proposal is refused by a pending line of the count sheet, never by an envelope counted
  above or below its expectation (S8).
* The envelope is **not required at the closure**: a settlement whose warehouse has not stated an
  amount closes with `null` in the column, and its acta publishes the book's own sum, because an
  unstated fund is zero and not unknown (S7). No movement is written in that case: the book already
  says what the fund holds.
* **The closure settles the fund through its book** (S9). The amount the warehouse leaves is written
  as a movement of `branch_fund_movements` whose amount is the difference against the book's balance
  at that instant, read under the lock of the branch (`340251`), and signed by the settlement's own
  opener; the row also **names the settlement** it states (`closing_id`, unique), which is what lets
  that settlement's acta read its own movement later. It is the difference and not the stated amount,
  because writing the amount would count the fund twice; and the **direction is the kind's**: a
  settlement that leaves more than the book holds loads the fund with a `reposicion`, and one that
  leaves less takes the surplus back with a `devolucion`, both with a positive amount. The balance
  after the closure is therefore exactly the stated amount. S6 still wins: the statement is a column
  of 044 that is never negative, so no closure can drive the fund below zero, and the difference can
  only take out what the book holds. The two kinds are the closure's alone: `devolucion` is refused
  to any other writer, and a movement of the period that names a settlement is refused with it, so
  no branch can drain its fund with no acta behind it.
* **A fund that changes after the closure appends its movement** (S5, S9). The ledger is append only
  and a closed settlement is never rewritten, so a correction of the fund is a new row -- a
  `correccion` that answers the `reposicion`, the `devolucion`, the `compra` or the `aporte` that
  made the book wrong -- and the balance follows the sum. The closed acta keeps publishing the fund
  it settled: it is history, and the correction is a fact of the period that follows, which is the
  fund the next closure states.

## The third account: materials

The purchase fund above says how much money the envelope still holds; this account says what that
money bought (S7). A branch buys used batteries by the unit, one model at a time, and scrap by
weight, one material at a time — the four materials of the reference table, all of them weighed in
kilograms — and at the cut the warehouse counts both against what the period bought.

| Field | Identity |
|---|---|
| `kind` | `used` for a model counted in whole units, `scrap` for a material weighed in kilograms |
| `model`, `material_id`, `material` | The key of the line: a used line names its model and no material, a scrap line the id and the name of its material from the reference table and no model. The side that is not the key is `null`, so every line carries the same keys |
| `unit` | `unit` or `kg`: the unit every quantity of the line is counted in, which is also the scale it is published with |
| `expected_quantity` | What the period bought: the `sum(quantity)` per model and the `sum(kg)` per material of the branch purchases inside `[period_start, cut_at)`. Counter-documents are stored with negative quantities and kilograms, so a reversal inside the period subtracts by itself (S11) and no document is filtered out |
| `counted_quantity` | What the warehouse counted at the cut: the column, `null` while it has not counted the line |
| `difference` | `counted_quantity - expected_quantity` with its sign, at the scale of the unit: `-1` is a battery the period bought and nobody found, `-1.250` a kilogram and a quarter of scrap. `null` while the line is uncounted |
| `delivered_quantity` | Everything that was counted, because the warehouse takes it all and the branch keeps nothing (S9). Derived on every read and never stored: there is no remnant field and no column, and an uncounted line delivers `null` |

The expected quantity is a **fact of the opening**, not something the warehouse types. The previous
closure took every battery and every kilogram to the warehouse, so the shelf starts at zero by
construction and what must be on it at this cut is exactly what the period bought, no more and no
less (S7). The opener therefore seeds one line per model and per material of its own window with
that sum, and a key the period did not buy gets no line at all — one that nets zero because it was
returned whole, and one the period only returned. An empty sheet is the truth of a period that
bought nothing, and it is published as `[]` and never as a missing key.

The counted quantities are written in one route, in the shape of the count sheet rather than as
fields of the drawer (S8):

```
POST /api/closings/1/materials
{"lines":[{"kind":"used","model":"NS60ZL","counted_quantity":"7"},
          {"kind":"scrap","material_id":1,"counted_quantity":"12.500"}]}
```

* The body states **only** what was counted. `expected_quantity`, `difference` and
  `delivered_quantity` are not part of it at all — the first is the fact of the opening and the
  other two are derived from it — so a blinded count of this sheet cannot even be expressed,
  exactly like the count sheet of the stock.
* `lines` holds 1 to 190 entries, one per line of the sheet, each with the one key its kind names
  (`model` for a used line and `material_id` for a scrap one, and never both) and a
  `counted_quantity` that is the canonical text of that kind's unit: a whole number of units for a
  used line and kilograms with exactly three decimals for a scrap one, which is the scale the
  weight of a purchase already stores. A quantity of the other scale — `"7.5"` for a battery or
  `"12.5"` for a kilogram — is `400 invalid_request`, and so is a JSON number, a padded or
  negative value, a material outside the reference table and a key stated twice.
* A line that already exists only changes its counted quantity, and a line the period did not buy
  is added with an expected quantity of **zero**, which is the database's own fact of the opening
  for that key and never a promise of the client. A line the request does not state keeps the count
  it has, so writing the same request twice leaves the same sheet.
* The sheet may be written **only while the warehouse holds the settlement**: `open` and
  `rejected`. While the branch is deciding (`proposed`) it is `409 count_frozen`, and forever after
  the closure too. No line is ever removed and the expected quantity of a line never moves.
* A line nobody counted is **published as `null` and never blocks the proposal**: the stock count
  sheet stays the only gate of the offer. A difference is informed, exactly like the cash one
  (S8), and it is informed in both directions: material missing from the shelf and material the
  period did not buy are both published with their sign and neither refuses anything.
* The closure **keeps the counts** the branch signed and publishes the delivery of every counted
  line, which is the whole count because the warehouse takes everything (S9). After the closure
  the sheet is history: no route moves it and no correction touches it.
* None of this is money. The used units and the kilograms enter no identity of the drawer, no part
  of the commission and none of the envelope of the purchase fund (S12): they are the register of
  what the money of that envelope bought, published beside it.

## Expenses of the branch

The branch records the small expenses it pays out of its own till as they happen (S12): no approval
precedes them and no settlement is named, because the settlement that covers an expense is the one
whose period contains the instant it was recorded.

```
POST /api/closings/expenses
{"amount":"45.50","description":"Flete"}
```

```json
{"id":12,"branch_location_id":2,"kind":"gasto","amount":"45.50","description":"Flete",
 "occurred_at":"2026-03-02T09:15:00Z","created_by_account_id":2,"corrects_id":null}
```

* Both keys of the body are mandatory and there are no others. `amount` is canonical two-decimal text and is
  never zero; `description` is valid UTF-8 without NUL, at most 500 characters and never blank
  once trimmed, and it is published exactly as it is stored, so a padded `" Flete "` is `400
  invalid_request` instead of a silently trimmed one.
* The answer states the eight keys of a row of the branch's till: `id`, `branch_location_id`,
  `kind`, `amount`, `description`, `occurred_at`, `created_by_account_id` and `corrects_id`. The row
  this route writes is a `gasto` that names no other movement, so `corrects_id` is `null` — the key is
  always published and never omitted — and `kind` is what tells this row from the correction of an
  expense in the acta that lists both (see [the acta's expense
  list](#the-actas-expense-list-is-the-ledger-it-totals)).
* The branch is the **session's own**: `branch_location_id` and `created_by_account_id` are the
  account's, never the body's, and `occurred_at` is the database's, so no caller records an
  expense in another till nor backdates one into an already settled period.
* Only the branch records an expense, because the till the money comes out of is the branch's. The
  warehouse has no till of its own and is refused with `403 forbidden`.
* While a settlement holds the branch the expense is refused with `409 branch_frozen`: the drawer
  that would move is the one being counted (S3). A refusal writes nothing at all — no movement, no
  counter, no change to the settlement.
* A recorded expense is immutable: it is never edited and never deleted, and a wrong one is
  corrected with its opposite movement, which is the [correction of the
  drawer](#corrections-of-the-drawers-book) below.
* The expense is not attached to a settlement by the caller: it belongs to the period whose window
  `[period_start, cut_at)` contains its instant, and that settlement publishes it.

### The acta's expense list is the ledger it totals

The settlement publishes in `expenses` the rows of the branch's own ledger inside its window —
`branch_cash_ledger`, the same view the total is read from — with `closing_id` null, whose effect
kind is a `gasto`. That is the pay-outs of the period **and** the corrections that answer them
(S13): a correction is listed beside the expense it corrects, with `kind: "correccion"`, its own
positive amount and the `corrects_id` of the movement it answers, so a reader of the acta sees the
direction of every row of the ledger instead of a list only the total knew about. `cash_expenses`
is the net of exactly those rows — a correction lowers the expense it answers — so the list and the
total beside it always describe one period and never two readings of it.

The direction of a row is `kind` plus `corrects_id`, never the sign of `amount`: an amount is
always the positive fact the branch stated, and the ledger's sign is a reading of the view. The
reference is published on every row, `null` on a pay-out and the corrected movement's id on a
correction, which is the same shape rule the database enforces; a row of any other shape is refused
instead of described.

## The operational drawer: aportes, recaudaciones and corrections

The branch's operational drawer is the counter's till, and it is a box of its own: it is not the
purchase fund (S3) and no movement of one ever moves the other. The branch writes **four** kinds in
it, and the amount of every row is positive canonical money with two decimals — the direction the
movement moves the drawer is the ledger's own reading, never a sign the caller stores (S11):

| Kind | Direction of the drawer | Written by |
|---|---|---|
| `gasto` | out (it pays for the store: detergent, brooms, a small errand) | the branch |
| `aporte` | in (the drawer receives cash to work with) | the branch |
| `recaudacion` | out (the cash is collected and taken away) | the branch |
| `correccion` | the opposite of the movement it answers | the branch, naming that movement |

```
POST /api/closings/cash-movements
{"kind":"aporte","amount":"100.00","description":"Cambio para el cajón"}
```

```json
{"id":21,"branch_location_id":2,"kind":"aporte","amount":"100.00",
 "description":"Cambio para el cajón","occurred_at":"2026-03-02T09:15:00Z",
 "created_by_account_id":2}
```

* The three keys are mandatory and there are no others: `kind` is one of `gasto`, `aporte` and
  `recaudacion`, `amount` is canonical two-decimal text and is never zero, and `description` is the
  same text the expense route admits (valid UTF-8 without NUL, at most 500 characters, never blank
  once trimmed, and published exactly as it is stored). An extra key, a `correccion` here, a padded
  description or a JSON number for an amount is `400 invalid_request`.
* The branch is the **session's own** (S12): `branch_location_id` and `created_by_account_id` are the
  account's and never the body's, and `occurred_at` is the database's, so no caller writes another
  branch's drawer nor backdates a movement into a period that is already settled.
* The warehouse has no drawer of its own and is refused with `403 forbidden`. While a settlement
  holds the branch the movement is refused with `409 branch_frozen` (S9), exactly like the expense of
  the same till. A refusal writes nothing at all.
* A movement of the period belongs to no settlement: the settlement that covers it is the one whose
  window `[period_start, cut_at)` contains its instant.

### Corrections of the drawer's book

The book is immutable, so a wrong movement is answered by a compensating one of kind `correccion`
that names the movement it corrects (S6). Nothing is edited, nothing is deleted, and a correction is
never corrected.

```
POST /api/closings/cash-corrections
{"corrects_id":21,"amount":"20.00","description":"Aporte mal cargado"}
```

```json
{"id":22,"branch_location_id":2,"kind":"correccion","amount":"20.00",
 "description":"Aporte mal cargado","occurred_at":"2026-03-02T09:22:00Z",
 "created_by_account_id":2,"corrects_id":21}
```

* The three keys are mandatory and there are no others: `corrects_id` is a canonical positive integer
  and the answer states it beside the shape of a movement.
* The amount is **positive** and the sign is the ledger's: a correction carries the opposite direction
  of the movement it answers, so correcting a `gasto` returns money to the drawer and correcting an
  `aporte` takes it back out. Writing the sign itself would say the error twice.
* Refusals: a target the book may not answer — an unknown movement, one of another branch, another
  correction, the transfer of a settlement, or a movement of a period a closure already signed (S7) —
  is `400 {"error":"correction_target_invalid"}`; a correction that would take the corrections of one
  movement above the amount that movement stated is `409 {"error":"correction_exceeds"}`. The tope is
  the sum, so one movement may be corrected in parts. A frozen branch is `409 branch_frozen` and the
  warehouse is `403 forbidden`.

### The book of the window

```
GET /api/closings/cash-ledger
GET /api/closings/cash-ledger?from=2026-03-01T00:00:00Z&to=2026-03-23T18:30:00Z
```

```json
{"since":"2026-02-23T18:00:00Z","until":null,"opening":"100.00","sales":"96000.00",
 "effective":"44.50","expected":"96144.50","truncated":false,
 "movements":[
  {"id":21,"kind":"gasto","effect_kind":"gasto","amount":"45.50","effective":"-45.50",
   "description":"Detergente","occurred_at":"2026-03-02T09:15:00Z",
   "created_by_account_id":2,"corrects_id":null},
  {"id":22,"kind":"correccion","effect_kind":"gasto","amount":"10.00","effective":"10.00",
   "description":"Detergente mal cargado","occurred_at":"2026-03-02T09:22:00Z",
   "created_by_account_id":2,"corrects_id":21}]}
```

* `from` and `to` are both optional and each appears at most once, as an RFC3339 instant. An absent
  bound is the store's own default: without `from` the window starts at the cut of the last closed
  settlement and `opening` is the fund that closure left in the drawer; with an explicit `from` that is
  exactly a closed settlement's `period_start` — the instant itself, microseconds included — the window
  is the one that settlement settled, so `opening` is the amount that period inherited and the book of a
  settled window closes with its acta. Any other explicit `from` inherits nothing and `opening` is
  `"0.00"`. Without `to` the window has no end and `until` is
  `null`. An unknown key, a repeated bound, an empty value, a bare `?`, an instant that does not parse
  and a window that ends before it starts are `400 invalid_request` — the branch is never a query value
  (S12).
* `expected` is the drawer's **one rule** (`opening + sales + effective`), the same arithmetic the acta
  of a settlement publishes as `expected_cash` over its own window (`opening_cash + cash_sales +
  cash_effective`): the book of a period and its acta state one number, never two (S4, S13).
* `since` and `until` are the window the numbers describe, so a screen reads the period it was given
  instead of guessing it. `opening` is the money the period inherited, `sales` the cash its sales
  collected, `effective` the **signed** sum of the movements of the window and `expected` their one
  identity: `opening + sales + effective` (S4, S13).
* `effective` is the only signed money of this contract: it is canonical two-decimal **text** and it may
  start with `-`. The amount of a row is always positive and `effect_kind` states the direction: an
  `aporte` moves the drawer in, a `gasto` and a `recaudacion` move it out, and a `correccion` carries the
  kind of the movement it answers with the opposite sign.
* `movements` is published **oldest first**, because a book is read in the order it happened.
* `truncated` reports that the window holds more movements than the answer lists: the list is the newest
  500 rows and every number beside it counts the whole window, so a long period publishes a shorter list
  without ever publishing a total that is the sum of the part it kept.
* The book is the movements the **branch** wrote. The `aporte` and the `recaudacion` a closure writes are
  the acta's own facts — the contribution of the Almacén and the money it takes, already stated by
  `contributed_cash` and `taken_cash` — so they are never listed here and never enter this expectation:
  counting them as well would count that money twice (S5). The administrator reads those inside the
  settlement (S10).

## Proposal (offer to the branch)

```
POST /api/closings/1/propose
```

No body is admitted at all: the offer is composed from the ledgers of the period and never
from a client promise. An empty body is required; anything else is `400 invalid_request`.

The proposal is refused, naming what is missing, when:

| Refusal | Status and body |
|---|---|
| A sheet written before the count is seeded still has a pending variant (defensive) | `409 {"error":"count_pending","variant_id":7}` |
| A line lost its counted quantity while the offer was being recorded | `409 {"error":"proposal_stale","variant_id":7}` |
| The drawer is not stated | `409 {"error":"cash_not_stated"}` |
| The fund exceeds the drawer | `409 {"error":"fund_exceeds_drawer","excess":"50.00"}` |
| The branch has no configured rate | `409 {"error":"commission_rate_missing"}` |
| The settlement is not held (already proposed or closed) | `409 {"error":"state_conflict"}` |

The proposal asks for nothing but the drawer. The count sheet is already complete when the
settlement opens, because the opener seeds each counted quantity with the expected one, so
there is no pending variant to resolve and no step between drafting the drawer and proposing.

`count_pending` and `proposal_stale` are kept as **defensive** refusals of the same fact, and
neither is a step of this contract. `count_pending` is what the store answers when it reads a
sheet that still states a missing quantity, which the seeding makes unreachable from the
contract: only a sheet written before that seeding, or a line emptied out of band, can present
it; `proposal_stale` is the database's own `LC019`, raised when a line loses its counted
quantity between that read and the transition that records the offer. Both are conflicts: the
warehouse re-reads the settlement and proposes again, and neither is an outage.

On success the database freezes the configured rate on the settlement, records the period
totals and the commission and the warehouse's round is added to the history:

```json
{"id":1,"status":"proposed","commission_rate_percent":"10.00",
 "opening_cash":"100.00","cash_sales":"96000.00","cash_effective":"0.00","expected_cash":"96100.00",
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

## Corrections of a closed settlement

A closed settlement is never reopened, edited or deleted. An error is corrected by a
**correction**: the warehouse states what was wrong and why, and the branch accepts or rejects
it. Nothing is applied until an acceptance, and an acceptance never rewrites the closed
document: it records the deltas of the corrected values as compensating effects, applies the
stock delta to the branch inventory in both directions, folds a fund delta into the opening
cash of the next period exactly once, and leaves the commission as reported money that moves
no till (S16).

```
POST /api/closings/1/corrections
{"reason":"conté mal el cajón y faltaba una batería",
 "payload":{"counted_quantities":[{"variant_id":3,"counted_quantity":8}],
            "counted_cash":"150.00",
            "commission_amount":"516.27",
            "closing_cash":"60.00"}}
```

```json
{"id":2,"closing_id":1,"status":"proposed",
 "reason":"conté mal el cajón y faltaba una batería",
 "payload":{"counted_cash":"150.00","counted_quantities":[{"variant_id":3,"counted_quantity":8}]},
 "proposed_by_account_id":1,"proposed_at":"2026-03-24T09:00:00Z",
 "decided_by_account_id":null,"decided_at":null,"decision_reason":"","effects":[]}
```

* Both keys of the body are mandatory and there are no others: `reason` and `payload`. The
  reason is valid UTF-8 without NUL, at most 1000 characters and never blank once trimmed, and
  it is published exactly as it is stored, so a padded `" conté mal "` is `400 invalid_request`.
  It is the warehouse's motive, not the branch's.
* `payload` states **at least one** of four values, and every one of them is optional: the
  values a correction does not touch stay **absent** instead of being restated, so a client can
  read which numbers this correction rewrote.
  * `counted_quantities` is the same array the count sheet admits (1 to 190 lines, one per
    variant, `counted_quantity` from `0` to `1000000`). The variant must be on the closed
    settlement's own sheet: a variant it never counted has no recorded quantity to take a
    difference against, and is `409 {"error":"correction_payload"}`.
  * `counted_cash` is the corrected cash the branch counted at the cut.
  * `commission_amount` is the corrected commission of the period. It is informational money
    settled outside the system, so it moves no till and no balance.
  * `closing_cash` is the corrected fund, and it never exceeds the cash counted plus the
    contribution the warehouse made: `409 {"error":"fund_exceeds_drawer","excess":"50.00"}`,
    the same bound and the same sentence the closure uses.
  * An amount is canonical two-decimal **text**: a JSON number (`150.00`), a `null`, a padded or
    one-decimal value is `400 invalid_request`.
* A correction states what the drawer, the count and the fund should have been, not the
difference: the delta is derived against the settlement's own values as its accepted
corrections already amended them, so successive corrections converge on the number the branch
counted instead of applying the same difference twice.
* **One correction waits at a time**: while the branch has not answered, a second proposal is
`409 {"error":"correction_pending"}` and writes nothing.
* A live settlement is not corrected: `409
{"error":"correction_not_closed","closing_id":1}` names the settlement to look at, because a
settlement that is `open`, `proposed` or `rejected` is corrected by its own rounds.
* A correction never freezes the branch: the settlement is already closed, so the branch keeps
selling, receiving stock and recording expenses while it decides.
* The correction that waits for the branch is **published with the settlement**, with
`"status":"proposed"`, its reason, its payload and the account that proposed it: the branch reads
what it has to decide from the document it already holds, and no second route lists corrections.
No number of the document moves until the branch accepts, and a rejected correction is never
published because it applied nothing.

```
POST /api/closings/corrections/2/decision
{"decision":"accepted"}
{"decision":"rejected","reason":"lo reviso con el contador"}
```

* `accepted` is the only answer that applies anything: the deltas of the corrected values are
  recorded as effects of that correction, the stock of every corrected variant moves by its
  difference (in both directions, never under its reserved stock), and a corrected fund becomes
  the opening cash of the next period. The corrected drawer and the corrected fund are what the
  document publishes, while a corrected commission is published as the delta of its effect beside
  the reported `commission_amount` of the period: the commission is reported money that enters no
  cash identity (S9), so it is not folded into any other number.
* `rejected` states a **mandatory reason** — the same text rules as a rejection of a round — and
  applies nothing at all: no stock, no drawer, no fund, no delta, no correction published in the
  document. The settlement stays closed and cannot be proposed again; the warehouse simply
  proposes another correction, with no limit of rounds.
* A decided correction is final: a second decision is `409 {"error":"correction_decided"}`.
* Only an enabled account of the branch that owns the settlement decides. Another branch and the
  warehouse are `403 forbidden`, and nothing is written.
* A fund correction is refused with `409 {"error":"correction_fund_started"}` when a later
  settlement already exists: that period inherited its opening cash from the recorded fund and
  there is no coherent place left to apply the delta, so it is named instead of silently leaving
  a drawer wrong. The correction is proposed normally and refused when it is accepted.

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
| `cash_sales`, `cash_expenses` | The cash the branch collected and the expenses it recorded in the period: derived from the ledgers while the settlement is `open`, frozen from the proposal on |
| `cash_effective` | The signed effect of the movements the branch wrote in the window: derived on every read, see above. It is the term `expected_cash` is built from |
| `expected_cash` | Derived, see above |
| `counted_cash`, `cash_difference` | What was counted and its sign against the expected drawer; `null` while uncounted |
| `contributed_cash`, `closing_cash`, `taken_cash` | The contribution, the fund left behind and what the warehouse takes; see above |
| `purchase_fund_opening`, `purchases_total`, `purchases_cash` | The second envelope: what it inherited, and the sums of the purchases of the window (counter-documents included); derived on read, see [the purchase fund](#the-purchase-fund-the-second-envelope) |
| `purchase_fund_expected`, `purchase_fund_counted`, `purchase_fund_difference` | The expectation of the envelope, what the warehouse counted in it and the sign of the difference; the count and the difference are `null` until it is counted, and the difference never blocks |
| `purchase_fund_cash` | The amount the warehouse leaves in the envelope, which opens the next period; on a `closed` settlement the signed sum of the fund's book at its `closed_at` (migration 051), and on a live one the draft or the offer; `null` while the warehouse has not stated one and the settlement is not closed |
| `sales_total`, `commission_amount` | The commission base and the reported commission of the period: derived from the ledgers and the configured rate while the settlement is `open`, frozen from the proposal on |
| `card_total`, `transfer_total`, `qr_total` | The electronic collection of the period, published on its own, with the same frozen-or-derived rule |
| `observation` | The free text of the drawer |
| `opened_by_account_id` | The warehouse account that opened it |
| `count_lines` | The sheet, ordered by `variant_id`, with `expected_quantity` and the `counted_quantity` the opener seeded from it, which is the warehouse's own number where it disagreed; `null` only on a sheet written before that seeding |
| `material_lines` | The third account: what the period bought of every used model and every scrap material, what the warehouse counted, the difference and the quantity that goes to the warehouse; ordered by model for the used lines and by material id for the scrap ones, the used ones first. See [the third account](#the-third-account-materials) |
| `expenses` | The expenses of the branch inside this settlement's own window, in the order they were recorded, with the corrections of those expenses among them |
| `rounds` | The proposal history, oldest first |
| `corrections` | The corrections of the closed settlement, oldest first: the accepted ones with the deltas they applied and the pending one, if any, with its status |

Each `count_lines` entry also carries the catalogue identity of its variant — `catalog_entry_id`,
`brand`, `model`, `capacity_ah` (canonical decimal text) and `polarity` — so the sheet is legible
without a second read. Each `material_lines` entry carries `kind`, its key — `model`, or `material_id` and `material` —
`unit`, `expected_quantity`, `counted_quantity`, `difference` and `delivered_quantity`, every
quantity as decimal text: whole units for a used line and kilograms with exactly three decimals for
a scrap one, which is what its `unit` states. The counted quantity, the difference and the delivery
are `null` together, and only while the line is uncounted. Each `expenses` entry carries `id`,
`branch_location_id`, `kind`, `amount`, `description`, `occurred_at`, `created_by_account_id` and
`corrects_id`, which is exactly the shape the recording route answers, so the branch reads its own
expense the same way in both places; `kind` is `gasto` or `correccion`, and `corrects_id` is the
movement a correction answers and `null` on every pay-out, always published. Each `rounds`
entry carries `id`, `round` (the database's own sequence), `offer`, `proposed_by_account_id`,
`proposed_at`, `decision` (`""` while pending, `accepted` or `rejected`), `decision_reason`,
`decided_by_account_id` and `decided_at`; a decided round states who answered it and when, and a
rejected one always states its motive. The `offer` carries the drawer and, when the warehouse stated
it, the envelope of the purchase fund (`purchase_fund_counted` and `purchase_fund_cash`), which are
absent from an offer made before the envelope existed.

Each `corrections` entry carries `id`, `closing_id`, `status` (`accepted`, or `proposed` for the
one correction that still waits for the branch's decision — a rejected one applied nothing and is
never published),
`reason` (the warehouse's), `payload` (the four values it stated, each **absent** when the
correction did not touch it), `proposed_by_account_id`, `proposed_at`,
`decided_by_account_id` (`null` while pending), `decided_at` (`null` while pending), `decision_reason` (always empty for an acceptance) and
`effects` (`[]` while pending, because nothing is applied before the acceptance). Each effect is `kind` plus exactly the unit of that kind: `stock` carries
`variant_id` and `quantity_delta` (a whole quantity, either direction) and a `null`
`amount_delta`; `counted_cash`, `commission` and `fund` carry a signed `amount_delta` and a
`null` `variant_id` and `quantity_delta`. A document of a closed settlement whose `counted_cash`,
`cash_difference` or `taken_cash` is the result of a correction therefore states both the
corrected number and the delta that produced it, so a client never needs a second request to
tell a corrected number from the signed one and the signed one is `corrected - delta`.

The published document is revalidated before it is written: a settlement whose money is not
canonical, whose derived numbers do not follow their own identity — including the opening, the
purchases and the expectation of the purchase fund — whose count sheet, material sheet or rounds
are out of order, or whose round states a decision it cannot have, is answered `503
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
// abbreviated: every row carries all 37 keys of the settlement document
{"page":1,"page_size":25,"total_closings":2,
 "closings":[
  {"id":2,"branch_location_id":2,"branch_name":"Sucursal A","status":"open",
   "period_start":"2026-03-23T18:30:00Z","cut_at":"2026-04-23T18:30:00Z","closed_at":null,
   "commission_rate_percent":null,"opening_cash":"100.00","cash_sales":"40.00",
   "cash_expenses":"10.00","cash_effective":"-10.00","expected_cash":"130.00","counted_cash":null,
   "cash_difference":null,"sales_total":"40.00","commission_amount":"5.00",
   "card_total":"0.00","transfer_total":"0.00","qr_total":"0.00","closing_cash":null,
   "taken_cash":null,"count_lines":[],"rounds":[],"expenses":[],"corrections":[]},
  {"id":1,"branch_location_id":2,"branch_name":"Sucursal A","status":"closed",
   "period_start":"2026-02-23T18:00:00Z","cut_at":"2026-03-23T18:30:00Z",
   "closed_at":"2026-03-23T18:31:10Z","commission_rate_percent":"10.00",
   "expected_cash":"0.00","counted_cash":"0.00","cash_difference":"0.00",
   "commission_amount":"0.00","closing_cash":"100.00","taken_cash":"0.00",
   "count_lines":[],"rounds":[],"expenses":[],"corrections":[]}]}
```

Rows are ordered by the **cut instant, newest first**, with the newer settlement first when two
share one instant, so paging with a stable `page_size` never repeats or skips a settlement.
`total_closings` counts every settlement of that branch, independent of the requested page,
which makes an empty page beyond the last one harmless.

Every row is the **same document projection** the single read publishes — the whole settlement
shape of the table above, already validated and with its derived money computed from its own
facts — so a history row and the settlement it summarises can never disagree. A row of a
settlement the warehouse still holds therefore publishes the **derived** money of its period, the
same way its document does: `cash_sales`, `cash_expenses`, `sales_total`, `commission_amount`,
`card_total`, `transfer_total` and `qr_total` are filled in from the ledgers of its own window, and
`commission_rate_percent` stays `null` because nothing is frozen before the proposal. The count
sheet, the expenses, the proposal rounds and the corrections belong to the single read: a row
publishes them as empty arrays and `GET /api/closings/{id}` unfolds them. The material sheet, unlike
those four, is part of the same derivation as the money, so **every row publishes its own
`material_lines`**: a page of a branch states what each period bought and what the warehouse counted
of it without a second request per settlement. A row of a corrected settlement therefore publishes
the corrected drawer with `"corrections":[]`; the document of that settlement is where the deltas
are.

## Errors

Failures are exactly one of these; the four refusals an operator acts on name the fact they are
about instead of a generic code.

| Status | Code | Companion key | Meaning |
|---|---|---|---|
| 400 | `invalid_request` | — | Malformed body or framing, an unknown or duplicate key, a non-canonical amount, percentage, id, branch, page or instant, an inadmissible query, a query string outside the history and the book of the drawer, a window that ends before it starts, or a body above 32 KiB |
| 400 | `correction_target_invalid` | — | A correction of the drawer names a movement it may not answer: an unknown one, one of another branch, another correction, the transfer of a settlement or a movement of a period a closure already signed (LC030) |
| 401 | `unauthenticated` | — | No session |
| 403 | `forbidden` | — | The caller is not the actor of this operation (branch on a warehouse route, warehouse on an expense, warehouse or another branch on a decision) |
| 404 | `not_found` | — | No such settlement for this caller, no setting for that branch, or an aliased path |
| 409 | `settlement_live` | `branch_location_id`, `closing_id` | The branch already has a live settlement, named by the refusal; only one exists at a time |
| 409 | `branch_retired` | `branch_location_id` | The branch was retired and is not settled |
| 409 | `count_pending` | `variant_id` | A sheet still states a variant with no counted quantity; out of band only, because the opener seeds every line (defensive) |
| 409 | `proposal_stale` | `variant_id` | The count sheet lost a counted quantity while the offer was being recorded; re-read and propose again |
| 409 | `cash_not_stated` | — | The proposal needs the counted cash and the fund |
| 409 | `fund_exceeds_drawer` | `excess` | The fund exceeds the counted cash plus the contribution by that amount |
| 409 | `commission_rate_missing` | — | The branch has no configured commission rate |
| 409 | `count_frozen` | — | The count sheet or the material sheet is not writable in this state |
| 409 | `state_conflict` | — | The settlement's state does not admit this operation |
| 409 | `closure_refused` | — | The closure's own money rule refused the settlement |
| 409 | `reserved_stock` | `variant_id` | A variant of the branch still holds a reservation |
| 409 | `stock_moved` | `variant_id` | A variant moved during the settlement, so the count is stale |
| 409 | `round_not_accepted` | — | The settlement has no accepted proposal round |
| 409 | `branch_frozen` | — | The branch is frozen by a live settlement and cannot record an expense |
| 409 | `correction_not_closed` | `closing_id` | Only a closed settlement is corrected; the refusal names the live one |
| 409 | `correction_pending` | — | The settlement already has a correction waiting for the branch |
| 409 | `correction_decided` | — | The correction already has an answer, and a decided one is final |
| 409 | `correction_payload` | — | The payload is not a correction this domain applies: a value of the wrong shape or a variant the settlement never counted |
| 409 | `correction_fund_started` | — | The fund of a settlement is corrected before its next period starts |
| 409 | `correction_journal` | — | A delta was journalled outside the acceptance of its own correction |
| 409 | `correction_exceeds` | — | The corrections of one movement of the drawer would exceed the amount that movement stated (LC031) |
| 503 | `service_unavailable` | — | Pool, database, or any unmapped failure |

Failures never leak driver, SQL or configuration details: only the database's own rejection is
trusted, and it is mapped by SQLSTATE. The refusals that name a variant read it back from the
count sheet and the balances — the same rows and the same predicates the database used — instead
of parsing the message of the trigger, so the number in the body is the line that actually
refused the operation. Every other failure of the vertical is `service_unavailable`, including a
stored shape this domain never wrote. The only SQLSTATE of this vertical that still lands there is
the one the store cannot reach at all: `LC020` is the provenance of a settlement ledger row, which
only the closure's own trigger writes.

## Database invariants

`branch_closings`, `closing_count_lines`, `closing_material_lines`, `closing_proposals`,
`closing_corrections`, `closing_correction_effects`, `branch_cash_movements` and `branch_settings`
are the settlement's own tables; the closed settlement, its rounds, its corrections, the journal of
their deltas, the sheets of its materials and the cash ledger are immutable. The database, not the application, decides the following, with
stable SQLSTATEs:

| SQLSTATE | Guard | Published as |
|---|---|---|
| `LC001` | The branch is frozen by a live settlement and cannot operate (sale, purchase, transfer, stock ingress, reconciliation, expense) | `409 branch_frozen` on the expense route, `409 state_conflict` from the document's own routes |
| `LC002` | Only the warehouse settles a branch, and the warehouse is never settled | 403 `forbidden` |
| `LC003` | The branch has no configured commission rate | 409 `commission_rate_missing` |
| `LC004` | Count lines are written only while the warehouse holds the settlement; only the counted quantity moves | 409 `count_frozen` |
| `LC025` | Material lines obey the same window, only the counted quantity of one moves, the expected quantity is written by the seed of the opening alone, and a line is never removed | 409 `count_frozen` |
| `LC005` | Unsupported transition, frozen identity, draft of a proposed or closed settlement, period totals that are not drafts | 409 `state_conflict` |
| `LC006` | The closure's money rule: the fund above the drawer, the drawer not stated, a pending variant — which only out-of-band state produces | 409 `fund_exceeds_drawer`, `cash_not_stated`, `count_pending` or `closure_refused` |
| `LC007` | A variant still holds reserved stock | 409 `reserved_stock` with `variant_id` |
| `LC008` | A proposal belongs to a live settlement and only the warehouse proposes | 409 `state_conflict` |
| `LC009` | Rounds are never deleted and a decided round is final | 409 `state_conflict` |
| `LC010` | Only a proposed settlement is decided, and only by an enabled account of its branch | 403 `forbidden` or 409 `state_conflict` |
| `LC011`, `LC020` | The cash ledger's admission (only the branch records its own expenses; only the closure writes the money of a settlement) and the provenance of a settlement movement | `403 forbidden` from the expense route, 503 `service_unavailable` elsewhere |
| `LC015` | Only the warehouse configures a branch commission, and never to itself | 400 `invalid_request` or 403 `forbidden` |
| `LC016` | The latest proposal round is not accepted, is still undecided, or is not rejected | 409 `round_not_accepted` |
| `LC017` | The branch was retired | 409 `branch_retired` |
| `LC018` | A variant moved during the settlement | 409 `stock_moved` with `variant_id` |
| `LC019` | A variant has no counted quantity at the proposal; out of band only (defensive) | 409 `proposal_stale` with `variant_id` when the store's own read missed it; `409 count_pending` when the store refuses first |
| `LC012` | Only a closed settlement is corrected | 409 `correction_not_closed` with `closing_id` |
| `LC013` | A decided correction is final, and a correction states what the warehouse offered, unchanged | 409 `correction_decided` |
| `LC014` | Only an enabled account of the branch decides a correction | 403 `forbidden` |
| `LC021` | The payload is not a correction this domain applies | 409 `correction_payload` |
| `LC022` | The fund of a settlement is corrected before the next period starts | 409 `correction_fund_started` |
| `LC023` | A correction effect is written by the acceptance of its own correction | 409 `correction_journal` |
| `LC030` | A correction of the drawer names a movement it may not answer: an unknown one, one of another branch, another correction, the transfer of a settlement, or a movement of a period a closure already signed | 400 `correction_target_invalid` |
| `LC031` | The corrections of one movement of the drawer never exceed the amount that movement stated | 409 `correction_exceeds` |
| `LC024` | Location 1 is the warehouse: an expense belongs to a branch | `403 forbidden` from the expense route, 503 `service_unavailable` elsewhere |

One live settlement per branch is a unique index, reported as `409 settlement_live`; a
reference to a settlement that does not exist is reported as `404 not_found`, and a second
pending correction of the same settlement is `409 correction_pending`.

The closure is one transaction: the counted stock, the cash ledger rows of the drawer
(`aporte` for the contribution, `recaudacion` for what the warehouse takes), the state and the
unfreezing of the branch all commit together or not at all. A closure of a settlement whose
branch traded during the period is refused (`LC018`, `409 stock_moved`) instead of restoring
stale stock, and one of a branch that still owes a reserved unit is refused (`LC007`, `409
reserved_stock`); neither applies anything, so resolving the line and accepting again closes the
same settlement.

An accepted correction writes nothing the branch signed: it appends the deltas of the corrected
values to `closing_correction_effects`, moves the corrected variants' stock by their difference in
both directions, and folds a fund delta into the next opening cash exactly once. A correction whose
acceptance fails leaves neither a delta nor an answer behind, and no correction ever reopens,
rewrites or refreezes anything.

## Not served yet

The screen of the operational drawer (`#/caja`) is not part of this contract: it is the frontend
half of the vertical, and every route above is already what it needs. Nothing of the drawer's book
is left unwritten or unread here: the branch records the three kinds of its period, corrects a wrong
row with its compensating movement, and reads the book of any window with its expectation.

## Wiring

The server composes `NewWithClosings(api, service, cfg, closings.New(pool))` after the purchase
ledger, so the settlement owns only its own path and every composed surface keeps its exact
behaviour. The factory returns `(http.Handler, error)` and refuses a nil base handler, a nil
authentication service and an inconsistent authentication configuration. **The store is
optional**: without it the settlement routes stay unregistered and every request is forwarded to
the composed handler unchanged, exactly like stock ingress on the legacy factories — a missing
settlement store never breaks the server.
