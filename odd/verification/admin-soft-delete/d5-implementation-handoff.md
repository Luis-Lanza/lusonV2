# D5 recovery B — controls ready for parent checks

Source only, covering S1–S4 UI boundaries. No runtime GREEN, build, browser, review acceptance or preview deployment is claimed. Unit A client/parser changes are preserved, not reimplemented. Canonical authority: task Specs and L39–L47; prior RED is parent-reported job61 (11 missing-control/client-policy failures) and parser RED (3 failures, old metadata control PASS). The old deactivate/reactivate preservation test did NOT run during RED.

## Changed paths and size

- `apps/web/src/AccountAdministration.tsx`: +32/-6 versus HEAD. Separate user/branch deletion, confirmation/cancel, callbacks and narrowly extended safe error prefix.
- `apps/api/docs/administration.md`: +3/-3, source controls and lifecycle, availability only after verified build/deployment.
- `apps/api/docs/administrative-retirement.md`: +1/-1, same source-versus-proof boundary.
- `odd/verification/admin-soft-delete/d5-green-runner.sh`: new parent-only runner.
- `odd/verification/admin-soft-delete/d5-implementation-handoff.md`: this handoff.

No CSS was necessary: existing `admin-actions`, panel and branch-card layout reused. AccountAdministration/App tests are unchanged; no fixtures needed alteration, assertions/skips untouched. No App production or unit A files edited. Production delta is well below 120–170 lines.

## Review facts

- Exact controls: “Eliminar usuario”, “Eliminar sucursal”, “Confirmar eliminación”, “Cancelar”. User confirmation explicitly distinguishes deletion from temporary deactivation. Existing “Acceso” create/profile/reset/reactivation flows remain intact.
- Account1 has no delete control and the handler rejects it; branch1 has no delete control and the handler rejects it. Cancel only clears intent, sending no request. All new buttons are type=button outside existing forms.
- Each handler sets its existing pending ref synchronously before await, then busy state; user shares the editor's profile/reset pending ref, branch shares the existing creation ref. Existing lifetime AbortController/current-owner checks suppress stale errors, success, directory revision and metadata refresh. Logout abort remains controller-owned.
- Canonical item DELETE expects empty204 via existing privateRequest. No optimistic list removal: success increments existing directory revision. User success calls closePrivate, clearing editor and credential handoff; Manage already clears handoff before deletion. No new secret storage.
- Branch success calls existing refreshBranches(owner), which uses invalidate(true); A owns selected-retired fallback before inventory fetch. Rejected/uncertain mutations do not refetch or claim success; target lists remain. Error exits close confirmation, with no automatic retry. Directory consultation remains available.
- publicError adds only the safe `La sucursal` prefix; client maps server codes, never raw server text. Exact blocker messages remain unit A's: “La sucursal tiene stock o reservas. Resolvé el stock y las reservas antes de eliminarla.” / “La sucursal tiene usuarios asignados, incluso desactivados. Reasignalos o eliminalos antes de eliminarla.” / “La sucursal tiene operaciones pendientes. Resolvelas antes de eliminarla.” Known409 is a normal actionable rejection, not uncertain-outcome copy. Unknown transport details use existing generic consult-before-resubmitting text.
- Success copy: “Usuario eliminado del directorio. Se conserva su historial.” / “Sucursal eliminada del directorio. Se conserva su historial.”

## Parent execution only

Prepare a fresh canonical web candidate under `/tmp/luson-account-administration-82bce681/<fresh>/candidate`, overlay consolidated D5 source and all four prepared test files, bind existing project node_modules without installation. Keep source and runner hashes. Supply fresh existing external receipts outside candidate. Runner does not prepare candidate or bindings.

`bash odd/verification/admin-soft-delete/d5-green-runner.sh "$candidate" "$receipts"`

Actual package scripts: test=`vitest run`; build=`tsc --noEmit && vite build`. Runner reserves all nine stdout/stderr/exit files noclobber before checks. Empty exit means NOT EXECUTED, never PASS. Commands run once serially in foreground, stop first failure, offline, no timeout changes:

1. `npm test -- src/AccountAdministration.test.tsx src/App.test.tsx src/useInventory.test.ts src/model.test.ts`
2. `npm test`
3. `npm run build`

Worker ran none of these; parent launches only after B. Full files include existing access preservation omitted by RED selector. Static `bash -n` and `git diff --check` exited0. D5 functional and consolidated parent assessment/one independent disposition remain pending. D6 actual browser, geometry/focus and integrated security/concurrency/history proof remain pending; no glyph proof substituted.

## Key Learnings

Existing closePrivate and directory revision are sufficient; no target-secret store or new layout is needed. User and branch IDs have different types, so reuse their existing protected comparisons. Shared publicError affects create/profile/reset/branch-create errors: source only adds a safe mapped prefix, but differential is not claimed complete. Consolidated D6 should compare existing GET accounts/branches, POST accounts/branches/account-password, PATCH account and POST own-password through privateRequest against prior code for added DELETE inputs/path rejection and retained valid methods, comparing outcome/request effects; include metadata consumers under retired selection. Unit A owns this shared client/parser change, not B. Backend sibling differential recorded in task L35–L37 remains separately pending.

Initial unrestricted status produced host spill `/tmp/gpj9v8pJ/gaUECgeg/pi-bash-397a5046f037b6d4.log`; untouched, no cleanup authority. No deliberate scratch/cache created. Unrelated dirty/untracked resources preserved.
