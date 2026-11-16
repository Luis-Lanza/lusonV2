# Caja operativa

Libro de la caja operativa (el cajón del mostrador) escrito por la sucursal: gastos chicos de tienda, aportes
y recaudaciones, con corrección trazable y saldo esperado a la vista. Es una caja distinta del fondo de compras
(`044_purchase_fund.sql`), y ninguna de las dos puede tocar a la otra. Diseño: pendiente.

## Specs

- **S1** La sucursal registra un **gasto** del cajón desde su propia pantalla, con monto y motivo. La hora la
  pone la base, no el operador. Texto del humano: «a veces se saca dinero de ahi para hacer compras para la
  tienda como detergente, talvez escobas, etc».
- **S2** La sucursal registra además **aportes y recaudaciones** de la caja operativa, no sólo gastos. Decisión
  del humano: «Gastos + aportes/recaudaciones».
- **S3** La caja operativa y el fondo de compras son cajas distintas y no se cruzan: un gasto de tienda nunca
  descuenta del fondo de compras, y una compra de chatarra o baterías usadas nunca descuenta del cajón. Texto
  del humano: «actualmente tenemos compras que es para comprar chatarra y baterias usadas, pero esto utiliza
  una caja diferente. entonces ahora haremos el movimiento de la caja operativa».
- **S4** El esperado del cajón suma y resta los movimientos del período: `apertura + ventas en efectivo +
  aportes − gastos − recaudaciones`, tomando los movimientos que **no** pertenecen a un cierre. Esta spec
  **revisa S14 de `metricas-sucursal.md`**, que declaraba los movimientos como información y no como términos
  de la expectativa: eso era coherente mientras sólo los escribía el cierre. Un aporte o una recaudación que
  escribe la sucursal y nadie resta hace que el cajón esperado mienta y que el faltante del corte no tenga
  explicación.
- **S5** Los movimientos que escribe un **cierre** no cambian de semántica: el aporte es la contribución del
  Almacén y la recaudación es la plata que se lleva, y entran al acta por sus propias columnas
  (`contributed_cash`, `taken`). Nunca se cuentan dos veces: el esperado del período excluye los movimientos
  con cierre.
- **S6** Un movimiento mal cargado se corrige con un movimiento compensatorio de tipo nuevo (`correccion`) que
  referencia al original, con signo contrario y tope en el monto original. El libro es inmutable: nada se
  edita ni se borra, y una corrección no se corrige. Decisión del humano: «Movimiento compensatorio (kind
  nuevo)».
- **S7** Sólo se corrigen movimientos cuya hora no esté cubierta por ninguna rendición cerrada. Un movimiento
  que un cierre ya usó en su acta se resuelve en la rendición, no desde la sucursal. *Precisión del 16/11*:
  un gasto nunca lleva `closing_id`, así que «pertenece a un cierre» se decide por su instante dentro de
  `[period_start, cut_at)` de alguna rendición cerrada, y no por la columna — que en los gastos siempre es
  nula y habría dejado corregible un período ya firmado.
- **S8** Hay una pantalla `#/caja` con el libro del período —gasto, aporte, recaudación y corrección, con tipo,
  monto, momento y quién lo cargó—, el saldo esperado del cajón y, al lado, el saldo del fondo de compras, para
  que las dos cajas se vean juntas sin confundirse.
- **S9** Con la sucursal congelada por una rendición en curso no se escribe: el registro se rechaza con la
  misma regla que hoy (`branch_frozen`, LC001).
- **S10** El Almacén ve los movimientos de la sucursal dentro de la rendición, con su autor y su momento. Un
  movimiento que la sucursal firmó es **detectable**, no prevenible: la pantalla del admin es donde el gasto
  sin motivo o la recaudación inventada se ven.
- **S11** El dinero viaja como texto decimal canónico y se valida en el servidor; una respuesta que no cierra
  se rechaza en la pantalla.
- **S12** La pantalla no acepta una sucursal por parámetro: la sucursal es la de la sesión, y el Almacén no
  escribe el cajón de una sucursal desde acá.
- **S13** Un solo cálculo de efecto firmado alimenta el esperado del período, el acta, las métricas y el
  listado. Nunca dos sumas que puedan discrepar: la corrección de un gasto reduce el gasto del acta, y no es
  una fila que un lector ve y otro no.

## Tasks

- **T1** Migración: tipo `correccion` en el CHECK de `branch_cash_movements`, columna de referencia al
  movimiento corregido, y las guardas de S6/S7 (signo contrario, tope en el monto original, sin cadenas, sólo
  movimientos sin cierre). Pruebas de esquema en `apps/api/migrations`. — Spec: S6, S7.
- **T2** Store: una sola función de efecto firmado, `periodTotals` neto de correcciones, y lectura del libro
  por intervalo. Pruebas de store. — Spec: S4, S5, S13.
