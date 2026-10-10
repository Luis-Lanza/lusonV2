# Immutable transfer requests and whole-request decisions

`internal/transfers` creates durable, participant-private Pending requests,
approves whole requests with atomic source reservations and rejects whole requests
without inventory changes. `Dispatch` consumes approved requests at their
physical origin with atomic stock deduction. Creation does not hold stock;
approval/rejection themselves do not dispatch or receive. The guarded HTTP API
and commit-only invalidations are documented in [transfers-api.md](transfers-api.md).
`Receive` finalizes at the destination with exact line-level quantities and
immutable exceptions; only expected minimums become available stock.

The A01–A03/R02 and D1 sections below retain prerequisite implementation history;
the R1 contract supersedes their earlier lifecycle/count/HTTP fences. D2 dispatch
UI is complete; R2 receipt UI and manual smoke remain pending.

## R1 destination receipt and workflow counts

`Store.Receive(ctx, authenticatedIdentity, requestID, ReceiptInput)` returns the
complete persisted `Request` only after commit. Physical participant lookup
precedes destination authorization; authorization precedes normalized retry and
lifecycle conflict handling. Invalid identity is forbidden; missing/foreign ID is
not-found. A visible origin cannot receive or probe a finalized retry outcome.

Input `Items []Line` uses `Line.Quantity` as actual received quantity. Every
expected variant appears once, with zero allowed. Additional preloaded catalog
variants require positive actuals. Duplicates, noncatalog variants, missing
expected lines, negative actuals, unexpected zeros and all-zero receipts are
`ErrInvalid`. Positive actual existence is tested without an int64 aggregate;
cross-variant totals may exceed signed bigint. `NormalizeReceipt` copies and
sorts without mutating input, imposing no arbitrary smaller line cap.

Only In-transit can finalize. Pending/Approved/Rejected return
`ErrDecisionConflict`. Received plus identical sorted variant/actual pairs returns
the immutable persisted receipt without stock checks/writes. A changed valid
normalized payload returns `ErrRetryConflict`. No separate receipt retry key or
client-derived actor/time is accepted. Original creation replay, participant
Get/List, authorized Approve and Dispatch retries all return current Received;
authorized Reject returns `ErrDecisionConflict`.

Receipt shares the global integrity advisory lock, READ COMMITTED, 10-second
operation budget and 5-second background rollback. Lock the advisory key before
the participant header, then destination balances in sorted variant order.
Catalog completeness, all line rules and every destination addition are checked
before any INSERT/UPDATE. Addition overflow is `ErrInvalid`; driver/SQL failures
are sanitized `ErrUnavailable`, while Go context semantics remain intact. Every
failure returns a zero request and rolls back header, stock, lines, exceptions
and revisions together.

Migration 008 preserves 001–007 and extends header/allocation lifecycle guards to
Received. `receipt_location_id` and `received_at` are server-derived destination
and statement timestamp, no earlier than dispatch. Consumed allocations survive
unchanged, and active-only reservation coverage remains enforced. Immutable
`transfer_receipt_lines` persist expected/actual/available quantities per variant;
expected equals original sent quantity, or zero for unexpected catalog variants.
Available equals `LEAST(expected,actual)` exactly. `transfer_receipt_exceptions`
separately persist positive typed shortage/excess/unexpected quantities. No
exceptions become automatically available inventory.

Line INSERTs require the integrity lock, In-transit header and current creation
transaction. Deferred final-row guards reject standalone line commits, incomplete
receipts and arithmetic/ownership inconsistencies. Updates, deletes, appends after
finalization and truncation are refused. The header trigger prevalidates every
line and overflow before any credit, then credits only positive available units
and generates exact exceptions. Raw SQL finalization therefore cannot persist a
stock-free or header-only receipt. Exceptions may only be inserted by that header
transition. Owner-level disabling of triggers is outside the existing integrity
boundary; arbitrary SQL prelocking can still deadlock/abort.

`Receipt` contains sorted `Items []ReceiptLine` and `Exceptions []ReceiptException`;
`CheckReceipt` verifies persisted complete arithmetic before domain/wire exposure.
Received retains original request items, participants, approval and dispatch.
Unexpected-only arrivals record every expected shortage with zero inventory
credit; no automatic loss, return, discrepancy resolution or cancellation exists.

