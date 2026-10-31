# Safe deletion: verification accepted, preview not deployed

S1–S4 passed implementation verification and the final independent source/evidence review. The persistent preview remains stopped. No push, PR or merge was performed.

## Review result

| Requirement | Result | Evidence |
| --- | --- | --- |
| S1: administrator deletion and protected warehouse/admin | Met | Service/HTTP guards, UI confirmations and real-browser protected controls |
| S2: hidden retired records, revoked sessions, retained history | Met | Public directory/session/replay/rollback tests; same live SSE stream closed before the operator's natural Login view |
| S3: distinct deletion and branch blockers | Met | Stock/reservation/user/latest received-work blockers; both overlapping transaction orders; UI cancellation and blocked stock retirement |
| S4: preserve authority and existing contracts | Met | Source lock-order/admission/replay review, full suites, strict public differentials and browser metadata/selection checks |

Independent verifier `mvvqto16-2i-591q` found no candidate-caused severe blocker and checked 786 bound file entries with zero mismatches. This is not native review approval or deployment authorization.

## Observed checks

All roots below are under `/tmp/luson-account-administration-82bce681/`.

| Check | Accepted result | Evidence root |
| --- | --- | --- |
| Full HTTP | PASS, 318.480s | `d6-authorized-cleanup-UxTNdeyg/receipts/` |
| Stock-wait regression | PASS, 0.714s | `d6-stock-wait-Hk4KopjA/freshreceipts/` |
| Full transfers | PASS, 333.979s | `d6-stock-wait-Hk4KopjA/freshreceipts/` |
| Frontend | 185 affected / 3185 full tests; typecheck and build PASS | `d5-authorized-pH2r66RF/receipts/` |
| Public differential | 56 accepted, zero failures after three source-justified oracle corrections | `d6-oracle-reclassify-np8tjibg/` |
| First real-browser attempt | PASS, Go 7.588s; strict ten-key result and pre/post guards accepted | `d6-browser-9483b02a/` |

The three original browser screenshots were inspected: account confirmation at 1440px and branch confirmations at 1440px/390px. Controls were usable, narrow layout had no horizontal overflow, and password inputs were masked. The browser checked account/branch cancellation, protected controls, stock rejection, directory omission, metadata fallback and the surviving operator's own branch. The same operator stream recorded response 38 → account DELETE start 59 → stream close 69 → natural Login observation 75, without a harness logout or manual session probe.

## Evidence interpretation

- Exact private marker/version writes are source/schema evidence, supported by public authority, rollback and idempotence effects—not private-row runtime telemetry.
- The stock-request differential rejected insufficient stock before retirement admission. It proves unchanged existing rejection, not retirement-guard coverage.
- Two restitution cases reach retirement admission before later action-role checks in both refs. Only the exact retired-location SQL error translation explains their intended 503→409 change; role guards remain intact.
- Reclassification preserved all 56 before/after observations. The original stopped/failed comparisons and earlier failed test receipts remain unchanged; they were not retroactively relabeled as successful runs.
- Browser assets have a current bound inventory and accepted-build provenance, not a historical build-time digest. The existing 630.09kB bundle warning remains nonblocking.
- Native assessment was unavailable because of untracked-scope declarations. No native approval or authority burn is claimed; the required independent verification passed separately.
- Preparation handoffs and pinned runners describe historical execution contracts. They are not permission to replay maintenance or passing workloads. The exact test-database deletion grant was consumed once.

## Local work units

- `708113b6fca81c512fc0af4564c06ce434c5c0d4`: concurrency observation repairs, preserving effects and original timeouts.
- `f21fb95abcbfccc8e60b8427b7305bad4aa5279c`: public retirement replay, rollback and overlapping-winner proofs.

Production behavior remains the previously verified feature implementation through `0bbb729`; these closing source units add verification only. Unrelated working-tree changes, raw receipts, private preview files and ignored scratch drivers remain untouched and unpublished.

## Needs your decision

D7 requires explicit authorization to update and restart the separate preview at `http://127.0.0.1:8080`. Its server was stopped at the user's request. Do not restart it automatically, provision accounts, read human passwords, or reset/delete manual records.

Risk: items 2 and 4 (authority/session retirement and concurrent transaction ordering).
