# Luson frontend — login and read-only inventory

Spanish read-only inventory UI for the Go API. L05 serves compiled assets through
Go and deploys exactly app/db with Compose. Independent local fictional
HTTPS/browser/persistence acceptance is **PASS**, not operational deployment.

## Current verification status

Verifier `muxiytmn-2n-of93` passed all seven commands: 107 frontend tests with no
skips, Go webui/config and three CLI packages, vet, typecheck, build and the real
Compose runtime. Private NSS trust required no host installation or TLS bypass.
Nine hidden PTY inputs provisioned TEST accounts; all nine account/location
combinations, warehouse390px, desktop1280px, filters and pagination passed.
The same volume and cookie/session survived app/db recreation with stock and
checksums preserved; bootstrap replay refusal and expiry passed.

Catalog metadata is real and Excel-derived; only trial opening stock is fictional.
The parent cleaned owned test resources and retired the manifest. Any rerun needs
a newly authorized fixture. See [L05 acceptance and history](../../docs/l05-checks.md).
Real stock, operator provisioning/certificates, hosting/network rollout and
backups remain out of scope; no pixel-perfect claim is made.

## Application contract

- All production requests use relative `/api` paths and same-origin browser cookies. There are no demo accounts, frontend inventory fixtures, storage tokens or external font/CDN requests.
- Session restoration is a GET. Login is an explicit form-submit POST with exactly `username` and `password`, JSON content type and memory-only CSRF. The browser supplies Origin. Password input clears on submission. Logout is successful only on 204, followed by anonymous CSRF restoration.
- A current 401 clears protected identity, metadata and rows before refreshing the session and focusing login. Request/auth generations reject obsolete successes and errors, including transports that ignore AbortSignal. Filter changes cancel pending reads and reset page atomically without moving keyboard focus.
- Metadata supplies all locations and brands. Consultation never changes account assignment. Warehouse assignment ID1 uses page-local catalog cards below 768 CSS pixels; branch accounts keep the desktop table. Pagination counts variants, not cards. Transfer navigation is available to all assigned participants; warehouse creation stays disabled. Assigned branches use the same Transfers-owned creation form from the Inventory shortcut or the Transfers list CTA. Creation/recovery use Transfers navigation, header and main semantics; back, confirmed discard and confirmed-review return always go to Transfers, regardless of entry point. Inventory consultation and its query remain unchanged.
- `lossless-json` 4.3.1 is intentional: default parse produces `LosslessNumber`; raw `toString()` tokens become bounded nonnegative int64 bigint quantities and canonical positive decimal capacity text. Only checked bounded IDs/pages/counts become Number. Server availability is displayed, not recomputed. Zero availability is `Sin disponible`, with no low-stock threshold.
- Search is literal brand/model text, bounded to 128 UTF-8 bytes. Empty filters are omitted; brand and L/R filters combine with search. Page sizes are 10/25/50.

## R04b2a source-stock invalidation seam

`useInventory` exposes stable `subscribeSourceInventoryInvalidation(listener): unsubscribe`
with empty, void-only signals on authorized `inventory` and `resync` events.
It is independent of private `subscribeTransferInvalidation`: `transfers` never
signals source stock. Existing viewer refresh and private transfer routing remain intact.
Each controller owns both subscriber sets and one EventSource; registration performs
no source GET, metadata GET or fetch. `SourceInventoryController` is a separate
structural consumer type; existing `TransferController` objects need no new method.
Listeners bind to the authority epoch, not the consulted inventory location or a
physical source ID. All three assigned account locations may receive inventory signals.
Delivery checks current readiness, epoch and membership per callback, isolates thrown
errors without logging, and clears owned subscribers on unmount. Unready registration
is accepted like the transfer channel, but consumers must re-subscribe for each ready
authority epoch and unsubscribe on cleanup; consult `getTransferAuthority()` before reads.
Future source consumers own explicit manual opening and passive background reads,
latest epoch/source/sequence and abort guards. This seam loads no catalog and implements
no creation UI; cross-page stock is not atomic and server creation remains final authority.
R04 screens and R05 browser verification remain pending.

## R03 frontend invalidation adapter

`useRealtime({ enabled, epoch, resync, inventory, transfers?, error })` owns one
same-origin `EventSource('/api/events')` for authenticated, non-busy authority.
It returns an immediate stop function for mutation attempts. Latest callbacks
are held in refs; filter/search/location/page changes never replace the source.
Epoch, active-instance and disposed guards reject obsolete stream callbacks.
Only the three named events with bounded JSON empty-object payloads are accepted.
`transfers` is a typed callback seam for future participant readers, not a stock
refresh, transfer fetch, counter, cart or operative transfer screen.

