# Drawer never negative

The branch operational drawer ("caja operativa") must never be driven below zero: no movement may
spend money the drawer does not hold. Today nothing stops it — only `amount > 0` is checked.

## Specs

- **S1** — A movement whose signed effect would make the branch drawer's expected cash negative is
  refused. Verbatim user intent: «yo quiero hacer que la caja no pueda quedar en negativo, te estoy
  hablando de la caja operativa, no se puede gastar dinero si no hay!»
- **S2** — The amount available is the drawer's expected cash, exactly as the screen states it:
  what the last closed settlement left (`closing_cash`), plus the cash its sales collected, plus the
  signed effect of the movements of the window. Verbatim: «se usa un fondo operativo que se dejo al
  cerrar la rendiciones y aumenta conforme vendes baterias!» — a sale that is not cash does not feed
  the drawer.
- **S3** — Money coming in is never refused by this rule: an `aporte` is admitted on an empty drawer.
  Verbatim: «si por alguna razon se hacen muchos movimientos en esta caja ... ahi talvez hay
  posibilidades de que la caja quede en negativo?»
- **S4** — The refusal is its own identifiable outcome, carrying the balance and the requested
  amount, and it is definite: the operator's draft is not kept for a retry that cannot succeed.
- **S5** — Every existing behaviour of the drawer is preserved: kind admission, freeze, correction
  caps, settled-window refusals, the sign of the ledger view, and the closing's own shortage rule
  (a counted cash below the expected cash stays a shortage the closing admits).
- **S6** — The settlement's own transfers (`closing_id IS NOT NULL`) are outside this rule: the
  closing states them and its own checks govern them.

## Tasks

| ID | Covers | Route | Commit |
| -- | ------ | ----- | ------ |
| T1 | S1-S6 | RED schema + store tests for the guard | — |
| T2 | S1-S3, S6 | Inline (migration 060: one SQL expression of the expected, trigger guard) | — |
| T3 | S4 | Inline (store typed error + HTTP 409 with balance/requested) | — |
| T4 | S4 | Inline (web: decode, message, no impossible retry) | — |
| T5 | S5 | Inline (docs + help text) | — |
| T6 | S1-S6 | Independent verify (Risk: items 1 and 3) | — |
| T7 | S5 | Reconcile the existing drawer fixtures with the bound (writer) | — |
| T8 | S4-S5 | Close the four defects the independent verifier found (writer) | — |
| T9 | S4-S6 | Focused re-verification of S4 (second verifier) | — |
| T10 | S4-S5 | Commit the verifier's probes as regression tests (writer) | — |

## Evidence

- **T1** — `apps/api/migrations/drawer_never_negative_schema_test.go`: five tests, RED before 060 and
  green after it. `TestDrawerRefusesSpendingMoreThanItHolds`,
  `TestDrawerAdmitsAContributionOnAnEmptyDrawer`, `TestDrawerCountsItsCashSales`,
  `TestDrawerRefusesACorrectionThatWouldSpendWhatItDoesNotHold`, and the shape test.
- **T2** — `apps/api/migrations/060_drawer_never_negative.sql`; the whole migrations package passes
  with the ledger view redefined (`61s`, no regression).
- **T3** — `internal/closings/store.go` (`DrawerInsufficient`, `drawerBalanceOf`) and
  `internal/httpapi/closings.go` (409 `drawer_insufficient` with `balance` and `requested`);
  `TestClosingFailureMapping` pins the body.
- **T4** — `apps/web/src/cashAPI.ts` admits the two quantities only for that code and refuses any
  other shape; `Cash.tsx` states both numbers. `cashAPI.test.ts` and `Cash.test.tsx` green; the whole
  web suite passes (`4482` tests).
- **T5** — `apps/api/docs/closings.md` states the rule, the refusal and the two exclusions.
- **D3** — Decision: the three functions of 060 carry no `REVOKE`. A trigger and the store call them
  as the inserting role, so revoking from PUBLIC turned the refusal into `503 service_unavailable`;
  this vertical revokes only entry points (`create_branch`, `load_branch_funds`).
- **E3** — Evidence: eight existing tests in `internal/closings` and `internal/httpapi` record a
  `gasto` on a drawer that inherited nothing, so the bound refuses them. They test ownership, totals
  and correction classes, not the bound; T7 funds their drawer instead of weakening them.
