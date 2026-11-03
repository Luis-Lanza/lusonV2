# Unified transfer reconciliation

Expected variants use one jointly reviewed agreement in a modal over the existing
detail table. The implementation includes atomic Store operations, versioned
HTTP boundaries, strict frontend codecs, exact-operation recovery, historical
audit and unified review discovery. Internal Store structs are not HTTP DTOs.

Observed checks include Store/HTTP integration, three populated prefix-upgrade
scenarios, 81 baseline/candidate sibling refusals and eight synthetic Chromium
interaction cases. Independent source verification found no concrete production
blocker. The full API run failed on outdated tests; its corrected failing
selections passed, not a new full-suite run. Browser transport is simulated and
pre/post-upgrade counter preservation is not proven. Delivery review and final
work-unit closure remain separate from these checks.

## Read-only HTTP contract (candidate)

`GET /api/transfers/{id}/unified-reconciliations` returns the coordinated
`luson.transfer-reconciliation/v2` snapshot to authenticated physical
participants only. Query parameters are rejected. Other methods return 405;
unknown suffixes return 404. Existing transfer errors and no-store headers apply.

The closed top-level object contains `schema`, `request_id`,
`origin_location_id`, `destination_location_id`, `received_at`, `original`,
`legacy`, `current`, `lines`, and `operations`. Request IDs, quantities,
revisions, generations and signed deltas are canonical decimal strings. Variant
and location IDs retain the existing numeric representation. Timestamps use the
existing canonical UTC serializer. Optional facts/decisions/applications are
explicit nulls; collection fields are always arrays, including when empty.
`legacy` contains `count`, `restitution`, and `dispatch` using their existing
wire contracts. Unexpected received variants remain in `original` and `current`,
but do not gain unified workflow lines. This endpoint never applies effects.
The frontend consumes this coordinated snapshot for the received table, modal
and audit history. Mutation production-router checks passed on the isolated
fixture.

## Mutation HTTP contract (candidate)

POST suffixes `/propose`, `/accept` and `/reject` reuse existing method,
identity, duplicate Sec-Fetch-Site, CSRF, no-query, canonical request ID and
`CheckRestitutionAccess` admission, in that order before reading the body.
No current snapshot is read to decide eligibility: historical exact retries
must remain possible after later revisions or decisions.

The closed proposal object requires numeric `variant_id`, string
`operation_key`, canonical nonnegative decimal strings `expected_revision`,
`dispatch_quantity`, `arrival_quantity`, `retained_quantity`, boolean
`retained_at_origin`, and string `reason`. Decisions omit all three quantities;
the path supplies acceptance, not a body field. Actor and baselines are not
caller-controlled. Existing key/reason limits apply without trimming admitted
text. Duplicate decoded names, unknown/missing fields, noncanonical integers,
invalid UTF-8, ambiguous/non-JSON MIME and trailing input are rejected.

The technical response choice is the closed `{schema, operation}` envelope,
with `schema: "luson.transfer-reconciliation-operation/v2"`. Its operation
uses the exact unified GET operation DTO, including explicit nullable facts,
canonical bigint strings and UTC timestamp. Successful exact retries return
original operation evidence, not newly computed stock. Error/status pairs and
security headers reuse existing reconciliation HTTP behavior. The modal uses
captured original-context recovery and explicit confirmation; effects never POST
on mount, editing or passive refresh.

## Pending reviews and personal activity

The existing participant-private list/count projection reports
`review_unified_reconciliation` as its only review category. It is
present only for a received transfer with an originally expected variant whose
latest unified proposal has no decision and was initiated by the other endpoint.
Either endpoint may initiate. Multiple variants contribute once per transfer and
count once in the `action_count` union. `pending_total`, descending ID ordering
and pagination keep their existing meaning. Counts serialize all four category
values as canonical nonnegative decimal strings. The retired count, restitution
and dispatch audit flows are history only: their tables, triggers and readers
stay, but they contribute no category, no union membership and no list reason.

Stale predecessor generations and insufficient stock do not hide a pending
review: they can block acceptance, but rejection remains an obligation. A
replacement uses only the latest per-variant revision; a terminal decision on it
removes that variant's review, even if an older proposal was superseded without
a decision. List/count reads never authorize mutations or alter inventory.

