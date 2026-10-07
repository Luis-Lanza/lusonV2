# L05 source candidate checks

## Status and ownership

**Writer source/unit/component/type/build checks: PASS.**
**Independent isolated NSS import/isolation/cleanup and app image build: PASS.**
**Independent actual app/db creation, private PTY, trusted browser navigation and persistence: PASS.**
Local fictional deployment acceptance is verified; operational completion is not claimed.
Verifier `muxiytmn-2n-of93` ran all seven exact commands successfully: 107 frontend
checks with no skips, Go webui/config and three CLI packages, vet, typecheck, build,
and the real Compose runtime. Earlier PARTIAL/PENDING records below are historical.

Actual acceptance includes private NSS trust (no TLS bypass or host installation),
two deployed services, nonroot file-based secrets, nine hidden PTY inputs, all nine
account/location combinations, warehouse390px and desktop1280px, literal/combined
filters and10/25/50 pagination. Account/session/catalog/provenance/balance/migration
snapshots and the same cookie survived app/db recreation on the same volume; a
TEST stock mutation persisted, provisioning replay refused, then expiry passed.
The protected baseline matched56/62 with exactly six authorized exceptions and
all19 pins. The writer78-file aggregate is not independently established. Bounded
daemon history retained final-generation destruction only; private runner old/new
full-ID comparisons passed. No pixel-perfect or operational certificate claim.

The verifier cleaned its containers/processes/private files. Parent then freshly
checked exact network identity/labels/EMPTY membership and all six volume identity
fields/no references, removed only its ephemeral test network/volume, and retired
the manifest. Local images remain. Rerunning the entry requires a newly authorized
owned fixture—not the historical retired manifest. No commits, staging, remotes,
publication or RDD changes occurred. Real stock, operator credentials/certificates,
hosting/network rollout and backup remain outside this fictional acceptance. The writer
read the complete canonical task before writes and implemented only mapped L05
surfaces. Parent owns task/evidence/memory, assessment and resource lifecycle.
No stage, commits, remotes, publication, RDD changes or child delegation occurred.

## Observed test-first evidence

- First compiling minimal static/config stubs: required command1 exited1.
  Static API dispatch, index/assets/MIME/cache/HEAD/405 and seven startup refusal
  cases failed; environment/file success and current-UID predicate failed.
- Compiling naive FileServer/file-reader scaffolds: command1 exited1.
  Source/dotfile/map/unhashed assets were incorrectly served; traversal and
  encoded paths were served/redirected; API dispatch, cache/HEAD/405 and startup
  validation failed. File-provider duplicate/missing/empty/permissions/size/
  symlink/type/newline/invalid URL/profile/driver-option cases did not satisfy
  fixed sanitized failure assertions. This was not a missing-import failure.
- Pure binding stubs: frontend tests exited1 with29 L05 failures. Missing/inactive/
  wrong schema/project/services/UID/GID/IDs/labels/real-volume metadata and wrong
  container/Compose identity were accepted instead of refused.
- Additional observed RED: five unsafe API paths reached the API sentinel418
  instead of404; fixed by rejecting raw unsafe paths before inner mux dispatch.
- Additional observed RED: unlabelled preexisting exact container names reached
  the mocked image-build effect instead of refusing; fixed with fresh exact-name
  checks. Mocks made no Docker calls.
- GREEN/triangulation: all focused checks below passed. Coverage also includes
  valid with/without-LF files, exact4096-byte boundaries, oversized otherwise-valid
  URLs, optional nonzero process identity checks, canonical API preservation,
  actual MIME/cache/HEAD, detached expected container validation, and fresh
  refusal before SQL after a changed network binding.
- The file ownership negative uses the same fstat UID predicate without privileged
  chown or skipped tests; actual host1000-to-container1000 readability remains
  an external runtime check. Three command callsite tests are GREEN-only wiring
  regressions, not separately observed RED. Docker/docs are passive structural
  changes with no artificial RED. Old L03 PostgreSQL/race fixtures were not run.

## Exact observed worker commands

Original candidate results (before the bounded NSS/coverage correction), each
independently from repository root, foreground. These six checks also passed
independent verification; the correction writer did not rerun Go commands:

