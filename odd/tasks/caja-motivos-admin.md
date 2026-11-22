# Administración del catálogo de motivos de Caja

Vertical que abre el catálogo cerrado de motivos de gasto (S6 de `caja-motivos-categorias.md`) a un
admin que crea, renombra, archiva y reactiva, y hace que las sucursales lo vean en vivo.
Diseño: pendiente (`design/<slug>/`), la ubicación de la pantalla se decide ahí.

## Specs

S1. Los motivos de un gasto de Caja son un catálogo **global y cerrado** de 11 filas sembradas por la
migración 061 (`branch_cash_categories`). Hoy sólo se cambian por migración o `UPDATE`. El desplegable
de la pantalla de Caja muestra exactamente esos motivos: no se vuelve al texto libre.

S2. Pedido del humano, verbatim: «hay que plantear como el admin puede crear estos motivos, para que
aparezcan en las sucursales en tiempo real».

S3. Decisiones del humano sobre la baja, verbatim: «Archivar, y poder reactivar después». Archivar es
`retired_at` no nulo: el motivo deja de ofrecerse y el guard de la 061 rechaza gastos nuevos con él.
El motivo archivado nunca se borra de la tabla. Reactivar es volver `retired_at` a nulo.

S4. Renombrar la etiqueta de un motivo existente está permitido. Los movimientos ya cargados conservan
la etiqueta con la que se registraron (`category_label` es copia en el movimiento, 061:96-99), así que
renombrar no reescribe la historia.

S5. Un motivo nuevo se agrega **siempre al final**: `sort_order` = máximo actual + 1. No hay pantalla
de reordenamiento.

S6. La ubicación de la pantalla de administración (solapa dentro de Almacén › Catálogo, o sección
propia) se decide en el diseño, no en este documento.

S7. Se cambia el catálogo desde la identidad de administración que ya existe (cuenta 1, ubicación 1,
sin cambio de clave pendiente); ninguna sesión de sucursal puede escribir el catálogo.

S8. Un motivo creado, renombrado, archivado o reactivado se refleja en la pantalla de Caja de las
sucursales **sin recargar la página**.

S9. Un motivo **retirado** no se puede volver a elegir en un gasto nuevo; la base lo rechaza con
`LC033` → `400 category_unknown`. Un movimiento histórico que lo usó sigue mostrando su etiqueta.

S10. Guardas de bajas: no se puede archivar el **último motivo activo** (sin ningún motivo la sucursal
no puede registrar un gasto), y «Otros gastos» queda fuera de la baja por ser el cajón de sastre.
Este último punto queda a confirmación del humano.

S11. Si el motivo que el operador tiene seleccionado en Caja se archiva mientras tipea, la pantalla no
lo borra en silencio: lo avisa y pide reelegir, igual que la rendición difiere el aviso en vivo.

S12. Las rutas públicas y el contrato de lectura de la sucursal no cambian: `GET /api/closings/cash-categories`
sigue publicando sólo activos con `{"categories":[{"id","label"}]}`.

S13. Los errores del admin son explícitos: etiqueta duplicada, motivo inexistente y motivo protegido
tienen su propio rechazo; probar cada uno y comprobar que un rechazo no deja datos cambiados.

S14. `docs/closings.md` deja de decir que la administración del catálogo no existe y documenta las
rutas admin con sus códigos.

## Contract

Admin routes (all mounted under `/api/admin/`, every one behind the existing administration identity gate —
status `403` otherwise; any other method answers `405`):

| Route | Body | Answer |
| --- | --- | --- |
| `GET /api/admin/cash-categories` | — | `200 {"categories":[category]}` ordered by `sort_order, label`, archived included |
| `POST /api/admin/cash-categories` | `{"label":string}` | `201 {"category":category}` |
| `POST /api/admin/cash-categories/{id}/rename` | `{"label":string}` | `200 {"category":category}` |
| `POST /api/admin/cash-categories/{id}/retire` | — | `200 {"category":category}` |
| `POST /api/admin/cash-categories/{id}/reactivate` | — | `200 {"category":category}` |

`category` is exactly `{"id":int,"label":string,"sort_order":int,"state":"active"|"retired","retired_at":string|null,"retired_by":string|null}`;
`retired_at` is RFC 3339 in UTC and `retired_by` is the acting account name. A create takes the next
`sort_order`; a retire stamps `retired_at = now()` and `retired_by`; a reactivate clears both.

