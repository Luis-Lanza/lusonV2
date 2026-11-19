# Proveedores e ingreso con proveedor

Rama `feat/suppliers-and-ingress`, cortada de `master` `ea58654`. Migración nueva: `059`.
Una sección **Proveedores** en Almacén (alta, edición, retiro y lista de productos que ofrece) y **Ingresos** pasa a exigir proveedor primero y a ofrecer solo los productos de ese proveedor.

## Specs

**S1 — Sección Proveedores, autoridad de almacén.**
Existe una sección Proveedores dentro de Catálogo (Almacén), en `#/catalogo/proveedores`, con el mismo gate que el resto del catálogo y que Ingresos: solo la cuenta administradora de almacén (cuenta 1, locación 1, sin cambio de contraseña pendiente). Cualquier otra identidad recibe `403 forbidden`; sin sesión `401 unauthenticated`. Mutaciones con CSRF y mismo origen; query string en escritura `400`.

**S2 — El proveedor ofrece productos del catálogo, a nivel entrada.**
"asignarle que productos del catogo ofrece ese proveedor": la asignación es N:M entre proveedor y **entrada** de catálogo (`catalog_entries`), no entre proveedor y variante. Para una batería la entrada es marca + modelo (`Willard 12N24`); para otro producto es su nombre (`Agua acidulada`). El ingreso sigue nombrando **variantes**; la entrada asignada expande a todas sus variantes.
Asignar reemplaza el conjunto completo del proveedor (no hay merge parcial): el cuerpo de la escritura es la lista final. Una asignación nunca borra historia de documentos.

**S3 — Ciclo de vida del proveedor.**
Se crea, se edita (nombre y contacto) y se **retira**; nunca hay borrado físico ni reutilización de un id retirado como si estuviera activo. Nombre: 3–64 caracteres, sin espacios en los extremos, sin caracteres de control, único entre proveedores **activos** sin distinguir mayúsculas. Contacto: texto libre 0–200 caracteres, sin caracteres de control. Un proveedor retirado no puede ganar asignaciones nuevas y no aparece para elegir en Ingresos.

**S4 — Ingresos exige proveedor primero.**
"en ingresos quiero que primero se deba elegir proveedor y luego recien seleccionar que productos de ese proveedor estan ingresando". Los ingresos **nuevos** exigen proveedor: sin proveedor no se guarda (`400 invalid_request`). Los documentos históricos, sin proveedor, se siguen leyendo, listando y anulando exactamente igual; el proveedor es nulo en ellos, nunca inventado.

**S5 — El filtro es una regla del servidor, no de la pantalla.**
Un producto que el proveedor elegido no ofrece **no aparece** en el selector de Ingresos y, si llegara por otro camino, el documento se rechaza: toda línea de un ingreso nuevo debe pertenecer a una entrada asignada a ese proveedor (`400 invalid_request`). No hay excepción ni auto-asignación. Un proveedor sin productos asignados no permite ingresar nada y lo dice.

**S6 — Sin costo.**
Esta vertical registra proveedor, producto y cantidad. No agrega precio, costo, remito, factura, orden de compra ni cuenta corriente. El costo queda para otra vertical.

**S7 — El proveedor viaja con el documento.**
La respuesta de creación, cada fila del historial y el detalle exponen el proveedor (id y nombre). Un contra-asiento lleva **el mismo** proveedor que su original; la anulación no pide proveedor al cliente, lo hereda.

**S8 — Idempotencia intacta.**
`operation_key` sigue serializando el alta. El proveedor forma parte de la carga canónica: el mismo `operation_key` con otro proveedor es `409 retry_conflict`, nunca un segundo documento.

**S9 — Errores y SQLSTATE.**
El wire conserva los códigos existentes (`400 invalid_request`, `401 unauthenticated`, `403 forbidden`, `404 not_found`, `409 decision_conflict`, `409 retry_conflict`, `409 insufficient_stock`, `503 service_unavailable`). Nuevos SQLSTATE de base, cada uno con un único significado:
`LS009` ingreso sin proveedor → `400`; `LS010` proveedor desconocido o retirado → `409 decision_conflict`; `LS011` línea no ofrecida por el proveedor → `400`; `LS012` contra-asiento con proveedor distinto del original → `400`.

## Contract

Frozen before implementation. Warehouse admin only, JSON only, no query string on writes.

**`GET /api/suppliers?page=&page_size=`**
`{suppliers:[{id,name,contact,retired:bool,kinds:["battery","other"],offers:int}],page,page_size,total_suppliers}`
Activos primero por nombre; los retirados se listan al final, marcados.

