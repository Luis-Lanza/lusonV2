# Create transfers and read private outcomes

Authenticated branches can create immutable Pending requests. Only physical
origin and destination can read them; warehouse can read participating records
but cannot create. Pending does **not** reserve or change stock. This read API
also exposes persisted Approved/Rejected/In-transit outcomes and guarded
whole-request approval, rejection and origin-only dispatch. Cancellation, receipt
and frontend dispatch integration remain outside D1.

## Quick path

1. Establish a session through the existing same-origin authentication API.
2. Read its CSRF token from `GET /api/auth/session`.
3. POST one complete cart with that session cookie, Origin and CSRF header.
4. Read the returned full record, a participant-scoped status page or counts.

The server explicitly composes `NewWithTransfers(service, cfg, inventoryStore,
transferStore)`. It returns `(http.Handler, error)`, rejects required nil pointers
and inconsistent authentication configuration, and expects initialized
services/stores. Configuration follows `config.ParseAuth`; HTTP is limited to
explicit loopback trial endpoints. Production configuration and TLS loading
remain enforced by server startup. Store/pool availability failures return 503.
Legacy `New(service, cfg, stores ...*inventory.Store)` keeps its signature and
never registers transfers: those routes remain 404 for legacy callers.

## Routes and authorization

| Route | Methods | Result |
|---|---|---|
| `/api/transfers` | GET | Participant-scoped page for the selected status |
| `/api/transfers` | POST | 201 new Pending; 200 identical original replay, including terminal outcomes |
| `/api/transfers/{id}` | GET | Full participant record; missing/inaccessible both 404 |
| `/api/transfers/counts` | GET | Private Pending total and assigned-approver action count |
| `/api/transfers/{id}/approve` | POST | Full persisted Approved outcome |
| `/api/transfers/{id}/reject` | POST | Full persisted Rejected outcome |
| `/api/transfers/{id}/dispatch` | POST | Origin-only full persisted In-transit outcome |

Unsupported methods return 405 with exact `Allow: GET, POST` for the collection
and `Allow: GET` for numeric detail and the exact static counts route. HEAD is
not implicitly enabled; `/api/transfers/counts/` is not an alias.
Text-only detail segments (including operation names), trailing-slash paths and
unknown operation segments are 404 routes. Approval, rejection and dispatch are exact
POST-only routes with `Allow: POST`; trailing/extra segments are not aliases. Digit-containing malformed detail segments
(e.g. `0`, `01`, `-1`, `1.0`, overflowing int64) return 400 after authentication.
Detail IDs must be canonical positive int64 decimal strings. Encoded path aliases
are rejected 400; unsafe dot/double-slash paths are rejected 404 without redirects.
The existing outer static dispatcher retains its own unsafe-path guards. API
paths never fall back to the public index.

Every defined request authenticates through the existing session identity lookup,
not caller identity fields or a consulted inventory location. Duplicate session
cookies return 400; absent, malformed, expired or revoked sessions return 401.
Existing collection/detail reads retain the explicit passive-header policy.
Counts is inherently passive: it reuses inventory identity validation with
non-touching session lookup even without `X-Luson-Passive: 1`. An explicit
selector must still be exactly one `1`; malformed/duplicate selectors are 400.
Counts never calls touching Current or writes cookies/session idle deadlines.
Responses retain `Cache-Control: no-store` and
`X-Content-Type-Options: nosniff`, with no permissive CORS.

## Strict creation body

```json
{
  "kind": "request_stock",
  "counterparty_location_id": 3,
  "retry_key": "opaque-client-key-0001",
  "items": [{ "variant_id": 1, "quantity": "2" }]
}
```

| Field | Contract |
|---|---|
| `kind` | Exact `request_stock` or `send_to_warehouse` |
| `counterparty_location_id` | Canonical integer JSON token 1–3; direction validated against actor |
| `retry_key` | Opaque ASCII `[A-Za-z0-9_-]{16,128}`, actor-scoped |
| `items` | 1–190 objects, one line per variant; duplicates rejected |
| `items[].variant_id` | Canonical positive integer JSON token through 2147483647; must exist |
| `items[].quantity` | Canonical positive decimal **string** through 9223372036854775807 |

