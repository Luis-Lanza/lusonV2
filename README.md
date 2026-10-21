# Luson inventory and transfers

Luson combines a Go API and PostgreSQL with a React/TypeScript frontend for
private login, inventory consultation and transfers across Almacén, Sucursal A
and Sucursal B. The frontend uses the existing authenticated backend contracts;
a consulted inventory location does not change the account's assigned authority.

## Implemented workflows

- Consult inventory across the three locations, with filters and pagination.
- Create stock requests (`request_stock`), branch proposals to send stock to the
  warehouse (`send_to_warehouse`), and direct warehouse shipments to branches
  (`direct_shipment`).
- Browse transfer statuses and details; approve or reject proposals, dispatch,
  receive, or cancel before dispatch where the actor and current state permit.
  Direct shipments are authorized and reserved at creation, not approved later.
- Record receipt quantities and use the received-line count-correction and
  restitution workflows, preserving original receipt evidence.

See the [inventory API contract](apps/api/docs/inventory-api.md) and
[transfer API contract](apps/api/docs/transfers-api.md) for backend rules.
Frontend composition is in [App](apps/web/src/App.tsx) and
[TransferPending](apps/web/src/TransferPending.tsx), including the reachable
lifecycle, receipt, count-correction and restitution views. Contract documents
may retain earlier slice exclusions; frontend composition shows the integrated UI.

## Repository map

| Path | Purpose |
| --- | --- |
| `apps/api/` | Go backend, PostgreSQL migrations, fixtures and API contracts |
| `apps/web/` | React/TypeScript frontend and frontend tests |
| `docs/` | Operational setup and historical verification documentation |
| `odd/tasks/` | Feature plans, scope and delivery evidence |
| `odd/design/` | Optional local design exports; not required to build or verify |

Start with [local deployment](docs/local-deployment.md) for configuration and
[historical L05 checks](docs/l05-checks.md) for the original deployment evidence.
The [transfer UI publication task](odd/tasks/publish-transfer-ui.md) records the
bounded verification and publication work; it is not a general deployment guide.

## Verification and local-test status

Manual acceptance of the integrated transfer flows was reported by the user in
a local test environment, not a production deployment. The transfer UI
publication checks separately passed 2,570 frontend tests across 36 files,
79 focused creation tests, TypeScript checking and a frontend build. These are
recorded checks for that delivery milestone, not a guarantee for future changes
or a new automated browser end-to-end run. They do not establish production
readiness, real-stock reconciliation or operational rollout acceptance.

### Frontend verification quick path

With frontend dependencies already available, run from the repository root:

```sh
npm --prefix apps/web test
npm --prefix apps/web run typecheck
npm --prefix apps/web run build
```

These commands run Vitest, TypeScript checking, and the compiled frontend build.
They can write workspace caches and build outputs. By themselves they do not
update an already-running frozen manual-test environment or its database, nor
do they deploy the generated assets. Keep verification separate from that
running environment. Dependency installation, runtime startup and database
changes require separate instructions; none is part of this quick path.

## Historical L01–L05 verification status

L01–L04 independently passed; their PostgreSQL bindings are historical and
retired. L05 added compiled same-origin assets, private file configuration and
two-service Compose. Its independent fictional local deployment verification
passed real HTTPS/browser/persistence checks, not operational acceptance.
Transfers and a real-stock importer were outside that historical slice.

The L05 verifier passed all seven commands: 107 frontend tests with
no skips, Go webui/config and three CLI packages, vet, typecheck, build and the
real Compose runtime. Acceptance covered exactly app/db, private NSS-trusted
TLS without host installation or certificate bypass, nine hidden PTY inputs,
all nine account/location combinations, warehouse390px and desktop1280px,
filters and pagination. Recreation on the **same volume** preserved the **same
cookie/session**, stock and checksums; bootstrap replay refusal and expiry passed.

The parent completed owned test-resource cleanup and retired the manifest.
Reruns need a newly authorized fixture, not a historical binding. Real stock,
operator provisioning/certificates, hosting/network rollout and backups were
out of scope for L05. No pixel-perfect claim is made.

## Authentication setup

1. Initialize/check the database as described below. Migration002 adds only
   `auth_accounts`, `auth_sessions` and `auth_throttle`; migration001 and stock
   initialization remain unchanged.
2. From `apps/api`, run `go run ./cmd/bootstrap-accounts` in a private terminal.
   Use a private `LUSON_DATABASE_URL_FILE` and explicit `LUSON_PROFILE`
   configuration. Generated test DSNs may still use `LUSON_DATABASE_URL`, but
   exactly one provider must be present (even empty duplicates are rejected). The CLI accepts no arguments, account-password environment
   variables, credential URL, redirected credential file or piped input. It
   opens `/dev/tty` and hides **both usernames and passwords**, with confirmation,
   in Almacén / Sucursal A / Sucursal B order. Do not record the terminal.
