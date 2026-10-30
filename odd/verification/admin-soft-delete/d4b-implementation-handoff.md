# D4B implementation: parent GREEN pending

Implements S2 operational visibility/admission and preserves S3/S4 retained evidence and business boundaries. This is L32–L34 only, based on HEAD `4cbe8f2`; not full D4/D5/D6 completion or runtime approval.

## Exact source overlay

Overlay these seven files into a fresh base candidate:

- `apps/api/internal/inventory/inventory.go`: metadata filters `deleted_at IS NULL`; List reads retirement in its existing location snapshot, returns specific `ErrRetiredLocation` after existing query/brand validation. Unknown/missing targets retain ErrInvalid.
- `apps/api/internal/httpapi/inventory.go`: only that sentinel maps to existing 404/not_found JSON. Existing unknown/invalid 400/invalid_request and unavailable mapping remain.
- `apps/api/internal/transfers/store.go`: only fresh header INSERT failure classifies the retirement rejection, after stored creation replay resolution.
- `apps/api/internal/transfers/correction.go`: shared `activeLocationRequired` exact classifier and countError call after context precedence.
- `apps/api/internal/transfers/restitution.go`: existing restitutionError calls classifier after context precedence.
- `apps/api/internal/transfers/dispatch_reconciliation_store.go`: existing reconciliation error handler likewise.
- `apps/api/internal/httpapi/retired_branch_operations_test.go`: all supplied assertions remain meaningful (source was161 lines, now166, despite handoff's178-line estimate); adds one five-line public preservation control covering unknown inventory ID32767 and invalid page0. Exact 400/invalid_request derived from inventoryFailure/inventoryQuery/List, not guessed.

Three updated existing docs: `apps/api/docs/administration.md`, `apps/api/docs/administrative-retirement.md`, `apps/api/docs/dynamic-branches.md`. Two new technical artifacts: this handoff and `odd/verification/admin-soft-delete/d4b-green-runner.sh`.

## Error and replay boundary

Classifier requires all three: SQLSTATE23514, ConstraintName active_location_required, Message `New work requires active locations`. Existing ErrDecisionConflict crosses existing transferFailure as 409 `{"error":"decision_conflict"}`. No generic23514 promotion, driver disclosure, policy query or SQL edit. Other SQL mappings remain unchanged. Context cancellation/deadline takes precedence in all four handlers.

Migration017 remains authoritative at fresh INSERT. Existing SQL stored-operation lookup precedes insertion; Go creation stored replay branch likewise precedes insertion. No new active lookup or guard call precedes either. No assignment changes, historical join filters, bootstrap/broker matrix filters, DTO fields or identity reuse. Dynamic stored replay/concurrent winners are source-preserved, not proven by this worker.

## Parent execution

Do not reuse RED candidate/receipts. Parent constructs a fresh base+seven-source overlay candidate under `/tmp/luson-account-administration-82bce681/*/candidate`, binds exact source hashes and creates a fresh sibling `freshreceipts` directory. Execute runner once through parent background facility:

`bash odd/verification/admin-soft-delete/d4b-green-runner.sh <candidate> <freshreceipts>`

Runner uses existing manifest pointer, local offline Go and existing caches; no retry/repair. It reserves all stdout/stderr/exit files with noclobber before first execution, stops on first failure, runs focused three TestRetiredBranch cases+TestT5NewBranch then only `^(TestT5|TestAccountRetirement|TestBranchRetirement)` serially. Empty legacy exit means NOT RUN. Helper owns random test databases: never use original pgx ConnString after Database mutation or connect directly to adminDB. Worker did not run runner or any runtime test.

## Evidence and outstanding preservation

Parent supplied observed RED job59 EXIT1/9s, Go5.796s, empty stderr: retired metadata4 still visible, direct inventory200 vs404, fresh create and three received proposals503 vs409. Fixtures, public post-rejection invariance/history and creation control reached successfully. Immutable receipts `/tmp/luson-account-administration-82bce681/d4b-red-iJE5MEPx/receipts` untouched.

Existing controls already exercised by RED fixtures: active metadata/inventory pages, fresh direct create/dispatch/receive, personal actor snapshots, retained history/detail, rejected-write public snapshot equality, TestT5NewBranch. Added public inventory400 preservation awaits parent GREEN. No runtime PASS claimed.

Shared-helper impact is not zero: the classifier is new, but countError is shared by ProposeCount/DecideCount; restitutionError by ProposeRestitution/DecideRestitution; dispatchReconciliationError by ProposeDispatchReconciliation/DecideDispatchReconciliation; Create covers all three creation kinds. Fresh proposals/direct creation are requested changes; decision siblings and other creation kinds share changed handling. Only exact retirement rejection should differ. D6 needs ONE differential script comparing previous/candidate public stdout, stderr and exit for unrequested decision siblings (accept/reject across three workflows) with changed retired-participant input and other creation kinds, using fresh helper-owned fixtures. Worker is forbidden runtime probes and out-of-scope scratch writes, so did not execute this script. Do not claim differential complete.

Useful existing focused Store preservation tests (not added to the authorized two-command runner): TestC2CorrectionStoreReplacementRejection, TestC2CorrectionStoreOperationalFailures, TestR3RestitutionStoreRejectionAndConflicts, TestR3RestitutionError, TestDR2StoreMutationGuards, TestDR2StoreMutationErrorRedaction. Exact classifier mismatch permutations/context precedence also await D6 targeted proof; no new package-test surface was authorized.

Live SSE, persisted marker/version, all-counter atomicity, recorded retry execution, concurrent winners and integrated dynamic branch proof remain D6. User/branch HTTP exists; source deletion UI remains pending. Native assessment/security2/4 and one independent verification remain parent-owned, with no approval inferred.

## KeyLearnings

Retired inventory requires its own sentinel because unknown IDs intentionally return400. Keeping brand validation before the sentinel preserves invalid-query semantics even on retired IDs. Specific INSERT rejection translation fixes admission transport without adding policy before recorded replay.

## Static validation

Diff counts: nine tracked paths45 additions/7 deletions; untracked test166 lines (161 supplied +5), runner30, handoff51:299 total changed/authored lines including supplied tests and artifacts, below550. Worker ran scoped gofmt, bash -n runner and git diff --check successfully. No Go/DB/HTTP/browser/docker/npm/build/native checks executed. No staging, commits, cleanup or private data access. Existing dirty/untracked resources preserved. Automatic status-output spill `/tmp/gpj9v8pJ/gaa1XBg4/pi-bash-377fbc2ed1e96781.log` left untouched; host generation does not authorize cleanup.
