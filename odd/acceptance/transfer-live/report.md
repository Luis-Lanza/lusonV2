# Live transfer acceptance — master cf2e162

## Result
CLOSED — human accepted the executed finite live acceptance matrix on master cf2e162: "ok! cerremos la aceptacion y hazme un resumen de todos los flujos que probaste". Includes the explicitly authorized read-only mobile/privacy continuation. No product code fix was needed. This is representative acceptance evidence, not exhaustive proof of every payload, timing or failure mode.

## Observed passes
- Actual GUI login/logout for Almacén, Sucursal A and Sucursal B; 190 inventory variants per location observed through authenticated GET.
- Pilot TR-006: branch request to warehouse, approval, dispatch and exact receipt of one unit.
- Fifteen additional cases TR-007–TR-021: warehouse request rejection/pending cancellation/approved cancellation; interbranch request and branch-to-warehouse proposal lifecycle/rejection/both cancellations; direct warehouse shipments to both branches plus approved cancellation.
- Receipt examples: exact, shortage (3 sent / 1 received), excess (1 sent / 2 received / credit limited to 1).
- 43 complete inventory comparisons in pilot/matrix: expected reservation, release, dispatch and credit effects; other stocks unchanged.
- TR-010 count: propose2, accept2, propose1, replace3, reject3. Five exact count-history and full-inventory comparisons; only acceptance credited destination by one. Effective count/credit now2; original receipt remains1.
- Restitution: TR-010 propose1/replace1/reject; TR-014 propose1/accept. Five exact restitution-history/full-inventory comparisons; only accepted TR-014 credited its physical origin by one. Partial application closed the variant despite mathematical remaining capacity1. Original receipts and count histories unchanged. Retention statements explicitly described fictional local-trial scenarios, not real physical verification.
- Reload/deep-link and Back/Forward retained correct detail for four participant/record pairs: TR-010 actors2/3 and TR-014 actors2/1.
- Mobile390 count/rest history controls and overflow checks passed for three pairs: TR-010 actors2/3, TR-014 actor2. Six authenticated screenshots retained.

## Finding requiring a decision
- Audit stopped at TR-014, Almacén actor1, mobile390×900, before opening count management.
- After `scrollIntoViewIfNeeded`, the Gestiones button bounds were x251/y840.265625/w105/h44. Its center was inside the viewport but `elementFromPoint` did not hit it or its descendants (`unobscured:false`).
- This establishes an occluded position, not the blocking element, causality, permanence or whether ordinary extra scrolling makes it accessible. No automatic retry or source fix performed.
- Audit business writes:0. All three GUI logouts succeeded. Privacy cases were ordered later and were NOT RUN.

## Resolved by authorized read-only diagnosis and continuation
- Original failure retained above: fixed bottom navigation covered the initial sampled center after `scrollIntoViewIfNeeded`.
- `mobile-occlusion-journal.jsonl`: ordinary click opened the menu, manual scrolling exposed the button, and Tab/Enter worked. Business POSTs0; TR-014 detail/count/restitution unchanged. No functional product blocker demonstrated.
- `audit-continuation-journal.jsonl`: exit0, Almacén/TR-014 at390px passed both count and restitution views, history/closed actions, ordinary scroll/click checks and no page overflow. Two additional authenticated screenshots bring the mobile total to8 across4 participant/record pairs.
- Unrelated Almacén→TR-010 and Sucursal B→TR-014 normal-GUI requests returned404, with private product/reference/tables/action controls absent. No negative write probes.
- All570 inventory rows and original audit histories matched before/after; business writes0 and all three GUI logouts passed.

## Not proved
- Arbitrary backend write-denial403 probes, forced ambiguous-response recovery, simultaneous stale mutations, all possible payload/timing/boundary combinations, total-zero/unexpected-line receipt cases.
- No production-readiness or exhaustive all-flows claim.

## Data retained
16 new trial transfers (TR-006 through TR-021), five count operations and five restitution operations remain stored. No reset/delete/direct SQL/source edits. Runtime is rebuilt master cf2e162 at https://localhost:4323.

## Evidence
`parent-preflight.json`, `pilot-journal.jsonl`, `matrix-journal.jsonl`, `gestions-journal.jsonl`, `restitution-journal.jsonl`, `audit-journal.jsonl`, `mobile-occlusion-journal.jsonl`, `audit-continuation-journal.jsonl`, and eight `audit-*-390.png` screenshots. Original failed observations are preserved, not overwritten.

## Tooling failures, separate from app findings
Initial parent auxiliary API client failed local TLS verification after GUI login. Its raw error included a session cookie; the local log was redacted. Corrected preflight used browser same-origin fetch with pinned certificate public key and passed. No password/cookie/CSRF values are intentionally stored in these acceptance artifacts.
