# Remaining Luson views — ODD tasks

## Objective

**T01–T14 done for static design only; C01–C14 done.** Human acceptance `2825` approves the definitive static design selection and waives canvas/list visibility as a delivery blocker, not as a repaired condition. The authoritative [48-ID selection](mockup-counter-copy-corrections.md#definitive-static-design-selection--48-unique-ids) contains 31 unchanged historical + 17 current workflow-state/role alternatives, not one simultaneous live database snapshot. Production readiness, cleanup and deletion are not claimed or authorized.

## Why

The domain and most desktop flows have already been defined and reviewed. Remaining work needs a bounded, recoverable checklist, consistent evidence, and explicit separation between genuinely new layouts and reused states.

## Authorization and boundaries

- The user authorized organizing ODD for the remaining views and finishing those views first.
- This document tracks design/mockups only, not application implementation.
- Do not initialize Git, configure the remote, implement application code, delete screens, or start cleanup.
- Keep original screens and corrected predecessors until a separately approved cleanup inventory exists.
- No SDD artifacts or workflows.
- English task documentation; Spanish product UI.
- Work-unit commits are not applicable to this non-Git mockup workspace. No commit evidence is claimed. Application implementation and Git setup require separate authorization.
- Static mockups have no meaningful runnable application RED/GREEN cycle. Verify actual rendered screenshots and exported HTML; defer browser interaction, builds, and application tests until implementation is authorized.

## Continuity

- Workspace: `/home/luis/velay/luson_v2`.
- Task document: `odd/tasks/remaining-views.md`.
- Engram mirror: project `luson_v2`, topic `odd/remaining-views/tasks`.
- Domain recovery: Engram observation `2578`.
- Latest design state: Engram observation `2586`; reconcile it with this checklist before resuming.
- Stitch project: `6509355458249521776`.
- Historical last verified screen: `49a63016a53741f38c97e1bdf9bcfeb5`, **TR013 receipt review — canonical Almacén**; independent screenshot/full HTML PASS remains preserved; superseded by selected `b599f12e26f34c1fbb3f38ad2444d30f`.
- Current status: **T01–T14 done for static design only**. Historical completion covered 17 representative official screens (**9 desktop + 8 mobile**) and a passing final static audit after bounded canonical-name corrections; that evidence remains preserved. Audit `2770`/`2742` reopened T14; C01–C12 correction verification, independent C13 STATIC_SCOPE PASS / REGISTRY_COVERAGE PASS and acceptance `2825` now close it. C14 is done by accepted disposition—visibility remains unverified/unresolved, not fixed. See [correction document](mockup-counter-copy-corrections.md).
- Confirmed economical mobile breakdown: T10 ×1, T11 ×3, T12 ×2, T13 ×2 = 8 mobile screens; 17 representative screens including desktop, excluding corrections.

### Current transfer facts

TR-012 was created by Sucursal A and approved/reserved in Sucursal B. Physical direction is **B → A**. It contains TOYO NS40ZL, 35 Ah, L ×5 and CAR NS40ZL, 35 Ah, R ×3. B's unreserved availability is 4 / 1. Dispatch deducts existing stock and consumes this request's reservation together; unreserved availability remains 4 / 1.

After dispatch, B has one required action remaining (incoming TR-004 receipt). A has three required receipts (TR-007, TR-008, TR-012). Only B dispatches and only A receives. Cancellation is forbidden after dispatch.

## Forecast and reuse

- **14 tasks:** nine representative desktop views, four mobile workflow groups, one final audit.
- Planning estimate: **9 desktop + 7–10 mobile screenshots = 16–19 representative screenshots**. Corrections may create retained predecessors; the audit creates no screen.
- The earlier estimate of 3–4 mobile adaptations described groups, not a confirmed number of screenshots. This clarification is not permission for new business scope.
- Map each mobile group's essential interactions before generation. Use the smallest sufficient representation; do not generate all state combinations.
- If a meaningful missing permission/layout requires more views, surface the reason and revised forecast before expanding the task.
- Existing approval, rejection, cancellation, dispatch, ordinary receipt, and result patterns remain reusable. Do not duplicate them merely because the supplier label changes.

## Shared acceptance criteria

1. Palette: primary `#7A1F3D`, hover `#5B162D`, tint `#F5E8ED`, page `#F8F6F4`, white surfaces, borders `#DED7DA`, primary text `#242124`, secondary text `#6B6267`; typography Inter.
2. Navigation contains only **Inventario** and **Transferencias** plus identity/logout. Use a compact red numeric action badge (`#BA1A1A`), never a separate **Notificaciones** section or bell.
3. Counters represent actions required from the assigned location, not unread events or another actor's actions.
4. Long statuses occupy their own header line, fully visible at approximately 14px. No clipped headers, overlapping text, illegible polarity, or horizontal cropping.
5. Preserve catalog brand/model/capacity/polarity. The current example variants are exactly **35 Ah** and L/R. Never invent technology claims, priorities, guide numbers, reservation IDs, version labels, demo labels, or pre-creation transfer IDs.
6. Pending approval does not reserve. Full approval revalidates and reserves. Dispatch consumes this transfer's own reservation and deducts existing stock; receipt makes expected received quantities available at destination.
7. Validate full quantities atomically; no partial approval/dispatch, negative stock, or treating another transfer's reservation as available. Do not block dispatch merely because unreserved stock is smaller than this transfer's own valid reservation.
8. A creator may cancel before dispatch; release only its reservation, if one exists. No editing after creation, cancellation after dispatch, or second receipt.
9. Long item lists scroll centrally while necessary context, totals, notices, and actions remain accessible. A two-row screenshot does not prove long-list behavior; record unverified behavior honestly and carry implementation criteria forward.
10. Select official artifacts by role/state and observed checks, not by timestamp, generated prose, or matching titles. Record exact IDs and preserve predecessors.

## Routing

- Parent owns scope, domain decisions, Stitch mutations, task transitions, and reconciliation.
- Execute one screen/work unit at a time; no parallel remote writers or destructive operations.
- Use the smallest safe routing: narrow, known Stitch generation and bounded artifact checks inline; context-heavy mapping/comparison goes to a read-only explorer.
- Constrained child agents may lack Stitch/MCP and memory tools. Supply exported screenshots/HTML for read-only inspection rather than changing tool configuration or assuming access.
- Do not run application commands or native code review for nonexistent application source.

## Tasks

Authoritative task statuses and exact completion evidence are in the ledger below. Previous patterns alone are not completion evidence.

### Desktop

- [x] **T01 — Transit detail from origin Sucursal B**
  - Depends on: verified TR-012 dispatch-confirmation baseline.
  - Deliverable: one desktop post-dispatch detail.
  - Checks: state **En tránsito**, physical B → A, 5 TOYO L +3 CAR R sent, own reservation consumed, no cancellation/dispatch/receipt action for B, badge 1, unreserved availability still 4 / 1 if shown. History preserves creation by A, approval by B, and completed dispatch by B. Receipt is pending, not a confirmed zero.

- [x] **T02 — Transit detail from destination Sucursal A**
  - Depends on: T01.
  - Deliverable: one desktop destination detail exposing **Registrar recepción**.
  - Checks: same ID/route/quantities/history as T01, badge 3, only A receives, no cancellation after dispatch. Reuse established receipt capture/review/result patterns; do not generate ordinary duplicates.

- [x] **T03 — Outbound transfer form from Sucursal A to Almacén**
  - Depends on: existing catalog/cart patterns.
  - Deliverable: one desktop send form.
  - Checks: creator and physical origin A, destination and approver Almacén. This sends A's stock, not a request for warehouse stock. Source availability, quantities, context, and primary action communicate that direction. Preloaded catalog only; no stock adjustment or product CRUD.

- [x] **T04 — Review A → Almacén before submission**
  - Depends on: T03.
  - Deliverable: one desktop pre-send review.
  - Checks: direction and quantities match T03; requires destination warehouse approval; submission neither reserves nor dispatches; return to editing preserves selection. Do not assign an ID before creation.

- [x] **T05 — Warehouse actor view pending approval of incoming transfer**
  - Depends on: T04.
  - Deliverable: one desktop warehouse approval detail.
  - Checks: warehouse approves/rejects the incoming A → Almacén transfer; approval reserves the full quantities at **origin A**, not warehouse stock. Warehouse approval does not dispatch. Historical creator stays A. Apply established confirmation/rejection templates and location-scoped permissions.

- [x] **T06 — Creator A view approved and pending dispatch to warehouse**
  - Depends on: T05.
  - Deliverable: one desktop origin detail.
  - Checks: approval/reservation at A, dispatch action owned by A, receiving actor Almacén. Creator can cancel before dispatch and release its reservation; no cancellation afterward. Reuse common dispatch/cancel/receipt templates with corrected roles. Flag a genuinely missing permission/layout before adding another view.

- [x] **T07 — Receipt capture with excess and unexpected catalog variant**
  - Depends on: existing receipt-entry pattern.
  - Deliverable: one desktop exception-capture representation.
  - Checks: example includes positive expected arrivals, an excess, and an unexpected catalog variant. Actual quantities are editable/readable. Unexpected selection uses the preloaded catalog without origin-availability filtering or free product creation. Distinguish variant count from unit count. Do not confirm total-zero receipts.

- [x] **T08 — Receipt review separating available quantities from exceptions**
  - Depends on: T07.
  - Deliverable: one desktop exception-review representation.
  - Checks: available expected receipt is `min(actual, sent)` per expected variant; shortages stay unresolved with no automatic return/loss; excess and unexpected units are separate and not sale-available. Totals clearly distinguish received units, available units, exception units, and variants. Receipt is finalized once; reuse result-state treatment.

- [x] **T09 — Local-account login**
  - Depends on: shared visual rules.
  - Deliverable: one desktop login view.
  - Checks: **Usuario**/**Contraseña** only; no OAuth/SSO/public registration, fake credentials, demo/version labels. Accounts have one assigned location. Three test accounts remain private test data. No approved login screen is recorded in current context; inspect existing artifacts before generating a duplicate.

### Warehouse mobile — four workflow groups, not four screenshots

Branches remain desktop-only. Do not introduce native apps, offline behavior, scanning, or new business operations.

- [x] **T10 — Warehouse inventory on mobile**
  - Depends on: approved desktop inventory reference `0de7519c7e744fe3a65c4a422dc1afdc`.
  - Estimate: 1–2 representative screens.
  - Checks: essential existing inventory information/actions accessible, quantities and variants legible, no horizontal crop; existing controls/dialogs responsive without new inventory flows.

- [x] **T11 — Warehouse transfer listing and action detail on mobile**
  - Depends on: T05 and approved warehouse listing/approval/dispatch references.
  - Estimate: 2–3 representative screens.
  - Checks: preserve listing and actor-specific approval/dispatch access; incoming A → Almacén approval does not grant destination dispatch; warehouse-origin transfers still allow warehouse dispatch. Statuses, counters, history, and permissions match desktop. Controls remain accessible with long content.

- [x] **T12 — Warehouse direct creation, catalog/cart, and review on mobile**
  - Depends on: approved direct-create and review references.
  - Estimate: 2–3 representative screens.
  - Checks: catalog selection, quantity changes, cart and review all usable; no core creation action omitted. Reused modals responsive. Preserve direct warehouse creation/reservation rules, not branch-send approval semantics.

- [x] **T13 — Warehouse receipt capture and review on mobile**
  - Depends on: T07, T08 and ordinary receipt references.
  - Estimate: approximately two representative screens.
  - Checks: capture/review actual ordinary and exception quantities, available-versus-unresolved separation, single receipt, total-zero block, no horizontal crop or obscured final action. Receiving actor is warehouse only for incoming transfers. Reuse confirmations responsively.

### Final review

- [x] **T14 — Consistency and completeness audit (renewed closure; static design only)**
  - Depends on: T01–T13.
  - Deliverable: renewed read-only review through [C13](mockup-counter-copy-corrections.md#checklist--all-pending), after twelve verified counter/copy replacements, plus human acceptance `2825`; no cleanup/deletion. Historical audit completion is retained below; current closure is static design only.
  - Checks: exact official IDs and screenshot/HTML evidence for every new deliverable; actor/route/permissions/status/counters/quantities/reservation arithmetic/palette/typography/clipping consistent. All warehouse mobile core actions covered. Unresolved decisions explicit. Corrections stay within their originating task; reopen invalidated work with a reason. Preserve sources and predecessors.

## Open decisions and limits

- HISTORICAL listing limitation: earlier `list_screens` returned 53 screens and omitted later T06/T07/T08, which direct get resolved. Current native projection is root93instances/92refs/list80/hidden12; all13 new resources are omitted despite direct-get availability (twelve verified selected replacements + one retained unofficial failed candidate). Cause remains unknown; human acceptance2825 waives visibility as delivery blocker, not proof of canvas/UI visibility. All105 known resources remain KEEP, including twelve superseded sources and failed `718b6345b1fc44e4ba757f8748a9011a`. Historical39 candidate classification is NOT deletion permission. Future backup scope and exact-list confirmation are separate decisions; no durable backup or cleanup authorized.

- Mobile provider export limitation observed: MOBILE was requested, but Stitch returned a wide DESKTOP-classified canvas containing fluid `max-width:390px` phone-column HTML. Static phone-layout presentation and complete HTML are verified; native MOBILE classification and a real 390×844 CSS-viewport render are NOT claimed. No Chromium/Firefox/Playwright/Puppeteer/Selenium is installed; no installation or environment changes were made. Real responsive browser/scroll checks remain implementation-stage work under the original scope.
- Self-contained new fixture: TR-013 is creator/origin A → approver/receiver Almacén, TOYO L4 + CAR R2 (35Ah). A stock before approval10/2/8 and8/1/7; approved10/6/4 and8/3/5 (own held4/2,other held2/1); after dispatch6/2/4 and6/1/5. A required actions3 →4 on approval →3 on dispatch. Warehouse background TR-014 is direct Almacén → B, CAR L2 + CAR R1, created after TR-013; its own held2/1 is included in warehouse total reservations6/2. HISTORICAL warehouse actions2→1→2→1 omitted TR-003; superseded, not current. Current warehouse actions3→2→3→2 include existing pending-dispatch TR-003 throughout. Accepted design allocation for TR-003 background10 is TOYO L5 + CAR L4 + CAR R1 (not server-observed breakdown); TR-014 owns CAR L2 + CAR R1 =3, combined13 reserved. These are representative static scenario alternatives, not executed operations or one live database snapshot.
- TR-013 receipt fixture: expected TOYO L4 actual3 (shortage1), CAR R2 actual3 (excess1), unexpected TOYO R2; received8units/3variants, available5units/2variants, received exceptions3units/2variants, shortage1unit/1variant separately. Warehouse balances before receipt TOYO L20/5/15,R12/0/12,CAR L6/6/0,R10/2/8; afterward TOYO L23/5/18,CAR R12/2/10,other variants unchanged. Excess/unexpected remain separate and unavailable.

- Whether a receipt with only unexpected units and zero expected units received may be finalized is not explicitly settled. Do not decide it implicitly. T07–T08 use positive expected arrivals; keep the edge case explicit for a focused product decision before implementation.
- Separation/resolution of shortages, excess and unexpected variants remains outside the initial version. These mockups record exceptions, not a resolution workflow.
- Proposed mobile screenshot counts remain estimates. Confirm an economical representation within existing business scope before each group.
- Actual interaction/scroll behavior, transactional races, password/session security, and responsive browser checks are implementation-stage verification, not claims proven by static exports.

## Evidence ledger

**HISTORICAL T01–T13 ledger:** original official IDs, PASS checks and bad-counter counterevidence are preserved unchanged below, not asserted as current selected counts. Current selection is in the correction document and the replacement mapping below. Current TR-013 warehouse actions are 3→2→3→2; original badge2/badge1 observations remain historical superseded evidence.

On each transition, update this file first, mirror its full contents in Engram, read back both, and synchronize the visible todo projection. All verification is static; browser interaction, long-scroll execution and transactional tests remain deferred to authorized implementation.

| Task | Status | Official screen IDs | Artifact checks | Corrections / blockers |
| --- | --- | --- | --- | --- |
| T01 | done | `3221af6d1268400dbce090e51f105a7c` | Actual screenshot + complete HTML passed via verifier muwcpcgu-4-0oxq; parent screenshot spot check; correct B→A/35Ah/5+3/badge1/history/consumed reserve/availability4+1/permissions/palette/hover | Preserved baseline `bdb9dd9acf9948f983208c6530de6848`, predecessors `7256b98a176e4519b1fdf040b1b72583`, `353286c4e4d546629bbab95fc2b79d9c`; Ayuda and hover corrected; functional checks deferred |
| T02 | done | `d2ceb9080266461f8dbd57510121e65e` | Actual screenshot + full HTML PASS; active A/B→A/35Ah/5+3/badge3/Registrar recepción/history/permissions/palette/hover; parent reviewed verifier result | Reference3221af6d1268400dbce090e51f105a7c preserved; metadata title still B, noncritical visible-role checks passed; correct document title during implementation; functional checks deferred |
| T03 | done | `4efc50dcfaf847819619e71c53f82a86` | Screenshot/full HTML PASS; A→Almacén/35Ah/4+2/6units2variants/badge3/sourceavailability8+7/catalog10+25+50/editablecart/14pxapprovalnotice/hover; parent reviewed verdict | Source62762677118c48e9bf6441a1758d9213 and failedpredecessor22cf16b173f14d84aba2d788ac6e2b81 preserved; removedprematurestatus; nonvisiblecommentbadge2≠visible3; interactivechecksdeferred |
| T04 | done | `7db777ac302b4e448632bfe4862beb0d` | Screenshot/fullHTML PASS; readonly4+2/35Ah/6units2variants/A→Almacén/badge3/approvalneeded/noID/noreserve/nodispatch/editback/hover | Reference4efc50dcfaf847819619e71c53f82a86 preserved; nonvisibleoldformtitle/commentbadge2; runtimefocus/backcart/submission deferred |
| T05 | done | `670f6bb4df214f489fcfb9518bcbac30` | Original2560×2048screenshot/fullHTML PASS afterscope-aware reassessment; activeAlmacén/A→Almacén/4+2/35Ah/6units2variants/badge2/zeroheld/source8+7/reserveatA/approve+reject | Referencef5bc8e4bfd354f1fb41330f81d8139ff preserved; falsemodel/fixture/hovertoken findings withdrawn; historybelowviewportregularverticalscrollnottruncation; commentbadge3≠actual2; livechecksdeferred |
| T06 | done | `69624d6a9cee42c3a4fe76c9688fcc1a` | Originalscreenshot/fullHTML PASS afterT14reopen; allwarehouse/destination/approver/historylabelsAlmacén; allstock10+6+4/8+3+5,ownheld4+2vs9,badge4,14px,status/actions/atomicavailability4+5regressionspassed | Preservedsource488e1a4eb0894ebc8e876ad435d16355,predecessors9b77b361b298427192e2a6afd37ca869,34802cdb7d4249c5b8032c3dd25d3a9d,invalidatedcedfb6fe9ea74237b2931005655f86dc,partialpatchb6994b97582c46dc8958f30e5fdb0537; canonical-nameauditfix; runtimechecksdeferred |
| T07 | done | `a5b3f06050574b8a9c8d92077fdbe719` | Originalscreenshot/fullHTML PASS; everyvisiblewarehouseAlmacén; correct5columncapture4→3/2→3/unexpected2,8received3var/5available2var/3receivedexceptions2var/1shortage1var/nativecatalog/minone/singlefinal/noinventoryJS | Preservedsource0f8d0a838e734b0f8cb1e0c6de032a69,predecessorsf0825e475eff49999aaed7562abb9867,e4ac22a33058435cbe238af29eba08ef,cbfe25d9d33944dea7a5032ad0c09f4a,invalidatedoldofficial7ec50ac175a24ae6bc5fc7e121b2e407; canonicalnameauditfix/runtimechecksdeferred |
| T08 | done | `49a63016a53741f38c97e1bdf9bcfeb5` | Originalscreenshot/fullHTML PASS; allvisiblelocationAlmacén; exactreadonlymin3+2=5,received8/3var available5/2var exceptions3/2var shortage1/1var,currenttransit/badge2/futureconditionalreceiveddifferences/singlefinal/noreopen/noreturnloss/nonsaleexception | Preservedpredecessors2d153f909da447f49076840211624844,94404463da584de4be1171c63d2307f9,invalidatedoldofficialff64868f7c6741409120551ace3a8ab1; canonical-nameT14fix; actualcorrection/back/confirmation/inventorytestsdeferred |
| T09 | done | `2b52b360d7fc4d6c87a79b7980266280` | Originalscreenshot/fullHTML PASS; inspected53projectscreenmetadatatitlesbeforegeneration,noexistinglogincandidates; emptyUsuario/Contraseña,passwordmasked,Iniciar sesión,fixedlocation,noexternal/publicauth/noexposedcredentials | Freshnewscreen,allpriorartifactsretained; noauthbackend/servercalls; actualpasswordvisibility/submission/sessionsecuritychecksdeferred |
| T10 | done | `9ed771e37b354a8f8cd63a212b84aefb` | Screenshot/fullHTML PASS; phone-widthmax390CSS,all4balances/controlselectors/search/brandpolarity/paging10+25+50/badge2/readableL+R; AlmacénCentralremoved | Preservedsource0de7519c7e744fe3a65c4a422dc1afdc,candidates8261bcb603634add810789c503607b9e,b695830920444901a13e9c7b7db6fb8b,53d375808081448cb18abe74748b312c; nativewideDESKTOPcanvasphonecolumnNOTlive390×844render; browserunavailable/noinstall; actualresponsivechecksdeferred |
| T11 | done | `66edd8f657bf480ab0782c4ef8482623`, `28ff08916a774bd8ad5a9dbed07b46c2`, `668c9b0c0a7440e8a93ec4cd08503585` | 3/3 originalscreenshot/fullHTML PASS; listlocalTR013+014/badge2; incoming13approveonlysourceAreserve6; direct14badge1/CARL2R1/validownhold2+1withunreserved0+8/enabledatomicdispatch/predispatchcreatorcancel | Preservedfailedlista6a7d8b8cbb34e8081e13ee78425ba4c,approvalc16b24b869334868a6e10c5fe47cff4d; realphonebrowser/modal/scroll/runtimepermission/transactionchecksdeferred,wideexportlimitationrecorded |
| T12 | done | `430b0f1a965444b79f5aef9c9ca9b52d`, `cf8321dd651c47198b2364b505d2260a` | 2/2 originalscreenshot/fullHTML PASS; phone-widthcatalogsearchfilters/paging/add/selectedcartqty±remove/noID/W→BTOYOR2available12/badge1/directwhole-reserve2atcreate/noapproval/dispatchlater/immutableaftercreate/readonlyreviewback | Preserved2d39623efb974cd1b2a13569f89cac4eand9c4195d2ef85417cbb359b66fa82633b; noactualpreviewcreation/reservationexecuted; phoneviewport/selectionpersistence/responsiveconfirmmodalchecksdeferred |
| T13 | done | `0a0ff9a618694a93b0c073c85b71131f`, `3b0f68d6fabd42c3b167d1cf38e2e3ac` | 2/2 actualscreenshot/fullHTML PASS; captureall3nativeqty/catalog/noavailabilityfilter; reviewreadonlymin3+2=5,received8/3var,available5/2var,exceptions3/2var,shortage1/1var; badge2/currenttransit/futureRecibida con diferencias/singlefinal/minone/noresolution; navFLOWunobscured | Preserved4f8db4ed84854787bb8df1984c33c6fd,4a5017f7e44049a59679f10f0a033cbf,ba39378688a04fd4b20ce745f2879d39; nativephone-widthcapture780andwidereviewexport; flowfooterstaticONLY/notpersistentnav; actual390browser/backquantitypreservation/confirmation/stocksecuritytestsdeferred |
| T14 | done — static design only (historical PASS retained) | No new screen in historical audit; all 17 original official IDs in T01–T13 retained | Historical final read-only audit PASS: 17 HTML/PNG pairs, 9 desktop + 8 mobile (1/3/2/2); all visible warehouse aliases canonical; actor/route/state/counters/stock/own-reservation/math/action-entry coverage checked; 3 corrected screenshots/full HTML rechecked | First audit reopened T06–T08 for Almacén Central; corrected IDs now official and predecessors preserved. Renewed closure: C01–C12 full PNG/full HTML PASS; C13 STATIC_SCOPE PASS / REGISTRY_COVERAGE PASS, final17 completeHTML + five untouched fullPNGs/fresh10sourcefiles byte-identical; human acceptance2825. C14 accepted unresolved visibility disposition, not fixed. Static/mobile export/runtime/product-decision limits remain explicit; definitive static selection only, no cleanup or production readiness |

For each completed work unit record: role/state, project/screen ID, screenshot inspected, exported HTML inspected (including truncation continuation when needed), reference/predecessor IDs, passed checks, failed/skipped/pending checks, corrections, and parent verification. Do not mark done on provider success prose alone.

## Retained source → selected replacement mapping

All twelve sources remain KEEP. Historical T01–T13 ledger IDs above are unchanged. The [definitive 48-ID ledger](mockup-counter-copy-corrections.md#definitive-static-design-selection--48-unique-ids) is authoritative; replacements are independently verified and direct-get available, not proven canvas-visible.

| Unit / role | Retained source | Selected replacement |
| --- | --- | --- |
| C01 / T03 form | `4efc50dcfaf847819619e71c53f82a86` | `5f1376d04fd44108b7026a668676baf8` |
| C02 / T04 review | `7db777ac302b4e448632bfe4862beb0d` | `6cacdcff316c4320aed50c95c1849378` |
| C03 / T05 approval | `670f6bb4df214f489fcfb9518bcbac30` | `d5e3220eae8445d5b43d358cf96331b9` |
| C04 / T07 capture | `a5b3f06050574b8a9c8d92077fdbe719` | `29c4c04f8ddf414780f8775ae824c18b` |
| C05 / T08 review | `49a63016a53741f38c97e1bdf9bcfeb5` | `b599f12e26f34c1fbb3f38ad2444d30f` |
| C06 / T11 list | `66edd8f657bf480ab0782c4ef8482623` | `0a33f367884e49d7b229939de832c035` |
| C07 / T11 approval | `28ff08916a774bd8ad5a9dbed07b46c2` | `e5a074beb12a4d1489c622eb5cd64e6f` |
| C08 / T11 dispatch | `668c9b0c0a7440e8a93ec4cd08503585` | `d1fac98c42294864820bde35c1018a0c` |
| C09 / T12 cart | `430b0f1a965444b79f5aef9c9ca9b52d` | `2d3276204f3d4aa384c1bfd9beec4fcc` |
| C10 / T12 review | `cf8321dd651c47198b2364b505d2260a` | `85c329f646444712b0237ea58370162c` |
| C11 / T13 capture | `0a0ff9a618694a93b0c073c85b71131f` | `eb06b4122b4f49b4a036ee61a44da71a` |
| C12 / T13 review | `3b0f68d6fabd42c3b167d1cf38e2e3ac` | `a25c61ecac454416a6c5c830004eae24` |

Known nonvisible old-count comments in C08/C09/C10/C12 remain limitations, not silently fixed. Agotado remains outside authorization; unexpected-only receipt decision, live390px behavior, authentication security and atomicity remain unresolved/unverified. No actual application TDD, commits, native review authority approval, UI visibility, durable backup or deletion consent is claimed. Explicit **No Git**.

## Closure and next step

- **T01–T14 and C01–C14 done for static design only**, under acceptance2825. The ledger retains 17 original official representative IDs and historical PASS evidence; all predecessors remain protected. Current definitive selection and accepted unresolved visibility disposition are recorded in [mockup-counter-copy-corrections.md](mockup-counter-copy-corrections.md).
- Parent must synchronize full mirrors2776/2679, perform full readbacks, update todo and run independent structural verification before final delivery. Restore this complete checklist rather than restarting T01.
- Static screenshots/full HTML and two read-only consistency audits are the observed verification record. Browser/build/application RED/GREEN checks were not applicable or available and are not claimed.
- Before application implementation: settle the unexpected-only receipt decision; verify real mobile viewports, scrolling/persistent navigation, responsive confirmations, focus/back/selection preservation, atomic inventory/race behavior, and password/session security. Git/application setup requires separate authorization.
- Historical optional next-stage proposal was a read-only official-versus-superseded inventory and backup plan; it is not current authorization. Current authorization is passive reconciliation of these two existing task documents only. Future backup scope and exact-list confirmation require separate approval. No backup, deletion, cleanup, Git, installation or application work is authorized.

## Reopening audit — 2026-10-06

- Audit observations `2770`/`2742` found omitted warehouse action counters for existing pending-dispatch TR-003 and incorrect T03/T04 approval copy implying reservation/deduction at submission. This historically invalidated T14 closure, not the existence of historical PASS evidence or completed T01–T13 deliverables; renewed static closure is now accepted2825.
- Accepted fixture decision `2773` explicitly models TR-003 other holds; it does not claim a server-observed variant breakdown. The correction document records the replacement notice, warehouse action sequence 3→2→3→2, and twelve exact source IDs.
- HISTORICAL reopening affected only T14. All historical ledger checks, other thirteen completed statuses, seventeen original official IDs, references and predecessors remain preserved. Current closure follows twelve independently verified corrections; this journal does not rerun artifact checks.
- [C13 — final actual-artifact audit](mockup-counter-copy-corrections.md#checklist--all-pending) is now done on independent static scope/registry passes plus human acceptance2825. C01–C12 remain done; C14 done by accepted disposition, visibility unresolved/unverified, not fixed. Old T14 is done for static design only. All105 known artifacts remain KEEP.
- Parent confirmed mirror `2679` matches this file's pre-edit content exactly after removing only structured bookkeeping before the title and normalizing its final newline. Parent owns full updated mirrors/readback/todo synchronization before the first Stitch mutation.
