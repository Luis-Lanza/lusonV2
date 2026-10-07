# Deliver local login and three-location inventory

Implement the first complete Luson vertical slice: private login/session/logout and read-only inventory for Almacén, Sucursal A and Sucursal B, backed by PostgreSQL and deployed locally through Docker Compose.

## Authorization and boundaries

- Explicit implementation authorization: observation2900. Core stack: React + Vite2883, Go2888, PostgreSQL2886, local Docker2896.
- Source files, project dependencies, Docker project images, isolated test containers and applicable tests are authorized. Human2929 subsequently authorized local Git metadata ONLY; commits, remotes, push/publication, system-tool installation, mockup deletion and unrelated file changes remain unauthorized.
- Workspace was intentionally non-Git during L01. Under2929, an empty local repository now exists on unborn `feature/login-inventory`, with no commits/staged files/remotes (2930). Local `.git/info/exclude` protects private backups/runtime secrets (2931). Review mode remains global OFF/clone-local unset; do not change it. Native assessment was unavailable for L01; assess subsequent candidates where possible and follow its plan, with independent high-risk fallback for unavailable/unassessable cases. No invented work-unit commits or native authority.
- Preserve `.atl/`, all105 Stitch resources, existing mockup/backup task documents and `backups/`. Reference only the definitive48-ID registry. Original XLSX remains outside the repository.
- Technical code/docs/tests use English; application UI uses Spanish. No SDD.
- One writer at a time. Parent owns this document, its full Engram mirror and visible todo.

## Architecture

React/Vite SPA → one modular Go HTTP API → central PostgreSQL. Only Go connects to the database. The Go deployment serves compiled frontend assets and API under one origin; PostgreSQL is the second deployment container. A temporary verification container is not another deployment service.

Supporting implementation choices: TypeScript, compiled Tailwind CSS, Go `net/http`, `pgx` and versioned SQL migrations. Keep dependencies purposeful; no SSR, microservices, Redis or queue. Go and TypeScript communicate through an explicit API contract, not directly shared types.

Authentication uses PostgreSQL-backed opaque sessions, securely hashed passwords, expiry/revocation, session renewal on login, protected cookies, CSRF/origin checks and login throttling. The server resolves assigned location from the account/session. A clearly bounded localhost HTTP development profile must not be presented as production HTTPS protection. Operational usernames/passwords are supplied privately through a bootstrap CLI, never invented, committed or logged. Tests use isolated generated credentials.

## Data contract

- Three logical locations in one database; three fixed accounts, each assigned to one location.
- Every account can consult all inventories without changing its assigned operating location.
- Excel source: `/tmp/marca modelo amperaje.xlsx`, sheet `baae de datos`; raw95 catalog entries/11 brands after excluding6 repeated header triplets. Preserve brand/model spelling, underscores, commas and spaces.
- Capacity is positive decimal Ah, including6.5; physical quantities are nonnegative integers. All95 entries produce explicit L/R variants:190 variants and570 location/variant balances. Never infer polarity from model suffixes or invent voltage/technology.
- Fictional deterministic opening quantities are authorized for trials (2510), not asserted real operational quantities. Reserved starts0 because this slice creates no transfer-owned holds. Available = existing − reserved.
- Initialization is transactional and repeat-safe; never overwrite existing balances/accounts or reseed on every restart. PostgreSQL uses a persistent named volume; it is not a backup.
- No public registration/OAuth/SSO, catalog CRUD, manual stock adjustment, transfer creation/approval/cancellation/dispatch/receipt or offline synchronization.

## Visual and intermediate scope

Reference files under `backups/stitch/luson-6509355458249521776/capture-2840/payload/screens/`:

| View | Definitive ID |
| --- | --- |
| Login | `2b52b360d7fc4d6c87a79b7980266280` |
| Desktop inventory | `0de7519c7e744fe3a65c4a422dc1afdc` |
| Warehouse mobile inventory | `9ed771e37b354a8f8cd63a212b84aefb` |

Use Inter, wine `#7A1F3D`, hover `#5B162D`, tint `#F5E8ED`, background `#F8F6F4`, white surfaces, borders `#DED7DA`, primary text `#242124`, secondary `#6B6267`. Preserve desktop sidebar/table and mobile cards/navigation layouts. A shared responsive breakpoint is an implementation choice because source screenshots are separate layouts; verify actual390px behavior and do not suppress zoom.

For this explicitly read-only intermediate milestone, retain existing Transferencias/navigation and transfer CTAs as genuinely disabled accessible controls; no fake handler, fabricated pending badge, invented stub transfer page, demo/version label or new explanatory widget. Minimally replace operation-enabled wording in existing slots with truthful consultation wording. This is application behavior, not a modification of the retained Stitch mockups. Future transfer slices enable those same entry points.

## Checklist

