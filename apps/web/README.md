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
- Metadata supplies all locations and brands. Consultation never changes account assignment. Warehouse assignment ID1 uses page-local catalog cards below 768 CSS pixels; branch accounts keep the desktop table. Pagination counts variants, not cards. Transfer navigation and CTAs are native disabled controls without handlers.
- `lossless-json` 4.3.1 is intentional: default parse produces `LosslessNumber`; raw `toString()` tokens become bounded nonnegative int64 bigint quantities and canonical positive decimal capacity text. Only checked bounded IDs/pages/counts become Number. Server availability is displayed, not recomputed. Zero availability is `Sin disponible`, with no low-stock threshold.
- Search is literal brand/model text, bounded to 128 UTF-8 bytes. Empty filters are omitted; brand and L/R filters combine with search. Page sizes are 10/25/50.

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