`open` is not snapshot readiness. A subscription's `resync` requests fresh metadata
and inventory, including after recovery; initial data is provisional. Inventory
invalidations preserve consultation, filters, page/size, assigned actor, keyboard
focus and exact bigint quantities. The current read records dirty invalidations
and requests one follow-up after settlement; events during that follow-up can
mark it dirty again. This bounded queue neither discards in-flight invalidations
nor aborts/refetches on every burst. Manual query changes still abort obsolete
reads, and auth/read generations protect against stale successes and 401s.

Bootstrap and initial/event snapshots carry exactly one `X-Luson-Passive: 1`.
Explicit filters, pagination, size and manual inventory retry remain ordinary
GETs. The selector is merged with existing headers rather than replacing them.
Login/logout keep their original JSON/CSRF headers and never select passive mode.
All paths remain relative, cookies same-origin, cache no-store and CSRF memory-only.

An error coalesces into a five-second cookie-neutral `/api/auth/validate` probe,
not destructive `/api/auth/session` restoration. Settled native error bursts also
use a 1–30 second probe cooldown without a separate timer; resync resets it and
terminal CLOSED bypasses it so fatal failures cannot strand the source. Healthy same identity **and**
same CSRF preserve the Session object, query and snapshot. Changed identity or
CSRF invalidates old readers/source/protected state before assigned-authority
reconciliation. Anonymous validation clears protected state first, then a separate
passive bootstrap obtains anonymous CSRF (or reconciles an external-tab login).
Unavailable, network or malformed validation retains known state and announces
an error; it does not pretend the user logged out.

WHATWG EventSource keeps native retries while CONNECTING. A terminal CLOSED
source or constructor fault uses one exponential-backoff timer (1–30 seconds),
a fresh neutral validation and one new connection attempt. A new resync, not an
open event or healthy probe, refreshes snapshots. There is no snapshot polling or
permanent auth-poll fallback; unavailable validation permits a bounded transport
attempt, not actor renewal. Unsupported browsers keep manual consultation and
the existing Spanish error/retry surface. Cleanup cancels probes, retry/timeout
and expiry timers, sources and obsolete readers. Absolute expiry clears authority;
failed logout may reopen still-known authority, subject to server revalidation.

Cookie-writing bootstraps have a shared explicit settlement promise. Concurrent
restores coalesce; mutations stop realtime and invalidate generations before
awaiting this barrier and before any POST. A timed-out/aborted bootstrap is
uncertain and remains a fail-closed mutation/restore barrier for that mount;
a late mock response cannot make it safe. Reload/new bootstrap is needed after
that uncertainty. Abort and generation guards **cannot undo Set-Cookie headers**.
Neutral validation avoids automatic cookie-writing probes, but does not provide
global ordering against other tabs or other cookie-writing responses.

`R03 realtime lifecycle` and `R03 passive invalidation` use controllable EventSource,
deferred fetches and scoped fake timers. They prove client adapter behavior only,
not actual browser HTTP/MIME failure classification, cookie ordering, deployed SSE
or multi-account delivery. R05 real independent-browser verification remains
pending. The 107-test verifier result above is historical, not an R03 test count.
No App component, layout, domain parser, dependencies or transfer controls change.

Focused checks from repository root:

```sh
npm --prefix apps/web run test -- src/useRealtime.test.ts src/App.test.tsx
npm --prefix apps/web run test -- src/useRealtime.test.ts src/App.test.tsx -t 'R03'
```

The title filter excludes unmatched historical tests; it is not a full-suite skip
claim. Run the unfiltered package suite, typecheck and build below as well.

## R04a1 pure transfer contracts (not UI integration)

`transferModel.ts` decodes the API's flat Pending DTOs with ordinary JSON parsing:
IDs remain canonical positive int64 strings; quantities and private total counts
become bigint directly from strings. Numeric wire quantities/IDs/counts are
rejected. Each line is bounded to int64, but aggregate quantities are not.
Catalog capacities retain canonical exact decimal text (six whole/fractional
digits); UTC timestamp text retains nanosecond precision. Parsers reject unknown
fields, unsupported routes/status/kinds, duplicate variants, invalid references,
nullable arrays and inconsistent page counts/order. Trusted Go response DTOs
have unique keys; these parsers do not independently detect duplicate JSON keys.