Counts remain one participant-filtered, read-only REPEATABLE READ aggregate:
`PendingTotal` counts participant Pending only; `ActionCount` counts Pending at
persisted approver, Approved at physical origin, In-transit at physical destination.
Each header contributes once, independent of units/items/pages. Received/Rejected
are no actions. The two totals share a snapshot, not a separate page request.
`ActionCount` may exceed `PendingTotal`. R2 must remove D2's outdated decoder
constraint and approval-only copy; the app remains stopped, with no old-client
production compatibility or versioned count layer added.

Migration 004 inventory and 006 participant status invalidations are unchanged.
Only positive credit produces inventory movement/hints. Unexpected-only receipts
produce participant transfer hints, not fabricated inventory updates. Rollback,
failed commit, reads and no-op retries produce no mutation hints.

Focused `TestR1*` tests use actual admitted isolated PostgreSQL databases and
connection-local tracer/PID wait handshakes. They cover line arithmetic, all
roles, overflow/max boundaries, unexpected-only and all-zero rules, full catalog,
normalized retries, complete recovery/replay, direct SQL bypass rejection,
immutable histories, injected rollback/deferred failure, canceled lock waits,
identical/conflicting and overlapping receipts, true count transitions/snapshots
and commit-only events. Pure normalization/decoder tests do not require PG.
Documentation has no meaningful behavioral RED. Native approval, commit and
human manual smoke remain parent-owned and pending.

## D1 whole-request dispatch contract

`Store.Dispatch(ctx, authenticatedIdentity, requestID)` returns the complete
persisted `Request` only after commit. Account and assigned location must agree.
Physical-participant lookup precedes origin authorization; authorization precedes
retry/conflict handling. The warehouse can dispatch requests whose physical
origin is warehouse, but remains forbidden to create requests. A warehouse
approver cannot dispatch a branch's `send_to_warehouse` proposal.

| Condition | Result |
| --- | --- |
| Nil context/store/pool | `ErrUnavailable`, zero request |
| Invalid/unassigned identity or visible non-origin | `ErrForbidden` |
| Nonpositive, missing or foreign ID | `ErrNotFound` |
| Origin dispatch of Pending/Rejected | `ErrDecisionConflict` |
| Origin dispatch of Approved | Commit whole In-transit outcome |
| Origin retry of In-transit | Current persisted outcome without mutation |

Dispatch uses READ COMMITTED, a 10-second operation deadline and bounded
5-second background rollback. It takes `pg_advisory_xact_lock(714025,1)` before
locking the participant header. Migration 007's header transition locks source
balances in ascending variant order, validates every active owned allocation,
and deducts each exact item quantity from `existing` and `reserved` together.
This keeps `available` unchanged, preserves other owned/independent holds and
never credits destination inventory. The database owns those coupled effects:
a direct SQL header transition cannot persist a stock-free dispatch. Missing or
uncovered stock aborts; any partial effects roll back with the header.

Migration 007 preserves 001–006 and extends the existing guards rather than
adding a ledger/framework. Request status now admits `in_transit`; immutable
original items and approval metadata stay sealed. `DispatchLocationID` and
`DispatchedAt` are nullable pointers, both absent before dispatch and both present
for In-transit. The database derives the origin location and statement timestamp;
dispatch cannot precede approval. The allocation's minimal `consumed_at` marker
retains immutable request/variant/source/quantity history. Only the header
transition may consume allocations; standalone consumption, release, reactivation,
delete and truncation are refused. Deferred final-row checks require exactly one
allocation per item with consumption matching the header. Only active allocations
contribute to numeric-sum reservation coverage; independent reservations may
still exceed that owned sum. Owner-level disabling of guards remains outside the
integrity boundary, and arbitrary SQL prelocking can still deadlock/abort.

Participant Get/List and identical original creation replay validate and return
In-transit consistently. Authorized Approve after dispatch returns the current
In-transit outcome without reserving again; Reject returns `ErrDecisionConflict`.
Authorized dispatch retries never recheck stock or issue writes. Standard Go
cancellation/deadline semantics remain intact; driver failures are sanitized.
Every failure returns a zero request. Reads/replays preserve immutable payload,
participant privacy and original creation-key conflict semantics.

