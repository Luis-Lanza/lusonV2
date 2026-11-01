# Discover unified reconciliation reviews

Unified reconciliation adds the seventh required-action category,
`review_unified_reconciliation`, and distinct personal activity labels. This slice
exposes review obligations; it does not add the reconciliation modal, client
transport or unified proposal codec.

## List and counts contract

- `GET /api/transfers?status=all&requires_action=true` includes a received
  transfer for the counterparty of its latest undecided unified proposal on an
  expected variant. Either endpoint may initiate; the proposer does not review
  their own proposal, and unrelated locations cannot discover it.
- `required_actions` appends `review_unified_reconciliation` after the six existing
  reasons. Existing category meanings and ordering remain unchanged.
- `GET /api/transfers/counts` includes the new category as a decimal string in
  `actions`, including `"0"` when empty. Store counts expose
  `ReviewUnifiedReconciliation`.
- `action_count` remains a union of transfer headers, not a sum of overlapping
  categories. `pending_total` retains its existing meaning.

## Acceptance blockers do not hide review

Insufficient stock and stale predecessor generations may prevent acceptance but
must not remove a pending review: rejection remains available. Replacement keeps
review assigned to the counterparty; a decision on the latest revision removes
that unified obligation. Discovery does not apply inventory effects or change
proposal/decision rules.

## Client boundary and history

The strict model recognizes all seven count keys and the ordered unified reason,
retaining lossless bigint quantities and counts. Unified review advice is valid
for either participant. Legacy responses without action metadata remain supported;
unknown, duplicated or out-of-order reasons remain invalid.

Personal activity accepts category `unified` with `propose`, `accept` or `reject`,
using existing actor, participant, timestamp and variant validation. It renders
“Conciliación unificada propuesta”, “Conciliación unificada aceptada” or
“Conciliación unificada rechazada”. Personal snapshots are escaped, and original
receipt quantities and historical categories remain unchanged.

## Scope and verification

This slice supports S3–S7 discovery and evidence preservation; it does not complete
the modal replacement or prove atomic domain effects. It adds no confirmed losses,
returns, unexpected variants, realtime scheduling or sorting changes.

Parent verification covers new Store/HTTP action tests, legacy discovery and
exact-category fixtures, API compilation, focused web tests and typechecking.
