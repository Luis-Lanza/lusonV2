# Suppliers

The warehouse supplier administration: who supplies the warehouse and which catalog
products that supplier offers. A supplier offers catalog **entries** (a battery is
offered as its brand and model, an other product as its name), while an ingress
document keeps naming **variants**. The offer list is what makes the ingress picker
and the persisted document agree.

This vertical is **money-free**. It records a supplier, the products it offers and
(later, through ingress) quantities. There is no price, no cost, no remittance, no
invoice, no purchase order and no account: cost belongs to another vertical.

## Where it sits

Migration `059_suppliers.sql` adds:

- `suppliers(id, name, contact, deleted_at, created_at)` — a name trimmed by the
  column's own check and unique among **active** suppliers ignoring case
  (`suppliers_active_name`), a free contact of at most 200 characters, and a one-way
  retirement marker.
- `supplier_offers(supplier_id, catalog_entry_id)` — the current offer set, primary
  key on the pair, so a supplier offers an entry at most once.
- `admit_supplier_offer` — refuses a new offer for a retired or unknown supplier
  (`LV001`) and for a retired or unknown catalog entry (`LV002`).
- `protect_supplier` — refuses a physical `DELETE`/`TRUNCATE` of a supplier
  (`LV003`), because persisted ingress documents name it.

The domain never deletes: retiring an entry is a `deleted_at` update, and a retired
row stays readable forever.

## Authority

Every route requires the **warehouse administrator**: account 1 assigned to location
1 with a completed password change. That is the same gate as `/api/administration`,
`/api/catalog/batteries` and `/api/stock-entries`.

- A branch administrator, any other account, or the warehouse account with a pending
  password change is refused `403 {"error":"forbidden"}`.
- An unauthenticated caller is refused `401 {"error":"unauthenticated"}`.
- Authority is decided **before** the method, the framing and the body, so an
  unauthorized caller never learns whether its request was otherwise well formed.
- A mutation also needs the ordinary same-origin `Origin`/`Sec-Fetch-Site` check and
  the `X-CSRF-Token` header derived from the session. A write carrying a query string
  is `400 {"error":"invalid_request"}`.

## Routes

| Method | Path | Success | Meaning |
| --- | --- | --- | --- |
| `GET` | `/api/suppliers?page=&page_size=` | `200` page | Active suppliers first by name, retired ones last |
| `POST` | `/api/suppliers` | `201` record | Create a supplier |
| `GET` | `/api/suppliers/catalog?kind=&search=&page_size=` | `200` entries | The assignable catalog entries |
| `GET` | `/api/suppliers/{id}` | `200` detail | One supplier with its whole offer set |
| `PATCH` | `/api/suppliers/{id}` | `200` record | Replace the name and the contact |
| `DELETE` | `/api/suppliers/{id}` | `204` | Retire the supplier, one way |
| `PUT` | `/api/suppliers/{id}/offers` | `200` detail | Replace the whole offer set |
| `GET` | `/api/suppliers/{id}/catalog?kind=&search=` | `200` items | The variants the supplier offers |

`/api/suppliers/catalog` is a fixed path of its own, never the identity `{id}`: the
literal path always wins over the identity pattern.

### List

```json
{ "suppliers": [
    { "id": 2, "name": "Distribuidora Norte", "contact": "555-1234",
      "retired": false, "kinds": ["battery", "other"], "offers": 12 },
    { "id": 1, "name": "Distribuidora Sur", "contact": "",
      "retired": true, "kinds": ["battery"], "offers": 3 } ],
  "page": 1, "page_size": 10, "total_suppliers": 2 }
```

Active suppliers come first, ordered by name ignoring case; the retired ones are
listed at the end and marked. `kinds` is derived from the offered entries in the
catalog's order (`battery` before `other`) and `offers` is the exact number of offered
entries, so a row states both what the supplier offers and how much of it, without a
second read. `total_suppliers` counts every supplier of every page.

`page` defaults to 1 and `page_size` to 10; the admitted page sizes are 10, 25 and 50
and the admitted page bound is 1000000. Any other value, an unknown key, a repeated
key or an empty value is `400`.

### Create and edit

```json
{"name":"Distribuidora Norte","contact":"555-1234"}
```

Both keys are required and the response is the allocated record:

```json
{"id":2,"name":"Distribuidora Norte","contact":"555-1234"}
```

`PATCH` carries the same pair and answers the same shape. It changes the name and the
contact **only**: never the id, never the offer set, never the retirement marker. An
absent `contact` is a malformed body, not an empty contact — send `"contact":""` to
clear it. Editing a retired supplier is `404 not_found`, because a retired supplier
has left the editable list.

### Retire

`DELETE /api/suppliers/{id}` marks the supplier retired and answers `204` with no body.
Retirement is one way and never deletes the row: the documents that named it keep
reading it. Retiring an already retired supplier is `409 conflict`, and editing,
assigning or picking a retired supplier is refused as described below.

### Detail and the offer set

`GET /api/suppliers/{id}` and `PUT /api/suppliers/{id}/offers` answer the same shape:

