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
6. Waits for the container health check (`pg_isready`). A container Docker marks
   `unhealthy` fails the command immediately, with the last health-check output,
   instead of burning the 120 second budget; a container that stops or never
   reports health fails at once too.
7. Reads the real network and container back with `docker inspect` and writes
   `manifest.json` (`0600`) with the real network id, container id, image id,
   IPAM, labels, mount and address. `admin-dsn` (`0600`, owner 1000) holds the
   `postgres://` URL for the admin database and role.
8. Re-checks every fact the admission validates before it prints the manifest
   path. On any failure it removes the partial container, network and
   directory, so a failed `up` leaves nothing behind — and if that cleanup
   itself fails, it says what remains, names the `run_id` and exits non-zero
   instead of only reporting the original error.

`up` refuses to start while another fixture exists, so two runs can never share
or orphan objects: finish with `down` first. That refusal is not a racy check:
`up`, `down` and `run` hold an advisory lock on
`$HOME/.local/share/luson-transfer-tests.lock` for the whole creating or
removing step, so a second concurrent invocation fails fast instead of inventing
a second run id. The lock lives in the kernel, so a crashed or killed invocation
never leaves it stuck.

`up` prints only the manifest path on standard output; diagnostics go to
standard error:

```sh
export LUSON_TEST_PG_MANIFEST=$(./scripts/test-pg-fixture.sh up)
```

### What `down` does

`down` removes the container, the network, the private directory and the
manifest for every fixture run it finds, including a run whose `up` crashed
before writing a manifest: objects are addressed by the names derived from the
validated run id, or by the full fixed label set.

Removal targets are exact. An object is removed only when its generated name is
exactly `luson-transfer-tests-<run_id>-pg` / `-net` for a validated `run_id`, or
when it carries all five fixture labels. A Docker object whose name merely
*contains* the fixture prefix is never touched.

`down` takes the same advisory lock, so it cannot run while another `run` holds
the fixture, and it never reaches another run's objects.

Every removal step is checked. If Docker refuses to remove a container or a
network, or a private path cannot be deleted, `down` retries it in the leftover
pass and then re-checks the end state: it names whatever is still present and
exits non-zero, and it never reports a leftover that is gone. A failed removal
step whose object the retry pass did remove is a clean teardown, not a failure.

On a clean host `down` is a safe no-op: the state root `$HOME/.local/share` is
created by whichever command takes the lock first, so `up`, `down` and `run` all
work on a host where no fixture ever ran.

### What `run` does

`run -- <command>` brings the fixture up, unsets every inherited `PG*`
variable, exports `LUSON_TEST_PG_MANIFEST` and executes the command. It tears
the fixture down afterwards even when the command fails or is interrupted, and
returns the command's exit status.

A teardown failure is never swallowed: `run` names the leftovers and exits
non-zero even when the command itself succeeded, so `make test-pg` cannot report
success while the fixture container, network or private directory is still
there. An interrupted `run` is torn down as well, including a signal that
arrives while the fixture is still being created and no manifest path exists yet.

The command `run` executes never inherits the lock descriptor. A wrapper killed
while the command keeps running therefore leaves no surviving process holding
the advisory lock, and the next `up`, `down` or `run` is not blocked by it.

### In GitHub Actions

`.github/workflows/verify.yml` runs this fixture in the `go-postgresql` job on
every pull request and every push to `master`, so a pull request that breaks a
migration fails CI. The job runs `make test-pg`, the same command as above.

The admission hardcodes two facts that a hosted runner does not provide: uid
1000, and the private root under the literal `/home/luis/.local/share`. The
runner user is uid 1001, and `apps/api/internal/testpg` is never relaxed. The
job therefore:

1. creates a real uid-1000 account whose home is `/home/luis` (reusing one only
   if its home already matches that path, and failing with an `::error::`
   otherwise), adds it to the `docker` group, and proves `id -u` is 1000 and
   `docker info` works for it before running anything;
2. gives it its own copy of the checkout under `/home/luis/work`, because the
   checkout belongs to the runner user and the runner's home permissions are
   not something the workflow controls — the copy is re-owned, no fixture path
   ever is;
3. pulls `postgres:17.9-bookworm`, because this script never pulls.

`run` then does the whole cycle once, with the Makefile's `-count=1`, and a
final `if: always()` step runs `down`. That step also runs after a failure or a
cancellation, and it exits non-zero when a container, network or private
directory survived, so a green job cannot hide a leftover fixture. The job has
an explicit `timeout-minutes: 25` cap instead of the six-hour default.

### Requirements and safety

- Docker reachable by the current user, without `sudo`. The script never calls
  `sudo`.
- `jq`, `od`, `stat`, `dd` (coreutils) and `flock` (util-linux).
- The image `postgres:17.9-bookworm` must be present locally; the script never
  pulls anything. The GitHub Actions job pulls it in a step of its own.
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
| `$HOME/.local/share/luson-transfer-tests.lock` | `0600` | advisory lock (`flock`) |

Nothing is written inside the repository. The lock file holds the pid of the
current holder as a single fixed-width line that is rewritten without truncating
the file and blanked while the lock is still held, so a concurrent invocation
that is refused always names the live holder instead of reading an empty file,
and releasing never erases a pid written by the next holder. The lock itself is
kernel state, so it cannot go stale and a killed invocation never blocks the
next one.
