# Mockup counter and approval-copy corrections — ODD tasks

## Objective and current status

**C01–C14 done; old T14 done for static design only.** Acceptance `2825` (human: “no importa eso, lo importante es que esten las que si sirven y las definitivas”) accepts the definitive static design selection and waives canvas/list visibility as a delivery blocker. C13 closes on independent STATIC_SCOPE PASS / REGISTRY_COVERAGE PASS plus that criterion. C14 closes by **accepted disposition—visibility remains unverified/unresolved, not fixed**. This is authoritative definitive static design selection, not production readiness.

## Why and continuity

Actual PNG/full-HTML audit observations `2770`/`2742` invalidated the earlier final consistency conclusion: warehouse counters omit the existing TR-003 dispatch action, and the A → Almacén submission copy incorrectly suggests deduction/reservation at approval (rather than source-only reservation until physical dispatch). Fixture decision `2773` supplies the bounded correction model. Historical completed work and PASS evidence remain in [remaining-views.md](remaining-views.md); its reopened T14 now closes through C13 and human acceptance `2825`, for static design only.

- Workspace: `/home/luis/velay/luson_v2`; intentionally no Git.
- Stitch project: `6509355458249521776`.
- Task locator: `odd/tasks/mockup-counter-copy-corrections.md`.
- Parent-owned full mirror topic: `odd/mockup-counter-copy-corrections/tasks` (observation 2776); original remaining-view mirror 2679. Both documents were reconciled and read back before the first remote call. Each task transition is fully mirrored, read back and projected to todo before the next call.
- Parent reconciled old mirror `2679`: removing only its structured bookkeeping prefix and normalizing the final newline gives an exact match with the old task file. No continuity conflict exists.

## Scope and non-goals

Only the twelve named counter/copy corrections and final read-only audit are authorized. Keep English documentation and Spanish UI; retain Inter and primary `#7A1F3D`, hover `#5B162D`, tint `#F5E8ED`, page `#F8F6F4`, border `#DED7DA`.

No application/source work, Git initialization or commits, installs, backups, moves, deletion, cleanup, raw HTTP, credential access/workarounds, or unrelated screen changes. No accessibility/font cleanup, unrelated Agotado issue, new brand/model/technology fields, Almacén Central alias, or English UI. No new business behavior or duplicate transfer creation. Real 390px browser/runtime checks remain deferred; browser installation is not authorized.

## Fixture — accepted decision 2773

### Existing warehouse obligations and inventory

Legacy TR-003 is **Almacén → Sucursal A, 10 units, pending dispatch**, observed in legacy `368` HTML lines 252–268. Assign its other holds TOYO L5 + CAR L4 + CAR R1 **as an explicit mockup model**, not a server-observed variant breakdown. TR-014 independently owns CAR L2 + CAR R1 = 3 units. Combined reservations are TOYO L5, CAR L6, CAR R2 = 13 units.

| Warehouse variant | Existing / reserved / available before TR-013 receipt |
| --- | --- |
| TOYO L | 20 / 5 / 15 |
| TOYO R | 12 / 0 / 12 |
| CAR L | 6 / 6 / 0 |
| CAR R | 10 / 2 / 8 |

| TR-013 stage | Warehouse required actions | Explanation |
| --- | --- | --- |
| Pending approval | 3 | Approve TR-013; dispatch existing TR-003 and TR-014 |
| Approved at origin A | 2 | Only the two warehouse dispatch obligations remain |
| Dispatched by A | 3 | Add warehouse receipt of TR-013 |
| Received by warehouse | 2 | Remove TR-013 receipt obligation only |

TR-003 and TR-014 stay pending dispatch throughout this representative fixture; no remote transactions are executed. T12 creation/catalog/review use the pre-receipt stock values unchanged.

### Sucursal A and receipt invariants

TR-013 sends A → Almacén, TOYO L4 + CAR R2 (35 Ah); other A reservations total 3 units (2 / 1). A required actions are 3 → 4 on approval → 3 on dispatch. A stock, reserved, available: before approval 10/2/8 + 8/1/7; approved 10/6/4 + 8/3/5; after dispatch 6/2/4 + 6/1/5. Own approval holds are 4 / 2.

