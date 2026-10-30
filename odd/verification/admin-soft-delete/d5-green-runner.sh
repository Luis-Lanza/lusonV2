#!/bin/bash
# Prepared only. Parent supplies a fresh canonical candidate, dependency binding and external receipts.
set -euo pipefail
set -o noclobber
candidate="${1:?isolated candidate root required}"
receipts="${2:?fresh external receipts required}"
case "$candidate" in /tmp/luson-account-administration-82bce681/*/candidate) ;; *) exit 2;; esac
case "$receipts" in /tmp/luson-account-administration-82bce681/*) ;; *) exit 2;; esac
[[ "$(realpath -e "$candidate")" == "$candidate" && "$(realpath -e "$receipts")" == "$receipts" ]] || exit 2
[[ "$receipts" != "$candidate" && "$receipts" != "$candidate/"* ]] || exit 2
[[ -d "$candidate/apps/web/node_modules" ]] || exit 2
# Reserve ALL receipts before any check. An empty exit file means NOT EXECUTED.
for check in focused suite build; do
  for stream in stdout stderr exit; do
    [[ ! -e "$receipts/$check.$stream" && ! -L "$receipts/$check.$stream" ]] || exit 2
  done
done
for check in focused suite build; do
  for stream in stdout stderr exit; do : > "$receipts/$check.$stream"; done
done
export npm_config_offline=true npm_config_update_notifier=false npm_config_audit=false npm_config_fund=false
cd "$candidate/apps/web"
run() {
  local name="$1" code=0; shift
  "$@" >| "$receipts/$name.stdout" 2>| "$receipts/$name.stderr" || code=$?
  printf '%s\n' "$code" >| "$receipts/$name.exit"
  printf '%s: exit %s\n' "$name" "$code"
  return "$code"
}
run focused npm test -- src/AccountAdministration.test.tsx src/App.test.tsx src/useInventory.test.ts src/model.test.ts
run suite npm test
run build npm run build
