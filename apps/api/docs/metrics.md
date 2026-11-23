# Métricas de la sucursal (Metrics)

The branch's own metrics screen, cut **by settlement period and never by calendar
month**: the money of the period, the operational drawer, the purchase envelope,
the best-selling batteries by units, the scrap and the current state.

The read is a **projection, not a second calculation**. Everything a settlement
already states — the money the period collected, the drawer, the envelope and the
material sheet — is read from the closing document itself, through the same
derivation the branch already sees in its workspace, so the metrics and the acta of
one settlement can never disagree. The only numbers this read adds are the ones no
document holds: how many sales and units the window produced, which models they
were, and how many units the shelf has today.

## Authorization

The identity must be a completed **branch** session: an account with `id > 1`
assigned to an active location with `id > 1`, and a completed password change.
Authority always comes from the session — there is no branch parameter, so a branch
reads its own branch and no other. A closing of another branch is an invalid
request, exactly like a foreign settlement.

| Actor | Result |
|---|---|
| Branch account in its own branch | admitted |
| Branch account asking for another branch's closing | `400 invalid_request` |
| Warehouse (account `1`, location `1`) | `403 forbidden` |
| Session that must still change its password | `403 forbidden` |
| Retired branch or retired account | `403 forbidden` |

The consolidated read of every branch belongs to another vertical: this contract
publishes one branch, the one of the session.

## The selector

`period` takes the same tokens the Compras contract takes, minus `pending`: the
balance the branch holds right now is material bought and not yet delivered, so it
is not a stretch of time and has no sales, no drawer and no envelope to state.

| `period` | Period |
|---|---|
| absent, or `all` | every sale the branch ever made |
| `<id>` (a positive integer) | the settlement that id names: a closed one, or the live one the selector offers as the period in progress |

A query with any other key, a repeated key, an empty value, a bare separator, a
padded or zero id, or an id that names no settlement of this branch is
`400 invalid_request`. There is no default period other than the whole history, and
no value is ever guessed.

## The answer

```json
{
  "periods": [
    {"kind": "settlement", "closing_id": 4, "from": "2026-10-20T12:00:00Z",
     "to": "2026-11-01T12:00:00Z", "label": "Rendición #4"},
    {"kind": "open", "closing_id": 5, "from": "2026-11-01T12:00:00Z",
     "to": "2026-11-12T12:00:00Z", "label": "En curso"},
    {"kind": "all", "closing_id": null, "from": null, "to": null, "label": "Todo el historial"}
  ],
  "period": {"kind": "open", "closing_id": 5, "from": "2026-11-01T12:00:00Z",
             "to": "2026-11-12T12:00:00Z", "label": "En curso"},
  "source": "live",
  "sales": {"total": "200.00", "batteries": "185.00", "cash": "100.00", "card": "50.00",
            "transfer": "20.00", "qr": "30.00", "commission": "25.00", "sales": 4, "units": 4},
  "cash": {"opening": "500.00", "sales": "100.00", "expenses": "12.50", "expected": "587.50",
           "counted": null, "difference": null},
  "fund": {"opening": "0.00", "purchases": "0.00", "expected": "0.00", "counted": null,
           "difference": null, "replacement": null},
  "materials": {"used_units": 0, "used_delivered_units": 0, "scrap_milli": 0,
                "scrap_delivered_milli": 0, "materials": []},
  "top_models": [
    {"catalog_entry_id": 1, "brand": "CAR", "model": "NS40ZL", "capacity_ah": "35",
     "units": 3, "money": "300.00"}
  ],
  "stock": {"units": 11},
  "today": {
    "since": "2026-11-01T12:00:00Z", "opening": "500.00", "sales": "240.00",
    "expenses": "12.50", "effective": "-12.50", "expected": "727.50",
    "rate": "4.50", "sold": "3200.00", "commission_base": "3000.00",
    "commission": "135.00",
    "movements": [
      {"kind": "aporte", "amount": "100.00", "occurred_at": "2026-11-01T12:00:00Z"},
      {"kind": "recaudacion", "amount": "150.00", "occurred_at": "2026-11-03T09:15:00Z"},
      {"kind": "gasto", "amount": "12.50", "occurred_at": "2026-11-04T18:40:00Z"}
    ]
  },
  "fund_today": {
    "since": "2026-11-01T12:00:00Z", "opening": "250.00", "purchases": "35.00",
    "effective": "-35.00", "balance": "215.00", "documents": 1, "used_units": 2,
    "scrap_milli": 1500
  }
}
```

`periods` is the selector the screen offers, in its frozen order: every closed
settlement newest first, then the live one when the branch is inside one, then the
whole history. The pending balance is never an entry. `period` is the chosen one and
is always one of the entries of `periods`.

`from` and `to` are the instants the database holds, at the precision it holds them:
the seconds are always stated and the fraction is published whenever the instant has
one (`2026-11-01T12:00:00.123456Z`). They are the window a screen asks the book of the
drawer for, so a bound truncated to the whole second would count the rows recorded in
the last fraction of a second on the wrong side of the window it describes.

`source` says where the numbers came from, and it is the only thing that decides
whether they move:

