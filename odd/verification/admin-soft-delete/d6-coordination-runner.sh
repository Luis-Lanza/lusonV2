#!/bin/bash
# Parent only: fresh HEAD + four changed tests + existing 353-line D6 HTTP overlay.
set -euo pipefail
candidate="${1:?isolated candidate required}"
receipts="${2:?fresh receipt directory required}"
case "$candidate" in /tmp/luson-account-administration-82bce681/*/candidate) ;; *) exit 2;; esac
case "$receipts" in /tmp/luson-account-administration-82bce681/*/freshreceipts) ;; *) exit 2;; esac
[[ -d "$candidate/apps/api" && -d "$receipts" && -s "$receipts/source.sha256" ]] || exit 2
export GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local
export LUSON_TEST_PG_MANIFEST='/home/luis/.local/share/luson-transfer-tests-82bce681/manifest.json'
unset LUSON_DATABASE_URL DATABASE_URL PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD PGPASSFILE PGSERVICE PGSERVICEFILE PGSSLMODE PGSSLCERT PGSSLKEY PGSSLROOTCERT PGSSLCRL PGOPTIONS PGAPPNAME PGTARGETSESSIONATTRS PGCONNECT_TIMEOUT
cd "$candidate"
sha256sum --check --status "$receipts/source.sha256"
(set -o noclobber
 : > "$receipts/focused.stdout"
 : > "$receipts/focused.stderr"
 : > "$receipts/focused.exit"
 : > "$receipts/suite.stdout"
 : > "$receipts/suite.stderr"
 : > "$receipts/suite.exit")
cd apps/api
code=0
go test -p 1 ./internal/httpapi ./internal/transfers -run '^(TestD6RetirementRecordedReplay|TestD6RetirementFailureAtomicity|TestD6RetirementOverlappedWinners|TestA02ApprovalConcurrency|TestC2CorrectionConcurrencyWorkflow|TestC2CorrectionConcurrencyCancellation|TestC2CorrectionConcurrencyReservation|TestW01DirectShipmentConcurrency|TestW01DirectShipmentContextWait|TestR3RestitutionConcurrencyDecisions|TestR3RestitutionConcurrencyCount|TestDR1Concurrency|TestDR1AllocationCoverage|TestDR1Notifications)$' -count=1 > "$receipts/focused.stdout" 2> "$receipts/focused.stderr" || code=$?
printf '%s\n' "$code" > "$receipts/focused.exit"
printf 'focused: exit %s\n' "$code"
if (( code != 0 )); then exit "$code"; fi
code=0
go test -p 1 ./internal/httpapi ./internal/transfers -count=1 > "$receipts/suite.stdout" 2> "$receipts/suite.stderr" || code=$?
printf '%s\n' "$code" > "$receipts/suite.exit"
printf 'suite: exit %s\n' "$code"
exit "$code"
