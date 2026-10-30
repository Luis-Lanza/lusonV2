# Account administration: accepted implementation

The selected directory is implemented in the real React, Go and PostgreSQL stack. Required S1–S8 outcomes are covered by the evidence below. Changes remain local on `feat/account-administration`; nothing was pushed, deployed or published.

## Acceptance matrix

| Spec | Verified outcome | Evidence |
|---|---|---|
| S1 | Chosen directory mapped into the existing shell and design tokens; desktop/mobile views and final actual-stack capture reviewed. | UI `9738349`; T6 retained browser captures; final real-stack job40 PASS. |
| S2 | One protected warehouse administrator; personal branch accounts; no public signup or warehouse creation. | Schema/auth/API/CLI independent reviews; current HTTP suites and real protected login/account creation. |
| S3 | Administrator-only management; operators retain full assigned-branch operations, including dynamic-branch transfer decisions and creator-only cancellation. | API `c039e96`; HTTP correction `9f1350c`; scoped independent S2/S3/S6/S8 PASS. |
| S4 | Private temporary delivery, mandatory change, own-current-password change, administrative reset and private warehouse recovery command. | Auth `050016a`; UI `9738349`; CLI `cbadb57` real subprocess/PTY tests and independent S2/S4 PASS; final private handoff retirement. |
| S5 | Application database untouched; isolated test state; unrelated work and historical authorship preserved. | Fixture admission/ownership records and canonical task log; no historical actor backfill. |
| S6 | New branch starts with all 190 variants at zero; metadata, transfer directions, reservations, dispatch, receipt, rejection and cancellation work. | Nine public PostgreSQL/HTTP TestT8 functions, serialized legacy seam, final real-browser branch creation/190 zero rows. Retained realtime evidence is unchanged. |
| S7 | Reassignment, deactivation and reactivation; prior authority retired on relevant account changes. | T3/T5 lifecycle tests and independent review; current full HTTP seam. |
| S8 | New operations retain personal actor snapshots and immutable activity prefixes; historical unknown authors remain unknown. | Attribution `87dbfab`; current HTTP/transfer suites, dynamic-branch activity/replay assertions and independent review. |

Account and location IDs are independent keys and may coincide numerically. Authority derives from actual assignment, not numeric equality.

## Final observed checks

| Check | Result |
|---|---|
| Frontend suite | 3,168 tests passed; current runtime JavaScript/TypeScript sources are unchanged. The later CSS-only mobile correction has focused/build/browser proof. |
| Frontend focused independent check | 77 tests passed; scoped security review completed. |
| Frontend typecheck/build | Passed; existing approximately 627 kB bundle warning retained. |
| Private recovery | Focused and full auth/CLI suites plus API build passed; independent S2/S4 PASS. |
| Current independent TestT8 execution | Exit 0, 20.930 s; actual HTTP package 15.363 s. |
| Current serialized HTTP/transfers seam | Exit 0, 619.172 s; HTTP 293.414 s and transfers 322.796 s, neither cached. |
| Current API build | Exit 0, 1.422 s. |
| Final React → Go/SSE → owned PostgreSQL browser | Exit 0, 10.013 s whole attempt; Go test 3.146 s. All 11 checks true, 190 zero variants, no runtime/console/external errors, source guard true. |

The final browser created exactly one branch and one assigned personal operator through the real UI/API, then verified persisted assignment and removal of the submitted temporary password from the private handoff UI. No API responses were mocked. Parent inspected the masked capture. The isolated test server closed normally; there is no running preview URL.

## Historical failures and evidence limits

Earlier failures are retained, not rewritten as passing runs. The full chronology is in [the task log](../../tasks/account-administration.md). In particular:

- Original mobile reference capture failed on the unchanged artboard's overflow; mobile operator overflow required a scoped CSS correction. Application cases were completed under separate bounded authorizations.
- A recovery test initially targeted the fixture administration database through pgx's original connection string. Corrected tests use current randomized target fields. A separately authorized read-only audit found no migration/account tables; historical non-mutation is not formally proved.
- The first independent T8 run timed out at 30 s; the first broad seam failed an obsolete negative boundary and three fixture-settlement checks. An explicitly authorized exact inactive test-database retirement, boundary-test correction and serialized run preceded the successful current receipts. The old failure cause is not attributed beyond observed evidence.
- The single differential exited 1 for intended dynamic-branch rejection improvements, not PASS. Rejection and both dynamic cancellation boundaries are now pinned with public tests.
- Initial real-stack browser attempts failed a coarse account step, a Chromium setup stage, and then the exact-label select locator. Only the harness selector and isolated browser paths changed; application code was not altered to satisfy these checks. The final selector uses a unique creation-editor select and adds eight guards.

Native review assessment remained unavailable because of untracked scope; no native approval, receipt burn or review closure is claimed. Scoped independent reviews are separate evidence. T7 concurrency ordering has static evidence, not a new dynamic overlap proof. Cookie scheduling evidence covers a canceled old connection, not delivered late-cookie headers or all browsers. Internal allocator/throttle counters were not inspected. These limits are not waived tests or broader guarantees.

Raw local receipts, bindings and diagnostic artifacts are retained beside this report; private runtime scratch is retained under its explicitly authorized root. They are not a portable deployment or public evidence upload. No further tests were run merely to write this report.

## Delivery

Code slices: `0e0c8ca`, `050016a`, `820a9f9`, `77531cf`, `87dbfab`, `c039e96`, `9738349`, `cbadb57`, `9f1350c`. The closing documentation commit records this matrix and the reconciled task document. The chosen artboard is marked implemented; alternatives remain unchanged. Publishing, PR creation, merge, deployment and unrelated cleanup remain outside delivery.

Risk: items 2/3/4 — credentials, shared contracts and session coordination. Applicable scoped independent verification is recorded above; no risk-free claim is made.