- [x] **L01 — Establish durable three-location catalog and balances:** Go module/data foundation, transactional migrations, exact95-entry catalog/190 variants/570 balances, deterministic zero-reservation trial stock, repeat-safe initialization and real-PostgreSQL tests.
- [x] **L02 — Authenticate assigned-location accounts:** private three-account bootstrap, secure password/session lifecycle, login/current-session/logout API, CSRF/throttling, unit and PostgreSQL integration tests, setup/security docs.
- [x] **L03 — Expose authenticated inventory consultation:** all three locations, combined search/brand/polarity filters, stable variant pagination10/25/50, computed availability, validation/errors, API contract and integration tests.
- [x] **L04 — Integrate faithful Spanish React screens:** real login/session identity/logout, independent consultation location, desktop table/mobile cards, filters/pagination, loading/error/expiry and stale-request protection; component and visual checks.
- [x] **L05 — Deploy and verify the local vertical end to end:** two-service Docker Compose/multistage image, persistent initialization, private bootstrap/configuration, real browser checks for three accounts/locations, desktop/mobile390px and restart persistence, final docs.

## L02 correction and focused coverage plan

Initial independent verification returned PARTIAL, not approval. Correction worker muxc1yxq-25-kqaw completed:all nine endpoint cases actually RED (anonymous200/login200 mutation/logout204) then GREEN; identical/differing/reversed ambiguity now rejected before fallback/mutation. Focused isolated limiter/recreated-expiry/positive trusted runtime TLS coverage passed self-checks; coverage-only additions claim no separate RED. Four Go files plus check evidence changed, no SQL/dependencies/private CLI/foundation/README/Git/RDD changes. Fresh ASSESS remains unassessable (untracked declaration required), so the returned high-risk independent plan is followed. Re-verifier muxca872-26-7fxa independently confirmed all four checks (PASS2950); L02 complete. Its dedicated test network is retired after exact empty-owner cleanup; old command examples below are historical and require a fresh explicit parent-provisioned binding for replay. Prior independent private TTY PASS carries forward only for unchanged CLI. These checks must be observed before L02 closure:

- [x] Add actual endpoint-level RED → GREEN for duplicate session cookies (identical/differing/reversed ordering with valid prelogin CSRF). Reject ambiguous requests without anonymous/prelogin fallback, false204 logout or a new login session; never choose/revoke arbitrary cookie tokens. Verify persisted state remains unchanged after rejected requests and ordinary single-cookie revocation still works.
- [x] Isolate IP, username and global throttling dimensions so exhaustion of one does not mask another; use deterministic clocks and independent fixture state.
- [x] Prove persisted expired sessions remain invalid after fresh service/handler recreation.
- [x] Exercise positive real TLS transport with an ephemeral trusted certificate and actual runtime TLS path, not only missing-certificate rejection. Browser/real operational HTTPS remain later acceptance.

Keep correction surfaces limited to existing HTTP auth/source tests, existing server startup/source tests (minimal testability factoring only if necessary), the authentication check evidence and minimal README clarification. No changes to session SQL, password rules, schema001/002, catalog, fixture, stock, dependencies or private CLI without a separately derived and justified scope. Do not repeat the unexecuted temporary overlay probe as a PASS; the repository regression supplies actual behavioral reproduction instead. Advisory correction size roughly200–350 authored lines, not a hard cap; report material expansion before extra areas. No other feature implementation while L02 is partial.

## L02 exact parent execution plan

These project-dependency and test commands are within existing human2900 authorization, not a new human grant. They may be repeated for observed RED/GREEN and refactoring from repository root. All new PostgreSQL authentication tests must use the exclusive L02 network; the existing L01 regression exception remains separately scoped.

```sh
cd apps/api && go get golang.org/x/term@v0.31.0
cd apps/api && go mod tidy
cd apps/api && LUSON_TEST_NETWORK=luson-l02-test-isolated-a04e86dcb9ac go test ./internal/auth ./internal/httpapi ./internal/config ./internal/bootstrap ./cmd/bootstrap-accounts ./cmd/server -run 'TestAuth|TestAccounts' -count=1
cd apps/api && LUSON_TEST_NETWORK=luson-l02-test-isolated-a04e86dcb9ac go test ./internal/auth ./internal/httpapi ./internal/config ./internal/bootstrap ./cmd/bootstrap-accounts ./cmd/server -count=1
cd apps/api && LUSON_TEST_NETWORK=luson-l02-test-isolated-a04e86dcb9ac go test ./... -count=1
cd apps/api && LUSON_TEST_NETWORK=luson-l02-test-isolated-a04e86dcb9ac go test -race ./... -count=1
cd apps/api && go vet ./...
python3 apps/api/fixtures/normalize.py '/tmp/marca modelo amperaje.xlsx'
```

Each command starts independently from repository root, not from the previous command's changed directory. Unit RED selection must not invoke new PostgreSQL checks without the dedicated network. `gofmt` writes are limited to newly authored authorized Go files and the two approved foundation-test adaptations; all other old source remains untouched. Read-only SHA-256 baseline comparisons and exact network/container inspections are permitted. Test-owned PostgreSQL containers retain all ownership/cleanup restrictions; only the parent owns exact empty test-network cleanup. No system-tool installation or Git delivery commands are authorized.

## L03 bounded contract and exact parent execution plan

