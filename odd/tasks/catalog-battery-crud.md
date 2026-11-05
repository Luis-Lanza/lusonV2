# Catalog battery CRUD

Vertical: create, edit and archive batteries inside the catalog, turning the database into
the catalog authority while the embedded fixture becomes an initial seed only.
High risk: migration of a protected dataset, append-only evidence, and shared read paths.

## Specs

S1. Desde el catálogo se pueden **crear nuevas baterías**, editarlas y archivarlas; el
    pedido literal es "dentro de catalogo, se puedan crear nuevas baterias, archivar
    baterias, eliminar, editar".

S2. "eliminar" es archivar: soft delete irreversible, sin borrado físico de una batería con
    historia. Ventas, transferencias, ingresos y ajustes pasados siguen mostrando el
    producto. Decisión textual: "Solo archivar: \"eliminar\" es archivar".

S3. La base de datos es la autoridad del catálogo; el fixture embebido queda como semilla
    inicial. Decisión textual: "Sí: la DB pasa a ser la autoridad del catálogo".

S4. Archivar se **bloquea** si la batería tiene stock o movimientos pendientes, con la misma
    forma de respuesta que el retiro de sucursal. Decisión textual: "Bloquear si tiene stock
    o movimientos pendientes".

S5. Solo el administrador de almacén (cuenta con location 1) puede crear, editar y archivar.
    Decisión textual: "Administrador de almacén (location 1)".

## Tasks

| ID | Spec | Route | Commit |
| --- | --- | --- | --- |
| T1 | S2-S3 | inline | pending |
| T2 | S3 | inline | pending |
| T3 | S1-S3 | inline | pending |
| T4 | S2-S4 | inline | pending |
| T5 | S1,S5 | inline | pending |
| T6 | S1-S2 | inline | pending |
| T7 | S1-S5 | inline | pending |

## Log

L1 (usuario, verbatim): "bien, la siguiente vertical es que dentro de catalogo, se puedan
crear nuevas baterias, archivar baterias, eliminar, editar, etc

es decir el crud completo, cachai?"

L2 (usuario, decisión verbatim): "Sí: la DB pasa a ser la autoridad del catálogo" — migración
028+, drop del trigger `protect_preloaded_catalog`, drop de los CHECK de rango de id,
secuencias para entries y variants, `seed.go` como semilla, `catalog.Load()` sin la verdad
95/101/SHA, y fallback de `cells` para baterías nuevas.

L3 (usuario, decisión verbatim): "Solo archivar: \"eliminar\" es archivar" — columna
`deleted_at` siguiendo el patrón de `017_admin_soft_delete.sql`.

L4 (usuario, decisión verbatim): "Bloquear si tiene stock o movimientos pendientes" —
409 `catalog_battery_has_stock` / `catalog_battery_has_pending`, patrón `RetireBranch`.

L5 (usuario, decisión verbatim): "Administrador de almacén (location 1)" — mismo gate que
`/api/administration`.

L6 (usuario, contexto de sesión): "bien! creo que estamos preparados para la siguiente
vertical no!, antes me guistaria levantar el proyecto en local" — el entorno local quedó
levantado (Postgres en contenedor `luson-dev-db`, API `local-trial` HTTP en
`127.0.0.1:8080`, 3 cuentas provisionadas) antes de empezar esta vertical.

L7 (evidencia, exploración read-only): el catálogo hoy es inmutable por construcción —
`001_data_foundation.sql:44-62` trigger `protect_preloaded_catalog` (INSERT/UPDATE/DELETE
prohibidos tras el seed), `:64-82` bloqueo de TRUNCATE, caps `id BETWEEN 1 AND 95` y
`1 AND 190` (`001:11,20`), ids nunca generados (`bootstrap/seed.go:63-70`, variante =
`(entry.ID-1)*2+i+1` en `catalog/catalog.go`), `catalog.Decode` exige 95 entries / 101
triplets / SHA, `bootstrap/seed.go:121` hardcodea 95/190, y `pricing` resuelve `cells` del
fixture por id. Fan-out: `initialize_branch_inventory` (014:67-75, 015) crea balances
copiando todos los variants al crear la sucursal, y `021:86`, `022:78`, `025:128` exigen la
fila de balance para operar. Append-only con FK hacia `catalog_variants`: `sale_lines`
(025:85), `transfer_request_items` (003:29), `transfer_receipt_lines` (008:28),
`stock_entry_lines` (021:29), `stock_adjustment_lines` (022:34), `transfer_recovery_events`
(020:13), `variant_warranties` (024:16); `transfer_personal_activity.variant_id` (016:15) sin
FK a propósito. Ningún read path filtra activo/archivado hoy.
