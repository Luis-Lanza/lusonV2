# Administrator account and branch API

The sole protected warehouse account (account 1, assigned to warehouse 1) manages personal branch operators through `/api/admin/...`. There is no public registration, second administrator, warehouse creation, granular role, invitation or email workflow. Personal-account retirement is available over HTTP; branch retirement and deletion UI remain pending.

## Routes

All responses are JSON except empty **204** responses. Lists are ordered by numeric ID. Account IDs are canonical positive decimal **strings**; location IDs are positive smallint JSON **integers** (1–32767). These are independently allocated identities: equal numbers do not establish assignment or privilege.

| Method and route | Request | Success |
| --- | --- | --- |
| `GET /api/admin/accounts` | No query | 200 account array |
| `GET /api/admin/branches` | No query | 200 location array, including warehouse for directory context |
| `POST /api/admin/accounts` | Exactly `username`, `display_name`, `location_id`, `temporary_password` | 201 account |
| `PATCH /api/admin/accounts/{id}` | One or more of `display_name`, `location_id`, `enabled` | 204 |
| `DELETE /api/admin/accounts/{id}` | No payload required | 204 |
| `POST /api/admin/accounts/{id}/password` | Exactly `temporary_password` | 204 |
| `POST /api/admin/branches` | Exactly `name` | 201 location |

Account representation:

```json
{"id":"4","username":"personal.operator","display_name":"Operador personal","location_id":2,"enabled":true,"must_change_password":true}
```

Location representation: `{"id":4,"name":"Sucursal Nueva"}`. No fabricated last-login/activity metadata is returned. No password, hash, token or supplied secret is returned by administration routes.

## Guards and validation

- A unique `luson_session` cookie must identify a live, enabled, completed-password administrator session in the database. Neither username nor a client role/location assertion grants authority. Ordinary operators receive 403 `forbidden`; mandatory-change sessions receive 403 `password_change_required` before body decoding.
- Every operation revalidates session expiry, revocation, account enabled state, assigned warehouse and authority version inside its transaction. Administration uses passive validation and does not renew idle authority or set/clear cookies, including on rejection.
- Mutations require the existing exact same-origin, Fetch-Site and CSRF guards. GET accepts only absent or matching Origin/Fetch-Site headers and the existing optional `X-Luson-Passive: 1` selector.
- No query parameters are accepted. DELETE does not decode a body or require a media type. Other mutations require `Content-Type: application/json`, a flat object of at most 4096 UTF-8 bytes, and exact field names. Unknown/duplicate fields, nulls, nested values, trailing input, invalid types and malformed numbers are rejected. Client `role`, `kind`, IDs, hash, authority-version and password-state overrides are not accepted.
- Usernames reuse the existing 3–64 ASCII letters/digits/underscore/dot/hyphen policy. Passwords reuse the existing 12–128 UTF-8 **byte** policy without NUL; bytes, including spaces, are preserved. Names must be nonblank UTF-8, at most 128 bytes, without NUL; supplied valid names are preserved.
- Operators must be assigned to an existing branch (2–32767), never warehouse 1. Usernames and account IDs cannot be edited. Account 1 permits display-name edits only: its enabled state, assignment and password cannot be managed through this API. Its own-password route remains available.
- Branch creation accepts only a name, never a warehouse kind or role. The reserved warehouse name is rejected. Duplicate usernames/branch names return conflict without consuming an allocation.

## Temporary password and lifecycle

Supply the temporary password privately over the authenticated same-origin request. Deliver it to the operator through a private channel; it is not retrievable later. Do not put secrets into URLs, logs, screenshots or example files. New accounts are enabled with `must_change_password=true`; restricted sessions can only inspect their session, change their own password and logout.

Reset replaces the hash without reading or revealing the previous password, forces a new password change, increments authority version, and revokes all previous sessions atomically. Reset leaves a disabled account disabled; reactivation is an explicit separate PATCH.

Reassignment and enabled-state transitions increment authority version and retire prior sessions. Reactivation cannot revive old sessions. Profile-only edits and no-op assignment/enabled edits do not retire authority. Transactions lock accounts in ID order before sessions, matching login/password lifecycle ordering and preserving concurrent changes. Password hashing uses the existing bounded admission channel.

New branch creation calls the existing `create_branch(text)` database function unchanged. Its initialization lock and triggers atomically allocate the branch, add zero balances for every existing catalog variant, establish the realtime audience and publish inventory invalidation. Existing locations, stock, transfer rules and historical attribution remain unchanged. Operators assigned to the new branch use the existing inventory, transfer and realtime interfaces.

## Personal-account retirement

DELETE is admin-only and uses the same Origin/CSRF guards, without setting or clearing cookies. Account 1 returns 403 `forbidden`; unknown accounts return 404 `not_found`. Retirement atomically disables the account, sets its retained deletion timestamp, increments authority version once and revokes all its sessions. Repeating DELETE on an existing retired account returns empty 204 without another update or revocation.

The account directory omits retired accounts without changing its DTO. Temporarily disabled accounts remain visible and reactivatable. Retired accounts cannot log in; existing current/passive/realtime authority checks reject their sessions. PATCH and password reset on retired targets return 404 before mutation (reset also before hashing). Records, usernames, IDs and historical attribution remain retained; no restore, recycling or physical deletion endpoint exists. Unsupported methods on an account resource return 405 with `Allow: PATCH, DELETE`.

## Errors and remaining work

Failures are `{"error":"code"}` with no secret or database detail: 400 `invalid_request` (including duplicate authority cookies), 401 `unauthenticated`, 403 `forbidden` / `password_change_required`, 404 `not_found`, 405 `method_not_allowed` (with Allow), 409 `conflict`, 429 `rate_limited` (Retry-After 60), or 503 `service_unavailable`. Rejected mutations leave account, branch, stock and counter state unchanged.

The administration screens and private server recovery command are separate pending work. HTTP has no protected-account reset override or public recovery endpoint. See [authentication](authentication.md) for own-password changes and [dynamic branches](dynamic-branches.md) for operational scope.
