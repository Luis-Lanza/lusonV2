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
| T1 | S2-S3 | inline (parent) | `fb6eb9c` |
| T2 | S3 | worker `gentle-ai-worker` | `5d41e66` |
| T3 | S1-S3 | worker `gentle-ai-worker` | `bccd62c` |
| T4 | S2-S3 | worker `gentle-ai-worker` | `8714c0b` |
| T5 | S1,S5 | worker `gentle-ai-worker` | `bccd62c` |
| T6 | S1-S2 | worker `gentle-ai-worker` | `cce22cf` |
| T7 | S1-S5 | inline (parent) | pending |

Task rules agreed before implementation:

- T1 done: `028_catalog_operational_authority.sql` adds `deleted_at`, allocated ids past the
  fixture (sequences 96/191), the retirement blocker (stock / open transfers), a one-way
  retirement guard, a deletion-forbidden guard, an active-only `(brand, model)` unique index,
  and the variant-to-active-branch balance fan-out. Static assertions plus live RED/GREEN
  against the local database; `migrate check` still passes on the seeded dataset.
- T2: `bootstrap.Check` keeps proving the seeded fixture is intact (metadata sha, the 95
  entries and 190 variants with their exact values, one balance per active location for every
  seeded variant) while tolerating operational batteries past the fixture and archived
  fixture rows. `Seed` stays one-shot and must not fail on a database that already holds
  operational batteries.
- T4: only *selection* paths filter `deleted_at IS NULL` (inventory listing, sellable catalog,
  price matrix, stock-adjustment catalog, transfer availability). *History* paths never filter
  (sale detail, stock entry detail, request items), because archived batteries must stay
  visible in past evidence. `pricing` must stop returning `service_unavailable` for a battery
  that has no fixture cells: cells become optional. The SPA bounds that hardcode 95/190 must
  stop rejecting allocated identities.

Delivery strategy: one commit per task on `feat/catalog-battery-crud`. The 400-line
slice was crossed at T4 (661 authored lines across T1 and T4) and again at T3/T5
(2455 lines across seven commits); remaining tasks keep their own commit so each is
reviewable alone. Each slice is reviewed natively as its own candidate, never as the
accumulated branch.

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

