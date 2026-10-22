# Restitution UX verification — mobile correction complete

Human choice **"Corregir móvil"** authorized a new bounded correction after the partial handoff below. The mobile overlap is now resolved and all four targeted mobile cases pass. This is self-verification, not user visual acceptance or deployment authorization. Prior failures remain preserved below.

## Authorized mobile correction

Product delta is **five CSS additions**, entirely inside the existing max-width767px management-table media query: th/td use `height: auto` and `min-height: 44px`. No clipping, global CSS, handlers, requests, permissions, operation keys or data changed. See `mobile-correction.patch` and `mobile-verified-source-hashes.json` for the final product delta/bytes. The existing probe grew from184 to212 lines to add mobile filtering and geometric regression assertions; no separate verification project was created.

Each command ran in the foreground with separate stdout/stderr redirection to the named files in this directory:

| Exact command before log redirection | Exit | stdout / stderr | Observed result |
| --- | --- | --- | --- |
| `cd apps/web && node ../../odd/design/transfer-origin-restitution-ux/integrated-probe.mjs --mobile-red` | 1 | `mobile-red.stdout.log` / `mobile-red.stderr.log` | Intended geometric RED before CSS correction: clientHeight43 versus content52–321px; history/action controls outside cells |
| `cd apps/web && node ../../odd/design/transfer-origin-restitution-ux/integrated-probe.mjs --mobile` | 0 | `mobile-green.stdout.log` / `mobile-green.stderr.log` | Four390px actor/state cases passed, twelve geometry checkpoints with zero issues, zero business writes |
| `cd apps/web && npm test -- src/TransferRestitutions.test.tsx` | 0 | `mobile-focused.stdout.log` / `mobile-focused.stderr.log` | 104/104 passed |
| `cd apps/web && npm run build` | 0 | `mobile-build.stdout.log` / `mobile-build.stderr.log` | Final CSS compiled; tsc passed; >500kB chunk-size warning remains |
| `git diff --check` | 0 | `mobile-diffcheck.stdout.log` / `mobile-diffcheck.stderr.log` | Passed |

`mobile-red-results.json` retains the measured failure; `mobile-green-results.json` contains all four complete cases. Each checks both products and preserved quantities above Gestiones, pending/applied/no-history states, real history and technical evidence clicks, no overlapping cells or controls in collapsed/expanded/returned views, no horizontal overflow, explicit consultation, origin replacement capture, destination accept/reject review, focus trap/Escape restoration, count/restitution switching and zero business writes. No forced clicks, timeout retries, live API or database calls were used.

Final screenshot paths (all in this directory):
- `mobile-green-390-actor-{1,2}-{pending,applied}-{initial,collapsed,history}.png`.
- `mobile-green-390-actor-{1,2}-pending-review.png` and `mobile-green-390-actor-2-pending-reject-review.png`.
- Geometric RED: `mobile-red-390-actor-1-pending-{initial,collapsed,failure}.png`.

Destination pending collapsed and origin applied history screenshots were directly inspected: cells expand with content and disclosures, without the previous vertical overlap. Full-page images include the existing application shell; no shell redesign or reference-pixel equality is claimed. Earlier four desktop browser cases, full2592 tests and typecheck evidence remain applicable per parent authorization; they were not swept again for this mobile-only CSS change. T2/T3 S1–S3 self-verification is complete.

## Previous C/D evidence (historical partial handoff)

The following records the earlier boundary and failure, superseded only by the explicitly authorized correction above.

## Review boundaries

- `boundary-B.patch`: 164 additions + 27 deletions = **191** tracked authored changed lines (source/tests/README).
- `boundary-C.patch`: reconstructed against B, 129 additions + 34 deletions = **163** tracked authored changed lines (source/tests/README). Existing tests were retained; only deliberately changed presentation selectors/disclosure steps were adapted.
- D: `integrated-probe.mjs`, **184 authored lines**, plus this evidence document and task progress. Patches are generated review aids, not additional implementations.
- A original references remain separate: five HTML files, **2,341 generated lines / 119,375 bytes**, and five PNG files, **251,312 bytes**. `manifest.json` has 126 generated provenance lines; `verify-archive.py` has 22 authored lines. `sources.json` was parent-provided and is unchanged.

## Commands and observed exits

All commands ran in the foreground from the repository root. Each command used `> <stdout path> 2> <stderr path>`; all paths below are relative to this directory. No timeout was automatically retried.