Personal activity uses migration018's existing `unified` category with
`propose`, `accept`, and `reject`, preserving recorded actors and original
receipt evidence. No migration or historical backfill is introduced.

## Public Store contract

- `ProposeUnifiedReconciliation`: variant, operation key, expected workflow
  revision, dispatch D, arrival A, total retention R, origin attestation, reason.
- `DecideUnifiedReconciliation`: variant, operation key, expected revision,
  accept/reject, origin attestation, reason.
- `GetUnifiedReconciliations`: participant-private, coordinated snapshot in one
  read-only repeatable-read transaction, including:
  - immutable `Original`, physical endpoint IDs and receipt timestamp;
  - `Legacy.Count`, `.Restitution`, `.Dispatch` histories and coherent legacy
    accounting, using the existing SQL readers and restitution validator;
  - `Lines` and `Operations`: unified history only, including immutable baseline
    quantities, independent generations and acceptance/application identities;
  - `Current`: authoritative accounting for every receipt variant.

The internal schema identifier is `luson.transfer-reconciliation/v2`. Quantities
are int64 internally. Future wire serializers must use canonical decimal strings
for bigint values, closed versioned schemas, explicit nulls and strict codecs.

## Ownership is not an application

| State | Current owner | Current source |
|---|---|---|
| No unified proposal | legacy | legacy effects |
| Unified proposal pending/rejected, no acceptance yet | unified | legacy effects |
| Accepted unified proposal | unified | that acceptance |
| Later pending/rejected proposal | unified | previous acceptance |

Ownership begins at the first proposal and never reverts on rejection. Current
source includes its applied revision and acceptance operation key; no timestamp
or cross-workflow revision comparison selects the source. For legacy-sourced
state, retention/unknown/excess fields are null: historical accounting does not
establish new jointly agreed physical facts. Unexpected receipt variants remain
legacy-sourced, audit-only and ineligible for unified mutation.

The old public `GetCountCorrections`, `GetRestitutions` and
`GetDispatchReconciliations` preserve their exact unowned projections. Once any
line is owned they return zero output and `ErrUnifiedReconciliationRequired`,
which wraps `ErrDecisionConflict`. They never return stale legacy quantities
labelled as current. Historical evidence remains available under `Legacy` in
the coordinated snapshot. `transfer_effective_line` retains its legacy meaning;
no legacy-field overlay, synthetic revision or historical backfill is used.

## Exact accounting

`CalculateUnifiedAccounting` and SQL `transfer_unified_accounting` use:

| Value | Formula |
|---|---|
| Allowed retention | `0 <= R <= max(E-D,0)` |
| Target source debit | `max(E,D)-R` |
| Target destination credit | `min(D,A)` |
| Source stock delta | actual source debit minus target source debit |
| Destination stock delta | target credit minus actual destination credit |
| Origin unknown | `max(E-D,0)-R` |
| Transit unknown | `max(D-A,0)` |
| Excess, not credited | `max(A-D,0)` |

E is the immutable original debit. Zero quantities and quantities above E are
valid; stock, reservation, int64 and retention bounds still apply. Unknowns are
not confirmed losses, returns or unexpected incorporation.

Baselines sum actual receipt, legacy and unified effects with numeric SQL
intermediates and explicit bigint bounds. The coordinated reader independently
recomputes signed effects with wide Go integers and checks consent/application
identity, origin attestation, revision/generation structure and current selection.
Operation stock snapshots are audit evidence, never chained across unrelated
inventory activity.

For E10/D9/A8/R1 with baselines10/8, deltas are +1/0 and transit unknown1.
After prior restoration1, source baseline9 gives 0/0, not another +1.
After that legacy restoration, a new D12/A12/R0 agreement produces source
baseline9 -> target12, delta-3. Historical restitution1 remains unchanged under
`Legacy`; current retention0 is a separate agreement, not erased history.
With baselines10/10, D12/A12/R0 yields -2/+2.

## Admission, atomicity and coexistence

The Store reuses assignment checks and `beginPersonal`. SQL rechecks physical
participation under the existing advisory fence714025/1 and header lock.
Either endpoint initiates; only its counterparty decides. Only origin can attest
positive retention, when proposing or accepting a destination proposal. Only the
initiator replaces a pending proposal; terminal proposals allow fresh agreements.

