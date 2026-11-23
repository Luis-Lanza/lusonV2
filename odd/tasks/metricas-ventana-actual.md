# Métricas: la ventana desde el último corte

Pantalla de Métricas de la sucursal: agregar un período calculado «Desde el último corte» (de la última rendición cerrada hasta ahora) para leer la plata, el mix y el ranking de la ventana actual sin abrir una rendición, porque una rendición abierta bloquea la sucursal.

## Specs

- **S1.** El pedido: «pero cuando una rendicion esta abierta quiere decir que la sucursal esta bloqueada... como puedo ver las metricas entonces».
- **S2.** La dirección elegida: «Período «Desde el último corte» en el selector».
- **S3.** La ventana empieza en el `cut_at` de la última rendición **cerrada** de la sucursal y termina en el momento de la lectura. Leerla no crea, no abre y no propone ninguna rendición, y no congela la sucursal.
- **S4.** El selector publica esa ventana **primero**, con la etiqueta exacta `Desde el último corte`, `kind` `current` y token `current`. Se publica solo si (a) la sucursal tiene al menos una rendición cerrada y (b) no tiene una rendición viva (`open`, `proposed`, `rejected`): una rendición viva ya cubre esa misma ventana como `En curso` y ofrecer las dos sería el mismo número dos veces.
- **S5.** La respuesta de esa ventana declara `source: live` y calcula **plata** (total, medios, unidades, comisión devengada), **ranking** y **estantería de hoy** para la ventana. `cash`, `fund` y `materials` son `null` porque una ventana no tiene acta.
- **S6.** El `sales.total` de la ventana es igual al `today.sold` de la misma respuesta: es la misma ventana, y la pantalla no puede contradecirse.
- **S7.** Pedir `current` cuando no hay ninguna rendición cerrada falla con 404 `not_found`; el cliente nunca lo ofrece en ese caso.
- **S8.** Pantalla: con esa ventana las cuatro cifras dicen `Sin caja` / `Sin fondo` / `Sin planilla` con notas que nombran el acta que falta — `se cuenta al rendir`, `lo declara el Almacén al rendir`, `se entrega al rendir` — y el sello dice `Desde el corte del <fecha> · se mueve con cada venta`.
- **S9.** El selector de Compras no cambia: `Pendiente` sigue siendo su default y su semántica.

- **S10.** La pantalla abre en la ventana cuando la sucursal tiene una rendición cerrada y no está dentro de una rendición viva. Si no la tiene, abre en el acumulado sin mostrar ningún error; una caída al acumulado nunca pisa un período que el humano eligió.

## Tasks

- **T1** — Go, store: lectura de métricas de una ventana calculada (`closings`). Spec: S3, S5, S6.
- **T2** — Go, httpapi: token `current`, período publicado primero, reglas de 404 y wire. Spec: S4, S5, S7.
- **T3** — Web, cliente: `kind`/token/validación de `current`. Spec: S4, S5.
- **T4** — Web, pantalla: notas de «sin acta» y sello de la ventana. Spec: S8.
- **T5** — Verificación y commit. Spec: S1-S9.

## Log

- **L1.** «pero cuando una rendicion esta abierta quiere decir que la sucursal esta bloqueada... como puedo ver las metricas entonces»
- **L2.** «Período «Desde el último corte» en el selector» (dirección elegida sobre las tres ofrecidas).
- **L3.** Incidente en uso: el selector seguía sin ofrecer la ventana. Causa: el handler armaba la entrada `current` **solo** cuando la lectura ya la pedía, así que la lectura que publica el selector (`period=all`, la primera de la pantalla) nunca la incluía y era imposible elegirla. Corregido: la ventana se coloca delante del selector en toda lectura y se usa como período elegido solo cuando se pide. El test que faltaba —publicación en `period=all`— quedó agregado.
- **L4.** «la vista por defecto que sea la que dice desde el ulktimo corte»: la pantalla abre en la ventana; sin ventana publicada cae al acumulado en silencio (S10).