Receipt keeps expected TOYO L4 actual3 (shortage1), CAR R2 actual3 (excess1), unexpected TOYO R2: received8/3variants, available5/2variants, received exceptions3/2variants, shortage1/1variant separately. Post-receipt warehouse TOYO L23/5/18 and CAR R12/2/10; other balances unchanged. Exceptions are not sale-available. No new exception-resolution policy or unexpected-only receipt decision is authorized.

### Exact approval notice

Replace the incorrect T03/T04 deduction/reservation-at-submission copy with:

> La aprobación del Almacén reservará las baterías en Sucursal A. Las existencias se descontarán únicamente al confirmar el despacho físico desde Sucursal A.

Submission neither reserves nor deducts stock. Approval reserves at A; only physical dispatch from A deducts stock. C02 must correct both contradictory review-underlay notices and preserve the already-correct confirmation modal's respective approval/reservation and physical-dispatch meaning. Preserve A badge 3 in C01/C02.

## Routing and promotion gate

1. Parent completes full local/mirror readback and rebuilds the visible todo before the first Stitch write.
2. Prepare one bounded prompt naming project, exact source ID, permitted delta, fixture and protected invariants. Parent bridges **one native Stitch call at a time**; no parallel remote writers.
3. Request REFINE into a **new ID**, retaining the original by default; do not mutate the source. Verify the exact source before the call and exact returned ID/project before independent inspection.
4. Independently inspect the replacement's actual PNG and complete HTML. Provider success prose, titles and timestamps are not evidence. Failed candidates remain retained and unofficial.
5. Parent alone promotes a verified replacement, transitions its task, records evidence, mirrors the full document, reads back both copies and synchronizes todo before continuing.

Worker callable Stitch MCP/codemode and native Agent tools are unavailable. A named server declaration is not callable access. Parent owns bridging and independent verification; no access workaround or delegation is authorized here.

<!-- Legacy link anchor retained for continuity; no tasks remain pending. -->
<a id="checklist--all-pending"></a>

## Checklist

- [x] **C01 — Outbound A → Almacén form:** source `4efc50dcfaf847819619e71c53f82a86`; copy-only correction; preserve A badge 3 and all form/stock/quantity behavior.
- [x] **C02 — Pre-submit review:** source `7db777ac302b4e448632bfe4862beb0d`; exact copy in both contradictory underlay notices; preserve correct modal meaning; preserve A badge 3, no pre-creation ID and no submission reservation/deduction.
- [x] **C03 — Warehouse desktop approval:** source `670f6bb4df214f489fcfb9518bcbac30`; required-action badge 2 → 3; preserve approval at A and incoming-transfer permissions.
- [x] **C04 — Desktop receipt capture:** source `a5b3f06050574b8a9c8d92077fdbe719`; badge 2 → 3; preserve receipt quantities, exceptions and pre-receipt balances.
- [x] **C05 — Desktop receipt review:** source `49a63016a53741f38c97e1bdf9bcfeb5`; badge 2 → 3; preserve read-only receipt arithmetic and single-finalization semantics.
- [x] **C06 — Mobile warehouse listing:** source `66edd8f657bf480ab0782c4ef8482623`; badge 2 → 3 and add the existing TR-003 dispatch action card, not a newly created transfer; retain TR-013/TR-014 and fixture totals.
- [x] **C07 — Mobile approval:** source `28ff08916a774bd8ad5a9dbed07b46c2`; badge 2 → 3; preserve A approval/reservation and warehouse actor permissions. Also clarify the existing approval paragraph: this incoming transfer has no own hold yet; approval reserves TOYO L4/CAR R2 at source A, not a global Warehouse-zero assertion.
- [x] **C08 — Mobile TR-014 dispatch:** source `668c9b0c0a7440e8a93ec4cd08503585`; badge 1 → 2; preserve valid own CAR L2/R1 reservation, existing-stock deduction and atomic dispatch access.
- [x] **C09 — Mobile catalog/cart:** source `430b0f1a965444b79f5aef9c9ca9b52d`; badge 1 → 2; retain unchanged pre-receipt inventory, controls and direct warehouse creation semantics.
- [x] **C10 — Mobile direct-create review:** source `cf8321dd651c47198b2364b505d2260a`; badge 1 → 2; preserve immutable/read-only review, back path and warehouse reservation-at-creation rules.
- [x] **C11 — Mobile receipt capture:** source `0a0ff9a618694a93b0c073c85b71131f`; badge 2 → 3; retain quantities, catalog, exception separation and receipt permissions.
- [x] **C12 — Mobile receipt review:** source `3b0f68d6fabd42c3b167d1cf38e2e3ac`; badge 2 → 3; retain all receipt math, finalization constraints and readable controls.
- [x] **C13 — Final actual-artifact audit:** independent STATIC_SCOPE PASS / REGISTRY_COVERAGE PASS recorded below; twelve per-unit full-PNG/full-HTML passes, final seventeen complete HTML exports and five untouched full PNGs verified; all original 92 and current 105 known artifacts protected. Human acceptance `2825` closes old T14 for static design only.

