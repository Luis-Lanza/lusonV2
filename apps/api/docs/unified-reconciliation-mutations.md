# Unified reconciliation Store mutations

This delivery adds Go Store mutations for originally expected receipt variants.
It does not install HTTP routes, unified review discovery or frontend controls.

## Public contract

- `ProposeUnifiedReconciliation` takes a variant, operation key, expected workflow
  revision, dispatch D, arrival A, total retention R, origin attestation and reason.
- `DecideUnifiedReconciliation` takes a variant, operation key, expected revision,
  acceptance flag, origin attestation and reason.
- Both return immutable `UnifiedReconciliationOperation` evidence. Exact retries
  return the original operation; changed retry identity returns `ErrRetryConflict`.

The Store reuses `CheckRestitutionAccess`, existing input validation and
`beginPersonal`, then invokes `transfer_unified_reconcile` in one transaction.
SQL owns bilateral consent, predecessor checks and joint inventory effects.
Either physical endpoint may initiate; only its counterparty decides. Only origin
may attest retention. Rejection remains possible when acceptance is stale.

## Accounting and historical evidence

For original debit E, retention satisfies `0 <= R <= max(E-D,0)`.
Target source debit is `max(E,D)-R`; target destination credit is `min(D,A)`.
Deltas use actual receipt, legacy and unified effects, not a reconstructed history.
For E10/D9/A8/R1 with baselines10/8, effects are origin +1 and destination 0,
with transit unknown1. Prior restoration1 changes those effects to 0/0.
Unknown differences are not confirmed losses, returns or inventory credits.

The existing coordinated reader retains original receipt and nested legacy
history separately from authoritative current accounting. Ownership begins with
a proposal, but only acceptance changes the current source to unified. New legacy
writes on owned expected variants are fenced; historical exact retries and
rejections remain available. Unexpected variants remain audit-only.

## Errors and verification boundary

The adapter maps SQL refusals to `ErrForbidden`, `ErrRetryConflict`, `ErrInvalid`,
`ErrDecisionConflict` or `ErrInsufficientStock`; other failures fail closed.
Failed decoding or commit returns no successful operation. Transaction cleanup
uses the existing bounded rollback helper.

The copied Store tests cover atomic accounting, prior effects, roles, retries,
replacement, stale consent, rollback, concurrency and historical-body compatibility.
They preserve the separate readonly reader test. Historical-body compatibility
is not a genuine populated pre018-prefix upgrade test; that belongs to a later
unit. Existing counters still use the six installed review categories.

Parent job37 observed the intended compile-only RED for missing mutation methods;
no database workload ran in that step. Runtime GREEN and API compile verification
remain parent-owned. Test presence and exact source assembly do not establish
runtime success or install future HTTP/UI capabilities.
