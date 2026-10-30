# Dynamic branch operations

Warehouse location 1 belongs only to account 1. Every other account is a personal operator assigned to an existing branch. Operators have the branch's full existing capabilities; account IDs are independent of location IDs and do not grant additional authority. The numbers may coincide; the actual database assignment governs operations.

## Operational contract

- Usernames and account IDs are stable identities: neither can be renamed or rekeyed. Password, display-name and supported lifecycle/reassignment edits remain permitted; the warehouse administrator remains protected from deletion.
- Authentication resolves the assigned location and enforces enabled accounts, authority versions and mandatory password changes. Inventory, transfer and SSE paths retain those fences.
- Transfer Store boundaries check the provisioned account ID **and** its actual assigned location, reusing creation's binding query. Positive IDs alone do not establish assignment: absent accounts and mismatched bindings are forbidden; valid nonparticipants retain private not-found responses. Dependency, structural-input and invalid-request-ID guards still precede database access. Binding checks do not replace authentication's live session/lifecycle authority.
- Transfer participants, decisions, stock, revisions and retry fingerprints remain **location-owned**. Two operators at the same branch can read and act on the same transfer, including replaying an identical creation key. Personal attribution is separate work; historical location evidence is not personal history.
- Locations are existing positive smallint identities (1–32767). Transfer creation accepts that same canonical JSON-integer range for `counterparty_location_id`, including newly created branches; the Store still rejects nonexistent locations against the initialized inventory/location data. Direct shipments originate only at warehouse 1 and may select any existing branch (2–32767); branch requests use a different physical origin; branch proposals go only to warehouse 1. Approved/rejected/in-transit/received decision DTOs admit assigned dynamic-branch approvers. Cancelled DTOs retain dynamic-branch approval and creator-cancellation locations; only the creator may cancel a pending or approved request before dispatch, releasing reservations without changing physical stock. Existing lifecycle and conservation guards remain in force.
- A new branch receives zero balances for all 190 catalog variants and a private transfer revision row atomically. Inventory invalidations refresh connected brokers so the new audience becomes subscribable. Unknown audiences and malformed notification framing fail closed.
- Bootstrap rechecks the complete catalog × current-locations balance matrix without resetting operational quantities or repairing partial datasets. The embedded catalog and three base location identities remain protected.

## Protected administration seam

`POST /api/admin/branches` now calls `create_branch(text)` through the protected administrator service transaction; see [administration](administration.md). The database function remains revoked from PUBLIC. It serializes allocation through the existing initialization lock and requires an initialized catalog. Branch initialization reuses the existing `initialize_branch_inventory` trigger for both stock and realtime state. No schema changes or duplicate initialization logic are introduced by the API.

## Browser integration

The session wire decoder requires explicit `display_name` and boolean `must_change_password`, accepts positive safe-integer account IDs, and validates dynamic smallint location IDs. Optional fields on the TypeScript identity interface accommodate older synthetic component fixtures, not missing server fields: the decoder never defaults a missing mandatory-change flag to false.

Metadata supplies eligible branch destinations. The original A/B flow aliases remain compatible, while explicit `direct:<id>` and `request:<id>` flows carry additional destinations through cart restoration and unknown-write recovery. Recovery remains isolated by personal account, assigned location and session generation even though the server's durable retry fingerprint is location-owned.

Password-change screens are not implemented here. Until that integration is available, `useInventory` refuses operational bootstrap for mandatory-change sessions: no inventory reads, realtime connection or transfer authority starts. The session endpoint itself remains available under the authentication contract.
