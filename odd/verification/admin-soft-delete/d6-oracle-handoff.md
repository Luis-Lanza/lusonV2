# D6: three source-justified oracle corrections (not a runtime PASS)

Source supports correcting exactly the three job70 assumptions. The isolated adapter is prepared, NOT executed. Original job69 STOPPED, job70 FAIL3, all drivers, runners and trace bytes remain unchanged. This covers S2–S4 rejection/authority preservation only; it does not close D6, browser/SSE evidence or D7.

## Parent action after source review

Run once, mechanically, without application workloads:

```sh
python3 .cache/admin-soft-delete-d6-reclassify.py --run
```

The only output location is a fresh `/tmp/luson-account-administration-82bce681/d6-oracle-reclassify-*` directory, containing `source-proof.json`, `binding.json` and `comparison.json`. No Go, Node, HTTP or DB command is reachable. Git operations are read-only rev-parse/archive. No adapter execution was performed by the writer; no reclassified result is claimed here.

## Source verdicts

### restitutions-accept and restitutions-reject — high source confidence

Both requests reject without public effects. The label `destination-only-review; active-origin-forbidden` is retained byte-for-byte as historical metadata, but **does not specify which rejecting guard executes first**.

1. `apps/api/internal/httpapi/transfer_restitutions.go:121–190` checks method, authenticated inventory identity, mutation guards, canonical ID, participant/header privacy and strict payload before calling DecideRestitution. It does not enforce destination-only decision authority at this boundary.
2. `apps/api/internal/transfers/restitution.go:141–190` checks assignment, participant membership, received header and input before the actual `transfer_restitute` SQL call. `CheckRestitutionAccess:237–275` is expressly a participant privacy fence, not action authorization.
3. `apps/api/migrations/012_transfer_restitutions.sql:293–327` is the actual entrypoint: READ COMMITTED, common advisory fence, received physical participant and expected receipt line; exact stored replay returns BEFORE fresh INSERT. Neither action-specific destination authority nor fresh revision checks precedes that INSERT.
4. The INSERT's BEFORE STATEMENT fence is `012:96–97`. BEFORE ROW triggers then run alphabetically: `admit_active_participants` (`017_admin_soft_delete.sql:90–118`) precedes `apply_restitution_operation` (`012:244–245`). The former rejects retired endpoints with SQLSTATE23514, constraint `active_location_required`, exact message `New work requires active locations`.
5. The operative apply function is the REPLACEMENT in **`013_transfer_dispatch_reconciliation.sql:546–652`**, not merely migration012. Its received/participant check at557–560, revision check at570–572, count-state checks at574–578, and destination-only decision check at600–603 are all inside the later row trigger. Migration017 therefore fires BEFORE these fresh-work checks in BOTH frozen refs. In particular, no legitimate rule promises origin-role403 before retirement rejection.
6. `restitution.go:193–232` preserves `ctx.Err()` first. The sole baseline→candidate change in this file adds exact active-location classification to ErrDecisionConflict. `correction.go:164–170` matches all THREE SQL error fields, not a blanket23514 or503 map. Baseline lacks this match, and the active-location error falls through to `fail(ctx)` (`store.go:22–27`), hence ErrUnavailable. `httpapi/transfers.go:59–76` gives exactly503/service_unavailable versus409/decision_conflict. All existing42501 role messages and their403 mapping remain intact.

Frozen baseline `4cbe8f2e971f77f72f023b51dd9ae954a7968e72` already contains migration017; current is `0bbb729adf40db7270475999336a09af201db92d`. The source diff changes only this error translation at the restitution seam, not permission checks or SQL. The driver (`.cache/admin-soft-delete-d6-backend-diff.go:95–112`) invokes fresh keys as active origin1 against received transfer1/retired destination4. This reaches retirement admission before destination-only review; the exact503→409 pair is consistent only with the narrowly added translation in this controlled source delta, not a newly granted authority.

**Limits/counterexample:** canceled/deadline context can also surface as503 via HTTP fallback. A nonnil `ctx.Err()` would win in BOTH versions, not become409 through the new classifier. Other SQL23514 errors, active-endpoint origin decisions, wrong participants and mismatched stored replay are NOT admitted by this correction. Already-recorded exact replay returns before INSERT; active destination-role403 contracts remain unchanged. No source priority is invented for every error combination, and public traces alone are not treated as cause proof. This is source-plus-existing-evidence attribution, not newly observed SQL error telemetry or proof of private counters.