All four root fields and both item fields are required. Input is at most 64 KiB,
valid UTF-8, exactly one JSON object, with optional surrounding whitespace.
Content-Type must be a single `application/json` header; only optional
`charset=utf-8` is accepted (charset case-insensitive), without duplicate
parameters or dangling separators. Unknown, duplicate,
escaped-equivalent duplicate, casefold, null and trailing fields/data are
rejected. Numeric strings are not ID tokens; numeric quantities, floats,
exponents, signs, padding, zero and overflow are rejected. POST and detail accept
no query parameters, including an explicit empty query marker.

POST reuses the existing mutation guard: exactly one matching Origin and one
session-derived `X-CSRF-Token`; FetchSite may be absent but, when supplied, must
be exactly one `same-origin` value. Prelogin authority cannot substitute for an
authenticated session. The server derives creator, physical direction and
approver. Requesting stock makes counterparty the origin/approver and creator
the destination. Sending to warehouse requires counterparty 1, makes creator
the origin and warehouse the destination/approver.

All selected physical-origin stock must suffice. Same actor/key/canonical cart
replays the original immutable record even if current availability changes;
reordered lines are equivalent. Changed payload with the same actor/key is 409.
Independent actors may reuse a key. References remain globally generated,
continue beyond 999 and may have rollback gaps. No client reference is accepted.

## Whole-request decisions

The persisted approver, not the consulted inventory location, may perform:

```http
POST /api/transfers/123/approve
Content-Type: application/json
Origin: <configured same origin>
X-CSRF-Token: <session-derived token>

{}
```

Rejection uses `/api/transfers/123/reject` with the same empty body. Warehouse
assignment is eligible when it is the persisted approver. There is no reason,
new retry key, item selection, actor override or allocation DTO in either input.
The decision covers every original immutable item; it is not partial approval.

Decision body framing is deliberately narrow:

- One required empty JSON object, with optional surrounding whitespace.
- One `application/json` Content-Type; optional UTF-8 charset only.
- No duplicate parameters, dangling separators or duplicate Content-Type headers.
- Valid UTF-8, at most 64 KiB including whitespace.
- Arrays, null, absent bodies, trailing objects/scalars and every key are invalid.
- Escaped keys and duplicate keys are invalid too; no field is admitted.

Admission order is outer path safety, exact POST method, authenticated identity,
unique optional same-origin FetchSite, Origin/CSRF mutation guard, no query,
canonical positive int64 ID and strict body, then the domain operation. An empty
query marker `?` is also forbidden. Invalid identity/guards take precedence over
malformed IDs or bodies. POST always calls touching Current, never passive Peek,
even when a passive-read header is supplied. No caller-provided actor is used.

First success and same-action retries return 200 with the complete validated
persisted transfer record. Original reference, creation time, items and quantities
are retained. Decision actor and UTC timestamp come from the persisted server
outcome, not the request. A decision response does not require Location.

Approval atomically rechecks all physical-origin availability and reserves all
items with one exact request-owned allocation set. It does not deduct physical
stock or increase destination availability. Rejection closes Pending without
changing inventory or allocations. Any failed transaction rolls back the whole
request; later-item shortage cannot leave earlier reservations behind.

An already-completed same-action request returns the current persisted outcome
without rechecking stock or emitting another change. After dispatch, authorized
approval retries return In-transit without reserving again; rejection is a
409 `decision_conflict`. Opposite action is 409
`decision_conflict`, distinct from original-creation `retry_conflict`. Shortage
is 409 `insufficient_stock`; missing/foreign is 404 `not_found`; a visible
participant who is not the approver gets 403 `forbidden`. Backend/context failures
are sanitized 503 `service_unavailable`, never driver text or partial metadata.

A lost decision response is recovered by an authorized GET of the same ID.
Do not invent a new creation key to recover a decision. Original creation replay
continues to return the original terminal payload and original Location; changed
cart with the same key remains a creation retry conflict.

Committed invalidations are hints to refetch authorized detail, selected-status
list and Pending/action counts. They are not decision payloads or delivery
receipts. D1 does not deliver a frontend dispatch workflow. D2 integration and separately
admitted human acceptance remain pending.

## Origin-only whole-request dispatch

```http
POST /api/transfers/123/dispatch
Content-Type: application/json
Origin: <configured same origin>
X-CSRF-Token: <session-derived token>

{}
```

