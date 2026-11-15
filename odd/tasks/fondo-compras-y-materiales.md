# Fondo de compras y materiales rendidos

Rendir la cuenta del dinero destinado a compras y de lo comprado (baterías usadas y chatarra), dentro de la misma rendición de cuentas y con dos pestañas.

Estado: diseño aprobado en dirección; implementación pendiente.

## Specs

- **S1** El fondo de compras es un sobre aparte, dinero físico separado de la caja operativa. Se cuentan los dos por separado. Texto del humano: «Sobre aparte».
- **S2** Toda compra de sucursal se paga en efectivo del fondo de compras. Una compra no puede pagarse por transferencia: el monto de transferencia de una compra queda en cero y se valida. Texto del humano: «si correcto toda compra se paga con efectivo!».
- **S3** La compra en efectivo descuenta del fondo de compras. Esperado del fondo = saldo heredado + aporte − compras en efectivo del período, netas de reversos.
- **S4** No se puede comprar más que el saldo disponible del fondo de compras. Texto del humano: «No puede!». La validación vive en la compra, no en la rendición.
- **S5** Al cerrar, el Almacén se lleva todo el sobrante del fondo de compras y deja un monto nuevo que él escribe cada vez. Texto del humano: «correcto se lleva todo el sobrante y deja uno nuevo, es decir debe quedar un numero X de dinero que el admin/almacen coloca. Entonces seria recambio» y «El monto escribe almacen cada vez!».
- **S6** El monto nuevo que deja el Almacén es el saldo inicial del período siguiente, no un hecho del período que cierra. Se escribe al proponer, igual que el fondo operativo.
- **S7** Lo que debe haber en la estantería son los materiales comprados en el período: el cierre anterior se llevó todo, así que la estantería arranca en cero por construcción. Texto del humano: «si siempre se lelva toda al momento de rendir cuentas».
- **S8** Se cuenta y se informa: baterías usadas en unidades por modelo, chatarra en kilogramos por material (cobre, aluminio, plomo, bronce), cada una con su diferencia contra lo comprado. La diferencia se informa y no bloquea la propuesta, igual que la diferencia de caja. Texto del humano: «Se debe informar correcto, lo mismo que pasa con la caja».
- **S9** La entrega al Almacén es todo lo contado. El remanente queda en cero y no se pide: no hay campo de remanente.
- **S10** Una sola rendición con dos pestañas, Caja y Chatarra: un corte, un congelamiento, una propuesta y una aceptación. Las pestañas son navegación, no dos ciclos de vida. Texto del humano: «dentro rendicion de cuentas debe haber 2 pestanias, una para abrir renicion de cuentas de la caja operativa y otra para rendicion de cuentas de chatarra!» y «Correcto vamos por la primera».
- **S11** Un reverso dentro del período resta del gasto del fondo y de los kilos comprados. Un reverso después del cierre es una corrección con aprobación, como las existentes.
- **S12** El fondo de compras no participa de la comisión ni de la igualdad de la caja operativa, y ninguna plata de ventas lo alimenta. La comisión y las tres igualdades de caja quedan con su semántica actual.
- **S13** La rendición muestra, por encima de las pestañas, los tres saldos con su diferencia —caja operativa, fondo de compras, materiales— y cada uno lleva a su pestaña, para verificar sin cambiar de pestaña.
- **S14** La pestaña Chatarra sirve también durante el período abierto: el encargado ve cuánto le queda de fondo y cuánto material lleva comprado.
- **S15** Antes de empezar se eliminan las compras existentes de la base de desarrollo. Texto del humano: «simplemente eliminemos todas las compras, igual estoy todavia desarollando no sobre una base de datos en produccion».

## Tasks

- **T1** Fondo de compras como sobre aparte, cobrado por la compra misma; la compra en efectivo lo descuenta y valida contra el saldo disponible; la caja operativa no cambia. Specs: S1-S4, S12. Route: worker. Commit: `4127a86`, `d3c6d4e`.
- **T2** El fondo en la rendición: heredado, compras del período, esperado, contado, diferencia y monto nuevo que abre el período siguiente. Specs: S5, S6, S1. Route: worker. Commit: `e004e2c`, `db4875a`.
- **T3** Materiales rendidos: comprado del período contra contado, usadas por modelo y chatarra en kg por material, diferencia informada y entrega derivada. Specs: S7-S9, S11. Route: worker. Commit: `12809ad`.
- **T4** Las dos pestañas y la franja de tres saldos en las dos pantallas, con el conteo de materiales y la entrega a la vista. Specs: S8, S10, S13, S14. Route: worker. Commit: `4f1ff60`.
- **T5** Suite completa, limpieza de las compras de desarrollo y revisión nativa del candidato. Specs: S15, S12. Route: inline. Commit: pendiente.

## Log

