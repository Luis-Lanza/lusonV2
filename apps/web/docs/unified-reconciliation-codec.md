# Unified reconciliation codec (inert delivery unit)

This unit supplies closed v2 snapshot and operation-envelope decoders plus intent
normalization. It does not activate runtime reconciliation: no API transport,
recovery store, hook, modal, or other UI is included.

## Evidence boundary

`parseUnifiedReconciliations(raw, record)` binds the snapshot to the independent
received `TransferRecord`. Original receipt evidence, coherent legacy histories,
and authoritative current state remain separate. Existing strict legacy parsers
are reused; ownership alone is not proof of an accepted application.

The decoder rejects unknown or missing fields, duplicate decoded JSON members,
noncanonical quantities, out-of-range values, mismatched identities, orphan
operations, inconsistent generations, and invalid accounting or attestations.
Captured results are immutable; rejected input does not rewrite the receipt.

## Accounting and agreement (S3–S7)

For original quantity E, agreed dispatch D, arrival A, and retention R:
`0 <= R <= max(E-D, 0)`, source debit is `max(E,D)-R`, and destination credit is
`min(D,A)`. Application deltas use existing ledger effects, so prior restoration
is not credited twice. Origin-side and transit-side unknown differences remain
separate; excess arrival is not inventory credit. Unexpected variants remain
audit-only, not unified workflow lines.

Either endpoint may initiate. Positive retention requires origin attestation;
acceptance belongs to the counterpart. Proposals, decisions, applications, and
operation identities must agree per variant. Pending or rejected ownership does
not replace a previous accepted application or fabricate historical evidence.

## Future consumer contract

`parseUnifiedReconciliationOperation` validates a closed v2 result against the
received record. `normalizeUnifiedReconciliationIntent` validates the exact
proposal or decision input shape and preserves lossless quantities. Neither
function grants authorization, establishes retry eligibility, performs a write,
or guarantees backend atomicity. Future transport and recovery consumers must
retain these guards and independently handle authorization and uncertain writes.

The model tests and fixtures exercise receipt separation, accounting, legacy
coexistence, attestations, and malformed evidence. Parent-owned focused tests,
regressions, typecheck, and build provide integration evidence for this slice;
they do not constitute runtime, browser, or database activation proof.
