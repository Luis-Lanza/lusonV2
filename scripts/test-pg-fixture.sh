#!/usr/bin/env bash
# Ephemeral, audited PostgreSQL fixture for the database-backed Go suites.
#
# Contract: apps/api/internal/testpg/postgres.go. That package fails closed
# (t.Fatal, never t.Skip) unless a manifest, a private DSN file and a live
# Docker network/container all agree with a fixed set of expectations. This
# script is the only owner of the fixture lifecycle; the package never creates
# or destroys Docker objects.
#
# The manifest is generated from `docker inspect` of the real network and the
# real container, so its ids, IPAM, labels, mount and image id describe objects
# that actually exist. Nothing here relaxes the admission, touches product code,
# runs migrations or reuses the development database.
#
# Teardown only addresses objects that are provably this fixture's own: the
# exact generated name (<prefix>-<run_id>-pg|-net) or the full fixed label set.
# A Docker object whose name merely contains the prefix is never removed.
#
# One fixture at a time is enforced with an advisory lock file held for the whole
# creating or removing command, so two concurrent invocations cannot race into
# separate run ids. The lock file carries the holder pid without ever being
# truncated, so a refused invocation can name who holds it, and the descriptor is
# never inherited by the command `run` executes, so a killed wrapper cannot leave
# the lock held by a surviving child.
#
# Teardown is judged by its end state, not by its steps: a removal that failed but
# left nothing behind is a clean teardown, and a leftover that survived the retry
# pass is reported by name and makes the command exit non-zero.
#
# ODD task: odd/tasks/postgres-test-fixture.md (S1-S3, T1-T2).
#
# Commands:
#   up                create the fixture, print the manifest path on stdout
#   down [run-id...]  remove container, network, private directory, manifest
#   run -- <command>  up, run <command> with the manifest exported, always down
#   status            report fixture objects currently on this host
set -euo pipefail

readonly IMAGE_REFERENCE=postgres:17.9-bookworm
readonly STATE_ROOT="${HOME}/.local/share"
readonly RUN_PREFIX=luson-transfer-tests
readonly RUN_ID_RE='^[a-f0-9]{8}$'
readonly LOCK_FILE="${STATE_ROOT}/${RUN_PREFIX}.lock"
readonly MANIFEST_NAME=manifest.json
readonly DSN_NAME=admin-dsn
readonly SECRET_NAME=pg-password
readonly DATA_DIR_NAME=pgdata
readonly ADMIN_DATABASE=luson_test
readonly ADMIN_ROLE=luson_test
readonly DATA_DIR_UID=999
readonly PRIVATE_DIR_MODE=700
readonly DATA_DIR_MODE=700
readonly SECRET_FILE_MODE=600
readonly HEALTH_ATTEMPTS=120
readonly HEALTH_RETRIES=30

# The exact label set the admission compares with reflect.DeepEqual. Order is
# irrelevant for Docker, but every pair is mandatory and no extra pair is legal.
readonly FIXTURE_LABELS=(
  'luson.feature=transfer-requests'
  'luson.task=R01'
  'luson.owner=parent-session-luson-v2'
  'luson.lifecycle=ephemeral-test-only'
  'luson.purpose=go-postgresql-tests'
)

DOCKER_LABEL_ARGS=()
for label in "${FIXTURE_LABELS[@]}"; do
  DOCKER_LABEL_ARGS+=(--label "${label}")
done

