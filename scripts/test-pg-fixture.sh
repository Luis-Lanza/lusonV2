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
readonly LIFECYCLE_LABEL=luson.purpose=go-postgresql-tests

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
    "${IMAGE_REFERENCE}" -c 'chown 999:999 /pgdata && chmod 700 /pgdata'
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
  docker run --rm --user 0 --network none --entrypoint /bin/sh \
    --mount "type=bind,source=${root}/${DATA_DIR_NAME},target=/pgdata" \
    "${IMAGE_REFERENCE}" -c 'find /pgdata -mindepth 1 -delete' ||
    log "warning: could not clear ${root}/${DATA_DIR_NAME} contents"
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
  local ctr=$1 attempt state
  for ((attempt = 0; attempt < HEALTH_ATTEMPTS; attempt++)); do
    state=$(docker inspect --format \
      '{{if .State.Running}}{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}{{else}}not-running{{end}}' \
      "${ctr}" 2>/dev/null) || state=missing
    case ${state} in
      healthy) return 0 ;;
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

fixture_containers() {
  {
    docker ps --all --quiet --filter "label=${LIFECYCLE_LABEL}"
    docker ps --all --quiet --filter "name=${RUN_PREFIX}-"
  } | sort -u
}

fixture_networks() {
  {
    docker network ls --quiet --filter "label=${LIFECYCLE_LABEL}"
    docker network ls --quiet --filter "name=${RUN_PREFIX}-"
  } | sort -u
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
  local dir base name
  {
    for dir in "${STATE_ROOT}/${RUN_PREFIX}-"*; do
      [[ -d ${dir} ]] || continue
      base=$(basename -- "${dir}")
      if [[ ${base} =~ ^${RUN_PREFIX}-([a-f0-9]{8})$ ]]; then
        printf '%s\n' "${BASH_REMATCH[1]}"
      fi
    done
    local -a containers=() networks=()
    mapfile -t containers < <(docker ps --all --format '{{.Names}}')
    mapfile -t networks < <(docker network ls --format '{{.Name}}')
    run_ids_from_names "${containers[@]}" "${networks[@]}"
  } | sort -u
}

# Removes one run by name. Container and network are addressed by the names
# derived from the validated run id, so teardown works even when the manifest
# or the private directory never got written.
remove_run() {
  local run_id=$1 root net ctr
  run_id_valid "${run_id}" || die "refusing to remove unknown run id: ${run_id}"
  root=$(fixture_root "${run_id}")
  net=$(network_name "${run_id}")
  ctr=$(container_name "${run_id}")
  [[ ${root} == "${STATE_ROOT}/${RUN_PREFIX}-"* ]] ||
    die "refusing to remove unexpected path: ${root}"

  if docker container inspect "${ctr}" >/dev/null 2>&1; then
    log "removing container ${ctr}"
    docker rm --force "${ctr}" >/dev/null
  fi
  if docker network inspect "${net}" >/dev/null 2>&1; then
    log "removing network ${net}"
    docker network rm "${net}" >/dev/null
  fi
  if [[ -e ${root} ]]; then
    log "removing private directory ${root}"
    remove_data_dir "${root}"
    rm -rf -- "${root}" || log "warning: could not remove ${root}"
  fi
}

abort_up() {
  local status=$?
  if [[ -n ${ACTIVE_RUN_ID} ]]; then
    trap - EXIT INT TERM
    log "up failed (exit ${status}); removing partial fixture ${ACTIVE_RUN_ID}"
    remove_run "${ACTIVE_RUN_ID}" || log "warning: partial cleanup was incomplete"
    ACTIVE_RUN_ID=""
  fi
  return "${status}"
}

cmd_up() {
  require_docker
  require_commands

  local pending
  pending=$(pg_env_names)
  if [[ -n ${pending} ]]; then
    log "warning: PG* variables are set in this shell and are not used by the fixture: $(printf '%s ' ${pending})"
  fi

  local leftovers
  leftovers=$(fixture_containers)
  [[ -z ${leftovers} ]] || die "a fixture container already exists; run '$0 down' first"
  leftovers=$(fixture_networks)
  [[ -z ${leftovers} ]] || die "a fixture network already exists; run '$0 down' first"

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
  printf '%s\n' "${root}/${MANIFEST_NAME}"
}

cmd_down() {
  require_docker
  local -a run_ids=()
  local arg run_id dir base
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
    remove_run "${run_id}"
  done

  # Belt and braces: anything still carrying the fixture labels or the fixture
  # name prefix is removed too, so a crashed up cannot leak an object.
  local -a ids=()
  mapfile -t ids < <(fixture_containers)
  if ((${#ids[@]})); then
    log "removing ${#ids[@]} leftover fixture container(s)"
    docker rm --force "${ids[@]}" >/dev/null
  fi
  mapfile -t ids < <(fixture_networks)
  if ((${#ids[@]})); then
    log "removing ${#ids[@]} leftover fixture network(s)"
    docker network rm "${ids[@]}" >/dev/null
  fi
  for dir in "${STATE_ROOT}/${RUN_PREFIX}-"*; do
    [[ -d ${dir} ]] || continue
    base=$(basename -- "${dir}")
    if [[ ${base} =~ ^${RUN_PREFIX}-[a-f0-9]{8}$ ]]; then
      log "removing leftover private directory ${dir}"
      remove_data_dir "${dir}"
      rm -rf -- "${dir}" || log "warning: could not remove ${dir}"
    fi
  done

  local dirty=0
  if [[ -n $(fixture_containers) ]]; then
    log "error: fixture containers remain"
    dirty=1
  fi
  if [[ -n $(fixture_networks) ]]; then
    log "error: fixture networks remain"
    dirty=1
  fi
  for dir in "${STATE_ROOT}/${RUN_PREFIX}-"*; do
    [[ -e ${dir} ]] || continue
    log "error: private path remains: ${dir}"
    dirty=1
  done
  if ((dirty)); then
    return 1
  fi
  log "teardown clean: no fixture container, network, private directory or manifest left"
}

cmd_run() {
  [[ $# -gt 0 ]] || die "run needs a command, for example: run -- go test ./..."
  local manifest status
  manifest=$(cmd_up)
  trap 'cmd_down "${manifest}" >/dev/null 2>&1 || true' INT TERM
  set +e
  (
    scrub_pg_env
    export LUSON_TEST_PG_MANIFEST="${manifest}"
    exec "$@"
  )
  status=$?
  set -e
  trap - INT TERM
  cmd_down "${manifest}" || log "warning: teardown reported leftovers"
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
  run -- <command>     bring the fixture up, run <command> with
                       LUSON_TEST_PG_MANIFEST exported and every PG* variable
                       unset, then always tear the fixture down
  status               report fixture containers, networks and manifests

environment:
  HOME                 fixture state lives in
                       $HOME/.local/share/luson-transfer-tests-<run_id>/

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
main "$@"
