# Unified reconciliation caller activation

## Scope

This unit activates the existing unified reconciliation hook and detail/modal seam in
`TransferPending`. It covers the caller portion of S2–S7; it does not introduce new
accounting rules, backend operations, or closure for deferred losses and returns.
The existing detail table remains the presentation surface.

## Authority and coordinated evidence

Only a received transfer with an authorized origin or destination participant enables
reconciliation reads. The caller retains its owner, selected-request, private-access,
and mount-bound authority fences, including the just-confirmed receipt path.

The unified hook reads the coordinated snapshot. Legacy count, restitution, and
dispatch recovery engines retain their existing mutation interfaces, but their audit
reads use only the coordinated snapshot's corresponding `legacy` evidence. No
legacy-current GET or historical-current fallback is introduced. Expected-variant
current facts are presented through the unified detail seam, not legacy overlays.

Unexpected-variant audit mutations and historical rejection/recovery remain available
through the existing engines. Confirmation uses the existing controller callback for
inventory, activity, and counter invalidation. Pending and in-transit workflows keep
their existing action composition.

## Modal and focus

The existing modal focus binding is passed to the detail seam. Its scope, owner,
request, availability, and mounted checks remain intact. Dismissing reconciliation
restores the stable Gestiones opener when it remains valid; opening or dismissing
review does not itself POST a mutation.

## Verification boundary

The parameterized caller test checks coordinated audit GETs and Gestiones focus for
Escape, close, and return dismissal. The parent observed its three expected RED
failures against the old caller before this production copy. The parent owns GREEN
verification of all 260 caller/App scenarios through the four established bounded
partitions, the detail/modal tests, typecheck, and build. This assembly does not claim
backend end-to-end proof, native approval, or final feature closure.