- Protected `GET /api/inventory/metadata`: PostgreSQL-derived `locations:[{id,name}]`, `brands:[string]`.
- Protected `GET /api/inventory`: required `location_id`, optional `search` (case-insensitive literal brand/model substring only), exact `brand`, explicit `polarity=L|R`, `page` default1, `page_size` default10, allowed10/25/50. AND filters; escaped backslash/%/_ patterns and parameterized SQL. Stable `variant_id` order, identical count/item filters under one read-only snapshot. Valid out-of-range page returns empty items with accurate total.
- Snake-case response: `location,items,page,page_size,total_variants`; items `variant_id,catalog_entry_id,brand,model,capacity_ah,polarity,existing,reserved,available`. Reuse `catalog.Decimal` exact numeric JSON via numeric-text canonical parsing, never float64; use generated PostgreSQL availability. No status/low-threshold/aggregate GLOBAL or capacity-search fields.
- Reject duplicate/unknown query keys, malformed/bounded integers, unsupported sizes/polarity/location/brand, invalid UTF-8/NUL and excessive search; bound page/offset arithmetic. JSON400 `invalid_request`,401 `unauthenticated`,405 `method_not_allowed`/Allow,503 `service_unavailable`; reject ambiguous cookies consistently. HTTP-layer protected-read guard uses existing unambiguous cookie parsing and `Service.Current`, passing DB identity explicitly; leave plaintext legacy auth middleware unchanged and do not expose it as inventory JSON. Preserve compatible existing auth constructor and all session/CSRF/TLS rules.
- No schema/dependency/runtime auth changes needed. Minimal new inventory store/HTTP routes, constructor/server wiring, test-only fixture helper/validation tests, API docs/check evidence. Every account reads every location without changing assigned location. No inventory writes/seed/reset or public auth changes.
- Test helper requires BOTH `LUSON_TEST_NETWORK` and `LUSON_TEST_NETWORK_MANIFEST`; descriptor schema `luson.test-network/v1`, status `active`, exact name/full64-hexID and four labels: feature `login-inventory`, active task `L03`, owner `parent-session-luson-v2`, lifecycle `ephemeral-test-only`. Fresh Docker inspection must match before each own container. No retired L02 rewrite, defaults, fallback bridge or skipped PASS. Resolve relative manifest from canonical repository root, or use explicit absolute path. Pure validation tests cover missing/inactive/malformed/mismatched metadata; name/labels of fresh owned fixtures reflect active task. Parent alone owns empty exact-ID cleanup.

Exact commands, each independently from repository root, repeat for actual RED/GREEN/refactoring. Test-helper configuration repair may precede inventory RED so retired fixture errors are not mislabeled behavioral failures. No dependency install/tidy required:

```sh
cd apps/api && LUSON_TEST_NETWORK=luson-l03-test-isolated-468f4adf5962 LUSON_TEST_NETWORK_MANIFEST=/home/luis/velay/luson_v2/odd/evidence/login-inventory/l03-test-network.json go test ./internal/inventory ./internal/httpapi ./internal/auth/testpg ./cmd/server -run 'TestInventory|TestNetworkManifest' -count=1
cd apps/api && LUSON_TEST_NETWORK=luson-l03-test-isolated-468f4adf5962 LUSON_TEST_NETWORK_MANIFEST=/home/luis/velay/luson_v2/odd/evidence/login-inventory/l03-test-network.json go test ./internal/inventory ./internal/httpapi ./internal/auth/testpg ./cmd/server -count=1
cd apps/api && LUSON_TEST_NETWORK=luson-l03-test-isolated-468f4adf5962 LUSON_TEST_NETWORK_MANIFEST=/home/luis/velay/luson_v2/odd/evidence/login-inventory/l03-test-network.json go test ./... -count=1
cd apps/api && LUSON_TEST_NETWORK=luson-l03-test-isolated-468f4adf5962 LUSON_TEST_NETWORK_MANIFEST=/home/luis/velay/luson_v2/odd/evidence/login-inventory/l03-test-network.json go test -race ./... -count=1
cd apps/api && go vet ./...
python3 apps/api/fixtures/normalize.py '/tmp/marca modelo amperaje.xlsx'
```

Formatting writes only allowed new inventory/helper test files and existing auth-constructor/server-wiring/test-helper surfaces. Persist concise actual nonsecret commands/exits/assertions in `odd/evidence/login-inventory/l03-inventory-checks.md`, not credentials/DSNs/cookies/CSRF/hashes. Compare post-L02 source baseline with exactly authorized existing-file exceptions. Fixtures are fresh own L03-prefixed PostgreSQL17.9/tmpfs/random localhost ports/generated credentials, no network creation/deletion/prune/volumes/operational resources. Existing L01 bridge exception remains separately scoped. No known environmental base failures; final required failure means partial, not done. Advisory L03 roughly650–950 authored lines including store/HTTP/helper/tests/docs; surface material multi-area expansion before extra writes, never minify or omit coverage.

## L04 bounded implementation and exact verification plan

Scope: `apps/web/**` only (frontend, isolated component tests, real-browser test harness and web docs). Worker authors the harness but DOES NOT execute its external runtime. Parent delegates real-browser execution to a separate verifier explicitly authorized for private external temporary fixture artifacts. This resolves worker muxfd9sj-2d-6oip's pre-write interaction stop (2964); no source changed or checks ran before resolution. Existing Go/API/config/SQL/catalog/auth/private CLI/root README stay byte-identical to the 36-file post-L03 baseline. Parent owns feature/evidence/network documents and memory. No Git staging/commit/publication/RDD changes.

