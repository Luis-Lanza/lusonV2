#!/usr/bin/env bash
# One complete end-to-end cycle of the browser suite: a database this script
# owns, a server it starts itself, the suite, and a teardown that always removes
# both.
#
# The suite in apps/web/e2e drives whatever origin `LUSON_E2E_ORIGIN` names
# (read by apps/web/playwright.config.ts and by the `origin` constant of
# apps/web/e2e/warranty/harness.ts, and by nothing else) and never boots
# anything. This script is that "whatever": it does not reuse a developer's
# database, it never touches luson-local-db or its volume, and it destroys
# everything it creates, even on failure.
#
# Why the origin is a variable and the port is chosen here
#   The origin the suite drives is read from LUSON_E2E_ORIGIN, defaulting to
#   http://127.0.0.1:8080 (the address every documented local command uses).
#   This script states that variable for the server it starts, so the browser
#   and the specs' API contexts always reach the same server: a run that states
#   nothing picks a free loopback port from the kernel, which is what keeps a
#   nightly from colliding with a developer's server on 8080. When the port is
#   already held -- by a stated origin or by a race after the kernel handed it
#   out -- the script names the holder and refuses: it never stops a process it
#   did not start.
#
# The database
#   One ephemeral PostgreSQL service container, data directory on a tmpfs,
#   loopback-only published port, so removing the container is exactly what drops
#   the database: no volume, no leftover cluster, nothing shared with anything
#   else. The audited Go fixture (scripts/test-pg-fixture.sh) is deliberately not
#   reused: it publishes no port, admits only the Go tests' manifest, pins uid
#   1000 with a private root under /home/luis and allows one fixture at a time.
#   It exists to prove the Go suites' admission contract, not to serve a browser.
#   The container here follows the shape the repository already uses for an owned
#   trial database (apps/web/e2e/run-real.mjs).
#
# The three accounts
#   apps/api/cmd/bootstrap-accounts is the only account creator and it reads
#   /dev/tty by design: no arguments, no credential environment, no piped input.
#   The script reuses apps/web/e2e/bootstrap-pty.py, the private controlling-PTY
#   driver the repository already ships for this exact CLI, and hands it the
#   three credential pairs over an inherited file descriptor (fd 3) as JSON. The
#   credentials are in neither argv nor the environment, the driver only answers
#   a prompt after the terminal has stopped echoing, and nothing is recorded. The
#   three accounts, and their passwords, are the suite's own: harness.ts signs in
#   with them, and this script fails when the two disagree.
#
# Usage:
#   ./scripts/test-e2e.sh                  # the whole cycle
#   ./scripts/test-e2e.sh --list           # same cycle, Playwright only lists
#   ./scripts/test-e2e.sh --grep 'venta'   # extra arguments go to `playwright test`
#
# Environment:
#   LUSON_E2E_SKIP_BUILD=1   reuse an existing apps/web/dist instead of building
#   LUSON_E2E_OUTPUT_DIR     where Playwright writes traces and screenshots; the
#                            script keeps this directory instead of deleting it
#   LUSON_E2E_ORIGIN         the origin to serve and to hand the suite, as
#                            http://127.0.0.1:<port>; when it is not stated the
#                            script asks the kernel for a free loopback port
#
# Requirements: docker (no sudo), go, node/npm/npx, python3, curl.
set -euo pipefail

readonly ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
readonly SCRIPT_STARTED=$(date +%s%3N)

# The origin variable the suite reads. It is stated, never compiled: see above.
readonly ORIGIN_VARIABLE=LUSON_E2E_ORIGIN
readonly DEFAULT_ORIGIN='http://127.0.0.1:8080'
readonly ORIGIN_SHAPE='^http://127\.0\.0\.1:([1-9][0-9]{0,4})$'

readonly PG_IMAGE=postgres:17.9-bookworm
readonly PG_NAME_PREFIX=luson-e2e-pg
readonly PG_NAME_RE='^luson-e2e-pg-[0-9a-f]{8}$'
readonly PG_USER=luson_e2e
readonly PG_DATABASE=luson_e2e
readonly OWNER_LABEL=luson.e2e.owner=luson-e2e