Both endpoint inventory rows are locked in physical order and validated before
either update, including zero-effect rows. Existing inventory audit/invalidation
triggers remain authoritative. Application admission verifies durable bilateral
consent and resulting balances; deferred checks require durable operation and
application evidence. Immutable protection reuses existing evidence guards.

Proposal pins independently count per-variant count/restitution/dispatch/unified
operations. Acceptance rejects changed predecessors; rejection remains possible.
New legacy proposals/acceptances are fenced only on owned expected variants.
Historical exact retries return their original operations/balances before new
insertion checks. Reasons and attestations are part of exact retry identity.
Unexpected audit corrections remain unaffected.

The existing personal-activity writer records a new `unified` category without
backfill. The existing retirement blocker is retained and extended for pending
unified consent. Old callers keep their signatures and original policy.

## Verification and proof boundaries

Parent observed the initial compile-only RED: undefined unified API, exit1/1s.
The writer does not execute DB tests. Tests use admitted random databases,
existing fixture helpers, public Store/inventory observations and serial fixture
workloads. Existing 30-second fixture contexts are unchanged.

Selected tests cover the sample, prior restoration, overdispatch, zero/downward
counts, partial unknowns, both initiators, attestation/roles, exact retry conflicts,
replacement/stale generations, legacy coexistence, public fail-closed readers,
immutable nested audit, current source selection, reservation/unavailable-stock
rollback, suppressed/deferred failure rollback, evidence admission and concurrent
acceptance once. Historical-body compatibility uses embedded migration helpers;
this is not a claim of a fully populated real pre018 prefix upgrade run.

`TestUR4PopulatedPrefixUpgrade` separately prepares genuine checksummed001–017
random databases using the admitted testpg helper, then applies018 via `db.Apply`.
Its three scenarios populate receipts and transfer history exclusively through
public Store mutations: the10/9/8/1 sample, prior applied restitution1 (no second
credit), and applied dispatch7/count6. Each carries pending historical count
consent across the upgrade, checks failed acceptance without public effects,
retains rejection and exact retries, and applies a fresh unified agreement.
Public inventory, participant counters and coordinated history are observed;
internal transfer ledger rows are not used as behavioral proof. Current public
`Counts` queries018 tables via the action projection, so counter observations
start immediately **after** `db.Apply`; pre/post migration counter preservation
is **not proven**. Pre-upgrade observations remain public inventory, original
receipts and returned immutable operations. Post-upgrade counters check the
historical review obligation, failed mutations and exact-retry preservation.
Historical rejection must append exactly one count operation and increment only
that variant's current `version.count` by1. Accounting, source/application
identity, physical facts, other generations, unexpected variants, original
receipt and unified evidence remain unchanged. An exact rejection retry must
preserve the complete resulting snapshot, inventory and counters.

The explicitly approved test-local bootstrap exception is confined to that test
file. `bootstrap.Initialize` would install018 prematurely, while
`bootstrap.Provision` requires latest-schema `db.Check`. The helper duplicates
only prefix tracking and initial account bootstrap: contiguous embedded SQL,
SHA256 checksums, unchanged tracking shape, initialization advisory lock and
transaction; exactly three valid, distinct credentials, `auth.HashPassword`,
empty-account refusal, exact catalog location names/order, and transactional
account insertion. Trial inventory still uses `bootstrap.Seed`. No production
validator/function is replaced, disabled or weakened. Legacy public getters
reference018's ownership function, so pre-upgrade evidence comes from original
public receipts and returned operations; coordinated legacy reads begin after
upgrade. Execution remains parent-owned and is not implied by test presence.

Parent execution observed populated prefix-upgrade PASS for all three scenarios,
HTTP mutation and strict-codec seam PASS, and 81 identical sibling refusals with
unchanged public state within each version. Eight synthetic Chromium cases passed
for both actors at mobile and desktop widths, including exact Gestiones focus
restoration, explicit confirmation and uncertain-operation recovery. These browser
checks do not prove backend persistence or successful durable responses.

Independent read-only verification assessed S1–S7 as met within the accepted scope
and found no concrete production blocker; it did not execute workloads itself.
The original full API run remains a recorded failure, with all failed selections
subsequently corrected and passing. Native review and final delivery closure are
not implied by functional verification.

Old HTTP reads fail closed for owned requests. The frontend selects `Current`
separately from nested legacy audit. Never weaken legacy validators or unwrap
legacy audit as a current-state fallback.
