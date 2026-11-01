# Coordinated reconciliation reader

`Store.GetUnifiedReconciliations` reads a received transfer for either physical
endpoint, using the internal `luson.transfer-reconciliation/v2` contract. This
unit exposes no Go unified proposal or decision methods and adds no HTTP route.
Migration 018 must already be installed.

## Evidence boundaries

- `Original` preserves every original receipt line, including unexpected variants.
- `Legacy` retains count, restitution and dispatch evidence with legacy meaning.
- `Current` identifies ownership separately from the source of applied accounting.
  Unified ownership alone does not establish an accepted application.
- `Lines` contains unified workflow history only for originally expected variants;
  `Operations` retains immutable operation evidence.

All four histories are read in one read-only repeatable-read transaction. Existing
legacy SQL expressions, restitution validation and timestamp normalization are
reused. The coordinated validator recomputes accounting from actual recorded
applications; it does not synthesize historical proposals or fall back to an
independently read current projection. Physical quantities remain null until a
unified agreement actually supplies them.

The three public legacy getters preserve their existing unowned behavior. Once
018 reports unified ownership, they fail closed with
`ErrUnifiedReconciliationRequired`, which wraps `ErrDecisionConflict`, rather than
present historical accounting as current. Participant privacy checks remain in
place before returning private history.

## Bounded reader proof

`TestUnifiedReconciliationReaderUnowned` uses the existing Store receipt lifecycle,
compares coordinated legacy evidence with all three public legacy getters, checks
both participants and private-actor refusals, and verifies expected/unexpected
original lines, absent unified physical facts, unchanged stock and immutable
receipt evidence. It does not exercise unified mutations or claim acceptance,
concurrency or upgrade coverage for this unit.
