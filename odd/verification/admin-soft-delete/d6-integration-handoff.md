# D6 public HTTP integration preparation

Prepared only; **no Go, database, fixture or runtime checks executed**. This is D6 evidence preparation for S2–S4, not D6 closure or a production change. The Go file is approximately 355 formatted lines; no framework or full-server fixture added.

## Tests and expected outcomes (unexecuted)

| Exact test | Fixture and expected public result |
|---|---|
| `TestD6RetirementRecordedReplay` | T5 fresh helper-owned DB; public branch4, reassign account2, HTTP login, direct shipment1, dispatch, receive expected variant1 actual0 and unexpected variant2 actual1. Destination stays zero on all four inventory pages. Warehouse count proposal1/revision0; real destination operator rejects at revision1. Delete account2, retire branch4. Creation replay200 returns current full request; count replay200 returns original immutable operation. Detail/activity/workflows/list/counters/surviving inventory remain unchanged by replays. Historical personal actor2 and branch4 name remain in detail. |
| `TestD6RetirementFailureAtomicity` | T5 fresh DB; fixture DDL installs narrowly targeted `BEFORE UPDATE OF revoked_at` trigger on `auth_sessions`, only account2's null→nonnull revocation. Public DELETE account2 must return exact cookie-neutral503 `service_unavailable`. Public directories/counts/list/inventory unchanged; old CURRENT target session and operational inventory remain valid, admin/operator3 unaffected. No fresh login under hook; helper owns whole-DB teardown. |
| `TestD6RetirementOverlappedWinners` | Four subcases: `received_false/retire_first_true`, `received_false/retire_first_false`, `received_true/retire_first_true`, `received_true/retire_first_false`. Creation uses empty branch4 without assigned users, warehouse stock18. Proposal uses zero-credit received fixture then deletes account2, warehouse stock17. |

Both race inputs start eligible with zero branch stock, no assigned nondeleted users and no pending work. Both requests must be observed waiting simultaneously before releasing the fence:

