# Transfer discrepancy resolution

## Objective and accepted intent
Resolve a received transfer discrepancy caused by an incorrectly recorded dispatch when units are explicitly confirmed retained at origin. C4 count correction remains closed and its destination-only history stays intact.

User approved on 2026-10-12: origin proposes a retained quantity and reason; the exact destination account accepts or rejects the exact proposal. Acceptance atomically credits origin existing stock once without increasing reservations. Example: dispatched 5, effective destination credit 4, confirmed retained 1 => net origin -4, destination +4.

## Scope and invariants
- Received expected lines only; physical origin/destination accounts, no new admin role.
- Separate append-only proposal, decision and application evidence; preserve original dispatch and receipt.
- Require explicit origin retention attestation and nonempty reason. Destination confirmation alone never proves retention.
- One successful restitution application per transfer/variant for this initial vertical, including partial settlements; rejections may be followed by a fresh proposal. No reversal, loss disposition or later delivery.
- Let D be immutable dispatched debit, C latest effective destination credit, R applied source restitution. Enforce R + C <= D atomically. A new q must be positive and <= D - C - R; never infer physical retention from inventory balances.
- Exact operation-key retries return persisted results without another credit; differing payload conflicts; different-key duplicate applications are also rejected.
- Pin proposal and cross-workflow revisions; no restitution while a count proposal is pending. Revalidate on acceptance; stale confirmation conflicts. Future C4 acceptance must also enforce conservation with R, without silent origin debit or reversal.
- Preserve current inventory overflow, reservation/allocation coverage, authentication, CSRF/Origin, audience privacy and read/write recovery protections.

## Authorization and non-goals
Scoped source implementation authorized after proposal and approval. No manual runtime rollout, existing database writes/cleanup, Docker lifecycle, browser/Playwright, publishing or destructive Git operations. Integration fixture lifecycle needs a separately admitted isolated test target; do not reuse the manual database. Existing four untracked ODD documents are unrelated and must remain intact.
User explicitly authorized local work-unit commits for this vertical after verification/review (memory5486). No push, PR or merge. Record actual commit identities before closing tasks; preserve unrelated files and resources.

## Checklist
- [ ] R1: Pure restitution contract and conservation arithmetic with deterministic tests. **In progress**.
- [ ] R2: Append-only SQL workflow, atomic source credit and restitution-aware count acceptance guards.
- [ ] R3: Store integration and isolated database concurrency/schema/rollback verification (fixture admission pending).
- [ ] R4: Authenticated API, exact replay and private history transport with tests.
- [ ] R5: Frontend models, pinned mutation/recovery and cross-workflow stale-state tests.
- [ ] R6: Separate detail section, roles, approval/rejection and immutable history integration with tests/docs.
- [ ] R7: Integrated verification and user-owned manual acceptance preparation; runtime rollout only after separate authorization.

## Acceptance criteria and checks
- Recorded 5 / effective receipt 4 / retained 1 yields source +1 once, destination unchanged, originals unchanged.
- Cannot credit origin based on shortage alone, exceed outstanding debit, resolve unexpected goods, or exceed D with R+C.
- Unauthorized, stale, duplicate different-key, conflicting retry, overflow and uncovered-stock cases fail atomically.
- After R=1 for D=5, destination correction to credit5 conflicts; allowed lower/equal credits remain possible without restitution reversal.
- Both concurrent workflow lock orders, pending/replaced/rejected proposals, exact retry and zero-delta destination changes covered.
- UI shows original evidence, effective destination count and separate restitution history; roles and private owner fencing remain correct.
- Applicable behavior uses observed RED -> GREEN -> focused regression checks. Independent command-running verification delegated. Native review under current user-owned RDD switch, exact candidate scope only; functional checks still required.
- Test/code line forecasts are provisional, not quotas; do not compress tests or omit behavior to fit a count. Units may be split when a coherent review boundary exists.

## Progress and evidence
- Baseline branch feature/transfer-dispatch-receipt, HEAD ee1c190. Tracked tree clean; four historical untracked ODD documents retained.
- Read-only explorer mapped existing dispatch debit, destination-only correction, physical account authority and stock conservation (memory5477). Parent spot-read migration011 acceptance confirms missing restitution-aware cap.
- Approved scope saved as memory5479.
- RDD status reads on (global). Native inspect selected only the two R1 contract/test files, excluding all ODD docs. First two START attempts returned consent-binding-expired with no lineage/mutation. User explicitly authorized a fresh retry; host resolved consent and created review-40641989edaec316, medium reliability lens, 232 source/test lines. One forecast model run and capture approved; exact provider acknowledgement completed, authority burned for target sha256:acb6c17aed9a82d91e586659630104d69b925e5c5e9f3bd6529ab3bc7f9d4938, consumed revision sha256:0101d32b1548f018eb36018f5e1db98fac2621445a34f6cd2f19375e7e440c17. No STATUS after burn. Review does not authorize repository commit.
- R1 allowed surfaces: apps/api/internal/transfers/restitution_contract.go and restitution_contract_test.go only. Existing C4 functions unchanged in this unit; integration comes later.
- R1 checks planned: from apps/api, go test ./internal/transfers -run '^TestRestitution' -count=1; same with -race; existing pure correction/receipt arithmetic regressions. No database tests admitted.
- R1 writer mv62gru1-2-9n1b launched in background on the two exact new contract paths. Initial envelope rejected before dispatch for noncanonical allowed-surface prose; corrected envelope admitted, no duplicate writer.
- R1 writer completed 232 additions in two new files (52 contract/180 tests), no existing file changes. Exports CalculateRestitution => SourceDelta=q/RemainingQuantity=D-C-R-q and ValidateRestitutionDestinationCredit => reject credit outside [0,D-R] without clipping. Parent full production readback confirmed subtraction-only overflow-safe bounds and SQL-owned eligibility documentation.
- Writer observed compiling-stub RED exit1/0.006s, GREEN0.004s/postformat0.005s; focused -race PASS1.016s; seven named pure correction/receipt regressions PASS0.004s; gofmt/whitespace PASS. Historical RED is writer-reported, not independently replayed; no DB/runtime/browser/full-suite checks run.
- ASSESS returned unassessable due explicit-untracked declaration requirement; independentVerifier=true. Independent verifier mv62l7mi-3-3k2d PASS: focused0.006s/race1.017s/pure regressions0.005s, no skips/no blockers; six top-level restitution tests and59 named subtests/seven regression names structurally confirmed, no DB selection. Formatting clean; no-index checks exit1/no diagnostics reflect additions, not whitespace failure. Both full files inspected; candidate SHA256 production04e57865369c11692cd796bd2420e7b3ac4459c233f70186466ab749135ccad1/testbe5fcdb84c1305d96949ea55f9bbe11eb94d567b93ff907117557e368b6e9b86 stable, HEAD/status unchanged. No runtime/DB changes.
- Local work-unit commits authorized by user. R1 source hashes independently verified and parent rechecked unchanged before staging; index initially empty, baseline HEAD unchanged.

## Next step
Commit exact verified R1 files with this feature document, record actual commit evidence and close R1. Then map R2 allowed surfaces and isolated test fixture requirements read-only before assigning a writer. No runtime/database operations admitted.
