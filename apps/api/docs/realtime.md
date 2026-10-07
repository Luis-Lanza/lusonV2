# Private invalidation foundations and guarded HTTP streaming

Migration004, `realtime.Broker` and `auth.Service.Peek` provide the R03a commit-only
invalidation and non-renewing authorization primitives. R03b adds opt-in HTTP
streaming, passive GET selection and server lifetime wiring, described below.
Go SPA/API and PostgreSQL remain the only deployed services. These source and
httptest/owned-PG checks do not claim deployment, browser synchronization,
frontend adapters or completed transfer UI.

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
**before** closing the application pool or dropping a test database. R03b server
integration owns this ordering without changing ordinary transport settings.

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
logout racing a later operation. R03b passive HTTP GETs and SSE use Peek and
apply bounded stream expiry enforcement as described below.

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

## R03b opt-in HTTP and passive reads

`httpapi.NewWithRealtime(service, cfg, inventoryStore, transferStore, broker)`
returns `(http.Handler, error)`. It reuses the checked transfer constructor's
required dependencies/configuration validation and rejects nil broker. An
opaque unready/zero broker never grants readiness: Subscribe fails 503.
Legacy `New` and `NewWithTransfers` still leave `/api/events` absent 404.
No store, migration or authentication-service behavior is changed by this unit.

Only GET recognizes optional `X-Luson-Passive: 1`. Absence selects ordinary
Current; exactly one value 1 selects Peek; empty, duplicate, comma-list or any
other value returns 400 even for anonymous restoration. This applies to session
restoration, inventory/metadata and transfer list/detail via the shared identity
helper. Passive restoration preserves anonymous/prelogin cookie and CSRF
semantics; authenticated expires_at retains its absolute meaning. POST creation,
login and logout ignore this selector and retain Current/Origin/CSRF policy.
A passive header never supplies actor authority or bypasses mutation guards.

## R03b event transport

GET exact `/api/events` requires a unique live session cookie and always uses
Peek, irrespective of the optional selector (malformed selector is rejected 400).
Origin may be absent; if present it must be exactly one configured same-origin
value. FetchSite may be absent; otherwise exactly one same-origin value is
required. No CORS or forwarded trust is introduced. No query is admitted,
including an empty query marker. Encoded aliases are 400 and unsafe dot,
double-slash/trailing paths are 404 before ServeMux cleaning. Other methods return
405 with exact `Allow: GET`, without implicit HEAD. Existing static/transfer
path guards retain their own behavior.

Only the authenticated assigned location may Subscribe, not a queried inventory
location. Initial absent/expired/revoked sessions return 401, ambiguous cookies
400, backend/readiness/capability failure 503. After 200, authorization or transport
failure ends the stream: no impossible late JSON 401/503 is appended. Reconnect
must reauthenticate; a later passive restoration can clear dead session state.
Last-Event-ID is ignored (single value bounded to 128 bytes), never a replay
cursor or authority. New subscription resync precedes the client's future fresh
snapshot fetch; actual frontend integration belongs to R03c.

Responses are `text/event-stream`, `Cache-Control: no-store, no-transform`, and
nosniff. Frames have only `event: resync|inventory|transfers` and `data: {}`;
heartbeats are generic comments. No IDs, revisions, other audiences, counts,
records, credentials or session deadlines are emitted. There is no manual
Connection/Transfer-Encoding header or additional service. Broker closure,
overflow and request cancellation unsubscribe and end the stream for refetch.

Capability preflight walks at most 32 Unwrap layers for flush/write-deadline
support without prematurely flushing. Unsupported transport fails closed before
event bytes. ResponseController clears inherited write deadline while waiting,
sets a 750 ms deadline before every write/flush, and clears it after successful
flush. An empty preparation flush probes transport under a deadline before any
kind/data; runtime errors stop rather than claim a status that cannot be changed.

Peek is bounded to 750 ms before every event, heartbeat and preparation flush.
The next check is at most 1 s away, or earlier at effective idle/absolute expiry.
A scheduled check/query/write therefore has a nominal worst-case 2.5 s budget,
within the required 5 s detection bound (subject to process scheduling). Database
query stalls and slow writes cannot retain an indefinitely live claim. This
is bounded validation, not atomic SELECT-to-socket authorization against a
concurrent logout. Ordinary server WriteTimeout remains 15 s; only the event route
clears/rebounds its deadline. Explicit ordinary GETs continue sliding idle TTL.

## R03b server ownership and verification

Main initializes the broker before handler/listener serving. Start receives the
root lifetime context, never the short startup context. A separate 10 s startup
wait cancels and joins on failure. Cancellation/shutdown happens before pool
close and before final HTTP shutdown waits; startup results are joined and
shutdown errors are sanitized. Ordinary TLS/static/Read/Idle/WriteTimeout and
listener configuration remain unchanged. No operator server is launched by tests.

`TestR03RealtimeConstructor`, `TestR03Events` and `TestR03PassiveReads` cover
compatibility, strict passive selection, complete session timestamps, actual
HTTP→committed-PG→SSE privacy/replay/rollback, transport failure/slow writer,
revocation/expiry/query stalls, guarded listener recovery and joined shutdown.
One named real-network test deliberately runs beyond 16 s with global 15 s write
timeout. It is a duration smoke, not an arbitrary sleep-based queue/race proof.
All Pending checks compare 570-row stock snapshots. Parent independent review
and fixture audit remain separate; no browser, live UI or deployment is claimed.
