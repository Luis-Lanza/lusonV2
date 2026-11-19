# Rendir una sucursal que tiene otros productos

La planilla de conteo ya siembra todo el catálogo y el cierre ya la aplica por `variant_id`; lo que
no puede es **leerse**: la lectura proyecta campos de batería sin coalescer y devuelve 503. Esta
vertical abre la rendición a los dos tipos y hace que el congelamiento y la aceptación se vean en
vivo, reusando el stream de la ubicación.

## Specs

S1. **La planilla cuenta todo el catálogo.** No se agrega filtro de tipo a `seed_closing_count_lines`
ni a `apply_branch_closing_closure`, y no se redefinen funciones ya aplicadas de `034`/`035`/`043`.
Una línea de producto y una de batería conviven en la misma planilla.

S2. **La planilla de una sucursal con productos se lee.** `loadCountLines` deja de escanear
`entry.brand`, `entry.model`, `entry.capacity_ah` y `variant.polarity` en tipos no anulables y deja de
exigir marca/modelo/polaridad/capacidad. La rendición de esa sucursal responde 200, con las líneas de
batería igual que hoy y las de producto con nombre y detalle.

S3. **El acta publica la identidad de cada tipo.** Los campos de batería del DTO de línea
(`brand`, `model`, `capacity_ah`, `polarity`) pasan a ser opcionales y una línea de producto publica
`name` y `detail`. La web espeja el mismo contrato: `closingsAPI.ts` deja de rechazar un valor vacío
de polaridad o capacidad, la etiqueta de fila muestra "Marca Modelo L · 100 Ah" para batería y
"Agua acidulada · 1 L" para producto, y el buscador indexa también nombre y detalle.

S4. **La pantalla deja de decir batería cuando ya no es sólo batería.** El encabezado de la columna y
el texto de búsqueda de la planilla no nombran solo baterías; el selector del catálogo de la sucursal
deja de exigir `battery` y ofrece ambos tipos.

S5. **Escribir una línea de producto sigue permitido y sin inventar reglas.** `checkVariants` no gana
predicado de tipo, `expected_quantity` sigue saliendo del saldo por el trigger `admit_closing_count_line`,
y la diferencia contada − esperada no cambia de significado para ningún tipo.

S6. **El acta de métricas deja de romperse.** `topModels` deja de leer marca/modelo/capacidad como
texto obligatorio: un período en el que se vendió un producto devuelve 200 y su fila se etiqueta con
el nombre del producto, sin sufijo de capacidad. Las compuertas que hoy rechazan marca vacía o
capacidad inválida se relajan para el tipo producto **sin** aceptar una batería mal formada.

S7. **Los números que ya son correctos no se tocan.** `sales.units` sigue sumando todos los tipos
(ya lo hace) y el "stock en estantería" sigue sumando todos los tipos (ya lo hace). Esta vertical no
cambia un importe: la rendición se valora por totales de documento.

S8. **El congelamiento se avisa en vivo sin tópico nuevo.** Una migración nueva (la siguiente al
`057`) agrega triggers sobre `branch_closings` para `INSERT` y `UPDATE` que bumpean
`realtime_revisions` y notifican `transfers:<branch_location_id>`. No se toca el CHECK de scopes, el
seed, `admit_realtime_audience`, `parsePayload` ni las listas `EXCEPT` de `readRevisions`.

S9. **La audiencia sigue siendo por ubicación.** El evento viaja en el stream de la sucursal afectada
y nunca se difunde a todas: el filtro `s.location != audience` de `install()` queda intacto, y el
scope lo sigue resolviendo el servidor desde la sesión.

S10. **La aceptación aparece sin recargar.** La pantalla de la sucursal se suscribe al stream de su
propia ubicación y, al recibir el evento de rendición, vuelve a leer historia y detalle. Con eso el
aviso de "sucursal congelada" y el botón "Aceptar y cerrar la rendición" aparecen sin recargar la
página, tanto cuando Almacén abre la rendición como cuando la propone.

S11. **Cada corte con RED observado.** Ningún test nuevo se escribe después de la implementación. Los
tests que hoy fijan "la planilla cuenta solo baterías" o "un producto no llega al acta" se cambian a
propósito y quedan nombrados en el log. La migración nueva lleva su test de esquema, como las demás.

S12. **Ningún documento cerrado se reprocesa.** Los cierres históricos conservan sus líneas; la
planilla vieja se lee con el contrato nuevo y sigue diciendo lo mismo que decía.

## Tasks