L7 (evidencia, exploración read-only): el catálogo hoy es inmutable por construcción —`001_data_foundation.sql:44-62` trigger `protect_preloaded_catalog` (INSERT/UPDATE/DELETE
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

L8 (review nativo, tres líneas + hallazgos leídos del store del provider): las líneas
`review-b79e73483e89a274`, `review-8e2a8b459dd12d01` y `review-9c17189a7f73948d` cerraron las
tres en `correction_required`. El texto de los findings se leyó de
`.git/gentle-ai/review-transactions/v2/<lineage>/review-state.json` (evidencia almacenada por
el provider), no de STATUS: el facade no expone findings y su `status` no acepta
`baseRef`/`committedOnly`, así que la ruta de corrección queda inalcanzable cuando el worktree
coincide con HEAD. Hallazgos: **R4-001 CRITICAL** (carrera entre la creación de sucursal y de
batería: cada fan-out lee el snapshot del otro y la fila de `inventory_balances` faltante es
permanente, invisible para el verificador), R3-002 (misma carrera, lente reliability), R3-003
(el guard de variants aceptaba INSERT en una batería archivada), R3-001 (inferencial:
`observe` parseaba capacidad de entradas operativas), R4-002 (`observe` cargaba toda la matriz
de balances en memoria). Lente risk: 0 findings.

L9 (corrección, commits 60214d1 y el de 029): `60214d1` probó que una batería editada sigue
siendo verificable (S1 vs T2). `029_catalog_fanout_serialization.sql` serializa ambos fan-outs
con el advisory lock de inicialización (21485914531180593) y prohíbe que una batería archivada
gane variants; `observe` se acota a los ids del fixture. RED/GREEN del CRITICAL reproducido a
mano con dos sesiones intercaladas: `missing=1` antes, `missing=0` después; variant en batería
archivada rechazado con `catalog_variant_retired_battery`; tras limpiar las sondas vuelven
entries=95, variants=190, balances=570, locations=3 y `migrate check` sigue en verde.

L10 (T3/T5, commit `bccd62c`): API del administrador de almacén. `POST /api/catalog/batteries`
crea entrada y variantes en una transacción, con ids asignados por la base y una fila de
balance en cero por sucursal activa (probado en vivo: entry 113, variants 212/213, tres filas
`0|0` cada una). `PATCH` exige la identidad completa; `DELETE` archiva, con `409
catalog_battery_has_stock` / `409 catalog_battery_has_pending` y repetición idempotente. Gate
idéntico a `/api/admin/branches` (401/403 byte a byte). Diferencial contra el binario previo:
todas las rutas preexistentes iguales. Doc nueva: `apps/api/docs/catalog-batteries.md`.

L11 (T6, commit `cce22cf`): pantalla «Baterías» junto a Precios, misma sección y mismo gate;
crear/escribir-una-vez y re-leer, editar identidad completa, archivar confirmado con los tres
409 como mensajes propios, y una batería con `priced_branches: 0` marcada «No vendible · sin
precio» con la instrucción de ponerle precio. 128 tests nuevos, ninguno existente modificado.

L12 (T7, verificación final): suite web 3205 passed | 1 skipped (el seam opt-in, preexistente);
`tsc --noEmit`, `npm run lint` y `npm run build` limpios; en Go `gofmt -l` sin salida,
`go build ./...` y `go vet ./...` limpios. API reiniciada sobre el código final: `POST` y
`DELETE /api/catalog/batteries` responden 401 (ruta montada y con gate) en vez del 404 previo,
y el SPA sirve el bundle nuevo. Veredicto por spec: S1 ✅ (API probada en vivo, UI cubierta por
tests; falta el click-through real en navegador, que requiere las credenciales del usuario),
S2 ✅ (archivo de una vía, idempotente, historia intacta), S3 ✅ (`migrate check` verde con
catálogo sembrado, con baterías operativas y con una batería editada), S4 ✅ (ambos 409 y su
resolución probados en vivo), S5 ✅ (401/403 iguales a administración, y un test de UI prueba
que una identidad de sucursal no alcanza ninguna superficie de catálogo).

L13 (gaps declarados, no tapados): las suites Go con PostgreSQL no se ejecutan en este entorno
(`testpg.Open` falla cerrado sin el fixture `LUSON_TEST_PG_MANIFEST`), así que los tests de
esquema y de store existen pero no corrieron acá; el click-through en navegador queda para el
usuario; y los cinco findings advisory del review aprobado (`seed.go:205`, `seed.go:252`,
`catalog_fanout_serialization_schema_test.go:27-29`, `inventory.go:117`, `029:13`) quedan como
trabajo posterior.

L14 (smoke manual, reportado por el usuario): el usuario completó el recorrido manual completo
sobre el entorno local (`localhost:8080`, base de trial con 3 cuentas) y lo reporta conforme.
Cobertura del recorrido, según lo observado en la sesión: login del administrador de almacén por
`localhost` (el origen `127.0.0.1` se rechaza con 403 por el guard de origen, comportamiento
correcto y esperado), intento de archivar la batería sembrada `CARGO NS40ZL` con stock en los
tres locales, que devolvió `409 catalog_battery_has_stock` como exige S4, y el resto de los pasos
del recorrido (alta, estado no vendible, permisos por sucursal) cerrado por el usuario.

Carácter de esta evidencia: aceptación manual **reportada por el usuario**, no verificada de forma
independiente en esta sesión. Vale como cierre del smoke de S1, no como garantía para cambios
futuros ni como sustituto de las suites Go con PostgreSQL, que siguen sin ejecutarse en este
entorno.