- Follow actual three definitive PNG/HTML references above; local Inter and inline SVG, compiled Tailwind. Actual username and assigned location replace unsupported employee role/initials. Keep assignment separate from consultation.
- Warehouse-only assigned ID1 uses mobile cards below768px; branches remain desktop. Verify390px rather than claiming exported responsiveness. Group only page items by catalog entry, preserving variant order; page/range counts variants. No counters, alerts/bells, thresholds, fabricated stock or fake transfer handlers. Native disabled transfer buttons retain accessible names.
- Browser cookie sessions only; in-memory CSRF, session boot/reload, exact login JSON, POST events not effects, logout success only204 followed by anonymous CSRF refresh. On401 clear protected state and focus login; guard obsolete successes AND errors across filters/logout/auth generations. Cancel obsolete GETs. No passwords/session tokens in browser storage, URLs or logs.
- Use lossless-json4.3.1 default parse/LosslessNumber raw text. Convert bounded IDs/page/count to safe Number; quantities to bigint within nonnegative int64, decimal Ah to canonical text without float conversion. Never recompute server availability. Test quantities beyond2^53 and exact6.5.
- Source loading/error/empty states stay within existing form/results regions with accessible announcements; remove export zoom prohibition/global text selection restriction. Search/brand/model/polarity/page controls use actual metadata and literal URLSearchParams, reset page together on filter/location/size changes.
- Test first: minimal compiling scaffolding, failing deterministic component/API-parser/stale-response/binding tests (not import errors or fixture/environment failures), then implement/GREEN/refactor. Structural-only docs/styles use build/browser verification, not artificial RED.

Exact dependency commands from root, after creating only the new package scaffold. Worker runs installation/component/typecheck/build commands only; use NPM_CONFIG_CACHE=$PWD/apps/web/.cache/npm to keep its dependency cache in its surface. Parent-owned external runtime command below is executed ONLY by the separate verifier, not the bounded writer:

```sh
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm --prefix apps/web install --save-exact react@19.3.0 react-dom@19.3.0 @fontsource/inter@5.3.0 lossless-json@4.3.1
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm --prefix apps/web install --save-dev --save-exact vite@8.3.3 @vitejs/plugin-react@6.1.2 typescript@7.0.2 tailwindcss@4.3.3 @tailwindcss/vite@4.3.3 vitest@5.0.3 @testing-library/react@16.3.3 @testing-library/dom@10.4.2 @testing-library/user-event@14.6.7 @testing-library/jest-dom@7.0.1 jsdom@30.1.2 @types/react@19.3.0 @types/react-dom@19.3.0 @types/node@26.6.4 @playwright/test@1.62.1
npm --prefix apps/web run test
npm --prefix apps/web run typecheck
npm --prefix apps/web run build
LUSON_TEST_NETWORK=luson-l04-test-isolated-44fea1f86fda LUSON_TEST_NETWORK_MANIFEST=/home/luis/velay/luson_v2/odd/evidence/login-inventory/l04-test-network.json node apps/web/e2e/run-real.mjs
```

Scripts: dev=vite; test=vitest run; typecheck=tsc --noEmit; build=tsc --noEmit && vite build. Pure binding validator tests run within test. One-worker Playwright is invoked by the real fixture runner with its private runtime configuration, not against an operational server. Browser executable explicitly `/home/luis/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`; registry PW1.62.1 matches cached revision1234/Chrome151. Version and shared libraries independently checked, actual rendering remains required. No browser/system-library installation or downloads.

Real fixture harness authored under apps/web/e2e; the following external runtime writes/processes belong exclusively to the parent-delegated verifier, not the frontend source writer:
1. Validate BOTH bindings, canonical-root manifest path, active schema/exact full ID/name/L04 prefix and four exact labels; fresh docker inspect before each creation. Reject missing/inactive/malformed/extra/wrong ownership without creating resources. No Go L03 test helper, old descriptor reuse or fallback network.
2. Only new random owned PG17.9 container, tmpfs, generated TEST password passed via child environment rather than argv, loopback random published port. No operational DB/volumes/prune. Runtime-generated private DB URL only in child environment; suppress secret-bearing output/inspection.
3. Build unchanged Go server/bootstrap binaries in private temporary directory. Start Go with local-trial, loopback nonzero selected port, browser-origin loopback URL, blank TLS settings. Bound port-race retries and readiness. Go initialization seeds trialdata/migrations; then private Python controlling PTY supplies nine hidden generated distinct TEST inputs to unchanged bootstrap CLI. No arguments/default operator credentials. Require successful bootstrap completion; bound waits and restore/reap on signals/failures.
4. Vite strict loopback port with /api proxy preserving path/browser Origin/Host (changeOrigin:false). Private runtime config/IPC communicates generated TEST credentials to Playwright; no repo credential fixtures, secret argv/logs/traces/video/storage. Fresh browser contexts, one worker, bounded waits.
5. Exercise all3 accounts/all3 inventories (9 combinations), real login/reload/logout/bad login, literal/combined filters and paging, fixed operating identity, warehouse390x844/mobile scroll/cards/no overflow/keyboard/disabled controls, branches1280x1024 desktop/table. Compare actual visual geometry/type/color with exports. No intercepted fake business/API routes in real-browser checks. Screenshot evidence only nonsecret/empty-login or identity/form masked; traces/videos off.
6. Cleanup only exact owned child processes/tempfiles/container after full-ID/labels inspection. Verify no own containers and parent network remains exactly bound/empty; parent alone retires network after independent verification. Never delete/rewrite parent descriptor.