| `source` | Period | Numbers |
|---|---|---|
| `settlement` | a closed settlement | frozen: read from the closure, never recalculated |
| `live` | the settlement the branch is inside | derived on read, exactly like the branch's own workspace |
| `history` | every sale of the branch | frozen sales, no drawer at all |

Money is canonical two-decimal text (`"25000.00"`) and is validated by the client:
a response that does not close is rejected instead of shown.

### `sales`

`total`, `cash`, `card`, `transfer`, `qr` and `commission` are the money of the
period by source, with the commission beside the drawer and never inside it.
`batteries` is how much of that `total` was sold in batteries: the rest of the
money is the other products of the catalogue, so `total - batteries` is what the
screen shows as its own reading, and an answer whose batteries exceed the total is
refused instead of shown. A settlement derives it from the sales of the same
stretch, which are immutable, so the split exists for a closed period too. For a
settlement they are the ones its closure froze; for the history they are derived
from the sales themselves. `sales` is how many documents the window holds and
`units` how many batteries they took off the shelf — the two numbers no document
holds. The window is half-open, `[period_start, cut_at)`, so a sale made at the cut
belongs to the next period and never to both.

### `cash`

The operational drawer: `opening` plus the cash the period collected plus the signed
effect of the movements the branch wrote in the window is `expected` — the drawer's one
rule, the same one the acta publishes as `expected_cash` and the book as `GET
/api/closings/cash-ledger`'s `expected`, so the card and the document of one period can
never state two numbers. For a settlement the effect is the `cash_effective` the acta
publishes; `expenses` is reported beside the drawer and is never subtracted a second
time. `counted` is what the branch counted and
`difference` is that count against the expectation. Both are **null while nobody
counted**: a difference of zero would be a count that never happened.

### `fund`

The purchase envelope: `opening` (what it inherited from the previous closure),
`purchases` (the cash it spent inside the window), `expected`, and `counted` /
`difference` with the same nulls as the drawer. `replacement` is the amount the
warehouse left in it, which is the opening of the next period; it is null while the
warehouse has not stated it.

### `materials`

The third account of the period: `used_units` of batteries bought by model,
`scrap_milli` and its rows in thousandths of a kilogram, with what the warehouse
took of each (`delivered_milli`). `used_delivered_units` and `scrap_delivered_milli`
are **null as a whole while any line is uncounted**, so a half-counted sheet never
reads as delivered. A period that bought nothing publishes `used_units` 0, a
delivered count of 0 and an empty `materials` list, never a null; the whole history
publishes no material account at all.

### `top_models`

The five models with the most units sold in the period, **ordered by units and not
by money**: the money of each row is the secondary reading. Equal units are broken
by brand, then model, then capacity in byte order, so the same period always
publishes the same ranking. A period that sold nothing publishes an empty list, not
an error and not five zeros.

### `stock`

`units` on the shelf of the branch today, whatever the period: `stock` is a state of
the shelf and not a total of the window, so it is the same number for every period.

### `today`

The drawer of the branch **today**, published by the three sources — `settlement`, `live`
and `history` — and never null. It is the one reading a branch whose settlements are all
closed would otherwise never see: the period in progress only exists while a settlement is
open, and a branch that is not inside one still holds cash in its drawer.

`since` is the cut of the **last closed settlement** of the branch: the instant the
database seeds the next opening from, and the same `closing_cash` the next settlement
inherits as its opening. It is **null** for a branch that never closed a settlement — there
is no cut to start from — and in that case the window is everything the branch ever did and
`opening` is `"0.00"`.

`opening`, `sales`, `expenses` and `effective` are the terms of the drawer's identity, so the
card and the acta of the same drawer cannot state two different numbers:

- `opening` is the `closing_cash` of the last closed settlement, which is what the database
  seeds a new opening with;
- `sales` is the sum of the `cash_amount` of the branch's sales with `created_at >= since`;
  card, transfer and QR never entered the drawer and are not terms of this sum;
- `expenses` is the **net** expense of the window: the signed effect of its `gasto` and
  `correccion` rows, read from `branch_cash_ledger`, so a correction of an expense lowers it;
- `effective` is the signed effect of **every** row of the window: `+` for an `aporte`, `−`
  for a `gasto` or a `recaudacion`, and for a `correccion` the direction it returns.

`expected` is signed and is exactly `opening + sales + effective`, with the same arithmetic
the book of the branch uses (`GET /api/closings/cash-ledger`). Rows with a `closing_id` — the
aporte and the recaudacion a closure writes — are **not** terms of it (S5): those are the
acta's own contribution and collection, and counting them here would state the same money
twice.

`movements` lists the rows of the branch's cash ledger with `occurred_at >= since` — the
kinds `aporte`, `recaudacion`, `gasto` and `correccion` — oldest first, with its `kind`, its
`amount` (always positive, the stored fact), its `effective` (the signed term it contributes)
and the instant it happened as `occurred_at`. The list is bounded to the newest 50 rows, kept
in chronological order, so a long history cannot flood the answer; the expectation is derived
from the ledger and not from the list, so the bound never changes it — `effective` is the
window's own aggregate.

