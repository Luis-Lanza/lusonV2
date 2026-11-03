# Unified reconciliation hook

`useTransferUnifiedReconciliations` connects the [coordinator](unified-reconciliation-coordinator.md)
to the [transport](unified-reconciliation-transport.md) for one received transfer.
This delivery adds no caller, table or modal mount: importing the hook performs no requests.

## Explicit actions

- Mount and transfer invalidation trigger passive GETs only when enabled with valid owner and captured received-record evidence.
- `prepare(action, input)` stages validated intent without sending a mutation; `cancel()` clears prepared intent.
- `confirm()` submits the prepared attempt through the coordinator's write ticket.
- `refresh()` and `recover()` explicitly GET evidence; neither automatically retries a mutation.
- `retry(variant)` explicitly resends the retained exact attempt, not a new operation derived from the current head.
- `onConfirmed(owner, operation)` reports confirmed evidence only while the captured context remains valid.

## Private lifetime and recovery

The default store is weakly memoized by the controller's authority-reader function, not a shared singleton store.
An injected store remains supported. The coordinator synchronizes private owner scope before selection and reads.
Owner epoch, generation, account, location and readiness changes mask private state; request/captured-record and
controller/API/store identity fences prevent obsolete responses or callbacks from crossing contexts.

Passive GET 401 responses may mask this pane but never settle or change the session. Explicit reads and writes
may settle unauthorized status only for the still-current captured epoch. Writes obtain current authenticated
credentials immediately before dispatch; credentials are not retained in attempts.

Unmount and scope cleanup abort flights and release coordinator tickets. An interrupted write remains uncertain
for the same owner and requires explicit recovery or retry. Exact durable GET proof can confirm an attempt and
retire its live POST; a late POST response cannot overwrite that confirmation.

## Verification boundary

The hook tests cover passive reads, explicit exact retry across remount, owner masking, DOM invalidation,
passive versus explicit 401 handling, obsolete reads, read-proof retirement and interrupted writes.
These are frontend seam tests, not backend atomicity or browser/end-to-end proof. S3–S7 are supported through
the existing model/API/coordinator contracts; S2 table/modal integration remains a separate delivery.
