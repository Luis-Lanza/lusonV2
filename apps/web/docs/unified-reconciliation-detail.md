# Optional unified reconciliation in transfer detail

## Scope

This unit adds an opt-in `TransferDetail` presentation seam for S2–S7.
It does not activate unified reconciliation in `TransferPending` or other callers.
Existing callers that omit `unified` retain the legacy detail projection and controls.

## When a caller supplies the unified hook

- The existing received-detail table uses coordinated `Current` evidence through
  `projectUnifiedReceived`; legacy or original quantities are not a fallback.
- Missing current evidence shows “Conteo efectivo no disponible”.
  “Consultar conciliación” requests a refresh when the hook is not masked.
- The detail offers the direct “Resolver diferencia” action for expected
  variants, opening the existing unified modal. There is no management menu: it
  is the only remaining management flow. The button is retained as the opener so
  Escape can restore focus after the modal closes.
- The legacy count-correction, restitution and dispatch audit sections, their
  hooks and their stylesheets are removed (S5); their parsers and recovery
  history survive only as evidence read by the unified snapshot.
- Opening history includes unified history when evidence is not masked.
- “Ver recepción original” continues to expose immutable receipt evidence.

Optional `modalFocus` passes the caller's focus binding to the modal. The retired
`restitutionAPI` seam is gone with the legacy restitution write client; this
component does not create a new transport or reconciliation coordinator.

## Verification boundary

`TransferDetail.unified.test.tsx` is copied byte-for-byte from the main candidate.
It exercises coordinated table quantities, the single expected-variant entry,
modal opening, Escape focus restoration, original receipt evidence and refusal
of a missing-current fallback. Existing detail and modal tests remain the
regression checks for default behavior and modal interactions.

The parent observed the new test fail before implementation because the
“Conteo efectivo” table was missing. Post-copy focused tests, TypeScript and
build verification are parent-owned and pending; this document does not claim
caller activation, backend atomicity proof or end-to-end delivery completion.
