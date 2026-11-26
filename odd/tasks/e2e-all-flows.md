# Cobertura e2e de todos los flujos

Feature: `test/e2e-all-flows` · Base: `d614c83` (master) · Risk: item 3 (`playwright.config.ts` y `tsconfig.e2e.json` los comparten los 11 specs de garantías y ajustes que el pedido no nombró)

Entrega: un spec de Playwright por cada acto que el operador puede hacer en cada pantalla del producto, corriendo contra el servidor real en `http://127.0.0.1:8080` y la base local, con un solo comando que corre la suite completa. Un commit por grupo de flujos.

Hoy el arnés cubre la vertical de garantías (8 specs) y el ajuste de sucursal (1). Todo el resto del producto —ventas, compras, caja, rendiciones, métricas, transferencias, ingresos, catálogo, administración, contraseña, ajuste del almacén— no tiene ninguna prueba de navegador. Este documento define esa cobertura, no cambia comportamiento del producto.

## Specs

S1. El servidor local para revisión. User, L1: "entonces puedes levantarlo en local para que lo revise". La aplicación responde en `http://127.0.0.1:8080` sirviendo el bundle recién construido, contra la base local en la última migración, con las tres cuentas de la semilla habilitadas (`bot_almacen`, `bot_sucursal_a`, `bot_sucursal_b`) y el `LUSON_ORIGIN` igual al origen con el que Playwright navega. Check: `GET /` devuelve el `index.html` del build actual y el proyecto `sesiones` abre las tres sesiones.

S2. Todos los flujos. User, L2: "y tu tambien quiero que hagas test en e2e de todos los flujos, TODOS, en playwrigth". Cada acto visible por el operador en cada pantalla tiene al menos un spec que lo ejecuta por la interfaz y afirma su efecto. Las pantallas y sus actos son: inventario (consultar, filtrar, paginar, ver el cambio en vivo); transferencias (solicitar, enviar, aprobar, rechazar, despachar, recibir, cancelar, conciliar); ingresos de almacén (registrar, ver, revertir); ajustes (contar a ciegas, aplicar, historial, revertir) en sucursal y en almacén; catálogo (precios, baterías, otros productos, proveedores); ventas (vender con serial y garantía, cobrar, historial, comprobante); compras (usadas y chatarra, documentos, reverso); caja (movimiento, comprobante, corrección, libro, motivos); métricas (corte por período); rendiciones (lista, detalle, conteo, materiales, efectivo, propuesta, decisión, corrección) y rendición de sucursal (comisión, gastos, propuesta, decisión); administración (cuentas, contraseña temporal, habilitar/deshabilitar, sucursales, saldos, carga de fondos); mi contraseña. Check: existe al menos un spec por acto de esa lista, todos dentro de la suite.

S3. Qué cuenta como cubierto. El spec entra por la pantalla, no por la API: llena el formulario, toca el botón y pasa por la confirmación como el operador. Afirma el efecto observable —el texto en pantalla, la fila o el documento que cambia— y lo contrasta con el valor persistido leído por la API pública de la aplicación. Check: ningún spec afirma estructura interna de la base ni escribe SQL; el arreglo previo de datos puede usar la API, la afirmación no.

S4. Aislamiento y repetibilidad. Cada spec arregla sus propios datos con seriales y documentos únicos y no depende del orden ni de otro spec. Una corrida no escribe archivos en el árbol de trabajo: trazas, capturas y sesiones van fuera del repo. Check: la suite corre dos veces seguidas en verde contra el mismo servidor y la misma base, y `git status` queda limpio después de cada corrida.

S5. La suite no necesita Docker ni PTY. Check: `npx playwright test` en `apps/web` completa todos los proyectos contra un servidor ya levantado, sin invocar `docker` ni pedir terminal interactiva.

S6. El gate de tipos cubre el arnés entero. Check: `npm --prefix apps/web run typecheck` incluye los specs nuevos y falla si uno no compila.