readonly HARNESS="$ROOT/apps/web/e2e/warranty/harness.ts"
readonly BOOTSTRAP_PTY="$ROOT/apps/web/e2e/bootstrap-pty.py"
readonly WEB_DIR="$ROOT/apps/web/dist"

# The credentials the suite signs in with, in the order the CLI provisions them
# (Almacén, Sucursal A, Sucursal B: bootstrap.Provision assigns locations 1,2,3).
# Never echo these; keep them out of argv and out of the environment.
readonly ACCOUNT_USERNAMES=(bot_almacen bot_sucursal_a bot_sucursal_b)
readonly ACCOUNT_PASSWORDS=('Bot.Almacen.2026' 'Bot.SucursalA.2026' 'Bot.SucursalB.2026')

TMP=''
API_PID=''
API_STARTED=0
SUITE_PID=''
PG_NAME=''
PG_ID=''
OUTPUT_DIR=''
OUTPUT_OWNED=0
PHASE_LABEL=''
PHASE_STARTED=0

log() { printf 'test-e2e: %s\n' "$*" >&2; }
die() {
  log "error: $*"
  exit 1
}
require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}
clock() { date +%s%3N; }
elapsed_seconds() { printf '%d.%03d' "$((($1) / 1000))" "$((($1) % 1000))"; }
phase() {
  PHASE_LABEL=$1
  PHASE_STARTED=$(clock)
  log "==> $1"
}
phase_done() {
  log "    $PHASE_LABEL: $(elapsed_seconds "$(($(clock) - PHASE_STARTED))")s"
}

# A loopback port nobody is listening on: binding port zero is the only way to
# learn which one the kernel handed out. It is probed again before anything
# starts, and a holder is still a refusal, never a kill.
free_port() {
  python3 - <<'PY'
import socket
probe = socket.socket()
try:
    probe.bind(('127.0.0.1', 0))
    print(probe.getsockname()[1])
finally:
    probe.close()
PY
}

# True when anything accepts a TCP connection on the served port.
port_busy() {
  (exec 3<>"/dev/tcp/127.0.0.1/${PORT}") 2>/dev/null
}

# The pid listening on the port, when this host lets us name it.
port_holder() {
  command -v ss >/dev/null 2>&1 || return 0
  ss -ltnpH "sport = :${PORT}" 2>/dev/null | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' | head -n 1
}