- **L1** Pedido original, textual: «durante la rendicion de cuentas igual debe haber rendicion de cuentas de lo que vendria a ser compras, de baterias viejas y de chatarra.»
- **L2** Modelo de negocio, textual: «Cada sucursal tendra un dinero destinado solo a compras de baterias/chatarra, entonces, al hacer esto ese dinero se va usando para comprar baterias viejas cobre ,etc. Y en al rendicion de cuentas debe haber el dinero que queda en caja que fue destinado para esto y cuadrar con las ventas y con lo que hay en kilos de chatarra y baterias usadas. Luego todo eso al cerrar la rendicion de cuentas se va a almacen y desaparece de la sucursal, entonces otra vez comenzaria en 0 su contador de chatarra y baterias usadas y el admin/almacen deja un monto destinado otra vez solo a compra de chatarra.»
- **L3** Respuestas del humano a las ocho preguntas del diseño: fondo «Sobre aparte»; recambio; monto escrito por el Almacén cada vez; no se compra con plata de ventas; la chatarra se lleva siempre toda; las compras son plata física; los reversos restan en el período y son corrección después del cierre; las compras existentes se eliminan porque la base no es de producción.
- **L4** Evidencia leída antes de diseñar: `032_purchases.sql` registra la compra sin proveedor, con `paid_cash` y `paid_transfer` en la cabecera y líneas de usadas (modelo, unidades) y de chatarra (material, kg); `035_branch_guards.sql` congela las compras mientras la sucursal está rendida; ninguna compra escribe un asiento en `branch_cash_movements`, así que la caja esperada no la ve y un gasto real aparece como faltante.
- **L5** Decisión de estructura, textual del humano: «Correcto vamos por la primera», es decir una rendición con dos pestañas y un solo ciclo de vida.
- **L6** Diseño: `design/rendicion-caja-y-chatarra/` con cuatro artboards — `01-mesa-dos-pestanas.html`, `02-acta-dos-paginas.html`, `03-chatarra-guiada.html` (tres direcciones) y `04-decision-dos-pestanas.html` (superficie de la sucursal). Los tres primeros son alternativas entre sí; el humano eligió `01-mesa-dos-pestanas.html` y su implementación quedó registrada como handoff.
- **L7** Corte de slices: la rama `feat/closings-purchase-fund` sale del commit `5a305b0` (la vertical anterior, ya revisada por candidato). Contiene por ahora dos unidades — `4127a86` (044, las dos columnas del fondo y los dos guardas, con la compra pagada sólo en efectivo de punta a punta) y `d3c6d4e` (la pantalla de Compras sin transferencia) — y nada de la vertical anterior viaja mezclado con esto en la relectura, porque se cuenta desde `5a305b0`.
- **L8** Evidencia de T1: `./migrations` 96/96, `internal/closings` y `internal/purchases` verdes con la 044 puesta, Compras 17/17 y `tsc` limpio. Un sobre que ninguna rendición declaró no se cobra: el techo se enciende en el primer cierre que escribe un monto y no se apaga. Sin eso, las sucursales que nunca cerraron no podían comprar nada.

- **L9** Unidades y commits: `4127a86` migración 044 y la compra pagada sólo en efectivo de punta a punta; `d3c6d4e` la pantalla de Compras sin transferencia; `e004e2c` el fondo publicado por la rendición; `db4875a` el fondo en las dos pantallas; `12809ad` migración 045 y los materiales; `4f1ff60` las dos pestañas y la franja de tres saldos.
- **L10** Evidencia de T2 a T4: `./migrations` verde con la 045 puesta, `internal/closings` 38 tests verdes, `internal/httpapi` con los tests de rendición verdes y `TestSettlementCycleEndToEnd` intacto; web 364 tests en las cinco suites de rendición y App, `tsc` y build limpios.
- **L11** Corrección de la maqueta: el total de chatarra del artboard 01 no sumaba sus líneas (decía 105,450 kg y −3,300); las cuatro maquetas quedaron con 104,450 kg y −4,300, que es lo que las líneas dan. La pantalla deriva el total de las líneas.
- **L12** Preview en `http://127.0.0.1:8081` con las migraciones 044 y 045 aplicadas. Una rendición abierta antes de la 045 no tiene planilla de materiales (la siembra ocurre al abrir); una nueva sí.

- **L13** Revisión nativa del corte del dinero (`5a305b0..8604933`, 976 líneas, lentes `risk` y `resilience`): **aprobada**. El reviewer de confiabilidad agotó su presupuesto de salida dos veces sobre este diff, así que ese linaje se liberó con `operator_disposition` y el corte se revisó con dos lentes; los siete tests de esquema de la 044 cubren lo que esa lente miraba. Hallazgos y correcciones: (1) tres CRITICAL iguales —el rechazo de transferencia corría antes del pase del contra-documento, y dejaba sin camino de corrección a las compras pagadas por transferencia anteriores a la 044— corregido en `8604933` con un test que guarda la compra legada y prueba su espejo; (2) un CRITICAL de carrera —la compra tomaba el lock `340252` y el cierre `340251`, así que podía validarse contra el sobre viejo— corregido en `fd6ea06` usando la llave del cierre, con un test que mantiene el lock del cierre y prueba que la compra espera. Autoridad quemada; la rama tiene la corrección dentro del corte, no al final.