## Evidence and acceptance

- Audit `2770` inspected all current 92 actual PNG/HTML artifacts. Registry `2733` categorized 48 protected selected + 39 candidates + 1 conditional + 4 unknown: **all KEEP**, not a deletion list.
- Current native projection: 93 instances, 92 root references, 80 listed and 12 hidden; all original 92 known URLs unchanged. These are API projection counts, not proof of actual UI visibility; all thirteen new generated resources remain omitted. Do not equate differently scoped counts or infer deletion from listing omissions.
- C13 reconciled 48 selected artifacts (31 unchanged historical + 17 current, including twelve verified substitutions). All 105 known artifacts remain KEEP: original 92 + twelve selected replacements + retained unofficial failed `718b6345b1fc44e4ba757f8748a9011a`. The historical 39-candidate classification is NOT deletion permission.
- Untouched official IDs: T01 `3221af6d1268400dbce090e51f105a7c`; T02 `d2ceb9080266461f8dbd57510121e65e`; T06 `69624d6a9cee42c3a4fe76c9688fcc1a`; T09 `2b52b360d7fc4d6c87a79b7980266280`; T10 `9ed771e37b354a8f8cd63a212b84aefb`.
- Each replacement must retain role/route, state, quantities, reservation math, actor permissions, palette/Inter, Spanish labels and original layout except the explicit correction. Check counters in every visible relevant context, including modal underlays; audit stock tables/history for regressions.
- Record exact project/source/new ID, PNG and complete HTML checks, failed/skipped/unavailable checks, retention evidence and independent parent disposition before completion.
- Passive tracking has no meaningful application RED/GREEN or runner. C01–C12 done rows identify completed independent full-PNG/full-HTML static verification; C13 records final static audit closure and C14 records accepted unresolved visibility disposition, not a visibility PASS. Runtime, security and transactional checks are not claimed.

- [x] **C14 — Native canvas/list visibility disposition (read-only):** accepted disposition `2825`—visibility remains unverified/unresolved, not fixed. Thirteen generated IDs remain absent from the native projection despite direct-get availability. No creation, attachment, regeneration or deletion authorized.

## Evidence ledger

