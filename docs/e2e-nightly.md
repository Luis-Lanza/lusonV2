# The nightly end-to-end browser suite

`scripts/test-e2e.sh` runs the whole Playwright suite in `apps/web/e2e` once,
against a database it creates and destroys. `.github/workflows/e2e.yml` calls
that same script once a night and on demand.

This suite is **not** a pull-request gate, and it is **not** a substitute for the
database-backed Go suites.

## Run it locally

From the repository root, with Docker reachable without `sudo` and
`apps/web/node_modules` already installed (`npm --prefix apps/web ci`):

```sh
./scripts/test-e2e.sh
```

Everything else is done for you. If the browser is already installed the script
reuses it; extra arguments go straight to `npx playwright test`, so a single
group can be re-run without a full cycle:

```sh
./scripts/test-e2e.sh --grep 'venta'
./scripts/test-e2e.sh --list          # same cycle, the suite only lists its tests
```

Two environment variables are honoured:

| Variable | Effect |
| --- | --- |
| `LUSON_E2E_SKIP_BUILD=1` | reuse an existing `apps/web/dist` instead of building |
| `LUSON_E2E_OUTPUT_DIR=<abs path>` | where Playwright writes traces and screenshots; the script keeps this directory instead of deleting it |
| `LUSON_E2E_ORIGIN=<origin>` | the origin to serve and to hand the suite, as `http://127.0.0.1:<port>`; unset means a free loopback port of the run's own |

### One origin variable, and a port the run chooses

The origin the suite drives is read from **`LUSON_E2E_ORIGIN`** by
`apps/web/playwright.config.ts` (`baseURL`) and by the `origin` constant every
spec's API context uses in `apps/web/e2e/warranty/harness.ts` — one variable,
read with one default, so the browser and the arrangements can never reach
different servers. Unset, it is `http://127.0.0.1:8080`, the address every
documented local command already uses; nothing about a local run changes.

A cycle without `LUSON_E2E_ORIGIN` binds port zero, learns the free loopback
port the kernel handed out, serves that origin and states it for the suite, so a
nightly never collides with a development server on `127.0.0.1:8080`. Stating
the variable runs the cycle on that origin instead (useful to reproduce a red
nightly exactly). Either way the port is this run's to hold: if something else
already answers on it, the script **refuses to start** — it names the holder and
exits instead of stopping a process it did not start.

## What one cycle does

1. **An ephemeral PostgreSQL.** One `postgres:17.9-bookworm` container named
   `luson-e2e-pg-<run id>`, data directory on a **tmpfs**, port published only on
   `127.0.0.1`. Removing the container is what drops the database: no volume and
   no cluster survives.
2. **The schema at the head of `apps/api/migrations`**, applied by
   `cmd/migrate initialize` under `LUSON_PROFILE=local-trial` (which also seeds
   the fictional catalogue), then `cmd/migrate check` and a count of
   `schema_migrations` against the number of `.sql` migrations on disk.
3. **The three accounts**, provisioned by `cmd/bootstrap-accounts` over a
   private controlling PTY (`apps/web/e2e/bootstrap-pty.py`, credentials on an
   inherited file descriptor, never argv or the environment), and then cleared of
   the forced first-login password rotation the CLI applies to every account,
   because the suite signs in with the fixed passwords in `harness.ts`. The
   rotation gate keeps its own coverage in
   `apps/web/e2e/administration/password.spec.ts`.
4. **The frontend build** (`npm run build`), which the API caches at boot: the
   script checks `GET /` serves the `index.html` it just built.
5. **The API** in the background with `LUSON_PROFILE=local-trial`, a private
   `LUSON_DATABASE_URL_FILE`, `LUSON_ORIGIN`/`LUSON_LISTEN` on the suite's
   origin, and `LUSON_WEB_DIR` on the build, then polled until it answers.
