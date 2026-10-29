# Authentication and password authority

Authentication uses `auth_accounts.id`; `identity.location` is the assigned operational location, never the account identity. The sole administrator remains account 1 at warehouse location 1. There is no public registration or public recovery. Protected account/branch administration and operator resets are documented in [administration](administration.md); the private server command is documented in [warehouse recovery](warehouse-recovery.md).

Successful login and `GET /api/auth/session` return `authenticated`, `identity`, `csrf_token` and `expires_at`. Identity contains `account_id`, `username`, `display_name`, explicit boolean `must_change_password`, and `location: {id,name}`. No hashes or passwords are returned. Active reads renew idle authority at the existing interval; `X-Luson-Passive: 1` and `Peek` never renew it. Both validate enabled state and equality of session/account authority versions against the live database.

Login verifies the bounded Argon2 credential hash, then locks the account and rechecks hash, enabled state and authority version before inserting a session with that version. A concurrent reset, deactivation or reassignment that retires authority cannot mint a session from the previous verified credentials. Origin, CSRF, strict cookies and existing login throttle behavior are unchanged.

## Own password

`POST /api/auth/password` requires the normal same-origin/CSRF mutation guard and a live session, even for mandatory initial changes. Send `Content-Type: application/json` and exactly:

```json
{"current_password":"current private password","new_password":"different private password"}
```

The flat object is limited to 1024 bytes. Unknown, duplicate or missing keys, non-string values, invalid UTF-8, trailing input and invalid media types are rejected. The existing credential policy applies: 12–128 UTF-8 bytes without NUL, no second password policy. The new password must differ from the current password. Hashing uses the same bounded admission as login.

Success atomically replaces the hash, clears `must_change_password`, increments `authority_version`, and revokes every previous session. Response: **204**, empty body, expired session cookie; log in again. Validation/credential rejection does not alter account/session state. Errors are JSON `{"error":"code"}`: 400 `invalid_request`, 401 `unauthenticated` or `invalid_credentials`, 403 `forbidden`, 429 `rate_limited` (Retry-After 60), or 503 `service_unavailable`. Database errors and submitted secrets never appear in responses.

Mandatory-change sessions can inspect `/api/auth/session`, change their own password, and logout. Operational composition rejects them with 403 `password_change_required`; standalone auth middleware returns plaintext 403 `password change required`. SSE revalidation stops restricted or stale authority before further event writes. Session inspection continues to expose restricted identity rather than treating it as an invalid login.

## Administrator lifecycle integration

Administration validates the actual protected account and live completed session, then locks the administrator and target accounts in numeric order before sessions. Reset uses the small package-private `resetAccountCredential` primitive: replace the prevalidated hash, require a password change, increment authority version and retire all sessions in one transaction. Authorization and protected-account policy stay outside that neutral primitive; the private warehouse recovery entry point reuses it after locking and rechecking the existing enabled protected account, without an HTTP override. The existing own-password implementation is unchanged.

Reassignment and enabled-state transitions retire authority atomically; reactivation never restores old sessions. Profile-only and no-op edits preserve sessions. Reset does not enable disabled accounts. Database constraints protect the singleton assignment but never replace live service authorization. Dynamic inventory, transfer and SSE fences continue to apply. Ordinary operational test fixtures explicitly set `must_change_password=false`; production defaults remain mandatory.