| Task | Current status | Source / intended delta | Replacement and observed verification |
| --- | --- | --- | --- |
| C01 | done | T03; source `4efc50dcfaf847819619e71c53f82a86` retained | Parent-reported independent STATIC PASS after ONE native variant: canonical T03 `5f1376d04fd44108b7026a668676baf8`; actual 2560×2048 PNG + FULL HTML inspected; exact notices at lines225/292; actorA/badge3/4+2=6/stock10/2/8+8/1/7/controls/style unchanged; no behavior script. Fresh original HTML/PNG hashes byte-identical; proof below. Runtime/browser/app tests and Git commits not claimed |
| C02 | done | T04; source `7db777ac302b4e448632bfe4862beb0d` retained | Parent-reported independent STATIC PASS: canonical T04 `6cacdcff316c4320aed50c95c1849378`; actual full 2560×2048 PNG + FULL HTML PASS; exact two notice replacements lines225/292, no old bad text; modal line298 byte-identical; A badge3/stock/4+2=6/controls unchanged; no collision or behavior scripts. Fresh original HTML/PNG byte-identical: HTML SHA-256 `2542b7f563d7fbc5411fc5e0caa25f34b7c97f2dd6250c88053974daf8b4ce4f`, PNG `09bec901d461d2c0c5d25670368df643e2ead4970902808efdae5e9776aedd7f`. Runtime/app/Git not claimed |
| C03 | done | T05; warehouse 2→3 | Verified new `d5e3220eae8445d5b43d358cf96331b9`; source `670f6bb4df214f489fcfb9518bcbac30` retained byte-identical. Actual full PNG + complete HTML static PASS; evidence /tmp/luson-mockup-corrections/. No runtime/Git claim. |
| C04 | done | T07; warehouse 2→3 | Verified new `29c4c04f8ddf414780f8775ae824c18b`; source `a5b3f06050574b8a9c8d92077fdbe719` retained byte-identical. Actual full PNG + complete HTML static PASS; evidence /tmp/luson-mockup-corrections/. No runtime/Git claim. |
| C05 | done | T08; warehouse 2→3 | Verified new `b599f12e26f34c1fbb3f38ad2444d30f`; source `49a63016a53741f38c97e1bdf9bcfeb5` retained byte-identical. Actual full PNG + complete HTML static PASS; evidence /tmp/luson-mockup-corrections/. Initial existing-label-only scope flag resolved by independent exact diff: native count tooltip allowed; no second generation. No runtime/Git claim. |
| C06 | done | T11 list; 2→3, existing TR-003 card | Verified new `0a33f367884e49d7b229939de832c035`; source `66edd8f657bf480ab0782c4ef8482623` retained byte-identical. Actual full PNG + complete HTML static PASS; evidence /tmp/luson-mockup-corrections/. No runtime/Git claim. |
| C07 | done | T11 approval; 2→3 | Verified new `e5a074beb12a4d1489c622eb5cd64e6f`; source `28ff08916a774bd8ad5a9dbed07b46c2` retained byte-identical. Actual full PNG + complete HTML static PASS; evidence /tmp/luson-mockup-corrections/. Explicitly authorized existing approval-paragraph replacement clarifies own hold0/source A reservation4/2 (C07 prepared prompt and independent PASS2796); not badge-only. No runtime/Git claim. |
| C08 | done | T11 dispatch; 1→2; original `668c9b0c0a7440e8a93ec4cd08503585` retained | Verified new `d1fac98c42294864820bde35c1018a0c`; source `668c9b0c0a7440e8a93ec4cd08503585` retained byte-identical. Actual full PNG + complete HTML static PASS; evidence /tmp/luson-mockup-corrections/. Initial placement-only FAIL in retained unofficial `718b6345b1fc44e4ba757f8748a9011a` resolved by one refinement; final nonvisible line303 badge=1 comment remains known limitation (prompt-comment compliance partial, not UI failure). CAR other4/1 is variant-subset, global other10 includes TOYO5. No runtime/Git claim. |
| C09 | done | T12 catalog; 1→2 | Verified new `2d3276204f3d4aa384c1bfd9beec4fcc`; source `430b0f1a965444b79f5aef9c9ca9b52d` retained byte-identical. Actual full PNG + complete HTML static PASS; evidence /tmp/luson-mockup-corrections/. No runtime/Git claim. |
| C10 | done | T12 review; 1→2 | Verified new `85c329f646444712b0237ea58370162c`; source `cf8321dd651c47198b2364b505d2260a` retained byte-identical. Actual full PNG + complete HTML static PASS; evidence /tmp/luson-mockup-corrections/. Initial invented mandatory-tooltip gate resolved by independent revalidation: no tooltip/ID enumeration required; no second generation. Nonvisible comments212/219/223 remain old badge1. No runtime/Git claim. |
| C11 | done | T13 capture; 2→3 | Verified new `eb06b4122b4f49b4a036ee61a44da71a`; source `0a0ff9a618694a93b0c073c85b71131f` retained byte-identical. Actual full PNG + complete HTML static PASS; evidence /tmp/luson-mockup-corrections/. Initial blanket-ARIA gate resolved by independent revalidation of same-badge count-only aria/title; no second generation or broad accessibility claim. No runtime/Git claim. |
| C12 | done | T13 review; 2→3 | Verified new `a25c61ecac454416a6c5c830004eae24`; source `3b0f68d6fabd42c3b167d1cf38e2e3ac` retained byte-identical. Actual full PNG + complete HTML static PASS; evidence /tmp/luson-mockup-corrections/. No runtime/Git claim. |
| C13 | done — static design only | Final cross-view audit | Independent STATIC_SCOPE PASS / REGISTRY_COVERAGE PASS: 12 native badges, complete17HTML, five full untouched PNGs/fresh10files byte-identical, stock/receipt/role math and selected48/known105 reconciled. C07 approval-paragraph scope reconciled after timed-out query. Human criterion/acceptance2825 closes definitive static selection; CANVAS_VISIBILITY UNVERIFIED, not production readiness. |
| C14 | done — accepted disposition | Read-only native projection reconciliation | Fresh native root/list still93instances/92refs/80listed/12hidden; none13new IDs anywhere/0nested variants. Live README reviewed completely; three indexed _autodocs URLs404. MCP inventory and live SDK document no adopt/save/attach route; SDK is unofficial. Cause remains unknown. Acceptance2825 waives visibility as delivery blocker: visibility remains unverified/unresolved, not fixed. No new generation, project mutation or cleanup. |