Rejections, each with its own code and nothing written: `400 invalid_request` (label shape, unknown body
key), `404 category_unknown`, `409 duplicate_label`, `409 category_pinned` (a pinned motive is never
archived), `409 last_category` (the last active motive is never archived). The database speaks
`LC034` (a motive keeps its identity, place and pin and is never deleted), `LC035` (pinned),
`LC036` (last active) and `23505` for the unique label; the store maps them.

The public read `GET /api/closings/cash-categories` keeps its exact answer and stays available to any
session (S12).

## Tasks

| ID | Tarea | Specs | Ruta | Commit |
| --- | --- | --- | --- | --- |
| T1 | Tres direcciones de diseño en `design/caja-motivos-admin/` y elección del humano | S6 | parent | — |
| T2 | Migración 063: `pinned` y `retired_by`, guardas de archivo y trigger de realtime del catálogo | S3, S8, S9, S10 | parent | — |
| T3 | Scope `catalogue` en el broker Go, `EXCEPT` de `readRevisions`, whitelist de SSE y hooks del web | S8 | parent | — |
| T4 | Web de la sucursal: `Cash.tsx` relee la lista con el scope y avisa si le archivaron el motivo elegido | S8, S11 | parent | — |
| T5 | API admin: listar, crear, renombrar, archivar y reactivar con el gate de administración | S3, S4, S5, S7, S9, S10, S13 | worker | — |
| T6 | Pantalla de administración: solapa «Motivos de caja» del catálogo, según el artboard 01 | S6, S13 | worker | — |
| T7 | Docs: `closings.md` y el contrato del catálogo | S12, S14 | worker | — |
| T8 | Verificación independiente (privilegios nuevos y parser de scopes compartido) | todas | verify | — |

## Log