| ID | Specs | Ruta | Commit |
| --- | --- | --- | --- |
| T1 | S6, S7 | worker: metrics (ranking, compuertas, etiqueta web) | `1cfc10d` |
| T2 | S2, S3, S4, S5, S12 | worker: planilla (lectura, DTO, web, selector de catálogo) | `f04bb4b` |
| T3 | S8, S9, S10, S11 | worker: migración del aviso + suscriptor web | `f04bb4b` |
| T4 | S1-S12 | verificación independiente | L5-L9 (`mwnw9atb-b-wk89`) |

## Log

L1. Pedido del humano, textual: «si si cierto! tenemos que hacer cierre primero pa! como hacemos!!!
plantiemos como hacerlo, ademas actualmente cuando se inicia una rendicion de cuentas tampoco sale en
tiempo real avisandole a la sucursal de que esta bloqueada ni sale en tiempo real a la sucursal que
apruebe la rendicion!, sino que tengo que recargar la pagina y recien se habilita el boton de aceptar
rendicion! ya que vamos a tocar cierres/rendicion aprovechemos tambien para arreglar esto! entonces
creemos una rama y exploremos como seria la cosa para hacer la rendicion de cuentas».

L2. Decisiones del humano, textual: «A y reusar!». A = la planilla cuenta todo el catálogo (sin filtro
de tipo, sin migración de siembra). Reusar = el aviso de rendición viaja por el stream de la propia
ubicación (`transfers:<loc>`), sin crear un tópico nuevo.

L3. Corrección de un dato mío: el congelamiento del stock ya es correcto (el trigger siembra todo y el
cierre aplica por `variant_id`); lo que falla es la lectura (`closings/store.go:2175-2193`), que con un
producto en la planilla devuelve 503 y deja la rendición ilegible. La sucursal no puede rendir.

L4. Rama `feat/closings-other-products`, cortada de `master` `3db3386`.

L5. Verificación independiente sobre el árbol completo. **Un bloqueante**: `gofmt -l apps/api` fallaba en
`internal/httpapi/closings_test.go` (alineación tras agregar `Identity:`), y el job `go` de CI corre
`gofmt -l .`, así que habría rebotado. Arreglado en el acto con `gofmt -w` y verificado vacío; el resto
de la verificación se hizo después. Verdicto por spec: S1-S12 satisfechas, con los matices de abajo.

L6. Hallazgos del verificador, corregidos en esta rama:

- F1 — `/api/metrics` había ganado una clave `kind` en las filas de **batería**: un cambio de contrato
  que ninguna spec pedía. Revertido. La batería vuelve a publicar sus seis claves baseline y el
  producto publica cuatro; la discriminación es por presencia, igual que en la planilla de conteo.
  `{"catalog_entry_id":1,"brand":"CAR","model":"NS40ZL","capacity_ah":"35","units":2,"money":"10.00"}`
- F3 — el aviso que llegaba mientras el operario tipeaba un conteo se **descartaba**. Ahora se difiere y
  se aplica cuando el borrador se libera, sin pisar el trabajo en curso: era la queja original del
  humano, así que no podía quedar como advisory.
- F5 — el test de esquema afirmaba tokens del comentario del `.sql` (`"Why"`, `"S8"`, `"015"`), de modo
  que borrar un comentario rompía el build. Reemplazado por aserciones estructurales sobre el cuerpo de
  la función y el trigger.

L7. Hallazgos del verificador, aceptados y no corregidos, con motivo:

- F4 (concurrencia) — el trigger nuevo toma `FOR UPDATE` sobre el contador de su propia sucursal y lo
  sostiene hasta el commit del `Open`. No hay ciclo posible: adquiere **una sola fila** y siempre la del
  `branch_location_id` de la fila que disparó, que es un prefijo del orden ascendente que ya usan los
  triggers de transferencias (`004`, `006`, `011`, `012`, `013`, `018`). El costo es contención: una
  transferencia que toque esa sucursal espera el `Open`. Se acepta porque esa sucursal está siendo
  congelada y su transferencia iba a ser rechazada por el guard de todos modos.
- F6 (cobertura) — los tests de pantalla disparan el fan-out importado, así que no probarían el cableado
  si se borrara el hook; la integración real queda fijada una sola vez, por comportamiento, en
  `useInventory.test.ts` (un frame `transfers` real mueve a los dos lectores con un solo `EventSource`).
- F8 (redacción) — S3 dice "deja de rechazar un valor vacío de polaridad o capacidad"; la implementación
  sigue rechazando una **batería** con polaridad o capacidad vacía. Es lo correcto: el servidor no puede
  emitir eso (`identity.Valid()`) y aceptarlo contradiría S6 ("sin aceptar una batería mal formada").
  La spec se lee con esa precedencia.

