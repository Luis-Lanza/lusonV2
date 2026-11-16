# Métricas por sucursal

Pantalla de métricas de la sucursal propia, cortada por período de rendición: plata del período, caja
operativa, fondo de compras, baterías más vendidas por unidades, recambio y estado actual. Diseño elegido:
`design/metricas-sucursal/01-acta-por-periodo.html`.

## Specs

- **S1** Hay una pantalla de métricas de la sucursal. Texto del humano: «quiero que en el frontend haya una
  pantalla de metricas, donde cada sucursal vea cuanto dinero tiene, ventas, baterias mas vendidas de esa
  sucursal, dinero en caja operativa, dinero del fondo de compras, etc.».
- **S2** Las métricas se cortan por período de rendición, no por mes calendario, y el período se elige con el
  mismo control que Compras. Texto del humano: «y se puede ver por periodos de rendicion de cuentas, asi que
  cuando se termina una rendicion de cuentas las cajas vas a 0 o como queden luego de la rendicion» y «2. Si
  me parece que usar el mismo selector es buena idea».
- **S3** Un período cerrado muestra lo que dejó el período: la caja que se entregó, el recambio de fondo que
  escribió el Almacén y el material entregado. Texto del humano: «como queden luego de la rendicion».
- **S4** Las baterías más vendidas se ordenan por unidades, no por plata. Top 5 por marca + modelo +
  amperaje, con la plata como dato secundario. Texto del humano: «3. por unidades».
- **S5** La pantalla es sólo de la sucursal de la sesión. El consolidado del Almacén queda para otra
  vertical. Texto del humano: «1. La pantalla de momento es solo de la sucursal, pero en otra vertical hare que
  almacen/admin pueda ver la metricas de cada sucursal.».
- **S6** Cada número dice su origen: «al cierre del …» para lo congelado, «en vivo» para lo que se mueve. Un
  período cerrado nunca se recalcula: se lee del cierre. Texto del humano: «de momento metricas generales».
- **S7** No se publica ganancia, margen, rotación de stock ni ranking de clientes: no hay costo registrado, ni
  libro de movimientos, ni registro de clientes. No se inventa un número que no se pueda sostener.
- **S8** Todo el dinero viaja como texto decimal canónico y se valida en el servidor; una respuesta que no
  cierra se rechaza en la pantalla con «Respuesta inválida del servidor.».
- **S9** El acumulado «Todo el historial» publica ventas, producto y stock, y deja en nulo la caja, el fondo
  y la planilla de materiales: una caja se cierra en cada rendición y cada rendición se llevó su material,
  así que sumarlos daría un número que ninguna rendición firmó. La pantalla lo dice con palabras, no con
  ceros.
- **S10** La pantalla lee la sucursal de la sesión y no acepta un parámetro de sucursal: un encargado no
  puede pedir las métricas de otra sucursal, y el Almacén no tiene pantalla propia todavía (su consolidado
  es la vertical siguiente, S5). Sin sesión de sucursal, la respuesta es la de siempre para ese caso.
- **S11** Los días sin rendir se derivan de la apertura del período en curso y se muestran siempre que exista
  un período abierto.
- **S12** La pantalla muestra la caja de hoy **aunque no haya rendición abierta**. Esperado de hoy = lo que
  quedó en el cajón al cerrar el último cierre + las ventas en efectivo posteriores a ese corte − los gastos
  posteriores a ese corte: exactamente la misma fórmula que el esperado de un período en curso, para que la
  tarjeta y la rendición no puedan decir cosas distintas. Sin ningún cierre previo, arranca en cero y la
  tarjeta lo dice. Texto del humano: «no me sale en ningun lugar en curso» y «dale! hagamos eso!».
- **S13** La tarjeta lista los movimientos de caja posteriores a ese corte —aporte, recaudación, gasto— con su
  tipo, su monto y su momento, y dice con palabras cuando no hubo ninguno.
- **S14** Los movimientos son información, no términos de la expectativa: el esperado de una rendición tampoco
  los resta ni los suma (un aporte y una recaudación entran al acta como contribución y como la plata que se
  lleva el Almacén). Sumarlos acá haría que la tarjeta contradiga al acta.

## Tasks

