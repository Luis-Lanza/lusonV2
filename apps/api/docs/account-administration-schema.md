# Independent accounts and branch stock

Migration 014 establishes the schema prerequisite for S2, S3, S5 and S6. It does not expose account or branch administration endpoints. Apply it only through the existing migration runner; no application database was touched during this unit.

## Account contract for T3

- `auth_accounts.id` is a positive bigint primary key, independent of the non-unique assigned `location_id`. Existing IDs are copied from legacy locations; initial private bootstrap inserts still allocate 1, 2, 3 in order.
- Inserts without an ID use a transaction-serialized maximum-plus-one allocator. Explicit IDs participate in the same lock. Do not introduce another allocation path. Deleted highest IDs can be reused: upcoming administration should deactivate, not delete accounts, and must not expose caller-selected IDs.
- ID 1 is the only possible warehouse account, must remain assigned to warehouse location 1, and cannot be disabled, deleted or rekeyed. Every other account must be assigned to an existing non-warehouse location. There is no granular role table: warehouse assignment supplies the administrative distinction.
- `display_name` defaults to empty for compatibility with private bootstrap; the future administration API must require and validate personal display names. Username constraints and opaque non-null password-hash storage are unchanged; password validation/hashing remains Go-owned.
- `enabled` defaults true, `must_change_password` defaults true, and positive `authority_version` defaults 1. Sessions reference the independent account ID and carry their own authority version. T3 must enforce enabled status, compare versions, restrict temporary-password sessions and atomically retire prior authority on resets, password changes, reassignment and deactivation. These fields alone do not enforce revocation.
- The original account TRUNCATE prohibition remains. Protected administrator credentials, display name and password lifecycle state remain changeable for recovery.

## Branch contract for T4/T5

`SELECT create_branch('Sucursal C')` is a private database seam, not a public route. It requires initialized catalog metadata, takes the same advisory transaction lock as initialization, allocates the next positive smallint location ID, and inserts the branch. The insert trigger supplies every catalog variant with existing/reserved/available quantities of zero in the same transaction. Errors or caller rollback leave neither a location nor balances. Existing balances are never reset. Execution is revoked from PUBLIC; it is an invoker-rights function for the trusted owner/backend role, not an authorization boundary.

Warehouse ID/name and all existing location identities remain immutable; catalog and initialization protections remain unchanged. Locations retain smallint IDs (maximum 32767). Names are unique and nonblank; `Almacén` is reserved for ID 1. Direct trusted location insertion also runs stock initialization after metadata exists; only the function should be used by the upcoming API.

## Remaining dependencies and hazards

1. **T3:** unchanged Go auth still conflates account ID and location ID. It compiles against this schema but is unsafe for independent accounts until its queries/session joins and authority enforcement are replaced. Do not expose new account creation before then. Initial three-account provisioning remains SQL-compatible; no hash conversion or fictional personal attribution was added.
2. **T4:** transfer creator foreign keys now reference locations, not a unique account assignment. Historical values, immutable history, retry uniqueness and payload fingerprints are unchanged. Transfer direction/check constraints and realtime audiences still explicitly name locations 1–3; dynamic branches cannot yet perform all operations. Personal attribution needs separate nullable historical/new actor evidence, never a reinterpretation of creator location.
3. **T4/T5:** bootstrap dataset checks still require exactly three locations and 570 balances. Startup/seed/check behavior must be generalized before creating branches in a running deployment. Existing bootstrap tests also pin migration count 13 and will need a separately authorized update.
4. **T5:** owner-only branch SQL is not an admin-only HTTP operation. Authenticate/authorize administration, prevent public signup and warehouse creation, and validate inputs before exposing it. Stock-zero schema coverage is not evidence of working dynamic inventory/transfers/realtime.

## Verification

The isolated PostgreSQL test uses `testpg.Open`, `db.Apply` and `bootstrap.Seed`. It exercises legacy initial inserts, independent IDs, shared branch assignment, protected administrator rejection with unchanged rows/stock/revisions, atomic zero-stock branch initialization, location-based transfer creators and legacy session inserts. RED/GREEN receipts are under `odd/verification/account-administration/t2-*`. Only the migrations package was run; no application runtime or broader suite claim is made.
