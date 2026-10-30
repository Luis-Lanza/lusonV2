# D4 slice A implementation handoff

Base: 6051893. Scope: L27–L28; S1 branch admin API, S2 admin-directory omission/history retention, S3 existing blocker consumption, S4 authority/guards/protected warehouse. Slice B operational metadata/inventory/Store and D5 UI/D6 independent/concurrency closure remain pending. No runtime GREEN is claimed.

## Exact sources and size

- `apps/api/internal/auth/administration.go`: +57/-1; adds `RetireBranch`, three blocker errors, filters only `ListBranches`.
- `apps/api/internal/httpapi/administration.go`: +22; DELETE resource dispatch and exact blocker HTTP mapping.
- `apps/api/internal/httpapi/branch_retirement_test.go`: existing 194-line RED preparation, unchanged.
- `apps/api/docs/administration.md`: +9/-2; endpoint, errors, visibility and remaining scope.
- `apps/api/docs/administrative-retirement.md`: +11/-3; fence/fresh-snapshot explanation.
- `odd/verification/admin-soft-delete/d4a-green-runner.sh`: 29 lines; parent-only serial focused/targeted runner.
- This handoff: 31 lines. 353 authored added lines including existing tests; no large-write expansion.

## Source proof and authority order

HTTP first uses the existing Administrator gate before path/method/body work. Branch IDs reuse unchanged canonical `administrationID`, reject >32767 before conversion/query, and service validates again. DELETE uses existing mutation guards, never decodes a body or changes cookies. Warehouse 1 is forbidden, unknown IDs not_found, repeat archived IDs 204. Other methods advertise DELETE. Account dispatch/core are unchanged.

`RetireBranch` takes `administrationTx(token,0)` (ordered admin account then admin session), explicitly takes transaction advisory `(714025,1)`, THEN reads marker. It acquires no account locks under global. With the existing READ COMMITTED transaction default, separate post-wait statements see the committed winning transaction rather than the fence statement's old snapshot. It calls the existing VOLATILE `branch_retirement_blocker($1::smallint)`; there is no Go copy of the SQL pending predicate. `stock/users/operations` map to 409 `branch_has_stock/branch_has_users/branch_has_pending_operations`. Marker UPDATE also retains migration017's authoritative trigger check. No physical deletion, allocation change, migration edit, retained matrix/audience filtering or history rewrite.

Tests retain public stock/user/pending fixtures and strict rejection/no-change assertions. PendingHistory captures settled detail and rejected-history response bodies BEFORE retirement and compares exact bodies AFTER, including retained personal actor and branch name. TestT5NewBranch remains the creation preservation control. No generic parser semantics changed; no sibling differential required.

## Commands and remaining limits

Parent job57 RED supplied by parent: EXIT1, Go6.900s, five branch tests missing-route failures; creation/authority controls not failed; stderr empty. Immutable receipts remain under `/tmp/luson-account-administration-82bce681/d4a-red-ONeuQJhj/receipts`.

Worker ran only gofmt on the two changed Go sources, `bash -n odd/verification/admin-soft-delete/d4a-green-runner.sh`, and `git diff --check`: all exited 0. No Go/DB/HTTP/browser/build/native assessment executed. Parent must bind fresh HEAD+exact overlay hashes, then execute runner once with fresh external receipts: focused six tests first, conditional `^(TestT5|TestAccountRetirement)` regression next; stop first failure. Empty legacy receipts mean NOT RUN. Existing admitted manifest/helper only; no direct DSN/database inspection. Native item4 and independent review remain parent-owned.

## KeyLearnings

The idempotent marker read itself must follow the explicit common fence, not merely rely on the UPDATE statement trigger: otherwise a stale pre-wait active marker can attempt an illegal second UPDATE. Keeping both marker and SQL blocker reads in separate post-fence statements preserves fresh READ COMMITTED visibility while reusing migration017's complete received-work predicate. No scratch/cache was created by this worker; tool-host output spill and all unrelated dirty/untracked evidence remain untouched.