## Tasks

T1 — Base del arnés (S1, S5, S6): `tsconfig.e2e.json` incluye `e2e/**/*.ts`; `playwright.config.ts` suma el proyecto de flujos con sus `testMatch`; `sessions.ts` y `auth.setup.ts` abren la sesión de Sucursal B; `package.json` gana `test:e2e`. Commit `test(e2e): one base for every flow`.
T2 — Inventario (S2): consulta, filtros, paginación, cambio en vivo. Commit `test(e2e): inventory`.
T3 — Ventas (S2): venta con serial y garantía, cobro, historial, comprobante. Commit `test(e2e): sales`.
T4 — Compras (S2): usadas y chatarra, documentos, reverso. Commit `test(e2e): used purchases`.
T5 — Caja (S2): movimiento, comprobante, corrección, libro, motivos. Commit `test(e2e): drawer`.
T6 — Rendiciones (S2): almacén y sucursal, sobre **Sucursal A** porque hoy es la única que entra debajo del tope de la planilla (ver «Pendiente»); cada rendición que se abre se decide y se cierra en su propio test. Commit `test(e2e): closings`.
T7 — Métricas (S2): corte por período. Commit `test(e2e): metrics`.
T8 — Transferencias (S2): el ciclo completo y la conciliación. Commit `test(e2e): transfers`.
T9 — Ingresos (S2): registro, detalle, reverso. Commit `test(e2e): warehouse entries`.
T10 — Catálogo (S2): precios, baterías, otros productos, proveedores. Commit `test(e2e): catalog`.
T11 — Administración y contraseña (S2): cuentas, contraseña temporal, alta/baja de sucursal, saldos, fondos, mi contraseña. Commit `test(e2e): administration`.
T12 — Ajuste del almacén (S2): el mismo acto desde el Almacén, con su propia ubicación. Commit `test(e2e): warehouse adjustment`.
T13 — Cierre (S2, S3, S4, S5, S6): corrida completa, segunda corrida, `git status` limpio, informe de qué afirma cada spec. Commit `test(e2e): record the full-suite result`.

## Pendiente: migración para el tope de la planilla de rendición

Defecto confirmado en T6 y diferido por decisión del humano (`L9`): **una sucursal con más de 190 variantes con stock no puede rendir cuentas nunca**. Abrir la rendición responde `503 service_unavailable` y no hay camino alternativo en el producto.

- El tope es `MaxCountLines = 190` en `apps/api/internal/closings/closing.go:253` y se aplica al armar la planilla en `apps/api/internal/closings/store.go:2662` (`len(sheet) > MaxCountLines` → `ErrUnavailable`), dentro de la transacción de apertura.
- La planilla escribe una línea por variante con `existing > 0` de la sucursal, sin tope propio: `apps/api/migrations/043_closing_assumed_count.sql:71-82` (`seed_closing_count_lines`).
- El catálogo **ya no** está limitado a 190 variantes: `apps/api/migrations/028_catalog_operational_authority.sql:14` borra `catalog_variants_id_check` (`id BETWEEN 1 AND 190`). El tope del cierre se quedó con el número viejo.
- Medición del día: Almacén 353, Sucursal B 235 (184 baterías + 51 otros productos creados por la suite), Sucursal A 180 variantes con stock.

Qué tiene que hacer la migración cuando se encare, como feature propio y con riesgo item 1 (esquema):
1. Subir `MaxCountLines` en Go y su contraparte en la base al mismo número, o reemplazar el tope por paginación de la planilla. Un número más grande es un parche: el catálogo crece y el problema vuelve.
2. Revisar los otros dos topes que quedaron con el mismo 190 y dependen del catálogo: `MaxMaterialLines` (`closing.go:260`) y el límite de 1..190 ítems de `apps/api/migrations/003_pending_requests.sql:40`.
3. Test que abra una rendición sobre una sucursal con más de 190 variantes con stock y la cierre, hoy imposible.
4. Recién con eso, los specs de rendición pueden volver a cualquier sucursal grande y el grupo deja de depender de que Sucursal A esté debajo del tope.