| Exact command before log redirection | Exit | stdout / stderr | Result |
| --- | --- | --- | --- |
| `cd apps/web && npm test -- src/TransferRestitutions.test.tsx src/TransferPending.test.tsx` | 1 | `c-red.stdout.log` / `c-red.stderr.log` | Three intended missing-presentation failures; 337 existing cases passed |
| `cd apps/web && npm test -- src/TransferRestitutions.test.tsx src/TransferPending.test.tsx` | 1 | `c-green.stdout.log` / `c-green.stderr.log` | Two new quantity text queries failed across a strong element; 338 passed |
| `cd apps/web && npm test -- src/TransferRestitutions.test.tsx src/TransferPending.test.tsx` | 0 | `c-green-corrected.stdout.log` / `c-green-corrected.stderr.log` | Exact quantity assertion retained, query corrected; 340 passed |
| `cd apps/web && node ../../odd/design/transfer-origin-restitution-ux/integrated-probe.mjs` | 1 | `browser.stdout.log` / `browser.stderr.log` | Initial fixture rejected compiled font assets; `integrated-results.json` retains failure |
| `cd apps/web && node ../../odd/design/transfer-origin-restitution-ux/integrated-probe.mjs` | 1 | `browser-corrected.stdout.log` / `browser-corrected.stderr.log` | Four desktop cases passed; first mobile case failed with 10-second history-click timeout; `integrated-results-corrected.json` |
| `cd apps/web && npm test -- src/TransferRestitutions.test.tsx src/TransferPending.test.tsx` | 0 | `final-focused.stdout.log` / `final-focused.stderr.log` | 340/340 passed |
| `cd apps/web && npm test` | 0 | `final-suite.stdout.log` / `final-suite.stderr.log` | 2592/2592 passed, 36 files |
| `cd apps/web && npm run typecheck` | 0 | `final-typecheck.stdout.log` / `final-typecheck.stderr.log` | Passed |
| `cd apps/web && npm run build` | 0 | `final-build.stdout.log` / `final-build.stderr.log` | Passed; size warning for minified chunk >500kB |
| `python3 odd/design/transfer-origin-restitution-ux/verify-archive.py` | 0 | `final-archive.stdout.log` / `final-archive.stderr.log` | Ten hashes, sizes and source URL associations verified |
| `git diff --check` | 0 | `final-diffcheck.stdout.log` / `final-diffcheck.stderr.log` | Passed |

`verified-source-hashes.json` identifies the final product TSX/CSS checked by the corrected browser run and final test/build commands. No product edits followed that run. CLI differential testing does not apply: no CLI command/options/parsers changed.

## Browser proof and failure

The probe compiles the actual App in memory with Vite, imports installed Playwright through `createRequire`, and intercepts every request. Only fictional GET API responses and compiled local assets are served. EventSource is stubbed. No live login, runtime API, POST, database access or downloaded HTML execution occurs. Existing capture/review dialogs are exercised without final submission.

Desktop1280 passed for physical origin and destination, both pending and partially-applied/closed fixtures. Each fixture also contains a second product with plain empty history. Checks cover one management table, immutable quantities above Gestiones, proposed versus applied quantities, declaration/raw multiline reason, collapsed/expanded audit and technical evidence, exact recorded before/after values, explicit consultation before action admission, replacement capture, accept/reject review, focus trap and Escape restoration, count/restitution switching, no horizontal page overflow, no page errors, and zero business writes.

At mobile390 origin/pending, initial quantities, role text, raw reason and no horizontal page overflow passed. The subsequent history click timed out because the Acción cell intercepted pointer events; bottom navigation also intercepted some auto-scroll positions. The screenshot shows substantive vertical overlap across numeric, action and pending rows. No forced click was used to hide this failure. Mobile forms/history, mobile applied cases and mobile destination cases were not proved.

Likely next scoped correction: remove inherited fixed cell heights for the block/grid mobile table in `apps/web/src/transfer-restitutions.css`. Repository `style.css` sets global `td { height: 44px; }`; it was read, not edited. Renewed correction/browser execution needs parent authorization because the bounded correction was already consumed fixing fixture asset routing. No further attempt was made after the mobile timeout.

## Screenshots for readback

All paths are in this directory:

- Desktop both actors: `integrated-1280-actor-{1,2}-{pending,applied}-{initial,collapsed,history}.png`.
- Real review steps: `integrated-1280-actor-{1,2}-pending-review.png` and `integrated-1280-actor-2-pending-reject-review.png`.
- Mobile failure: `integrated-390-actor-1-pending-{initial,collapsed,failure}.png`.
- Initial font-routing failure retained: `integrated-1280-actor-1-pending-failure.png`.

The desktop destination collapsed screenshot and mobile origin collapsed screenshot were inspected directly. Desktop is compact with original transfer context; mobile is visibly broken. Original reference PNGs may lag HTML-only changes and are not final pixel truth.

## Invariants and remaining work at the preceding partial handoff

No hooks, domain models, authorization/recovery helpers, backend/API contracts, stored data, operation keys, revisions, generations or focus-isolation helpers were changed. Existing independent rejection without count evidence and valid pending-proposal replacement remain covered. Application closure, immutable receipt/audit evidence and BigInt quantities remain covered. No new controls claim retention from capacity or manufacture stock/transaction evidence.

At the preceding partial handoff, S1/S3 presentation was not complete because mobile controls were unusable, and S2 mobile proof was incomplete. The authorized correction and targeted GREEN results above resolve that blocker; user visual acceptance remains outside this self-verification. Engram mirror was unavailable at the A/B handoff (core/session-resume incompatibility); canonical task progress remains in the task document.
