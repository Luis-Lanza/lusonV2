# D2 foundation handoff — verification pending

Implemented S2–S4 integrity foundation only. D3 owns deleted-user login/session
revocation and HTTP mutation authority; D4 owns operational filtering, HTTP business
error mapping and broader concurrency tests; D5 owns UI. No HTTP/UI completion claim.

## Changed paths and workload

| Path | Lines | Change |
|---|---:|---|
| `apps/api/migrations/017_admin_soft_delete.sql` | 134 new | Markers, blockers, admission and shared fence |
| `apps/api/migrations/admin_soft_delete_test.go` | 180 total | Preserve parent's four RED tests; add archived admissions and received-shortfall case |
| `apps/api/internal/transfers/personal_activity.go` | 69 total | Five added/removed comment/query lines; early common fence |
| `apps/api/docs/administrative-retirement.md` | 45 new | Foundation boundary and next-unit contracts |
| `odd/verification/admin-soft-delete/d2-green-runner.sh` | 23 new | Parent-only serial verification |
| `odd/verification/admin-soft-delete/d2-implementation-handoff.md` | this file | Evidence and continuation |

Approximately 440 authored lines including the parent's tests and this handoff;
no historical migration edits. Unrelated dirty/untracked files remain untouched.

## SQL contract

New functions: `branch_retirement_blocker(branch_id smallint) RETURNS text`,
`guard_account_retirement() RETURNS trigger`,
`admit_active_transfer_participants() RETURNS trigger`,
`guard_retired_inventory() RETURNS trigger`.
Replaced existing `guard_location_identity() RETURNS trigger` in migration 017 only.

`branch_retirement_blocker` returns stock/users/operations/NULL, checking either
endpoint and latest-undecided proposals across all three received workflows.
It deliberately does not clone actor-relative action projections. Authoritative
callers hold global `(714025,1)` at READ COMMITTED; marker UPDATE enforces this.
New SQLSTATE 23514 constraints: `auth_accounts_retirement_check`,
`locations_retirement_check`, `branch_retirement_blocked`,
`locations_identity_immutable`, `account_retirement_immutable`,
`active_location_required`. See the foundation documentation for exact semantics.

## Evidence and parent commands

Parent-observed RED remains immutable in `d2-red.*`: four tests reached SQL42703
missing deleted_at after successful bootstrap. Worker did not run Go, DB or builds,
as expressly instructed. Added regressions therefore have no newly observed RED/GREEN.
No PASS is claimed. Static gofmt, bash syntax and git diff whitespace checks succeeded.

Run the prepared runner through the parent's background facility against its isolated
candidate, with existing admitted external HOME/TMPDIR/Go cache environment and a
fresh external receipt directory. Do not point any cache into the repository.
Runner executes these exact commands from candidate `apps/api`, sequentially:

```sh
go test -p 1 ./migrations -run 'TestAdministrativeRetirement|TestDynamicBranchAudiences' -count=1
go test -p 1 ./migrations -count=1
```

The first includes all four original tests, the new received-admission regression
and the existing audience/lifecycle preservation control. Runner exports the existing
admitted manifest locator, disables dependency fetching, preserves separate original
stdout/stderr/exit in external receipts and stops at first failure. Parent owns evidence
import, source/candidate binding, independent review and any further seam verification.
Do not auto-retry, raise timeouts or repair admission/cache/environment after failure.

## Key Learnings

- The existing balance constraints permit reserved stock without allocations: 001
  requires 0 <= reserved <= existing; 009's final ownership check is a lower bound,
  not ledger equality. The original existing=1/reserved=1 fixture is valid unchanged.
- Separate alphabetically earlier BEFORE-row admission preserves the operation-owned
  trigger nesting depth, avoiding copies of the large 013 workflow functions. All
  operation statement triggers already fence before FK/header locks. Durable replay
  returns before operation INSERT, so it bypasses only freshness, not stored identity.
- The received-shortfall fixture uses positive unexpected units with zero inventory
  credit: receipt payload requires some positive actual, but no expected units need
  be credited. Retirement can then win legitimately; active warehouse fresh received
  operations must reject without operation/header/balance/revision changes.
- Assignment writes fence before tuple/FK locking, but transfer account reads remain
  MVCC. Future admin code must retain ordered account/session then global order.

## Remaining evidence gaps

Dynamic SQL syntax/behavior, full migration suite, exact business error mapping,
recorded replay after retirement and both concurrency winners require parent proof.
Added SQL regressions currently assert rejection/state stability, not exact PgError
constraint identity. No differential scratch or tool cache was created by the worker.
Memory persistence was not attempted: parent did not supply a validated project name
as required by this worker's memory-safety contract.
