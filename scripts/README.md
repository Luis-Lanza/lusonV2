# Local scripts

## `test-pg-fixture.sh`

An ephemeral, audited PostgreSQL fixture for the database-backed Go tests in
`apps/api`. The admission contract lives in
`apps/api/internal/testpg/postgres.go`: it fails closed unless the manifest,
the private DSN file and live `docker inspect` output agree. `testpg` never
creates or destroys Docker objects, so this script owns the whole lifecycle.

```sh
./scripts/test-pg-fixture.sh up                 # print the manifest path
./scripts/test-pg-fixture.sh status             # what is left on this host
./scripts/test-pg-fixture.sh down               # remove everything
./scripts/test-pg-fixture.sh run -- go test ./...   # up, run, always down
```

From the repository root, `make test-pg` runs the whole Go suite this way.
See `apps/api/docs/testing.md` for the test-side rules.

### What `up` does

1. Generates an 8-hex `run_id` and creates the private directory
   `$HOME/.local/share/luson-transfer-tests-<run_id>/` with mode `0700`.
2. Creates `pgdata/` inside it and hands it to uid/gid 999 with mode `0700`,
   using a throwaway container that shares only that bind mount. PostgreSQL in
   the official image runs as uid 999 and the admission pins that owner.
3. Writes a random admin password to `pg-password` (`0600`, owner 1000).
4. Creates an internal bridge network named
   `luson-transfer-tests-<run_id>-net` with the fixed label set. No port is
   published anywhere.
5. Starts `luson-transfer-tests-<run_id>-pg` from `postgres:17.9-bookworm` on
   that network only, with `pgdata` bound `rw`/`rprivate` and the password file
   bound read-only from the private directory.
6. Waits for the container health check (`pg_isready`).
7. Reads the real network and container back with `docker inspect` and writes
   `manifest.json` (`0600`) with the real network id, container id, image id,
   IPAM, labels, mount and address. `admin-dsn` (`0600`, owner 1000) holds the
   `postgres://` URL for the admin database and role.
8. Re-checks every fact the admission validates before it prints the manifest
   path. On any failure it removes the partial container, network and
   directory, so a failed `up` leaves nothing behind.

`up` refuses to start while another fixture exists, so two runs can never share
or orphan objects: finish with `down` first.

`up` prints only the manifest path on standard output; diagnostics go to
standard error:

```sh
export LUSON_TEST_PG_MANIFEST=$(./scripts/test-pg-fixture.sh up)
```

### What `down` does

`down` removes the container, the network, the private directory and the
manifest for every fixture run it finds, including a run whose `up` crashed
before writing a manifest (objects are addressed by the names derived from the
validated run id, plus the fixed labels). It then asserts that no fixture
container, network or directory remains and exits non-zero if one does.

### What `run` does

`run -- <command>` brings the fixture up, unsets every inherited `PG*`
variable, exports `LUSON_TEST_PG_MANIFEST` and executes the command. It tears
the fixture down afterwards even when the command fails or is interrupted, and
returns the command's exit status.

### Requirements and safety

- Docker reachable by the current user, without `sudo`. The script never calls
  `sudo`.
- `jq`, `od` and `stat` (coreutils).
- The image `postgres:17.9-bookworm` must be present locally; the script never
  pulls anything.
- Everything else is created fresh and removed again: no volume, no published
  port, no persistent service.
- The development database (`luson-dev-db`) and its volume are never touched.
  The fixture uses its own container, network, private directory and password.
- The script never modifies `apps/api/internal/testpg`, product code, migrations
  or the web app.

### Files it creates

| Path | Mode / owner | Purpose |
| --- | --- | --- |
| `$HOME/.local/share/luson-transfer-tests-<run_id>/` | `0700`, 1000 | private root |
| `.../pgdata/` | `0700`, 999 | PostgreSQL data bind source |
| `.../pg-password` | `0600`, 1000 | random admin password |
| `.../admin-dsn` | `0600`, 1000 | admin connection URL |
| `.../manifest.json` | `0600`, 1000 | versioned fixture manifest |

Nothing is written inside the repository.