`transferDirection(assignedLocation, flow)` provides branch-assignment guidance
for warehouse requests, other-branch requests and warehouse sends. Consultation
is not identity. Warehouse creation is refused; server cookies alone determine
actor authority. `canonicalTransferInput(input)` clones, sorts and freezes a
1–190-line attempt with string quantities and its caller-owned retry key.
`newTransferRetryKey(crypto?)` uses secure randomness only, on explicit new-attempt
calls. Never regenerate the key or mutate the payload when retrying a lost reply.

`createTransferAPI(fetch?)` exposes `list(query?, { signal?, passive? }?)`,
`detail(id, options?)` and `create(input, memoryCSRF, signal?)`. Reads admit only
page/page_size/pending status and capture passive mode per request; manual reads
are ordinary GETs. Relative paths, same-origin cookies and no-store are mandatory.
POST sends JSON/CSRF headers without passive mode or a manually supplied Origin.
Creation verifies a public record and distinguishes 201 creation from 200 replay.
Typed errors expose only status/known codes, never raw payloads or transport
messages; network/abort and malformed creation replies mark uncertain creation.
No automatic POST retry, session recovery, storage, stock calls or EventSource
exists here. Server-side foreign/missing detail failures remain identical 404s.

R04 model/API tests use authentic flat DTOs and injected fetch/crypto, not PG or
browser resources. The prior R03 full-suite result was 145 passing tests; it and
the 107-test history above are not new R04 run claims. Focused checks:

```sh
npm --prefix apps/web run test -- src/transferModel.test.ts src/transferAPI.test.ts
npm --prefix apps/web run test -- src/transferModel.test.ts src/transferAPI.test.ts -t 'R04'
```

At R04a1, hooks/epoch guards and single-stream callback integration were later
units; R04a2 below supplies these opt-in seams, not UI integration. Cart/review
and Pending screens remain later R04 work. R04 is not complete; real independent
browser transport and layout verification remain R05. No new UI copy or controls
are introduced by either adapter unit.

## R04a2 opt-in participant hook

`useTransfers({ controller, api?, listEnabled?, detailEnabled? })` uses the current
`useInventory()` controller. Both views default disabled, with no hidden private
count reads. It exposes `query`, `page`, `listBusy/listError`, `selectedID`,
`detail`, `detailBusy/detailError`, `changeQuery(patch)`, `selectDetail(id|null)`,
`retryList()` and `retryDetail()`. Query fields remain only page/page_size/pending;
IDs remain strings and quantities/counts bigint. Foreign/missing detail404 is the
same sanitized `not_found`; malformed or foreign snapshots expose no metrics.

Controller seams are `authorityEpoch`, `getTransferAuthority()`,
`subscribeTransferInvalidation(listener)` (returns detach) and
`settleUnauthorized(expectedEpoch)`. The epoch is ephemeral local cancellation
state, not a server revision/token. The getter checks readiness synchronously,
including logout attempts and changed authority before React effects settle.
Protected hook getters mask obsolete epoch/disabled data; generation/abort guards
also reject late data/errors from transports that ignore cancellation. Genuine
identity/CSRF changes reset query and selection; a failed logout retaining the
same authority preserves them while loading a fresh snapshot. Drafts stay caller-
owned: ordinary invalidations never mutate them, and future UI must clear them
on authority changes. Inventory consultation never reassigns transfer authority.

The controller owns the sole EventSource. Instance-local listeners receive
`resync` and `transfers`, not inventory-only events; subscriber exceptions are
isolated without logging payloads. Stable registration creates no extra source
or React callback-store loop. Each enabled list/detail lane captures query, epoch
and passive/manual mode. Initial/reactivation and push reads are passive; explicit
page/size/selection/retries are ordinary GETs. Bursts during reads mark one dirty
follow-up; a push racing a queued manual read cannot reclassify its headers.
Obsolete jobs are aborted and cannot carry dirty flags into newer selections.

`submit(input)` exposes `submitBusy/submitError` and a checked creation/replay
result, never an optimistic row. Only assigned branches may submit, with current
memory CSRF; attempts are cloned/frozen and never regenerated or automatically
retried. Network/abort uncertainty remains typed so the caller can retain the
same key/payload. Obsolete creation results cannot publish success. Stock409,
retry409 and CSRF403 do not log out the actor. Current401 uses shared, five-second
bounded neutral validation with current-epoch coalescing/cooldown. Healthy or
unavailable validation does not bootstrap; confirmed anonymity uses the existing
separate serialized bootstrap. Cancellation cannot undo browser Set-Cookie;
R03 cross-tab/cookie-writing uncertainty limits remain unchanged.

