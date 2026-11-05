# Catalog batteries

The operational catalog contract: the warehouse administrator creates, edits and
retires batteries. The database is the catalog authority; the embedded fixture is
only the initial seed.

## Authorization

Every route requires the warehouse administrator identity, the same authority
`/api/administration` uses: account 1 assigned to location 1, with a completed
password change. A branch administrator is refused `403 {"error":"forbidden"}` and
an unauthenticated caller `401 {"error":"unauthenticated"}`. A mutation also needs
the ordinary same-origin and CSRF header check; a write with a query string is
`400`.

## Routes

| Method | Path | Success | Meaning |
| --- | --- | --- | --- |
| `POST` | `/api/catalog/batteries` | `201` record | Create a battery and its variants atomically |
| `PATCH` | `/api/catalog/batteries/{id}` | `200` record | Edit an active battery's identity |
| `DELETE` | `/api/catalog/batteries/{id}` | `204` | Retire a battery, one way |

### Create

```json
{"brand":"TOYO","model":"NS40ZL","capacity_ah":"45","polarities":["L","R"]}
```

`polarities` carries at least one and at most both of `L` and `R`, ascending and
unique. Identifiers are never supplied: the database allocates the battery id and
each variant id, and every active branch receives a zero balance row for every new
variant in the same transaction.

### Edit

```json
{"brand":"TOYO","model":"NS40ZL","capacity_ah":"45.5"}
```

All three fields are required; a partial edit is refused rather than merged. Ids and
variants never change. A retired battery has left the editable catalog, so editing
it answers `404`.

### Retire

There is no physical deletion. Retirement is refused while the battery still has
stock or reservations, or while an open transfer operation references it. A repeat
on an already retired battery is a successful no-op, matching branch retirement.

## Response record

```json
{"id":113,"brand":"TOYO","model":"NS40ZL","capacity_ah":"45",
 "variants":[{"id":212,"polarity":"L"},{"id":213,"polarity":"R"}],
 "priced_branches":0}
```

`priced_branches` exists because a battery is not sellable until it holds a price in
a branch: creation never invents one, and `0` is the state the price screen has to
resolve.

## Errors

| Status | Code | Cause |
| --- | --- | --- |
| `400` | `invalid_request` | Non-canonical body, capacity or polarity, or a query string on a write |
| `401` | `unauthenticated` | No session |
| `403` | `forbidden` | Not the warehouse administrator, or a bad origin/CSRF token |
| `404` | `not_found` | Unknown battery, or editing a retired one |
| `409` | `conflict` | An active battery already holds that brand and model |
| `409` | `catalog_battery_has_stock` | Stock or reservations still reference the battery |
| `409` | `catalog_battery_has_pending` | An open transfer operation references the battery |
| `503` | `service_unavailable` | The catalog authority is unavailable |

A retired identity frees its `(brand, model)` pair, so a new battery may reuse it.
Past evidence keeps referring to the retired row, which is why retirement replaces
deletion.
