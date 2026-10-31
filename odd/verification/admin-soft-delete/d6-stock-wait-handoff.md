# D6 stock-wait coordination: parent execution pending

S3–S4 instrumentation only, NOT D6 PASS. No production changes or runtime execution by this writer. Existing job67 failure (L67) is RED; no new RED run authorized.

## Source gate and exact repair

Migration005 `lock_transfer_balances` is BEFORE UPDATE/DELETE FOR EACH STATEMENT and takes global advisory714025,1. `beginPersonal` takes that same fence before Create reaches its stock query. The stock-mutator UPDATE therefore blocks Create at the early fence, making the previous downstream stock-query observation unreachable.

Only `testLockedStock` changes: discard unused fixture Store; create a connection-local tracer via existing `a02Gated(...,"pg_advisory_xact_lock(714025,1)",false)`; run Create through that Store; observe its PID using `a02Arrived`, then native `a01Wait(...,"advisory")`, before committing the stock mutation. One `context.WithTimeout(ctx,3*time.Second)` encloses BOTH observations; the helper's five-second child cannot extend this parent deadline. Fixture/Create contexts and all functional assertions remain unchanged. Fatal wording now describes revalidation after fence release.

`waitStockLock` and `testCanceledStock` are untouched: the latter uses a row-only SELECT FOR UPDATE blocker, not the statement-level global fence. No shared helper, production, SQL, timeout increase, sleeps, skips or new abstraction.

## Parent preparation and single attempt

1. Fresh scratch ONLY under `/tmp/luson-account-administration-82bce681/`, with `candidate` and `freshreceipts`. Archive pinned HEAD `0bbb729adf40db7270475999336a09af201db92d` (verify identity). Overlay frozen job67 approval/correction/direct-shipment/restitution concurrency test files and original 353-line HTTP integration test from `/tmp/luson-account-administration-82bce681/d6-authorized-cleanup-UxTNdeyg/candidate/apps/api`. Overlay ONLY the newly repaired workspace `internal/transfers/store_test.go` after these frozen tests. Never copy the consumed maintenance collector/test or execute maintenance.
2. Bind ALL candidate API source with `source.sha256` relative to candidate, plus separately retained exact overlay/runner hashes and base identity, as in existing coordination preparation. Verify production matches frozen API-tested job67 candidate; only store_test.go is newly different. Do not overlay other workspace files. Preserve previous receipts. Use admitted manifest/helper-owned random databases only; no private credential reads, raw DSN or administrative bypass.
3. Parent launches `bash odd/verification/admin-soft-delete/d6-stock-wait-runner.sh "$candidate" "$receipts"`. Runner verifies source hashes, guards scratch paths, uses offline/local Go and admitted manifest, unsets ambient PG variables and reserves original stdout/stderr/exit with noclobber.
4. Exactly `go test -p 1 ./internal/transfers -run '^TestR01PendingStore$/^locked_stock_revalidation$' -count=1` once. ONLY on success, exactly `go test -p 1 ./internal/transfers -count=1` once, serially. Default 10m/package and all existing local budgets unchanged. Stop first failure; no retry/environment repair/cleanup/HTTP execution. Empty suite.exit means NOT RUN.

Full HTTP job67 PASS318.480s remains retained evidence for unchanged production, not rerun here. OID2924737 deletion grant was consumed successfully; no new deletion grant. D6 differential/browser/SSE/final independent proof and D7 remain pending and parent-owned.

## Key Learnings

A statement-trigger stock writer owns the common fence before row locks; its competing Create must be observed at the actual early advisory wait. Row-only cancellation blockers still require their original downstream stock wait. Share the original three-second observation budget across tracer arrival and native wait rather than accumulating helper defaults.