Existing inventory/status triggers release metadata-only hints on commit.
Rollback and mutation-free retries add no revisions or hints. Pending/action
counts retain their approval-only meaning. Receipt, cancellation and direct
warehouse creation are not admitted by this migration.

`TestD01DispatchDependencies` is pure. `TestD01DispatchStore`,
`TestD01DispatchSchema` and `TestD01DispatchConcurrency` use the existing admitted
per-test PostgreSQL databases for all flows, stock/reservation snapshots, retained
history, direct-SQL guard rejection, midwrite rollback, retries/replay and actual
lock-wait handshakes. HTTP/event coverage is described in the API contract.
Verification does not establish deployment, manual smoke or independent approval.

## Trusted entry points

Use `transfers.New(pool).Create(ctx, identity, input)` with the actual
server-authenticated `auth.Identity`. Never construct identity from a client
location, selected inventory view, username or request body. Account and assigned
location IDs must agree; only provisioned branches 2/3 may create. Warehouse
creation is forbidden because its future contract requires reservation.

| Input | Derived physical origin | Destination | Approver |
| --- | --- | --- | --- |
| `request_stock`, counterparty 1 | Warehouse 1 | Creator branch | Warehouse 1 |
| `request_stock`, other branch | Other branch | Creator branch | Other branch |
| `send_to_warehouse`, counterparty 1 | Creator branch | Warehouse 1 | Warehouse 1 |

`Get(ctx, identity, id)` returns a complete record only to its physical origin or
destination. A valid uninvolved account gets the same `ErrNotFound` as for a
missing ID. Authentication/session validation remains the caller's responsibility;
this store is not a replacement for existing middleware.

## Exact payload and retry authority

- One to 190 distinct catalog variants, with positive `int64` quantities and
  positive IDs bounded to PostgreSQL `integer`. Duplicates are rejected before
  sorting a copy. Quantities are never added into an overflow-prone total.
- Retry keys are opaque, case-sensitive `[A-Za-z0-9_-]{16,128}` values. They are
  not trimmed or normalized. Future clients must keep them private/in-memory.
- Versioned SHA256 canonical payloads include kind, authenticated creator,
  counterparty, item count and sorted fixed-width variant/quantity pairs. Retry
  keys and usernames are excluded from the fingerprint.
- An actor/key-scoped transaction advisory lock serializes retries; the unique
  `(creator_location_id,retry_key)` constraint remains final authority. Hash
  collisions can cause contention only, never shared identity or replay.
- Existing-key lookup precedes stock validation: an identical payload returns
  the original complete record with `Replayed=true`, even after stock decreases.
  A different payload returns `ErrRetryConflict`. Another actor can use the same
  key independently. An ambiguous commit reply is recoverable by the same retry.

## Atomic creation and database protections

Creation uses READ COMMITTED, a 10-second operation deadline and a bounded rollback
context. For a new key, all selected physical-source balance rows are locked in
ascending variant order. Missing catalog/balance rows and insufficient available
stock reject the whole request before insertion. A competing stock mutation is
revalidated after its row lock releases. Header and every item commit together;
Pending requests do not consume availability, even when several request the same
stock. Approval must independently revalidate and reserve later.

Migration 003 adds only `transfer_requests` and `transfer_request_items`, plus
supporting sequence/functions/triggers. It preserves migrations 001/002. Database
checks enforce legal branch direction, Pending-only creation, positive IDs/items,
retry/fingerprint bounds, foreign keys and uniqueness. Deferred completeness
requires 1–190 items. An internal `creation_xid` permits item insertion only within
the header's creation transaction; later appends, updates, deletes and truncation
are refused. Migration 005 adds the narrowly admitted schema transitions below,
not an implicit approval/rejection during creation. Database owner access remains administrative authority,
not a security boundary against an operator disabling protections.

