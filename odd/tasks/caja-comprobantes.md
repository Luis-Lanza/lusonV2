# Caja: comprobante fotográfico del gasto

Feature branch: `feat/caja-comprobantes`, apilada sobre `feat/caja-motivos-categorias`
(base `f4cd579`). Un gasto puede llevar la foto de su comprobante, guardada y servida como
evidencia inmutable.

## Specs

S1 — Un gasto puede llevar **una sola** imagen de comprobante, y es **opcional**: un gasto sin
foto se registra igual. Requisitos textuales del humano: «Una sola foto», «Opcional siempre».

S2 — **Sólo** el tipo `gasto` puede llevar comprobante. `aporte`, `recaudacion` y `correccion` no
lo llevan nunca. Requisito textual: «Sólo gasto».

S3 — Los bytes de la imagen viven en **PostgreSQL**, en la misma fila del movimiento. Requisito
textual: «Postgres (recomendado)».

S4 — La foto nace en la **misma transacción** que el gasto. Si la imagen se rechaza, no existe el
movimiento; nunca queda un gasto esperando su comprobante.

S5 — La foto es **inmutable**, por herencia del trigger que ya protege la fila del movimiento: no
se edita, no se reemplaza, no se borra. Una foto equivocada se resuelve como todo lo demás en este
libro: se corrige el gasto con un movimiento que lo compensa y se registra un gasto nuevo con el
comprobante correcto.

S6 — Sólo se aceptan **JPEG y PNG**, y el formato se decide por el **contenido decodificado**, no
por el `Content-Type` ni por la extensión que declara el cliente. SVG se rechaza siempre. Se
rechazan archivos vacíos, imágenes que no decodifican hasta el final, y las que superan los topes:
**8 MB** de tamaño y **6000×6000** píxeles.

S6b — El comprobante es **el archivo entero**: si queda un solo byte más allá del final de la
imagen, se rechaza. Un PNG válido con un ZIP pegado atrás no es un comprobante.

S6c — Las decodificaciones simultáneas están acotadas, para que varias subidas no multipliquen la
memoria reservada al descomprimir.

S7 — Los bytes **no viajan** en el libro ni en el acta. Ambos publican sólo los metadatos del
comprobante: tipo, tamaño y huella SHA-256, o nada cuando el movimiento no lleva foto.

S8 — La imagen se sirve por un endpoint autenticado con la misma autoridad que el libro: sesión
válida y la sucursal del movimiento. Ninguna URL pública ni adivinable; `no-store` y `nosniff`.

S9 — El cuerpo JSON existente de `POST /api/closings/cash-movements` no cambia ni una clave: un
cliente que registra un gasto sin foto sigue funcionando igual que antes de esta feature.

## Contrato de esta entrega

`POST /api/closings/cash-movements` acepta dos formas:

- `application/json`, la de siempre: `{kind, amount, category_id, description}`. Sin foto.
- `multipart/form-data` con una parte `movement` que contiene exactamente ese mismo JSON, y una
  parte `evidence` con el archivo. La respuesta es la misma de siempre.

`GET /api/closings/cash-movements/{id}/evidence` → 200 con los bytes y el `Content-Type`
validado, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, disposición inline.
Refusals: 404 si el movimiento no existe o no es de la sucursal de la sesión; 404 si no tiene
comprobante; 405 para métodos que no sean GET/HEAD.

Refusals del comprobante, en la creación:

| Caso | Código |
| --- | --- |
| Archivo vacío | 400 `evidence_empty` |
| Tamaño sobre el tope | 400 `evidence_too_large` |
| Formato no permitido o no decodificable | 400 `evidence_unsupported` |
| Dimensiones sobre el tope | 400 `evidence_dimensions` |
| Comprobante en un tipo que no es gasto | 400 `evidence_not_applicable` |
| Parte `evidence` repetida | 400 `invalid_request` |

El libro y el acta publican, por movimiento, `evidence`:

```json
{"evidence": {"type": "image/jpeg", "size": 482913, "sha256": "…"}}
```

y `"evidence": null` cuando el movimiento no lleva comprobante.

## Tasks

| ID | Tarea | Specs | Ruta | Commit |
| --- | --- | --- | --- | --- |
| T1 | Migración 062: las cuatro columnas del comprobante, sus CHECK y el test de esquema. Sin trigger nuevo: la inmutabilidad se hereda | S3 S5 S6 | worker | C1 |
| T2 | Store y HTTP: validación por decodificación, escritura en la misma transacción, metadatos en el libro, endpoint autenticado de la imagen, contrato en `apps/api/docs/closings.md` | S1 S2 S3 S4 S6 S7 S8 S9 | worker | C2 |
| T3 | Pantalla: selector de archivo con vista previa, indicador en el libro y en el acta, cliente de API y tests | S1 S2 S7 | worker | C3 |
| T4 | Verificación independiente con chequeos adversariales de subida y autorización | S1-S9 | verify | — |
| T6 | Cerrar los dos defectos que encontró la verificación | S6b S6c | worker | C5 |
| T7 | Cerrar la regresión que introdujo el arreglo: una subida abortada respondía 200 vacío | S6c | worker | C6 |
| T5 | Cierre: reconciliar este documento y dejar la evidencia | — | inline | C4 |