Whole L04 advisory1200–2200 authored lines including UI, tests and isolated fixture; not a cap. Report expansion into new areas before writes. No backend change permitted without parent mapping a real need. L05 still owns Go static SPA serving, two-service deployment, persistent volume/restart and operational HTTPS acceptance. Do not label loopback HTTP tests production TLS or fixture containers deployment services. Failures/skips mean partial; record honest nonsecret command/exit/test evidence in apps/web/docs/l04-checks.md.

## L05 bounded implementation and verification ownership

Implement authorized **local fictional HTTPS trial**, not operational stock import/certificate issuance. Existing trial HTTPS allows container0.0.0.0; do not relax loopback-only HTTP rules. Production currently initializes empty schema; never silently seed fictional stock into production.

Source units: separate webui static handler/tests; shared config.LoadEnv file provider/tests and minimal three CLI callsites; Dockerfile/compose.yaml/.dockerignore/root README/docs; new l05 Compose binding/PTY/ownership/browser runtime files and minimal Vitest inclusion. No auth/SQL/catalog/UI redesign or old L03/L04 fixture-helper weakening.

- Public runtime directory contains only copied compiled index and hashed build assets/local fonts. Serve / and /index.html plus permitted build-owned assets; no new SPA route/fallback for unknown paths or /api. Preserve API handler and its JSON/method/auth behavior. Reject traversal, encoded separators/dot paths, symlinks, source/maps/dotfiles/private paths. GET/HEAD parity,405/Allow,nosniff/correct MIME, HTML revalidation, immutable hashed assets; missing index invalid startup/missing asset404.
- Preserve pure config.Parse/Config and existing generated TEST environment DSNs. Shared loader accepts exactly ONE present DATABASE_URL or DATABASE_URL_FILE (both even empty rejects); bound private regular nonsymlink0600 file owned by runtime UID, bounded size/newline rules, sanitize every configuration failure. Server/bootstrap/migrate share loader. Never output DSN/password/path contents; avoid secret-bearing database startup diagnostics.
- Multi-stage observed official node:26.8.1-bookworm-slim and golang:1.27.0-bookworm builders; compiled static Go binaries server/private bootstrap/migrate and compiled React assets only in minimal nonroot final image. No host-tool installation; image dependencies are project build scope. Exactly app/db runtime services, PG postgres:17.9-bookworm, named PG volume at /var/lib/postgresql/data, DB unpublished, no Vite/proxy/Redis/daemon mount/privilege.
- File-based secrets only for DB password/DSN and TLS keys. PG POSTGRES_PASSWORD_FILE; Go DATABASE_URL_FILE. Nonsecret path/UID/profile/port variables are allowed; no demo/default operational accounts/passwords. Compose file-secret uid/gid/mode overrides are ignored: require real host0600 file ownership/readability matching explicitly configured nonzero app UID/GID. HTTPS cert/key externally supplied. Require explicit LUSON_PROFILE choice; documented local-trial means fictional data, production needs separate legitimate provisioning.
- .dockerignore must exclude Git/.atl/backups/odd/private secrets/evidence/runtime/caches/dependency directories/unrelated assets. COPY only necessary sources/lock/modules. Private credentials/certificates never build context/image layers.
- Writer AUTHORS runtime harness but does NOT build images/start Compose/create TLS/PG/private TMP or run browser. Separate verifier owns external runtime. Writer uses package-local .cache for Go TMPDIR/GOCACHE and npm cache; no source-secret fixtures. Deterministic compiling RED->GREEN config/static/binding tests; no environmental/import failures as RED. Docs/packaging ordinary structural checks.

Exact worker self-checks (each starts from root):
```sh
cd apps/api && mkdir -p .cache/tmp && TMPDIR=$PWD/.cache/tmp GOCACHE=$PWD/.cache/go-build go test ./internal/webui ./internal/config -count=1
cd apps/api && TMPDIR=$PWD/.cache/tmp GOCACHE=$PWD/.cache/go-build go test ./cmd/server ./cmd/bootstrap-accounts ./cmd/migrate -run 'TestWebUI|TestStatic|TestLoad' -count=1
cd apps/api && TMPDIR=$PWD/.cache/tmp GOCACHE=$PWD/.cache/go-build go vet ./...
npm --prefix apps/web run test
npm --prefix apps/web run typecheck
npm --prefix apps/web run build
```
No dependency updates required; installed npm lock remains exact. New pure l05 binding tests belong Vitest. Existing old Go real-PG/race suites cannot use retired L03 bindings; preserve unrelated source hashes and carry prior evidence, then verifier checks actual Compose/auth transport/persistence.