## Definitive static design selection — 48 unique IDs

Authoritative role/ID registry supplied with acceptance `2825`; no timestamp/title inference. The 31 historical and 17 current screens are workflow-state/role alternatives, **not one simultaneous live database snapshot**. Historical warehouse 2→1→2→1 counters are superseded counterevidence; the current TR-013 warehouse sequence is 3→2→3→2. TR-003 background10 is explicitly allocated TOYO L5 + CAR L4 + CAR R1 (design model, not server breakdown); TR-014 owns3, total13. Untouched T10 is an inventory alternative, not proof that every screen shares the TR-013 stage.

### 31 historical selections — unchanged

| Supplied role | Selected ID |
| --- | --- |
| Desktop inventory | `0de7519c7e744fe3a65c4a422dc1afdc` |
| Direct-send cart | `74981de7ea944ffc82bd734f4ad0d710` |
| Direct-send review | `211bef1392654a9bba6ff8f90a960c2a` |
| Direct pending dispatch | `7b7014bc2b5345e6ae848b23089adec3` |
| Direct dispatch confirmation | `2ae7a4ee6c88469b85624b08e4702831` |
| Direct origin transit | `ad81c9742d8148f492d9b411c8e1f68d` |
| Direct destination transit | `bde3c2494af74eeb82b4b586fb23135e` |
| Ordinary receipt capture | `0f8d0a838e734b0f8cb1e0c6de032a69` |
| Ordinary receipt review | `53d91d9145be4e419a8c1b430f5822de` |
| Receipt differing outcome | `7d94ece03edf47319b6e4a8f74e05097` |
| Receipt matching alternative outcome | `799a943a395743ada4e1c82313fa441b` |
| Warehouse desktop transfer list | `368275ff488942ebb6246d5ca8e44955` |
| Branch A desktop transfer list | `9ba6b7ae6e4b406c83b5f910defa58ed` |
| Warehouse-request form | `1db28971cab145a490f567c3f0c14be0` |
| Warehouse-request review | `066c481f9b134172b1b9d9c604cb9101` |
| TR010 creator pending | `8210853b4c684cdeaddd390bc315456c` |
| TR010 supplier pending | `f5bc8e4bfd354f1fb41330f81d8139ff` |
| TR010 approval confirmation | `2fa8888b6c0f411188a59128df0830c0` |
| TR010 supplier approved | `1c804bb72de24df7b84f547e33239bcc` |
| TR010 creator approved | `488e1a4eb0894ebc8e876ad435d16355` |
| TR010 creator cancellation confirmation | `b44c443ac5a541acbb1651dcbfd5ddc9` |
| TR010 canceled outcome | `bee0193fc16644c89422494f2fc7c79e` |
| TR011 rejection confirmation | `6b1eda1dc19548599fe7750939e8bebf` |
| TR011 rejected creator | `4ffaf3cfab964eb58baec439b14f4700` |
| Interbranch request form | `62762677118c48e9bf6441a1758d9213` |
| Interbranch request review | `f750c57a527040288db290de28d60494` |
| TR012 creator pending | `ef2c4d0632b74a8e8a77cf85ed481cc7` |
| TR012 supplier pending | `c6727b9f9a924280b2329f503e3354c6` |
| TR012 approval confirmation | `7192e51a73374416b9347ab6adc6f90a` |
| TR012 supplier approved | `bdb9dd9acf9948f983208c6530de6848` |
| TR012 dispatch confirmation | `6f339e006a454dd79da798c74d13976c` |

### 17 current selections — five untouched plus twelve replacements

