# Vender otros productos en el mostrador

Vertical que cierra el hueco declarado: hoy una venta de producto se escribe y no se puede leer.
Una línea de venta pasa a ser la identidad compartida del catálogo más su cantidad; la serie y la
garantía por pieza quedan donde estaban, en la batería.

## Specs

S1. **"Sin serie: alcanza la cantidad".** Una línea de venta de un producto (`kind = other`) no lleva
unidades, ni serie, ni plazo por pieza: su cantidad es toda la línea. Una línea de batería conserva
una unidad por pieza vendida, con su serie obligatoria y su plazo opcional 1..120 (`null` = sin
garantía). Una línea de producto que trae unidades se rechaza; una línea de batería que no trae una
unidad por pieza se rechaza.

S2. **"La garantía actual, con plazo vacío".** El documento impreso de una venta sigue siendo el PDF
de garantía para toda venta, sin documento nuevo. Una línea de producto imprime su identidad —nombre y
detalle— con el plazo vacío; una línea de batería imprime lo que imprime hoy, palabra por palabra.

S3. **"Sí, una venta mezcla (recomiendo)".** Una venta puede llevar los dos tipos a la vez. Nada se
rechaza por mezclar, y cada línea se lee y se muestra por su propia identidad, nunca por la forma de
otra.

S4. **No se cobra una venta que no se puede leer.** La misma petición responde 201 y su detalle, su
fila de historial y su documento impreso. El defecto actual —escribir 201 y fallar al leer con 503—
no puede sobrevivir a este cambio.

S5. **El mostrador lista los dos tipos.** La lectura de catálogo del mostrador acepta un tipo, con la
batería como valor por defecto, así el comportamiento de hoy no cambia; la pantalla ofrece buscar
baterías o productos. Una tarjeta de producto muestra nombre y detalle y no columnas de marca,
capacidad ni polaridad.

S6. **El precio no cambia de forma.** El cajero sigue declarando el precio unitario, el mínimo de la
sucursal sigue siendo piso y una venta de un producto sin precio en la matriz se rechaza como hoy.

S7. **Fuera de alcance, declarado.** Devoluciones, reclamos de garantía, plazo por producto en el
catálogo y comprobante distinto del PDF de garantía no se construyen acá.

S8. **Nada de la batería se toca.** El cable de la venta de baterías no cambia en ningún campo, y el
copy de pantalla existente se conserva palabra por palabra.

## Tasks

| ID | Specs | Ruta | Commit |
| --- | --- | --- | --- |
| T1 | S1, S4 | parent: migración del trigger de unidades por tipo + test de esquema | — |
| T2 | S1, S3, S4, S5, S6, S8 | worker backend: dominio, store, httpapi | — |
| T3 | S2 | worker backend: PDF de garantía por línea | — |
| T4 | S1, S2, S3, S5, S8 | worker web: mostrador, carrito, historial, detalle | — |
| T5 | S2, S5, S6 | docs: API de ventas | — |
| T6 | S1-S8 | verificación independiente | — |

## Log

L1. "okey, entonces creemos otra rama y analicemos como hacer la venta!, porque durante una venta
gestionar garantias en baterias, y el agua no lleva garantias necesito ideas de como hacer el POS con
esto"

L2. Mapa del POS (read-only). Lo que decide el diseño: la garantía **ya** es agnóstica al tipo (el
plazo vive por pieza en `sale_units.warranty_months`, nullable 1..120, y `null` ya significa sin
garantía); lo estructural es la serie obligatoria por pieza (`migrations/031_sale_unit_serial_warranty.sql:35-36`)
y el trigger diferido que exige una unidad por pieza (`031:98-118`). El defecto real: `POST /api/sales`
con un producto escribe 201 y descuenta stock, y `Store.Read` lo rechaza después porque exige marca,
modelo y polaridad (`sales/store.go:442`, `httpapi/sales.go:1075`), así que el detalle, el historial y
el PDF fallan con 503. No existe devolución, reclamo ni ticket en todo el repo.

L3. Decisiones del dueño: (1) sin serie, alcanza la cantidad; (2) la garantía actual como comprobante,
con plazo vacío —no un documento nuevo—; (3) una venta mezcla los dos tipos.

L4. Backend entregado en dos commits: `2bb4fa2` (migración `056`, regla de unidades por tipo de
catálogo) y `ffeb54c` (dominio, store, httpapi, PDF y `docs/sales.md`). El defecto que trajo esta
vertical tiene ahora test que lo prueba en rojo: crear la venta de un producto respondía 201 y leerla
después daba `503 sale store unavailable`. Los dos rechazos de línea son 400 con nombre propio
(`battery_line_requires_units`, `product_line_carries_no_units`) y nombran el variante; antes, una serie
ofrecida en un producto salía como 503, que es un error de datos disfrazado de caída.

L5. Dos correcciones mías durante la revisión, y las dos son la misma lección. Primero delegué con una
superficie equivocada (`apps/api/docs/sales-api.md`, que no existe) y el worker se detuvo en vez de
crear un documento paralelo: hizo bien. Segundo, el documento dejaba la fila de `LV012` diciendo "o una
venta no lleva ninguna", que la regla nueva volvió falsa — no distinta, falsa — y la corregí yo. Pedir
"no toques la fila de la batería" para preservar el texto es correcto para el copy de pantalla y un error
para un documento que afirma lo que el servidor hace.

L6. Verificación independiente: **sin bloqueantes**, S1-S6 y S8 satisfechas, S7 fuera de alcance como se
declaró. Lo valioso que trajo, incluida una corrección a mi propio L2:

- **El L2 estaba mal en un punto y la realidad es peor.** Yo escribí que al baseline la venta de un
  producto fallaba en el detalle, el historial y el PDF. El verificador reprodujo la trampa y midió: el
  baseline responde 201, descuenta stock, el detalle y el PDF dan 503 **y el historial responde 200 con
  `units_total: 1`** — o sea, contaba la serie inventada del producto como una pieza de batería vendida.
  Un historial que miente con 200 es más peligroso que uno que falla, porque nadie lo mira dos veces.
- El cable de baterías es idéntico al baseline campo por campo en CREATE, DETAIL, LIST y SELLABLE, y el
  PDF de una venta de baterías es **byte-idéntico** (4011 bytes, también tras normalizar fechas). El
  catálogo vendible por defecto respondió byte-idéntico en las cuatro consultas cotejadas.
- El ataque al dinero y al stock se sostiene: producto sin precio en la sucursal → `409
  variant_not_sellable`; stock insuficiente → rechazo con la base sin cambios; precio bajo el mínimo →
  `below_minimum`; ninguna balanza negativa. Lo único que cambió de código para una batería es la línea
  con unidades que no coinciden con su cantidad, que pasó de `invalid_request` a
  `battery_line_requires_units` — y eso es exactamente lo que pedía S1.

L7. Dos defectos míos corregidos en la revisión, y son la lección de esta vertical: el worker invirtió el
orden de dos validaciones del mostrador, así que una batería con el precio bajo el mínimo **y** sin serie
mostraba el mensaje del precio en vez del de la serie; `master` validaba la serie primero. Lo revertí y
**observé el rojo** con el orden equivocado antes de dar el pin por bueno. Y el documento `sales.md` seguía
afirmando en la fila de `invalid_request` que unas unidades distintas de la cantidad responden
`invalid_request`, cuando ahora responden su propio código: misma lección que L5, un documento que afirma
lo que el servidor hace se corrige, no se preserva.