**`POST /api/suppliers`** `{name,contact}` → `201 {id,name,contact}`

**`PATCH /api/suppliers/{id}`** `{name,contact}` → `200 {id,name,contact}`
Renombrar a un nombre activo existente → `409 conflict`.

**`DELETE /api/suppliers/{id}`** → `204` (retiro de una sola vía). Un id ya retirado → `409 conflict`.

**`GET /api/suppliers/{id}`**
`{id,name,contact,retired,offers:[{catalog_entry_id,kind,brand?,model?,capacity_ah?,polarity?,name?}],kinds:["battery","other"]}`

**`PUT /api/suppliers/{id}/offers`** `{catalog_entry_ids:[1,2,3]}` → `200` con el mismo cuerpo que `GET /api/suppliers/{id}`
Conjunto final; lista vacía = sin productos. Id de entrada inexistente o retirada → `400 invalid_request`. Proveedor retirado → `409 conflict`.

**`GET /api/suppliers/catalog?kind=&search=&page_size=`** — entradas asignables
`{entries:[{catalog_entry_id,kind,brand?,model?,capacity_ah?,polarity?,name?}],page_size,total_entries}`
Solo entradas activas; `kind` opcional (`battery`|`other`), `search` opcional sobre marca/modelo/nombre.

**`GET /api/suppliers/{id}/catalog?kind=&search=`** — variantes que ofrece ese proveedor, para el selector de Ingresos
`{items:[{variant_id,catalog_entry_id,kind,name,detail,battery?,fields?}],page_size}` — la identidad tipada que ya usa el almacén (`catalog.Identity`), sin números de stock.

**`POST /api/stock-entries`** `{operation_key, supplier_id, note?, lines:[{variant_id,quantity}]}` → `201`
`supplier_id` obligatorio y positivo. La respuesta suma `supplier:{id,name}`.

**`GET /api/stock-entries`** — cada fila suma `supplier:{id,name}|null`.

**`GET /api/stock-entries/{id}`** — suma `supplier:{id,name}|null`; el contra-asiento repite el del original.

## Tasks

- **T1** Migración 059: `suppliers`, `supplier_offers`, `stock_entries.supplier_id` y las guardas `LS009`–`LS012` (trigger nuevo, sin redefinir `admit_stock_entry`); test de estructura; allow-list de tablas del test de bootstrap. **Parent inline.** Commit `feat(api): suppliers schema and ingress supplier guard`.
- **T2** Go: paquete `internal/suppliers` (alta, edición, retiro, asignación reemplazable, lecturas de entradas asignables y de variantes ofrecidas) + `internal/httpapi/suppliers.go` + `apps/api/docs/suppliers.md` + tests. **Worker.** Commit `feat(api): suppliers administration`.
- **T3** Go: ingreso con proveedor (validación de carga, `supplier` en la clave canónica, tres lecturas, herencia en el contra-asiento) + `apps/api/docs/stock-entries.md` + tests. **Worker.** Commit `feat(api): ingress requires an offered supplier`.
- **T4** Web: tab Proveedores + pantalla (alta, edición, retiro, editor de asignación) + API/model + tests. **Worker.** Commit `feat(web): suppliers section`.
- **T5** Web: Ingresos proveedor-primero (selector, tipos disponibles, catálogo filtrado, historial con proveedor) + tests. **Worker.** Commit `feat(web): ingress chooses a supplier first`.
- **T6** Verificación completa, barrido de docs y cierre de la vertical. **Parent inline.**

## Log

**L1** (pedido, textual) — "En alamcen tenemos lo que son ingresos bien entonces quiero crear una nueva seccion que sea proveedores, donde puedo crear un provedor y asignarle que productos del catogo ofrece ese proveedor. luego en ingresos quiero que primero se deba elegir proveedor y luego recien seleccionar que productos de ese proveedor estan ingresando!, vas cachando mi idea? explora y dime si entiendes"

**L2** (decisiones del humano, textuales) — "A la entrada: marca/modelo o nombre"; "No: solo trazabilidad por ahora"; "No aparece: primero hay que asignarlo"; "Sí, siempre en ingresos nuevos".

**L3** Evidencia previa (exploración, no invención): no existe entidad proveedor en ningún lado (`032_purchases.sql:39-41`, `docs/purchases.md:13`); `stock_entries` no lleva origen ni costo (`021_stock_entries.sql:8-32`); el único precedente de tabla asociativa por **entrada** es `branch_prices` (`026_branch_prices_by_battery.sql:20`); el selector de Ingresos consulta `/api/inventory` con `kind`+`search` (`StockEntry.tsx:97-120`).