3. Supply your own three distinct usernames and three distinct passwords. Names
   are case-sensitive ASCII `[a-zA-Z0-9_.-]`, 3–64 bytes. Passwords are 12–128
   UTF-8 bytes without NUL. There are no operational defaults. Provisioning is
   all-three transactional, requires all three existing locations, and refuses
   existing complete **or partial** accounts; replay never changes accounts or
   balances. The CLI does not initialize trial data. Production schema-only
   initialization cannot create accounts until legitimate locations exist;
   real-stock importing was outside the historical L01–L05 slice.
4. Set explicit `LUSON_ORIGIN`, `LUSON_LISTEN` and `LUSON_WEB_DIR` (the compiled
   `apps/web/dist` directory), then run `go run ./cmd/server`.
   For an explicit `local-trial` only, `http://localhost:8080` and
   `127.0.0.1:8080` are valid technical examples. HTTP requires both origin and
   listener to be localhost/loopback; LAN/public insecure listeners are refused.
   HTTPS requires `LUSON_TLS_CERT` and `LUSON_TLS_KEY` paths. Production **must**
   use HTTPS and a certificate/key that actually load before any DB startup or
   listener opening. The server itself terminates TLS; forwarded headers are
   not trusted and no third deployment service is assumed.

The server calls `bootstrap.Initialize(ctx, pool, profile)` once on startup.
It does not provision accounts, overwrite balances, serve fake business/health
responses or expose registration, reset, admin or direct inventory write routes.
Transfer mutations use their separate authenticated API contract.
Compiled public assets are composed outside the API mux; unknown paths never
become the SPA index. The runtime image contains no frontend development server.

## Browser navigation

Inventory, the transfer list and transfer details use hash URLs:
`/#/inventario`, `/#/transferencias` and `/#/transferencias/<id>`.
Refresh and browser Back/Forward restore the selected view. Detail links fetch
fresh data after authentication and retain the backend's participant checks;
a URL does not grant access. Signing out clears the current private route.
Drafts, open dialogs and pending operation recovery remain memory-only and are
not restored by refreshing. Unknown or malformed routes show Inventory.

## Authentication API contract (for L03/L04)

All responses are `Cache-Control: no-store`; JSON errors are
`{"error":"<code>"}`. Same-origin fetches must retain cookies. No CORS is enabled.

| Route | Request | Response |
| --- | --- | --- |
| `GET /api/auth/session` | No credential body | 200 anonymous: `authenticated:false`, `csrf_token:string`; or 200 authenticated: `authenticated:true`, `identity`, `csrf_token:string`, `expires_at:string` (UTC RFC3339) |
| `POST /api/auth/login` | JSON object with **only** string `username`, `password`; maximum1024 bytes | 200 authenticated response identical to session; fresh session cookie |
| `POST /api/auth/logout` | Empty body; mutation headers and cookie | 204 empty response; persistent revocation and cleared cookies |

`identity` has `account_id:number`, `username:string`, and
`location:{id:number,name:string}`. Account IDs equal assigned location IDs
1/2/3: Almacén / Sucursal A / Sucursal B. The server derives all identity fields
from PostgreSQL; actor/location parameters cannot change assignment. Every
account can consult all three inventories without changing this assignment.

Before login, fetch session and send its `csrf_token` in `X-CSRF-Token` together
with the exact configured `Origin`. The anonymous response creates a600-second
HttpOnly prelogin cookie; CSRF is domain-separated SHA-256 derived from that
random cookie. Authenticated CSRF is instead derived from the secret session
cookie, so it remains available after handler/process recreation without storing
raw secrets. Both mutation routes require exact Origin, CSRF and, when supplied,
`Sec-Fetch-Site: same-origin`. Fetch session again after expiry or logout.
The browser cannot read either cookie. The prelogin cookie is cleared on login.

Missing, invalid, unknown and wrong credentials return the same401
`invalid_credentials`; malformed JSON (including null/non-string values,
duplicates, unknown keys and trailing input) returns400 `invalid_request`.
Origin/CSRF violations return403 `forbidden`; throttling returns429
`rate_limited` with `Retry-After: 60`; database failures return503
`service_unavailable` without driver details. Wrong methods return405 with Allow;
logout is never GET. Expired/revoked sessions become anonymous through session
GET; reusable `auth.Service.Middleware` rejects them with401 and places only a
server-resolved `auth.Identity` in request context (`auth.IdentityFrom`). Future
mutations must also apply the origin/CSRF guard; middleware alone is not CSRF.