Tests inject fetch and a controllable single EventSource around both hooks; no
PG, actual browser transport, UI geometry or deployment is claimed. Prior full-
suite results of 107, 145 and 224 tests remain historical. R04 stays open for UI;
R05 actual independent-browser verification remains pending. Focused checks:

```sh
npm --prefix apps/web run test -- src/useTransfers.test.ts src/App.test.tsx src/useRealtime.test.ts
npm --prefix apps/web run test -- src/useTransfers.test.ts src/App.test.tsx src/useRealtime.test.ts -t 'R04'
```

The R04 title filter excludes historical/R03 titles; it is not full-suite skipping.

## R04b1 pure source catalog and cart foundation

`loadSourceInventory(physicalSource, { signal?, reason? }?, fetch?)` reads a complete
unfiltered catalog through the existing inventory path, pages50, at most four
pages/190 rows. Default/manual GETs are ordinary activity; explicit
`reason: 'passive'` captures exactly one `X-Luson-Passive: 1` per page. Source, signal and
reason are captured before awaiting. Cookies remain same-origin, cache no-store;
no auth probe, POST, metadata fetch, global revision or inventory mutation exists.
`SourceInventoryError` exposes sanitized code/status only, including current401,
cancellation, unavailable transport and malformed success; no private body leaks.

The unchanged lossless inventory decoder preserves numeric bigint wire tokens
and exact decimal Ah text. Its sealed catalog bounds are entry1–95/variant1–190,
separate from the190-row cap (INT32 storage is not a wider catalog contract).
Each response must match requested source/page/size, stable source descriptor and
count, exact page length and unique increasing IDs across pages. Any failure or
abort discards the whole read, never publishing partial rows. Consistent zero
counts are accepted without demo fill. Returned location/rows/items are copied
and frozen. `filterSourceInventory(catalog, { search?, brand?, polarity? })` filters
all rows locally: literal lowercased brand/model substring, exact brand and L/R;
no capacity/quantity matching, unsupported wire filters or pagination truncation.

This is **complete catalog membership, not atomic cross-page stock quantities**.
Each page has its own server snapshot; legitimate intervening stock changes are
accepted. The future controller retains the last full snapshot, captures authority
and generation, cancels obsolete reads and refetches on push/recovery. This helper
has no global browser cursor or listener. Server POST atomically checks all items
at physical origin. Pending/cart items neither reserve nor move stock.

`createTransferCart(getTransferAuthority(), flow, sourceCatalog)` binds a branch,
account and ephemeral epoch to the committed three-flow direction helper. It
stores no CSRF/session cookie. Warehouse is refused; consulted inventory never
sets actor/source. Source must match direction. `addCartItem` deliberately
increments an existing unique line; `setCartQuantity` accepts canonical positive
int64 string/bigint only. Both check actual catalog membership and advisory source
availability. `removeCartItem`/`clearTransferCart` are explicit, immutable actions;
flow/source changes require a new empty cart and future UI discard confirmation.
Every operation takes current authority; `cartStatus` returns neutral
`{ usable: false, ready: false, total: 0n, invalid: [] }` with a frozen empty array
on mismatch, before accessing private lines. Current-authority status retains
actual invalid IDs, readiness and an unbounded bigint total. Future UI must also
clear/mask direct obsolete cart views before rendering, not trust a saved actor.

`refreshCart` preserves flow, quantities and missing selected variants (null
availability); reduced guidance marks invalid IDs without silently losing drafts.
`reviewCart` creates a sorted/frozen canonical attempt only on explicit valid new
review, using secure RNG or a fresh caller key for each material revision.
Payload contains only kind, counterparty,
retry_key and quantity-string items. Material edits invalidate the attempt; no-op
edits/back-to-review and guidance-only refresh preserve its exact key/payload.
Existing uncertain attempts can be retried despite changed availability: the
server checks replay before stock. `cartStatus.ready` is new-draft guidance, NOT a
retry gate. A409 remains editable; no automatic retry/network call exists here.

Tests use injected raw numeric responses and pure controller authority, not
accounts, PG or browser resources. The prior258-test full suite and worker-only
66-focused/324-full results are historical, not independent approval. The status
privacy correction adds seven regression cases; post-fix worker checks pass73
focused/331 full tests, typecheck and build. Browser verification is not claimed.
R04 remains open for creation/cart/review and private views; R05 actual browser
transport/layout is still pending. Focused checks from repository root:

