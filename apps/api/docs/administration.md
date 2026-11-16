# Administrator account and branch API

The sole protected warehouse account (account 1, assigned to warehouse 1) manages personal branch operators through `/api/admin/...`. There is no public registration, second administrator, warehouse creation, granular role, invitation or email workflow. Personal-account and branch retirement are available over HTTP; operational metadata/inventory filtering is implemented; deletion controls are implemented in source and become available after a verified build and deployment, not in the unchanged preview.

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
| `POST /api/admin/branches` | Exactly `name`, `opening_cash`, `purchase_fund` | 201 location |
| `POST /api/admin/branches/{id}/funds` | Exactly `opening_cash`, `purchase_fund`; canonical ID 2–32767 | 204 |
| `GET /api/admin/branches/balances` | No query | 200 balance array |
| `DELETE /api/admin/branches/{id}` | No payload required; canonical ID 1–32767 | 204 |

Account representation:

```json
{"id":"4","username":"personal.operator","display_name":"Operador personal","location_id":2,"enabled":true,"must_change_password":true}
```

Location representation: `{"id":4,"name":"Sucursal Nueva"}`. No fabricated last-login/activity metadata is returned. No password, hash, token or supplied secret is returned by administration routes.

Balance representation, one row per live **branch** (the warehouse owns no drawer and no fund, so it is absent), ordered by branch ID:

```json
{"branch_id":2,"cash_balance":"5000.00","fund_balance":"3000.00","frozen":false}
```

`cash_balance` is the branch drawer's expectation — what it inherited from its last closed settlement, plus the cash its sales collected after that cut, plus the signed effect of every movement of its own book after the same cut — computed with the one rule of the settlement vertical (`closings.DrawerExpected`), so the panel, the branch's book, the metrics card and the acta can never publish two numbers for one drawer. It is signed text: a shortage is negative. `fund_balance` is the signed sum of `purchase_fund_ledger`, the one arithmetic of the purchase fund. `frozen` states that a live settlement is holding the branch: the numbers are the ones about to change, and the screen says so instead of presenting them as settled. Balances are a response of their own and not fields of the location representation, so the exact `{"id","name"}` shape of a directory row keeps closing for every reader that pins it.

## Guards and validation