- **T1** API de métricas: `GET /api/metrics?branch_location_id=…&period=…` publica `periods`, `period`,
  `source`, `sales`, `cash`, `fund`, `materials`, `top_models`, `stock`, `left`. Reusa la derivación del cierre
  para lo congelado y agrega sólo modelo, unidades, stock y conteo de ventas. Pruebas de store y de handler.
  Docs en `apps/api/docs/metrics.md`. — Spec: S1-S11.
- **T2** Pantalla: `metricsAPI.ts` (parser estricto), `Metrics.tsx` (banda de lo que dejó el período, dos
  columnas plata/caja, fondo, top 5 con barra de parte, recambio y estado), selector de período igual a
  Compras, etiquetas de origen, `navigation.ts` + `App.tsx`, estilos con los tokens existentes y pruebas.
  — Spec: S1-S9, S11.
- **T3** Cierre: documentación de la vertical, `odd/tasks` actualizado, preview recompilado y verificación
  independiente. — Spec: S6, S8.
- **T4** Caja de hoy: el contrato publica el bloque `today` (desde qué corte, apertura que quedó, ventas en
  efectivo, gastos, esperado y los movimientos con su momento) en las tres fuentes, y la pantalla lo muestra
  siempre, arriba, con la lista de movimientos. — Spec: S12-S14.

## Log

- **L1** Pedido original, verbatim: «bien!, entonces quiero que en el frontend haya una pantalla de metricas,
  donde cada sucursal vea cuanto dinero tiene, ventas, baterias mas vendidas de esa sucursal, dinero en caja
  operativa, dinero del fondo de compras, etc. / y se puede ver por periodos de rendicion de cuentas, asi que
  cuando se termina una rendicion de cuentas las cajas vas a 0 o como queden luego de la rendicion, me vas
  entendiendo? primero analicemos aun no toques codigo».
- **L2** Decisiones del humano: alcance sólo sucursal propia; mismo selector que Compras; ranking por
  unidades; métricas generales.
- **L3** Aclaración de negocio: las cajas no van a cero, se vacían y arrancan desde lo que declara el Almacén
  (caja entregada y recambio de fondo). Queda como S3.
- **L4** Diseño: `design/metricas-sucursal/` con tres direcciones. Elegida
  `01-acta-por-periodo.html` («el período como acta»); las otras dos quedan como alternativas.
- **L5** Hallazgo que ordena la implementación: `GET /api/closings/{id}` ya publica la caja, el fondo, los
  materiales y los totales del período, y `deriveClosing` los deriva también para el período abierto. Lo único
  que no existe en ninguna parte es la agregación por modelo, el conteo de unidades y ventas, y el stock.
  La API nueva es una proyección, no un segundo cálculo.
- **L6** Corrección de especificación: S9 prometía el recambio en el acumulado y S10 un parámetro de
  sucursal para el Almacén. Ninguna de las dos se implementó, y ninguna por omisión. La planilla de
  materiales de un período es lo que ese período compró y lo que el Almacén se llevó al cerrarlo: sumar
  planillas daría un total que ninguna rendición firmó. Y el consolidado del Almacén es la vertical
  siguiente (S5), no un parámetro escondido en ésta.
- **L7** Verificación independiente del corte (riesgo: código compartido por todas las pantallas). Tres
  defectos graves, los tres del mismo tipo: campos que pueden ser negativos o excederse y el contrato los
  trataba como no-negativos. El neto de compras de una ventana puede ser negativo cuando se anularon
  compras de un período anterior, y una rendición puede contar más material del que el período compró
  (informar, nunca bloquear). Los dos primeros respondían 503; se corrigen para admitir el signo y el
  exceso, con pruebas que los fijan.
- **L8** Cierre del corte: `be26eba` corrige los tres defectos de la verificación con pruebas que los
  fijan (un neto de compras negativo se publica con su signo; una rendición que contó más material del
  comprado se publica como el exceso que es; la nota de la pantalla ya no dice que todo está congelado).
  Suites: Go `closings` y `httpapi` en verde (build y `gofmt` limpios); web 3703 pasan / 1 skip
  preexistente; `tsc` y build limpios. Preview en http://127.0.0.1:8081 con la pantalla en `#/metricas`.