```sh
npm --prefix apps/web run test -- src/transferCart.test.ts src/sourceInventory.test.ts
npm --prefix apps/web run test -- src/transferCart.test.ts src/sourceInventory.test.ts -t 'R04'
```

## R04b2b branch creation workspace

`TransferCreation` reuses the existing authenticated shell; only assigned branches
can open it, irrespective of the consulted stock location. Back preserves the
inventory query. Warehouse mobile/desktop creation and private Transferencias
navigation remain disabled. The three physical routes are warehouse→actor,
other branch→actor and actor→warehouse; approval belongs to the counterparty.
The selected creation resources inform breadcrumb, route notice, five-column
catalog and side cart structure; there are no mockup people, counts or records.
Geometry, fonts and real keyboard/browser acceptance remain R05, not unit proof.

Opening and explicit retries read the complete source catalog with ordinary GETs;
stock/resync signals use passive GETs, one active flight and one dirty follow-up.
Manual supersession preserves queued work without changing captured request reason.
Epoch/account/assignment/source/sequence checks reject obsolete successes and401s,
even if a transport ignores abort. A synchronous latest-authority fence masks raw
rows, cart, quantities and errors before effects. Readiness suspension cancels reads
and detaches listeners; same-authority recovery retains selections but requires a
fresh full catalog before showing them. Current401 joins cookie-neutral settlement.
No additional EventSource, polling, viewer-query changes or source helper changes.

Search/brand/polarity filters apply locally to all190 possible variants; display
pagination uses25 rows. Quantities are canonical positive int64 text/bigint, with
unbounded bigint aggregate totals. Zero cart quantity explicitly removes a line.
Advisory refresh preserves selected quantities and missing/reduced-stock invalid
markers, never clamps or drops them. Background failure visibly retains stale full
guidance; initial failure shows sanitized retry without partial rows. Source changes
with lines require an accessible explicit discard dialog, including cancel/focus
restoration. No cart or Pending request reserves or moves inventory; cross-page
quantities are not atomic and server POST will remain final authority.

The original workspace did not send requests. R04b2c2 now adds explicit review
and manual submission below. Participant list/detail views and independent R05
acceptance remain pending. Component and App mocks are deterministic checks only.

Focused checks from repository root:

```sh
npm --prefix apps/web run test -- src/TransferCreation.test.tsx src/App.test.tsx
npm --prefix apps/web run test -- src/TransferCreation.test.tsx src/App.test.tsx -t 'R04b2b'
```

The title filter excludes historical cases; it is not a full-suite skip claim.

## R04b2c1 live-memory recovery foundation

`createTransferRecovery()` creates an instance-private archive, not a singleton.
App now instantiates it once above conditional auth/creation views;
real App unmount, reload or tab close destroys it. No persistent recovery exists.
Every read uses the latest controller authority: ready verified branch, exact
`account_id` and assigned `location.id`. Same owner after fresh login reads a
snapshot tagged with the current epoch, never the old session or CSRF token.
Capture requires an already reviewed canonical attempt and current owned cart.
Only frozen retry payload, physical direction and selected variant/catalog IDs,
brand, model, exact `capacity_ah`, polarity and quantity strings are retained.
No stocks, full catalog, credentials, sessions, cookies, logs or global reader.
Two owner slots coexist; exhaustion is generic and never evicts unresolved work.
Opaque entry handles and fresh per-begin flight tokens fence stale callbacks.
Manual begin changes ready/unknown to inFlight; unknown preserves exact key/body.
New-owner-epoch reads turn an old pending flight unknown, never automatically POST.
Confirmed current-epoch success clears only its live flight; explicit owner discard
refuses inFlight and requires uncertainty acknowledgement for unknown entries.
Retry performs no availability lookup. R04b2c2 wires this leaf to App/review;
R05 browser acceptance remains pending.

## R04b2c-hydration pure cart restoration (not recovery UI)

