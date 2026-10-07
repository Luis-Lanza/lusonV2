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
