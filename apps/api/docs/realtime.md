# Backend foundations for private current-state invalidation

Migration004, `realtime.Broker` and `auth.Service.Peek` provide commit-only
invalidation and non-renewing authorization primitives. This unit does not
register HTTP/SSE routes, passive headers, server lifecycle wiring or frontend
handlers. Go SPA/API and PostgreSQL remain the only deployed services; these
checks do not claim deployed streaming, browser synchronization or completed UI.

## Interfaces and lifecycle

| Interface | Contract |
|---|---|
| `realtime.New(pool) (*Broker, error)` | Copies the existing pgx connection configuration; rejects nil pool |
| `Broker.Start(ctx) error` | Single-use; waits for committed LISTEN and a fresh validated revision snapshot |
| `Broker.Subscribe(location) (*Subscription, error)` | Caller supplies authenticated assigned location 1–3; refuses before-ready/lost/stopped/full broker |
| `Subscription.Events <-chan Event` | Only `resync`, `inventory`, `transfers`; no account IDs, versions, credentials or records |
| `Subscription.Close()` | Idempotent, safe against concurrent fanout/loss/shutdown |
| `Broker.Shutdown(ctx) error` | Closes subscriptions, cancels network/backoff work and joins within at most five seconds |
| `Service.Peek(ctx, token) (Session, time.Time, error)` | Live identity and unchanged absolute ExpiresAt, plus separate effective idle/absolute deadline |

Start with a cancelable application lifetime. The broker owns a dedicated pgx
connection, not a permanently occupied application-pool slot. One goroutine
alone connects, begins/commits LISTEN, reads revisions, waits for notifications
and closes the connection. Every successful new subscription starts with a
generic `resync`; its consumer must fetch complete authorized current snapshots.
Close subscriptions when consumers leave. Cancel/Shutdown and join the broker
**before** closing the application pool or dropping a test database. The future
server integration owns this ordering; current startup remains unchanged.

## Commit, readiness and recovery

The listener commits `LISTEN luson_realtime` **before** reading fresh revisions.
Notifications received during that query remain queued, so changes across the
startup boundary require neither a browser cursor nor a durable inbox. A
subscription created after a change still starts with resync and must read
current state. Redundant invalidations are harmless; identical transaction
metadata can coalesce. Separate snapshots may observe newer commits.

Listener/validation loss closes all current subscriptions before connection
cleanup. Reconnect uses cancelable exponential backoff 100 ms–2 s. Only a new
committed LISTEN and validated fresh snapshot restore readiness; new consumers
resync. Startup/connect/read queries have five-second attempt bounds, connection
close has a three-second bound, and canceled shutdown returns a context error
if its deadline prevents joining. Callers must not treat a failed join as success.
Unknown channels/payloads, malformed metadata, incomplete/negative revision sets
or decreasing internal versions fail closed rather than forwarding bytes or
keeping a false live claim. No raw configuration or driver errors are logged.

At most 128 subscriptions have queues of 8 events. Fanout never blocks. Overflow
closes only the affected subscription, forcing reconnect/refetch instead of
silently discarding an invalidation while claiming live status. Closed channels
can still yield previously buffered events before EOF; consumers must handle
closure and resynchronize, not interpret events as immutable record delivery.

## SQL scope, ordering and stock policy

`realtime_revisions` contains exactly four fixed internal scope keys:
`inventory`, `transfers:1`, `transfers:2`, `transfers:3`. BIGINT revisions start at 0
and only increase; ordinary DML cannot remove/rekey/reset them. They are internal
recovery evidence, never public activity counts, SSE IDs or durable replay tokens.
Revision exhaustion fails the transaction rather than wrapping. Initial seed
balance INSERTs intentionally update inventory evidence; tests listen only after
initialization. Initialize replay still preserves operational quantities.

The transfer AFTER INSERT statement trigger collects all physical participants
from its transition table. It locks the **entire selected revision-row set in
ascending C-collated key order before incrementing any row**. This also covers
multi-header INSERT statements and opposite branch directions; it never locks
origin first merely because origin appears first in a request. Arbitrary future
multi-statement mixed workflows must preserve a transaction-wide lock hierarchy
when they are introduced; this unit does not implement stock approval/movement.

Each participant counter increases for its committed headers. Transactional
NOTIFY metadata contains only `transfers:<audience>`; it has no request ID,
request bytes, key, hash or credential. The existing deferred completeness and
item failures roll back both counters and notifications. Replay performs no
header INSERT, so emits neither. Pending emits **transfers only** and neither
changes nor reserves any of the 570 balances.

Meaningful existing/reserved UPDATEs and balance INSERT/DELETE increase the
inventory scope and emit `inventory:0`. No-op UPDATEs are silent. Inventory
invalidations reach all three assigned accounts because all-location consultation
is authorized; transfer invalidations reach only the indicated participants.
Payload grammar is an exact whitelist, not permissive JSON. Broker events strip
internal audience metadata before delivery. Authorization belongs to the caller;
Subscribe is not an HTTP authentication boundary.

## Passive session authority and verification

Peek uses the same strict token hash lookup, account/location joins, clock and
live/revoked/idle/absolute predicates as Current, but a SELECT with **no UPDATE**.
Repeated probes/reconnect-equivalent validations cannot change last_seen, idle
or absolute authority. Session.ExpiresAt remains the absolute deadline; the
separate return value is `min(idle_deadline, absolute_deadline)`. Invalid/expired/
revoked tokens return ErrSession; unavailable dependencies/driver failures are
sanitized and cancellation/deadlines remain recognizable. Literal nil service,
context, pool and zero service are safe. Existing touching Current/login/logout
semantics remain unchanged. Peek does not promise atomic authorization against
logout racing a later operation. Future passive HTTP GETs and SSE must use Peek;
that adapter and ongoing stream expiry enforcement belong to R03b.

Focused tests are `TestR03PeekPostgres`, `TestR03BrokerContract` and
`TestR03BrokerPostgres`. Actual admitted private PostgreSQL tests prove committed
LISTEN readiness, queued startup races, participant exclusion, commit versus
rollback/deferred failure/replay, inventory/no-op policy, observed reversed lock
waits with a NOWAIT larger-key probe, reconnect/resync, overflow and joined
cancellation. Listener termination targets only a recorded backend in the test's
cryptographic own database through a guarded SQL predicate. Inventory mutation
cases are explicit test-only changes with separate expected snapshots; Pending
cases compare complete stock snapshots. Guarded helper cleanup and a read-only
settled catalog audit remain required; parent independent verification follows.
