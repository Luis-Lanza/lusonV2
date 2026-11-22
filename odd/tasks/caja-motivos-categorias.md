# Caja: motivos predeterminados para los gastos

Feature branch: `feat/caja-motivos-categorias`. Primera vertical: una lista cerrada de motivos
para registrar un gasto de caja. La administración de ese catálogo (alta/edición por el admin)
queda **fuera** de alcance y se planifica por separado (S6).

## Specs

S1 — El MOTIVO de un gasto deja de ser texto libre y pasa a elegirse de una lista cerrada.
Requisito textual: «no que se pueda comprar cualquier cosa.»
La pantalla de Caja no ofrece ningún camino para escribir un motivo de gasto a mano: el campo es
un selector de las opciones del catálogo.

S2 — La lista inicial viene sembrada con motivos fijos. Requisito textual: «opciones
predeterminadas de compra, por ejemplo alquiler, internet, limpieza, etc.»
Semilla de esta entrega, en este orden:

| # | Motivo |
| --- | --- |
| 1 | Alquiler |
| 2 | Internet |
| 3 | Energía eléctrica |
| 4 | Agua |
| 5 | Limpieza |
| 6 | Sueldos |
| 7 | Transporte |
| 8 | Insumos de tienda |
| 9 | Mantenimiento |
| 10 | Impuestos |
| 11 | Otros gastos |

«Otros gastos» es la única válvula de escape y va última: no reabre el texto libre, la
aclaración va en la nota. Si no se quiere, se quita de la semilla.

S3 — Para un gasto, el motivo es **obligatorio** y la nota es **opcional**. Requisito textual:
«Categoría obligatoria + nota opcional».
El motivo identifica la categoría; la nota es una aclaración corta adicional y puede quedar
vacía. Un gasto sin motivo no se registra.

S4 — Aporte y Recaudación **no cambian**: siguen con motivo de texto libre escrito a mano, como
hoy. Requisito textual: «Sólo Gasto».

S5 — El catálogo vive en una tabla de la base, sembrada en esta entrega, y es **global**: la
misma lista para todas las sucursales. Requisito textual: «Tabla en DB, sembrada ahora» y
«Globales para todas».

S6 — Fuera de alcance: la pantalla donde el administrador crea o edita las opciones. Requisito
textual: «luego en otra vertical el admin podra crear los campos/opciones que apareceran en caja.»
Nada de esta entrega expone alta, edición ni borrado de motivos.

S7 — Los movimientos ya registrados y sus cortes cerrados quedan **intactos**: conservan su
motivo libre histórico y siguen leyéndose igual. Nada se edita ni se borra, según la regla ya
vigente del libro (trigger `protect_branch_cash_movements`). Un gasto histórico sin motivo nuevo
no se rompe.

S8 — Cada gasto guarda, junto a la referencia al motivo, una **copia del nombre** que tenía al
registrarse. Renombrar o archivar el motivo en la vertical del admin no reescribe el pasado: el
libro, la rendición y el acta siguen contando la misma historia.

S9 — La aritmética del cajón no cambia. `esperado = opening + sales + effective` se deriva del
tipo de movimiento, nunca del motivo. Ningún motivo nuevo altera signos, topes, cortes ni la
guarda de cajón no negativo.

S10 — Fuera de alcance: mostrar el motivo de la fila corregida en las filas de corrección. Una
corrección sigue sin motivo propio y se muestra como hoy.

## Tasks

| ID | Tarea | Specs | Ruta | Commit |
| --- | --- | --- | --- | --- |
| T1 | Catálogo en la base, captura y lectura en la API: migración 061 (tabla sembrada, columnas de motivo y nombre, guarda `LC033`, vista del libro), store, handlers, contrato en `apps/api/docs/closings.md` | S2 S3 S4 S5 S7 S8 S9 | worker | C1 C2 C3 · `9c40fef` `6297e30` `a6b4c24` |
| T2 | Pantalla: motivo como selector obligatorio para gasto, nota opcional, columna MOTIVO del libro, cliente de API y tests | S1 S3 S4 S7 | worker | C4 · `324ca38` |
| T3 | Verificación independiente contra S1-S9 | S1-S9 | verify | — |
| T5 | El motivo llega a la rendición y el store recupera su propia regla (A1, A2, A3 de la verificación) | S8 S3 | worker | C5 C6 |
| T4 | Cierre: reconciliar este documento con lo entregado y dejar la evidencia | — | inline | C7 |

