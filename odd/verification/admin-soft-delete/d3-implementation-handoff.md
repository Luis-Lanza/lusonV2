# D3 implementation handoff

## Scope and evidence

Implements D3 portions of S1/S2/S4 only: personal-user retirement service/HTTP, hidden account directory, archived-target mutation guards and existing authority integration. Branch API/filtering/metadata, UI confirmation/delivery and live concurrency/SSE proof remain D4–D6. No feature-document, private CLI, shared credential core or lifecycle source edits.

Parent job55 supplied valid behavioral RED: EXIT1, Go3.888s, DELETE405 instead of204 and guard405 instead of403; preservation control did not fail, stderr empty. Immutable receipts remain `/tmp/luson-account-administration-82bce681/d3-red-O4NEOt40/receipts`. Worker ran no Go, DB, build or runtime commands; GREEN is **pending**, not PASS.

## Implementation facts

- `RetireOperator` reuses `Administrator`, `administrationTx` and `retireAccountSessions`. Existing transaction locks account1/target in numeric order, then validates/locks admin session. Account UPDATE's migration017 statement trigger acquires global `(714025,1)` only afterward; no new account lock under global.
- Under the locked account, archived DELETE commits without UPDATE or session retirement. Unknown target is `ErrAdminNotFound`; account1 is existing `ErrAdminForbidden`. First retirement sets enabled=false, deleted_at=CURRENT_TIMESTAMP (PostgreSQL stable transaction timestamp), authority_version=authority_version+1 and revokes all live target sessions in the same transaction. Any failure rolls back both. This is source proof, not dynamic atomicity/version proof.
- Directory query adds only `deleted_at IS NULL`, retaining exact DTO/order. Disabled nondeleted users remain visible/reactivatable. No row deletion or allocation/uniqueness changes.
- PATCH reads only active targets, mapping no row to404 before writes. Reset checks locked deleted state before bounded hashing and reuses unchanged `resetAccountCredential`. Hashing now occurs while holding admin/target locks, intentionally allowing an authoritative pre-hash archived check; no new hashing framework.
- DELETE adds no body/media requirement and never reads body. Existing auth precedes method/body; canonical ID/query/escaped-path/route checks precede dispatch; Origin/Fetch-Site/CSRF reuse `GuardMutation`. Empty204 is cookie-neutral. Password subroute still only POST; account resource unsupported methods advertise `PATCH, DELETE`.
- Legacy `TestT5ProtectedAndStrictPayloads` changes only unsupported DELETE to PUT, retaining exact405/no-mutation matrix. Existing three retirement tests (193 lines) are unchanged. Existing directory/profile/reset/lifecycle tests preserve touched behavior; no unrelated test expansion.

## Authority source proof and limits

`auth/service.go` Login initial query filters enabled and its locked recheck rejects disabled or changed version/hash. Current requires enabled plus matching version; Peek requires enabled/version, unrevoked and unexpired session. Migration017 CHECK requires deleted⇒disabled and protects account1. `httpapi/events.go` eventSession calls Peek on admission, preflush and every event/one-second heartbeat; invalid authority ends stream. Thus no broader lifecycle edits were needed. Concurrent winners, exact stored version once, persisted markers, atomicity under failure and live SSE cutoff remain dynamic D6 proof, not assertions established by public snapshot tests.

## Parent execution

Prepare a fresh isolated candidate under `/tmp/luson-account-administration-82bce681/*/candidate` from HEAD plus the exact D3 production/test overlay; bind source hashes. Provide a fresh existing receipts directory under the same authorized root. Do not reuse RED receipts. Then execute once through the parent facility:

```sh
bash odd/verification/admin-soft-delete/d3-green-runner.sh "$candidate" "$receipts"
```

Runner executes serially from candidate apps/api, stopping on failure:

```sh
go test -p 1 ./internal/httpapi -run '^(TestAccountRetirement(Success|ArchivedTarget|Guards)|TestT5MutationGuards)$' -count=1
go test -p 1 ./internal/httpapi -run '^TestT5' -count=1
```

First selects three requested public retirement tests plus preservation control. Second selects 12 existing top-level T5 tests (including login/reset race, lifecycle/concurrent lifecycle, strict payloads, new branch and mutation guards), not the full httpapi suite. Job55's focused fixture work took3.888s; no new legacy timing was measured or guaranteed. Both command stdout/stderr/exit receipts are reserved with noclobber before execution. Unexecuted legacy receipts remain empty if focused fails. No retry or limit change.

Runner pins offline/local Go and admitted manifest pointer, clears direct DB overrides and relies only on existing t5Setup→testpg.Open random isolated database admission. It never reads/copies private DSNs or uses original pgx ConnString after database mutation. No worker scratch/caches created intentionally. Native assessment/security escalation/independent disposition remain parent-owned.

## Static verification

- `gofmt -w apps/api/internal/auth/administration.go apps/api/internal/httpapi/administration.go apps/api/internal/httpapi/administration_test.go`: completed.
- `bash -n odd/verification/admin-soft-delete/d3-green-runner.sh`: exit0.
- `git diff --check`: exit0.
- No runtime GREEN or differential executed: worker runtime explicitly prohibited. Shared generic parsers/helpers and unrelated commands remain unchanged; account-resource Allow changes are intentional. Broader differential/concurrency work remains parent/D6-owned.

## Key Learnings

- Existing enabled predicates plus migration017 deleted⇒disabled provide retirement authority enforcement without widening shared lifecycle scope.
- The existing account1/target→admin-session transaction is the required entry to the SQL statement-trigger fence; reuse rather than lock accounts under global.
- Password-reset pre-hash archived rejection requires checking the locked target before hashing, while preserving the neutral reset core for private recovery.
- Public idempotence snapshots cannot establish exact persisted version or atomic failure behavior; retain those proof limits explicitly.

No persistent memory written: no validated project name was supplied to this worker; parent may persist these verified conclusions under its validated project.