- A unique `luson_session` cookie must identify a live, enabled, completed-password administrator session in the database. Neither username nor a client role/location assertion grants authority. Ordinary operators receive 403 `forbidden`; mandatory-change sessions receive 403 `password_change_required` before body decoding.
- Every operation revalidates session expiry, revocation, account enabled state, assigned warehouse and authority version inside its transaction. Administration uses passive validation and does not renew idle authority or set/clear cookies, including on rejection.
- Mutations require the existing exact same-origin, Fetch-Site and CSRF guards. GET accepts only absent or matching Origin/Fetch-Site headers and the existing optional `X-Luson-Passive: 1` selector.
- No query parameters are accepted. DELETE does not decode a body or require a media type. Other mutations require `Content-Type: application/json`, a flat object of at most 4096 UTF-8 bytes, and exact field names. Unknown/duplicate fields, nulls, nested values, trailing input, invalid types and malformed numbers are rejected. Client `role`, `kind`, IDs, hash, authority-version and password-state overrides are not accepted.
- Usernames reuse the existing 3–64 ASCII letters/digits/underscore/dot/hyphen policy. Passwords reuse the existing 12–128 UTF-8 **byte** policy without NUL; bytes, including spaces, are preserved. Names must be nonblank UTF-8, at most 128 bytes, without NUL; supplied valid names are preserved.
- Operators must be assigned to an existing branch (2–32767), never warehouse 1. Usernames and account IDs cannot be edited. Account 1 permits display-name edits only: its enabled state, assignment and password cannot be managed through this API. Its own-password route remains available.
- Branch creation accepts only a name, never a warehouse kind or role. The reserved warehouse name is rejected. Duplicate usernames/branch names return conflict without consuming an allocation. It also states its two mandatory amounts, `opening_cash` and `purchase_fund`, as canonical decimal strings: at most ten integral digits and exactly two decimals, never signed, padded or with a decimal comma. A missing or non-canonical amount is `invalid_request` and creates nothing; `0.00` is a stated answer, not a missing one.
- Loading the funds of a branch that already exists states the same two mandatory canonical amounts and nothing else. It is admitted for a live branch that is not the warehouse, and it writes the drawer's operating cash and the purchase fund as the two `aporte` rows of the two ledgers, signed by the administering account, in one transaction: `0.00` on both sides writes no movement and is not an error, and `0.00` on one side states only the other. The load is refused with 409 `branch_frozen` while a live settlement holds the branch — money stated into a till being counted would break the count — and it never freezes a branch itself. A branch account cannot load funds for itself or for another branch: administration is the warehouse's, so it answers 403 `forbidden`. The provenance of the two rows is the act itself (a transaction-local marker that each ledger honours only when the row was written from inside the act's own trigger), so a bare insert that sets the marker by hand is refused by the database.

## Temporary password and lifecycle

Supply the temporary password privately over the authenticated same-origin request. Deliver it to the operator through a private channel; it is not retrievable later. Do not put secrets into URLs, logs, screenshots or example files. New accounts are enabled with `must_change_password=true`; restricted sessions can only inspect their session, change their own password and logout.

Reset replaces the hash without reading or revealing the previous password, forces a new password change, increments authority version, and revokes all previous sessions atomically. Reset leaves a disabled account disabled; reactivation is an explicit separate PATCH.

Reassignment and enabled-state transitions increment authority version and retire prior sessions. Reactivation cannot revive old sessions. Profile-only edits and no-op assignment/enabled edits do not retire authority. Transactions lock accounts in ID order before sessions, matching login/password lifecycle ordering and preserving concurrent changes. Password hashing uses the existing bounded admission channel.

New branch creation calls `create_branch_funded(name, opening_cash, purchase_fund, creator_account_id)` inside the protected administrator service transaction. The function keeps the initialization lock, the zero balances of every existing catalog variant, the realtime audience and the inventory invalidation of the original seam, and adds the money: the drawer's opening cash as an `aporte` of the branch's cash ledger and the purchase fund as an `aporte` of `branch_fund_movements`, both signed by the administering account (1) and written in the same transaction. The branch and its two openings are born together or not at all, and a `0.00` amount writes no movement. The purchase fund's balance is the signed sum of `purchase_fund_ledger` and is computed nowhere else. Migration 049 dropped `create_branch(text)`, so no path creates a branch without stating its two amounts. Existing locations, stock, transfer rules and historical attribution remain unchanged. Operators assigned to the new branch use the existing inventory, transfer and realtime interfaces.

A branch that already exists receives the same two funds through `POST /api/admin/branches/{id}/funds`, which calls `load_branch_funds(branch, opening_cash, purchase_fund, actor_account_id)` (migration 054). The act has the shape of a view (`branch_fund_load`) whose trigger writes the two `aporte` rows: the actor must be the warehouse, the branch must exist, be live and not be the warehouse, the branch must not be frozen by a live settlement (the settlement's own `LC001` refusal reaches this surface as 409 `branch_frozen`), and `0.00` on both sides writes nothing. The two admissions of the ledgers — the drawer's and the fund's — were restated whole by that version to add this one path, with every code and message they already published unchanged. The load is append-only history like every other movement: a wrong load is answered by a correcting movement, never edited.

## Personal-account retirement

DELETE is admin-only and uses the same Origin/CSRF guards, without setting or clearing cookies. Account 1 returns 403 `forbidden`; unknown accounts return 404 `not_found`. Retirement atomically disables the account, sets its retained deletion timestamp, increments authority version once and revokes all its sessions. Repeating DELETE on an existing retired account returns empty 204 without another update or revocation.

The account directory omits retired accounts without changing its DTO. Temporarily disabled accounts remain visible and reactivatable. Retired accounts cannot log in; existing current/passive/realtime authority checks reject their sessions. PATCH and password reset on retired targets return 404 before mutation (reset also before hashing). Records, usernames, IDs and historical attribution remain retained; no restore, recycling or physical deletion endpoint exists. Unsupported methods on an account resource return 405 with `Allow: PATCH, DELETE`.

## Branch retirement

DELETE uses the same admin-only, cookie-neutral Origin/CSRF guards. Warehouse 1 returns 403 `forbidden`; unknown IDs return 404 `not_found`; invalid/out-of-smallint IDs return 400 `invalid_request`. Unsupported resource methods return 405 with `Allow: DELETE`. Success and repeated retirement return empty 204. The normal admin branch directory omits retired branches without changing its DTO; warehouse context remains.

Blockers return 409, in precedence: `branch_has_stock` (any nonzero existing/reserved balance), `branch_has_users` (nondeleted assigned users, including disabled users), `branch_has_pending_operations` (unresolved work at either endpoint, including latest undecided received-operation proposals). Resolve blockers before retrying. Retirement retains IDs, names, balances, audiences and historical actor evidence; no purge, restore or reuse is available. Operational metadata omits retired branches. Direct inventory for a retired branch returns 404 `not_found`; missing/unknown locations and invalid queries retain 400 `invalid_request`. Fresh transfer creation and received count/restitution/reconciliation work involving a retired endpoint return 409 `decision_conflict`. Stored exact retries remain eligible for replay; historical reads retain names and evidence. Administration source offers “Eliminar usuario” separately from temporary “Acceso” changes and “Eliminar sucursal” on unprotected branches. Both require “Confirmar eliminación”; “Cancelar” sends no DELETE. Blocker messages retain the target and explain stock/reservations, assigned users (including disabled users), or pending operations.

## Errors and remaining work

Failures are `{"error":"code"}` with no secret or database detail: 400 `invalid_request` (including duplicate authority cookies), 401 `unauthenticated`, 403 `forbidden` / `password_change_required`, 404 `not_found`, 405 `method_not_allowed` (with Allow), 409 `conflict` / `branch_has_stock` / `branch_has_users` / `branch_has_pending_operations` / `branch_frozen`, 429 `rate_limited` (Retry-After 60), or 503 `service_unavailable`. Rejected mutations leave account, branch, stock, counter and ledger state unchanged.

Accepted empty 204 responses trigger directory refetch; branch retirement also refreshes operational metadata and reconciles a retired inventory selection. Pending mutations are not duplicated or automatically retried; uncertain outcomes require consulting the directory before another submission. Private handoffs are cleared when managing/deleting a target, and stale-owner outcomes are ignored. Functional checks and actual-browser D6 proof remain pending; source controls do not imply preview deployment. A private server recovery command is out of scope. HTTP has no protected-account reset override or public recovery endpoint. See [authentication](authentication.md) for own-password changes and [dynamic branches](dynamic-branches.md) for operational scope.