| Supplied role | Selected ID |
| --- | --- |
| T01 B transit | `3221af6d1268400dbce090e51f105a7c` |
| T02 A transit/receipt entry | `d2ceb9080266461f8dbd57510121e65e` |
| T03 A→Warehouse form | `5f1376d04fd44108b7026a668676baf8` |
| T04 A→Warehouse review | `6cacdcff316c4320aed50c95c1849378` |
| T05 Warehouse incoming approval | `d5e3220eae8445d5b43d358cf96331b9` |
| T06 A approved dispatch | `69624d6a9cee42c3a4fe76c9688fcc1a` |
| T07 Desktop exception capture | `29c4c04f8ddf414780f8775ae824c18b` |
| T08 Desktop exception review | `b599f12e26f34c1fbb3f38ad2444d30f` |
| T09 Local login | `2b52b360d7fc4d6c87a79b7980266280` |
| T10 Warehouse mobile inventory | `9ed771e37b354a8f8cd63a212b84aefb` |
| T11 Mobile local action list | `0a33f367884e49d7b229939de832c035` |
| T11 Mobile incoming approval | `e5a074beb12a4d1489c622eb5cd64e6f` |
| T11 Mobile direct dispatch | `d1fac98c42294864820bde35c1018a0c` |
| T12 Mobile direct cart | `2d3276204f3d4aa384c1bfd9beec4fcc` |
| T12 Mobile direct review | `85c329f646444712b0237ea58370162c` |
| T13 Mobile exception capture | `eb06b4122b4f49b4a036ee61a44da71a` |
| T13 Mobile exception review | `a25c61ecac454416a6c5c830004eae24` |

### C01 retained artifact proof — parent independent verification

Evidence directory: `/tmp/luson-mockup-corrections/`, artifacts keyed by the exact source and replacement IDs. Parent accepted the new ID as canonical T03; source remains retained.

| Artifact | SHA-256 reported by parent |
| --- | --- |
| New HTML | `2f5232beb48749bdbf02c9d3484dbb94704956f533392323b3ce5fef9b37c1a3` |
| New PNG | `0bd70bdc7c47a7c0e80d6924cf1cbabd04078c8dd8f39047ec89e60789b1b64c` |
| Original HTML, unchanged on fresh readback | `808fffa1af656e08046645fa3caa8e9b945cab7d51a6086bb4d71789f0a8cc4c` |
| Original PNG, unchanged on fresh readback | `1d7c5447db9451d09131b3de086e55b3583907b08c29edcefbe57a3aae659b99` |

## Known limitations

- Native static export verification is not app/browser/runtime/security/atomicity proof; no meaningful application RED/GREEN, Git review or commits are claimed.
- C08 final line303, C09 lines409/416/420, C10 lines212/219/223 and C12 retain known nonvisible old-count comments; visible counts are corrected. Prototype HTML must not become application business logic. C08 comment-prompt compliance is partial, not silently declared complete.
- C09 CAR L existence/reservation6/6 is not displayed locally (available0 is); global fixture validation uses inventory/dispatch cross-view evidence. Unchanged Agotado may be ambiguous and was explicitly outside this correction scope.
- Receipt with only unexpected units, live390px scroll/focus/navigation and security/atomic races remain unresolved or unverified before application implementation.
- All original, failed and corrected resources remain KEEP; downloads under /tmp are temporary inspection exports, not durable backup or deletion consent.

## Resume and next step

C01–C14 and old T01–T14 are done for the authorized static-design scope. C14 is accepted disposition, not a repaired canvas; C13 closes on the independent static passes and human acceptance `2825`. The twelve canonical replacements are independently verified and direct-get available. All thirteen new generated resources (including the failed unofficial candidate) succeed by direct project-qualified get_screen with unchanged HTML/PNG URLs but remain omitted from native root93instances/92refs/list80/hidden12 (no nested variants). Known105 all KEEP, including all twelve superseded sources. No UI visibility, Git review approval, durable backup, deletion consent or production readiness is claimed. Explicit No Git; no application TDD, commits or native review authority work occurred.

No further remote work or rerun is needed for this passive reconciliation. Future backup planning and exact-list confirmation are separate scoped decisions; neither is authorized here. Parent owns mirror2776/mirror2679 synchronization, full readbacks, todo projection and independent structural verification before final delivery.
