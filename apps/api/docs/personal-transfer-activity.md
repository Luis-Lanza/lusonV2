# Personal transfer activity

## Read contract

`GET /api/transfers/{id}` and successful full-transfer mutation responses add an
optional `activity` array. Its absence means no personal evidence is recorded;
it does not identify a person. Lists omit activity and do not query its table.
The existing workflow operation/history DTOs are unchanged: read transfer detail
to see their personal authors. No new endpoint, query option or role is added.

```json
{
  "category": "count",
  "action": "accept",
  "actor": {"account_id": "20", "username": "ana", "display_name": "Ana"},
  "location_id": 2,
  "location_name": "Sucursal A",
  "recorded_at": "2026-04-02T12:34:56.123456789Z",
  "variant_id": 1
}
```

Each array entry has exactly the six fields shown before `variant_id`; workflow
entries additionally require numeric `variant_id`. `actor` has exactly the three
shown fields; `account_id` is a positive decimal bigint string. Location/variant
IDs remain JSON integers. `recorded_at` is the business operation's persisted UTC
RFC3339Nano time, not the fetch time. Names are immutable snapshots. Empty
`display_name` is valid for bootstrap accounts; display `username` as fallback.

| Category | Actions |
|---|---|
| `transfer` | `create`, `approve`, `reject`, `dispatch`, `receive`, `cancel` |
| `count` | `propose`, `accept`, `reject` |
| `restitution` | `propose`, `accept`, `reject` |
| `reconciliation` | `propose`, `accept`, `reject` |

Direct shipment creation records one `create` operation, including its existing
creation-time authorization/reservation; it does not invent a later approval.
Entries retain write order through an internal per-request ordinal, even when
business action times coincide or a waiting statement began earlier.
Retry keys/fingerprints and internal operation identities are not exposed here.

## Identity, history and atomicity

Migration **016** is additive. It creates `transfer_personal_activity` and operation
triggers without rewriting migrations001–015, business ledgers, location-owned
retry fingerprints, inventory, operation counters or old history. There is no
historical backfill. SQL-owner fixtures without authenticated context remain
location-only, including exact replays of their old operations.

The Store passes only trusted `auth.Identity.AccountID` into a transaction-local
setting. Trigger-time account/location reads copy username, display name and
physical location into evidence in the same transaction as the admitted effect.
Request payloads cannot supply actors or snapshots. The setting is not session
policy: live authentication and existing `checkAssignment` remain authoritative.
It is not a security boundary against database owners who control SQL/DDL.

Evidence is append-only, guarded against direct insertion/update/delete/truncate.
The primary key reuses request/category/existing operation identity; it adds no
new sequence or retry framework. The per-request ordinal is allocated under the
existing operation locks and rolls back with the write; it is not a retry key.
The existing operation locks/uniqueness decide
concurrent duplicates. Replays insert no operation and therefore append no event,
even when a different operator at the same branch recovers an uncertain response.
Failed statements, explicit rollback and deferred commit failure remove evidence
with all corresponding business effects. Account reads add no row/advisory locks.

Later display-name changes, reassignment or deactivation do not alter snapshots.
There is intentionally no account foreign key that could cascade account removal
into historical authorship. Existing physical ownership and responsibilities do
not change when personnel change.

## Privacy and presentation

Only the existing physical participants can load personal evidence, after the
assigned-account binding and participant-scoped header have been admitted.
Unassigned identities retain Forbidden; assigned nonparticipants retain NotFound,
including workflow history reads. Errors, session gates, passive reads and unknown
write recovery retain their prior contracts. Activity is evidence, not authority
to mutate, a workflow head, or proof that an absent uncertain operation failed.

The existing transfer detail's “Ver historial” displays “Autoría personal” with
Spanish actions, snapshot name, physical location, variant when applicable, and
the existing Bolivia-time component. React renders names as escaped text. The
mount-bound authority fence retires names with the old session. Unknown legacy
authorship is explicitly described as location responsibility, not a user.
Existing tokens, history styles and responsive layout are reused without a
visual redesign. Administration screens remain a separate unit.