```text
cd apps/api && mkdir -p .cache/tmp && TMPDIR=$PWD/.cache/tmp GOCACHE=$PWD/.cache/go-build go test ./internal/webui ./internal/config -count=1
exit0; both packages passed, no skips.

cd apps/api && TMPDIR=$PWD/.cache/tmp GOCACHE=$PWD/.cache/go-build go test ./cmd/server ./cmd/bootstrap-accounts ./cmd/migrate -run 'TestWebUI|TestStatic|TestLoad' -count=1
exit0; all three packages passed, one new TestLoad case each, no skips.

cd apps/api && TMPDIR=$PWD/.cache/tmp GOCACHE=$PWD/.cache/go-build go vet ./...
exit0; no diagnostics; no external PostgreSQL tests executed.

npm --prefix apps/web run test
exit0; 4 files, 86 tests passed (34 L05 + 52 unchanged), no skips.

npm --prefix apps/web run typecheck
exit0; existing TypeScript configuration unchanged.

npm --prefix apps/web run build
exit0; 33 modules, compiled index/hashed JS/CSS/local WOFF/WOFF2 assets.
```

Readonly62-file SHA-256 comparison: **56 unchanged; six allowed exceptions**:
README.md, apps/api/cmd/server/main.go, apps/api/cmd/server/main_test.go,
apps/api/cmd/bootstrap-accounts/main.go, apps/api/cmd/migrate/main.go,
apps/web/vite.config.ts. No nonexception changed. Modules/locks, all19 dependency
pins, auth/HTTP API/SQL/catalog/bootstrap logic, UI/model and old L04 helpers are
unchanged. New files and generated dist/package-local caches are within scope.
Source formatting was inspected read-only; no formatter wrote outside scope.
There are no private runtime secret artifacts: the writer did not create external
TMP, TLS, runtime credentials, containers, network or volume artifacts. Parser
unit fixtures are non-operational and confined to allowed Go TMPDIR/cache.

## Bounded NSS/Compose-coverage correction

Independent verifier muxhme70-2j-uonr returned **PARTIAL**: all six source checks/
86 tests passed, but runtime exited1 because host certutil was missing, before
image builds or container creation. Parent confirmed bound resources remained
empty/unchanged. That environmental failure is not application RED.

Parent route2976 is now authored: `l05-nss.Dockerfile` installs libnss3-tools only
inside a purpose-built node26.8.1-bookworm-slim project test image. Docker receives
only Dockerfile text on stdin (empty filesystem build context). There is no host
installation or production Dockerfile/Compose change. The short-lived tool runs
1000:1000, network none, readonly root, dropped capabilities/no-new-privileges.
Its only mounts are owned private NSS directory RW and generated public CA file
RO. No full secret directory, host home, daemon socket or global CA store is
mounted. Actual TEST CA trust is imported into the private Chromium profile;
certificate bypasses remain forbidden. Random tool namespace/image names are
checked before effects; fresh parent bindings and full container/image identity,
labels, role, command and mount checks guard start/cleanup. Interrupted creation
is recovered only by exact name/full identity into private state. Exact-ID cleanup
verifies no tool remains before app/db startup, including the outer failure/signal
cleanup path. Built images are retained for parent disposition.

Observed correction RED: `npm --prefix apps/web run test` exited1 with10 new
mocked NSS failures (all prior86 tests passed). Minimal compiling scaffolding
accepted preexisting names, changed bindings and unsafe ID/role/mount/network/user/
root settings; build lacked empty context and isolation assertions failed.
GREEN: correction unit tests pass, including interrupted-create recovery and
exact-ID removal. All Docker effects/filesystem probes are mocked in unit tests.

Exact correction commands, independently foreground from repository root:

- `npm --prefix apps/web run test`: exit0, 97 tests/4 files, no skips; prior86 plus11 NSS tests.
- `npm --prefix apps/web run typecheck`: exit0.
- `npm --prefix apps/web run build`: exit0, unchanged React compiled assets/33 modules.

Real Compose spec coverage is **authored, NOT EXECUTED**: each of the nine
account/location combinations now exercises real UI literal underscore/percent/
backslash, exact brand+polarity+search AND filters, actual6.5 capacity rendering
and exclusion from brand/model search, server-derived quantities/order/counts/
ranges, singleton mobile groups,10/25/50 size resets and previous/next boundaries.
Empty searches assert the actual0–0 GUI range. The existing GUI disables next at
the last page, so out-of-range is checked only by a real browser GET; no invented
control. Assigned actor remains fixed after every filter/pager interaction.
Warehouse390×844, desktop1280×1024, trust/cookies/fonts/static/auth/persistence/
replay assertions remain. Added existing-behavior coverage has no artificial RED.