Exact future verifier runtime command (NOT worker execution):
```sh
LUSON_TEST_COMPOSE_MANIFEST=/home/luis/velay/luson_v2/odd/evidence/login-inventory/l05-compose-manifest.json node apps/web/e2e/l05-run-compose.mjs
```

Parent-created schema luson.compose-test/v1/statusactive binds project luson-l05-test-6100cb8ee3ed, services app/db, network fullID5b00841fad4161beb8195c6defde38b7ef8038aa7d70fd314c47f01b93cb8fb1/name luson-l05-test-6100cb8ee3ed-net and REAL volume inspect identity Name luson-l05-test-6100cb8ee3ed-pgdata/Driver local/CreatedAt/Labels/Options/Scope (no invented volume64hexID). Exactly four custom labels featurelogin-inventory/taskL05/ownerparent-session-luson-v2/lifecycleephemeral-test-only. App UID/GID1000 matches host private files. Test override uses external parent-owned network and volume; Compose must not recreate/delete them. Container labels include expected custom ownership plus standard verified Compose project/service labels. Validate fresh identities before effects and each recreation/SQL/cleanup operation; reject retired/wrong/attached/preexisting bindings.

Verifier runtime harness:
1. Private external0700 directory/0600 generated TEST PG secret/DSN/TLS key/CA/credential IPC. Build project image once; no image publishing. Compose override and config remain private; suppress credential/log/config dumps.
2. Run exactly app/db on bound network+volume, published HTTPS loopback only, DB not published. Explicit local-trial with existing HTTPS policy. Generate TEST CA/SAN, trusted Chromium without ignoreHTTPSErrors; inspect actual TLS≥1.2/Secure HttpOnly Strict cookies.
3. Private controlling-PTY docker exec -it app bootstrap-accounts supplies nine hidden generated distinct TEST inputs; no credentials argv/env/repo fixtures. Reuse behavior, not old retired binding. Fresh browser contexts/cachedChrome/PW1.62.1/workers1/traces/videosoff; all9account×location,390 warehouse/desktop, real same-origin STATICSPA/API/authentication, anon/revoked denials/static hardening/font assets.
4. Verify initial570 zero reservations/provenance/counts/migration checksums, private hashed account/session persistence comparisons without emitting hashes/secrets. Modify one balance ONLYownTESTDB, recreate ordinary app/db preserving volume, prove mutation/accounts/session state/catalog/checksums survive and private bootstrap replay refuses without overwrite. This is fixture mutation not operational stock.
5. Stop/remove ONLY exact full-ID/label-owned containers/processes/temp files after each fresh identity check; no prune/down-v or blanket project teardown. Parent ALONE removes exact empty network and unreferenced freshly created volume after all verification settles. Container recreation must never remove the volume. Parent manifest immutable to harness; runtime resource identities may be recorded only in private owned temporary state.
6. Failures/skips mean partial; no whole-vertical/operatorHTTPS/network rollout claim. Record nonsecret self-checks and explicitly pending runtime in docs/l05-checks.md. Forecast900–1500 authored lines excluding generated assets, not cap; report material expansion/new area before edits.

## L05 bounded correction after independent PARTIAL

Verifier muxhme70-2j-uonr passed six source commands/86 tests but runtime exited1 BEFORE image build/container creation: host certutil missing (openssl present). No TLS/browser/persistence PASS. Exact parent network/volume/container/TMP absence independently verified; resources remain active. New Compose browser spec lacked actual literal/combined filter/paging/capacity-exclusion interactions; historical L04 PASS is not Compose evidence.

Parent technical disposition2976 under existing project-image/test authorization:
- Do not install host NSS/system tools or bypass certificates/global CA trust.
- Author dedicated apps/web/e2e/l05-nss.Dockerfile test tool image based on observed node:26.8.1-bookworm-slim; install libnss3-tools inside that image only. Production Dockerfile/Compose remain exactly two runtime services, no NSS in app.
- New l05-nss.mjs invokes tool container for private NSS profile initialization/TESTCA import. Readonly root, network none, cap-drop/no-new-privileges, user1000:1000, ONLY private owned NSS directory writable and CA file readonly. Never mount full secret directory/host home/global trust/socket.
- Guard fresh manifest/network/volume and exact random tool name before build/create. Capture exact created ID and full ownership labels/private state; inspect before every start/cleanup; cleanup all failures/signals without deleting parent resources. Tool container is temporary verification infrastructure, not a third deployed service. Verify no tool remains before app/db startup.
- Real Compose browser spec must perform literal underscore/percent/backslash, combined exactbrand+polarity+search, capacity-search exclusion,10/25/50 reset/previous-next/empty-range checks via real UI and actual server query/result/quantity/assignment assertions. No route interception or invented data.
- Worker authors correction only, pure ownership tests compiling meaningful RED->GREEN; added coverage of already implemented filters has no invented historical RED. Missing certutil is environmental, not app RED.
- Only new NSS helper/Dockerfile, l05 runner/spec, minimal l05 ownership/binding tests and docs/l05-checks.md changes. No Go/UI/production image/Compose/auth/catalog modifications.

Exact self-checks remain npm test/typecheck/build. Separate verifier reruns unchanged L05 runtime entry after source correction. No external image/container/TLS/private TMP execution by writer.

## L05 supported-create correction after second PARTIAL

