# D5 recovery unit A — client/parser source handoff

Scope: S2/S4, canonical task L39–L46. Source implementation only; no runtime GREEN, browser, build, independent review or delivery claim. Parent-reported job61 client RED and L44 three parser RED/control PASS were the implementation prerequisites; no reruns here.

## Changes

- `apps/web/src/useInventory.ts`: +14/-3 relative to HEAD. Both public/private implementation method unions include DELETE. A separate DELETE-only anchored item allowlist accepts canonical positive account/branch IDs as strings, including account `9007199254740993`; existing GET/POST/PATCH policy remains unchanged. Collections, password paths, zero/padded IDs, query strings and trailing slashes fail before fetch. Existing owner, linked abort, pre-aborted admission, CSRF, stale401 and empty204 checks remain.
- Metadata reconciliation occurs immediately after parse/epoch/read/abort validation and `setMetadata`, before captured inventory URL fetch. A missing selection for warehouse authority reuses `change({ location: session.identity.location.id })`, preserving filters/size, resetting page1, clearing stale data and cancelling the captured read. Its next job is non-full and uses the newly stored metadata rather than another metadata GET. Operators receive an invalid-response error, never a redirect to another branch.
- `apps/web/src/model.ts`: existing +2/-2 guard delta preserved verbatim, not rewritten. Only fixed minimum-three/IDs1,2,3 assumptions change to mandatory warehouse1. Location decoding, ID range, nonempty valid names, unique IDs and nonempty unique valid brands remain; no warehouse-name restriction or other parser change.
- `apps/web/src/useInventory.test.ts` (+42/-0) and `apps/web/src/model.test.ts` (+14/-1) are pre-existing RED preparation, unchanged by this worker. All original four affected test files remain preserved.

## Exact safe blocker copy / required unit B seam

- `branch_has_stock`: “La sucursal tiene stock o reservas. Resolvé el stock y las reservas antes de eliminarla.”
- `branch_has_users`: “La sucursal tiene usuarios asignados, incluso desactivados. Reasignalos o eliminalos antes de eliminarla.”
- `branch_has_pending_operations`: “La sucursal tiene operaciones pendientes. Resolvelas antes de eliminarla.”

IMPORTANT: existing `AccountAdministration.tsx` `publicError` prefix allowlist does NOT accept `La sucursal`. Unit B must add that exact safe prefix (or equivalent narrowly bounded handling); otherwise these messages become the generic uncertain-outcome text. No raw response text is exposed by the client. AccountAdministration was read only in A.

Unit B still owns deletion controls, destructive-intent confirmation/cancel, duplicate/pending/uncertain-outcome handling, protected admin/warehouse presentation, directory/metadata refresh after accepted deletion and private credential-handoff clearance. No App production edit indicated. No unit B files were written here.

## Static evidence and remaining proof

`git diff --check`: exit0. Scoped production diff inspected: 16 additions / 5 deletions combined, including preserved model delta; under the production budget. No tests, npm, Vitest, tsc, build, browser, Go, DB, HTTP or runtime probes executed. Parent owns full four affected files, then full suite, then build, once each serially stopping on failure, only after B; actual browser/D6, shared-client differential and independent disposition remain parent-owned.

## Key Learnings

Use the existing query `change` transition, not inline query/job reconstruction: it enforces cancellation, private snapshot clearing, filter retention and page reset while avoiding a third metadata GET. Only warehouse authority may fall back to its own protected location1. The existing model partial diff already matches the bounded parser contract.

No scratch/cache was created deliberately. Initial unrestricted `git status --short` output exceeded the harness display limit and produced host spill `/tmp/gpj9v8pJ/gaCXcTDF/pi-bash-d61c6f61031abb6e.log`; not read, modified or cleaned. Unrelated dirty/untracked evidence/design/task files preserved.