`rate`, `sold`, `commission_base` and `commission` are what the branch is **earning so far**:
the commission rate the warehouse configured for it, the total it sold in the same window, the
batteries of that total — the only base a commission is paid on — and the commission that rate
produces on that base, rounded exactly once. It is the rule the settlement itself applies, so the
card and the acta of a period being lived cannot disagree on the arithmetic.

`sold` is the **total sold**, not the cash: a card sale never enters the drawer, and the whole
sale stays in `sold` while only its battery lines enter `commission_base`, which is why the two
differ as soon as the period sold a product that is not a battery.

`rate` is **null** for a branch the warehouse never configured, and then `commission` is
`"0.00"`: the absence of a rate is a state of its own and never a zero percentage dressed as a
rate. A commission that is not its rate times `sold`, or a commission above zero with no rate
behind it, is a shape this server never wrote and the answer fails closed instead.

The commission is **not money in a box**: it is settled when the settlement is proposed and
until then it is a projection. It is never a term of `expected` and it is not part of
`fund_today` either — nothing in a drawer or in the purchase envelope holds it.

`today` is **not** required to equal `cash.expected` of a live period: the two are separate
statements of the same drawer and a sale landing between them moves one and not the other.
The client validates the identity *inside* `today` and never the equality between the two
reads.

### `fund_today`

The **purchase envelope of the branch today**, published by the three sources — `settlement`, `live`
and `history` — and never null. It is the second money box of the branch, apart from the drawer, and it
is the one reading a branch whose settlements are all closed would otherwise never see: the period in
progress only exists while a settlement is open, and a branch that is not inside one still holds money
in the envelope it buys with.

`since` is the cut of the **last closed settlement** of the branch, the same instant `today` starts
from, and it is **null** for a branch that never closed one — there is no cut to start from, so the
window is everything the branch ever did and `opening` is `"0.00"`.

`balance` is the branch's **book**, and it is the same arithmetic the acta of a settlement and the
tope of a purchase read (S5): `sum(effective)` of `purchase_fund_ledger` over the whole history of the
branch — the view that publishes one signed effect per movement. It is **not** derived as `opening −
purchases`: an `aporte` the warehouse loads, the founding of a branch or a correction also moves the
book, and a branch founded with a purchase fund and no settlement holds that fund, not zero. This is
the one place the card's balance comes from, so a branch the screen shows has a number the purchases
it pays with also honour.

`opening` and `effective` are the **breakdown** the card states, and they add up to `balance` with the
numbers on screen: `balance = opening + effective`.

- `opening` is what the last closed settlement left in the envelope, read by the same helper as its
  acta (the signed sum of the book at its `closed_at` when its closure wrote the movement that
  reconciled it, and the amount it stated otherwise). A branch that never closed a settlement
  inherits nothing, so `opening` is `"0.00"`;
- `effective` is the **signed effect of the movements of the window that belong to no settlement**:
  the `aporte`, `compra`, `correccion` and the backfilled rows with `occurred_at >= since` and no
  `closing_id`. The `reposicion`/`devolucion` a closure writes is left out because it is already
  inside `opening`, exactly as the drawer of today leaves out the transfers of an acta;
- `purchases` is the sum of the `paid_cash` of the branch's purchases with `created_at >= since` — the
  same column and the same window the settlement's own fund sums, with no counter-document filter, so a
  counter-document subtracts by construction and can leave the net itself negative. It is the **cash of
  the window's documents**, the volume they paid, and **not a term of `balance`**: a correction of a
  purchase moves `effective` and the document's net moves `purchases`, and the two need not agree.

A `balance` that `opening + effective` does not produce is a number this server never wrote, and the
answer fails closed. A balance that is zero or below is the end of the branch's buying: the screen says
with words that the branch cannot keep buying until the warehouse refills it.

`documents` is how many purchase documents the window holds — counter-documents included, because they
are documents of the branch — and `used_units` and `scrap_milli` are the batteries and the thousandths
of a kilogram those same documents bought, net of the counter-documents with the same netting the
Compras read applies: the counter-document is stored with a negative quantity and weight.

`fund_today` is **not** required to equal `fund` of a live period: the two are separate reads of the
same envelope and a purchase landing between them moves one and not the other. The client validates the
breakdown *inside* `fund_today` (`opening + effective = balance`) and never the equality between the two
reads.

## What this read does not publish

No profit, no margin, no stock rotation and no customer ranking. There is no
recorded cost of a sale, no movement ledger and no customer register, so those
numbers cannot be stated; the contract publishes what the documents hold.

## Refusals

| Status | Token | When |
|---|---|---|
| `400` | `invalid_request` | the query, the token or the closing id is not one this contract admits |
| `403` | `forbidden` | the identity is not a provisioned branch account of an active branch |
| `405` | `method_not_allowed` | anything but `GET`; `Allow: GET` |
| `503` | `service_unavailable` | the store is unreachable, or a persisted state the answer could not have been produced from fails closed |

Every answer carries `Cache-Control: no-store` and `X-Content-Type-Options:
nosniff`.
