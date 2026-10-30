# Administrative retirement foundation

Migration 017 supplies integrity foundations. D3 adds personal-user HTTP retirement,
atomic session revocation and filtered account directories; see [account API](administration.md).
D4 slice A adds branch HTTP retirement and admin-directory omission. Operational
filtering/metadata (slice B) and UI confirmations remain D4–D5 work. This is not a claim that the full deletion feature is shipped.

## Retained records

`auth_accounts.deleted_at` and `locations.deleted_at` default to NULL. Retirement
retains IDs, names, usernames, balances, realtime audiences and historical evidence.
Deleted accounts must be disabled; administrator 1 and warehouse 1 are protected.
There is no restore, recovery command, purge or identity/name recycling feature.
Bootstrap still checks 190 variants × **all** locations, and realtime still retains
**all** location audiences.

## Branch mutation contract

`branch_retirement_blocker(branch_id smallint) RETURNS text` returns `stock`,
`users`, `operations`, or NULL, in that precedence. Call it under transaction advisory
lock `(714025,1)` at READ COMMITTED for an authoritative decision. The marker UPDATE
also enforces it. Blockers include any nonzero existing/reserved stock, any nondeleted
assigned account (even disabled), pending/approved/in-transit headers, and the latest
undecided count/restitution/reconciliation proposal at either physical endpoint.
A historical received shortfall without pending proposals is not itself a blocker.

Existing admin writers acquire ordered account/session locks **before** the global
fence. Transfer transactions now take the global fence first in `beginPersonal`,
before retry/header/stock locks. Account assignment/activity reads remain MVCC;
never acquire account row locks under the transfer fence.

## Admission after retirement

Statement triggers take the same fence before tuple/FK locking. Row admission rejects
new headers and new received count/restitution/reconciliation operations if either
endpoint is retired, including direct operation INSERTs. Existing operation entrypoints
return recorded exact retries before INSERT, preserving historical replay. Balance
INSERT/UPDATE rejects archived locations. Nondeleted accounts cannot be assigned to
retired branches. Identity guards admit only a first branch retirement marker change;
IDs/names and physical location deletion remain protected.

New business failures use SQLSTATE `23514`: `active_location_required`,
`branch_retirement_blocked`, `locations_identity_immutable`, and
`account_retirement_immutable`. Check constraints are `auth_accounts_retirement_check`
and `locations_retirement_check`. D3's account DELETE uses ordered account/admin-session
locks before the UPDATE trigger's global fence, retaining rows and incrementing
version only on first retirement. Existing Login initial/locked enabled checks and
Current/Peek enabled/version/revocation predicates enforce account authority because
the constraint requires deleted accounts to be disabled. Realtime uses Peek for
initial admission and periodic revalidation. Live stream/concurrency verification
remains D6; active-location filtering remains D4 slice B.

Branch DELETE acquires `administrationTx(admin target 0)` then explicitly takes
`pg_advisory_xact_lock(714025,1)` before reading even the idempotent marker.
Separate READ COMMITTED statements read the marker and call the existing VOLATILE
`branch_retirement_blocker($1::smallint)` after any fence wait. Its stock/users/
operations result maps to the three documented HTTP 409 codes; no pending-work
predicate is duplicated in Go. The marker UPDATE retains the migration's trigger
recheck. No account row locks are acquired under the global fence.