`restoreTransferCart(currentAuthority, validatedSourceCatalog, snapshot)` accepts
`CartRestoration`; the existing `RecoverySnapshot` is structurally compatible.
The caller **must** obtain it through `recovery.getCurrent(latestAuthorityGetter)`
for exact account/branch authorization. A snapshot has no account credential:
this helper cannot distinguish arbitrary same-branch foreign-account snapshots.
Ready branch/current epoch checks precede private payload reads. Routes, canonical
attempt membership/quantities and sealed descriptors must agree with current source.
Copies are frozen; selected descriptors contain no stock or credential references.
Every quantity and retry key survives, including insufficient or missing variants;
actual fresh availability or null supplies invalid guidance, never a clamp.
Refresh/no-op review preserves the attempt; material edits clear it and only explicit
new review generates a key. Prepare a valid restored cart **before** acknowledged
unknown-entry discard; without a catalog, retain the archive and allow exact retry.
The hydration unit itself adds no lifecycle or browser proof.

## R04b2c2 explicit review, manual submit and App lifetime

`TransferCreation` accepts `controller`, `metadata`, `onBack`, optional `loader`
and optional `recovery` (isolated leaf default only), plus optional guarded
`onDetail(id, ownerTag)` for a supported host. Actual App always supplies
its root-owned factory; A/B slots survive login/logout/auth-dependent unmounts.
Only latest ready exact account/branch sees its banner, frozen review or result.
Fresh same-owner epochs recover the cached route and exact attempt, not old auth.
No session, CSRF, stock catalog or credentials enter the archive or storage.

Explicit review securely freezes the canonical key/payload and descriptors.
Closing/reopening and advisory refresh preserve it; actual material edits invalidate
it. RNG failure sanitizes and blocks sending. Review is an accessible titled modal
with Escape, focus cycling and return focus; CSS follows the selected modal
structure, not measured pixel/font/browser proof. All three branch flows create
Pending with counterparty approval, without reservations or stock movement.

Only manual send begins a fresh opaque flight under a synchronous ref lock.
Existing useTransfers reads stay disabled; POST uses current CSRF. Actual parsed
201/200 results publish reference, string ID and exact UTC creation text only after
matching current-owner/epoch confirmation. No optimistic IDs, automatic retry,
private reads from creation/review, polling, additional EventSource or future action endpoints exist.
Failures keep the same attempt and sanitized code-specific guidance;403 is not
logout,401 uses existing neutral settlement and retry_conflict never rotates a key.

Sending blocks edits/source/back/close. Unknown edits require a real caution action;
restoration with a current complete catalog happens before acknowledged archive
discard. All quantities and missing/insufficient markers survive. Failed source
loading defers editing, but direct same-key manual retry remains available. Returning
to inventory can retain the attempt and query; reload/tab close destroys recovery.
Unit transport mocks exercise framing/status and lifecycle, not real browser cookie
ordering, deployed MIME, fonts/geometry, SSE, two services or PG stock invariance.
R04 and R05 remain open; no overall feature closure is claimed.

## R04c participant Pending list and detail

The shared `TransferPending` takes `controller`, minimal current `ownerTag`, optional
`initialDetail: { ownerTag, id }`, and `onInventory`. The internal tag contains only
epoch/account/assigned location; it is not an auth credential. Latest readiness and
owner checks precede DTO/error/ID/total reads and human handlers. Actual App routes
only in memory, with no URL IDs or storage. Authority changes mask obsolete routes;
an initial detail belonging to another owner is not read or requested.

Only the visible Pending pane enables the existing list lane; only a selected detail
enables its detail lane. Manual open/page/size/retry uses the hook's human methods;
transfer invalidation and resync passively refresh both enabled lanes through the one
existing EventSource. Hook abort/dirty-flight follow-up semantics remain unchanged.
Sizes are 10/25/50; size changes reset page one. Human page entry is bounded 1–1000000.
Next-page bounds compare exact bigint count with bigint page × size, never Number(count).
The header reports only validated participant `total_count`, not page length or role
aggregates. Loading/error/unready states do not invent zero; only an actual zero DTO
shows the empty state. Private and unknown 404s share a generic unavailable message,
without echoing the requested ID or an unvalidated reference.

Rows show real references, physical route, Pending, exact unit sums and static
required location. Detail preserves Ah/UTC strings, L/R labels, bigint quantities,
creator location and approver location. It reports no employee/history/stock metrics
and exposes no approval/rejection/cancellation/dispatch/reservation actions. Warehouse
cards follow the existing 390px shell; branches keep the desktop table regardless
of viewport or consulted inventory location. Geometry/font fidelity is not measured.

