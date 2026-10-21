# Publish the verified transfer UI branch

## Goal and authorization
Prepare coherent commits and publish `fix/transfer-frontend-fidelity` without merging into `master`. The human approved preparing pending commits and publishing this feature branch. The running application and PostgreSQL database remain a local test environment and must stay untouched.

Starting HEAD: `335547764c4f6a5cb67fe279f25b2223ea206c47`. Starting index: empty. Existing feature history: 49 commits ahead of local `master`. Read-only remote preflight confirmed `master` at `292a6d0fa228c57de7f82135b341e10bcd0fb708` and found no existing remote `fix/transfer-frontend-fidelity` branch. Recheck the publication target before pushing; this is not merge acceptance.

## Scope
- Commit the already-present creation accessibility/responsive fix together with its unit test.
- Update README status and safe frontend verification guidance without replacing historical evidence.
- Use explicit path allowlists; preserve all unrelated dirty/untracked files.
- Verify candidate content, runnable checks and outgoing publication privacy before staging or committing.
- Publish only the feature branch, with no force push, merge, PR, runtime action, database change, reset, cleanup or installation.

## Tasks
- [ ] P1 (in progress): Verify and commit the pending creation accessibility work. Allowed product paths: `apps/web/src/TransferCreation.tsx`, `apps/web/src/TransferCreation.test.tsx`, `apps/web/src/style.css`. Keep tests with behavior and include this publication tracking document. Source changes already exist and were included in the manually accepted frozen build; this task does not invent a new RED cycle or alter behavior without a diagnosed defect. Fresh independent focused/full frontend tests, typecheck and isolated build are required before completion.
- [ ] P2: Update and verify `README.md` to describe implemented transfer functionality, repository layout, local-test status and safe frontend checks. Keep historical L01–L05 evidence explicitly historical. Commit this cohesive documentation change with tracking updates. Documentation uses structural verification; no meaningful test-first RED applies.
- [ ] P3: Audit the complete outgoing commit range, verify remote branch state, publish the feature branch and confirm its remote HEAD. Preserve exclusions, record exact local work-unit commit identities and report any remaining dirty files. Do not rewrite the existing 49 commits.

## Default exclusions
These remain local and unchanged unless a later explicit scope and verification justify inclusion:
- All 72 `odd/design/transfer-detail-ux/` JSON/PNG design artifacts; filename classification is not a privacy approval.
- The three `apps/web/e2e/f6b-native/` files. This optional native-browser harness pins historical inputs and a user-cache Chromium path; do not advertise it as portable or freshly verified.
- All nine pre-existing untracked historical/runtime task documents.
- Existing modifications in `odd/tasks/transfer-frontend-fidelity.md`, `odd/tasks/transfer-ui-all-flows.md` and `odd/tasks/transfer-ui-mockup-adaptation.md`, unless specific relevant hunks are independently approved. Preserve their local acceptance/runtime history rather than deleting or rewriting it.
- Private configurations, credentials, TLS keys, databases, backups and generated validation outputs.

## Verification and review
- Inspect the exact three product diffs and compare preserved unrelated paths before/after each phase.
- Use an isolated source/dependency copy and private build/cache/output locations for functional checks. No installs, live runtime, login, business requests or database tests are needed for these frontend/documentation units.
- Do not narrow full Vitest discovery: tracked companion files under `apps/web/e2e/` are required by configured tests.
- Native review follows the user-owned RDD switch and exact candidate consent. Each new work-unit commit is a candidate against its preceding boundary, never the accumulated branch or an arbitrary TODO checkbox.
- The existing branch is approximately 9,200 changed lines relative to local `master`. Branch publication is not PR/merge acceptance; any later integration needs a focused review strategy.
- The historical build proof records HEAD `db38819…`; later provenance binds the integrated HEAD335 assets. The tested working tree includes the pending creation sources, so HEAD335 alone is not presented as reproducing the accepted UI.

## Progress and evidence
- Read-only scout `mvhd1ban-q-2875` mapped dependencies and proposed the work units. No unresolved product decision blocks this plan.
- Read-only preflight `mvhd1yiv-r-gshw` completed: 20 selected text files / 832,963 bytes heuristically screened with zero secret-pattern candidates; design contents and outgoing history were not covered. Remote query succeeded as recorded above. No functional tests were executed in that preflight.
- The optional native fixture's three source hashes match current source bytes, but its pinned user-cache browser path and dependency-sharing assumptions remain environment-specific. Keep it excluded from this focused publication; ordinary unit tests and application builds do not import it.
- Initial functional attempt `mvhd54f6-s-cvt2` created `/tmp/luson-publish-p1-check-3rvdy87t` and verified 130 tracked frontend files plus 5,322 dependency files. Focused npm exited1 before Vitest because user/global config both pointed to `/dev/null`; no tests ran. Diff check passed and 8,110 canonical paths/HEAD/index/exclusions were preserved. Full tests/typecheck/build were not run; no GREEN claim.
- Functional continuation `mvhd7g38-u-1duy` PASS in the isolated copy: focused Creation79/79, full Vitest2570/2570 across36files, typecheck/build/diff checks all exit0. All130trackedfrontend inputs/5322dependencyfiles and8110canonicalpaths were preserved, excluding only this parent tracking document. Distinct private npm config files resolved the initial harness failure; no product changes or invented RED. Logs: `/tmp/luson-publish-p1-check-3rvdy87t/attempt02/logs/`.
- Fresh private build:59files1566439bytes, JS`index-BZFWAcDR.js`/CSS`index-pwv8zqti.css`; nonfatal chunk>500kB warning retained. Read-only `mvhdbhgd-v-n769` fully explained the165byte difference from the deployed build: identical130shared source hashes, identical application JS bytes and56fonts; HTML only changes two entrypoint references. CSS differs only by three Tailwind outline-utility fragments induced by a standalone token in excluded native-runner code, with no identified application consumer. The clean candidate supports the same application behavior for this difference, not byte-identical artifacts or a fresh manual-browser pass. Historical build pins and the running deployment stay unchanged.
- Outgoing-history audit `mvhd68d6-t-g4io` returned PASS-HEURISTIC-SCREEN for exact range `292a6d0fa228c57de7f82135b341e10bcd0fb708..335547764c4f6a5cb67fe279f25b2223ea206c47`: 49 commits, 41 changed paths, 259 deduplicated old/new text blobs / 11,291,907 bytes, plus all commit messages; no skipped/binary blobs or unresolved secret candidates. The 34 short mnemonic occurrences were test fixtures. Historical local-path/hash references are not treated as secrets solely by appearance. This is heuristic screening, not sanitization or functional acceptance.
- The audit's status delta was exactly the newly parent-owned `odd/tasks/publish-transfer-ui.md`; excluding only that path restored the original status hash. No unexplained status change remains. This new document and future commits still need their own publication screening; the history pass does not cover uncommitted content.
- Initial dirty product/document files: six, with 244 additions and 20 deletions. Initial untracked files: 84, totaling 10,147,812 bytes. This new tracking document is additional and parent-owned.
- P1 verification and artifact-delta review are complete. Parent will stage exactly the three product files plus this tracking document, excluding all pre-existing local documents/designs/fixture files. Commit and native exact-slice review evidence are pending; no push or runtime operation has occurred.

## Next step
Create the verified P1 work-unit commit using the exact four-path allowlist, then obtain native review for that new committed slice against the full starting HEAD. Record its identity and outcome before P2 README work. Audit new commits before publication; no unscanned design/runtime artifact is implicitly approved.
