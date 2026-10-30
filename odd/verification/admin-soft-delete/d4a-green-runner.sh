#!/bin/bash
# Parent only: fresh HEAD + exact source overlay candidate, one serial run each.
set -euo pipefail
candidate="${1:?isolated candidate root required}"
receipts="${2:?fresh external receipt directory required}"
case "$candidate" in /tmp/luson-account-administration-82bce681/*/candidate) ;; *) exit 2;; esac
case "$receipts" in /tmp/luson-account-administration-82bce681/*) ;; *) exit 2;; esac
export GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local
export LUSON_TEST_PG_MANIFEST='/home/luis/.local/share/luson-transfer-tests-82bce681/manifest.json'
unset LUSON_DATABASE_URL DATABASE_URL PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD PGPASSFILE PGSERVICE PGSERVICEFILE PGSSLMODE PGSSLCERT PGSSLKEY PGSSLROOTCERT PGSSLCRL PGOPTIONS PGAPPNAME PGTARGETSESSIONATTRS PGCONNECT_TIMEOUT
cd "$candidate/apps/api"
# Empty legacy receipts mean NOT RUN, never PASS. Reserve before either command.
(set -o noclobber
 : > "$receipts/focused.stdout"
 : > "$receipts/focused.stderr"
 : > "$receipts/focused.exit"
 : > "$receipts/legacy.stdout"
 : > "$receipts/legacy.stderr"
 : > "$receipts/legacy.exit")
code=0
go test -p 1 ./internal/httpapi -run '^(TestBranchRetirement(Success|AssignedUsers|Stock|PendingHistory|Guards)|TestT5NewBranch)$' -count=1 > "$receipts/focused.stdout" 2> "$receipts/focused.stderr" || code=$?
printf '%s\n' "$code" > "$receipts/focused.exit"
printf 'focused: exit %s\n' "$code"
if (( code != 0 )); then exit "$code"; fi
code=0
go test -p 1 ./internal/httpapi -run '^(TestT5|TestAccountRetirement)' -count=1 > "$receipts/legacy.stdout" 2> "$receipts/legacy.stderr" || code=$?
printf '%s\n' "$code" > "$receipts/legacy.exit"
printf 'legacy: exit %s\n' "$code"
exit "$code"
