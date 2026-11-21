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

- **T1** Migración 059: `suppliers`, `supplier_offers`, `stock_entries.supplier_id` y las guardas `LS009`–`LS012` (trigger nuevo, sin redefinir `admit_stock_entry`); test de estructura; allow-list de tablas del test de bootstrap. **Parent inline.** Commit `5bd60e4`.
- **T2** Go: paquete `internal/suppliers` (alta, edición, retiro, asignación reemplazable, lecturas de entradas asignables y de variantes ofrecidas) + `internal/httpapi/suppliers.go` + `apps/api/docs/suppliers.md` + tests. **Worker.** Commit `7f1c11c`.
- **T3** Go: ingreso con proveedor (validación de carga, `supplier` en la clave canónica, tres lecturas, herencia en el contra-asiento) + `apps/api/docs/stock-entries.md` + tests. **Worker.** Commit `25d7215`.
- **T4** Web: tab Proveedores + pantalla (alta, edición, retiro, editor de asignación) + API/model + tests. **Worker.** Commit `03d5670`.
- **T5** Web: Ingresos proveedor-primero (selector, tipos disponibles, catálogo filtrado, historial con proveedor) + tests. **Worker.** Commit `17a21f9`.
- **T6** Verificación completa, barrido de docs y cierre de la vertical. **Parent inline.** Commit `docs(odd): close the suppliers vertical`.
- **T7** Web: implementar el diseño elegido para Ingresos (dos colecciones acotadas: catálogo agrupado por marca y documento con scroll propio, ambos con cabecera y pie fijos). **Worker.** Evidencia de diseño en `design/ingresos-proveedor/`. Commit `feat(web): bounded grouped ingress`.

## Delivery
La vertical es grande por naturaleza (esquema + dos fronteras + dos pantallas), así que se entrega en cortes por área, cada uno con sus tests al lado del comportamiento:

- corte 1 `5bd60e4` — esquema 059, guardas y allow-list del fixture (227 líneas).
- corte 2 `48d9146` — este documento.
- corte 3 `03d5670` — pantalla Proveedores (web, con sus tres suites).
- corte 4 `17a21f9` — Ingresos proveedor-primero (web, con sus suites).
- corte 5 `7f1c11c` — API de proveedores (Go, T2).
- corte 6 `25d7215` — ingreso con proveedor (Go, T3).
- corte 7 `e740a4f`, `f94c524`, `77fb3c0` — pruebas vivas contra el ambiente ficticio y la corrección del tamaño de página del catálogo (el cliente pedía 200 contra los 500 publicados).
- corte 8 `3a3ca8e`, `153cc06` — dirección de diseño de Ingresos y acotado de las dos columnas.
- corte 9 `fdcfbac` — implementación del diseño elegido en la app real (T7).

Los cortes 3 y 4 superan el ideal de ~400 líneas porque son pantallas completas con su evidencia; no se parten por archivo. La revisión de esta vertical, si se pide, se hace por corte y no como un candidato único: la memoria del repo registra que un candidato de este tamaño excede el presupuesto del revisor.

## Entregado

`feat/suppliers-and-ingress` (12 cortes desde `ea58654`) integrada en `master` con el merge `85d03ff` y publicada, rama incluida. **T6 y T7 cerradas.**

CI del merge: run `44796279350`. El primer intento salió rojo en dos tests **ajenos a la vertical** y sensibles a latencia — `internal/realtime TestR03BrokerPostgres` y `src/TransferPending.test.tsx` C4b — y quedó **verde en los tres jobs** al re-ejecutar los fallidos. Lectura registrada sin maquillar: esta vertical duplicó el peso de la suite y esos dos tests son frágiles bajo carga; es deuda del repo, no daño de esta entrega, y el próximo que los vea rojos no debería culpar al cambio que tenga adelante.

## Log

**L1** (pedido, textual) — "En alamcen tenemos lo que son ingresos bien entonces quiero crear una nueva seccion que sea proveedores, donde puedo crear un provedor y asignarle que productos del catogo ofrece ese proveedor. luego en ingresos quiero que primero se deba elegir proveedor y luego recien seleccionar que productos de ese proveedor estan ingresando!, vas cachando mi idea? explora y dime si entiendes"