- Retirement first: DELETE204; fresh creation/proposal409 `decision_conflict`; no new list/detail/workflow/activity/counter/inventory evidence; branch omitted, direct inventory404.
- Write first: creation201 approved/reservation1 or proposal200 revision1/pending/credit0; retirement409 `branch_has_pending_operations`. Branch stays visible, warehouse stock/reservation, history membership and warehouse action counters checked. Creation has dispatch action1; warehouse-origin proposal has warehouse action0 (counterparty review belongs to retired account's branch, not warehouse).

## Existing contracts reused

- `administration_test.go`: `t5Setup`, composed HTTP router, `request`, `snapshot`, `oldInventory`, exact cookie-neutral responses and `TestT5ConcurrentLifecycle` goroutine result collection. `testpg.Open` alone creates/adopts/destroys random owned databases (pool max4); no connection strings reconstructed or printed.
- `account_retirement_test.go`: `retirementLogin` and survivor checks. Two warehouse HTTP logins both present the already-revoked original token; neither presents the other new token. Both new sessions are publicly checked live before starting requests.
- `retired_branch_operations_test.go`: public zero-credit received fixture and all-page empty destination assertion. `dynamic_branch_integration_test.go`: public transfer decoding, stock and current identity helpers.
- `transfers/store.go` + `dynamic_branch_integration_test.go`: creation replay loads **current request**, including later activity; not the original creation response. `transfer_count_corrections.go` + `TestC3CountWorkflowHTTP`: operation replay returns persisted original ten-field operation, byte-identical after later rejection, not current workflow head.
- `auth/credential_reset.go`: actual primitive is `UPDATE auth_sessions SET revoked_at=$2 WHERE account_id=$1 AND revoked_at IS NULL`. `RetireOperator` updates disabled/marker/version first, then invokes this primitive in the same transaction. Trigger SQL is fault instrumentation, not business fixture rows or private-state assertions.

## Native lock coordination

`d6Overlap` holds transaction-scoped pair-key advisory `(714025,1)` on an acquired fixture-pool connection. That same connection queries `pg_locks`, filtered by current database OID, advisory type, classid714025, objid1, **objsubid2** (two-int key) and `NOT granted`. Queue winner first, require exactly one waiter; queue loser, require exactly two; then rollback held transaction. This is system-view instrumentation, not stored application-state inspection.

Two buffered result channels, main-test-only assertions, cancellation, rollback and goroutine joining cover normal/failure paths. Each waiter phase has a 2s deadline/5ms ticker, shared request context8s; no tool-side polling or sleep. These are new test bounds, not increases to any existing runner/package timeout.

Read-only lock-order review: `auth/administration.go` orders account→admin session→global; `transfers/personal_activity.go` starts mutators at global before retry/header/stock locks. `Current` writes only each request's own session row; distinct live sessions avoid false session-row serialization. `checkAssignment`/activity account reads are MVCC, not account tuple locks under global. Migration017 blockers include latest undecided received proposals. Native wait observations are asserted by the test, **not yet dynamically observed**.

## Parent-only execution

Run serially after any other fixture workload ends, using the existing admitted healthy helper. Do not run against preview, an admin DSN or private manual data. Parent prepares a fresh canonical HEAD archive plus only this test overlay and binds all Go/SQL/module source. Example exact preparation/execution sequence for the parent (not executed by worker):

```bash
repo=/home/luis/velay/luson_v2
cd "$repo"
test "$(git rev-parse HEAD)" = 0bbb729adf40db7270475999336a09af201db92d
root=$(mktemp -d /tmp/luson-account-administration-82bce681/d6-integration-XXXXXXXX)
mkdir "$root/candidate" "$root/freshreceipts"
git archive HEAD | tar -x -C "$root/candidate"
cp apps/api/internal/httpapi/admin_retirement_integration_test.go "$root/candidate/apps/api/internal/httpapi/"
(cd "$root/candidate" && find apps/api -type f \( -name '*.go' -o -name '*.sql' -o -name go.mod -o -name go.sum \) -print0 | sort -z | xargs -0 sha256sum) > "$root/freshreceipts/source.sha256"
sha256sum odd/verification/admin-soft-delete/d6-integration-runner.sh > "$root/freshreceipts/runner.sha256"
bash odd/verification/admin-soft-delete/d6-integration-runner.sh "$root/candidate" "$root/freshreceipts"
```

Runner uses offline/local Go and the existing manifest pointer only. It checks source binding, reserves new stdout/stderr/exit receipts without clobber, then runs exactly:

1. `go test -p 1 ./internal/httpapi -run '^(TestD6RetirementRecordedReplay|TestD6RetirementFailureAtomicity|TestD6RetirementOverlappedWinners)$' -count=1`
2. Only if focused succeeds: `go test -p 1 ./internal/httpapi ./internal/transfers -count=1`

Original stdout/stderr/exit are preserved. Empty reserved exit means NOT RUN. Stop first failure, no retries, timeout increases, installs, environment repair or broad cleanup. Default Go per-package timeout is unchanged; previous full serialized workload was approximately619s plus new cases. Parent must retain source binding and receipts and inspect both package outcomes.

## Key Learnings

- Durable creation replay and durable count-operation replay intentionally have different response semantics; current-request equality must not be substituted for original-operation equality.
- Failure atomicity is demonstrated through surviving old authority and public unchanged state, not raw private version/marker queries.
- Exact marker/version-write properties remain **source/schema evidence**: `RetireOperator` increments once only on active target; archived repeat commits without UPDATE; migration017 freezes retired account markers and branch identity; `RetireBranch` avoids repeat UPDATE. No dynamic private-counter claim is made.
- D6 differential tooling, real SSE cutoff (T5 lacks routes), browser proof and remaining source/counter closure are separate pending work. This preparation does not discharge them.