## Delivery

The backend slice is past the ~400-line review unit, so it ships as three layer commits that
build in order, each boundary recorded here.

| Slice | Content | Lines |
| --- | --- | --- |
| C1 | Migration 062 and its schema test: the four receipt columns, five CHECKs, the restated view and admission function | 852 |
| C2 | The closings package: content validation by decoding, the receipt in the movement's INSERT, the metadata in the book and the acta | 762 |
| C3 | The HTTP layer and the contract: two-form POST, the authenticated image route, docs | 838 |
| C4 | The screen: file picker with preview, the badge in the book and the acta, client and tests | 952 `ebf663a` |
| C5 | The verification's two defects: the receipt is the whole file, the side cap is 6000, and decodes are bounded to two at a time | 447 |
| C6 | The regression the fix introduced: an aborted upload answers `invalid_request`, never an empty 200 | 160 |
| C7 | This document: delivery, the verification verdict and what the fixes cost | 0 |
## Log

L1 — Pedido original del humano, textual:

> bien bien. ahora quiero que se pueda adjuntar una imagen [Image#1] aqui al hacer un gasto en la caja, cachas? coomo podemos plantearlo? aun no hagas codigo

L2 — Decisiones del humano, textuales, ante cuatro preguntas del padre: «Una sola foto» ·
«Opcional siempre» · «Sólo gasto» · «Postgres (recomendado)».

L3 — Restricciones fijadas por el padre y aprobadas por el humano («dale»): original guardado tal
cual, sin re-codificar, con SHA-256 registrado; sólo JPEG y PNG; topes de 8 MB y 10000×10000 px;
dos formas en el mismo POST (JSON y multipart) para no romper el cliente que no manda foto; el
servido va por endpoint autenticado, nunca por el directorio público.

L4 — Consecuencia aceptada explícitamente antes de codificar: con una sola foto, inmutable y
opcional, una foto equivocada **no se puede reemplazar**. El camino es corregir el gasto y
registrar uno nuevo con el comprobante correcto, que es la misma regla que rige todo el libro.

L5 — Verificación independiente, sobre `ebf663a`: **S1-S9 `met`** y ocho de los diez adversariales
limpios (SVG disfrazado rechazado, tres 404 indistinguibles para sucursal ajena, id inexistente y
movimiento sin comprobante, inyección por nombre de archivo bloqueada, ningún byte de imagen en el
libro, ningún `SELECT *` sobre la tabla en código de producción). Encontró dos defectos reales,
corregidos en la tarea T6: un PNG o JPEG válido con payload pegado atrás era aceptado, y una
imagen de 10000×10000 dentro de los topes reservaba ~382 MiB por decodificación sin límite de
concurrencia.

L6 — T6 ajustó los topes a 6000×6000 px por esa razón, agregó la regla de que el comprobante es el
archivo entero, y acotó las decodificaciones simultáneas. El tope de 8 MB no cambió. La constante
del tope en el frontend vive en un solo lugar (`closingModel.ts`) y `cashAPI.ts` la reexporta.

L7 — Re-chequeo del verificador sobre `0b53d15`: **los dos defectos cerrados**, con medición propia.
Polyglot 8/8 rechazados; seis subidas simultáneas con pico de heap de 104 MiB frente a 69 MiB con
dos, o sea sin escalar; un pedido cancelado en cola responde con su contexto a los 80 ms y no
filtra el turno. Encontró una **regresión que introdujo el propio arreglo**: una subida abortada
respondía `200 OK` vacío, porque el handler volvía sin escribir estado y net/http contesta 200 por
defecto. Corregida en C6: el handler siempre escribe su rechazo, y un cuerpo incompleto tiene una
sola regla —el comprobante nunca llegó completo, así que nunca se juzgó— `400 invalid_request`,
tanto si el `Content-Length` mentía como si no. Esa regla destapó además una carrera en la toma del
turno de decodificación (con un turno libre y un contexto ya cancelado, el `select` podía elegir
cualquiera de los dos casos), corregida rechazando antes de tomar el turno.

L8 — Cierre verificado sobre `00a857c`: la sonda del verificador, **sin modificar**, ahora imprime
`400 {"error":"invalid_request"}` en las dos formas de truncamiento —antes `200` vacío y
`evidence_unsupported` respectivamente—, y en ambas el conteo de movimientos y el esperado del
cajón quedan iguales. El camino aceptado sigue dando 201 con bytes idénticos a los guardados y
servidos, y una imagen no soportada sigue rechazándose con `evidence_unsupported`. Servidor de
desarrollo reiniciado: migración 062 aplicada sobre la base real con datos previos.

L9 — Observación aceptada, no defecto: el turno de decodificación se toma **antes** de leer el
cuerpo, así que dos subidas deliberadamente lentas pueden acaparar los dos turnos hasta que expiren
los timeouts de lectura del servidor, y la cola de espera no tiene tope de profundidad. En una red
interna con dos operadores es irrelevante; si este endpoint se expone, hay que leer primero y tomar
el turno después.
