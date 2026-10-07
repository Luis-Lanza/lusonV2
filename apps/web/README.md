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
- Metadata supplies all locations and brands. Consultation never changes account assignment. Warehouse assignment ID1 uses page-local catalog cards below 768 CSS pixels; branch accounts keep the desktop table. Pagination counts variants, not cards. Transfer navigation and warehouse creation CTAs remain native disabled controls. Assigned branches may open the source/catalog/cart workspace described below.
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

## R04b2b branch creation workspace (review/send not implemented)

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

**Revisar solicitud is disabled**, with an explicit next-stage explanation. This
unit does not call reviewCart, generate retry keys, POST, assign references, show
success, submit via useTransfers or implement participant list/detail views.
R04b2c review/send and R04c views remain pending, as does independent R05 acceptance.
Component tests and App integration mocks establish deterministic behavior only.

Focused checks from repository root:

```sh
npm --prefix apps/web run test -- src/TransferCreation.test.tsx src/App.test.tsx
npm --prefix apps/web run test -- src/TransferCreation.test.tsx src/App.test.tsx -t 'R04b2b'
```

The title filter excludes historical cases; it is not a full-suite skip claim.

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
