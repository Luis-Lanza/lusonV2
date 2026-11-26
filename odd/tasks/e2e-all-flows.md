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
T6 — Rendiciones (S2): almacén y sucursal, sobre Sucursal B, porque una rendición abierta congela la sucursal. Commit `test(e2e): closings`.
T7 — Métricas (S2): corte por período. Commit `test(e2e): metrics`.
T8 — Transferencias (S2): el ciclo completo y la conciliación. Commit `test(e2e): transfers`.
T9 — Ingresos (S2): registro, detalle, reverso. Commit `test(e2e): warehouse entries`.
T10 — Catálogo (S2): precios, baterías, otros productos, proveedores. Commit `test(e2e): catalog`.
T11 — Administración y contraseña (S2): cuentas, contraseña temporal, alta/baja de sucursal, saldos, fondos, mi contraseña. Commit `test(e2e): administration`.
T12 — Ajuste del almacén (S2): el mismo acto desde el Almacén, con su propia ubicación. Commit `test(e2e): warehouse adjustment`.
T13 — Cierre (S2, S3, S4, S5, S6): corrida completa, segunda corrida, `git status` limpio, informe de qué afirma cada spec. Commit `test(e2e): record the full-suite result`.

## Log

L1. User: "bien pa, entonces puedes levantarlo en local para que lo revise,"

L2. User: "y tu tambien quiero que hagas test en e2e de todos los flujos, TODOS, en playwrigth"

L3. Exploración (L1, L2): la app se levanta con `LUSON_PROFILE=local-trial`, `LUSON_ORIGIN` y `LUSON_LISTEN` en loopback, `LUSON_WEB_DIR=apps/web/dist`; la base local `luson-local-db` estaba en la migración 75 y `go -C apps/api run ./cmd/migrate initialize` la dejó en la 76 con el bootstrap aplicado; la API cachea `dist` al arrancar, así que reconstruir el frontend exige reiniciarla. El arnés actual son 11 tests en 7 archivos, sin script `npm` para Playwright, y `tsconfig.e2e.json` solo incluye `e2e/warranty/**` y `e2e/adjustments/**`, así que un spec nuevo en otro directorio no pasa por el gate de tipos.