log() { printf 'test-pg: %s\n' "$*" >&2; }
die() {
  log "error: $*"
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

require_docker() {
  require_command docker
  docker info >/dev/null 2>&1 ||
    die "docker is not reachable for this user; the fixture never uses sudo"
}

require_commands() {
  require_command jq
  require_command od
  require_command stat
}

# LOCK_HELD is inherited by subshells and children: a subshell never takes the
# lock again and never drops the lock its parent is holding. Ownership is tracked
# by BASHPID, not $$, because a command-substitution subshell keeps the parent's
# $$ and would otherwise release the parent's lock.
LOCK_FD=""
LOCK_HELD=""
LOCK_OWNER_PID=""

# The lock file lives in the state root, which does not exist on a clean host and
# is not created by opening a file inside it. `up` used to be its only creator, so
# `down` and `run` failed outright on a clean host; every lock taker now makes sure
# the directory is there first.
ensure_state_root() {
  if [[ -d ${STATE_ROOT} ]]; then
    return 0
  fi
  mkdir -p -- "${STATE_ROOT}" 2>/dev/null ||
    die "cannot create the fixture state root ${STATE_ROOT}"
}

# The lock file holds one fixed-width line: the pid of the current holder, or
# blank space when nobody holds it. The line is rewritten without truncating the
# file, so a concurrent invocation that fails to take the lock reads a well-formed
# line instead of the empty file a truncating open leaves behind. It is only ever
# written by the process that holds the lock, and it is blanked while the lock is
# still held, so releasing can never erase a pid the next holder wrote.
readonly LOCK_PID_WIDTH=12
readonly LOCK_LINE_WIDTH=$((LOCK_PID_WIDTH + 1))

write_lock_pid() {
  printf '%-*s\n' "${LOCK_PID_WIDTH}" "$1" |
    dd of="${LOCK_FILE}" bs=1 count="${LOCK_LINE_WIDTH}" conv=notrunc status=none \
      2>/dev/null || true
}

read_lock_pid() {
  local raw
  raw=$(cat -- "${LOCK_FILE}" 2>/dev/null) || raw=""
  raw=${raw%%[[:space:]]*}
  if [[ ${raw} =~ ^[0-9]+$ ]]; then
    printf '%s' "${raw}"
  fi
}

# One fixture at a time, enforced by the kernel instead of by a leftover check
# that two racing invocations can both pass. Every command that creates or
# removes objects holds this lock while it does so; a second invocation fails
# fast instead of inventing a second run id.
acquire_lock() {
  if [[ -n ${LOCK_HELD} ]]; then
    return 0
  fi
  require_command flock
  require_command dd
  ensure_state_root
  # Append, never truncate: a refused invocation must not empty the file that
  # records who holds the lock.
  exec {LOCK_FD}>>"${LOCK_FILE}" ||
    die "cannot open the fixture lock file ${LOCK_FILE}"
  if ! flock --nonblock "${LOCK_FD}"; then
    local holder=""
    holder=$(read_lock_pid) || holder=""
    exec {LOCK_FD}>&-
    die "another fixture invocation is active${holder:+ (pid ${holder})}; wait for it to finish or inspect it with '$0 status'"
  fi
  LOCK_HELD=1
  LOCK_OWNER_PID=${BASHPID}
  write_lock_pid "${BASHPID}"
  chmod "${SECRET_FILE_MODE}" -- "${LOCK_FILE}" 2>/dev/null || true
}

# Only the process that took the lock drops it. The kernel also drops it when
# this process exits, so a crashed or killed invocation never leaves a stuck
# lock behind. The pid line is blanked before the unlock: blanking it afterwards
# could erase the pid of a holder that acquired the lock in between.
release_lock() {
  if [[ -n ${LOCK_HELD} && ${LOCK_OWNER_PID:-} == "${BASHPID}" ]]; then
    write_lock_pid ""
    flock --unlock "${LOCK_FD}" >/dev/null 2>&1 || true
    exec {LOCK_FD}>&-
    LOCK_HELD=""
    LOCK_OWNER_PID=""
  fi
}

new_run_id() {
  od -An -N4 -tx1 /dev/urandom | tr -d ' \n'
}

new_password() {
  od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
}

run_id_valid() {
  [[ ${1:-} =~ ${RUN_ID_RE} ]]
}

fixture_root() { printf '%s/%s-%s' "${STATE_ROOT}" "${RUN_PREFIX}" "$1"; }
network_name() { printf '%s-%s-net' "${RUN_PREFIX}" "$1"; }
container_name() { printf '%s-%s-pg' "${RUN_PREFIX}" "$1"; }

# PG* variables are ambient connection providers. The admission rejects the
# fixture when any of them is set, so the fixture never exports one and `run`
# scrubs inherited ones before starting a test process.
pg_env_names() {
  local name value
  while IFS='=' read -r name value; do
    case ${name} in
      PG*) printf '%s\n' "${name}" ;;
    esac
  done < <(env)
}

scrub_pg_env() {
  local name value
  while IFS='=' read -r name value; do
    case ${name} in
      PG*) unset "${name}" ;;
    esac
  done < <(env)
  local remaining
  remaining=$(pg_env_names)
  if [[ -n ${remaining} ]]; then
    die "PG* variables survived scrubbing: $(printf '%s ' "${remaining}")"
  fi
}

install_private_dir() {
  local path=$1
  mkdir -p -- "${path}"
  chmod "${PRIVATE_DIR_MODE}" -- "${path}"
}

# The postgres image runs PostgreSQL as uid/gid 999. The admission pins that
# owner on the bind source and rejects any group/other permission bit, so the
# directory is created as the invoking user and re-owned by a throwaway
# container that shares only this bind mount.
prepare_data_dir() {
  local pgdata=$1 owner
  install_private_dir "${pgdata}"
  docker run --rm --user 0 --network none --entrypoint /bin/sh \
    --mount "type=bind,source=${pgdata},target=/pgdata" \
    "${IMAGE_REFERENCE}" -c 'chown 999:999 /pgdata && chmod 700 /pgdata' >/dev/null
  owner=$(stat -c '%u:%a' -- "${pgdata}")
  [[ ${owner} == "${DATA_DIR_UID}:${DATA_DIR_MODE}" ]] ||
    die "pgdata metadata is ${owner}, expected ${DATA_DIR_UID}:${DATA_DIR_MODE}"
}