L1 — Pedido del humano, verbatim: «perfecto pa entonces ahora en caja hay [Image#1] motivos que son
las opciones que se peuden elegir no? / bien ahora hay que plantear como el admin puede crear estos
motivos, para que aparezcan en las sucursales en tiempo real. recuerdas que vimos esto en engram?».

L2 — Mapa de partida (exploración con evidencia): la tabla es global sin columna de sucursal, con
`retired_at` como única bandera y sin columnas de autoría; el guard `admit_branch_expense_category`
(061) exige motivo sólo en `gasto`, rechaza id desconocido o archivado con `LC033` y **sobrescribe la
etiqueta desde el catálogo**; la lectura `GET /api/closings/cash-categories` la sirve cualquier sesión
y sólo lista activos; `Cash.tsx` la pide al montar y **no se suscribe a realtime**; los únicos scopes
vivos son `inventory` y `transfers:<loc>`, y escribir el catálogo hoy no emite nada; no existe CRUD del
catálogo en ninguna capa.

L3 — Decisiones del humano en esta sesión: baja = archivar con reactivación; renombrar permitido con la
historia intacta; orden append-only; la ubicación de la pantalla queda para el diseño («si debe tener su
pestania propia. Diseniamos en gentle design antes de implementar de una»).

L4 — Riesgo declarado antes de escribir: item 2 (frontera de privilegios nueva en rutas de escritura de
administración) e item 3 (el parser de scopes de `broker.go` es código compartido por inventario y
transferencias, así que el cambio va con chequeo diferencial). T8 no es opcional.

L5 — Sincronización del sistema de diseño (el humano la autorizó): `design/system.md` estaba más viejo
que `apps/web/src/style.css`. Re-medido el inventario completo el 2026-11-22: **la capa de tokens no
cambió** (mismas 6 custom properties, 16 tamaños, 10 radios, 10 sombras; 69 representaciones de color),
lo único nuevo es el bloque `.cash-*` de la caja, ahora documentado en las reglas de componentes, más
el delta registrado en su propia sección. `design/system.html` no necesitó cambios porque no cambió
ningún token.

L6 — Diseño entregado en `design/caja-motivos-admin/` con tres direcciones que responden también la
ubicación pendiente (S6): `01-tabla-y-alta.html` (solapa dentro de Almacén › Catálogo), `02-maestro-detalle.html`
(sección propia «Administración») y `03-el-selector-manda.html` (dentro de Caja, con el selector real al
lado). Auto-chequeo hecho contra `design/system.md` y contra capturas reales a 1440 px: los tres tableros
usan sólo tokens del sistema y se corrigieron cuatro defectos observados en la captura —alto de tablero
que cortaba el pie en 01 y 03, y las etiquetas «Orden»/«Alcance» de 02 que se renderizaban con forma de
campo vacío—. Falta la elección del humano.

L7 — El humano eligió `design/caja-motivos-admin/01-tabla-y-alta.html` y mandó implementarlo (handoff de
diseño abierto, en progreso). La ubicación queda decidida: solapa «Motivos de caja» dentro de Almacén ›
Catálogo, al lado de Baterías y Otros productos, con el gate de ubicación 1 que ya usa el catálogo.
Arranca por T2 y T3 (schema y realtime) porque T5 y T6 dependen de su contrato; el contrato de rutas
admin quedó escrito arriba para que T5 y T6 avancen en paralelo sobre superficies disjuntas.

L8 — T2 entregada: migración `063_cash_category_administration.sql` aplicada sobre la base de desarrollo
(versión 62 → 63). Guardas medidas contra datos reales, cada una en una transacción con `ROLLBACK`:
archivar la opción fijada da `LC035`; un `DELETE` da `LC034`; un `INSERT` bumpea `catalogue` a revisión 1;
y renombrar la fijada sigue permitido, porque la regla es estructural (`pinned`) y no mira la etiqueta.
Hallazgo: el guard `admit_realtime_audience` de la 015 rechaza a propósito todo scope global insertado
por DML (así `inventory` sólo existe por su migración), así que el seed del contador nuevo corre con el
trigger apagado y la función se restata sin cambiar su regla.

L9 — T4 entregada en `apps/web/src/Cash.tsx`: la lista de motivos se relee con el frame `catalogue` sin
vaciar el formulario, y un motivo archivado mientras estaba elegido se anuncia y se pide reelegir en vez
de borrarse en silencio (S8, S11). Dos pruebas nuevas en `Cash.test.tsx`, con **RED observado** —con la
suscripción neutralizada fallan las dos— y después GREEN.


L10 — T6 entregada por el worker: solapa «Motivos de caja» del registro `CatalogScreens`, con cliente y
parser estrictos nuevos (`cashCategoriesAPI.ts`), pantalla (`CashCategories.tsx`), bloque `.cash-motives-*`
en `style.css` construido sólo con tokens declarados, y 23 pruebas propias. Evidencia: `npx tsc --noEmit`
exit 0; suite web completa exit 0 con 4.563 pruebas; `npm run lint` exit 0. El RED lo capturó después de
escribir la implementación (copia descartable sin los módulos nuevos), no antes: queda anotado como
 evidencia débil de ese punto. Sin hash propio: la solapa vive como estado local de la sección y cualquier
pantalla con hash la cierra; `navigation.ts` quedaba fuera de su superficie.

L11 — Frontera de rebanada, registrada al superar el presupuesto de revisión (696 líneas autoradas en 3
commits sobre `feat/caja-motivos-admin`, rama creada antes de la primera commit porque estábamos en
`master`). Unidades previstas y su tamaño medido: A schema+realtime (350, `dea9327`), B pantalla de la
sucursal en vivo (77, `4fda354`), C1 store del catálogo (267, `b1aa371`), C2 superficie HTTP admin + sus
pruebas (850), C3 docs del contrato (62), D1 cliente y parser del web (488), D2 pantalla de administración
+ registro de solapas + estilos (713), E diseño y cierre ODD (diseño + `system.md` + este documento).
C2 y D2 no bajan de 400 sin separar comportamiento de sus pruebas, que la regla prohíbe; el corte se
queda donde está y se reporta el excedente. C2 es la unidad de riesgo (item 2) y va en su propia commit.
Entrega pendiente de la elección del humano.

L12 — Estrategia de entrega elegida por el humano ante el excedente de revisión:
`chain_strategy=feature-branch-chain`. `feat/caja-motivos-admin` es la rama tracker y las siete
rebanadas (A, B, C1, C2+C3, D1, D2, E) son sus hijas, en ese orden; los PRs hijos apuntan a la tracker y
cada uno lleva su diagrama de dependencia con la rebanada actual marcada. La elección no autoriza push,
creación de PRs ni merge: eso queda a decisión del humano.
