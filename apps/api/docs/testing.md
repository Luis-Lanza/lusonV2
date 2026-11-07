# Testing the API

`go test ./...` from `apps/api` runs two kinds of tests:

- pure tests, which never open a database;
- database-backed tests, which call `testpg.Open(t)` from
  `internal/testpg`.

The database-backed tests need an ephemeral PostgreSQL fixture. Without one they
fail closed: `testpg.Open` calls `t.Fatal("test PostgreSQL admission rejected")`
and never `t.Skip`. A suite that cannot reach an admitted fixture is red on
purpose, so a missing fixture can never look like a pass.

## Run the whole suite against a fixture

From the repository root:

```sh
make test-pg
```

That is one command: it creates the fixture, runs `go test ./...` in `apps/api`
with `LUSON_TEST_PG_MANIFEST` exported and every `PG*` variable unset, then
tears the fixture down even when the tests fail.

## Run it step by step

```sh
export LUSON_TEST_PG_MANIFEST=$(./scripts/test-pg-fixture.sh up)
cd apps/api && go test ./...
cd ../.. && ./scripts/test-pg-fixture.sh down
```

`up` prints only the manifest path on standard output; progress and errors go
to standard error.

`run` still performs the whole lifecycle for one command:

```sh
cd apps/api && ../../scripts/test-pg-fixture.sh run -- go test ./internal/db/
```

Nothing else is needed to run against the fixture: no `PGHOST`, no `PGPASSWORD`,
no `psql`, no `sudo`.

## What the fixture is

`scripts/test-pg-fixture.sh` starts one container from `postgres:17.9-bookworm`
on its own internal bridge network, with no published ports, and writes a
versioned manifest under
`$HOME/.local/share/luson-transfer-tests-<run_id>/`. `testpg` admits a test only
when the manifest, the private DSN file and live `docker inspect` output all
agree, so the manifest describes real objects:

| Fact | Value |
| --- | --- |
| Manifest schema | `luson.test-pg/v1`, status `active`, scope `transfer-requests/R01` |
| Labels | `luson.feature`, `luson.task`, `luson.owner`, `luson.lifecycle`, `luson.purpose` |
| Network | internal `bridge`, private CIDR, no published ports |
| Container | `postgres:17.9-bookworm`, healthy, address only on the fixture network |
| Data bind | `pgdata` owned by uid 999, `rw`, `rprivate` |
| Private directory | `0700`, owner 1000; DSN file `0600`, owner 1000 |
| Admin database and role | `luson_test` / `luson_test` |

Each test gets its own empty database (`luson_test_<32 hex>`), created and
dropped by `testpg`. Tests still own their schema: `db.Apply` and the seed run
inside the test, exactly as before.

The fixture never touches the development database (`luson-dev-db`) or its
volume: it has a different container, network, directory and password, and it
never publishes a port.

## Continuous integration

The `go-postgresql` job in `.github/workflows/verify.yml` runs `make test-pg` on
every pull request and every push to `master`, so a migration or query that
breaks a database-backed suite fails the pull request instead of staying green.
It runs exactly the command above against the same fixture, once, with
`-count=1`.

The admission is not relaxed for CI. `testpg` still requires `os.Getuid() ==
1000` and every private path under the literal `/home/luis/.local/share`, and
the hosted runner runs as uid 1001. The job therefore creates a real uid-1000
account whose home is `/home/luis`, adds it to the `docker` group, and gives it
its own copy of the checkout. The fixture creates its private directory, DSN
file and manifest as that uid 1000, so the metadata the admission checks is real
rather than rewritten.

One fixture cycle covers the whole suite, and an `if: always()` teardown step
runs after a failure or a cancellation as well. It fails loudly if a container,
network or private directory survived, so a green job cannot hide a leftover
fixture. The job has an explicit `timeout-minutes` cap rather than the six-hour
default.

## Rules for test authors

- Open a database only through `testpg.Open(t)`; never build a DSN from the
  environment.
- Never turn the admission into a skip. A red admission is the signal that the
  fixture is missing or has drifted.
- Do not export `PG*` variables. `testpg` rejects the fixture when any of
  `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, `PGPASSFILE`,
  `PGSERVICE`, `PGSERVICEFILE`, `PGSSLMODE`, `PGSSLCERT`, `PGSSLKEY`,
  `PGSSLROOTCERT`, `PGSSLCRL`, `PGOPTIONS`, `PGAPPNAME`,
  `PGTARGETSESSIONATTRS` or `PGCONNECT_TIMEOUT` is set, because pgx would
  otherwise consult an ambient connection provider. `run` unsets them for the
  child process.
- Keep schema state inside the database the test owns. Another test in the same
  package or another package may run concurrently.

## Interpreting a failure

- `test PostgreSQL admission rejected`, `test PostgreSQL network identity
  rejected`, `test PostgreSQL data directory metadata rejected`: the fixture is
  missing, was torn down, or drifted. Recreate it with `make test-pg-up`; see
  `scripts/README.md`.
- Any other error is a real test or product result. Do not weaken the test to
  make the fixture look good.

Teardown proof and recovery: `./scripts/test-pg-fixture.sh status` reports any
fixture container, network or manifest still on the host, and
`./scripts/test-pg-fixture.sh down` removes every one of them.