Sidebar/bottom navigation cannot leave active creation drafts or in-flight POSTs:
use the existing warned back action. Unknown attempts survive non-destructive Pending
navigation in the root archive. Back preserves the inventory controller query and
Pending detail-back preserves its page/size. Parsed 201/200 success can call optional
Review → Creation → App detail navigation only after latest owner/epoch checks;
standalone hosts without that callback retain the disabled future CTA. No extra POST
or private GET occurs until actual navigation.

RTL transport mocks verify these UI contracts, not deployed browser cookie ordering,
MIME delivery or real multi-account SSE. R05 still must observe natural cookie/current
actor/response-count authority binding in isolated owned contexts; no universal browser
privacy conclusion follows from mocked getters or participant fixtures. API/hooks and
backend authority protocols are unchanged by this UI unit. Two-service PG stock
invariance, real desktop/mobile layout and complete feature acceptance remain pending.

## D2 dispatch frontend — source candidate, verification pending

This section describes the dispatch candidate and supersedes the historical
Pending-only boundaries above. It is not deployed-browser acceptance. Full
Vitest, typecheck and a non-destructive build remain parent-owned checks; newly
added stale-session and shell-navigation tests have not been executed by the
source writer. Earlier focused RED/GREEN evidence does not establish that the
final candidate passes every check.

### Dispatch and current outcomes

Participant list/detail and original creation replay admit `in_transit` alongside
Pending, Approved and Rejected. Transfer IDs remain canonical int64 strings,
quantities remain bigint, and UTC timestamps retain their original nanosecond
text. Transit requires retained approval location/time plus origin-matching
`dispatch_location_id` and canonical `dispatched_at >= decided_at`; other states
reject dispatch metadata. Fractional timestamp ordering never uses rounded
JavaScript milliseconds. Immutable identity, items and approval metadata must
match the original attempt before a mutation or recovery result is confirmed.

Only the authenticated assigned physical origin may open dispatch confirmation
for an Approved request, including warehouse origins. A warehouse approving a
branch-to-warehouse send cannot dispatch it: the branch origin does that.
Consulted inventory location never grants authority. Dispatch is whole-request,
with strict `{}` POST to `/api/transfers/{id}/dispatch`, current memory CSRF,
same-origin cookies and no-store. There are no quantity overrides, new retry
keys, partial dispatch, cancellation or receipt controls. Approval retries may
return the current In-transit record; rejection conflict remains a sanitized409.

The UI does not require unreserved availability to cover an already approved
request's owned reservation. Confirmation explains that dispatch deducts the
same quantity from source physical stock and this request's reservation,
leaving unreserved availability and other holds unchanged. No destination stock
credit occurs. `En tránsito` details show sent quantities, consumed own reserve,
retained approval history and dispatch origin/time. Destination receipt is
pending, not a confirmed zero quantity. Original creation replay shows its real
current state, not a new Pending request. A cached approval must not hide newer
transit detail or confirmed dispatch.

### Explicit live-memory recovery

`useInventory` owns `createTransferDispatchRecovery()` above conditional panes;
`useTransfers` supplies `dispatch(original)`, `retryDispatch()` and
`recoverDispatch()`, with `dispatchAttempt` and sanitized `dispatchError`.
The recovery retains a frozen original record and approval metadata, not stock,
session objects, cookies or CSRF. Account, assigned location, auth epoch and
session generation fence every read and completion; opaque flights prevent an
old response from settling a replacement attempt. Reload/tab close/App unmount
loses this live memory. A replacement session does not inherit private recovery.

Network/abort, malformed replies and mismatched success are dispatch uncertainty,
never creation uncertainty. Uncertain POSTs are never automatically replayed by
rendering, navigation, inventory refresh or realtime. The recovery panel offers
an explicit ordinary GET of the original ID and a guarded retry of the same
whole-request dispatch. An Approved GET cannot prove the uncertain POST failed;
it leaves the original attempt unresolved. Only matching transit confirms it.
403/404 mask private recovery and remove the selected private outcome; obsolete
401 completions cannot reconcile replacement authority.

Confirmed POST or recovery GET independently refreshes fenced participant
list/detail/count subscribers and inventory/source subscribers, without requiring
an SSE event. A failed subscriber cannot block other lanes. Existing shell and
pane labels/counts remain **approval-only**: `Requieren tu aprobación` does not
count dispatch or receipt obligations. Workflow-wide counters belong to the
later receipt work, not D2.

### Styling and manual acceptance boundary