Public references use a global positive BIGINT `NO CYCLE` sequence: `TR-001`,
`TR-999`, `TR-1000` and beyond. Rollback may consume sequence values; numbering is
not gapless and retries never allocate another reference. Records join the sealed
catalog's exact brand/model, canonical decimal Ah and explicit L/R polarity.
Neither retry material nor account usernames appear in records. Future HTTP DTOs
must serialize quantities and numeric identifiers losslessly, rather than
assuming JavaScript number precision.

Errors are stable `ErrForbidden`, `ErrInvalid`, `ErrNotFound`,
`ErrInsufficientStock`, `ErrRetryConflict`, `ErrDecisionConflict` and sanitized
`ErrUnavailable` values.
Cancellation/deadline errors retain their standard Go semantics. Driver/config,
private credentials and raw SQL errors are not returned.

## A01a lifecycle persistence prerequisite

Migration 005 preserves migrations 001–004. Requests must still be created Pending
with null decision metadata. Only Pending → Approved/Rejected is admitted; no
same-status update, reopen or terminal mutation is allowed. Original identity,
flow participants, retry fingerprint, creation timestamp/xid and items stay
immutable. The one persisted decision supplies lifecycle history without a
generic audit/event framework. Its location comes from the persisted approver;
its timestamp comes from the server statement and cannot precede creation.

`transfer_request_allocations` owns each request/variant once, with an immutable
item foreign key, exact item quantity and header-derived physical origin.
Deferred checks inspect **current final rows**, including under `SET CONSTRAINTS
ALL IMMEDIATE`: Approved owns every item, while Pending/Rejected own none. Every
source balance must cover the numeric sum of owned allocations. Equality is not
required: independent holds remain valid. Physical `existing` is unchanged by
allocation storage itself, and the existing balance constraints still apply.
Allocation updates/deletes/truncation are forbidden. Balance deletion/relocation
cannot strand allocations; balance truncation is forbidden because it bypasses
row-level deferred checks. Delete-and-reinsert may restore final coverage.

All protected header UPDATE, allocation INSERT and balance UPDATE/DELETE
statements acquire the same transaction-owned reservation-integrity advisory
lock (`pg_advisory_xact_lock(714025, 1)`) before row locking. These writes require
READ COMMITTED so waiting writers can validate newly committed state. Other
isolation levels remain available for reads. A02 approval transactions
acquire this lock **before** explicit request/balance locks. Arbitrary SQL
that prelocks rows can deadlock and abort; universal deadlock-free success is not
promised. The committed invariants, not the SQL actor's authenticated identity,
are the database guarantee. Operators disabling guards are outside that boundary.

A01a adds schema capabilities only; A01b adds the domain outcome reads below.
Neither exposes an approval/rejection API or establishes workflow/UI/realtime
acceptance. Later units require authorization and compatible outcome DTOs; final
visual/workflow acceptance remains human manual smoke, not browser automation.

Focused schema coverage is `TestA01LifecycleSchema`, using a newly admitted owned
empty database per case, real PostgreSQL wait-event handshakes, strict rollback
stock snapshots and clean numeric-overflow coverage failures.

## A01b persisted outcomes and temporary HTTP fence

`Get` and identical original creation replay return the persisted `pending`,
`approved` or `rejected` status, never a Pending disguise. Status remains a string
with exactly those three admitted values. `DecisionLocationID` and `DecidedAt`
are nullable pointers: both absent for Pending, both present for terminal rows,
with the persisted approver location and a timestamp not earlier than creation.
Inconsistent metadata or an unrecognized status returns `ErrUnavailable`.
Fingerprint, completeness and participant checks remain in force.

Terminal reads/replays preserve the original ID, reference, creation time,
direction and every item. Replay lookup still precedes fresh stock checks and
writes no header, reference, item, allocation or balance, even when present
availability is insufficient. Changed carts still return `ErrRetryConflict`;
foreign/missing detail still returns `ErrNotFound`. List records and counts remain
Pending-only. Outcome reads add no allocation DTO/query or decision mutation.

Until A04 admits outcome DTOs, the HTTP adapter fences successful terminal Get
and creation replay **before** Location or serialization, returning only the
existing sanitized 503 `service_unavailable`. Pending HTTP behavior is unchanged.
This is a temporary compatibility boundary, not outcome/UI readiness; clients
must not substitute a fresh retry key to work around the fence.

