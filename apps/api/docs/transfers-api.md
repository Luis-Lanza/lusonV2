# Create and read private Pending transfers

Authenticated branches can create immutable Pending requests. Only physical
origin and destination can read them; warehouse can read participating records
but cannot create. Pending does **not** reserve or change stock. This HTTP unit
adds no approval, rejection, cancellation, dispatch, receipt, UI or realtime
behavior.

## Quick path

1. Establish a session through the existing same-origin authentication API.
2. Read its CSRF token from `GET /api/auth/session`.
3. POST one complete cart with that session cookie, Origin and CSRF header.
4. Read the returned record or the participant-scoped Pending list.

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
| `/api/transfers` | GET | Participant-scoped Pending page |
| `/api/transfers` | POST | 201 new Pending; 200 identical Pending replay; terminal replay fenced 503 |
| `/api/transfers/{id}` | GET | Participant Pending record; terminal fenced 503; missing/inaccessible both 404 |

Unsupported methods return 405 with exact `Allow: GET, POST` for the collection
and `Allow: GET` for numeric detail routes. HEAD is not implicitly enabled.
Text-only detail segments (including operation names), trailing-slash paths and
extra operation segments such as `/api/transfers/1/approve` are unknown 404
routes, not lifecycle capabilities. Digit-containing malformed detail segments
(e.g. `0`, `01`, `-1`, `1.0`, overflowing int64) return 400 after authentication.
Detail IDs must be canonical positive int64 decimal strings. Encoded path aliases
are rejected 400; unsafe dot/double-slash paths are rejected 404 without redirects.
The existing outer static dispatcher retains its own unsafe-path guards. API
paths never fall back to the public index.

Every defined request authenticates through the real `Current` session lookup,
not caller identity fields or a consulted inventory location. Duplicate session
cookies return 400; absent, malformed, expired or revoked sessions return 401.
Current retains its existing idle-touch behavior; no streaming session policy
is introduced. Responses retain `Cache-Control: no-store` and
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

## Temporary terminal-outcome fence (A01b, until A04)

The domain now loads persisted Approved/Rejected decisions and returns them on
identical original creation replay, preserving immutable payload and decision
metadata even if current stock is insufficient. HTTP outcome DTOs are not yet
admitted. After a successful store Get/replay, the adapter checks status before
setting Location or serializing any record. Non-Pending results return exactly
`{"error":"service_unavailable"}` with status 503, no Location or cookies, and
no request, status, decision, items or retry material. Existing no-store/nosniff
headers remain. The outcome is not disguised as Pending.

The DTO whitelist below is unchanged; decision metadata is domain-only. Lists
and counts remain Pending-only. Inaccessible detail stays 404, changed-cart
replay stays 409, and authentication, Origin/CSRF and strict framing keep their
existing precedence. Pending creation/replay/detail retain 201/200, their
original DTOs and creation/replay Location. This fence is not workflow/UI or
realtime readiness. Do not switch retry keys to bypass it.

`TestA01bPendingFence` exercises both outcomes and all three flows through real
sessions and guarded terminal fixtures, exact sanitized errors, participant
privacy, Pending whitelists/list/counts, security boundaries and complete
header/item/allocation/balance snapshots around reads, replays and errors.

## Bounded list and lossless responses

GET accepts only `page`, `page_size` and `status`, each at most once:

| Parameter | Default | Accepted values |
|---|---|---|
| `page` | 1 | Canonical ASCII decimal 1–1000000 |
| `page_size` | 25 | Exact 10, 25, 50 |
| `status` | pending | Exact `pending` |

Raw queries are bounded to 4096 bytes. Empty values/components, unknown fields,
duplicates, encoding aliases and malformed encoding are rejected 400. Parameter
order is irrelevant; no URL escaping is needed for the admitted ASCII values.
An absent query, or empty collection query, uses defaults. Counts, ordered IDs
and complete records share the store's read-only repeatable-read transaction.
IDs descend. Far pages preserve the private total and return `records: []`.
Separate requests can see newer commits; this is not a frozen pagination cursor.

Only explicit snake_case DTOs are serialized:

- Record: `id`, `reference`, `kind`, `status`, `created_at`, `items`, plus
  `creator_location_id/name`, `origin_location_id/name`,
  `destination_location_id/name`, `approver_location_id/name` (each pair means
  two flat fields, e.g. `origin_location_id` and `origin_location_name`).
- Item: `variant_id`, `brand`, `model`, `capacity_ah`, `polarity`, `quantity`.
- Page: `page`, `page_size`, `status`, `total_count`, `records`.

Request IDs, quantities, decimal capacities and total_count are JSON **strings**,
never floating-point conversions. Bounded location/variant/page values are JSON
integer numbers. Timestamps are canonical UTC RFC3339 with only necessary
fractional precision. Exact catalog model, Ah and L/R data are preserved. Retry
keys, hashes, creation XIDs, account usernames and authentication metadata are
never transfer-response fields. Pending creation/replay returns the same public
record and `Location: /api/transfers/{id}`; Pending reads use the same record DTO.

## Sanitized errors and verification

| Status | JSON error |
|---|---|
| 400 | `invalid_request` |
| 401 | `unauthenticated` |
| 403 | `forbidden` |
| 404 | `not_found` (numeric detail; inaccessible equals missing) |
| 405 | `method_not_allowed` |
| 409 | `insufficient_stock` or `retry_conflict` |
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

See [the immutable store contract](pending-requests-store.md) for persistence,
replay ordering, Pending stock policy and snapshot rationale.