- **T3** HTTP: endpoints de aporte, recaudación y corrección junto al gasto existente, y `GET` del libro del
  período. Contrato en `apps/api/docs`. — Spec: S1, S2, S4, S9, S11, S12.
- **T4** Métricas: `today.expenses` neto de correcciones y `today.movements` con su saldo, sin recalcular en
  otro lado. — Spec: S4, S13.
- **T5** Pantalla `#/caja`: `cashAPI.ts`, libro, formulario de los tres tipos, corrección, saldo del cajón y
  del fondo, navegación y pruebas. — Spec: S1, S2, S8, S11.
- **T6** Documentación de la vertical, revisión de S14 en `metricas-sucursal.md` y `README`. — Spec: S4, S5.
- **T7** Verificación independiente y revisión nativa de las unidades de riesgo. — Spec: S6, S13.

## Log

- **L1** Pedido original, verbatim: «Bien antes de arrancar con movimientos de caja quiero que me ayudes a como
  plantearlo / porque actualmente tenemos compras que es para comprar chatarra y baterias usadas, pero esto
  utiliza una caja diferente. entonces ahora haremos el movimiento de la caja operativa porque aveces se saca
  dinero de ahi para hacer compras para la tienda como detergente, talvez escobas, etc / me entiendes?».
- **L2** Decisiones del humano: el alcance incluye gastos **y** aportes/recaudaciones; un error se corrige con
  un movimiento compensatorio de tipo nuevo; la fecha es la del momento de carga.
- **L3** Hallazgo que ordena el alcance: `POST /api/closings/expenses` ya existe y funciona desde la sesión de
  la sucursal (`httpapi/closings.go:2273`, store `closings/store.go:689`), pero **ningún componente del
  frontend lo llama**. Falta un `GET` del libro: hoy sólo `today.movements` dentro de `/api/metrics` publica
  movimientos. El backend es la mitad del vertical, no el principio.
- **L4** Hallazgo que obliga la revisión de S14 de métricas: el esperado del cajón (`034:17-19`) es
  `apertura + ventas efectivo − gastos`, y `cash_expenses` sólo suma `kind='gasto'`. Mientras aportes y
  recaudaciones sólo los escribía el cierre, la omisión era correcta: entraban al acta como contribución y
  como lo que se lleva el Almacén. Con la sucursal escribiéndolos, el esperado tiene que restarlos o sumarlos,
  o el corte muestra un faltante sin causa. De ahí S4 y S5.
- **L5** Hallazgo de riesgo: el libro es inmutable, con `amount > 0` y sin ningún tipo de ajuste, así que hoy
  un gasto de 5.000 cargado por error no se puede deshacer de ninguna forma. De ahí S6 y T1: la corrección no
  es un lujo de UX, es la condición para que el libro pueda ser inmutable.
- **L6** Diseño: `design/caja-operativa/` con tres direcciones — `01-libro-y-ticket.html` (el libro manda,
  formulario al costado), `02-cajon-primero.html` (el esperado manda y la acción está al lado del número) y
  `03-mesa-dos-cajas.html` (caja operativa y fondo de compras juntos, con el estado congelado por rendición).
  Ninguna elegida todavía. El sistema visual se re-sincronizó antes de diseñar: `design/system.md` ganó el
  tamaño 26px, los espacios 1/5/18 y las convenciones de las tarjetas de medición.
- **L7** Diseño elegido: `01-libro-y-ticket.html`, por handoff del humano («Implement the design artboard»).
  Las otras dos quedan como alternativas. El sistema visual se re-sincronizó antes de diseñar y la pantalla
  se implementó sobre los componentes reales (`.cash-*` en `style.css`), no sobre el HTML del tablero.
- **L8** Lo que la implementación encontró y no estaba previsto: (a) el tipo de la vista firmaba la corrección
  al revés —una corrección de gasto restaba en vez de devolver— y se corrigió en `046` con su test; (b) el
  total del libro se calculaba sumando las 500 filas publicadas, así que una ventana larga publicaba un
  esperado falso con cara de correcto; ahora el agregado cubre toda la ventana y `truncated` dice que la
  lista es la más nueva de 500; (c) el mapa de fallos no conocía LC030/LC031 y una corrección rechazada
  salía como 503. Los tres son de la clase «el número se ve bien y está mal», que es la que esta vertical
  existe para evitar.
- **L9** S14 de `metricas-sucursal.md` quedó revisada en su lugar: la tarjeta de hoy ahora suma aportes y
  resta gastos y recaudaciones del período, con `today.effective` publicando el término firmado del que sale
  el esperado. Sin eso la tarjeta y el libro habrían dicho dos números del mismo cajón (S13).
- **L10** Verificación: `go test ./...` completo y la suite del frontend completo, más `typecheck` y `build`.
  La pantalla monta bajo la misma puerta de sesión de sucursal que Compras y Métricas, y el selector de
  período se apoya en los períodos que ya publica `/api/metrics`; no hay todavía una ruta de períodos propia
  del libro (anotado como hueco, no como olvido).
