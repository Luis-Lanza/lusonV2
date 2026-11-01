# Unified reconciliation presentation foundation

## Delivery boundary

This slice installs pure presentation helpers and a read-only history component.
Neither TransferDetail nor TransferPending imports or mounts them in this slice.
The existing table, entry points and mutation behavior remain unchanged.
The whole verified View source includes a future received-table projection helper;
its presence does not activate that projection in any caller.

## Evidence and arithmetic

- Consume coordinated, decoded snapshots; the decoder establishes Current validity.
- Keep original receipt, nested Legacy evidence and authoritative Current separate.
- Project Current, never the latest pending or rejected proposal as an agreement.
- A later pending or rejected proposal does not replace an earlier applied Current.
- Calculate hypothetical effects with bigint and canonical nonnegative quantity text.
- Retention cannot exceed the positive difference between expected and dispatched.
- Overdispatch permits zero retention, not simultaneous positive origin retention.
- Compare target ledger totals with Current debit/credit, not original quantities.
- For 10 declared, 9 dispatched, 8 arrived and 1 retained, a debit baseline of 10
  yields origin +1 and destination unchanged at credit 8; transit unknown remains 1.
- If origin debit is already 9, the same facts yield no additional origin credit.
- Unlocated differences stay unresolved; excess arrival is not inventory credit.
- These calculations neither guarantee stock nor grant mutation capability.

## Read-only history

History renders original quantities separately from effective Current and lists
proposal states, decisions, origin attestations and recorded application deltas.
It adds no controls, events, fetches or mutations and fabricates no missing history.
A null snapshot renders nothing. Future callers must fence visibility by owner
and request; this component does not replace those authority checks.

## Specification support and proof boundary

S3 supports retained historical evidence; S4 supports displaying recorded atomic
applications, not proving their atomicity. S5–S7 support unresolved differences,
exact hypothetical effects, partial retention and overdispatch constraints.
S2 table/modal integration and S7 bilateral authorization remain caller/backend
work, not activated or established by this foundation.
Parent job55 observed RED: both suites failed on missing View/History imports,
exit 1, before real tests ran. GREEN for both suites plus the existing model,
typecheck and build remains parent-owned and pending at assembly handoff.
No browser, backend E2E, runtime inventory or UI activation proof is claimed.