`TestA01bOutcomeStore` covers both outcomes across all three flows, persisted
metadata and exact immutable payloads, participant privacy, reordered replay
under exhausted availability, mixed Pending-only lists and complete unchanged
header/item/allocation/balance snapshots. Fixtures use real guarded transitions
in a committed READ COMMITTED transaction with reservation advisory lock first.

## A02 atomic whole-request approval

`Store.Approve(ctx, identity, requestID)` returns the complete persisted `Request`
after commit, not an approval key, replay flag or allocation DTO. Supply the
server-authenticated identity. Account/assigned location must match; warehouse
approval is legal even though warehouse creation remains forbidden. Participant
membership is checked before the persisted approver, and authorization precedes
terminal handling. Foreign/missing/nonpositive IDs return `ErrNotFound`;
malformed identities and visible non-approvers return `ErrForbidden`. Authorized
Rejected approval returns `ErrDecisionConflict`, distinct from creation's
`ErrRetryConflict`. Nil context/store/pool returns `ErrUnavailable`; SQL/config
errors stay private and cancellation/deadline errors retain Go semantics.

Approval uses READ COMMITTED, a 10-second deadline and bounded background rollback.
The reservation-integrity advisory lock is acquired first, then the participant
header is locked. Authorized Approved retries reload the original complete
outcome without any stock query, availability recheck or writes. Lost replies
can be recovered through participant `Get` or the same authorized approval.

For Pending, all immutable variants at the persisted physical origin are locked
in ascending order. Result rows close before writes. Every item is validated
first; a missing balance or any shortage returns `ErrInsufficientStock` without
partial effects. Per-item quantity <= available proves reserved + quantity <=
existing <= MaxInt64; quantities across variants are never summed. Each exact
reserved increment and allocation insert must affect one row. Guards derive
allocation origin and decision actor/time; the header update changes only status.
Canonical reload and successful commit precede returning the result. Any failure
returns a zero request and rolls back the whole transaction. Physical stock,
destination/unrelated balances and pre-existing independent holds are preserved.

`TestA02ApprovalDependencies`, `TestA02ApprovalStore` and
`TestA02ApprovalConcurrency` cover refusals/full snapshots, all three flows,
exhausted-stock retries, rejected conflicts, first/later/missing-item shortages,
independent int64 boundaries and an observed midwrite rollback. Connection-local
pgx tracer/channel stages and actual PostgreSQL lock waits exercise competing
and same-request approvals, both approval/rejection orders, guarded stock/hold
changes and both creation/approval orders. Creation can finish while approval
waits on its balance locks; waiting creation revalidates committed availability.
No production hooks or timing sleeps are used. Arbitrary SQL prelocking may
still deadlock/abort. Existing Pending-only HTTP fences remain unchanged; human
manual workflow/UI/realtime smoke and later integration units remain pending.

## A03 atomic whole-request rejection

`Store.Reject(ctx, identity, requestID)` returns the complete persisted `Request`
only after commit. Supply the actual authenticated identity, not a consulted
inventory location. Dependency, identity and ID guards match approval in that
order. Warehouse rejection is legal without enabling warehouse creation.
Participant-scoped header lookup precedes persisted approver authorization;
authorization precedes terminal handling. Visible non-approvers are forbidden
for Pending, Rejected and Approved alike; outsiders/missing IDs are not-found.
Authorized Approved rejection returns the existing `ErrDecisionConflict`.

Rejection uses READ COMMITTED, a 10-second operation deadline and a 5-second
background rollback bound. The integrity advisory lock is acquired **before**
the participant header row lock, sharing approval's ordering. Pending rejection
changes only status, verifies one affected row, canonically reloads and commits;
database guards derive decision location/time. Every failure returns a zero
request, preserving cancellation/deadline semantics and sanitizing SQL errors.

Authorized Rejected retry commits without writes and returns the identical
payload, reference and persisted outcome/time. Lost replies can be recovered
through participant `Get`, same-action retry or reordered original creation
replay. Neither Pending rejection nor Rejected retry issues application inventory
queries or balance/allocation writes, even with exhausted availability or a
missing balance. Deferred database guards remain enabled and may inspect stock
integrity internally: this is not a promise of zero database stock inspection.
No independent holds or request-owned reservations are released; rejection
cannot replace an Approved outcome. There is no reason field or new retry key.