Re-verifier muxi8j5e-2l-beju passed97 tests/source checks, actual isolated NSS import/cleanup and app image build, but no app/db creation/browser/persistence. Installed Docker Compose create help confirms --no-deps unsupported; --no-recreate and --no-build supported. Runtime stderr was discarded, but CLI incompatibility is deterministic.

Bounded correction2986 only owned-compose.mjs/binding.test.ts/docs/l05-checks.md:
- Use supported create --no-build --no-recreate service, not up.
- Require app dependencies (db) already owned/inspected by full ID, name, labels and expected config hash BEFORE effects. Refuse app-first or unknown/untracked dependency closure; db creation has no dependencies.
- Preserve existing owned dependency IDs through creation/recovery; detect unexpected expansion/recreation and stop safely, never adopt unlabelled/project-selected containers.
- Preserve configure/fresh guard/create-before-start/recover/individual exact cleanup. No UI/backend/production Compose/NSS changes.
- Deterministic compiling mocked RED for unsupported argv/dependency refusal/identity preservation, then GREEN npm test/typecheck/build. Writer never executes external runtime.
- Separate verifier replays original runtime only after corrected source settles. Parent network/volume stay active until full acceptance/cleanup.

## Acceptance and evidence

- Each provisioned account logs into its assigned location; bad credentials do not reveal account existence. Unauthenticated, expired and revoked sessions cannot read inventory. Client-supplied actor data cannot alter assignment.
- Every inventory comes from PostgreSQL, not frontend fixtures. Filters/page counts agree with returned variants and selected location; L/R and fractional Ah remain correct.
- No state-changing inventory route exists in this slice. Available agrees with SQL balances, including zero availability. Opening stock cannot be silently reset by initialization/restart.
- Desktop and warehouse390px layouts are actually exercised; quantities, controls, focus/keyboard and pagination are readable and usable.
- Go/database unit/integration tests, frontend checks/build and applicable browser tests pass. Record observed RED → GREEN for deterministic behavior and alternate cases; explain checks without meaningful RED. Tests/builds are not native review authority.
- Exactly two deployed services; database data persists across ordinary container recreation. No destructive volume removal or unrelated container/data changes.
- Real operational acceptance, network rollout and the unexpected-only receipt decision remain separate later work.

## Workload and routing

Plan five cohesive work units. Initial forecast1,800–2,800 authored lines was low: L01 alone required~1,276 authored lines including integration coverage, plus generated catalog/locks. Revised whole-slice planning range is roughly4,000–6,000 authored lines, excluding generated locks/assets; this is a forecast, not a hard cap. Authentication/UI may exceed the~400-line advisory heuristic: keep behavior/tests/docs together, do not minify or omit coverage, and surface material expansion before turning a unit into a larger multi-area change. No commits: local-metadata grant2929 explicitly excludes them.

Parent derives narrow repository-relative allowed edit surfaces per unit. Delegate each bounded multi-file write to one worker. Writers read this document, self-verify and return exact evidence; parent assesses where available and routes independent verification. Keep all unrelated evidence and snapshots unchanged.

## Progress ledger