### request_stock-retired — high source confidence, no retirement coverage

`contract.go:97–134` derives request_stock origin from counterparty4, destination from authenticated personal3. `store.go:71–119` checks recorded replay, then locks and checks source availability for ALL fresh kinds, including pending requests. Only the later status assignment differs by kind; header INSERT begins at121. Migration017's retirement admission is a header row trigger and cannot run before this query/availability return. Pending requests do not reserve stock, but that is not an exemption from availability validation.

The existing driver proves destination4 is empty before retirement (`backend-diff.go:62–77`) and sends the request at123. The unchanged409 `{"error":"insufficient_stock"}\n` is therefore an EXISTING PRECONDITION REJECTION, not retired-guard coverage and not an admitted pending request. `httpapi/transfers.go:67–70` distinguishes insufficient_stock from decision_conflict even though both are409. The oracle's409 body restriction was wrong for this exact case. No fixture, metadata, request, body or outcome changes are authorized.

## Adapter guard/review map

- Pins job70 preparation SHA256 `eeda9d4f10466196a7a3fe4b38786ef1f41c7d7845aa1432ca93eb37baf40c2e` and original FAIL comparison SHA256 `520f8e51397c76a51189e46431803ad3336b3d7988db8c87820e0497955fa484` before loading their content.
- Hash-verifies original runner and resume modules BEFORE import; imports neither main. Pins HEAD/three refs, original runner/resume/Go/current-Web driver SHA lineage, all `original_evidence_sha256` entries, job69 STOPPED, archive and overlay hashes, old→new frontend emission-only transformation, new frontend plans and raw/public hashes.
- Reuses the resume module's read-only `trace` helper to extract all14 Go and42 Web observations from raw stdout, verify public wrappers/zero exits, strict stderr and name order. It regenerates every original classifier record and requires exact equality with all56 saved job70 records, including three exact names/reasons. It does not trust comparison.json without raw validation.
- Reads proof files from BOTH frozen archives and requires equality with original Go candidate source files. Records SHA256/ref/path/line provenance BEFORE accepting corrections. Archives are bound by the original and resumed run bindings, not newly guessed source versions.
- Only exact backend names `restitutions-accept`, `restitutions-reject`, `request_stock-retired` can bypass the old assumptions. Whole-dict equality requires exact routes, names, statuses, bodies, cookie0, unchanged=true and original eligibility strings; restitution only503→409 with the standard pair, stock before==after exact409/insufficient_stock. Unknown fields also fail equality.
- Other53 call original `classify` verbatim. No broad status maps, normalization, rewritten raw/public input, or partial56 PASS. Result before/after objects are the original extracted JSON observations; source corrections are separate annotations, never eligibility rewrites. All input hashes are checked before/after result preparation, and originals are never written.

## Verification and known limits

Test-first exception: this is explicitly source-only preparation; tests, unit probes and adapter execution are prohibited. Bounded `ast.parse`/structure inspection passed: adapter155lines (under200), one original-classifier call site, no direct workload/destructive execution calls. `git diff --check -- .cache/admin-soft-delete-d6-reclassify.py odd/verification/admin-soft-delete/d6-oracle-handoff.md` exited0 (new/ignored files also receive the final static whitespace check; ordinary git diff does not include them). Functional backend and frontend receipts are prior parent evidence, not this worker's new validation. No runtime PASS is reported.

An initial guessed migration filename read failed (ENOENT); scoped discovery identified `017_admin_soft_delete.sql`. A guessed `validate.go` grep failed (exit2); scoped source search identified `contract.go`. No files were changed in response except these two allowed preparation surfaces. Existing unrelated untracked evidence is preserved. A large initial git-status output was host-spilled to `/tmp/gpj9v8pJ/ga5z2E9M/pi-bash-7c747c1689ad77b8.log`; no cleanup attempted.

## Key Learnings

- The operative restitution trigger body is replaced in migration013; checking012 alone is insufficient.
- Retirement admission preceded action-role checks already in the baseline. A role description is not an error-precedence oracle.
- A pending request's non-reservation property does not bypass Create's availability precondition. This case cannot prove retirement admission.
