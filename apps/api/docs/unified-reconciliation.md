# Unified reconciliation accounting (planned internal API)

This is **new, unused internal arithmetic**, not a live route or a replacement
for existing transfer contracts. No database, permission or workflow changes
are implemented by this slice. Existing historical evidence remains immutable.

## Calculation for one variant

`CalculateUnifiedAccounting(UnifiedAccountingInput)` accepts nonnegative exact
`int64` values and returns `UnifiedAccounting`, or a zero result with
`ErrInvalidUnifiedAccounting`. There is no float conversion or cross-variant sum.

| Input | Meaning |
|---|---|
| `OriginalDebit` (E) | Original source debit |
| `Dispatch` (D) | Agreed dispatched quantity |
| `Arrival` (A) | Agreed actual arrival |
| `Retained` (R) | Total confirmed physical retention at origin |
| `SourceDebit` | Current net debit from actual source ledger effects |
| `DestinationCredit` | Current net credit from actual destination ledger effects |

Retention must satisfy `R <= max(E-D,0)`. Overdispatch therefore requires R=0.
Zero quantities are valid arithmetic; expected-variant eligibility is external.
Baselines must be nonnegative and representable as int64. The future ledger
reader must validate exact aggregates before narrowing to int64; a wrapped or
fabricated positive value cannot be detected by this calculator. Baselines are
not bounded by the new targets, since previous agreements can have larger effects.

| Output | Formula |
|---|---|
| Target source debit | `max(E,D)-R` |
| Target destination credit | `min(D,A)` |
| Source stock delta | `SourceDebit - target source debit` |
| Destination stock delta | `target destination credit - DestinationCredit` |
| Origin unknown | `max(E-D,0)-R` |
| Transit unknown | `max(D-A,0)` |
| Excess (not credited) | `max(A-D,0)` |

All differences fit int64 after validation; no potentially overflowing sum is
needed. Unknown differences stay separate and do not establish confirmed losses.
Excess does not authorize incorporation of unexpected goods.

## Examples and legacy coexistence

For E=10,D=9,A=8,R=1, targets are source debit9/destination credit8.
With baselines10/8, stock deltas are +1/0 and transit unknown1.
If legacy restitution already restored1, the actual source baseline is9:
stock deltas are 0/0, not another +1. Never substitute effective dispatch for
the source ledger baseline or original receipt credit for corrected destination
credit. Supplying already-applied targets as baselines yields zero deltas.

For E=10,D=12,A=12,R=0 and baselines10/10, deltas are -2/+2.
For D=10, reducing arrival to7 and then0 changes only destination credit;
origin debit does not change. For E=10,D=0, retention10 restores10 from a
source baseline10, while retention0 leaves origin unknown10 and restores nothing.

## Transactional integration still required

Either endpoint may initiate, but origin must explicitly attest positive
retention when proposing or accepting. Arithmetic makes no permission decisions
and proves neither physical facts nor membership in the expected variants.

The future store must derive trustworthy baselines from receipt, legacy and
unified effects; reject stale evidence; fence conflicting legacy writes; validate
stock and reservations; preserve historical reads and exact retries; and accept
one variant's bilateral agreement with all ledger effects atomically, or none.
Zero arithmetic deltas alone do not provide concurrency safety or retry identity.
No transport schema, loss policy, returns or unexpected-variant workflow is
specified here.

## Pure verification

From the repository root, without package DB fixtures or network access:

```sh
GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off go test -timeout=20s apps/api/internal/transfers/unified_reconciliation_accounting.go apps/api/internal/transfers/unified_reconciliation_accounting_test.go
```