**L2** (decisiones del humano, textuales) — "A la entrada: marca/modelo o nombre"; "No: solo trazabilidad por ahora"; "No aparece: primero hay que asignarlo"; "Sí, siempre en ingresos nuevos".

**L3** Evidencia previa (exploración, no invención): no existe entidad proveedor en ningún lado (`032_purchases.sql:39-41`, `docs/purchases.md:13`); `stock_entries` no lleva origen ni costo (`021_stock_entries.sql:8-32`); el único precedente de tabla asociativa por **entrada** es `branch_prices` (`026_branch_prices_by_battery.sql:20`); el selector de Ingresos consulta `/api/inventory` con `kind`+`search` (`StockEntry.tsx:97-120`).

**L4** Evidencia de los cortes: `migrations` + `internal/bootstrap` verdes en fixture limpio (la 059 aplica de cero); `internal/suppliers` 3,2 s y `internal/httpapi` 205,9 s; `internal/stockentries` 22,8 s y `internal/httpapi` 221 s; web 4469 pasan / 0 fallan / 1 skip, `tsc` limpio, `vite build` ok.

**L5** Desvíos y reglas derivadas, decididos al implementar y documentados en `apps/api/docs/suppliers.md`:
- La entrada asignable **no emite `polarity`**: la polaridad es de la variante, y la asignación es proveedor↔entrada (S2). El cliente web tolera su ausencia y la recibe dentro de la identidad de la variante.
- `GET /api/suppliers/{id}/catalog` de un proveedor retirado responde `409 conflict` (ya no puede llenar el selector de Ingresos); `PATCH` de un retirado responde `404 not_found` (salió de la lista editable), siguiendo la convención de las otras pantallas de administración.
- `kind=all` se rechaza: la ausencia de `kind` ya significa ambos tipos. La lectura de variantes ofrecidas se topa en 500 (≥200 entradas × 2 polaridades) y la de entradas asignables admite `page_size` 10/25/50.
- El lint no vuelve a un baseline de 227: el árbol limpio real trae 274 y las pantallas nuevas repiten los mismos patrones que `CatalogOtherProducts.tsx`, `CatalogBatteries.tsx` y `StockAdjustment.tsx`. Igualar el estilo existente es la decisión; cambiarlo es otra vertical.

**L6** Prueba en vivo (autorizada por el humano para el ambiente ficticio): la API arrancó con el código de la vertical contra `luson-dev-db` y la migración **059 se aplicó en el arranque** (`max(version)=59`). `GET /` 200 (SPA servida), `GET /api/auth/session` 200, y `GET /api/suppliers`, `GET /api/suppliers/catalog` y `GET /api/stock-entries` responden **401** sin sesión — las rutas existen y están detrás del gate, no 404 ni 500.

Nota de ambiente (no es código): el DSN de `~/.local/share/luson-dev/database_url` tenía una credencial vieja y `~/.local/share/luson-local/database_url` apuntaba al contenedor detenido (`:5433`, dataset anterior). Se reseteó la clave del usuario `luson` **dentro** del contenedor y se reescribió el archivo `0600`; el server corre con `LUSON_DATABASE_URL_FILE` apuntando ahí. Si el contenedor se **recrea**, vuelve a tomar la clave vieja de su variable de entorno y ese archivo deja de autenticar. El click-through en el navegador queda del humano, igual que en las verticales anteriores.

**L7** (bug reportado por el humano en la primera prueba en vivo) «he creado este proveedor batevol ahi me sale reintentar catalogo porque? si ya le asigne baterias a ese proveedor».

Diagnóstico reproducido en fixture, no deducido: `GET /api/suppliers/{id}/catalog` devolvía **200** con la forma congelada, `page_size: 500` y 66 variantes para 33 entradas ofrecidas. El decoder web tenía `stockSupplierMaxCatalogPageSize = 200` — el tope de **entradas ofrecidas** — aplicado al tope de **variantes leídas**, así que rechazaba *toda* respuesta real (con cero filas también) con `invalid_response`, y la pantalla lo mostraba como "no se pudo consultar el catálogo del proveedor". El volumen no era la causa: era el sobre de la respuesta.