write_private_file() {
  local path=$1 content=$2
  (umask 077 && printf '%s' "${content}" >"${path}")
  chmod "${SECRET_FILE_MODE}" -- "${path}"
}

create_network() {
  local name=$1
  docker network create \
    --driver bridge \
    --internal \
    --ipam-driver default \
    "${DOCKER_LABEL_ARGS[@]}" \
    "${name}" >/dev/null
}

# The bind source is owned by uid 999 with no group/other bits, so the invoking
# user cannot delete its contents. A throwaway container sharing only that
# directory clears it before the private directory itself is removed.
remove_data_dir() {
  local root=$1
  if [[ ! -d ${root}/${DATA_DIR_NAME} ]]; then
    return 0
  fi
  log "clearing ${root}/${DATA_DIR_NAME}"
  if ! docker run --rm --user 0 --network none --entrypoint /bin/sh \
    --mount "type=bind,source=${root}/${DATA_DIR_NAME},target=/pgdata" \
    "${IMAGE_REFERENCE}" -c 'find /pgdata -mindepth 1 -delete' >/dev/null; then
    log "warning: could not clear ${root}/${DATA_DIR_NAME} from a throwaway container"
    return 1
  fi
  return 0
}

# Removes one private directory. Success is decided by the end state, not by the
# steps along the way: the throwaway-container clear can fail on a hiccup, or on a
# pgdata the invoking user may delete anyway, and the plain removal that follows is
# the belt and braces for exactly that. Only a path that is still there is a
# failure, so a clean end state is never reported as a leftover.
remove_private_dir() {
  local dir=$1 base run_id failed=0
  base=$(basename -- "${dir}")
  run_id=${base#"${RUN_PREFIX}"-}
  if [[ ${dir} != "${STATE_ROOT}/${RUN_PREFIX}-"* ]] ||
    ! run_id_valid "${run_id}" ||
    [[ ${dir} != "$(fixture_root "${run_id}")" ]]; then
    log "error: refusing to remove unexpected path: ${dir}"
    return 1
  fi
  remove_data_dir "${dir}" || true
  if [[ -e ${dir} ]]; then
    log "removing private directory ${dir}"
    if ! rm -rf -- "${dir}"; then
      log "error: could not remove ${dir}"
    fi
  fi
  if [[ -e ${dir} ]]; then
    log "error: private path still exists: ${dir}"
    failed=1
  fi
  return ${failed}
}

create_container() {
  local ctr=$1 net=$2 root=$3
  docker run --detach \
    --name "${ctr}" \
    "${DOCKER_LABEL_ARGS[@]}" \
    --network "${net}" \
    --env "POSTGRES_USER=${ADMIN_ROLE}" \
    --env "POSTGRES_DB=${ADMIN_DATABASE}" \
    --env POSTGRES_PASSWORD_FILE="/run/secrets/${SECRET_NAME}" \
    --health-cmd "pg_isready -U ${ADMIN_ROLE} -d ${ADMIN_DATABASE}" \
    --health-interval 1s \
    --health-timeout 2s \
    --health-retries "${HEALTH_RETRIES}" \
    --health-start-period 1s \
    --mount "type=bind,source=${root}/${DATA_DIR_NAME},target=/var/lib/postgresql/data,bind-propagation=rprivate" \
    --mount "type=bind,source=${root}/${SECRET_NAME},target=/run/secrets/${SECRET_NAME},readonly,bind-propagation=rprivate" \
    "${IMAGE_REFERENCE}" >/dev/null
}

wait_healthy() {
  local ctr=$1 attempt state streak detail line raw
  for ((attempt = 0; attempt < HEALTH_ATTEMPTS; attempt++)); do
    state=$(docker inspect --format \
      '{{if .State.Running}}{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}{{else}}not-running{{end}}' \
      "${ctr}" 2>/dev/null) || state=missing
    case ${state} in
      healthy) return 0 ;;
      unhealthy)
        # Docker only says unhealthy after HEALTH_RETRIES failed checks. Waiting
        # out the whole HEALTH_ATTEMPTS budget would hide the diagnosis for two
        # more minutes, so fail now and say what the health check reported.
        streak=$(docker inspect --format '{{.State.Health.FailingStreak}}' "${ctr}" 2>/dev/null) ||
          streak="unknown"
        raw=$(docker inspect --format '{{json .State.Health}}' "${ctr}" 2>/dev/null |
          jq --raw-output '[.Log[]?.Output // ""] | map(select(. != "")) | last // ""' 2>/dev/null) ||
          raw=""
        detail=""
        while IFS= read -r line; do
          line=${line%$'\r'}
          [[ -n ${line} ]] || continue
          detail=${line}
        done <<<"${raw}"
        die "container ${ctr} reported unhealthy (failing_streak=${streak}): ${detail:-no health check output}"
        ;;
      not-running | missing | no-healthcheck)
        die "container ${ctr} cannot report healthy state (${state})"
        ;;
    esac
    sleep 1
  done
  die "container ${ctr} did not become healthy within ${HEALTH_ATTEMPTS}s"
}