Dispatch uses the same strict empty-object framing and authenticated mutation
admission order as decisions. No actor, item quantities, retry key or consulted
inventory location is accepted. Only the persisted physical origin may dispatch,
including a warehouse origin. For `send_to_warehouse`, the branch origin dispatches;
warehouse approval does not grant warehouse dispatch authority.

Approved → `in_transit` consumes every immutable request-owned allocation and
atomically deducts its quantity from both source `existing` and `reserved`.
Unreserved availability is unchanged; other allocations and independent holds
survive. Destination balances receive no credit. Items, participants, creation
identity and approval actor/time remain unchanged. Allocation history stays
internal, marked consumed rather than deleted.

First success and authorized retries return 200 with the complete current
persisted record. Dispatch adds `dispatch_location_id`, an integer matching the
origin, and `dispatched_at`, a server-derived canonical UTC RFC3339Nano timestamp
not earlier than `decided_at`. Both fields are omitted before dispatch, never null.
Decision fields remain present. IDs and quantities keep their decimal-string
encoding. No new response retry key, allocation DTO or Location requirement is
introduced.

Pending/Rejected dispatch is 409 `decision_conflict`. A visible destination actor
gets 403 `forbidden`; missing/foreign records are indistinguishable 404
`not_found`. Standard framing, authentication, method and backend errors retain
their existing mappings. A retry never deducts stock twice. Authorized approval
retry after dispatch returns the current In-transit record without reserving;
rejection after dispatch returns 409, not unavailable.

Recover an uncertain result through participant `GET /api/transfers/{id}`.
Identical original creation replay and `status=in_transit` participant pages also
return the complete persisted outcome. Do not invent a new creation key. Clients
must explicitly handle uncertainty rather than silently replay mutations.

Existing commit-only inventory and participant transfer invalidations are reused.
Rollback, recovery reads and mutation-free retries emit no new mutation hints.
Pending/action counters remain approval-only; dispatch does not add future action
counts. Receipt, cancellation and direct warehouse creation are excluded.

## Full persisted outcomes and original replay

Approved/Rejected records add exactly two fields: `decision_location_id`, a
bounded integer matching the persisted approver, and `decided_at`, the persisted
server decision time encoded as canonical UTC RFC3339Nano. Both keys are omitted
for Pending, never emitted as null. Original fields, immutable items, exact
numeric strings and creation timestamps retain their previous encodings.

List, detail and identical original creation replay use the same full DTO, not
summaries or asymmetric outcomes. Reordered original carts replay with 200 and
`Location: /api/transfers/{original-id}`, even after a decision or exhausted
availability. Detail returns 200 without a Location requirement; new creation
remains 201. Changed-cart replay remains 409; missing/foreign detail stays 404.
Authentication, framing, Origin/CSRF and FetchSite precedence is unchanged.

Reads/replays never alter decisions, balances or request-owned allocations.
Incomplete, inconsistent or unsupported internal outcome metadata yields
sanitized 503 before serialization or Location, not an invented outcome.
The former terminal-only 503 fences are removed, not domain integrity checks.

**Frontend boundary:** D2 must admit `in_transit` and both dispatch metadata
fields in lossless decoders, recovery and origin-only controls. This backend
contract is not a dispatch UI, deployed runtime or human acceptance.

## Bounded list and lossless responses

GET accepts only `page`, `page_size` and `status`, each at most once:

| Parameter | Default | Accepted values |
|---|---|---|
| `page` | 1 | Canonical ASCII decimal 1–1000000 |
| `page_size` | 25 | Exact 10, 25, 50 |
| `status` | pending | Exact `pending`, `approved`, `rejected`, `in_transit` |

Raw queries are bounded to 4096 bytes. Empty values/components, unknown fields,
duplicates, encoding aliases and malformed encoding are rejected 400. Parameter
order is irrelevant; no URL escaping is needed for the admitted ASCII values.
An absent query, or empty collection query, uses defaults. Counts, ordered IDs
and complete records share the store's read-only repeatable-read transaction.
IDs descend. Far pages preserve the private total and return `records: []`.
Separate requests can see newer commits; this is not a frozen pagination cursor.
Page `status` is the normalized selected status; `total_count` counts only that
status's physical-participant requests, independently of page size or offset.

