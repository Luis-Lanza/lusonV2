# Count-only verification

## S2–S4 table correction — current self-verification complete; visual assessment pending

- Product structure: one shared desktop management table, mobile labeled blocks, plain empty-history state, compact revision/result/date rows, secondary detail/technical evidence. Before counts use original receipt at base 0 or an explicitly applied predecessor; otherwise quantity only. Domain handlers/forms unchanged.
- Structural RED: exit 1, 2 intended failures /171 passes. Focused correction initially 172/173 (selector matched pending overview too), then exit 0, 173 passed.
- Integrated `cd apps/web && node ../../odd/design/transfer-count-compact/integrated-probe.mjs`: exit 0 after explicitly authorized Chromium-import correction, one attempt. Actual App, synthetic intercepted GETs only, proposer 2/reviewer 1 at 1280/390. Main table above management and contained without document horizontal overflow; current/proposed separation, empty history, revision details, existing forms/focus/Escape, restitution switching and zero writes passed. Eight collapsed/history screenshots `integrated-*-actor-*-*.png`; request evidence in `integrated-results.json`. No visual acceptance claimed.
- Product `cd apps/web && npm run build`: exit 0, 73 modules; >500 kB advisory only. Product typecheck passed.
- First full suite: exit 1, 2580 passed/4 failed. Old selectors in TransferPending.test.tsx expected combined result/revision text and product article roles. Human approved exact selector-only scope extension; no product changes were made to satisfy them.
- Final `cd apps/web && npm test -- src/TransferCountCorrections.test.tsx src/TransferPending.test.tsx`: exit 0, 409 tests /2 files passed.
- Final `cd apps/web && npm test`: exit 0, 2584 tests /36 files passed.
- Final `cd apps/web && npm run typecheck`: exit 0, no diagnostics.
- Last correction changes only three integration selectors, preserving both result/revision checks and absence of proposal action during uncertainty. Prior successful product build and browser results still apply; product bytes unchanged by this selector-only handoff.

## Earlier parent-requested correction — historical partial status

- Moved count technical evidence and applied-effect text into collapsed history without deleting values/dates. Exposed pending proposal reason verbatim before review, using existing safe wrapping.
- `cd apps/web && npm test -- src/TransferCountCorrections.test.tsx`: RED exit 1 (missing raw pending reason), 170 previous tests passed; final GREEN exit 0, 171 passed.
- `cd apps/web && npm test`: exit 0, 2582 tests / 36 files.
- `cd apps/web && npm run typecheck`: exit 0.
- `cd apps/web && npm run build`: exit 0; >500 kB advisory only.
- `cd apps/web && node ../../odd/design/transfer-count-compact/integrated-probe.mjs`: exit 1 before browser launch. `TypeError: Cannot read properties of undefined (reading 'launch')` at line 38. Dynamic import through CommonJS resolution did not expose the named Chromium export. No integrated screenshots/results were produced. No retry under the single bounded-attempt instruction.
- Integrated App table containment, final collapsed appearance, both participants at 1280/390, real trigger focus/Escape and restitution switching remain **unproven**. T3 is partial. Existing isolated screenshots below predate this correction and are not final layout proof.

## Earlier initial implementation evidence (historical)

Branch: `fix/transfer-count-compact`, base `dda4e77`. No commits or runtime changes.

## Automated checks

- `cd apps/web && npm test -- src/TransferCountCorrections.test.tsx`: RED exit 1, 3 new tests failed and 167 existing passed. Missing pending summary and history disclosure were the intended failures.
- Same focused command after implementation: exit 0, 170 passed.
- `cd apps/web && npm test`: exit 0, 36 files / 2581 tests passed.
- `cd apps/web && npm run typecheck`: exit 0, no diagnostics.
- `cd apps/web && npm run build`: exit 0, 73 modules transformed. Existing large-chunk advisory (JS >500 kB), no build error.
- `git diff --check`: exit 0.

## Synthetic Chromium check

A foreground `cd apps/web && node --input-type=module` probe bundled the existing test fixture and actual component using Vite `write:false`, then loaded it into Chromium using an intercepted fixture-only URL. All requests were fulfilled locally; no application server, login, backend, database, or business POST was used. No remote archived HTML was executed.

Initial probe exited 1 because the bundle was injected as a classic script (`window.renderCount is not a function`). One correction enabled the React plugin and module script injection; the corrected probe exited 0.

At 1280×900 and 390×900, for both proposer (location 2) and reviewer (location 3):

- Exactly one pending current→proposed comparison, correct endpoint-specific action.
- No document horizontal overflow; action target at least 44px high.
- History initially collapsed; reasons/actors expand locally and preserve decision reason.
- Existing modal opens, traps initial focus, closes with Escape, and restores trigger focus.
- Zero fixture propose/decide invocations.

Screenshots `fixture-*-actor-*.png` show actual synthetic component output with history expanded, not integrated transfer-page or production screenshots. The unchanged main transfer table and restitution UI were verified by source-diff isolation, not an integrated browser fixture. Existing tests preserve permission, BigInt, revision, recovery, focus and modal invariants. No CLI command/parser changed, so CLI differential testing is inapplicable.

## Design provenance

`manifest.json` records all five selected screen IDs, titles, archive UTC time, original HTML/PNG SHA-256 and byte sizes. Public source URLs remain in `sources.json`. Archived PNGs may lag DOM-only edits; none is claimed as final pixel truth. Remote HTML is untrusted visual reference only.

Review slices: original generated assets/provenance; count-specific implementation + tests + README. No backend, table-global CSS, restitution, request or modal handler changes.
