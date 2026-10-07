# Luson login and read-only inventory

React and Go provide private login and read-only consultation for all three
locations. L05 provides compiled same-origin assets, private file configuration
and two-service Compose. Independent local fictional deployment verification is
**PASS**, including real HTTPS/browser/persistence checks; this is not operational
acceptance. Transfers and a real stock importer are not implemented.

Start with [local deployment](docs/local-deployment.md), then
[L05 check status](docs/l05-checks.md) and the
[inventory API contract](apps/api/docs/inventory-api.md). L01–L04 independently
passed; their PostgreSQL bindings are historical and retired.

## Current verification status

Verifier `muxiytmn-2n-of93` passed all seven commands: 107 frontend tests with
no skips, Go webui/config and three CLI packages, vet, typecheck, build and the
real Compose runtime. Acceptance covered exactly app/db, private NSS-trusted
TLS without host installation or certificate bypass, nine hidden PTY inputs,
all nine account/location combinations, warehouse390px and desktop1280px,
filters and pagination. Recreation on the **same volume** preserved the **same
cookie/session**, stock and checksums; bootstrap replay refusal and expiry passed.

The parent completed owned test-resource cleanup and retired the manifest.
Reruns need a newly authorized fixture, not a historical binding. Real stock,
operator provisioning/certificates, hosting/network rollout and backups remain
out of scope. No pixel-perfect claim is made.

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
   there is no operational stock importer in this slice.
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
responses or expose registration, reset, admin or inventory write routes.
Compiled public assets are composed outside the API mux; unknown paths never
become the SPA index. The runtime image contains no frontend development server.

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

All authentication/inventory PostgreSQL tests require BOTH an explicit
`LUSON_TEST_NETWORK` and `LUSON_TEST_NETWORK_MANIFEST`. The active descriptor's
schema, name, full ID and four exact ownership labels must match a fresh Docker
inspection before each fixture. Relative descriptor paths resolve from the
canonical repository root, not the Go package directory. Missing, inactive or
mismatched descriptors fail; there is no bridge fallback or skip. The historical
L02 network is retired. Active fixtures are fresh `luson-l03-test-*`
PostgreSQL17.9 containers with generated test credentials, localhost random ports
and tmpfs data, and stop only their exact owned containers. The parent owns
network creation and empty exact-ID cleanup; a file alone grants no lifecycle
permission.

Historical L03 commands below are evidence only: their binding is retired.
Do not execute them without a new parent-provisioned contract/helper mapping:

```sh
cd apps/api
LUSON_TEST_NETWORK=luson-l03-test-isolated-468f4adf5962 LUSON_TEST_NETWORK_MANIFEST=odd/evidence/login-inventory/l03-test-network.json go test ./... -count=1
LUSON_TEST_NETWORK=luson-l03-test-isolated-468f4adf5962 LUSON_TEST_NETWORK_MANIFEST=odd/evidence/login-inventory/l03-test-network.json go test -race ./... -count=1
go vet ./...
```

This binding is temporary, not a reusable default. L03 commands and actual
results: `odd/evidence/login-inventory/l03-inventory-checks.md`.

The original L01 integration test still uses its independently authorized bridge
exception; no new auth coverage was added there. Observed command/RED/GREEN
records: `odd/evidence/login-inventory/l02-auth-checks.md`.

## Run the foundation checks

Requirements: Go 1.27, Python 3 for source comparison, and a running Docker daemon.
From the repository root:

```sh
python3 apps/api/fixtures/normalize.py '/tmp/marca modelo amperaje.xlsx'
cd apps/api
go test ./internal/catalog ./internal/config ./internal/bootstrap ./internal/db ./cmd/migrate -count=1
go test -race ./internal/catalog ./internal/config ./internal/bootstrap ./internal/db ./cmd/migrate -count=1
go vet ./internal/catalog ./internal/config ./internal/bootstrap ./internal/db ./cmd/migrate
```

The PostgreSQL integration test **always runs**, without a skip path. It uses
`postgres:17.9`, a fresh `luson-l01-test-<random>` container, generated test-only
password, fresh test databases, container-only bridge networking, and a random
host port bound only to `127.0.0.1`. PostgreSQL data is held in a tmpfs at
`/var/lib/postgresql/data` (the PostgreSQL 17 path). No user database, named
volume, or operational credentials are used. Deferred cleanup stops only that
exact container; Docker's `--rm` removes it. There is no prune or volume-removal
command. A forcibly killed test process may leave its own container running;
inspect the exact test container and stop only it.

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
There is no reset, drop, backfill, or real-stock import command.

For later server integration, `bootstrap.Initialize(ctx, pool, profile)` is the
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
real browser checks for the isolated fictional trial (see current status above).
The isolated tmpfs test container and named deployment volume are not backups.