## Delivery

The backend slice is larger than the ~400-line review unit, so T1 ships as three
layer commits that each build on their own, in order. Each boundary is recorded
here as it lands.

| Slice | Content | Lines |
| --- | --- | --- |
| C1 | Schema: migration 061, its schema test, the table-inventory and raw-`gasto` fixtures it necessarily breaks | 736 `9c40fef` |
| C2 | Store: the one write path, the catalogue read, the label revalidation, the ledger projection | 637 `6297e30` |
| C3 | HTTP + contract: routes, per-kind decoders, DTOs, `apps/api/docs/closings.md` | 828 `a6b4c24` |
| C4 | Screen and client: motive selector, optional note, book column, parsers, frontend tests | 617 `324ca38` |
| C5 | Settlement publishes the motive (A1) and the store/read stop drifting (A2, A3) | 454 `1bcf1a4` |
| C6 | Actas render motive, note and amount; the list's styling | 328 `5feee70` |
| C7 | This document: the delivery, the verification's verdict and what was left alone | 204 |

## Contrato de esta entrega (para T1 y T2)

`GET /api/closings/cash-categories` → 200

```json
{"categories": [{"id": 1, "label": "Alquiler"}]}
```

Sólo motivos activos, ordenados por posición de la semilla y luego por nombre.

`POST /api/closings/cash-movements` — cuerpo `{kind, amount, category_id, description}`:

- `kind = "gasto"`: `category_id` obligatorio (entero positivo), `description` opcional.
- `kind = "aporte" | "recaudacion"`: `category_id` prohibido, `description` obligatorio como hoy.
- Motivo desconocido o archivado → 400 `{"error": "category_unknown"}`.
- Motivo en un tipo que no es gasto → 400 `{"error": "category_not_applicable"}`.
- Gasto sin motivo → 400 `{"error": "category_required"}` (guarda de base `LC033`).

`POST /api/closings/cash-corrections` — sin cambios: no lleva motivo.

`GET /api/closings/cash-ledger` — cada movimiento gana dos campos, `null` cuando no aplica:

```json
{"category_id": 3, "category_label": "Alquiler"}
```

## Log

L1 — Pedido original del humano, textual:

> bien bien
>
> ahora quiero en esta parte [Image#3], modificar para que haya opciones predeterminadas de compra, por ejemplo alquiler, internet, limpieza, etc.
>
> no que se pueda comprar cualquier cosa. Primero asi, luego en otra vertical el admin podra crear los campos/opciones que apareceran en caja. dime si entendiste antes de continuar con el codigo

L2 — Decisiones del humano, textuales, ante cuatro preguntas del padre:
«Sólo Gasto» · «Categoría obligatoria + nota opcional» · «Tabla en DB, sembrada ahora» ·
«Globales para todas».

L3 — Restricciones que el padre fijó antes de codificar y el humano dejó pasar sin objeción:
schema aditivo (no se toca la columna `description` existente ni se reescriben filas), copia del
nombre del motivo en cada gasto (S8), la aritmética del cajón no se toca (S9), y el catálogo se
siembra ya en tabla para que la vertical del admin sea sólo CRUD y no una migración de datos
reales. Riesgo del slice: bajo; todo es aditivo y reconstruible, y ningún contrato existente se
rompe.

L4 — Semilla propuesta por el padre a partir de los ejemplos del humano y aprobada por
continuidad: la tabla de S2. «Otros gastos» se ofrece como escape y puede quitarse sin tocar
código.

L5 — Hallazgo del mapeo previo: `odd/tasks/caja-operativa.md:5` sigue diciendo «Diseño:
pendiente» con el trabajo ya entregado. Deuda de documentación, fuera de esta feature.

L6 — T1 entregado y la suite completa de Go en verde (`go test -count=1 ./...`, todas las
packages ok). El perfecto: el slice de backend superó el límite de revisión de ~400 líneas, así
que se partió en tres commits por capa (C1 schema, C2 store, C3 HTTP y contrato), cada uno
compilando por sí solo en ese orden. La tabla de T1 quedó fuera de las superficies delegadas en
dos fixtures (`bootstrap/integration_test.go`, `auth/administration_test.go`), que el padre
autorizó al ampliar la superficie: son consecuencias necesarias de una tabla y una guarda nuevas,
no cambios de conducta.

L7 — Hallazgo de la auditoría del frontend, y alcance real de T2: `apps/web/src` **nunca** llama a
`POST /api/closings/expenses`, así que ese endpoint cambió de contrato sin impacto en la
pantalla. Los puntos que T2 tiene que tocar son: el cuerpo del movimiento
(`cashAPI.ts:394`), el parser del libro (`cashAPI.ts:274`), que exige un juego exacto de claves y
por eso hoy rechaza la respuesta nueva; la nota vacía (`cashAPI.ts:210`); la lectura nueva del
catálogo; y la pantalla (`Cash.tsx:215`, `Cash.tsx:477`). Mientras T2 no entre, la pantalla de Caja
falla tanto al escribir un gasto como al leer el libro, y eso es esperado en este punto.

L8 — T2 entregado y verde: 64 tests en los dos archivos del slice, 4.507 en la suite completa del
frontend, `tsc --noEmit` y `biome lint` con exit 0. Tres tests de pantalla cambiaron su **entrada**,
no su expectativa: los gastos que escribían «Detergente» en el motivo libre ahora eligen «Limpieza»
del catálogo, porque ese textarea ya no existe para un gasto; y todos los fixtures del libro
ganaron las dos claves que el contrato publica siempre. No hubo que correr verificación diferencial:
`cashAPI.ts` sólo lo importa `Cash.tsx` y ningún otro comando comparte los helpers cambiados.

L9 — Verificación independiente (T3), sobre `324ca38` contra `origin/master`: **S1-S10 `met`**, los
cinco chequeos adversariales pasan. Lo construido, no leído: caja vacía → `LC032` antes que
`LC033`; sucursal congelada → `LC001` antes que `LC033`; `pg_trigger` con `tgtype=7` termina en
`verify_branch_expense_category_before_insert`; un dataset escrito en el esquema 060 y migrado a
061 queda byte-idéntico; renombrar un motivo no reescribe el pasado; no se puede guardar una fila
sin nota y sin motivo ni por la base. Ningún test fue debilitado: +1053 líneas de test Go y +373
web, sólo dos líneas de aserción reemplazadas por su versión con motivo.

Advisories de esa verificación y qué se hizo con cada uno:

- **A1 (acta sin motivo) — corregido en C5/C6.** Era real y contradecía S8.
- **A2 (el store recortaba la nota en silencio) — corregido en C5.** El store volvió a rechazar
  texto con relleno en vez de normalizarlo, y los casos volvieron a su lista de malformados.
- **A3 (la lectura aceptaba más que el escritor) — corregido en C5.** Una regla por concepto, en
  una función cada una, compartida por escritor y lectores.
- **A4 (`category_id:null` → `invalid_request`) — se deja como está, a propósito.** Un `null`
  explícito es un cuerpo mal formado, no un gasto sin motivo; `category_required` describe el
  gasto que no nombra ninguno. Está documentado así en el contrato.
- **`POST /api/closings/cash-movements` responde sin el motivo — se deja como está.** La pantalla
  relee el libro, y el juego de siete claves de esa respuesta está fijado por el parser del
  cliente; agregarlo sería un cambio de contrato sin lector que lo necesite.

L10 — T5 entregado (C5, C6). El acta publica y muestra el motivo; el store recupera su regla; la
lectura y la escritura comparten una sola función por regla. El CSS del acta quedó fuera de las
superficies delegadas y lo agregó el padre (18 líneas, `closings.css`), con `biome lint` en 0 y los
dos tests de acta en verde. La verificación diferencial de A2 se hizo sobre una copia en `/tmp` con
la igualdad quitada: sin la regla el caso pasa, con la regla falla. Ambas copias de scratch fueron
borradas por el padre.

L11 — Cabo suelto conocido y aceptado: el catálogo no tiene todavía pantalla de administración
(S6). Hasta esa vertical, cambiar los motivos es una migración o un `UPDATE` en la base.

L12 — Evidencia de cierre en `5feee70`: `go -C apps/api test -count=1 ./...` con el fixture
PostgreSQL arriba, **exit 0 en todas las packages** (closings 103s, httpapi 295s, migrations
140s, transfers 341s, y el resto). Frontend: 4.515 tests, `tsc --noEmit` exit 0, `biome lint src`
exit 0. Nada queda pendiente dentro de S1-S10.