- **L9** Pendiente al cerrar: la revisión nativa del corte no se corrió. El candidato son dos commits de
  API (~2.100 líneas) y uno de pantalla (~1.600), así que va por corte, no entero.
- **L10** Reporte del humano sobre la pantalla en el preview: «no me sale en ningun lugar en curso». La
  causa no era un defecto de la pantalla: la sucursal no tenía ninguna rendición abierta, y el período en vivo
  sólo existe mientras hay una. Diagnóstico con datos: las cuatro rendiciones de Sucursal A estaban cerradas,
  la caja de hoy era Bs 500,00 (lo que quedó al cerrar la #4, sin ventas ni gastos después), y el libro tenía
  un movimiento de recaudación de Bs 5.000 que ninguna pantalla mostraba. Se agrega S12-S14 y la tarea T4.
- **L11** T4 implementado. El contrato publica `today` en las tres fuentes con la identidad exacta de la
  rendición (`expected = opening + sales − expenses`, apertura = `closing_cash` del último cierre, ventana
  desde ese corte, lista de movimientos informativa) y la pantalla abre con la tarjeta «Caja de hoy» arriba
  de todo. Con los datos del preview: apertura Bs 500,00, cero ventas en efectivo y cero gastos desde el
  último corte, un movimiento de recaudación de Bs 5.000 que se lista pero **no** resta. Decisiones del
  worker que se aceptan: la lista se acota a los 50 movimientos más nuevos publicados del más viejo al más
  nuevo, y un movimiento de monto cero o de instante cero se rechaza porque el libro no los escribe.
  El parser **no** compara `today.expected` con `cash.expected` de un período en curso: son dos lecturas
  separadas y una venta entre las dos daría un rechazo falso.
- **L12** Verificación: Go `closings` y `httpapi` verdes en el fixture; web 3721 pasan / 1 skip preexistente;
  `tsc`, build y `gofmt` limpios. Preview recompilado en http://127.0.0.1:8081 con la tarjeta nueva.
- **L13** El candidato completo eran 6.008 líneas y no entraba en el presupuesto del revisor (el techo está
  cerca de 2.100). Se reorganizaron los commits locales en cuatro cortes: lectura (1.259), contrato (1.643),
  pantalla (2.063) y documentos (1.043).
- **L14** Revisión nativa del corte de lectura (`review-af60a7deb5855652`, lentes resiliencia y fiabilidad):
  dos hallazgos graves, los dos reales, corregidos en **142 líneas** de diff (tope 200).
  `R3-001`: el historial leía ventas, comisión, ranking, stock y cajón en consultas separadas, sin una
  transacción; una venta concurrente podía entrar en el ranking y no en los totales, y el documento no
  describía un solo instante. Se corrigió leyendo todo en **una transacción de sólo lectura con nivel
  `repeatable read`** — el nivel importa: con el `read committed` por defecto cada sentencia toma su propia
  foto y la transacción sola no garantizaba nada. `R4-closedAtCutGap`: la caja de hoy arrancaba en el
  `closed_at` del último cierre cuando el período termina en el `cut_at`, así que lo vendido o gastado entre
  el corte y la aceptación no estaba en ninguna de las dos cuentas. Ahora arranca en el corte.
  Aprobada y la autoridad quedó quemada. Cuatro observaciones informativas, ninguna bloqueante.
- **L15** Lo que la corrección no pudo probar, y conviene saberlo: el escenario literal de `R4` —una venta
  entre el corte y el cierre— es inalcanzable hoy desde el store, porque mientras una rendición no está
  cerrada la sucursal está congelada (`035`) y los gastos se escriben con `now()` (`042`). La frontera quedó
  fijada por el lado alcanzable: el test exige que la ventana empiece en el `cut_at` del último cierre y
  explícitamente no en su `closed_at`. La prueba de `R3-001` es una invariante bajo un escritor concurrente
  (el total del ranking nunca supera las unidades vendidas), no una foto determinista.
- **L16** Tras la corrección se rearmó la cadena (`git rebase --onto`) sobre el commit enmendado; las tres
  suites de Go (`closings`, `httpapi`, `purchases`) quedaron verdes y el árbol compila. Cortes 2 y 3 sin
  revisar todavía.