## Authentication technical defaults and limits

- Passwords: maintained `x/crypto` Argon2id,19MiB,2 passes,1 lane; independent
  CSPRNG16-byte salts and32-byte hashes in fixed-parameter PHC encodings. Corrupt
  encodings cannot request attacker-selected memory/cost. These are technical
  security defaults, not new business rules.
- Sessions: CSPRNG32-byte opaque tokens; PostgreSQL stores only SHA-256 token
  hashes. Absolute8 hours, idle30 minutes, activity extension at most once per
  minute and never beyond absolute expiry. Login revokes the presented old
  session and creates a new one in one transaction. Conditional SQL activity
  updates cannot clear revocation or revive expiry. Login opportunistically
  removes up to100 sessions older than absolute expiry plus24 hours; no separate
  cleanup service is provided.
- Cookies: `luson_session` and `luson_prelogin`, Path=/, HttpOnly,
  SameSite=Strict, no Domain; Secure on HTTPS, including required production TLS.
  Logout clears the identical names/path/flags. The loopback HTTP trial exception
  is not production transport protection.
- Throttling precedes expensive hashing: persistent fixed one-minute windows,
  10 attempts/IP bucket,10/username bucket,60/global. Fixed4096 IP and4096
  username hash buckets plus one global row bound limiter storage to8193 rows.
  Collisions conservatively share limits and may deny unrelated users. All
  attempts, including successful ones, count; distributed attacks can exhaust
  the global budget. TCP peer IP only: X-Forwarded-For cannot bypass it. There is
  additionally a **process-local** two-hash concurrency cap (not shared across
  processes); PostgreSQL limits remain persistent/shared. No proxy trust is
  configured. Authentication behind a proxy would share that proxy's IP budget.
- Runtime timeouts:5s headers,10s reads,15s writes,60s idle;8KiB headers.
  Database owner access remains administrative authority, not an application
  security boundary. Runtime-role provisioning is not implemented. Go strings
  cannot guarantee secret-memory erasure; the CLI clears temporary byte input
  but must retain credentials in memory until the transaction finishes.

## Authentication checks

All PostgreSQL tests require **one nonsecret environment pointer**:
`LUSON_TEST_PG_MANIFEST`, an absolute path to a fresh parent-owned
`luson.test-pg/v1` manifest. Missing, inactive or mismatched admission fails
before SQL; there is no skip, historical binding, default-bridge fallback,
host PostgreSQL installation or credential DSN environment provider.

The parent prepares and owns the isolated PostgreSQL17.9 fixture: an internal
private Docker network, no published host ports, and temporary private data.
The manifest and its private DSN file must be regular, nonsymlink, UID1000,
mode0600 files. Do not print their contents or copy credentials into commands,
environment variables or logs. Read-only Docker inspection verifies full
container/network/image identities, exact ownership labels, IPAM, private
address and bind metadata before database creation and cleanup.

`internal/testpg.Open(t)` creates only a cryptographically named **empty
database**, with a bounded pool; callers initialize their own schema/accounts.
The old `internal/auth/testpg` import path delegates to the same helper.
Cleanup closes the pool, rechecks admission and drops only its recorded database
with the matching owner and catalog identity. Tests never create, stop or remove
Docker resources or drop the admin database. Parent fixture lifecycle remains
separate; a manifest does not grant Docker lifecycle permission.

Historical L02–L05 commands and retired bindings are evidence only, not runnable
defaults. Earlier records remain in
`odd/evidence/login-inventory/l02-auth-checks.md` and
`odd/evidence/login-inventory/l03-inventory-checks.md`.

## Run the foundation checks

Requirements: Go 1.27, Python 3 for source comparison, a running Docker daemon,
and the freshly admitted parent-owned fixture described above. Set
`LUSON_TEST_PG_MANIFEST` to its absolute manifest path (not a DSN) in the test
shell before running PostgreSQL checks. From the repository root:

```sh
python3 apps/api/fixtures/normalize.py '/tmp/marca modelo amperaje.xlsx'
cd apps/api
# Fixture-independent admission checks:
go test ./internal/testpg -run '^TestR01AdmissionPure$' -count=1
go test ./internal/auth/testpg -count=1
# Requires LUSON_TEST_PG_MANIFEST from the parent-owned fixture:
go test ./internal/testpg ./internal/bootstrap -run '^(TestR01AdmissionPostgres|TestPostgres|TestAccountsAtomic|TestAccountsPartialRefusal)$' -count=1
go vet ./...
```

The foundation integration test **always runs**, without a skip path, through
that same admission boundary. Its schema/seed, replay, rollback, checksum,
unknown-table and eight-concurrent-initializer assertions remain unchanged.
There is no independent default-bridge container setup. If a process is forcibly
killed, its generated database can remain; the parent must inspect and handle
that exact owned database rather than using wildcard drops or Docker cleanup.

