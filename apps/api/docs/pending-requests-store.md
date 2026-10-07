# Immutable Pending requests without stock holds

`internal/transfers` creates durable, participant-private Pending requests in one
PostgreSQL transaction. It does not reserve, dispatch, receive or change stock.
There are no HTTP routes, UI screens, list pagination or realtime transport in
this store unit; those require separate integration and authorization checks.

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
checks enforce legal branch direction, Pending-only status, positive IDs/items,
retry/fingerprint bounds, foreign keys and uniqueness. Deferred completeness
requires 1–190 items. An internal `creation_xid` permits item insertion only within
the header's creation transaction; later appends, updates, deletes and truncation
are refused. Future lifecycle changes need an explicit migration, not an update
path hidden in this store. Database owner access remains administrative authority,
not a security boundary against an operator disabling protections.

Public references use a global positive BIGINT `NO CYCLE` sequence: `TR-001`,
`TR-999`, `TR-1000` and beyond. Rollback may consume sequence values; numbering is
not gapless and retries never allocate another reference. Records join the sealed
catalog's exact brand/model, canonical decimal Ah and explicit L/R polarity.
Neither retry material nor account usernames appear in records. Future HTTP DTOs
must serialize quantities and numeric identifiers losslessly, rather than
assuming JavaScript number precision.

Errors are stable `ErrForbidden`, `ErrInvalid`, `ErrNotFound`,
`ErrInsufficientStock`, `ErrRetryConflict` and sanitized `ErrUnavailable` values.
Cancellation/deadline errors retain their standard Go semantics. Driver/config,
private credentials and raw SQL errors are not returned.

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
