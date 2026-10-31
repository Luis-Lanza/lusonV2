# D6 coordination repair: parent execution pending

S3–S4 test instrumentation only; no production edits or D6 PASS/closure. Original job64 failures are the existing RED evidence, not exhaustive production-order proof. No Go, DB, tests, build, install or cleanup executed by this writer.

## Gate changes

All changed loser matches now observe literal `pg_advisory_xact_lock(714025,1)` at TraceQueryStart, on the operation's actual connection PID, followed by native advisory-wait observation before releasing the winner.

| Cases | Previous loser match |
| --- | --- |
| Approval creation-before-approval and approval-before-creation | `ORDER BY b.variant_id FOR UPDATE OF b`; wait event transactionid becomes advisory |
| All eight correction workflow cases | `FROM transfer_count_correct` |
| Correction waiting cancellation only | `FROM transfer_count_correct`; after_effect retains entrypoint-end gate |
| Correction reservation_first correction loser | `FROM transfer_count_correct`; approval winner remains allocation-end |
| Direct duplicate_key and changed_key_payload | `SELECT pg_advisory_xact_lock($1)`; other three modes already early-global |
| All six restitution decisions and both count/restitution orders | `FROM transfer_restitute` or `FROM transfer_count_correct` |

correction_first retains correction entrypoint-end winner and the already-global approval loser. Every winner after-effect gate is unchanged. All assertions, subcases, deadlines and timeouts remain: identity/replay/conflicts, zero outcomes, stock/reservations/conservation, original evidence, revisions, MVCC, cancellation/rollback, waiter release and subsequent same-key success. The obsolete creation-lock comment now describes the common fence.

Inspected all nine concurrency siblings plus rejection_test.go, approval_test.go and direct_shipment_test.go negative stock probes. The shared literal SQL matcher, phase/context propagation, deadlines and PID handshakes are unchanged. Existing early-global lifecycle siblings and intentionally row-only header/balance blockers remain compatible and untouched. Restitution exact tag/database/granted-holder/ungranted-waiter/blocker-edge checks remain intact. Dispatch reconciliation uses direct SQL transactions and exact native global blocker checks, not beginPersonal tracer gates; no edit needed, including reservation mode. Its three top-level tests are nevertheless selected. No later restitution/reconciliation runtime result is claimed.

## Parent quick path (one attempt only)

1. Use a fresh system-temp directory under `/tmp/luson-account-administration-82bce681/`, with `candidate` and `freshreceipts`. Archive fresh HEAD (expected `0bbb729adf40db7270475999336a09af201db92d`), overlay only the four changed concurrency files and the existing 353-line `internal/httpapi/admin_retirement_integration_test.go` from original job64 candidate. Do not overlay production files or unrelated dirty files.
2. Mirror existing integration preparation: bind all candidate API source plus exact overlay/runner hashes in fresh receipts (`source.sha256` relative to candidate); retain HEAD identity and runner hash separately. Use only the existing healthy owned manifest/helper fresh databases; never read password files or connect to administrative/preview databases.
3. Parent launches `bash odd/verification/admin-soft-delete/d6-coordination-runner.sh "$candidate" "$receipts"` in its background facility. Writer did not launch it. Runner contains the exact anchored focus selecting every top-level test from all five inspected families, unchanged subcases included, plus the three public D6 HTTP tests, in ONE two-package command.
4. Only if focus exits zero, runner executes exactly `go test -p 1 ./internal/httpapi ./internal/transfers -count=1` once. Default Go 10m per package and all local budgets unchanged; no timeout flag/suppression. Stop first failure, no retries/recovery/cleanup. Reserved empty suite.exit means NOT RUN, not PASS.

Runner mirrors existing shell path guards, offline/local Go, ambient PG unsets, known manifest, source verification and fresh noclobber stdout/stderr/exit receipts. Original frozen source and receipts remain untouched. Differential/browser/SSE/independent proof and D7 remain parent-owned outstanding work.