# ---------------------------------------------------------------------------
# Teardown: stop what this script started, and only that.
# ---------------------------------------------------------------------------
teardown() {
  local status=$? failures=0 attempt remaining
  trap - EXIT INT TERM HUP
  set +e
  log '==> teardown'

  # A browser suite interrupted by a signal is ours to stop first.
  if [ -n "$SUITE_PID" ] && kill -0 "$SUITE_PID" 2>/dev/null; then
    kill -TERM "$SUITE_PID" 2>/dev/null
    for attempt in $(seq 1 100); do
      kill -0 "$SUITE_PID" 2>/dev/null || break
      sleep 0.1
    done
    kill -0 "$SUITE_PID" 2>/dev/null && kill -KILL "$SUITE_PID" 2>/dev/null
    log 'teardown: the interrupted suite run was stopped'
  fi

  # The API: SIGTERM, then wait, then SIGKILL -- the ordinary path a deployment
  # uses. The pid was started here; nothing else is ever signalled.
  if [ "$API_STARTED" = 1 ] && [ -n "$API_PID" ]; then
    if kill -0 "$API_PID" 2>/dev/null; then
      kill -TERM "$API_PID" 2>/dev/null
      for attempt in $(seq 1 150); do
        kill -0 "$API_PID" 2>/dev/null || break
        sleep 0.1
      done
      if kill -0 "$API_PID" 2>/dev/null; then
        log "teardown: api pid ${API_PID} ignored SIGTERM; sending SIGKILL"
        kill -KILL "$API_PID" 2>/dev/null
      fi
    fi
    wait "$API_PID" 2>/dev/null
    if kill -0 "$API_PID" 2>/dev/null; then
      log "teardown: api pid ${API_PID} survived"
      failures=$((failures + 1))
    else
      log "teardown: api pid ${API_PID} stopped"
    fi
  fi
  if port_busy; then
    log "teardown: 127.0.0.1:${PORT} still accepts connections"
    failures=$((failures + 1))
  else
    log "teardown: 127.0.0.1:${PORT} is free"
  fi

  # The database. Its data directory is a tmpfs, so removing the container is
  # what drops it: no volume, no cluster left behind. Removal addresses the exact
  # generated name and nothing else, and a Docker that cannot confirm the end
  # state is reported instead of being read as success.
  if [ -n "$PG_NAME" ]; then
    if printf '%s' "$PG_NAME" | grep -Eq "$PG_NAME_RE"; then
      docker rm -f "$PG_NAME" >/dev/null 2>&1
      if ! remaining=$(docker ps -aq --filter "name=^${PG_NAME}$" 2>/dev/null); then
        log "teardown: docker could not confirm that container ${PG_NAME} is gone"
        failures=$((failures + 1))
      elif [ -n "$remaining" ]; then
        log "teardown: container ${PG_NAME} survived"
        failures=$((failures + 1))
      else
        log "teardown: container ${PG_NAME} removed; its tmpfs data directory went with it"
      fi
    else
      log 'teardown: refusing to remove an unvalidated container name'
      failures=$((failures + 1))
    fi
  fi

  # The private workspace: DSN file, account hand-off, server log, sessions.
  if [ -n "$TMP" ] && [ -d "$TMP" ]; then
    case "$TMP" in
      */luson-e2e-*)
        rm -rf -- "$TMP" && log "teardown: private directory ${TMP} removed"
        ;;
      *)
        log "teardown: refusing to remove an unexpected directory ${TMP}"
        failures=$((failures + 1))
        ;;
    esac
  fi
  if [ "$OUTPUT_OWNED" = 0 ] && [ -n "$OUTPUT_DIR" ]; then
    log "teardown: Playwright traces and screenshots kept in ${OUTPUT_DIR}"
  fi

  if [ "$failures" -gt 0 ]; then
    log "teardown: ${failures} leftover(s); this run is not clean"
    [ "$status" -eq 0 ] && status=1
  else
    log 'teardown: nothing this run created is left behind'
  fi
  exit "$status"
}

# ---------------------------------------------------------------------------
# Preconditions
# ---------------------------------------------------------------------------
for tool in docker go node npx npm curl python3 od; do
  require_command "$tool"
done

# The origin: the one the operator stated, or a free port of this run's own.
if [ -n "${LUSON_E2E_ORIGIN:-}" ]; then
  ORIGIN=$LUSON_E2E_ORIGIN
  ORIGIN_SOURCE="stated in ${ORIGIN_VARIABLE}"
else
  ORIGIN="http://127.0.0.1:$(free_port)"
  ORIGIN_SOURCE="a free port this run chose, so a nightly never takes yours (${ORIGIN_VARIABLE} is unset; its default is ${DEFAULT_ORIGIN})"
fi
[[ "$ORIGIN" =~ $ORIGIN_SHAPE ]] ||
  die "${ORIGIN_VARIABLE} must be http://127.0.0.1:<port>, got ${ORIGIN}"
PORT=${BASH_REMATCH[1]}
readonly ORIGIN PORT
readonly LISTEN="127.0.0.1:${PORT}"

[ -f "$HARNESS" ] || die "missing ${HARNESS}"
[ -f "$BOOTSTRAP_PTY" ] || die "missing ${BOOTSTRAP_PTY} (the private controlling-PTY driver)"
[ -d "$ROOT/apps/web/node_modules" ] ||
  die 'apps/web/node_modules is missing; run `npm --prefix apps/web ci` first'

docker info >/dev/null 2>&1 ||
  die 'docker is not reachable for this user; this script never uses sudo'