## Initialize or check a privately configured database

Supply the path to a private `LUSON_DATABASE_URL_FILE` for operational use.
Generated isolated tests retain environment `LUSON_DATABASE_URL` compatibility.
Do not put a password/DSN in this repository, logs, command arguments, or shared
shell history. File rules and Compose ownership are in the deployment guide.
Set `LUSON_PROFILE` explicitly to one of:

| Profile | `initialize` behavior |
| --- | --- |
| `production` | Apply schema only; never insert fictional balances. |
| `local-trial` | Apply schema and atomically seed the fictional opening dataset once. |

From `apps/api`:

```sh
go run ./cmd/migrate initialize
go run ./cmd/migrate check
```

Missing URLs, invalid PostgreSQL URLs, and unsupported/missing profiles are
rejected. CLI errors deliberately omit driver details because those can expose
connection data. `check` verifies migration tracking and accepts either a wholly
empty data schema or a complete initialized dataset; it never repairs or seeds.
The historical foundation workflow above does not cover reset, drop, backfill
or real-stock import.

For server integration, `bootstrap.Initialize(ctx, pool, profile)` is the
entry point. `db.Apply` and `bootstrap.Seed` are separate transactional functions.
Schema application can commit independently of a failed seed; no partial seed
can commit. Both acquire the same transaction-scoped PostgreSQL advisory lock,
so concurrent starters serialize safely. One `schema_migrations` table records
versions and SQL checksums. Changed, unknown, or noncontiguous applied migrations
are refused rather than silently reapplied.

## Data and provenance

| Contract | Implementation |
| --- | --- |
| Locations | `Almacén`, `Sucursal A`, `Sucursal B` |
| Source | External `/tmp/marca modelo amperaje.xlsx`, sheet `baae de datos` |
| Catalog | 95 exact entries, 11 brands; all brands including MOTO and Solar rows |
| Variants | 190 explicit L/R pairs, regardless of L/R-looking model suffixes |
| Balances | 570 location/variant rows; nonnegative integer existing/reserved |
| Availability | Stored generated SQL column `existing - reserved` |
| Capacity | Positive `numeric(12,6)` Ah, exact Go decimal strings; never floats or integer truncation |

Catalog metadata is real and Excel-derived; only the local-trial opening stock
quantities are fictional.

`apps/api/fixtures/catalog.json` is derived, embedded into Go, and includes the
source SHA-256, sheet, exact JSON decimal numbers, entry cell references, and the
six excluded header triplets. The source workbook is not copied into this repo.
The stdlib-only normalizer reads XLSX ZIP/XML without modifying the original.
The 101 nonempty triplets **after row 4** comprise 95 records and six repeated
headers (four groups on row 22; two on row 31), across BCD/FGH/JKL/NOP.
The original row-4 headings are not counted as records.

Source SHA-256:
`b48e97ce1abf24304951831cc07498098391a12c3587cda6448fa7aea8faeacf`.

The fractional source records remain `TOYO_MOTO / 12N6,5_3B / 6.5` and
`ULTRON_MOTO / YB6,5_BS / 6.5`. Brand underscores, model commas, spaces, and case
are preserved. Source comparison checks the entire fixture, not only these two
examples. Only intentional source maintenance should use the normalizer's
`--write` option; an initialized database rejects a changed fixture fingerprint.

## Fictional opening quantities and preservation

Explicitly authorized trial quantities are `(variant_id * 7 + location_id * 11)
mod 31`: varied 0–30, with zeros in every location and distinct quantities for
each location/variant. They are not physical stock observations or values taken
from mockups. Reserved starts at zero; there are no phantom transfer holds.
`initialization_metadata.stock_origin = 'fictional-local-trial-v1'` records this
provenance internally. It is not an application demo label.

Seeding refuses any partial existing dataset. On replay it checks catalog,
variants, locations, counts, source SHA, and fixture fingerprint, but **never
compares or resets existing/reserved values to the trial formula**. Deleted
balance rows cause an error, not a reseed. SQL triggers seal catalog, variants,
locations, and initialization metadata against mutation. Database owner-level
administration is not a security boundary; later runtime role provisioning is
outside L01.

The tests cover exact source counts/decimals, configuration safety, invalid
quantities, schema/seed rollback, SQL constraints, migration drift, production
seed rejection, replay preservation, incomplete-data refusal, and eight
concurrent initializers. L05 independently passed durable-volume recreation and
real browser checks for the isolated fictional trial (see historical status above).
The isolated tmpfs test container and named deployment volume are not backups.