Se corrigió **solo el lado equivocado**: el cliente, a 500, con el número publicado en `apps/api/docs/suppliers.md`. Se fijó con el cuerpo real capturado (33 entradas → 66 variantes, ids 194–259) y un rechazo de `page_size: 501`; el server no cambió y se le agregó un test de volumen con identidad de almacén. Commit `fix(web): accept the published supplier catalogue page size`.

**L8** (pedido, textual) «bien bien, funciona pero ahora necesito que explores bien el frontent en esta seccion de ingresos, siento que la UI UX no esta bien hecha, levantemos un gentle design y dame opciones».

Diagnóstico de los seis defectos de la pantalla en vivo (tres franjas antes de la primera acción; el control de tipo desapareció y dejó sus explicaciones; 33 productos mostrados como 66 filas por listar variantes; una tabla que es un menú; Confirmar habilitado con cero líneas y lejos del trabajo; jerga interna) y tres direcciones estructurales en `design/ingresos-proveedor/` (proveedor como contexto · documento como remito · carga por teclado). El sistema de diseño se resincronizó desde las 16 hojas reales.

**L9** (comentarios del humano sobre el canvas, textuales) «tengo un problema con todos los mockups que me diseniaste, esta seccion puede crecer mucho, un provedor puede tener 20 o mas productos, entonces se hace muy pequenia!, Necesito alternatvias» y «esto igual debe tener su propio scroll no? puede crecer mucho»; elección: «F+H pa»; y autorización: «belleza arranca ya pero implementarlo en el real no? que opinas?».

Decisión estructural: **las dos colecciones de la pantalla son acotadas** — el catálogo (grupos por marca, buscador y contador fijos, la página no crece) y el documento (cabecera, líneas y pie de totales fijos). Aplicado a los tres tableros con estados de 22 líneas/60 unidades y verificado en Chromium con 7/22/40/60+ líneas. Costo aceptado: el historial sale del viewport principal en dos tableros. Implementación en la app: T7.

**L10** (evidencia del diseño) — el pedido está en L8 y la decisión en L9; esta entrada registra la salida.

Salida: `design/ingresos-proveedor/` con tres direcciones de diseño, no implementación, para el click-through en vivo del humano. `01-proveedor-contexto.html` (proveedor como contexto en el encabezado del documento; tradeoff: mínimo desperdicio vertical y ninguna fila duplicada, pero la polaridad se lee como control de la fila); `02-documento-remito.html` (encabezado tipo remito y el documento al centro; tradeoff: se lee como el papel que llega, pero explorar el catálogo pasa a segundo plano); `03-carga-por-teclado.html` (búsqueda primero y una tecla por polaridad; tradeoff: la más rápida para 20+ líneas, pero exige aprender atajos). Las tres modelan el paso de proveedor, la regla de tipo solo cuando importa, el catálogo agrupado por producto con un único conteo, el documento con totales reales (3 líneas, 7 unidades), la confirmación con su lógica de deshabilitado y el historial con el documento `#1` sin proveedor, más los estados vacío, con líneas, proveedor de dos tipos, proveedor sin productos y pantalla angosta. Antes de dibujarlas se re-sincronizó el sistema visual del proyecto a `design/system.md` y `design/system.html` desde los 16 CSS de `apps/web/src` (69 representaciones de color, sin valores inventados).

**L11** (reinicio del humano) «continuamos pa, he reiniciado mi PC». Tras el reinicio se volvió a levantar el ambiente: `luson-dev-db` arriba en `127.0.0.1:55432`, API en `127.0.0.1:8080` sirviendo `index-BCbL6-Zi.js`, `GET /` 200 y `GET /api/auth/session` 200. La vertical queda entregada; lo que sigue es decisión del humano y no deuda: contador de rango visible en el catálogo, y las verticales siguientes (costo por línea, orden de compra, cuenta corriente).
