#!/bin/bash
# PREPARED ONLY: parent launches against its isolated candidate and existing caches.
# Parent must provide fresh receipt directory plus admitted HOME/TMPDIR/Go caches.
set -euo pipefail
candidate="${1:?isolated candidate root required}"
receipts="${2:?fresh external receipt directory required}"
case "$candidate" in /tmp/luson-account-administration-82bce681/*/candidate) ;; *) exit 2;; esac
case "$receipts" in /tmp/luson-account-administration-82bce681/*) ;; *) exit 2;; esac
export GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local
export LUSON_TEST_PG_MANIFEST='/home/luis/.local/share/luson-transfer-tests-82bce681/manifest.json'
unset LUSON_DATABASE_URL DATABASE_URL PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD PGPASSFILE PGSERVICE PGSERVICEFILE PGSSLMODE PGSSLCERT PGSSLKEY PGSSLROOTCERT PGSSLCRL PGOPTIONS PGAPPNAME PGTARGETSESSIONATTRS PGCONNECT_TIMEOUT
cd "$candidate/apps/api"
run() {
    local label="$1"; shift
    local code=0
    # Noclobber preserves original stdout/stderr/exit; stop rather than retry.
    (set -o noclobber; "$@" > "$receipts/$label.stdout" 2> "$receipts/$label.stderr") || code=$?
    (set -o noclobber; printf '%s\n' "$code" > "$receipts/$label.exit")
    printf '%s: exit %s\n' "$*" "$code"
    return "$code"
}
run focused go test -p 1 ./migrations -run 'TestAdministrativeRetirement|TestDynamicBranchAudiences' -count=1
run migrations go test -p 1 ./migrations -count=1
