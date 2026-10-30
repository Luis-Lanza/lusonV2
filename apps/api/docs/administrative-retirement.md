# Administrative retirement foundation

Migration 017 adds integrity foundations only. Admin HTTP actions, session revocation,
filtered directories/selectors and UI confirmations are subsequent D3–D5 work; this
migration alone does not ship administrative deletion to users.

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
and `locations_retirement_check`. HTTP mapping and active-user authority enforcement
remain D3/D4 responsibilities.