| Task | Status | Evidence |
| --- | --- | --- |
| L01 | done | Independent PASS (2920):focused Go/real-PostgreSQL tests, race, vet, source normalization and read-only gofmt; no skipped PG checks or leftover owned test containers. Exact95 models/11 brands/190 L/R variants/570 balances,2 exact6.5Ah capacities. Migration checksums/advisory locks/rollback/production gating/partial refusal/replay preservation/8 concurrent initializers verified. Protected archive baseline hash,217 payload hashes+checksumfile and2 original design-task documents match. Historical RED is writer-reported (catalog/config and6 PG subtests), not independently reproduced/raw-trace-backed; global pre-worker immutability (.atl etc) cannot be proved without a baseline. Human approved scoped shared-bridge exception2915. Source16 files/~1,276 authored+680 fixture/28 lock lines. Native ASSESS unavailable/non-Git/no commits authorized; independent verification is not native authority. |
| L02 | done | Independent corrected-candidate PASS2950 (muxca872-26-7fxa):all6Go/realPG/race/vet/normalizer/gofmt-l checks0/no skips/races. Nine duplicate-cookie endpoint cases4xx/no cookie or persisted mutations; single/anonymous flows preserved. Independent IP10/user10/global60 budgets/minute reset; fresh-handler/service idle30m/absolute8h expiry; trusted actual runtime TLS chain/SAN ≥1.2/Secure HttpOnly Strict cookie. Earlier privatePTY independentPASS carried unchangedCLI:9hidden inputs/3assignedArgonaccounts/replay570balances preserved/signals restore/noTTYrefusal. Historical9caseRED worker-recorded/currentGREENindependent; oldoverlayunexecuted.12origSHA+reverseONLYhuman2936twofoundationadaptationsoriginalhash/95entries11brands190LR570balances/two6.5Ah/stock preserved. ASSESSunassessableuntracked→HIGHindepfallback, RDDOFF/no nativeauthority/no commits authorized. Parent aftersettledtests freshinspectedexactnetworkID/name/fourlabels/EMPTY and removedONLYownedL02ephemeralnetwork; descriptor retired (2925). Browser/operatorHTTPS/deployment stillL04/L05. |
| L03 | done | Independent PASS2958 (muxdiuva-29-1p57):all6Go/realPG/race/vet/normalize+gofmt/hash checks0/no skips/races;focusedserverselection had no tests,full/raceTLS executed. Nineaccount×locationfixedidentity/JSONdenials/strictquerybounds/literalfilters/Decimal/190variants570balances/two6.5Ah/readonlyrepeatablesnapshot verified. AccountID=LocationID proven002PK/Provision/PGidentity notinventedpolicy.26/30postL02baselineMATCH,ONLYREADME/authctor/serverwire/testhelperchanged;modulesoldservertestsunchanged. InventoryREDworkerhistory/helperREDuncaptured/currentGREENindependent/someboundariesstructural/futurehelperportabilitynotexercisedstrictL03. ParentfreshID/name/fourlabels/EMPTYcleanup removedONLYownedL03network;descriptorhistoricalretired (2954). No nativeauthority/commits/stage/remotes/publication/RDDchanges;browser/operatorHTTPS/deployment pending. |
| L04 | done | Independent PASS2968 (muxgbwej-2f-z7gs):52 tests/0 skips, typecheck/build, four real Go/PG/privatePTY/Chromium checks exit0; all9 account-location combinations retain assignment, actual190 variants/location and570 initial zero-reservation balances. Real login/bad login/reload/logout/revocation/expiry/literal and combined filters/paging verified. Lossless quantities >2^53/int64 and exact6.5, stale success/error/401 guards verified. Actual390x844 warehouse no horizontal overflow/16px spacing/64px nav/112px clearance; desktop1280x1024 sidebar240/header56/rows44; login420desktop358mobile; loaded Inter/computed colors. No pixel-perfect screenshot claim.19 dependency pins match;36 protected API/README hashes unchanged (oldGo/race carried forward, not rerun). HistoricalRED worker-only/deepindividual assertionsGREEN-only. Owned PG/processes/privateTMP cleaned; parent freshly matched exact EMPTY network and removed only L04 resource (2963), descriptor retired. No nativeauthority/Gitdelivery/RDDchanges. |
| L05 | done | Independent PASS muxiytmn-2n-of93/2990: all7commands exit0;107frontendtests/no skips/type/build/vet/format PASS. Actual app+db only/nonroot/file secrets/privateNSS trustedHTTPS SAN TLS>=1.2 SecureHttpOnlyStrict/privateTTY9inputs/nine account-location UI matrix/390x844warehouse/1280desktop/literal+combined filters/10,25,50paging/static guards PASS. Same volume/account-session/catalog/provenance/balance/checksum snapshot and SAMEcookie survive ordinary app/db recreation; owned TEST stock mutation retained/bootstrap replay refused/expiry afterward PASS.56of62protectedfiles match/exact6authorizedexceptions/19pins;78aggregate not independently established. Runtime cleanup PASS; parent fresh fullnetworkID/name/4labelsEMPTY and volume6fieldsSAMEnorefs rechecked, removed ONLY created testvolume/network; manifest retired. Initial IDs not retained in bounded daemon history; runner private old/new identity comparisons PASS, final-generation destroy independently seen. Local fictional acceptance only; no Git/native authority/operational rollout. |

## Continuity and next step

Full mirror topic: odd/login-inventory/tasks, observation2906. L01–L05 independently PASS. Verifier muxiytmn-2n-of93 finished; no active writer/verifier or unfinished feature task. All parent-owned isolated fixtures retired, including exact L05 test network and volume after fresh identity/EMPTY/no-reference checks. Local candidate/NSS images retained; no pruning or unrelated resource changes. The retired manifest is historical evidence and cannot be reused for a runtime replay. Historical plans above record each bounded implementation/correction, not active work. User2929 permits Git metadata only: feature/login-inventory remains unborn, zero staged paths/commits/remotes/publication; RDD remains OFF with no native-authority workaround. Operational stock, private operator provisioning, certificate issuance, hosting/network rollout and real backup remain separate next decisions. Current evidence: independent2990, parent cleanup2971, docs/l05-checks.md. Update file/full mirror/todo on any later authorized feature.

## Authorized local delivery checkpoint

After independent L01–L05 acceptance, the user explicitly authorized local commits (observation2992: "perfecto!. comiteamos entonces"). This supersedes the prior metadata-only/no-stage/no-commit boundary for this verified vertical only. It does not authorize remotes, push, publication, merge or RDD changes. The original task-stage Git restrictions above remain historical evidence.

Delivery uses one coherent initial vertical commit: the final API/UI/deployment state is intertwined, and artificial historical splitting would invent independently usable intermediate states. Code, tests, locks and deployment/docs are included. Root ignore rules exclude generated caches/builds, private runtime material, backups, workbooks, tool indexes and local evidence. Other design/backup task histories are not included. Passive status documentation is reconciled with independent2990 PASS; functional sources have not changed and no new functional test execution is claimed.

Commit identity will be recorded in a follow-up documentation commit and the full Engram mirror after actual commit success. The initial commit is large; a future PR needs its own scope/review strategy. Runtime remains stopped, fixtures retired, and operational setup is separate.