Only explicit snake_case DTOs are serialized:

- Record: `id`, `reference`, `kind`, `status`, `created_at`, `items`, plus
  `creator_location_id/name`, `origin_location_id/name`,
  `destination_location_id/name`, `approver_location_id/name` (each pair means
  two flat fields, e.g. `origin_location_id` and `origin_location_name`).
- Decided record only: `decision_location_id`, `decided_at`.
- In-transit record additionally: `dispatch_location_id`, `dispatched_at`.
- Item: `variant_id`, `brand`, `model`, `capacity_ah`, `polarity`, `quantity`.
- Page: `page`, `page_size`, `status`, `total_count`, `records`.

Request IDs, quantities, decimal capacities and total_count are JSON **strings**,
never floating-point conversions. Bounded location/variant/page values are JSON
integer numbers. Timestamps are canonical UTC RFC3339 with only necessary
fractional precision. Exact catalog model, Ah and L/R data are preserved. Retry
keys, hashes, creation XIDs, account usernames and authentication metadata are
never transfer-response fields. Pending creation/replay returns the same public
record and `Location: /api/transfers/{id}`; all reads use the same full record DTO.

## Private Pending counts

`GET /api/transfers/counts` accepts no query, including an explicit empty `?`.
It shares strict path-alias, unique-cookie, identity and privacy guards with
existing reads. Its exact response has only decimal-string counts:

```json
{"pending_total":"3","action_count":"1"}
```

`pending_total` counts Pending requests whose physical origin or destination is
the authenticated assigned location. `action_count` counts the Pending subset
whose **persisted approver** is that location. One request contributes once,
regardless of item count/quantities or the two possible decision buttons.
Warehouse assignment is legal. These are not future dispatch/receipt actions.

The domain uses one participant-filtered aggregate in a read-only repeatable-read
transaction, with a 10-second operation budget and bounded 5-second background
rollback. It commits before returning; every failure returns zero domain totals.
Dependency and assigned-identity guards precede SQL. Counts does not load items,
paginate or mutate state. Both totals share one snapshot, but are **not atomic
with a separately fetched list**; later calls can observe newer commits.

## Sanitized errors and verification

| Status | JSON error |
|---|---|
| 400 | `invalid_request` |
| 401 | `unauthenticated` |
| 403 | `forbidden` |
| 404 | `not_found` (numeric detail; inaccessible equals missing) |
| 405 | `method_not_allowed` |
| 409 | `insufficient_stock`, `retry_conflict` or `decision_conflict` |
| 503 | `service_unavailable` (including cancellation/deadlines) |

Unknown routes retain ordinary 404 behavior. No backend/SQL/credential text is
returned. Defined errors use a single `error` field.

`TestR02TransfersConstructor` and `TestR02TransfersDecoder` cover pure boundaries.
`TestR02TransfersHTTP` uses actual admitted PostgreSQL and auth sessions for all
branch flows, warehouse refusal, privacy/counts, retries/concurrency, strict
guards, cancellation/unavailability, expiry/revocation, static dispatch, all nine
account/inventory consultations and full 570-row stock invariance. Large-value
fixtures deliberately alter their owned test stock/sequence before snapshots;
HTTP itself is checked against the resulting complete snapshot. These checks
are not a deployed runtime, browser/UI delivery or independent approval claim.

`TestA04Counts*` and `TestA04OutcomeList*` cover private aggregates, terminal
pages and deterministic snapshot interleaving. The retained
`TestA01bPendingFence` now covers full HTTP outcomes for both decisions/all flows,
original replay, Pending compatibility and exact state invariance. Its guarded
setup proves exact owned allocations/reservations before resetting test baseline.

`TestD01DispatchContract` covers the pure filter/metadata boundary;
`TestD01DispatchHTTP` and `TestD01DispatchEvents` cover the real guarded route,
origin/participant privacy, recovery, rollback and commit-only hints. The domain
and schema tests cover exact owned consumption, stock invariants, SQL bypass
rejection and concurrent dispatch/approval retries. These are source verification,
not manual smoke or independent review approval.

See [the immutable store contract](pending-requests-store.md) for persistence,
replay ordering, Pending stock policy and snapshot rationale.
