# Local HTTPS deployment candidate

## What this delivers — and what it does not

Exactly two services: **app** serves compiled React and the Go API on one HTTPS
origin; **db** is PostgreSQL17.9 with unpublished ports and persistent named
storage at `/var/lib/postgresql/data`. No Vite, proxy or additional runtime.

This is an authorized **fictional local HTTPS trial**, not real operational
stock, certificate issuance, account defaults, backups or network rollout.
[L05 checks](l05-checks.md) distinguish source checks from pending runtime checks.
The `production` profile applies empty schema only. There is **no legitimate
catalog/location/stock importer** in this slice: a clean production database
cannot bootstrap the three accounts until separate legitimate provisioning
exists. Do not switch profiles to disguise trial stock as operational data.

## Prepare private configuration outside the repository

Use an external private directory, not the build context, with mode0700.
Supply your own PostgreSQL password, its corresponding DSN, and externally
issued/trusted TLS certificate/key. There are no default passwords/accounts.
Keep account credentials out of these files: they are entered only in the
private interactive bootstrap terminal.

Export **paths and nonsecret settings only**:

| Variable | Required value |
| --- | --- |
| `LUSON_PROFILE` | Explicit `local-trial` or `production` |
| `LUSON_DB_PASSWORD_FILE` | Absolute external private PostgreSQL password file |
| `LUSON_DATABASE_URL_FILE` | Absolute external private PostgreSQL URL file |
| `LUSON_TLS_CERT_FILE` | Absolute external certificate PEM file |
| `LUSON_TLS_KEY_FILE` | Absolute external private key PEM file |
| `LUSON_ORIGIN` | Exact trusted HTTPS browser origin including nondefault port |
| `LUSON_HTTPS_PORT` | Explicit nonzero unoccupied host port |
| `LUSON_APP_UID`, `LUSON_APP_GID` | Optional matching **nonzero** host IDs; defaults1000:1000 |

Compose publishes **127.0.0.1 only**. A local trusted origin may use localhost or
127.0.0.1 with a matching certificate SAN. Existing HTTPS policy permits the
container listener `0.0.0.0:8443`; the loopback-only HTTP development policy is
unchanged, not broadened for Docker. Never disable TLS trust in a browser.

The DSN file contains a URL for the `luson` database/user at Compose hostname
`db`, port5432, with its privately supplied password URL-encoded correctly.
Internal PostgreSQL transport is on the private Docker network; the browser
transport terminates TLS in Go. PostgreSQL TLS/runtime-role provisioning is not
implemented. Do not put the URL/password into command arguments, environment,
shell history, source, screenshots, logs or Compose config dumps.

### Go file-provider rules

All three binaries use `config.LoadEnv`. Exactly one **present** variable among
`LUSON_DATABASE_URL` and `LUSON_DATABASE_URL_FILE` is accepted: even two empty
variables are an error. Environment DSNs are retained only for backward-
compatible generated tests; operational database passwords use files.

The file must be a regular, last-component nonsymlink, current-runtime-UID-owned
file with exactly0600 permission bits and no special permission bits. Size is
1–4096 bytes **including** an optional single terminal LF. No CR, extra LF,
embedded NUL, empty value or surrounding whitespace is accepted. The remaining
raw URL must pass PostgreSQL URL/driver parsing. Parent directories must remain
private and controlled. The open inode is checked after a NOFOLLOW/nonblocking
open; every loader failure uses fixed sanitized text, not paths or driver errors.

Standalone Compose file secrets are bind mounts: Docker documents that their
`uid`, `gid`, and `mode` attributes are ignored. **Do not assume0444 remapping.**
Set real host-file ownership/readability to the selected app UID/GID and0600.
The image defaults1000:1000; optional identity settings reject zero or a mismatch
with the running process. TLS files must also be readable by that identity.
The PostgreSQL image's root entrypoint reads its separate password file before
switching to its PostgreSQL user; the DB URL secret is mounted only into app.

## Build, initialize and provision

These are operator steps, **not evidence that the candidate was executed**:

```sh
docker compose build app
docker compose up -d db app
docker compose exec -it app /usr/local/bin/bootstrap-accounts
```

Run bootstrap only from a private controlling terminal. The unchanged CLI hides
nine inputs: username/password/confirmation for Almacén, Sucursal A, Sucursal B.
Supply three distinct valid usernames and passwords yourself; never record the
terminal or pass credentials through argv/environment. Provisioning is once-
only and atomic; complete or partial account replay is refused. No account is
created by server startup. Schema/trial initialization is repeat-safe and never
resets an existing balance. Optional explicit inspection:

```sh
docker compose exec app /usr/local/bin/migrate check
```

Do not dump configuration or database/account/session values to shared output.
Ordinary `docker compose up -d --force-recreate db app` preserves the named
volume; stop services without removing storage when ending a local session.
There is intentionally **no volume-deletion, pruning or data-reset recipe**.
A persistent volume is not a backup; operational backup/recovery remains later
work. The test harness never uses an operational volume or Compose project.

## Image and public-directory boundary

Observed official tags are node26.8.1-bookworm-slim, golang1.27.0-bookworm and
postgres17.9-bookworm; Linux amd64 manifests were confirmed before this work,
not builds. The multi-stage image compiles existing pinned React and CGO-disabled
Go server/bootstrap/migrate binaries. The scratch final image runs nonroot with
root-owned0555 assets/binaries and read-only root filesystem; no source, shell,
Node or writable business files. Credentials/certificates are external mounts,
never build arguments or copied layers. `.dockerignore` denies unrelated root
assets, Git/.atl/backups/odd, secrets, evidence, caches, modules and existing dist.

The trusted compiled directory is snapshotted/validated at startup. `/` and
`/index.html` revalidate; actual hashed JS/CSS/WOFF/WOFF2 assets are immutable.
Unknown/missing/stale paths return404, not a invented SPA route. Unsafe separators,
dot paths, symlinks, source/maps/private paths are refused. GET/HEAD preserve MIME,
length and nosniff; static methods other than GET/HEAD get405/Allow. Canonical
`/api` and `/api/*` remain API-owned, including unknown404s. No private business
information is stored in the public directory.

## External verifier ownership

The separately authorized verifier runs `apps/web/e2e/l05-run-compose.mjs` only
with the active parent manifest. It uses an external0700 fixture,0600 generated
TEST secrets, trusted TEST TLS and private Chromium trust store, builds once,
boots exactly app/db and verifies actual browser/auth/static/persistence behavior.
Every effect/SQL/recreation/cleanup requires fresh parent network and real-volume
inspection, plus exact full container IDs/custom and standard Compose labels.
Test overrides reference parent resources as **external**. Container recreation
never removes the volume; the harness removes only its exact containers,
processes and private files. The built image is retained for parent disposition.
Only the parent retires the empty bound network and unreferenced test volume.