# The accounts this script provisions have to be the ones the suite signs in
# with, or the browser fails at the login form for a reason that is ours.
for index in 0 1 2; do
  username=${ACCOUNT_USERNAMES[$index]}
  password=${ACCOUNT_PASSWORDS[$index]}
  grep -Fq "username: '${username}', password: '${password}'" "$HARNESS" ||
    die "${HARNESS} signs in as ${username} with another password; keep the two in step"
done
unset username password

# The port is this run's to hold: if something already answers on it, that is a
# refusal, not something this script may resolve by stopping the owner.
if port_busy; then
  holder=$(port_holder)
  die "something is already listening on 127.0.0.1:${PORT}${holder:+ (pid ${holder})}; the suite drives exactly that origin and this script never stops a process it did not start"
fi

TMP=$(mktemp -d "${TMPDIR:-/tmp}/luson-e2e-XXXXXXXX") || die 'could not create a private directory'
chmod 700 "$TMP"
trap teardown EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

if [ -n "${LUSON_E2E_OUTPUT_DIR:-}" ]; then
  OUTPUT_DIR=$LUSON_E2E_OUTPUT_DIR
  case "$OUTPUT_DIR" in
    "$TMP"/*) die 'LUSON_E2E_OUTPUT_DIR must not live inside the private directory this script deletes' ;;
  esac
else
  OUTPUT_DIR="$TMP/playwright"
  OUTPUT_OWNED=1
fi
readonly SESSION_DIR="$TMP/sessions"
mkdir -p "$OUTPUT_DIR" "$SESSION_DIR"

RUN_ID=$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')
PG_NAME="${PG_NAME_PREFIX}-${RUN_ID}"

log "origin ${ORIGIN}: ${ORIGIN_SOURCE}"
log "private directory ${TMP}"

# ---------------------------------------------------------------------------
# 1. An ephemeral PostgreSQL this run owns
# ---------------------------------------------------------------------------
phase 'start an ephemeral PostgreSQL'
if ! docker image inspect "$PG_IMAGE" >/dev/null 2>&1; then
  log "pulling ${PG_IMAGE}"
  docker pull "$PG_IMAGE" >/dev/null
fi
DB_PASSWORD=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')
# The password reaches the container through the docker client's environment,
# never its argv, the way apps/web/e2e/run-real.mjs creates its own trial
# database. What the server reads is the private 0600 DSN file below.
POSTGRES_PASSWORD="$DB_PASSWORD" docker create \
  --name "$PG_NAME" \
  --label "$OWNER_LABEL" \
  --label 'luson.e2e.cycle=test-e2e' \
  --tmpfs /var/lib/postgresql/data:rw \
  --publish '127.0.0.1::5432' \
  --env "POSTGRES_USER=${PG_USER}" \
  --env "POSTGRES_DB=${PG_DATABASE}" \
  --env 'POSTGRES_PASSWORD' \
  "$PG_IMAGE" >/dev/null
PG_ID=$(docker inspect --type=container --format '{{.Id}}' "$PG_NAME")
[ -n "$PG_ID" ] || die 'the database container could not be inspected'
docker start "$PG_ID" >/dev/null

PG_HOST_PORT=$(docker port "$PG_ID" 5432/tcp | sed -n 's/^127\.0\.0\.1:\([0-9][0-9]*\)$/\1/p' | head -n 1)
[ -n "$PG_HOST_PORT" ] || die 'the database container published no loopback port'

ready=0
for attempt in $(seq 1 120); do
  if [ "$(docker inspect --format '{{.State.Running}}' "$PG_ID" 2>/dev/null)" != true ]; then
    die "database container ${PG_NAME} stopped during startup"
  fi
  if docker exec "$PG_ID" pg_isready -U "$PG_USER" -d "$PG_DATABASE" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.5
done
[ "$ready" = 1 ] || die 'the database did not become ready'

printf 'postgres://%s:%s@127.0.0.1:%s/%s?sslmode=disable\n' \
  "$PG_USER" "$DB_PASSWORD" "$PG_HOST_PORT" "$PG_DATABASE" >"$TMP/database-url"
chmod 600 "$TMP/database-url"
unset DB_PASSWORD
log "container ${PG_NAME} ready on 127.0.0.1:${PG_HOST_PORT}, data directory on tmpfs"
phase_done

# ---------------------------------------------------------------------------
# 2. Binaries, migrations to head, catalogue, three accounts
# ---------------------------------------------------------------------------
phase 'build the API commands'
go -C "$ROOT/apps/api" build -o "$TMP/server" ./cmd/server
go -C "$ROOT/apps/api" build -o "$TMP/migrate" ./cmd/migrate
go -C "$ROOT/apps/api" build -o "$TMP/bootstrap-accounts" ./cmd/bootstrap-accounts
phase_done

phase 'migrate to the head of apps/api/migrations and seed the trial catalogue'
env -u LUSON_DATABASE_URL \
  LUSON_PROFILE=local-trial \
  LUSON_DATABASE_URL_FILE="$TMP/database-url" \
  "$TMP/migrate" initialize >&2
env -u LUSON_DATABASE_URL \
  LUSON_PROFILE=local-trial \
  LUSON_DATABASE_URL_FILE="$TMP/database-url" \
  "$TMP/migrate" check >&2
applied=$(docker exec "$PG_ID" psql -U "$PG_USER" -d "$PG_DATABASE" -X -A -t \
  -c 'SELECT count(*) FROM schema_migrations')
expected=$(find "$ROOT/apps/api/migrations" -maxdepth 1 -name '*.sql' | wc -l | tr -d ' ')
[ "$applied" = "$expected" ] ||
  die "the database is at migration ${applied} of ${expected}"
log "schema_migrations holds ${applied} of ${expected} migrations: the database is at the head"
phase_done

phase 'provision the three accounts over a private controlling terminal'
json='['
for index in 0 1 2; do
  [ "$index" = 0 ] || json+=','
  json+="{\"username\":\"${ACCOUNT_USERNAMES[$index]}\",\"password\":\"${ACCOUNT_PASSWORDS[$index]}\"}"
done
json+=']'
printf '%s' "$json" >"$TMP/accounts.json"
chmod 600 "$TMP/accounts.json"
unset json
# fd 3 is the private channel: not argv, not the environment, not stdin.
env -u LUSON_DATABASE_URL \
  LUSON_PROFILE=local-trial \
  LUSON_DATABASE_URL_FILE="$TMP/database-url" \
  python3 "$BOOTSTRAP_PTY" "$TMP/bootstrap-accounts" 3<"$TMP/accounts.json"
rm -f -- "$TMP/accounts.json"

# Every account the CLI creates is meant to rotate its password at first login,
# and this suite signs in with the fixed passwords above instead of the rotation
# screen. The gate keeps its own coverage (apps/web/e2e/administration/
# password.spec.ts creates an account and walks the forced change), so only the
# three operator accounts of this run are cleared, and only in the database this
# run created.
docker exec "$PG_ID" psql -U "$PG_USER" -d "$PG_DATABASE" -X -v ON_ERROR_STOP=1 \
  -c "UPDATE auth_accounts SET must_change_password=false WHERE username IN ('bot_almacen','bot_sucursal_a','bot_sucursal_b')" \
  >/dev/null
accounts=$(docker exec "$PG_ID" psql -U "$PG_USER" -d "$PG_DATABASE" -X -A -t \
  -c "SELECT count(*) || ':' || count(*) FILTER (WHERE must_change_password) FROM auth_accounts")
[ "$accounts" = '3:0' ] ||
  die "expected three accounts with no forced rotation, found ${accounts}"
log 'three accounts provisioned and able to sign in'
phase_done

# ---------------------------------------------------------------------------
# 3. The compiled frontend the server caches at boot
# ---------------------------------------------------------------------------
phase 'build the frontend'
if [ "${LUSON_E2E_SKIP_BUILD:-0}" = 1 ] && [ -f "$WEB_DIR/index.html" ]; then
  log 'reusing the existing apps/web/dist (LUSON_E2E_SKIP_BUILD=1)'
else
  npm --prefix "$ROOT/apps/web" run build >&2
fi
[ -f "$WEB_DIR/index.html" ] || die "no compiled frontend in ${WEB_DIR}"
phase_done

# ---------------------------------------------------------------------------
# 4. The server, on the suite's own origin
# ---------------------------------------------------------------------------
phase 'start the API on the suite origin'
env -u LUSON_DATABASE_URL \
  LUSON_PROFILE=local-trial \
  LUSON_DATABASE_URL_FILE="$TMP/database-url" \
  LUSON_ORIGIN="$ORIGIN" \
  LUSON_LISTEN="$LISTEN" \
  LUSON_TLS_CERT= \
  LUSON_TLS_KEY= \
  LUSON_WEB_DIR="$WEB_DIR" \
  "$TMP/server" >"$TMP/server.log" 2>&1 &
API_PID=$!
API_STARTED=1

ready=0
for attempt in $(seq 1 240); do
  if ! kill -0 "$API_PID" 2>/dev/null; then
    log 'the API exited during startup; its last lines follow'
    tail -n 20 "$TMP/server.log" >&2
    die 'the API did not start'
  fi
  if curl -fsS -m 2 -o /dev/null "$ORIGIN/api/auth/session"; then
    ready=1
    break
  fi
  sleep 0.25
done
[ "$ready" = 1 ] || die 'the API never answered on its origin'

curl -fsS -m 5 -o "$TMP/served-index.html" "$ORIGIN/" || die 'GET / did not answer'
cmp -s "$TMP/served-index.html" "$WEB_DIR/index.html" ||
  die 'GET / did not serve the index.html of this build'
log "api pid ${API_PID} answering on ${ORIGIN} with the build in ${WEB_DIR}"
phase_done

# ---------------------------------------------------------------------------
# 5. Chromium, downloaded once and reused afterwards
# ---------------------------------------------------------------------------
phase 'prepare the Chromium build Playwright needs'
browser_executable=$(cd "$ROOT/apps/web" && node --input-type=module -e \
  'const { chromium } = await import("@playwright/test"); process.stdout.write(chromium.executablePath())') ||
  browser_executable=''
if [ -n "$browser_executable" ] && [ -x "$browser_executable" ]; then
  log "reusing the browser already installed at ${browser_executable}"
  # The download is what repeats; the system libraries are cheap to confirm and
  # are only confirmed where this host can install without a prompt.
  if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    (cd "$ROOT/apps/web" && npx playwright install-deps chromium) >&2
  else
    log 'skipping the system-dependency check: no passwordless sudo on this host'
  fi
else
  log 'installing Chromium and its system dependencies'
  (cd "$ROOT/apps/web" && npx playwright install --with-deps chromium) >&2
fi
phase_done

# ---------------------------------------------------------------------------
# 6. The suite
# ---------------------------------------------------------------------------
phase 'run the browser suite'
log "traces and screenshots: ${OUTPUT_DIR}"
log "sessions: ${SESSION_DIR}"
suite_started=$(clock)
(
  cd "$ROOT/apps/web" &&
    env \
      PLAYWRIGHT_OUTPUT_DIR="$OUTPUT_DIR" \
      PLAYWRIGHT_SESSION_DIR="$SESSION_DIR" \
      "${ORIGIN_VARIABLE}=${ORIGIN}" \
      npx playwright test "$@"
) &
SUITE_PID=$!
suite_status=0
wait "$SUITE_PID" || suite_status=$?
SUITE_PID=''
suite_millis=$(($(clock) - suite_started))
phase_done
log "suite exit ${suite_status} after $(elapsed_seconds "$suite_millis")s"
log "whole cycle $(elapsed_seconds "$(($(clock) - SCRIPT_STARTED))")s so far"

if [ "$suite_status" -ne 0 ]; then
  log 'the browser suite did not pass'
fi
exit "$suite_status"