container_ip() {
  local ctr=$1 net=$2 ip
  ip=$(docker container inspect --format "{{(index .NetworkSettings.Networks \"${net}\").IPAddress}}" "${ctr}")
  [[ -n ${ip} ]] || die "container ${ctr} has no address on ${net}"
  printf '%s' "${ip}"
}

# The manifest is derived from live inspections, never from assumptions: ids,
# IPAM, labels, mount flags and the published-port fact are read back from the
# objects Docker created. The write happens last, so a partial fixture never
# carries a manifest the admission would accept.
write_manifest() {
  local run_id=$1 root=$2 net ctr
  net=$(network_name "${run_id}")
  ctr=$(container_name "${run_id}")
  {
    docker network inspect "${net}"
    docker container inspect "${ctr}"
  } | jq --slurp --exit-status \
    --arg run_id "${run_id}" \
    --arg dsn_file "${root}/${DSN_NAME}" \
    --arg data_dir "${root}/${DATA_DIR_NAME}" \
    --arg image_reference "${IMAGE_REFERENCE}" '
      .[0][0] as $n | .[1][0] as $c
      | ($c.Mounts | map(select(.Destination == "/var/lib/postgresql/data"))) as $data
      | if ($n.Id | test("^[a-f0-9]{64}$") | not) then error("network id is not canonical") else . end
      | if ($c.Id | test("^[a-f0-9]{64}$") | not) then error("container id is not canonical") else . end
      | if ($c.Image | test("^sha256:[a-f0-9]{64}$") | not) then error("image id is not canonical") else . end
      | if ($data | length) != 1 then error("expected exactly one pgdata bind") else . end
      | if $data[0].Mode != "" then error("pgdata bind carries an unexpected mode") else . end
      | if ($c.NetworkSettings.Networks[$n.Name].NetworkID // "") != $n.Id then error("container is not attached to the fixture network") else . end
      | if ($c.NetworkSettings.Networks[$n.Name].IPAddress // "") == "" then error("container has no fixture address") else . end
      | {
          schema: "luson.test-pg/v1",
          status: "active",
          scope: "transfer-requests/R01",
          run_id: $run_id,
          labels: $n.Labels,
          dsn_file: $dsn_file,
          expected_uid: 1000,
          expected_mode: "0600",
          admin_database: "luson_test",
          admin_role: "luson_test",
          network: {
            id: $n.Id,
            name: $n.Name,
            labels: $n.Labels,
            driver: $n.Driver,
            internal: $n.Internal,
            ipam: $n.IPAM
          },
          container: {
            id: $c.Id,
            name: ($c.Name | ltrimstr("/")),
            image_id: $c.Image,
            image_reference: $c.Config.Image,
            labels: $c.Config.Labels,
            network_id: $n.Id,
            network_name: $n.Name,
            ip: $c.NetworkSettings.Networks[$n.Name].IPAddress,
            port: 5432,
            published_ports: (($c.HostConfig.PortBindings // {}) | [ .[][]? ] | length) > 0
          },
          data_bind: ($data[0] | {Type, Source, Destination, Mode, RW, Propagation})
        }
      | if .container.image_reference != $image_reference then error("unexpected image reference") else . end
      | if .data_bind.Source != $data_dir then error("unexpected data bind source") else . end
    ' >"${root}/${MANIFEST_NAME}.tmp"
  chmod "${SECRET_FILE_MODE}" -- "${root}/${MANIFEST_NAME}.tmp"
  mv -f -- "${root}/${MANIFEST_NAME}.tmp" "${root}/${MANIFEST_NAME}"
}

expected_labels_json() {
  printf '%s\n' "${FIXTURE_LABELS[@]}" |
    jq -Rn '[inputs | split("=") | {key: .[0], value: (.[1:] | join("="))}] | from_entries'
}

# Independent self-check before announcing success: the same private metadata,
# label set, pinned image, port facts and path shapes the admission validates,
# read from the filesystem and the manifest that were just written.
verify_fixture() {
  local run_id=$1 root=$2 password=$3
  local manifest="${root}/${MANIFEST_NAME}" dsn="${root}/${DSN_NAME}"
  local labels ip content

  [[ $(stat -c '%u:%a' -- "${root}") == "1000:${PRIVATE_DIR_MODE}" ]] ||
    die "private directory ${root} is not 1000:${PRIVATE_DIR_MODE}"
  [[ $(stat -c '%u:%a' -- "${root}/${DATA_DIR_NAME}") == "${DATA_DIR_UID}:${DATA_DIR_MODE}" ]] ||
    die "pgdata is not ${DATA_DIR_UID}:${DATA_DIR_MODE}"
  [[ $(stat -c '%u:%a' -- "${dsn}") == "1000:${SECRET_FILE_MODE}" ]] ||
    die "DSN file is not 1000:${SECRET_FILE_MODE}"
  [[ $(stat -c '%u:%a' -- "${manifest}") == "1000:${SECRET_FILE_MODE}" ]] ||
    die "manifest is not 1000:${SECRET_FILE_MODE}"
  [[ $(stat -c '%u:%a' -- "${root}/${SECRET_NAME}") == "1000:${SECRET_FILE_MODE}" ]] ||
    die "password file is not 1000:${SECRET_FILE_MODE}"

  labels=$(expected_labels_json)
  jq --exit-status \
    --arg run_id "${run_id}" \
    --argjson labels "${labels}" \
    --arg dsn "${dsn}" \
    --arg data_dir "${root}/${DATA_DIR_NAME}" '
      .schema == "luson.test-pg/v1"
      and .status == "active"
      and .scope == "transfer-requests/R01"
      and .run_id == $run_id
      and .labels == $labels
      and .dsn_file == $dsn
      and .expected_uid == 1000
      and .expected_mode == "0600"
      and .admin_database == "luson_test"
      and .admin_role == "luson_test"
      and .network.driver == "bridge"
      and .network.internal == true
      and .network.labels == $labels
      and (.network.id | test("^[a-f0-9]{64}$"))
      and (.network.ipam.Config | length) == 1
      and .network.ipam.Config[0].Subnet != ""
      and .network.ipam.Config[0].Gateway != ""
      and .container.labels == $labels
      and (.container.id | test("^[a-f0-9]{64}$"))
      and .container.id != .network.id
      and (.container.image_id | test("^sha256:[a-f0-9]{64}$"))
      and .container.image_reference == "postgres:17.9-bookworm"
      and .container.network_id == .network.id
      and .container.network_name == .network.name
      and .container.port == 5432
      and .container.published_ports == false
      and .data_bind.Type == "bind"
      and .data_bind.Source == $data_dir
      and .data_bind.Destination == "/var/lib/postgresql/data"
      and .data_bind.Mode == ""
      and .data_bind.RW == true
      and .data_bind.Propagation == "rprivate"
    ' "${manifest}" >/dev/null || die "manifest self-check failed: ${manifest}"

  ip=$(jq --raw-output --exit-status '.container.ip' "${manifest}")
  content=$(cat -- "${dsn}")
  [[ ${content} == "postgres://${ADMIN_ROLE}:${password}@${ip}:5432/${ADMIN_DATABASE}?sslmode=disable" ]] ||
    die "DSN file does not describe the fixture admin connection"
  [[ $(stat -c '%s' -- "${dsn}") -le 4096 ]] || die "DSN file exceeds the admission limit"
  [[ $(stat -c '%s' -- "${manifest}") -le 32768 ]] || die "manifest exceeds the admission limit"
}

# Ownership, never name containment. An object belongs to the fixture only when
# its generated name is exact for its kind, or when it carries the full fixed
# label set (Docker ANDs repeated label filters, so all five pairs must match).
# An unrelated object whose name merely contains the prefix is never a target.
exact_generated_name() {
  local kind=$1 name=$2
  case ${kind} in
    container) [[ ${name} =~ ^${RUN_PREFIX}-[a-f0-9]{8}-pg$ ]] ;;
    network) [[ ${name} =~ ^${RUN_PREFIX}-[a-f0-9]{8}-net$ ]] ;;
    *) return 1 ;;
  esac
}

fixture_label_filters() {
  local -n out=$1
  local label
  out=()
  for label in "${FIXTURE_LABELS[@]}"; do
    out+=(--filter "label=${label}")
  done
}

fixture_container_names() {
  local -a filters=() names=()
  local labelled all name
  fixture_label_filters filters
  labelled=$(docker ps --all --format '{{.Names}}' "${filters[@]}") || return 1
  all=$(docker ps --all --format '{{.Names}}') || return 1
  while IFS= read -r name; do
    name=${name%%,*}
    [[ -n ${name} ]] || continue
    names+=("${name}")
  done <<<"${labelled}"
  while IFS= read -r name; do
    [[ -n ${name} ]] || continue
    exact_generated_name container "${name}" || continue
    names+=("${name}")
  done <<<"${all}"
  ((${#names[@]})) || return 0
  printf '%s\n' "${names[@]}" | sort -u
}

fixture_network_names() {
  local -a filters=() names=()
  local labelled all name
  fixture_label_filters filters
  labelled=$(docker network ls --format '{{.Name}}' "${filters[@]}") || return 1
  all=$(docker network ls --format '{{.Name}}') || return 1
  while IFS= read -r name; do
    [[ -n ${name} ]] || continue
    names+=("${name}")
  done <<<"${labelled}"
  while IFS= read -r name; do
    [[ -n ${name} ]] || continue
    exact_generated_name network "${name}" || continue
    names+=("${name}")
  done <<<"${all}"
  ((${#names[@]})) || return 0
  printf '%s\n' "${names[@]}" | sort -u
}

run_ids_from_names() {
  local name
  for name in "$@"; do
    if [[ ${name} =~ ^${RUN_PREFIX}-([a-f0-9]{8})-(net|pg)$ ]]; then
      printf '%s\n' "${BASH_REMATCH[1]}"
    fi
  done
}

all_run_ids() {
  local dir base
  {
    for dir in "${STATE_ROOT}/${RUN_PREFIX}-"*; do
      [[ -d ${dir} ]] || continue
      base=$(basename -- "${dir}")
      if [[ ${base} =~ ^${RUN_PREFIX}-([a-f0-9]{8})$ ]]; then
        printf '%s\n' "${BASH_REMATCH[1]}"
      fi
    done
    local -a objects=() networks=()
    mapfile -t objects < <(fixture_container_names)
    mapfile -t networks < <(fixture_network_names)
    run_ids_from_names "${objects[@]}" "${networks[@]}"
  } | sort -u
}

# Removes one run by name. Container and network are addressed by the exact
# names derived from the validated run id, so teardown works even when the
# manifest or the private directory never got written. Every step is checked and
# returns non-zero so a caller can tell that this pass did not finish the job; the
# caller decides the verdict from the re-check that follows its retry pass.
remove_run() {
  local run_id=$1 root net ctr failed=0
  run_id_valid "${run_id}" || die "refusing to remove unknown run id: ${run_id}"
  root=$(fixture_root "${run_id}")
  net=$(network_name "${run_id}")
  ctr=$(container_name "${run_id}")
  [[ ${root} == "${STATE_ROOT}/${RUN_PREFIX}-"* ]] ||
    die "refusing to remove unexpected path: ${root}"

  if docker container inspect "${ctr}" >/dev/null 2>&1; then
    log "removing container ${ctr}"
    if ! docker rm --force "${ctr}" >/dev/null; then
      log "error: could not remove container ${ctr}"
      failed=1
    fi
  fi
  if docker network inspect "${net}" >/dev/null 2>&1; then
    log "removing network ${net}"
    if ! docker network rm "${net}" >/dev/null; then
      log "error: could not remove network ${net}"
      failed=1
    fi
  fi
  if [[ -e ${root} ]]; then
    remove_private_dir "${root}" || failed=1
  fi
  return ${failed}
}

abort_up() {
  local status=$?
  trap - EXIT INT TERM
  if [[ -n ${ACTIVE_RUN_ID} ]]; then
    log "up failed (exit ${status}); removing partial fixture ${ACTIVE_RUN_ID}"
    if ! remove_run "${ACTIVE_RUN_ID}"; then
      log "error: partial cleanup of ${ACTIVE_RUN_ID} is incomplete; run '$0 down ${ACTIVE_RUN_ID}' to finish it"
      if ((status == 0)); then
        status=1
      fi
    fi
    ACTIVE_RUN_ID=""
  fi
  release_lock
  exit "${status}"
}

cmd_up() {
  require_docker
  require_commands
  acquire_lock

  local pending
  pending=$(pg_env_names)
  if [[ -n ${pending} ]]; then
    log "warning: PG* variables are set in this shell and are not used by the fixture: $(printf '%s ' ${pending})"
  fi

  local leftovers
  leftovers=$(fixture_container_names) || die "could not enumerate fixture containers"
  [[ -z ${leftovers} ]] ||
    die "a fixture container already exists (${leftovers//$'\n'/, }); run '$0 down' first"
  leftovers=$(fixture_network_names) || die "could not enumerate fixture networks"
  [[ -z ${leftovers} ]] ||
    die "a fixture network already exists (${leftovers//$'\n'/, }); run '$0 down' first"

  local run_id root net ctr password ip dsn
  run_id=$(new_run_id)
  run_id_valid "${run_id}" || die "generated run id is not canonical: ${run_id}"
  root=$(fixture_root "${run_id}")
  net=$(network_name "${run_id}")
  ctr=$(container_name "${run_id}")
  password=$(new_password)

  ACTIVE_RUN_ID=${run_id}
  trap abort_up EXIT INT TERM

  log "creating fixture ${run_id}"
  install_private_dir "${root}"
  prepare_data_dir "${root}/${DATA_DIR_NAME}"
  write_private_file "${root}/${SECRET_NAME}" "${password}"
  create_network "${net}"
  create_container "${ctr}" "${net}" "${root}"
  wait_healthy "${ctr}"

  ip=$(container_ip "${ctr}" "${net}")
  dsn="postgres://${ADMIN_ROLE}:${password}@${ip}:5432/${ADMIN_DATABASE}?sslmode=disable"
  write_private_file "${root}/${DSN_NAME}" "${dsn}"
  write_manifest "${run_id}" "${root}"
  verify_fixture "${run_id}" "${root}" "${password}"

  trap - EXIT INT TERM
  ACTIVE_RUN_ID=""
  log "fixture ${run_id} is ready on ${net} (unpublished, internal)"
  release_lock
  printf '%s\n' "${root}/${MANIFEST_NAME}"
}

cmd_down() {
  require_docker
  acquire_lock
  local -a run_ids=()
  local arg run_id dir base name listing remaining=0
  if [[ $# -gt 0 ]]; then
    for arg in "$@"; do
      if [[ -d ${arg} && ${arg} == "${STATE_ROOT}/${RUN_PREFIX}-"* ]]; then
        base=$(basename -- "${arg}")
        run_ids+=("${base#"${RUN_PREFIX}"-}")
      elif [[ -f ${arg} && ${arg} == */"${MANIFEST_NAME}" ]]; then
        dir=$(dirname -- "${arg}")
        base=$(basename -- "${dir}")
        run_ids+=("${base#"${RUN_PREFIX}"-}")
      else
        run_ids+=("${arg}")
      fi
    done
  else
    mapfile -t run_ids < <(all_run_ids)
  fi

  for run_id in "${run_ids[@]}"; do
    # A failure here is retried by the leftover passes below, so the verdict is
    # the re-check at the end, not this step.
    remove_run "${run_id}" || true
  done

  # Belt and braces for a crashed up, with exact ownership only: an object is
  # removed because its generated name is exact for its kind or because it
  # carries the full fixture label set, never because its name contains the
  # prefix.
  if ! listing=$(fixture_container_names); then
    log "error: could not enumerate fixture containers"
    listing=""
  fi
  while IFS= read -r name; do
    [[ -n ${name} ]] || continue
    log "removing leftover fixture container ${name}"
    if ! docker rm --force "${name}" >/dev/null; then
      log "error: could not remove container ${name}"
    fi
  done <<<"${listing}"

  if ! listing=$(fixture_network_names); then
    log "error: could not enumerate fixture networks"
    listing=""
  fi
  while IFS= read -r name; do
    [[ -n ${name} ]] || continue
    log "removing leftover fixture network ${name}"
    if ! docker network rm "${name}" >/dev/null; then
      log "error: could not remove network ${name}"
    fi
  done <<<"${listing}"

  for dir in "${STATE_ROOT}/${RUN_PREFIX}-"*; do
    [[ -d ${dir} ]] || continue
    base=$(basename -- "${dir}")
    [[ ${base} =~ ^${RUN_PREFIX}-[a-f0-9]{8}$ ]] || continue
    log "removing leftover private directory ${dir}"
    remove_private_dir "${dir}" || true
  done

  # The end state decides the exit status. A step above that failed and left
  # nothing behind is a clean teardown; anything still enumerable, or any
  # enumeration that fails so that "clean" cannot be proved, is not.
  if ! listing=$(fixture_container_names); then
    log "error: could not re-check fixture containers after teardown"
    remaining=1
  elif [[ -n ${listing} ]]; then
    log "error: fixture containers remain: ${listing//$'\n'/, }"
    remaining=1
  fi
  if ! listing=$(fixture_network_names); then
    log "error: could not re-check fixture networks after teardown"
    remaining=1
  elif [[ -n ${listing} ]]; then
    log "error: fixture networks remain: ${listing//$'\n'/, }"
    remaining=1
  fi
  for dir in "${STATE_ROOT}/${RUN_PREFIX}-"*; do
    [[ -e ${dir} ]] || continue
    log "error: private path remains: ${dir}"
    remaining=1
  done
  release_lock
  if ((remaining)); then
    log "error: teardown incomplete: the fixture objects named above are still present"
    return 1
  fi
  log "teardown clean: no fixture container, network, private directory or manifest left"
}

# A signal can arrive while the fixture is still being created, when no
# manifest path exists yet. Teardown therefore never depends on that path: with
# it, exactly that run is removed, and without it `down` removes whatever this
# invocation managed to create, so an interrupted creation cannot leave a
# container, a network or a private directory behind.
teardown_after_signal() {
  local signal=$1 status=130
  if [[ ${signal} == TERM ]]; then
    status=143
  fi
  trap - INT TERM EXIT
  log "received ${signal}; tearing the fixture down"
  local cleaned=0
  if [[ -n ${RUN_MANIFEST} ]]; then
    cmd_down "${RUN_MANIFEST}" || cleaned=1
  else
    cmd_down || cleaned=1
  fi
  if ((cleaned)); then
    log "error: teardown after ${signal} left fixture objects behind; run '$0 down' to finish it"
    status=1
  fi
  release_lock
  exit "${status}"
}

cmd_run() {
  [[ $# -gt 0 ]] || die "run needs a command, for example: run -- go test ./..."
  local manifest status teardown_failed=0
  acquire_lock
  RUN_MANIFEST=""
  trap 'teardown_after_signal INT' INT
  trap 'teardown_after_signal TERM' TERM
  manifest=$(cmd_up)
  RUN_MANIFEST=${manifest}
  set +e
  (
    scrub_pg_env
    export LUSON_TEST_PG_MANIFEST="${manifest}"
    # The command must not inherit the lock descriptor. If the wrapper is killed
    # while the command keeps running, an inherited copy of the descriptor would
    # keep the flock held by that orphan and block every later up, down and run
    # until it exits, which is exactly what the lock must never do.
    if [[ -n ${LOCK_FD} ]]; then
      exec {LOCK_FD}>&-
      LOCK_FD=""
      LOCK_HELD=""
      LOCK_OWNER_PID=""
    fi
    exec "$@"
  )
  status=$?
  set -e
  trap - INT TERM
  if ! cmd_down "${manifest}"; then
    teardown_failed=1
  fi
  release_lock
  if ((teardown_failed)); then
    log "error: the fixture teardown failed, so this run cannot report success (the command exited ${status})"
    if ((status == 0)); then
      status=1
    fi
  fi
  return "${status}"
}

cmd_status() {
  require_docker
  local run_id ctr net manifest container_state network_state manifest_state
  local found=0
  while read -r run_id; do
    [[ -n ${run_id} ]] || continue
    found=1
    ctr=$(container_name "${run_id}")
    net=$(network_name "${run_id}")
    manifest=$(fixture_root "${run_id}")/${MANIFEST_NAME}
    if docker container inspect "${ctr}" >/dev/null 2>&1; then
      container_state=$(docker inspect --format '{{.State.Status}}' "${ctr}")
    else
      container_state=absent
    fi
    if docker network inspect "${net}" >/dev/null 2>&1; then
      network_state=present
    else
      network_state=absent
    fi
    if [[ -f ${manifest} ]]; then
      manifest_state=present
    else
      manifest_state=absent
    fi
    printf 'run=%s container=%s network=%s manifest=%s\n' \
      "${run_id}" "${container_state}" "${network_state}" "${manifest_state}"
  done < <(all_run_ids)
  if ((found == 0)); then
    printf 'no fixture present\n'
  fi
}

usage() {
  cat <<'EOF'
usage: scripts/test-pg-fixture.sh <command>

commands:
  up                   create the ephemeral PostgreSQL fixture and print the
                       manifest path on stdout; export it as
                       LUSON_TEST_PG_MANIFEST for the test run
  down [run-id...]     remove the fixture container, network, private directory
                       and manifest; with no argument removes every fixture
                       run found on this host
  run -- <command>     bring the fixture up, run <command> with
                       LUSON_TEST_PG_MANIFEST exported and every PG* variable
                       unset, then always tear the fixture down (a teardown
                       failure makes the run exit non-zero)
  status               report fixture containers, networks and manifests

environment:
  HOME                 fixture state lives in
                       $HOME/.local/share/luson-transfer-tests-<run_id>/
                       and the advisory lock file
                       $HOME/.local/share/luson-transfer-tests.lock

Only one fixture command runs at a time: up, down and run take an advisory
lock for the whole creating or removing step, so a second concurrent
invocation fails fast instead of racing into a second run id. Teardown only
removes objects with the exact generated name or the full fixture label set;
an object whose name merely contains the prefix is never touched. A removal
that fails is reported as an error and makes the command exit non-zero.

The fixture never uses sudo, never publishes a port, never reuses the
development database and never touches apps/api/internal/testpg.
EOF
}

main() {
  local command=${1:-}
  if (($# > 0)); then
    shift
  fi
  case ${command} in
    up) cmd_up ;;
    down) cmd_down "$@" ;;
    run)
      if [[ ${1:-} == -- ]]; then
        shift
      fi
      cmd_run "$@"
      ;;
    status) cmd_status ;;
    '' | -h | --help | help) usage ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
}

ACTIVE_RUN_ID=""
RUN_MANIFEST=""
main "$@"