`TestA03RejectionDependencies`, `TestA03RejectionStore` and
`TestA03RejectionConcurrency` cover all flows, complete balance/allocation
snapshots (including missing rows), immutable two-item outcomes, privacy and
stock-query tracing. Fixture-only strengthening triggers prove update rollback
and deferred commit failure after successful canonical reload. Actual concurrent
Reject calls return one outcome; actual Approve/Reject races cover both winning
orders with exact reservations or none. PID/channel and PostgreSQL wait-event
handshakes cover cancellation/deadline at advisory and header locks without
sleeps or production hooks. Existing Pending-only HTTP 503 compatibility remains
unchanged. Public decisions, outcome DTOs, UI/realtime integration and human
workflow smoke remain pending; source checks do not establish deployment.

## Focused verification

Use the existing parent-owned admitted fixture. `LUSON_TEST_PG_MANIFEST` is the
only nonsecret test connection pointer: an absolute manifest path, never a DSN.
See the repository README for strict file/resource admission. Do not create or
alter Docker resources, private configuration or operator accounts to run tests.
From `apps/api`, with that pointer already set for PostgreSQL checks:

```sh
go test ./internal/transfers -run '^TestR01PendingContract$' -count=1
go test ./internal/transfers -run '^TestR01PendingStore$' -count=1
```

Tests use empty admitted per-test databases, initialize the local-trial catalog
and provision generated test-only accounts. They compare all 570 sorted balance
rows before/after creation, failures, retries and concurrency. Deliberate test-only
stock mutations have separate expected snapshots. Lock tests use a database
wait-event handshake, not timing guesses. Injected rollback triggers exist only
in owned test databases. Final read-only fixture diagnostics wait for concurrent
packages to settle; the helper rechecks resource identity and drops only its own
generated databases. Parent lifecycle and independent verification remain separate.

## R02a participant snapshot list

`Store.List(ctx, identity, Query)` extends the original creation-only unit above
with domain/store pagination. HTTP routes, DTOs, UI and realtime remain absent.
Identity must still come from authentication, never from a consulted inventory
location. Warehouse may read its physical-participant requests despite being
forbidden to create them.

| Query field | Default when omitted/zero | Accepted values |
| --- | --- | --- |
| `Page` (`int64`) | 1 | 1–1,000,000 |
| `PageSize` (`int`) | 25 | 10, 25, 50 |
| `Status` (`string`) | `pending` | Exactly `pending` |

Negative values, arbitrary page sizes, future statuses and invalid/unassigned
identities are rejected. No actor override, date, role or counterparty filter is
supported. Nil context, receiver or pool returns sanitized `ErrUnavailable` and
an exact zero page before any SQL; cancellation/deadline semantics are preserved.

`Page` contains complete canonical `Records`, participant-private `Total int64`,
normalized `Page` and `PageSize`. Empty databases, uninvolved accounts and pages
beyond the last row return a nonnil empty records slice. An out-of-range page
retains only that actor's scoped total, not a global count or a 404-style response.
Totals count requests, never summed battery quantities; future HTTP DTOs must
encode totals, IDs and quantities losslessly.

Both COUNT and descending-ID pagination apply physical-origin/destination
membership before status/pagination. COUNT, IDs and existing canonical record
loading share one read-only REPEATABLE READ transaction, with a 10-second deadline
and bounded rollback. No balance mutation, reservation or row/advisory lock is
added. Per-record loading is intentionally bounded to at most 50 requests, each
already bounded to 190 items. Snapshots are internally consistent; separate page
calls can naturally observe newer commits and do not promise a frozen browsing
session or expose a private revision/cursor.

Focused checks are `TestR02ListDependencies` (pure) and `TestR02ListPostgres`
(admitted fixture required). A test-only pgx tracer pauses after COUNT while a
separate connection commits a writer, proving IDs and loaded records stay in the
original snapshot. This adds no production hook or fixture-schema substitution.