L8. Tests re-apuntados a propósito (S11). Uno solo: `closingsAPI.test.ts` "counts batteries only: a
product row never becomes a count line (S11)" pasó a "offers both kinds of the catalogue, never only
batteries (S4)", porque la regla que fija cambió de "nunca un producto" a "siempre los dos tipos, con
`kind=all`". Ningún test de Go fijaba el comportamiento viejo. Copys visibles que cambiaron además de
S4, todos por la misma razón (una cifra correcta con un sustantivo falso): el título del ranking
("Baterías más vendidas" → "Más vendidos"), su vacío, "78 baterías vendidas" → "78 unidades vendidas"
—la cifra suma los dos tipos desde siempre—, y en la rendición "Sólo baterías nuevas" → "Baterías y
productos del catálogo".

L9. Medición final sobre el árbol quieto, una sola corrida, con log completo (la corrida anterior se
midió con `| tail` y con un `gofmt -w` concurrente sobre un archivo que la suite estaba compilando: eso
es lo que produjo el `FAIL` que nunca supe explicar, y no vuelvo a medir así).

- **Go**: `make test-pg` **exit 0**, los 20 paquetes `ok` (`internal/closings` 141s, `internal/httpapi`
  418s, `internal/transfers` 522s, `migrations` 187s); fixture auditado y teardown limpio.
- **Web**: 4190 de 4191 pasan (1 skip preexistente) con **un** test intermitente ajeno a esta vertical:
  `TransferPending.test.tsx > retains uncertainty across parent unmount/remount` ("Unable to find …
  'Estado de operación'"). Evidencia de que es flake y no regresión: falló 1 de 6 corridas del archivo
  solo (las 6 en la misma máquina y con la misma versión del árbol), y ese archivo sólo importa el
  **tipo** `TransferAuthority` de `useInventory`: no ejecuta el hook que esta vertical tocó. Se anota
  acá; si aparece en CI se abre aparte, no se tapa alargando un timeout.
- **Estático**: `gofmt -l apps/api` vacío, `go vet ./...` limpio, `tsc --noEmit` limpio, `biome lint src`
  con 0 errores. Delta real de warnings medido archivo por archivo contra `3db3386`: `ClosingDecision`
  4→5 (el efecto que aplica el aviso diferido: el linter cree que sobran dependencias y son justamente
  las compuertas), el resto igual o mejor (`closingsAPI` 1→0).

L10. Entrega cortada en dos commits de código más este documento. Frontera de los cortes, para que la
revisión sepa dónde termina uno y empieza el otro: `1cfc10d` es sólo métricas (dominio, DTO, decoder y
pantalla) y no toca la rendición; `f04bb4b` es la rendición completa —lectura y escritura de la planilla,
pantalla, migración 058 y el cableado en vivo— porque `ClosingWorkspace.tsx` lleva la etiqueta por tipo y
la suscripción al mismo tiempo, y partirlo por archivo habría dejado un commit que no compila. Carga de
revisión: 644 líneas autoradas en el primero, ~1470 en el segundo; si el segundo resulta demasiado de una
sentada, el corte natural es API (`closing.go`, `store.go`, `httpapi/*`, migración) contra web
(`closingsAPI`, `closingModel`, las dos pantallas, `useInventory`). Sin push y sin merge: es decisión del
humano.

L11. Publicada: la rama subió con upstream y entró a `master` como merge commit `c6dbd22`. Después del
merge, sobre master: `go build ./...` verde y `gofmt -l apps/api` vacío. CI `verify` corre sobre el push
de master (`go`, `go-postgresql`, `frontend`).

L12. Un tropiezo de entrega, anotado para no repetirlo: al levantar el stack local con esta vertical
reinicié la API pero **no reconstruí el SPA**, y el servidor cachea `index.html` en memoria al arrancar.
El bundle viejo (anterior a la vertical) rechazaba la línea de producto de la planilla y la pantalla de
Rendiciones mostraba "No se pudieron consultar las rendiciones". Era el frontend de ayer contra el
backend de hoy. Se corrigió con `vite build` **más** reinicio, y la verificación correcta es comparar el
hash del asset que sirve `GET /` con el que declara `apps/web/dist/index.html`. Lo que el bundle viejo
no podía parsear era real y estaba en la base: la rendición viva de Sucursal A tiene 184 líneas de
batería y 1 de producto.