- **V1** — Verifier verdict: S1, S2, S3, S5, S6 met; **S4 unmet** on two write paths. Defects: (1)
  `event.preventDefault()` deleted from `Cash.tsx` `submitMovement` — fixed inline; (2) `RecordExpense`
  inserts on its own and maps `LC032` through `mapFailure` to `503`; (3) `drawerBalanceOf` fails on an
  already-negative drawer because `ParseAmount` rejects the sign, publishing `400`; (4) the guard's
  `(since IS NULL OR created_at >= since)` stops being an index qual once the plan goes generic.
  Also a duplicated doc line, fixed inline.
- **V2** — Second verifier verdict: all six items **met**, **no defects**. S4 proven on all three write
  routes at the HTTP layer (`expenses`, `cash-movements`, `cash-corrections`), with exact 409 bodies
  and state snapshots; negative pre-rule drawer answers `-50.00` and still admits an `aporte`;
  precedence probed (`LC001` → `LC030` → `LC031` → `LC032`); the guard's read keeps
  `created_at` as an index cond under `force_generic_plan`; the `defaultPrevented` test fails when the
  line is removed (mutation-checked). T10 brings those probes into the repository so the verification
  is reproducible by its own suite.

## Slices

- **S1 (commit `fea4058`)** — the rule and its contract, backend only: migration 060, the migrations
  tests, the plan test, both writers, the published refusal, the funded fixtures, the docs and this
  document. ~1135 authored lines, above the usual review slice on purpose: it cannot be split without
  leaving a red intermediate commit. A migration that bounds the admission turns `internal/closings`
  and `internal/httpapi` red until the store maps `LC032` and the fixtures fund their till, so
  "migration" and "consumer" are one unit here. The two halves were reviewed by two independent
  verifiers instead of by slicing.
- **S2** — the screen: `cashAPI.ts`, `cashAPI.test.ts`, `Cash.tsx`, `Cash.test.tsx`. Green on its own
  because the web suite mocks the transport.

## Log

- **L1** — «bien! me gusta como estamos avanzando. las sucursales tenemos 2 seccions una de compras y
  otra de caja. puedes explorar que hacen actualemnte? quiero hacer cambios aqui»
- **L2** — «y que pasas si no hay dinero en la caja por cualquier motivo, no se puede hacer
  movimientos en caja?»
- **L3** — «seria una buena practica que no deje comprar si no hay saldo en la caja no?»
- **L4** — «a lo que me voy en caja se usa un fondo operativo que se dejo al cerrar la rendiciones y
  aumenta conforme vendes baterias!, pero si por alguna razon se hacen muchos movimientos en esta caja,
  como comporas para la tiendas, gastos operativos, alquiler, etc ahi talvez hay posibilidades de que
  la caja quede en negativo?»
- **L5** — «yo quiero hacer que la caja no pueda quedar en negativo, te estoy hablando de la caja
  operativa, no se puede gastar dinero si no hay!» — authorizes S1 as the whole feature.
- **E1** — Evidence: no never-negative guard exists anywhere for the drawer. `branch_cash_movements`
  only asserts `amount > 0` (`apps/api/migrations/034_branch_closings.sql:131`); the admission returns
  before any balance read for every kind except `correccion`
  (`apps/api/migrations/054_load_branch_funds.sql:239-240`); the store inserts without reading the
  drawer (`apps/api/internal/closings/store.go:692-698`, `735-828`); the UI only refuses `<= 0`
  (`apps/web/src/Cash.tsx:167-173`); the closing never compares counted against expected
  (`apps/api/internal/closings/closing.go:1049-1072`). The fund, by contrast, locks and sums before
  admitting (`apps/api/migrations/048_branch_fund_ledger.sql:245-252`, `LF003`).
- **E2** — Evidence: the drawer's expected is a single stated rule, `DrawerExpected`
  (`apps/api/internal/closings/money.go:191-207`); the vertical's doctrine forbids a second
  arithmetic of the same window, so the guard must reuse that rule, not restate it.
- **D1** — Decision: guard against the full expected (opening + cash sales + signed effect), not the
  ledger alone. Guarding the ledger alone would refuse spending cash sales the drawer really holds,
  contradicting S2.
- **D2** — Decision: the settlement's transfer rows are excluded (S6); the closing keeps its own
  rule, so a physical shortage at a closing is still admitted as a shortage.
