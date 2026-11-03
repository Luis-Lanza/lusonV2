# Unified reconciliation HTTP read

## Endpoint

`GET /api/transfers/{id}/unified-reconciliations` returns the coordinated
`luson.transfer-reconciliation/v2` snapshot for either authenticated endpoint.
The request ID must be canonical positive decimal. Query strings, including an
empty `?`, are rejected with `400 invalid_request`. Unauthenticated requests
receive `401 unauthenticated`; private or missing transfers receive
`404 not_found`. Other methods receive `405 method_not_allowed` with `Allow: GET`.
Unknown descendants receive `404 not_found`.

## Evidence boundaries

- `original` is the immutable receipt, including unexpected variants.
- `legacy` retains historical count, restitution and dispatch evidence; it is
  not an overlay to apply again to current quantities.
- `current` is the authoritative coordinated projection, with explicit owner,
  source, application and generation provenance.
- `lines` contains expected-variant workflows; `operations` retains unified
  history. Empty collections serialize as arrays, not null.

Quantities, request IDs, revisions and generations use decimal strings to avoid
JavaScript integer truncation. Variant and location IDs remain JSON numbers.
Unavailable physical facts and absent application keys remain explicit nulls;
unknown differences must not be inferred as confirmed losses or inventory credit.

## Delivery and proof limits

This unit exposes GET only: no mutation decoder, POST routes, operation envelope,
UI activation or real HTTP-to-TypeScript seam. The existing six-category action
API is unchanged; unified discovery is a later delivery unit.

The GET test covers both endpoints, admission failures and unchanged inventory
and counters. The serializer test covers maximum int64, timestamps, empty arrays
and explicit nulls. Parent-owned verification also includes the existing
dispatch-read regression and API compilation.

`TestUR4PopulatedPrefixUpgrade` installs genuine checksummed migrations 001–017,
populates public historical operations, then upgrades through `db.Apply`.
Its approved test-local bootstrap exception preserves credential, hashing,
location and transaction invariants without weakening production validators.
The three scenarios cover sample, prior restoration and dispatch/count history,
no double credit, fenced old consent, exact retries and retained evidence.
Counter observations begin **after** upgrade: this is not proof of pre/post
migration counter preservation. A later historical rejection advances only the
affected count generation while preserving physical and unified evidence.

Execution evidence belongs to the parent serial isolated fixture; assembly or
source equivalence alone does not establish a new GREEN result.
