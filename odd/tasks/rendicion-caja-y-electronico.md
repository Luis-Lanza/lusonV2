# Caja esperada viva y cobro electrónico visible
Dos defectos de superficie encontrados por el humano probando el preview, contra la vertical de Rendición de cuentas (`odd/tasks/rendicion-de-cuentas.md`). El primero: el panel de caja del Almacén muestra las ventas en efectivo y la comisión del período en cero mientras la rendición está abierta, porque esas columnas sólo las escribe el trigger de la transición a `proposed` y la lectura publica la columna. El segundo: la pantalla de la sucursal no renderiza tarjeta, transferencia ni QR, aunque la oferta los lleva de punta a punta, así que un cobro electrónico no aparece en ninguna parte y el "sobrante" queda sin explicación.
Feature branch: `feat/closings-live-period` desde `feat/closings-count-assumed` (`f6e5ed2`).

## Specs
S1. La caja esperada del Almacén es la real antes de proponer: “ademas en el almacen sale como 0 las ventas en efectivo”. Check: mientras la rendición no está propuesta ni cerrada, la superficie del Almacén publica las ventas en efectivo, los gastos del período, el total vendido y la comisión derivados de la misma ventana que usará la oferta; la caja esperada coincide con la que la sucursal verá al recibir la propuesta, y deja de ser cero por no haberse propuesto todavía.
S2. El desglose electrónico se informa en las dos superficies: “no me sale nada que tenga que ver con codigo QR, deberia salir igual el QR”. Check: la rendición informa tarjeta, transferencia y QR por separado en la pantalla del Almacén y en la de la sucursal, con el mismo valor en las dos, y ninguno entra en la caja esperada, en la diferencia ni en lo que se lleva el Almacén.
S3. La discrepancia entre pantallas desaparece: “logras ver la discrepancia?”. Check: para la misma rendición, el Almacén y la sucursal muestran la misma caja esperada, el mismo total vendido y la misma comisión, antes y después de proponer; sólo cambian los campos que la sucursal firma (contada, diferencia, fondo).
S4. Nada más de la vertical cambia: la identidad de caja, la cota del fondo, la comisión informativa, las rondas, el cierre atómico e inmutable, la corrección con aprobación, el congelamiento y el conteo asumido conservan su comportamiento y sus tests.
S5. Sin regresiones: las migraciones aplican en base viva, las suites de Go y de web quedan verdes, `tsc` y build limpios.

## Tasks
T1 [S1–S5] Escribir este documento y su espejo — route inline.
T2 [S1,S3] API: derivar los totales del período en la lectura de una rendición que no está propuesta ni cerrada, reutilizando `periodTotals` y la tasa congelada cuando existe — route delegated; done: pendiente; Risk item 3 (cambia lo que el documento publica para todo consumidor).
T3 [S2,S3] Web de la sucursal: renderizar tarjeta, transferencia y QR desde la oferta, y separar el rótulo de faltante/sobrante del monto — route delegated; done: pendiente.
T4 [S4,S5] Verificación: suites, typecheck, build y verificador independiente por riesgo item 3 — route independent verifier; done: pendiente.

## Log
L1. Pedido original, verbatim: “mira esta imagen es de la rendicion de cuentas desde almacen / y esta otra es la rendicion de cuentas como se ve desde la sucursal / logras ver la discrepancia? y ademas no me sale nada que tenga que ver con codigo QR, deberia salir igual el QR... ademas en el almacen sale como 0 las ventas en efectivo.”

L2. Evidencia de la base del preview, que acota el alcance: la rendición 4 (`proposed`) tiene `sales_total 5000.00`, `cash_sales 2500.00`, `transfer_total 2500.00`, `qr_total 0.00`, `commission_amount 225.00`; las ventas son `#8` en efectivo 2.500 y `#9` por transferencia 2.500. **No existe ninguna venta con QR**: la queja sobre el QR es la misma que la de la transferencia, porque la sucursal no muestra ningún medio electrónico. La rendición está `proposed`, así que sus columnas ya están escritas; el estado que muestra ceros es el `open`, cuyas columnas sólo escribe el trigger `record_branch_closing_offer` en la transición a `proposed` y la lectura nunca deriva.
