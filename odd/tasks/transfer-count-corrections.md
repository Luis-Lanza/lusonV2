# Transfer count corrections

## Objective
Resolve post-receipt counting errors inside Transfer detail through joint physical-origin/destination confirmation, retaining immutable original receipt evidence.

## Accepted scope and constraints
- User authorized beginning implementation after commit check. Baseline: feature/transfer-dispatch-receipt, 8968146.
- Any received line is eligible, including originally matching lines; original exception existence is not a prerequisite.
- Expected-line credit remains min(corrected actual, dispatched quantity). Surplus incorporation is separate.
- Apply inventory deltas against latest effective credited quantity, never repeatedly against original receipt quantities.
- Never automatically restore origin stock for destination count corrections.
- Preserve immutable receipt and received header; use linked correction evidence.
- Joint physical endpoint agreement, revision-bound confirmation, exactly-once atomic application, auditable history and explicit recovery are required.
- Preserve nonnegative inventory, reserved coverage, shared locking discipline and participant privacy.
- Unexpected-line count history must not authorize inventory credit or provenance automatically. Its exact workflow is pending.
- Proposal initiation, replacement/rejection details and unexpected-line handling must be resolved before dependent implementation. Loss and complementary deliveries are excluded from this count-correction scope.
- Do not change running application, private data, dependencies, existing applied migrations or unrelated untracked task documents.
- English technical artifacts, existing Spanish UI convention. User explicitly authorized local verified C1 and subsequent feature work-unit commits. No push, PR creation, merge or deployment authorized.

## Work units
- [ ] C1: Define and test expected-line correction arithmetic and normalization as a pure domain contract, including upward/downward corrections, capped credit, prior-effective-credit deltas, zero, invalid/overflow inputs and matching original lines. No persisted proposals, endpoint initiation policy or inventory mutation in this unit.
- [ ] C2: Implement immutable revision-linked proposals and joint physical-endpoint confirmation with atomic, exactly-once SQL-owned application and participant invalidation. Resolve remaining product choices first; test concurrency, retries, rollback, reservations and unauthorized actors.
- [ ] C3: Expose participant-private correction API/history and frontend model/API/revision-pinned uncertain-operation recovery with deterministic tests and API documentation.
- [ ] C4: Add detail-contained Spanish correction proposal/confirmation/history UI, retaining original receipt presentation; run functional checks and obtain human manual acceptance.

## Acceptance and verification
- Test-first on deterministic behavior: observed RED then GREEN, followed by focused refactor checks.
- C1 focused command: (cd apps/api && go test ./internal/transfers -run '^TestCorrection' -count=1); run the same command with -race after GREEN.
- Database integration requires a fresh parent-admitted LUSON_TEST_PG_MANIFEST. Do not reuse or create private database authorization implicitly.
- Commands for subsequent units must be admitted with their bounded delegation.
- Native review only under the user-owned review switch. Assess actual diff and follow native verification plan. Functional tests remain necessary.
- Record actual checks and failures; do not close a task on partial checks or before its authorized work-unit commit.

## Progress
- C1 in progress: writer mv5n8ted-2-veye returned two new files (206 added lines). Parent read both. Pure arithmetic only, no persistence/API/runtime effects. Independent verifier mv5ndr74-3-2hub returned PASS with no C1 defects; local verified work-unit commits explicitly authorized; feature-branch-chain selected. C1 ready for local work-unit commit.
- C2–C4 pending. Product blockers above remain intentionally open.
- Existing tracked code clean; untracked historical task files preserved.
- Workload forecast: roughly 1,200–2,000 authored diff lines across domain, SQL, API, recovery and UI/tests, provisional rather than a size quota. Delivery strategy ask-on-risk resolved: chain_strategy=feature-branch-chain. Planned dependent slices: C1 contract; C2 atomic workflow (split further only if coherent); C3 API/recovery; C4 UI. Boundaries will be recorded with actual commits. No publishing authorized.
- Commit evidence: none for this feature yet. User authorized local verified work-unit commits and selected feature-branch-chain.
- C1 checks: writer observed meaningful RED with stub, then GREEN for go test ./internal/transfers -run '^TestCorrection' -count=1 and its -race variant; gofmt succeeded. Native medium review review-928065fbb4afb81c (reliability lens) approved; exact acknowledgement burned authority for target sha256:b951dfcb87c3913099b729c285faff54bab91bd57df1457927187393a1bbfefe. ASSESS failed on untracked declaration, risk unassessable, independentVerifier true; independent verifier mv5ndr74-3-2hub passed the focused correction command, its -race variant and existing receipt normalization/arithmetic command (5 correction and 2 receipt top-level tests found in source, nonverbose output). Historical RED was writer-reported, not independently replayed. No database/full-suite/UI checks run or claimed.

## Next step
Close C1 with the authorized local work-unit commit after confirming staged paths are exactly the C1 code/tests and this feature document. C1 implementation, focused checks and independent/native review are verified. Decide remaining product choices before C2; no stock/API/UI integration yet.