```json
{ "id": 2, "name": "Distribuidora Norte", "contact": "555-1234", "retired": false,
  "offers": [
    { "catalog_entry_id": 5, "kind": "battery",
      "brand": "CAR", "model": "N120", "capacity_ah": "120" },
    { "catalog_entry_id": 113, "kind": "other", "name": "Agua acidulada" } ],
  "kinds": ["battery", "other"] }
```

An offer is a catalog **entry**, in ascending entry id order: a battery entry carries
`brand`, `model` and `capacity_ah` (the canonical decimal text, never a float), an
other product carries its `name`, and neither invents the attribute of the other kind.
An entry carries no `polarity`: polarity is a property of a **variant**, and the
assignment is entry level, so the entry shape has none — the variant shape below does.

The assignment body is the whole final set:

```json
{"catalog_entry_ids":[5,113]}
```

- It **replaces** the set instead of merging it, in one transaction, serialized with
  one advisory lock per supplier id, so two concurrent assignments cannot interleave.
- An empty list is a valid final state: a supplier that offers nothing.
- Order and repetition carry no meaning; the stored and published set is ascending and
  unique.
- At most 200 entries per supplier.
- An entry id that is unknown or retired is `400 invalid_request` (the database's
  `LV002`), and a refused assignment leaves the previous set exactly as it was.
- A retired supplier cannot gain offers: `409 conflict`.

**The offer list is state, not history.** It is the current answer to "what does this
supplier offer", always the whole set the last assignment wrote; there is no
per-offer log and removing an offer erases nothing but the offer. The history of what
was actually received lives in the ingress documents themselves, which name the
supplier and keep their lines forever.

### Assignable catalog entries

`GET /api/suppliers/catalog?kind=&search=&page_size=` answers the entries a supplier
can be assigned:

```json
{ "entries": [
    { "catalog_entry_id": 5, "kind": "battery",
      "brand": "CAR", "model": "N120", "capacity_ah": "120" },
    { "catalog_entry_id": 113, "kind": "other", "name": "Agua acidulada" } ],
  "page_size": 50, "total_entries": 96 }
```

- Only **active** entries appear; a retired entry is never assignable.
- `kind` is optional and admits `battery` or `other`. The absent value lists **both**
  kinds, so `all` is not an alias here and is `400`.
- `search` is optional and literal (a typed `%` or `_` never becomes a wildcard) over
  the brand, the model and the product name, at most 128 characters.
- `page_size` defaults to 50 (admitted 10, 25, 50). This read has no `page`
  parameter: it publishes the first page in ascending entry id order and
  `total_entries` tells whether the catalog was truncated, so the search is what
  narrows a long catalog.

### Variants the supplier offers (the ingress picker)

`GET /api/suppliers/{id}/catalog?kind=&search=` answers the **variants** of the entries
that supplier offers, using the typed catalog identity the whole warehouse already
reads:

```json
{ "items": [
    { "variant_id": 9, "kind": "battery", "name": "CAR · N120", "detail": "120 Ah · L",
      "battery": { "brand": "CAR", "model": "N120", "capacity_ah": "120", "polarity": "L" },
      "fields": null, "catalog_entry_id": 5 },
    { "variant_id": 227, "kind": "other", "name": "Agua acidulada",
      "detail": "Agua acidulada", "battery": null, "fields": [], "catalog_entry_id": 113 } ],
  "page_size": 500 }
```

One offered battery entry expands to **every** one of its polarities, because the
assignment is entry level while the ingress document names variants. A product entry
expands to its single polarity-less variant and keeps its typed `fields`. There is no
stock number on this shape at all, and no variant of an entry the supplier does not
offer ever appears.

The read is bounded to 500 variants, which is more than the largest set a supplier may
offer (200 entries × at most two polarities), so the picker never hides a variant a
document could legally name; `page_size` states that bound. `kind` and `search` behave
like the assignable catalog above. A retired supplier fills no picker (`409
conflict`), because it can no longer supply; its own detail read still shows its frozen
offer set.

## Limits

All of them are enforced by the server; the form is never the authority.

- Name: 3-64 bytes after trimming, no control character, unique among **active**
  suppliers ignoring case. The column's own check counts characters, so the byte bound
  is the stricter of the two and nothing the API accepts is refused by the database. A
  retired name is free again; the retired row keeps its own.
- Contact: free text, 0-200 characters, never trimmed, no control character.
- Offer set: at most 200 catalog entries; each entry id is a positive catalog identity
  and must be an active entry.

## Errors

| Status | Code | Cause |
| --- | --- | --- |
| `400` | `invalid_request` | A malformed or unknown key, a wrong content type, a query string on a write, a bad id, an out-of-bounds name or contact, or an unknown/retired catalog entry in an assignment |
| `401` | `unauthenticated` | No session |
| `403` | `forbidden` | Not the warehouse administrator, a pending password change, or a bad origin/CSRF token |
| `404` | `not_found` | Unknown supplier, or editing a retired one |
| `409` | `conflict` | A duplicate active name, a repeated retirement, an assignment to a retired supplier, or the ingress picker of a retired supplier |
| `503` | `service_unavailable` | The store is unavailable, or a persisted record this contract could not publish |

## No cost, no catalog mutation

This surface writes `suppliers` and `supplier_offers` and nothing else. It never
creates, edits or retires a catalog entry, never allocates an identity, never deletes
a supplier and never records money. Quantities belong to the ingress document, which
is the only place a receipt is written.