## Log

L1. User: "bien pa, entonces puedes levantarlo en local para que lo revise,"

L2. User: "y tu tambien quiero que hagas test en e2e de todos los flujos, TODOS, en playwrigth"

L3. Exploración (L1, L2): la app se levanta con `LUSON_PROFILE=local-trial`, `LUSON_ORIGIN` y `LUSON_LISTEN` en loopback, `LUSON_WEB_DIR=apps/web/dist`; la base local `luson-local-db` estaba en la migración 75 y `go -C apps/api run ./cmd/migrate initialize` la dejó en la 76 con el bootstrap aplicado; la API cachea `dist` al arrancar, así que reconstruir el frontend exige reiniciarla. El arnés actual son 11 tests en 7 archivos, sin script `npm` para Playwright, y `tsconfig.e2e.json` solo incluye `e2e/warranty/**` y `e2e/adjustments/**`, así que un spec nuevo en otro directorio no pasa por el gate de tipos.

L4. Política de slices (L2): el corte de entrega es **un grupo de pantallas por commit**, no ~400 líneas. El catálogo quedó en 892 líneas entre el documento, la base y los 10 specs, porque el arnés del grupo y sus cuatro pantallas se revisan juntos o no se revisan. Cada grupo es autónomo: se puede leer, correr y revertir solo.

L5. Throttle del arnés (L2): el servidor admite diez logins por minuto por dirección y el proyecto `sesiones` firma tres por invocación, así que tres workers corriendo Playwright a la vez rozan el límite y alguno ve fallar los logins. Las corridas bajan a dos workers en paralelo; los specs de un grupo se verifican con `--no-deps` cuando las sesiones ya están abiertas.

L6. Hallazgo de producto (T9, fuera de alcance): el control de proveedor de `#/ingresos` publica **solo la primera página de 50 proveedores activos**, ordenada por `lower(name), id`, sin búsqueda ni paginación (`apps/web/src/StockEntry.tsx:153`, `stockEntryModel.ts:97`, `apps/api/internal/suppliers/store.go:256-257`). Con la base local ya en 167 proveedores, un operador cuyo proveedor ordene después del puesto 50 no puede elegirlo. No se toca en este feature: es comportamiento del producto y necesita decisión del humano.

L7. Los grupos no se commitean con el verde del worker: cada uno se corre desde el árbol del padre sobre la base ya poblada por los otros grupos. Ingresos pasó de 10 verdes reportados a 2 rojos reales en esa corrida, y el arreglo destapó además que el paginador del historial se salteaba la página 1 mientras la tabla se recargaba.

L8. Hallazgo de producto (T8, fuera de alcance): **crear una transferencia de baterías por pantalla no funciona** en el catálogo actual. `apps/web/src/sourceInventory.ts:33` lee como máximo 4 páginas de 50 filas (200 variantes) y el catálogo publica más baterías que eso, así que la pantalla de origen muestra «No se pudo actualizar el catálogo completo. Reintentá la consulta.» y deja «Revisar solicitud» deshabilitado. Los tres actos de creación del grupo se cubren con un documento de **otros productos** —mismo acto, misma regla de stock— porque el defecto es de la pantalla, no del producto. Arreglarlo es subir el tope de páginas y reconstruir el frontend: comportamiento de producto, necesita decisión del humano.

L9. Decisión del humano (T6): **la rendición se prueba sobre Sucursal A**, que hoy tiene 180 variantes con stock, y el tope de la planilla queda documentado como defecto con su migración pendiente (ver «Pendiente» arriba), no arreglado en este feature. User: "dale si dale con sucursal A pero eso debe quedar documentado que hay que hacer una migracion luego!"