6. **Chromium**, downloaded only when the executable Playwright expects is
   missing (and `--with-deps` only on that path); the workflow caches
   `~/.cache/ms-playwright` on the lockfile hash so a nightly run does not
   download it again.
7. **`npx playwright test`**, with fresh session and output directories inside
   the private workspace, so a cookie from another database is never reused and
   a red run leaves the worktree clean.
8. **Teardown**, always, on success, failure, `SIGINT` and `SIGTERM`: the suite
   is stopped, the API this script started is stopped (SIGTERM, wait, SIGKILL)
   and the port is re-probed, the container is removed by its exact generated
   name and its absence confirmed, and the private directory is deleted. A
   leftover makes the cycle exit non-zero rather than reporting a clean run.

The accounts the script provisions, and their passwords, are the ones
`apps/web/e2e/warranty/harness.ts` signs in with; the script fails before doing
anything if the two ever disagree.

### The audited Go fixture is deliberately not reused

`scripts/test-pg-fixture.sh` (`make test-pg`) is a different tool for a different
contract: it publishes no port, admits only the Go tests' manifest, pins uid 1000
with a private root under `/home/luis`, and allows one fixture at a time. It
exists to prove the Go suites' admission, not to serve a browser. The cycle above
therefore uses a plain service container shaped like the one
`apps/web/e2e/run-real.mjs` already creates for an owned trial database, and the
`e2e` workflow needs no uid-1000 preparation step for that reason.

## Continuous integration

`.github/workflows/e2e.yml` runs the script at `06:17 UTC` (02:17 in La Paz:
off the top of the hour, where GitHub queues scheduled runs, and finished before
the working day) and on `workflow_dispatch`. It has an explicit
`timeout-minutes` cap, caches the browsers, uploads traces and screenshots when
the run is red, and ends with an `if: always()` step that proves no database
container survived the job. It carries no secrets: every credential it uses is
an ephemeral local-trial one created inside the run.

## What it does not cover

- **It is not a pull-request check.** It boots a real server, PostgreSQL and
  Chromium, mutates stock in every spec, and takes far longer than
  `verify.yml`. Running it per pull request would turn every red into a queue and
  every green into a coincidence of a shared database. A red nightly needs a
  human to look at it; nothing blocks a merge on it.
- **It does not replace the fixture-based Go suites.** `make test-pg` proves the
  migration and query behaviour under `internal/testpg`'s audited admission, with
  one isolated database per test and the whole suite in one fixture cycle. This
  script instead applies the migrations once, to one database, and then exercises
  screens. A migration that breaks an invariant only a Go suite asserts stays
  green here.
- **It does not run the fast gates.** `npm run lint`, `npm test`, `gofmt`,
  `go vet`, `go build ./...` and the R05 suites are `verify.yml`'s job. This
  cycle only builds, and only because the API serves the build.
- **One browser.** Chromium only: no Firefox, no WebKit, and no mobile device
  emulation beyond the viewports the specs themselves set.
- **It proves one process, one loopback origin, plain HTTP.** No TLS, no reverse
  proxy, no multiple application replicas, no operator-provisioned accounts, no
  real stock and no backups.
- **Nothing survives a cycle.** The database is dropped by design, so a cycle
  cannot prove that data persists across a restart or an upgrade, and two back
  to back cycles do not accumulate history. The one thing that does persist is
  the Chromium download and the build output.
- **One origin, stated once.** The suite reads `LUSON_E2E_ORIGIN` (default
  `http://127.0.0.1:8080`) and nothing else, and a cycle either serves a free
  port it chose or the origin you stated. It still needs that port free: a
  server already listening there is a hard stop, not something the script
  resolves by stopping it.
- **A cancelled job can outlive its teardown.** The proof is by end state: the
  script's trap runs on `SIGTERM`, and the workflow's final step fails the job if
  a container labelled `luson.e2e.owner=luson-e2e` is still on the runner. What a
  cancellation cannot undo is a browser or a build cache left in the runner's
  temporary storage, which the runner discards anyway.
