# Consult three-location inventory

L03 adds authenticated, read-only PostgreSQL inventory. Each account can consult
all three locations; consultation never changes the account's assigned operating
location. No frontend, aggregate inventory, stock mutation or transfer route is
included.

## Quick path

1. Log in through the existing [authentication API](../../../README.md).
2. Fetch `GET /api/inventory/metadata` with the session cookie.
3. Fetch `GET /api/inventory?location_id=1` and choose filters/page independently
   of the assigned location returned by `GET /api/auth/session`.

Both routes require an unambiguous `luson_session` cookie. Missing, expired,
revoked or invalid sessions return JSON 401, unlike the public session route's
anonymous 200 response. These GETs do not require mutation CSRF headers; existing
login/logout origin, CSRF and cookie protections remain unchanged.

## Requests

Metadata accepts no query fields and returns PostgreSQL-derived
`locations:[{id,name}]` ordered by ID and distinct `brands:[string]` ordered by
brand. Locations remain `1:Almacén`, `2:Sucursal A`, `3:Sucursal B`.

| Inventory query | Contract |
| --- | --- |
| `location_id` | Required positive decimal integer, existing location 1–3; no GLOBAL/0 |
| `search` | Optional literal, case-insensitive brand/model substring; maximum 128 UTF-8 bytes; empty means no search |
| `brand` | Optional nonempty exact PostgreSQL brand, including case; maximum 128 UTF-8 bytes |
| `polarity` | Optional explicit `L` or `R`; never inferred from model suffix |
| `page` | Default 1; positive decimal digits, maximum 1,000,000 |
| `page_size` | Default 10; only 10, 25 or 50 |

Filters are AND-combined. Search does not match capacities, quantities or status.
Percent, underscore and backslash are literal characters, not SQL wildcards.
URL-encode values, especially `+` and `&`. SQL uses bound parameters.

Duplicate or unknown fields, malformed URL encoding, invalid UTF-8, NUL, empty
explicit brand/polarity, signed/fractional integers and unsupported values are
400 `invalid_request`. Raw query length is bounded at 4096 bytes; integer text
at seven digits. Bounds are technical request/overflow safeguards, not business
rules. Leading zeros are accepted within the text bound. Page offsets are
computed in int64 after validation (maximum 49,999,950).

## Responses

Inventory JSON uses these fields:

```json
{
  "location": {"id": 1, "name": "Almacén"},
  "items": [],
  "page": 1,
  "page_size": 10,
  "total_variants": 0
}
```

Each item has `variant_id`, `catalog_entry_id`, `brand`, `model`, `capacity_ah`,
`polarity`, `existing`, `reserved`, `available`. Capacity is an exact JSON number
(e.g. `6.5`, not a quoted value or binary-float conversion). Quantities are
PostgreSQL bigint values; `available` reads the generated `existing-reserved`
column. There are no status/threshold fields or invented operational holds.

Items are ordered by `variant_id`. Count and items use identical predicates in
one read-only repeatable-read transaction. A valid page beyond the last returns
`items:[]` and the accurate total, not 404. Empty metadata/item arrays are never
null. The unfiltered initialized catalog has 190 variants per location.

| Failure | JSON error |
| --- | --- |
| 400 | `invalid_request` (including duplicate session cookies, even identical ones) |
| 401 | `unauthenticated` |
| 405 | `method_not_allowed`, with `Allow: GET` |
| 503 | `service_unavailable` (no driver/connection details) |

Method validation precedes authentication; authentication precedes query
validation. Responses have `Cache-Control: no-store` and
`X-Content-Type-Options: nosniff`. There is no inventory write method. Catalog
and balance reads do not mutate data; normal authenticated session maintenance
may still update session activity.

## Verify

Tests use fresh generated credentials and PostgreSQL 17.9 containers on the
explicit parent-owned active L03 network. Both `LUSON_TEST_NETWORK` and
`LUSON_TEST_NETWORK_MANIFEST` are mandatory. The helper checks manifest schema,
active status, exact name/ID/four ownership labels and freshly inspected Docker
metadata before each container. Relative manifest paths resolve from the
canonical repository root; absolute paths are accepted. No fallback or skip is
allowed, and a descriptor alone does not authorize network creation/lifecycle.

See [observed checks](../../../odd/evidence/login-inventory/l03-inventory-checks.md)
for commands, RED/GREEN, preservation and owned-container cleanup evidence.