The NSS writer previously reported an in-memory74-file aggregate comparison.
No persisted74-file reference was available to the re-verifier, so this is a
historical writer report, not independently established74-file proof. No Go/backend/UI,
production packaging, dependency pins/locks, old L04 helper, Git/RDD, parent
manifest/evidence or resource lifecycle changes. No private runtime artifacts,
image builds, containers, TLS or browser execution were created by this writer.

Re-verifier muxi8j5e-2l-beju observed97 source tests passing, isolated NSS import/
isolation/exact cleanup and app image build PASS. Runtime then failed before
app/db creation. Installed Compose help confirms `create --no-deps` unsupported;
`--no-build` and `--no-recreate` are supported. Raw runtime stderr was discarded;
the argument incompatibility is deterministic, not a Go/password/TLS finding.
Trusted browser navigation, PTY, filters and persistence remain PENDING.

## Supported-create correction2986

The owned harness now uses exactly `create --no-build --no-recreate service`,
not `up`. Normalized Compose JSON stays private in memory: exactly app/db,
app→healthy db, db→no dependencies and no implicit service-link namespaces are
accepted. Its canonical fingerprint detects configuration drift before create
and start. App-first/untracked/not-ready DB or missing expected config hash
refuses before effects. Existing full IDs/names/custom-plus-Compose labels/hashes
are rechecked; prior IDs are snapshotted and inspected through recovery/start.
Only the planned validated target may be admitted during fresh resource-list
checks. Unexpected replacement/expansion stops recovery without broader adoption
or cleanup of untracked resources. Parent bindings/lifecycle remain unchanged.

Observed compiling mock RED: frontend tests exited1, eight new failures with all
prior97 passing. Unsupported argv broke the success path; app-first/missing hash/
config drift/unknown dependencies were accepted, and changed DB/unexpected
expansion allowed premature app adoption. Existing untracked-resource refusal
and interrupted-create recovery were GREEN-only protections, not invented RED.

Exact correction checks, independently foreground from root:
- `npm --prefix apps/web run test`: exit0, 107 tests/4 files, no skips; prior97 plus10 create regressions.
- `npm --prefix apps/web run typecheck`: exit0.
- `npm --prefix apps/web run build`: exit0, 33 modules.

Fresh before/after78-file aggregate comparison preserves the62-file current
candidate baseline plus non-editable packaging, Go and NSS/runner/spec sources;
this is a current writer comparison, not a missing historical74-file reference.
No runtime, Docker, TLS/NSS, PTY or private fixture execution by this writer.
Separate verification must replay the unchanged entry below for actual supported
creation, dependency preservation, browser/auth/PTY/filter/persistence acceptance.

## External verifier command — NOT EXECUTED by writer

```sh
LUSON_TEST_COMPOSE_MANIFEST=/home/luis/velay/luson_v2/odd/evidence/login-inventory/l05-compose-manifest.json node apps/web/e2e/l05-run-compose.mjs
```

Pending checks: actual app/db creation; exactly two deployed services; trusted TLS≥1.2 and cookie
flags; all nine real account/location combinations; warehouse390/desktop1280,
fonts/static hardening; private nine-hidden-input CLI and replay refusal; initial
95/190/570 zero-reservation provenance/migrations; one own TEST mutation; ordinary
container recreation preserving the real named volume, account/session/catalog/
quantity/checksum state and retained session; isolated post-persistence expiry;
exact cleanup leaving parent network empty and volume preserved. No PASS skips.

The harness builds the app image once and the test NSS image once, uses an
external private0700 fixture/0600 secrets and
private Chromium trust store, suppresses diagnostics/config/SQL/hashes/credentials,
and retains the built image. Fresh full-ID/name/labels and real-volume timestamp/
driver/options/scope checks precede Docker effects/SQL/recreation/cleanup; exact
preexisting names, project resources and stopped volume attachments are refused.
Only expected full-ID/custom-plus-standard-Compose-labelled containers are
removed. Parent manifest is immutable; parent alone retires network/volume.

External prerequisites are existing Docker Compose and host OpenSSL, host
UID/GID1000 and the cached PW1.62.1/Chrome151 binary; NSS certutil is supplied only
by the test tool image. This writer did not execute runtime prerequisites or
install anything. Any runtime failure, skip or incomplete
cleanup is a failed acceptance check requiring parent disposition. Real stock
provisioning, operator certificate issuance, backups and network rollout remain
separate; clean production schema is intentionally empty.