Dispatch reuses the existing decision confirmation backdrop/modal, focus trap,
focus restoration, busy dismissal guards, recovery panel, item table and
responsive footer. Only the shared grid selector is extended to the dispatch
wrapper so recovery and detail retain the existing14px separation. The bounded
modal keeps header/footer outside its central scrolling body for up to190 items;
no new layout system or dependency is introduced. jsdom assertions are not
measured browser geometry, keyboard acceptance or pixel fidelity.

Manual user checklist (not executed):

- Dispatch Approved warehouse→branch, branch→branch and branch→warehouse requests
  from their physical origins; verify destinations cannot dispatch them.
- Check full immutable quantities, retained approval and dispatch history, source
  existing/reserved deductions, unchanged unreserved availability/other holds,
  and no destination credit.
- Lose a dispatch response, navigate Inventory→Transfers, consult explicitly,
  then retry the same dispatch if still unresolved; ensure it never moves twice.
- Check `En tránsito` filtering/detail and original replay, pending receipt wording,
  focus cycling/restoration, busy dismissal and long-item scrolling.
- Confirm approval-only shell labels/counts remain unchanged in meaning and that
  replacement sessions reveal no previous private recovery.

Suggested focused verification from `apps/web`, for the parent/verifier:

```sh
npm test -- --run src/transferModel.test.ts src/transferAPI.test.ts src/transferDispatchRecovery.test.ts src/transferDecisionRecovery.test.ts
npm test -- --run src/useTransfers.test.ts src/TransferDispatch.test.tsx src/TransferCreation.test.tsx src/TransferPending.test.tsx src/TransferDetail.test.tsx src/TransferReview.test.tsx src/App.test.tsx
npm test
npm run typecheck
```

The parent also owns build verification using a fresh output and a non-destructive
build route. The default `npm run build` can empty `dist`; the source writer is
not authorized to generate/delete artifacts or mutate build configuration.
Receipt, workflow-wide counters and user manual acceptance remain pending.

## Worker checks

From repository root:

```sh
npm --prefix apps/web run test
npm --prefix apps/web run typecheck
npm --prefix apps/web run build
```

Vitest mocks are restricted to isolated component tests. Build assets, Vite/npm caches and dependency output stay inside this package and are ignored locally. See [the observed check record](docs/l04-checks.md).

## Historical L04 verifier: real browser fixture

This section records the earlier L04 runner, not the current L05 deployment entry.
Its binding is retired; do not execute the historical command without a newly
parent-authorized fixture. The source writer must **not** execute this runner.
A parent-delegated verifier with private external-runtime authorization used:

```sh
LUSON_TEST_NETWORK=luson-l04-test-isolated-44fea1f86fda LUSON_TEST_NETWORK_MANIFEST=/home/luis/velay/luson_v2/odd/evidence/login-inventory/l04-test-network.json node apps/web/e2e/run-real.mjs
```

Both bindings are mandatory. Relative descriptor paths resolve from the canonical repository root. The active descriptor and fresh Docker inspection must match the exact approved full network ID/name/four L04 labels, with an empty network immediately before the runner's own container creation. The runner never creates, removes or rewrites the parent network/descriptor.

The runner builds unchanged Go binaries offline into a private temporary directory; starts one owned PostgreSQL17.9 tmpfs container with a random loopback port/generated TEST password; waits for Go initialization; then supplies three generated TEST accounts through nine hidden, prompt-driven controlling-PTY inputs. Credentials travel by private IPC/0600 external files, never argv, browser storage or logs. No operational credentials are requested.

Vite binds a strict loopback port and proxies `/api` unchanged with `changeOrigin:false`. Playwright1.62.1 uses the approved cached Chrome151 executable, fresh contexts, one worker and no traces/video/screenshots. A sanitized reporter prints check titles/status only. Real specifications cover the nine account/location combinations, bad login/reload/logout, actual filters/paging, warehouse390×844 scrolling/cards/keyboard/disabled controls and branch1280×1024 tables. Geometry assertions use HTML CSS dimensions rather than the scaled desktop JPEG.

Before the zero-availability case, the runner proves all570 trial balances have zero reservations. It then changes exactly one balance in its own new TEST database to `reserved=existing>0`. The expiry specification changes only persisted sessions in that same private fixture. Neither uses API stock writes, operational data, transfers or fake browser routes.

Cleanup targets only owned process groups, private files and the exact full-ID/label-verified TEST container. It must prove the parent network remains exactly bound and empty. Failures return nonzero and receive no PASS credit. The former pending status is
historical: current L05 runtime, browser, PTY, persistence and cleanup acceptance
passed as summarized above. This L04 command is not a reusable fixture.
